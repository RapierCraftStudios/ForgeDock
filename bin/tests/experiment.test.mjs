// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExperiment, assignArm, benchRecord, BENCH_SCHEMA } from "../experiment.mjs";
import { mapRecord } from "../engine/telemetry-seam.mjs";
import { runsFromRecords } from "../stats/github-source.mjs";
import { experimentReport, evalTarget } from "../stats/experiment.mjs";
import { parseArgs } from "../stats/index.mjs";
import { aggregate as benchAggregate } from "../../scripts/bench-lightlane.mjs";
import { evaluateGate } from "../../scripts/eval-gate-scorecard.mjs";

const SEC = { id: "ab1", arms: "light,full", ratio: "1,3", targets: "light.usd_median<=1.2xfull,light.first_pass_rate>=0.5", min_n: "3" };

test("#4629 parseExperiment: valid, defaults and invalid declarations", () => {
  const e = parseExperiment(SEC);
  assert.deepEqual([e.id, e.arms, e.ratio, e.minN, e.targets.length], ["ab1", ["light", "full"], [1, 3], 3, 2]);
  assert.equal(parseExperiment({ id: "x", arms: "a,b" }).minN, 10);
  assert.deepEqual(parseExperiment({ id: "x", arms: "a,b" }).ratio, [1, 1]);
  for (const bad of [null, { id: "x", arms: "a" }, { ...SEC, ratio: "1" }, { ...SEC, targets: "nope.usd_median<=1" }, { ...SEC, metrics: "bogus" }, { ...SEC, min_n: "x" }]) assert.equal(parseExperiment(bad), null);
});

test("#4629 assignArm is deterministic and follows the ratio", () => {
  const e = parseExperiment(SEC);
  assert.equal(assignArm(e, 42), assignArm(e, 42));
  const counts = { light: 0, full: 0 };
  for (let i = 1; i <= 2000; i++) counts[assignArm(e, i)]++;
  assert.ok(counts.light > 300 && counts.light < 700, JSON.stringify(counts)); // ~25%
});

test("#4629 the seam carries arm and experiment, and nothing when undeclared", () => {
  const t = mapRecord({ event: "RUN_TERMINAL", reason: "merged", code: "ok", experiment: "ab1", arm: "light" }, 5);
  assert.equal(t.payload.arm, "light"); assert.equal(t.payload.experiment, "ab1");
  const a = mapRecord({ event: "PHASE_ATTEMPT_USAGE", phase: "implement", attempt: 1, experiment: "ab1", arm: "full" }, 5);
  assert.equal(a.payload.arm, "full");
  assert.ok(!("arm" in mapRecord({ event: "RUN_TERMINAL", reason: "merged", code: "ok" }, 5).payload));
});

test("#4629 runsFromRecords keeps arm and experiment", () => {
  const runs = runsFromRecords([
    { event: "phase_attempt", repo: "o/r", issue: 1, run: "a", ts: "2026-01-01T00:00:00Z", phase: "implement", attempt: 1, experiment: "ab1", arm: "light", cost_usd: 1 },
    { event: "run_terminal", repo: "o/r", issue: 1, run: "a", ts: "2026-01-01T00:01:00Z", reason: "merged", experiment: "ab1", arm: "light", wall_ms: 60000 },
  ]);
  assert.deepEqual([runs[0].experiment, runs[0].arm], ["ab1", "light"]);
});

const mkRun = (arm, i, usd) => ({ finished: true, experiment: "ab1", arm, repo: "o/r", issue: i, reason: "merged", wallMs: 1000, version: "1.0.0",
  phases: { implement: { cr: 0, out: 0, usd, ms: 1, attempts: 1 } }, builderAttempts: [{ attempt: 1, trigger: "build", restart_of: null, cost_usd: usd }], usageEvents: 1 });

test("#4629 experimentReport: null below min n, targets met/missed/null", () => {
  const e = parseExperiment(SEC);
  const runs = [1, 2, 3].flatMap((i) => [mkRun("light", i, 1), mkRun("full", 10 + i, 1)]);
  const r = experimentReport(runs, e);
  assert.equal(r.schema, BENCH_SCHEMA);
  assert.equal(r.arms.light.n, 3); assert.equal(r.arms.light.usd_median, 1);
  assert.equal(r.targets["light.usd_median<=1.2xfull"].pass, true);
  const small = experimentReport(runs.slice(0, 4), e);
  assert.equal(small.arms.light.usd_median, null);
  assert.equal(small.targets["light.usd_median<=1.2xfull"].pass, null);
  assert.equal(small.targets_met, false);
  const costly = experimentReport([1, 2, 3].flatMap((i) => [mkRun("light", i, 5), mkRun("full", 10 + i, 1)]), e);
  assert.equal(costly.targets["light.usd_median<=1.2xfull"].pass, false);
  assert.equal(experimentReport(runs.filter((r) => r.arm === "light").map((r) => ({ ...r, experiment: "other" })), e).arms.light.n, 0);
  assert.equal(evalTarget({ arm: "a", metric: "m", op: ">=", limit: 1, vs: null }, { a: { m: null } }).pass, null);
});

test("#4629 parseArgs --experiment", () => {
  assert.equal(parseArgs(["--experiment", "ab1"]).experiment, "ab1");
  assert.throws(() => parseArgs(["--experiment", "a b"]));
});

test("#4629 bench-lightlane and the eval gate emit the shared record", () => {
  const b = benchAggregate([]).record;
  assert.equal(b.schema, BENCH_SCHEMA); assert.equal(b.source, "bench-lightlane");
  const sc = (rate, n) => ({ schema_version: 1, issues_run: n, successful_runs: n, failed_runs: 0, success_rate_pct: rate, run_mode: "full", run_id: "r" });
  const g = evaluateGate(sc(90, 20), sc(90, 20));
  assert.equal(g.record.schema, BENCH_SCHEMA);
  assert.deepEqual(Object.keys(g.record).sort(), Object.keys(benchRecord({ source: "x" })).sort());
  assert.equal(evaluateGate(sc(10, 2), sc(90, 20)).record.targets.success_rate_within_threshold.pass, null);
});

test("#4632 parseArgs: --emit-event is opt-in", () => {
  assert.equal(parseArgs(["--experiment", "x"]).emitEvent, false);
  assert.equal(parseArgs(["--experiment", "x", "--emit-event"]).emitEvent, true);
});
