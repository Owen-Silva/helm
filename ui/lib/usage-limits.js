// Does this sign-in have Claude's 5-hour / weekly usage limits? (lane prep-helm-auth-usage, 2026-10-19)
// Subscriptions do; an Anthropic API key doesn't (billed per token, no window), so with a key the 5H / week
// meters, pace and the queue's 5H gate would be blank or wrong. The host says so with auth.usageLimits === false:
// no 5-hour/weekly limits (an API key: one saved in Helm, or Claude Code itself signed in with a Console key)
// (store.js `auth`). Anything else (null = an older host or not loaded yet, absent, true) = limits as always.
// Pure: no DOM, no store import, so test/host/usage-limits.test.js runs it in plain node.

export const CONSOLE_USAGE_URL = 'https://console.anthropic.com/settings/usage';

// a = auth.value
export function limitsOff(a) { return !!a && a.usageLimits === false; }

// Usage panel card, in place of the 5-hour and weekly windows.
export const NO_LIMITS_TITLE = 'No usage limits with an API key';
export const NO_LIMITS_TEXT = 'Usage limits apply to Claude subscriptions only. These sessions use an Anthropic API key '
  + '(or a Console login or cloud provider): spend is billed per token and has no 5-hour or weekly window.';
export const NO_LIMITS_LINK = 'See spend in the Anthropic Console';

// Compact chip (Home glance, sidebar meter): label + tooltip with the reason.
export const NO_LIMITS_CHIP = { key: 'API key', value: 'no usage limits' };
export const NO_LIMITS_TIP = 'API key · no usage limits. Usage limits apply to Claude subscriptions only: '
  + 'an Anthropic API key is billed per token and has no 5-hour or weekly window.';

// Queue: with a key the host starts jobs without the 5H gate (main/queue.js), still one at a time.
export const QUEUE_NO_GATE = 'No 5-hour gate: these sessions use an Anthropic API key (or a Console login or cloud provider), which has no usage window. Jobs still run one at a time.';
