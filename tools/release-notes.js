#!/usr/bin/env node
// Release notes for the installer workflow's DRAFT release (.github/workflows/installer.yml, draft job).
//
//   node tools/release-notes.js            build/release-notes.md as it is (the unsigned build)
//   node tools/release-notes.js --signed   the same notes with the "isn't code-signed" paragraph swapped for the
//                                          signed one, for a run whose Helm-Setup.exe SignPath signed
//
// One notes file, so the signed and unsigned texts can't drift apart. Fails (exit 1, with the reason) if the
// paragraph it swaps is gone, rather than publishing notes that still say the installer is unsigned.
'use strict';
const fs = require('fs');
const path = require('path');

const NOTES = path.join(__dirname, '..', 'build', 'release-notes.md');
const UNSIGNED = /^\*\*Windows will warn you\.\*\*.*$/m;
const SIGNED = '**Signed installer.** Helm-Setup.exe is code-signed; its publisher is SignPath Foundation (free code signing ' +
  'provided by SignPath.io, certificate by SignPath Foundation). A new certificate can still trigger a Microsoft Defender ' +
  'SmartScreen warning until it builds up reputation: if you see "Windows protected your PC", check that the publisher is ' +
  'SignPath Foundation, then click **More info** and **Run anyway**.';

const text = fs.readFileSync(NOTES, 'utf8');
if (!process.argv.includes('--signed')) { process.stdout.write(text); process.exit(0); }
if (!UNSIGNED.test(text)) {
  console.error(`release-notes: ${path.relative(process.cwd(), NOTES)} has no "**Windows will warn you.**" paragraph to replace for a signed release`);
  process.exit(1);
}
process.stdout.write(text.replace(UNSIGNED, SIGNED));
