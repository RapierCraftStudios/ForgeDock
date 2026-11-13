// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recomputeAtCut, runTrain, trainBranch } from "./release-train.mjs";
import { rollSet } from "./release-plan.mjs";
import { laneTrailers } from "./release-fence.mjs";

const policy = {
  branches: { train: "train/<date>-<n>" },
  units: { api: { paths: ["svc/api/**"] }, web: { paths: ["svc/web/**"], surface: "web" }, worker: { paths: ["svc/worker/**"] }, fx: { paths: ["svc/fx/**"], service_pipeline: false } },
  couplings: [{ paths: ["shared/**"], affects: ["api", "web", "worker"] }],
  contracts: [{ producer: "api", consumers: ["web"], paths: ["contract/**"], additive_only: true, regenerate: "make gen" }],
};
const rec = { units: ["api"], migrations: "none", contract: false };

describe("recomputeAtCut (I3)", () => {
  it("keeps an unchanged diff", () => assert.equal(recomputeAtCut(policy, rec, ["svc/api/a.js"]).action, "keep"));
  it("demotes a migration file", () => { const r = recomputeAtCut(policy, rec, ["svc/api/a.js", "svc/api/migrations/001.sql"]); assert.equal(r.action, "demote"); assert.ok(r.widened.includes("migration")); });
  it("demotes a contract file", () => assert.equal(recomputeAtCut(policy, rec, ["contract/x.json"]).action, "demote"));
  it("ejects a new unit", () => { const r = recomputeAtCut(policy, rec, ["svc/api/a.js", "svc/worker/w.js"]); assert.equal(r.action, "eject"); assert.deepEqual(r.widened, ["unit:worker"]); });
  it("demotes when the diff forces the full pipeline", () => assert.equal(recomputeAtCut(policy, { ...rec, units: ["fx"] }, ["svc/fx/a.js"]).action, "demote"));
  it("accepts narrowing", () => { const r = recomputeAtCut(policy, { ...rec, units: ["api", "worker"] }, ["svc/api/a.js"]); assert.equal(r.action, "keep"); assert.deepEqual(r.narrowed, ["unit:worker"]); });
});

describe("roll-set property (I4)", () => {
  it("the recomputed unit set covers every unit owning or coupled to a file; shared yields the full consumer set", () => {
    const corpus = ["svc/api/a.js", "svc/web/b.js", "svc/worker/c.js", "shared/x.js", "docs/readme.md"];
    for (const f of corpus) {
      const r = recomputeAtCut(policy, { units: [] }, [f]);
      const want = [...Object.entries(policy.units).filter(([, u]) => u.paths.some((p) => f.startsWith(p.replace("**", "")))).map(([id]) => id), ...(f.startsWith("shared/") ? ["api", "web", "worker"] : [])];
      for (const u of want) assert.ok(r.units.includes(u), `${f} -> ${u}`);
    }
    assert.deepEqual(recomputeAtCut(policy, { units: [] }, ["shared/x.js"]).units, ["api", "web", "worker"]);
  });
});

describe("trailers and branch", () => {
  it("laneTrailers carries lane, release and epoch", () => assert.equal(laneTrailers({ lane: "train", release: "r1", epoch: 7 }), "Forge-Lane: train\nForge-Release: r1\nForge-Epoch: 7"));
  it("trainBranch expands the pattern and rejects bad names", () => { assert.equal(trainBranch(policy, "2026-11-13", 2), "train/2026-11-13-2"); assert.equal(trainBranch({ branches: { train: "a b" } }, "d", 1), null); });
});

/** Fake io: a wave of PRs with the given files; records every git/gh call. Live == default (rev-parse returns one sha). */
function world({ files = { 11: ["svc/api/a.js"] }, dirty = false, regenOk = true } = {}) {
  const calls = { git: [], gh: [], rehearse: [] };
  const A = "a".repeat(40), B = "b".repeat(40);
  const io = {
    git: (a) => { calls.git.push(a); if (a[0] === "rev-parse") return `${A}\n`; if (a[0] === "status") return dirty ? " M gen.json" : ""; return ""; },
    gh: async (a) => {
      calls.gh.push(a);
      if (a[0] === "pr" && a[1] === "view" && a.includes("files")) return JSON.stringify({ files: (files[a[2]] ?? []).map((path) => ({ path })) });
      if (a[0] === "pr" && a[1] === "create") return "https://github.com/o/r/pull/99";
      if (a[0] === "pr" && a[1] === "view") return JSON.stringify({ state: "MERGED", mergeCommit: { oid: B } });
      return "";
    },
    rehearse: async (c) => { calls.rehearse.push(c); return c === "live" ? { ok: true, output: JSON.stringify({ sha: A, units: { api: "sha256:old-api", web: "sha256:old-web" } }) } : { ok: c === "make gen" ? regenOk : true, output: "" }; },
    now: () => 0, sleep: async () => {},
  };
  return { io, calls };
}
const mkctx = (w, extra = {}, pol = policy) => {
  const state = { id: "rel-1", steps: {} };
  const seen = { deploy: [], rollback: [] };
  const ctx = { io: w.io, repo: "o/r", def: "main", state, save() {}, policy: pol, date: "2026-11-13", n: 1, config: { deploy: { live_release_command: "live", pipelines: { service: { workflow: "svc.yml", inputs: {} } } } }, ...extra };
  ctx.ledger = { deployStep: async (c) => { seen.deploy.push(c); return extra.deployResult ?? {}; }, ...(extra.ledger ?? {}) };
  return { state, ctx, seen };
};
const wave = [{ issue: 5, pr: 11, record: rec }];

describe("runTrain", () => {
  it("demotes at CUT before creating any branch", async () => {
    const w = world({ files: { 11: ["svc/api/migrations/1.sql"] } }); const { ctx } = mkctx(w);
    const r = await runTrain(ctx, wave);
    assert.equal(r.status, "demoted");
    assert.ok(!w.calls.git.some((a) => a[0] === "push"));
  });
  it("ejects a widened issue and demotes when none remain", async () => {
    const w = world({ files: { 11: ["svc/api/a.js", "svc/worker/w.js"] } }); const { ctx } = mkctx(w);
    const r = await runTrain(ctx, wave);
    assert.equal(r.status, "demoted"); assert.equal(r.ejected[0].issue, 5);
  });
  it("creates train/<date>-<n> from live, lands with the lane trailers and dispatches merge sha + units", async () => {
    const w = world(); const { ctx, state, seen } = mkctx(w);
    const r = await runTrain(ctx, wave);
    assert.equal(r.status, "live");
    assert.deepEqual(w.calls.git.find((a) => a[0] === "push"), ["push", "--quiet", "origin", `${"a".repeat(40)}:refs/heads/train/2026-11-13-1`]);
    const merge = w.calls.gh.find((a) => a[1] === "merge" && a.includes("--body"));
    assert.equal(merge[merge.indexOf("--body") + 1], "Forge-Lane: train\nForge-Release: rel-1");
    assert.equal(state.lane, "train"); assert.deepEqual(state.train.previous, { api: "sha256:old-api" });
    assert.equal(state.steps["post-merge"].result.merge, "b".repeat(40));
    assert.deepEqual(seen.deploy[0].config.trainDispatch, { units: ["api"] });
    assert.equal(seen.deploy[0].config.deployPipeline, "service");
  });
  it("a contract wave orders the producer first and runs regenerate before the push", async () => {
    const w = world({ files: { 11: ["contract/x.json"] }, dirty: true });
    const { ctx, state } = mkctx(w);
    const r = await runTrain(ctx, [{ issue: 5, pr: 11, record: { units: ["api", "web"], migrations: "none", contract: true } }]);
    assert.deepEqual(state.train.order, ["api", "web"]); assert.deepEqual(state.train.units, ["api", "web"]);
    assert.ok(w.calls.rehearse.includes("make gen"));
    const ci = w.calls.git.findIndex((a) => a[0] === "commit"), pi = w.calls.git.findIndex((a, i) => a[0] === "push" && i > ci);
    assert.ok(ci >= 0 && pi > ci, "regenerate commit precedes the push");
    assert.equal(r.status, "verifying"); // web is a web surface and no purge seam is set
  });
  it("a failing regenerate refuses", async () => {
    const w = world({ files: { 11: ["contract/x.json"] }, regenOk: false }); const { ctx } = mkctx(w);
    const r = await runTrain(ctx, [{ issue: 5, pr: 11, record: { units: ["api", "web"], contract: true } }]);
    assert.equal(r.status, "refused");
  });
  it("on a deploy failure invokes rung 1 (flag) with the recorded digests", async () => {
    const w = world(); const calls = [];
    const { ctx, state } = mkctx(w, { deployResult: { blocked: true, reason: "smoke failed" } });
    state.deploy = { target: { sha: "a".repeat(40) }, runId: 7, merge: "b".repeat(40) };
    ctx.ledger.runRollback = async (c, a) => { calls.push({ digests: c.trainDigests, to: a.to }); return { rung: "flag", ok: true }; };
    const r = await runTrain(ctx, wave);
    assert.equal(r.status, "rolled-back");
    assert.deepEqual(calls, [{ digests: { api: "sha256:old-api" }, to: "flag" }]);
  });
  it("refuses without deploy.pipelines.service", async () => {
    const w = world(); const { ctx } = mkctx(w); ctx.config.deploy.pipelines = {};
    assert.equal((await runTrain(ctx, wave)).status, "refused");
  });
});

describe("web wave purge gate", () => {
  const webWave = [{ issue: 5, pr: 11, record: { units: ["web"], migrations: "none", contract: false } }];
  const run = (purge) => { const w = world({ files: { 11: ["svc/web/a.js"] } }); const m = mkctx(w, { purge }); return runTrain(m.ctx, webWave).then((r) => ({ r, state: m.state })); };
  it("without a purge seam stays VERIFYING and never reaches live", async () => {
    const { r, state } = await run(undefined);
    assert.equal(r.status, "verifying"); assert.match(r.reason, /no purge seam/); assert.equal(state.train.state, "VERIFYING");
  });
  it("a failing purge stays VERIFYING with the reason", async () => {
    const { r } = await run(async () => ({ ok: false, reason: "cdn 503" }));
    assert.equal(r.status, "verifying"); assert.match(r.reason, /cdn 503/);
  });
  it("a successful purge proceeds to live", async () => {
    let got; const { r, state } = await run(async (a) => { got = a; return { ok: true }; });
    assert.equal(r.status, "live"); assert.deepEqual(got.units, ["web"]); assert.equal(state.train.state, "LIVE");
  });
});
