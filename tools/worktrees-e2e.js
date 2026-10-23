// End-to-end proof of worktrees (lane helm-next3, 2026-10-15) in the REAL app: a hidden `Helm.exe --test`
// (off-screen window, throwaway profile, its own port) with an empty throwaway CLAUDE_CONFIG_DIR (Claude Code
// authenticates with ANTHROPIC_API_KEY), on a throwaway git repo under %TEMP% that has a small node_modules.
//   1. the Worktrees panel opens on the repo (real worktrees.list) and shows only the main folder
//   2. its "New worktree" button opens the New session dialog with the worktree part on; a name and
//      "Copy dependencies" are entered and "Create worktree and start" is clicked: the real backend makes
//      <repo>-wt/<name> on wk/<name> with a REAL node_modules copy (not a link), and a claude-haiku-5-5 session
//      starts there and commits one file
//   3. the panel lists the worktree 1 ahead; after the session is closed, Merge -> Merge fast-forwards master
//   4. Remove with "Also delete the branch" -> the folder and wk/<name> are gone, master keeps the file, and the
//      repo's own node_modules is untouched
// Guards: >= 2.5 GB free RAM, the machine-wide %TEMP%\claude-headless-browser.lock, and ANTHROPIC_API_KEY
// set in the environment (else SKIP, exit 2). Never touches port 4871, %APPDATA%\Helm, ~/.claude or any process it did not start.
// Summary line: `worktrees-e2e: N passed, M failed`. Usage: node tools/worktrees-e2e.js [--exe=…] [--keep] [--shot=dir]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');
const { dropLiveTranscripts } = require('./live-cleanup');

const ROOT = path.join(__dirname, '..');
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const EXE = arg('exe') ? path.resolve(ROOT, arg('exe')) : require(path.join(ROOT, 'node_modules', 'electron'));
const KEEP = process.argv.includes('--keep');
const SHOTS = path.resolve(arg('shot') || os.tmpdir());
fs.mkdirSync(SHOTS, { recursive: true });
const profile = 'wte' + process.pid;
const userData = path.join(os.tmpdir(), 'helm-test-' + profile);
const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'helm-wt-e2e-')));
const repo = path.join(parent, 'demo');
const NAME = 'e2e-wt';
const wtPath = path.join(parent, 'demo-wt', NAME);
const cfg = path.join(os.tmpdir(), 'helm-wt-e2e-cfg-' + process.pid);
const LOCK = path.join(os.tmpdir(), 'claude-headless-browser.lock');
const T0 = Date.now();
const stamp = () => new Date().toISOString().slice(11, 23);
const note = (...a) => console.log(stamp(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, what) => { results.push({ ok: !!ok, what }); console.log(`${stamp()} ${ok ? 'PASS' : 'FAIL'} ${what}`); return ok; };
const started = new Set();
let haveLock = false;
const ours = (pid) => { try { return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true }).includes(profile); } catch { return false; } };
const killTree = (pid) => { if (!ours(pid)) return; try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} };
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', windowsHide: true }).trim();
const gitOk = (...a) => { try { git(...a); return true; } catch { return false; } };

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
function connect(port, token) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { origin: `http://127.0.0.1:${port}` });
    let id = 1;
    const pending = new Map();
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); if (p) p(m); } });
    const rpc = (method, params = {}) => new Promise((ok, bad) => {
      const i = id++;
      pending.set(i, (m) => (m.error ? bad(Object.assign(new Error(m.error.message), { code: m.error.code })) : ok(m.result)));
      ws.send(JSON.stringify({ id: i, type: 'rpc', method, params }));
      setTimeout(() => { if (pending.delete(i)) bad(new Error(`${method} timed out`)); }, 60000);
    });
    ws.on('close', () => { for (const [i, p] of pending) { pending.delete(i); p({ error: { message: 'connection closed', code: 'closed' } }); } });
    ws.once('open', () => res({ ws, rpc }));
    ws.once('error', rej);
  });
}
async function waitReady(child, getOut) {
  for (const end = Date.now() + 60000; Date.now() < end; await sleep(250)) {
    const m = /HELM_READY (\{.*\})/.exec(getOut());
    if (m) return JSON.parse(m[1]);
    if (child.exitCode !== null) throw new Error('app exited early:\n' + getOut().slice(-1500));
  }
  throw new Error('no HELM_READY in 60 s');
}
const sessionsOf = async (c) => (await c.rpc('app.hello')).sessions || [];
const ui = (c, js) => c.rpc('test.eval', { js });
// poll a UI expression until it is truthy
async function uiWait(c, js, ms = 20000) {
  let v = null;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) {
    v = await ui(c, js).catch(() => null);
    if (v) return v;
  }
  return v;
}
const click = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el || el.disabled) return false; el.click(); return true; })()`;
const clickText = (scope, text) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)})].find((b) => b.textContent.trim().includes(${JSON.stringify(text)})); if (!el || el.disabled) return false; el.click(); return true; })()`;
const shot = async (c, name) => { try { await c.rpc('test.capture', { file: path.join(SHOTS, `worktrees-e2e-${name}.png`), waitMs: 400 }); } catch (e) { note('capture failed:', e.message); } };

async function answerQuestion(c, id, ss) {
  const pr = ss && ss.pendingRequest;
  if (!(pr && pr.kind === 'question' && pr.choice && Array.isArray(pr.choice.options) && pr.choice.options.length)) return;
  const opt = pr.choice.options.find((o) => /^\s*yes\b/i.test(String(o.label))) || pr.choice.options[0];
  note(`answering "${pr.choice.question}" with "${opt.label}"`);
  await c.rpc('sessions.respond', { id, requestId: pr.requestId, response: { answers: { [pr.choice.question]: opt.label } } }).catch((e) => note('respond failed:', e.message));
}

async function main() {
  const freeGb = Number(execFileSync('powershell', ['-NoProfile', '-Command', '[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,2)'], { encoding: 'utf8', windowsHide: true }).trim());
  note(`free RAM ${freeGb} GB`);
  if (!(freeGb >= 2.5)) throw new Error(`only ${freeGb} GB free RAM (needs 2.5 GB for an Electron instance): not starting`);
  const held = readJson(LOCK);
  if (held && held.pid && alive(held.pid)) throw new Error(`the headless-browser lock is held by pid ${held.pid} (${held.by || '?'})`);
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, by: 'helm worktrees-e2e', at: new Date().toISOString() }));
  haveLock = true;
  fs.mkdirSync(cfg, { recursive: true });   // empty: the instance's Claude Code gets ANTHROPIC_API_KEY from the env

  // the throwaway repo: one commit, a package.json + lockfile and a small REAL node_modules (ignored)
  fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'master', repo], { windowsHide: true });
  fs.writeFileSync(path.join(repo, 'package.json'), '{ "name": "demo", "version": "1.0.0", "private": true }\n');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{ "name": "demo", "version": "1.0.0", "lockfileVersion": 3, "requires": true, "packages": { "": { "name": "demo", "version": "1.0.0" } } }\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = (s) => s;\n');
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@local', '-c', 'commit.gpgsign=false', 'add', '.');
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial');
  const port = await freePort();
  note(`profile ${profile}; port ${port}; repo ${repo}; CLAUDE_CONFIG_DIR ${cfg}`);

  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, HELM_CLAUDE_DIR: cfg, HELM_CLAUDE_PROJECTS: path.join(cfg, 'projects') };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;   // API key only: never hand a subscription token to the test instance
  const child = spawn(EXE, [ROOT, '--test', '--profile=' + profile, '--port=' + port], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  started.add(child.pid);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const ready = await waitReady(child, () => out);
  started.add(ready.pid);
  note(`instance up: pid ${ready.pid}`);
  const c = await connect(port, ready.token);
  await uiWait(c, `!!document.querySelector('body') && document.readyState === 'complete'`);

  // 1. the Worktrees panel on the repo
  await ui(c, `import('/shell/worktrees.js').then((m) => { m.openWorktrees(${JSON.stringify(repo)}); return true; })`);
  const rows1 = await uiWait(c, `(() => { const l = [...document.querySelectorAll('.wt-sheet .wt-item')]; return l.length ? l.map((li) => li.dataset.wt + (li.classList.contains('main') ? ':main' : '')).join(',') : null; })()`);
  check(rows1 && /:main/.test(rows1) && rows1.split(',').length === 1, `the panel lists only the main folder: ${rows1}`);
  await shot(c, '1-panel');

  // 2. New worktree -> the New session dialog with the worktree part on
  check(await ui(c, clickText('.wt-sheet button', 'New worktree')), 'clicked New worktree');
  const dlg = await uiWait(c, `(() => { const t = document.querySelector('.wt-toggle input'); return t && t.checked ? 'on' : (document.querySelector('.wt-name-input') ? 'name-input' : null); })()`);
  check(dlg, `the dialog opened with the worktree part on (${dlg})`);
  // the panel button sets only { cwd, worktree }; reopen with the model / mode / prompt this test needs (the
  // dialog takes its first values from newSessionOpen), keeping the worktree part on
  const prompt = 'Without asking any question first, do exactly this and nothing else: create a file named e2e.txt in the current folder containing the single line hello from the worktree, then run this Bash command: git add e2e.txt && git -c user.name=e2e -c user.email=e2e@local -c commit.gpgsign=false commit -q -m "e2e: add e2e.txt". Then reply with the single word done.';
  await ui(c, `import('/shell/state.js').then(async (st) => { st.newSessionOpen.value = false; await new Promise((r) => setTimeout(r, 200)); st.newSessionOpen.value = { cwd: ${JSON.stringify(repo)}, worktree: true, model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'bypassPermissions', prompt: ${JSON.stringify(prompt)} }; return true; })`);
  const nameReady = await uiWait(c, `!!document.querySelector('.wt-name-input')`, 20000);
  check(nameReady, 'the worktree name field is there (worktrees.info read the repo)');
  await ui(c, `(() => { const i = document.querySelector('.wt-name-input'); i.value = ${JSON.stringify(NAME)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const copyOn = await uiWait(c, `(() => { const b = [...document.querySelectorAll('.wt-deps button')].find((x) => /Copy dependencies/.test(x.textContent)); if (!b || b.disabled) return false; b.click(); return true; })()`, 10000);
  check(copyOn, 'chose Copy dependencies (real copy)');
  await sleep(300);
  await shot(c, '2-dialog');
  const go = await uiWait(c, clickText('.modal button.btn-primary', 'Create worktree and start'), 5000);
  check(go, 'clicked Create worktree and start');
  let s = null;
  for (const end = Date.now() + 90000; Date.now() < end; await sleep(1000)) {
    s = (await sessionsOf(c)).find((x) => x.cwd && path.resolve(x.cwd).toLowerCase() === wtPath.toLowerCase());
    if (s) break;
  }
  check(s, `a session started in ${wtPath}`);
  check(fs.existsSync(wtPath) && git('-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD') === 'wk/' + NAME, `the worktree exists on wk/${NAME}`);
  const nm = path.join(wtPath, 'node_modules');
  const nmStat = fs.existsSync(nm) ? fs.lstatSync(nm) : null;
  let isLink = false;
  try { isLink = !!nmStat && (nmStat.isSymbolicLink() || fs.realpathSync.native(nm).toLowerCase() !== nm.toLowerCase()); } catch {}
  check(nmStat && nmStat.isDirectory() && !isLink && fs.existsSync(path.join(nm, 'left-pad', 'index.js')), `its node_modules is a REAL copy (dir ${!!nmStat && nmStat.isDirectory()}, link ${isLink})`);
  if (!s) return;

  // the Haiku turn commits e2e.txt in the worktree
  let ss = null;
  for (const end = Date.now() + 180000; Date.now() < end; await sleep(1500)) {
    ss = (await sessionsOf(c)).find((x) => x.id === s.id);
    if (ss && ss.status === 'idle' && (ss.lastText || '').length) break;
    await answerQuestion(c, s.id, ss);
  }
  const ahead = Number(git('-C', wtPath, 'rev-list', '--count', 'master..HEAD'));
  check(ahead === 1 && fs.existsSync(path.join(wtPath, 'e2e.txt')), `Claude committed e2e.txt in the worktree (wk/${NAME} ${ahead} ahead of master; status ${ss && ss.status}; last ${JSON.stringify(String((ss && ss.lastText) || '').slice(0, 80))})`);
  await shot(c, '3-session');
  await c.rpc('sessions.close', { id: s.id }).catch((e) => note('close failed:', e.message));
  await sleep(1000);

  // 3. merge through the panel
  await ui(c, `import('/shell/worktrees.js').then((m) => { m.worktreesFor.value = null; setTimeout(() => m.openWorktrees(${JSON.stringify(repo)}), 100); return true; })`);
  const row = `.wt-sheet .wt-item[data-wt="${NAME}"]`;
  const meta = await uiWait(c, `(() => { const li = document.querySelector(${JSON.stringify(row)}); return li ? li.querySelector('.wt-meta').textContent.trim() : null; })()`);
  check(meta && /1 ahead/.test(meta), `the panel lists ${NAME}: ${meta}`);
  await shot(c, '4-listed');
  check(await uiWait(c, click(`${row} [data-act="merge"]`), 10000), 'clicked Merge into master');
  check(await uiWait(c, click(`${row} [data-act="merge-go"]`), 5000), 'confirmed Merge');
  const merged = await uiWait(c, `(() => [...document.querySelectorAll('.toasts .toast')].map((t) => t.textContent).find((t) => /Merged wk\\/${NAME} into master/.test(t)) || null)()`, 20000);
  check(merged, `toast: ${merged && merged.slice(0, 120)}`);
  const mHead = git('rev-parse', 'master'), wHead = git('-C', wtPath, 'rev-parse', 'HEAD');
  check(mHead === wHead && git('show', 'master:e2e.txt').includes('hello'), `master fast-forwarded to the worktree's commit (master ${mHead.slice(0, 7)}, wk/${NAME} ${wHead.slice(0, 7)})`);
  // master is checked out in the main folder, so the fast-forward also brings the file into it, and leaves it clean
  check(fs.existsSync(path.join(repo, 'e2e.txt')) && git('status', '--porcelain') === '', 'the main folder has e2e.txt and is clean');
  await shot(c, '5-merged');

  // 4. remove through the panel, deleting the branch
  check(await uiWait(c, click(`${row} [data-act="remove"]`), 10000), 'clicked Remove');
  await uiWait(c, `(() => { const box = [...document.querySelectorAll(${JSON.stringify(row + ' .wt-check')})].find((l) => /delete the branch/.test(l.textContent)); if (!box) return false; const i = box.querySelector('input'); if (!i.checked) i.click(); return true; })()`, 5000);
  check(await uiWait(c, click(`${row} [data-act="remove-go"]`), 5000), 'confirmed Remove (with Also delete the branch)');
  const gone = await uiWait(c, `!document.querySelector(${JSON.stringify(row)})`, 30000);
  check(gone, 'the row is gone from the panel');
  check(!fs.existsSync(wtPath), `the folder ${wtPath} is gone`);
  check(!gitOk('rev-parse', '--verify', '--quiet', 'refs/heads/wk/' + NAME), `the branch wk/${NAME} is deleted`);
  check(!git('worktree', 'list').includes(NAME), 'git worktree list no longer has it');
  check(fs.existsSync(path.join(repo, 'node_modules', 'left-pad', 'index.js')), "the repo's own node_modules is untouched");
  await shot(c, '6-removed');
}

if (!(process.env.ANTHROPIC_API_KEY || '').trim()) {
  console.log('worktrees-e2e: SKIP, ANTHROPIC_API_KEY is not set (this test runs a live Claude Code session, which authenticates with an Anthropic API key from the environment, as Helm passes it). Set it and re-run.');
  process.exit(2);
}

main().catch((e) => { check(false, 'threw: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); }).finally(async () => {
  try {
    const log = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8').split('\n');
    for (const l of log.filter((x) => /worktree|boot failed|uncaught/i.test(x)).slice(-15)) console.log('  log ' + l.slice(0, 300));
  } catch (e) { console.log('  (no profile log: ' + e.message + ')'); }
  for (const pid of started) killTree(pid);
  await sleep(1500);
  if (!KEEP) console.log(`  cleaned up ${dropLiveTranscripts([repo, wtPath]).length} transcript folder(s)`);
  if (!KEEP) { for (const d of [parent, userData, cfg]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } }
  if (haveLock) { try { const l = readJson(LOCK); if (l && l.pid === process.pid) fs.rmSync(LOCK, { force: true }); } catch {} }
  const pass = results.filter((x) => x.ok).length;
  console.log(`worktrees-e2e: ${pass} passed, ${results.length - pass} failed (${((Date.now() - T0) / 1000).toFixed(0)} s; stopped PIDs ${[...started].join(', ')})`);
});
