# Quantra AI — Deployment Guide

This app runs three ways, controlled entirely by environment variables:

| Mode | Storage | Email | Billing |
|------|---------|-------|---------|
| **Local dev** (default) | JSON files in `data/` | console links | off |
| **Cloud** | Postgres (`DATABASE_URL`) | Resend (`RESEND_API_KEY`) | Stripe (`STRIPE_*`) |

No code changes are needed to move between them — only `.env`.

---

## 1. Prerequisites

- Node.js 18+ (22 recommended)
- A Postgres database (any provider: Neon, Supabase, Railway, RDS…)
- A [Resend](https://resend.com) account for transactional email
- A [Stripe](https://stripe.com) account for billing

---

## 2. Environment variables

Copy `.env.example` → `.env` and fill in:

```
NODE_ENV=production
APP_URL=https://your-domain.com        # used in email links + Secure cookies
DATABASE_URL=postgres://user:pass@host:5432/quantra
RESEND_API_KEY=re_...
MAIL_FROM=Quantra AI <noreply@your-domain.com>
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_ULTIMATE=price_...
ANTHROPIC_API_KEY=sk-ant-...           # optional, AI verdicts
QUANTRA_AI_MODEL=claude-opus-4-8
```

`NODE_ENV=production` turns on the `Secure` cookie flag, so the app **must** be served over HTTPS (every recommended host below terminates TLS for you).

---

## 3. Postgres

The schema is created automatically on first boot (`store.ready()` runs
`CREATE TABLE IF NOT EXISTS …`). Just provide `DATABASE_URL`. Most managed
Postgres requires SSL — that's the default; set `PGSSL=disable` only for a
plain local instance.

---

## 4. Email (Resend)

1. Add and verify your sending domain in Resend.
2. Create an API key → `RESEND_API_KEY`.
3. Set `MAIL_FROM` to an address on the verified domain.

Without a key, verification/reset links print to the server log (fine for dev).

---

## 5. Stripe billing

1. Create two recurring **Products/Prices** (Pro, Ultimate) → copy the
   `price_…` ids into `STRIPE_PRICE_PRO` / `STRIPE_PRICE_ULTIMATE`.
2. `STRIPE_SECRET_KEY` from Developers → API keys.
3. Add a **webhook endpoint** → `https://your-domain.com/api/billing/webhook`,
   subscribe to `checkout.session.completed`,
   `customer.subscription.updated`, `customer.subscription.deleted`; copy the
   signing secret → `STRIPE_WEBHOOK_SECRET`.

The app creates a Stripe Customer per org, opens Checkout from the account
menu, and flips the org's `plan` when the webhook fires. The customer portal
(“Manage billing”) handles upgrades, downgrades and cancellations.

---

## 6. Deploy

### Option A — Render / Railway / Fly.io (simplest)
- New **Web Service** from the repo.
- Build: `npm install` · Start: `node server.js`
- Add all the env vars above. Attach a managed Postgres and copy its URL.
- The platform provides HTTPS automatically.

### Option B — Docker
```bash
docker build -t quantra-ai .
docker run -p 5280:5280 --env-file .env quantra-ai
```
Put it behind a TLS-terminating proxy (Caddy, Nginx, a cloud load balancer).

### Static front-end (optional split)
The HTML/CSS/JS is static and can sit on a CDN (Cloudflare Pages, Vercel) with
the Node app serving only `/api/*`. For the single-box setup above, the Node
server already serves both.

---

## 7. Post-deploy checklist

- [ ] `https://your-domain.com` loads over HTTPS.
- [ ] Sign up → a real verification email arrives → link verifies.
- [ ] Forgot password → reset email → new password works.
- [ ] Upgrade → Stripe Checkout → returns to app → plan shows the new tier.
- [ ] `stripe trigger checkout.session.completed` (Stripe CLI) updates the org.
- [ ] Restart the service → accounts and watchlists persist (Postgres).

---

## 8. Hardening (recommended before real customers)

- **Rate-limiting is built in** — `/api/auth/login`, `signup`, `request-reset`,
  `reset` and `resend-verify` are throttled per-IP (sliding window, returns 429
  with `Retry-After`). It's in-memory/per-instance; if you run **multiple
  instances**, also add an edge/WAF rate-limit (Cloudflare, your load balancer)
  or move the limiter to the shared store/Redis.
- Rotate the session secret strategy to signed/rotating tokens if you scale to
  multiple instances (sessions currently live in the shared store, which is fine
  for Postgres-backed multi-instance, but review TTLs).
- Add a Content-Security-Policy and standard security headers at the proxy.
- Back up the database; set Stripe to live mode only after testing in test mode.

*Quantra AI is an educational analysis tool — not investment advice.*
