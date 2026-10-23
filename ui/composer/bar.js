// The composer's bottom row: attach, screenshot, mic (voice.js), model / effort / permission pickers, snippets,
// queued chip, context % + cost, send/stop. Owner: lane composer.
// Controls are the shell's .btn / .icon-btn / .chip primitives; composer.css only adds modifiers.
import { html } from '../lib/html.js';
import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks';
import { settings, updateSession, saveSettings, toast } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { Popover, Opt } from './popover.js';
import { models, loadModels, modelLabel, EFFORTS, PERMS, permLabel, isPhone, isTouch } from './util.js';
import { CapturePicker, canCapture } from './capture.js';
import { MicButton } from './voice.js';

function Picker({ name, open, setOpen, label, title, icon, children, wide }) {
  const btn = useRef(null);
  const isOpen = open === name;
  const iconOnly = icon && label == null;
  return html`<span class="cmp-pick">
    <button type="button" ref=${btn} class=${(iconOnly ? 'icon-btn cmp-icon' : 'btn btn-ghost sm cmp-btn') + (isOpen ? ' on' : '')}
      aria-haspopup="menu" aria-expanded=${isOpen ? 'true' : 'false'} title=${title} aria-label=${label == null ? title : `${title}: ${label}`}
      onClick=${() => setOpen(isOpen ? null : name)}>
      ${icon}
      ${label != null && html`<span class="cmp-btn-label">${label}</span>`}
      ${label != null && html`<${Icon} name="chevron-down" size=${12} class="cmp-caret" />`}
    </button>
    ${isOpen && html`<${Popover} anchorRef=${btn} onClose=${() => setOpen(null)} label=${title} wide=${wide}>${children}<//>`}
  </span>`;
}

function SnippetMenu({ text, onInsert, close }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef(null);
  const list = settings.value?.snippets || [];
  const body = text.trim();
  useEffect(() => { if (naming) inputRef.current?.focus(); }, [naming]);

  const save = async () => {
    const n = name.trim() || body.split('\n')[0].slice(0, 28);
    const sn = { id: 'sn_' + Date.now().toString(36), name: n, text: body };
    try {
      await saveSettings({ snippets: [...list, sn] });
      toast({ title: 'Snippet saved', body: n, ms: 2500 });
      close(true);
    } catch (e) {
      toast({ title: 'Could not save snippet', error: e, kind: 'error' });
    }
  };

  return html`
    ${list.length
      ? list.map((sn) => html`<${Opt} radio=${false} label=${sn.name} desc=${sn.text} onClick=${() => { onInsert(sn.text); close(false); }} />`)
      : html`<div class="cmp-pop-empty">No snippets yet</div>`}
    <div class="menu-sep" />
    ${naming
      ? html`<form class="cmp-snip-form" onSubmit=${(e) => { e.preventDefault(); save(); }}>
          <input ref=${inputRef} class="input sm" placeholder="Snippet name" value=${name} maxlength="60"
            onInput=${(e) => setName(e.currentTarget.value)} aria-label="Snippet name" />
          <button type="submit" class="btn btn-primary sm">Save</button>
        </form>`
      : html`<${Opt} radio=${false} icon=${html`<${Icon} name="plus" size=${15} />`} label="Save as snippet"
          desc=${body ? null : 'Type something first'} disabled=${!body} onClick=${() => setNaming(true)} />`}
  `;
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// lane voice: the mic made the row ~32 px wider, so in a narrow desktop composer (Helm's default 1280 window
// with the sidebar and inspector open: ~482 px inside the row) the right-hand group dropped to a second line.
// Below this inner width the row is marked data-tight and composer.css trims its gaps and paddings by
// that much (only while the mic is there); wider rows, the phone and touch screens never change.
const TIGHT_PX = 524;
function useTight(ref) {
  const [tight, setTight] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const check = () => {
      if (isPhone.value || isTouch()) { setTight(false); return; }
      const cs = getComputedStyle(el);
      setTight(el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) < TIGHT_PX);
    };
    const ro = new ResizeObserver(check);
    ro.observe(el);
    check();
    return () => ro.disconnect();
  }, []);
  return tight;
}

export function Bar({ s, voice, text, hasContent, working, shell = false, onSend, onStop, onAttach, onInsert, refocus }) {
  const [open, setOpen] = useState(null);
  const barRef = useRef(null);
  const tight = useTight(barRef);
  useEffect(() => { loadModels(); }, []);
  useEffect(() => { setOpen(null); }, [s?.id]);
  // Screenshot button: desktop bridge only (mock-capture.js installs its fake one asynchronously in ?mock=1)
  const [capOk, setCapOk] = useState(canCapture);
  const [capOpen, setCapOpen] = useState(false);
  useEffect(() => {
    if (capOk) return;
    const on = () => setCapOk(canCapture());
    addEventListener('helm:native-ready', on);
    return () => removeEventListener('helm:native-ready', on);
  }, [capOk]);

  const close = (focus) => { setOpen(null); if (focus) refocus(); };
  const set = (fields) => {
    close(true);
    updateSession(s.id, fields).catch((e) => toast({ title: 'Could not change the session', error: e, kind: 'error' }));
  };

  // Unknown context / cost stay hidden, never 0 or NaN. The engine creates a session with
  // costUsd: 0 and only learns the real figure from the turn's result (Claude Code reports no
  // running cost mid-turn), so a 0 means "not known yet": hide it rather than show a fake $0.00.
  const pctRaw = finite(s?.context?.percent);
  const pct = pctRaw == null ? null : Math.max(0, Math.min(100, Math.round(pctRaw)));
  const costRaw = finite(s?.costUsd);
  const cost = costRaw == null || costRaw <= 0 ? null : costRaw < 0.01 ? '<$0.01' : '$' + costRaw.toFixed(2);
  const ctxTok = finite(s?.context?.usedTokens), ctxWin = finite(s?.context?.windowTokens);
  const metaTip = [pct != null && `Context ${pct}% used${ctxTok != null && ctxWin ? ` (${ctxTok.toLocaleString()} of ${ctxWin.toLocaleString()} tokens, as of Claude's latest reply)` : ''}`,
    cost && `session cost ${cost} (Claude Code's own total for this conversation, all days)`].filter(Boolean).join(' · ');
  const queued = finite(s?.queued) || 0;
  // lane steer: Send is only ever Send (a message mid-turn reaches Claude at its next step). Stop is its own
  // button, apart from Send, shown while a turn runs; it asks first when agents would stop with it.
  const showStop = working && !shell;
  const mlist = models.value.length ? models.value : [{ value: s.model, displayName: modelLabel(s.model) }];

  return html`<div class="cmp-bar" ref=${barRef} data-tight=${tight ? '' : undefined}>
    <div class="cmp-tools">
      <button type="button" class="icon-btn cmp-icon" title="Attach files" aria-label="Attach files" onClick=${onAttach}><${Icon} name="paperclip" size=${16} /></button>
      ${capOk && !isPhone.value && html`<button type="button" class=${'icon-btn cmp-icon cmp-cam' + (capOpen ? ' on' : '')} title="Attach a screenshot" aria-label="Attach a screenshot"
        aria-haspopup="dialog" onClick=${() => { setOpen(null); setCapOpen(true); }}><${Icon} name="camera" size=${16} /></button>`}
      ${voice && html`<${MicButton} voice=${voice} disabled=${!s} />`}
      ${capOpen && html`<${CapturePicker} onClose=${() => { setCapOpen(false); refocus(); }} />`}
      <${Picker} name="model" open=${open} setOpen=${setOpen} title="Model" label=${modelLabel(s.model)} wide>
        ${mlist.map((m) => html`<${Opt} checked=${m.value === s.model} label=${m.displayName} desc=${m.description} onClick=${() => set({ model: m.value })} />`)}
      <//>
      <${Picker} name="effort" open=${open} setOpen=${setOpen} title="Effort" label=${s.effort || 'Effort'}>
        ${EFFORTS.map((x) => html`<${Opt} checked=${x.value === s.effort} label=${x.value} desc=${x.desc} onClick=${() => set({ effort: x.value })} />`)}
      <//>
      <${Picker} name="perm" open=${open} setOpen=${setOpen} title="Permissions" label=${permLabel(s.permissionMode)} wide>
        ${PERMS.map((x) => html`<${Opt} checked=${x.value === s.permissionMode} label=${x.label} desc=${x.desc} onClick=${() => set({ permissionMode: x.value })} />`)}
      <//>
      <${Picker} name="snip" open=${open} setOpen=${setOpen} title="Snippets" icon=${html`<${Icon} name="snippet" size=${16} />`} wide>
        <${SnippetMenu} text=${text} onInsert=${onInsert} close=${close} />
      <//>
    </div>
    <div class="cmp-end">
      ${queued > 0 && html`<span class="chip cmp-queued" title="Prompts waiting for the current turn to finish">${queued} queued</span>`}
      ${(pct != null || cost) && html`<span class="cmp-meta" title=${metaTip}>
        ${pct != null && html`<span class="cmp-meta-ctx">${pct}% context</span>`}
        ${pct != null && cost && html`<span class="cmp-meta-sep" aria-hidden="true" />`}
        ${cost && html`<span>${cost}</span>`}
      </span>`}
      ${showStop && html`<button type="button" class="cmp-stop" data-act="stop" title="Stop this turn (asks first if agents are running)" aria-label="Stop this turn" onClick=${onStop}>
        <${Icon} name="stop" size=${12} /><span class="cmp-stop-label">Stop</span>
      </button>`}
      <button type="button" class="cmp-send" disabled=${!hasContent}
        title=${shell ? 'Run command (Enter)' : working ? 'Send: Claude reads it at its next step (Enter)' : 'Send (Enter)'} aria-label=${shell ? 'Run command' : 'Send'}
        onClick=${onSend}>
        <span class="cmp-send-face">${shell ? html`<${Icon} name="play" size=${14} />` : html`<${Icon} name="arrow-up" size=${16} />`}</span>
      </button>
    </div>
  </div>`;
}
