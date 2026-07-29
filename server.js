// Servidor local de AMET Radar: sirve los archivos estáticos y expone una
// API mínima (/api/reports) que guarda los reportes en data/reports.json.
// Al ser un único servidor compartido (en vez de localStorage por navegador),
// cualquier dispositivo que entre a esta misma URL ve los mismos reportes.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'reports.json');
const PORT = process.env.PORT || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8'
};

function ensureDataFile(){
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if(!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '{}');
}

function readReports(){
  ensureDataFile();
  try{ return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '{}'); }
  catch(e){ return {}; }
}

function writeReports(obj){
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj));
}

function sendJson(res, status, data){
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readBody(req){
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if(data.length > 8 * 1024 * 1024){ req.destroy(); reject(new Error('body demasiado grande')); }
    });
    req.on('end', () => {
      try{ resolve(data ? JSON.parse(data) : {}); }
      catch(e){ reject(e); }
    });
    req.on('error', reject);
  });
}

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if(req.method === 'OPTIONS' && pathname.startsWith('/api/')){
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if(pathname === '/api/reports' && req.method === 'GET'){
    return sendJson(res, 200, readReports());
  }

  if(pathname === '/api/reports' && req.method === 'POST'){
    try{
      const body = await readBody(req);
      if(!body.id || !body.record) return sendJson(res, 400, { error: 'id y record requeridos' });
      const all = readReports();
      all[body.id] = body.record;
      writeReports(all);
      return sendJson(res, 201, { ok: true });
    }catch(e){ return sendJson(res, 400, { error: 'body inválido' }); }
  }

  const idMatch = pathname.match(/^\/api\/reports\/([^/]+)$/);

  if(idMatch && req.method === 'PATCH'){
    try{
      const body = await readBody(req);
      const all = readReports();
      const id = decodeURIComponent(idMatch[1]);
      if(!all[id]) return sendJson(res, 404, { error: 'no existe' });
      Object.assign(all[id], body);
      writeReports(all);
      return sendJson(res, 200, { ok: true });
    }catch(e){ return sendJson(res, 400, { error: 'body inválido' }); }
  }

  if(idMatch && req.method === 'DELETE'){
    const all = readReports();
    delete all[decodeURIComponent(idMatch[1])];
    writeReports(all);
    return sendJson(res, 200, { ok: true });
  }

  if(pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'ruta no encontrada' });

  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AMET Radar escuchando en http://0.0.0.0:${PORT} (reportes en ${DATA_FILE})`);
});
