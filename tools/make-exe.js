// Builds dist/Helm/Helm.exe: a copy of node_modules/electron/dist with electron.exe renamed to
// Helm.exe and stamped (rcedit) with ui/assets/icon.ico + version info, so the taskbar, Alt+Tab,
// Task Manager and toasts show Helm instead of Electron's atom. The app code is NOT copied:
// `Helm.exe "<path to this repo>"` runs the live project folder, so code changes need no rebuild.
// Re-run only when the icon or the Electron version changes.
// Usage: node tools/make-exe.js [--out=<dir>]   (default dist/Helm)
// Owner: lane host (B).
//
// LICENSING GUARD: never publish what this script builds, and never add a packaging step that copies
// node_modules into a release. node_modules/@anthropic-ai/claude-agent-sdk* (including the platform
// packages that contain claude.exe) is Anthropic's proprietary software, not covered by Helm's GPL, and
// Helm has no right to redistribute it. Helm releases are SOURCE-ONLY: users install their own Claude
// Code and run `npm install` themselves. Any future installer must exclude every
// @anthropic-ai/claude-agent-sdk* package and claude(.exe) and require the user's own Claude Code.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const SRC = path.join(ROOT, 'node_modules', 'electron', 'dist');
const ICON = path.join(ROOT, 'ui', 'assets', 'icon.ico');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const OUT = outArg ? path.resolve(outArg.slice(6)) : path.join(ROOT, 'dist', 'Helm');

function fail(msg) { console.error('make-exe: ' + msg); process.exit(1); }

// resources/app: Helm.exe started with NO arguments (a taskbar pin made from the running window, Explorer)
// would otherwise open Electron's default app. With this folder Electron runs it instead, and it loads
// the project's main.js; an explicit project path argument (Start Menu, `helm`, tests) changes nothing.
function writeStub(dir) {
  const app = path.join(dir, 'resources', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName || 'Helm', version: pkg.version, private: true, main: 'index.js' }, null, 2));
  fs.writeFileSync(path.join(app, 'index.js'), [
    '// Written by tools/make-exe.js: run the Helm project folder (see writeStub there).',
    `require(${JSON.stringify(path.join(ROOT, 'main.js'))});`,
    '',
  ].join('\n'));
  return app;
}

// Windows file versions are 4 numbers; package.json has 3.
const fileVersion = (v) => { const n = String(v).split(/[.+-]/).map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x)); while (n.length < 4) n.push(0); return n.slice(0, 4).join('.'); };

async function main() {
  // --stub-only: add/refresh resources/app in an existing build (works while Helm is running).
  if (process.argv.includes('--stub-only')) { if (!fs.existsSync(path.join(OUT, 'Helm.exe'))) fail('no ' + path.join(OUT, 'Helm.exe') + ' (run without --stub-only)'); console.log('HELM_STUB ' + writeStub(OUT)); return; }
  if (!fs.existsSync(path.join(SRC, 'electron.exe'))) fail(`no electron.exe in ${SRC} (run npm install)`);
  if (!fs.existsSync(ICON)) fail(`no icon at ${ICON}`);
  const ico = fs.readFileSync(ICON);
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) fail(`${ICON} is not an .ico file`);
  const frames = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < frames; i++) { const w = ico[6 + i * 16] || 256; sizes.push(w); }
  const electronVersion = fs.readFileSync(path.join(SRC, 'version'), 'utf8').trim();
  const { rcedit } = await import('rcedit');

  // Build next to the target, then swap, so a failed build never leaves a half-made Helm.
  const stage = OUT + '.new';
  const old = OUT + '.old';
  fs.rmSync(stage, { recursive: true, force: true });
  const t0 = Date.now();
  fs.cpSync(SRC, stage, { recursive: true });
  const exe = path.join(stage, 'Helm.exe');
  fs.renameSync(path.join(stage, 'electron.exe'), exe);

  await rcedit(exe, {
    icon: ICON,
    'file-version': fileVersion(pkg.version),
    'product-version': fileVersion(pkg.version),
    'version-string': {
      ProductName: 'Helm',
      FileDescription: 'Helm',
      CompanyName: 'Owen Silva',
      InternalName: 'Helm',
      OriginalFilename: 'Helm.exe',
      LegalCopyright: `Copyright (C) ${new Date().getFullYear()} Owen Silva`,
      Comments: `Helm ${pkg.version} on Electron ${electronVersion}: desktop + phone deck for Claude Code`,
    },
  });

  const info = {
    helm: pkg.version, electron: electronVersion, builtAt: new Date().toISOString(),
    icon: path.relative(ROOT, ICON), iconSha256: crypto.createHash('sha256').update(ico).digest('hex'), iconSizes: sizes,
    run: `"${path.join(OUT, 'Helm.exe')}" "${ROOT}"`,
  };
  fs.writeFileSync(path.join(stage, 'helm-build.json'), JSON.stringify(info, null, 2));
  writeStub(stage);

  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(OUT)) {
    try { fs.renameSync(OUT, old); }
    catch (e) { fs.rmSync(stage, { recursive: true, force: true }); fail(`could not replace ${OUT} (${e.code}): quit Helm (tray > Quit Helm) and run this again`); }
  }
  fs.renameSync(stage, OUT);
  fs.rmSync(old, { recursive: true, force: true });
  console.log(`HELM_EXE ${JSON.stringify({ exe: path.join(OUT, 'Helm.exe'), electron: electronVersion, iconSizes: sizes, ms: Date.now() - t0 })}`);
}

main().catch((e) => fail(e && e.stack || String(e)));
