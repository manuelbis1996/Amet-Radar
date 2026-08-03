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

(async () => {
  const browser = await lanzar();
  for(const vp of [{n:'320px', width:320, height:568}, {n:'390px', width:390, height:844}]){
    const ctx = await browser.newContext({ viewport:{width:vp.width,height:vp.height}, isMobile:true, hasTouch:true });
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
    const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(300); }

    const m = await page.evaluate(() => {
      const card = document.querySelector('.empty-card');
      const brand = document.querySelector('.brand');
      const fab = document.getElementById('fab-row');
      const r = e => { const b = e.getBoundingClientRect(); return { top:Math.round(b.top), bottom:Math.round(b.bottom), h:Math.round(b.height), w:Math.round(b.width) }; };
      return { visible: !document.getElementById('empty-state').hidden,
               card: card ? r(card) : null, brand: r(brand), fab: r(fab),
               alto: window.innerHeight };
    });

    const solapa = (a,b) => !(a.bottom <= b.top || a.top >= b.bottom);
    const ocupa = m.card ? (m.card.h / m.alto * 100).toFixed(1) : '-';
    console.log(`\n[${vp.n}] visible=${m.visible} | píldora ${m.card && m.card.h}px de alto (${ocupa}% de la pantalla), y=${m.card && m.card.top}`);
    check(`[${vp.n}] se muestra`, m.visible === true);
    check(`[${vp.n}] no se superpone con el header`, !!m.card && !solapa(m.card, m.brand),
          `header hasta y=${m.brand.bottom}, píldora desde y=${m.card.top}`);
    check(`[${vp.n}] no se superpone con los botones de abajo`, !!m.card && !solapa(m.card, m.fab));
    check(`[${vp.n}] ocupa poco (menos del 8% del alto)`, !!m.card && (m.card.h / m.alto) < 0.08, ocupa + '%');
    check(`[${vp.n}] no se sale de pantalla`, !!m.card && m.card.w <= vp.width);

    if(vp.n === '390px') await page.screenshot({ path: DIR + '/vacio-pildora.png' });
    await ctx.close();
  }
  console.log(fails.length ? `\n>>> ${fails.length} FALLO(S): ${fails.join(' | ')}` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
