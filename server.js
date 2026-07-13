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
const zlib = require('zlib');

// Resilience: a stray async error should degrade one request, never take the
// whole web server down. Log and keep serving instead of crashing the process.
process.on('unhandledRejection', (e) => { try { noteError(); } catch {} console.error('[unhandledRejection]', (e && e.stack) || e); });
process.on('uncaughtException', (e) => { try { noteError(); } catch {} console.error('[uncaughtException]', (e && e.stack) || e); });

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
const FMP_KEY = process.env.FMP_API_KEY || '';         // Financial Modeling Prep — economic calendar (free tier)
const MARKETAUX_KEY = process.env.MARKETAUX_API_KEY || ''; // marketaux — premium multi-source news (free tier)
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY || ''; // Twelve Data — fresher global quotes incl. Gulf/Asia
const POLYGON_KEY = process.env.POLYGON_API_KEY || '';  // Polygon.io — US stocks (real-time needs the Advanced tier; lower tiers are 15-min delayed). US-only.
// RapidAPI — Real-Time Finance Data (Google-Finance-sourced): global quotes incl. NSE/BSE
// + Gulf/Asia, plus news. Fills the international/India gap that Twelve Data's tier misses.
// Key + host stay server-side; host is overridable if you subscribe to a different RapidAPI feed.
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'real-time-finance-data.p.rapidapi.com';
// Map a Yahoo suffix → Twelve Data exchange code so international quotes resolve.
const TD_EXCH = { NS: 'NSE', BO: 'BSE', L: 'LSE', HK: 'HKEX', T: 'XTKS', KS: 'KRX', TW: 'TWSE', SI: 'SGX', AX: 'ASX', SR: 'Tadawul', AE: 'DFM', AD: 'ADX', JO: 'JSE', SS: 'SSE', SZ: 'SZSE', DE: 'XETR', PA: 'Euronext', AS: 'Euronext', MI: 'MTA', MC: 'BME', SW: 'SIX', ST: 'OMX', OL: 'OSL', CO: 'OMXC', TO: 'TSX', SA: 'B3', MX: 'BMV', JK: 'IDX', BK: 'SET', KL: 'Bursa' };
function tdSymbol(yh) {
  const i = String(yh).lastIndexOf('.');
  if (i < 0) return { symbol: yh };                    // US / plain ticker
  const ex = TD_EXCH[yh.slice(i + 1)];
  return ex ? { symbol: yh.slice(0, i), exchange: ex } : { symbol: yh };
}
// Map a Yahoo suffix → the Google-Finance exchange code Real-Time Finance Data expects
// (symbol format is TICKER:EXCHANGE, e.g. RELIANCE:NSE, 7203:TYO). US plain tickers are
// already covered by Finnhub, so we return null for them (RapidAPI serves international only).
const RAPID_EXCH = { NS: 'NSE', BO: 'BOM', L: 'LON', DE: 'ETR', PA: 'EPA', AS: 'AMS', MI: 'BIT', MC: 'BME', SW: 'SWX', ST: 'STO', OL: 'OSL', CO: 'CPH', HE: 'HEL', T: 'TYO', HK: 'HKG', SS: 'SHA', SZ: 'SHE', KS: 'KRX', TW: 'TPE', SI: 'SGX', AX: 'ASX', TO: 'TSE', SA: 'BVMF', MX: 'BMV', SR: 'TADAWUL', JK: 'JKT', BK: 'BKK', KL: 'KLSE' };
function rapidSymbol(yh) {
  const s = String(yh);
  if (s.includes(':')) return s;                        // already TICKER:EXCH
  const i = s.lastIndexOf('.');
  if (i < 0) return null;                                // US / plain ticker → Finnhub handles it
  const ex = RAPID_EXCH[s.slice(i + 1)];
  return ex ? `${s.slice(0, i)}:${ex}` : null;
}
const rapidHeaders = () => ({ 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST });
/* ---- Dhan (NSE F&O — real exchange data via the user's own broker account) ----
   Free API with a Dhan account: dhan.co → DhanHQ → generate access token, then set
   DHAN_ACCESS_TOKEN + DHAN_CLIENT_ID on Render. Powers real NIFTY/BANKNIFTY/FINNIFTY
   option chains in the existing Options card. Rate limit: chain ≈ 1 req/3 s → cached. */
const DHAN_TOKEN = process.env.DHAN_ACCESS_TOKEN || '';
const DHAN_CLIENT = process.env.DHAN_CLIENT_ID || '';
const DHAN_ON = !!(DHAN_TOKEN && DHAN_CLIENT);
// NSE index underlyings (Dhan security ids, IDX_I segment)
const DHAN_UNDERLYINGS = {
  NIFTY: { scrip: 13, name: 'NIFTY 50' }, '^NSEI': { scrip: 13, name: 'NIFTY 50' },
  BANKNIFTY: { scrip: 25, name: 'NIFTY BANK' }, '^NSEBANK': { scrip: 25, name: 'NIFTY BANK' },
  FINNIFTY: { scrip: 27, name: 'NIFTY FIN SERVICE' },
};
async function dhanPost(pathn, bodyObj) {
  const r = await fetch(`https://api.dhan.co/v2${pathn}`, {
    method: 'POST',
    headers: { 'access-token': DHAN_TOKEN, 'client-id': DHAN_CLIENT, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  if (!r.ok) throw new Error(`dhan ${r.status}`);
  return r.json();
}
// Full option chain for an NSE index → same shape the Options card already renders.
async function dhanChain(sym, dateEpoch) {
  const u = DHAN_UNDERLYINGS[sym]; if (!u || !DHAN_ON) return null;
  const exps = await cached(`dhan:exp:${u.scrip}`, 10 * 60 * 1000, async () => {
    const d = await dhanPost('/optionchain/expirylist', { UnderlyingScrip: u.scrip, UnderlyingSeg: 'IDX_I' });
    return (d && d.data) || [];
  });
  if (!exps.length) return null;
  let expiry = exps[0];
  if (dateEpoch) { const want = new Date(dateEpoch * 1000).toISOString().slice(0, 10); if (exps.includes(want)) expiry = want; }
  const chain = await cached(`dhan:oc:${u.scrip}:${expiry}`, 60 * 1000, async () => {
    const d = await dhanPost('/optionchain', { UnderlyingScrip: u.scrip, UnderlyingSeg: 'IDX_I', Expiry: expiry });
    return (d && d.data) || null;
  });
  if (!chain || !chain.oc) return null;
  const spot = chain.last_price != null ? +chain.last_price : null;
  const calls = [], puts = [];
  for (const [k, v] of Object.entries(chain.oc)) {
    const strike = +k; if (!isFinite(strike)) continue;
    const side = (o, arr, itm) => { if (!o) return; arr.push({ strike,
      last: o.last_price != null ? +o.last_price : null,
      bid: o.top_bid_price != null ? +o.top_bid_price : null,
      ask: o.top_ask_price != null ? +o.top_ask_price : null,
      iv: o.implied_volatility != null ? +(+o.implied_volatility).toFixed(1) : null,
      vol: o.volume != null ? +o.volume : null, oi: o.oi != null ? +o.oi : null, itm }); };
    side(v.ce, calls, spot != null && strike < spot);
    side(v.pe, puts, spot != null && strike > spot);
  }
  calls.sort((a, b) => a.strike - b.strike); puts.sort((a, b) => a.strike - b.strike);
  const toEpoch = (d) => Math.round(Date.parse(d + 'T10:00:00Z') / 1000);
  return { ok: true, symbol: sym, source: 'dhan', spot, currency: 'INR',
    expirations: exps.slice(0, 24).map(toEpoch), expiry: toEpoch(expiry), calls, puts };
}
async function dhanTest() {
  if (!DHAN_ON) return { configured: false };
  try { const d = await dhanPost('/optionchain/expirylist', { UnderlyingScrip: 13, UnderlyingSeg: 'IDX_I' });
    const n = (d && d.data && d.data.length) || 0;
    return n ? { configured: true, ok: true, symbol: 'NIFTY', expiries: n }
      : { configured: true, ok: false, symbol: 'NIFTY', error: 'no expiries returned' };
  } catch (e) { return { configured: true, ok: false, symbol: 'NIFTY', error: e.message }; }
}
// M4: quota guard — daily call counter + a 30-min circuit breaker on 429 so a burned
// free-tier quota fails FAST to the Yahoo fallback instead of burning more calls (and
// the operator can see today's burn in /admin → System status).
const rapidState = { day: '', calls: 0, breakerUntil: 0 };
async function rapidGet(url) {
  const today = new Date().toISOString().slice(0, 10);
  if (rapidState.day !== today) { rapidState.day = today; rapidState.calls = 0; }
  if (Date.now() < rapidState.breakerUntil) throw new Error('rapidapi breaker open (last 429)');
  rapidState.calls++;
  try { return await getJSON(url, rapidHeaders()); }
  catch (e) { if (/429/.test(String(e.message))) rapidState.breakerUntil = Date.now() + 30 * 60 * 1000; throw e; }
}
// Real-time US quote from Finnhub (free tier covers US stocks/ETFs only). Excludes
// exchange-suffixed, futures (=), index (^), FX (=X). Returns null → fall back.
const fhEligible = (s) => FINNHUB_KEY && !/[.\^=]/.test(String(s));
async function fhQuote(sym) {
  if (!fhEligible(sym)) return null;
  try {
    const d = await cached(`fhq:${sym}`, 20000, () => getJSON(`${FINNHUB}/quote?symbol=${encodeURIComponent(sym)}&token=${FINNHUB_KEY}`));
    if (!d || d.c === 0 || d.c == null) return null;
    return { price: d.c, prev: d.pc, change: isFinite(+d.d) ? +d.d : null, changePct: isFinite(+d.dp) ? +d.dp : null, asOf: d.t ? d.t * 1000 : null };
  } catch { return null; }
}
// Authoritative US market status incl. holidays (Finnhub free covers US).
async function usMarketStatus() {
  if (!FINNHUB_KEY) return null;
  try { const d = await cached('mst:US', 60000, () => getJSON(`${FINNHUB}/stock/market-status?exchange=US&token=${FINNHUB_KEY}`)); if (d && typeof d.isOpen === 'boolean') return { open: d.isOpen, holiday: d.holiday || null }; } catch {} return null;
}
const US_INDEX = new Set(['^GSPC', '^DJI', '^IXIC', '^RUT', '^VIX']);
const isUSsym = (s) => US_INDEX.has(s) || !/[.\^=]/.test(String(s));
// Curated 2026 full-day exchange closures (Finnhub's free holiday feed is US-only).
// Conservative — only well-established dates, to avoid falsely marking a trading day closed.
const HOLIDAYS_2026 = {
  IN: ['2026-01-26', '2026-04-03', '2026-05-01', '2026-08-15', '2026-10-02', '2026-12-25'],
  UK: ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28'],
  DE: ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-12-24', '2026-12-25', '2026-12-31'],
  FR: ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-12-25'],
  NL: ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-12-25'],
  IT: ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-12-25'],
  ES: ['2026-01-01', '2026-04-03', '2026-05-01', '2026-12-25'],
  CH: ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-12-25', '2026-12-26'],
  JP: ['2026-01-01', '2026-01-02', '2026-01-03', '2026-12-31'],
  HK: ['2026-01-01', '2026-04-03', '2026-05-01', '2026-12-25'],
  AU: ['2026-01-01', '2026-01-26', '2026-04-03', '2026-04-06', '2026-12-25', '2026-12-28'],
  CA: ['2026-01-01', '2026-04-03', '2026-12-25'],
  SG: ['2026-01-01', '2026-05-01', '2026-12-25'],
};
const HOL_REGION = { NS: 'IN', BO: 'IN', L: 'UK', DE: 'DE', PA: 'FR', AS: 'NL', MI: 'IT', MC: 'ES', SW: 'CH', T: 'JP', HK: 'HK', AX: 'AU', TO: 'CA', SI: 'SG' };
function curatedHoliday(sym) {
  const i = String(sym).lastIndexOf('.'); if (i < 0) return null;
  const reg = HOL_REGION[sym.slice(i + 1)]; if (!reg) return null;
  return (HOLIDAYS_2026[reg] || []).includes(new Date().toISOString().slice(0, 10)) ? 'Holiday' : null;
}
// Real-time-ish quote from Twelve Data (returns null → caller falls back to Yahoo).
async function tdQuote(yh) {
  if (!TWELVEDATA_KEY) return null;
  const { symbol, exchange } = tdSymbol(yh);
  const u = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}${exchange ? '&exchange=' + encodeURIComponent(exchange) : ''}&apikey=${TWELVEDATA_KEY}`;
  try {
    const d = await cached(`td:${yh}`, 15000, () => getJSON(u));
    if (!d || d.status === 'error' || d.code) return null;
    const price = +d.close, prev = +d.previous_close;
    if (!isFinite(price)) return null;
    return { price, prev: isFinite(prev) ? prev : null, change: isFinite(+d.change) ? +d.change : null, changePct: isFinite(+d.percent_change) ? +d.percent_change : null, currency: d.currency || null, asOf: d.datetime || null };
  } catch { return null; }
}
// Real-time-ish quote from Polygon.io — US plain tickers only (no suffix/^/=). Real-time on the
// Advanced tier; lower tiers return 15-min-delayed/EOD. Used only as a fallback AFTER Finnhub so it
// never downgrades the free real-time US feed. Returns null → caller falls back.
async function polyQuote(sym) {
  if (!POLYGON_KEY || /[.\^=]/.test(String(sym))) return null;
  try {
    const d = await cached(`poly:${sym}`, 15000, () => getJSON(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(sym)}?apiKey=${POLYGON_KEY}`));
    const t = d && d.ticker; if (!t) return null;
    const price = (t.lastTrade && t.lastTrade.p) || (t.day && t.day.c) || (t.prevDay && t.prevDay.c);
    const prev = t.prevDay && t.prevDay.c;
    if (!(price > 0)) return null;
    return {
      price, prev: prev || null,
      change: (t.todaysChange != null) ? t.todaysChange : (prev ? price - prev : null),
      changePct: (t.todaysChangePerc != null) ? t.todaysChangePerc : (prev ? ((price - prev) / prev) * 100 : null),
      currency: 'USD',
      asOf: (t.lastTrade && t.lastTrade.t) ? Math.round(t.lastTrade.t / 1e6) : (t.updated ? Math.round(t.updated / 1e6) : null),
    };
  } catch { return null; }
}
// Real-time-ish quote from RapidAPI (Real-Time Finance Data). International only — US is
// served by Finnhub. Google-Finance-sourced, so it covers NSE/BSE and most world exchanges.
// Defensive field parsing (the feed nests the quote under `data`). Returns null → fall back.
async function rapidQuote(yh) {
  if (!RAPIDAPI_KEY) return null;
  const rs = rapidSymbol(yh); if (!rs) return null;
  try {
    // 60s TTL (not 15s): RapidAPI free tiers have tight monthly quotas — a longer cache
    // keeps international prices "live enough" while burning ~4x fewer requests.
    const d = await cached(`rapid:q:${rs}`, 60000, () => rapidGet(
      `https://${RAPIDAPI_HOST}/stock-quote?symbol=${encodeURIComponent(rs)}&language=en`));
    const q = (d && d.data) || d; if (!q) return null;
    const price = +((q.price != null) ? q.price : q.last);
    if (!isFinite(price)) return null;
    const prev = +((q.previous_close != null) ? q.previous_close : q.prev_close);
    const pct = (q.change_percent != null) ? +q.change_percent : (q.percent_change != null ? +q.percent_change : null);
    return {
      price, prev: isFinite(prev) ? prev : null,
      change: isFinite(+q.change) ? +q.change : (isFinite(prev) ? +(price - prev).toFixed(4) : null),
      changePct: isFinite(pct) ? pct : (isFinite(prev) && prev ? +(((price - prev) / prev) * 100).toFixed(2) : null),
      currency: q.currency || null,
      asOf: q.last_update_utc ? (Date.parse(q.last_update_utc) || null) : null,
    };
  } catch { return null; }
}
// Verbose provider self-tests for the admin diagnostic — surface the RAW success/error
// (e.g. "symbol not found", "requires a paid plan", "out of credits") so the operator can
// tell instantly whether a data key works and covers a given market.
async function tdTest(yh) {
  if (!TWELVEDATA_KEY) return { configured: false };
  const { symbol, exchange } = tdSymbol(yh);
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}${exchange ? '&exchange=' + encodeURIComponent(exchange) : ''}&apikey=${TWELVEDATA_KEY}`;
  try { const d = await getJSON(url);
    if (d && d.close && !d.code && d.status !== 'error') return { configured: true, ok: true, symbol: yh, price: +d.close, exchange: d.exchange || exchange || '' };
    return { configured: true, ok: false, symbol: yh, error: (d && (d.message || d.status)) || 'no data returned' };
  } catch (e) { return { configured: true, ok: false, symbol: yh, error: e.message }; }
}
async function polyTest(sym) {
  if (!POLYGON_KEY) return { configured: false };
  try { const d = await getJSON(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(sym)}?apiKey=${POLYGON_KEY}`);
    const t = d && d.ticker, price = t && ((t.lastTrade && t.lastTrade.p) || (t.day && t.day.c) || (t.prevDay && t.prevDay.c));
    if (price > 0) return { configured: true, ok: true, symbol: sym, price };
    return { configured: true, ok: false, symbol: sym, error: (d && (d.message || d.error || d.status)) || 'no data returned' };
  } catch (e) { return { configured: true, ok: false, symbol: sym, error: e.message }; }
}
async function fhTest(sym) {
  if (!FINNHUB_KEY) return { configured: false };
  try { const d = await getJSON(`${FINNHUB}/quote?symbol=${encodeURIComponent(sym)}&token=${FINNHUB_KEY}`);
    if (d && d.c > 0) return { configured: true, ok: true, symbol: sym, price: d.c };
    return { configured: true, ok: false, symbol: sym, error: 'no data returned' };
  } catch (e) { return { configured: true, ok: false, symbol: sym, error: e.message }; }
}
async function rapidTest(yh) {
  if (!RAPIDAPI_KEY) return { configured: false };
  const rs = rapidSymbol(yh) || (String(yh).includes(':') ? yh : yh);
  try { const d = await getJSON(`https://${RAPIDAPI_HOST}/stock-quote?symbol=${encodeURIComponent(rs)}&language=en`, rapidHeaders());
    const q = (d && d.data) || d, price = q && ((q.price != null) ? +q.price : +q.last);
    if (price > 0) return { configured: true, ok: true, symbol: rs, price, host: RAPIDAPI_HOST };
    return { configured: true, ok: false, symbol: rs, error: (d && (d.message || d.error || d.status)) || 'no data returned', host: RAPIDAPI_HOST };
  } catch (e) { return { configured: true, ok: false, symbol: rs, error: e.message, host: RAPIDAPI_HOST }; }
}
// Turn a raw provider error into a concrete fix the operator can act on.
function feedHint(provider, r) {
  if (!r || !r.configured || r.ok) return null;
  const e = String(r.error || '').toLowerCase();
  const varName = provider === 'twelvedata' ? 'TWELVEDATA_API_KEY' : provider === 'polygon' ? 'POLYGON_API_KEY' : provider === 'rapidapi' ? 'RAPIDAPI_KEY' : 'FINNHUB_API_KEY';
  if (provider === 'rapidapi' && /403|not subscribed|not.*subscrib|you are not subscribed/.test(e)) return '→ Not subscribed on RapidAPI — subscribe to the API (free tier is fine) so the key can call this host.';
  if (provider === 'rapidapi' && /429|rate|quota|exceeded|limit/.test(e)) return '→ RapidAPI monthly quota hit — wait for reset or bump the plan.';
  if (/401|403|unauthor|invalid.*key|api ?key|forbidden/.test(e)) return `→ Key looks invalid — recheck ${varName} (exact spelling + value) on Render, then redeploy.`;
  if (/credit|quota|out of|429|too many|rate.?limit|run out/.test(e)) return '→ Out of API credits or rate-limited — wait, or move to a higher plan.';
  if (/plan|upgrade|not available|grow|\bpro\b|premium|subscription|access/.test(e)) return provider === 'twelvedata'
    ? '→ NSE/BSE needs a higher Twelve Data plan — upgrade to Grow/Pro for Indian real-time.'
    : `→ Real-time here is a paid ${provider} tier — upgrade the plan.`;
  if (/not found|no data|symbol|invalid symbol/.test(e)) return provider === 'twelvedata'
    ? '→ Symbol/exchange not covered on this plan — NSE/BSE usually needs a paid Twelve Data tier.'
    : '→ Symbol not covered by this provider/plan.';
  return '→ Check the provider dashboard for details on this error.';
}
const cgHeaders = () => (COINGECKO_KEY ? { 'x-cg-demo-api-key': COINGECKO_KEY } : {});
// Super-admins (oversight only — emails/metadata + audit log, NEVER passwords).
// Set SUPER_ADMINS="a@x.com,b@y.com". Empty = nobody has admin access (secure default).
const SUPER_ADMINS = new Set((process.env.SUPER_ADMINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const isSuperAdmin = (email) => SUPER_ADMINS.has(String(email || '').toLowerCase());

// Web Push (PWA notifications) — optional; enabled only when VAPID keys are set.
let webpush = null, PUSH_ENABLED = false;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '', VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
try {
  if (VAPID_PUBLIC && VAPID_PRIVATE) {
    webpush = require('web-push');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@quantra.ai', VAPID_PUBLIC, VAPID_PRIVATE);
    PUSH_ENABLED = true;
  }
} catch (e) { console.warn('[push] web-push unavailable:', e.message); }
async function sendPush(subs, payload) {
  if (!PUSH_ENABLED || !subs || !subs.length) return [];
  const dead = [];
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification(s, JSON.stringify(payload)); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint); }
  }));
  return dead;   // endpoints that are gone — caller prunes them
}
let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { /* SDK not installed — AI feature disabled */ }

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json; charset=utf-8' };

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

/* Stocks bifurcated by exchange/market. Each market quotes in its own currency
   (Yahoo's exchange suffix → native ccy), so the UI can follow the exchange. */
const STOCK_MARKETS = {
  // — Americas —
  us:     { label: 'United States', ccy: 'USD', list: DEFAULT_STOCKS },
  canada: { label: 'Canada · TSX', ccy: 'CAD', list: ['RY.TO', 'TD.TO', 'SHOP.TO', 'ENB.TO', 'BMO.TO', 'BNS.TO', 'CNR.TO', 'CP.TO', 'TRI.TO', 'SU.TO', 'BCE.TO', 'MFC.TO'] },
  brazil: { label: 'Brazil · B3', ccy: 'BRL', list: ['PETR4.SA', 'VALE3.SA', 'ITUB4.SA', 'BBDC4.SA', 'ABEV3.SA', 'B3SA3.SA', 'WEGE3.SA', 'BBAS3.SA', 'ITSA4.SA', 'SUZB3.SA'] },
  mexico: { label: 'Mexico · BMV', ccy: 'MXN', list: ['AMXL.MX', 'WALMEX.MX', 'GFNORTEO.MX', 'FEMSAUBD.MX', 'GMEXICOB.MX', 'BIMBOA.MX', 'CEMEXCPO.MX', 'KIMBERA.MX'] },
  // — Europe —
  eu:     { label: 'Europe · Euro', ccy: 'EUR', list: ['SAP.DE', 'SIE.DE', 'ALV.DE', 'DTE.DE', 'BAS.DE', 'BMW.DE', 'ASML.AS', 'MC.PA', 'OR.PA', 'AIR.PA', 'IBE.MC', 'SAN.MC', 'ENEL.MI', 'ISP.MI'] },
  uk:     { label: 'United Kingdom · LSE', ccy: 'GBP', list: ['SHEL.L', 'AZN.L', 'HSBA.L', 'ULVR.L', 'BP.L', 'GSK.L', 'RIO.L', 'LLOY.L', 'BARC.L', 'VOD.L', 'DGE.L', 'GLEN.L', 'NG.L', 'REL.L'] },
  switzerland: { label: 'Switzerland · SIX', ccy: 'CHF', list: ['NESN.SW', 'ROG.SW', 'NOVN.SW', 'UBSG.SW', 'ZURN.SW', 'ABBN.SW', 'CFR.SW', 'SIKA.SW', 'LONN.SW', 'GIVN.SW'] },
  sweden: { label: 'Sweden · OMX', ccy: 'SEK', list: ['VOLV-B.ST', 'ERIC-B.ST', 'ATCO-A.ST', 'INVE-B.ST', 'HM-B.ST', 'SEB-A.ST', 'SAND.ST', 'ABB.ST'] },
  norway: { label: 'Norway · OSE', ccy: 'NOK', list: ['EQNR.OL', 'DNB.OL', 'TEL.OL', 'AKRBP.OL', 'MOWI.OL', 'YAR.OL', 'NHY.OL'] },
  denmark: { label: 'Denmark · OMX', ccy: 'DKK', list: ['NOVO-B.CO', 'MAERSK-B.CO', 'DSV.CO', 'ORSTED.CO', 'CARL-B.CO', 'VWS.CO', 'GMAB.CO'] },
  // — Asia-Pacific —
  nse:    { label: 'India · NSE', ccy: 'INR', list: ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'ICICIBANK.NS', 'SBIN.NS', 'BHARTIARTL.NS', 'ITC.NS', 'LT.NS', 'HINDUNILVR.NS', 'AXISBANK.NS', 'BAJFINANCE.NS', 'MARUTI.NS', 'SUNPHARMA.NS', 'KOTAKBANK.NS', 'WIPRO.NS', 'HCLTECH.NS', 'ADANIENT.NS', 'TATASTEEL.NS', 'NTPC.NS'] },
  bse:    { label: 'India · BSE', ccy: 'INR', list: ['RELIANCE.BO', 'TCS.BO', 'HDFCBANK.BO', 'INFY.BO', 'ICICIBANK.BO', 'SBIN.BO', 'BHARTIARTL.BO', 'ITC.BO', 'LT.BO', 'HINDUNILVR.BO', 'AXISBANK.BO', 'MARUTI.BO', 'SUNPHARMA.BO', 'WIPRO.BO'] },
  china:  { label: 'China · SSE/SZSE', ccy: 'CNY', list: ['600519.SS', '601398.SS', '600036.SS', '601318.SS', '600900.SS', '601988.SS', '600276.SS', '000858.SZ', '300750.SZ', '002594.SZ'] },
  japan:  { label: 'Japan · TSE', ccy: 'JPY', list: ['7203.T', '6758.T', '9984.T', '8306.T', '6861.T', '9432.T', '6098.T', '8035.T', '9433.T', '7974.T', '4063.T', '6501.T'] },
  korea:  { label: 'South Korea · KRX', ccy: 'KRW', list: ['005930.KS', '000660.KS', '005380.KS', '051910.KS', '035420.KS', '005490.KS', '068270.KS', '105560.KS'] },
  taiwan: { label: 'Taiwan · TWSE', ccy: 'TWD', list: ['2330.TW', '2317.TW', '2454.TW', '2412.TW', '2308.TW', '2881.TW', '3008.TW', '2882.TW'] },
  hk:     { label: 'Hong Kong · HKEX', ccy: 'HKD', list: ['0700.HK', '9988.HK', '0941.HK', '1299.HK', '0005.HK', '3690.HK', '0388.HK', '1810.HK', '2318.HK', '0883.HK', '1398.HK', '0939.HK', '2628.HK', '9618.HK'] },
  singapore: { label: 'Singapore · SGX', ccy: 'SGD', list: ['D05.SI', 'O39.SI', 'U11.SI', 'Z74.SI', 'C6L.SI', 'C38U.SI', 'BN4.SI', 'S68.SI'] },
  australia: { label: 'Australia · ASX', ccy: 'AUD', list: ['BHP.AX', 'CBA.AX', 'CSL.AX', 'NAB.AX', 'WBC.AX', 'ANZ.AX', 'WES.AX', 'MQG.AX', 'FMG.AX', 'TLS.AX', 'WOW.AX', 'RIO.AX'] },
  indonesia: { label: 'Indonesia · IDX', ccy: 'IDR', list: ['BBCA.JK', 'BBRI.JK', 'TLKM.JK', 'BMRI.JK', 'ASII.JK', 'UNVR.JK', 'ICBP.JK'] },
  thailand: { label: 'Thailand · SET', ccy: 'THB', list: ['PTT.BK', 'AOT.BK', 'CPALL.BK', 'ADVANC.BK', 'SCB.BK', 'KBANK.BK', 'GULF.BK'] },
  malaysia: { label: 'Malaysia · Bursa', ccy: 'MYR', list: ['1155.KL', '5347.KL', '1023.KL', '6888.KL', '5183.KL', '6033.KL'] },
  // — Middle East & Africa —
  uae:    { label: 'UAE · Dubai (DFM)', ccy: 'AED', list: ['EMAAR.AE', 'DIB.AE', 'EMIRATESNBD.AE', 'DEWA.AE', 'SALIK.AE', 'TECOM.AE', 'EMAARDEV.AE', 'DU.AE', 'AMR.AE', 'TAALEEM.AE'] },
  saudi:  { label: 'Saudi Arabia · Tadawul', ccy: 'SAR', list: ['2222.SR', '1120.SR', '2010.SR', '7010.SR', '1180.SR', '2350.SR', '1211.SR', '2280.SR'] },
  southafrica: { label: 'South Africa · JSE', ccy: 'ZAR', list: ['NPN.JO', 'FSR.JO', 'SBK.JO', 'MTN.JO', 'AGL.JO', 'SOL.JO', 'CFR.JO', 'CPI.JO'] },
};

/* Curated universes for the non-equity asset classes. Each entry: y = Yahoo
   symbol (used for charts/quotes), s = display ticker, n = friendly name.
   ETFs, commodities, indices and FX all flow through the same Yahoo chart
   pipeline as stocks, so the analysis engine scores them with no extra code. */
/* Futures — CME-group contracts, freely quoted via Yahoo (=F). This is the honest
   free universe: global equity-index futures (incl. Nikkei), rates, energy, metals,
   ags. Exchange-local F&O (e.g. NSE NIFTY futures) needs a paid exchange feed. */
const FUTURES = [
  { y: 'ES=F', s: 'ES', n: 'S&P 500 E-mini' }, { y: 'NQ=F', s: 'NQ', n: 'Nasdaq 100 E-mini' },
  { y: 'YM=F', s: 'YM', n: 'Dow E-mini' }, { y: 'RTY=F', s: 'RTY', n: 'Russell 2000 E-mini' },
  { y: 'NKD=F', s: 'NKD', n: 'Nikkei 225 (CME)' },
  { y: 'ZN=F', s: 'ZN', n: '10-Yr T-Note' }, { y: 'ZB=F', s: 'ZB', n: '30-Yr T-Bond' }, { y: 'ZF=F', s: 'ZF', n: '5-Yr T-Note' },
  { y: 'CL=F', s: 'CL', n: 'Crude Oil WTI' }, { y: 'BZ=F', s: 'BZ', n: 'Brent Crude' }, { y: 'NG=F', s: 'NG', n: 'Natural Gas' }, { y: 'RB=F', s: 'RB', n: 'RBOB Gasoline' },
  { y: 'GC=F', s: 'GC', n: 'Gold' }, { y: 'SI=F', s: 'SI', n: 'Silver' }, { y: 'HG=F', s: 'HG', n: 'Copper' }, { y: 'PL=F', s: 'PL', n: 'Platinum' },
  { y: 'ZC=F', s: 'ZC', n: 'Corn' }, { y: 'ZS=F', s: 'ZS', n: 'Soybeans' }, { y: 'ZW=F', s: 'ZW', n: 'Wheat' },
  { y: 'KC=F', s: 'KC', n: 'Coffee' }, { y: 'SB=F', s: 'SB', n: 'Sugar' }, { y: 'CC=F', s: 'CC', n: 'Cocoa' }, { y: 'CT=F', s: 'CT', n: 'Cotton' }, { y: 'LE=F', s: 'LE', n: 'Live Cattle' },
];
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
    // — regional / country ETFs (US-listed, USD) —
    { y: 'INDA', s: 'INDA', n: 'India (MSCI)' }, { y: 'EPI', s: 'EPI', n: 'India Earnings' },
    { y: 'VGK', s: 'VGK', n: 'Europe (Vanguard)' }, { y: 'EZU', s: 'EZU', n: 'Eurozone' },
    { y: 'EWU', s: 'EWU', n: 'United Kingdom' }, { y: 'EWG', s: 'EWG', n: 'Germany' },
    { y: 'EWJ', s: 'EWJ', n: 'Japan' }, { y: 'MCHI', s: 'MCHI', n: 'China (MSCI)' },
    { y: 'FXI', s: 'FXI', n: 'China Large-Cap' }, { y: 'KWEB', s: 'KWEB', n: 'China Internet' },
    { y: 'EWY', s: 'EWY', n: 'South Korea' }, { y: 'EWT', s: 'EWT', n: 'Taiwan' },
    { y: 'EWA', s: 'EWA', n: 'Australia' }, { y: 'EWH', s: 'EWH', n: 'Hong Kong' },
    { y: 'EWS', s: 'EWS', n: 'Singapore' }, { y: 'EWZ', s: 'EWZ', n: 'Brazil' },
    { y: 'EWW', s: 'EWW', n: 'Mexico' }, { y: 'KSA', s: 'KSA', n: 'Saudi Arabia' },
    { y: 'UAE', s: 'UAE', n: 'UAE' }, { y: 'EZA', s: 'EZA', n: 'South Africa' },
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
    // Americas
    { y: '^GSPC', s: 'S&P 500', n: 'S&P 500 (US)' }, { y: '^DJI', s: 'DOW', n: 'Dow Jones (US)' },
    { y: '^IXIC', s: 'NASDAQ', n: 'Nasdaq Composite (US)' }, { y: '^RUT', s: 'RUSSELL', n: 'Russell 2000 (US)' },
    { y: '^VIX', s: 'VIX', n: 'Volatility Index (US)' }, { y: '^GSPTSE', s: 'TSX', n: 'S&P/TSX (Canada)' },
    { y: '^BVSP', s: 'BOVESPA', n: 'Ibovespa (Brazil)' }, { y: '^MXX', s: 'IPC', n: 'S&P/BMV IPC (Mexico)' },
    // Europe
    { y: '^FTSE', s: 'FTSE', n: 'FTSE 100 (UK)' }, { y: '^GDAXI', s: 'DAX', n: 'DAX (Germany)' },
    { y: '^FCHI', s: 'CAC40', n: 'CAC 40 (France)' }, { y: '^STOXX50E', s: 'STOXX50', n: 'Euro Stoxx 50' },
    { y: '^IBEX', s: 'IBEX', n: 'IBEX 35 (Spain)' }, { y: 'FTSEMIB.MI', s: 'FTSEMIB', n: 'FTSE MIB (Italy)' },
    { y: '^AEX', s: 'AEX', n: 'AEX (Netherlands)' }, { y: '^SSMI', s: 'SMI', n: 'SMI (Switzerland)' },
    { y: '^OMX', s: 'OMX30', n: 'OMX Stockholm 30 (Sweden)' },
    // Asia-Pacific
    { y: '^N225', s: 'NIKKEI', n: 'Nikkei 225 (Japan)' }, { y: '^HSI', s: 'HSI', n: 'Hang Seng (HK)' },
    { y: '^NSEI', s: 'NIFTY', n: 'Nifty 50 (India)' }, { y: '^BSESN', s: 'SENSEX', n: 'BSE Sensex (India)' },
    { y: '^NSEBANK', s: 'BANKNIFTY', n: 'Nifty Bank (India)' }, { y: '000001.SS', s: 'SSE', n: 'SSE Composite (China)' },
    { y: '399001.SZ', s: 'SZSE', n: 'Shenzhen Component (China)' }, { y: '^KS11', s: 'KOSPI', n: 'KOSPI (Korea)' },
    { y: '^TWII', s: 'TWSE', n: 'Taiwan Weighted (Taiwan)' }, { y: '^STI', s: 'STI', n: 'Straits Times (Singapore)' },
    { y: '^AXJO', s: 'ASX200', n: 'ASX 200 (Australia)' }, { y: '^JKSE', s: 'IDX', n: 'IDX Composite (Indonesia)' },
    { y: '^KLSE', s: 'KLCI', n: 'FTSE Bursa KLCI (Malaysia)' },
    // Middle East & Africa
    { y: '^TASI.SR', s: 'TASI', n: 'Tadawul All Share (Saudi)' }, { y: '^J203.JO', s: 'JALSH', n: 'JSE All Share (S. Africa)' },
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

// Authoritative previous-session close (= Yahoo's regularMarketPreviousClose). The chart
// endpoint's chartPreviousClose is range-relative, so we must ask for range=1d specifically.
// Needed for futures/indices, where `meta.previousClose` is absent and guessing from the
// monthly series picks the wrong session (e.g. Friday instead of the official prior close).
async function dayPrevClose(sym) {
  try {
    const d = await cached(`prevc:${sym}`, 60000, () => getJSON(`${YF}/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`));
    const m = d.chart.result[0].meta || {};
    return m.chartPreviousClose != null ? m.chartPreviousClose : (m.previousClose != null ? m.previousClose : null);
  } catch { return null; }
}

/* Build a board for any list of Yahoo symbols (stocks/ETFs/commodities/indices/FX). */
async function buildBoard(list, type) {
  const out = await Promise.all(list.map(async (it) => {
    const sym = typeof it === 'string' ? it : it.y;
    try {
      const d = await getJSON(`${YF}/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`);
      const r = d.chart.result[0], meta = r.meta || {};
      const a = alignedFromYahoo(r);                 // dates aligned with closes
      const closes = a.closes;
      // Prefer the live market price over the last *daily* close (which lags intraday).
      const last = (meta.regularMarketPrice != null) ? meta.regularMarketPrice : closes[closes.length - 1];
      // Daily % must compare to the PRIOR SESSION close. meta.chartPreviousClose is the
      // close before the whole 1-month window (~a month ago) — using it made the 24h
      // change wildly wrong (e.g. MSFT showing -10% on an up day). Use previousClose, or
      // yesterday's bar — session-aware so it's right intraday and pre-market.
      let prev = meta.previousClose;
      if (prev == null) prev = await dayPrevClose(sym);   // authoritative daily prev (futures/indices)
      if (prev == null) {
        const lastBarDay = a.dates.length ? a.dates[a.dates.length - 1].slice(0, 10) : null;
        const rmtDay = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10) : lastBarDay;
        prev = (lastBarDay && rmtDay && rmtDay > lastBarDay) ? closes[closes.length - 1]
          : (closes.length >= 2 ? closes[closes.length - 2] : last);
      }
      let price = last, ccy = meta.currency || 'USD';
      let changeAbs = prev ? +(last - prev).toFixed(4) : 0, change24h = prev ? ((last - prev) / prev) * 100 : 0;
      let asOf = meta.regularMarketTime ? meta.regularMarketTime * 1000 : null;
      // Real-time override: Finnhub for US stocks/ETFs (free, live), Twelve Data for
      // exchange-suffixed international symbols (when keyed). Both fall back silently.
      if (fhEligible(sym)) {
        const fh = await fhQuote(sym);
        if (fh && fh.price != null) { price = fh.price; if (fh.changePct != null) change24h = fh.changePct; if (fh.change != null) changeAbs = fh.change; if (fh.asOf) asOf = fh.asOf; }
        else if (POLYGON_KEY) { const pg = await polyQuote(sym); if (pg && pg.price != null) { price = pg.price; if (pg.changePct != null) change24h = pg.changePct; if (pg.change != null) changeAbs = pg.change; if (pg.asOf) asOf = pg.asOf; } }
      } else if (TWELVEDATA_KEY && String(sym).includes('.')) {
        const td = await tdQuote(sym);
        if (td && td.price != null) {
          price = td.price;
          if (td.changePct != null) change24h = td.changePct;
          if (td.change != null) changeAbs = td.change;
          if (td.currency) ccy = td.currency;
          if (td.asOf) { const t = Date.parse(td.asOf); if (t) asOf = t; }
        }
      }
      const cr = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
      let mktOpen, holiday = null;
      if (isUSsym(sym)) { const us = await usMarketStatus(); if (us) { mktOpen = us.open; holiday = us.holiday; } }
      else holiday = curatedHoliday(sym);
      return { type, id: sym, symbol: (it && it.s) || meta.symbol || sym, name: (it && it.n) || meta.shortName || sym,
        price, currency: ccy, change24h, changeAbs, asOf, tp: cr ? [cr.start, cr.end, cr.gmtoffset != null ? cr.gmtoffset : (meta.gmtoffset || 0)] : null,
        mktOpen, holiday,
        marketCap: meta.marketCap || null, volume: meta.regularMarketVolume || null, spark: closes.slice(-30) };
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
  async 'stock/board'(q) {
    const mk = (q && STOCK_MARKETS[q.market]) ? q.market : 'us';
    return cached('sb:' + mk, 12000, () => buildBoard(STOCK_MARKETS[mk].list, 'stock'));
  },
  async 'stock/markets'() { return Object.entries(STOCK_MARKETS).map(([id, m]) => ({ id, label: m.label, ccy: m.ccy })); },
  async 'etf/board'() { return cached('etfb', 15000, () => buildBoard(UNIV.etf, 'etf')); },
  async 'commodity/board'() { return cached('comb', 15000, () => buildBoard(UNIV.commodity, 'commodity')); },
  async 'futures/board'() { return cached('futb', 15000, () => buildBoard(FUTURES, 'future')); },
  /* ---- movers radar: modeled odds of a ±10% move (30 sessions), whole-market scan ----
     Runs the same seeded Monte Carlo used everywhere else over 6 months of daily
     closes per asset, and reports P(+10%) / P(−10%) by horizon end. This is the
     honest version of "will it go above 10%": a measured probability, not a call.
     Cached 10 min + rebuilt on a timer so the sidebar loads instantly. */
  async 'movers/radar'() {
    return cached('radar', 10 * 60 * 1000, async () => {
      if (!Q) return { ok: false, reason: 'engine' };
      const universe = [];
      try { const cs = await api['crypto/markets']({ page: '1' }); (cs || []).slice(0, 30).forEach((c) => universe.push({ type: 'crypto', id: c.id, symbol: c.symbol, name: c.name, ysym: c.symbol + '-USD' })); } catch {}
      DEFAULT_STOCKS.forEach((s) => universe.push({ type: 'stock', id: s, symbol: s, name: s, ysym: s }));
      UNIV.commodity.forEach((c) => universe.push({ type: 'commodity', id: c.y, symbol: c.s, name: c.n, ysym: c.y }));
      UNIV.index.forEach((c) => universe.push({ type: 'index', id: c.y, symbol: c.s, name: c.n, ysym: c.y }));
      const THRESH = [2, 5, 10, 20, 40];
      const items = [];
      // memory/CPU safety on the small instance: cache ONLY the closes arrays (never the
      // raw chart JSON), and scan in small batches so ~95 assets can't spike RAM or
      // starve the event loop (an unbounded Promise.all here 503'd the whole app).
      const closesOf = (ys, range, interval) => cached(`radc:${ys}:${interval}`, 30 * 60 * 1000, async () => {
        const d = await getJSON(`${YF}/v8/finance/chart/${encodeURIComponent(ys)}?range=${range}&interval=${interval}`);
        return (d.chart.result[0].indicators.quote[0].close || []).filter((v) => v != null && isFinite(v));
      });
      const scanOne = async (u2) => {
        try {
          const hc = await closesOf(u2.ysym, '1mo', '60m');
          const dc = await closesOf(u2.ysym, '6mo', '1d');
          if (hc.length < 40 || dc.length < 40) return;   // validation: enough real bars for both scales
          const grid = {};
          for (const [key, closes, bars] of [['1h', hc, 1], ['4h', hc, 4], ['24h', hc, 24], ['30d', dc, 30]]) {
            const fc = Q.forecast(closes, bars, 0, { thresholds: THRESH });
            if (fc && fc.probs) grid[key] = { u: Object.fromEntries(THRESH.map((t) => [t, +(fc.probs.up[t] * 100).toFixed(1)])), d: Object.fromEntries(THRESH.map((t) => [t, +(fc.probs.down[t] * 100).toFixed(1)])) };
          }
          if (!grid['24h']) return;
          items.push({ type: u2.type, id: u2.id, symbol: u2.symbol, name: u2.name, price: dc[dc.length - 1], grid });
        } catch {}
      };
      for (let i = 0; i < universe.length; i += 6) {
        await Promise.all(universe.slice(i, i + 6).map(scanOne));
        await new Promise((r) => setTimeout(r, 50));   // yield to the event loop between batches
      }
      detectRadarSignals(items).catch(() => {});   // +20%-odds spike alerts (opt-in members)
      return { ok: true, asOf: Date.now(), thresholds: THRESH, horizons: ['1h', '4h', '24h', '30d'], count: items.length, items,
        note: 'Modeled probability the price is beyond ±X% at the horizon end (seeded Monte Carlo; 1h–24h from hourly closes — trading hours for stocks, literal for crypto; 30d from daily closes). Probabilities, not calls. Not investment advice.' };
    });
  },
  /* ---- radar signals feed: recent +20%-odds spikes (for the popup system) ---- */
  async 'movers/signals'(q) {
    const after = +(q.after || 0);
    return { ok: true, now: Date.now(), minOdds: RADAR_ALERT_MIN, signals: radarSignals.filter((s) => s.ts > after) };
  },
  /* ---- Web3 / on-chain overview (all free, keyless feeds) ---- */
  async 'web3/overview'() {
    return cached('web3', 5 * 60 * 1000, async () => {
      const out = { ok: true, asOf: Date.now() };
      // crypto Fear & Greed (alternative.me)
      try { const f = await getJSON('https://api.alternative.me/fng/?limit=1'); const d = f && f.data && f.data[0]; if (d) out.fearGreed = { value: +d.value, label: d.value_classification }; } catch {}
      // global market: total mcap, BTC/ETH dominance (CoinGecko, keyless tier)
      try { const g = await getJSON('https://api.coingecko.com/api/v3/global', cgHeaders()); const d = g && g.data;
        if (d) out.global = { mcapUsd: d.total_market_cap && d.total_market_cap.usd, vol24hUsd: d.total_volume && d.total_volume.usd, btcDom: d.market_cap_percentage && +d.market_cap_percentage.btc.toFixed(1), ethDom: d.market_cap_percentage && +d.market_cap_percentage.eth.toFixed(1), mcapChange24h: d.market_cap_change_percentage_24h_usd != null ? +d.market_cap_change_percentage_24h_usd.toFixed(2) : null }; } catch {}
      // DeFi TVL by chain + top protocols (DefiLlama, free)
      try { const ch = await getJSON('https://api.llama.fi/v2/chains');
        if (Array.isArray(ch)) { const top = ch.filter((c) => c.tvl > 0).sort((a, b) => b.tvl - a.tvl); out.defi = { totalTvl: top.reduce((s, c) => s + c.tvl, 0), chains: top.slice(0, 10).map((c) => ({ name: c.name, tvl: c.tvl })) }; } } catch {}
      try { const pr = await getJSON('https://api.llama.fi/protocols');
        if (Array.isArray(pr)) out.protocols = pr.sort((a, b) => (b.tvl || 0) - (a.tvl || 0)).slice(0, 12).map((p2) => ({ name: p2.name, tvl: p2.tvl, chain: p2.chain, change7d: p2.change_7d != null ? +(+p2.change_7d).toFixed(1) : null, category: p2.category })); } catch {}
      // ETH gas via public RPC (keyless)
      try {
        // public RPCs that don't block cloud IPs (Cloudflare's does, from Render)
        for (const rpc of ['https://ethereum-rpc.publicnode.com', 'https://1rpc.io/eth', 'https://rpc.ankr.com/eth']) {
          try {
            const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 1 }) });
            const d = await r.json(); if (d && d.result) { out.gasGwei = +(parseInt(d.result, 16) / 1e9).toFixed(2); break; }
          } catch {}
        }
      } catch {}
      return out;
    });
  },
  /* ---- options chain (US-listed symbols; Yahoo v7 + crumb; delayed) ---- */
  async 'options'(q) {
    const sym = String(q.symbol || '').trim().toUpperCase();
    if (!sym || !/^[A-Z0-9.^-]{1,12}$/.test(sym)) return { ok: false, reason: 'bad-symbol' };
    // NSE index F&O via the operator's Dhan broker keys (real exchange data)
    if (DHAN_UNDERLYINGS[sym]) {
      if (!DHAN_ON) return { ok: false, reason: 'no-dhan', hint: 'NSE option chains need Dhan broker keys — set DHAN_ACCESS_TOKEN + DHAN_CLIENT_ID on Render.' };
      try { const c = await dhanChain(sym, /^\d+$/.test(String(q.date || '')) ? +q.date : null); if (c) return c; } catch (e) { noteError(); }
      return { ok: false, reason: 'dhan-failed' };
    }
    const date = /^\d+$/.test(String(q.date || '')) ? '&date=' + q.date : '';
    return cached(`opt:${sym}:${q.date || 'front'}`, 3 * 60 * 1000, async () => {
      await ensureCrumb();
      const d = await getJSON(`${YF2}/v7/finance/options/${encodeURIComponent(sym)}?crumb=${encodeURIComponent(yCrumb)}${date}`, { cookie: yCookie });
      const r = d && d.optionChain && d.optionChain.result && d.optionChain.result[0];
      if (!r || !r.options || !r.options[0]) return { ok: false, reason: 'no-chain' };
      const o = r.options[0], spot = r.quote && r.quote.regularMarketPrice;
      const row = (c) => ({ strike: c.strike, last: c.lastPrice ?? null, bid: c.bid ?? null, ask: c.ask ?? null,
        iv: c.impliedVolatility != null ? +(c.impliedVolatility * 100).toFixed(1) : null,
        vol: c.volume ?? null, oi: c.openInterest ?? null, itm: !!c.inTheMoney });
      return { ok: true, symbol: sym, spot: spot ?? null, currency: (r.quote && r.quote.currency) || 'USD',
        expirations: (r.expirationDates || []).slice(0, 24), expiry: o.expirationDate || null,
        calls: (o.calls || []).map(row), puts: (o.puts || []).map(row) };
    });
  },
  async 'index/board'() { return cached('idxb', 15000, () => buildBoard(UNIV.index, 'index')); },
  async 'fx/board'() { return cached('fxb', 15000, () => buildBoard(UNIV.fx, 'fx')); },

  /* ---- market discovery: heatmap + movers + breadth ---- */
  async 'discover'(q) {
    const cls = q.class || 'crypto';
    const boards = {
      crypto: () => api['crypto/markets']({}), stock: () => api['stock/board']({ market: q.market }), etf: () => api['etf/board'](),
      commodity: () => api['commodity/board'](), index: () => api['index/board'](), fx: () => api['fx/board'](),
    };
    let raw = [];
    if (cls === 'all') {
      const arrs = await Promise.all(Object.values(boards).map((f) => f().catch(() => [])));
      raw = arrs.flat();
    } else if (boards[cls]) {
      raw = await boards[cls]().catch(() => []);
    }
    const items = raw
      .map((it) => ({ id: it.id, symbol: it.symbol, name: it.name, type: it.type, price: it.price, change: it.change24h, marketCap: it.marketCap || null, currency: it.currency || 'USD', tp: it.tp || null, mktOpen: it.mktOpen, holiday: it.holiday || null }))
      .filter((x) => x.change != null && isFinite(x.change) && x.price != null);
    const up = items.filter((x) => x.change > 0).length, down = items.filter((x) => x.change < 0).length;
    const avg = items.length ? items.reduce((s, x) => s + x.change, 0) / items.length : 0;
    const byMove = (a, b) => b.change - a.change;
    return {
      class: cls, count: items.length,
      breadth: { up, down, flat: items.length - up - down, avg: +avg.toFixed(2) },
      gainers: items.slice().sort(byMove).slice(0, 12),
      losers: items.slice().sort((a, b) => a.change - b.change).slice(0, 12),
      items: items.slice().sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)),
    };
  },

  /* ---- earnings calendar (Finnhub, free tier) ---- */
  async 'calendar/earnings'(q) {
    if (!FINNHUB_KEY) return { ok: false, reason: 'no-key', events: [] };
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 35 * 864e5).toISOString().slice(0, 10);
    let data;
    try { data = await cached(`earn:${from}`, 3600000, () => getJSON(`${FINNHUB}/calendar/earnings?from=${from}&to=${to}&token=${FINNHUB_KEY}`)); }
    catch { return { ok: false, reason: 'fetch', events: [] }; }
    let list = (data.earningsCalendar || []).filter((e) => e.date >= from);
    const scope = q.scope || 'watch';
    if (scope === 'all') {
      list = list.filter((e) => e.revenueEstimate || e.epsEstimate)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (b.revenueEstimate || 0) - (a.revenueEstimate || 0)))
        .slice(0, 120);
    } else {
      const syms = new Set(String(q.syms || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).concat(DEFAULT_STOCKS));
      list = list.filter((e) => syms.has(String(e.symbol).toUpperCase()));
    }
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { ok: true, from, to, count: list.length, events: list.map((e) => ({ symbol: e.symbol, date: e.date, hour: e.hour || '', epsEstimate: e.epsEstimate, revenueEstimate: e.revenueEstimate, quarter: e.quarter, year: e.year })) };
  },

  /* ---- IPO calendar (Finnhub, free tier) ---- */
  async 'calendar/ipo'() {
    if (!FINNHUB_KEY) return { ok: false, reason: 'no-key', events: [] };
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);
    try {
      const d = await cached(`ipo:${from}`, 3600000, () => getJSON(`${FINNHUB}/calendar/ipo?from=${from}&to=${to}&token=${FINNHUB_KEY}`));
      const list = (d.ipoCalendar || []).filter((x) => x.date >= from).sort((a, b) => (a.date < b.date ? -1 : 1));
      return { ok: true, count: list.length, events: list };
    } catch { return { ok: false, reason: 'fetch', events: [] }; }
  },

  /* ---- economic calendar — FMP (real macro feed) → Finnhub → graceful fallback ---- */
  async 'calendar/economic'() {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    // 1) Financial Modeling Prep — proper macro calendar with impact + estimate/prev/actual
    if (FMP_KEY) {
      try {
        const d = await cached(`econ:fmp:${from}`, 3600000, () => getJSON(`https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${FMP_KEY}`));
        if (Array.isArray(d) && d.length) {
          const evs = d.filter((e) => (e.country === 'US' || e.country === 'United States') && (e.impact === 'High' || e.impact === 'Medium'))
            .map((e) => ({ date: String(e.date || '').slice(0, 10), time: e.date, country: 'US', event: e.event, estimate: e.estimate, prev: e.previous, actual: e.actual, impact: e.impact }))
            .slice(0, 80);
          if (evs.length) return { ok: true, source: 'fmp', count: evs.length, events: evs };
        }
      } catch {}
    }
    // 2) Finnhub (premium on most plans — used if your key has access)
    if (FINNHUB_KEY) {
      try {
        const d = await cached('econ', 3600000, () => getJSON(`${FINNHUB}/calendar/economic?token=${FINNHUB_KEY}`));
        if (d && !d.error && d.economicCalendar) {
          const evs = d.economicCalendar.filter((e) => (!e.country || e.country === 'US') && (e.time || '').slice(0, 10) >= from)
            .map((e) => ({ date: (e.time || '').slice(0, 10), time: e.time, country: e.country || 'US', event: e.event, estimate: e.estimate, prev: e.prev, actual: e.actual, impact: e.impact })).slice(0, 80);
          if (evs.length) return { ok: true, source: 'finnhub', count: evs.length, events: evs };
        }
      } catch {}
    }
    // No free macro-calendar source currently available (FMP/Finnhub gated, TE guest
    // discontinued). Return an honest "needs a data source" state — the client shows
    // the working earnings calendar as the primary content instead of a blank block.
    return { ok: false, premium: true, reason: 'no-macro-source', events: [] };
  },

  /* ---- premium multi-source news (marketaux) with source attribution ---- */
  async 'news/premium'(q) {
    if (!MARKETAUX_KEY) return { ok: false, reason: 'no-key', news: [] };
    const sym = q.symbol ? `&symbols=${encodeURIComponent(String(q.symbol).toUpperCase())}` : '';
    try {
      const d = await cached(`mx:${q.symbol || 'general'}`, 600000, () => getJSON(`https://api.marketaux.com/v1/news/all?language=en&filter_entities=true&limit=12${sym}&api_token=${MARKETAUX_KEY}`));
      const news = (d.data || []).map((n) => ({
        title: n.title, url: n.url, source: n.source, publisher: n.source, time: n.published_at,
        snippet: n.description || n.snippet || '',
        sentiment: (n.entities && n.entities[0] && typeof n.entities[0].sentiment_score === 'number') ? +n.entities[0].sentiment_score.toFixed(2) : null,
      }));
      return { ok: true, count: news.length, news };
    } catch { return { ok: false, reason: 'fetch', news: [] }; }
  },

  /* ---- personalized AI daily brief (watchlist digest) ---- */
  async 'brief'(q, body) {
    const items = (body && Array.isArray(body.items) ? body.items : []).filter((it) => it && it.symbol).slice(0, 40);
    const rows = await Promise.all(items.map(async (it) => {
      try { const pr = await api['price']({ id: it.id || it.symbol, symbol: it.symbol, type: it.type }); return { type: it.type, id: it.id, symbol: it.symbol, name: it.name || it.symbol, price: pr.ok ? pr.price : null, change: pr.ok ? pr.change : null, currency: (pr && pr.currency) || 'USD' }; }
      catch { return { type: it.type, id: it.id, symbol: it.symbol, name: it.name || it.symbol, price: null, change: null }; }
    }));
    const priced = rows.filter((r) => r.change != null).sort((a, b) => (b.change || 0) - (a.change || 0));
    const up = priced.filter((r) => r.change > 0).length, down = priced.filter((r) => r.change < 0).length;
    const avg = priced.length ? +(priced.reduce((s, r) => s + r.change, 0) / priced.length).toFixed(2) : 0;
    let market = null;
    try { const dd = await api['discover']({ class: 'all' }); market = dd.breadth; } catch {}
    let earnings = [];
    try {
      const stockSyms = items.filter((i) => i.type === 'stock' || i.type === 'etf').map((i) => i.symbol);
      if (stockSyms.length) { const e = await api['calendar/earnings']({ scope: 'watch', syms: stockSyms.join(',') }); earnings = (e.events || []).slice(0, 8).map((x) => ({ symbol: x.symbol, date: x.date })); }
    } catch {}
    const topGainers = priced.slice(0, 3).map((x) => ({ symbol: x.symbol, change: x.change }));
    const topLosers = priced.slice(-3).reverse().map((x) => ({ symbol: x.symbol, change: x.change }));
    const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const watching = (body && Array.isArray(body.affinity)) ? body.affinity.slice(0, 4) : [];
    // Research headlines for what they follow most (RapidAPI-keyed; empty otherwise) —
    // lets the narrative cite actual coverage, not just price moves.
    let headlines = [];
    if (RAPIDAPI_KEY && watching.length) {
      try {
        const hs = await Promise.all(watching.slice(0, 2).map((sym) => api.research({ symbol: sym }).catch(() => null)));
        headlines = hs.flatMap((r, i) => (r && r.ok && r.news.length) ? [{ symbol: watching[i], title: r.news[0].title, publisher: r.news[0].publisher }] : []);
      } catch {}
    }
    const narrative = await briefNarrative({ date, count: priced.length, up, down, avg, topGainers, topLosers, market, earnings, watching, headlines });
    return { ok: true, date, count: priced.length, up, down, avg, rows: priced, topGainers, topLosers, market, earnings, watching, headlines, text: narrative.text, source: narrative.source };
  },
  // Universal current price for any held asset (portfolio tracker).
  async 'price'(q) {
    const idv = q.id || q.symbol; if (!idv) return { ok: false };
    if (q.type === 'crypto') {
      try { const d = await cached(`px:c:${idv}`, 30000, () => getJSON(`${CG}/simple/price?ids=${encodeURIComponent(idv)}&vs_currencies=usd&include_24hr_change=true`, cgHeaders())); const row = d[idv]; if (row && row.usd != null) return { ok: true, price: row.usd, change: row.usd_24h_change != null ? +row.usd_24h_change.toFixed(2) : null, currency: 'USD' }; } catch {}
      try { const d = await getJSON(`https://api.coinpaprika.com/v1/tickers/${encodeURIComponent(String(q.symbol || idv).toLowerCase())}-${encodeURIComponent(String(idv).toLowerCase())}?quotes=USD`); const u = d && d.quotes && d.quotes.USD; if (u && u.price != null) return { ok: true, price: u.price, change: u.percent_change_24h != null ? +u.percent_change_24h.toFixed(2) : null, currency: 'USD' }; } catch {}
      return { ok: false };
    }
    // Yahoo base gives the prior close, currency and the exchange session window (tp).
    let base = null;
    try {
      const d = await cached(`px:y:${idv}`, 15000, () => getJSON(`${YF}/v8/finance/chart/${encodeURIComponent(idv)}?range=1d&interval=1d`));
      const r = d.chart.result[0], m = r.meta || {}, closes = (r.indicators.quote[0].close || []).filter((v) => v != null);
      const price = (m.regularMarketPrice != null) ? m.regularMarketPrice : (closes.length ? closes[closes.length - 1] : null);
      const prev = m.chartPreviousClose;
      const cr = m.currentTradingPeriod && m.currentTradingPeriod.regular;
      base = { price, change: (price != null && prev) ? +(((price - prev) / prev) * 100).toFixed(2) : null,
        changeAbs: (price != null && prev) ? +(price - prev).toFixed(4) : null,
        currency: m.currency || 'USD', asOf: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
        tp: cr ? [cr.start, cr.end, cr.gmtoffset != null ? cr.gmtoffset : (m.gmtoffset || 0)] : null };
    } catch {}
    // Market status incl. holidays: authoritative US (Finnhub), curated calendar otherwise.
    let mktOpen, holiday = null;
    if (isUSsym(idv)) { const us = await usMarketStatus(); if (us) { mktOpen = us.open; holiday = us.holiday; } }
    else holiday = curatedHoliday(idv);
    // Real-time override: Finnhub for US (free, live), Twelve Data for non-US (when keyed).
    const fh = await fhQuote(idv);
    const pg = fh ? null : await polyQuote(idv);
    const td = (fh || pg) ? null : await tdQuote(idv);
    const rapid = (fh || pg || td) ? null : await rapidQuote(idv);   // RapidAPI: intl incl. NSE/BSE
    const rt = fh || pg || td || rapid;
    if (rt && rt.price != null) {
      return { ok: true, price: rt.price, change: rt.changePct != null ? +rt.changePct.toFixed(2) : (base ? base.change : null),
        changeAbs: rt.change != null ? rt.change : (base ? base.changeAbs : null),
        currency: (rt.currency) || (base ? base.currency : 'USD'), asOf: rt.asOf || (base ? base.asOf : null),
        tp: base ? base.tp : null, mktOpen, holiday, source: fh ? 'finnhub' : pg ? 'polygon' : td ? 'twelvedata' : 'rapidapi' };
    }
    if (base && base.price != null) return { ok: true, ...base, mktOpen, holiday, source: 'yahoo' };
    return { ok: false };
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
      '"read" (4-6 sentence professional analysis in plain language that weaves together the technical signals, fundamentals, the latest-news sentiment — noting whether the supplied headlines support or contradict the technical picture — the walk-forward accuracy and the forecast into one coherent view; no markdown, no headers), ' +
      '"stance" (one of "bullish","neutral","bearish"), ' +
      '"newsImpact" (a number from -1 to 1: how much ONLY the latest news shifts the near-term outlook — negative = bearish news, 0 = neutral/no material news, positive = bullish news), and ' +
      '"newsRationale" (one short sentence naming the main news driver). ' +
      'Be candid about uncertainty. Do not give explicit buy/sell signals, actionable price targets or guarantees.';
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
          system: 'You are Quantra AI. Write a concise 4-6 sentence professional read weaving technical signals, fundamentals, latest-news sentiment, accuracy and the forecast into one view. No advice, no markdown.',
          messages: [{ role: 'user', content: userMsg }],
        });
        const t2 = (msg2.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        return { ok: true, text: t2 };
      } catch (e2) { return { ok: false, reason: String(e2.message || e2) }; }
    }
  },

  /* ---- "Ask Quantra": grounded conversational analyst ---- */
  async 'ai/ask'(q, body) {
    const ctx = (body && body.context) || {};
    const question = String((body && body.question) || '').slice(0, 600).trim();
    if (!question) return { ok: false, reason: 'no-question' };
    if (ANTHROPIC_KEY && Anthropic && AI_MODEL) {
      try {
        const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
        const sys = 'You are Quantra AI, a markets analyst chatting with a user about a specific asset. Answer in 2-5 plain sentences, grounded ONLY in the supplied live context (price, indicators, forecast, news, fundamentals) plus general market knowledge. If the question needs data you were not given (e.g. another asset not in context), say so briefly. Be candid about uncertainty. Do not give explicit buy/sell signals, actionable price targets, or guarantees. No markdown.';
        const userMsg = 'Live context for ' + (ctx.symbol || 'the asset') + ':\n' + JSON.stringify(ctx, null, 1) + '\n\nUser question: ' + question;
        const msg = await client.messages.create({ model: AI_MODEL, max_tokens: 500, system: sys, messages: [{ role: 'user', content: userMsg }] });
        const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        if (text) return { ok: true, text, source: 'ai' };
      } catch (e) { /* fall through to local */ }
    }
    return localAnswer(question, ctx);
  },

  /* ---- latest news for a stock ----
     Merges the RapidAPI research feed (when keyed) with Yahoo's search news: RapidAPI
     first (fresher + source-attributed, esp. international/NSE), deduped by title.
     Everything downstream — news panel, sentiment meter, AI "read", Ask-Quantra
     context — consumes this one endpoint, so they all inherit the research feed. */
  async 'stock/news'(q) {
    if (!q.symbol) return [];
    return cached(`news:${q.symbol}`, 5 * 60 * 1000, async () => {
      const [rapid, yahoo] = await Promise.all([
        api.research({ symbol: q.symbol }).catch(() => null),
        getJSON(`${YF}/v1/finance/search?q=${encodeURIComponent(q.symbol)}&newsCount=20&quotesCount=1&enableFuzzyQuery=false`).catch(() => null),
      ]);
      const out = [], seen = new Set();
      const add = (n) => { const k = String(n.title || '').toLowerCase().slice(0, 60); if (!n.title || seen.has(k)) return; seen.add(k); out.push(n); };
      if (rapid && rapid.ok) for (const n of rapid.news) {
        const t = n.time ? Date.parse(n.time) : NaN;
        add({ title: n.title, publisher: n.publisher, link: n.link, time: isFinite(t) ? new Date(t).toISOString() : null, thumb: n.thumb, tickers: [q.symbol] });
      }
      if (yahoo) for (const n of (yahoo.news || [])) add({
        title: n.title, publisher: n.publisher, link: n.link,
        time: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
        thumb: (n.thumbnail && n.thumbnail.resolutions && n.thumbnail.resolutions[0] && n.thumbnail.resolutions[0].url) || null,
        tickers: n.relatedTickers || [],
      });
      return out.slice(0, 20);
    });
  },

  /* ---- live config: tells the client which live sources are available ----
     Booleans only (never key values) so the UI — and the operator — can see at a
     glance which real-time feeds are actually loaded: crypto (always), US
     (finnhub), international incl. India/NSE (twelvedata), US fallback (polygon). */
  async config() {
    return { cryptoStream: true, finnhub: !!FINNHUB_KEY, twelvedata: !!TWELVEDATA_KEY, polygon: !!POLYGON_KEY, rapidapi: !!RAPIDAPI_KEY, dhan: DHAN_ON };
  },

  /* ---- RapidAPI research: analyst-grade news + market analytics for a symbol ----
     Feeds the analysis view (and, downstream, the AI brief) with fresher, source-attributed
     coverage than the Yahoo search feed — especially for international names. Key-gated:
     returns {ok:false, reason:'no-rapidapi'} until RAPIDAPI_KEY is set, so nothing breaks. */
  async research(q) {
    if (!RAPIDAPI_KEY) return { ok: false, reason: 'no-rapidapi' };
    if (!q.symbol) return { ok: false, reason: 'no-symbol' };
    const rs = rapidSymbol(q.symbol) || (String(q.symbol).includes(':') ? q.symbol : `${q.symbol}:NASDAQ`);
    try {
      const d = await cached(`rapid:news:${rs}`, 30 * 60 * 1000, () => rapidGet(
        `https://${RAPIDAPI_HOST}/stock-news?symbol=${encodeURIComponent(rs)}&language=en`));
      const raw = (d && d.data && (d.data.news || d.data)) || d.news || [];
      const news = (Array.isArray(raw) ? raw : []).slice(0, 12).map((n) => ({
        title: n.article_title || n.title || n.headline || '',
        link: n.article_url || n.url || n.link || null,
        publisher: n.source || n.source_name || n.publisher || null,
        time: n.post_time_utc || n.published_at || n.time || null,
        thumb: n.article_photo_url || n.thumbnail || null,
      })).filter((n) => n.title);
      return { ok: true, source: 'rapidapi', symbol: q.symbol, resolved: rs, count: news.length, news };
    } catch (e) { return { ok: false, reason: e.message }; }
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

/* Local "Quantra AI" read — composes a professional narrative from the
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
  p.push('Not investment advice.');
  return { ok: true, source: 'quantra', text: p.join(' '), stance, newsImpact: impact, rationale };
}

// Local (no-LLM) answer for "Ask Quantra" — grounded in the supplied live context.
function localAnswer(question, c) {
  c = c || {}; const q = String(question || '').toLowerCase();
  const sym = c.symbol || 'this asset', t = c.technical || {}, fc = c.forecast || {}, nw = c.news || {}, fu = c.fundamentals || {};
  const stance = c.score >= 56 ? 'bullish' : c.score < 45 ? 'bearish' : 'neutral';
  const p = [];
  if (/\b(buy|sell|entry|exit|should i|invest|good time|hold)/.test(q)) {
    p.push(`I can't give buy/sell advice, but here's the read on ${sym}: the Quantra Score is ${c.score ?? '—'} (${stance}).`);
    if (fc.probUp != null) p.push(`The model puts near-term odds of a gain near ${Math.round(fc.probUp * 100)}%.`);
    if (t.rsi != null) p.push(`RSI is ${t.rsi}${t.rsi >= 70 ? ' (overbought — risky to chase)' : t.rsi <= 30 ? ' (oversold)' : ''}.`);
    p.push('Weigh that against your own risk tolerance and time horizon.');
  } else if (/\b(rsi|macd|indicator|technical|oversold|overbought|momentum|adx|moving average|sma)/.test(q)) {
    if (t.rsi != null) p.push(`RSI(14) is ${t.rsi}${t.rsi >= 70 ? ' — overbought' : t.rsi <= 30 ? ' — oversold' : ' — neutral'}.`);
    if (t.macdHist != null) p.push(`MACD histogram ${t.macdHist} (${t.macdHist >= 0 ? 'bullish' : 'bearish'} momentum).`);
    if (t.adx != null) p.push(`ADX ${t.adx} → ${t.adx >= 25 ? 'a trending' : 'a rangebound'} market.`);
    if (t.sma200 != null && c.price != null) p.push(`Price sits ${c.price >= t.sma200 ? 'above' : 'below'} its 200-day average.`);
    if (p.length === 0) p.push('No technical readings are loaded right now.');
  } else if (/\b(risk|volatil|downside|safe|drawdown)/.test(q)) {
    if (fc.annualVol != null) p.push(`${sym} carries roughly ${Math.round(fc.annualVol * 100)}% annualised volatility.`);
    if (fc.lo != null && fc.hi != null) p.push(`The 30-period projection band spans about ${fc.lo} to ${fc.hi} (P10–P90).`);
    p.push('Wider band = more uncertainty in both directions.');
  } else if (/\b(news|why|headline|catalyst|happening|drop|fall|rise|up|down|moving)/.test(q)) {
    if (nw.label) p.push(`Latest news reads ${nw.label} (${nw.positive || 0} positive / ${nw.negative || 0} negative headlines).`);
    if (nw.headlines && nw.headlines.length) p.push(`Top headline: "${nw.headlines[0]}".`);
    if (p.length === 0) p.push('No fresh news is loaded for this asset right now.');
  } else if (/\b(forecast|projection|target|where|predict|expect|outlook)/.test(q)) {
    if (fc.expReturn != null) p.push(`The Monte-Carlo central path projects about ${(fc.expReturn * 100).toFixed(1)}% over ~30 periods${fc.probUp != null ? `, with ~${Math.round(fc.probUp * 100)}% odds of a gain` : ''}.`);
    p.push('It widens with volatility and is probabilistic, not a guarantee.');
  } else if (/\b(fundamental|valuation|p\/?e|earnings|revenue|margin|roe)/.test(q) && fu.peTrailing != null) {
    p.push(`${sym} trades on a ${Number(fu.peTrailing).toFixed(1)}× trailing P/E${fu.revenueGrowth != null ? ` with ${(fu.revenueGrowth * 100).toFixed(0)}% revenue growth` : ''}${fu.roe != null ? ` and ${(fu.roe * 100).toFixed(0)}% ROE` : ''}.`);
  } else {
    p.push(`${sym} reads ${stance} on the Quantra engine (score ${c.score ?? '—'}, ${c.regime || c.grade || 'mixed regime'}).`);
    if (t.rsi != null) p.push(`RSI ${t.rsi}, MACD ${t.macdHist != null ? t.macdHist : '—'}.`);
    if (fc.probUp != null) p.push(`Near-term up-odds ~${Math.round(fc.probUp * 100)}%.`);
    p.push('Ask me about the indicators, risk, news, fundamentals, or the forecast.');
  }
  p.push('(Not advice.)');
  return { ok: true, source: 'quantra', text: p.join(' ') };
}

// Local (no-LLM) personalized daily brief from the aggregated watchlist data.
function localBrief(d) {
  const p = [];
  p.push(`Here's your ${d.date} brief.`);
  if (d.watching && d.watching.length) p.push(`You've been following ${d.watching.slice(0, 3).join(', ')} most.`);
  if (!d.count) { p.push('Add assets to your watchlist to get a personalized read on what moved and what\'s coming up.'); p.push('Not investment advice.'); return p.join(' '); }
  const tone = d.avg > 0.3 ? 'mostly green' : d.avg < -0.3 ? 'mostly red' : 'mixed';
  p.push(`Your ${d.count} watched asset(s) are ${tone} today — ${d.up} up, ${d.down} down, ${d.avg >= 0 ? '+' : ''}${d.avg}% on average.`);
  if (d.topGainers && d.topGainers.length) p.push(`Leading: ${d.topGainers.map((x) => `${x.symbol} ${x.change >= 0 ? '+' : ''}${x.change.toFixed(1)}%`).join(', ')}.`);
  const losers = (d.topLosers || []).filter((x) => x.change < 0);
  if (losers.length) p.push(`Lagging: ${losers.map((x) => `${x.symbol} ${x.change.toFixed(1)}%`).join(', ')}.`);
  if (d.market) p.push(`Broader market: ${d.market.up} advancing vs ${d.market.down} declining (${d.market.avg >= 0 ? '+' : ''}${d.market.avg}% avg) — a ${d.market.avg >= 0 ? 'risk-on' : 'risk-off'} tone.`);
  if (d.earnings && d.earnings.length) p.push(`On your calendar: ${d.earnings.slice(0, 3).map((x) => x.symbol).join(', ')} report soon (next: ${d.earnings[0].symbol} on ${d.earnings[0].date}).`);
  if (d.headlines && d.headlines.length) p.push(`In the news: ${d.headlines.map((h) => `"${h.title}" (${h.publisher || 'press'}) on ${h.symbol}`).join('; ')}.`);
  p.push('Not investment advice.');
  return p.join(' ');
}
async function briefNarrative(d) {
  if (ANTHROPIC_KEY && Anthropic && AI_MODEL) {
    try {
      const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
      const sys = 'You are Quantra AI writing a short, personalized market brief for a user, based ONLY on the supplied data (their watchlist moves, broader-market breadth, upcoming earnings, and research headlines). If a non-empty "watching" list is present, open by acknowledging the assets they follow most. If "headlines" are present, weave one or two into the story with attribution (publisher), connecting them to the price action where sensible. 4-6 warm but factual sentences with concrete numbers. No buy/sell advice, no markdown, no price targets.';
      const msg = await client.messages.create({ model: AI_MODEL, max_tokens: 420, system: sys, messages: [{ role: 'user', content: 'Brief data:\n' + JSON.stringify(d) }] });
      const t = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (t) return { text: t, source: 'ai' };
    } catch {}
  }
  return { text: localBrief(d), source: 'quantra' };
}

/* ============================================================
   Server-side alert monitor — fires even when the tab is closed,
   and emails the user. Active alerts live in each user's data;
   we keep a flat in-memory index and poll prices on a timer.
   ============================================================ */
let alertIdx = [];   // [{ userId, email, alert }]
function alertCondText(a) {
  const v = a.value;
  if (a.cond === 'price_above') return `is at or above ${v}`;
  if (a.cond === 'price_below') return `is at or below ${v}`;
  if (a.cond === 'pct_up') return `is up ${v}% or more today`;
  if (a.cond === 'pct_down') return `is down ${Math.abs(v)}% or more today`;
  return 'condition met';
}
function alertCrossed(a, price, change) {
  if (price == null) return false;
  if (a.cond === 'price_above') return price >= a.value;
  if (a.cond === 'price_below') return price <= a.value;
  if (a.cond === 'pct_up') return change != null && change >= a.value;
  if (a.cond === 'pct_down') return change != null && change <= -Math.abs(a.value);
  return false;
}
const activeAlerts = (d) => (d && Array.isArray(d.alerts) ? d.alerts : []).filter((a) => a && a.status === 'active');
function indexUser(userId, email, d) {
  alertIdx = alertIdx.filter((x) => x.userId !== userId);
  for (const a of activeAlerts(d)) alertIdx.push({ userId, email, alert: a });
}
async function hydrateAlerts() {
  try {
    const users = await store.allUsers(); const idx = [];
    for (const u of users) { const d = await store.getUserData(u.id); for (const a of activeAlerts(d)) idx.push({ userId: u.id, email: u.email, alert: a }); }
    alertIdx = idx;
    if (idx.length) console.log(`[alerts] monitoring ${idx.length} active alert(s)`);
  } catch (e) { console.warn('[alerts] hydrate failed:', e.message); }
}
async function fireAlert(entry, price) {
  const { userId, email } = entry, aId = entry.alert.id;
  let d; try { d = await store.getUserData(userId); } catch { return; }
  const al = (d.alerts || []).find((y) => y.id === aId);
  if (!al || al.status !== 'active') { alertIdx = alertIdx.filter((y) => !(y.userId === userId && y.alert.id === aId)); return; }
  al.status = 'triggered'; al.triggeredAt = Date.now(); al.triggeredPrice = price;
  alertIdx = alertIdx.filter((y) => !(y.userId === userId && y.alert.id === aId));
  const cond = alertCondText(al);
  const pretty = '$' + Number(price).toLocaleString('en-US', { maximumFractionDigits: price >= 1000 ? 0 : price >= 1 ? 2 : 6 });
  // push to the user's devices (and prune dead subscriptions) before persisting
  if (PUSH_ENABLED && Array.isArray(d.pushSubs) && d.pushSubs.length) {
    const dead = await sendPush(d.pushSubs, { title: `🔔 ${al.symbol} alert`, body: `${al.symbol} ${cond}. Now ${pretty}.`, url: APP_URL });
    if (dead.length) d.pushSubs = d.pushSubs.filter((x) => !dead.includes(x.endpoint));
  }
  try { await store.putUserData(userId, d); } catch {}
  sendMail(email, `🔔 ${al.symbol} ${cond}`,
    shell(`${al.symbol} alert triggered`, `<p style="color:#93A0B8">Your Quantra alert fired — <b style="color:#E7ECF5">${al.symbol}</b> ${cond}.</p><p style="color:#E7ECF5;font-size:20px;margin:14px 0"><b>Now: ${pretty}</b></p>${btn(APP_URL, 'Open Quantra AI')}`),
    `Quantra alert: ${al.symbol} ${cond}. Now ${pretty}.`).catch(() => {});
}
let alertBusy = false;
async function monitorAlerts() {
  if (alertBusy || !alertIdx.length) return; alertBusy = true;
  try {
    const groups = new Map();
    for (const x of alertIdx) { const k = (x.alert.assetType || 'crypto') + ':' + (x.alert.assetId || x.alert.symbol); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
    for (const list of groups.values()) {
      const a0 = list[0].alert; let pr;
      try { pr = await api['price']({ id: a0.assetId || a0.symbol, symbol: a0.symbol, type: a0.assetType }); } catch { pr = null; }
      if (!pr || !pr.ok || pr.price == null) continue;
      for (const x of list) if (alertCrossed(x.alert, pr.price, pr.change)) await fireAlert(x, pr.price);
    }
  } catch (e) { console.warn('[alerts] monitor error:', e.message); }
  alertBusy = false;
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
    // M8: ?v=-versioned assets are content-addressed by convention (we bump v on every
    // change), so they can cache forever — repeat page loads skip re-downloading the
    // big JS/CSS bundles entirely.
    const versioned = /[?&]v=\d/.test(req.url);
    const noCache = ext === '.html' || ext === '.js' || ext === '.css';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : noCache ? 'no-store, must-revalidate' : 'public, max-age=3600',
    };
    // M8: gzip text responses (~70% smaller on the ~150 KB terminal.js) when accepted
    const texty = ext === '.html' || ext === '.js' || ext === '.css' || ext === '.svg' || ext === '.json' || ext === '.webmanifest';
    if (texty && buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      try { buf = zlib.gzipSync(buf); headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding'; } catch {}
    }
    res.writeHead(200, headers);
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
// For now every signed-in user is granted the top "ultimate" plan, and super-admins always are.
// Anonymous (not signed in) stays on "free" — so a user must at least sign in to get it.
// Billing go-live switch (M2): defaults to TRUE (everyone gets Ultimate) so nothing
// changes until the operator finishes the Stripe setup (docs/foundation/07_BILLING_RUNBOOK.md)
// and sets FORCE_ULTIMATE=false on Render. Then plans enforce per-org limits and the
// Upgrade buttons in the account menu run real Stripe checkout.
const FORCE_ULTIMATE = process.env.FORCE_ULTIMATE !== 'false';
const planFor = (org, email) => isSuperAdmin(email) ? 'ultimate' : (FORCE_ULTIMATE ? (org ? 'ultimate' : 'free') : ((org && org.plan) || 'free'));
const maskKey = (k) => { k = String(k || ''); return k.length <= 6 ? '••••' : k.slice(0, 4) + '…' + k.slice(-2); };
const { sendMail, mailConfig, shell, btn, APP_URL } = require('./mailer');
const broker = require('./broker');
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
async function userPublic(u) { const org = await store.getOrg(u.orgId); return { id: u.id, email: u.email, name: u.name, orgId: u.orgId, role: u.role, verified: !!u.verified, plan: planFor(org, u.email), superAdmin: isSuperAdmin(u.email) }; }
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
function sanitizeHandle(h, user) {
  let s = String(h || '').replace(/[^A-Za-z0-9_\- ]/g, '').trim().slice(0, 24);
  if (!s) s = 'Trader-' + String((user && user.id) || '').replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase();
  return s;
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
      const userId = newId('usr');
      // M7: invited signups join the inviter's workspace as members instead of
      // getting their own org (token from POST /api/org/invite, 7-day expiry).
      let orgId = null, role = 'owner';
      if (body.invite) {
        const inv = await store.getToken(String(body.invite));
        if (inv && inv.type === 'invite' && inv.exp > Date.now() && (await store.getOrg(inv.orgId))) {
          orgId = inv.orgId; role = 'member';
          await store.delToken(String(body.invite));
        }
      }
      if (!orgId) {
        orgId = newId('org');
        await store.putOrg({ id: orgId, name: String(body.orgName || '').trim() || `${name}'s workspace`, plan: 'free', apiKey: 'qk_live_' + crypto.randomBytes(16).toString('hex'), ownerId: userId, createdAt: Date.now() });
      }
      const user = { id: userId, email, name, passHash: hashPw(pw), orgId, role, verified: false, createdAt: Date.now() };
      await store.putUser(user);
      audit('signup', req, email, { orgId, invited: role === 'member' });
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
        const org = await store.getOrg(s.user.orgId), cfg = planOf(planFor(org, s.user.email));
        const d = await store.getUserData(s.user.id);
        if (Array.isArray(body.watchlist)) d.watchlist = body.watchlist.slice(0, cfg.watchlistMax);
        if (body.prefs && typeof body.prefs === 'object') d.prefs = { ...d.prefs, ...body.prefs };
        if (Array.isArray(body.screens)) d.screens = body.screens.slice(0, 50);
        if (Array.isArray(body.portfolio)) d.portfolio = body.portfolio.slice(0, 200);
        if (Array.isArray(body.layouts)) d.layouts = body.layouts.slice(0, 20);
        if (body.paper && typeof body.paper === 'object') {
          const pp = body.paper;
          d.paper = {
            cash: Number(pp.cash) || 0,
            realized: Number(pp.realized) || 0,
            startCash: Number(pp.startCash) || 100000,
            startedAt: Number(pp.startedAt) || Date.now(),
            positions: Array.isArray(pp.positions) ? pp.positions.slice(0, 100) : [],
            trades: Array.isArray(pp.trades) ? pp.trades.slice(-200) : [],
            journal: String(pp.journal || '').slice(0, 4000),
          };
        }
        if (Array.isArray(body.alerts)) d.alerts = body.alerts.slice(0, 100).map((a) => ({
          id: String(a.id || '').slice(0, 40),
          assetId: String(a.assetId || a.symbol || '').slice(0, 40),
          symbol: String(a.symbol || '').slice(0, 20),
          name: String(a.name || '').slice(0, 80),
          assetType: String(a.assetType || 'crypto').slice(0, 12),
          cond: ['price_above', 'price_below', 'pct_up', 'pct_down'].includes(a.cond) ? a.cond : 'price_above',
          value: Number(a.value) || 0,
          note: String(a.note || '').slice(0, 120),
          status: a.status === 'triggered' ? 'triggered' : 'active',
          createdAt: Number(a.createdAt) || Date.now(),
          triggeredAt: a.triggeredAt ? Number(a.triggeredAt) : undefined,
          triggeredPrice: a.triggeredPrice != null ? Number(a.triggeredPrice) : undefined,
        })).filter((a) => a.id && a.symbol);
        await store.putUserData(s.user.id, d);
        if (Array.isArray(body.alerts)) indexUser(s.user.id, s.user.email, d);   // keep the monitor in sync
        return send(res, 200, d);
      }
    }
    /* ---- Personalization: learn what each user watches (affinity), tailor "For you" ---- */
    if (p === '/api/me/track' && m === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 200, { ok: false });   // silent for guests
      const type = String(body.type || '').slice(0, 12), id = String(body.id || body.symbol || '').slice(0, 40);
      const symbol = String(body.symbol || '').slice(0, 24), name = String(body.name || '').slice(0, 60);
      if (!type || !id) return send(res, 200, { ok: false });
      const d = await store.getUserData(s.user.id);
      const aff = d.affinity = d.affinity || { symbols: {}, classes: {} };
      const key = type + ':' + id, cur = aff.symbols[key] || { n: 0, type, id, symbol, name };
      cur.n++; cur.t = Date.now(); if (symbol) cur.symbol = symbol; if (name) cur.name = name;
      aff.symbols[key] = cur; aff.classes[type] = (aff.classes[type] || 0) + 1;
      const keys = Object.keys(aff.symbols);
      if (keys.length > 40) {   // keep the 40 strongest signals (views, then recency)
        keys.sort((a, b) => (aff.symbols[b].n - aff.symbols[a].n) || ((aff.symbols[b].t || 0) - (aff.symbols[a].t || 0)));
        const keep = {}; keys.slice(0, 40).forEach((k) => { keep[k] = aff.symbols[k]; }); aff.symbols = keep;
      }
      await store.putUserData(s.user.id, d);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/me/foryou' && m === 'GET') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const d = await store.getUserData(s.user.id);
      const aff = d.affinity || { symbols: {}, classes: {} };
      const syms = Object.values(aff.symbols || {}).sort((a, b) => (b.n - a.n) || ((b.t || 0) - (a.t || 0))).slice(0, 6);
      const favClass = Object.entries(aff.classes || {}).sort((a, b) => b[1] - a[1])[0];
      const watched = await Promise.all(syms.map(async (x) => {
        try { const pr = await api['price']({ type: x.type, id: x.id, symbol: x.symbol }); return { type: x.type, id: x.id, symbol: x.symbol, name: x.name, price: pr && pr.price, change: pr && pr.change, currency: pr && pr.currency, views: x.n }; }
        catch { return { type: x.type, id: x.id, symbol: x.symbol, name: x.name, views: x.n }; }
      }));
      return send(res, 200, { favoriteClass: favClass ? favClass[0] : null, watched, totalViews: Object.values(aff.classes || {}).reduce((a, b) => a + b, 0) });
    }
    if (p === '/api/me/limits' && m === 'GET') {
      const s = await sessionUser(req);
      const org = s ? await store.getOrg(s.user.orgId) : null;
      const plan = planFor(org, s && s.user && s.user.email), cfg = planOf(plan);
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
        return { id: u.id, email: u.email, name: u.name, role: u.role, verified: !!u.verified, plan: planFor(org, u.email), workspace: (org || {}).name || null, createdAt: u.createdAt || null, lastLogin: u.lastLogin || null, superAdmin: isSuperAdmin(u.email) };
      }));
      rows.sort((a, b) => (b.lastLogin || b.createdAt || 0) - (a.lastLogin || a.createdAt || 0));
      return send(res, 200, { count: rows.length, users: rows });
    }
    if (p === '/api/admin/datatest' && m === 'GET') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (!isSuperAdmin(s.user.email)) { audit('admin_denied', req, s.user.email, { path: p }); return send(res, 403, { error: 'Forbidden.' }); }
      const nse = String(u.searchParams.get('symbol') || 'RELIANCE.NS');
      const [twelvedata, polygon, finnhub, rapidapi, dhan] = await Promise.all([tdTest(nse), polyTest('AAPL'), fhTest('AAPL'), rapidTest(nse), dhanTest()]);
      twelvedata.hint = feedHint('twelvedata', twelvedata);
      polygon.hint = feedHint('polygon', polygon);
      finnhub.hint = feedHint('finnhub', finnhub);
      rapidapi.hint = feedHint('rapidapi', rapidapi);
      if (dhan.configured && !dhan.ok) dhan.hint = /401|403/.test(String(dhan.error)) ? '→ Dhan token invalid or expired — regenerate the access token in DhanHQ and update DHAN_ACCESS_TOKEN on Render (tokens expire; renew monthly).' : '→ Check the DhanHQ dashboard / API status.';
      return send(res, 200, { twelvedata, polygon, finnhub, rapidapi, dhan });
    }
    if (p === '/api/admin/mail-test' && m === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (!isSuperAdmin(s.user.email)) { audit('admin_denied', req, s.user.email, { path: p }); return send(res, 403, { error: 'Forbidden.' }); }
      const to = String(body.to || s.user.email).trim().toLowerCase();
      const cfg = mailConfig();
      const r = await sendMail(to, 'Quantra AI — test email',
        shell('Test email', '<p style="color:#cbd5e1">If you can read this, Resend delivery is working. ✅</p>'),
        'Quantra AI test email — if you received this, delivery is working.');
      audit('admin_mail_test', req, s.user.email, { to, ok: r.ok, status: r.status || null });
      return send(res, 200, { ok: r.ok, to, from: cfg.from, configured: cfg.configured, sandbox: cfg.sandbox, status: r.status || null, id: r.id || null, error: r.error || null });
    }
    if (p === '/api/admin/users/delete' && m === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (!isSuperAdmin(s.user.email)) { audit('admin_denied', req, s.user.email, { path: p }); return send(res, 403, { error: 'Forbidden.' }); }
      const target = await store.getUserById(String(body.id || '')); if (!target) return send(res, 404, { error: 'User not found.' });
      if (target.email === s.user.email) return send(res, 400, { error: 'You cannot delete your own account from here.' });
      if (isSuperAdmin(target.email)) return send(res, 400, { error: 'Cannot delete a super-admin account. Remove their email from SUPER_ADMINS first.' });
      await store.delSessionsForEmail(target.email);
      await store.deleteUserData(target.id);
      if (target.orgId) { const org = await store.getOrg(target.orgId); if (org && org.ownerId === target.id) await store.deleteOrg(target.orgId); }
      await store.deleteUser(target.email);
      audit('admin_delete_user', req, s.user.email, { target: target.email });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/audit' && m === 'GET') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (!isSuperAdmin(s.user.email)) { audit('admin_denied', req, s.user.email, { path: p }); return send(res, 403, { error: 'Forbidden.' }); }
      const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '300', 10), 1), 1000);
      const offset = Math.max(parseInt(u.searchParams.get('offset') || '0', 10), 0);
      audit('admin_view_audit', req, s.user.email);
      return send(res, 200, { events: await store.listAudit(limit, offset) });
    }
    if (p === '/api/admin/selfcheck' && m === 'GET') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (!isSuperAdmin(s.user.email)) { audit('admin_denied', req, s.user.email, { path: p }); return send(res, 403, { error: 'Forbidden.' }); }
      if (u.searchParams.get('run') === '1') await selfCheck();   // run on demand
      return send(res, 200, { last: healthLast, history: healthHistory });
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
        status: { storage: store.kind, finnhub: !!FINNHUB_KEY, coingecko: !!COINGECKO_KEY, ai: !!ANTHROPIC_KEY, fmp: !!FMP_KEY, marketaux: !!MARKETAUX_KEY, twelvedata: !!TWELVEDATA_KEY, polygon: !!POLYGON_KEY, rapidapi: !!RAPIDAPI_KEY, push: PUSH_ENABLED, cryptoStream: true, mail: mailConfig(), uptimeSec: Math.round(process.uptime()), node: process.version,
          billing: { stripe: !!stripe, prices: !!(PRICES.pro && PRICES.ultimate), webhook: !!process.env.STRIPE_WEBHOOK_SECRET, enforcing: !FORCE_ULTIMATE },
          rapidQuota: { callsToday: rapidState.calls, breaker: Date.now() < rapidState.breakerUntil } },
      });
    }
    if (p === '/api/org' && m === 'GET') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const org = (await store.getOrg(s.user.orgId)) || {};
      return send(res, 200, { id: org.id, name: org.name, plan: planFor(org, s.user.email), members: await store.countMembers(s.user.orgId), role: s.user.role, apiKey: s.user.role === 'owner' ? org.apiKey : undefined, billingEnabled: !!stripe, devBilling: !!process.env.QUANTRA_DEV_BILLING && !PROD });
    }

    /* ---- M7: team workspaces — members, invites, shared watchlist ---- */
    if (p === '/api/org/members' && m === 'GET') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const users = (await store.allUsers()).filter((u2) => u2.orgId === s.user.orgId);
      return send(res, 200, { ok: true, members: users.map((u2) => ({ email: u2.email, name: u2.name, role: u2.role, verified: !!u2.verified, lastLogin: u2.lastLogin || null })) });
    }
    if (p === '/api/org/invite' && m === 'POST') {
      if (tooMany(res, 'inv:' + clientIp(req), 20, 3600000)) return;
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (s.user.role !== 'owner') return send(res, 403, { error: 'Only the workspace owner can invite.' });
      const t = crypto.randomBytes(18).toString('hex');
      await store.putToken(t, { type: 'invite', orgId: s.user.orgId, invitedBy: s.user.email, exp: Date.now() + 7 * 24 * 3600 * 1000 });
      const link = `${APP_URL}/terminal.html?invite=${t}`;
      const toEmail = String(body.email || '').trim().toLowerCase();
      let mailed = false;
      if (toEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail) && mailConfig().ok) {
        const org = await store.getOrg(s.user.orgId);
        try { const r = await sendMail(toEmail, `You're invited to ${(org && org.name) || 'a Quantra workspace'}`, shell('Workspace invite', `<p style="color:#93A0B8">${s.user.email} invited you to their Quantra AI workspace — shared team watchlist, synced markets terminal.</p>${btn(link, 'Join the workspace')}<p style="color:#5A6680;font-size:12px">The link expires in 7 days. ${link}</p>`)); mailed = !!(r && r.ok !== false); } catch {}
      }
      audit('org_invite', req, s.user.email, { to: toEmail || '(link only)' });
      return send(res, 200, { ok: true, link, mailed });
    }
    if (p === '/api/org/members/remove' && m === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (s.user.role !== 'owner') return send(res, 403, { error: 'Only the workspace owner can remove members.' });
      const email = String(body.email || '').trim().toLowerCase();
      const usr = await store.getUserByEmail(email);
      if (!usr || usr.orgId !== s.user.orgId) return send(res, 404, { error: 'No such member in your workspace.' });
      if (usr.email === s.user.email) return send(res, 400, { error: 'Owners cannot remove themselves.' });
      // moved out, not deleted: they get a fresh personal workspace and keep their data
      const newOrg = newId('org');
      await store.putOrg({ id: newOrg, name: `${usr.name || usr.email.split('@')[0]}'s workspace`, plan: 'free', apiKey: 'qk_live_' + crypto.randomBytes(16).toString('hex'), ownerId: usr.id, createdAt: Date.now() });
      usr.orgId = newOrg; usr.role = 'owner';
      await store.putUser(usr);
      audit('org_member_removed', req, s.user.email, { removed: email });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/org/watch' && m === 'GET') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const org = (await store.getOrg(s.user.orgId)) || {};
      const items = (org.sharedWatch || []).slice(0, 20);
      const priced = await Promise.all(items.map(async (it) => {
        try { const pr = await api['price']({ id: it.id || it.symbol, symbol: it.symbol, type: it.type }); return { ...it, price: pr.ok ? pr.price : null, change24h: pr.ok ? pr.change : null, currency: (pr && pr.currency) || 'USD' }; }
        catch { return { ...it, price: null, change24h: null }; }
      }));
      return send(res, 200, { ok: true, items: priced, count: (org.sharedWatch || []).length });
    }
    if (p === '/api/org/watch' && m === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const org = await store.getOrg(s.user.orgId);
      if (!org) return send(res, 404, { error: 'No workspace.' });
      org.sharedWatch = org.sharedWatch || [];
      const it = body.item || {};
      const key = (x) => `${x.type}:${x.id || x.symbol}`;
      if (body.action === 'remove') {
        org.sharedWatch = org.sharedWatch.filter((x) => key(x) !== key(it));
      } else {
        if (!it.symbol || !it.type) return send(res, 400, { error: 'Bad item.' });
        if (org.sharedWatch.length >= 50) return send(res, 400, { error: 'Team watchlist is full (50).' });
        if (!org.sharedWatch.some((x) => key(x) === key(it))) org.sharedWatch.push({ type: String(it.type).slice(0, 12), id: String(it.id || it.symbol).slice(0, 40), symbol: String(it.symbol).slice(0, 20), name: String(it.name || it.symbol).slice(0, 80), by: s.user.email });
      }
      await store.putOrg(org);
      return send(res, 200, { ok: true, count: org.sharedWatch.length });
    }

    /* ---- Bring-your-own-broker (user links their OWN broker; Quantra never holds funds) ---- */
    // Connection status — NEVER returns the secret; key id is masked.
    if (p === '/api/broker/providers' && m === 'GET') return send(res, 200, { providers: broker.list() });
    if (p === '/api/broker/status' && m === 'GET') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const b = s.user.broker;
      return send(res, 200, { connected: !!b, provider: b ? b.provider : null, mode: b ? b.mode : null, keyHint: b ? maskKey(b.keyId) : null, connectedAt: b ? b.connectedAt : null });
    }
    if (p === '/api/broker/connect' && m === 'POST') {
      if (tooMany(res, 'bc:' + clientIp(req), 15, 3600000)) return;   // 15 connect attempts / hr / IP
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const provider = String(body.provider || '').toLowerCase();
      const mode = body.mode === 'live' ? 'live' : 'paper';
      // M6: live trading is gated twice — the operator must enable it deployment-wide
      // (BROKER_LIVE_ENABLED=true, only after compliance review) AND the user must
      // explicitly acknowledge the risk. Paper mode is always available.
      if (mode === 'live') {
        if (process.env.BROKER_LIVE_ENABLED !== 'true') return send(res, 200, { ok: false, error: 'Live trading is not enabled on this deployment yet — paper trading only for now.' });
        if (body.acceptLiveRisk !== true) return send(res, 400, { error: 'Live mode requires ticking the risk acknowledgement.' });
      }
      const keyId = String(body.keyId || '').trim(), secret = String(body.secret || '').trim();
      if (!broker.PROVIDERS[provider]) return send(res, 400, { error: 'Unsupported broker.' });
      if (!keyId || !secret) return send(res, 400, { error: 'Enter both the API key and secret.' });
      let account;
      try { account = await broker.verify(provider, { mode, keyId, secret }); }
      catch (e) { return send(res, 200, { ok: false, error: 'Broker rejected the credentials: ' + (e.message || 'unknown error') }); }
      const usr = await store.getUserByEmail(s.user.email);
      usr.broker = { provider, mode, keyId, secret, connectedAt: Date.now() };
      await store.putUser(usr);
      audit('broker_connect', req, s.user.email, { provider, mode });   // secret never logged
      return send(res, 200, { ok: true, provider, mode, keyHint: maskKey(keyId), account });
    }
    if (p === '/api/broker/disconnect' && m === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const usr = await store.getUserByEmail(s.user.email);
      delete usr.broker; await store.putUser(usr);
      audit('broker_disconnect', req, s.user.email);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/broker/account' && m === 'GET') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const b = s.user.broker; if (!b) return send(res, 400, { error: 'No broker connected.' });
      try {
        const prov = broker.PROVIDERS[b.provider];
        const [account, positions] = await Promise.all([prov.account(b), prov.positions(b).catch(() => [])]);
        return send(res, 200, { ok: true, provider: b.provider, mode: b.mode, account, positions });
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }
    if (p === '/api/broker/orders' && m === 'GET') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const b = s.user.broker; if (!b) return send(res, 400, { error: 'No broker connected.' });
      try { return send(res, 200, { ok: true, orders: await broker.PROVIDERS[b.provider].orders(b) }); }
      catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }
    // Place an order — ALWAYS user-initiated (one explicit request per order; no autonomous loop).
    if (p === '/api/broker/order' && m === 'POST') {
      if (tooMany(res, 'bo:' + clientIp(req), 60, 3600000)) return;   // 60 orders / hr / IP (anti-abuse)
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const b = s.user.broker; if (!b) return send(res, 400, { error: 'No broker connected.' });
      // Live orders require the client to echo the live mode explicitly — guards against an accidental real-money send.
      if (b.mode === 'live' && body.confirmLive !== true) return send(res, 400, { error: 'Live order not confirmed.' });
      try {
        const order = await broker.PROVIDERS[b.provider].placeOrder(b, { symbol: body.symbol, side: body.side, type: body.type, qty: body.qty, notional: body.notional, limitPrice: body.limitPrice, tif: body.tif });
        audit('broker_order', req, s.user.email, { provider: b.provider, mode: b.mode, symbol: order.symbol, side: order.side, qty: order.qty, type: order.type });
        return send(res, 200, { ok: true, mode: b.mode, order });
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }
    if (p === '/api/broker/cancel' && m === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const b = s.user.broker; if (!b) return send(res, 400, { error: 'No broker connected.' });
      try { await broker.PROVIDERS[b.provider].cancel(b, String(body.id || '')); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 200, { ok: false, error: e.message }); }
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
      const cfg = planOf(planFor(org, s && s.user && s.user.email));
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
    if (p === '/api/ai/ask' && m === 'POST') {
      if (tooMany(res, 'ask:' + clientIp(req), 40, 3600000)) return;   // 40 questions / hour / IP
      return send(res, 200, await api['ai/ask'](Object.fromEntries(u.searchParams.entries()), body));
    }
    if (p === '/api/brief' && m === 'POST') {
      if (tooMany(res, 'brief:' + clientIp(req), 20, 3600000)) return;   // 20 briefs / hour / IP
      try {   // personalize: tell the brief which assets this user follows most
        const s = await sessionUser(req);
        if (s) { const ud = await store.getUserData(s.user.id); const aff = ud.affinity && ud.affinity.symbols;
          if (aff) body.affinity = Object.values(aff).sort((a, b) => (b.n - a.n) || ((b.t || 0) - (a.t || 0))).slice(0, 4).map((x) => x.symbol); }
      } catch {}
      return send(res, 200, await api['brief'](Object.fromEntries(u.searchParams.entries()), body));
    }
    // ---- community: shared trade ideas + paper-return leaderboard ----
    if (p === '/api/community/ideas' && m === 'GET') return send(res, 200, { ideas: await store.listIdeas(80) });
    if (p === '/api/community/ideas' && m === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (tooMany(res, 'idea:' + clientIp(req), 15, 3600000)) return;
      const symbol = String(body.symbol || '').toUpperCase().slice(0, 20);
      const thesis = String(body.thesis || '').slice(0, 600).trim();
      if (!symbol || !thesis) return send(res, 400, { error: 'Symbol and thesis are required.' });
      const dir = ['bullish', 'bearish', 'neutral'].includes(body.direction) ? body.direction : 'neutral';
      const idea = { id: newId('idea'), ts: Date.now(), authorId: s.user.id, handle: sanitizeHandle(body.handle, s.user), symbol, assetType: String(body.type || '').slice(0, 12), assetId: String(body.id || symbol).slice(0, 40), direction: dir, thesis, target: body.target != null && isFinite(+body.target) ? +body.target : null, horizon: String(body.horizon || '').slice(0, 40), votes: 0, voters: [] };
      await store.addIdea(idea); audit('idea_post', req, s.user.email, { symbol });
      return send(res, 200, { ok: true, idea });
    }
    if (p === '/api/community/ideas' && m === 'DELETE') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const idea = await store.getIdea(String(u.searchParams.get('id') || body.id || '')); if (!idea) return send(res, 404, { error: 'Not found.' });
      if (idea.authorId !== s.user.id && !isSuperAdmin(s.user.email)) return send(res, 403, { error: 'Forbidden.' });
      await store.deleteIdea(idea.id); return send(res, 200, { ok: true });
    }
    if (p === '/api/community/vote' && m === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const idea = await store.getIdea(String(body.id || '')); if (!idea) return send(res, 404, { error: 'Not found.' });
      idea.voters = idea.voters || [];
      const i = idea.voters.indexOf(s.user.id);
      if (i >= 0) idea.voters.splice(i, 1); else idea.voters.push(s.user.id);
      idea.votes = idea.voters.length; await store.updateIdea(idea);
      return send(res, 200, { ok: true, votes: idea.votes, voted: i < 0 });
    }
    if (p === '/api/community/leaderboard' && m === 'GET') {
      const leaders = (await store.allLeaders()).filter(Boolean).sort((a, b) => (b.return || 0) - (a.return || 0)).slice(0, 100);
      return send(res, 200, { leaders });
    }
    if (p === '/api/community/publish' && m === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const ret = Number(body.return), equity = Number(body.equity), trades = Number(body.trades) || 0;
      if (!isFinite(ret) || !isFinite(equity)) return send(res, 400, { error: 'Bad data.' });
      await store.putLeader(s.user.id, { uid: s.user.id, handle: sanitizeHandle(body.handle, s.user), return: +ret.toFixed(2), equity: Math.round(equity), trades, ts: Date.now() });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/push/config' && m === 'GET') return send(res, 200, { enabled: PUSH_ENABLED, publicKey: VAPID_PUBLIC });
    if (p === '/api/push/subscribe' && m === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const sub = body.subscription;
      if (!sub || !sub.endpoint) return send(res, 400, { error: 'Bad subscription.' });
      const d = await store.getUserData(s.user.id);
      d.pushSubs = (d.pushSubs || []).filter((x) => x.endpoint !== sub.endpoint);
      d.pushSubs.unshift(sub); if (d.pushSubs.length > 10) d.pushSubs = d.pushSubs.slice(0, 10);
      await store.putUserData(s.user.id, d);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/push/unsubscribe' && m === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      const d = await store.getUserData(s.user.id);
      d.pushSubs = (d.pushSubs || []).filter((x) => x.endpoint !== (body.endpoint || ''));
      await store.putUserData(s.user.id, d);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/push/test' && m === 'POST') {   // send a test push to this user's devices
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Not signed in.' });
      if (!PUSH_ENABLED) return send(res, 200, { ok: false, reason: 'disabled' });
      const d = await store.getUserData(s.user.id);
      const dead = await sendPush(d.pushSubs || [], { title: '🔔 Quantra test', body: 'Push notifications are working on this device.', url: APP_URL });
      if (dead.length) { d.pushSubs = (d.pushSubs || []).filter((x) => !dead.includes(x.endpoint)); await store.putUserData(s.user.id, d); }
      return send(res, 200, { ok: true, sent: (d.pushSubs || []).length });
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
  } catch (e) { try { noteError(); } catch {} return send(res, 500, { error: String(e.message || e) }); }
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
// Short horizons mature within days so the record advances with the calendar from day one,
// instead of sitting empty until a 5-day window first completes.
const TR_HORIZONS = [1, 2, 3, 5, 10, 30];
// Band multiplier for the live projection-calibration widget. With a daily σ from
// the trailing window, exp(±BAND_Z·σ·√H) lands realised coverage at ~80% on a
// 5-year backtest (Z=1.28→78%, 1.45→83%), so 1.34 ≈ a true 80% band.
const BAND_Z = 1.34;
// Daily volatility from a board item's sparkline (crypto sparks are hourly → ×√24).
function sparkSigmaDaily(it) {
  const s = (it.spark || []).filter((v) => v > 0);
  if (s.length < 10) return null;
  const r = []; for (let i = 1; i < s.length; i++) r.push(Math.log(s[i] / s[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  let sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
  if (it.type === 'crypto') sd *= Math.sqrt(24);
  return isFinite(sd) && sd > 0 ? Math.round(sd * 1e5) / 1e5 : null;
}
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
      .map((it) => ({ type: it.type, symbol: it.symbol, score: Q.liteScore(it.spark, it.change24h), price: it.price, sd: sparkSigmaDaily(it) }))
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
/* ---- shareable analysis snapshot: sanitize + render (server-side) ---- */
function shareSnapshot(b) {
  if (!b || !b.symbol) return null;
  const num = (v) => (v == null || !isFinite(+v)) ? null : +(+v).toFixed(6);
  const str = (v, n) => v == null ? null : String(v).slice(0, n || 40);
  return {
    symbol: str(b.symbol, 20), name: str(b.name, 60), type: str(b.type, 12),
    price: num(b.price), currency: str(b.currency, 6) || 'USD',
    score: (b.score != null && isFinite(+b.score)) ? Math.round(+b.score) : null,
    grade: str(b.grade, 16), dir: str(b.dir, 8), trend: str(b.trend, 40),
    lo: num(b.lo), hi: num(b.hi), horizon: str(b.horizon, 20),
    ts: Date.now(),
  };
}
function fmtMoney(v, ccy) {
  if (v == null) return '—';
  const p = (ccy === 'USD' || !ccy) ? '$' : '';
  const suf = (ccy && ccy !== 'USD') ? ' ' + ccy : '';
  return p + Number(v).toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 1 ? 2 : 6 }) + suf;
}
function shareCardSvg(d) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const scoreCol = d.score == null ? '#93A0B8' : d.score >= 70 ? '#34D399' : d.score >= 56 ? '#22D3EE' : d.score >= 45 ? '#FBBF24' : '#FB7185';
  const band = (d.lo != null && d.hi != null) ? `${fmtMoney(d.lo, d.currency)} – ${fmtMoney(d.hi, d.currency)}` : '—';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop stop-color="#34D399"/><stop offset=".5" stop-color="#22D3EE"/><stop offset="1" stop-color="#818CF8"/></linearGradient></defs>
  <rect width="1200" height="630" fill="#0A0F1C"/>
  <rect x="0" y="0" width="1200" height="8" fill="url(#g)"/>
  <text x="70" y="96" fill="#6B7890" font-family="Arial,sans-serif" font-size="26" font-weight="bold" letter-spacing="2">QUANTRA AI · ANALYSIS</text>
  <text x="70" y="188" fill="#E7ECF5" font-family="Arial,sans-serif" font-size="72" font-weight="bold">${esc(d.symbol)}</text>
  <text x="70" y="238" fill="#93A0B8" font-family="Arial,sans-serif" font-size="30">${esc((d.name || '').slice(0, 42))}</text>
  <text x="70" y="340" fill="#E7ECF5" font-family="Arial,sans-serif" font-size="58" font-weight="bold">${esc(fmtMoney(d.price, d.currency))}</text>
  <text x="70" y="386" fill="#93A0B8" font-family="Arial,sans-serif" font-size="28">${esc(d.trend || '')}</text>
  <rect x="820" y="120" width="310" height="200" rx="20" fill="#121A2E" stroke="${scoreCol}" stroke-width="2"/>
  <text x="975" y="196" fill="#6B7890" font-family="Arial,sans-serif" font-size="24" text-anchor="middle" font-weight="bold">QUANTRA SCORE</text>
  <text x="975" y="272" fill="${scoreCol}" font-family="Arial,sans-serif" font-size="86" text-anchor="middle" font-weight="bold">${d.score == null ? '—' : d.score}</text>
  <text x="975" y="306" fill="#93A0B8" font-family="Arial,sans-serif" font-size="24" text-anchor="middle">${esc(d.grade || '')}</text>
  <text x="70" y="470" fill="#6B7890" font-family="Arial,sans-serif" font-size="26" font-weight="bold">PROJECTION RANGE (${esc(d.horizon || '')})</text>
  <text x="70" y="518" fill="#22D3EE" font-family="Arial,sans-serif" font-size="40" font-weight="bold">${esc(band)}</text>
  <text x="70" y="586" fill="#6B7890" font-family="Arial,sans-serif" font-size="24">Probabilistic — not a guarantee, not investment advice · quantra-ai.onrender.com</text>
  </svg>`;
}
// Canonical public base from the request itself (Render sits behind a proxy, so
// honor x-forwarded-proto/host) — reliable even when APP_URL env is unset.
function reqBase(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (isHttps(req) ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'quantra-ai.onrender.com';
  return `${proto}://${host}`;
}
function sharePageHtml(d, id, baseIn) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const base = (baseIn || APP_URL || '').replace(/\/$/, '');
  if (!d) return `<!doctype html><meta charset="utf-8"><title>Quantra AI</title><body style="background:#0A0F1C;color:#93A0B8;font-family:Arial;text-align:center;padding:80px"><h2 style="color:#34D399">Quantra AI</h2><p>This shared analysis link has expired or was not found.</p><a href="${base}/terminal.html" style="color:#22D3EE">Open the live terminal →</a></body>`;
  const title = `${d.symbol} — Quantra Score ${d.score == null ? '' : d.score}${d.grade ? ' (' + d.grade + ')' : ''}`;
  const desc = `${d.name || d.symbol} at ${fmtMoney(d.price, d.currency)}. ${d.trend || ''} Projection ${d.horizon || ''}: ${d.lo != null ? fmtMoney(d.lo, d.currency) + '–' + fmtMoney(d.hi, d.currency) : ''}. Probabilistic, not advice.`;
  const img = `${base}/api/share/${id}/img.svg`;
  const scoreCol = d.score == null ? '#93A0B8' : d.score >= 70 ? '#34D399' : d.score >= 56 ? '#22D3EE' : d.score >= 45 ? '#FBBF24' : '#FB7185';
  const band = (d.lo != null && d.hi != null) ? `${fmtMoney(d.lo, d.currency)} – ${fmtMoney(d.hi, d.currency)}` : '—';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Quantra AI</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)} · Quantra AI">
<meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${esc(img)}"><meta property="og:url" content="${esc(base + '/s/' + id)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(img)}">
<style>body{margin:0;background:#0A0F1C;color:#E7ECF5;font-family:'Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:640px;margin:0 auto;padding:32px 20px 60px}.bar{height:6px;background:linear-gradient(100deg,#34D399,#22D3EE,#818CF8)}
.kick{color:#6B7890;font-size:13px;font-weight:700;letter-spacing:2px;margin:24px 0 6px}
h1{font-size:42px;margin:0}.name{color:#93A0B8;font-size:18px;margin-top:4px}
.card{background:#121A2E;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:22px;margin-top:22px;display:flex;gap:20px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.px{font-size:34px;font-weight:700}.trend{color:#93A0B8;font-size:15px;margin-top:4px}
.score{text-align:center;min-width:120px}.score .v{font-size:56px;font-weight:800;color:${scoreCol};line-height:1}.score .l{color:#6B7890;font-size:12px;font-weight:700;letter-spacing:1px}
.band{margin-top:18px}.band .l{color:#6B7890;font-size:13px;font-weight:700;letter-spacing:1px}.band .v{color:#22D3EE;font-size:24px;font-weight:700;margin-top:4px}
.cta{display:inline-block;margin-top:26px;background:linear-gradient(100deg,#34D399,#22D3EE);color:#06251c;font-weight:700;text-decoration:none;padding:14px 26px;border-radius:12px;font-size:16px}
.foot{color:#5A6680;font-size:12px;margin-top:22px;line-height:1.6}a.link{color:#22D3EE;text-decoration:none}</style></head>
<body><div class="bar"></div><div class="wrap">
<div class="kick">QUANTRA AI · SHARED ANALYSIS</div>
<h1>${esc(d.symbol)}</h1><div class="name">${esc(d.name || '')}</div>
<div class="card"><div><div class="px">${esc(fmtMoney(d.price, d.currency))}</div><div class="trend">${esc(d.trend || '')}</div></div>
<div class="score"><div class="v">${d.score == null ? '—' : d.score}</div><div class="l">${esc((d.grade || 'SCORE').toUpperCase())}</div></div></div>
<div class="band"><div class="l">PROJECTION RANGE${d.horizon ? ' · ' + esc(d.horizon) : ''}</div><div class="v">${esc(band)}</div></div>
<a class="cta" href="${base}/terminal.html?type=${encodeURIComponent(d.type || 'stock')}&symbol=${encodeURIComponent(d.symbol)}&name=${encodeURIComponent(d.name || d.symbol)}">Open the live analysis on Quantra →</a>
<div class="foot">Snapshot from ${new Date(d.ts).toLocaleString()}. Probabilistic analytics — <b>not a guarantee, not investment advice</b>. Quantra publicly grades every projection against reality: <a class="link" href="${base}/track-record.html">see the track record →</a></div>
</div></body></html>`;
}
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
  let bandIn = 0, bandTot = 0;   // overall projection-band calibration
  const horizons = TR_HORIZONS.map((H) => {
    let n = 0, hits = 0, directional = 0, sumRet = 0, bullN = 0, bullUp = 0, bearN = 0, bearDown = 0;
    let bIn = 0, bN = 0;
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
        // projection-band calibration: did the realised move land in the 80% band?
        if (it.sd > 0) {
          const w = BAND_Z * it.sd * Math.sqrt(H);
          const lo = Math.exp(-w) - 1, hi = Math.exp(w) - 1;
          bN++; bandTot++; if (ret >= lo && ret <= hi) { bIn++; bandIn++; }
        }
      }
    }
    return { horizon: H, samples: n, evaluated: directional, hitRate: directional ? hits / directional : null,
      avgReturn: n ? sumRet / n : null, bullUp: bullN ? bullUp / bullN : null, bearDown: bearN ? bearDown / bearN : null,
      bandN: bN, bandCoverage: bN ? bIn / bN : null };
  });
  const calibration = { target: 0.8, n: bandTot, coverage: bandTot ? bandIn / bandTot : null,
    perHorizon: horizons.map((h) => ({ horizon: h.horizon, n: h.bandN, coverage: h.bandCoverage })) };
  return { building: false, days: snaps.length, since: dates[0], latest: dates[dates.length - 1], samples: horizons.reduce((a, h) => a + h.samples, 0), horizons, calibration, integrity };
}
async function trackDevSeed() {
  const d30 = (() => { const x = new Date(); x.setDate(x.getDate() - 30); return x.toISOString().slice(0, 10); })();
  await writeSnapshot(d30, [
    { type: 'stock', symbol: 'AAA', score: 80, price: 100, sd: 0.02 }, { type: 'stock', symbol: 'BBB', score: 75, price: 100, sd: 0.02 },
    { type: 'stock', symbol: 'CCC', score: 30, price: 100, sd: 0.02 }, { type: 'stock', symbol: 'DDD', score: 35, price: 100, sd: 0.005 },
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

/* ============================================================
   Continuous self-diagnostics (vigilance). The app tests ITSELF in
   production every few minutes — feeds alive, prices sane, %s correct,
   forecast calibration in range, storage reachable, error-rate low —
   keeps a rolling health history and emails super-admins the moment
   anything fails. It REPORTS and ALERTS; it never auto-rewrites code.
   ============================================================ */
let healthLast = null, healthHistory = [], errCount = 0, lastHealthAlert = 0;
function noteError() { errCount++; }
function alertAdmins(result) {
  if (Date.now() - lastHealthAlert < 3600000) return; lastHealthAlert = Date.now();   // debounce: 1/hr
  const failsHtml = result.checks.filter((c) => !c.ok).map((c) => `• ${c.name}: ${c.detail}`).join('<br>');
  const failsTxt = result.checks.filter((c) => !c.ok).map((c) => c.name + ': ' + c.detail).join('\n');
  for (const email of SUPER_ADMINS) {
    sendMail(email, '⚠ Quantra self-check failed',
      shell('Self-check failed', `<p style="color:#cbd5e1">One or more live checks just failed on Quantra:</p><p style="color:#fb7185">${failsHtml}</p><p style="color:#8a94a6;font-size:12px">Open /admin → System health for detail.</p>`),
      'Quantra self-check failed:\n' + failsTxt).catch(() => {});
  }
}
let scBusy = false;
async function selfCheck() {
  if (scBusy) return healthLast; scBusy = true;
  const checks = [], add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: String(detail == null ? '' : detail) });
  try {
    try { const c = await api['crypto/markets']({ page: '1' }); add('crypto_feed', Array.isArray(c) && c.length > 0 && c.every((x) => x.price > 0), `${(c || []).length} coins live`); } catch (e) { add('crypto_feed', false, e.message); }
    try { const s = await api['stock/board']({}); add('stock_feed', Array.isArray(s) && s.length > 0, `${(s || []).length} symbols`); } catch (e) { add('stock_feed', false, e.message); }
    try { const p = await api['price']({ type: 'stock', id: 'AAPL', symbol: 'AAPL' }); add('price_sanity', p && p.price > 0 && Math.abs(p.change || 0) < 50, `AAPL ${p && p.price} · ${p && p.change}% · ${p && p.source}`); } catch (e) { add('price_sanity', false, e.message); }
    try { const tr = await trackRecord(); const cov = tr && tr.calibration && tr.calibration.coverage; add('forecast_calibration', !tr || tr.building || cov == null || (cov >= 0.5 && cov <= 0.98), cov != null ? `${(cov * 100).toFixed(0)}% band coverage` : 'building'); } catch (e) { add('forecast_calibration', false, e.message); }
    try { await store.allUsers(); add('storage', true, store.kind); } catch (e) { add('storage', false, e.message); }
    add('error_rate', errCount < 25, `${errCount} server errors since last check`);
  } catch (e) { add('selfcheck', false, e.message); }
  const ok = checks.every((c) => c.ok);
  healthLast = { ts: Date.now(), ok, checks, uptimeSec: Math.round(process.uptime()) };
  healthHistory.push({ ts: healthLast.ts, ok, fails: checks.filter((c) => !c.ok).map((c) => c.name) });
  if (healthHistory.length > 60) healthHistory.shift();
  errCount = 0; scBusy = false;
  if (!ok) { audit('selfcheck_fail', null, null, { fails: healthLast.checks.filter((c) => !c.ok) }); alertAdmins(healthLast); }
  return healthLast;
}

/* ============================================================
   Radar signals — pop-up + push alerts when an asset's MODELED
   odds of a +20% move (24h horizon) cross the alert line.
   Edge-triggered against the previous scan + 6h per-symbol
   cooldown so it never spams. Honest wording throughout:
   probabilities, not calls. Delivered to opt-in members only
   (prefs.radarAlerts) — in-app popups + web push if subscribed.
   ============================================================ */
const RADAR_ALERT_MIN = Math.max(5, Math.min(90, +(process.env.RADAR_ALERT_MIN || 25)));
let radarSignals = [];            // recent signals for the in-app popup feed
let radarPrev = null;             // previous scan (key → pUp20) for edge-triggering
const radarCooldown = new Map();  // key → last-signal ts
async function detectRadarSignals(items) {
  const cur = new Map();
  const fresh = [];
  for (const it of items) {
    const g = it.grid && it.grid['24h']; if (!g || g.u[20] == null) continue;
    const key = it.type + ':' + it.id, p = g.u[20];
    cur.set(key, p);
    if (radarPrev === null) continue;                          // first scan after boot: baseline only
    const was = radarPrev.get(key);
    const cooled = (radarCooldown.get(key) || 0) < Date.now() - 6 * 3600 * 1000;
    if (p >= RADAR_ALERT_MIN && (was == null || was < RADAR_ALERT_MIN) && cooled) {
      radarCooldown.set(key, Date.now());
      fresh.push({ ts: Date.now(), type: it.type, id: it.id, symbol: it.symbol, name: it.name,
        horizon: '24h', threshold: 20, p, pDown: g.d[20] ?? null, prev: was ?? null });
    }
  }
  radarPrev = cur;
  if (!fresh.length) return;
  radarSignals = [...fresh, ...radarSignals].slice(0, 30);
  // web push to opted-in members (cap 3 signals per scan to stay respectful)
  if (PUSH_ENABLED) {
    try {
      const users = await store.allUsers();
      for (const u of users.slice(0, 500)) {
        try {
          const d = await store.getUserData(u.id);
          if (!d || !d.prefs || !d.prefs.radarAlerts || !Array.isArray(d.pushSubs) || !d.pushSubs.length) continue;
          for (const s of fresh.slice(0, 3)) {
            await sendPush(d.pushSubs, {
              title: `🚀 ${s.symbol}: +20% odds now ${s.p}%`,
              body: `Modeled odds of a +20% move in 24h crossed ${RADAR_ALERT_MIN}% (downside −20%: ${s.pDown ?? '?'}%). Probability, not a call — not advice.`,
              tag: 'radar-' + s.symbol, url: '/terminal.html',
            });
          }
        } catch {}
      }
    } catch {}
  }
}

/* ============================================================
   Daily brief digest — one morning email to users who opted in
   (prefs.digestEmail, set on the Brief page). Sends in the
   07:00–08:59 UTC window, once per user per day (d.digestDay).
   ============================================================ */
let digestBusy = false;
async function sendDigests() {
  if (digestBusy || !mailConfig().ok) return;
  const hour = new Date().getUTCHours();
  if (hour < 7 || hour > 8) return;
  const today = new Date().toISOString().slice(0, 10);
  digestBusy = true;
  try {
    const users = await store.allUsers();
    for (const u of users.slice(0, 500)) {
      try {
        if (!u.verified) continue;
        const d = await store.getUserData(u.id);
        if (!d || !d.prefs || !d.prefs.digestEmail || d.digestDay === today) continue;
        const items = (d.watchlist || []).slice(0, 40);
        if (!items.length) continue;
        const affinity = (d.affinity || []).slice().sort((a, b) => (b.n || 0) - (a.n || 0)).slice(0, 4).map((a) => a.symbol);
        const br = await api['brief']({}, { items, affinity });
        if (!br || !br.ok || !br.text) continue;
        const movers = (br.rows || []).slice(0, 6).map((r) =>
          `<tr><td style="padding:4px 10px 4px 0"><b>${r.symbol}</b></td><td style="padding:4px 10px 4px 0">${r.price != null ? r.price : '—'}</td><td style="padding:4px 0;color:${r.change >= 0 ? '#0E9F6E' : '#E02424'}">${r.change != null ? (r.change >= 0 ? '+' : '') + r.change.toFixed(2) + '%' : '—'}</td></tr>`).join('');
        await sendMail(u.email, `☀ Your Quantra brief — ${br.date}`, shell('Your daily brief', `
          <p style="font-size:15px;line-height:1.6">${br.text}</p>
          ${movers ? `<table style="border-collapse:collapse;font-size:14px;margin:12px 0">${movers}</table>` : ''}
          ${btn(APP_URL + '/brief.html', 'Open the full brief')}
          <p style="color:#8A93A6;font-size:12px">You get this because you turned on the daily digest on your Brief page — untick it there any time. Not investment advice.</p>`));
        d.digestDay = today;
        await store.putUserData(u.id, d);
      } catch {}
    }
  } catch (e) { console.warn('[digest]', e.message); } finally { digestBusy = false; }
}

store.ready().then(() => {
  snapshotToday();
  setInterval(snapshotToday, 2 * 60 * 60 * 1000).unref(); // every 2h so the new day's snapshot lands promptly; no-ops if today is done
  metricsLoad();
  setInterval(metricsFlush, 120000).unref();              // persist footfall every 2 min
  hydrateAlerts();                                        // rebuild active-alert index from accounts
  setInterval(monitorAlerts, 60000).unref();             // check alert prices every 60s (fires + emails)
  setTimeout(selfCheck, 20000); setInterval(selfCheck, 12 * 60 * 1000).unref(); // self-diagnostics every 12 min
  sendDigests(); setInterval(sendDigests, 20 * 60 * 1000).unref();   // daily brief emails (07:00–08:59 UTC window, once/user/day)
  // movers radar: warm at boot + refresh on a timer so the sidebar is always instant
  setTimeout(() => api['movers/radar']().catch(() => {}), 30000);
  setInterval(() => { cache.delete('radar'); api['movers/radar']().catch(() => {}); }, 10 * 60 * 1000).unref();
  // prune expired sessions daily (30-day TTL rows otherwise accumulate forever)
  setInterval(() => { store.pruneSessions(Date.now()).then((n) => { if (n) console.log(`[sessions] pruned ${n} expired`); }).catch(() => {}); }, 24 * 60 * 60 * 1000).unref();
  setTimeout(() => { store.pruneSessions(Date.now()).catch(() => {}); }, 60000);
  // Keep-warm: free hosts sleep after ~15 min idle, so the first visit then takes
  // ~50s to wake. A self-ping every few minutes keeps it hot → the app loads in <1s.
  const SELF_URL = (process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '').replace(/\/$/, '');
  if (/^https:\/\//.test(SELF_URL) && typeof fetch === 'function') {
    setInterval(() => { fetch(SELF_URL + '/healthz').catch(() => {}); }, 10 * 60 * 1000).unref();
    console.log('[keepwarm] self-ping every 10m →', SELF_URL);
  }
  process.on('SIGTERM', () => { metricsFlush().finally(() => process.exit(0)); });
  http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    try { track(req, u); } catch {}            // footfall analytics (non-blocking)
    // HARD AUTH GATE: Quantra requires an account. Every data API needs a valid
    // session; only sign-in/up flows, health, the Stripe webhook, the feature-flag
    // config, and the public track-record transparency proof stay open.
    // Escape hatch for the operator: OPEN_ACCESS=true restores anonymous access.
    if (u.pathname.startsWith('/api/') && process.env.OPEN_ACCESS !== 'true') {
      const open = u.pathname.startsWith('/api/auth/') || u.pathname === '/api/billing/webhook'
        || u.pathname === '/api/config' || u.pathname.startsWith('/api/track-record') || u.pathname === '/api/status'
        || u.pathname.startsWith('/api/share/') || u.pathname.startsWith('/s/')   // public share cards
        || u.pathname.startsWith('/api/v1/');   // developer API (own key auth)
      if (!open) {
        const s = await sessionUser(req).catch(() => null);
        if (!s) return send(res, 401, { error: 'Sign in to use Quantra.', signin: true });
      }
    }
    // security headers on every response
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.sheetjs.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.coingecko.com https://open.er-api.com https://query1.finance.yahoo.com https://query2.finance.yahoo.com https://finnhub.io wss://ws-feed.exchange.coinbase.com wss://stream.binance.com:9443 wss://stream.binance.com; frame-ancestors 'self'; base-uri 'self'");
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // health checks
    if (u.pathname === '/healthz' || u.pathname === '/readyz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, storage: store.kind })); }
    // Public status — the self-diagnostics, read-only, no sensitive detail (names + pass/fail only)
    if (u.pathname === '/api/status') {
      const h = healthLast;
      const checks = (h && h.checks || []).map((c) => ({ name: c.name, ok: c.ok }));
      const recent = (healthHistory || []).slice(-30).map((r) => ({ ts: r.ts, ok: r.ok }));
      return send(res, 200, { ok: h ? h.ok : true, asOf: h ? h.ts : Date.now(), uptimeSec: Math.round(process.uptime()), checks, recent });
    }
    // public track record
    if (u.pathname === '/api/stream/trades' && req.method === 'GET') return tradeStream(req, res, u);
    if (u.pathname === '/api/track-record' && req.method === 'GET') { snapshotToday().catch(() => {}); return send(res, 200, await trackRecord()); }
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
    /* ---- shareable analysis snapshots (public growth loop) ----
       A signed-in user shares the current read; anyone can open the link (no account).
       Stored as a long-lived token so links survive restarts. Server-rendered HTML with
       OpenGraph tags so it previews in WhatsApp/Twitter/LinkedIn, + an SVG card image. */
    if (u.pathname === '/api/share' && req.method === 'POST') {
      const s = await sessionUser(req); if (!s) return send(res, 401, { error: 'Sign in to share.' });
      if (tooMany(res, 'sh:' + clientIp(req), 40, 3600000)) return;
      let body; try { body = await readBody(req); } catch { return send(res, 400, { error: 'bad body' }); }
      const snap = shareSnapshot(body);
      if (!snap) return send(res, 400, { error: 'nothing to share' });
      const id = crypto.randomBytes(7).toString('hex');
      await store.putToken('share:' + id, { type: 'share', data: snap, by: s.user.email, exp: Date.now() + 180 * 864e5 });
      return send(res, 200, { ok: true, id, url: reqBase(req) + '/s/' + id });
    }
    if (u.pathname.startsWith('/api/share/') && req.method === 'GET') {
      const id = u.pathname.split('/')[3] || '';
      const rec = await store.getToken('share:' + id.replace(/[^a-f0-9]/g, ''));
      if (!rec || rec.type !== 'share') return send(res, 404, { error: 'not found' });
      if (u.pathname.endsWith('/img.svg')) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
        return res.end(shareCardSvg(rec.data));
      }
      return send(res, 200, { ok: true, snapshot: rec.data });
    }
    if (u.pathname.startsWith('/s/') && req.method === 'GET') {
      const id = u.pathname.slice(3).replace(/[^a-f0-9]/g, '');
      const rec = await store.getToken('share:' + id);
      res.writeHead(rec && rec.type === 'share' ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      return res.end(sharePageHtml(rec && rec.type === 'share' ? rec.data : null, id, reqBase(req)));
    }
    /* ---- Developer API v1 (authenticated by the workspace API key) ----
       Key in `X-API-Key` header or `?key=`. Rate-limited per key. On-demand only. */
    if (u.pathname.startsWith('/api/v1/') && req.method === 'GET') {
      const key = req.headers['x-api-key'] || u.searchParams.get('key') || '';
      if (!/^qk_live_[a-f0-9]{32}$/.test(key)) return send(res, 401, { ok: false, error: 'Missing or malformed API key. Pass X-API-Key: qk_live_… (find it in your workspace settings).' });
      const org = await store.findOrgByApiKey(key);
      if (!org) return send(res, 401, { ok: false, error: 'Invalid API key.' });
      if (tooMany(res, 'apik:' + key, 120, 60000)) return;   // 120 req/min/key
      try {
        if (u.pathname === '/api/v1/price') {
          const sym = u.searchParams.get('symbol'); if (!sym) return send(res, 400, { ok: false, error: 'symbol required' });
          const p = await api['price']({ id: sym, symbol: sym, type: u.searchParams.get('type') || 'stock' });
          return send(res, 200, { ok: !!(p && p.ok !== false), symbol: sym, price: p && p.price, change: p && p.change, currency: (p && p.currency) || 'USD', source: p && p.source, asOf: (p && p.asOf) || Date.now() });
        }
        if (u.pathname === '/api/v1/movers') {
          const d = await api['movers/radar']();
          return send(res, 200, { ok: !!(d && d.ok), asOf: d && d.asOf, thresholds: d && d.thresholds, horizons: d && d.horizons, items: (d && d.items || []).map((it) => ({ type: it.type, symbol: it.symbol, price: it.price, odds: it.grid })) });
        }
        if (u.pathname === '/api/v1/track-record') return send(res, 200, await trackRecord());
        return send(res, 404, { ok: false, error: 'unknown endpoint', endpoints: ['/api/v1/price', '/api/v1/movers', '/api/v1/track-record'] });
      } catch (e) { return send(res, 502, { ok: false, error: String(e.message || e) }); }
    }
    if (u.pathname === '/api/billing/webhook') return billingWebhook(req, res);
    if (u.pathname.startsWith('/api/auth/') || u.pathname.startsWith('/api/admin/') || u.pathname.startsWith('/api/me/') || u.pathname === '/api/org' || u.pathname.startsWith('/api/org/') || u.pathname.startsWith('/api/ai/') || u.pathname.startsWith('/api/push/') || u.pathname === '/api/brief' || u.pathname.startsWith('/api/community/') || u.pathname.startsWith('/api/billing/') || u.pathname.startsWith('/api/broker/')) {
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
