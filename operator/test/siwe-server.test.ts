import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createSiweMessage } from "viem/siwe";
import { cfg, store, fixtureChain, fixtureAccount, ORIGIN } from "./helpers.ts";
import { issueNonce, verifySignIn, sessionFor } from "../src/siwe.ts";
import { handler } from "../src/server.ts";

const acct = fixtureAccount("siwe");
const msg = (nonce: string, over: Partial<Parameters<typeof createSiweMessage>[0]> = {}) => createSiweMessage({ address: acct.address, chainId: 1, domain: new URL(ORIGIN).host, uri: ORIGIN, nonce, version: "1", statement: "Sign in to IMD Sport Intelligence.", issuedAt: new Date(), ...over });

test("SIWE accepts a fresh nonce once, on the right origin and chain", async () => {
  const s = store(); const c = cfg(); const n = issueNonce(s, c); const m = msg(n);
  const sig = await acct.signMessage({ message: m });
  const r = await verifySignIn(s, c, m, sig, ORIGIN); assert.equal(r.ok, true);
  assert.equal((await verifySignIn(s, c, m, sig, ORIGIN) as any).error, "unknown_or_expired_nonce");
  if (r.ok) assert.equal(sessionFor(s, r.token)?.address, acct.address);
});
test("SIWE rejects wrong origin, domain, chain, expired nonce, bad signature", async () => {
  const s = store(); const c = cfg();
  const n1 = issueNonce(s, c); const m1 = msg(n1); const sig1 = await acct.signMessage({ message: m1 });
  assert.equal((await verifySignIn(s, c, m1, sig1, "https://evil.example") as any).error, "origin_not_allowed");
  const m2 = msg(n1, { domain: "evil.example" }); assert.equal((await verifySignIn(s, c, m2, await acct.signMessage({ message: m2 }), ORIGIN) as any).error, "domain_mismatch");
  const m3 = msg(n1, { chainId: 8453 }); assert.equal((await verifySignIn(s, c, m3, await acct.signMessage({ message: m3 }), ORIGIN) as any).error, "wrong_chain");
  assert.equal((await verifySignIn(s, c, m1, await fixtureAccount("x").signMessage({ message: m1 }), ORIGIN) as any).error, "bad_signature");
  const n2 = issueNonce(s, c, Date.now() - 3600_000); const m4 = msg(n2);
  assert.equal((await verifySignIn(s, c, m4, await acct.signMessage({ message: m4 }), ORIGIN) as any).error, "unknown_or_expired_nonce");
});
test("sessions expire", async () => {
  const s = store(); const c = cfg({ IMD_SPORT_SESSION_TTL: "1" }); const n = issueNonce(s, c); const m = msg(n);
  const r = await verifySignIn(s, c, m, await acct.signMessage({ message: m }), ORIGIN);
  assert.ok(r.ok); if (r.ok) assert.equal(sessionFor(s, r.token, Date.now() + 5000), null);
});
test("HTTP: signed-out access, CORS origin lock, feeds unavailable without keys, empty settings disable checkout", async () => {
  const s = store();
  for (const [c, expectEnabled] of [[cfg({ IMD_SPORT_DEVELOPER_RECIPIENT: "", IMD_SPORT_RESEARCH_RECIPIENT: "" }), false], [cfg(), true]] as const) {
    const srv = createServer(handler({ cfg: c, store: s, reader: fixtureChain(), feeds: [], tokenVerified: async () => true }));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const st = await (await fetch(base + "/api/status", { headers: { origin: ORIGIN } })).json();
    assert.equal(st.checkout.enabled, expectEnabled);
    if (!expectEnabled) assert.equal(st.checkout.recipients, null);
    assert.equal(st.research.plannedRoles, 216); assert.equal(st.research.distinctContributors, 0);
    assert.equal((await fetch(base + "/api/status", { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(base + "/api/me/history", { headers: { origin: ORIGIN } })).status, 401);
    assert.equal((await fetch(base + "/api/intents", { method: "POST", headers: { origin: ORIGIN }, body: "{}" })).status, 401);
    const f = await (await fetch(base + "/api/feeds/nhl", { headers: { origin: ORIGIN } })).json();
    assert.equal(f.status, "unavailable");
    srv.close();
  }
});
