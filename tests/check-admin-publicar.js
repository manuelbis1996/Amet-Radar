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

async function abrirPanel(browser, opciones = {}) {
  const ctx = await browser.newContext({ viewport:{ width:1100, height:900 } });
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', e => errores.push(String(e)));

  await page.route('**/maplibre-gl.js', r => r.fulfill({ contentType:'application/javascript', body: STUB }));
  await page.route('**/maplibre-gl.css', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/tiles.openfreemap.org/**', r => r.abort());
  await page.route('**/rest/v1/app_config*', r =>
    r.fulfill({ contentType:'application/json', body: JSON.stringify(CONFIG) }));
  await page.route('**/rest/v1/reports*', r =>
    r.fulfill({ contentType:'application/json', body:'[]' }));
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
    await page.evaluate(() => {
      const m = window.__markers[window.__markers.length - 1];
      m.setLngLat({ lng: -70.4800, lat: 19.2900 });
    });
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

  await browser.close();
  console.log('');
  console.log(fails.length ? `>>> ${fails.length} FALLO(S): ${fails.join(' | ')}` : '>>> TODOS LOS CHEQUEOS PASARON');
  process.exit(fails.length ? 1 : 0);
})();
