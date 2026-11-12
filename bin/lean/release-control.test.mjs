// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runControl, controlFromCli, buildDispatchArgs, holdCheck, CONTROL_SCHEMA } from "./release-control.mjs";
import { fenced } from "./release-fence.mjs";

// A tiny in-memory GitHub: _active branch (active.json + controls.jsonl) and one release ledger.
function world({ active = { epoch: 1, lease: { holder: "A", epoch: 1, release: "r20260101-000000-1", issue: 9 } }, state = null } = {}) {
  const w = { active, controls: "", comments: [], vars: [], gh: [], files: {}, sha: 0 };
  w.io = {
    now: () => 1_700_000_000_000, print: (l) => (w.out ??= []).push(l),
    gh: async (a) => { w.gh.push(a); if (a[0] === "repo") return JSON.stringify({ nameWithOwner: "o/r" }); if (a[0] === "variable") w.vars.push(a); return ""; },
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
const base = (w, extra = {}) => ({ io: w.io, repo: "o/r", actor: "op", host: "h1", now: 1_700_000_000_000, ...extra });

describe("release control (#5556)", () => {
  it("every mutation needs --reason (I15)", async () => {
    const w = world();
    for (const [v, a] of [["hold", [RID]], ["resume", [RID]], ["cancel", [RID]], ["lane", ["#1", "--force", "p0"]], ["exempt", ["lint", "--mode", "skip", "--issue", "3", "--until", "2h"]], ["freeze", []], ["unfreeze", []]]) {
      const r = await runControl(v, a, base(w, { policy: { deploy: { freeze_variable: "DEPLOY_FREEZE" } } }));
      assert.equal(r.ok, false, v); assert.match(r.error, /--reason is required/);
    }
    assert.equal(w.comments.length, 0);
  });

  it("exempt of an unskippable class (migration) is rejected; so is a policy-added one", async () => {
    const w = world();
    const a = ["--mode", "skip", "--issue", "3", "--until", "2h", "--reason", "x"];
    assert.match((await runControl("exempt", ["migration", ...a], base(w))).error, /unskippable/);
    for (const c of ["security", "rollback", "backup-restore", "secrets"]) assert.equal((await runControl("exempt", [c, ...a], base(w))).ok, false);
    assert.equal((await runControl("exempt", ["custom", ...a], base(w, { policy: { ci: { unskippable: ["custom"] } } }))).ok, false);
    assert.equal(w.controls, "");
  });

  it("exempt: mode ttl caps, required issue, trusted actor", async () => {
    const w = world();
    const ok = ["lint", "--mode", "skip", "--issue", "3", "--until", "24h", "--reason", "flaky"];
    assert.match((await runControl("exempt", ["lint", "--mode", "skip", "--issue", "3", "--until", "25h", "--reason", "r"], base(w))).error, /at most 24h/);
    assert.match((await runControl("exempt", ["lint", "--mode", "quarantine", "--issue", "3", "--until", "15d", "--reason", "r"], base(w))).error, /at most 336h/);
    assert.match((await runControl("exempt", ["lint", "--mode", "skip", "--until", "1h", "--reason", "r"], base(w))).error, /--issue/);
    assert.match((await runControl("exempt", ok, base(w, { policy: { trust: { actors: ["boss"] } } }))).error, /not trusted/);
    assert.equal((await runControl("exempt", ["lint", "--mode", "quarantine", "--issue", "3", "--until", "14d", "--reason", "r"], base(w))).ok, true);
    assert.equal((await runControl("exempt", ok, base(w, { policy: { trust: { actors: ["op"] } } }))).ok, true);
  });

  it("a mutation appends the audit line and posts a FORGE:CONTROL comment", async () => {
    const w = world();
    const r = await runControl("hold", [RID, "--reason", "pause for incident"], base(w));
    assert.equal(r.schema, CONTROL_SCHEMA); assert.equal(r.ok, true);
    const line = JSON.parse(w.controls.trim().split("\n").pop());
    assert.deepEqual({ ...line, after: undefined }, { at: "2023-11-14T22:13:20.000Z", actor: "op", host: "h1", verb: "hold", reason: "pause for incident", before: null, after: undefined, epoch: 1 });
    assert.equal(line.after.reason, "pause for incident");
    assert.match(w.comments[0], /FORGE:CONTROL/);
    assert.equal(w.active.holds[RID].actor, "op");
  });

  it("hold is obeyed: fenced() refuses every irreversible action; resume lifts it", async () => {
    const w = world();
    const fence = { lctx: { io: w.io, repo: "o/r", credential: "driver" }, lease: w.active.lease, now: () => "t", record: async () => {} };
    let ran = 0;
    assert.equal((await fenced(fence, { action: "merge", key: "k" }, async () => { ran++; })).ok, true);
    await runControl("hold", [RID, "--reason", "r"], base(w));
    assert.match(await holdCheck(fence.lctx, RID), /held/);
    const r = await fenced(fence, { action: "merge", key: "k2" }, async () => { ran++; });
    assert.match(r.refused, /held/); assert.equal(ran, 1);
    await runControl("resume", [RID, "--reason", "done"], base(w));
    assert.equal((await fenced(fence, { action: "merge", key: "k3" }, async () => { ran++; })).ok, true);
    assert.equal(ran, 2);
  });

  it("cancel is refused once MERGED", async () => {
    const w = world();
    const orig = w.io.api;
    w.io.api = async (m, p, b) => (/forge-ledger%2F|contents\/state\.json/.test(p) && m === "GET" && /state\.json/.test(p)
      ? { content: Buffer.from(JSON.stringify({ v: 1, id: RID, steps: { promotion: { done: true, result: { merged: true } } } })).toString("base64") } : orig(m, p, b));
    const r = await runControl("cancel", [RID, "--reason", "r"], base(w));
    assert.equal(r.ok, false); assert.match(r.error, /MERGED|no ledger/);
  });

  it("lane force and freeze/unfreeze (the repo's own variable)", async () => {
    const w = world();
    assert.equal((await runControl("lane", ["#4", "#5", "--force", "exclude", "--reason", "r"], base(w))).ok, true);
    assert.equal(w.active.lanes["4"].force, "exclude");
    assert.match((await runControl("lane", ["#4", "--force", "bogus", "--reason", "r"], base(w))).error, /--force/);
    assert.match((await runControl("freeze", ["--reason", "r"], base(w))).error, /freeze_variable/);
    const policy = { deploy: { freeze_variable: "DEPLOY_FREEZE" } };
    assert.equal((await runControl("freeze", ["--reason", "r"], base(w, { policy }))).ok, true);
    assert.deepEqual(w.vars[0], ["variable", "set", "DEPLOY_FREEZE", "--repo", "o/r", "--body", "1"]);
    assert.equal((await runControl("unfreeze", ["--reason", "r"], base(w, { policy }))).ok, true);
    assert.equal(w.vars[1][1], "delete");
  });

  it("I26: a dispatch with override_freeze or acknowledge_hotfix_revert is rejected", () => {
    assert.throws(() => buildDispatchArgs({ workflow: "p.yml", repo: "o/r", ref: "main", inputs: { override_freeze: "true" } }), /break-glass/);
    assert.throws(() => buildDispatchArgs({ workflow: "p.yml", repo: "o/r", ref: "main", inputs: { acknowledge_hotfix_revert: "1" } }), /break-glass/);
    assert.deepEqual(buildDispatchArgs({ workflow: "p.yml", repo: "o/r", ref: "main", inputs: { forge_epoch: 2 } }), ["workflow", "run", "p.yml", "--repo", "o/r", "--ref", "main", "-f", "forge_epoch=2"]);
  });

  it("CLI: --json prints the stable schema; --repo is accepted; exit 1 on a refusal", async () => {
    const w = world();
    assert.equal(await controlFromCli("hold", [RID, "--repo", "o/r", "--reason", "r", "--json"], { io: w.io, actor: "op", host: "h" }), 0);
    assert.equal(JSON.parse(w.out[0]).schema, CONTROL_SCHEMA);
    assert.equal(await controlFromCli("hold", [RID, "--json"], { io: w.io }), 1);
  });
});
