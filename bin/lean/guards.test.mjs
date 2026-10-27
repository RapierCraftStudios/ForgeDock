// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { buildGuard, guardTests, parseHunks, renderGuard, parseGuard, guardIssue, listGuards, backfill, guardsCli, readIndex, guardAfterMerge } from "./guards.mjs";
import { renderContract } from "./render.mjs";
import { tmpDir } from "../tests/_tmp.mjs";

const DIFF = `diff --git a/src/a.mjs b/src/a.mjs
--- a/src/a.mjs
+++ b/src/a.mjs
@@ -10,2 +10,3 @@ export function fixed() {
-x
+y
+z
@@ -30 +31,0 @@ function other() {
-gone
diff --git a/test/a.test.mjs b/test/a.test.mjs
--- a/test/a.test.mjs
+++ b/test/a.test.mjs
@@ -1,0 +2,3 @@
+t
`;
const nodeContract = { repro_test: { path: "test/a.test.mjs", id: "fixed keeps x", command: "node --test test/a.test.mjs" }, validate: [{ id: "V1", command: "node --test test/a.test.mjs --test-name-pattern=\"fixed keeps x\"" }] };
const pyContract = { repro_test: { path: "tests/test_a.py", command: "pytest -q tests/test_a.py::test_fixed" }, validate: [{ id: "V1", command: "pytest -q tests/test_a.py -k fixed" }, { id: "V2", command: "pytest -q tests/test_b.py" }] };

test("node --test fixture: file and id, hunks exclude test files with symbol and deletion anchor", () => {
  const { guard } = buildGuard({ issue: 7, title: "Fix  x\nbug", pr: 9, mergeSha: "abc", contract: nodeContract, diff: DIFF });
  assert.deepEqual(guard.tests, [{ path: "test/a.test.mjs", ids: ["fixed keeps x"] }]);
  assert.deepEqual(guard.hunks, [{ file: "src/a.mjs", start: 10, end: 12, symbol: "export function fixed() {" }, { file: "src/a.mjs", start: 32, end: 32, symbol: "function other() {" }]);
  assert.equal(guard.why, "Fix x bug");
});

test("pytest fixture: ::ids and -k, every test file named", () => {
  const t = guardTests(pyContract);
  assert.deepEqual(t.find((x) => x.path === "tests/test_a.py").ids.sort(), ["fixed", "test_fixed"]);
  assert.deepEqual(t.find((x) => x.path === "tests/test_b.py").ids, []); // file granularity
});

test("a contract without a test yields no guard and says why", () => {
  assert.match(buildGuard({ issue: 1, contract: { repro_test: "none", repro_test_reason: "docs only", validate: [{ command: "npm run lint" }] } }).reason, /repro_test none \(docs only\)/);
  assert.match(buildGuard({ issue: 1, contract: { validate: [] } }).reason, /names no test/);
});

test("render/parse round trip survives '-->' in a field", () => {
  const g = { v: 1, issue: 3, why: "a --> b <x>", tests: [], hunks: [] };
  const body = renderGuard(g);
  assert.equal(body.match(/-->/g).length, 1);
  assert.deepEqual(parseGuard(body), g);
});

function fakeGh({ contract, comments = [], title = "Fix the thing" }) {
  const posted = [];
  const body = `<!-- FORGE:CONTRACT -->\n${renderContract({ requirements: [], deliverables: [], preserve: [], validate: [], ...contract }, "abcdef123456")}`;
  const gh = async (a) => {
    if (a[0] === "issue" && a[1] === "view") return JSON.stringify({ number: 7, title, comments: [{ body }, ...comments, ...posted.map((b) => ({ body: b }))] });
    if (a[0] === "pr" && a[1] === "view") return JSON.stringify({ number: 9, mergeCommit: { oid: "deadbeefcafe" } });
    if (a[0] === "issue" && a[1] === "comment") { posted.push(a[a.indexOf("--body") + 1]); return ""; }
    throw new Error(`unexpected gh ${a.join(" ")}`);
  };
  return { gh, posted };
}
const git = async (a) => { assert.deepEqual(a.slice(0, 2), ["diff", "-U0"]); assert.ok(a.includes("deadbeefcafe^1")); return DIFF; };

test("guardIssue posts exactly one FORGE:GUARD and is idempotent on rerun", async () => {
  const f = fakeGh({ contract: nodeContract });
  const r1 = await guardIssue({ gh: f.gh, git, repo: "o/r", issue: 7, pr: 9 });
  assert.ok(r1.posted);
  const r2 = await guardIssue({ gh: f.gh, git, repo: "o/r", issue: 7, pr: 9 });
  assert.ok(r2.exists);
  assert.equal(f.posted.length, 1);
  assert.equal(parseGuard(f.posted[0]).merge_sha, "deadbeefcafe");
});

test("guardIssue: no test posts nothing; unavailable merge commit is a logged skip", async () => {
  const f = fakeGh({ contract: { repro_test: "none", repro_test_reason: "n/a" } });
  assert.ok((await guardIssue({ gh: f.gh, git, repo: "o/r", issue: 7, pr: 9 })).skipped);
  assert.equal(f.posted.length, 0);
  const g = fakeGh({ contract: nodeContract });
  const r = await guardIssue({ gh: g.gh, git: async () => { throw new Error("bad object"); }, repo: "o/r", issue: 7, pr: 9 });
  assert.match(r.reason, /not available locally/);
});

test("listGuards filters by hunk file, test file or directory", () => {
  const gs = [buildGuard({ issue: 7, contract: nodeContract, diff: DIFF }).guard, buildGuard({ issue: 8, contract: pyContract, diff: "" }).guard];
  assert.deepEqual(listGuards(gs, { path: "src/a.mjs" }).map((g) => g.issue), [7]);
  assert.deepEqual(listGuards(gs, { path: "tests" }).map((g) => g.issue), [8]);
  assert.deepEqual(listGuards(gs, { path: "nope.js" }), []);
  assert.equal(listGuards(gs).length, 2);
});

test("backfill guards merged lanes and logs why a lane without a test yields none", async () => {
  const withTest = fakeGh({ contract: nodeContract }), noTest = fakeGh({ contract: { validate: [] } });
  const by = { 1: withTest, 2: noTest };
  const gh = async (a) => {
    if (a[0] === "issue" && a[1] === "list") return JSON.stringify([{ number: 1 }, { number: 2 }]);
    if (a[0] === "pr" && a[1] === "list") return JSON.stringify([{ number: 9, body: `Closes #${a.join(" ").match(/#(\d+) in:body/)[1]}`, mergeCommit: { oid: "deadbeefcafe" } }]);
    return by[a[2]].gh(a);
  };
  const logs = [];
  const r = await backfill({ gh, git, repo: "o/r", since: "2026-01-01", log: (m) => logs.push(m) });
  assert.deepEqual(r.posted, [1]);
  assert.equal(r.skipped[0].issue, 2);
  assert.match(logs[0], /names no test/);
  assert.equal(withTest.posted.length, 1);
});

test("guards list prints guards for a path and caches the index; falls back to it offline", async () => {
  const root = tmpDir("guards-");
  {
    const g = buildGuard({ issue: 7, title: "t", contract: nodeContract, diff: DIFF }).guard;
    const gh = async () => JSON.stringify([{ number: 7, comments: [{ body: renderGuard(g) }] }]);
    const out = [];
    assert.equal(await guardsCli(["list", "--path", "src/a.mjs"], { gh, repo: "o/r", print: (m) => out.push(m), root }), 0);
    assert.match(out[0], /#7/);
    assert.equal(readIndex("o/r", { root }).length, 1);
    const off = [];
    await guardsCli(["list", "--path", "test/a.test.mjs"], { gh: async () => { throw new Error("offline"); }, repo: "o/r", print: (m) => off.push(m), root });
    assert.match(off[0], /#7/);
  }
});
test("parseHunks ignores deleted files", () => {
  assert.deepEqual(parseHunks("--- a/x.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n"), []);
});
test("guardAfterMerge fetches the bare branch (not origin/<lane>) and the merge sha when absent locally", async () => {
  const calls = [];
  let have = false;
  const body = `<!-- FORGE:CONTRACT -->\n${renderContract({ requirements: [], deliverables: [], preserve: [], ...nodeContract }, "abcdef123456")}`;
  const io = {
    gh: async (a) => a[0] === "issue" ? JSON.stringify({ number: 9, title: "t", comments: [{ body }] }) : a[0] === "pr" ? JSON.stringify({ number: 3, mergeCommit: { oid: "abc123" } }) : "",
    git: async (a) => { calls.push(a.join(" ")); if (a[0] === "diff") { if (!have) throw new Error("bad object"); return DIFF; } if (a.join(" ") === "fetch origin abc123") have = true; return ""; },
  };
  const r = await guardAfterMerge({ io, repo: "o/r", issue: 9, pr: 3, cwd: "/x", base: "origin/staging" });
  assert.ok(calls.includes("fetch origin staging"));
  assert.ok(!calls.some((c) => c.includes("origin/staging")));
  assert.ok(r.posted, JSON.stringify(r));
});
