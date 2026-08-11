const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const DIR = __dirname;
const STUB = fs.readFileSync(DIR + '/maplibre-stub.js', 'utf8');

const GEO = `
// El flujo con foto ya no tiene entrada en la UI (v13.0); esta suite lo
// sigue cubriendo porque el código sigue ahí y está pensado para volver.
window.__ametFlujoConFoto = true;
window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
Object.defineProperty(navigator,'geolocation',{value:{
  watchPosition:(s)=>{setTimeout(()=>s({coords:{latitude:19.2214,longitude:-70.5295}}),40);return 1;},
  clearWatch:()=>{}},configurable:true});`;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const fails = [];
const check = (n, c, extra='') => {
  console.log((c ? '  OK  ' : ' FALLA') + ' | ' + n + (extra ? '  -> ' + extra : ''));
  if(!c) fails.push(n);
};

// Desde v17.3 el pin NO es un marcador de MapLibre: está clavado al centro de
// la pantalla y lo que se mueve es el mapa por debajo. Así que "dónde apunta"
// ya no se lee del marcador sino del centro del mapa, y "está puesto" se mira
// en el DOM.
const pinInfo = (page) => page.evaluate(() => {
  const el = document.querySelector('.pick-fijo');
  if(!el) return null;
  const c = window.__map.getCenter();
  return { pos: { lat: c.lat, lng: c.lng },
           sinToques: getComputedStyle(el).pointerEvents === 'none' };
});
// Mover el mapa es lo que mueve el punto elegido.
const moverMapa = (page, lat, lng) =>
  page.evaluate(([la, ln]) => window.__map.jumpTo({ center: [ln, la] }), [lat, lng]);

(async () => {
  const browser = await lanzar();
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  const page = await ctx.newPage();
  page.on('pageerror', e => fails.push('JS: ' + e));
  await page.addInitScript(GEO);
  await page.route('**/maplibre-gl.js', r => r.fulfill({ contentType:'application/javascript', body: STUB }));
  await page.route('**/maplibre-gl.css', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/tiles.openfreemap.org/**', r => r.abort());
  await page.route('**/rest/v1/app_config*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
  await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body:'[]' }));

  await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(800);
  const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(250); }

  // Desde v11.2 el modo detallado pide la foto ANTES de marcar el lugar.
  const entrarAMarcar = async () => {
    await page.click('#report-btn'); await page.waitForTimeout(250);
    await page.click('#detailed-btn'); await page.waitForTimeout(300);
    await page.setInputFiles('#camera-input', { name:'foto.png', mimeType:'image/png', buffer: PNG });
    await page.waitForTimeout(1400);
    // Desde v11.3 con GPS se saltea el paso de marcar: se llega vía el
    // enlace "Ajustar ubicación" de la hoja de categoría.
    await page.click('#adjust-loc');
    await page.waitForTimeout(400);
  };
  await entrarAMarcar();

  const p0 = await pinInfo(page);
  check('aparece un pin al entrar en "Marca el lugar"', !!p0, JSON.stringify(p0));
  // El pin no puede recibir toques: si los interceptara bloquearía justo el
  // gesto de arrastrar el mapa, que es la ÚNICA forma de mover el punto.
  check('el pin no intercepta los toques del mapa',
        !!p0 && p0.sinToques === true, JSON.stringify(p0));
  check('el mapa arranca en la ubicación del usuario (~19.2214, -70.5295)',
        !!p0 && Math.abs(p0.pos.lat - 19.2214) < 0.01 && Math.abs(p0.pos.lng + 70.5295) < 0.01,
        JSON.stringify(p0 && p0.pos));
  check('hay botón para confirmar el lugar', !!(await page.$('#pick-confirm')));
  // el cartel de estado vacío no debe quedar tapando el centro del mapa:
  // acá el overlay deja pasar los toques y la tarjeta se los comía
  check('el cartel de estado vacío no estorba al marcar',
        await page.$eval('#empty-state', el => el.hidden));
  await page.screenshot({ path: DIR + '/pin-1-marcar.png' });

  // Mover el mapa mueve el punto elegido, porque el pin está fijo al centro.
  await moverMapa(page, 19.2300, -70.5400);
  await page.waitForTimeout(200);
  const p1 = await pinInfo(page);
  check('mover el mapa mueve el punto elegido',
        !!p1 && Math.abs(p1.pos.lat - 19.2300) < 0.0001 && Math.abs(p1.pos.lng + 70.5400) < 0.0001,
        JSON.stringify(p1 && p1.pos));
  const sigueEnMarcar = await page.textContent('.sheet h2');
  check('mover el mapa NO avanza de paso solo', /Marca el lugar/i.test(sigueEnMarcar), sigueEnMarcar);

  // y el punto final es el último centro, no el primero
  await moverMapa(page, 19.2280, -70.5350);
  await page.waitForTimeout(120);

  // confirmar usa la posición final del pin
  await page.click('#pick-confirm');
  await page.waitForTimeout(400);
  const titulo = await page.textContent('.sheet h2');
  check('"Confirmar lugar" avanza a elegir categoría', /Qué estás reportando/i.test(titulo), titulo);
  check('el pin se quita de la pantalla al confirmar', (await pinInfo(page)) === null);
  const guardado = await page.evaluate(() => window.__pend || null);
  await page.screenshot({ path: DIR + '/pin-2-confirmado.png' });

  // cancelar también limpia el pin
  await page.click('#cancel-btn'); await page.waitForTimeout(250);
  await entrarAMarcar();
  check('vuelve a aparecer el pin en un intento nuevo', !!(await pinInfo(page)));
  await page.click('#cancel-btn'); await page.waitForTimeout(300);
  check('cancelar quita el pin de la pantalla', (await pinInfo(page)) === null);
  const quedan = await page.$$eval('.pick-fijo', e => e.length);
  check('no queda ningún pin huérfano en el DOM', quedan === 0, 'pins=' + quedan);

  console.log(fails.length ? `\n>>> ${fails.length} FALLO(S): ${fails.join(' | ')}` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
