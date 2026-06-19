/* ============================================================
   Quantra AI — analysis engine v3
   Deep technical suite + fundamentals + backtested accuracy +
   ensemble forecast.  Pure functions, real data in.
   ============================================================ */
window.Quantra = (function () {
  'use strict';
  const last = (a) => a[a.length - 1];
  const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : 0);
  function gauss() { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  const pctile = (arr, q) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * a.length)))]; };

  /* ---------------- core indicators ---------------- */
  function smaAt(arr, end, n) { if (end + 1 < n) return null; let s = 0; for (let i = end - n + 1; i <= end; i++) s += arr[i]; return s / n; }
  function sma(arr, n) { return smaAt(arr, arr.length - 1, n); }

  function emaArray(arr, n) {
    if (arr.length < n) return arr.map(() => null);
    const k = 2 / (n + 1), out = new Array(arr.length).fill(null);
    let e = mean(arr.slice(0, n)); out[n - 1] = e;
    for (let i = n; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out[i] = e; }
    return out;
  }
  function ema(arr, n) { return last(emaArray(arr, n)); }

  function rsiAt(closes, end, n = 14) {
    if (end < n) return null;
    let g = 0, l = 0;
    for (let i = end - n + 1; i <= end; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
    const al = l / n; if (al === 0) return 100; return 100 - 100 / (1 + (g / n) / al);
  }
  const rsi = (closes, n = 14) => rsiAt(closes, closes.length - 1, n);

  function macd(closes, fast = 12, slow = 26, sig = 9) {
    if (closes.length < slow + sig) return null;
    const ef = emaArray(closes, fast), es = emaArray(closes, slow);
    const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
    const valid = line.filter((v) => v != null);
    const sigArr = emaArray(valid, sig);
    const signal = last(sigArr), macdLine = last(valid);
    const prevHist = (valid[valid.length - 2] ?? macdLine) - (sigArr[sigArr.length - 2] ?? signal);
    return { macd: macdLine, signal, hist: macdLine - signal, prevHist };
  }

  function bollinger(closes, n = 20, k = 2) {
    if (closes.length < n) return null;
    const slice = closes.slice(-n), m = mean(slice);
    const sd = Math.sqrt(mean(slice.map((v) => (v - m) ** 2)));
    const upper = m + k * sd, lower = m - k * sd, price = last(closes);
    return { mid: m, upper, lower, pctB: (price - lower) / (upper - lower || 1), bandwidth: (upper - lower) / m };
  }

  function atr(highs, lows, closes, n = 14) {
    if (closes.length < n + 1) return null;
    const tr = [];
    for (let i = 1; i < closes.length; i++) tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    return mean(tr.slice(-n));
  }

  function stochastic(highs, lows, closes, n = 14) {
    if (closes.length < n) return null;
    const hh = Math.max(...highs.slice(-n)), ll = Math.min(...lows.slice(-n));
    const k = ((last(closes) - ll) / (hh - ll || 1)) * 100;
    // %D = 3-period sma of %K
    const ks = [];
    for (let j = 0; j < 3; j++) {
      const end = closes.length - 1 - j; if (end < n - 1) break;
      const h = Math.max(...highs.slice(end - n + 1, end + 1)), l = Math.min(...lows.slice(end - n + 1, end + 1));
      ks.push(((closes[end] - l) / (h - l || 1)) * 100);
    }
    return { k, d: mean(ks) };
  }

  function adx(highs, lows, closes, n = 14) {
    if (closes.length < n * 2) return null;
    const tr = [], pDM = [], mDM = [];
    for (let i = 1; i < closes.length; i++) {
      const up = highs[i] - highs[i - 1], dn = lows[i - 1] - lows[i];
      pDM.push(up > dn && up > 0 ? up : 0); mDM.push(dn > up && dn > 0 ? dn : 0);
      tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    }
    const atrN = mean(tr.slice(-n)) || 1;
    const pDI = (mean(pDM.slice(-n)) / atrN) * 100, mDI = (mean(mDM.slice(-n)) / atrN) * 100;
    const dx = (Math.abs(pDI - mDI) / (pDI + mDI || 1)) * 100;
    return { adx: dx, pDI, mDI };
  }

  function obvTrend(closes, volumes) {
    if (!volumes || volumes.length < 12 || volumes.every((v) => !v)) return null;
    const obv = [0];
    for (let i = 1; i < closes.length; i++) obv.push(obv[i - 1] + (closes[i] > closes[i - 1] ? volumes[i] : closes[i] < closes[i - 1] ? -volumes[i] : 0));
    const recent = obv.slice(-15);
    return last(recent) - recent[0]; // >0 accumulation, <0 distribution
  }

  function slope(closes, look = 12) {
    const s = [];
    for (let i = closes.length - look; i < closes.length; i++) s.push(smaAt(closes, i, Math.min(20, i + 1)) || closes[i]);
    if (s.length < 2) return 0;
    return ((last(s) - s[0]) / s[0]) * 100;
  }

  function linReg(closes, look = 40) {
    const y = closes.slice(-look), n = y.length;
    const xs = y.map((_, i) => i), mx = mean(xs), my = mean(y);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (y[i] - my); den += (xs[i] - mx) ** 2; }
    const m = den ? num / den : 0, b = my - m * mx;
    return { slopePerBar: m, intercept: b, at: (i) => m * i + b, n };
  }

  /* ---------------- formatting ---------------- */
  function priceFmt(p) {
    if (p == null) return '—';
    if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (p >= 1) return p.toFixed(2);
    if (p >= 0.01) return p.toFixed(4);
    return p.toPrecision(3);
  }
  const pct = (x, d = 1) => (x == null ? '—' : (x * 100).toFixed(d) + '%');
  const capFmt = (n) => n == null ? '—' : n >= 1e12 ? '$' + (n / 1e12).toFixed(2) + 'T' : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : '$' + Math.round(n).toLocaleString();

  /* ---------------- per-date series (Excel) ---------------- */
  function series(closes) {
    const out = { sma20: [], sma50: [], sma200: [], rsi14: [] };
    for (let i = 0; i < closes.length; i++) {
      out.sma20.push(smaAt(closes, i, 20)); out.sma50.push(smaAt(closes, i, 50));
      out.sma200.push(smaAt(closes, i, 200)); out.rsi14.push(i >= 14 ? rsiAt(closes, i, 14) : null);
    }
    return out;
  }

  /* ---------------- signal voting ---------------- */
  function buildSignals(d) {
    const { price, s20, s50, s200, r, mac, boll, stoch, adxV, obv } = d;
    const sigs = [];
    const add = (name, dir, weight, note) => sigs.push({ name, dir, weight, note });

    if (s200 != null) add('Long-term trend', price > s200 ? 'up' : 'down', 1.3, price > s200 ? 'above 200-SMA' : 'below 200-SMA');
    if (s50 != null) add('MA cross', s20 > s50 ? 'up' : 'down', 1, s20 > s50 ? 'golden (20>50)' : 'death (20<50)');
    if (s20 != null) add('Price vs SMA20', price > s20 ? 'up' : 'down', 0.8, price > s20 ? 'above mean' : 'below mean');
    if (mac) add('MACD', mac.hist > 0 ? 'up' : 'down', 1, mac.hist > 0 ? (mac.prevHist <= 0 ? 'bullish cross' : 'positive') : (mac.prevHist >= 0 ? 'bearish cross' : 'negative'));
    if (r != null) add('RSI', r > 70 ? 'down' : r < 30 ? 'up' : r > 55 ? 'up' : r < 45 ? 'down' : 'flat', 0.9, `RSI ${Math.round(r)}${r > 70 ? ' overbought' : r < 30 ? ' oversold' : ''}`);
    if (stoch) add('Stochastic', stoch.k > 80 ? 'down' : stoch.k < 20 ? 'up' : stoch.k > stoch.d ? 'up' : 'down', 0.6, `%K ${Math.round(stoch.k)}`);
    if (boll) add('Bollinger', boll.pctB > 1 ? 'down' : boll.pctB < 0 ? 'up' : boll.pctB > 0.5 ? 'up' : 'down', 0.6, `%B ${boll.pctB.toFixed(2)}`);
    if (adxV) add('Trend strength', adxV.adx > 25 ? (adxV.pDI > adxV.mDI ? 'up' : 'down') : 'flat', 0.8, `ADX ${Math.round(adxV.adx)}${adxV.adx > 25 ? ' strong' : ' weak'}`);
    if (obv != null) add('Volume (OBV)', obv > 0 ? 'up' : 'down', 0.7, obv > 0 ? 'accumulation' : 'distribution');
    return sigs;
  }

  /* ---------------- technical snapshot ---------------- */
  function technical(ohlc) {
    const closes = ohlc.closes.filter((v) => v != null);
    const highs = (ohlc.highs && ohlc.highs.length ? ohlc.highs : closes).filter((v) => v != null);
    const lows = (ohlc.lows && ohlc.lows.length ? ohlc.lows : closes).filter((v) => v != null);
    const volumes = ohlc.volumes || [];
    if (closes.length < 18) return null;
    const price = last(closes);
    const d = {
      price, s20: sma(closes, 20), s50: sma(closes, 50) || sma(closes, Math.min(40, closes.length - 1)),
      s200: closes.length >= 200 ? sma(closes, 200) : null, r: rsi(closes, 14),
      mac: macd(closes), boll: bollinger(closes), stoch: stochastic(highs, lows, closes),
      atrV: atr(highs, lows, closes), adxV: adx(highs, lows, closes), obv: obvTrend(closes, volumes),
      slp: slope(closes), support: Math.min(...lows.slice(-30)), resistance: Math.max(...highs.slice(-30)),
    };
    const signals = buildSignals(d);
    const score = sum(signals.map((s) => (s.dir === 'up' ? s.weight : s.dir === 'down' ? -s.weight : 0)));
    const maxScore = sum(signals.map((s) => s.weight)) || 1;
    return { ...d, signals, score, scoreNorm: score / maxScore, bars: closes.length };
  }

  /* ---------------- fundamentals ---------------- */
  function fundamental(f) {
    if (!f) return null;
    let score = 0; const notes = [];
    if (f.peTrailing != null) { if (f.peTrailing > 0 && f.peTrailing < 18) { score += 1; notes.push(`reasonable P/E ${f.peTrailing.toFixed(1)}`); } else if (f.peTrailing > 45) { score -= 1; notes.push(`rich P/E ${f.peTrailing.toFixed(1)}`); } }
    if (f.roe != null) { if (f.roe > 0.15) { score += 1; notes.push(`strong ROE ${pct(f.roe)}`); } else if (f.roe < 0.05) { score -= 1; notes.push(`weak ROE ${pct(f.roe)}`); } }
    if (f.profitMargin != null) { if (f.profitMargin > 0.15) { score += 1; notes.push(`healthy margins ${pct(f.profitMargin)}`); } else if (f.profitMargin < 0) { score -= 1; notes.push('unprofitable'); } }
    if (f.debtToEquity != null) { if (f.debtToEquity < 60) score += 0.5; else if (f.debtToEquity > 150) { score -= 1; notes.push(`high leverage D/E ${Math.round(f.debtToEquity)}`); } }
    if (f.revenueGrowth != null) { if (f.revenueGrowth > 0.12) { score += 1; notes.push(`revenue +${pct(f.revenueGrowth)}`); } else if (f.revenueGrowth < 0) { score -= 1; notes.push('revenue declining'); } }
    if (f.earningsGrowth != null && f.earningsGrowth > 0.15) score += 0.5;
    const grade = score >= 2.5 ? 'Strong' : score >= 1 ? 'Solid' : score <= -1.5 ? 'Weak' : 'Mixed';
    return { score, grade, notes };
  }

  /* ---------------- backtest (the "learning") ----------------
     Replays the same trend logic across history and measures how
     often the bias matched the next `horizon`-bar move. Honest,
     per-asset hit-rate — no look-ahead. */
  function backtest(closes, horizon = 5) {
    if (closes.length < 80) return null;
    let total = 0, correct = 0, retSum = 0;
    for (let i = 60; i < closes.length - horizon; i++) {
      const s20 = smaAt(closes, i, 20), s50 = smaAt(closes, i, 50), r = rsiAt(closes, i, 14);
      if (s20 == null || s50 == null || r == null) continue;
      const bias = (closes[i] > s20 ? 1 : -1) + (s20 > s50 ? 1 : -1) + (r > 55 ? 1 : r < 45 ? -1 : 0);
      if (bias === 0) continue;
      const fwd = (closes[i + horizon] - closes[i]) / closes[i];
      total++;
      if ((bias > 0 && fwd > 0) || (bias < 0 && fwd < 0)) correct++;
      retSum += bias > 0 ? fwd : -fwd; // return if you'd followed the bias
    }
    if (total < 20) return null;
    return { trades: total, hitRate: correct / total, avgReturn: retSum / total, horizon };
  }

  /* ---------------- walk-forward weight learning ----------------
     Learn per-signal weights from the first 70% of history (train),
     then measure accuracy on the held-out 30% (out-of-sample). This
     is the honest "learning per asset" — weights adapt to what has
     actually worked on THIS instrument, validated on unseen bars. */
  function walkForward(closes, horizon = 5) {
    const n = closes.length;
    if (n < 160) return null;
    const ef = emaArray(closes, 12), es = emaArray(closes, 26);
    const s20 = [], s50 = [], s200 = [], rs = [], mac = [];
    for (let i = 0; i < n; i++) {
      s20.push(smaAt(closes, i, 20)); s50.push(smaAt(closes, i, 50)); s200.push(smaAt(closes, i, 200));
      rs.push(i >= 14 ? rsiAt(closes, i, 14) : null);
      mac.push(ef[i] != null && es[i] != null ? ef[i] - es[i] : null);
    }
    const keys = ['p20', 'cross', 'lt', 'rsi', 'macd'];
    const dirAt = (i) => ({
      p20: s20[i] == null ? 0 : Math.sign(closes[i] - s20[i]),
      cross: (s20[i] == null || s50[i] == null) ? 0 : Math.sign(s20[i] - s50[i]),
      lt: s200[i] == null ? 0 : Math.sign(closes[i] - s200[i]),
      rsi: rs[i] == null ? 0 : (rs[i] > 55 ? 1 : rs[i] < 45 ? -1 : 0),
      macd: mac[i] == null ? 0 : Math.sign(mac[i]),
    });
    const split = Math.floor(n * 0.7);
    const stat = {}; keys.forEach((k) => (stat[k] = { c: 0, t: 0 }));
    for (let i = 60; i < split - horizon; i++) {
      const d = dirAt(i), fwd = Math.sign(closes[i + horizon] - closes[i]);
      keys.forEach((k) => { if (d[k] !== 0) { stat[k].t++; if (d[k] === fwd) stat[k].c++; } });
    }
    const weights = {}, hits = {};
    keys.forEach((k) => { const hr = stat[k].t ? stat[k].c / stat[k].t : 0.5; hits[k] = hr; weights[k] = Math.max(0, (hr - 0.5) * 4); });
    // out-of-sample test with learned weights
    let tc = 0, tt = 0;
    for (let i = split; i < n - horizon; i++) {
      const d = dirAt(i); let sc = 0; keys.forEach((k) => (sc += d[k] * weights[k]));
      if (Math.abs(sc) < 1e-9) continue;
      tt++; if (Math.sign(sc) === Math.sign(closes[i + horizon] - closes[i])) tc++;
    }
    if (tt < 15) return null;
    const ranked = keys.map((k) => ({ k, hit: hits[k], weight: weights[k] })).sort((a, b) => b.weight - a.weight);
    const nameOf = { p20: 'Price vs SMA20', cross: 'MA cross', lt: 'Long-term trend', rsi: 'RSI', macd: 'MACD' };
    return { weights, hits, oosAccuracy: tc / tt, testTrades: tt, horizon,
      top: ranked.filter((r) => r.weight > 0).slice(0, 2).map((r) => ({ name: nameOf[r.k], hit: r.hit })) };
  }

  /* ---------------- ensemble forecast ---------------- */
  /* ---------------- news sentiment (finance lexicon) ---------------- */
  const POS = ['beat', 'beats', 'surge', 'surges', 'soar', 'soars', 'jump', 'jumps', 'rally', 'rallies', 'gain', 'gains', 'record', 'upgrade', 'upgrades', 'upgraded', 'raise', 'raises', 'raised', 'growth', 'profit', 'profits', 'strong', 'tops', 'outperform', 'bullish', 'expand', 'expands', 'partnership', 'wins', 'win', 'approval', 'approved', 'buyback', 'dividend', 'rises', 'rise', 'climbs', 'climb', 'boost', 'boosts', 'optimistic', 'rebound', 'breakout', 'momentum', 'positive', 'accelerates', 'tops'];
  const NEG = ['miss', 'misses', 'plunge', 'plunges', 'slump', 'slumps', 'sink', 'sinks', 'tumble', 'tumbles', 'drop', 'drops', 'fall', 'falls', 'decline', 'declines', 'downgrade', 'downgrades', 'downgraded', 'cut', 'cuts', 'loss', 'losses', 'lawsuit', 'probe', 'investigation', 'recall', 'weak', 'bearish', 'warns', 'warn', 'warning', 'fraud', 'layoff', 'layoffs', 'delay', 'delays', 'halt', 'halts', 'slash', 'slashes', 'plummet', 'plummets', 'concern', 'concerns', 'risk', 'risks', 'selloff', 'bankruptcy', 'default', 'crash', 'slowdown', 'sinks', 'negative', 'disappoint', 'disappoints', 'misses'];
  const wordIn = (t, w) => new RegExp('\\b' + w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + 's?\\b').test(t);
  function sentiment(items) {
    if (!items || !items.length) return null;
    let pos = 0, neg = 0; const scored = [];
    for (const n of items.slice(0, 15)) {
      const t = (n.title || '').toLowerCase(); let s = 0;
      for (const w of POS) if (wordIn(t, w)) s += 1;
      for (const w of NEG) if (wordIn(t, w)) s -= 1;
      const dir = s > 0 ? 'pos' : s < 0 ? 'neg' : 'neu';
      if (s > 0) pos++; else if (s < 0) neg++;
      scored.push({ title: n.title, link: n.link, publisher: n.publisher, time: n.time, s, dir });
    }
    const total = scored.length;
    const score = Math.max(-1, Math.min(1, ((pos - neg) / total) * 1.5));
    const label = score > 0.15 ? 'Positive' : score < -0.15 ? 'Negative' : 'Neutral';
    return { score, label, pos, neg, neu: total - pos - neg, count: total, scored };
  }

  /* ---------------- lite score (fast, for the screener) ---------------- */
  function liteScore(spark, change) {
    const c = (spark || []).filter((v) => v != null);
    if (c.length < 6) return null;
    const lastP = c[c.length - 1], firstP = c[0], mid = c[Math.floor(c.length / 2)];
    const ret = (lastP - firstP) / firstP;
    const recent = (lastP - mid) / mid;
    let g = 0, l = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
    const rs = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    let s = 50;
    s += Math.max(-20, Math.min(20, ret * 120));
    s += Math.max(-12, Math.min(12, recent * 200));
    s += Math.max(-8, Math.min(8, (change || 0) * 0.6));
    if (rs > 72) s -= 6; else if (rs < 28) s += 6; else if (rs > 55) s += 5; else if (rs < 45) s -= 5;
    return Math.max(1, Math.min(99, Math.round(s)));
  }
  const scoreGrade = (q) => (q == null ? '—' : q >= 70 ? 'Strong' : q >= 56 ? 'Bullish' : q >= 45 ? 'Neutral' : q >= 30 ? 'Bearish' : 'Weak');

  function forecast(closes, horizon = 30, bias = 0) {
    const c = closes.filter((v) => v != null);
    if (c.length < 18) return null;
    const rets = [];
    for (let i = 1; i < c.length; i++) rets.push(Math.log(c[i] / c[i - 1]));
    // Sample real recent returns (keeps fat tails + skew the markets actually have).
    const pool = rets.slice(-120);
    const mu = mean(pool);
    const sigma = Math.sqrt(mean(pool.map((x) => (x - mu) ** 2))) || 1e-6;
    // Markets ≈ random walk: a short window's drift is mostly noise and rarely
    // persists, so shrink it hard toward 0 and cap it (this removes the directional
    // bias that pushed the old cone off and made the band under-cover).
    const driftShrunk = Math.max(-0.5 * sigma, Math.min(0.5 * sigma, mu * 0.25)) + (bias || 0) * 0.0004;
    // Calibration factor on the resampled shocks. 1.0 lands the nominal 80% band at
    // ~80% realised coverage on a 5-year, 10-symbol backtest (stocks, indices, crypto).
    const VOL_INFLATE = 1.0;
    const dem = pool.map((x) => (x - mu) * VOL_INFLATE);   // de-meaned, inflated shock pool
    const p0 = last(c);
    // Monte Carlo via block-free bootstrap of real shocks → probability + percentile cone
    const SIMS = 800;
    const stepVals = Array.from({ length: horizon }, () => new Array(SIMS));
    const ends = new Array(SIMS);
    for (let s = 0; s < SIMS; s++) {
      let p = p0;
      for (let t = 0; t < horizon; t++) {
        const r = dem[(Math.random() * dem.length) | 0];   // resample an actual market move
        p = p * Math.exp(driftShrunk + r);
        stepVals[t][s] = p;
      }
      ends[s] = p;
    }
    const lo = stepVals.map((v) => pctile(v, 0.1));
    const hi = stepVals.map((v) => pctile(v, 0.9));
    const mcMid = stepVals.map((v) => pctile(v, 0.5));
    const mid = mcMid;   // central path = MC median, so chart line and projection table agree
    const probUp = ends.filter((e) => e > p0).length / SIMS;
    const cps = [...new Set([Math.max(1, Math.round(horizon / 3)), Math.max(2, Math.round((2 * horizon) / 3)), horizon])];
    const horizons = cps.map((h) => ({ bars: h, move: (mcMid[h - 1] - p0) / p0, lo: (lo[h - 1] - p0) / p0, hi: (hi[h - 1] - p0) / p0 }));
    return { p0, horizon, mu, sigma, mid, lo, hi, mcMid, probUp, horizons,
      expReturn: (last(mid) - p0) / p0, expMoveMC: (last(mcMid) - p0) / p0, annualVol: sigma * Math.sqrt(252) };
  }

  /* ---------------- combined verdict ---------------- */
  function analyze(ohlc, label, fundamentals, news) {
    const t = technical(ohlc);
    if (!t) return null;
    const closesClean = ohlc.closes.filter((v) => v != null);
    const f = fundamental(fundamentals);
    const bt = backtest(closesClean);
    const wf = walkForward(closesClean);
    const newsScore = news ? news.score : 0;

    // re-weight the live signals with walk-forward-learned weights
    if (wf) {
      const map = { 'Price vs SMA20': wf.weights.p20, 'MA cross': wf.weights.cross, 'Long-term trend': wf.weights.lt, RSI: wf.weights.rsi, MACD: wf.weights.macd };
      let ws = 0;
      t.signals.forEach((s) => { const m = map[s.name]; const w = m != null ? s.weight * (0.5 + m) : s.weight; s.weightEff = w; ws += s.dir === 'up' ? w : s.dir === 'down' ? -w : 0; });
      t.score = ws; // verdict now driven by learned, per-asset weights
    }

    const combined = t.score + (f ? f.score * 0.6 : 0) + newsScore * 0.9;
    const bullish = combined > 0.6, bearish = combined < -0.6;
    const dir = bullish ? 'up' : bearish ? 'down' : 'flat';

    let rr = null, stop, target;
    if (bullish) { stop = t.support; target = t.resistance > t.price ? t.resistance : t.price * 1.05; const risk = t.price - stop, rew = target - t.price; rr = risk > 0 ? rew / risk : null; }
    else if (bearish) { stop = t.resistance; target = t.support < t.price ? t.support : t.price * 0.95; const risk = stop - t.price, rew = t.price - target; rr = risk > 0 ? rew / risk : null; }

    // confidence blends signal agreement, trend strength (ADX) and out-of-sample accuracy
    const acc = wf ? wf.oosAccuracy : bt ? bt.hitRate : null;
    let conf = 48 + Math.abs(t.scoreNorm) * 26;
    if (t.adxV && t.adxV.adx > 25) conf += 6;
    if (acc != null) conf += (acc - 0.5) * 30;
    if (news && newsScore !== 0) { const agree = Math.sign(newsScore) === Math.sign(t.score); conf += agree ? Math.abs(newsScore) * 6 : -Math.abs(newsScore) * 4; }
    conf = Math.max(38, Math.min(92, conf));

    const trendLabel = bullish ? (t.slp > 1 ? 'Strong bullish' : 'Bullish') : bearish ? (t.slp < -1 ? 'Strong bearish' : 'Bearish') : 'Ranging';
    const fc = forecast(ohlc.closes, 30, newsScore);
    const up = sum(t.signals.filter((s) => s.dir === 'up').map((s) => 1));
    const down = sum(t.signals.filter((s) => s.dir === 'down').map((s) => 1));

    // market regime (trend strength + volatility)
    const adxV = t.adxV ? t.adxV.adx : 0;
    const av = fc ? fc.annualVol : 0;
    const volTag = av > 0.6 ? 'high-vol' : av < 0.25 ? 'calm' : 'normal';
    const regimeLabel = adxV > 25 ? (t.slp > 0 ? 'Trending up' : 'Trending down') : (av > 0.6 ? 'Volatile range' : 'Ranging');
    const regime = { label: regimeLabel, vol: volTag, adx: Math.round(adxV), annualVol: av };

    // Quantra Score (1-99): composite of technical bias, MC probability, accuracy, fundamentals & news
    let q = 50;
    q += (t.scoreNorm || 0) * 22;
    if (fc) q += (fc.probUp - 0.5) * 40;
    if (acc != null) q += (acc - 0.5) * 24;
    if (f) q += Math.max(-8, Math.min(8, f.score * 3));
    if (news && newsScore) q += newsScore * 8;
    const quantraScore = Math.max(1, Math.min(99, Math.round(q)));

    return {
      label, price: t.price, priceStr: priceFmt(t.price), regime,
      quantraScore, scoreGrade: scoreGrade(quantraScore),
      technical: t, fundamental: f, forecast: fc, backtest: bt, walkForward: wf, news: news || null,
      signals: t.signals, signalTally: { up, down, total: t.signals.length },
      indicators: {
        sma20: t.s20, sma50: t.s50, sma200: t.s200, rsi: t.r, slope: t.slp,
        support: t.support, resistance: t.resistance,
        macd: t.mac, atr: t.atrV, adx: t.adxV ? t.adxV.adx : null,
        stoch: t.stoch ? t.stoch.k : null, bollPctB: t.boll ? t.boll.pctB : null,
      },
      verdict: { dir, trend: trendLabel, rr: rr ? `1 : ${round(rr, 1)}` : '—', confidence: `${Math.round(conf)}%`,
        accuracy: acc != null ? `${Math.round(acc * 100)}%` : '—',
        accuracyKind: wf ? 'walk-forward' : bt ? 'backtest' : null },
      text: writeRead(label, t, f, fc, bt, wf, news),
    };
  }

  function writeRead(name0, t, f, fc, bt, wf, news) {
    const name = name0 || 'This asset';
    const above = t.price > t.s20;
    const structure = t.scoreNorm > 0.2 ? 'higher-highs / higher-lows' : t.scoreNorm < -0.2 ? 'lower-highs / lower-lows' : 'a sideways range';
    const meanLine = above ? `holding above its 20-period mean (${priceFmt(t.s20)})` : `below its 20-period mean (${priceFmt(t.s20)})`;
    const lt = t.s200 != null ? (t.price > t.s200 ? ' The long-term 200-SMA trend is up.' : ' It sits under its 200-SMA, a long-term headwind.') : '';
    let macTxt = '';
    if (t.mac) macTxt = t.mac.hist > 0 ? ` MACD is positive${t.mac.prevHist <= 0 ? ' and just crossed up' : ''}.` : ` MACD is negative${t.mac.prevHist >= 0 ? ' and just crossed down' : ''}.`;
    let momTxt = '';
    if (t.r != null) momTxt = t.r >= 70 ? ` RSI ${Math.round(t.r)} is overbought — pullback risk.` : t.r <= 30 ? ` RSI ${Math.round(t.r)} is oversold — bounce setup.` : ` RSI sits at ${Math.round(t.r)}.`;
    const adxTxt = t.adxV ? (t.adxV.adx > 25 ? ` Trend strength is firm (ADX ${Math.round(t.adxV.adx)}).` : ` Trend is weak (ADX ${Math.round(t.adxV.adx)}), so ranges may persist.`) : '';
    const levels = ` Support near ${priceFmt(t.support)}, resistance near ${priceFmt(t.resistance)}.`;
    const fund = f ? ` Fundamentally ${f.grade.toLowerCase()}${f.notes.length ? ' — ' + f.notes.slice(0, 3).join(', ') : ''}.` : '';
    let acc = '';
    if (wf) {
      const top = wf.top && wf.top.length ? ` Walk-forward learning favours ${wf.top.map((x) => x.name.toLowerCase()).join(' and ')} on this asset.` : '';
      acc = ` Out-of-sample, the learned signal weights were directionally right ${Math.round(wf.oosAccuracy * 100)}% of the time over ${wf.horizon} sessions (${wf.testTrades} unseen samples).${top}`;
    } else if (bt) {
      acc = ` On this asset's own history, the signal blend was directionally right ${Math.round(bt.hitRate * 100)}% of the time over ${bt.horizon} sessions (${bt.trades} samples).`;
    }
    let newsTxt = '';
    if (news && news.count) {
      const agree = news.score !== 0 && Math.sign(news.score) === Math.sign(t.score);
      newsTxt = ` Recent news skews ${news.label.toLowerCase()} (${news.pos}▲ / ${news.neg}▼ across ${news.count} headlines)${news.score !== 0 ? ', which ' + (agree ? 'reinforces' : 'tempers') + ' the read' : ''}.`;
    }
    const pred = fc ? ` Monte-Carlo projection (30 sessions): ${fc.expReturn >= 0 ? '+' : ''}${(fc.expReturn * 100).toFixed(1)}% central path, a ${Math.round(fc.probUp * 100)}% modelled chance of finishing higher, at ~${(fc.annualVol * 100).toFixed(0)}% annualised volatility.` : '';
    return `${name} is ${meanLine}, printing ${structure}.${lt}${macTxt}${momTxt}${adxTxt}${levels}${fund}${newsTxt}${acc}${pred}`;
  }

  return { analyze, technical, fundamental, sentiment, backtest, walkForward, forecast, liteScore, scoreGrade, series, sma, ema, rsi, macd, bollinger, atr, adx, priceFmt, pct, capFmt };
})();
