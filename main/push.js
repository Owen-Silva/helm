// Web Push to the phone (PROTOCOL "Push"). Needs the phone page on tailnet HTTPS (main/https.js):
// a service worker (ui/sw.js) subscribes with this PC's VAPID public key and Helm POSTs encrypted
// pushes to the phone's push service (FCM for Android Chrome) with the `web-push` package.
//  - keys + subscriptions live in <userData>/push/ (vapid.json, subscriptions.json), never in the repo
//  - a subscription is shown and logged only as { id: sha256(endpoint)[0:12], service host }: never the
//    full endpoint or its keys
//  - WHAT is pushed: exactly the `notify` kinds main/notify.js turns into a desktop toast for a session
//    (waiting = needs input / permission, done = turn finished, error), filtered by the same
//    settings.notifications[kind] switches, and skipped when the desktop window is focused (notify.js
//    shows no toast then either: the user is at the PC). On top of that: never while a phone page is open and
//    visible (it reports itself with `phone.visible`; ui/shell/phone.js), since it has its own in-page cue.
//    Agent context hand-off alerts (source "context", 32% / 40%; main/notify.js onContextAlert) push too, gated
//    by their own switch (settings.notifyContextHandoff) instead of notifications[kind].
//  - expired subscriptions (404 / 410 from the push service) are dropped; other failures are kept with the
//    reason, shown in Settings, Phone
// Owner: lane https.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic, readJson } = require('./atomic');

const PUSH_KINDS = new Set(['waiting', 'done', 'error']);
const VISIBLE_MS = 150_000; // a "visible" report counts this long (the page repeats it every 60 s while visible)
const MAX_SUBS = 10;

const subId = (endpoint) => crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 12);
const hostOf = (endpoint) => { try { return new URL(endpoint).host; } catch { return 'unknown'; } };
const short = (s, n = 160) => String(s || '').replace(/https?:\/\/\S+/g, '[url]').replace(/\s+/g, ' ').trim().slice(0, n);

// Pure policy (exported for tests): should this notify event go to the phone? -> { send, reason }
function pushDecision(n, { prefs = {}, windowFocused = false, phoneVisible = false, subscribers = 0 } = {}) {
  if (!n || !n.title) return { send: false, reason: 'no title' };
  const ctx = n.source === 'context';   // agent context hand-off (32% / 40%): its own switch, notifyContextHandoff, already applied
  if (!PUSH_KINDS.has(n.kind)) return { send: false, reason: `"${n.kind || 'plain'}" notices stay on the desktop` };
  if (!ctx && prefs[n.kind] === false) return { send: false, reason: `${n.kind} notifications are off in Settings` };
  if (windowFocused) return { send: false, reason: 'the desktop window is focused' };
  if (phoneVisible) return { send: false, reason: 'the phone page is open and visible' };
  if (!subscribers) return { send: false, reason: 'no phone has turned on notifications' };
  return { send: true, reason: 'ok' };
}

// A subscription from the browser (PushSubscription.toJSON()) -> the stored shape, or throws bad_params.
function cleanSubscription(sub) {
  const bad = (m) => Object.assign(new Error(m), { code: 'bad_params' });
  if (!sub || typeof sub !== 'object') throw bad('subscription must be an object');
  const endpoint = String(sub.endpoint || '');
  let u; try { u = new URL(endpoint); } catch { throw bad('subscription.endpoint must be a URL'); }
  if (u.protocol !== 'https:') throw bad('subscription.endpoint must be https');
  if (endpoint.length > 1024) throw bad('subscription.endpoint is too long');
  const k = sub.keys || {};
  const b64u = /^[A-Za-z0-9_-]+=*$/;
  if (typeof k.p256dh !== 'string' || !b64u.test(k.p256dh) || k.p256dh.length > 200) throw bad('subscription.keys.p256dh is missing');
  if (typeof k.auth !== 'string' || !b64u.test(k.auth) || k.auth.length > 64) throw bad('subscription.keys.auth is missing');
  return { endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}

/**
 * createPush({ dir, webpush?, getSubject?, log?, now? })
 *   dir: <userData>/push
 *   webpush: the `web-push` module (injectable; null = push unavailable, with the reason)
 *   getSubject(): the VAPID subject, an https URL (this PC's https origin) or a mailto:
 * -> { publicKey(), subscribe(sub, meta), unsubscribe(endpointOrId), status(), send(payload, opts),
 *      notify(n, ctx), setVisible(clientId, visible), clientClosed(clientId), phoneVisible() }
 */
function createPush({ dir, webpush = null, loadError = null, getSubject = () => null, log = () => {}, now = Date.now }) {
  const vapidFile = path.join(dir, 'vapid.json');
  const subsFile = path.join(dir, 'subscriptions.json');
  let vapid = null;
  let subs = null;              // [{ endpoint, keys, id, host, addedAt, label, lastOkAt, lastError, lastErrorAt }]
  const visible = new Map();    // clientId -> at (last "visible" report)
  let lastSend = null;          // { at, kind, sent, failed, skipped? reason }

  function ensureDir() { fs.mkdirSync(dir, { recursive: true }); }

  function keys() {
    if (vapid) return vapid;
    const r = readJson(vapidFile, { now });
    if (r.status === 'ok' && r.value && r.value.publicKey && r.value.privateKey) return (vapid = r.value);
    if (!webpush) return null;
    const k = webpush.generateVAPIDKeys();
    vapid = { publicKey: k.publicKey, privateKey: k.privateKey, createdAt: now() };
    ensureDir();
    writeFileAtomic(vapidFile, JSON.stringify(vapid, null, 2));
    log('push: generated VAPID keys');
    return vapid;
  }

  function load() {
    if (subs) return subs;
    const r = readJson(subsFile, { now });
    subs = r.status === 'ok' && Array.isArray(r.value) ? r.value.filter((s) => s && s.endpoint && s.keys) : [];
    if (r.status === 'corrupt') log(`push: subscriptions.json was unreadable (${r.error}); starting empty`);
    return subs;
  }
  function save() { ensureDir(); writeFileAtomic(subsFile, JSON.stringify(subs, null, 2)); }

  const view = (s) => ({ id: s.id, host: s.host, label: s.label || null, addedAt: s.addedAt, lastOkAt: s.lastOkAt || null, lastError: s.lastError || null, lastErrorAt: s.lastErrorAt || null });

  function publicKey() {
    if (!webpush) { const e = new Error(`Push is unavailable: ${loadError || 'the web-push module is missing'}`); e.code = 'unavailable'; throw e; }
    return keys().publicKey;
  }

  function subscribe(sub, meta = {}) {
    const clean = cleanSubscription(sub);
    const list = load();
    const id = subId(clean.endpoint);
    const existing = list.find((s) => s.id === id);
    const label = short(meta.label, 60) || null;
    if (existing) { existing.keys = clean.keys; if (label) existing.label = label; existing.lastError = null; }
    else {
      list.push({ ...clean, id, host: hostOf(clean.endpoint), addedAt: now(), label, lastOkAt: null, lastError: null });
      while (list.length > MAX_SUBS) list.shift(); // oldest first
      log(`push: subscribed ${id} (${hostOf(clean.endpoint)})`);
    }
    save();
    return { id, subscribed: true, count: list.length };
  }

  function unsubscribe(which) {
    const list = load();
    const id = /^[0-9a-f]{12}$/.test(String(which || '')) ? which : subId(which);
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) return { removed: false, count: list.length };
    list.splice(i, 1); save();
    log(`push: unsubscribed ${id}`);
    return { removed: true, count: list.length };
  }

  function status() {
    const list = load();
    return {
      available: !!webpush,
      reason: webpush ? null : (loadError || 'the web-push module is missing'),
      count: list.length,
      subscriptions: list.map(view),
      lastSend,
    };
  }

  // payload: { title, body, sessionId?, kind?, tag? } -> { sent, failed, removed, results: [{ id, ok, status?, error? }] }
  async function send(payload, { ttl = 3600, urgency = 'normal', topic = null } = {}) {
    if (!webpush) return { sent: 0, failed: 0, removed: 0, results: [], error: `Push is unavailable: ${loadError || 'web-push missing'}` };
    const list = load().slice();
    const k = keys();
    const subject = getSubject() || 'mailto:helm@localhost.invalid';
    const body = JSON.stringify(payload);
    const results = [];
    let removed = 0;
    await Promise.all(list.map(async (s) => {
      try {
        const r = await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, {
          vapidDetails: { subject, publicKey: k.publicKey, privateKey: k.privateKey },
          TTL: ttl, urgency, ...(topic ? { topic } : {}), timeout: 15000,
        });
        s.lastOkAt = now(); s.lastError = null;
        results.push({ id: s.id, ok: true, status: r && r.statusCode });
      } catch (e) {
        const status = e && e.statusCode;
        if (status === 404 || status === 410) {
          const i = subs.findIndex((x) => x.id === s.id); if (i >= 0) { subs.splice(i, 1); removed++; }
          log(`push: ${s.id} (${s.host}) expired (${status}); removed`);
          results.push({ id: s.id, ok: false, status, error: 'expired; removed', removed: true });
          return;
        }
        // never the endpoint: WebPushError carries it, so only status + a scrubbed body/message
        const why = status ? `${status} ${short(e.body || e.message, 120)}` : short((e && (e.code || e.message)) || String(e), 120);
        s.lastError = why; s.lastErrorAt = now();
        log(`push: ${s.id} (${s.host}) failed: ${why}`);
        results.push({ id: s.id, ok: false, status: status || null, error: why });
      }
    }));
    save();
    const sent = results.filter((r) => r.ok).length;
    return { sent, failed: results.length - sent - removed, removed, results };
  }

  function phoneVisible() {
    const t = now();
    for (const [id, at] of visible) if (t - at > VISIBLE_MS) visible.delete(id);
    return visible.size > 0;
  }
  function setVisible(clientId, isVisible) { if (isVisible) visible.set(clientId, now()); else visible.delete(clientId); }
  function clientClosed(clientId) { visible.delete(clientId); }

  // A host `notify` event -> maybe one push. ctx: { prefs, windowFocused }.
  async function notify(n, ctx = {}) {
    const d = pushDecision(n, { ...ctx, phoneVisible: phoneVisible(), subscribers: webpush ? load().length : 0 });
    if (!d.send) { if (subs && subs.length) lastSend = { at: now(), kind: n && n.kind, skipped: true, reason: d.reason }; return { sent: 0, skipped: d.reason }; }
    // A context alert gets its own topic + tag per agent, so it never replaces the session's "needs you" push (and
    // that agent's 40% alert replaces its 32% one).
    const ctxKey = n.source === 'context' && n.agentId ? `ctx-${n.agentId}` : '';
    const topic = n.sessionId ? crypto.createHash('sha256').update(`${n.sessionId}:${ctxKey || n.kind}`).digest('base64url').slice(0, 32) : null;
    const tag = n.sessionId ? `helm-${n.sessionId}${ctxKey ? `-${ctxKey}` : ''}` : 'helm';
    const r = await send({ title: String(n.title).slice(0, 120), body: String(n.body || '').slice(0, 400), sessionId: n.sessionId || null, kind: n.kind, tag },
      { urgency: n.kind === 'done' ? 'normal' : 'high', topic, ttl: n.kind === 'done' ? 3600 : 6 * 3600 });
    lastSend = { at: now(), kind: n.kind, sent: r.sent, failed: r.failed, removed: r.removed };
    return r;
  }

  return { publicKey, subscribe, unsubscribe, status, send, notify, setVisible, clientClosed, phoneVisible };
}

// Load web-push without letting a broken install take Helm down: -> { webpush, error }
function loadWebPush() {
  try { return { webpush: require('web-push'), error: null }; }
  catch (e) { return { webpush: null, error: `web-push did not load (${String(e && e.message || e).split('\n')[0]}); run npm install` }; }
}

module.exports = { createPush, pushDecision, cleanSubscription, subId, loadWebPush, PUSH_KINDS, VISIBLE_MS };
