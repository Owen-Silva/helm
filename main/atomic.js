// Small persistence helpers shared by settings.js and queue.js.
//  - writeFileAtomic: temp file + fsync + rename, so a crash or power cut leaves either the old
//    file or the new one (without the fsync NTFS can rename a temp whose data never hit disk,
//    leaving a zero-length settings.json). The rename is retried briefly on Windows sharing
//    errors (antivirus / indexer holding the target open).
//  - readJson: parse a JSON file; a file that exists but can't be parsed is moved aside to
//    <file>.bad-<timestamp> (the user's data survives for a manual fix) instead of being overwritten.
// Owner: lane host (B).
const fs = require('fs');

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    try { fs.fsyncSync(fd); } catch {}
  } finally { fs.closeSync(fd); }
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      const until = Date.now() + 25 * (i + 1);
      while (Date.now() < until) { /* brief sync backoff: the callers are synchronous */ }
    }
  }
}

/** -> { status: 'ok', value } | { status: 'missing' } | { status: 'corrupt', error, movedTo } */
function readJson(file, { now = Date.now } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { status: 'missing' };
    return { status: 'corrupt', error: e.message, movedTo: null };
  }
  try { return { status: 'ok', value: JSON.parse(text) }; } catch (e) {
    let movedTo = `${file}.bad-${now()}`;
    try { fs.renameSync(file, movedTo); } catch { movedTo = null; }
    return { status: 'corrupt', error: e.message, movedTo };
  }
}

module.exports = { writeFileAtomic, readJson };
