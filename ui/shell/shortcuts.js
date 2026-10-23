// Keyboard shortcuts sheet (lane presets). Opened by `?` (when focus is not in a text field), Ctrl+/ and
// the palette. Desktop only: the phone has no keyboard, so neither the sheet nor its entry points exist there.
// Every row below is a shortcut that really exists; the source that handles it is noted beside each group.
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { html } from '../lib/html.js';
import { settings, appInfo } from '../lib/store.js';
import { isPhone } from './state.js';
import { Modal, isMac } from './util.js';
import { openWhatsNew } from './whats-new.js';

export const shortcutsOpen = signal(false);
export function toggleShortcuts() { if (!isPhone.value) shortcutsOpen.value = !shortcutsOpen.value; }

// Platform labels: ⌘ ⇧ ⌥ ⌃ on a Mac, words elsewhere.
const L = isMac
  ? { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃' }
  : { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl' };
const k = (...keys) => keys.map((x) => L[x] || x);

// Electron accelerator ("Control+Alt+Space", "CommandOrControl+Shift+H") -> key labels.
export function acceleratorKeys(accel) {
  const map = { control: L.ctrl, ctrl: L.ctrl, alt: L.alt, option: L.alt, shift: L.shift, super: isMac ? '⌘' : 'Win', meta: isMac ? '⌘' : 'Win',
    command: '⌘', cmd: '⌘', commandorcontrol: L.mod, cmdorctrl: L.mod, space: 'Space' };
  return String(accel || '').split('+').map((x) => x.trim()).filter(Boolean).map((x) => map[x.toLowerCase()] || (x.length === 1 ? x.toUpperCase() : x));
}

function groups() {
  const desktopApp = appInfo.value.platform === 'electron';
  const hotkey = settings.value?.quickPromptHotkey;
  return [
    { title: 'General', rows: [                                   // shell/index.js useShortcuts
      ['Command palette', k('mod', 'K')],
      ['Home', k('mod', 'shift', 'H')],                            // lane home (state.js goHome)
      ['New session', k('mod', 'N')],
      ['Settings', k('mod', ',')],
      ['History', k('mod', 'H')],
      ['Deck: every session as a tile', k('mod', 'shift', 'D')],
      ['Keyboard shortcuts', ['?'], k('mod', '/')],
      ...(desktopApp && hotkey ? [['Quick prompt, from any app', acceleratorKeys(hotkey)]] : []),   // main/quick.js
      ['Close a dialog, menu or panel', ['Esc']],
    ] },
    { title: 'Sessions and layout', rows: [                       // shell/index.js, shell/sidebar.js, shell/tabs.js
      ['Go to tab 1 to 8', k('mod', '1–8')],
      ['Last tab', k('mod', '9')],
      ['Next tab', k('mod', 'Tab')],
      ['Previous tab', k('mod', 'shift', 'Tab')],
      ['Close tab (the session keeps running)', k('mod', 'W')],
      ['Filter sessions', k('mod', 'shift', 'F')],
      ['Toggle sidebar', k('mod', 'B')],
      ['Toggle inspector', k('mod', '\\')],
      ['Split view (1 or 2 side by side)', k('mod', 'shift', '\\')],
      ['4 corners (on, or back)', k('mod', 'shift', '4')],   // lane quad
      ['Select several sessions', [isMac ? '⌘ click' : 'Ctrl click'], [isMac ? '⇧ click' : 'Shift click']],
    ] },
    { title: 'Composer', rows: [                                  // composer/index.js
      ['Send', ['Enter']],
      ['New line', k('shift', 'Enter')],
      ['Stop the running turn', ['Esc']],
      ['Previous prompts', ['↑'], ['↓']],
      ['Slash command', ['/']],
      ['Mention a file', ['@']],
      ['! at the start of the box: run a shell command in the session folder; Claude sees the output with your next message', ['!']],
      ['Dictate: tap to start, tap again to stop and transcribe into the box', k('ctrl', 'M')],   // composer/voice.js
      ['Push-to-talk: hold, speak, let go', k('ctrl', 'M')],
      ['Discard the dictation (while recording or transcribing)', ['Esc']],
    ] },
    { title: 'Conversation', rows: [                              // chat/index.js, chat/find.js, chat/requests.js
      ['Find in conversation', k('mod', 'F')],
      ['Next / previous match', ['Enter'], k('shift', 'Enter')],
      ['Pick an answer on a question', ['1–9']],
      ['Submit the answers', ['Enter']],
    ] },
    { title: 'Deck', rows: [                                      // deck/deck.js
      ['Move between tiles', ['←↑↓→']],
      ['Open the session', ['Enter']],
      ['Reply from the tile', ['/']],
    ] },
    { title: 'New session', rows: [                               // shell/new-session.js
      ['Start the session', k('mod', 'Enter')],
    ] },
  ];
}

const Keys = ({ keys }) => html`<span class="sc-keys">${keys.map((x) => html`<span class="kbd">${x}</span>`)}</span>`;

export function ShortcutsSheet() {
  if (!shortcutsOpen.value || isPhone.value) return null;
  const close = () => { shortcutsOpen.value = false; };
  const whatsNew = () => { close(); openWhatsNew(); };
  return html`<${Modal} title="Keyboard shortcuts" onClose=${close} width=${720} class="shortcuts-modal"
      footer=${html`<span class="grow"></span><button class="btn btn-ghost btn-sm" data-act="whats-new" onClick=${whatsNew}>What's new in Helm</button>`}>
    <div class="sc-grid">
      ${groups().map((g) => html`<section class="sc-group" aria-label=${g.title}>
        <h3 class="section-label">${g.title}</h3>
        <dl class="sc-list">
          ${g.rows.map(([label, ...alts]) => html`<div class="sc-row">
            <dt>${label}</dt>
            <dd>${alts.map((keys, i) => html`${i > 0 && html`<span class="sc-or">or</span>`}<${Keys} keys=${keys} />`)}</dd>
          </div>`)}
        </dl>
      </section>`)}
    </div>
  <//>`;
}

const typing = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

// `?` (no modifiers, not typing) and Ctrl+/ toggle the sheet. Mounted once by the Shell.
export function useShortcutsKey() {
  useEffect(() => {
    const onKey = (e) => {
      if (isPhone.value || e.defaultPrevented || e.altKey || e.isComposing) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (e.code === 'Slash' || e.key === '/') && !e.shiftKey) {
        e.preventDefault(); e.stopPropagation(); toggleShortcuts(); return;
      }
      if (ctrl || e.key !== '?' || typing(e.target) || typing(document.activeElement)) return;
      // another dialog is up (palette, new session, delete…): `?` belongs to it
      if (!shortcutsOpen.value && document.querySelector('.modal-scrim:not(.m-leave)')) return;
      e.preventDefault(); toggleShortcuts();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, []);
}
