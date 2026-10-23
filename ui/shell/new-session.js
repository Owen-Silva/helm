// New session dialog. Owner: lane shell (C).
// Launch presets (lane presets): a row of chips at the top fills the whole form in one click
// (folder, model, effort, permissions, first prompt). "Save as preset" stores the current form in
// settings.presets (max 20, main/settings.js validates); "Manage" renames or deletes them.
// newSessionOpen.value may be true, or { cwd?, model?, effort?, permissionMode?, prompt?, presetId?, worktree? } to prefill
// (worktree: true opens with "Run it in its own git worktree" on: palette "New session in a worktree", Worktrees panel)
// ("Start another like this" passes a session's settings, the palette passes a presetId).
import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { settings, saveSettings, createSession, rpc, toast, appInfo } from '../lib/store.js';
import { newSessionOpen, view, phoneScreen } from './state.js';
import { cx, Modal, useModels, EFFORTS, MODES, mod, effortLabel, modeLabel } from './util.js';
import { WorktreeSection, launchInWorktree, nameProblem } from './worktrees.js';   // lane helm-worktrees (H4)
import { plainError } from '../lib/plain-error.js';
import { AuthNotice } from './auth-notice.js';   // lane opensource-auth

const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
export const MAX_PRESETS = 20;
const NAME_MAX = 80;
const newId = () => 'pr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// "Shop · X-High · Bypass": what a preset launches, for chip titles and the palette.
export function presetDetail(p) {
  return [base(p.cwd), effortLabel(p.effort), modeLabel(p.permissionMode)].filter(Boolean).join(' · ');
}

// Open the dialog filled from a preset id, or from a session ("Start another like this").
export function openPreset(id) { newSessionOpen.value = { presetId: id }; }
export function openLike(s) {
  newSessionOpen.value = { cwd: s.cwd, model: s.model, effort: s.effort, permissionMode: s.permissionMode };
}

async function savePresets(list, what) {
  try { await saveSettings({ presets: list }); return true; }
  catch (e) { toast({ title: `Preset not ${what}`, error: e, kind: 'error' }); return false; }
}

// Esc inside an inline editor cancels that editor, not the whole dialog. This mounts with the dialog and
// child effects run before the Modal's, so the capture listener is registered first and can stop the
// Modal's Esc handler; `active` is read through a ref so the listener never has to be re-added.
function useEscCancels(active, ref, onCancel) {
  const live = useRef({ active, onCancel });
  live.current = { active, onCancel };
  useEffect(() => {
    const key = (e) => {
      if (e.key !== 'Escape' || !live.current.active || !ref.current?.contains(document.activeElement)) return;
      e.preventDefault(); e.stopImmediatePropagation(); live.current.onCancel();
    };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  }, []);
}

function PresetBar({ presets, form, apply, appliedId }) {
  const [saving, setSaving] = useState(false);     // inline "name this preset" field
  const [managing, setManaging] = useState(false);
  const [name, setName] = useState('');
  const box = useRef(null);
  const full = presets.length >= MAX_PRESETS;
  useEscCancels(saving || managing, box, () => { setSaving(false); setManaging(false); });

  const startSave = () => {
    const cur = presets.find((p) => p.id === appliedId);
    setName(cur ? cur.name : [base(form.cwd), effortLabel(form.effort)].filter(Boolean).join(' ').slice(0, NAME_MAX));
    setManaging(false); setSaving(true);
    requestAnimationFrame(() => { const i = box.current?.querySelector('.np-name'); i?.focus(); i?.select(); });
  };
  const commitSave = async (typed) => {
    const n = String(typeof typed === 'string' ? typed : name).trim();
    if (!n) return;
    if (!form.cwd.trim()) { toast({ title: 'Choose a project folder first', ms: 3000 }); return; }
    const fields = { name: n, cwd: form.cwd.trim(), model: form.model, effort: form.effort, permissionMode: form.mode,
      ...(form.prompt.trim() ? { prompt: form.prompt } : {}) };
    const same = presets.find((p) => p.name.toLowerCase() === n.toLowerCase());
    if (!same && full) { toast({ title: `${MAX_PRESETS} presets is the limit`, body: 'Delete one under Manage first.', kind: 'error' }); return; }
    const id = same ? same.id : newId();
    const list = same ? presets.map((p) => (p.id === same.id ? { id, ...fields } : p)) : [...presets, { id, ...fields }];
    if (await savePresets(list, 'saved')) {
      setSaving(false);
      apply({ id, ...fields }, false);
      toast({ title: same ? `Preset “${n}” updated` : `Preset “${n}” saved`, ms: 2500 });
    }
  };

  if (!presets.length && !saving) {
    return html`<div class="np" ref=${box}>
      <button class="btn btn-ghost np-save-first" data-act="preset-save" onClick=${startSave} title="Keep this folder, model, effort, permissions and prompt as a one-click preset">
        <${Icon} name="bookmark" size=${15} />Save as preset</button>
    </div>`;
  }
  return html`<div class="np" ref=${box}>
    <div class="np-head">
      <span class="field-label">Presets</span>
      <span class="grow"></span>
      ${presets.length > 0 && !saving && html`<button class="btn btn-ghost np-link" data-act="preset-manage" aria-pressed=${managing}
        onClick=${() => setManaging((m) => !m)}>${managing ? 'Done' : 'Manage'}</button>`}
      ${!managing && !saving && html`<button class="btn btn-ghost np-link" data-act="preset-save" onClick=${startSave}
        disabled=${full && !presets.some((p) => p.id === appliedId)} title=${full ? `${MAX_PRESETS} presets is the limit: delete one under Manage` : 'Save the form below as a preset'}>
        <${Icon} name="bookmark" size=${14} />Save as preset</button>`}
    </div>
    ${saving && html`<div class="np-saverow">
      <input class="input np-name" value=${name} maxlength=${NAME_MAX} placeholder="Preset name" aria-label="Preset name" spellcheck="false"
        onInput=${(e) => setName(e.currentTarget.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); commitSave(e.currentTarget.value); } }} />
      <button class="btn" onClick=${() => setSaving(false)}>Cancel</button>
      <button class="btn btn-primary" data-act="preset-save-confirm" disabled=${!name.trim()} onClick=${commitSave}>
        ${presets.some((p) => p.name.toLowerCase() === name.trim().toLowerCase()) ? 'Update' : 'Save'}</button>
    </div>`}
    ${managing
      ? html`<ul class="np-manage">${presets.map((p) => html`<${ManageRow} key=${p.id} p=${p} presets=${presets} />`)}</ul>`
      : presets.length > 0 && html`<div class="np-chips" role="list" aria-label="Launch presets">
        ${presets.map((p) => html`<button key=${p.id} role="listitem" class=${cx('chip np-chip', p.id === appliedId && 'on')} aria-pressed=${p.id === appliedId}
            data-preset=${p.id} title=${`${presetDetail(p)}\n${p.cwd}${p.prompt ? `\nPrompt: ${p.prompt.slice(0, 120)}` : ''}`} onClick=${() => apply(p, true)}>
          <span class="truncate">${p.name}</span></button>`)}
      </div>`}
  </div>`;
}

function ManageRow({ p, presets }) {
  const [val, setVal] = useState(p.name);
  useEffect(() => setVal(p.name), [p.name]);
  // reads the field itself: a blur right after typing can beat the re-render that updates `val`
  const rename = async (e) => {
    const n = String(e?.currentTarget?.value ?? val).trim();
    if (!n || n === p.name) { setVal(p.name); return; }
    if (await savePresets(presets.map((x) => (x.id === p.id ? { ...x, name: n } : x)), 'renamed')) toast({ title: `Renamed to “${n}”`, ms: 2000 });
    else setVal(p.name);
  };
  const del = async () => {
    if (await savePresets(presets.filter((x) => x.id !== p.id), 'deleted')) toast({ title: `Preset “${p.name}” deleted`, ms: 2500 });
  };
  return html`<li class="np-row" data-preset=${p.id}>
    <input class="input np-rename" value=${val} maxlength=${NAME_MAX} aria-label=${`Rename preset ${p.name}`} spellcheck="false"
      onInput=${(e) => setVal(e.currentTarget.value)} onBlur=${rename}
      onKeyDown=${(e) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); } }} />
    <span class="np-row-detail truncate" title=${p.cwd}>${presetDetail(p)}</span>
    <button class="icon-btn np-del" aria-label=${`Delete preset ${p.name}`} title="Delete preset" onClick=${del}><${Icon} name="trash" size=${15} /></button>
  </li>`;
}

export function NewSessionDialog() {
  const st = settings.value || {};
  const presets = Array.isArray(st.presets) ? st.presets : [];
  const open = typeof newSessionOpen.value === 'object' && newSessionOpen.value ? newSessionOpen.value : {};
  const fromPreset = open.presetId ? presets.find((p) => p.id === open.presetId) : null;
  const init = fromPreset || open;
  const d = st.defaults || {};
  const projects = st.projects || [];
  const models = useModels(rpc);
  const [cwd, setCwd] = useState(init.cwd || projects[0]?.cwd || d.cwd || '');
  const [model, setModel] = useState(init.model || d.model || 'claude-opus-5-5');
  const [effort, setEffort] = useState(init.effort || d.effort || 'high');
  const [mode, setMode] = useState(init.permissionMode || d.permissionMode || 'default');
  const [prompt, setPrompt] = useState(init.prompt || '');
  const [appliedId, setAppliedId] = useState(fromPreset?.id || null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // lane helm-worktrees: the worktree part (worktrees.js); `made` = a worktree already created by a try that failed later
  const [wt, setWt] = useState({ on: !!open.worktree, name: '', base: '', deps: 'none' });
  const [wtInfo, setWtInfo] = useState(null);
  const [made, setMade] = useState(null);
  const [step, setStep] = useState('');
  useEffect(() => { setMade(null); }, [cwd]);
  const canBrowse = appInfo.value.platform === 'electron';
  const close = () => { newSessionOpen.value = false; };
  // a hand edit after applying a preset un-highlights its chip
  const edit = (fn) => (v) => { fn(v); setAppliedId(null); };

  const apply = (p, focus) => {
    setCwd(p.cwd || ''); if (p.model) setModel(p.model); if (p.effort) setEffort(p.effort); if (p.permissionMode) setMode(p.permissionMode);
    setPrompt(p.prompt || ''); setAppliedId(p.id); setErr('');
    if (focus) requestAnimationFrame(() => document.querySelector('.newsess .ns-prompt')?.focus());
  };

  const browse = async () => {
    try { const r = await rpc('files.pickFolder', {}); if (r?.path) edit(setCwd)(r.path); }
    catch (e) { setErr(`Folder picker unavailable here (${e.message}). Type the path instead.`); }
  };
  const create = async () => {
    if (!cwd.trim()) { setErr('Choose a project folder first.'); return; }
    if (wt.on && !made) {
      if (!wtInfo) { setErr('Helm has not read this folder as a git repo yet (see the worktree part above).'); return; }
      const bad = nameProblem(wt.name, wtInfo.taken);
      if (bad) { setErr(bad); return; }
    }
    setBusy(true); setErr('');
    let dir = cwd.trim();
    try {
      if (wt.on) {
        const r = made || await launchInWorktree({ cwd: dir, ...wt, info: wtInfo }, setStep);
        setMade(r); dir = r.path; setStep('Starting the session…');
      }
      await createSession({ cwd: dir, model, effort, permissionMode: mode, ...(prompt.trim() ? { prompt: prompt.trim() } : {}) });
      view.value = 'session'; phoneScreen.value = 'session';
      close();
    } catch (e) {
      if (e && e.made) { setMade(e.made); setErr(`${plainError(e).text} The worktree itself is ready at ${e.made.path}: Start in the worktree opens the session there without dependencies.`); }
      else setErr(wt.on ? plainError(e).text : (e.message || String(e)));
      setStep(''); setBusy(false);
    }
  };
  const onKey = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); create(); } };
  // a preset's model may not be in the list the CLI reports (renamed / retired): keep it selectable
  const modelOpts = models.length ? (models.some((m) => m.value === model) ? models : [...models, { value: model, displayName: model }]) : [{ value: model, displayName: model }];

  return html`<${Modal} title="New session" onClose=${close} width=${560} class="newsess"
    footer=${html`
      <span class="hint">${mod}+Enter to start</span>
      <span class="grow"></span>
      <button class="btn btn-ghost" onClick=${close}>Cancel</button>
      <button class="btn btn-primary" disabled=${busy} onClick=${create}>${busy ? html`<span class="spinner sm"></span>` : html`<${Icon} name="arrow-right" size=${15} />`}${made ? 'Start in the worktree' : wt.on ? 'Create worktree and start' : 'Start session'}</button>`}>
    <div class="ns" onKeyDown=${onKey}>
      <${AuthNotice} onOpen=${close} />
      <${PresetBar} presets=${presets} form=${{ cwd, model, effort, mode, prompt }} apply=${apply} appliedId=${appliedId} />

      <div class="field">
        <span class="field-label">Project</span>
        ${projects.length > 0 && html`<div class="ns-projects" role="listbox" aria-label="Recent projects">
          ${projects.map((p) => html`<button key=${p.cwd} role="option" aria-selected=${p.cwd === cwd}
              class=${cx('ns-proj', p.cwd === cwd && 'on')} onClick=${() => edit(setCwd)(p.cwd)} title=${p.cwd}>
            <${Icon} name=${p.cwd === cwd ? 'folder-open' : 'folder'} size=${16} />
            <span class="ns-proj-text"><span class="ns-proj-name truncate">${p.name || base(p.cwd)}</span><span class="ns-proj-path mono truncate">${p.cwd}</span></span>
            ${p.cwd === cwd && html`<${Icon} name="check" size=${15} class="ns-proj-check" />`}
          </button>`)}
        </div>`}
        <div class="ns-path">
          <input class="input mono" value=${cwd} placeholder="C:\\path\\to\\project" aria-label="Project folder path" spellcheck="false"
            onInput=${(e) => { edit(setCwd)(e.currentTarget.value); setErr(''); }} />
          ${canBrowse && html`<button class="btn" onClick=${browse}><${Icon} name="folder-open" size=${15} />Browse…</button>`}
        </div>
      </div>

      <${WorktreeSection} cwd=${cwd} value=${wt} busy=${busy} onInfo=${setWtInfo} onChange=${(v) => { setWt(v); setMade(null); setErr(''); }} />

      <div class="ns-row">
        <label class="field">
          <span class="field-label">Model</span>
          <select class="select ns-model" value=${model} onChange=${(e) => edit(setModel)(e.currentTarget.value)}>
            ${modelOpts.map((m) => html`<option value=${m.value}>${m.displayName || m.value}</option>`)}
          </select>
        </label>
        <label class="field">
          <span class="field-label">Permissions</span>
          <select class="select ns-mode" value=${mode} onChange=${(e) => edit(setMode)(e.currentTarget.value)}>
            ${MODES.map((m) => html`<option value=${m.value}>${m.label} · ${m.long}</option>`)}
          </select>
        </label>
      </div>

      <div class="field">
        <span class="field-label">Effort</span>
        <div class="seg ns-effort" role="radiogroup" aria-label="Effort">
          ${EFFORTS.map((e) => html`<button role="radio" aria-checked=${effort === e.value} aria-pressed=${effort === e.value} onClick=${() => edit(setEffort)(e.value)}>${e.label}</button>`)}
        </div>
      </div>

      <label class="field">
        <span class="field-label">First prompt <span class="faint">(optional)</span></span>
        <textarea class="textarea ns-prompt" rows="3" value=${prompt} placeholder="What should Claude start on?" autofocus
          onInput=${(e) => edit(setPrompt)(e.currentTarget.value)}></textarea>
      </label>

      ${step && html`<p class="wt-note" role="status"><span class="spinner sm"></span>${step}</p>`}
      ${err && html`<p class="ns-err" role="alert"><${Icon} name="alert" size=${14} />${err}</p>`}
    </div>
  <//>`;
}
