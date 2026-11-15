// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5718: verify.settle (condition wait for unreported gate checks) and verify.cancel_superseded.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GRACE_MS, SETTLE_MIN_MS, cancelSuperseded, parseCancelSuperseded, parseVerify, runCiVerify, settleKnown, supersededRuns } from "./verify.mjs";

/** A clock-driven fake: `checks(elapsedMs)` and `suites(elapsedMs)` answer by time since the first read. */
function fake({ checks, suites = null }) {
  const f = { clock: 0, suiteReads: 0, settle: [] };
  f.io = { commitChecks: async () => checks(f.clock), failedLogs: async () => "", ...(suites ? { checkSuites: async () => { f.suiteReads++; const s = suites(f.clock); if (s === "throw") throw new Error("HTTP 502"); return s; } } : {}) };
  f.args = (settle) => ({ io: f.io, branch: "feat/x", head: "abc123", changedFiles: ["src/a.ts"], verify: parseVerify({ mode: "ci", ...(settle ? { settle } : {}) }), gate: ["lint", "test"],
    now: () => f.clock, sleep: async (ms) => { f.clock += ms; }, random: () => 0.5, onSettle: (r) => f.settle.push(r) });
  return f;
}
const lintOnly = () => [{ name: "lint", state: "success", id: 1 }];
const done = (...ids) => ids.map((id) => ({ id, status: "completed", conclusion: "success" }));

describe("verify.settle config (#5718)", () => {
  it("defaults add no key: the parsed config is unchanged when settle and cancel_superseded are off", () => {
    assert.ok(!("settle" in parseVerify({}))); assert.ok(!("cancelSuperseded" in parseVerify({})));
    assert.ok(!("settle" in parseVerify({ settle: "fixed" }))); assert.ok(!("settle" in parseVerify({ settle: "soon" })));
    assert.ok(!("cancelSuperseded" in parseVerify({ cancel_superseded: "false" })));
    assert.equal(parseVerify({ settle: "Condition" }).settle, "condition"); assert.equal(parseVerify({ settle: "shadow" }).settle, "shadow");
    assert.equal(parseVerify({ cancel_superseded: "true" }).cancelSuperseded, "own"); assert.equal(parseVerify({ cancel_superseded: "all" }).cancelSuperseded, "all");
    assert.equal(parseCancelSuperseded("sometimes"), "off");
  });
  it("settleKnown: every suite completed, the same ids on two polls, and the minimum wait passed", () => {
    const k = (o) => settleKnown({ suites: done(1, 2), prev: ["1", "2"], elapsedMs: SETTLE_MIN_MS, ...o }).known;
    assert.equal(k({}), true);
    assert.equal(k({ prev: null }), false, "first poll");
    assert.equal(k({ prev: ["1"] }), false, "a suite appeared since the last poll");
    assert.equal(k({ elapsedMs: SETTLE_MIN_MS - 1 }), false);
    assert.equal(k({ suites: [...done(1), { id: 2, status: "queued" }] }), false, "a queued suite may still register checks");
    assert.equal(k({ suites: [...done(1), { id: 2, status: "in_progress" }] }), false);
    assert.equal(k({ suites: [], prev: [] }), false, "no suite yet");
    assert.equal(k({ suites: null, prev: [] }), false);
  });
});

describe("runCiVerify settle modes (#5718)", () => {
  it("fixed (default): waits the whole grace period for an unreported gate check and never reads check suites", async () => {
    for (const mode of [undefined, "fixed"]) {
      const f = fake({ checks: lintOnly, suites: () => done(1) });
      const r = await runCiVerify(f.args(mode));
      assert.equal(r.result, "pass"); assert.ok(f.clock >= DEFAULT_GRACE_MS); assert.equal(f.suiteReads, 0); assert.deepEqual(f.settle, []);
    }
  });
  it("condition: decides once the head's check suites are complete and stable, with the same verdict", async () => {
    const fixed = fake({ checks: lintOnly }), cond = fake({ checks: lintOnly, suites: () => done(1) });
    const a = await runCiVerify(fixed.args()), b = await runCiVerify(cond.args("condition"));
    assert.deepEqual({ result: b.result, detail: b.detail }, { result: a.result, detail: a.detail });
    assert.ok(cond.clock >= SETTLE_MIN_MS && cond.clock < DEFAULT_GRACE_MS / 2, `decided at ${cond.clock} ms`);
    assert.equal(cond.settle.length, 1); assert.equal(cond.settle[0].mode, "condition"); assert.deepEqual(cond.settle[0].missing, ["test"]); assert.equal(cond.settle[0].agreed, true);
  });
  it("condition: a suite that is still running keeps the wait, so a late required check still gates", async () => {
    const f = fake({ checks: (t) => (t < 120000 ? lintOnly() : [...lintOnly(), { name: "test", state: "failure", id: 2, url: "https://github.com/o/r/actions/runs/7/job/1" }]),
      suites: (t) => (t < 120000 ? [...done(1), { id: 2, status: "queued" }] : done(1, 2)) });
    const r = await runCiVerify(f.args("condition"));
    assert.equal(r.result, "fail"); assert.deepEqual(r.failures.map((x) => x.job), ["test"]); assert.ok(f.clock >= 120000);
  });
  it("condition: unreadable or absent check suites never shorten the wait; the grace period is the maximum", async () => {
    const f = fake({ checks: lintOnly, suites: () => "throw" });
    assert.equal((await runCiVerify(f.args("condition"))).result, "pass"); assert.ok(f.clock >= DEFAULT_GRACE_MS);
    const g = fake({ checks: lintOnly, suites: () => [{ id: 1, status: "in_progress" }] });
    await runCiVerify(g.args("condition")); assert.ok(g.clock >= DEFAULT_GRACE_MS);
    const h = fake({ checks: lintOnly }); // no seam: fixed
    await runCiVerify(h.args("condition")); assert.ok(h.clock >= DEFAULT_GRACE_MS);
  });
  it("shadow: waits as fixed and records when the condition held and whether the gating set agreed", async () => {
    const f = fake({ checks: lintOnly, suites: () => done(1) });
    const r = await runCiVerify(f.args("shadow"));
    assert.equal(r.result, "pass"); assert.ok(f.clock >= DEFAULT_GRACE_MS);
    assert.equal(f.settle.length, 1); assert.equal(f.settle[0].mode, "shadow"); assert.equal(f.settle[0].agreed, true);
    assert.ok(f.settle[0].known_at_ms < DEFAULT_GRACE_MS / 2 && f.settle[0].waited_ms >= DEFAULT_GRACE_MS);
    // a check that registers after every suite looked complete: the shadow record disagrees
    const g = fake({ checks: (t) => (t < 200000 ? [{ name: "docs", state: "success", id: 1 }] : [{ name: "docs", state: "success", id: 1 }, { name: "lint", state: "success", id: 2 }]), suites: (t) => (t < 200000 ? done(1) : done(1, 2)) });
    await runCiVerify(g.args("shadow"));
    assert.equal(g.settle[0].agreed, false);
  });
  it("no gate name missing: no suite read in any mode", async () => {
    const f = fake({ checks: () => [{ name: "lint", state: "success", id: 1 }, { name: "test", state: "success", id: 2 }], suites: () => done(1) });
    assert.equal((await runCiVerify(f.args("condition"))).result, "pass"); assert.equal(f.suiteReads, 0); assert.equal(f.clock, 0);
  });
});

describe("verify.cancel_superseded (#5718)", () => {
  const runs = [
    { id: 1, headSha: "old1", status: "in_progress", event: "pull_request", actor: "forge-bot[bot]", createdAt: "2026-03-01T10:00:00Z" },
    { id: 2, headSha: "old1", status: "queued", event: "pull_request", actor: "someone", createdAt: "2026-03-01T10:00:00Z" },
    { id: 3, headSha: "new2", status: "in_progress", event: "pull_request", actor: "forge-bot[bot]", createdAt: "2026-03-01T10:10:00Z" },
    { id: 4, headSha: "old1", status: "in_progress", event: "push", actor: "forge-bot[bot]", createdAt: "2026-03-01T10:00:00Z" },
    { id: 5, headSha: "old1", status: "completed", event: "pull_request", actor: "forge-bot[bot]", createdAt: "2026-03-01T10:00:00Z" },
    { id: 6, headSha: "old0", status: "in_progress", event: "pull_request_target", actor: "Forge-Bot[bot]", createdAt: "2026-03-01T09:00:00Z" },
  ];
  const ids = (o) => supersededRuns({ runs, head: "new2", actor: "forge-bot[bot]", ...o }).map((r) => r.id);
  it("own: only this actor's queued or running verification runs of an older head", () => {
    assert.deepEqual(ids({ mode: "own" }), [1, 6]);
    assert.deepEqual(ids({ mode: "all" }), [1, 2, 6]);
    assert.deepEqual(ids({ mode: "off" }), []); assert.deepEqual(ids({ mode: "own", actor: null }), []);
    assert.deepEqual(supersededRuns({ runs, head: null, mode: "all" }), []);
    assert.deepEqual(ids({ mode: "all", pushedAt: Date.parse("2026-03-01T09:30:00Z") }), [6], "a run created after the push is not superseded by it");
    assert.ok(!ids({ mode: "all" }).includes(4), "a push run may deploy: never cancelled");
    assert.ok(!ids({ mode: "all" }).includes(3), "the current head is never cancelled");
  });
  it("cancelSuperseded: off makes no call; on cancels through the seam and never throws", async () => {
    const calls = [];
    const io = { branchRuns: async (b) => { calls.push(`list ${b}`); return runs; }, cancelRun: async (id) => { calls.push(`cancel ${id}`); if (id === 6) throw new Error("HTTP 409"); }, viewerLogin: async () => "forge-bot[bot]" };
    assert.deepEqual(await cancelSuperseded({ io, branch: "release", head: "new2" }), { cancelled: [], failed: [], skipped: "off" });
    assert.deepEqual(calls, []);
    assert.deepEqual(await cancelSuperseded({ io, branch: "release", head: "new2", mode: "own" }), { cancelled: [1], failed: [6] });
    assert.deepEqual(calls, ["list release", "cancel 1", "cancel 6"]);
    assert.deepEqual((await cancelSuperseded({ io, branch: "release", head: "new2", mode: "all", dryRun: true })).cancelled, [1, 2, 6]);
    assert.equal((await cancelSuperseded({ io: { ...io, viewerLogin: async () => null }, branch: "release", head: "new2", mode: "own" })).skipped, "actor unknown");
    assert.equal((await cancelSuperseded({ io: { ...io, branchRuns: async () => { throw new Error("HTTP 502"); } }, branch: "release", head: "new2", mode: "all" })).skipped, "runs unreadable");
    assert.equal((await cancelSuperseded({ io: {}, branch: "release", head: "new2", mode: "all" })).skipped, "no seam");
  });
});

describe("forgedock ci cancel-superseded and the gh seams (#5718)", () => {
  it("ciRunSeams reads suites and runs through gh --paginate and cancels with one POST", async () => {
    const { ciRunSeams } = await import("./effects.mjs");
    const calls = [];
    const gh = async (args) => {
      calls.push(args.join(" "));
      if (args.includes("user")) return "forge-bot[bot]\n";
      if (/check-suites/.test(args.join(" "))) return '{"id":1,"status":"completed","conclusion":"success","app":"github-actions"}\n{"id":2,"status":"queued","conclusion":null,"app":"other"}\n';
      if (/status=queued/.test(args.join(" "))) return '{"id":7,"headSha":"old","status":"queued","event":"pull_request","actor":"forge-bot[bot]","createdAt":"2026-03-01T10:00:00Z"}\n';
      return "";
    };
    const io = ciRunSeams({ gh, repo: "acme/widgets" });
    assert.deepEqual((await io.checkSuites("abc")).map((s) => [s.id, s.status]), [[1, "completed"], [2, "queued"]]);
    assert.deepEqual((await io.branchRuns("feat/x y")).map((r) => r.id), [7]);
    await io.cancelRun(7);
    const prev = process.env.FORGE_BOT_LOGIN; delete process.env.FORGE_BOT_LOGIN;
    try { assert.equal(await io.viewerLogin(), "forge-bot[bot]"); process.env.FORGE_BOT_LOGIN = "app[bot]"; assert.equal(await io.viewerLogin(), "app[bot]"); }
    finally { if (prev === undefined) delete process.env.FORGE_BOT_LOGIN; else process.env.FORGE_BOT_LOGIN = prev; }
    assert.ok(calls[0].startsWith("api --paginate repos/acme/widgets/commits/abc/check-suites"));
    assert.ok(calls.some((c) => c.includes("actions/runs?branch=feat%2Fx%20y&status=in_progress")));
    assert.ok(calls.includes("api -X POST repos/acme/widgets/actions/runs/7/cancel"));
  });
  it("the CLI is off without the forge.yaml switch or --mode, and cancels for a PR head when on", async () => {
    const { cancelSupersededFromCli } = await import("./verify.mjs");
    const out = [], cancelled = [];
    const runs = [{ id: 1, headSha: "old", status: "in_progress", event: "pull_request", actor: "bot", createdAt: "2026-03-01T10:00:00Z" }, { id: 2, headSha: "new", status: "in_progress", event: "pull_request", actor: "bot", createdAt: "2026-03-01T10:05:00Z" }];
    const deps = (config = {}) => ({ print: (s) => out.push(s), repo: "acme/widgets", config, gh: async (args) => (args[0] === "pr" ? JSON.stringify({ headRefName: "release", headRefOid: "new" }) : "new\n"),
      seams: () => ({ branchRuns: async () => runs, cancelRun: async (id) => { cancelled.push(id); }, viewerLogin: async () => "bot" }) });
    assert.equal(await cancelSupersededFromCli(["--pr", "12"], deps()), 0);
    assert.match(out.pop(), /off \(set verify\.cancel_superseded/); assert.deepEqual(cancelled, []);
    assert.equal(await cancelSupersededFromCli(["--pr", "12", "--dry-run"], deps({ cancelSuperseded: "own" })), 0);
    assert.match(out.pop(), /release at new \(own, dry run\): 1 run\(s\) would be cancelled: 1/); assert.deepEqual(cancelled, []);
    assert.equal(await cancelSupersededFromCli(["--branch", "release", "--mode", "all"], deps()), 0);
    assert.deepEqual(cancelled, [1]);
    assert.equal(await cancelSupersededFromCli([], deps()), 2); assert.equal(await cancelSupersededFromCli(["--pr", "x"], deps()), 2);
  });
});
