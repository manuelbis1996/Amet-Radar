// Hoja "Acerca de" (v17.8): contacto, privacidad y encuadre.
//
// Lo que se vigila acá, y por qué cada cosa:
//  - que el botón ⓘ exista y abra la hoja, y que la topbar siga entrando en
//    320px con tres botones (era de dos: el tercero podía empujar la marca
//    fuera de la pantalla);
//  - que el correo NO esté escrito entero en el HTML servido. Es el punto
//    del ejercicio: se arma en tiempo de ejecución para que no lo levante un
//    scraper. Si alguien lo "simplifica" a un mailto literal, esto se pone
//    en rojo;
//  - que el enlace de la bienvenida lleve a la misma hoja, que es por donde
//    pasa la gente nueva;
//  - que admin.html tenga noindex.
const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const DIR = __dirname;
const STUB = fs.readFileSync(DIR + '/maplibre-stub.js', 'utf8');

const GEO = `
// Sin esto el stub cae a unos límites por defecto sobre Santo Domingo, los
// reportes de La Vega quedan fuera del área visible y el contador de la marca
// se queda en 0 — o sea que el caso de varios dígitos, que es el que ensancha
// la marca, no se estaría probando.
window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
Object.defineProperty(navigator,'geolocation',{value:{
  watchPosition:(s)=>{setTimeout(()=>s({coords:{latitude:19.2214,longitude:-70.5295}}),40);return 1;},
  clearWatch:()=>{}},configurable:true});`;

const fails = [];
const check = (n, c, extra = '') => {
  console.log((c ? '  OK  ' : ' FALLA') + ' | ' + n + (extra ? '  -> ' + extra : ''));
  if (!c) fails.push(n);
};

const CORREO = 'manuelbis1996' + String.fromCharCode(64) + 'gmail.com';

async function preparar(page) {
  page.on('pageerror', e => fails.push('JS: ' + e));
  await page.addInitScript(GEO);
  await page.route('**/maplibre-gl.js', r => r.fulfill({ contentType: 'application/javascript', body: STUB }));
  await page.route('**/maplibre-gl.css', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/tiles.openfreemap.org/**', r => r.abort());
  await page.route('**/rest/v1/app_config*', r => r.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(REPORTES) }));
}

// Con reportes en pantalla, no con el mapa vacío: el contador de la marca
// ("N en vista") crece con los dígitos, y medir siempre con 0 escondía justo
// el caso que rompía.
const REPORTES = [...Array(128)].map((_, i) => ({
  id: 'r' + i, lat: 19.2214 + (i % 20) * 0.0006, lng: -70.5295 + Math.floor(i / 20) * 0.0006,
  photo: null, note: '', ts: Date.now() - 60000, category: 'reten_fijo',
  confirms: 0, denies: 0, approx: false, photo_flags: 0
}));

// Los cuatro anchos de teléfono que importan. Hasta v17.9 esto se medía SOLO
// a 320px, y ahí el contador de la marca está oculto por un `@media`: o sea
// que la única medición era la del único ancho donde el problema no podía
// aparecer. A 360 y 390 —los dos más comunes— la campana se salía de la
// pantalla por 47 y 17px.
const ANCHOS = [320, 360, 390, 412];

async function medirTopbar(browser, ancho) {
  const ctx = await browser.newContext({ viewport: { width: ancho, height: 720 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await preparar(page);
  await page.goto(BASE + '/amet-radar.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  const w = await page.$('#welcome-ok'); if (w) { await w.click(); await page.waitForTimeout(250); }
  const caja = await page.evaluate(() => {
    const r = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right) }; };
    const nombre = document.querySelector('.brand-name');
    return {
      marca: r(document.querySelector('.brand')),
      acciones: r(document.querySelector('.topbar-actions')),
      campana: r(document.getElementById('push-toggle-btn')),
      recortado: nombre.scrollWidth > nombre.clientWidth + 1,
      cuenta: document.getElementById('stat-count').textContent,
      ancho: window.innerWidth
    };
  });
  await ctx.close();
  return caja;
}

(async () => {
  const browser = await lanzar();

  // ---- 1. El correo no viaja escrito en el fuente ----
  const fuente = fs.readFileSync(DIR + '/../amet-radar.html', 'utf8');
  check('el correo no está escrito entero en el HTML servido', !fuente.includes(CORREO),
        'debe armarse en runtime, si no lo levanta un scraper');

  // ---- 2. Desde la topbar, en la pantalla más angosta ----
  const ctx = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await preparar(page);
  await page.goto(BASE + '/amet-radar.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  // La bienvenida se abre sola la primera vez: su enlace es la otra vía.
  check('la bienvenida ofrece la hoja', !!(await page.$('#welcome-about')));
  await page.click('#welcome-about');
  await page.waitForTimeout(250);
  check('el enlace de la bienvenida abre la hoja', !!(await page.$('#about-ok')));
  await page.click('#about-ok');
  await page.waitForTimeout(250);
  check('la hoja se cierra', (await page.$('#about-ok')) === null);

  // La topbar con tres botones tiene que seguir entrando.
  const caja = await page.evaluate(() => {
    const r = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), h: Math.round(b.height), w: Math.round(b.width) }; };
    const btn = document.getElementById('about-btn');
    const marca = document.querySelector('.brand');
    const acciones = document.querySelector('.topbar-actions');
    return { btn: r(btn), marca: r(marca), acciones: r(acciones), ancho: window.innerWidth };
  });
  check('[320px] el botón ⓘ mide 44px (mínimo táctil)', caja.btn.h >= 44 && caja.btn.w >= 44,
        `${caja.btn.w}x${caja.btn.h}`);

  await page.click('#about-btn');
  await page.waitForTimeout(250);
  check('el botón ⓘ de la topbar abre la hoja', !!(await page.$('#about-ok')));

  // ---- 3. Contenido: las tres cosas que la hoja tiene que decir ----
  const hoja = await page.evaluate(() => {
    const s = document.querySelector('.sheet');
    const mail = document.getElementById('about-mail');
    return {
      texto: s ? s.textContent : '',
      mailto: mail ? mail.getAttribute('href') : null,
      mailVisible: mail ? mail.textContent.trim() : null,
      github: (() => { const a = [...document.querySelectorAll('.about-contacto a')].find(x => (x.getAttribute('href') || '').includes('github')); return a ? a.getAttribute('href') : null; })(),
      ancho: Math.round(s.getBoundingClientRect().width),
      pantalla: window.innerWidth,
    };
  });
  check('dice quién la hizo', /Manuelbis/i.test(hoja.texto) && /ingeniero en software/i.test(hoja.texto));
  check('el mailto lleva el correo', hoja.mailto === `mailto:${CORREO}?subject=AMET%20Radar`, String(hoja.mailto));
  check('el correo se ve en pantalla', hoja.mailVisible === CORREO, String(hoja.mailVisible));
  check('enlaza el GitHub', hoja.github === 'https://github.com/manuelbis1996', String(hoja.github));
  check('avisa que los reportes no están verificados', /no están verificados/i.test(hoja.texto));
  check('avisa de no usar el teléfono al volante', /No uses el teléfono mientras manejas/i.test(hoja.texto));
  check('dice que no hay cuentas ni registro', /sin cuentas y sin registro/i.test(hoja.texto));
  check('explica qué pasa con la ubicación', /No se guarda tu recorrido/i.test(hoja.texto));
  check('dice que no queda registrado quién publicó', /No queda registrado quién lo publicó/i.test(hoja.texto));
  check('muestra la versión', /Versión v\d+\.\d+/.test(hoja.texto), hoja.texto.slice(-24));
  check('[320px] la hoja no desborda a lo ancho', hoja.ancho <= hoja.pantalla, `${hoja.ancho} vs ${hoja.pantalla}`);

  await page.screenshot({ path: DIR + '/acerca-hoja.png' });

  // La hoja es más alta que la pantalla, así que el contacto queda abajo del
  // corte: hay que poder LLEGAR. Es el chequeo que más importa de los de
  // layout — un cambio que atrape el correo fuera de alcance vaciaría la
  // razón de ser de la hoja, y en una captura del principio no se notaría.
  const alcance = await page.evaluate(async () => {
    const hoja = document.querySelector('.sheet');
    hoja.scrollTop = hoja.scrollHeight;
    await new Promise(r => setTimeout(r, 120));
    const b = document.getElementById('about-mail').getBoundingClientRect();
    const h = hoja.getBoundingClientRect();
    return { desplazable: hoja.scrollHeight > hoja.clientHeight + 4,
             dentro: b.top >= h.top - 1 && b.bottom <= h.bottom + 1,
             alto: Math.round(b.height) };
  });
  check('la hoja scrollea (no recorta el contenido)', alcance.desplazable);
  check('se puede llegar al correo scrolleando', alcance.dentro);
  check('el enlace del correo respeta el mínimo táctil', alcance.alto >= 44, alcance.alto + 'px');
  await page.evaluate(() => { document.querySelector('.sheet').scrollTop = 0; });

  // Tocar afuera la cierra, como cualquier otra hoja del flujo.
  await page.mouse.click(160, 40);
  await page.waitForTimeout(250);
  check('tocar afuera la cierra', (await page.$('#about-ok')) === null);
  await ctx.close();

  // ---- 4. El panel de admin no se indexa ----
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.route('**/maplibre-gl.js', r => r.fulfill({ contentType: 'application/javascript', body: STUB }));
  await page2.route('**/maplibre-gl.css', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page2.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page2.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  const robots = await page2.evaluate(() => {
    const m = document.querySelector('meta[name="robots"]');
    return m ? m.getAttribute('content') : null;
  });
  check('admin.html tiene noindex', !!robots && /noindex/.test(robots), String(robots));
  await ctx2.close();

  // ---- La topbar entra en TODOS los anchos de teléfono, con el mapa lleno ----
  for(const ancho of ANCHOS){
    const c = await medirTopbar(browser, ancho);
    console.log(`\n[${ancho}px] cuenta=${c.cuenta} | marca →${c.marca.r} | botones ${c.acciones.l}→ | campana →${c.campana.r} de ${c.ancho}`);
    check(`[${ancho}px] la campana NO se sale de la pantalla`, c.campana.r <= c.ancho,
          `termina en ${c.campana.r} de ${c.ancho}`);
    check(`[${ancho}px] la marca no se solapa con los botones`, c.marca.r <= c.acciones.l,
          `marca hasta ${c.marca.r}, botones desde ${c.acciones.l}`);
    check(`[${ancho}px] el nombre de la app no queda recortado`, !c.recortado,
          'la elipsis es la red de seguridad, no el aspecto normal');
  }

  // ---- La red de seguridad, ejercitada donde NADA alcanza ----
  // A 280px (teléfonos viejos, o el navegador con mucho zoom) la marca entera
  // más los tres botones no entran de ninguna manera. Lo que tiene que pasar
  // es que ceda la marca —recortando el nombre— y NUNCA que se vaya un botón
  // fuera de la pantalla. Sin `min-width:0` + `overflow:hidden` en `.brand`,
  // nada de la fila puede encogerse y la campana termina fuera del viewport.
  // Este chequeo es el único que prueba esa capa: el `@media` que oculta el
  // contador tapa el caso en los anchos normales.
  {
    const c = await medirTopbar(browser, 280);
    console.log(`\n[280px] marca →${c.marca.r} | campana →${c.campana.r} de ${c.ancho} (recortado=${c.recortado})`);
    check('[280px] aunque no entre, la campana sigue dentro de la pantalla',
          c.campana.r <= c.ancho, `termina en ${c.campana.r} de ${c.ancho}`);
    check('[280px] la que cede es la marca, no los botones', c.recortado,
          'el nombre tiene que recortarse; si no, algo más se está saliendo');
  }

  console.log(fails.length ? `\n>>> ${fails.length} FALLO(S): ${fails.join(' | ')}` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
