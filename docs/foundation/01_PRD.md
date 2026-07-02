# Quantra AI — PRD (Product Requirements Document)

> Status legend: ✅ done & live in production · 🟡 partial · ⬜ left / planned

## App Name & Purpose
**Quantra AI** — a multi-tenant SaaS market-analysis terminal: live global market data
(crypto, stocks, ETFs, commodities, indices, FX), an honest AI analysis engine
(Quantra Score, calibrated probabilistic projections, a public graded track record),
and personal tools (watchlists, alerts, portfolio, paper trading, daily AI brief).
Deployed at **https://quantra-ai.onrender.com** (GitHub voltapix26/quantra-ai → Render).

**Positioning:** the honest retail terminal — every projection is probabilistic,
labeled with its real confidence, and publicly graded against what actually happened.
No fabricated precision, no guaranteed-profit claims.

## Target Users
- Retail traders/investors (India + Gulf + US focus) who want live data without a
  Bloomberg budget.
- Analysts/students who want indicator + fundamental + news synthesis in one read.
- The operator (super-admin) running it as a SaaS with plan tiers.

## Core Features — status
| Feature | Status |
|---|---|
| Live boards: crypto / stocks (24 exchanges) / ETFs / commodities / indices / FX | ✅ |
| Real-time feeds: Coinbase WS (crypto), Finnhub (US), RapidAPI Google-Finance (world incl. NSE/BSE), Twelve Data + Polygon (key-gated), Yahoo fallback | ✅ |
| Seconds-mode live tick chart w/ millisecond readout + per-second projections + measured live hit rate | ✅ |
| Analysis: 11+ indicators, signals w/ walk-forward-learned weights, Quantra Score, regime detection | ✅ |
| Probabilistic projections: P50 + tight 50% band + calibrated 80% band, self-calibrating vs live track record, deterministic MC | ✅ |
| Verified outcomes: every projection graded in-list (✓ 50% / ✓ 80% / direction / ✗) | ✅ |
| Public track record: hash-chained daily snapshots, accuracy + band calibration, embeddable badge | ✅ |
| AI: analysis "read", Ask-Quantra chat, daily personalized brief w/ research headlines (Anthropic, key-gated) | ✅ |
| News + sentiment: RapidAPI research feed merged w/ Yahoo, finance-lexicon + AI sentiment | ✅ |
| Personalization: affinity tracking → For-you tab + brief panel | ✅ |
| Accounts: signup/login/verify/reset, session cookies, plans (all Ultimate for now) | ✅ |
| Watchlist, alerts (server-side email/push), portfolio, paper trading, screener, calendar, community, notes | ✅ |
| PWA: installable, offline shell, web-push | ✅ |
| Broker (BYO Alpaca, paper-first) w/ rate limits | ✅ scaffold |
| Admin: users, audit log, self-diagnostics, data-feed tests w/ fix hints, footfall stats | ✅ |
| Payments/billing (Stripe wired but plans forced Ultimate) | 🟡 |
| Mobile APK (Capacitor) | ⬜ |
| Live (non-paper) broker execution | ⬜ deliberate — compliance first |
| Team/multi-seat workspaces | ⬜ |

## Non-Features (explicitly out of scope)
- Autonomous trading, "picosecond/microsecond execution", guaranteed returns — refused
  by design; microsecond latency exists only as the co-located roadmap tier in the
  investor deck.
- Password recovery/inspection by admins (scrypt one-way, delete-only admin).
- Betting/gaming mechanics.

## Success Metrics
| Metric | Where measured | Status |
|---|---|---|
| Directional accuracy per horizon (target: honestly >50%) | /track-record (live, no back-fill) | ✅ measuring |
| 80% band coverage → 80% (self-calibrating loop) | /track-record calibration | ✅ measuring |
| Daily active users / page views | /admin footfall | ✅ measuring |
| Signups → retained (For-you engagement) | affinity data | 🟡 tracked, no funnel report |
| Paying conversion | Stripe | ⬜ (plans free/Ultimate for now) |

## User Stories (top)
1. As a trader I open an asset and get a live price, a plain-language AI read, and a
   projection with honest odds — ✅
2. As a user I set an alert and get an email/push even with the tab closed — ✅
3. As a skeptic I check the public track record before trusting the score — ✅
4. As an India-based user I see live NSE prices, not 15-min delayed — ✅ (RapidAPI)
5. As the operator I diagnose a broken data key from /admin in one click — ✅
6. As a paying customer I upgrade to a higher plan — ⬜ (billing intentionally off)

## PRD checklist vs the Vibe-Coding template
| Template item | Quantra status |
|---|---|
| What it is / why it exists | ✅ this doc |
| Target users | ✅ |
| Core features | ✅ |
| Non-features | ✅ |
| Success metrics | ✅ (live-measured, not aspirational) |
| Task flow / example section | ✅ see 03_APP_FLOW.md |
