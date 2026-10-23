// Optional machine-wide CPU cap for the dev scripts that drive a headless browser or Electron.
// lowcpu.js is a separate helper (not part of Helm) that lowers process priority and allows one browser
// machine-wide. Point HELM_LOWCPU at your copy; without it, ~/portfolio-site/tools/lowcpu.js is used when it
// exists. With neither, the script runs uncapped and says so once on stderr.
// Require this FIRST in a script, before anything launches a browser: require('./lowcpu-optional');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOWCPU = process.env.HELM_LOWCPU || path.join(os.homedir(), 'portfolio-site', 'tools', 'lowcpu.js');
const present = fs.existsSync(LOWCPU);
if (present) require(LOWCPU);
else if (!process.env.CI) process.stderr.write(`lowcpu: ${LOWCPU} not found, running without the CPU cap (set HELM_LOWCPU to use one)\n`);

module.exports = { LOWCPU, present };
