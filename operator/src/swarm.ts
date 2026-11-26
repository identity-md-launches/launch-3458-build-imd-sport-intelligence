import { createHash, randomUUID } from "node:crypto";
import type { Store, SwarmOrder } from "./store.ts";
import type { OperatorConfig } from "./config.ts";
import type { Sport } from "./feeds.ts";

/**
 * Research through the IMD Swarm, following https://imd.fun/docs/api/ ("How paying works") and
 * https://api.imd.fun/openapi.json: POST /requests/check, POST /requests/quote {requestKey (a fresh
 * UUID per order attempt, persisted and reused on retry), action:"job.open", input}, POST
 * /requests/:id/submit with no body for the 402 challenge, whose JSON carries accepts, quote,
 * requesterScopeHash and resourceUrl, then again with PAYMENT-SIGNATURE and {quoteSignature} (both
 * signed by x402.ts from that challenge); GET /requests/:id until `admitted`, whose
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
export function balanceOf(db: Store["db"]) {
  let alloc = 0n, authorized = 0n, spent = 0n, reserved = 0n;
  for (const l of db.ledger) { const a = BigInt(l.amountUnits); if (l.kind === "allocation") alloc += a; else if (l.kind === "authorized-spend") authorized += a; else spent += a; }
  for (const o of Object.values(db.swarmOrders ?? {})) if (o.state === "reserved") reserved += BigInt(o.amountUnits);
  return { allocatedUnits: alloc, authorizedUnits: authorized, spentUnits: spent, reservedUnits: reserved, availableUnits: (authorized < alloc ? authorized : alloc) - spent - reserved };
}
export const balance = (store: Store) => balanceOf(store.db);

/**
 * Reserve a quoted amount under an idempotent order key. Runs synchronously inside one store
 * transaction, so overlapping waves cannot both pass the balance test: the second sees the first's
 * reservation. An existing live reservation for the key is returned instead of a second one.
 */
export function reserve(store: Store, key: string, roleId: string, eventId: string, amount: bigint, now = Date.now()): SwarmOrder | null {
  return store.tx((db) => {
    const ex = db.swarmOrders[key];
    if (ex && ex.state !== "released") return ex;
    if (balanceOf(db).availableUnits < amount) return null;
    const o: SwarmOrder = { key, requestKey: randomUUID(), roleId, eventId, amountUnits: amount.toString(), state: "reserved", createdAt: now, updatedAt: now };
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
  /** Pay one quoted order; refuses unless the challenge's quote charges exactly `expectedAmount`. */
  pay(orderId: string, expectedAmount: bigint): Promise<void>;
  status(orderId: string): Promise<OrderStatus>;
  result(job: { jobId: string; resultUrl?: string }): Promise<JobResult>;
}

/** The 402 challenge JSON (openapi.json components.schemas.Challenge). */
export type Challenge = {
  x402Version: 2; resource: { url?: string; description?: string; mimeType?: string };
  accepts: { scheme: string; network: string; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number; extra?: Record<string, unknown> }[];
  quote: { v: 1; id: string; action: string; policyVersion: string; inputHash: string; issuedAt: number; expiresAt: number; payment: { network: string; asset: string; amount: string; payTo: string; decimals: number; scheme: "exact" }; terms: unknown; quoteHash: string };
  requesterScopeHash: string; resourceUrl: string; input: unknown;
};
/** The x402 + QuoteApproval signer lives with the operator (see x402.ts); this module never sees the key. */
export type Payer = (ctx: { orderId: string; challenge: Challenge; expectedAmount: bigint }) => Promise<{ payment: unknown; paymentHeader: string; quoteSignature: string }>;

export function httpSwarmApi(cfg: OperatorConfig, payer: Payer, f: typeof fetch = fetch): SwarmApi {
  const auth = { Authorization: `Bearer ${cfg.imdPaidToken}`, "Content-Type": "application/json" };
  const abs = (u: string) => (/^https?:\/\//.test(u) ? u : cfg.imdApi.replace(/\/$/, "") + u);
  const j = async (r: Response) => { if (!r.ok && r.status !== 402) throw new Error(`${r.url} ${r.status}`); return r.json() as Promise<any>; };
  const decode = (h: string | null) => { if (!h) return null; try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; } };
  return {
    check: async (input) => { const r = await j(await f(abs("/requests/check"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "job.open", input }) })); return { blockers: r.blockers ?? [] }; },
    quote: async (requestKey, input) => { const o = (await j(await f(abs("/requests/quote"), { method: "POST", headers: auth, body: JSON.stringify({ requestKey, action: "job.open", input }) }))).order; return { id: o.id, amount: String(o.quote?.payment?.amount ?? o.quote?.amount) }; },
    pay: async (id, expectedAmount) => {
      const url = abs(`/requests/${id}/submit`);
      // 1. the challenge: an empty POST. Its JSON carries quote, requesterScopeHash, resourceUrl and input.
      const first = await f(url, { method: "POST", headers: { Authorization: auth.Authorization } });
      if (first.status !== 402) { if (first.ok) return; throw new Error(`submit ${first.status}`); }
      const ch = (await first.json().catch(() => null)) as Challenge | null;
      const header = decode(first.headers.get("PAYMENT-REQUIRED"));
      if (!ch?.quote || !ch.resourceUrl) throw new Error("402 challenge JSON lacks quote/resourceUrl");
      if (header?.accepts?.[0] && JSON.stringify(header.accepts[0]) !== JSON.stringify(ch.accepts?.[0])) throw new Error("PAYMENT-REQUIRED header and challenge JSON disagree");
      // 2-3. Permit2 payment + QuoteApproval of that exact payment, 4. one signed retry.
      const s = await payer({ orderId: id, challenge: ch, expectedAmount });
      const r = await f(url, { method: "POST", headers: { ...auth, "PAYMENT-SIGNATURE": s.paymentHeader }, body: JSON.stringify({ quoteSignature: s.quoteSignature }) });
      if (!(r.status === 200 || r.status === 202)) { const e = await r.json().catch(() => ({})); throw new Error(`submit ${r.status} ${e.error ?? ""} ${e.detail ?? ""}`.trim()); }
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

/** job.open objective limit (https://imd.fun/docs/api/, "Open a job"). */
export const OBJECTIVE_MAX = 8000;
export function jobInput(role: Role, eventId: string, cutoffUtc: string, ev: Evidence[], inputs: (Artifact & { role: string })[] = []) {
  const head = `${role.brief} Sport: ${role.sport}. Factor: ${role.factor}. Event: ${eventId}. Use nothing observed after ${cutoffUtc}. Sports analysis only; no wagering advice.${inputs.length ? ` Prior accepted work is attached under .imd/reads/artifacts/: ${inputs.map((i) => `${i.name} (${i.role})`).join(", ")}.` : ""} Public evidence: `;
  // Evidence that does not fit the documented objective limit is dropped whole, newest kept first.
  const pub = publicEvidence(ev).sort((a, b) => b.observedUtc.localeCompare(a.observedUtc));
  let list = pub; while (list.length && head.length + JSON.stringify(list).length > OBJECTIVE_MAX) list = list.slice(0, -1);
  return {
    objective: head + JSON.stringify(list),
    skill: "research-report", outputs: [{ name: "report", path: "artifacts/report.md", mediaType: "text/markdown" }], minCitations: 2, github: false,
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
  // A dispatched record with no order id is a claim whose quote never landed: it is resumed, not reused.
  const reused = candidates.filter((r) => { const rec = store.db.research[cacheKey(eventId, evidenceTime, cutoffUtc, r.id)] as ResearchRecord | undefined; return rec && (rec.status === "accepted" || (rec.status === "dispatched" && !!rec.orderId)); }).map((r) => r.id);
  const open = candidates.filter((r) => !reused.includes(r.id));
  const waiting = open.filter((r) => !priorWork(store, r, eventId, evidenceTime, cutoffUtc)).map((r) => r.id);
  const ready = open.filter((r) => !waiting.includes(r.id));
  // Roles whose claim already holds a reservation resume first and need no new funds.
  const held = (r: Role) => { const rec = store.db.research[cacheKey(eventId, evidenceTime, cutoffUtc, r.id)] as ResearchRecord | undefined; return rec?.status === "dispatched" && !!rec.orderKey && store.db.swarmOrders[rec.orderKey]?.state === "reserved"; };
  const resume = ready.filter(held), fresh = ready.filter((r) => !held(r));
  const affordable = Math.max(0, Number(balance(store).availableUnits / JOB_PRICE_UNITS));
  return { phase, eventId, evidenceTime, cutoffUtc, roles: [...resume, ...fresh.slice(0, affordable)], reused, waitingOnPriorPhase: waiting, affordable, skippedForBudget: fresh.slice(affordable).map((r) => r.id) };
}

/**
 * Dispatch one planned wave. For each role, one shared-store transaction claims the order: it
 * re-reads current state, skips work another process already dispatched, recomputes the funded
 * balance, and commits a reservation of the job price together with a dispatched record and a
 * fresh UUID requestKey. Only after that commit is the order quoted and paid. A retry of the same
 * attempt reuses the persisted requestKey, so IMD returns the same order instead of a second one.
 */
export async function dispatchWave(store: Store, cfg: OperatorConfig, api: SwarmApi, plan: WavePlan, ev: Evidence[], now = () => Date.now()) {
  if (!cfg.researchActivated) return { dispatched: [] as string[], error: "research_not_activated" };
  const { eventId, evidenceTime, cutoffUtc } = plan;
  const out: string[] = [], skipped: { role: string; reason: string }[] = [];
  for (const role of plan.roles) {
    const prior = priorWork(store, role, eventId, evidenceTime, cutoffUtc);
    if (!prior) { skipped.push({ role: role.id, reason: "prior phase not accepted" }); continue; }
    const ck = cacheKey(eventId, evidenceTime, cutoffUtc, role.id);
    const inputs = priorInputs(prior);
    const input = jobInput(role, eventId, cutoffUtc, ev, inputs);
    const claim = store.tx((db) => {
      const existing = db.research[ck] as ResearchRecord | undefined;
      if (existing && existing.status !== "rejected" && existing.orderId) return { skip: "already dispatched" } as const;
      const resume = existing?.status === "dispatched" && existing.orderKey ? db.swarmOrders[existing.orderKey] : undefined;
      if (resume && resume.state === "reserved") return { order: resume, attempt: existing!.attempt ?? 0 } as const; // crashed before quoting: same requestKey
      const attempt = existing ? (existing.attempt ?? 0) + 1 : 0;
      const t = now();
      const key = `imd-sport:${sha256(ck).slice(0, 40)}:${attempt}`;
      if (balanceOf(db).availableUnits < JOB_PRICE_UNITS) return { skip: "funded research balance exhausted", stop: true } as const;
      const order: SwarmOrder = { key, requestKey: randomUUID(), roleId: role.id, eventId, amountUnits: JOB_PRICE_UNITS.toString(), state: "reserved", createdAt: t, updatedAt: t };
      db.swarmOrders[key] = order;
      db.research[ck] = { cacheKey: ck, eventId, roleId: role.id, factor: role.factor, phase: role.phase, modelVersion: MODEL_VERSION, cutoffUtc, evidenceTime, evidenceHash: evidenceHash(ev), status: "dispatched", orderKey: key, attempt, inputHashes: inputs.map((i) => i.hash) } satisfies ResearchRecord;
      return { order, attempt } as const;
    });
    if ("skip" in claim) { skipped.push({ role: role.id, reason: String(claim.skip) }); if ("stop" in claim) break; continue; }
    const { key, requestKey } = claim.order;
    const fail = (why: string) => store.tx((db) => {
      const o = db.swarmOrders[key]; if (o && o.state === "reserved" && !o.orderId) Object.assign(o, { state: "released", note: why, updatedAt: now() });
      const r = db.research[ck] as ResearchRecord | undefined; if (r && r.orderKey === key && !r.orderId) Object.assign(r, { status: "rejected", rejectReason: why });
    });
    try {
      const chk = await api.check(input);
      if (chk.blockers?.length) { fail(chk.blockers.join("; ")); skipped.push({ role: role.id, reason: chk.blockers.join("; ") }); continue; }
    } catch (e) { skipped.push({ role: role.id, reason: `check failed, reservation kept for retry: ${(e as Error).message}` }); continue; }
    let q: { id: string; amount: string };
    try { q = await api.quote(requestKey, input); }
    catch (e) { skipped.push({ role: role.id, reason: `quote failed, reservation kept for retry with the same requestKey: ${(e as Error).message}` }); continue; }
    if (BigInt(q.amount) > JOB_PRICE_UNITS) { fail(`quote ${q.amount} exceeds the reserved ${JOB_PRICE_UNITS}`); skipped.push({ role: role.id, reason: "quote above reserved price" }); continue; }
    const bound = store.tx((db) => {
      const o = db.swarmOrders[key]; const r = db.research[ck] as ResearchRecord | undefined;
      if (!o || o.state !== "reserved" || (o.orderId && o.orderId !== q.id)) return false;
      Object.assign(o, { orderId: q.id, amountUnits: String(BigInt(q.amount)), updatedAt: now() });
      if (r && r.orderKey === key) r.orderId = q.id;
      return true;
    });
    if (!bound) { skipped.push({ role: role.id, reason: "order key already bound" }); continue; }
    try { await api.pay(q.id, BigInt(q.amount)); }
    catch (e) { store.tx((db) => { const o = db.swarmOrders[key]; if (o) o.note = `payment outcome unknown: ${(e as Error).message}`; }); } // stays reserved until the order status settles it
    out.push(role.id);
  }
  return { dispatched: out, skipped };
}

const URL_RE = /https?:\/\/[^\s)\]>"']+/g;
/**
 * Collect dispatched work: reconcile spend, verify accepted files by hash, enforce challenger
 * independence. Pending records are read from the current shared state on every run, so a
 * long-running collector sees orders dispatched by other processes.
 */
export async function collect(store: Store, api: SwarmApi, eventId?: string, now = () => Date.now()) {
  const pending = records(store).filter((r) => (!eventId || r.eventId === eventId) && r.status === "dispatched" && r.orderId).map((r) => r.cacheKey);
  let accepted = 0, rejected = 0;
  const update = (ck: string, patch: Partial<ResearchRecord>) => store.tx((db) => { const r = db.research[ck] as ResearchRecord | undefined; if (r && r.status === "dispatched") Object.assign(r, patch); });
  for (const ck of pending) {
    const rec = store.db.research[ck] as ResearchRecord | undefined;
    if (!rec || rec.status !== "dispatched" || !rec.orderId) continue;
    const s = await api.status(rec.orderId);
    if (rec.orderKey) reconcile(store, rec.orderKey, s.status, now());
    if (/^(payment_failed|expired)$/.test(s.status)) { update(ck, { status: "rejected", rejectReason: `order ${s.status}` }); rejected++; continue; }
    if (!s.jobId) continue;
    const r = await api.result({ jobId: s.jobId, resultUrl: s.resultUrl });
    if (!r.complete) { if (/fail|cancel|expired|rejected/.test(r.state)) { update(ck, { status: "rejected", jobId: s.jobId, rejectReason: `job ${r.state}` }); rejected++; } continue; }
    const verified = r.files.filter((x) => /^[0-9a-f]{64}$/.test(x.hash) && sha256(x.body) === x.hash);
    const report = verified.find((x) => x.name === "report") ?? verified[0];
    const reject = (why: string) => { update(ck, { status: "rejected", jobId: s.jobId, rejectReason: why }); rejected++; };
    if (!report) { reject("no accepted file matched its hash"); continue; }
    const contributors = [...new Set(verified.map((x) => r.contributors[x.submissionHash]).filter((c): c is string => !!c))];
    if (rec.phase === "challenge") {
      // Independence needs both identities evidenced: an unknown research author cannot be compared.
      const research = store.db.research[cacheKey(rec.eventId, rec.evidenceTime, rec.cutoffUtc, rec.roleId.replace(/challenge$/, "research"))] as ResearchRecord | undefined;
      const authors = new Set(research?.status === "accepted" ? research.contributors ?? [] : []);
      if (!contributors.length) { reject("challenger identity not evidenced, independence unproven"); continue; }
      if (!authors.size) { reject("research author identity not evidenced, independence unproven"); continue; }
      if (contributors.some((c) => authors.has(c))) { reject("challenger is not independent of the research author"); continue; }
    }
    if (rec.phase === "adjudication" && !contributors.length) { reject("adjudicator identity not evidenced"); continue; }
    update(ck, {
      status: "accepted", jobId: s.jobId, resultHash: report.hash, submissionHash: report.submissionHash,
      artifacts: verified.map(({ name, path, hash, mediaType, bytes, submissionHash }) => ({ name, path, hash, mediaType, bytes, submissionHash })),
      contributors, sources: [...new Set([...(r.sources ?? []), ...(report.body.match(URL_RE) ?? [])])], findings: report.body, acceptedAt: now(),
    });
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
/** A forecast recorded by the sport model pipeline before the event (see forecasts.ts). */
export type Forecast = {
  eventId: string; sport: Sport; competition: string; kickoffUtc: string; cutoffUtc: string; baseModel: string; p: number[];
  /** Output of the release pipeline (MODEL_VERSION) for this forecast: base plus accepted adjustments, before temperature. */
  pipeline?: string; adjusted?: number[]; outcome?: number | null;
};
export const forecastKey = (eventId: string, cutoffUtc: string, baseModel: string) => `${eventId}|${cutoffUtc}|${baseModel}`;
export type Release = {
  eventId: string; version: string; sport: Sport; modelVersion: string; baseModel: string; cutoffUtc: string; evidenceTime: string; outcomes: string[]; probabilities: number[];
  base: number[]; adjusted: number[];
  calibration: { temperature: number; n: number; logLossBefore: number; logLossAfter: number; rows: "distinct earlier events, same base model and pipeline, known outcomes" };
  complete: boolean; confidence: "low" | "medium" | "high"; reasons: string[]; counterarguments: string[]; dataGaps: string[];
  evidence: { roleId: string; phase: Phase; resultHash: string; submissionHash?: string; contributors: string[]; sources: string[]; cutoffUtc: string; modelVersion: string }[];
};
export const MIN_CALIBRATION = 100;
const EPL = "en.1";

/**
 * Calibration rows for a release: one per distinct earlier event (its latest forecast before the
 * release cutoff), from the same base model and the same adjustment pipeline, EPL only, whose
 * kickoff precedes the cutoff and whose outcome is recorded. Duplicates of one event count once.
 */
export function calibrationRows(db: Store["db"], eventId: string, cutoffUtc: string, baseModel: string): CalibrationRow[] {
  const latest = new Map<string, Forecast>();
  for (const f of Object.values(db.forecasts as Record<string, Forecast>)) {
    if (f.eventId === eventId || f.baseModel !== baseModel || f.pipeline !== MODEL_VERSION || f.competition !== EPL) continue;
    if (!(f.kickoffUtc < cutoffUtc) || !(f.cutoffUtc < cutoffUtc) || !(f.cutoffUtc <= f.kickoffUtc)) continue;
    if (f.outcome == null || !(f.outcome >= 0 && f.outcome < 3) || !Array.isArray(f.adjusted) || f.adjusted.length !== 3) continue;
    const prev = latest.get(f.eventId); if (!prev || prev.cutoffUtc < f.cutoffUtc) latest.set(f.eventId, f);
  }
  return [...latest.values()].map((f) => ({ eventId: f.eventId, p: f.adjusted!, outcome: f.outcome! }));
}

/**
 * Release a prediction version. The base probabilities are the validated sport model's recorded
 * forecast for this exact event and cutoff (never caller-supplied); only the EPL pilot qualifies. A
 * factor moves them (at most 5 points) only when its research, independent challenge and
 * adjudication were all accepted for the same evidence time and cutoff. The adjusted probabilities
 * are calibrated with one temperature fitted on calibrationRows(). Unresolved phases become data
 * gaps, and a release with any gap is recorded but not purchasable. The full synthesis goes to the
 * operator's private premium store; nothing here is published.
 */
export function release(store: Store, o: { eventId: string; sport: Sport; cutoffUtc: string; evidenceTime: string; adjustments: { factor: Factor; shift: number[]; reason: string; counter?: string }[] }, now = Date.now()): Release {
  const model = MODELS[o.sport];
  if (!model.validated) throw new Error(`no validated model for ${o.sport}; release refused`);
  return store.tx((db) => {
    const fk = forecastKey(o.eventId, o.cutoffUtc, model.version);
    const fc = db.forecasts[fk] as Forecast | undefined;
    if (!fc) throw new Error(`no recorded ${model.version} forecast for ${o.eventId} at cutoff ${o.cutoffUtc}; release refused`);
    if (fc.competition !== EPL || fc.sport !== "football") throw new Error(`the ${model.scope} pilot model supports EPL events only; release refused`);
    if (!(fc.cutoffUtc <= fc.kickoffUtc)) throw new Error("forecast cutoff is after kickoff; release refused");
    const base = fc.p;
    if (base.length !== model.outcomes.length || Math.abs(base.reduce((a, b) => a + b, 0) - 1) > 1e-6) throw new Error("recorded forecast does not match the model's outcomes");
    const cal = calibrationRows(db, o.eventId, o.cutoffUtc, model.version);
    if (cal.length < MIN_CALIBRATION) throw new Error(`calibration set has ${cal.length} distinct earlier events; ${MIN_CALIBRATION} needed`);
    const rec = (factor: Factor, ph: Phase) => db.research[cacheKey(o.eventId, o.evidenceTime, o.cutoffUtc, `${o.sport}.${factor}.${ph}`)] as ResearchRecord | undefined;
    const resolved = new Set<Factor>(); const gaps: string[] = []; const used: ResearchRecord[] = [];
    for (const f of FACTORS) {
      const st = PHASES.map((ph) => [ph, rec(f, ph)] as const);
      const missing = st.filter(([, r]) => r?.status !== "accepted").map(([ph]) => ph);
      st.forEach(([, r]) => r?.status === "accepted" && used.push(r));
      if (missing.length) gaps.push(`${f}: ${missing.join(", ")} not accepted`); else resolved.add(f);
    }
    const applied = o.adjustments.filter((a) => resolved.has(a.factor));
    const adjusted = shiftProbabilities(base, applied.map((a) => a.shift));
    let T = 1, best = Infinity;
    for (let t = 0.5; t <= 2.0001; t += 0.02) { const ll = logLoss(cal.map((r) => ({ ...r, p: temper(r.p, t) }))); if (ll < best) { best = ll; T = Math.round(t * 100) / 100; } }
    const p = temper(adjusted, T).map((x) => Math.round(x * 1e4) / 1e4);
    const top = Math.max(...p);
    const complete = gaps.length === 0 && used.length === FACTORS.length * PHASES.length;
    const rel: Release = {
      eventId: o.eventId, version: `${o.eventId}@${MODEL_VERSION}@${o.cutoffUtc}`, sport: o.sport, modelVersion: MODEL_VERSION, baseModel: model.version, cutoffUtc: o.cutoffUtc, evidenceTime: o.evidenceTime,
      outcomes: model.outcomes, probabilities: p, base, adjusted,
      calibration: { temperature: T, n: cal.length, logLossBefore: Math.round(logLoss(cal) * 1e4) / 1e4, logLossAfter: Math.round(best * 1e4) / 1e4, rows: "distinct earlier events, same base model and pipeline, known outcomes" },
      complete, confidence: gaps.length > 6 || top < 0.45 ? "low" : gaps.length > 2 || top < 0.6 ? "medium" : "high",
      reasons: applied.map((a) => a.reason), counterarguments: applied.flatMap((a) => (a.counter ? [a.counter] : [])), dataGaps: gaps,
      evidence: used.map((r) => ({ roleId: r.roleId, phase: r.phase, resultHash: r.resultHash!, submissionHash: r.submissionHash, contributors: r.contributors ?? [], sources: r.sources ?? [], cutoffUtc: r.cutoffUtc, modelVersion: r.modelVersion })),
    };
    // The pipeline output is recorded with the forecast so later releases calibrate on it once the outcome is known.
    Object.assign(fc, { pipeline: MODEL_VERSION, adjusted });
    db.premium[rel.version] = { eventId: o.eventId, releasedAt: now, purchasable: complete, release: rel, findings: used.map((r) => ({ roleId: r.roleId, findings: r.findings, sources: r.sources })) };
    return rel;
  });
}

type PremiumRec = { eventId?: string; releasedAt?: number; purchasable?: boolean; release?: Release };
/**
 * The one predicate for "purchasable completed prediction", shared by the public listing and by
 * POST /api/intents: a released synthesis with every factor resolved and the operator's
 * purchasable flag explicitly true.
 */
export function isPurchasableVersion(store: Store, version: string): boolean {
  const v = store.db.premium[version] as PremiumRec | undefined;
  return !!v?.release && v.purchasable === true && v.release.complete === true && v.release.dataGaps.length === 0 && v.release.evidence.length > 0 && v.release.version === version;
}

/** Public listing of an event's released versions: identity and state only, never the synthesis. */
export function versionsFor(store: Store, eventId: string) {
  return Object.entries(store.db.premium as Record<string, PremiumRec>)
    .filter(([, v]) => v.eventId === eventId && v.release)
    .map(([version, v]) => ({ version, eventId, modelVersion: v.release!.modelVersion, baseModel: v.release!.baseModel, cutoffUtc: v.release!.cutoffUtc, outcomes: v.release!.outcomes, releasedAt: v.releasedAt ?? 0, purchasable: isPurchasableVersion(store, version) }))
    .sort((a, b) => b.releasedAt - a.releasedAt);
}
