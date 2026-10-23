// Per-agent context % in Helm (main/engine/fleet.js onUsage -> util.contextFrom) must say the same thing as the user's
// own checker, ~/.claude/tools/agent-context.js, for the same transcript: same token sum (input + cache_creation +
// cache_read + output of the latest assistant turn), same window (1M for an Opus 5 model, or once any request in
// the transcript passed 200k; else 200k), same percent. Fixture transcripts are written to a temp dir, measured by
// the real tool (skipped when it is not on this machine) and replayed through a Fleet.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Fleet } = require('../../main/engine/fleet');
const { contextLevel, CONTEXT_HANDOFF_PCT, CONTEXT_CEILING_PCT } = require('../../ui/lib/context-limits.js');

const TOOL = path.join(os.homedir(), '.claude', 'tools', 'agent-context.js');
const HAVE_TOOL = fs.existsSync(TOOL);

const u = (input, cacheCreate, cacheRead, output) => ({ input_tokens: input, cache_creation_input_tokens: cacheCreate, cache_read_input_tokens: cacheRead, output_tokens: output });

// name -> { model, usages (oldest first) }
const CASES = {
  'opus-12': { model: 'claude-opus-5-5', usages: [u(3, 20_000, 0, 400), u(2, 4_000, 96_000, 1_234), u(1, 2_100, 117_000, 900)] },
  'opus-33': { model: 'claude-opus-5-5', usages: [u(5, 30_000, 200_000, 800), u(1, 1_500, 330_500, 1_111)] },
  'opus-41': { model: 'claude-opus-5-5', usages: [u(1, 5_000, 380_000, 700), u(2, 3_333, 408_000, 1_010)] },
  'small-12': { model: 'claude-3-haiku-20240307', usages: [u(10, 4_000, 10_000, 300), u(4, 1_000, 22_500, 500)] },
  // a 200k-window model id, but one request passed 200k: the window must have been 1M
  'peak-proves-1m': { model: 'claude-3-haiku-20240307', usages: [u(1, 10_000, 240_000, 500), u(1, 2_000, 118_000, 600)] },
};

function writeFixture(dir, name, { model, usages }) {
  const sid = 'fixture-session';
  const t0 = Date.parse('2026-10-08T12:00:00Z');
  const lines = [JSON.stringify({ parentUuid: null, sessionId: sid, type: 'user', timestamp: new Date(t0).toISOString(), message: { role: 'user', content: `[lane:${name}] fixture brief` } })];
  usages.forEach((usage, i) => {
    lines.push(JSON.stringify({ parentUuid: `p${i}`, sessionId: sid, type: 'assistant', timestamp: new Date(t0 + (i + 1) * 60_000).toISOString(),
      message: { id: `m${i}`, role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], usage } }));
    lines.push(JSON.stringify({ parentUuid: `a${i}`, sessionId: sid, type: 'user', timestamp: new Date(t0 + (i + 1) * 60_000 + 1).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x' }] } }));
  });
  const file = path.join(dir, `agent-${name}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// What the tool prints for one file: "agent-<name>   33.4%   334k of 1000k  HAND OFF SOON ..."
function toolMeasure(file) {
  const out = execFileSync(process.execPath, [TOOL, file], { encoding: 'utf8' });
  const m = /(\d+\.\d)%\s+(\d+)k of (\d+)k\s+(OVER 40%|HAND OFF SOON|ok)/.exec(out);
  assert.ok(m, `agent-context.js output not understood: ${out}`);
  return { pct: Number(m[1]), usedK: Number(m[2]), windowK: Number(m[3]), flag: m[4] };
}

// Helm: replay the transcript's assistant usages into a Fleet the way the live stream does.
function helmMeasure({ model, usages }) {
  const fleet = new Fleet('s1', () => {});
  fleet.onToolStart({ name: 'Agent', toolUseId: 'tu1', status: 'running', ts: 1, input: { description: '[lane:x] fixture', subagent_type: 'opus-high' } });
  for (const usage of usages) fleet.onUsage('tu1', usage, model);
  return fleet.agents.get('tu1').context;
}

test('agent context % matches ~/.claude/tools/agent-context.js on fixture transcripts', { skip: !HAVE_TOOL && 'agent-context.js is not on this machine' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-ctx-match-'));
  try {
    for (const [name, c] of Object.entries(CASES)) {
      const tool = toolMeasure(writeFixture(dir, name, c));
      const helm = helmMeasure(c);
      assert.equal(helm.windowTokens / 1000, tool.windowK, `${name}: window`);
      assert.equal(Math.round(helm.usedTokens / 1000), tool.usedK, `${name}: tokens used`);
      assert.ok(Math.abs(helm.percent - tool.pct) <= 0.05, `${name}: Helm ${helm.percent}% vs tool ${tool.pct}%`);
      // and the same verdict: tool "ok" | "HAND OFF SOON" | "OVER 40%" <-> Helm '' | warn | danger
      assert.equal({ '': 'ok', warn: 'HAND OFF SOON', danger: 'OVER 40%' }[contextLevel(helm.percent)], tool.flag, `${name}: verdict`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the expected numbers for the fixtures (independent of the tool)', () => {
  const pct = (name) => helmMeasure(CASES[name]).percent;
  assert.equal(pct('opus-12'), 12);
  assert.equal(pct('opus-33'), 33.3);
  assert.equal(pct('opus-41'), 41.2);
  assert.equal(pct('small-12'), 12);
  assert.equal(helmMeasure(CASES['peak-proves-1m']).windowTokens, 1_000_000);
  assert.equal(pct('peak-proves-1m'), 12.1);
});

test('classification: below 32 neutral, 32 up to 40 amber (warn), 40 and up red (danger)', () => {
  assert.equal(CONTEXT_HANDOFF_PCT, 32);
  assert.equal(CONTEXT_CEILING_PCT, 40);
  for (const [p, want] of [[0, ''], [12, ''], [31.9, ''], [32, 'warn'], [33.4, 'warn'], [39.99, 'warn'], [40, 'danger'], [41.2, 'danger'], [100, 'danger'],
    [null, ''], [undefined, ''], ['', ''], [NaN, ''], ['34', 'warn']]) {
    assert.equal(contextLevel(p), want, `contextLevel(${p})`);
  }
});
