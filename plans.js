/* ============================================================
   Quantra AI — plan definitions & feature limits
   Single source of truth for what each tier unlocks. Server
   enforces these; the client reads them via /api/me/limits.
   ============================================================ */
'use strict';
const PLANS = {
  free:       { label: 'Free',       aiVerdicts: false, intraday: false, exports: false, screener: true, watchlistMax: 25,   aiDaily: 0 },
  pro:        { label: 'Pro',        aiVerdicts: true,  intraday: true,  exports: true,  screener: true, watchlistMax: 200,  aiDaily: 300 },
  ultimate:   { label: 'Ultimate',   aiVerdicts: true,  intraday: true,  exports: true,  screener: true, watchlistMax: 1000, aiDaily: 1500 },
  enterprise: { label: 'Enterprise', aiVerdicts: true,  intraday: true,  exports: true,  screener: true, watchlistMax: 5000, aiDaily: 100000 },
};
const planOf = (p) => PLANS[p] || PLANS.free;
module.exports = { PLANS, planOf };
