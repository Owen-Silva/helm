// Mock (?mock=1) for Settings -> Account: account.status / account.setApiKey (PROTOCOL "Account"). Helm never signs
// in: by default its sessions use the installed Claude Code's own sign-in (read-only status, `claudeCode`); a key
// saved in Settings -> Account switches them to that key. Made-up people and key endings only. Start state:
//   ?account=cc-signed-in (default) | cc-signed-out | cc-unknown | cc-console (Claude Code signed in with a Console
//   key: no 5-hour/weekly limits) | key-helm (a key saved in Helm) | key-error (a saved key that can't be read)
//   | old-host (a host older than this window: no `claudeCode`, no provider)
// Events go out through the mock transport's emit (window.__helmMock.emit).
// Owner: lane account.
const now = () => Date.now();

let mode = 'cc-signed-in';
try { mode = new URLSearchParams(location.search).get('account') || 'cc-signed-in'; } catch {}

export const NOT_SIGNED_IN = "Claude Code isn't signed in. Open a terminal, run `claude`, and sign in there; then press Check again.";
const EMAIL = 'sam.rivera@example.com';
const CC = {
  'signed-in': { state: 'signed-in', loggedIn: true, kind: 'subscription', plan: 'Max', methodLabel: 'Claude account (claude.ai)', email: EMAIL, orgName: null, reason: null, source: 'auth-status' },
  'signed-out': { state: 'signed-out', loggedIn: false, kind: 'none', plan: null, methodLabel: null, email: null, orgName: null, reason: NOT_SIGNED_IN, source: 'auth-status' },
  unknown: { state: 'unknown', loggedIn: null, kind: null, plan: null, methodLabel: null, email: null, orgName: null, reason: 'Claude Code was not found on this PC (no `claude` on PATH).', source: null },
  console: { state: 'signed-in', loggedIn: true, kind: 'console', plan: 'Console (API billing)', methodLabel: 'Anthropic Console account', email: EMAIL, orgName: 'Example Org', reason: null, source: 'auth-status' },
};
const ccFor = (m) => ({ checking: false, checkedAt: now(), ...(CC[m.replace(/^cc-/, '')] || CC['signed-in']) });

const keyStatus = (last4, keyError = null) => ({ ok: true, apiKeySet: !!last4, apiKeyLast4: last4 || null, apiKeySource: last4 ? 'helm' : null,
  keyError, canSave: true, checkedAt: now() });

const S = {
  status: mode === 'key-helm' ? keyStatus('Mk7Q')
    : mode === 'key-error' ? keyStatus(null, 'The saved API key could not be decrypted on this PC. Enter it again, or remove it.')
      : keyStatus(null),
  claudeCode: mode === 'old-host' ? undefined : ccFor(/^cc-/.test(mode) ? mode : 'cc-signed-in'),
  restart: null,
};
let timer = null;

// The provider part of account.status / account.changed and app.hello `auth`.
function provider() {
  if (mode === 'old-host') return { provider: 'api-key', capabilities: { apiKey: true, login: false }, usageLimits: false, ready: !!S.status.apiKeySet,
    reason: S.status.apiKeySet ? null : 'No Anthropic API key: add one in Settings > Account.' };
  const keyMode = !!(S.status.apiKeySet || S.status.keyError);
  const cc = S.claudeCode;
  const ready = keyMode ? !S.status.keyError : cc.state !== 'signed-out' && cc.state !== 'unknown';
  const reason = keyMode ? S.status.keyError : cc.state === 'signed-out' ? NOT_SIGNED_IN : cc.state === 'unknown' ? `Helm couldn't check Claude Code's sign-in: ${cc.reason}` : null;
  const usageLimits = !keyMode && cc.kind !== 'console' && cc.kind !== 'api_key';
  return { provider: keyMode ? 'api-key' : 'claude-code', capabilities: { apiKey: true, login: false }, usageLimits, ready, reason: ready ? null : reason };
}
// app.hello `auth`
export const accountHelloAuth = () => provider();

const fail = (message, code) => Object.assign(new Error(message), { code });
const snap = () => ({ ...provider(), status: S.status, ...(S.claudeCode ? { claudeCode: { ...S.claudeCode } } : {}), restart: S.restart && { ...S.restart } });
function changed() { try { window.__helmMock?.emit('account.changed', snap()); } catch {} }
function finish(reason) {
  S.restart = { at: now(), reason, restarted: 2, waiting: 1 };
  changed();
  clearTimeout(timer);
  timer = setTimeout(() => { S.restart = { ...S.restart, restarted: 3, waiting: 0 }; changed(); }, 4000);
}

export function accountMock(method, p = {}) {
  switch (method) {
    case 'account.setApiKey': {   // lane opensource-auth
      if (p.key === null) {
        S.status = keyStatus(null);
      } else {
        const k = typeof p.key === 'string' ? p.key.trim() : '';
        if (!k) throw fail('Paste an API key first.', 'bad_params');
        if (/\s/.test(k)) throw fail('An API key has no spaces or line breaks in it. Copy it again from the Anthropic Console.', 'bad_params');
        if (k.length > 400) throw fail('That is too long to be an API key.', 'bad_params');
        S.status = keyStatus(k.slice(-4));
      }
      finish('apiKey');
      return snap();
    }
    case 'account.status':
      S.status = { ...S.status, checkedAt: now() };
      if (!p.refresh || !S.claudeCode) return snap();
      // refresh: true re-runs Claude Code's read-only status check first (here: a short wait, same answer).
      S.claudeCode = { ...S.claudeCode, checking: true };
      changed();
      return new Promise((r) => setTimeout(() => { S.claudeCode = { ...S.claudeCode, checking: false, checkedAt: now() }; changed(); r(snap()); }, 700));
    default: throw fail(`mock: no handler for ${method}`, 'unknown_method');
  }
}
