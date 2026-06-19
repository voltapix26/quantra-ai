/* ============================================================
   Quantra AI Terminal — zero-dependency server + market proxy
   Run:  node server.js   →  http://localhost:5280
   Node 18+ (global fetch). No npm install required.
   Crypto: CoinGecko · Stocks + News: Yahoo Finance · no API key
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Resilience: a stray async error should degrade one request, never take the
// whole web server down. Log and keep serving instead of crashing the process.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', (e && e.stack) || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', (e && e.stack) || e));

const ROOT = __dirname;
const PORT = process.env.PORT || 5280;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 QuantraAI/2.0';
const CG = 'https://api.coingecko.com/api/v3';
const YF = 'https://query1.finance.yahoo.com';
const YF2 = 'https://query2.finance.yahoo.com';
const FINNHUB = 'https://finnhub.io/api/v1';

// Load .env (no dependency) — keeps keys + model id out of source.
try {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* ignore */ }

// Optional AI reasoning engine (graceful if absent). Reads ANTHROPIC_API_KEY + QUANTRA_AI_MODEL from .env/env.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.QUANTRA_AI_MODEL || '';
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || ''; // free tier: real-time US stock quotes + news
const COINGECKO_KEY = process.env.COINGECKO_KEY || ''; // free "demo" key — raises limits + works from cloud IPs
const cgHeaders = () => (COINGECKO_KEY ? { 'x-cg-demo-api-key': COINGECKO_KEY } : {});
// Super-admins (oversight only — emails/metadata + audit log, NEVER passwords).
// Set SUPER_ADMINS="a@x.com,b@y.com". Empty = nobody has admin access (secure default).
const SUPER_ADMINS = new Set((process.env.SUPER_ADMINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const isSuperAdmin = (email) => SUPER_ADMINS.has(String(email || '').toLowerCase());
let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { /* SDK not installed — AI feature disabled */ }

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

/* ---- TTL cache ---- */
const cache = new Map();
function cached(key, ttl, producer) {
  const hit = cache.get(key), now = Date.now();
  if (hit && now - hit.t < ttl) return Promise.resolve(hit.v);
  return producer().then((v) => { cache.set(key, { t: now, v }); return v; })
    .catch((e) => { if (hit) return hit.v; throw e; });   // serve stale on upstream failure (e.g. 429)
}
async function getJSON(url, headers) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...(headers || {}) } });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/* ---- Yahoo crumb/cookie dance (needed for fundamentals) ---- */
let yCookie = null, yCrumb = null, yCrumbAt = 0;
async function ensureCrumb() {
  if (yCrumb && Date.now() - yCrumbAt < 25 * 60 * 1000) return;
  let cookies = [];
  for (const seed of ['https://fc.yahoo.com', 'https://finance.yahoo.com']) {
    try {
      const r = await fetch(seed, { headers: { 'User-Agent': UA } });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      if (sc.length) { cookies = sc; break; }
    } catch {}
  }
  yCookie = cookies.map((c) => c.split(';')[0]).join('; ');
  const rc = await fetch(`${YF2}/v1/test/getcrumb`, { headers: { 'User-Agent': UA, cookie: yCookie } });
  yCrumb = (await rc.text()).trim();
  yCrumbAt = Date.now();
  if (!yCrumb || yCrumb.length > 40) throw new Error('crumb failed');
}

const DEFAULT_STOCKS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'NFLX', 'JPM', 'XOM',
  'AVGO', 'ORCL', 'CRM', 'ADBE', 'COST', 'WMT', 'DIS', 'BA', 'PYPL', 'UBER', 'INTC', 'QCOM', 'V'];

/* Curated universes for the non-equity asset classes. Each entry: y = Yahoo
   symbol (used for charts/quotes), s = display ticker, n = friendly name.
   ETFs, commodities, indices and FX all flow through the same Yahoo chart
   pipeline as stocks, so the analysis engine scores them with no extra code. */
const UNIV = {
  etf: [
    { y: 'SPY', s: 'SPY', n: 'S&P 500 ETF' }, { y: 'QQQ', s: 'QQQ', n: 'Nasdaq 100 ETF' },
    { y: 'VOO', s: 'VOO', n: 'Vanguard S&P 500' }, { y: 'VTI', s: 'VTI', n: 'Total US Market' },
    { y: 'IWM', s: 'IWM', n: 'Russell 2000 ETF' }, { y: 'DIA', s: 'DIA', n: 'Dow Jones ETF' },
    { y: 'GLD', s: 'GLD', n: 'Gold Trust' }, { y: 'SLV', s: 'SLV', n: 'Silver Trust' },
    { y: 'ARKK', s: 'ARKK', n: 'ARK Innovation' }, { y: 'XLK', s: 'XLK', n: 'Technology Sector' },
    { y: 'XLF', s: 'XLF', n: 'Financials Sector' }, { y: 'XLE', s: 'XLE', n: 'Energy Sector' },
    { y: 'SCHD', s: 'SCHD', n: 'Dividend Equity' }, { y: 'VEA', s: 'VEA', n: 'Developed Markets' },
    { y: 'VWO', s: 'VWO', n: 'Emerging Markets' }, { y: 'TLT', s: 'TLT', n: '20+ Yr Treasuries' },
    { y: 'HYG', s: 'HYG', n: 'High-Yield Bonds' }, { y: 'EEM', s: 'EEM', n: 'MSCI Emerging Mkts' },
    { y: 'EFA', s: 'EFA', n: 'MSCI EAFE' }, { y: 'SMH', s: 'SMH', n: 'Semiconductor ETF' },
  ],
  commodity: [
    { y: 'GC=F', s: 'GOLD', n: 'Gold (COMEX)' }, { y: 'SI=F', s: 'SILVER', n: 'Silver (COMEX)' },
    { y: 'CL=F', s: 'WTI', n: 'Crude Oil WTI' }, { y: 'BZ=F', s: 'BRENT', n: 'Brent Crude' },
    { y: 'NG=F', s: 'NATGAS', n: 'Natural Gas' }, { y: 'HG=F', s: 'COPPER', n: 'Copper' },
    { y: 'PL=F', s: 'PLAT', n: 'Platinum' }, { y: 'PA=F', s: 'PALL', n: 'Palladium' },
    { y: 'ZC=F', s: 'CORN', n: 'Corn' }, { y: 'ZW=F', s: 'WHEAT', n: 'Wheat' },
    { y: 'ZS=F', s: 'SOY', n: 'Soybeans' }, { y: 'KC=F', s: 'COFFEE', n: 'Coffee' },
    { y: 'SB=F', s: 'SUGAR', n: 'Sugar' }, { y: 'CC=F', s: 'COCOA', n: 'Cocoa' },
    { y: 'CT=F', s: 'COTTON', n: 'Cotton' }, { y: 'LE=F', s: 'CATTLE', n: 'Live Cattle' },
  ],
  index: [
    { y: '^GSPC', s: 'S&P 500', n: 'S&P 500 Index' }, { y: '^DJI', s: 'DOW', n: 'Dow Jones Industrial' },
    { y: '^IXIC', s: 'NASDAQ', n: 'Nasdaq Composite' }, { y: '^RUT', s: 'RUSSELL', n: 'Russell 2000' },
    { y: '^VIX', s: 'VIX', n: 'Volatility Index' }, { y: '^FTSE', s: 'FTSE', n: 'FTSE 100 (UK)' },
    { y: '^GDAXI', s: 'DAX', n: 'DAX (Germany)' }, { y: '^FCHI', s: 'CAC40', n: 'CAC 40 (France)' },
    { y: '^N225', s: 'NIKKEI', n: 'Nikkei 225 (Japan)' }, { y: '^HSI', s: 'HSI', n: 'Hang Seng (HK)' },
    { y: '^NSEI', s: 'NIFTY', n: 'Nifty 50 (India)' }, { y: '^BSESN', s: 'SENSEX', n: 'BSE Sensex (India)' },
    { y: '^STOXX50E', s: 'STOXX50', n: 'Euro Stoxx 50' }, { y: '^AXJO', s: 'ASX200', n: 'ASX 200 (Australia)' },
  ],
  fx: [
    { y: 'EURUSD=X', s: 'EUR/USD', n: 'Euro / US Dollar' }, { y: 'GBPUSD=X', s: 'GBP/USD', n: 'Pound / US Dollar' },
    { y: 'USDJPY=X', s: 'USD/JPY', n: 'US Dollar / Yen' }, { y: 'USDINR=X', s: 'USD/INR', n: 'US Dollar / Rupee' },
    { y: 'AUDUSD=X', s: 'AUD/USD', n: 'Aussie / US Dollar' }, { y: 'USDCAD=X', s: 'USD/CAD', n: 'US Dollar / Loonie' },
    { y: 'USDCHF=X', s: 'USD/CHF', n: 'US Dollar / Franc' }, { y: 'USDCNY=X', s: 'USD/CNY', n: 'US Dollar / Yuan' },
    { y: 'NZDUSD=X', s: 'NZD/USD', n: 'Kiwi / US Dollar' }, { y: 'EURGBP=X', s: 'EUR/GBP', n: 'Euro / Pound' },
    { y: 'USDAED=X', s: 'USD/AED', n: 'US Dollar / Dirham' }, { y: 'USDSGD=X', s: 'USD/SGD', n: 'US Dollar / SGD' },
  ],
};
// Map Yahoo quoteType -> our asset class (broadens search beyond equities).
const QTYPE = { EQUITY: 'stock', ETF: 'etf', MUTUALFUND: 'etf', FUTURE: 'commodity', INDEX: 'index', CURRENCY: 'fx', CRYPTOCURRENCY: 'crypto' };

/* helper: aligned OHLC + dates from a Yahoo chart result */
function alignedFromYahoo(r) {
  const ts = r.timestamp || [];
  const q = (r.indicators.quote && r.indicators.quote[0]) || {};
  const out = { closes: [], highs: [], lows: [], opens: [], volumes: [], dates: [] };
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    out.dates.push(new Date(ts[i] * 1000).toISOString());
    out.closes.push(q.close[i]);
    out.highs.push(q.high[i] != null ? q.high[i] : q.close[i]);
    out.lows.push(q.low[i] != null ? q.low[i] : q.close[i]);
    out.opens.push(q.open[i] != null ? q.open[i] : q.close[i]);
    out.volumes.push(q.volume[i] != null ? q.volume[i] : 0);
  }
  return out;
}

/* Build a board for any list of Yahoo symbols (stocks/ETFs/commodities/indices/FX). */
async function buildBoard(list, type) {
  const out = await Promise.all(list.map(async (it) => {
    const sym = typeof it === 'string' ? it : it.y;
    try {
      const d = await getJSON(`${YF}/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`);
      const r = d.chart.result[0];
      const closes = (r.indicators.quote[0].close || []).filter((v) => v != null);
      const last = closes[closes.length - 1], prev = r.meta.chartPreviousClose || closes[closes.length - 2] || last;
      return { type, id: sym, symbol: (it && it.s) || r.meta.symbol || sym, name: (it && it.n) || r.meta.shortName || sym,
        price: last, currency: r.meta.currency || 'USD', change24h: prev ? ((last - prev) / prev) * 100 : 0,
        marketCap: r.meta.marketCap || null, volume: r.meta.regularMarketVolume || null, spark: closes.slice(-30) };
    } catch { return null; }
  }));
  return out.filter(Boolean);
}

const api = {
  /* ---- FX rates (USD base) for currency conversion ---- */
  async fx() {
    return cached('fx', 60 * 60 * 1000, async () => {
      try {
        const d = await getJSON('https://open.er-api.com/v6/latest/USD');
        return { base: 'USD', rates: d.rates || { USD: 1 }, updated: d.time_last_update_utc || null };
      } catch {
        return { base: 'USD', rates: { USD: 1 } };
      }
    });
  },

  async 'crypto/markets'(q) {
    const page = Math.max(1, parseInt(q.page || '1', 10));
    try {
      const d = await cached(`cm:${page}`, 45000, () => getJSON(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=${page}&sparkline=true&price_change_percentage=24h`, cgHeaders()));
      return d.map((c) => ({ type: 'crypto', id: c.id, symbol: (c.symbol || '').toUpperCase(), name: c.name,
        price: c.current_price, change24h: c.price_change_percentage_24h, marketCap: c.market_cap, volume: c.total_volume,
        spark: (c.sparkline_in_7d && c.sparkline_in_7d.price) || [] }));
    } catch (e) {
      // CoinGecko throttles cloud IPs hard (HTTP 429). Fall back to CoinPaprika so the board still loads.
      return cached(`cmfb:${page}`, 60000, async () => {
        const d = await getJSON('https://api.coinpaprika.com/v1/tickers?quotes=USD');
        const start = (page - 1) * 50;
        return (Array.isArray(d) ? d : []).slice(start, start + 50).map((c) => {
          const u = (c.quotes && c.quotes.USD) || {};
          // CoinPaprika id is "{sym}-{slug}"; the slug usually matches the CoinGecko id used by the chart endpoint.
          return { type: 'crypto', id: String(c.id || '').replace(/^[^-]+-/, '') || c.id, symbol: (c.symbol || '').toUpperCase(), name: c.name,
            price: u.price, change24h: u.percent_change_24h, marketCap: u.market_cap, volume: u.volume_24h, spark: [] };
        }).filter((x) => x.price != null);
      });
    }
  },
  async 'crypto/search'(q) {
    if (!q.q) return [];
    const d = await cached(`cs:${q.q}`, 120000, () => getJSON(`${CG}/search?query=${encodeURIComponent(q.q)}`, cgHeaders()));
    return (d.coins || []).slice(0, 12).map((c) => ({ type: 'crypto', id: c.id, symbol: (c.symbol || '').toUpperCase(), name: c.name }));
  },
  async 'crypto/chart'(q) {
    if (!q.id) throw new Error('missing id');
    const days = q.days || '90';
    const d = await cached(`cc:${q.id}:${days}`, 60000, () => getJSON(`${CG}/coins/${encodeURIComponent(q.id)}/market_chart?vs_currency=usd&days=${days}`, cgHeaders()));
    const closes = (d.prices || []).map((p) => p[1]);
    const dates = (d.prices || []).map((p) => new Date(p[0]).toISOString());
    const volumes = (d.total_volumes || []).map((p) => p[1]);
    return { symbol: q.id, closes, highs: closes, lows: closes, opens: closes, volumes, dates };
  },
  // Real crypto OHLC candles via Coinbase (free, no key, US-accessible — Binance
  // geo-blocks US/cloud IPs with HTTP 451, so it can't be used server-side).
  async 'crypto/ohlc'(q) {
    if (!q.symbol) throw new Error('missing symbol');
    const map = { '1m': 60, '60m': 3600, '1d': 86400, '1wk': 86400 };
    const gran = map[q.interval] || 86400;
    const limit = Math.min(Math.max(parseInt(q.limit || '200', 10), 10), 300);
    const prod = (q.symbol || '').toUpperCase() + '-USD';
    return cached(`cb:${prod}:${gran}:${limit}`, 30000, async () => {
      const d = await getJSON(`https://api.exchange.coinbase.com/products/${encodeURIComponent(prod)}/candles?granularity=${gran}`);
      // Coinbase rows: [time(s), low, high, open, close, volume], newest-first.
      const rows = (Array.isArray(d) ? d : []).slice(0, limit).reverse();
      const opens = [], highs = [], lows = [], closes = [], dates = [];
      for (const k of rows) { dates.push(new Date(k[0] * 1000).toISOString()); lows.push(+k[1]); highs.push(+k[2]); opens.push(+k[3]); closes.push(+k[4]); }
      return { symbol: q.symbol, opens, highs, lows, closes, dates };
    });
  },
  async 'stock/search'(q) {
    if (!q.q) return [];
    const d = await cached(`ss:${q.q}`, 120000, () => getJSON(`${YF}/v1/finance/search?q=${encodeURIComponent(q.q)}&quotesCount=14&newsCount=0`));
    return (d.quotes || []).filter((x) => x.symbol && QTYPE[x.quoteType] && x.quoteType !== 'CRYPTOCURRENCY')
      .slice(0, 12).map((x) => ({ type: QTYPE[x.quoteType], id: x.symbol, symbol: x.symbol, name: x.shortname || x.longname || x.symbol }));
  },
  async 'stock/chart'(q) {
    if (!q.symbol) throw new Error('missing symbol');
    const range = q.range || '6mo', interval = q.interval || '1d';
    const d = await cached(`sc:${q.symbol}:${range}:${interval}`, 60000, () => getJSON(`${YF}/v8/finance/chart/${encodeURIComponent(q.symbol)}?range=${range}&interval=${interval}`));
    const r = d.chart && d.chart.result && d.chart.result[0];
    if (!r) throw new Error('no data');
    return { symbol: q.symbol, currency: (r.meta && r.meta.currency) || 'USD', ...alignedFromYahoo(r), meta: r.meta || {} };
  },
  async 'stock/board'() { return cached('sb', 60000, () => buildBoard(DEFAULT_STOCKS, 'stock')); },
  async 'etf/board'() { return cached('etfb', 60000, () => buildBoard(UNIV.etf, 'etf')); },
  async 'commodity/board'() { return cached('comb', 60000, () => buildBoard(UNIV.commodity, 'commodity')); },
  async 'index/board'() { return cached('idxb', 60000, () => buildBoard(UNIV.index, 'index')); },
  async 'fx/board'() { return cached('fxb', 60000, () => buildBoard(UNIV.fx, 'fx')); },
  // Universal current price for any held asset (portfolio tracker).
  async 'price'(q) {
    const idv = q.id || q.symbol; if (!idv) return { ok: false };
    if (q.type === 'crypto') {
      try { const d = await cached(`px:c:${idv}`, 30000, () => getJSON(`${CG}/simple/price?ids=${encodeURIComponent(idv)}&vs_currencies=usd`, cgHeaders())); const p = d[idv] && d[idv].usd; if (p != null) return { ok: true, price: p, currency: 'USD' }; } catch {}
      try { const d = await getJSON(`https://api.coinpaprika.com/v1/tickers/${encodeURIComponent(String(q.symbol || idv).toLowerCase())}-${encodeURIComponent(String(idv).toLowerCase())}?quotes=USD`); const p = d && d.quotes && d.quotes.USD && d.quotes.USD.price; if (p != null) return { ok: true, price: p, currency: 'USD' }; } catch {}
      return { ok: false };
    }
    try {
      const d = await cached(`px:y:${idv}`, 30000, () => getJSON(`${YF}/v8/finance/chart/${encodeURIComponent(idv)}?range=1d&interval=1d`));
      const r = d.chart.result[0], closes = (r.indicators.quote[0].close || []).filter((v) => v != null);
      return { ok: true, price: closes.length ? closes[closes.length - 1] : (r.meta && r.meta.regularMarketPrice), currency: (r.meta && r.meta.currency) || 'USD' };
    } catch { return { ok: false }; }
  },

  /* ---- screener.in-style fundamentals (Yahoo quoteSummary) ---- */
  async 'stock/fundamentals'(q) {
    if (!q.symbol) throw new Error('missing symbol');
    return cached(`fund:${q.symbol}`, 10 * 60 * 1000, async () => {
      await ensureCrumb();
      const modules = 'summaryDetail,defaultKeyStatistics,financialData,price,assetProfile,recommendationTrend,earningsTrend,calendarEvents';
      const url = `${YF2}/v10/finance/quoteSummary/${encodeURIComponent(q.symbol)}?modules=${modules}&crumb=${encodeURIComponent(yCrumb)}`;
      const d = await getJSON(url, { cookie: yCookie });
      const r = d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0];
      if (!r) throw new Error('no fundamentals');
      const sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {}, fd = r.financialData || {}, pr = r.price || {}, ap = r.assetProfile || {};
      const num = (x) => (x && typeof x === 'object' && 'raw' in x ? x.raw : x == null ? null : x);
      // analyst recommendation breakdown (latest period)
      const rt = (r.recommendationTrend && r.recommendationTrend.trend && r.recommendationTrend.trend[0]) || null;
      const recBreakdown = rt ? { strongBuy: rt.strongBuy, buy: rt.buy, hold: rt.hold, sell: rt.sell, strongSell: rt.strongSell } : null;
      // forward EPS/revenue estimates
      const et = (r.earningsTrend && r.earningsTrend.trend) || [];
      const pick = (p) => et.find((x) => x.period === p) || {};
      const cy = pick('0y'), ny = pick('+1y'), cq = pick('0q');
      const estimates = {
        epsCurrentYear: num((cy.earningsEstimate || {}).avg), epsNextYear: num((ny.earningsEstimate || {}).avg),
        epsCurrentQtr: num((cq.earningsEstimate || {}).avg),
        revCurrentYear: num((cy.revenueEstimate || {}).avg), revNextYear: num((ny.revenueEstimate || {}).avg),
        epsGrowthNextYear: num((ny.growth)), revGrowthCurrentYear: num((cy.revenueEstimate || {}).growth),
        nextEarningsDate: (r.calendarEvents && r.calendarEvents.earnings && r.calendarEvents.earnings.earningsDate && r.calendarEvents.earnings.earningsDate[0] && r.calendarEvents.earnings.earningsDate[0].fmt) || null,
      };
      return {
        recBreakdown, estimates,
        analystCount: num(fd.numberOfAnalystOpinions),
        targetHigh: num(fd.targetHighPrice), targetLow: num(fd.targetLowPrice),
        symbol: q.symbol,
        name: pr.longName || pr.shortName || q.symbol,
        sector: ap.sector || null, industry: ap.industry || null,
        price: num(fd.currentPrice) ?? num(pr.regularMarketPrice),
        currency: pr.currency || 'USD',
        marketCap: num(sd.marketCap) ?? num(pr.marketCap),
        peTrailing: num(sd.trailingPE), peForward: num(sd.forwardPE),
        eps: num(ks.trailingEps), pb: num(ks.priceToBook), bookValue: num(ks.bookValue),
        dividendYield: num(sd.dividendYield), beta: num(sd.beta) ?? num(ks.beta),
        roe: num(fd.returnOnEquity), roa: num(fd.returnOnAssets),
        profitMargin: num(fd.profitMargins), operatingMargin: num(fd.operatingMargins),
        debtToEquity: num(fd.debtToEquity), currentRatio: num(fd.currentRatio),
        revenueGrowth: num(fd.revenueGrowth), earningsGrowth: num(fd.earningsGrowth),
        recommendation: fd.recommendationKey || null, targetMean: num(fd.targetMeanPrice),
        high52: num(sd.fiftyTwoWeekHigh), low52: num(sd.fiftyTwoWeekLow),
      };
    });
  },

  /* ---- peer comparison ---- */
  async 'stock/peers'(q) {
    if (!q.symbol) return [];
    return cached(`peers:${q.symbol}`, 30 * 60 * 1000, async () => {
      let syms = [];
      try {
        const rec = await getJSON(`${YF}/v6/finance/recommendationsbysymbol/${encodeURIComponent(q.symbol)}`);
        syms = ((rec.finance && rec.finance.result && rec.finance.result[0] && rec.finance.result[0].recommendedSymbols) || []).map((x) => x.symbol).slice(0, 5);
      } catch {}
      if (!syms.length) return [];
      const out = await Promise.all(syms.map(async (sym) => {
        try {
          const d = await getJSON(`${YF}/v8/finance/chart/${sym}?range=5d&interval=1d`);
          const r = d.chart.result[0];
          const closes = (r.indicators.quote[0].close || []).filter((v) => v != null);
          const last = closes[closes.length - 1], prev = r.meta.chartPreviousClose || closes[closes.length - 2] || last;
          return { symbol: sym, name: r.meta.shortName || sym, price: last, currency: r.meta.currency || 'USD', change: prev ? ((last - prev) / prev) * 100 : 0, marketCap: r.meta.marketCap || null };
        } catch { return null; }
      }));
      return out.filter(Boolean);
    });
  },

  /* ---- AI natural-language reasoning + structured news impact ---- */
  async 'ai/reason'(q, body) {
    if (!ANTHROPIC_KEY) return { ok: false, reason: 'no-key' };
    if (!Anthropic) return { ok: false, reason: 'no-sdk' };
    if (!AI_MODEL) return { ok: false, reason: 'no-model' };
    const data = body || {};
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const sys = 'You are Quantra AI, a markets analyst. From the supplied pre-computed indicators, fundamentals and latest news, return a JSON object with: ' +
      '"read" (4-6 sentence educational analysis in plain language that weaves together the technical signals, fundamentals, the latest-news sentiment — noting whether the supplied headlines support or contradict the technical picture — the walk-forward accuracy and the forecast into one coherent view; no markdown, no headers), ' +
      '"stance" (one of "bullish","neutral","bearish"), ' +
      '"newsImpact" (a number from -1 to 1: how much ONLY the latest news shifts the near-term outlook — negative = bearish news, 0 = neutral/no material news, positive = bullish news), and ' +
      '"newsRationale" (one short sentence naming the main news driver). ' +
      'Be candid about uncertainty. Educational only — never give buy/sell advice, actionable price targets or signals.';
    const schema = { type: 'object', additionalProperties: false, required: ['read', 'stance', 'newsImpact'],
      properties: { read: { type: 'string' }, stance: { type: 'string', enum: ['bullish', 'neutral', 'bearish'] }, newsImpact: { type: 'number' }, newsRationale: { type: 'string' } } };
    const userMsg = 'Analyse this asset and return the JSON:\n\n' + JSON.stringify(data, null, 1);
    try {
      const msg = await client.messages.create({
        model: AI_MODEL, max_tokens: 900, system: sys,
        messages: [{ role: 'user', content: userMsg }],
        output_config: { format: { type: 'json_schema', schema } },
      });
      const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      const p = JSON.parse(text);
      let impact = Number(p.newsImpact); if (!isFinite(impact)) impact = 0; impact = Math.max(-1, Math.min(1, impact));
      return { ok: true, text: (p.read || '').trim(), stance: p.stance || 'neutral', newsImpact: impact, rationale: p.newsRationale || '' };
    } catch (e) {
      // fallback: plain-text read if structured output is unavailable
      try {
        const msg2 = await client.messages.create({
          model: AI_MODEL, max_tokens: 700,
          system: 'You are Quantra AI. Write a concise 4-6 sentence educational read weaving technical signals, fundamentals, latest-news sentiment, accuracy and the forecast into one view. No advice, no markdown.',
          messages: [{ role: 'user', content: userMsg }],
        });
        const t2 = (msg2.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        return { ok: true, text: t2 };
      } catch (e2) { return { ok: false, reason: String(e2.message || e2) }; }
    }
  },

  /* ---- latest news for a stock ---- */
  async 'stock/news'(q) {
    if (!q.symbol) return [];
    return cached(`news:${q.symbol}`, 5 * 60 * 1000, async () => {
      const d = await getJSON(`${YF}/v1/finance/search?q=${encodeURIComponent(q.symbol)}&newsCount=20&quotesCount=1&enableFuzzyQuery=false`);
      return (d.news || []).map((n) => ({
        title: n.title, publisher: n.publisher, link: n.link,
        time: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
        thumb: (n.thumbnail && n.thumbnail.resolutions && n.thumbnail.resolutions[0] && n.thumbnail.resolutions[0].url) || null,
        tickers: n.relatedTickers || [],
      }));
    });
  },

  /* ---- live config: tells the client which live sources are available ---- */
  async config() {
    return { cryptoStream: true, finnhub: !!FINNHUB_KEY };
  },

  /* ---- Finnhub real-time US stock quote (key stays server-side) ---- */
  async 'stock/quote'(q) {
    if (!FINNHUB_KEY) return { ok: false, reason: 'no-finnhub' };
    if (!q.symbol) return { ok: false, reason: 'no-symbol' };
    try {
      const d = await getJSON(`${FINNHUB}/quote?symbol=${encodeURIComponent(q.symbol)}&token=${FINNHUB_KEY}`);
      // Finnhub: c=current, d=change, dp=percent, t=epoch seconds. c===0 => no data for symbol.
      if (!d || d.c === 0 || d.c == null) return { ok: false, reason: 'no-data' };
      return { ok: true, price: d.c, change: d.d, changePct: d.dp, high: d.h, low: d.l, open: d.o, prevClose: d.pc, t: d.t || null, source: 'finnhub' };
    } catch (e) { return { ok: false, reason: String(e.message || e) }; }
  },

  /* ---- Finnhub live news (general market or per-symbol) ---- */
  async 'news/live'(q) {
    if (!FINNHUB_KEY) return [];
    try {
      let raw;
      if (q.symbol) {
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
        raw = await getJSON(`${FINNHUB}/company-news?symbol=${encodeURIComponent(q.symbol)}&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
      } else {
        raw = await getJSON(`${FINNHUB}/news?category=general&token=${FINNHUB_KEY}`);
      }
      return (raw || []).slice(0, 30).map((n) => ({
        title: n.headline, publisher: n.source, link: n.url,
        time: n.datetime ? new Date(n.datetime * 1000).toISOString() : null,
        thumb: n.image || null, tickers: n.related ? String(n.related).split(',').filter(Boolean) : [],
      }));
    } catch { return []; }
  },
};

/* Local "Quantra AI" read — composes an educational narrative from the
   pre-computed analysis WITHOUT any external LLM, so every user always sees a
   Quantra AI verdict. Paid plans get the richer live-news LLM read on top. */
function localReason(d) {
  d = d || {};
  const v = d.verdict || {}, t = d.technical || {}, fc = d.forecast || {}, nw = d.news || {}, fu = d.fundamentals || {}, rg = d.regime || {};
  const f1 = (x, k) => (x == null ? null : (x[k] != null ? x[k] : null));
  const num = (x, dp) => (x == null || isNaN(x) ? null : Number(x).toFixed(dp == null ? 2 : dp));
  let stance = 'neutral';
  if (v.dir === 'up' || (fc.probUp != null && fc.probUp > 0.55)) stance = 'bullish';
  else if (v.dir === 'down' || (fc.probUp != null && fc.probUp < 0.45)) stance = 'bearish';
  let impact = 0, rationale = '';
  if (nw && typeof nw.score === 'number') {
    impact = Math.max(-1, Math.min(1, nw.score));
    rationale = nw.label && nw.label !== 'Neutral'
      ? `${nw.label} news flow (${nw.positive || 0} positive / ${nw.negative || 0} negative headlines).`
      : 'No material news catalyst in the latest headlines.';
  }
  const p = [];
  p.push(`${d.asset || d.symbol || 'This asset'} reads ${stance} on the rule-based engine, in a ${rg.label || v.trend || 'mixed'} regime.`);
  if (t.rsi != null) p.push(`Momentum: RSI ${t.rsi}${t.rsi >= 70 ? ' (overbought)' : t.rsi <= 30 ? ' (oversold)' : ''}, MACD histogram ${t.macdHist != null ? t.macdHist : '—'}${t.adx != null ? `, ADX ${t.adx} (${t.adx >= 25 ? 'trending' : 'rangebound'})` : ''}.`);
  if (t.sma200 != null && d.price != null) p.push(`Price is ${d.price >= t.sma200 ? 'above' : 'below'} its 200-day average — a ${d.price >= t.sma200 ? 'constructive' : 'cautious'} longer-term backdrop${t.support != null ? `, with support near ${num(t.support, 2)} and resistance near ${num(t.resistance, 2)}` : ''}.`);
  if (fc.probUp != null) p.push(`The Monte-Carlo forecast puts the 30-session odds of a gain near ${Math.round(fc.probUp * 100)}%, an expected move of ${fc.expReturn != null ? (fc.expReturn * 100).toFixed(1) : '—'}% against ${fc.annualVol != null ? (fc.annualVol * 100).toFixed(0) : '—'}% annualised volatility.`);
  if (d.walkForward && d.walkForward.oosAccuracy != null) p.push(`Walk-forward testing shows ~${Math.round(d.walkForward.oosAccuracy * 100)}% out-of-sample directional accuracy, so treat this as a probabilistic lean, not a certainty.`);
  if (fu && fu.peTrailing != null) p.push(`Fundamentally it trades on a ${num(fu.peTrailing, 1)}× trailing P/E${fu.revenueGrowth != null ? ` with ${(fu.revenueGrowth * 100).toFixed(0)}% revenue growth` : ''}${fu.roe != null ? ` and ${(fu.roe * 100).toFixed(0)}% ROE` : ''}.`);
  if (rationale) p.push(rationale);
  p.push('Educational only — not investment advice.');
  return { ok: true, source: 'quantra', text: p.join(' '), stance, newsImpact: impact, rationale };
}

/* ---- static + routing ---- */
function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const fp = path.join(ROOT, path.normalize(rel));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(fp);
    // Never let the browser serve a stale app shell or script — always revalidate
    // HTML/JS/CSS so code fixes take effect on the next load. Other assets may cache.
    const noCache = ext === '.html' || ext === '.js' || ext === '.css';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-store, must-revalidate' : 'public, max-age=3600',
    });
    res.end(buf);
  });
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/* ============================================================
   Multi-tenant accounts, sessions, billing & per-tenant storage.
   Storage (store.js) is Postgres in the cloud, JSON files locally.
   Email (mailer.js) is Resend in the cloud, console locally.
   Billing (Stripe) and email verify/reset are all env-gated and
   degrade gracefully when not configured.
   ============================================================ */
const store = require('./store');
const { planOf } = require('./plans');
const { sendMail, shell, btn, APP_URL } = require('./mailer');
// load the analysis engine server-side (it assigns window.Quantra) for scoring
global.window = global.window || {};
try { require('./analysis'); } catch {}
const Q = global.window.Quantra || null;

// reject the most common / weak passwords
const WEAK_PW = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop', 'iloveyou', 'admin123', 'welcome1', 'letmein123', 'changeme', 'football1', 'sunshine1', 'password!', 'passw0rd', 'trustno1', 'baseball1', 'starwars1', 'quantra123', 'abc12345']);
function weakPassword(pw, email) {
  const lo = pw.toLowerCase();
  if (WEAK_PW.has(lo)) return 'That password is too common — choose a stronger one.';
  if (email && lo.includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4) return 'Password must not contain your email name.';
  if (/^(.)\1+$/.test(pw)) return 'Password must not be a single repeated character.';
  return null;
}
function aiUsage(org) {
  const day = new Date().toISOString().slice(0, 10);
  if (!org.usage || org.usage.day !== day) org.usage = { day, ai: 0 };
  return org.usage;
}
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days
const PROD = process.env.NODE_ENV === 'production';
const newId = (p) => p + '_' + crypto.randomBytes(8).toString('hex');

// optional Stripe (lazy)
let Stripe = null; try { Stripe = require('stripe'); } catch {}
const stripe = (process.env.STRIPE_SECRET_KEY && Stripe) ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const PRICES = { pro: process.env.STRIPE_PRICE_PRO || '', ultimate: process.env.STRIPE_PRICE_ULTIMATE || '' };

function hashPw(pw) { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); }
function verifyPw(pw, stored) { try { const [s, h] = stored.split(':'); const exp = Buffer.from(h, 'hex'); const act = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64); return act.length === exp.length && crypto.timingSafeEqual(act, exp); } catch { return false; } }
function parseCookies(req) { const o = {}; (req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
// Is the request to a loopback/dev host? (browser may be on plain http even if a proxy claims https)
const isLocalHost = (req) => { const h = (req.headers.host || '').toLowerCase(); return h.startsWith('localhost') || h.startsWith('127.0.0.1') || h.startsWith('[::1]') || h.startsWith('0.0.0.0'); };
// Genuinely HTTPS only when the socket is encrypted, or a proxy advertises https for a NON-loopback host.
// A `Secure` cookie sent over http://localhost is silently dropped by the browser, which logs the user
// straight back out — so loopback hosts over a plain socket are never treated as https.
const isHttps = (req) => (req.socket && req.socket.encrypted) ? true : (!isLocalHost(req) && (req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https');
const cookieFor = (t, req) => `qsid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}${isHttps(req) ? '; Secure' : ''}`;
async function createSession(email) { const t = crypto.randomBytes(24).toString('hex'); await store.putSession(t, { email, exp: Date.now() + SESSION_TTL }); return t; }
// Session token may arrive via the httpOnly cookie OR an Authorization: Bearer
// header. The header path is a fallback for contexts where the browser drops
// the cookie (https-wrapped previews, cross-site iframes, some localhost tunnels).
function bearerToken(req) { const h = String(req.headers['authorization'] || ''); const m = h.match(/^Bearer\s+(.+)$/i); return m ? m[1].trim() : null; }
async function sessionUser(req) { const t = parseCookies(req).qsid || bearerToken(req); if (!t) return null; const s = await store.getSession(t); if (!s || s.exp < Date.now()) { if (s) await store.delSession(t); return null; } const u = await store.getUserByEmail(s.email); return u ? { user: u, token: t } : null; }
async function userPublic(u) { const org = await store.getOrg(u.orgId); return { id: u.id, email: u.email, name: u.name, orgId: u.orgId, role: u.role, verified: !!u.verified, plan: (org || {}).plan || 'free', superAdmin: isSuperAdmin(u.email) }; }
function sendC(res, code, obj, cookie) { const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }; if (cookie) h['Set-Cookie'] = cookie; res.writeHead(code, h); res.end(JSON.stringify(obj)); }

/* ---- sliding-window rate limiting (per-instance, in-memory) ---- */
const rlBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let arr = rlBuckets.get(key); if (!arr) { arr = []; rlBuckets.set(key, arr); }
  while (arr.length && arr[0] <= now - windowMs) arr.shift();
  if (arr.length >= max) return { ok: false, retryAfter: Math.ceil((arr[0] + windowMs - now) / 1000) };
  arr.push(now); return { ok: true };
}
setInterval(() => { const cut = Date.now() - 3600000; for (const [k, arr] of rlBuckets) { while (arr.length && arr[0] <= cut) arr.shift(); if (!arr.length) rlBuckets.delete(k); } }, 600000).unref();
const clientIp = (req) => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || (req.socket && req.socket.remoteAddress) || 'unknown';
// Append a security-audit event (fire-and-forget; never logs passwords).
function audit(action, req, email, detail) {
  try { store.appendAudit({ ts: Date.now(), action, email: email || null, ip: clientIp(req), ua: String((req && req.headers['user-agent']) || '').slice(0, 160), detail: detail || null }); } catch {}
}

/* ---- lightweight, privacy-friendly traffic analytics (footfall) ----
   Counts page views + unique visitors per day. Visitors are identified by a
   one-way hash of IP (no raw IP, no cross-site tracking). Aggregated in memory
   and flushed to storage so the admin can see real footfall over time.        */
const metrics = { day: '', views: 0, api: 0, pages: {}, hashes: new Set() };
const hashIp = (ip) => crypto.createHash('sha256').update('qfp:' + ip).digest('hex').slice(0, 12);
function metricsRoll(day) { metrics.day = day; metrics.views = 0; metrics.api = 0; metrics.pages = {}; metrics.hashes = new Set(); }
async function metricsLoad() {
  metricsRoll(new Date().toISOString().slice(0, 10));
  try { const r = await store.getStats(metrics.day); if (r) { metrics.views = r.views || 0; metrics.api = r.api || 0; metrics.pages = r.pages || {}; (r.hashes || []).forEach((h) => metrics.hashes.add(h)); } } catch {}
}
async function metricsFlush() {
  try { await store.putStats(metrics.day, { views: metrics.views, api: metrics.api, uniques: metrics.hashes.size, pages: metrics.pages, hashes: [...metrics.hashes].slice(0, 5000), at: Date.now() }); } catch {}
}
function track(req, u) {
  const day = new Date().toISOString().slice(0, 10);
  if (metrics.day !== day) { metricsFlush(); metricsRoll(day); }
  const p = u.pathname;
  if (p.startsWith('/api/')) { metrics.api++; return; }
  if (!(p === '/' || p.endsWith('.html'))) return;            // count page views, not assets
  metrics.views++;
  const page = p === '/' ? '/index.html' : p;
  metrics.pages[page] = (metrics.pages[page] || 0) + 1;
  metrics.hashes.add(hashIp(clientIp(req)));
}
function tooMany(res, key, max, win) {
  const r = rateLimit(key, max, win);
  if (!r.ok) { res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(r.retryAfter), 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: `Too many attempts. Try again in ${r.retryAfter}s.` })); return true; }
  return false;
}

async function emailVerify(user) {
  const t = crypto.randomBytes(20).toString('hex');
  await store.putToken(t, { type: 'verify', email: user.email, exp: Date.now() + 1000 * 60 * 60 * 24 });
  const url = `${APP_URL}/verify.html?token=${t}`;
  await sendMail(user.email, 'Verify your Quantra AI email',
    shell('Confirm your email', `<p style="color:#93A0B8">Welcome to Quantra AI. Confirm your email to finish setting up your account.</p>${btn(url, 'Verify email')}<p style="color:#5A6680;font-size:12px">Or paste this link: ${url}</p>`),
    `Verify your Quantra AI email: ${url}`);
}

async function authRoute(req, res, u) {
  const p = u.pathname, m = req.method;
  const body = (m === 'POST' || m === 'PUT') ? await readBody(req) : {};
  const ip = clientIp(req);
  try {
    if (p === '/api/auth/signup' && m === 'POST') {
      if (tooMany(res, 'su:' + ip, 8, 3600000)) return;
      const email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || '');
      const name = String(body.name || '').trim() || email.split('@')[0];
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'Enter a valid email address.' });
      if (pw.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      const wk = weakPassword(pw, email); if (wk) return send(res, 400, { error: wk });
      if (!body.consent) return send(res, 400, { error: 'Please accept the Terms and Privacy Policy.' });
      if (await store.getUserByEmail(email)) return send(res, 409, { error: 'An account with that email already exists.' });
      const userId = newId('usr'), orgId = newId('org');
      await store.putOrg({ id: orgId, name: String(body.orgName || '').trim() || `${name}'s workspace`, plan: 'free', apiKey: 'qk_live_' + crypto.randomBytes(16).toString('hex'), ownerId: userId, createdAt: Date.now() });
      const user = { id: userId, email, name, passHash: hashPw(pw), orgId, role: 'owner', verified: false, createdAt: Date.now() };
      await store.putUser(user);
      audit('signup', req, email, { orgId });
      emailVerify(user).catch(() => {});
      const tok = await createSession(email);
      return sendC(res, 200, { ok: true, user: await userPublic(user), token: tok }, cookieFor(tok, req));
    }
    if (p === '/api/auth/login' && m === 'POST') {
      if (tooMany(res, 'li:' + ip, 12, 900000)) return;
      const email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || '');
      const usr = await store.getUserByEmail(email);
      if (!usr || !verifyPw(pw, usr.passHash)) { audit('login_failed', req, email); return send(res, 401, { error: 'Wrong email or password.' }); }
      usr.lastLogin = Date.now(); await store.putUser(usr);
      const tok = await createSession(email);
      audit('login', req, email);
      return sendC(res, 200, { ok: true, user: await userPublic(usr), token: tok }, cookieFor(tok, req));
    }
    if (p === '/api/auth/logout' && m === 'POST') {
      const t = parseCookies(req).qsid; let who = null;
      if (t) { const s = await store.getSession(t); who = s && s.email; await store.delSession(t); }
      audit('logout', req, who);
      return sendC(res, 200, { ok: true }, 'qsid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    }
    if (p === '/api/auth/me') { const s = await sessionUser(req); return send(res, 200, { user: s ? await userPublic(s.user) : null }); }

    if (p === '/api/auth/verify' && m === 'POST') {
      const tok = await store.getToken(String(body.token || ''));
      if (!tok || tok.type !== 'verify' || tok.exp < Date.now()) return send(res, 400, { error: 'This verification link is invalid or expired.' });
      const usr = await store.getUserByEmail(tok.email); if (usr) { usr.verified = true; await store.putUser(usr); }
      await store.delToken(String(body.token));
      audit('email_verified', req, tok.email);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/auth/resend-verify' && m === 'POST') {
      if (tooMany(res, 'rv:' + ip, 6, 3600000)) return;
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (!s.user.verified) emailVerify(s.user).catch(() => {});
      return send(res, 200, { ok: true });
    }
    if (p === '/api/auth/request-reset' && m === 'POST') {
      if (tooMany(res, 'rr:' + ip, 6, 3600000)) return;
      const email = String(body.email || '').trim().toLowerCase();
      const usr = await store.getUserByEmail(email);
      if (usr) {
        const t = crypto.randomBytes(20).toString('hex');
        await store.putToken(t, { type: 'reset', email, exp: Date.now() + 1000 * 60 * 60 });
        const url = `${APP_URL}/reset.html?token=${t}`;
        sendMail(email, 'Reset your Quantra AI password',
          shell('Reset your password', `<p style="color:#93A0B8">Click below to choose a new password. This link expires in 1 hour.</p>${btn(url, 'Reset password')}<p style="color:#5A6680;font-size:12px">If you didn’t request this, you can ignore it. Link: ${url}</p>`),
          `Reset your Quantra AI password: ${url}`).catch(() => {});
      }
      audit('reset_requested', req, email, { exists: !!usr });
      return send(res, 200, { ok: true }); // never reveal whether the email exists
    }
    if (p === '/api/auth/reset' && m === 'POST') {
      if (tooMany(res, 'rs:' + ip, 10, 3600000)) return;
      const tok = await store.getToken(String(body.token || '')), pw = String(body.password || '');
      if (!tok || tok.type !== 'reset' || tok.exp < Date.now()) return send(res, 400, { error: 'This reset link is invalid or expired.' });
      if (pw.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      const wkr = weakPassword(pw, tok.email); if (wkr) return send(res, 400, { error: wkr });
      const usr = await store.getUserByEmail(tok.email);
      if (usr) await store.delSessionsForEmail(tok.email); // sign out other sessions on reset
      if (usr) { usr.passHash = hashPw(pw); usr.verified = true; await store.putUser(usr); }
      await store.delToken(String(body.token));
      audit('password_reset', req, tok.email);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/me/data') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (m === 'GET') return send(res, 200, await store.getUserData(s.user.id));
      if (m === 'PUT') {
        const org = await store.getOrg(s.user.orgId), cfg = planOf(org && org.plan);
        const d = await store.getUserData(s.user.id);
        if (Array.isArray(body.watchlist)) d.watchlist = body.watchlist.slice(0, cfg.watchlistMax);
        if (body.prefs && typeof body.prefs === 'object') d.prefs = { ...d.prefs, ...body.prefs };
        if (Array.isArray(body.screens)) d.screens = body.screens.slice(0, 50);
        if (Array.isArray(body.portfolio)) d.portfolio = body.portfolio.slice(0, 200);
        await store.putUserData(s.user.id, d);
        return send(res, 200, d);
      }
    }
    if (p === '/api/me/limits' && m === 'GET') {
      const s = await sessionUser(req);
      const org = s ? await store.getOrg(s.user.orgId) : null;
      const plan = org ? org.plan : 'free', cfg = planOf(plan);
      const used = (org && org.usage && org.usage.day === new Date().toISOString().slice(0, 10)) ? org.usage.ai : 0;
      return send(res, 200, { loggedIn: !!s, plan, aiVerdicts: cfg.aiVerdicts, intraday: cfg.intraday, exports: cfg.exports, screener: cfg.screener, watchlistMax: cfg.watchlistMax, aiDaily: cfg.aiDaily, aiUsed: used });
    }
    if (p === '/api/me/export' && m === 'GET') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const org = await store.getOrg(s.user.orgId) || {};
      const out = { exportedAt: new Date().toISOString(), profile: { id: s.user.id, email: s.user.email, name: s.user.name, role: s.user.role, createdAt: s.user.createdAt, verified: !!s.user.verified }, workspace: { id: org.id, name: org.name, plan: org.plan }, data: await store.getUserData(s.user.id) };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="quantra-data-export.json"', 'Cache-Control': 'no-store' });
      audit('data_export', req, s.user.email);
      return res.end(JSON.stringify(out, null, 2));
    }
    if (p === '/api/me/delete' && m === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (!verifyPw(String(body.password || ''), s.user.passHash)) return send(res, 401, { error: 'Wrong password.' });
      await store.deleteUserData(s.user.id);
      await store.delSessionsForEmail(s.user.email);
      await store.deleteUser(s.user.email);
      if (s.user.role === 'owner' && (await store.countMembers(s.user.orgId)) === 0) await store.deleteOrg(s.user.orgId);
      audit('account_deleted', req, s.user.email);
      return sendC(res, 200, { ok: true }, 'qsid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    }

    /* ---- super-admin (oversight only: emails + metadata + audit; NEVER passwords) ---- */
    if (p === '/api/admin/users' && m === 'GET') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (!isSuperAdmin(s.user.email)) { audit('admin_denied', req, s.user.email, { path: p }); return send(res, 403, { error: 'Forbidden.' }); }
      audit('admin_view_users', req, s.user.email);
      const users = await store.allUsers();
      const rows = await Promise.all(users.map(async (u) => {
        const org = await store.getOrg(u.orgId);
        return { id: u.id, email: u.email, name: u.name, role: u.role, verified: !!u.verified, plan: (org || {}).plan || 'free', workspace: (org || {}).name || null, createdAt: u.createdAt || null, lastLogin: u.lastLogin || null, superAdmin: isSuperAdmin(u.email) };
      }));
      rows.sort((a, b) => (b.lastLogin || b.createdAt || 0) - (a.lastLogin || a.createdAt || 0));
      return send(res, 200, { count: rows.length, users: rows });
    }
    if (p === '/api/admin/audit' && m === 'GET') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (!isSuperAdmin(s.user.email)) { audit('admin_denied', req, s.user.email, { path: p }); return send(res, 403, { error: 'Forbidden.' }); }
      const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '300', 10), 1), 1000);
      const offset = Math.max(parseInt(u.searchParams.get('offset') || '0', 10), 0);
      audit('admin_view_audit', req, s.user.email);
      return send(res, 200, { events: await store.listAudit(limit, offset) });
    }
    if (p === '/api/admin/stats' && m === 'GET') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (!isSuperAdmin(s.user.email)) { audit('admin_denied', req, s.user.email, { path: p }); return send(res, 403, { error: 'Forbidden.' }); }
      await metricsFlush();
      const today = new Date().toISOString().slice(0, 10);
      const days = (await store.allStats()).slice(-30).map((d) => ({ date: d.date, views: d.views || 0, uniques: d.uniques || 0, api: d.api || 0 }));
      const users = await store.allUsers();
      const signups = { total: users.length, today: users.filter((u2) => u2.createdAt && new Date(u2.createdAt).toISOString().slice(0, 10) === today).length };
      const verified = users.filter((u2) => u2.verified).length;
      const paid = users.filter((u2) => u2.plan && u2.plan !== 'free').length;
      const td = days.find((d) => d.date === today) || { views: 0, uniques: 0, api: 0 };
      const topPages = Object.entries(metrics.pages).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([path, count]) => ({ path, count }));
      audit('admin_view_stats', req, s.user.email);
      return send(res, 200, {
        today: td, days, topPages,
        users: { total: users.length, verified, paid }, signups,
        status: { storage: store.kind, finnhub: !!FINNHUB_KEY, coingecko: !!COINGECKO_KEY, ai: !!ANTHROPIC_KEY, cryptoStream: true, uptimeSec: Math.round(process.uptime()), node: process.version },
      });
    }
    if (p === '/api/org' && m === 'GET') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const org = (await store.getOrg(s.user.orgId)) || {};
      return send(res, 200, { id: org.id, name: org.name, plan: org.plan, members: await store.countMembers(s.user.orgId), apiKey: s.user.role === 'owner' ? org.apiKey : undefined, billingEnabled: !!stripe, devBilling: !!process.env.QUANTRA_DEV_BILLING && !PROD });
    }

    // dev-only: simulate a plan change without Stripe (never in production)
    if (p === '/api/billing/dev-upgrade' && m === 'POST') {
      if (!process.env.QUANTRA_DEV_BILLING || PROD) return send(res, 404, { error: 'not found' });
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const plan = String(body.plan || 'free');
      if (!['free', 'pro', 'ultimate', 'enterprise'].includes(plan)) return send(res, 400, { error: 'unknown plan' });
      const org = await store.getOrg(s.user.orgId); org.plan = plan; await store.putOrg(org);
      return send(res, 200, { ok: true, plan });
    }

    if (p === '/api/ai/reason' && m === 'POST') {
      const s = await sessionUser(req);
      const org = s ? await store.getOrg(s.user.orgId) : null;
      const cfg = planOf(org && org.plan);
      // Premium: LLM-enhanced read with live-news comprehension for paid plans,
      // when an API key is configured and the daily allowance isn't spent.
      if (cfg.aiVerdicts && ANTHROPIC_KEY && Anthropic && AI_MODEL && org) {
        const usage = aiUsage(org);
        if (usage.ai < cfg.aiDaily) {
          usage.ai++; await store.putOrg(org);
          const result = await api['ai/reason'](Object.fromEntries(u.searchParams.entries()), body);
          if (result && result.ok && result.text) return send(res, 200, Object.assign({ source: 'ai' }, result));
        }
      }
      // Everyone always gets a Quantra AI read (no key / free plan / over cap → local engine).
      return send(res, 200, localReason(body || {}));
    }
    if (p === '/api/billing/checkout' && m === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (!stripe) return send(res, 200, { ok: false, reason: 'billing-disabled' });
      const plan = String(body.plan || '');
      if (!PRICES[plan]) return send(res, 200, { ok: false, reason: 'unknown-plan' });
      const org = await store.getOrg(s.user.orgId);
      if (!org.stripeCustomerId) { const c = await stripe.customers.create({ email: s.user.email, metadata: { orgId: org.id } }); org.stripeCustomerId = c.id; await store.putOrg(org); }
      const cs = await stripe.checkout.sessions.create({ mode: 'subscription', customer: org.stripeCustomerId, line_items: [{ price: PRICES[plan], quantity: 1 }], success_url: `${APP_URL}/?billing=success`, cancel_url: `${APP_URL}/?billing=cancel`, metadata: { orgId: org.id, plan } });
      return send(res, 200, { ok: true, url: cs.url });
    }
    if (p === '/api/billing/portal' && m === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (!stripe) return send(res, 200, { ok: false, reason: 'billing-disabled' });
      const org = await store.getOrg(s.user.orgId);
      if (!org.stripeCustomerId) return send(res, 200, { ok: false, reason: 'no-customer' });
      const ps = await stripe.billingPortal.sessions.create({ customer: org.stripeCustomerId, return_url: APP_URL });
      return send(res, 200, { ok: true, url: ps.url });
    }
    return send(res, 404, { error: 'unknown route' });
  } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
}

function readRaw(req) { return new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => resolve(d)); req.on('error', () => resolve('')); }); }
async function billingWebhook(req, res) {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) { res.writeHead(200); return res.end('ok'); }
  const raw = await readRaw(req);
  let ev; try { ev = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch (e) { res.writeHead(400); return res.end('bad signature'); }
  try {
    const o = ev.data.object;
    if (ev.type === 'checkout.session.completed') {
      const org = (o.metadata && await store.getOrg(o.metadata.orgId)) || await store.findOrgByStripeCustomer(o.customer);
      if (org) { org.plan = (o.metadata && o.metadata.plan) || org.plan; org.stripeSubId = o.subscription; await store.putOrg(org); }
    } else if (ev.type === 'customer.subscription.deleted') {
      const org = await store.findOrgByStripeCustomer(o.customer); if (org) { org.plan = 'free'; await store.putOrg(org); }
    } else if (ev.type === 'customer.subscription.updated') {
      const org = await store.findOrgByStripeCustomer(o.customer); if (org && o.status !== 'active' && o.status !== 'trialing') { org.plan = 'free'; await store.putOrg(org); }
    }
  } catch (e) { console.warn('[webhook]', e.message); }
  res.writeHead(200); res.end('ok');
}

/* ============================================================
   Track record — daily snapshot of Quantra Scores + realised
   forward returns. Accumulates from day one so performance can
   be reported honestly (not back-filled).
   ============================================================ */
const TR_HORIZONS = [5, 10, 30];
const trDay = () => new Date().toISOString().slice(0, 10);
let trBusy = false;
// Tamper-evident hash chain: each day's hash binds its items to the prior day's
// hash, so a published ledger lets a third party prove no snapshot was altered,
// inserted, or back-dated after the fact.
const chainHash = (date, items, prevHash) => crypto.createHash('sha256')
  .update(JSON.stringify({ date, items, prev: prevHash })).digest('hex');
async function writeSnapshot(date, items) {
  const all = await store.allSnapshots();
  const prior = all.filter((s) => s.date < date).pop();
  const prevHash = prior ? (prior.hash || 'genesis') : 'genesis';
  const hash = chainHash(date, items, prevHash);
  await store.putSnapshot(date, { items, hash, prevHash, createdAt: new Date().toISOString() });
}
async function snapshotToday() {
  if (trBusy || !Q) return; trBusy = true;
  try {
    const d = trDay();
    if (await store.getSnapshot(d)) return;
    const boards = await Promise.all([
      api['crypto/markets']({ page: '1' }).catch(() => []), api['stock/board']().catch(() => []),
      api['etf/board']().catch(() => []), api['commodity/board']().catch(() => []), api['index/board']().catch(() => []),
    ]);
    const items = boards.flat()
      .map((it) => ({ type: it.type, symbol: it.symbol, score: Q.liteScore(it.spark, it.change24h), price: it.price }))
      .filter((x) => x.score != null && x.price != null);
    if (items.length) await writeSnapshot(d, items);
  } catch (e) { console.warn('[track] snapshot:', e.message); } finally { trBusy = false; }
}
// Recompute the whole chain and confirm every link matches what was stored.
async function verifyLedger() {
  const snaps = await store.allSnapshots();
  let prevHash = 'genesis', valid = true, brokenAt = null;
  const entries = snaps.map((s) => {
    const stored = s.hash || null;
    const recomputed = chainHash(s.date, s.items || [], s.prevHash || 'genesis');
    const ok = stored != null && recomputed === stored && (s.prevHash || 'genesis') === prevHash;
    if (!ok && valid) { valid = false; brokenAt = s.date; }
    prevHash = stored || 'genesis';
    return { date: s.date, hash: stored, prevHash: s.prevHash || 'genesis', count: (s.items || []).length, createdAt: s.createdAt || null, ok };
  });
  return { valid, length: entries.length, head: entries.length ? entries[entries.length - 1].hash : null, brokenAt, entries };
}
// Dynamic SVG accuracy badge for embedding on a landing page (<img src=…>).
function badgeSvg(tr) {
  let best = null;
  if (!tr.building) for (const h of tr.horizons || []) if (h.hitRate != null && (!best || h.evaluated > best.evaluated)) best = h;
  const val = best ? (best.hitRate * 100).toFixed(1) + '%' : 'building';
  const sub = best ? `${best.horizon}-session · n=${best.evaluated} · as of ${tr.latest || tr.since}` : 'accumulating daily';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="68" viewBox="0 0 340 68" role="img" aria-label="Quantra Score accuracy ${esc(val)}">
  <defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop stop-color="#34D399"/><stop offset=".5" stop-color="#22D3EE"/><stop offset="1" stop-color="#818CF8"/></linearGradient></defs>
  <rect x="1" y="1" width="338" height="66" rx="12" fill="#0A0F1C" stroke="#1E293B"/>
  <circle cx="28" cy="34" r="8" fill="url(#g)"/>
  <text x="48" y="27" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="11" font-weight="600" letter-spacing=".06em" fill="#94A3B8">QUANTRA SCORE · DIRECTIONAL ACCURACY</text>
  <text x="48" y="50" font-family="'Space Grotesk',Inter,Arial,sans-serif" font-size="22" font-weight="700" fill="#34D399">${esc(val)}</text>
  <text x="${best ? 118 : 150}" y="49" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="11" fill="#64748B">${esc(sub)}</text>
</svg>`;
}
async function trackRecord() {
  const snaps = await store.allSnapshots();
  const led = await verifyLedger();
  const integrity = { chained: true, valid: led.valid, length: led.length, head: led.head ? led.head.slice(0, 16) + '…' : null };
  if (snaps.length < 2) return { building: true, days: snaps.length, since: snaps[0] && snaps[0].date, samples: 0, horizons: [], integrity };
  const dates = snaps.map((s) => s.date);
  const byDate = new Map(snaps.map((s) => [s.date, new Map(s.items.map((i) => [i.type + ':' + i.symbol, i]))]));
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  const onOrAfter = (t) => dates.find((d) => d >= t);
  const horizons = TR_HORIZONS.map((H) => {
    let n = 0, hits = 0, directional = 0, sumRet = 0, bullN = 0, bullUp = 0, bearN = 0, bearDown = 0;
    for (const s of snaps) {
      const later = onOrAfter(addDays(s.date, H));
      if (!later || later === s.date) continue;
      const gap = (new Date(later) - new Date(s.date)) / 86400000;
      if (gap < H - 1 || gap > H + 4) continue;
      const lm = byDate.get(later);
      for (const it of s.items) {
        const l = lm.get(it.type + ':' + it.symbol);
        if (!l || !l.price || !it.price) continue;
        const ret = (l.price - it.price) / it.price; n++; sumRet += ret;
        if (it.score >= 56) { bullN++; directional++; if (ret > 0) { bullUp++; hits++; } }
        else if (it.score < 45) { bearN++; directional++; if (ret < 0) { bearDown++; hits++; } }
      }
    }
    return { horizon: H, samples: n, evaluated: directional, hitRate: directional ? hits / directional : null,
      avgReturn: n ? sumRet / n : null, bullUp: bullN ? bullUp / bullN : null, bearDown: bearN ? bearDown / bearN : null };
  });
  return { building: false, days: snaps.length, since: dates[0], latest: dates[dates.length - 1], samples: horizons.reduce((a, h) => a + h.samples, 0), horizons, integrity };
}
async function trackDevSeed() {
  const d30 = (() => { const x = new Date(); x.setDate(x.getDate() - 30); return x.toISOString().slice(0, 10); })();
  await writeSnapshot(d30, [
    { type: 'stock', symbol: 'AAA', score: 80, price: 100 }, { type: 'stock', symbol: 'BBB', score: 75, price: 100 },
    { type: 'stock', symbol: 'CCC', score: 30, price: 100 }, { type: 'stock', symbol: 'DDD', score: 35, price: 100 },
  ]);
  await writeSnapshot(trDay(), [
    { type: 'stock', symbol: 'AAA', score: 60, price: 110 }, { type: 'stock', symbol: 'BBB', score: 60, price: 95 },
    { type: 'stock', symbol: 'CCC', score: 50, price: 92 }, { type: 'stock', symbol: 'DDD', score: 50, price: 105 },
  ]);
}

/* ============================================================
   Finnhub trade relay → SSE. One upstream WS to Finnhub (key stays
   server-side); per-symbol fan-out to browser EventSource clients
   gives true tick-by-tick US stock/ETF data without exposing the key.
   ============================================================ */
const WSImpl = (typeof WebSocket !== 'undefined') ? WebSocket : null;
const fhSubs = new Map();            // symbol -> Set(res)
let fhWS = null, fhReady = false;
function fhSend(o) { try { if (fhWS && fhReady) fhWS.send(JSON.stringify(o)); } catch {} }
function fhConnect() {
  if (!FINNHUB_KEY || !WSImpl || fhWS) return;
  try {
    fhWS = new WSImpl(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
    fhWS.onopen = () => { fhReady = true; for (const sym of fhSubs.keys()) fhSend({ type: 'subscribe', symbol: sym }); };
    fhWS.onmessage = (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (m.type !== 'trade' || !Array.isArray(m.data)) return;
      const last = new Map();                       // collapse to the latest price per symbol per batch
      for (const t of m.data) last.set(t.s, t);
      for (const [sym, t] of last) {
        const set = fhSubs.get(sym); if (!set || !set.size) continue;
        const line = `data: ${JSON.stringify({ p: t.p, t: t.t, v: t.v })}\n\n`;
        for (const res of set) { try { res.write(line); } catch {} }
      }
    };
    fhWS.onclose = () => { fhWS = null; fhReady = false; if (fhSubs.size) setTimeout(fhConnect, 3000); };
    fhWS.onerror = () => { try { fhWS && fhWS.close(); } catch {} };
  } catch { fhWS = null; }
}
function fhSubscribe(sym, res) { let set = fhSubs.get(sym); if (!set) { set = new Set(); fhSubs.set(sym, set); fhConnect(); fhSend({ type: 'subscribe', symbol: sym }); } set.add(res); }
function fhUnsubscribe(sym, res) { const set = fhSubs.get(sym); if (!set) return; set.delete(res); if (!set.size) { fhSubs.delete(sym); fhSend({ type: 'unsubscribe', symbol: sym }); } }
function tradeStream(req, res, u) {
  const sym = (u.searchParams.get('symbol') || '').toUpperCase();
  if (!FINNHUB_KEY || !WSImpl) { return send(res, 200, { ok: false, reason: 'stream-unavailable' }); }
  if (!sym) return send(res, 400, { error: 'no symbol' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });
  res.write('retry: 3000\n\n: connected\n\n');
  fhSubscribe(sym, res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); fhUnsubscribe(sym, res); });
}

store.ready().then(() => {
  snapshotToday();
  setInterval(snapshotToday, 6 * 60 * 60 * 1000).unref(); // daily-ish; no-ops if today is done
  metricsLoad();
  setInterval(metricsFlush, 120000).unref();              // persist footfall every 2 min
  process.on('SIGTERM', () => { metricsFlush().finally(() => process.exit(0)); });
  http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    try { track(req, u); } catch {}            // footfall analytics (non-blocking)
    // security headers on every response
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.sheetjs.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.coingecko.com https://open.er-api.com https://query1.finance.yahoo.com https://query2.finance.yahoo.com https://finnhub.io wss://ws-feed.exchange.coinbase.com wss://stream.binance.com:9443 wss://stream.binance.com; frame-ancestors 'self'; base-uri 'self'");
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // health checks
    if (u.pathname === '/healthz' || u.pathname === '/readyz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, storage: store.kind })); }
    // public track record
    if (u.pathname === '/api/stream/trades' && req.method === 'GET') return tradeStream(req, res, u);
    if (u.pathname === '/api/track-record' && req.method === 'GET') return send(res, 200, await trackRecord());
    if (u.pathname === '/api/track-record/ledger' && req.method === 'GET') return send(res, 200, await verifyLedger());
    if (u.pathname === '/api/track-record/badge.svg' && req.method === 'GET') {
      const svg = badgeSvg(await trackRecord());
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      return res.end(svg);
    }
    if (u.pathname === '/api/track-record/dev-seed' && req.method === 'POST') {
      if (!process.env.QUANTRA_DEV_BILLING || PROD) return send(res, 404, { error: 'not found' });
      await trackDevSeed(); return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/billing/webhook') return billingWebhook(req, res);
    if (u.pathname.startsWith('/api/auth/') || u.pathname.startsWith('/api/admin/') || u.pathname === '/api/me/data' || u.pathname === '/api/me/limits' || u.pathname === '/api/me/export' || u.pathname === '/api/me/delete' || u.pathname === '/api/org' || u.pathname === '/api/ai/reason' || u.pathname.startsWith('/api/billing/')) {
      return authRoute(req, res, u);
    }
    if (u.pathname.startsWith('/api/')) {
      const handler = api[u.pathname.replace('/api/', '')];
      if (!handler) return send(res, 404, { error: 'unknown route' });
      try {
        const body = req.method === 'POST' ? await readBody(req) : null;
        return send(res, 200, await handler(Object.fromEntries(u.searchParams.entries()), body));
      } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
    }
    // Notes page is super-admin only — gate it server-side (not just hide the link).
    if (u.pathname === '/notes.html' || u.pathname === '/notes') {
      const s = await sessionUser(req);
      if (!s || !isSuperAdmin(s.user.email)) { res.writeHead(302, { Location: '/' }); return res.end(); }
    }
    serveStatic(req, res);
  }).on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n  ⚠ Port ${PORT} is already in use — a Quantra server is probably already running.`);
      console.error(`  → Either just open  http://localhost:${PORT}  (it's already up),`);
      console.error(`  → or free the port first:  npx kill-port ${PORT}   then run  node server.js`);
      console.error(`  → or pick another port:    set PORT=5300 && node server.js\n`);
      process.exit(1);
    }
    console.error('Server error:', e.message); process.exit(1);
  }).listen(PORT, () => {
    console.log('\n  ⚡ Quantra AI Terminal  →  http://localhost:' + PORT);
    console.log('  storage: ' + store.kind + ' · billing: ' + (stripe ? 'on' : 'off') + ' · email: ' + (process.env.RESEND_API_KEY ? 'resend' : 'dev-console') + '\n');
  });
}).catch((e) => { console.error('Store init failed:', e.message); process.exit(1); });
