// Builds Helm-Setup.exe: a per-user NSIS installer (electron-builder) that contains NO Anthropic software.
//
//   node tools/build-installer.js [--stage-only] [--no-install] [--builder=<electron-builder version>]
//
// 1. Stage: copies the git-tracked app files (main.js, preload.js, main/, ui/, the licence files) to
//    dist/installer/app and writes its package.json: the repo's, minus every @anthropic-ai dependency and the
//    dev tools, plus "helmDistribution": "installer" (main/distribution.js) and "helmSdk", the SDK pin from
//    package-lock.json (version + sha512) that the installed Helm downloads from npm on first run
//    (main/sdk-fetch.js). Its only npm dependencies are the ones main/ really requires (checked below).
// 2. npm install --omit=dev --omit=optional --omit=peer in the stage, from a copy of package-lock.json.
// 3. Refuses to continue if the stage holds any @anthropic-ai path or a claude(.exe).
// 4. electron-builder (run with npx, never a dependency of the repo, so `npm install` in a checkout is
//    unchanged) packs it with Electron into dist/installer/out/Helm-Setup.exe. build/installer.nsh adds the
//    uninstaller's SDK cleanup and the "Helm is running" check.
// 5. tools/check-installer.js unpacks the result with 7-Zip and fails on any Anthropic file.
//
// LICENSING: see the README ("What the installer contains"). The SDK and claude.exe are Anthropic's
// proprietary software; Helm may not redistribute them. CI runs this on windows-latest (.github/workflows/installer.yml).
// Owner: lane installer.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { builtinModules } = require('module');

const ROOT = path.join(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'dist', 'installer');
const STAGE = path.join(OUT_ROOT, 'app');
const OUT = path.join(OUT_ROOT, 'out');
const SDK_NAME = '@anthropic-ai/claude-agent-sdk';
const BUILDER_DEFAULT = '26.0.12';
// What the installed app copies from the repo (git-tracked files only, so nothing local or personal ships).
const APP_PATHS = ['main.js', 'preload.js', 'main', 'ui', 'LICENSE', 'LICENSE-EXCEPTIONS.md', 'CREDITS.md'];
// Bare specifiers main/ may load that are NOT installed into the app: electron itself and the SDK (downloaded).
const NOT_BUNDLED = new Set(['electron', SDK_NAME]);

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const say = (m) => console.log(`build-installer: ${m}`);
function fail(m) { console.error(`build-installer: FAILED: ${m}`); process.exit(1); }
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', ...opts });
// npm / npx through node + their CLI script (a .cmd can't be run without a shell); a shell only as the fallback
function npm(name, argv, opts = {}) {
  const js = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${name}-cli.js`);
  if (fs.existsSync(js)) return run(process.execPath, [js, ...argv], opts);
  return run(name, argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)), { ...opts, shell: true });
}

// Bare module names a JS file requires/imports (comments stripped first, roughly).
function bareImports(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const out = new Set();
  for (const re of [/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, /^\s*import\s[^'"]*?from\s*['"]([^'"]+)['"]/gm]) {
    for (const m of code.matchAll(re)) {
      const s = m[1];
      if (s.startsWith('.') || s.startsWith('/') || s.startsWith('node:') || /^[a-z]+:/i.test(s)) continue;
      const name = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
      if (builtinModules.includes(name)) continue;
      out.add(name);
    }
  }
  return out;
}

// Every path under dir that would put Anthropic software in the installer.
function anthropicPaths(dir) {
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (/@anthropic-ai|claude-agent-sdk/i.test(e.name) || /^claude(\.exe)?$/i.test(e.name)) bad.push(rel);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return bad;
}

function stage() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const locked = lock.packages && lock.packages[`node_modules/${SDK_NAME}`];
  if (!locked || !locked.integrity || !locked.version) fail(`package-lock.json has no ${SDK_NAME} entry with an integrity`);
  if (pkg.dependencies[SDK_NAME] !== locked.version) fail(`package.json pins ${SDK_NAME} ${pkg.dependencies[SDK_NAME]} but package-lock.json has ${locked.version}: run npm install first`);
  const helmSdk = { name: SDK_NAME, version: locked.version, integrity: locked.integrity };

  fs.rmSync(OUT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--', ...APP_PATHS], { encoding: 'utf8' }).split('\0').filter(Boolean);
  if (!files.includes('main.js')) fail('git ls-files found no main.js (run this from a checkout)');
  for (const f of files) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) continue; // deleted in the work tree
    const dst = path.join(STAGE, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  // npm packages the app's main process really loads; each must be a dependency of the repo
  const need = new Set();
  for (const f of files) if (/\.(c|m)?js$/.test(f) && (f === 'main.js' || f === 'preload.js' || f.startsWith('main/'))) for (const n of bareImports(fs.readFileSync(path.join(ROOT, f), 'utf8'))) need.add(n);
  const deps = {};
  for (const n of [...need].sort()) {
    if (NOT_BUNDLED.has(n)) continue;
    if (n.startsWith('@anthropic-ai/')) fail(`main/ loads ${n}: Anthropic packages must never be bundled`);
    if (!pkg.dependencies[n]) fail(`main/ loads "${n}", which is not in package.json dependencies`);
    deps[n] = pkg.dependencies[n];
  }

  const appPkg = {
    name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, main: pkg.main,
    author: { name: 'Owen Silva' }, license: pkg.license, private: true,
    helmDistribution: 'installer', helmSdk, dependencies: deps,
  };
  fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(appPkg, null, 2) + '\n');
  fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(STAGE, 'package-lock.json'));
  say(`staged ${files.length} files in ${STAGE}; npm dependencies: ${Object.keys(deps).join(', ') || 'none'}; SDK pin ${helmSdk.version} (downloaded on first run, not bundled)`);
  return { pkg, appPkg };
}

function builderConfig(pkg) {
  const electron = (pkg.devDependencies && pkg.devDependencies.electron || '').replace(/^[^\d]*/, '');
  if (!/^\d+\.\d+\.\d+$/.test(electron)) fail(`devDependencies.electron is not an exact version: ${pkg.devDependencies && pkg.devDependencies.electron}`);
  return {
    appId: 'com.owensilva.helm', // = main.js AUMID: the Start Menu shortcut and Helm's toasts must agree
    productName: 'Helm',
    copyright: `Copyright (C) ${new Date().getFullYear()} Owen Silva`,
    electronVersion: electron,
    asar: false,               // main/ runs workers and spawns scripts from its own folder; plain files keep that simple
    npmRebuild: false,          // no native modules
    directories: { output: OUT, buildResources: path.join(ROOT, 'build') },
    files: ['**/*', '!package-lock.json'],
    win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: path.join(ROOT, 'ui', 'assets', 'icon.ico'), executableName: 'Helm' },
    nsis: {
      oneClick: true, perMachine: false, allowElevation: false,            // %LOCALAPPDATA%\Programs, no admin prompt
      artifactName: 'Helm-Setup.exe',                                        // stable: pages link releases/latest/download/Helm-Setup.exe
      shortcutName: 'Helm', createStartMenuShortcut: true, createDesktopShortcut: false,
      runAfterFinish: true, deleteAppDataOnUninstall: false,                // settings and sessions in %APPDATA%\Helm stay
      uninstallDisplayName: 'Helm', differentialPackage: false,
      include: path.join(ROOT, 'build', 'installer.nsh'),
    },
    publish: null,
  };
}

function main() {
  const { pkg } = stage();
  if (!has('--no-install')) {
    say('npm install (production dependencies only, no optional or peer packages, no install scripts)');
    npm('npm', ['install', '--omit=dev', '--omit=optional', '--omit=peer', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: STAGE });
  }
  const bad = anthropicPaths(STAGE);
  if (bad.length) fail(`the staged app contains Anthropic software, refusing to package it:\n  ${bad.slice(0, 20).join('\n  ')}`);
  say('stage check: no @anthropic-ai path and no claude(.exe) in the staged app');
  const cfgFile = path.join(OUT_ROOT, 'electron-builder.json');
  fs.writeFileSync(cfgFile, JSON.stringify(builderConfig(pkg), null, 2));
  if (has('--stage-only')) { say(`stage only: config in ${cfgFile}`); return; }
  const ver = val('builder') || BUILDER_DEFAULT;
  say(`electron-builder ${ver}`);
  npm('npx', ['--yes', `electron-builder@${ver}`, '--win', 'nsis', '--x64', '--projectDir', STAGE, '--config', cfgFile, '--publish', 'never'], { cwd: OUT_ROOT, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  const exe = path.join(OUT, 'Helm-Setup.exe');
  if (!fs.existsSync(exe)) fail(`electron-builder finished but ${exe} is missing`);
  say(`built ${exe} (${(fs.statSync(exe).size / 1048576).toFixed(1)} MB)`);
  run(process.execPath, [path.join(__dirname, 'check-installer.js'), exe]);
}

if (require.main === module) main();
module.exports = { bareImports, anthropicPaths, builderConfig };
