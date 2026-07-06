/* Quantra AI — analysis-engine invariant tests (no network, deterministic).
   Run: node test/engine.test.js — exits non-zero on any failure. */
'use strict';
global.window = {};
require('../analysis.js');
const Q = global.window.Quantra;

let failures = 0;
const ok = (cond, name, detail) => {
  if (cond) { console.log('  ✓', name); }
  else { failures++; console.error('  ✗', name, detail != null ? '— ' + detail : ''); }
};

// deterministic synthetic price series (seeded LCG — no Math.random)
function series(n, seed, vol) {
  let s = seed, p = 100; const out = [p];
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < n; i++) { p *= Math.exp((rnd() - 0.5) * (vol || 0.02)); out.push(p); }
  return out;
}
const closes = series(220, 42);

console.log('engine.test.js');

/* ---- indicators vs independent implementations ---- */
{
  const s = Q.series(closes);
  const sma20 = closes.slice(-20).reduce((a, v) => a + v, 0) / 20;
  ok(Math.abs(s.sma20[s.sma20.length - 1] - sma20) < 1e-9, 'SMA20 matches independent calc');
  const rsi = s.rsi14[s.rsi14.length - 1];
  ok(rsi > 0 && rsi < 100, 'RSI14 in (0,100)', rsi);
  ok(s.sma20.slice(0, 18).every((v) => v == null), 'SMA20 leads with nulls (window warm-up)');
}

/* ---- forecast invariants ---- */
{
  const f = Q.forecast(closes, 30, 0);
  ok(!!f, 'forecast returns');
  ok(f.mid.length === 30 && f.lo.length === 30 && f.hi.length === 30, 'arrays span horizon');
  let nested = true;
  for (let i = 0; i < 30; i++) if (!(f.lo[i] <= f.lo25[i] && f.lo25[i] <= f.mid[i] && f.mid[i] <= f.hi75[i] && f.hi75[i] <= f.hi[i])) nested = false;
  ok(nested, 'bands nested lo<=lo25<=mid<=hi75<=hi at every step');
  ok(f.probUp >= 0 && f.probUp <= 1, 'probUp in [0,1]', f.probUp);
  ok(Math.abs(f.p0 - closes[closes.length - 1]) < 1e-9, 'anchored to last close');
  ok(f.horizons.length >= 3 && f.horizons[0].bars < f.horizons[f.horizons.length - 1].bars, 'near-term checkpoint first');
  ok(f.horizons.every((h) => h.lo <= h.move && h.move <= h.hi), 'horizon rows consistent');

  // determinism: same inputs → identical projected values (seeded MC)
  const g = Q.forecast(closes, 30, 0);
  ok(f.mid.every((v, i) => v === g.mid[i]), 'deterministic: identical run-to-run');
  // sensitivity: different data / news bias must change the path
  const h2 = Q.forecast(closes.slice(0, 200), 30, 0);
  ok(h2.mid[29] !== f.mid[29], 'different data → different path');
  const b = Q.forecast(closes, 30, 5);
  ok(b.mid[29] !== f.mid[29], 'news bias shifts path');
  // calibration clamps
  ok(Q.forecast(closes, 30, 0, { cal: 9 }).calScale === 1.35, 'cal clamps high at 1.35');
  ok(Q.forecast(closes, 30, 0, { cal: 0 }).calScale >= 0.8, 'cal clamps low at 0.8');
  // wider cal → wider band
  const w1 = f.hi[29] - f.lo[29], w2 = (() => { const x = Q.forecast(closes, 30, 0, { cal: 1.3 }); return x.hi[29] - x.lo[29]; })();
  ok(w2 > w1, 'calibration widens band');
}

/* ---- analyze end-to-end on synthetic OHLC ---- */
{
  const highs = closes.map((c) => c * 1.01), lows = closes.map((c) => c * 0.99), opens = closes.map((c, i) => (i ? closes[i - 1] : c));
  const a = Q.analyze({ closes, highs, lows, opens, volumes: closes.map(() => 1000) }, 'TEST', null, null);
  ok(!!a, 'analyze returns');
  ok(a.indicators.support <= a.price && a.price <= a.indicators.resistance, 'support<=price<=resistance');
  ok(a.verdict && typeof a.verdict.confidence === 'string', 'verdict present');
  ok(a.quantraScore >= 1 && a.quantraScore <= 99, 'Quantra Score in [1,99]', a.quantraScore);
}

/* ---- sentiment lexicon ---- */
{
  const pos = Q.sentiment([{ title: 'Shares surge after record profit beat' }]);
  const neg = Q.sentiment([{ title: 'Stock plunges on fraud probe and layoffs' }]);
  ok(pos.score > 0, 'positive headline scores > 0', pos.score);
  ok(neg.score < 0, 'negative headline scores < 0', neg.score);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall engine tests passed');
process.exit(failures ? 1 : 0);
