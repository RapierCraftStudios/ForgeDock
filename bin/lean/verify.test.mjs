// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseVerify, matchesGlob, skipsCi, capLogs, runCiVerify, DEFAULT_SKIP_PATHS, LOG_CAP } from "./verify.mjs";
import { precheck } from "./conformance.mjs";

const HEAD = "abc123abc123abc123";
/** Fake io + clock: `runs` is a list of successive workflowRuns answers (the last repeats); `checks` likewise. */
function fake(o = {}) {
  const f = { clock: 0, dispatched: [], logsFor: [], pushes: 0, runsQ: [...(o.runs ?? [])], checksQ: [...(o.checks ?? [])] };
  f.io = {
    dispatchWorkflow: async (a) => { if (o.dispatchError) throw Object.assign(new Error("HTTP 422"), { stderr: o.dispatchError }); f.dispatched.push(a); },
    workflowRuns: async () => (f.runsQ.length > 1 ? f.runsQ.shift() : f.runsQ[0] ?? []),
    commitChecks: async () => (f.checksQ.length > 1 ? f.checksQ.shift() : f.checksQ[0] ?? []),
    failedLogs: async (id) => { f.logsFor.push(String(id)); return o.log ?? `log of ${id}`; },
  };
  f.args = (extra = {}) => ({ io: f.io, branch: "feat/issue-7-lean", head: HEAD, changedFiles: ["src/a.ts", ".forge-lean/result.json"], verify: parseVerify({ mode: "ci", workflow: "verify.yml", paths_input: "changed_paths" }),
    ciMaxMinutes: 30, now: () => f.clock, sleep: async (ms) => { f.clock += ms; }, random: () => 0.5, push: async () => { f.pushes++; }, ...extra });
  return f;
}

describe("verify-by-CI config (#4167)", () => {
  it("parseVerify defaults to local and rejects invalid values", () => {
    assert.deepEqual(parseVerify({}), { mode: "local", workflow: null, pathsInput: null, skipPaths: [...DEFAULT_SKIP_PATHS], maxRounds: 2 });
    const v = parseVerify({ mode: "ci", workflow: ".github/workflows/verify.yml", paths_input: "changed_paths", skip_paths: "*.md, docs/** ,", max_rounds: "3" });
    assert.deepEqual(v, { mode: "ci", workflow: ".github/workflows/verify.yml", pathsInput: "changed_paths", skipPaths: ["*.md", "docs/**"], maxRounds: 3 });
    assert.equal(parseVerify({ mode: "remote" }).mode, "local");
    assert.equal(parseVerify({ workflow: "x; rm -rf /" }).workflow, null);
    assert.equal(parseVerify({ max_rounds: "-1" }).maxRounds, 2);
    assert.equal(parseVerify({ max_rounds: "0" }).maxRounds, 0);
    assert.equal(parseVerify({ mode: "hybrid" }).mode, "hybrid");
  });
  it("globs: a pattern without / matches the basename anywhere; ** spans directories", () => {
    assert.ok(matchesGlob("README.md", "*.md")); assert.ok(matchesGlob("pkg/a/CHANGELOG.md", "*.md"));
    assert.ok(matchesGlob("docs/guide/x.png", "docs/**")); assert.ok(!matchesGlob("src/docs/x.ts", "docs/**"));
    assert.ok(!matchesGlob("src/a.ts", "*.md")); assert.ok(!matchesGlob("a.mdx.ts", "*.mdx"));
  });
  it("a docs-only change skips CI; one code file does not; .forge-lean files are ignored", () => {
    assert.ok(skipsCi(["README.md", "docs/a.md", ".forge-lean/result.json"]));
    assert.ok(!skipsCi(["README.md", "src/a.ts"]));
    assert.ok(!skipsCi(["poetry.lock"]), "a lock file is never docs-only");
  });
  it("capLogs keeps the tails within the cap", () => {
    const out = capLogs([{ job: "a", log: "x".repeat(50000) + "END-A" }, { job: "b", log: "short" }]);
    assert.ok(out[0].log.endsWith("END-A")); assert.ok(out[0].log.length <= LOG_CAP / 2 + 1); assert.equal(out[1].log, "short");
  });
  it("precheck: a CI-verified head covers validate ids left to CI; a recorded failure still fails", () => {
    const contract = { requirements: [], deliverables: [{ id: "D1", path: "src/a.ts", change: "x", requirements: [] }], validate: [{ id: "V1", command: "tsc" }, { id: "V2", command: "lint" }] };
    const result = { validation: [{ id: "V1", command: "tsc", ci: true }, { id: "V2", command: "lint", exit: 0 }] };
    const kinds = (r, ciVerified) => precheck({ contract, result: r, changedFiles: ["src/a.ts"], ciVerified }).failures.map((f) => f.kind);
    assert.deepEqual(kinds(result, false), ["validate_missing"]);
    assert.deepEqual(kinds(result, true), []);
    assert.deepEqual(kinds({ validation: [] }, true), []);
    assert.deepEqual(kinds({ validation: [{ id: "V1", exit: 0 }, { id: "V2", exit: 1 }] }, true), ["validate_failed"]);
  });
});

describe("runCiVerify (#4167)", () => {
  it("docs-only: skipped without a push or any CI call", async () => {
    const f = fake();
    const r = await runCiVerify(f.args({ changedFiles: ["README.md", "docs/x.md"] }));
    assert.equal(r.result, "skipped"); assert.equal(f.pushes, 0); assert.equal(f.dispatched.length, 0);
  });
  it("workflow: pushes, dispatches on the branch with the changed paths, waits for the run of this head, passes", async () => {
    const f = fake({ runs: [[], [{ databaseId: 9, headSha: HEAD, status: "in_progress" }], [{ databaseId: 9, headSha: HEAD, status: "completed", conclusion: "success", url: "u9" }]] });
    const r = await runCiVerify(f.args());
    assert.equal(r.result, "pass"); assert.equal(r.runId, 9); assert.equal(f.pushes, 1);
    assert.deepEqual(f.dispatched, [{ workflow: "verify.yml", ref: "feat/issue-7-lean", inputs: { changed_paths: "src/a.ts" } }]);
  });
  it("workflow: a red run returns the failed-job log; excluded (already judged) runs are never reused", async () => {
    const f = fake({ runs: [[{ databaseId: 1, headSha: HEAD, status: "completed", conclusion: "failure" }, { databaseId: 2, headSha: HEAD, status: "completed", conclusion: "failure", name: "verify", url: "u2" }]], log: "poetry.lock is out of date" });
    const r = await runCiVerify(f.args({ exclude: [1] }));
    assert.equal(r.result, "fail"); assert.equal(r.runId, 2); assert.deepEqual(f.logsFor, ["2"]);
    assert.deepEqual(r.failures, [{ job: "verify", url: "u2", log: "poetry.lock is out of date" }]);
  });
  it("workflow: a refused dispatch, or no run within the grace period, is unavailable (local fallback)", async () => {
    assert.equal((await runCiVerify(fake({ dispatchError: "workflow does not have workflow_dispatch trigger" }).args())).result, "unavailable");
    const r = await runCiVerify(fake({ runs: [[{ databaseId: 5, headSha: "other", status: "completed", conclusion: "success" }]] }).args());
    assert.equal(r.result, "unavailable"); assert.match(r.detail, /no verify\.yml run/);
  });
  it("slow CI is a timeout at the budget, never a failure", async () => {
    const f = fake({ runs: [[{ databaseId: 3, headSha: HEAD, status: "queued" }]] });
    const r = await runCiVerify(f.args({ ciMaxMinutes: 10 }));
    assert.equal(r.result, "timeout"); assert.ok(f.clock >= 10 * 60000);
  });
  it("no workflow: waits on the head's push-triggered checks and fetches each failed Actions run's log once", async () => {
    const f = fake({ checks: [[{ name: "lint", state: "pending" }], [{ name: "lint", state: "success" }, { name: "test", state: "failure", url: "https://github.com/o/r/actions/runs/55/job/1" }, { name: "types", state: "failure", url: "https://github.com/o/r/actions/runs/55/job/2" }]] });
    const r = await runCiVerify(f.args({ verify: parseVerify({ mode: "ci" }) }));
    assert.equal(r.result, "fail"); assert.deepEqual(f.logsFor, ["55"]); assert.equal(f.dispatched.length, 0);
    assert.deepEqual(r.failures.map((x) => [x.job, Boolean(x.log)]), [["test", true], ["types", false]]);
    const g = fake({ checks: [[]] });
    assert.equal((await runCiVerify(g.args({ verify: parseVerify({ mode: "ci" }) }))).result, "unavailable");
  });
});
