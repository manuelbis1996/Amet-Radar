// Publicar un reporte desde el panel de administración, en cualquier punto
// del mapa sin estar cerca (v14.3). Primera suite que cubre `admin.html`.
//
// Qué protege:
//   * el panel publica por rpc/create_report — la misma RPC pública que la
//     app, sin endpoint privilegiado nuevo
//   * manda las coordenadas DEL PIN, no las del dispositivo (que es el punto
//     de la función: reportar sin estar cerca)
//   * deja elegir las 4 categorías, no solo la única que reporta la app
//   * `approx` sale del checkbox
//   * un rechazo del servidor (`duplicate` / `rate_limit`) se muestra con su
//     motivo y NO como un éxito silencioso
//
// OJO: como el resto de las suites, esto mockea la red. No prueba las reglas
// del servidor (dedupe, tope por IP): eso se verifica contra la base real.

const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const STUB = fs.readFileSync(__dirname + '/maplibre-stub.js', 'utf8');

const fails = [];
const check = (n, c, extra='') => {
  console.log((c ? '  OK  ' : ' FALLA') + ' | ' + n + (extra ? '  -> ' + extra : ''));
  if(!c) fails.push(n);
};

const CONFIG = [{ stale_minutes:45, max_age_minutes:120, deny_threshold:3,
                  report_limit:5, report_window_min:60 }];

const ahora = Date.now();
// Dos reportes ya existentes: uno exacto y uno de zona aproximada, de
// categorías distintas, para comprobar que el panel los dibuja en el mapa.
const REPORTES = [
  { id:'r-uno', lat:19.2230, lng:-70.5300, photo:null, note:'', ts: ahora-5*60000,
    category:'reten_fijo', confirms:1, denies:0, approx:false },
  { id:'r-dos', lat:19.2400, lng:-70.5100, photo:null, note:'', ts: ahora-9*60000,
    category:'accidente', confirms:0, denies:0, approx:true },
];

async function abrirPanel(browser, opciones = {}) {
  const ctx = await browser.newContext({ viewport:{ width:1100, height:900 } });
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', e => errores.push(String(e)));

  // opciones.sinMapa simula el caso real que rompía el panel entero: la
  // librería no carga (CDN caído) o el dispositivo no tiene WebGL.
  await page.route('**/maplibre-gl.js', r => opciones.sinMapa
    ? r.fulfill({ contentType:'application/javascript', body:'/* no cargó */' })
    : r.fulfill({ contentType:'application/javascript', body: STUB }));
  await page.route('**/maplibre-gl.css', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/tiles.openfreemap.org/**', r => r.abort());
  await page.route('**/rest/v1/app_config*', r =>
    r.fulfill({ contentType:'application/json', body: JSON.stringify(CONFIG) }));
  await page.route('**/rest/v1/reports*', r =>
    r.fulfill({ contentType:'application/json',
      body: JSON.stringify(opciones.reportes === undefined ? REPORTES : opciones.reportes) }));
  // El login del panel pasa por un Edge Function; acá se acepta siempre.
  await page.route('**/functions/v1/admin-login', r =>
    r.fulfill({ status:200, contentType:'application/json', body:'{"ok":true}' }));

  const rpcs = [];
  await page.route('**/rest/v1/rpc/create_report', r => {
    rpcs.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ status:200, contentType:'application/json',
      body: JSON.stringify(opciones.respuesta || { ok:true, reason:null }) });
  });

  await page.goto(BASE + '/admin.html', { waitUntil:'domcontentloaded' });
  await page.fill('#password-input', 'loquesea');
  await page.click('#login-btn');
  await page.waitForSelector('#dashboard:not([hidden])', { timeout:8000 });
  await page.waitForTimeout(400);
  return { ctx, page, rpcs, errores };
}

(async () => {
  const browser = await lanzar();

  // ---- 1. Camino feliz: elegir punto y categoría, y publicar ----
  {
    const { ctx, page, rpcs, errores } = await abrirPanel(browser);

    check('el panel muestra el mapa para elegir el punto', !!(await page.$('#admin-map')));
    check('ofrece las 4 categorías (la app solo reporta una)',
      (await page.$$eval('.cat-choice', e => e.length)) === 4);

    // Mover el pin a un punto lejos del centro por defecto, que es lo que hace
    // el admin: publicar donde NO está.
    // Mover el pin tiene que escribir las coordenadas en el formulario, que
    // es de donde publica.
    await page.fill('#pub-lat', '19.29000');
    await page.fill('#pub-lng', '-70.48000');
    await page.click('.cat-choice[data-cat="accidente"]');
    await page.check('#pub-approx');
    await page.click('#publish-btn');
    await page.waitForTimeout(600);

    check('publica por rpc/create_report, sin endpoint privilegiado nuevo',
      rpcs.length === 1, 'llamadas=' + rpcs.length);

    const p = rpcs[0] || {};
    check('manda las coordenadas del pin, no las del dispositivo',
      Math.abs(p.p_lat - 19.2900) < 0.0001 && Math.abs(p.p_lng + 70.4800) < 0.0001,
      JSON.stringify({ lat:p.p_lat, lng:p.p_lng }));
    check('manda la categoría elegida', p.p_category === 'accidente', String(p.p_category));
    check('manda approx según el checkbox', p.p_approx === true, String(p.p_approx));
    check('el id tiene el formato que la base valida',
      /^report_[0-9]+_[a-z0-9]*$/.test(p.p_id || ''), String(p.p_id));
    check('no manda foto ni nota (el servidor las rechaza desde v14.1)',
      p.p_photo === null && p.p_note === '', JSON.stringify({ photo:p.p_photo, note:p.p_note }));
    check('sin errores de JS', errores.length === 0, JSON.stringify(errores));
    await ctx.close();
  }

  // ---- 1.bis Los reportes existentes se dibujan en el mapa del panel ----
  // Antes solo estaban en la tabla: el mapa mostraba únicamente el pin de
  // "dónde voy a publicar", así que no se veía lo que ya había ni lo recién
  // publicado, y era fácil poner un duplicado encima de otro.
  {
    const { ctx, page, rpcs } = await abrirPanel(browser);

    const puntos = await page.$$eval('.rep-dot', els => els.map(e => ({
      cls: e.className, bg: e.style.background, title: e.title
    })));
    check('los reportes existentes aparecen como marcadores en el mapa',
      puntos.length === 2, 'marcadores=' + puntos.length);
    check('el de zona aproximada se distingue del exacto',
      puntos.filter(p => /approx/.test(p.cls)).length === 1,
      JSON.stringify(puntos.map(p => p.cls)));
    check('cada marcador dice qué es y de cuándo',
      puntos.every(p => /·/.test(p.title)), JSON.stringify(puntos.map(p => p.title)));

    // Publicar redibuja el mapa: el reporte nuevo tiene que aparecer.
    await page.route('**/rest/v1/reports*', r =>
      r.fulfill({ contentType:'application/json',
        body: JSON.stringify(REPORTES.concat([{ id:'r-nuevo', lat:19.2600, lng:-70.5000,
          photo:null, note:'', ts: Date.now(), category:'control', confirms:0, denies:0, approx:false }])) }));
    await page.click('#publish-btn');
    await page.waitForTimeout(700);
    check('tras publicar, el reporte nuevo se dibuja sin recargar la página',
      (await page.$$eval('.rep-dot', e => e.length)) === 3,
      'marcadores=' + (await page.$$eval('.rep-dot', e => e.length)));
    check('y se publicó de verdad', rpcs.length === 1);
    await ctx.close();
  }

  // ---- 2. Rechazo del servidor: se muestra el motivo, no un éxito falso ----
  {
    const { ctx, page } = await abrirPanel(browser, {
      respuesta: { ok:false, reason:'duplicate', id:null }
    });
    await page.click('#publish-btn');
    await page.waitForTimeout(600);

    const visible = await page.$eval('#publish-error', el => !el.hidden);
    const texto = await page.$eval('#publish-error', el => el.textContent.trim());
    check('un duplicado muestra el error en pantalla', visible, 'texto=' + texto);
    check('y explica el motivo real (no un genérico)',
      /150 m/.test(texto) && /30 minutos/.test(texto), texto);
    await ctx.close();
  }

  // ---- 3. Tope por IP: su propio mensaje ----
  {
    const { ctx, page } = await abrirPanel(browser, {
      respuesta: { ok:false, reason:'rate_limit', id:null }
    });
    await page.click('#publish-btn');
    await page.waitForTimeout(600);
    const texto = await page.$eval('#publish-error', el => el.textContent.trim());
    check('el tope por hora tiene su propio mensaje', /tope de reportes por hora/i.test(texto), texto);
    await ctx.close();
  }

  // ---- 4. Si MapLibre no carga, el panel NO se cae y se publica igual ----
  // Regresión concreta: initAdminMap() vivía dentro del try de loadDashboard,
  // así que una excepción del mapa (sin WebGL, CDN caído) dejaba el panel sin
  // parámetros ni tabla de reportes, solo con un toast genérico.
  {
    const { ctx, page, rpcs, errores } = await abrirPanel(browser, { sinMapa: true });

    check('sin mapa, el resto del panel igual carga (parámetros)',
      (await page.inputValue('#cfg-maxage')) === '120', await page.inputValue('#cfg-maxage'));
    check('sin mapa, la tabla de reportes igual se dibuja',
      !!(await page.$('#reports-tbody tr')));
    check('sin mapa, no se intenta dibujar marcadores (no revienta)',
      (await page.$$eval('.rep-dot', e => e.length)) === 0);
    const avisoVisible = await page.$eval('#map-fallback', el => !el.hidden);
    check('se avisa que el mapa no cargó, en vez de dejar una caja muda', avisoVisible);

    await page.fill('#pub-lat', '19.31000');
    await page.fill('#pub-lng', '-70.51000');
    await page.click('#publish-btn');
    await page.waitForTimeout(600);
    check('sin mapa, publicar sigue funcionando con las coordenadas a mano',
      rpcs.length === 1 && Math.abs(rpcs[0].p_lat - 19.31) < 0.0001,
      JSON.stringify(rpcs[0] && { lat:rpcs[0].p_lat, lng:rpcs[0].p_lng }));
    check('y sin errores de JS sueltos', errores.length === 0, JSON.stringify(errores));
    await ctx.close();
  }

  await browser.close();
  console.log('');
  console.log(fails.length ? `>>> ${fails.length} FALLO(S): ${fails.join(' | ')}` : '>>> TODOS LOS CHEQUEOS PASARON');
  process.exit(fails.length ? 1 : 0);
})();
