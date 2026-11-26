/**
 * Browser test of a companion-enabled build against a local fixture companion and an injected
 * EIP-6963 fixture wallet, at 390x844. Nothing touches a real chain or service.
 *   VITE_COMPANION_ORIGIN=https://companion.test npx vite build --outDir test/scratch/dist-companion --emptyOutDir
 *   IMD_PLAYWRIGHT=/path/to/playwright/index.mjs IMD_DIST=test/scratch/dist-companion node test/site/companion.e2e.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
const pw = await import(process.env.IMD_PLAYWRIGHT ?? "playwright");
const chromium = pw.chromium ?? pw.default.chromium;
const DIST = resolve(process.env.IMD_DIST ?? "test/scratch/dist-companion");
const PREFIX = "/ipfs/bafybeicompaniontest/";
const C = "https://companion.test";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const srv = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const rel = u.pathname.slice(PREFIX.length) || "index.html";
  try { const b = await readFile(join(DIST, rel)); res.writeHead(200, { "content-type": types[extname(rel)] ?? "application/octet-stream" }); res.end(b); } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}${PREFIX}`;
const EVENT = "openfootball:en.1:2025-26:2026-05-24:manchester-city-v-aston-villa";
const V = `${EVENT}@imd-sport-synth-1@2026-05-24T14:00:00Z`;
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), DEV = "0x" + "d1".repeat(20), RES = "0x" + "e2".repeat(20);
const H1 = "0x" + "01".repeat(32), H2 = "0x" + "02".repeat(32);

const results = []; let failed = 0;
const check = (name, ok, detail = "") => { const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`; results.push(line); console.error(line); if (!ok) failed++; };

/** Stateful fixture companion. */
function companion() {
  const st = { log: [], finalized: new Set(), entitled: new Set(), sessions: {}, legs: { developer: null, research: null } };
  const now = new Date().toISOString();
  const handle = (method, path, body, auth) => {
    st.log.push({ method, path, body });
    const me = st.sessions[auth];
    if (path === "/api/status") return [200, { checkout: { enabled: true, blockers: [], recipients: { developer: DEV, research: RES } }, token: { verified: true }, research: { activated: false, plannedRoles: 216, distinctContributors: 0, allocatedUnits: "0", authorizedUnits: "0", spentUnits: "0" }, feeds: { nhl: true, mma: true, football: true, nfl: false, nba: false, tennis: false } }];
    if (path === "/api/feeds/nhl") return [200, { sport: "nhl", status: "ok", observedUtc: now, events: [{ id: "sportradar:nhl:g1", sport: "nhl", competition: "NHL", startUtc: now, home: "Harbour Pike", away: "Ridge Owls", status: "live", score: [2, 1], decidedIn: null, outcomeModel: "two-way", observedUtc: now, sources: ["https://api.sportradar.com/nhl/trial/v7/en/games/2026/11/26/schedule.json"], freshnessSeconds: 12, corroboratedBy: [], availability: [] }],
      availability: { status: "ok", sources: ["https://api.sportradar.com/nhl/trial/v7/en/league/injuries.json"], reports: [{ id: "i1", player: "Skater Two", team: "Harbour Pike", kind: "withdrawal", status: "Out", detail: "Not Injury Related - Personal", source: "https://api.sportradar.com/nhl/trial/v7/en/league/injuries.json", observedUtc: now }] } }];
    if (path.startsWith("/api/feeds/")) return [200, { sport: path.slice(11), status: "unavailable", reason: "upstream 403 from api.sportradar.com (endpoint not licensed for this key)", observedUtc: now, events: [], availability: { status: "unavailable", reason: "not licensed", reports: [], sources: [] } }];
    if (path === "/api/siwe/nonce") return [200, { nonce: "fixturenonce123", domain: "127.0.0.1", chainId: 1 }];
    if (path === "/api/siwe/verify") { const addr = /0x[0-9a-fA-F]{40}/.exec(body.message)[0].toLowerCase(); const t = "tok-" + addr; st.sessions[t] = addr; return [200, { ok: true, token: t }]; }
    if (path === `/api/events/${encodeURIComponent(EVENT)}/predictions`) return [200, { eventId: EVENT, signedIn: !!me, checkout: { enabled: true, blockers: [] }, versions: [{ version: V, modelVersion: "imd-sport-synth-1", baseModel: "epl-elo-olog-1", cutoffUtc: "2026-05-24T14:00:00Z", outcomes: ["home", "draw", "away"], releasedAt: 1, purchasable: true, entitled: !!me && st.entitled.has(me), intent: me && !st.entitled.has(me) && (st.legs.developer || st.legs.research) ? { id: "intent-1", status: "partial" } : null }] }];
    if (path.startsWith("/api/predictions/")) { const v = decodeURIComponent(path.slice(17)); if (v !== V) return [404, { error: "unknown_prediction" }]; if (!me || !st.entitled.has(me)) return [402, { error: "not_entitled" }];
      return [200, { release: { version: V, cutoffUtc: "2026-05-24T14:00:00Z", outcomes: ["home", "draw", "away"], probabilities: [0.62, 0.21, 0.17], confidence: "medium", reasons: ["Fixture reason: home side rested"], counterarguments: ["Fixture counter: away form"], dataGaps: ["weather: challenge not accepted"], calibration: { temperature: 1.08, n: 380 }, evidence: [1, 2, 3] } }]; }
    if (!me) return [401, { error: "sign_in_required" }];
    if (path === "/api/intents") {
      if (body.predictionVersion !== V) return [409, { ok: false, error: "checkout_unavailable", blockers: ["prediction version is not a purchasable completed prediction"] }];
      if (st.entitled.has(me)) return [200, { ok: true, alreadyEntitled: true }];
      const legs = { developer: { recipient: DEV, ...(st.legs.developer ? { txHash: st.legs.developer, verifiedAt: 1 } : {}) }, research: { recipient: RES, ...(st.legs.research ? { txHash: st.legs.research, verifiedAt: 1 } : {}) } };
      const calls = ["developer", "research"].filter((k) => !st.legs[k]).map((k) => ({ leg: k, to: "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7", data: "0xa9059cbb" }));
      return [200, { ok: true, alreadyEntitled: false, intent: { id: "intent-1", legs }, calls }];
    }
    if (path === "/api/intents/intent-1/legs") {
      const leg = body.txHash === H1 ? "developer" : "research";
      if (!st.finalized.has(body.txHash)) return [409, { ok: false, error: "not_final", verified: [], pending: true }];
      if (st.legs[leg]) return [409, { ok: false, error: "duplicate_receipt", verified: [] }];
      st.legs[leg] = body.txHash; if (st.legs.developer && st.legs.research) st.entitled.add(me);
      return [200, { ok: true, verified: [leg], entitled: st.entitled.has(me) }];
    }
    if (path === "/api/me/history") return [200, { address: me, purchases: me === A.toLowerCase() ? [{ intentId: "h-a", predictionVersion: V, status: "paid", entitled: true, legs: [{ leg: "developer", explorer: "https://etherscan.io/tx/" + H1 }, { leg: "research", explorer: "https://etherscan.io/tx/" + H2 }] }] : [] }];
    return [404, { error: "not_found" }];
  };
  return { st, handle };
}

const WALLET = ({ A }) => {
  const listeners = {}; const emit = (e, v) => (listeners[e] ?? []).forEach((f) => f(v));
  window.__w = { account: A, chain: "0x1", sends: [], plan: [], chainChecks: 0 };
  const w = window.__w;
  const provider = {
    isFixture: true,
    on: (e, f) => { (listeners[e] ??= []).push(f); }, removeListener: (e, f) => { listeners[e] = (listeners[e] ?? []).filter((x) => x !== f); },
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts") { localStorage.setItem("__fixture_authorized", "1"); return [w.account]; }
      // Like a real wallet: no accounts until the user approves, and the approval survives a reload.
      if (method === "eth_accounts") return localStorage.getItem("__fixture_authorized") ? [w.account] : [];
      if (method === "eth_chainId") { w.chainChecks++; return w.chain; }
      if (method === "personal_sign") return "0x" + "11".repeat(65);
      if (method === "wallet_getCapabilities") throw Object.assign(new Error("unsupported"), { code: 4200 });
      if (method === "wallet_switchEthereumChain") { w.chain = params[0].chainId; emit("chainChanged", w.chain); return null; }
      if (method === "eth_sendTransaction") { w.sends.push({ chain: w.chain, params }); const next = w.plan.shift(); if (!next || next === "reject") throw Object.assign(new Error("User rejected the request."), { code: 4001 }); return next; }
      if (method === "wallet_revokePermissions" || method === "wallet_requestPermissions") return [];
      throw Object.assign(new Error("unsupported " + method), { code: 4200 });
    },
  };
  window.__emit = emit;
  const info = { uuid: "7c5b3e0a-0000-4000-8000-000000000001", name: "Fixture Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "test.fixture.wallet" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce); announce();
};

const browser = await chromium.launch();
async function newPage() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const co = companion(); const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(WALLET, { A });
  await page.route("**/*", async (route) => {
    const req = route.request(); const url = req.url();
    if (url.startsWith(C)) {
      const cors = { "access-control-allow-origin": new URL(base).origin, "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" };
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const u = new URL(url); const auth = (req.headers().authorization ?? "").replace(/^Bearer /, "");
      const [status, body] = co.handle(req.method(), u.pathname, req.postData() ? JSON.parse(req.postData()) : {}, auth);
      return route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
    }
    return url.startsWith(base.slice(0, base.indexOf(PREFIX))) ? route.continue() : route.abort();
  });
  return { page, co, errors };
}
const connect = async (page) => {
  await page.getByRole("button", { name: "Connect" }).click();
  try { await page.getByRole("button", { name: /Fixture Wallet/ }).click({ timeout: 8000 }); }
  catch (e) { console.log("dialog:", await page.evaluate(() => document.querySelector("dialog")?.outerHTML.replace(/<svg.*?<\/svg>/g, "").slice(0, 900))); throw e; }
  await page.getByRole("button", { name: /Disconnect/ }).waitFor();
};

// 1. Licensed feed views request and render feed data; the archive stays when the feed is unavailable.
{
  const { page, co, errors } = await newPage();
  await page.goto(base + "#/sport/nhl/live"); await page.locator(".feed li").first().waitFor();
  check("nhl live requests /api/feeds/nhl", co.st.log.filter((l) => l.path === "/api/feeds/nhl").length >= 1);
  check("nhl live renders the returned event with score, source and freshness", (await page.locator(".feed li").count()) === 1 && /Harbour Pike\s*2–1\s*Ridge Owls/.test(await page.locator(".feed li").innerText()) && (await page.locator(".feed li").innerText()).includes("12 s old"));
  check("nhl header no longer claims no feed", !(await page.locator(".sport-head").innerText()).includes("No licensed live feed"));
  await page.getByRole("tab", { name: "Injuries and availability" }).click(); await page.locator("table.tbl").waitFor();
  check("nhl availability renders a withdrawal, not an injury", (await page.locator("table.tbl").innerText()).includes("Withdrawal, no injury reported"));
  await page.goto(base + "#/sport/mma/live"); await page.getByText(/The companion reports: upstream 403/).waitFor();
  check("mma unavailable feed shows the companion's reason", true);
  await page.goto(base + "#/sport/football/upcoming"); await page.getByRole("heading", { name: /Scheduled in the September 2026 snapshot/ }).waitFor();
  const firstRow = await page.locator(".fixtures").first().locator("li").first().innerText();
  check("football upcoming falls back to future snapshot fixtures first", /Scheduled/.test(firstRow) && !/Stale/.test(firstRow), firstRow.replace(/\s+/g, " "));
  check("no page errors (feeds)", errors.length === 0, errors.join(" | "));
  await page.close();
}

// 2 + 9. Buy the released version; an interrupted, pending first transfer is reconciled, never re-requested.
{
  const { page, co, errors } = await newPage();
  await page.goto(base + `#/match/${encodeURIComponent(EVENT)}`); await connect(page);
  await page.getByRole("button", { name: "Review the purchase" }).click();
  await page.getByRole("button", { name: "Pay 1 IMD" }).waitFor();
  const intentPost = co.st.log.find((l) => l.path === "/api/intents");
  check("intent request sends the released compound version", intentPost?.body.predictionVersion === V, intentPost?.body.predictionVersion);
  await page.evaluate((h) => { window.__w.plan = [h, "reject"]; }, H1);
  await page.getByRole("button", { name: "Pay 1 IMD" }).click();
  await page.getByRole("button", { name: "Pay the missing 0.5 IMD" }).waitFor();
  const legPosts = () => co.st.log.filter((l) => l.path === "/api/intents/intent-1/legs");
  check("pending first transfer was submitted for verification", legPosts().length >= 1 && legPosts().every((l) => l.body.txHash === H1));
  check("after rejecting the second, only the missing leg is offered", (await page.getByRole("button", { name: "Pay 1 IMD" }).count()) === 0 && (await page.getByText("Sent, waiting for finality").count()) === 1);
  check("the broadcast hash is persisted against the intent", (await page.evaluate(() => localStorage.getItem("imd-sport-pending:intent-1"))) === JSON.stringify({ developer: "0x" + "01".repeat(32) }));
  check("chain re-checked before each transfer request", (await page.evaluate(() => window.__w.chainChecks)) >= 2);
  co.st.finalized.add(H1); co.st.finalized.add(H2);
  const before = legPosts().length;
  await page.getByRole("button", { name: "Check the sent transfer again" }).click();
  await page.getByText("Verified").first().waitFor();
  check("check again re-verifies the same hash", legPosts().length === before + 1 && legPosts().at(-1).body.txHash === H1);
  await page.evaluate((h) => { window.__w.plan = [h]; }, H2);
  await page.getByRole("button", { name: "Pay the missing 0.5 IMD" }).click();
  try { await page.getByText("Fixture reason: home side rested").waitFor({ timeout: 10000 }); }
  catch (e) { console.error("panel:", (await page.locator("main section.card").nth(2).innerText()).slice(0, 600), JSON.stringify(co.st.log.slice(-6))); throw e; }
  check("entitled synthesis fetched from /api/predictions/", co.st.log.some((l) => l.path.startsWith("/api/predictions/")));
  check("two transfers broadcast plus the one the buyer rejected; the first was never requested again", JSON.stringify(await page.evaluate(() => window.__w.sends.map((x) => x.params[0].to + ":" + x.chain))) === JSON.stringify(Array(3).fill("0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7:0x1")));
  const intentsBefore = co.st.log.filter((l) => l.path === "/api/intents").length;
  const nlog = co.st.log.length;
  await page.reload();
  try { await page.getByText("Fixture reason: home side rested").waitFor({ timeout: 10000 }); }
  catch (e) { console.error("after reload:", (await page.locator("main").innerText()).slice(-500), JSON.stringify(co.st.log.slice(nlog)), await page.evaluate(() => sessionStorage.getItem("imd-sport-session"))); throw e; }
  check("reopening shows the synthesis with no new intent and no transfer", co.st.log.filter((l) => l.path === "/api/intents").length === intentsBefore && (await page.evaluate(() => window.__w.sends.length)) === 0);
  check("no page errors (purchase)", errors.length === 0, errors.join(" | "));
  await page.close();
}

// 10. Wrong chain shows Switch to Ethereum and no transfer can be requested; history is bound to the address.
{
  const { page, co, errors } = await newPage();
  await page.goto(base + "#/account"); await connect(page);
  await page.getByRole("button", { name: "Sign in with Ethereum" }).click(); await page.locator("table.tbl tbody tr").waitFor();
  check("account A sees its history row", (await page.locator("table.tbl tbody tr").count()) === 1);
  await page.evaluate((b) => { window.__w.account = b; window.__emit("accountsChanged", [b]); }, B);
  await page.getByRole("button", { name: "Sign in with Ethereum" }).waitFor();
  check("switching to account B drops A's history and asks for a new sign-in", (await page.locator("table.tbl tbody tr").count()) === 0 && (await page.evaluate(() => sessionStorage.getItem("imd-sport-session"))) === null);
  await page.evaluate(() => { window.__w.chain = "0x2105"; window.__emit("chainChanged", "0x2105"); });
  await page.getByRole("button", { name: "Switch to Ethereum" }).waitFor();
  check("Base chain renders Switch to Ethereum", (await page.getByRole("button", { name: "Switch to Ethereum" }).count()) === 1);
  await page.getByRole("button", { name: "Switch to Ethereum" }).click(); await page.getByRole("button", { name: /Disconnect/ }).waitFor();
  check("switch returns the wallet to Ethereum", (await page.evaluate(() => window.__w.chain)) === "0x1");
  check("no transfers requested on the wrong chain", (await page.evaluate(() => window.__w.sends.length)) === 0);
  check("no page errors (scope)", errors.length === 0, errors.join(" | "));
  await page.close();
}

// 11. The connect sheet keeps focus inside and returns it to Connect.
{
  const { page } = await newPage();
  await page.goto(base);
  await page.getByRole("button", { name: "Connect" }).click();
  const inside = [];
  for (let i = 0; i < 6; i++) { await page.keyboard.press("Tab"); inside.push(await page.evaluate(() => { const el = document.activeElement; return !el || el === document.body ? "chrome" : el.closest("dialog") ? "dialog" : "background:" + el.textContent; })); }
  // Native modal: the page behind is inert, so Tab cycles through the sheet and the browser's own UI only.
  check("Tab never reaches the page behind the open dialog", inside.every((x) => x === "dialog" || x === "chrome") && inside.includes("dialog"), inside.join(","));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(50);
  check("Escape returns focus to Connect", (await page.evaluate(() => document.activeElement?.textContent)) === "Connect");
  await page.close();
}

await browser.close(); srv.close();
console.log(results.join("\n")); console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
