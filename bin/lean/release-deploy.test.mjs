// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deployStep, parseLiveRelease, liveMatches } from "./release-deploy.mjs";
import { validatePolicy } from "./release-config.mjs";

const SHA = "a".repeat(40), OLD = "b".repeat(40);
const POLICY = { live_release_command: "live", freeze_variable: "DEPLOY_FREEZE", start_timeout_s: 10, stage_timeout_s: 100, recovery: { rerun_max: 2, max_attempts: 3, signatures: ["429 Too Many"] }, pipelines: { full: { workflow: "deploy.yml", trigger: "push" } } };

/** World: `live` is a queue (last repeats) of live shas; `runs` a queue of run rows; `freeze` the variable value. */
function world(o = {}) {
  const w = { live: [OLD, SHA], runs: [{ databaseId: 9, status: "completed", conclusion: "success" }], freeze: "", log: "", gh: [], ran: [], ...o };
  const io = {
    print: () => {}, sleep: async () => {}, git: () => "{}",
    rehearse: async (cmd) => { w.ran.push(cmd); if (cmd === "live") { const v = w.live.length > 1 ? w.live.shift() : w.live[0]; return v == null ? { ok: false, output: "" } : { ok: true, output: v }; } if (w.failCheck) return { ok: false, output: "boom" }; return { ok: true, output: "{}" }; },
    gh: async (a) => {
      w.gh.push(a.join(" "));
      if (a[0] === "variable") { if (!w.freeze) throw new Error("HTTP 404"); return w.freeze; }
      if (a[0] === "run" && a[1] === "list") { const r = w.runs[Math.min(w.reran ?? 0, w.runs.length - 1)]; return JSON.stringify(r ? [r] : []); }
      if (a[0] === "run" && a[1] === "view") return w.log;
      if (a[0] === "run" && a[1] === "rerun") { w.reran = (w.reran ?? 0) + 1; return ""; }
      if (a[0] === "workflow" || a[0] === "pr") return "";
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
  };
  return { w, io };
}
const mk = (io, over = {}, deploy = POLICY) => ({ io, repo: "o/r", def: "main", config: { deploy, deployBounds: { pollMs: 1, runPollMs: 1 } }, state: { steps: { "post-merge": { result: { merge: SHA } }, "release-pr": { result: { pr: 7 } } } }, save() {}, ...over });
const active = (o) => ({ content: Buffer.from(JSON.stringify(o)).toString("base64") });
const fence = (calls = []) => ({ lctx: { io: { api: async () => active({ epoch: 3, lease: { holder: "h", epoch: 3 } }) }, repo: "o/r" }, lease: { holder: "h", epoch: 3, release: "r" }, now: () => "t", record: async (r) => calls.push(r) });

describe("release deploy stages (#5560)", () => {
  it("skips without a deploy policy and leaves no trace", async () => {
    const { io } = world(); const c = mk(io, {}, null);
    assert.deepEqual(await deployStep(c), { skipped: true }); assert.equal(c.state.deploy, undefined);
  });
  it("MERGED -> LIVE: records the rollback target, observes the run, passes LIVE_CHECK, writes FORGE:VERIFIED", async () => {
    const { w, io } = world(); const c = mk(io);
    const out = await deployStep(c);
    assert.equal(out.live, true); assert.equal(c.state.deploy.target.sha, OLD); assert.equal(c.state.deploy.phase, "LIVE");
    assert.ok(w.gh.some((g) => g.startsWith("pr comment 7") && g.includes(`FORGE:VERIFIED ${SHA}`)));
    assert.ok(!w.gh.some((g) => g.startsWith("workflow run")), "an observed push run is never redispatched");
  });
  it("I9: an unknown rollback target blocks before any dispatch", async () => {
    const { w, io } = world({ live: [null], runs: [] });
    const out = await deployStep(mk(io));
    assert.match(out.reason, /rollback target unknown/); assert.ok(!w.gh.some((g) => g.startsWith("workflow run")));
  });
  it("I28 + I26: a freeze-skipped success fails LIVE_CHECK and is never rerun or redispatched", async () => {
    const { w, io } = world({ live: [OLD], freeze: "" });
    w.gh.push; const orig = io.gh; io.gh = async (a) => { if (a[0] === "run" && a[1] === "list") w.freeze = "1"; return orig(a); }; // the run sets the freeze
    const out = await deployStep(mk(io));
    assert.equal(out.blocked, true); assert.match(out.reason, /LIVE_CHECK failed/); assert.match(out.reason, /override_freeze|I26/);
    assert.equal(w.reran, undefined); assert.equal(w.gh.filter((g) => g.startsWith("workflow run")).length, 0);
  });
  it("a success run with a stale live record (no freeze) is a failed deploy, not retried", async () => {
    const { w, io } = world({ live: [OLD] });
    const out = await deployStep(mk(io));
    assert.match(out.reason, /live is bbbbbbbb/); assert.equal(w.reran, undefined);
  });
  it("a transient build failure is rerun once and reaches LIVE with no human", async () => {
    const { w, io } = world({ live: [OLD, SHA], log: "build: 429 Too Many Requests", runs: [{ databaseId: 9, status: "completed", conclusion: "failure" }, { databaseId: 9, status: "completed", conclusion: "success" }] });
    const out = await deployStep(mk(io));
    assert.equal(out.live, true); assert.equal(out.reruns, 1); assert.equal(w.reran, 1);
  });
  it("rerun_max bounds the reruns, then escalates", async () => {
    const { w, io } = world({ live: [OLD], log: "429 Too Many Requests", runs: [{ databaseId: 9, status: "completed", conclusion: "failure" }] });
    const out = await deployStep(mk(io));
    assert.match(out.reason, /recovery spent/); assert.equal(w.reran, 2);
  });
  it("max_attempts bounds the actions", async () => {
    const { w, io } = world({ live: [OLD], log: "429 Too Many Requests", runs: [{ databaseId: 9, status: "completed", conclusion: "failure" }] });
    const out = await deployStep(mk(io, {}, { ...POLICY, recovery: { ...POLICY.recovery, rerun_max: 5, max_attempts: 1 } }));
    assert.match(out.reason, /recovery spent/); assert.equal(w.reran, 1);
  });
  it("a failure without a transient signature is not rerun", async () => {
    const { w, io } = world({ live: [OLD], log: "tsc error", runs: [{ databaseId: 9, status: "completed", conclusion: "failure" }] });
    const out = await deployStep(mk(io));
    assert.match(out.reason, /transient signature/); assert.equal(w.reran, undefined);
  });
  it("dispatches (fenced, with forge_epoch) only when no run appears, and never an override input", async () => {
    const { w, io } = world({ runs: [] }); const calls = [];
    w.runs = []; const orig = io.gh; io.gh = async (a) => { const r = await orig(a); if (a[0] === "workflow") w.runs = [{ databaseId: 11, status: "completed", conclusion: "success" }]; return r; };
    const out = await deployStep(mk(io, { fence: fence(calls) }));
    const d = w.gh.filter((g) => g.startsWith("workflow run")); assert.equal(out.live, true); assert.equal(d.length, 1);
    assert.match(d[0], /forge_epoch=3/); assert.ok(!/override_|acknowledge_/.test(d[0]));
    assert.ok(calls.some((r) => r.key === `deploy:${SHA}`));
  });
  it("a stale epoch refuses the dispatch", async () => {
    const { io } = world({ runs: [] });
    const f = fence(); f.lctx = { io: { api: async () => active({ lease: { holder: "other", epoch: 4 }, epoch: 4 }) }, repo: "o/r" };
    const out = await deployStep(mk(io, { fence: f }));
    assert.match(out.reason, /fenced|refused/);
  });
  it("a post-deploy check that fails blocks FORGE:VERIFIED", async () => {
    const { w, io } = world({ failCheck: true }); io.git = () => JSON.stringify({ c1: { run: "check-it" } });
    const out = await deployStep(mk(io, { state: { issues: [{ number: 1, checks: ["c1"] }], steps: { "post-merge": { result: { merge: SHA } }, "release-pr": { result: { pr: 7 } } } } }));
    assert.match(out.reason, /check c1 failed/); assert.ok(!w.gh.some((g) => g.includes("FORGE:VERIFIED")));
  });
  it("chaos: a throw at every boundary, then a resume, repeats no dispatch, rerun or verified comment", async () => {
    for (const dieOn of ["variable", "run list", "run view", "run rerun", "pr comment", "live"]) {
      const { w, io } = world({ live: [OLD, SHA], log: "429 Too Many Requests", runs: [{ databaseId: 9, status: "completed", conclusion: "failure" }, { databaseId: 9, status: "completed", conclusion: "success" }] });
      let armed = true; const g0 = io.gh, r0 = io.rehearse;
      const maybe = (k) => { if (armed && k === dieOn) { armed = false; throw new Error("kill -9"); } };
      io.gh = async (a) => { maybe(a.slice(0, 2).join(" ").replace(/^variable get$/, "variable")); return g0(a); };
      io.rehearse = async (c, o) => { if (c === "live" && w.ran.length >= 3) maybe("live"); return r0(c, o); };
      const c = mk(io);
      try { await deployStep(c); } catch { /* killed */ }
      const out = await deployStep(c);
      assert.equal(out.live, true, dieOn);
      assert.ok((w.reran ?? 0) <= 1, `${dieOn}: one rerun`); assert.equal(w.gh.filter((g) => g.includes("FORGE:VERIFIED")).length, 1, `${dieOn}: one comment`);
      assert.equal(w.gh.filter((g) => g.startsWith("workflow run")).length, 0, dieOn);
    }
  });
});

describe("deploy reconcile (#5560)", () => {
  it("a LIVE_CHECKED phase whose live record moved is re-observed without a dispatch, then re-checked", async () => {
    const { w, io } = world({ live: [OLD] });
    const c = mk(io); c.state.deploy = { phase: "LIVE_CHECKED", attempts: 0, reruns: 0, target: { sha: OLD, images: {} }, expected: null, merge: SHA, freezeBefore: "" };
    const out = await deployStep(c);
    assert.equal(out.blocked, true); assert.match(out.reason, /LIVE_CHECK failed/);
    assert.equal(w.gh.filter((g) => g.startsWith("workflow run")).length, 0);
  });
});

describe("deploy helpers", () => {
  it("parseLiveRelease reads JSON and a bare sha; liveMatches prefers expected digests", () => {
    assert.deepEqual(parseLiveRelease(`{"sha":"abc1234","images":{"api":"d1"}}`), { sha: "abc1234", images: { api: "d1" } });
    assert.equal(parseLiveRelease("garbage!"), null);
    assert.equal(liveMatches({ sha: "x".repeat(8), images: { api: "d1" } }, SHA, { api: "d1" }), true);
    assert.equal(liveMatches({ sha: SHA, images: { api: "d0" } }, SHA, { api: "d1" }), false);
  });
  it("the policy schema accepts the typed recovery block and rejects a string rerun_max", () => {
    const base = { schema: 1, deploy: { ...POLICY } };
    assert.deepEqual(validatePolicy(base).filter((f) => /deploy\.recovery/.test(f)), []);
    assert.ok(validatePolicy({ ...base, deploy: { ...POLICY, recovery: { rerun_max: "2" } } }).some((f) => /rerun_max/.test(f)));
  });
});
