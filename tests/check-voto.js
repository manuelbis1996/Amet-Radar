const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const DIR = __dirname;
const STUB = fs.readFileSync(DIR + '/maplibre-stub.js', 'utf8');

const GEO = `
// El flujo con foto ya no tiene entrada en la UI (v13.0); se activa acá
// porque es el único que sigue mostrando el selector de categorías.
window.__ametFlujoConFoto = true;
window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
Object.defineProperty(navigator,'geolocation',{value:{
  watchPosition:(s)=>{setTimeout(()=>s({coords:{latitude:19.2214,longitude:-70.5295}}),40);return 1;},
  clearWatch:()=>{}},configurable:true});`;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const now = Date.now();
const REPORTS = [{ id:'r1', lat:19.2230, lng:-70.5300, photo:null, note:'test',
  ts: now-3*60000, category:'reten_fijo', confirms:4, denies:0, approx:false }];

const fails = [];
const check = (n, c, extra='') => {
  console.log((c ? '  OK  ' : ' FALLA') + ' | ' + n + (extra ? '  -> ' + extra : ''));
  if(!c) fails.push(n);
};

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
  // Desde v12.0 el voto no es un PATCH con los totales: es la RPC
  // vote_report, que suma de a 1 y decide ella si el reporte se retira.
  const rpcs = [];
  await page.route('**/rest/v1/rpc/**', r => {
    const fn = new URL(r.request().url()).pathname.split('/').pop();
    const args = JSON.parse(r.request().postData() || '{}');
    rpcs.push({ fn, args });
    if(fn === 'vote_report'){
      const dir = args.p_dir;
      return r.fulfill({ status:200, contentType:'application/json',
        body: JSON.stringify([{ confirms: 4 + (dir === 'confirm' ? 1 : 0),
                                denies: dir === 'deny' ? 1 : 0, removed: false }]) });
    }
    return r.fulfill({ status:200, contentType:'application/json', body:'null' });
  });

  await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(800);
  const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(250); }

  // ---------- A. colores de categoría en el flujo de reporte ----------
  await page.click('#report-btn'); await page.waitForTimeout(250);
  await page.click('#detailed-btn'); await page.waitForTimeout(350);
  await page.setInputFiles('#camera-input', { name:'foto.png', mimeType:'image/png', buffer: PNG });
  await page.waitForTimeout(1500);
  const cats = await page.$$eval('.cat-option', els => els.map(e => ({
    txt: e.textContent.trim().replace(/\s+/g,' '),
    borde: getComputedStyle(e).borderTopColor,
    fondo: getComputedStyle(e).backgroundColor
  })));
  const bordesDistintos = new Set(cats.map(c => c.borde)).size;
  check('las 4 categorías tienen colores de borde distintos (no cajas grises)',
        cats.length === 4 && bordesDistintos === 4, JSON.stringify(cats.map(c => c.borde)));
  const fondosDistintos = new Set(cats.map(c => c.fondo)).size;
  check('cada categoría tiene su propio tinte de fondo', fondosDistintos === 4,
        JSON.stringify(cats.map(c => c.fondo)));
  await page.screenshot({ path: DIR + '/voto-1-categorias.png' });
  await page.click('#cancel-btn'); await page.waitForTimeout(250);

  // ---------- B. estado del voto ----------
  await page.$eval('.amet-pin', el => el.click());
  await page.waitForTimeout(350);
  let botones = await page.$$eval('.vote-btn', els => els.map(e => ({
    txt: e.textContent.trim().replace(/\s+/g,' '),
    disabled: e.disabled, chosen: e.classList.contains('chosen')
  })));
  check('antes de votar: ambos botones habilitados y sin marcar',
        botones.length === 2 && !botones[0].disabled && !botones[1].disabled &&
        !botones[0].chosen && !botones[1].chosen, JSON.stringify(botones));

  await page.click('.vote-btn[data-action="confirm"]');
  await page.waitForTimeout(600);
  botones = await page.$$eval('.vote-btn', els => els.map(e => ({
    txt: e.textContent.trim().replace(/\s+/g,' '),
    disabled: e.disabled, chosen: e.classList.contains('chosen')
  })));
  check('tras votar: el elegido queda marcado como "Tu voto"',
        botones[0].chosen && /Tu voto/.test(botones[0].txt), JSON.stringify(botones[0]));
  check('tras votar: ambos botones quedan deshabilitados',
        botones[0].disabled && botones[1].disabled, JSON.stringify(botones.map(b => b.disabled)));
  check('el otro botón NO queda marcado', !botones[1].chosen, JSON.stringify(botones[1]));
  // el aviso no debe tapar los botones de votar que acaban de cambiar
  const solape = await page.evaluate(() => {
    const t = document.querySelector('.toast');
    const v = document.querySelector('.vote-btn');
    if(!t || !v) return { hayToast: !!t, solapa: null };
    const a = t.getBoundingClientRect(), b = v.getBoundingClientRect();
    return { hayToast: true, arriba: t.classList.contains('top'),
             solapa: !(a.bottom < b.top || a.top > b.bottom) };
  });
  check('el aviso no se superpone con los botones de votar',
        solape.hayToast && solape.arriba === true && solape.solapa === false,
        JSON.stringify(solape));
  await page.screenshot({ path: DIR + '/voto-2-votado.png' });

  // ---------- el estado sobrevive a reabrir la hoja ----------
  await page.$eval('.detail-backdrop', el => el.click());
  await page.waitForTimeout(300);
  await page.$eval('.amet-pin', el => el.click());
  await page.waitForTimeout(350);
  const tras = await page.$$eval('.vote-btn', els => els.map(e => ({
    disabled: e.disabled, chosen: e.classList.contains('chosen')
  })));
  check('al reabrir el reporte, el voto sigue visible',
        tras[0].chosen && tras[0].disabled, JSON.stringify(tras));

  // ---------- C. el voto va por RPC, no por PATCH directo ----------
  const voto = rpcs.find(x => x.fn === 'vote_report');
  check('votar llama a la RPC vote_report', !!voto, JSON.stringify(rpcs));
  check('la RPC recibe id + dirección, no los totales (que el cliente podría inventar)',
        !!voto && voto.args.p_id === 'r1' && voto.args.p_dir === 'confirm' &&
        !('confirms' in voto.args) && !('denies' in voto.args), JSON.stringify(voto && voto.args));

  console.log(fails.length ? `\n>>> ${fails.length} FALLO(S): ${fails.join(' | ')}` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
