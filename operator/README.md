# Operator companion service

Runs separately from the static site, on a host the operator controls, behind HTTPS. It is never part
of the IPFS publication. It handles SIWE sign-in, the private store, licensed feed access, Swarm research,
receipt verification and entitlements. Node 22.18+ (type stripping), no build step.

## Setup

```sh
npm ci                                   # from the repository root (uses viem)
export IMD_SPORT_ALLOWED_ORIGIN=https://<your-site>.imd.site   # the published site origin
export IMD_SPORT_RPC_URL=https://<your mainnet RPC>
export IMD_SPORT_DEVELOPER_RECIPIENT=0x...   # empty by default: checkout stays off
export IMD_SPORT_RESEARCH_RECIPIENT=0x...    # empty by default: checkout stays off
export IMD_SPORT_DATA_DIR=/var/lib/imd-sport # private store (mode 0700), back it up, never publish it
npm run operator                             # listens on $PORT (8787)
```

Optional: `SPORTRADAR_API_KEY`, `APISPORTS_API_KEY` (licensed feeds; confirm your contract covers a paid
analysis product), `IMD_API` and `IMD_PAID_TOKEN` (IMD Swarm request token), `IMD_SPORT_RESEARCH_ACTIVE=1`
(research dispatch), `IMD_SPORT_CONFIRMATIONS` (default 12), `IMD_SPORT_SESSION_TTL` (seconds, default 8h).

Then rebuild the site with `VITE_COMPANION_ORIGIN=https://<companion host>` (see `release.env.example`).

## Modules

| File | Does |
| --- | --- |
| `src/config.ts` | settings, price (1 IMD = 2 x 500000000000000000 units), checkout prerequisites |
| `src/siwe.ts` | EIP-4361 nonce (single use, expiring), origin, domain, URI and chain checks, expiring sessions |
| `src/payments.ts` | intents (payer, version, recipients, token, creation block, expiry), finalized Transfer log verification, one reservation per chain:tx:logIndex, partial resume, single entitlement, private history |
| `src/verify-token.ts` | re-checks chain ID, bytecode hash and decimals of the IMD token |
| `src/feeds.ts` | normalized events: stable IDs, UTC observation, sources, freshness, corroboration; live/final/scheduled/stale/unavailable; regulation/overtime/shootout; three-way vs two-way; withdrawal vs injury; Sportradar and API-Sports adapters |
| `src/swarm.ts` | 216 roles (6 sports x 12 factors x research/challenge/adjudication), budgeted waves, IMD Swarm quote/submit/status/collect, cache by event+evidence time+version, invalidation, public-evidence filter, spend cap, distinct contributors, calibrated release; premium synthesis kept in the private store |
| `src/server.ts` | HTTP API with CORS locked to the site origin |

## Tests (offline fixtures, no network)

`npm test` from the root. Transactions use local fixture receipts and fixture keys derived inside the tests.

## Assumptions to confirm before activation

- The IMD Swarm submission format (`GET /jobs/:id/submissions`) is parsed tolerantly (`verdict`/`accepted`,
  `agentId`/`seat`, `resultHash`/`treeHash`). Confirm against the live API before funding research.
- `httpSwarmApi` needs a `payer` callback that produces the x402 Permit2 payment and the EIP-712 quote
  approval from the operator's research wallet; that wallet and key stay with the operator.
