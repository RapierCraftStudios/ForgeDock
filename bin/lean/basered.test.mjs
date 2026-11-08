// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify, namedPaths, issueOf, attribute, runOnBase, reportBaseRed } from "./basered.mjs";

const SHA = "13834f1c51".padEnd(40, "0");

describe("base red (#5239)", () => {
  it("classify: base red only when the base run itself failed", () => {
    const failed = [{ command: "a" }, { command: "b" }, { command: "c" }, { command: "d" }];
    const r = classify({ failed, baseRuns: [{ command: "a", rc: 1 }, { command: "b", rc: 0 }, { command: "c", rc: 124 }] });
    assert.deepEqual(r.baseRed.map((f) => f.command), ["a"]);
    assert.deepEqual(r.laneOwn.map((f) => f.command), ["b", "c", "d"]);
    assert.deepEqual(classify({ failed, baseRuns: [] }).baseRed, [], "no base run: the failure stays the lane's");
  });

  it("namedPaths lists the guarded code before the guard's own test file", () => {
    const p = namedPaths([{ command: "pytest services/api/tests/test_rate_limit_rejection_sites_guard.py", output: "bare 429 at services/api/app/routers/listing_feeds.py:41" }]);
    assert.deepEqual(p.src, ["services/api/app/routers/listing_feeds.py"]);
    assert.deepEqual(p.tests, ["services/api/tests/test_rate_limit_rejection_sites_guard.py"]);
  });

  it("issueOf prefers a closing keyword, then the issue branch, then the last (#N)", () => {
    assert.equal(issueOf("feat: x (#40001)", "Closes #39805"), 39805);
    assert.equal(issueOf("Merge pull request #39996 from o/feat/issue-39805-lean", ""), 39805);
    assert.equal(issueOf("feat(api): feeds (#39805)", ""), 39805);
    assert.equal(issueOf("chore: nothing", ""), null);
  });

  it("attribute names the newest base commit touching the guarded code, else the tests; null when none", async () => {
    const calls = [];
    const git = async (a) => { calls.push(a); return a.includes("services/api/app/routers/listing_feeds.py") ? `${SHA}\x1ffeat(api): listing feeds (#39805)\x1f` : ""; };
    const failed = [{ command: "pytest t/test_guard.py", output: "bare 429 at services/api/app/routers/listing_feeds.py" }];
    const att = await attribute({ failed, git, base: "origin/staging" });
    assert.equal(att.sha, SHA); assert.equal(att.issue, 39805);
    assert.deepEqual(calls[0].slice(0, 5), ["log", "-1", "--format=%H%x1f%s%x1f%b", "origin/staging", "--"]);
    assert.equal(await attribute({ failed: [{ command: "make guard", output: "" }], git, base: "origin/staging" }), null);
    assert.equal(await attribute({ failed, git: async () => { throw new Error("boom"); }, base: "b" }), null);
  });

  it("runOnBase runs each command in a detached base worktree and removes it", async () => {
    const calls = [], cwds = [];
    const git = async (a) => { calls.push(a.slice(0, 3).join(" ")); return ""; };
    const out = await runOnBase({ commands: ["x", "y"], git, mergeBase: "origin/staging", cwd: "/nonexistent", timeoutMs: 1000,
      runCommand: async ({ command, cwd }) => { cwds.push(cwd); return { rc: command === "x" ? 1 : 0 }; } });
    assert.deepEqual(out, [{ command: "x", rc: 1 }, { command: "y", rc: 0 }]);
    assert.match(calls[0], /^worktree add --detach$|^worktree add --detach /);
    assert.ok(calls.some((c) => c.startsWith("worktree remove --force")));
    assert.equal(cwds[0], cwds[1]);
    assert.deepEqual(await runOnBase({ commands: ["x"], git: async () => { throw new Error("no"); }, runCommand: async () => ({ rc: 0 }), mergeBase: "b", cwd: "/x" }), [], "no base tree: no verdict");
  });

  it("reportBaseRed reopens a closed introducing issue and comments; files a new issue when unattributable", async () => {
    const gh = [];
    const ghc = async (a) => { gh.push(a); return a[1] === "view" ? "CLOSED\n" : a[1] === "create" ? "https://github.com/o/r/issues/77\n" : ""; };
    const n = await reportBaseRed({ ghc, repo: "o/r", base: "staging", att: { sha: SHA, subject: "feat", issue: 39805 }, laneIssue: 5, commands: ["pytest g"] });
    assert.equal(n, 39805);
    assert.deepEqual(gh.map((a) => a[1]), ["view", "reopen", "comment"]);
    assert.match(gh[2].at(-1), /FORGE:BASE_RED[\s\S]*Lane #5 is deferred/);
    gh.length = 0;
    assert.equal(await reportBaseRed({ ghc, repo: "o/r", base: "staging", att: null, laneIssue: 5, commands: ["pytest g"] }), 77);
    assert.equal(gh[0][1], "create");
    assert.equal(await reportBaseRed({ ghc: async () => { throw new Error("x"); }, repo: "o/r", base: "s", att: null, laneIssue: 5, commands: ["c"] }), null);
  });
});
