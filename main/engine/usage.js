'use strict';
// Plan usage (5-hour / 7-day windows). Sources, best first:
//   sdk        — rate_limit_event frames from a live session (unifiedWindows carries both windows)
//   statusline — newest <mission-control>/data/statusline/*.json written by the user's interactive
//                sessions' status line hook (rate_limits.five_hour / seven_day, resets_at in s)
// Unknown → nulls plus `reason`; never an invented number.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATUSLINE_DIR = process.env.HELM_STATUSLINE_DIR || path.join(os.homedir(), 'mission-control', 'data', 'statusline');
const STALE_MS = 6 * 60 * 60 * 1000;
// Every Claude Code turn (Helm's or a terminal's) refreshes the reading. Older than this, it is shown as
// "as of N ago" (stale: true): use on claude.ai or another device since then is not in it.
const AGED_MS = 30 * 60 * 1000;

function pct(x) {
  if (x == null || Number.isNaN(Number(x))) return null;
  return Math.round(Number(x) * 10) / 10;
}
function msFromEpoch(x) {
  if (x == null) return null;
  const n = Number(x);
  if (!n) return null;
  return n < 1e12 ? n * 1000 : n; // seconds → ms
}

class UsageTracker {
  constructor({ emit, statuslineDir = STATUSLINE_DIR, now = () => Date.now() } = {}) {
    this.emit = emit || (() => {});
    this.dir = statuslineDir;
    this.now = now;
    this.sdk = null; // { fiveHour, week, updatedAt }
    this.costTodayUsd = 0;
    this.costDay = new Date(this.now()).toDateString();
    this.startedAt = this.now();
    this.costLedger = null; // { costToday() -> { usd, since } } (usage-history.js): survives restarts
    this.last = null;
  }

  // Today's cost of Helm's sessions: from the persisted ledger when there is one, else this run's own sum
  // (then counting began when Helm started, said by costTodaySince).
  _costToday() {
    if (this.costLedger) {
      try {
        const c = this.costLedger.costToday();
        if (c && Number.isFinite(c.usd)) return { usd: c.usd, since: c.since ?? null };
      } catch {}
    }
    const day = new Date(this.now()).toDateString();
    if (day !== this.costDay) return { usd: 0, since: null };
    return { usd: this.costTodayUsd, since: new Date(this.startedAt).toDateString() === day ? this.startedAt : null };
  }

  // rate_limit_event.rate_limit_info from any live session.
  onRateLimit(info) {
    if (!info) return;
    const w = info.unifiedWindows || {};
    const prev = this.sdk || {};
    const fiveHour = w.five_hour
      ? { percent: pct(w.five_hour.utilization * 100), resetsAt: msFromEpoch(w.five_hour.resetsAt) }
      : info.rateLimitType === 'five_hour' && info.utilization != null
        ? { percent: pct(info.utilization * 100), resetsAt: msFromEpoch(info.resetsAt) }
        : prev.fiveHour || null;
    const week = w.seven_day
      ? { percent: pct(w.seven_day.utilization * 100), resetsAt: msFromEpoch(w.seven_day.resetsAt) }
      : info.rateLimitType === 'seven_day' && info.utilization != null
        ? { percent: pct(info.utilization * 100), resetsAt: msFromEpoch(info.resetsAt) }
        : prev.week || null;
    this.sdk = { fiveHour, week, status: info.status, updatedAt: this.now() };
    this.publish();
  }

  addCost(deltaUsd) {
    if (!(deltaUsd > 0)) return;
    const day = new Date(this.now()).toDateString();
    if (day !== this.costDay) {
      this.costDay = day;
      this.costTodayUsd = 0;
    }
    this.costTodayUsd = Math.round((this.costTodayUsd + deltaUsd) * 1e6) / 1e6;
    this.publish();
  }

  readStatusline() {
    let files;
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return { error: `no status line data at ${this.dir}` };
    }
    let best = null;
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(this.dir, f));
        if (!best || st.mtimeMs > best.mtimeMs) best = { f, mtimeMs: st.mtimeMs };
      } catch {}
    }
    if (!best) return { error: 'status line folder is empty' };
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.dir, best.f), 'utf8'));
      const rl = j.rate_limits;
      if (!rl) return { error: 'newest status line file has no rate_limits' };
      return {
        fiveHour: rl.five_hour ? { percent: pct(rl.five_hour.used_percentage), resetsAt: msFromEpoch(rl.five_hour.resets_at) } : null,
        week: rl.seven_day ? { percent: pct(rl.seven_day.used_percentage), resetsAt: msFromEpoch(rl.seven_day.resets_at) } : null,
        updatedAt: Date.parse(j.receivedAt) || best.mtimeMs,
      };
    } catch (e) {
      return { error: `could not read status line file: ${e.message}` };
    }
  }

  get() {
    const now = this.now();
    let src = null;
    let reason = null;
    const sl = this.readStatusline();
    const sdkFresh = this.sdk && now - this.sdk.updatedAt < STALE_MS ? this.sdk : null;
    const slFresh = !sl.error && now - sl.updatedAt < STALE_MS ? sl : null;
    // Prefer whichever is newer; both report the same account-wide windows.
    if (sdkFresh && (!slFresh || sdkFresh.updatedAt >= slFresh.updatedAt)) src = { ...sdkFresh, source: 'sdk' };
    else if (slFresh) src = { ...slFresh, source: 'statusline' };
    else if (!sl.error) {
      src = { ...sl, source: 'statusline' };
      reason = `status line data is ${Math.round((now - sl.updatedAt) / 3600000)}h old`;
    } else reason = `no live session has reported limits yet; ${sl.error}`;
    // A window whose reset time has passed is no longer known.
    const fresh = (w) => (w && w.resetsAt && w.resetsAt < now ? null : w);
    const fiveHour = src ? fresh(src.fiveHour) : null;
    const week = src ? fresh(src.week) : null;
    if (src && src.fiveHour && !fiveHour) reason = (reason ? reason + '; ' : '') + '5-hour window has reset since the last report';
    const cost = this._costToday();
    const updatedAt = src ? src.updatedAt : null;
    const ageMs = updatedAt != null ? Math.max(0, now - updatedAt) : null;
    const usage = {
      fiveHour: fiveHour || null,
      week: week || null,
      costTodayUsd: cost.usd,
      costTodayScope: 'helm', // only sessions Helm ran today
      costTodaySince: cost.since, // counting began after local midnight (Helm's first run, or a restart without the ledger)
      source: src ? src.source : null,
      updatedAt,
      ageMs,
      stale: ageMs != null && ageMs > AGED_MS,
      ...(reason ? { reason } : {}),
    };
    this.last = usage;
    return usage;
  }

  publish() {
    this.emit('usage.updated', this.get());
  }
}

module.exports = { UsageTracker, AGED_MS };
