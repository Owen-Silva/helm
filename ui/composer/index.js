// Owner: lane composer. Exports Composer: the prompt input for the active session.
// Enter sends (Shift+Enter newline); mid-turn a message reaches Claude at its next step and never stops anything.
// Esc only closes a menu (or leaves `!` mode); stopping is the separate Stop button (ui/lib/stop.js). Up/Down on an
// empty box walk this session's prompt history. Paste/drop images, @file and /command menus,
// model / effort / permission pickers, snippets. Drafts persist per session (helm.draft.<id>).
// `!` at the start = shell mode: Enter runs the command in the session folder (sessions.shell),
// Esc / Backspace at the start leaves it, Up/Down walk earlier `!` commands; menus are off.
// Window events: 'helm:composer-insert' { detail: { text, mode? } } inserts at the cursor (or appends);
// 'helm:composer-attach' { detail: { attachments } } adds image attachments; 'helm:composer-focus'.
// Voice input (./voice.js, lane voice): the mic in the tool row or Ctrl+M (tap = start / stop, hold = push-to-talk,
// Esc discards); the text lands at the caret like the 'word' insert mode and is never sent by itself.
import { html } from '../lib/html.js';
import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks';
import { activeSession, activeId, sessions, send, rpc, toast, noteAttachments, noteDraft } from '../lib/store.js';
import { stopTurn } from '../lib/stop.js';
import { Icon } from '../lib/icons.js';
import { Bar } from './bar.js';
import { AutoMenu } from './menu.js';
import { useVoice, VoiceStatus } from './voice.js';
import { AuthNotice } from '../shell/auth-notice.js';   // lane opensource-auth: no API key = say so here
import {
  isPhone, isTouch, loadDraft, saveDraft, loadHistory, pushHistory, readDataUrl, fmtBytes, uid,
  getCommands, filterCommands, normFile, detectToken,
} from './util.js';

const FILE_LIMIT = 512 * 1024;          // non-image attach limit when there is no native path
const IMAGE_LIMIT = 20 * 1024 * 1024;

const quotePath = (p) => (/\s/.test(p) ? `"${p}"` : p);
// A draft that starts with `!` is a shell command (sessions.shell), not a prompt.
const splitDraft = (d) => (typeof d === 'string' && d.startsWith('!') ? { shell: true, text: d.slice(1) } : { shell: false, text: d || '' });
const folderName = (s) => s?.project || String(s?.cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'this folder';
const desktop = () => !isTouch() && !isPhone.value;

// `sid`: the session this composer sends to (split view renders one per pane); default = the active session.
export function Composer({ sid: forSid = null } = {}) {
  const s = forSid ? sessions.value.find((x) => x.id === forSid) || null : activeSession.value;
  const id = s?.id || null;
  const working = s?.status === 'working';

  const taRef = useRef(null);
  const fileRef = useRef(null);
  const [text, setText] = useState(() => splitDraft(loadDraft(id)).text);
  // Shell mode (`!`): the box holds the command without its `!`; the draft keeps the `!`.
  const [shell, setShellState] = useState(() => splitDraft(loadDraft(id)).shell);
  const [atts, setAtts] = useState([]);
  // lane restart: drafts are saved per keystroke, attachments are not, so main holds an auto-restart while any are unsent
  const attsKey = useRef(null);
  if (!attsKey.current) attsKey.current = {};
  useEffect(() => { noteAttachments(attsKey.current, atts.length); }, [atts.length]);
  useEffect(() => () => noteAttachments(attsKey.current, 0), []);
  const [menu, setMenu] = useState(null);
  const [drag, setDrag] = useState(false);

  const textRef = useRef(text); textRef.current = text;
  const shellRef = useRef(shell); shellRef.current = shell;
  const idRef = useRef(id); idRef.current = id;
  const caretRef = useRef(null);                 // caret to place after the next render
  const histRef = useRef({ idx: -1, list: [] });
  const suppressRef = useRef(null);              // token key the user closed with Esc
  const seqRef = useRef(0);
  const timerRef = useRef(0);

  const focusTa = () => taRef.current?.focus({ preventScroll: true });

  const setBox = (v, caret) => {
    textRef.current = v;
    setText(v);
    saveDraft(idRef.current, (shellRef.current ? '!' : '') + v);
    if (caret != null) caretRef.current = caret;
  };

  // Enter / leave shell mode (keeps what is typed; popups off while in it).
  const setShell = (on, v = textRef.current, caret = null) => {
    shellRef.current = on;
    setShellState(on);
    histRef.current = { idx: -1, list: [] };
    closeMenu(false);
    setBox(v, caret);
  };

  // ---- session switch: restore draft, drop attachments, focus (desktop) ----
  useEffect(() => {
    const { text: d, shell: sh } = splitDraft(loadDraft(id));
    shellRef.current = sh;
    setShellState(sh);
    textRef.current = d;
    setText(d);
    setAtts([]);
    closeMenu(false);
    histRef.current = { idx: -1, list: [] };
    caretRef.current = null;
    if (id && desktop() && (!forSid || id === activeId.value)) {   // split: only the focused pane grabs focus
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        focusTa();
        const n = ta.value.length;
        ta.setSelectionRange(n, n);
      });
    }
  }, [id]);

  // ---- autosize + pending caret ----
  // (The on-screen keyboard is handled by the shell: .app.phone follows visualViewport via --vvh.)
  const autosize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const vh = window.visualViewport?.height || innerHeight;
    const corner = forSid ? ta.closest('.quad > .main') : null;   // lane quad: a corner is a quarter of the window
    const max = Math.round(corner ? Math.min(vh * 0.4, corner.clientHeight * 0.3) : vh * 0.4);
    const h = Math.min(ta.scrollHeight, max);
    ta.style.height = h + 'px';
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
  };
  useLayoutEffect(() => {
    autosize();
    const ta = taRef.current;
    if (ta && caretRef.current != null) {
      const c = Math.min(caretRef.current, ta.value.length);
      caretRef.current = null;
      ta.setSelectionRange(c, c);
    }
  }, [text, id]);
  useEffect(() => { addEventListener('resize', autosize); return () => removeEventListener('resize', autosize); }, []);

  // lane quad: in a corner, the @ / slash menu (it opens upward) gets only the room between the card and the
  // corner's top edge (--cmp-ac-room, used by shell.css .quad .cmp-ac), so it never runs out of the corner.
  const colRef = useRef(null);
  useLayoutEffect(() => {
    const col = colRef.current;
    if (!col) return;
    const corner = menu && forSid ? col.closest('.quad > .main') : null;
    if (!corner) { col.style.removeProperty('--cmp-ac-room'); return; }
    const room = col.getBoundingClientRect().top - corner.getBoundingClientRect().top - 12;
    col.style.setProperty('--cmp-ac-room', `${Math.max(80, Math.round(room))}px`);
  }, [!!menu]);

  // ---- menus ----
  function closeMenu(suppress) {
    seqRef.current++;
    clearTimeout(timerRef.current);
    setMenu((m) => { if (suppress && m) suppressRef.current = m.kind + ':' + m.start; return null; });
  }

  function runDetect(v, caret) {
    const tok = s ? detectToken(v, caret) : null;
    if (!tok) { suppressRef.current = null; closeMenu(false); return; }
    if (suppressRef.current === tok.kind + ':' + tok.start) return;
    suppressRef.current = null;
    const seq = ++seqRef.current;
    clearTimeout(timerRef.current);
    if (tok.kind === 'cmd') {
      const sid = s.id;
      getCommands(sid).then((all) => {
        if (seq !== seqRef.current) return;
        setMenu({ kind: 'cmd', start: 0, q: tok.q, items: filterCommands(all, tok.q), active: 0 });
      }).catch(() => { if (seq === seqRef.current) setMenu(null); });
      return;
    }
    setMenu((m) => (m && m.kind === 'file' && m.start === tok.start ? { ...m, q: tok.q } : { kind: 'file', start: tok.start, q: tok.q, items: null, active: 0 }));
    const cwd = s.cwd;
    timerRef.current = setTimeout(() => {
      rpc('files.search', { cwd, q: tok.q, limit: 50 }).then((r) => {
        if (seq !== seqRef.current) return;
        const items = (Array.isArray(r) ? r : []).map(normFile).filter(Boolean).slice(0, 50);
        setMenu({ kind: 'file', start: tok.start, q: tok.q, items, active: 0 });
      }).catch(() => { if (seq === seqRef.current) setMenu((m) => m && { ...m, items: [] }); });
    }, 120);
  }

  function pick(i) {
    const m = menu;
    const it = m?.items?.[i];
    if (!it) return;
    const end = m.start + 1 + m.q.length;
    const ins = m.kind === 'cmd' ? '/' + it.name + ' ' : '@' + it.rel + ' ';
    const v = text.slice(0, m.start) + ins + text.slice(end).replace(/^ /, '');
    closeMenu(false);
    suppressRef.current = null;
    setBox(v, m.start + ins.length);
    focusTa();
  }

  // ---- insert at cursor (snippets, paths, window event) ----
  function insertAt(str) {
    const ta = taRef.current;
    const v = textRef.current;
    const a = caretRef.current ?? (ta ? ta.selectionStart : v.length);
    const b = caretRef.current ?? (ta ? ta.selectionEnd : v.length);
    setBox(v.slice(0, a) + str + v.slice(b), a + str.length);
  }
  const insertRef = useRef(insertAt); insertRef.current = insertAt;
  // At the cursor, padded with spaces so it never glues onto a neighbouring word ('word' inserts, dictation).
  function insertWord(t) {
    const ta = taRef.current; const v = textRef.current;
    const a = caretRef.current ?? (ta ? ta.selectionStart : v.length);
    const b = caretRef.current ?? (ta ? ta.selectionEnd : v.length);
    const pre = a > 0 && !/\s/.test(v[a - 1]) ? ' ' : '';
    const post = b < v.length && /\s/.test(v[b]) ? '' : ' ';
    insertAt(pre + t + post);
  }
  const wordRef = useRef(insertWord); wordRef.current = insertWord;
  const voice = useVoice({ id, idRef, enabled: !!s, onText: (t) => { wordRef.current(t); requestAnimationFrame(focusTa); }, refocus: () => requestAnimationFrame(focusTa) });

  useEffect(() => {
    // split view: only the focused pane's composer takes window-level inserts / focus requests
    const mine = () => !idRef.current || idRef.current === activeId.value;
    // detail.mode: 'cursor' (default) | 'append' (after the draft, blank line between, caret at the end)
    // | 'word' (at the cursor, padded with spaces so `@path` never glues onto a neighbouring word)
    const ins = (e) => {
      if (!mine()) return;
      const t = e.detail?.text;
      if (typeof t === 'string' && t) {
        const mode = e.detail?.mode;
        if (mode === 'append') {
          const v = textRef.current.replace(/\s+$/, '');
          const next = v ? v + '\n\n' + t : t;
          caretRef.current = null;
          setBox(next, next.length);
        } else if (mode === 'word') wordRef.current(t);
        else insertRef.current(t);
      }
      if (e.detail?.focus !== false) requestAnimationFrame(focusTa);   // focus:false = the phone sheet covers the box
    };
    // 'helm:composer-attach' { detail: { attachments: [{ kind: 'image', name, mime, dataUrl, size? }] } }
    // (screenshot picker, Files panel "Attach image"). Same split-view rule as inserts.
    const att = (e) => {
      if (!mine() || !idRef.current) return;
      const list = (Array.isArray(e.detail?.attachments) ? e.detail.attachments : [])
        .filter((a) => a && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:'))
        .map((a) => ({ key: uid(), kind: a.kind === 'file' ? 'file' : 'image', name: String(a.name || 'image.png'), mime: String(a.mime || 'image/png'), dataUrl: a.dataUrl, size: Number(a.size) || Math.round(a.dataUrl.length * 0.75) }));
      if (list.length) setAtts((x) => [...x, ...list]);
      if (e.detail?.focus !== false) requestAnimationFrame(focusTa);
    };
    const foc = () => { if (mine()) focusTa(); };
    addEventListener('helm:composer-insert', ins);
    addEventListener('helm:composer-attach', att);
    addEventListener('helm:composer-focus', foc);
    return () => { removeEventListener('helm:composer-insert', ins); removeEventListener('helm:composer-attach', att); removeEventListener('helm:composer-focus', foc); };
  }, []);

  // ---- attachments ----
  async function addFiles(files) {
    for (const f of files) {
      const isImg = (f.type || '').startsWith('image/');
      if (isImg) {
        if (f.size > IMAGE_LIMIT) { toast({ title: 'Image too large', body: `${f.name} is ${fmtBytes(f.size)}; the limit is 20 MB.`, kind: 'warn' }); continue; }
        try {
          const dataUrl = await readDataUrl(f);
          setAtts((a) => [...a, { key: uid(), kind: 'image', name: f.name || 'pasted-image.png', mime: f.type, dataUrl, size: f.size }]);
        } catch (e) { toast({ title: 'Could not read image', error: e, kind: 'error' }); }
        continue;
      }
      let p = null;
      try { p = window.helmNative?.pathForFile?.(f) || null; } catch {}
      if (p) {
        const v = textRef.current;
        const a = caretRef.current ?? taRef.current?.selectionStart ?? v.length;
        const pre = a > 0 && !/\s/.test(v[a - 1]) ? ' ' : '';
        insertAt(pre + quotePath(p) + ' ');
        continue;
      }
      if (f.size < FILE_LIMIT) {
        try {
          const dataUrl = await readDataUrl(f);
          setAtts((a) => [...a, { key: uid(), kind: 'file', name: f.name, mime: f.type || 'application/octet-stream', dataUrl, size: f.size }]);
        } catch (e) { toast({ title: 'Could not read file', error: e, kind: 'error' }); }
      } else {
        toast({ title: 'File too large to attach', body: `${f.name} is ${fmtBytes(f.size)}. Without the desktop app the limit is 512 KB.`, kind: 'warn' });
      }
    }
  }

  const onPaste = (e) => {
    const cd = e.clipboardData;
    const imgs = [...(cd?.files || [])].filter((f) => (f.type || '').startsWith('image/'));
    if (!imgs.length) return;
    if (![...cd.types].includes('text/plain')) e.preventDefault();
    addFiles(imgs);
  };
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const onDragOver = (e) => {
    if (!s || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!drag) setDrag(true);
  };
  const onDragLeave = (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false); };
  const onDrop = (e) => {
    if (!s || !hasFiles(e)) return;
    e.preventDefault();
    setDrag(false);
    addFiles([...e.dataTransfer.files]);
    focusTa();
  };
  const onPicked = (e) => {
    const files = [...(e.currentTarget.files || [])];
    e.currentTarget.value = '';
    addFiles(files);
    focusTa();
  };

  // ---- send / stop ----
  const hasContent = shell ? !!text.trim() : !!text.trim() || atts.length > 0;   // a `!` command never carries attachments

  // Only the Stop button gets here; it asks first when agents would stop with the turn.
  function stop() {
    if (!s) return;
    stopTurn(s.id);
  }

  // `!` command: runs in the session folder now (no CLI needed); Claude sees the output with the
  // next message. The box goes back to a normal prompt, like the terminal.
  async function runShell() {
    if (!s) return;
    const cmd = textRef.current.trim();
    if (!cmd) return;
    const sid = s.id;
    pushHistory(sid, '!' + cmd);
    setShell(false, '', 0);
    try {
      await rpc('sessions.shell', { id: sid, command: cmd });
    } catch (e) {
      toast({ title: 'Command not run', error: e, kind: 'error' });
      if (idRef.current === sid && !textRef.current) setShell(true, cmd, cmd.length);
      else saveDraft(sid, '!' + cmd);
    }
  }

  async function submit() {
    if (!s) return;
    if (shellRef.current) { runShell(); return; }
    if (!hasContent) return;   // lane steer: an empty Enter never stops a turn
    const sid = s.id;
    const raw = text;
    const body = raw.replace(/^\s*\n/, '').trimEnd();
    const kept = atts;
    const payload = kept.map(({ kind, name, mime, dataUrl, path }) => ({ kind, name, mime, dataUrl, path }));
    pushHistory(sid, body);
    histRef.current = { idx: -1, list: [] };
    closeMenu(false);
    setAtts([]);
    setBox('', 0);
    try {
      await send(sid, body, payload.length ? payload : undefined);
    } catch (e) {
      toast({ title: 'Message not sent', error: e, kind: 'error' });
      if (idRef.current === sid && !textRef.current) { setBox(raw, raw.length); setAtts((a) => (a.length ? a : kept)); }
      else saveDraft(sid, raw);
    }
  }

  // ---- keys ----
  function onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    const ta = e.currentTarget;
    if (menu) {
      const n = menu.items?.length || 0;
      if (e.key === 'ArrowDown' && n) { e.preventDefault(); setMenu({ ...menu, active: (menu.active + 1) % n }); return; }
      if (e.key === 'ArrowUp' && n) { e.preventDefault(); setMenu({ ...menu, active: (menu.active - 1 + n) % n }); return; }
      if (((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') && n) { e.preventDefault(); pick(menu.active); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
    }
    // Shell mode: Esc, or Backspace at the very start, goes back to a normal prompt (text kept).
    if (shellRef.current && (e.key === 'Escape' || (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0))) {
      e.preventDefault();
      e.stopPropagation();
      setShell(false, textRef.current, 0);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      if (isTouch() && isPhone.value) return;      // phone keyboards: Enter is a newline, the button sends
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape') return;   // lane steer: Esc closes menus (above); it never stops a turn
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const h = histRef.current;
    const navigating = h.idx >= 0 && h.idx < h.list.length && text === h.list[h.idx];
    if (e.key === 'ArrowUp' && (text === '' || navigating)) {
      if (navigating && text.slice(0, ta.selectionStart).includes('\n')) return;
      if (!navigating) {
        // `!` commands and prompts keep separate histories: shell mode walks only the commands.
        const all = loadHistory(id);
        h.list = shellRef.current ? all.filter((x) => x.startsWith('!')).map((x) => x.slice(1)) : all.filter((x) => !x.startsWith('!'));
        h.idx = h.list.length;
      }
      if (h.idx > 0) { e.preventDefault(); h.idx--; const v = h.list[h.idx]; setBox(v, v.length); }
      return;
    }
    if (e.key === 'ArrowDown' && navigating) {
      if (text.slice(ta.selectionEnd).includes('\n')) return;
      e.preventDefault();
      h.idx++;
      const v = h.idx < h.list.length ? h.list[h.idx] : '';
      if (!v) h.idx = -1;
      setBox(v, v.length);
    }
  }

  const onKeyUp = (e) => {
    if (shellRef.current) return;
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) runDetect(e.currentTarget.value, e.currentTarget.selectionStart);
  };
  const onInput = (e) => {
    const ta = e.currentTarget;
    histRef.current.idx = -1;
    caretRef.current = null;
    // A leading `!` switches to shell mode; the `!` becomes the Shell chip.
    if (s && !shellRef.current && ta.value.startsWith('!')) { setShell(true, ta.value.slice(1), Math.max(0, ta.selectionStart - 1)); return; }
    setBox(ta.value);
    if (ta.value.trim()) noteDraft(idRef.current); // typing a draft keeps this session's CLI from the idle close
    if (shellRef.current) return;
    runDetect(ta.value, ta.selectionStart);
  };

  const disabled = !s;
  const cls = 'cmp-card' + (drag ? ' is-drag' : '') + (disabled ? ' is-disabled' : '') + (shell ? ' is-shell' : '');

  return html`<div class="cmp" data-session=${id || ''}>
    <div class="cmp-col" ref=${colRef}>
      <${AutoMenu} menu=${menu} onPick=${pick} onHover=${(i) => setMenu((m) => m && { ...m, active: i })} />
      <${AuthNotice} />
      <div class=${cls} onDragOver=${onDragOver} onDragEnter=${onDragOver} onDragLeave=${onDragLeave} onDrop=${onDrop}>
        ${atts.length > 0 && html`<div class="cmp-atts">
          ${atts.map((a) => (a.kind === 'image'
            ? html`<div class="cmp-thumb" key=${a.key} title=${a.name}>
                <img src=${a.dataUrl} alt=${a.name} />
                <button type="button" class="cmp-x" aria-label=${'Remove ' + a.name} onClick=${() => setAtts((l) => l.filter((x) => x.key !== a.key))}><${Icon} name="x" size=${12} /></button>
              </div>`
            : html`<div class="chip cmp-filechip" key=${a.key} title=${a.name}>
                <${Icon} name="file" size=${14} /><span class="cmp-filechip-name">${a.name}</span><span class="cmp-filechip-size">${fmtBytes(a.size)}</span>
                <button type="button" class="cmp-x cmp-x-inline" aria-label=${'Remove ' + a.name} onClick=${() => setAtts((l) => l.filter((x) => x.key !== a.key))}><${Icon} name="x" size=${12} /></button>
              </div>`))}
        </div>`}
        ${shell && html`<div class="cmp-shellhead">
          <span class="cmp-shellchip"><${Icon} name="terminal" size=${12} />Shell</span>
          <span class="cmp-shellnote">Claude sees the output with your next message</span>
          <button type="button" class="cmp-shellx" title="Back to a message (Esc)" aria-label="Leave shell mode"
            onClick=${() => { setShell(false); requestAnimationFrame(focusTa); }}><${Icon} name="x" size=${12} /></button>
        </div>`}
        <textarea ref=${taRef} class=${shell ? 'cmp-ta is-shell' : 'cmp-ta'} rows="1" value=${text} disabled=${disabled}
          placeholder=${disabled ? 'Select a session to start' : shell ? `Run a command in ${folderName(s)}` : isPhone.value || forSid ? 'Message Claude…' : 'Message Claude…  @ for files, / for commands'}
          aria-label=${shell ? 'Shell command' : 'Message'} aria-autocomplete="list" aria-expanded=${menu ? 'true' : 'false'} aria-controls=${menu ? 'cmp-ac' : undefined}
          aria-activedescendant=${menu?.items?.length ? 'cmp-ac-' + menu.active : undefined}
          spellcheck=${shell ? 'false' : 'true'} autocapitalize=${shell ? 'off' : undefined} autocorrect=${shell ? 'off' : undefined}
          onInput=${onInput} onKeyDown=${onKeyDown} onKeyUp=${onKeyUp} onPaste=${onPaste}
          onClick=${(e) => { if (!shellRef.current) runDetect(e.currentTarget.value, e.currentTarget.selectionStart); }}
          onBlur=${() => setTimeout(() => { if (document.activeElement !== taRef.current) closeMenu(false); }, 120)} />
        <${VoiceStatus} voice=${voice} />
        ${s && html`<${Bar} s=${s} voice=${voice} text=${text} hasContent=${hasContent} working=${working} shell=${shell}
          onSend=${submit} onStop=${stop} onAttach=${() => fileRef.current?.click()} onInsert=${(t) => { insertAt(t); requestAnimationFrame(focusTa); }} refocus=${() => requestAnimationFrame(focusTa)} />`}
        <input ref=${fileRef} type="file" multiple hidden onChange=${onPicked} />
        ${drag && html`<div class="cmp-drop" aria-hidden="true">Drop to attach</div>`}
      </div>
    </div>
  </div>`;
}
