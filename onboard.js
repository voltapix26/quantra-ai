/* Quantra AI — onboarding: first-run coach-mark tour + getting-started checklist.
   Self-contained: observes existing DOM events (no coupling into terminal.js).
   State in localStorage: quantra.tour (1 = seen), quantra.gs = {steps, dismissed}. */
(() => {
  'use strict';
  if (!document.getElementById('list')) return;   // terminal page only
  const $ = (id) => document.getElementById(id);
  const LS = { tour: 'quantra.tour', gs: 'quantra.gs' };
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  /* ---------------- first-run tour ---------------- */
  const STEPS = [
    { sel: '#list', title: 'Live markets', text: 'Crypto, stocks (24 exchanges), ETFs, commodities, indices and forex — live prices with honest freshness labels. Click any asset to analyse it.' },
    { sel: '#search', title: 'Search anything', text: 'Any symbol, any market — AAPL, RELIANCE.NS, BTC, gold…' },
    { sel: '#intervalSel', title: 'Seconds · live', text: 'Switch the interval to “Seconds · live” for a real-time tick chart with millisecond timing and per-second projections — with a measured live hit rate.' },
    { sel: '.bar__links a[href="track-record.html"]', title: 'The proof', text: 'Every projection Quantra makes is graded against what actually happened — publicly, on a tamper-evident ledger. Probabilistic, never a guarantee.' },
    { sel: '#acctBtn', title: 'Sign in to sync', text: 'Free account = watchlist, alerts (email + push), portfolio and your personal For-you board, synced everywhere.' },
  ];
  let ti = -1, tEls = null;
  function tourEls() {
    if (tEls) return tEls;
    const dim = document.createElement('div'); dim.className = 'tour-dim'; dim.id = 'tourDim';
    const ring = document.createElement('div'); ring.className = 'tour-ring'; ring.id = 'tourRing';
    const card = document.createElement('div'); card.className = 'tour-card'; card.id = 'tourCard';
    document.body.append(dim, ring, card);
    dim.addEventListener('click', endTour);
    return (tEls = { dim, ring, card });
  }
  function showStep(i) {
    const { dim, ring, card } = tourEls();
    // skip steps whose anchor is missing/hidden
    while (i < STEPS.length) {
      const el = document.querySelector(STEPS[i].sel);
      if (el && el.offsetParent !== null) break;
      i++;
    }
    if (i >= STEPS.length) return endTour();
    ti = i;
    const s = STEPS[i], el = document.querySelector(s.sel), r = el.getBoundingClientRect();
    dim.style.display = 'block';
    ring.style.display = 'block';
    ring.style.cssText += `;top:${r.top - 6}px;left:${r.left - 6}px;width:${r.width + 12}px;height:${r.height + 12}px`;
    card.innerHTML = `
      <div class="tour-step">${i + 1} / ${STEPS.length}</div>
      <h4>${s.title}</h4><p>${s.text}</p>
      <div class="tour-btns">
        <button class="tour-skip" id="tourSkip">Skip</button>
        <button class="tour-next" id="tourNext">${i === STEPS.length - 1 ? 'Done ✓' : 'Next →'}</button>
      </div>`;
    card.style.display = 'block';
    // position: below anchor if room, else above; clamp to viewport
    const ch = 170, cw = Math.min(320, window.innerWidth - 24);
    card.style.width = cw + 'px';
    let top = r.bottom + 14; if (top + ch > window.innerHeight - 10) top = Math.max(10, r.top - ch - 14);
    let left = Math.max(12, Math.min(window.innerWidth - cw - 12, r.left + r.width / 2 - cw / 2));
    card.style.top = top + 'px'; card.style.left = left + 'px';
    $('tourNext').onclick = () => (ti === STEPS.length - 1 ? endTour() : showStep(ti + 1));
    $('tourSkip').onclick = endTour;
  }
  function endTour() {
    save(LS.tour, 1); ti = -1;
    if (tEls) { tEls.dim.style.display = tEls.ring.style.display = tEls.card.style.display = 'none'; }
  }
  function startTour() { showStep(0); }

  /* ---------------- getting-started checklist ---------------- */
  const GS_STEPS = [
    { k: 'pick', label: 'Open any asset', hint: 'click a row on the board' },
    { k: 'watch', label: 'Star a watchlist favourite', hint: 'the ☆ next to the name' },
    { k: 'alert', label: 'Set a price alert', hint: 'fires by email even when closed' },
    { k: 'sec', label: 'Try Seconds · live', hint: 'interval → “Seconds · live”' },
    { k: 'signin', label: 'Sign in to sync', hint: 'top-right — free' },
  ];
  let gs = load(LS.gs, { steps: {}, dismissed: false });
  const gsDone = () => GS_STEPS.filter((s) => gs.steps[s.k]).length;
  function mark(k) {
    if (gs.dismissed || gs.steps[k]) return;
    gs.steps[k] = Date.now(); save(LS.gs, gs); renderGS();
  }
  function renderGS() {
    let card = $('gsCard');
    if (gs.dismissed || (gsDone() === GS_STEPS.length && gs.celebrated)) { if (card) card.remove(); return; }
    if (!card) {
      card = document.createElement('div'); card.className = 'gs-card'; card.id = 'gsCard';
      document.body.appendChild(card);
    }
    const done = gsDone(), all = done === GS_STEPS.length;
    if (all && !gs.celebrated) { gs.celebrated = Date.now(); save(LS.gs, gs); setTimeout(() => { const c = $('gsCard'); if (c) c.remove(); }, 6000); }
    card.innerHTML = `
      <div class="gs-head" id="gsHead">
        <span class="gs-title">${all ? 'You’re all set 🎉' : 'Getting started'}</span>
        <span class="gs-count">${done}/${GS_STEPS.length}</span>
        <button class="gs-x" id="gsX" title="Dismiss">×</button>
      </div>
      <div class="gs-bar"><i style="width:${(done / GS_STEPS.length) * 100}%"></i></div>
      <div class="gs-body" id="gsBody" ${gs.collapsed ? 'hidden' : ''}>
        ${GS_STEPS.map((s) => `<div class="gs-item ${gs.steps[s.k] ? 'is-done' : ''}"><span class="gs-tick">${gs.steps[s.k] ? '✓' : '○'}</span><div><b>${s.label}</b><small>${s.hint}</small></div></div>`).join('')}
        <button class="gs-replay" id="gsReplay">↻ Replay the tour</button>
      </div>`;
    $('gsX').onclick = (e) => { e.stopPropagation(); gs.dismissed = true; save(LS.gs, gs); card.remove(); };
    $('gsHead').onclick = () => { gs.collapsed = !gs.collapsed; save(LS.gs, gs); renderGS(); };
    $('gsReplay').onclick = (e) => { e.stopPropagation(); startTour(); };
  }

  /* ---------------- observers (zero coupling) ---------------- */
  const list = $('list');
  if (list) list.addEventListener('click', (e) => { if (e.target.closest('.trow')) mark('pick'); });
  const star = $('wStar');
  if (star) star.addEventListener('click', () => mark('watch'));
  const alertBtn = $('alertAdd');
  if (alertBtn) alertBtn.addEventListener('click', () => mark('alert'));
  const intSel = $('intervalSel');
  if (intSel) intSel.addEventListener('change', () => { if (intSel.value === 'sec') mark('sec'); });
  window.addEventListener('quantra:limits', (e) => { if (e.detail && e.detail.loggedIn) mark('signin'); });

  /* ---------------- boot ---------------- */
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (!load(LS.tour, 0)) startTour();
      renderGS();
    }, 1200);   // let the board render first
  });
})();
