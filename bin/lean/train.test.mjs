// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { openTrain, createTrain, insertMilestone, resolveCaps, runTrain, stopOf, trainCli, STOP_REASONS } from "./train.mjs";

const live = { issues: [
  { number: 1, milestone: "m1", state: "OPEN", body: "" },
  { number: 2, milestone: "m2", state: "OPEN", body: "Depends on #1" },
  { number: 3, milestone: "m3", state: "OPEN", body: "" },
] };
const tmp = () => tmpDir("train-");
const okRun = (calls) => async (slug, o) => { calls.push([slug, o]); return { ok: true, batch: `b-${slug}`, rows: [] }; };
const life = async (titles) => titles.map((title) => ({ title, state: "shipped:staging" }));

test("createTrain keeps order, refuses a dependency on a later milestone", () => {
  const s = createTrain({ slugs: ["m1", "m2"], live });
  assert.deepEqual(s.order, ["m1", "m2"]);
  assert.equal(s.milestones.m1.status, "pending");
  assert.throws(() => createTrain({ slugs: ["m2", "m1"], live }), /train order invalid/);
});

test("insertMilestone re-validates and leaves the state unchanged on refusal", () => {
  const s = createTrain({ slugs: ["m1", "m2"], live });
  const n = insertMilestone(s, "m3", { after: "m1", live });
  assert.deepEqual(n.order, ["m1", "m3", "m2"]);
  assert.deepEqual(s.order, ["m1", "m2"]);
  assert.throws(() => insertMilestone(s, "m1", { live }), /already in the train/);
  const live2 = { issues: [...live.issues, { number: 4, milestone: "m4", state: "OPEN", body: "Depends on #2" }, { number: 5, milestone: "m2", state: "OPEN", body: "Depends on #4" }] };
  assert.throws(() => insertMilestone(s, "m4", { live: live2 }), /train order invalid/);
});

test("runTrain runs in order, persists lifecycle, and resumes from the state file", async () => {
  const root = tmp(), train = openTrain(root, "t1"), calls = [];
  const r = await runTrain({ train, state: createTrain({ slugs: ["m1", "m2"], live }), runMilestone: okRun(calls), onBatchEnd: life, readLive: async () => live, caps: resolveCaps({}) });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c[0]), ["m1", "m2"]);
  const saved = train.load();
  assert.equal(saved.milestones.m2.status, "done");
  assert.equal(saved.milestones.m2.lifecycle, "shipped:staging");
  assert.equal(saved.milestones.m1.batch, "b-m1");
});

test("a failed milestone ends in a typed STOP and --resume continues through its batch", async () => {
  const root = tmp(), train = openTrain(root, "t2"), calls = [];
  let fail = true;
  const run = async (slug, o) => { calls.push([slug, o.resume]); return fail && slug === "m1" ? { ok: false, batch: "b1", rows: [{ issue: 1, outcome: "needs-human" }] } : { ok: true, rows: [] }; };
  const args = { train, runMilestone: run, onBatchEnd: life, readLive: async () => live, caps: resolveCaps({}) };
  const a = await runTrain({ ...args, state: createTrain({ slugs: ["m1", "m2"], live }) });
  assert.equal(a.ok, false);
  assert.equal(a.state.stop.reason, "needs-human");
  assert.ok(STOP_REASONS.includes(a.state.stop.reason));
  assert.equal(a.state.milestones.m2.status, "pending");
  fail = false;
  const b = await runTrain({ ...args, state: train.load() });
  assert.equal(b.ok, true);
  assert.deepEqual(calls.slice(1), [["m1", "b1"], ["m2", null]]);
});

test("open issues left after a batch stop the train with milestone-open", async () => {
  const r = await runTrain({ train: openTrain(tmp(), "t3"), state: createTrain({ slugs: ["m1"] }), runMilestone: okRun([]), onBatchEnd: async (t) => [{ title: t[0], state: "building" }], caps: resolveCaps({}) });
  assert.equal(r.state.stop.reason, "milestone-open");
});

test("stopOf maps row outcomes to typed reasons", () => {
  assert.equal(stopOf({ rows: [{ outcome: "dependency-open" }] }), "dependency-unmet");
  assert.equal(stopOf({ rows: [{ outcome: "budget-exceeded" }] }), "budget");
  assert.equal(stopOf({ rows: [] }), "error");
});

test("parallel milestones run together and split one cap", async () => {
  const caps = resolveCaps({ globalParallel: 6, parallelMilestones: 2 });
  assert.equal(caps.perMilestone, 3);
  let live_ = 0, max = 0;
  const run = async () => { live_++; max = Math.max(max, live_); await new Promise((r) => setTimeout(r, 10)); live_--; return { ok: true, rows: [] }; };
  const r = await runTrain({ train: openTrain(tmp(), "t4"), state: createTrain({ slugs: ["m1", "m3"], parallelMilestones: 2 }), runMilestone: run, onBatchEnd: life, caps });
  assert.equal(r.ok, true);
  assert.equal(max, 2);
});

test("a conflicting --parallel override warns and is ignored; the cap source is global_parallel", () => {
  const c = resolveCaps({ requested: 32, globalParallel: 12 });
  assert.equal(c.cap, 12);
  assert.match(c.warnings[0], /conflicts.*ignored/);
  assert.equal(resolveCaps({ requested: 12, globalParallel: 12 }).warnings.length, 0);
});

test("trainCli: forge.yaml is byte-identical after a run and lanes get no branches.staging override", async () => {
  const root = tmp(), cwd = tmp(), out = [], calls = [];
  const yaml = "branches:\n  staging: staging\norchestration:\n  global_parallel: 4\n";
  writeFileSync(join(cwd, "forge.yaml"), yaml);
  const before = readFileSync(join(cwd, "forge.yaml"));
  const r = await trainCli(["m1", "m2", "--parallel", "32"], { root, id: "t5", globalParallel: 4, readLive: async () => live, runMilestone: okRun(calls), onBatchEnd: life, print: (l) => out.push(l) });
  assert.equal(r.ok, true);
  assert.ok(out.some((l) => /conflicts with the lane cap 4/.test(l)));
  assert.equal(calls[0][1].parallel, 4);
  assert.deepEqual(readFileSync(join(cwd, "forge.yaml")), before);
  assert.equal(openTrain(root, "t5").load().milestones.m2.status, "done");
});

test("trainCli --insert adds a milestone explicitly; --resume clears nothing it did not own", async () => {
  const root = tmp(), out = [];
  const deps = { root, id: "t6", readLive: async () => live, runMilestone: okRun([]), onBatchEnd: life, print: (l) => out.push(l) };
  await trainCli(["m1"], deps);
  const r = await trainCli(["--insert", "t6", "m3"], deps);
  assert.deepEqual(r.state.order, ["m1", "m3"]);
  const done = await trainCli(["--resume", "t6"], deps);
  assert.equal(done.state.milestones.m3.status, "done");
  await assert.rejects(() => trainCli(["--resume", "nope"], deps), /no train/);
});
