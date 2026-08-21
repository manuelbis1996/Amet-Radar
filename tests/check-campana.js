// La campana de los avisos push: que responda SIEMPRE y que diga la verdad.
//
// Los tres defectos que cubre estaban vivos en producción hasta v17.9 y los
// tres son silenciosos, que es lo que los hacía difíciles de notar:
//
//   1. El listener del click se enganchaba DESPUÉS de esperar a
//      `navigator.serviceWorker.ready`. Esa promesa no rechaza nunca: si el
//      service worker no llega a activarse (registro fallido, o la app
//      servida por http desde una IP de la red, donde ni se registra) queda
//      pendiente para siempre y el listener NO se engancha jamás. La campana
//      se veía normal y al tocarla no pasaba nada — sin toast, sin hoja y sin
//      error en consola.
//   2. Arrancaba afirmando "apagada" (el estado del HTML) antes de saberlo,
//      así que a alguien que SÍ tenía los avisos activos le mostraba la
//      campana gris; y si `ready` se colgaba, para siempre.
//   3. `aria-label`/`title` no cambiaban nunca: con los avisos activos el
//      botón seguía anunciando "Avisarme de retenes cerca" aunque ahí ya abre
//      la hoja de gestión. Sin `aria-pressed`, y con el encendido comunicado
//      SOLO por color sobre un ícono idéntico.
//
// Lo que esta suite NO puede ver: que el push llegue de verdad a un teléfono.
// Eso solo se prueba a mano (y la sonda semanal comprueba el lado del
// servidor, ver tests/README.md).
const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const STUB = fs.readFileSync(__dirname + '/maplibre-stub.js', 'utf8');

const GEO = `
window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
Object.defineProperty(navigator,'geolocation',{value:{
  watchPosition:(s)=>{setTimeout(()=>s({coords:{latitude:19.2214,longitude:-70.5295}}),40);return 1;},
  clearWatch:()=>{}},configurable:true});`;

// Doble del entorno de push. `readyCuelga` es el caso del service worker que
// nunca se activa: se simula con una promesa que no resuelve nunca, que es
// exactamente lo que hace el navegador de verdad.
const PUSH = (readyCuelga, yaSuscripto) => `
window.__push = { subs: 0, unsubs: 0 };
const fakeSub = {
  endpoint:'https://push.example/abc',
  toJSON:()=>({endpoint:'https://push.example/abc',keys:{p256dh:'p',auth:'a'}}),
  unsubscribe:()=>{window.__push.unsubs++;subActual=null;return Promise.resolve(true);}
};
// El doble tiene que RECORDAR la suscripción: si getSubscription() siguiera
// devolviendo null después de subscribe(), la baja no encontraría nada que
// dar de baja y el chequeo fallaría por el stub, no por el producto.
let subActual = ${yaSuscripto} ? fakeSub : null;
const reg = { pushManager:{
  getSubscription:()=>Promise.resolve(subActual),
  subscribe:()=>{window.__push.subs++;subActual=fakeSub;return Promise.resolve(fakeSub);}
}};
Object.defineProperty(navigator,'serviceWorker',{value:{
  ready: ${readyCuelga} ? new Promise(()=>{}) : Promise.resolve(reg),
  register:()=>Promise.resolve(reg), addEventListener:()=>{}, controller:null
},configurable:true});
window.PushManager = function(){};
window.Notification = { permission:'default', requestPermission:()=>Promise.resolve('granted') };`;

const fails = [];
const check = (n, c, extra='') => {
  console.log((c ? '  OK  ' : ' FALLA') + ' | ' + n + (extra ? '  -> ' + extra : ''));
  if(!c) fails.push(n);
};
const toast = (page) => page.evaluate(() => {
  const t = document.querySelector('.toast');
  return t ? t.textContent.trim() : '';
});

async function abrir(ctx, { readyCuelga = false, yaSuscripto = false } = {}) {
  const p = await ctx.newPage();
  await p.addInitScript(GEO);
  await p.addInitScript(PUSH(readyCuelga, yaSuscripto));
  await p.route('**/maplibre-gl.js', r => r.fulfill({ contentType:'application/javascript', body: STUB }));
  await p.route('**/maplibre-gl.css', r => r.fulfill({ contentType:'text/css', body:'' }));
  await p.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType:'text/css', body:'' }));
  await p.route('**/tiles.openfreemap.org/**', r => r.abort());
  await p.route('**/rest/v1/app_config*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
  await p.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
  await p.route('**/rest/v1/rpc/**', r => r.fulfill({ status:200, contentType:'application/json', body:'true' }));
  await p.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
  await p.waitForTimeout(1100);
  const w = await p.$('#welcome-ok'); if(w){ await w.click(); await p.waitForTimeout(250); }
  return p;
}

(async () => {
  const browser = await lanzar();
  const errores = [];
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  ctx.on('page', p => p.on('pageerror', e => errores.push(String(e))));

  // ---- 1. Con el service worker colgado, la campana RESPONDE ----
  {
    const page = await abrir(ctx, { readyCuelga:true });
    check('la campana se muestra aunque el service worker no esté listo',
          !(await page.$eval('#push-toggle-btn', e => e.hidden)));
    check('y NO afirma "apagada" antes de saberlo',
          (await page.$eval('#push-toggle-btn', e => e.dataset.state)) === 'checking',
          await page.$eval('#push-toggle-btn', e => e.dataset.state));

    await page.click('#push-toggle-btn');
    await page.waitForTimeout(500);
    // El bug original: el listener se enganchaba después del await, así que
    // esto no producía absolutamente nada.
    check('EL BUG: tocarla hace algo visible en vez de nada',
          (await toast(page)).length > 0, JSON.stringify(await toast(page)));
    check('y no intenta suscribir a ciegas (se colgaría igual)',
          (await page.evaluate(() => window.__push.subs)) === 0);
    await page.close();
  }

  // ---- 2. Pasado el tope de espera, lo explica ----
  {
    const page = await abrir(ctx, { readyCuelga:true });
    await page.waitForTimeout(8600);   // PUSH_SW_TIMEOUT_MS + margen
    check('pasado el tope deja de decir "preparando" y ofrece activarlos',
          (await page.$eval('#push-toggle-btn', e => e.dataset.state)) === 'inactive',
          await page.$eval('#push-toggle-btn', e => e.dataset.state));
    await page.click('#push-toggle-btn');
    await page.waitForTimeout(400);
    check('y al tocarla dice por qué no puede, en vez de quedarse muda',
          /no están listos|Recargá/i.test(await toast(page)), await toast(page));
    await page.close();
  }

  // ---- 3. Camino normal: suscribirse ----
  {
    const page = await abrir(ctx);
    check('con el service worker activo arranca ofreciendo activarlos',
          (await page.$eval('#push-toggle-btn', e => e.dataset.state)) === 'inactive');
    await page.click('#push-toggle-btn');
    await page.waitForTimeout(700);
    check('tocarla suscribe', (await page.evaluate(() => window.__push.subs)) === 1);
    check('y queda encendida', (await page.$eval('#push-toggle-btn', e => e.dataset.state)) === 'active');

    // ---- 4. Lo que anuncia el botón, que antes era fijo ----
    const label = await page.$eval('#push-toggle-btn', e => e.getAttribute('aria-label'));
    check('encendida, la etiqueta YA NO dice "Avisarme" (ahí abre la gestión)',
          !/Avisarme/i.test(label), label);
    check('dice que están activados', /activad/i.test(label), label);
    check('el title acompaña a la etiqueta',
          (await page.$eval('#push-toggle-btn', e => e.getAttribute('title'))) === label);
    check('y expone el estado con aria-pressed',
          (await page.$eval('#push-toggle-btn', e => e.getAttribute('aria-pressed'))) === 'true');

    // ---- 5. El encendido no se comunica SOLO por color ----
    const punto = await page.$eval('#push-toggle-btn', e => {
      const c = getComputedStyle(e, '::after');
      return { content: c.content, w: parseFloat(c.width), h: parseFloat(c.height) };
    });
    check('hay un punto (forma, no color) que marca el encendido',
          punto.content !== 'none' && punto.w >= 6 && punto.h >= 6, JSON.stringify(punto));

    // ---- 6. Encendida abre la gestión, no desuscribe de un toque ----
    await page.click('#push-toggle-btn');
    await page.waitForTimeout(400);
    check('encendida abre la hoja de gestión',
          !(await page.$eval('#flow-overlay', e => e.hidden)) && !!(await page.$('#push-unsubscribe')));
    check('y no desuscribe sin confirmación',
          (await page.evaluate(() => window.__push.unsubs)) === 0);
    await page.click('#push-unsubscribe');
    await page.waitForTimeout(600);
    check('desde ahí sí se desactiva',
          (await page.evaluate(() => window.__push.unsubs)) === 1);
    check('y la campana vuelve a apagada',
          (await page.$eval('#push-toggle-btn', e => e.dataset.state)) === 'inactive');
    const apagada = await page.$eval('#push-toggle-btn', e => e.getAttribute('aria-pressed'));
    check('con aria-pressed en false', apagada === 'false', apagada);
    await page.close();
  }

  // ---- 7. Un dispositivo ya suscripto no se muestra como apagado ----
  {
    const page = await abrir(ctx, { yaSuscripto:true });
    await page.waitForTimeout(300);
    check('un dispositivo YA suscripto aparece encendido',
          (await page.$eval('#push-toggle-btn', e => e.dataset.state)) === 'active');
    await page.close();
  }

  check('sin errores de JavaScript', errores.length === 0, errores.join(' | '));

  await ctx.close();
  await browser.close();
  console.log(fails.length ? `\n>>> ${fails.length} CHEQUEO(S) FALLARON` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  process.exit(fails.length ? 1 : 0);
})();
