/* Agent Desk pipeline test — runs the full multi-agent orchestration with a
   stubbed Anthropic client (no network, no key) and the real analysis engine.
   Verifies: context gathering, all four stages, schema clamping, job lifecycle,
   per-day result caching, and the degraded fallback when a call fails. */
'use strict';
const assert = require('assert');

// real engine, loaded the same way server.js does
global.window = global.window || {};
require('../analysis');
const Q = global.window.Quantra;

// synthetic but realistic 180-bar uptrend with noise
const closes = []; let px = 100;
for (let i = 0; i < 180; i++) { px *= 1 + 0.0012 + Math.sin(i / 9) * 0.006; closes.push(px); }
const chart = { symbol: 'TEST', currency: 'USD', closes, highs: closes.map((c) => c * 1.01), lows: closes.map((c) => c * 0.99), dates: closes.map((_, i) => new Date(Date.now() - (180 - i) * 864e5).toISOString()) };

const api = {
  'stock/chart': async () => chart,
  'crypto/chart': async () => chart,
  'stock/fundamentals': async () => ({ symbol: 'TEST', name: 'Test Corp', sector: 'Technology', peTrailing: 21, roe: 0.24, revenueGrowth: 0.12 }),
  'stock/news': async () => [{ title: 'Test Corp beats earnings estimates', source: 'wire', time: new Date().toISOString() }, { title: 'Analysts raise Test Corp outlook', source: 'wire', time: new Date().toISOString() }],
};

// stub Anthropic: returns valid JSON for each schema; one analyst call fails on purpose
let calls = 0, failedOnce = false;
class FakeAnthropic {
  constructor() { this.messages = { create: async (req) => {
    calls++;
    const sys = req.system || '';
    if (sys.includes('Fundamental analyst') && !failedOnce) { failedOnce = true; throw new Error('simulated API error'); }
    let obj;
    if (sys.includes('bull researcher') || sys.includes('bear researcher')) obj = { thesis: 'T', points: ['a', 'b'], rebuttal: 'R' };
    else if (sys.includes('head trader')) obj = { stance: 'bullish', conviction: 140, horizon: '2-6 weeks', summary: 'S' };
    else if (sys.includes('risk manager')) obj = { approved: false, finalStance: 'neutral', riskNotes: ['n1'], invalidations: ['i1'] };
    else obj = { stance: 'bullish', confidence: 72, view: 'V', keyPoints: ['k1', 'k2'] };
    return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
  } }; }
}

(async () => {
  const desk = require('../agents').create({ Anthropic: FakeAnthropic, apiKey: 'test', model: 'test-model', api, Q });
  assert.ok(desk.enabled, 'desk enabled with all deps');

  const item = { type: 'stock', id: 'TEST', symbol: 'TEST', name: 'Test Corp' };
  assert.strictEqual(desk.cachedResult(item), null, 'no cached result before first run');

  const started = desk.start(item);
  assert.ok(started.ok && started.jobId && started.fresh, 'job starts fresh');
  const dupe = desk.start(item);
  assert.strictEqual(dupe.jobId, started.jobId, 'concurrent same-asset run dedupes to one job');
  assert.strictEqual(dupe.fresh, false, 'dupe not charged as fresh');

  // wait for completion
  let j;
  for (let i = 0; i < 100; i++) { j = desk.job(started.jobId); if (j.status !== 'running') break; await new Promise((r) => setTimeout(r, 50)); }
  assert.strictEqual(j.status, 'done', 'pipeline completes: ' + (j.error || 'ok'));
  assert.ok(j.steps.every((s) => s.state === 'done'), 'all steps done');

  const r = j.result;
  assert.strictEqual(r.analysts.length, 4, 'four analysts report');
  const fund = r.analysts.find((a) => a.key === 'fundamental');
  assert.ok(fund.degraded, 'failed analyst call degrades to local stub instead of killing the run');
  assert.strictEqual(r.personas.length, 3, 'three personas report');
  assert.ok(r.debate.bull && r.debate.bear, 'bull and bear both argue');
  assert.strictEqual(r.verdict.conviction, 100, 'conviction clamped to 0-100');
  assert.strictEqual(r.risk.approved, false, 'risk gate veto respected');
  assert.strictEqual(r.finalStance, 'neutral', 'final stance follows the risk veto');
  assert.ok(r.engine && r.engine.quantraScore >= 1, 'engine context attached');

  const hit = desk.cachedResult(item);
  assert.ok(hit && hit.asOf === r.asOf, 'finished run is cached for the day');
  assert.ok(calls >= 9, 'made the expected number of AI calls, got ' + calls);

  console.log('agents.test.js: all assertions passed (' + calls + ' stubbed AI calls)');
  process.exit(0);
})().catch((e) => { console.error('agents.test.js FAILED:', e); process.exit(1); });
