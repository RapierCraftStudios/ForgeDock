// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Lane execution targets (#4253): config, sandbox-provider seam, ledger-tracked teardown, gc reaping, max_remote admission.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { parseExecution, placement, scopedEnv, providerLanes, containerProvider, providerByName } from "./execution.mjs";
import { makeLedger, countLiveLanes } from "./ledger.mjs";
import { openBatch } from "./batch.mjs";
import { orchestrate } from "./orchestrate.mjs";
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
  };
  return p;
}

const ledgerIn = (root, { pid = process.pid, host = HOST } = {}) => (n) => makeLedger({ root, batch: "bt", lane: `sandbox-${n}`, owner: "orch_test", issue: n, host, pid });

describe("execution config (#4253)", () => {
  it("absent, empty or invalid config is local; max_remote and secrets are validated", () => {
    assert.deepEqual(parseExecution(undefined), { mode: "local", maxRemote: 0, provider: "local", image: null, secrets: [] });
    assert.deepEqual(parseExecution({ mode: "cloud", max_remote: "-1" }), { mode: "local", maxRemote: 0, provider: "local", image: null, secrets: [] });
    assert.deepEqual(parseExecution({ mode: "remote", max_remote: "4", image: "node:22-slim", secrets: "GH_TOKEN, bad-name,ANTHROPIC_API_KEY,GH_TOKEN" }),
      { mode: "remote", maxRemote: 4, provider: "container", image: "node:22-slim", secrets: ["GH_TOKEN", "ANTHROPIC_API_KEY"] });
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
    assert.deepEqual(readExecution(dir), { mode: "remote", maxRemote: 5, provider: "container", image: "node:22", secrets: ["GH_TOKEN"] });
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
    const lanes = providerLanes({ provider: prov, laneArgs: () => ["--repo", "o/r"], ledgerFor, pollMs, env: { GH_TOKEN: "x" }, secrets: ["GH_TOKEN"],
      sleep: async () => { if (++ticks === 2 && !finish) { prov.results[7] = { terminalReason: "merged", pr: 9 }; prov.live.delete(7); } } });
    const started = [];
    const r = await lanes.runOne(7, "staging", { onStart: (i) => started.push(i) });
    return { r, prov, started, led: ledgerFor(7) };
  };

  it("success: registered before start, result reaches the batch, torn down and released", async () => {
    const { r, prov, started, led } = await run();
    assert.deepEqual(prov.ledgerAtStart, ["fake-7"]); // registered BEFORE the sandbox was created
    assert.deepEqual(r, { terminalReason: "merged", pr: 9 });
    assert.deepEqual(started, [{ handle: { provider: "fake", id: "fake-7", issue: 7 }, remote: true }]);
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

  it("start throws: engine-error row, teardown still runs", async () => {
    const { r, prov, led } = await run({ startThrows: true });
    assert.equal(r.terminalReason, "engine-error");
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
    assert.deepEqual(r, { terminalReason: "merged", pr: 3 });
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
  const base = (work, extra) => ({ batchRoot: join(work, "batches"), allowTmpfs: true, pollMs: 5, orchestration: { breaker: null, maxDeferrals: 3 }, io: { gh: async () => "o/r\n" }, leanIo, sched: null, maintenance: null, ...extra });

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
