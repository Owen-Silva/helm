// Settings -> Account, host side (main/account.js, main/claude-cli.js; PROTOCOL "Account"). Helm never signs in:
// by default its claude children run on whatever the user's Claude Code is signed in with (the user's env passed
// through, no auth variable added or removed); an API key saved in Settings > Account is the only thing Helm adds.
// Claude Code's sign-in is read with its own read-only status command. The CLI here is a fake: node running a
// small script that answers `auth status --json` from a state file. The SDK is test/engine/fake-sdk.js.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAccount, cleanKey, describeStatus, NOT_SIGNED_IN, KEY_FIX } = require('../../main/account.js');
const { baseChildEnv, buildChildEnv, NESTED_MARKERS } = require('../../main/claude-cli.js');
const { createSettings } = require('../../main/settings.js');
const { createRouter } = require('../../main/rpc.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-account-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const mk = (p) => fs.mkdtempSync(path.join(root, p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 4000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(5); } };

const FAKE_KEY = 'sk-ant-api03-FAKEfakeFAKEfake0000-test-only-wxyz';
const OTHER_KEY = 'sk-ant-api03-OTHERotherOTHER1111-test-only-abcd';
const FAKE_OAUTH = 'fake-oauth-value-test-only';
// Every variable a user may set to choose how Claude Code authenticates or where it reads its config: in the
// default mode each must reach the claude child exactly as the user set it.
const USER_AUTH_ENV = {
  ANTHROPIC_API_KEY: OTHER_KEY, CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH, ANTHROPIC_AUTH_TOKEN: 'fake-auth-token', ANTHROPIC_BASE_URL: 'https://example.invalid',
  CLAUDE_CONFIG_DIR: path.join(root, 'cfg'), CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', AWS_PROFILE: 'p', ANTHROPIC_MODEL: 'm',
};

// The fake Claude Code: `auth status --json` answers from FAKE_AUTH_STATE; each call is logged (argv + what env it saw).
const FAKE_CLI = path.join(root, 'fake-claude.js');
fs.writeFileSync(FAKE_CLI, `
const fs = require('fs');
const st = fs.readFileSync(process.env.FAKE_AUTH_STATE, 'utf8').trim();
fs.appendFileSync(process.env.FAKE_AUTH_LOG, JSON.stringify({ argv: process.argv.slice(2), nested: 'CLAUDECODE' in process.env,
  tag: process.env.CLAUDE_AGENT_SDK_CLIENT_APP || null, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN || null, key: process.env.ANTHROPIC_API_KEY || null }) + '\\n');
const out = {
  in: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'sam.rivera@example.com', orgId: 'org-id-not-for-clients',
        orgName: 'Example Org', subscriptionType: 'max', configDirectory: '/not/for/clients', projectsDirectory: '/not/for/clients/projects' },
  out: { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' },
  console: { loggedIn: true, authMethod: 'console', apiProvider: 'firstParty', email: 'sam.rivera@example.com' },
  envkey: { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' },
  bedrock: { loggedIn: false, authMethod: 'none', apiProvider: 'bedrock' },
}[st];
if (st === 'broken') { process.stderr.write('Error: something broke\\n'); process.exit(2); }
else if (st === 'hang') setTimeout(() => {}, 60000);
else { process.stdout.write(JSON.stringify(out, null, 2)); process.exit(out.loggedIn ? 0 : 1); }
`);

// A real settings store in a temp profile + the provider over it, with the fake CLI. Every event and log line is
// kept so the tests can prove the key never shows up in any of them.
function setup({ env: extraEnv = {}, cli = 'in', engine, secretBox, claudePath = process.execPath, ...rest } = {}) {
  const userDataDir = mk('ud-');
  const stateFile = path.join(userDataDir, 'fake-state');
  const cliLog = path.join(userDataDir, 'fake-log.jsonl');
  fs.writeFileSync(stateFile, cli);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '', FAKE_AUTH_STATE: stateFile, FAKE_AUTH_LOG: cliLog, ...extraEnv };
  const events = [];
  const logs = [];
  const log = (...a) => logs.push(a.map(String).join(' '));
  const settings = createSettings({ userDataDir, uiBgDir: null, emit: (ev, d) => events.push([ev, d]), log, home: userDataDir, appDataDir: userDataDir, secretBox });
  const acct = createAccount({ settings, env, engine, claudePath, claudeArgs: [FAKE_CLI], emit: (ev, d) => events.push([ev, d]), log, recyclePollMs: 20, ...rest });
  const setCli = (s) => fs.writeFileSync(stateFile, s);
  const calls = () => (fs.existsSync(cliLog) ? fs.readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const leaks = () => {
    const files = fs.readdirSync(userDataDir).filter((f) => f !== 'api-key.json' && fs.statSync(path.join(userDataDir, f)).isFile())
      .map((f) => fs.readFileSync(path.join(userDataDir, f), 'utf8'));
    return [JSON.stringify(events), logs.join('\n'), JSON.stringify(acct.state()), JSON.stringify(settings.get()), ...files].filter((t) => t.includes(FAKE_KEY));
  };
  return { acct, settings, events, logs, userDataDir, leaks, setCli, calls, env };
}

// ---------- the env builder ----------
test('env builder, default mode: the user env passes through; no auth variable is added or removed', () => {
  const { acct } = setup();
  assert.equal(acct.mode(), 'claude-code');
  const userEnv = { PATH: 'p', HOME: 'h', ...USER_AUTH_ENV, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' };
  const out = buildChildEnv((e) => acct.childEnv(e), userEnv);
  const expected = { ...userEnv, CLAUDE_AGENT_SDK_CLIENT_APP: 'helm/0.1.0' };
  for (const k of NESTED_MARKERS) delete expected[k];
  assert.deepEqual(out, expected, 'exactly the user env, minus the two nested-terminal markers, plus the client tag');
  for (const [k, v] of Object.entries(USER_AUTH_ENV)) assert.equal(out[k], v, `${k} passes through unchanged`);
  // an env with no auth variables gets none
  const bare = buildChildEnv((e) => acct.childEnv(e), { PATH: 'p' });
  assert.deepEqual(bare, { PATH: 'p', CLAUDE_AGENT_SDK_CLIENT_APP: 'helm/0.1.0' });
  assert.deepEqual(NESTED_MARKERS, ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'], 'only the nested-session markers are removed, nothing that authenticates');
  // a fresh copy: the user env object is never changed
  assert.equal(userEnv.CLAUDECODE, '1');
  assert.deepEqual(baseChildEnv({ A: '1' }), { A: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'helm/0.1.0' });
});

test('env builder, API-key mode: ANTHROPIC_API_KEY is the saved key; everything else is the user env', async () => {
  const { acct, leaks } = setup();
  await acct.methods['account.setApiKey']({ key: FAKE_KEY });
  assert.equal(acct.mode(), 'api-key');
  const userEnv = { PATH: 'p', ...USER_AUTH_ENV };
  const out = buildChildEnv((e) => acct.childEnv(e), userEnv);
  assert.deepEqual(out, { ...userEnv, ANTHROPIC_API_KEY: FAKE_KEY, CLAUDE_AGENT_SDK_CLIENT_APP: 'helm/0.1.0' });
  assert.equal(buildChildEnv((e) => acct.childEnv(e), { PATH: 'p' }).ANTHROPIC_API_KEY, FAKE_KEY, 'set even when the user env has none');
  assert.deepEqual(leaks(), []);
  acct.stop();
});

// ---------- Claude Code's sign-in ----------
test('default mode before any check: Claude Code\'s sign-in, ready, no sign-in methods, login capability off', async () => {
  const { acct, calls } = setup();
  const st = acct.state();
  assert.equal(st.provider, 'claude-code');
  assert.deepEqual(st.capabilities, { apiKey: true, login: false });
  assert.equal(st.ready, true);
  assert.equal(st.claudeCode.state, 'unchecked');
  assert.equal(st.usageLimits, true);
  assert.equal(acct.startBlock(), null, 'not known to be signed out: nothing is blocked');
  assert.deepEqual(Object.keys(acct.methods).sort(), ['account.setApiKey', 'account.status']);
  assert.equal(calls().length, 0, 'no CLI run until something asks (or start())');
});

test('signed in with a Claude account: the status check is read-only, keeps only non-secret fields, env passed through', async () => {
  const { acct, calls, events } = setup({ env: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH, CLAUDECODE: '1' } });
  const st = await acct.methods['account.status']({});   // the first status call runs the check
  assert.equal(st.claudeCode.state, 'signed-in');
  assert.equal(st.claudeCode.kind, 'subscription');
  assert.equal(st.claudeCode.plan, 'Max');
  assert.equal(st.claudeCode.methodLabel, 'Claude account (claude.ai)');
  assert.equal(st.claudeCode.email, 'sam.rivera@example.com');
  assert.equal(st.claudeCode.orgName, 'Example Org');
  assert.equal(st.claudeCode.source, 'auth-status');
  assert.equal(st.ready, true);
  assert.equal(st.usageLimits, true, 'a Claude subscription has 5-hour / weekly windows');
  const all = JSON.stringify(st) + JSON.stringify(events);
  for (const s of ['org-id-not-for-clients', '/not/for/clients']) assert.equal(all.includes(s), false, `${s} never reaches a client`);
  const c = calls();
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].argv, ['auth', 'status', '--json'], 'only the read-only status command');
  assert.equal(c[0].oauth, FAKE_OAUTH, 'the user env reaches the check as it is');
  assert.equal(c[0].nested, false);
  assert.equal(c[0].tag, 'helm/0.1.0');
  // cached: a plain status call does not run the CLI again; refresh does
  await acct.methods['account.status']({});
  assert.equal(calls().length, 1);
  await acct.methods['account.status']({ refresh: true });
  assert.equal(calls().length, 2);
  assert.ok(events.some(([ev, d]) => ev === 'account.changed' && d.claudeCode.checking === true), 'clients see the check running');
});

test('signed out: state AND reason, sessions refused with it; signing in in a terminal then Check again clears it', async () => {
  const { acct, setCli } = setup({ cli: 'out' });
  const st = await acct.methods['account.status']({});
  assert.equal(st.claudeCode.state, 'signed-out');
  assert.equal(st.claudeCode.reason, NOT_SIGNED_IN);
  assert.equal(st.ready, false);
  assert.equal(st.reason, NOT_SIGNED_IN);
  assert.match(NOT_SIGNED_IN, /Open a terminal, run `claude`, and sign in there; then press Check again/);
  assert.deepEqual(acct.startBlock(), { code: 'auth_required', message: NOT_SIGNED_IN });
  assert.deepEqual(acct.public(), { provider: 'claude-code', capabilities: { apiKey: true, login: false }, usageLimits: true, ready: false, reason: NOT_SIGNED_IN });
  setCli('in');
  const again = await acct.methods['account.status']({ refresh: true });
  assert.equal(again.ready, true);
  assert.equal(acct.startBlock(), null);
});

test('a stale signed-out answer is looked at again when a start is refused', async () => {
  const { acct, setCli, calls } = setup({ cli: 'out', staleMs: 1 });
  await acct.checkSignIn();
  setCli('in');
  await sleep(5);
  assert.equal(acct.startBlock().code, 'auth_required', 'this start still waits');
  await until(() => acct.state().claudeCode.state === 'signed-in');
  assert.equal(acct.startBlock(), null, 'the next one goes');
  assert.equal(calls().length, 2);
});

test('signed in with a Console login, an API key Claude Code reads itself, or a cloud provider: no 5-hour windows', async () => {
  for (const [cli, kind, plan] of [['console', 'console', 'Console (API billing)'], ['envkey', 'api_key', 'API key'], ['bedrock', 'provider', 'Amazon Bedrock']]) {
    const { acct } = setup({ cli });
    const st = await acct.methods['account.status']({});
    assert.equal(st.claudeCode.state, 'signed-in', cli);
    assert.equal(st.claudeCode.kind, kind, cli);
    assert.equal(st.claudeCode.plan, plan, cli);
    assert.equal(st.usageLimits, false, cli);
    assert.equal(st.ready, true, cli);
  }
});

test('the check cannot run (no CLI, an error, no answer): unknown with the reason, nothing blocked', async () => {
  const missing = setup({ claudePath: path.join(root, 'no-such-claude.exe') });
  let st = await missing.acct.methods['account.status']({});
  assert.equal(st.claudeCode.state, 'unknown');
  assert.match(st.claudeCode.reason, /^Helm couldn't check Claude Code's sign-in: Claude Code was not found at .*no-such-claude\.exe/);
  assert.equal(st.ready, true, 'not known to be signed out: Claude Code\'s own error will say');
  const none = setup({ claudePath: null });
  assert.match((await none.acct.methods['account.status']({})).claudeCode.reason, /Claude Code was not found\. Install it/);
  const broken = setup({ cli: 'broken' });
  st = await broken.acct.methods['account.status']({});
  assert.equal(st.claudeCode.state, 'unknown');
  assert.match(st.claudeCode.reason, /something broke/);
  const hang = setup({ cli: 'hang', statusTimeoutMs: 300 });
  st = await hang.acct.methods['account.status']({});
  assert.equal(st.claudeCode.state, 'unknown');
  assert.match(st.claudeCode.reason, /did not answer in 0 s|did not answer/);
  assert.equal(st.ready, true);
});

test('a session says "Not logged in": the sign-in is checked again; without a working check the session\'s word counts', async () => {
  const a = setup({ cli: 'out' });
  a.acct.noteAuthError('Not logged in · Please run /login');
  await until(() => a.acct.state().claudeCode.state === 'signed-out');
  assert.equal(a.acct.state().claudeCode.source, 'auth-status');
  assert.equal(a.calls().length, 1);
  const b = setup({ claudePath: path.join(root, 'no-such-claude.exe') });
  b.acct.noteAuthError('Not logged in · Please run /login');
  await until(() => b.acct.state().claudeCode.state === 'signed-out');
  assert.equal(b.acct.state().claudeCode.source, 'session');
  assert.equal(b.acct.state().reason, NOT_SIGNED_IN);
  // in API-key mode a failure is the key's: no sign-in check
  const c = setup();
  await c.acct.methods['account.setApiKey']({ key: FAKE_KEY });
  c.acct.noteAuthError('Invalid API key · Please run /login');
  await sleep(50);
  assert.equal(c.calls().length, 0);
  c.acct.stop();
});

test('describeStatus keeps only what Settings shows', () => {
  const d = describeStatus({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', email: 'a@example.com', orgId: 'x', configDirectory: 'y', projectsDirectory: 'z' });
  assert.deepEqual(Object.keys(d).sort(), ['email', 'kind', 'loggedIn', 'methodLabel', 'orgName', 'plan']);
  assert.equal(d.plan, 'Pro');
  assert.equal(describeStatus({ loggedIn: false }).kind, 'none');
});

// ---------- the API key ----------
test('setApiKey: switches to the key; it is passed to children and hidden everywhere else; clearing switches back', async () => {
  const { acct, settings, leaks, events } = setup();
  let st = await acct.methods['account.setApiKey']({ key: ` ${FAKE_KEY} ` });
  assert.equal(st.provider, 'api-key');
  assert.equal(st.ready, true);
  assert.equal(st.usageLimits, false);
  assert.deepEqual({ ...st.status, checkedAt: 0 }, { ok: true, apiKeySet: true, apiKeyLast4: 'wxyz', apiKeySource: 'helm', keyError: null, canSave: true, checkedAt: 0 });
  assert.equal(settings.getApiKey(), FAKE_KEY);
  assert.equal(acct.childEnv({}).ANTHROPIC_API_KEY, FAKE_KEY);
  assert.ok(events.some(([ev, d]) => ev === 'account.changed' && d.provider === 'api-key'));
  assert.deepEqual(leaks(), []);
  st = await acct.methods['account.setApiKey']({ key: null });
  assert.equal(st.provider, 'claude-code');
  assert.equal(st.status.apiKeySet, false);
  assert.equal('ANTHROPIC_API_KEY' in acct.childEnv({}), false);
  acct.stop();
});

test('the ANTHROPIC_API_KEY Helm was started with is not Helm\'s key: default mode passes it through for Claude Code', () => {
  const { acct } = setup({ env: { ANTHROPIC_API_KEY: OTHER_KEY } });
  const st = acct.state();
  assert.equal(st.provider, 'claude-code');
  assert.equal(st.status.apiKeySet, false);
  assert.equal(JSON.stringify(st).includes(OTHER_KEY), false);
  assert.deepEqual(acct.childEnv({ ANTHROPIC_API_KEY: OTHER_KEY }), { ANTHROPIC_API_KEY: OTHER_KEY });
});

test('setApiKey: rejects what is not an API key, with a reason; a sign-in token is never stored', async () => {
  const { acct, settings } = setup();
  const bad = async (key, re) => assert.rejects(acct.methods['account.setApiKey']({ key }), (e) => e.code === 'bad_params' && re.test(e.message));
  await bad('   ', /Paste an API key/);
  await bad('sk-ant-api03 with spaces', /no spaces/);
  await bad('sk-ant-oat01-abcdefghijklmnop', /sign-in token, not an API key, and Helm doesn't store sign-in tokens/);
  await bad('x'.repeat(600), /longer than an API key/);
  await bad(42, /string/);
  await assert.rejects(acct.methods['account.setApiKey']({}), { code: 'bad_params' });
  assert.equal(cleanKey(` ${FAKE_KEY} `), FAKE_KEY);
  assert.equal(settings.getApiKey(), null, 'nothing was saved');
  assert.equal(acct.state().provider, 'claude-code');
});

test('a key change restarts Helm\'s CLIs (idle now, working after their turn); the same key again does not', async () => {
  let n = 0;
  const engine = { recycleClis: () => { n++; return n === 1 ? { closed: ['s1'], busy: ['s2'] } : { closed: ['s2'], busy: [] }; } };
  const { acct, events } = setup({ engine });
  await acct.methods['account.setApiKey']({ key: FAKE_KEY });
  await until(() => acct.state().restart && acct.state().restart.waiting === 0, 2000);
  assert.deepEqual({ ...acct.state().restart, at: 0 }, { at: 0, reason: 'apiKey', restarted: 2, waiting: 0 });
  assert.ok(events.some(([ev, d]) => ev === 'account.changed' && d.restart && d.restart.waiting === 1));
  const before = n;
  await acct.methods['account.setApiKey']({ key: FAKE_KEY });
  assert.equal(n, before, 'same key: nothing to restart');
  await acct.methods['account.setApiKey']({ key: null });
  assert.ok(n > before, 'back to Claude Code\'s sign-in: restart again');
  acct.stop();
});

test('a saved key this PC cannot decrypt: stays in API-key mode, not ready, says why (never a silent switch)', async () => {
  const box = { available: () => true, encrypt: (t) => Buffer.from(`enc:${Buffer.from(t).toString('hex')}`), decrypt: (b) => Buffer.from(String(b).slice(4), 'hex').toString() };
  const { acct, userDataDir } = setup({ secretBox: box });
  await acct.methods['account.setApiKey']({ key: FAKE_KEY });
  const raw = fs.readFileSync(path.join(userDataDir, 'api-key.json'), 'utf8');
  assert.equal(raw.includes(FAKE_KEY), false);
  assert.equal(JSON.parse(raw).enc, 'os');
  const other = createSettings({ userDataDir, uiBgDir: null, home: userDataDir, appDataDir: userDataDir, secretBox: { available: () => true, encrypt: box.encrypt, decrypt: () => { throw new Error('bad'); } } });
  const acct2 = createAccount({ settings: other, env: { PATH: process.env.PATH }, claudePath: null });
  const st = acct2.state();
  assert.equal(st.provider, 'api-key');
  assert.equal(st.ready, false);
  assert.match(st.status.keyError, /could not be decrypted/);
  assert.equal(st.reason, `${st.status.keyError} ${KEY_FIX}`);
  assert.equal(acct2.startBlock().code, 'auth_required');
  assert.equal('ANTHROPIC_API_KEY' in acct2.childEnv({}), false);
  acct.stop();
});

// ---------- the router ----------
test('router: app.hello says which mode; only account.status / account.setApiKey; the key never leaves the host', async () => {
  const { settings, leaks, env } = setup();
  const engine = { methods: {}, snapshot: async () => ({ sessions: [] }) };
  const router = createRouter({ engine, version: 't', files: {}, queue: { list: () => [] }, settings, accountOptions: { env, claudePath: process.execPath, claudeArgs: [FAKE_CLI] } });
  const c = { platform: 'web' };
  let hello = await router.handle(c, 'app.hello', {});
  assert.deepEqual(hello.auth, { provider: 'claude-code', capabilities: { apiKey: true, login: false }, usageLimits: true, ready: true, reason: null });
  for (const m of ['account.login', 'account.loginCode', 'account.loginCancel', 'account.logout']) {
    assert.equal(m in router.methods, false, m);
    await assert.rejects(router.handle(c, m, {}), { code: 'unknown_method' });
  }
  assert.equal((await router.handle(c, 'account.status', {})).claudeCode.state, 'signed-in');
  await router.handle(c, 'account.setApiKey', { key: FAKE_KEY });
  hello = await router.handle(c, 'app.hello', {});
  assert.equal(hello.auth.provider, 'api-key');
  assert.deepEqual(hello.settings.account, { apiKeySet: true, apiKeyLast4: 'wxyz' });
  assert.equal(JSON.stringify(hello).includes(FAKE_KEY), false);
  assert.equal(JSON.stringify(await router.handle(c, 'settings.get', {})).includes(FAKE_KEY), false);
  await assert.rejects(router.handle(c, 'settings.set', { apiKey: FAKE_KEY }), { code: 'bad_params' });
  assert.deepEqual(leaks(), []);
  router.account.stop();
});

// ---------- the engine: env, refusal, a session's sign-in error ----------
function fakeEngine({ provider, frames }) {
  const { createEngine } = require('../../main/engine');
  const { createFakeSdk, F } = require('../engine/fake-sdk');
  const sdk = createFakeSdk(frames || async function* () {
    for (const f of F.textTurn('m' + Math.random(), 'ok')) yield f;
    yield F.result(0.01);
  }, { projectsDir: mk('proj-') });
  const engine = createEngine({
    userDataDir: mk('eud-'), emit: () => {}, log: () => {}, sdk, claudePath: null, projectsDir: mk('proj2-'), statuslineDir: mk('sl-'), etaDir: false, external: false,
    tempDir: path.join(os.tmpdir(), 'not-the-test-dirs'), childEnv: (env) => provider.childEnv(env), startBlock: () => provider.startBlock(),
    onAuthError: (t) => provider.noteAuthError && provider.noteAuthError(t),
  });
  return { engine, sdk };
}

test('engine, default mode: every claude child gets exactly the user env (+ the client tag, not nested)', async () => {
  const { acct } = setup();
  const { engine, sdk } = fakeEngine({ provider: acct });
  await engine.methods['sessions.create']({ cwd: mk('cwd-'), prompt: 'hello' });
  await until(() => sdk.calls.length > 0);
  const expected = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'helm/0.1.0' };
  for (const k of NESTED_MARKERS) delete expected[k];
  assert.deepEqual(sdk.calls[0].options.env, expected);
  await engine.shutdown();
});

test('engine, API-key mode: every claude child gets ANTHROPIC_API_KEY (and nothing else changes)', async () => {
  const { acct } = setup();
  await acct.methods['account.setApiKey']({ key: FAKE_KEY });
  const { engine, sdk } = fakeEngine({ provider: acct });
  await engine.methods['sessions.create']({ cwd: mk('cwd-'), prompt: 'hello' });
  await until(() => sdk.calls.length > 0);
  const expected = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'helm/0.1.0', ANTHROPIC_API_KEY: FAKE_KEY };
  for (const k of NESTED_MARKERS) delete expected[k];
  assert.deepEqual(sdk.calls[0].options.env, expected);
  await engine.shutdown();
  acct.stop();
});

test('engine: signed out refuses sends, new sessions with a prompt and the probe, with the reason; nothing starts', async () => {
  const { acct } = setup({ cli: 'out' });
  await acct.checkSignIn();
  const { engine, sdk } = fakeEngine({ provider: acct });
  const cwd = mk('cwd-');
  const s = await engine.methods['sessions.create']({ cwd });   // an empty session is fine: no CLI yet
  await assert.rejects(engine.methods['sessions.send']({ id: s.id, text: 'hi' }), (e) => e.code === 'auth_required' && e.message === NOT_SIGNED_IN);
  const hist = await engine.methods['sessions.history']({ id: s.id });
  assert.equal((hist.items || []).filter((i) => i.type === 'user').length, 0, 'the refused message is not stored (the composer keeps it)');
  const before = (await engine.snapshot()).sessions.length;
  await assert.rejects(engine.methods['sessions.create']({ cwd, prompt: 'hi' }), { code: 'auth_required' });
  assert.equal((await engine.snapshot()).sessions.length, before, 'no half-made session');
  await assert.rejects(engine.methods['sessions.models']({}), { code: 'auth_required' });
  assert.equal(sdk.calls.length, 0, 'no claude child was started');
  await engine.shutdown();
});

test('engine: a session whose Claude Code answers "Not logged in" tells the provider (which checks again)', async () => {
  const seen = [];
  const provider = { childEnv: (e) => e, startBlock: () => null, noteAuthError: (t) => seen.push(t) };
  const { F } = require('../engine/fake-sdk');
  const { engine } = fakeEngine({ provider, frames: async function* () {
    yield { type: 'assistant', parent_tool_use_id: null, uuid: 'u-auth', error: 'authentication_failed',
      message: { id: 'm-auth', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } };
    yield F.result(0, { is_error: true });
  } });
  await engine.methods['sessions.create']({ cwd: mk('cwd-'), prompt: 'hello' });
  await until(() => seen.length > 0);
  assert.deepEqual(seen, ['Not logged in · Please run /login']);
  await engine.shutdown();
});

// engine.recycleClis on the real engine with the fake SDK: an idle live CLI closes, a mid-turn one is reported
// busy and closes once its turn ends.
test('engine.recycleClis closes idle CLIs and leaves working ones until their turn ends', async () => {
  const { createEngine } = require('../../main/engine');
  const { createFakeSdk, F } = require('../engine/fake-sdk');
  let release = null;
  const sdk = createFakeSdk(async function* (um) {
    const text = JSON.stringify(um.message && um.message.content);
    if (text.includes('slow')) await new Promise((r) => { release = r; });
    for (const f of F.textTurn('m' + Math.random(), 'ok')) yield f;
    yield F.result(0.01);
  }, { projectsDir: mk('proj-') });
  const engine = createEngine({ userDataDir: mk('ud-'), emit: () => {}, log: () => {}, sdk, claudePath: null, projectsDir: mk('proj2-'), statuslineDir: mk('sl-'), etaDir: false, external: false, tempDir: path.join(os.tmpdir(), 'not-the-test-dirs') });
  const es = (id) => engine._internal.sessions.get(id);
  const cwd = mk('cwd-');
  const idle = await engine.methods['sessions.create']({ cwd });
  const busy = await engine.methods['sessions.create']({ cwd });
  const never = await engine.methods['sessions.create']({ cwd });
  await engine.methods['sessions.send']({ id: idle.id, text: 'quick' });
  await until(() => es(idle.id).live() && !es(idle.id).turnActive && es(idle.id).s.status === 'idle');
  await engine.methods['sessions.send']({ id: busy.id, text: 'slow' });
  await until(() => release && es(busy.id).turnActive);
  const r1 = engine.recycleClis();
  assert.deepEqual(r1.closed, [idle.id]);
  assert.deepEqual(r1.busy, [busy.id]);
  assert.equal(r1.closed.includes(never.id) || r1.busy.includes(never.id), false, 'a session with no CLI is left alone');
  await until(() => !es(idle.id).live());
  assert.equal(es(idle.id).s.status, 'idle', 'closed for the restart, not marked closed');
  release();
  await until(() => !es(busy.id).turnActive);
  const r2 = engine.recycleClis();
  assert.deepEqual(r2.closed, [busy.id]);
  assert.deepEqual(r2.busy, []);
  await engine.methods['sessions.send']({ id: idle.id, text: 'quick' });
  await until(() => es(idle.id).live() && es(idle.id).s.status === 'idle');
  await engine.shutdown();
});
