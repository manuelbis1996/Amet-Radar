// Ofrecer instalar la app en la pantalla de inicio.
//
// La app es instalable desde siempre (manifest + service worker) pero nunca lo
// sugería, así que se quedaba en pestaña del navegador. Instalada cambia dos
// cosas: queda un ícono en la pantalla de inicio y las notificaciones push
// funcionan de verdad — el único mecanismo de retención del proyecto.
//
// OJO CON LO QUE ESTA SUITE PUEDE Y NO PUEDE VER. `beforeinstallprompt` NO
// dispara en Chromium headless: solo lo emite Chrome real tras sus heurísticas
// de engagement. Acá se despacha un evento sintético con la misma forma, así
// que lo que se prueba es NUESTRA lógica (cuándo se ofrece, cuántas veces, qué
// pasa al aceptar), no que el navegador lo emita. Eso último solo se ve en un
// teléfono.
const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const DIR = __dirname;
const STUB = fs.readFileSync(DIR + '/maplibre-stub.js', 'utf8');

const GEO = `
window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
Object.defineProperty(navigator,'geolocation',{value:{
  watchPosition:(s)=>{setTimeout(()=>s({coords:{latitude:19.2214,longitude:-70.5295}}),40);return 1;},
  clearWatch:()=>{}},configurable:true});`;

// Doble del evento del navegador: registra si se llamó a prompt() y si se
// frenó el banner propio de Chrome con preventDefault().
const EVENTO = `
window.__instalar = { prompts: 0, preventDefault: 0 };
window.__emitirInstalable = () => {
  const e = new Event('beforeinstallprompt');
  e.preventDefault = () => { window.__instalar.preventDefault++; };
  e.prompt = () => { window.__instalar.prompts++; return Promise.resolve(); };
  window.dispatchEvent(e);
};`;

const fails = [];
const check = (n, c, extra='') => {
  console.log((c ? '  OK  ' : ' FALLA') + ' | ' + n + (extra ? '  -> ' + extra : ''));
  if(!c) fails.push(n);
};
const textoYa = (page, sel, def='(no está)') => page.evaluate(([s, d]) => {
  const el = document.querySelector(s);
  return el ? el.textContent.trim() : d;
}, [sel, def]);

async function abrir(browser, ctx, { emitir = true, esperar = 900 } = {}) {
  const page = await ctx.newPage();
  await page.addInitScript(GEO);
  await page.addInitScript(EVENTO);
  await page.route('**/maplibre-gl.js', r => r.fulfill({ contentType:'application/javascript', body: STUB }));
  await page.route('**/maplibre-gl.css', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/tiles.openfreemap.org/**', r => r.abort());
  await page.route('**/rest/v1/app_config*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
  await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
  await page.route('**/rest/v1/rpc/**', r => r.fulfill({ status:200, contentType:'application/json', body:'null' }));
  await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(esperar);
  const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(250); }
  if(emitir){ await page.evaluate(() => window.__emitirInstalable()); await page.waitForTimeout(350); }
  return page;
}

(async () => {
  const browser = await lanzar();
  const errores = [];

  // El contexto se comparte entre "aperturas" para conservar localStorage,
  // que es donde se cuenta cuántas veces se abrió la app.
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  ctx.on('page', p => p.on('pageerror', e => errores.push(String(e))));

  // ---- 1. En la PRIMERA apertura no se ofrece nada ----
  {
    const page = await abrir(browser, ctx);
    check('en la primera apertura NO se ofrece instalar (sin banner al abrir)',
          !(await page.$('#inst-si')));
    check('pero el banner propio de Chrome sí se frena, para decidir nosotros cuándo',
          (await page.evaluate(() => window.__instalar.preventDefault)) === 1);
    await page.close();
  }

  // ---- 2. En la segunda, sí ----
  {
    const page = await abrir(browser, ctx);
    check('EL PEDIDO: en la segunda apertura se ofrece instalar',
          !!(await page.$('#inst-si')), await textoYa(page, '.sheet h2'));
    check('el texto explica para qué sirve, no solo "instalá"',
          /avisos|cerrada|inicio/i.test(await textoYa(page, '.sheet .sub', '')),
          await textoYa(page, '.sheet .sub', ''));
    check('todavía no se disparó el diálogo del sistema',
          (await page.evaluate(() => window.__instalar.prompts)) === 0);

    await page.click('#inst-si');
    await page.waitForTimeout(300);
    check('al aceptar se dispara el diálogo real del navegador',
          (await page.evaluate(() => window.__instalar.prompts)) === 1);
    check('y la hoja se cierra', (await page.$eval('#flow-overlay', el => el.hidden)) === true);
    await page.close();
  }

  // ---- 3. No insiste nunca más ----
  {
    const page = await abrir(browser, ctx);
    check('en la tercera apertura ya NO vuelve a ofrecerlo', !(await page.$('#inst-si')));
    await page.close();
  }

  // ---- 4. "Ahora no" también cuenta como respuesta ----
  {
    const ctx2 = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
    ctx2.on('page', p => p.on('pageerror', e => errores.push(String(e))));
    let page = await abrir(browser, ctx2);           // 1ª
    await page.close();
    page = await abrir(browser, ctx2);               // 2ª: ofrece
    check('"Ahora no" está disponible junto a "Instalar"', !!(await page.$('#inst-no')));
    await page.click('#inst-no');
    await page.waitForTimeout(250);
    check('rechazar cierra sin disparar el diálogo del sistema',
          (await page.evaluate(() => window.__instalar.prompts)) === 0);
    await page.close();
    page = await abrir(browser, ctx2);               // 3ª
    check('y no se vuelve a preguntar después de un "Ahora no"', !(await page.$('#inst-si')));
    await page.close();
    await ctx2.close();
  }

  // ---- 5. Si el navegador no puede instalar, no se inventa nada ----
  {
    const ctx3 = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
    ctx3.on('page', p => p.on('pageerror', e => errores.push(String(e))));
    let page = await abrir(browser, ctx3, { emitir:false });
    await page.close();
    page = await abrir(browser, ctx3, { emitir:false });
    check('sin beforeinstallprompt no se ofrece nada (en un navegador que no puede)',
          !(await page.$('#inst-si')) && !(await page.$('#inst-ok')));
    await page.close();
    await ctx3.close();
  }

  // ---- 6. Ya instalada: no molestar ----
  {
    const ctx4 = await browser.newContext({
      viewport:{width:390,height:844}, isMobile:true, hasTouch:true,
    });
    ctx4.on('page', p => p.on('pageerror', e => errores.push(String(e))));
    // Se simula la app corriendo instalada (display-mode: standalone).
    await ctx4.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => /standalone/.test(q)
        ? { matches: true, media: q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }
        : real(q);
    });
    let page = await abrir(browser, ctx4);
    await page.close();
    page = await abrir(browser, ctx4);
    check('si ya está instalada NO se ofrece instalarla otra vez',
          !(await page.$('#inst-si')));
    await page.close();
    await ctx4.close();
  }

  // ---- 7. iPhone: no hay API, así que se explica dónde está ----
  {
    const ctx5 = await browser.newContext({
      viewport:{width:390,height:844}, isMobile:true, hasTouch:true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    ctx5.on('page', p => p.on('pageerror', e => errores.push(String(e))));
    let page = await abrir(browser, ctx5, { emitir:false });
    await page.close();
    page = await abrir(browser, ctx5, { emitir:false, esperar: 3400 });
    const sub = await textoYa(page, '.sheet .sub', '');
    check('en iPhone se explica el camino a mano (no hay API que disparar)',
          /Compartir/i.test(sub) && /pantalla de inicio/i.test(sub), sub);
    check('y no ofrece un botón "Instalar" que no haría nada',
          !(await page.$('#inst-si')));
    await page.close();
    await ctx5.close();
  }

  check('sin errores de JavaScript', errores.length === 0, errores.join(' | '));

  await ctx.close();
  await browser.close();
  console.log(fails.length ? `\n>>> ${fails.length} CHEQUEO(S) FALLARON` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  process.exit(fails.length ? 1 : 0);
})();
