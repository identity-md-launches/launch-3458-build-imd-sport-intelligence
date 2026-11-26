import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The operator's private store: one JSON document written atomically. It holds sessions, payment
 * intents, reserved Transfer logs, entitlements, research records and premium synthesis. It is
 * never part of the static export or of any Swarm request.
 */
export type Db = {
  nonces: Record<string, { expiresAt: number; origin: string }>;
  sessions: Record<string, { address: string; chainId: number; expiresAt: number }>;
  intents: Record<string, Intent>;
  reservations: Record<string, { intentId: string; leg: "developer" | "research"; reservedAt: number }>;
  entitlements: Record<string, { address: string; predictionVersion: string; intentId: string; grantedAt: number }>;
  research: Record<string, unknown>;
  ledger: { kind: "allocation" | "authorized-spend" | "spent"; amountUnits: string; ref: string; at: number }[];
  premium: Record<string, unknown>;
  /** Swarm spend reservations keyed by the idempotent order key (also the IMD requestKey). */
  swarmOrders: Record<string, SwarmOrder>;
};
export type SwarmOrder = { key: string; roleId: string; eventId: string; amountUnits: string; state: "reserved" | "spent" | "released"; orderId?: string; createdAt: number; updatedAt: number; note?: string };
export type Leg = { recipient: string; amountUnits: string; txHash?: string; logIndex?: number; blockNumber?: number; verifiedAt?: number };
export type Intent = {
  id: string; payer: string; predictionVersion: string; token: string; chainId: number;
  createdBlock: number; expiresAt: number; createdAt: number;
  legs: { developer: Leg; research: Leg };
  status: "open" | "partial" | "paid" | "expired";
};

const empty = (): Db => ({ nonces: {}, sessions: {}, intents: {}, reservations: {}, entitlements: {}, research: {}, ledger: [], premium: {}, swarmOrders: {} });

export class Store {
  db: Db;
  private file: string | null;
  constructor(dir: string | null) {
    this.file = dir ? join(dir, "store.json") : null;
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = this.file && existsSync(this.file) ? { ...empty(), ...JSON.parse(readFileSync(this.file, "utf8")) } : empty();
  }
  /** Run a mutation and persist it; single-process, so this is the transaction boundary. */
  tx<T>(fn: (db: Db) => T): T {
    const out = fn(this.db);
    if (this.file) { const tmp = this.file + ".tmp"; writeFileSync(tmp, JSON.stringify(this.db), { mode: 0o600 }); renameSync(tmp, this.file); }
    return out;
  }
}
