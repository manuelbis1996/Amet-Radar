const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const DIR = __dirname;
const STUB = fs.readFileSync(DIR + '/maplibre-stub.js', 'utf8');

const GEO_STUB = `
// El flujo con foto ya no tiene entrada en la UI (v13.0); esta suite lo
// sigue cubriendo porque el código sigue ahí y está pensado para volver.
window.__ametFlujoConFoto = true;
window.__geoSuccess = null;
Object.defineProperty(navigator, 'geolocation', {
  value: {
    watchPosition: (success, error) => {
      window.__geoSuccess = success;
      setTimeout(() => success({ coords: { latitude: 18.4861, longitude: -69.9312 } }), 50);
      return 1;
    },
    clearWatch: () => {}
  },
  configurable: true
});
`;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const now = Date.now();
const REPORTS = [
  // pin normal, dentro del bbox
  { id: 'r-pin', lat: 18.49, lng: -69.93, photo: null, note: 'pin normal',
    ts: now - 60000, category: 'reten_fijo', confirms: 0, denies: 0, approx: false },
  // círculo de zona aproximada (reporte rápido), dentro del bbox
  { id: 'r-approx', lat: 18.47, lng: -69.94, photo: null, note: 'zona aprox',
    ts: now - 120000, category: 'accidente', confirms: 0, denies: 0, approx: true },
  // fuera del bbox visible -> no debe dibujarse
  { id: 'r-lejos', lat: 19.90, lng: -70.70, photo: null, note: 'lejos',
    ts: now - 60000, category: 'control', confirms: 0, denies: 0, approx: false },
];

(async () => {
  const browser = await lanzar();
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true, colorScheme:'light' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  await page.addInitScript(GEO_STUB);
  await page.route('**/maplibre-gl.js', r => r.fulfill({ contentType:'application/javascript', body: STUB }));
  await page.route('**/maplibre-gl.css', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/tiles.openfreemap.org/**', r => r.abort());
  await page.route('**/rest/v1/app_config*', r => r.fulfill({ contentType:'application/json', body:'[]' }));
  await page.route('**/rest/v1/reports*', r => r.fulfill({ contentType:'application/json', body: JSON.stringify(REPORTS) }));

  await page.goto(BASE + '/amet-radar.html', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(900);

  // Desde v10.4 la app muestra una hoja de bienvenida la primera vez; si no
  // se cierra, el overlay intercepta los clicks reales de esta suite.
  const welcome = await page.$('#welcome-ok');
  if(welcome){ await welcome.click(); await page.waitForTimeout(250); }

  const fail = [];
  const check = (name, cond, extra='') => {
    console.log((cond ? '  OK  ' : ' FALLA') + ' | ' + name + (extra ? '  -> ' + extra : ''));
    if(!cond) fail.push(name);
  };

  // 1) el mapa se creó con el estilo Bright y sin rotación
  const init = await page.evaluate(() => ({
    style: window.__map._opts.style,
    zoom: window.__map._opts.zoom,
    center: window.__map._opts.center,
    rotDisabled: !!window.__map._rotationDisabled,
    attribution: window.__map._opts.attributionControl,
    maxBounds: window.__map._opts.maxBounds,
    minZoom: window.__map._opts.minZoom
  }));

  // arranca en La Vega (el proyecto se lanza ahí), no en Santo Domingo
  const [lng, lat] = init.center;
  check('centro por defecto en La Vega (~19.22, -70.53)',
        Math.abs(lat - 19.2214) < 0.05 && Math.abs(lng + 70.5295) < 0.05,
        `lat=${lat} lng=${lng}`);

  // limitado a RD, con el minZoom que evita que el mapa se escape al centro
  check('maxBounds cubre RD', !!init.maxBounds &&
        init.maxBounds[0][0] < -71 && init.maxBounds[1][0] > -69 &&
        init.maxBounds[0][1] < 18 && init.maxBounds[1][1] > 19.5,
        JSON.stringify(init.maxBounds));
  check('minZoom >= 8 (si no, al alejar el mapa se clava en el centro del país)',
        init.minZoom >= 8, 'minZoom=' + init.minZoom);
  check('estilo Bright de OpenFreeMap', /openfreemap\.org\/styles\/bright$/.test(init.style), init.style);
  check('zoom inicial convertido de Leaflet 13 -> MapLibre 12', init.zoom === 12, 'zoom=' + init.zoom);
  check('centro en [lng, lat] (no [lat, lng])', init.center[0] < -60 && init.center[1] > 0 && init.center[1] < 30, JSON.stringify(init.center));
  check('rotación deshabilitada', init.rotDisabled === true);

  // atribución de OpenStreetMap (ODbL), compacta y abajo a la derecha
  const attrib = await page.evaluate(() => (window.__map._controls || []).map(c => ({
    tipo: c.ctrl && c.ctrl.constructor && c.ctrl.constructor.name,
    compact: c.ctrl && c.ctrl._opts && c.ctrl._opts.compact,
    pos: c.pos
  })));
  check('atribución de OpenStreetMap agregada, compacta',
        attrib.some(a => a.tipo === 'AttributionControl' && a.compact === true),
        JSON.stringify(attrib));

  // 2) marcadores: pin dibujado, círculo aprox dibujado, lejano NO dibujado
  const pins = await page.$$eval('.amet-pin', els => els.length);
  const approx = await page.$$eval('.amet-approx', els => els.map(e => ({ w: e.style.width, h: e.style.height })));
  const ids = await page.evaluate(() => Object.keys(window.__markersDebug || {}));
  check('1 pin dibujado (el lejano queda fuera del bbox)', pins === 1, 'pins=' + pins);
  check('1 círculo de zona aproximada dibujado', approx.length === 1, JSON.stringify(approx));
  check('el círculo tiene diámetro en píxeles calculado', approx[0] && parseFloat(approx[0].w) > 0, approx[0] && approx[0].w);

  // 3) el círculo se re-dimensiona al cambiar el zoom
  const before = parseFloat(approx[0].w);
  await page.evaluate(() => { window.__map._zoom = window.__map._zoom + 2; window.__map.fire('zoom'); });
  await page.waitForTimeout(80);
  const after = await page.$eval('.amet-approx', e => parseFloat(e.style.width));
  check('el círculo crece al acercar el zoom (radio en metros, no fijo)', after > before * 3, `${before}px -> ${after}px`);

  // 3.bis) el reporte de zona TIENE que seguir viéndose al alejar el mapa.
  // El círculo mide 150 m reales, así que su tamaño en pantalla se desploma:
  // a zoom 10 daba ~4px, o sea que los reportes de un toque —la mayoría—
  // desaparecían del mapa. Ahora hay un piso en píxeles y, sobre todo, un
  // núcleo de tamaño fijo con el emoji de la categoría.
  await page.evaluate(() => { window.__map._zoom = 9; window.__map.fire('zoom'); });
  await page.waitForTimeout(80);
  const alejado = await page.$eval('.amet-approx', e => parseFloat(e.style.width));
  // 44px es el mínimo táctil de la app (--tap): el círculo entero es el área
  // de click, así que por debajo de eso el reporte no solo se ve mal, no se
  // puede tocar. Se afirma contra esa invariante y no contra el valor exacto
  // de APPROX_MIN_PX, que es un número de diseño y puede moverse.
  check('alejando el mapa el círculo no se hace invisible ni intocable',
    alejado >= 44, alejado + 'px a zoom 9');
  const core = await page.$$eval('.approx-core', els => els.map(e => ({
    txt: e.textContent.trim(), w: getComputedStyle(e).width
  })));
  check('la zona lleva un núcleo con el emoji de la categoría',
    core.length === 1 && core[0].txt.length > 0, JSON.stringify(core));
  check('y ese núcleo es de tamaño fijo, no depende del zoom',
    core[0] && core[0].w === '34px', core[0] && core[0].w);

  // 4) el pin abre la hoja de detalle al tocarlo.
  // Se dispara el click directo sobre el elemento en vez de page.click():
  // el stub no posiciona los marcadores (MapLibre real usa transform), así
  // que quedan en 0,0 debajo del header y el hit-test de Playwright falla.
  // Eso es limitación del stub, no de la app.
  await page.$eval('.amet-pin', el => el.click());
  await page.waitForTimeout(250);
  const detailOpen = await page.$eval('#detail', el => !el.hidden);
  check('tocar el pin abre la hoja de detalle', detailOpen);
  await page.$eval('.detail-backdrop', el => el.click()).catch(()=>{});
  await page.waitForTimeout(200);

  // 5) marcador de "mi ubicación"
  const me = await page.$$eval('.me-marker', els => els.length);
  check('marcador de mi ubicación dibujado', me === 1, 'me=' + me);

  // 6) primer fix centra el mapa con jumpTo y zoom 14 (Leaflet 15)
  const calls = await page.evaluate(() => window.__map._calls.map(c => [c[0], JSON.stringify(c[1])]));
  const jump = calls.find(c => c[0] === 'jumpTo');
  check('primer fix usa jumpTo', !!jump, JSON.stringify(calls.map(c=>c[0])));
  check('primer fix con zoom 14 (Leaflet 15 - 1)', !!jump && /"zoom":14/.test(jump[1]), jump && jump[1]);

  // 7) modo seguir: easeTo + data-state, y panTo en el fix siguiente
  await page.click('#locate-btn');
  await page.waitForTimeout(150);
  const state = await page.$eval('#locate-btn', el => el.getAttribute('data-state'));
  check('el botón de ubicación queda en estado activo', state === 'active', 'data-state=' + state);

  await page.evaluate(() => window.__geoSuccess({ coords: { latitude: 18.50, longitude: -69.95 } }));
  await page.waitForTimeout(150);
  const calls2 = await page.evaluate(() => window.__map._calls.map(c => c[0]));
  check('con seguimiento activo, el fix nuevo usa panTo (no resetea el zoom)', calls2.includes('panTo'), calls2.join(','));

  // 8) arrastrar desactiva el seguimiento
  await page.evaluate(() => window.__map.fire('dragstart'));
  await page.waitForTimeout(120);
  const stateAfter = await page.$eval('#locate-btn', el => el.getAttribute('data-state'));
  check('arrastrar el mapa desactiva el seguimiento', stateAfter === null, 'data-state=' + stateAfter);

  // 9) flujo "marca el lugar": usa e.lngLat (MapLibre), no e.latlng (Leaflet)
  await page.click('#report-btn');
  await page.waitForTimeout(200);
  await page.click('#detailed-btn');
  await page.waitForTimeout(250);
  // Desde v11.2 primero va la foto y recién después se marca el lugar.
  await page.setInputFiles('#camera-input', { name:'foto.png', mimeType:'image/png', buffer: PNG });
  await page.waitForTimeout(1400)
  // Desde v11.3 con GPS se saltea el paso de marcar: se llega vía el
  // enlace "Ajustar ubicación" de la hoja de categoría.
  await page.click('#adjust-loc');
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__map.fire('click', { lngLat: { lat: 18.48, lng: -69.93 } }));
  await page.waitForTimeout(250);
  // Desde v10.9 tocar el mapa solo mueve el pin; hay que confirmar.
  await page.click('#pick-confirm');
  await page.waitForTimeout(300);
  const heading = await page.textContent('.sheet h2').catch(() => '(sin hoja)');
  const catOptions = await page.$$eval('.cat-option', els => els.length);
  const picked = await page.evaluate(() => window.__pendingLocationDebug || null);
  check('tras tocar el mapa avanza a elegir categoría (4 opciones)',
        catOptions === 4, `hoja: "${heading}" | opciones: ${catOptions}`);

  console.log('\nERRORES JS: ' + JSON.stringify(errors));
  console.log(fail.length ? `\n>>> ${fail.length} CHEQUEO(S) FALLIDO(S): ${fail.join(' | ')}` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  await browser.close();
  process.exit(fail.length || errors.length ? 1 : 0);
})();
