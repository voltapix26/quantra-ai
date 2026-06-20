/* ============================================================
   Quantra AI — bring-your-own-broker adapters
   The USER supplies their OWN broker API credentials. Quantra
   never holds funds — the regulated broker custodies the money
   and executes. Quantra only routes orders the user explicitly
   places. Paper mode is the default; live requires opt-in.
   ============================================================ */
'use strict';

const ALPACA_HOSTS = { paper: 'https://paper-api.alpaca.markets', live: 'https://api.alpaca.markets' };

async function alpacaReq(creds, path, opts = {}) {
  const host = ALPACA_HOSTS[creds.mode === 'live' ? 'live' : 'paper'];
  const r = await fetch(host + path, {
    ...opts,
    headers: { 'APCA-API-KEY-ID': creds.keyId, 'APCA-API-SECRET-KEY': creds.secret, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const raw = await r.text().catch(() => '');
  let body = null; try { body = raw ? JSON.parse(raw) : null; } catch {}
  if (!r.ok) { const e = new Error((body && (body.message || body.msg)) || raw || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  return body;
}

const PROVIDERS = {
  alpaca: {
    label: 'Alpaca',
    region: 'US',
    signupUrl: 'https://alpaca.markets',
    docsUrl: 'https://docs.alpaca.markets/docs/getting-started',
    // Free, instant paper keys at app.alpaca.markets → Paper Trading → API keys.
    async account(creds) {
      const a = await alpacaReq(creds, '/v2/account');
      return { cash: +a.cash, equity: +a.equity, buyingPower: +a.buying_power, currency: a.currency || 'USD', status: a.status, blocked: !!(a.trading_blocked || a.account_blocked) };
    },
    async positions(creds) {
      const ps = await alpacaReq(creds, '/v2/positions');
      return (ps || []).map((p) => ({ symbol: p.symbol, qty: +p.qty, avgEntry: +p.avg_entry_price, marketValue: +p.market_value, unrealizedPL: +p.unrealized_pl, unrealizedPLpc: +p.unrealized_plpc * 100, currentPrice: +p.current_price, side: p.side }));
    },
    async placeOrder(creds, o) {
      const body = { symbol: String(o.symbol).toUpperCase(), side: o.side === 'sell' ? 'sell' : 'buy', type: o.type === 'limit' ? 'limit' : 'market', time_in_force: o.tif || 'day' };
      if (o.qty) body.qty = String(o.qty); else if (o.notional) body.notional = String(o.notional);
      else throw Object.assign(new Error('Provide a quantity or notional amount.'), { status: 400 });
      if (body.type === 'limit') { if (!(o.limitPrice > 0)) throw Object.assign(new Error('A limit price is required for limit orders.'), { status: 400 }); body.limit_price = String(o.limitPrice); }
      const r = await alpacaReq(creds, '/v2/orders', { method: 'POST', body: JSON.stringify(body) });
      return { id: r.id, symbol: r.symbol, qty: r.qty != null ? +r.qty : null, side: r.side, type: r.type, status: r.status, submittedAt: r.submitted_at };
    },
    async orders(creds) {
      const os = await alpacaReq(creds, '/v2/orders?status=all&limit=40&direction=desc');
      return (os || []).map((r) => ({ id: r.id, symbol: r.symbol, qty: r.qty != null ? +r.qty : null, side: r.side, type: r.type, status: r.status, filledQty: +r.filled_qty || 0, filledAvg: r.filled_avg_price ? +r.filled_avg_price : null, submittedAt: r.submitted_at }));
    },
    async cancel(creds, id) { await alpacaReq(creds, '/v2/orders/' + encodeURIComponent(id), { method: 'DELETE' }); return { ok: true }; },
  },
};

// Validate a connection by hitting the broker's account endpoint with the given creds.
async function verify(provider, creds) {
  const p = PROVIDERS[provider]; if (!p) throw Object.assign(new Error('Unknown broker.'), { status: 400 });
  return p.account(creds);
}

const list = () => Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, region: p.region, signupUrl: p.signupUrl, docsUrl: p.docsUrl }));

module.exports = { PROVIDERS, verify, list };
