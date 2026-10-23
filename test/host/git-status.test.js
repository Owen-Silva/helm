// Unit tests for main/git.js (git.status for the session header chip) and files.saveText.
// Builds throwaway repos with git init + commits; a bare "remote" gives a real upstream for ahead/behind.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { status, parseStatusV2 } = require('../../main/git.js');
const { createFiles, safeFileName } = require('../../main/files.js');
const { createRouter } = require('../../main/rpc.js');

const tmpRoots = [];
function mkTmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `helm-git-${tag}-`));
  tmpRoots.push(d);
  return d;
}
after(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Helm Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
function write(root, rel, content) {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
function commit(root, msg) { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', msg); }
// Snapshot of everything under .git except nothing: proves git.status wrote no file (index, lock, refs).
function gitDirSnapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { const st = fs.statSync(f); out[path.relative(root, f)] = `${st.size}:${st.mtimeMs}`; }
    }
  };
  walk(path.join(root, '.git'));
  return out;
}

test('not a repo -> { isRepo: false }', async () => {
  const d = mkTmp('plain');
  // A temp folder can sit inside a repo on some machines; make sure this one does not.
  fs.writeFileSync(path.join(d, 'a.txt'), 'x');
  const r = await status({ cwd: d });
  assert.equal(r.isRepo, false);
});

test('validation: missing cwd, NUL, missing folder, a file', async () => {
  await assert.rejects(status({}), { code: 'bad_params' });
  await assert.rejects(status({ cwd: '  ' }), { code: 'bad_params' });
  await assert.rejects(status({ cwd: 'C:\\x\0y' }), { code: 'bad_params' });
  const d = mkTmp('val');
  await assert.rejects(status({ cwd: path.join(d, 'nope') }), { code: 'not_found' });
  fs.writeFileSync(path.join(d, 'f.txt'), 'x');
  await assert.rejects(status({ cwd: path.join(d, 'f.txt') }), { code: 'bad_params' });
});

test('fresh repo with no commits: branch known, lastCommit null, untracked counted', async () => {
  const d = mkTmp('init');
  git(d, 'init', '-q');
  write(d, 'a.txt', 'a');
  const r = await status({ cwd: d });
  assert.equal(r.isRepo, true);
  assert.equal(r.branch, 'main');
  assert.equal(r.detached, false);
  assert.equal(r.lastCommit, null);
  assert.equal(r.untracked, 1);
  assert.equal(r.dirty, 1);
  assert.equal(r.upstream, null);
  assert.equal(r.ahead, null);
  assert.equal(r.behind, null);
});

test('dirty / staged / untracked counts, last commit subject + time, subfolder cwd', async () => {
  const d = mkTmp('dirty');
  git(d, 'init', '-q');
  write(d, 'a.txt', 'a'); write(d, 'b.txt', 'b'); write(d, 'sub/c.txt', 'c');
  const t0 = Date.now();
  commit(d, 'First commit: hello');
  write(d, 'a.txt', 'a2');            // unstaged modify
  write(d, 'b.txt', 'b2'); git(d, 'add', 'b.txt');   // staged modify
  write(d, 'new.txt', 'n');           // untracked
  git(d, 'mv', 'sub/c.txt', 'sub/d.txt');            // staged rename (porcelain v2 "2" entry, two path fields)
  const r = await status({ cwd: path.join(d, 'sub') });
  assert.equal(r.isRepo, true);
  assert.equal(r.branch, 'main');
  assert.equal(r.staged, 2);
  assert.equal(r.untracked, 1);
  assert.equal(r.dirty, 4);
  assert.equal(r.lastCommit.subject, 'First commit: hello');
  assert.ok(Math.abs(r.lastCommit.ts - t0) < 120_000, `commit ts ${r.lastCommit.ts} near ${t0}`);
});

test('ahead / behind against the existing remote-tracking ref, no fetch', async () => {
  const remote = mkTmp('remote');
  git(remote, 'init', '-q', '--bare');
  const a = mkTmp('clone-a');
  git(a, 'init', '-q');
  write(a, 'x.txt', '1'); commit(a, 'one');
  git(a, 'remote', 'add', 'origin', remote);
  git(a, 'push', '-q', '-u', 'origin', 'main');

  let r = await status({ cwd: a });
  assert.equal(r.upstream, 'origin/main');
  assert.deepEqual([r.ahead, r.behind], [0, 0]);

  // two local commits -> ahead 2
  write(a, 'x.txt', '2'); commit(a, 'two');
  write(a, 'x.txt', '3'); commit(a, 'three');
  r = await status({ cwd: a });
  assert.deepEqual([r.ahead, r.behind], [2, 0]);
  assert.equal(r.lastCommit.subject, 'three');

  // someone else pushes one commit: still 2/0 until a fetch (git.status never fetches)
  const b = mkTmp('clone-b');
  git(b, 'clone', '-q', remote, '.');
  write(b, 'y.txt', 'b'); commit(b, 'from b');
  git(b, 'push', '-q', 'origin', 'main');
  r = await status({ cwd: a });
  assert.deepEqual([r.ahead, r.behind], [2, 0], 'no network fetch happened');
  git(a, 'fetch', '-q');
  r = await status({ cwd: a });
  assert.deepEqual([r.ahead, r.behind], [2, 1]);
});

test('detached HEAD reports the short sha and detached: true', async () => {
  const d = mkTmp('detached');
  git(d, 'init', '-q');
  write(d, 'a.txt', 'a'); commit(d, 'c1');
  write(d, 'a.txt', 'b'); commit(d, 'c2');
  const sha = git(d, 'rev-parse', 'HEAD~1').trim();
  git(d, 'checkout', '-q', sha);
  const r = await status({ cwd: d });
  assert.equal(r.detached, true);
  assert.equal(r.branch, sha.slice(0, 7));
  assert.equal(r.upstream, null);
  assert.equal(r.lastCommit.subject, 'c1');
});

test('read-only: nothing under .git changes, even with a dirty work tree and a stale index', async () => {
  const d = mkTmp('ro');
  git(d, 'init', '-q');
  write(d, 'a.txt', 'a'); commit(d, 'c1');
  write(d, 'a.txt', 'changed');
  // bump the mtime so a normal `git status` would want to refresh the index stat cache
  const later = new Date(Date.now() + 5000); fs.utimesSync(path.join(d, 'a.txt'), later, later);
  const before = gitDirSnapshot(d);
  for (let i = 0; i < 3; i++) await status({ cwd: d });
  assert.deepEqual(gitDirSnapshot(d), before);
});

test('concurrent calls for one folder share a single read', async () => {
  const d = mkTmp('dedupe');
  git(d, 'init', '-q');
  write(d, 'a.txt', 'a'); commit(d, 'c1');
  const [x, y] = await Promise.all([status({ cwd: d }), status({ cwd: d })]);
  assert.equal(x, y);
});

test('parseStatusV2: upstream gone leaves ahead/behind null; unmerged counts as dirty', () => {
  const out = ['# branch.oid 0123456789abcdef', '# branch.head feat/x', '# branch.upstream origin/feat/x',
    'u UU N... 100644 100644 100644 100644 a a a conflict.txt', '? junk.txt', ''].join('\0');
  const r = parseStatusV2(out);
  assert.equal(r.branch, 'feat/x');
  assert.equal(r.upstream, 'origin/feat/x');
  assert.equal(r.ahead, null);
  assert.equal(r.behind, null);
  assert.equal(r.conflicted, 1);
  assert.equal(r.dirty, 2);
});

test('git.status and files.saveText are routed; saveText refuses the web client', async () => {
  const engine = { snapshot: async () => ({ sessions: [] }), methods: {} };
  const settings = { get: () => ({}), file: null };
  const queue = { list: () => [] };
  const files = createFiles({});
  const router = createRouter({ engine, files, queue, settings, version: 't' });
  const d = mkTmp('route');
  git(d, 'init', '-q');
  const r = await router.handle({ platform: 'web' }, 'git.status', { cwd: d });
  assert.equal(r.isRepo, true);
  await assert.rejects(router.handle({ platform: 'web' }, 'files.saveText', { suggestedName: 'a.md', text: 'x' }), { code: 'unsupported' });
});

test('files.saveText: writes what the dialog picked; cancel -> null; name sanitised', async () => {
  const d = mkTmp('save');
  const target = path.join(d, 'out.md');
  let seen = null;
  const dialog = { showSaveDialog: async (_w, opts) => { seen = opts; return { canceled: false, filePath: target }; } };
  const files = createFiles({ dialog, getWindow: () => null });
  const r = await files.saveText({ suggestedName: 'Fix: login/redirect?.md', text: '# Hi\n' }, { platform: 'electron' });
  assert.equal(r.path, target);
  assert.equal(fs.readFileSync(target, 'utf8'), '# Hi\n');
  assert.equal(seen.defaultPath, 'Fix login redirect .md');
  assert.ok(!/[\\/:*?"<>|]/.test(seen.defaultPath), seen.defaultPath);
  assert.equal(seen.filters[0].extensions[0], 'md');

  const cancel = createFiles({ dialog: { showSaveDialog: async () => ({ canceled: true }) } });
  assert.deepEqual(await cancel.saveText({ suggestedName: 'a.md', text: 'x' }, { platform: 'electron' }), { path: null });
  await assert.rejects(files.saveText({ suggestedName: 'a.md' }, { platform: 'electron' }), { code: 'bad_params' });
  await assert.rejects(files.saveText({ suggestedName: 'a.md', text: 'x' }, { platform: 'web' }), { code: 'unsupported' });

  assert.equal(safeFileName('..\\..\\evil.md'), 'evil.md');
  assert.equal(safeFileName('con.md'), '_con.md');
  assert.equal(safeFileName(''), 'export.md');
  assert.equal(safeFileName(null), 'export.md');
  assert.ok(safeFileName('x'.repeat(300) + '.md').length <= 120);
  assert.ok(safeFileName('x'.repeat(300) + '.md').endsWith('.md'));
});
