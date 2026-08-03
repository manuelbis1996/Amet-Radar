const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const DIR = __dirname;
const STUB = fs.readFileSync(DIR + '/maplibre-stub.js', 'utf8');

const GEO = `
window.__bounds = { n: 19.30, s: 19.14, e: -70.45, w: -70.62 };
Object.defineProperty(navigator,'geolocation',{value:{
  watchPosition:(s)=>{setTimeout(()=>s({coords:{latitude:19.2214,longitude:-70.5295}}),40);return 1;},
  clearWatch:()=>{}},configurable:true});`;

const now = Date.now();
// Fixture mutable: así la segunda visita puede tener reportes sin recrear
// el contexto (recrearlo vaciaría el localStorage y la bienvenida volvería
// a aparecer, que es justo lo que hay que verificar que NO pasa).
let reportsFixture = [];
const UN_REPORTE = [{ id:'a', lat:19.2230, lng:-70.5300, photo:null, note:'Frente al parque',
  ts: now-4*60000, category:'reten_fijo', confirms:3, denies:0, approx:false }];

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
  await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body: JSON.stringify(reportsFixture) }));

  // ================= PRIMERA VISITA (sin reportes) =================
  await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(800);

  const h2 = await page.textContent('.sheet h2').catch(() => '(sin hoja)');
  check('primera visita: aparece la bienvenida', /Bienvenido/i.test(h2), h2);
  await page.screenshot({ path: DIR + '/ux-1-bienvenida.png' });
  await page.click('#welcome-ok');
  await page.waitForTimeout(250);
  check('"Entendido" cierra la bienvenida', await page.$eval('#flow-overlay', el => el.hidden));

  check('sin reportes: se muestra el estado vacío', await page.$eval('#empty-state', el => !el.hidden));
  const pe = await page.$eval('#empty-state', el => getComputedStyle(el).pointerEvents);
  check('el estado vacío no bloquea el arrastre del mapa', pe === 'none', 'pointer-events=' + pe);
  await page.screenshot({ path: DIR + '/ux-2-estado-vacio.png' });

  // no debe quedarse pegado: se va solo a los 7s
  await page.waitForTimeout(7300);
  check('el estado vacío se oculta solo (no se queda pegado)',
        await page.$eval('#empty-state', el => el.hidden));

  // y no reaparece en el siguiente sondeo de 8s aunque siga sin haber reportes
  await page.waitForTimeout(8500);
  check('no reaparece en el sondeo siguiente',
        await page.$eval('#empty-state', el => el.hidden));

  const headerTxt = await page.textContent('.brand');
  check('el header ya no muestra la versión', !/v\d+\.\d+/.test(headerTxt), JSON.stringify(headerTxt.trim()));
  await page.evaluate(() => document.querySelector('.brand')
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await page.waitForTimeout(900);
  const toast = await page.textContent('.toast').catch(() => '(sin toast)');
  check('mantener presionado el logo revela la versión', /v\d+\.\d+/.test(toast), toast);

  // ============ SEGUNDA VISITA (mismo contexto, con reportes) ============
  reportsFixture = UN_REPORTE;
  await page.reload({ waitUntil:'domcontentloaded' });
  await page.waitForTimeout(800);

  check('segunda visita: la bienvenida no vuelve a aparecer',
        await page.$eval('#flow-overlay', el => el.hidden));
  check('con reportes: el estado vacío se oculta',
        await page.$eval('#empty-state', el => el.hidden));

  await page.$eval('.amet-pin', el => el.click());
  await page.waitForTimeout(300);
  const botones = await page.$$eval('.mini-btn', els => els.map(e => ({
    txt: e.textContent.trim(), clases: e.className,
    bg: getComputedStyle(e).backgroundColor, icono: !!e.querySelector('svg')
  })));
  const share = botones.find(b => /Compartir/.test(b.txt));
  check('el botón Compartir está destacado (color de marca + ícono)',
        !!share && /primary/.test(share.clases) && share.icono && share.bg !== 'rgba(0, 0, 0, 0)',
        JSON.stringify(share));
  await page.screenshot({ path: DIR + '/ux-3-detalle-compartir.png' });

  console.log(fails.length ? `\n>>> ${fails.length} FALLO(S): ${fails.join(' | ')}` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
