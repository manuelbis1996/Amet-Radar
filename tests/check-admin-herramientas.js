// Herramientas de moderación del panel admin: filtros de la tabla, «Ver en
// mapa», copiar link, exportar CSV, purgar vencidos, refresco a pedido y las
// estadísticas ampliadas.
//
// Qué protege:
//   * las estadísticas separan activos de vencidos (antes "Activos" contaba
//     todo lo que hubiera en la base, vencidos incluidos)
//   * los filtros achican la TABLA pero nunca el mapa (el mapa es el
//     inventario completo; el filtro es una herramienta de lectura)
//   * «Ver» centra el mapa en ese reporte y abre su ficha — el cruce
//     tabla→mapa que antes había que hacer a ojo con las coordenadas
//   * «Link» copia el mismo formato ?r=<id> que comparte la app
//   * el CSV exporta lo que la tabla muestra (filtros aplicados), con BOM
//   * purgar vencidos usa la MISMA rpc pública purge_expired_reports que la
//     app — sin endpoint privilegiado nuevo
//   * el aviso de "manda push a menos de X" refleja el radio configurado, no
//     el "2 km" que estaba hardcodeado
//
// OJO: como el resto de las suites, esto mockea la red. Que la RPC de purga
// borre solo lo vencido lo garantiza la base (ver check-base-real.js).

const { lanzar, BASE } = require('./_setup');
const fs = require('fs');
const STUB = fs.readFileSync(__dirname + '/maplibre-stub.js', 'utf8');

const fails = [];
const check = (n, c, extra='') => {
  console.log((c ? '  OK  ' : ' FALLA') + ' | ' + n + (extra ? '  -> ' + extra : ''));
  if(!c) fails.push(n);
};

const CONFIG = [{ stale_minutes:45, max_age_minutes:120, deny_threshold:3,
                  report_limit:5, report_window_min:60, push_radius_meters:2500 }];

const ahora = Date.now();
const FOTO_URL = 'https://nikexwjxxcxzhsuypsjn.supabase.co/storage/v1/object/public/report-photos/r-foto.jpg';
// Tres reportes: uno fresco sin foto, uno fresco con foto (y nota con tilde,
// para el CSV) y uno vencido (300 min > los 120 de max_age_minutes).
const REPORTES = [
  { id:'r-fresco', lat:19.2230, lng:-70.5300, photo:null, note:'', ts: ahora-5*60000,
    category:'reten_fijo', confirms:1, denies:0, approx:false, photo_flags:0 },
  { id:'r-foto', lat:19.2400, lng:-70.5100, photo:FOTO_URL, note:'nota con tilde á',
    ts: ahora-9*60000, category:'accidente', confirms:0, denies:0, approx:true, photo_flags:0 },
  { id:'r-viejo', lat:19.2500, lng:-70.5200, photo:null, note:'', ts: ahora-300*60000,
    category:'control', confirms:2, denies:1, approx:false, photo_flags:0 },
];

async function abrirPanel(browser) {
  const ctx = await browser.newContext({
    viewport:{ width:1100, height:900 },
    acceptDownloads: true, // para poder leer el CSV exportado
  });
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', e => errores.push(String(e)));

  // Portapapeles capturado: el de verdad necesita permisos que headless no da.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: t => { window.__copiado = t; return Promise.resolve(); } }
    });
  });

  await page.route('**/maplibre-gl.js', r => r.fulfill({ contentType:'application/javascript', body: STUB }));
  await page.route('**/maplibre-gl.css', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.route('**/tiles.openfreemap.org/**', r => r.abort());
  await page.route('**/storage/v1/object/public/**', r =>
    r.fulfill({ contentType:'image/jpeg', body:'' }));
  await page.route('**/rest/v1/app_config*', r =>
    r.fulfill({ contentType:'application/json', body: JSON.stringify(CONFIG) }));

  let fetchesReportes = 0;
  await page.route('**/rest/v1/reports*', r => {
    fetchesReportes++;
    return r.fulfill({ contentType:'application/json', body: JSON.stringify(REPORTES) });
  });
  await page.route('**/functions/v1/admin-login', r =>
    r.fulfill({ status:200, contentType:'application/json', body:'{"ok":true}' }));

  const purgas = [];
  await page.route('**/rest/v1/rpc/purge_expired_reports', r => {
    purgas.push(true);
    return r.fulfill({ status:200, contentType:'application/json', body:'null' });
  });

  await page.goto(BASE + '/admin.html', { waitUntil:'domcontentloaded' });
  await page.fill('#password-input', 'loquesea');
  await page.click('#login-btn');
  await page.waitForSelector('#dashboard:not([hidden])', { timeout:8000 });
  await page.waitForTimeout(400);
  return { ctx, page, errores, purgas, contarFetches: () => fetchesReportes };
}

(async () => {
  const browser = await lanzar();
  const { ctx, page, errores, purgas, contarFetches } = await abrirPanel(browser);

  // ---- 1. Estadísticas: activos y vencidos por separado ----
  {
    const tiles = await page.$$eval('#stat-grid .stat-tile', els =>
      els.map(e => ({ n: e.querySelector('b').textContent, l: e.querySelector('span').textContent })));
    const porLabel = Object.fromEntries(tiles.map(t => [t.l, t.n]));
    check('la estadística separa activos de vencidos',
      porLabel['Activos'] === '2' && porLabel['Vencidos'] === '1',
      JSON.stringify(porLabel));
    check('y cuenta total, última hora y con foto',
      porLabel['Total en la base'] === '3' && porLabel['Última hora'] === '2' &&
      porLabel['Con foto'] === '1', JSON.stringify(porLabel));
  }

  // ---- 2. La tabla marca los vencidos y muestra la ubicación ----
  {
    check('el reporte vencido lleva su marca en la tabla',
      (await page.$$eval('.exp-tag', e => e.length)) === 1);
    const coords = await page.$eval('tr[data-id="r-fresco"] td.num', el => el.textContent);
    check('cada fila muestra sus coordenadas',
      /19\.22300, -70\.53000/.test(coords), coords);
    check('la miniatura de la foto abre la imagen completa',
      (await page.$$eval('a.thumb-link', e => e.length)) === 1);
  }

  // ---- 3. El aviso de push refleja el radio configurado ----
  {
    const nota = await page.$eval('#push-radius-note', el => el.textContent);
    check('el aviso de push muestra el radio real (no el "2 km" fijo)',
      nota === '2.5 km', nota);
  }

  // ---- 4. Filtros: achican la tabla pero NUNCA el mapa ----
  {
    await page.selectOption('#filter-cat', 'accidente');
    await page.waitForTimeout(150);
    check('filtrar por categoría deja solo esa fila',
      (await page.$$eval('#reports-tbody tr[data-id]', e => e.length)) === 1 &&
      !!(await page.$('#reports-tbody tr[data-id="r-foto"]')));
    check('el filtro no toca el mapa (sigue el inventario completo)',
      (await page.$$eval('.rep-dot', e => e.length)) === 3,
      'marcadores=' + (await page.$$eval('.rep-dot', e => e.length)));

    await page.selectOption('#filter-cat', '');
    await page.selectOption('#filter-estado', 'vencidos');
    await page.waitForTimeout(150);
    check('el filtro de vencidos deja solo el vencido',
      (await page.$$eval('#reports-tbody tr[data-id]', e => e.length)) === 1 &&
      !!(await page.$('#reports-tbody tr[data-id="r-viejo"]')));

    await page.selectOption('#filter-estado', 'con_foto');
    await page.waitForTimeout(150);
    check('el filtro de "con foto" deja solo el que tiene foto',
      (await page.$$eval('#reports-tbody tr[data-id]', e => e.length)) === 1 &&
      !!(await page.$('#reports-tbody tr[data-id="r-foto"]')));

    // Un filtro sin resultados lo dice, no deja la tabla muda.
    await page.selectOption('#filter-cat', 'reten_movil');
    await page.waitForTimeout(150);
    const vacio = await page.$eval('#reports-tbody', el => el.textContent);
    check('un filtro sin resultados lo explica',
      /coincide con el filtro/.test(vacio), vacio.trim());

    await page.selectOption('#filter-cat', '');
    await page.selectOption('#filter-estado', 'todos');
    await page.waitForTimeout(150);
  }

  // ---- 5. «Ver» centra el mapa y abre la ficha de ese reporte ----
  {
    await page.click('tr[data-id="r-fresco"] .row-ver');
    await page.waitForTimeout(250);
    check('«Ver» abre la ficha del reporte en el mapa',
      !(await page.$eval('#rep-popover', el => el.hidden)) &&
      /Retén fijo/.test(await page.$eval('#rp-cat', el => el.textContent)));
    const centrado = await page.evaluate(() => {
      const c = window.__map._calls.filter(x => x[0] === 'easeTo').pop();
      return c && c[1] && c[1].center;
    });
    check('y centra el mapa en sus coordenadas',
      centrado && Math.abs(centrado[1] - 19.2230) < 0.0001 &&
      Math.abs(centrado[0] + 70.5300) < 0.0001, JSON.stringify(centrado));
    await page.click('#rp-close');
  }

  // ---- 6. «Link» copia el mismo formato ?r=<id> que comparte la app ----
  {
    await page.click('tr[data-id="r-fresco"] .row-link');
    await page.waitForTimeout(150);
    const copiado = await page.evaluate(() => window.__copiado);
    check('«Link» copia el enlace compartible del reporte',
      copiado === `${BASE}/?r=r-fresco`, String(copiado));
  }

  // ---- 7. El CSV exporta lo que la tabla muestra ----
  {
    const [descarga] = await Promise.all([
      page.waitForEvent('download', { timeout: 8000 }),
      page.click('#export-csv'),
    ]);
    const ruta = await descarga.path();
    const csv = fs.readFileSync(ruta, 'utf8');
    const lineas = csv.trim().split('\n');
    check('el CSV trae cabecera + una línea por reporte',
      lineas.length === 4, 'lineas=' + lineas.length);
    check('el CSV arranca con BOM (si no, Excel rompe las tildes)',
      csv.charCodeAt(0) === 0xFEFF);
    check('la cabecera tiene las columnas esperadas',
      /^id,categoria,lat,lng,fecha/.test(lineas[0].replace(/^﻿/, '')), lineas[0]);
    check('los campos con coma o tilde viajan bien',
      /"nota con tilde á"|nota con tilde á/.test(csv));
    check('el vencido va marcado en el CSV', /r-viejo.*,si,/.test(csv));
  }

  // ---- 8. Purgar vencidos: confirma, llama a la RPC pública y refresca ----
  {
    page.on('dialog', d => d.accept());
    const antes = contarFetches();
    await page.click('#purge-btn');
    await page.waitForTimeout(600);
    check('purgar pasa por rpc/purge_expired_reports (la misma de la app)',
      purgas.length === 1, 'llamadas=' + purgas.length);
    check('y refresca la tabla después', contarFetches() > antes);
  }

  // ---- 9. Actualizar a pedido, con marca de hora ----
  {
    const antes = contarFetches();
    await page.click('#refresh-btn');
    await page.waitForTimeout(400);
    check('el botón Actualizar vuelve a pedir los reportes', contarFetches() > antes);
    const marca = await page.$eval('#last-update', el => el.textContent);
    check('y deja la hora de la última actualización', /Actualizado/.test(marca), marca);
  }

  check('sin errores de JS en toda la pasada', errores.length === 0, JSON.stringify(errores));

  await ctx.close();
  await browser.close();
  console.log('');
  console.log(fails.length ? `>>> ${fails.length} FALLO(S): ${fails.join(' | ')}` : '>>> TODOS LOS CHEQUEOS PASARON');
  process.exit(fails.length ? 1 : 0);
})();
