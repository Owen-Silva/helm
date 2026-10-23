// Mock data for `eta.accuracy` in the browser mock mode (?mock=1), same shape as the engine's
// (main/engine/eta-accuracy.js readEtaHistory): 40 finished tasks over 12 days, deterministic, noisy early
// and steadier lately, so the Estimates section shows a trend. Owner: lane eta-accuracy.
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export function mockEtaAccuracy() {
  const now = Date.now();
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const sizes = [5, 12, 20, 30, 45, 60, 90, 120];
  const projects = ['helm', 'api-server', 'storefront', 'blog'];
  const records = [];
  for (let i = 0; i < 40; i++) {
    const first = sizes[Math.floor(rnd() * sizes.length)];
    const spread = i < 20 ? 1.1 : 0.45;
    const took = Math.max(0.5, Math.round(first * 0.8 * Math.exp((rnd() * 2 - 1) * spread) * 10) / 10);
    const finishedAt = now - (12 * DAY) + i * (12 * DAY / 40) + Math.round(rnd() * 3 * 3600_000);
    const factor = i < 6 ? null : 0.75;
    records.push({
      first, took, firstAt: finishedAt - took * MIN, finishedAt, factor,
      range: i >= 30 ? [Math.round(first * 0.5 * 10) / 10, Math.round(first * 1.3 * 10) / 10] : null,
      end: rnd() < 0.85 ? 'done' : 'idle', project: projects[i % projects.length], session: 'mock' + (i % 5),
      reEstimates: Math.floor(rnd() * 4), factorSrc: 'shown',
    });
  }
  records.sort((a, b) => a.finishedAt - b.finishedAt);
  return { file: 'C:\\Users\\you\\.claude\\mods-data\\eta\\history.jsonl', missing: false, records, bad: 0, size: 12_345, mtimeMs: now };
}
