// Verifica que la app ya no dependa de operaciones destructivas abiertas
// contra la REST API (v12.0). La anon key es pública dentro de
// amet-radar.html, así que todo lo que el cliente pueda hacer con ella lo
// puede hacer cualquiera: el objetivo es que borrar/votar solo se pueda por
// las RPC, que tienen las reglas del lado del servidor.
const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const DIR = __dirname;
const STUB = fs.readFileSync(DIR + '/maplibre-stub.js', 'utf8');

const GEO = `
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

const now = Date.now();
// r-viejo ya venció (más de 6h): antes el cliente le mandaba un DELETE por
// cada uno de estos, que es exactamente el permiso que había que sacar.
const REPORTS = [
  { id:'r-mio',   lat:19.2230, lng:-70.5300, photo:null, note:'mío',
    ts: now-3*60000, category:'reten_fijo', confirms:0, denies:0, approx:false },
  { id:'r-ajeno', lat:19.2240, lng:-70.5310, photo:null, note:'de otro',
    ts: now-4*60000, category:'accidente', confirms:0, denies:1, approx:false },
  { id:'r-viejo', lat:19.2250, lng:-70.5320, photo:null, note:'vencido',
    ts: now-9*60*60000, category:'control', confirms:0, denies:0, approx:false },
];

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

  // Todo lo que la página manda a Supabase, tal cual, para poder auditarlo.
  const enviado = [];
  page.on('request', r => {
    const u = r.url();
    if(/supabase\.co|rest\/v1|storage\/v1/.test(u)) enviado.push({ m: r.method(), u });
  });

  const rpcs = [];
  await page.route('**/rest/v1/rpc/**', r => {
    const fn = new URL(r.request().url()).pathname.split('/').pop();
    rpcs.push({ fn, args: JSON.parse(r.request().postData() || '{}') });
    if(fn === 'vote_report') return r.fulfill({ status:200, contentType:'application/json',
      body: JSON.stringify([{ confirms:0, denies:2, removed:true }]) });
    if(fn === 'delete_own_report') return r.fulfill({ status:200, contentType:'application/json', body:'false' });
    return r.fulfill({ status:200, contentType:'application/json', body:'0' });
  });

  await page.route('**/rest/v1/reports*', r => {
    const m = r.request().method();
    if(m === 'GET') return r.fulfill({ contentType:'application/json', body: JSON.stringify(REPORTS) });
    return r.fulfill({ status: m === 'POST' ? 201 : 204, contentType:'application/json', body:'' });
  });

  await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(1000);
  const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(250); }

  // ---- 1. Reportes vencidos: se limpian con la RPC, no borrando fila por fila ----
  const purgas = rpcs.filter(x => x.fn === 'purge_expired_reports');
  check('los vencidos se limpian llamando a purge_expired_reports', purgas.length >= 1,
        'llamadas=' + purgas.length);
  // Quedan los 2 vigentes; el vencido no se dibuja (la app tampoco lo borra
  // ella misma: eso es cosa de purge_expired_reports).
  const pines = await page.$$eval('.amet-pin', e => e.length);
  check('el vencido no deja marcador (solo se dibujan los 2 vigentes)', pines === 2, 'pines=' + pines);

  // ---- 2. Votar hasta el umbral: el retiro lo decide el servidor ----
  await page.$$eval('.amet-pin', els => { const e = els[0]; e && e.click(); });
  await page.waitForTimeout(350);
  const abierto = await page.$eval('#detail', el => !el.hidden);
  check('la hoja de detalle abre', abierto);
  await page.click('.vote-btn[data-action="deny"]');
  await page.waitForTimeout(600);
  const voto = rpcs.find(x => x.fn === 'vote_report');
  check('votar usa vote_report(id, dirección)',
        !!voto && typeof voto.args.p_id === 'string' && /^(confirm|deny)$/.test(voto.args.p_dir),
        JSON.stringify(voto && voto.args));
  check('el cliente no manda los totales de votos (podría inventarlos)',
        !!voto && !('p_confirms' in voto.args) && !('confirms' in voto.args), JSON.stringify(voto && voto.args));
  const trasRetiro = await page.evaluate(() => ({
    hoja: document.getElementById('detail').hidden,
    toast: (document.querySelector('.toast') || {}).textContent || ''
  }));
  check('cuando el servidor responde removed:true, la app retira el reporte',
        /retirado por la comunidad/i.test(trasRetiro.toast), JSON.stringify(trasRetiro));
  check('y cierra la hoja del reporte que dejó de existir', trasRetiro.hoja === true);

  // ---- 3. Borrar un reporte ajeno (o sin token) no se puede ----
  // Se fuerza el caso poniendo el id en "mis reportes" a mano: es lo que
  // haría alguien desde la consola del navegador. Antes eso alcanzaba para
  // borrar cualquier cosa, porque "es mío" solo se validaba en localStorage.
  await page.evaluate(() => {
    localStorage.setItem('amet_my_reports_v1', JSON.stringify(['r-ajeno']));
  });
  await page.reload({ waitUntil:'domcontentloaded' });
  await page.waitForTimeout(1000);
  const w2 = await page.$('#welcome-ok'); if(w2){ await w2.click(); await page.waitForTimeout(250); }
  // No hay forma de mapear pin -> id desde afuera (los marcadores son divs
  // sin el id encima), así que se abre cada uno hasta dar con r-ajeno.
  let hayBorrar = null;
  const total = await page.$$eval('.amet-pin', e => e.length);
  for(let i = 0; i < total; i++){
    await page.evaluate((n) => document.querySelectorAll('.amet-pin')[n].click(), i);
    await page.waitForTimeout(300);
    hayBorrar = await page.$('[data-action="delete"][data-id="r-ajeno"]');
    if(hayBorrar) break;
    await page.evaluate(() => { const b = document.querySelector('.detail-backdrop'); if(b) b.click(); });
    await page.waitForTimeout(200);
  }
  check('el botón de eliminar aparece (el cliente sigue creyendo que es suyo)', !!hayBorrar);
  const antesDeBorrar = await page.$$eval('.amet-pin', e => e.length);
  if(hayBorrar){
    await hayBorrar.click();
    await page.waitForTimeout(600);
  }
  const intento = rpcs.filter(x => x.fn === 'delete_own_report').pop();
  check('borrar exige el token de propiedad, que este dispositivo no tiene',
        !intento || !intento.args.p_token, JSON.stringify(intento && intento.args));
  const despuesDeBorrar = await page.$$eval('.amet-pin', e => e.length);
  check('el reporte ajeno sigue en el mapa (el servidor dijo que no)',
        despuesDeBorrar === antesDeBorrar, `${antesDeBorrar} -> ${despuesDeBorrar}`);
  const avisoBorrado = await page.evaluate(() => (document.querySelector('.toast')||{}).textContent || '');
  check('y se le avisa al usuario que no se pudo eliminar',
        /no se pudo eliminar/i.test(avisoBorrado), avisoBorrado);

  // ---- 4. Auditoría: nada destructivo por REST directo ----
  const destructivas = enviado.filter(r =>
    (r.m === 'DELETE' || r.m === 'PATCH' || r.m === 'PUT') &&
    !/push_subscriptions/.test(r.u));
  check('la app no manda ningún DELETE/PATCH a reports, app_config ni al bucket de fotos',
        destructivas.length === 0, JSON.stringify(destructivas));
  check('sin errores de JS', errores.length === 0, JSON.stringify(errores));

  console.log(fails.length ? `\n>>> ${fails.length} FALLO(S): ${fails.join(' | ')}` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
