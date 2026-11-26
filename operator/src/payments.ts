import { randomUUID } from "node:crypto";
import type { ChainReader, Log } from "./rpc.ts";
import type { Store, Intent } from "./store.ts";
import { IMD_TOKEN, LEG_UNITS, checkoutBlockers, type OperatorConfig } from "./config.ts";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const lc = (s: string) => s.toLowerCase();
const topicAddr = (t: string) => "0x" + t.slice(-40).toLowerCase();
export const explorerTx = (hash: string) => `https://etherscan.io/tx/${hash}`;
export const entKey = (payer: string, version: string) => `${lc(payer)}|${version}`;

/** Calldata for a direct ERC-20 transfer(to, amount). */
export function transferCalldata(to: string, amount: bigint = LEG_UNITS): string {
  return "0xa9059cbb" + to.toLowerCase().replace(/^0x/, "").padStart(64, "0") + amount.toString(16).padStart(64, "0");
}

export type Purchasable = (predictionVersion: string) => boolean;

export async function verifierHealthy(reader: ChainReader, cfg: OperatorConfig): Promise<boolean> {
  try { return (await reader.chainId()) === cfg.chainId && (await reader.blockNumber()) > 0 && (await reader.finalizedBlock()) > 0; } catch { return false; }
}

export type IntentResult =
  | { ok: true; alreadyEntitled: true }
  | { ok: true; alreadyEntitled: false; intent: Intent; calls: { to: string; data: string; leg: string }[] }
  | { ok: false; error: string; blockers?: string[] };

/** Create, or resume, the payer's intent for one prediction version. Never charges twice. */
export async function openIntent(store: Store, cfg: OperatorConfig, reader: ChainReader, payer: string, predictionVersion: string, purchasable: Purchasable, tokenVerified: boolean, now = Date.now()): Promise<IntentResult> {
  if (store.db.entitlements[entKey(payer, predictionVersion)]) return { ok: true, alreadyEntitled: true };
  const blockers = checkoutBlockers(cfg, await verifierHealthy(reader, cfg), tokenVerified);
  if (!purchasable(predictionVersion)) blockers.push("prediction version is not a purchasable completed prediction");
  if (blockers.length) return { ok: false, error: "checkout_unavailable", blockers };
  const existing = Object.values(store.db.intents).find((i) => lc(i.payer) === lc(payer) && i.predictionVersion === predictionVersion && (i.status === "partial" || (i.status === "open" && i.expiresAt > now)));
  const intent = existing ?? store.tx((db) => {
    // Re-check inside the shared transaction: another operator process may have opened it meanwhile.
    const again = Object.values(db.intents).find((i) => lc(i.payer) === lc(payer) && i.predictionVersion === predictionVersion && (i.status === "partial" || (i.status === "open" && i.expiresAt > now)));
    if (again) return again;
    const it: Intent = {
      id: randomUUID(), payer: lc(payer), predictionVersion, token: lc(IMD_TOKEN.address), chainId: cfg.chainId,
      createdBlock: 0, expiresAt: now + cfg.intentTtlSeconds * 1000, createdAt: now, status: "open",
      legs: { developer: { recipient: lc(cfg.developerRecipient), amountUnits: LEG_UNITS.toString() }, research: { recipient: lc(cfg.researchRecipient), amountUnits: LEG_UNITS.toString() } },
    };
    db.intents[it.id] = it; return it;
  });
  if (!existing) { const b = await reader.blockNumber(); store.tx((db) => { if (db.intents[intent.id]) db.intents[intent.id].createdBlock = b; intent.createdBlock = b; }); }
  const calls = (["developer", "research"] as const).filter((k) => !intent.legs[k].txHash).map((k) => ({ leg: k, to: IMD_TOKEN.address, data: transferCalldata(intent.legs[k].recipient) }));
  return { ok: true, alreadyEntitled: false, intent, calls };
}

export type LegResult = { ok: boolean; error?: string; verified: string[]; intent?: Intent; entitled?: boolean; pending?: boolean; finalizedBlock?: number; receiptBlock?: number };

/**
 * Verify a buyer's transaction against an intent. Accepts a single transfer, or a batch whose
 * receipt carries both legs. Each finalized Transfer log is reserved once by chain, hash and index.
 */
export async function submitLeg(store: Store, cfg: OperatorConfig, reader: ChainReader, sessionAddress: string, intentId: string, txHash: string, now = Date.now()): Promise<LegResult> {
  const intent = store.db.intents[intentId];
  if (!intent || lc(intent.payer) !== lc(sessionAddress)) return { ok: false, error: "intent_not_found", verified: [] };
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, error: "bad_tx_hash", verified: [] };
  const hasLeg = !!(intent.legs.developer.verifiedAt || intent.legs.research.verifiedAt);
  if (!hasLeg && intent.expiresAt < now) { store.tx((db) => { if (db.intents[intentId]) db.intents[intentId].status = "expired"; }); return { ok: false, error: "intent_expired", verified: [] }; }
  if ((await reader.chainId()) !== intent.chainId) return { ok: false, error: "wrong_chain", verified: [] };
  const rc = await reader.receipt(txHash);
  if (!rc) return { ok: false, error: "receipt_not_found", verified: [], pending: true };
  if (rc.status !== "0x1") return { ok: false, error: "transaction_failed", verified: [] };
  const block = Number(rc.blockNumber);
  const tokenLogs = rc.logs.filter((l) => !l.removed && lc(l.address) === intent.token && lc(l.topics[0] ?? "") === TRANSFER_TOPIC);
  if (tokenLogs.length && tokenLogs.every((l) => store.db.reservations[`${intent.chainId}:${lc(txHash)}:${Number(l.logIndex)}`])) return { ok: false, error: "duplicate_receipt", verified: [] };
  if (block < intent.createdBlock) return { ok: false, error: "before_intent", verified: [] };
  // Finality is the chain's own finalized checkpoint, not a confirmation count. A receipt above it
  // stays pending; a receipt whose block is no longer canonical is not counted at all.
  const finalized = await reader.finalizedBlock();
  if (!(finalized > 0) || block > finalized) return { ok: false, error: "not_final", verified: [], pending: true, finalizedBlock: finalized, receiptBlock: block };
  const canonical = await reader.blockHash(block);
  if (!canonical || lc(canonical) !== lc(rc.blockHash ?? "")) return { ok: false, error: "receipt_not_canonical", verified: [], pending: true };
  const verified: string[] = [];
  let sawReserved = false;
  let cur: Intent = intent;
  store.tx((db) => {
    const intent = (cur = db.intents[intentId] ?? cur);
    for (const log of rc.logs as Log[]) {
      if (log.removed || lc(log.address) !== intent.token || lc(log.topics[0] ?? "") !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
      const key = `${intent.chainId}:${lc(txHash)}:${Number(log.logIndex)}`;
      if (db.reservations[key]) { sawReserved = true; continue; }
      if (topicAddr(log.topics[1]) !== lc(intent.payer)) continue;
      if (BigInt(log.data) !== LEG_UNITS) continue;
      const to = topicAddr(log.topics[2]);
      const leg = (["developer", "research"] as const).find((k) => intent.legs[k].recipient === to && !intent.legs[k].verifiedAt);
      if (!leg) continue;
      db.reservations[key] = { intentId, leg, reservedAt: now };
      Object.assign(intent.legs[leg], { txHash: lc(txHash), logIndex: Number(log.logIndex), blockNumber: block, verifiedAt: now });
      verified.push(leg);
    }
    const both = !!(intent.legs.developer.verifiedAt && intent.legs.research.verifiedAt);
    intent.status = both ? "paid" : intent.legs.developer.verifiedAt || intent.legs.research.verifiedAt ? "partial" : intent.status;
    const ek = entKey(intent.payer, intent.predictionVersion);
    if (both && !db.entitlements[ek]) {
      db.entitlements[ek] = { address: intent.payer, predictionVersion: intent.predictionVersion, intentId, grantedAt: now };
      db.ledger.push({ kind: "allocation", amountUnits: LEG_UNITS.toString(), ref: `research-leg:${intentId}`, at: now });
    }
  });
  if (!verified.length) return { ok: false, error: sawReserved ? "duplicate_receipt" : "no_matching_transfer", verified, intent: cur };
  return { ok: true, verified, intent: cur, entitled: cur.status === "paid" };
}

export function isEntitled(store: Store, address: string | null, version: string): boolean {
  return !!address && !!store.db.entitlements[entKey(address, version)];
}

/** One signed-in user's purchase history. Nothing from another address is ever included. */
export function historyFor(store: Store, address: string) {
  const a = lc(address);
  return Object.values(store.db.intents).filter((i) => i.payer === a).map((i) => ({
    intentId: i.id, predictionVersion: i.predictionVersion, status: i.status, createdAt: i.createdAt,
    legs: (["developer", "research"] as const).map((k) => ({ leg: k, recipient: i.legs[k].recipient, amountUnits: i.legs[k].amountUnits, txHash: i.legs[k].txHash ?? null, explorer: i.legs[k].txHash ? explorerTx(i.legs[k].txHash!) : null })),
    entitled: !!store.db.entitlements[entKey(a, i.predictionVersion)],
  }));
}
