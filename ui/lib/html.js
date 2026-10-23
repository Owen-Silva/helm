// `html` tagged templates (htm bound to Preact's h) — the JSX replacement, no build step.
//   import { html } from '../lib/html.js';  html`<div class=${cls}>${children}</div>`
import { h } from 'preact';
import htm from 'htm';
export const html = htm.bind(h);
export { h };
