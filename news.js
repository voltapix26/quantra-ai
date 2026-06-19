/* ============================================================
   Quantra AI — stock news page
   ============================================================ */
(function () {
  'use strict';
  const onServer = location.protocol === 'http:' || location.protocol === 'https:';
  const API = '/api';
  const $ = (id) => document.getElementById(id);
  const grid = $('newsGrid');

  function timeAgo(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 3600) return Math.max(1, Math.round(diff / 60)) + 'm ago';
    if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
    return Math.round(diff / 86400) + 'd ago';
  }
  const esc = (s) => (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function card(n) {
    const src = n.source || n.publisher || '';
    const badge = src ? `<span class="ncard__src">${esc(src)}</span>` : '';
    const sent = (typeof n.sentiment === 'number')
      ? `<span class="ncard__sent ${n.sentiment > 0.05 ? 'pos' : n.sentiment < -0.05 ? 'neg' : ''}">${n.sentiment > 0.05 ? '▲' : n.sentiment < -0.05 ? '▼' : '•'} ${n.sentiment.toFixed(2)}</span>` : '';
    const tickers = (n.tickers || []).slice(0, 4).map((t) => `<span>${esc(t)}</span>`).join('');
    const thumb = n.thumb ? `<div class="ncard__thumb" style="background-image:url('${esc(n.thumb)}')"></div>` : '';
    const link = n.link || n.url || '#';
    return `<a class="ncard" href="${esc(link)}" target="_blank" rel="noopener noreferrer">
      ${thumb}
      <div class="ncard__body">
        <div class="ncard__title">${esc(n.title)}</div>
        ${n.snippet ? `<div class="ncard__snip">${esc(String(n.snippet).slice(0, 150))}</div>` : ''}
        <div class="ncard__tickers">${tickers}</div>
        <div class="ncard__meta"><span>${badge}${sent}</span><span>${timeAgo(n.time)}</span></div>
      </div></a>`;
  }

  async function load(symbol) {
    symbol = (symbol || '').trim().toUpperCase();
    if (!symbol) return;
    $('newsSym').textContent = symbol;
    $('newsInput').value = symbol;
    document.title = `Quantra AI — ${symbol} News`;
    history.replaceState(null, '', `news.html?symbol=${encodeURIComponent(symbol)}`);
    grid.innerHTML = '<div class="news-empty">Loading latest headlines…</div>';
    if (!onServer) { grid.innerHTML = '<div class="news-empty">News needs the live server.<br>Run <code>node server.js</code>, then open <b>localhost:5280/news.html</b></div>'; return; }
    try {
      let news = [];
      // premium multi-source first (Bloomberg/Reuters/CNBC via marketaux, when a key is set)
      try { const p = await (await fetch(`${API}/news/premium?symbol=${encodeURIComponent(symbol)}`)).json(); if (p && p.ok && p.news && p.news.length) news = p.news; } catch {}
      if (!news.length) news = await (await fetch(`${API}/stock/news?symbol=${encodeURIComponent(symbol)}`)).json();
      if (!news.length) { grid.innerHTML = `<div class="news-empty">No recent headlines found for ${esc(symbol)}.</div>`; return; }
      grid.innerHTML = news.map(card).join('');
    } catch (e) {
      grid.innerHTML = '<div class="news-empty">Could not load news right now. Try again shortly.</div>';
    }
  }

  $('newsForm').addEventListener('submit', (e) => { e.preventDefault(); load($('newsInput').value); });

  const sym = new URLSearchParams(location.search).get('symbol');
  if (sym) load(sym);
})();
