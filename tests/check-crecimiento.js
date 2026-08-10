// Lo que hace que la app se reparta y que la gente vuelva.
//
// Es la mitad del lanzamiento que no depende de que haya retenes:
//   * compartir es la palanca de crecimiento declarada del proyecto, pero
//     hasta v16.4 solo se podía compartir un reporte puntual desde su ficha
//     — o sea que el día 1, sin ningún reporte, la app era incompartible;
//   * el link compartido salía con location.pathname, y con la PWA instalada
//     eso es /amet-radar.html, que en Cloudflare lo sirve el asset router SIN
//     invocar al Worker: la tarjeta de WhatsApp salía genérica justo para los
//     usuarios que más comparten (verificado contra producción);
//   * el push es el único motivo para volver y nadie lo encontraba.
const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const DIR = __dirname;
const STUB = fs.readFileSync(DIR + '/maplibre-stub.js', 'utf8');

const GEO = `
window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
Object.defineProperty(navigator,'geolocation',{value:{
  watchPosition:(s)=>{setTimeout(()=>s({coords:{latitude:19.2214,longitude:-70.5295}}),40);return 1;},
  clearWatch:()=>{}},configurable:true});`;

// Espía de navigator.share: Chromium headless no lo implementa, así que se
// inyecta uno. Lo que se prueba es CON QUÉ lo llamamos, no que abra la hoja
// del sistema — eso solo se ve en un teléfono.
const SHARE_SPY = `
window.__shared = [];
navigator.share = (data) => { window.__shared.push(data); return Promise.resolve(); };`;

// Doble del entorno de push, para que la oferta no se saltee por falta de
// soporte. Notification.permission queda en 'default' (nadie decidió aún).
const PUSH_ENV = `
window.__subscribeLlamado = 0;
window.Notification = function(){};
window.Notification.permission = 'default';
window.Notification.requestPermission = () => { window.__subscribeLlamado++; return Promise.resolve('denied'); };
window.PushManager = function(){};
Object.defineProperty(navigator, 'serviceWorker', { configurable:true, value: {
  ready: Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(null) } }),
  register: () => Promise.resolve({}),
  addEventListener: () => {}
}});`;

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
const REPORTE = { id:'r1', lat:19.2220, lng:-70.5300, photo:null, note:'',
  ts: now-2*60000, category:'reten_fijo', confirms:0, denies:0, approx:false };

async function nuevaPagina(browser, extras, vp){
  const ctx = await browser.newContext({ viewport: vp || {width:390,height:844}, isMobile:true, hasTouch:true });
  const page = await ctx.newPage();
  await page.addInitScript(GEO);
  for(const e of (extras || [])) await page.addInitScript(e);
  await page.route('**/maplibre-gl.js', r => r.fulfill({ contentType:'application/javascript', body: STUB }));
  await page.route('**/maplibre-gl.css', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/tiles.openfreemap.org/**', r => r.abort());
  await page.route('**/rest/v1/app_config*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
  return { ctx, page };
}

(async () => {
  const browser = await lanzar();
  const errores = [];

  // =====================================================================
  // 1. Se puede compartir la app aunque no haya ni un reporte
  // =====================================================================
  {
    const { ctx, page } = await nuevaPagina(browser, [SHARE_SPY]);
    page.on('pageerror', e => errores.push(String(e)));
    await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
    await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(800);

    check('la bienvenida ofrece compartir con los contactos', !!(await page.$('#welcome-share')));
    check('la bienvenida menciona los avisos, que antes eran invisibles',
          /avisos/i.test(await textoYa(page, '.welcome-list', '')));
    await page.click('#welcome-share');
    await page.waitForTimeout(300);

    let compartido = (await page.evaluate(() => window.__shared))[0] || {};
    check('EL BUG: se puede compartir LA APP sin ningún reporte publicado',
          !!compartido.url, JSON.stringify(compartido));
    check('y ese enlace no apunta a ningún reporte', !/\?r=/.test(compartido.url || ''),
          compartido.url);

    // El botón permanente de la topbar.
    check('hay un botón de compartir en la barra de arriba', !!(await page.$('#share-app-btn')));
    await page.click('#share-app-btn');
    await page.waitForTimeout(200);
    const n = await page.evaluate(() => window.__shared.length);
    check('el botón de la topbar también comparte la app', n === 2, 'n=' + n);
    await ctx.close();
  }

  // =====================================================================
  // 2. El enlace de un reporte apunta a la raíz (si no, no hay preview)
  // =====================================================================
  {
    const { ctx, page } = await nuevaPagina(browser, [SHARE_SPY]);
    page.on('pageerror', e => errores.push(String(e)));
    await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body: JSON.stringify([REPORTE]) }));
    await page.route('**/rest/v1/rpc/**', r => r.fulfill({ status:200, contentType:'application/json', body:'null' }));
    await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(800);
    const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(250); }

    await page.$eval('.amet-pin', el => el.click());
    await page.waitForTimeout(250);
    await page.$eval('[data-action="share"]', el => el.click());
    await page.waitForTimeout(250);

    const compartido = (await page.evaluate(() => window.__shared))[0] || {};
    const url = compartido.url || '';
    check('el enlace del reporte lleva su id', /\?r=r1$/.test(url), url);
    check('EL BUG: apunta a la raíz, NO a /amet-radar.html (si no, el Worker no corre y no hay preview)',
          !/amet-radar\.html/.test(url), url);
    await ctx.close();
  }

  // =====================================================================
  // 3. Un reporte compartido que ya venció lo dice, en vez de callarse
  // =====================================================================
  {
    const { ctx, page } = await nuevaPagina(browser, [SHARE_SPY]);
    page.on('pageerror', e => errores.push(String(e)));
    await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
    await page.goto(BASE + '/amet-radar.html?r=yanoexiste', { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(1200);
    const t = await textoYa(page, '.toast', '(sin toast)');
    check('EL BUG: un link a un reporte vencido explica qué pasó (antes: silencio total)',
          /ya no está/i.test(t), t);
    await ctx.close();
  }

  // =====================================================================
  // 4. Los avisos se ofrecen tras el primer reporte, una sola vez
  // =====================================================================
  {
    const { ctx, page } = await nuevaPagina(browser, [PUSH_ENV]);
    page.on('pageerror', e => errores.push(String(e)));
    await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
    await page.route('**/rest/v1/rpc/**', r => {
      const fn = new URL(r.request().url()).pathname.split('/').pop();
      const body = fn === 'create_report' ? JSON.stringify({ ok:true, reason:null }) : 'null';
      return r.fulfill({ status:200, contentType:'application/json', body });
    });
    await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(800);
    const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(250); }

    await page.click('#report-btn');
    await page.waitForTimeout(1000);
    check('publicar no pregunta nada antes (sigue siendo un toque)',
          (await page.$eval('#flow-overlay', el => el.hidden)) === true);
    check('durante la ventana de Deshacer NO se ofrece nada todavía',
          !(await page.$('#push-yes')));

    // Vence la ventana de Deshacer (6 s) y recién ahí llega la oferta.
    await page.waitForTimeout(6200);
    check('EL BUG: después del primer reporte se ofrecen los avisos',
          !!(await page.$('#push-yes')));
    check('la oferta NO disparó sola el permiso del sistema',
          (await page.evaluate(() => window.__subscribeLlamado)) === 0);

    await page.click('#push-later');
    await page.waitForTimeout(300);

    // Segundo reporte: la oferta no puede volver a aparecer.
    await page.evaluate(() => { try{ localStorage.removeItem('amet_report_times_v1'); }catch(e){} });
    await page.click('#report-btn');
    await page.waitForTimeout(7400);
    check('no se vuelve a ofrecer nunca más (una sola vez, no insiste)',
          !(await page.$('#push-yes')));
    await ctx.close();
  }

  // =====================================================================
  // 5. Los dos botones de la topbar entran en la pantalla más chica
  // =====================================================================
  {
    const { ctx, page } = await nuevaPagina(browser, [], { width:320, height:568 });
    page.on('pageerror', e => errores.push(String(e)));
    await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
    await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(800);
    const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(250); }
    const m = await page.evaluate(() => {
      const r = s => { const e = document.querySelector(s); if(!e) return null;
        const b = e.getBoundingClientRect(); return { l:Math.round(b.left), r:Math.round(b.right), w:Math.round(b.width), h:Math.round(b.height) }; };
      return { share: r('#share-app-btn'), brand: r('.brand'), ancho: window.innerWidth };
    });
    check('[320px] el botón de compartir mide al menos 44px (mínimo táctil)',
          !!m.share && m.share.w >= 44 && m.share.h >= 44, JSON.stringify(m.share));
    check('[320px] no se sale de la pantalla', !!m.share && m.share.r <= m.ancho,
          `right=${m.share && m.share.r} ancho=${m.ancho}`);
    check('[320px] no se encima con el nombre de la app',
          !!m.share && !!m.brand && m.share.l >= m.brand.r,
          JSON.stringify({ brandR: m.brand && m.brand.r, shareL: m.share && m.share.l }));
    await ctx.close();
  }

  check('sin errores de JavaScript', errores.length === 0, errores.join(' | '));

  await browser.close();
  console.log(fails.length ? `\n>>> ${fails.length} CHEQUEO(S) FALLARON` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  process.exit(fails.length ? 1 : 0);
})();
