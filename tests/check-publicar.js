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

// PNG 1x1 válido, para que compressImage() tenga algo real que procesar
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

// OJO: page.textContent() auto-espera hasta 30s si el selector no existe.
// Acá se consulta el DOM sin esperar, porque justamente hay que distinguir
// "no está" al instante (y porque el toast vive solo 2.6s).
const textoYa = (page, sel, def='(no está)') => page.evaluate(([s, d]) => {
  const el = document.querySelector(s);
  return el ? el.textContent.trim() : d;
}, [sel, def]);

const fails = [];
const check = (n, c, extra='') => {
  console.log((c ? '  OK  ' : ' FALLA') + ' | ' + n + (extra ? '  -> ' + extra : ''));
  if(!c) fails.push(n);
};

const now = Date.now();
let reportsFixture = [];

async function nuevaPagina(browser){
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
  // Storage: subida de la foto -> ok
  await page.route('**/storage/v1/object/**', r => r.fulfill({ status:200, contentType:'application/json', body:'{"Key":"report-photos/x.jpg"}' }));
  // REST de reportes: GET devuelve el fixture, POST (insert) responde ok.
  // Desde v12.0 no hay PATCH ni DELETE contra esta ruta — el borrado va por
  // la RPC delete_own_report (ver abajo).
  const inserts = [];
  await page.route('**/rest/v1/reports*', r => {
    const m = r.request().method();
    if(m === 'GET') return r.fulfill({ contentType:'application/json', body: JSON.stringify(reportsFixture) });
    if(m === 'POST'){ try{ inserts.push(JSON.parse(r.request().postData() || '{}')); }catch(e){} }
    return r.fulfill({ status: m === 'POST' ? 201 : 204, contentType:'application/json', body:'' });
  });
  const rpcs = [];
  await page.route('**/rest/v1/rpc/**', r => {
    const fn = new URL(r.request().url()).pathname.split('/').pop();
    const args = JSON.parse(r.request().postData() || '{}');
    rpcs.push({ fn, args });
    // v14.0: publicar pasa por create_report, no por POST /rest/v1/reports.
    // Se normaliza a la forma del record para no tocar los chequeos.
    if(fn === 'create_report'){
      inserts.push({ id: args.p_id, lat: args.p_lat, lng: args.p_lng,
                     photo: args.p_photo, note: args.p_note, ts: args.p_ts,
                     category: args.p_category, approx: args.p_approx,
                     owner_hash: args.p_owner_hash });
      return r.fulfill({ status:200, contentType:'application/json',
                         body: JSON.stringify({ ok:true, reason:null, id:args.p_id }) });
    }
    return r.fulfill({ status:200, contentType:'application/json',
                       body: fn === 'delete_own_report' ? 'true' : 'null' });
  });
  return { ctx, page, errores, rpcs, inserts };
}

(async () => {
  const browser = await lanzar();

  // ============ 1. PUBLICAR UN REPORTE COMPLETO (con foto) ============
  let { ctx, page, errores, rpcs, inserts } = await nuevaPagina(browser);
  await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(800);
  const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(250); }

  // Desde v11.2 el orden es: FOTO -> lugar -> categoría -> publica.
  await page.click('#report-btn');    await page.waitForTimeout(250);
  await page.click('#detailed-btn');  await page.waitForTimeout(400);

  const pideFoto = await page.textContent('.sheet h2');
  check('el modo detallado arranca pidiendo la foto', /foto/i.test(pideFoto), pideFoto);

  await page.setInputFiles('#camera-input', { name:'foto.png', mimeType:'image/png', buffer: PNG });
  await page.waitForTimeout(1500);
  // Desde v11.3, con GPS disponible se saltea el paso de marcar y se usa la
  // ubicación del usuario (el ajuste manual queda como opción).
  const trasFoto = await textoYa(page, '.sheet h2', '(sin hoja)');
  check('con GPS, tras la foto va directo a la categoría',
        /Qué estás reportando/i.test(trasFoto), trasFoto);

  await page.click('.cat-option');    await page.waitForTimeout(1500);

  // ESTE es el bug reportado: el reporte se guardaba pero salía el error,
  // porque map.setView (método de Leaflet) lanzaba excepción después del
  // insert y caía en el catch.
  const hojaFinal = await textoYa(page, '.sheet h2', '(sin hoja)');
  check('NO aparece "No se pudo publicar" tras publicar bien',
        !/No se pudo publicar/i.test(hojaFinal), 'hoja: ' + hojaFinal);
  const overlayCerrado = await page.$eval('#flow-overlay', el => el.hidden);
  check('el flujo se cierra al publicar', overlayCerrado);
  const toast = await textoYa(page, '.toast', '(sin toast)');
  check('avisa que se publicó', /publicado/i.test(toast), toast);
  check('el aviso ofrece "Deshacer"', !!(await page.$('[data-toast="undo"]')));
  // Desde v15.0 el toast trae DOS acciones: la foto opcional y Deshacer.
  // Por eso los selectores son específicos — con `.toast-btn` a secas se
  // clickeaba la primera, que ya no es la que este test quiere.
  check('y también la puerta rápida a la foto', !!(await page.$('[data-toast="foto"]')));
  const centrado = await page.evaluate(() => {
    const c = window.__map._calls.filter(x => x[0] === 'easeTo').pop();
    return c ? c[1] : null;
  });
  check('el mapa se centra en el reporte nuevo (easeTo, no setView)',
        !!centrado && Array.isArray(centrado.center), JSON.stringify(centrado));
  check('sin errores de JS durante la publicación', errores.length === 0, JSON.stringify(errores));
  await page.screenshot({ path: DIR + '/publicar-1-ok.png' });

  // El insert tiene que llevar el hash de propiedad (v12.0): sin eso el
  // autor no puede borrar su propio reporte, porque la base ya no acepta
  // un DELETE con la anon key.
  const insert = inserts[inserts.length - 1] || null;
  const tokenGuardado = await page.evaluate(() => {
    try{ return Object.keys(JSON.parse(localStorage.getItem('amet_report_tokens_v1')||'{}')).length; }
    catch(e){ return -1; }
  });
  check('el reporte se guarda con owner_hash (SHA-256 hex)',
        !!insert && /^[0-9a-f]{64}$/.test(insert.owner_hash || ''), JSON.stringify(insert && insert.owner_hash));
  check('el token en claro queda solo en este dispositivo', tokenGuardado === 1, 'tokens=' + tokenGuardado);

  // ---- "Deshacer" retira el reporte recién publicado ----
  const antes = await page.$$eval('.amet-pin', e => e.length);
  const directos = [];
  page.on('request', r => {
    const m = r.method();
    if((m === 'DELETE' || m === 'PATCH') && /\/rest\/v1\/reports/.test(r.url())) directos.push(m + ' ' + r.url());
  });
  await page.click('[data-toast="undo"]');
  await page.waitForTimeout(700);
  const despues = await page.$$eval('.amet-pin', e => e.length);
  check('"Deshacer" quita el marcador del mapa', despues === antes - 1, `${antes} -> ${despues}`);
  const borrado = rpcs.filter(x => x.fn === 'delete_own_report').pop();
  check('"Deshacer" borra el reporte por RPC, con el token de propiedad',
        !!borrado && /^[0-9a-f]{32}$/.test(borrado.args.p_token || ''), JSON.stringify(borrado));
  check('la app NO manda ningún DELETE/PATCH directo a /rest/v1/reports',
        directos.length === 0, JSON.stringify(directos));
  const cupo = await page.evaluate(() => {
    try{ return JSON.parse(localStorage.getItem('amet_report_times_v1') || '[]').length; }catch(e){ return -1; }
  });
  check('"Deshacer" devuelve el cupo del anti-spam', cupo === 0, 'reportes contados=' + cupo);
  await ctx.close();

  // ============ 2. ABRIR UN REPORTE POR LINK COMPARTIDO (?r=) ============
  reportsFixture = [{ id:'compartido', lat:19.2230, lng:-70.5300, photo:null,
    note:'reporte compartido', ts: now-2*60000, category:'accidente',
    confirms:2, denies:0, approx:false }];
  ({ ctx, page, errores, rpcs, inserts } = await nuevaPagina(browser));
  await page.goto(BASE + '/amet-radar.html?r=compartido', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(1400);

  const detalleAbierto = await page.$eval('#detail', el => !el.hidden);
  check('un link compartido abre el detalle del reporte', detalleAbierto);
  const nota = await textoYa(page, '.detail-note', '(sin nota)');
  check('muestra el reporte correcto', /reporte compartido/.test(nota), nota);
  check('sin errores de JS al abrir por link', errores.length === 0, JSON.stringify(errores));
  await page.screenshot({ path: DIR + '/publicar-2-deeplink.png' });
  await ctx.close();

  console.log(fails.length ? `\n>>> ${fails.length} FALLO(S): ${fails.join(' | ')}` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
