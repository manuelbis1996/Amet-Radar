// v13.2: el sondeo pide solo el área visible, no el país entero.
// Lo que hay que proteger es que un link compartido (o una notificación
// push) siga abriendo un reporte que está FUERA de esa área — si no, se
// rompe justo la palanca de crecimiento del proyecto.
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

const now = Date.now();
// Está en Santo Domingo; el mapa arranca mirando La Vega. El sondeo por
// área NO lo trae: solo puede llegar por la consulta puntual del id.
const LEJANO = { id:'lejano', lat:18.4861, lng:-69.9312, photo:null,
  note:'reporte de otra ciudad', ts: now-2*60000, category:'reten_fijo',
  confirms:1, denies:0, approx:false };

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
  await page.route('**/rest/v1/rpc/**', r => r.fulfill({ status:200, contentType:'application/json', body:'null' }));

  const consultas = [];
  await page.route('**/rest/v1/reports*', r => {
    const url = r.request().url();
    if(r.request().method() !== 'GET'){
      return r.fulfill({ status:204, contentType:'application/json', body:'' });
    }
    consultas.push(url);
    // La consulta por id devuelve el reporte lejano SOLO si el id coincide
    // (si devolviera siempre algo, el caso del id inexistente no probaría
    // nada); la del área nunca lo trae, porque está en otra ciudad.
    const idPedido = (url.match(/id=eq\.([^&]+)/) || [])[1];
    const hay = idPedido && decodeURIComponent(idPedido) === LEJANO.id;
    return r.fulfill({ contentType:'application/json',
                       body: JSON.stringify(hay ? [LEJANO] : []) });
  });

  await page.goto(BASE + '/amet-radar.html?r=lejano', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(1600);

  // ---- 1. El sondeo acota por área ----
  const porArea = consultas.filter(u => !/id=eq\./.test(u));
  const primera = porArea[0] || '';
  check('el sondeo filtra por latitud', /lat=gte\./.test(primera) && /lat=lte\./.test(primera), primera.slice(-120));
  check('el sondeo filtra por longitud', /lng=gte\./.test(primera) && /lng=lte\./.test(primera));
  check('el sondeo NO se trae el país entero', porArea.length > 0 && !porArea.some(u => !/lat=gte\./.test(u)));

  // ---- 2. El link compartido abre igual, aunque el área no lo traiga ----
  const porId = consultas.filter(u => /id=eq\./.test(u));
  check('se pide el reporte por id', porId.length >= 1, String(porId.length) + ' consulta(s)');
  const abierto = await page.$eval('#detail', el => !el.hidden);
  check('el link compartido abre el detalle aunque esté fuera del área', abierto);
  const nota = await textoYa(page, '.detail-note', '(sin nota)');
  check('muestra el reporte correcto', /otra ciudad/.test(nota), nota);

  // ---- 3. Un id inexistente no rompe nada ----
  await page.goto(BASE + '/amet-radar.html?r=no-existe-nada', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(1400);
  const detalle2 = await page.$eval('#detail', el => el.hidden);
  check('un id inexistente no abre nada ni lanza error', detalle2 === true);

  check('sin errores de JS', errores.length === 0, JSON.stringify(errores));

  console.log(fails.length ? `\n>>> ${fails.length} FALLO(S): ${fails.join(' | ')}` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
