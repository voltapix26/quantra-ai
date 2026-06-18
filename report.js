/* ============================================================
   Quantra AI — Excel + PDF report generation
   Excel: SheetJS (xlsx) · PDF: jsPDF · graceful fallbacks.
   ============================================================ */
window.QuantraReport = (function () {
  'use strict';
  const Q = window.Quantra;

  const dnum = (n, d = 2) => (n == null || isNaN(n) ? '' : Math.round(n * 10 ** d) / 10 ** d);
  const dateStr = (iso) => (iso ? iso.slice(0, 10) : '');
  const addDays = (iso, n) => { const d = new Date(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

  // ---- currency conversion (reads st.cur / st.fxRates / base hints) ----
  const CUR_SYM = { USD: '$', INR: '₹', AED: 'AED ', EUR: '€', GBP: '£', JPY: '¥', CNY: 'CN¥', CAD: 'C$', AUD: 'A$', SGD: 'S$', CHF: 'CHF ' };
  const curOf = (st) => st.cur || 'USD';
  const rateOf = (st, c) => (st.fxRates && st.fxRates[c]) || 1;
  const conv = (st, amt, base) => (amt == null || isNaN(amt) ? null : amt * rateOf(st, curOf(st)) / rateOf(st, base || 'USD'));
  const symOf = (st) => CUR_SYM[curOf(st)] || curOf(st) + ' ';
  function moneyStr(st, amt, base) {
    const v = conv(st, amt, base); if (v == null) return '—';
    const a = Math.abs(v), d = a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
    return symOf(st) + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
  }
  function capStr(st, amt, base) {
    const v = conv(st, amt, base); if (v == null) return '—'; const s = symOf(st);
    return v >= 1e12 ? s + (v / 1e12).toFixed(2) + 'T' : v >= 1e9 ? s + (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? s + (v / 1e6).toFixed(1) + 'M' : s + Math.round(v).toLocaleString();
  }
  // converted numeric cell for Excel
  const cnum = (st, amt, base, d = 4) => { const v = conv(st, amt, base); return v == null ? '' : Math.round(v * 10 ** d) / 10 ** d; };

  function toast(msg) {
    const t = document.getElementById('toast');
    if (!t) return; t.textContent = msg; t.classList.add('show');
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ---------- EXCEL ---------- */
  function buildHistoryRows(st) {
    const { dates, closes, highs, lows } = st.history;
    const s = Q.series(closes);
    const cmp = st.compare; // {symbol, byDate:Map}
    const C = curOf(st), pb = st.priceBase || 'USD';
    const header = ['Date', `Close (${C})`, `High (${C})`, `Low (${C})`, `SMA20 (${C})`, `SMA50 (${C})`, 'RSI14'];
    if (cmp) header.push(`${cmp.symbol} Close (${C})`, 'Spread %');
    const rows = [header];
    for (let i = 0; i < closes.length; i++) {
      const row = [dateStr(dates[i]), cnum(st, closes[i], pb), cnum(st, highs[i], pb), cnum(st, lows[i], pb),
        cnum(st, s.sma20[i], pb), cnum(st, s.sma50[i], pb), dnum(s.rsi14[i], 1)];
      if (cmp) {
        const cv = cmp.byDate.get(dateStr(dates[i]));
        row.push(cv != null ? cnum(st, cv, 'USD') : '');
        row.push(cv != null ? dnum(((closes[i] - cv) / cv) * 100, 2) : '');
      }
      rows.push(row);
    }
    return rows;
  }

  function buildSummaryRows(st) {
    const a = st.analysis, ind = a.indicators, f = st.fundamentals;
    const C = curOf(st), pb = st.priceBase || 'USD', fb = st.fundBase || 'USD';
    const rows = [
      ['Quantra AI — Analysis Report'],
      ['Asset', st.name + ' (' + st.symbol + ')'],
      ['Type', st.type], ['Generated', new Date().toISOString().slice(0, 19).replace('T', ' ')],
      ['Range / Interval', st.range + ' / ' + st.interval],
      ['Currency', C + (pb !== C ? ` (converted from ${pb})` : '')],
      [],
      ['— Snapshot —'],
      ['Price', moneyStr(st, a.price, pb)],
      ['Trend', a.verdict.trend], ['Risk / Reward', a.verdict.rr], ['Confidence', a.verdict.confidence],
      ['Backtested accuracy', a.verdict.accuracy + (a.backtest ? ` (${a.backtest.trades} samples, ${a.backtest.horizon}-session)` : '')],
      [],
      [`— Technical (${C}) —`],
      ['SMA 20', moneyStr(st, ind.sma20, pb)], ['SMA 50', moneyStr(st, ind.sma50, pb)], ['SMA 200', moneyStr(st, ind.sma200, pb)],
      ['RSI 14', dnum(ind.rsi, 1)], ['MACD hist', ind.macd ? moneyStr(st, ind.macd.hist, pb) : ''],
      ['ADX', dnum(ind.adx, 1)], ['Stochastic %K', dnum(ind.stoch, 1)], ['Bollinger %B', dnum(ind.bollPctB, 2)],
      ['ATR (14)', moneyStr(st, ind.atr, pb)], ['Support', moneyStr(st, ind.support, pb)], ['Resistance', moneyStr(st, ind.resistance, pb)],
      [],
      ['— Signal breakdown —'],
      ...(a.signals || []).map((s) => [s.name, s.dir.toUpperCase() + ' · ' + s.note]),
      [],
      ['— AI verdict —'], [st.aiText || a.text],
    ];
    if (f) {
      rows.push([], [`— Fundamentals (screener-style, ${C}) —`],
        ['Sector', f.sector || ''], ['Industry', f.industry || ''],
        ['Market Cap', f.marketCap ? capStr(st, f.marketCap, fb) : ''], ['P/E (TTM)', dnum(f.peTrailing, 2)], ['Forward P/E', dnum(f.peForward, 2)],
        ['EPS', f.eps != null ? moneyStr(st, f.eps, fb) : ''], ['Price/Book', dnum(f.pb, 2)], ['Book Value', f.bookValue != null ? moneyStr(st, f.bookValue, fb) : ''],
        ['ROE', f.roe != null ? dnum(f.roe * 100, 1) + '%' : ''], ['ROA', f.roa != null ? dnum(f.roa * 100, 1) + '%' : ''],
        ['Profit Margin', f.profitMargin != null ? dnum(f.profitMargin * 100, 1) + '%' : ''],
        ['Debt/Equity', dnum(f.debtToEquity, 1)], ['Revenue Growth', f.revenueGrowth != null ? dnum(f.revenueGrowth * 100, 1) + '%' : ''],
        ['Dividend Yield', f.dividendYield != null ? dnum(f.dividendYield * 100, 2) + '%' : ''],
        ['52w High', f.high52 != null ? moneyStr(st, f.high52, fb) : ''], ['52w Low', f.low52 != null ? moneyStr(st, f.low52, fb) : ''], ['Analyst target', f.targetMean != null ? moneyStr(st, f.targetMean, fb) : '']);
    }
    const fc = a.forecast;
    if (fc) {
      rows.push([], [`— 30-session projection (illustrative, ${C}) —`],
        ['Expected drift', dnum(fc.expReturn * 100, 1) + '%'],
        ['Projected mid', moneyStr(st, fc.mid[fc.mid.length - 1], pb)],
        ['Projected low', moneyStr(st, fc.lo[fc.lo.length - 1], pb)],
        ['Projected high', moneyStr(st, fc.hi[fc.hi.length - 1], pb)],
        ['Annualised volatility', dnum(fc.annualVol * 100, 0) + '%']);
    }
    rows.push([], ['Disclaimer', 'Educational only. Not investment advice — no signals, no automatic orders.']);
    return rows;
  }

  function buildForecastRows(st) {
    const fc = st.analysis.forecast; if (!fc) return [['No forecast available']];
    const lastDate = st.history.dates[st.history.dates.length - 1];
    const C = curOf(st), pb = st.priceBase || 'USD';
    const rows = [['Session', 'Approx date', `Lower 1σ (${C})`, `Mid (${C})`, `Upper 1σ (${C})`]];
    for (let i = 0; i < fc.mid.length; i++)
      rows.push(['+' + (i + 1), addDays(lastDate, i + 1), cnum(st, fc.lo[i], pb), cnum(st, fc.mid[i], pb), cnum(st, fc.hi[i], pb)]);
    return rows;
  }

  function exportExcel(st) {
    const base = `Quantra_${st.symbol}_${new Date().toISOString().slice(0, 10)}`;
    if (window.XLSX) {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildSummaryRows(st)), 'Summary');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildHistoryRows(st)), 'History');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildForecastRows(st)), 'Forecast');
      XLSX.writeFile(wb, base + '.xlsx');
      toast('Excel workbook downloaded');
    } else {
      // CSV fallback (history only)
      const csv = buildHistoryRows(st).map((r) => r.join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = base + '.csv'; a.click();
      toast('Excel lib offline — exported CSV instead');
    }
  }

  /* ---------- chart image for PDF ---------- */
  function chartImage(st) {
    const W = 760, H = 320, pad = 36;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#0E1525'; ctx.fillRect(0, 0, W, H);
    const hist = st.history.closes.slice(-120);
    const fc = st.analysis.forecast;
    const fcMid = fc ? fc.mid : [], fcHi = fc ? fc.hi : [], fcLo = fc ? fc.lo : [];
    const all = hist.concat(fcHi, fcLo);
    const min = Math.min(...all), max = Math.max(...all), rng = max - min || 1;
    const total = hist.length + fcMid.length;
    const x = (i) => pad + (i / (total - 1)) * (W - pad * 2);
    const y = (v) => H - pad - ((v - min) / rng) * (H - pad * 2);
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) { const yy = pad + (g / 4) * (H - pad * 2); ctx.beginPath(); ctx.moveTo(pad, yy); ctx.lineTo(W - pad, yy); ctx.stroke(); }
    // forecast band
    if (fc) {
      ctx.fillStyle = 'rgba(34,211,238,.12)'; ctx.beginPath();
      for (let i = 0; i < fcHi.length; i++) { const xx = x(hist.length + i); const yy = y(fcHi[i]); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
      for (let i = fcLo.length - 1; i >= 0; i--) ctx.lineTo(x(hist.length + i), y(fcLo[i]));
      ctx.closePath(); ctx.fill();
    }
    // history line
    ctx.strokeStyle = '#34D399'; ctx.lineWidth = 2; ctx.beginPath();
    hist.forEach((v, i) => { const xx = x(i), yy = y(v); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }); ctx.stroke();
    // forecast mid (dashed)
    if (fc) {
      ctx.strokeStyle = '#22D3EE'; ctx.setLineDash([6, 4]); ctx.beginPath();
      ctx.moveTo(x(hist.length - 1), y(hist[hist.length - 1]));
      fcMid.forEach((v, i) => ctx.lineTo(x(hist.length + i), y(v))); ctx.stroke(); ctx.setLineDash([]);
    }
    return cv.toDataURL('image/png');
  }

  /* ---------- PDF ---------- */
  function exportPDF(st) {
    if (!(window.jspdf && window.jspdf.jsPDF)) { toast('PDF library is offline — try again in a moment'); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const M = 40; let y = 46; const w = doc.internal.pageSize.getWidth();
    const a = st.analysis, f = st.fundamentals, fc = a.forecast;
    const C = curOf(st), pb = st.priceBase || 'USD', fb = st.fundBase || 'USD';

    doc.setFillColor(6, 9, 18); doc.rect(0, 0, w, doc.internal.pageSize.getHeight(), 'F');
    doc.setTextColor(231, 236, 245);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.text('Quantra AI — Analysis Report', M, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(147, 160, 184);
    y += 18; doc.text(`${st.name} (${st.symbol}) · ${st.type} · ${C}${pb !== C ? ' (from ' + pb + ')' : ''} · ${new Date().toLocaleString()}`, M, y);
    doc.setDrawColor(52, 211, 153); doc.setLineWidth(1.4); y += 10; doc.line(M, y, w - M, y);

    // snapshot
    y += 26; doc.setTextColor(231, 236, 245); doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text('Snapshot', M, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(200, 208, 222);
    const snap = [
      `Price: ${moneyStr(st, a.price, pb)}`, `Trend: ${a.verdict.trend}`,
      `Risk / Reward: ${a.verdict.rr}`, `Confidence: ${a.verdict.confidence}`,
      `Backtested accuracy: ${a.verdict.accuracy}`, `RSI(14): ${a.indicators.rsi != null ? Math.round(a.indicators.rsi) : '—'}`,
      `MACD hist: ${a.indicators.macd ? a.indicators.macd.hist.toFixed(2) : '—'}`, `ADX: ${a.indicators.adx != null ? Math.round(a.indicators.adx) : '—'}`,
      `Support / Resistance: ${moneyStr(st, a.indicators.support, pb)} / ${moneyStr(st, a.indicators.resistance, pb)}`,
    ];
    y += 16; snap.forEach((s, i) => doc.text(s, M + (i % 2) * 260, y + Math.floor(i / 2) * 15));
    y += Math.ceil(snap.length / 2) * 15 + 6;

    // verdict
    y += 12; doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(231, 236, 245); doc.text('AI verdict (technical + fundamental)', M, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(180, 190, 206);
    y += 16; doc.splitTextToSize(st.aiText || a.text, w - M * 2).forEach((ln) => { doc.text(ln, M, y); y += 14; });

    // chart
    y += 8; doc.setDrawColor(40, 50, 70); doc.setFillColor(14, 21, 37);
    try { doc.addImage(chartImage(st), 'PNG', M, y, w - M * 2, 180); y += 192; } catch (e) { y += 6; }
    doc.setFontSize(8); doc.setTextColor(120, 130, 150);
    doc.text('Green = price · Cyan dashed = projected path · shaded = 1σ range', M, y); y += 16;

    // forecast
    if (fc) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(231, 236, 245); doc.text('Future prediction (illustrative)', M, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(200, 208, 222); y += 16;
      const sign = fc.expReturn >= 0 ? '+' : '';
      [`Horizon: 30 sessions`, `Expected drift: ${sign}${(fc.expReturn * 100).toFixed(1)}%`,
       `Projected range: ${moneyStr(st, fc.lo[fc.lo.length - 1], pb)} – ${moneyStr(st, fc.hi[fc.hi.length - 1], pb)}`,
       `Projected mid: ${moneyStr(st, fc.mid[fc.mid.length - 1], pb)}`, `Annualised volatility: ${(fc.annualVol * 100).toFixed(0)}%`]
        .forEach((s) => { doc.text(s, M, y); y += 14; });
    }

    // fundamentals
    if (f) {
      if (y > 660) { doc.addPage(); doc.setFillColor(6, 9, 18); doc.rect(0, 0, w, doc.internal.pageSize.getHeight(), 'F'); y = 46; }
      y += 10; doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(231, 236, 245); doc.text('Fundamentals (screener-style)', M, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(200, 208, 222); y += 16;
      const fr = [
        ['Market Cap', f.marketCap ? capStr(st, f.marketCap, fb) : '—'], ['P/E (TTM)', dnum(f.peTrailing, 1)],
        ['Forward P/E', dnum(f.peForward, 1)], ['EPS', f.eps != null ? moneyStr(st, f.eps, fb) : '—'], ['Price/Book', dnum(f.pb, 2)],
        ['ROE', f.roe != null ? (f.roe * 100).toFixed(1) + '%' : '—'], ['Profit margin', f.profitMargin != null ? (f.profitMargin * 100).toFixed(1) + '%' : '—'],
        ['Debt/Equity', dnum(f.debtToEquity, 1)], ['Rev. growth', f.revenueGrowth != null ? (f.revenueGrowth * 100).toFixed(1) + '%' : '—'],
        ['Div. yield', f.dividendYield != null ? (f.dividendYield * 100).toFixed(2) + '%' : '—'],
      ];
      fr.forEach((row, i) => { const col = i % 2; doc.text(`${row[0]}: ${row[1]}`, M + col * 260, y + Math.floor(i / 2) * 14); });
      y += Math.ceil(fr.length / 2) * 14 + 6;
    }

    // disclaimer
    doc.setFontSize(8); doc.setTextColor(107, 120, 144);
    doc.text(doc.splitTextToSize('Disclaimer: Quantra AI is for educational purposes only. It does not provide signals, automatic orders or investment advice. Projections are illustrative model output, not a guarantee of future performance.', w - M * 2), M, Math.min(y + 14, 800));

    doc.save(`Quantra_${st.symbol}_report.pdf`);
    toast('PDF report downloaded');
  }

  return { exportExcel, exportPDF, toast };
})();
