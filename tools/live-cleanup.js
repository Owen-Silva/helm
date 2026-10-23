'use strict';
// Live tools run a real claude.exe in a throwaway temp cwd, and the CLI writes that session's transcript to
// ~/.claude/projects/<slug of the cwd>. Left behind, those folders show up in Helm History, Mission Control and
// volt search. dropLiveTranscripts removes them, plus the temp folder itself, the way tools/e2e.js does.
// It refuses any cwd that is not inside a `helm-*` folder directly under the OS temp dir, so it can never
// reach one of the user's real projects.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectsDir, slugFor } = require('../main/engine/transcript');

const lc = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// The `helm-*` folder directly under the temp dir that holds `cwd`, or null.
function tempRootOf(cwd) {
  const tmp = lc(path.resolve(os.tmpdir()));
  const abs = path.resolve(String(cwd || ''));
  const rel = path.relative(tmp, lc(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const top = rel.split(path.sep)[0];
  if (!/^helm-/.test(top)) return null;
  return path.join(path.resolve(os.tmpdir()), abs.slice(tmp.length + 1).split(path.sep)[0]);
}

// Remove the CLI's transcript folder for each throwaway cwd, then the temp root that holds them.
// Returns the folders it removed. KEEP (--keep) skips it all.
function dropLiveTranscripts(cwds, { keep = process.argv.includes('--keep') } = {}) {
  const removed = [];
  if (keep) return removed;
  const roots = new Set();
  for (const cwd of [].concat(cwds || [])) {
    const root = tempRootOf(cwd);
    if (!root) continue;
    roots.add(root);
    const dir = path.join(projectsDir(), slugFor(path.resolve(cwd)));
    if (fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(dir); } catch {}
    }
  }
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
  return removed;
}

module.exports = { dropLiveTranscripts, tempRootOf };
