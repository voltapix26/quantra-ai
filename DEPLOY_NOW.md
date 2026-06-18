# Deploy Quantra AI to a permanent link (free)

Your local app is ready to host. This gives you a stable `https://…` URL that
works even when your PC is off. ~10 minutes, free.

## Option A — Render (recommended, has free Postgres)

1. **Put the code on GitHub**
   - Create a new empty repo at https://github.com/new (e.g. `quantra-ai`). Don't add a README.
   - In `C:\Users\eshan\quantra-terminal`, run:
     ```powershell
     git init
     git add .
     git commit -m "Quantra AI — initial deploy"
     git branch -M main
     git remote add origin https://github.com/<your-username>/quantra-ai.git
     git push -u origin main
     ```

2. **Deploy on Render**
   - Sign up free at https://render.com (use "Sign in with GitHub").
   - Click **New +  →  Blueprint**, pick your `quantra-ai` repo, click **Apply**.
   - `render.yaml` provisions the web service **and** a free Postgres, and wires
     `DATABASE_URL` automatically — so accounts and watchlists persist.
   - Wait for the first build (~2–3 min). You'll get a URL like
     `https://quantra-ai.onrender.com`. **That's your permanent shareable link.**

3. **(Optional) turn on extra features** — in the Render service → Environment:
   - `ANTHROPIC_API_KEY` + `QUANTRA_AI_MODEL` → premium LLM "Quantra AI" read.
   - `STRIPE_SECRET_KEY` → real billing.
   - `APP_URL` = your final `https://…onrender.com` URL → correct email links.

### Notes
- **Free tier sleeps** after ~15 min idle; the first visit then takes ~50s to
  wake. Fine for sharing/demos. Upgrade to remove the cold start.
- Secrets (`.env`) and local data (`data/`) are git-ignored — they are NOT
  pushed. Set secrets in the Render dashboard instead.

## Option B — Railway / Fly.io
Same idea: connect the GitHub repo, it auto-detects Node (`npm start`).
Add a Postgres plugin and set `DATABASE_URL`. Use `render.yaml` as a reference
for the env vars.
