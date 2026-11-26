import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type { OperatorConfig } from "./config.ts";
import type { Sport } from "./feeds.ts";

/**
 * Research through the IMD Swarm, following https://imd.fun/docs/api/ ("How paying works"):
 * POST /requests/check, POST /requests/quote {requestKey, action:"job.open", input}, POST
 * /requests/:id/submit (x402 payment signed by the operator's wallet), GET /requests/:id, then
 * the job's accepted submissions. Each specialist role is one research job.
 */
export const SPORTS: Sport[] = ["mma", "nhl", "nfl", "nba", "football", "tennis"];
export const FACTORS = ["statistics", "injuries", "news", "weather", "venue", "experience-vs-youth", "fatigue", "tactics", "opposition-strength", "style", "odds-as-market-signal", "historical-patterns-and-unexpected-factors"] as const;
export const PHASES = ["research", "challenge", "adjudication"] as const;
export type Phase = (typeof PHASES)[number];
export type Role = { id: string; sport: Sport; factor: (typeof FACTORS)[number]; phase: Phase; brief: string };

const PHASE_BRIEF: Record<Phase, string> = {
  research: "Gather sourced evidence for this factor up to the event cutoff. Cite every source with its URL and observation time.",
  challenge: "Independently test the research for this factor: look for misleading statistics (small samples, selection, base-rate neglect) and contradictory evidence. Report what fails.",
  adjudication: "Weigh the research against its challenges for this factor and state what survives, with its effect on each outcome and the remaining data gaps.",
};
export const ROLES: Role[] = SPORTS.flatMap((sport) => FACTORS.flatMap((factor) => PHASES.map((phase) => ({ id: `${sport}.${factor}.${phase}`, sport, factor, phase, brief: PHASE_BRIEF[phase] }))));
export const MODEL_VERSION = "imd-sport-synth-1";
export const JOB_PRICE_UNITS = 500_000_000_000_000_000n;

export type Evidence = { id: string; url: string; observedUtc: string; publicOk: boolean; summary: string; premium?: unknown };
export type ResearchRecord = {
  cacheKey: string; eventId: string; roleId: string; phase: Phase; modelVersion: string; cutoffUtc: string; evidenceHash: string;
  status: "dispatched" | "accepted" | "rejected"; orderId?: string; jobId?: string;
  resultHash?: string; contributors?: string[]; sources?: string[]; findings?: string; acceptedAt?: number;
};

/** Only evidence licensed for public Swarm work leaves the operator; premium fields never do. */
export function publicEvidence(ev: Evidence[]) { return ev.filter((e) => e.publicOk).map(({ id, url, observedUtc, summary }) => ({ id, url, observedUtc, summary })); }
export const evidenceHash = (ev: Evidence[]) => createHash("sha256").update(JSON.stringify(publicEvidence(ev).sort((a, b) => a.id.localeCompare(b.id)))).digest("hex");
export const cacheKey = (eventId: string, evidenceTime: string, roleId: string, version = MODEL_VERSION) => `${eventId}|${evidenceTime}|${version}|${roleId}`;

export function balance(store: Store) {
  let alloc = 0n, authorized = 0n, spent = 0n;
  for (const l of store.db.ledger) { const a = BigInt(l.amountUnits); if (l.kind === "allocation") alloc += a; else if (l.kind === "authorized-spend") authorized += a; else spent += a; }
  return { allocatedUnits: alloc, authorizedUnits: authorized, spentUnits: spent, availableUnits: (authorized < alloc ? authorized : alloc) - spent };
}

export interface SwarmApi {
  check(input: unknown): Promise<{ blockers: string[] }>;
  quote(requestKey: string, input: unknown): Promise<{ id: string; amount: string }>;
  pay(orderId: string): Promise<void>;                    // x402 submit, signed by the operator's wallet
  status(orderId: string): Promise<{ status: string; jobId?: string }>;
  accepted(jobId: string): Promise<{ resultHash: string; contributor: string; sources: string[]; body: string }[]>;
}

export function httpSwarmApi(cfg: OperatorConfig, payer: (orderId: string, challenge: unknown) => Promise<{ paymentHeader: string; quoteSignature: string }>, f: typeof fetch = fetch): SwarmApi {
  const auth = { Authorization: `Bearer ${cfg.imdPaidToken}`, "Content-Type": "application/json" };
  const j = async (r: Response) => { if (!r.ok && r.status !== 402) throw new Error(`${r.url} ${r.status}`); return r.json() as Promise<any>; };
  return {
    check: async (input) => j(await f(`${cfg.imdApi}/requests/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "job.open", input }) })),
    quote: async (requestKey, input) => { const o = (await j(await f(`${cfg.imdApi}/requests/quote`, { method: "POST", headers: auth, body: JSON.stringify({ requestKey, action: "job.open", input }) }))).order; return { id: o.id, amount: o.quote.payment.amount }; },
    pay: async (id) => {
      const challenge = await j(await f(`${cfg.imdApi}/requests/${id}/submit`, { method: "POST", headers: auth }));
      const s = await payer(id, challenge);
      await j(await f(`${cfg.imdApi}/requests/${id}/submit`, { method: "POST", headers: { ...auth, "PAYMENT-SIGNATURE": s.paymentHeader }, body: JSON.stringify({ quoteSignature: s.quoteSignature }) }));
    },
    status: async (id) => { const r = await j(await f(`${cfg.imdApi}/requests/${id}`, { headers: auth })); return { status: r.status, jobId: r.admission?.jobId ?? r.result?.jobId }; },
    accepted: async (jobId) => {
      const subs = (await j(await f(`${cfg.imdApi}/jobs/${jobId}/submissions`))) as any[];
      return (Array.isArray(subs) ? subs : (subs as any).submissions ?? []).filter((s: any) => s.verdict === "accepted" || s.accepted === true)
        .map((s: any) => ({ resultHash: s.resultHash ?? s.treeHash ?? s.hash, contributor: String(s.agentId ?? s.seat ?? s.contributor), sources: s.sources ?? [], body: s.report ?? s.body ?? "" }));
    },
  };
}

export function jobInput(role: Role, eventId: string, cutoffUtc: string, ev: Evidence[]) {
  return {
    objective: `${role.brief} Sport: ${role.sport}. Factor: ${role.factor}. Event: ${eventId}. Use nothing observed after ${cutoffUtc}. Sports analysis only; no wagering advice. Public evidence: ${JSON.stringify(publicEvidence(ev))}`,
    template: "research", outputs: [{ name: "report", path: "artifacts/report.md", mediaType: "text/markdown" }], minCitations: 2, github: false,
  };
}

export type WavePlan = { phase: Phase; roles: Role[]; reused: string[]; affordable: number; skippedForBudget: string[] };

/** Plan one phase for one event: reuse cached research, then fit what remains in the balance. */
export function planWave(store: Store, sport: Sport, eventId: string, phase: Phase, evidenceTime: string, maxRoles = 12): WavePlan {
  const candidates = ROLES.filter((r) => r.sport === sport && r.phase === phase).slice(0, maxRoles);
  const reused = candidates.filter((r) => { const rec = store.db.research[cacheKey(eventId, evidenceTime, r.id)] as ResearchRecord | undefined; return rec && rec.status !== "rejected"; }).map((r) => r.id);
  const todo = candidates.filter((r) => !reused.includes(r.id));
  const affordable = Number(balance(store).availableUnits / JOB_PRICE_UNITS);
  return { phase, roles: todo.slice(0, Math.max(0, affordable)), reused, affordable, skippedForBudget: todo.slice(Math.max(0, affordable)).map((r) => r.id) };
}

export async function dispatchWave(store: Store, cfg: OperatorConfig, api: SwarmApi, plan: WavePlan, eventId: string, evidenceTime: string, cutoffUtc: string, ev: Evidence[]) {
  if (!cfg.researchActivated) return { dispatched: [], error: "research_not_activated" };
  const out: string[] = [];
  for (const role of plan.roles) {
    if (balance(store).availableUnits < JOB_PRICE_UNITS) break;          // hard cap at the funded balance
    const input = jobInput(role, eventId, cutoffUtc, ev);
    const chk = await api.check(input);
    if (chk.blockers?.length) continue;
    const q = await api.quote(randomUUID(), input);
    if (BigInt(q.amount) > balance(store).availableUnits) break;
    await api.pay(q.id);
    const key = cacheKey(eventId, evidenceTime, role.id);
    store.tx((db) => {
      db.ledger.push({ kind: "spent", amountUnits: q.amount, ref: `swarm:${q.id}:${role.id}`, at: Date.now() });
      db.research[key] = { cacheKey: key, eventId, roleId: role.id, phase: role.phase, modelVersion: MODEL_VERSION, cutoffUtc, evidenceHash: evidenceHash(ev), status: "dispatched", orderId: q.id } satisfies ResearchRecord;
    });
    out.push(role.id);
  }
  return { dispatched: out };
}

export async function collect(store: Store, api: SwarmApi, eventId: string) {
  const pending = Object.values(store.db.research as Record<string, ResearchRecord>).filter((r) => r.eventId === eventId && r.status === "dispatched");
  let accepted = 0;
  for (const rec of pending) {
    const s = await api.status(rec.orderId!);
    if (!s.jobId) continue;
    const subs = await api.accepted(s.jobId);
    store.tx(() => {
      if (!subs.length) { if (/done|complete|failed|rejected/.test(s.status)) rec.status = "rejected"; return; }
      Object.assign(rec, { status: "accepted", jobId: s.jobId, resultHash: subs[0].resultHash, contributors: [...new Set(subs.map((x) => x.contributor))], sources: [...new Set(subs.flatMap((x) => x.sources))], findings: subs[0].body, acceptedAt: Date.now() });
    });
    if (subs.length) accepted++;
  }
  return { accepted };
}

/** Changed evidence invalidates cached work for that event; unchanged evidence keeps it shared. */
export function invalidate(store: Store, eventId: string, ev: Evidence[]) {
  const h = evidenceHash(ev); let n = 0;
  store.tx((db) => { for (const [k, r] of Object.entries(db.research as Record<string, ResearchRecord>)) if (r.eventId === eventId && r.evidenceHash !== h) { delete db.research[k]; n++; } });
  return n;
}

export function distinctContributors(store: Store) {
  const s = new Set<string>();
  for (const r of Object.values(store.db.research as Record<string, ResearchRecord>)) if (r.status === "accepted") r.contributors?.forEach((c) => s.add(c));
  return { plannedRoles: ROLES.length, distinctContributors: s.size };
}

export type Release = {
  eventId: string; version: string; modelVersion: string; cutoffUtc: string; outcomes: string[]; probabilities: number[];
  confidence: "low" | "medium" | "high"; reasons: string[]; counterarguments: string[]; dataGaps: string[]; evidence: { roleId: string; resultHash: string; contributors: string[] }[];
};
/**
 * Adjudicated release: the calibrated base model, nudged by at most 5 points per surviving factor,
 * renormalized. The full synthesis goes to the private premium store; the public part is summary only.
 */
export function release(store: Store, eventId: string, sport: Sport, base: number[], cutoffUtc: string, adjustments: { roleId: string; shift: number[]; reason: string; counter?: string }[]): Release {
  const recs = Object.values(store.db.research as Record<string, ResearchRecord>).filter((r) => r.eventId === eventId && r.status === "accepted");
  const ok = new Set(recs.filter((r) => r.phase === "adjudication").map((r) => r.roleId));
  const applied = adjustments.filter((a) => ok.has(a.roleId));
  let p = base.slice();
  for (const a of applied) p = p.map((x, i) => Math.max(0.01, x + Math.max(-0.05, Math.min(0.05, a.shift[i] ?? 0))));
  const z = p.reduce((s, x) => s + x, 0); p = p.map((x) => Math.round((x / z) * 1e4) / 1e4);
  const covered = new Set(recs.map((r) => r.roleId.split(".")[1]));
  const gaps = FACTORS.filter((f) => !covered.has(f)).map((f) => `no accepted ${f} research`);
  const top = Math.max(...p);
  const rel: Release = {
    eventId, version: `${eventId}@${MODEL_VERSION}@${cutoffUtc}`, modelVersion: MODEL_VERSION, cutoffUtc,
    outcomes: sport === "football" ? ["home", "draw", "away"] : ["home", "away"], probabilities: p,
    confidence: gaps.length > 6 || top < 0.45 ? "low" : gaps.length > 2 || top < 0.6 ? "medium" : "high",
    reasons: applied.map((a) => a.reason), counterarguments: applied.flatMap((a) => (a.counter ? [a.counter] : [])), dataGaps: gaps,
    evidence: recs.map((r) => ({ roleId: r.roleId, resultHash: r.resultHash!, contributors: r.contributors ?? [] })),
  };
  store.tx((db) => { db.premium[rel.version] = { release: rel, findings: recs.map((r) => ({ roleId: r.roleId, findings: r.findings, sources: r.sources })) }; });
  return rel;
}
