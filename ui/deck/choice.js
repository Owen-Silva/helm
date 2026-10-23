// Owner: lane deck. The one question shape a Deck tile answers in one click (no imports, so the mock,
// the stand-in engine and node tests can all load it). Mirrors simpleChoice() in main/engine/session.js;
// PROTOCOL "Deck summary" pendingRequest.choice.
//
// simpleChoice(questions) -> { question, options: [{ label, description? }] } | null
//   Only for exactly ONE question, single-select, with 2-4 options. `question` and each `label` are exact,
//   because the answer is keyed by them: { answers: { [question]: label } } (the chat's own shape).
//   Anything else (several questions, multiSelect, 1 or 5+ options, free text, plans) -> null: open the session.
const one = (v, n = 160) => { const t = String(v || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export function simpleChoice(questions) {
  if (!Array.isArray(questions) || questions.length !== 1) return null;
  const q = questions[0] || {};
  if (q.multiSelect || typeof q.question !== 'string' || !q.question.trim() || !Array.isArray(q.options)) return null;
  if (q.options.length < 2 || q.options.length > 4) return null;
  const options = [];
  for (const o of q.options) {
    const label = o && typeof o.label === 'string' ? o.label : '';
    if (!label.trim()) return null;
    const d = o.description ? one(o.description) : '';
    options.push(d ? { label, description: d } : { label });
  }
  return { question: q.question, options };
}

// The questions on a request item: the item's own list, else the tool input's.
export const questionsOf = (it) => (Array.isArray(it?.questions) && it.questions.length ? it.questions : it?.input?.questions);

// The response a tile sends for one picked option.
export const choiceAnswer = (choice, label) => ({ answers: { [choice.question]: label } });
