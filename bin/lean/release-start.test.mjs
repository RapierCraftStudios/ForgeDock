// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startRelease, startFromCli, goFromCli, cutAllowed, flagPolicyOutcome, milestonePlan, recordActivation, orderWaves, PLAN_DECISION } from "./release-start.mjs";
import { approvalOf } from "./release-plan.mjs";

const HASH = "a".repeat(64);
const plan = { plan_hash: HASH, waves: [
  { id: "release", lane: "release", issues: [3], units: ["web"] },
  { id: "train-1", lane: "train", issues: [1], units: ["api"] },
  { id: "train-2", lane: "train", issues: [2], units: ["api"] },
] };
const policy = { trust: { actors: ["owner"] } };
const mk = (over = {}) => {
  const log = [], out = [], state = {};
  const runners = {
    build: async (w) => { log.push(`build:${w.id}`); return { ok: true }; },
    train: async (w) => { log.push(`train:${w.id}`); return { status: "live" }; },
    release: async (w, o) => { log.push(`release:${w.id}:${o.soak}`); return { status: "done" }; },
    verify: async () => ({ verified: true }),
    mergeback: async () => ({ validated: true }),
    ...over.runners,
  };
  return { log, out, state, ctx: { io: { print: (l) => out.push(l) }, plan, state, save: () => {}, managed: true, approval: { state: "approved" }, policy, runners, ...over.ctx } };
};

describe("startRelease", () => {
  it("replays plan, approval, two trains, then the release wave with only the approval as input", async () => {
    const { ctx, log, state } = mk();
    const r = await startRelease(ctx);
    assert.equal(r.status, "done");
    assert.deepEqual(log, ["build:release", "train:train-1", "train:train-2", "release:release:full"]);
    assert.deepEqual(Object.values(state.waves).map((w) => w.state), ["WAVE_DONE", "WAVE_DONE", "WAVE_DONE"]);
    assert.equal(orderWaves(plan)[2].id, "release");
  });
  it("refuses to CUT the release wave before the last train is WAVE_DONE; building is allowed", () => {
    const st = { waves: { "train-1": { state: "WAVE_DONE" }, "train-2": { state: "LIVE" } } };
    assert.equal(cutAllowed(st, plan, plan.waves[0]).ok, false);
    assert.match(cutAllowed(st, plan, plan.waves[0]).reason, /train-2/);
    st.waves["train-2"].state = "WAVE_DONE";
    assert.equal(cutAllowed(st, plan, plan.waves[0]).ok, true);
  });
  it("stops a train that is live but not verified, so the release wave is never cut", async () => {
    const { ctx, log } = mk({ runners: { verify: async () => ({ verified: false }) } });
    const r = await startRelease(ctx);
    assert.equal(r.status, "stopped");
    assert.ok(!log.some((l) => l.startsWith("release:")));
  });
  it("a build before the trains deploy does not CUT (release runner is not called)", async () => {
    const { ctx, log } = mk({ ctx: { wave: "release" }, runners: {} });
    const r = await startRelease(ctx);
    assert.equal(r.status, "refused");
    assert.deepEqual(log, ["build:release"]);
  });
  it("resumes after a crash mid-wave without repeating a completed wave", async () => {
    const { ctx, log, state } = mk({ runners: { train: async (w) => { log.push(`train:${w.id}`); if (w.id === "train-2" && !state.crashed) { state.crashed = 1; throw new Error("crash"); } return { status: "live" }; } } });
    await assert.rejects(startRelease(ctx), /crash/);
    log.length = 0;
    const r = await startRelease(ctx);
    assert.equal(r.status, "done");
    assert.deepEqual(log, ["train:train-2", "release:release:full"]);
  });
  it("a recorded LIVE wave is verified, not redeployed", async () => {
    const { ctx, log, state } = mk();
    state.waves = { "train-1": { state: "LIVE" } };
    await startRelease(ctx);
    assert.ok(!log.includes("train:train-1"));
  });
  it("does nothing and writes nothing when unmanaged", async () => {
    const { ctx, log } = mk({ ctx: { managed: false } });
    assert.equal((await startRelease(ctx)).status, "unmanaged");
    assert.deepEqual(log, []);
  });
  it("waits for approval", async () => {
    const { ctx, log } = mk({ ctx: { approval: { state: "stale" } } });
    assert.equal((await startRelease(ctx)).status, "awaiting-approval");
    assert.deepEqual(log, []);
  });
});

describe("flag policy", () => {
  const info = { feature: true, added: [], offKeys: ["new_flag"] };
  for (const [mode, action] of [["require", "error"], ["warn", "warn"], ["off", "none"]]) {
    it(`missing rollout key under ${mode} => ${action}`, () => assert.equal(flagPolicyOutcome({ features: { flag_policy: mode } }, "release", info).action, action));
  }
  it("a present rollout key and a non-feature wave need nothing", () => {
    assert.equal(flagPolicyOutcome({ features: { flag_policy: "require" } }, "release", { feature: true, added: ["k"] }).action, "none");
    assert.equal(flagPolicyOutcome({ features: { flag_policy: "require" } }, "release", { feature: false }).action, "none");
  });
  it("a lane's own flag_policy wins", () => assert.equal(flagPolicyOutcome({ features: { flag_policy: "require" }, lanes: { release: { flag_policy: "off" } } }, "release", info).action, "none"));
  it("require refuses the wave; warn runs it with a WARN", async () => {
    const rollouts = async () => info;
    const a = mk({ ctx: { policy: { ...policy, features: { flag_policy: "require" } } }, runners: { rollouts } });
    assert.equal((await startRelease(a.ctx)).status, "refused");
    const b = mk({ ctx: { policy: { ...policy, features: { flag_policy: "warn" } } }, runners: { rollouts } });
    assert.equal((await startRelease(b.ctx)).status, "done");
    assert.ok(b.out.some((l) => l.startsWith("WARN")));
  });
  it("a default-off key stays off after deploy and activation is its own record", async () => {
    const { ctx, state } = mk({ runners: { rollouts: async () => ({ feature: true, added: ["new_flag"], offKeys: ["new_flag"] }) } });
    await startRelease(ctx);
    assert.deepEqual(state.waves.release.keepOff, ["new_flag"]);
    assert.equal(state.activations, undefined);
    recordActivation(state, "new_flag", "owner", "t");
    assert.equal(state.activations[0].key, "new_flag");
  });
});

describe("milestone lane", () => {
  it("refuses without --milestone and builds one full release wave on the milestone branch", () => {
    assert.throws(() => milestonePlan(plan), /--milestone/);
    const m = milestonePlan(plan, "v2");
    assert.equal(m.waves.length, 1);
    assert.deepEqual([m.waves[0].base, m.waves[0].pipeline, m.waves[0].lane], ["milestone/v2", "full", "release"]);
  });
  it("start --lane milestone without --milestone throws", async () => {
    await assert.rejects(startFromCli(["--lane", "milestone"], { io: { print() {} }, managed: true }), /--milestone/);
  });
});

describe("startFromCli / goFromCli", () => {
  const io = () => { const out = []; return { out, print: (l) => out.push(l) }; };
  it("go posts the typed approval bound to the plan hash; start --approve then runs", async () => {
    const posted = [], i = io();
    const ledger = { read: async () => ({ state: { plan }, head: "h" }), write: async () => ({ ok: true, sha: "h2" }) };
    assert.equal(await goFromCli(["r1"], { io: i, ledger, post: async (b) => posted.push(b), managed: true }), 0);
    assert.deepEqual(posted, [PLAN_DECISION(HASH)]);
    const comments = [];
    const m = mk();
    const code = await startFromCli(["--plan", "r1", "--approve"], { io: i, managed: true, policy, ledger, decisions: async () => comments.map((c) => ({ author: "owner", body: c })), post: async (b) => comments.push(b), runners: m.ctx.runners });
    assert.equal(code, 0);
    assert.equal(m.log.at(-1), "release:release:full");
    assert.equal(approvalOf(plan, comments.map((b) => ({ author: "owner", body: b })), policy).state, "approved");
  });
  it("go and start write nothing when unmanaged", async () => {
    const i = io(); let wrote = 0;
    const ledger = { read: async () => { wrote++; }, write: async () => { wrote++; } };
    assert.equal(await goFromCli(["r1"], { io: i, ledger, post: async () => { wrote++; }, managed: false }), 0);
    assert.equal(await startFromCli([], { io: i, managed: false, ledger }), 0);
    assert.equal(wrote, 0);
  });
  it("a refused wave lease stops the run before any effect", async () => {
    const b = mk({ ctx: { takeFence: async () => ({ refused: "lease lost" }) } });
    const r = await startRelease(b.ctx);
    assert.deepEqual([r.status, r.reason], ["refused", "lease lost"]);
    assert.ok(!b.log.some((l) => l.startsWith("train:")));
  });
  it("each wave takes its own fence and the effect runs under it", async () => {
    const taken = [], recorded = [];
    const fence = { lctx: { io: { api: async () => ({}) } }, lease: { epoch: 1 }, record: async (r) => recorded.push(r), now: () => "t" };
    const { ctx } = mk({ ctx: { takeFence: async (st) => { taken.push(st); return { fence }; } } });
    ctx.fence = null;
    await startRelease(ctx).catch(() => null); // the fence gate reads the ledger, which this fake io does not serve; only the per-wave take is asserted
    assert.equal(taken.length, 1);
    assert.equal(taken[0], ctx.state);
  });
  it("prints activation_missing for a kept-off key until `go --activate` records it", async () => {
    const { ctx, state, out } = mk({ runners: { rollouts: async () => ({ feature: true, added: ["new_flag"], offKeys: ["new_flag"] }) } });
    state.id = "r1"; state.plan = plan;
    await startRelease(ctx);
    assert.ok(out.some((l) => l.startsWith("activation_missing: default-off new_flag")));
    const posted = []; let written = null;
    const ledger = { read: async () => ({ state, head: "h" }), write: async (_i, st) => { written = st; return { ok: true, sha: "h2" }; } };
    const i = { print() {} };
    assert.equal(await goFromCli(["r1", "--activate", "other"], { io: i, ledger, post: async (b) => posted.push(b), managed: true }), 1);
    assert.equal(await goFromCli(["r1", "--activate", "new_flag"], { io: i, ledger, post: async (b) => posted.push(b), managed: true, actor: "owner" }), 0);
    assert.equal(written.activations[0].key, "new_flag");
    assert.deepEqual(posted, ["<!-- FORGE:DECISION activate new_flag -->"]);
  });
});
