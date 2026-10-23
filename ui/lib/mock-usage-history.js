// Mock data for `usage.history` in the browser mock mode (?mock=1). Same shape as the engine's
// UsageHistory.history(): { samples: [{ ts, fiveHour, week, fiveHourResetsAt?, weekResetsAt? }],
// costByDay: [{ day: 'YYYY-MM-DD', usd, byProject }] }. Deterministic for a given `now`.
// Lines up with mock-data.js `usage`: 5H 37% resetting in 2h14m, week 11% resetting in 4 days,
// and today's cost $41.20.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STEP = 5 * MIN;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const r1 = (n) => Math.round(n * 10) / 10;
const r6 = (n) => Math.round(n * 1e6) / 1e6;

export function mockUsageHistory({ days = 14, now = Date.now() } = {}) {
  let n = Math.floor(Number(days));
  if (!Number.isFinite(n)) n = 1;
  n = Math.min(14, Math.max(1, n));
  const rand = rng(20261008);
  const from = now - n * DAY;

  // 5-hour windows, newest first: { start, end, final } where `final` is the percent at the end.
  const curStart = now - 2 * HOUR - 46 * MIN; // resets in 2h14m, like mock-data's usage
  const curFrac = (now - curStart) / (5 * HOUR);
  const windows = [
    { start: curStart, end: curStart + 5 * HOUR, final: 37 / Math.pow(curFrac, 0.85) },
    { start: curStart - 5 * HOUR, end: curStart, final: 88 },
    { start: now - 19 * HOUR, end: now - 14 * HOUR, final: 64 },
    { start: now - 24 * HOUR, end: now - 19 * HOUR, final: 52 },
  ];
  // Older windows: back to back or after an idle stretch.
  let cursor = now - 24 * HOUR;
  while (cursor > from - 5 * HOUR) {
    const idle = rand() < 0.45 ? rand() * 3 * HOUR : 0;
    const end = cursor - idle;
    windows.push({ start: end - 5 * HOUR, end, final: 30 + rand() * 62 });
    cursor = end - 5 * HOUR;
  }
  windows.sort((a, b) => a.start - b.start);

  // Stretches when Helm was closed: one ~2 h gap in the last 24 h, and a few overnight closures.
  const closed = [[now - 7 * HOUR - 10 * MIN, now - 5 * HOUR - 10 * MIN]];
  for (let d = 2; d <= n; d += 2) closed.push([now - d * DAY - 4 * HOUR, now - d * DAY + 2 * HOUR]);
  const isClosed = (t) => closed.some(([a, b]) => t >= a && t < b);

  const weekReset = now + 4 * DAY; // like mock-data's usage
  const weekResetAt = (t) => { let r = weekReset; while (r - 7 * DAY > t) r -= 7 * DAY; return r; };

  // Walk forward in 5-minute steps; the week figure accrues from 5-hour use (scaled after).
  const raw = [];
  let week = 0, lastWeekReset = null, lastFh = 0, wi = 0;
  const t0 = Math.floor(from / STEP) * STEP + (now % STEP);
  for (let t = t0; t <= now; t += STEP) {
    while (wi < windows.length && windows[wi].end <= t) wi++;
    const w = windows[wi] && windows[wi].start <= t ? windows[wi] : null;
    let fh = 0;
    if (w) {
      const frac = (t - w.start) / (w.end - w.start);
      // A little plateau texture: usage arrives in bursts.
      const burst = Math.floor(frac * 20) / 20;
      fh = Math.min(100, w.final * Math.pow(Math.max(frac * 0.6 + burst * 0.4, 0), 0.85));
    }
    const wr = weekResetAt(t);
    if (lastWeekReset != null && wr !== lastWeekReset) week = 0;
    lastWeekReset = wr;
    if (fh > lastFh) week += fh - lastFh;
    lastFh = fh;
    raw.push({ t, fh, week, fhReset: w ? w.end : null, wr });
  }
  const lastRaw = raw[raw.length - 1];
  const k = lastRaw && lastRaw.week > 0 ? 11 / lastRaw.week : 0.02;

  const samples = [];
  for (const p of raw) {
    if (p.t < from || isClosed(p.t)) continue;
    const s = { ts: p.t, fiveHour: p.t === now ? 37 : r1(p.fh), week: p.t === now ? 11 : r1(p.week * k), weekResetsAt: p.wr };
    if (p.fhReset != null) s.fiveHourResetsAt = p.fhReset;
    samples.push(s);
  }

  // Cost per local day, oldest first, today last ($41.20 like mock-data's usage).
  const keys = [];
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  for (let i = 0; i < n; i++) { keys.unshift(dayKey(d.getTime())); d.setDate(d.getDate() - 1); }
  const crand = rng(1414);
  const costByDay = keys.map((day, i) => {
    const back = n - 1 - i; // 0 = today
    if (back === 0) return { day, usd: 41.2, byProject: { storefront: 18.45, helm: 15.05, 'booking-portal': 7.7 } };
    if (back === 3 || back === 9) return { day, usd: 0, byProject: {} };
    const byProject = {};
    const scale = 6 + crand() * 54;
    const store = crand() < 0.85 ? scale * (0.3 + crand() * 0.5) : 0;
    const helm = crand() < 0.8 ? scale * (0.2 + crand() * 0.5) : 0;
    const booking = crand() < 0.5 ? scale * crand() * 0.4 : 0;
    if (store) byProject.storefront = r6(store);
    if (helm) byProject.helm = r6(helm);
    if (booking) byProject['booking-portal'] = r6(booking);
    if (back === 5) byProject['mobile-app'] = 3.12;
    if (back === 5) byProject['api-server'] = 1.87;
    const usd = r6(Object.values(byProject).reduce((a, b) => a + b, 0));
    return { day, usd, byProject };
  });

  return { samples, costByDay };
}
