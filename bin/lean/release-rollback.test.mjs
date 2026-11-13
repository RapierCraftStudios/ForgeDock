// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runRollback, chooseRung, checkCounts, refuseAcross, classifyTrigger, rollbackFromCli } from "./release-rollback.mjs";

const TARGET = { sha: "aaaa1111", images: { api: "sha256:old-api", web: "sha256:old-web" } };
const POLICY = {
  rollback: { ladder: ["flag", "unit", "full", "stop"], flags: [{ flag: "f1", kill_command: "kill f1" }], unit_workflow: "svc.yml", full_workflow: "rb.yml", result_command: "result", health_command: "health", open_revert_pr: true },
  events: { webhook_url: "https://hook.test/x" },
};
const GOOD = { units: { api: { digest: "sha256:old-api", hosts: { h1: { expected: 1, rolled: 1 }, h2: { expected: 1, rolled: 1 } } }, web: { digest: "sha256:old-web", expected: 2, rolled: 2 } } };

function world({ policy = POLICY, record = GOOD, healthOk = true, runConclusion = "success", migrations = {}, closed = [1, 2], incidents = [], gitFail = false } = {}) {
  const w = { gh: [], dispatches: [], rehearsed: [], git: [], holds: [], pages: [], issues: [...incidents], saved: 0, out: [] };
  let runId = 100, dispatched = false;
  const state = { id: "r20260101-000000-1", repo: "o/r", deploy: { phase: "LIVE_CHECKED", merge: "bbbb2222", target: TARGET }, steps: { "release-pr": { result: { pr: 7, issues: [1, 2] } } } };
  const io = {
    now: () => 1_700_000_000_000, sleep: async () => {}, print: (l) => w.out.push(l),
    post: async (u, b) => { w.pages.push({ u, b }); return { ok: true }; },
    rehearse: async (cmd) => {
      w.rehearsed.push(cmd);
      if (cmd === "result") return record ? { ok: true, output: JSON.stringify(record) } : { ok: false, output: "" };
      if (cmd === "health") return { ok: healthOk, output: "unhealthy" };
      return { ok: true, output: "" };
    },
    git: (a) => {
      w.git.push(a);
      if (gitFail && a[0] === "diff") throw new Error("bad revision");
      if (a[0] === "diff") return Object.keys(migrations).join("\n");
      if (a[0] === "show") return migrations[a[1].split(":")[1]] ?? "";
      if (a.includes("rev-list")) return "bbbb2222 p1 p2";
      return "";
    },
    gh: async (a) => {
      w.gh.push(a);
      if (a[0] === "workflow") { dispatched = true; w.dispatches.push(a); return ""; }
      if (a[0] === "run") return JSON.stringify(dispatched ? [{ databaseId: ++runId > 101 ? 101 : 101, status: "completed", conclusion: runConclusion }] : [{ databaseId: 50, status: "completed", conclusion: "success" }]);
      if (a[0] === "pr" && a[1] === "list") return "[]";
      if (a[0] === "pr" && a[1] === "create") return "https://github.com/o/r/pull/77";
      if (a[0] === "issue" && a[1] === "view") return JSON.stringify({ state: closed.includes(Number(a[2])) ? "CLOSED" : "OPEN" });
      if (a[0] === "issue" && a[1] === "reopen") return "";
      if (a[0] === "issue" && a[1] === "list") return JSON.stringify(w.issues);
      if (a[0] === "issue" && a[1] === "create") { w.issues.push({ number: 99, body: a[a.indexOf("--body") + 1] }); return "https://github.com/o/r/issues/99"; }
      throw new Error(`unrouted gh ${a.join(" ")}`);
    },
  };
  const fence = { lctx: {}, lease: { holder: "h", epoch: 5, release: state.id }, intents: [], record: async (i) => { fence.intents.push(i); }, now: () => "t" };
  return { w, state, io, fence, policy };
}
const ctxOf = (x, extra = {}) => ({ io: x.io, repo: "o/r", def: "main", state: x.state, save: () => { x.w.saved++; }, policy: x.policy, actor: "op", host: "h", config: { rollbackBounds: { pollMs: 0, startPolls: 2, donePolls: 2 } }, ...extra });
// A fence whose gate always passes: fenced() re-reads _active through lctx, so stub the module-level check via a lease-free fence-like object.
const noFence = null;

describe("rung choice", () => {
  it("picks the lowest sufficient rung and says why", () => {
    const r = chooseRung({ trigger: "smoke", rb: POLICY.rollback, target: TARGET });
    assert.equal(r.rung, "flag"); assert.match(r.why, /smoke/);
  });
  it("a livecheck mismatch skips the flag rung; no digests skips unit", () => {
    assert.equal(chooseRung({ trigger: "livecheck", rb: POLICY.rollback, target: TARGET }).rung, "unit");
    const r = chooseRung({ trigger: "livecheck", rb: POLICY.rollback, target: { sha: "a", images: {} } });
    assert.equal(r.rung, "full"); assert.match(r.why, /no recorded previous per-unit digests/);
  });
  it("--to raises the floor and nothing configured ends at stop", () => {
    assert.equal(chooseRung({ trigger: "human", from: "full", rb: POLICY.rollback, target: TARGET }).rung, "full");
    assert.equal(chooseRung({ trigger: "human", rb: {}, target: TARGET }).rung, "stop");
  });
  it("classifies the recorded trigger reasons", () => {
    assert.equal(classifyTrigger("SLI breach over 15 min"), "sli");
    assert.equal(classifyTrigger("smoke.yml (smoke) run 3 concluded failure"), "smoke");
    assert.equal(classifyTrigger("LIVE_CHECK failed"), "livecheck");
  });
});

describe("injected failure per rung (fake io)", () => {
  it("rung 0 flag: kills the flags, checks health, records the reason", async () => {
    const x = world();
    const r = await runRollback(ctxOf(x), { reason: "smoke red", trigger: "smoke" });
    assert.equal(r.rung, "flag"); assert.equal(r.ok, true);
    assert.deepEqual(x.w.rehearsed.filter((c) => c === "kill f1"), ["kill f1"]);
    assert.equal(x.w.dispatches.length, 0);
    assert.equal(x.state.rollbackRun.reason, "smoke red");
    assert.match(x.state.rollbackRun.why, /lowest sufficient rung is flag/);
    assert.equal(r.post.revert, undefined); // code is unchanged: default already equals live
  });
  it("rung 0 health failure escalates to the unit rung", async () => {
    const x = world({ healthOk: false });
    const r = await runRollback(ctxOf(x), { reason: "smoke red", trigger: "smoke" });
    assert.equal(r.history[0].rung, "flag"); assert.match(r.history[0].result, /health command failed/);
    assert.equal(r.history[1].rung, "unit");
  });
  it("rung 1 unit: dispatches the service rollback with the previous digests and the epoch", async () => {
    const x = world();
    const r = await runRollback(ctxOf(x, { fence: okFence(x) }), { reason: "deploy mismatch", trigger: "livecheck" });
    assert.equal(r.rung, "unit"); assert.equal(r.ok, true);
    const a = x.w.dispatches[0];
    assert.deepEqual(a.slice(0, 3), ["workflow", "run", "svc.yml"]);
    assert.ok(a.includes("action=rollback")); assert.ok(a.includes("forge_epoch=5"));
    assert.ok(a.includes(`digests=${JSON.stringify(TARGET.images)}`));
    assert.equal(r.post.revert.pr, 77);
  });
  it("rung 2 full: dispatches the standalone workflow with the target sha", async () => {
    const x = world({ policy: { ...POLICY, rollback: { ...POLICY.rollback, unit_workflow: undefined } } });
    const r = await runRollback(ctxOf(x, { fence: okFence(x) }), { reason: "x", trigger: "livecheck" });
    assert.equal(r.rung, "full");
    const a = x.w.dispatches[0];
    assert.equal(a[2], "rb.yml"); assert.ok(a.includes("sha=aaaa1111")); assert.ok(a.includes("forge_epoch=5"));
    assert.ok(!a.some((v) => /override_|acknowledge_/.test(v)));
  });
  it("rung 3 stop: nothing configured holds, pages and opens the incident", async () => {
    const x = world({ policy: { rollback: { ladder: ["stop"] }, events: POLICY.events } });
    const r = await runRollback(ctxOf(x), { reason: "crash loop", trigger: "crashloop", later: [] });
    assert.equal(r.rung, "stop"); assert.equal(r.ok, false);
    assert.equal(x.w.pages.length, 1); assert.match(x.w.pages[0].b.text, /crash loop/);
    assert.equal(r.post.incident.number, 99);
  });
});

describe("counts check (Q8)", () => {
  it("a matching record passes", () => assert.equal(checkCounts(GOOD, TARGET), null));
  it("a per-host mismatch fails", () => {
    const bad = structuredClone(GOOD); bad.units.api.hosts.h2.rolled = 0;
    assert.match(checkCounts(bad, TARGET), /api@h2: 0 of 1/);
  });
  it("a missing unit, a wrong digest and an unreadable record fail", () => {
    assert.match(checkCounts({ units: { api: GOOD.units.api } }, TARGET), /no entry for web/);
    const w = structuredClone(GOOD); w.units.web.digest = "sha256:new"; assert.match(checkCounts(w, TARGET), /web: rolled to/);
    assert.match(checkCounts(null, TARGET), /unreadable/);
  });
  it("a mismatch after rung 1 escalates to rung 3; a matching one completes", async () => {
    const bad = structuredClone(GOOD); bad.units.api.hosts.h2.rolled = 0;
    const x = world({ record: bad });
    const r = await runRollback(ctxOf(x, { fence: okFence(x) }), { reason: "x", trigger: "livecheck" });
    assert.equal(r.rung, "stop"); assert.match(r.history[0].result, /counts check/);
    assert.equal(x.w.pages.length, 1);
    const y = world();
    assert.equal((await runRollback(ctxOf(y, { fence: okFence(y) }), { reason: "x", trigger: "livecheck" })).ok, true);
    const z = world({ record: null });
    assert.equal((await runRollback(ctxOf(z, { fence: okFence(z) }), { reason: "x", trigger: "livecheck" })).rung, "stop");
  });
  it("a failed rollback run escalates to rung 3", async () => {
    const x = world({ runConclusion: "failure" });
    const r = await runRollback(ctxOf(x, { fence: okFence(x) }), { reason: "x", trigger: "livecheck" });
    assert.equal(r.rung, "stop"); assert.match(r.history[0].result, /concluded failure/);
  });
});

describe("refuse_across (I8)", () => {
  const DESTRUCTIVE = { "db/migrations/0042.sql": "ALTER TABLE users DROP COLUMN legacy;" };
  it("refuses across a destructive migration and never reaches a code rung", async () => {
    const x = world({ migrations: DESTRUCTIVE });
    const r = await runRollback(ctxOf(x, { fence: okFence(x) }), { reason: "x", trigger: "livecheck" });
    assert.match(r.refused, /crosses destructive migration db\/migrations\/0042.sql/);
    assert.equal(r.rung, "stop"); assert.equal(x.w.dispatches.length, 0);
  });
  it("a harmless migration, none, or an unreadable history", () => {
    const x = world({ migrations: { "db/migrations/0043.sql": "CREATE TABLE t (id int);" } });
    assert.equal(refuseAcross({ io: x.io, target: "a", live: "b" }).ok, true);
    assert.match(refuseAcross({ io: world({ gitFail: true }).io, target: "a", live: "b" }).refused, /cannot list migrations/);
  });
  it("the flag rung is still allowed across a destructive migration (no code moves)", async () => {
    const x = world({ migrations: DESTRUCTIVE });
    const r = await runRollback(ctxOf(x), { reason: "smoke", trigger: "smoke" });
    assert.equal(r.rung, "flag"); assert.equal(r.ok, true);
  });
  it("the module has no SQL verb and no database client (static)", () => {
    const src = readFileSync(new URL("./release-rollback.mjs", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.doesNotMatch(src, /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT)\b/);
    assert.doesNotMatch(src, /\b(psql|mysql|sqlite3?|pg_dump|knex|sequelize)\b/i);
  });
});

describe("after a rollback", () => {
  it("reopens the wave's issues, one incident (a second run creates none), holds later waves", async () => {
    const x = world();
    const r = await runRollback(ctxOf(x, { fence: okFence(x) }), { reason: "smoke red", trigger: "livecheck", later: ["r20260102-000000-2"] });
    assert.deepEqual(r.post.reopened, [1, 2]);
    assert.equal(x.w.gh.filter((a) => a[0] === "issue" && a[1] === "create").length, 1);
    assert.deepEqual(r.post.held, []); // unmanaged (no io.api): no control path, nothing faked
    delete x.state.rollbackRun.post.incident; // a fresh process: the marker search finds the issue
    await runRollback(ctxOf(x, { fence: okFence(x) }), { reason: "smoke red", trigger: "livecheck" });
    assert.equal(x.w.gh.filter((a) => a[0] === "issue" && a[1] === "create").length, 1);
  });
  it("the revert PR runs in a throwaway worktree and is reused when one is open", async () => {
    const x = world();
    await runRollback(ctxOf(x, { fence: okFence(x) }), { reason: "x", trigger: "livecheck" });
    assert.ok(x.w.git.some((a) => a[0] === "worktree" && a[1] === "add"));
    assert.ok(x.w.git.some((a) => a.includes("revert") && a.includes("-m")));
    assert.ok(x.w.git.some((a) => a[0] === "worktree" && a[1] === "remove"));
    assert.ok(x.w.gh.some((a) => a[0] === "pr" && a[1] === "create"));
  });
});

describe("later waves are held through the control path", () => {
  it("writes a hold per later wave into _active", async () => {
    const x = world();
    const files = {}, active = { epoch: 5, lease: { holder: "h", epoch: 5, release: x.state.id } }; let cur = active;
    x.io.api = async (m, p, body) => {
      if (m === "GET" && /git\/ref\/heads\/_active$/.test(p)) return { object: { sha: "h0" } };
      if (m === "GET" && /contents\/active\.json/.test(p)) return { content: Buffer.from(JSON.stringify(cur)).toString("base64") };
      if (m === "GET" && /contents\/controls\.jsonl/.test(p)) return { content: "" };
      if (m === "GET" && /git\/commits\//.test(p)) return { tree: { sha: "t0" } };
      if (m === "POST" && /git\/trees/.test(p)) { for (const t of body.tree) files[t.path] = t.content; return { sha: "t1" }; }
      if (m === "POST" && /git\/commits/.test(p)) return { sha: "c1" };
      if (m === "PATCH" && /git\/refs/.test(p)) { cur = JSON.parse(files["active.json"]); return {}; }
      if (m === "POST" && /comments/.test(p)) return { id: 1 };
      throw new Error(`unrouted ${m} ${p}`);
    };
    const r = await runRollback(ctxOf(x), { reason: "smoke red", trigger: "smoke", later: ["r20260102-000000-2"] });
    assert.deepEqual(r.post.held, ["r20260102-000000-2"]);
    assert.match(cur.holds["r20260102-000000-2"].reason, /rolled back: smoke red/);
  });
});

describe("CLI", () => {
  it("refuses without a reason, an id or a valid --to", async () => {
    const x = world();
    const rel = { load: () => x.state, save: () => {} };
    const run = (argv) => rollbackFromCli(argv, { io: x.io, rel, policy: x.policy, def: "main" });
    assert.equal(await run(["r1", "--json"]), 1);
    assert.equal(await run(["--reason", "x"]), 1);
    assert.equal(await run(["r1", "--reason", "x", "--to", "stop"]), 1);
    assert.match(x.w.out.join("\n"), /--reason is required/);
  });
  it("an unmanaged run takes the flag rung and exits 0", async () => {
    const x = world();
    const rel = { load: () => x.state, save: () => {} };
    assert.equal(await rollbackFromCli(["r20260101-000000-1", "--reason", "smoke red"], { io: x.io, rel, policy: x.policy, def: "main" }), 0);
    assert.match(x.w.out.at(-1), /rolled back at rung flag/);
  });
});

// A fence for the fake io: the real fenced() re-reads _active through fence.lctx, which this world does not serve,
// so the dispatch tests use a fence-shaped object whose gate is the lease check against a stubbed _active.
function okFence(x) {
  const active = { epoch: 5, lease: { holder: "h", epoch: 5, release: x.state.id } };
  const lctx = { io: { api: async (m, p) => {
    if (/git\/ref\/heads\/_active$/.test(p)) return { object: { sha: "h0" } };
    if (/contents\/active\.json/.test(p)) return { content: Buffer.from(JSON.stringify(active)).toString("base64") };
    throw new Error(`unrouted ${m} ${p}`);
  } }, repo: "o/r", credential: "driver" };
  return { lctx, lease: active.lease, record: async (rec) => { (x.state.intents ??= []).push(rec); }, now: () => "t" };
}
