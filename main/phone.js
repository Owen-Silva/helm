// Phone health: everything that decides whether Helm opens on the user's phone, checked from the PC
// so Settings -> Phone can say what is wrong and the exact fix (PROTOCOL `phone.status`).
//   - Tailscale up? (an address in 100.64.0.0/10 + `tailscale status --json` BackendState)
//   - bound on that address, on 4871 (a busy 4871 makes the server fall back to a random port,
//     which the firewall rule does not cover; who holds 4871 comes from Get-NetTCPConnection)
//   - Windows Firewall rule "Helm (Tailscale)" (bin/firewall.ps1, elevated once; reading it needs no admin)
//   - HTTPS certificates on the tailnet (CertDomains): without them the page is plain http, so no
//     service worker, no Web Push, no clipboard write, no real install on Android
//   - has a phone actually reached Helm over Tailscale (the best proof the firewall lets it in)
// Slow probes (PowerShell ~2-6 s, tailscale ~0.3 s) are cached for 60 s; `refresh` skips the cache.
// Owner: lane phone.
const path = require('path');
const { execFile } = require('child_process');
const { isTailscaleIp } = require('./net');

const RULE_NAME = 'Helm (Tailscale)';
const EXPECTED_PORT = 4871;
const CACHE_MS = 60_000;

// one process start per event-loop turn: see main/start-turn.js
const { nextStartTurn } = require('./start-turn');

function runFile(file, args, { timeout = 15000 } = {}) {
  return nextStartTurn().then(() => new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) => {
      resolve({ ok: !e, code: e ? (e.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: e ? e.message : null });
    });
  }));
}

function powershell(script, run = runFile) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 20000 });
}

// One line out: PRESENT|<Enabled>|<Action>|<Direction>|<LocalPort>, MISSING, or ERROR|<message>.
const FIREWALL_PS = `$ErrorActionPreference='Stop'
try {
  $r = Get-NetFirewallRule -DisplayName '${RULE_NAME}' | Select-Object -First 1
  $p = $r | Get-NetFirewallPortFilter
  'PRESENT|{0}|{1}|{2}|{3}' -f $r.Enabled, $r.Action, $r.Direction, (@($p.LocalPort) -join ',')
} catch {
  if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { 'MISSING' } else { 'ERROR|' + $_.Exception.Message }
}`;

// -> { state: 'present'|'missing'|'unknown', detail }
function parseFirewall(out, expectedPort = EXPECTED_PORT) {
  const line = String(out || '').split(/\r?\n/).map((l) => l.trim()).find((l) => /^(PRESENT|MISSING|ERROR)\b/.test(l));
  if (!line) return { state: 'unknown', detail: 'could not read the firewall rules' };
  if (line === 'MISSING') return { state: 'missing', detail: `no rule named "${RULE_NAME}"` };
  if (line.startsWith('ERROR|')) return { state: 'unknown', detail: line.slice(6) || 'could not read the firewall rules' };
  const [, enabled, action, direction, ports] = line.split('|');
  const problems = [];
  if (!/^true$/i.test(enabled)) problems.push('the rule is disabled');
  if (!/^allow$/i.test(action)) problems.push(`the rule's action is ${action || 'unknown'}, not Allow`);
  if (!/^inbound$/i.test(direction)) problems.push(`the rule is ${direction || 'not'} inbound`);
  const portList = String(ports || '').split(',').map((s) => s.trim());
  if (!portList.includes(String(expectedPort)) && !portList.includes('Any')) problems.push(`the rule opens port ${ports || 'none'}, not ${expectedPort}`);
  return problems.length ? { state: 'missing', detail: problems.join('; ') } : { state: 'present', detail: `allows TCP ${expectedPort} inbound from the tailnet` };
}

// Who is listening on a port: PID|ProcessName lines.
const portOwnerPs = (port) => `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { '{0}|{1}' -f $_.OwningProcess, (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName }`;
function parsePortOwner(out) {
  const line = String(out || '').split(/\r?\n/).map((l) => l.trim()).find((l) => /^\d+\|/.test(l));
  if (!line) return null;
  const [pid, name] = line.split('|');
  return { pid: Number(pid), name: name || null };
}

// `tailscale status --json` -> the fields phone health needs (or null when the CLI isn't there).
function parseTailscaleStatus(json) {
  let j;
  try { j = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const self = j.Self || {};
  const certs = Array.isArray(j.CertDomains) ? j.CertDomains.filter(Boolean) : [];
  const phones = Object.values(j.Peer || {})
    .filter((p) => p && /^(android|ios)$/i.test(p.OS || ''))
    .map((p) => ({ name: p.HostName || (p.DNSName || '').split('.')[0] || 'phone', os: String(p.OS).toLowerCase(), online: !!p.Online }));
  return {
    backendState: j.BackendState || null,
    dnsName: self.DNSName ? String(self.DNSName).replace(/\.$/, '') : null,
    magicDns: !!(j.CurrentTailnet && j.CurrentTailnet.MagicDNSEnabled),
    certDomains: certs,
    phones,
  };
}

function tailscaleCandidates() {
  return ['tailscale', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')];
}

/**
 * createPhoneHealth({ getServer, getSettings, getTailscaleIp, emit?, expectedPort?, run?, platform?, now?, log? })
 *   emit(event, data): the host event hub; the busy-4871 notice goes out as one `notify` (kind info)
 *     when the first client connects (nobody is listening at boot)
 *   getServer(): the startServer() handle ({ port, hosts, portFellBack }) or null before it listens
 *   getTailscaleIp({ fresh }): this PC's Tailscale IPv4 (net.tailscaleIPv4; main.js reuses a reading under 65 s old
 *     unless fresh, which status({ refresh: true }) asks for), or null
 *   run(file, args, opts) -> { ok, stdout, stderr }: injectable for tests (default execFile)
 * -> { status({ refresh }), onClient(client, state), fallbackNotice() }
 */
function createPhoneHealth({ getServer, getSettings, getTailscaleIp, emit = null, expectedPort = EXPECTED_PORT, run = runFile, platform = process.platform, now = Date.now, log = () => {} }) {
  const cache = new Map(); // key -> { at, value, pending }
  let lastPhone = null;    // { at, remote } the last client that reached Helm from a Tailscale address
  let fallbackNoticed = false;

  function cached(key, fn, refresh) {
    const c = cache.get(key);
    if (c && c.pending) return c.pending;
    if (!refresh && c && now() - c.at < CACHE_MS) return Promise.resolve(c.value);
    const pending = Promise.resolve().then(fn).catch((e) => { log(`phone ${key}:`, e && e.message ? e.message : e); return null; })
      .then((value) => { cache.set(key, { at: now(), value }); return value; });
    cache.set(key, { ...(c || {}), pending });
    return pending;
  }

  async function firewall() {
    if (platform !== 'win32') return { state: 'unknown', detail: 'only checked on Windows' };
    const r = await powershell(FIREWALL_PS, run);
    if (!r.ok && !r.stdout.trim()) return { state: 'unknown', detail: (r.stderr || r.error || 'PowerShell failed').trim().split(/\r?\n/)[0] };
    return parseFirewall(r.stdout, expectedPort);
  }

  async function tailscale() {
    for (const exe of tailscaleCandidates()) {
      const r = await run(exe, ['status', '--json'], { timeout: 5000 });
      if (r.ok && r.stdout.trim()) return parseTailscaleStatus(r.stdout);
    }
    return null;
  }

  async function portOwner() {
    if (platform !== 'win32') return null;
    const r = await powershell(portOwnerPs(expectedPort), run);
    return parsePortOwner(r.stdout);
  }

  async function status({ refresh = false } = {}) {
    const server = getServer();
    const s = (getSettings && getSettings()) || {};
    const phone = s.phone || {};
    const ip = getTailscaleIp({ fresh: refresh });
    const port = server ? server.port : null;
    const portIsFallback = !!(server && server.portFellBack);
    const [fw, ts, owner] = await Promise.all([
      cached('firewall', firewall, refresh),
      cached('tailscale', tailscale, refresh),
      portIsFallback ? cached('portOwner', portOwner, refresh) : Promise.resolve(null),
    ]);
    const bound = server ? (server.hosts || []).slice() : [];
    const backend = ts ? ts.backendState : null;
    return {
      enabled: phone.enabled !== false,
      tailscaleUp: !!ip && (backend == null || backend === 'Running'),
      tailscaleIp: ip,
      tailscaleState: backend,
      boundAddresses: bound,
      boundOnTailscale: bound.some(isTailscaleIp),
      port,
      expectedPort,
      portIsFallback,
      portOwner: owner,
      firewallRule: fw ? fw.state : 'unknown',
      firewallDetail: fw ? fw.detail : 'could not read the firewall rules',
      firewallRuleName: RULE_NAME,
      httpsAvailable: !!(ts && ts.certDomains.length),
      certDomains: ts ? ts.certDomains : [],
      magicDnsName: (ts && ts.dnsName) || null,
      phones: ts ? ts.phones : [],
      phoneClientsNow: server && server.clients ? [...server.clients].filter((c) => isTailscaleIp(String(c.remote || '').replace(/^::ffff:/, ''))).length : 0,
      lastPhoneAt: lastPhone ? lastPhone.at : null,
      lastPhoneRemote: lastPhone ? lastPhone.remote : null,
      url: phone.url || null,
      checkedAt: now(),
    };
  }

  // server onClient hook: remember the last client that came in over Tailscale (a phone, usually).
  function onClient(client, state) {
    if (!client || state !== 'open') return;
    if (emit && !fallbackNoticed && getServer() && getServer().portFellBack) {
      fallbackNotice().then((n) => { if (n) emit('notify', n); }, (e) => log('phone fallback notice', e));
    }
    const remote = String(client.remote || '').replace(/^::ffff:/, '');
    if (isTailscaleIp(remote)) lastPhone = { at: now(), remote };
  }

  // The one-time notice for a busy 4871 ({ title, body, kind: 'info' }), or null.
  async function fallbackNotice() {
    const server = getServer();
    if (fallbackNoticed || !server || !server.portFellBack) return null;
    fallbackNoticed = true;
    const owner = await cached('portOwner', portOwner, false);
    const who = owner ? `${owner.name || 'another program'} (PID ${owner.pid})` : 'another program';
    return {
      title: `Port ${expectedPort} was busy`,
      body: `${who} is using ${expectedPort}, so Helm is on ${server.port} this time. The phone link and firewall rule expect ${expectedPort}: close that program and restart Helm. Details in Settings, Phone.`,
      kind: 'info',
    };
  }

  return { status, onClient, fallbackNotice };
}

module.exports = { createPhoneHealth, parseFirewall, parsePortOwner, parseTailscaleStatus, runFile, tailscaleCandidates, FIREWALL_PS, RULE_NAME, EXPECTED_PORT, CACHE_MS };
