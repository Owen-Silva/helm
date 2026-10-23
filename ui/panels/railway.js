// Railway panel: live deploy status for every Railway project on the user's account, with Redeploy and
// Restart per service, each behind a confirm (PROTOCOL "Railway"). Data: ui/lib/railway.js (store) and
// ui/lib/railway-model.js (pure words). Styles: ./railway.css. Owner: lane railway.
import { html, Icon, cx, useNow, Loading, Empty, SectionHead, Modal } from './util.js';
import { useState } from 'preact/hooks';
import { railwayState, railwayRpcError, useRailwayWatch, pingRailway, railwayAct } from '../lib/railway.js';
import { stateLine, svcTone, projectSummary, actionFor, actionRunning, confirmCopy, metaLine, fmtFor } from '../lib/railway-model.js';

export function RailwayPanel() {
  useRailwayWatch('panel');
  const v = railwayState.value;
  const rpcErr = railwayRpcError.value;
  const [ask, setAsk] = useState(null);   // { kind, svc } while the confirm is open
  const busyNow = !!(v && ((v.projects || []).some((p) => p.services.some((s) => svcTone(s) === 'busy')) || (v.actions || []).some(actionRunning)));
  const now = useNow(busyNow ? 1000 : 15_000, true);

  let body;
  if (!v && rpcErr) {
    body = html`<div class="pn-rw-err" role="alert">
      <div class="pn-rw-err-title">Railway status is unavailable</div>
      <div class="pn-rw-err-detail mono">${rpcErr.message || String(rpcErr)}</div>
      <button type="button" class="btn sm" onClick=${() => pingRailway('panel', true)}>Try again</button>
    </div>`;
  } else if (!v) {
    body = html`<${Loading} label="Asking Railway…" />`;
  } else if (v.mode === 'off') {
    body = html`<${Empty} icon="server" title="Railway is off in this run">${v.offReason}<//>`;
  } else if (!v.projects) {
    body = v.error ? null : html`<${Loading} label="Asking Railway…" />`;
  } else if (!v.projects.length) {
    body = html`<${Empty} icon="server" title="No Railway projects">The Railway CLI is signed in but sees no projects on this account.<//>`;
  } else {
    body = v.projects.map((p) => html`<section class="pn-rw-proj" key=${p.id}>
      <${SectionHead} title=${p.name}>${projectSummary(p)}<//>
      <div class="pn-rw-list">
        ${p.services.map((s) => html`<${ServiceRow} key=${s.key} svc=${{ ...s, project: p.name }} v=${v} now=${now} onAsk=${(kind, svc) => setAsk({ kind, svc })} />`)}
      </div>
    </section>`);
  }

  const err = v && v.error;
  return html`<div class="pn-rw">
    <div class="pn-rw-top">
      <span class="pn-rw-meta">${metaLine(v, now)}</span>
      <button type="button" class="icon-btn pn-rw-refresh" aria-label="Check Railway now" title="Check Railway now"
        disabled=${!v || v.mode === 'off' || v.fetching} onClick=${() => pingRailway('panel', true)}>
        <${Icon} name="refresh" size=${14} class=${cx(v && v.fetching && 'pn-rw-spin')} />
      </button>
    </div>
    ${err && html`<div class="pn-rw-err" role="alert">
      <div class="pn-rw-err-title">${err.message}</div>
      ${err.detail && html`<div class="pn-rw-err-detail mono">${err.detail}</div>`}
      ${v.projects && v.fetchedAt && html`<div class="pn-rw-err-note">Showing the last good status, from ${fmtFor(now - v.fetchedAt)} ago.</div>`}
      <button type="button" class="btn sm" disabled=${v.fetching} onClick=${() => pingRailway('panel', true)}>${v.fetching ? 'Checking…' : 'Try again'}</button>
    </div>`}
    ${v && v.warning && html`<div class="pn-rw-warn" role="status">Railway answered with a warning: <span class="mono">${v.warning}</span></div>`}
    ${v && v.mode !== 'off' && !v.canAct && v.actReason && html`<div class="pn-rw-warn" role="status">${v.actReason}</div>`}
    ${body}
    ${ask && html`<${ConfirmAction} kind=${ask.kind} svc=${ask.svc} onClose=${() => setAsk(null)} />`}
  </div>`;
}

function ServiceRow({ svc, v, now, onAsk }) {
  const tone = svcTone(svc);
  const a = actionFor(v, svc.key, now);
  const running = actionRunning(a);
  const off = !v.canAct;
  const why = (kind) => (off ? v.actReason || 'Actions are off' : running ? 'An action is running for this service' : kind === 'redeploy' ? svc.redeployWhy : svc.restartWhy);
  const btn = (kind, label, can) => html`<button type="button" class="btn sm pn-rw-btn" data-act=${`railway-${kind}`}
      disabled=${off || running || !can} title=${(off || running || !can) ? why(kind) || '' : `${label} ${svc.name}${svc.prod ? ' (production)' : ''}`}
      onClick=${() => onAsk(kind, svc)}>${label}</button>`;
  return html`<div class=${cx('pn-rw-row', `t-${tone}`)} data-status=${svc.status}>
    <span class="pn-rw-dot" aria-hidden="true"></span>
    <div class="pn-rw-main">
      <div class="pn-rw-name"><span class="pn-rw-svc">${svc.name}</span>${!svc.prod && svc.environment && html`<span class="pn-rw-env">${svc.environment}</span>`}</div>
      <div class="pn-rw-state">${stateLine(svc, now)}</div>
      ${svc.olderLive && html`<div class="pn-rw-note">Previous deploy still serving</div>`}
      ${a && html`<div class=${cx('pn-rw-act', `a-${a.state}`)} role="status">${running && html`<span class="spinner sm" aria-hidden="true"></span>`}${a.message}</div>`}
    </div>
    <div class="pn-rw-btns">
      ${btn('redeploy', 'Redeploy', svc.canRedeploy)}
      ${btn('restart', 'Restart', svc.canRestart)}
    </div>
  </div>`;
}

function ConfirmAction({ kind, svc, onClose }) {
  const c = confirmCopy(kind, svc);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await railwayAct(kind, svc); onClose(); } catch (e) { setErr((e && e.message) || String(e)); setBusy(false); }
  };
  const footer = html`<button type="button" class="btn btn-ghost" onClick=${onClose} disabled=${busy}>Cancel</button>
    <button type="button" class=${cx('btn', svc.prod ? 'btn-danger' : 'btn-primary')} data-act="railway-confirm" onClick=${go} disabled=${busy}>
      ${busy ? (kind === 'redeploy' ? 'Redeploying…' : 'Restarting…') : c.button}</button>`;
  return html`<${Modal} title=${c.title} onClose=${busy ? undefined : onClose} footer=${footer}>
    <div class="pn-rw-cf">
      <dl class="pn-rw-cf-rows">${c.rows.map(([k, val]) => html`<div><dt>${k}</dt><dd>${val}</dd></div>`)}</dl>
      ${c.prodLine && html`<p class="pn-rw-cf-prod">${c.prodLine}</p>`}
      <p class="pn-rw-cf-note">${c.body}</p>
      ${err && html`<p class="pn-rw-cf-err" role="alert">${err}</p>`}
    </div>
  <//>`;
}
