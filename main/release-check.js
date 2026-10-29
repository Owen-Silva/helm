// Release check for INSTALLED builds (PROTOCOL "Restart + updates", UpdateState.release).
//
// An installed Helm has no git checkout, so main/update.js (new commit = update) has nothing to watch. Instead
// this asks GitHub Releases for the latest published release and compares its tag with the running version:
// newer = "a new version is available, download the installer" (Settings > Helm + the quiet chip). It never
// downloads or installs anything itself; the user runs the installer.
//
// No silent failures: every outcome is a phase the UI shows (checking, current, available, none, failed), and a
// failure carries one plain sentence (`reason`) plus the technical part (`detail`: HTTP status, error code).
// The last good `latest` survives a later failure, so a flaky network never hides a known update.
//
// Runs only in installed builds: main.js gates it (clone builds keep main/update.js) and passes Electron's
// net.fetch (follows the system proxy). Builtins only; fetch, timers and the clock are injected for tests.
// Owner: lane installer.

'use strict';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(s) {
  const m = SEMVER.exec(String(s == null ? '' : s).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
// -1 / 0 / 1, numeric per part (1.10.0 > 1.9.0)
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

// Network errors -> one plain sentence. Electron's net.fetch rejects with "net::ERR_..." in the message;
// Node's undici with TypeError("fetch failed") and the real code on `cause.code`.
function errorCode(e) {
  if (!e) return null;
  const c = (e.cause && e.cause.code) || e.code;
  if (c && typeof c === 'string') return c;
  const m = /net::(ERR_[A-Z0-9_]+)/.exec(String(e.message || ''));
  return m ? m[1] : null;
}
const NET_REASONS = [
  [/^(ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE|ENETUNREACH|ENETDOWN|EHOSTUNREACH)$/,
    'This computer looks offline, so Helm could not check for a new version.'],
  [/^(ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ENOTFOUND|EAI_AGAIN)$/,
    'Helm could not find GitHub (api.github.com did not resolve); check the internet connection.'],
  [/^(ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/,
    'GitHub did not answer in time, so Helm could not check for a new version.'],
  [/^(ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_AUTH_REQUESTED|ERR_MANDATORY_PROXY_CONFIGURATION_FAILED)$/,
    'Helm could not reach GitHub through the system proxy.'],
  [/^(ERR_CERT_|CERT_|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_SSL_)/,
    "GitHub's certificate could not be verified; a firewall or proxy may be intercepting the connection."],
  [/^(ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_EMPTY_RESPONSE|ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR_SOCKET)$/,
    'The connection to GitHub was refused or dropped, so Helm could not check for a new version.'],
];
function networkReason(code) {
  if (code) for (const [re, text] of NET_REASONS) if (re.test(code)) return text;
  return 'Helm could not reach GitHub to check for a new version.';
}
function errorDetail(e, code) {
  const msg = String((e && e.message) || e || 'unknown error');
  const cause = e && e.cause && e.cause.message && e.cause.message !== msg ? ` (${e.cause.message})` : '';
  return code && !msg.includes(code) && !cause.includes(code) ? `${code}: ${msg}${cause}` : `${msg}${cause}`;
}

function header(res, name) {
  try { return res && res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null; } catch { return null; }
}

function createReleaseCheck({
  repo = 'Owen-Silva/helm', current, asset = 'Helm-Setup.exe', fetch, log = () => {}, onChange = () => {},
  now = Date.now, timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  intervalMs = 6 * 3600e3, startDelayMs = 20e3, timeoutMs = 20e3,
} = {}) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const cur = parseVersion(current);
  let s = { phase: 'idle', checkedAt: null, latest: null, reason: null, detail: null };
  let inflight = null, startTimer = null, everyTimer = null;

  const state = () => ({ mode: 'installer', current, phase: s.phase, checkedAt: s.checkedAt,
    latest: s.latest ? { ...s.latest } : null, reason: s.reason, detail: s.detail });
  function set(next) {
    s = { ...s, ...next };
    try { onChange(state()); } catch (e) { log(`release-check: onChange threw: ${e && e.message}`); }
  }
  // a failure keeps the last good `latest` (no `latest` key here)
  const fail = (reason, detail) => {
    log(`release-check: failed: ${reason}${detail ? ` [${detail}]` : ''}`);
    set({ phase: 'failed', checkedAt: now(), reason, detail: detail || null });
  };

  // GitHub's rate limit (60/h per IP unauthenticated): 429, or 403 with x-ratelimit-remaining: 0 / retry-after.
  function rateLimitReason(res) {
    const resetSec = Number(header(res, 'x-ratelimit-reset'));
    const retrySec = Number(header(res, 'retry-after'));
    const waitMs = retrySec > 0 ? retrySec * 1000 : resetSec > 0 ? resetSec * 1000 - now() : 0;
    if (waitMs <= 0) return "GitHub's limit on update checks was reached; Helm tries again later.";
    const min = Math.max(1, Math.ceil(waitMs / 60e3));
    return `GitHub's limit on update checks was reached; Helm can check again in about ${min} minute${min === 1 ? '' : 's'}.`;
  }

  async function run() {
    if (!cur) return fail(`This build's own version ("${current}") is not a version number, so Helm cannot compare it with a release.`, `current=${JSON.stringify(current)}`);
    if (typeof fetch !== 'function') return fail('Helm has no way to reach the network here, so it cannot check for a new version.', 'no fetch');
    set({ phase: 'checking' });
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const t = unref(timers.setTimeout(() => { timedOut = true; if (ctl) ctl.abort(); }, timeoutMs));
    let res, text;
    try {
      res = await fetch(url, {
        method: 'GET', signal: ctl ? ctl.signal : undefined,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Helm/${current}`, 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (res.status === 200) text = await res.text();
    } catch (e) {
      timers.clearTimeout(t);
      if (timedOut) return fail(`GitHub did not answer within ${Math.round(timeoutMs / 1000)} seconds, so Helm could not check for a new version.`, `timed out after ${timeoutMs} ms`);
      const code = errorCode(e);
      return fail(networkReason(code), errorDetail(e, code));
    }
    timers.clearTimeout(t);

    const st = res.status;
    if (st === 404) {
      log('release-check: no release published (404)');
      return set({ phase: 'none', checkedAt: now(), latest: null, reason: 'No release of Helm has been published yet.', detail: null });
    }
    if (st === 429 || (st === 403 && (header(res, 'x-ratelimit-remaining') === '0' || header(res, 'retry-after'))))
      return fail(rateLimitReason(res), `HTTP ${st}${header(res, 'x-ratelimit-reset') ? `, x-ratelimit-reset ${header(res, 'x-ratelimit-reset')}` : ''}`);
    if (st >= 500) return fail('GitHub is having trouble right now, so Helm could not check for a new version.', `HTTP ${st}`);
    if (st !== 200) return fail(`GitHub refused the update check (HTTP ${st}).`, `HTTP ${st}${res.statusText ? ` ${res.statusText}` : ''}`);

    let body;
    try { body = JSON.parse(text); } catch (e) {
      return fail("GitHub's answer could not be read, so Helm could not check for a new version.", `bad JSON: ${e.message}`);
    }
    if (!body || typeof body !== 'object' || typeof body.tag_name !== 'string')
      return fail("GitHub's answer did not name a version, so Helm could not check for a new version.", 'no tag_name in the release');
    const tag = body.tag_name;
    const ver = parseVersion(tag);
    if (!ver) return fail(`The latest release is tagged "${tag}", which is not a version number Helm can compare.`, `tag_name ${JSON.stringify(tag)}`);

    const want = String(asset).toLowerCase();
    const a = Array.isArray(body.assets) ? body.assets.find((x) => x && String(x.name).toLowerCase() === want) : null;
    const latest = {
      version: ver.join('.'), tag, name: body.name || tag,
      url: body.html_url || `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
      download: (a && a.browser_download_url) || null, publishedAt: body.published_at || null,
    };
    const newer = compareVersions(ver, cur) > 0;
    if (newer && !latest.download) log(`release-check: ${tag} has no ${asset} asset; linking the release page`);
    set({ phase: newer ? 'available' : 'current', checkedAt: now(), latest, reason: null, detail: null });
  }

  // one check at a time: concurrent callers share it (also one made from onChange mid-check); never rejects
  function check() {
    if (!inflight) {
      inflight = Promise.resolve().then(run)
        .catch((e) => fail('The update check stopped on an unexpected error.', String((e && e.stack) || e)))
        .then(() => { inflight = null; return state(); });
    }
    return inflight;
  }
  const unref = (h) => { if (h && typeof h.unref === 'function') h.unref(); return h; };
  function start() {
    if (startTimer || everyTimer) return;
    startTimer = unref(timers.setTimeout(() => {
      startTimer = null;
      check();
      everyTimer = unref(timers.setInterval(check, intervalMs));
    }, startDelayMs));
  }
  function stop() {
    if (startTimer) timers.clearTimeout(startTimer);
    if (everyTimer) timers.clearInterval(everyTimer);
    startTimer = everyTimer = null;
  }
  return { start, stop, check, state };
}

module.exports = { createReleaseCheck, parseVersion, compareVersions };
