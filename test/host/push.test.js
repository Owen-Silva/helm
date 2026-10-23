// main/push.js: Web Push policy, storage in userData, and what is (never) shown or logged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPush, pushDecision, cleanSubscription, subId, VISIBLE_MS } = require('../../main/push');

const SUB = (n = 1) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/secret-endpoint-${n}`, keys: { p256dh: 'BPk' + 'a'.repeat(84), auth: 'x'.repeat(22) } });

function fakeWebPush(statusFor = () => 201) {
  const sent = [];
  return {
    sent,
    generateVAPIDKeys: () => ({ publicKey: 'B' + 'k'.repeat(86), privateKey: 'p'.repeat(43) }),
    sendNotification: async (sub, body, opts) => {
      sent.push({ endpoint: sub.endpoint, body: JSON.parse(body), opts });
      const status = statusFor(sub.endpoint);
      if (status >= 200 && status < 300) return { statusCode: status };
      throw Object.assign(new Error(`Received unexpected response code`), { statusCode: status, endpoint: sub.endpoint, body: `push service said no to ${sub.endpoint}` });
    },
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'helm-push-'));

test('pushDecision follows notify.js: the session kinds, the Settings switches, not while the desktop window is focused or the phone page is visible', () => {
  const n = (kind, extra = {}) => ({ title: 'Fix login', body: 'Done in 40s', sessionId: 's1', kind, ...extra });
  const go = { subscribers: 1 };
  assert.equal(pushDecision(n('done'), go).send, true);
  assert.equal(pushDecision(n('waiting'), go).send, true);
  assert.equal(pushDecision(n('error'), go).send, true);
  assert.equal(pushDecision(n('info'), go).send, false, 'infra notices (busy port, hotkey) stay on the desktop');
  assert.equal(pushDecision(n('waiting', { source: 'context' }), go).send, true, 'context hand-off alerts reach the phone');
  assert.equal(pushDecision(n('error', { source: 'context' }), { ...go, prefs: { error: false } }).send, true, 'context alerts have their own switch, not notifications[kind]');
  assert.match(pushDecision(n('waiting', { source: 'context' }), { ...go, windowFocused: true }).reason, /desktop window is focused/);
  assert.match(pushDecision(n('done'), { ...go, prefs: { done: false } }).reason, /off in Settings/);
  assert.match(pushDecision(n('done'), { ...go, windowFocused: true }).reason, /desktop window is focused/);
  assert.match(pushDecision(n('done'), { ...go, phoneVisible: true }).reason, /phone page is open and visible/);
  assert.match(pushDecision(n('done'), { subscribers: 0 }).reason, /no phone/);
  assert.equal(pushDecision({ kind: 'done' }, go).send, false);
});

test('cleanSubscription accepts a browser subscription and rejects junk', () => {
  assert.deepEqual(cleanSubscription({ ...SUB(), expirationTime: null }), SUB());
  for (const bad of [null, {}, { endpoint: 'http://fcm.googleapis.com/x', keys: SUB().keys }, { endpoint: 'not a url', keys: SUB().keys },
    { endpoint: SUB().endpoint, keys: { p256dh: 'has spaces!', auth: 'x' } }, { endpoint: SUB().endpoint, keys: { p256dh: SUB().keys.p256dh } }]) {
    assert.throws(() => cleanSubscription(bad), { code: 'bad_params' });
  }
});

test('keys + subscriptions live in the given userData dir; status and logs never carry the endpoint or keys', async () => {
  const dir = tmp();
  const logs = [];
  const wp = fakeWebPush();
  const push = createPush({ dir, webpush: wp, getSubject: () => 'https://my-pc.example.ts.net', log: (...a) => logs.push(a.join(' ')) });
  const pk = push.publicKey();
  assert.equal(pk, 'B' + 'k'.repeat(86));
  assert.ok(fs.existsSync(path.join(dir, 'vapid.json')));
  const r = push.subscribe(SUB(1), { label: 'Android Chrome' });
  assert.equal(r.id, subId(SUB(1).endpoint));
  assert.equal(push.subscribe(SUB(1)).count, 1, 'same endpoint twice = one subscription');
  const st = push.status();
  assert.equal(st.count, 1);
  assert.deepEqual(Object.keys(st.subscriptions[0]).sort(), ['addedAt', 'host', 'id', 'label', 'lastError', 'lastErrorAt', 'lastOkAt']);
  assert.equal(st.subscriptions[0].host, 'fcm.googleapis.com');
  assert.ok(!JSON.stringify(st).includes('secret-endpoint'), 'status has no endpoint');
  // a second instance reads the same files (survives a restart)
  const again = createPush({ dir, webpush: wp });
  assert.equal(again.publicKey(), pk);
  assert.equal(again.status().count, 1);
  // send: VAPID subject + the payload
  const out = await push.send({ title: 't', body: 'b', kind: 'test' }, { urgency: 'high', ttl: 60 });
  assert.equal(out.sent, 1);
  assert.equal(wp.sent[0].opts.vapidDetails.subject, 'https://my-pc.example.ts.net');
  assert.equal(wp.sent[0].opts.urgency, 'high');
  assert.ok(push.status().subscriptions[0].lastOkAt);
  assert.ok(!logs.some((l) => l.includes('secret-endpoint') || l.includes(SUB().keys.auth)), logs.join('\n'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an expired subscription (410) is dropped; another failure is kept with a scrubbed reason', async () => {
  const dir = tmp();
  const logs = [];
  const wp = fakeWebPush((ep) => (ep.endsWith('-1') ? 410 : ep.endsWith('-2') ? 403 : 201));
  const push = createPush({ dir, webpush: wp, log: (...a) => logs.push(a.join(' ')) });
  push.subscribe(SUB(1)); push.subscribe(SUB(2)); push.subscribe(SUB(3));
  const r = await push.send({ title: 'x' });
  assert.equal(r.sent, 1);
  assert.equal(r.removed, 1);
  assert.equal(r.failed, 1);
  const st = push.status();
  assert.equal(st.count, 2);
  const failing = st.subscriptions.find((s) => s.lastError);
  assert.match(failing.lastError, /^403 /);
  assert.ok(!failing.lastError.includes('secret-endpoint'), failing.lastError);
  assert.ok(!logs.some((l) => l.includes('secret-endpoint')), logs.join('\n'));
  assert.ok(!JSON.stringify(r).includes('secret-endpoint'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('notify: skipped while a phone page reports visible (until the report goes stale), sent otherwise', async () => {
  const dir = tmp();
  let t = 1_000_000;
  const wp = fakeWebPush();
  const push = createPush({ dir, webpush: wp, now: () => t });
  push.subscribe(SUB(1));
  const n = { title: 'Fix login', body: 'Done in 40s', sessionId: 's1', kind: 'done' };
  push.setVisible('c1', true);
  assert.match((await push.notify(n)).skipped, /visible/);
  assert.equal(push.status().lastSend.skipped, true);
  t += VISIBLE_MS + 1; // the page stopped reporting (frozen / killed)
  assert.equal((await push.notify(n)).sent, 1);
  push.setVisible('c2', true); push.clientClosed('c2');
  assert.equal((await push.notify(n, { windowFocused: false })).sent, 1);
  assert.match((await push.notify(n, { windowFocused: true })).skipped, /focused/);
  assert.match((await push.notify({ ...n, kind: 'waiting' }, { prefs: { waiting: false } })).skipped, /off in Settings/);
  // payload: tag per session, collapse topic, no more than the title/body/session/kind
  const last = wp.sent[wp.sent.length - 1];
  assert.deepEqual(Object.keys(last.body).sort(), ['body', 'kind', 'sessionId', 'tag', 'title']);
  assert.equal(last.body.tag, 'helm-s1');
  assert.match(last.opts.topic, /^[A-Za-z0-9_-]{1,32}$/);
  // a context hand-off alert (main/notify.js onContextAlert) pushes with its own per-agent tag and topic, so it
  // never replaces the session's "needs you" push
  const ctx = { title: "Agent 'lane:x' is at 34% context — hand it off", body: 'Hand off now', sessionId: 's1', kind: 'waiting', source: 'context', agentId: 'tu1', threshold: 32 };
  assert.equal((await push.notify(ctx, { prefs: { waiting: false } })).sent, 1);
  const c = wp.sent[wp.sent.length - 1];
  assert.equal(c.body.tag, 'helm-s1-ctx-tu1');
  assert.equal(c.body.title, ctx.title);
  assert.notEqual(c.opts.topic, last.opts.topic);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('without web-push: unavailable with the reason, nothing thrown at notify time', async () => {
  const dir = tmp();
  const push = createPush({ dir, webpush: null, loadError: 'web-push did not load (x); run npm install' });
  assert.throws(() => push.publicKey(), { code: 'unavailable' });
  assert.equal(push.status().available, false);
  assert.match(push.status().reason, /npm install/);
  assert.deepEqual(await push.notify({ title: 'x', kind: 'done' }), { sent: 0, skipped: 'no phone has turned on notifications' });
  fs.rmSync(dir, { recursive: true, force: true });
});
