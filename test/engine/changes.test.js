'use strict';
// files.changes inside a git repo: numbers come from git (vs HEAD), status from git status.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { computeChanges } = require('../../main/engine/changes');

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

test('git repo: numstat + untracked file + deleted file', { skip: !hasGit && 'git not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.js'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'x\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'a.js'), 'one\nTWO\nthree\nfour\n');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'new.md'), 'a\nb\n');
  fs.unlinkSync(path.join(dir, 'gone.txt'));
  const items = [
    { type: 'tool', name: 'Edit', status: 'done', toolUseId: 't1', input: { file_path: path.join(dir, 'a.js'), old_string: 'two', new_string: 'TWO' } },
    { type: 'tool', name: 'Edit', status: 'done', toolUseId: 't2', input: { file_path: path.join(dir, 'a.js'), old_string: 'three', new_string: 'three\nfour' } },
    { type: 'tool', name: 'Write', status: 'done', toolUseId: 't3', input: { file_path: path.join(dir, 'sub', 'new.md'), content: 'a\nb\n' }, result: 'File created successfully at: x' },
    { type: 'tool', name: 'Write', status: 'done', toolUseId: 't4', input: { file_path: path.join(dir, 'gone.txt'), content: 'x\n' }, result: 'ok' },
    { type: 'tool', name: 'Bash', status: 'done', toolUseId: 't5', input: { command: 'rm gone.txt' } },
  ];
  const ch = await computeChanges(items, dir);
  const by = Object.fromEntries(ch.map((c) => [c.rel.split(path.sep).join('/'), c]));
  assert.deepStrictEqual([by['a.js'].status, by['a.js'].additions, by['a.js'].deletions, by['a.js'].touchedBy], ['M', 2, 1, ['t1', 't2']]);
  assert.strictEqual(by['a.js'].source, 'git');
  assert.deepStrictEqual([by['sub/new.md'].status, by['sub/new.md'].additions], ['A', 2]);
  assert.strictEqual(by['gone.txt'].status, 'D');
});

// Regression (lane helm-next3, 2026-10-15): git reports the repo root in its real form (junctions,
// symlinks and 8.3 short names such as C:\Users\RUNNER~1 resolved). A cwd reached another way never
// matched it, so every file silently fell back to the per-tool estimate (M 3/2 here instead of 2/1).
test('git repo reached through a junction / symlink still gets git numbers', { skip: !hasGit && 'git not installed' }, async (t) => {
  const realDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'helm-git-real-')));
  const link = path.join(os.tmpdir(), 'helm-git-link-' + process.pid + '-' + Date.now());
  try {
    fs.symlinkSync(realDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('cannot make a junction / symlink here');
    return;
  }
  try {
    const g = (...a) => execFileSync('git', a, { cwd: realDir, stdio: 'pipe' });
    g('init', '-q');
    g('config', 'user.email', 't@example.invalid');
    g('config', 'user.name', 't');
    g('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(realDir, 'a.js'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(realDir, 'gone.txt'), 'x\n');
    g('add', '.');
    g('commit', '-qm', 'init');
    fs.writeFileSync(path.join(realDir, 'a.js'), 'one\nTWO\nthree\nfour\n');
    fs.unlinkSync(path.join(realDir, 'gone.txt'));
    const items = [
      { type: 'tool', name: 'Edit', status: 'done', toolUseId: 't1', input: { file_path: path.join(link, 'a.js'), old_string: 'two', new_string: 'TWO' } },
      { type: 'tool', name: 'Edit', status: 'done', toolUseId: 't2', input: { file_path: path.join(link, 'a.js'), old_string: 'three', new_string: 'three\nfour' } },
      { type: 'tool', name: 'Bash', status: 'done', toolUseId: 't3', input: { command: 'rm gone.txt' } },
      { type: 'tool', name: 'Write', status: 'done', toolUseId: 't4', input: { file_path: path.join(link, 'gone.txt'), content: 'x\n' }, result: 'ok' },
    ];
    const ch = await computeChanges(items, link);
    const by = Object.fromEntries(ch.map((c) => [path.basename(c.path), c]));
    assert.deepStrictEqual([by['a.js'].status, by['a.js'].additions, by['a.js'].deletions, by['a.js'].source], ['M', 2, 1, 'git']);
    assert.strictEqual(by['gone.txt'].status, 'D');
    assert.strictEqual(by['a.js'].path, path.join(link, 'a.js'), 'the entry keeps the path the session used');
  } finally {
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch {} }
  }
});
