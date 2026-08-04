// Fotos opcionales, adjuntas DESPUÉS de publicar (v15.0).
//
// Qué protege, en orden de importancia:
//   * que reportar siga siendo UN toque — la foto no puede haber metido
//     ningún paso antes de publicar. Es la regresión que más caro saldría:
//     la gente reporta manejando.
//   * que la foto NO viaje en create_report (el servidor la rechaza desde
//     v14.1) sino por el Edge Function attach-photo, con el token de
//     propiedad
//   * que el pin muestre la cámara solo cuando hay foto
//   * que "Agregar foto" aparezca solo en el reporte propio y sin foto, y
//     "Denunciar foto" solo en el de otro
//   * que una denuncia que alcanza el umbral saque la foto de la vista
//
// OJO: como el resto de las suites, esto mockea la red. No prueba que el
// servidor valide la propiedad ni que la foto se borre de Storage — eso está
// en check-base-real.js y se verificó a mano contra producción.

const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const STUB = fs.readFileSync(__dirname + '/maplibre-stub.js', 'utf8');

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

// JPEG 1x1 real: compressImage() lo pasa por un <canvas>, así que tiene que
// ser decodificable de verdad, no bytes cualquiera.
const JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const OTRO = {
  id: 'r-ajeno', lat: 19.2214, lng: -70.5295, photo: 'https://ejemplo.test/x.jpg',
  note: '', ts: Date.now() - 60000, category: 'reten_fijo',
  confirms: 0, denies: 0, approx: false, photo_flags: 0
};

async function abrir(browser, opciones = {}) {
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

  let filas = opciones.filas || [];
  await page.route('**/rest/v1/reports*', r =>
    r.fulfill({ contentType:'application/json', body: JSON.stringify(filas) }));

  // El wildcard va PRIMERO: en Playwright gana la última ruta registrada, así
  // que las específicas de abajo tienen que ir después o este se las come.
  const rpcs = [];
  await page.route('**/rest/v1/rpc/**', r => {
    const fn = new URL(r.request().url()).pathname.split('/').pop();
    rpcs.push({ fn, args: JSON.parse(r.request().postData()||'{}') });
    return r.fulfill({ status:200, contentType:'application/json', body:'null' });
  });
  await page.route('**/rest/v1/rpc/create_report', r => {
    const args = JSON.parse(r.request().postData()||'{}');
    rpcs.push({ fn:'create_report', args });
    return r.fulfill({ status:200, contentType:'application/json',
                       body: JSON.stringify({ ok:true, reason:null, id:args.p_id }) });
  });
  await page.route('**/rest/v1/rpc/flag_photo', r => {
    const args = JSON.parse(r.request().postData()||'{}');
    rpcs.push({ fn:'flag_photo', args });
    return r.fulfill({ status:200, contentType:'application/json',
                       body: JSON.stringify(opciones.flagRespuesta || { flags:1, hidden:false }) });
  });

  const adjuntos = [];
  await page.route('**/functions/v1/attach-photo', r => {
    const body = JSON.parse(r.request().postData()||'{}');
    adjuntos.push(body);
    if(opciones.adjuntarFalla){
      return r.fulfill({ status:403, contentType:'application/json',
                         body: JSON.stringify({ ok:false, reason:'not_owner' }) });
    }
    return r.fulfill({ status:200, contentType:'application/json',
      body: JSON.stringify({ ok:true, photo:`https://sup.test/${body.id}.jpg` }) });
  });

  await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('amet_onboarded_v1','1');
    localStorage.removeItem('amet_report_times_v1');
  });
  await page.reload({ waitUntil:'domcontentloaded' });
  await page.waitForTimeout(700);
  return { ctx, page, rpcs, adjuntos, errores };
}

// Mete un archivo real en el <input type=file> oculto de la cámara.
async function sacarFoto(page){
  await page.setInputFiles('#camera-input', {
    name: 'foto.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(JPEG_B64, 'base64')
  });
  await page.waitForTimeout(700);
}

(async () => {
  const browser = await lanzar();

  // ---- 1. Publicar sigue siendo UN toque, y la foto es opcional ----
  {
    const { ctx, page, rpcs, adjuntos, errores } = await abrir(browser);

    await page.click('#report-btn');
    await page.waitForTimeout(600);

    const creados = rpcs.filter(r => r.fn === 'create_report');
    check('un toque publica, sin pantallas intermedias', creados.length === 1,
      'create_report=' + creados.length);
    check('la foto NO viaja en create_report (el servidor la rechaza)',
      creados[0] && creados[0].args.p_photo === null, JSON.stringify(creados[0] && creados[0].args.p_photo));
    check('no se adjuntó ninguna foto sin que el usuario la pida',
      adjuntos.length === 0, 'adjuntos=' + adjuntos.length);

    check('el aviso ofrece la foto como opción', !!(await page.$('[data-toast="foto"]')));
    check('y sigue ofreciendo Deshacer', !!(await page.$('[data-toast="undo"]')));

    // El pin recién publicado no tiene foto: no debe mostrar la cámara.
    check('sin foto, el pin no muestra la cámara',
      (await page.$$eval('.pin-cam', e => e.length)) === 0);

    // Adjuntar desde el toast
    await page.click('[data-toast="foto"]');
    await sacarFoto(page);

    check('adjuntar va por attach-photo, no por Storage directo',
      adjuntos.length === 1, 'adjuntos=' + adjuntos.length);
    const a = adjuntos[0] || {};
    check('manda el token de propiedad', typeof a.token === 'string' && a.token.length >= 16,
      String(a.token).slice(0, 12) + '…');
    check('manda el id del reporte recién publicado',
      a.id === (creados[0] && creados[0].args.p_id), String(a.id));
    check('manda la foto ya comprimida como data: URL',
      typeof a.photo === 'string' && a.photo.startsWith('data:image/jpeg;base64,'),
      String(a.photo).slice(0, 30));
    check('con la foto puesta, el pin muestra la cámara',
      (await page.$$eval('.pin-cam', e => e.length)) === 1);
    check('sin errores de JS', errores.length === 0, JSON.stringify(errores));
    await ctx.close();
  }

  // ---- 2. La hoja de detalle: quién puede adjuntar y quién denunciar ----
  {
    const { ctx, page } = await abrir(browser, { filas: [OTRO] });
    await page.waitForTimeout(300);

    await page.evaluate(() => document.querySelector('.amet-pin').click());
    await page.waitForTimeout(300);

    check('en el reporte de otro NO se ofrece agregar foto',
      (await page.$$eval('[data-action="add-photo"]', e => e.length)) === 0);
    check('en el reporte de otro SÍ se ofrece denunciar la foto',
      !!(await page.$('[data-action="flag-photo"]')));
    await ctx.close();
  }

  // ---- 3. Denunciar: al alcanzar el umbral la foto desaparece ----
  {
    const { ctx, page, rpcs } = await abrir(browser, {
      filas: [OTRO], flagRespuesta: { flags:3, hidden:true }
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('.amet-pin').click());
    await page.waitForTimeout(250);

    check('el reporte de otro con foto muestra la cámara en el pin',
      (await page.$$eval('.pin-cam', e => e.length)) === 1);

    await page.click('[data-action="flag-photo"]');
    await page.waitForTimeout(500);

    const f = rpcs.filter(r => r.fn === 'flag_photo');
    check('denunciar llama a flag_photo con el id', f.length === 1 && f[0].args.p_id === OTRO.id,
      JSON.stringify(f.map(x => x.args)));
    check('al alcanzar el umbral, la foto se saca de la hoja',
      (await page.$$eval('.detail-photo', e => e.length)) === 0);
    check('y el pin deja de mostrar la cámara',
      (await page.$$eval('.pin-cam', e => e.length)) === 0);

    // Segunda denuncia del mismo dispositivo: no debe volver a llamar.
    await page.evaluate(() => document.querySelector('.amet-pin').click());
    await page.waitForTimeout(250);
    const botones = await page.$$eval('[data-action="flag-photo"]', e => e.length);
    check('ya denunciada, no se puede volver a denunciar desde el mismo equipo',
      botones === 0 || (await page.$eval('[data-action="flag-photo"]', el => el.disabled)),
      'botones=' + botones);
    await ctx.close();
  }

  // ---- 4. Un rechazo del servidor se avisa, y no deja el pin mintiendo ----
  {
    const { ctx, page, errores } = await abrir(browser, { adjuntarFalla: true });
    await page.click('#report-btn');
    await page.waitForTimeout(600);
    await page.click('[data-toast="foto"]');
    await sacarFoto(page);

    const toast = await page.$$eval('.toast', els => els.map(e => e.textContent).join(' | '));
    check('si el servidor rechaza, se avisa con el motivo',
      /solo puedes agregarle foto a un reporte tuyo/i.test(toast), toast);
    check('y el pin NO muestra una cámara que no existe',
      (await page.$$eval('.pin-cam', e => e.length)) === 0);
    check('sin errores de JS', errores.length === 0, JSON.stringify(errores));
    await ctx.close();
  }

  await browser.close();
  console.log('');
  console.log(fails.length ? `>>> ${fails.length} FALLO(S): ${fails.join(' | ')}` : '>>> TODOS LOS CHEQUEOS PASARON');
  process.exit(fails.length ? 1 : 0);
})();
