'use strict';
// Worker thread for main/activity.js: scans the Claude Code transcripts off Electron's main
// thread and saves the cache. Messages to the host, in order:
//   { kind: 'window', result }          phase 1 (the 30-day window) is ready
//   { kind: 'progress', done, total }   phase 2 (every older file), at most every 250 ms
//   { kind: 'alltime', result }         phase 2's all-time aggregate
//   { kind: 'done' }                    then the worker exits
//   { kind: 'error', ok: false, error } on failure (in either phase)
// Owner: lane activity.
const { parentPort, workerData } = require('worker_threads');
const { runScan } = require('./activity');

runScan({
  ...workerData,
  // ok: true keeps a host started before this change (it resolves on the first { ok, result }) working.
  onWindow: (result) => parentPort.postMessage({ kind: 'window', ok: true, result }),
  onProgress: (done, total) => parentPort.postMessage({ kind: 'progress', done, total }),
})
  .then((out) => {
    if (out.allTime) parentPort.postMessage({ kind: 'alltime', result: out.allTime });
    parentPort.postMessage({ kind: 'done' });
  })
  .catch((e) => parentPort.postMessage({ kind: 'error', ok: false, error: (e && e.message) || String(e) }));
