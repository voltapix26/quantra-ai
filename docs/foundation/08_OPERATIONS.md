# Quantra AI — Operations Runbook (M3)

## Deploy & rollback
- **Deploy:** push to `main` → GitHub Actions CI runs (syntax + engine + smoke) →
  Render auto-deploys (~60–90 s). Verify: `/healthz`, then the page you changed
  with its new `?v=` asset version.
- **Rollback:** Render → your service → *Events* → pick the previous deploy →
  **Rollback**. Or `git revert <sha> && git push`.
- CI failing does NOT block Render (it deploys on push). If CI goes red, revert
  first, investigate second.

## Backups (Render Postgres)
- **Render's own backups:** paid Postgres plans keep automatic daily snapshots
  (Database → Backups → Restore). Free/hobby tiers may not — check yours; if there
  are no automatic backups, the manual dump below is your safety net. Run it
  weekly (or before risky changes) until the DB is upgraded.
- **Manual dump** (from your PC; get the External Database URL from Render):
  ```
  pg_dump "<EXTERNAL_DATABASE_URL>" --no-owner --format=custom \
    --file "quantra-$(date +%Y%m%d).dump"
  ```
- **Restore:**
  ```
  pg_restore --clean --no-owner --dbname "<EXTERNAL_DATABASE_URL>" quantra-YYYYMMDD.dump
  ```
- What's in the DB: users, orgs, sessions, per-user data (watchlists/alerts/
  portfolio/affinity), the hash-chained track-record snapshots, audit log,
  footfall stats. The track-record chain is the irreplaceable part — losing it
  resets the public accuracy history.

## Scheduled jobs (all in server.js, all `.unref()`)
| Job | Cadence | Notes |
|---|---|---|
| Track-record snapshot | 2 h (no-op once done for the day) | + lazy maturation on GET |
| Alert monitor | 60 s | emails + push |
| Self-diagnostics | 12 min | emails super-admins on failure |
| Daily digest emails | 20-min poll, sends 07:00–08:59 UTC | once/user/day |
| Session pruning | daily | deletes expired (30-day TTL) sessions |
| Keep-warm self-ping | 10 min | prevents free-tier cold starts |
| Metrics flush | 2 min | footfall persistence |

## Env vars (Render → Environment) — full inventory
```
DATABASE_URL            Postgres (unset → file store in ./data)
FINNHUB_API_KEY         US real-time + tick stream
RAPIDAPI_KEY            world real-time incl. NSE/BSE + research news (watch quota!)
TWELVEDATA_API_KEY      global quotes (NSE needs Grow/Pro)
POLYGON_API_KEY         US fallback (optional)
COINGECKO_API_KEY       crypto board (optional)
FMP_API_KEY             economic calendar (now premium upstream)
MARKETAUX_API_KEY       premium news (optional)
ANTHROPIC_API_KEY       AI read/brief/ask (+ QUANTRA_AI_MODEL)
DHAN_ACCESS_TOKEN / DHAN_CLIENT_ID   NSE F&O option chains (NIFTY/BANKNIFTY/FINNIFTY) via your Dhan broker account — token expires, renew in DhanHQ
RESEND_API_KEY          email (+ MAIL_FROM after domain verify)
VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT   web-push
SUPER_ADMINS            comma-separated admin emails
STRIPE_SECRET_KEY / STRIPE_PRICE_PRO / STRIPE_PRICE_ULTIMATE / STRIPE_WEBHOOK_SECRET
FORCE_ULTIMATE          "false" = enforce paid plans (see 07_BILLING_RUNBOOK.md)
APP_URL / RENDER_EXTERNAL_URL   canonical URL (keep-warm + email links)
```

## Incident checklist
1. `/healthz` down → Render Events (crashed deploy? OOM?) → rollback.
2. Prices wrong/stale → `/admin → Test data feeds` (per-provider raw error + fix
   hint); `/api/config` shows which keys are loaded.
3. Self-diagnostics email arrived → it names the failing check (crypto_feed,
   stock_feed, price_sanity, forecast_calibration, storage, error_rate).
4. Emails not arriving → `/admin → Send test email`; sandbox sender warning means
   MAIL_FROM/domain not verified in Resend.
5. RapidAPI 429 → quota exhausted; international falls back to delayed Yahoo
   automatically; bump the RapidAPI plan or wait for reset.

## Testing (local & CI)
```
npm test           # syntax check all modules + engine invariants + server smoke
npm run test:engine
npm run test:smoke # boots the real server on a throwaway file store
```
CI: .github/workflows/ci.yml runs the same on every push/PR to main.
