// A toast's words: title, body, and (lane helm-plainerror, 2026-10-14, P-H1) a "Details" disclosure holding the
// raw error text that ui/lib/plain-error.js put into plain words, so nothing is hidden. Opening Details pins the
// toast (onPin) so it does not time out while being read; clicks inside it never open the toast's session.
// Kept apart from chrome.js so a node test can build it (preact + htm, no DOM).
import { html } from '../lib/html.js';

export function ToastText({ t, onPin }) {
  const stop = (e) => e.stopPropagation();
  return html`<div class="toast-text"><div class="toast-title">${t.title}</div>${t.body && html`<div class="toast-body">${t.body}</div>`}${t.details && html`<details class="toast-details" onClick=${stop} onToggle=${(e) => { if (e.currentTarget.open && onPin) onPin(); }}>
      <summary>Details</summary><pre class="toast-raw">${t.details}</pre></details>`}</div>`;
}
