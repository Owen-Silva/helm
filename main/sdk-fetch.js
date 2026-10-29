// Installed builds only (main/distribution.js): download Anthropic's Claude Agent SDK onto this PC.
//
// Helm's installer must not contain the SDK. It is Anthropic's proprietary software, so Helm can't
// redistribute it. A checkout gets it from `npm install`. An installed Helm gets the same package from the
// same place on the user's own machine:
//   - the tarball npm itself downloads (<registry>/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-<v>.tgz),
//   - checked against the sha512 that package-lock.json pins (npm ci checks the same "integrity"),
//   - unpacked into %LOCALAPPDATA%\Helm\claude-agent-sdk\installed\node_modules\@anthropic-ai\claude-agent-sdk.
// Only the SDK's main package is fetched. Its optional per-platform packages hold a bundled claude.exe, and
// Helm runs the user's own Claude Code instead. Its peer packages aren't imported by the SDK's entry file.
//
// Every failure throws an SdkError with a plain-words `reason` (offline, npm blocked, checksum mismatch,
// disk full...) and a technical `detail`. main/sdk-setup.js shows both and offers Try again. Nothing here
// falls back silently.
//
// Registry: HELM_NPM_REGISTRY, else npm_config_registry, else `registry=` in %USERPROFILE%\.npmrc, else
// https://registry.npmjs.org/. The sha512 check makes a mirror safe: it must serve the exact same bytes.
// Location: HELM_SDK_DIR overrides %LOCALAPPDATA%\Helm\claude-agent-sdk. The uninstaller removes that folder.
// Owner: lane installer.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const SDK_NAME = '@anthropic-ai/claude-agent-sdk';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const MARKER = 'helm-sdk.json';
const MAX_BYTES = 200 * 1024 * 1024;   // the 0.3.293 tarball is 1.6 MB; anything near this is wrong
const STALL_MS = 30_000;               // no bytes for this long = stalled
const TOTAL_MS = 10 * 60_000;
const PROGRESS_MS = 100;

class SdkError extends Error {
  constructor(code, reason, detail) {
    super(reason);
    this.name = 'SdkError';
    this.code = code;
    this.reason = reason;
    this.detail = detail || null;
  }
}

// package.json "helmSdk" (tools/build-installer.js copies it from package-lock.json): { name, version, integrity }.
function readPin(pkg) {
  const p = pkg && pkg.helmSdk;
  if (!p || p.name !== SDK_NAME || !/^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(String(p.version || ''))
    || !/(^|\s)sha512-[A-Za-z0-9+/]+={0,2}(\s|$)/.test(String(p.integrity || ''))) {
    throw new SdkError('pin', 'This Helm build does not say which Claude Agent SDK it needs, so it cannot download one. Reinstall Helm.',
      `package.json helmSdk = ${JSON.stringify(p || null)}`);
  }
  return { name: p.name, version: p.version, integrity: String(p.integrity).trim() };
}

function defaultSdkRoot(env = process.env) {
  if (env.HELM_SDK_DIR) return path.resolve(env.HELM_SDK_DIR);
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Helm', 'claude-agent-sdk');
}

// The registry npm would use for this user (see the header), and where that came from.
function resolveRegistry({ env = process.env, home = os.homedir(), readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const fromNpmrc = () => {
    let text = null;
    try { text = readFile(path.join(home, '.npmrc')); } catch { return null; }
    const m = String(text).match(/^\s*registry\s*=\s*(\S+)\s*$/m);
    return m ? m[1] : null;
  };
  const pick = [['HELM_NPM_REGISTRY', env.HELM_NPM_REGISTRY], ['npm_config_registry', env.npm_config_registry || env.NPM_CONFIG_REGISTRY], ['.npmrc', fromNpmrc()]]
    .find(([, v]) => v && /^https?:\/\//i.test(v));
  const url = pick ? pick[1] : DEFAULT_REGISTRY;
  return { url: url.endsWith('/') ? url : url + '/', source: pick ? pick[0] : 'default' };
}

// npm's tarball path: <registry>/@scope/name/-/name-<version>.tgz
function tarballUrl(registry, pin) {
  const bare = pin.name.split('/').pop();
  return new URL(`${pin.name}/-/${bare}-${pin.version}.tgz`, registry.endsWith('/') ? registry : registry + '/').href;
}

const sha512b64 = (buf) => crypto.createHash('sha512').update(buf).digest('base64');
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The sha512 out of an SRI integrity string ("sha512-<base64> [more]"), or null.
function sha512Of(integrity) {
  const m = String(integrity || '').split(/\s+/).map((s) => s.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)).find(Boolean);
  return m ? m[1] : null;
}

// ---------- errors in plain words ----------
function describeError(e, { host = 'the npm registry', url = '' } = {}) {
  if (e instanceof SdkError) return e;
  const msg = String((e && e.message) || e || 'unknown error');
  const cause = e && e.cause;
  const code = String((cause && cause.code) || (e && e.code) || '');
  const net = (msg.match(/net::(ERR_[A-Z_]+)/) || [])[1] || '';
  const detail = [net || code, msg, url].filter(Boolean).join(' · ');
  const is = (...names) => names.includes(net) || names.includes(code);
  if (is('ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED', 'ENETUNREACH', 'ERR_ADDRESS_UNREACHABLE')) return new SdkError('offline', 'This PC is offline. Connect to the internet and press Try again.', detail);
  if (is('ERR_NAME_NOT_RESOLVED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_NAME_RESOLUTION_FAILED')) return new SdkError('dns', `Helm could not find ${host}. This PC may be offline, or the network blocks it.`, detail);
  if (is('ERR_CONNECTION_REFUSED', 'ECONNREFUSED')) return new SdkError('refused', `${host} refused the connection. A firewall or proxy may block npm on this network.`, detail);
  if (is('ERR_CONNECTION_RESET', 'ECONNRESET', 'ERR_CONNECTION_CLOSED', 'ERR_EMPTY_RESPONSE', 'UND_ERR_SOCKET')) return new SdkError('reset', `The connection to ${host} was cut off. A firewall or proxy may block npm on this network.`, detail);
  if (is('ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT')) return new SdkError('timeout', `${host} did not answer in time. The network may be slow or block npm.`, detail);
  if (/^ERR_(CERT|SSL)_|^ERR_BAD_SSL|^ERR_CERTIFICATE/.test(net) || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return new SdkError('tls', `The secure connection to ${host} failed a certificate check. A proxy may be intercepting HTTPS on this network.`, detail);
  if (/^ERR_(PROXY|TUNNEL)_/.test(net) || is('ERR_TUNNEL_CONNECTION_FAILED', 'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED')) return new SdkError('proxy', 'The network proxy refused the download. Ask whoever runs the network to allow the npm registry.', detail);
  if (is('ENOSPC')) return new SdkError('disk_full', 'The disk is full. Free some space and press Try again.', detail);
  if (is('EPERM', 'EACCES', 'EBUSY', 'EROFS')) return new SdkError('write', `Helm could not write the SDK's files (${code}). Another program (often antivirus) may be holding them; press Try again.`, detail);
  return new SdkError('network', `The download from ${host} failed.`, detail);
}

// ---------- download ----------
// fetch: a WHATWG fetch (Electron's net.fetch in Helm: it follows the system proxy). onProgress({ received, total }).
async function download(url, { fetch, onProgress = () => {}, stallMs = STALL_MS, totalMs = TOTAL_MS, maxBytes = MAX_BYTES, timers = { setTimeout, clearTimeout } } = {}) {
  const host = (() => { try { return new URL(url).host; } catch { return 'the npm registry'; } })();
  const ac = new AbortController();
  let why = null;
  const abort = (w) => { if (!why) { why = w; ac.abort(); } };
  let stall = timers.setTimeout(() => abort('stall'), stallMs);
  const total = timers.setTimeout(() => abort('total'), totalMs);
  const touch = () => { timers.clearTimeout(stall); stall = timers.setTimeout(() => abort('stall'), stallMs); };
  const aborted = () => (why === 'stall'
    ? new SdkError('stalled', `The download from ${host} stopped for ${Math.round(stallMs / 1000)} seconds. The network may be slow or block npm.`, url)
    : new SdkError('timeout', `The download from ${host} took longer than ${Math.round(totalMs / 60000)} minutes.`, url));
  try {
    let res;
    try { res = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { Accept: 'application/octet-stream' } }); }
    catch (e) { if (why) throw aborted(); throw describeError(e, { host, url }); }
    if (!res.ok) {
      const s = res.status;
      const reason = s === 401 || s === 403 ? `${host} refused the download (HTTP ${s}). npm may be blocked on this network, or the registry needs a login.`
        : s === 404 ? `${host} does not have this version of the Claude Agent SDK (HTTP 404).`
          : s === 407 ? 'The network proxy asked for a login (HTTP 407). Helm cannot sign in to proxies.'
            : s === 429 ? `${host} is limiting downloads right now (HTTP 429). Wait a minute and press Try again.`
              : `${host} answered HTTP ${s} instead of the file.`;
      throw new SdkError(s === 404 ? 'not_found' : s === 401 || s === 403 || s === 407 ? 'blocked' : 'http', reason, `HTTP ${s} ${res.statusText || ''} · ${url}`.replace(/\s+·/, ' ·'));
    }
    const len = Number(res.headers && res.headers.get && res.headers.get('content-length')) || null;
    if (len && len > maxBytes) throw new SdkError('too_large', `${host} offered a ${Math.round(len / 1048576)} MB file, far bigger than the SDK. Helm did not download it.`, url);
    const chunks = [];
    let received = 0, last = 0;
    onProgress({ received, total: len });
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) throw new SdkError('network', `${host} sent an empty answer.`, url);
    for (;;) {
      let r;
      try { r = await reader.read(); } catch (e) { if (why) throw aborted(); throw describeError(e, { host, url }); }
      if (r.done) break;
      const buf = Buffer.from(r.value);
      received += buf.length;
      if (received > maxBytes) { abort('size'); throw new SdkError('too_large', `The file from ${host} kept growing past ${Math.round(maxBytes / 1048576)} MB. Helm stopped the download.`, url); }
      chunks.push(buf);
      touch();
      const t = Date.now();
      if (t - last >= PROGRESS_MS) { last = t; onProgress({ received, total: len }); }
    }
    if (why) throw aborted();
    onProgress({ received, total: len || received });
    if (len && received !== len) throw new SdkError('network', `The download from ${host} ended early (${received} of ${len} bytes).`, url);
    return Buffer.concat(chunks, received);
  } finally {
    timers.clearTimeout(stall);
    timers.clearTimeout(total);
  }
}

// ---------- .tgz (ustar + pax + GNU long names) ----------
const cstr = (b, o, n) => { const s = b.subarray(o, o + n); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString('utf8'); };
function octal(b, o, n) {
  if (b[o] & 0x80) throw new SdkError('corrupt', 'The downloaded SDK archive is damaged.', 'tar: base-256 size field');
  const s = cstr(b, o, n).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new SdkError('corrupt', 'The downloaded SDK archive is damaged.', `tar: bad number "${s}"`);
  return parseInt(s, 8);
}
function parsePax(data) {
  const out = {};
  let i = 0;
  const s = data.toString('utf8');
  while (i < s.length) {
    const sp = s.indexOf(' ', i);
    if (sp < 0) break;
    const len = parseInt(s.slice(i, sp), 10);
    if (!(len > 0)) break;
    const rec = s.slice(sp + 1, i + len - 1); // without the trailing \n
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}
// tar bytes -> [{ path, type: 'file'|'dir'|'other', data }]
function readTar(buf) {
  const out = [];
  let off = 0, pax = null, gpax = {}, longName = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    let sum = 0;
    for (let k = 0; k < 512; k++) sum += k >= 148 && k < 156 ? 32 : h[k];
    if (sum !== octal(h, 148, 8)) throw new SdkError('corrupt', 'The downloaded SDK archive is damaged.', `tar: header checksum at byte ${off}`);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const ext = { ...gpax, ...(pax || {}) };
    const size = ext.size != null ? Number(ext.size) : octal(h, 124, 12);
    off += 512;
    if (!Number.isFinite(size) || size < 0 || off + size > buf.length) throw new SdkError('corrupt', 'The downloaded SDK archive is damaged.', `tar: entry runs past the end at byte ${off}`);
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = parsePax(data); continue; }
    if (type === 'g') { Object.assign(gpax, parsePax(data)); continue; }
    if (type === 'L') { longName = cstr(data, 0, data.length); continue; }
    const magic = cstr(h, 257, 6);
    const prefix = magic.startsWith('ustar') ? cstr(h, 345, 155) : '';
    const name = ext.path || longName || (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100));
    pax = null; longName = null;
    out.push({ path: name, type: type === '0' || type === '7' ? 'file' : type === '5' ? 'dir' : 'other', data });
  }
  return out;
}
// An entry path inside the package (npm tarballs put everything under one top folder, usually package/), or
// null to skip it. Throws on anything that could land outside the destination.
function safeRelative(p) {
  const segs = String(p).split(/[\\/]+/).filter((s) => s && s !== '.');
  if (/^[\\/]/.test(p) || segs.some((s) => s === '..' || s.includes(':'))) throw new SdkError('corrupt', 'The downloaded SDK archive has an unsafe file path, so Helm did not unpack it.', `tar: ${p}`);
  segs.shift();
  return segs.length ? segs : null;
}
function extractTgz(tgz, dest) {
  let tar;
  try { tar = zlib.gunzipSync(tgz); } catch (e) { throw new SdkError('corrupt', 'The downloaded SDK archive is damaged.', `gunzip: ${e.message}`); }
  const root = path.resolve(dest);
  let files = 0, skipped = 0;
  for (const ent of readTar(tar)) {
    const segs = safeRelative(ent.path);
    if (!segs) continue;
    if (ent.type === 'other') { skipped++; continue; } // links, devices: an npm package needs none
    const target = path.join(root, ...segs);
    if (!target.startsWith(root + path.sep)) throw new SdkError('corrupt', 'The downloaded SDK archive has an unsafe file path, so Helm did not unpack it.', `tar: ${ent.path}`);
    if (ent.type === 'dir') { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ent.data);
    files++;
  }
  return { files, skipped };
}

// ---------- the installed copy ----------
const pkgDirIn = (dir) => path.join(dir, 'node_modules', ...SDK_NAME.split('/'));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// The SDK's ESM entry file ("exports"."." default, else "main"), kept inside the package folder.
function entryOf(pkgDir, pj) {
  const ex = pj && pj.exports;
  const dot = ex && typeof ex === 'object' ? ex['.'] : ex;
  const rel = (typeof dot === 'string' ? dot : dot && (dot.import || dot.default)) || (pj && pj.main) || 'index.js';
  const file = path.resolve(pkgDir, rel);
  return file.startsWith(path.resolve(pkgDir) + path.sep) ? file : null;
}

// Is the pinned SDK installed under root? { ok, reason, dir, pkgDir, entry, entryUrl, version, marker }
function sdkStatus(root, pin) {
  const dir = path.join(root, 'installed');
  const pkgDir = pkgDirIn(dir);
  const base = { ok: false, dir, pkgDir, entry: null, entryUrl: null, version: null, marker: null };
  const marker = readJson(path.join(dir, MARKER));
  if (!marker) return { ...base, reason: 'not downloaded yet' };
  if (marker.name !== pin.name || marker.version !== pin.version || marker.integrity !== pin.integrity) return { ...base, marker, reason: `this Helm needs ${pin.version}; ${marker.version || 'another version'} is downloaded` };
  const pj = readJson(path.join(pkgDir, 'package.json'));
  if (!pj || pj.name !== pin.name || pj.version !== pin.version) return { ...base, marker, reason: 'the downloaded copy is incomplete' };
  const entry = entryOf(pkgDir, pj);
  let buf = null;
  try { buf = entry ? fs.readFileSync(entry) : null; } catch {}
  if (!buf) return { ...base, marker, reason: 'the downloaded copy is incomplete' };
  if (marker.entrySha256 && sha256hex(buf) !== marker.entrySha256) return { ...base, marker, reason: 'the downloaded copy was changed or damaged' };
  return { ok: true, reason: null, dir, pkgDir, entry, entryUrl: pathToFileURL(entry).href, version: pj.version, marker };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retryFs(fn, tries = 6) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) { if (i >= tries - 1 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e; await sleep(150 * (i + 1)); }
  }
}

/**
 * Make sure the pinned SDK is installed under root; download it when it isn't.
 * onProgress({ phase: 'downloading'|'verifying'|'unpacking'|'loading'|'ready', received, total, url, registry, source })
 * verify(entryUrl): optional extra check of a fresh copy (main.js imports it and looks for query()).
 * Resolves to sdkStatus() + { fetched, bytes, url }; rejects with an SdkError.
 */
async function ensureSdk({ pin, root = defaultSdkRoot(), registry = resolveRegistry(), fetch, onProgress = () => {}, verify = null, log = () => {}, downloadOpts = {} }) {
  const st = sdkStatus(root, pin);
  if (st.ok) return { ...st, fetched: false, bytes: 0, url: null };
  const url = tarballUrl(registry.url, pin);
  const host = (() => { try { return new URL(url).host; } catch { return 'the npm registry'; } })();
  log(`sdk: ${st.reason}; downloading ${pin.name}@${pin.version} from ${url} (registry from ${registry.source})`);
  const ctx = { url, registry: registry.url, source: registry.source, version: pin.version };
  onProgress({ ...ctx, phase: 'downloading', received: 0, total: null });
  const tgz = await download(url, { fetch, ...downloadOpts, onProgress: (p) => onProgress({ ...ctx, phase: 'downloading', ...p }) });
  onProgress({ ...ctx, phase: 'verifying', received: tgz.length, total: tgz.length });
  const want = sha512Of(pin.integrity);
  const got = sha512b64(tgz);
  if (got !== want) throw new SdkError('integrity', `The file from ${host} did not match the checksum this Helm expects, so Helm did not use it. A proxy or mirror may have changed it.`, `sha512 expected ${want.slice(0, 16)}… got ${got.slice(0, 16)}… · ${url}`);
  onProgress({ ...ctx, phase: 'unpacking', received: tgz.length, total: tgz.length });
  fs.mkdirSync(root, { recursive: true });
  const stage = path.join(root, `incoming-${process.pid}-${Date.now()}`);
  const live = path.join(root, 'installed');
  const old = path.join(root, 'previous');
  try {
    let unpacked;
    try {
      unpacked = extractTgz(tgz, pkgDirIn(stage));
      const pj = readJson(path.join(pkgDirIn(stage), 'package.json'));
      if (!pj || pj.name !== pin.name || pj.version !== pin.version) throw new SdkError('bad_package', 'The downloaded package is not the Claude Agent SDK version this Helm needs.', `package.json: ${pj ? `${pj.name}@${pj.version}` : 'missing'}`);
      const entry = entryOf(pkgDirIn(stage), pj);
      if (!entry || !fs.existsSync(entry)) throw new SdkError('bad_package', 'The downloaded Claude Agent SDK has no entry file.', String(entry));
      fs.writeFileSync(path.join(stage, MARKER), JSON.stringify({
        name: pin.name, version: pin.version, integrity: pin.integrity, url, registry: registry.url, bytes: tgz.length, files: unpacked.files,
        entrySha256: sha256hex(fs.readFileSync(entry)), fetchedAt: new Date().toISOString(),
      }, null, 2));
    } catch (e) { throw describeError(e, { host, url }); }
    try {
      fs.rmSync(old, { recursive: true, force: true });
      if (fs.existsSync(live)) await retryFs(() => fs.renameSync(live, old));
      await retryFs(() => fs.renameSync(stage, live));
    } catch (e) { throw describeError(e, { host, url }); }
    fs.rmSync(old, { recursive: true, force: true });
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
  }
  const done = sdkStatus(root, pin);
  if (!done.ok) throw new SdkError('bad_package', `The Claude Agent SDK was unpacked but Helm cannot find it (${done.reason}).`, done.dir);
  if (verify) {
    onProgress({ ...ctx, phase: 'loading', received: tgz.length, total: tgz.length });
    try { await verify(done.entryUrl); } catch (e) { throw new SdkError('import', 'The downloaded Claude Agent SDK did not load.', String((e && e.message) || e)); }
  }
  log(`sdk: ${pin.name}@${pin.version} ready in ${done.dir} (${tgz.length} bytes)`);
  onProgress({ ...ctx, phase: 'ready', received: tgz.length, total: tgz.length });
  return { ...done, fetched: true, bytes: tgz.length, url };
}

module.exports = {
  ensureSdk, sdkStatus, readPin, defaultSdkRoot, resolveRegistry, tarballUrl, download, extractTgz, readTar, describeError, sha512Of,
  SdkError, SDK_NAME, DEFAULT_REGISTRY, MARKER,
};
