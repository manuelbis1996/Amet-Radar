#!/usr/bin/env node
// Corre todas las suites: levanta server.js en un puerto de pruebas, ejecuta
// cada check-*.js en serie y devuelve código distinto de cero si alguna falla.
//
//   node tests/run.js                 (todas)
//   node tests/run.js seguridad area  (solo las que coincidan)
//
// En serie a propósito: cada suite abre su propio Chromium y en paralelo se
// pisan por memoria en máquinas chicas.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const DIR = __dirname;
const RAIZ = path.join(DIR, '..');
const PORT = process.env.TEST_PORT || 8171;

const filtros = process.argv.slice(2);
// Convención: `check-*-real.js` pega contra la base REAL de Supabase y queda
// FUERA de esta corrida. No es capricho — el CI manda el dominio de Supabase a
// 127.0.0.1 justamente para que ninguna suite toque producción por accidente,
// así que acá fallaría siempre; y el check que protege `main` no puede
// depender de que un servicio externo esté arriba. Se corren a mano o por el
// workflow `base-real.yml`:
//
//   node tests/check-base-real.js [--solo-lectura]
const suites = fs.readdirSync(DIR)
  .filter(f => f.startsWith('check-') && f.endsWith('.js'))
  .filter(f => !f.endsWith('-real.js'))
  .filter(f => filtros.length === 0 || filtros.some(x => f.includes(x)))
  .sort();

if (suites.length === 0) {
  console.error('Ninguna suite coincide con:', filtros.join(' '));
  process.exit(1);
}

function esperarServidor(intentos = 40) {
  return new Promise((resolve, reject) => {
    const probar = (n) => {
      http.get(`http://localhost:${PORT}/amet-radar.html`, res => {
        res.resume();
        res.statusCode === 200 ? resolve() : reintentar(n);
      }).on('error', () => reintentar(n));
    };
    const reintentar = (n) => {
      if (n <= 0) return reject(new Error('el servidor de pruebas no respondió'));
      setTimeout(() => probar(n - 1), 250);
    };
    probar(intentos);
  });
}

(async () => {
  const server = spawn('node', [path.join(RAIZ, 'server.js')], {
    env: { ...process.env, PORT },
    stdio: 'ignore',
    detached: false,
  });
  const cerrarServidor = () => { try { server.kill(); } catch (e) {} };
  process.on('exit', cerrarServidor);
  process.on('SIGINT', () => { cerrarServidor(); process.exit(130); });

  try {
    await esperarServidor();
  } catch (e) {
    console.error(e.message);
    cerrarServidor();
    process.exit(1);
  }

  const fallaron = [];
  for (const s of suites) {
    process.stdout.write(s.padEnd(24));
    const r = spawnSync('node', [path.join(DIR, s)], { encoding: 'utf8' });
    const salida = (r.stdout || '') + (r.stderr || '');
    const ultima = salida.trim().split('\n').pop() || '(sin salida)';
    console.log(ultima);
    if (r.status !== 0) {
      fallaron.push(s);
      // El detalle solo cuando hace falta, para que la corrida completa se
      // lea de un vistazo.
      console.log(salida.split('\n').filter(l => l.includes('FALLA') || l.includes('Error')).join('\n'));
    }
  }

  cerrarServidor();
  console.log('');
  if (fallaron.length) {
    console.log(`>>> ${fallaron.length} SUITE(S) CON FALLOS: ${fallaron.join(', ')}`);
    process.exit(1);
  }
  console.log(`>>> LAS ${suites.length} SUITES PASARON`);
})();
