# IMD Sport Intelligence

A static sports-analysis site for IMD's IPFS publishing flow (a `.imd.site` address), plus a companion
service the operator runs separately. Analysis only: no wagering, no tips, no promises of winnings.

- **Static export:** `dist/` (committed). Relative assets (`base: "./"`) and hash routes (`#/accuracy`,
  `#/sport/nhl/research`, `#/match/<event id>`), so it works at an IPFS gateway subpath with no rewrites.
- **First screen:** a real EPL match (Manchester City 1-2 Aston Villa, 24 May 2026) with its pre-match
  probabilities, result and an "Open the analysis" action.
- **Views:** football (EPL pilot), UFC/MMA, NHL, NFL, NBA, tennis, each with live scores, upcoming,
  injuries and availability, prediction previews and research; an interactive EPL accuracy report;
  signed-in history and receipts; a status page saying what needs activation.
- **Operator code:** `operator/` (see `operator/README.md`).

## Install, preview, rebuild

```sh
npm ci
npm run dev                 # local dev server
npm run build               # checks the backtest reproduces, then writes dist/
npm run preview             # serves dist/ locally
npm run typecheck           # site and operator (tsc --noEmit)
npm test                    # operator + backtest tests, offline
npm run backtest            # regenerate src/data/epl.json from data/openfootball/
```

Browser test of the export under a gateway subpath (needs Playwright installed outside the repo):
`IMD_PLAYWRIGHT=/path/to/playwright/index.mjs node test/site/gateway.e2e.mjs`.

Browser test of a companion-enabled build against a fixture companion and an injected fixture wallet:
`VITE_COMPANION_ORIGIN=https://companion.test npx vite build --outDir test/scratch/dist-companion --emptyOutDir`,
then `IMD_PLAYWRIGHT=... IMD_DIST=test/scratch/dist-companion node test/site/companion.e2e.mjs`.

### Release configuration

`release.env.example` lists two build-time settings, both empty by default:

- `VITE_COMPANION_ORIGIN`: an operator-authorized HTTPS origin running `operator/`. Empty: sign-in,
  history and checkout are suppressed and explained; the site still builds and publishes.
- `VITE_WALLETCONNECT_PROJECT_ID`: a registered WalletConnect project ID. Empty: the WalletConnect row is
  hidden; MetaMask and Rabby still connect through EIP-6963.

Build with them: `VITE_COMPANION_ORIGIN=https://api.example.org npm run build`.

## Data and model

- Results: [openfootball/football.json](https://github.com/openfootball/football.json) at commit
  `e6744429ee395bc86f247348c6184bb08d4eb361` (2026-09-22), CC0 1.0. The five EPL season files are in
  `data/openfootball/`; their sha256 hashes are written into `src/data/epl.json`.
- Model: Elo with an ordered-logit draw band. Trained on 2022-23 and 2023-24 (ratings used all 760 results;
  parameter selection scored 680, excluding matchdays 1-8 of 2022-23, 80 matches), one temperature
  fitted on 2024-25 (380), held out on 2025-26 (353 with results; 27 fixtures have no result in the archive).
- Held-out: model Brier 0.5971, log loss 0.9992, favourite won 51.3%; frequency baseline Brier 0.6377,
  log loss 1.0550. Reliability bins are in the report. **The EPL pilot supports EPL claims only.**
- The 2026-27 file is a dated snapshot. Fixtures after it show as stale or scheduled, never as live.

## Payments (off until activated)

1 IMD per prediction version, as two direct ERC-20 transfers of 0.5 IMD (500000000000000000 units) to
the developer and the Swarm research recipients, both operator settings with empty defaults. Token: IMD on
Ethereum Mainnet, `0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7`, verified in `docs/TOKEN-VERIFICATION.md`.
The site offers an atomic batch (EIP-5792) where the wallet supports one and otherwise asks for two
confirmations. Each broadcast hash is kept in the browser against its intent and re-verified before anything
else is asked, and a leg counts only once its block is at or below Ethereum's finalized block. The match page
lists the event's released prediction versions from the companion and buys the selected version.
Checkout only appears when the companion confirms a purchasable completed prediction,
a verified token, two recipients and a working verifier.

## Outstanding activation steps

1. Deploy `operator/` on an HTTPS host; set `IMD_SPORT_ALLOWED_ORIGIN` to the published site origin.
2. Set the developer and Swarm research recipients and a mainnet RPC.
3. License live feeds (Sportradar NHL, NBA, NFL, MMA, tennis; API-Sports football) with rights covering a paid
   analysis product; set keys and `SPORTRADAR_ACCESS_LEVEL`.
4. Get an IMD paid-request token, fund and authorize a research balance, set `IMD_SWARM_SIGNER_KEY` and
   `IMD_SPORT_RESEARCH_ACTIVE=1`, then dispatch with `node operator/src/research.ts dispatch ...`.
5. Optionally register a WalletConnect project ID.
6. Rebuild with `VITE_COMPANION_ORIGIN` (and the project ID) and republish.

## Validation

Results of the build, typecheck, tests, browser checks, design probe and Better Interface review are in
`docs/VALIDATION.md`. Design system: `DESIGN.md`.
