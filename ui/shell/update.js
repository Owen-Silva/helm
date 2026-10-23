// Restart + updates (PROTOCOL "Restart + updates"): Settings > Helm (running commit, update ready + why it
// is waiting, Restart Helm, the auto-restart toggle) and the quiet "Update ready" chip in the top strip
// (phone: above the list). Owner: lane restart.
import { signal } from '@preact/signals';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { settings, saveSettings, toast, updateState, restartingNow, restartHelm, cancelRestartWhenIdle } from '../lib/store.js';
import { go, isPhone } from './state.js';
import { cx, ago } from './util.js';

// What a restart now would cut off, once the user pressed Restart and main said "busy" (the confirm).
export const restartConfirm = signal(null);   // null | { reasons: [string], kept: [string] } (kept: lane detach)

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const failed = (e) => toast({ title: 'Helm did not restart', error: e, kind: 'error' });

// Restart now; if something would be cut off, show the confirm (Settings > Helm) instead.
export async function requestRestart({ fromChip = false } = {}) {
  try {
    const r = await restartHelm({ confirmKept: true });
    if (r && r.reasons) {
      restartConfirm.value = { reasons: r.reasons, kept: r.kept || [] };
      if (fromChip) openHelmSettings();
    }
  } catch (e) { failed(e); }
}
async function restartAnyway() {
  restartConfirm.value = null;
  try { await restartHelm({ force: true }); } catch (e) { failed(e); }
}
// lane restart: the default answer to "Helm is still working": wait for it, then restart (UpdateState.deferred).
export async function restartWhenFinished() {
  restartConfirm.value = null;
  try {
    const r = await restartHelm({ whenIdle: true });
    if (r && r.deferred) toast({ title: 'Helm restarts when it finishes', body: `Waiting for: ${(r.reasons || []).join(' · ')}`, ms: 7000 });
  } catch (e) { failed(e); }
}
export async function cancelWhenFinished() {
  try { await cancelRestartWhenIdle(); } catch (e) { toast({ title: 'Could not cancel the restart', error: e, kind: 'error' }); }
}

export function openHelmSettings() {
  go('settings');
  let tries = 30;
  const find = () => { const el = document.getElementById('set-helm'); if (el) el.scrollIntoView({ block: 'start' }); else if (tries-- > 0) requestAnimationFrame(find); };
  requestAnimationFrame(find);
}

function Commit({ c }) {
  return html`<span class="upd-commit"><span class="mono">${c.short || '—'}</span>${c.subject ? html`<span class="upd-subj">${c.subject}</span>` : null}</span>`;
}

// Settings > Helm
export function UpdateSettings() {
  const u = updateState.value;
  const run = u && u.running;
  const p = u && u.pending;
  const auto = settings.value.autoRestart !== false;
  const conf = restartConfirm.value;
  const going = restartingNow.value;
  const d = u && u.deferred; // lane restart: "Restart when finished" is waiting
  const extra = p && p.commits && p.commits.length > 1 ? p.commits.length - 1 : 0;
  return html`
    <div class="set-row">
      <div class="set-row-label"><span>Running</span>
        <span class="hint">${run && run.startedAt ? `Started ${clock(run.startedAt)} (${ago(run.startedAt)})` : 'Started —'}${run && run.branch ? ` · ${run.branch}` : ''}</span></div>
      <div class="set-row-ctl upd-ctl">${run && run.sha ? html`<${Commit} c=${run} />` : html`<span class="hint">Not a git checkout: updates are not detected</span>`}</div>
    </div>
    ${p && html`<div class="set-row upd-ready" data-phase=${p.phase}>
      <div class="set-row-label"><span><span class="upd-dot" aria-hidden="true"></span>Update ready</span>
        <span class="hint upd-why">${p.phase === 'restarting' ? 'Restarting…' : !auto ? 'Restart to load it' : p.reason || 'Restarts when idle'}</span></div>
      <div class="set-row-ctl upd-ctl"><${Commit} c=${(p.commits && p.commits[0]) || p} />${extra ? html`<span class="hint">+${extra} more</span>` : null}</div>
    </div>`}
    <div class=${cx('set-row', conf && 'stack')}>
      <div class="set-row-label"><span>Restart Helm</span>
        <span class="hint">${d && !going ? html`<span class="upd-dot" aria-hidden="true"></span>Restarts when finished · ${d.reason || 'waiting'}`
          : 'Quits and reopens to load updates. Anything still running stops, so Helm offers to wait for it.'}</span></div>
      <div class="set-row-ctl">
        ${going ? html`<span class="hint upd-going"><span class="spinner sm"></span>Restarting…</span>`
          : d ? html`<button class="btn btn-sm" data-act="restart-cancel-wait" onClick=${cancelWhenFinished}>Don't restart</button>`
            : html`<button class="btn btn-sm" data-act="restart-helm" disabled=${!!conf} onClick=${() => requestRestart()}><${Icon} name="refresh" size=${14} />Restart Helm</button>`}
      </div>
      ${conf && !going && !d && !conf.reasons.length && html`<div class="upd-confirm" role="alertdialog" aria-label="Sessions keep running through the restart">
        <p><strong>Kept running through the restart:</strong> ${conf.kept.join(' · ')}. Helm restarts around them and re-attaches; nothing is stopped.</p>
        <div class="upd-confirm-btns">
          <button class="btn btn-sm" onClick=${() => { restartConfirm.value = null; }}>Cancel</button>
          <button class="btn btn-sm" data-act="restart-when-finished" onClick=${restartWhenFinished}>Restart when finished</button>
          <button class="btn btn-sm btn-primary" data-act="restart-anyway" onClick=${restartAnyway}>Restart now</button>
        </div>
      </div>`}
      ${conf && !going && !d && conf.reasons.length > 0 && html`<div class="upd-confirm" role="alertdialog" aria-label="Helm is still working">
        <p><strong>Helm is still working:</strong> ${conf.reasons.join(' · ')}. Restarting now stops all of it; each session it cuts off then lists what stopped, with Continue.${conf.kept && conf.kept.length ? ` Kept running through it: ${conf.kept.join(' · ')}.` : ''}</p>
        <div class="upd-confirm-btns">
          <button class="btn btn-sm" onClick=${() => { restartConfirm.value = null; }}>Cancel</button>
          <button class="btn btn-sm btn-danger" data-act="restart-anyway" onClick=${restartAnyway}>Restart now</button>
          <button class="btn btn-sm btn-primary" data-act="restart-when-finished" onClick=${restartWhenFinished}>Restart when finished</button>
        </div>
      </div>`}
    </div>
    <div class="set-row">
      <div class="set-row-label"><span>Restart automatically when Helm updates</span>
        <span class="hint">After a new commit, once nothing is running and you have not used Helm for 2 minutes.</span></div>
      <div class="set-row-ctl"><button class="toggle" role="switch" aria-checked=${auto} aria-label="Restart automatically when Helm updates"
        onClick=${() => saveSettings({ autoRestart: !auto }).catch((e) => toast({ title: 'Setting not saved', error: e, kind: 'error' }))}></button></div>
    </div>`;
}

// The quiet chip: only while an update is pending (or a restart is under way).
export function UpdateChip() {
  const u = updateState.value;
  const p = u && u.pending;
  const d = u && u.deferred; // lane restart: "Restart when finished" is waiting
  const going = restartingNow.value || (p && p.phase === 'restarting') || (d && d.phase === 'restarting');
  if (!p && !d && !going) return null;
  const auto = !u || u.autoRestart !== false;
  const why = going ? 'Helm is restarting' : d ? `Restarts when finished · ${d.reason || 'waiting'}` : p.reason || '';
  const phone = isPhone.value;
  return html`<div class=${cx('upd-chip', phone && 'phone')} role="status" title=${why}>
    ${going ? html`<span class="spinner sm"></span><span>Restarting…</span>` : d ? html`
      <span class="upd-dot" aria-hidden="true"></span>
      <button class="upd-chip-open" onClick=${openHelmSettings} aria-label=${why}>Restarts when finished<span class="upd-chip-sub">${` · ${(d.reasons && d.reasons[0]) || 'confirming'}${d.reasons && d.reasons.length > 1 ? ` +${d.reasons.length - 1}` : ''}`}</span></button>
      <button class="upd-chip-act" data-act="restart-cancel-wait" onClick=${cancelWhenFinished}>Cancel</button>` : html`
      <span class="upd-dot" aria-hidden="true"></span>
      <button class="upd-chip-open" onClick=${openHelmSettings} aria-label=${`Update ready. ${why}`}>Update ready${auto ? html`<span class="upd-chip-sub">${' · restarts when idle'}</span>` : null}</button>
      <button class="upd-chip-act" data-act="restart-now" onClick=${() => requestRestart({ fromChip: true })}>Restart now</button>`}
  </div>`;
}
