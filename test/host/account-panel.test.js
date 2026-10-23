// Settings -> Account (ui/shell/account.js) rendered in plain node (test/host/fixtures/ui-render.mjs, no DOM).
// Helm never signs in: by default sessions use the installed Claude Code's own sign-in (shown read-only, with
// Check again = account.status { refresh: true }); an API key saved here switches them to the key, and removing
// it switches back. No control or text offers a sign-in. lane account.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ACCOUNT = path.join(__dirname, '..', '..', 'ui', 'shell', 'account.js');
let ui, AccountSettings;
before(async () => {
  ui = await import('./fixtures/ui-render.mjs');
  if (!ui.available) return;
  ({ AccountSettings } = await ui.importUnderTest(ACCOUNT));
});
const needHooks = (t) => { if (!ui.available) { t.skip('node:module registerHooks is missing in this node'); return true; } return false; };

const NOT_SIGNED_IN = "Claude Code isn't signed in. Open a terminal, run `claude`, and sign in there; then press Check again.";
const CC = {
  in: { state: 'signed-in', checking: false, loggedIn: true, kind: 'subscription', plan: 'Max', methodLabel: 'Claude account (claude.ai)', email: 'sam.rivera@example.com', orgName: null, reason: null, source: 'auth-status', checkedAt: 1 },
  out: { state: 'signed-out', checking: false, loggedIn: false, kind: 'none', plan: null, methodLabel: null, email: null, orgName: null, reason: NOT_SIGNED_IN, source: 'auth-status', checkedAt: 1 },
  unknown: { state: 'unknown', checking: false, loggedIn: null, kind: null, plan: null, methodLabel: null, email: null, orgName: null, reason: 'Claude Code was not found on this PC.', source: null, checkedAt: 1 },
  unchecked: { state: 'unchecked', checking: false, loggedIn: null, kind: null, plan: null, methodLabel: null, email: null, orgName: null, reason: null, source: null, checkedAt: null },
};
const NO_KEY = { ok: true, apiKeySet: false, apiKeyLast4: null, apiKeySource: null, keyError: null, canSave: true, checkedAt: 1 };
const HELM_KEY = { ...NO_KEY, apiKeySet: true, apiKeyLast4: 'Mk7Q', apiKeySource: 'helm' };
const CAPS = { apiKey: true, login: false };
const ccState = (cc, extra = {}) => ({ provider: 'claude-code', capabilities: CAPS, usageLimits: true, ready: cc.state !== 'signed-out' && cc.state !== 'unknown',
  reason: cc.state === 'signed-out' ? NOT_SIGNED_IN : null, status: NO_KEY, claudeCode: cc, restart: null, ...extra });
const keyState = (status = HELM_KEY, extra = {}) => ({ provider: 'api-key', capabilities: CAPS, usageLimits: false, ready: !status.keyError,
  reason: status.keyError || null, status, claudeCode: CC.in, restart: null, ...extra });

// Mount with rpc answering through `impl(method, params)` (or a fixed account.status reply), settle, return the harness.
async function show(st, impl) {
  ui.reset();
  ui.R.rpcImpl = impl || (async (m, p) => { if (m === 'account.status') return typeof st === 'function' ? st(p) : st; throw new Error(`unexpected ${m}`); });
  ui.mount(AccountSettings);
  await ui.settle();
  return ui;
}

// Never a sign-in: no such control, no such button text, no CLI sign-in command.
const BANNED_ACTS = ['acct-signin', 'acct-signout', 'acct-switch', 'acct-login', 'acct-logout', 'acct-signout-confirm', 'acct-code', 'acct-cancel', 'acct-open-link'];
const CLI_SIGNIN = ['auth', 'log' + 'in'].join(' ');   // built, so the repo scan (no-login.test.js) does not flag this guard
function noSignIn(u, label) {
  assert.ok(u.findAll((n) => n.t === 'button').length > 0, label + ': the guard sees the buttons');
  const acts = u.findAll((n) => typeof n.p['data-act'] === 'string').map((n) => n.p['data-act']);
  for (const a of acts) assert.ok(!BANNED_ACTS.includes(a) && !/sign-?in|sign-?out|login|logout|switch/i.test(a), `${label}: no ${a} control`);
  for (const b of u.findAll((n) => n.t === 'button' || n.t === 'a')) {
    assert.doesNotMatch(u.text([b]), /sign\s?in|sign\s?out|log\s?in|log\s?out|switch account/i, `${label}: a control reads "${u.text([b])}"`);
  }
  assert.doesNotMatch(u.text(), /\bSign (in|out)\b|\bLog (in|out)\b|Switch account/, `${label}: no sign-in wording`);
  assert.ok(!u.text().includes(CLI_SIGNIN) && !u.json().includes(CLI_SIGNIN), `${label}: no CLI sign-in command`);
}

test('the source offers no sign-in and has no local panel loader', () => {
  const src = require('fs').readFileSync(ACCOUNT, 'utf8');
  for (const s of [CLI_SIGNIN, 'Sign in', 'Sign out', 'Log in', 'Switch account', 'account.login', 'account.logout', 'loginCode', 'loginCancel', '/local/', 'createAccountUI', 'Subscription' + 'Account', 'provider' + 'Error', 'import(']) {
    assert.ok(!src.includes(s), `ui/shell/account.js still contains "${s}"`);
  }
});

test('default mode, Claude Code signed in: in use, who it is, Check again calls account.status { refresh: true }', async (t) => {
  if (needHooks(t)) return;
  let n = 0;
  const u = await show((p) => ccState(p && p.refresh ? { ...CC.in, email: 'after.check@example.com' } : CC.in, { n: ++n }));
  assert.equal(u.findAll(u.byState('in-use-claude-code')).length, 1);
  assert.match(u.text(), /In use: Claude Code's sign-in/);
  assert.equal(u.findAll(u.byState('cc-signed-in')).length, 1);
  assert.ok(u.findAll((n) => n.p && n.p.name === 'check').length >= 1, 'the in-use line has its check mark while signed in');
  assert.match(u.text(), /sam\.rivera@example\.com/);
  assert.match(u.text(), /Max · Claude account \(claude\.ai\)/);
  assert.equal(u.findAll(u.byAct('acct-key-input')).length, 1, 'the key form is there');
  assert.match(u.text(), /Use an API key instead/);
  assert.equal(u.findAll(u.byAct('acct-key-clear')).length, 0, 'nothing to remove in the default mode');
  assert.equal(u.findAll(u.byState('no-limits')).length, 0);
  noSignIn(u, 'signed in');
  u.click('acct-check');
  await u.settle();
  assert.deepEqual(u.R.rpcLog, [['account.status', {}], ['account.status', { refresh: true }]]);
  assert.match(u.text(), /after\.check@example\.com/, 'the refreshed answer is shown');
});

test('default mode, Claude Code signed out: the state and the host reason, text only, and Check again', async (t) => {
  if (needHooks(t)) return;
  const u = await show(ccState(CC.out));
  assert.equal(u.findAll(u.byState('cc-signed-out')).length, 1);
  // The heading says "isn't signed in"; the line under it starts at what to do, so neither is said twice.
  const what = NOT_SIGNED_IN.replace(/^Claude Code isn't signed in\.\s*/, '');
  assert.equal(u.text().split("Claude Code isn't signed in").length - 1, 1, 'signed out is said once, in the heading');
  assert.ok(u.text().includes(what), 'what to do, verbatim');
  assert.equal(u.text().split(what).length - 1, 1, 'what to do is said once (the ready=false reason is the same text)');
  assert.equal(u.findAll((n) => n.p && n.p.name === 'check').length, 0, 'no check mark on the in-use line while signed out');
  assert.equal(u.findAll(u.byAct('acct-check')).length, 1);
  noSignIn(u, 'signed out');
  u.click('acct-check');
  await u.settle();
  assert.deepEqual(u.R.rpcLog.at(-1), ['account.status', { refresh: true }]);

  const s = await show(ccState({ ...CC.out, source: 'session' }));
  assert.match(s.text(), /A session reported this when it started/);
});

test('default mode, could not check / not checked yet / signed in with a Console key', async (t) => {
  if (needHooks(t)) return;
  let u = await show(ccState(CC.unknown, { ready: false, reason: "Helm couldn't check Claude Code's sign-in: Claude Code was not found on this PC." }));
  assert.equal(u.findAll(u.byState('cc-unknown')).length, 1);
  assert.match(u.text(), /Helm couldn't check Claude Code's sign-in/);
  assert.match(u.text(), /Claude Code was not found on this PC\./);
  assert.equal(u.findAll(u.byAct('acct-check')).length, 1);
  noSignIn(u, 'unknown');

  for (const cc of [CC.unchecked, { ...CC.in, checking: true }]) {
    u = await show(ccState(cc));
    assert.equal(u.findAll(u.byState('cc-checking')).length, 1, cc.state);
    assert.match(u.text(), /Checking Claude Code's sign-in…/);
    assert.equal(u.findAll(u.byAct('acct-check'))[0].p.disabled, true, 'Check again waits for the running check');
  }

  u = await show(ccState({ ...CC.in, kind: 'console', plan: 'Console (API billing)', methodLabel: 'Anthropic Console account', orgName: 'Example Org' }, { usageLimits: false }));
  assert.equal(u.findAll(u.byState('cc-signed-in')).length, 1);
  assert.match(u.text(), /Console \(API billing\) · Anthropic Console account · Example Org/);
  assert.equal(u.findAll(u.byState('no-limits')).length, 1, 'says there are no 5-hour/weekly limits');
});

test('API-key mode: in-use label with last4, Claude Code labelled as the fallback, remove asks first then setApiKey { key: null }', async (t) => {
  if (needHooks(t)) return;
  const calls = [];
  const u = await show(null, async (m, p) => {
    calls.push([m, p]);
    if (m === 'account.status') return keyState(HELM_KEY, { restart: { at: Date.now(), reason: 'apiKey', restarted: 2, waiting: 0 } });
    if (m === 'account.setApiKey') return ccState(CC.in, { restart: { at: Date.now(), reason: 'apiKey', restarted: 2, waiting: 0 } });
    throw new Error(m);
  });
  assert.equal(u.findAll(u.byState('in-use-key')).length, 1);
  assert.match(u.text(), /In use: an API key/);
  assert.match(u.text(), /API key ••••Mk7Q/);
  assert.match(u.text(), /Claude Code's own sign-in \(used if you remove the key\)/);
  assert.equal(u.findAll(u.byState('cc-signed-in')).length, 1);
  assert.match(u.text(), /2 sessions restarted with the new key/);
  noSignIn(u, 'api key');
  u.click('acct-key-clear');
  await u.settle();
  assert.match(u.text(), /Remove the saved key and use Claude Code's sign-in\? Running sessions restart onto it\./);
  assert.ok(!calls.some(([m]) => m === 'account.setApiKey'), 'nothing removed before the confirm');
  u.click('acct-key-clear-confirm');
  await u.settle();
  assert.deepEqual(calls.at(-1), ['account.setApiKey', { key: null }]);
  assert.equal(u.findAll(u.byState('in-use-claude-code')).length, 1, 'back to Claude Code\'s sign-in');
  assert.match(u.text(), /2 sessions restarted onto Claude Code's sign-in/);
  assert.equal(u.R.toasts.at(-1).title, "API key removed: sessions use Claude Code's sign-in");
});

test('a saved key that cannot be read: says why and can be removed', async (t) => {
  if (needHooks(t)) return;
  const keyError = 'The saved API key could not be decrypted on this PC. Enter it again, or remove it.';
  const u = await show(keyState({ ...NO_KEY, keyError }));
  assert.equal(u.findAll(u.byState('in-use-key-error')).length, 1);
  assert.equal(u.findAll(u.byState('key-error')).length, 1);
  assert.equal(u.text().split(keyError).length - 1, 1, 'the key error is said once');
  assert.equal(u.findAll(u.byAct('acct-key-clear'))[0].p.disabled, false);
  noSignIn(u, 'key error');
});

test('an older host with no claudeCode: the key part, and a note to restart Helm', async (t) => {
  if (needHooks(t)) return;
  const st = keyState(NO_KEY, { ready: false, reason: 'No Anthropic API key: add one in Settings > Account.' });
  delete st.claudeCode;
  let u = await show(st);
  assert.equal(u.findAll(u.byState('old-host')).length, 1);
  assert.match(u.text(), /Helm's host is older than this window.*Restart Helm/);
  assert.equal(u.findAll(u.byAct('acct-key-input')).length, 1);
  assert.equal(u.findAll(u.byAct('acct-check')).length, 0);
  assert.equal(u.findAll(u.byState('not-ready')).length, 1, 'the host reason is shown');
  noSignIn(u, 'old host');
  u = await show({ status: HELM_KEY, restart: null });   // no provider either
  assert.match(u.text(), /API key ••••Mk7Q/);
  assert.equal(u.findAll(u.byState('old-host')).length, 1);
});

test('the key never appears in a render: the input is not prefilled and is cleared after saving', async (t) => {
  if (needHooks(t)) return;
  const KEY = 'sk-test-0000-example-ZZ99';
  const calls = [];
  const u = await show(null, async (m, p) => {
    calls.push([m, p]);
    if (m === 'account.status') return ccState(CC.in);
    if (m === 'account.setApiKey') return keyState({ ...HELM_KEY, apiKeyLast4: p.key.slice(-4) });
    throw new Error(m);
  });
  assert.equal(u.findAll(u.byAct('acct-key-input'))[0].p.value, '', 'not prefilled');
  assert.equal(u.findAll(u.byAct('acct-key-input'))[0].p.type, 'password');
  u.input('acct-key-input', KEY);
  await u.settle();
  assert.ok(!u.text().includes(KEY), 'never shown as text while typing');
  u.submit((n) => n.t === 'form');
  await u.settle();
  assert.deepEqual(calls.at(-1), ['account.setApiKey', { key: KEY }]);
  assert.ok(!u.json().includes(KEY), 'gone from the tree after saving');
  assert.match(u.text(), /API key ••••ZZ99/);
  assert.ok(!JSON.stringify(u.R.toasts).includes(KEY));
  for (const st of [ccState(CC.in), ccState(CC.out), keyState(), keyState({ ...NO_KEY, keyError: 'x' })]) {
    const v = await show(st);
    assert.ok(!v.json().includes(KEY));
  }
});

test('loading, and an account.status error with Try again', async (t) => {
  if (needHooks(t)) return;
  ui.reset();
  ui.R.rpcImpl = () => new Promise(() => {});
  ui.mount(AccountSettings);
  await ui.settle();
  assert.match(ui.text(), /Checking how Helm's sessions reach Claude…/);
  ui.reset();
  ui.R.rpcImpl = async () => { throw new Error('socket closed'); };
  ui.mount(AccountSettings);
  await ui.settle();
  assert.equal(ui.findAll(ui.byState('rpc-error')).length, 1);
  assert.match(ui.text(), /Could not check the account.*socket closed/);
  ui.click('acct-retry');
  await ui.settle();
  assert.deepEqual(ui.R.rpcLog.at(-1), ['account.status', { refresh: true }]);
});
