import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, decidedIn, availabilityKind, availabilityFrom, OUTCOME_MODEL, eventsFor, sportradarAdapter, apiSportsAdapter } from "../src/feeds.ts";
import { ROLES, FACTORS, planWave, dispatchWave, collect, invalidate, distinctContributors, release, publicEvidence, balance, httpSwarmApi, sha256, cacheKey, versionsFor, type SwarmApi, type Evidence, type ResearchRecord, type JobResult } from "../src/swarm.ts";
import { runEvent } from "../src/research.ts";
import { cfg, store, fixtureAccount } from "./helpers.ts";

const now = Date.parse("2026-11-26T12:00:00Z");
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
/** A fetch that answers by URL substring and counts every call. */
function routes(map: Record<string, unknown>) {
  const calls: string[] = [];
  const f = (async (u: string | URL) => { const url = String(u); calls.push(url); const k = Object.keys(map).find((x) => url.includes(x)); return k ? (map[k] instanceof Response ? map[k] as Response : json(map[k])) : json({ error: "nf" }, 404); }) as typeof fetch;
  return { f, calls };
}

test("status: live, final, scheduled, stale, unavailable", () => {
  assert.equal(classify({ state: "inprogress", observedUtc: "2026-11-26T11:59:30Z", startUtc: "2026-11-26T11:00:00Z" }, now).status, "live");
  assert.equal(classify({ state: "inprogress", observedUtc: "2026-11-26T11:50:00Z", startUtc: "2026-11-26T11:00:00Z" }, now).status, "stale");
  assert.equal(classify({ state: "closed", observedUtc: "2026-11-20T00:00:00Z", startUtc: "2026-11-19T00:00:00Z" }, now).status, "final");
  assert.equal(classify({ state: "scheduled", observedUtc: "2026-11-26T11:00:00Z", startUtc: "2026-11-27T00:00:00Z" }, now).status, "scheduled");
  assert.equal(classify({ state: "scheduled", observedUtc: "2026-11-26T11:00:00Z", startUtc: "2026-11-25T00:00:00Z" }, now).status, "stale");
  assert.equal(classify({ state: "cancelled", observedUtc: "2026-11-26T11:59:00Z", startUtc: "2026-11-26T00:00:00Z" }, now).status, "unavailable");
});
test("regulation vs overtime, draws vs two-way, withdrawal vs injury vs unknown reason", () => {
  assert.equal(decidedIn("nhl", "OT"), "overtime"); assert.equal(decidedIn("nhl", "SO"), "shootout"); assert.equal(decidedIn("nba", "reg"), "regulation");
  assert.equal(decidedIn("football", "AET"), "extra-time"); assert.equal(decidedIn("mma", "Decision"), "decision");
  assert.equal(OUTCOME_MODEL.football, "three-way"); assert.equal(OUTCOME_MODEL.tennis, "two-way");
  assert.equal(availabilityKind("Withdrew (no injury reported)"), "withdrawal");
  assert.equal(availabilityKind("Withdrew from the bout, replaced on the card"), "withdrawal");
  assert.equal(availabilityKind("Withdrew with a knee injury"), "confirmed-injury");
  assert.equal(availabilityKind("Out: torn ACL"), "confirmed-injury"); assert.equal(availabilityKind("Questionable (ankle)"), "questionable");
  assert.equal(availabilityKind("Out"), "unknown-reason");
  assert.equal(availabilityFrom("Out", "Not Injury Related - Personal"), "withdrawal");
  assert.equal(availabilityFrom("Out", "Knee"), "confirmed-injury");
  assert.equal(availabilityFrom("Out", ""), "unknown-reason");
  assert.equal(availabilityFrom("Missing Fixture", "Suspended"), "suspension");
  assert.equal(availabilityFrom("Questionable", "Knock"), "questionable");
});

const KEY = "fixture-key";
test("Sportradar uses documented access-level routes and maps NHL, NBA, NFL, MMA and tennis with availability", async () => {
  const { f, calls } = routes({
    "/nhl/trial/v7/en/games/2026/11/26/schedule.json": { games: [{ id: "n1", status: "inprogress", scheduled: "2026-11-26T11:00:00Z", home: { name: "Home H" }, away: { name: "Away H" }, home_points: 2, away_points: 1 }, { id: "n2", status: "closed", scheduled: "2026-11-25T00:00:00Z", home: { name: "A" }, away: { name: "B" }, home_points: 3, away_points: 2, shootout: true }] },
    "/nhl/trial/v7/en/league/injuries.json": { teams: [{ name: "Home H", players: [{ id: "p1", full_name: "Skater One", injuries: [{ id: "i1", status: "Out", desc: "Lower Body", update_date: "2026-11-26T09:00:00Z" }] }, { id: "p2", full_name: "Skater Two", injuries: [{ id: "i2", status: "Out", desc: "Not Injury Related - Personal" }] }] }] },
    "/nba/trial/v8/en/games/2026/11/26/schedule.json": { games: [{ id: "b1", status: "scheduled", scheduled: "2026-11-27T00:30:00Z", home: { name: "H" }, away: { name: "A" } }] },
    "/nba/trial/v8/en/league/injuries.json": { teams: [] },
    "/nfl/official/trial/v7/en/games/current_week/schedule.json": { season: { year: 2026, type: "REG" }, week: { sequence: 12, games: [{ id: "f1", status: "closed", scheduled: "2026-11-24T01:15:00Z", home: { name: "H" }, away: { name: "A" }, scoring: { home_points: 27, away_points: 24, periods: [{ period_type: "quarter" }, { period_type: "overtime" }] } }] } },
    "/nfl/official/trial/v7/en/seasons/2026/REG/12/injuries.json": { week: { teams: [{ name: "H", players: [{ id: "q", name: "QB", injuries: [{ status: "Questionable", primary: "Ankle" }] }] }] } },
    "/mma/trial/v2/en/schedules/2026-11-26/summaries.json": { summaries: [{ sport_event: { id: "sr:sport_event:1", start_time: "2026-11-26T22:00:00Z", competitors: [{ id: "c1", name: "Fighter A", qualifier: "home" }, { id: "c2", name: "Fighter B", qualifier: "away" }], sport_event_context: { competition: { name: "UFC Fight Night" } } }, sport_event_status: { status: "not_started" } }] },
    "/tennis/trial/v3/en/schedules/2026-11-26/summaries.json": { summaries: [{ sport_event: { id: "sr:sport_event:9", start_time: "2026-11-26T10:00:00Z", competitors: [{ id: "a", name: "Player A", qualifier: "home" }, { id: "b", name: "Player B", qualifier: "away" }] }, sport_event_status: { status: "closed", match_status: "walkover", winner_id: "a" } }] },
  });
  const sr = [sportradarAdapter(KEY, f)];
  const nhl = await eventsFor("nhl", sr, now);
  assert.equal(nhl.status, "ok"); assert.equal(nhl.events[0].status, "live"); assert.deepEqual(nhl.events[0].score, [2, 1]); assert.equal(nhl.events[1].decidedIn, "shootout");
  assert.deepEqual(nhl.availability.reports.map((r) => r.kind), ["confirmed-injury", "withdrawal"]);
  assert.ok(calls.every((u) => !u.includes("/nhl/official/")), "NHL has no /official/ segment");
  assert.equal((await eventsFor("nba", sr, now)).events[0].status, "scheduled");
  const nfl = await eventsFor("nfl", sr, now);
  assert.equal(nfl.events[0].decidedIn, "overtime"); assert.equal(nfl.availability.reports[0].kind, "questionable");
  const mma = await eventsFor("mma", sr, now);
  assert.equal(mma.status, "ok"); assert.equal(mma.events.length, 1); assert.equal(mma.events[0].home, "Fighter A"); assert.equal(mma.events[0].outcomeModel, "two-way");
  assert.equal(mma.availability.status, "unavailable"); assert.match(mma.availability.reason!, /no injury or withdrawal endpoint/);
  const ten = await eventsFor("tennis", sr, now);
  assert.equal(ten.status, "ok"); assert.equal(ten.events[0].status, "final");
  assert.equal(ten.availability.reports[0].kind, "withdrawal"); assert.equal(ten.availability.reports[0].player, "Player B");
  assert.equal(ten.events[0].availability.length, 1, "withdrawal attached to its event");
});
test("API-Sports football fixtures and injuries; upstream refusal and missing keys are explicit unavailable states", async () => {
  const { f } = routes({
    "/fixtures?": { response: [{ fixture: { id: 77, date: "2026-11-28T15:00:00+00:00", status: { short: "NS" } }, teams: { home: { name: "Arsenal" }, away: { name: "Manchester City" } }, goals: { home: null, away: null } }] },
    "/injuries?": { response: [{ player: { id: 5, name: "Defender", type: "Missing Fixture", reason: "Hamstring Injury" }, team: { name: "Arsenal" }, fixture: { id: 77 } }, { player: { id: 6, name: "Mid", type: "Missing Fixture", reason: "Suspended" }, team: { name: "Arsenal" }, fixture: { id: 77 } }] },
  });
  const fb = await eventsFor("football", [apiSportsAdapter(KEY, f)], now);
  assert.equal(fb.events[0].status, "scheduled"); assert.equal(fb.events[0].outcomeModel, "three-way");
  assert.deepEqual(fb.events[0].availability.map((a) => a.kind), ["confirmed-injury", "suspension"]);
  assert.equal((await eventsFor("nba", [], now)).status, "unavailable");
  const denied = routes({ "api.sportradar.com": json({ message: "Not Authorized" }, 403) });
  const r = await eventsFor("mma", [sportradarAdapter(KEY, denied.f)], now);
  assert.equal(r.status, "unavailable"); assert.match(r.reason!, /403.*not licensed/);
  assert.equal((await eventsFor("nba", [sportradarAdapter("", denied.f)], now)).status, "unavailable");
});

test("216 roles: 6 sports x 12 factors x research/challenge/adjudication", () => {
  assert.equal(ROLES.length, 216); assert.equal(new Set(ROLES.map((r) => r.id)).size, 216); assert.equal(FACTORS.length, 12);
});

const ev: Evidence[] = [{ id: "e1", url: "https://example.org/a", observedUtc: "2026-11-25T00:00:00Z", publicOk: true, summary: "s" }, { id: "e2", url: "https://licensed.example/b", observedUtc: "2026-11-25T00:00:00Z", publicOk: false, summary: "paid", premium: { x: 1 } }];
const ET = "2026-11-25T00:00:00Z", CUT = "2026-11-26T00:00:00Z";
/** In-memory Swarm: each order becomes a job whose accepted report is hashed; `who` picks the contributor. */
function fakeApi(who: (roleHint: string, n: number) => string = (_r, n) => `agent-${n}`) {
  let n = 0; const quotes: any[] = []; const orders = new Map<string, { input: any; hint: string }>(); const paid: string[] = [];
  const api: SwarmApi = {
    check: async () => ({ blockers: [] }),
    quote: async (key, input: any) => { quotes.push({ key, input }); const id = `o${++n}`; orders.set(id, { input, hint: String(input.objective).slice(0, 40) }); return { id, amount: "500000000000000000" }; },
    pay: async (id) => { paid.push(id); },
    status: async (id) => ({ status: "admitted", jobId: `job-${id}`, statusUrl: `/jobs/job-${id}`, resultUrl: `/jobs/job-${id}/result` }),
    result: async ({ jobId }): Promise<JobResult> => { const k = Number(jobId.split("-o")[1]); const body = `report ${jobId} https://example.org/source-${k}`; const sub = sha256("sub" + jobId); return { complete: true, state: "completed", files: [{ name: "report", path: "artifacts/report.md", mediaType: "text/markdown", hash: sha256(body), bytes: body.length, submissionHash: sub, body }], contributors: { [sub]: who(orders.get(`o${k}`)!.hint, k) } }; },
  };
  return { api, quotes, paid };
}
const fund = (s: ReturnType<typeof store>, imd: number) => s.db.ledger.push({ kind: "allocation", amountUnits: (BigInt(imd * 10) * 10n ** 17n).toString(), ref: "a", at: 0 }, { kind: "authorized-spend", amountUnits: (BigInt(imd * 10) * 10n ** 17n).toString(), ref: "b", at: 0 });

test("documented order shape reaches collection: admission.result.jobId, resultUrl, artifact hash check", async () => {
  const body = "# report\nhttps://example.org/x";
  const { f, calls } = routes({
    "/requests/fixture-order": { status: "admitted", admission: { result: { kind: "job", jobId: "fixture-job", launch: false, statusUrl: "/jobs/fixture-job", resultUrl: "/jobs/fixture-job/result" } } },
    "/jobs/fixture-job/result": { jobId: "fixture-job", state: "completed", complete: true, files: [{ name: "report", path: "artifacts/report.md", mediaType: "text/markdown", hash: sha256(body), bytes: body.length, submissionHash: "ab".repeat(32), url: "https://api.imd.fun/artifacts/" + sha256(body) }], delivery: {} },
    "/artifacts/": new Response(body),
    "/jobs/fixture-job/submissions": { submissions: [{ submissionHash: "ab".repeat(32), agentId: "seat-7" }] },
  });
  const api = httpSwarmApi(cfg(), async () => ({ payment: {}, paymentHeader: "", quoteSignature: "" }), f);
  assert.deepEqual(await api.status("fixture-order"), { status: "admitted", jobId: "fixture-job", statusUrl: "/jobs/fixture-job", resultUrl: "/jobs/fixture-job/result" });
  const r = await api.result({ jobId: "fixture-job", resultUrl: "/jobs/fixture-job/result" });
  assert.equal(r.files[0].body, body); assert.equal(r.contributors["ab".repeat(32)], "seat-7");
  assert.ok(calls.some((u) => u.endsWith("/jobs/fixture-job/result")));
});
test("phases are gated on accepted prior work; inputs carry its artifacts; challenger must be independent", async () => {
  const s = store(); fund(s, 0.5); const c = cfg({ IMD_SPORT_RESEARCH_ACTIVE: "1" });
  // The reported reproduction: one funded slot, no accepted records.
  assert.deepEqual(planWave(s, "nba", "e", "challenge", ET, CUT).roles, []);
  assert.deepEqual(planWave(s, "nba", "e", "adjudication", ET, CUT).roles, []);
  assert.equal(planWave(s, "nba", "e", "challenge", ET, CUT).waitingOnPriorPhase.length, 12);
  fund(s, 10);
  const same = fakeApi(() => "agent-same");
  await runEvent(s, c, same.api, { sport: "nba", eventId: "e", cutoffUtc: CUT, evidence: ev, evidenceTime: ET, phases: ["research"], maxRoles: 1 });
  await collect(s, same.api, "e");
  const d = await dispatchWave(s, c, same.api, planWave(s, "nba", "e", "challenge", ET, CUT, 1), ev);
  assert.deepEqual(d.dispatched, ["nba.statistics.challenge"]);
  const chInput = same.quotes.at(-1).input;
  const research = s.db.research[cacheKey("e", ET, CUT, "nba.statistics.research")] as ResearchRecord;
  assert.equal(chInput.inputs.length, 1); assert.equal(chInput.inputs[0].hash, research.resultHash); assert.equal(chInput.inputs[0].submissionHash, research.submissionHash);
  await collect(s, same.api, "e");
  const ch = s.db.research[cacheKey("e", ET, CUT, "nba.statistics.challenge")] as ResearchRecord;
  assert.equal(ch.status, "rejected"); assert.match(ch.rejectReason!, /not independent/);
  assert.deepEqual(planWave(s, "nba", "e", "adjudication", ET, CUT, 1).roles, [], "no adjudication without an accepted challenge");
  // A different contributor passes, and only then does adjudication open with both artifacts.
  const indep = fakeApi((_h, n) => `agent-other-${n}`);
  await dispatchWave(s, c, indep.api, planWave(s, "nba", "e", "challenge", ET, CUT, 1), ev);
  await collect(s, indep.api, "e");
  assert.equal((s.db.research[cacheKey("e", ET, CUT, "nba.statistics.challenge")] as ResearchRecord).status, "accepted");
  await dispatchWave(s, c, indep.api, planWave(s, "nba", "e", "adjudication", ET, CUT, 1), ev);
  assert.equal(indep.quotes.at(-1).input.inputs.length, 2);
});
test("overlapping waves cannot spend past the funded balance; reservations reconcile with order status", async () => {
  const s = store(); fund(s, 0.5); const c = cfg({ IMD_SPORT_RESEARCH_ACTIVE: "1" });
  const a = fakeApi();
  const [w1, w2] = await Promise.all([
    dispatchWave(s, c, a.api, planWave(s, "nba", "ev-a", "research", ET, CUT, 1), ev),
    dispatchWave(s, c, a.api, planWave(s, "nba", "ev-b", "research", ET, CUT, 1), ev),
  ]);
  assert.equal(w1.dispatched.length + w2.dispatched.length, 1);
  assert.equal(a.paid.length, 1);
  const b = balance(s); assert.equal(b.reservedUnits, 500000000000000000n); assert.equal(b.availableUnits, 0n); assert.equal(b.spentUnits, 0n);
  await collect(s, a.api);
  const b2 = balance(s); assert.equal(b2.reservedUnits, 0n); assert.equal(b2.spentUnits, 500000000000000000n);
  // A failed payment releases its reservation only on a terminal unpaid status.
  const s2 = store(); fund(s2, 0.5);
  const failing = { ...fakeApi().api, pay: async () => { throw new Error("network"); }, status: async () => ({ status: "payment_failed" }) };
  await dispatchWave(s2, c, failing, planWave(s2, "nba", "ev-c", "research", ET, CUT, 1), ev);
  assert.equal(balance(s2).reservedUnits, 500000000000000000n, "unknown payment outcome stays reserved");
  await collect(s2, failing);
  assert.equal(balance(s2).reservedUnits, 0n); assert.equal(balance(s2).availableUnits, 500000000000000000n);
});
test("activation switch, public evidence only, cache reuse, invalidation, distinct contributors", async () => {
  const s = store(); const api = fakeApi();
  assert.deepEqual((await dispatchWave(s, cfg(), api.api, planWave(s, "nba", "ev1", "research", ET, CUT), ev)).dispatched, []);
  fund(s, 1.5); const c = cfg({ IMD_SPORT_RESEARCH_ACTIVE: "1" });
  const plan = planWave(s, "nba", "ev1", "research", ET, CUT);
  assert.equal(plan.roles.length, 3); assert.equal(plan.skippedForBudget.length, 9);
  assert.equal((await dispatchWave(s, c, api.api, plan, ev)).dispatched.length, 3);
  assert.ok(!JSON.stringify(api.quotes).includes("licensed.example") && !JSON.stringify(api.quotes).includes("premium"));
  assert.equal((await collect(s, api.api, "ev1")).accepted, 3);
  assert.deepEqual(distinctContributors(s), { plannedRoles: 216, distinctContributors: 3 });
  assert.equal(planWave(s, "nba", "ev1", "research", ET, CUT).reused.length, 3);
  assert.equal(invalidate(s, "ev1", ev), 0);
  assert.equal(invalidate(s, "ev1", [{ ...ev[0], summary: "changed" }]), 3);
  assert.equal(publicEvidence(ev).length, 1);
});

const accepted = (s: ReturnType<typeof store>, ev: string, sport: string, factor: string, phases: string[], who = "a") => phases.forEach((ph, i) => {
  const roleId = `${sport}.${factor}.${ph}`; const k = cacheKey(ev, ET, CUT, roleId);
  s.db.research[k] = { cacheKey: k, eventId: ev, roleId, factor: factor as any, phase: ph as any, modelVersion: "imd-sport-synth-1", cutoffUtc: CUT, evidenceTime: ET, evidenceHash: "h", status: "accepted", resultHash: sha256(roleId), submissionHash: sha256("s" + roleId), artifacts: [], contributors: [`${who}${i}`], sources: ["https://example.org"], findings: "private finding" } satisfies ResearchRecord;
});
