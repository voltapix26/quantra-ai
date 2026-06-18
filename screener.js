/* ============================================================
   Quantra AI — Screener & Top Picks
   ============================================================ */
(function () {
  'use strict';
  const Q = window.Quantra;
  const onServer = location.protocol === 'http:' || location.protocol === 'https:';
  const API = '/api', CG = 'https://api.coingecko.com/api/v3';
  const $ = (id) => document.getElementById(id);

  let universe = [];
  let filterClass = 'all', minScore = 0, sortBy = 'score';

  async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }

  async function loadCrypto() {
    if (onServer) return getJSON(`${API}/crypto/markets?page=1`);
    const raw = await getJSON(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=true&price_change_percentage=24h`);
    return raw.map((c) => ({ type: 'crypto', id: c.id, symbol: (c.symbol || '').toUpperCase(), name: c.name, price: c.current_price, change24h: c.price_change_percentage_24h, spark: (c.sparkline_in_7d && c.sparkline_in_7d.price) || [] }));
  }
  async function loadStocks() { if (!onServer) return []; try { return await getJSON(`${API}/stock/board`); } catch { return []; } }

  const fmtP = (p) => (p == null ? '—' : '$' + (p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p >= 1 ? p.toFixed(2) : p.toFixed(4)));
  const scoreColor = (q) => q >= 70 ? '#34D399' : q >= 56 ? '#22D3EE' : q >= 45 ? '#FBBF24' : q >= 30 ? '#FB7185' : '#FB7185';
  function spark(data, up) {
    if (!data || data.length < 2) return '';
    const w = 70, h = 22, color = up ? '#34D399' : '#FB7185', min = Math.min(...data), max = Math.max(...data), rng = max - min || 1, step = w / (data.length - 1);
    const d = data.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${(h - ((v - min) / rng) * (h - 4) - 2).toFixed(1)}`).join(' ');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
  }
  const linkFor = (it) => `index.html?type=${it.type}&id=${encodeURIComponent(it.id)}&symbol=${encodeURIComponent(it.symbol)}&name=${encodeURIComponent(it.name || it.symbol)}`;

  function scoreRing(q) {
    const c = scoreColor(q), circ = 2 * Math.PI * 15, off = circ * (1 - q / 100);
    return `<svg width="46" height="46" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="3"/><circle cx="18" cy="18" r="15" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${off}" transform="rotate(-90 18 18)"/><text x="18" y="22" text-anchor="middle" font-family="Space Grotesk" font-size="12" font-weight="700" fill="${c}">${q}</text></svg>`;
  }

  function pickCard(it) {
    const up = (it.change24h || 0) >= 0;
    return `<a class="pick" href="${linkFor(it)}">
      <div class="pick__top">${scoreRing(it.score)}<div class="pick__id"><b>${it.symbol}</b><small>${(it.name || '').slice(0, 22)}</small></div></div>
      <div class="pick__row"><span>${fmtP(it.price)}</span><span class="${up ? 'up' : 'down'}">${up ? '+' : ''}${(it.change24h || 0).toFixed(2)}%</span></div>
      <div class="pick__grade" style="color:${scoreColor(it.score)}">${Q.scoreGrade(it.score)}</div></a>`;
  }

  function rowHTML(it, rank) {
    const up = (it.change24h || 0) >= 0;
    return `<a class="scr-row" href="${linkFor(it)}">
      <span class="scr-rank">${rank}</span>
      <span class="scr-name"><b>${it.symbol}</b><small>${it.name || ''}</small></span>
      <span class="scr-cls scr-cls--${it.type}">${it.type === 'crypto' ? 'Crypto' : 'Stock'}</span>
      <span class="scr-price">${fmtP(it.price)}</span>
      <span class="scr-chg ${up ? 'up' : 'down'}">${up ? '+' : ''}${(it.change24h || 0).toFixed(2)}%</span>
      <span class="scr-spark">${spark(it.spark, up)}</span>
      <span class="scr-score"><i class="scr-bar"><i style="width:${it.score}%;background:${scoreColor(it.score)}"></i></i><b style="color:${scoreColor(it.score)}">${it.score}</b></span></a>`;
  }

  function render() {
    let list = universe.filter((it) => it.score != null);
    if (filterClass !== 'all') list = list.filter((it) => it.type === filterClass);
    list = list.filter((it) => it.score >= minScore);
    list.sort((a, b) => sortBy === 'chg' ? (b.change24h || 0) - (a.change24h || 0) : sortBy === 'sym' ? a.symbol.localeCompare(b.symbol) : b.score - a.score);
    const le = $('scrList');
    le.innerHTML = list.length ? list.map((it, i) => rowHTML(it, i + 1)).join('') : '<div class="scr-empty">No assets match the filter.</div>';

    const top = universe.filter((it) => it.score != null).sort((a, b) => b.score - a.score).slice(0, 6);
    $('topPicks').innerHTML = top.map(pickCard).join('') || '<div class="scr-empty">No data.</div>';

    renderWatch();
  }

  function renderWatch() {
    let watch = [];
    try { watch = JSON.parse(localStorage.getItem('quantra.watch') || '[]'); } catch {}
    const sec = $('watchSection');
    if (!watch.length) { sec.hidden = true; return; }
    sec.hidden = false;
    $('watchPicks').innerHTML = watch.map((w) => {
      const found = universe.find((u) => u.id === w.id && u.type === w.type);
      if (found && found.score != null) return pickCard(found);
      return `<a class="pick pick--plain" href="${linkFor(w)}"><div class="pick__id"><b>${w.symbol}</b><small>${(w.name || '').slice(0, 22)}</small></div><div class="pick__grade" style="color:var(--muted-2)">open →</div></a>`;
    }).join('');
  }

  async function init() {
    try {
      const [crypto, stocks] = await Promise.all([loadCrypto().catch(() => []), loadStocks().catch(() => [])]);
      universe = [...crypto, ...stocks].map((it) => ({ ...it, score: Q.liteScore(it.spark, it.change24h) }));
      render();
      if (!universe.length) { $('scrEmpty').textContent = onServer ? 'Could not reach the market feed.' : 'Run the server (node server.js) to load stocks.'; }
    } catch (e) {
      $('scrEmpty').textContent = 'Could not load the universe. Retry shortly.';
      $('picksEmpty').textContent = '';
    }
  }

  document.querySelectorAll('.seg__btn').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.seg__btn').forEach((x) => x.classList.toggle('is-active', x === b));
    filterClass = b.dataset.class; render();
  }));
  $('minScore').addEventListener('input', (e) => { minScore = +e.target.value; $('minVal').textContent = minScore; render(); });
  $('sortSel').addEventListener('change', (e) => { sortBy = e.target.value; render(); });

  init();
})();
