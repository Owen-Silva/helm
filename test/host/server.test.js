// Server auth + routing (no Electron): token/cookie auth on HTTP and WS, Origin check,
// path traversal, /bg/ lookup order, RPC error frames, broadcast.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');
const { startServer, resolveInside } = require('../../main/server');
const { createRouter } = require('../../main/rpc');

const TOKEN = 'a'.repeat(64);
let dir, srv, port, uiDir, bg1, bg2;

function get(p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}
// raw request so the path is sent exactly as written (no client-side normalisation)
function raw(p, headers = '') {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headers}Connection: close\r\n\r\n`));
    let buf = ''; s.on('data', (d) => { buf += d; }); s.on('end', () => resolve(Number(buf.split(' ')[1]))); s.on('error', () => resolve(0));
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
function call(ws, method, params = {}, id = Math.floor(Math.random() * 1e9)) {
  return new Promise((resolve) => {
    const on = (rawMsg) => { const m = JSON.parse(String(rawMsg)); if (m.id === id) { ws.off('message', on); resolve(m); } };
    ws.on('message', on);
    ws.send(JSON.stringify({ id, type: 'rpc', method, params }));
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-srv-'));
  uiDir = path.join(dir, 'ui'); bg1 = path.join(dir, 'bg-user'); bg2 = path.join(dir, 'bg-bundled');
  for (const d of [uiDir, bg1, bg2]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>Helm</title>');
  fs.writeFileSync(path.join(uiDir, 'app.js'), 'export {}');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'top secret');
  fs.writeFileSync(path.join(bg1, 'mine.png'), 'user');
  fs.writeFileSync(path.join(bg2, 'mine.png'), 'bundled');
  fs.writeFileSync(path.join(bg2, 'only-bundled.png'), 'bundled2');
  const engine = {
    methods: { 'usage.get': async () => ({ fiveHour: { percent: 1 } }), 'sessions.boom': async () => { throw new Error('kaboom'); } },
    snapshot: async () => ({ sessions: [{ id: 's1' }], usage: null }),
  };
  const router = createRouter({
    engine, version: 't',
    files: { pickFolder: async (_p, c) => { if (c.platform !== 'electron') throw Object.assign(new Error('no'), { code: 'unsupported' }); return { path: null }; } },
    queue: { list: () => [] },
    settings: { get: () => ({ theme: 'dark' }), set: () => { throw Object.assign(new Error('bad'), { code: 'bad_params' }); } },
    windowCtl: { minimize: () => {} },
  });
  srv = await startServer({ uiDir, bgDirs: [bg1, bg2], token: TOKEN, port: 0, onRpc: (c, m, p) => router.handle(c, m, p) });
  port = srv.port;
});
after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('HTTP needs the token or cookie', async () => {
  assert.equal((await get('/')).status, 401);
  assert.equal((await get('/app.js')).status, 401);
  assert.equal((await get('/?token=' + 'b'.repeat(64))).status, 401);
  assert.equal((await get('/?token=short')).status, 401);
  const ok = await get('/?token=' + TOKEN);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /<title>Helm/);
  assert.equal((await get('/app.js', { cookie: 'helm_key=' + TOKEN })).status, 200);
  assert.equal((await get('/app.js', { cookie: 'helm_key=' + 'c'.repeat(64) })).status, 401);
});

test('pairing link answers with the page itself (no redirect) and a Lax HttpOnly cookie', async () => {
  const r = await get('/?key=' + TOKEN);
  assert.equal(r.status, 200, 'no redirect: a scanned QR lost the cookie on the 302 to /');
  assert.equal(r.headers.location, undefined);
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.match(String(r.headers['cache-control']), /no-store/);
  const c = r.headers['set-cookie'].join(';');
  assert.match(c, /helm_key=a{64}/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Max-Age=2592000/);
  assert.equal((await get('/?key=nope')).status, 401);
});

test('path traversal cannot leave ui/ or the background dirs', async () => {
  const cookie = `Cookie: helm_key=${TOKEN}\r\n`;
  for (const p of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/bg/..%2f..%2fsecret.txt', '/bg/%2e%2e%5csecret.txt', '/%00']) {
    const st = await raw(p, cookie);
    assert.notEqual(st, 200, p);
  }
  assert.equal(resolveInside('/srv/ui', '/../../etc/passwd'), path.resolve('/srv/ui/etc/passwd'));
  assert.equal(resolveInside('/srv/ui', '%E0%A4%A'), null);
});

test('/bg/ prefers the user dir, then the bundled one', async () => {
  const cookie = 'helm_key=' + TOKEN;
  assert.equal((await get('/bg/mine.png', { cookie })).body, 'user');
  assert.equal((await get('/bg/only-bundled.png', { cookie })).body, 'bundled2');
  assert.equal((await get('/bg/missing.png', { cookie })).status, 404);
});

test('WS: no token -> 4401 close; foreign Origin -> 403; good token or cookie -> open', async () => {
  const origin = `http://127.0.0.1:${port}`;
  const none = await wsOpen(`ws://127.0.0.1:${port}/ws`, { origin });
  const code = await new Promise((r) => (none.open ? none.ws.once('close', (c) => r(c)) : r(none.status)));
  assert.equal(code, 4401);
  const evil = await wsOpen(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { origin: 'http://evil.example' });
  assert.equal(evil.open, false); assert.equal(evil.status, 403);
  const sub = await wsOpen(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { origin: `http://127.0.0.1:${port}.evil.example` });
  assert.equal(sub.status, 403);
  const wrongPath = await wsOpen(`ws://127.0.0.1:${port}/other?token=${TOKEN}`, { origin });
  assert.equal(wrongPath.status, 404);
  const good = await wsOpen(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { origin });
  assert.ok(good.open);
  const cook = await wsOpen(`ws://127.0.0.1:${port}/ws`, { origin, headers: { cookie: 'helm_key=' + TOKEN } });
  assert.ok(cook.open);
  good.ws.close(); cook.ws.close();
});

test('RPC routing, error frames and broadcast', async () => {
  const { ws } = await wsOpen(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { origin: `http://127.0.0.1:${port}` });
  const hello = await call(ws, 'app.hello');
  assert.deepEqual(hello.result.sessions, [{ id: 's1' }]);
  assert.equal(hello.result.platform, 'web'); // node client: not the Electron window
  assert.equal((await call(ws, 'usage.get')).result.fiveHour.percent, 1);
  const boom = await call(ws, 'sessions.boom');
  assert.deepEqual(boom.error, { message: 'kaboom', code: 'internal' });
  assert.equal((await call(ws, 'nope')).error.code, 'unknown_method');
  assert.equal((await call(ws, 'toString')).error.code, 'unknown_method'); // no prototype lookups
  assert.equal((await call(ws, 'settings.set', { theme: 'x' })).error.code, 'bad_params');
  assert.equal((await call(ws, 'app.window', { action: 'minimize' })).error.code, 'unsupported');
  assert.equal((await call(ws, 'files.pickFolder')).error.code, 'unsupported');
  ws.send('not json'); ws.send(JSON.stringify({ type: 'rpc' }));
  assert.ok((await call(ws, 'app.ping')).result.t > 0, 'server survives junk frames');
  const ev = new Promise((r) => ws.once('message', (m) => r(JSON.parse(String(m)))));
  srv.broadcast('queue.updated', { queue: [] });
  assert.deepEqual(await ev, { type: 'event', event: 'queue.updated', data: { queue: [] } });
  ws.close();
});

test('window actions are allowed only for the Electron window client', async () => {
  const router = createRouter({
    engine: { methods: {}, snapshot: async () => ({}) }, version: 't', files: {}, queue: { list: () => [] }, settings: { get: () => ({}) },
    windowCtl: { minimize: () => {} },
  });
  assert.deepEqual(await router.handle({ platform: 'electron' }, 'app.window', { action: 'minimize' }), {});
  await assert.rejects(router.handle({ platform: 'electron' }, 'app.window', { action: 'explode' }), { code: 'bad_params' });
  assert.equal((await router.handle({ platform: 'electron' }, 'app.hello', {})).platform, 'electron');
});

test('port fallback when the fixed port is taken, and never 0.0.0.0', async () => {
  const s2 = await startServer({ uiDir, token: TOKEN, port, hosts: ['0.0.0.0'], onRpc: async () => ({}) });
  try {
    assert.notEqual(s2.port, port);
    assert.ok(s2.portFellBack);
    assert.deepEqual(s2.hosts, ['127.0.0.1']);
    assert.equal(await s2.bindHost('0.0.0.0'), false);
  } finally { await s2.close(); }
});

// ---------- review-main round: auth edge cases, DNS rebinding, CSP ----------
// Raw request with an exact Host header; resolves the status, or 'hang' if nothing comes back in time.
function rawHost(p, host, extra = '', ms = 1500) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${p} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`));
    let buf = ''; const t = setTimeout(() => { s.destroy(); resolve('hang'); }, ms);
    s.on('data', (d) => { buf += d; }); s.on('end', () => { clearTimeout(t); resolve(Number(buf.split(' ')[1])); });
    s.on('error', () => { clearTimeout(t); resolve(0); });
  });
}

test('a same-length multibyte key/token/cookie is a clean 401, not a thrown handler (any web page could send one)', async () => {
  const caught = [];
  const onUncaught = (e) => caught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    const multi = encodeURIComponent('é'.repeat(64)); // 64 UTF-16 units, 128 bytes: timingSafeEqual would throw
    const h = `127.0.0.1:${port}`;
    assert.equal(await rawHost('/?key=' + multi, h), 401);
    assert.equal(await rawHost('/?token=' + multi, h), 401);
    assert.equal(await rawHost('/app.js', h, `Cookie: helm_key=${multi}\r\n`), 401);
    const ws = await wsOpen(`ws://127.0.0.1:${port}/ws?token=${multi}`, { origin: `http://${h}` });
    const code = await new Promise((r) => (ws.open ? ws.ws.once('close', (c) => r(c)) : r(ws.status || ws.error)));
    assert.equal(code, 4401);
    assert.deepEqual(caught.map((e) => e.message), []);
  } finally { process.off('uncaughtException', onUncaught); }
});

test('DNS rebinding: a foreign Host header is refused on HTTP and WS, even with the token', async () => {
  const cookie = `Cookie: helm_key=${TOKEN}\r\n`;
  for (const h of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `localhost.evil.example:${port}`, `attacker.ts.net.evil.example:${port}`]) {
    assert.equal(await rawHost('/app.js', h, cookie), 403, h);
    assert.equal(await rawHost('/?token=' + TOKEN, h), 403, h);
  }
  // the hosts Helm is really reached on: loopback, the Tailscale IP, MagicDNS (short + full)
  for (const h of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `100.101.102.103:${port}`, `my-pc:${port}`, `my-pc.tail1234.ts.net:${port}`, 'MY-PC.Tail1234.TS.NET']) {
    assert.equal(await rawHost('/app.js', h, cookie), 200, h);
  }
  const host = `evil.example:${port}`;
  const ws = await wsOpen(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { origin: `http://${host}`, headers: { host } });
  assert.equal(ws.open, false); assert.equal(ws.status, 403);
});

test('HTML pages carry a CSP: own scripts + the hashes of their inline scripts only', async () => {
  const inline = '{"imports":{"x":"/x.js"}}';
  fs.writeFileSync(path.join(uiDir, 'csp.html'), `<!doctype html><script type="importmap">${inline}</script><script type="module" src="/app.js"></script>`);
  const r = await get('/csp.html', { cookie: 'helm_key=' + TOKEN });
  assert.equal(r.status, 200);
  const csp = r.headers['content-security-policy'] || '';
  const hash = require('crypto').createHash('sha256').update(inline).digest('base64');
  assert.match(csp, /script-src 'self' /);
  assert.ok(csp.includes(`'sha256-${hash}'`), csp);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.equal((await get('/csp.html', { cookie: 'helm_key=' + TOKEN })).body.length, r.body.length);
});

test('the real ui/ pages: every inline script is covered by the CSP the server sends', async () => {
  const realUi = path.join(__dirname, '..', '..', 'ui');
  const s2 = await startServer({ uiDir: realUi, token: TOKEN, port: 0, onRpc: async () => ({}) });
  try {
    for (const page of ['/index.html', '/quick/index.html', '/']) {
      const r = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: s2.port, path: page, headers: { cookie: 'helm_key=' + TOKEN } }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, csp: res.headers['content-security-policy'], body: b }));
      }).on('error', reject));
      assert.equal(r.status, 200, page);
      const inl = [...r.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter((m) => !/\bsrc\s*=/i.test(m[1]) && m[2]);
      for (const m of inl) {
        const h = require('crypto').createHash('sha256').update(m[2], 'utf8').digest('base64');
        assert.ok(r.csp.includes(`'sha256-${h}'`), `${page}: inline script not hashed`);
      }
      assert.doesNotMatch(r.body, /\son[a-z]+\s*=\s*["']/i, `${page}: inline event handler attributes are blocked by the CSP`);
    }
  } finally { await s2.close(); }
});

test('router: window actions are own properties only; test.* exists only when main.js passes testMethods', async () => {
  const calls = [];
  const mk = (testMethods) => createRouter({
    engine: { methods: {}, snapshot: async () => ({}) }, version: 't', files: {}, queue: { list: () => [] }, settings: { get: () => ({}) },
    windowCtl: { minimize: () => calls.push('min') }, testMethods,
  });
  const r = mk(null);
  for (const action of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    await assert.rejects(r.handle({ platform: 'electron' }, 'app.window', { action }), { code: 'bad_params' }, action);
  }
  assert.deepEqual(calls, []);
  await assert.rejects(r.handle({ platform: 'electron' }, 'test.capture', {}), { code: 'unknown_method' });
  await assert.rejects(r.handle({ platform: 'web' }, 'test.quick', { eval: '1' }), { code: 'unknown_method' });
  const t = mk({ 'test.ping': async () => 'pong' });
  assert.equal(await t.handle({ platform: 'web' }, 'test.ping', {}), 'pong');
});

test('hostAllowed: extra names from the host (the phone link MagicDNS name) are accepted, look-alikes are not', async () => {
  const { hostAllowed } = require('../../main/server');
  assert.equal(hostAllowed('pc.example.org:4871', ['pc.example.org']), true);
  assert.equal(hostAllowed('PC.EXAMPLE.ORG.', ['pc.example.org']), true);
  assert.equal(hostAllowed('pc.example.org.evil.com:4871', ['pc.example.org']), false);
  assert.equal(hostAllowed('evil.com', []), false);
  assert.equal(hostAllowed('a b', []), false);
  assert.equal(hostAllowed(undefined, []), true); // no Host header: not a browser
  const s2 = await startServer({ uiDir, token: TOKEN, port: 0, extraHosts: () => ['pc.example.org'], onRpc: async () => ({}) });
  try {
    const st = (h) => new Promise((resolve) => http.get({ host: '127.0.0.1', port: s2.port, path: '/app.js', headers: { host: h, cookie: 'helm_key=' + TOKEN } }, (res) => { res.resume(); resolve(res.statusCode); }));
    assert.equal(await st(`pc.example.org:${s2.port}`), 200);
    assert.equal(await st(`other.example.org:${s2.port}`), 403);
  } finally { await s2.close(); }
});

// Helm has no sign-in panel of its own, so nothing outside ui/ is served: a file next to ui/ (e.g. in a
// gitignored local/ folder) is 404, with or without the key.
test('/local/ is not a route: files outside ui/ are never served', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-srv-local-'));
  const ui = path.join(root, 'ui'); const local = path.join(root, 'local');
  fs.mkdirSync(ui); fs.mkdirSync(local);
  fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>Helm</title>');
  fs.writeFileSync(path.join(local, 'panel.js'), 'export const x = 1;');
  const s = await startServer({ uiDir: ui, token: TOKEN, port: 0, onRpc: async () => null });
  const at = (url, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: s.port, path: url, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  try {
    const cookie = { cookie: 'helm_key=' + TOKEN };
    for (const u of ['/local/panel.js', '/local/', '/local/panel.js?token=' + TOKEN, '/../local/panel.js']) {
      const st = await at(u, cookie);
      assert.ok(st === 404 || st === 400 || st === 403, `${u} -> ${st}`);
    }
    assert.equal(await at('/index.html', cookie), 200, 'ui/ itself is still served');
  } finally {
    await s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
