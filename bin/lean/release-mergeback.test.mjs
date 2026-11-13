// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { syncStep, finishSync, syncBlocksRelease, syncValidated, parseHunks, duplicateFixes, staleMilestones, targetSet } from "./release-mergeback.mjs";
import { runTargetedPreflight } from "./release-preflight.mjs";

const LANE_DIFF = "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -10,2 +10,3 @@\n x\n";
const OVERLAP = "--- a/src/a.js\n+++ b/src/a.js\n@@ -11,1 +11,1 @@\n";
const APART = "--- a/src/a.js\n+++ b/src/a.js\n@@ -90,1 +90,1 @@\n";

/** Fake io: records every git/gh call; `writes` are the mutating ones. */
function fake({ conflict = false, milestones = [] } = {}) {
  const calls = [], writes = [];
  const io = {
    git(args) {
      calls.push(["git", ...args]);
      if (args[0] === "merge-tree") { if (conflict) { const e = new Error("conflict"); e.stdout = "CONFLICT (content): Merge conflict in src/conflict.js\n"; throw e; } return ""; }
      if (args[0] === "diff" && args.includes("--name-only")) return "src/a.js\n";
      if (args[0] === "diff") return LANE_DIFF;
      if (args[0] === "ls-remote") return milestones.map((m) => `abc\trefs/heads/${m}`).join("\n");
      if (args[0] === "rev-parse") return "deadbeef\n";
      return "";
    },
    async gh(args) {
      calls.push(["gh", ...args]);
      if (args[0] === "pr" && args[1] === "list" && args.includes("--head")) return "[]";
      if (args[0] === "pr" && args[1] === "create") { writes.push(args); return "https://github.com/o/r/pull/50"; }
      if (args[0] === "pr" && args[1] === "merge") { writes.push(args); return ""; }
      if (args[0] === "pr" && args[1] === "view") return '{"state":"MERGED"}';
      if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 61, headRefName: "fix/overlap" }, { number: 62, headRefName: "fix/apart" }]);
      if (args[0] === "pr" && args[1] === "diff") return args[2] === "61" ? OVERLAP : APART;
      return "";
    },
    async rehearse(cmd) { calls.push(["rehearse", cmd]); return { ok: true, code: 0 }; },
    sleep: async () => {},
  };
  return { io, calls, writes };
}
const intakeLog = () => { const log = []; return { log, setIntake: async (p) => { log.push(p.paused); } }; };
const base = (io, extra = {}) => ({ io, repo: "o/r", def: "main", staging: "staging", config: { managed: true, preflight: { command: "node --test {files}", timeoutMs: 1000 } }, review: async () => ({ ok: true, verdict: "GATE_PASS" }), recordSync: async () => null, ...extra });

describe("merge-back (#5566)", () => {
  it("a conflicting hunk yields a conflicted sync PR; the target has the file; blocks until covered, green and merged", async () => {
    const { io } = fake({ conflict: true });
    const rec = [];
    const r = await syncStep(base(io, { recordSync: async (s) => rec.push(s), setIntake: intakeLog().setIntake }), { lane: "p0" });
    assert.equal(r.pr, 50);
    assert.equal(r.conflicted, true);
    assert.ok(r.target.includes("src/conflict.js"));
    assert.ok(r.target.includes("src/a.js"));
    assert.equal(rec.length, 1);
    assert.equal(r.blocks, true);
    const sync = { ...r, conflicted: false, merged: false };
    assert.equal(syncBlocksRelease({ sync }), true, "unmerged still blocks");
    assert.equal(syncBlocksRelease({ sync: { ...sync, merged: true, preflight: { ok: true, covered: ["src/a.js"] } } }), true, "a preflight that misses the conflict file is unvalidated");
    assert.equal(syncBlocksRelease({ sync: { ...sync, merged: true, preflight: { ok: true, covered: r.target } } }), false);
    assert.equal(syncBlocksRelease({ sync: { ...sync, merged: true, preflight: { ok: false, covered: r.target } } }), true);
  });

  it("is false for train and p0 in the same state, and with no sync", () => {
    const sync = { pr: 1, conflicted: true, target: ["a"], merged: false };
    assert.equal(syncBlocksRelease({ sync }, "train"), false);
    assert.equal(syncBlocksRelease({ sync }, "p0"), false);
    assert.equal(syncBlocksRelease({ sync }, "release"), true);
    assert.equal(syncBlocksRelease({}), false);
    assert.equal(syncBlocksRelease(null), false);
  });

  it("flags a staging PR overlapping a lane hunk and not a disjoint one", async () => {
    const { io } = fake();
    const r = await syncStep(base(io), { lane: "train" });
    assert.deepEqual(r.duplicates, [{ pr: 61, files: ["src/a.js"] }]);
    assert.deepEqual(duplicateFixes(parseHunks(LANE_DIFF), [{ number: 9, hunks: parseHunks(APART) }]), []);
  });

  it("lists open milestone branches as stale-vs-main with the hazard note", async () => {
    const { io } = fake({ milestones: ["milestone/a", "milestone/b"] });
    const r = await syncStep(base(io), { lane: "p0" });
    assert.deepEqual(r.milestones.map((m) => [m.branch, m.status]), [["milestone/a", "stale-vs-main"], ["milestone/b", "stale-vs-main"]]);
    assert.match(r.milestones[0].note, /squash/);
    assert.equal(staleMilestones({ git: () => { throw new Error("x"); } }).length, 0);
  });

  it("refuses squash and writes nothing", async () => {
    const { io, calls } = fake();
    const r = await syncStep(base(io, { policy: { merge: { method: "squash" } } }), { lane: "p0" });
    assert.match(r.refused, /squash/);
    assert.equal(calls.length, 0);
  });

  it("unmanaged: no io call at all", async () => {
    const { io, calls } = fake();
    const r = await syncStep(base(io, { config: { preflight: { command: "x {files}" } } }), { lane: "p0" });
    assert.deepEqual(r, { skipped: true });
    assert.deepEqual(await finishSync(base(io, { config: {} }), {}), { skipped: true });
    assert.equal(calls.length, 0);
  });

  it("pauses intake on start and releases it on merge; a conflicted sync stays paused", async () => {
    const { io, writes } = fake();
    const a = intakeLog();
    const r = await syncStep(base(io, { setIntake: a.setIntake, preflight: async (_c, { head, target }) => ({ ok: true, head, covered: target }) }), { lane: "p0" });
    assert.deepEqual(a.log, [true]);
    assert.equal(r.validated, true);
    const f = await finishSync(base(io, { setIntake: a.setIntake }), r);
    assert.equal(f.merged, true);
    assert.deepEqual(a.log, [true, false]);
    assert.ok(writes.some((w) => w[1] === "merge" && w.includes("--merge") && !w.includes("--squash")));
    const c = fake({ conflict: true }), b = intakeLog();
    const rc = await syncStep(base(c.io, { setIntake: b.setIntake }), { lane: "p0" });
    const fc = await finishSync(base(c.io, { setIntake: b.setIntake }), rc);
    assert.equal(fc.merged, false);
    assert.deepEqual(b.log, [true]);
  });

  it("targeted preflight covers the target only when the command takes {files}", async () => {
    const { io } = fake();
    const t = ["a b.js", "c.js"];
    const ok = await runTargetedPreflight({ io, config: { preflight: { command: "node --test {files}", timeoutMs: 1 } } }, { head: "h", target: t });
    assert.deepEqual(ok.covered, t);
    assert.match(ok.command, /'a b\.js' 'c\.js'/);
    const bad = await runTargetedPreflight({ io, config: { preflight: { command: "npm test", timeoutMs: 1 } } }, { head: "h", target: t });
    assert.equal(bad.ok, true);
    assert.deepEqual(bad.covered, []);
    assert.equal(syncValidated({ target: t, review: { ok: true }, preflight: bad }), false);
    assert.deepEqual(targetSet({ conflicts: ["b"], changed: ["a", "b"] }), ["a", "b"]);
  });
});
