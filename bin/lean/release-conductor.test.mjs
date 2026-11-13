// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITIES, REFUSED, capability, conductorConfig, conductorGuard, renderConductor, installConductor, recover, recoverFromCli, CONDUCTOR_WORKFLOW_PATH } from "./release-conductor.mjs";
import { fenced } from "./release-fence.mjs";
import { renderReleaseStatus } from "./release-status.mjs";
import { initFromCli } from "./release-config.mjs";

const ID = "r20260101-000000-1", NOW = 1_700_000_000_000;
const b64 = (o) => ({ content: Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64") });
const POLICY = { trust: { actors: ["github-actions[bot]"] }, deploy: { pipelines: { full: { workflow: "deploy.yml" } } }, rollback: { full_workflow: "rb.yml" } };

/** Fake GitHub: `_active`, the lease heartbeat comment and the release ledger; `commits` records every ledger write. */
function world({ active = {}, state, heartbeatAgeS = 3600, policy = POLICY } = {}) {
  const w = { active: { epoch: 4, lease: { holder: "host-1", release: ID, epoch: 4, commentId: 9 }, ...active }, commits: [], gh: [], holds: [] };
  w.state = state ?? { id: ID, repo: "o/r", lane: "release", steps: { "post-merge": { result: { merge: "bbbb2222" } } }, deploy: { phase: "DEPLOYING", merge: "bbbb2222", target: { sha: "aaaa1111" } } };
  const io = {
    now: () => NOW, print: () => {},
    api: async (m, path, body) => {
      if (/contents\/active\.json\?ref=_active$/.test(path)) return b64(w.active);
      if (/controls\.jsonl/.test(path)) return b64("");
      if (/issues\/comments\/9$/.test(path)) return { updated_at: new Date(NOW - heartbeatAgeS * 1000).toISOString() };
      if (/git\/ref\/heads\//.test(path)) return { object: { sha: "h0" } };
      if (/contents\/state\.json/.test(path)) return b64(w.state);
      if (m === "POST" && /git\/trees$/.test(path)) { w.commits.push(JSON.parse(body.tree[0].content)); return { sha: "t1" }; }
      if (/git\/commits\/h/.test(path)) return { tree: { sha: "t0" } };
      if (m === "POST" && /git\/commits$/.test(path)) return { sha: "c1" };
      if (m === "PATCH" && /git\/refs/.test(path)) return {};
      if (m === "POST" && /issues\/\d+\/comments$/.test(path)) return { id: 1 };
      throw new Error(`unrouted ${m} ${path}`);
    },
    gh: async (a) => { w.gh.push(a); if (a[0] === "issue" && a[1] === "list") return "[]"; if (a[0] === "issue" && a[1] === "create") return "https://github.com/o/r/issues/42"; return ""; },
  };
  const fence = { lctx: { io, repo: "o/r", credential: "driver" }, lease: { holder: "conductor-gh", release: ID, epoch: 5 }, record: async () => {}, now: () => "t" };
  const takeFence = async () => ({ fence });
  return { w, io, policy, takeFence, ctx: { io, repo: "o/r", id: ID, policy, def: "main", actor: "github-actions[bot]", host: "gh" } };
}

describe("capability matrix (#5564)", () => {
  it("github-only actions run, host-only actions wait, plan/build/review/merge/patch are refused", () => {
    for (const [a, c] of Object.entries(CAPABILITIES)) {
      const r = capability(a, POLICY);
      assert.ok(c.where === "host" ? r.host : r.run, a);
    }
    for (const a of REFUSED) assert.ok(capability(a, POLICY).refused, a);
    assert.ok(capability("nonsense", POLICY).refused);
  });
  it("full rollback runs only when the rollback workflow is configured", () => {
    assert.ok(capability("rollback_full", POLICY).run);
    assert.match(capability("rollback_full", {}).why, /rollback\.full_workflow/);
  });
});

describe("recover (#5564)", () => {
  it("fresh lease: does nothing", async () => {
    const { ctx, takeFence } = world({ heartbeatAgeS: 10 });
    let took = 0;
    const r = await recover(ctx, { takeFence: async (...a) => { took++; return takeFence(...a); } });
    assert.match(r.noop, /fresh/);
    assert.equal(took, 0);
  });

  it("I17: stale lease at DEPLOYING: takes epoch + 1, replays the deploy and finishes", async () => {
    const { ctx, w, takeFence } = world();
    const seen = [];
    const r = await recover(ctx, { takeFence, deploy: async (c) => { seen.push(c.fence.lease.epoch); c.state.deploy.phase = "LIVE"; return { live: true }; } });
    assert.equal(r.live, true);
    assert.equal(r.epoch, 5);
    assert.deepEqual(seen, [5]);
    assert.equal(w.commits.at(-1).deploy.phase, "LIVE");
  });

  it("deploy blocked, rollback workflow configured: rolls back to the recorded target", async () => {
    const { ctx, takeFence } = world();
    let to = null;
    const r = await recover(ctx, { takeFence, deploy: async () => ({ blocked: true, reason: "LIVE_CHECK failed" }), rollback: async (_c, a) => { to = a.to; return { ok: true, rung: "full" }; } });
    assert.equal(r.ended, "rolled-back");
    assert.equal(to, "full");
  });

  it("rollback workflow unconfigured: holds at last healthy and files needs-agent", async () => {
    const { ctx, w, takeFence } = world({ policy: { ...POLICY, rollback: undefined } });
    const r = await recover(ctx, { takeFence, deploy: async () => ({ blocked: true, reason: "LIVE_CHECK failed" }), rollback: async () => { throw new Error("must not roll back"); } });
    assert.equal(r.ended, "held");
    assert.ok(w.gh.some((a) => a[0] === "issue" && a[1] === "create" && a.includes("needs-agent")));
  });

  it("a hold from the deploy (freeze, deterministic failure) never rolls back blindly", async () => {
    const { ctx, takeFence } = world();
    const r = await recover(ctx, { takeFence, deploy: async () => ({ blocked: true, reason: "freeze set", hold: "x" }), rollback: async () => { throw new Error("must not roll back"); } });
    assert.equal(r.ended, "held");
  });

  it("HELD: with a hold set the conductor performs no action", async () => {
    const { ctx, w } = world({ active: { holds: { [ID]: { reason: "owner" } } } });
    const r = await recover(ctx, { takeFence: async () => { throw new Error("must not take the lease"); }, deploy: async () => { throw new Error("must not act"); } });
    assert.match(r.refused, /held/);
    assert.equal(w.commits.length, 0);
  });

  it("refuses a non-allowlisted actor and an unmerged ledger", async () => {
    const a = world();
    assert.match((await recover({ ...a.ctx, actor: "mallory" }, { takeFence: a.takeFence })).refused, /trust\.actors/);
    const b = world({ state: { id: ID, steps: {} } });
    assert.match((await recover(b.ctx, { takeFence: b.takeFence })).refused, /merged/);
  });

  it("zombie: the old driver's epoch is refused after the takeover", async () => {
    const { w, io } = world();
    w.active = { epoch: 5, lease: { holder: "conductor-gh", epoch: 5 } };
    let ran = 0;
    const r = await fenced({ lctx: { io, repo: "o/r" }, lease: { holder: "host-1", epoch: 4 }, record: async () => {}, now: () => "t" }, { action: "dispatch", key: "k" }, async () => { ran++; });
    assert.match(r.refused, /fenced/);
    assert.equal(ran, 0);
  });

  it("host-only SLI soak is listed as waiting and shown by release status", async () => {
    const { ctx, takeFence } = world({ policy: { ...POLICY, verify: { workflow: "v.yml", slis: [{ name: "p99" }] } } });
    const seen = {};
    const r = await recover(ctx, { takeFence, deploy: async (c) => { seen.slis = c.config.verify.slis; c.state.deploy.phase = "LIVE"; return { live: true }; } });
    assert.deepEqual(r.waiting, ["sli_soak (host-only)"]);
    assert.deepEqual(seen.slis, []);
    const s = { id: ID, repo: "o/r", status: "running", source: "ledger", steps: [], waiting_host: r.waiting, next_actions: [] };
    assert.match(renderReleaseStatus(s), /waiting on a host: sli_soak/);
  });

  it("recoverFromCli maps outcomes to exit codes", async () => {
    const { w, io, policy } = world({ heartbeatAgeS: 5 });
    const out = []; io.print = (l) => out.push(l);
    assert.equal(await recoverFromCli([ID, "--repo", "o/r"], { io, policy, def: "main", actor: "github-actions[bot]" }), 0);
    assert.match(out[0], /nothing to do/);
    w.active.holds = { [ID]: {} };
    w.active.lease.commentId = undefined; w.active.lease.expires = 0;
    assert.equal(await recoverFromCli([ID, "--repo", "o/r"], { io, policy, def: "main", actor: "github-actions[bot]" }), 1);
  });
});

describe("conductor template (#5564)", () => {
  const tpl = readFileSync(new URL("../../templates/github-actions/forge-conductor.yml", import.meta.url), "utf8");
  const scopes = JSON.parse(readFileSync(new URL("../../templates/github-actions/forge-conductor.scopes.json", import.meta.url), "utf8"));
  const rendered = renderConductor({ version: "1.59.1", cron: "0 */6 * * *", workflows: ["Deploy"] });

  it("pins an exact forgedock version", () => {
    assert.match(tpl, /forgedock@__FORGEDOCK_VERSION__/);
    assert.match(rendered, /forgedock@1\.59\.1 release recover/);
    assert.doesNotMatch(rendered, /__[A-Z_]+__|@latest/);
  });
  it("has the four triggers and the configured watchdog cron", () => {
    for (const t of ["workflow_run:", "deployment_status:", "workflow_dispatch:", "schedule:"]) assert.ok(rendered.includes(t), t);
    assert.match(rendered, /types: \[completed\]/);
    assert.match(rendered, /cron: '0 \*\/6 \* \* \*'/);
    assert.match(renderConductor({ version: "1.0.0", cron: "0 3 * * *", workflows: ["A", "B"] }), /workflows: \["A","B"\]/);
  });
  it("the no-op path runs before any checkout step", () => {
    const find = tpl.indexOf("_active"), checkout = tpl.indexOf("actions/checkout");
    assert.ok(find > 0 && checkout > find);
    assert.ok(tpl.indexOf("if: steps.active.outputs.release != ''") < checkout);
  });
  it("token scopes: the workflow permissions equal the scope file; no secrets, no merge, no PR write", () => {
    const block = /permissions:\n((?:  \w[\w-]*: \w+\n)+)/.exec(tpl)[1];
    const perms = Object.fromEntries(block.trim().split("\n").map((l) => l.trim().split(": ")));
    assert.deepEqual(perms, scopes.permissions);
    assert.ok(!("pull-requests" in perms) && !("id-token" in perms));
    assert.doesNotMatch(tpl, /secrets\.(?!GITHUB_TOKEN)|pr merge|gh api[^\n]*merge/);
  });
});

describe("bootstrap guard and init --conductor (#5564)", () => {
  const on = { controls: { conductor: { enabled: true } } };
  it("refuses while the workflow is absent from the default branch", () => {
    const gitHas = (has) => ({ git: (a) => { if (!has) throw new Error("not found"); assert.equal(a[1], `origin/main:${CONDUCTOR_WORKFLOW_PATH}`); return "x"; } });
    assert.match(conductorGuard({ io: gitHas(false), policy: on, def: "main" }), /absent from origin\/main/);
    assert.equal(conductorGuard({ io: gitHas(true), policy: on, def: "main" }), null);
    assert.equal(conductorGuard({ io: gitHas(false), policy: {}, def: "main" }), null);
  });
  it("conductorConfig defaults the watchdog to every 6 h", () => {
    assert.equal(conductorConfig({}).watchdogCron, "0 */6 * * *");
    assert.equal(conductorConfig({ controls: { conductor: { watchdog_cron: "0 1 * * *" } } }).watchdogCron, "0 1 * * *");
  });
  it("init --conductor writes the pinned workflow, never overwrites, and plain init is unchanged", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "conductor-"));
    const out = [], io = { print: (l) => out.push(l) };
    assert.equal(await initFromCli(["--conductor"], { io, cwd }), 0);
    const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    assert.ok(readFileSync(join(cwd, CONDUCTOR_WORKFLOW_PATH), "utf8").includes(`forgedock@${version} release recover`));
    assert.equal(installConductor({ io, cwd, policy: null }), 1);
    assert.equal(initFromCli([], { io, cwd }), 1); // policy file now exists
    assert.ok(existsSync(join(cwd, ".forge/release.yaml")));
  });
});
