// Railway panel + Home chip: pure rules (no DOM, no signals), shared by ui/panels/railway.js and
// ui/shell/railway-chip.js and unit-tested in test/host/railway.test.js. The data is railway.status's
// answer (PROTOCOL "Railway"). Owner: lane railway.

const WORD = {
  live: 'live', building: 'building', deploying: 'deploying', queued: 'queued', failed: 'failed', crashed: 'crashed',
  sleeping: 'sleeping', stopped: 'stopped', removed: 'removed', skipped: 'skipped', none: 'no deploys', unknown: 'unknown',
};
const TONE = { live: 'ok', building: 'busy', deploying: 'busy', queued: 'busy', failed: 'bad', crashed: 'bad' };

export const statusWord = (s) => WORD[s] || String(s || 'unknown');
export const toneOf = (s) => TONE[s] || 'idle';
export const svcTone = (svc) => (svc && svc.tone) || toneOf(svc && svc.status);

// "45s", "1m 20s" (seconds) or "12m", "2h", "3h 05m" (under 10 h), "4d".
export function fmtFor(ms, { seconds = false } = {}) {
  if (ms == null || !isFinite(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d`;
  if (h > 0) return h < 10 && m % 60 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${h}h`;
  if (m > 0) return seconds ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${m}m`;
  return `${s}s`;
}

// "live · 2h", "building · 1m 20s", "failed · 3m"
export function stateLine(svc, now = Date.now()) {
  const word = statusWord(svc.status);
  if (!svc.since) return word;
  return `${word} · ${fmtFor(now - svc.since, { seconds: svcTone(svc) === 'busy' })}`;
}

export function allServices(v) {
  const out = [];
  for (const p of (v && v.projects) || []) for (const s of p.services || []) out.push({ ...s, project: p.name });
  return out;
}

// "3 live", "1 building · 2 live"
export function projectSummary(p) {
  const n = {};
  for (const s of p.services || []) n[s.status] = (n[s.status] || 0) + 1;
  const order = ['failed', 'crashed', 'building', 'deploying', 'queued', 'live', 'sleeping', 'stopped', 'removed', 'skipped', 'none', 'unknown'];
  const parts = order.filter((k) => n[k]).map((k) => `${n[k]} ${statusWord(k)}`);
  return parts.length ? parts.join(' · ') : 'no services';
}

// A finished action shows for 90 s; running ones always.
export function actionFor(v, key, now = Date.now()) {
  const a = ((v && v.actions) || []).find((x) => x.key === key);
  if (!a) return null;
  if (a.endedAt && now - a.endedAt > 90_000) return null;
  return a;
}
export const actionRunning = (a) => !!a && (a.state === 'running' || a.state === 'sent');

// Home chip: one quiet line. tone: ok | busy | bad | idle | error; hidden when Railway is off (test runs).
export function chipSummary(v, now = Date.now(), rpcErr = null) {
  if (rpcErr && !v) return { tone: 'error', text: 'Railway · unavailable', title: `Railway status is unavailable: ${rpcErr.message || rpcErr}` };
  if (!v) return { tone: 'idle', text: 'Railway · checking', title: 'Asking Railway for deploy status' };
  if (v.mode === 'off') return { hidden: true, tone: 'idle', text: 'Railway · off', title: v.offReason || 'Railway is off' };
  const err = v.error;
  const errLine = err ? `Last check failed: ${err.message}${err.detail ? ` (${err.detail})` : ''}` : '';
  if (!v.projects) {
    if (err) return { tone: 'error', text: err.kind === 'auth' ? 'Railway · signed out' : err.kind === 'missing' ? 'Railway · CLI missing' : 'Railway · check failed', title: errLine };
    return { tone: 'idle', text: 'Railway · checking', title: 'Asking Railway for deploy status' };
  }
  const svcs = allServices(v);
  const checked = v.checkedAt ? `Checked ${fmtFor(now - v.checkedAt)} ago.` : '';
  const stale = err && v.fetchedAt && now - v.fetchedAt > 10 * 60_000;
  const suffix = stale ? ' · stale' : '';
  if (!svcs.length) return { tone: 'idle', text: `Railway · no services${suffix}`, title: [checked, errLine].filter(Boolean).join(' ') };
  const notLive = svcs.filter((s) => s.status !== 'live');
  const detail = notLive.map((s) => `${s.project} / ${s.name}${s.prod ? '' : ` (${s.environment})`}: ${stateLine(s, now)}`).join('\n');
  const title = [detail, checked, errLine].filter(Boolean).join('\n');
  const pick = (list, tone) => {
    const projects = [...new Set(list.map((s) => s.project))];
    let word;
    if (tone === 'bad') word = list.every((s) => s.status === 'crashed') ? 'crashed' : 'failed';
    else word = list.some((s) => s.status === 'building' || s.status === 'queued') ? 'building' : 'deploying';
    const who = projects.length === 1 ? projects[0] : `${list.length}`;
    return { tone, text: `Railway · ${who} ${word}${suffix}`, title, project: projects.length === 1 ? projects[0] : null };
  };
  const bad = svcs.filter((s) => svcTone(s) === 'bad');
  if (bad.length) return pick(bad, 'bad');
  const busy = svcs.filter((s) => svcTone(s) === 'busy');
  if (busy.length) return pick(busy, 'busy');
  if (!notLive.length) return { tone: 'ok', text: `Railway · all live${suffix}`, title: title || checked };
  const live = svcs.length - notLive.length;
  return { tone: 'idle', text: `Railway · ${live} live · ${notLive.length} idle${suffix}`, title };
}

// The confirm dialog's words. kind: 'redeploy' | 'restart'
export function confirmCopy(kind, svc) {
  const redeploy = kind === 'redeploy';
  const envName = svc.environment || 'production';
  return {
    title: `${redeploy ? 'Redeploy' : 'Restart'} ${svc.name}?`,
    rows: [['Project', svc.project], ['Service', svc.name], ['Environment', envName]],
    prodLine: svc.prod ? `This ${redeploy ? 'redeploys' : 'restarts'} production.` : null,
    body: redeploy
      ? 'Railway builds the latest deployment again and swaps it in once it is healthy.'
      : 'Railway restarts the running deployment without rebuilding. It is briefly unavailable while it comes back.',
    button: redeploy ? 'Redeploy' : 'Restart',
  };
}

// The panel's top line: "2 projects · checked 12s ago"
export function metaLine(v, now = Date.now()) {
  if (!v) return 'Checking Railway…';
  if (v.mode === 'off') return 'Off in this run';
  const n = (v.projects || []).length;
  const head = v.projects ? `${n} ${n === 1 ? 'project' : 'projects'}` : 'Railway';
  if (v.fetching && !v.checkedAt) return 'Checking Railway…';
  const when = v.checkedAt ? `checked ${fmtFor(now - v.checkedAt)} ago` : 'not checked yet';
  return `${head} · ${v.fetching ? 'checking…' : when}`;
}
