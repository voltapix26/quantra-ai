# Quantra AI — Terminal

Quantra AI (quantra-terminal) is a live technical and fundamental market analysis web application and progressive web app (PWA). It offers a terminal-style interface for market screening, analysis, reporting, and user onboarding, plus a Capacitor-wrapped Android shell located in `mobile/`.

## Key goals
- Provide a fast, terminal-like market analysis experience (technical & fundamental)
- Offer a PWA with offline capability and a mobile Android shell
- Integrate payments and large-model analysis for advanced workflows

## Features
- Terminal-style UI for screening, reports, and analysis
- PWA support (installable, offline caching)
- Backend server for API, authentication, and Stripe payments
- Large-model integration (Anthropic SDK)
- PostgreSQL support via `pg`
- Android wrapper using Capacitor (in `mobile/`)

## Quick links
- Repo: https://github.com/voltapix26/quantra-ai
- Deployment docs: `DEPLOY.md`, `DEPLOY_NOW.md`
- Changelog: `CHANGELOG.md`
- Render config: `render.yaml`

## Requirements
- Node.js >= 22
- PostgreSQL (for DB-backed features)
- Stripe account and API keys (if payments are used)
- Environment variables configured from `.env.example`

Selected dependencies
- @anthropic-ai/sdk — Large-model integration
- pg — PostgreSQL client
- stripe — Payments

Refer to `package.json` for the complete dependency list.

## Quick start (development)

1. Clone
   git clone https://github.com/voltapix26/quantra-ai.git
   cd quantra-ai

2. Install
   npm install

3. Configure environment
   - Copy `.env.example` to `.env` and fill in required variables (DB, Stripe, API keys).
   - Check `render.yaml`, `DEPLOY.md`, and `DEPLOY_NOW.md` for deployment-specific environment variables.

4. Run locally
   npm start
   - Starts the Node server (`server.js`) which serves the application and API.

## Mobile (Android)
The `mobile/` folder contains a Capacitor Android wrapper:
- cd mobile
- npm install
- npm run sync
- npm run apk

## Scripts
- npm start — run `node server.js`
- npm test — run checks and tests (`npm run check && npm run test:engine && npm run test:smoke`)
- npm run test:engine — run engine tests
- npm run test:smoke — run smoke tests

## Docker
A `Dockerfile` is included for container builds. See `DEPLOY.md` for recommended container and deployment instructions.

## Testing
- Tests are located under `test/`.
- Run `npm test` to execute the test suite.

## Project layout (high level)
- `server.js` — Node server entrypoint
- `*.html` / `*.js` — Frontend pages and client scripts (index.html, screener.html, terminal.html, etc.)
- `mobile/` — Capacitor Android wrapper
- `docs/` — Documentation files
- `DEPLOY.md`, `DEPLOY_NOW.md` — Deployment instructions
- `render.yaml` — Render.com configuration
- `Dockerfile` — Container build instructions

## Contributing
- Contributions are welcome. Please open issues or pull requests with changes.
- Add tests for new features or bug fixes.
- Consider adding a LICENSE file if you intend to publish the project as open source.

## Security
- Never commit secrets. Use `.env` for local development and set secrets via the deployment environment.
- Review `STRIPE_TEST.md` before testing payment flows.

## License
No LICENSE file is present in this repository. Add a license (for example, MIT or Apache-2.0) to make the project explicitly open source.

## Additional notes
This README focuses on high-level project orientation and developer bootstrapping. For detailed deployment steps and environment keys, consult `DEPLOY.md`, `DEPLOY_NOW.md`, and `render.yaml`.
