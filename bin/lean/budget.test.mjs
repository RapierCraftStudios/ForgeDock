// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4392: per-size implement turn budgets: sizing, config, digest, the stream turn cap and the batch-report line.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync } from "node:fs";
import { tmpDir } from "../tests/_tmp.mjs";
import { TURN_BUDGET_DEFAULTS, parseTurnBudgets, laneSize, nextSize, recoverySize, wrapupGrant, makeTurnBudget, budgetDigest, formatTurnSummary } from "./budget.mjs";
import { orchestrate } from "./orchestrate.mjs";
import { OUTCOME_CODES, RECOVERABLE_CODES } from "../engine/outcome-codes.mjs";
import { RECOVER_HOW } from "./lean.mjs";
import { TRIGGERS, REWORK_TRIGGERS, firstPassOf } from "./fixround.mjs";

process.env.FORGEDOCK_SCHED_DIR = tmpDir("budget-sched-");
const contract = (n) => ({ deliverables: Array.from({ length: n }, (_, i) => ({ id: `D${i + 1}`, path: `src/f${i % Math.max(1, n)}.js` })) });

describe("#4392 turn budget", () => {
  it("defaults are S=25, M=60, L=100; forge.yaml keys override, 0 allowed, junk ignored", () => {
    assert.deepEqual(TURN_BUDGET_DEFAULTS, { S: 25, M: 60, L: 100 });
    assert.equal(parseTurnBudgets({}), null);
    assert.equal(parseTurnBudgets(null), null);
    assert.deepEqual(parseTurnBudgets({ turn_budget_s: "10", turn_budget_m: 0, turn_budget_l: "x" }), { S: 10, M: 0, L: 100 });
  });

  it("size: a size label wins, else distinct deliverable paths (S <= 2, M <= 5, else L); unsized without either", () => {
    assert.equal(laneSize({ contract: contract(1) }), "S");
    assert.equal(laneSize({ contract: contract(2) }), "S");
    assert.equal(laneSize({ contract: contract(3) }), "M");
    assert.equal(laneSize({ contract: contract(5) }), "M");
    assert.equal(laneSize({ contract: contract(6) }), "L");
    assert.equal(laneSize({ contract: { deliverables: [{ path: "a" }, { path: "a" }, { path: "b" }] } }), "S", "paths are deduped");
    assert.equal(laneSize({ contract: contract(9), labels: [{ name: "size:S" }] }), "S");
    assert.equal(laneSize({ contract: contract(1), labels: ["bug", "Size/l"] }), "L");
    assert.equal(laneSize({}), null);
  });

  it("#4505 a budget.exceeded recovery runs at the next size (S->M->L, L stays L); other lanes keep their size", () => {
    assert.deepEqual(["S", "M", "L"].map(nextSize), ["M", "L", "L"]);
    assert.equal(nextSize(null), null); assert.equal(nextSize("XL"), "XL");
    assert.equal(recoverySize("S", { code: "budget.exceeded", attempt: 1, final: true }), "M");
    assert.equal(recoverySize("L", { code: "budget.exceeded" }), "L");
    assert.equal(recoverySize("S", { code: "ci.red" }), "S"); assert.equal(recoverySize("S", null), "S"); assert.equal(recoverySize(null, { code: "budget.exceeded" }), null);
  });

  it("the tally: build turns spend the budget, other attempts count only in total; off or unsized is unlimited", () => {
    const tb = makeTurnBudget({ M: 60 });
    assert.equal(tb.record(), null); assert.equal(tb.remaining(), Infinity);
    tb.setSize("M"); tb.note(4, false); tb.note(50, true); tb.note(undefined, true);
    assert.equal(tb.remaining(), 10);
    tb.markExceeded();
    assert.deepEqual(tb.record(), { size: "M", budget: 60, build: 50, total: 54, exceeded: true });
    const off = makeTurnBudget({ S: 0 }); off.setSize("S");
    assert.equal(off.on(), false); assert.equal(off.remaining(), Infinity);
    assert.equal(wrapupGrant(25), 5); assert.equal(wrapupGrant(100), 20); assert.equal(wrapupGrant(3), 5);
  });

  it("the digest is the builder's (capped), else the diff stat and the last self-check", () => {
    const d = budgetDigest({ size: "M", budget: 60, used: 66, digest: "x".repeat(5000) });
    assert.match(d, /size M, 60 turns; 66 used/); assert.ok(d.length < 1800);
    const s = budgetDigest({ size: "S", budget: 25, used: 30, stat: " src/a.js | 4 ++--", check: "red" });
    assert.match(s, /No builder digest/); assert.match(s, /src\/a\.js/); assert.match(s, /Last self-check: red/);
  });

  it("budget.exceeded is a typed, recoverable outcome with a recovery instruction; budget_wrapup is a build restart, not rework", () => {
    assert.equal(OUTCOME_CODES.BUDGET_EXCEEDED, "budget.exceeded");
    assert.ok(RECOVERABLE_CODES.includes("budget.exceeded"));
    assert.match(RECOVER_HOW["budget.exceeded"], /split-required/);
    assert.ok(TRIGGERS.includes("budget_wrapup")); assert.ok(!REWORK_TRIGGERS.includes("budget_wrapup"));
    assert.equal(firstPassOf([{ trigger: "plan" }, { trigger: "budget_wrapup", restart_of: "build" }]), true);
  });

  it("runCliBackendAsync turnMax stops a stream session at that many assistant turns (deduped by message id)", async () => {
    const { runCliBackendAsync } = await import("../runner.mjs");
    const d = tmpDir("core-turns-");
    const line = (id) => JSON.stringify({ type: "assistant", message: { id, content: [{ type: "tool_use", name: "Edit", input: { file: "a" } }], usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } } });
    writeFileSync(`${d}/fake`, `#!/bin/sh\necho '${line("m1")}'\necho '${line("m1")}'\necho '${line("m2")}'\necho '${line("m3")}'\nexec sleep 30\n`); chmodSync(`${d}/fake`, 0o755);
    const t0 = Date.now();
    await assert.rejects(runCliBackendAsync({ spec: { name: "t" }, userMessage: "go", args: ["1"], cwd: d, bin: `${d}/fake`, logger: { log() {} }, stream: true, turnMax: 3 }), (e) => {
      assert.equal(e.code, "CLI_TURNS"); assert.equal(e.turns, 3); assert.equal(e.turnMax, 3);
      assert.deepEqual(e.usage, { input_tokens: 30, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 15 });
      assert.equal(e.lastTool.name, "Edit");
      return true;
    });
    assert.ok(Date.now() - t0 < 15000, "killed, not waited out");
  });

  it("#4410 runCliBackendAsync returns the stream's tool uses, deduped by tool_use id, with path and command", async () => {
    const { runCliBackendAsync } = await import("../runner.mjs");
    const d = tmpDir("core-tools-");
    const use = (id, name, input) => ({ type: "tool_use", id, name, input });
    const line = (id, content) => JSON.stringify({ type: "assistant", message: { id, content, usage: { input_tokens: 1, output_tokens: 1 } } });
    const a = line("m1", [use("t1", "Read", { file_path: "a.sh" })]), b = line("m1", [use("t2", "Bash", { command: "sed -n 1,9p a.sh" })]);
    const c = line("m2", [use("t3", "Grep", { pattern: "x", path: "src" })]);
    const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s-1", usage: { input_tokens: 2, output_tokens: 2 } });
    writeFileSync(`${d}/fake`, `#!/bin/sh\necho '${a}'\necho '${a}'\necho '${b}'\necho '${c}'\necho '${result}'\n`); chmodSync(`${d}/fake`, 0o755);
    const r = await runCliBackendAsync({ spec: { name: "t" }, userMessage: "go", args: ["1"], cwd: d, bin: `${d}/fake`, logger: { log() {} }, stream: true });
    assert.deepEqual(r.toolUses, [{ msg: "m1", name: "Read", path: "a.sh", cmd: null }, { msg: "m1", name: "Bash", path: null, cmd: "sed -n 1,9p a.sh" },
      { msg: "m2", name: "Grep", path: "src", cmd: null }]);
    writeFileSync(`${d}/fake`, `#!/bin/sh\necho '${a}'\necho '${b}'\necho '${c}'\nexec sleep 30\n`);
    await assert.rejects(runCliBackendAsync({ spec: { name: "t" }, userMessage: "go", args: ["1"], cwd: d, bin: `${d}/fake`, logger: { log() {} }, stream: true, turnMax: 2 }),
      (e) => e.code === "CLI_TURNS" && e.toolUses.length === 3);
  });

  it("the batch row carries the lane's turns and the report prints a size x turns line with overruns", async () => {
    const T = (size, budget, build, exceeded = false) => ({ size, budget, build, total: build + 3, exceeded });
    const results = { 1: { terminalReason: "merged", turns: T("S", 25, 10) }, 2: { terminalReason: "merged", turns: T("S", 25, 22) }, 3: { terminalReason: "merged", turns: T("S", 25, 30, true) },
      4: { terminalReason: "merged", turns: T("M", 60, 41) }, 5: { terminalReason: "needs-human", code: "budget.exceeded", turns: T("L", 100, 105, true) } };
    const rows = await orchestrate({ issues: [1, 2, 3, 4, 5], parallel: 2, readBody: async () => "", runOne: async (n) => results[n], recovery: { maxAttempts: 0 } });
    assert.deepEqual(rows.find((r) => r.issue === 4).turns, results[4].turns);
    assert.equal(formatTurnSummary(rows), "turns by size: S n=3 p50 22 max 30/25; M n=1 p50 41 max 41/60; over budget: #3 (S 25) #5 (L 100)");
    assert.equal(formatTurnSummary([{ issue: 1, outcome: "merged" }]), null);
    assert.equal(formatTurnSummary([{ issue: 1, outcome: "merged", turns: T("S", 0, 7) }]), "turns by size: S n=1 p50 7 max 7/off");
  });
});
