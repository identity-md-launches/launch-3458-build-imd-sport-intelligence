/**
 * Operator entry point for Swarm research. Dispatch is explicit and budgeted; collection can also run
 * on a timer inside the server (IMD_SPORT_COLLECT_EVERY seconds).
 *
 *   node operator/src/research.ts dispatch --sport football --event <id> --cutoff <iso> --evidence evidence.json [--phase research] [--max 12]
 *   node operator/src/research.ts collect [--event <id>]
 *   node operator/src/research.ts status
 *
 * Needs IMD_SPORT_RESEARCH_ACTIVE=1, IMD_PAID_TOKEN and IMD_SWARM_SIGNER_KEY (operator secrets).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, type OperatorConfig } from "./config.ts";
import { Store } from "./store.ts";
import { httpSwarmApi, planWave, dispatchWave, collect, invalidate, balance, distinctContributors, PHASES, type SwarmApi, type Evidence, type Phase } from "./swarm.ts";
import { swarmPayer } from "./x402.ts";
import type { Sport } from "./feeds.ts";

export function swarmFromEnv(cfg: OperatorConfig, env: Record<string, string | undefined> = process.env): SwarmApi | null {
  const key = env.IMD_SWARM_SIGNER_KEY ?? "";
  if (!cfg.researchActivated || !cfg.imdPaidToken || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  return httpSwarmApi(cfg, swarmPayer(privateKeyToAccount(key as `0x${string}`), Number(env.IMD_SWARM_CHAIN_ID ?? 1)));
}

/** One event: drop work whose evidence changed, then dispatch each phase whose prior phase is accepted. */
export async function runEvent(store: Store, cfg: OperatorConfig, api: SwarmApi, o: { sport: Sport; eventId: string; cutoffUtc: string; evidence: Evidence[]; evidenceTime: string; phases?: Phase[]; maxRoles?: number }) {
  const invalidated = invalidate(store, o.eventId, o.evidence);
  const waves = [];
  for (const phase of o.phases ?? PHASES) {
    const plan = planWave(store, o.sport, o.eventId, phase, o.evidenceTime, o.cutoffUtc, o.maxRoles ?? 12);
    const d = await dispatchWave(store, cfg, api, plan, o.evidence);
    waves.push({ phase, planned: plan.roles.length, reused: plan.reused.length, waiting: plan.waitingOnPriorPhase.length, skippedForBudget: plan.skippedForBudget.length, ...d });
  }
  return { invalidated, waves };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const cfg = loadConfig(env); const store = new Store(cfg.dataDir);
  const arg = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const show = (x: unknown) => console.log(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  if (argv[0] === "status") return show({ activated: cfg.researchActivated, ...distinctContributors(store), ...balance(store) });
  const api = swarmFromEnv(cfg, env);
  if (!api) { console.error("research is not activated: set IMD_SPORT_RESEARCH_ACTIVE=1, IMD_PAID_TOKEN and IMD_SWARM_SIGNER_KEY"); process.exitCode = 2; return; }
  if (argv[0] === "collect") return show(await collect(store, api, arg("event")));
  if (argv[0] === "dispatch") {
    const evidence = JSON.parse(readFileSync(arg("evidence")!, "utf8")) as Evidence[];
    const evidenceTime = evidence.map((e) => e.observedUtc).sort().at(-1) ?? arg("cutoff")!;
    return show(await runEvent(store, cfg, api, { sport: arg("sport") as Sport, eventId: arg("event")!, cutoffUtc: arg("cutoff")!, evidence, evidenceTime, phases: arg("phase") ? [arg("phase") as Phase] : undefined, maxRoles: Number(arg("max") ?? 12) }));
  }
  console.error("usage: research.ts dispatch|collect|status"); process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
