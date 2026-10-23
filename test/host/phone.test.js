// Phone lane: phone.status health checks (main/phone.js) and the install manifest + icons route
// (main/server.js PUBLIC_PATHS) against the real ui/ folder.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer, PUBLIC_PATHS } = require('../../main/server');
const { createPhoneHealth, parseFirewall, parsePortOwner, parseTailscaleStatus, CACHE_MS } = require('../../main/phone');

const UI = path.join(__dirname, '..', '..', 'ui');
const TOKEN = 'b'.repeat(64);

// ---------------------------------------------------------------- parsers
test('parseFirewall: present / disabled / wrong port / missing / error / garbage', () => {
  assert.deepEqual(parseFirewall('PRESENT|True|Allow|Inbound|4871\r\n').state, 'present');
  const off = parseFirewall('PRESENT|False|Allow|Inbound|4871');
  assert.equal(off.state, 'missing'); assert.match(off.detail, /disabled/);
  const port = parseFirewall('PRESENT|True|Allow|Inbound|4870');
  assert.equal(port.state, 'missing'); assert.match(port.detail, /4870, not 4871/);
  assert.equal(parseFirewall('PRESENT|True|Block|Inbound|4871').state, 'missing');
  assert.equal(parseFirewall('PRESENT|True|Allow|Inbound|Any').state, 'present');
  assert.equal(parseFirewall('MISSING').state, 'missing');
  const err = parseFirewall('ERROR|Access is denied.');
  assert.equal(err.state, 'unknown'); assert.equal(err.detail, 'Access is denied.');
  assert.equal(parseFirewall('').state, 'unknown');
  assert.equal(parseFirewall('WARNING: something\r\n').state, 'unknown');
});

test('parsePortOwner and parseTailscaleStatus', () => {
  assert.deepEqual(parsePortOwner('\r\n22512|Helm\r\n'), { pid: 22512, name: 'Helm' });
  assert.equal(parsePortOwner(''), null);
  const ts = parseTailscaleStatus(JSON.stringify({
    BackendState: 'Running', CertDomains: null, CurrentTailnet: { MagicDNSEnabled: true },
    Self: { DNSName: 'my-pc.example.ts.net.' },
    Peer: { a: { HostName: 'Pixel 8', OS: 'android', Online: false }, b: { HostName: 'laptop', OS: 'windows', Online: true }, c: { HostName: 'iph', OS: 'iOS', Online: true } },
  }));
  assert.equal(ts.backendState, 'Running');
  assert.equal(ts.dnsName, 'my-pc.example.ts.net');
  assert.deepEqual(ts.certDomains, []);
  assert.deepEqual(ts.phones, [{ name: 'Pixel 8', os: 'android', online: false }, { name: 'iph', os: 'ios', online: true }]);
  assert.deepEqual(parseTailscaleStatus(JSON.stringify({ CertDomains: ['my-pc.example.ts.net'], Self: {} })).certDomains, ['my-pc.example.ts.net']);
  assert.equal(parseTailscaleStatus('not json'), null);
});

// ---------------------------------------------------------------- createPhoneHealth
function fakeRun({ firewall = 'MISSING', owner = '4242|node', ts = { BackendState: 'Running', CertDomains: null, Self: { DNSName: 'pc.tail.ts.net.' }, Peer: {} } } = {}) {
  const calls = [];
  const run = async (file, args) => {
    const script = args[args.length - 1];
    calls.push(/Get-NetFirewallRule/.test(script) ? 'firewall' : /Get-NetTCPConnection/.test(script) ? 'owner' : /status/.test(args.join(' ')) ? 'tailscale' : file);
    if (/Get-NetFirewallRule/.test(script)) return { ok: true, stdout: firewall + '\r\n', stderr: '' };
    if (/Get-NetTCPConnection/.test(script)) return { ok: true, stdout: owner + '\r\n', stderr: '' };
    if (args[0] === 'status') return ts ? { ok: true, stdout: JSON.stringify(ts), stderr: '' } : { ok: false, stdout: '', stderr: 'not found' };
    return { ok: false, stdout: '', stderr: 'unexpected' };
  };
  return { run, calls };
}

test('status: the full shape, from the server + settings + probes', async () => {
  const { run } = fakeRun({ firewall: 'PRESENT|True|Allow|Inbound|4871' });
  const server = { port: 4871, hosts: ['127.0.0.1', '100.64.0.1'], portFellBack: false, clients: new Set([{ remote: '::ffff:100.88.1.2' }, { remote: '127.0.0.1' }]) };
  const h = createPhoneHealth({ getServer: () => server, getSettings: () => ({ phone: { enabled: true, url: 'http://pc.tail.ts.net:4871/?key=k' } }), getTailscaleIp: () => '100.64.0.1', run, platform: 'win32' });
  const st = await h.status();
  assert.equal(st.tailscaleUp, true);
  assert.deepEqual(st.boundAddresses, ['127.0.0.1', '100.64.0.1']);
  assert.equal(st.boundOnTailscale, true);
  assert.equal(st.port, 4871); assert.equal(st.expectedPort, 4871); assert.equal(st.portIsFallback, false); assert.equal(st.portOwner, null);
  assert.equal(st.firewallRule, 'present');
  assert.equal(st.httpsAvailable, false);
  assert.equal(st.magicDnsName, 'pc.tail.ts.net');
  assert.equal(st.url, 'http://pc.tail.ts.net:4871/?key=k');
  assert.equal(st.phoneClientsNow, 1);
  assert.equal(st.enabled, true);
});

test('status: probes are cached for 60 s, refresh skips the cache, port owner only on fallback', async () => {
  let t = 1000;
  const { run, calls } = fakeRun();
  const server = { port: 4871, hosts: ['127.0.0.1'], portFellBack: false };
  const h = createPhoneHealth({ getServer: () => server, getSettings: () => ({ phone: {} }), getTailscaleIp: () => null, run, platform: 'win32', now: () => t });
  const a = await h.status();
  assert.equal(a.tailscaleUp, false);
  assert.equal(a.firewallRule, 'missing');
  assert.deepEqual(calls.sort(), ['firewall', 'tailscale']);
  calls.length = 0;
  t += CACHE_MS - 1; await h.status();
  assert.deepEqual(calls, [], 'cached inside 60 s');
  await h.status({ refresh: true });
  assert.deepEqual(calls.sort(), ['firewall', 'tailscale'], 'refresh re-probes');
  calls.length = 0;
  t += CACHE_MS + 1; server.portFellBack = true; server.port = 51000;
  const b = await h.status();
  assert.deepEqual(calls.sort(), ['firewall', 'owner', 'tailscale']);
  assert.equal(b.portIsFallback, true); assert.equal(b.port, 51000);
  assert.deepEqual(b.portOwner, { pid: 4242, name: 'node' });
});

test('status: concurrent calls share one probe; off-Windows the firewall is unknown; no tailscale CLI', async () => {
  const { run, calls } = fakeRun({ ts: null });
  const h = createPhoneHealth({ getServer: () => null, getSettings: () => ({ phone: { enabled: false } }), getTailscaleIp: () => null, run, platform: 'linux' });
  const [a, b] = await Promise.all([h.status(), h.status()]);
  assert.equal(calls.filter((c) => c === 'tailscale').length, 2, 'both tailscale candidates tried once, not twice each');
  assert.equal(a.firewallRule, 'unknown'); assert.equal(b.firewallRule, 'unknown');
  assert.equal(a.enabled, false); assert.equal(a.port, null); assert.deepEqual(a.boundAddresses, []);
  assert.equal(a.magicDnsName, null); assert.deepEqual(a.phones, []);
});

test('onClient remembers the last Tailscale client; busy 4871 fires one notify on the first client', async () => {
  const events = [];
  let t = 5000;
  const { run } = fakeRun({ owner: '777|python' });
  const server = { port: 52000, hosts: ['127.0.0.1'], portFellBack: true, clients: new Set() };
  const h = createPhoneHealth({ getServer: () => server, getSettings: () => ({ phone: {} }), getTailscaleIp: () => null, run, platform: 'win32', now: () => t, emit: (e, d) => events.push([e, d]) });
  h.onClient({ remote: '127.0.0.1', platform: 'electron' }, 'open');
  h.onClient({ remote: '127.0.0.1', platform: 'electron' }, 'open');
  h.onClient({ remote: '::ffff:100.70.1.9', platform: 'web' }, 'open');
  h.onClient({ remote: '100.70.1.9' }, 'close');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(events.length, 1, 'exactly one notice');
  assert.equal(events[0][0], 'notify');
  assert.equal(events[0][1].kind, 'info');
  assert.match(events[0][1].body, /python \(PID 777\) is using 4871, so Helm is on 52000/);
  assert.equal(await h.fallbackNotice(), null, 'never twice');
  const st = await h.status();
  assert.equal(st.lastPhoneAt, 5000); assert.equal(st.lastPhoneRemote, '100.70.1.9');
});

test('no notice when 4871 was free', async () => {
  const events = [];
  const h = createPhoneHealth({ getServer: () => ({ port: 4871, hosts: [], portFellBack: false }), getSettings: () => ({}), getTailscaleIp: () => null, run: fakeRun().run, platform: 'win32', emit: (e, d) => events.push([e, d]) });
  h.onClient({ remote: '127.0.0.1' }, 'open');
  assert.equal(await h.fallbackNotice(), null);
  assert.equal(events.length, 0);
});

// ---------------------------------------------------------------- manifest + icons over HTTP
let srv, port;
function get(p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
before(async () => { srv = await startServer({ uiDir: UI, bgDirs: [], token: TOKEN, port: 0 }); port = srv.port; });
after(async () => { await srv.close(); });

test('manifest: served without the key, as application/manifest+json, valid and complete', async () => {
  const r = await get('/manifest.webmanifest');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^application\/manifest\+json/);
  assert.equal(r.headers['set-cookie'], undefined, 'no cookie handed out on the public path');
  const m = JSON.parse(r.body.toString('utf8'));
  assert.equal(m.name, 'Helm'); assert.equal(m.short_name, 'Helm');
  assert.equal(m.display, 'standalone'); assert.equal(m.start_url, '/'); assert.equal(m.scope, '/');
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i); assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  const tokens = fs.readFileSync(path.join(UI, 'styles', 'tokens.css'), 'utf8');
  assert.ok(tokens.toLowerCase().includes(`--bg: ${m.background_color.toLowerCase()}`), 'background_color comes from the dark --bg token');
  const want = { '192x192:any': 192, '512x512:any': 512, '512x512:maskable': 512 };
  for (const [k, size] of Object.entries(want)) {
    const [sizes, purpose] = k.split(':');
    const icon = m.icons.find((i) => i.sizes === sizes && i.purpose === purpose);
    assert.ok(icon, `icon ${k} listed`);
    assert.ok(PUBLIC_PATHS.has(icon.src), `${icon.src} is public`);
    const ir = await get(icon.src);
    assert.equal(ir.status, 200, icon.src);
    assert.equal(ir.headers['content-type'], 'image/png');
    assert.equal(ir.body.readUInt32BE(16), size); assert.equal(ir.body.readUInt32BE(20), size);
  }
});

test('apple-touch-icon is public, 180x180 and opaque; everything else still needs the key', async () => {
  const r = await get('/assets/apple-touch-icon.png');
  assert.equal(r.status, 200);
  assert.equal(r.body.readUInt32BE(16), 180); assert.equal(r.body.readUInt32BE(20), 180);
  assert.equal(r.body[25], 2, 'PNG colour type 2 (RGB, no alpha): iOS paints transparent corners black');
  for (const p of ['/', '/index.html', '/assets/icon.png', '/assets/icon-small.svg', '/app.js', '/shell/phone.js', '/manifest.webmanifest/../index.html']) {
    assert.equal((await get(p)).status, 401, `${p} still gated`);
  }
});

test('public paths keep the DNS-rebinding guard', async () => {
  assert.equal((await get('/manifest.webmanifest', { host: 'evil.example' })).status, 403);
  assert.equal((await get('/assets/app-icon-192.png', { host: 'evil.example:4871' })).status, 403);
});

test('index.html: manifest + touch icon + phone module linked, and the CSP still covers every inline script', async () => {
  const r = await get(`/?token=${TOKEN}`);
  assert.equal(r.status, 200);
  const html = r.body.toString('utf8');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="\/assets\/apple-touch-icon\.png">/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/);
  assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}">/i);
  assert.match(html, /<script type="module" src="\/shell\/phone\.js"><\/script>/);
  const csp = r.headers['content-security-policy'];
  assert.match(csp, /script-src 'self' 'sha256-/);
  assert.doesNotMatch(csp, /unsafe-inline/);
});

test('a page load on the cookie slides its 30 days forward; static files do not re-set it', async () => {
  const cookie = `helm_key=${TOKEN}`;
  const page = await get('/', { cookie });
  assert.equal(page.status, 200);
  assert.match(String(page.headers['set-cookie']), /helm_key=b{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000/);
  const js = await get('/app.js', { cookie });
  assert.equal(js.status, 200);
  assert.equal(js.headers['set-cookie'], undefined);
  assert.equal((await get('/', { cookie: 'helm_key=' + 'c'.repeat(64) })).status, 401, 'a wrong cookie is still refused');
});
