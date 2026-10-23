'use strict';
// Worktrees (lane helm-worktrees, 2026-10-14; backlog H4): a session in its own git worktree, and a
// Worktrees panel per repo. A by-hand habit made one click: each lane runs in its own worktree beside the repo
// (~/<repo>-wt/<name>). Layout follows that: a worktree of <parent>/<repo> lives at
// <parent>/<repo>-wt/<name>, on a new branch wk/<name>.
//
//   worktrees.info   { cwd }                          the repo, its branches and node_modules (the dialog)
//   worktrees.create { cwd, name, base? }             git worktree add <repo>-wt/<name> -b wk/<name> <base>
//   worktrees.deps   { path, mode: 'copy'|'install' } a REAL copy of node_modules, or npm ci / npm install
//   worktrees.list   { cwd }                          every worktree: branch, ahead/behind its base, dirty,
//                                                     last commit, the sessions using it, can it merge
//   worktrees.merge  { path, confirmRestart? }        the worktree's branch into its base
//   worktrees.remove { path, discard?, deleteBranch? } junction-safe remove
//
// node_modules is NEVER linked. On Windows `git worktree remove` follows an NTFS junction inside the
// worktree and deletes the TARGET's files (2026-09-05: a node_modules junction wiped a repo's real
// node_modules). So deps are a real copy (robocopy /XJ: junctions are not followed or copied) or an install,
// and remove first takes every link out of the worktree (rmdir on a junction removes only the link), checks
// each target is still there, and only then asks git to remove the folder.
//
// Merge: fast-forward when the base has not moved, otherwise a merge commit; never forced. Refused, in plain
// words, when the worktree has uncommitted changes, when there is nothing to merge, when the branch or the
// base is behind its own upstream (as of the last fetch: Helm never fetches), when the base's checkout has
// uncommitted changes, or when the merge would conflict (checked with `git merge-tree` before anything is
// touched). A protected branch (the production guard's repos in <userData>/prod-guard.json, see
// main/engine/prod-guard.js: a listed branch, or any branch of a repo guarded on every push) is
// refused outright. Merging into the branch Helm itself runs from restarts Helm (main/update.js watches its
// HEAD), so that needs { confirmRestart: true }; without it the call fails with code 'confirm_restart'.
//
// Every refusal is an Error with a plain sentence for the user and a code; git's own words, when there are any,
// ride in data.git (the toast's Details).

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { parseStatusV2 } = require('./git');
const prodGuard = require('./engine/prod-guard');

const BRANCH_PREFIX = 'wk/';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const COPY_MAX_BYTES = 800 * 1024 * 1024;   // node_modules up to this is copied by default (Helm's is ~690 MB, ~21 s)
const COPY_MAX_FILES = 60_000;
const SIZE_BUDGET_MS = 5000;                 // measuring node_modules stops here; unfinished = "large"
const WALK_MAX = 400_000;                    // entries checked for links before a remove
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const GIT_TIMEOUT_MS = 60_000;
const GIT_SAFE = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-c', 'color.ui=false', '-c', 'log.showSignature=false'];
const WIN = process.platform === 'win32';

function wtErr(message, code = 'refused', data) {
  return Object.assign(new Error(message), { code }, data ? { data } : {});
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
const tail = (s, n = 4000) => { s = String(s || ''); return s.length > n ? '…' + s.slice(-n) : s; };

// git runner: never rejects. -> { ok, out, err, code }  (code 'ENOENT' = git missing)
function runGit(cwd, args, { timeout = GIT_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve) => {
    execFile('git', [...GIT_SAFE, ...args], {
      cwd, windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no', LC_ALL: 'C', LANG: 'C', ...(env || {}) },
    }, (e, stdout, stderr) => {
      resolve({ ok: !e, out: String(stdout || '').replace(/\r?\n$/, ''), err: String(stderr || ''), code: e ? (e.code ?? 1) : 0 });
    });
  });
}
async function gitOrThrow(cwd, args, what, opts) {
  const r = await runGit(cwd, args, opts);
  if (r.ok) return r.out;
  if (r.code === 'ENOENT') throw wtErr('Git is not installed or not on the PATH, so Helm cannot manage worktrees.', 'git_unavailable');
  throw wtErr(`${what}. Git said: ${firstLine(r.err) || 'nothing (it failed without a message)'}`, 'git_failed', { git: tail(r.err || r.out) });
}

// Canonical form for comparing folders: long names (RUNNER~1), the real case, lower case on Windows.
function canon(p) {
  let r = path.resolve(String(p));
  try { r = fs.realpathSync.native(r); } catch {}
  return WIN ? r.toLowerCase() : r;
}
const inside = (child, parent) => { const c = canon(child), p = canon(parent); return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep); };

function requireDir(p, name) {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) throw wtErr(`Choose a ${name} first.`, 'bad_params');
  const abs = path.resolve(p.trim());
  let st;
  try { st = fs.statSync(abs); } catch { throw wtErr(`The folder ${abs} was not found. It may have been moved or deleted.`, 'not_found'); }
  if (!st.isDirectory()) throw wtErr(`${abs} is a file, not a folder.`, 'bad_params');
  return abs;
}

// `git worktree list --porcelain` -> [{ path, head, branch, detached, bare, locked, prunable }]; [0] = main.
function parseWorktreeList(out) {
  const list = [];
  let cur = null;
  for (const line of String(out || '').split(/\r?\n/)) {
    if (!line.trim()) { cur = null; continue; }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') { cur = { path: path.resolve(val), head: null, branch: null, detached: false, bare: false, locked: null, prunable: null }; list.push(cur); continue; }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = val;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') cur.locked = val || 'no reason given';
    else if (key === 'prunable') cur.prunable = val || 'its folder is gone';
  }
  return list;
}

// The repo a folder belongs to: its main worktree, where its worktrees go, every worktree.
async function repoOf(cwd) {
  const dir = requireDir(cwd, 'project folder');
  const top = await runGit(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    if (top.code === 'ENOENT') throw wtErr('Git is not installed or not on the PATH, so Helm cannot manage worktrees.', 'git_unavailable');
    if (/not a git repository/i.test(top.err)) throw wtErr(`${dir} is not inside a git repository, so it cannot have worktrees. Pick a folder inside a repo.`, 'not_repo');
    if (/dubious ownership|safe\.directory/i.test(top.err)) throw wtErr(`Git refuses to work in ${dir} because another Windows user owns it (git "safe.directory").`, 'not_repo', { git: tail(top.err) });
    throw wtErr(`Git could not read ${dir}. Git said: ${firstLine(top.err)}`, 'git_failed', { git: tail(top.err) });
  }
  const here = path.resolve(top.out.trim());
  const list = parseWorktreeList(await gitOrThrow(here, ['worktree', 'list', '--porcelain'], 'Git could not list the worktrees'));
  const main = list[0];
  if (!main || main.bare) throw wtErr('This repo is a bare repository (it has no main folder), and Helm only manages worktrees of a normal repo.', 'bare_repo');
  const name = path.basename(main.path);
  return { here, root: main.path, name, wtDir: path.join(path.dirname(main.path), `${name}-wt`), list, mainBranch: main.branch };
}

async function localBranches(root) {
  const r = await runGit(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/']);
  return r.ok ? r.out.split(/\r?\n/).filter(Boolean).slice(0, 300) : [];
}
async function branchExists(root, b) { return (await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`])).ok; }
async function revOf(root, ref) { const r = await runGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return r.ok ? r.out.trim() : null; }
async function helmBases(root) {
  // `branch.<name>.helmbase <base>` for every branch Helm made (the variable name comes back lower case)
  const r = await runGit(root, ['config', '--get-regexp', '^branch\\..*\\.helmbase$']);
  const out = new Map();
  if (!r.ok) return out;
  for (const line of r.out.split(/\r?\n/)) {
    const m = /^branch\.(.+)\.helmbase (.+)$/i.exec(line.trim());
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

// ---------- node_modules ----------
function lstatOrNull(p) { try { return fs.lstatSync(p); } catch { return null; } }
const isLink = (st) => !!st && st.isSymbolicLink();   // Node reports NTFS junctions as symbolic links too

async function measure(dir, budgetMs = SIZE_BUDGET_MS) {
  const t0 = Date.now();
  let bytes = 0, files = 0, links = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() - t0 > budgetMs) return { bytes, files, links, partial: true };
    const d = stack.pop();
    let ents;
    try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) { links++; continue; }
      if (e.isDirectory()) { stack.push(p); continue; }
      files++;
      try { bytes += (await fs.promises.lstat(p)).size; } catch {}
    }
  }
  return { bytes, files, links, partial: false };
}

// What the dialog offers for a folder's node_modules.
async function depsInfo(dir) {
  const nm = path.join(dir, 'node_modules');
  const hasPkg = fs.existsSync(path.join(dir, 'package.json'));
  const lock = ['package-lock.json', 'npm-shrinkwrap.json'].find((f) => fs.existsSync(path.join(dir, f))) || null;
  const install = hasPkg ? (lock ? 'npm ci' : 'npm install') : null;
  const st = lstatOrNull(nm);
  if (!st) return { exists: false, source: null, install, suggest: 'none' };
  if (isLink(st)) {
    return { exists: true, link: true, source: nm, install, copyable: false, suggest: install ? 'install' : 'none',
      why: 'This node_modules is a link (junction) to another folder, so Helm will not copy it. Use Install.' };
  }
  if (!st.isDirectory()) return { exists: false, source: null, install, suggest: 'none' };
  const m = await measure(nm);
  const small = !m.partial && m.bytes <= COPY_MAX_BYTES && m.files <= COPY_MAX_FILES;
  return { exists: true, link: false, source: nm, install, copyable: true, bytes: m.bytes, files: m.files, linksInside: m.links, partial: m.partial,
    suggest: small || !install ? 'copy' : 'install' };
}

function robocopy(src, dst) {
  // /E all subfolders, /XJ never follow or copy junctions / symlinks, /MT:8 threads. Exit codes < 8 = success.
  return new Promise((resolve) => {
    execFile('robocopy', [src, dst, '/E', '/XJ', '/MT:8', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'],
      { windowsHide: true, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (e, stdout, stderr) => {
        const code = e ? (typeof e.code === 'number' ? e.code : -1) : 0;
        resolve({ ok: code >= 0 && code < 8, code, out: tail(`${stdout || ''}${stderr || ''}`) });
      });
  });
}
async function nodeCopy(src, dst) {
  let skipped = 0;
  await fs.promises.cp(src, dst, {
    recursive: true, errorOnExist: true, force: false,
    filter: (s) => { const st = lstatOrNull(s); if (isLink(st)) { skipped++; return false; } return true; },
  });
  return skipped;
}

function runInstall(dir, cmd, npm) {
  const args = cmd === 'npm ci' ? ['ci'] : ['install'];
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(npm || (WIN ? 'npm.cmd' : 'npm'), [...args, '--no-audit', '--no-fund'], { cwd: dir, windowsHide: true, shell: WIN && !npm, env: { ...process.env, CI: '1' } });
    } catch (e) { resolve({ ok: false, code: e.code || 'spawn', out: String(e.message) }); return; }
    const add = (d) => { out = tail(out + d, 8000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { try { child.kill(); } catch {} add('\n(stopped after 15 minutes)'); }, INSTALL_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: e.code || 'spawn', out: tail(out + e.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out }); });
  });
}

// ---------- links inside a worktree (junction safety) ----------
async function findLinks(dir) {
  const links = [];
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) {
      if (d === dir) throw e;
      continue;
    }
    for (const e of ents) {
      if (++seen > WALK_MAX) return { links, tooMany: true };
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) links.push(p);
      else if (e.isDirectory()) stack.push(p);
    }
  }
  return { links, tooMany: false };
}

// Take a link out (only the link: rmdir on a junction / directory symlink never touches the target).
async function unlinkOnly(p) {
  let target = null;
  try { target = fs.readlinkSync(p); } catch {}
  const resolvedTarget = target ? path.resolve(path.dirname(p), target) : null;
  const targetExisted = resolvedTarget ? fs.existsSync(resolvedTarget) : false;
  try { await fs.promises.rmdir(p); } catch (e1) {
    try { await fs.promises.unlink(p); } catch (e2) { throw wtErr(`Helm could not take out the link at ${p}, so it stopped before deleting anything (removing the worktree could follow the link and delete the folder it points to).`, 'link_stuck', { git: `${e1.code || e1.message}; ${e2.code || e2.message}` }); }
  }
  if (lstatOrNull(p)) throw wtErr(`The link at ${p} is still there after Helm removed it, so Helm stopped before deleting anything.`, 'link_stuck');
  if (targetExisted && !fs.existsSync(resolvedTarget)) throw wtErr(`After taking out the link at ${p}, its target ${resolvedTarget} is missing. Helm stopped; check that folder.`, 'link_stuck');
  return { link: p, target: resolvedTarget };
}

// ---------- status of one worktree ----------
async function statusOf(dir) {
  const r = await runGit(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=dirty']);
  if (!r.ok) return { error: firstLine(r.err) || 'git status failed' };
  return parseStatusV2(r.out);
}
async function aheadBehind(root, base, branch) {
  const r = await runGit(root, ['rev-list', '--left-right', '--count', `${base}...${branch}`]);
  if (!r.ok) return null;
  const m = /^(\d+)\s+(\d+)$/.exec(r.out.trim());
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null;
}
async function upstreamGap(root, branch) {
  // how far `branch` is behind its own upstream, as of the last fetch; null = no upstream
  const up = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]);
  if (!up.ok || !up.out.trim()) return null;
  const ab = await aheadBehind(root, `${branch}@{upstream}`, branch);
  return ab ? { upstream: up.out.trim(), behind: ab.behind, ahead: ab.ahead } : null;
}
async function lastCommit(root, ref) {
  const r = await runGit(root, ['log', '-1', '--no-color', '--format=%h%x00%s%x00%ct', ref]);
  if (!r.ok || !r.out) return null;
  const [hash, subject, ct] = r.out.split('\0');
  return { hash, subject: subject || '', ts: Number(ct) * 1000 || null };
}

// A merge commit needs a name and email. The user's machine has none in git config (its sessions pass -c user.name),
// so when git has no identity, the merge commit is made in the name of whoever wrote the branch's last commit.
async function identityEnv(root, branch) {
  if ((await runGit(root, ['var', 'GIT_COMMITTER_IDENT'])).ok) return undefined;
  const r = await runGit(root, ['log', '-1', '--format=%an%x00%ae', branch]);
  const [name, email] = r.ok ? r.out.split('\0') : [];
  if (!name || !email) return undefined;
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

// Prod guard: the protected repos in <dataDir>/prod-guard.json, matched by remote URL (main/engine/prod-guard.js).
// No dataDir or no file: nothing is protected. An unreadable file fails closed: its stand-in target (all: true)
// matches every repo, so every merge is refused until the file is fixed.
async function guardTarget(root, dataDir) {
  const list = prodGuard.targets(dataDir);
  if (!list.length) return null;
  const r = await runGit(root, ['remote', '-v']);
  if (!r.ok) return null;
  const urls = r.out.split(/\r?\n/).map((l) => (/^\S+\s+(\S+)/.exec(l) || [])[1]).filter(Boolean).map(prodGuard.normalizeRemote);
  return list.find((t) => t.remotes.some((u) => urls.includes(u))) || list.find((t) => t.all) || null;
}
// Electron's userData folder (main.js sets it to Helm's data folder before anything runs); null outside
// Electron, where require('electron') is only the binary's path.
function electronUserData() {
  try {
    const { app } = require('electron');
    return app && typeof app.getPath === 'function' ? app.getPath('userData') : null;
  } catch { return null; }
}
function guardMessage(t, base) {
  if (!t) return null;
  if (t.all) return `Merging is refused: Helm could not read ${t.file} (${t.why}), so the production guard treats every repo as protected. Fix or delete that file to go back to your list.`;
  if (t.branches && !t.branches.includes(base)) return null;
  return t.branches
    ? `Merging into ${t.name} ${base} is refused: ${t.name} ${base} is production, and the production guard keeps it for you to merge and push by hand.`
    : `Merging in the ${t.name} repo is refused: every change to ${t.name} is guarded, so merge and push it by hand.`;
}
const RESTART_WARNING = "Merging into Helm's own master restarts Helm and stops running sessions.";

/**
 * createWorktrees({ getSessions, helmRoot, userDataDir, log, npm, copier })
 *   getSessions: async () => Session[] (engine snapshot), for "sessions using it" and the remove check
 *   helmRoot: the folder this Helm runs from (main.js __dirname); its branch restarts Helm when it moves
 *   userDataDir: Helm's data folder, where prod-guard.json lists the protected repos (default: Electron's
 *     userData path when running inside Electron, else none, so nothing is protected)
 *   npm / copier: tests only (an npm command path; 'node' forces the fs.cp copy instead of robocopy)
 */
function createWorktrees({ getSessions = async () => [], helmRoot = null, userDataDir = null, log = () => {}, npm = null, copier = null } = {}) {
  const guardDir = () => userDataDir || electronUserData();
  let helmCache = null;
  async function helmSelf() {
    if (!helmRoot) return null;
    if (helmCache && Date.now() - helmCache.t < 30_000) return helmCache.v;
    let v = null;
    const common = await runGit(helmRoot, ['rev-parse', '--git-common-dir']);
    const head = await runGit(helmRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (common.ok) v = { common: canon(path.resolve(helmRoot, common.out.trim())), branch: head.ok && head.out.trim() !== 'HEAD' ? head.out.trim() : null };
    helmCache = { v, t: Date.now() };
    return v;
  }
  async function restartsHelm(repo, base) {
    const h = await helmSelf();
    if (!h || !h.branch || base !== h.branch) return false;
    const common = await runGit(repo.root, ['rev-parse', '--git-common-dir']);
    return common.ok && canon(path.resolve(repo.root, common.out.trim())) === h.common;
  }
  async function sessionsList() {
    try { return (await getSessions()) || []; } catch (e) { log('worktrees: sessions unavailable:', e && e.message); return []; }
  }
  // which worktree each session is in (the deepest worktree folder containing its cwd)
  function sessionsByTree(list, sessions) {
    const out = new Map(list.map((w) => [w.path, []]));
    const byDepth = [...list].sort((a, b) => b.path.length - a.path.length);
    for (const s of sessions) {
      if (!s || !s.cwd) continue;
      const w = byDepth.find((x) => inside(s.cwd, x.path));
      if (w) out.get(w.path).push({ id: s.id, title: s.title || 'New session', status: s.status || 'idle', archived: !!s.archived });
    }
    return out;
  }
  function findTree(repo, p) {
    const w = repo.list.find((x) => canon(x.path) === canon(p));
    if (!w) throw wtErr(`${p} is not a worktree of ${repo.name}.`, 'not_worktree');
    return w;
  }
  async function baseOf(repo, w, bases) {
    const b = (bases || await helmBases(repo.root)).get(w.branch);
    return b || repo.mainBranch || null;
  }

  async function info(p = {}) {
    const repo = await repoOf(p.cwd);
    const here = repo.list.find((w) => canon(w.path) === canon(repo.here));
    const branches = await localBranches(repo.root);
    // copy from the folder you started in when it has a real node_modules (closest to the base), else the main one
    let deps = await depsInfo(repo.here);
    // (a worktree whose node_modules is a hand-made junction falls back to the main folder's real one)
    if ((!deps.exists || deps.link) && canon(repo.here) !== canon(repo.root)) {
      const m = await depsInfo(repo.root);
      if (!deps.exists || (m.exists && !m.link)) deps = m;
    }
    const taken = [...new Set([...branches, ...repo.list.map((w) => w.branch).filter(Boolean)])];
    return {
      root: repo.root, name: repo.name, wtDir: repo.wtDir, here: repo.here,
      currentBranch: here && here.branch ? here.branch : null, detached: !!(here && here.detached),
      branches, taken, deps, copyMaxBytes: COPY_MAX_BYTES,
    };
  }

  async function create(p = {}) {
    const name = String(p.name || '').trim();
    if (!name) throw wtErr('Give the worktree a name first.', 'bad_params');
    if (!NAME_RE.test(name) || /\.\.|\.lock$|\.$/.test(name)) {
      throw wtErr('Use letters, numbers, dots, dashes or underscores for the name (up to 48, starting with a letter or number).', 'bad_params');
    }
    const repo = await repoOf(p.cwd);
    const branch = BRANCH_PREFIX + name;
    const chk = await runGit(repo.root, ['check-ref-format', '--branch', branch]);
    if (!chk.ok) throw wtErr(`Git does not accept "${branch}" as a branch name. Pick another name.`, 'bad_params');
    let base = String(p.base || '').trim();
    if (!base) {
      const here = repo.list.find((w) => canon(w.path) === canon(repo.here));
      base = here && here.branch;
      if (!base) throw wtErr('This folder is not on a branch (detached HEAD), so there is no default base. Pick a base branch.', 'bad_params');
    }
    const baseSha = await revOf(repo.root, base);
    if (!baseSha) throw wtErr(`The base branch "${base}" was not found in ${repo.name}.`, 'not_found');
    const dest = path.join(repo.wtDir, name);
    if (fs.existsSync(dest)) throw wtErr(`A folder named "${name}" already exists in ${repo.wtDir}. Pick another name.`, 'exists');
    if (await branchExists(repo.root, branch)) throw wtErr(`The branch ${branch} already exists in ${repo.name}. Pick another name, or open its worktree from the Worktrees panel.`, 'exists');
    try { fs.mkdirSync(repo.wtDir, { recursive: true }); } catch (e) { throw wtErr(`Helm could not make the folder ${repo.wtDir} (${e.code || e.message}).`, 'io'); }
    // --no-track: the base is where it came from, not an upstream (the git chip would otherwise compare to it)
    await gitOrThrow(repo.root, ['worktree', 'add', '--no-track', '-b', branch, dest, baseSha], `Git could not create the worktree ${dest}`, { timeout: 5 * 60_000 });
    const cfg = await runGit(repo.root, ['config', `branch.${branch}.helmBase`, base]);
    if (!cfg.ok) log('worktrees: could not record the base:', firstLine(cfg.err));
    log(`worktrees: created ${dest} on ${branch} from ${base} (${baseSha.slice(0, 7)})`);
    return { path: dest, branch, base, head: baseSha, repo: repo.root };
  }

  async function deps(p = {}) {
    const dest = requireDir(p.path, 'worktree');
    const repo = await repoOf(dest);
    const w = findTree(repo, dest);
    if (w === repo.list[0]) throw wtErr('This is the repo\'s main folder, not a worktree.', 'bad_params');
    const nm = path.join(dest, 'node_modules');
    if (lstatOrNull(nm)) throw wtErr('This worktree already has a node_modules folder, so Helm left it alone.', 'exists');
    const t0 = Date.now();
    if (p.mode === 'copy') {
      // the source: the folder named in `from` (a worktree of the same repo), else the main folder
      const fromDir = p.from ? requireDir(p.from, 'source folder') : repo.root;
      if (!repo.list.some((x) => canon(x.path) === canon(fromDir))) throw wtErr(`${fromDir} is not part of ${repo.name}, so Helm will not copy from it.`, 'bad_params');
      const src = path.join(fromDir, 'node_modules');
      const st = lstatOrNull(src);
      if (!st) throw wtErr(`There is no node_modules in ${fromDir} to copy. Use Install instead.`, 'not_found');
      if (isLink(st)) throw wtErr(`The node_modules in ${fromDir} is a link (junction), so Helm will not copy it. Use Install instead.`, 'refused');
      let skippedLinks = 0;
      if (WIN && copier !== 'node') {
        const r = await robocopy(src, nm);
        if (!r.ok) throw wtErr(`Copying node_modules failed (robocopy exit code ${r.code}). The worktree is there; use Install, or try again.`, 'copy_failed', { git: r.out });
      } else {
        try { skippedLinks = await nodeCopy(src, nm); } catch (e) { throw wtErr(`Copying node_modules failed (${e.code || e.message}). The worktree is there; use Install, or try again.`, 'copy_failed', { git: String(e.message) }); }
      }
      const after = lstatOrNull(nm);
      if (!after || isLink(after) || !after.isDirectory()) throw wtErr('After the copy, node_modules is not a real folder. Helm stopped; remove the worktree and use Install.', 'copy_failed');
      log(`worktrees: copied node_modules into ${dest} in ${Date.now() - t0} ms`);
      return { mode: 'copy', from: src, ms: Date.now() - t0, skippedLinks };
    }
    if (p.mode === 'install') {
      if (!fs.existsSync(path.join(dest, 'package.json'))) throw wtErr('There is no package.json in this worktree, so there is nothing to install.', 'not_found');
      const cmd = ['package-lock.json', 'npm-shrinkwrap.json'].some((f) => fs.existsSync(path.join(dest, f))) ? 'npm ci' : 'npm install';
      const r = await runInstall(dest, cmd, npm);
      if (!r.ok) {
        const why = r.code === 'ENOENT' ? 'npm was not found on the PATH' : `it stopped with exit code ${r.code}`;
        throw wtErr(`${cmd} failed in the worktree: ${why}. The worktree is there; its output is under Details.`, 'install_failed', { git: r.out });
      }
      log(`worktrees: ${cmd} in ${dest} took ${Date.now() - t0} ms`);
      return { mode: 'install', command: cmd, ms: Date.now() - t0 };
    }
    throw wtErr('Pick Copy or Install for the dependencies.', 'bad_params');
  }

  // Why Merge would be refused right now (null = it can go), plus what it would do. Shared by list and merge.
  async function mergePlan(repo, w, st, ctx = {}) {
    const plan = { base: null, kind: null, why: null, protectedWhy: null, restartsHelm: false, ahead: null, behind: null };
    if (w === repo.list[0]) { plan.why = 'This is the main folder.'; return plan; }
    if (!w.branch) { plan.why = 'This worktree is not on a branch (detached HEAD), so there is nothing to merge.'; return plan; }
    const base = await baseOf(repo, w, ctx.bases);
    plan.base = base;
    if (!base) { plan.why = 'Helm does not know which branch this came from, and the main folder is not on a branch.'; return plan; }
    if (base === w.branch) { plan.why = `This worktree is on ${base} itself.`; return plan; }
    if (!(await branchExists(repo.root, base))) { plan.why = `Its base "${base}" is not a local branch, so there is nothing to merge into. Merge it by hand.`; return plan; }
    if (!('guard' in ctx)) ctx.guard = await guardTarget(repo.root, guardDir());
    plan.protectedWhy = guardMessage(ctx.guard, base);
    plan.restartsHelm = await restartsHelm(repo, base);
    const ab = await aheadBehind(repo.root, base, w.branch);
    if (ab) { plan.ahead = ab.ahead; plan.behind = ab.behind; }
    if (plan.protectedWhy) { plan.why = plan.protectedWhy; return plan; }
    if (st && st.error) { plan.why = `Git could not read this worktree's changes (${st.error}), so Helm will not merge it.`; return plan; }
    if (st && st.dirty) { plan.why = `${w.branch} has ${plural(st.dirty, 'uncommitted change')}. Commit or discard them first, so the merge carries everything you see.`; return plan; }
    if (!ab) { plan.why = `Git could not compare ${w.branch} with ${base}.`; return plan; }
    if (ab.ahead === 0) { plan.why = `Nothing to merge: ${w.branch} has no commits that ${base} does not already have.`; return plan; }
    const ownUp = await upstreamGap(repo.root, w.branch);
    if (ownUp && ownUp.behind > 0) { plan.why = `${w.branch} is ${plural(ownUp.behind, 'commit')} behind ${ownUp.upstream} (as of the last fetch). Pull those into the worktree first.`; return plan; }
    const baseUp = await upstreamGap(repo.root, base);
    if (baseUp && baseUp.behind > 0) { plan.why = `${base} is ${plural(baseUp.behind, 'commit')} behind ${baseUp.upstream} (as of the last fetch). Pull ${base} first, then merge.`; return plan; }
    const at = repo.list.find((x) => x.branch === base && !x.prunable);
    if (at) {
      // one read of the base's folder per list call (most rows share the main folder's branch)
      const bst = await (ctx.baseStatus ||= new Map()).get(at.path) || await (async () => { const v = statusOf(at.path); ctx.baseStatus.set(at.path, v); return v; })();
      if (bst.error) { plan.why = `Git could not read ${base}'s folder ${at.path} (${bst.error}).`; return plan; }
      if (bst.dirty) { plan.why = `${base} is checked out in ${at.path}, which has ${plural(bst.dirty, 'uncommitted change')}. Helm will not merge on top of them.`; return plan; }
      if (await opInProgress(at.path)) { plan.why = `${at.path} is in the middle of a merge, rebase or cherry-pick. Finish or abort it first.`; return plan; }
    }
    plan.kind = ab.behind === 0 ? 'ff' : 'merge';
    if (plan.kind === 'merge') {
      const mt = await runGit(repo.root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, w.branch]);
      if (!mt.ok) {
        const files = mt.out.split(/\r?\n/).slice(1).filter(Boolean);
        plan.kind = null;
        plan.why = files.length
          ? `Merging would conflict in ${plural(files.length, 'file')} (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}). Merge ${base} into ${w.branch} in the worktree and resolve them there first.`
          : `Git could not work out the merge (${firstLine(mt.err) || 'no message'}).`;
        return plan;
      }
      plan.tree = mt.out.split(/\r?\n/)[0].trim();
    }
    plan.checkout = at ? at.path : null;
    return plan;
  }
  async function opInProgress(dir) {
    const g = await runGit(dir, ['rev-parse', '--git-dir']);
    if (!g.ok) return false;
    const gd = path.resolve(dir, g.out.trim());
    return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG'].some((f) => fs.existsSync(path.join(gd, f)));
  }

  async function list(p = {}) {
    const repo = await repoOf(p.cwd);
    const [bases, sessions] = await Promise.all([helmBases(repo.root), sessionsList()]);
    const using = sessionsByTree(repo.list, sessions);
    const ctx = { bases, guard: await guardTarget(repo.root, guardDir()) };
    const row1 = async (w, i) => {
      const exists = !w.prunable && fs.existsSync(w.path);
      const st = exists ? await statusOf(w.path) : null;
      const nmSt = exists ? lstatOrNull(path.join(w.path, 'node_modules')) : null;
      const row = {
        path: w.path, name: i === 0 ? repo.name : path.basename(w.path), main: i === 0,
        branch: w.branch, detached: w.detached, head: w.head ? w.head.slice(0, 7) : null,
        locked: w.locked, missing: !exists, prunable: w.prunable,
        dirty: st && !st.error ? st.dirty : null, statusError: st && st.error ? st.error : null,
        nodeModules: !nmSt ? 'none' : isLink(nmSt) ? 'link' : 'copy',
        lastCommit: exists ? await lastCommit(repo.root, w.branch || w.head || 'HEAD') : null,
        sessions: using.get(w.path) || [],
      };
      if (i > 0 && exists) {
        const plan = await mergePlan(repo, w, st, ctx);
        Object.assign(row, { base: plan.base, ahead: plan.ahead, behind: plan.behind,
          merge: { can: !plan.why, why: plan.why, kind: plan.kind, protected: !!plan.protectedWhy, restartsHelm: plan.restartsHelm } });
      }
      return row;
    };
    // six worktrees at a time: each is a handful of short git reads
    const rows = new Array(repo.list.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, repo.list.length) }, async () => {
      while (next < repo.list.length) { const i = next++; rows[i] = await row1(repo.list[i], i); }
    }));
    return { root: repo.root, name: repo.name, wtDir: repo.wtDir, mainBranch: repo.mainBranch, worktrees: rows };
  }

  async function merge(p = {}) {
    const dir = requireDir(p.path, 'worktree');
    const repo = await repoOf(dir);
    const w = findTree(repo, dir);
    if (w === repo.list[0]) throw wtErr("This is the repo's main folder; there is nothing to merge it into.", 'bad_params');
    const st = await statusOf(w.path);
    const plan = await mergePlan(repo, w, st);
    if (plan.why) throw wtErr(plan.why, plan.protectedWhy ? 'protected' : 'refused');
    if (plan.restartsHelm && p.confirmRestart !== true) throw wtErr(RESTART_WARNING, 'confirm_restart', { base: plan.base });
    const base = plan.base, branch = w.branch;
    const oldBase = await revOf(repo.root, base);
    const env = await identityEnv(repo.root, branch);
    const tip = await revOf(repo.root, branch);
    let head;
    if (plan.checkout) {
      // the base is checked out (usually the main folder): a normal merge there keeps its files in step.
      // --ff overrides a merge.ff=only / false config; git merge has no force.
      const r = await runGit(plan.checkout, ['merge', '--ff', '--no-edit', '-m', `Merge branch '${branch}'`, branch], { timeout: 5 * 60_000, env });
      if (!r.ok) {
        const midway = await opInProgress(plan.checkout);
        if (midway) await runGit(plan.checkout, ['merge', '--abort']);
        const ident = /tell me who you are|empty ident|user\.email/i.test(r.err);
        throw wtErr(ident ? 'Git does not know your name and email, so it cannot make the merge commit. Set user.name and user.email in git, then try again.'
          : `Git could not merge ${branch} into ${base}${midway ? ' and Helm undid the half-done merge' : ''}. Git said: ${firstLine(r.err) || firstLine(r.out) || 'no message'}`, 'git_failed', { git: tail(`${r.out}\n${r.err}`) });
      }
      head = await revOf(repo.root, base);
    } else if (plan.kind === 'ff') {
      // not checked out anywhere: move the ref, only if it is still where we read it (no force)
      await gitOrThrow(repo.root, ['update-ref', '-m', `helm: fast-forward ${base} to ${branch}`, `refs/heads/${base}`, tip, oldBase], `Git could not move ${base}`);
      head = tip;
    } else {
      const ct = await runGit(repo.root, ['commit-tree', plan.tree, '-p', oldBase, '-p', tip, '-m', `Merge branch '${branch}'`], { env });
      if (!ct.ok) {
        const ident = /tell me who you are|empty ident|user\.email/i.test(ct.err);
        throw wtErr(ident ? 'Git does not know your name and email, so it cannot make the merge commit. Set user.name and user.email in git, then try again.'
          : `Git could not make the merge commit. Git said: ${firstLine(ct.err)}`, 'git_failed', { git: tail(ct.err) });
      }
      head = ct.out.trim();
      await gitOrThrow(repo.root, ['update-ref', '-m', `helm: merge ${branch} into ${base}`, `refs/heads/${base}`, head, oldBase], `Git could not move ${base}`);
    }
    const kind = head === tip ? 'ff' : 'merge';
    log(`worktrees: merged ${branch} into ${base} (${kind}) -> ${String(head).slice(0, 7)}`);
    return { base, branch, kind, head: String(head).slice(0, 7), restartsHelm: plan.restartsHelm };
  }

  async function remove(p = {}) {
    const dir = path.resolve(String(p.path || ''));
    if (!p.path) throw wtErr('Choose a worktree first.', 'bad_params');
    const repo = await repoOf(fs.existsSync(dir) ? dir : (p.cwd || dir));
    const w = findTree(repo, dir);
    if (w === repo.list[0]) throw wtErr("This is the repo's main folder, not a worktree. Helm never removes it.", 'refused');
    if (w.locked) throw wtErr(`This worktree is locked (${w.locked}). Unlock it with git worktree unlock first.`, 'refused');
    const open = sessionsByTree(repo.list, await sessionsList()).get(w.path).filter((s) => s.status !== 'closed');
    if (open.length) {
      throw wtErr(`${open.length === 1 ? `The session "${open[0].title}" is` : `${open.length} sessions are`} still open in this worktree. Close ${open.length === 1 ? 'it' : 'them'} first: Windows will not delete a folder a program is working in.`, 'in_use');
    }
    const exists = fs.existsSync(w.path);
    let st = null;
    if (exists) {
      st = await statusOf(w.path);
      if (st.error && p.discard !== true) throw wtErr(`Git could not read this worktree's changes (${st.error}). Tick "Discard changes" to remove it anyway.`, 'refused');
      if (st.dirty && p.discard !== true) throw wtErr(`${w.branch || 'This worktree'} has ${plural(st.dirty, 'uncommitted change')}. Tick "Discard changes" to remove it anyway; they will be lost.`, 'dirty');
    }
    // junction safety: every link out first, each target checked, before git deletes anything
    const linksRemoved = [];
    if (exists) {
      const found = await findLinks(w.path);
      if (found.tooMany) throw wtErr(`This worktree has more than ${WALK_MAX.toLocaleString('en-US')} files, too many for Helm to check for links safely. Remove it by hand.`, 'refused');
      for (const l of found.links) linksRemoved.push(await unlinkOnly(l));
    }
    const force = p.discard === true || !exists;
    await gitOrThrow(repo.root, ['worktree', 'remove', ...(force ? ['--force'] : []), w.path], `Git could not remove the worktree ${w.path}`, { timeout: 5 * 60_000 });
    if (fs.existsSync(w.path)) throw wtErr(`Git said the worktree was removed, but the folder ${w.path} is still there. Something may be using it.`, 'io');
    if (!fs.existsSync(repo.root)) throw wtErr(`The main folder ${repo.root} is missing after the remove. Stop and check it.`, 'io');
    for (const l of linksRemoved) if (l.target && !fs.existsSync(l.target)) throw wtErr(`The folder ${l.target} that a link pointed to is missing after the remove. Stop and check it.`, 'io');
    let branchDeleted = false, branchKept = null;
    if (p.deleteBranch === true && w.branch) {
      const r = await runGit(repo.root, ['branch', '-d', w.branch]);
      if (r.ok) branchDeleted = true;   // git also drops the branch's config section (helmBase)
      else branchKept = /not fully merged/i.test(r.err) ? `${w.branch} has commits that are not merged, so Helm kept it.` : `Git kept ${w.branch}: ${firstLine(r.err)}`;
    }
    log(`worktrees: removed ${w.path}${linksRemoved.length ? ` (took out ${linksRemoved.length} link(s) first)` : ''}${branchDeleted ? `, deleted ${w.branch}` : ''}`);
    return { removed: w.path, branch: w.branch, linksRemoved: linksRemoved.map((l) => l.link), branchDeleted, branchKept };
  }

  const methods = {
    'worktrees.info': info,
    'worktrees.create': create,
    'worktrees.deps': deps,
    'worktrees.list': list,
    'worktrees.merge': merge,
    'worktrees.remove': remove,
  };
  return { methods, info, create, deps, list, merge, remove };
}

module.exports = { createWorktrees, parseWorktreeList, depsInfo, findLinks, guardMessage, RESTART_WARNING, COPY_MAX_BYTES, BRANCH_PREFIX };
