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
| M1 | Onboarding & retention | first-run tour, empty-state checklist, email digests opt-in | S |
| M2 | Billing on | re-enable Stripe plans (Free/Pro/Ultimate limits), refund flow already documented | M |
| M3 | Quality hardening | CI (GitHub Actions): node --check, engine invariant tests, Playwright smoke; session pruning; DB backup runbook | M |
| M4 | India data decision | either Twelve Data Grow/Pro or keep RapidAPI (watch free-tier quota in /admin) | S/$ |
| M5 | Mobile APK | Capacitor wrap (pattern exists from TradeWatch project) | M |
| M6 | Broker GA | live-trading gating, compliance text, per-broker adapters beyond Alpaca | L |
| M7 | Team workspaces | multi-seat orgs, shared watchlists/screens | L |
| M8 | Scale | CDN for static, WS fan-out service, Bloomberg tier (investor funding) | L/$ |

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
