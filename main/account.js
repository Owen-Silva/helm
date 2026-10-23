// Settings -> Account (PROTOCOL "Account"): how the claude children Helm starts reach Claude. Helm never signs
// in: it has no login of its own, never runs a sign-in or sign-out, and never reads, copies or stores a token.
//
// Two modes:
//   claude-code (default)  Helm's claude children run on whatever the user's installed Claude Code is already
//                          signed in with (their Claude account, or their own API key), signed in by the user in
//                          a terminal with `claude` (Anthropic's own flow). Helm passes the user's environment
//                          through unchanged (main/claude-cli.js baseChildEnv): it adds no auth variable and
//                          strips none.
//   api-key                only when the user saved an Anthropic API key in Settings > Account (main/settings.js:
//                          <userData>/api-key.json, OS-encrypted when it can be; never in settings.json, never
//                          sent to a client, never logged). Every claude child gets it as ANTHROPIC_API_KEY.
//                          Clients only ever see apiKeySet + the last 4 characters. Clearing the key is the
//                          switch back to claude-code.
//
// Signed-in status, without touching credentials: Claude Code's own read-only `claude auth status --json`
// (it prints no secret), run with the same environment the sessions get. Only loggedIn / method / plan /
// email / org name are kept. It runs once after start (start()), when Settings > Account asks (refresh), when
// a blocked start finds the answer stale, and after a session's own startup error says it is not signed in.
// If the check cannot run, nothing is blocked: the session's own error says what Claude Code thinks.
//
// After the key is saved, replaced or cleared, Helm's running CLIs still hold the old credentials: idle ones are
// closed (the next message starts a fresh CLI, the conversation resumes) and working ones are closed once their
// turn ends (engine.recycleClis, polled).
'use strict';
const { spawn: realSpawn, execFile } = require('child_process');
const fs = require('fs');
const { baseChildEnv, sessionClaudePath } = require('./claude-cli');
const { nextStartTurn } = require('./start-turn');

const RECYCLE_POLL_MS = 5000;
const RECYCLE_MAX_MS = 60 * 60_000;
const STATUS_TIMEOUT_MS = 10_000;   // `claude auth status` normally answers in under a second
const STALE_MS = 30_000;            // a signed-out answer older than this is re-checked when a start is refused
const START_DELAY_MS = 3000;        // the first check after Helm starts (off the startup path)
const SESSION_RECHECK_MS = 5000;    // at most one re-check per this after a session's sign-in error
const MAX_KEY = 512;
const MAX_TAIL = 4000;

const NOT_SIGNED_IN = "Claude Code isn't signed in. Open a terminal, run `claude`, and sign in there; then press Check again.";
const KEY_FIX = "Save the key again in Settings > Account, or remove it to use Claude Code's sign-in.";
const CAPABILITIES = Object.freeze({ apiKey: true, login: false });   // login: Helm never signs in

function err(message, code) { return Object.assign(new Error(message), { code }); }
const bad = (m) => err(m, 'bad_params');
const last4 = (k) => (typeof k === 'string' && k.length >= 12 ? k.slice(-4) : null);
const oneLine = (s, n = 300) => String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0]?.slice(0, n) || '';

/**
 * Restart Helm's own CLIs onto new credentials: idle ones close now, working ones when their turn ends.
 * createRecycler({ engine, onChange, log, now, pollMs, maxMs }) -> { recycle(reason), state(), stop() }
 *   engine  { recycleClis() -> { closed: [ids], busy: [ids] } }; without it the state says unsupported
 */
function createRecycler({ engine, onChange = () => {}, log = () => {}, now = Date.now, pollMs = RECYCLE_POLL_MS, maxMs = RECYCLE_MAX_MS } = {}) {
  let restart = null;   // { at, reason, restarted, waiting, unsupported? }
  let timer = null;
  function recycle(reason) {
    clearTimeout(timer);
    if (!engine || typeof engine.recycleClis !== 'function') { restart = { at: now(), reason, restarted: 0, waiting: 0, unsupported: true }; onChange(); return; }
    const started = now();
    let total = 0;
    const tick = () => {
      let r;
      try { r = engine.recycleClis() || {}; } catch (e) { log('account: recycleClis failed', e); r = {}; }
      total += (r.closed || []).length;
      const waiting = (r.busy || []).length;
      restart = { at: started, reason, restarted: total, waiting };
      onChange();
      if (waiting && now() - started < maxMs) timer = setTimeout(tick, pollMs);
    };
    tick();
  }
  return { recycle, state: () => (restart ? { ...restart } : null), stop: () => clearTimeout(timer) };
}

/**
 * The key a user pasted -> the key to save, or throws bad_params saying what is wrong with it.
 * A Claude sign-in token (sk-ant-oat...) is refused: Helm never stores sign-in tokens.
 */
function cleanKey(raw) {
  if (typeof raw !== 'string') throw bad('key must be a string, or null to clear it');
  const key = raw.trim();
  if (!key) throw bad('Paste an API key first.');
  if (key.length > MAX_KEY) throw bad(`That is longer than an API key (over ${MAX_KEY} characters).`);
  if (!/^[\x21-\x7e]+$/.test(key)) throw bad('An API key is one word with no spaces or line breaks. Copy it again from the Anthropic Console.');
  if (/^sk-ant-oat/i.test(key)) throw bad("That is a Claude sign-in token, not an API key, and Helm doesn't store sign-in tokens. To use your Claude account, run `claude` in a terminal and sign in there; or create an API key in the Anthropic Console (console.anthropic.com > Settings > API keys).");
  return key;
}

const PLAN_NAMES = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
const CLOUD_NAMES = { bedrock: 'Amazon Bedrock', vertex: 'Google Vertex AI', foundry: 'Microsoft Foundry' };
const text = (v) => (typeof v === 'string' && v ? v.slice(0, 300) : null);

// What Claude Code says it runs on. 'subscription' (Claude account), 'console' (Console login, API billing),
// 'api_key' (a key Claude Code takes from its environment or an apiKeyHelper), 'provider' (Bedrock / Vertex /
// Foundry credentials), 'none' (signed out).
function kindOf(j) {
  const method = text(j.authMethod) || 'none';
  const source = text(j.apiKeySource) || '';
  if ((text(j.apiProvider) || 'firstParty') !== 'firstParty') return 'provider';
  if (!j.loggedIn) return 'none';
  if (method === 'claude.ai') return 'subscription';
  if (/^ANTHROPIC_API_KEY$|apiKeyHelper|ANTHROPIC_AUTH_TOKEN/i.test(source)) return 'api_key';
  if (method === 'console' || /login managed key/i.test(source)) return 'console';
  if (method === 'api_key' || source) return 'api_key';
  return 'subscription';   // any other sign-in, e.g. a long-lived token from a Claude account: limits as always
}

/**
 * Raw `claude auth status --json` -> the non-secret fields Settings shows: { loggedIn, kind, plan, methodLabel,
 * email, orgName }. Everything else it prints (ids, folders) is dropped: no client needs it.
 */
function describeStatus(raw) {
  const j = (raw && typeof raw === 'object') ? raw : {};
  const kind = kindOf(j);
  const tier = text(j.subscriptionType);
  const cloud = CLOUD_NAMES[text(j.apiProvider)] || text(j.apiProvider);
  const keyFrom = text(j.apiKeySource);
  const [plan, methodLabel] = {
    subscription: [tier ? PLAN_NAMES[tier.toLowerCase()] || tier[0].toUpperCase() + tier.slice(1) : 'Claude subscription', 'Claude account (claude.ai)'],
    console: ['Console (API billing)', 'Anthropic Console'],
    api_key: ['API key', keyFrom ? `API key from ${keyFrom}` : 'API key'],
    provider: [cloud, `${cloud} credentials`],
    none: [null, null],
  }[kind];
  return { loggedIn: kind !== 'none', kind, plan, methodLabel, email: text(j.email), orgName: text(j.orgName) };
}

// Stop a status check we started, and whatever it started, by its PID (never by image name).
function endTree(child) {
  if (!child || !child.pid) return;
  if (process.platform !== 'win32') { try { child.kill('SIGTERM'); } catch {} return; }
  execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {});
}

const UNCHECKED = Object.freeze({ state: 'unchecked', loggedIn: null, kind: null, plan: null, methodLabel: null, email: null, orgName: null, reason: null, source: null, checkedAt: null });

/**
 * createAccount(opts) -> the auth provider
 *   settings      { getApiKey(), setApiKey(key|null), apiKeyError() } (main/settings.js); absent = no saved key
 *   env           the environment claude children inherit (default process.env); read-only here
 *   emit(event, data)  'account.changed' goes to every client
 *   engine        { recycleClis() } (optional; main.js passes a late-bound one)
 *   claudePath    the executable the status check runs (string, null = none, or a function; default: the one
 *                 sessions run, main/claude-cli.js sessionClaudePath)
 *   claudeArgs    args put before ours (tests: [fakeScript] with claudePath = node)
 *   spawn, killTree, exists, startTurn, now, statusTimeoutMs, staleMs, startDelayMs, recyclePollMs, recycleMaxMs: tests
 *
 * -> { id, capabilities, methods, state(), public(), usageLimits (getter), childEnv(env), startBlock(),
 *      checkSignIn(), noteAuthError(text), start(), stop() }
 */
function createAccount(opts = {}) {
  const settings = opts.settings || null;
  const env = opts.env || process.env;
  const emit = opts.emit || (() => {});
  const log = opts.log || (() => {});
  const now = opts.now || Date.now;
  const spawn = opts.spawn || realSpawn;
  const killTree = opts.killTree || endTree;
  const exists = opts.exists || ((p) => fs.existsSync(p));
  const startTurn = opts.startTurn || nextStartTurn;
  const argsBefore = opts.claudeArgs || [];   // tests: [fakeScript] with claudePath = node
  const statusTimeout = opts.statusTimeoutMs || STATUS_TIMEOUT_MS;
  const staleMs = opts.staleMs || STALE_MS;
  const claudePathNow = () => (typeof opts.claudePath === 'function' ? opts.claudePath() : opts.claudePath !== undefined ? opts.claudePath : sessionClaudePath());
  const canSave = !!(settings && typeof settings.getApiKey === 'function' && typeof settings.setApiKey === 'function');
  let lastSent = '';
  let signIn = { ...UNCHECKED };
  let checking = null;          // the in-flight check (a promise), or null
  let checkChild = null;
  let lastSessionCheck = 0;
  let startTimer = null;
  let stopped = false;

  // ---------- the saved API key ----------
  const savedKey = () => { const k = canSave ? settings.getApiKey() : null; return typeof k === 'string' && k ? k : null; };
  const keyError = () => (canSave && typeof settings.apiKeyError === 'function' ? settings.apiKeyError() || null : null);
  // api-key while a key is saved, or a saved one can't be read (never a silent switch to another account)
  const mode = () => (savedKey() || keyError() ? 'api-key' : 'claude-code');

  // ---------- Claude Code's own sign-in ----------
  function runStatus() {
    return new Promise((resolve) => {
      const exe = claudePathNow();
      if (!exe || !exists(exe)) { resolve({ error: `Claude Code was not found${exe ? ` at ${exe}` : ''}. Install it (or set HELM_CLAUDE_EXE), then press Check again.` }); return; }
      let child;
      // the sessions' own environment (no Helm key): what Claude Code is signed in with by itself
      try { child = spawn(exe, [...argsBefore, 'auth', 'status', '--json'], { env: baseChildEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { resolve({ error: (e && e.message) || String(e) }); return; }
      checkChild = child;
      let stdout = '', stderr = '', done = false;
      const finish = (r) => { if (done) return; done = true; clearTimeout(t); checkChild = null; resolve({ stdout, stderr, ...r }); };
      const t = setTimeout(() => { killTree(child); finish({ error: `claude auth status did not answer in ${Math.round(statusTimeout / 1000)} s.` }); }, statusTimeout);
      const keepTail = (s) => (s.length > MAX_TAIL ? s.slice(-MAX_TAIL) : s);
      if (child.stdout) child.stdout.on('data', (d) => { stdout = keepTail(stdout + d); });
      if (child.stderr) child.stderr.on('data', (d) => { stderr = keepTail(stderr + d); });
      child.on('error', (e) => finish({ error: e && e.code === 'ENOENT' ? `Claude Code was not found at ${exe}.` : (e && e.message) || String(e) }));
      child.on('close', (exitCode) => finish({ code: exitCode }));
    });
  }

  async function readSignIn() {
    await startTurn();   // one process start per event-loop turn (main/start-turn.js)
    const r = await runStatus();
    const at = now();
    if (!r.error) {
      // signed out exits 1 but still prints the JSON: parse first, judge the exit code after
      const txt = String(r.stdout || '');
      const open = txt.indexOf('{');
      const close = txt.lastIndexOf('}');
      if (open >= 0 && close > open) {
        let j = null;
        try { j = JSON.parse(txt.slice(open, close + 1)); } catch {}
        if (j && typeof j === 'object') {
          const d = describeStatus(j);
          return { state: d.loggedIn ? 'signed-in' : 'signed-out', ...d, reason: d.loggedIn ? null : NOT_SIGNED_IN, source: 'auth-status', checkedAt: at };
        }
      }
    }
    const why = r.error || oneLine(r.stderr) || oneLine(r.stdout) || `claude auth status exited with code ${r.code}`;
    return { ...UNCHECKED, state: 'unknown', reason: `Helm couldn't check Claude Code's sign-in: ${String(why).replace(/\.$/, '')}.`, source: 'auth-status', checkedAt: at };
  }

  // -> the new sign-in state. One check at a time: callers during a check share it.
  function checkSignIn() {
    if (checking) return checking;
    if (stopped) return Promise.resolve({ ...signIn });
    checking = readSignIn().then((s) => {
      const was = signIn.state;
      signIn = s;
      if (was !== s.state) log(`account: Claude Code sign-in ${s.state}${s.state === 'unknown' ? ` (${s.reason})` : ''}`);
      return { ...signIn };
    }, (e) => {
      signIn = { ...UNCHECKED, state: 'unknown', reason: `Helm couldn't check Claude Code's sign-in: ${oneLine(e && e.message) || 'unknown error'}.`, source: 'auth-status', checkedAt: now() };
      return { ...signIn };
    }).finally(() => { checking = null; changed(); });
    changed();   // checking: true
    return checking;
  }

  // A session's own startup error said Claude Code is not signed in (main/engine/session.js): look again, and
  // when the status check can't run, take the session's word for it.
  function noteAuthError(text) {
    if (mode() !== 'claude-code') return;
    const notSignedIn = /not logged in|please run \/login|not signed in|no credentials/i.test(String(text || ''));
    if (now() - lastSessionCheck < SESSION_RECHECK_MS) return;
    lastSessionCheck = now();
    checkSignIn().then((s) => {
      if (s.state === 'unknown' && notSignedIn) {
        signIn = { ...UNCHECKED, state: 'signed-out', loggedIn: false, kind: 'none', reason: NOT_SIGNED_IN, source: 'session', checkedAt: now() };
        changed();
      }
    }, () => {});
  }

  // ---------- what every client sees ----------
  // why no claude child may start now, or null (no side effects: state() uses it too)
  function blockNow() {
    if (mode() === 'api-key') {
      if (savedKey()) return null;
      return { code: 'auth_required', message: `${keyError() || 'The saved API key could not be read.'} ${KEY_FIX}` };
    }
    return signIn.state === 'signed-out' ? { code: 'auth_required', message: NOT_SIGNED_IN } : null;
  }
  // the engine and the queue ask before starting a claude child. A stale signed-out answer (signed in meanwhile
  // in a terminal?) is looked at again in the background; this start still waits for it.
  function startBlock() {
    const b = blockNow();
    if (b && mode() === 'claude-code' && !checking && now() - (signIn.checkedAt || 0) > staleMs) checkSignIn().catch(() => {});
    return b;
  }

  // no 5-hour / weekly windows: an API key (Helm's, or the one Claude Code itself is signed in with)
  function usageLimits() {
    if (mode() === 'api-key') return false;
    return !(signIn.state === 'signed-in' && signIn.kind && signIn.kind !== 'subscription');
  }

  function state() {
    const key = savedKey();
    const block = blockNow();
    return {
      provider: mode(),
      capabilities: { ...CAPABILITIES },
      usageLimits: usageLimits(),
      ready: !block,
      reason: block ? block.message : null,
      status: {
        ok: true,
        apiKeySet: !!key,
        apiKeyLast4: key ? last4(key) : null,
        apiKeySource: key ? 'helm' : null,
        keyError: keyError(),
        canSave,
        checkedAt: now(),
      },
      claudeCode: { ...signIn, checking: !!checking },
      restart: recycler.state(),
    };
  }

  function changed(force = false) {
    const s = state();
    const sig = JSON.stringify({ ...s, status: { ...s.status, checkedAt: 0 } });
    if (!force && sig === lastSent) return;
    lastSent = sig;
    try { emit('account.changed', s); } catch (e) { log('account: emit failed', e); }
  }
  const recycler = createRecycler({ engine: opts.engine, onChange: () => changed(), log, now, pollMs: opts.recyclePollMs, maxMs: opts.recycleMaxMs });

  async function setApiKey(p = {}) {
    if (!p || typeof p !== 'object' || !('key' in p)) throw bad('key is required: the API key, or null to clear it');
    const next = p.key === null || p.key === '' ? null : cleanKey(p.key);
    if (!canSave) throw err('This Helm has no profile to save an API key in.', 'unsupported');
    const before = savedKey();
    settings.setApiKey(next);
    log(next ? 'account: API key saved' : "account: API key cleared (sessions use Claude Code's sign-in)");   // never the key itself
    changed(true);
    // new credentials for Helm's own CLIs (same key again: nothing to restart)
    if (before !== savedKey()) recycler.recycle('apiKey');
    // back on Claude Code's sign-in: show what it is now
    if (!next && signIn.state !== 'unchecked') checkSignIn().catch(() => {});
    return state();
  }

  const methods = {
    'account.status': async (p = {}) => {
      if ((p && p.refresh) || signIn.state === 'unchecked') await checkSignIn();
      return state();
    },
    'account.setApiKey': (p) => setApiKey(p || {}),
  };

  return {
    id: 'account',
    capabilities: { ...CAPABILITIES },
    methods,
    state,
    public: () => { const s = state(); return { provider: s.provider, capabilities: s.capabilities, usageLimits: s.usageLimits, ready: s.ready, reason: s.reason }; },
    get usageLimits() { return usageLimits(); },
    mode,
    // every claude child Helm starts: the user's env as it is (claude-code), plus the saved key (api-key)
    childEnv: (e) => { if (mode() === 'api-key') { const k = savedKey(); if (k) e.ANTHROPIC_API_KEY = k; } return e; },
    startBlock,
    checkSignIn,
    noteAuthError,
    start: () => {
      clearTimeout(startTimer);
      startTimer = setTimeout(() => checkSignIn().catch(() => {}), opts.startDelayMs != null ? opts.startDelayMs : START_DELAY_MS);
      if (startTimer.unref) startTimer.unref();
    },
    stop: () => { stopped = true; clearTimeout(startTimer); recycler.stop(); if (checkChild) killTree(checkChild); },
    _recycle: (reason) => recycler.recycle(reason),
  };
}

module.exports = { createAccount, createRecycler, cleanKey, describeStatus, NOT_SIGNED_IN, KEY_FIX };
