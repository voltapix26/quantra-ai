/* ============================================================
   Quantra AI — bring-your-own-broker adapters
   The USER supplies their OWN broker API credentials. Quantra
   never holds funds — the regulated broker custodies the money
   and executes. Quantra only routes orders the user explicitly
   places. Paper mode is the default; live requires opt-in.
   ============================================================ */
'use strict';

const crypto = require('crypto');

const ALPACA_HOSTS = { paper: 'https://paper-api.alpaca.markets', live: 'https://api.alpaca.markets' };

// --- Bybit v5 (unified account). paper => testnet, live => mainnet. ---
const BYBIT_HOSTS = { paper: 'https://api-testnet.bybit.com', live: 'https://api.bybit.com' };

// Bybit v5 auth: X-BAPI-SIGN = HMAC_SHA256(secret, timestamp + apiKey + recvWindow + (GET queryString | POST rawBody)).
async function bybitReq(creds, method, path, params = {}) {
  const host = BYBIT_HOSTS[creds.mode === 'live' ? 'live' : 'paper'];
  const ts = Date.now().toString();
  const recv = '5000';
  const query = method === 'GET' ? new URLSearchParams(params).toString() : '';
  const bodyStr = method === 'GET' ? '' : JSON.stringify(params);
  const signPayload = ts + creds.keyId + recv + (method === 'GET' ? query : bodyStr);
  const sign = crypto.createHmac('sha256', creds.secret).update(signPayload).digest('hex');
  const url = host + path + (query ? '?' + query : '');
  const r = await fetch(url, {
    method,
    headers: {
      'X-BAPI-API-KEY': creds.keyId, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': recv,
      'X-BAPI-SIGN': sign, 'Content-Type': 'application/json',
    },
    ...(method === 'GET' ? {} : { body: bodyStr }),
  });
  const raw = await r.text().catch(() => '');
  let body = null; try { body = raw ? JSON.parse(raw) : null; } catch {}
  if (!r.ok) {
    // Bybit's edge returns a bare 401/403 for an unknown/wrong-network key.
    const hint = (r.status === 401 || r.status === 403)
      ? 'Invalid API key or signature — check the key/secret and that it is a testnet key for paper mode (mainnet key for live).'
      : ((body && body.retMsg) || raw || ('HTTP ' + r.status));
    const e = new Error(hint); e.status = r.status; throw e;
  }
  if (body && body.retCode !== 0) { const e = new Error(body.retMsg || ('Bybit error ' + body.retCode)); e.status = 400; e.bybitCode = body.retCode; throw e; }
  return body ? body.result : null;
}

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
  bybit: {
    label: 'Bybit',
    region: 'Global (restricted in some countries — check your local rules)',
    signupUrl: 'https://www.bybit.com',
    docsUrl: 'https://bybit-exchange.github.io/docs/v5/intro',
    // Paper mode uses the Bybit TESTNET (testnet.bybit.com — free fake funds).
    // Create a Unified Trading Account API key with "Trade" enabled and
    // WITHDRAWAL DISABLED; add an IP allowlist. Symbols are like BTCUSDT.
    keyHint: 'Unified account API key with Trade enabled and WITHDRAWAL DISABLED. Paper mode = testnet.bybit.com keys.',
    async account(creds) {
      const r = await bybitReq(creds, 'GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
      const a = r && r.list && r.list[0];
      const avail = a ? +(a.totalAvailableBalance || a.totalMarginBalance || 0) : 0;
      return { cash: avail, equity: a ? +(a.totalEquity || 0) : 0, buyingPower: avail, currency: 'USD', status: 'active', blocked: false };
    },
    async positions(creds) {
      // Linear USDT perps are where positions live; spot holdings show as balances, not positions.
      const r = await bybitReq(creds, 'GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' }).catch(() => null);
      return ((r && r.list) || []).filter((p) => +p.size !== 0).map((p) => ({
        symbol: p.symbol, qty: +p.size, avgEntry: +p.avgPrice, marketValue: +p.positionValue,
        unrealizedPL: +p.unrealisedPnl, unrealizedPLpc: (+p.positionValue > 0 ? (+p.unrealisedPnl / +p.positionValue) * 100 : 0),
        currentPrice: +p.markPrice, side: (p.side || '').toLowerCase(),
      }));
    },
    async placeOrder(creds, o) {
      const category = ['spot', 'linear', 'inverse'].includes(o.category) ? o.category : 'spot';
      const body = { category, symbol: String(o.symbol).toUpperCase(), side: o.side === 'sell' ? 'Sell' : 'Buy', orderType: o.type === 'limit' ? 'Limit' : 'Market' };
      if (o.qty) body.qty = String(o.qty);
      else if (o.notional && category === 'spot') { body.qty = String(o.notional); body.marketUnit = 'quoteCoin'; }  // spot market order by quote amount
      else throw Object.assign(new Error('Provide a quantity (or a notional amount for spot).'), { status: 400 });
      if (body.orderType === 'Limit') { if (!(o.limitPrice > 0)) throw Object.assign(new Error('A limit price is required for limit orders.'), { status: 400 }); body.price = String(o.limitPrice); }
      const r = await bybitReq(creds, 'POST', '/v5/order/create', body);
      return { id: r && r.orderId, symbol: body.symbol, qty: o.qty != null ? +o.qty : null, side: body.side.toLowerCase(), type: body.orderType.toLowerCase(), status: 'submitted', submittedAt: new Date().toISOString() };
    },
    async orders(creds) {
      // Open orders are per-category; merge spot + linear so the user sees everything live.
      const grab = (category) => bybitReq(creds, 'GET', '/v5/order/realtime', { category, limit: 30 }).then((r) => (r && r.list) || []).catch(() => []);
      const lists = await Promise.all([grab('spot'), grab('linear')]);
      return lists.flat().map((o) => ({ id: o.orderId, symbol: o.symbol, qty: o.qty != null ? +o.qty : null, side: (o.side || '').toLowerCase(), type: (o.orderType || '').toLowerCase(), status: (o.orderStatus || '').toLowerCase(), filledQty: +o.cumExecQty || 0, filledAvg: o.avgPrice ? +o.avgPrice : null, submittedAt: o.createdTime ? new Date(+o.createdTime).toISOString() : null }));
    },
    async cancel(creds, id, extra) {
      // Bybit needs category + symbol + orderId to cancel (unlike Alpaca's id-only).
      const category = extra && ['spot', 'linear', 'inverse'].includes(extra.category) ? extra.category : 'spot';
      const symbol = extra && extra.symbol ? String(extra.symbol).toUpperCase() : '';
      if (!symbol) throw Object.assign(new Error('Bybit needs the symbol to cancel an order.'), { status: 400 });
      await bybitReq(creds, 'POST', '/v5/order/cancel', { category, symbol, orderId: id });
      return { ok: true };
    },
  },
};

// Validate a connection by hitting the broker's account endpoint with the given creds.
async function verify(provider, creds) {
  const p = PROVIDERS[provider]; if (!p) throw Object.assign(new Error('Unknown broker.'), { status: 400 });
  return p.account(creds);
}

const list = () => Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, region: p.region, signupUrl: p.signupUrl, docsUrl: p.docsUrl, keyHint: p.keyHint || null }));

module.exports = { PROVIDERS, verify, list };
