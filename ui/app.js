// Renderer entry. Owner: lane shell (C).
import { render } from 'preact';
import { html } from './lib/html.js';
import './lib/store.js';
import { Shell } from './shell/index.js';
render(html`<${Shell} />`, document.getElementById('app'));
