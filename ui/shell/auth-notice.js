// "Sessions can't start yet" notice, shown where a session would start (the composer, the New session
// dialog) while the host says auth is not ready (app.hello `auth` / account.changed: PROTOCOL "Account").
// Renders nothing when auth is ready or unknown (an older host), so that path looks exactly as before.
// It shows the host's reason. When sessions use Claude Code's own sign-in (provider 'claude-code'), the user signs
// in themselves in a terminal, so it adds Check again (account.status { refresh: true }) and looks again by itself
// when Helm comes back to the front, at most once per 10 s. Open Account settings scrolls to the Account section.
// Owner: lane opensource-auth.
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { auth, rpc, toast, setAuth } from '../lib/store.js';
import { go } from './state.js';

export function openAccountSettings() {
  go('settings');
  let tries = 30;
  const find = () => { const el = document.getElementById('set-account'); if (el) el.scrollIntoView({ block: 'start' }); else if (tries-- > 0) requestAnimationFrame(find); };
  requestAnimationFrame(find);
}

// One re-check at a time; the visibility re-check waits 10 s since the last one. The reply (and any
// account.changed) goes to store.js setAuth, so the notice goes away by itself once Claude Code is signed in.
const RECHECK_MS = 10_000;
let lastCheck = 0;
let inFlight = null;
function recheck({ quiet } = {}) {
  if (inFlight) return inFlight;
  lastCheck = Date.now();
  inFlight = rpc('account.status', { refresh: true })
    .then((x) => setAuth(x))
    .catch((e) => { if (!quiet) toast({ title: 'Could not check Claude Code\'s sign-in', kind: 'error', error: e }); })
    .finally(() => { inFlight = null; });
  return inFlight;
}
function onVisible() {
  if (document.visibilityState !== 'visible') return;
  const a = auth.value;
  if (!a || a.ready !== false || a.provider !== 'claude-code') return;
  if (Date.now() - lastCheck < RECHECK_MS) return;
  recheck({ quiet: true });
}
try { document.addEventListener('visibilitychange', onVisible); } catch {}

export function AuthNotice({ onOpen } = {}) {
  const a = auth.value;
  if (!a || a.ready !== false) return null;
  const cc = a.provider === 'claude-code';
  return html`<div class="auth-need" role="status" data-state="auth-required">
    <${Icon} name="key" size=${14} />
    <span class="auth-need-text">${a.reason || (cc ? "Sessions can't start until Claude Code on this PC is signed in. Open a terminal, run `claude`, and sign in there." : 'Sessions cannot start until Helm has a way to reach Claude. Open Settings > Account.')}</span>
    ${cc && html`<button type="button" class="btn btn-sm auth-need-btn" data-act="auth-check" onClick=${() => recheck()}>Check again</button>`}
    <button type="button" class="btn btn-sm auth-need-btn" data-act="auth-open-account"
      onClick=${() => { if (onOpen) onOpen(); openAccountSettings(); }}>Open Account settings</button>
  </div>`;
}
