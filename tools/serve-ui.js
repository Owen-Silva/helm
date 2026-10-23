// Static dev server for ui/ on 127.0.0.1 — lets UI lanes work without Electron or the engine.
// Open http://127.0.0.1:<port>/?mock=1 to run the renderer against ui/lib/mock-data.js.
// Live reload: the page (ui/lib/live.js, mock mode only) listens on /__live and reloads
// when any file under ui/ changes, so the user can watch the build happen.
// /bg/<file> serves ui/assets/backgrounds/<file> (the real server serves <userData>/backgrounds).
// Usage: node tools/serve-ui.js [port]   (default 4870; 0 = random, printed on start)
const http = require('http');
const fs = require('fs');
const path = require('path');

// HELM_UI_DIR serves another copy of ui/ (tools/overlap-audit.js --ui: the before pass on an archived master)
const UI = process.env.HELM_UI_DIR ? path.resolve(process.env.HELM_UI_DIR) : path.join(__dirname, '..', 'ui');
const BG = path.join(UI, 'assets', 'backgrounds');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

const clients = new Set();
let timer = null;
fs.watch(UI, { recursive: true }, (_e, name) => {
  if (!name || name.includes('backgrounds')) return;
  clearTimeout(timer);
  timer = setTimeout(() => { for (const res of clients) res.write(`data: ${JSON.stringify({ file: name })}\n\n`); }, 300);
});

const port = Number(process.argv[2] ?? 4870);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__live') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': hi\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const base = url.pathname.startsWith('/bg/') ? BG : UI;
  const rel = url.pathname.startsWith('/bg/') ? url.pathname.slice(3) : url.pathname;
  let file = path.normalize(path.join(base, decodeURIComponent(rel)));
  if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
});
server.listen(port, '127.0.0.1', () => console.log(`ui on http://127.0.0.1:${server.address().port}/?mock=1`));
