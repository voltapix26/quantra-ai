# Quantra AI — Scale Plan (M8) & Data Decisions (M4)

> What's already shipped vs what to buy, and the traffic thresholds that trigger each.

## Shipped now (M8 engineering)
- **gzip** on all text responses (~70% smaller transfers; the ~150 KB terminal.js
  ships in ~40 KB).
- **Immutable caching** for `?v=`-versioned JS/CSS — repeat visits skip re-downloading
  bundles entirely (we bump `v` on every change, so this is safe).
- **Keep-warm self-ping** (already live) hides free-tier cold starts.
- **RapidAPI quota guard** (M4): daily call counter in /admin + a 30-minute circuit
  breaker on 429 — a burned quota fails fast to Yahoo instead of burning more calls.

## Buy/decide later — thresholds
| Trigger | Action | Rough cost |
|---|---|---|
| RapidAPI breaker opens regularly (see /admin "RapidAPI today") | RapidAPI paid tier (Pro ~$10–25/mo) **or** Twelve Data Grow ($29/mo, native NSE/BSE) — pick one, not both | $10–29/mo |
| >~50 concurrent users / Render CPU pegged | Render paid instance upgrade; move static to a CDN (Cloudflare in front is free and takes ~90% of requests) | $0–25/mo |
| >~500 concurrent seconds-mode users | Split the tick relay into its own service (one Finnhub WS in, N SSE out) | 1 small instance |
| Paying institutional users ask for exchange-grade data | Bloomberg B-PIPE / exchange direct feeds (the investor-deck tier) | $2k+/mo, contracts |
| DB >1 GB or backups matter commercially | Render Postgres paid tier (automatic daily backups + PITR) | ~$7–20/mo |

## M4 decision, made concrete
Current setup: **RapidAPI free tier + 60s/30min caches + circuit breaker** = live
international quotes most of the time, honest delayed fallback when the quota runs
out. This is fine pre-revenue. First paying user from India → buy the RapidAPI paid
tier (cheapest live-NSE option) the same day.
