import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The operator's private store: one JSON document written atomically. It holds sessions, payment
 * intents, reserved Transfer logs, entitlements, research records and premium synthesis. It is
 * never part of the static export or of any Swarm request.
 *
 * Several operator processes share one store directory (the HTTP server with its collector, and
 * each `research.ts dispatch|collect` run). Every transaction therefore takes an exclusive lock
 * file in that directory, re-reads the document if another process replaced it, runs the mutation
 * on the current state and writes it back before releasing the lock. Reads outside a transaction
 * (`store.db`) also pick up another process's committed writes.
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
  /** Swarm spend reservations keyed by the internal order key; requestKey is the UUID sent to IMD. */
  swarmOrders: Record<string, SwarmOrder>;
  /** Model forecasts recorded by the forecasting pipeline, keyed by `${eventId}|${cutoffUtc}|${baseModel}`. */
  forecasts: Record<string, unknown>;
};
export type SwarmOrder = { key: string; requestKey: string; roleId: string; eventId: string; amountUnits: string; state: "reserved" | "spent" | "released"; orderId?: string; createdAt: number; updatedAt: number; note?: string };
export type Leg = { recipient: string; amountUnits: string; txHash?: string; logIndex?: number; blockNumber?: number; verifiedAt?: number };
export type Intent = {
  id: string; payer: string; predictionVersion: string; token: string; chainId: number;
  createdBlock: number; expiresAt: number; createdAt: number;
  legs: { developer: Leg; research: Leg };
  status: "open" | "partial" | "paid" | "expired";
};

const empty = (): Db => ({ nonces: {}, sessions: {}, intents: {}, reservations: {}, entitlements: {}, research: {}, ledger: [], premium: {}, swarmOrders: {}, forecasts: {} });
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** A lock older than this belongs to a crashed process; transactions are short and synchronous. */
const STALE_LOCK_MS = 15_000;

export class Store {
  private state: Db;
  private file: string | null;
  private lock: string | null;
  private seen = "";
  private depth = 0;
  constructor(dir: string | null) {
    this.file = dir ? join(dir, "store.json") : null;
    this.lock = dir ? join(dir, "store.lock") : null;
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.state = empty();
    this.reload(true);
  }
  /** File identity: rename-on-write gives each committed version a new inode. */
  private stamp() { if (!this.file || !existsSync(this.file)) return ""; const s = statSync(this.file); return `${s.ino}:${s.size}:${s.mtimeMs}`; }
  private reload(force = false) {
    if (!this.file) return;
    const st = this.stamp();
    if (!force && st === this.seen) return;
    this.state = st ? { ...empty(), ...JSON.parse(readFileSync(this.file, "utf8")) } : empty();
    this.seen = st;
  }
  /** Current committed state, including other processes' writes. */
  get db(): Db { if (this.depth === 0) this.reload(); return this.state; }
  private acquire() {
    if (!this.lock) return;
    for (let i = 0; ; i++) {
      try { closeSync(openSync(this.lock, "wx", 0o600)); return; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try { if (Date.now() - statSync(this.lock).mtimeMs > STALE_LOCK_MS) unlinkSync(this.lock); } catch { /* released meanwhile */ }
        if (i > 20_000) throw new Error("store lock not released");
        pause(2);
      }
    }
  }
  private release() { if (this.lock) try { unlinkSync(this.lock); } catch { /* already gone */ } }
  /**
   * The transaction boundary shared by every process on this store: lock, read current state, run
   * the mutation, commit, unlock. Look records up through the `db` argument: objects read before
   * the transaction may be from an older version.
   */
  tx<T>(fn: (db: Db) => T): T {
    if (this.depth > 0) return fn(this.state);
    this.acquire();
    this.depth++;
    try {
      this.reload();
      const out = fn(this.state);
      if (this.file) { const tmp = `${this.file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 }); renameSync(tmp, this.file); this.seen = this.stamp(); }
      return out;
    } finally { this.depth--; this.release(); }
  }
}
