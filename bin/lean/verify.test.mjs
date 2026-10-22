// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseVerify, matchesGlob, skipsCi, capLogs, runCiVerify, collectFailedLogs, verifyReport, DEFAULT_SKIP_PATHS, LOG_CAP, VERIFY_CHECK_NAME, VERIFY_TEXT_CAP, latestPerName, ciGate, rerunFailedOnce, rerunTarget } from "./verify.mjs";
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
    assert.deepEqual(parseVerify({}), { mode: "local", workflow: null, pathsInput: null, skipPaths: [...DEFAULT_SKIP_PATHS], maxRounds: 2, precheckTimeoutSeconds: 300, precheckTotalSeconds: 600, checkRun: false, checks: null });
    const v = parseVerify({ mode: "ci", workflow: ".github/workflows/verify.yml", paths_input: "changed_paths", skip_paths: "*.md, docs/** ,", max_rounds: "3" });
    assert.deepEqual(v, { mode: "ci", workflow: ".github/workflows/verify.yml", pathsInput: "changed_paths", skipPaths: ["*.md", "docs/**"], maxRounds: 3, precheckTimeoutSeconds: 300, precheckTotalSeconds: 600, checkRun: false, checks: null });
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

describe("CI verification gate, latest attempt and flake rerun (#4387)", () => {
  const CI = parseVerify({ mode: "ci" });
  const run = (id) => `https://github.com/o/r/actions/runs/${id}/job/1`;
  it("#4387 required checks gate: a red non-required storybook check passes when required lint and test are green", async () => {
    const f = fake({ checks: [[{ name: "lint", state: "success", id: 1, url: run(1) }, { name: "test", state: "success", id: 2, url: run(1) }, { name: "storybook (web)", state: "failure", id: 3, url: run(2) }]] });
    const r = await runCiVerify(f.args({ verify: CI, gate: ["lint", "test"] }));
    assert.equal(r.result, "pass"); assert.match(r.detail, /ignored non-gating: storybook \(web\)/); assert.deepEqual(f.logsFor, []);
    const g = fake({ checks: [[{ name: "lint", state: "failure", id: 1, url: run(1) }, { name: "test", state: "success", id: 2, url: run(1) }, { name: "storybook (web)", state: "failure", id: 3, url: run(2) }]] });
    const red = await runCiVerify(g.args({ verify: CI, gate: ["lint", "test"] }));
    assert.equal(red.result, "fail"); assert.deepEqual(red.failures.map((x) => x.job), ["lint"]);
    assert.deepEqual(red.failedChecks, [{ name: "lint", id: 1, url: run(1) }]);
  });
  it("#4387 latest attempt per name: a later green run of a check counts as green; a later red one as red", async () => {
    const f = fake({ checks: [[{ name: "test", state: "failure", id: 10, url: run(5) }, { name: "test", state: "success", id: 11, url: run(6) }, { name: "lint", state: "success", id: 9 }]] });
    assert.equal((await runCiVerify(f.args({ verify: CI }))).result, "pass");
    const g = fake({ checks: [[{ name: "test", state: "success", id: 10, url: run(5) }, { name: "test", state: "failure", id: 11, url: run(6) }]] });
    assert.equal((await runCiVerify(g.args({ verify: CI }))).result, "fail");
    // without ids the worst state of a name wins (unchanged conservative behaviour)
    assert.deepEqual(latestPerName([{ name: "t", state: "failure" }, { name: "t", state: "success" }]).map((c) => c.state), ["failure"]);
  });
  it("#4387 a gate name not reported yet is waited on for the grace period; with none reported every check gates", async () => {
    const f = fake({ checks: [[{ name: "lint", state: "success", id: 1 }], [{ name: "lint", state: "success", id: 1 }, { name: "test", state: "failure", id: 2, url: run(3) }]] });
    assert.equal((await runCiVerify(f.args({ verify: CI, gate: ["lint", "test"] }))).result, "fail");
    const g = fake({ checks: [[{ name: "storybook", state: "failure", id: 1, url: run(4) }]] });
    const r = await runCiVerify(g.args({ verify: CI, gate: ["lint", "test"] }));
    assert.equal(r.result, "fail"); assert.ok(g.clock >= 5 * 60000, "waited for the grace period first");
  });
  it("#4387 verify.checks overrides which checks gate CI verification", async () => {
    const v = parseVerify({ mode: "ci", checks: "lint, test ," });
    assert.deepEqual(v.checks, ["lint", "test"]);
    assert.deepEqual(parseVerify({ checks: ["a", " b"] }).checks, ["a", "b"]);
    const io = { requiredChecks: async () => ["build"] };
    assert.deepEqual(await ciGate({ io, lane: "staging", mergeWait: "required", verify: v }), ["lint", "test"]);
    assert.deepEqual(await ciGate({ io, lane: "staging", mergeWait: "required", verify: CI }), ["build"]);
    assert.equal(await ciGate({ io, lane: "staging", mergeWait: "all", verify: CI }), null);
    assert.equal(await ciGate({ io: { requiredChecks: async () => { throw new Error("404"); } }, lane: "staging", mergeWait: "required", verify: CI }), null);
    const f = fake({ checks: [[{ name: "lint", state: "success", id: 1 }, { name: "test", state: "success", id: 2 }, { name: "build", state: "failure", id: 3, url: run(1) }]] });
    assert.equal((await runCiVerify(f.args({ verify: v, gate: await ciGate({ io, lane: "staging", mergeWait: "required", verify: v }) }))).result, "pass");
  });
  it("#4387 rerunFailedOnce reruns each failed Actions run once; the re-verify waits for newer attempts", async () => {
    const reran = [];
    const v = { failures: [{ job: "test" }, { job: "types" }], failedChecks: [{ name: "test", id: 4, url: run(55) }, { name: "types", id: 5, url: run(55) }] };
    const rr = await rerunFailedOnce({ io: { rerunFailedJobs: async (id) => { reran.push(id); } }, v });
    assert.deepEqual([rr.ok, rr.runs, rr.jobs, reran], [true, ["55"], ["test", "types"], ["55"]]);
    assert.equal((await rerunFailedOnce({ io: {}, v })).ok, false);
    assert.match((await rerunFailedOnce({ io: { rerunFailedJobs: async () => { throw new Error("run too old"); } }, v })).detail, /run too old/);
    const f = fake({ checks: [[{ name: "test", state: "failure", id: 4, url: run(55) }], [{ name: "test", state: "pending", id: 6 }], [{ name: "test", state: "success", id: 6 }]] });
    const r = await runCiVerify(f.args({ verify: CI, rerunOf: rerunTarget({ failedChecks: [{ name: "test", id: 4 }] }) }));
    assert.equal(r.result, "pass"); assert.ok(f.clock > 0, "the stale red attempt was not judged");
  });
  it("#4387 workflow mode: the re-verify waits for the same run's next attempt", async () => {
    const f = fake({ runs: [[{ databaseId: 7, headSha: HEAD, status: "completed", conclusion: "failure", attempt: 1 }], [{ databaseId: 7, headSha: HEAD, status: "completed", conclusion: "success", attempt: 2 }]] });
    const r = await runCiVerify(f.args({ exclude: [7], rerunOf: rerunTarget({ runId: 7, attempt: 1 }) }));
    assert.equal(r.result, "pass"); assert.equal(r.runId, 7);
  });
});

describe("merge-time fix rounds and declared check commands (#4240)", () => {
  it("collectFailedLogs fetches one log per Actions run and caps the total", async () => {
    const fetched = [];
    const io = { failedLogs: async (id) => { fetched.push(id); return "x".repeat(LOG_CAP * 2); } };
    const out = await collectFailedLogs(io, [
      { name: "Unit tests", url: "https://github.com/o/r/actions/runs/9/job/1" },
      { name: "Shell tests", url: "https://github.com/o/r/actions/runs/9/job/2" },
      { name: "status", url: null },
    ]);
    assert.deepEqual(fetched, ["9"]);
    assert.deepEqual(out.map((f) => f.job), ["Unit tests", "Shell tests", "status"]);
    assert.ok(out[0].log.length > 0 && out[1].log === "" && out[2].log === "");
    assert.ok(out.reduce((n, f) => n + f.log.length, 0) <= LOG_CAP + 3);
    assert.deepEqual(await collectFailedLogs({ failedLogs: async () => { throw new Error("gone"); } }, [{ name: "a", url: "https://x/actions/runs/1" }]), [{ job: "a", url: "https://x/actions/runs/1", log: "" }]);
  });

  it("parseVerify precheck_timeout_seconds: default 300, integer 1-3600 accepted, others fall back", () => {
    assert.equal(parseVerify({}).precheckTimeoutSeconds, 300);
    assert.equal(parseVerify({ precheck_timeout_seconds: "60" }).precheckTimeoutSeconds, 60);
    for (const bad of ["0", "-5", "1.5", "abc", "3601"]) assert.equal(parseVerify({ precheck_timeout_seconds: bad }).precheckTimeoutSeconds, 300, bad);
  });
});

describe("forgedock/verify check run (#4270)", () => {
  const contract = { requirements: [{ id: "R1", disposition: "deliver" }], deliverables: [{ id: "D1", path: "src/a.ts", change: "x", requirements: ["R1"] }], validate: [{ id: "V1", command: "node --test t.mjs" }, { id: "V2", command: "tsc" }] };
  const result = { validation: [{ id: "V1", exit: 0 }, { id: "V2", ci: true }], requirements: [{ id: "R1", status: "implemented" }] };
  const out = (r) => JSON.parse(/```json\n([\s\S]*)\n```/.exec(r.text)[1]);

  it("#4318 parseVerify precheck_total_seconds: default 600, integer 1-7200 accepted, others fall back", () => {
    assert.equal(parseVerify({}).precheckTotalSeconds, 600);
    assert.equal(parseVerify({ precheck_total_seconds: "1800" }).precheckTotalSeconds, 1800);
    assert.equal(parseVerify({ precheck_total_seconds: "7200" }).precheckTotalSeconds, 7200);
    for (const bad of ["0", "-5", "1.5", "abc", "7201"]) assert.equal(parseVerify({ precheck_total_seconds: bad }).precheckTotalSeconds, 600, bad);
  });
  it("parseVerify: check_run is true only for the literal true; default false", () => {
    assert.equal(parseVerify({}).checkRun, false);
    assert.equal(parseVerify({ check_run: "true" }).checkRun, true);
    assert.equal(parseVerify({ check_run: true }).checkRun, true);
    for (const v of ["false", "yes", "1", ""]) assert.equal(parseVerify({ check_run: v }).checkRun, false, v);
    assert.equal(VERIFY_CHECK_NAME, "forgedock/verify");
  });

  it("success iff every gate passed; per-gate typed evidence from the computed results", () => {
    const r = verifyReport({ head: "abc", commands: [{ command: "npm run lint", rc: 0 }], structure: { package_edges_added: [{ from: "@s/a", to: "@s/b", manifest: "packages/a/package.json" }] },
      docs: { ok: true }, precheck: [], amendments: [], hotspots: true, contract, result });
    assert.equal(r.conclusion, "success");
    const g = Object.fromEntries(out(r).gates.map((x) => [x.id, x]));
    assert.deepEqual(g["precheck.commands"].evidence, [{ command: "npm run lint", rc: 0 }]);
    assert.deepEqual(g["structure.edges"].evidence, { added: ["@s/a→@s/b (packages/a/package.json)"] });
    assert.deepEqual(g["conformance.validate"].evidence, [{ id: "V1", command: "node --test t.mjs", exit: 0 }, { id: "V2", command: "tsc", ci: true }]);
    assert.deepEqual(g["conformance.requirements"].evidence, [{ id: "R1", status: "implemented" }]);
    assert.ok(Object.values(g).every((x) => x.ok));
  });

  it("each failing gate is failure with its evidence; gates without input are ok and marked not run", () => {
    const pre = [
      { kind: "scope_creep", detail: "changed outside the contract's deliverables: src/x.ts" },
      { kind: "validate_failed", detail: "validate V1 failed (exit 1)" },
      { kind: "requirement_unimplemented", detail: "R1 reported \"partial\"" },
      { kind: "hotspot_growth", detail: "src/big.ts grew by 300 lines" },
    ];
    const r = verifyReport({ head: "abc", commands: [{ command: "lint", rc: 2 }], structure: { package_edges_added: [] }, undeclaredEdges: [{ from: "@s/a", to: "@s/b" }],
      docs: { ok: false, output: "stale devdocs/x.md" }, precheck: pre, amendments: [{ detail: "add-deliverable without why" }], hotspots: true, contract, result });
    assert.equal(r.conclusion, "failure");
    const g = Object.fromEntries(r.gates.map((x) => [x.id, x]));
    assert.ok(r.gates.every((x) => !x.ok), "every gate failed");
    assert.deepEqual(g["precheck.commands"].evidence, ["lint (exit 2)"]);
    assert.deepEqual(g["structure.edges"].evidence, ["undeclared @s/a→@s/b"]);
    assert.match(g["conformance.scope"].evidence[0], /src\/x\.ts/);
    assert.match(g["maintenance.hotspot_growth"].evidence[0], /src\/big\.ts/);
    assert.match(r.title, /8 of 8/);

    const none = verifyReport({});
    assert.ok(none.gates.every((x) => x.ok && !x.ran && x.evidence === "not run"));
  });

  it("verifyReport with no gate results is neutral with \"no gates ran\" (#4297)", () => {
    for (const r of [verifyReport({}), verifyReport({ head: "abc" })]) {
      assert.equal(r.conclusion, "neutral");
      assert.equal(r.title, "no gates ran");
      assert.match(r.summary, /no gates ran/);
      assert.doesNotMatch(`${r.title}\n${r.summary}`, /passed|✅/);
    }
    // Only gates that ran are counted: one command round, nothing else.
    const one = verifyReport({ head: "abc", commands: [{ command: "lint", rc: 0 }] });
    assert.equal(one.conclusion, "success");
    assert.equal(one.title, "1 deterministic gate(s) passed");
    assert.match(one.summary, /`structure\.edges` \(not run\)/);
    const bad = verifyReport({ head: "abc", commands: [{ command: "lint", rc: 1 }] });
    assert.equal(bad.conclusion, "failure"); assert.equal(bad.title, "1 of 1 deterministic gate(s) failed");
  });

  it("the output text stays under the Checks API limit", () => {
    const r = verifyReport({ precheck: Array.from({ length: 2000 }, (_, i) => ({ kind: "scope_creep", detail: `changed outside: src/${"x".repeat(80)}${i}.ts` })), contract, result });
    assert.ok(r.text.length < 65535); assert.ok(r.text.length <= VERIFY_TEXT_CAP + 100);
    assert.equal(r.conclusion, "failure"); assert.equal(out(r).truncated, true);
  });

  it("runCiVerify never waits on the lane's own forgedock/verify check run", async () => {
    const f = fake({ checks: [[{ name: "ci", state: "success" }, { name: VERIFY_CHECK_NAME, state: "failure" }]] });
    const r = await runCiVerify(f.args({ verify: parseVerify({ mode: "ci" }) }));
    assert.equal(r.result, "pass");
    const g = fake({ checks: [[{ name: VERIFY_CHECK_NAME, state: "success" }], [{ name: "ci", state: "success" }]] });
    assert.equal((await runCiVerify(g.args({ verify: parseVerify({ mode: "ci" }) }))).detail, "1 check(s) green", "its own check alone is not CI");
  });
});
