// Pure ETA formatting (no store, no DOM) so it can be unit-tested in node: ui/shell/eta.js re-exports it.
// lane accuracy 2026-10-14: moved out of ui/shell/eta.js unchanged, plus the day-aware clock and ETA_BASIS.

function dur(ms, compact) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return compact ? '<1m' : '<1 min';
  if (m < 60) return compact ? `${m}m` : `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return compact ? (r ? `${h}h${r}m` : `${h}h`) : (r ? `${h} h ${r} min` : `${h} h`);
}
// "4:32" for a finish later today (the countdown beside it says which half of the day); a finish on another
// day names it: "tomorrow 1:15 AM", "Fri 9:00 AM" (a bare "1:15" past midnight read as today).
function clock(ts, now = Date.now()) {
  try {
    const d = new Date(ts), n = new Date(now);
    if (d.toDateString() !== n.toDateString()) {
      const tom = new Date(n); tom.setDate(n.getDate() + 1);
      const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return `${d.toDateString() === tom.toDateString() ? 'tomorrow' : d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
    }
    return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).formatToParts(new Date(ts))
      .filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
  } catch { return ''; }
}
// Mirrors the eta mod's stepText: step is a 1-based number or a label.
function stepOf(eta) {
  const steps = Array.isArray(eta.steps) ? eta.steps : [];
  const n = steps.length;
  if (!n) return null;
  let i = 1;
  if (typeof eta.step === 'number') i = Math.min(Math.max(1, Math.round(eta.step)), n);
  else if (typeof eta.step === 'string' && eta.step) { const k = steps.findIndex((s) => String(s).toLowerCase() === eta.step.toLowerCase()); if (k >= 0) i = k + 1; else return null; }
  return { text: `step ${i}/${n}`, of: `${i} of ${n}`, label: steps[i - 1] };
}

// Every ETA is an estimate; its basis goes in each tooltip (numbers are right, or say what they rest on).
export const ETA_BASIS = "Estimate from the eta mod: Claude's own time estimate (calibrated by past runs) or the running agents' expected finish, whichever is later.";

// null unless the session is working and the mod gave an ETA. `working` = the caller's notion of busy.
export function etaInfo(eta, working, now = Date.now()) {
  if (!eta || !working || !eta.etaAt || (eta.state && eta.state !== 'working')) return null;
  const left = eta.etaAt - now;
  const over = !!eta.isOverdue || left < 0;
  const st = stepOf(eta);
  // eta.reason: why the mod pushed the finish out on its own ("test failed · +10m"); shown while counting down
  const why = !over && eta.reason ? ` (${eta.reason})` : '';
  const long = over ? `over by ${left < 0 ? dur(-left, true) : '<1m'}` : `~${dur(left, false)} left${why}`;
  const done = clock(eta.etaAt, now);
  // one phrase for tooltips: "~14 min left, done 4:32 · step 2/4: Patch + test"
  const phrase = `${long}${!over && done ? `, done ${done}` : ''}${st ? ` · ${st.text}: ${st.label}` : ''}`;
  return {
    over, long, done, phrase,
    short: over ? `+${dur(-left, true)}` : `~${dur(left, true)}`,
    step: st?.text || null,
    stepOf: st?.of || null,
    stepLabel: st?.label || null,
    label: eta.label || null, summary: eta.summary || null, note: eta.note || null,
    reason: eta.reason || null,
    title: [phrase, eta.label, eta.summary, eta.note, ETA_BASIS].filter(Boolean).join('\n'),
    basis: ETA_BASIS,
  };
}

