// Phone: installed-app glue, foreground attention, and the Settings -> Phone health checklist.
// Loaded as its own module from index.html (side effects below) and imported by settings.js.
//  - attention (web clients, i.e. the phone; the desktop window has its taskbar badge): when a
//    session starts waiting, a short vibration if the page is visible, "(N) Helm" in the title and a
//    dot on the favicon while N > 0 (the title survives in the tab switcher when hidden). Follows
//    settings.notifications.waiting. Plain http over Tailscale has no push and no service worker,
//    so this is what reaches the user while the page is open.
//  - theme-color follows the resolved theme (the status bar in standalone mode), html.standalone
//    when launched from the home screen.
//  - PhoneHealth: phone.status (main/phone.js) as a checklist with the exact fix per failing item.
//  - openFind(): the phone has no Ctrl+F; this fires the same shortcut the chat pane listens for.
//  - tailnet HTTPS (main/https.js): registers the service worker (ui/sw.js), follows its notification
//    clicks (and /?session=<id>), reports phone.visible so Helm doesn't push while this page is in view,
//    and PushControl: the phone's own "Turn on notifications" (Web Push needs a tap for permission).
// Owner: lane phone.
import { effect, signal } from '@preact/signals';
import { useState, useEffect } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { sessions, settings, appInfo, ready, rpc, isMock, toast } from '../lib/store.js';
import { openSession } from './state.js';

// ---------------------------------------------------------------- attention
const isWebClient = () => appInfo.value.platform !== 'electron';
const waitingOn = () => (settings.value?.notifications?.waiting ?? true) !== false;

let seen = null;           // Map id -> status (null until the first session list after hello)
let baseIcon = null;       // the page's own favicon href
let badgeHref = null;      // cached data URL of the badged favicon
let lastCount = -1;

function iconLink() { return document.querySelector('link[rel="icon"]'); }

function badgedIcon(href) {
  if (badgeHref) return Promise.resolve(badgeHref);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, 64, 64);
        g.beginPath(); g.arc(50, 14, 13, 0, Math.PI * 2);
        g.fillStyle = '#141516'; g.fill();
        g.beginPath(); g.arc(50, 14, 10, 0, Math.PI * 2);
        g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--st-waiting').trim() || '#e0a33a'; g.fill();
        badgeHref = c.toDataURL('image/png');
      } catch { badgeHref = null; }
      resolve(badgeHref);
    };
    img.onerror = () => resolve(null);
    img.src = href;
  });
}

function paintAttention(count) {
  if (count === lastCount) return;
  lastCount = count;
  document.title = count > 0 ? `(${count}) Helm` : 'Helm';
  const link = iconLink();
  if (!link) return;
  if (baseIcon == null) baseIcon = link.getAttribute('href');
  if (count > 0) badgedIcon(baseIcon).then((h) => { if (h && lastCount > 0) { link.setAttribute('type', 'image/png'); link.setAttribute('href', h); } });
  else { link.setAttribute('type', 'image/svg+xml'); link.setAttribute('href', baseIcon); }
}

function buzz() {
  try { if (document.visibilityState === 'visible' && typeof navigator.vibrate === 'function') navigator.vibrate([70, 50, 70]); } catch {}
}

/** One step of the attention state machine (exported for tests). Returns { count, started }. */
export function attentionStep(list, prev) {
  let count = 0; const started = [];
  for (const s of list || []) {
    if (s.status === 'waiting') { count++; if (prev && prev.get(s.id) !== 'waiting') started.push(s.id); }
  }
  return { count, started };
}

effect(() => {
  const list = sessions.value;
  const on = ready.value && isWebClient() && waitingOn();
  if (!ready.value) return;
  const { count, started } = attentionStep(list, seen);
  seen = new Map(list.map((s) => [s.id, s.status]));
  if (!on) { paintAttention(0); return; }
  paintAttention(count);
  if (started.length) buzz();
});

// ---------------------------------------------------------------- theme-color + standalone
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg && meta.getAttribute('content') !== bg) meta.setAttribute('content', bg);
}
if (typeof MutationObserver === 'function') {
  new MutationObserver(syncThemeColor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  queueMicrotask(syncThemeColor);
}
const standaloneMq = typeof matchMedia === 'function' ? matchMedia('(display-mode: standalone)') : null;
const markStandalone = () => document.documentElement.classList.toggle('standalone', !!(standaloneMq?.matches || navigator.standalone));
markStandalone();
standaloneMq?.addEventListener?.('change', markStandalone);

// ---------------------------------------------------------------- service worker, deep links, visibility
const onHttps = typeof location !== 'undefined' && location.protocol === 'https:';
const swSupported = () => !isMock && onHttps && typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext;
export const swState = signal({ state: swSupported() ? 'registering' : 'none', error: null });
if (swSupported()) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .then(() => { swState.value = { state: 'ok', error: null }; })
    .catch((e) => { swState.value = { state: 'error', error: (e && e.message) || String(e) }; });
  // a notification tapped while Helm is open: show that session
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'helm.select' && e.data.sessionId) openWhenKnown(e.data.sessionId); });
}

function openWhenKnown(id) {
  let tries = 0;
  const go = () => { if (sessions.value.some((s) => s.id === id)) openSession(id); else if (tries++ < 25) setTimeout(go, 200); };
  go();
}
// /?session=<id>: a notification tapped while Helm was closed (ui/sw.js openWindow)
if (typeof location !== 'undefined') {
  const params = new URLSearchParams(location.search);
  const want = params.get('session');
  if (want) {
    params.delete('session');
    const rest = params.toString();
    try { history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch {}
    const stop = effect(() => { if (ready.value) { queueMicrotask(() => stop()); openWhenKnown(want); } });
  }
}

// phone.visible: Helm skips a push while a phone page is open and visible (main/push.js). Repeated every
// 60 s while visible: the host forgets a report after 150 s (a frozen tab stops counting).
let visTimer = null;
function reportVisible() {
  if (isMock || !ready.value || !isWebClient()) return;
  const send = () => rpc('phone.visible', { visible: document.visibilityState === 'visible' }).catch(() => {});
  send();
  clearInterval(visTimer);
  visTimer = document.visibilityState === 'visible' ? setInterval(send, 60_000) : null;
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', reportVisible);
effect(() => { if (ready.value) reportVisible(); });

// ---------------------------------------------------------------- push (this phone)
function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function sameKey(buf, b64u) {
  if (!buf) return false;
  const a = new Uint8Array(buf), b = b64uToBytes(b64u);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
function deviceLabel() {
  const ua = navigator.userAgent || '';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : 'Device';
  const br = /EdgA?\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${os} ${br}`;
}

/** What this page can do about push right now -> { state, reason } (exported for tests). */
export function pushAvailability({ secure, hasSw, hasPush, permission, standalone, ios }) {
  if (!secure) return { state: 'http', reason: 'This page is plain http, and browsers only allow push on https.' };
  if (!hasSw || !hasPush) return ios && !standalone
    ? { state: 'unsupported', reason: 'On iPhone, push works only from the Home Screen app: Share, Add to Home Screen, then open Helm from there.' }
    : { state: 'unsupported', reason: 'This browser has no Web Push.' };
  if (permission === 'denied') return { state: 'denied', reason: 'Notifications are blocked for this site. In Chrome: the lock icon next to the address (or Settings, Site settings), Notifications, Allow. Then come back here.' };
  return { state: 'ready', reason: null };
}

function availabilityNow() {
  return pushAvailability({
    secure: onHttps && !!window.isSecureContext,
    hasSw: 'serviceWorker' in navigator,
    hasPush: 'PushManager' in window && typeof Notification !== 'undefined',
    permission: typeof Notification !== 'undefined' ? Notification.permission : 'default',
    standalone: !!(standaloneMq?.matches || navigator.standalone),
    ios: /iPhone|iPad/.test(navigator.userAgent || ''),
  });
}

// { state: 'checking'|'http'|'unsupported'|'denied'|'off'|'on'|'error', reason, id? }
export const pushState = signal({ state: 'checking', reason: null });

async function readyReg() {
  if (swState.value.state === 'error') throw new Error(`The service worker did not register: ${swState.value.error}`);
  return Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('The service worker did not start within 15 s. Reload the page and try again.')), 15000))]);
}

// Re-check this phone's push state and re-send its subscription (idempotent: survives a host that lost it).
export async function syncPush() {
  if (isMock) { pushState.value = { state: 'off', reason: null }; return; }
  const a = availabilityNow();
  if (a.state !== 'ready') { pushState.value = { state: a.state, reason: a.reason }; return; }
  try {
    const reg = await readyReg();
    const sub = await reg.pushManager.getSubscription();
    if (!sub || Notification.permission !== 'granted') { pushState.value = { state: 'off', reason: null }; return; }
    const { publicKey } = await rpc('push.key');
    if (!sameKey(sub.options && sub.options.applicationServerKey, publicKey)) { pushState.value = { state: 'off', reason: 'This phone was subscribed with an older Helm key. Turn notifications on again.' }; return; }
    const r = await rpc('push.subscribe', { subscription: sub.toJSON(), label: deviceLabel() });
    pushState.value = { state: 'on', reason: null, id: r.id };
  } catch (e) { pushState.value = { state: 'error', reason: (e && e.message) || String(e) }; }
}

async function turnOnPush() {
  const a = availabilityNow();
  if (a.state !== 'ready') { pushState.value = { state: a.state, reason: a.reason }; return; }
  pushState.value = { state: 'busy', reason: 'Asking for permission…' };
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { const b = availabilityNow(); pushState.value = perm === 'denied' ? { state: 'denied', reason: b.reason } : { state: 'off', reason: 'Permission was not given. Tap Turn on notifications again and choose Allow.' }; return; }
    pushState.value = { state: 'busy', reason: 'Subscribing…' };
    const reg = await readyReg();
    const { publicKey } = await rpc('push.key');
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options && sub.options.applicationServerKey, publicKey)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
    const r = await rpc('push.subscribe', { subscription: sub.toJSON(), label: deviceLabel() });
    pushState.value = { state: 'on', reason: null, id: r.id };
  } catch (e) { pushState.value = { state: 'error', reason: (e && e.message) || String(e) }; }
}

async function turnOffPush() {
  pushState.value = { state: 'busy', reason: 'Turning off…' };
  try {
    const reg = await readyReg();
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await rpc('push.unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    pushState.value = { state: 'off', reason: null };
  } catch (e) { pushState.value = { state: 'error', reason: (e && e.message) || String(e) }; }
}

effect(() => { if (ready.value && isWebClient()) syncPush(); });

/** The phone's own push switch (Settings, Phone on a web client). */
export function PushControl() {
  const ps = pushState.value;
  const httpsUrl = (settings.value?.phone?.url || '').startsWith('https://') ? settings.value.phone.url : null;
  const busy = ps.state === 'busy' || ps.state === 'checking';
  const text = {
    checking: 'Checking…',
    busy: ps.reason || 'Working…',
    http: httpsUrl ? `${ps.reason} Open the https link to get notifications and a real app install.` : `${ps.reason} Turn on HTTPS on the PC first: Settings, Phone, Turn on HTTPS.`,
    unsupported: ps.reason,
    denied: ps.reason,
    off: ps.reason || 'Get a notification when a session needs you, finishes or fails, while this page is closed.',
    on: 'On. Helm pushes "needs you", "done" and errors here while this page is not open.',
    error: `Did not work: ${ps.reason}`,
  }[ps.state] || ps.reason;
  const state = ps.state === 'on' ? 'ok' : ['denied', 'error', 'unsupported'].includes(ps.state) ? 'warn' : 'off';
  return html`<div class=${`ph-push ${state}`} data-push=${ps.state} role="group" aria-label="Notifications on this phone">
    <span class="ph-ic" aria-hidden="true"><${Icon} name="bell" size=${16} /></span>
    <div class="ph-body">
      <div class="ph-title">Notifications on this phone</div>
      <div class="ph-detail" role=${ps.state === 'error' ? 'alert' : null}>${text}</div>
    </div>
    <div class="ph-push-act">
      ${ps.state === 'http' && httpsUrl && html`<a class="btn btn-sm btn-primary" href=${httpsUrl}>Open the https link</a>`}
      ${(ps.state === 'off' || ps.state === 'error') && html`<button type="button" class="btn btn-sm btn-primary" onClick=${turnOnPush}>Turn on notifications</button>`}
      ${ps.state === 'on' && html`<button type="button" class="btn btn-sm" onClick=${turnOffPush}>Turn off</button>`}
      ${busy && html`<span class="spinner" aria-hidden="true"></span>`}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- find (no Ctrl+F on a phone)
export function openFind() {
  dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true }));
}
export function FindButton() {
  return html`<button class="icon-btn ph-find" aria-label="Find in conversation" title="Find in conversation" onClick=${openFind}><${Icon} name="search" size=${18} /></button>`;
}

// ---------------------------------------------------------------- copy (http has no clipboard API)
export async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
  document.body.appendChild(ta);
  ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}

// ---------------------------------------------------------------- health checklist
export const FIREWALL_CMD = "Remove-NetFirewallRule -DisplayName 'Helm (Tailscale)' -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName 'Helm (Tailscale)' -Direction Inbound -Protocol TCP -LocalPort 4871 -RemoteAddress 100.64.0.0/10 -Action Allow";
const TS_DNS_ADMIN = 'https://login.tailscale.com/admin/dns';

// Mock mode has no host: a canned status (?phonestate=bad shows every failing item; https-off / https-live /
// push / push-error the tailnet https + push stages; the default is https live with one phone subscribed).
function mockHttps(stage, t) {
  const d = 'my-pc.example.ts.net';
  const live = { state: 'live', certs: true, domain: d, httpsPort: 443, url: `https://${d}`, target: 'http://127.0.0.1:4871', undo: 'tailscale serve --https=443 off', otherHandlers: 1, canChange: true, probe: { at: t - 20_000, ok: true, status: 200 } };
  const subs = [{ id: '3f9a1c2b7d10', host: 'fcm.googleapis.com', label: 'Android Chrome', addedAt: t - 86400_000, lastOkAt: t - 9 * 60_000, lastError: stage === 'push-error' ? '403 the VAPID credentials do not match' : null }];
  return {
    https: stage === 'bad' ? { state: 'no-certs', certs: false, domain: null, canChange: true }
      : stage === 'https-off' ? { state: 'off', certs: true, domain: d, nextPort: 443, otherHandlers: 1, canChange: true }
        : stage === 'https-down' ? { ...live, probe: { at: t - 5000, ok: false, error: 'ETIMEDOUT: no answer within 30 s' } } : live,
    push: { available: true, count: stage === 'push' || stage === 'push-error' || !stage ? 1 : 0, subscriptions: stage === 'push' || stage === 'push-error' || !stage ? subs : [],
      lastSend: stage === 'push' || !stage ? { at: t - 9 * 60_000, kind: 'done', sent: 1, failed: 0, removed: 0 } : null },
  };
}
function mockStatus() {
  const stage = new URLSearchParams(location.search).get('phonestate');
  const bad = stage === 'bad';
  const t = Date.now();
  return { ...mockStatusBase(bad, t), ...mockHttps(stage, t), httpsAvailable: stage !== 'bad', certDomains: stage === 'bad' ? [] : ['my-pc.example.ts.net'] };
}
function mockStatusBase(bad, t) {
  return bad ? {
    enabled: true, tailscaleUp: true, tailscaleIp: '100.64.0.1', tailscaleState: 'Running', boundAddresses: ['127.0.0.1', '100.64.0.1'], boundOnTailscale: true,
    port: 51233, expectedPort: 4871, portIsFallback: true, portOwner: { pid: 22512, name: 'node' },
    firewallRule: 'missing', firewallDetail: 'no rule named "Helm (Tailscale)"', firewallRuleName: 'Helm (Tailscale)',
    httpsAvailable: false, certDomains: [], magicDnsName: 'my-pc.example.ts.net', phones: [{ name: 'Pixel 8', os: 'android', online: false }],
    phoneClientsNow: 0, lastPhoneAt: null, lastPhoneRemote: null, url: settings.value?.phone?.url || null, checkedAt: t,
  } : {
    enabled: true, tailscaleUp: true, tailscaleIp: '100.64.0.1', tailscaleState: 'Running', boundAddresses: ['127.0.0.1', '100.64.0.1'], boundOnTailscale: true,
    port: 4871, expectedPort: 4871, portIsFallback: false, portOwner: null,
    firewallRule: 'present', firewallDetail: 'allows TCP 4871 inbound from the tailnet', firewallRuleName: 'Helm (Tailscale)',
    httpsAvailable: false, certDomains: [], magicDnsName: 'my-pc.example.ts.net', phones: [{ name: 'Pixel 8', os: 'android', online: true }],
    phoneClientsNow: 1, lastPhoneAt: t - 4 * 60_000, lastPhoneRemote: '100.88.12.4', url: settings.value?.phone?.url || null, checkedAt: t,
  };
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** phone.status -> checklist rows [{ id, state: 'ok'|'warn'|'off', title, detail, fix?, cmd?, link? }] (exported for tests). */
export function healthItems(st) {
  if (!st) return [];
  const rows = [];
  const os = (p) => (p.os === 'ios' ? 'iPhone' : p.os === 'android' ? 'Android' : p.os);
  if (!st.enabled) rows.push({ id: 'enabled', state: 'off', title: 'Phone access is off', detail: 'Turn on "Allow phone access" to serve Helm on your tailnet.' });

  rows.push(st.tailscaleUp
    ? { id: 'tailscale', state: 'ok', title: 'Tailscale is connected', detail: `This PC is ${st.tailscaleIp}${st.magicDnsName ? ` (${st.magicDnsName})` : ''}.` }
    : { id: 'tailscale', state: 'warn', title: 'Tailscale is not connected', detail: st.tailscaleState && st.tailscaleState !== 'Running' ? `Tailscale reports "${st.tailscaleState}".` : 'This PC has no Tailscale address.',
      fix: 'Open Tailscale from the system tray and connect (sign in if it asks).' });

  if (st.tailscaleUp && st.enabled) {
    rows.push(st.boundOnTailscale
      ? { id: 'bound', state: 'ok', title: 'Listening on the tailnet', detail: `Helm answers on ${st.tailscaleIp}:${st.port}.` }
      : { id: 'bound', state: 'warn', title: 'Not listening on the tailnet yet', detail: `Helm has not bound ${st.tailscaleIp}:${st.port}. It retries every minute.`, fix: 'If this stays amber, restart Helm.' });
  }

  if (st.portIsFallback) {
    const who = st.portOwner ? `${st.portOwner.name || 'Another program'} (PID ${st.portOwner.pid})` : 'Another program';
    rows.push({ id: 'port', state: 'warn', title: `Port ${st.expectedPort} is taken`,
      detail: `${who} is using ${st.expectedPort}, so Helm is on ${st.port} this time. The firewall rule only opens ${st.expectedPort}, and the phone link changes with the port.`,
      fix: `Close ${st.portOwner?.name || 'that program'}, then restart Helm.` });
  } else rows.push({ id: 'port', state: 'ok', title: `On port ${st.expectedPort}`, detail: 'The port the phone link and the firewall rule use.' });

  const reached = st.phoneClientsNow > 0 ? 'A phone is connected right now' : st.lastPhoneAt ? `A phone connected ${ago(st.lastPhoneAt)}` : '';
  if (st.firewallRule === 'present') rows.push({ id: 'firewall', state: 'ok', title: 'Windows Firewall lets the phone in', detail: `Rule "${st.firewallRuleName}" ${st.firewallDetail}.` });
  else {
    const what = st.firewallRule === 'missing' ? `Windows Firewall: ${st.firewallDetail}.` : `Could not read the firewall rules (${st.firewallDetail}).`;
    rows.push({ id: 'firewall', state: 'warn', title: st.firewallRule === 'missing' ? 'Firewall rule missing' : 'Firewall rule unknown',
      detail: reached ? `${what} ${reached}, so Windows is letting it in another way for now; the rule makes it permanent.` : `${what} Without it Windows can block the phone.`,
      fix: 'Run once in PowerShell opened with "Run as administrator":', cmd: FIREWALL_CMD });
  }

  const phones = st.phones || [];
  const online = phones.filter((p) => p.online);
  if (reached) rows.push({ id: 'phone', state: 'ok', title: reached, detail: st.lastPhoneRemote ? `From ${st.lastPhoneRemote} over Tailscale.` : 'Over Tailscale.' });
  else if (online.length) rows.push({ id: 'phone', state: 'ok', title: `${online[0].name} is on your tailnet`, detail: `${os(online[0])}, online. Open the link below on it.` });
  else if (phones.length) rows.push({ id: 'phone', state: 'warn', title: `${phones[0].name} is offline`, detail: `${os(phones[0])} is on your tailnet but not connected.`, fix: 'Open the Tailscale app on the phone and turn it on.' });
  else rows.push({ id: 'phone', state: 'warn', title: 'No phone on your tailnet', detail: 'Tailscale lists no Android or iPhone device.', fix: 'Install Tailscale on the phone and sign in with the same account as this PC.' });

  httpsRows(st, rows);
  pushRows(st, rows);
  return rows;
}

const NO_HTTPS = 'so the phone page cannot get push notifications or install as an app with its own window. While it is open it still vibrates and shows a count in the tab.';

// st.https (main/https.js status): certs off / certs on but not set up (button) / live (self-checked) / problems
function httpsRows(st, rows) {
  const h = st.https;
  if (!h) { // a host from before tailnet https
    rows.push(st.httpsAvailable
      ? { id: 'https', state: 'off', title: 'HTTPS certificates are on', detail: `${st.certDomains[0] || 'Your tailnet'} has a certificate. Restart Helm to set up HTTPS.` }
      : { id: 'https', state: 'off', title: 'Plain http (no push, no real install)', detail: `Your tailnet has no HTTPS certificates, ${NO_HTTPS}`, fix: 'Tailscale admin console, DNS, HTTPS Certificates: Enable.', link: TS_DNS_ADMIN });
    return;
  }
  const where = (port) => `https://${h.domain}${port && port !== 443 ? `:${port}` : ''}`;
  if (h.state === 'no-certs') {
    rows.push({ id: 'https', state: 'off', title: 'Plain http (no push, no real install)', detail: `Your tailnet has no HTTPS certificates, ${NO_HTTPS}`, fix: 'Tailscale admin console, DNS, HTTPS Certificates: Enable. Then Check again here.', link: TS_DNS_ADMIN });
  } else if (h.state === 'off') {
    rows.push({ id: 'https', state: 'off', title: 'HTTPS certificates are on, Helm is not using them yet',
      detail: `Turn on HTTPS and Helm asks Tailscale to serve ${where(h.nextPort)} to this PC: tailnet only, never the public internet. The phone link then becomes https (push, real install); plain http keeps working as a fallback.${h.otherHandlers ? ` Your other tailscale serve setup (${h.otherHandlers} handler${h.otherHandlers > 1 ? 's' : ''}) stays as it is.` : ''}`,
      ...(h.canChange ? { action: { id: 'https-on', label: 'Turn on HTTPS', primary: true, desktop: true } } : { fix: 'This Helm cannot change tailscale serve (it is a test run).' }) });
  } else if (h.state === 'live') {
    const p = h.probe;
    const undo = `To undo by hand: ${h.undo}`;
    if (p && !p.ok) rows.push({ id: 'https', state: 'warn', title: 'HTTPS is set up but did not answer', detail: `${h.url} -> ${h.target}. Self-check: ${p.error || `answered ${p.status}`}.`, fix: 'Make sure Tailscale is connected on this PC, then Check again. The very first https request can take up to 30 s while Tailscale fetches the certificate.', cmd: h.undo });
    else rows.push({ id: 'https', state: 'ok', title: 'HTTPS is on', detail: `${h.url} -> ${h.target}, tailnet only. ${p ? `Self-check ${ago(p.at)}: it answered.` : 'Not self-checked yet.'} ${undo}.`, action: { id: 'https-off', label: 'Turn off HTTPS', desktop: true, confirm: 'Turn off HTTPS? The phone link goes back to plain http, and push stops until you turn it on again.' } });
  } else if (h.state === 'funnel') {
    rows.push({ id: 'https', state: 'warn', title: 'Tailscale Funnel is on for Helm', detail: h.detail, fix: 'Run this in a terminal on this PC:', cmd: `tailscale funnel --https=${h.httpsPort} off` });
  } else if (h.state === 'busy') {
    rows.push({ id: 'https', state: 'warn', title: 'HTTPS ports are taken', detail: h.detail, fix: 'Free port 443 or 8443 in tailscale serve (tailscale serve status shows what uses them), then Check again.' });
  } else if (h.state === 'tailscale-down') {
    rows.push({ id: 'https', state: 'off', title: 'HTTPS waits for Tailscale', detail: h.detail });
  } else {
    rows.push({ id: 'https', state: 'warn', title: 'Could not check HTTPS', detail: h.detail || 'No answer from tailscale.', fix: 'Check that Tailscale is installed and running, then Check again.' });
  }
}

// st.push (main/push.js status): only once HTTPS is live (push needs it)
function pushRows(st, rows) {
  const h = st.https, p = st.push;
  if (!p || !h || h.state !== 'live') return;
  const last = p.lastSend
    ? p.lastSend.skipped ? ` Last notice not pushed (${ago(p.lastSend.at)}): ${p.lastSend.reason}.`
      : ` Last push ${ago(p.lastSend.at)}: ${p.lastSend.sent} delivered${p.lastSend.failed ? `, ${p.lastSend.failed} failed` : ''}.`
    : '';
  if (!p.available) { rows.push({ id: 'push', state: 'warn', title: 'Push is unavailable', detail: p.reason }); return; }
  if (!p.count) {
    rows.push({ id: 'push', state: 'off', title: 'No phone has notifications on', detail: 'Helm can push "needs you", "done" and errors to the phone while its page is closed.', fix: 'On the phone: open the https link, Settings, Phone, Turn on notifications.' });
    return;
  }
  const subs = p.subscriptions || [];
  const failing = subs.filter((s) => s.lastError);
  rows.push({ id: 'push', state: failing.length === subs.length ? 'warn' : 'ok',
    title: `Push is on for ${subs.length} device${subs.length > 1 ? 's' : ''}`,
    detail: subs.map((s) => `${s.label || 'Phone'} via ${s.host}${s.lastOkAt ? `, last delivered ${ago(s.lastOkAt)}` : ', nothing delivered yet'}${s.lastError ? `, last error: ${s.lastError}` : ''}`).join('; ') + '.' + last,
    action: { id: 'push-test', label: 'Send a test push' } });
}

function CopyCmd({ cmd }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    if (await copyText(cmd)) { setDone(true); setTimeout(() => setDone(false), 1600); }
    else toast({ title: 'Copy failed', body: 'Select the command and copy it by hand.', kind: 'error' });
  };
  return html`<div class="ph-cmd">
    <code class="mono">${cmd}</code>
    <button type="button" class="btn btn-sm" onClick=${copy}><${Icon} name=${done ? 'check' : 'copy'} size=${14} />${done ? 'Copied' : 'Copy'}</button>
  </div>`;
}

export function PhoneHealth() {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async (refresh = false) => {
    setBusy(true); setErr('');
    try { setSt(isMock ? mockStatus() : await rpc('phone.status', { refresh })); }
    catch (e) { setErr(e.code === 'unknown_method' ? 'The running Helm predates this check. Restart Helm to run it.' : (e.message || String(e))); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(false); }, []);
  // row buttons (Turn on / off HTTPS, Send a test push): their outcome stays on the row, success or failure
  const [act, setAct] = useState({}); // rowId -> { busy, ok?, msg }
  const run = async (row) => {
    const a = row.action;
    // two-step confirm on the row itself (no native dialog)
    if (a.confirm && !(act[row.id] && act[row.id].confirming)) { setAct((m) => ({ ...m, [row.id]: { confirming: true, msg: a.confirm } })); return; }
    setAct((m) => ({ ...m, [row.id]: { busy: true, msg: a.id === 'https-on' ? 'Setting up tailscale serve… (the first https request can take up to 30 s)' : 'Working…' } }));
    try {
      let msg;
      if (a.id === 'https-on') { const s = await rpc('phone.httpsOn'); msg = s.probe && s.probe.ok ? `Done: ${s.url} answered.` : `Set up, but the self-check failed: ${(s.probe && s.probe.error) || 'not checked'}.`; }
      else if (a.id === 'https-off') { await rpc('phone.httpsOff'); msg = 'HTTPS is off; the phone link is plain http again.'; }
      else if (a.id === 'push-test') {
        const r = await rpc('push.test');
        msg = r.sent ? `Sent to ${r.sent} device${r.sent > 1 ? 's' : ''}${r.failed ? `; ${r.failed} failed (${r.results.filter((x) => !x.ok).map((x) => x.error).join('; ')})` : ''}${r.removed ? `; ${r.removed} expired and removed` : ''}. Check the phone.`
          : `Not delivered: ${r.results.map((x) => x.error).filter(Boolean).join('; ') || 'no device answered'}.`;
        setAct((m) => ({ ...m, [row.id]: { busy: false, ok: r.sent > 0, msg } }));
        load(false);
        return;
      }
      setAct((m) => ({ ...m, [row.id]: { busy: false, ok: true, msg } }));
    } catch (e) {
      setAct((m) => ({ ...m, [row.id]: { busy: false, ok: false, msg: e.code === 'unknown_method' ? 'The running Helm predates this. Restart Helm.' : (e.message || String(e)) } }));
    }
    load(true);
  };
  const desktop = appInfo.value.platform === 'electron';
  const rows = healthItems(st);
  const bad = rows.filter((r) => r.state === 'warn').length;
  return html`<div class="ph-health" aria-busy=${busy}>
    <div class="ph-health-head">
      <div class="ph-health-sum">
        <span class=${`ph-sum-dot ${!st ? 'off' : bad ? 'warn' : 'ok'}`} aria-hidden="true"></span>
        <span>${!st ? (err ? 'Could not check the phone connection' : 'Checking the phone connection…') : bad ? `${bad} thing${bad > 1 ? 's' : ''} to fix for the phone` : 'Phone connection looks good'}</span>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" onClick=${() => load(true)} disabled=${busy} aria-label="Check again"><${Icon} name="refresh" size=${14} />${busy ? 'Checking…' : 'Check again'}</button>
    </div>
    ${err && html`<p class="ph-err" role="alert">${err}</p>`}
    ${!desktop && html`<${PushControl} />`}
    ${rows.length > 0 && html`<ul class="ph-list">
      ${rows.map((r) => html`<li key=${r.id} class=${`ph-item ${r.state}`} data-check=${r.id}>
        <span class="ph-ic" aria-hidden="true"><${Icon} name=${r.state === 'ok' ? 'check-circle' : r.state === 'warn' ? 'alert' : 'info'} size=${16} /></span>
        <div class="ph-body">
          <div class="ph-title">${r.title}</div>
          ${r.detail && html`<div class="ph-detail">${r.detail}</div>`}
          ${r.fix && html`<div class="ph-fix">${r.fix}${r.link ? html` <a href=${r.link} target="_blank" rel="noopener noreferrer">Open the DNS page</a>` : null}</div>`}
          ${r.cmd && html`<${CopyCmd} cmd=${r.cmd} />`}
          ${r.action && (desktop || !r.action.desktop) && html`<div class="ph-act">
            <button type="button" class=${`btn btn-sm${r.action.primary || (act[r.id] && act[r.id].confirming) ? ' btn-primary' : ''}`} data-action=${r.action.id} disabled=${!!(act[r.id] && act[r.id].busy)} onClick=${() => run(r)}>${act[r.id] && act[r.id].confirming ? `Yes, ${r.action.label.toLowerCase()}` : r.action.label}</button>
            ${act[r.id] && act[r.id].confirming && html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => setAct((m) => ({ ...m, [r.id]: null }))}>Cancel</button>`}
            ${act[r.id] && html`<span class=${`ph-act-msg${act[r.id].ok === false ? ' bad' : ''}`} role=${act[r.id].ok === false ? 'alert' : 'status'}>${act[r.id].busy && html`<span class="spinner" aria-hidden="true"></span>`}${act[r.id].msg}</span>`}
          </div>`}
          ${r.action && r.action.desktop && !desktop && html`<div class="ph-detail">${r.action.label}: in the desktop app, Settings, Phone.</div>`}
        </div>
      </li>`)}
    </ul>`}
  </div>`;
}
