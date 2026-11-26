import { keccak256 } from "viem";
import type { ChainReader } from "./rpc.ts";
import { IMD_TOKEN } from "./config.ts";

/** Recorded public evidence (docs/TOKEN-VERIFICATION.md). verifyToken re-checks it at startup. */
export const TOKEN_EVIDENCE = {
  address: IMD_TOKEN.address,
  docsEntry: "imd.fun/docs Crosschain table: $IMD ETH 0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7",
  observedAtBlock: 26496647,
  runtimeCodeBytes: 22990,
  runtimeCodeKeccak: "0x79a1ae149d27d4aae006d4dd75cb834222c9623799bbf34359428aaf66fec3bf",
  sourcify: "https://sourcify.dev/server/v2/contract/1/0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7 (exact_match, BridgedFP, solc 0.8.26)",
};

export async function verifyToken(reader: ChainReader, expectedCodeKeccak = TOKEN_EVIDENCE.runtimeCodeKeccak): Promise<{ ok: boolean; checks: Record<string, boolean | string> }> {
  const checks: Record<string, boolean | string> = {};
  try {
    checks.chainId = (await reader.chainId()) === IMD_TOKEN.chainId;
    const code = await reader.code(IMD_TOKEN.address);
    checks.hasCode = code.length > 2;
    checks.codeHash = expectedCodeKeccak ? keccak256(code as `0x${string}`) === expectedCodeKeccak : keccak256(code as `0x${string}`);
    checks.decimals = BigInt(await reader.call(IMD_TOKEN.address, "0x313ce567")) === 18n;
  } catch (e) { checks.error = String(e); }
  const ok = checks.chainId === true && checks.hasCode === true && checks.decimals === true && checks.codeHash !== false && !checks.error;
  return { ok, checks };
}
