# Validation record (2026-11-26, revision 2)

All commands run from the repository root on the final source. Results are as observed.

| Check | Command | Result |
| --- | --- | --- |
| Typecheck (site + operator) | `npm run typecheck` | pass, 0 errors |
| Production build | `npm run build` | pass; "backtest reproduced: src/data/epl.json matches"; `dist/` 2.1 MB |
| Offline tests | `npm test` | 26 tests, 26 pass, 0 fail |
| Gateway-subpath browser test | `node test/site/gateway.e2e.mjs` (Chromium headless, export served at `/ipfs/<cid>/`, off-origin requests blocked) | 46/46 pass at 390 and 1440 wide |
| Companion-enabled browser test | `node test/site/companion.e2e.mjs` on a build with `VITE_COMPANION_ORIGIN=https://companion.test` (fixture companion via request interception, injected EIP-6963 fixture wallet, 390x844) | 25/25 pass |
| Design probe taste@1 | `node .imd/reads/skills/design-critic/scripts/taste.mjs --out test/scratch/taste` | 16/16 pass |
| Relative URLs | `dist/index.html` | `./favicon.svg`, `./assets/*.js`, `./assets/*.css`, `./og.png` |

## Revision 2: reviewer findings reproduced and retested

Each finding was reproduced before the fix: by reading the cited code, or by the reviewer's scenario written as a test.

- Feed views now request `/api/feeds/:sport` and render events, scores, decided-in, freshness, sources,
  corroboration and availability; an unavailable feed shows the companion's reason, and football falls back to
  the dated archive (browser: nhl live/availability, mma unavailable, football fallback).
- Match page lists `/api/events/:id/predictions`, sends the compound version, fetches `/api/predictions/:version`
  on entitlement and on reopening (browser).
- Sportradar adapters for NHL, NBA, NFL, MMA and tennis on documented access-level routes, with injuries endpoints
  and walkover withdrawals; API-Sports fixtures and injuries; `availabilityKind("Withdrew (no injury reported)")`
  is now `withdrawal`; refused endpoints are explicit unavailable states (operator tests).
- Swarm: `admission.result.jobId/resultUrl`, artifact hash verification, phase gating with prior artifacts as
  inputs, challenger independence, atomic reservations (overlapping waves dispatch 1 of 2 on a 0.5 IMD balance),
  calibrated release bound to a validated model, `research.ts` entry point and timed collection (operator tests).
- Receipts: head 140, finalized 110, receipt 120 now returns `not_final` with no reservation; non-canonical block
  hash refused; verifier health needs the finalized tag (operator test).
- Wallet: hashes persisted per intent, re-verified before any request; rejecting the second confirmation leaves
  only the missing leg; `eth_chainId` checked before each transfer; Base shows Switch to Ethereum; switching
  account drops history and session (browser).
- Connect sheet: native modal; Tab reaches only the sheet and browser UI; Escape returns focus to Connect (browser).
- Upcoming: first row is Arsenal v Manchester City, 28 Nov 2026 15:00 UTC, Scheduled (browser).
- Accuracy text: 760 rating results, 680 scored for parameter selection, 80 warm-up, derived by `scripts/backtest.ts`.

## What the tests cover

- Historical metric reproduction: a fresh run of `scripts/backtest.ts` equals the committed metrics and
  reliability bins; held-out model Brier beats the baseline; all source URLs pin the archive commit.
- Payments with local fixture receipts: finality by the chain's finalized block and canonical hash; empty recipients/origin disable checkout; unverified token, dead
  verifier and non-purchasable versions refuse; intent binding and exact 0.5 IMD calldata; a batched receipt
  with both legs grants one entitlement and reopening never charges; duplicate receipts refused (also across
  intents); partial payment survives expiry and resumes at the missing leg; wrong chain, wrong sender, wrong
  amount, wrong token, unfinalized, failed and pre-intent transactions refused; user isolation for submit,
  history and entitlement.
- SIWE: single-use nonce, wrong origin, domain, chain, bad signature, expired nonce, session expiry; HTTP
  signed-out access returns 401; CORS locked to the configured origin.
- Feeds: live/final/scheduled/stale/unavailable; regulation/overtime/shootout/extra-time/decision; three-way
  vs two-way; withdrawal vs confirmed injury; unavailable feeds with no keys; credentialed adapter fixture.
- Swarm: 216 unique roles; activation gate; budgeted waves capped at the funded balance; only public
  evidence leaves; collection stores hashes and contributors; cache reuse and invalidation; distinct
  contributors separate from planned roles; release with probabilities, confidence, reasons,
  counterarguments, gaps; premium findings only in the private store.
- Browser (both widths): featured match and main action in the first viewport (at 390 the CTA ends above
  844px), no horizontal overflow on home and accuracy, match page, no payment request when the companion is
  empty, accuracy filter and reliability toggle, JSON download, all six sports show unavailable live feeds,
  snapshot fixtures marked stale/scheduled, research table, signed-out history, activation page, connect
  sheet opens and closes with Escape, no console errors, no failed local requests.

## Better Interface review (six domains)

Coverage: source review of all components plus rendered checks in headless Chromium (screenshots at 320,
390 and 1440 from the probe, and the e2e walk). Not performed: WebKit/Safari, a real wallet extension,
screen-reader output, 200% zoom.

| Domain | Finding (file:line at time of finding) | Fix |
| --- | --- | --- |
| Layout | Tables pushed the page 71px wide at 320 on `#/accuracy` and `#/sport/*/research` (`src/styles.css` `.tbl`) | Tables scroll in their own box under 640px; page scroll width now 0 |
| Layout | Team names split mid-word ("Manchest/er City") in the featured card at 390 (`src/styles.css` `.fixture span`, `overflow-wrap: anywhere`) | `break-word`, `minmax(0,1fr)` columns, fixture names at 17px under 640px |
| Layout | Header nav hidden on phones left History and Status unreachable (`src/App.tsx` header) | Footer nav with the three links, 44px targets |
| Writing | Five sport cards repeated one line (probe `repetition`) (`src/App.tsx` sports grid) | Each card names its league |
| Accessibility | Checked: skip link, `:focus-visible` ring, native buttons/links/selects with labels, `aria-pressed` toggles, `aria-current` nav, dialog with Escape and ×, `role=status` for filter counts and notices, SVG art with `aria-label`, title updated per route | No further change |
| Typography | Checked: six sizes, three weights, two families, tabular numerals, mono only for addresses and IDs | No change |
| Colors | Probe contrast pass for all measured text; color is never the only signal (badges have words, the result has a "Result" tag) | No change |
| UI | Checked: one gold main action per view, disabled and pending states on pay and wallet rows, unavailable states explain activation | No change |

Remaining limitations: the probe does not measure text over the SVG art or the gold-tinted card gradient
(22 boxes); 6 controls are between 24 and 44px (tabs, segmented buttons at 36 to 40px) and spaced apart.
Browser checks used locally extracted Ubuntu libraries and Liberation/DejaVu fonts because this machine has
no system fonts; real devices will render the system UI font.

## Known limits of the delivery

- No live data ships: no feed with confirmed rights for a paid product is free and browser-readable, so live,
  upcoming and availability views state "unavailable" until the operator configures licensed keys.
- The IMD Swarm order and result shapes follow imd.fun/docs/api; contributor identity and the x402 Permit2 payload
  are fixture-tested only. Confirm with one small funded request before enabling research.
- Live feed adapters are tested against fixture payloads shaped like the providers' documented responses;
  no licensed key was used.
- Wallet transactions were tested against fixtures only; no transaction was sent.
