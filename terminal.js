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

  // ---- currency conversion ----
  let fxRates = { USD: 1 };
  let selCur = 'USD';
  let curBase = 'USD';         // native currency of the selected asset's prices
  const CUR_SYM = { USD: '$', INR: '₹', AED: 'AED ', EUR: '€', GBP: '£', JPY: '¥', CNY: 'CN¥', CAD: 'C$', AUD: 'A$', SGD: 'S$', CHF: 'CHF ' };
  const fxRate = (c) => fxRates[c] || 1;
  const conv = (amt, base) => (amt == null || isNaN(amt) ? null : amt * fxRate(selCur) / fxRate(base || 'USD'));
  const curSym = () => CUR_SYM[selCur] || selCur + ' ';
  function money(amt, base) {
    const v = conv(amt, base); if (v == null) return '—';
    const a = Math.abs(v), d = a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
    return curSym() + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
  }
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
    if (!onServer) throw new Error('static');
    return getJSON(`${API}/${BOARD_EP[cls] || 'stock/board'}`);
  }
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
  function rowHTML(it) {
    const up = (it.change24h || 0) >= 0, chg = it.change24h == null ? '—' : `${up ? '+' : ''}${it.change24h.toFixed(2)}%`;
    return `<button class="trow" data-id="${it.id}" data-type="${it.type}" data-symbol="${it.symbol}" data-name="${(it.name || '').replace(/"/g, '')}">
      <span class="trow__name"><b>${it.symbol}</b><small>${it.name || ''}</small></span>
      <span class="trow__price">${money(it.price, it.currency)}</span>
      <span class="trow__chg ${up ? 'up' : 'down'}">${chg}</span>
      <span class="trow__spark">${sparkSVG(it.spark, up)}</span></button>`;
  }
  function renderBoard() {
    const list = $('list'), empty = $('empty');
    if (!board.length) { empty.textContent = 'No data.'; return; }
    list.innerHTML = board.map(rowHTML).join('');
    list.querySelectorAll('.trow').forEach((r) => r.addEventListener('click', () => select({ id: r.dataset.id, type: r.dataset.type, symbol: r.dataset.symbol, name: r.dataset.name })));
  }
  async function switchClass(cls) {
    assetClass = cls;
    document.querySelectorAll('.seg__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.class === cls));
    $('search').value = ''; $('results').hidden = true;
    $('list').innerHTML = '<div class="tempty" id="empty">Loading live markets…</div>';
    try { board = await loadBoard(cls); renderBoard(); (cls === 'crypto' ? startArr() : stopArr()); if (board[0]) select(board[0]); }
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
  const W = 720, H = 240, PAD = 8;
  let chartState = null;   // {total, histLen, vals, dates, fcMid, yAt} for hover tooltip
  let chartType = 'line';  // 'line' | 'candle'
  try { const ct = localStorage.getItem('quantra.charttype'); if (ct === 'candle' || ct === 'line') chartType = ct; } catch {}
  let candleHist = null;   // OHLC source for the candle view (crypto: Binance; else: hist)
  let tickMode = false, tickBuf = [], tickTimer = null, tickWinMs = 300000;  // live seconds chart

  function drawChart(hist, fc) {
    const ohlc = candleHist || hist;
    const hasOHLC = ohlc && ohlc.opens && ohlc.highs && ohlc.lows && ohlc.opens.length === ohlc.closes.length
      && ohlc.highs.some((h, i) => h > ohlc.lows[i]);   // real OHLC (not degenerate)
    if (chartType === 'candle' && hasOHLC) return drawCandles(ohlc, fc);
    return drawLine(hist, fc);
  }

  function drawLine(hist, fc) {
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
    const sma20Line = lineFrom(s.sma20.slice(start));
    const sma50Line = lineFrom(s.sma50.slice(start));

    let fcBand = '', fcLine = '';
    if (fc) {
      const off = histSlice.length;
      const hiPath = fcHi.map((v, i) => `${i ? 'L' : 'M'}${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
      const loPath = fcLo.map((v, i) => `L${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).reverse().join(' ');
      fcBand = `${hiPath} ${fcLo.map((v, i) => `L${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).reverse().join(' ')} Z`;
      fcLine = `M${x(off - 1).toFixed(1)} ${y(histSlice[histSlice.length - 1]).toFixed(1)} ` + fcMid.map((v, i) => `L${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    }
    svg.innerHTML = `
      <defs><linearGradient id="pf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34D399" stop-opacity=".22"/><stop offset="1" stop-color="#34D399" stop-opacity="0"/></linearGradient></defs>
      <path d="${area}" fill="url(#pf)"/>
      ${fc ? `<path d="${fcBand}" fill="#22D3EE" opacity=".12"/>` : ''}
      ${sma50Line ? `<path d="${sma50Line}" fill="none" stroke="#FBBF24" stroke-width="1.4" opacity=".85"/>` : ''}
      ${sma20Line ? `<path d="${sma20Line}" fill="none" stroke="#818CF8" stroke-width="1.4" opacity=".9"/>` : ''}
      <path d="${priceLine}" fill="none" stroke="#34D399" stroke-width="2.1" stroke-linejoin="round"/>
      ${fc ? `<path d="${fcLine}" fill="none" stroke="#22D3EE" stroke-width="1.8" stroke-dasharray="5 4"/>` : ''}
      <line id="xhair" y1="${PAD}" y2="${H - PAD}" stroke="rgba(231,236,245,.45)" stroke-width="1" stroke-dasharray="3 3" style="display:none" vector-effect="non-scaling-stroke"/>
      <circle id="xdot" r="3.6" fill="#E7ECF5" stroke="#0A0F1C" stroke-width="1" style="display:none"/>`;

    chartState = { total, histLen: histSlice.length, vals: histSlice, dates: histDates, fcMid, yAt: y, xAt: x };
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
    let fcBand = '', fcLine = '';
    if (fc) {
      const off = c.length;
      const hiPath = fcHi.map((v, i) => `${i ? 'L' : 'M'}${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
      fcBand = `${hiPath} ${fcLo.map((v, i) => `L${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).reverse().join(' ')} Z`;
      fcLine = `M${x(off - 1).toFixed(1)} ${y(c[c.length - 1]).toFixed(1)} ` + fcMid.map((v, i) => `L${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    }
    svg.innerHTML = `
      ${fc ? `<path d="${fcBand}" fill="#22D3EE" opacity=".12"/>` : ''}
      ${sma50Line ? `<path d="${sma50Line}" fill="none" stroke="#FBBF24" stroke-width="1.3" opacity=".8"/>` : ''}
      ${sma20Line ? `<path d="${sma20Line}" fill="none" stroke="#818CF8" stroke-width="1.3" opacity=".85"/>` : ''}
      ${candles}
      ${fc ? `<path d="${fcLine}" fill="none" stroke="#22D3EE" stroke-width="1.8" stroke-dasharray="5 4"/>` : ''}
      <line id="xhair" y1="${PAD}" y2="${H - PAD}" stroke="rgba(231,236,245,.45)" stroke-width="1" stroke-dasharray="3 3" style="display:none" vector-effect="non-scaling-stroke"/>
      <circle id="xdot" r="3.6" fill="#E7ECF5" stroke="#0A0F1C" stroke-width="1" style="display:none"/>`;
    chartState = { total, histLen: c.length, vals: c, dates: d, fcMid, yAt: y, xAt: x };
  }

  /* ---------------- chart hover tooltip (date + price) ---------------- */
  function fmtTipDate(iso) {
    if (!iso) return '';
    const intr = $('intervalSel').value;
    const opt = intr === 'sec'
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : (intr === '1m' || intr === '60m')
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
    $('fcRange').textContent = money(fc.lo[fc.lo.length - 1], curBase) + ' – ' + money(fc.hi[fc.hi.length - 1], curBase);
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
      return `<tr><td>${fmtD(d)}<small>+${h.bars} ${interval === '1wk' ? 'wk' : interval === '60m' ? 'h' : interval === '1m' ? 'm' : 'sessions'}</small></td><td class="proj-px">${money(proj, curBase)}</td><td class="proj-rng">${money(lo, curBase)} – ${money(hi, curBase)}</td><td class="proj-d ${up ? 'up' : 'down'}">${up ? '+' : ''}${(h.move * 100).toFixed(1)}%</td></tr>`;
    }).join('');
    $('projTable').innerHTML = '<tr><th>Date</th><th>Projected (P50)</th><th>Range (P10–P90)</th><th>Δ vs now</th></tr>' + rows;
    $('projAsof').textContent = 'Anchored to ' + fmtD(new Date(lastIso || Date.now())) + ' · ' + Math.round((fc.probUp || 0) * 100) + '% modelled chance of finishing higher. Monte-Carlo projection — probabilistic, not a guarantee.';
    card.hidden = false;
  }

  /* ---------------- live seconds (tick) chart ---------------- */
  function pushTick(p) {
    if (!(p > 0)) return;
    const t = Date.now();
    tickBuf.push({ t, p });
    const cut = t - tickWinMs;
    while (tickBuf.length > 2 && tickBuf[0].t < cut) tickBuf.shift();
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
    if (st) for (let i = 1; i <= FS; i++) { const w = st.volPerSec * Math.sqrt(i) * 1.28; pj.push({ mid: st.last + st.driftPerSec * i, lo: st.last + st.driftPerSec * i - w, hi: st.last + st.driftPerSec * i + w }); }
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
    const rows = [5, 10, 20, 30].map((s) => {
      const mid = st.last + st.driftPerSec * s, w = st.volPerSec * Math.sqrt(s) * 1.28, up = st.driftPerSec >= 0;
      const d = new Date(now + s * 1000);
      return `<tr><td>${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}<small>+${s}s</small></td><td class="proj-px">${money(mid, curBase)}</td><td class="proj-rng">${money(mid - w, curBase)} – ${money(mid + w, curBase)}</td><td class="proj-d ${up ? 'up' : 'down'}">${up ? '+' : ''}${((mid / st.last - 1) * 100).toFixed(2)}%</td></tr>`;
    }).join('');
    $('projTable').innerHTML = '<tr><th>Time</th><th>Projected</th><th>Range (P10–P90)</th><th>Δ vs now</th></tr>' + rows;
    $('projAsof').textContent = 'Live tick projection from the last ' + tickBuf.length + ' ticks — very short horizon, high uncertainty, not a guarantee.';
    card.hidden = false;
  }
  function startTickChart() {
    tickBuf = [];
    if (state && state.history && state.history.closes && state.history.closes.length) tickBuf.push({ t: Date.now(), p: state.history.closes[state.history.closes.length - 1] });
    drawTickChart(); renderTickProjection();
  }
  function stopTick() { tickMode = false; if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; } }

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
    stopLive(); stopTick();
    let interval = $('intervalSel').value, range = $('rangeSel').value;
    if (interval === 'sec' && item.type !== 'crypto') { R.toast('Seconds (live tick) is available for crypto only.'); interval = '1m'; $('intervalSel').value = '1m'; fillRanges(); range = $('rangeSel').value; }
    const secMode = interval === 'sec';
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
      curBase = (item.type === 'crypto') ? 'USD' : (hist.currency || (fund && fund.currency) || 'USD');
      const sent = Q.sentiment(news);
      const res = Q.analyze(hist, item.name || item.symbol, fund, sent);
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
      const chg = (board.find((b) => b.id === item.id) || {}).change24h;
      const chip = $('dChange');
      if (chg != null) { chip.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`; chip.className = 'chip chip--' + (chg >= 0 ? 'up' : 'down'); }
      else { chip.textContent = res.verdict.trend; chip.className = 'chip chip--' + (up ? 'up' : res.verdict.dir === 'down' ? 'down' : 'neutral'); }
      const SUBS = { crypto: 'Cryptocurrency · 24/7 market', etf: 'Exchange-traded fund', commodity: 'Commodity / futures', index: 'Market index', fx: 'Foreign exchange pair' };
      if (SUBS[item.type]) $('dSub').textContent = SUBS[item.type];

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
        if (chartType === 'candle' && item.type === 'crypto') {
          try { candleHist = await getJSON(`${API}/crypto/ohlc?symbol=${encodeURIComponent(item.symbol)}&interval=${interval}`); } catch { candleHist = null; }
        }
        drawChart(hist, res.forecast);
        renderProjections(res.forecast, hist, item);
      }
      typeOut($('dText'), res.text);
      renderPeers(peers);
      renderNews(sent, item);
      state.news = sent;

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
            const fc2 = Q.forecast(state.history.closes, 30, r.newsImpact);
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
  function setDetailPrice(p) { const dp = $('dPrice'); if (!dp) return; dp.textContent = money(p, curBase); dp.classList.remove('tick'); void dp.offsetWidth; dp.classList.add('tick'); }
  function updateRowPrice(it) {
    const list = $('list'); if (!list) return;
    const row = list.querySelector('.trow[data-type="' + it.type + '"][data-symbol="' + it.symbol + '"]');
    const c = row && row.querySelector('.trow__price'); if (c) c.textContent = money(it.price, it.currency);
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
    tick(); quoteTimer = setInterval(tick, 4000);
  }
  function stopQuote() { if (quoteTimer) { clearInterval(quoteTimer); quoteTimer = null; } }
  function stopLive() { stopTrade(); stopQuote(); liveTag(false); }
  function startLive(item) { if (item.type === 'crypto') startTrade(item.symbol); else startQuote(item); }

  /* ---------------- controls ---------------- */
  document.querySelectorAll('.seg__btn').forEach((b) => b.addEventListener('click', () => switchClass(b.dataset.class)));
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

  $('curSel').addEventListener('change', (e) => {
    selCur = e.target.value;
    try { localStorage.setItem(CUR_KEY, selCur); } catch (_) {}
    if (window.QuantraAuth && window.QuantraAuth.user) window.QuantraAuth.pushData({ prefs: { currency: selCur } });
    renderBoard();                              // re-price the board
    if (current) select(current);               // re-price the detail panel
  });

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

  // deep-link from the screener: index.html?type=&id=&symbol=&name=
  const P = new URLSearchParams(location.search);
  const dlType = P.get('type'), dlId = P.get('id'), dlSym = P.get('symbol');
  if (dlSym && dlType && dlId) {
    switchClass(dlType).then(() => select({ id: dlId, type: dlType, symbol: dlSym, name: P.get('name') || dlSym }));
  } else {
    switchClass('crypto');
  }
})();
