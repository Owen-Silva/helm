// Owner: lane panels (E). Overnight queue: jobs that start a session when their time comes and the
// 5-hour budget allows. List + add/edit form + cancel/remove.
import { html, Icon, cx, fmtWhen, fmtAgo, fmtDuration, basename, shortModel, dotClass, Empty, Loading, SectionHead, useNow } from './util.js';
import { queue, settings, activeSession, sessions, usage, ready, rpc, selectSession, auth } from '../lib/store.js';
import { limitsOff, QUEUE_NO_GATE } from '../lib/usage-limits.js';   // lane prep-helm-auth-usage: no 5-hour/weekly limits (an API key) = no 5H gate (main/queue.js)
import { useState, useEffect } from 'preact/hooks';
import { ScheduledSection } from './scheduled.js';   // lane sched: in-session /loop + cron schedules, with Cancel

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES = [
  { value: 'bypassPermissions', label: 'Bypass permissions' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'default', label: 'Ask for permission' },
  { value: 'plan', label: 'Plan only' },
];
const FALLBACK_MODELS = [{ value: 'claude-opus-5-5', displayName: 'Opus 5.5' }];
const STATUS_LABEL = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const ORDER = { running: 0, queued: 1, failed: 2, done: 3, cancelled: 4 };

let modelsCache = null;
function useModels() {
  const [models, setModels] = useState(modelsCache || FALLBACK_MODELS);
  useEffect(() => {
    if (modelsCache) return;
    rpc('sessions.models', {}).then((m) => { if (Array.isArray(m) && m.length) { modelsCache = m; setModels(m); } }).catch(() => {});
  }, []);
  return models;
}

// datetime-local <-> epoch ms
function toLocalInput(ts) { const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
function tonight() { const d = new Date(); d.setHours(23, 0, 0, 0); if (d.getTime() < Date.now() + 10 * 60_000) d.setDate(d.getDate() + 1); return d.getTime(); }

function projectOptions() {
  const out = [];
  const seen = new Set();
  const add = (cwd, name) => { if (!cwd || seen.has(cwd.toLowerCase())) return; seen.add(cwd.toLowerCase()); out.push({ cwd, name: name || basename(cwd) }); };
  const a = activeSession.value;
  if (a) add(a.cwd, a.project);
  for (const p of settings.value?.projects || []) add(p.cwd, p.name);
  if (settings.value?.defaults?.cwd) add(settings.value.defaults.cwd);
  return out;
}

function JobForm({ job, onDone }) {
  const models = useModels();
  const projects = projectOptions();
  const d = settings.value?.defaults || {};
  const [f, setF] = useState(() => ({
    prompt: job?.prompt || '',
    cwd: job?.cwd || projects[0]?.cwd || '',
    model: job?.model || d.model || models[0]?.value || '',
    effort: job?.effort || d.effort || 'high',
    permissionMode: job?.permissionMode || d.permissionMode || 'bypassPermissions',
    when: job ? (job.runAfter ? 'at' : 'budget') : 'budget',
    runAfter: toLocalInput(job?.runAfter || tonight()),
    maxFiveHourPercent: job?.maxFiveHourPercent ?? 85,
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value });
  const noLimits = limitsOff(auth.value);
  const modelOpts = models.some((m) => m.value === f.model) ? models : [...models, { value: f.model, displayName: shortModel(f.model) }];

  const submit = async (e) => {
    e.preventDefault();
    if (!f.prompt.trim()) { setErr(new Error('Write the prompt the job should send.')); return; }
    if (!f.cwd) { setErr(new Error('Pick a project folder.')); return; }
    const runAfter = f.when === 'at' ? new Date(f.runAfter).getTime() : null;
    if (f.when === 'at' && !isFinite(runAfter)) { setErr(new Error('That start time is not a valid date.')); return; }
    const body = { prompt: f.prompt.trim(), cwd: f.cwd, model: f.model, effort: f.effort, permissionMode: f.permissionMode, runAfter, maxFiveHourPercent: +f.maxFiveHourPercent };
    setBusy(true); setErr(null);
    try { if (job) await rpc('queue.update', { id: job.id, ...body }); else await rpc('queue.add', body); onDone(); } catch (x) { setErr(x); } finally { setBusy(false); }
  };

  return html`<form class="pn-q-form" onSubmit=${submit}>
    <label class="pn-field">
      <span class="pn-field-label">Prompt</span>
      <textarea class="textarea pn-q-prompt" rows="4" placeholder="What should Claude do while you're away?" value=${f.prompt} onInput=${set('prompt')}
        onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e); }}></textarea>
    </label>
    <label class="pn-field">
      <span class="pn-field-label">Project</span>
      <select class="select" value=${f.cwd} onChange=${set('cwd')}>
        ${projects.map((p) => html`<option value=${p.cwd} title=${p.cwd}>${p.name}</option>`)}
      </select>
    </label>
    <div class="pn-q-grid">
      <label class="pn-field"><span class="pn-field-label">Model</span>
        <select class="select" value=${f.model} onChange=${set('model')}>${modelOpts.map((m) => html`<option value=${m.value}>${m.displayName || m.value}</option>`)}</select></label>
      <label class="pn-field"><span class="pn-field-label">Effort</span>
        <select class="select" value=${f.effort} onChange=${set('effort')}>${EFFORTS.map((x) => html`<option value=${x}>${x}</option>`)}</select></label>
      <label class="pn-field pn-q-span"><span class="pn-field-label">Permissions</span>
        <select class="select" value=${f.permissionMode} onChange=${set('permissionMode')}>${MODES.map((m) => html`<option value=${m.value}>${m.label}</option>`)}</select></label>
    </div>
    <fieldset class="pn-field pn-q-when">
      <legend class="pn-field-label">Start</legend>
      <div class="seg pn-q-seg" role="radiogroup" aria-label="Start">
        ${[['budget', noLimits ? 'As soon as possible' : 'When budget allows'], ['at', 'After a time']].map(([v, label]) => html`<button type="button" role="radio" aria-checked=${f.when === v} aria-pressed=${f.when === v}
          onClick=${() => setF({ ...f, when: v })}>${label}</button>`)}
      </div>
      ${f.when === 'at' && html`<input class="input" type="datetime-local" value=${f.runAfter} onInput=${set('runAfter')} />`}
    </fieldset>
    ${noLimits ? html`<div class="pn-q-nogate" role="note">${QUEUE_NO_GATE}</div>` : html`<label class="pn-field">
      <span class="pn-field-label pn-q-range-label"><span>Don't start above</span><span class="pn-num pn-strong">${f.maxFiveHourPercent}% of 5H</span></span>
      <input class="range" type="range" min="10" max="100" step="5" value=${f.maxFiveHourPercent} onInput=${set('maxFiveHourPercent')} />
    </label>`}
    ${err && html`<div class="pn-q-err" role="alert">${err.message || String(err)}</div>`}
    <div class="pn-q-actions">
      <button type="button" class="btn btn-ghost" onClick=${onDone}>Cancel</button>
      <button type="submit" class="btn btn-primary" disabled=${busy}>${busy ? 'Saving…' : job ? 'Save job' : 'Add to queue'}</button>
    </div>
  </form>`;
}

const isNum = (v) => typeof v === 'number' && isFinite(v);
const sentence = (s) => { const t = String(s || '').trim(); return t ? t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.') : ''; };

function whenText(j, fiveH, now, noLimits = false) {
  if (j.status === 'running') return isNum(j.startedAt) ? `Running for ${fmtDuration(now - j.startedAt, { seconds: false })}` : 'Running now';
  if (j.status === 'done' || j.status === 'failed') return isNum(j.endedAt) ? `${j.status === 'failed' ? 'Failed' : 'Finished'} ${fmtAgo(j.endedAt, now)}` : null;
  if (j.status !== 'queued') return null;
  if (noLimits) return j.runAfter ? `Not before ${fmtWhen(j.runAfter)}` : 'As soon as possible · no 5H gate with an API key';
  const limit = isNum(j.maxFiveHourPercent) ? j.maxFiveHourPercent : 85;
  const gate = `5H under ${limit}%`;
  if (j.runAfter) return `Not before ${fmtWhen(j.runAfter)} · ${gate}`;
  const cur = fiveH?.percent;
  return `When budget allows · ${gate}${!j.waitReason && isNum(cur) && cur >= limit ? ` (now ${Math.round(cur)}%)` : ''}`;
}

function JobRow({ job: j, onEdit, now }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const act = async (method, params) => { setBusy(true); setErr(null); try { await rpc(method, params); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const hasSession = j.sessionId && sessions.value.some((s) => s.id === j.sessionId);
  const when = whenText(j, usage.value?.fiveHour, now, limitsOff(auth.value));
  const kind = [shortModel(j.model), j.effort].filter(Boolean).join(' · ');
  return html`<li class=${cx('pn-q-job', `st-${j.status}`)}>
    <div class="pn-q-top">
      <span class=${cx('dot', dotClass(j.status), j.status === 'running' && 'live')}></span>
      <span class="pn-q-status">${STATUS_LABEL[j.status] || j.status || 'Unknown'}</span>
      ${j.cwd && html`<span class="pn-q-proj" title=${j.cwd}>${basename(j.cwd)}</span>`}
      ${kind && html`<span class="pn-q-model">${kind}</span>`}
    </div>
    <button class=${cx('pn-q-text', open && 'open')} onClick=${() => setOpen(!open)} aria-expanded=${open} title=${open ? 'Collapse' : 'Show the whole prompt'}>${j.prompt || ''}</button>
    ${when && html`<div class="pn-q-when-line pn-num">${when}</div>`}
    ${j.status === 'queued' && j.waitReason && html`<div class="pn-q-wait"><${Icon} name="clock" size=${13} /><span>${sentence(j.waitReason)}</span></div>`}
    ${j.summary && html`<div class="pn-q-summary">${j.summary}</div>`}
    ${err && html`<div class="pn-q-err" role="alert">${err.message || String(err)}</div>`}
    <div class="pn-q-row-actions">
      ${isNum(j.createdAt) ? html`<span class="pn-q-created pn-num">Added ${fmtAgo(j.createdAt, now)}</span>` : html`<span class="pn-q-created"></span>`}
      ${hasSession && html`<button class="btn btn-ghost sm" onClick=${() => selectSession(j.sessionId)}>Open session</button>`}
      ${j.status === 'queued' && html`<button class="btn btn-ghost sm" disabled=${busy} onClick=${() => onEdit(j)}>Edit</button>`}
      ${(j.status === 'queued' || j.status === 'running') && html`<button class="btn btn-ghost sm pn-q-danger" disabled=${busy}
          onClick=${() => act('queue.update', { id: j.id, status: 'cancelled' })}>Cancel</button>`}
      ${j.status !== 'queued' && j.status !== 'running' && html`<button class="btn btn-ghost sm" disabled=${busy}
          onClick=${() => act('queue.remove', { id: j.id })}>Remove</button>`}
    </div>
  </li>`;
}

export function QueuePanel() {
  const [editing, setEditing] = useState(null);   // null | 'new' | Job
  // Tick only while a running job shows its elapsed time.
  const now = useNow(30_000, (queue.value || []).some((j) => j.status === 'running' && isNum(j.startedAt)));
  if (!ready.value) return html`<div class="pn"><${Loading} label="Connecting…" /></div>`;
  const jobs = [...(queue.value || [])].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || (a.runAfter || 0) - (b.runAfter || 0) || b.createdAt - a.createdAt);
  const pending = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const past = jobs.filter((j) => !(j.status === 'queued' || j.status === 'running'));

  return html`<div class="pn pn-queue">
    <div class="pn-bar">
      <span class="pn-bar-grow pn-num"><span class="pn-strong">${pending.length} waiting</span><span class="pn-muted"> · ${past.length} finished</span></span>
      ${editing == null && html`<button class="btn btn-primary sm" onClick=${() => setEditing('new')}><${Icon} name="plus" size=${14} />New job</button>`}
    </div>
    <div class="pn-note">Jobs run only while Helm is running. Closing the window keeps it going in the tray; quitting from the tray stops the queue.</div>
    ${editing != null && html`<div class="pn-q-form-wrap">
      <${SectionHead} title=${editing === 'new' ? 'New job' : 'Edit job'} />
      <${JobForm} key=${editing === 'new' ? 'new' : editing.id} job=${editing === 'new' ? null : editing} onDone=${() => setEditing(null)} />
    </div>`}
    <${ScheduledSection} />
    ${jobs.length === 0 && editing == null && html`<${Empty} icon="queue" title="Nothing queued">
        ${limitsOff(auth.value) ? 'Queue a prompt to run tonight or as soon as Helm is free. Each job opens its own session and leaves a summary here.'
          : 'Queue a prompt to run tonight or whenever the 5-hour budget has room. Each job opens its own session and leaves a summary here.'}<//>`}
    ${pending.length > 0 && html`<${SectionHead} title="Up next" />
      <ul class="pn-q-list">${pending.map((j) => html`<${JobRow} key=${j.id} job=${j} now=${now} onEdit=${setEditing} />`)}</ul>`}
    ${past.length > 0 && html`<${SectionHead} title="Finished" />
      <ul class="pn-q-list">${past.map((j) => html`<${JobRow} key=${j.id} job=${j} now=${now} onEdit=${setEditing} />`)}</ul>`}
  </div>`;
}

