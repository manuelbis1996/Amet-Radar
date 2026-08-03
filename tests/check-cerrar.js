const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const DIR = __dirname;
const STUB = fs.readFileSync(DIR + '/maplibre-stub.js', 'utf8');

const GEO = `
// El flujo con foto ya no tiene entrada en la UI (v13.0); esta suite lo
// sigue usando para tener hojas anidadas que cerrar.
window.__ametFlujoConFoto = true;
window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
Object.defineProperty(navigator,'geolocation',{value:{
  watchPosition:(s)=>{setTimeout(()=>s({coords:{latitude:19.2214,longitude:-70.5295}}),40);return 1;},
  clearWatch:()=>{}},configurable:true});`;

const now = Date.now();
const REPORTS = [{ id:'r1', lat:19.2230, lng:-70.5300, photo:null, note:'test',
  ts: now-3*60000, category:'reten_fijo', confirms:1, denies:0, approx:false }];

const fails = [];
const check = (n, c, extra='') => {
  console.log((c ? '  OK  ' : ' FALLA') + ' | ' + n + (extra ? '  -> ' + extra : ''));
  if(!c) fails.push(n);
};

// Toca el fondo del overlay, bien arriba (zona de mapa oscurecido), lejos
// de la hoja que está abajo.
const tocarAfuera = (page) => page.mouse.click(195, 120);

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
  await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body: JSON.stringify(REPORTS) }));

  await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(800);

  const abierto = () => page.$eval('#flow-overlay', el => !el.hidden);

  // 1) la bienvenida se cierra tocando afuera
  check('bienvenida abierta', await abierto());
  await tocarAfuera(page); await page.waitForTimeout(250);
  check('la bienvenida se cierra tocando el mapa', !(await abierto()));

  // (la hoja de filtros se quitó en v13.0, ya no hay nada que cerrar ahí)

  // 3) "¿Cómo quieres reportar?"
  await page.click('#report-btn'); await page.waitForTimeout(250);
  check('hoja de modo de reporte abierta', await abierto());
  await tocarAfuera(page); await page.waitForTimeout(250);
  check('el modo de reporte se cierra tocando el mapa', !(await abierto()));

  // 4) un paso más adentro del flujo (la hoja de la foto)
  await page.click('#report-btn'); await page.waitForTimeout(200);
  await page.click('#detailed-btn'); await page.waitForTimeout(300);
  const enFoto = await page.textContent('.sheet h2');
  check('paso de la foto abierto', /foto/i.test(enFoto), enFoto);
  await tocarAfuera(page); await page.waitForTimeout(250);
  check('el paso de la foto se cierra tocando el mapa', !(await abierto()));

  // 5) tocar DENTRO de la hoja no la cierra
  await page.click('#report-btn'); await page.waitForTimeout(250);
  await page.click('.sheet h2'); await page.waitForTimeout(250);
  check('tocar dentro de la hoja NO la cierra', await abierto());
  await page.click('#cancel-btn'); await page.waitForTimeout(200);

  // 6) una hoja "ocupada" no se cierra tocando afuera
  await page.evaluate(() => {
    window.__testRender = true;
    // se fuerza el mismo render que usan las hojas de proceso
    const ov = document.getElementById('flow-overlay');
    ov.innerHTML = '<div class="sheet"><h2>Procesando foto</h2></div>';
    ov.dataset.dismissible = 'false';
    ov.hidden = false;
  });
  await tocarAfuera(page); await page.waitForTimeout(250);
  check('una hoja en proceso NO se cierra tocando afuera', await abierto());

  // 7) el detalle de un reporte también cierra tocando afuera (ya existía)
  await page.evaluate(() => { const ov=document.getElementById('flow-overlay'); ov.hidden=true; ov.innerHTML=''; });
  await page.$eval('.amet-pin', el => el.click());
  await page.waitForTimeout(300);
  check('detalle abierto', await page.$eval('#detail', el => !el.hidden));
  await tocarAfuera(page); await page.waitForTimeout(250);
  check('el detalle se cierra tocando el mapa', await page.$eval('#detail', el => el.hidden));

  console.log(fails.length ? `\n>>> ${fails.length} FALLO(S): ${fails.join(' | ')}` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
