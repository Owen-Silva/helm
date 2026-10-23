// One child-process start per event-loop turn (lane helm-settings-freeze, 2026-10-17).
// Starting a process blocks the calling thread (CreateProcess: 15-100 ms each on the user's laptop), and Helm's main
// thread is also the one that answers the window. Opening Settings starts several at once: the Phone checklist
// (firewall check, tailscale status twice, serve status), Account (claude auth status) and, before any session has
// run, the model list (a Claude Code probe). Started in the same turn they add up into one block. Every start awaits
// nextStartTurn() first: a loop turn (setImmediate) after the previous start; Electron returns to the window's
// message loop between libuv turns, so the window gets answered in between.
let gate = Promise.resolve();
function nextStartTurn() {
  const turn = gate.then(() => new Promise((r) => setImmediate(r)));
  gate = turn;
  return turn;
}
module.exports = { nextStartTurn };
