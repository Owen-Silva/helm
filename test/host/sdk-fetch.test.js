// main/sdk-fetch.js: the installed build's Claude Agent SDK download (no network: a fake fetch serves a
// synthetic npm tarball), plus main/distribution.js (installed build vs checkout).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const sdk = require('../../main/sdk-fetch');
const { isInstalledBuild } = require('../../main/distribution');

// ---- a tiny ustar writer (the shape npm pack produces) ----
function header(name, size, type = '0', prefix = '') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257); h.write('00', 263);
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function tar(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '');
    if (e.pax) {
      const rec = Object.entries(e.pax).map(([k, v]) => { const body = ` ${k}=${v}\n`; let n = body.length + 1; while (String(n).length + body.length !== n) n++; return n + body; }).join('');
      parts.push(header('PaxHeader', Buffer.byteLength(rec), 'x'), pad(Buffer.from(rec)));
    }
    parts.push(header(e.name, e.type === '5' ? 0 : data.length, e.type || '0', e.prefix), ...(e.type === '5' ? [] : [pad(data)]));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
const PKG = { name: '@anthropic-ai/claude-agent-sdk', version: '9.9.9', type: 'module', main: 'sdk.mjs', exports: { '.': { types: './sdk.d.ts', default: './sdk.mjs' } } };
const tgzOf = (entries) => zlib.gzipSync(tar(entries));
const goodTgz = () => tgzOf([
  { name: 'package/package.json', data: JSON.stringify(PKG) },
  { name: 'package/sdk.mjs', data: 'export function query() { return 42; }\n' },
  { name: 'package/lib', type: '5' },
  { name: 'package/lib/x.js', data: 'x' },
  { name: 'ignored-long', data: 'deep', pax: { path: 'package/a/very/long/' + 'n'.repeat(120) + '.txt' } },
]);
const integrityOf = (buf) => 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
const pinFor = (buf, version = '9.9.9') => ({ name: '@anthropic-ai/claude-agent-sdk', version, integrity: integrityOf(buf) });

// fake fetch: answers one body (or a status / an error) and records the URLs
function fakeFetch({ body = null, status = 200, error = null, chunk = 4096 } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (error) throw error;
    let i = 0;
    return {
      ok: status >= 200 && status < 300, status, statusText: '',
      headers: { get: (k) => (k === 'content-length' && body ? String(body.length) : null) },
      body: { getReader: () => ({ read: async () => (body && i < body.length ? { done: false, value: body.subarray(i, (i += chunk)) } : { done: true }) }) },
    };
  };
  fn.calls = calls;
  return fn;
}
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-sdk-test-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const REG = { url: 'https://registry.example/', source: 'test' };

test.describe('distribution: installed build vs checkout', () => {
  const res = 'C:\\Users\\you\\AppData\\Local\\Programs\\helm\\resources';
  test.it('needs the installer marker AND code inside the resources folder', () => {
    assert.equal(isInstalledBuild({ pkg: { helmDistribution: 'installer' }, appDir: res + '\\app', resourcesPath: res }), true);
    assert.equal(isInstalledBuild({ pkg: {}, appDir: res + '\\app', resourcesPath: res }), false);
    // the make-exe launcher: Helm.exe's resources\app stub loads a checkout's main.js
    assert.equal(isInstalledBuild({ pkg: { helmDistribution: 'installer' }, appDir: 'C:\\Users\\you\\helm', resourcesPath: 'C:\\Users\\you\\helm\\dist\\Helm\\resources' }), false);
    assert.equal(isInstalledBuild({ pkg: { name: 'helm' }, appDir: 'C:\\Users\\you\\helm', resourcesPath: 'C:\\Users\\you\\helm\\node_modules\\electron\\dist\\resources' }), false);
    assert.equal(isInstalledBuild({ pkg: { helmDistribution: 'installer' }, appDir: res + 'x\\app', resourcesPath: res }), false);
    assert.equal(isInstalledBuild({}), false);
  });
});

test.describe('pin, registry, tarball URL', () => {
  test.it('readPin accepts the pinned SDK and refuses anything else, with a reason', () => {
    const p = { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.293', integrity: 'sha512-DVfn46SmpfB7xaKuUHsAC+qwY27hOLHNbvF7FoNOAXLZPRTeCr68SjhBjlFOtk+jz5Nf7pfUwnIUDFcdVih6Dg==' };
    assert.deepEqual(sdk.readPin({ helmSdk: p }), p);
    for (const bad of [null, { ...p, name: 'left-pad' }, { ...p, version: 'latest' }, { ...p, integrity: 'sha1-abc' }]) {
      assert.throws(() => sdk.readPin({ helmSdk: bad }), (e) => e.code === 'pin' && /Reinstall Helm/.test(e.reason));
    }
  });
  test.it('tarballUrl is npm\'s own path, under any registry base', () => {
    const pin = { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.293' };
    assert.equal(sdk.tarballUrl('https://registry.npmjs.org/', pin), 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.293.tgz');
    assert.equal(sdk.tarballUrl('https://mirror.example/npm', pin), 'https://mirror.example/npm/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.293.tgz');
  });
  test.it('resolveRegistry: HELM_NPM_REGISTRY > npm_config_registry > .npmrc > default', () => {
    const rf = () => 'fund=false\nregistry = https://npmrc.example/\n';
    assert.deepEqual(sdk.resolveRegistry({ env: { HELM_NPM_REGISTRY: 'http://127.0.0.1:9', npm_config_registry: 'https://x/' }, readFile: rf }), { url: 'http://127.0.0.1:9/', source: 'HELM_NPM_REGISTRY' });
    assert.deepEqual(sdk.resolveRegistry({ env: { npm_config_registry: 'https://cfg.example/' }, readFile: rf }), { url: 'https://cfg.example/', source: 'npm_config_registry' });
    assert.deepEqual(sdk.resolveRegistry({ env: {}, readFile: rf }), { url: 'https://npmrc.example/', source: '.npmrc' });
    assert.deepEqual(sdk.resolveRegistry({ env: {}, readFile: () => { throw new Error('ENOENT'); } }), { url: 'https://registry.npmjs.org/', source: 'default' });
  });
  test.it('defaultSdkRoot: %LOCALAPPDATA%\\Helm\\claude-agent-sdk, or HELM_SDK_DIR', () => {
    assert.equal(sdk.defaultSdkRoot({ LOCALAPPDATA: 'C:\\L' }), path.join('C:\\L', 'Helm', 'claude-agent-sdk'));
    assert.equal(sdk.defaultSdkRoot({ HELM_SDK_DIR: 'D:\\sdk', LOCALAPPDATA: 'C:\\L' }), path.resolve('D:\\sdk'));
  });
});

test.describe('extractTgz', () => {
  test.it('unpacks files, folders and pax long paths, dropping the top folder', () => {
    const d = tmp();
    const r = sdk.extractTgz(goodTgz(), d);
    assert.equal(r.files, 4);
    assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).version, '9.9.9');
    assert.equal(fs.readFileSync(path.join(d, 'lib', 'x.js'), 'utf8'), 'x');
    assert.equal(fs.readFileSync(path.join(d, 'a', 'very', 'long', 'n'.repeat(120) + '.txt'), 'utf8'), 'deep');
  });
  test.it('refuses paths that escape the folder', () => {
    for (const name of ['package/../../evil.txt', '/abs/evil.txt', 'package/C:/evil.txt']) {
      const d = tmp();
      assert.throws(() => sdk.extractTgz(tgzOf([{ name, data: 'x' }]), d), (e) => e.code === 'corrupt' && /unsafe file path/.test(e.reason));
      assert.equal(fs.existsSync(path.join(d, '..', 'evil.txt')), false);
    }
  });
  test.it('a damaged archive is "damaged", not a crash', () => {
    assert.throws(() => sdk.extractTgz(Buffer.from('not gzip'), tmp()), (e) => e.code === 'corrupt');
    const t = tar([{ name: 'package/a', data: 'abc' }]);
    t[0] ^= 0xff; // breaks the header checksum
    assert.throws(() => sdk.extractTgz(zlib.gzipSync(t), tmp()), (e) => e.code === 'corrupt');
  });
});

test.describe('ensureSdk', () => {
  test.it('downloads, checks the sha512, unpacks, verifies, then reuses the copy without a download', async () => {
    const root = tmp();
    const body = goodTgz();
    const pin = pinFor(body);
    const fetch = fakeFetch({ body, chunk: 100 });
    const phases = [];
    let verified = null;
    const r = await sdk.ensureSdk({ pin, root, registry: REG, fetch, onProgress: (p) => phases.push(p.phase), verify: async (u) => { verified = u; } });
    assert.equal(r.ok, true);
    assert.equal(r.fetched, true);
    assert.equal(r.bytes, body.length);
    assert.deepEqual(fetch.calls, ['https://registry.example/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-9.9.9.tgz']);
    assert.deepEqual([...new Set(phases)], ['downloading', 'verifying', 'unpacking', 'loading', 'ready']);
    assert.equal(verified, r.entryUrl);
    assert.ok(r.entry.endsWith(path.join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs')));
    const m = await import(r.entryUrl);
    assert.equal(m.query(), 42);
    assert.deepEqual(fs.readdirSync(root).sort(), ['installed']); // no staging or previous folders left behind
    const again = await sdk.ensureSdk({ pin, root, registry: REG, fetch });
    assert.equal(again.ok, true);
    assert.equal(again.fetched, false);
    assert.equal(fetch.calls.length, 1);
  });
  test.it('a changed entry file or a new pinned version downloads again', async () => {
    const root = tmp();
    const body = goodTgz();
    const pin = pinFor(body);
    const fetch = fakeFetch({ body });
    const r = await sdk.ensureSdk({ pin, root, registry: REG, fetch });
    fs.appendFileSync(r.entry, '// changed\n');
    assert.match(sdk.sdkStatus(root, pin).reason, /changed or damaged/);
    await sdk.ensureSdk({ pin, root, registry: REG, fetch });
    assert.equal(fetch.calls.length, 2);
    assert.match(sdk.sdkStatus(root, { ...pin, version: '9.9.10' }).reason, /needs 9\.9\.10; 9\.9\.9 is downloaded/);
  });
  test.it('a checksum mismatch is refused and nothing is installed', async () => {
    const root = tmp();
    const body = goodTgz();
    const pin = { ...pinFor(body), integrity: integrityOf(Buffer.from('something else')) };
    await assert.rejects(sdk.ensureSdk({ pin, root, registry: REG, fetch: fakeFetch({ body }) }), (e) => e.code === 'integrity' && /did not match the checksum/.test(e.reason) && /registry\.example/.test(e.reason));
    assert.equal(sdk.sdkStatus(root, pin).ok, false);
    assert.equal(fs.existsSync(path.join(root, 'installed')), false);
  });
  test.it('the wrong package inside a matching tarball is refused', async () => {
    const body = tgzOf([{ name: 'package/package.json', data: JSON.stringify({ ...PKG, name: 'left-pad' }) }, { name: 'package/sdk.mjs', data: '' }]);
    await assert.rejects(sdk.ensureSdk({ pin: pinFor(body), root: tmp(), registry: REG, fetch: fakeFetch({ body }) }), (e) => e.code === 'bad_package');
  });
  test.it('a copy that does not load is an "import" failure with the error', async () => {
    const body = goodTgz();
    await assert.rejects(sdk.ensureSdk({ pin: pinFor(body), root: tmp(), registry: REG, fetch: fakeFetch({ body }), verify: async () => { throw new Error('no query export'); } }),
      (e) => e.code === 'import' && e.detail === 'no query export');
  });
  test.it('network failures come back in plain words', async () => {
    const pin = pinFor(goodTgz());
    const cases = [
      [new Error('net::ERR_INTERNET_DISCONNECTED'), 'offline', /offline/],
      [new Error('net::ERR_NAME_NOT_RESOLVED'), 'dns', /could not find registry\.example/],
      [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'refused', /refused the connection/],
      [new Error('net::ERR_CERT_AUTHORITY_INVALID'), 'tls', /certificate/],
      [new Error('net::ERR_PROXY_CONNECTION_FAILED'), 'proxy', /proxy/],
    ];
    for (const [error, code, re] of cases) {
      await assert.rejects(sdk.ensureSdk({ pin, root: tmp(), registry: REG, fetch: fakeFetch({ error }) }), (e) => e.code === code && re.test(e.reason) && typeof e.detail === 'string');
    }
    await assert.rejects(sdk.ensureSdk({ pin, root: tmp(), registry: REG, fetch: fakeFetch({ status: 403 }) }), (e) => e.code === 'blocked' && /HTTP 403/.test(e.reason));
    await assert.rejects(sdk.ensureSdk({ pin, root: tmp(), registry: REG, fetch: fakeFetch({ status: 404 }) }), (e) => e.code === 'not_found');
  });
  test.it('a stalled download is stopped with a reason', async () => {
    const pin = pinFor(goodTgz());
    const fetch = async (_u, { signal }) => ({
      ok: true, status: 200, headers: { get: () => null },
      body: { getReader: () => ({ read: () => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) }) },
    });
    await assert.rejects(sdk.ensureSdk({ pin, root: tmp(), registry: REG, fetch, downloadOpts: { stallMs: 30 } }), (e) => e.code === 'stalled' && /stopped for 0 seconds|stopped for/.test(e.reason));
  });
  test.it('a file far bigger than the SDK is refused before it is read', async () => {
    const pin = pinFor(goodTgz());
    const fetch = async () => ({ ok: true, status: 200, headers: { get: (k) => (k === 'content-length' ? String(500 * 1048576) : null) }, body: { getReader: () => ({ read: async () => ({ done: true }) }) } });
    await assert.rejects(sdk.ensureSdk({ pin, root: tmp(), registry: REG, fetch }), (e) => e.code === 'too_large');
  });
});
