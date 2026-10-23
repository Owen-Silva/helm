// Dev live reload (mock mode only): tools/serve-ui.js pushes a message on /__live when ui/ changes.
// CSS changes hot-swap without a reload; anything else reloads the page.
// Add &nolive to the URL to switch it off (headless checks that must not reload mid-run).
const params = new URLSearchParams(location.search);
if (params.has('mock') && !params.has('nolive')) {
  const es = new EventSource('/__live');
  es.onmessage = (e) => {
    const { file } = JSON.parse(e.data);
    if (file.endsWith('.css')) {
      for (const l of document.querySelectorAll('link[rel=stylesheet]')) l.href = l.href.replace(/\?.*|$/, '?t=' + Date.now());
    } else location.reload();
  };
}
