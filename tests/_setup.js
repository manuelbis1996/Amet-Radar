// Enganche común de las suites de Playwright.
//
// Existe para que los tests no lleven rutas absolutas del sandbox donde se
// escribieron: antes vivían en un directorio temporal y se perdían con cada
// sesión. Todo lo que dependa del entorno se resuelve acá.

const path = require('path');

// Playwright no es dependencia del proyecto (que no tiene ninguna): puede
// estar instalado globalmente o al lado. Se prueban las dos formas antes de
// dar un mensaje útil.
function cargarPlaywright() {
  const intentos = [
    'playwright',
    '/opt/node22/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
  ];
  for (const ruta of intentos) {
    try { return require(ruta); } catch (e) { /* siguiente */ }
  }
  console.error(
    'No se encontró Playwright. Instalalo con:\n' +
    '  npm install -g playwright\n' +
    'Y asegurate de tener Chromium disponible (npx playwright install chromium).'
  );
  process.exit(1);
}

const { chromium } = cargarPlaywright();

// Puerto del servidor de pruebas. Se puede cambiar con TEST_PORT por si el
// 8171 está ocupado.
const PORT = process.env.TEST_PORT || 8171;
const BASE = `http://localhost:${PORT}`;

// Sin executablePath: con PLAYWRIGHT_BROWSERS_PATH bien puesto (o con la
// instalación por defecto) Playwright encuentra Chromium solo, y así el
// test no se ata a un número de build concreto. PW_CHROMIUM permite
// forzar un binario si hiciera falta.
async function lanzar() {
  const opts = {};
  if (process.env.PW_CHROMIUM) opts.executablePath = process.env.PW_CHROMIUM;
  return chromium.launch(opts);
}

// Contexto de teléfono, que es el público real de la app.
const MOVIL = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

// Rutas comunes a todas las suites: el CDN de MapLibre se reemplaza por el
// stub (este sandbox bloquea el CDN y los tiles), y las fuentes y tiles se
// cortan para que no cuelguen.
const fs = require('fs');
const STUB = fs.readFileSync(path.join(__dirname, 'maplibre-stub.js'), 'utf8');

async function rutasBase(page) {
  await page.route('**/maplibre-gl.js', r => r.fulfill({ contentType: 'application/javascript', body: STUB }));
  await page.route('**/maplibre-gl.css', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/tiles.openfreemap.org/**', r => r.abort());
}

// OJO: page.textContent() auto-espera hasta 30s si el selector no existe.
// Cuando hace falta distinguir "no está" al instante (por ejemplo un toast,
// que vive 2.6s), se consulta el DOM sin esperar.
const textoYa = (page, sel, def = '(no está)') => page.evaluate(([s, d]) => {
  const el = document.querySelector(s);
  return el ? el.textContent.trim() : d;
}, [sel, def]);

module.exports = { chromium, lanzar, PORT, BASE, MOVIL, STUB, rutasBase, textoYa, DIR: __dirname };
