# Moving Quantra to a Bybit-reachable region

Bybit geo-blocks US and cloud IPs, so from a **US Render region** (oregon / ohio /
virginia) the server cannot reach `api.bybit.com`. That takes out the Bybit **data
feed** and the Bybit **live broker** path (both are server-side calls). Everything else
(Coinbase, CoinGecko, Yahoo, Finnhub) works fine, so the app stays up — Bybit just goes
dark. Moving the server to **Frankfurt (EU)** — or **Singapore** as a fallback — restores it.

## The Render reality (read first)

**A Render service's region is fixed at creation.** You cannot flip it in place. Moving
region = **create a new service** in the target region and cut over to it. The blueprint
(`render.yaml`) now pins `region: frankfurt` for both the web service and the database.

**Reachability is empirical.** Frankfurt is the best first bet, but nobody can promise a
given region reaches Bybit. You verify it *after* deploy with the new self-check:
- Open **`/status`** → the **“bybit data”** row reads **available** (green) if reachable,
  **region-gated** (amber) if still blocked.
- Or, unauthenticated: `curl https://<new-host>/api/config` → `"bybitReachable": true`.

## Protect the data BEFORE you move

The database is the thing to not lose. Two safe paths:

- **Reusing an external DB (recommended):** if `DATABASE_URL` already points at Neon or
  another managed Postgres, the new region’s service just reconnects to it. **No data
  moves, nothing to restore.** This is the cleanest cutover.
- **DB is on Render in the old region:** take a backup first, create a new DB in the new
  region, and restore into it:
  ```bash
  # 1. Fresh backup from the CURRENT deployment (needs BACKUP_TOKEN set)
  curl -H "X-Backup-Token: $BACKUP_TOKEN" https://quantra-ai.onrender.com/api/admin/backup -o backup.json
  # 2. …after the new Frankfurt service + DB exist, restore into the new DB:
  DATABASE_URL='postgres://…new-frankfurt-db…' node scripts/restore-backup.js backup.json --confirm
  ```
  (See `docs/BACKUP_AND_RESTORE.md`. Restore is an upsert, safe to re-run.)

## Steps

1. **Back up** (above), or confirm your DB is external and will be reused.
2. In Render: **New +  →  Blueprint  →  this repo.** With the pinned `region: frankfurt`
   it creates `quantra-ai` + `quantra-db` in Frankfurt. (Or New Web Service, region =
   Frankfurt, same repo.)
3. **Re-enter every env var** on the new service — they do NOT carry over from the old one:
   `DATABASE_URL` (auto-wired by the blueprint, or your external URL), `ANTHROPIC_API_KEY`,
   `QUANTRA_AI_MODEL`, `BROKER_ENC_KEY`, `BROKER_LIVE_ENABLED`, `PUTER_AI`,
   `STRIPE_SECRET_KEY`, `APP_URL`, `BACKUP_TOKEN`, plus any data-feed keys
   (`FINNHUB_KEY`, `TWELVEDATA_KEY`, `POLYGON_KEY`, `RAPIDAPI_KEY`, `DHAN_*`).
4. **Restore data** into the new DB (step 1’s backup) unless you reused an external DB.
5. **Verify** on the new host: `/healthz` = 200, `/status` shows storage OK + feeds OK,
   and the **“bybit data”** row is **available**. If it’s still **region-gated**, redeploy
   with `region: singapore` and re-check.
6. **Cut over:** point your shared URL / custom domain at the new service. Once it’s
   verified and traffic has moved, delete the old US service.

## Notes

- **Latency:** an EU region is slightly farther from India/US users than US-East. In
  practice a few tens of ms; fine for this app.
- **MiCA / EU rules** govern *serving EU users*, not your server calling an exchange API —
  the blocker here is IP-level geo-blocking, not regulation.
- **Bybit live trading** stays double-gated regardless of region: `BROKER_LIVE_ENABLED=true`
  on the deployment **and** a per-order risk acknowledgement. Confirm your users’ regions
  are allowed to use Bybit before enabling it.
