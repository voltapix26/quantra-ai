/* ============================================================
   Quantra AI Terminal — UI controller
   ============================================================ */
(function () {
  'use strict';
  const Q = window.Quantra, R = window.QuantraReport;
  const onServer = location.protocol === 'http:' || location.protocol === 'https:';
  const API = '/api', CG = 'https://api.coingecko.com/api/v3';
  const $ = (id) => document.getElementById(id);

  let assetClass = 'crypto';
  let board = [];
  let current = null;          // selected board item {id,type,symbol,name}
  let state = null;            // full render state for reports
  let aiToken = 0;             // guards stale async AI responses
  let live = { cryptoStream: false, finnhub: false };  // available live sources
  let arrWS = null, tradeWS = null, quoteTimer = null, coinSubs = null;  // crypto board stream, selected-coin stream, stock poll, subscribed products
  let stockES = null, stockWatch = null;  // stock/ETF tick stream (SSE) + fallback watchdog

  // ---- currency conversion ----
  let fxRates = { USD: 1 };
  let selCur = 'USD';
  let curBase = 'USD';         // native currency of the selected asset's prices
  const CUR_SYM = { USD: '$', INR: '₹', AED: 'AED ', EUR: '€', GBP: '£', JPY: '¥', CNY: 'CN¥', CAD: 'C$', AUD: 'A$', SGD: 'S$', HKD: 'HK$', CHF: 'CHF ',
    BRL: 'R$', MXN: 'Mex$', SEK: 'kr ', NOK: 'kr ', DKK: 'kr ', KRW: '₩', TWD: 'NT$', IDR: 'Rp ', THB: '฿', MYR: 'RM ', SAR: 'SR ', ZAR: 'R ', NZD: 'NZ$' };
  // Some exchanges quote in a minor unit (London = pence GBp, Johannesburg = cents ZAc);
  // normalise to the major unit so FX conversion is correct.
  const MINOR = { GBp: ['GBP', 100], ZAc: ['ZAR', 100], ILA: ['ILS', 100] };
  let stockMarket = 'us';      // selected stock exchange
  let stockMarkets = [{ id: 'us', label: 'United States', ccy: 'USD' }];   // populated from server
  try { const m = localStorage.getItem('quantra.market'); if (m) stockMarket = m; } catch {}
  const fxRate = (c) => fxRates[c] || 1;
  const conv = (amt, base) => {
    if (amt == null || isNaN(amt)) return null;
    let b = base || 'USD', f = 1;
    if (MINOR[b]) { f = MINOR[b][1]; b = MINOR[b][0]; }
    return (amt / f) * fxRate(selCur) / fxRate(b);
  };
  const curSym = () => CUR_SYM[selCur] || selCur + ' ';
  let idxMode = false;   // true while viewing an index → show raw points (no FX, indices aren't a currency)
  function money(amt, base) {
    if (idxMode) { if (amt == null || isNaN(amt)) return '—'; const a = Math.abs(amt), d = a >= 1000 ? 2 : a >= 1 ? 2 : 4; return Number(amt).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d }); }
    const v = conv(amt, base); if (v == null) return '—';
    const a = Math.abs(v), d = a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
    return curSym() + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
  }
  const signedMoney = (v, base) => { if (v == null || isNaN(v)) return ''; return (v >= 0 ? '+' : '−') + money(Math.abs(v), base); };
  function capMoney(amt, base) {
    const v = conv(amt, base); if (v == null) return '—'; const s = curSym();
    return v >= 1e12 ? s + (v / 1e12).toFixed(2) + 'T' : v >= 1e9 ? s + (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? s + (v / 1e6).toFixed(1) + 'M' : s + Math.round(v).toLocaleString();
  }
  async function loadFX() {
    try {
      const url = onServer ? `${API}/fx` : 'https://open.er-api.com/v6/latest/USD';
      const d = await getJSON(url);
      if (d && d.rates) fxRates = d.rates;
    } catch { /* keep USD-only */ }
  }

  async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }

  /* ---------------- data ---------------- */
  const BOARD_EP = { stock: 'stock/board', etf: 'etf/board', commodity: 'commodity/board', index: 'index/board', fx: 'fx/board' };
  async function loadBoard(cls) {
    if (cls === 'crypto') {
      if (onServer) return getJSON(`${API}/crypto/markets?page=1`);
      const raw = await getJSON(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=true&price_change_percentage=24h`);
      return raw.map((c) => ({ type: 'crypto', id: c.id, symbol: (c.symbol || '').toUpperCase(), name: c.name, price: c.current_price, change24h: c.price_change_percentage_24h, marketCap: c.market_cap, volume: c.total_volume, spark: (c.sparkline_in_7d && c.sparkline_in_7d.price) || [] }));
    }
    if (cls === 'foryou') {   // personalized: the assets this user opens most
      if (!onServer || !signedIn()) return [];
      const t = window.QuantraAuth && window.QuantraAuth.token;
      const r = await fetch(`${API}/me/foryou`, { headers: t ? { Authorization: 'Bearer ' + t } : {}, credentials: 'same-origin' });
      if (!r.ok) return [];
      const f = await r.json();
      return (f.watched || []).map((w) => ({ type: w.type, id: w.id, symbol: w.symbol, name: w.name, price: w.price, change24h: w.change, currency: w.currency, spark: [] }));
    }
    if (!onServer) throw new Error('static');
    const q = cls === 'stock' ? `?market=${encodeURIComponent(stockMarket)}` : '';
    return getJSON(`${API}/${BOARD_EP[cls] || 'stock/board'}${q}`);
  }
  function updateForYouTab() { const b = document.getElementById('segForYou'); if (b) b.hidden = !signedIn(); }
  // valid lookback ranges per interval (keeps Yahoo combos legal) + defaults
  const RANGES = {
    'sec': [['1m', '1m'], ['5m', '5m'], ['15m', '15m']],     // live tick window (crypto)
    '1m':  [['1d', '1D'], ['5d', '5D']],
    '60m': [['5d', '5D'], ['1mo', '1M'], ['3mo', '3M'], ['6mo', '6M']],
    '1d':  [['1mo', '1M'], ['6mo', '6M'], ['1y', '1Y'], ['2y', '2Y'], ['5y', '5Y']],
    '1wk': [['6mo', '6M'], ['1y', '1Y'], ['5y', '5Y'], ['max', 'Max']],
  };
  const DEFAULT_RANGE = { 'sec': '5m', '1m': '1d', '60m': '1mo', '1d': '6mo', '1wk': '1y' };
  const secWindowMs = (r) => ({ '1m': 60000, '5m': 300000, '15m': 900000 }[r] || 300000);
  function rangeToDays(range) { return { '1d': 2, '5d': 7, '1mo': 30, '3mo': 90, '6mo': 180, '1y': 365, '2y': 730, '5y': 1825, 'max': 'max' }[range] || 180; }
  function cryptoDays(interval, range) {
    if (interval === '1m') return 1;                       // ~5-min candles (today)
    if (interval === '60m') { const d = rangeToDays(range); return Math.min(d === 'max' ? 90 : d, 90); } // hourly up to 90d
    return rangeToDays(range);                             // daily / weekly
  }
  async function loadChart(item, range, interval) {
    if (item.type === 'crypto') {
      const days = cryptoDays(interval, range);
      if (onServer) return getJSON(`${API}/crypto/chart?id=${item.id}&days=${days}`);
      const d = await getJSON(`${CG}/coins/${item.id}/market_chart?vs_currency=usd&days=${days}`);
      const closes = (d.prices || []).map((p) => p[1]), dates = (d.prices || []).map((p) => new Date(p[0]).toISOString());
      return { symbol: item.symbol, closes, highs: closes, lows: closes, dates };
    }
    return getJSON(`${API}/stock/chart?symbol=${encodeURIComponent(item.id)}&range=${range}&interval=${interval}`);
  }
  async function loadFundamentals(item) {
    if (item.type !== 'stock' || !onServer) return null;
    try { return await getJSON(`${API}/stock/fundamentals?symbol=${item.id}`); } catch { return null; }
  }
  async function loadPeers(item) {
    if (item.type !== 'stock' || !onServer) return [];
    try { return await getJSON(`${API}/stock/peers?symbol=${item.id}`); } catch { return []; }
  }
  async function loadNews(item) {
    if (!onServer) return [];
    const sym = item.type === 'crypto' ? item.symbol : item.id;
    if (live.finnhub) { try { const n = await getJSON(`${API}/news/live?symbol=${encodeURIComponent(sym)}`); if (n && n.length) return n; } catch {} }
    try { return await getJSON(`${API}/stock/news?symbol=${encodeURIComponent(sym)}`); } catch { return []; }
  }
  async function reasonAI(payload) {
    if (!onServer) return { ok: false, reason: 'static' };
    try {
      const r = await fetch(`${API}/ai/reason`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return await r.json();
    } catch (e) { return { ok: false, reason: String(e) }; }
  }
  async function doSearch(term) {
    if (assetClass === 'crypto') {
      if (!onServer) { const d = await getJSON(`${CG}/search?query=${encodeURIComponent(term)}`); return (d.coins || []).slice(0, 12).map((c) => ({ type: 'crypto', id: c.id, symbol: (c.symbol || '').toUpperCase(), name: c.name })); }
      return getJSON(`${API}/crypto/search?q=${encodeURIComponent(term)}`);
    }
    return getJSON(`${API}/stock/search?q=${encodeURIComponent(term)}`);
  }

  /* ---------------- board render ---------------- */
  const fmtP = (p, base) => money(p, base);
  function sparkSVG(data, up) {
    if (!data || data.length < 2) return '';
    const w = 66, h = 22, color = up ? '#34D399' : '#FB7185', min = Math.min(...data), max = Math.max(...data), rng = max - min || 1, step = w / (data.length - 1);
    const d = data.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${(h - ((v - min) / rng) * (h - 4) - 2).toFixed(1)}`).join(' ');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
  }
  function rowDot(it) {
    const st = mktState(it.type, it.tp, it.mktOpen, it.holiday);
    if (!st) return '';
    return `<span class="mkt-dot ${st.open ? 'open' : 'closed'}" title="${st.open ? 'Market open' : (it.holiday ? 'Closed · ' + it.holiday : 'Market closed')}"></span>`;
  }
  // Re-evaluate open/closed for every board dot + the detail badge against the clock,
  // so they flip live the moment a session opens or closes (no full reload needed).
  function tickMarketStatus() {
    const list = $('list');
    if (list) board.forEach((b) => {
      const dot = list.querySelector('.trow[data-id="' + (b.id || '').replace(/"/g, '') + '"] .mkt-dot');
      if (!dot) return;
      const st = mktState(b.type, b.tp, b.mktOpen, b.holiday);
      if (!st) return;
      dot.className = 'mkt-dot ' + (st.open ? 'open' : 'closed'); dot.title = st.open ? 'Market open' : (b.holiday ? 'Closed · ' + b.holiday : 'Market closed');
    });
    if (current && state && state.history) renderDetailBadge();
  }
  function rowHTML(it) {
    const up = (it.change24h || 0) >= 0, chg = it.change24h == null ? '—' : `${up ? '+' : ''}${it.change24h.toFixed(2)}%`;
    return `<button class="trow" data-id="${it.id}" data-type="${it.type}" data-symbol="${it.symbol}" data-name="${(it.name || '').replace(/"/g, '')}">
      <span class="trow__name"><b>${rowDot(it)}${it.symbol}</b><small>${it.name || ''}</small></span>
      <span class="trow__price">${money(it.price, it.currency)}</span>
      <span class="trow__chg ${up ? 'up' : 'down'}">${chg}</span>
      <span class="trow__spark">${sparkSVG(it.spark, up)}</span></button>`;
  }
  function renderBoard() {
    const list = $('list'), empty = $('empty');
    idxMode = (assetClass === 'index');   // indices show raw points, not FX-converted
    if (!board.length) { empty.textContent = 'No data.'; return; }
    list.innerHTML = board.map(rowHTML).join('');
    list.querySelectorAll('.trow').forEach((r) => r.addEventListener('click', () => select({ id: r.dataset.id, type: r.dataset.type, symbol: r.dataset.symbol, name: r.dataset.name })));
  }
  async function switchClass(cls) {
    assetClass = cls;
    document.querySelectorAll('.seg__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.class === cls));
    const ms = $('marketSel'); if (ms) { ms.hidden = (cls !== 'stock'); if (cls === 'stock') ms.value = stockMarket; }
    if (cls === 'stock' && typeof applyCurrency === 'function') { const mk = stockMarkets.find((m) => m.id === stockMarket); if (mk) applyCurrency(mk.ccy, false); }
    $('search').value = ''; $('results').hidden = true;
    $('list').innerHTML = '<div class="tempty" id="empty">Loading live markets…</div>';
    try { board = await loadBoard(cls); renderBoard(); (cls === 'crypto' ? startArr() : stopArr());
      if (cls === 'foryou' && !board.length) { const em = $('empty'); if (em) em.textContent = 'Open a few assets and they’ll appear here — Quantra learns what you follow.'; }
      if (board[0]) select(board[0]); }
    catch (e) {
      const empty = $('empty');
      if (cls === 'stock' && !onServer) empty.innerHTML = 'Stocks need the live server.<br>Run <code>node server.js</code> then open <b>localhost:5280</b>';
      else empty.textContent = 'Could not reach the market feed. Retry shortly.';
    }
  }

  /* ---------------- search ---------------- */
  let searchTimer;
  $('search').addEventListener('input', () => {
    const term = $('search').value.trim(); clearTimeout(searchTimer);
    if (term.length < 2) { $('results').hidden = true; return; }
    searchTimer = setTimeout(async () => {
      try {
        const hits = await doSearch(term); const res = $('results');
        if (!hits.length) { res.hidden = true; return; }
        res.innerHTML = hits.map((h) => `<button class="sres" data-id="${h.id}" data-type="${h.type}" data-symbol="${h.symbol}" data-name="${(h.name || '').replace(/"/g, '')}"><b>${h.symbol}</b><span>${h.name || ''}</span></button>`).join('');
        res.hidden = false;
        res.querySelectorAll('.sres').forEach((b) => b.addEventListener('click', () => { res.hidden = true; $('search').value = b.dataset.symbol; select({ id: b.dataset.id, type: b.dataset.type, symbol: b.dataset.symbol, name: b.dataset.name }); }));
      } catch { $('results').hidden = true; }
    }, 280);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) $('results').hidden = true; });

  /* ---------------- chart (price + SMAs + forecast) ---------------- */
  const W = 720, PAD = 8;
  let H = 240, enlarged = false;
  try { enlarged = localStorage.getItem('quantra.enlarge') === '1'; if (enlarged) H = 480; } catch {}
  let chartState = null;   // {total, histLen, vals, dates, fcMid, yAt} for hover tooltip
  let chartType = 'line';  // 'line' | 'candle'
  try { const ct = localStorage.getItem('quantra.charttype'); if (ct === 'candle' || ct === 'line') chartType = ct; } catch {}
  let studyBB = false, studyMcg = false, studyEma = false, studySar = false, studyVwap = false, studyDon = false, studyKelt = false, studyIchi = false, studySuper = false;   // price-overlay studies
  try { const g = (k) => localStorage.getItem('quantra.' + k) === '1'; studyBB = g('bb'); studyMcg = g('mcg'); studyEma = g('ema'); studySar = g('sar'); studyVwap = g('vwap'); studyDon = g('don'); studyKelt = g('kelt'); studyIchi = g('ichi'); studySuper = g('super'); } catch {}
  let candleHist = null;   // OHLC source for the candle view (crypto: Binance; else: hist)
  let tickMode = false, tickBuf = [], tickTimer = null, tickWinMs = 300000;  // live seconds chart

  function drawChart(hist, fc) {
    renderLegend();
    const ohlc = candleHist || hist;
    const hasOHLC = ohlc && ohlc.opens && ohlc.highs && ohlc.lows && ohlc.opens.length === ohlc.closes.length
      && ohlc.highs.some((h, i) => h > ohlc.lows[i]);   // real OHLC (not degenerate)
    if ((chartType === 'candle' || chartType === 'heikin') && hasOHLC) return drawCandles(chartType === 'heikin' ? heikinAshi(ohlc) : ohlc, fc);
    return drawLine(hist, fc, chartType === 'area');
  }
  // Dynamic legend: shows only the overlays currently switched on, with their colours.
  function renderLegend() {
    const el = $('legend'); if (!el) return;
    const it = (c, n, dim) => `<span><i style="background:${c}${dim ? ';opacity:.55' : ''}"></i>${n}</span>`;
    let h = it('#34D399', 'Price') + it('#818CF8', 'SMA 20') + it('#FBBF24', 'SMA 50');
    if (studyBB) h += it('#22D3EE', 'Bollinger');
    if (studyEma) h += it('#2DD4BF', 'EMA 21');
    if (studyMcg) h += it('#EC4899', 'McGinley');
    if (studyVwap) h += it('#FBBF24', 'VWAP');
    if (studyKelt) h += it('#F59E0B', 'Keltner');
    if (studyDon) h += it('#A78BFA', 'Donchian');
    if (studyIchi) h += it('#818CF8', 'Ichimoku');
    if (studySar) h += it('#34D399', 'PSAR');
    if (studySuper) h += it('#34D399', 'Supertrend');
    h += it('#22D3EE', 'Forecast', true);
    el.innerHTML = h;
  }
  function setEnlarged(on) {
    enlarged = on; H = on ? 480 : 240;
    try { localStorage.setItem('quantra.enlarge', on ? '1' : '0'); } catch {}
    const chart = $('chart'); if (chart) chart.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const term = document.querySelector('.term'); if (term) term.classList.toggle('is-enlarged', on);
    const btn = $('chartBig'); if (btn) { btn.classList.toggle('is-on', on); btn.textContent = on ? '⤡ Shrink' : '⤢ Enlarge'; }
    if (replay.on) drawReplay(); else if (current && state) { redrawChart(); drawPanes(state.history); }
  }
  // Is the asset's exchange open right now? Uses Yahoo's per-exchange session window.
  // tp from Yahoo meta → [sessionStart, sessionEnd, gmtoffset]. Yahoo's range=1d window
  // can be a day stale, so we use the session TIME-OF-DAY against today, not the literal date.
  function tpFromMeta(meta) {
    const cr = meta && meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
    if (!cr) return null;
    return [cr.start, cr.end, cr.gmtoffset != null ? cr.gmtoffset : (meta.gmtoffset || 0)];
  }
  // Robust open/closed + countdown, computed in the exchange's local time-of-day so it's
  // immune to Yahoo's stale dates. Returns { open, label, cls, cd }.
  // Time-of-day session state from tp=[start,end,gmtoffset] (in exchange-local time).
  function tpState(tp) {
    if (!tp || tp.length < 2) return null;
    const DAY = 86400, off = tp[2] || 0, mod = (a, n) => ((a % n) + n) % n;
    const startTod = mod(tp[0] + off, DAY), endTod = mod(tp[1] + off, DAY);
    const localNow = Date.now() / 1000 + off, dow = new Date(localNow * 1000).getUTCDay(), weekday = dow >= 1 && dow <= 5;
    const localToday = Math.floor(localNow / DAY) * DAY, todStart = localToday + startTod, todEnd = localToday + endTod;
    const fmt = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h >= 24 ? Math.round(h / 24) + 'd ' + (h % 24) + 'h' : h > 0 ? h + 'h ' + m + 'm' : m + 'm'; };
    const open = weekday && localNow >= todStart && localNow < todEnd;
    let next = todStart; if (weekday && localNow < todStart) { /* opens today */ } else { next = todStart + DAY; let nd = new Date(next * 1000).getUTCDay(); while (nd === 0 || nd === 6) { next += DAY; nd = new Date(next * 1000).getUTCDay(); } }
    return { open, cdOpen: 'closes in ' + fmt(todEnd - localNow), cdClosed: 'opens in ' + fmt(next - localNow) };
  }
  // Open/closed incl. holidays: authoritative `mktOpen` (US Finnhub) + `holiday` override
  // win; otherwise fall back to the time-of-day session window. Returns {open,label,cls,cd}.
  function mktState(type, tp, mktOpen, holiday) {
    if (type === 'crypto') return { open: true, label: 'Open · 24/7', cls: 'open', cd: '' };
    if (type === 'fx') { const d = new Date(), dw = d.getUTCDay(), h = d.getUTCHours(); const open = !((dw === 6) || (dw === 0 && h < 22) || (dw === 5 && h >= 22)); return { open, label: open ? 'Open · 24/5' : 'Closed', cls: open ? 'open' : 'closed', cd: '' }; }
    const base = tpState(tp);
    if (holiday) return { open: false, label: 'Closed · ' + holiday, cls: 'closed', cd: base ? base.cdClosed : '' };
    if (typeof mktOpen === 'boolean') return { open: mktOpen, label: mktOpen ? 'Market open' : 'Market closed', cls: mktOpen ? 'open' : 'closed', cd: base ? (mktOpen ? base.cdOpen : base.cdClosed) : '' };
    if (!base) return null;
    return { open: base.open, label: base.open ? 'Market open' : 'Market closed', cls: base.open ? 'open' : 'closed', cd: base.open ? base.cdOpen : base.cdClosed };
  }
  function renderDetailBadge() {
    const mk = $('dMkt'); if (!mk || !current) return;
    const bi = board.find((b) => b.id === current.id) || {};
    const tp = bi.tp || tpFromMeta(state && state.history && state.history.meta);
    const st = mktState(current.type, tp, bi.mktOpen, bi.holiday);
    if (!st) { mk.hidden = true; return; }
    mk.textContent = st.label + (st.cd ? ' · ' + st.cd : '');
    mk.className = 'dmkt ' + st.cls; mk.hidden = false;
  }
  // Heikin Ashi: smoothed OHLC that filters noise (a TradingView staple).
  function heikinAshi(o) {
    const O = o.opens, H = o.highs, L = o.lows, C = o.closes, ho = [], hh = [], hl = [], hc = [];
    for (let i = 0; i < C.length; i++) {
      const close = (O[i] + H[i] + L[i] + C[i]) / 4;
      const open = i === 0 ? (O[i] + C[i]) / 2 : (ho[i - 1] + hc[i - 1]) / 2;
      ho.push(open); hc.push(close); hh.push(Math.max(H[i], open, close)); hl.push(Math.min(L[i], open, close));
    }
    return Object.assign({}, o, { opens: ho, highs: hh, lows: hl, closes: hc });
  }
  // EMA array + MACD series (for the MACD pane).
  function emaArr(arr, n) { const k = 2 / (n + 1); const out = []; let prev; for (let i = 0; i < arr.length; i++) { prev = i === 0 ? arr[i] : arr[i] * k + prev * (1 - k); out.push(prev); } return out; }
  function macdSeries(closes) { const f = emaArr(closes, 12), s = emaArr(closes, 26); const macd = closes.map((_, i) => f[i] - s[i]); const signal = emaArr(macd, 9); return { macd, signal, hist: macd.map((v, i) => v - signal[i]) }; }
  // McGinley Dynamic — an adaptive moving average that speeds up/slows down with the
  // market, hugging price more smoothly than an EMA and reducing whipsaw.
  function mcginley(closes, n) {
    const out = new Array(closes.length); let md = closes[0];
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i];
      if (i === 0) md = c;
      else { const r = c / (md || c); md = md + (c - md) / Math.max(1e-9, n * Math.pow(r, 4)); }
      out[i] = md;
    }
    return out;
  }
  // Parabolic SAR (Wilder) — trailing stop-and-reverse dots above/below price.
  function psar(highs, lows, step, max) {
    step = step || 0.02; max = max || 0.2;
    const n = highs.length, out = new Array(n).fill(null);
    if (n < 2) return out;
    let bull = highs[1] >= highs[0], af = step, ep = bull ? highs[0] : lows[0], sar = bull ? lows[0] : highs[0];
    for (let i = 1; i < n; i++) {
      sar = sar + af * (ep - sar);
      if (bull) {
        sar = Math.min(sar, lows[i - 1], i >= 2 ? lows[i - 2] : lows[i - 1]);
        if (lows[i] < sar) { bull = false; sar = ep; ep = lows[i]; af = step; }
        else if (highs[i] > ep) { ep = highs[i]; af = Math.min(max, af + step); }
      } else {
        sar = Math.max(sar, highs[i - 1], i >= 2 ? highs[i - 2] : highs[i - 1]);
        if (highs[i] > sar) { bull = true; sar = ep; ep = highs[i]; af = step; }
        else if (lows[i] < ep) { ep = lows[i]; af = Math.min(max, af + step); }
      }
      out[i] = sar;
    }
    out[0] = out[1];
    return out;
  }
  // --- more studies (verified) ---
  function atrSeries(H, L, C, n) { const tr = []; for (let i = 0; i < C.length; i++) tr.push(i === 0 ? H[i] - L[i] : Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]))); return emaArr(tr, n); }
  function donchian(H, L, n) { const up = [], lo = []; for (let i = 0; i < H.length; i++) { if (i < n - 1) { up.push(null); lo.push(null); continue; } let hh = -Infinity, ll = Infinity; for (let j = i - n + 1; j <= i; j++) { if (H[j] > hh) hh = H[j]; if (L[j] < ll) ll = L[j]; } up.push(hh); lo.push(ll); } return { up, lo }; }
  function keltner(C, H, L) { const e = emaArr(C, 20), a = atrSeries(H, L, C, 10); return { up: C.map((_, i) => e[i] + 2 * a[i]), lo: C.map((_, i) => e[i] - 2 * a[i]) }; }
  function vwapArr(H, L, C, V) { let pv = 0, vv = 0; const o = []; for (let i = 0; i < C.length; i++) { const tp = (H[i] + L[i] + C[i]) / 3, v = V[i] || 0; pv += tp * v; vv += v; o.push(vv > 0 ? pv / vv : null); } return o; }
  function ichimoku(H, L) { const mid = (p) => { const o = []; for (let i = 0; i < H.length; i++) { if (i < p - 1) { o.push(null); continue; } let hh = -Infinity, ll = Infinity; for (let j = i - p + 1; j <= i; j++) { if (H[j] > hh) hh = H[j]; if (L[j] < ll) ll = L[j]; } o.push((hh + ll) / 2); } return o; }; const t = mid(9), k = mid(26), b = mid(52); const a = t.map((v, i) => (v != null && k[i] != null) ? (v + k[i]) / 2 : null); return { tenkan: t, kijun: k, spanA: a, spanB: b }; }
  function supertrend(H, L, C, period, mult) { const n = C.length, atr = atrSeries(H, L, C, period); const up = [], lo = [], st = new Array(n).fill(null), tr = new Array(n).fill(1); for (let i = 0; i < n; i++) { const hl = (H[i] + L[i]) / 2, ub = hl + mult * atr[i], lb = hl - mult * atr[i]; up[i] = (i === 0) ? ub : ((ub < up[i - 1] || C[i - 1] > up[i - 1]) ? ub : up[i - 1]); lo[i] = (i === 0) ? lb : ((lb > lo[i - 1] || C[i - 1] < lo[i - 1]) ? lb : lo[i - 1]); if (i === 0) { tr[i] = 1; st[i] = lo[i]; continue; } if (st[i - 1] === up[i - 1]) tr[i] = C[i] > up[i] ? 1 : -1; else tr[i] = C[i] < lo[i] ? -1 : 1; st[i] = tr[i] === 1 ? lo[i] : up[i]; } return { st, trend: tr }; }
  function williamsR(H, L, C, n) { const o = []; for (let i = 0; i < C.length; i++) { if (i < n - 1) { o.push(null); continue; } let hh = -Infinity, ll = Infinity; for (let j = i - n + 1; j <= i; j++) { if (H[j] > hh) hh = H[j]; if (L[j] < ll) ll = L[j]; } o.push(hh > ll ? -100 * (hh - C[i]) / (hh - ll) : -50); } return o; }
  function cciSeries(H, L, C, n) { const o = []; for (let i = 0; i < C.length; i++) { if (i < n - 1) { o.push(null); continue; } const tp = []; for (let j = i - n + 1; j <= i; j++) tp.push((H[j] + L[j] + C[j]) / 3); const sma = tp.reduce((a, b) => a + b, 0) / n; const md = tp.reduce((a, b) => a + Math.abs(b - sma), 0) / n; const cur = (H[i] + L[i] + C[i]) / 3; o.push(md ? (cur - sma) / (0.015 * md) : 0); } return o; }
  function adxSeries(H, L, C, n) { const tr = [], pdm = [], mdm = []; for (let i = 1; i < C.length; i++) { const up = H[i] - H[i - 1], dn = L[i - 1] - L[i]; pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0); tr.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]))); } const atr = emaArr(tr, n), pe = emaArr(pdm, n), me = emaArr(mdm, n), dx = []; for (let i = 0; i < atr.length; i++) { const pdi = 100 * pe[i] / (atr[i] || 1), mdi = 100 * me[i] / (atr[i] || 1); dx.push(100 * Math.abs(pdi - mdi) / ((pdi + mdi) || 1)); } const adx = emaArr(dx, n); return [null].concat(adx.map((v) => Math.max(0, Math.min(100, v)))); }

  // Shared price-overlay SVG used by BOTH the line/area and candle views, so every
  // study renders on either chart type. Coordinates come from the caller's x()/y().
  function studyOverlaySVG(closes, highs, lows, volumes, start, x, y, prices) {
    const lineFrom = (arr) => { let st = false; return arr.map((v, i) => { if (v == null) { st = false; return ''; } const c = st ? 'L' : 'M'; st = true; return `${c}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; }).join(' '); };
    const band = (up, lo) => { const fwd = [], rev = []; up.forEach((v, i) => { if (v != null && lo[i] != null) fwd.push(`${fwd.length ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`); }); for (let i = lo.length - 1; i >= 0; i--) { if (lo[i] != null && up[i] != null) rev.push(`L${x(i).toFixed(1)} ${y(lo[i]).toFixed(1)}`); } return fwd.length ? fwd.join(' ') + ' ' + rev.join(' ') + ' Z' : ''; };
    const s = Q.series(closes);
    const ohlc = highs && lows && highs.length === closes.length && lows.length === closes.length;
    let o = '';
    if (studyBB) { const per = 20, up = [], lo = []; for (let i = 0; i < closes.length; i++) { const m = s.sma20[i]; if (i < per - 1 || m == null) { up.push(null); lo.push(null); continue; } let sum = 0; for (let j = i - per + 1; j <= i; j++) sum += (closes[j] - m) ** 2; const sd = Math.sqrt(sum / per); up.push(m + 2 * sd); lo.push(m - 2 * sd); } const u = up.slice(start), l = lo.slice(start); const f = band(u, l); if (f) o += `<path d="${f}" fill="#22D3EE" opacity=".06"/>`; o += `<path d="${lineFrom(u)}" fill="none" stroke="#22D3EE" stroke-width="1.1" opacity=".55" stroke-dasharray="4 3"/><path d="${lineFrom(l)}" fill="none" stroke="#22D3EE" stroke-width="1.1" opacity=".55" stroke-dasharray="4 3"/>`; }
    if (studyDon && ohlc) { const d = donchian(highs, lows, 20); o += `<path d="${lineFrom(d.up.slice(start))}" fill="none" stroke="#A78BFA" stroke-width="1" opacity=".5"/><path d="${lineFrom(d.lo.slice(start))}" fill="none" stroke="#A78BFA" stroke-width="1" opacity=".5"/>`; }
    if (studyKelt && ohlc) { const k = keltner(closes, highs, lows); o += `<path d="${lineFrom(k.up.slice(start))}" fill="none" stroke="#F59E0B" stroke-width="1" opacity=".5" stroke-dasharray="3 3"/><path d="${lineFrom(k.lo.slice(start))}" fill="none" stroke="#F59E0B" stroke-width="1" opacity=".5" stroke-dasharray="3 3"/>`; }
    if (studyIchi && ohlc) { const ic = ichimoku(highs, lows); const f = band(ic.spanA.slice(start), ic.spanB.slice(start)); if (f) o += `<path d="${f}" fill="#818CF8" opacity=".10"/>`; o += `<path d="${lineFrom(ic.tenkan.slice(start))}" fill="none" stroke="#22D3EE" stroke-width="1" opacity=".75"/><path d="${lineFrom(ic.kijun.slice(start))}" fill="none" stroke="#FB7185" stroke-width="1" opacity=".75"/>`; }
    if (studyVwap && ohlc && volumes && volumes.length === closes.length) { o += `<path d="${lineFrom(vwapArr(highs, lows, closes, volumes).slice(start))}" fill="none" stroke="#FBBF24" stroke-width="1.3" opacity=".8"/>`; }
    if (studySuper && ohlc) { const su = supertrend(highs, lows, closes, 10, 3).st.slice(start); o += su.map((v, i) => v == null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.3" fill="${prices[i] >= v ? '#34D399' : '#FB7185'}"/>`).join(''); }
    if (studyEma) o += `<path d="${lineFrom(emaArr(closes, 21).slice(start))}" fill="none" stroke="#2DD4BF" stroke-width="1.4" opacity=".85" stroke-dasharray="2 2"/>`;
    if (studyMcg) o += `<path d="${lineFrom(mcginley(closes, 14).slice(start))}" fill="none" stroke="#EC4899" stroke-width="1.6" opacity=".92"/>`;
    if (studySar && ohlc) { const sar = psar(highs, lows).slice(start); o += sar.map((v, i) => v == null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.5" fill="${prices[i] >= v ? '#34D399' : '#FB7185'}"/>`).join(''); }
    return o;
  }

  function drawLine(hist, fc, areaOnly) {
    const svg = $('chart');
    const closes = hist.closes, s = Q.series(closes);
    const dates = hist.dates || [];
    const view = Math.min(closes.length, 160), start = closes.length - view;
    const histSlice = closes.slice(start);
    const histDates = dates.slice(start);
    const fcMid = fc ? fc.mid : [], fcHi = fc ? fc.hi : [], fcLo = fc ? fc.lo : [];
    const all = histSlice.concat(fcHi, fcLo);
    const min = Math.min(...all), max = Math.max(...all), rng = max - min || 1;
    const total = histSlice.length + fcMid.length;
    const x = (i) => PAD + (i / (total - 1)) * (W - PAD * 2);
    const y = (v) => H - PAD - ((v - min) / rng) * (H - PAD * 2);
    const path = (arr, off) => arr.map((v, i) => v == null ? '' : `${i ? 'L' : 'M'}${x((off || 0) + i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ').replace(/L(?=M)/g, '');
    const lineFrom = (arr) => { let started = false; return arr.map((v, i) => { if (v == null) { started = false; return ''; } const cmd = started ? 'L' : 'M'; started = true; return `${cmd}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; }).join(' '); };

    const priceLine = histSlice.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const area = `${priceLine} L ${x(histSlice.length - 1).toFixed(1)} ${H - PAD} L ${PAD} ${H - PAD} Z`;
    const sma20Line = areaOnly ? '' : lineFrom(s.sma20.slice(start));
    const sma50Line = areaOnly ? '' : lineFrom(s.sma50.slice(start));
    const overlays = studyOverlaySVG(closes, hist.highs, hist.lows, hist.volumes, start, x, y, histSlice);

    let fcBand = '', fcBandIn = '', fcLine = '';
    if (fc) {
      const off = histSlice.length;
      const hiPath = fcHi.map((v, i) => `${i ? 'L' : 'M'}${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
      fcBand = `${hiPath} ${fcLo.map((v, i) => `L${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).reverse().join(' ')} Z`;
      // inner 50% band (P25–P75): the tighter "likely" cone drawn darker inside the 80% cone
      if (fc.hi75 && fc.lo25) {
        const hiIn = fc.hi75.map((v, i) => `${i ? 'L' : 'M'}${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
        fcBandIn = `${hiIn} ${fc.lo25.map((v, i) => `L${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).reverse().join(' ')} Z`;
      }
      fcLine = `M${x(off - 1).toFixed(1)} ${y(histSlice[histSlice.length - 1]).toFixed(1)} ` + fcMid.map((v, i) => `L${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    }
    svg.innerHTML = `
      <defs><linearGradient id="pf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34D399" stop-opacity=".22"/><stop offset="1" stop-color="#34D399" stop-opacity="0"/></linearGradient></defs>
      <path d="${area}" fill="url(#pf)"/>
      ${fc ? `<path d="${fcBand}" fill="#22D3EE" opacity=".12"/>` : ''}
      ${fcBandIn ? `<path d="${fcBandIn}" fill="#22D3EE" opacity=".14"/>` : ''}
      ${sma50Line ? `<path d="${sma50Line}" fill="none" stroke="#FBBF24" stroke-width="1.4" opacity=".85"/>` : ''}
      ${sma20Line ? `<path d="${sma20Line}" fill="none" stroke="#818CF8" stroke-width="1.4" opacity=".9"/>` : ''}
      ${overlays}
      <path d="${priceLine}" fill="none" stroke="#34D399" stroke-width="2.1" stroke-linejoin="round"/>
      ${fc ? `<path d="${fcLine}" fill="none" stroke="#22D3EE" stroke-width="1.8" stroke-dasharray="5 4"/>` : ''}
      ${overlaySVG(y)}
      <line id="xhair" y1="${PAD}" y2="${H - PAD}" stroke="rgba(231,236,245,.45)" stroke-width="1" stroke-dasharray="3 3" style="display:none" vector-effect="non-scaling-stroke"/>
      <circle id="xdot" r="3.6" fill="#E7ECF5" stroke="#0A0F1C" stroke-width="1" style="display:none"/>`;

    chartState = { total, histLen: histSlice.length, vals: histSlice, dates: histDates, fcMid, yAt: y, xAt: x, yInv: (yv) => min + ((H - PAD - yv) / (H - PAD * 2)) * rng };
  }

  function drawCandles(ohlc, fc) {
    const svg = $('chart');
    const view = Math.min(ohlc.closes.length, 110), start = ohlc.closes.length - view;
    const o = ohlc.opens.slice(start), h = ohlc.highs.slice(start), l = ohlc.lows.slice(start), c = ohlc.closes.slice(start), d = (ohlc.dates || []).slice(start);
    const s = Q.series(c);
    const fcMid = fc ? fc.mid : [], fcHi = fc ? fc.hi : [], fcLo = fc ? fc.lo : [];
    const all = h.concat(l, fcHi, fcLo);
    const min = Math.min(...all), max = Math.max(...all), rng = max - min || 1;
    const total = c.length + fcMid.length;
    const x = (i) => PAD + (i / (total - 1)) * (W - PAD * 2);
    const y = (v) => H - PAD - ((v - min) / rng) * (H - PAD * 2);
    const slot = (W - PAD * 2) / total, bw = Math.max(1.2, Math.min(slot * 0.66, 9));
    let candles = '';
    for (let i = 0; i < c.length; i++) {
      const up = c[i] >= o[i], col = up ? '#34D399' : '#FB7185', cx = x(i);
      const top = Math.min(y(o[i]), y(c[i])), bh = Math.max(1, Math.abs(y(c[i]) - y(o[i])));
      candles += `<line x1="${cx.toFixed(1)}" y1="${y(h[i]).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(l[i]).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
      candles += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}" opacity=".9"/>`;
    }
    const lineFrom = (arr) => { let st = false; return arr.map((v, i) => { if (v == null) { st = false; return ''; } const cmd = st ? 'L' : 'M'; st = true; return `${cmd}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; }).join(' '); };
    const sma20Line = lineFrom(s.sma20.slice(start)), sma50Line = lineFrom(s.sma50.slice(start));
    const overlays = studyOverlaySVG(ohlc.closes, ohlc.highs, ohlc.lows, ohlc.volumes, start, x, y, c);
    let fcBand = '', fcBandIn = '', fcLine = '';
    if (fc) {
      const off = c.length;
      const hiPath = fcHi.map((v, i) => `${i ? 'L' : 'M'}${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
      fcBand = `${hiPath} ${fcLo.map((v, i) => `L${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).reverse().join(' ')} Z`;
      if (fc.hi75 && fc.lo25) {
        const hiIn = fc.hi75.map((v, i) => `${i ? 'L' : 'M'}${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
        fcBandIn = `${hiIn} ${fc.lo25.map((v, i) => `L${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).reverse().join(' ')} Z`;
      }
      fcLine = `M${x(off - 1).toFixed(1)} ${y(c[c.length - 1]).toFixed(1)} ` + fcMid.map((v, i) => `L${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    }
    svg.innerHTML = `
      ${fc ? `<path d="${fcBand}" fill="#22D3EE" opacity=".12"/>` : ''}
      ${fcBandIn ? `<path d="${fcBandIn}" fill="#22D3EE" opacity=".14"/>` : ''}
      ${sma50Line ? `<path d="${sma50Line}" fill="none" stroke="#FBBF24" stroke-width="1.3" opacity=".8"/>` : ''}
      ${sma20Line ? `<path d="${sma20Line}" fill="none" stroke="#818CF8" stroke-width="1.3" opacity=".85"/>` : ''}
      ${overlays}
      ${candles}
      ${fc ? `<path d="${fcLine}" fill="none" stroke="#22D3EE" stroke-width="1.8" stroke-dasharray="5 4"/>` : ''}
      ${overlaySVG(y)}
      <line id="xhair" y1="${PAD}" y2="${H - PAD}" stroke="rgba(231,236,245,.45)" stroke-width="1" stroke-dasharray="3 3" style="display:none" vector-effect="non-scaling-stroke"/>
      <circle id="xdot" r="3.6" fill="#E7ECF5" stroke="#0A0F1C" stroke-width="1" style="display:none"/>`;
    chartState = { total, histLen: c.length, vals: c, dates: d, fcMid, yAt: y, xAt: x, yInv: (yv) => min + ((H - PAD - yv) / (H - PAD * 2)) * rng };
  }

  /* ---------------- indicator sub-panes (RSI · MACD · Volume) ---------------- */
  function togglePane(id, on) { const el = $(id); if (el) el.classList.toggle('is-off', !on); }
  function drawPanes(hist) {
    const show = !tickMode && chartState && hist && hist.closes && hist.closes.length > 2;
    togglePane('paneRsi', show && $('togRsi').checked);
    togglePane('paneMacd', show && $('togMacd').checked);
    togglePane('paneVol', show && $('togVol').checked);
    togglePane('paneStoch', show && $('togStoch') && $('togStoch').checked);
    const tog = (id) => $(id) && $(id).checked;
    togglePane('paneAdx', show && tog('togAdx'));
    togglePane('paneWill', show && tog('togWill'));
    togglePane('paneCci', show && tog('togCci'));
    if (!show) return;
    const hl = chartState.histLen, xEnd = chartState.xAt(hl - 1);
    const px = (j) => PAD + (hl > 1 ? (j / (hl - 1)) * (xEnd - PAD) : 0);
    if ($('togRsi').checked) renderRsiPane(hist, hl, px, xEnd);
    if ($('togMacd').checked) renderMacdPane(hist, hl, px, xEnd);
    if ($('togVol').checked) renderVolPane(hist, hl, px);
    if (tog('togStoch')) renderStochPane(hist, hl, px, xEnd);
    if (tog('togAdx')) renderOscPane('svgAdx', adxSeries(hist.highs || [], hist.lows || [], hist.closes || [], 14), hl, px, xEnd, { lo: 0, hi: 60, levels: [25], col: '#A78BFA', need: hist.highs });
    if (tog('togWill')) renderOscPane('svgWill', williamsR(hist.highs || [], hist.lows || [], hist.closes || [], 14), hl, px, xEnd, { lo: -100, hi: 0, levels: [-20, -80], col: '#22D3EE', need: hist.highs });
    if (tog('togCci')) renderOscPane('svgCci', cciSeries(hist.highs || [], hist.lows || [], hist.closes || [], 20), hl, px, xEnd, { lo: -200, hi: 200, levels: [100, -100], col: '#FBBF24', need: hist.highs });
  }
  // Generic oscillator pane renderer (ADX, Williams %R, CCI…)
  function renderOscPane(svgId, series, hl, px, xEnd, opt) {
    const svg = $(svgId); if (!svg) return;
    const C = (series || []);
    if (!opt.need || opt.need.length !== C.length || !opt.need.length) { svg.innerHTML = `<text x="360" y="34" fill="#6B7890" font-size="9" text-anchor="middle">needs OHLC data</text>`; return; }
    const PH = 64, lo = opt.lo, hi = opt.hi, rng = (hi - lo) || 1;
    const y = (v) => PH - 5 - ((Math.max(lo, Math.min(hi, v)) - lo) / rng) * (PH - 12);
    const arr = C.slice(-hl);
    const line = arr.map((v, i) => v == null ? '' : `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ').replace(/L(?=M)/g, '');
    const lvls = (opt.levels || []).map((lv) => `<line x1="${PAD}" x2="${xEnd}" y1="${y(lv)}" y2="${y(lv)}" stroke="rgba(231,236,245,.18)" stroke-width="1" stroke-dasharray="3 3"/>`).join('');
    const last = arr[arr.length - 1];
    svg.innerHTML = lvls + `<path d="${line}" fill="none" stroke="${opt.col}" stroke-width="1.5"/>` + (last != null ? `<circle cx="${px(arr.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.6" fill="${opt.col}"/>` : '');
  }
  function renderStochPane(hist, hl, px, xEnd) {
    const svg = $('svgStoch'); if (!svg) return;
    const PH = 64, Hi = hist.highs || [], Lo = hist.lows || [], C = hist.closes || [], n = 14;
    if (Hi.length !== C.length || !Hi.length) { svg.innerHTML = `<text x="360" y="34" fill="#6B7890" font-size="9" text-anchor="middle">Stochastic needs OHLC data</text>`; return; }
    const k = [];
    for (let i = 0; i < C.length; i++) {
      if (i < n - 1) { k.push(null); continue; }
      let hh = -Infinity, ll = Infinity;
      for (let j = i - n + 1; j <= i; j++) { if (Hi[j] > hh) hh = Hi[j]; if (Lo[j] < ll) ll = Lo[j]; }
      k.push(hh > ll ? ((C[i] - ll) / (hh - ll)) * 100 : 50);
    }
    const dd = k.map((_, i) => (i < 2 || k[i] == null || k[i - 1] == null || k[i - 2] == null) ? null : (k[i] + k[i - 1] + k[i - 2]) / 3);
    const kS = k.slice(-hl), dS = dd.slice(-hl);
    const y = (v) => PH - 5 - (Math.max(0, Math.min(100, v)) / 100) * (PH - 12);
    const lineOf = (arr, col) => `<path d="${arr.map((v, i) => v == null ? '' : `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ').replace(/L(?=M)/g, '')}" fill="none" stroke="${col}" stroke-width="1.4"/>`;
    svg.innerHTML =
      `<line x1="${PAD}" x2="${xEnd}" y1="${y(80)}" y2="${y(80)}" stroke="rgba(251,113,133,.28)" stroke-width="1" stroke-dasharray="3 3"/>` +
      `<line x1="${PAD}" x2="${xEnd}" y1="${y(20)}" y2="${y(20)}" stroke="rgba(52,211,153,.28)" stroke-width="1" stroke-dasharray="3 3"/>` +
      lineOf(kS, '#22D3EE') + lineOf(dS, '#FBBF24');
  }
  function renderRsiPane(hist, hl, px, xEnd) {
    const svg = $('svgRsi'); if (!svg) return;
    const PH = 64, rsi = (Q.series(hist.closes).rsi14 || []).slice(-hl);
    const y = (v) => PH - 5 - (Math.max(0, Math.min(100, v)) / 100) * (PH - 12);
    const line = rsi.map((v, i) => v == null ? '' : `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ').replace(/L(?=M)/g, '');
    const lastV = rsi[rsi.length - 1];
    svg.innerHTML =
      `<line x1="${PAD}" x2="${xEnd}" y1="${y(70)}" y2="${y(70)}" stroke="rgba(251,113,133,.28)" stroke-width="1" stroke-dasharray="3 3"/>` +
      `<line x1="${PAD}" x2="${xEnd}" y1="${y(30)}" y2="${y(30)}" stroke="rgba(52,211,153,.28)" stroke-width="1" stroke-dasharray="3 3"/>` +
      `<path d="${line}" fill="none" stroke="#818CF8" stroke-width="1.5"/>` +
      (lastV != null ? `<circle cx="${px(rsi.length - 1).toFixed(1)}" cy="${y(lastV).toFixed(1)}" r="2.6" fill="#818CF8"/>` : '');
  }
  function renderMacdPane(hist, hl, px, xEnd) {
    const svg = $('svgMacd'); if (!svg) return;
    const PH = 64, ms = macdSeries(hist.closes);
    const m = ms.macd.slice(-hl), sg = ms.signal.slice(-hl), h = ms.hist.slice(-hl);
    const span = Math.max(0.0001, ...m.concat(sg, h).map((v) => Math.abs(v)));
    const y = (v) => PH / 2 - (v / span) * (PH / 2 - 5), y0 = y(0);
    const slot = (xEnd - PAD) / Math.max(1, hl), bw = Math.max(1, slot * 0.6);
    let bars = '';
    for (let i = 0; i < h.length; i++) { const yy = y(h[i]); bars += `<rect x="${(px(i) - bw / 2).toFixed(1)}" y="${Math.min(yy, y0).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.6, Math.abs(yy - y0)).toFixed(1)}" fill="${h[i] >= 0 ? '#34D399' : '#FB7185'}" opacity=".6"/>`; }
    const mLine = m.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const sLine = sg.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    svg.innerHTML = `<line x1="${PAD}" x2="${xEnd}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}" stroke="rgba(255,255,255,.12)" stroke-width="1"/>${bars}<path d="${mLine}" fill="none" stroke="#22D3EE" stroke-width="1.3"/><path d="${sLine}" fill="none" stroke="#FBBF24" stroke-width="1.2"/>`;
  }
  function renderVolPane(hist, hl, px) {
    const svg = $('svgVol'); if (!svg) return;
    const PH = 54, vols = (hist.volumes || []).slice(-hl), closes = hist.closes.slice(-hl);
    if (!vols.length || vols.every((v) => !v)) { svg.innerHTML = `<text x="360" y="30" fill="#6B7890" font-size="9" text-anchor="middle">No volume data for this asset</text>`; return; }
    const max = Math.max(...vols) || 1, y = (v) => PH - 2 - ((v || 0) / max) * (PH - 8);
    const xEnd = px(hl - 1), slot = (xEnd - PAD) / Math.max(1, hl), bw = Math.max(1, slot * 0.6);
    let bars = '';
    for (let i = 0; i < vols.length; i++) { const up = i === 0 ? true : closes[i] >= closes[i - 1], yy = y(vols[i]); bars += `<rect x="${(px(i) - bw / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${(PH - 2 - yy).toFixed(1)}" fill="${up ? '#34D399' : '#FB7185'}" opacity=".5"/>`; }
    svg.innerHTML = bars;
  }

  /* ---------------- candlestick pattern recognition ---------------- */
  function detectPatterns(o) {
    if (!o || !o.closes || o.closes.length < 3) return [];
    const O = o.opens, H = o.highs, L = o.lows, C = o.closes, n = C.length;
    if (!O || !H || !L || !H.some((h, i) => h > L[i])) return [];   // need real OHLC
    const body = (i) => Math.abs(C[i] - O[i]), range = (i) => Math.max(1e-9, H[i] - L[i]);
    const upSh = (i) => H[i] - Math.max(O[i], C[i]), loSh = (i) => Math.min(O[i], C[i]) - L[i], bull = (i) => C[i] >= O[i];
    const found = [];
    for (let i = Math.max(1, n - 12); i < n; i++) {
      const b = body(i), r = range(i);
      if (b <= r * 0.1) found.push({ i, name: 'Doji', dir: 'neut' });
      else if (loSh(i) >= 2 * b && upSh(i) <= b * 0.6) found.push({ i, name: bull(i) ? 'Hammer' : 'Hanging Man', dir: bull(i) ? 'bull' : 'bear' });
      else if (upSh(i) >= 2 * b && loSh(i) <= b * 0.6) found.push({ i, name: bull(i) ? 'Inverted Hammer' : 'Shooting Star', dir: bull(i) ? 'bull' : 'bear' });
      if (i >= 1 && body(i - 1) > 0) {
        if (bull(i) && !bull(i - 1) && C[i] >= O[i - 1] && O[i] <= C[i - 1] && b > body(i - 1)) found.push({ i, name: 'Bullish Engulfing', dir: 'bull' });
        if (!bull(i) && bull(i - 1) && O[i] >= C[i - 1] && C[i] <= O[i - 1] && b > body(i - 1)) found.push({ i, name: 'Bearish Engulfing', dir: 'bear' });
      }
    }
    const seen = new Set(), out = [];
    for (let k = found.length - 1; k >= 0; k--) { if (!seen.has(found[k].name)) { seen.add(found[k].name); out.push(Object.assign({ ago: n - 1 - found[k].i }, found[k])); } }
    return out.slice(0, 4);
  }
  function renderPatterns(o) {
    const el = $('patterns'); if (!el) return;
    const pats = tickMode ? [] : detectPatterns(o);
    if (!pats.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = '<span class="studies__label" style="align-self:center">Patterns</span>' + pats.map((p) => {
      const c = p.dir === 'bull' ? 'bull' : p.dir === 'bear' ? 'bear' : 'neut';
      const when = p.ago === 0 ? 'latest' : p.ago + ' bars ago';
      return `<span class="pat pat--${c}">${p.name} <span class="pat__when">${when}</span></span>`;
    }).join('');
  }

  /* ---------------- drawing tools + price alerts ---------------- */
  const akey = (it) => it ? (it.type + ':' + (it.symbol || it.id)) : '';
  let drawings = {}, alerts = [], activeTool = null, pendingPt = null;
  try { drawings = JSON.parse(localStorage.getItem('quantra.draw') || '{}'); } catch {}
  try { alerts = JSON.parse(localStorage.getItem('quantra.alerts') || '[]'); } catch {}
  const saveDraw = () => { try { localStorage.setItem('quantra.draw', JSON.stringify(drawings)); } catch {} };
  const saveAlerts = () => { try { localStorage.setItem('quantra.alerts', JSON.stringify(alerts)); } catch {} };
  const curPrice = () => (state && state.analysis && state.analysis.price) || ((board.find((b) => b.id === (current && current.id)) || {}).price) || null;

  function overlaySVG(y) {
    if (!current || tickMode) return '';
    const k = akey(current); let out = '';
    for (const d of (drawings[k] || [])) {
      if (d.type === 'hline') { const yy = y(d.a.price); out += `<line x1="${PAD}" x2="${W - PAD}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="#22D3EE" stroke-width="1.3" stroke-dasharray="6 3" opacity=".85"/>`; }
      else if (d.type === 'trend' && d.b) { const x1 = PAD + d.a.xf * (W - 2 * PAD), x2 = PAD + d.b.xf * (W - 2 * PAD); out += `<line x1="${x1.toFixed(1)}" y1="${y(d.a.price).toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y(d.b.price).toFixed(1)}" stroke="#818CF8" stroke-width="1.6" opacity=".9"/>`; }
      else if (d.type === 'fib' && d.b) {
        const xL = PAD + Math.min(d.a.xf, d.b.xf) * (W - 2 * PAD);
        for (const L of [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]) {
          const yy = y(d.b.price + (d.a.price - d.b.price) * L), edge = (L === 0 || L === 1);
          out += `<line x1="${xL.toFixed(1)}" x2="${W - PAD}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="#FBBF24" stroke-width="${edge ? 1.3 : 0.9}" ${edge ? '' : 'stroke-dasharray="4 3"'} opacity="${edge ? 0.9 : 0.55}"/>`;
          out += `<text x="${(xL + 3).toFixed(1)}" y="${(yy - 2).toFixed(1)}" fill="#FBBF24" font-size="8" opacity=".85">${(L * 100).toFixed(1)}%</text>`;
        }
      }
    }
    if ((activeTool === 'trend' || activeTool === 'fib') && pendingPt && pendingPt.k === k) { const x1 = PAD + pendingPt.xf * (W - 2 * PAD); out += `<circle cx="${x1.toFixed(1)}" cy="${y(pendingPt.price).toFixed(1)}" r="3" fill="#818CF8"/>`; }
    for (const a of alerts) { if (a.k === k && a.on) { const yy = y(a.price); out += `<line x1="${PAD}" x2="${W - PAD}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="#FBBF24" stroke-width="1.1" stroke-dasharray="2 3" opacity=".8"/>`; } }
    return out;
  }
  function redrawChart() { if (current && state) drawChart(state.history, state.analysis && state.analysis.forecast); }
  function setTool(t) { activeTool = t; pendingPt = null; const tr = $('toolTrend'), hl = $('toolHline'), fb = $('toolFib'); if (tr) tr.classList.toggle('is-on', t === 'trend'); if (hl) hl.classList.toggle('is-on', t === 'hline'); if (fb) fb.classList.toggle('is-on', t === 'fib'); const c = $('chart'); if (c) c.style.cursor = t ? 'crosshair' : ''; }
  function chartPoint(e) {
    const svg = $('chart'), rect = svg.getBoundingClientRect();
    let df = (((e.clientX - rect.left) / rect.width) * W - PAD) / (W - PAD * 2); df = Math.max(0, Math.min(1, df));
    const price = (chartState && chartState.yInv) ? chartState.yInv(((e.clientY - rect.top) / rect.height) * H) : null;
    return { xf: df, price };
  }
  function onChartDown(e) {
    if (!activeTool || !current || !chartState) return;
    const pt = chartPoint(e); if (pt.price == null) return;
    const k = akey(current);
    if (activeTool === 'hline') { (drawings[k] = drawings[k] || []).push({ type: 'hline', a: { price: pt.price } }); saveDraw(); setTool(null); redrawChart(); }
    else if (activeTool === 'trend' || activeTool === 'fib') {   // two-click tools
      if (!pendingPt) { pendingPt = { k, xf: pt.xf, price: pt.price }; redrawChart(); }
      else { (drawings[k] = drawings[k] || []).push({ type: activeTool, a: { xf: pendingPt.xf, price: pendingPt.price }, b: { xf: pt.xf, price: pt.price } }); pendingPt = null; saveDraw(); setTool(null); redrawChart(); }
    }
  }
  function clearDrawings() { if (current) { drawings[akey(current)] = []; saveDraw(); redrawChart(); } }

  function addAlert() {
    if (!current) return R.toast('Pick an asset first');
    const price = parseFloat(($('alertPrice').value || '').replace(/[^0-9.]/g, ''));
    if (!(price > 0)) return R.toast('Enter a valid alert price');
    const cur = curPrice();
    const side = (cur != null && price >= cur) ? 'above' : 'below';
    alerts.push({ id: 'al_' + Date.now().toString(36), k: akey(current), sym: current.symbol, type: current.type, price, side, on: true });
    saveAlerts(); $('alertPrice').value = '';
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') { try { Notification.requestPermission(); } catch {} }
    R.toast('Alert set · ' + money(price, curBase) + ' (' + side + ')');
    renderAlerts(); redrawChart();
  }
  function removeAlert(id) { alerts = alerts.filter((a) => a.id !== id); saveAlerts(); renderAlerts(); redrawChart(); }
  function renderAlerts() {
    const el = $('alertList'); if (!el) return;
    const mine = alerts.filter((a) => a.on && current && a.k === akey(current));
    if (!mine.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = mine.map((a) => `<span class="al-chip">🔔 <b>${money(a.price, curBase)}</b> <small>${a.side}</small> <button data-al="${a.id}" aria-label="remove alert">✕</button></span>`).join('');
    el.querySelectorAll('[data-al]').forEach((b) => b.addEventListener('click', () => removeAlert(b.dataset.al)));
  }
  function fireAlert(a, price) {
    const msg = `${a.sym} crossed ${money(a.price, curBase)} (now ${money(price, curBase)})`;
    try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('Quantra alert', { body: msg, icon: 'assets/brand/quantra-icon.svg' }); } catch {}
    if (R && R.toast) R.toast('🔔 ' + msg);
  }
  function checkAlerts(type, symbol, price) {
    if (!(price > 0) || !alerts.length) return;
    const k = type + ':' + symbol; let changed = false;
    for (const a of alerts) {
      if (!a.on || a.k !== k) continue;
      if ((a.side === 'above' && price >= a.price) || (a.side === 'below' && price <= a.price)) { a.on = false; changed = true; fireAlert(a, price); }
    }
    if (changed) { saveAlerts(); if (current && k === akey(current)) { renderAlerts(); redrawChart(); } }
  }

  /* ---------------- chart hover tooltip (date + price) ---------------- */
  function fmtTipDate(iso) {
    if (!iso) return '';
    const intr = $('intervalSel').value;
    if (intr === 'sec') {   // live mode: show real millisecond precision on the tick time
      const d = new Date(iso);
      return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    }
    const opt = (intr === '1m' || intr === '60m')
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric' };
    return new Date(iso).toLocaleString('en-US', opt);
  }
  function setupChartHover() {
    const svg = $('chart'), tip = $('chartTip');
    const onMove = (e) => {
      if (!chartState || !chartState.total) return;
      const rect = svg.getBoundingClientRect();
      const xv = ((e.clientX - rect.left) / rect.width) * W;            // viewBox x
      let df = (xv - PAD) / (W - PAD * 2); df = Math.max(0, Math.min(1, df));
      const idx = Math.round(df * (chartState.total - 1));
      const isHist = idx < chartState.histLen;
      const price = isHist ? chartState.vals[idx] : chartState.fcMid[idx - chartState.histLen];
      if (price == null) return;
      const vx = chartState.xAt(idx), vy = chartState.yAt(price);
      const hair = svg.querySelector('#xhair'), dot = svg.querySelector('#xdot');
      if (hair) { hair.setAttribute('x1', vx); hair.setAttribute('x2', vx); hair.style.display = 'block'; }
      if (dot) { dot.setAttribute('cx', vx); dot.setAttribute('cy', vy); dot.style.display = 'block'; dot.setAttribute('fill', isHist ? '#34D399' : '#22D3EE'); }
      const leftPx = (vx / W) * rect.width;
      tip.style.display = 'block';
      tip.style.left = Math.max(2, Math.min(rect.width - tip.offsetWidth - 2, leftPx - tip.offsetWidth / 2)) + 'px';
      let when;
      if (isHist) when = fmtTipDate(chartState.dates[idx]);
      else { const lastIso = chartState.dates[chartState.histLen - 1]; const fd = projDateFor(lastIso, idx - chartState.histLen + 1, $('intervalSel').value, current && current.type === 'crypto'); when = 'proj · ' + fmtTipDate(fd.toISOString()); }
      tip.innerHTML = `<b>${money(price, curBase)}</b><span>${when}</span>`;
    };
    const onLeave = () => {
      tip.style.display = 'none';
      const hair = svg.querySelector('#xhair'), dot = svg.querySelector('#xdot');
      if (hair) hair.style.display = 'none';
      if (dot) dot.style.display = 'none';
    };
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerleave', onLeave);
    // Touch: tapping/holding the chart should immediately reveal the value at that point
    // (no hover on mobile), and lifting the finger clears it. Guarded so drawing tools and
    // desktop mouse-clicks are unaffected.
    svg.addEventListener('pointerdown', (e) => { if (!activeTool && e.pointerType === 'touch') onMove(e); });
    svg.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') onLeave(); });
    svg.addEventListener('pointercancel', onLeave);
  }

  /* ---------------- typewriter ---------------- */
  let typeTimer;
  function typeOut(node, str) { clearTimeout(typeTimer); let i = 0; (function t() { node.innerHTML = str.slice(0, i) + (i < str.length ? '<span class="cursor"></span>' : ''); if (i < str.length) { i += 3; typeTimer = setTimeout(t, 9); } })(); }

  /* ---------------- fundamentals render ---------------- */
  function fundField(label, value, cls) { return `<div class="fund ${cls || ''}"><span>${label}</span><b>${value}</b></div>`; }
  function renderFundamentals(f) {
    const card = $('fundCard');
    if (!f) { card.hidden = true; return; }
    card.hidden = false;
    $('fundGrade').textContent = (state.analysis.fundamental ? state.analysis.fundamental.grade : '—') + ' fundamentals';
    $('fundNews').href = `news.html?symbol=${encodeURIComponent(f.symbol)}`;
    const pct = (x, d = 1) => (x == null ? '—' : (x * 100).toFixed(d) + '%');
    const cls = (cond) => (cond === null ? '' : cond ? 'good' : 'bad');
    $('funds').innerHTML = [
      fundField('Market Cap', f.marketCap ? capMoney(f.marketCap, f.currency) : '—'),
      fundField('P/E (TTM)', f.peTrailing != null ? f.peTrailing.toFixed(1) : '—', cls(f.peTrailing == null ? null : f.peTrailing > 0 && f.peTrailing < 25)),
      fundField('Forward P/E', f.peForward != null ? f.peForward.toFixed(1) : '—'),
      fundField('EPS (TTM)', f.eps != null ? f.eps.toFixed(2) : '—'),
      fundField('Price / Book', f.pb != null ? f.pb.toFixed(2) : '—'),
      fundField('Book Value', f.bookValue != null ? f.bookValue.toFixed(2) : '—'),
      fundField('ROE', pct(f.roe), cls(f.roe == null ? null : f.roe > 0.12)),
      fundField('ROA', pct(f.roa), cls(f.roa == null ? null : f.roa > 0.05)),
      fundField('Profit Margin', pct(f.profitMargin), cls(f.profitMargin == null ? null : f.profitMargin > 0.1)),
      fundField('Oper. Margin', pct(f.operatingMargin)),
      fundField('Debt / Equity', f.debtToEquity != null ? f.debtToEquity.toFixed(1) : '—', cls(f.debtToEquity == null ? null : f.debtToEquity < 100)),
      fundField('Rev. Growth', pct(f.revenueGrowth), cls(f.revenueGrowth == null ? null : f.revenueGrowth > 0)),
      fundField('Earn. Growth', pct(f.earningsGrowth), cls(f.earningsGrowth == null ? null : f.earningsGrowth > 0)),
      fundField('Div. Yield', pct(f.dividendYield, 2)),
      fundField('52w High', f.high52 != null ? money(f.high52, f.currency) : '—'),
      fundField('52w Low', f.low52 != null ? money(f.low52, f.currency) : '—'),
      fundField('Beta', f.beta != null ? f.beta.toFixed(2) : '—'),
      fundField('Analyst Target', f.targetMean != null ? money(f.targetMean, f.currency) : '—'),
    ].join('');
    if (f.sector) $('dSub').textContent = `${f.sector}${f.industry ? ' · ' + f.industry : ''}`;

    // estimates / analyst block
    const e = f.estimates || {}, rb = f.recBreakdown;
    const fld = (label, value) => `<div class="fund"><span>${label}</span><b>${value}</b></div>`;
    const num = (x, d = 2) => (x == null ? '—' : (+x).toFixed(d));
    const bil = (x) => (x == null ? '—' : x >= 1e9 ? '$' + (x / 1e9).toFixed(1) + 'B' : '$' + Math.round(x / 1e6) + 'M');
    const rows = [];
    if (rb) { const total = (rb.strongBuy || 0) + (rb.buy || 0) + (rb.hold || 0) + (rb.sell || 0) + (rb.strongSell || 0); rows.push(fld('Analyst consensus', `${(rb.strongBuy || 0) + (rb.buy || 0)} buy / ${rb.hold || 0} hold / ${(rb.sell || 0) + (rb.strongSell || 0)} sell`)); }
    if (f.analystCount != null) rows.push(fld('# Analysts', f.analystCount));
    if (f.targetLow != null) rows.push(fld('Target range', `${money(f.targetLow, f.currency)} – ${money(f.targetHigh, f.currency)}`));
    if (e.epsCurrentYear != null) rows.push(fld('EPS est (FY)', num(e.epsCurrentYear)));
    if (e.epsNextYear != null) rows.push(fld('EPS est (FY+1)', num(e.epsNextYear)));
    if (e.revNextYear != null) rows.push(fld('Revenue est (FY+1)', bil(e.revNextYear)));
    if (e.epsGrowthNextYear != null) rows.push(fld('EPS growth (FY+1)', (e.epsGrowthNextYear * 100).toFixed(1) + '%'));
    if (e.nextEarningsDate) rows.push(fld('Next earnings', e.nextEarningsDate));
    const ew = $('estWrap');
    if (rows.length) { ew.hidden = false; $('estimates').innerHTML = rows.join(''); } else ew.hidden = true;
  }

  function renderPeers(peers) {
    const card = $('peerCard');
    if (!peers || !peers.length) { card.hidden = true; return; }
    card.hidden = false;
    $('peers').innerHTML = peers.map((p) => {
      const up = (p.change || 0) >= 0;
      return `<button class="peer trow" data-id="${p.symbol}" data-type="stock" data-symbol="${p.symbol}" data-name="${(p.name || '').replace(/"/g, '')}" style="cursor:pointer;text-align:left">
        <b>${p.symbol}</b><small>${p.name || ''}</small>
        <span class="chg ${up ? 'up' : 'down'}">${money(p.price, p.currency)} · ${up ? '+' : ''}${(p.change || 0).toFixed(2)}%</span></button>`;
    }).join('');
    $('peers').querySelectorAll('.peer').forEach((b) => b.addEventListener('click', () => select({ id: b.dataset.id, type: 'stock', symbol: b.dataset.symbol, name: b.dataset.name })));
  }

  function newsAgo(iso) {
    if (!iso) return '';
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 3600) return Math.max(1, Math.round(d / 60)) + 'm';
    if (d < 86400) return Math.round(d / 3600) + 'h';
    return Math.round(d / 86400) + 'd';
  }
  const escAttr = (s) => (s || '').replace(/"/g, '&quot;');
  const escHtml = (s) => (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function renderNews(sent, item) {
    const card = $('newsCard');
    if (!sent || !sent.count) { card.hidden = true; return; }
    card.hidden = false;
    const badge = $('newsSentiment');
    const cls = sent.label === 'Positive' ? 'pos' : sent.label === 'Negative' ? 'neg' : 'neu';
    badge.textContent = `${sent.label} · ${sent.score >= 0 ? '+' : ''}${sent.score.toFixed(2)} (${sent.pos}▲/${sent.neg}▼)`;
    badge.className = 'grade sent-' + cls;
    const symParam = item.type === 'crypto' ? item.symbol : item.id;
    $('newsMore').href = `news.html?symbol=${encodeURIComponent(symParam)}`;
    $('newsList').innerHTML = sent.scored.slice(0, 6).map((n) => {
      const d = n.dir === 'pos' ? 'pos' : n.dir === 'neg' ? 'neg' : 'neu';
      return `<a class="nitem nitem--${d}" href="${escAttr(n.link)}" target="_blank" rel="noopener noreferrer">
        <span class="nitem__dot"></span>
        <span class="nitem__body"><b>${escHtml(n.title)}</b><small>${escHtml(n.publisher || '')}${n.time ? ' · ' + newsAgo(n.time) + ' ago' : ''}</small></span></a>`;
    }).join('');
  }
  function setNewsMeter(label, score, suffix) {
    const nm = $('mNews');
    if (!label || score == null) { nm.textContent = '—'; nm.style.color = ''; return; }
    nm.textContent = `${label} ${score >= 0 ? '+' : ''}${score.toFixed(2)}${suffix || ''}`;
    nm.style.color = label === 'Positive' ? 'var(--mint)' : label === 'Negative' ? 'var(--rose)' : 'var(--amber)';
  }
  function renderForecast(fc) {
    if (!fc) { $('fcast').hidden = true; return; }
    $('fcast').hidden = false;
    const sign = fc.expReturn >= 0 ? '+' : '';
    const rEl = $('fcReturn'); rEl.textContent = `${sign}${(fc.expReturn * 100).toFixed(1)}%`; rEl.className = 'big ' + (fc.expReturn >= 0 ? 'up' : 'down');
    const pEl = $('fcProb');
    if (pEl && fc.probUp != null) { pEl.textContent = Math.round(fc.probUp * 100) + '%'; pEl.style.color = fc.probUp >= 0.55 ? 'var(--mint)' : fc.probUp <= 0.45 ? 'var(--rose)' : 'var(--amber)'; }
    $('fcTarget').textContent = money(fc.mid[fc.mid.length - 1], curBase);
    // lead with the tight 50% band when available; fall back to the 80% band
    $('fcRange').textContent = (fc.lo25 && fc.hi75)
      ? money(fc.lo25[fc.lo25.length - 1], curBase) + ' – ' + money(fc.hi75[fc.hi75.length - 1], curBase)
      : money(fc.lo[fc.lo.length - 1], curBase) + ' – ' + money(fc.hi[fc.hi.length - 1], curBase);
    $('fcVol').textContent = (fc.annualVol * 100).toFixed(0) + '%';
    const hz = $('fcHorizons');
    if (hz) hz.innerHTML = (fc.horizons || []).map((h) => `<span class="fch"><i>+${h.bars} bars</i> <b class="${h.move >= 0 ? 'up' : 'down'}">${h.move >= 0 ? '+' : ''}${(h.move * 100).toFixed(1)}%</b> <em>${(h.lo * 100).toFixed(0)}…${(h.hi * 100).toFixed(0)}%</em></span>`).join('');
  }

  /* ---------------- dated projections ---------------- */
  function projDateFor(lastIso, bars, interval, isCrypto) {
    const dt = new Date(lastIso || Date.now());
    if (interval === 'sec') return new Date(dt.getTime() + bars * 1000);
    if (interval === '60m') return new Date(dt.getTime() + bars * 3600e3);
    if (interval === '1m') return new Date(dt.getTime() + bars * 60e3);
    const step = interval === '1wk' ? 7 : 1; let added = 0;
    while (added < bars) { dt.setDate(dt.getDate() + step); if (isCrypto || (dt.getDay() !== 0 && dt.getDay() !== 6)) added++; }
    return dt;
  }
  // Live calibration feedback: read the measured 80%-band coverage from the server's
  // track record (real forward outcomes, hash-chained) and turn it into a corrective
  // width multiplier for the forecast cone. Under-coverage → wider bands; over-coverage
  // → tighter. This is what makes the bands trustworthy in real use: they converge to
  // meaning exactly what they say. Cached 10 min; scale clamped so it can never run away.
  let liveCal = null, liveCalAt = 0;
  async function getLiveCal() {
    if (liveCal && Date.now() - liveCalAt < 10 * 60 * 1000) return liveCal;
    liveCalAt = Date.now();
    try {
      const d = await getJSON(`${API}/track-record`);
      const c = d && d.calibration;
      if (c && c.n >= 150 && c.coverage != null) {
        liveCal = { scale: Math.max(0.85, Math.min(1.3, 1 + (0.8 - c.coverage) * 1.6)), coverage: c.coverage, n: c.n };
      } else liveCal = { scale: 1, coverage: null, n: (c && c.n) || 0 };
    } catch { liveCal = { scale: 1, coverage: null, n: 0 }; }
    return liveCal;
  }
  function renderProjections(fc, hist, item) {
    const card = $('projCard'); if (!card) return;
    if (!fc || !fc.horizons || !fc.horizons.length) { card.hidden = true; return; }
    const interval = $('intervalSel').value, isCrypto = item.type === 'crypto';
    const lastIso = (hist.dates && hist.dates[hist.dates.length - 1]) || null;
    const p0 = fc.p0;
    const fmtD = (d) => d.toLocaleString('en-US', (interval === '1m' || interval === '60m')
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { weekday: 'short', month: 'short', day: 'numeric' });
    const rows = fc.horizons.map((h) => {
      const d = projDateFor(lastIso, h.bars, interval, isCrypto);
      const proj = p0 * (1 + h.move), lo = p0 * (1 + h.lo), hi = p0 * (1 + h.hi), up = h.move >= 0;
      // tighter central band (P25–P75, 50%) leads; the wider 80% band sits beneath it
      const tl = h.lo25 != null ? p0 * (1 + h.lo25) : null, th = h.hi75 != null ? p0 * (1 + h.hi75) : null;
      const rng = (tl != null)
        ? `${money(tl, curBase)} – ${money(th, curBase)}<small>50% likely · 80%: ${money(lo, curBase)} – ${money(hi, curBase)}</small>`
        : `${money(lo, curBase)} – ${money(hi, curBase)}`;
      const st = projStatus(hist, d.toISOString(), p0, proj, lo, hi, tl, th);
      return `<tr><td>${fmtD(d)}<small>+${h.bars} ${interval === '1wk' ? 'wk' : interval === '60m' ? 'h' : interval === '1m' ? 'm' : 'sessions'}</small></td><td class="proj-px">${money(proj, curBase)}</td><td class="proj-rng">${rng}</td><td class="proj-d ${up ? 'up' : 'down'}">${up ? '+' : ''}${(h.move * 100).toFixed(1)}%</td><td>${st}</td></tr>`;
    }).join('');
    // Matured checkpoints from earlier visits — the "did it go or not" rows, shown right
    // in the projection list: past projection vs the price that actually happened.
    let verified = '';
    try {
      const log = JSON.parse(localStorage.getItem('quantra.projlog') || '{}');
      const past = [];
      for (const e of (log[akey(item)] || [])) for (const c of e.checks) {
        const actual = actualAt(hist, c.date);
        if (actual == null) continue;
        const v = projVerdict(e.p0, c.lo, c.hi, c.p50, actual, c.tl, c.th);
        past.push({ made: e.made, date: c.date, p50: c.p50, lo: c.lo, hi: c.hi, actual, v });
      }
      if (past.length) {
        past.sort((a, b) => (a.date < b.date ? 1 : -1));
        verified = `<tr><td colspan="5" class="proj-sep">Verified — projected earlier, graded against the real price</td></tr>` +
          past.slice(0, 3).map((r) => `<tr class="proj-past"><td>${r.date.slice(0, 10)}<small>made ${r.made.slice(0, 10)}</small></td><td class="proj-px">${money(r.p50, curBase)}</td><td class="proj-rng">${money(r.lo, curBase)} – ${money(r.hi, curBase)}</td><td class="proj-px">${money(r.actual, curBase)}<small>actual</small></td><td class="proj-d ${r.v.c === 'up' ? 'up' : r.v.c === 'down' ? 'down' : ''}">${r.v.t}</td></tr>`).join('');
      }
    } catch {}
    $('projTable').innerHTML = '<tr><th>Date</th><th>Projected (P50)</th><th>Likely range (P25–P75)</th><th>Δ vs now</th><th>Status</th></tr>' + rows + verified;
    const calNote = (liveCal && liveCal.coverage != null)
      ? ` <b>Self-calibrating:</b> measured live coverage is ${Math.round(liveCal.coverage * 100)}% over ${liveCal.n.toLocaleString()} matured projections, so band width runs ×${liveCal.scale.toFixed(2)} to converge on a true 80%.`
      : ' Bands auto-calibrate against the live track record as projections mature.';
    const regNote = (fc.regimeScale && Math.abs(fc.regimeScale - 1) > 0.12)
      ? ` Current volatility regime: ${fc.regimeScale > 1 ? 'elevated' : 'calm'} (×${fc.regimeScale.toFixed(2)} vs the 120-day average).` : '';
    $('projAsof').innerHTML = 'Anchored to ' + fmtD(new Date(lastIso || Date.now())) + ' · ' + Math.round((fc.probUp || 0) * 100) + '% modelled chance of finishing higher. The headline <b>P25–P75 range is the tight 50% band</b> — the price lands inside it about half the time; the small <b>80% band</b> beneath catches ~4 in 5. A narrower range always means lower odds — that\'s probability, not a setting.' + calNote + regNote + ' Probabilistic, not a guarantee.';
    card.hidden = false;
    logProjection(item, fc, hist, interval, isCrypto, lastIso);
    renderProjScorecard(item, hist);
  }
  // actual close at or just after a target date/time (from the loaded history).
  // Timestamp-aware: intraday targets (full ISO) grade against the bar AT/after the
  // target time — not the first bar of that day, which silently mis-graded 1m/60m
  // projections. Date-only targets keep grading at the daily boundary as before.
  function actualAt(hist, target) {
    if (!hist || !hist.dates) return null;
    const tMs = Date.parse(String(target).length <= 10 ? target + 'T00:00:00Z' : target);
    if (!isFinite(tMs)) return null;
    for (let i = 0; i < hist.dates.length; i++) {
      const bMs = Date.parse(hist.dates[i]);
      if (isFinite(bMs) && bMs >= tMs && hist.closes[i] != null) return hist.closes[i];
    }
    return null;   // target still in the future / beyond loaded data
  }
  // verdict for one projection checkpoint vs the realised price. The P10–P90 band
  // is volatility-scaled by the Monte-Carlo sigma, so this stays fair on calm
  // indices and wild crypto alike.
  function projVerdict(p0, lo, hi, proj, actual, tl, th) {
    if (actual == null) return null;
    // grade against the tight 50% band first when it was recorded, then the 80% band
    if (tl != null && actual >= tl && actual <= th) return { c: 'up', t: '✓ in 50% band' };
    if (actual >= lo && actual <= hi) return { c: 'up', t: tl != null ? '✓ in 80% band' : '✓ in range' };
    return ((proj >= p0) === (actual >= p0)) ? { c: 'neut', t: (actual >= p0 ? '↗' : '↘') + ' direction' } : { c: 'down', t: '✗ missed' };
  }
  function projStatus(hist, dateStr, p0, proj, lo, hi, tl, th) {
    const a = actualAt(hist, dateStr);
    if (a == null) return '<span class="proj-pending">⏳ pending</span>';
    const v = projVerdict(p0, lo, hi, proj, a, tl, th);
    return `<span class="proj-d ${v.c === 'up' ? 'up' : v.c === 'down' ? 'down' : ''}">${v.t}</span>`;
  }
  function logProjection(item, fc, hist, interval, isCrypto, lastIso) {
    if (interval === 'sec' || !fc.horizons) return;
    const intraday = interval === '1m' || interval === '60m';
    const k = akey(item), made = (lastIso || new Date().toISOString()).slice(0, intraday ? 16 : 10), id = made + ':' + interval;
    let log = {}; try { log = JSON.parse(localStorage.getItem('quantra.projlog') || '{}'); } catch {}
    log[k] = log[k] || [];
    if (!log[k].some((e) => e.id === id)) {
      // intraday targets keep the full timestamp so grading happens at the target TIME,
      // not against the first bar of the day (which silently mis-scored 1m/60m checks)
      log[k].push({ id, made, interval, p0: fc.p0, checks: fc.horizons.map((h) => { const d = projDateFor(lastIso, h.bars, interval, isCrypto).toISOString(); return { date: intraday ? d : d.slice(0, 10), p50: fc.p0 * (1 + h.move), lo: fc.p0 * (1 + h.lo), hi: fc.p0 * (1 + h.hi), tl: h.lo25 != null ? fc.p0 * (1 + h.lo25) : null, th: h.hi75 != null ? fc.p0 * (1 + h.hi75) : null }; }) });
      if (log[k].length > 16) log[k] = log[k].slice(-16);
      try { localStorage.setItem('quantra.projlog', JSON.stringify(log)); } catch {}
    }
  }
  function renderProjScorecard(item, hist) {
    const card = $('projScore'); if (!card) return;
    let log = {}; try { log = JSON.parse(localStorage.getItem('quantra.projlog') || '{}'); } catch {}
    const out = [];
    for (const e of (log[akey(item)] || [])) for (const c of e.checks) {
      const actual = actualAt(hist, c.date); if (actual == null) continue;
      const v = projVerdict(e.p0, c.lo, c.hi, c.p50, actual, c.tl, c.th);
      out.push({ made: e.made, date: c.date, p50: c.p50, lo: c.lo, hi: c.hi, actual, v });
    }
    if (!out.length) { card.hidden = true; return; }
    out.sort((a, b) => (a.date < b.date ? 1 : -1));
    const inRange = out.filter((r) => r.v.c === 'up').length, dirOk = out.filter((r) => r.v.c !== 'down').length;
    $('projScoreTable').innerHTML = '<tr><th>Made</th><th>Target</th><th>Projected</th><th>Actual</th><th>Result</th></tr>' +
      out.slice(0, 8).map((r) => `<tr><td><small>${r.made}</small></td><td>${r.date}</td><td class="proj-px">${money(r.p50, curBase)}</td><td class="proj-px">${money(r.actual, curBase)}</td><td class="proj-d ${r.v.c === 'up' ? 'up' : r.v.c === 'down' ? 'down' : ''}">${r.v.t}</td></tr>`).join('');
    $('projScoreSum').textContent = `${inRange}/${out.length} landed inside the P10–P90 band · ${dirOk}/${out.length} got the direction right`;
    card.hidden = false;
  }

  /* ---------------- Ask Quantra (conversational analyst) ---------------- */
  const ASK_CHIPS = ['Is this a good entry?', 'What do the indicators say?', 'What are the risks?', 'Summarize the news', 'Where might it go?'];
  let askAssetKey = null;
  // Compact, grounded snapshot of the current asset for the analyst to reason over.
  function askContext() {
    if (!state || !state.analysis) return null;
    const res = state.analysis, ind = res.indicators || {}, fc = res.forecast || {}, sent = state.news || null, fund = state.fundamentals || null;
    const lastH = fc.horizons && fc.horizons[fc.horizons.length - 1];
    const band = (lastH && fc.p0 != null) ? { lo: +(fc.p0 * (1 + lastH.lo)).toFixed(2), hi: +(fc.p0 * (1 + lastH.hi)).toFixed(2) } : {};
    return {
      symbol: state.symbol, type: state.type, price: res.price,
      score: res.quantraScore, grade: res.scoreGrade,
      regime: res.regime && res.regime.label,
      verdict: res.verdict && { dir: res.verdict.dir, trend: res.verdict.trend, confidence: res.verdict.confidence, rr: res.verdict.rr, accuracy: res.verdict.accuracy },
      technical: { rsi: ind.rsi != null ? Math.round(ind.rsi) : null, macdHist: ind.macd ? +ind.macd.hist.toFixed(2) : null, adx: ind.adx != null ? Math.round(ind.adx) : null, sma20: ind.sma20, sma50: ind.sma50, sma200: ind.sma200, support: ind.support, resistance: ind.resistance, atr: ind.atr },
      forecast: { probUp: fc.probUp != null ? +fc.probUp.toFixed(2) : null, expReturn: fc.expReturn != null ? +fc.expReturn.toFixed(3) : null, annualVol: fc.annualVol != null ? +fc.annualVol.toFixed(3) : null, lo: band.lo, hi: band.hi },
      walkForward: res.walkForward && { oosAccuracy: +(res.walkForward.oosAccuracy).toFixed(3) },
      fundamentals: fund && { sector: fund.sector, peTrailing: fund.peTrailing, roe: fund.roe, profitMargin: fund.profitMargin, revenueGrowth: fund.revenueGrowth },
      news: sent && { label: sent.label, positive: sent.pos, negative: sent.neg, headlines: (sent.scored || []).slice(0, 6).map((n) => n.title) },
    };
  }
  function renderAskChips() {
    const el = $('askqChips'); if (!el) return;
    el.innerHTML = ASK_CHIPS.map((c) => `<button class="askq-chip" type="button">${c}</button>`).join('');
    el.querySelectorAll('.askq-chip').forEach((b) => b.addEventListener('click', () => askSend(b.textContent)));
  }
  function setAskAsset(item) {
    const card = $('askqCard'); if (!card) return;
    card.hidden = false;
    if ($('askqSym')) $('askqSym').textContent = item.symbol;
    if (askAssetKey !== akey(item)) { askAssetKey = akey(item); if ($('askqThread')) $('askqThread').innerHTML = ''; }
    renderAskChips();
  }
  function appendAskMsg(role, text, loading) {
    const t = $('askqThread'); if (!t) return null;
    const d = document.createElement('div');
    d.className = 'askq-msg askq-msg--' + role + (loading ? ' is-loading' : '');
    d.textContent = text; t.appendChild(d); t.scrollTop = t.scrollHeight; return d;
  }
  async function askSend(text) {
    const inp = $('askqInput'); const q = String(text != null ? text : (inp ? inp.value : '')).trim(); if (!q) return;
    if (text == null && inp) inp.value = '';
    if (!state || !state.analysis) { appendAskMsg('ai', 'Pick an asset first so I have live data to analyse.'); return; }
    appendAskMsg('you', q);
    const loading = appendAskMsg('ai', 'Quantra is reading the data…', true);
    try {
      const r = await fetch(`${API}/ai/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, context: askContext() }) }).then((x) => x.json());
      if (loading) { loading.classList.remove('is-loading'); loading.textContent = (r && r.ok && r.text) ? r.text : 'I could not answer that right now — try rephrasing.'; }
    } catch { if (loading) { loading.classList.remove('is-loading'); loading.textContent = 'Network error — please try again.'; } }
    const t = $('askqThread'); if (t) t.scrollTop = t.scrollHeight;
  }

  /* ---------------- Monitored alerts (server-side, emails you) ---------------- */
  let salerts = [];
  try { salerts = JSON.parse(localStorage.getItem('quantra.salerts') || '[]'); } catch {}
  const signedIn = () => !!(window.QuantraAuth && window.QuantraAuth.user);
  function trackView(item) {   // personalization signal — records the viewed asset for signed-in users
    if (!onServer || !signedIn() || !item) return;
    const t = window.QuantraAuth && window.QuantraAuth.token;
    fetch(`${API}/me/track`, { method: 'POST', credentials: 'same-origin',
      headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}),
      body: JSON.stringify({ type: item.type, id: item.id, symbol: item.symbol, name: item.name }) }).catch(() => {});
  }
  const uid = () => 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  function alCondText(a) {
    if (a.cond === 'price_above') return 'rises to ≥ ' + money(a.value, curBase);
    if (a.cond === 'price_below') return 'falls to ≤ ' + money(a.value, curBase);
    if (a.cond === 'pct_up') return 'up ' + a.value + '% or more today';
    if (a.cond === 'pct_down') return 'down ' + Math.abs(a.value) + '% or more today';
    return 'condition met';
  }
  function saveSAlerts() {
    try { localStorage.setItem('quantra.salerts', JSON.stringify(salerts)); } catch {}
    if (signedIn() && window.QuantraAuth.pushData) window.QuantraAuth.pushData({ alerts: salerts });
  }
  async function meGet() {
    if (!onServer || !signedIn()) return null;
    try { const t = window.QuantraAuth.token; const r = await fetch(`${API}/me/data`, { headers: t ? { Authorization: 'Bearer ' + t } : {}, credentials: 'same-origin' }); return r.ok ? await r.json() : null; } catch { return null; }
  }
  async function refreshAlertsFromServer() {
    const d = await meGet(); if (!d || !Array.isArray(d.alerts)) return;
    const wasActive = new Set(salerts.filter((a) => a.status === 'active').map((a) => a.id));
    salerts = d.alerts;
    salerts.filter((a) => a.status === 'triggered' && wasActive.has(a.id)).forEach((a) => R && R.toast && R.toast('🔔 ' + a.symbol + ' ' + alCondText(a)));
    try { localStorage.setItem('quantra.salerts', JSON.stringify(salerts)); } catch {}
    renderAlertsCard();
  }
  function setAlertAsset(item) {
    const card = $('alertsCard'); if (!card) return;
    card.hidden = false;
    if ($('alFor')) $('alFor').textContent = item.symbol;
    renderAlertsCard(); renderPwaButtons();
  }
  function createAlert() {
    if (!current) return R && R.toast && R.toast('Select an asset first.');
    const cond = $('alCond').value;
    const value = parseFloat(String($('alValue').value || '').replace(/[^0-9.\-]/g, ''));
    if (isNaN(value)) return R && R.toast && R.toast('Enter a value.');
    salerts.unshift({ id: uid(), assetId: current.id, symbol: current.symbol, name: current.name || current.symbol, assetType: current.type, cond, value, status: 'active', createdAt: Date.now() });
    if (salerts.length > 100) salerts = salerts.slice(0, 100);
    $('alValue').value = '';
    saveSAlerts(); renderAlertsCard();
    if (R && R.toast) R.toast(signedIn() ? `Alert set — we'll watch ${current.symbol} 24/7 and email you.` : `Alert saved on this device. Sign in for 24/7 monitoring + email.`);
  }
  function deleteAlert(id) { salerts = salerts.filter((a) => a.id !== id); saveSAlerts(); renderAlertsCard(); }
  function renderAlertsCard() {
    const note = $('alNote'), list = $('alList'); if (!list) return;
    if (note) note.textContent = signedIn()
      ? 'These run on our servers and email you the moment they trigger — even with Quantra closed.'
      : 'Saved on this device for now. Sign in to monitor 24/7 and get an email when they fire.';
    const mine = current ? salerts.filter((a) => a.assetId === current.id && a.assetType === current.type) : salerts;
    const ordered = mine.slice().sort((a, b) => (a.status === b.status ? b.createdAt - a.createdAt : a.status === 'active' ? -1 : 1));
    if (!ordered.length) { list.innerHTML = '<div class="alerts-empty">No alerts yet for this asset. Set one above.</div>'; return; }
    list.innerHTML = ordered.map((a) => `<div class="al-row">
      <span class="al-row__sym">${a.symbol}</span>
      <span class="al-row__cond">${alCondText(a)}${a.status === 'triggered' && a.triggeredPrice != null ? ' · hit ' + money(a.triggeredPrice, curBase) : ''}</span>
      <span class="al-row__status ${a.status}">${a.status === 'triggered' ? '✓ fired' : 'active'}</span>
      <button class="al-row__del" data-al="${a.id}" aria-label="delete alert">✕</button></div>`).join('');
    list.querySelectorAll('[data-al]').forEach((b) => b.addEventListener('click', () => deleteAlert(b.dataset.al)));
  }
  // PWA install + per-device push controls, shown inside the alerts card
  async function renderPwaButtons() {
    const el = $('alertsPwa'); if (!el || !window.QuantraPWA) return;
    const cfg = await window.QuantraPWA.pushConfig().catch(() => ({ enabled: false }));
    const st = await window.QuantraPWA.pushState().catch(() => 'unsupported');
    const parts = [];
    if (window.QuantraPWA.hasInstall()) parts.push('<button class="btn btn--ghost btn--sm" id="pwaInstall">📲 Install app</button>');
    if (cfg.enabled) {
      if (!signedIn()) parts.push('<span class="alerts-empty">Sign in to push alerts to this device.</span>');
      else if (st === 'on') parts.push('<button class="btn btn--ghost btn--sm" id="pwaPush" data-on="1">🔔 Push on · send test</button>');
      else if (st === 'denied') parts.push('<span class="alerts-empty">Push blocked in browser settings.</span>');
      else if (st !== 'unsupported') parts.push('<button class="btn btn--ghost btn--sm" id="pwaPush">🔔 Enable push on this device</button>');
    }
    el.innerHTML = parts.join('');
    const ib = $('pwaInstall'); if (ib) ib.addEventListener('click', () => window.QuantraPWA.promptInstall());
    const pb = $('pwaPush'); if (pb) pb.addEventListener('click', async () => {
      if (pb.dataset.on) {
        try { const t = localStorage.getItem('quantra.sid') || ''; const r = await fetch(`${API}/push/test`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t } }).then((x) => x.json()); R && R.toast && R.toast(r && r.ok ? 'Test push sent 🔔' : 'Could not send test.'); } catch { R && R.toast && R.toast('Could not send test.'); }
      } else {
        pb.disabled = true;
        const r = await window.QuantraPWA.enablePush();
        R && R.toast && R.toast(r.ok ? 'Push enabled on this device 🔔' : r.reason === 'denied' ? 'Notification permission denied.' : r.reason === 'unsupported' ? 'Push not supported on this browser.' : r.reason === 'signin' ? 'Sign in first.' : 'Push unavailable.');
        renderPwaButtons();
      }
    });
  }

  /* ---------------- bar replay ---------------- */
  let replay = { on: false, n: 0, timer: null };
  function sliceHist(h, n) {
    const out = {};
    for (const k of ['closes', 'dates', 'opens', 'highs', 'lows', 'volumes']) if (Array.isArray(h[k])) out[k] = h[k].slice(0, n);
    return out;
  }
  function drawReplay() {
    if (!state || !state.history || !state.history.closes) return;
    const total = state.history.closes.length;
    const n = Math.max(25, Math.min(replay.n, total));
    const sl = sliceHist(state.history, n);
    drawLine(sl, null, chartType === 'area');   // clean line + studies so they evolve as you scrub
    drawPanes(sl);
    const scrub = $('rpScrub'); if (scrub) scrub.value = String(Math.round((n / total) * 100));
    const iso = (state.history.dates && state.history.dates[n - 1]) || '';
    const dl = $('rpDate'); if (dl) dl.textContent = iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : n + '/' + total;
  }
  function enterReplay() {
    if (!state || !state.history || !state.history.closes || state.history.closes.length < 40) return R && R.toast && R.toast('Load a daily/longer chart to replay.');
    replay.on = true; replay.n = Math.floor(state.history.closes.length * 0.5);
    $('replayCtl').hidden = false; $('replayToggle').classList.add('is-on'); $('replayToggle').textContent = '⏏ Exit replay';
    drawReplay();
  }
  function exitReplay() {
    stopReplay(); replay.on = false;
    $('replayCtl').hidden = true; $('replayToggle').classList.remove('is-on'); $('replayToggle').textContent = '⏮ Replay';
    if (state && state.history) { redrawChart(); drawPanes(state.history); }
  }
  function stepReplay(d) {
    if (!replay.on) return;
    const total = state.history.closes.length;
    replay.n = Math.max(25, Math.min(total, replay.n + d));
    drawReplay();
    if (replay.n >= total) stopReplay();
  }
  function stopReplay() { if (replay.timer) { clearInterval(replay.timer); replay.timer = null; } const p = $('rpPlay'); if (p) p.textContent = '▶'; }
  function playReplay() {
    if (replay.timer) return stopReplay();
    const p = $('rpPlay'); if (p) p.textContent = '⏸';
    const speed = parseInt(($('rpSpeed') && $('rpSpeed').value) || '600', 10);
    replay.timer = setInterval(() => stepReplay(1), speed);
  }

  /* ---------------- saved chart layouts ---------------- */
  let layouts = [];
  try { layouts = JSON.parse(localStorage.getItem('quantra.layouts') || '[]'); } catch {}
  const STUDY_IDS = ['togRsi', 'togMacd', 'togVol', 'togStoch', 'togAdx', 'togWill', 'togCci', 'togBB', 'togMcg', 'togEma', 'togSar', 'togVwap', 'togSuper', 'togIchi', 'togKelt', 'togDon'];
  function curLayout() {
    const studies = {}; STUDY_IDS.forEach((id) => { if ($(id)) studies[id] = $(id).checked; });
    return { chartType, interval: $('intervalSel').value, range: $('rangeSel').value, studies };
  }
  function persistLayouts() {
    try { localStorage.setItem('quantra.layouts', JSON.stringify(layouts)); } catch {}
    if (window.QuantraAuth && window.QuantraAuth.user && window.QuantraAuth.pushData) window.QuantraAuth.pushData({ layouts });
  }
  function renderLayoutSel() {
    const sel = $('layoutSel'); if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">Layouts…</option>' + layouts.map((l, i) => `<option value="${i}">${escHtml(l.name)}</option>`).join('');
    if (cur && layouts[cur]) sel.value = cur;
    const del = $('layoutDel'); if (del) del.hidden = !sel.value;
  }
  function saveLayout() {
    const name = (prompt('Name this layout:') || '').trim(); if (!name) return;
    layouts = layouts.filter((l) => l.name !== name); layouts.push({ name, cfg: curLayout() });
    if (layouts.length > 20) layouts = layouts.slice(-20);
    persistLayouts(); renderLayoutSel();
    const sel = $('layoutSel'); if (sel) sel.value = String(layouts.length - 1);
    if ($('layoutDel')) $('layoutDel').hidden = false;
    R && R.toast && R.toast('Layout saved: ' + name);
  }
  function applyLayout(i) {
    const l = layouts[i]; if (!l) return; const c = l.cfg || {};
    chartType = c.chartType || 'line'; const cts = $('chartTypeSel'); if (cts) cts.value = chartType;
    try { localStorage.setItem('quantra.charttype', chartType); } catch {}
    // new layouts store {studies:{togX:bool}}; old ones store flat keys (back-compat)
    const st = c.studies || { togRsi: c.rsi !== false, togMacd: c.macd !== false, togVol: c.vol !== false, togStoch: !!c.stoch, togBB: !!c.bb, togMcg: !!c.mcg, togEma: !!c.ema, togSar: !!c.sar };
    STUDY_IDS.forEach((id) => { if ($(id) && id in st) $(id).checked = !!st[id]; });
    studyBB = !!st.togBB; studyMcg = !!st.togMcg; studyEma = !!st.togEma; studySar = !!st.togSar; studyVwap = !!st.togVwap; studySuper = !!st.togSuper; studyIchi = !!st.togIchi; studyKelt = !!st.togKelt; studyDon = !!st.togDon;
    try { [['bb', studyBB], ['mcg', studyMcg], ['ema', studyEma], ['sar', studySar], ['vwap', studyVwap], ['super', studySuper], ['ichi', studyIchi], ['kelt', studyKelt], ['don', studyDon]].forEach(([k, v]) => localStorage.setItem('quantra.' + k, v ? '1' : '0')); } catch {}
    $('intervalSel').value = c.interval || '1d'; fillRanges();
    if (c.range) { const ro = $('rangeSel'); if ([...ro.options].some((o) => o.value === c.range)) ro.value = c.range; }
    if ($('layoutDel')) $('layoutDel').hidden = false;
    if (current) select(current); else if (state && state.history) { redrawChart(); drawPanes(state.history); }
  }
  function deleteLayout() {
    const sel = $('layoutSel'); const i = sel && sel.value; if (i === '' || i == null) return;
    const l = layouts[i]; if (!l) return;
    layouts.splice(i, 1); persistLayouts(); renderLayoutSel();
    R && R.toast && R.toast('Layout deleted');
  }
  async function pullLayouts() {
    if (typeof meGet !== 'function') return;
    const d = await meGet(); if (d && Array.isArray(d.layouts)) { layouts = d.layouts; try { localStorage.setItem('quantra.layouts', JSON.stringify(layouts)); } catch {} renderLayoutSel(); }
  }

  /* ---------------- live seconds (tick) chart ---------------- */
  let lastTickT = 0;
  // Live self-scoring of the per-second projection: we log each projection with its due
  // time, then grade it against the real tick that arrives at/after that time — a genuine,
  // measured hit rate at the seconds scale (no back-fill, resets each session).
  let projPending = [], projScore = { band: 0, dir: 0, n: 0, perS: {} }, lastProjRec = 0;
  function pushTick(p) {
    if (!(p > 0)) return;
    const t = Date.now();
    const gap = lastTickT ? t - lastTickT : null; lastTickT = t;
    tickBuf.push({ t, p });
    const cut = t - tickWinMs;
    while (tickBuf.length > 2 && tickBuf[0].t < cut) tickBuf.shift();
    // grade any matured projections against this real tick (band hit + direction hit)
    if (projPending.length) {
      const still = [];
      for (const pp of projPending) {
        if (t < pp.dueAt) { still.push(pp); continue; }
        const inBand = p >= pp.lo && p <= pp.hi;
        const dirOk = pp.mid === pp.base ? true : Math.sign(p - pp.base) === Math.sign(pp.mid - pp.base);
        projScore.band += inBand ? 1 : 0; projScore.dir += dirOk ? 1 : 0; projScore.n++;
        const ps = projScore.perS[pp.s] || (projScore.perS[pp.s] = { band: 0, dir: 0, n: 0 });
        ps.band += inBand ? 1 : 0; ps.dir += dirOk ? 1 : 0; ps.n++;
      }
      projPending = still;
    }
    // live millisecond readout — real receive time + real inter-tick gap (genuine cadence)
    const tl = $('tickLive');
    if (tl && tickMode) {
      const d = new Date(t), ms = String(d.getMilliseconds()).padStart(3, '0');
      const hhmmss = d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      tl.hidden = false;
      tl.innerHTML = `<span class="tl-dot"></span><b>${hhmmss}.${ms}</b> · ${money(p, curBase)}${gap != null ? ` · <span class="tl-gap">+${gap} ms</span>` : ''}`;
    }
    if (!tickTimer) tickTimer = setTimeout(() => { tickTimer = null; if (tickMode) { drawTickChart(); renderTickProjection(); } }, 250);
  }
  function tickStats() {
    const n = tickBuf.length; if (n < 6) return null;
    const last = tickBuf[n - 1].p, first = tickBuf[0].p;
    const secs = (tickBuf[n - 1].t - tickBuf[0].t) / 1000 || 1;
    const driftPerSec = (last - first) / secs;
    let s = 0, c = 0; for (let i = 1; i < n; i++) { s += Math.abs(tickBuf[i].p - tickBuf[i - 1].p); c++; }
    const ticksPerSec = c / secs, volPerSec = (c ? s / c : 0) * Math.sqrt(Math.max(1, ticksPerSec));
    return { last, driftPerSec, volPerSec };
  }
  function drawTickChart() {
    const svg = $('chart'); if (!svg) return;
    const n = tickBuf.length;
    if (n < 2) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" fill="#6B7890" font-size="12" text-anchor="middle">Accumulating live ticks…</text>`; return; }
    const st = tickStats(), FS = 30, pj = [];
    // session-wide self-tuning width for the drawn cone (matches the projection table's target)
    const cScale = projScore.n >= 20 ? Math.max(0.75, Math.min(1.5, 1 + (0.8 - projScore.band / projScore.n) * 1.2)) : 1;
    if (st) for (let i = 1; i <= FS; i++) { const w = st.volPerSec * Math.sqrt(i) * 1.28 * cScale; pj.push({ mid: st.last + st.driftPerSec * i, lo: st.last + st.driftPerSec * i - w, hi: st.last + st.driftPerSec * i + w }); }
    const prices = tickBuf.map((d) => d.p);
    const allv = prices.concat(pj.flatMap((p) => [p.lo, p.hi]));
    const min = Math.min(...allv), max = Math.max(...allv), rng = max - min || 1;
    const total = n + pj.length, x = (i) => PAD + (i / (total - 1)) * (W - PAD * 2), y = (v) => H - PAD - ((v - min) / rng) * (H - PAD * 2);
    const line = prices.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const area = `${line} L ${x(n - 1).toFixed(1)} ${H - PAD} L ${PAD} ${H - PAD} Z`;
    let band = '', mid = '';
    if (pj.length) { const off = n; const hiP = pj.map((p, i) => `${i ? 'L' : 'M'}${x(off + i).toFixed(1)} ${y(p.hi).toFixed(1)}`).join(' '); band = `${hiP} ${pj.map((p, i) => `L${x(off + i).toFixed(1)} ${y(p.lo).toFixed(1)}`).reverse().join(' ')} Z`; mid = `M${x(off - 1).toFixed(1)} ${y(prices[n - 1]).toFixed(1)} ` + pj.map((p, i) => `L${x(off + i).toFixed(1)} ${y(p.mid).toFixed(1)}`).join(' '); }
    const up = prices[n - 1] >= prices[0], col = up ? '#34D399' : '#FB7185';
    svg.innerHTML = `
      <defs><linearGradient id="tf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".2"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
      <path d="${area}" fill="url(#tf)"/>
      ${band ? `<path d="${band}" fill="#22D3EE" opacity=".12"/>` : ''}
      <path d="${line}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>
      ${mid ? `<path d="${mid}" fill="none" stroke="#22D3EE" stroke-width="1.6" stroke-dasharray="5 4"/>` : ''}
      <circle cx="${x(n - 1).toFixed(1)}" cy="${y(prices[n - 1]).toFixed(1)}" r="3.4" fill="${col}"/>`;
    chartState = { total, histLen: n, vals: prices, dates: tickBuf.map((d) => new Date(d.t).toISOString()), fcMid: pj.map((p) => p.mid), yAt: y, xAt: x };
  }
  function renderTickProjection() {
    const card = $('projCard'); if (!card) return;
    const st = tickStats();
    if (!st) { $('projTable').innerHTML = ''; $('projAsof').textContent = 'Accumulating live ticks to project…'; card.hidden = false; return; }
    const now = Date.now();
    // Per-second horizons, down to the lowest the tick feed supports (+1s).
    const HS = [1, 2, 3, 5, 10, 20, 30];
    // Per-horizon self-tuning width: once a horizon has ≥15 graded projections, nudge its
    // band toward the 80% target using the MEASURED hit rate (too many misses → wider;
    // too easy → tighter). The displayed band and the graded band use the same width,
    // so the "Live hit" column always scores exactly what the user saw.
    const wScale = (s) => { const ps = projScore.perS[s]; return (ps && ps.n >= 15) ? Math.max(0.75, Math.min(1.5, 1 + (0.8 - ps.band / ps.n) * 1.2)) : 1; };
    // Log fresh projections (~1×/sec) so pushTick can grade them once they mature.
    if (now - lastProjRec > 1000) {
      lastProjRec = now;
      for (const s of HS) { const mid = st.last + st.driftPerSec * s, w = st.volPerSec * Math.sqrt(s) * 1.28 * wScale(s); projPending.push({ dueAt: now + s * 1000, base: st.last, mid, lo: mid - w, hi: mid + w, s }); }
      if (projPending.length > 800) projPending = projPending.slice(-800);
    }
    const rows = HS.map((s) => {
      const mid = st.last + st.driftPerSec * s, w = st.volPerSec * Math.sqrt(s) * 1.28 * wScale(s), up = st.driftPerSec >= 0;
      const d = new Date(now + s * 1000);
      const ps = projScore.perS[s];
      const hit = ps && ps.n ? `${Math.round(100 * ps.band / ps.n)}% <small>n=${ps.n}</small>` : '<span class="proj-wait">—</span>';
      return `<tr><td>${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}<small>+${s}s</small></td><td class="proj-px">${money(mid, curBase)}</td><td class="proj-rng">${money(mid - w, curBase)} – ${money(mid + w, curBase)}</td><td class="proj-d ${up ? 'up' : 'down'}">${up ? '+' : ''}${((mid / st.last - 1) * 100).toFixed(2)}%</td><td class="proj-hit">${hit}</td></tr>`;
    }).join('');
    $('projTable').innerHTML = '<tr><th>Time</th><th>Projected</th><th>Range (P10–P90)</th><th>Δ vs now</th><th>Live hit</th></tr>' + rows;
    const sc = projScore.n ? ` Live hit rate this session: band ${Math.round(100 * projScore.band / projScore.n)}% · direction ${Math.round(100 * projScore.dir / projScore.n)}% (n=${projScore.n}); band widths self-tune toward the 80% target from the measured hit rate.` : '';
    $('projAsof').textContent = 'Live per-second projection from the last ' + tickBuf.length + ' ticks — down to a +1s horizon; very short, high uncertainty, not a guarantee.' + sc;
    card.hidden = false;
  }
  function startTickChart() {
    tickBuf = []; lastTickT = 0;
    projPending = []; projScore = { band: 0, dir: 0, n: 0, perS: {} }; lastProjRec = 0;
    const tl = $('tickLive'); if (tl) { tl.hidden = false; tl.innerHTML = '<span class="tl-dot"></span>Waiting for the first live tick…'; }
    if (state && state.history && state.history.closes && state.history.closes.length) tickBuf.push({ t: Date.now(), p: state.history.closes[state.history.closes.length - 1] });
    drawTickChart(); renderTickProjection();
  }
  function stopTick() { tickMode = false; if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; } const tl = $('tickLive'); if (tl) tl.hidden = true; }

  /* ---------------- Quantra Score + watchlist ---------------- */
  const scoreColor = (q) => q >= 70 ? '#34D399' : q >= 56 ? '#22D3EE' : q >= 45 ? '#FBBF24' : '#FB7185';
  function setScore(res) {
    const el = $('qScore');
    if (res && res.quantraScore != null) { el.hidden = false; el.innerHTML = `<i>SCORE</i> ${res.quantraScore} · ${res.scoreGrade}`; const c = scoreColor(res.quantraScore); el.style.color = c; el.style.borderColor = c + '66'; }
    else el.hidden = true;
  }
  const WATCH_KEY = 'quantra.watch';
  const getWatch = () => { try { return JSON.parse(localStorage.getItem(WATCH_KEY) || '[]'); } catch { return []; } };
  const setWatch = (a) => { const t = a.slice(0, 60); try { localStorage.setItem(WATCH_KEY, JSON.stringify(t)); } catch {} if (window.QuantraAuth && window.QuantraAuth.user) window.QuantraAuth.pushWatch(t); };
  const isWatched = (it) => getWatch().some((w) => w.id === it.id && w.type === it.type);
  function updateStar(it) { const s = $('wStar'); const on = isWatched(it); s.classList.toggle('on', on); s.textContent = on ? '★' : '☆'; s.setAttribute('aria-pressed', String(on)); s.title = on ? 'Remove from watchlist' : 'Add to watchlist'; }
  function toggleWatch(it) { let a = getWatch(); const was = a.some((w) => w.id === it.id && w.type === it.type); a = was ? a.filter((w) => !(w.id === it.id && w.type === it.type)) : [{ id: it.id, type: it.type, symbol: it.symbol, name: it.name || it.symbol }, ...a]; setWatch(a); updateStar(it); R.toast(was ? 'Removed from watchlist' : 'Added to watchlist'); }

  /* ---------------- select + analyze ---------------- */
  async function select(item) {
    current = item;
    trackView(item);   // personalization: learn what this user watches (signed-in only, fire-and-forget)
    idxMode = (item.type === 'index');   // show index detail in points, not FX-converted
    stopLive(); stopTick();
    if (replay.on) { stopReplay(); replay.on = false; const rc = $('replayCtl'); if (rc) rc.hidden = true; const rtg = $('replayToggle'); if (rtg) { rtg.classList.remove('is-on'); rtg.textContent = '⏮ Replay'; } }
    let interval = $('intervalSel').value, range = $('rangeSel').value;
    let secMode = interval === 'sec';
    if (secMode) {
      const supported = item.type === 'crypto' || ((item.type === 'stock' || item.type === 'etf') && live.finnhub);
      if (!supported) {
        R.toast((item.type === 'stock' || item.type === 'etf') ? 'Live seconds needs a Finnhub key (set on the server).' : 'Live seconds is available for crypto, stocks and ETFs.');
        interval = '1m'; $('intervalSel').value = '1m'; fillRanges(); range = $('rangeSel').value; secMode = false;
      }
    }
    const dataInterval = secMode ? '1m' : interval, dataRange = secMode ? '1d' : range;
    if (secMode) tickWinMs = secWindowMs(range);
    $('dTicker').textContent = item.symbol + (item.type === 'crypto' ? ' / USD' : '');
    $('dText').textContent = 'Crunching technicals + fundamentals…';
    $('indis').innerHTML = ''; $('fcast').hidden = true;
    $('newsLink').href = item.type === 'stock' ? `news.html?symbol=${encodeURIComponent(item.id)}` : 'news.html';
    document.querySelectorAll('.trow').forEach((r) => r.classList.toggle('is-sel', r.dataset.id === item.id));

    $('aiBadge').hidden = true;
    try {
      const [hist, fund, peers, news] = await Promise.all([loadChart(item, dataRange, dataInterval), loadFundamentals(item), loadPeers(item), loadNews(item)]);
      // Anchor the chart's last point + analysed price to the board's LIVE price (Finnhub for US,
      // latest market price otherwise). The chart history comes from Yahoo/CoinGecko, whose last
      // bar lags the real-time quote — without this the line ends below/above the displayed price
      // and looks "inaccurate". Only nudge when the live price is sane (within 25% of last close).
      const bi = board.find((b) => b.id === item.id) || {};
      if (!secMode && bi.price != null && isFinite(bi.price) && hist.closes && hist.closes.length) {
        const i = hist.closes.length - 1, lc = hist.closes[i];
        if (lc && Math.abs(bi.price - lc) / lc < 0.25) {
          hist.closes[i] = bi.price;
          if (hist.highs && hist.highs[i] != null) hist.highs[i] = Math.max(hist.highs[i], bi.price);
          if (hist.lows && hist.lows[i] != null) hist.lows[i] = Math.min(hist.lows[i], bi.price);
          if (hist.opens && hist.opens[i] == null) hist.opens[i] = lc;
        }
      }
      curBase = (item.type === 'crypto') ? 'USD' : (hist.currency || (fund && fund.currency) || 'USD');
      const sent = Q.sentiment(news);
      const cal = await getLiveCal();
      const res = Q.analyze(hist, item.name || item.symbol, fund, sent, { cal: cal.scale });
      if (!res) { $('dText').textContent = 'Not enough history to analyse this asset yet.'; return; }

      // compare symbol?
      let compare = null;
      const cmpSym = $('compareInput').value.trim().toUpperCase();
      if (cmpSym && cmpSym !== item.symbol.toUpperCase()) {
        try {
          const cmpItem = item.type === 'crypto' ? (await doSearch(cmpSym))[0] : { type: 'stock', id: cmpSym, symbol: cmpSym };
          if (cmpItem) { const ch = await loadChart(cmpItem, range, interval); const byDate = new Map(); ch.dates.forEach((d, i) => byDate.set(d.slice(0, 10), ch.closes[i])); compare = { symbol: cmpSym, byDate }; }
        } catch {}
      }

      state = { symbol: item.symbol, name: item.name || item.symbol, type: item.type, range, interval, analysis: res, fundamentals: fund, history: hist, compare,
        cur: selCur, fxRates, priceBase: curBase, fundBase: (fund && fund.currency) || 'USD' };

      const up = res.verdict.dir !== 'down';
      $('dPrice').textContent = money(res.price, curBase);
      const chg = bi.change24h, chgAbs = bi.changeAbs;
      const chip = $('dChange');
      if (chg != null) {
        const absStr = (chgAbs != null) ? ' · ' + signedMoney(chgAbs, curBase) : '';
        chip.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%${absStr}`;
        chip.className = 'chip chip--' + (chg >= 0 ? 'up' : 'down');
      } else { chip.textContent = res.verdict.trend; chip.className = 'chip chip--' + (up ? 'up' : res.verdict.dir === 'down' ? 'down' : 'neutral'); }
      const SUBS = { crypto: 'Cryptocurrency · 24/7 market', stock: 'Equity / stock', etf: 'Exchange-traded fund', commodity: 'Commodity / futures', index: 'Market index', fx: 'Foreign exchange pair' };
      $('dSub').textContent = SUBS[item.type] || '—';   // always set (fundamentals may refine it for stocks)
      // Market open/closed badge (per-exchange session window from Yahoo).
      renderDetailBadge();
      // Data-freshness line: free feeds (esp. non-US/Gulf/Asian exchanges) can lag the
      // live market, so show exactly when this price is from instead of looking "wrong".
      { const af = $('dAsOf'); const mt = hist && hist.meta && hist.meta.regularMarketTime; const tz = hist && hist.meta && hist.meta.exchangeTimezoneName;
        const tMs = bi.asOf || (mt ? mt * 1000 : null);
        if (af) {
          if (item.type !== 'crypto' && tMs) {
            const ageMin = (Date.now() - tMs) / 60000;
            const st = mktState(item.type, bi.tp || tpFromMeta(hist && hist.meta), bi.mktOpen, bi.holiday);
            const open = st && st.open;
            const tstr = new Date(tMs).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz || undefined });
            // Only call it "delayed" when the market is OPEN and the price is stale; when
            // closed it's simply the last close (not a feed problem), and fresh = live.
            const tail = !open ? ' · at last close' : (ageMin > 8 ? ' · delayed feed' : ' · live');
            af.textContent = `Price as of ${tstr}${tz ? ' · ' + tz.split('/').pop().replace(/_/g, ' ') : ''}${tail}`;
            af.className = 'das-of' + (open && ageMin > 8 ? ' is-stale' : ''); af.hidden = false;
          } else { af.hidden = true; }
        } }

      setScore(res); updateStar(item);
      $('mTrend').textContent = res.verdict.trend; $('mRR').textContent = res.verdict.rr;
      $('mConf').textContent = res.verdict.confidence; $('mAcc').textContent = res.verdict.accuracy;
      setNewsMeter(sent && sent.count ? sent.label : null, sent ? sent.score : null);
      const ind = res.indicators;
      $('indis').innerHTML = [
        ['RSI 14', ind.rsi != null ? Math.round(ind.rsi) : '—'],
        ['SMA 20', money(ind.sma20, curBase)],
        ['SMA 50', ind.sma50 ? money(ind.sma50, curBase) : '—'],
        ['SMA 200', ind.sma200 ? money(ind.sma200, curBase) : '—'],
        ['MACD', ind.macd ? (ind.macd.hist >= 0 ? '+' : '') + ind.macd.hist.toFixed(2) : '—'],
        ['ADX', ind.adx != null ? Math.round(ind.adx) : '—'],
        ['Stoch %K', ind.stoch != null ? Math.round(ind.stoch) : '—'],
        ['Boll %B', ind.bollPctB != null ? ind.bollPctB.toFixed(2) : '—'],
        ['ATR', ind.atr != null ? money(ind.atr, curBase) : '—'],
        ['Support', money(ind.support, curBase)],
        ['Resistance', money(ind.resistance, curBase)],
      ].map(([k, v]) => `<span class="indi"><i>${k}</i>${v}</span>`).join('');

      // signal breakdown
      const sw = $('sigwrap');
      if (res.signals && res.signals.length) {
        sw.hidden = false;
        $('sigTally').textContent = `· ${res.signalTally.up} bullish / ${res.signalTally.down} bearish of ${res.signalTally.total}`;
        $('signals').innerHTML = res.signals.map((s) => {
          const arrow = s.dir === 'up' ? '▲' : s.dir === 'down' ? '▼' : '—';
          return `<div class="signal ${s.dir}"><span class="signal__dot"></span><div class="signal__body"><div class="signal__name">${s.name}</div><div class="signal__note">${s.note}</div></div><span class="signal__arrow">${arrow}</span></div>`;
        }).join('');
      } else sw.hidden = true;

      candleHist = null;
      if (secMode) {
        // live seconds: stream ticks into a rolling chart (analysis above uses 1m data for context)
        tickMode = true; startTickChart();
      } else {
        // candle source: crypto needs real OHLC from Coinbase; others already have it in hist
        if ((chartType === 'candle' || chartType === 'heikin') && item.type === 'crypto') {
          try { candleHist = await getJSON(`${API}/crypto/ohlc?symbol=${encodeURIComponent(item.symbol)}&interval=${interval}`); } catch { candleHist = null; }
        }
        drawChart(hist, res.forecast);
        renderProjections(res.forecast, hist, item);
      }
      drawPanes(hist);
      renderPatterns(secMode ? null : (candleHist || hist));
      setTool(null); renderAlerts();
      typeOut($('dText'), res.text);
      renderPeers(peers);
      renderNews(sent, item);
      state.news = sent;
      setAskAsset(item);
      setAlertAsset(item);

      // upgrade the verdict with the AI reasoning engine when a key is configured
      const badge = $('aiBadge');
      badge.hidden = false; badge.className = 'ai-badge thinking'; badge.textContent = '✦ AI thinking…';
      const ind2 = res.indicators;
      const aiPayload = {
        asset: item.name || item.symbol, symbol: item.symbol, type: item.type, price: res.price,
        verdict: res.verdict,
        technical: { rsi: ind2.rsi && Math.round(ind2.rsi), macdHist: ind2.macd && +ind2.macd.hist.toFixed(2), adx: ind2.adx && Math.round(ind2.adx), sma20: ind2.sma20, sma50: ind2.sma50, sma200: ind2.sma200, support: ind2.support, resistance: ind2.resistance },
        signals: res.signals.map((s) => ({ name: s.name, dir: s.dir, note: s.note })),
        walkForward: res.walkForward && { oosAccuracy: +(res.walkForward.oosAccuracy).toFixed(3), top: res.walkForward.top },
        forecast: res.forecast && { expReturn: +(res.forecast.expReturn).toFixed(3), probUp: +(res.forecast.probUp).toFixed(2), annualVol: +(res.forecast.annualVol).toFixed(3) },
        regime: res.regime && { label: res.regime.label, volatility: res.regime.vol },
        fundamentals: fund && { sector: fund.sector, peTrailing: fund.peTrailing, roe: fund.roe, profitMargin: fund.profitMargin, debtToEquity: fund.debtToEquity, revenueGrowth: fund.revenueGrowth, estimates: fund.estimates, recBreakdown: fund.recBreakdown },
        news: sent && { label: sent.label, score: +sent.score.toFixed(2), positive: sent.pos, negative: sent.neg, headlines: sent.scored.slice(0, 8).map((n) => n.title) },
      };
      const myToken = ++aiToken;
      reasonAI(aiPayload).then((r) => {
        if (myToken !== aiToken) return; // user moved on
        if (r && r.ok && r.text) {
          state.aiText = r.text; typeOut($('dText'), r.text);
          badge.className = 'ai-badge'; badge.textContent = '✦ Quantra AI';
          if (typeof r.newsImpact === 'number') {
            // recompute the forecast with the AI's comprehension-based news impact
            const fc2 = Q.forecast(state.history.closes, 30, r.newsImpact, { cal: (liveCal && liveCal.scale) || 1 });
            if (fc2) { state.analysis.forecast = fc2; if (!tickMode) { drawChart(state.history, fc2); renderProjections(fc2, state.history, item); } renderForecast(fc2); }
            const lab = r.stance === 'bullish' ? 'Positive' : r.stance === 'bearish' ? 'Negative' : 'Neutral';
            setNewsMeter(lab, r.newsImpact, ' · AI');
            const nb = $('newsSentiment');
            if (nb && !$('newsCard').hidden) {
              nb.textContent = `${lab} · ${r.newsImpact >= 0 ? '+' : ''}${r.newsImpact.toFixed(2)} · AI`;
              nb.className = 'grade sent-' + (lab === 'Positive' ? 'pos' : lab === 'Negative' ? 'neg' : 'neu');
            }
            if (r.rationale) {
              state.newsRationale = r.rationale;
              const nr = $('newsRationale');
              if (nr && !$('newsCard').hidden) { nr.hidden = false; nr.innerHTML = `<span class="nr-tag">AI news read</span> ${escHtml(r.rationale)}`; }
            }
          }
        } else {
          badge.className = 'ai-badge rule';
          const reason = r && r.reason;
          badge.textContent = reason === 'upgrade' ? 'rule-based · upgrade for AI verdicts'
            : reason === 'limit' ? 'rule-based · AI daily limit reached'
            : reason === 'no-key' ? 'rule-based · AI not configured'
            : 'rule-based';
        }
      });

      renderForecast(res.forecast);
      const rg = $('fcRegime');
      if (rg) { rg.textContent = res.regime ? res.regime.label : '—'; rg.style.color = res.regime && res.regime.label.includes('up') ? 'var(--mint)' : res.regime && res.regime.label.includes('down') ? 'var(--rose)' : 'var(--amber)'; }
      $('newsRationale').hidden = true;
      renderFundamentals(fund);
      startLive(item);
    } catch (e) { $('dText').textContent = 'Could not load data for ' + item.symbol + '.'; }
  }

  /* ---------------- live streaming ---------------- */
  async function loadLiveConfig() { try { live = await getJSON(`${API}/config`); } catch {} }
  function liveTag(on, label) {
    let t = $('liveTag');
    if (!t) { const h = document.querySelector('.dhead'); if (!h) return; t = document.createElement('span'); t.id = 'liveTag'; t.className = 'live-tag'; h.insertBefore(t, h.children[1] || null); }
    t.hidden = !on; if (on) t.innerHTML = '<span class="live-dot"></span>' + (label || 'LIVE');
  }
  function setDetailPrice(p) { const dp = $('dPrice'); if (!dp) return; dp.textContent = money(p, curBase); dp.classList.remove('tick'); void dp.offsetWidth; dp.classList.add('tick'); if (current) checkAlerts(current.type, current.symbol, p); }
  function updateRowPrice(it) {
    const list = $('list'); if (!list) return;
    const row = list.querySelector('.trow[data-type="' + it.type + '"][data-symbol="' + it.symbol + '"]');
    const c = row && row.querySelector('.trow__price'); if (c) c.textContent = money(it.price, it.currency);
    checkAlerts(it.type, it.symbol, it.price);
  }
  // Non-crypto boards (stocks/ETFs/commodities/indices/FX) have no WS stream — poll
  // periodically so their prices stay current with the live market.
  async function refreshBoardPrices() {
    if (!onServer || !board.length || assetClass === 'crypto') return;
    let fresh; try { fresh = await loadBoard(assetClass); } catch { return; }
    const byId = new Map(fresh.map((f) => [f.id, f]));
    const list = $('list');
    board.forEach((b) => {
      const f = byId.get(b.id); if (!f || f.price == null) return;
      b.price = f.price; b.change24h = f.change24h; b.changeAbs = f.changeAbs; b.tp = f.tp; b.asOf = f.asOf; updateRowPrice(b);
      const row = list && list.querySelector('.trow[data-id="' + b.id + '"]');
      const cg = row && row.querySelector('.trow__chg');
      if (cg && f.change24h != null) { const up = f.change24h >= 0; cg.textContent = (up ? '+' : '') + f.change24h.toFixed(2) + '%'; cg.className = 'trow__chg ' + (up ? 'up' : 'down'); }
    });
    if (current && !tickMode) { const f = byId.get(current.id); if (f && f.price != null) setDetailPrice(f.price); }
  }
  // Crypto: one Coinbase public WS (ticker channel) for the whole board + the
  // selected coin. Sub-second per-trade updates, and US-accessible (unlike Binance).
  const coinProd = (sym) => (sym || '').toUpperCase() + '-USD';
  function startArr() {
    stopArr();
    if (!live.cryptoStream || !onServer || assetClass !== 'crypto') return;
    const byProd = new Map(board.filter((b) => b.type === 'crypto').map((b) => [coinProd(b.symbol), b]));
    coinSubs = new Set(byProd.keys());
    if (!coinSubs.size) return;
    try {
      arrWS = new WebSocket('wss://ws-feed.exchange.coinbase.com');
      arrWS.onopen = () => { try { arrWS.send(JSON.stringify({ type: 'subscribe', product_ids: [...coinSubs], channels: ['ticker'] })); } catch {} };
      arrWS.onmessage = (ev) => {
        let d; try { d = JSON.parse(ev.data); } catch { return; }
        if (!d || d.type !== 'ticker' || !d.product_id) return;
        const p = parseFloat(d.price); if (!(p > 0)) return;
        const it = byProd.get(d.product_id);
        if (it) { it.price = p; updateRowPrice(it); }
        if (current && current.type === 'crypto' && coinProd(current.symbol) === d.product_id) { setDetailPrice(p); if (tickMode) pushTick(p); }
      };
    } catch {}
  }
  function stopArr() { if (arrWS) { try { arrWS.close(); } catch {} arrWS = null; } coinSubs = null; }
  // Ensure the selected coin streams (it may not be in the board, e.g. via search).
  function startTrade(sym) {
    if (!live.cryptoStream || !onServer) return;
    const prod = coinProd(sym);
    if (arrWS) {
      // board feed exists (open or connecting) — it already handles the detail price.
      if (!coinSubs || !coinSubs.has(prod)) {
        const sub = () => { try { arrWS.send(JSON.stringify({ type: 'subscribe', product_ids: [prod], channels: ['ticker'] })); coinSubs && coinSubs.add(prod); } catch {} };
        if (arrWS.readyState === 1) sub(); else arrWS.addEventListener('open', sub, { once: true });
      }
      liveTag(true, 'LIVE · Coinbase');
      return;
    }
    // no board feed (e.g. deep-link before board loads) — dedicated socket
    try {
      tradeWS = new WebSocket('wss://ws-feed.exchange.coinbase.com');
      tradeWS.onopen = () => { try { tradeWS.send(JSON.stringify({ type: 'subscribe', product_ids: [prod], channels: ['ticker'] })); liveTag(true, 'LIVE · Coinbase'); } catch {} };
      tradeWS.onmessage = (ev) => { try { const d = JSON.parse(ev.data); if (d.type === 'ticker' && current && current.type === 'crypto' && coinProd(current.symbol) === d.product_id) { const p = parseFloat(d.price); if (p > 0) { setDetailPrice(p); if (tickMode) pushTick(p); } } } catch {} };
    } catch {}
  }
  function stopTrade() { if (tradeWS) { try { tradeWS.close(); } catch {} tradeWS = null; } }
  // Selected stock/ETF: poll Finnhub real-time quote every ~4s (key stays server-side).
  function startQuote(item) {
    stopQuote();
    if (!live.finnhub || !onServer || (item.type !== 'stock' && item.type !== 'etf')) return;
    const tick = async () => {
      try {
        const q = await getJSON(`${API}/stock/quote?symbol=${encodeURIComponent(item.id)}`);
        if (q && q.ok && q.price && current && current.id === item.id) { item.price = q.price; setDetailPrice(q.price); updateRowPrice(item); liveTag(true, 'LIVE · Finnhub'); }
      } catch {}
    };
    tick(); quoteTimer = setInterval(tick, 2000);   // real-time US quote, snappier
  }
  function stopQuote() { if (quoteTimer) { clearInterval(quoteTimer); quoteTimer = null; } }
  // Live seconds for stocks/ETFs: poll Finnhub real-time quote ~1s and feed the tick chart.
  function startStockTick(item) {
    stopQuote();
    if (!live.finnhub || !onServer) return;
    const tick = async () => {
      try {
        const q = await getJSON(`${API}/stock/quote?symbol=${encodeURIComponent(item.id)}`);
        if (q && q.ok && q.price && current && current.id === item.id) { item.price = q.price; setDetailPrice(q.price); updateRowPrice(item); if (tickMode) pushTick(q.price); liveTag(true, 'LIVE · Finnhub ~1s'); }
      } catch {}
    };
    tick(); quoteTimer = setInterval(tick, 1200);
  }
  // True tick-by-tick stock/ETF stream via the server's Finnhub SSE relay.
  // Falls back to ~1s polling if the stream sends nothing (relay off / market closed).
  function startStockStream(item) {
    stopStockStream();
    if (!live.finnhub || !onServer) return;
    if (typeof EventSource === 'undefined') { startStockTick(item); return; }
    let gotTick = false;
    try {
      stockES = new EventSource(`${API}/stream/trades?symbol=${encodeURIComponent(item.id)}`);
      stockES.onmessage = (ev) => {
        try { const d = JSON.parse(ev.data); const p = +d.p; if (p > 0 && current && current.id === item.id) { gotTick = true; item.price = p; setDetailPrice(p); updateRowPrice(item); if (tickMode) pushTick(p); liveTag(true, 'LIVE · Finnhub ticks'); } } catch {}
      };
    } catch { startStockTick(item); return; }
    stockWatch = setTimeout(() => { if (!gotTick && current && current.id === item.id) { stopStockStream(); startStockTick(item); } }, 6000);
  }
  function stopStockStream() { if (stockES) { try { stockES.close(); } catch {} stockES = null; } if (stockWatch) { clearTimeout(stockWatch); stockWatch = null; } }
  function stopLive() { stopTrade(); stopQuote(); stopStockStream(); liveTag(false); }
  function startLive(item) { if (item.type === 'crypto') startTrade(item.symbol); else if (tickMode) startStockStream(item); else startQuote(item); }

  /* ---------------- controls ---------------- */
  document.querySelectorAll('.seg__btn').forEach((b) => b.addEventListener('click', () => switchClass(b.dataset.class)));
  updateForYouTab(); window.addEventListener('quantra:limits', updateForYouTab); setTimeout(updateForYouTab, 2000);
  function fillRanges() {
    const intr = $('intervalSel').value, opts = RANGES[intr] || RANGES['1d'], cur = $('rangeSel').value;
    $('rangeSel').innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    $('rangeSel').value = opts.some((o) => o[0] === cur) ? cur : DEFAULT_RANGE[intr];
  }
  $('intervalSel').addEventListener('change', () => {
    fillRanges(); if (current) select(current);
  });
  $('rangeSel').addEventListener('change', () => current && select(current));
  $('compareInput').addEventListener('change', () => current && select(current));
  const ctSel = $('chartTypeSel');
  if (ctSel) { ctSel.value = chartType; ctSel.addEventListener('change', () => { chartType = ctSel.value; try { localStorage.setItem('quantra.charttype', chartType); } catch {} if (current) select(current); }); }
  ['togRsi', 'togMacd', 'togVol', 'togStoch', 'togAdx', 'togWill', 'togCci'].forEach((id) => { const el = $(id); if (el) el.addEventListener('change', () => { if (state && state.history) drawPanes(state.history); }); });
  // price-overlay study toggles: persist + redraw the chart
  [['togBB', 'bb', studyBB, (v) => studyBB = v], ['togMcg', 'mcg', studyMcg, (v) => studyMcg = v], ['togEma', 'ema', studyEma, (v) => studyEma = v], ['togSar', 'sar', studySar, (v) => studySar = v],
   ['togVwap', 'vwap', studyVwap, (v) => studyVwap = v], ['togSuper', 'super', studySuper, (v) => studySuper = v], ['togIchi', 'ichi', studyIchi, (v) => studyIchi = v], ['togKelt', 'kelt', studyKelt, (v) => studyKelt = v], ['togDon', 'don', studyDon, (v) => studyDon = v]].forEach(([id, key, init, set]) => {
    const el = $(id); if (!el) return;
    el.checked = init;
    el.addEventListener('change', () => { set(el.checked); try { localStorage.setItem('quantra.' + key, el.checked ? '1' : '0'); } catch {} if (replay.on) drawReplay(); else redrawChart(); });
  });
  // bar replay wiring
  { const rt = $('replayToggle'); if (rt) rt.addEventListener('click', () => (replay.on ? exitReplay() : enterReplay()));
    const rb = $('rpBack'); if (rb) rb.addEventListener('click', () => stepReplay(-1));
    const rf = $('rpFwd'); if (rf) rf.addEventListener('click', () => stepReplay(1));
    const rp = $('rpPlay'); if (rp) rp.addEventListener('click', playReplay);
    const rs = $('rpScrub'); if (rs) rs.addEventListener('input', () => { if (!replay.on || !state || !state.history) return; replay.n = Math.max(25, Math.round((+rs.value / 100) * state.history.closes.length)); stopReplay(); drawReplay(); });
    const rsp = $('rpSpeed'); if (rsp) rsp.addEventListener('change', () => { if (replay.timer) { stopReplay(); playReplay(); } }); }
  // saved layouts wiring
  { const ls = $('layoutSel'); if (ls) ls.addEventListener('change', () => { if (ls.value !== '') applyLayout(+ls.value); else if ($('layoutDel')) $('layoutDel').hidden = true; });
    const lsv = $('layoutSave'); if (lsv) lsv.addEventListener('click', saveLayout);
    const ld = $('layoutDel'); if (ld) ld.addEventListener('click', deleteLayout);
    renderLayoutSel(); window.addEventListener('quantra:synced', pullLayouts); pullLayouts(); }
  // drawing tools + alerts wiring
  { const tT = $('toolTrend'), tH = $('toolHline'), tC = $('toolClear'), aA = $('alertAdd'), aP = $('alertPrice'), chartEl = $('chart');
    if (tT) tT.addEventListener('click', () => setTool(activeTool === 'trend' ? null : 'trend'));
    const tF = $('toolFib'); if (tF) tF.addEventListener('click', () => setTool(activeTool === 'fib' ? null : 'fib'));
    if (tH) tH.addEventListener('click', () => setTool(activeTool === 'hline' ? null : 'hline'));
    if (tC) tC.addEventListener('click', clearDrawings);
    if (aA) aA.addEventListener('click', addAlert);
    if (aP) aP.addEventListener('keydown', (e) => { if (e.key === 'Enter') addAlert(); });
    if (chartEl) chartEl.addEventListener('pointerdown', onChartDown); }
  // enlarge / shrink chart
  { const cb = $('chartBig'); if (cb) { cb.textContent = enlarged ? '⤡ Shrink' : '⤢ Enlarge'; cb.classList.toggle('is-on', enlarged); cb.addEventListener('click', () => setEnlarged(!enlarged)); }
    const chart = $('chart'); if (chart) chart.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const term = document.querySelector('.term'); if (term) term.classList.toggle('is-enlarged', enlarged); }
  setupChartHover();
  fillRanges();
  function gateFeature(flag, msg) {
    const L = window.QuantraAuth && window.QuantraAuth.limits;
    if (L && !L[flag]) { R.toast(msg + ' — upgrade in your account.'); const b = $('acctBtn'); if (b) b.click(); return false; }
    return true;
  }
  $('btnExcel').addEventListener('click', () => { if (!state) return R.toast('Pick an asset first'); if (gateFeature('exports', 'Exports are a Pro feature')) R.exportExcel(state); });
  $('btnPdf').addEventListener('click', () => { if (!state) return R.toast('Pick an asset first'); if (gateFeature('exports', 'PDF reports are a Pro feature')) R.exportPDF(state); });

  const CUR_KEY = 'quantra.currency';
  const validCur = (c) => !!CUR_SYM[c];
  // restore saved currency
  try { const saved = localStorage.getItem(CUR_KEY); if (saved && validCur(saved)) { selCur = saved; $('curSel').value = saved; } } catch (_) {}

  function applyCurrency(cur, rerender) {
    if (!validCur(cur)) return;
    selCur = cur;
    try { localStorage.setItem(CUR_KEY, selCur); } catch (_) {}
    if ($('curSel')) $('curSel').value = selCur;
    if (window.QuantraAuth && window.QuantraAuth.user) window.QuantraAuth.pushData({ prefs: { currency: selCur } });
    if (rerender !== false) { renderBoard(); if (current) select(current); }
  }
  $('curSel').addEventListener('change', (e) => applyCurrency(e.target.value));

  // Stock markets: populate the exchange selector; currency follows the exchange.
  async function initMarkets() {
    const sel = $('marketSel'); if (!sel || !onServer) return;
    try { const m = await getJSON(`${API}/stock/markets`); if (Array.isArray(m) && m.length) stockMarkets = m; } catch {}
    if (!stockMarkets.some((m) => m.id === stockMarket)) stockMarket = 'us';
    sel.innerHTML = stockMarkets.map((m) => `<option value="${m.id}">${m.label} · ${m.ccy}</option>`).join('');
    sel.value = stockMarket;
    sel.addEventListener('change', () => {
      stockMarket = sel.value;
      try { localStorage.setItem('quantra.market', stockMarket); } catch {}
      const mk = stockMarkets.find((m) => m.id === stockMarket);
      if (mk) applyCurrency(mk.ccy, false);     // currency follows the exchange (re-render via switchClass)
      switchClass('stock');
    });
  }
  initMarkets();

  // when an account syncs, adopt its currency + refresh the watchlist UI
  window.addEventListener('quantra:synced', () => {
    try { const c = localStorage.getItem(CUR_KEY); if (c && CUR_SYM[c]) { selCur = c; $('curSel').value = c; } } catch (_) {}
    if (board.length) renderBoard();
    if (current) { updateStar(current); select(current); }
  });

  $('wStar').addEventListener('click', () => { if (current) toggleWatch(current); });

  loadFX().then(() => { if (board.length) renderBoard(); if (current) select(current); });
  // start live streams once we know which sources are available (covers any load ordering)
  loadLiveConfig().then(() => { if (assetClass === 'crypto' && board.length) startArr(); if (current) startLive(current); });
  setInterval(refreshBoardPrices, 8000);   // keep non-crypto board prices current
  setInterval(tickMarketStatus, 20000);     // flip open/closed dots live at session boundaries
  if ($('askqSend')) $('askqSend').addEventListener('click', () => askSend());
  if ($('askqInput')) $('askqInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); askSend(); } });
  document.addEventListener('quantra:installable', () => renderPwaButtons());
  if ($('alCreate')) $('alCreate').addEventListener('click', createAlert);
  if ($('alValue')) $('alValue').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createAlert(); } });
  // pull server-side alert state (picks up triggers fired while away) on load, on sync, and every 60s
  if (onServer) {
    window.addEventListener('quantra:synced', refreshAlertsFromServer);
    refreshAlertsFromServer();
    setInterval(() => { if (signedIn()) refreshAlertsFromServer(); }, 60000);
  }

  // deep-link from the screener: terminal.html?type=&id=&symbol=&name=
  const P = new URLSearchParams(location.search);
  const dlType = P.get('type'), dlId = P.get('id'), dlSym = P.get('symbol');
  if (dlSym && dlType && dlId) {
    switchClass(dlType).then(() => select({ id: dlId, type: dlType, symbol: dlSym, name: P.get('name') || dlSym }));
  } else {
    switchClass('crypto');
  }
})();
