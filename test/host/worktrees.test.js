// Host tests for main/worktrees.js (lane helm-worktrees, H4): a session in its own git worktree.
// Every test runs against REAL throwaway git repos in the temp folder, never a real project's repos. The junction tests
// make a real NTFS junction (fs.symlinkSync type 'junction'; a plain directory symlink off Windows) and prove a
// Remove never deletes the folder it points to.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createWorktrees, parseWorktreeList, findLinks, guardMessage, RESTART_WARNING } = require('../../main/worktrees.js');
const { createRouter } = require('../../main/rpc.js');

const WIN = process.platform === 'win32';
const tmpRoots = [];
function mkTmp(tag) {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `helm-wt-${tag}-`)));
  tmpRoots.push(d);
  return d;
}
after(() => {
  // take links out first (a recursive delete must never walk through a junction), then the folders
  for (const d of tmpRoots) {
    try { const stack = [d]; while (stack.length) { const x = stack.pop(); for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); if (e.isSymbolicLink()) { try { fs.rmdirSync(p); } catch { try { fs.unlinkSync(p); } catch {} } } else if (e.isDirectory()) stack.push(p); } } } catch {}
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(root, rel, content) {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
function commit(root, rel, content, msg = `edit ${rel}`) { write(root, rel, content); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', msg); return git(root, 'rev-parse', 'HEAD'); }

// <tmp>/proj on main: a tracked file, a .gitignore'd real node_modules with one package, a package.json.
function makeRepo(tag, { remote } = {}) {
  const parent = mkTmp(tag);
  const root = path.join(parent, 'proj');
  fs.mkdirSync(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Helm Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
  write(root, '.gitignore', 'node_modules/\n');
  write(root, 'package.json', '{ "name": "proj", "version": "1.0.0", "private": true }\n');
  commit(root, 'README.md', 'hello\n', 'first');
  write(root, 'node_modules/left-pad/index.js', 'module.exports = (s) => s;\n');
  write(root, 'node_modules/left-pad/package.json', '{ "name": "left-pad", "version": "1.0.0" }\n');
  if (remote) git(root, 'remote', 'add', 'origin', remote);
  return { parent, root };
}
const sessionsOf = (list) => async () => list;
const wt = (opts = {}) => createWorktrees({ copier: 'node', ...opts });

test('parseWorktreeList: main first, branches, detached, locked, prunable', () => {
  const out = ['worktree C:/r/proj', 'HEAD aaaa', 'branch refs/heads/main', '', 'worktree C:/r/proj-wt/a', 'HEAD bbbb', 'branch refs/heads/wk/a', 'locked busy', '',
    'worktree C:/r/proj-wt/b', 'HEAD cccc', 'detached', 'prunable gitdir file points to non-existent location', ''].join('\n');
  const l = parseWorktreeList(out);
  assert.equal(l.length, 3);
  assert.equal(l[0].branch, 'main');
  assert.equal(l[1].branch, 'wk/a');
  assert.equal(l[1].locked, 'busy');
  assert.equal(l[2].detached, true);
  assert.match(l[2].prunable, /non-existent/);
});

test('guardMessage: Shop master and every Client Portal branch are production; other branches are not', () => {
  assert.match(guardMessage({ name: 'Shop', branches: ['master'] }, 'master'), /Shop master is production/);
  assert.equal(guardMessage({ name: 'Shop', branches: ['master'] }, 'wk/x'), null);
  assert.match(guardMessage({ name: 'Client Portal', branches: null }, 'dev'), /every change to Client Portal is guarded/);
  assert.equal(guardMessage(null, 'master'), null);
});

test('info: the repo, where worktrees go, the current branch and the node_modules offer', async () => {
  const { parent, root } = makeRepo('info');
  const w = wt();
  const i = await w.info({ cwd: root });
  assert.equal(path.resolve(i.root), root);
  assert.equal(i.name, 'proj');
  assert.equal(i.wtDir, path.join(parent, 'proj-wt'));
  assert.equal(i.currentBranch, 'main');
  assert.deepEqual(i.branches, ['main']);
  assert.equal(i.deps.exists, true);
  assert.equal(i.deps.copyable, true);
  assert.equal(i.deps.files, 2);
  assert.equal(i.deps.suggest, 'copy', 'a small node_modules defaults to Copy');
  assert.equal(i.deps.install, 'npm install', 'no lockfile: npm install');
  await assert.rejects(w.info({ cwd: parent }), (e) => e.code === 'not_repo' && /not inside a git repository/.test(e.message));
  await assert.rejects(w.info({ cwd: path.join(parent, 'nope') }), (e) => e.code === 'not_found' && /was not found/.test(e.message));
});

test('create: <repo>-wt/<name> on wk/<name> from the base; refusals say why', async () => {
  const { parent, root } = makeRepo('create');
  const w = wt();
  const r = await w.create({ cwd: root, name: 'feat' });
  assert.equal(r.path, path.join(parent, 'proj-wt', 'feat'));
  assert.equal(r.branch, 'wk/feat');
  assert.equal(r.base, 'main');
  assert.equal(git(r.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'wk/feat');
  assert.equal(git(root, 'config', 'branch.wk/feat.helmBase'), 'main');
  assert.throws(() => git(root, 'rev-parse', '--abbrev-ref', 'wk/feat@{upstream}'), 'no upstream: the base is not tracked');
  assert.ok(fs.existsSync(path.join(r.path, 'README.md')));
  assert.ok(!fs.existsSync(path.join(r.path, 'node_modules')), 'node_modules is never made by create (deps is its own step)');
  // a worktree made from inside another worktree still lands beside the MAIN folder, based on that worktree's branch
  commit(r.path, 'feat.txt', 'f\n');
  const r2 = await w.create({ cwd: r.path, name: 'child' });
  assert.equal(r2.path, path.join(parent, 'proj-wt', 'child'));
  assert.equal(r2.base, 'wk/feat');
  assert.ok(fs.existsSync(path.join(r2.path, 'feat.txt')));
  await assert.rejects(w.create({ cwd: root, name: 'feat' }), (e) => e.code === 'exists' && /already exists/.test(e.message));
  await assert.rejects(w.create({ cwd: root, name: '../evil' }), (e) => e.code === 'bad_params' && /letters, numbers/.test(e.message));
  await assert.rejects(w.create({ cwd: root, name: '' }), (e) => e.code === 'bad_params' && /name/.test(e.message));
  await assert.rejects(w.create({ cwd: root, name: 'x', base: 'no-such-branch' }), (e) => e.code === 'not_found' && /"no-such-branch" was not found/.test(e.message));
  fs.mkdirSync(path.join(parent, 'proj-wt', 'squat'));
  await assert.rejects(w.create({ cwd: root, name: 'squat' }), (e) => e.code === 'exists' && /folder named "squat"/.test(e.message));
});

test('deps copy: a REAL node_modules folder (never a link); a second copy is refused', async () => {
  const { root } = makeRepo('copy');
  for (const copier of WIN ? ['node', null] : ['node']) {
    const w = createWorktrees({ copier });
    const r = await w.create({ cwd: root, name: `c-${copier || 'robocopy'}` });
    const d = await w.deps({ path: r.path, mode: 'copy' });
    assert.equal(d.mode, 'copy');
    const nm = path.join(r.path, 'node_modules');
    const st = fs.lstatSync(nm);
    assert.ok(st.isDirectory() && !st.isSymbolicLink(), `${copier || 'robocopy'}: node_modules is a real folder`);
    assert.equal(fs.readFileSync(path.join(nm, 'left-pad', 'index.js'), 'utf8'), 'module.exports = (s) => s;\n');
    // the copy is independent: deleting it leaves the main repo's node_modules alone
    fs.rmSync(path.join(nm, 'left-pad'), { recursive: true });
    assert.ok(fs.existsSync(path.join(root, 'node_modules', 'left-pad', 'index.js')));
    fs.mkdirSync(path.join(nm, 'left-pad'));
    await assert.rejects(w.deps({ path: r.path, mode: 'copy' }), (e) => e.code === 'exists' && /already has a node_modules/.test(e.message));
    // a clean worktree with a real (git-ignored) node_modules removes without "Discard changes"
    const out = await w.remove({ path: r.path });
    assert.deepEqual(out.linksRemoved, []);
    assert.ok(!fs.existsSync(r.path));
    assert.ok(fs.existsSync(path.join(root, 'node_modules', 'left-pad', 'index.js')), "the main repo's node_modules is untouched");
  }
});

test('info: a worktree whose node_modules is a junction offers a copy of the main folder\'s real one', async () => {
  const { root } = makeRepo('herelink');
  const w = wt();
  const r = await w.create({ cwd: root, name: 'lane' });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(r.path, 'node_modules'), 'junction');
  const i = await w.info({ cwd: r.path });
  assert.equal(i.deps.link, false);
  assert.equal(i.deps.copyable, true);
  assert.equal(path.resolve(i.deps.source), path.join(root, 'node_modules'));
  assert.ok(i.taken.includes('wk/lane'));
  fs.rmdirSync(path.join(r.path, 'node_modules'));   // only the link
});

test('deps copy: a junctioned source is refused; info says Install', async () => {
  const { parent, root } = makeRepo('srclink');
  const elsewhere = path.join(parent, 'real-nm');
  fs.renameSync(path.join(root, 'node_modules'), elsewhere);
  fs.symlinkSync(elsewhere, path.join(root, 'node_modules'), 'junction');
  const w = wt();
  const i = await w.info({ cwd: root });
  assert.equal(i.deps.link, true);
  assert.equal(i.deps.copyable, false);
  assert.equal(i.deps.suggest, 'install');
  const r = await w.create({ cwd: root, name: 'x' });
  await assert.rejects(w.deps({ path: r.path, mode: 'copy' }), (e) => /is a link \(junction\)/.test(e.message));
});

test('deps install: npm ci runs in the worktree; a failing install says so with its output', async () => {
  const { root } = makeRepo('install');
  write(root, 'package-lock.json', JSON.stringify({ name: 'proj', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'proj', version: '1.0.0' } } }, null, 2) + '\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'lock');
  const w = wt();
  const r = await w.create({ cwd: root, name: 'inst' });
  const d = await w.deps({ path: r.path, mode: 'install' });
  assert.equal(d.command, 'npm ci');
  assert.equal(d.mode, 'install');
  const nmSt = fs.existsSync(path.join(r.path, 'node_modules')) ? fs.lstatSync(path.join(r.path, 'node_modules')) : null;
  assert.ok(!nmSt || !nmSt.isSymbolicLink(), 'whatever npm ci made is not a link');
  const bad = createWorktrees({ npm: path.join(root, 'no-such-npm.exe') });
  const r2 = await bad.create({ cwd: root, name: 'inst2' });
  await assert.rejects(bad.deps({ path: r2.path, mode: 'install' }), (e) => e.code === 'install_failed' && /npm ci failed in the worktree/.test(e.message));
  await assert.rejects(w.deps({ path: r2.path, mode: 'sideways' }), (e) => e.code === 'bad_params' && /Copy or Install/.test(e.message));
});

test('list: branch, base, ahead/behind, dirty, last commit, sessions using each worktree', async () => {
  const { root } = makeRepo('list');
  const sessions = [];
  const w = wt({ getSessions: sessionsOf(sessions) });
  const r = await w.create({ cwd: root, name: 'feat' });
  fs.mkdirSync(path.join(r.path, 'sub'));
  sessions.push({ id: 's1', title: 'In the worktree', cwd: path.join(r.path, 'sub'), status: 'idle' }, { id: 's2', title: 'In main', cwd: root, status: 'working' });
  let l = await w.list({ cwd: r.path });
  assert.equal(path.resolve(l.root), root);
  assert.equal(l.worktrees.length, 2);
  const [m, f] = l.worktrees;
  assert.equal(m.main, true);
  assert.deepEqual(m.sessions.map((s) => s.id), ['s2']);
  assert.equal(f.branch, 'wk/feat');
  assert.equal(f.base, 'main');
  assert.deepEqual(f.sessions.map((s) => s.id), ['s1']);
  assert.equal(f.ahead, 0);
  assert.equal(f.merge.can, false);
  assert.match(f.merge.why, /Nothing to merge/);
  assert.equal(f.nodeModules, 'none');
  commit(r.path, 'a.txt', 'a\n', 'add a');
  write(r.path, 'scratch.txt', 'wip\n');
  l = await w.list({ cwd: root });
  const f2 = l.worktrees[1];
  assert.equal(f2.ahead, 1);
  assert.equal(f2.behind, 0);
  assert.equal(f2.dirty, 1);
  assert.equal(f2.lastCommit.subject, 'add a');
  assert.equal(f2.merge.can, false);
  assert.match(f2.merge.why, /1 uncommitted change\. Commit or discard/);
  fs.unlinkSync(path.join(r.path, 'scratch.txt'));
  const f3 = (await w.list({ cwd: root })).worktrees[1];
  assert.equal(f3.merge.can, true);
  assert.equal(f3.merge.kind, 'ff');
});

test('merge: fast-forward into the checked-out base, then a merge commit once the base has moved', async () => {
  const { root } = makeRepo('merge');
  const w = wt();
  const r = await w.create({ cwd: root, name: 'feat' });
  const tip = commit(r.path, 'a.txt', 'a\n');
  const m1 = await w.merge({ path: r.path });
  assert.equal(m1.kind, 'ff');
  assert.equal(git(root, 'rev-parse', 'main'), tip);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'a\n', "the main folder's files moved with it");
  commit(root, 'b.txt', 'b\n', 'on main');
  commit(r.path, 'c.txt', 'c\n', 'on feat');
  const m2 = await w.merge({ path: r.path });
  assert.equal(m2.kind, 'merge');
  const parents = git(root, 'rev-list', '--parents', '-1', 'main').split(' ');
  assert.equal(parents.length, 3, 'a merge commit has two parents');
  assert.equal(git(root, 'log', '-1', '--format=%s', 'main'), "Merge branch 'wk/feat'");
  assert.equal(git(root, 'status', '--porcelain'), '', 'the main folder is clean after the merge');
  assert.ok(fs.existsSync(path.join(root, 'c.txt')));
});

test('merge commit with no git identity anywhere: made in the name of the branch\'s last author', async () => {
  const { parent, root } = makeRepo('ident');
  const w = wt();
  const r = await w.create({ cwd: root, name: 'feat' });
  commit(root, 'b.txt', 'b\n', 'on main');
  // no identity: repo config cleared, global config an empty file, no system config, no guessing from the host name
  git(root, 'config', '--unset', 'user.name');
  git(root, 'config', '--unset', 'user.email');
  git(root, 'config', 'user.useConfigOnly', 'true');
  const emptyCfg = path.join(parent, 'empty.gitconfig');
  fs.writeFileSync(emptyCfg, '');
  const saved = { G: process.env.GIT_CONFIG_GLOBAL, S: process.env.GIT_CONFIG_NOSYSTEM, E: process.env.EMAIL };
  process.env.GIT_CONFIG_GLOBAL = emptyCfg; process.env.GIT_CONFIG_NOSYSTEM = '1'; delete process.env.EMAIL;
  try {
    write(r.path, 'c.txt', 'c\n');
    git(r.path, 'add', '-A');
    git(r.path, '-c', 'user.name=Branch Author', '-c', 'user.email=ba@example.com', 'commit', '-q', '-m', 'on feat');
    assert.throws(() => git(root, 'var', 'GIT_COMMITTER_IDENT'), 'git really has no identity here');
    const m = await w.merge({ path: r.path });
    assert.equal(m.kind, 'merge');
    assert.equal(git(root, 'log', '-1', '--format=%an <%ae> / %cn <%ce>', 'main'), 'Branch Author <ba@example.com> / Branch Author <ba@example.com>');
  } finally {
    for (const [k, v] of [['GIT_CONFIG_GLOBAL', saved.G], ['GIT_CONFIG_NOSYSTEM', saved.S], ['EMAIL', saved.E]]) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
});

test('merge: base not checked out anywhere moves by ref only (fast-forward and merge commit), never forced', async () => {
  const { root } = makeRepo('mergeref');
  git(root, 'branch', 'release');
  const w = wt();
  const r = await w.create({ cwd: root, name: 'fix', base: 'release' });
  const tip = commit(r.path, 'fix.txt', 'fix\n');
  assert.equal((await w.merge({ path: r.path })).kind, 'ff');
  assert.equal(git(root, 'rev-parse', 'release'), tip);
  // move release on in a short-lived checkout of its own (gone again before the merge), then merge again: a real
  // merge commit made with merge-tree + commit-tree, since release is checked out nowhere
  const tmpWt = path.join(path.dirname(root), 'tmp-release');
  git(root, 'worktree', 'add', '-q', tmpWt, 'release');
  commit(tmpWt, 'release-only.txt', 'm\n');
  git(root, 'worktree', 'remove', tmpWt);
  commit(r.path, 'fix2.txt', 'fix2\n');
  const m = await w.merge({ path: r.path });
  assert.equal(m.kind, 'merge');
  const files = git(root, 'ls-tree', '--name-only', 'release').split('\n');
  for (const f of ['fix.txt', 'fix2.txt', 'release-only.txt']) assert.ok(files.includes(f), `${f} is in the merged release`);
  assert.equal(git(root, 'rev-list', '--parents', '-1', 'release').split(' ').length, 3);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the main folder was not switched');
});

test('merge refusals: dirty, conflicts (nothing touched), dirty base checkout, behind upstream', async () => {
  const { parent, root } = makeRepo('mergeno');
  const w = wt();
  const r = await w.create({ cwd: root, name: 'feat' });
  commit(r.path, 'README.md', 'feat version\n');
  write(r.path, 'wip.txt', 'x\n');
  await assert.rejects(w.merge({ path: r.path }), (e) => e.code === 'refused' && /uncommitted change/.test(e.message));
  fs.unlinkSync(path.join(r.path, 'wip.txt'));
  // conflict: both sides change README.md
  const before = commit(root, 'README.md', 'main version\n');
  await assert.rejects(w.merge({ path: r.path }), (e) => e.code === 'refused' && /would conflict in 1 file \(README\.md\)/.test(e.message));
  assert.equal(git(root, 'rev-parse', 'HEAD'), before, 'a refused merge changes nothing');
  assert.ok(!fs.existsSync(path.join(root, '.git', 'MERGE_HEAD')));
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), 'main version\n');
  // the base's checkout has uncommitted changes
  const r2 = await w.create({ cwd: root, name: 'clean' });
  commit(r2.path, 'n.txt', 'n\n');
  write(root, 'dirty.txt', 'd\n');
  await assert.rejects(w.merge({ path: r2.path }), (e) => /main is checked out in .*uncommitted change\. Helm will not merge on top/.test(e.message));
  fs.unlinkSync(path.join(root, 'dirty.txt'));
  // the base is behind its upstream (as of the last fetch)
  const bare = path.join(parent, 'origin.git');
  git(parent, 'init', '-q', '--bare', bare);
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  const other = path.join(parent, 'other');
  git(parent, 'clone', '-q', bare, other);
  git(other, 'config', 'user.name', 'T'); git(other, 'config', 'user.email', 't@e.x');
  commit(other, 'remote.txt', 'r\n');
  git(other, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');
  await assert.rejects(w.merge({ path: r2.path }), (e) => /main is 1 commit behind origin\/main \(as of the last fetch\)\. Pull main first/.test(e.message));
  const row = (await w.list({ cwd: root })).worktrees.find((x) => x.branch === 'wk/clean');
  assert.equal(row.merge.can, false);
  assert.match(row.merge.why, /behind origin\/main/);
});

test('prod guard: Shop master and any Client Portal branch (prod-guard.json) are refused with the plain message', async () => {
  // the protected repos come from <userData>/prod-guard.json, the production guard's own config
  const userDataDir = mkTmp('ud');
  fs.writeFileSync(path.join(userDataDir, 'prod-guard.json'), JSON.stringify({ repos: [
    { name: 'Shop', remotes: ['github.com/example/shop'], branches: ['master'] },
    { name: 'Client Portal', remotes: ['https://github.com/example/client-portal'], branches: null },
  ] }));
  const shop = makeRepo('shop', { remote: 'https://github.com/Example/shop.git' });
  git(shop.root, 'branch', '-m', 'main', 'master');
  const w = wt({ userDataDir });
  const r = await w.create({ cwd: shop.root, name: 'feat' });
  commit(r.path, 'x.txt', 'x\n');
  // no prod-guard.json (the public default): nothing is protected, so the same merge would be allowed
  const row0 = (await wt().list({ cwd: shop.root })).worktrees[1];
  assert.equal(row0.merge.protected, false);
  assert.equal(row0.merge.can, true);
  const before = git(shop.root, 'rev-parse', 'master');
  await assert.rejects(w.merge({ path: r.path }), (e) => e.code === 'protected' && /Shop master is production/.test(e.message));
  assert.equal(git(shop.root, 'rev-parse', 'master'), before);
  const row = (await w.list({ cwd: shop.root })).worktrees[1];
  assert.equal(row.merge.protected, true);
  // a non-master base in Shop merges normally
  git(shop.root, 'branch', 'staging');
  const r2 = await w.create({ cwd: shop.root, name: 'st', base: 'staging' });
  commit(r2.path, 'y.txt', 'y\n');
  assert.equal((await w.merge({ path: r2.path })).kind, 'ff');
  const portal = makeRepo('portal', { remote: 'git@github.com:example/client-portal.git' });
  const t = await w.create({ cwd: portal.root, name: 'feat' });
  commit(t.path, 'x.txt', 'x\n');
  await assert.rejects(w.merge({ path: t.path }), (e) => e.code === 'protected' && /every change to Client Portal is guarded/.test(e.message));
  // the same repo with no prod-guard.json merges normally
  const t2 = await wt().create({ cwd: portal.root, name: 'feat2' });
  commit(t2.path, 'z.txt', 'z\n');
  assert.equal((await wt().merge({ path: t2.path })).kind, 'ff');
});

test('prod guard: an unreadable prod-guard.json fails closed (every merge refused, with the reason)', async () => {
  const userDataDir = mkTmp('ud-bad');
  fs.writeFileSync(path.join(userDataDir, 'prod-guard.json'), '{"repos": [ oops');
  const any = makeRepo('anyrepo', { remote: 'https://github.com/example/anything.git' });
  const w = wt({ userDataDir });
  const r = await w.create({ cwd: any.root, name: 'feat' });
  commit(r.path, 'x.txt', 'x\n');
  const before = git(any.root, 'rev-parse', 'HEAD');
  await assert.rejects(w.merge({ path: r.path }), (e) => e.code === 'protected' && /could not read .*prod-guard\.json \(.+\), so the production guard treats every repo as protected/.test(e.message));
  assert.equal(git(any.root, 'rev-parse', 'HEAD'), before);
  assert.equal((await w.list({ cwd: any.root })).worktrees[1].merge.protected, true);
  // fixed (valid, and this repo not listed): merges normally again
  fs.writeFileSync(path.join(userDataDir, 'prod-guard.json'), JSON.stringify({ repos: [] }) + ' ');
  assert.equal((await wt({ userDataDir }).merge({ path: r.path })).kind, 'ff');
});

test("Helm's own repo: merging into the branch Helm runs from needs a second confirm", async () => {
  const { root } = makeRepo('self');
  const w = wt({ helmRoot: root });
  const r = await w.create({ cwd: root, name: 'feat' });
  commit(r.path, 'x.txt', 'x\n');
  const row = (await w.list({ cwd: root })).worktrees[1];
  assert.equal(row.merge.restartsHelm, true);
  await assert.rejects(w.merge({ path: r.path }), (e) => e.code === 'confirm_restart' && e.message === RESTART_WARNING);
  assert.equal(RESTART_WARNING, "Merging into Helm's own master restarts Helm and stops running sessions.");
  const m = await w.merge({ path: r.path, confirmRestart: true });
  assert.equal(m.restartsHelm, true);
  assert.equal(m.kind, 'ff');
  // another branch of Helm's repo does not restart Helm
  git(root, 'branch', 'side');
  const r2 = await w.create({ cwd: root, name: 'side2', base: 'side' });
  commit(r2.path, 'z.txt', 'z\n');
  assert.equal((await w.merge({ path: r2.path })).restartsHelm, false);
});

test('remove: refuses dirty unless Discard, refuses the main folder and an open session; deletes a merged branch', async () => {
  const { root } = makeRepo('remove');
  const sessions = [];
  const w = wt({ getSessions: sessionsOf(sessions) });
  const r = await w.create({ cwd: root, name: 'feat' });
  write(r.path, 'wip.txt', 'x\n');
  await assert.rejects(w.remove({ path: r.path }), (e) => e.code === 'dirty' && /Tick "Discard changes"/.test(e.message));
  assert.ok(fs.existsSync(path.join(r.path, 'wip.txt')));
  await assert.rejects(w.remove({ path: root }), (e) => /main folder, not a worktree/.test(e.message));
  sessions.push({ id: 's1', title: 'Busy lane', cwd: r.path, status: 'idle' });
  await assert.rejects(w.remove({ path: r.path, discard: true }), (e) => e.code === 'in_use' && /"Busy lane" is still open/.test(e.message));
  sessions[0].status = 'closed';
  const out = await w.remove({ path: r.path, discard: true, deleteBranch: true });
  assert.ok(!fs.existsSync(r.path));
  assert.equal(out.branchDeleted, true, 'wk/feat had no commits of its own, so it is merged');
  assert.equal(git(root, 'branch', '--list', 'wk/feat'), '');
  // an unmerged branch is kept, and the reason says so
  const r2 = await w.create({ cwd: root, name: 'keep' });
  commit(r2.path, 'k.txt', 'k\n');
  const out2 = await w.remove({ path: r2.path, deleteBranch: true });
  assert.equal(out2.branchDeleted, false);
  assert.match(out2.branchKept, /not merged, so Helm kept it/);
  assert.equal(git(root, 'branch', '--list', 'wk/keep').replace('*', '').trim(), 'wk/keep');
  // a worktree whose folder is already gone is cleaned up from git's list
  const r3 = await w.create({ cwd: root, name: 'gone' });
  fs.rmSync(r3.path, { recursive: true, force: true });
  await w.remove({ path: r3.path, cwd: root });
  assert.ok(!git(root, 'worktree', 'list').includes('gone'));
});

test('JUNCTION SAFETY: remove takes the links out first and never deletes the main repo\'s node_modules', async () => {
  const { parent, root } = makeRepo('junction');
  const outside = path.join(parent, 'outside');
  write(outside, 'keep-me.txt', 'precious\n');
  const w = wt();
  const r = await w.create({ cwd: root, name: 'linked' });
  // the old hand-made setup: <worktree>/node_modules is a JUNCTION to the main repo's node_modules
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(r.path, 'node_modules'), 'junction');
  fs.mkdirSync(path.join(r.path, 'deep', 'er'), { recursive: true });
  fs.symlinkSync(outside, path.join(r.path, 'deep', 'er', 'out'), 'junction');
  assert.ok(fs.lstatSync(path.join(r.path, 'node_modules')).isSymbolicLink(), 'Node reports the junction as a link');
  assert.equal((await findLinks(r.path)).links.length, 2);
  const row = (await w.list({ cwd: root })).worktrees[1];
  assert.equal(row.nodeModules, 'link');
  const out = await w.remove({ path: r.path, discard: true });
  assert.equal(out.linksRemoved.length, 2);
  assert.ok(!fs.existsSync(r.path), 'the worktree is gone');
  assert.equal(fs.readFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'utf8'), 'module.exports = (s) => s;\n', "the main repo's node_modules is intact");
  assert.equal(fs.readFileSync(path.join(root, 'node_modules', 'left-pad', 'package.json'), 'utf8'), '{ "name": "left-pad", "version": "1.0.0" }\n');
  assert.equal(fs.readFileSync(path.join(outside, 'keep-me.txt'), 'utf8'), 'precious\n', 'a deeper junction target is intact');
});

test('control (not asserted): what raw `git worktree remove --force` does through a junction on this machine', async (t) => {
  const { root } = makeRepo('control');
  const w = wt();
  const r = await w.create({ cwd: root, name: 'raw' });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(r.path, 'node_modules'), 'junction');
  let gitErr = null;
  try { git(root, 'worktree', 'remove', '--force', r.path); } catch (e) { gitErr = String(e.stderr || e.message).trim(); }
  const survived = fs.existsSync(path.join(root, 'node_modules', 'left-pad', 'index.js'));
  t.diagnostic(`raw git worktree remove --force via a junction: target node_modules ${survived ? 'SURVIVED' : 'WAS DELETED'}${gitErr ? ` (git: ${gitErr.split('\n')[0]})` : ''}`);
});

test('router: worktrees.* are reachable through rpc with { message, code }', async () => {
  const { root } = makeRepo('rpc');
  const w = wt();
  const engine = { snapshot: async () => ({ sessions: [] }), methods: {} };
  const router = createRouter({ engine, files: {}, queue: { list: () => [] }, settings: { get: () => ({}) }, version: 't', test: true, hostMethods: { ...w.methods } });
  const l = await router.handle({}, 'worktrees.list', { cwd: root });
  assert.equal(l.worktrees.length, 1);
  await assert.rejects(router.handle({}, 'worktrees.create', { cwd: root, name: '' }), (e) => e.code === 'bad_params');
});
