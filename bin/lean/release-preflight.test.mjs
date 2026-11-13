// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { runRelease, withStubs, readReleaseConfig, newReleaseId } from "./release.mjs";
import { parsePreflightConfig, markReadyStep } from "./release-preflight.mjs";
import { fixStep } from "./release-review.mjs";

const DISK = [{ mount: "/", type: "ext4" }];
const REPO = "o/r", HEAD = "a".repeat(40);
const ok = async () => ({ ok: true });

/** io fake: `preflightOk(n)` decides the n-th host command run; gh answers just what the preflight steps ask. */
function fakeIo({ preflightOk = () => true, draft = true } = {}) {
  const calls = [], ran = [];
  return {
    calls, ran, now: () => 1_700_000_000_000, print() {}, sleep: async () => {},
    runningLanes: async () => [], batches: async () => [], setParallel: async () => {},
    rehearse: async (cmd) => { ran.push(cmd); return preflightOk(ran.length) ? { ok: true, code: 0, output: "" } : { ok: false, code: 1, output: "suite red" }; },
    gh: async (a) => {
      calls.push(a);
      const j = a.join(" ");
      if (a[0] === "api") return `${HEAD}\n`;
      if (a[0] === "pr" && a[1] === "list" && a.includes("open") && a.includes("--head")) return "[]";
      if (a[0] === "pr" && a[1] === "list") return "[]";
      if (a[0] === "pr" && a[1] === "create") return "https://github.com/o/r/pull/9";
      if (a[0] === "pr" && a[1] === "view") return JSON.stringify({ headRefOid: HEAD, isDraft: draft, state: "OPEN" });
      if (a[0] === "pr" && a[1] === "ready") return "";
      if (a[0] === "issue" && a[1] === "list") return "[]";
      if (a[0] === "issue" && a[1] === "create") return "https://github.com/o/r/issues/50";
      throw new Error(`unexpected gh ${j}`);
    },
  };
}
const run = (io, config, over = {}) => runRelease({ io, repo: REPO, root: tmpDir("rel-pf-"), mounts: DISK, id: newReleaseId(), opts: {}, config, branches: { staging: "staging", default: "main" }, steps: withStubs({ review: ok, fixes: ok, promotion: ok, "post-merge": ok, ...over }) });
const CFG = readReleaseConfig("release:\n  preflight_command: npm test\n");

describe("release host preflight (#5277)", () => {
  it("parses the flat keys and is null when unset", () => {
    assert.equal(parsePreflightConfig({}), null);
    assert.deepEqual(parsePreflightConfig({ preflight_command: " make t ", preflight_timeout: "30", preflight_blocking: "false" }), { command: "make t", timeoutMs: 30000, blocking: false });
    assert.equal(CFG.preflight.command, "npm test");
    assert.equal("preflight" in readReleaseConfig(""), false);
  });

  it("R6: a failing preflight opens no PR, files one release-blocker and stops the release", async () => {
    const io = fakeIo({ preflightOk: () => false });
    const out = await run(io, CFG);
    assert.equal(out.status, "stopped");
    assert.equal(out.step, "host-preflight");
    assert.ok(!io.calls.some((a) => a[0] === "pr" && a[1] === "create"));
    const create = io.calls.find((a) => a[0] === "issue" && a[1] === "create");
    assert.ok(create.includes("release-blocker") && create.some((x) => x.includes("kind=preflight")));
  });

  it("R2/R6: a passing preflight opens the PR as a draft; unset opens it ready with no preflight work", async () => {
    const on = fakeIo();
    await run(on, CFG);
    assert.ok(on.calls.find((a) => a[0] === "pr" && a[1] === "create").includes("--draft"));
    const off = fakeIo();
    const out = await run(off, readReleaseConfig(""));
    assert.equal(out.status, "done");
    assert.ok(!off.calls.find((a) => a[0] === "pr" && a[1] === "create").includes("--draft"));
    assert.equal(off.ran.length, 0);
    assert.ok(!off.calls.some((a) => a[0] === "pr" && a[1] === "ready"));
  });

  it("R4/R7: the final preflight passes, then the draft is marked ready once, after review and fixes", async () => {
    const order = [];
    const io = fakeIo();
    const out = await run(io, CFG, { review: async () => { order.push("review"); return {}; }, fixes: async () => { order.push("fixes"); return {}; } });
    assert.equal(out.status, "done");
    assert.equal(io.calls.filter((a) => a[1] === "ready").length, 1);
    assert.deepEqual(order, ["review", "fixes"]);
    assert.ok(io.calls.findIndex((a) => a[1] === "create") < io.calls.findIndex((a) => a[1] === "ready"));
    assert.equal(io.ran.length, 2); // before the PR and before ready
  });

  it("R6: a head whose final preflight fails is not marked ready", async () => {
    const io = fakeIo({ preflightOk: (n) => n < 2 });
    const out = await run(io, CFG);
    assert.equal(out.step, "mark-ready");
    assert.equal(out.status, "stopped");
    assert.ok(!io.calls.some((a) => a[1] === "ready"));
  });

  it("an already-ready PR is not re-marked; non-blocking failures do not stop", async () => {
    const io = fakeIo({ draft: false });
    const r = await markReadyStep({ io, repo: REPO, config: CFG, state: { steps: { "release-pr": { result: { pr: 9 } } } } });
    assert.equal(r.ready, true);
    assert.ok(!io.calls.some((a) => a[1] === "ready"));
    const nb = fakeIo({ preflightOk: () => false });
    const r2 = await markReadyStep({ io: nb, repo: REPO, config: { preflight: { ...CFG.preflight, blocking: false } }, state: { steps: { "release-pr": { result: { pr: 9 } } } } });
    assert.equal(r2.stopped, undefined);
    assert.ok(nb.calls.some((a) => a[1] === "ready"));
  });

  it("R3: fixStep re-runs the preflight on the new head before the delta review, and a red one blocks", async () => {
    const mk = (pfOk) => {
      const io = fakeIo({ preflightOk: () => pfOk });
      const seam = {
        headOf: async () => HEAD, runLane: async () => ({ terminalReason: "merged" }), fileFixIssue: async () => 3, failedJobs: async () => [],
        calls: [],
      };
      return { io, seam, ctx: { io: Object.assign(io, { review: seam }), repo: REPO, def: "main", staging: "staging", config: CFG, save() {}, state: { steps: { review: { result: { pr: 9, marker: "FORGE:GATE_FAILURE", verdict: "X", head: "b".repeat(40), blocking: [11], ciFailing: 0 } } } } } };
    };
    const red = mk(false);
    const out = await fixStep(red.ctx);
    assert.equal(out.blocked, true);
    assert.match(out.reason, /host preflight failed/);
    assert.equal(red.io.ran.length, 1);
  });
});
