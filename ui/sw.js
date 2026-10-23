// Helm's service worker: the phone page over tailnet HTTPS only (registered by ui/shell/phone.js;
// plain http has no service workers). Served without the key (main/server.js PUBLIC_PATHS): it holds no
// data and caches nothing.
//  1. push: show what Helm sent (main/push.js), unless a Helm page is visible right now (it has its own cue)
//  2. notificationclick: focus an open Helm window on that session, else open one at /?session=<id>
//  3. fetch: page loads go to the network; when the PC can't be reached, a small offline page instead of
//     the browser's error. (A real fetch handler is also what lets Android Chrome install Helm as an app.)
const page = (title, body) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#141516"><title>Helm</title>
<body style="margin:0;font:15px/1.5 system-ui,sans-serif;background:#141516;color:#d9dadb;display:grid;place-items:center;min-height:100vh">
<main style="max-width:340px;padding:24px">
<p style="font-size:17px;color:#f2f2f2;margin:0 0 8px">${title}</p>
<p style="margin:0 0 16px;color:#a3a5a8">${body}</p>
<a href="" style="display:inline-block;padding:8px 14px;border:1px solid #3a3c40;border-radius:8px;color:#f2f2f2;text-decoration:none">Try again</a>
</main></body></html>`;
// no network at all: the PC (or this phone's Tailscale) is down
const OFFLINE = page("Helm can't reach your PC", 'The PC may be asleep, or this phone is off Tailscale. Your sessions keep running on the PC.');
// Tailscale answered but Helm didn't (tailscale serve says 502/504): Helm is closed or restarting
const NOT_RUNNING = page("Helm isn't answering on your PC", 'Tailscale reached the PC, but Helm is closed or restarting. Start Helm on the PC, then try again.');
const html = (text) => new Response(text, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate' || req.method !== 'GET') return; // everything else: the browser as usual
  event.respondWith(fetch(req).then(
    (res) => (res.status === 502 || res.status === 504 ? html(NOT_RUNNING) : res), // Helm itself never answers 502/504
    () => html(OFFLINE),
  ));
});

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'Helm', body: event.data ? event.data.text() : '' }; }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (d.kind !== 'test' && wins.some((c) => c.visibilityState === 'visible' && c.focused)) return;
    await self.registration.showNotification(d.title || 'Helm', {
      body: d.body || '',
      tag: d.tag || 'helm',
      renotify: true,
      icon: '/assets/app-icon-192.png',
      data: { sessionId: d.sessionId || null },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sid = event.notification.data && event.notification.data.sessionId;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find((c) => c.visibilityState === 'visible') || wins[0];
    if (w) {
      try { await w.focus(); } catch {}
      if (sid) w.postMessage({ type: 'helm.select', sessionId: sid });
      return;
    }
    await self.clients.openWindow(sid ? `/?session=${encodeURIComponent(sid)}` : '/');
  })());
});
