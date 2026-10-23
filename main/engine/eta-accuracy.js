// lane eta-accuracy (2026-10-17): the eta mod's finished-task history for the Usage panel's Estimates section.
//
// The mod (~/.claude/mods/eta, hooks/core.ts historyRecord) appends one JSON line per finished plan to
// <etaDir>/history.jsonl: { v:1, id, session, project, startedAt, firstAt, finishedAt, first, estimates[],
// took, factor, range?, factorSrc, end, src }. Numbers and times only (no prompt text). `first` is the first
// estimate in minutes, `took` the minutes from it to the finish, `factor` the calibration ratio the band
// applied to it (null = shown as said), `range` the [lo, hi] minutes it showed as a range, if any.
//
// Read-only and async (fs.promises): never a synchronous read on the main thread. A missing file is
// "no history yet" (missing: true), not an error; an unreadable or oversized file rejects with the reason.
// Lines that do not parse as records are skipped and counted (`bad`), never silently.
'use strict';
const fsp = require('fs/promises');
const path = require('path');
const { defaultEtaDir } = require('./eta');

const MAX_BYTES = 16 * 1024 * 1024;
const num = (v) => typeof v === 'number' && Number.isFinite(v);

function historyFile(etaDir) {
  return path.join(etaDir || defaultEtaDir(), 'history.jsonl');
}

// One parsed line as the UI uses it, or null when it is not a record. Only known fields pass through.
function toRecord(o) {
  if (!o || typeof o !== 'object' || o.v !== 1) return null;
  if (!num(o.first) || !num(o.took) || !num(o.finishedAt) || !num(o.firstAt)) return null;
  const range = Array.isArray(o.range) && o.range.length === 2 && num(o.range[0]) && num(o.range[1]) ? [o.range[0], o.range[1]] : null;
  return {
    first: o.first,
    took: o.took,
    firstAt: o.firstAt,
    finishedAt: o.finishedAt,
    factor: num(o.factor) ? o.factor : null,
    range,
    end: o.end === 'idle' ? 'idle' : 'done',
    project: typeof o.project === 'string' ? o.project.slice(0, 80) : null,
    session: typeof o.session === 'string' ? o.session.slice(0, 16) : null,
    reEstimates: Array.isArray(o.estimates) ? Math.max(0, o.estimates.length - 1) : 0,
    factorSrc: o.factorSrc === 'replayed' ? 'replayed' : 'shown',
  };
}

function parseHistory(text) {
  const records = [];
  let bad = 0;
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o = null;
    try { o = JSON.parse(t); } catch { o = null; }
    const r = toRecord(o);
    if (r) records.push(r); else bad++;
  }
  records.sort((a, b) => a.finishedAt - b.finishedAt);
  return { records, bad };
}

// -> { file, missing, records, bad, size, mtimeMs }
async function readEtaHistory({ etaDir } = {}) {
  const file = historyFile(etaDir);
  let st;
  try {
    st = await fsp.stat(file);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { file, missing: true, records: [], bad: 0, size: 0, mtimeMs: null };
    throw Object.assign(new Error(`cannot read ${file}: ${e && e.message}`), { code: 'unreadable' });
  }
  if (!st.isFile()) throw Object.assign(new Error(`${file} is not a file`), { code: 'unreadable' });
  if (st.size > MAX_BYTES) throw Object.assign(new Error(`${file} is ${Math.round(st.size / 1048576)} MB, over the ${MAX_BYTES / 1048576} MB this view reads`), { code: 'too-large' });
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    throw Object.assign(new Error(`cannot read ${file}: ${e && e.message}`), { code: 'unreadable' });
  }
  const { records, bad } = parseHistory(text);
  return { file, missing: false, records, bad, size: st.size, mtimeMs: st.mtimeMs };
}

module.exports = { readEtaHistory, parseHistory, historyFile, toRecord };
