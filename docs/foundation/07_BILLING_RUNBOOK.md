# Quantra AI — Billing Go-Live Runbook (M2)

All the code is live and key-gated. Billing turns on with **Stripe keys + one env
flag** — no deploy needed beyond saving env vars (Render restarts automatically).

> Current state: `FORCE_ULTIMATE` defaults **true** → every signed-in user gets the
> Ultimate plan and the Upgrade buttons stay hidden. Nothing changes until step 5.

## Plans (already enforced in code — plans.js)
| Plan | Watchlist | AI verdicts/day | Intraday | Exports |
|---|---|---|---|---|
| Free | 25 | 0 | — | — |
| Pro | 200 | 300 | ✅ | ✅ |
| Ultimate | 1000 | 1500 | ✅ | ✅ |

## Steps (≈20 minutes, all in your Stripe + Render dashboards)
1. **Stripe account** — dashboard.stripe.com → activate your account (business
   details, bank for payouts). Start in **Test mode** first.
2. **Products & prices** — Products → Add product:
   - "Quantra Pro" → recurring monthly price (e.g. $9.99) → copy the **price id** (`price_…`)
   - "Quantra Ultimate" → recurring monthly (e.g. $24.99) → copy its price id
3. **Webhook** — Developers → Webhooks → Add endpoint:
   - URL: `https://quantra-ai.onrender.com/api/billing/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted`
   - Copy the **signing secret** (`whsec_…`)
4. **Render env vars** (Service → Environment → Add):
   ```
   STRIPE_SECRET_KEY      = sk_test_…   (later: sk_live_…)
   STRIPE_PRICE_PRO       = price_…
   STRIPE_PRICE_ULTIMATE  = price_…
   STRIPE_WEBHOOK_SECRET  = whsec_…
   ```
   Save → auto-redeploy. Check **/admin → System status → Billing** shows
   `on · on · on`.
5. **Test-mode dry run** — sign in with a test account → account menu →
   *Upgrade to Pro* → pay with Stripe test card `4242 4242 4242 4242` → confirm
   the plan flips to Pro (webhook worked) → *Manage billing* opens the portal →
   cancel → plan drops to Free.
6. **Go live** — switch Stripe to Live mode, repeat steps 2–4 with live keys, then set:
   ```
   FORCE_ULTIMATE = false
   ```
   → plan enforcement is ON (admin shows "enforcing paid plans").

## Rollback
Set `FORCE_ULTIMATE=true` (or delete the var) → everyone is Ultimate again
instantly. Subscriptions keep billing in Stripe until cancelled — pause there
if you need a full stop.

## Notes
- Existing users: when enforcement turns on, non-paying accounts become **Free**
  (25-item watchlist, no AI verdicts). Consider a grace email first (the digest
  list is a good channel).
- Super-admins are always Ultimate regardless of the flag.
- Refund policy page already exists (refund.html) — Stripe portal handles the mechanics.
