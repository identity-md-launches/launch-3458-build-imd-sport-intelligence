import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run } from "../../scripts/backtest.ts";

test("historical metrics reproduce from the pinned archive", () => {
  const fresh = run(); const committed = JSON.parse(readFileSync(new URL("../../src/data/epl.json", import.meta.url), "utf8"));
  assert.deepEqual(fresh.metrics, committed.metrics); assert.deepEqual(fresh.reliability, committed.reliability);
  assert.equal(fresh.splits.training.matches, 760); assert.equal(fresh.splits.calibration.matches, 380);
  assert.ok(fresh.metrics.heldOut.model.brier < fresh.metrics.heldOut.baseline.brier);
  assert.ok(fresh.heldOut.every((r: any) => r.kickoffUtc.startsWith("2025") || r.kickoffUtc.startsWith("2026")));
  for (const [s, f] of Object.entries(fresh.source.files) as any) assert.match(f.url, /e6744429ee395bc86f247348c6184bb08d4eb361/, s);
});
