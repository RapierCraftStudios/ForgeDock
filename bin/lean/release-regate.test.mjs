// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyGateOnly, hunkSteps, gateScriptSha } from "./release-regate.mjs";
import { runControl, VERBS } from "./release-control.mjs";
import { gateRecord, parseGatesConfig } from "./release-gates.mjs";

const POLICY = { gates: { workflow_steps: ["Smoke"] }, verify: { workflow: "verify-release.yml" }, deploy: { freeze_variable: "DEPLOY_FREEZE" } };
const WF = ".github/workflows/deploy.yml";
const WF_TEXT = ["name: d", "jobs:", "  j:", "    steps:", "      - name: Build", "        run: make", "      - name: Smoke", "        run: ./s.sh", ""].join("\n");

describe("classifyGateOnly (#5584)", () => {
  it("a gate-path-only diff is gate-only", () => {
    const r = classifyGateOnly(["scripts/deploy/a.sh", "scripts/lib/b.sh", "scripts/prod-smoke-test.sh", "tests/gates/x.json"], POLICY);
    assert.equal(r.gateOnly, true);
  });
  it("an app path, a migration path and an image path each flip it", () => {
    for (const [p, kind] of [["src/app.ts", "app"], ["db/migrations/001.sql", "migration"], ["scripts/deploy/migrations/2.sql", "migration"], ["docker/Dockerfile.api", "image"], ["Dockerfile", "image"]]) {
      const r = classifyGateOnly(["scripts/deploy/a.sh", p], POLICY);
      assert.equal(r.gateOnly, false, p);
      assert.deepEqual(r.offenders, [{ path: p, kind }]);
    }
  });
  it("a workflow file qualifies only when every hunk lies in a listed step", () => {
    assert.equal(classifyGateOnly([WF], POLICY, { workflowSteps: { [WF]: ["Smoke"] } }).gateOnly, true);
    assert.equal(classifyGateOnly([WF], POLICY, { workflowSteps: { [WF]: ["Smoke", "Build"] } }).gateOnly, false);
    assert.equal(classifyGateOnly([WF], POLICY, { workflowSteps: { [WF]: [null] } }).gateOnly, false);
    assert.equal(classifyGateOnly([WF], POLICY).gateOnly, false);
  });
  it("custom gates.paths replace the default allowlist; no changes is not gate-only", () => {
    assert.equal(classifyGateOnly(["ops/x.sh"], { gates: { paths: ["ops/**"] } }).gateOnly, true);
    assert.equal(classifyGateOnly(["scripts/deploy/a.sh"], { gates: { paths: ["ops/**"] } }).gateOnly, false);
    assert.equal(classifyGateOnly([], POLICY).gateOnly, false);
    assert.ok(parseGatesConfig({}).paths.includes("scripts/deploy/**"));
  });
  it("hunkSteps maps changed lines to step names", () => {
    const io = { git: (a) => (a[0] === "diff" ? "@@ -8 +8 @@\n-x\n+y\n@@ -6,0 +6,1 @@\n+z\n@@ -5 +5 @@\n+q\n" : WF_TEXT) };
    assert.deepEqual(hunkSteps(io, "a", "b", WF), ["Smoke", "Build", "Build"]);
  });
  it("a gate record keeps a valid gate_sha", () => {
    assert.equal(gateRecord({ gate: "g", outcome: "pass", gate_sha: "abcdef1" }).gate_sha, "abcdef1");
    assert.equal(gateRecord({ gate: "g", outcome: "pass", gate_sha: "zz" }).gate_sha, undefined);
  });
});

// A tiny in-memory GitHub for the control path, as in release-control.test.mjs.
function world({ changed = ["scripts/prod-smoke-test.sh"], deploy = { target: { sha: "t0" }, merge: "m1" }, freezeVar = "", migrations = "" } = {}) {
  const w = { active: { epoch: 1, lease: { holder: "A", epoch: 1, release: "r20260101-000000-1", issue: 9 } }, controls: "", comments: [], gh: [], files: {}, sha: 0, saved: 0 };
  w.state = { id: "r20260101-000000-1", deploy, steps: { "release-pr": { result: { pr: 9 } } } };
  w.rel = { load: () => w.state, save: () => { w.saved++; } };
  w.io = {
    now: () => 1_700_000_000_000, holder: "h", print: () => {},
    git: (a) => {
      if (a[0] === "rev-parse") return a[a.length - 1].includes(":") ? "b10b" : "f1f1f1f1";
      if (a[0] === "diff" && a.includes("--name-only")) return a.includes("--") ? migrations : changed.join("\n");
      throw new Error(`git ${a.join(" ")}`);
    },
    gh: async (a) => { w.gh.push(a); if (a[0] === "variable") { if (!freezeVar) throw new Error("not set"); return freezeVar; } return ""; },
    api: async (method, path, body) => {
      if (method === "GET" && /git\/ref\/heads\/_active$/.test(path)) return { object: { sha: "h0" } };
      if (method === "GET" && /contents\/active\.json/.test(path)) return { content: Buffer.from(JSON.stringify(w.active)).toString("base64") };
      if (method === "GET" && /contents\/controls\.jsonl/.test(path)) return { content: Buffer.from(w.controls).toString("base64") };
      if (method === "GET" && /git\/commits\//.test(path)) return { tree: { sha: "t0" } };
      if (method === "POST" && /git\/trees/.test(path)) { for (const t of body.tree) w.files[t.path] = t.content; return { sha: "t1" }; }
      if (method === "POST" && /git\/commits/.test(path)) return { sha: `c${++w.sha}` };
      if (method === "PATCH" && /git\/refs/.test(path)) { w.active = JSON.parse(w.files["active.json"]); w.controls = w.files["controls.jsonl"] ?? w.controls; return {}; }
      if (method === "POST" && /issues\/\d+\/comments/.test(path)) { w.comments.push(body.body); return { id: w.comments.length }; }
      throw new Error(`unrouted ${method} ${path}`);
    },
  };
  return w;
}
const RID = "r20260101-000000-1";
const run = (w, argv, extra = {}) => runControl("regate", [RID, "--reason", "fix smoke", ...argv], { io: w.io, repo: "o/r", actor: "op", host: "h1", now: 1_700_000_000_000, policy: POLICY, rel: w.rel, ...extra });
const auditLine = (w) => w.controls.trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.verb === "regate").pop();
const dispatches = (w) => w.gh.filter((a) => a[0] === "workflow");

describe("regate verb (#5584)", () => {
  it("is a control verb", () => assert.ok(VERBS.includes("regate")));
  it("replay of 11-12: one fenced dispatch at the fix ref for the same sha, no merge", async () => {
    const w = world();
    const r = await run(w, ["--ref", "fix/smoke"]);
    assert.equal(r.ok, true, r.error);
    const d = dispatches(w);
    assert.equal(d.length, 1);
    assert.deepEqual(d[0].slice(0, 7), ["workflow", "run", "verify-release.yml", "--repo", "o/r", "--ref", "fix/smoke"]);
    const inputs = Object.fromEntries(d[0].filter((x) => x.includes("=")).map((x) => x.split("=")));
    assert.equal(inputs.sha, "m1");
    assert.equal(inputs.regate, "true");
    assert.match(inputs.forge_epoch, /^\d+$/);
    assert.equal(inputs.override_freeze, undefined);
    assert.equal(w.gh.filter((a) => a[0] === "pr").length, 0, "no merge");
    assert.equal(w.state.regates.length, 1);
    assert.equal(w.state.regates[0].gate_sha, inputs.gate_sha);
  });
  it("the audit entry carries the gate-script sha and the actor", async () => {
    const w = world();
    const r = await run(w, ["--ref", "fix/smoke"]);
    const line = auditLine(w);
    assert.equal(line.verb, "regate");
    assert.equal(line.actor, "op");
    assert.match(line.after.gate_sha, /^[0-9a-f]{40}$/);
    assert.equal(line.after.gate_sha, r.entry.after.gate_sha);
    assert.equal(line.after.gate_sha, gateScriptSha(w.io, "f1f1f1f1", ["scripts/prod-smoke-test.sh"]));
  });
  it("gate_fix_ref rides the dispatch for a hotfix and is recorded", async () => {
    const w = world();
    const r = await run(w, ["--ref", "fix/smoke", "--gate-fix-ref", "hotfix/9"]);
    assert.equal(r.ok, true, r.error);
    assert.ok(dispatches(w)[0].includes("gate_fix_ref=hotfix/9"));
    assert.equal(w.state.regates[0].gate_fix_ref, "hotfix/9");
    assert.equal(auditLine(w).after.gate_fix_ref, "hotfix/9");
  });
  it("refuses with no recorded live record/rollback target", async () => {
    const w = world({ deploy: null });
    const r = await run(w, ["--ref", "fix/smoke"]);
    assert.equal(r.ok, false);
    assert.match(r.error, /no recorded live record/);
    assert.equal(dispatches(w).length, 0);
    assert.equal(w.controls, "");
  });
  it("refuses a run-set freeze with migration evidence, never sending override_freeze", async () => {
    const w = world({ freezeVar: "1", migrations: "db/migrations/9.sql" });
    const r = await run(w, ["--ref", "fix/smoke"]);
    assert.equal(r.ok, false);
    assert.match(r.error, /migration evidence/);
    assert.equal(dispatches(w).length, 0);
    const pre = world({ freezeVar: "1", migrations: "db/migrations/9.sql", deploy: { target: { sha: "t0" }, merge: "m1", freezeBefore: "1" } });
    assert.equal((await run(pre, ["--ref", "fix/smoke"])).ok, true, "a freeze set before the deploy is not the run's");
  });
  it("refuses a non-gate-only fix and a repeated ref", async () => {
    const w = world({ changed: ["scripts/prod-smoke-test.sh", "src/app.ts"] });
    assert.match((await run(w, ["--ref", "f"])).error, /not a gate-only fix/);
    const w2 = world();
    assert.equal((await run(w2, ["--ref", "f"])).ok, true);
    assert.match((await run(w2, ["--ref", "f"])).error, /already re-evaluated/);
    assert.match((await run(world(), [])).error, /--ref/);
    assert.match((await runControl("regate", [RID, "--ref", "f"], { io: w.io, repo: "o/r", rel: w.rel })).error, /--reason/);
  });
  it("a hold refuses the dispatch (fenced) after the audit line", async () => {
    const w = world();
    w.active.holds = { [RID]: { reason: "incident" } };
    const r = await run(w, ["--ref", "fix/smoke"]);
    assert.equal(r.ok, false);
    assert.match(r.error, /held/);
    assert.equal(dispatches(w).length, 0);
  });
});
