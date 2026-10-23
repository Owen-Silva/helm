// Production guard config (main/engine/prod-guard.js): the protected repos come from
// <userDataDir>/prod-guard.json. Parsing, the empty public default (only Railway asks), missing /
// corrupt files, re-reading on change, and the words and texts that follow the configured names.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const G = require('../../main/engine/prod-guard');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-guard-config-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).toString().trim();
function repo(name, remote, branch = 'main') {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  g(d, 'init', '-q', '-b', branch);
  g(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (remote) g(d, 'remote', 'add', 'origin', remote);
  return d;
}
const shop = repo('shop', 'https://github.com/example/shop.git');
const plain = path.join(root, 'plain');
fs.mkdirSync(plain);
let n = 0;
const userData = (config) => {
  const d = path.join(root, `ud-${++n}`);
  fs.mkdirSync(d);
  if (config !== undefined) fs.writeFileSync(path.join(d, G.CONFIG_FILE), typeof config === 'string' ? config : JSON.stringify(config));
  return d;
};
const SHOP = { name: 'Shop', remotes: ['github.com/example/shop'], branches: ['main'] };

test('parseConfig: every remote form, derived ids, branches null / missing / [] = every push', () => {
  const list = G.parseConfig({ repos: [
    { name: 'My App', remotes: ['github.com/Your-Org/Your-App', 'https://x:tok@github.com/your-org/your-app.git/', 'git@github.com:your-org/your-app.git', 'ssh://git@github.com:22/your-org/your-app'], branches: ['main', 'refs/heads/release', ' '] },
    { name: 'Client Portal', remotes: ['git@github.com:example/client-portal.git'], branches: null },
    { name: 'Docs', remotes: ['github.com/example/docs'] },
    { name: 'Site', remotes: ['github.com/example/site'], branches: [] },
    { id: 'Ops Repo', name: 'Ops', remotes: ['gitlab.example.com:8443/team/ops.git'], branches: ['prod'] },
    { name: 'No remotes', remotes: [] },
    null,
    'junk',
  ] });
  assert.deepStrictEqual(list.map((t) => ({ ...t, remotes: [...t.remotes], branches: t.branches && [...t.branches] })), [
    { id: 'my-app', name: 'My App', remotes: ['github.com/your-org/your-app'], branches: ['main', 'release'] },
    { id: 'client-portal', name: 'Client Portal', remotes: ['github.com/example/client-portal'], branches: null },
    { id: 'docs', name: 'Docs', remotes: ['github.com/example/docs'], branches: null },
    { id: 'site', name: 'Site', remotes: ['github.com/example/site'], branches: null },
    { id: 'ops-repo', name: 'Ops', remotes: ['gitlab.example.com/team/ops'], branches: ['prod'] },
  ]);
  // a remote given as a local folder (a bare repo) is a path key, like the remotes git reports
  const local = G.parseConfig({ repos: [{ name: 'Bare', remotes: [path.join(root, 'bare.git')] }] });
  assert.deepStrictEqual([...local[0].remotes], [G.normalizeRemote(path.join(root, 'bare.git'))]);
  assert.throws(() => G.parseConfig({ projects: [] }), /repos/);
  assert.throws(() => G.parseConfig(null), /repos/);
});

test('missing prod-guard.json = no protected repos; corrupt = fail closed (one match-all stand-in); logged once, never thrown', () => {
  const logs = [];
  const log = (level, msg) => logs.push([level, msg]);
  assert.deepStrictEqual(G.targets(null), []);
  const none = userData();
  assert.deepStrictEqual(G.targets(none, { log }), []);
  assert.deepStrictEqual(G.targets(none, { log }), []);
  assert.strictEqual(logs.length, 1, 'logged once');
  assert.match(logs[0][1], /prod-guard: no .*prod-guard\.json, so no repos are protected \(Railway deploys still ask\)/);
  for (const bad of ['{not json', '{"repos": 5}', '[]', '']) {
    logs.length = 0;
    const d = userData(bad);
    const list = G.targets(d, { log });
    assert.strictEqual(list.length, 1, bad);
    assert.strictEqual(list[0].all, true, bad);
    assert.strictEqual(list[0].branches, null, bad);
    assert.strictEqual(list[0].file, path.join(d, G.CONFIG_FILE));
    assert.ok(list[0].why, bad);
    assert.deepStrictEqual(G.targets(d, { log }), list, bad);
    assert.strictEqual(logs.length, 1, `logged once: ${bad}`);
    assert.strictEqual(logs[0][0], 'warn');
    assert.match(logs[0][1], /prod-guard: could not read .*prod-guard\.json \(.+\), so EVERY push asks until it is fixed \(fail closed\)/);
    assert.strictEqual(G.configStatus(d).state, 'unreadable', bad);
  }
  assert.strictEqual(G.configStatus(none).state, 'missing');
  assert.strictEqual(G.configStatus(null).state, 'none');
  // a note found with no logger waits for the first caller that has one
  logs.length = 0;
  const later = userData('{oops');
  G.targets(later);
  G.targets(later, { log });
  assert.strictEqual(logs.length, 1);
  // a UTF-8 BOM (Windows editors, PowerShell) is fine, and loading logs what it protects
  logs.length = 0;
  const bom = userData('\uFEFF' + JSON.stringify({ repos: [SHOP, { name: 'Client Portal', remotes: ['github.com/example/client-portal'] }] }));
  assert.deepStrictEqual(G.targets(bom, { log }).map((t) => t.id), ['shop', 'client-portal']);
  assert.deepStrictEqual(logs, [['info', `prod-guard: 2 protected repos from ${path.join(bom, G.CONFIG_FILE)}: Shop (main), Client Portal (every push)`]]);
});

test('prod-guard.json is re-read when it changes (mtime), and cached while it does not', () => {
  const d = userData({ repos: [SHOP] });
  const file = path.join(d, G.CONFIG_FILE);
  const first = G.targets(d);
  assert.deepStrictEqual(first.map((t) => t.id), ['shop']);
  assert.strictEqual(G.targets(d), first, 'unchanged file: the cached list');
  fs.writeFileSync(file, JSON.stringify({ repos: [{ ...SHOP, name: 'Store' }] })); // the same size: only the mtime tells
  const t1 = new Date(Date.now() + 60_000);
  fs.utimesSync(file, t1, t1);
  assert.deepStrictEqual(G.targets(d).map((t) => t.name), ['Store']);
  fs.writeFileSync(file, JSON.stringify({ repos: [SHOP, { name: 'Client Portal', remotes: ['github.com/example/client-portal'] }] }));
  const t2 = new Date(Date.now() + 120_000);
  fs.utimesSync(file, t2, t2);
  assert.deepStrictEqual(G.targets(d).map((t) => t.id), ['shop', 'client-portal']);
  fs.rmSync(file);
  assert.deepStrictEqual(G.targets(d), [], 'deleted: nothing protected');
});

test('the empty default asks for nothing but Railway (no git calls, no "folder unknown" card)', async () => {
  const gitCalls = [];
  const git = async (dir, args) => { gitCalls.push(args.join(' ')); return G.runGit(dir, args); };
  const gh = async () => { throw new Error('gh must not run'); };
  for (const opts of [{ targets: [] }, { userDataDir: userData() }, {}]) {
    const bash = (command, cwd = shop) => G.assess('Bash', { command }, { cwd, git, gh, ...opts });
    for (const cmd of ['git push', 'git push origin main', 'git push --all', 'git push https://github.com/example/shop.git main',
      'cd "$REPO" && git push', 'git push origin "$BRANCH"', 'gh pr merge 1', 'gh release create v1', 'gh api -X POST repos/example/shop/merges -f base=main',
      'bash -c "git push origin main"', './no-such-script.sh main', 'pnpm --filter shop run deploy']) {
      assert.strictEqual(await bash(cmd), null, `${cmd} (${Object.keys(opts).join() || 'no options'})`);
      assert.strictEqual(await bash(cmd, plain), null, `${cmd} in a plain folder`);
    }
    assert.match((await bash('railway up')).title, /^Railway up/);
    assert.match((await bash('git push && railway redeploy')).title, /Railway redeploy/);
    assert.match((await G.assess('mcp__railway__deploy', {}, opts)).title, /Railway/);
  }
  assert.deepStrictEqual(gitCalls, [], 'nothing protected: git is never asked about remotes or branches');
});

test('a configured list: the unknown-folder card names the configured repos', async () => {
  const one = G.parseConfig({ repos: [SHOP] });
  const three = G.parseConfig({ repos: [SHOP, { name: 'Client Portal', remotes: ['github.com/example/client-portal'] }, { name: 'Docs', remotes: ['github.com/example/docs'] }] });
  const v1 = await G.assess('Bash', { command: 'cd "$REPO" && git push' }, { cwd: plain, targets: one });
  assert.match(v1.title, /folder unknown/);
  assert.strictEqual(v1.description, 'Helm could not tell which repo this pushes from, so it asks in case it is Shop.');
  const v3 = await G.assess('Bash', { command: 'cd "$REPO" && git push' }, { cwd: plain, targets: three });
  assert.strictEqual(v3.description, 'Helm could not tell which repo this pushes from, so it asks in case it is Shop, Client Portal or Docs.');
  const ghv = await G.assess('Bash', { command: 'cd "$WHERE" && gh pr merge 3' }, { cwd: plain, targets: three, gh: async () => ({ ok: false, out: '', err: 'x' }) });
  assert.match(ghv.description, /could not work out, so it asks in case it is Shop, Client Portal or Docs\.$/);
  // a configured repo is matched by remote in any form, and only its protected branches ask
  assert.match((await G.assess('Bash', { command: 'git push origin main' }, { cwd: shop, targets: one })).title, /Production push · Shop main/);
  assert.strictEqual(await G.assess('Bash', { command: 'git push origin feature' }, { cwd: shop, targets: one }), null);
  // an unread script asks only when the command names a configured repo or branch
  assert.match((await G.assess('Bash', { command: 'pnpm --filter shop run deploy' }, { cwd: plain, targets: one })).title, /not read/);
  assert.strictEqual(await G.assess('Bash', { command: 'pnpm --filter docs run deploy' }, { cwd: plain, targets: one }), null);
});

test('prompt approval: configured repo names count as production words', () => {
  const list = G.parseConfig({ repos: [SHOP, { name: 'Client Portal', remotes: ['github.com/example/client-portal'] }] });
  for (const t of ['push it, but not to shop', 'commit and push, not the Client Portal yet', "push, but don't touch client-portal"]) {
    assert.strictEqual(G.promptApproval(t, null, list), null, t);
  }
  // with nothing configured those names are ordinary words; the built-in production words still veto
  assert.strictEqual(G.promptApproval('push it, but not to shop', null, []).scope, 'all');
  assert.strictEqual(G.promptApproval('push it, but not to master', null, []), null);
  assert.strictEqual(G.answerApproval('Push now?', 'Push, but not to shop', list), null);
  assert.strictEqual(G.answerApproval('Push now?', 'Push, but not to shop', []).scope, 'all');
});

test('hook: the session reads its own prod-guard.json; none = only Railway asks; prodGuard:false = off', async () => {
  const session = (dir) => {
    const s = {
      s: { id: 's1', cwd: shop, lastText: null }, logs: [], asked: [],
      engine: { userDataDir: dir, log: (lvl, m) => s.logs.push(m) },
      norm: { system() {}, store: { patch() {} } },
      requests: new Map(),
      _canUseTool(name, input, o) { s.asked.push(o.title); return Promise.resolve({ behavior: 'allow' }); },
      _cancelRequest() {},
    };
    return s;
  };
  const pre = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'tu1', cwd: shop });
  const on = session(userData({ repos: [SHOP] }));
  assert.deepStrictEqual(await G.createHook(on).hooks[0](pre('git push origin main'), 'tu1', {}), {});
  assert.deepStrictEqual(on.asked, ['Production push · Shop main']);
  assert.ok(on.logs.some((m) => /prod-guard: 1 protected repo from .*: Shop \(main\)/.test(m)), on.logs.join('\n'));
  assert.ok(on.logs.some((m) => /prod-guard: s1 asking the user: Production push · Shop main/.test(m)), on.logs.join('\n'));
  assert.ok(on.logs.some((m) => /prod-guard: s1 the user allowed Production push · Shop main/.test(m)), on.logs.join('\n'));
  const empty = session(userData());
  await G.createHook(empty).hooks[0](pre('git push origin main'), 'tu1', {});
  await G.createHook(empty).hooks[0](pre('cd "$REPO" && git push'), 'tu1', {});
  assert.deepStrictEqual(empty.asked, []);
  await G.createHook(empty).hooks[0](pre('railway up'), 'tu1', {});
  assert.deepStrictEqual(empty.asked, ['Railway up · railway up']);
  const offDir = userData({ repos: [SHOP] });
  fs.writeFileSync(path.join(offDir, 'settings.json'), JSON.stringify({ prodGuard: false }));
  const off = session(offDir);
  await G.createHook(off).hooks[0](pre('git push origin main'), 'tu1', {});
  await G.createHook(off).hooks[0](pre('railway up'), 'tu1', {});
  assert.deepStrictEqual(off.asked, []);
});
