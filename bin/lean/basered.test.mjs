// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyBaseRed, baseRedPaths, issueOf, attribute, runOnBase, reportBaseRed, reportParityGaps, probeBase, bypassesGuard, cachedBaseVerdict, recordBaseVerdict, clearBaseVerdicts, BASE_PROBE_TTL_MS } from "./basered.mjs";

const SHA = "13834f1c51".padEnd(40, "0");

describe("base red (#5239)", () => {
  it("classifyBaseRed: base red only when the base run itself failed", () => {
    const failed = [{ command: "a" }, { command: "b" }, { command: "c" }, { command: "d" }];
    const r = classifyBaseRed({ failed, baseRuns: [{ command: "a", rc: 1 }, { command: "b", rc: 0 }, { command: "c", rc: 124 }] });
    assert.deepEqual(r.baseRed.map((f) => f.command), ["a"]);
    assert.deepEqual(r.laneOwn.map((f) => f.command), ["b", "c", "d"]);
    assert.deepEqual(classifyBaseRed({ failed, baseRuns: [] }).baseRed, [], "no base run: the failure stays the lane's");
  });

  it("baseRedPaths lists the guarded code before the guard's own test file", () => {
    const p = baseRedPaths([{ command: "pytest services/api/tests/test_rate_limit_rejection_sites_guard.py", output: "bare 429 at services/api/app/routers/listing_feeds.py:41" }]);
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
    const git = async (a) => { calls.push(a.slice(0, 3).join(" ")); return a[0] === "rev-parse" ? `${"d".repeat(40)}\n` : ""; };
    const envs = [];
    const out = await runOnBase({ commands: ["x", "y"], git, mergeBase: "origin/staging", cwd: "/nonexistent", timeoutMs: 1000, env: { A: "1" },
      runCommand: async ({ command, cwd, env }) => { cwds.push(cwd); envs.push(env); return { rc: command === "x" ? 1 : 0, output: `${"z".repeat(5000)}tail-${command}` }; } });
    assert.deepEqual(out.map((o) => [o.command, o.rc]), [["x", 1], ["y", 0]]);
    assert.equal(out[0].output.length, 4096); assert.ok(out[0].output.endsWith("tail-x"), "the tail of the output is kept");
    assert.deepEqual(envs[0], { A: "1", BASE_SHA: "d".repeat(40), LANE_CHECK_BASE: "d".repeat(40) });
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
    assert.ok(gh.some((a) => a[1] === "create"));
    assert.equal(await reportBaseRed({ ghc: async () => { throw new Error("x"); }, repo: "o/r", base: "s", att: null, laneIssue: 5, commands: ["c"] }), null);
  });
});

describe("base red dedupe and env classification (#5945)", () => {
  const SHA12 = "a".repeat(12);
  const fake = (issues) => { const log = []; const ghc = async (a) => { log.push(a); if (a[1] === "list") return JSON.stringify(issues.filter((i) => i.body)); if (a[1] === "create") { issues.push({ number: 90, state: "OPEN", createdAt: new Date().toISOString(), body: a[a.indexOf("--body") + 1] }); return "https://github.com/o/r/issues/90\n"; } return ""; }; return { log, ghc }; };
  const args = (ghc, extra = {}) => ({ ghc, repo: "o/r", base: "staging", att: null, baseSha: "a".repeat(40), laneIssue: 5, commands: ["g"], outputs: { g: "boom ENDTAIL" }, ...extra });

  it("two lanes with the same base+sha give one create then a comment; body holds the base output", async () => {
    const { log, ghc } = fake([]);
    assert.equal(await reportBaseRed(args(ghc)), 90);
    assert.equal(await reportBaseRed(args(ghc, { laneIssue: 6 })), 90);
    assert.equal(log.filter((a) => a[1] === "create").length, 1);
    assert.equal(log.filter((a) => a[1] === "comment").length, 1);
    const body = log.find((a) => a[1] === "create")[log.find((a) => a[1] === "create").indexOf("--body") + 1];
    assert.match(body, /boom ENDTAIL/); assert.ok(body.includes(`staging@${SHA12}`));
  });

  it("a closed match is reopened only when closed after the commit; within 24h it is commented, not duplicated", async () => {
    const key = `<!-- FORGE:BASE_RED_KEY staging@${SHA12} -->`;
    const old = new Date(Date.now() - 3 * 86400000).toISOString(), recent = new Date(Date.now() - 3600000).toISOString();
    let f = fake([{ number: 7, state: "CLOSED", createdAt: old, closedAt: old, body: key }]);
    await reportBaseRed(args(f.ghc, { commitDate: new Date(Date.now() - 86400000).toISOString() }));
    assert.ok(!f.log.some((a) => a[1] === "reopen"), "closed before the commit: not reopened");
    assert.ok(f.log.some((a) => a[1] === "create"), "older than a day: a new issue");
    f = fake([{ number: 7, state: "CLOSED", createdAt: old, closedAt: recent, body: key }]);
    assert.equal(await reportBaseRed(args(f.ghc, { commitDate: new Date(Date.now() - 86400000).toISOString() })), 7);
    assert.ok(f.log.some((a) => a[1] === "reopen"));
    f = fake([{ number: 8, state: "CLOSED", createdAt: recent, closedAt: recent, body: key }]);
    assert.equal(await reportBaseRed(args(f.ghc)), 8, "rate limit: one issue per base+sha per day");
    assert.ok(!f.log.some((a) => a[1] === "create" || a[1] === "reopen"));
  });

  it("classifyBaseRed: env signatures in the base output are env, not base red (and a clean red stays base red)", () => {
    const failed = ["a", "b", "c", "d"].map((command) => ({ command, rc: 1 }));
    const baseRuns = [{ command: "a", rc: 1, output: "ModuleNotFoundError: No module named x" }, { command: "b", rc: 1, output: "gh: fail closed" }, { command: "c", rc: 1, output: "fatal: bad revision 'origin/staging...HEAD'" }, { command: "d", rc: 1, output: "AssertionError: real" }];
    const r = classifyBaseRed({ failed, baseRuns });
    assert.deepEqual(r.env.map((f) => f.command), ["a", "b", "c"]); assert.deepEqual(r.baseRed.map((f) => f.command), ["d"]); assert.deepEqual(r.laneOwn, []);
  });
});

describe("reportTrainBaseRed (#5838)", () => {
  it("files a base-red issue naming the checks, the base tip and the batch, without a lane", async () => {
    const calls = []; const ghc = async (a) => { calls.push(a); return "https://github.com/o/r/issues/77\n"; };
    const { reportTrainBaseRed } = await import("./basered.mjs");
    assert.equal(await reportTrainBaseRed({ ghc, repo: "o/r", base: "staging", baseSha: "c".repeat(40), checks: [{ name: "build", url: "https://ci/1" }], batch: "b1" }), 77);
    const cr = calls.find((a) => a[1] === "create");
    const body = cr[cr.indexOf("--body") + 1];
    assert.match(body, /FORGE:BASE_RED/); assert.match(body, /`build` https:\/\/ci\/1/); assert.match(body, /batch b1/); assert.doesNotMatch(body, /Lane #/);
    assert.match(cr[cr.indexOf("--title") + 1], /staging is red on required check build/);
  });
});

describe("base probe cache (#5992)", () => {
  const SHA2 = "2".repeat(40);
  const mk = (sha, rc = 1) => {
    const calls = { run: 0 };
    const git = async (a) => (a[0] === "rev-parse" ? sha : a[0] === "log" ? `${sha}\x1ffix: x (#7)\x1f` : "");
    const runCommand = async () => { calls.run++; return { rc, output: "tests/guard.test.mjs failed" }; };
    return { calls, git, runCommand, readSha: async () => sha };
  };
  const base = { repo: "o/r", base: "staging", commands: ["guard"], cwd: process.cwd(), timeoutMs: 1000 };

  it("hit within the TTL: one probe run serves every later call and carries the attribution", async () => {
    clearBaseVerdicts();
    const m = mk(SHA);
    const a = await probeBase({ ...base, ...m, now: 1000 });
    const b = await probeBase({ ...base, ...m, now: 1000 + BASE_PROBE_TTL_MS - 1 });
    assert.equal(m.calls.run, 1);
    assert.equal(a.red, true);
    assert.deepEqual(b, a);
    assert.equal(b.att.issue, 7);
  });

  it("miss after the TTL", async () => {
    clearBaseVerdicts();
    const m = mk(SHA);
    await probeBase({ ...base, ...m, now: 1000 });
    await probeBase({ ...base, ...m, now: 1000 + BASE_PROBE_TTL_MS });
    assert.equal(m.calls.run, 2);
  });

  it("miss when the base sha moves; a green base is cached as not red", async () => {
    clearBaseVerdicts();
    const m = mk(SHA);
    await probeBase({ ...base, ...m, now: 1000 });
    const m2 = mk(SHA2, 0);
    const v = await probeBase({ ...base, ...m2, now: 1001 });
    assert.equal(m2.calls.run, 1);
    assert.equal(v.red, false);
    assert.equal(cachedBaseVerdict({ repo: "o/r", base: "staging", sha: SHA, now: 1002 }), null);
  });

  it("a lane's recorded red verdict is reused without a probe run; an env failure is no verdict of red", async () => {
    clearBaseVerdicts();
    recordBaseVerdict({ repo: "o/r", base: "staging", sha: SHA, red: true, commands: ["guard"], now: 5 });
    const m = mk(SHA);
    assert.equal((await probeBase({ ...base, ...m, now: 6 })).red, true);
    assert.equal(m.calls.run, 0);
    clearBaseVerdicts();
    const env = mk(SHA);
    env.runCommand = async () => ({ rc: 1, output: "ModuleNotFoundError: x" });
    assert.equal((await probeBase({ ...base, ...env, now: 7 })).red, false);
  });
});

describe("#5992: path-scoped guard bypass", () => {
  const att = { sha: "a".repeat(40), files: ["src/guard.mjs", "tests/dir"] };
  it("bypasses a lane clear of the guarded surface", () => assert.equal(bypassesGuard({ laneFiles: ["docs/a.md"], att }), true));
  it("does not bypass when the lane touches a named file or a file under a named dir", () => {
    assert.equal(bypassesGuard({ laneFiles: ["docs/a.md", "src/guard.mjs"], att }), false);
    assert.equal(bypassesGuard({ laneFiles: ["tests/dir/x.mjs"], att }), false);
  });
  it("does not bypass without a known surface or lane diff, or on a sibling-prefix name", () => {
    assert.equal(bypassesGuard({ laneFiles: ["a"], att: null }), false);
    assert.equal(bypassesGuard({ laneFiles: [], att }), false);
    assert.equal(bypassesGuard({ laneFiles: ["tests/directory.mjs"], att }), true);
  });
});

// #6238: a fake issue tracker whose search ignores hidden markers (as GitHub's does): dedupe must not rely on it.
const tracker = () => {
  const issues = []; const log = [];
  const ghc = async (a) => {
    log.push(a);
    if (a[1] === "list") return JSON.stringify(issues);
    if (a[1] === "create") { issues.push({ number: issues.length + 1, state: "OPEN", closedAt: null, createdAt: new Date().toISOString(), body: a[a.indexOf("--body") + 1] }); return `https://github.com/o/r/issues/${issues.length}`; }
    if (a[1] === "reopen") { issues.find((i) => i.number === Number(a[2])).state = "OPEN"; return ""; }
    return "";
  };
  return { issues, log, ghc };
};
describe("#6238 engine-filed issue dedupe", () => {
  it("a parity gap with a punctuated context name is filed once over repeated runs", async () => {
    const t = tracker();
    const gaps = [{ context: "CI / build (linux): e2e", reason: "no lane equivalent" }];
    const first = await reportParityGaps({ ghc: t.ghc, repo: "o/r", release: "main", gaps });
    const second = await reportParityGaps({ ghc: t.ghc, repo: "o/r", release: "main", gaps });
    assert.deepEqual(first, [1]);
    assert.deepEqual(second, []);
    assert.equal(t.issues.length, 1);
  });
  it("a closed parity-gap issue is reopened, not refiled", async () => {
    const t = tracker();
    const gaps = [{ context: "CI", reason: "x" }];
    await reportParityGaps({ ghc: t.ghc, repo: "o/r", release: "main", gaps });
    t.issues[0].state = "CLOSED"; t.issues[0].closedAt = new Date().toISOString();
    assert.deepEqual(await reportParityGaps({ ghc: t.ghc, repo: "o/r", release: "main", gaps }), []);
    assert.equal(t.issues.length, 1);
    assert.equal(t.issues[0].state, "OPEN");
  });
  it("base-red reported repeatedly for one base sha is one issue", async () => {
    const t = tracker();
    const a = { ghc: t.ghc, repo: "o/r", base: "main", att: null, laneIssue: 5, commands: ["npm test"], outputs: {}, baseSha: "abcdef1234567890" };
    const x = await reportBaseRed(a), y = await reportBaseRed(a);
    assert.equal(x, y);
    assert.equal(t.issues.length, 1);
  });
});
