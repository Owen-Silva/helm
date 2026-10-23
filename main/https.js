// Tailnet HTTPS for the phone page (PROTOCOL "Phone over HTTPS").
// `tailscale serve` terminates TLS with the tailnet's own Let's Encrypt certificate (CertDomains) and
// proxies https://<MagicDNS name>/ to Helm's loopback listener (http://127.0.0.1:<port>). Tailscale
// issues and renews the certificate; Helm never holds a private key. Tailnet only: Helm never runs
// `tailscale funnel`, and refuses to call a setup "live" if Funnel is on for its port.
//  - reads `tailscale serve status --json` BEFORE any change and never replaces a handler it did not
//    make: it takes 443, else 8443, whichever is completely unused; the undo is `tailscale serve --https=<p> off`
//  - after a change it re-reads the config and checks every handler that was there before is still there
//  - status() also probes https://<name>[:p]/manifest.webmanifest from this PC (the real certificate
//    and the proxy end to end) so Settings, Phone can say "live" from evidence, not from config alone
// The proxy's requests reach main/server.js from 127.0.0.1 with X-Forwarded-* headers: server.js
// still demands the cookie, never treats them as the desktop window, and logs the real phone address.
// Owner: lane https.
const https = require('https');
const { runFile, tailscaleCandidates, parseTailscaleStatus } = require('./phone');

const PORTS = [443, 8443];
const PROBE_PATH = '/manifest.webmanifest';

// `tailscale serve status --json` -> the ServeConfig object ({} when nothing is served), or null if unreadable.
function parseServe(text) {
  const t = String(text || '').trim();
  if (!t || /^no serve config/i.test(t)) return {};
  try { const j = JSON.parse(t); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

const loopbackTarget = (proxy, localPort) => {
  const m = /^https?:\/\/(127\.0\.0\.1|localhost)(?::(\d+))?\/?$/i.exec(String(proxy || '').trim());
  return !!m && Number(m[2] || 80) === Number(localPort);
};

// The web handlers configured for one port: [{ mount, proxy|text|path }] across every host:port key.
function webOnPort(cfg, port) {
  const out = [];
  for (const [hp, web] of Object.entries((cfg && cfg.Web) || {})) {
    if (!hp.endsWith(`:${port}`)) continue;
    for (const [mount, h] of Object.entries((web && web.Handlers) || {})) out.push({ host: hp, mount, proxy: h && h.Proxy, text: h && h.Text, path: h && h.Path });
  }
  return out;
}

// Helm's own handler: an HTTPS port whose only "/" handler on <domain> proxies to 127.0.0.1:<localPort>.
function helmHandler(cfg, domain, localPort) {
  if (!cfg || !domain) return null;
  for (const [p, tcp] of Object.entries(cfg.TCP || {})) {
    if (!tcp || !tcp.HTTPS) continue;
    const web = (cfg.Web || {})[`${domain}:${p}`];
    const root = web && web.Handlers && web.Handlers['/'];
    if (root && loopbackTarget(root.Proxy, localPort)) return { port: Number(p), proxy: root.Proxy, funnel: !!(cfg.AllowFunnel && cfg.AllowFunnel[`${domain}:${p}`]) };
  }
  return null;
}

// What already uses a port (TCP forwarder, http or https web handlers), as a short description, or null if free.
function portUse(cfg, port) {
  const tcp = cfg && cfg.TCP && cfg.TCP[String(port)];
  const web = webOnPort(cfg, port);
  if (!tcp && !web.length) return null;
  if (web.length) return web.map((w) => `${w.mount} -> ${w.proxy || (w.path ? 'files' : w.text != null ? 'text' : 'a handler')}`).join(', ');
  if (tcp.TCPForward) return `TCP -> ${tcp.TCPForward}`;
  return tcp.HTTPS ? 'an https listener' : tcp.HTTP ? 'an http listener' : 'a listener';
}

// Every handler as a "host:port mount" string (to prove a change kept everything else).
function handlerKeys(cfg) {
  const keys = [];
  for (const [hp, web] of Object.entries((cfg && cfg.Web) || {})) for (const mount of Object.keys((web && web.Handlers) || {})) keys.push(`${hp} ${mount}`);
  for (const [p, tcp] of Object.entries((cfg && cfg.TCP) || {})) if (tcp && tcp.TCPForward) keys.push(`tcp:${p} ${tcp.TCPForward}`);
  return keys.sort();
}

const httpsUrl = (domain, port) => `https://${domain}${Number(port) === 443 ? '' : `:${port}`}`;
const undoCmd = (port) => `tailscale serve --https=${port} off`;

// GET https://<domain>[:port]/manifest.webmanifest with normal certificate checks -> { ok, status?, error? }.
// The first request after certs are enabled makes tailscaled fetch the certificate (10-30 s), hence the long timeout.
function probeHttps(url, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      const req = https.get(url + PROBE_PATH, { timeout, headers: { 'user-agent': 'Helm https self-check' } }, (res) => {
        res.resume();
        finish(res.statusCode === 200 ? { ok: true, status: 200 } : { ok: false, status: res.statusCode, error: `answered ${res.statusCode}` });
      });
      req.on('timeout', () => { req.destroy(); finish({ ok: false, error: `no answer within ${Math.round(timeout / 1000)} s` }); });
      req.on('error', (e) => finish({ ok: false, error: e.code ? `${e.code}: ${e.message}` : e.message }));
    } catch (e) { finish({ ok: false, error: e.message }); }
  });
}

function err(message, code) { return Object.assign(new Error(message), { code }); }

/**
 * createTailnetHttps({ getLocalPort, run?, probe?, ports?, allowChange?, log?, now? })
 *   getLocalPort(): the port Helm's loopback listener is on (server.port)
 *   run(file, args, opts) -> { ok, stdout, stderr, error }: injectable for tests (default execFile)
 *   probe(url) -> { ok, status?, error? }: injectable for tests (default a real https GET)
 *   allowChange: false in a --test run unless it names its own port (--test-https-port): never touch
 *     The user's serve config from a test
 * -> { refresh(), status({ probe }), enable(), disable(), last(), names() }
 */
function createTailnetHttps({ getLocalPort, run = runFile, probe = probeHttps, ports = PORTS, allowChange = true, log = () => {}, now = Date.now }) {
  let exe = null;      // the tailscale CLI that answered last
  let state = null;    // the last refresh() result
  let lastProbe = null; // { at, url, ok, status?, error? }
  let busy = null;     // the in-flight enable/disable

  async function ts(args, timeout = 15000) {
    const list = exe ? [exe, ...tailscaleCandidates().filter((c) => c !== exe)] : tailscaleCandidates();
    let last = null;
    for (const file of list) {
      const r = await run(file, args, { timeout });
      if (r.ok || (r.stdout || r.stderr)) { exe = file; return r; }
      last = r;
    }
    return last || { ok: false, stdout: '', stderr: '', error: 'tailscale not found' };
  }

  async function refresh() {
    const localPort = getLocalPort();
    const st = await ts(['status', '--json'], 5000);
    const tsInfo = st.ok ? parseTailscaleStatus(st.stdout) : null;
    const base = { localPort, checkedAt: now(), canChange: !!allowChange && ports.length > 0 };
    if (!tsInfo) return (state = { ...base, state: 'unknown', certs: false, domain: null, detail: `Could not run tailscale status (${firstLine(st.stderr || st.error) || 'no output'}).` });
    const domain = tsInfo.certDomains[0] || null;
    if (tsInfo.backendState && tsInfo.backendState !== 'Running') return (state = { ...base, state: 'tailscale-down', certs: !!domain, domain, detail: `Tailscale reports "${tsInfo.backendState}".` });
    if (!domain) return (state = { ...base, state: 'no-certs', certs: false, domain: null, magicDnsName: tsInfo.dnsName, detail: 'Your tailnet has no HTTPS certificates.' });
    const sv = await ts(['serve', 'status', '--json'], 8000);
    const cfg = sv.ok ? parseServe(sv.stdout) : null;
    if (!cfg) return (state = { ...base, state: 'unknown', certs: true, domain, detail: `Could not read tailscale serve status (${firstLine(sv.stderr || sv.error) || 'unreadable output'}).` });
    const mine = helmHandler(cfg, domain, localPort);
    const others = handlerKeys(cfg).length - (mine ? 1 : 0);
    if (mine) {
      const url = httpsUrl(domain, mine.port);
      if (mine.funnel) return (state = { ...base, state: 'funnel', certs: true, domain, httpsPort: mine.port, url, undo: undoCmd(mine.port), otherHandlers: others, detail: `Tailscale Funnel is ON for port ${mine.port}: Helm would be on the public internet. Turn Funnel off for it (tailscale funnel --https=${mine.port} off).` });
      return (state = { ...base, state: 'live', certs: true, domain, httpsPort: mine.port, url, undo: undoCmd(mine.port), otherHandlers: others, target: mine.proxy, detail: `tailscale serve proxies ${url} to ${mine.proxy}.` });
    }
    const free = ports.find((p) => !portUse(cfg, p));
    const taken = ports.filter((p) => portUse(cfg, p)).map((p) => `${p}: ${portUse(cfg, p)}`);
    if (free == null && ports.length) return (state = { ...base, state: 'busy', certs: true, domain, otherHandlers: others, detail: `tailscale serve already uses ${taken.join('; ')}. Helm will not replace a handler it did not make.` });
    return (state = { ...base, state: 'off', certs: true, domain, nextPort: free ?? null, otherHandlers: others, taken, detail: 'Certificates are on, but Helm is not served over HTTPS yet.' });
  }

  // probe: run the end-to-end https self-check (reused for 60 s unless force)
  async function status({ probe: doProbe = false, force = false } = {}) {
    const s = await refresh();
    const fresh = lastProbe && lastProbe.url === s.url && now() - lastProbe.at < 60_000;
    if (doProbe && s.state === 'live' && (force || !fresh)) {
      const r = await probe(s.url);
      lastProbe = { at: now(), url: s.url, ...r };
      if (!r.ok) log(`https self-check ${s.url}: ${r.error || r.status}`);
    }
    const p = lastProbe && state && lastProbe.url === state.url ? lastProbe : null;
    return { ...s, probe: p };
  }

  async function change(fn) {
    if (busy) return busy;
    busy = Promise.resolve().then(fn).finally(() => { busy = null; });
    return busy;
  }

  function enable() {
    return change(async () => {
      if (!allowChange || !ports.length) throw err('This Helm is a test run: it never changes tailscale serve (start it with --test-https-port to allow one port).', 'unsupported');
      const before = await refresh();
      if (before.state === 'live') return status({ probe: true, force: true });
      if (before.state === 'no-certs') throw err('Your tailnet has no HTTPS certificates yet: Tailscale admin console, DNS, HTTPS Certificates, Enable.', 'no_certs');
      if (before.state !== 'off') throw err(before.detail || `HTTPS cannot be set up (${before.state}).`, before.state === 'busy' ? 'busy' : 'unavailable');
      const sv = await ts(['serve', 'status', '--json'], 8000);
      const cfg = parseServe(sv.stdout);
      if (!cfg) throw err('Could not read tailscale serve status, so Helm did not change it.', 'unavailable');
      const kept = handlerKeys(cfg);
      const port = before.nextPort;
      const target = `http://127.0.0.1:${before.localPort}`;
      log(`https: tailscale serve --bg --https=${port} ${target} (keeps ${kept.length} other handler${kept.length === 1 ? '' : 's'})`);
      const r = await ts(['serve', '--bg', '--yes', `--https=${port}`, target], 30000);
      if (!r.ok) throw err(`tailscale serve failed: ${firstLine(r.stderr || r.stdout || r.error) || 'no output'}`, 'failed');
      const after = await ts(['serve', 'status', '--json'], 8000);
      const cfg2 = parseServe(after.stdout);
      const lost = cfg2 ? kept.filter((k) => !handlerKeys(cfg2).includes(k)) : kept;
      if (lost.length) { log(`https: after the change these handlers are gone: ${lost.join(', ')}`); throw err(`tailscale serve dropped existing handlers (${lost.join(', ')}). Check tailscale serve status.`, 'failed'); }
      const s = await status({ probe: true, force: true });
      if (s.state !== 'live') throw err(`tailscale serve accepted the change, but Helm's handler is not in its config (${s.detail}).`, 'failed');
      return s;
    });
  }

  function disable() {
    return change(async () => {
      if (!allowChange || !ports.length) throw err('This Helm is a test run: it never changes tailscale serve.', 'unsupported');
      const before = await refresh();
      if (before.state !== 'live' && before.state !== 'funnel') return status();
      const sv = await ts(['serve', 'status', '--json'], 8000);
      const kept = handlerKeys(parseServe(sv.stdout) || {}).filter((k) => !k.startsWith(`${before.domain}:${before.httpsPort} `));
      log(`https: ${undoCmd(before.httpsPort)}`);
      const r = await ts(['serve', '--yes', `--https=${before.httpsPort}`, 'off'], 20000);
      if (!r.ok) throw err(`tailscale serve off failed: ${firstLine(r.stderr || r.stdout || r.error) || 'no output'}`, 'failed');
      const after = await ts(['serve', 'status', '--json'], 8000);
      const cfg2 = parseServe(after.stdout) || {};
      const lost = kept.filter((k) => !handlerKeys(cfg2).includes(k));
      if (lost.length) log(`https: after turning off, these handlers are gone: ${lost.join(', ')}`);
      lastProbe = null;
      return status();
    });
  }

  return {
    refresh, status, enable, disable,
    last: () => state,
    // MagicDNS names this PC is reached by over HTTPS (the server's Host guard allow-list)
    names: () => (state && state.domain ? [state.domain] : []),
  };
}

function firstLine(s) { return String(s || '').trim().split(/\r?\n/)[0].slice(0, 200); }

module.exports = { createTailnetHttps, parseServe, helmHandler, portUse, handlerKeys, httpsUrl, undoCmd, probeHttps, PORTS };
