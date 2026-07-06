# Quantra AI — Implementation Plan & Status

> ✅ shipped & verified in production · 🟡 partial · ⬜ left

## Build sequence (template: Setup → DB → Auth → Core → UI polish → Testing → Deploy → Iterate)

### Phase 0–6: DONE (all deployed to https://quantra-ai.onrender.com)
1. **Setup** — Node server, static pages, Render auto-deploy pipeline ✅
2. **Database** — Postgres + file-store dual backend, hash-chained snapshots ✅
3. **Auth** — signup/login/verify/reset, sessions, plans, super-admin ✅
4. **Core features** ✅
   - Live boards (6 asset classes, 24 stock exchanges) + real-time feed chain
     (Finnhub → Polygon → Twelve Data → RapidAPI → Yahoo; Coinbase WS crypto)
   - Analysis engine (indicators, signals, walk-forward weights, Quantra Score)
   - Probabilistic projections (deterministic MC, EWMA regime vol, 50%+80% bands,
     live self-calibration, verified in-list grading, per-second live projections)
   - Track record (public, graded, tamper-evident) + embeddable badge
   - AI layer (read / Ask-Quantra / daily brief w/ research headlines)
   - Alerts (server-side email+push), watchlist, portfolio, paper, screener,
     calendar, discover, community, notes, news
   - Personalization (affinity → For-you tab + brief)
   - PWA (installable, offline shell, push)
   - Broker scaffold (Alpaca BYO, paper-first, rate-limited)
   - Admin (users, audit, self-diagnostics every 12 min w/ email alerts,
     data-feed tests w/ auto-fix hints, footfall)
5. **UI polish** — cinematic landing, 3D hero, fit-to-screen, mobile chart tooltip ✅
6. **Testing/verification practice** — every deploy verified by scripted endpoint
   checks + headless-browser (Playwright) runs; engine audited vs independent math;
   P50 backtested vs naive baseline (~380 anchors); seconds-mode bug reproduced and
   fixed headless ✅ (⬜ not yet a CI test suite — see below)

## Milestones LEFT (proposed order)
| # | Milestone | Contents | Effort |
|---|---|---|---|
| M1 | ~~Onboarding & retention~~ ✅ DONE | first-run coach-mark tour (onboard.js), getting-started checklist (auto-detects real actions), daily-brief email digest opt-in (Brief page toggle + 07:00-08:59 UTC sender) | ✅ |
| M2 | ~~Billing on~~ ✅ CODE DONE | FORCE_ULTIMATE now env-driven; Stripe checkout/portal/webhook verified wired; admin shows billing status; go-live = operator runs 07_BILLING_RUNBOOK.md (Stripe account + 5 env vars) | ✅ |
| M3 | ~~Quality hardening~~ ✅ DONE | CI (GitHub Actions: syntax + 22 engine invariants + 14-check server smoke on isolated store), daily session pruning (both store backends), ops runbook 08_OPERATIONS.md (backups/restore/env/incidents) | ✅ |
| M4 | ~~India data~~ ✅ ENGINEERED | RapidAPI quota guard: daily call counter in /admin + 30-min circuit breaker on 429 (fails fast to Yahoo). Money decision documented in 09_SCALE_PLAN.md — buy RapidAPI paid tier at first Indian paying user | ✅ |
| M5 | Mobile APK 🟡 | Capacitor Android shell (mobile/), remote-URL wrap of the live PWA; build with `cd mobile && npm run apk` (needs Android SDK — pattern + SDK path from TradeWatch) | 🟡 scaffolded |
| M6 | ~~Broker gating~~ ✅ ENGINEERED | live mode double-gated: BROKER_LIVE_ENABLED=true (operator, post-compliance) + per-user risk acknowledgement checkbox; paper always available. Legal/compliance review is the remaining (non-code) step | ✅ |
| M7 | ~~Team workspaces~~ ✅ DONE | owner invites (email or link, 7-day tokens) → invited signups join the org as members; members list/remove APIs; shared team watchlist (👥 share button + Team board tab, 50 items, priced live) | ✅ |
| M8 | ~~Scale~~ ✅ ENGINEERED | gzip (~70% smaller transfers) + immutable caching for versioned assets; buy-thresholds table (CDN, tick fan-out, Bloomberg, DB tier) in 09_SCALE_PLAN.md | ✅ |

## Recommended AI workflow (template step 1–8) — audit
| Step | Status |
|---|---|
| 1. Write PRD | ✅ docs/foundation/01_PRD.md (this pass) |
| 2. Write TRD | ✅ 02_TRD.md |
| 3. Create App Flow | ✅ 03_APP_FLOW.md |
| 4. Define UI/UX Brief | ✅ 04_UIUX_BRIEF.md |
| 5. Create Backend Schema | ✅ 05_BACKEND_SCHEMA.md |
| 6. Write Implementation Plan | ✅ this file |
| 7. Code with AI | ✅ ongoing (Claude Code; documented honesty guardrails) |
| 8. Ship & iterate | ✅ every change deployed + verified same-session |

**Note:** the app was built code-first; these six documents were back-filled from the
real production system (so they are accurate, not aspirational). Going forward, new
features should update the relevant foundation doc first, then code.

## Final advice (from the source PDF, adopted)
"Better documents → better context for the AI → better output." Quantra's addition:
**better verification** — every claim in these docs is tied to something measurable
in production (track record, self-diagnostics, admin feed tests).
