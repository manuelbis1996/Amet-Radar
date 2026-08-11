// El arranque en frío: que la app se vea y se pueda usar aunque el GPS no
// conteste nunca, y que no mienta cuando el servidor no responde.
//
// Es el primer tramo del embudo del lanzamiento y hasta v16.4 perdía gente
// por dos razones que no tienen nada que ver con si hay retenes:
//   * el loader tapaba la pantalla hasta 20 s esperando al GPS, con el mapa
//     ya dibujado detrás;
//   * con el permiso de ubicación denegado, el botón principal NO FUNCIONABA
//     NUNCA MÁS (mostraba un toast y volvía);
//   * un mapa vacío por Supabase caído se veía igual que "no hay retenes",
//     que es el estado normal del día 1.
const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const DIR = __dirname;
const STUB = fs.readFileSync(DIR + '/maplibre-stub.js', 'utf8');

// GPS que NO contesta nunca: ni success ni error. Es el caso que dejaba la
// pantalla opaca, y el que no se puede simular esperando el timeout real.
const GEO_MUDO = `
window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
Object.defineProperty(navigator,'geolocation',{value:{
  watchPosition:()=>1, clearWatch:()=>{}},configurable:true});`;

// Permiso denegado (código 1), igual que en check-gps.js.
const GEO_DENEGADO = `
window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
Object.defineProperty(navigator,'geolocation',{value:{
  watchPosition:(s,e)=>{setTimeout(()=>e({code:1,message:'denied'}),40);return 1;},
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

async function nuevaPagina(browser, geo, extra){
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  const page = await ctx.newPage();
  await page.addInitScript(geo);
  if(extra) await page.addInitScript(extra);
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
  // 1. El loader se va con el mapa, no con el GPS
  // =====================================================================
  {
    const { ctx, page } = await nuevaPagina(browser, GEO_MUDO);
    page.on('pageerror', e => errores.push(String(e)));
    await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
    await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(700);
    const oculto = await page.$eval('#map-loader', el => el.hidden);
    check('EL BUG: con el GPS mudo, el loader igual se va (antes: hasta 20 s de pantalla opaca)',
          oculto === true);
    check('el loader ya no promete "Buscando tu ubicación"',
          !/Buscando tu ubicación/.test(await textoYa(page, '#map-loader span', '')),
          await textoYa(page, '#map-loader span', ''));
    await ctx.close();
  }

  // =====================================================================
  // 2. Si el estilo del mapa NUNCA carga, el tope de seguridad lo suelta
  // =====================================================================
  {
    const { ctx, page } = await nuevaPagina(browser, GEO_MUDO, `window.__mapNoLoad = true;`);
    page.on('pageerror', e => errores.push(String(e)));
    await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
    await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(600);
    const antes = await page.$eval('#map-loader', el => el.hidden);
    check("sin evento 'load' todavía está tapado a los 0,6 s (o sea que el tope es lo que lo suelta)",
          antes === false);
    await page.waitForTimeout(3400);
    const despues = await page.$eval('#map-loader', el => el.hidden);
    check('el tope de seguridad lo suelta igual (estilo caído no deja la pantalla opaca para siempre)',
          despues === true);
    await ctx.close();
  }

  // =====================================================================
  // 3. El primer fix del GPS no le salta el mapa a quien ya paneó
  // =====================================================================
  {
    const GEO_LENTO = `
      window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
      Object.defineProperty(navigator,'geolocation',{value:{
        watchPosition:(s)=>{ window.__darFix = () => s({coords:{latitude:19.2214,longitude:-70.5295}}); return 1; },
        clearWatch:()=>{}},configurable:true});`;
    const { ctx, page } = await nuevaPagina(browser, GEO_LENTO);
    page.on('pageerror', e => errores.push(String(e)));
    await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
    await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(700);
    const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(200); }
    // El usuario toma el mapa y recién DESPUÉS llega el GPS.
    await page.evaluate(() => { window.__map.fire('dragstart'); window.__map._calls.length = 0; });
    await page.evaluate(() => window.__darFix());
    await page.waitForTimeout(200);
    const saltos = await page.evaluate(() => window.__map._calls.filter(c => c[0] === 'jumpTo').length);
    check('si el usuario ya paneó, el primer fix NO le recentra el mapa encima', saltos === 0,
          'jumpTo=' + saltos);
    await ctx.close();
  }
  {
    // Y el contraejemplo: sin paneo, sí tiene que centrar.
    const GEO_LENTO = `
      window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
      Object.defineProperty(navigator,'geolocation',{value:{
        watchPosition:(s)=>{ window.__darFix = () => s({coords:{latitude:19.2214,longitude:-70.5295}}); return 1; },
        clearWatch:()=>{}},configurable:true});`;
    const { ctx, page } = await nuevaPagina(browser, GEO_LENTO);
    page.on('pageerror', e => errores.push(String(e)));
    await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
    await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(700);
    await page.evaluate(() => { window.__map._calls.length = 0; window.__darFix(); });
    await page.waitForTimeout(200);
    const saltos = await page.evaluate(() => window.__map._calls.filter(c => c[0] === 'jumpTo').length);
    check('sin paneo previo, el primer fix sí centra el mapa (no se rompió el comportamiento)',
          saltos === 1, 'jumpTo=' + saltos);
    await ctx.close();
  }

  // =====================================================================
  // 4. Sin GPS se puede reportar igual, con el pin
  // =====================================================================
  {
    const { ctx, page } = await nuevaPagina(browser, GEO_DENEGADO);
    page.on('pageerror', e => errores.push(String(e)));
    await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
    const rpcs = [];
    await page.route('**/rest/v1/rpc/**', r => {
      const fn = new URL(r.request().url()).pathname.split('/').pop();
      let args = {}; try{ args = JSON.parse(r.request().postData() || '{}'); }catch(e){}
      rpcs.push({ fn, args });
      const body = fn === 'create_report' ? JSON.stringify({ ok:true, reason:null }) : 'null';
      return r.fulfill({ status:200, contentType:'application/json', body });
    });
    await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(800);
    const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(250); }

    await page.click('#report-btn');
    await page.waitForTimeout(400);
    const titulo = await textoYa(page, '.sheet h2');
    check('EL BUG: sin GPS, reportar abre el pin en vez de morir en un toast',
          /marca el lugar/i.test(titulo), titulo);
    check('hay un pin fijo en el centro para marcar', (await page.$$('.pick-fijo')).length === 1);

    // El usuario mueve el mapa hasta poner el lugar bajo el pin, y confirma.
    await page.evaluate(() => window.__map.jumpTo({ center: [-70.5100, 19.2400] }));
    await page.waitForTimeout(120);
    await page.click('#pick-confirm');
    await page.waitForTimeout(900);

    const creados = rpcs.filter(r => r.fn === 'create_report');
    check('se publicó exactamente 1 reporte', creados.length === 1, 'n=' + creados.length);
    const a = (creados[0] || {}).args || {};
    check('publica las coordenadas DEL PIN, no las del dispositivo',
          Math.abs(a.p_lat - 19.2400) < 1e-6 && Math.abs(a.p_lng - (-70.5100)) < 1e-6,
          JSON.stringify({ lat:a.p_lat, lng:a.p_lng }));
    check('un punto puesto a mano se publica como pin exacto, no como zona',
          a.p_approx === false, 'approx=' + a.p_approx);
    check('sigue sin foto y sin nota (no se reactivó el flujo con foto)',
          a.p_photo === null && (a.p_note === '' || a.p_note == null),
          JSON.stringify({ photo:a.p_photo, note:a.p_note }));
    check('lleva owner_hash, así que su autor puede borrarlo',
          /^[0-9a-f]{64}$/.test(a.p_owner_hash || ''), String(a.p_owner_hash).slice(0,16) + '…');
    check('NO se preguntó la categoría (hay una sola)', (await page.$$('.cat-option')).length === 0);
    await ctx.close();
  }

  // =====================================================================
  // 5. "No hay retenes" y "no pude conectarme" dejan de verse igual
  // =====================================================================
  {
    const { ctx, page } = await nuevaPagina(browser, GEO_DENEGADO);
    page.on('pageerror', e => errores.push(String(e)));
    let caido = true;
    await page.route('**/rest/v1/reports*', r => caido
      ? r.fulfill({ status:500, contentType:'application/json', body:'{"message":"boom"}' })
      : r.fulfill({ contentType:'application/json', body:'[]' }));
    await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(800);
    const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(300); }

    const visible = await page.$eval('#empty-state', el => !el.hidden);
    const texto = await textoYa(page, '.empty-card');
    check('EL BUG: con el servidor caído se avisa (antes el mapa quedaba mudo)', visible === true);
    check('y el aviso dice que es de conexión, no "Todo tranquilo"',
          /conexión|conexion/i.test(texto), texto);

    // Se recupera el servidor: el aviso tiene que volver a ser el de vacío.
    caido = false;
    await page.evaluate(() => { document.getElementById('empty-state').hidden = true; });
    await page.waitForTimeout(9000);
    const texto2 = await textoYa(page, '.empty-card');
    check('cuando el servidor vuelve, el mensaje pasa a ser el de mapa vacío',
          /tranquilo/i.test(texto2), texto2);
    await ctx.close();
  }

  // =====================================================================
  // 6. Un voto que no llegó al servidor no se da por bueno
  // =====================================================================
  {
    const { ctx, page } = await nuevaPagina(browser, GEO_DENEGADO);
    page.on('pageerror', e => errores.push(String(e)));
    const R = { id:'r1', lat:19.2220, lng:-70.5300, photo:null, note:'',
      ts: Date.now()-120000, category:'reten_fijo', confirms:0, denies:0, approx:false };
    await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body: JSON.stringify([R]) }));
    let votoCae = true;
    await page.route('**/rest/v1/rpc/**', r => {
      const fn = new URL(r.request().url()).pathname.split('/').pop();
      if(fn === 'vote_report' && votoCae) return r.abort();
      if(fn === 'vote_report') return r.fulfill({ status:200, contentType:'application/json',
        body: JSON.stringify([{ confirms:1, denies:0, removed:false }]) });
      return r.fulfill({ status:200, contentType:'application/json', body:'null' });
    });
    await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(800);
    const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(250); }

    await page.$eval('.amet-pin', el => el.click());
    await page.waitForTimeout(250);
    await page.$eval('[data-action="confirm"]', el => el.click());
    await page.waitForTimeout(700);

    check('EL BUG: si el voto no llega, se avisa en vez de decir "Gracias por confirmar"',
          /no se pudo registrar/i.test(await textoYa(page, '.toast', '')),
          await textoYa(page, '.toast', ''));
    const guardado = await page.evaluate(() => {
      try{ return localStorage.getItem('amet_voted_v1') || ''; }catch(e){ return 'error'; }
    });
    check('y NO queda marcado como votado (antes se perdía el voto Y el reintento)',
          !/r1/.test(guardado), guardado);
    check('los botones vuelven a estar habilitados para reintentar',
          (await page.$$('[data-action="confirm"]:not([disabled])')).length === 1);

    // Ahora sí entra: el camino feliz no se rompió. Se espera a que el toast
    // anterior se vaya solo (2,6 s): si no, conviven dos y la lectura de
    // `.toast` devuelve el viejo, dando un rojo que no es del código.
    votoCae = false;
    await page.waitForTimeout(2800);
    await page.$eval('[data-action="confirm"]', el => el.click());
    await page.waitForTimeout(700);
    check('con el servidor respondiendo, el voto sí se registra',
          /r1/.test(await page.evaluate(() => { try{ return localStorage.getItem('amet_voted_v1') || ''; }catch(e){ return ''; } })));
    check('y se agradece', /gracias/i.test(await textoYa(page, '.toast', '')),
          await textoYa(page, '.toast', ''));
    await ctx.close();
  }

  // =====================================================================
  // 7. CON GPS también se puede marcar en otro punto
  //
  // Hasta v17.2 el pin manual solo aparecía sin GPS, así que con la ubicación
  // andando no había forma de avisar de un retén que no fuera donde uno está
  // parado — y ese es medio caso real: te lo cuentan, o lo pasaste hace diez
  // cuadras. Lo que NO puede pasar es que esto le agregue un toque al camino
  // rápido, que es el que se usa manejando.
  // =====================================================================
  {
    const GEO_OK = `
      window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
      Object.defineProperty(navigator,'geolocation',{value:{
        watchPosition:(s)=>{setTimeout(()=>s({coords:{latitude:19.2214,longitude:-70.5295}}),40);return 1;},
        clearWatch:()=>{}},configurable:true});`;
    const { ctx, page } = await nuevaPagina(browser, GEO_OK);
    page.on('pageerror', e => errores.push(String(e)));
    await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
    const rpcs = [];
    await page.route('**/rest/v1/rpc/**', r => {
      const fn = new URL(r.request().url()).pathname.split('/').pop();
      let args = {}; try{ args = JSON.parse(r.request().postData() || '{}'); }catch(e){}
      rpcs.push({ fn, args });
      const body = fn === 'create_report' ? JSON.stringify({ ok:true, reason:null }) : 'null';
      return r.fulfill({ status:200, contentType:'application/json', body });
    });
    await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(800);
    const w = await page.$('#welcome-ok'); if(w){ await w.click(); await page.waitForTimeout(250); }

    check('con GPS hay un botón para marcar en otro punto', !!(await page.$('#pick-btn')));

    // El camino rápido no cambia: sigue publicando de un toque, sin preguntar.
    await page.click('#report-btn');
    await page.waitForTimeout(1000);
    const rapidos = rpcs.filter(r => r.fn === 'create_report');
    check('«Reportar» sigue siendo UN toque, sin pantallas nuevas',
          rapidos.length === 1 && (await page.$eval('#flow-overlay', el => el.hidden)) === true,
          'publicados=' + rapidos.length);
    const aRapido = (rapidos[0] || {}).args || {};
    check('y ese sigue usando el GPS, como zona aproximada',
          Math.abs(aRapido.p_lat - 19.2214) < 0.01 && aRapido.p_approx === true,
          JSON.stringify({ lat:aRapido.p_lat, approx:aRapido.p_approx }));

    // Ahora el camino nuevo: marcar lejos de donde estoy.
    await page.evaluate(() => { try{ localStorage.removeItem('amet_report_times_v1'); }catch(e){} });
    await page.waitForTimeout(6300); // que venza el toast de Deshacer
    const of = await page.$('#push-later'); if(of){ await of.click(); await page.waitForTimeout(300); }

    await page.click('#pick-btn');
    await page.waitForTimeout(500);
    check('EL PEDIDO: con GPS igual se abre «Marca el lugar»',
          /marca el lugar/i.test(await textoYa(page, '.sheet h2')), await textoYa(page, '.sheet h2'));
    check('el pin queda fijo en el centro de la pantalla', (await page.$$('.pick-fijo')).length === 1);
    const centrado = await page.evaluate(() => {
      const el = document.querySelector('.pick-fijo');
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), cx: Math.round(window.innerWidth / 2),
               y: Math.round(r.top), cy: Math.round(window.innerHeight / 2),
               toques: getComputedStyle(el).pointerEvents };
    });
    check('está en el centro exacto, que es lo que se va a publicar',
          Math.abs(centrado.x - centrado.cx) <= 1 && Math.abs(centrado.y - centrado.cy) <= 1,
          JSON.stringify(centrado));
    check('y no intercepta los toques (si no, no se podría arrastrar el mapa)',
          centrado.toques === 'none', centrado.toques);

    // Se mueve el mapa, no el pin.
    await page.evaluate(() => window.__map.jumpTo({ center: [-70.4900, 19.2650] }));
    await page.waitForTimeout(150);
    await page.click('#pick-confirm');
    await page.waitForTimeout(900);

    const marcados = rpcs.filter(r => r.fn === 'create_report');
    check('se publicó el segundo reporte', marcados.length === 2, 'n=' + marcados.length);
    const a = (marcados[1] || {}).args || {};
    check('EL PEDIDO: publica donde quedó el pin, NO donde está el dispositivo',
          Math.abs(a.p_lat - 19.2650) < 1e-6 && Math.abs(a.p_lng - (-70.4900)) < 1e-6,
          JSON.stringify({ lat:a.p_lat, lng:a.p_lng }));
    check('un punto elegido a mano va como pin exacto, no como zona',
          a.p_approx === false, 'approx=' + a.p_approx);
    check('lleva owner_hash, así que se puede borrar',
          /^[0-9a-f]{64}$/.test(a.p_owner_hash || ''));
    check('el pin se limpia al terminar', (await page.$$('.pick-fijo')).length === 0);
    await ctx.close();
  }

  check('sin errores de JavaScript', errores.length === 0, errores.join(' | '));

  await browser.close();
  console.log(fails.length ? `\n>>> ${fails.length} CHEQUEO(S) FALLARON` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  process.exit(fails.length ? 1 : 0);
})();
