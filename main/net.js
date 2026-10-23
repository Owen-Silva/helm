// Token + Tailscale discovery for the phone link.
// Owner: lane host (B).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// <userData>/token.txt: 32 random bytes, hex. Created once; the user can delete it to re-pair the phone.
function loadToken(userDataDir) {
  const file = path.join(userDataDir, 'token.txt');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch {}
  const t = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

// 100.64.0.0/10 = 100.64.0.0 – 100.127.255.255 (Tailscale's CGNAT range)
function isTailscaleIp(ip) {
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(ip || '');
  return !!m && +m[1] >= 64 && +m[1] <= 127;
}

function tailscaleIPv4(ifaces = os.networkInterfaces()) {
  for (const list of Object.values(ifaces)) for (const a of list || []) {
    if ((a.family === 'IPv4' || a.family === 4) && !a.internal && isTailscaleIp(a.address)) return a.address;
  }
  return null;
}

// MagicDNS name from `tailscale status --json` (Self.DNSName, trailing dot removed), or null.
function tailscaleDnsName() {
  const candidates = ['tailscale', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')];
  return new Promise((resolve) => {
    const tryOne = (i) => {
      if (i >= candidates.length) { resolve(null); return; }
      execFile(candidates[i], ['status', '--json'], { timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, out) => {
        if (e) { tryOne(i + 1); return; }
        try {
          const j = JSON.parse(out);
          const name = j && j.Self && j.Self.DNSName ? String(j.Self.DNSName).replace(/\.$/, '') : null;
          resolve(name || null);
        } catch { resolve(null); }
      });
    };
    tryOne(0);
  });
}

module.exports = { loadToken, isTailscaleIp, tailscaleIPv4, tailscaleDnsName };
