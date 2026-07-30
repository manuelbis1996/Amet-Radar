// Servidor local de AMET Radar: solo sirve los archivos estáticos, para
// poder abrir la app por http:// en vez de file:// (geolocalización,
// service worker y el fetch a Supabase no funcionan sobre file://). Los
// reportes ya no se guardan acá: viven en Supabase (ver amet-radar.html),
// así que este servidor no persiste nada.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8'
};

function serveStatic(req, res, pathname){
  const safePath = path.normalize(pathname === '/' ? '/amet-radar.html' : pathname);
  const filePath = path.join(ROOT, safePath);
  if(!filePath.startsWith(ROOT)){ res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, content) => {
    if(err){ res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('No encontrado'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AMET Radar escuchando en http://0.0.0.0:${PORT}`);
});
