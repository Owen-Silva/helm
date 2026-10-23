// Mock schedules.* for the ?mock=1 UI (screenshots, click-throughs). Never real data. Scenario: &sched=some (default) |
// none | restart (only "Ended by restart" rows) | many. "Ask Claude to cancel" marks the row asked, then ~2.5 s later
// moves it to Ended as 'deleted' / 'stopped' (as Claude would); "Close process" ends every row of that session.
// Owner: lane sched.
const T0 = Date.now();
const MIN = 60_000;
const scenario = new URLSearchParams(location.search).get('sched') || 'some';

const item = (sessionId, sessionTitle, project, key, kind, label, nextIn, extra = {}) => ({
  id: `${sessionId}|${key}`, key, sessionId, sessionTitle, project, kind, label, prompt: label, detail: '', nextAt: T0 + nextIn,
  recurring: kind !== 'wakeup', durable: false, cronId: null, askedAt: null, canClose: true, closeWhy: null, others: 0,
  askText: kind === 'cron' ? `Please cancel the scheduled job ${extra.cronId || 'abcd1234'} ("${label}") with CronDelete, then confirm in one line. (Sent from Helm's Scheduled list.)`
    : "Please stop this loop: call ScheduleWakeup with stop: true and do not schedule another wake-up, then confirm in one line. (Sent from Helm's Scheduled list.)",
  ...extra,
});

function initial() {
  if (scenario === 'none') return { items: [], ended: [] };
  const restart = [
    { id: 'r1', sessionId: 's_mobile', sessionTitle: 'Bundle size report on release', project: 'mobile-app', kind: 'cron', label: 'Re-run the size report and post the summary', detail: 'every 30 minutes', why: 'restart', at: T0 - 4 * MIN },
  ];
  if (scenario === 'restart') return { items: [], ended: restart };
  const items = [
    item('s_helm', 'Helm design system', 'helm', 'wake:tu1', 'loop', '/loop check the e2e run and fix what broke', 4 * MIN + 12_000, { detail: 'Waiting on the e2e suite (about 4 min left)', cronId: null }),
    item('s_storefront', 'Fix the login redirect loop', 'storefront', 'cron:tu2', 'cron', 'Check Railway deploy health and post to #claude-queue', 17 * MIN + 40_000, { detail: 'every 30 minutes', cronId: 'abcd1234', canClose: false, closeWhy: 'Claude is working in this session; closing its process now would stop that work.' }),
    item('s_booking', 'Customer import preview', 'booking-portal', 'cron:tu3', 'cron', 'Remind me to send the import preview for review', 2 * 60 * MIN + 5 * MIN, { detail: 'once at 4:30 PM', recurring: false, cronId: 'ffff0000' }),
  ];
  if (scenario === 'many') {
    items.push(item('s_sim', 'Match simulated load to real traffic', 'simulator', 'wake:tu4', 'loop', 'Autonomous loop', 26 * MIN, { detail: 'Next sweep after the replay finishes' }));
    items.push(item('s_mobile', 'Bundle size report on release', 'mobile-app', 'cron:tu5', 'cron', 'Pull the nightly build and update the size board', 6 * 60 * MIN, { detail: 'at 4:05 PM, Monday to Friday', durable: true, canClose: false, closeWhy: 'Saved in the project (durable): it comes back the next time Claude starts in this folder, so closing does not cancel it.', cronId: 'dur00001' }));
  }
  return { items: items.sort((a, b) => a.nextAt - b.nextAt), ended: scenario === 'many' ? restart : [] };
}

const S = initial();
const view = () => ({ now: Date.now(), items: S.items.map((x) => ({ ...x })), ended: S.ended.map((e) => ({ ...e })) });

export async function mockSchedules(method, p = {}, emit = () => {}) {
  if (method === 'schedules.list') return view();
  if (method === 'schedules.dismiss') {
    S.ended = p.all ? [] : S.ended.filter((e) => e.id !== p.id);
    emit(view());
    return {};
  }
  if (method === 'schedules.cancel') {
    const x = S.items.find((y) => y.sessionId === p.sessionId && y.key === p.key);
    if (!x) throw Object.assign(new Error('That schedule is no longer pending in this session.'), { code: 'gone' });
    if (p.how === 'ask') {
      x.askedAt = Date.now();
      emit(view());
      setTimeout(() => {
        S.items = S.items.filter((y) => y !== x);
        S.ended.unshift({ id: `${x.id}|${Date.now()}`, sessionId: x.sessionId, sessionTitle: x.sessionTitle, project: x.project, kind: x.kind, label: x.label, detail: x.detail,
          why: x.key.startsWith('wake:') ? 'stopped' : 'deleted', at: Date.now(), asked: true });
        emit(view());
      }, 2500);
      return { how: 'ask', asked: true, queued: false, text: x.askText };
    }
    if (!x.canClose) throw Object.assign(new Error(x.closeWhy), { code: x.durable ? 'durable' : 'busy' });
    const gone = S.items.filter((y) => y.sessionId === x.sessionId);
    S.items = S.items.filter((y) => y.sessionId !== x.sessionId);
    for (const y of gone) S.ended.unshift({ id: `${y.id}|${Date.now()}`, sessionId: y.sessionId, sessionTitle: y.sessionTitle, project: y.project, kind: y.kind, label: y.label, detail: y.detail, why: 'closed', at: Date.now() });
    emit(view());
    return { how: 'close', closed: true, ended: gone.length, left: 0 };
  }
  throw new Error(`mock: unknown ${method}`);
}
