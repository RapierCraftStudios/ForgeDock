// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { releaseFromCli, openRelease, RELEASE_STEPS } from "./release.mjs";
import { deployStep } from "./release-deploy.mjs";
import { runRollback } from "./release-rollback.mjs";
import { KINDS, CANARY, STAGES_KEY, engineOn, readEngine, validateEngine, normalise, canaryPlan, deployRisk, diffServices, stageParts, partsKey, decide, planStages, renderPlan, deployFromCli, clearStages, withEnv } from "./deploy-stages.mjs";
import { validateForgeYaml } from "../config-schema.mjs";

const OLD = "b".repeat(40), SHA = "a".repeat(40), SHA2 = "c".repeat(40), ID = "r20260101-000000-1";
const ORDER = ["build", "expand", "deploy-new", "smoke-new", "shift", "verify", "retire-old", "contract"];
const ENGINE = () => ({
  enabled: true, live_release_command: "live", colour: { active_command: "active" },
  rollback: { shift_back_command: "shift-back" },
  stages: [
    { id: "build", kind: "build", run: "build", inputs: ["services/**"] },
    { id: "expand", kind: "migrate", run: "expand", inputs: ["db/expand/**"] },
    { id: "deploy-new", kind: "deploy", run: "deploy-new", inputs: ["ops/**"] },
    { id: "smoke-new", kind: "smoke", run: "smoke-new", inputs: ["tests/smoke/**"] },
    { id: "shift", kind: "shift", run: "shift", inputs: ["ops/router/**"] },
    { id: "verify", kind: "verify", run: "verify", inputs: ["tests/verify/**"] },
    { id: "retire-old", kind: "retire", run: "retire-old", inputs: ["ops/**"] },
    { id: "contract", kind: "contract", run: "contract", inputs: ["db/contract/**"] },
  ],
});
const TREE = { "services/api/main.py": "o1", "db/expand/001.sql": "o2", "ops/compose.yml": "o3", "tests/smoke/home.sh": "o4", "ops/router/weights": "o5", "tests/verify/v.sh": "o6", "db/contract/001.sql": "o7", "README.md": "o8" };

/**
 * World: `live` is the sha the live record reports (the shift command at 100% moves it, shift-back restores it); `fail` maps a
 * command to how many times it still fails; `trees` the files (path -> blob id) of each commit; `numstat` the diff to the target.
 */
function world(o = {}) {
  const w = { live: OLD, active: "blue", fail: {}, ran: [], trees: { [SHA]: TREE }, numstat: "3\t1\tREADME.md", digests: { api: "sha256:1" }, now: 1_000_000, slept: [], gh: [], freeze: "", git: [], ...o };
  const io = {
    print: () => {}, now: () => w.now, sleep: async (ms) => { w.slept.push(ms); w.now += ms; },
    rehearse: async (full) => {
      const m = /^export (.*?); ([^;]*)$/.exec(full), cmd = m ? m[2] : full;
      const env = Object.fromEntries([...(m?.[1] ?? "").matchAll(/(\w+)='([^']*)'/g)].map((x) => [x[1], x[2]]));
      w.ran.push({ cmd, env });
      w.now += w.cost?.[cmd] ?? 10;
      if (w.fail[cmd] > 0) { w.fail[cmd] -= 1; return { ok: false, output: `${cmd} boom` }; }
      if (cmd === "live") return w.live ? { ok: true, output: w.live } : { ok: false, output: "" };
      if (cmd === "active") return { ok: true, output: w.active };
      if (cmd === "expected") return { ok: true, output: "{}" };
      if (cmd === "desired") return { ok: true, output: JSON.stringify(w.desired) };
      if (cmd === "livesvc") return { ok: true, output: JSON.stringify(w.liveSvc) };
      if (cmd === "build") return { ok: true, output: `built\n${JSON.stringify({ digests: w.digests })}` };
      if (cmd === "shift" && env.FORGE_TRAFFIC_PCT === "100") w.live = env.FORGE_SHA;
      if (cmd === "shift-back") w.live = OLD;
      return { ok: true, output: "" };
    },
    git: (a) => {
      w.git.push(a.join(" "));
      if (a[0] === "rev-parse") { const s = a.at(-1).replace(/\^\{.*$/, ""); if (!w.trees[s] && !/^origin\//.test(s)) throw new Error("bad object"); return `${/^origin\//.test(s) ? SHA : a.at(-1).endsWith("^{tree}") ? `tree-${s}` : s}\n`; }
      if (a[0] === "ls-tree") { const t = w.trees[a.at(-1)]; if (!t) throw new Error("bad object"); return Object.entries(t).map(([p, oid]) => `100644 blob ${oid}\t${p}`).join("\0") + "\0"; }
      if (a[0] === "diff") { if (w.numstat == null) throw new Error("bad revision"); return w.numstat; }
      if (a[0] === "merge-base") { if (w.notAncestor) throw new Error("exit 1"); return ""; }
      if (a[0] === "show") { if (w.defaultYaml == null) throw new Error("not tracked"); return w.defaultYaml; }
      throw new Error(`unexpected git ${a.join(" ")}`);
    },
    gh: async (a) => {
      w.gh.push(a.join(" "));
      if (a[0] === "variable") { if (!w.freeze) throw new Error("HTTP 404"); return w.freeze; }
      if (a[0] === "run" && a[1] === "list") return JSON.stringify(w.runs ?? []);
      if (a[0] === "workflow") { w.runs = [{ databaseId: (w.runs?.[0]?.databaseId ?? 0) + 1, status: "completed", conclusion: w.wfConclusion ?? "success" }, ...(w.runs ?? [])]; return ""; }
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
  };
  return { w, io };
}
const mk = (io, engine = ENGINE(), over = {}) => ({ io, repo: "o/r", def: "main", config: { deployEngine: engine, deployBounds: { pollMs: 1, runPollMs: 1 }, ...(over.config ?? {}) }, state: over.state ?? { id: ID, steps: { "post-merge": { result: { merge: SHA } } } }, save() {}, ...(over.ctx ?? {}) });
const cmds = (w, from = 0) => w.ran.slice(from).map((r) => r.cmd).filter((c) => ORDER.includes(c) || ["shift-back", "abort"].includes(c));

describe("deploy engine: off is today's behaviour (#5712)", () => {
  it("no engine block, or enabled: false: the legacy step runs, the engine leaves no trace and no stage command runs", async () => {
    for (const engine of [undefined, null, { ...ENGINE(), enabled: false }, { ...ENGINE(), enabled: "true" }]) {
      const { w, io } = world(); const c = mk(io, null); c.config.deployEngine = engine;
      assert.deepEqual(await deployStep(c), { skipped: true }); assert.equal(c.state.deploy, undefined); assert.equal(w.ran.length, 0); assert.equal(w.git.length, 0);
      assert.equal(engineOn(engine), false);
    }
  });
  it("readEngine: no git call and null unless the working copy turns it on; then the default branch's forge.yaml wins", () => {
    const on = "deploy:\n  engine:\n    enabled: true\n    stages:\n      - id: a\n        run: x\n", off = "deploy:\n  engine:\n    enabled: false\n";
    const { w, io } = world();
    assert.equal(readEngine({ raw: "release:\n  managed: true\n", io, def: "main" }), null);
    assert.equal(readEngine({ raw: off, io, def: "main" }), null);
    assert.equal(w.git.length, 0);
    assert.equal(readEngine({ raw: on, io, def: "main" }).stages[0].id, "a"); // not tracked on the default branch: the working copy
    w.defaultYaml = off;
    assert.equal(readEngine({ raw: on, io, def: "main" }), null, "a checkout cannot turn the engine on over the default branch");
    w.defaultYaml = on.replace("id: a", "id: b");
    assert.equal(readEngine({ raw: on, io, def: "main" }).stages[0].id, "b");
    assert.match(validateEngine(readEngine({ raw: "deploy:\n  engine:\n    enabled: true\n    stages: [a\n" }))[0], /not valid YAML/);
  });
  it("a release the engine started is never handed to the workflow pipeline on a host without the engine", async () => {
    const { w, io } = world(); const c = mk(io, null, { config: { deploy: { live_release_command: "live", pipelines: { full: { workflow: "deploy.yml", trigger: "dispatch" } } } } });
    c.state.deploy = { phase: "DEPLOYING", target: { sha: OLD }, engine: { started_at: "t" }, attempts: 0, reruns: 0 };
    const out = await deployStep(c);
    assert.equal(out.blocked, true); assert.equal(out.hold.label, "needs-agent"); assert.equal(w.gh.length, 0);
  });
});

describe("deploy engine: stage machine (#5712)", () => {
  it("runs every stage in order, smokes the new colour before any traffic, and ends LIVE with a checkpoint per stage", async () => {
    const { w, io } = world(); const c = mk(io);
    const out = await deployStep(c);
    assert.equal(out.live, true); assert.equal(out.merge, SHA);
    assert.deepEqual(cmds(w), ORDER);
    assert.equal(c.state.deploy.phase, "LIVE"); assert.equal(c.state.deploy.target.sha, OLD);
    assert.deepEqual(Object.keys(c.state.deploy.stages), ORDER);
    for (const cp of Object.values(c.state.deploy.stages)) { assert.equal(cp.status, "done"); assert.equal(cp.sha, SHA); assert.ok(cp.key && cp.ms >= 0); }
    assert.deepEqual(c.state.deploy.stages.build.outputs, { digests: { api: "sha256:1" } });
    const smoke = w.ran.find((r) => r.cmd === "smoke-new");
    assert.deepEqual([smoke.env.FORGE_COLOUR, smoke.env.FORGE_OLD_COLOUR, smoke.env.FORGE_SHA, smoke.env.FORGE_STAGE, smoke.env.FORGE_TARGET_SHA], ["green", "blue", SHA, "smoke-new", OLD]);
    assert.ok(c.state.deploy.engine.traffic_at);
  });
  it("I9: an unknown rollback target blocks before any stage", async () => {
    const { w, io } = world({ live: null });
    const out = await deployStep(mk(io));
    assert.match(out.reason, /rollback target unknown/); assert.deepEqual(cmds(w), []);
  });
  it("I26: a set freeze variable blocks before any stage", async () => {
    const { w, io } = world({ freeze: "1" });
    const out = await deployStep(mk(io, ENGINE(), { config: { deploy: { freeze_variable: "DEPLOY_FREEZE" } } }));
    assert.match(out.reason, /I26/); assert.deepEqual(cmds(w), []);
  });
  it("an invalid stage list blocks and deploys nothing", async () => {
    const { w, io } = world(); const e = ENGINE(); e.stages = e.stages.filter((s) => s.kind !== "smoke");
    const out = await deployStep(mk(io, e));
    assert.match(out.reason, /smoke stage must come before/); assert.deepEqual(cmds(w), []);
  });
  for (const id of ORDER) {
    it(`resume after a failure at ${id}: earlier stages are not run again`, async () => {
      const { w, io } = world({ fail: { [id]: 1 } }); const c = mk(io);
      const first = await deployStep(c), i = ORDER.indexOf(id);
      assert.equal(first.blocked, true); assert.match(first.reason, new RegExp(`stage ${id} \\(`));
      const kind = ENGINE().stages[i].kind, pre = i < ORDER.indexOf("shift"), shifted = !pre && i < ORDER.indexOf("retire-old");
      assert.equal(!!first.preTraffic, pre); assert.equal(!!first.rolledBack, shifted); assert.equal(!!first.hold, !pre && !shifted, kind);
      assert.deepEqual(cmds(w), [...ORDER.slice(0, i + 1), ...(shifted ? ["shift-back"] : [])]);
      if (pre) assert.equal(w.live, OLD, "the old colour keeps serving");
      const mark = w.ran.length;
      const second = await deployStep(c);
      assert.equal(second.live, true);
      assert.deepEqual(cmds(w, mark), ORDER.slice(shifted ? ORDER.indexOf("shift") : i), "only the failed stage and what follows it (after a shift-back: from the shift)");
      assert.equal(c.state.deploy.stages[id].attempt, 2);
    });
  }
  it("a stage that throws is a failed stage, not a crash", async () => {
    const { io } = world(); const c = mk(io); const orig = io.rehearse;
    io.rehearse = async (cmd, o) => { if (/; expand$/.test(cmd)) throw new Error("ssh: connection reset"); return orig(cmd, o); };
    const out = await deployStep(c);
    assert.equal(out.preTraffic, true); assert.match(out.reason, /connection reset/); assert.equal(c.state.deploy.stages.expand.status, "failed");
  });
});

describe("deploy engine: input-change invalidation (#5712)", () => {
  const failedSmoke = async (o = {}) => { const { w, io } = world({ fail: { "smoke-new": 1 }, ...o }); const c = mk(io); await deployStep(c); return { w, io, c, mark: w.ran.length }; };
  it("a smoke-fix commit re-runs the smoke stage and nothing before it", async () => {
    const { w, c, mark } = await failedSmoke();
    w.trees[SHA2] = { ...TREE, "tests/smoke/home.sh": "o4-fixed" };
    c.config.deploySha = SHA2;
    const out = await deployStep(c);
    assert.equal(out.live, true); assert.equal(out.merge, SHA2); assert.equal(w.live, SHA2);
    assert.deepEqual(cmds(w, mark), ORDER.slice(ORDER.indexOf("smoke-new")));
    assert.equal(c.state.deploy.stages.build.sha, SHA, "the build checkpoint is the first attempt's");
    assert.equal(c.state.deploy.stages["smoke-new"].sha, SHA2);
    assert.equal(c.state.deploy.target.sha, OLD, "the rollback target stays the pre-release live sha");
  });
  it("a commit outside every stage's inputs re-runs nothing that is done", async () => {
    const { w, c, mark } = await failedSmoke();
    w.trees[SHA2] = { ...TREE, "README.md": "o8-new" };
    c.config.deploySha = SHA2; await deployStep(c);
    assert.deepEqual(cmds(w, mark), ORDER.slice(ORDER.indexOf("smoke-new")));
  });
  it("a service change re-runs build; later stages re-run only when its outputs (digests) changed", async () => {
    const same = await failedSmoke();
    same.w.trees[SHA2] = { ...TREE, "services/api/main.py": "o1-comment" };
    same.c.config.deploySha = SHA2; await deployStep(same.c);
    assert.deepEqual(cmds(same.w, same.mark), ["build", ...ORDER.slice(ORDER.indexOf("smoke-new"))], "same digests: the idle colour is not redeployed");
    const diff = await failedSmoke();
    diff.w.trees[SHA2] = { ...TREE, "services/api/main.py": "o1-fix" }; diff.w.digests = { api: "sha256:2" };
    diff.c.config.deploySha = SHA2; await deployStep(diff.c);
    assert.deepEqual(cmds(diff.w, diff.mark), ORDER, "new digests: everything that depends on the build runs again");
  });
  it("a stage without inputs depends on the whole tree; an unreadable commit never matches a checkpoint", async () => {
    const e = ENGINE(); delete e.stages[0].inputs;
    const { w, io } = world({ fail: { "smoke-new": 1 } }); const c = mk(io, e); await deployStep(c);
    w.trees[SHA2] = { ...TREE, "README.md": "o8-new" }; c.config.deploySha = SHA2;
    const mark = w.ran.length; await deployStep(c);
    assert.equal(cmds(w, mark)[0], "build");
    assert.equal(decide({ status: "done", parts: stageParts({ stage: normalise(e).stages[1], tree: `unreadable:${SHA}`, services: null, needs: {}, base: {} }) }, stageParts({ stage: normalise(e).stages[1], tree: `unreadable:${SHA2}`, services: null, needs: {}, base: {} })).run, true);
  });
  it("a changed stage definition, a moved live baseline and a failed check each re-run the stage", async () => {
    const { w, io } = world({ fail: { "smoke-new": 1 } }); const e = ENGINE(); const c = mk(io, e); await deployStep(c);
    e.stages[1].run = "expand"; e.stages[1].check = "expand-check"; // definition changed (a check was added)
    w.fail["smoke-new"] = 1; let mark = w.ran.length; await deployStep(c);
    assert.deepEqual(cmds(w, mark), ["expand", "deploy-new", "smoke-new"], "expand declares no outputs, so its changed key reaches the stages that need it");
    w.fail["expand-check"] = 1; w.fail["smoke-new"] = 1; mark = w.ran.length; await deployStep(c);
    assert.deepEqual(cmds(w, mark), ["expand", "deploy-new", "smoke-new"], "a failed check means the environment drifted: that stage and all after it");
    const p = stageParts({ stage: e.stages[0], tree: "t", services: null, needs: {}, base: { target: OLD } });
    assert.match(decide({ status: "done", parts: p, sha: SHA }, { ...p, base: "x" }).why, /live baseline/);
    assert.deepEqual(decide({ status: "done", parts: p, sha: SHA }, p), { run: false, why: "done at aaaaaaaa, inputs unchanged" });
    assert.equal(decide(null, p).why, "no checkpoint");
    assert.notEqual(partsKey(p), partsKey({ ...p, paths: "u" }));
  });
});

describe("deploy engine: smoke before traffic, rollback (#5712)", () => {
  it("a smoke failure moves no traffic: no shift, no hold, no rollback trigger, no freeze", async () => {
    const { w, io } = world({ fail: { "smoke-new": 1 } }); const triggers = [];
    const c = mk(io, ENGINE(), { ctx: { rollbackTrigger: (t) => triggers.push(t) } });
    const out = await deployStep(c);
    assert.equal(out.preTraffic, true); assert.equal(out.hold, undefined); assert.equal(out.rollback, undefined); assert.equal(out.rolledBack, undefined);
    assert.match(out.reason, /no traffic moved, blue keeps serving \(no freeze, no hold\)/);
    assert.ok(!cmds(w).includes("shift") && !cmds(w).includes("shift-back"));
    assert.deepEqual(triggers, []); assert.equal(w.live, OLD);
    assert.ok(!w.gh.some((g) => /variable set|workflow run/.test(g)));
    assert.deepEqual(c.state.deploy.engine.last, { stage: "smoke-new", pre_traffic: true, rollback: { kind: "none", ok: true, ms: 0 } });
    assert.equal(c.state.deploy.engine.traffic_at, undefined);
  });
  it("abort_command tears the idle colour down inside the budget and the next run deploys it again", async () => {
    const e = ENGINE(); e.rollback.abort_command = "abort";
    const { w, io } = world({ fail: { "smoke-new": 1 } }); const c = mk(io, e);
    const out = await deployStep(c);
    assert.equal(out.engine.rollback.kind, "abort"); assert.ok(out.engine.rollback.ms <= 60_000);
    assert.equal(c.state.deploy.stages["deploy-new"].status, "aborted");
    const mark = w.ran.length; await deployStep(c);
    assert.deepEqual(cmds(w, mark), ORDER.slice(ORDER.indexOf("deploy-new")));
  });
  it("a failure after the shift moves traffic back inside rollback.budget_s and emits no ladder trigger", async () => {
    const { w, io } = world({ fail: { verify: 1 } }); const triggers = [], timeouts = [];
    const c = mk(io, ENGINE(), { ctx: { rollbackTrigger: (t) => triggers.push(t) } }); const orig = io.rehearse;
    io.rehearse = async (cmd, o) => { if (/; shift-back$/.test(cmd)) timeouts.push(o.timeout); return orig(cmd, o); };
    const out = await deployStep(c);
    assert.equal(out.rolledBack, true); assert.equal(w.live, OLD); assert.deepEqual(triggers, []); assert.deepEqual(timeouts, [60_000]);
    assert.equal(w.ran.find((r) => r.cmd === "shift-back").env.FORGE_TRAFFIC_PCT, "0");
    assert.equal(c.state.deploy.engine.last.rollback.kind, "shift-back"); assert.ok(c.state.deploy.engine.last.rollback.ms <= 60_000);
    assert.deepEqual(Object.values(c.state.deploy.stages).map((cp) => cp.status), ["done", "done", "done", "done", "rolled-back", "rolled-back"], "the shift and what followed it must run again");
  });
  it("a live record that is not the deployed sha after the shift fails verify (I28) and shifts back", async () => {
    const { w, io } = world(); const c = mk(io); const orig = io.rehearse;
    io.rehearse = async (cmd, o) => { const r = await orig(cmd, o); if (/; shift$/.test(cmd)) w.live = OLD; return r; }; // the router did not move
    const out = await deployStep(c);
    assert.match(out.reason, /LIVE_CHECK failed: live is bbbbbbbb/); assert.equal(out.rolledBack, true); assert.ok(!cmds(w).includes("verify"));
  });
  it("a failed or missing shift-back hands over to the rollback ladder", async () => {
    for (const setup of [(w) => { w.fail["shift-back"] = 1; }, (w, e) => { delete e.rollback.shift_back_command; }]) {
      const { w, io } = world({ fail: { verify: 1 } }); const e = ENGINE(); setup(w, e); const triggers = [];
      const out = await deployStep(mk(io, e, { ctx: { rollbackTrigger: (t) => triggers.push(t) } }));
      assert.equal(out.rolledBack, undefined); assert.match(out.rollback.reason, /stage verify/); assert.equal(triggers.length, 1); assert.equal(triggers[0].sha, SHA);
    }
  });
  it("after the old colour is retired there is no shift-back: hold for a roll-forward", async () => {
    const { w, io } = world({ fail: { contract: 1 } });
    const out = await deployStep(mk(io));
    assert.equal(out.hold.label, "needs-agent"); assert.ok(!cmds(w).includes("shift-back")); assert.equal(w.live, SHA);
  });
  it("a verification layer that asks to wait or hold is not a failure: no shift-back, the stage is retried on resume", async () => {
    const { w, io } = world(); const c = mk(io, ENGINE(), { config: { verify: { results: [{ workflow: "smoke.yml", kind: "smoke" }] } } });
    const out = await deployStep(c);
    assert.match(out.reason, /stage verify: smoke.yml \(smoke\) has no completed run/); assert.equal(out.rolledBack, undefined); assert.ok(!cmds(w).includes("shift-back"));
    assert.equal(c.state.deploy.stages.verify, undefined);
    w.runs = [{ databaseId: 5, status: "completed", conclusion: "success" }];
    const mark = w.ran.length, again = await deployStep(c);
    assert.equal(again.live, true); assert.equal(again.verify.verified, true); assert.deepEqual(cmds(w, mark), ["verify", "retire-old", "contract"]);
  });
  it("a code rollback forgets every stage checkpoint", async () => {
    const { io } = world({ fail: { verify: 1 } }); const c = mk(io); await deployStep(c);
    assert.ok(Object.keys(c.state.deploy.stages).length > 0);
    c.policy = { rollback: { ladder: ["stop"] } };
    await clearStages(c);
    assert.deepEqual(c.state.deploy.stages, {});
    assert.equal(typeof runRollback, "function");
  });
});

describe("deploy engine: changed services only (#5712)", () => {
  const D = (digest, config) => ({ digest, config });
  it("diffServices: unchanged needs the same digest and the same config hash on both sides", () => {
    const desired = { api: D("d1", "c1"), web: D("d2", "c2"), cron: D("d3", "c3"), mail: D("d4", "c4"), old: "d5", bare: D("d6"), gone: D(null, "c7") };
    const live = { api: D("d1", "c1"), web: D("d9", "c2"), cron: D("d3", "c9"), old: "d5", bare: D("d6"), gone: D("d7", "c7") };
    const r = diffServices(desired, live);
    assert.deepEqual(r.unchanged, ["api"]);
    assert.deepEqual(Object.fromEntries(r.changed.map((c) => [c.service, c.why])), { web: "image digest changed", cron: "config changed", mail: "not running", old: "no config hash reported", bare: "no config hash reported", gone: "no desired digest reported" });
    assert.deepEqual(diffServices({ api: D("d1", "c1") }, null).changed, [{ service: "api", why: "not running" }]);
  });
  const svcEngine = (mode) => { const e = ENGINE(); e.services = { mode, desired_command: "desired", live_command: "livesvc" }; for (const s of e.stages) if (["build", "deploy", "smoke"].includes(s.kind)) s.services = true; return e; };
  const SVC = { desired: { api: D("d1", "c1"), web: D("d2", "c2"), cron: D("d3", "c3") }, liveSvc: { api: D("d0", "c1"), web: D("d2", "c2"), cron: D("d3", "c3") } };
  it("enforce: only the changed service reaches the stages; the skipped ones are recorded", async () => {
    const { w, io } = world(SVC); const c = mk(io, svcEngine("enforce"));
    const out = await deployStep(c);
    assert.equal(out.live, true);
    const dep = w.ran.find((r) => r.cmd === "deploy-new");
    assert.equal(dep.env.FORGE_SERVICES, "api"); assert.equal(dep.env.FORGE_SERVICES_SKIPPED, "cron,web");
    assert.deepEqual(c.state.deploy.services, { mode: "enforce", changed: [{ service: "api", why: "image digest changed" }], skipped: ["cron", "web"] });
  });
  it("enforce with nothing changed: service stages are skipped, the rest still run", async () => {
    const { w, io } = world({ ...SVC, liveSvc: SVC.desired }); const c = mk(io, svcEngine("enforce"));
    const out = await deployStep(c);
    assert.equal(out.live, true); assert.deepEqual(cmds(w), ["expand", "shift", "verify", "retire-old", "contract"]);
    assert.deepEqual(out.engine.stages.filter((s) => !s.run).map((s) => s.why), ["no changed services", "no changed services", "no changed services"]);
  });
  it("shadow (the default with a desired_command): everything is deployed, the would-be skip and its agreement are recorded", async () => {
    const e = svcEngine("shadow"); delete e.services.mode;
    const { w, io } = world(SVC); const c = mk(io, e);
    await deployStep(c);
    const dep = w.ran.find((r) => r.cmd === "deploy-new");
    assert.equal(dep.env.FORGE_SERVICES, "api,cron,web"); assert.equal(dep.env.FORGE_SERVICES_SKIPPED, "");
    assert.deepEqual(c.state.deploy.services.would_skip, ["cron", "web"]);
    assert.deepEqual(c.state.deploy.services.agreement, { agree: 2, disagree: [] });
    const dis = world(SVC); const c2 = mk(dis.io, svcEngine("shadow")); const orig = dis.io.rehearse;
    dis.io.rehearse = async (cmd, o) => { const r = await orig(cmd, o); if (/; deploy-new$/.test(cmd)) dis.w.liveSvc = { ...dis.w.liveSvc, web: D("d2", "c-drifted") }; return r; };
    await deployStep(c2);
    assert.deepEqual(c2.state.deploy.services.agreement, { agree: 1, disagree: [{ service: "web", why: "config changed" }] });
  });
  it("a changed digest changes the key of service stages only", async () => {
    const { w, io } = world({ ...SVC, fail: { "smoke-new": 1 } }); const c = mk(io, svcEngine("enforce")); await deployStep(c);
    w.desired = { ...SVC.desired, api: D("d1b", "c1") };
    const mark = w.ran.length; await deployStep(c);
    assert.deepEqual(cmds(w, mark), ["build", "deploy-new", "smoke-new", "shift", "verify", "retire-old", "contract"], "expand has no service slice and is not run again");
  });
  it("unreadable desired digests, or a refused promotion, block before anything is deployed", async () => {
    const a = world({ desired: null, liveSvc: {} });
    assert.match((await deployStep(mk(a.io, svcEngine("enforce")))).reason, /desired digests are unreadable/); assert.deepEqual(cmds(a.w), []);
    const b = world(SVC), asked = [];
    const promote = { serviceDigests: async () => SVC.desired, liveDigests: async () => SVC.liveSvc, canPromote: async (q) => { asked.push(q); return { ok: false, why: "no CI evidence for this digest" }; } };
    const out = await deployStep(mk(b.io, svcEngine("enforce"), { ctx: { promote } }));
    assert.match(out.reason, /service api cannot be promoted: no CI evidence/); assert.deepEqual(cmds(b.w), []);
    assert.deepEqual(asked, [{ service: "api", digest: "d1", sha: SHA }]);
    assert.ok(!b.w.ran.some((r) => r.cmd === "desired"), "the promote interface replaces the commands");
  });
});

describe("deploy engine: canary by risk class (#5712)", () => {
  it("canaryPlan: defaults per class, per-repo override, unknown class is the most careful", () => {
    assert.deepEqual(canaryPlan({ canary: {} }, "low"), CANARY.low);
    assert.deepEqual(canaryPlan({ canary: { medium: { wait_s: 30 } } }, "medium"), { steps: [10, 100], wait_s: 30 });
    assert.deepEqual(canaryPlan({ canary: {} }, "p9"), CANARY.high);
  });
  it("deployRisk reuses riskOf: a small diff is low, a migration is high, an unreadable diff is high", () => {
    const ctx = (numstat, config = {}) => ({ io: world({ numstat }).io, config });
    assert.equal(deployRisk(ctx("3\t1\tREADME.md"), SHA, OLD).risk, "low");
    assert.equal(deployRisk(ctx("3\t1\tinfra/migrations/001.sql"), SHA, OLD).risk, "high");
    assert.equal(deployRisk(ctx("300\t200\tsrc/a.js"), SHA, OLD).risk, "medium");
    assert.deepEqual(deployRisk(ctx(null), SHA, OLD), { risk: "high", rule: "unreadable diff" });
    assert.equal(deployRisk(ctx("1\t1\tsrc/pay/x.js", { policy: { risk: { rules: [{ when: { paths: ["src/pay/**"] }, risk: "high" }] } } }), SHA, OLD).risk, "high");
    assert.equal(deployRisk(ctx(null, { deployRisk: "low" }), SHA, OLD).risk, "low");
  });
  it("low risk shifts straight to 100 with no wait; high risk steps 10, 50, 100 and waits between steps", async () => {
    const low = world(); await deployStep(mk(low.io));
    assert.deepEqual(low.w.ran.filter((r) => r.cmd === "shift").map((r) => r.env.FORGE_TRAFFIC_PCT), ["100"]); assert.deepEqual(low.w.slept, []);
    const high = world({ numstat: "3\t1\tinfra/migrations/001.sql" }); const e = ENGINE(); e.canary = { health_command: "health" };
    const c = mk(high.io, e); await deployStep(c);
    assert.deepEqual(high.w.ran.filter((r) => r.cmd === "shift").map((r) => r.env.FORGE_TRAFFIC_PCT), ["10", "50", "100"]);
    assert.equal(high.w.slept.reduce((a, b) => a + b, 0), 600_000); assert.ok(high.w.slept.every((ms) => ms <= 60_000), "waits are sliced for the lease heartbeat");
    assert.equal(high.w.ran.filter((r) => r.cmd === "health").length, 3); assert.equal(high.w.ran.find((r) => r.cmd === "shift").env.FORGE_RISK, "high");
    assert.equal(c.state.deploy.engine.risk.risk, "high");
  });
  it("a failed canary health check shifts back before the next step", async () => {
    const { w, io } = world({ numstat: "3\t1\tinfra/migrations/001.sql", fail: { health: 1 } }); const e = ENGINE(); e.canary = { health_command: "health" };
    const out = await deployStep(mk(io, e));
    assert.match(out.reason, /canary health failed at 10%/); assert.equal(out.rolledBack, true);
    assert.deepEqual(w.ran.filter((r) => r.cmd === "shift").map((r) => r.env.FORGE_TRAFFIC_PCT), ["10"]);
  });
  it("a resume in the middle of a canary wait does not set the share again and waits only the remainder", async () => {
    const HIGH = { numstat: "3\t1\tinfra/migrations/001.sql" };
    const a = world(HIGH), ca = mk(a.io); await deployStep(ca);
    const key = ca.state.deploy.stages.shift.key; // the same inputs give the same key in any world
    const { w, io } = world({ ...HIGH, fail: { "smoke-new": 1 } }); const c = mk(io); await deployStep(c);
    c.state.deploy.engine.shift = { key, step: 0, since: w.now - 100_000 }; // the host died 100 s into the wait after the 10% step
    const mark = w.ran.length, out = await deployStep(c);
    assert.equal(out.live, true);
    assert.deepEqual(w.ran.slice(mark).filter((r) => r.cmd === "shift").map((r) => r.env.FORGE_TRAFFIC_PCT), ["50", "100"]);
    const total = w.slept.reduce((a, b) => a + b, 0);
    assert.ok(total > 499_000 && total <= 500_000, `200 s left of the first wait plus 300 s, got ${total}`);
  });
});

describe("deploy engine: config (#5712)", () => {
  it("validateEngine accepts the documented shape and names each defect", () => {
    assert.deepEqual(validateEngine(ENGINE()), []);
    const bad = (mut) => { const e = ENGINE(); mut(e); return validateEngine(e).join(" | "); };
    assert.match(bad((e) => { e.stages = []; }), /non-empty list/);
    assert.match(bad((e) => { e.stages[1].id = "build"; }), /duplicate id/);
    assert.match(bad((e) => { e.stages[0].kind = "compile"; }), /kind "compile" is not one of/);
    assert.match(bad((e) => { e.stages[0].workflow = "b.yml"; }), /exactly one of run or workflow/);
    assert.match(bad((e) => { delete e.stages[0].run; }), /exactly one of run or workflow/);
    assert.match(bad((e) => { e.stages[0].needs = ["smoke-new"]; }), /not an earlier stage/);
    assert.match(bad((e) => { e.stages[0].inputs = "services/**"; }), /inputs: expected a list/);
    assert.match(bad((e) => { e.stages[0].retries = 3; }), /retries: unknown key/);
    assert.match(bad((e) => { e.stages = e.stages.filter((s) => s.kind !== "verify"); }), /verify stage is required/);
    assert.match(bad((e) => { const [sm] = e.stages.splice(3, 1); e.stages.splice(4, 0, sm); }), /smoke stage must come before the first shift/);
    assert.match(bad((e) => { const [r] = e.stages.splice(6, 1); e.stages.splice(4, 0, r); }), /retire stages come after verify/);
    assert.match(bad((e) => { e.services = { mode: "sometimes" }; }), /services.mode/);
    assert.match(bad((e) => { e.canary = { high: { steps: [50, 10, 100] } }; }), /ascending percentages ending in 100/);
    assert.match(bad((e) => { e.canary = { severe: {} }; }), /unknown risk class/);
    assert.match(bad((e) => { e.rollback.budget_s = 0; }), /budget_s/);
    assert.match(bad((e) => { e.pipelines = {}; }), /pipelines: unknown key/);
    const noRun = ENGINE(); delete noRun.stages[5].run;
    assert.deepEqual(validateEngine(noRun), [], "a verify stage may rely on the built-in verification alone");
  });
  it("every stage kind documents its idempotency contract; withEnv quotes values", () => {
    for (const k of ["build", "migrate", "deploy", "smoke", "shift", "verify", "retire", "contract", "run"]) assert.ok(KINDS[k].length > 30, k);
    assert.equal(withEnv("x", { A: "it's", B: "1" }), `export A='it'\\''s' B='1'; x`);
  });
  it("forge.yaml schema check: deploy.engine keys are known, a typo is flagged, keys of stage items are not mistaken for engine keys", () => {
    const base = 'project:\n  owner: "o"\n  repo: "r"\npaths:\n  root: "/x"\nbranches:\n  default: "main"\n';
    const ok = base + "deploy:\n  engine:\n    enabled: true\n    live_release_command: \"x\"\n    stage_timeout_s: 600\n    colour:\n      active_command: \"y\"\n    services:\n      mode: shadow\n      desired_command: \"d\"\n    canary:\n      high:\n        wait_s: 60\n    rollback:\n      budget_s: 60\n      shift_back_command: \"z\"\n    stages:\n      - id: build\n        kind: build\n        run: \"make images\"\n        inputs:\n          - \"services/**\"\n      - id: verify\n        kind: verify\n";
    assert.deepEqual(validateForgeYaml(ok), []);
    const codes = (t) => validateForgeYaml(t).map((f) => `${f.code}:${f.key}`).sort();
    assert.deepEqual(codes(base + "deploy:\n  engine:\n    enable: true\n    services:\n      mode: maybe\n    rollback:\n      budget: 60\n"), ["unknown-key:deploy.engine.enable", "unknown-key:deploy.engine.rollback.budget", "wrong-type:deploy.engine.services.mode"]);
    assert.deepEqual(codes(base + "deploy:\n  engine:\n    enabled: yes please\n"), ["wrong-type:deploy.engine.enabled"]);
  });
});

describe("deploy engine: plan and CLI (#5712)", () => {
  const failed = async () => { const { w, io } = world({ fail: { "smoke-new": 1 } }); const c = mk(io); await deployStep(c); return { w, io, c }; };
  it("planStages says which stages would run and why, and runs nothing", async () => {
    const { w, io, c } = await failed(); const mark = w.ran.length;
    const p = await planStages({ ...c, state: structuredClone(c.state) }, SHA);
    assert.deepEqual(p.stages.map((s) => [s.stage, s.run]), ORDER.map((id, i) => [id, i >= 3]));
    assert.equal(p.stages[0].why, "done at aaaaaaaa, inputs unchanged"); assert.match(p.stages[3].why, /failed last time: smoke-new boom/); assert.equal(p.stages[4].why, "no checkpoint");
    assert.ok(p.stages.every((s) => s.contract === KINDS[s.kind]));
    assert.deepEqual(cmds(w, mark), [], "no stage command");
    w.trees[SHA2] = { ...TREE, "services/api/main.py": "o1b" };
    const p2 = await planStages({ ...c, state: structuredClone(c.state) }, SHA2);
    assert.match(p2.stages[0].why, /inputs changed: files matching inputs/); assert.match(p2.stages[2].why, /re-runs if the outputs of build change/);
    const text = renderPlan(p);
    assert.match(text, /^deploy plan for aaaaaaaa \(live bbbbbbbb; risk low, rule default; canary 100%; new colour green\)/); assert.match(text, /\n {2}skip {2}build \(build\): done at/); assert.match(text, /\n {2}run {3}smoke-new \(smoke\): failed last time/);
    assert.equal(io, c.io);
  });
  it("release deploy --plan prints the plan (text or JSON) for a release or for the default branch head", async () => {
    const { io, c } = await failed(); const out = []; io.print = (l) => out.push(l);
    const deps = { io, load: async (id) => (id === ID ? c.state : null), engine: c.config.deployEngine, def: "main", repo: "o/r" };
    assert.equal(await deployFromCli(["--plan", ID], deps), 0); assert.match(out[0], /skip {2}build/);
    assert.equal(await deployFromCli(["--plan", ID, "--json"], deps), 0); assert.equal(JSON.parse(out[1]).stages[3].run, true);
    assert.equal(await deployFromCli(["--plan"], deps), 0); assert.match(out[2], /run {3}build \(build\): no checkpoint/);
    assert.equal(c.state.deploy.stages["smoke-new"].status, "failed", "the plan never changes the release state");
  });
  it("release deploy --resume hands a merged release back to the release job; --sha must be on the default branch and contain the merge", async () => {
    const { w, io, c } = await failed(); const out = []; io.print = (l) => out.push(l); w.trees[SHA2] = TREE;
    const deps = { io, load: async (id) => (id === ID ? c.state : id === "r20260101-000000-2" ? { id, steps: {} } : null), engine: c.config.deployEngine, def: "main", repo: "o/r" };
    assert.deepEqual(await deployFromCli(["--resume", ID], deps), { resume: ID, sha: null });
    assert.deepEqual(await deployFromCli(["--resume", ID, "--sha", SHA2], deps), { resume: ID, sha: SHA2 });
    w.notAncestor = true;
    assert.equal(await deployFromCli(["--resume", ID, "--sha", SHA2], deps), 1); assert.match(out.at(-1), /--sha must be a commit on origin\/main that contains the release merge aaaaaaaa/);
    assert.equal(await deployFromCli(["--resume", "r20260101-000000-2"], deps), 1); assert.match(out.at(-1), /not merged yet/);
    assert.equal(await deployFromCli(["--resume", "r20260101-000000-9"], deps), 1); assert.match(out.at(-1), /no release/);
    assert.equal(await deployFromCli([ID], deps), 1); assert.match(out.at(-1), /exactly one of --plan or --resume/);
    assert.equal(await deployFromCli(["--plan", ID], { ...deps, engine: null }), 1); assert.match(out.at(-1), /deploy.engine.enabled is not on/);
  });
});

describe("deploy engine: durable checkpoints and workflow stages (#5712)", () => {
  /** A ledger `_active` branch behind `io.api` (the contents and git-data calls updateActive uses). */
  const ledger = (io) => {
    const l = { active: { epoch: 1, lease: { holder: "h", epoch: 1, release: ID } }, commits: 0 };
    io.api = async (m, path, body) => {
      if (/contents\/active\.json/.test(path)) return { content: Buffer.from(JSON.stringify(l.active)).toString("base64") };
      if (/git\/ref\/heads\//.test(path)) return { object: { sha: "h0" } };
      if (/git\/commits\/h0$/.test(path)) return { tree: { sha: "t0" } };
      if (m === "POST" && /git\/trees$/.test(path)) { l.active = JSON.parse(body.tree.find((f) => f.path === "active.json").content); return { sha: "t1" }; }
      if (m === "POST" && /git\/commits$/.test(path)) { l.commits += 1; return { sha: "h0" }; }
      if (m === "PATCH" && /git\/refs/.test(path)) return {};
      if (m === "PATCH" && /issues\/comments\//.test(path)) { l.beats = (l.beats ?? 0) + 1; return {}; }
      throw new Error(`unrouted ${m} ${path}`);
    };
    const lctx = { io, repo: "o/r", credential: "driver" };
    return { l, fence: (release) => ({ lctx, lease: { holder: "h", epoch: 1, release }, now: () => "t", record: async () => {} }) };
  };
  it("a managed release keeps checkpoints on the ledger: the next release starts from what the failed one finished", async () => {
    const { w, io } = world({ fail: { "smoke-new": 1 } }); const { l, fence } = ledger(io);
    const first = mk(io, ENGINE(), { ctx: { fence: fence(ID) } });
    assert.equal((await deployStep(first)).preTraffic, true);
    assert.deepEqual(Object.keys(l.active[STAGES_KEY]), ORDER.slice(0, 4)); assert.equal(l.active[STAGES_KEY]["smoke-new"].status, "failed");
    assert.equal(l.active.lease.holder, "h", "only the deploy_stages key of _active is written");
    w.trees[SHA2] = { ...TREE, "tests/smoke/home.sh": "o4-fixed" };
    const ID2 = "r20260102-000000-1", mark = w.ran.length;
    l.active.lease.release = ID2;
    const next = mk(io, ENGINE(), { state: { id: ID2, steps: { "post-merge": { result: { merge: SHA2 } } } }, ctx: { fence: fence(ID2) } });
    const out = await deployStep(next);
    assert.equal(out.live, true); assert.deepEqual(cmds(w, mark), ORDER.slice(3), "build, expand and deploy-new of the failed release are reused");
    assert.equal(l.active[STAGES_KEY].build.release, ID); assert.equal(l.active[STAGES_KEY].contract.release, ID2);
    await clearStages(next);
    assert.deepEqual(l.active[STAGES_KEY], {}); assert.deepEqual(next.state.deploy.stages, {});
  });
  it("a release after one that went live shares nothing with it: the live baseline moved", async () => {
    const { w, io } = world(); const { fence } = ledger(io);
    await deployStep(mk(io, ENGINE(), { ctx: { fence: fence(ID) } }));
    w.trees[SHA2] = TREE; w.active = "green";
    const ID2 = "r20260102-000000-1", mark = w.ran.length;
    const out = await deployStep(mk(io, ENGINE(), { state: { id: ID2, steps: { "post-merge": { result: { merge: SHA2 } } } }, ctx: { fence: fence(ID2) } }));
    assert.equal(out.live, true); assert.deepEqual(cmds(w, mark), ORDER);
    assert.equal(w.ran.slice(mark).find((r) => r.cmd === "deploy-new").env.FORGE_COLOUR, "blue");
  });
  it("the lease heartbeat is kept fresh per stage; a lease taken over by another host stops the run before the next stage", async () => {
    const { w, io } = world(); const { l, fence } = ledger(io); const c = mk(io, ENGINE(), { ctx: { fence: fence(ID) } }); const orig = io.rehearse;
    io.rehearse = async (cmd, o) => { const r = await orig(cmd, o); if (/; expand$/.test(cmd)) l.active.lease = { holder: "conductor-gh", epoch: 2, release: ID }; return r; };
    const out = await deployStep(c);
    assert.match(out.reason, /stage deploy-new: fenced: another host took over/); assert.deepEqual(cmds(w), ["build", "expand"]); assert.equal(l.beats, 2);
    assert.equal(out.preTraffic, undefined);
  });
  it("--sha refreshes the expected digests for the new commit", async () => {
    const { w, io } = world({ fail: { "smoke-new": 1 } }); const c = mk(io, ENGINE(), { config: { deploy: { expected_digests_command: "expected" } } });
    await deployStep(c); w.trees[SHA2] = TREE; c.config.deploySha = SHA2; w.fail.expected = 1;
    assert.match((await deployStep(c)).reason, /expected_digests_command returned no digests for the new sha/);
    assert.equal(w.ran.at(-1).env.FORGE_SHA, SHA2);
  });
  it("an unreadable checkpoint store blocks (I5) before any stage", async () => {
    const { w, io } = world(); const { fence } = ledger(io); io.api = async () => { throw new Error("HTTP 502"); };
    const out = await deployStep(mk(io, ENGINE(), { ctx: { fence: { ...fence(ID) } } }));
    assert.match(out.reason, /cannot read the stage checkpoints \(I5\)/); assert.deepEqual(cmds(w), []);
  });
  it("a workflow stage is dispatched once with its inputs; a resume observes the run; a failed run is dispatched again as the next attempt", async () => {
    const e = ENGINE(); delete e.stages[2].run; e.stages[2].workflow = "stage.yml";
    const { w, io } = world({ wfConclusion: "failure" }); const c = mk(io, e);
    const first = await deployStep(c);
    assert.match(first.reason, /stage deploy-new \(deploy\) failed: stage.yml run 1 concluded failure/); assert.equal(first.preTraffic, true);
    const disp = () => w.gh.filter((g) => g.startsWith("workflow run"));
    assert.equal(disp().length, 1);
    assert.match(disp()[0], /^workflow run stage.yml --repo o\/r --ref main -f stage=deploy-new -f sha=a{40} -f release=r20260101-000000-1 -f colour=green -f old_colour=blue$/);
    w.wfConclusion = "success";
    const second = await deployStep(c);
    assert.equal(second.live, true); assert.equal(disp().length, 2); assert.equal(c.state.deploy.stages["deploy-new"].attempt, 2);
    const again = world(); const c2 = mk(again.io, e); // a crash after the dispatch: the record says dispatched, so the run is observed, never dispatched twice
    c2.state.deploy = undefined; await deployStep(c2);
    const n = again.w.gh.filter((g) => g.startsWith("workflow run")).length;
    delete c2.state.deploy.stages["deploy-new"]; again.w.fail["smoke-new"] = 1;
    await deployStep(c2);
    assert.equal(again.w.gh.filter((g) => g.startsWith("workflow run")).length, n, "same key, same attempt: observed, not redispatched");
  });
});

describe("deploy engine: release CLI wiring and docs (#5712)", () => {
  const DISK = [{ mount: "/", type: "ext4" }]; // CI /tmp can be tmpfs, which assertDiskPath refuses
  const YAML = `deploy:\n  engine:\n    enabled: true\n    live_release_command: "live"\n    colour:\n      active_command: "active"\n    rollback:\n      shift_back_command: "shift-back"\n    stages:\n${ENGINE().stages.map((s) => `      - {id: ${s.id}, kind: ${s.kind}, run: "${s.run}", inputs: ["${s.inputs[0]}"]}`).join("\n")}\n`;
  const setup = (yaml = YAML) => {
    const cwd = tmpDir("deploy-stages-"), root = join(cwd, "releases"); mkdirSync(root);
    if (yaml != null) writeFileSync(join(cwd, "forge.yaml"), yaml);
    const { w, io } = world(); const out = []; io.print = (l) => out.push(String(l));
    Object.assign(io, { runningLanes: async () => [], batches: async () => [], setParallel: async () => {} });
    const state = { v: 1, id: ID, repo: "o/r", startedAt: "2026-01-01T00:00:00Z", held: [], steps: Object.fromEntries(RELEASE_STEPS.filter((s) => s !== "deploy").map((s) => [s, { done: true, result: s === "post-merge" ? { merge: SHA } : {} }])) };
    openRelease(root, ID, DISK).save(state);
    return { w, io, out, cwd, root, deps: { io, cwd, env: { FORGEDOCK_RELEASE_DIR: root }, mounts: DISK } };
  };
  it("release deploy --resume continues a merged release from the failed stage; --sha deploys the fix under the same release", async () => {
    const { w, out, root, deps } = setup(); w.fail["smoke-new"] = 1;
    assert.equal(await releaseFromCli(["deploy", "--resume", ID, "--repo", "o/r"], deps), 3);
    assert.match(out.join("\n"), /blocked at deploy: stage smoke-new \(smoke\) failed: smoke-new boom; no traffic moved/);
    assert.deepEqual(cmds(w), ORDER.slice(0, 4));
    assert.equal(await releaseFromCli(["deploy", "--plan", ID, "--repo", "o/r"], deps), 0);
    assert.match(out.at(-1), /skip {2}deploy-new \(deploy\): done at aaaaaaaa, inputs unchanged\n {2}run {3}smoke-new \(smoke\): failed last time/);
    w.trees[SHA2] = { ...TREE, "tests/smoke/home.sh": "o4-fixed" };
    const mark = w.ran.length;
    assert.equal(await releaseFromCli(["deploy", "--resume", ID, "--sha", SHA2, "--repo", "o/r"], deps), 0);
    assert.deepEqual(cmds(w, mark), ORDER.slice(3));
    const st = openRelease(root, ID).load();
    assert.equal(st.steps.deploy.done, true); assert.equal(st.deploy.phase, "LIVE"); assert.equal(st.deploy.merge, SHA2); assert.equal(st.deploy.stages.build.sha, SHA);
  });
  it("without the engine block the verb refuses and the release job never sees an engine", async () => {
    const { w, out, deps } = setup("release:\n  auto_merge: false\n");
    assert.equal(await releaseFromCli(["deploy", "--plan", ID, "--repo", "o/r"], deps), 1);
    assert.match(out.at(-1), /deploy.engine.enabled is not on/);
    w.git.length = 0;
    assert.equal(await releaseFromCli(["--resume", ID, "--repo", "o/r"], deps), 0); // the deploy step is skipped as before
    assert.deepEqual(cmds(w), []); assert.equal(w.git.length, 0);
  });
  it("the docs/CONFIG.md example is a valid engine block and passes the forge.yaml schema check", () => {
    const doc = readFileSync(new URL("../../docs/CONFIG.md", import.meta.url), "utf8");
    const sec = doc.slice(doc.indexOf("## `deploy` (OPTIONAL)")), yaml = /```yaml\n([\s\S]*?)```/.exec(sec)[1];
    const e = readEngine({ raw: yaml });
    assert.deepEqual(validateEngine(e), []); assert.equal(e.stages.length, 8);
    assert.deepEqual(validateForgeYaml(yaml).filter((f) => f.key.startsWith("deploy")), []);
    for (const k of ["id", "kind", "inputs", "needs", "services", "check", "outputs_command", "timeout_s"]) assert.ok(sec.includes(`| \`${k}\` |`), k);
  });
});
