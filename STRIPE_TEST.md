# Stripe — local test-mode walkthrough

Two ways to see a plan upgrade locally:

- **A. Simulator (no Stripe needed)** — already on. Sign in → account menu →
  **Simulate Pro / Ultimate**. The org plan flips and intraday, exports and AI
  verdicts unlock instantly. This is gated by `QUANTRA_DEV_BILLING=1` in `.env`
  and is **auto-disabled when `NODE_ENV=production`**. Use it to demo the
  gating; it does **not** exercise Stripe.

- **B. Real Stripe Checkout (test mode)** — the genuine flow, below.

---

## B. Real Stripe test-mode (a real checkout → webhook → upgrade)

### 1. Get test keys & prices
1. Create a free Stripe account; stay in **Test mode** (toggle, top-right).
2. **Products → Add product** twice: "Quantra Pro" and "Quantra Ultimate",
   each with a **recurring monthly price**. Copy the two `price_…` ids.
3. **Developers → API keys** → copy the **Secret key** (`sk_test_…`).

### 2. Configure `.env`
```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_ULTIMATE=price_...
APP_URL=http://localhost:5280
# turn the simulator OFF so the real buttons show:
QUANTRA_DEV_BILLING=
```

### 3. Forward webhooks with the Stripe CLI
Install the [Stripe CLI](https://docs.stripe.com/stripe-cli), then:
```
stripe login
stripe listen --forward-to localhost:5280/api/billing/webhook
```
It prints a signing secret `whsec_…` — put it in `.env`:
```
STRIPE_WEBHOOK_SECRET=whsec_...
```
Restart the server (`node server.js`) so it picks up the new env.

### 4. Run the flow
1. Open `http://localhost:5280`, sign in, account menu → **Upgrade to Pro**.
2. You're redirected to **Stripe Checkout** — pay with the test card
   `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.
3. You're returned to the app (`/?billing=success`). The Stripe CLI shows
   `checkout.session.completed` being delivered to your webhook, and the
   server flips the org's `plan` to **pro** — the account menu now shows Pro
   and the Pro features unlock.
4. Account menu → **Manage billing** opens the Stripe **customer portal**
   (test mode) where you can switch or cancel; `customer.subscription.*`
   webhooks update the plan accordingly.

### 5. Trigger webhooks without checking out (optional)
```
stripe trigger checkout.session.completed
stripe trigger customer.subscription.deleted
```

### Going live
Swap the `sk_test_…`/`price_…`/`whsec_…` for **live-mode** equivalents, set
`APP_URL` to your real domain, register the webhook at
`https://your-domain.com/api/billing/webhook`, and keep `QUANTRA_DEV_BILLING`
blank. Test thoroughly in test mode first.

*Educational analysis tool — not investment advice.*
