import { createHash } from "node:crypto";
import type { Store, SwarmOrder } from "./store.ts";
import type { OperatorConfig } from "./config.ts";
import type { Sport } from "./feeds.ts";

/**
 * Research through the IMD Swarm, following https://imd.fun/docs/api/ ("How paying works"):
 * POST /requests/check, POST /requests/quote {requestKey, action:"job.open", input}, POST
 * /requests/:id/submit once for the 402 challenge (PAYMENT-REQUIRED), then again with
 * PAYMENT-SIGNATURE and {quoteSignature}; GET /requests/:id until `admitted`, whose
 * admission.result carries {kind:"job", jobId, statusUrl, resultUrl}; GET resultUrl for the accepted
 * files (name, path, mediaType, hash, bytes, submissionHash, url), downloaded from /artifacts/:hash
 * and checked against their sha256. Each specialist role is one research job.
 */
export const SPORTS: Sport[] = ["mma", "nhl", "nfl", "nba", "football", "tennis"];
export const FACTORS = ["statistics", "injuries", "news", "weather", "venue", "experience-vs-youth", "fatigue", "tactics", "opposition-strength", "style", "odds-as-market-signal", "historical-patterns-and-unexpected-factors"] as const;
export type Factor = (typeof FACTORS)[number];
export const PHASES = ["research", "challenge", "adjudication"] as const;
export type Phase = (typeof PHASES)[number];
export type Role = { id: string; sport: Sport; factor: Factor; phase: Phase; brief: string };

const PHASE_BRIEF: Record<Phase, string> = {
  research: "Gather sourced evidence for this factor up to the event cutoff. Cite every source with its URL and observation time.",
  challenge: "Independently test the attached research for this factor: look for misleading statistics (small samples, selection, base-rate neglect) and contradictory evidence. Report what fails. You must not be the author of the research.",
  adjudication: "Weigh the attached research against the attached challenge for this factor and state what survives, with its effect on each outcome and the remaining data gaps.",
};
export const ROLES: Role[] = SPORTS.flatMap((sport) => FACTORS.flatMap((factor) => PHASES.map((phase) => ({ id: `${sport}.${factor}.${phase}`, sport, factor, phase, brief: PHASE_BRIEF[phase] }))));
export const MODEL_VERSION = "imd-sport-synth-1";
export const JOB_PRICE_UNITS = 500_000_000_000_000_000n;

export type Evidence = { id: string; url: string; observedUtc: string; publicOk: boolean; summary: string; premium?: unknown };
/** An accepted Swarm file, in the shape a later job's `inputs[]` requires. */
export type Artifact = { name: string; path: string; hash: string; mediaType: string; bytes: number; submissionHash: string };
export type ResearchRecord = {
  cacheKey: string; eventId: string; roleId: string; factor: Factor; phase: Phase; modelVersion: string; cutoffUtc: string; evidenceTime: string; evidenceHash: string;
  status: "dispatched" | "accepted" | "rejected"; orderKey?: string; orderId?: string; jobId?: string; attempt?: number;
  inputHashes?: string[]; resultHash?: string; submissionHash?: string; artifacts?: Artifact[]; contributors?: string[]; sources?: string[]; findings?: string; acceptedAt?: number; rejectReason?: string;
};

/** Only evidence licensed for public Swarm work leaves the operator; premium fields never do. */
export function publicEvidence(ev: Evidence[]) { return ev.filter((e) => e.publicOk).map(({ id, url, observedUtc, summary }) => ({ id, url, observedUtc, summary })); }
export const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
export const evidenceHash = (ev: Evidence[]) => sha256(JSON.stringify(publicEvidence(ev).sort((a, b) => a.id.localeCompare(b.id))));
/** Cache identity: event, evidence time, event cutoff, model version and role. */
export const cacheKey = (eventId: string, evidenceTime: string, cutoffUtc: string, roleId: string, version = MODEL_VERSION) => `${eventId}|${evidenceTime}|${cutoffUtc}|${version}|${roleId}`;
const records = (store: Store) => Object.values(store.db.research as Record<string, ResearchRecord>);

/** Funds: allocations and authorized spend are tracked apart; open reservations count as committed. */
export function balance(store: Store) {
  let alloc = 0n, authorized = 0n, spent = 0n, reserved = 0n;
  for (const l of store.db.ledger) { const a = BigInt(l.amountUnits); if (l.kind === "allocation") alloc += a; else if (l.kind === "authorized-spend") authorized += a; else spent += a; }
  for (const o of Object.values(store.db.swarmOrders ?? {})) if (o.state === "reserved") reserved += BigInt(o.amountUnits);
  return { allocatedUnits: alloc, authorizedUnits: authorized, spentUnits: spent, reservedUnits: reserved, availableUnits: (authorized < alloc ? authorized : alloc) - spent - reserved };
}

/**
 * Reserve a quoted amount under an idempotent order key. Runs synchronously inside one store
 * transaction, so overlapping waves cannot both pass the balance test: the second sees the first's
 * reservation. An existing live reservation for the key is returned instead of a second one.
 */
export function reserve(store: Store, key: string, roleId: string, eventId: string, amount: bigint, now = Date.now()): SwarmOrder | null {
  return store.tx((db) => {
    const ex = db.swarmOrders[key];
    if (ex && ex.state !== "released") return ex;
    if (balance(store).availableUnits < amount) return null;
    const o: SwarmOrder = { key, roleId, eventId, amountUnits: amount.toString(), state: "reserved", createdAt: now, updatedAt: now };
    db.swarmOrders[key] = o; return o;
  });
}
/** Reconcile a reservation with the order status: admitted spends it, a terminal unpaid outcome releases it. */
export function reconcile(store: Store, key: string, orderStatus: string, now = Date.now()) {
  store.tx((db) => {
    const o = db.swarmOrders[key]; if (!o || o.state !== "reserved") return;
    if (/^(admitted|admission_pending)$/.test(orderStatus)) { o.state = "spent"; db.ledger.push({ kind: "spent", amountUnits: o.amountUnits, ref: `swarm:${o.orderId ?? key}:${o.roleId}`, at: now }); }
    else if (/^(payment_failed|expired)$/.test(orderStatus)) o.state = "released";
    o.updatedAt = now; o.note = orderStatus;
  });
}

export type OrderStatus = { status: string; jobId?: string; statusUrl?: string; resultUrl?: string };
export type AcceptedFile = Artifact & { url?: string; body: string };
export type JobResult = { complete: boolean; state: string; files: AcceptedFile[]; contributors: Record<string, string>; sources?: string[] };
export interface SwarmApi {
  check(input: unknown): Promise<{ blockers: string[] }>;
  quote(requestKey: string, input: unknown): Promise<{ id: string; amount: string }>;
  pay(orderId: string): Promise<void>;
  status(orderId: string): Promise<OrderStatus>;
  result(job: { jobId: string; resultUrl?: string }): Promise<JobResult>;
}

/** The x402 + QuoteApproval signer lives with the operator (see x402.ts); this module never sees the key. */
export type Payer = (ctx: { orderId: string; order: any; paymentRequired: any; resourceUrl: string }) => Promise<{ paymentHeader: string; quoteSignature: string }>;

export function httpSwarmApi(cfg: OperatorConfig, payer: Payer, f: typeof fetch = fetch): SwarmApi {
  const auth = { Authorization: `Bearer ${cfg.imdPaidToken}`, "Content-Type": "application/json" };
  const abs = (u: string) => (/^https?:\/\//.test(u) ? u : cfg.imdApi.replace(/\/$/, "") + u);
  const j = async (r: Response) => { if (!r.ok && r.status !== 402) throw new Error(`${r.url} ${r.status}`); return r.json() as Promise<any>; };
  const decode = (h: string | null) => { if (!h) return null; try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; } };
  return {
    check: async (input) => { const r = await j(await f(abs("/requests/check"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "job.open", input }) })); return { blockers: r.blockers ?? [] }; },
    quote: async (requestKey, input) => { const o = (await j(await f(abs("/requests/quote"), { method: "POST", headers: auth, body: JSON.stringify({ requestKey, action: "job.open", input }) }))).order; return { id: o.id, amount: String(o.quote?.payment?.amount ?? o.quote?.amount) }; },
    pay: async (id) => {
      const order = (await j(await f(abs(`/requests/${id}`), { headers: auth }))).order;
      const first = await f(abs(`/requests/${id}/submit`), { method: "POST", headers: auth });
      if (first.status !== 402) { if (first.ok) return; throw new Error(`submit ${first.status}`); }
      const paymentRequired = decode(first.headers.get("PAYMENT-REQUIRED")) ?? (await first.json().catch(() => null));
      const s = await payer({ orderId: id, order, paymentRequired, resourceUrl: paymentRequired?.resource?.url ?? abs(`/requests/${id}/submit`) });
      const r = await f(abs(`/requests/${id}/submit`), { method: "POST", headers: { ...auth, "PAYMENT-SIGNATURE": s.paymentHeader }, body: JSON.stringify({ quoteSignature: s.quoteSignature }) });
      if (!(r.status === 200 || r.status === 202)) throw new Error(`submit ${r.status}`);
    },
    status: async (id) => {
      const r = await j(await f(abs(`/requests/${id}`), { headers: auth }));
      const a = r.admission?.result ?? {};
      return { status: String(r.status), jobId: a.kind === "job" || a.jobId ? a.jobId : undefined, statusUrl: a.statusUrl, resultUrl: a.resultUrl };
    },
    result: async ({ jobId, resultUrl }) => {
      const r = await j(await f(abs(resultUrl ?? `/jobs/${jobId}/result`)));
      const files: AcceptedFile[] = [];
      for (const x of r.files ?? []) {
        const resp = await f(abs(x.url ?? `/artifacts/${x.hash}`));
        files.push({ name: x.name, path: x.path, hash: x.hash, mediaType: x.mediaType, bytes: x.bytes, submissionHash: x.submissionHash, url: x.url, body: resp.ok ? await resp.text() : "" });
      }
      const contributors: Record<string, string> = {};
      try {
        const subs = await j(await f(abs(`/jobs/${jobId}/submissions`)));
        for (const s of (Array.isArray(subs) ? subs : subs.submissions ?? []) as any[]) {
          const who = s.agentId ?? s.seatId ?? s.seat ?? s.contributor ?? s.submittedBy;
          const h = s.submissionHash ?? s.hash;
          if (who && h) contributors[h] = String(who);
        }
      } catch { /* identities unavailable: accepted work is stored but counts no contributor */ }
      return { complete: r.complete === true, state: String(r.state ?? ""), files, contributors };
    },
  };
}

export function jobInput(role: Role, eventId: string, cutoffUtc: string, ev: Evidence[], inputs: (Artifact & { role: string })[] = []) {
  return {
    objective: `${role.brief} Sport: ${role.sport}. Factor: ${role.factor}. Event: ${eventId}. Use nothing observed after ${cutoffUtc}. Sports analysis only; no wagering advice. Public evidence: ${JSON.stringify(publicEvidence(ev))}${inputs.length ? ` Prior accepted work is attached under .imd/reads/artifacts/: ${inputs.map((i) => `${i.name} (${i.role})`).join(", ")}.` : ""}`,
    template: "research", outputs: [{ name: "report", path: "artifacts/report.md", mediaType: "text/markdown" }], minCitations: 2, github: false,
    ...(inputs.length ? { inputs: inputs.map(({ name, path, hash, mediaType, bytes, submissionHash }) => ({ name, path, hash, mediaType, bytes, submissionHash })) } : {}),
  };
}

const PRIOR: Record<Phase, Phase[]> = { research: [], challenge: ["research"], adjudication: ["research", "challenge"] };
/** Accepted outputs of the earlier phases for the same event, factor, evidence time and cutoff, or null if any is missing. */
export function priorWork(store: Store, role: Role, eventId: string, evidenceTime: string, cutoffUtc: string): ResearchRecord[] | null {
  const out: ResearchRecord[] = [];
  for (const ph of PRIOR[role.phase]) {
    const rec = store.db.research[cacheKey(eventId, evidenceTime, cutoffUtc, `${role.sport}.${role.factor}.${ph}`)] as ResearchRecord | undefined;
    if (!rec || rec.status !== "accepted" || !rec.artifacts?.length) return null;
    out.push(rec);
  }
  return out;
}
const priorInputs = (prior: ResearchRecord[]) => prior.flatMap((r) => (r.artifacts ?? []).map((a) => ({ ...a, name: `${r.phase}_${a.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64), role: r.roleId })));

export type WavePlan = { phase: Phase; eventId: string; evidenceTime: string; cutoffUtc: string; roles: Role[]; reused: string[]; waitingOnPriorPhase: string[]; affordable: number; skippedForBudget: string[] };

/** Plan one phase for one event: reuse cached work, hold roles whose prior phase is not accepted, fit the rest in the balance. */
export function planWave(store: Store, sport: Sport, eventId: string, phase: Phase, evidenceTime: string, cutoffUtc: string, maxRoles = 12): WavePlan {
  const candidates = ROLES.filter((r) => r.sport === sport && r.phase === phase).slice(0, maxRoles);
  const reused = candidates.filter((r) => { const rec = store.db.research[cacheKey(eventId, evidenceTime, cutoffUtc, r.id)] as ResearchRecord | undefined; return rec && rec.status !== "rejected"; }).map((r) => r.id);
  const open = candidates.filter((r) => !reused.includes(r.id));
  const waiting = open.filter((r) => !priorWork(store, r, eventId, evidenceTime, cutoffUtc)).map((r) => r.id);
  const todo = open.filter((r) => !waiting.includes(r.id));
  const affordable = Math.max(0, Number(balance(store).availableUnits / JOB_PRICE_UNITS));
  return { phase, eventId, evidenceTime, cutoffUtc, roles: todo.slice(0, affordable), reused, waitingOnPriorPhase: waiting, affordable, skippedForBudget: todo.slice(affordable).map((r) => r.id) };
}

export async function dispatchWave(store: Store, cfg: OperatorConfig, api: SwarmApi, plan: WavePlan, ev: Evidence[], now = () => Date.now()) {
  if (!cfg.researchActivated) return { dispatched: [] as string[], error: "research_not_activated" };
  const { eventId, evidenceTime, cutoffUtc } = plan;
  const out: string[] = [], skipped: { role: string; reason: string }[] = [];
  for (const role of plan.roles) {
    const prior = priorWork(store, role, eventId, evidenceTime, cutoffUtc);
    if (!prior) { skipped.push({ role: role.id, reason: "prior phase not accepted" }); continue; }
    const ck = cacheKey(eventId, evidenceTime, cutoffUtc, role.id);
    const existing = store.db.research[ck] as ResearchRecord | undefined;
    if (existing && existing.status !== "rejected") { skipped.push({ role: role.id, reason: "already dispatched" }); continue; }
    const attempt = (existing?.attempt ?? 0) + (existing ? 1 : 0);
    const orderKey = `imd-sport-${sha256(ck).slice(0, 40)}-${attempt}`;
    const inputs = priorInputs(prior);
    const input = jobInput(role, eventId, cutoffUtc, ev, inputs);
    const chk = await api.check(input);
    if (chk.blockers?.length) { skipped.push({ role: role.id, reason: chk.blockers.join("; ") }); continue; }
    const q = await api.quote(orderKey, input);
    const res = reserve(store, orderKey, role.id, eventId, BigInt(q.amount), now());
    if (!res) { skipped.push({ role: role.id, reason: "funded research balance exhausted" }); break; }
    if (res.orderId && res.orderId !== q.id) { skipped.push({ role: role.id, reason: "order key already bound" }); continue; }
    store.tx((db) => {
      res.orderId = q.id;
      db.research[ck] = { cacheKey: ck, eventId, roleId: role.id, factor: role.factor, phase: role.phase, modelVersion: MODEL_VERSION, cutoffUtc, evidenceTime, evidenceHash: evidenceHash(ev), status: "dispatched", orderKey, orderId: q.id, attempt, inputHashes: inputs.map((i) => i.hash) } satisfies ResearchRecord;
    });
    try { await api.pay(q.id); }
    catch (e) { store.tx(() => { res.note = `payment outcome unknown: ${(e as Error).message}`; }); } // stays reserved until the order status settles it
    out.push(role.id);
  }
  return { dispatched: out, skipped };
}

const URL_RE = /https?:\/\/[^\s)\]>"']+/g;
/** Collect dispatched work: reconcile spend, verify accepted files by hash, enforce challenger independence. */
export async function collect(store: Store, api: SwarmApi, eventId?: string, now = () => Date.now()) {
  const pending = records(store).filter((r) => (!eventId || r.eventId === eventId) && r.status === "dispatched");
  let accepted = 0, rejected = 0;
  for (const rec of pending) {
    const s = await api.status(rec.orderId!);
    if (rec.orderKey) reconcile(store, rec.orderKey, s.status, now());
    if (/^(payment_failed|expired)$/.test(s.status)) { store.tx(() => Object.assign(rec, { status: "rejected", rejectReason: `order ${s.status}` })); rejected++; continue; }
    if (!s.jobId) continue;
    const r = await api.result({ jobId: s.jobId, resultUrl: s.resultUrl });
    if (!r.complete) { if (/fail|cancel|expired|rejected/.test(r.state)) { store.tx(() => Object.assign(rec, { status: "rejected", jobId: s.jobId, rejectReason: `job ${r.state}` })); rejected++; } continue; }
    const verified = r.files.filter((x) => /^[0-9a-f]{64}$/.test(x.hash) && sha256(x.body) === x.hash);
    const report = verified.find((x) => x.name === "report") ?? verified[0];
    const reject = (why: string) => { store.tx(() => Object.assign(rec, { status: "rejected", jobId: s.jobId, rejectReason: why })); rejected++; };
    if (!report) { reject("no accepted file matched its hash"); continue; }
    const contributors = [...new Set(verified.map((x) => r.contributors[x.submissionHash]).filter(Boolean))];
    if (rec.phase === "challenge") {
      const research = store.db.research[cacheKey(rec.eventId, rec.evidenceTime, rec.cutoffUtc, rec.roleId.replace(/challenge$/, "research"))] as ResearchRecord | undefined;
      const authors = new Set(research?.contributors ?? []);
      if (!contributors.length) { reject("challenger identity not evidenced, independence unproven"); continue; }
      if (contributors.some((c) => authors.has(c))) { reject("challenger is not independent of the research author"); continue; }
    }
    store.tx(() => Object.assign(rec, {
      status: "accepted", jobId: s.jobId, resultHash: report.hash, submissionHash: report.submissionHash,
      artifacts: verified.map(({ name, path, hash, mediaType, bytes, submissionHash }) => ({ name, path, hash, mediaType, bytes, submissionHash })),
      contributors, sources: [...new Set([...(r.sources ?? []), ...(report.body.match(URL_RE) ?? [])])], findings: report.body, acceptedAt: now(),
    }));
    accepted++;
  }
  return { accepted, rejected };
}

/** Changed evidence invalidates cached work for that event; unchanged evidence keeps it shared. */
export function invalidate(store: Store, eventId: string, ev: Evidence[]) {
  const h = evidenceHash(ev); let n = 0;
  store.tx((db) => { for (const [k, r] of Object.entries(db.research as Record<string, ResearchRecord>)) if (r.eventId === eventId && r.evidenceHash !== h) { delete db.research[k]; n++; } });
  return n;
}

export function distinctContributors(store: Store) {
  const s = new Set<string>();
  for (const r of records(store)) if (r.status === "accepted") r.contributors?.forEach((c) => s.add(c));
  return { plannedRoles: ROLES.length, distinctContributors: s.size };
}

/** Sport models allowed to anchor a release. Only the EPL pilot has a completed backtest. */
export const MODELS: Record<Sport, { version: string; validated: boolean; scope: string; outcomes: string[] }> = {
  football: { version: "epl-elo-olog-1", validated: true, scope: "English Premier League", outcomes: ["home", "draw", "away"] },
  mma: { version: "", validated: false, scope: "", outcomes: ["fighter-a", "fighter-b"] },
  nhl: { version: "", validated: false, scope: "", outcomes: ["home", "away"] },
  nfl: { version: "", validated: false, scope: "", outcomes: ["home", "away"] },
  nba: { version: "", validated: false, scope: "", outcomes: ["home", "away"] },
  tennis: { version: "", validated: false, scope: "", outcomes: ["player-a", "player-b"] },
};

export const temper = (p: number[], t: number) => { const q = p.map((x) => Math.pow(Math.max(x, 1e-9), 1 / t)); const z = q.reduce((a, b) => a + b, 0); return q.map((x) => x / z); };
const logLoss = (rows: { p: number[]; outcome: number }[]) => rows.reduce((s, r) => s - Math.log(Math.max(r.p[r.outcome], 1e-12)), 0) / rows.length;
export const shiftProbabilities = (base: number[], shifts: number[][]) => {
  let p = base.slice();
  for (const sh of shifts) p = p.map((x, i) => Math.max(0.01, x + Math.max(-0.05, Math.min(0.05, sh[i] ?? 0))));
  const z = p.reduce((s, x) => s + x, 0); return p.map((x) => x / z);
};

export type CalibrationRow = { eventId: string; p: number[]; outcome: number };
export type Release = {
  eventId: string; version: string; sport: Sport; modelVersion: string; baseModel: string; cutoffUtc: string; evidenceTime: string; outcomes: string[]; probabilities: number[];
  calibration: { temperature: number; n: number; logLossBefore: number; logLossAfter: number };
  confidence: "low" | "medium" | "high"; reasons: string[]; counterarguments: string[]; dataGaps: string[];
  evidence: { roleId: string; phase: Phase; resultHash: string; submissionHash?: string; contributors: string[]; sources: string[]; cutoffUtc: string; modelVersion: string }[];
};
export const MIN_CALIBRATION = 100;

/**
 * Release a prediction version. The base probabilities come from a validated sport model; a factor
 * moves them (at most 5 points) only when its research, independent challenge and adjudication were
 * all accepted for the same evidence time and cutoff. The adjusted probabilities are then calibrated
 * with one temperature fitted on a separate calibration set (earlier adjusted forecasts with known
 * outcomes, excluding this event). Unresolved phases become data gaps. The full synthesis is written
 * to the operator's private premium store; nothing here is published.
 */
export function release(store: Store, o: { eventId: string; sport: Sport; base: number[]; cutoffUtc: string; evidenceTime: string; adjustments: { factor: Factor; shift: number[]; reason: string; counter?: string }[]; calibration: CalibrationRow[] }, now = Date.now()): Release {
  const model = MODELS[o.sport];
  if (!model.validated) throw new Error(`no validated model for ${o.sport}; release refused`);
  if (o.base.length !== model.outcomes.length || Math.abs(o.base.reduce((a, b) => a + b, 0) - 1) > 1e-6) throw new Error("base probabilities do not match the model's outcomes");
  const cal = o.calibration.filter((r) => r.eventId !== o.eventId && r.p.length === model.outcomes.length);
  if (cal.length < MIN_CALIBRATION) throw new Error(`calibration set has ${cal.length} rows; ${MIN_CALIBRATION} needed`);
  const rec = (factor: Factor, ph: Phase) => store.db.research[cacheKey(o.eventId, o.evidenceTime, o.cutoffUtc, `${o.sport}.${factor}.${ph}`)] as ResearchRecord | undefined;
  const resolved = new Set<Factor>(); const gaps: string[] = []; const used: ResearchRecord[] = [];
  for (const f of FACTORS) {
    const st = PHASES.map((ph) => [ph, rec(f, ph)] as const);
    const missing = st.filter(([, r]) => r?.status !== "accepted").map(([ph]) => ph);
    st.forEach(([, r]) => r?.status === "accepted" && used.push(r));
    if (missing.length) gaps.push(`${f}: ${missing.join(", ")} not accepted`); else resolved.add(f);
  }
  const applied = o.adjustments.filter((a) => resolved.has(a.factor));
  const adjusted = shiftProbabilities(o.base, applied.map((a) => a.shift));
  let T = 1, best = Infinity;
  for (let t = 0.5; t <= 2.0001; t += 0.02) { const ll = logLoss(cal.map((r) => ({ ...r, p: temper(r.p, t) }))); if (ll < best) { best = ll; T = Math.round(t * 100) / 100; } }
  const p = temper(adjusted, T).map((x) => Math.round(x * 1e4) / 1e4);
  const top = Math.max(...p);
  const rel: Release = {
    eventId: o.eventId, version: `${o.eventId}@${MODEL_VERSION}@${o.cutoffUtc}`, sport: o.sport, modelVersion: MODEL_VERSION, baseModel: model.version, cutoffUtc: o.cutoffUtc, evidenceTime: o.evidenceTime,
    outcomes: model.outcomes, probabilities: p,
    calibration: { temperature: T, n: cal.length, logLossBefore: Math.round(logLoss(cal) * 1e4) / 1e4, logLossAfter: Math.round(best * 1e4) / 1e4 },
    confidence: gaps.length > 6 || top < 0.45 ? "low" : gaps.length > 2 || top < 0.6 ? "medium" : "high",
    reasons: applied.map((a) => a.reason), counterarguments: applied.flatMap((a) => (a.counter ? [a.counter] : [])), dataGaps: gaps,
    evidence: used.map((r) => ({ roleId: r.roleId, phase: r.phase, resultHash: r.resultHash!, submissionHash: r.submissionHash, contributors: r.contributors ?? [], sources: r.sources ?? [], cutoffUtc: r.cutoffUtc, modelVersion: r.modelVersion })),
  };
  store.tx((db) => { db.premium[rel.version] = { eventId: o.eventId, releasedAt: now, purchasable: true, release: rel, findings: used.map((r) => ({ roleId: r.roleId, findings: r.findings, sources: r.sources })) }; });
  return rel;
}

/** Public listing of an event's released versions: identity and state only, never the synthesis. */
export function versionsFor(store: Store, eventId: string) {
  return Object.entries(store.db.premium as Record<string, { eventId?: string; releasedAt?: number; purchasable?: boolean; release?: Release }>)
    .filter(([, v]) => v.eventId === eventId && v.release)
    .map(([version, v]) => ({ version, eventId, modelVersion: v.release!.modelVersion, baseModel: v.release!.baseModel, cutoffUtc: v.release!.cutoffUtc, outcomes: v.release!.outcomes, releasedAt: v.releasedAt ?? 0, purchasable: v.purchasable !== false }))
    .sort((a, b) => b.releasedAt - a.releasedAt);
}
