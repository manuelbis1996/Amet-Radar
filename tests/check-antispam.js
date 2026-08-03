// Cobertura del anti-spam del lado del servidor (v14.0).
//
// Qué verifica, en una sola pasada por navegador real:
//   1. publicar ya NO hace POST /rest/v1/reports, va por rpc/create_report
//   2. el payload lleva owner_hash (stampOwnership corre ANTES del envío) y
//      approx:true en el reporte rápido
//   3. 'duplicate' -> mensaje propio, sin marcador y SIN gastar cupo local
//   4. 'rate_limit' -> mensaje propio
//   5. caída de red -> cola offline, con el owner_hash ya adentro
//   6. la cola reintenta con el MISMO id y 'already_exists' cuenta como éxito
//   7. el flujo con foto (FLUJO_CON_FOTO) también publica por la RPC
//
// OJO con el alcance: esto mockea la red, así que NO prueba las reglas del
// servidor (dedupe por proximidad, tope por IP, validaciones). Eso se probó
// contra la base real con el rol anon — los tests del cliente nunca ven a
// Postgres, que es justo cómo se colaron los bugs históricos de este
// proyecto. Acá se prueba que el CLIENTE llama bien y reacciona bien.
//
// Correr:  NODE_PATH=$(npm root -g) node tests/check-antispam.js
//
// El NODE_PATH hace falta porque playwright está instalado global en este
// entorno y el proyecto no tiene package.json (ni dependencias, a propósito).
// El script levanta su propio server.js en el puerto 8123 y lo baja al salir.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const RAIZ = path.join(__dirname, '..');
const PORT = 8123;
const BASE = `http://localhost:${PORT}`;
const STUB = fs.readFileSync(path.join(__dirname, 'maplibre-stub.js'), 'utf8');

let fallos = 0;
function ok(cond, nombre, extra) {
  console.log(`${cond ? '  ok  ' : ' FALLA'}  ${nombre}${cond || extra === undefined ? '' : `\n         -> ${extra}`}`);
  if (!cond) fallos++;
}

// --- Doble de la API de Supabase -------------------------------------------
// Guarda todo lo que el cliente manda, para poder afirmar sobre las llamadas.
function crearEspia() {
  return {
    rpc: [],            // llamadas a create_report
    insertsDirectos: 0, // POST /rest/v1/reports (no debería haber ninguno)
    respuesta: { ok: true, reason: null },
    fallarRed: false
  };
}

async function montarRutas(page, espia) {
  // El CDN de MapLibre está bloqueado en el sandbox: se sirve el stub.
  await page.route('**/maplibre-gl*.js', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: STUB }));
  await page.route('**/maplibre-gl*.css', (r) =>
    r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('**/tiles.openfreemap.org/**', (r) => r.abort());
  // El service worker haría cache-first y volvería las pruebas no
  // deterministas entre corridas.
  await page.route('**/sw.js', (r) => r.fulfill({ status: 404, body: '' }));

  await page.route('**/rest/v1/app_config*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([{ stale_minutes: 45, max_age_minutes: 120,
        deny_threshold: 3, report_limit: 5, report_window_min: 60 }]) }));

  // El sondeo: siempre vacío, así los marcadores que aparezcan son los que
  // creó la prueba y no ruido del servidor.
  await page.route('**/rest/v1/reports*', (r) => {
    if (r.request().method() === 'POST') {
      espia.insertsDirectos++;
      return r.fulfill({ status: 201, body: '' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  // OJO CON EL ORDEN: en Playwright gana la ÚLTIMA ruta registrada que
  // matchee, así que el comodín de rpc va PRIMERO y create_report después.
  // Al revés, el comodín se comía create_report, la RPC contestaba `null` y
  // la app lo leía como rechazo 'invalid' — con todos los chequeos en rojo
  // por un problema del andamiaje y no del código.
  await page.route('**/rest/v1/rpc/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: 'null' }));

  await page.route('**/rest/v1/rpc/create_report', (r) => {
    espia.rpc.push(JSON.parse(r.request().postData() || '{}'));
    if (espia.fallarRed) return r.abort('failed');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(espia.respuesta) });
  });
  await page.route('**/storage/v1/object/report-photos/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
}

async function nuevaPagina(browser, espia, opciones = {}) {
  const ctx = await browser.newContext({
    permissions: ['geolocation'],
    geolocation: { latitude: 19.2230, longitude: -70.5290 },
    serviceWorkers: 'block'
  });
  const page = await ctx.newPage();
  await montarRutas(page, espia);
  if (opciones.conFoto) {
    await page.addInitScript(() => { window.__ametFlujoConFoto = true; });
  }
  // La bienvenida tapa el botón de reportar con una hoja modal.
  await page.addInitScript(() => {
    try { localStorage.setItem('amet_onboarded_v1', '1'); } catch (e) {}
  });
  await page.goto(`${BASE}/amet-radar.html`);
  await page.waitForFunction(() => typeof window.maplibregl !== 'undefined');
  return { ctx, page };
}

const textoToasts = (page) =>
  page.$$eval('.toast', (ns) => ns.map((n) => n.textContent.trim()));

async function reportar(page) {
  await page.click('#report-btn');
}

// ---------------------------------------------------------------------------
(async () => {
  const server = spawn('node', ['server.js'], { cwd: RAIZ, env: { ...process.env, PORT: String(PORT) } });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await new Promise((res) => setTimeout(res, 700));

  const browser = await chromium.launch();
  try {
    // --- 1 y 2: camino feliz del reporte rápido --------------------------
    {
      const espia = crearEspia();
      const { ctx, page } = await nuevaPagina(browser, espia);
      await page.waitForFunction(() => window.navigator.geolocation !== undefined);
      await reportar(page);
      await page.waitForFunction(() => document.querySelectorAll('.toast').length > 0, null, { timeout: 8000 });

      ok(espia.rpc.length === 1, 'publica llamando a rpc/create_report', `llamadas: ${espia.rpc.length}`);
      ok(espia.insertsDirectos === 0,
        'NO usa el POST directo a /rest/v1/reports', `inserts directos: ${espia.insertsDirectos}`);

      const p = espia.rpc[0] || {};
      ok(/^report_[0-9]+_[a-z0-9]*$/.test(p.p_id || ''), 'manda un id con el formato esperado', p.p_id);
      ok(typeof p.p_owner_hash === 'string' && /^[0-9a-f]{64}$/.test(p.p_owner_hash),
        'el owner_hash viaja en el envío (stampOwnership antes de publicar)', String(p.p_owner_hash));
      ok(p.p_approx === true, 'el reporte rápido va con approx:true', String(p.p_approx));
      ok(p.p_category === 'reten_fijo', 'categoría única reten_fijo', String(p.p_category));
      ok(p.p_photo === null, 'el reporte rápido va sin foto', String(p.p_photo));

      const guardado = await page.evaluate(() => localStorage.getItem('amet_report_times_v1'));
      ok(JSON.parse(guardado || '[]').length === 1, 'gasta un cupo local al publicar bien', guardado);
      await ctx.close();
    }

    // --- 3: duplicado -----------------------------------------------------
    {
      const espia = crearEspia();
      espia.respuesta = { ok: false, reason: 'duplicate', id: null };
      const { ctx, page } = await nuevaPagina(browser, espia);
      await reportar(page);
      await page.waitForFunction(() => document.querySelectorAll('.toast').length > 0, null, { timeout: 8000 });

      const toasts = await textoToasts(page);
      ok(toasts.some((t) => /Ya hay un reporte de esto aquí cerca/.test(t)),
        'un duplicado explica que hay que confirmar, no republicar', JSON.stringify(toasts));

      const cupos = await page.evaluate(() => localStorage.getItem('amet_report_times_v1'));
      ok(JSON.parse(cupos || '[]').length === 0,
        'un duplicado NO gasta cupo local', cupos);

      const cola = await page.evaluate(() => localStorage.getItem('amet_pending_queue_v1'));
      ok(JSON.parse(cola || '[]').length === 0,
        'un duplicado NO se encola para reintentar', cola);

      const abierto = await page.$eval('#flow-overlay', (n) => !n.hidden);
      ok(abierto === false, 'un duplicado cierra la hoja de "Publicando…"', `overlay abierto: ${abierto}`);
      await ctx.close();
    }

    // --- 4: tope por IP ---------------------------------------------------
    {
      const espia = crearEspia();
      espia.respuesta = { ok: false, reason: 'rate_limit', id: null };
      const { ctx, page } = await nuevaPagina(browser, espia);
      await reportar(page);
      await page.waitForFunction(() => document.querySelectorAll('.toast').length > 0, null, { timeout: 8000 });

      const toasts = await textoToasts(page);
      ok(toasts.some((t) => /Demasiados reportes desde esta conexión/.test(t)),
        'el tope por IP tiene su propio mensaje', JSON.stringify(toasts));
      await ctx.close();
    }

    // --- 5 y 6: cola offline y reintento idempotente ----------------------
    {
      const espia = crearEspia();
      espia.fallarRed = true;
      const { ctx, page } = await nuevaPagina(browser, espia);
      await reportar(page);
      await page.waitForFunction(
        () => JSON.parse(localStorage.getItem('amet_pending_queue_v1') || '[]').length > 0,
        null, { timeout: 8000 });

      const cola = JSON.parse(await page.evaluate(() => localStorage.getItem('amet_pending_queue_v1')));
      ok(cola.length === 1, 'una caída de red encola el reporte', JSON.stringify(cola).slice(0, 120));
      ok(/^[0-9a-f]{64}$/.test((cola[0] || {}).record.owner_hash || ''),
        'el reporte encolado ya lleva su owner_hash (se puede borrar después)',
        String((cola[0] || {}).record.owner_hash));

      const idEncolado = cola[0].id;

      // Vuelve la red, pero el servidor contesta que ese id ya existía: es el
      // caso de "el insert entró y la respuesta se perdió".
      espia.fallarRed = false;
      espia.respuesta = { ok: true, reason: 'already_exists', id: idEncolado };
      const rpcAntes = espia.rpc.length;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.waitForFunction(
        () => JSON.parse(localStorage.getItem('amet_pending_queue_v1') || '[]').length === 0,
        null, { timeout: 8000 });

      const reintento = espia.rpc[espia.rpc.length - 1];
      ok(espia.rpc.length > rpcAntes && reintento.p_id === idEncolado,
        'la cola reintenta con el MISMO id, no con uno nuevo',
        `${reintento && reintento.p_id} vs ${idEncolado}`);

      const colaFinal = JSON.parse(await page.evaluate(() => localStorage.getItem('amet_pending_queue_v1')));
      ok(colaFinal.length === 0, "'already_exists' vacía la cola en vez de tratarlo como error",
        JSON.stringify(colaFinal));

      const toasts = await textoToasts(page);
      ok(!toasts.some((t) => /No se pudo sincronizar/.test(t)),
        "'already_exists' no muestra error al usuario", JSON.stringify(toasts));
      await ctx.close();
    }

    // --- 7: el flujo con foto también pasa por la RPC ---------------------
    {
      const espia = crearEspia();
      const { ctx, page } = await nuevaPagina(browser, espia, { conFoto: true });
      await page.click('#report-btn');
      await page.waitForSelector('#detailed-btn', { timeout: 8000 });
      await page.click('#detailed-btn');

      // 1x1 JPEG mínimo para el input de cámara.
      const jpeg = Buffer.from(
        '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
        'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
        'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
      await page.setInputFiles('#camera-input', { name: 'r.jpg', mimeType: 'image/jpeg', buffer: jpeg });

      // Con GPS disponible el paso de "marca el lugar" se saltea (v11.3), así
      // que después de la foto viene directo la hoja de categoría — y ahí
      // recién publica. Sin este toque el flujo se queda esperando para
      // siempre.
      await page.waitForSelector('.cat-option[data-cat="reten_fijo"]', { timeout: 15000 });
      await page.click('.cat-option[data-cat="reten_fijo"]');

      await page.waitForFunction(() => document.querySelectorAll('.toast').length > 0, null, { timeout: 15000 });
      ok(espia.rpc.length === 1, 'el flujo con foto publica por rpc/create_report', `llamadas: ${espia.rpc.length}`);
      ok(espia.insertsDirectos === 0, 'el flujo con foto tampoco usa el insert directo',
        `inserts directos: ${espia.insertsDirectos}`);
      const p = espia.rpc[0] || {};
      ok(typeof p.p_owner_hash === 'string' && /^[0-9a-f]{64}$/.test(p.p_owner_hash),
        'el flujo con foto también sella la propiedad antes de enviar', String(p.p_owner_hash));
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(fallos === 0 ? '\nTodo en verde.' : `\n${fallos} chequeo(s) en rojo.`);
  process.exit(fallos === 0 ? 0 : 1);
})();
