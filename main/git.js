// git.status (lane git-export): the session folder's branch, dirty count and ahead/behind for the
// header chip. READ-ONLY: every call goes through files.js's git() (--no-optional-locks, no fsmonitor),
// never fetches (ahead/behind is against the remote-tracking ref already on disk), never writes.
// Owner: lane host (B).
const fs = require('fs');
const { git, requirePath } = require('./files');

function err(message, code = 'bad_params') { return Object.assign(new Error(message), { code }); }

// Extra read-only guards on top of files.js GIT_SAFE: a repo's config could otherwise make `git log`
// run gpg (log.showSignature) or print with a pager/colour.
const LOG_SAFE = ['-c', 'log.showSignature=false', '-c', 'color.ui=false'];

/**
 * Parse `git status --porcelain=v2 --branch -z` output.
 * -> { branch, detached, oid, upstream, ahead, behind, dirty, staged, unstaged, untracked, conflicted }
 *   dirty = every changed path (staged, unstaged, conflicted AND untracked): the chip's "N changed".
 *   ahead/behind are null when there is no upstream, or the upstream ref is gone (`# branch.ab` absent).
 */
function parseStatusV2(out) {
  const r = { branch: null, detached: false, oid: null, upstream: null, ahead: null, behind: null, dirty: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  const parts = String(out || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [key, ...rest] = line.slice(2).split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') r.oid = val === '(initial)' ? null : val;
      else if (key === 'branch.head') { if (val === '(detached)') r.detached = true; else r.branch = val; }
      else if (key === 'branch.upstream') r.upstream = val;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) { r.ahead = Number(m[1]); r.behind = Number(m[2]); }
      }
      continue;
    }
    const kind = line[0];
    if (kind === '1' || kind === '2') {
      const xy = line.slice(2, 4);
      if (xy[0] !== '.') r.staged++;
      if (xy[1] !== '.') r.unstaged++;
      r.dirty++;
      if (kind === '2') i++; // rename/copy: the original path follows as its own NUL-terminated field
    } else if (kind === 'u') { r.conflicted++; r.dirty++; }
    else if (kind === '?') { r.untracked++; r.dirty++; }
  }
  if (r.detached && r.oid) r.branch = r.oid.slice(0, 7);
  return r;
}

const NOT_REPO = /not a git repository|dubious ownership|safe\.directory/i;

// One in-flight read per folder: two panes on the same repo, or a turn ending while the 30 s timer
// fires, share a single pair of git processes.
const inflight = new Map();

async function status(params = {}) {
  const cwd = requirePath(params && params.cwd, 'cwd');
  let st;
  try { st = await fs.promises.stat(cwd); } catch (e) { throw err(e.code === 'ENOENT' ? `no such folder: ${cwd}` : e.message, e.code === 'ENOENT' ? 'not_found' : 'io'); }
  if (!st.isDirectory()) throw err(`not a folder: ${cwd}`);
  if (inflight.has(cwd)) return inflight.get(cwd);
  const p = read(cwd).finally(() => inflight.delete(cwd));
  inflight.set(cwd, p);
  return p;
}

async function read(cwd) {
  let out;
  try {
    out = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=dirty'], { maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    if (e && e.code === 'ENOENT') throw err('git is not installed or not on PATH', 'git_unavailable');
    const msg = String((e && (e.stderr || e.message)) || '');
    if (NOT_REPO.test(msg)) return { isRepo: false };
    throw err(msg.split('\n').find(Boolean) || 'git status failed', 'git_failed');
  }
  const s = parseStatusV2(out);
  let lastCommit = null;
  if (s.oid) {
    try {
      const log = await git(cwd, [...LOG_SAFE, 'log', '-1', '--no-color', '--format=%s%x00%ct', 'HEAD']);
      const [subject, ct] = log.replace(/\r?\n$/, '').split('\0');
      lastCommit = { subject: subject || '', ts: Number(ct) * 1000 || null };
    } catch { lastCommit = null; }
  }
  return {
    isRepo: true,
    branch: s.branch,
    detached: s.detached,
    dirty: s.dirty,
    staged: s.staged,
    untracked: s.untracked,
    ahead: s.ahead,
    behind: s.behind,
    upstream: s.upstream,
    lastCommit,
  };
}

module.exports = { status, parseStatusV2 };
