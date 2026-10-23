// Railway panel (lane railway): status mapping, normalising, the confirm-required action path against a
// fake CLI (injected transport AND a real spawned fake script), error redaction, polling back-off, and the
// UI's pure words (ui/lib/railway-model.js). Nothing here talks to Railway.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = require('../../main/railway.js');
const M = require('../../ui/lib/railway-model.js');

const U1 = '11111111-2222-4333-8444-555555555555';
const U2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';

// ---------- fixtures ----------
function dep(id, status, minsAgo = 5, extra = {}) {
  const t = new Date(Date.UTC(2026, 9, 8, 12, 0, 0) - minsAgo * 60_000).toISOString();
  return { id, status, createdAt: t, statusUpdatedAt: t, deploymentStopped: false, canRedeploy: true, ...extra };
}
function inst(serviceId, serviceName, latest, active = [], extra = {}) {
  return { serviceId, serviceName, deletedAt: null, latestDeployment: latest, activeDeployments: active, ...extra };
}
function project(id, name, envs, extra = {}) {
  return { id, name, deletedAt: null, environments: { edges: envs.map(([eid, ename, insts]) => ({ node: { id: eid, name: ename, serviceInstances: { edges: insts.map((n) => ({ node: n })) } } })) }, ...extra };
}
function statusData() {
  const storefront = project('p-storefront', 'Storefront', [
    ['e-prod', 'production', [
      inst('s-web', 'web', dep('d-web-2', 'SUCCESS'), [dep('d-web-2', 'SUCCESS')]),
      inst('s-bot', 'discord-bot', dep('d-bot-3', 'BUILDING', 1), [dep('d-bot-2', 'SUCCESS', 600)]),
    ]],
    ['e-stg', 'staging', [inst('s-web', 'web', dep('d-webs-1', 'SLEEPING', 900), [dep('d-webs-1', 'SLEEPING', 900)])]],
  ]);
  const tickets = project('p-tickets', 'Tickets', [
    ['e-tprod', 'production', [
      inst('s-portal', 'portal', dep('d-portal-9', 'FAILED', 3), [dep('d-portal-8', 'SUCCESS', 2000)]),
      inst('s-pg', 'Postgres', dep('d-pg-2', 'SKIPPED', 2), [dep('d-pg-1', 'SUCCESS', 9000)]),
      inst('s-gone', 'old', dep('d-old', 'SUCCESS'), [], { deletedAt: '2026-01-01T00:00:00Z' }),
    ]],
  ]);
  const deleted = project('p-del', 'Deleted', [], { deletedAt: '2026-01-01T00:00:00Z' });
  return { me: { workspaces: [{ projects: { edges: [{ node: storefront }, { node: deleted }] } }], projects: { edges: [{ node: tickets }, { node: storefront }] } } };
}

// Fake CLI transport: records every call; answers status / mutations from a script.
function fakeRun({ status = () => ({ data: statusData() }), redeploy = (id) => ({ data: { deploymentRedeploy: { id: `${id}-new`, status: 'INITIALIZING' } } }), restart = () => ({ data: { deploymentRestart: true } }) } = {}) {
  const calls = [];
  const run = async (args, input) => {
    calls.push({ args, input });
    const idArg = args[args.indexOf('--raw-var') + 1] || '';
    const id = idArg.startsWith('id=') ? idArg.slice(3) : null;
    let r;
    if (/deploymentRedeploy/.test(input)) r = redeploy(id);
    else if (/deploymentRestart/.test(input)) r = restart(id);
    else r = status();
    if (r && r.raw) return r.raw;
    return { code: 0, stdout: JSON.stringify(r), stderr: '' };
  };
  return { run, calls, mutations: () => calls.filter((c) => /mutation/.test(c.input)) };
}
const mk = (o = {}) => R.createRailway({ log: () => {}, timers: { setTimeout: () => ({ unref() {} }), clearTimeout() {} }, ...o });

// ---------- status mapping ----------
test('mapStatus: every Railway DeploymentStatus maps into the fixed set', () => {
  const want = {
    SUCCESS: 'live', BUILDING: 'building', DEPLOYING: 'deploying', INITIALIZING: 'queued', QUEUED: 'queued', WAITING: 'queued',
    NEEDS_APPROVAL: 'queued', FAILED: 'failed', CRASHED: 'crashed', SLEEPING: 'sleeping', REMOVED: 'removed', REMOVING: 'removed', SKIPPED: 'skipped',
  };
  for (const [raw, s] of Object.entries(want)) assert.equal(R.mapStatus(raw), s, raw);
  assert.equal(R.mapStatus('success'), 'live');
  assert.equal(R.mapStatus('SUCCESS', { stopped: true }), 'stopped');
  assert.equal(R.mapStatus(null), 'none');
  assert.equal(R.mapStatus('SOMETHING_NEW'), 'unknown');
  assert.deepEqual(['live', 'building', 'deploying', 'queued', 'failed', 'crashed', 'sleeping'].map(R.toneOf), ['ok', 'busy', 'busy', 'busy', 'bad', 'bad', 'idle']);
});

test('normalize: workspace + shared projects deduped, deleted skipped, prod flagged, skipped push falls back to the serving deploy', () => {
  const ps = R.normalize(statusData());
  assert.deepEqual(ps.map((p) => p.name), ['Storefront', 'Tickets']);
  const storefront = ps[0].services, tickets = ps[1].services;
  assert.deepEqual(storefront.map((s) => `${s.name}/${s.environment}/${s.status}/${s.prod}`), ['discord-bot/production/building/true', 'web/production/live/true', 'web/staging/sleeping/false']);
  assert.deepEqual(tickets.map((s) => `${s.name}/${s.status}`), ['portal/failed', 'Postgres/live']);   // deleted 'old' dropped; SKIPPED -> serving SUCCESS
  const portal = tickets[0];
  assert.equal(portal.tone, 'bad');
  assert.equal(portal.olderLive, true);
  assert.equal(portal.deploymentId, 'd-portal-9');        // redeploy target = the latest (failed) one
  assert.equal(portal.restartId, 'd-portal-8');           // restart target = the deployment still running
  const bot = storefront[0];
  assert.equal(bot.canRedeploy, false); assert.match(bot.redeployWhy, /finish/);
  assert.equal(bot.canRestart, false);
  assert.equal(storefront[1].key, 's-web:e-prod');
  assert.ok(Number.isFinite(storefront[1].since));
});

// ---------- actions ----------
test('redeploy/restart without confirm: refused, and the CLI is never called', async () => {
  const f = fakeRun();
  const r = mk({ run: f.run });
  for (const m of ['railway.redeploy', 'railway.restart']) {
    await assert.rejects(r.methods[m]({ serviceId: 's-web', environmentId: 'e-prod', deploymentId: 'd-web-2' }), (e) => e.code === 'confirm_required');
    await assert.rejects(r.methods[m]({ serviceId: 's-web', environmentId: 'e-prod', confirm: 'yes' }), (e) => e.code === 'confirm_required');
  }
  assert.equal(f.calls.length, 0);
  r.stop();
});

test('confirmed redeploy: refreshes, checks the deployment is still the latest, sends deploymentRedeploy(latest id) only', async () => {
  const f = fakeRun();
  const r = mk({ run: f.run });
  const res = await r.methods['railway.redeploy']({ serviceId: 's-web', environmentId: 'e-prod', deploymentId: 'd-web-2', confirm: true });
  assert.equal(res.ok, true);
  assert.equal(res.action.state, 'sent');
  const muts = f.mutations();
  assert.equal(muts.length, 1);
  assert.match(muts[0].input, /deploymentRedeploy\(id: \$id\)/);
  assert.deepEqual(muts[0].args.slice(0, 5), ['api', '-f', '-', '--compact', '--allow-errors']);
  assert.deepEqual(muts[0].args.slice(5), ['--raw-var', 'id=d-web-2']);
  // a second click while it runs is refused without another mutation
  await assert.rejects(r.methods['railway.redeploy']({ serviceId: 's-web', environmentId: 'e-prod', deploymentId: 'd-web-2', confirm: true }), (e) => e.code === 'busy');
  assert.equal(f.mutations().length, 1);
  r.stop();
});

test('confirmed restart targets the running deployment; a stale deploymentId or a busy service sends nothing', async () => {
  const f = fakeRun();
  const r = mk({ run: f.run });
  await assert.rejects(r.methods['railway.restart']({ serviceId: 's-portal', environmentId: 'e-tprod', deploymentId: 'd-portal-9', confirm: true }), (e) => e.code === 'stale');
  await assert.rejects(r.methods['railway.redeploy']({ serviceId: 's-bot', environmentId: 'e-prod', confirm: true }), (e) => e.code === 'unavailable');
  await assert.rejects(r.methods['railway.redeploy']({ serviceId: 's-nope', environmentId: 'e-prod', confirm: true }), (e) => e.code === 'not_found');
  await assert.rejects(r.methods['railway.redeploy']({ serviceId: 's-web; rm', environmentId: 'e-prod', confirm: true }), (e) => e.code === 'bad_params');
  assert.equal(f.mutations().length, 0);
  const res = await r.methods['railway.restart']({ serviceId: 's-portal', environmentId: 'e-tprod', deploymentId: 'd-portal-8', confirm: true });
  assert.equal(res.action.state, 'done');
  assert.equal(f.mutations().length, 1);
  assert.match(f.mutations()[0].input, /deploymentRestart\(id: \$id\)/);
  assert.deepEqual(f.mutations()[0].args.slice(5), ['--raw-var', 'id=d-portal-8']);
  r.stop();
});

test('a redeploy action settles to done once the new deployment is live', async () => {
  let phase = 0;
  const f = fakeRun({
    status: () => {
      const d = statusData();
      if (phase > 0) d.me.workspaces[0].projects.edges[0].node.environments.edges[0].node.serviceInstances.edges[0].node.latestDeployment = dep('d-web-2-new', phase === 1 ? 'BUILDING' : 'SUCCESS', 0);
      return { data: d };
    },
  });
  const r = mk({ run: f.run });
  await r.methods['railway.redeploy']({ serviceId: 's-web', environmentId: 'e-prod', deploymentId: 'd-web-2', confirm: true });
  phase = 1; await r.refresh();
  let a = r.state().actions.find((x) => x.key === 's-web:e-prod');
  assert.equal(a.state, 'sent'); assert.match(a.message, /building/);
  assert.equal(r.state().poll.intervalMs, null);   // no lease: nothing polls, even mid-deploy
  phase = 2; await r.refresh();
  a = r.state().actions.find((x) => x.key === 's-web:e-prod');
  assert.equal(a.state, 'done'); assert.equal(a.result, 'live');
  r.stop();
});

test('a --test run never touches real Railway: off by default, read-only with HELM_RAILWAY_LIVE=1', async () => {
  let spawned = 0;
  const spawn = () => { spawned++; throw new Error('should not spawn'); };
  const off = R.createRailway({ test: true, env: { PATH: '' }, spawn, log: () => {} });
  const v = await off.methods['railway.status']({ watch: 'panel' });
  assert.equal(v.mode, 'off'); assert.match(v.offReason, /test run/);
  await assert.rejects(off.methods['railway.redeploy']({ serviceId: 's-web', environmentId: 'e-prod', confirm: true }), (e) => e.code === 'unsupported');
  const ro = R.createRailway({ test: true, env: { PATH: '', HELM_RAILWAY_LIVE: '1' }, spawn, exists: () => false, log: () => {} });
  await assert.rejects(ro.methods['railway.restart']({ serviceId: 's-web', environmentId: 'e-prod', confirm: true }), (e) => e.code === 'unsupported');
  assert.equal(ro.state().canAct, false);
  // HELM_RAILWAY_CLI pointing at a real binary (not a .js fake) does not enable actions either
  const notFake = R.createRailway({ test: true, env: { PATH: '', HELM_RAILWAY_CLI: 'C:\\railway.exe' }, spawn, log: () => {} });
  assert.equal(notFake.state().mode, 'off');
  assert.equal(spawned, 0);
  off.stop(); ro.stop(); notFake.stop();
});

// ---------- redaction ----------
test('redact: tokens, JWTs, long secrets, UUIDs, emails and user paths never survive', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const s = R.redact(`Authorization: Bearer abc123secretvalue token=tok_live_998877 ${jwt} project ${U1} user someone@example.com at C:\\Users\\someone\\.railway\\config.json key ${'A'.repeat(40)}`, ['envsecret999']);
  for (const bad of ['abc123secretvalue', 'tok_live_998877', jwt, U1, 'someone@example.com', 'someone', 'A'.repeat(40)]) assert.ok(!s.includes(bad), `leaked ${bad}: ${s}`);
  assert.ok(!R.redact('x envsecret999 y', ['envsecret999']).includes('envsecret999'));
  assert.ok(R.redact('x'.repeat(1000)).length <= 300);
});

test('status and action errors carry no token, id or email (fake CLI prints them)', async () => {
  const secret = 'rw_api_token_value_1234567890';
  const leaky = `Error: request failed for token ${secret} Bearer ${secret} project ${U1} env ${U2} user someone@example.com path C:\\Users\\someone\\x`;
  const f = fakeRun({ status: () => ({ raw: { code: 1, stdout: '', stderr: leaky } }) });
  const r = mk({ run: f.run, env: { RAILWAY_API_TOKEN: secret, PATH: '' } });
  const v = await r.refresh();
  const errText = JSON.stringify(v.error);
  for (const bad of [secret, U1, U2, 'someone@example.com', 'someone']) assert.ok(!errText.includes(bad), `status error leaked ${bad}: ${errText}`);
  assert.equal(v.error.kind, 'other');
  r.stop();

  // auth errors are classified and still redacted; the mutation error string is clean too
  let fail = false;
  const g = fakeRun({ redeploy: () => ({ raw: { code: 0, stdout: JSON.stringify({ errors: [{ message: `Not Authorized for ${U1} (${secret})` }], data: null }), stderr: '' } }) });
  const r2 = mk({ run: g.run, env: { RAILWAY_API_TOKEN: secret, PATH: '' } });
  try { await r2.methods['railway.redeploy']({ serviceId: 's-web', environmentId: 'e-prod', confirm: true }); } catch (e) {
    fail = true;
    for (const bad of [secret, U1]) assert.ok(!e.message.includes(bad), `action error leaked ${bad}: ${e.message}`);
    assert.match(e.message, /permission|railway login/);
  }
  assert.ok(fail);
  const a = r2.state().actions[0];
  assert.equal(a.state, 'error');
  assert.ok(!a.message.includes(secret) && !a.message.includes(U1));
  r2.stop();
});

test('classify: auth / rate / network / missing CLI', async () => {
  assert.equal(R.classifyText('Unauthorized. Please login with `railway login`'), 'auth');
  assert.equal(R.classifyText('Not Authorized'), 'auth');
  assert.equal(R.classifyText('HTTP 429 Too Many Requests'), 'rate');
  assert.equal(R.classifyText('error sending request for url'), 'network');
  assert.equal(R.classifyText("error: unrecognized subcommand 'api'"), 'old');
  const missing = R.createRailway({ env: { PATH: '' }, exists: () => false, log: () => {} });
  const v = await missing.refresh();
  assert.equal(v.error.kind, 'missing'); assert.match(v.error.message, /npm i -g @railway\/cli/);
  missing.stop();
  const bogus = mk({ run: async () => ({ code: 0, stdout: JSON.stringify({ data: { me: null }, errors: [{ message: 'Not Authorized' }] }), stderr: '' }) });
  const b = await bogus.refresh();
  assert.equal(b.error.kind, 'auth'); assert.match(b.error.message, /railway login/);
  bogus.stop();
});

// ---------- polling ----------
test('pollDelay: no lease = no polling; busy 10 s, panel 30 s, chip 3 min; errors back off to 10 min; rate limit >= 5 min', () => {
  assert.equal(R.pollDelay({}), null);
  assert.equal(R.pollDelay({ busy: true }), null);
  assert.equal(R.pollDelay({ panel: true }), 30_000);
  assert.equal(R.pollDelay({ chip: true }), 180_000);
  assert.equal(R.pollDelay({ chip: true, busy: true }), 10_000);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 30].map((n) => R.pollDelay({ panel: true, errorStreak: n })), [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  assert.equal(R.pollDelay({ panel: true, busy: true, rateLimited: true }), 300_000);
  assert.equal(R.pollDelay({ chip: true, errorStreak: 1 }), 180_000);
});

test('polling backs off on repeated errors, waits 5 min on a rate limit, and recovers after a success', async () => {
  let t = 1_000_000;
  const scheduled = [];
  const timers = { setTimeout: (fn, ms) => { const h = { fn, ms, unref() {} }; scheduled.push(h); return h; }, clearTimeout: (h) => { const i = scheduled.indexOf(h); if (i >= 0) scheduled.splice(i, 1); } };
  let mode = 'fail';
  const run = async () => {
    if (mode === 'fail') return { code: 1, stdout: '', stderr: 'error sending request for url' };
    if (mode === 'rate') return { code: 1, stdout: '', stderr: 'Railway API returned HTTP 429 Too Many Requests' };
    return { code: 0, stdout: JSON.stringify({ data: statusData() }), stderr: '' };
  };
  const r = R.createRailway({ run, timers, now: () => t, log: () => {} });
  await r.methods['railway.status']({ watch: 'panel' });   // lease + first fetch (failure 1)
  await r.refresh();                                        // joins that same in-flight fetch
  const delays = [];
  for (let i = 0; i < 4; i++) { delays.push(r.state().poll.intervalMs); t += 1000; await r.refresh(); }
  assert.deepEqual(delays, [30_000, 60_000, 120_000, 240_000]);
  assert.equal(r.state().error.kind, 'network');
  assert.equal(scheduled.at(-1).ms, 480_000);               // the live timer matches the back-off (failure 5)
  mode = 'rate'; t += 1000; await r.refresh();
  assert.equal(r.state().error.kind, 'rate');
  assert.ok(r.state().poll.intervalMs >= 300_000);
  await assert.rejects(r.methods['railway.redeploy']({ serviceId: 's-web', environmentId: 'e-prod', confirm: true }), (e) => e.code === 'rate_limited');
  mode = 'ok'; t += 300_000;
  await r.methods['railway.status']({ watch: 'panel' });   // the panel renews its lease; the 5 min wait is over
  await r.refresh();
  assert.equal(r.state().error, null);
  assert.equal(r.state().poll.intervalMs, 10_000);   // discord-bot is BUILDING in the fixture
  // lease lapses: no more polling at all
  t += 80_000;
  assert.equal(r.state().poll.intervalMs, null);
  r.stop();
});

test('railway.changed fires on a change, not on every identical poll', async () => {
  const events = [];
  const f = fakeRun();
  const r = mk({ run: f.run, emit: (e, d) => events.push([e, d]) });
  await r.refresh(); await r.refresh(); await r.refresh();
  assert.equal(events.filter(([e]) => e === 'railway.changed').length, 1);
  r.stop();
});

// ---------- the real spawn path, against a fake CLI script ----------
test('spawn path: a --test run with HELM_RAILWAY_CLI=<fake.js> sends the document on stdin and the id as --raw-var', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-railway-'));
  const log = path.join(dir, 'calls.jsonl');
  const fake = path.join(dir, 'fake-railway.js');
  const data = JSON.stringify({ data: statusData() });
  fs.writeFileSync(fake, `
const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => input += d).on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');
  if (/deploymentRedeploy/.test(input)) process.stdout.write(JSON.stringify({ data: { deploymentRedeploy: { id: 'd-web-3', status: 'INITIALIZING' } } }));
  else process.stdout.write(${JSON.stringify(data)});
});`);
  const r = R.createRailway({ test: true, env: { ...process.env, HELM_RAILWAY_CLI: fake }, log: () => {} });
  try {
    const v = await r.refresh();
    assert.equal(v.error, null, JSON.stringify(v.error));
    assert.equal(v.projects.length, 2);
    assert.equal(v.canAct, true);
    const res = await r.methods['railway.redeploy']({ serviceId: 's-web', environmentId: 'e-prod', deploymentId: 'd-web-2', confirm: true });
    assert.equal(res.action.state, 'sent');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const mut = calls.find((c) => /mutation/.test(c.input));
    assert.ok(mut, 'mutation reached the fake CLI');
    assert.deepEqual(mut.args, ['api', '-f', '-', '--compact', '--allow-errors', '--raw-var', 'id=d-web-2']);
    assert.match(calls[0].input, /query HelmRailwayStatus/);
  } finally {
    r.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findRailwayCli: the npm shim resolves to the real railway.exe beside it', () => {
  const have = new Set([path.join('C:\\npm', 'railway.cmd'), path.join('C:\\npm', 'node_modules', '@railway', 'cli', 'bin', 'railway.exe')]);
  assert.equal(R.findRailwayCli({ env: { PATH: 'C:\\x;C:\\npm' }, platform: 'win32', exists: (p) => have.has(p) }), path.join('C:\\npm', 'node_modules', '@railway', 'cli', 'bin', 'railway.exe'));
  assert.equal(R.findRailwayCli({ env: { PATH: '' }, platform: 'win32', exists: () => false }), null);
});

// ---------- UI words (ui/lib/railway-model.js) ----------
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const view = (services, extra = {}) => ({ mode: 'ready', projects: [{ id: 'p1', name: 'Storefront', services: services.filter((s) => s.p !== 2) }, { id: 'p2', name: 'Tickets', services: services.filter((s) => s.p === 2) }], checkedAt: NOW - 5000, fetchedAt: NOW - 5000, error: null, actions: [], canAct: true, ...extra });
const s = (status, extra = {}) => ({ key: `${Math.random()}`, name: 'web', environment: 'production', prod: true, status, tone: M.toneOf(status), since: NOW - 80_000, ...extra });

test('chip: all live quietly, amber when building, red when failed (red wins), hidden when off, reason when signed out', () => {
  assert.deepEqual(pick(M.chipSummary(view([s('live'), s('live', { p: 2 })]), NOW)), { tone: 'ok', text: 'Railway · all live' });
  assert.deepEqual(pick(M.chipSummary(view([s('building'), s('live', { p: 2 })]), NOW)), { tone: 'busy', text: 'Railway · Storefront building' });
  assert.deepEqual(pick(M.chipSummary(view([s('deploying'), s('failed', { p: 2 })]), NOW)), { tone: 'bad', text: 'Railway · Tickets failed' });
  assert.deepEqual(pick(M.chipSummary(view([s('building'), s('deploying', { p: 2 })]), NOW)), { tone: 'busy', text: 'Railway · 2 building' });
  assert.equal(M.chipSummary({ mode: 'off', offReason: 'test' }, NOW).hidden, true);
  const out = M.chipSummary({ mode: 'ready', projects: null, error: { kind: 'auth', message: 'Railway sign-in is missing or expired.' } }, NOW);
  assert.equal(out.text, 'Railway · signed out'); assert.match(out.title, /sign-in/);
  const stale = M.chipSummary(view([s('live')], { error: { kind: 'network', message: 'Could not reach Railway.' }, fetchedAt: NOW - 11 * 60_000 }), NOW);
  assert.equal(stale.text, 'Railway · all live · stale'); assert.match(stale.title, /Last check failed/);
});
function pick(x) { return { tone: x.tone, text: x.text }; }

test('row words: "live · 2h", "building · 1m 20s"; confirm names project/service/env and says when it is production', () => {
  assert.equal(M.stateLine({ status: 'live', since: NOW - 2 * 3_600_000 }, NOW), 'live · 2h');
  assert.equal(M.stateLine({ status: 'building', since: NOW - 80_000 }, NOW), 'building · 1m 20s');
  assert.equal(M.stateLine({ status: 'failed', since: NOW - 3 * 60_000 - 5000 }, NOW), 'failed · 3m');
  assert.equal(M.stateLine({ status: 'none', since: null }, NOW), 'no deploys');
  const c = M.confirmCopy('redeploy', { project: 'Storefront', name: 'web', environment: 'production', prod: true });
  assert.equal(c.title, 'Redeploy web?');
  assert.deepEqual(c.rows, [['Project', 'Storefront'], ['Service', 'web'], ['Environment', 'production']]);
  assert.equal(c.prodLine, 'This redeploys production.');
  assert.equal(M.confirmCopy('restart', { project: 'Storefront', name: 'web', environment: 'production', prod: true }).prodLine, 'This restarts production.');
  assert.equal(M.confirmCopy('restart', { project: 'Storefront', name: 'web', environment: 'staging', prod: false }).prodLine, null);
  assert.equal(M.projectSummary({ services: [{ status: 'live' }, { status: 'building' }, { status: 'live' }] }), '1 building · 2 live');
});
