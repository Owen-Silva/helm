// jobSafe (main/engine/broker-launch.js): when Helm counts on the broker outliving it. On the user's machine every
// process is in a session-wide job, so a broker that broke away still reports childInJob: true (2026-10-16).
const test = require('node:test');
const assert = require('node:assert/strict');
const { jobSafe } = require('../../main/engine/broker-launch');

test('jobSafe: no job, or a successful breakaway, is safe; stuck in a job is not; unknown is null', () => {
  assert.equal(jobSafe(null), null);
  assert.equal(jobSafe({ method: 'launcher', parentInJob: false, brokeAway: false, childInJob: false }), true);
  assert.equal(jobSafe({ method: 'launcher', parentInJob: true, brokeAway: true, childInJob: false }), true);
  assert.equal(jobSafe({ method: 'launcher', parentInJob: true, brokeAway: true, childInJob: true, breakawayError: 0 }), true);
  assert.equal(jobSafe({ method: 'launcher', parentInJob: true, brokeAway: false, childInJob: true, breakawayError: 5 }), false);
  assert.equal(jobSafe({ method: 'node', parentInJob: null, brokeAway: false, childInJob: null }), null);
});
