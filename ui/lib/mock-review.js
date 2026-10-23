// Mock data for the review tools (?mock=1 only; transport.js calls these before its defaults).
// diff(): a realistic two-hunk diff so review comments, ranges and inline cards have room to show.
// read()/tree(): a `public/` folder with images, so the Files panel's "Attach image" flow runs in a browser.
// Owner: lane review-tools. Each function returns null when it has nothing to say (the default answers).

const BEFORE = `const express = require('express');
const { getSession } = require('../lib/session');
const log = require('../lib/log');

// Gate every route behind a signed-in session.
function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.redirect('/login');
  }
  req.user = session.user;
  next();
}

// Admin pages: signed in AND on the allow-list.
function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session || !session.user) {
    return res.status(401).end();
  }
  if (!session.user.isAdmin) {
    return res.status(403).send('Forbidden');
  }
  req.user = session.user;
  next();
}

function rateLimit(max) {
  const hits = new Map();
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > max) return res.status(429).end();
    next();
  };
}

module.exports = { requireAuth, requireAdmin, rateLimit };
`;

const AFTER = BEFORE
  .replace("    return res.redirect('/login');\n", "    const next = encodeURIComponent(req.originalUrl);\n    log.info('auth: redirecting to login', { next });\n    return res.redirect(`/login?next=${next}`);\n")
  .replace("    if (n > max) return res.status(429).end();\n", "    if (n > max) {\n      res.set('Retry-After', '60');\n      return res.status(429).json({ error: 'rate_limited' });\n    }\n");

export function diff(path) {
  if (!path) return null;
  return { path, before: BEFORE, after: AFTER };
}

// ---------- images ----------

const IMG = /\.(png|jpe?g|gif|webp)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
let cached = null;

// A quiet 640x360 "screenshot" drawn once on a canvas (neutral greys, one muted accent line).
function picture() {
  if (cached) return cached;
  try {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 360;
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, 640, 360);
    bg.addColorStop(0, '#2a2d31'); bg.addColorStop(1, '#1d1f22');
    g.fillStyle = bg; g.fillRect(0, 0, 640, 360);
    g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(24, 24, 592, 40);
    g.fillStyle = '#c9ced4'; g.font = '600 18px system-ui, sans-serif'; g.fillText('storefront — weekly runs', 40, 51);
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1;
    for (let y = 120; y <= 320; y += 50) { g.beginPath(); g.moveTo(40, y + 0.5); g.lineTo(600, y + 0.5); g.stroke(); }
    g.strokeStyle = '#9fb4cc'; g.lineWidth = 2; g.beginPath();
    [[40, 290], [120, 260], [200, 270], [280, 210], [360, 220], [440, 170], [520, 150], [600, 128]].forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
    cached = c.toDataURL('image/png');
  } catch { cached = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='; }
  return cached;
}

export function read(path) {
  if (!path || !IMG.test(path)) return null;
  const ext = path.split('.').pop().toLowerCase();
  const dataUrl = picture();
  return { path, text: '', truncated: false, mime: MIME[ext] || 'image/png', size: Math.round(dataUrl.length * 0.75), binary: true, dataUrl };
}

export function tree(dir) {
  if (!dir || !/[\\/]public$/i.test(dir)) return null;
  const now = Date.now();
  const f = (name, size, mins) => ({ name, path: dir + '\\' + name, dir: false, size, mtime: now - mins * 60_000 });
  return [f('dashboard.png', 48_213, 12), f('favicon.svg', 1_204, 3 * 24 * 60), f('index.html', 6_512, 40), f('og-image.jpg', 92_877, 9 * 24 * 60)];
}
