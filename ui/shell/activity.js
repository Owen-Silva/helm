// Live side of the sidebar's active / Past split. Owner: lane sessions. The rule itself is pure and
// host-tested in ui/lib/session-activity.js; this adds the minute clock and the open session.
// state.js builds the project groups from sessionSplit.active (in start order, buildProjectGroups), so
// the sidebar, Ctrl+1..9 and split view all see the same list; past.js shows sessionSplit.past.
import { signal, computed, effect } from '@preact/signals';
import { sessions, activeId } from '../lib/store.js';
import { displayStatus } from '../lib/session-status.js';
import { splitSessions } from '../lib/session-activity.js';

// lane:fleet's display rule: an idle session whose background agents still run reads as working.
const isWorking = (s) => displayStatus(s) === 'working';

// Minute clock, on the minute: "used in the last hour" is re-checked once a minute, so a row never
// slides out of the list between ticks because time passed.
export const minuteTick = signal(Date.now());
(function schedule() {
  setTimeout(() => { minuteTick.value = Date.now(); schedule(); }, 60000 - (Date.now() % 60000) + 50);
})();

// Ids kept in the main list whatever the rule says: id -> leftAt (null while it is the open session).
// The open session joins once it has been in the main list and stays while it is open ("never yank
// the open session"); after the user leaves it, it stays until a minute tick at least 30 s later.
// A session opened from Past is not in the main list, so it stays in Past (highlighted) until it is
// used: sessions.markRead does not touch updatedAt.
const keep = signal(new Map());
const LEFT_GRACE_MS = 30 * 1000;

export const sessionSplit = computed(() => splitSessions(sessions.value, {
  now: minuteTick.value, openId: activeId.value, keep: keep.value, isWorking,
}));

// The open session joins `keep` once it shows in the main list; the one the user just left gets a leftAt.
let openPrev = null;
effect(() => {
  const id = activeId.value;
  const { active } = sessionSplit.value;
  const k = keep.peek();
  let next = null;
  if (openPrev !== id) {
    if (openPrev && k.has(openPrev) && k.get(openPrev) == null) (next ||= new Map(k)).set(openPrev, Date.now());
    openPrev = id;
  }
  if (id && (!k.has(id) || k.get(id) != null) && active.some((s) => s.id === id)) (next ||= new Map(k)).set(id, null);
  if (next) keep.value = next;
});

// Each tick: drop sessions left long enough ago.
effect(() => {
  const now = minuteTick.value;
  const k = keep.peek();
  const next = new Map([...k].filter(([, leftAt]) => leftAt == null || now - leftAt < LEFT_GRACE_MS));
  if (next.size !== k.size) keep.value = next;
});

// Terminal transcripts Past has loaded (claudeSessionId -> HistoryEntry), so the read-only view can
// name a terminal session that external.list no longer reports and offer to continue it.
export const pastTerminal = signal(new Map());
