// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseExperiment, assignArm, benchRecord, BENCH_SCHEMA, ARM_OVERRIDE_KEYS, armOverrides, applyArmOverrides, readExperiment } from "../experiment.mjs";
import { parseForgeYaml } from "../forge-utils.mjs";
import { parseExploreConfig } from "../lean/explore.mjs";
import { mapRecord } from "../engine/telemetry-seam.mjs";
import { runsFromRecords } from "../stats/github-source.mjs";
import { experimentReport, evalTarget, renderExperiment } from "../stats/experiment.mjs";
import { parseArgs, experimentExit, runStats } from "../stats/index.mjs";
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

test("#4634 --require-met: exit 1 unless every target is met, opt-in only", async () => {
  assert.equal(parseArgs(["--experiment", "ab1", "--require-met"]).requireMet, true);
  assert.equal(parseArgs(["--experiment", "ab1"]).requireMet, false);
  const e = parseExperiment(SEC);
  const runs = [1, 2, 3].flatMap((i) => [mkRun("light", i, 1), mkRun("full", 10 + i, 1)]);
  const met = experimentReport(runs, e), small = experimentReport(runs.slice(0, 4), e);
  assert.equal(met.targets_met, true);
  assert.equal(experimentExit({ requireMet: true }, met), 0);
  assert.equal(experimentExit({ requireMet: true }, small), 1);
  assert.equal(experimentExit({ requireMet: false }, small), 0);
  const realOut = process.stdout.write, realErr = process.stderr.write;
  let err = "";
  process.stdout.write = () => true; process.stderr.write = (c) => { err += c; return true; };
  try {
    assert.equal(await runStats(["--require-met", "--repo", "o/r"]), 2);
    assert.match(err, /--require-met needs --experiment/);
    const gh = async () => "[]";
    const deps = { gh, env: {}, releaseTimes: [], experiment: e };
    const base = ["--experiment", "ab1", "--repo", "o/r", "--no-cache", "--no-local"];
    assert.equal(await runStats(base, deps), 0);
    assert.equal(await runStats([...base, "--require-met"], deps), 1);
  } finally { process.stdout.write = realOut; process.stderr.write = realErr; }
});

test("#4632 parseArgs: --emit-event is opt-in", () => {
  assert.equal(parseArgs(["--experiment", "x"]).emitEvent, false);
  assert.equal(parseArgs(["--experiment", "x", "--emit-event"]).emitEvent, true);
});

// ---- forge#5206: arm-scoped config overrides ----
const AB = { id: "explore-ab", arms: "on,off", ratio: "1,1", "on.lean.explore": "on", "off.lean.explore": "off", min_n: "2" };

test("#5206 parseExperiment reads <arm>.<key> overrides; armOverrides per arm", () => {
  const e = parseExperiment(AB);
  assert.deepEqual(e.overrides, { on: { "lean.explore": "on" }, off: { "lean.explore": "off" } });
  assert.deepEqual(armOverrides(e, "on"), { "lean.explore": "on" });
  assert.deepEqual(armOverrides(e, "nope"), {});
  assert.deepEqual(armOverrides(null, "on"), {});
  assert.deepEqual(parseExperiment({ id: "x", arms: "a,b" }).overrides, { a: {}, b: {} });
  const all = parseExperiment({ id: "x", arms: "a,b", "a.lean.explore_model": "claude-haiku-5-5", "a.lean.light_mode": "on", "b.context_pack": "on", "b.review.verifier": "shadow" });
  assert.deepEqual(all.overrides, { a: { "lean.explore_model": "claude-haiku-5-5", "lean.light_mode": "on" }, b: { context_pack: "on", "review.verifier": "shadow" } });
  assert.deepEqual(Object.keys(ARM_OVERRIDE_KEYS).sort(), ["context_pack", "lean.explore", "lean.explore_model", "lean.light_mode", "review.verifier"]);
});

test("#5206 R2: a key outside the allowlist, an undeclared arm or a bad value invalidates the whole declaration with a reason", () => {
  for (const bad of [{ "on.lean.fix_model": "x" }, { "on.engine.conformance": "enforce" }, { "maybe.lean.explore": "on" }, { "on.lean.explore": "sometimes" }, { "on.context_pack": "ab" }, { "on.review.verifier": "loud" }]) {
    const reasons = [];
    assert.equal(parseExperiment({ ...AB, ...bad }, { warn: (m) => reasons.push(m) }), null, JSON.stringify(bad));
    assert.equal(reasons.length, 1); assert.match(reasons[0], new RegExp(Object.keys(bad)[0].replace(/\./g, "\\.")));
    const opts = { experiment: parseExperiment({ ...AB, ...bad }), explore: { mode: "off" } };
    assert.equal(applyArmOverrides(opts, 7).options, opts, "no partial apply");
  }
});

test("#5206 R1: overrides apply only to the arm's issues, the same issue always gets the same arm", () => {
  const e = parseExperiment(AB);
  const seen = { on: 0, off: 0 };
  for (let i = 1; i <= 40; i++) {
    const { options, tag } = applyArmOverrides({ experiment: e, explore: { model: "claude-haiku-5-5" } }, i);
    assert.equal(tag.arm, assignArm(e, i));
    assert.deepEqual(applyArmOverrides({ experiment: e }, i).tag, applyArmOverrides({ experiment: e }, i).tag); // rerun/resume: same arm
    assert.equal(parseExploreConfig(options.explore).mode, tag.arm === "on" ? "on" : "off");
    assert.equal(options.explore.model, "claude-haiku-5-5");
    assert.equal(tag.arm_overrides, `lean.explore=${tag.arm}`);
    seen[tag.arm]++;
  }
  assert.ok(seen.on > 0 && seen.off > 0);
  const x = parseExperiment({ id: "x", arms: "a,b", "a.lean.light_mode": "on", "a.context_pack": "off", "a.review.verifier": "enforce", "a.lean.explore_model": "m1", "b.lean.light_mode": "on", "b.context_pack": "off", "b.review.verifier": "enforce", "b.lean.explore_model": "m1" });
  const { options } = applyArmOverrides({ experiment: x, light: { mode: "shadow", maxLines: 40, maxFiles: 2 }, contextPack: { mode: "shadow", bytes: 9 }, verifier: { mode: "off", model: "v" } }, 3);
  assert.deepEqual([options.light, options.contextPack, options.verifier, options.explore], [{ mode: "on", maxLines: 40, maxFiles: 2 }, { mode: "off", bytes: 9 }, { mode: "enforce", model: "v" }, { model: "m1" }]);
});

test("#5206 R4: no experiment leaves the lane options untouched (same object, no tag)", () => {
  const opts = { issue: 7, explore: { mode: "on" }, light: { mode: "shadow" } };
  const r = applyArmOverrides(opts, 7);
  assert.equal(r.options, opts); assert.deepEqual(r.tag, {});
  const noOv = applyArmOverrides({ experiment: parseExperiment({ id: "x", arms: "a,b" }) }, 7);
  assert.equal(noOv.tag.arm_overrides, "");
});

test("#5206 forge.yaml: dotted keys only in opted-in sections; readExperiment reads them and warns on an invalid one", () => {
  const raw = "experiment:\n  id: explore-ab\n  arms: on,off\n  on.lean.explore: on\n  off.lean.explore: off\nlean:\n  a.b: x\n  explore: on\n";
  assert.deepEqual(parseForgeYaml(raw).experiment, { id: "explore-ab", arms: "on,off" });
  assert.deepEqual(parseForgeYaml(raw, { dottedSections: ["experiment"] }).experiment, { id: "explore-ab", arms: "on,off", "on.lean.explore": "on", "off.lean.explore": "off" });
  assert.deepEqual(parseForgeYaml(raw, { dottedSections: ["experiment"] }).lean, { explore: "on" });
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "exp5206-"));
  try {
    writeFileSync(join(dir, "forge.yaml"), raw);
    assert.deepEqual(readExperiment(dir).overrides, { on: { "lean.explore": "on" }, off: { "lean.explore": "off" } });
    writeFileSync(join(dir, "forge.yaml"), raw.replace("off.lean.explore: off", "off.lean.fix_model: x"));
    const reasons = [];
    assert.equal(readExperiment(dir, (m) => reasons.push(m)), null);
    assert.match(reasons[0], /off\.lean\.fix_model/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#5206 R3: the seam carries arm_overrides, stats counts per-arm applied runs", () => {
  assert.equal(mapRecord({ event: "RUN_TERMINAL", reason: "merged", code: "ok", experiment: "e", arm: "on", arm_overrides: "lean.explore=on" }, 5).payload.arm_overrides, "lean.explore=on");
  assert.equal(mapRecord({ event: "RUN_TERMINAL", reason: "merged", code: "ok", experiment: "e", arm: "on", arm_overrides: "" }, 5).payload.arm_overrides, "none");
  assert.equal(mapRecord({ event: "PHASE_ATTEMPT_USAGE", phase: "implement", attempt: 1, experiment: "e", arm: "on", arm_overrides: "lean.explore=on" }, 5).payload.arm_overrides, "lean.explore=on");
  assert.ok(!("arm_overrides" in mapRecord({ event: "RUN_TERMINAL", reason: "merged", code: "ok" }, 5).payload));
  const runs = runsFromRecords([
    { event: "run_terminal", repo: "o/r", issue: 1, run: "a", ts: "2026-01-01T00:01:00Z", reason: "merged", experiment: "explore-ab", arm: "on", arm_overrides: "lean.explore=on", wall_ms: 1 },
  ]);
  assert.equal(runs[0].armOverrides, "lean.explore=on");
  const e = parseExperiment(AB);
  const mk = (arm, i, ov) => ({ ...mkRun(arm, i, 1), experiment: "explore-ab", ...(ov !== undefined ? { armOverrides: ov } : {}) });
  const r = experimentReport([mk("on", 1, "lean.explore=on"), mk("on", 2, "lean.explore=off"), mk("off", 3, "lean.explore=off"), mk("off", 4)], e);
  assert.deepEqual([r.arms.on.n, r.arms.on.applied, r.arms.off.n, r.arms.off.applied], [2, 1, 2, 1]);
  assert.equal(experimentReport([mk("a", 1, "none")], parseExperiment({ id: "explore-ab", arms: "a,b" })).arms.a.applied, 1);
  const txt = renderExperiment(r);
  assert.match(txt, /\| arm \| n \| applied \|/); assert.match(txt, /\| on \| 2 \| 1\/2 \|/);
});
