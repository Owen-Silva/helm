// Which kind of Helm is running: a git checkout (the default) or a build made by the Windows installer.
//
// app.isPackaged can't tell them apart: Electron decides it from the executable's name, and the clone launcher
// tools/make-exe.js builds (dist\Helm\Helm.exe running this folder) already counts as "packaged". An installed
// build is recognised by two things that a checkout never has together:
//   1. package.json carries "helmDistribution": "installer" (tools/build-installer.js writes it into the copy it
//      packages; the repo's own package.json never has it), and
//   2. this code runs from inside the executable's own resources folder (<install>\resources\app), not from a
//      checkout that a launcher points at.
// Everything installer-only (the Claude Agent SDK download, the release-based update notice) is gated on this,
// so `npm start` and the make-exe launcher behave exactly as before.
// Owner: lane installer.
'use strict';
const path = require('path');

const INSTALLER = 'installer';

const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();

// pkg: the app's package.json; appDir: main.js's folder; resourcesPath: process.resourcesPath.
function isInstalledBuild({ pkg, appDir, resourcesPath } = {}) {
  if (!pkg || pkg.helmDistribution !== INSTALLER) return false;
  if (!appDir || !resourcesPath) return false;
  const res = norm(resourcesPath);
  const dir = norm(appDir);
  return dir.startsWith(res + path.sep.toLowerCase()) || dir.startsWith(res + '/');
}

module.exports = { isInstalledBuild, INSTALLER };
