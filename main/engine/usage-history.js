'use strict';
// Usage history: a small rolling log of 5-hour / week percent samples and per-turn costs, kept in
// <userData>/usage-history.jsonl and bounded to `retentionDays`. One JSON object per line:
//   {k:'s', ts, fiveHour, week, fiveHourResetsAt?, weekResetsAt?}   a usage sample
//   {k:'c', ts, usd, sessionId, project, v:2}                        a cost increment
//   {k:'m', ts, cost:2}                                              cost counting (v2) starts here
// Cost records without v:2 were written before 2026-10-14 by a Helm bug that re-added a conversation's
// whole lifetime cost on every resume (a day showed $4,219). They are never summed: days before the 'm'
// marker report usd null (unknown) and the marker's own day reports partial + since.
// Everything time-based goes through `now()` so tests can drive a fake clock. I/O errors are
// logged, never thrown out of sample() / addCost(); a corrupt or partial line is skipped.
const fs = require('fs');
const path = require('path');

const DAY = 24 * 3600_000;
const HOUR = 3600_000;
const MAX_DAYS = 14;
// Two resetsAt readings within this many ms are "the same reset" (status-line values can jitter).
const RESET_TOLERANCE = 60_000;
const COST_V = 2;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const pct = (w) => (w && isNum(w.percent) ? w.percent : null);
const resetOf = (w) => (w && isNum(w.resetsAt) ? w.resetsAt : null);
const sameReset = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < RESET_TOLERANCE);

// Local calendar date of a timestamp as YYYY-MM-DD.
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function validRecord(r) {
  if (!r || typeof r !== 'object' || !isNum(r.ts)) return false;
  if (r.k === 's') return (r.fiveHour === null || isNum(r.fiveHour)) && (r.week === null || isNum(r.week)) && (r.fiveHour != null || r.week != null);
  if (r.k === 'c') return isNum(r.usd) && r.usd > 0;
  if (r.k === 'm') return r.cost === COST_V;
  return false;
}

class UsageHistory {
  constructor({ file, now = () => Date.now(), log = () => {}, retentionDays = MAX_DAYS, sampleEveryMs = 5 * 60 * 1000 } = {}) {
    if (!file) throw new Error('UsageHistory needs a file');
    this.file = file;
    this.now = now;
    this.log = log;
    this.retentionMs = Math.max(1, retentionDays) * DAY;
    this.sampleEveryMs = sampleEveryMs;
    this.records = []; // ascending ts (append order; tolerates small clock skew)
    this.lastSample = null;
    this.costSince = null;
    this.lastPruneAt = 0;
    this.timer = null;
    this._load();
  }

  _load() {
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') this.log('error', `usage history: read failed: ${e.message}`);
      this.lastPruneAt = this.now();
      return;
    }
    let bad = 0;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let r;
      try { r = JSON.parse(t); } catch { bad++; continue; }
      if (!validRecord(r)) { bad++; continue; }
      this.records.push(r);
    }
    this.records.sort((a, b) => a.ts - b.ts);
    if (bad) this.log('warn', `usage history: skipped ${bad} unreadable line(s)`);
    const pruned = this._pruneMemory();
    this.lastSample = this._findLastSample();
    this.lastPruneAt = this.now();
    if (pruned || bad) this._rewrite();
    this._ensureCostMarker();
  }

  // Where trustworthy (v2) cost counting begins: the 'm' record, written once. A file with no legacy cost
  // records left needs none (null = every kept day is complete).
  _ensureCostMarker() {
    const m = this.records.find((r) => r.k === 'm');
    if (m) { this.costSince = m.ts; return; }
    const legacy = this.records.some((r) => r.k === 'c' && r.v !== COST_V);
    const any = this.records.length > 0;
    if (!legacy && any) { this.costSince = null; return; }
    // A brand-new file, or one holding only legacy costs: v2 counting starts now.
    this.costSince = this.now();
    this._append({ k: 'm', ts: this.costSince, cost: COST_V });
  }

  _costRecords() {
    return this.records.filter((r) => r.k === 'c' && r.v === COST_V);
  }

  // Today's cost in Helm (local calendar day): { usd, since } where since is when counting began if that was
  // after local midnight (Helm's first run or the 2026-10-14 fix), else null.
  costToday() {
    const t = this.now();
    const key = dayKey(t);
    let usd = 0;
    for (const r of this._costRecords()) if (r.ts <= t && dayKey(r.ts) === key) usd = round6(usd + r.usd);
    const since = this.costSince != null && dayKey(this.costSince) === key ? this.costSince : null;
    return { usd, since };
  }

  _findLastSample() {
    for (let i = this.records.length - 1; i >= 0; i--) if (this.records[i].k === 's') return this.records[i];
    return null;
  }

  // Drop records older than the retention window. Returns how many were dropped.
  _pruneMemory() {
    const cutoff = this.now() - this.retentionMs;
    const before = this.records.length;
    if (before && this.records[0].ts >= cutoff) return 0;
    this.records = this.records.filter((r) => r.ts >= cutoff);
    return before - this.records.length;
  }

  // Atomic rewrite of the whole file from memory: write tmp, fsync, rename.
  _rewrite() {
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const body = this.records.map((r) => JSON.stringify(r)).join('\n') + (this.records.length ? '\n' : '');
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, body);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.renameSync(tmp, this.file);
      } catch {
        // Windows: rename over a file another process holds open can fail; fall back to copy.
        fs.copyFileSync(tmp, this.file);
        try { fs.unlinkSync(tmp); } catch {}
      }
    } catch (e) {
      this.log('error', `usage history: rewrite failed: ${e.message}`);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  _append(rec) {
    this.records.push(rec);
    const t = this.now();
    if (t - this.lastPruneAt >= HOUR) {
      this.lastPruneAt = t;
      if (this._pruneMemory()) { this._rewrite(); return; }
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
    } catch (e) {
      this.log('error', `usage history: append failed: ${e.message}`);
    }
  }

  // Record a usage reading (UsageTracker.get() shape). Returns the stored sample, or null when skipped.
  sample(usage) {
    try {
      const fiveHour = pct(usage?.fiveHour);
      const week = pct(usage?.week);
      if (fiveHour == null && week == null) return null;
      // A reading nothing has refreshed for a while (usage.stale) is not a sample of "now".
      if (usage && usage.stale === true) return null;
      const fiveHourResetsAt = fiveHour == null ? null : resetOf(usage.fiveHour);
      const weekResetsAt = week == null ? null : resetOf(usage.week);
      const ts = this.now();
      const last = this.lastSample;
      if (last && last.fiveHour === fiveHour && last.week === week
        && sameReset(last.fiveHourResetsAt ?? null, fiveHourResetsAt)
        && sameReset(last.weekResetsAt ?? null, weekResetsAt)
        && ts - last.ts < this.sampleEveryMs) return null;
      const rec = { k: 's', ts, fiveHour, week };
      if (fiveHourResetsAt != null) rec.fiveHourResetsAt = fiveHourResetsAt;
      if (weekResetsAt != null) rec.weekResetsAt = weekResetsAt;
      this.lastSample = rec;
      this._append(rec);
      return rec;
    } catch (e) {
      this.log('error', `usage history: sample failed: ${e.message}`);
      return null;
    }
  }

  // Record a cost increment for a session. Ignores non-positive / non-finite amounts.
  addCost({ usd, sessionId, project, ts } = {}) {
    try {
      if (!isNum(usd) || usd <= 0) return null;
      const rec = { k: 'c', ts: isNum(ts) ? ts : this.now(), usd: round6(usd), sessionId: sessionId || null, project: project || null, v: COST_V };
      if (rec.usd <= 0) return null;
      this._append(rec);
      return rec;
    } catch (e) {
      this.log('error', `usage history: addCost failed: ${e.message}`);
      return null;
    }
  }

  history({ days = 1 } = {}) {
    let n = Math.floor(Number(days));
    if (!Number.isFinite(n)) n = 1;
    n = Math.min(MAX_DAYS, Math.max(1, n));
    const t = this.now();
    const cutoff = t - n * DAY;

    const samples = [];
    for (const r of this.records) {
      if (r.k !== 's' || r.ts < cutoff || r.ts > t) continue;
      const s = { ts: r.ts, fiveHour: r.fiveHour ?? null, week: r.week ?? null };
      if (isNum(r.fiveHourResetsAt)) s.fiveHourResetsAt = r.fiveHourResetsAt;
      if (isNum(r.weekResetsAt)) s.weekResetsAt = r.weekResetsAt;
      samples.push(s);
    }
    samples.sort((a, b) => a.ts - b.ts);

    // One entry per local calendar day, today and the n-1 before it, oldest first.
    const keys = [];
    const d = new Date(t);
    d.setHours(12, 0, 0, 0); // noon steps day-by-day safely across DST changes
    for (let i = 0; i < n; i++) { keys.unshift(dayKey(d.getTime())); d.setDate(d.getDate() - 1); }
    const byKey = new Map(keys.map((k) => [k, { day: k, usd: 0, byProject: {} }]));
    const sinceKey = this.costSince != null ? dayKey(this.costSince) : null;
    for (const e of byKey.values()) {
      if (sinceKey == null || e.day > sinceKey) continue;
      if (e.day < sinceKey) { e.usd = null; e.unknown = true; } // before counting began: unknown, never $0
      else { e.partial = true; e.since = this.costSince; }
    }
    for (const r of this._costRecords()) {
      if (r.ts > t) continue;
      const e = byKey.get(dayKey(r.ts));
      if (!e || e.unknown) continue;
      const p = r.project || 'Other';
      e.usd = round6(e.usd + r.usd);
      e.byProject[p] = round6((e.byProject[p] || 0) + r.usd);
    }
    return { samples, costByDay: keys.map((k) => byKey.get(k)), costSince: this.costSince };
  }

  start(getUsage) {
    this.stop();
    const tick = () => {
      try { this.sample(getUsage()); } catch (e) { this.log('error', `usage history: tick failed: ${e.message}`); }
    };
    tick();
    this.timer = setInterval(tick, this.sampleEveryMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { UsageHistory, dayKey };
