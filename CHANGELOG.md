# Quantra AI — Changelog & Version History

**Product:** Quantra AI — multi-tenant SaaS market-analysis terminal
**Live:** https://quantra-ai.onrender.com  ·  **Repo:** github.com/voltapix26/quantra-ai
**Current build:** Assets `?v=39` · Service Worker `quantra-v21` · 2026-06-19

Versioning note: each release below maps to a deployed commit. "Assets vN" is the
client cache-bust marker shipped in `index.html`; "SW" is the service-worker cache name.

---

## Phase 6 — Market Status & Real-Time Feeds

### v5.7.0 — Faster, honest live feed *(2026-06-19 · `32f283c` · current)*
- Real-time detail poll **4s → 2.5s**; board refresh **15s → 10s**.
- Freshness label is now accurate: **"live"** (open + fresh), **"delayed feed"** (open + stale),
  **"at last close"** (market closed) — no longer cries "delayed" when a market is simply shut.

### v5.6.0 — Per-exchange holiday calendar *(2026-06-19 · `49a75df`)*
- Authoritative **US** open/closed incl. holidays via Finnhub `market-status` (correctly flags
  closures such as Juneteenth → "Closed · Juneteenth").
- **Curated 2026 holiday calendar** for 13 major non-US exchanges (UK, DE, FR, IT, ES, CH, JP,
  HK, AU, CA, SG, India NSE/BSE) — conservative to avoid false closures.
- Threaded through board, detail badge, Discover and Portfolio.

### v5.5.0 — Stale-session fix (timezone-aware) *(2026-06-19 · `c27b08a`)*
- Yahoo's `range=1d` window is often a day stale (showed NYSE closed while open). Open/closed is
  now computed from the session **time-of-day in the exchange timezone** (gmtoffset) — immune to
  stale dates. Fixed in board, badge, Discover, Portfolio.

### v5.4.0 — Real-time US feed + status dots everywhere *(2026-06-19 · `90df4dc`)*
- Finnhub **real-time US quotes** (stocks + ETFs) override Yahoo in the board and `/api/price`
  with graceful fallback; `/api/price` now returns the session window.
- Open/closed dots added to Discover movers and Portfolio holdings.

### v5.3.0 — Open/close countdown *(2026-06-19 · `c1bad4a`)*
- Badge shows "Market open · closes in 3h 5m" / "Market closed · opens in 14h", live-updating
  every 20s; estimates the next open across weekends.

### v5.2.0 — Live-flipping status *(2026-06-19 · `299ddf3`)*
- Dots and the detail badge re-evaluate against the clock every 20s so they flip exactly at the
  open/close boundary.

### v5.1.0 — Per-row board status dots *(2026-06-19 · `98d5560`)*
- Green = open, grey = closed per exchange session window; crypto always-on, FX weekday-aware.

### v5.0.0 — Market open/closed badge *(2026-06-19 · `b1c1599`)*
- Per-exchange session badge near the ticker: Market open / Pre-market / After-hours / Closed;
  crypto 24/7, forex 24/5.

---

## Phase 5 — Technical Indicator Suite

### v4.2.0 — Enlarge mode + dynamic legend *(2026-06-19 · `2b49273`)*
- Full-width / taller chart toggle (proportional viewBox, persisted) + a legend that lists only
  the active overlays with their colours.

### v4.1.0 — Full indicator suite *(2026-06-19 · `215728b`)*
- Overlays: **Ichimoku Cloud, Supertrend, VWAP, Keltner & Donchian channels**.
- Panes: **ADX, Williams %R, CCI**.
- Shared overlay engine renders every study on **both line and candlestick** charts; persisted and
  stored in saved layouts.

### v4.0.0 — Adaptive averages + Stochastic *(2026-06-19 · `43e075a`)*
- **McGinley Dynamic + EMA(21) + Parabolic SAR** overlays and a **Stochastic (14·3)** pane, all
  toggleable, persisted, and saved in layouts.

---

## Phase 4 — Global Markets & Accurate Pricing

### v3.10.0 — Twelve Data + absolute change *(2026-06-19 · `0ef471d`)*
- Twelve Data (gated, Yahoo fallback) for fresher global/Gulf quotes; the detail now shows the
  **absolute up/down amount beside the %**; audit confirmed all daily-% calcs use prior-session close.

### v3.9.0 — Data freshness transparency *(2026-06-19 · `e345a54`)*
- "Price as of <time> <exchange tz>" line so delayed free feeds (non-US/Gulf/Asia) are visible
  rather than looking wrong. (Confirmed EMAAR −0.46% matched Yahoo exactly — not a calc bug.)

### v3.8.0 — Regional ETFs + Discover market filter *(2026-06-19 · `935d33b`)*
- Country/region ETFs (India, Europe, China, Japan, Korea, Brazil, Saudi, UAE, S. Africa …) and a
  per-exchange breadth/movers/heatmap filter on Discover.

### v3.7.0 — 32 global indices *(2026-06-19 · `789ca78`)*
- TSX, Bovespa, IPC, KOSPI, TWSE, STI, SMI, IBEX, FTSE MIB, AEX, OMX, SSE, Shenzhen, Bank Nifty,
  KLCI, IDX, TASI, JSE + existing — shown as raw points (no FX conversion).

### v3.6.0 — 25 world stock exchanges *(2026-06-19 · `878e4ca`)*
- US, Canada, Brazil, Mexico, Europe, UK, Switzerland, Nordics, India NSE+BSE, China, Japan, Korea,
  Taiwan, HK, Singapore, Australia, SE Asia, UAE, Saudi, South Africa. **Currency follows the
  exchange** (16 currencies) with pence/cents minor-unit normalization.

### v3.5.0 — Stock market bifurcation *(2026-06-19 · `2815a77`)*
- Exchange selector (US / India NSE / India BSE / Europe / UAE / Hong Kong); display currency
  auto-follows the exchange (INR/AED/EUR/HKD/USD); `/api/stock/board?market=` + `/api/stock/markets`.

### v3.4.0 — Speed: keep-warm + faster board *(2026-06-19 · `aaebd38`)*
- Keep-warm self-ping removes free-tier cold start (~50s wake → instant); board refresh 25s → 15s.

### v3.3.0 — Fix board 24h % (MSFT bug) *(2026-06-19 · `4a301fa`)*
- Was using `chartPreviousClose` (≈1 month ago on the 1-month range) → wildly wrong daily change
  (MSFT −10% on an up day). Now compares to prior-session close, session-aware for pre-market.

---

## Phase 3 — Premium Data & Forecast Accuracy

### v3.2.0 — Live calibration widget *(2026-06-19 · `c8f3119`)*
- Snapshots store daily sigma; server computes realised **80%-band coverage** per horizon from real
  forward outcomes; Track Record shows live in-band % vs the 80% target (provable, not back-filled).

### v3.1.0 — Forecast calibration to 80% *(2026-06-19 · `9da53c6`)*
- Bootstrap Monte-Carlo from real returns (fat tails) + drift shrinkage + MC-median central path.
  P10–P90 band now ~**80% calibrated** (80.1% realised vs 74.4% before) on a 5yr / 10-symbol backtest.

### v3.0.0 — Premium data feeds *(2026-06-19 · `970189b`)*
- **FMP** economic calendar (real macro feed) + **marketaux** multi-source news with source badges
  and sentiment; key-gated with graceful fallback; admin status + `.env.example`.

---

## Phase 2 — 10-Feature SaaS Roadmap

### v2.10.0 — Community *(2026-06-19 · `a943691`)*
- Shared trade ideas (post / upvote / delete) + paper-trading leaderboard (ranked returns).

### v2.9.0 — Paper trading *(2026-06-19 · `80e1a56`)*
- Simulated cash account, live buy/sell, positions with unrealized P&L, realized P&L, trade history,
  research journal; account-synced.

### v2.8.0 — Bollinger + bar replay + saved layouts *(2026-06-19 · `a662f39`)*
- Bollinger Bands overlay + bar replay (step/play/scrub, studies evolve) + account-synced layouts.

### v2.7.0 — AI daily brief *(2026-06-19 · `81f6056`)*
- Personalized watchlist + portfolio digest (movers, breadth, upcoming earnings) with AI/local
  narrative; `/api/brief`.

### v2.6.0 — PWA + push *(2026-06-19 · `4eb20e2`)*
- Installable app (manifest + service worker + offline shell) + VAPID web-push wired into the alert
  engine; per-device push controls.

### v2.5.0 — Market calendar *(2026-06-19 · `9854558`)*
- Earnings (watchlist/popular/all), IPOs, economic events via Finnhub with graceful premium fallback.

### v2.4.0 — Market discovery *(2026-06-19 · `66c012d`)*
- Live heatmap + top movers + breadth gauge across all asset classes; `/api/discover` aggregator.

### v2.3.0 — Monitored alerts + email *(2026-06-19 · `8bcd130`)*
- Server-side alert engine fires even when the tab is closed + emails on trigger; price/percent
  conditions; account-synced.

### v2.2.0 — Ask Quantra AI analyst *(2026-06-19 · `56996df`)*
- Grounded conversational analyst (LLM when keyed + smart local fallback), per-asset chat panel,
  suggested prompts, 40/hr rate limit.

### v2.1.0 — Portfolio tracker *(2026-06-19 · `3fc73dd`)*
- Holdings, live P&L, allocation, totals; account-synced; universal `/api/price` endpoint.

---

## Phase 1 — Foundation & Live Data *(2026-06-18)*

### v1.8.0 — Admin oversight & analytics *(`089e84c`, `b6129de`, `fc9f8e9`, `ecdd330`)*
- Super-admin audit log + admin panel (emails/metadata only, **never passwords**); crypto 429 cloud
  fix (stale cache + CoinPaprika fallback); private notes page; privacy-friendly footfall analytics.

### v1.7.0 — Alerts & drawing tools *(`4ab96d9`, `af72a91`)*
- Price alerts (live notifications + chart levels) + drawing tools: trendline, horizontal level,
  Fibonacci retracement.

### v1.6.0 — Indicator panes & chart types *(`d46ccf1`)*
- RSI / MACD / Volume panes, candlestick pattern recognition, Heikin Ashi + Area chart types.

### v1.5.0 — Tick-by-tick stocks *(`621e9c6`, `4b76a12`, `a6dfc9b`)*
- Live seconds chart (Finnhub ~1s) + seconds projection; Finnhub WS → SSE relay (key stays
  server-side) with watchdog fallback.

### v1.4.0 — Cloud-resilient live crypto *(`c9ccd3f`, `8581ed5`)*
- Coinbase WS crypto streaming (Binance 451-geoblocks Render's US IP); sub-second ticks for US users.

### v1.3.0 — Candles + dated projections *(`9c4ff12`)*
- Candlestick toggle + dated, checkable Monte-Carlo projections.

### v1.2.0 — Live data backbone *(`5971d34`)*
- Crypto WS streaming + Finnhub real-time stock quotes & news.

### v1.1.0 — Responsive mobile *(`812f217`, `fe14f60`, `4ebc1f1`)*
- Phone breakpoints; screener + notes mobile layouts.

### v1.0.0 — Initial deploy *(`147945d`, `af2c447`, `a60ba33`)*
- First public deploy (instant link + permanent hosting); one-click share launcher; pg-pool error
  + process-level crash guards.

---

## Data sources
CoinGecko / CoinPaprika (crypto) · Coinbase (crypto OHLC + WS) · Yahoo Finance (stocks/ETF/index/
commodity/FX) · Finnhub (real-time US quotes, news, calendars, market-status, WS) · Twelve Data
(gated global quotes) · FMP (gated economic calendar) · marketaux (gated premium news) ·
open.er-api (FX). All paid sources are **key-gated with graceful fallback**.

## Optional environment keys
`ANTHROPIC_API_KEY` · `RESEND_API_KEY` · `VAPID_PUBLIC/PRIVATE_KEY` + `VAPID_SUBJECT` ·
`FINNHUB_API_KEY` · `TWELVEDATA_API_KEY` · `FMP_API_KEY` · `MARKETAUX_API_KEY` ·
`COINGECKO_KEY` · `SUPER_ADMINS`.
