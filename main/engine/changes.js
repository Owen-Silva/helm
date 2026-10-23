'use strict';
// files.changes: files a session changed, from its successful Edit / Write / MultiEdit /
// NotebookEdit tool items. +/- come from the tool inputs (line diff); when the session cwd is a
// git repo, `git diff --numstat HEAD` and `git status` replace them for files inside it
// (those numbers are the file vs HEAD, so they include edits made outside this session).

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

let diffLib = null;
try {
  diffLib = require('diff');
} catch {}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function lineCount(s) {
  if (!s) return 0;
  const n = String(s).split('\n').length;
  return String(s).endsWith('\n') ? n - 1 : n;
}

function countDiff(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (diffLib && a.length + b.length < 2_000_000) {
    let add = 0;
    let del = 0;
    for (const part of diffLib.diffLines(a, b)) {
      if (part.added) add += part.count || lineCount(part.value);
      else if (part.removed) del += part.count || lineCount(part.value);
    }
    return { add, del };
  }
  return { add: lineCount(b), del: lineCount(a) };
}

function git(cwd, args, timeout = 5000) {
  return new Promise((resolve) => {
    // --no-optional-locks: a read-only look must never rewrite .git/index (and race a `git commit`
    // Claude runs in the same repo: "index.lock: File exists"). core.fsmonitor=false: a repo's own
    // .git/config must not get to run a command just because Helm looked at it.
    execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

function keyOf(p) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

// The real (canonical) form of a path: junctions, symlinks, subst drives and 8.3 short names
// (C:\Users\RUNNER~1) resolved, the way `git rev-parse --show-toplevel` reports the repo root. A path
// that no longer exists (a deleted file) keeps its missing tail under its nearest real ancestor.
// Without this a session whose cwd is reached through a junction or short name never matched the
// git root, and every file silently fell back to the per-tool estimates.
function realOf(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

async function computeChanges(items, cwd) {
  const files = new Map(); // key → entry
  for (const it of items) {
    if (it.type !== 'tool' || !EDIT_TOOLS.has(it.name) || it.status !== 'done') continue;
    const input = it.input || {};
    const p = input.file_path || input.notebook_path;
    if (!p) continue;
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd || '.', p);
    const k = keyOf(abs);
    let e = files.get(k);
    if (!e) {
      e = { path: abs, rel: cwd ? path.relative(cwd, abs) || path.basename(abs) : abs, status: 'M', additions: 0, deletions: 0, touchedBy: [] };
      files.set(k, e);
    }
    e.touchedBy.push(it.toolUseId);
    if (it.name === 'Edit') {
      const d = countDiff(input.old_string, input.new_string);
      e.additions += d.add;
      e.deletions += d.del;
    } else if (it.name === 'MultiEdit') {
      for (const ed of input.edits || []) {
        const d = countDiff(ed.old_string, ed.new_string);
        e.additions += d.add;
        e.deletions += d.del;
      }
    } else if (it.name === 'Write') {
      // Write replaces the whole file; without the old content we can only count the new lines.
      const created = typeof it.result === 'string' && /created successfully/i.test(it.result);
      if (created && e.touchedBy.length === 1) e.status = 'A';
      e.additions += lineCount(input.content);
    } else if (it.name === 'NotebookEdit') {
      e.additions += lineCount(input.new_source);
      if (input.edit_mode === 'delete') e.deletions += 1;
    }
  }
  if (!files.size) return [];
  for (const e of files.values()) {
    if (!fs.existsSync(e.path)) e.status = 'D';
  }

  // Git numbers for files inside the repo.
  const top = cwd ? await git(cwd, ['rev-parse', '--show-toplevel']) : null;
  if (top) {
    const root = realOf(top.trim());
    const rootKey = keyOf(root);
    const real = new Map([...files.values()].map((e) => [e, realOf(e.path)]));
    const inside = [...files.values()].filter((e) => keyOf(real.get(e)).startsWith(rootKey + path.sep.toLowerCase()) || keyOf(real.get(e)).startsWith(rootKey + '/'));
    if (inside.length) {
      const rels = inside.map((e) => path.relative(root, real.get(e)).split(path.sep).join('/'));
      const [numstat, status] = await Promise.all([
        git(root, ['-c', 'core.quotepath=off', 'diff-index', '--numstat', 'HEAD', '--', ...rels]), // plumbing: never refreshes (rewrites) the index
        git(root, ['-c', 'core.quotepath=off', 'status', '--porcelain=v1', '--untracked-files=all', '--', ...rels]),
      ]);
      const byRel = new Map(inside.map((e, i) => [rels[i].toLowerCase(), e]));
      if (numstat) {
        for (const line of numstat.split('\n')) {
          const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
          if (!m) continue;
          const e = byRel.get(m[3].toLowerCase());
          if (!e) continue;
          e.additions = m[1] === '-' ? e.additions : Number(m[1]);
          e.deletions = m[2] === '-' ? e.deletions : Number(m[2]);
          e.source = 'git';
        }
      }
      if (status) {
        for (const line of status.split('\n')) {
          if (line.length < 4) continue;
          const code = line.slice(0, 2);
          const rel = line.slice(3).replace(/^"|"$/g, '');
          const e = byRel.get(rel.toLowerCase());
          if (!e) continue;
          if (code === '??' || code.includes('A')) {
            e.status = 'A';
            if (code === '??') {
              try {
                e.additions = lineCount(fs.readFileSync(e.path, 'utf8'));
                e.deletions = 0;
                e.source = 'git';
              } catch {}
            }
          } else if (code.includes('D')) e.status = 'D';
          else e.status = 'M';
        }
      }
    }
  }
  return [...files.values()];
}

module.exports = { computeChanges, countDiff, EDIT_TOOLS };
