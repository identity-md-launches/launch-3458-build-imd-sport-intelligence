import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { loadConfig, checkoutBlockers, IMD_TOKEN, LEG_UNITS, type OperatorConfig } from "./config.ts";
import { Store } from "./store.ts";
import { httpReader, type ChainReader } from "./rpc.ts";
import { issueNonce, verifySignIn, sessionFor, signOut } from "./siwe.ts";
import { openIntent, submitLeg, historyFor, isEntitled, verifierHealthy } from "./payments.ts";
import { verifyToken } from "./verify-token.ts";
import { eventsFor, sportradarAdapter, apiSportsAdapter, type FeedAdapter, type Sport } from "./feeds.ts";
import { distinctContributors, balance } from "./swarm.ts";

export type Deps = { cfg: OperatorConfig; store: Store; reader: ChainReader; feeds: FeedAdapter[]; tokenVerified: () => Promise<boolean> };

const SPORTS = new Set(["mma", "nhl", "nfl", "nba", "football", "tennis"]);

async function body(req: IncomingMessage): Promise<any> {
  let s = ""; for await (const c of req) { s += c; if (s.length > 64_000) throw new Error("too large"); }
  return s ? JSON.parse(s) : {};
}

export function handler(d: Deps) {
  const { cfg, store, reader } = d;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const origin = String(req.headers.origin ?? "");
    const send = (code: number, data: unknown) => {
      const h: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store", vary: "Origin" };
      if (cfg.allowedOrigin && origin === cfg.allowedOrigin) Object.assign(h, { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" });
      res.writeHead(code, h); res.end(JSON.stringify(data));
    };
    try {
      if (req.method === "OPTIONS") return send(204, {});
      if (origin && origin !== cfg.allowedOrigin) return send(403, { error: "origin_not_allowed" });
      const url = new URL(req.url ?? "/", "http://operator");
      const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "") || undefined;
      const me = sessionFor(store, token);
      const p = url.pathname;
      if (p === "/api/status" && req.method === "GET") {
        const tv = await d.tokenVerified(); const vh = await verifierHealthy(reader, cfg);
        const blockers = checkoutBlockers(cfg, vh, tv);
        const b = balance(store);
        return send(200, { checkout: { enabled: blockers.length === 0, blockers, priceUnits: (LEG_UNITS * 2n).toString(), legUnits: LEG_UNITS.toString(), recipients: blockers.length ? null : { developer: cfg.developerRecipient, research: cfg.researchRecipient } },
          token: { ...IMD_TOKEN, verified: tv }, research: { activated: cfg.researchActivated, ...distinctContributors(store), allocatedUnits: b.allocatedUnits.toString(), authorizedUnits: b.authorizedUnits.toString(), spentUnits: b.spentUnits.toString() },
          feeds: Object.fromEntries([...SPORTS].map((s) => [s, d.feeds.some((f) => f.sports.includes(s as Sport))])) });
      }
      if (p === "/api/siwe/nonce" && req.method === "GET") return send(200, { nonce: issueNonce(store, cfg), domain: cfg.siweDomain, chainId: cfg.chainId });
      if (p === "/api/siwe/verify" && req.method === "POST") { const b = await body(req); const r = await verifySignIn(store, cfg, String(b.message), b.signature, origin); return send(r.ok ? 200 : 401, r); }
      if (p === "/api/signout" && req.method === "POST") { if (token) signOut(store, token); return send(200, { ok: true }); }
      const fm = p.match(/^\/api\/feeds\/([a-z]+)$/);
      if (fm && SPORTS.has(fm[1])) return send(200, await eventsFor(fm[1] as Sport, d.feeds));
      const pm = p.match(/^\/api\/predictions\/(.+)$/);
      if (pm && req.method === "GET") {
        const v = decodeURIComponent(pm[1]); const rec = store.db.premium[v] as { release: unknown } | undefined;
        if (!rec) return send(404, { error: "unknown_prediction" });
        if (!isEntitled(store, me?.address ?? null, v)) return send(402, { error: "not_entitled", purchasable: true });
        return send(200, rec);
      }
      if (!me) return send(401, { error: "sign_in_required" });
      if (p === "/api/intents" && req.method === "POST") {
        const b = await body(req);
        const r = await openIntent(store, cfg, reader, me.address, String(b.predictionVersion), (v) => !!store.db.premium[v], await d.tokenVerified());
        return send(r.ok ? 200 : 409, r);
      }
      const lm = p.match(/^\/api\/intents\/([0-9a-f-]+)\/legs$/);
      if (lm && req.method === "POST") { const b = await body(req); const r = await submitLeg(store, cfg, reader, me.address, lm[1], String(b.txHash)); return send(r.ok ? 200 : 409, r); }
      if (p === "/api/me/history" && req.method === "GET") return send(200, { address: me.address, purchases: historyFor(store, me.address) });
      return send(404, { error: "not_found" });
    } catch (e) { return send(400, { error: "bad_request", detail: String((e as Error).message) }); }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = loadConfig();
  const reader = httpReader(cfg.rpcUrl);
  const feeds: FeedAdapter[] = [];
  if (cfg.feedKeys.sportradar) feeds.push(sportradarAdapter(cfg.feedKeys.sportradar));
  if (cfg.feedKeys.apisports) feeds.push(apiSportsAdapter(cfg.feedKeys.apisports));
  let tv: boolean | null = null;
  const deps: Deps = { cfg, store: new Store(cfg.dataDir), reader, feeds, tokenVerified: async () => (tv ??= (await verifyToken(reader)).ok) };
  createServer(handler(deps)).listen(cfg.port, () => console.log(`imd-sport operator on :${cfg.port}, origin ${cfg.allowedOrigin || "(unset: checkout disabled)"}`));
}
