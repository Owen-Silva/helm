// Unit tests for main/files.js (tree / read / search / diff / score / gitStatusMap / pickFolder).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const files = require('../../main/files.js');
const { createFiles, tree, read, search, diff, score, gitStatusMap } = files;

const CAP = 512 * 1024;
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

const tmpRoots = [];
// Long-form temp root. On a GitHub Windows runner TEMP is the 8.3 short name
// (C:\Users\RUNNER~1\...) while `git rev-parse --show-toplevel` answers in long form
// (C:/Users/runneradmin/...), so path.relative(root, file) climbed out with '../' and the
// git-status / diff-before checks came back empty (5 failures there, 0 on a laptop whose
// user name is already 8.3-sized). realpathSync.native expands the short name.
const TMP = fs.realpathSync.native(os.tmpdir());
function mkTmp(tag) {
  const d = fs.mkdtempSync(path.join(TMP, `helm-files-${tag}-`));
  tmpRoots.push(d);
  return d;
}
after(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Helm Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
function write(root, rel, content) {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// One shared repo for the read-only tree/read/diff/status cases.
let repo;
before(() => {
  repo = mkTmp('repo');
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'user.name', 'Helm Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  write(repo, '.gitignore', 'ignored.log\nnode_modules/\n');
  write(repo, 'tracked.txt', 'hello\n');
  write(repo, 'sub/inner.txt', 'inner v1\n');
  write(repo, 'sub/clean.txt', 'clean\n');
  write(repo, 'deleted.txt', 'gone soon\n');
  write(repo, 'old.txt', 'rename me\n');
  write(repo, 'Zeta.txt', 'z\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');

  write(repo, 'tracked.txt', 'hello world\n');       // M
  write(repo, 'sub/inner.txt', 'inner v2\n');         // M inside sub/
  write(repo, 'untracked.txt', 'new file\n');         // ?
  write(repo, 'newdir/a.txt', 'a\n');                 // ? inside newdir/
  write(repo, 'staged.txt', 'staged\n');              // A
  git(repo, 'add', 'staged.txt');
  fs.rmSync(path.join(repo, 'deleted.txt'));          // D (unstaged)
  git(repo, 'mv', 'old.txt', 'renamed.txt');          // R
  write(repo, 'ignored.log', 'noise\n');              // ignored
  write(repo, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
  write(repo, 'bin.dat', Buffer.from([0x41, 0x42, 0x00, 0x43, 0x44]));
  write(repo, 'big.txt', 'a'.repeat(CAP + 1000));
  write(repo, 'image.png', PNG_BYTES);
});

describe('gitStatusMap', () => {
  test('maps porcelain records to status letters', async () => {
    const m = await gitStatusMap(repo);
    assert.equal(m.get('tracked.txt'), 'M');
    assert.equal(m.get('sub/inner.txt'), 'M');
    assert.equal(m.get('untracked.txt'), '?');
    assert.equal(m.get('newdir/a.txt'), '?');
    assert.equal(m.get('staged.txt'), 'A');
    assert.equal(m.get('deleted.txt'), 'D');
    assert.equal(m.get('renamed.txt'), 'R');
    assert.equal(m.has('old.txt'), false, 'rename source must be consumed, not listed');
    assert.equal(m.has('ignored.log'), false);
    assert.equal(m.has('sub/clean.txt'), false);
    for (const k of m.keys()) assert.ok(!k.startsWith('node_modules'), `ignored node_modules leaked: ${k}`);
  });
});

describe('tree (git repo)', () => {
  test('one level, hides .git/node_modules, dirs first, sorted, git letters', async () => {
    const rows = await tree({ cwd: repo });
    const names = rows.map((r) => r.name);
    assert.ok(!names.includes('.git'));
    assert.ok(!names.includes('node_modules'));
    assert.ok(!names.includes('inner.txt'), 'must be one level only');
    // dirs first
    const firstFile = rows.findIndex((r) => !r.dir);
    assert.deepEqual(rows.slice(0, firstFile).map((r) => r.name), ['newdir', 'sub']);
    assert.ok(rows.slice(firstFile).every((r) => !r.dir));
    // case-insensitive sort among files
    const fileNames = rows.slice(firstFile).map((r) => r.name);
    const sorted = [...fileNames].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    assert.deepEqual(fileNames, sorted);
    assert.ok(fileNames.indexOf('tracked.txt') < fileNames.indexOf('Zeta.txt'));

    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.equal(by['tracked.txt'].gitStatus, 'M');
    assert.equal(by['untracked.txt'].gitStatus, '?');
    assert.equal(by['staged.txt'].gitStatus, 'A');
    assert.equal(by['renamed.txt'].gitStatus, 'R');
    assert.equal(by['sub'].gitStatus, 'M');
    assert.equal(by['newdir'].gitStatus, '?');
    assert.equal(by['Zeta.txt'].gitStatus, undefined);
    assert.equal(by['ignored.log'].gitStatus, undefined);
    assert.equal(by['tracked.txt'].path, path.join(repo, 'tracked.txt'));
    assert.equal(by['tracked.txt'].size, Buffer.byteLength('hello world\n'));
    assert.equal(by['sub'].size, 0);
    assert.ok(by['tracked.txt'].mtime > 0);
  });

  test('path param lists a subfolder with repo-relative status', async () => {
    const rows = await tree({ cwd: repo, path: path.join(repo, 'sub') });
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.deepEqual(Object.keys(by).sort(), ['clean.txt', 'inner.txt']);
    assert.equal(by['inner.txt'].gitStatus, 'M');
    assert.equal(by['clean.txt'].gitStatus, undefined);
  });

  test('missing folder -> not_found; no cwd -> bad_params', async () => {
    await assert.rejects(tree({ cwd: path.join(repo, 'nope') }), { code: 'not_found' });
    await assert.rejects(tree({}), { code: 'bad_params' });
    await assert.rejects(tree({ cwd: '   ' }), { code: 'bad_params' });
  });
});

describe('tree (plain folder)', () => {
  test('no git status, still hides node_modules and sorts dirs first', async () => {
    const d = mkTmp('plain');
    write(d, 'b.txt', 'b');
    write(d, 'A.txt', 'a');
    write(d, 'zdir/x.txt', 'x');
    write(d, 'node_modules/m.js', 'm');
    const rows = await tree({ cwd: d });
    assert.deepEqual(rows.map((r) => r.name), ['zdir', 'A.txt', 'b.txt']);
    assert.ok(rows.every((r) => r.gitStatus === undefined));
    assert.equal(rows[0].dir, true);
  });
});

describe('read', () => {
  test('text file', async () => {
    const r = await read({ path: path.join(repo, 'tracked.txt') });
    assert.equal(r.text, 'hello world\n');
    assert.equal(r.truncated, false);
    assert.equal(r.mime, 'text/plain');
    assert.equal(r.binary, undefined);
    assert.equal(r.size, 12);
  });

  test('caps at 512 KB with truncated flag', async () => {
    const r = await read({ path: path.join(repo, 'big.txt') });
    assert.equal(r.truncated, true);
    assert.equal(r.text.length, CAP);
    assert.equal(r.size, CAP + 1000);
  });

  test('maxBytes lowers the cap but cannot raise it', async () => {
    const r = await read({ path: path.join(repo, 'tracked.txt'), maxBytes: 5 });
    assert.equal(r.text, 'hello');
    assert.equal(r.truncated, true);
    const r2 = await read({ path: path.join(repo, 'big.txt'), maxBytes: CAP * 4 });
    assert.equal(r2.text.length, CAP);
  });

  test('multi-byte char cut at the cap is dropped, not shown as U+FFFD', async () => {
    const d = mkTmp('mb');
    const f = write(d, 'mb.txt', 'a'.repeat(CAP - 1) + '\u00e9tail');
    const r = await read({ path: f });
    assert.equal(r.truncated, true);
    assert.equal(r.text.length, CAP - 1);
    assert.ok(!r.text.includes('\uFFFD'));
  });

  test('binary detection via NUL byte', async () => {
    const r = await read({ path: path.join(repo, 'bin.dat') });
    assert.equal(r.binary, true);
    assert.equal(r.text, '');
    assert.equal(r.truncated, false);
  });

  test('images return a data URL', async () => {
    const r = await read({ path: path.join(repo, 'image.png') });
    assert.equal(r.binary, true);
    assert.equal(r.mime, 'image/png');
    assert.equal(r.text, '');
    assert.equal(r.dataUrl, 'data:image/png;base64,' + PNG_BYTES.toString('base64'));
  });

  test('errors: folder, missing, bad path', async () => {
    await assert.rejects(read({ path: repo }), { code: 'bad_params' });
    await assert.rejects(read({ path: path.join(repo, 'missing.txt') }), { code: 'not_found' });
    await assert.rejects(read({}), { code: 'bad_params' });
    await assert.rejects(read({ path: 'a\0b' }), { code: 'bad_params' });
  });

  test('empty file reads as empty text', async () => {
    const d = mkTmp('empty');
    const f = write(d, 'e.md', '');
    const r = await read({ path: f });
    assert.equal(r.text, '');
    assert.equal(r.truncated, false);
    assert.equal(r.mime, 'text/markdown');
  });
});

describe('score', () => {
  test('basename hit > path hit > fuzzy > none', () => {
    const base = score('src/foo.js', 'foo');
    const pathHit = score('foodir/x.txt', 'foo');
    const fuzzy = score('f1o2o3.txt', 'foo');
    assert.ok(base > pathHit, `${base} > ${pathHit}`);
    assert.ok(pathHit > fuzzy, `${pathHit} > ${fuzzy}`);
    assert.ok(fuzzy >= 0);
    assert.equal(score('zzz.txt', 'foo'), -1);
  });
  test('exact basename and prefix bonuses', () => {
    assert.ok(score('a/foo', 'foo') > score('a/foo.js', 'foo'));
    assert.ok(score('a/foo.js', 'foo') > score('a/xfoo.js', 'foo'));
  });
});

describe('search (plain folder walk)', () => {
  test('ranks basename > path > fuzzy and skips node_modules', async () => {
    const d = mkTmp('rank');
    for (const f of ['src/foo.js', 'foo.md', 'lib/barfoo.txt', 'foodir/x.txt', 'f1o2o3.txt', 'zzz.txt', 'node_modules/foo.js', 'dist/foo.js'])
      write(d, f, 'x');
    const res = await search({ cwd: d, q: 'foo' });
    assert.deepEqual(res.map((r) => r.rel), ['foo.md', 'src/foo.js', 'lib/barfoo.txt', 'foodir/x.txt', 'f1o2o3.txt']);
    assert.equal(res[1].path, path.join(d, 'src', 'foo.js'));
  });

  test('limit defaults to 50 and is honoured', async () => {
    const d = mkTmp('limit');
    for (let i = 0; i < 60; i++) write(d, `file${i}.txt`, 'x');
    assert.equal((await search({ cwd: d, q: '' })).length, 50);
    assert.equal((await search({ cwd: d, q: 'file' })).length, 50);
    assert.equal((await search({ cwd: d, q: 'file', limit: 5 })).length, 5);
  });

  test('backslash query matches posix rel paths; cwd required', async () => {
    const d = mkTmp('bs');
    write(d, 'src/deep/thing.js', 'x');
    const res = await search({ cwd: d, q: 'src\\deep' });
    assert.deepEqual(res.map((r) => r.rel), ['src/deep/thing.js']);
    await assert.rejects(search({ q: 'x' }), { code: 'bad_params' });
  });
});

describe('search (git repo)', () => {
  test('tracked + untracked, .gitignore respected', async () => {
    const res = await search({ cwd: repo, q: '', limit: 200 });
    const rels = res.map((r) => r.rel);
    for (const want of ['tracked.txt', 'untracked.txt', 'sub/inner.txt', 'newdir/a.txt', 'staged.txt', 'renamed.txt', 'big.txt'])
      assert.ok(rels.includes(want), `missing ${want}`);
    assert.ok(!rels.includes('ignored.log'));
    assert.ok(!rels.some((r) => r.startsWith('node_modules')));
    assert.equal(new Set(rels).size, rels.length, 'no duplicates');
  });

  test('ranked query in a repo', async () => {
    const res = await search({ cwd: repo, q: 'inner' });
    assert.equal(res[0].rel, 'sub/inner.txt');
    assert.equal(res[0].path, path.join(repo, 'sub', 'inner.txt'));
  });
});

describe('diff', () => {
  test('modified tracked file: before = HEAD, after = disk', async () => {
    const r = await diff({ cwd: repo, path: 'tracked.txt' });
    assert.equal(r.path, path.join(repo, 'tracked.txt'));
    assert.equal(r.before, 'hello\n');
    assert.equal(r.after, 'hello world\n');
  });
  test('file in a subfolder, absolute path without cwd', async () => {
    const r = await diff({ path: path.join(repo, 'sub', 'inner.txt') });
    assert.equal(r.before, 'inner v1\n');
    assert.equal(r.after, 'inner v2\n');
  });
  test('untracked / staged-new file: before is empty', async () => {
    assert.deepEqual(await diff({ cwd: repo, path: 'untracked.txt' }),
      { path: path.join(repo, 'untracked.txt'), before: '', after: 'new file\n' });
    assert.equal((await diff({ cwd: repo, path: 'staged.txt' })).before, '');
  });
  test('deleted file: after is empty', async () => {
    const r = await diff({ cwd: repo, path: 'deleted.txt' });
    assert.equal(r.before, 'gone soon\n');
    assert.equal(r.after, '');
  });
  test('outside a repo: before is empty', async () => {
    const d = mkTmp('nodiff');
    write(d, 'x.txt', 'plain\n');
    const r = await diff({ cwd: d, path: 'x.txt' });
    assert.equal(r.before, '');
    assert.equal(r.after, 'plain\n');
  });
  test('path required', async () => {
    await assert.rejects(diff({ cwd: repo }), { code: 'bad_params' });
  });
});

describe('createFiles().pickFolder', () => {
  test('non-electron client -> unsupported', async () => {
    const dialog = { showOpenDialog: async () => { throw new Error('should not be called'); } };
    const f = createFiles({ dialog });
    await assert.rejects(f.pickFolder({}, { platform: 'web' }), { code: 'unsupported' });
    await assert.rejects(createFiles({}).pickFolder({}, { platform: 'electron' }), { code: 'unsupported' });
  });
  test('electron client -> dialog result', async () => {
    let seen;
    const win = { id: 1 };
    const dialog = { showOpenDialog: async (w, o) => { seen = { w, o }; return { canceled: false, filePaths: ['C:\\proj'] }; } };
    const f = createFiles({ dialog, getWindow: () => win });
    assert.deepEqual(await f.pickFolder({}, { platform: 'electron' }), { path: 'C:\\proj' });
    assert.equal(seen.w, win);
    assert.ok(seen.o.properties.includes('openDirectory'));
    const f2 = createFiles({ dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } });
    assert.deepEqual(await f2.pickFolder({}, { platform: 'electron' }), { path: null });
  });
  test('exposes the module functions', () => {
    const f = createFiles({});
    for (const k of ['tree', 'read', 'search', 'diff', 'pickFolder']) assert.equal(typeof f[k], 'function');
  });
});

// ---------- review-main round: git calls must not lock the index or run repo-configured commands ----------
describe('git hardening', () => {
  test('tree/search never rewrite .git/index (no optional locks: no race with a git commit Claude runs)', async () => {
    const r = mkTmp('locks');
    git(r, 'init', '-q');
    write(r, 'a.txt', 'one\n');
    git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'init');
    // same content, new mtime: a plain `git status` re-hashes and writes the refreshed index
    const future = new Date(Date.now() + 3600_000);
    fs.utimesSync(path.join(r, 'a.txt'), future, future);
    const idx = path.join(r, '.git', 'index');
    const before = fs.readFileSync(idx);
    const mBefore = fs.statSync(idx).mtimeMs;
    await tree({ cwd: r });
    await search({ cwd: r, q: 'a' });
    assert.ok(fs.readFileSync(idx).equals(before), 'index bytes changed');
    assert.equal(fs.statSync(idx).mtimeMs, mBefore);
  });

  test('a planted core.fsmonitor command in .git/config is not executed by the Files panel', async () => {
    const r = mkTmp('fsmon');
    git(r, 'init', '-q');
    write(r, 'a.txt', 'x\n');
    git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'init');
    const marker = path.join(r, 'PWNED').split(path.sep).join('/');
    git(r, 'config', 'core.fsmonitor', `echo pwned > "${marker}"`);
    await tree({ cwd: r });
    await search({ cwd: r, q: 'a' });
    await diff({ cwd: r, path: 'a.txt' });
    assert.equal(fs.existsSync(marker), false, 'core.fsmonitor ran');
  });
});

test('the repo-root and file-list caches stay bounded however many folders are asked about', async () => {
  const { rootCache, listCache, CACHE_MAX } = files._caches;
  const base = mkTmp('cache');
  for (let i = 0; i < CACHE_MAX + 60; i++) await search({ cwd: path.join(base, 'gone-' + i), q: 'x' });
  assert.ok(rootCache.size <= CACHE_MAX, `rootCache ${rootCache.size}`);
  assert.ok(listCache.size <= CACHE_MAX, `listCache ${listCache.size}`);
});

// ---------- a short-form (8.3) cwd, e.g. C:\Users\RUNNER~1\... on a GitHub Windows runner ----------
// git reports the repo root in long form; files.js must still match status letters and HEAD content.
function shortName(p) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`],
      { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out && out.toLowerCase() !== p.toLowerCase() && fs.existsSync(out) ? out : null;
  } catch { return null; }
}
describe('short-form (8.3) cwd', () => {
  const r = mkTmp('short-form-repo');
  const short = shortName(r);
  const skip = short ? false : 'no 8.3 short name here (not Windows, or 8.3 names are off on this volume)';
  test('tree, diff and search line up with git\'s long-form root', { skip }, async () => {
    git(r, 'init', '-q');
    git(r, 'config', 'core.autocrlf', 'false');
    write(r, 'sub/keep.txt', 'v1\n');
    write(r, 'sub/gone.txt', 'was here\n');
    git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'init');
    write(r, 'sub/keep.txt', 'v2\n');
    fs.rmSync(path.join(r, 'sub', 'gone.txt'));
    write(r, 'new.txt', 'n\n');
    assert.ok(!short.toLowerCase().startsWith(r.toLowerCase()), `not a short path: ${short}`);

    const top = await tree({ cwd: short });
    assert.equal(top.find((x) => x.name === 'sub').gitStatus, 'M');
    assert.equal(top.find((x) => x.name === 'new.txt').gitStatus, '?');
    const sub = await tree({ cwd: short, path: path.join(short, 'sub') });
    assert.equal(sub.find((x) => x.name === 'keep.txt').gitStatus, 'M');

    const m = await diff({ cwd: short, path: path.join('sub', 'keep.txt') });
    assert.deepEqual([m.before, m.after], ['v1\n', 'v2\n']);
    const g = await diff({ cwd: short, path: 'sub/gone.txt' });
    assert.deepEqual([g.before, g.after], ['was here\n', '']);
    const abs = await diff({ path: path.join(short, 'sub', 'keep.txt') });
    assert.equal(abs.before, 'v1\n');

    const hits = await search({ cwd: short, q: 'keep' });
    assert.equal(hits[0].rel, 'sub/keep.txt');
  });
});
