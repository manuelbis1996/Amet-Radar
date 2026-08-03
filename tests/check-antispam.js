// Anti-spam del lado del servidor (v14.0): el flujo de publicar contra la
// RPC create_report.
//
// Qué protege, del lado del CLIENTE (que es hasta donde llegan estas suites):
//   * publicar va por rpc/create_report y NO por POST /rest/v1/reports
//   * el owner_hash viaja en el envío (stampOwnership antes de publicar)
//   * un rechazo 'duplicate' / 'rate_limit' tiene su propio mensaje, no gasta
//     cupo local y NO se encola para reintentar (daría lo mismo)
//   * una caída de red sí encola, con el owner_hash ya adentro
//   * la cola reintenta con el MISMO id y 'already_exists' cuenta como éxito
//
// Lo que esta suite NO ve, porque vive en Postgres: el dedupe por proximidad,
// el tope por IP, las validaciones de entrada y la extracción de la IP. Eso se
// verifica contra la base real con el rol anon — ver tests/README.md.

const { lanzar, BASE, MOVIL, rutasBase, textoYa } = require('./_setup');

const GEO = `
Object.defineProperty(navigator,'geolocation',{value:{
  watchPosition:(s)=>{setTimeout(()=>s({coords:{latitude:19.2214,longitude:-70.5295}}),40);return 1;},
  clearWatch:()=>{}},configurable:true});`;

const fails = [];
const check = (n, c, extra = '') => {
  console.log((c ? '  OK  ' : ' FALLA') + ' | ' + n + (extra ? '  -> ' + extra : ''));
  if (!c) fails.push(n);
};

// Doble de la API: guarda lo que el cliente manda y deja elegir qué contesta
// create_report, que es el eje de esta suite.
function crearEspia() {
  return { rpc: [], insertsDirectos: 0, respuesta: { ok: true, reason: null }, fallarRed: false };
}

async function nuevaPagina(browser, espia, opciones = {}) {
  const ctx = await browser.newContext(MOVIL);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  await page.addInitScript(GEO);
  // La bienvenida taparía el botón de reportar con una hoja modal.
  await page.addInitScript(() => { try { localStorage.setItem('amet_onboarded_v1', '1'); } catch (e) {} });
  if (opciones.conFoto) await page.addInitScript(() => { window.__ametFlujoConFoto = true; });

  await rutasBase(page);
  await page.route('**/rest/v1/app_config*', (r) =>
    r.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route('**/storage/v1/object/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

  await page.route('**/rest/v1/reports*', (r) => {
    const m = r.request().method();
    if (m === 'GET') return r.fulfill({ contentType: 'application/json', body: '[]' });
    // Si esto se incrementa, el cliente volvió al insert directo que v14.0 cerró.
    if (m === 'POST') espia.insertsDirectos++;
    return r.fulfill({ status: m === 'POST' ? 201 : 204, contentType: 'application/json', body: '' });
  });

  // OJO CON EL ORDEN: en Playwright gana la ÚLTIMA ruta registrada que
  // matchee, así que el comodín va primero y create_report después. Al revés,
  // el comodín se come create_report, la RPC contesta `null` y el cliente lo
  // lee como rechazo 'invalid' — todo en rojo por el andamiaje, no por el código.
  await page.route('**/rest/v1/rpc/**', (r) => {
    const fn = new URL(r.request().url()).pathname.split('/').pop();
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: fn === 'delete_own_report' ? 'true' : 'null' });
  });
  await page.route('**/rest/v1/rpc/create_report', (r) => {
    espia.rpc.push(JSON.parse(r.request().postData() || '{}'));
    if (espia.fallarRed) return r.abort('failed');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(espia.respuesta) });
  });

  await page.goto(BASE + '/amet-radar.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  const w = await page.$('#welcome-ok');
  if (w) { await w.click(); await page.waitForTimeout(250); }
  return { ctx, page, errores };
}

const guardado = (page, clave) =>
  page.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { return []; } }, clave);

(async () => {
  const browser = await lanzar();

  // ---- 1. Camino feliz: un toque publica por la RPC ----
  {
    const espia = crearEspia();
    const { ctx, page, errores } = await nuevaPagina(browser, espia);
    await page.click('#report-btn');
    await page.waitForTimeout(1200);

    check('publica llamando a rpc/create_report', espia.rpc.length === 1, 'llamadas=' + espia.rpc.length);
    check('NO usa el POST directo a /rest/v1/reports (cerrado en v14.0)',
      espia.insertsDirectos === 0, 'inserts directos=' + espia.insertsDirectos);

    const p = espia.rpc[0] || {};
    check('el id tiene el formato que espera la base', /^report_[0-9]+_[a-z0-9]*$/.test(p.p_id || ''), p.p_id);
    check('el owner_hash viaja en el envío (stampOwnership antes de publicar)',
      /^[0-9a-f]{64}$/.test(p.p_owner_hash || ''), String(p.p_owner_hash).slice(0, 16) + '…');
    check('es un reporte rápido: approx y sin foto', p.p_approx === true && p.p_photo === null,
      JSON.stringify({ approx: p.p_approx, photo: p.p_photo }));
    check('la categoría es retén fijo', p.p_category === 'reten_fijo', p.p_category);
    check('gasta un cupo local al publicar bien', (await guardado(page, 'amet_report_times_v1')).length === 1);
    check('sin errores de JS al publicar', errores.length === 0, JSON.stringify(errores));
    await ctx.close();
  }

  // ---- 2. Rechazo por duplicado ----
  {
    const espia = crearEspia();
    espia.respuesta = { ok: false, reason: 'duplicate', id: null };
    const { ctx, page } = await nuevaPagina(browser, espia);
    await page.click('#report-btn');
    await page.waitForTimeout(1200);

    const toast = await textoYa(page, '.toast', '(sin toast)');
    check('un duplicado dice que hay que confirmar, no republicar',
      /Ya hay un reporte de esto aquí cerca/.test(toast), toast);
    check('un duplicado NO gasta cupo local', (await guardado(page, 'amet_report_times_v1')).length === 0);
    check('un duplicado NO se encola para reintentar',
      (await guardado(page, 'amet_pending_queue_v1')).length === 0);
    check('un duplicado cierra la hoja de "Publicando…"',
      await page.$eval('#flow-overlay', (el) => el.hidden));
    await ctx.close();
  }

  // ---- 3. Rechazo por tope de IP ----
  {
    const espia = crearEspia();
    espia.respuesta = { ok: false, reason: 'rate_limit', id: null };
    const { ctx, page } = await nuevaPagina(browser, espia);
    await page.click('#report-btn');
    await page.waitForTimeout(1200);
    const toast = await textoYa(page, '.toast', '(sin toast)');
    check('el tope por IP tiene su propio mensaje, distinto del genérico',
      /Demasiados reportes desde esta conexión/.test(toast), toast);
    await ctx.close();
  }

  // ---- 4. Caída de red: cola offline y reintento idempotente ----
  {
    const espia = crearEspia();
    espia.fallarRed = true;
    const { ctx, page } = await nuevaPagina(browser, espia);
    await page.click('#report-btn');
    await page.waitForTimeout(1500);

    const cola = await guardado(page, 'amet_pending_queue_v1');
    check('una caída de red encola el reporte', cola.length === 1, 'cola=' + cola.length);
    check('el encolado ya lleva su owner_hash (se puede borrar después)',
      /^[0-9a-f]{64}$/.test(((cola[0] || {}).record || {}).owner_hash || ''));

    const idEncolado = (cola[0] || {}).id;
    // Vuelve la red, pero el servidor dice que ese id ya existía: es el caso
    // de "el insert entró y la respuesta se perdió".
    espia.fallarRed = false;
    espia.respuesta = { ok: true, reason: 'already_exists', id: idEncolado };
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(1500);

    const ultimo = espia.rpc[espia.rpc.length - 1] || {};
    check('la cola reintenta con el MISMO id, no con uno nuevo',
      ultimo.p_id === idEncolado, `${ultimo.p_id} vs ${idEncolado}`);
    check("'already_exists' vacía la cola en vez de tratarlo como error",
      (await guardado(page, 'amet_pending_queue_v1')).length === 0);
    const toast = await textoYa(page, '.toast', '(sin toast)');
    check("'already_exists' no le muestra un error al usuario",
      !/No se pudo sincronizar/.test(toast), toast);
    await ctx.close();
  }

  // ---- 5. El flujo con foto tampoco vuelve al insert directo ----
  {
    const espia = crearEspia();
    const { ctx, page } = await nuevaPagina(browser, espia, { conFoto: true });
    await page.click('#report-btn');
    await page.waitForTimeout(300);
    await page.click('#detailed-btn');
    await page.waitForTimeout(300);
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
      'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
    await page.setInputFiles('#camera-input', { name: 'r.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    // Con GPS el paso de marcar se saltea (v11.3): después de la foto viene
    // la categoría, y recién ahí publica.
    await page.waitForSelector('.cat-option', { timeout: 15000 });
    await page.click('.cat-option[data-cat="reten_fijo"]');
    await page.waitForTimeout(1500);

    check('el flujo con foto publica por rpc/create_report', espia.rpc.length === 1,
      'llamadas=' + espia.rpc.length);
    check('el flujo con foto tampoco usa el insert directo', espia.insertsDirectos === 0,
      'inserts directos=' + espia.insertsDirectos);
    check('el flujo con foto también sella la propiedad antes de enviar',
      /^[0-9a-f]{64}$/.test((espia.rpc[0] || {}).p_owner_hash || ''));
    await ctx.close();
  }

  await browser.close();
  console.log('');
  console.log(fails.length ? `>>> ${fails.length} FALLO(S): ${fails.join(', ')}` : '>>> TODOS LOS CHEQUEOS PASARON');
  process.exit(fails.length ? 1 : 0);
})();
