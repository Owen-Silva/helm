// Unit tests for ui/lib/usage-limits.js (lane prep-helm-auth-usage): which sign-ins have Claude's 5-hour / weekly
// usage limits, and the text shown when they don't (an Anthropic API key). Absent / null must mean "limits as always".
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ul = require('../../ui/lib/usage-limits.js');

test('limitsOff is true only when the host says usageLimits: false', () => {
  assert.equal(ul.limitsOff({ provider: 'api-key', capabilities: { apiKey: true, login: false }, usageLimits: false }), true);
  assert.equal(ul.limitsOff(null), false, 'older host / not loaded: today\'s behaviour');
  assert.equal(ul.limitsOff(undefined), false);
  assert.equal(ul.limitsOff({ provider: 'subscription', capabilities: { login: true } }), false, 'field absent');
  assert.equal(ul.limitsOff({ provider: 'subscription', usageLimits: true }), false);
  assert.equal(ul.limitsOff({ usageLimits: 0 }), false, 'only a literal false turns limits off');
  assert.equal(ul.limitsOff({ usageLimits: 'false' }), false);
});

test('the no-limits text says why and where the spend is', () => {
  assert.equal(ul.CONSOLE_USAGE_URL, 'https://console.anthropic.com/settings/usage');
  assert.match(ul.NO_LIMITS_TEXT, /subscriptions only/);
  assert.match(ul.NO_LIMITS_TEXT, /API key/);
  assert.match(ul.NO_LIMITS_TEXT, /5-hour or weekly/);
  assert.match(ul.NO_LIMITS_TIP, /^API key · no usage limits\./);
  assert.match(ul.QUEUE_NO_GATE, /one at a time/);
  for (const s of [ul.NO_LIMITS_TEXT, ul.NO_LIMITS_TIP, ul.QUEUE_NO_GATE, ul.NO_LIMITS_TITLE, ul.NO_LIMITS_LINK]) {
    assert.doesNotMatch(s, /—|unknown/i, 'never reads as a blank or broken value');
  }
});
