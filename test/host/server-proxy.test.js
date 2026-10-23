// Tailnet HTTPS through `tailscale serve` (main/server.js + main/https.js): requests arrive from 127.0.0.1
// with X-Forwarded-* and Tailscale-* headers (the exact set measured from tailscale 1.102.3 on 2026-10-08).
// They must still need the cookie, never count as the desktop window, only be accepted under this PC's own
// MagicDNS name, be refused while phone access is off, and be logged under the phone's real address.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { startServer, requestInfo, hostAllowed } = require('../../main/server');

const TOKEN = 'p'.repeat(64);
const NAME = 'my-pc.example.ts.net';
const EMAIL = 'someone@example.com';
let dir, srv, port, phoneOn = true;
const logs = [];
const opened = [];

// what tailscale serve adds (Host is kept as the phone sent it; X-Forwarded-For is the phone's tailnet IP)
const proxyHeaders = (extra = {}) => ({
  host: NAME, 'x-forwarded-for': '100.88.12.4', 'x-forwarded-host': NAME, 'x-forwarded-proto': 'https',
  'tailscale-headers-info': 'https://tailscale.com/s/serve-headers', 'tailscale-user-login': EMAIL, 'tailscale-user-name': 'Someone', ...extra,
});

function get(p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}
function wsOpen(url, opts) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts);
    ws.once('open', () => resolve({ ws, open: true }));
    ws.once('unexpected-response', (_q, res) => resolve({ ws, open: false, status: res.statusCode }));
    ws.once('error', (e) => resolve({ ws, open: false, error: e.message }));
  });
}
const closeCode = (r) => new Promise((res) => (r.open ? r.ws.once('close', (c) => res(c)) : res(r.status || r.error)));
function hello(ws) {
  return new Promise((resolve) => {
    ws.once('message', (m) => resolve(JSON.parse(String(m))));
    ws.send(JSON.stringify({ id: 1, type: 'rpc', method: 'who', params: {} }));
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-proxy-'));
  fs.mkdirSync(path.join(dir, 'ui'));
  fs.writeFileSync(path.join(dir, 'ui', 'index.html'), '<!doctype html><title>Helm</title>');
  fs.writeFileSync(path.join(dir, 'ui', 'app.js'), 'export {}');
  fs.writeFileSync(path.join(dir, 'ui', 'sw.js'), 'self.addEventListener("fetch", () => {})');
  fs.writeFileSync(path.join(dir, 'ui', 'manifest.webmanifest'), '{}');
  srv = await startServer({
    uiDir: path.join(dir, 'ui'), token: TOKEN, port: 0,
    extraHosts: () => [NAME], allowProxied: () => phoneOn,
    onRpc: async (c) => ({ platform: c.platform, remote: c.remote, proxied: c.proxied, secure: c.secure }),
    onClient: (c, s) => { if (s === 'open') opened.push(c); },
    log: (...a) => logs.push(a.join(' ')),
  });
  port = srv.port;
});
after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('requestInfo: forwarding headers count only from a loopback socket', () => {
  const r = (remoteAddress, headers) => requestInfo({ socket: { remoteAddress }, headers });
  const viaProxy = r('127.0.0.1', proxyHeaders());
  assert.equal(viaProxy.proxied, true);
  assert.equal(viaProxy.remote, '100.88.12.4');
  assert.equal(viaProxy.secure, true);
  assert.equal(viaProxy.localWindow, false);
  // a direct tailnet client sending its own X-Forwarded-For is NOT trusted
  const spoof = r('100.88.12.4', { host: `100.64.0.1:4871`, 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' });
  assert.equal(spoof.proxied, false);
  assert.equal(spoof.remote, '100.88.12.4');
  assert.equal(spoof.secure, false);
  // the desktop window: loopback socket, loopback Host, no forwarding headers
  assert.equal(r('127.0.0.1', { host: '127.0.0.1:4871' }).localWindow, true);
  assert.equal(r('::ffff:127.0.0.1', { host: 'localhost:4871' }).localWindow, true);
  assert.equal(r('127.0.0.1', { host: `${NAME}:4871` }).localWindow, false);
  // X-Forwarded-For: the last (proxy-added) entry; junk is not echoed
  assert.equal(r('127.0.0.1', proxyHeaders({ 'x-forwarded-for': '6.6.6.6, 100.88.12.4' })).remote, '100.88.12.4');
  assert.equal(r('127.0.0.1', proxyHeaders({ 'x-forwarded-for': '<script>' })).remote, 'unknown (proxied)');
});

test('hostAllowed: a proxied request must name this PC\'s own MagicDNS host', () => {
  assert.equal(hostAllowed(NAME, [NAME], { proxied: true }), true);
  assert.equal(hostAllowed(`${NAME}:8443`, [NAME], { proxied: true }), true);
  assert.equal(hostAllowed('other-pc.example.ts.net', [NAME], { proxied: true }), false);
  assert.equal(hostAllowed('100.64.0.1', [NAME], { proxied: true }), false);
  assert.equal(hostAllowed('127.0.0.1:4871', [NAME], { proxied: true }), false);
  assert.equal(hostAllowed('my-pc', [NAME], { proxied: true }), false);
  assert.equal(hostAllowed(undefined, [NAME], { proxied: true }), false);
  // direct requests: own name yes, a foreign *.ts.net no once the own name is known; any *.ts.net before
  assert.equal(hostAllowed(`${NAME}:4871`, [NAME]), true);
  assert.equal(hostAllowed('attacker.tail9999.ts.net:4871', [NAME]), false);
  assert.equal(hostAllowed('attacker.tail9999.ts.net:4871', []), true);
  assert.equal(hostAllowed('100.64.0.1:4871', [NAME]), true);
});

test('a proxied request still needs the cookie or key', async () => {
  assert.equal((await get('/', proxyHeaders())).status, 401);
  assert.equal((await get('/app.js', proxyHeaders())).status, 401);
  assert.equal((await get('/app.js', proxyHeaders({ cookie: 'helm_key=' + 'q'.repeat(64) }))).status, 401);
  const ok = await get('/app.js', proxyHeaders({ cookie: 'helm_key=' + TOKEN }));
  assert.equal(ok.status, 200);
  // the pairing link over https sets a Secure cookie
  const pair = await get('/?key=' + TOKEN, proxyHeaders());
  assert.equal(pair.status, 200);
  assert.match(String(pair.headers['set-cookie']), /HttpOnly; SameSite=Lax; .*; Secure$/);
  // plain loopback (the desktop window) gets no Secure flag: it is http
  const local = await get('/?token=' + TOKEN);
  assert.doesNotMatch(String(local.headers['set-cookie']), /Secure/);
  // the manifest and service worker are public (install + SW update checks fetch them without cookies)
  assert.equal((await get('/sw.js', proxyHeaders())).status, 200);
  assert.equal((await get('/manifest.webmanifest', proxyHeaders())).status, 200);
});

test('the refused log names the phone, not the proxy, and never the Tailscale identity headers', async () => {
  logs.length = 0;
  await get('/app.js', proxyHeaders());
  const line = logs.find((l) => l.startsWith('refused /app.js'));
  assert.ok(line, logs.join('\n'));
  assert.match(line, /from 100\.88\.12\.4 via tailscale serve: no cookie/);
  assert.ok(!logs.some((l) => l.includes(EMAIL) || l.includes(TOKEN)), 'no email or token in the log');
});

test('a proxied host other than this PC\'s name is refused; so is everything proxied while phone access is off', async () => {
  const cookie = 'helm_key=' + TOKEN;
  assert.equal((await get('/app.js', proxyHeaders({ host: 'evil.example', cookie }))).status, 403);
  assert.equal((await get('/app.js', proxyHeaders({ host: '100.64.0.1', cookie }))).status, 403);
  phoneOn = false;
  try {
    assert.equal((await get('/app.js', proxyHeaders({ cookie }))).status, 403);
    assert.equal((await get('/?key=' + TOKEN, proxyHeaders())).status, 403);
    const ws = await wsOpen(`ws://127.0.0.1:${port}/ws`, { headers: proxyHeaders({ cookie }), origin: `https://${NAME}` });
    assert.equal(await closeCode(ws), 403);
    // the desktop window is not affected
    assert.equal((await get('/app.js', { cookie })).status, 200);
  } finally { phoneOn = true; }
});

test('a proxied WebSocket needs the cookie, takes the https Origin, and is never the desktop window', async () => {
  const cookie = 'helm_key=' + TOKEN;
  // no cookie -> 4401
  const none = await wsOpen(`ws://127.0.0.1:${port}/ws`, { headers: proxyHeaders(), origin: `https://${NAME}` });
  assert.equal(await closeCode(none), 4401);
  // even the token in the URL plus an Electron user agent: it came through the proxy, so 'web'
  opened.length = 0;
  const spoof = await wsOpen(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { headers: proxyHeaders({ 'user-agent': 'Mozilla/5.0 Electron/44.4.3' }), origin: `https://${NAME}` });
  assert.equal(spoof.open, true);
  const who = await hello(spoof.ws);
  assert.deepEqual(who.result, { platform: 'web', remote: '100.88.12.4', proxied: true, secure: true });
  spoof.ws.close();
  // the phone's normal shape: cookie, https origin
  const phone = await wsOpen(`ws://127.0.0.1:${port}/ws`, { headers: proxyHeaders({ cookie }), origin: `https://${NAME}` });
  assert.equal(phone.open, true);
  assert.equal((await hello(phone.ws)).result.platform, 'web');
  phone.ws.close();
  // another origin through the proxy -> 403
  const evil = await wsOpen(`ws://127.0.0.1:${port}/ws`, { headers: proxyHeaders({ cookie }), origin: 'https://evil.example' });
  assert.equal(await closeCode(evil), 403);
  // an https Origin WITHOUT the proxy (no X-Forwarded-Proto https) -> 403
  const direct = await wsOpen(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { headers: { host: `${NAME}:${port}` }, origin: `https://${NAME}:${port}` });
  assert.equal(await closeCode(direct), 403);
  // and the real desktop window (loopback, token, Electron, loopback Host) is still 'electron'
  const win = await wsOpen(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { headers: { 'user-agent': 'Mozilla/5.0 Electron/44.4.3' }, origin: `http://127.0.0.1:${port}` });
  assert.equal(win.open, true);
  assert.equal((await hello(win.ws)).result.platform, 'electron');
  win.ws.close();
});
