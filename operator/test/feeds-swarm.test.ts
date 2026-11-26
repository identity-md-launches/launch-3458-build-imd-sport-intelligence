import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, decidedIn, availabilityKind, OUTCOME_MODEL, eventsFor, sportradarAdapter } from "../src/feeds.ts";
import { ROLES, FACTORS, planWave, dispatchWave, collect, invalidate, distinctContributors, release, publicEvidence, balance, type SwarmApi, type Evidence } from "../src/swarm.ts";
import { cfg, store } from "./helpers.ts";

const now = Date.parse("2026-11-26T12:00:00Z");
test("status: live, final, scheduled, stale, unavailable", () => {
  assert.equal(classify({ state: "inprogress", observedUtc: "2026-11-26T11:59:30Z", startUtc: "2026-11-26T11:00:00Z" }, now).status, "live");
  assert.equal(classify({ state: "inprogress", observedUtc: "2026-11-26T11:50:00Z", startUtc: "2026-11-26T11:00:00Z" }, now).status, "stale");
  assert.equal(classify({ state: "closed", observedUtc: "2026-11-20T00:00:00Z", startUtc: "2026-11-19T00:00:00Z" }, now).status, "final");
  assert.equal(classify({ state: "scheduled", observedUtc: "2026-11-26T11:00:00Z", startUtc: "2026-11-27T00:00:00Z" }, now).status, "scheduled");
  assert.equal(classify({ state: "scheduled", observedUtc: "2026-11-26T11:00:00Z", startUtc: "2026-11-25T00:00:00Z" }, now).status, "stale");
  assert.equal(classify({ state: "weird", observedUtc: "2026-11-26T11:59:00Z", startUtc: "2026-11-26T00:00:00Z" }, now).status, "unavailable");
});
test("regulation vs overtime, draws vs two-way, withdrawal vs injury", () => {
  assert.equal(decidedIn("nhl", "OT"), "overtime"); assert.equal(decidedIn("nhl", "SO"), "shootout"); assert.equal(decidedIn("nba", "reg"), "regulation");
  assert.equal(decidedIn("football", "AET"), "extra-time"); assert.equal(decidedIn("mma", "Decision"), "decision");
  assert.equal(OUTCOME_MODEL.football, "three-way"); assert.equal(OUTCOME_MODEL.tennis, "two-way");
  assert.equal(availabilityKind("Withdrew from the bout, replaced on the card"), "withdrawal");
  assert.equal(availabilityKind("Withdrew with a knee injury"), "confirmed-injury");
  assert.equal(availabilityKind("Out: torn ACL"), "confirmed-injury"); assert.equal(availabilityKind("Questionable (ankle)"), "questionable");
});
test("feeds: unavailable without adapters; credentialed adapter normalizes fixture", async () => {
  assert.equal((await eventsFor("nba", [], now)).status, "unavailable");
  const fx = async () => new Response(JSON.stringify({ games: [{ id: "g1", status: "closed", scheduled: "2026-11-25T00:00:00Z", home: { name: "A" }, away: { name: "B" }, home_points: 101, away_points: 99, overtime: true }] }));
  const r = await eventsFor("nba", [sportradarAdapter("k", fx as any)], now);
  assert.equal(r.status, "ok"); assert.equal(r.events[0].status, "final"); assert.equal(r.events[0].decidedIn, "overtime"); assert.equal(r.events[0].id, "sportradar:nba:g1");
  assert.equal((await eventsFor("nba", [sportradarAdapter("", fx as any)], now)).status, "unavailable");
});
test("216 roles: 6 sports x 12 factors x research/challenge/adjudication", () => {
  assert.equal(ROLES.length, 216); assert.equal(new Set(ROLES.map((r) => r.id)).size, 216); assert.equal(FACTORS.length, 12);
  assert.ok(ROLES.some((r) => r.factor === "weather") && ROLES.some((r) => r.factor === "experience-vs-youth"));
});
const ev: Evidence[] = [{ id: "e1", url: "https://example.org/a", observedUtc: "2026-11-25T00:00:00Z", publicOk: true, summary: "s" }, { id: "e2", url: "https://licensed.example/b", observedUtc: "2026-11-25T00:00:00Z", publicOk: false, summary: "paid", premium: { x: 1 } }];
function fakeApi(): SwarmApi & { quotes: unknown[] } {
  let n = 0; const quotes: unknown[] = [];
  return { quotes, check: async () => ({ blockers: [] }), quote: async (_k, input) => { quotes.push(input); return { id: `o${++n}`, amount: "500000000000000000" }; }, pay: async () => {},
    status: async (id) => ({ status: "done", jobId: `j-${id}` }), accepted: async (j) => [{ resultHash: "0x" + j, contributor: `agent-${Number(j.slice(3)) % 3}`, sources: ["https://example.org/a"], body: "ok" }] };
}
test("budgeted waves, spend cap, public evidence only, cache reuse, invalidation, contributors", async () => {
  const s = store(); const c = cfg({ IMD_SPORT_RESEARCH_ACTIVE: "1" }); const api = fakeApi();
  assert.deepEqual((await dispatchWave(s, cfg(), api, planWave(s, "nba", "ev1", "research", "t1"), "ev1", "t1", "t1", ev)).dispatched, []); // not activated
  s.db.ledger.push({ kind: "allocation", amountUnits: "2000000000000000000", ref: "a", at: 0 }, { kind: "authorized-spend", amountUnits: "1500000000000000000", ref: "b", at: 0 });
  const plan = planWave(s, "nba", "ev1", "research", "t1");
  assert.equal(plan.roles.length, 3); assert.equal(plan.skippedForBudget.length, 9);
  const d = await dispatchWave(s, c, api, plan, "ev1", "t1", "2026-11-25T12:00:00Z", ev);
  assert.equal(d.dispatched.length, 3); assert.equal(balance(s).availableUnits, 0n);
  assert.ok(!JSON.stringify(api.quotes).includes("licensed.example") && !JSON.stringify(api.quotes).includes("premium"));
  assert.equal((await collect(s, api, "ev1")).accepted, 3);
  assert.deepEqual(distinctContributors(s), { plannedRoles: 216, distinctContributors: 3 });
  assert.equal(planWave(s, "nba", "ev1", "research", "t1").reused.length, 3);
  assert.equal(invalidate(s, "ev1", ev), 0);
  assert.equal(invalidate(s, "ev1", [{ ...ev[0], summary: "changed" }]), 3);
  assert.equal(publicEvidence(ev).length, 1);
});
test("release has calibrated probabilities, confidence, reasons, counterarguments, gaps; premium kept private", () => {
  const s = store();
  s.db.research["k"] = { cacheKey: "k", eventId: "e", roleId: "football.injuries.adjudication", phase: "adjudication", modelVersion: "m", cutoffUtc: "c", evidenceHash: "h", status: "accepted", resultHash: "0xr", contributors: ["a1"], sources: [], findings: "private" };
  const r = release(s, "e", "football", [0.5, 0.25, 0.25], "2026-11-25T00:00:00Z", [{ roleId: "football.injuries.adjudication", shift: [-0.2, 0.1, 0.1], reason: "home striker out", counter: "replacement scored in 4 of 5 starts" }, { roleId: "football.weather.adjudication", shift: [0.5, 0, 0], reason: "ignored: not adjudicated" }]);
  assert.equal(r.outcomes.length, 3); assert.ok(Math.abs(r.probabilities.reduce((a, b) => a + b) - 1) < 1e-3);
  assert.ok(r.probabilities[0] > 0.42 && r.probabilities[0] < 0.5); // each shift clamped to 5 points, then renormalized assert.deepEqual(r.reasons, ["home striker out"]); assert.equal(r.counterarguments.length, 1);
  assert.ok(r.dataGaps.length === 11); assert.equal(r.confidence, "low");
  assert.ok(!JSON.stringify(r).includes("private")); assert.ok(JSON.stringify(s.db.premium).includes("private"));
});
