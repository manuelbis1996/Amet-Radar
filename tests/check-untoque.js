// Flujo simplificado v13.0: reportar es UN toque, sin elegir modo ni
// categoría, y con Deshacer como red de seguridad. El filtro ya no existe.
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
  await page.route('**/storage/v1/object/**', r => r.fulfill({ status:200, contentType:'application/json', body:'{}' }));

  const inserts = [];
  await page.route('**/rest/v1/reports*', r => {
    const m = r.request().method();
    if(m === 'GET') return r.fulfill({ contentType:'application/json', body:'[]' });
    if(m === 'POST'){ try{ inserts.push(JSON.parse(r.request().postData()||'{}')); }catch(e){} }
    return r.fulfill({ status: m === 'POST' ? 201 : 204, contentType:'application/json', body:'' });
  });
  const rpcs = [];
  await page.route('**/rest/v1/rpc/**', r => {
    const fn = new URL(r.request().url()).pathname.split('/').pop();
    rpcs.push({ fn, args: JSON.parse(r.request().postData()||'{}') });
    return r.fulfill({ status:200, contentType:'application/json',
                       body: fn === 'delete_own_report' ? 'true' : 'null' });
  });

  await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(900);
  const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(250); }

  // ---- 1. El filtro ya no está ----
  check('el botón de filtro no existe', !(await page.$('#filter-btn')));

  // ---- 2. Un toque publica: sin selector de modo ni de categoría ----
  await page.click('#report-btn');
  await page.waitForTimeout(1200);

  check('NO aparece "¿Cómo quieres reportar?"',
        !(await page.$('#quick-btn')) && !(await page.$('#detailed-btn')));
  check('NO aparece la elección de categoría', (await page.$$('.cat-option')).length === 0);
  const overlayCerrado = await page.$eval('#flow-overlay', el => el.hidden);
  check('el flujo se cierra solo tras publicar', overlayCerrado);

  check('se publicó exactamente 1 reporte', inserts.length === 1, 'inserts=' + inserts.length);
  const rep = inserts[0] || {};
  check('la categoría es retén fijo', rep.category === 'reten_fijo', rep.category);
  check('es un reporte rápido (zona aproximada, sin foto)',
        rep.approx === true && rep.photo === null, JSON.stringify({approx:rep.approx, photo:rep.photo}));
  check('lleva owner_hash, así que su autor puede borrarlo',
        /^[0-9a-f]{64}$/.test(rep.owner_hash || ''), String(rep.owner_hash).slice(0,16) + '…');

  // ---- 3. La red de seguridad: Deshacer ----
  const toast = await textoYa(page, '.toast', '(sin toast)');
  check('el aviso ofrece Deshacer', !!(await page.$('.toast-btn')), toast);

  const pinesAntes = await page.$$eval('.amet-pin, .amet-approx', e => e.length);
  await page.click('.toast-btn');
  await page.waitForTimeout(700);
  const pinesDespues = await page.$$eval('.amet-pin, .amet-approx', e => e.length);
  check('Deshacer quita el marcador', pinesDespues === pinesAntes - 1, `${pinesAntes} -> ${pinesDespues}`);

  const borrado = rpcs.filter(x => x.fn === 'delete_own_report').pop();
  check('Deshacer borra en el servidor con el token de propiedad',
        !!borrado && /^[0-9a-f]{32}$/.test(borrado.args.p_token || ''), JSON.stringify(borrado && borrado.args));
  const cupo = await page.evaluate(() => {
    try{ return JSON.parse(localStorage.getItem('amet_report_times_v1')||'[]').length; }catch(e){ return -1; }
  });
  check('Deshacer devuelve el cupo del anti-spam', cupo === 0, 'reportes contados=' + cupo);

  check('sin errores de JS', errores.length === 0, JSON.stringify(errores));
  await page.screenshot({ path: DIR + '/untoque.png' });

  console.log(fails.length ? `\n>>> ${fails.length} FALLO(S): ${fails.join(' | ')}` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
