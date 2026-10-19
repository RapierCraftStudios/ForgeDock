// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Lane execution targets (#4253): config, sandbox-provider seam, ledger-tracked teardown, gc reaping, max_remote admission.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { parseExecution, placement, scopedEnv, providerLanes, containerProvider, providerByName, openExecutionBudget } from "./execution.mjs";
import { makeLedger, countLiveLanes } from "./ledger.mjs";
import { openBatch } from "./batch.mjs";
import { orchestrate, formatTable, formatSandboxSummary } from "./orchestrate.mjs";
import { planGc, applyGc } from "../gc.mjs";
import { orchestrateFromCli, readExecution } from "../engine-cli.mjs";

const HOST = "testhost";
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };

/** In-memory provider: `results[issue]` is what the sandbox "writes"; `opts.startThrows`, `opts.teardownOk`. */
function fakeProvider(opts = {}) {
  const p = {
    name: "fake", calls: [], live: new Set(), results: {}, ledgerAtStart: null,
    idFor: (n) => `fake-${n}`,
    async start({ issue, env, secrets }) {
      p.calls.push(["start", issue]);
      p.ledgerAtStart = opts.ledger?.entries("sandbox").map((e) => e.value) ?? null;
      if (opts.startThrows) throw new Error("boom: no capacity");
      p.live.add(issue);
      p.env = env; p.secrets = secrets;
      if (opts.finish) { const r = opts.finish(issue); if (r !== undefined) { p.results[issue] = r; p.live.delete(issue); } }
      return { provider: "fake", id: `fake-${issue}`, issue };
    },
    async status(h) { p.calls.push(["status", h.issue]); return p.live.has(h.issue) ? "running" : "exited"; },
    async fetchResult(h) { return p.results[h.issue] ?? null; },
    async teardown(h) { p.calls.push(["teardown", h.id]); p.live.delete(h.issue); return opts.teardownOk ?? true; },
    ...(opts.usage ? { usage: opts.usage } : {}),
  };
  return p;
}

const NO_BUDGET = { batchMinutes: null, batchUsd: null, dayMinutes: null, dayUsd: null, onBudget: "stop", costPerMinute: 0 };
const ledgerIn = (root, { pid = process.pid, host = HOST } = {}) => (n) => makeLedger({ root, batch: "bt", lane: `sandbox-${n}`, owner: "orch_test", issue: n, host, pid });

describe("execution config (#4253)", () => {
  it("absent, empty or invalid config is local; max_remote and secrets are validated", () => {
    assert.deepEqual(parseExecution(undefined), { mode: "local", maxRemote: 0, provider: "local", image: null, secrets: [], budget: NO_BUDGET });
    assert.deepEqual(parseExecution({ mode: "cloud", max_remote: "-1" }), { mode: "local", maxRemote: 0, provider: "local", image: null, secrets: [], budget: NO_BUDGET });
    assert.deepEqual(parseExecution({ mode: "remote", max_remote: "4", image: "node:22-slim", secrets: "GH_TOKEN, bad-name,ANTHROPIC_API_KEY,GH_TOKEN" }),
      { mode: "remote", maxRemote: 4, provider: "container", image: "node:22-slim", secrets: ["GH_TOKEN", "ANTHROPIC_API_KEY"], budget: NO_BUDGET });
    assert.equal(parseExecution({ mode: "remote", provider: "My Provider" }).provider, "container");
  });

  it("placement: remote only for mode remote with max_remote >= 1; hybrid stays local until #4256", () => {
    assert.equal(placement(parseExecution({})), "local");
    assert.equal(placement(parseExecution({ mode: "remote", max_remote: "0" })), "local");
    assert.equal(placement(parseExecution({ mode: "hybrid", max_remote: "3" })), "local");
    assert.equal(placement(parseExecution({ mode: "remote", max_remote: "3" })), "remote");
    assert.equal(placement(undefined), "local");
  });

  it("readExecution reads the forge.yaml block; absent section is undefined", () => {
    const dir = tmpDir("exec-cfg-");
    writeFileSync(join(dir, "forge.yaml"), "project:\n  name: x\n");
    assert.equal(readExecution(dir), undefined);
    writeFileSync(join(dir, "forge.yaml"), "execution:\n  mode: remote\n  max_remote: 5\n  provider: container\n  image: node:22\n  secrets: GH_TOKEN\n");
    assert.deepEqual(readExecution(dir), { mode: "remote", maxRemote: 5, provider: "container", image: "node:22", secrets: ["GH_TOKEN"], budget: NO_BUDGET });
  });

  it("scopedEnv forwards only the batch id, the target repo and allowlisted secret names", () => {
    const env = { GH_TOKEN: "t0k", AWS_SECRET_ACCESS_KEY: "nope", HOME: "/home/x", EMPTY: "" };
    assert.deepEqual(scopedEnv({ env, secrets: ["GH_TOKEN", "EMPTY", "MISSING"], batchId: "bt", repo: "o/r" }), { FORGEDOCK_BATCH_ID: "bt", GH_REPO: "o/r", GH_TOKEN: "t0k" });
  });

  it("an unknown provider is a typed error", () => {
    assert.throws(() => providerByName("k8s", {}), (e) => e.code === "execution.provider.unknown" && /k8s/.test(e.message));
  });
});

describe("providerLanes: sandbox ledger and teardown on every exit path (#4253)", () => {
  const run = async ({ finish, startThrows, teardownOk, pollMs = 1 } = {}) => {
    const root = tmpDir("exec-ledger-");
    const ledgerFor = ledgerIn(root);
    const prov = fakeProvider({ finish, startThrows, teardownOk, ledger: ledgerFor(7) });
    let ticks = 0;
    const lanes = providerLanes({ provider: prov, laneArgs: () => ["--repo", "o/r"], ledgerFor, pollMs, env: { GH_TOKEN: "x" }, secrets: ["GH_TOKEN"], now: () => 1000,
      sleep: async () => { if (++ticks === 2 && !finish) { prov.results[7] = { terminalReason: "merged", pr: 9 }; prov.live.delete(7); } } });
    const started = [];
    const r = await lanes.runOne(7, "staging", { onStart: (i) => started.push(i) });
    return { r, prov, started, led: ledgerFor(7) };
  };

  it("success: registered before start, result reaches the batch, torn down and released", async () => {
    const { r, prov, started, led } = await run();
    assert.deepEqual(prov.ledgerAtStart, ["fake-7"]); // registered BEFORE the sandbox was created
    assert.deepEqual(r, { terminalReason: "merged", pr: 9, sandbox: { provider: "fake", id: "fake-7", minutes: 0, cost_usd: 0 } });
    assert.deepEqual(started, [{ handle: { provider: "fake", id: "fake-7", issue: 7, startedAt: 1000 }, remote: true }]);
    assert.ok(prov.calls.some((c) => c[0] === "teardown" && c[1] === "fake-7"));
    assert.equal(led.read(), null); // released and the empty ledger removed
  });

  it("failure result: torn down and released", async () => {
    const { r, prov, led } = await run({ finish: () => ({ terminalReason: "needs-human", detail: "ci.red" }) });
    assert.equal(r.terminalReason, "needs-human");
    assert.ok(prov.calls.some((c) => c[0] === "teardown"));
    assert.equal(led.read(), null);
  });

  it("sandbox exited without a result: engine-error row, still torn down", async () => {
    const { r, prov, led } = await run({ finish: () => null });
    assert.equal(r.terminalReason, "engine-error");
    assert.match(r.detail, /fake-7 exited without a result/);
    assert.ok(prov.calls.some((c) => c[0] === "teardown"));
    assert.equal(led.read(), null);
  });

  it("start throws: typed needs-human sandbox.start_failed row (#4254), teardown still runs", async () => {
    const { r, prov, led } = await run({ startThrows: true });
    assert.equal(r.terminalReason, "needs-human");
    assert.equal(r.code, "sandbox.start_failed");
    assert.match(r.detail, /boom/);
    assert.ok(prov.calls.some((c) => c[0] === "teardown"));
    assert.equal(led.read(), null);
  });

  it("a teardown that fails keeps the sandbox listed for the reaper", async () => {
    const { led } = await run({ finish: () => ({ terminalReason: "merged" }), teardownOk: false });
    assert.deepEqual(led.entries("sandbox").map((e) => [e.value, e.provider]), [["fake-7", "fake"]]);
  });

  it("adopt after a restart: re-registers under this dispatcher, waits, tears down", async () => {
    const root = tmpDir("exec-adopt-");
    makeLedger({ root, batch: "bt", lane: "sandbox-7", owner: "orch_dead", issue: 7, host: HOST, pid: 999999 }).register("sandbox", "fake-7", { provider: "fake" });
    const ledgerFor = ledgerIn(root);
    const prov = fakeProvider();
    prov.live.add(7);
    const lanes = providerLanes({ provider: prov, laneArgs: () => [], ledgerFor, pollMs: 1, sleep: async () => { prov.results[7] = { terminalReason: "merged", pr: 3 }; prov.live.delete(7); } });
    const r = await lanes.adopt(7, { pid: undefined, remote: true, handle: { provider: "fake", id: "fake-7", issue: 7 } });
    assert.deepEqual(r, { terminalReason: "merged", pr: 3, sandbox: { provider: "fake", id: "fake-7", minutes: 0, cost_usd: 0 } });
    assert.ok(prov.calls.some((c) => c[0] === "teardown"));
    assert.equal(ledgerFor(7).read(), null);
    // Nothing to adopt (no handle): null, so orchestrate relaunches.
    assert.equal(await lanes.adopt(8, { pid: 5 }), null);
  });

  it("a sandbox an earlier attempt left behind is torn down before the relaunch", async () => {
    const root = tmpDir("exec-relaunch-");
    const ledgerFor = ledgerIn(root);
    ledgerFor(7).register("sandbox", "fake-7", { provider: "fake" });
    const prov = fakeProvider({ finish: () => ({ terminalReason: "merged" }) });
    await providerLanes({ provider: prov, laneArgs: () => [], ledgerFor, pollMs: 1 }).runOne(7, null);
    assert.deepEqual(prov.calls.map((c) => c[0]).slice(0, 2), ["teardown", "start"]);
  });
});

describe("runner kill: a sandbox left by a dead dispatcher is reaped by gc --apply (#4253)", () => {
  it("lists the stale sandbox, removes the container, releases the ledger; a live one is only reported", async () => {
    const home = tmpDir("exec-gc-");
    const root = join(home, ".forge", "ledger");
    mkdirSync(join(home, ".forge", "tmp"), { recursive: true });
    const dead = makeLedger({ root, batch: "bt", lane: "sandbox-7", owner: "orch_1", issue: 7, host: HOST, pid: 424242 });
    dead.register("sandbox", "fdsbx-bt-7", { provider: "container", handle: { provider: "container", id: "fdsbx-bt-7", issue: 7 } });
    const live = makeLedger({ root, batch: "bt", lane: "sandbox-8", owner: "orch_2", issue: 8, host: HOST, pid: 111 });
    live.register("sandbox", "fdsbx-bt-8", { provider: "container" });
    const docker = [];
    const probes = { cwd: home, host: HOST, ledgerRoot: root, forgeTmpRoot: join(home, ".forge", "tmp"), worktreeRoot: join(home, "wt"), fs: undefined,
      alive: (pid) => pid === 111, ppid: () => 0, procsInDir: () => [], dirSize: () => 0,
      docker: async (args) => { docker.push(args.join(" ")); if (args[0] === "ps") return [JSON.stringify({ Names: "fdsbx-bt-8", Labels: "forgedock.owner=1,forgedock.expires=1", CreatedAt: "2020-01-01 00:00:00 +0000 UTC", Size: "0B" })].join("\n"); return ""; },
      git: async () => "", gh: async () => "[]" };
    delete probes.fs;
    const plan = await planGc({ probes });
    const sb = plan.items.filter((i) => i.type === "sandbox");
    assert.deepEqual(sb.map((i) => [i.id, i.action]).sort(), [["fdsbx-bt-7", "reclaim"], ["fdsbx-bt-8", "report"]]);
    // The live sandbox's container is not reclaimed by the labelled-container pass even though its label expired.
    assert.equal(plan.items.some((i) => i.type === "container" && i.id === "fdsbx-bt-8"), false);
    const res = await applyGc(plan, probes);
    assert.deepEqual(res.reclaimed.map((i) => i.id), ["fdsbx-bt-7"]);
    assert.ok(docker.includes("rm -f fdsbx-bt-7"));
    assert.equal(docker.some((d) => d.includes("fdsbx-bt-8") && d.startsWith("rm")), false);
    assert.equal(existsSync(dead.path), false);
    assert.equal(live.entries("sandbox").length, 1);
  });

  it("an unknown provider is reported, never reclaimed", async () => {
    const home = tmpDir("exec-gc-unk-");
    const root = join(home, ".forge", "ledger");
    makeLedger({ root, batch: "bt", lane: "sandbox-9", owner: "o", issue: 9, host: HOST, pid: 424243 }).register("sandbox", "x-9", { provider: "k8s" });
    const probes = { cwd: home, host: HOST, ledgerRoot: root, forgeTmpRoot: join(home, "t"), worktreeRoot: join(home, "wt"), alive: () => false, ppid: () => 0,
      procsInDir: () => [], docker: async () => "", git: async () => "", gh: async () => "[]" };
    const plan = await planGc({ probes, scopes: new Set(["sandboxes"]) });
    assert.deepEqual(plan.items.map((i) => [i.type, i.action, i.reason]), [["sandbox", "report", "unknown sandbox provider k8s"]]);
  });

  it("a sandbox-only ledger file is not a live lane on this host", () => {
    const root = tmpDir("exec-count-");
    makeLedger({ root, batch: "bt", lane: "sandbox-1", owner: "o", issue: 1, host: HOST, pid: process.pid }).register("sandbox", "s-1", { provider: "container" });
    makeLedger({ root, batch: "bt", lane: "lean-2", owner: "o", issue: 2, host: HOST, pid: process.pid }).register("worktree", "/tmp/wt-2");
    assert.equal(countLiveLanes({ root, host: HOST }), 1);
  });
});

describe("container provider (#4253)", () => {
  it("docker run: --rm --pull never, ownership labels, read-only git and cache mounts, secret names only", async () => {
    const work = tmpDir("exec-ctr-");
    const cache = join(work, "cache"); mkdirSync(cache);
    const batch = openBatch(join(work, "batches"), "bt");
    const calls = [];
    const docker = async (args, o = {}) => { calls.push({ args, env: o.env }); return "cid\n"; };
    const p = containerProvider({ batch, repo: "o/r", image: "node:22", gitDir: "/repo/.git", cacheDir: cache, docker, user: "1000:1000", now: () => 5, ttlMs: 10 });
    const h = await p.start({ issue: 7, args: ["--repo", "o/r"], env: { GH_TOKEN: "s3cret", AWS_KEY: "leak" }, secrets: ["GH_TOKEN"] });
    assert.deepEqual(h, { provider: "container", id: "fdsbx-bt-7", issue: 7 });
    const a = calls[0].args, s = a.join(" ");
    assert.deepEqual(a.slice(0, 7), ["run", "-d", "--rm", "--pull", "never", "--name", "fdsbx-bt-7"]);
    for (const l of ["forgedock.owner=1", "forgedock.batch=bt", "forgedock.lane=sandbox-7", "forgedock.issue=7", "forgedock.expires=15", "forgedock.sandbox=1"]) assert.ok(s.includes(`--label ${l}`), l);
    assert.ok(s.includes("-v /repo/.git:/src:ro"));
    assert.ok(s.includes(`-v ${cache}:/cache:ro`));
    assert.ok(s.includes(`-v ${join(work, "batches", "bt", "lanes")}:/result`));
    assert.ok(s.includes("-e GH_TOKEN") && s.includes("-e GH_REPO") && s.includes("-e FORGEDOCK_BATCH_ID"));
    assert.equal(s.includes("s3cret"), false, "secret values never in argv");
    assert.equal(s.includes("AWS_KEY") || s.includes("leak"), false, "non-allowlisted env never forwarded");
    assert.equal(calls[0].env.GH_TOKEN, "s3cret");
    assert.equal(calls[0].env.AWS_KEY, undefined);
    assert.ok(a.includes("node:22") && a.includes("run-issue") && a.at(-1) === "/result/7.json");
    assert.equal(JSON.stringify(h).includes("s3cret"), false);
  });

  it("status maps docker states; teardown treats a gone container as torn down", async () => {
    const batch = openBatch(tmpDir("exec-ctr2-"), "bt");
    let state = "running", rmErr = null;
    const docker = async (args) => {
      if (args[0] === "inspect") { if (state === null) throw new Error("Error: No such object"); return `${state}\n`; }
      if (args[0] === "rm") { if (rmErr) { const e = new Error("x"); e.stderr = rmErr; throw e; } return ""; }
      return "";
    };
    const p = containerProvider({ batch, image: "i", gitDir: "/g", docker });
    const h = { provider: "container", id: "fdsbx-bt-1", issue: 1 };
    assert.equal(await p.status(h), "running");
    state = "exited"; assert.equal(await p.status(h), "exited");
    state = null; assert.equal(await p.status(h), "gone");
    assert.equal(await p.teardown(h), true);
    rmErr = "Error response from daemon: No such container: fdsbx-bt-1"; assert.equal(await p.teardown(h), true);
    rmErr = "removal of container fdsbx-bt-1 is already in progress"; state = null; assert.equal(await p.teardown(h), true);
    rmErr = "Cannot connect to the Docker daemon"; state = "running"; assert.equal(await p.teardown(h), false);
    await assert.rejects(containerProvider({ batch, gitDir: "/g", docker }).start({ issue: 1 }), /execution.image/);
  });
});

describe("max_remote admission (#4253)", () => {
  it("remote lanes run up to max_remote, never take a host registry slot, the rest wait", async () => {
    let live = 0, peak = 0;
    const gates = new Map();
    const acquired = [];
    const registry = { tryAcquire: (k) => { acquired.push(k); return { ok: false, reason: "host cap 1 reached" }; }, offer: () => {}, withdraw: () => {}, release: () => {}, setLanePid: () => {}, adoptSlot: () => {} };
    const runOne = (n) => new Promise((res) => { live++; peak = Math.max(peak, live); gates.set(n, () => { live--; res({ terminalReason: "merged", pr: n }); }); });
    const done = orchestrate({ issues: [1, 2, 3], parallel: 5, runOne, readBody: async () => "", sched: { registry, batch: "bt", repo: "o/r", cap: 1 }, priorityOf: async () => 2,
      remote: { max: 2, isRemote: () => true }, pollMs: 1, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms ?? 1, 5))) });
    const until = async (c) => { for (let i = 0; i < 400 && !c(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(c()); };
    await until(() => gates.size === 2);
    assert.deepEqual([...gates.keys()], [1, 2]);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(gates.size, 2, "the third waits for a remote slot");
    gates.get(1)();
    await until(() => gates.has(3));
    gates.get(2)(); gates.get(3)();
    const rows = await done;
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged", "merged"]);
    assert.equal(peak, 2);
    assert.deepEqual(acquired, [], "the host cap was never consulted");
  });

  it("a resumed batch re-counts adopted remote lanes against max_remote", async () => {
    let state = { v: 1, order: [1, 2], deps: { 1: [], 2: [] }, lanes: {}, crossSeen: [], results: {}, running: { 1: { startedAt: 1, remote: true, handle: { provider: "fake", id: "fake-1", issue: 1 } } }, pending: [2], notBefore: {}, requeues: {}, deferrals: {}, engineErrors: {}, prefilter: {}, errorTimes: [], breaker: null };
    const store = { load: () => state, save: (s) => { state = s; }, log: () => {} };
    const order = [];
    const rows = await orchestrate({ issues: [], parallel: 5, store, readBody: async () => "", remote: { max: 1, isRemote: () => true },
      adopt: async (n) => { order.push(`adopt${n}`); return { terminalReason: "merged", pr: 10 + n }; },
      runOne: async (n) => { order.push(`run${n}`); return { terminalReason: "merged", pr: 20 + n }; } });
    assert.deepEqual(rows.map((r) => [r.issue, r.pr]), [[1, 11], [2, 22]]);
    assert.deepEqual(order, ["adopt1", "run2"]);
  });
});

describe("runBatch wiring (#4253)", () => {
  const leanIo = { gh: async (a) => a.includes("milestone") ? JSON.stringify({ milestone: null }) : a[0] === "repo" ? "main\n" : JSON.stringify({ body: "" }),
    git: async (a) => (a[0] === "ls-remote" ? "abc\trefs/heads/staging\n" : a[0] === "rev-parse" ? ".git\n" : "") };
  const base = (work, extra) => ({ batchRoot: join(work, "batches"), allowTmpfs: true, pollMs: 5, orchestration: { breaker: null, maxDeferrals: 3 }, io: { gh: async () => "o/r\n" }, leanIo, sched: null, maintenance: null,
    executionBudget: openExecutionBudget({ file: join(work, "execution-budget.json") }), emitTelemetry: () => {}, ...extra });

  it("execution remote: lanes go through the provider with a sandbox ledger; result reaches the batch", async () => {
    const work = tmpDir("exec-cli-");
    const ledRoot = join(work, "ledger");
    const prov = fakeProvider({ finish: (n) => ({ terminalReason: "merged", pr: 100 + n, cost_usd: 0 }) });
    const res = await quiet(() => orchestrateFromCli(["1", "2", "--repo", "o/r", "--no-prefilter"], base(work, { batchId: "be1",
      execution: parseExecution({ mode: "remote", max_remote: "2", secrets: "GH_TOKEN" }), sandboxProvider: prov,
      sandboxLedger: (n) => makeLedger({ root: ledRoot, batch: "be1", lane: `sandbox-${n}`, owner: "t", issue: n }) })));
    assert.deepEqual(res.rows.map((r) => [r.issue, r.outcome, r.pr]), [[1, "merged", 101], [2, "merged", 102]]);
    assert.deepEqual(prov.calls.filter((c) => c[0] === "start").map((c) => c[1]), [1, 2]);
    assert.deepEqual(prov.secrets, ["GH_TOKEN"]);
    assert.equal(existsSync(join(ledRoot, "be1", "sandbox-1.json")), false); // torn down and released
  });

  it("execution absent or local: today's detached lanes (the provider is never used)", async () => {
    const work = tmpDir("exec-cli-local-");
    const stub = join(work, "stub.mjs");
    writeFileSync(stub, `import { writeFileSync } from "node:fs"; const a = process.argv.slice(2); writeFileSync(a[a.indexOf("--result-file") + 1], JSON.stringify({ terminalReason: "merged", pr: 7 }));\n`);
    for (const execution of [undefined, parseExecution({ mode: "local", max_remote: "4" }), parseExecution({ mode: "hybrid", max_remote: "4" })]) {
      const prov = fakeProvider();
      const res = await quiet(() => orchestrateFromCli(["1", "--repo", "o/r", "--no-prefilter"], base(work, { batchId: `bl-${execution?.mode ?? "absent"}`, laneScript: stub, execution, sandboxProvider: prov })));
      assert.deepEqual(res.rows.map((r) => [r.issue, r.outcome, r.pr]), [[1, "merged", 7]]);
      assert.deepEqual(prov.calls, []);
    }
  });
});

describe("execution budget and sandbox cost (#4255)", () => {
  const leanIo = { gh: async (x) => x.includes("milestone") ? JSON.stringify({ milestone: null }) : x[0] === "repo" ? "main\n" : JSON.stringify({ body: "" }),
    git: async (x) => (x[0] === "ls-remote" ? "abc\trefs/heads/staging\n" : x[0] === "rev-parse" ? ".git\n" : "") };
  const base = (work, extra) => ({ batchRoot: join(work, "batches"), allowTmpfs: true, pollMs: 5, orchestration: { breaker: null, maxDeferrals: 3 }, io: { gh: async () => "o/r\n" }, leanIo, sched: null, maintenance: null, ...extra });
  const sbx = (minutes, cost_usd = 0) => ({ provider: "fake", id: "x", minutes, cost_usd });
  // Remote lanes that each report `minutes` of sandbox time; `ctxs` records ctx.remote per launch.
  const budgetRun = ({ issues = [1, 2, 3, 4], budget, onBudget = "stop", file, store = null, minutes = 10, ctxs = [] }) => {
    const b = openExecutionBudget({ budget, file, now: () => 0 });
    return orchestrate({ issues, parallel: 1, store, readBody: async () => "", now: () => 0,
      remote: { max: 1, isRemote: () => true, admit: (u) => b.admit(u), onBudget, onUsage: (n, sb) => b.record(`bt#${n}#${ctxs.length}`, sb) },
      runOne: async (n, _l, ctx) => { ctxs.push([n, ctx.remote]); return { terminalReason: "merged", pr: n, cost_usd: 1, ...(ctx.remote ? { sandbox: sbx(minutes, 0.5) } : {}) }; } });
  };

  it("parseExecution reads the flat budget keys; invalid caps are no cap", () => {
    assert.deepEqual(parseExecution({ mode: "remote", max_remote: "2", budget_minutes: "30", budget_usd: "2.5", day_budget_minutes: "x", day_budget_usd: "-1", on_budget: "local", cost_per_minute: "0.05" }).budget,
      { batchMinutes: 30, batchUsd: 2.5, dayMinutes: null, dayUsd: null, onBudget: "local", costPerMinute: 0.05 });
    assert.equal(parseExecution({ on_budget: "fallback" }).budget.onBudget, "stop");
  });

  it("providerLanes attaches sandbox usage: from the provider, else wall clock x cost_per_minute; adopt measures from the persisted start", async () => {
    const root = tmpDir("exec-usage-");
    let t = 0;
    const now = () => t;
    const finish = () => ({ terminalReason: "merged", pr: 1 });
    const reported = fakeProvider({ finish, usage: async () => ({ minutes: 12.34, cost_usd: 0.5 }) });
    const r1 = await providerLanes({ provider: reported, laneArgs: () => [], ledgerFor: ledgerIn(root), pollMs: 1, now }).runOne(1, null);
    assert.deepEqual(r1.sandbox, { provider: "fake", id: "fake-1", minutes: 12.3, cost_usd: 0.5 });
    const wall = fakeProvider({ finish: () => { t += 10 * 60000; return finish(); } });
    const r2 = await providerLanes({ provider: wall, laneArgs: () => [], ledgerFor: ledgerIn(root), pollMs: 1, now, costPerMinute: 0.1 }).runOne(2, null);
    assert.deepEqual(r2.sandbox, { provider: "fake", id: "fake-2", minutes: 10, cost_usd: 1 });
    const throws = fakeProvider({ finish, usage: async () => { throw new Error("api down"); } });
    assert.equal((await providerLanes({ provider: throws, laneArgs: () => [], ledgerFor: ledgerIn(root), pollMs: 1, now }).runOne(3, null)).sandbox.minutes, 0);
    const adopted = fakeProvider();
    adopted.results[4] = { terminalReason: "merged", pr: 4 };
    t = 30 * 60000;
    const r4 = await providerLanes({ provider: adopted, laneArgs: () => [], ledgerFor: ledgerIn(root), pollMs: 1, now, costPerMinute: 0.1 })
      .adopt(4, { startedAt: 0, remote: true, handle: { provider: "fake", id: "fake-4", issue: 4, startedAt: 6 * 60000 } });
    assert.deepEqual(r4.sandbox, { provider: "fake", id: "fake-4", minutes: 24, cost_usd: 2.4 });
  });

  it("billable minutes a provider puts on the handle (#4254) are the lane's minutes, priced by cost_per_minute; a sandbox that never started has no usage", async () => {
    const root = tmpDir("exec-hmin-");
    const prov = fakeProvider({ finish: () => ({ terminalReason: "merged" }) });
    const start = prov.start;
    prov.start = async (o) => ({ ...(await start(o)), minutes: 7.5 });
    const r = await providerLanes({ provider: prov, laneArgs: () => [], ledgerFor: ledgerIn(root), pollMs: 1, costPerMinute: 0.2 }).runOne(1, null);
    assert.deepEqual(r.sandbox, { provider: "fake", id: "fake-1", minutes: 7.5, cost_usd: 1.5 });
    const failed = await providerLanes({ provider: fakeProvider({ startThrows: true }), laneArgs: () => [], ledgerFor: ledgerIn(root), pollMs: 1 }).runOne(2, null);
    assert.equal(failed.sandbox, undefined);
  });

  it("a batch that hits the budget admits no further remote lanes; on_budget stop holds the rest (fake provider)", async () => {
    const ctxs = [];
    const rows = await budgetRun({ budget: { batchMinutes: 20 }, file: join(tmpDir("exec-bud-"), "b.json"), ctxs });
    assert.deepEqual(ctxs, [[1, true], [2, true]], "the third lane is never started remote");
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged", "held", "held"]);
    assert.match(rows[2].detail, /^execution budget: batch sandbox minutes 20 >= budget_minutes 20/);
    assert.deepEqual(rows[0].sandbox, { minutes: 10, cost_usd: 0.5, attempts: 1 });
  });

  it("the USD cap through providerLanes x orchestrate: no remote start past budget_usd", async () => {
    const root = tmpDir("exec-bud-usd-");
    const prov = fakeProvider({ finish: () => ({ terminalReason: "merged" }), usage: async () => ({ minutes: 1, cost_usd: 0.75 }) });
    const lanes = providerLanes({ provider: prov, laneArgs: () => [], ledgerFor: ledgerIn(root), pollMs: 1 });
    const b = openExecutionBudget({ budget: { batchUsd: 1.5 }, file: join(root, "b.json") });
    const rows = await orchestrate({ issues: [1, 2, 3], parallel: 1, readBody: async () => "", ...lanes, remote: { max: 2, isRemote: () => true, admit: (u) => b.admit(u), onBudget: "stop" } });
    assert.deepEqual(prov.calls.filter((c) => c[0] === "start").map((c) => c[1]), [1, 2]);
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged", "held"]);
  });

  it("on_budget local: once the cap is hit the rest run as local lanes (ctx.remote false)", async () => {
    const ctxs = [];
    const rows = await budgetRun({ budget: { batchMinutes: 20 }, onBudget: "local", file: join(tmpDir("exec-bud-l-"), "b.json"), ctxs });
    assert.deepEqual(ctxs, [[1, true], [2, true], [3, false], [4, false]]);
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged", "merged", "merged"]);
    assert.equal(rows[3].sandbox, undefined);
  });

  it("budget state survives --resume: a resumed batch at the cap starts no remote lane", async () => {
    let state = null;
    const store = { load: () => state, save: (s) => { state = JSON.parse(JSON.stringify(s)); }, log: () => {} };
    const file = join(tmpDir("exec-bud-r-"), "b.json");
    await budgetRun({ budget: { batchMinutes: 20 }, file, store });
    assert.deepEqual(state.sandbox, { 1: { minutes: 10, cost_usd: 0.5, attempts: 1 }, 2: { minutes: 10, cost_usd: 0.5, attempts: 1 } });
    const ctxs = [];
    const rows = await budgetRun({ issues: [], budget: { batchMinutes: 20 }, file: join(tmpDir("exec-bud-r2-"), "fresh.json"), store, ctxs });
    assert.deepEqual(ctxs, [], "the batch total came from the saved state, not the host file");
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged", "held", "held"]);
    // A pre-#4255 state (no sandbox key) resumes as zero usage.
    const legacy = { v: 1, order: [5], deps: { 5: [] }, lanes: {}, crossSeen: [], results: {}, running: {}, pending: [5], notBefore: {}, requeues: {}, deferrals: {}, engineErrors: {}, prefilter: {}, errorTimes: [], breaker: null };
    const ctx2 = [];
    const r2 = await budgetRun({ issues: [], budget: { batchMinutes: 20 }, file, store: { load: () => legacy, save: () => {}, log: () => {} }, ctxs: ctx2 });
    assert.deepEqual(ctx2, [[5, true]]);
    assert.equal(r2[0].outcome, "merged");
  });

  it("host-day budget survives a schedd restart: totals reload from the file, a repeated record is not double-counted", () => {
    const file = join(tmpDir("exec-day-"), "sched", "execution-budget.json");
    const now = () => Date.parse("2026-10-20T10:00:00Z");
    const a = openExecutionBudget({ budget: { dayMinutes: 15 }, file, now });
    assert.equal(a.record("b1#fdsbx-1#100", { minutes: 10, cost_usd: 1 }), true);
    assert.equal(a.record("b1#fdsbx-1#100", { minutes: 10, cost_usd: 1 }), false);
    const b = openExecutionBudget({ budget: { dayMinutes: 15 }, file, now }); // a fresh daemon
    assert.deepEqual(b.dayTotals(), { ok: true, day: "2026-10-20", minutes: 10, cost_usd: 1 });
    assert.equal(b.admit({ minutes: 0, cost_usd: 0, running: { minutes: 0, cost_usd: 0 } }).ok, true);
    assert.match(b.admit({ minutes: 5, cost_usd: 0, running: { minutes: 5, cost_usd: 0 } }).reason, /day_budget_minutes 15/);
    // The next UTC day starts from zero.
    assert.equal(openExecutionBudget({ budget: { dayMinutes: 15 }, file, now: () => Date.parse("2026-10-21T00:00:01Z") }).admit({}).ok, true);
    // A corrupt store fails closed only while a day cap is set, and is never overwritten.
    writeFileSync(file, "{not json");
    assert.match(openExecutionBudget({ budget: { dayUsd: 5 }, file, now }).admit({}).reason, /unreadable/);
    assert.equal(openExecutionBudget({ budget: { batchMinutes: 50 }, file, now }).admit({}).ok, true);
    assert.equal(openExecutionBudget({ budget: {}, file, now }).record("k", { minutes: 1 }), false);
    assert.equal(readFileSync(file, "utf8"), "{not json");
  });

  it("report: sandbox columns next to token cost only when a lane used a sandbox; summary line", () => {
    const local = [{ issue: 1, outcome: "merged", pr: 2, cost_usd: 1.5, minutes: 3 }];
    assert.doesNotMatch(formatTable(local), /sbx/);
    assert.equal(formatSandboxSummary(local), null);
    const rows = [{ issue: 1, outcome: "merged", pr: 2, cost_usd: 1.5, minutes: 3, sandbox: { minutes: 12.5, cost_usd: 0.25, attempts: 1 } },
      { issue: 2, outcome: "held", pr: null, cost_usd: 0, minutes: 0, detail: "execution budget: batch sandbox minutes 12.5 >= budget_minutes 10" }];
    const t = formatTable(rows);
    assert.match(t.split("\n")[0], /cost\s+sbx-min\s+sbx-\$\s+min/);
    assert.match(t, /#1\s+merged\s+#2\s+\$1\.50\s+12\.5\s+\$0\.25\s+3/);
    assert.equal(formatSandboxSummary(rows, { budget: { batchMinutes: 10, batchUsd: null, dayMinutes: null, dayUsd: 20 }, day: { ok: true, minutes: 12.5, cost_usd: 0.25 } }),
      "sandbox: 1 lane, 12.5 min, $0.25 (token cost $1.50); budget: batch 10 min, day $20; host today 12.5 min, $0.25; cap reached, 1 held");
  });

  it("runBatch: rows, report.json and FORGE:TELEMETRY carry each lane's sandbox usage; the host-day store records it", async () => {
    const work = tmpDir("exec-cli-cost-");
    const ledRoot = join(work, "ledger");
    const prov = fakeProvider({ finish: (n) => ({ terminalReason: "merged", pr: 100 + n, cost_usd: 2 }), usage: async (h) => ({ minutes: 5 * h.issue, cost_usd: 0.1 * h.issue }) });
    const events = [];
    const file = join(work, "day.json");
    const res = await quiet(() => orchestrateFromCli(["1", "2", "3", "--repo", "o/r", "--no-prefilter"], base(work, { batchId: "bc1",
      execution: parseExecution({ mode: "remote", max_remote: "1", budget_minutes: "15" }), sandboxProvider: prov,
      sandboxLedger: (n) => makeLedger({ root: ledRoot, batch: "bc1", lane: `sandbox-${n}`, owner: "t", issue: n }),
      executionBudget: openExecutionBudget({ budget: parseExecution({ budget_minutes: "15" }).budget, file }), emitTelemetry: (rec) => { events.push(rec); } })));
    assert.deepEqual(res.rows.map((r) => [r.issue, r.outcome, r.sandbox?.minutes ?? null]), [[1, "merged", 5], [2, "merged", 10], [3, "held", null]]);
    const rep = openBatch(join(work, "batches"), "bc1").readReport();
    assert.deepEqual(rep.rows[1].sandbox, { minutes: 10, cost_usd: 0.2, attempts: 1 });
    assert.match(rep.report, /sandbox: 2 lanes, 15\.0 min, \$0\.30 \(token cost \$4\.00\); budget: batch 15 min/);
    assert.match(rep.report, /sbx-min/);
    assert.deepEqual(events.filter((e) => e.event === "SANDBOX_USAGE").map((e) => [e.issue, e.minutes, e.cost_usd, e.batch]), [[1, 5, 0.1, "bc1"], [2, 10, 0.2, "bc1"]]);
    assert.equal(Object.keys(JSON.parse(readFileSync(file, "utf8")).days[new Date().toISOString().slice(0, 10)]).length, 2);
  });
});
