// Mock railway.* for the ?mock=1 UI (screenshots, click-throughs). Never real data: made-up projects
// and ids. Pick a scenario with &railway=live|building|failed|error|auth|off|empty|readonly (default live).
// Redeploy walks the row through queued -> building -> deploying -> live; Restart answers at once.
// Owner: lane railway.
const T0 = Date.now();
const MIN = 60_000, H = 3_600_000;
const scenario = new URLSearchParams(location.search).get('railway') || 'live';

function svc(projectId, serviceId, name, status, since, extra = {}) {
  const tone = { live: 'ok', building: 'busy', deploying: 'busy', queued: 'busy', failed: 'bad', crashed: 'bad' }[status] || 'idle';
  const busy = tone === 'busy';
  return {
    key: `${serviceId}:env-prod`, serviceId, environmentId: 'env-prod', projectId, name, environment: 'production', prod: true,
    status, tone, raw: status.toUpperCase(), since: T0 - since, deploymentId: `dep-${serviceId}-1`, restartId: status === 'live' || status === 'crashed' ? `dep-${serviceId}-1` : null,
    olderLive: false, canRedeploy: !busy, canRestart: !busy && (status === 'live' || status === 'crashed'),
    redeployWhy: busy ? 'Wait for the current deploy to finish' : null,
    restartWhy: busy ? 'Wait for the current deploy to finish' : status === 'live' || status === 'crashed' ? null : 'Nothing running to restart',
    ...extra,
  };
}

function build() {
  const storeWeb = scenario === 'building' ? svc('p-storefront', 's-aweb', 'web', 'building', 80_000) : svc('p-storefront', 's-aweb', 'web', 'live', 2 * H + 5 * MIN);
  const bookingWeb = scenario === 'failed'
    ? { ...svc('p-booking', 's-tweb', 'portal', 'failed', 3 * MIN), olderLive: true, restartId: 'dep-s-tweb-0', canRestart: true, restartWhy: null }
    : svc('p-booking', 's-tweb', 'portal', 'live', 26 * H);
  const projects = [
    { id: 'p-storefront', name: 'storefront', services: [
      storeWeb,
      svc('p-storefront', 's-awork', 'worker', 'live', 4 * 24 * H),
      svc('p-storefront', 's-apg', 'Postgres', 'live', 46 * 24 * H),
      { ...svc('p-storefront', 's-aweb', 'web', 'sleeping', 3 * 24 * H), key: 's-aweb:env-stg', environmentId: 'env-stg', environment: 'staging', prod: false },
    ] },
    { id: 'p-booking', name: 'booking-portal', services: [bookingWeb, svc('p-booking', 's-tpg', 'Postgres', 'live', 61 * 24 * H)] },
  ];
  return projects;
}

const S = {
  mode: scenario === 'off' ? 'off' : 'ready',
  projects: scenario === 'auth' ? null : scenario === 'empty' ? [] : build(),
  fetchedAt: scenario === 'error' ? T0 - 12 * MIN : T0 - 8000,
  checkedAt: T0 - 8000,
  fetching: false,
  error: scenario === 'error'
    ? { kind: 'network', message: 'Could not reach Railway.', detail: 'error sending request for url (https://backboard.railway.com/graphql/v2)', at: T0 - 8000 }
    : scenario === 'auth' ? { kind: 'auth', message: 'Railway sign-in is missing or expired. Run "railway login" in a terminal, then try again.', detail: 'Not Authorized', at: T0 - 8000 } : null,
  warning: null,
  actions: [],
  canAct: scenario !== 'readonly' && scenario !== 'off',
  ...(scenario === 'readonly' ? { actReason: 'A test run reads Railway status only: Redeploy and Restart are off.' } : {}),
  ...(scenario === 'off' ? { offReason: 'A test run does not read Railway. Set HELM_RAILWAY_CLI to a fake CLI script, or HELM_RAILWAY_LIVE=1 for read-only status.' } : {}),
  poll: { intervalMs: 30_000, nextAt: null, watching: ['panel'] },
};
const snap = () => JSON.parse(JSON.stringify(S));
const find = (key) => { for (const p of S.projects || []) for (const s of p.services) if (s.key === key) return { s, p }; return null; };

export async function mockRailway(method, p = {}, { emit }) {
  const push = () => { try { emit('railway.changed', snap()); } catch {} };
  if (method === 'railway.status') {
    if (p.refresh) { S.checkedAt = Date.now(); if (scenario !== 'error' && scenario !== 'auth') S.fetchedAt = S.checkedAt; }
    return snap();
  }
  if (p.confirm !== true) throw Object.assign(new Error('Needs a confirm'), { code: 'confirm_required' });
  if (!S.canAct) throw Object.assign(new Error(S.actReason || 'Actions are off'), { code: 'unsupported' });
  const hit = find(`${p.serviceId}:${p.environmentId}`);
  if (!hit) throw Object.assign(new Error('That service is not in the latest Railway status. Refresh and try again.'), { code: 'not_found' });
  const kind = method === 'railway.restart' ? 'restart' : 'redeploy';
  const { s, p: proj } = hit;
  const a = { key: s.key, kind, state: 'running', serviceId: s.serviceId, environmentId: s.environmentId, project: proj.name, service: s.name, environment: s.environment, prod: s.prod, startedAt: Date.now(), message: kind === 'redeploy' ? 'Asking Railway to redeploy' : 'Asking Railway to restart' };
  S.actions = [...S.actions.filter((x) => x.key !== s.key), a];
  push();
  await new Promise((r) => setTimeout(r, 700));
  if (kind === 'restart') { Object.assign(a, { state: 'done', endedAt: Date.now(), result: 'sent', message: 'Restart sent' }); push(); return { ok: true, action: { ...a } }; }
  Object.assign(a, { state: 'sent', message: 'Redeploy started' });
  const setStatus = (status, tone) => { Object.assign(s, { status, tone, since: Date.now(), canRedeploy: tone !== 'busy', canRestart: tone !== 'busy', redeployWhy: tone === 'busy' ? 'Wait for the current deploy to finish' : null, restartWhy: tone === 'busy' ? 'Wait for the current deploy to finish' : null }); };
  setStatus('queued', 'busy'); s.deploymentId = `${s.deploymentId}-r`; s.olderLive = false;
  push();
  const steps = [[2500, 'building', 'busy', 'Redeploying: building'], [9000, 'deploying', 'busy', 'Redeploying: deploying'], [13000, 'live', 'ok', 'Redeployed: live']];
  for (const [ms, status, tone, msg] of steps) setTimeout(() => { setStatus(status, tone); a.message = msg; if (status === 'live') Object.assign(a, { state: 'done', endedAt: Date.now(), result: 'live' }); push(); }, ms);
  return { ok: true, action: { ...a } };
}
