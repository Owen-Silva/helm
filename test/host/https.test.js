// main/https.js: tailnet HTTPS via `tailscale serve`, against a fake tailscale CLI that keeps a real-shaped
// ServeConfig. The user's own config (an http :80 handler for another app) must survive every change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTailnetHttps, parseServe, helmHandler, portUse, handlerKeys, httpsUrl } = require('../../main/https');

const D = 'my-pc.example.ts.net';
const EXISTING = () => ({ TCP: { 80: { HTTP: true } }, Web: { [`${D}:80`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7373' } } } } });

// A fake `tailscale` binary: status --json, serve status --json, serve --bg --yes --https=P target, serve --yes --https=P off.
function fakeTailscale({ certs = [D], cfg = EXISTING(), backend = 'Running', failServe = false } = {}) {
  const calls = [];
  const state = { cfg };
  const run = async (file, args) => {
    calls.push(args.join(' '));
    if (file !== 'tailscale') return { ok: false, stdout: '', stderr: '', error: 'ENOENT' };
    if (args[0] === 'status') return { ok: true, stdout: JSON.stringify({ BackendState: backend, CertDomains: certs, Self: { DNSName: D + '.' }, CurrentTailnet: { MagicDNSEnabled: true } }) };
    if (args.join(' ') === 'serve status --json') return { ok: true, stdout: Object.keys(state.cfg).length ? JSON.stringify(state.cfg) : '{}' };
    if (args[0] === 'serve') {
      if (failServe) return { ok: false, stdout: '', stderr: 'serve: access denied\n', error: 'exit 1' };
      const port = (args.find((a) => a.startsWith('--https=')) || '').slice(8);
      if (args[args.length - 1] === 'off') {
        delete state.cfg.TCP[port]; delete state.cfg.Web[`${D}:${port}`];
        return { ok: true, stdout: '' };
      }
      const target = args[args.length - 1];
      state.cfg.TCP = { ...(state.cfg.TCP || {}), [port]: { HTTPS: true } };
      state.cfg.Web = { ...(state.cfg.Web || {}), [`${D}:${port}`]: { Handlers: { '/': { Proxy: target } } } };
      return { ok: true, stdout: `Available within your tailnet:\nhttps://${D}:${port}/\n` };
    }
    return { ok: false, stdout: '', stderr: 'unknown', error: 'exit 1' };
  };
  return { run, calls, state };
}
const mutations = (calls) => calls.filter((c) => c.startsWith('serve ') && !c.startsWith('serve status'));
const okProbe = async () => ({ ok: true, status: 200 });

test('parseServe / helmHandler / portUse read real-shaped config', () => {
  assert.deepEqual(parseServe(''), {});
  assert.deepEqual(parseServe('No serve config'), {});
  assert.equal(parseServe('garbage{'), null);
  const cfg = EXISTING();
  assert.equal(helmHandler(cfg, D, 4871), null);
  assert.equal(portUse(cfg, 443), null);
  assert.equal(portUse(cfg, 80), '/ -> http://127.0.0.1:7373');
  cfg.TCP[443] = { HTTPS: true };
  cfg.Web[`${D}:443`] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:4871' } } };
  assert.deepEqual(helmHandler(cfg, D, 4871), { port: 443, proxy: 'http://127.0.0.1:4871', funnel: false });
  assert.equal(helmHandler(cfg, D, 4872), null, 'another port is not ours');
  cfg.AllowFunnel = { [`${D}:443`]: true };
  assert.equal(helmHandler(cfg, D, 4871).funnel, true);
  assert.deepEqual(handlerKeys(EXISTING()), [`${D}:80 /`]);
  assert.equal(httpsUrl(D, 443), `https://${D}`);
  assert.equal(httpsUrl(D, 8443), `https://${D}:8443`);
});

test('no certificates: says so, and turning on changes nothing', async () => {
  const ts = fakeTailscale({ certs: [] });
  const h = createTailnetHttps({ getLocalPort: () => 4871, run: ts.run, probe: okProbe });
  assert.equal((await h.status()).state, 'no-certs');
  await assert.rejects(h.enable(), { code: 'no_certs' });
  assert.deepEqual(mutations(ts.calls), []);
});

test('turn on: reads serve status first, adds only Helm\'s 443 handler, keeps the existing :80, self-checks', async () => {
  const ts = fakeTailscale();
  const probes = [];
  const h = createTailnetHttps({ getLocalPort: () => 4871, run: ts.run, probe: async (u) => { probes.push(u); return { ok: true, status: 200 }; } });
  const before = await h.status();
  assert.equal(before.state, 'off');
  assert.equal(before.nextPort, 443);
  assert.equal(before.otherHandlers, 1);
  ts.calls.length = 0;
  const s = await h.enable();
  const firstServe = ts.calls.findIndex((c) => c.startsWith('serve '));
  assert.equal(ts.calls[firstServe], 'serve status --json', 'reads the config before changing it');
  assert.deepEqual(mutations(ts.calls), ['serve --bg --yes --https=443 http://127.0.0.1:4871']);
  assert.ok(!ts.calls.some((c) => /funnel/.test(c)), 'never funnel');
  assert.equal(s.state, 'live');
  assert.equal(s.url, `https://${D}`);
  assert.equal(s.undo, 'tailscale serve --https=443 off');
  assert.equal(s.probe.ok, true);
  assert.deepEqual(probes, [`https://${D}`]);
  assert.deepEqual(ts.state.cfg.Web[`${D}:80`], EXISTING().Web[`${D}:80`], ':80 untouched');
  assert.deepEqual(h.names(), [D]);
  // again: already live, no second change
  ts.calls.length = 0;
  assert.equal((await h.enable()).state, 'live');
  assert.deepEqual(mutations(ts.calls), []);
});

test('443 used by something else -> 8443; both used -> busy, and nothing is replaced', async () => {
  const cfg = EXISTING();
  cfg.TCP[443] = { HTTPS: true }; cfg.Web[`${D}:443`] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } };
  const ts = fakeTailscale({ cfg });
  const h = createTailnetHttps({ getLocalPort: () => 4871, run: ts.run, probe: okProbe });
  const s = await h.enable();
  assert.equal(s.httpsPort, 8443);
  assert.equal(s.url, `https://${D}:8443`);
  assert.equal(ts.state.cfg.Web[`${D}:443`].Handlers['/'].Proxy, 'http://127.0.0.1:3000');

  const cfg2 = EXISTING();
  cfg2.TCP[443] = { HTTPS: true }; cfg2.Web[`${D}:443`] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } };
  cfg2.TCP[8443] = { TCPForward: '127.0.0.1:22' };
  const ts2 = fakeTailscale({ cfg: cfg2 });
  const h2 = createTailnetHttps({ getLocalPort: () => 4871, run: ts2.run, probe: okProbe });
  const st = await h2.status();
  assert.equal(st.state, 'busy');
  assert.match(st.detail, /443: \/ -> http:\/\/127\.0\.0\.1:3000; 8443: TCP -> 127\.0\.0\.1:22/);
  await assert.rejects(h2.enable(), { code: 'busy' });
  assert.deepEqual(mutations(ts2.calls), []);
});

test('turn off removes only Helm\'s handler', async () => {
  const ts = fakeTailscale();
  const h = createTailnetHttps({ getLocalPort: () => 4871, run: ts.run, probe: okProbe });
  await h.enable();
  ts.calls.length = 0;
  const s = await h.disable();
  assert.deepEqual(mutations(ts.calls), ['serve --yes --https=443 off']);
  assert.equal(s.state, 'off');
  assert.deepEqual(ts.state.cfg, EXISTING());
  // nothing of ours: off is a no-op
  ts.calls.length = 0;
  await h.disable();
  assert.deepEqual(mutations(ts.calls), []);
});

test('a test run (allowChange false) never changes serve; failures surface with their reason', async () => {
  const ts = fakeTailscale();
  const h = createTailnetHttps({ getLocalPort: () => 4871, run: ts.run, probe: okProbe, allowChange: false });
  assert.equal((await h.status()).canChange, false);
  await assert.rejects(h.enable(), { code: 'unsupported' });
  assert.deepEqual(mutations(ts.calls), []);
  const bad = fakeTailscale({ failServe: true });
  const h2 = createTailnetHttps({ getLocalPort: () => 4871, run: bad.run, probe: okProbe });
  await assert.rejects(h2.enable(), (e) => e.code === 'failed' && /access denied/.test(e.message));
});

test('Funnel on for Helm\'s port is flagged, not called live; a failed self-check is reported', async () => {
  const cfg = EXISTING();
  cfg.TCP[443] = { HTTPS: true }; cfg.Web[`${D}:443`] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:4871' } } };
  cfg.AllowFunnel = { [`${D}:443`]: true };
  const h = createTailnetHttps({ getLocalPort: () => 4871, run: fakeTailscale({ cfg }).run, probe: okProbe });
  const s = await h.status({ probe: true });
  assert.equal(s.state, 'funnel');
  assert.match(s.detail, /public internet/);

  const cfg2 = EXISTING();
  cfg2.TCP[443] = { HTTPS: true }; cfg2.Web[`${D}:443`] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:4871' } } };
  const h2 = createTailnetHttps({ getLocalPort: () => 4871, run: fakeTailscale({ cfg: cfg2 }).run, probe: async () => ({ ok: false, error: 'ETIMEDOUT: no answer within 30 s' }) });
  const s2 = await h2.status({ probe: true });
  assert.equal(s2.state, 'live');
  assert.equal(s2.probe.ok, false);
  assert.match(s2.probe.error, /ETIMEDOUT/);
});

test('Tailscale missing or stopped: a reason, never a throw', async () => {
  const h = createTailnetHttps({ getLocalPort: () => 4871, run: async () => ({ ok: false, stdout: '', stderr: '', error: 'ENOENT' }), probe: okProbe });
  const s = await h.status();
  assert.equal(s.state, 'unknown');
  assert.match(s.detail, /Could not run tailscale status/);
  const h2 = createTailnetHttps({ getLocalPort: () => 4871, run: fakeTailscale({ backend: 'Stopped' }).run, probe: okProbe });
  assert.equal((await h2.status()).state, 'tailscale-down');
});
