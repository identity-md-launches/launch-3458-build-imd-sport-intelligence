/**
 * Browser test of the committed export under an IPFS-gateway-style subpath, at 390 and 1440 wide.
 *   IMD_PLAYWRIGHT=/path/to/playwright/index.mjs node test/site/gateway.e2e.mjs
 * Serves dist/ at /ipfs/<cid>/ (no rewrites), blocks every request off that origin, and walks the
 * primary interactions. Exits non-zero on any failure.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
const pw = await import(process.env.IMD_PLAYWRIGHT ?? "playwright");
const chromium = pw.chromium ?? pw.default.chromium;
const DIST = new URL("../../dist/", import.meta.url).pathname;
const PREFIX = "/ipfs/bafybeigatewaysubpathtest/";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const srv = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (!u.pathname.startsWith(PREFIX)) { res.writeHead(404); return res.end(); }
  const rel = u.pathname.slice(PREFIX.length) || "index.html";
  try { const b = await readFile(join(DIST, rel)); res.writeHead(200, { "content-type": types[extname(rel)] ?? "application/octet-stream" }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}${PREFIX}`;
const browser = await chromium.launch();
const results = []; let failed = 0;
const check = (name, ok, detail = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); if (!ok) failed++; };
for (const width of [390, 1440]) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
  const errors = [], bad = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route("**/*", (route) => (route.request().url().startsWith(`http://127.0.0.1:${srv.address().port}/`) ? route.continue() : route.abort()));
  page.on("response", (r) => r.status() >= 400 && bad.push(`${r.status()} ${r.url()}`));
  await page.goto(base, { waitUntil: "networkidle" });
  const w = `[${width}]`;
  const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${w} home renders title`, (await page.title()).includes("IMD Sport"));
  const cta = page.getByRole("link", { name: "Open the analysis" });
  const box = await cta.boundingBox();
  check(`${w} featured match and main action in first viewport`, !!box && box.y + box.height <= (width === 390 ? 844 : 900), box ? `cta bottom ${Math.round(box.y + box.height)}px` : "no cta");
  check(`${w} no horizontal overflow on home`, (await overflow()) <= 0);
  await cta.click();
  await page.waitForSelector("text=Event ID");
  check(`${w} match page shows result, probabilities, source`, (await page.locator("text=Event ID").count()) > 0 && (await page.locator(".tag", { hasText: "Result" }).count()) > 0);
  check(`${w} no payment request with companion empty`, (await page.locator("text=Purchases are off in this release.").count()) === 1 && (await page.getByRole("button", { name: /Pay|Review the purchase/ }).count()) === 0);
  await page.goto(base + "#/accuracy");
  await page.waitForSelector("text=EPL accuracy report");
  const before = await page.locator("p[role=status]").textContent();
  await page.selectOption("select >> nth=0", { label: "Arsenal" });
  const after = await page.locator("p[role=status]").textContent();
  check(`${w} accuracy team filter changes rows`, before !== after, `${before} -> ${after}`);
  await page.getByRole("button", { name: "Baseline" }).click();
  check(`${w} reliability toggle`, (await page.getByRole("button", { name: "Baseline" }).getAttribute("aria-pressed")) === "true");
  check(`${w} no horizontal overflow on accuracy`, (await overflow()) <= 0);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download the backtest data" }).click()]);
  check(`${w} backtest download`, dl.suggestedFilename() === "imd-sport-epl-backtest.json");
  for (const s of ["mma", "nhl", "nfl", "nba", "football", "tennis"]) {
    await page.goto(base + `#/sport/${s}/live`);
    await page.waitForSelector(".tabs");
    const unavailable = await page.locator(".badge.b-unavailable").count();
    check(`${w} ${s} live view states unavailable feed`, unavailable > 0);
  }
  await page.goto(base + "#/sport/football/upcoming"); await page.waitForSelector(".fixtures");
  check(`${w} football snapshot fixtures marked stale or scheduled`, (await page.locator(".fixtures .b-stale, .fixtures .b-scheduled").count()) > 0);
  await page.goto(base + "#/sport/nhl/research"); await page.waitForSelector("text=distinct contributors evidenced");
  check(`${w} research shows planned roles apart from contributors`, (await page.locator(".tbl tbody tr").count()) === 12);
  await page.goto(base + "#/account"); await page.waitForSelector("text=History is off in this release.");
  check(`${w} signed-out history explains activation`, true);
  await page.goto(base + "#/activation"); await page.waitForSelector("text=Payment token");
  check(`${w} activation lists token address`, (await page.locator("text=0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7").count()) > 0);
  await page.goto(base); await page.getByRole("button", { name: "Connect" }).click();
  check(`${w} connect sheet opens`, await page.getByRole("dialog", { name: "Connect a wallet" }).isVisible());
  await page.keyboard.press("Escape");
  check(`${w} connect sheet closes on Escape`, (await page.getByRole("dialog").count()) === 0);
  check(`${w} no console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
  check(`${w} no failed local requests`, bad.length === 0, bad.slice(0, 3).join(" | "));
  await page.close();
}
await browser.close(); srv.close();
console.log(results.join("\n")); console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
