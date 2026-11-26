import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import type { ChainReader, Receipt, Log } from "../src/rpc.ts";
import { TRANSFER_TOPIC } from "../src/payments.ts";
import { IMD_TOKEN, LEG_UNITS } from "../src/config.ts";

// Deterministic fixture keys derived from labels; they exist only inside these offline tests.
export const fixtureAccount = (label: string) => privateKeyToAccount(keccak256(toHex(`imd-sport-fixture:${label}`)));
export const DEV = "0x" + "d1".repeat(20), RES = "0x" + "e2".repeat(20);
export const ORIGIN = "https://sport.example.imd.site";
export const cfg = (over: Record<string, string> = {}) => loadConfig({ IMD_SPORT_ALLOWED_ORIGIN: ORIGIN, IMD_SPORT_DEVELOPER_RECIPIENT: DEV, IMD_SPORT_RESEARCH_RECIPIENT: RES, ...over });
export const store = () => new Store(null);
const pad = (a: string) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
export const transferLog = (from: string, to: string, i: number, tx: string, amount = LEG_UNITS, token: string = IMD_TOKEN.address): Log =>
  ({ address: token.toLowerCase(), topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: "0x" + amount.toString(16).padStart(64, "0"), logIndex: "0x" + i.toString(16), transactionHash: tx, blockNumber: "0x64" });
export const txh = (n: number) => "0x" + n.toString(16).padStart(64, "0");
export const bhash = (n: number) => "0x" + ("b" + n.toString(16)).padStart(64, "0");
/** Fixture chain. `finalized` defaults to head - 64 (two epochs); `reorged` heights report a different canonical hash. */
export function fixtureChain(opts: { chainId?: number; head?: number; finalized?: number; receipts?: Record<string, Receipt> } = {}): ChainReader & { receipts: Record<string, Receipt>; head: number; finalized: number | null; reorged: Set<number> } {
  const c = { receipts: opts.receipts ?? {}, head: opts.head ?? 200, finalized: opts.finalized ?? null as number | null, reorged: new Set<number>(),
    chainId: async () => opts.chainId ?? 1, blockNumber: async () => c.head,
    finalizedBlock: async () => c.finalized ?? Math.max(0, c.head - 64),
    blockHash: async (n: number) => (n > c.head ? null : c.reorged.has(n) ? "0x" + "f".repeat(64) : bhash(n)),
    receipt: async (h: string) => c.receipts[h.toLowerCase()] ?? null,
    call: async () => "0x" + (18).toString(16).padStart(64, "0"), code: async () => "0x6080" };
  return c;
}
export const receipt = (tx: string, from: string, logs: Log[], block = 100, status = "0x1"): Receipt => ({ status, from, to: IMD_TOKEN.address, blockNumber: "0x" + block.toString(16), blockHash: bhash(block), transactionHash: tx, logs });
