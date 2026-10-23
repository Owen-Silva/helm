// Unit tests for main/update.js: HEAD reading (loose ref, packed-refs, detached, worktree), commit
// subjects, the auto-restart gate (each reason), the quiet period on an injected clock, and the
// autoRestart setting.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const U = require('../../main/update.js');
const { createSettings } = require('../../main/settings.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-update-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
function fakeGit(name, files) {
  const dir = path.join(tmp, name, '.git');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true }).trim();
function realRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'main'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(dir, 'main', 'x.js'), '1\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first commit');
  return dir;
}
function commit(dir, subject) {
  fs.appendFileSync(path.join(dir, 'main', 'x.js'), subject + '\n');
  git(dir, 'commit', '-q', '-am', subject);
  return git(dir, 'rev-parse', 'HEAD');
}

describe('readHead', () => {
  test('loose branch ref', () => {
    const g = fakeGit('loose', { HEAD: 'ref: refs/heads/master\n', 'refs/heads/master': A + '\n' });
    assert.deepEqual(U.readHead(g), { sha: A, ref: 'refs/heads/master', detached: false });
  });
  test('packed-refs when there is no loose file (peeled lines skipped)', () => {
    const g = fakeGit('packed', { HEAD: 'ref: refs/heads/main\n', 'packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${C} refs/heads/other\n${B} refs/heads/main\n^${A}\n` });
    assert.equal(U.readHead(g).sha, B);
  });
  test('a loose ref wins over packed-refs', () => {
    const g = fakeGit('both', { HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': C, 'packed-refs': `${B} refs/heads/main\n` });
    assert.equal(U.readHead(g).sha, C);
  });
  test('detached HEAD', () => {
    const g = fakeGit('detached', { HEAD: B + '\n' });
    assert.deepEqual(U.readHead(g), { sha: B, ref: null, detached: true });
  });
  test('a branch with no commits yet, a half-written ref, no repo', () => {
    assert.equal(U.readHead(fakeGit('empty', { HEAD: 'ref: refs/heads/master\n' })).sha, null);
    assert.equal(U.readHead(fakeGit('partial', { HEAD: 'ref: refs/heads/master\n', 'refs/heads/master': 'abc' })), null);
    assert.equal(U.readHead(path.join(tmp, 'nope', '.git')), null);
    assert.equal(U.resolveGitDir(path.join(tmp, 'nope')), null);
  });
  test('linked worktree: .git file -> gitdir, refs in the common dir', () => {
    const common = fakeGit('wt-main', { HEAD: 'ref: refs/heads/master\n', 'refs/heads/feature': A });
    const wtGit = path.join(common, 'worktrees', 'wt');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/feature\n');
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    const work = path.join(tmp, 'wt-work');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, '.git'), `gitdir: ${wtGit}\n`);
    const g = U.resolveGitDir(work);
    assert.equal(path.resolve(g), path.resolve(wtGit));
    assert.equal(U.readHead(g).sha, A);
  });
  test('a real repo: HEAD, commit subject, commits between, dirty files, git op', async () => {
    const dir = realRepo('real');
    const g = U.resolveGitDir(dir);
    const first = git(dir, 'rev-parse', 'HEAD');
    assert.equal(U.readHead(g).sha, first);
    assert.equal(U.readCommit(g, first).subject, 'first commit');
    const two = commit(dir, 'second: fix the thing');
    const three = commit(dir, 'third');
    assert.equal(U.readHead(g).sha, three);
    assert.deepEqual((await U.commitsBetween(dir, g, first, three)).map((c) => c.subject), ['third', 'second: fix the thing']);
    assert.equal((await U.commitsBetween(dir, g, two, three)).length, 1);
    // packed objects: falls back to git log
    git(dir, 'gc', '-q');
    assert.equal(U.readCommit(g, three), null);
    assert.deepEqual((await U.commitsBetween(dir, g, first, three)).map((c) => c.short), [three.slice(0, 7), two.slice(0, 7)]);
    assert.deepEqual(await U.dirtyFiles(dir), { files: [] });
    fs.appendFileSync(path.join(dir, 'main', 'x.js'), 'edit\n');
    fs.writeFileSync(path.join(dir, 'main', 'untracked.js'), 'new\n'); // untracked files are never loaded on their own
    assert.deepEqual(await U.dirtyFiles(dir), { files: ['main/x.js'] });
    assert.equal(U.gitOpInProgress(g), null);
    fs.writeFileSync(path.join(g, 'MERGE_HEAD'), first);
    assert.equal(U.gitOpInProgress(g), 'merge');
    fs.mkdirSync(path.join(g, 'rebase-merge'));
    assert.equal(U.gitOpInProgress(g), 'rebase');
  });
});

describe('restartBlockers (the gate)', () => {
  const NOW = 1_000_000_000;
  const clear = { sessions: [], queueRunning: 0, gitOp: null, dirty: { files: [] }, now: NOW, lastInputAt: NOW - 121_000, attachments: 0, autoRestart: true };
  const reasons = (patch, o) => U.restartBlockers({ ...clear, ...patch }, o);
  test('clear when nothing runs and the user has been away 2 min', () => {
    assert.deepEqual(reasons({}), []);
    assert.deepEqual(reasons({ lastInputAt: 0 }), []);
  });
  test('each reason, in words', () => {
    const cases = [
      [{ sessions: [{ working: true }] }, '1 session working'],
      [{ sessions: [{ working: true }, { working: true }] }, '2 sessions working'],
      [{ sessions: [{ waiting: true }] }, '1 session waiting on you'],
      [{ sessions: [{ starting: true }] }, '1 session starting'],
      [{ sessions: [{ compacting: true }] }, '1 session compacting'],
      [{ sessions: [{ queued: 2 }] }, '2 queued messages'],
      [{ sessions: [{ agents: 1 }, { agents: 1 }] }, '2 agents running'],
      [{ sessions: [{ tasks: 1 }] }, '1 background task running'],
      [{ sessions: [{ shells: 1 }] }, '1 ! command running'],
      [{ queueRunning: 1 }, 'the overnight queue is running a job'],
      [{ gitOp: 'rebase' }, 'a git rebase is in progress'],
      [{ dirty: { files: ['main/x.js', 'ui/a.js', 'ui/b.js'] } }, 'uncommitted changes in main/x.js and 2 more'],
      [{ dirty: { error: 'git not found' } }, 'could not check for uncommitted changes (git not found)'],
      [{ attachments: 1 }, '1 unsent attachment in the composer'],
      [{ lastInputAt: NOW - 40_000 }, 'you used Helm 40 s ago'],
      [{ lastInputAt: NOW - 119_000 }, 'you used Helm 2 min ago'],
      [{ autoRestart: false }, 'automatic restart is off'],
    ];
    for (const [patch, want] of cases) assert.deepEqual(reasons(patch), [want], JSON.stringify(patch));
  });
  test('several at once, joined for the UI', () => {
    const r = reasons({ sessions: [{ working: true, agents: 2 }] });
    assert.deepEqual(r, ['1 session working', '2 agents running']);
    assert.equal(U.waitingText(r), 'waiting: 1 session working · 2 agents running');
  });
  test('manual restart: only what would be cut off or loaded half-done', () => {
    const r = reasons({ lastInputAt: NOW - 1000, attachments: 2, autoRestart: false, sessions: [{ agents: 1 }], dirty: { files: ['main.js'] } }, { manual: true });
    assert.deepEqual(r, ['1 agent running', 'uncommitted changes in main.js']);
  });
  test('the input window is configurable (tests) and 2 min by default', () => {
    assert.equal(U.INPUT_QUIET_MS, 120_000);
    assert.deepEqual(reasons({ lastInputAt: NOW - 5000, inputQuietMs: 4000 }), []);
  });
});

describe('createUpdater (injected clock)', () => {
  function fakeTimers() {
    let t = 5_000_000, seq = 0;
    const q = new Map();
    const add = (fn, ms, every) => { const id = ++seq; q.set(id, { at: t + ms, fn, every }); return id; };
    const timers = { setTimeout: (fn, ms) => add(fn, ms, 0), setInterval: (fn, ms) => add(fn, ms, ms), clearTimeout: (id) => q.delete(id), clearInterval: (id) => q.delete(id) };
    const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    async function advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of q) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        const [id, x] = next;
        t = x.at;
        if (x.every) x.at += x.every; else q.delete(id);
        x.fn();
        await flush();
      }
      t = end;
      await flush();
    }
    return { timers, clock: () => t, advance, flush };
  }

  function setup(blockers) {
    const dir = realRepo('upd-' + Math.random().toString(36).slice(2, 8));
    const ft = fakeTimers();
    const calls = { gate: 0, restart: [], events: [] };
    let next = blockers;
    const u = U.createUpdater({
      repoDir: dir, watch: false, clock: ft.clock, timers: ft.timers,
      emit: (ev, s) => calls.events.push(s),
      getBlockers: async () => { calls.gate++; return typeof next === 'function' ? next() : next; },
      restart: async (info) => { calls.restart.push(info); return true; },
      extra: () => ({ bootedAt: 1 }),
    });
    u.start();
    return { dir, u, ft, calls, setBlockers: (b) => { next = b; } };
  }

  test('no update while HEAD stays put; file edits alone never count', async () => {
    const { dir, u, ft, calls } = setup([]);
    fs.appendFileSync(path.join(dir, 'main', 'x.js'), 'half-edited\n');
    await ft.advance(10 * 60_000);
    assert.equal(u.state().pending, null);
    assert.equal(calls.gate, 0);
    assert.equal(calls.restart.length, 0);
    assert.equal(u.state().running.subject, 'first commit');
    assert.equal(u.state().bootedAt, 1);
    u.stop();
  });

  test('60 s of quiet after the LAST HEAD change, then the gate; restarts only once clear (re-confirmed)', async () => {
    const { dir, u, ft, calls, setBlockers } = setup(['1 session working']);
    commit(dir, 'feat: one');
    await ft.advance(30_000); // the 30 s poll sees it
    let p = u.state().pending;
    assert.equal(p.phase, 'settling');
    assert.equal(p.reason, 'waiting for commits to settle');
    assert.deepEqual(p.commits.map((c) => c.subject), ['feat: one']);
    const settle1 = p.settleAt;
    await ft.advance(30_000);
    commit(dir, 'fix: two'); // a second commit inside the window restarts the quiet period
    await ft.advance(30_000);
    p = u.state().pending;
    assert.ok(p.settleAt > settle1, 'quiet period restarted');
    assert.deepEqual(p.commits.map((c) => c.subject), ['fix: two', 'feat: one']);
    assert.equal(calls.gate, 0);
    await ft.advance(p.settleAt - ft.clock() - 1000);
    assert.equal(calls.gate, 0, 'not before 60 s of quiet');
    await ft.advance(1000);
    assert.equal(calls.gate, 1);
    assert.equal(u.state().pending.phase, 'waiting');
    assert.equal(u.state().pending.reason, 'waiting: 1 session working');
    assert.equal(calls.restart.length, 0);
    await ft.advance(30_000);
    assert.ok(calls.gate >= 2, 're-checked every 30 s');
    assert.equal(calls.restart.length, 0);
    // clear on the check but busy again 3 s later: no restart
    let n = 0;
    setBlockers(() => (n++ % 2 === 0 ? [] : ['1 session starting']));
    await ft.advance(30_000 + 3000);
    assert.equal(calls.restart.length, 0);
    assert.equal(u.state().pending.reason, 'waiting: 1 session starting');
    setBlockers([]);
    await ft.advance(30_000 + 3000);
    assert.equal(calls.restart.length, 1);
    assert.deepEqual(calls.restart[0].commits.map((c) => c.subject), ['fix: two', 'feat: one']);
    assert.equal(calls.restart[0].auto, true);
    assert.equal(u.state().pending.phase, 'restarting');
    assert.ok(calls.events.some((s) => s.pending && s.pending.phase === 'waiting'), 'emitted app.update with the waiting state');
    u.stop();
  });

  test('HEAD back at the running commit: nothing pending', async () => {
    const { dir, u, ft, calls } = setup([]);
    const first = git(dir, 'rev-parse', 'HEAD');
    commit(dir, 'oops');
    await ft.advance(30_000);
    assert.ok(u.state().pending);
    git(dir, 'reset', '-q', '--hard', first);
    await ft.advance(30_000);
    assert.equal(u.state().pending, null);
    await ft.advance(5 * 60_000);
    assert.equal(calls.restart.length, 0);
    u.stop();
  });

  test('a declined restart (test run) keeps waiting and says why', async () => {
    const dir = realRepo('upd-declined');
    const ft = fakeTimers();
    const u = U.createUpdater({ repoDir: dir, watch: false, clock: ft.clock, timers: ft.timers, getBlockers: async () => [], restart: async () => false });
    u.start();
    commit(dir, 'x');
    await ft.advance(30_000 + 60_000 + 3000);
    assert.equal(u.state().pending.phase, 'waiting');
    assert.match(u.state().pending.reason, /cannot restart itself/);
    u.stop();
  });

  // lane restart: "Restart when finished" waits on the MANUAL gate (what a restart cuts off), then restarts.
  test('restart when finished: waits while agents run, restarts once clear (re-confirmed), names who asked', async () => {
    const dir = realRepo('upd-defer');
    const ft = fakeTimers();
    const asked = [];
    let next = ['1 session working', '5 agents running'];
    const restarts = [];
    const u = U.createUpdater({ repoDir: dir, watch: false, clock: ft.clock, timers: ft.timers,
      getBlockers: async (o) => { asked.push(o && o.manual); return next.slice(); }, restart: async (i) => { restarts.push(i); return true; } });
    u.start();
    const s0 = u.restartWhenIdle({ by: 'desktop' });
    await ft.flush();
    assert.equal(s0.deferred.by, 'desktop');
    assert.equal(u.state().deferred.phase, 'waiting');
    assert.equal(u.state().deferred.reason, 'waiting: 1 session working · 5 agents running');
    await ft.advance(60_000);
    assert.equal(restarts.length, 0, 'never while agents run');
    assert.ok(asked.length >= 10 && asked.every((m) => m === true), 'the manual gate, every 5 s');
    next = ['1 agent running'];
    await ft.advance(5_000);
    assert.equal(u.state().deferred.reason, 'waiting: 1 agent running');
    next = [];
    await ft.advance(5_000); // clear once ...
    assert.equal(restarts.length, 0, 'not before the 3 s re-confirm');
    await ft.advance(3_000); // ... and still clear 3 s later
    assert.equal(restarts.length, 1);
    assert.deepEqual(restarts[0], { auto: false, by: 'desktop', deferred: true });
    assert.equal(u.state().deferred.phase, 'restarting');
    await ft.advance(60_000);
    assert.equal(restarts.length, 1, 'once');
    u.stop();
  });

  test('restart when finished: a turn that starts during the re-confirm wins; cancel takes it back', async () => {
    const dir = realRepo('upd-defer2');
    const ft = fakeTimers();
    let calls = 0;
    const restarts = [];
    const u = U.createUpdater({ repoDir: dir, watch: false, clock: ft.clock, timers: ft.timers,
      getBlockers: async () => (++calls === 2 ? ['1 session working'] : calls > 2 ? ['2 agents running'] : []), restart: async (i) => { restarts.push(i); return true; } });
    u.start();
    u.restartWhenIdle({ by: 'phone' });
    await ft.flush(); // the first check is clear: the 3 s re-confirm is now pending
    await ft.advance(3_000);
    assert.equal(restarts.length, 0, 'clear, then busy on the re-confirm: no restart');
    assert.equal(u.state().deferred.reason, 'waiting: 1 session working');
    assert.equal(u.cancelWhenIdle(), true);
    assert.equal(u.state().deferred, null);
    await ft.advance(60_000);
    assert.equal(restarts.length, 0);
    assert.equal(u.cancelWhenIdle(), false, 'nothing left to cancel');
    u.stop();
  });

  test('not a git work tree: detection off, state still answers', () => {
    const u = U.createUpdater({ repoDir: path.join(tmp, 'plain'), watch: false, getBlockers: async () => [], restart: async () => true });
    u.start();
    assert.equal(u.state().running.sha, null);
    assert.equal(u.state().pending, null);
    u.stop();
  });
});

describe('autoRestart setting', () => {
  test('defaults on, accepts booleans only, persists', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'settings-'));
    const s = createSettings({ userDataDir: dir, uiBgDir: path.join(dir, 'bg'), appDataDir: dir, home: dir });
    assert.equal(s.get().autoRestart, true);
    assert.throws(() => s.set({ autoRestart: 'no' }), /autoRestart must be true or false/);
    assert.throws(() => s.set({ autoRestart: 0 }), (e) => e.code === 'bad_params');
    assert.equal(s.set({ autoRestart: false }).autoRestart, false);
    const again = createSettings({ userDataDir: dir, uiBgDir: path.join(dir, 'bg'), appDataDir: dir, home: dir });
    assert.equal(again.get().autoRestart, false);
  });
});
