// La app tiene que funcionar aunque el almacenamiento local NO funcione.
//
// POR QUÉ IMPORTA. `localStorage` no solo devuelve null cuando no hay nada:
// puede TIRAR. Pasa con la cuota llena, con "bloquear todas las cookies" en
// Safari y, sobre todo, en los navegadores embebidos que abren los links
// dentro de otra app — que es justamente por donde se comparte esta.
//
// EL BUG QUE CIERRA (v17.11): `canReport()` escribía sin protección y es lo
// PRIMERO que toca el botón de Reportar. Con el almacenamiento rechazando
// escrituras, la excepción se escapaba del handler del click y el botón
// principal de la app quedaba MUERTO en silencio: sin hoja, sin toast, sin
// llegar a la red y sin nada en pantalla. Lo mismo con `savePendingQueue()`,
// que tiraba desde dentro del `catch` de publicar y dejaba la hoja
// "Publicando…" colgada para siempre, justo en el caso de quedarse sin señal.
//
// LA REGLA QUE PRUEBA: si el almacenamiento falla, la app funciona igual pero
// se olvida de las cosas. Nunca deja de funcionar.
const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const STUB = fs.readFileSync(__dirname + '/maplibre-stub.js', 'utf8');

const GEO = `
window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
Object.defineProperty(navigator,'geolocation',{value:{
  watchPosition:(s)=>{setTimeout(()=>s({coords:{latitude:19.2214,longitude:-70.5295}}),40);return 1;},
  clearWatch:()=>{}},configurable:true});`;

// Doble de un almacenamiento que deja LEER pero rechaza toda escritura, que
// es la forma exacta en que se comporta un navegador con los datos de sitio
// bloqueados o con la cuota agotada.
const LS_SOLO_LECTURA = `
(() => {
  const store = {};
  Object.defineProperty(window,'localStorage',{configurable:true,value:{
    getItem:(k)=> (k in store ? store[k] : null),
    setItem:()=>{ const e = new Error('QuotaExceededError'); e.name='QuotaExceededError'; throw e; },
    removeItem:()=>{ throw new Error('bloqueado'); },
    key:()=>null, length:0, clear:()=>{}
  }});
})();`;

// Y el caso más bruto: ni siquiera se puede LEER (algunos webviews tiran al
// tocar la propiedad).
const LS_MUERTO = `
(() => {
  Object.defineProperty(window,'localStorage',{configurable:true,get(){
    throw new Error('acceso a localStorage bloqueado');
  }});
})();`;

const fails = [];
const check = (n, c, extra='') => {
  console.log((c ? '  OK  ' : ' FALLA') + ' | ' + n + (extra ? '  -> ' + extra : ''));
  if(!c) fails.push(n);
};

async function abrir(ctx, almacen, { red = 'ok' } = {}) {
  const rpcs = [];
  const p = await ctx.newPage();
  await p.addInitScript(GEO);
  await p.addInitScript(almacen);
  await p.route('**/maplibre-gl.js', r => r.fulfill({ contentType:'application/javascript', body: STUB }));
  await p.route('**/maplibre-gl.css', r => r.fulfill({ contentType:'text/css', body:'' }));
  await p.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType:'text/css', body:'' }));
  await p.route('**/tiles.openfreemap.org/**', r => r.abort());
  await p.route('**/rest/v1/app_config*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
  await p.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
  await p.route('**/rest/v1/rpc/**', r => {
    rpcs.push(r.request().url().split('/rpc/')[1]);
    if(red === 'caida') return r.abort();
    return r.fulfill({ status:200, contentType:'application/json',
                       body: JSON.stringify({ ok:true, reason:null, id:'x' }) });
  });
  await p.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
  await p.waitForTimeout(1200);
  const w = await p.$('#welcome-ok'); if(w){ await w.click(); await p.waitForTimeout(250); }
  return { p, rpcs };
}

const toast = (p) => p.evaluate(() => {
  const t = document.querySelector('.toast');
  return t ? t.textContent.trim() : '';
});

(async () => {
  const browser = await lanzar();

  // ---- 1. Escrituras rechazadas: publicar tiene que funcionar igual ----
  {
    const errores = [];
    const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
    ctx.on('page', pg => pg.on('pageerror', e => errores.push(String(e))));
    const { p, rpcs } = await abrir(ctx, LS_SOLO_LECTURA);

    check('la app arranca con el almacenamiento rechazando escrituras',
          !!(await p.$('#map')));

    await p.click('#report-btn');
    await p.waitForTimeout(1400);

    // EL BUG: la excepción de canReport() se escapaba del handler y acá no
    // llegaba a pasar absolutamente nada.
    check('EL BUG: el botón Reportar llega a la red en vez de morir en silencio',
          rpcs.includes('create_report'), JSON.stringify(rpcs));
    check('y el usuario ve que se publicó', /publicado/i.test(await toast(p)), await toast(p));
    check('el marcador queda dibujado',
          (await p.evaluate(() => Object.keys(window.__markers || {}).length)) >= 1);
    check('sin ninguna excepción sin capturar', errores.length === 0, errores.join(' | '));
    await p.close(); await ctx.close();
  }

  // ---- 2. Sin señal Y sin poder guardar: la cola no puede colgar la hoja ----
  {
    const errores = [];
    const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
    ctx.on('page', pg => pg.on('pageerror', e => errores.push(String(e))));
    const { p } = await abrir(ctx, LS_SOLO_LECTURA, { red:'caida' });

    await p.click('#report-btn');
    await p.waitForTimeout(1600);
    const hoja = await p.evaluate(() => {
      const h = document.querySelector('.sheet h2');
      return h ? h.textContent.trim() : '';
    });
    // savePendingQueue() tiraba DESDE DENTRO del catch de publicar, así que
    // la excepción se escapaba y "Publicando…" se quedaba en pantalla.
    check('sin señal, la hoja "Publicando…" NO queda colgada', hoja !== 'Publicando…', hoja || '(cerrada)');
    check('y se avisa que quedó en cola', /sin conexión/i.test(await toast(p)), await toast(p));
    check('sin ninguna excepción sin capturar', errores.length === 0, errores.join(' | '));
    await p.close(); await ctx.close();
  }

  // ---- 3. Ni siquiera se puede leer ----
  {
    const errores = [];
    const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
    ctx.on('page', pg => pg.on('pageerror', e => errores.push(String(e))));
    const { p, rpcs } = await abrir(ctx, LS_MUERTO);
    check('la app arranca aunque tocar localStorage tire', !!(await p.$('#map')));
    await p.click('#report-btn');
    await p.waitForTimeout(1400);
    check('y se puede publicar igual', rpcs.includes('create_report'), JSON.stringify(rpcs));
    check('sin ninguna excepción sin capturar', errores.length === 0, errores.join(' | '));
    await p.close(); await ctx.close();
  }

  // ---- 4. Que no queden accesos crudos sueltos ----
  // Se lee el archivo del repo, no el DOM: la protección tiene que valer para
  // el código futuro también, no solo para los caminos que esta suite recorre.
  {
    const src = fs.readFileSync(__dirname + '/../amet-radar.html', 'utf8');
    const crudos = src.split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /localStorage\s*\./.test(l))
      .filter(({ l }) => !/function ls(Get|Set|Del)\b/.test(l))
      .filter(({ l }) => !/^\s*\/\//.test(l));
    check('todo acceso a localStorage pasa por los ayudantes ls*()',
          crudos.length === 0,
          crudos.map(c => 'línea ' + c.n).join(', '));
  }

  await browser.close();
  console.log(fails.length ? `\n>>> ${fails.length} CHEQUEO(S) FALLARON` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  process.exit(fails.length ? 1 : 0);
})();
