/**
 * Forecast records for releases. A release is bound to the validated model's forecast recorded here
 * for that exact event and cutoff; calibration reads earlier records with known outcomes.
 *
 * The only validated model is the EPL pilot (scripts/backtest.ts, epl-elo-olog-1). Its archive walk
 * gives a pre-match forecast for every EPL fixture in the pinned openfootball archive, made from
 * ratings that saw only earlier results, so the archive can be recorded as forecasts of the release
 * pipeline with no accepted adjustments (adjusted = base), each with its eventual result.
 */
import { load, walk, run } from "../../scripts/backtest.ts";
import type { Store } from "./store.ts";
import { forecastKey, MODEL_VERSION, MODELS, type Forecast } from "./swarm.ts";

const OUT = { H: 0, D: 1, A: 2 } as const;
/** Forecasts are made one hour before kickoff in the archive walk. */
export const archiveCutoff = (kickoffUtc: string) => new Date(Date.parse(kickoffUtc) - 3600_000).toISOString().replace(".000Z", "Z");

export function recordForecast(store: Store, f: Forecast) {
  if (f.sport !== "football" || f.baseModel !== MODELS.football.version) throw new Error("only the validated EPL model records forecasts");
  if (!(f.cutoffUtc <= f.kickoffUtc)) throw new Error("a forecast must be cut off before kickoff");
  store.tx((db) => { db.forecasts[forecastKey(f.eventId, f.cutoffUtc, f.baseModel)] = f; });
}
export function recordOutcome(store: Store, eventId: string, outcome: 0 | 1 | 2) {
  store.tx((db) => { for (const f of Object.values(db.forecasts as Record<string, Forecast>)) if (f.eventId === eventId) f.outcome = outcome; });
}

/** Record every archive fixture's pre-match forecast (and result, when played). Idempotent. */
export function backfillEplArchive(store: Store, root?: string) {
  const params = run(root).model.params;
  const { rows } = walk(load(root), params);
  const version = MODELS.football.version;
  let n = 0;
  store.tx((db) => {
    for (const r of rows) {
      const cutoffUtc = archiveCutoff(r.kickoffUtc);
      db.forecasts[forecastKey(r.id, cutoffUtc, version)] = { eventId: r.id, sport: "football", competition: "en.1", kickoffUtc: r.kickoffUtc, cutoffUtc, baseModel: version, p: r.p, pipeline: MODEL_VERSION, adjusted: r.p, outcome: r.result ? OUT[r.result] : null } satisfies Forecast;
      n++;
    }
  });
  return { recorded: n, withOutcome: rows.filter((r) => r.result).length };
}
