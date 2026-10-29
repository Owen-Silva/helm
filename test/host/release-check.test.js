// lane installer: main/release-check.js, the installed build's update notice (GitHub Releases, not git).
// Fake fetch + fake timers only: no network, no real clock. Response shapes follow GitHub's REST API
// (releases/latest: tag_name, name, html_url, published_at, assets[].browser_download_url) and the two real
// fetch failure shapes: Electron net.fetch ("net::ERR_...") and Node undici (TypeError + cause.code).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createReleaseCheck, parseVersion, compareVersions } = require('../../main/release-check.js');

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const DL = 'https://github.com/Owen-Silva/helm/releases/download/v1.3.0/Helm-Setup.exe';

function release(tag, { assets = [{ name: 'Helm-Setup.exe', browser_download_url: DL }], name } = {}) {
  return { tag_name: tag, name: name || `Helm ${tag}`, html_url: `https://github.com/Owen-Silva/helm/releases/tag/${tag}`, published_at: '2026-10-28T09:00:00Z', assets };
}
function reply(status, body, headers = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { status, statusText: '', headers: { get: (k) => (k.toLowerCase() in h ? h[k.toLowerCase()] : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}
// a fetch that answers from a queue of handlers and records each call
function fakeFetch(...answers) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    return typeof a === 'function' ? a(url, opts) : a;
  };
  f.calls = calls;
  return f;
}
function fakeTimers() {
  let seq = 0;
  const live = new Map();
  const add = (kind) => (fn, ms) => { const h = { id: ++seq, kind, fn, ms, unref() { this.unrefed = true; return this; } }; live.set(h.id, h); return h; };
  const del = (h) => { if (h) live.delete(h.id); };
  return { live, setTimeout: add('timeout'), setInterval: add('interval'), clearTimeout: del, clearInterval: del,
    fire(h) { if (h.kind === 'timeout') live.delete(h.id); h.fn(); },
    find: (pred) => [...live.values()].find(pred) };
}
function make(opts = {}) {
  const changes = [];
  const timers = opts.timers || fakeTimers();
  const rc = createReleaseCheck({ current: '1.2.0', now: () => NOW, timers, onChange: (s) => changes.push(s), ...opts });
  return { rc, changes, timers };
}

test('parse + compare: numeric parts, leading v, not x.y.z is null', () => {
  assert.deepEqual(parseVersion('v1.10.0'), [1, 10, 0]);
  assert.deepEqual(parseVersion('2.0.3'), [2, 0, 3]);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion('v1.2.0-beta.1'), null);
  assert.equal(compareVersions([1, 10, 0], [1, 9, 9]), 1);
  assert.equal(compareVersions([1, 2, 0], [1, 2, 0]), 0);
});

test('newer release: available, with the installer asset, the request GitHub expects', async () => {
  const fetch = fakeFetch(reply(200, release('v1.3.0')));
  const { rc } = make({ fetch });
  const s = await rc.check();
  assert.deepEqual(s, {
    mode: 'installer', current: '1.2.0', phase: 'available', checkedAt: NOW, reason: null, detail: null,
    latest: { version: '1.3.0', tag: 'v1.3.0', name: 'Helm v1.3.0', url: 'https://github.com/Owen-Silva/helm/releases/tag/v1.3.0', download: DL, publishedAt: '2026-10-28T09:00:00Z' },
  });
  assert.equal(fetch.calls.length, 1);
  const { url, opts } = fetch.calls[0];
  assert.equal(url, 'https://api.github.com/repos/Owen-Silva/helm/releases/latest');
  assert.equal(opts.headers.Accept, 'application/vnd.github+json');
  assert.equal(opts.headers['User-Agent'], 'Helm/1.2.0');
  assert.equal(opts.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.ok(opts.signal, 'an abort signal for the timeout');
});

test('1.10.0 is newer than 1.9.0 (numeric, not string compare)', async () => {
  const { rc } = make({ current: '1.9.0', fetch: fakeFetch(reply(200, release('1.10.0'))) });
  assert.equal((await rc.check()).phase, 'available');
});

test('equal and older releases: current', async () => {
  const eq = make({ fetch: fakeFetch(reply(200, release('v1.2.0'))) });
  const a = await eq.rc.check();
  assert.equal(a.phase, 'current');
  assert.equal(a.latest.version, '1.2.0');
  assert.equal(a.reason, null);
  const old = make({ fetch: fakeFetch(reply(200, release('v1.1.9'))) });
  assert.equal((await old.rc.check()).phase, 'current');
});

test('a newer release without the installer asset: available, download null, the page url kept', async () => {
  const { rc } = make({ fetch: fakeFetch(reply(200, release('v1.3.0', { assets: [{ name: 'Source.zip', browser_download_url: 'x' }] }))) });
  const s = await rc.check();
  assert.equal(s.phase, 'available');
  assert.equal(s.latest.download, null);
  assert.equal(s.latest.url, 'https://github.com/Owen-Silva/helm/releases/tag/v1.3.0');
});

test('404: no release published yet (phase none, a plain reason)', async () => {
  const { rc } = make({ fetch: fakeFetch(reply(404, { message: 'Not Found' })) });
  const s = await rc.check();
  assert.equal(s.phase, 'none');
  assert.equal(s.reason, 'No release of Helm has been published yet.');
  assert.equal(s.latest, null);
  assert.equal(s.detail, null);
});

test('a tag that is not x.y.z: failed, says why', async () => {
  const { rc } = make({ fetch: fakeFetch(reply(200, release('nightly-2026-10-28'))) });
  const s = await rc.check();
  assert.equal(s.phase, 'failed');
  assert.match(s.reason, /tagged "nightly-2026-10-28", which is not a version number/);
});

test('offline: Electron net.fetch and undici shapes map to plain words, code kept in detail', async () => {
  const el = make({ fetch: fakeFetch(() => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); }) });
  const a = await el.rc.check();
  assert.equal(a.phase, 'failed');
  assert.equal(a.reason, 'This computer looks offline, so Helm could not check for a new version.');
  assert.match(a.detail, /ERR_INTERNET_DISCONNECTED/);

  const dnsErr = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }) });
  const un = make({ fetch: fakeFetch(() => { throw dnsErr; }) });
  const b = await un.rc.check();
  assert.match(b.reason, /could not find GitHub/);
  assert.match(b.detail, /fetch failed.*ENOTFOUND/);

  const el2 = make({ fetch: fakeFetch(() => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); }) });
  assert.match((await el2.rc.check()).reason, /could not find GitHub/);
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const r = make({ fetch: fakeFetch(() => { throw refused; }) });
  assert.match((await r.rc.check()).reason, /refused or dropped/);
});

test('rate limit: 403 with x-ratelimit-remaining 0 says when it can check again', async () => {
  const reset = Math.floor(NOW / 1000) + 25 * 60;
  const { rc } = make({ fetch: fakeFetch(reply(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': 0, 'x-ratelimit-reset': reset })) });
  const s = await rc.check();
  assert.equal(s.phase, 'failed');
  assert.equal(s.reason, "GitHub's limit on update checks was reached; Helm can check again in about 25 minutes.");
  assert.match(s.detail, /HTTP 403/);
  const t = make({ fetch: fakeFetch(reply(429, {}, { 'retry-after': 60 })) });
  assert.match((await t.rc.check()).reason, /about 1 minute\.$/);
  const other = make({ fetch: fakeFetch(reply(403, { message: 'Forbidden' })) });
  assert.equal((await other.rc.check()).reason, 'GitHub refused the update check (HTTP 403).');
});

test('5xx and bad JSON: failed with plain words', async () => {
  const a = make({ fetch: fakeFetch(reply(502, 'Bad gateway')) });
  const s = await a.rc.check();
  assert.match(s.reason, /GitHub is having trouble/);
  assert.equal(s.detail, 'HTTP 502');
  const b = make({ fetch: fakeFetch(reply(200, '<html>captive portal</html>')) });
  const t = await b.rc.check();
  assert.match(t.reason, /could not be read/);
  assert.match(t.detail, /^bad JSON/);
});

test('timeout: aborts the request after timeoutMs and says so', async () => {
  let seen = null;
  const fetch = fakeFetch((url, opts) => new Promise((_, reject) => {
    seen = opts.signal;
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  }));
  const { rc, timers } = make({ fetch, timeoutMs: 5000 });
  const p = rc.check();
  await new Promise((r) => setImmediate(r));
  assert.equal(rc.state().phase, 'checking');
  const t = timers.find((h) => h.kind === 'timeout' && h.ms === 5000);
  assert.ok(t, 'the abort timer is armed');
  timers.fire(t);
  const s = await p;
  assert.equal(seen.aborted, true);
  assert.equal(s.phase, 'failed');
  assert.equal(s.reason, 'GitHub did not answer within 5 seconds, so Helm could not check for a new version.');
  assert.equal(s.detail, 'timed out after 5000 ms');
});

test('the last good latest survives a later failure; the abort timer is cleared on success', async () => {
  const fetch = fakeFetch(reply(200, release('v1.3.0')), () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); });
  const { rc, timers } = make({ fetch });
  await rc.check();
  assert.equal(timers.live.size, 0, 'no timer left after a check');
  const s = await rc.check();
  assert.equal(s.phase, 'failed');
  assert.equal(s.latest.version, '1.3.0');
  assert.equal(s.latest.download, DL);
});

test('concurrent checks share one request', async () => {
  let release_;
  const fetch = fakeFetch(() => new Promise((r) => { release_ = () => r(reply(200, release('v1.3.0'))); }));
  const { rc } = make({ fetch });
  const a = rc.check(), b = rc.check();
  assert.equal(a, b);
  await new Promise((r) => setImmediate(r));
  assert.equal(fetch.calls.length, 1);
  release_();
  const [sa, sb] = await Promise.all([a, b]);
  assert.deepEqual(sa, sb);
  const again = rc.check();
  await new Promise((r) => setImmediate(r));
  release_();
  await again;
  assert.equal(fetch.calls.length, 2, 'a check after the first one finished asks again');
});

test('onChange: checking, then the result, each a full state', async () => {
  const { rc, changes } = make({ fetch: fakeFetch(reply(200, release('v1.3.0'))) });
  await rc.check();
  assert.deepEqual(changes.map((c) => c.phase), ['checking', 'available']);
  assert.deepEqual(Object.keys(changes[1]).sort(), ['checkedAt', 'current', 'detail', 'latest', 'mode', 'phase', 'reason']);
  assert.deepEqual(rc.state(), changes[1]);
});

test('an onChange that throws does not break the check', async () => {
  const { rc } = make({ fetch: fakeFetch(reply(200, release('v1.3.0'))), onChange: () => { throw new Error('boom'); } });
  assert.equal((await rc.check()).phase, 'available');
});

test('start: one check after startDelayMs, then every intervalMs (unref); stop clears both', async () => {
  const fetch = fakeFetch(reply(200, release('v1.2.0')));
  const { rc, timers } = make({ fetch, startDelayMs: 20e3, intervalMs: 6 * 3600e3 });
  assert.equal(rc.state().phase, 'idle');
  rc.start();
  rc.start(); // idempotent
  const first = timers.find((h) => h.kind === 'timeout' && h.ms === 20e3);
  assert.ok(first && first.unrefed);
  assert.equal(timers.live.size, 1);
  assert.equal(fetch.calls.length, 0);
  timers.fire(first);
  await new Promise((r) => setImmediate(r));
  assert.equal(fetch.calls.length, 1);
  const every = timers.find((h) => h.kind === 'interval');
  assert.ok(every && every.unrefed && every.ms === 6 * 3600e3);
  every.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(fetch.calls.length, 2);
  rc.stop();
  assert.equal(timers.live.size, 0);

  const early = make({ fetch: fakeFetch(reply(200, release('v1.2.0'))) });
  early.rc.start();
  early.rc.stop();
  assert.equal(early.timers.live.size, 0, 'stop before the first check clears the start delay');
});

test('a current version that is not x.y.z fails with a reason instead of guessing', async () => {
  const fetch = fakeFetch(reply(200, release('v1.3.0')));
  const { rc } = make({ current: 'dev', fetch });
  const s = await rc.check();
  assert.equal(s.phase, 'failed');
  assert.match(s.reason, /own version \("dev"\) is not a version number/);
  assert.equal(fetch.calls.length, 0);
});
