/**
 * Reproducible EPL pilot backtest from the pinned openfootball/football.json archive (CC0).
 *
 *   node scripts/backtest.ts          regenerate src/data/epl.json
 *   node scripts/backtest.ts --check  fail if the committed file differs from a fresh run
 *
 * Chronology: 2022-23 + 2023-24 train the Elo/ordered-logit parameters, 2024-25 fits a
 * temperature on the trained model (calibration), 2025-26 is held out and scored once.
 * Every probability is computed from ratings that only saw earlier matches.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = {
  repo: "https://github.com/openfootball/football.json",
  commit: "e6744429ee395bc86f247348c6184bb08d4eb361",
  commitDate: "2026-09-22T09:33:49Z",
  license: "CC0 1.0 Universal (public domain dedication)",
  licenseUrl: "https://github.com/openfootball/football.json/blob/e6744429ee395bc86f247348c6184bb08d4eb361/LICENSE.md",
};
export const SEASONS = ["2022-23", "2023-24", "2024-25", "2025-26", "2026-27"] as const;
const TRAIN = ["2022-23", "2023-24"], CALIB = "2024-25", HOLDOUT = "2025-26", SNAPSHOT = "2026-27";

type Raw = { round: string; date: string; time?: string; team1: string; team2: string; score?: { ft?: [number, number]; ht?: [number, number] } };
export type Outcome = "H" | "D" | "A";
export type Row = {
  id: string; season: string; round: string; kickoffUtc: string; home: string; away: string;
  p: [number, number, number]; result: Outcome | null; ft: [number, number] | null;
  eloHome: number; eloAway: number;
};

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const sig = (x: number) => 1 / (1 + Math.exp(-x));
const slug = (t: string) => t.toLowerCase().replace(/ fc$| afc$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** openfootball times are UK local; convert to UTC (BST last Sun Mar to last Sun Oct, 01:00 UTC). */
function ukToUtc(date: string, time = "15:00"): string {
  const [y, m, d] = date.split("-").map(Number);
  const lastSun = (mon: number) => { const t = new Date(Date.UTC(y, mon + 1, 0)); return t.getUTCDate() - t.getUTCDay(); };
  const bst = (m > 3 && m < 10) || (m === 3 && d >= lastSun(2)) || (m === 10 && d < lastSun(9));
  const [hh, mm] = time.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - (bst ? 1 : 0), mm)).toISOString().replace(".000Z", "Z");
}

export function load(root = ROOT) {
  const files: Record<string, { sha256: string; url: string; matches: Raw[]; name: string }> = {};
  for (const s of SEASONS) {
    const buf = readFileSync(join(root, "data/openfootball", `en.${s}.json`));
    const j = JSON.parse(buf.toString("utf8"));
    files[s] = { sha256: createHash("sha256").update(buf).digest("hex"), url: `https://raw.githubusercontent.com/openfootball/football.json/${SOURCE.commit}/${s}/en.1.json`, matches: j.matches, name: j.name };
  }
  return files;
}

type Params = { K: number; HFA: number; S: number; theta: number };
function probs(rh: number, ra: number, P: Params): [number, number, number] {
  const x = (rh + P.HFA - ra) / P.S;
  const h = sig(x - P.theta), a = sig(-x - P.theta);
  return [h, Math.max(1e-6, 1 - h - a), a];
}

/** Walk every season in order, emitting pre-match probabilities, updating ratings after each result. */
export function walk(files: ReturnType<typeof load>, P: Params) {
  const elo = new Map<string, number>();
  const rows: Row[] = [];
  for (const s of SEASONS) {
    const ms = [...files[s].matches].sort((a, b) => (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")) || a.team1.localeCompare(b.team1));
    // promoted sides enter below the established mean
    for (const m of ms) for (const t of [m.team1, m.team2]) if (!elo.has(t)) elo.set(t, elo.size < 20 ? 1500 : 1440);
    for (const m of ms) {
      const rh = elo.get(m.team1)!, ra = elo.get(m.team2)!;
      const p = probs(rh, ra, P);
      const ft = m.score?.ft ?? null;
      const result: Outcome | null = ft ? (ft[0] > ft[1] ? "H" : ft[0] < ft[1] ? "A" : "D") : null;
      rows.push({ id: `openfootball:en.1:${s}:${m.date}:${slug(m.team1)}-v-${slug(m.team2)}`, season: s, round: m.round, kickoffUtc: ukToUtc(m.date, m.time), home: m.team1, away: m.team2, p, result, ft, eloHome: Math.round(rh), eloAway: Math.round(ra) });
      if (ft) {
        const exp = 1 / (1 + 10 ** (-(rh + P.HFA - ra) / 400));
        const act = result === "H" ? 1 : result === "D" ? 0.5 : 0;
        const gd = Math.abs(ft[0] - ft[1]);
        const mult = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
        const delta = P.K * mult * (act - exp);
        elo.set(m.team1, rh + delta); elo.set(m.team2, ra - delta);
      }
    }
  }
  return { rows, elo };
}

const idx = (o: Outcome) => (o === "H" ? 0 : o === "D" ? 1 : 2);
export function temper(p: number[], T: number): [number, number, number] {
  const e = p.map((x) => Math.pow(x, 1 / T)); const z = e[0] + e[1] + e[2];
  return [e[0] / z, e[1] / z, e[2] / z];
}
export function metrics(rows: { p: number[]; result: Outcome | null }[]) {
  const scored = rows.filter((r) => r.result);
  let brier = 0, ll = 0, hit = 0;
  for (const r of scored) {
    const k = idx(r.result!);
    brier += r.p.reduce((s, x, i) => s + (x - (i === k ? 1 : 0)) ** 2, 0);
    ll += -Math.log(Math.max(r.p[k], 1e-12));
    const top = r.p.indexOf(Math.max(...r.p)); if (top === k) hit++;
  }
  const n = scored.length || 1;
  return { n: scored.length, brier: r6(brier / n), logLoss: r6(ll / n), accuracy: r6(hit / n) };
}
export function reliability(rows: { p: number[]; result: Outcome | null }[], bins = 10) {
  const b = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, sumP: 0, hits: 0 }));
  for (const r of rows) if (r.result) r.p.forEach((x, i) => { const j = Math.min(bins - 1, Math.floor(x * bins)); b[j].n++; b[j].sumP += x; if (i === idx(r.result!)) b[j].hits++; });
  return b.map((x) => ({ lo: r6(x.lo), hi: r6(x.hi), n: x.n, meanPredicted: x.n ? r6(x.sumP / x.n) : null, observed: x.n ? r6(x.hits / x.n) : null }));
}

export function run(root = ROOT) {
  const files = load(root);
  // 1. training: grid search on the two training seasons, skipping the first 8 matchdays as warm-up
  let best: { P: Params; ll: number } | null = null;
  for (const K of [12, 16, 20, 24, 28]) for (const HFA of [30, 50, 70]) for (const S of [140, 180, 220, 260]) for (const theta of [0.35, 0.45, 0.55, 0.65, 0.75]) {
    const P = { K, HFA, S, theta };
    const tr = walk(files, P).rows.filter((r) => TRAIN.includes(r.season) && !(r.season === "2022-23" && Number(r.round.replace(/\D/g, "")) <= 8));
    const m = metrics(tr);
    if (!best || m.logLoss < best.ll) best = { P, ll: m.logLoss };
  }
  const P = best!.P;
  const { rows, elo } = walk(files, P);
  const train = rows.filter((r) => TRAIN.includes(r.season) && r.result);
  const calib = rows.filter((r) => r.season === CALIB && r.result);
  // 2. calibration: a single temperature fitted on 2024-25 only
  let T = 1, bestLL = Infinity;
  for (let t = 0.6; t <= 1.6001; t += 0.02) { const ll = metrics(calib.map((r) => ({ ...r, p: temper(r.p, t) }))).logLoss; if (ll < bestLL) { bestLL = ll; T = Math.round(t * 100) / 100; } }
  // 3. held-out evaluation on 2025-26
  const holdAll = rows.filter((r) => r.season === HOLDOUT);
  const hold = holdAll.filter((r) => r.result).map((r) => ({ ...r, p: temper(r.p, T).map(r6) as [number, number, number] }));
  const seen = [...train, ...calib];
  const freq = (["H", "D", "A"] as Outcome[]).map((o) => seen.filter((r) => r.result === o).length / seen.length) as [number, number, number];
  const base = hold.map((r) => ({ ...r, p: freq }));
  const snapRows = rows.filter((r) => r.season === SNAPSHOT).map((r) => ({ ...r, p: temper(r.p, T).map(r6) as [number, number, number] }));
  const pick = hold.filter((r) => r.round === hold[hold.length - 1].round);
  const featured = pick.sort((a, b) => (b.eloHome + b.eloAway) - (a.eloHome + a.eloAway))[0];
  const form = (team: string, before: string) => rows.filter((r) => r.result && r.kickoffUtc < before && (r.home === team || r.away === team)).slice(-5)
    .map((r) => (r.result === "D" ? "D" : (r.result === "H") === (r.home === team) ? "W" : "L")).join("");
  const h2h = rows.filter((r) => r.result && r.kickoffUtc < featured.kickoffUtc && ((r.home === featured.home && r.away === featured.away) || (r.home === featured.away && r.away === featured.home)))
    .map((r) => ({ id: r.id, kickoffUtc: r.kickoffUtc, home: r.home, away: r.away, ft: r.ft }));
  const compact = (r: Row) => ({ id: r.id, season: r.season, round: r.round, kickoffUtc: r.kickoffUtc, home: r.home, away: r.away, p: r.p.map(r6), result: r.result, ft: r.ft, eloHome: r.eloHome, eloAway: r.eloAway });
  return {
    schema: 1,
    generatedBy: "scripts/backtest.ts",
    scope: "English Premier League only. These results support EPL claims and nothing else.",
    source: { ...SOURCE, files: Object.fromEntries(SEASONS.map((s) => [s, { url: files[s].url, sha256: files[s].sha256, name: files[s].name, matches: files[s].matches.length, withResult: files[s].matches.filter((m) => m.score?.ft).length }])) },
    asOf: SOURCE.commitDate,
    model: { name: "Elo with ordered-logit draw band, temperature-calibrated", version: "epl-elo-olog-1", params: P, temperature: T },
    splits: {
      training: { seasons: TRAIN, matches: train.length },
      calibration: { seasons: [CALIB], matches: calib.length },
      heldOut: { seasons: [HOLDOUT], matches: hold.length, excludedNoResult: holdAll.length - hold.length },
    },
    baseline: { name: "Outcome frequency from training and calibration seasons", p: freq.map(r6) },
    metrics: {
      heldOut: { model: metrics(hold), modelUncalibrated: metrics(holdAll.filter((r) => r.result)), baseline: metrics(base) },
      calibration: { model: metrics(calib.map((r) => ({ ...r, p: temper(r.p, T) }))), baseline: metrics(calib.map((r) => ({ ...r, p: freq }))) },
    },
    reliability: { heldOut: reliability(hold), baselineHeldOut: reliability(base) },
    featured: { ...compact(featured), formHome: form(featured.home, featured.kickoffUtc), formAway: form(featured.away, featured.kickoffUtc), h2h },
    heldOut: hold.map(compact),
    snapshot: { season: SNAPSHOT, asOf: SOURCE.commitDate, fixtures: snapRows.map(compact) },
    ratings: [...elo.entries()].filter(([t]) => snapRows.some((r) => r.home === t || r.away === t)).map(([team, r]) => ({ team, elo: Math.round(r) })).sort((a, b) => b.elo - a.elo),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(ROOT, "src/data/epl.json");
  const text = JSON.stringify(run(), null, 0) + "\n";
  if (process.argv.includes("--check")) {
    if (!existsSync(out) || readFileSync(out, "utf8") !== text) { console.error("src/data/epl.json does not match a fresh backtest run; run `npm run backtest`"); process.exit(1); }
    console.log("backtest reproduced: src/data/epl.json matches");
  } else { writeFileSync(out, text); console.log("wrote", out); }
}
