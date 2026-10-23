// HTTP + WebSocket host for the UI (docs/PROTOCOL.md "Transport").
//  - serves ui/ statics and /bg/<file> (userData backgrounds first, then ui/assets/backgrounds)
//  - /ws speaks the JSON frame protocol; every frame goes to `onRpc(client, method, params)`
//  - EVERY request needs the token: `?token=` (the Electron window) or the HttpOnly
//    `helm_key` cookie that `GET /?key=<token>` sets (the phone). Loopback included,
//    because a WebSocket has no CORS: without the token any web page could drive Claude.
//  - a WS whose Origin is not this server's own host is refused (403) before the handshake
//  - binds 127.0.0.1 and, when given, the Tailscale IPv4. Never 0.0.0.0.
//  - tailnet HTTPS (main/https.js) is `tailscale serve` proxying to 127.0.0.1, so a phone can arrive
//    from loopback. A loopback request carrying X-Forwarded-* / Tailscale-* headers is a PROXIED
//    request: it still needs the cookie, is never the desktop window, must name this PC's own MagicDNS
//    host, is refused while phone access is off, and its real address (X-Forwarded-For, trusted only
//    from loopback) is what gets logged. The desktop window ('electron') additionally needs a loopback Host.
// Owner: lane host (B).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const COOKIE = 'helm_key';
// Served without the key: the install manifest and its icons. Browsers fetch a manifest without
// cookies (credentials "omit") and the launcher fetches icons on its own, so gating them would
// break "Add to Home screen". They hold nothing private; the Host guard still applies.
// The service worker script is public too: an expired cookie must not break its update check, and it
// holds no data (it only shows pushes and an offline page; ui/sw.js).
const PUBLIC_PATHS = new Set([
  '/manifest.webmanifest', '/sw.js',
  '/assets/app-icon-192.png', '/assets/app-icon-512.png', '/assets/app-icon-maskable-512.png',
  '/assets/apple-touch-icon.png',
]);
const COOKIE_MAX_AGE = 30 * 24 * 3600;
const MAX_PAYLOAD = 32 * 1024 * 1024; // backgrounds are ≤ 15 MB raw → ~20 MB as a data URL

// Compare as bytes: two strings of equal UTF-16 length can differ in UTF-8 byte length, and
// timingSafeEqual THROWS on unequal lengths (that turned `?key=é…` into a thrown handler).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// DNS-rebinding guard: a page on evil.com that re-resolves to 127.0.0.1 still sends
// `Host: evil.com`. Rebinding needs a DNS name the attacker controls, so allow only IP
// literals, localhost, single-label names (MagicDNS short name) and this PC's own MagicDNS
// name(s) (`extra`: the host passes them; while none is known yet, any *.ts.net, as before).
// A PROXIED request (tailscale serve) is only legitimate under this PC's own MagicDNS name,
// since that is the only name tailscale serve answers for. No Host header (non-browser client) is allowed.
function hostAllowed(hostHeader, extra = [], { proxied = false } = {}) {
  if (hostHeader === undefined) return !proxied;
  let name = String(hostHeader).trim().toLowerCase();
  if (name.startsWith('[')) return !proxied && /^\[[0-9a-f:.]+\](:\d+)?$/.test(name); // IPv6 literal
  name = name.replace(/:\d+$/, '').replace(/\.$/, '');
  if (!name || !/^[a-z0-9.-]+$/.test(name)) return false;
  const own = (extra || []).map((h) => String(h || '').toLowerCase().replace(/\.$/, '')).filter(Boolean);
  const ownTs = own.filter((h) => h.endsWith('.ts.net'));
  const isOwnTs = ownTs.length ? ownTs.includes(name) : name.endsWith('.ts.net');
  if (proxied) return isOwnTs || own.includes(name);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
  if (name === 'localhost' || !name.includes('.')) return true;
  if (name.endsWith('.ts.net')) return isOwnTs;
  return own.includes(name);
}

const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'tailscale-user-login', 'tailscale-headers-info'];
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const IP_TEXT = /^[0-9a-f:.]{2,45}$/i;

// Who a request really comes from. Forwarding headers are trusted ONLY from a loopback socket (that is
// tailscaled's proxy, or a local program that already has to present the token); from anywhere else they are
// ignored. X-Forwarded-For: the last entry is the one the nearest proxy added (tailscale serve replaces any
// client-sent value with the tailnet address; measured 2026-10-08).
//  -> { socketRemote, remote, proxied, secure, localWindow }
//  localWindow: loopback, not proxied, Host a loopback name: the only shape the desktop window has.
function requestInfo(req) {
  const socketRemote = (req.socket && req.socket.remoteAddress) || '';
  const h = req.headers || {};
  const loop = isLoopback(socketRemote);
  // tailscale serve always adds X-Forwarded-For/-Proto/-Host and Tailscale-Headers-Info (measured 2026-10-08)
  const proxied = loop && PROXY_HEADERS.some((k) => h[k] !== undefined);
  let remote = socketRemote;
  if (proxied) {
    const last = String(h['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean).pop();
    remote = last && IP_TEXT.test(last) ? last.replace(/^::ffff:/i, '') : 'unknown (proxied)';
  }
  const secure = proxied && String(h['x-forwarded-proto'] || '').trim().toLowerCase() === 'https';
  return { socketRemote, remote, proxied, secure, localWindow: loop && !proxied && h.host !== undefined && LOOPBACK_HOST.test(String(h.host).trim()) };
}

// Content-Security-Policy for an HTML page: scripts only from this server plus the exact inline
// scripts the page ships (the importmap), hashed, so an injected <script>/onerror=/javascript:
// in rendered markdown can't run (an XSS here drives Claude over the WebSocket).
function cspFor(html) {
  const hashes = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1]) || !m[2]) continue;
    hashes.push(`'sha256-${crypto.createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  }
  return [`script-src 'self'${hashes.length ? ' ' + hashes.join(' ') : ''}`, "object-src 'none'", "base-uri 'self'", "frame-ancestors 'self'"].join('; ');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); } }
  }
  return out;
}

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

// Resolve `rel` (URL path, already stripped of its mount prefix) inside `base`; null if it escapes.
function resolveInside(base, rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const file = path.resolve(base, '.' + path.posix.normalize('/' + decoded.replace(/\\/g, '/')));
  const root = path.resolve(base);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

/**
 * startServer({ uiDir, bgDirs, token, port, hosts, onRpc, onClient, log, bgDesktop })
 *   bgDirs: ordered list of directories /bg/<file> is looked up in
 *   bgDesktop: () => { file, type } | null: what /bg/desktop serves (main/look.js desktopFile; Look Sync)
 *   hosts:  extra IPv4 addresses to bind besides 127.0.0.1 (the Tailscale IP)
 *   onRpc(client, method, params) -> Promise<result>  (throw { message, code } for errors)
 *   onClient(client, 'open'|'close')
 *   extraHosts: () => this PC's own names (MagicDNS) for the Host guard
 *   allowProxied: () => false refuses every proxied (tailnet https) request: phone access is off
 *   client: { id, ws, auth, remote (real address), proxied, secure, platform: 'electron'|'web', alive }
 * Resolves { port, hosts, broadcast(event, data), send(client, event, data), clients, close() }.
 */
async function startServer(opts) {
  const { uiDir, bgDirs = [], token, onRpc, onClient = () => {}, log = () => {} } = opts;
  const extraHosts = () => { try { return (typeof opts.extraHosts === 'function' ? opts.extraHosts() : opts.extraHosts) || []; } catch { return []; } };
  if (!token || token.length < 32) throw new Error('server: token missing');
  const clients = new Set();

  function authOf(req, url) {
    const q = url.searchParams.get('token');
    if (q != null && safeEqual(q, token)) return 'token';
    const c = parseCookies(req.headers.cookie)[COOKIE];
    if (c && safeEqual(c, token)) return 'cookie';
    return null;
  }

  // Lax, not Strict: a scanned QR opens the pairing link from the camera app, a cross-site navigation,
  // and the browser then withholds a Strict cookie on the redirect to "/", so pairing looped back to
  // the "needs its pairing link" page (the user's phone, 2026-10-08). Lax is still never sent cross-site
  // on anything but a top-level GET, and the WebSocket checks Origin.
  // Over tailnet HTTPS (proxied, X-Forwarded-Proto https) the cookie is also Secure.
  function cookieHeader(secure = false) {
    return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}${secure ? '; Secure' : ''}`;
  }
  // Phone access off (settings.phone.enabled false) unbinds the Tailscale address; the https proxy
  // reaches loopback, so it is refused here too.
  const allowProxied = () => { try { return typeof opts.allowProxied === 'function' ? opts.allowProxied() !== false : true; } catch { return false; } };

  function serveFile(res, file, req, type = null) {
    fs.stat(file, (err, st) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
      if (st.isDirectory()) { serveFile(res, path.join(file, 'index.html'), req); return; }
      const headers = {
        'content-type': type || TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': st.size,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      };
      if (path.extname(file).toLowerCase() === '.html') {
        headers['x-frame-options'] = 'SAMEORIGIN';
        // HTML is small: read it whole so the CSP can hash its inline scripts.
        fs.readFile(file, (e2, buf) => {
          if (e2) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
          headers['content-length'] = buf.length;
          headers['content-security-policy'] = cspFor(buf.toString('utf8'));
          res.writeHead(200, headers);
          res.end(req.method === 'HEAD' ? undefined : buf);
        });
        return;
      }
      res.writeHead(200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  }

  function findBg(name) {
    for (const dir of bgDirs) {
      const f = resolveInside(dir, name);
      if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return f;
    }
    return null;
  }

  function handler(req, res) {
    let url;
    try { url = new URL(req.url, 'http://helm.local'); } catch { res.writeHead(400).end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }).end(); return; }
    const info = requestInfo(req);
    if (!hostAllowed(req.headers.host, extraHosts(), { proxied: info.proxied })) { refused(req, url, info, 'host not allowed'); res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden host'); return; }
    if (info.proxied && !allowProxied()) { refused(req, url, info, 'phone access is off'); res.writeHead(403, { 'content-type': 'text/plain' }).end('phone access is off in Helm'); return; }

    // Phone pairing link: /?key=<token> answers with the app page itself plus the cookie (no redirect);
    // the UI then drops `key` from the address bar (ui/lib/transport.js). It used to 302 to "/", and a
    // scanned QR (opened from the camera app) reached "/" without the cookie: "needs its pairing link".
    const key = url.searchParams.get('key');
    if (key != null && !safeEqual(key, token)) { refused(req, url, info, 'wrong pairing key'); unauthorized(res); return; }

    if (PUBLIC_PATHS.has(url.pathname)) { serveFile(res, path.join(uiDir, url.pathname.slice(1)), req); return; }

    const auth = key != null ? 'key' : authOf(req, url);
    if (!auth) { refused(req, url, info, req.headers.cookie ? (parseCookies(req.headers.cookie)[COOKIE] ? 'cookie with a stale key' : 'cookies but no helm_key') : 'no cookie'); unauthorized(res); return; }
    if (auth === 'key') { res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer'); }
    // The window loads /?token=…; give it the cookie too so its static requests authenticate.
    // A page load on the cookie (the phone, often launched from its home screen) slides the cookie's
    // 30 days forward, so an installed phone app only needs the pairing link again after a month unused.
    if (auth === 'token' || auth === 'key' || (url.pathname === '/' || url.pathname.endsWith('.html'))) res.setHeader('set-cookie', cookieHeader(info.secure));

    // Look Sync: the desktop wallpaper still. main/look.js picks and validates the file (only Mantle's
    // stills folder, the file Mantle's record names, or Windows' own wallpaper); ?v= is just a cache key.
    if (url.pathname === '/bg/desktop') {
      let d = null;
      try { d = typeof opts.bgDesktop === 'function' ? opts.bgDesktop() : null; } catch (e) { log('bg desktop', e); }
      if (!d || !d.file) { res.writeHead(404, { 'content-type': 'text/plain' }).end('no desktop wallpaper'); return; }
      serveFile(res, d.file, req, d.type || null);
      return;
    }
    if (url.pathname.startsWith('/bg/')) {
      const f = findBg(url.pathname.slice(4));
      if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
      serveFile(res, f, req);
      return;
    }
    if (url.pathname === '/__live') { res.writeHead(204).end(); return; } // dev-only endpoint in serve-ui
    const file = resolveInside(uiDir, url.pathname);
    if (!file) { res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden'); return; }
    serveFile(res, file, req);
  }

  // Why a page or file was refused, for the log (Settings → Phone problems): never the key or cookie value,
  // and never the Tailscale-User-* identity headers the https proxy adds (they carry the account email).
  let refusedLogged = 0;
  function refused(req, url, info, why) {
    if (refusedLogged++ > 200) return;
    const ua = String(req.headers['user-agent'] || '').slice(0, 120);
    log(`refused ${url.pathname} from ${info.remote}${info.proxied ? ' via tailscale serve' : ''}: ${why}; ${ua}`);
  }

  function unauthorized(res) {
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Helm</title>'
      + '<body style="font:15px system-ui;background:#1d1f22;color:#ddd;padding:24px">'
      + '<p>Helm needs its pairing link. Open Helm on the PC, go to Settings &rarr; Phone, and use that link (or scan its QR).</p>');
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

  function onUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://helm.local'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/ws') { reject(socket, 404, 'Not Found'); return; }
    const info = requestInfo(req);
    if (!hostAllowed(req.headers.host, extraHosts(), { proxied: info.proxied })) { refused(req, url, info, 'host not allowed'); reject(socket, 403, 'Forbidden'); return; }
    if (info.proxied && !allowProxied()) { refused(req, url, info, 'phone access is off'); reject(socket, 403, 'Forbidden'); return; }
    const origin = req.headers.origin;
    const host = req.headers.host;
    // Browsers always send Origin on a WebSocket. A page on another site would send its own,
    // so anything that isn't exactly this host is refused. (No Origin = a non-browser client,
    // which still needs the token below.) https://<host> only through the tailnet https proxy.
    if (origin !== undefined && origin !== `http://${host}` && !(info.secure && origin === `https://${host}`)) { refused(req, url, info, 'websocket from another origin'); reject(socket, 403, 'Forbidden'); return; }
    const auth = authOf(req, url);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!auth) { refused(req, url, info, 'websocket without the key'); ws.close(4401, 'unauthorized'); return; }
      const ua = String(req.headers['user-agent'] || '');
      const client = {
        id: crypto.randomBytes(6).toString('hex'),
        ws,
        auth,
        // the real address: the phone's tailnet IP for a proxied (https) client, else the socket's
        remote: info.remote,
        proxied: info.proxied,
        secure: info.secure,
        // The desktop window is the only client that loads with ?token= over loopback from Electron,
        // straight to 127.0.0.1 (never through the https proxy, whatever its user agent says).
        platform: auth === 'token' && info.localWindow && /Electron\//.test(ua) ? 'electron' : 'web',
        alive: true,
      };
      clients.add(client);
      ws.on('pong', () => { client.alive = true; });
      ws.on('message', (raw) => onMessage(client, raw));
      ws.on('close', () => { clients.delete(client); try { onClient(client, 'close'); } catch {} });
      ws.on('error', () => {});
      try { onClient(client, 'open'); } catch (e) { log('onClient failed', e); }
    });
  }

  function reject(socket, code, text) {
    try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
    socket.destroy();
  }

  function sendRaw(client, obj) {
    if (client.ws.readyState !== 1) return;
    try { client.ws.send(JSON.stringify(obj)); } catch (e) { log('send failed', e.message); }
  }

  async function onMessage(client, raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || msg.type !== 'rpc' || typeof msg.method !== 'string') return;
    const id = msg.id;
    try {
      const result = await onRpc(client, msg.method, msg.params && typeof msg.params === 'object' ? msg.params : {});
      sendRaw(client, { id, type: 'result', result: result === undefined ? {} : result });
    } catch (e) {
      const message = (e && e.message) || String(e);
      const code = (e && e.code) || 'error';
      if (code === 'internal' || !(e && e.code)) log(`rpc ${msg.method} failed:`, message);
      // lane steer: a plain-object `data` rides along (agents_running: { agents })
      const data = e && e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? e.data : null;
      sendRaw(client, { id, type: 'result', error: { message, code: String(code), ...(data ? { data } : {}) } });
    }
  }

  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { try { c.ws.terminate(); } catch {} continue; }
      c.alive = false;
      try { c.ws.ping(); } catch {}
    }
  }, 25_000);
  heartbeat.unref?.();

  // Bind 127.0.0.1 first (fixed port, else a free one), then the extra hosts on that same port.
  const servers = [];
  function listen(host, port) {
    return new Promise((resolve, rejectP) => {
      const s = http.createServer(handler);
      s.on('upgrade', onUpgrade);
      s.once('error', rejectP);
      s.listen(port, host, () => { s.removeListener('error', rejectP); s.on('error', (e) => log('server error', e.message)); resolve(s); });
    });
  }
  let primary;
  const wanted = opts.port ?? 4871;
  try { primary = await listen('127.0.0.1', wanted); }
  catch (e) {
    if (e.code !== 'EADDRINUSE' || wanted === 0) throw e;
    log(`port ${wanted} in use; falling back to a free port`);
    primary = await listen('127.0.0.1', 0);
  }
  servers.push(primary);
  const port = primary.address().port;
  const bound = ['127.0.0.1'];
  for (const h of opts.hosts || []) {
    if (!h || h === '0.0.0.0' || h === '::' || h === '127.0.0.1') continue;
    try { servers.push(await listen(h, port)); bound.push(h); }
    catch (e) { log(`could not bind ${h}:${port}: ${e.message}`); }
  }

  return {
    port,
    hosts: bound,
    portFellBack: port !== wanted && wanted !== 0,
    clients,
    // Bind one more address on the same port later (Tailscale can come up after Helm starts).
    async bindHost(h) {
      if (!h || h === '0.0.0.0' || h === '::' || bound.includes(h)) return false;
      try { servers.push(await listen(h, port)); bound.push(h); return true; }
      catch (e) { log(`could not bind ${h}:${port}: ${e.message}`); return false; }
    },
    async unbindHost(h) {
      const i = bound.indexOf(h);
      if (i <= 0) return false;
      const s = servers.find((x) => x.address() && x.address().address === h);
      bound.splice(i, 1);
      if (s) { servers.splice(servers.indexOf(s), 1); s.closeAllConnections?.(); await new Promise((r) => s.close(() => r())); }
      return true;
    },
    send(client, event, data) { sendRaw(client, { type: 'event', event, data }); },
    broadcast(event, data) {
      if (!clients.size) return;
      const frame = JSON.stringify({ type: 'event', event, data });
      for (const c of clients) if (c.ws.readyState === 1) { try { c.ws.send(frame); } catch {} }
    },
    async close() {
      clearInterval(heartbeat);
      for (const c of clients) { try { c.ws.terminate(); } catch {} }
      await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
    },
  };
}

module.exports = { startServer, parseCookies, resolveInside, safeEqual, hostAllowed, requestInfo, cspFor, COOKIE, PUBLIC_PATHS };
