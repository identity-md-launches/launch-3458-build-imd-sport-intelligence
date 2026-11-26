/**
 * Regression tests for the reviewer's findings on the previous round. Offline fixtures only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { verifyTypedData } from "viem";
import { createSiweMessage } from "viem/siwe";
import { Store } from "../src/store.ts";
import { cfg, fixtureAccount, fixtureChain, ORIGIN } from "./helpers.ts";
import { validate, schemas } from "./schema.ts";
import { httpSwarmApi, planWave, dispatchWave, collect, release, versionsFor, isPurchasableVersion, cacheKey, sha256, balance, FACTORS, PHASES, forecastKey, MIN_CALIBRATION, type SwarmApi, type Evidence, type ResearchRecord, type Challenge } from "../src/swarm.ts";
import { swarmPayer, shapeProblems, quoteApprovalMessage, quoteApprovalDomain, QUOTE_APPROVAL_TYPES } from "../src/x402.ts";
import { backfillEplArchive, archiveCutoff } from "../src/forecasts.ts";
import { sportradarAdapter, availabilityFrom, eventsFor } from "../src/feeds.ts";
import { issueNonce, verifySignIn } from "../src/siwe.ts";
import { handler } from "../src/server.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ET = "2026-11-25T00:00:00Z", CUT = "2026-11-26T00:00:00Z";
const ev: Evidence[] = [{ id: "e1", url: "https://example.org/a", observedUtc: ET, publicOk: true, summary: "s" }];
const HALF = 500000000000000000n;
const tmpStore = () => mkdtempSync(join(tmpdir(), "imd-sport-store-"));
const seed = (s: Store, units = HALF) => s.tx((db) => { db.ledger.push({ kind: "allocation", amountUnits: units.toString(), ref: "alloc", at: 0 }, { kind: "authorized-spend", amountUnits: units.toString(), ref: "auth", at: 0 }); });
const json = (x: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json", ...headers } });

/** A fixture IMD paid API that validates every request and response against the published schemas. */
function fixtureImd(signer: `0x${string}`) {
  const problems: string[] = []; const posts: { url: string; headers: Record<string, string>; body: any }[] = [];
  const orders = new Map<string, { requestKey: string; quote: Challenge["quote"]; paid: boolean }>();
  const nowS = () => Math.floor(Date.now() / 1000);
  const check = (what: string, schema: unknown, v: unknown) => { const p = validate(schema, v); if (p.length) problems.push(`${what}: ${p.join("; ")}`); };
  const challengeFor = (id: string): Challenge => {
    const o = orders.get(id)!;
    return { x402Version: 2, resource: { url: `https://api.imd.fun/requests/${id}/submit`, description: "job.open", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "eip155:1", asset: o.quote.payment.asset, amount: o.quote.payment.amount, payTo: o.quote.payment.payTo, maxTimeoutSeconds: 300, extra: { assetTransferMethod: "permit2" } }],
      quote: o.quote, requesterScopeHash: "5c".repeat(32), resourceUrl: `https://api.imd.fun/requests/${id}/submit`, input: {} };
  };
  const statusOf = (id: string) => { const o = orders.get(id)!; return { status: o.paid ? "admitted" : "quoted", order: { id, requestKey: o.requestKey, status: o.paid ? "paid" : "quoted", quote: o.quote, inputJson: "{}", createdAt: "2026-11-26T00:00:00Z", paidAt: o.paid ? "2026-11-26T00:00:01Z" : null }, payment: o.paid ? { status: "confirmed", paid: true, transactionHash: "0x" + "ab".repeat(32) } : null, admission: o.paid ? { action: "job.open", result: { kind: "job", jobId: `job-${id}`, launch: false, statusUrl: `/jobs/job-${id}`, resultUrl: `/jobs/job-${id}/result` } } : null }; };
  const body = "# Statistics\nSource https://example.org/a";
  const f = (async (u: string | URL, init: RequestInit = {}) => {
    const url = String(u); const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const b = init.body ? JSON.parse(String(init.body)) : undefined;
    if (init.method === "POST") posts.push({ url, headers, body: b });
    if (url.endsWith("/requests/check")) return json({ ok: true, blockers: [] });
    if (url.endsWith("/requests/quote")) {
      check("quote body", schemas.quoteBody, b);
      if (!/^[0-9a-f]{64}$/i.test(String(headers.authorization).replace(/^Bearer /, ""))) problems.push("request token is not 64 hex");
      const existing = [...orders.entries()].find(([, o]) => o.requestKey === b.requestKey);
      const id = existing?.[0] ?? randomUUID();
      if (!existing) orders.set(id, { requestKey: b.requestKey, paid: false, quote: { v: 1, id, action: "job.open", policyVersion: "job-1", inputHash: sha256(JSON.stringify(b.input)), issuedAt: nowS(), expiresAt: nowS() + 600, payment: { network: "eip155:1", asset: "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7", amount: HALF.toString(), payTo: "0x4e0fa57bde726079356537e2f34d671e9f41adbc", decimals: 18, scheme: "exact" }, terms: { purchase: "action-admission", resultGuaranteed: false }, quoteHash: "9a".repeat(32) } });
      const res = { created: !existing, order: statusOf(id).order }; check("quote response", schemas.quoteResponse, res);
      return json(res, existing ? 200 : 201);
    }
    const sm = url.match(/\/requests\/([0-9a-f-]+)\/submit$/);
    if (sm) {
      const id = sm[1]; const ch = challengeFor(id);
      if (!headers["payment-signature"]) {
        if (b !== undefined) check("challenge request body", schemas.submitBody, b);
        check("challenge", schemas.challenge, ch);
        return json(ch, 402, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify({ x402Version: 2, resource: ch.resource, accepts: ch.accepts })).toString("base64") });
      }
      check("submit body", schemas.submitBody, b);
      const payment = JSON.parse(Buffer.from(headers["payment-signature"], "base64").toString("utf8"));
      problems.push(...shapeProblems(payment).map((x) => `payment: ${x}`));
      if (JSON.stringify(payment.accepted) !== JSON.stringify(ch.accepts[0])) problems.push("accepted differs from accepts[0]");
      if (payment.resource?.url !== ch.resourceUrl) problems.push("resource.url is not resourceUrl");
      if (!(BigInt(payment.payload.permit2Authorization.deadline) < BigInt(ch.quote.expiresAt))) problems.push("deadline not before quote.expiresAt");
      if (payment.payload.permit2Authorization.from.toLowerCase() !== signer.toLowerCase()) problems.push("payment not from the signer");
      const ok = await verifyTypedData({ address: signer, domain: quoteApprovalDomain(ch), types: QUOTE_APPROVAL_TYPES, primaryType: "QuoteApproval", message: quoteApprovalMessage(ch, payment), signature: b.quoteSignature });
      if (!ok) problems.push("invalid_quote_approval");
      orders.get(id)!.paid = true; const st = statusOf(id); check("submit status", schemas.status, st); return json(st, 202);
    }
    const gm = url.match(/\/requests\/([0-9a-f-]+)$/);
    if (gm) { const st = statusOf(gm[1]); check("status", schemas.status, st); return json(st); }
    const rm = url.match(/\/jobs\/(job-[0-9a-f-]+)\/result$/);
    if (rm) return json({ jobId: rm[1], state: "completed", complete: true, files: [{ name: "report", path: "artifacts/report.md", mediaType: "text/markdown", hash: sha256(body), bytes: body.length, submissionHash: sha256("sub" + rm[1]), url: `https://api.imd.fun/artifacts/${sha256(body)}` }] });
    if (url.includes("/artifacts/")) return new Response(body);
    const subm = url.match(/\/jobs\/(job-[0-9a-f-]+)\/submissions$/);
    if (subm) return json({ submissions: [{ submissionHash: sha256("sub" + subm[1]), agentId: "seat-11" }] });
    return json({ error: "not_found" }, 404);
  }) as typeof fetch;
  return { f, problems, posts, orders };
}

test("Swarm: UUID requestKey, documented challenge -> Permit2 + QuoteApproval -> admission -> collection, all against the published schemas", async () => {
  const acct = fixtureAccount("swarm-signer");
  const imd = fixtureImd(acct.address);
  const s = new Store(null); seed(s);
  const c = cfg({ IMD_SPORT_RESEARCH_ACTIVE: "1", IMD_PAID_TOKEN: "7e".repeat(32) });
  const api = httpSwarmApi(c, swarmPayer(acct), imd.f);
  const d = await dispatchWave(s, c, api, planWave(s, "nba", "ev-1", "research", ET, CUT, 1), ev);
  assert.deepEqual(d.dispatched, ["nba.statistics.research"]);
  assert.deepEqual(imd.problems, []);
  const quote = imd.posts.find((p) => p.url.endsWith("/requests/quote"))!;
  assert.match(quote.body.requestKey, UUID);
  const submits = imd.posts.filter((p) => p.url.endsWith("/submit"));
  assert.equal(submits.length, 2, "one challenge POST and one signed retry");
  assert.ok(!submits[0].headers["payment-signature"] && submits[1].headers["payment-signature"]);
  assert.match(submits[1].body.quoteSignature, /^0x[0-9a-fA-F]{130}$/);
  const order = Object.values(s.db.swarmOrders)[0];
  assert.equal(order.requestKey, quote.body.requestKey, "the UUID is persisted with the order");
  assert.ok(quote.body.input.objective.length <= 8000 && quote.body.input.skill === "research-report");
  const r = await collect(s, api);
  assert.deepEqual(r, { accepted: 1, rejected: 0 });
  const rec = s.db.research[cacheKey("ev-1", ET, CUT, "nba.statistics.research")] as ResearchRecord;
  assert.deepEqual(rec.contributors, ["seat-11"]);
  assert.equal(balance(s).spentUnits, HALF);
});

test("Swarm: a failed quote keeps the reservation and the retry reuses the same requestKey", async () => {
  const acct = fixtureAccount("swarm-signer");
  const imd = fixtureImd(acct.address);
  let failQuote = true;
  const f = (async (u: string | URL, init?: RequestInit) => { if (String(u).endsWith("/requests/quote") && failQuote) { failQuote = false; await imd.f(u, init); return json({ error: "unavailable" }, 503); } return imd.f(u, init); }) as typeof fetch;
  const s = new Store(null); seed(s);
  const c = cfg({ IMD_SPORT_RESEARCH_ACTIVE: "1", IMD_PAID_TOKEN: "7e".repeat(32) });
  const api = httpSwarmApi(c, swarmPayer(acct), f);
  const first = await dispatchWave(s, c, api, planWave(s, "nba", "ev-2", "research", ET, CUT, 1), ev);
  assert.equal(first.dispatched.length, 0);
  assert.equal(balance(s).reservedUnits, HALF, "reservation held for the retry");
  const second = await dispatchWave(s, c, api, planWave(s, "nba", "ev-2", "research", ET, CUT, 1), ev);
  assert.equal(second.dispatched.length, 1);
  const keys = imd.posts.filter((p) => p.url.endsWith("/requests/quote")).map((p) => p.body.requestKey);
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
  assert.equal(imd.orders.size, 1, "IMD sees one order");
  assert.deepEqual(imd.problems, []);
});

test("Store: separate processes on one directory cannot overspend; a running collector sees their dispatches", async () => {
  const dir = tmpStore();
  const server = new Store(dir); seed(server);
  const a = new Store(dir), b = new Store(dir);
  const c = cfg({ IMD_SPORT_RESEARCH_ACTIVE: "1" });
  let pays = 0, n = 0;
  const api: SwarmApi = {
    check: async () => ({ blockers: [] }),
    quote: async () => ({ id: `o${++n}`, amount: HALF.toString() }),
    pay: async () => { pays++; },
    status: async (id) => ({ status: "admitted", jobId: `job-${id}`, resultUrl: `/jobs/job-${id}/result` }),
    result: async () => { const body = "report https://example.org/x"; return { complete: true, state: "completed", files: [{ name: "report", path: "artifacts/report.md", mediaType: "text/markdown", hash: sha256(body), bytes: body.length, submissionHash: "s1", body }], contributors: { s1: "seat-1" } }; },
  };
  const pa = planWave(a, "nba", "event-a", "research", ET, CUT, 1), pb = planWave(b, "nba", "event-b", "research", ET, CUT, 1);
  assert.equal(pa.roles.length + pb.roles.length, 2, "both preplanned while funds looked available");
  const [wa, wb] = await Promise.all([dispatchWave(a, c, api, pa, ev), dispatchWave(b, c, api, pb, ev)]);
  assert.equal(pays, 1); assert.equal(wa.dispatched.length + wb.dispatched.length, 1);
  const fresh = new Store(dir);
  assert.equal(Object.keys(fresh.db.swarmOrders).length, 1);
  assert.equal(balance(fresh).reservedUnits, HALF); assert.equal(balance(fresh).availableUnits, 0n);
  assert.equal((await collect(server, api)).accepted, 1, "the server's collector sees the CLI's dispatch");
  assert.equal(balance(new Store(dir)).spentUnits, HALF);
});

const acceptedRec = (s: Store, eventId: string, roleId: string, phase: string, contributors: string[]) => s.tx((db) => {
  const k = cacheKey(eventId, ET, CUT, roleId);
  db.research[k] = { cacheKey: k, eventId, roleId, factor: roleId.split(".")[1] as any, phase: phase as any, modelVersion: "imd-sport-synth-1", cutoffUtc: CUT, evidenceTime: ET, evidenceHash: "h", status: "accepted", resultHash: sha256(roleId), submissionHash: sha256("s" + roleId), artifacts: [{ name: "report", path: "artifacts/report.md", hash: sha256(roleId), mediaType: "text/markdown", bytes: 1, submissionHash: sha256("s" + roleId) }], contributors, sources: ["https://example.org"], findings: "private finding" } satisfies ResearchRecord;
});

test("Challenge: a known challenger against an unknown research author is rejected", async () => {
  const s = new Store(null); seed(s, 10n * HALF);
  acceptedRec(s, "e", "nba.statistics.research", "research", []);
  const c = cfg({ IMD_SPORT_RESEARCH_ACTIVE: "1" });
  const body = "challenge https://example.org/c";
  const api: SwarmApi = { check: async () => ({ blockers: [] }), quote: async () => ({ id: "o1", amount: HALF.toString() }), pay: async () => {}, status: async () => ({ status: "admitted", jobId: "j1" }),
    result: async () => ({ complete: true, state: "completed", files: [{ name: "report", path: "artifacts/report.md", mediaType: "text/markdown", hash: sha256(body), bytes: body.length, submissionHash: "cs", body }], contributors: { cs: "seat-challenger" } }) };
  await dispatchWave(s, c, api, planWave(s, "nba", "e", "challenge", ET, CUT, 1), ev);
  assert.deepEqual(await collect(s, api), { accepted: 0, rejected: 1 });
  assert.match((s.db.research[cacheKey("e", ET, CUT, "nba.statistics.challenge")] as ResearchRecord).rejectReason!, /research author identity not evidenced/);
});

test("Release: refuses caller probabilities, non-EPL events and duplicated calibration; only complete releases are purchasable", () => {
  const s = new Store(null);
  // The reviewer's fixture: empty store, non-EPL id, base [1,0,0], 100 copies of one calibration row.
  const dup = Array.from({ length: 100 }, () => ({ eventId: "single-duplicate-fixture", p: [1, 0, 0], outcome: 0 }));
  assert.throws(() => release(s, { eventId: "non-epl-fixture", sport: "football", base: [1, 0, 0], cutoffUtc: CUT, evidenceTime: ET, adjustments: [], calibration: dup } as any), /no recorded epl-elo-olog-1 forecast/);
  assert.equal(Object.keys(s.db.premium).length, 0);
  // A forecast recorded for a non-EPL competition is refused too.
  s.tx((db) => { db.forecasts[forecastKey("non-epl-fixture", CUT, "epl-elo-olog-1")] = { eventId: "non-epl-fixture", sport: "football", competition: "es.1", kickoffUtc: "2026-11-26T15:00:00Z", cutoffUtc: CUT, baseModel: "epl-elo-olog-1", p: [0.5, 0.3, 0.2] }; });
  assert.throws(() => release(s, { eventId: "non-epl-fixture", sport: "football", cutoffUtc: CUT, evidenceTime: ET, adjustments: [] }), /EPL events only/);
  // Duplicated rows of one event count once.
  s.tx((db) => {
    db.forecasts[forecastKey("epl-target", CUT, "epl-elo-olog-1")] = { eventId: "epl-target", sport: "football", competition: "en.1", kickoffUtc: "2026-11-26T15:00:00Z", cutoffUtc: CUT, baseModel: "epl-elo-olog-1", p: [0.5, 0.3, 0.2] };
    for (let i = 0; i < 150; i++) db.forecasts[forecastKey("one-old-match", `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`, "epl-elo-olog-1")] = { eventId: "one-old-match", sport: "football", competition: "en.1", kickoffUtc: "2026-01-01T15:00:00Z", cutoffUtc: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`, baseModel: "epl-elo-olog-1", p: [1, 0, 0], pipeline: "imd-sport-synth-1", adjusted: [1, 0, 0], outcome: 0 };
  });
  assert.throws(() => release(s, { eventId: "epl-target", sport: "football", cutoffUtc: CUT, evidenceTime: ET, adjustments: [] }), /calibration set has 1 distinct earlier events/);
});

test("Release: bound to the recorded EPL archive forecast, calibrated on distinct earlier archive events; incomplete stays out of checkout", async () => {
  const s = new Store(null);
  const bf = backfillEplArchive(s);
  assert.ok(bf.withOutcome > MIN_CALIBRATION);
  const target = Object.values(s.db.forecasts as Record<string, any>).find((f) => f.eventId.startsWith("openfootball:en.1:2026-27:") && f.outcome == null)!;
  const cut = target.cutoffUtc; assert.equal(cut, archiveCutoff(target.kickoffUtc));
  const mk = (eventId: string, roleId: string, phase: string, who: string[]) => s.tx((db) => { const k = cacheKey(eventId, ET, cut, roleId); db.research[k] = { cacheKey: k, eventId, roleId, factor: roleId.split(".")[1] as any, phase: phase as any, modelVersion: "imd-sport-synth-1", cutoffUtc: cut, evidenceTime: ET, evidenceHash: "h", status: "accepted", resultHash: sha256(roleId), submissionHash: sha256("s" + roleId), artifacts: [], contributors: who, sources: [], findings: "private" } satisfies ResearchRecord; });
  mk(target.eventId, "football.injuries.research", "research", ["a"]);
  const partial = release(s, { eventId: target.eventId, sport: "football", cutoffUtc: cut, evidenceTime: ET, adjustments: [{ factor: "injuries", shift: [0.05, 0, -0.05], reason: "r" }] });
  assert.deepEqual(partial.base, target.p, "base is the recorded model forecast");
  assert.equal(partial.complete, false); assert.equal(partial.reasons.length, 0);
  assert.ok(partial.calibration.n > MIN_CALIBRATION && partial.calibration.n < bf.withOutcome + 1);
  assert.equal(isPurchasableVersion(s, partial.version), false);
  assert.equal(versionsFor(s, target.eventId)[0].purchasable, false);
  for (const f of FACTORS) PHASES.forEach((ph, i) => mk(target.eventId, `football.${f}.${ph}`, ph, [`${ph}-${i}`]));
  const full = release(s, { eventId: target.eventId, sport: "football", cutoffUtc: cut, evidenceTime: ET, adjustments: [{ factor: "injuries", shift: [0.05, 0, -0.05], reason: "r" }] });
  assert.equal(full.complete, true); assert.equal(full.evidence.length, 36); assert.equal(isPurchasableVersion(s, full.version), true);
});

test("HTTP: POST /api/intents refuses a listed-but-disabled version with 409 and no calldata", async () => {
  const s = new Store(null); const c = cfg();
  const V = "fixture-event@imd-sport-synth-1@2026-11-26T00:00:00Z";
  s.tx((db) => { db.premium[V] = { eventId: "fixture-event", releasedAt: 1, purchasable: false, release: { version: V, eventId: "fixture-event", modelVersion: "imd-sport-synth-1", baseModel: "epl-elo-olog-1", cutoffUtc: "2026-11-26T00:00:00Z", outcomes: ["home", "draw", "away"], probabilities: [0.4, 0.3, 0.3], complete: true, dataGaps: [], evidence: [{}] } }; });
  const acct = fixtureAccount("buyer-intent"); const nonce = issueNonce(s, c);
  const m = createSiweMessage({ address: acct.address, chainId: 1, domain: new URL(ORIGIN).host, uri: ORIGIN, nonce, version: "1", issuedAt: new Date() });
  const si = await verifySignIn(s, c, m, await acct.signMessage({ message: m }), ORIGIN); assert.ok(si.ok);
  const srv = createServer(handler({ cfg: c, store: s, reader: fixtureChain(), feeds: [], tokenVerified: async () => true }));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`; const h = { origin: ORIGIN, authorization: `Bearer ${(si as any).token}`, "content-type": "application/json" };
  const list = await (await fetch(`${base}/api/events/fixture-event/predictions`, { headers: h })).json();
  assert.equal(list.versions[0].purchasable, false);
  const r = await fetch(`${base}/api/intents`, { method: "POST", headers: h, body: JSON.stringify({ predictionVersion: V }) });
  const j = await r.json(); srv.close();
  assert.equal(r.status, 409); assert.equal(j.ok, false); assert.equal(j.calls, undefined);
});

test("Sportradar MMA: today plus the upcoming window, decision winner carried, absences without an injury stay unknown", async () => {
  const now = Date.parse("2026-11-26T12:00:00Z"); const calls: string[] = [];
  const f = (async (u: string | URL) => {
    const url = String(u); calls.push(url);
    if (url.includes("/schedules/2026-11-26/")) return json({ summaries: [{ sport_event: { id: "sr:sport_event:1", start_time: "2026-11-26T02:00:00Z", competitors: [{ id: "c1", name: "Fighter One", qualifier: "home" }, { id: "c2", name: "Fighter Two", qualifier: "away" }] }, sport_event_status: { status: "closed", winner: "away_team", winner_id: "c2", method: "decision_unanimous" } }] });
    if (url.includes("/schedules/2026-11-27/")) return json({ summaries: [{ sport_event: { id: "sr:sport_event:2", start_time: "2026-11-27T22:00:00Z", competitors: [{ id: "c3", name: "Fighter Three", qualifier: "home" }, { id: "c4", name: "Fighter Four", qualifier: "away" }] }, sport_event_status: { status: "not_started" } }] });
    return json({ summaries: [] });
  }) as typeof fetch;
  const evs = await sportradarAdapter("k", f).fetchEvents("mma", now);
  assert.ok(calls.length > 1 && calls.some((u) => u.includes("2026-11-27")));
  const fin = evs.find((e) => e.id === "sportradar:mma:sr:sport_event:1")!;
  assert.equal(fin.status, "final"); assert.equal(fin.decidedIn, "decision");
  assert.deepEqual(fin.result, { outcome: "away", winner: "Fighter Two", method: "decision_unanimous" });
  assert.equal(evs.filter((e) => e.status === "scheduled").length, 1);
  const r = await eventsFor("mma", [sportradarAdapter("k", f)], now); assert.equal(r.events.length, 2);
  assert.equal(availabilityFrom("Out", "No injury reported"), "unknown-reason");
  assert.equal(availabilityFrom("Out", "Visa issue"), "unknown-reason");
  assert.equal(availabilityFrom("Out", "Knee"), "confirmed-injury");
  assert.equal(availabilityFrom("Withdrawn", "Visa issue"), "withdrawal");
  // Draws and no contests are explicit results.
  const f2 = (async () => json({ summaries: [{ sport_event: { id: "x", start_time: "2026-11-26T02:00:00Z", competitors: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, sport_event_status: { status: "closed", winner: "draw", method: "decision_split" } }, { sport_event: { id: "y", start_time: "2026-11-26T03:00:00Z", competitors: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, sport_event_status: { status: "closed", method: "no_contest" } }] })) as unknown as typeof fetch;
  const [d, nc] = await sportradarAdapter("k", f2).fetchEvents("mma", now);
  assert.equal(d.result!.outcome, "draw"); assert.equal(nc.result!.outcome, "no-contest");
});
