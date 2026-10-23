// Railway panel (lane railway, 2026-10-08): live deploy status for every Railway project on the user's
// account, plus Redeploy / Restart behind a confirm (PROTOCOL "Railway").
//
// Auth: everything goes through the user's own Railway CLI. `railway api` (CLI 5.41+) runs a GraphQL
// document against backboard.railway.com with the CLI's own sign-in and refreshes that sign-in itself,
// so Helm needs no setup, never reads ~/.railway/config.json and never holds a token. A PC without the
// CLI, or a signed-out CLI, shows that state with its reason ("run `railway login`"). The CLI also
// honours RAILWAY_API_TOKEN, so an account token in the environment works with no Helm change.
//
// Projects = me.workspaces[].projects UNION me.projects (deduped by id): `railway list` does the same,
// and a project shared into the user's account from another workspace only shows up in me.projects.
//
// Polling is lease-based: the UI renews a lease with railway.status { watch: 'panel' | 'chip' } while
// the panel or the Home chip is on screen and the window is visible. No lease = no polling at all.
//   anything building/deploying (or an action in flight)  every 10 s
//   panel open                                            every 30 s
//   Home chip only                                        every 3 min
//   errors: 30 s, 1, 2, 4 ... up to 10 min; rate-limited: at least 5 min
// One CLI process at a time (a token refresh rewrites the CLI's config file; two at once could race).
//
// Actions (railway.redeploy / railway.restart) need { confirm: true } (the UI sends it only from the
// confirm dialog) and the deploymentId the user saw; a snapshot older than 20 s is refreshed first and a
// changed deployment is refused as stale. Redeploy = deploymentRedeploy(latest deployment); Restart =
// deploymentRestart(the running deployment). A --test run never touches a real Railway project: it is
// off unless HELM_RAILWAY_CLI names a fake CLI script (.js), or HELM_RAILWAY_LIVE=1 allows read-only status.
//
// Every error string passes redact(): tokens, JWTs, long secrets, UUIDs, emails and user paths are cut.
// Owner: lane railway.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: realSpawn, execFile } = require('child_process');

const BUSY_MS = 10_000;
const PANEL_MS = 30_000;
const CHIP_MS = 3 * 60_000;
const ERR_BASE_MS = 30_000;
const ERR_MAX_MS = 10 * 60_000;
const RATE_MS = 5 * 60_000;
const LEASE_MS = { panel: 75_000, chip: 6 * 60_000 };
const STATUS_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 45_000;
const ACTION_FRESH_MS = 20_000;     // older snapshot -> refresh before acting
const MANUAL_MIN_MS = 5_000;        // a manual refresh within 5 s of the last check reuses it
const SETTLED_KEEP_MS = 90_000;     // a finished action's result stays visible this long
const REDEPLOY_GIVEUP_MS = 20 * 60_000;
const RESTART_FAST_MS = 60_000;     // fast polls after a restart
const MAX_OUT = 5 * 1024 * 1024;

const STATUS_QUERY = `query HelmRailwayStatus {
  me {
    workspaces { projects { edges { node { ...HelmProject } } } }
    projects { edges { node { ...HelmProject } } }
  }
}
fragment HelmDeploy on Deployment { id status createdAt statusUpdatedAt deploymentStopped canRedeploy }
fragment HelmProject on Project {
  id name deletedAt
  environments { edges { node { id name
    serviceInstances { edges { node {
      serviceId serviceName deletedAt
      latestDeployment { ...HelmDeploy }
      activeDeployments { ...HelmDeploy }
    } } }
  } } }
}`;
const REDEPLOY_MUTATION = 'mutation HelmRailwayRedeploy($id: String!) { deploymentRedeploy(id: $id) { id status } }';
const RESTART_MUTATION = 'mutation HelmRailwayRestart($id: String!) { deploymentRestart(id: $id) }';

// ---------- status mapping ----------
// Railway DeploymentStatus -> Helm's fixed set. tone: busy (amber), bad (red), ok / idle (neutral).
const STATUS_MAP = {
  SUCCESS: 'live', BUILDING: 'building', DEPLOYING: 'deploying',
  INITIALIZING: 'queued', QUEUED: 'queued', WAITING: 'queued', NEEDS_APPROVAL: 'queued',
  FAILED: 'failed', CRASHED: 'crashed', SLEEPING: 'sleeping',
  REMOVED: 'removed', REMOVING: 'removed', SKIPPED: 'skipped',
};
const TONE = { live: 'ok', building: 'busy', deploying: 'busy', queued: 'busy', failed: 'bad', crashed: 'bad', sleeping: 'idle', stopped: 'idle', removed: 'idle', skipped: 'idle', none: 'idle', unknown: 'idle' };
const BUSY = new Set(['building', 'deploying', 'queued']);
const RESTARTABLE = new Set(['SUCCESS', 'CRASHED', 'SLEEPING']);

function mapStatus(raw, { stopped = false } = {}) {
  if (raw == null || raw === '') return 'none';
  const s = STATUS_MAP[String(raw).toUpperCase()];
  if (!s) return 'unknown';
  return s === 'live' && stopped ? 'stopped' : s;
}
const toneOf = (status) => TONE[status] || 'idle';
const isBusy = (status) => BUSY.has(status);

// ---------- redaction ----------
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
function redact(text, secrets = []) {
  let s = text == null ? '' : String(text);
  for (const v of secrets) if (v && String(v).length >= 6) s = s.split(String(v)).join('[redacted]');
  s = s
    .replace(/eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, '[token]')                                   // JWTs
    .replace(/\bbearer\s+[^\s"',;}]+/gi, 'Bearer [redacted]')
    .replace(/\b(token|authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|secret)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1$2[redacted]')
    .replace(UUID_RE, '[id]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, '~')
    .replace(/\/(home|Users)\/[^/\s"']+/g, '~')
    .replace(/\b[A-Za-z0-9_\-+/=]{32,}\b/g, '[redacted]');                                     // long secrets
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}

class RailwayError extends Error {
  constructor(kind, message, detail = '') { super(message); this.kind = kind; this.detail = detail; }
}
const KIND_TEXT = {
  missing: 'Railway CLI not found. Install it (npm i -g @railway/cli) and run "railway login" once in a terminal.',
  auth: 'Railway sign-in is missing or expired. Run "railway login" in a terminal, then try again.',
  rate: 'Railway is rate-limiting requests. Helm waits at least 5 minutes before asking again.',
  network: 'Could not reach Railway.',
  timeout: 'The Railway CLI did not answer in time.',
  old: 'This Railway CLI is too old for Helm (it needs "railway api", CLI 5.41 or newer). Run "railway upgrade --yes".',
  other: 'The Railway CLI failed.',
};

function classifyText(text) {
  const t = String(text || '');
  if (/unrecognized subcommand|unexpected argument|unknown (sub)?command/i.test(t)) return 'old';
  if (/\b429\b|rate.?limit|too many requests/i.test(t)) return 'rate';
  if (/not authori[sz]ed|unauthori[sz]ed|railway login|not logged in|login required|invalid token|token.{0,20}expired|\b401\b|\b403\b/i.test(t)) return 'auth';
  if (/error sending request|dns|connection (refused|reset|closed)|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|network|offline|tls|certificate/i.test(t)) return 'network';
  return 'other';
}

// ---------- finding the CLI ----------
// The npm install puts a railway.cmd shim on PATH; a .cmd cannot be spawned without a shell, so the
// real railway.exe beside it (node_modules/@railway/cli/bin) is used instead.
function findRailwayCli({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const win = platform === 'win32';
  const dirs = String(env.PATH || env.Path || '').split(win ? ';' : ':').filter(Boolean);
  const exe = win ? 'railway.exe' : 'railway';
  for (const d of dirs) {
    const p = path.join(d, exe);
    if (exists(p)) return p;
    if (win && exists(path.join(d, 'railway.cmd'))) {
      const inner = path.join(d, 'node_modules', '@railway', 'cli', 'bin', 'railway.exe');
      if (exists(inner)) return inner;
    }
  }
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const extra = win
    ? [env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', '@railway', 'cli', 'bin', 'railway.exe'),
      home && path.join(home, '.railway', 'bin', 'railway.exe'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'railway.exe'),
      home && path.join(home, 'scoop', 'shims', 'railway.exe')]
    : [home && path.join(home, '.railway', 'bin', 'railway'), '/usr/local/bin/railway', '/opt/homebrew/bin/railway'];
  for (const p of extra) if (p && exists(p)) return p;
  return null;
}

// ---------- running the CLI ----------
// spawnRun(cli, args, input, opts) -> { code, stdout, stderr, error, timedOut }. cli = { cmd, pre, env }.
function makeSpawnRun({ spawn = realSpawn, env = process.env, platform = process.platform, timers = { setTimeout, clearTimeout } } = {}) {
  return function spawnRun(cli, args, input, { timeoutMs = STATUS_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(cli.cmd, [...(cli.pre || []), ...args], {
          cwd: os.tmpdir(), env: { ...env, ...(cli.env || {}), NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
      } catch (e) { resolve({ error: e }); return; }
      let stdout = '', stderr = '', done = false, timedOut = false;
      const finish = (r) => { if (done) return; done = true; timers.clearTimeout(timer); resolve(r); };
      const kill = () => {
        try {
          if (platform === 'win32' && child.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
          else child.kill('SIGKILL');
        } catch { /* already gone */ }
      };
      const timer = timers.setTimeout(() => { timedOut = true; kill(); finish({ code: null, stdout, stderr, timedOut }); }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d; if (stdout.length > MAX_OUT) { kill(); finish({ code: null, stdout: '', stderr: 'output too large', error: new Error('output too large') }); } });
      child.stderr.on('data', (d) => { if (stderr.length < 64 * 1024) stderr += d; });
      child.on('error', (e) => finish({ error: e, stdout, stderr }));
      child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
      child.stdin.on('error', () => {});
      child.stdin.end(input || '');
    });
  };
}

// ---------- normalising the status answer ----------
const ms = (t) => { const n = t ? Date.parse(t) : NaN; return Number.isFinite(n) ? n : null; };
const isProdEnv = (name) => /^prod(uction)?$/i.test(String(name || '').trim());

function normalize(data) {
  const me = (data && data.me) || {};
  const nodes = [];
  for (const w of me.workspaces || []) for (const e of ((w && w.projects) || {}).edges || []) nodes.push(e && e.node);
  for (const e of (me.projects || {}).edges || []) nodes.push(e && e.node);
  const seen = new Set();
  const projects = [];
  for (const p of nodes) {
    if (!p || !p.id || seen.has(p.id) || p.deletedAt) continue;
    seen.add(p.id);
    const services = [];
    for (const ee of (p.environments || {}).edges || []) {
      const env = ee && ee.node;
      if (!env || !env.id) continue;
      for (const se of (env.serviceInstances || {}).edges || []) {
        const si = se && se.node;
        if (!si || !si.serviceId || si.deletedAt) continue;
        services.push(serviceRow(p, env, si));
      }
    }
    services.sort((a, b) => (b.prod - a.prod) || a.name.localeCompare(b.name) || a.environment.localeCompare(b.environment));
    projects.push({ id: p.id, name: String(p.name || 'Untitled project'), services });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

function serviceRow(p, env, si) {
  const active = Array.isArray(si.activeDeployments) ? si.activeDeployments.filter(Boolean) : [];
  const latest = si.latestDeployment || null;
  // A skipped push (nothing in the watch paths changed) leaves the previous deployment serving.
  let shown = latest;
  if (latest && String(latest.status).toUpperCase() === 'SKIPPED' && active[0]) shown = active[0];
  const status = mapStatus(shown && shown.status, { stopped: !!(shown && shown.deploymentStopped) });
  // A failed/crashed new deploy can leave an older deployment still serving.
  const olderLive = (status === 'failed' || status === 'building' || status === 'deploying' || status === 'queued')
    && active.some((d) => d && d.id !== (shown && shown.id) && String(d.status).toUpperCase() === 'SUCCESS');
  const restartTarget = [latest, ...active].find((d) => d && RESTARTABLE.has(String(d.status).toUpperCase())) || null;
  const busy = isBusy(status);
  let redeployWhy = null, restartWhy = null;
  if (!latest) redeployWhy = 'No deployment to redeploy yet';
  else if (latest.canRedeploy === false) redeployWhy = 'Railway says this deployment cannot be redeployed';
  else if (busy) redeployWhy = 'Wait for the current deploy to finish';
  if (!restartTarget) restartWhy = 'Nothing running to restart';
  else if (busy) restartWhy = 'Wait for the current deploy to finish';
  return {
    key: `${si.serviceId}:${env.id}`,
    serviceId: si.serviceId,
    environmentId: env.id,
    projectId: p.id,
    name: String(si.serviceName || 'service'),
    environment: String(env.name || ''),
    prod: isProdEnv(env.name),
    status,
    tone: toneOf(status),
    raw: shown ? String(shown.status || '') : null,
    since: shown ? (ms(shown.statusUpdatedAt) || ms(shown.createdAt)) : null,
    deploymentId: latest ? latest.id : null,
    restartId: restartTarget ? restartTarget.id : null,
    olderLive,
    canRedeploy: !redeployWhy,
    canRestart: !restartWhy,
    redeployWhy,
    restartWhy,
  };
}

// ---------- polling cadence (pure; exported for tests) ----------
function pollDelay({ panel = false, chip = false, busy = false, errorStreak = 0, rateLimited = false } = {}) {
  if (!panel && !chip) return null;
  let d = busy ? BUSY_MS : panel ? PANEL_MS : CHIP_MS;
  if (errorStreak > 0) d = Math.max(d, Math.min(ERR_MAX_MS, ERR_BASE_MS * 2 ** Math.min(errorStreak - 1, 10)));
  if (rateLimited) d = Math.max(d, RATE_MS);
  return d;
}

function rpcError(message, code) { return Object.assign(new Error(message), { code }); }
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * createRailway(opts) -> { methods, refresh, state, stop }
 *   emit(event, data): main.js hostEmit (railway.changed goes to every client)
 *   test: main runs with --test (off unless HELM_RAILWAY_CLI / HELM_RAILWAY_LIVE)
 *   run(args, input, { timeoutMs }): injected CLI transport for tests -> { code, stdout, stderr, error, timedOut }
 *   cliPath, env, platform, exists, spawn, now, timers: more injection points for tests
 */
function createRailway(opts = {}) {
  const { emit = () => {}, log = () => {}, test = false } = opts;
  const env = opts.env || process.env;
  const now = opts.now || Date.now;
  const timers = opts.timers || { setTimeout, clearTimeout };
  const secrets = [env.RAILWAY_API_TOKEN, env.RAILWAY_TOKEN].filter(Boolean);

  // Where the CLI comes from, and whether actions are allowed at all.
  let mode = 'ready', offReason = null, actionsOff = null, run = null;
  if (typeof opts.run === 'function') {
    run = opts.run;
  } else {
    const spawnRun = makeSpawnRun({ spawn: opts.spawn, env, platform: opts.platform || process.platform, timers });
    let cli = null;
    if (test) {
      const fake = env.HELM_RAILWAY_CLI;
      if (fake && /\.(c|m)?js$/i.test(fake)) cli = { cmd: process.execPath, pre: [fake], env: { ELECTRON_RUN_AS_NODE: '1' } };
      else if (env.HELM_RAILWAY_LIVE === '1') { actionsOff = 'A test run reads Railway status only: Redeploy and Restart are off.'; }
      else { mode = 'off'; offReason = 'A test run does not read Railway. Set HELM_RAILWAY_CLI to a fake CLI script, or HELM_RAILWAY_LIVE=1 for read-only status.'; }
    }
    // Found lazily (and looked for again while missing), so installing the CLI later needs no Helm restart.
    const resolve = () => {
      if (!cli && mode === 'ready') { const found = opts.cliPath || findRailwayCli({ env, platform: opts.platform, exists: opts.exists }); if (found) cli = { cmd: found }; }
      return cli;
    };
    run = (args, input, o) => (resolve() ? spawnRun(cli, args, input, o) : Promise.resolve({ error: Object.assign(new Error('railway not found'), { code: 'ENOENT' }) }));
  }

  // One CLI process at a time.
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  async function gql(doc, vars = {}, { timeoutMs = STATUS_TIMEOUT_MS, allowPartial = false } = {}) {
    const args = ['api', '-f', '-', '--compact', '--allow-errors'];
    for (const [k, v] of Object.entries(vars)) args.push('--raw-var', `${k}=${v}`);
    const r = await serial(() => run(args, doc, { timeoutMs }));
    if (r.error) {
      if (r.error.code === 'ENOENT') throw new RailwayError('missing', KIND_TEXT.missing);
      throw new RailwayError('other', KIND_TEXT.other, redact(r.error.message, secrets));
    }
    if (r.timedOut) throw new RailwayError('timeout', KIND_TEXT.timeout, `No answer in ${Math.round(timeoutMs / 1000)} s.`);
    let j = null;
    try { j = JSON.parse(String(r.stdout || '').trim() || 'null'); } catch { j = null; }
    if (r.code !== 0 || !j) {
      const text = `${r.stderr || ''} ${j ? '' : r.stdout || ''}`;
      const kind = classifyText(text);
      throw new RailwayError(kind, KIND_TEXT[kind], redact(text, secrets) || (r.code !== 0 ? `exit code ${r.code}` : 'no JSON in the answer'));
    }
    const errs = Array.isArray(j.errors) ? j.errors : [];
    if (errs.length) {
      const text = errs.map((e) => (e && e.message) || String(e)).join('; ');
      const kind = classifyText(text);
      if (!allowPartial || kind === 'rate' || !j.data || (j.data.me == null && 'me' in j.data)) {
        throw new RailwayError(kind, KIND_TEXT[kind], redact(text, secrets));
      }
      return { data: j.data, warning: redact(text, secrets) };
    }
    return { data: j.data, warning: null };
  }

  // ---------- state ----------
  const st = {
    projects: null, fetchedAt: null, checkedAt: null, fetching: false,
    error: null, warning: null, errorStreak: 0, rateUntil: 0,
  };
  const leases = { panel: 0, chip: 0 };
  const actions = new Map();   // key -> { key, kind, state, ... }
  let timer = null, nextAt = null, inflight = null, lastSig = '', stopped = false;
  const after = new Set();   // one-off post-action refresh timers (cleared by stop())

  const leaseOn = (k) => leases[k] > now();
  const anyBusy = () => {
    const t = now();
    for (const a of actions.values()) if (a.state === 'running' || a.state === 'sent' || (a.fastUntil && a.fastUntil > t)) return true;
    return !!(st.projects && st.projects.some((p) => p.services.some((s) => isBusy(s.status))));
  };
  const currentDelay = () => pollDelay({ panel: leaseOn('panel'), chip: leaseOn('chip'), busy: anyBusy(), errorStreak: st.errorStreak, rateLimited: st.rateUntil > now() });

  function view() {
    const t = now();
    for (const [k, a] of actions) if (a.endedAt && t - a.endedAt > SETTLED_KEEP_MS) actions.delete(k);
    const d = mode === 'off' ? null : currentDelay();
    return {
      mode,
      ...(offReason ? { offReason } : {}),
      projects: st.projects,
      fetchedAt: st.fetchedAt,
      checkedAt: st.checkedAt,
      fetching: st.fetching,
      error: st.error,
      warning: st.warning,
      actions: [...actions.values()].map(({ fastUntil, ...a }) => a),
      canAct: mode === 'ready' && !actionsOff,
      ...(actionsOff ? { actReason: actionsOff } : {}),
      poll: { intervalMs: d, nextAt, watching: ['panel', 'chip'].filter(leaseOn) },
    };
  }

  function changed() {
    const v = view();
    const sig = JSON.stringify([v.mode, v.projects, v.error && [v.error.kind, v.error.message, v.error.detail], v.warning, v.actions, v.canAct]);
    if (sig === lastSig) return;
    lastSig = sig;
    try { emit('railway.changed', v); } catch (e) { log('railway emit failed:', e && e.message); }
  }

  function schedule() {
    if (timer) { timers.clearTimeout(timer); timer = null; }
    nextAt = null;
    if (stopped || mode === 'off') return;
    const d = currentDelay();
    if (d == null) return;
    const base = st.checkedAt || 0;
    nextAt = Math.max(now(), base + d);
    timer = timers.setTimeout(tick, Math.max(0, nextAt - now()));
    if (timer && timer.unref) timer.unref();
  }

  // Timer fired: leases may have lapsed (window hidden, panel closed) or the cadence slowed since.
  function tick() {
    timer = null;
    const d = currentDelay();
    if (d == null) { nextAt = null; return; }
    if (st.checkedAt != null && now() < st.checkedAt + d - 50) { schedule(); return; }
    refresh().catch(() => {});
  }

  function applyActions() {
    const t = now();
    for (const a of actions.values()) {
      if (a.state !== 'sent') continue;
      const svc = findSvc(a.serviceId, a.environmentId);
      if (!svc) continue;
      const moved = a.toId ? svc.deploymentId === a.toId : svc.deploymentId && svc.deploymentId !== a.fromId;
      if (moved && !isBusy(svc.status)) {
        a.state = 'done'; a.endedAt = t; a.result = svc.status;
        a.message = svc.status === 'live' ? 'Redeployed: live' : `Redeploy ended: ${svc.status}`;
      } else if (moved) {
        a.message = `Redeploying: ${svc.status}`;
      } else if (t - a.startedAt > REDEPLOY_GIVEUP_MS) {
        a.state = 'done'; a.endedAt = t; a.result = 'unknown'; a.message = 'No new deployment showed up in 20 minutes. Check Railway.';
      }
    }
  }

  async function doFetch() {
    st.fetching = true;
    try {
      const { data, warning } = await gql(STATUS_QUERY, {}, { allowPartial: true });
      st.projects = normalize(data);
      st.fetchedAt = now();
      st.error = null; st.warning = warning; st.errorStreak = 0; st.rateUntil = 0;
      applyActions();
    } catch (e) {
      const kind = e instanceof RailwayError ? e.kind : 'other';
      st.errorStreak += 1;
      if (kind === 'rate') st.rateUntil = now() + RATE_MS;
      st.error = { kind, message: e instanceof RailwayError ? e.message : KIND_TEXT.other, detail: redact(e instanceof RailwayError ? e.detail : (e && e.message), secrets), at: now() };
      log('railway status failed:', st.error.kind, st.error.detail);
    } finally {
      st.fetching = false;
      st.checkedAt = now();
    }
  }

  function refresh() {
    if (mode === 'off' || stopped) return Promise.resolve(view());
    if (inflight) return inflight;
    inflight = doFetch().finally(() => { inflight = null; changed(); schedule(); }).then(() => view());
    return inflight;
  }

  function findSvc(serviceId, environmentId) {
    for (const p of st.projects || []) for (const s of p.services) if (s.serviceId === serviceId && s.environmentId === environmentId) return { ...s, project: p.name };
    return null;
  }

  // ---------- RPC ----------
  async function status(p = {}) {
    if (mode === 'off') return view();
    const kind = p && (p.watch === 'panel' || p.watch === 'chip') ? p.watch : null;
    const wasIdle = !timer && !inflight;
    if (kind) leases[kind] = now() + LEASE_MS[kind];
    const age = st.checkedAt == null ? Infinity : now() - st.checkedAt;
    const d = currentDelay();
    const rateLimited = st.rateUntil > now();
    if (p && p.refresh === true && !rateLimited && age >= MANUAL_MIN_MS) {
      refresh().catch(() => {});
    } else if (!inflight && d != null && age >= d) {
      refresh().catch(() => {});
    } else if (wasIdle || kind) schedule();
    const v = view();
    if (inflight) v.fetching = true;
    return v;
  }

  async function act(kind, p = {}) {
    if (!p || p.confirm !== true) throw rpcError(`${kind === 'redeploy' ? 'Redeploy' : 'Restart'} needs a confirm: send { confirm: true } from the confirm dialog.`, 'confirm_required');
    for (const f of ['serviceId', 'environmentId']) if (typeof p[f] !== 'string' || !ID_RE.test(p[f])) throw rpcError(`${f} is missing or malformed`, 'bad_params');
    if (p.deploymentId != null && (typeof p.deploymentId !== 'string' || !ID_RE.test(p.deploymentId))) throw rpcError('deploymentId is malformed', 'bad_params');
    if (mode === 'off') throw rpcError(offReason, 'unsupported');
    if (actionsOff) throw rpcError(actionsOff, 'unsupported');
    const key = `${p.serviceId}:${p.environmentId}`;
    const prev = actions.get(key);
    if (prev && (prev.state === 'running' || prev.state === 'sent')) throw rpcError('An action is already running for this service.', 'busy');
    if (st.rateUntil > now()) throw rpcError(KIND_TEXT.rate, 'rate_limited');
    if (st.fetchedAt == null || now() - st.fetchedAt > ACTION_FRESH_MS) await refresh();
    if (st.error && (st.fetchedAt == null || now() - st.fetchedAt > ACTION_FRESH_MS)) throw rpcError(`Could not check Railway first: ${st.error.message}`, 'unavailable');
    const svc = findSvc(p.serviceId, p.environmentId);
    if (!svc) throw rpcError('That service is not in the latest Railway status. Refresh and try again.', 'not_found');
    const target = kind === 'redeploy' ? svc.deploymentId : svc.restartId;
    const can = kind === 'redeploy' ? svc.canRedeploy : svc.canRestart;
    if (!can || !target) throw rpcError((kind === 'redeploy' ? svc.redeployWhy : svc.restartWhy) || 'Not available right now.', 'unavailable');
    if (p.deploymentId && p.deploymentId !== target) throw rpcError('The deployment changed since you looked. Check the new status and try again.', 'stale');

    const a = {
      key, kind, state: 'running', serviceId: svc.serviceId, environmentId: svc.environmentId,
      project: svc.project, service: svc.name, environment: svc.environment, prod: svc.prod,
      fromId: svc.deploymentId, startedAt: now(), message: kind === 'redeploy' ? 'Asking Railway to redeploy' : 'Asking Railway to restart',
    };
    actions.set(key, a);
    changed();
    try {
      if (kind === 'redeploy') {
        const { data } = await gql(REDEPLOY_MUTATION, { id: target }, { timeoutMs: ACTION_TIMEOUT_MS });
        const dep = data && data.deploymentRedeploy;
        a.toId = dep && dep.id ? dep.id : null;
        a.state = 'sent'; a.message = 'Redeploy started';
      } else {
        const { data } = await gql(RESTART_MUTATION, { id: target }, { timeoutMs: ACTION_TIMEOUT_MS });
        if (!data || data.deploymentRestart !== true) throw new RailwayError('other', 'Railway did not confirm the restart.', '');
        a.state = 'done'; a.endedAt = now(); a.result = 'sent'; a.message = 'Restart sent'; a.fastUntil = now() + RESTART_FAST_MS;
      }
    } catch (e) {
      const kindE = e instanceof RailwayError ? e.kind : 'other';
      if (kindE === 'rate') st.rateUntil = now() + RATE_MS;
      a.state = 'error'; a.endedAt = now();
      // status reads work, so a refused mutation is more likely a permission than an expired sign-in
      if (kindE === 'auth') e.message = `Railway refused the ${kind}: the account may not have permission on ${a.project}, or the sign-in expired (run "railway login").`;
      const detail = redact(e instanceof RailwayError ? e.detail : (e && e.message), secrets);
      a.message = `${e instanceof RailwayError ? e.message : KIND_TEXT.other}${detail ? ` (${detail})` : ''}`;
      log(`railway ${kind} failed:`, kindE, detail);
      changed(); schedule();
      throw rpcError(a.message, kindE === 'rate' ? 'rate_limited' : 'railway_failed');
    }
    changed();
    // Fast polls show the new deployment move through building -> deploying -> live.
    const t1 = timers.setTimeout(() => { after.delete(t1); refresh().catch(() => {}); }, kind === 'redeploy' ? 3000 : 5000);
    if (t1 && t1.unref) t1.unref();
    after.add(t1);
    schedule();
    const { fastUntil, ...out } = a;
    return { ok: true, action: out };
  }

  const methods = {
    'railway.status': (p) => status(p || {}),
    'railway.redeploy': (p) => act('redeploy', p || {}),
    'railway.restart': (p) => act('restart', p || {}),
  };

  function stop() { stopped = true; if (timer) timers.clearTimeout(timer); timer = null; for (const t of after) timers.clearTimeout(t); after.clear(); }

  return { methods, refresh, state: view, stop };
}

module.exports = { createRailway, mapStatus, toneOf, normalize, pollDelay, redact, classifyText, findRailwayCli, makeSpawnRun, STATUS_QUERY, REDEPLOY_MUTATION, RESTART_MUTATION, BUSY_MS, PANEL_MS, CHIP_MS, RATE_MS, ERR_MAX_MS };
