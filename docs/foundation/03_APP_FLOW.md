# Quantra AI — App Flow (User Navigation)

> ✅ done & live · ⬜ left

## Screen inventory (19 pages, all live)
| Screen | File | Purpose |
|---|---|---|
| Landing | index.html | Cinematic textura-style marketing page → CTAs to terminal |
| Terminal | terminal.html | The core: boards, charts, analysis, projections, Ask-Quantra |
| Brief | brief.html | AI daily brief + For-you panel |
| Discover | discover.html | Heatmap, movers, breadth |
| Calendar | calendar.html | Economic + earnings calendar |
| Screener | screener.html | Multi-filter screener w/ saved screens |
| Paper | paper.html | Paper trading |
| Trade | broker.html | BYO-broker (Alpaca, paper-first) |
| Portfolio | portfolio.html | Holdings tracker |
| Community | community.html | Shared ideas + leaderboard |
| Track record | track-record.html | Public graded accuracy + calibration + ledger |
| News | news.html | News reader |
| Notes | notes.html | Personal notes |
| Admin | admin.html | Super-admin: users/audit/diagnostics/feed tests |
| Auth | verify.html, reset.html | Email verify / password reset |
| Legal | terms.html, privacy.html, refund.html | Policies |

## Primary flow
```
Landing (index)
   │ "Open terminal"
   ▼
Terminal ── select asset ── live price + AI read + projections
   │            │ interval=Seconds → live tick chart (ms readout, per-second projections)
   │            │ set alert / add watchlist / ask Quantra / export
   ├── nav bar → Brief · Discover · Calendar · Screener · Paper · Trade · Portfolio · Community · Track record · News
   └── Sign in (modal) ─ signup → verify email → signed in (Ultimate plan)
                          │ forgot → reset.html
Account menu: plan · workspace · export data · sign out · delete account
```

## Login / onboarding
- Anonymous: full market data + analysis work without an account (localStorage). ✅
- Signup: email+password → verification email (Resend) → verified badge; unverified
  users still work with a warning banner. ✅
- Sync: watchlist/prefs/screens/portfolio/layouts/paper/alerts/affinity per-user. ✅
- ⬜ Guided first-run tour ("what is the Quantra Score?") — not built.
- ⬜ Empty-state onboarding checklist (add first watchlist item → set first alert).

## Edge / error handling (as built)
- Every data feed has a fallback chain; freshness labeled honestly ("live" / "delayed
  feed" / "at last close"). ✅
- AI features degrade to local heuristics without keys. ✅
- Offline: PWA serves cached shell; API calls fail soft. ✅
- Self-diagnostics email the admin when a feed/storage check fails. ✅

## App-Flow checklist vs template
| Template item | Status |
|---|---|
| Which screens exist | ✅ |
| How the user moves between screens | ✅ |
| Login flow | ✅ |
| Onboarding | 🟡 works, but no guided tour (left) |
| Dashboard | ✅ (terminal) |
| Logout / account management | ✅ incl. export + delete |
