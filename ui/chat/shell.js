// Owner: lane bang. ShellCard: a `!` command the user ran from the composer (item type `shell`,
// docs/PROTOCOL.md). Same parts as an open Bash tool card: a quiet header line, the `.term` block
// ($ command + output folded past ~12 lines, copy buttons), plus a note saying whether Claude has
// seen the output yet (it goes with the next message sent).
import { useMemo } from 'preact/hooks';
import { html } from '../lib/html.js';
import { highlight } from '../lib/markdown.js';
import { Icon } from '../lib/icons.js';
import { rpc, toast } from '../lib/store.js';
import { OutputView, CopyBtn } from './views.js';
import { now, useTicker } from './state.js';
import { memo, fmtDuration, fmtElapsedShort } from './util.js';
import { spinner } from './tools.js';

// Progress bars rewrite a line with a bare \r: show what a terminal would end up showing.
function collapseCR(s) {
  if (!s || s.indexOf('\r') < 0) return s || '';
  return s.replace(/\r\n/g, '\n').split('\n').map((ln) => {
    const parts = ln.split('\r');
    for (let k = parts.length - 1; k >= 0; k--) if (parts[k]) return parts[k];
    return '';
  }).join('\n');
}
const folder = (cwd) => String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';

function Tail({ item }) {
  const running = item.status === 'running';
  useTicker(running);
  if (running) return html`<span class="trow-time">${fmtElapsedShort(Math.max(0, now.value - (item.startedAt || now.value)))}</span>`;
  const ms = item.endedAt && item.startedAt ? item.endedAt - item.startedAt : 0;
  const dur = ms >= 1000 ? fmtDuration(ms) : '';
  if (item.status === 'stopped') return html`<span class="trow-flag stopped"><${Icon} name="square" size=${10} />Stopped${dur ? html`<span class="shrow-dot">·</span>${dur}` : null}</span>`;
  if (item.status === 'error') return html`<span class="trow-flag error"><${Icon} name="alert" size=${12} />Could not run</span>`;
  const code = typeof item.exitCode === 'number' ? item.exitCode : null;
  if (code == null) return dur ? html`<span class="trow-time">${dur}</span>` : null;
  return html`<span class=${'trow-time shrow-exit' + (code ? ' bad' : '')}>Exit ${code}${dur ? html`<span class="shrow-dot">·</span>${dur}` : null}</span>`;
}

function ShellCardImpl({ item, sid, ro = false }) {
  const running = item.status === 'running';
  const bad = item.status === 'error' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
  const out = useMemo(() => collapseCR(item.text || ''), [item.text]);
  const ps = item.shell === 'powershell';
  const stop = () => rpc('sessions.shellStop', { id: sid, itemId: item.id }).catch((e) => toast({ title: 'Could not stop the command', error: e, kind: 'error' }));
  const where = folder(item.cwd);
  return html`<div class=${'shrow is-' + (item.status || 'done')} data-item-id=${item.id}>
    <div class="shrow-line">
      <span class="trow-ic">${running ? spinner() : html`<${Icon} name="terminal" size=${14} />`}</span>
      <span class="trow-verb">${running ? 'Running' : 'You ran'}</span>
      ${where ? html`<span class="trow-meta shrow-where" title=${item.cwd}>in ${where}</span>` : null}
      <span class="grow" />
      <${Tail} item=${item} />
      ${running && !ro ? html`<button type="button" class="btn sm shrow-stop" onClick=${stop} title="Stop this command (ends its whole process tree)">
        <${Icon} name="square" size=${10} />Stop</button>` : null}
    </div>
    <div class="t-detail shrow-body">
      <div class=${'term' + (bad ? ' bad' : '')}>
        <div class="term-cmd"><span class="term-prompt" aria-hidden="true">${ps ? 'PS>' : '$'}</span>
          <code class="hljs" dangerouslySetInnerHTML=${{ __html: highlight(item.command || '', ps ? 'powershell' : 'bash') }} /><${CopyBtn} text=${item.command || ''} label="" /></div>
        <${OutputView} text=${out} bare=${true} max=${12} tone=${item.status === 'error' ? 'error' : bad ? 'bad' : ''} empty=${running ? 'Waiting for output…' : 'No output'} />
      </div>
      <div class=${'shrow-note' + (item.shared ? ' is-shared' : '')}>
        <${Icon} name=${item.shared ? 'check' : 'eye'} size=${12} />
        <span>${item.shared ? 'Shared with Claude' : running ? 'Claude sees this with your next message once it finishes' : 'Claude sees this with your next message'}</span>
        ${item.clipped ? html`<span class="shrow-clip">· showing the last 1 MB</span>` : null}
      </div>
    </div>
  </div>`;
}

export const ShellCard = memo(ShellCardImpl, (a, b) => a.item === b.item && a.sid === b.sid && a.ro === b.ro);
