// Home "Next up" card (lane sched, 2026-10-09): the next three in-session schedules (a /loop's next tick, cron jobs)
// with live countdowns, plus one line when schedules were ended by a Helm restart. Hidden when there is nothing to
// show. The phone gets it too. Data + words: ../panels/scheduled.js (schedules.list / schedules.updated); countdowns
// ride the shared 1 s ticker (chat/state.js), which runs only while this card has a countdown and the window is
// visible. "All scheduled" opens the Queue panel's Scheduled section (the inspector tab when a session is open on the
// desktop, else the same list in a dialog), where each one can be cancelled. Styles: ../panels/scheduled.css.
// Mounted from home.js: import { NextUp } from './next-up.js';  <${NextUp} />
import { useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { activeSession, externalView } from '../lib/store.js';
import { now as tickNow, useTicker } from '../chat/state.js';
import { showPanel } from '../panels/state.js';
import { useSchedules, untilText, kindLabel, clockText, ScheduledDialog } from '../panels/scheduled.js';
import { openSession, go, isPhone } from './state.js';
import { cx } from './util.js';

const SHOW = 3;

export function NextUp() {
  const st = useSchedules();
  const [dialog, setDialog] = useState(false);
  const items = st.items;
  const restart = st.ended.filter((e) => e.why === 'restart');
  useTicker(items.length > 0);
  if (!items.length && !restart.length) return null;
  const now = items.length ? tickNow.value : Date.now();
  const openAll = () => {
    showPanel('queue');
    if (isPhone.value || !activeSession.value || externalView.value) setDialog(true);
    else go('session');
  };
  return html`<section class="nextup" aria-label="Next up">
    <h2 class="home-label nextup-label">Next up</h2>
    <ul class="nextup-list">
      ${items.slice(0, SHOW).map((x) => html`<li class="nextup-li" key=${x.id}>
        <button type="button" class=${cx('nextup-row', x.askedAt && 'asked')} data-sched=${x.key} onClick=${() => openSession(x.sessionId)}
            title=${`${x.prompt || x.label}\n${x.sessionTitle}${x.detail ? ` · ${x.detail}` : ''}`}>
          <span class="nextup-main">
            <span class="nextup-title">${x.label}</span>
            <span class="nextup-sub"><span class="nextup-kind">${kindLabel(x.kind)}</span><span class="nextup-sess">${x.sessionTitle}</span></span>
          </span>
          <span class="nextup-when"><span class="nextup-count tnum">${untilText(x.nextAt, now)}</span><span class="nextup-clock tnum">${clockText(x.nextAt)}</span></span>
        </button>
      </li>`)}
      ${restart.length > 0 && html`<li class="nextup-li"><button type="button" class="nextup-row nextup-lost" data-ended="restart" onClick=${openAll}
          title="Helm restarted, and in-session schedules end with Claude Code. Open the list to see which, or dismiss them.">
        <span class="nextup-main"><span class="nextup-title">${restart.length === 1 ? `“${restart[0].label}”` : `${restart.length} schedules`}</span>
          <span class="nextup-sub"><span class="nextup-kind">Ended by restart</span>${restart.length === 1 && html`<span class="nextup-sess">${restart[0].sessionTitle}</span>`}</span></span>
      </button></li>`}
    </ul>
    <button type="button" class="nextup-more" onClick=${openAll}>${items.length > SHOW ? `All scheduled (${items.length})` : items.length ? 'Manage or cancel' : 'Review'}</button>
    ${dialog && html`<${ScheduledDialog} onClose=${() => setDialog(false)} />`}
  </section>`;
}
