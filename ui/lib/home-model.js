// Home screen: pure rules (lane home, 2026-10-08). The user asked: "i want there to be like a home scren for helm and the
// blur goes away from the backround image when you are there when you press the helm logo in the very top left
// corner". Imports only pure modules, so node tests load it directly (test/host/home-model.test.js).
// ui/shell/home.js renders the model; ui/shell/state.js owns the navigation (goHome).
import { displayStatus, isAgentsOnly, agentsRunningOf, agentsLabel } from './session-status.js';
import { fmtAgo, etaShown } from './session-header.js';

const MIN = 60_000;
const num = (v) => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// "Good morning" 05:00-11:59, "Good afternoon" 12:00-16:59, "Good evening" 17:00-04:59 (local hour 0-23).
export function greetingFor(hour) {
  const h = Math.floor(Number(hour));
  if (!Number.isFinite(h)) return 'Hello';
  const k = ((h % 24) + 24) % 24;
  if (k >= 5 && k < 12) return 'Good morning';
  if (k >= 12 && k < 17) return 'Good afternoon';
  return 'Good evening';
}

// Minute-resolution duration for a card ("<1m", "4m", "1h 05m"). Home re-renders on the shared minute tick,
// so it never shows seconds that would sit still between ticks. '' without a duration.
export function fmtMinutes(ms) {
  const v = num(ms);
  if (v == null) return '';
  const m = Math.floor(Math.max(0, v) / MIN);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// The cards, in the user's order: open tabs first (tab-strip order), then the other active sessions in the
// sidebar's order. `tabIds` = tab strip ids; `all` = every session (to resolve tab ids: a tab may be a session
// that left the active list); `active` = the sidebar's active sessions in its order. Archived sessions only
// show when they are an open tab. -> [{ s, tab }]
export function homeCards(tabIds, all, active) {
  const byId = new Map((all || []).filter((s) => s && s.id).map((s) => [s.id, s]));
  const out = [];
  const seen = new Set();
  for (const id of tabIds || []) {
    const s = byId.get(id);
    if (!s || seen.has(id)) continue;
    seen.add(id); out.push({ s, tab: true });
  }
  for (const x of active || []) {
    const s = x && byId.get(x.id);
    if (!s || seen.has(s.id) || s.archived) continue;
    seen.add(s.id); out.push({ s, tab: false });
  }
  return out;
}

// The glance row's session counts (archived sessions do not count). Agents-only counts as working.
export function glanceCounts(list) {
  let working = 0, waiting = 0;
  for (const s of list || []) {
    if (!s || s.archived) continue;
    const st = displayStatus(s);
    if (st === 'working') working++;
    else if (st === 'waiting') waiting++;
  }
  return { working, waiting };
}

// A card's status line: { state (displayStatus: the dot), text (the lead), meta: [short pieces], needsYou }.
//   working      what it is doing ("Running npm test") · turn time · "2 agents" · "14m left" (eta mod, etaShown)
//   agents only  "2 agents running" · "14m left"
//   waiting      "Needs you" · what it waits on ("Waiting for permission")
//   error        the error text
//   idle/closed  "Idle" / "Stopped" · "active 25m ago"
export function cardStatus(s, now = Date.now()) {
  if (!s) return { state: 'idle', text: 'Idle', meta: [], needsYou: false };
  const state = displayStatus(s);
  const n = agentsRunningOf(s);
  const meta = [];
  const etaPiece = () => {
    if (!etaShown(s, now)) return;
    const left = num(s.eta.etaAt) - now;
    meta.push(left > 0 ? `${fmtMinutes(left)} left` : 'past its estimate');
  };
  let text;
  if (isAgentsOnly(s)) {
    text = agentsLabel(n);
    etaPiece();
  } else if (s.status === 'working') {
    text = s.activity || 'Working';
    const t = num(s.turnStartedAt);
    if (t && t > 0) meta.push(fmtMinutes(now - t));
    if (n > 0) meta.push(`${n} agent${n === 1 ? '' : 's'}`);
    etaPiece();
  } else if (s.status === 'waiting') {
    text = 'Needs you';
    if (s.activity) meta.push(s.activity);
  } else if (s.status === 'error') {
    text = s.activity || 'Stopped with an error';
  } else {
    text = s.status === 'closed' ? 'Stopped' : 'Idle';
    const at = num(s.updatedAt);
    if (at && at > 0) meta.push(`active ${fmtAgo(now - at)}`);
  }
  return { state, text, meta, needsYou: state === 'waiting' };
}

// "5H 34%" style percent for the glance chips; null when unknown.
export function pctText(p) {
  const v = num(p);
  if (v == null) return null;
  // Same rule as the Usage panel's fmtPct (lane accuracy): 99.6 is not "100%" (at the limit when it isn't) and
  // 0.4 is not a silent "0%".
  if (v > 0 && v < 1) return '<1%';
  if (v > 99 && v < 100) return '99%';
  return `${Math.round(Math.min(100, Math.max(0, v)))}%`;
}

// ---------- "Since you left" (lane recap, 2026-10-09) ----------
// Rows come from the engine (sessions.recap, main/engine/recap.js): one per session that did something since the user
// last had it on screen. The outcome follows the session's LIVE status when the app has it (a row that said "still
// working" flips to "Finished" without a refetch). -> { rows: [{ id, title, project, state (dot), outcome, lead,
// error, pieces: [...] }], more } with at most `max` rows; `more` = how many did not fit.
export const RECAP_MAX = 6;
const OUTCOME_TEXT = { done: 'Finished', failed: 'Failed', waiting: 'Waiting on you', working: 'Still working', stopped: 'Stopped' };
const OUTCOME_DOT = { done: 'ok', failed: 'error', waiting: 'waiting', working: 'working', stopped: 'idle' };

export function fmtCost(usd) {
  const v = num(usd);
  if (v == null || v <= 0) return '';
  if (v < 0.01) return '<$0.01';
  // Cents always (lane accuracy): $12.84 read "$13", a whole-dollar round-up of Claude Code's figure.
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function recapRow(r, live, clockOf = null) {
  let outcome = r.outcome || 'done';
  if (live) {
    const st = displayStatus(live);
    if (st === 'waiting') outcome = 'waiting';
    else if (st === 'working') outcome = 'working';
    else if (live.status === 'error') outcome = 'failed';
    else if (outcome === 'waiting' || outcome === 'working') outcome = 'done';   // it has since finished
  }
  const pieces = [];
  const commits = num(r.commits) || 0;
  if (commits > 0) pieces.push({ k: 'commits', text: plural(commits, 'commit'), detail: r.commitSubject || '' });
  const files = num(r.fileCount) || 0;
  if (files > 0) {
    const names = (r.files || []).slice(0, 3);
    const rest = files - names.length;
    pieces.push({ k: 'files', text: plural(files, 'file'), detail: names.join(', ') + (rest > 0 ? ` +${rest}` : '') });
  }
  const cost = fmtCost(r.costUsd);
  if (cost) pieces.push({ k: 'cost', text: cost });
  const from = num(r.from), to = num(r.to);
  if (from && to && to >= from) {
    const dur = fmtMinutes(to - from);
    const span = clockOf ? (to - from < MIN ? clockOf(to) : `${clockOf(from)}–${clockOf(to)}`) : '';
    pieces.push({ k: 'span', text: span || dur, detail: span && to - from >= MIN ? dur : '' });
  }
  const error = outcome === 'failed' ? (r.error || (live && live.activity) || '') : '';
  return {
    id: r.id, title: (live && live.title) || r.title || 'New session', project: (live && live.project) || r.project || '',
    outcome, state: OUTCOME_DOT[outcome] || 'idle', lead: OUTCOME_TEXT[outcome] || 'Finished', error, pieces,
  };
}

// rows: the engine's list; sessions: the app's session list (live status, archived). Archived and unknown-to-the-
// app sessions drop out; waiting and failed lead, then newest first (the engine's order).
export function recapView(rows, sessions, { max = RECAP_MAX, clockOf = null, showAll = false } = {}) {
  const byId = new Map((sessions || []).filter((s) => s && s.id).map((s) => [s.id, s]));
  const rank = { waiting: 0, failed: 1 };
  const out = (rows || [])
    .filter((r) => r && r.id && (!byId.size || (byId.has(r.id) && !byId.get(r.id).archived)))
    .map((r, i) => ({ ...recapRow(r, byId.get(r.id), clockOf), i }))
    .sort((a, b) => (rank[a.outcome] ?? 2) - (rank[b.outcome] ?? 2) || a.i - b.i)
    .map(({ i, ...r }) => r);
  const cap = showAll ? out.length : Math.max(0, max);
  return { rows: out.slice(0, cap), more: Math.max(0, out.length - cap), total: out.length };
}
