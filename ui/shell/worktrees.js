// Worktrees (lane helm-worktrees, 2026-10-14; backlog H4): a session in its own git worktree.
//   WorktreeSection  the "Run it in its own git worktree" part of the New session dialog: name, base branch,
//                    and for a repo with node_modules, Copy dependencies (a real copy) or Install (npm ci).
//   launchInWorktree worktrees.create, then worktrees.deps; the dialog then starts the session in the new folder.
//   WorktreesSheet   the Worktrees panel for one repo: each worktree's branch, ahead/behind its base, dirty flag,
//                    last commit and the sessions in it; Open session, Merge into <base>, Remove (inline confirms).
// The host (main/worktrees.js) decides every refusal and says why in plain words; this file shows those words,
// before the click where it can (list carries merge.why) and after it through plainError (feedback: no silent
// failures). A junctioned node_modules is never made here, and Remove takes links out first on the host.
import { signal } from '@preact/signals';
import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from '../lib/html.js';
import { Icon } from '../lib/icons.js';
import { rpc, toast, sessions } from '../lib/store.js';
import { plainError } from '../lib/plain-error.js';
import { newSessionOpen, openSession } from './state.js';
import { cx, Modal } from './util.js';

export const worktreesFor = signal(null);   // null | cwd: the Worktrees panel is open for that folder's repo
export function openWorktrees(cwd) { if (cwd) worktreesFor.value = cwd; }
// "New session in a worktree": the New session dialog with the worktree part switched on
export function newInWorktree(cwd) { newSessionOpen.value = { ...(cwd ? { cwd } : {}), worktree: true }; }

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const sep = (p) => (String(p).includes('\\') ? '\\' : '/');
const join = (a, b) => `${String(a).replace(/[\\/]+$/, '')}${sep(a)}${b}`;
export function mb(bytes) {
  if (bytes == null) return '';
  const m = bytes / (1024 * 1024);
  return m >= 1024 ? `${(m / 1024).toFixed(1)} GB` : m >= 10 ? `${Math.round(m)} MB` : `${m.toFixed(1)} MB`;
}
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return m < 60 ? `${m}m ago` : h < 24 ? `${h}h ago` : `${d}d ago`;
}
const errToast = (title, e) => toast({ title, error: e, kind: 'error', ...(e?.data?.git ? { details: e.data.git } : {}) });

// The name's problem in plain words, or '' when it is fine (the host checks again).
export function nameProblem(name, taken = []) {
  const n = String(name || '').trim();
  if (!n) return 'Give the worktree a name.';
  if (!NAME_RE.test(n) || /\.\.|\.lock$|\.$/.test(n)) return 'Use letters, numbers, dots, dashes or underscores (up to 48, starting with a letter or number).';
  if (taken.includes(`wk/${n}`)) return `The branch wk/${n} already exists. Pick another name.`;
  return '';
}

// What the dependencies choice starts as: Copy when the host says the copy is small enough, else Install.
export function defaultDeps(d) {
  if (!d || !d.exists) return 'none';
  if (d.suggest === 'copy' && d.copyable) return 'copy';
  return d.install ? 'install' : 'none';
}

// ---- the New session dialog's worktree part ----
// value: { on, name, base, deps }  onChange(next)  info: the worktrees.info result (loaded here, reported up)
export function WorktreeSection({ cwd, value, onChange, onInfo, busy }) {
  const [info, setInfo] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const v = value || {};
  const vRef = useRef(v);
  vRef.current = v;
  const set = (patch) => onChange({ ...v, ...patch });
  useEffect(() => {
    const dir = String(cwd || '').trim();
    setInfo(null); setLoadErr(''); onInfo?.(null);
    if (!dir || !v.on) return undefined;
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      rpc('worktrees.info', { cwd: dir }).then((i) => {
        if (n !== seq.current) return;
        setInfo(i); onInfo?.(i); setLoading(false);
        // fill the base (the folder's own branch) and the deps default once per repo
        const cur = vRef.current;
        onChange({ ...cur, base: cur.base && i.branches.includes(cur.base) ? cur.base : (i.currentBranch || i.branches[0] || ''), deps: defaultDeps(i.deps) });
      }, (e) => { if (n === seq.current) { setLoadErr(plainError(e).text); setLoading(false); } });
    }, 250);
    return () => clearTimeout(t);
  }, [cwd, v.on]);

  const problem = v.on && info ? nameProblem(v.name, info.taken) : '';
  const d = info?.deps;
  return html`<div class=${cx('wt-sec', v.on && 'on')}>
    <label class="wt-toggle">
      <input type="checkbox" checked=${!!v.on} disabled=${busy} onChange=${(e) => set({ on: e.currentTarget.checked })} />
      <span class="wt-toggle-text"><span class="wt-toggle-title"><${Icon} name="git-branch" size=${14} />Run it in its own git worktree</span>
        <span class="wt-toggle-sub">A new branch in its own folder, so this session's edits stay out of your other work.</span></span>
    </label>
    ${v.on && html`<div class="wt-body">
      ${loading && !info && html`<p class="wt-note"><span class="spinner sm"></span>Reading the repo…</p>`}
      ${loadErr && html`<p class="wt-err" role="alert"><${Icon} name="alert" size=${14} />${loadErr}</p>`}
      ${info && html`
        <div class="wt-row">
          <label class="field">
            <span class="field-label">Name</span>
            <div class="wt-name"><span class="wt-prefix mono">wk/</span>
              <input class="input mono wt-name-input" value=${v.name || ''} placeholder="fix-login" maxlength="48" spellcheck="false" disabled=${busy}
                aria-label="Worktree name" aria-invalid=${!!(v.name && problem)} onInput=${(e) => set({ name: e.currentTarget.value.replace(/\s+/g, '-') })} /></div>
          </label>
          <label class="field">
            <span class="field-label">Base branch</span>
            <select class="select wt-base" value=${v.base || ''} disabled=${busy} onChange=${(e) => set({ base: e.currentTarget.value })}>
              ${info.branches.map((b) => html`<option value=${b}>${b}${b === info.currentBranch ? ' (current)' : ''}</option>`)}
            </select>
          </label>
        </div>
        ${v.name && problem && html`<p class="wt-err" role="alert"><${Icon} name="alert" size=${14} />${problem}</p>`}
        <p class="wt-where mono truncate" title=${join(info.wtDir, v.name || '<name>')}>${join(info.wtDir, v.name || '<name>')}</p>
        ${d && d.exists && html`<div class="field">
          <span class="field-label">Dependencies <span class="faint">(node_modules${d.bytes != null ? `, ${mb(d.bytes)}${d.partial ? '+' : ''}` : ''})</span></span>
          <div class="seg wt-deps" role="radiogroup" aria-label="Dependencies">
            <button role="radio" aria-checked=${v.deps === 'copy'} aria-pressed=${v.deps === 'copy'} disabled=${busy || !d.copyable} onClick=${() => set({ deps: 'copy' })}>Copy dependencies (real copy)</button>
            ${d.install && html`<button role="radio" aria-checked=${v.deps === 'install'} aria-pressed=${v.deps === 'install'} disabled=${busy} onClick=${() => set({ deps: 'install' })}>Install (${d.install})</button>`}
            <button role="radio" aria-checked=${v.deps === 'none'} aria-pressed=${v.deps === 'none'} disabled=${busy} onClick=${() => set({ deps: 'none' })}>None</button>
          </div>
          <span class="wt-note">${!d.copyable ? d.why
            : v.deps === 'copy' ? 'A real, separate copy: never a link, so removing the worktree can never delete the original.'
            : v.deps === 'install' ? `Runs ${d.install} in the new folder. It can take a few minutes.${d.suggest === 'install' && d.copyable ? ` (Copy is off by default: ${d.partial ? 'too many files to measure quickly' : `${mb(d.bytes)} is large`}.)` : ''}`
            : 'No node_modules in the worktree. Anything that needs packages will fail until you install them.'}</span>
        </div>`}`}
    </div>`}
  </div>`;
}

// create + deps. onStep(text) shows progress. Throws the host's error with .made = the new folder once it exists.
export async function launchInWorktree({ cwd, name, base, deps, info }, onStep = () => {}) {
  onStep('Creating the worktree…');
  const made = await rpc('worktrees.create', { cwd, name: String(name).trim(), base });
  if (deps === 'copy' || deps === 'install') {
    onStep(deps === 'copy' ? `Copying dependencies${info?.deps?.bytes ? ` (${mb(info.deps.bytes)})` : ''}…` : `Running ${info?.deps?.install || 'npm ci'}…`);
    const from = info?.deps?.source ? info.deps.source.replace(/[\\/]node_modules$/, '') : undefined;
    try { await rpc('worktrees.deps', { path: made.path, mode: deps, ...(deps === 'copy' && from ? { from } : {}) }); }
    catch (e) { e.made = made; throw e; }
  }
  return made;
}

// ---- the Worktrees panel ----
export function WorktreesSheet() {
  const cwd = worktreesFor.value;
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const close = () => { worktreesFor.value = null; };
  const load = async () => {
    setLoading(true);
    try { setData(await rpc('worktrees.list', { cwd })); setErr(null); }
    catch (e) { setErr(plainError(e)); }
    setLoading(false);
  };
  useEffect(() => { setData(null); load(); }, [cwd]);
  const rows = data?.worktrees || [];
  return html`<${Modal} title="Worktrees" onClose=${close} width=${780} class="wt-sheet"
    footer=${html`
      <span class="hint truncate">${data ? html`<span class="mono">${data.wtDir}</span>` : ''}</span>
      <span class="grow"></span>
      <button class="btn btn-ghost" onClick=${close}>Close</button>
      <button class="btn btn-primary" disabled=${!data} onClick=${() => { close(); newInWorktree(data.root); }}><${Icon} name="plus" size=${15} />New worktree</button>`}>
    <div class="wt-panel">
      <div class="wt-head">
        <span class="wt-repo"><${Icon} name="folder" size=${16} /><span class="wt-repo-name">${data?.name || '…'}</span>
          <span class="mono faint truncate" title=${data?.root || cwd}>${data?.root || cwd}</span></span>
        <span class="grow"></span>
        <button class="icon-btn" aria-label="Refresh" title="Refresh" disabled=${loading} onClick=${load}>${loading ? html`<span class="spinner sm"></span>` : html`<${Icon} name="refresh" size=${15} />`}</button>
      </div>
      ${err && html`<p class="wt-err" role="alert"><${Icon} name="alert" size=${14} />${err.text}</p>`}
      ${!data && !err && html`<p class="wt-note"><span class="spinner sm"></span>Reading worktrees…</p>`}
      <ul class="wt-list">${rows.map((w) => html`<${WorktreeRow} key=${w.path} w=${w} root=${data.root} reload=${load} />`)}</ul>
      ${data && rows.length === 1 && html`<p class="wt-note">No worktrees yet. New worktree makes one beside ${data.name}, in ${data.wtDir}.</p>`}
    </div>
  <//>`;
}

function WorktreeRow({ w, root, reload }) {
  const [confirm, setConfirm] = useState(null);   // null | 'merge' | 'merge2' | 'remove'
  const [discard, setDiscard] = useState(false);
  const [delBranch, setDelBranch] = useState(w.ahead === 0);
  const [busy, setBusy] = useState(false);
  const [rowErr, setRowErr] = useState('');
  useEffect(() => { setDelBranch(w.ahead === 0); }, [w.ahead]);
  const live = (w.sessions || []).filter((s) => s.status !== 'closed');
  const all = (w.sessions || []).map((s) => sessions.value.find((x) => x.id === s.id) || s);
  const openHere = () => {
    worktreesFor.value = null;
    if (live.length) openSession(live[0].id); else newSessionOpen.value = { cwd: w.path };
  };
  const doMerge = async (confirmRestart) => {
    setBusy(true); setRowErr('');
    try {
      const r = await rpc('worktrees.merge', { path: w.path, ...(confirmRestart ? { confirmRestart: true } : {}) });
      toast({ title: `Merged ${r.branch} into ${r.base}`, body: r.kind === 'ff' ? `Fast-forward: ${r.base} is now at ${r.head}.` : `Merge commit ${r.head} on ${r.base}.${r.restartsHelm ? ' Helm restarts once nothing is running.' : ''}`, kind: 'ok' });
      setConfirm(null); reload();
    } catch (e) {
      if (e?.code === 'confirm_restart') { setConfirm('merge2'); }
      else { setRowErr(plainError(e).text); errToast(e?.code === 'protected' ? 'Merge refused: production' : 'Merge refused', e); }
    }
    setBusy(false);
  };
  const doRemove = async () => {
    setBusy(true); setRowErr('');
    try {
      const r = await rpc('worktrees.remove', { path: w.path, cwd: root, discard, deleteBranch: delBranch });
      const bits = [r.linksRemoved?.length ? `Took out ${r.linksRemoved.length} link${r.linksRemoved.length === 1 ? '' : 's'} first; the folders they pointed to are untouched.` : '',
        r.branchDeleted ? `Deleted the branch ${r.branch}.` : r.branchKept || (r.branch ? `The branch ${r.branch} is kept.` : '')].filter(Boolean);
      toast({ title: `Removed ${w.name}`, body: bits.join(' '), kind: 'ok' });
      setConfirm(null); reload();
    } catch (e) { setRowErr(plainError(e).text); errToast('Worktree not removed', e); }
    setBusy(false);
  };
  const m = w.merge || {};
  const mergeLabel = w.base ? `Merge into ${w.base}` : 'Merge';
  const flags = [
    w.main && html`<span class="chip wt-chip">main folder</span>`,
    w.missing && html`<span class="chip warn wt-chip">folder missing</span>`,
    w.locked && html`<span class="chip warn wt-chip" title=${w.locked}>locked</span>`,
    w.dirty > 0 && html`<span class="chip warn wt-chip">${w.dirty} changed</span>`,
    w.dirty === 0 && html`<span class="chip ok wt-chip">clean</span>`,
    w.statusError && html`<span class="chip danger wt-chip" title=${w.statusError}>status unknown</span>`,
    w.nodeModules === 'link' && html`<span class="chip warn wt-chip" title="node_modules here is a link (junction). Remove takes the link out first, so the folder it points to is never touched.">node_modules is a link</span>`,
  ].filter(Boolean);
  return html`<li class=${cx('wt-item', w.main && 'main', confirm && 'confirming')} data-wt=${w.name}>
    <div class="wt-top">
      <div class="wt-id">
        <span class="wt-name-l">${w.name}</span>
        <span class="wt-branch mono"><${Icon} name="git-branch" size=${13} />${w.branch || (w.detached ? `detached ${w.head || ''}` : '(no branch)')}</span>
        ${flags}
      </div>
      <div class="wt-actions">
        <button class="btn btn-sm" disabled=${w.missing} onClick=${openHere}><${Icon} name=${live.length ? 'message' : 'plus'} size=${14} />${live.length ? 'Open session' : 'New session here'}</button>
        ${!w.main && html`<button class="btn btn-sm" data-act="merge" disabled=${busy || !m.can} title=${m.why || ''} onClick=${() => setConfirm(confirm === 'merge' ? null : 'merge')}><${Icon} name=${m.protected ? 'lock' : 'arrow-right'} size=${14} />${mergeLabel}</button>
          <button class="btn btn-sm btn-ghost wt-remove" data-act="remove" disabled=${busy} onClick=${() => { setDiscard(false); setConfirm(confirm === 'remove' ? null : 'remove'); }}><${Icon} name="trash" size=${14} />Remove</button>`}
      </div>
    </div>
    <div class="wt-meta">
      ${!w.main && w.base && w.ahead != null && html`<span class="tnum">${w.ahead} ahead · ${w.behind} behind <span class="mono">${w.base}</span></span>`}
      ${w.lastCommit && html`<span class="wt-commit truncate" title=${w.lastCommit.subject}><span class="mono faint">${w.lastCommit.hash}</span> ${w.lastCommit.subject}<span class="faint"> · ${ago(w.lastCommit.ts)}</span></span>`}
    </div>
    <div class="wt-path mono faint truncate" title=${w.path}>${w.path}</div>
    ${all.length > 0 && html`<div class="wt-sessions">${all.map((s) => html`<button key=${s.id} class="chip wt-sess" title="Open this session" onClick=${() => { worktreesFor.value = null; openSession(s.id); }}>
      <span class=${cx('dot', s.status)}></span><span class="truncate">${s.title || 'New session'}</span>${s.status === 'closed' ? html`<span class="faint"> · closed</span>` : null}</button>`)}</div>`}
    ${!w.main && !m.can && m.why && !confirm && html`<p class=${cx('wt-why', m.protected && 'prot')}><${Icon} name=${m.protected ? 'shield' : 'info'} size=${13} />${m.why}</p>`}
    ${confirm === 'merge' && html`<div class="wt-confirm" role="group" aria-label="Confirm merge">
      <p>${m.kind === 'ff' ? html`Fast-forward <span class="mono">${w.base}</span> to <span class="mono">${w.branch}</span> (${w.ahead} commit${w.ahead === 1 ? '' : 's'}). No merge commit is needed.`
        : html`Merge <span class="mono">${w.branch}</span> into <span class="mono">${w.base}</span> with a merge commit (${w.base} has ${w.behind} commit${w.behind === 1 ? '' : 's'} this branch does not).`}</p>
      ${m.restartsHelm && html`<p class="wt-warn"><${Icon} name="alert" size=${14} />Merging into Helm's own master restarts Helm and stops running sessions.</p>`}
      <div class="wt-confirm-btns"><button class="btn btn-sm btn-ghost" onClick=${() => setConfirm(null)}>Cancel</button>
        <button class="btn btn-sm btn-primary" data-act="merge-go" disabled=${busy} onClick=${() => (m.restartsHelm ? setConfirm('merge2') : doMerge(false))}>${busy ? html`<span class="spinner sm"></span>` : null}Merge</button></div>
    </div>`}
    ${confirm === 'merge2' && html`<div class="wt-confirm danger" role="alertdialog" aria-label="Confirm Helm restart">
      <p class="wt-warn"><${Icon} name="alert" size=${14} /><span><strong>Second confirm.</strong> Merging into Helm's own master restarts Helm and stops running sessions. Their transcripts are kept.</span></p>
      <div class="wt-confirm-btns"><button class="btn btn-sm btn-ghost" onClick=${() => setConfirm(null)}>Cancel</button>
        <button class="btn btn-sm btn-danger" data-act="merge-restart" disabled=${busy} onClick=${() => doMerge(true)}>${busy ? html`<span class="spinner sm"></span>` : null}Merge and restart Helm</button></div>
    </div>`}
    ${confirm === 'remove' && html`<div class="wt-confirm" role="group" aria-label="Confirm remove">
      <p>Remove the folder <span class="mono">${w.path}</span>?${w.nodeModules === 'link' ? ' Its node_modules is a link: Helm takes the link out first, so the folder it points to is never touched.' : ''}</p>
      ${w.dirty > 0 && html`<label class="wt-check"><input type="checkbox" checked=${discard} onChange=${(e) => setDiscard(e.currentTarget.checked)} />Discard changes <span class="faint">(${w.dirty} uncommitted; they will be lost)</span></label>`}
      ${w.branch && html`<label class="wt-check"><input type="checkbox" checked=${delBranch} onChange=${(e) => setDelBranch(e.currentTarget.checked)} />Also delete the branch <span class="mono">${w.branch}</span> <span class="faint">${w.ahead === 0 ? '(merged)' : '(only if merged; kept otherwise)'}</span></label>`}
      ${w.dirty > 0 && !discard && html`<p class="wt-why"><${Icon} name="info" size=${13} />It has uncommitted changes, so Remove needs "Discard changes" ticked.</p>`}
      ${live.length > 0 && html`<p class="wt-why"><${Icon} name="info" size=${13} />${live.length === 1 ? `"${live[0].title}" is` : `${live.length} sessions are`} still open here; close ${live.length === 1 ? 'it' : 'them'} first.</p>`}
      <div class="wt-confirm-btns"><button class="btn btn-sm btn-ghost" onClick=${() => setConfirm(null)}>Cancel</button>
        <button class="btn btn-sm btn-danger" data-act="remove-go" disabled=${busy || (w.dirty > 0 && !discard)} onClick=${doRemove}>${busy ? html`<span class="spinner sm"></span>` : null}Remove</button></div>
    </div>`}
    ${rowErr && html`<p class="wt-err" role="alert"><${Icon} name="alert" size=${14} />${rowErr}</p>`}
  </li>`;
}
