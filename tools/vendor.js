// Copies the browser ESM builds of UI libraries into ui/vendor/.
// The renderer has no bundler: ui/index.html maps bare specifiers to these files
// with an import map, so `import { h } from 'preact'` works in Electron and on the phone.
// Run after `npm install`: `npm run vendor`.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'ui', 'vendor');

const FILES = {
  'preact.js': 'preact/dist/preact.module.js',
  'preact-hooks.js': 'preact/hooks/dist/hooks.module.js',
  'htm.js': 'htm/dist/htm.module.js',
  'signals-core.js': '@preact/signals-core/dist/signals-core.module.js',
  'signals.js': '@preact/signals/dist/signals.module.js',
  'marked.js': 'marked/lib/marked.esm.js',
  'purify.js': 'dompurify/dist/purify.es.mjs',
  'diff.js': 'diff/lib/index.mjs',
  'hljs.js': '@highlightjs/cdn-assets/es/highlight.min.js',
  'hljs-powershell.js': '@highlightjs/cdn-assets/es/languages/powershell.min.js',
};

fs.mkdirSync(out, { recursive: true });
for (const [dest, src] of Object.entries(FILES)) {
  fs.copyFileSync(path.join(nm, src), path.join(out, dest));
  console.log('vendor', dest, '<-', src);
}
