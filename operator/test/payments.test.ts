import { test } from "node:test";
import assert from "node:assert/strict";
import { cfg, store, fixtureChain, receipt, transferLog, txh, DEV, RES, fixtureAccount } from "./helpers.ts";
import { openIntent, submitLeg, historyFor, isEntitled, transferCalldata } from "../src/payments.ts";
import { checkoutBlockers, loadConfig } from "../src/config.ts";

const buyer = fixtureAccount("buyer").address, other = fixtureAccount("other").address;
const V = "openfootball:en.1:2026-27:x@imd-sport-synth-1@2026-09-22T00:00:00Z";
const setup = () => { const s = store(); s.db.premium[V] = { release: {} }; return s; };
const purch = (v: string) => v === V;

test("checkout stays off with empty recipients and origin (defaults)", () => {
  const b = checkoutBlockers(loadConfig({}), true, true);
  assert.ok(b.includes("developer recipient not set") && b.includes("Swarm research recipient not set") && b.includes("allowed HTTPS site origin not set"));
});
test("checkout refuses unverified token, dead verifier and non-purchasable predictions", async () => {
  const s = setup(); const c = fixtureChain();
  assert.equal((await openIntent(s, cfg(), c, buyer, V, purch, false)).ok, false);
  const r = await openIntent(s, cfg(), c, buyer, "unknown", purch, true);
  assert.equal(r.ok, false); assert.ok(!r.ok && r.blockers!.some((x) => /purchasable/.test(x)));
  const dead = { ...c, chainId: async () => { throw new Error("down"); } };
  assert.equal((await openIntent(s, cfg(), dead, buyer, V, purch, true)).ok, false);
});
test("intent binds payer, version, recipients, token, creation block and expiry; calldata is 0.5 IMD each", async () => {
  const s = setup(); const c = fixtureChain({ head: 150 });
  const r = await openIntent(s, cfg(), c, buyer, V, purch, true);
  assert.ok(r.ok && !r.alreadyEntitled);
  if (!r.ok || r.alreadyEntitled) return;
  assert.equal(r.intent.payer, buyer.toLowerCase()); assert.equal(r.intent.createdBlock, 150);
  assert.equal(r.intent.legs.developer.recipient, DEV); assert.equal(r.intent.legs.research.recipient, RES);
  assert.equal(r.calls.length, 2); assert.equal(r.calls[0].data, transferCalldata(DEV)); assert.ok(r.calls[0].data.endsWith("06f05b59d3b20000"));
});
test("batched receipt with both legs grants entitlement once; reopening never charges", async () => {
  const s = setup(); const c = fixtureChain({ head: 100 });
  const r = await openIntent(s, cfg(), c, buyer, V, purch, true); if (!r.ok || r.alreadyEntitled) throw 0;
  c.head = 200; c.receipts[txh(1)] = receipt(txh(1), buyer, [transferLog(buyer, DEV, 3, txh(1)), transferLog(buyer, RES, 4, txh(1))], 120);
  const out = await submitLeg(s, cfg(), c, buyer, r.intent.id, txh(1));
  assert.deepEqual(out.verified.sort(), ["developer", "research"]); assert.equal(out.entitled, true);
  assert.equal(isEntitled(s, buyer, V), true);
  const again = await openIntent(s, cfg(), c, buyer, V, purch, true);
  assert.ok(again.ok && again.alreadyEntitled);
  assert.equal(s.db.ledger.filter((l) => l.kind === "allocation").length, 1);
});
test("duplicate receipt is refused, even for a different intent", async () => {
  const s = setup(); const c = fixtureChain({ head: 100 });
  s.db.premium["v2"] = {};
  const a = await openIntent(s, cfg(), c, buyer, V, purch, true); if (!a.ok || a.alreadyEntitled) throw 0;
  c.head = 200; c.receipts[txh(2)] = receipt(txh(2), buyer, [transferLog(buyer, DEV, 0, txh(2))], 120);
  assert.equal((await submitLeg(s, cfg(), c, buyer, a.intent.id, txh(2))).ok, true);
  assert.equal((await submitLeg(s, cfg(), c, buyer, a.intent.id, txh(2))).error, "duplicate_receipt");
  const b = await openIntent(s, cfg(), c, buyer, "v2", (v) => v === "v2", true); if (!b.ok || b.alreadyEntitled) throw 0;
  assert.equal((await submitLeg(s, cfg(), c, buyer, b.intent.id, txh(2))).error, "duplicate_receipt");
});
test("partial payment keeps its verified leg after expiry and resumes at the missing half", async () => {
  const s = setup(); const c = fixtureChain({ head: 100 }); const t0 = Date.now();
  const a = await openIntent(s, cfg(), c, buyer, V, purch, true, t0); if (!a.ok || a.alreadyEntitled) throw 0;
  c.head = 200; c.receipts[txh(3)] = receipt(txh(3), buyer, [transferLog(buyer, RES, 1, txh(3))], 110);
  assert.deepEqual((await submitLeg(s, cfg(), c, buyer, a.intent.id, txh(3), t0 + 1000)).verified, ["research"]);
  const later = t0 + 10 * 3600 * 1000; // well past the intent TTL
  const resumed = await openIntent(s, cfg(), c, buyer, V, purch, true, later); if (!resumed.ok || resumed.alreadyEntitled) throw 0;
  assert.equal(resumed.intent.id, a.intent.id); assert.deepEqual(resumed.calls.map((x) => x.leg), ["developer"]);
  c.receipts[txh(4)] = receipt(txh(4), buyer, [transferLog(buyer, DEV, 0, txh(4))], 150);
  const fin = await submitLeg(s, cfg(), c, buyer, a.intent.id, txh(4), later);
  assert.equal(fin.entitled, true);
});
test("wrong chain, wrong sender, wrong amount, wrong token, unfinalized and failed tx are refused", async () => {
  const s = setup(); const c = fixtureChain({ head: 100 });
  const a = await openIntent(s, cfg(), c, buyer, V, purch, true); if (!a.ok || a.alreadyEntitled) throw 0;
  c.head = 200;
  c.receipts[txh(5)] = receipt(txh(5), other, [transferLog(other, DEV, 0, txh(5))], 120);
  c.receipts[txh(6)] = receipt(txh(6), buyer, [transferLog(buyer, DEV, 0, txh(6), 400000000000000000n)], 120);
  c.receipts[txh(7)] = receipt(txh(7), buyer, [transferLog(buyer, DEV, 0, txh(7), undefined, "0x" + "ab".repeat(20))], 120);
  c.receipts[txh(8)] = receipt(txh(8), buyer, [transferLog(buyer, DEV, 0, txh(8))], 195);
  c.receipts[txh(9)] = receipt(txh(9), buyer, [transferLog(buyer, DEV, 0, txh(9))], 120, "0x0");
  c.receipts[txh(10)] = receipt(txh(10), buyer, [transferLog(buyer, DEV, 0, txh(10))], 90);
  for (const [n, e] of [[5, "no_matching_transfer"], [6, "no_matching_transfer"], [7, "no_matching_transfer"], [8, "not_final"], [9, "transaction_failed"], [10, "before_intent"]] as const)
    assert.equal((await submitLeg(s, cfg(), c, buyer, a.intent.id, txh(n))).error, e, `tx ${n}`);
  const wrong = fixtureChain({ chainId: 8453, head: 200, receipts: c.receipts });
  assert.equal((await submitLeg(s, cfg(), wrong, buyer, a.intent.id, txh(6))).error, "wrong_chain");
  assert.equal(isEntitled(s, buyer, V), false);
});
test("user isolation: another session cannot submit to, read, or inherit an intent", async () => {
  const s = setup(); const c = fixtureChain({ head: 100 });
  const a = await openIntent(s, cfg(), c, buyer, V, purch, true); if (!a.ok || a.alreadyEntitled) throw 0;
  c.head = 200; c.receipts[txh(11)] = receipt(txh(11), buyer, [transferLog(buyer, DEV, 0, txh(11)), transferLog(buyer, RES, 1, txh(11))], 120);
  assert.equal((await submitLeg(s, cfg(), c, other, a.intent.id, txh(11))).error, "intent_not_found");
  await submitLeg(s, cfg(), c, buyer, a.intent.id, txh(11));
  assert.equal(historyFor(s, other).length, 0); assert.equal(historyFor(s, buyer).length, 1);
  assert.equal(isEntitled(s, other, V), false);
  assert.match(historyFor(s, buyer)[0].legs[0].explorer!, /^https:\/\/etherscan\.io\/tx\/0x/);
});
