// "Getting Helm ready" page (main/sdk-setup.js). State from main: { phase, received, total, version, name, host,
// source, reason, detail, code, canRetry }. Owner: lane installer.
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const mb = (n) => (n == null ? null : n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const LABEL = {
    starting: 'Starting…',
    downloading: 'Downloading…',
    verifying: 'Checking it against the checksum this Helm expects…',
    unpacking: 'Unpacking…',
    loading: 'Loading it…',
    ready: 'Ready. Opening Helm…',
  };
  let retrying = false;
  function render(s) {
    if (!s) return;
    $('pkg').textContent = `${s.name || '@anthropic-ai/claude-agent-sdk'}${s.version ? ` ${s.version}` : ''}`;
    $('from').textContent = s.host ? `${s.host}${s.source && s.source !== 'default' ? ` (set by ${s.source})` : ''}` : '—';
    const failed = s.phase === 'failed';
    document.body.dataset.phase = s.phase;
    $('title').textContent = failed ? 'Helm couldn’t download the Claude Agent SDK' : 'Getting Helm ready';
    $('fail').hidden = !failed;
    $('btns').hidden = !failed;
    $('retry').hidden = failed && s.canRetry === false;
    retrying = false;
    $('retry').disabled = false;
    if (failed) {
      $('reason').textContent = s.reason || 'The download failed.';
      $('detail').textContent = s.detail || '';
      $('status').textContent = 'Nothing was installed. Helm needs the SDK to run Claude Code sessions.';
      $('bar').removeAttribute('aria-valuenow');
      $('fill').style.width = '0%';
      return;
    }
    let pct = null;
    if (s.phase === 'downloading' && s.total) pct = Math.min(100, Math.round((s.received / s.total) * 100));
    else if (s.phase === 'verifying' || s.phase === 'unpacking' || s.phase === 'loading' || s.phase === 'ready') pct = 100;
    document.body.classList.toggle('indeterminate', pct == null);
    $('fill').style.width = pct == null ? '' : `${pct}%`;
    if (pct == null) $('bar').removeAttribute('aria-valuenow'); else $('bar').setAttribute('aria-valuenow', String(pct));
    const size = s.phase === 'downloading' && s.received ? ` ${mb(s.received)}${s.total ? ` of ${mb(s.total)}` : ''}` : '';
    $('status').textContent = (LABEL[s.phase] || s.phase) + size;
  }
  $('retry').addEventListener('click', () => {
    if (retrying) return;
    retrying = true;
    $('retry').disabled = true;
    render({ phase: 'starting', name: $('pkg').textContent });
    window.helmSetup.retry();
  });
  $('quit').addEventListener('click', () => window.helmSetup.quit());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('btns').hidden) window.helmSetup.quit(); });
  window.helmSetup.onState(render);
})();
