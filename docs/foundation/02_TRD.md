# Quantra AI — TRD (Technical Requirements Document)

> ✅ done & live · 🟡 partial · ⬜ left

## Stack (as built)
| Layer | Choice | Status |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS (no framework) — 19 pages, one shared styles.css, SVG charts hand-rolled | ✅ |
| Backend | Node.js single `server.js` (no Express) — static server + JSON API + SSE relay | ✅ |
| Database | Postgres on Render (`DATABASE_URL`) with file-store fallback (`data/`) for local dev | ✅ |
| Auth | scrypt password hashes, session tokens (cookie `qsid` HttpOnly+SameSite=Lax+Secure, plus Bearer) | ✅ |
| AI | @anthropic-ai/sdk (key-gated; local heuristic fallback for every AI feature) | ✅ |
| Email | Resend (key-gated) | ✅ |
| Push | web-push VAPID (key-gated) | ✅ |
| Payments | Stripe (optional dep; plans currently forced Ultimate) | 🟡 |
| Hosting | Render auto-deploy from GitHub main (~60–90 s) | ✅ |
| PWA | manifest + service worker (versioned cache `quantra-vNN`) | ✅ |

## Architecture
```
Browser (19 static pages + terminal.js/analysis.js/auth.js/pwa.js)
   │  fetch /api/* · SSE /api/stream/trades · WS direct to Coinbase
   ▼
server.js (Node http)
   ├── static file server (CSP/HSTS headers, no-store on scripts)
   ├── /api data proxy + TTL cache (serve-stale-on-failure)
   │     precedence per symbol: Finnhub → Polygon → Twelve Data → RapidAPI → Yahoo
   │     crypto: Coinbase WS + CoinGecko · FX: open.er-api · calendar: FMP · news: RapidAPI+Yahoo+marketaux
   ├── accounts/orgs/sessions/userData  ──► Postgres | file store
   ├── alert monitor (timer) ──► Resend email + web-push
   ├── track record: daily hash-chained snapshots + lazy maturation
   ├── self-diagnostics every 12 min ──► email super-admins on failure
   └── /api/admin/* (super-admin: users, audit, datatest, selfcheck)
```

## Data sources & keys (env)
| Source | Env var | Role | Status |
|---|---|---|---|
| Finnhub | FINNHUB_API_KEY | US real-time quotes, ticks (SSE relay), market status | ✅ active |
| RapidAPI (Real-Time Finance Data) | RAPIDAPI_KEY (+RAPIDAPI_HOST) | world real-time incl. NSE/BSE + research news | ✅ active |
| Twelve Data | TWELVEDATA_API_KEY | global quotes (NSE needs Grow/Pro tier) | 🟡 key set, tier doesn't cover NSE |
| Polygon | POLYGON_API_KEY | US fallback | ⬜ not set (not worth $50 vs free Finnhub) |
| CoinGecko / Coinbase | COINGECKO_KEY / — | crypto board / live WS | ✅ |
| FMP / marketaux | FMP_API_KEY / MARKETAUX_API_KEY | calendar / premium news | ✅ |
| Anthropic | ANTHROPIC_API_KEY + QUANTRA_AI_MODEL | AI read/brief/ask | ✅ |
| Resend / VAPID | RESEND_API_KEY / VAPID_* | email / push | ✅ |
| Admin | SUPER_ADMINS | comma list of admin emails | ✅ |

Rule: every key is optional — features activate when set, degrade gracefully when not.
Keys live ONLY in Render env / gitignored .env; never in code or chat.

## Analysis engine (analysis.js — pure functions, shared client+server)
- Indicators: RSI, SMA20/50/200, EMA, MACD, ADX, Stoch, Bollinger, ATR, OBV, S/R,
  Ichimoku/PSAR/VWAP/Supertrend/Keltner/Donchian overlays. Verified against
  independent calculations (RSI/SMA exact match on real AAPL data).
- Forecast: bootstrap Monte Carlo (1,200 paths, seeded/deterministic), EWMA (λ=.94)
  regime-scaled shocks, no momentum drift (backtested worse), news-impact nudge,
  P25–P75 (50%) + P10–P90 (80%) bands, live-calibration width feedback.
- Scoring: walk-forward-learned signal weights, out-of-sample accuracy in confidence.

## Security (implemented)
CSP/HSTS/X-Frame headers · scrypt · HttpOnly/SameSite cookies · 2 MB body cap ·
rate limits (auth + broker connect/order) · weak-password rejection · audit log ·
admin delete-only (no password access) · keys masked in admin UI.

## TRD checklist vs template
| Template item | Status |
|---|---|
| Frontend framework | ✅ (deliberately framework-free; documented) |
| Backend | ✅ |
| Database | ✅ |
| APIs | ✅ (documented above w/ precedence) |
| Hosting/deploy | ✅ |
| Authentication | ✅ |
| Architecture diagram | ✅ |

## Left / decisions pending
- ⬜ Twelve Data Grow/Pro upgrade decision (RapidAPI currently covers India).
- ⬜ Bloomberg B-PIPE tier (investor-deck roadmap, ~$24k+/yr).
- ⬜ Postgres migrations tooling (schema is created ad-hoc on boot).
- ⬜ Automated test suite in CI (verification is currently scripted spot-checks).
- ⬜ CDN/static split if traffic grows beyond a single Render instance.
