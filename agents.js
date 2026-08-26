/* ============================================================
   Quantra Agent Desk — multi-agent AI analysis pipeline.

   Ports the TradingAgents research pattern (parallel analysts →
   bull/bear researcher debate → trader synthesis → risk gate) and
   ai-hedge-fund-style investor personas natively onto the Claude
   API — no Python sidecar, no new dependencies. Runs entirely on
   Quantra's own market-data handlers and analysis engine.

   References (architecture only, no code copied):
   - TauricResearch/TradingAgents (Apache-2.0)
   - virattt/ai-hedge-fund (MIT)

   One run ≈ 10 Claude calls. Jobs are in-memory (lost on restart —
   acceptable: results are cached per symbol/day and cheap to rerun).
   ============================================================ */
'use strict';

const crypto = require('crypto');

const RESULT_TTL = 6 * 60 * 60 * 1000;   // reuse a finished desk read for 6h
const JOB_TTL = 30 * 60 * 1000;          // forget job records after 30 min
const MAX_ACTIVE = 2;                    // whole-process concurrent runs (free-tier RAM)

const GUARDRAILS = ' Be candid about uncertainty and disagreement. Never give explicit buy/sell instructions, position sizes, actionable price targets or guarantees — frame everything as analytical stance, not advice. No markdown.';

const STANCE = { type: 'string', enum: ['bullish', 'neutral', 'bearish'] };
const ANALYST_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['stance', 'confidence', 'view', 'keyPoints'],
  properties: { stance: STANCE, confidence: { type: 'number' }, view: { type: 'string' }, keyPoints: { type: 'array', items: { type: 'string' } } },
};
const DEBATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['thesis', 'points', 'rebuttal'],
  properties: { thesis: { type: 'string' }, points: { type: 'array', items: { type: 'string' } }, rebuttal: { type: 'string' } },
};
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['stance', 'conviction', 'horizon', 'summary'],
  properties: { stance: STANCE, conviction: { type: 'number' }, horizon: { type: 'string' }, summary: { type: 'string' } },
};
const RISK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['approved', 'finalStance', 'riskNotes', 'invalidations'],
  properties: { approved: { type: 'boolean' }, finalStance: STANCE, riskNotes: { type: 'array', items: { type: 'string' } }, invalidations: { type: 'array', items: { type: 'string' } } },
};

const ANALYSTS = [
  { key: 'technical', label: 'Technical analyst', focus: 'ONLY the technical picture: trend, momentum (RSI/MACD/ADX), moving-average structure, volatility, support/resistance, and the walk-forward signal accuracy. Ignore fundamentals and news.' },
  { key: 'fundamental', label: 'Fundamental analyst', focus: 'ONLY fundamentals: valuation (P/E, P/B), profitability (margins, ROE), growth, balance-sheet health, analyst estimates. If fundamentals are absent (e.g. crypto or index), assess what CAN be said (adoption proxies, flows) and say the rest is unknowable from the data given.' },
  { key: 'news', label: 'News & sentiment analyst', focus: 'ONLY the supplied headlines and computed news sentiment: what is the market narrative right now, does it support or contradict the price action, and is any headline material enough to dominate the near term?' },
  { key: 'macro', label: 'Macro & regime analyst', focus: 'ONLY market regime and context: the measured regime (trending/ranging/volatile), annualized volatility, the Monte-Carlo probability distribution, and what that regime implies for how much to trust trend-following vs mean-reversion here.' },
];

// ai-hedge-fund-style personas — archetypes, deliberately NOT named after real people.
const PERSONAS = [
  { key: 'value', label: 'Deep-value investor', brief: 'a patient deep-value investor: margin of safety, durable earnings power, balance-sheet strength, skepticism of stories and multiples detached from cash flow' },
  { key: 'growth', label: 'Growth & innovation investor', brief: 'a growth investor: secular trends, revenue acceleration, market-size expansion, willing to pay up for compounding but alert to broken growth stories' },
  { key: 'contrarian', label: 'Contrarian risk-taker', brief: 'a contrarian short-seller temperament: hunts for crowd euphoria, leverage, deteriorating internals and asymmetric downside; equally willing to call a washed-out bottom' },
];

function create({ Anthropic, apiKey, model, api, Q }) {
  const enabled = !!(Anthropic && apiKey && model && api);
  const jobs = new Map();      // jobId → job
  const running = new Map();   // cacheKey → jobId (dedupe concurrent runs of the same asset)
  const results = new Map();   // cacheKey → { t, result }
  let active = 0;

  const day = () => new Date().toISOString().slice(0, 10);
  const keyOf = (item) => `${item.type}:${String(item.id || item.symbol).toLowerCase()}:${day()}`;
  const newId = () => 'agj_' + crypto.randomBytes(8).toString('hex');

  function prune() {
    const now = Date.now();
    for (const [k, v] of results) if (now - v.t > RESULT_TTL) results.delete(k);
    for (const [k, j] of jobs) if (now - j.startedAt > JOB_TTL) { jobs.delete(k); }
    for (const [k, id] of running) if (!jobs.has(id)) running.delete(k);
  }

  async function ask(client, sys, user, schema, maxTokens) {
    const msg = await client.messages.create({
      model, max_tokens: maxTokens, system: sys + GUARDRAILS,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema } },
    });
    const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return JSON.parse(text);
  }

  /* ---- context: one compact JSON built from Quantra's own data + engine ---- */
  async function gatherContext(item) {
    const isCrypto = item.type === 'crypto';
    const [chart, fundamentals, news] = await Promise.all([
      isCrypto ? api['crypto/chart']({ id: item.id, days: '180' }) : api['stock/chart']({ symbol: item.id, range: '6mo', interval: '1d' }),
      (!isCrypto && item.type === 'stock') ? api['stock/fundamentals']({ symbol: item.id }).catch(() => null) : Promise.resolve(null),
      api['stock/news']({ symbol: isCrypto ? item.symbol : item.id }).catch(() => []),
    ]);
    const sent = Q && news && news.length ? Q.sentiment(news) : null;
    const a = Q ? Q.analyze(chart, item.symbol, fundamentals, sent) : null;
    const f = fundamentals || {};
    const fc = a && a.forecast;
    return {
      asset: { symbol: item.symbol, name: item.name || item.symbol, type: item.type, currency: chart.currency || (isCrypto ? 'USD' : 'USD'), price: a ? a.price : (chart.closes || []).at(-1) },
      quantraEngine: !a ? null : {
        quantraScore: a.quantraScore, grade: a.scoreGrade, regime: a.regime,
        signals: (a.signals || []).map((s) => ({ name: s.name, dir: s.dir })),
        walkForward: a.walkForward ? { outOfSampleAccuracy: a.walkForward.oosAccuracy, testTrades: a.walkForward.testTrades } : null,
        monteCarlo: fc ? { probUp: fc.probUp, probUp10: fc.probUp10, probDown10: fc.probDown10, annualVol: fc.annualVol, horizon: fc.horizon } : null,
        technical: a.technical ? { rsi: a.technical.rsiV, adx: a.technical.adxV && a.technical.adxV.adx, score: a.technical.scoreNorm, support: a.technical.support, resistance: a.technical.resistance } : null,
      },
      fundamentals: !fundamentals ? null : {
        sector: f.sector, industry: f.industry, marketCap: f.marketCap, peTrailing: f.peTrailing, peForward: f.peForward,
        pb: f.pb, eps: f.eps, dividendYield: f.dividendYield, beta: f.beta, roe: f.roe, profitMargin: f.profitMargin,
        debtToEquity: f.debtToEquity, revenueGrowth: f.revenueGrowth, earningsGrowth: f.earningsGrowth,
        analystRecommendation: f.recommendation, analystCount: f.analystCount, recBreakdown: f.recBreakdown,
        estimates: f.estimates, high52: f.high52, low52: f.low52,
      },
      newsSentiment: sent ? { score: sent.score, label: sent.label, scoredHeadlines: sent.count } : null,
      headlines: (news || []).slice(0, 10).map((n) => ({ title: n.title, source: n.source || n.publisher || '', time: n.time || '' })),
    };
  }

  /* ---- the pipeline ---- */
  async function run(job, item) {
    const client = new Anthropic({ apiKey });
    const ctx = job.ctx = await gatherContext(item);
    step(job, 'context', 'done');
    const ctxJson = JSON.stringify(ctx, null, 1);
    const who = `${ctx.asset.symbol} (${ctx.asset.name})`;

    // Stage 1 — four specialist analysts + three investor personas, all in parallel.
    step(job, 'analysts', 'run');
    const analystCalls = ANALYSTS.map((an) =>
      ask(client,
        `You are the ${an.label} on Quantra's AI agent desk. Assess ${who} from your lane: ${an.focus} Return JSON: "stance", "confidence" (0-100), "view" (3-4 plain sentences), "keyPoints" (2-4 short bullets).`,
        'Market context:\n' + ctxJson, ANALYST_SCHEMA, 450)
        .then((r) => ({ ...an, ...clampAnalyst(r) }))
        .catch(() => ({ ...an, ...stubAnalyst(ctx) })));
    const personaCalls = PERSONAS.map((pe) =>
      ask(client,
        `You are ${pe.brief}, giving a house view on Quantra's AI agent desk. Judge ${who} strictly through that lens using only the supplied data. Return JSON: "stance", "confidence" (0-100), "view" (2-3 plain sentences in that investor's voice, no impersonation of real people), "keyPoints" (2-3 short bullets).`,
        'Market context:\n' + ctxJson, ANALYST_SCHEMA, 400)
        .then((r) => ({ key: pe.key, label: pe.label, ...clampAnalyst(r) }))
        .catch(() => null));
    const [analysts, personas] = await Promise.all([Promise.all(analystCalls), Promise.all(personaCalls)]);
    job.result.analysts = analysts;
    job.result.personas = personas.filter(Boolean);
    step(job, 'analysts', 'done');

    // Stage 2 — bull and bear researchers debate over the analyst reports.
    step(job, 'debate', 'run');
    const reports = JSON.stringify(analysts.map((a) => ({ role: a.label, stance: a.stance, confidence: a.confidence, view: a.view, keyPoints: a.keyPoints })), null, 1);
    const debateInput = `Analyst reports for ${who}:\n${reports}\n\nKey engine stats:\n` + JSON.stringify(ctx.quantraEngine, null, 1);
    const [bull, bear] = await Promise.all([
      ask(client, `You are the bull researcher debating ${who}. Build the strongest honest bullish case from the analyst reports, and pre-empt the bear's best argument. Return JSON: "thesis" (2-3 sentences), "points" (3-4 bullets), "rebuttal" (1-2 sentences answering the likely bear case).`, debateInput, DEBATE_SCHEMA, 500).catch(() => null),
      ask(client, `You are the bear researcher debating ${who}. Build the strongest honest bearish case from the analyst reports, and pre-empt the bull's best argument. Return JSON: "thesis" (2-3 sentences), "points" (3-4 bullets), "rebuttal" (1-2 sentences answering the likely bull case).`, debateInput, DEBATE_SCHEMA, 500).catch(() => null),
    ]);
    job.result.debate = { bull, bear };
    step(job, 'debate', 'done');

    // Stage 3 — trader synthesizes analysts + debate + persona votes into one stance.
    step(job, 'verdict', 'run');
    const verdictInput = debateInput +
      `\n\nBull case:\n${JSON.stringify(bull, null, 1)}\n\nBear case:\n${JSON.stringify(bear, null, 1)}` +
      `\n\nInvestor persona votes:\n${JSON.stringify(job.result.personas.map((p) => ({ persona: p.label, stance: p.stance, confidence: p.confidence })), null, 1)}`;
    let verdict = await ask(client,
      `You are the head trader on Quantra's AI agent desk. Weigh the analyst reports, the bull/bear debate and the persona votes for ${who}, and commit to one analytical stance. Reward arguments grounded in the measured data (walk-forward accuracy, regime, Monte-Carlo odds) over narrative. Return JSON: "stance", "conviction" (0-100), "horizon" (e.g. "2-6 weeks"), "summary" (4-5 plain sentences explaining the call and the strongest counter-argument).`,
      verdictInput, VERDICT_SCHEMA, 550).catch(() => null);
    if (!verdict) verdict = stubVerdict(ctx, analysts);
    verdict.conviction = clampNum(verdict.conviction, 0, 100, 50);
    job.result.verdict = verdict;
    step(job, 'verdict', 'done');

    // Stage 4 — risk gate reviews the trader's call against measured risk.
    step(job, 'risk', 'run');
    const risk = await ask(client,
      `You are the risk manager gating the trader's call on ${who}. Review the proposed stance against measured volatility, regime, Monte-Carlo downside odds and data quality. "approved"=false only if the call materially overreaches the evidence; then set "finalStance" to what the evidence supports (often neutral). Return JSON: "approved", "finalStance", "riskNotes" (2-4 bullets on the main risks), "invalidations" (1-3 observable conditions that would invalidate this read).`,
      `Trader verdict:\n${JSON.stringify(verdict, null, 1)}\n\nEngine stats:\n${JSON.stringify(ctx.quantraEngine, null, 1)}`,
      RISK_SCHEMA, 450).catch(() => null);
    job.result.risk = risk || { approved: true, finalStance: verdict.stance, riskNotes: ['Risk review unavailable — treat conviction with extra caution.'], invalidations: [] };
    step(job, 'risk', 'done');

    job.result.finalStance = job.result.risk.approved ? verdict.stance : job.result.risk.finalStance;
    job.result.asOf = Date.now();
    job.result.asset = ctx.asset;
    job.result.engine = ctx.quantraEngine;
  }

  /* ---- degraded fallbacks so a single failed call never kills the run ---- */
  const dirStance = (n) => (n > 0.15 ? 'bullish' : n < -0.15 ? 'bearish' : 'neutral');
  const clampNum = (n, lo, hi, dflt) => { n = Number(n); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
  function clampAnalyst(r) {
    return { stance: ['bullish', 'neutral', 'bearish'].includes(r.stance) ? r.stance : 'neutral', confidence: clampNum(r.confidence, 0, 100, 50), view: String(r.view || '').slice(0, 1200), keyPoints: (Array.isArray(r.keyPoints) ? r.keyPoints : []).slice(0, 4).map((s) => String(s).slice(0, 200)) };
  }
  function stubAnalyst(ctx) {
    const e = ctx.quantraEngine;
    const sc = e && e.technical ? e.technical.score : 0;
    return { stance: dirStance(sc), confidence: 40, view: 'AI unavailable for this lane — falling back to the local engine read.', keyPoints: e ? [`Quantra score ${e.quantraScore}`, `Regime: ${e.regime && e.regime.label}`] : [], degraded: true };
  }
  function stubVerdict(ctx, analysts) {
    const votes = { bullish: 0, neutral: 0, bearish: 0 };
    analysts.forEach((a) => { votes[a.stance] = (votes[a.stance] || 0) + 1; });
    const stance = votes.bullish > votes.bearish ? 'bullish' : votes.bearish > votes.bullish ? 'bearish' : 'neutral';
    return { stance, conviction: 45, horizon: '2-6 weeks', summary: 'AI synthesis unavailable — stance is a simple majority vote of the analyst agents.', degraded: true };
  }

  function step(job, key, state) {
    const s = job.steps.find((x) => x.key === key);
    if (s) s.state = state;
  }

  /* ---- public surface ---- */
  function cachedResult(item) {
    prune();
    const hit = results.get(keyOf(item));
    return hit ? hit.result : null;
  }

  function start(item) {
    prune();
    if (!enabled) return { ok: false, reason: 'no-ai' };
    const k = keyOf(item);
    const dupe = running.get(k);
    if (dupe && jobs.has(dupe)) return { ok: true, jobId: dupe, fresh: false };
    if (active >= MAX_ACTIVE) return { ok: false, reason: 'busy' };
    const job = {
      id: newId(), status: 'running', startedAt: Date.now(),
      steps: [
        { key: 'context', label: 'Gathering market context', state: 'run' },
        { key: 'analysts', label: 'Analyst & persona round (7 agents)', state: 'wait' },
        { key: 'debate', label: 'Bull vs bear debate', state: 'wait' },
        { key: 'verdict', label: 'Trader synthesis', state: 'wait' },
        { key: 'risk', label: 'Risk-manager gate', state: 'wait' },
      ],
      result: {},
    };
    jobs.set(job.id, job);
    running.set(k, job.id);
    active++;
    run(job, item)
      .then(() => { job.status = 'done'; results.set(k, { t: Date.now(), result: job.result }); })
      .catch((e) => { job.status = 'error'; job.error = String(e && e.message || e); })
      .finally(() => { active = Math.max(0, active - 1); running.delete(k); });
    return { ok: true, jobId: job.id, fresh: true };
  }

  function jobState(id) {
    const j = jobs.get(String(id || ''));
    if (!j) return null;
    return { ok: true, status: j.status, steps: j.steps, error: j.error || null, result: j.status === 'done' ? j.result : null };
  }

  return { enabled, start, job: jobState, cachedResult };
}

module.exports = { create };
