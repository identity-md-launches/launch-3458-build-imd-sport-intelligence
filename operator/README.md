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
(research dispatch), `IMD_SWARM_SIGNER_KEY` (the operator's research wallet key; signs the x402 Permit2 payment and
the EIP-712 QuoteApproval, never leaves this host), `IMD_SPORT_COLLECT_EVERY` (seconds between automatic
collections, default 120), `SPORTRADAR_ACCESS_LEVEL` (`trial` or `production`), `IMD_SPORT_SESSION_TTL`
(seconds, default 8h). Receipts count only at or below Ethereum's `finalized` block with a canonical block hash;
the RPC must support the `finalized` block tag.

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
| `src/x402.ts` | operator signer: x402 Permit2 payment for the 402 challenge and the EIP-712 `QuoteApproval` (domain `IdentityMD Paid Action`) |
| `src/research.ts` | runnable entry point: `node operator/src/research.ts dispatch --sport football --event <id> --cutoff <iso> --evidence evidence.json`, `collect`, `status` |
| `src/server.ts` | HTTP API with CORS locked to the site origin: `/api/status`, `/api/feeds/:sport`, `/api/events/:id/predictions` (released versions and the caller's purchase state, never the synthesis), `/api/predictions/:version` (entitled only), SIWE, intents, legs, history. Collects Swarm work on a timer once research is activated |

## Tests (offline fixtures, no network)

`npm test` from the root. Transactions use local fixture receipts and fixture keys derived inside the tests.

## Research flow

Research runs per event in three gated phases. A challenge is dispatched only after the research for the same
event, factor, evidence time and cutoff is accepted, and receives its accepted files as `inputs[]` (name, path,
hash, mediaType, bytes, submissionHash). An adjudication needs both. A challenge whose contributor matches the
research author, or whose contributor is not evidenced, is rejected. Each quote is reserved against the funded
balance under an idempotent order key before payment is attempted; `admitted` turns the reservation into spend,
`payment_failed`/`expired` releases it, and an unknown outcome stays reserved. Collection reads
`admission.result.{jobId,resultUrl}`, downloads accepted files and keeps only those whose sha256 matches.
A release needs a validated sport model (only the EPL pilot today) and a calibration set of at least 100 earlier
forecasts; factors without the full research, challenge, adjudication chain become data gaps.

## Assumptions to confirm before activation

- IMD's docs name the result fields (`files[]` with `hash`, `submissionHash`, `url`) but not contributor identity;
  identities are read from `GET /jobs/:id/submissions` (`agentId`/`seatId`/`seat`/`contributor`). Without one,
  work is stored but counts no contributor and a challenge cannot prove independence.
- The x402 payload follows the Permit2 `PermitWitnessTransferFrom` shape and takes the spender from the
  challenge's `extra`; the QuoteApproval reads `requesterScopeHash`, `hash` and `expiresAt` from the quoted
  order. Both are fixture-tested only; confirm with one small funded request before enabling research.
- Sportradar MMA publishes no injury endpoint, so MMA availability is reported unavailable; tennis withdrawals
  come from walkovers.
