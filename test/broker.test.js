'use strict';
/* Unit tests for the bring-your-own-broker adapters (broker.js).
   Bybit is exercised with a mocked global.fetch so no network/keys are needed. */
const assert = require('node:assert');
const broker = require('../broker.js');

let failures = 0;
const ok = (cond, label) => { if (cond) { console.log('  ✓ ' + label); } else { failures++; console.log('  ✗ ' + label); } };

(async () => {
  console.log('broker.test.js');

  // ---- provider registry ----
  const ids = broker.list().map((p) => p.id);
  ok(ids.includes('alpaca'), 'alpaca is registered');
  ok(ids.includes('bybit'), 'bybit is registered');
  const by = broker.list().find((p) => p.id === 'bybit');
  ok(by && /withdrawal/i.test(by.keyHint || ''), 'bybit keyHint warns to disable withdrawal');

  // ---- Bybit adapter, mocked fetch ----
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    let result = {};
    if (url.includes('/v5/account/wallet-balance')) result = { list: [{ totalEquity: '1000', totalAvailableBalance: '800' }] };
    else if (url.includes('/v5/order/create')) result = { orderId: 'ord123' };
    else if (url.includes('/v5/position/list')) result = { list: [] };
    return { ok: true, text: async () => JSON.stringify({ retCode: 0, retMsg: 'OK', result }) };
  };
  try {
    const creds = { mode: 'paper', keyId: 'KEY', secret: 'SECRET' };
    const acct = await broker.PROVIDERS.bybit.account(creds);
    ok(acct.equity === 1000 && acct.cash === 800, 'wallet-balance parsed (equity + available)');
    const c0 = calls[0];
    ok(c0.url.startsWith('https://api-testnet.bybit.com'), 'paper mode → testnet host');
    ok(/^[0-9a-f]{64}$/.test(c0.opts.headers['X-BAPI-SIGN'] || ''), 'HMAC-SHA256 signature header present');
    ok(c0.opts.headers['X-BAPI-API-KEY'] === 'KEY' && !!c0.opts.headers['X-BAPI-TIMESTAMP'], 'auth headers set');

    calls.length = 0;
    await broker.PROVIDERS.bybit.account({ mode: 'live', keyId: 'K', secret: 'S' });
    ok(calls[0].url.startsWith('https://api.bybit.com'), 'live mode → mainnet host');

    calls.length = 0;
    const o = await broker.PROVIDERS.bybit.placeOrder(creds, { symbol: 'btcusdt', side: 'buy', type: 'market', qty: 0.01 });
    const body = JSON.parse(calls[0].opts.body);
    ok(o.id === 'ord123', 'placeOrder returns the order id');
    ok(body.category === 'spot' && body.symbol === 'BTCUSDT' && body.side === 'Buy' && body.orderType === 'Market' && body.qty === '0.01', 'spot market buy body built correctly');

    let threw = false;
    try { await broker.PROVIDERS.bybit.cancel(creds, 'id1', {}); } catch { threw = true; }
    ok(threw, 'cancel refuses without a symbol (Bybit needs category+symbol)');
  } finally { global.fetch = realFetch; }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall broker tests passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
