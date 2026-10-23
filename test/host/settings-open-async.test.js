// lane helm-settings-freeze: opening Settings must never block Helm's main process on the disk.
// Settings -> Claude Code calls claudeConfig.list on open (and claudeConfig.search while typing). Helm's main thread
// also pumps the window, so the old synchronous reads (openSync / readSync / lstatSync / readdirSync per memory note)
// froze Helm for 4.7 s on a cold open of ~150 notes and Windows marked it "not responding".
// These tests fail on that code: every synchronous fs call made during list() / search() is recorded and must be none.
// Everything runs in temp dirs; the real ~/.claude is never read.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createClaudeConfig, slugOf } = require('../../main/claude-config.js');

const roots = [];
after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true }); });
const w = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const MEM = (name, description, type) => `---\nname: ${name}\ndescription: "${description}"\nmetadata: \n  node_type: memory\n  type: ${type}\n---\n\nBody of ${name}.\n`;

// home/.claude with CLAUDE.md, a home memory folder of `notes` notes (half indexed in MEMORY.md), a project with
// CLAUDE.md, and an empty memory folder
function sandbox(notes = 60) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-sfa-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const claudeDir = path.join(home, '.claude');
  const proj = path.join(home, 'proj');
  w(path.join(claudeDir, 'CLAUDE.md'), '# Global\n');
  w(path.join(proj, 'CLAUDE.md'), '# Proj\n');
  const mem = path.join(claudeDir, 'projects', slugOf(home), 'memory');
  const index = ['# Memory', ''];
  for (let i = 0; i < notes; i++) {
    const n = `note_${String(i).padStart(3, '0')}.md`;
    w(path.join(mem, n), MEM(`Note ${i}`, `What note ${i} is about`, i % 2 ? 'project' : 'feedback'));
    if (i % 2 === 0) index.push(`- [Note ${i}](${n}) — hook ${i}`);
  }
  index.push('- [Gone](gone.md) — a broken link');
  w(path.join(mem, 'MEMORY.md'), index.join('\n') + '\n');
  fs.mkdirSync(path.join(claudeDir, 'projects', slugOf(proj), 'memory'), { recursive: true });
  const cc = createClaudeConfig({ home, claudeDir, profileDir: path.join(root, 'profile'), getProjectDirs: async () => [proj, proj, path.join(root, 'missing')] });
  return { root, home, claudeDir, proj, mem, cc };
}

// record every synchronous fs call made while fn runs (the module shares this fs object)
const SYNC = ['openSync', 'readSync', 'closeSync', 'readFileSync', 'lstatSync', 'statSync', 'readdirSync', 'existsSync', 'accessSync', 'fstatSync'];
async function syncCallsDuring(fn) {
  const calls = [];
  const saved = SYNC.map((k) => [k, fs[k]]);
  const savedNative = fs.realpathSync.native;
  const savedReal = fs.realpathSync;
  for (const [k, orig] of saved) fs[k] = function (...a) { calls.push(k); return orig.apply(this, a); };
  fs.realpathSync = Object.assign(function (...a) { calls.push('realpathSync'); return savedReal.apply(this, a); }, { native: function (...a) { calls.push('realpathSync.native'); return savedNative.apply(this, a); } });
  let result;
  try { result = await fn(); } finally {
    for (const [k, orig] of saved) fs[k] = orig;
    fs.realpathSync = savedReal;
  }
  return { calls, result };
}

test('claudeConfig.list (Settings open) makes no synchronous fs call and returns every note', async () => {
  const { cc, mem, proj } = sandbox(60);
  const { calls, result } = await syncCallsDuring(() => cc.methods['claudeConfig.list']());
  assert.deepEqual(calls, [], `synchronous fs calls on the Settings open path: ${[...new Set(calls)].join(', ')}`);
  const home = result.memory.folders.find((f) => f.isHome);
  assert.ok(home, 'the home memory folder is listed');
  assert.equal(home.fileCount, 61);
  assert.equal(home.entries.filter((e) => e.status === 'ok').length, 30);
  assert.equal(home.broken, 1);
  assert.equal(home.unindexed.length, 30);
  const e0 = home.entries.find((e) => e.title === 'Note 0');
  assert.equal(e0.path, path.join(mem, 'note_000.md'));
  assert.deepEqual([e0.file.name, e0.file.description, e0.file.type], ['Note 0', 'What note 0 is about', 'feedback']);
  const u1 = home.unindexed.find((u) => u.file === 'note_001.md');
  assert.deepEqual([u1.name, u1.description, u1.type], ['Note 1', 'What note 1 is about', 'project']);
  assert.equal(result.memory.emptyFolders, 1);
  assert.equal(result.instructions.global.exists, true);
  assert.equal(result.instructions.projects.length, 1, 'the duplicate and the missing project folder are dropped');
  assert.deepEqual(result.instructions.projects[0].files.map((f) => f.rel), ['CLAUDE.md']);
  assert.equal(result.instructions.projects[0].cwd, proj);
});

test('claudeConfig.search (typing in Settings) makes no synchronous fs call', async () => {
  const { cc } = sandbox(20);
  const { calls, result } = await syncCallsDuring(() => cc.methods['claudeConfig.search']({ q: 'body of note 7' }));
  assert.deepEqual(calls, [], `synchronous fs calls on the search path: ${[...new Set(calls)].join(', ')}`);
  assert.deepEqual(result.results.map((r) => [path.basename(r.path), r.where]), [['note_007.md', 'body']]);
});

test('a second open reads only the notes that changed (one lstat per unchanged note)', async () => {
  const { cc, mem } = sandbox(30);
  await cc.list();
  const fsp = fs.promises;
  const orig = fsp.open;
  const opened = [];
  fsp.open = function (file, ...a) { opened.push(path.basename(String(file))); return orig.call(this, file, ...a); };
  try {
    const again = await cc.list();
    assert.deepEqual(opened, [], 'unchanged notes are not re-opened');
    assert.equal(again.memory.folders.find((f) => f.isHome).entries.find((e) => e.title === 'Note 4').file.name, 'Note 4');
    // an edited note (new size + mtime) is read again and shows its new name
    const f = path.join(mem, 'note_004.md');
    fs.writeFileSync(f, MEM('Note four, renamed', 'Edited', 'project'));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(f, later, later);
    const third = await cc.list();
    assert.deepEqual(opened, ['note_004.md']);
    assert.equal(third.memory.folders.find((x) => x.isHome).entries.find((e) => e.title === 'Note 4').file.name, 'Note four, renamed');
  } finally { fsp.open = orig; }
});

test('a cold list of 300 notes never holds the event loop for long', async () => {
  const { cc } = sandbox(300);
  const { performance } = require('perf_hooks');
  let last = performance.now();
  let maxGap = 0;
  const tick = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 1);
  const t0 = performance.now();
  const r = await cc.list();
  const n = performance.now(); maxGap = Math.max(maxGap, n - last);
  clearInterval(tick);
  assert.equal(r.memory.folders.find((f) => f.isHome).fileCount, 301);
  // generous for a loaded laptop; the old synchronous list held the loop for the whole run (~total)
  assert.ok(maxGap < 100, `event loop held for ${Math.round(maxGap)} ms (list took ${Math.round(n - t0)} ms)`);
});
