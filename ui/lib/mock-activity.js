// Mock for activity.summary (PROTOCOL "activity.*"): believable Active hours for ?mock=1.
// Deterministic per day (seeded), weekends lighter, today scaled to the hour. Preview the other
// states with &activity=empty | missing | error | slow | unknown | alltime-scanning (the all-time
// count still running: { scanning: { done, total } } that grows while the page is open).
// Owner: lane activity.

const HOUR = 3600_000;
const MIN = 60_000;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// [name, cwd, weight, agent ratio]
const PROJECTS = [
  ['helm', 'C:\\Users\\you\\helm', 0.28, 2.6],
  ['api-server', 'C:\\Users\\you\\code\\api-server', 0.2, 3.4],
  ['you', 'C:\\Users\\you', 0.16, 1.2],
  ['storefront', 'C:\\Users\\you\\code\\storefront', 0.13, 2.1],
  ['docs-site', 'C:\\Users\\you\\code\\docs-site', 0.09, 2.2],
  ['mobile-app', 'C:\\Users\\you\\code\\mobile-app', 0.07, 1.8],
  ['Temp folders', 'C:\\Users\\you\\AppData\\Local\\Temp', 0.04, 1.4],
  ['booking-portal', 'C:\\Users\\you\\code\\booking-portal', 0.03, 1.6],
];

const loadedAt = Date.now();

export async function mockActivitySummary({ days = 14, allTime = false } = {}, now = Date.now()) {
  const mode = new URLSearchParams(location.search).get('activity');
  if (allTime !== undefined && typeof allTime !== 'boolean') throw Object.assign(new Error('allTime must be true or false'), { code: 'bad_params' });
  if (!Number.isInteger(days) || days < 1 || days > 30) throw Object.assign(new Error('days must be a whole number from 1 to 30'), { code: 'bad_params' });
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 6000));
  if (mode === 'error') throw Object.assign(new Error('Could not read the Claude Code transcripts: EACCES: permission denied, scandir \'C:\\Users\\you\\.claude\\projects\''), { code: 'scan_failed' });
  if (mode === 'unknown') throw Object.assign(new Error('unknown method: activity.summary'), { code: 'unknown_method' });
  const dir = 'C:\\Users\\you\\.claude\\projects';
  const base = { scannedAt: now - 20_000, scanMs: 184, capMs: 10 * MIN, windowDays: 30, dir, live: { workingNow: 0 } };
  const zeroDays = () => Array.from({ length: days }, (_, k) => {
    const d = new Date(now); d.setDate(d.getDate() - (days - 1 - k));
    return { date: dayKey(d), activeMs: 0, agentMs: 0 };
  });
  const withAll = (r) => (allTime ? { ...r, allTime: mockAllTime(mode, r, now) } : r);
  if (mode === 'missing') return withAll({ ...base, days: zeroDays(), today: { activeMs: 0, agentMs: 0 }, week: { activeMs: 0, agentMs: 0 }, byProject: [], files: 0, filesRead: 0, missing: true });
  if (mode === 'empty') return withAll({ ...base, days: zeroDays(), today: { activeMs: 0, agentMs: 0 }, week: { activeMs: 0, agentMs: 0 }, byProject: [], files: 0, filesRead: 0 });

  const out = [];
  const proj = PROJECTS.map(([project, cwd]) => ({ project, cwd, activeMs: 0, agentMs: 0 }));
  const today = new Date(now);
  const dayFrac = (today.getHours() * 60 + today.getMinutes()) / (24 * 60);
  for (let k = days - 1; k >= 0; k--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - k, 12);
    const r = rng(d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate());
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    let active = (weekend ? 1.5 : 4) * HOUR + r() * (weekend ? 3 : 5.5) * HOUR;
    if (r() < 0.08) active *= 0.25; // the odd quiet day
    if (k === 0) active *= Math.min(1, 0.25 + dayFrac);
    let agent = 0;
    let share = 0;
    PROJECTS.forEach(([, , w, ratio], i) => {
      const s = w * (0.6 + r() * 0.8);
      share += s;
      proj[i]._s = s;
      proj[i]._ratio = ratio * (0.7 + r() * 0.6);
    });
    PROJECTS.forEach((_, i) => {
      const a = (active * proj[i]._s) / share * 1.12; // projects overlap a little, so their sum > the union
      const g = a * proj[i]._ratio;
      proj[i].activeMs += a;
      proj[i].agentMs += g;
      agent += g;
    });
    out.push({ date: dayKey(d), activeMs: Math.round(active), agentMs: Math.round(Math.max(active, agent)) });
  }
  const sum = (arr, key) => arr.reduce((t, x) => t + x[key], 0);
  const last7 = out.slice(-7);
  return withAll({
    ...base,
    days: out,
    today: { activeMs: out[out.length - 1].activeMs, agentMs: out[out.length - 1].agentMs },
    week: { activeMs: sum(last7, 'activeMs'), agentMs: sum(last7, 'agentMs') },
    byProject: proj.map(({ project, cwd, activeMs, agentMs }) => ({ project, cwd, activeMs: Math.round(activeMs), agentMs: Math.round(agentMs) }))
      .sort((a, b) => b.activeMs - a.activeMs),
    live: { workingNow: 2 },
    files: 1404,
    filesRead: 6,
  });
}

// All time: months from mid-July to now (the demo history starts 2026-07-16), heavier lately.
function mockAllTime(mode, r, now) {
  if (mode === 'alltime-scanning') {
    const total = 3502;
    const done = Math.min(total - 1, (r.files || 1404) + Math.floor((Date.now() - loadedAt) / 25));
    return { scanning: { done, total } };
  }
  if (mode === 'missing' || mode === 'empty') return { activeMs: 0, agentMs: 0, since: null, byMonth: [], byProject: [], files: 0, scannedAt: now - 20_000, scanMs: 260 };
  const cur = new Date(now);
  const start = new Date(cur.getFullYear(), cur.getMonth() - 3, 16);
  const byMonth = [];
  for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d <= cur; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const r2 = rng(d.getFullYear() * 13 + d.getMonth());
    const k = byMonth.length;
    const isCur = d.getFullYear() === cur.getFullYear() && d.getMonth() === cur.getMonth();
    let active = (k === 0 ? 22 : 120 + k * 40 + r2() * 30) * HOUR;
    if (isCur) active = Math.max(r.week.activeMs, active * Math.min(1, cur.getDate() / 30));
    byMonth.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, activeMs: Math.round(active), agentMs: Math.round(active * (2.4 + r2() * 0.8)) });
  }
  const activeMs = byMonth.reduce((t, m) => t + m.activeMs, 0);
  const agentMs = byMonth.reduce((t, m) => t + m.agentMs, 0);
  const U = 'C:\\Users\\you';
  const shares = [['you', U, 0.24, 2.1], ['storefront', `${U}\\code\\storefront`, 0.21, 2.9], ['helm', `${U}\\helm`, 0.14, 3.1],
    ['api-server', `${U}\\code\\api-server`, 0.13, 3.6], ['booking-portal', `${U}\\code\\booking-portal`, 0.11, 2.2], ['mobile-app', `${U}\\code\\mobile-app`, 0.06, 2.0],
    ['docs-site', `${U}\\code\\docs-site`, 0.05, 2.4], ['Temp folders', `${U}\\AppData\\Local\\Temp`, 0.04, 1.3], ['data-pipeline', `${U}\\code\\data-pipeline`, 0.03, 1.5]];
  const byProject = shares.map(([project, cwd, w, ratio]) => ({ project, cwd, activeMs: Math.round(activeMs * w * 1.1), agentMs: Math.round(activeMs * w * 1.1 * ratio) }));
  return { activeMs, agentMs, since: dayKey(start), byMonth, byProject, files: 3502, scannedAt: now - 20_000, scanMs: 312 };
}
