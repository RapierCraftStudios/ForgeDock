// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { oldRanges, selectGuards, runGuards, commandFor, basePathOf, failingNames, guardFailures, supersessionComment, supersededIds, loadGuards } from "./guardgate.mjs";
import { applyAmendments, precheck } from "./conformance.mjs";
import { builderImplementPrompt, conformanceResumePrompt } from "./prompts.mjs";
import { tmpDir } from "../tests/_tmp.mjs";

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const gitIn = (cwd) => async (args) => sh(cwd, ...args);
const { NODE_TEST_CONTEXT: _ctx, ...CLEAN_ENV } = process.env; // the fixture runs node --test inside a test
const runCommand = async ({ command, cwd }) => { const r = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", env: CLEAN_ENV }); return { rc: r.status ?? 1, output: `${r.stdout}${r.stderr}` }; };
const put = (cwd, p, body) => { mkdirSync(join(cwd, p, ".."), { recursive: true }); writeFileSync(join(cwd, p), body); };

const TEST_SRC = (v) => `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { price } from "./a.mjs";\ntest("price is ${v}", () => assert.equal(price(), ${v}));\n`;

/** A repo whose fix commit (merge_sha) made price() return 2, guarded by src/a.test.mjs; the lane starts from it. */
function fixture(testSrc = TEST_SRC(2)) {
  const d = tmpDir("guardgate-");
  sh(d, "init", "-q", "-b", "main");
  put(d, "src/a.mjs", "export function price() {\n  return 1;\n}\n");
  sh(d, "add", "-A"); sh(d, "commit", "-qm", "init");
  put(d, "src/a.mjs", "export function price() {\n  return 2;\n}\n");
  put(d, "src/a.test.mjs", testSrc);
  sh(d, "add", "-A"); sh(d, "commit", "-qm", "fix: price");
  const sha = sh(d, "rev-parse", "HEAD").trim();
  put(d, "src/other.mjs", "export const x = 1;\n");
  sh(d, "add", "-A"); sh(d, "commit", "-qm", "later");
  sh(d, "update-ref", "refs/remotes/origin/main", "HEAD");
  sh(d, "checkout", "-qb", "lane");
  const guard = { v: 1, issue: 7, pr: 9, merge_sha: sha, tests: [{ path: "src/a.test.mjs", ids: [] }], hunks: [{ file: "src/a.mjs", start: 2, end: 2, symbol: "price" }], why: "price must be 2" };
  return { d, guard };
}
const commit = (d, m) => { sh(d, "add", "-A"); sh(d, "commit", "-qm", m); };
const files = (d) => sh(d, "diff", "--name-only", "origin/main...HEAD").split("\n").filter(Boolean);
const gate = async (d, guard, contract = {}) => {
  const git = gitIn(d);
  const { selected, mergeBase } = await selectGuards({ guards: [guard], files: files(d), git, base: "origin/main" });
  const r = selected.length ? await runGuards({ selected, mergeBase, contract, git, runCommand, cwd: d, env: process.env }) : null;
  return { selected, r };
};

test("a lane that reverts a guarded fix fails guard_broken even when it also edits the guard's test to pass", async () => {
  const { d, guard } = fixture();
  put(d, "src/a.mjs", "export function price() {\n  return 1;\n}\n"); // reverts the fix
  put(d, "src/a.test.mjs", TEST_SRC(1)); // and weakens the test so the lane's own copy passes
  commit(d, "revert");
  assert.equal((await runCommand({ command: "node --test src/a.test.mjs", cwd: d })).rc, 0, "the lane's own edited test passes");
  const { selected, r } = await gate(d, guard);
  assert.equal(selected.length, 1);
  assert.match(selected[0].reason, /src\/a\.mjs/);
  assert.equal(r.failures.length, 1, JSON.stringify({ runs: r.runs, skipped: r.skipped }));
  assert.equal(r.failures[0].code, "conformance.guard_broken");
  assert.equal(r.failures[0].guard, "#7");
  assert.match(r.failures[0].detail, /price must be 2/);
  assert.match(r.failures[0].detail, /src\/a\.test\.mjs/);
  assert.deepEqual(readdirSync(join(d, "src")).filter((f) => f.includes("__guardbase")), [], "base copies are removed");
  const pc = precheck({ contract: { requirements: [], deliverables: [{ id: "D1", path: "src/a.mjs" }, { id: "D2", path: "src/a.test.mjs" }], validate: [] }, result: {}, changedFiles: files(d), guardFailures: r.failures });
  assert.deepEqual(pc.failures.filter((f) => f.kind === "guard_broken").map((f) => f.guard), ["#7"]);
  assert.equal(pc.ok, false);
});

test("an accepted supersedes amendment passes the precheck and names the superseded guard for the issue comment", async () => {
  const { d, guard } = fixture();
  put(d, "src/a.mjs", "export function price() {\n  return 3;\n}\n");
  commit(d, "change");
  const { selected, r } = await gate(d, guard);
  assert.equal(r.failures.length, 1);
  const frozen = { requirements: [], deliverables: [{ id: "D1", path: "src/a.mjs" }], validate: [] };
  const a = applyAmendments(frozen, [{ kind: "supersedes", guard: "#7", why: "price is now 3 by product decision" }]);
  assert.deepEqual(a.problems, []);
  assert.deepEqual(a.applied, [{ kind: "supersedes", target: "#7", why: "price is now 3 by product decision" }]);
  const pc = precheck({ contract: a.contract, result: {}, changedFiles: ["src/a.mjs"], guardFailures: r.failures });
  assert.equal(pc.ok, true, JSON.stringify(pc.failures));
  const sup = supersededIds(a.contract, selected);
  assert.deepEqual(sup.map((s) => s.guard), ["#7"]);
  assert.match(supersessionComment({ guard: "#7", pr: 12, why: sup[0].why }), /#7 was superseded by PR #12: price is now 3/);
  assert.deepEqual(supersededIds(a.contract, []), [], "only selected guards are retired");
});

test("a supersedes amendment without a guard id is rejected", () => {
  const a = applyAmendments({ requirements: [], deliverables: [] }, [{ kind: "supersedes", why: "x" }, { kind: "supersedes", guard: "abc", why: "x" }]);
  assert.equal(a.problems.length, 2);
  assert.match(a.problems[0], /needs guard/);
});

test("a lane touching no guarded hunk selects nothing and runs no git or test", async () => {
  const { d, guard } = fixture();
  put(d, "src/other.mjs", "export const x = 2;\n");
  commit(d, "unrelated");
  const calls = [];
  const git = async (a) => { calls.push(a[0]); return gitIn(d)(a); };
  const r = await selectGuards({ guards: [guard], files: files(d), git, base: "origin/main" });
  assert.deepEqual(r.selected, []);
  assert.deepEqual(calls, [], "no git call at all");
  // same file as the guard but lines far from the hunk, with the guard's commit not the blamed one
  const big = { ...guard, hunks: [{ file: "src/a.mjs", start: 200, end: 210 }] };
  assert.deepEqual((await selectGuards({ guards: [big], files: files(d).concat("src/a.mjs"), git: gitIn(d), base: "origin/main" })).selected, []);
});

test("deleting or editing a guard's test selects it even when no guarded line changed", async () => {
  const { d, guard } = fixture();
  sh(d, "rm", "-q", "src/a.test.mjs");
  commit(d, "drop test");
  const { selected, r } = await gate(d, guard);
  assert.equal(selected.length, 1);
  assert.match(selected[0].reason, /edits or deletes its test/);
  assert.deepEqual(r.failures, [], "the base test still passes against the unchanged code");
  assert.equal(r.runs.length, 1);
});

test("a base test that cannot run in the cap, or has no known runner, is skipped and never blocks", async () => {
  const { d, guard } = fixture();
  put(d, "src/a.mjs", "export function price() {\n  return 1;\n}\n");
  commit(d, "revert");
  const git = gitIn(d);
  const { selected, mergeBase } = await selectGuards({ guards: [guard], files: files(d), git, base: "origin/main" });
  const slow = await runGuards({ selected, mergeBase, contract: {}, git, runCommand: async () => ({ rc: 124, output: "" }), cwd: d, env: {} });
  assert.deepEqual(slow.failures, []);
  assert.match(slow.skipped[0], /guard cap/);
  const none = await runGuards({ selected: [{ guard: { ...guard, tests: [{ path: "src/a.test.rb" }] }, reason: "" }], mergeBase, contract: {}, git, runCommand, cwd: d, env: {} });
  assert.match(none.skipped[0], /no runner/);
  assert.equal(existsSync(join(d, basePathOf("src/a.test.mjs"))), false);
});

test("pytest-style guards run through the contract's own validate command with the path substituted", () => {
  assert.equal(commandFor("tests/test_a__guardbase.py", { validate: [{ command: "pytest -q tests/test_a.py" }] }), "pytest -q tests/test_a__guardbase.py");
  assert.equal(commandFor("tests/test_a__guardbase.py", {}), "python -m pytest -q tests/test_a__guardbase.py");
  assert.equal(commandFor("src/a.test__guardbase.mjs", { validate: [{ command: "node --test src/a.test.mjs -t x" }] }), "node --test src/a.test__guardbase.mjs");
  assert.equal(commandFor("a.rb", {}), null);
  assert.equal(basePathOf("src/a.test.mjs"), "src/a.test__guardbase.mjs");
});

test("oldRanges reads old-side lines of non-test files and skips pure insertions", () => {
  const diff = "--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -3,2 +3 @@\n-a\n-b\n+c\n@@ -9,0 +9,2 @@\n+x\n+y\n@@ -20 +19,0 @@\n-z\n--- a/src/a.test.mjs\n+++ b/src/a.test.mjs\n@@ -1 +1 @@\n";
  assert.deepEqual(oldRanges(diff), { "src/a.mjs": [[3, 4], [20, 20]] });
});

test("guardFailures keeps only failing runs and loadGuards falls back to a stale index when GitHub is down", async () => {
  assert.deepEqual(guardFailures([{ issue: 1, rc: 0 }]), []);
  const root = tmpDir("guardgate-idx-");
  const fs = await import("node:fs");
  const { writeIndex } = await import("./guards.mjs");
  writeIndex("o/r", [{ issue: 3 }], { root });
  const old = new Date(Date.now() - 48 * 3600000);
  fs.utimesSync(join(root, "o_r.json"), old, old);
  const down = await loadGuards({ repo: "o/r", gh: async () => { throw new Error("offline"); }, root });
  assert.deepEqual(down, [{ issue: 3 }]);
  assert.deepEqual(await loadGuards({ repo: "o/none", gh: async () => "[]", root }), []);
});

test("guard_broken detail names the supersedes override and survives the resume prompt", async () => {
  const { d, guard } = fixture();
  put(d, "src/a.mjs", "export function price() {\n  return 3;\n}\n");
  commit(d, "change");
  const { r } = await gate(d, guard);
  assert.match(r.failures[0].detail, /"kind":"supersedes","guard":"#7"/);
  assert.match(r.failures[0].detail, /adding a code to an enum/);
  assert.match(conformanceResumePrompt(r.failures), /"kind":"supersedes","guard":"#7"/);
  assert.match(builderImplementPrompt("local"), /"kind":"supersedes","guard":"#N"/);
});

test("an additive enum change that updates its coverage test fails the guard without supersedes and passes with it", async () => {
  const d = tmpDir("guardgate-enum-");
  const cov = (codes) => `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { CODES } from "./codes.mjs";\ntest("every enum code has a declared coverage entry", () => assert.deepEqual(Object.values(CODES).sort(), ${JSON.stringify(codes)}));\n`;
  sh(d, "init", "-q", "-b", "main");
  put(d, "src/codes.mjs", "export const CODES = {\n  A: \"a\",\n};\n");
  put(d, "src/codes.test.mjs", cov(["a"]));
  sh(d, "add", "-A"); sh(d, "commit", "-qm", "fix: codes");
  const sha = sh(d, "rev-parse", "HEAD").trim();
  sh(d, "update-ref", "refs/remotes/origin/main", "HEAD");
  sh(d, "checkout", "-qb", "lane");
  put(d, "src/codes.mjs", "export const CODES = {\n  A: \"a\",\n  B: \"b\",\n};\n");
  put(d, "src/codes.test.mjs", cov(["a", "b"]));
  commit(d, "add code b");
  const guard = { v: 1, issue: 5, pr: 6, merge_sha: sha, tests: [{ path: "src/codes.test.mjs", ids: [] }], hunks: [{ file: "src/codes.mjs", start: 2, end: 2, symbol: "CODES" }], why: "enum coverage" };
  const { selected, r } = await gate(d, guard);
  assert.equal(selected.length, 1);
  assert.equal(r.failures.length, 1, JSON.stringify({ runs: r.runs, skipped: r.skipped }));
  const contract = { requirements: [], deliverables: [{ id: "D1", path: "src/codes.mjs" }, { id: "D2", path: "src/codes.test.mjs" }], validate: [] };
  const base = { result: {}, changedFiles: files(d), guardFailures: r.failures };
  const without = precheck({ contract, ...base });
  assert.deepEqual(without.failures.filter((f) => f.kind === "guard_broken").map((f) => f.guard), ["#5"]);
  const a = applyAmendments(contract, [{ kind: "supersedes", guard: "#5", why: "new code added to the closed enum" }]);
  const withIt = precheck({ contract: a.contract, ...base });
  assert.deepEqual(withIt.failures.filter((f) => f.kind === "guard_broken"), []);
});

// #4968: a guard test already red on the merge base must not block the lane
const FLAKY = (v) => `${TEST_SRC(v)}test("env dependent", () => assert.fail("red on base"));\n`;
const revert = (d) => { put(d, "src/a.mjs", "export function price() {\n  return 1;\n}\n"); commit(d, "revert"); };

test("a guard test that already fails on base is skipped (fails on base), not guard_broken", async () => {
  const { d, guard } = fixture(FLAKY(2));
  put(d, "src/a.mjs", "export function price() {\n  return 1 + 1;\n}\n"); // harmless edit of the guarded line
  commit(d, "refactor");
  const { selected, r } = await gate(d, guard);
  assert.equal(selected.length, 1);
  assert.equal(r.failures.length, 0, JSON.stringify(r));
  assert.ok(r.skipped.some((x) => /guard #7 .*fails on base/.test(x)), r.skipped.join("|"));
});

test("a test that passes on base and fails on the lane is blocked, with no skip", async () => {
  const { d, guard } = fixture();
  revert(d);
  const { r } = await gate(d, guard);
  assert.equal(r.failures.length, 1);
  assert.deepEqual(r.skipped, []);
  assert.match(r.failures[0].detail, /failing tests: price is 2:/);
});

test("a new failure in a file that already had one is blocked and its name leads the detail", async () => {
  const { d, guard } = fixture(FLAKY(2));
  revert(d);
  const { r } = await gate(d, guard);
  assert.equal(r.failures.length, 1, JSON.stringify({ skipped: r.skipped }));
  const detail = r.failures[0].detail;
  assert.match(detail, /failing tests: price is 2:\n/, "only the new failure is named");
  assert.ok(detail.indexOf("failing tests:") < detail.indexOf("not ok"), "names precede the output tail");
});

test("a passing guard adds no baseline worktree, and a failing one removes its worktree", async () => {
  const pass = fixture();
  const calls = [];
  const spy = (cwd) => async (args) => { calls.push(args[0]); return sh(cwd, ...args); };
  put(pass.d, "src/a.mjs", "export function price() {\n  return 1 + 1;\n}\n"); commit(pass.d, "refactor");
  let git = spy(pass.d);
  let { selected, mergeBase } = await selectGuards({ guards: [pass.guard], files: files(pass.d), git, base: "origin/main" });
  calls.length = 0;
  const ok = await runGuards({ selected, mergeBase, contract: {}, git, runCommand, cwd: pass.d, env: process.env });
  assert.equal(ok.failures.length, 0);
  assert.ok(!calls.includes("worktree"), calls.join(","));
  const bad = fixture();
  revert(bad.d);
  git = spy(bad.d);
  ({ selected, mergeBase } = await selectGuards({ guards: [bad.guard], files: files(bad.d), git, base: "origin/main" }));
  calls.length = 0;
  const r = await runGuards({ selected, mergeBase, contract: {}, git, runCommand, cwd: bad.d, env: process.env });
  assert.equal(r.failures.length, 1);
  assert.ok(calls.includes("worktree"));
  assert.equal(sh(bad.d, "worktree", "list").trim().split("\n").length, 1, "baseline worktree removed");
});

test("a baseline that cannot run is skipped, never blocking", async () => {
  const { d, guard } = fixture();
  revert(d);
  const git = async (a) => { if (a[0] === "worktree" && a[1] === "add") throw new Error("no worktree"); return sh(d, ...a); };
  const { selected, mergeBase } = await selectGuards({ guards: [guard], files: files(d), git, base: "origin/main" });
  const r = await runGuards({ selected, mergeBase, contract: {}, git, runCommand, cwd: d, env: process.env });
  assert.equal(r.failures.length, 0);
  assert.match(r.skipped[0], /baseline unavailable \(no worktree\)/);
});

test("failingNames reads TAP, spec and pytest output and ignores skips", () => {
  assert.deepEqual(failingNames("ok 1 - a\nnot ok 2 - b c\n    not ok 1 - nested # SKIP why\nnot ok 3 - d # TODO x"), ["b c"]);
  assert.deepEqual(failingNames("  ✖ spec one (1.2ms)\n✖ failing tests:\n  ✖ spec one (1.2ms)"), ["spec one"]);
  assert.deepEqual(failingNames("FAILED tests/t.py::test_x - assert 1 == 2"), ["tests/t.py::test_x"]);
  assert.equal(failingNames("all fine"), null);
});
