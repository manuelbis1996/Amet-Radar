// Un reporte que desapareció del servidor tiene que desaparecer del mapa de
// TODOS los dispositivos, no solo del que lo borró.
//
// El bug que cubre esta suite: renderVisibleMarkers recorría reportsCache
// para decidir qué dibujar y qué sacar. Eso solo alcanza para sacar lo que
// TODAVÍA está en la caché — un reporte borrado desde otro teléfono sale de
// la caché en el siguiente fetch, y con eso el bucle deja de visitar su id.
// El marcador quedaba pegado en el mapa hasta recargar la página, y el
// contador del header lo seguía contando. Ahora hay un barrido al revés
// (de los marcadores hacia la caché); lo que esta suite protege es que ese
// barrido exista Y que no se lleve puestos los reportes de la cola offline,
// que a propósito viven como marcador sin estar en reportsCache.
const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const DIR = __dirname;
const STUB = fs.readFileSync(DIR + '/maplibre-stub.js', 'utf8');

const GEO = `
window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
Object.defineProperty(navigator,'geolocation',{value:{
  watchPosition:(s)=>{setTimeout(()=>s({coords:{latitude:19.2214,longitude:-70.5295}}),40);return 1;},
  clearWatch:()=>{}},configurable:true});`;

const fails = [];
const check = (n, c, extra='') => {
  console.log((c ? '  OK  ' : ' FALLA') + ' | ' + n + (extra ? '  -> ' + extra : ''));
  if(!c) fails.push(n);
};
const textoYa = (page, sel, def='(no está)') => page.evaluate(([s, d]) => {
  const el = document.querySelector(s);
  return el ? el.textContent.trim() : d;
}, [sel, def]);

// Espera a que se cumpla algo, en vez de dormir un rato fijo: el sondeo es
// de 8s y clavar un waitForTimeout más corto daría un rojo intermitente.
async function hasta(page, fn, ms=14000){
  const t0 = Date.now();
  while(Date.now() - t0 < ms){
    if(await page.evaluate(fn)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

const now = Date.now();
const AJENO = { id:'ajeno', lat:19.2220, lng:-70.5300, photo:null, note:'',
  ts: now-2*60000, category:'reten_fijo', confirms:0, denies:0, approx:false };

(async () => {
  const browser = await lanzar();
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', e => errores.push(String(e)));
  await page.addInitScript(GEO);
  await page.route('**/maplibre-gl.js', r => r.fulfill({ contentType:'application/javascript', body: STUB }));
  await page.route('**/maplibre-gl.css', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/tiles.openfreemap.org/**', r => r.abort());
  await page.route('**/rest/v1/app_config*', r => r.fulfill({ contentType:'application/json', body:'[]' }));

  // El interruptor del test: simula que OTRO dispositivo borró el reporte.
  let borrado = false;
  await page.route('**/rest/v1/reports*', r => {
    if(r.request().method() !== 'GET'){
      return r.fulfill({ status:204, contentType:'application/json', body:'' });
    }
    return r.fulfill({ contentType:'application/json',
                       body: JSON.stringify(borrado ? [] : [AJENO]) });
  });

  // create_report se cae a la red a propósito en el tramo 3 (cola offline).
  let redCaida = false;
  await page.route('**/rest/v1/rpc/**', r => {
    const fn = new URL(r.request().url()).pathname.split('/').pop();
    if(fn === 'create_report' && redCaida) return r.abort();
    if(fn === 'create_report') return r.fulfill({ status:200, contentType:'application/json',
                                                  body: JSON.stringify({ ok:true, reason:null }) });
    return r.fulfill({ status:200, contentType:'application/json', body:'null' });
  });

  await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(900);
  const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(250); }

  // ---- 1. Estado de partida: el reporte ajeno se ve ----
  const pins0 = await page.$$eval('.amet-pin', els => els.length);
  check('el reporte de otro dispositivo se dibuja', pins0 === 1, 'pins=' + pins0);
  check('el contador del header lo cuenta',
        (await textoYa(page, '#stat-count')) === '1', await textoYa(page, '#stat-count'));

  // Con la hoja de detalle abierta, que es el caso peor: el usuario está
  // mirando justo el reporte que dejó de existir.
  // .click() del DOM y no page.click(): el stub de MapLibre apila los
  // marcadores en la esquina del contenedor sin posicionarlos, así que el
  // header queda encima y Playwright se niega a hacer un click real.
  await page.$eval('.amet-pin', el => el.click());
  await page.waitForTimeout(250);
  check('se abre la hoja de detalle del reporte',
        (await page.$eval('#detail', el => el.hidden)) === false);

  // ---- 2. Lo borran desde otro dispositivo ----
  borrado = true;
  const seFue = await hasta(page, () => document.querySelectorAll('.amet-pin').length === 0);
  check('EL BUG: el marcador desaparece del mapa en el siguiente sondeo', seFue,
        'pins=' + (await page.$$eval('.amet-pin', els => els.length)));
  check('el contador del header baja a 0',
        (await textoYa(page, '#stat-count')) === '0', await textoYa(page, '#stat-count'));
  check('la hoja de detalle se cierra sola',
        (await page.$eval('#detail', el => el.hidden)) === true);
  const aviso = await textoYa(page, '.toast', '(sin toast)');
  check('se avisa por qué se cerró, en vez de desaparecer sin explicación',
        /ya no está/i.test(aviso), aviso);

  // ---- 3. El barrido NO se puede llevar la cola offline ----
  // Un reporte pendiente existe como marcador SIN estar en reportsCache
  // (todavía no llegó al servidor). Es exactamente la forma que tiene un
  // huérfano, así que sin la excepción explícita el barrido lo borraría y el
  // usuario perdería de vista su propio reporte mientras no hay señal.
  redCaida = true;
  // Por DOM igual que arriba, y acá además por una razón de diagnóstico: si
  // el barrido se rompe, la hoja de detalle se queda abierta y tapa el botón,
  // así que un page.click() haría reventar la suite con un timeout en vez de
  // dejar ver los cuatro FALLA de la sección 2, que son el diagnóstico real.
  await page.$eval('#report-btn', el => el.click());
  await page.waitForTimeout(1200);
  const pend0 = await page.$$eval('.amet-approx', els => els.length);
  check('un reporte publicado sin red queda dibujado (cola offline)',
        pend0 === 1, 'aprox=' + pend0);

  // Dos sondeos completos con el servidor devolviendo [] y la RPC caída.
  await page.waitForTimeout(9000);
  const pend1 = await page.$$eval('.amet-approx', els => els.length);
  check('el barrido NO se lleva el reporte pendiente', pend1 === 1, 'aprox=' + pend1);
  check('y el contador lo sigue contando',
        (await textoYa(page, '#stat-count')) === '1', await textoYa(page, '#stat-count'));

  check('sin errores de JavaScript', errores.length === 0, errores.join(' | '));

  await browser.close();
  console.log(fails.length ? `\n>>> ${fails.length} CHEQUEO(S) FALLARON` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  process.exit(fails.length ? 1 : 0);
})();
