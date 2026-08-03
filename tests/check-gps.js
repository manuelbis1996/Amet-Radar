const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const DIR = __dirname;
const STUB = fs.readFileSync(DIR + '/maplibre-stub.js', 'utf8');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

// Con GPS: entrega una posición. Sin GPS: nunca llama al success.
const GEO_OK = `
window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
Object.defineProperty(navigator,'geolocation',{value:{
  watchPosition:(s)=>{setTimeout(()=>s({coords:{latitude:19.2214,longitude:-70.5295}}),40);return 1;},
  clearWatch:()=>{}},configurable:true});`;
const GEO_DENEGADO = `
window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
Object.defineProperty(navigator,'geolocation',{value:{
  watchPosition:(s,e)=>{setTimeout(()=>e({code:1,PERMISSION_DENIED:1}),40);return 1;},
  clearWatch:()=>{}},configurable:true});`;

const textoYa = (page, sel, def='(no está)') => page.evaluate(([s,d]) => {
  const el = document.querySelector(s); return el ? el.textContent.trim() : d;
}, [sel, def]);

const fails = [];
const check = (n, c, extra='') => {
  console.log((c ? '  OK  ' : ' FALLA') + ' | ' + n + (extra ? '  -> ' + extra : ''));
  if(!c) fails.push(n);
};

async function nuevaPagina(browser, geo){
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', e => errores.push(String(e)));
  // El flujo con foto ya no tiene entrada en la UI (v13.0); esta suite lo
  // sigue cubriendo porque el código sigue ahí y está pensado para volver.
  await page.addInitScript('window.__ametFlujoConFoto = true;');
  await page.addInitScript(geo);
  await page.route('**/maplibre-gl.js', r => r.fulfill({ contentType:'application/javascript', body: STUB }));
  await page.route('**/maplibre-gl.css', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/tiles.openfreemap.org/**', r => r.abort());
  await page.route('**/rest/v1/app_config*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
  await page.route('**/storage/v1/object/**', r => r.fulfill({ status:200, contentType:'application/json', body:'{}' }));
  await page.route('**/rest/v1/reports*', r => {
    const m = r.request().method();
    if(m === 'GET') return r.fulfill({ contentType:'application/json', body:'[]' });
    return r.fulfill({ status: m === 'POST' ? 201 : 204, contentType:'application/json', body:'' });
  });
  await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(900);
  const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(250); }
  return { ctx, page, errores };
}

const sacarFoto = async (page) => {
  await page.click('#report-btn');   await page.waitForTimeout(250);
  await page.click('#detailed-btn'); await page.waitForTimeout(300);
  await page.setInputFiles('#camera-input', { name:'f.png', mimeType:'image/png', buffer: PNG });
  await page.waitForTimeout(1500);
};

(async () => {
  const browser = await lanzar();

  // ========= CON GPS: se saltea el paso de marcar =========
  let { ctx, page, errores } = await nuevaPagina(browser, GEO_OK);
  await sacarFoto(page);
  const conGps = await textoYa(page, '.sheet h2', '(sin hoja)');
  check('con GPS, tras la foto va directo a la categoría (no pide marcar)',
        /Qué estás reportando/i.test(conGps), conGps);
  check('no se dibujó ningún pin de marcar',
        (await page.$$eval('.pick-marker', e => e.length)) === 0);
  check('la hoja ofrece "Ajustar ubicación"', !!(await page.$('#adjust-loc')));
  await page.screenshot({ path: DIR + '/gps-1-categoria.png' });

  // ---- el enlace de ajuste abre el pin, arrancando en el punto del GPS ----
  await page.click('#adjust-loc');
  await page.waitForTimeout(400);
  const enMarcar = await textoYa(page, '.sheet h2', '(sin hoja)');
  check('"Ajustar ubicación" abre el paso de marcar', /marca el lugar/i.test(enMarcar), enMarcar);
  const pos = await page.evaluate(() => {
    const m = (window.__markers||[]).find(x => x._el && x._el.classList.contains('pick-marker'));
    return m ? m._lngLat : null;
  });
  check('el pin arranca en el punto del GPS, no en otro lado',
        !!pos && Math.abs(pos.lat - 19.2214) < 0.01 && Math.abs(pos.lng + 70.5295) < 0.01,
        JSON.stringify(pos));

  // mover el pin y confirmar -> vuelve a categoría con el punto corregido
  await page.evaluate(() => window.__map.fire('click', { lngLat: { lat: 19.2400, lng: -70.5500 } }));
  await page.waitForTimeout(200);
  await page.click('#pick-confirm');
  await page.waitForTimeout(400);
  const volvio = await textoYa(page, '.sheet h2', '(sin hoja)');
  check('confirmar el ajuste vuelve a la categoría', /Qué estás reportando/i.test(volvio), volvio);

  // publicar y comprobar que se usó el punto AJUSTADO, no el del GPS
  let enviado = null;
  page.on('request', r => {
    if(r.method() === 'POST' && /rest\/v1\/reports/.test(r.url())){
      try{ enviado = JSON.parse(r.postData() || '{}'); }catch(e){}
    }
  });
  await page.click('.cat-option');
  await page.waitForTimeout(1500);
  check('publica con la ubicación ajustada (no la del GPS)',
        !!enviado && Math.abs(enviado.lat - 19.2400) < 0.001 && Math.abs(enviado.lng + 70.5500) < 0.001,
        JSON.stringify(enviado && { lat: enviado.lat, lng: enviado.lng }));
  check('sin errores de JS', errores.length === 0, JSON.stringify(errores));
  await ctx.close();

  // ========= SIN GPS: hay que marcar a mano (no hay alternativa) =========
  ({ ctx, page, errores } = await nuevaPagina(browser, GEO_DENEGADO));
  await sacarFoto(page);
  const sinGps = await textoYa(page, '.sheet h2', '(sin hoja)');
  check('sin GPS, tras la foto sí pide marcar el lugar', /marca el lugar/i.test(sinGps), sinGps);
  check('sin GPS se dibuja el pin para marcar',
        (await page.$$eval('.pick-marker', e => e.length)) === 1);
  check('sin errores de JS (sin GPS)', errores.length === 0, JSON.stringify(errores));
  await page.screenshot({ path: DIR + '/gps-2-sin-gps.png' });
  await ctx.close();

  console.log(fails.length ? `\n>>> ${fails.length} FALLO(S): ${fails.join(' | ')}` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
