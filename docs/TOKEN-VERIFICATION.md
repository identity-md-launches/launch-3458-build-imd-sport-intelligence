# IMD token verification (public evidence)

No token, NFT or contract was created. The payment token is the existing official IMD token.

| Check | Evidence | Result |
| --- | --- | --- |
| Official docs | https://imd.fun/docs, "Crosschain" table, row `$IMD ETH 0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7` (fetched 2026-11-26). The API reference (https://imd.fun/docs/api/) repeats it: "Token IMD on Ethereum mainnet: 0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7". | Ethereum Mainnet entry |
| Chain ID | `eth_chainId` on an Ethereum Mainnet JSON-RPC endpoint | `0x1` |
| Deployed bytecode | `eth_getCode(token, latest)` at block 26496647 (0x1944e87) | 22,990 bytes, keccak256 `0x79a1ae149d27d4aae006d4dd75cb834222c9623799bbf34359428aaf66fec3bf` |
| Decimals | `eth_call decimals()` (`0x313ce567`) | `18` |
| Symbol / name | `symbol()` / `name()` | `IMD` / `Identity.md` |
| Verified source | Sourcify https://sourcify.dev/server/v2/contract/1/0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7 : `exact_match` (creation and runtime), contract `src/BridgedFP.sol:BridgedFP`, solc 0.8.26, verified 2026-03-28. Blockscout (eth.blockscout.com) also reports it fully verified. | Verified |

Reproduce with any public mainnet RPC, for example `https://ethereum-rpc.publicnode.com`. The operator
service re-checks chain ID, code hash and decimals at start (`operator/src/verify-token.ts`) and keeps
checkout off if any check fails.
