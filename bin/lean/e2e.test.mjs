// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseE2e, e2eSpecs, contractWantsE2e, e2eWanted, ownFailures, runE2eGate, E2E_DEFAULT_PATHS, NO_TRIGGER } from "./e2e.mjs";
import { VERIFY_CHECK_NAME } from "./verify.mjs";

const HEAD = "abc123abc123abc123";
const RUN = "https://github.com/o/r/actions/runs/42/job/1";
/** Fake io + clock: `checks` is a list of successive commitChecks answers (the last repeats). */
function fake(o = {}) {
  const f = { clock: 0, labels: [], dispatched: [], q: [...(o.checks ?? [])] };
  f.io = {
    addPrLabel: async (pr, l) => { if (o.labelError) throw new Error(o.labelError); f.labels.push([pr, l]); },
    commitChecks: async () => (f.q.length > 1 ? f.q.shift() : f.q[0] ?? []),
    failedLogs: async () => o.log ?? "FAIL e2e/a.spec.ts",
    dispatchWorkflow: async (a) => { f.dispatched.push(a); },
    workflowRuns: async () => [{ databaseId: 9, headSha: HEAD, status: "completed", conclusion: o.conclusion ?? "success", url: "https://github.com/o/r/actions/runs/9", name: "e2e" }],
  };
  f.args = (extra = {}) => ({ io: f.io, pr: 77, branch: "feat/issue-7-lean", head: HEAD, cfg: parseE2e({ e2e_label: "full-ci", e2e_checks: "e2e" }), specs: ["e2e/a.spec.ts"],
    ciMaxMinutes: 30, now: () => f.clock, sleep: async (ms) => { f.clock += ms; }, random: () => 0.5, ...extra });
  return f;
}
const chk = (state, conclusion = state === "pending" ? null : state, name = "e2e") => ({ name, state, conclusion, url: RUN });

describe("e2e config and trigger (#4403)", () => {
  it("parseE2e defaults to auto/changed with the default paths and rejects invalid values", () => {
    assert.deepEqual(parseE2e({}), { mode: "auto", label: null, workflow: null, pathsInput: null, checks: [], paths: [...E2E_DEFAULT_PATHS], blocking: "changed" });
    const c = parseE2e({ e2e: "always", e2e_label: "full-ci", e2e_workflow: "e2e.yml", e2e_paths_input: "specs", e2e_checks: "e2e (1), e2e (2)", e2e_paths: "tests/e2e/**", e2e_blocking: "all" });
    assert.deepEqual(c, { mode: "always", label: "full-ci", workflow: "e2e.yml", pathsInput: "specs", checks: ["e2e (1)", "e2e (2)"], paths: ["tests/e2e/**"], blocking: "all" });
    assert.equal(parseE2e({ e2e: "sometimes" }).mode, "auto");
    assert.equal(parseE2e({ e2e_workflow: "x; rm -rf /" }).workflow, null);
    assert.equal(parseE2e({ e2e_label: "a$(b)" }).label, null);
  });
  it("e2eSpecs matches the default layouts and ignores .forge-lean files", () => {
    const files = ["e2e/a.spec.ts", "apps/web/e2e/b.spec.ts", "src/x.e2e.test.ts", "test/app.e2e-spec.ts", "cypress/e2e/c.cy.ts", "playwright/d.ts", "src/a.ts", "src/a.spec.ts", ".forge-lean/e2e/x"];
    assert.deepEqual(e2eSpecs(files), files.slice(0, 6));
  });
  it("e2eWanted: never never runs; no trigger never runs; auto runs on specs or [type:e2e]; always runs unless docs-only", () => {
    const cfg = parseE2e({ e2e_label: "full-ci" });
    const typed = { requirements: [{ quote: "Rosters render. [type:E2E]" }] };
    assert.equal(e2eWanted({ cfg: { ...cfg, mode: "never" }, files: ["e2e/a.spec.ts"] }).run, false);
    assert.deepEqual(e2eWanted({ cfg: parseE2e({}), files: ["e2e/a.spec.ts"] }), { run: false, reason: NO_TRIGGER, specs: ["e2e/a.spec.ts"] });
    assert.equal(e2eWanted({ cfg, files: ["e2e/a.spec.ts"] }).run, true);
    assert.equal(e2eWanted({ cfg, files: ["src/a.ts"] }).run, false);
    assert.equal(contractWantsE2e(typed), true);
    assert.equal(e2eWanted({ cfg, files: ["src/a.ts"], contract: typed }).run, true);
    assert.equal(e2eWanted({ cfg: { ...cfg, mode: "always" }, files: ["src/a.ts"] }).run, true);
    assert.equal(e2eWanted({ cfg: { ...cfg, mode: "always" }, files: ["README.md"] }).run, false);
  });
  it("ownFailures: by spec path or basename in the log; an empty log or no changed spec counts as the lane's", () => {
    const fs = [{ job: "a", log: "FAIL e2e/a.spec.ts" }, { job: "b", log: "x/a.spec.ts:3 failed" }, { job: "c", log: "FAIL e2e/rosters.spec.ts" }, { job: "d", log: "" }];
    assert.deepEqual(ownFailures(fs, ["e2e/a.spec.ts"]).map((f) => f.job), ["a", "b", "d"]);
    assert.deepEqual(ownFailures(fs, []).map((f) => f.job), ["a", "b", "c", "d"]);
  });
});

describe("runE2eGate (#4403)", () => {
  it("label path: labels the PR; a skipped run is not a pass; waits for the real run", async () => {
    const f = fake({ checks: [[chk("success", "skipped")], [chk("success", "skipped"), chk("pending")], [chk("success", "skipped"), chk("success")]] });
    const r = await runE2eGate(f.args());
    assert.equal(r.result, "pass"); assert.deepEqual(f.labels, [[77, "full-ci"]]);
    assert.ok(f.clock > 0, "it waited");
  });
  it("label path: a red e2e run returns the failed log; other checks are ignored when e2e_checks is set", async () => {
    const f = fake({ checks: [[chk("failure"), chk("failure", "failure", "lint")]], log: "FAIL e2e/a.spec.ts" });
    const r = await runE2eGate(f.args());
    assert.equal(r.result, "fail"); assert.deepEqual(r.failures.map((x) => x.job), ["e2e"]); assert.match(r.failures[0].log, /a\.spec\.ts/);
  });
  it("label path without e2e_checks waits on every check but the lane's own verify check", async () => {
    const f = fake({ checks: [[chk("success", "success", "build"), chk("success", "skipped"), chk("success", "success", VERIFY_CHECK_NAME)], [chk("success", "success", "build"), chk("success")]] });
    const r = await runE2eGate(f.args({ cfg: parseE2e({ e2e_label: "full-ci" }) }));
    assert.equal(r.result, "pass"); assert.ok(f.clock > 0, "the skipped e2e kept it waiting");
  });
  it("label refused, or no e2e run within the grace period, is unavailable; slow e2e is a timeout", async () => {
    assert.equal((await runE2eGate(fake({ labelError: "HTTP 422" }).args())).result, "unavailable");
    assert.equal((await runE2eGate(fake({ checks: [[chk("success", "skipped")]] }).args())).result, "unavailable");
    assert.equal((await runE2eGate(fake({ checks: [[chk("pending")]] }).args())).result, "timeout");
  });
  it("workflow path: dispatches the e2e workflow with the spec paths, wins over the label, judges the run of this head", async () => {
    const f = fake({ conclusion: "failure" });
    const r = await runE2eGate(f.args({ cfg: parseE2e({ e2e_label: "full-ci", e2e_workflow: "e2e.yml", e2e_paths_input: "specs" }) }));
    assert.equal(r.result, "fail"); assert.equal(r.runId, 9); assert.deepEqual(f.labels, []);
    assert.deepEqual(f.dispatched, [{ workflow: "e2e.yml", ref: "feat/issue-7-lean", inputs: { specs: "e2e/a.spec.ts" } }]);
  });
});
