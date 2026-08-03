// Corre todas las suites de tests/ y devuelve un solo veredicto.
//
//     node tests/run.js              todas
//     node tests/run.js antispam     solo las que matcheen ese texto
//
// Descubre solo: toma todos los `tests/check-*.js`, en orden alfabético. Para
// sumar una suite nueva alcanza con crear el archivo con ese nombre — no hay
// que registrarla en ningún lado.
//
// Contrato que tiene que cumplir cada suite:
//   * es un script de Node que se corre solo (`node tests/check-loquesea.js`)
//   * sale con código 0 si todo pasó y != 0 si algo falló
//   * levanta y baja su propio server.js; usa el puerto de AMET_TEST_PORT
//     (este runner le da uno distinto a cada una) y no lo hardcodea
//
// El runner resuelve NODE_PATH solo: playwright está instalado global en este
// entorno y el proyecto no tiene package.json a propósito (sin dependencias),
// así que sin eso las suites no encontrarían el módulo.

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const filtro = process.argv[2];

// --- NODE_PATH -------------------------------------------------------------
// Si playwright ya resuelve, no se toca nada. Si no, se busca el root global
// de npm una sola vez y se se lo pasa a las suites por entorno.
function resolverNodePath() {
  try {
    require.resolve('playwright');
    return process.env.NODE_PATH || '';
  } catch (e) {
    try {
      const raiz = execSync('npm root -g', { encoding: 'utf8' }).trim();
      return process.env.NODE_PATH ? `${process.env.NODE_PATH}:${raiz}` : raiz;
    } catch (e2) {
      console.error('No se pudo ubicar playwright. Instalalo con: npm i -g playwright');
      process.exit(1);
    }
  }
}

const NODE_PATH = resolverNodePath();

const suites = fs.readdirSync(DIR)
  .filter((f) => /^check-.*\.js$/.test(f))
  .filter((f) => !filtro || f.includes(filtro))
  .sort();

if (suites.length === 0) {
  console.error(filtro ? `Ninguna suite matchea "${filtro}".` : 'No hay suites en tests/.');
  process.exit(1);
}

console.log(`Corriendo ${suites.length} suite(s)\n`);

const resultados = [];
// Secuencial y no en paralelo: cada suite levanta un Chromium y un server.js,
// y en paralelo se pisan los tiempos de espera y se vuelve difícil leer qué
// falló. El puerto propio por suite está igual, para no depender del orden.
suites.forEach((archivo, i) => {
  console.log(`── ${archivo} ${'─'.repeat(Math.max(0, 56 - archivo.length))}`);
  const t0 = Date.now();
  const r = spawnSync('node', [path.join(DIR, archivo)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_PATH, AMET_TEST_PORT: String(8123 + i) }
  });
  const segundos = ((Date.now() - t0) / 1000).toFixed(1);
  resultados.push({ archivo, ok: r.status === 0, segundos });
  console.log('');
});

// --- Resumen ---------------------------------------------------------------
const enRojo = resultados.filter((r) => !r.ok);
console.log('═'.repeat(60));
resultados.forEach((r) =>
  console.log(`${r.ok ? ' PASA ' : ' FALLA'}  ${r.archivo}  (${r.segundos}s)`));
console.log('═'.repeat(60));

if (enRojo.length === 0) {
  console.log(`${resultados.length}/${resultados.length} suites en verde.`);
} else {
  console.log(`${enRojo.length} de ${resultados.length} suite(s) en rojo: ${enRojo.map((r) => r.archivo).join(', ')}`);
}

// RECORDATORIO, y no es decorativo: estas suites mockean la red y NUNCA
// llegan a Postgres. Verde acá no dice nada sobre RLS, RPC ni triggers — ver
// tests/README.md, "Lo que estas suites NO pueden ver".
if (enRojo.length === 0) {
  console.log('\nOjo: esto solo cubre el cliente. Si tocaste RLS, una RPC o un');
  console.log('trigger, falta probarlo contra la base real con el rol anon.');
}

process.exit(enRojo.length === 0 ? 0 : 1);
