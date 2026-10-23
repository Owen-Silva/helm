// Production guard: an unreadable prod-guard.json FAILS CLOSED and LOUD (main/engine/prod-guard.js).
// Corrupt = every push and gh write asks, with the reason in the card, and each session shows one
// 'guard-warn' line; missing = today's meaning (only Railway asks); a valid file = its own list.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const G = require('../../main/engine/prod-guard');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-guard-failclosed-'));
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
const other = repo('other', 'git@github.com:someone/other.git', 'feature');
let n = 0;
const userData = (config) => {
  const d = path.join(root, `ud-${++n}`);
  fs.mkdirSync(d);
  if (config !== undefined) fs.writeFileSync(path.join(d, G.CONFIG_FILE), config);
  return d;
};
const gh = async () => { throw new Error('gh must not run'); };

test('corrupt prod-guard.json: every push and gh write asks, naming the file and the reason', async () => {
  for (const bad of ['{not json', '{"repos": 5}', '[]', '']) {
    const ud = userData(bad);
    const bash = (command, cwd) => G.assess('Bash', { command }, { cwd, userDataDir: ud, gh });
    for (const [cmd, cwd] of [['git push', shop], ['git push origin main', shop], ['git push origin feature', other],
      ['git push --all', other], ['git push https://github.com/x/y.git main', root], ['gh pr merge 1', other],
      ['bash -c "git push origin topic"', other]]) {
      const v = await bash(cmd, cwd);
      assert.ok(v, `${cmd} must ask (${JSON.stringify(bad)})`);
      assert.strictEqual(v.kind, 'push');
      assert.match(v.title, /prod-guard\.json unreadable/, cmd);
      assert.ok(v.description.includes(path.join(ud, G.CONFIG_FILE)), v.description);
      assert.match(v.description, /fix or delete that file/);
      assert.strictEqual(v.approvable, 'all');
    }
    // a script Helm cannot read asks too, whatever it names
    const unread = await bash('pnpm --filter web run build', other);
    assert.ok(unread && /not read/.test(unread.title), JSON.stringify(unread));
    assert.match(unread.description, /could not read .*prod-guard\.json/);
    // dry runs and non-pushes still pass; Railway still asks
    assert.strictEqual(await bash('git push --dry-run origin main', shop), null);
    assert.strictEqual(await bash('git status', shop), null);
    assert.match((await bash('railway up', shop)).title, /^Railway up/);
  }
});

test('missing prod-guard.json keeps its meaning: no repo is protected', async () => {
  const ud = userData();
  assert.deepStrictEqual(G.targets(ud), []);
  assert.strictEqual(await G.assess('Bash', { command: 'git push origin main' }, { cwd: shop, userDataDir: ud, gh }), null);
});

test('a valid file is unchanged by the fail-closed path: only its own repos ask', async () => {
  const ud = userData(JSON.stringify({ repos: [{ name: 'Shop', remotes: ['github.com/example/shop'], branches: ['main'] }] }));
  const bash = (command, cwd) => G.assess('Bash', { command }, { cwd, userDataDir: ud, gh });
  assert.strictEqual((await bash('git push origin main', shop)).title, 'Production push · Shop main');
  assert.strictEqual(await bash('git push origin feature', other), null);
  assert.strictEqual(G.targets(ud).some((t) => t.all), false);
  assert.strictEqual(G.configStatus(ud).state, 'ok');
});

test('hook: a corrupt file shows one guard-warn line per session (again after a fix and a new break); off = silent', async () => {
  const session = (dir) => {
    const s = {
      s: { id: 's1', cwd: other, lastText: null }, logs: [], asked: [], lines: [],
      engine: { userDataDir: dir, log: (lvl, m) => s.logs.push(m) },
      norm: { system(subtype, text) { s.lines.push([subtype, text]); }, store: { patch() {} } },
      requests: new Map(),
      _canUseTool(name, input, o) { s.asked.push(o.title); return Promise.resolve({ behavior: 'allow' }); },
      _cancelRequest() {},
    };
    return s;
  };
  const pre = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'tu1', cwd: other });
  const ud = userData('{"repos": [ oops');
  const file = path.join(ud, G.CONFIG_FILE);
  const s = session(ud);
  const hook = G.createHook(s).hooks[0];
  assert.strictEqual(s.lines.length, 1, 'warned when the hook is made (session start)');
  assert.strictEqual(s.lines[0][0], 'guard-warn');
  assert.ok(s.lines[0][1].includes(file), s.lines[0][1]);
  assert.match(s.lines[0][1], /Helm asks before every git push/);
  await hook(pre('git push origin feature'), 'tu1', {});
  await hook(pre('git status'), 'tu1', {});
  assert.strictEqual(s.lines.filter((l) => l[0] === 'guard-warn').length, 1, 'once per broken file');
  assert.deepStrictEqual(s.asked, ['Push · prod-guard.json unreadable']);
  assert.ok(s.logs.some((m) => /could not read .*fail closed/.test(m)), s.logs.join('\n'));
  // fixed: no new warning, and the unlisted repo pushes freely
  fs.writeFileSync(file, JSON.stringify({ repos: [] }));
  await hook(pre('git push origin feature'), 'tu1', {});
  assert.strictEqual(s.asked.length, 1);
  assert.strictEqual(s.lines.filter((l) => l[0] === 'guard-warn').length, 1);
  // broken again (different content): warns again
  fs.writeFileSync(file, '{"repos": [ still broken');
  await hook(pre('git push origin feature'), 'tu1', {});
  assert.strictEqual(s.lines.filter((l) => l[0] === 'guard-warn').length, 2);
  assert.strictEqual(s.asked.length, 2);
  // prodGuard:false turns the whole guard off: no warning, no asking
  const offDir = userData('{oops');
  fs.writeFileSync(path.join(offDir, 'settings.json'), JSON.stringify({ prodGuard: false }));
  const off = session(offDir);
  await G.createHook(off).hooks[0](pre('git push origin feature'), 'tu1', {});
  assert.deepStrictEqual(off.lines, []);
  assert.deepStrictEqual(off.asked, []);
  // a missing file says nothing
  const quiet = session(userData());
  await G.createHook(quiet).hooks[0](pre('git push origin feature'), 'tu1', {});
  assert.deepStrictEqual(quiet.lines, []);
  assert.deepStrictEqual(quiet.asked, []);
});
