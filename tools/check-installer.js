// Licensing guard for Helm's installer: FAILS if Anthropic's software is inside.
//
//   node tools/check-installer.js <Helm-Setup.exe | installed folder> [--7z=<path to 7z.exe>]
//
// An .exe is unpacked with 7-Zip (it opens NSIS installers), then every archive found inside (electron-builder
// puts the app in $PLUGINSDIR\app-64.7z) is unpacked too. A folder (e.g. the installed
// %LOCALAPPDATA%\Programs\helm) is walked as is. It fails on:
//   - any path containing "@anthropic-ai" or "claude-agent-sdk" (the SDK and its per-platform packages),
//   - any file named claude.exe or claude (Claude Code itself),
//   - any package.json whose name is an @anthropic-ai package, whatever folder it sits in,
// and also when it cannot find Helm's own app inside (resources\app\main.js), so it never passes by looking
// at nothing. Prints one summary line: INSTALLER_GUARD PASS|FAIL ...
// Owner: lane installer.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const target = process.argv.slice(2).find((a) => !a.startsWith('--'));
const sevenArg = (process.argv.find((a) => a.startsWith('--7z=')) || '').slice(5);
function die(msg) { console.log(`INSTALLER_GUARD FAIL: ${msg}`); process.exit(1); }
if (!target || !fs.existsSync(target)) die(`nothing to check at ${target || '(no path given)'}`);

function sevenZip() {
  const c = [sevenArg, process.env.SEVEN_ZIP, 'C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe'].filter(Boolean);
  for (const p of c) if (fs.existsSync(p)) return p;
  try { execFileSync('7z', ['i'], { stdio: 'ignore' }); return '7z'; } catch {}
  die('7-Zip (7z.exe) not found; pass --7z=<path>');
}
const unpack = (z, file, dir) => execFileSync(z, ['x', '-y', '-bso0', '-bsp0', `-o${dir}`, file], { stdio: ['ignore', 'ignore', 'inherit'] });

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

let root = path.resolve(target);
let tmp = null;
const archives = [];
if (fs.statSync(root).isFile()) {
  const z = sevenZip();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-installer-guard-'));
  unpack(z, root, path.join(tmp, 'setup'));
  archives.push(path.basename(root));
  // nested archives (app-64.7z), up to 3 levels
  for (let depth = 0; depth < 3; depth++) {
    const inner = walk(tmp).filter((f) => /\.(7z|zip|nupkg|asar\.unpacked\.7z)$/i.test(f) && !fs.existsSync(f + '.d'));
    if (!inner.length) break;
    for (const f of inner) { unpack(z, f, f + '.d'); archives.push(path.relative(tmp, f)); }
  }
  root = tmp;
}

const files = walk(root);
const rel = (f) => path.relative(root, f);
const badPaths = files.filter((f) => /@anthropic-ai|claude-agent-sdk/i.test(rel(f)));
const badExe = files.filter((f) => /^claude(\.exe)?$/i.test(path.basename(f)));
const badPkg = files.filter((f) => path.basename(f) === 'package.json').filter((f) => {
  try { return /^@anthropic-ai\//.test(JSON.parse(fs.readFileSync(f, 'utf8')).name || ''); } catch { return false; }
});
const appMain = files.filter((f) => /(^|[\\/])resources[\\/]app[\\/]main\.js$/i.test(rel(f)));
const helmExe = files.filter((f) => /^helm\.exe$/i.test(path.basename(f)));

const bad = [...new Set([...badPaths, ...badExe, ...badPkg])].map(rel);
const summary = `${files.length} files${archives.length ? ` in ${archives.join(' + ')}` : ` under ${root}`} · ${badPaths.length} @anthropic-ai/claude-agent-sdk paths · ${badExe.length} claude(.exe) · ${badPkg.length} Anthropic package.json · app ${appMain.length ? 'found' : 'NOT found'}`;
if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
if (bad.length) { console.log(bad.slice(0, 40).map((b) => `  anthropic: ${b}`).join('\n')); die(summary); }
if (!appMain.length || !helmExe.length) die(`${summary} (expected Helm.exe and resources\\app\\main.js inside; the check would be meaningless)`);
console.log(`INSTALLER_GUARD PASS: ${summary}`);
