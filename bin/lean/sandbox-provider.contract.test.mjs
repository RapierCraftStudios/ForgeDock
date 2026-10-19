// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Sandbox provider contract (#4254): one suite every provider passes (container over a fake docker, remote over a fake
// transport), plus the remote adapter, credentials, config and gc specifics.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { containerProvider, parseExecution, providerByName, providerLanes, remoteTransportFor } from "./execution.mjs";
import { remoteProvider, httpTransport, isActionsEndpoint, redact } from "./sandbox-remote.mjs";
import { resolveCredential } from "./credentials.mjs";
import { makeLedger } from "./ledger.mjs";
import { openBatch } from "./batch.mjs";
import { orchestrate } from "./orchestrate.mjs";
import { planGc, applyGc } from "../gc.mjs";

const HOST = "testhost";
const SECRET = "s3cret-value-123";
const TOKEN = "tok-credential-456";

/** Fake docker daemon for the container provider: `run` starts, `inspect` reports, `rm` removes. */
function containerFixture(batch, { startError = null } = {}) {
  const live = new Map(); // id -> state
  const docker = async (args) => {
    if (args[0] === "run") {
      if (startError) throw Object.assign(new Error("x"), { stderr: startError });
      live.set(args[args.indexOf("--name") + 1], "running"); return "cid\n";
    }
    if (args[0] === "inspect") { const id = args.at(-1); if (!live.has(id)) throw new Error("Error: No such object"); return `${live.get(id)}\n`; }
    if (args[0] === "rm") { const id = args.at(-1); if (!live.delete(id)) throw Object.assign(new Error("x"), { stderr: `No such container: ${id}` }); return ""; }
    return "";
  };
  return {
    provider: containerProvider({ batch, repo: "o/r", image: "img:1", gitDir: "/g/.git", cacheDir: null, docker, user: null }),
    finish: (h, result) => { mkdirSync(dirname(batch.resultFile(h.issue)), { recursive: true }); writeFileSync(batch.resultFile(h.issue), JSON.stringify(result)); live.set(h.id, "exited"); },
    exists: (id) => live.has(id),
  };
}

/** In-memory transport: the "remote" end of the protocol. */
function fakeTransport({ launchError = null } = {}) {
  const t = {
    boxes: new Map(), specs: [], destroyed: [],
    async launch(spec) { if (launchError) throw launchError; t.specs.push(spec); t.boxes.set(spec.id, { state: "running", log: "", result: null, minutes: 0 }); return { id: spec.id }; },
    async status(id) { return t.boxes.get(id)?.state ?? "gone"; },
    async logs(id, cursor = 0) { const b = t.boxes.get(id); if (!b) return { text: "", cursor }; return { text: b.log.slice(cursor), cursor: b.log.length }; },
    async result(id) { return t.boxes.get(id)?.result ?? null; },
    async usage(id) { const b = t.boxes.get(id); return b ? { minutes: b.minutes } : null; },
    async destroy(id) { t.destroyed.push(id); t.boxes.delete(id); return true; },
  };
  return t;
}
function remoteFixture(batch, { launchError = null } = {}) {
  const transport = fakeTransport({ launchError });
  const provider = remoteProvider({ batch, repo: "o/r", settings: { image: "img:1", cacheStore: "s3://cache", tokenEnv: "FD_TOKEN", secrets: ["GH_TOKEN"] }, transport,
    env: { GH_TOKEN: SECRET, FD_TOKEN: TOKEN }, credentials: (n) => ({ GH_TOKEN: SECRET, FD_TOKEN: TOKEN })[n] ?? null });
  return {
    provider, transport,
    finish: (h, result) => { const b = transport.boxes.get(h.id); b.log += `lane done; token ${SECRET} and ${TOKEN}\n`; b.result = result; b.state = "exited"; b.minutes = 3.5; },
    exists: (id) => transport.boxes.has(id),
  };
}

const FIXTURES = { container: containerFixture, remote: remoteFixture };

for (const [name, make] of Object.entries(FIXTURES)) {
  describe(`sandbox provider contract: ${name} (#4254)`, () => {
    const setup = (opts) => { const work = tmpDir(`contract-${name}-`); const batch = openBatch(join(work, "batches"), "bt"); return { work, batch, ...make(batch, opts) }; };

    it("idFor is stable and equals the started handle id; start -> running; result -> fetched, exited", async () => {
      const { provider, finish } = setup();
      assert.equal(provider.idFor(7), provider.idFor(7));
      const h = await provider.start({ issue: 7, args: ["--repo", "o/r", "--lane", "staging"], env: { GH_TOKEN: SECRET }, secrets: ["GH_TOKEN"] });
      assert.equal(h.id, provider.idFor(7));
      assert.equal(h.provider, provider.name);
      assert.equal(h.issue, 7);
      assert.equal(await provider.status(h), "running");
      assert.equal(await provider.fetchResult(h), null);
      finish(h, { terminalReason: "merged", pr: 1 });
      assert.deepEqual(await provider.fetchResult(h), { terminalReason: "merged", pr: 1 });
      assert.equal(await provider.status(h), "exited");
    });

    it("teardown is true and idempotent; a gone sandbox is torn down", async () => {
      const { provider, exists } = setup();
      const h = await provider.start({ issue: 8, args: [], env: {}, secrets: [] });
      assert.equal(await provider.teardown(h), true);
      assert.equal(exists(h.id), false);
      assert.equal(await provider.teardown(h), true);
      assert.equal(await provider.status(h), "gone");
    });

    it("providerLanes: ledger before start, released after teardown; secrets never in handle, ledger, state or log", async () => {
      const { work, provider, finish, batch } = setup();
      const root = join(work, "ledger");
      const ledgerFor = (n) => makeLedger({ root, batch: "bt", lane: `sandbox-${n}`, owner: "o", issue: n, host: HOST, pid: process.pid });
      let atStart = null;
      const wrapped = { ...provider, start: async (a) => { atStart = ledgerFor(a.issue).entries("sandbox").map((e) => e.value); const h = await provider.start(a); setTimeout(() => finish(h, { terminalReason: "merged", pr: 4 }), 5); return h; } };
      const started = [];
      const r = await providerLanes({ provider: wrapped, laneArgs: () => ["--repo", "o/r"], ledgerFor, env: { GH_TOKEN: SECRET }, secrets: ["GH_TOKEN"], pollMs: 2 }).runOne(9, "staging", { onStart: (x) => started.push(x) });
      assert.equal(r.terminalReason, "merged");
      assert.deepEqual(atStart, [provider.idFor(9)]);
      assert.equal(ledgerFor(9).read(), null);
      const files = [JSON.stringify(started), JSON.stringify(r)];
      if (existsSync(join(root, "bt"))) for (const f of readdirSync(join(root, "bt"))) files.push(readFileSync(join(root, "bt", f), "utf8"));
      if (existsSync(batch.logFile(9))) files.push(readFileSync(batch.logFile(9), "utf8"));
      for (const f of files) { assert.equal(f.includes(SECRET), false); assert.equal(f.includes(TOKEN), false); }
    });

    it("a sandbox that fails to start: needs-human sandbox.start_failed, ledger released, orchestrate does not relaunch it", async () => {
      const opts = name === "container" ? { startError: "Unable to find image 'img:1' locally" } : { launchError: new Error("sandbox launch: HTTP 400") };
      const { work, provider } = setup(opts);
      const root = join(work, "ledger");
      const ledgerFor = (n) => makeLedger({ root, batch: "bt", lane: `sandbox-${n}`, owner: "o", issue: n, host: HOST, pid: process.pid });
      const lanes = providerLanes({ provider, laneArgs: () => [], ledgerFor, pollMs: 1 });
      let starts = 0;
      const rows = await orchestrate({ issues: [5], parallel: 1, readBody: async () => "", runOne: async (n, l) => { starts++; return lanes.runOne(n, l); } });
      assert.deepEqual(rows.map((x) => [x.issue, x.outcome, x.code]), [[5, "needs-human", "sandbox.start_failed"]]);
      assert.equal(starts, 1, "not relaunched");
      assert.equal(ledgerFor(5).read(), null);
    });
  });
}

describe("remote adapter (#4254)", () => {
  const setup = () => { const batch = openBatch(join(tmpDir("remote-"), "batches"), "bt"); return { batch, ...remoteFixture(batch) }; };

  it("launch spec: clones the target repo at the lane, mounts the shared cache store, scoped env only, run-issue command", async () => {
    const { provider, transport } = setup();
    await provider.start({ issue: 7, args: ["--repo", "o/r", "--lane", "staging"], env: { GH_TOKEN: SECRET, AWS_SECRET_ACCESS_KEY: "leak-leak" }, secrets: ["GH_TOKEN"] });
    const spec = transport.specs[0];
    assert.equal(spec.id, "fdrsbx-bt-7");
    assert.deepEqual(spec.repo, { slug: "o/r", url: "https://github.com/o/r.git", ref: "staging" });
    assert.deepEqual(spec.cache, { store: "s3://cache", key: "o_r" });
    assert.deepEqual(spec.env, { FORGEDOCK_BATCH_ID: "bt", GH_REPO: "o/r", GH_TOKEN: SECRET });
    assert.deepEqual(spec.command.slice(0, 3), ["forgedock", "run-issue", "7"]);
    assert.deepEqual(spec.command.slice(-2), ["--result-file", "/result/7.json"]);
    assert.equal(JSON.stringify(spec).includes(TOKEN), false, "the transport credential is never in the spec");
  });

  it("a secret missing from the env is read from the keychain (credential resolver)", async () => {
    const batch = openBatch(join(tmpDir("remote-kc-"), "batches"), "bt");
    const transport = fakeTransport();
    const p = remoteProvider({ batch, repo: "o/r", settings: { secrets: ["GH_TOKEN"] }, transport, env: {}, credentials: (n) => (n === "GH_TOKEN" ? "from-keychain" : null) });
    await p.start({ issue: 1, args: [], env: {}, secrets: ["GH_TOKEN"] });
    assert.equal(transport.specs[0].env.GH_TOKEN, "from-keychain");
  });

  it("streams the lane log into the batch log, redacted; billable minutes on the handle and on the lane result", async () => {
    const { provider, finish, batch } = setup();
    const lanes = providerLanes({ provider: { ...provider, start: async (a) => { const h = await provider.start(a); setTimeout(() => finish(h, { terminalReason: "merged", pr: 2 }), 5); return h; } },
      laneArgs: () => [], ledgerFor: () => null, env: { GH_TOKEN: SECRET }, secrets: ["GH_TOKEN"], pollMs: 2 });
    const r = await lanes.runOne(3, null);
    assert.equal(r.terminalReason, "merged");
    assert.deepEqual(r.sandbox, { provider: "remote", id: "fdrsbx-bt-3", minutes: 3.5 });
    const log = readFileSync(batch.logFile(3), "utf8");
    assert.match(log, /lane done/);
    assert.equal(log.includes(SECRET) || log.includes(TOKEN), false);
    assert.match(log, /\[redacted\]/);
  });

  it("a capacity error defers (sandbox.capacity, retryInSeconds); persistent status errors end the lane", async () => {
    const batch = openBatch(join(tmpDir("remote-cap-"), "batches"), "bt");
    const transport = fakeTransport({ launchError: Object.assign(new Error("sandbox launch: HTTP 429"), { retryable: true, retryInSeconds: 30 }) });
    const p = remoteProvider({ batch, repo: "o/r", transport, env: {} });
    const r = await providerLanes({ provider: p, laneArgs: () => [], ledgerFor: () => null, pollMs: 1 }).runOne(4, null);
    assert.deepEqual([r.terminalReason, r.code, r.retryInSeconds], ["deferred", "sandbox.capacity", 30]);
    const flaky = { ...fakeTransport(), status: async () => { throw new Error("ECONNRESET"); } };
    const q = remoteProvider({ batch, repo: "o/r", transport: flaky, env: {} });
    const h = await q.start({ issue: 6, args: [] });
    const seen = [];
    for (let i = 0; i < 5; i++) seen.push(await q.status(h));
    assert.deepEqual(seen, ["running", "running", "running", "running", "gone"]);
  });

  it("httpTransport: bearer token, JSON protocol, 404 = gone/destroyed, 429 retryable; the token never in errors", async () => {
    const calls = [];
    const reply = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)), headers: { get: (k) => headers[k] ?? null } });
    let launchStatus = 201;
    const fetchFn = async (url, init) => {
      calls.push([init.method, url, init.headers.authorization]);
      if (init.method === "POST") return launchStatus === 201 ? reply(201, { id: "x" }) : reply(launchStatus, { error: TOKEN }, { "retry-after": "12" });
      if (url.endsWith("/usage")) return reply(200, { minutes: 2 });
      if (url.endsWith("/result")) return reply(404);
      if (url.includes("/logs")) return reply(200, { text: "hi", cursor: 2 });
      if (init.method === "DELETE") return reply(404);
      return reply(200, { state: "running" });
    };
    const t = httpTransport({ endpoint: "https://pool.example/v1/", token: TOKEN, fetchFn });
    await t.launch({ id: "x" });
    assert.deepEqual(calls[0], ["POST", "https://pool.example/v1/sandboxes", `Bearer ${TOKEN}`]);
    assert.equal(await t.status("x"), "running");
    assert.deepEqual(await t.logs("x", 0), { text: "hi", cursor: 2 });
    assert.equal(await t.result("x"), null);
    assert.deepEqual(await t.usage("x"), { minutes: 2 });
    assert.equal(await t.destroy("x"), true);
    launchStatus = 429;
    await assert.rejects(t.launch({ id: "y" }), (e) => e.retryable === true && e.retryInSeconds === 12 && !e.message.includes(TOKEN));
  });

  it("redact replaces every secret value", () => {
    assert.equal(redact(`a ${SECRET} b ${SECRET}`, [SECRET, "", null]), "a [redacted] b [redacted]");
  });
});

describe("remote config and the Actions constraint (#4254)", () => {
  it("parseExecution reads the remote settings; remote is never the default provider", () => {
    assert.deepEqual(parseExecution({ mode: "remote", max_remote: "2", provider: "remote", endpoint: "https://pool.example/v1", token_env: "FD_POOL_TOKEN", cache_store: "s3://c", allow_actions: "true" }),
      { mode: "remote", maxRemote: 2, provider: "remote", image: null, secrets: [], endpoint: "https://pool.example/v1", tokenEnv: "FD_POOL_TOKEN", cacheStore: "s3://c", allowActions: true });
    for (const sec of [{}, { mode: "remote", max_remote: "3" }, { mode: "hybrid" }, { mode: "remote", endpoint: "https://api.github.com/repos/o/r/actions/workflows/x/dispatches" }]) {
      assert.notEqual(parseExecution(sec).provider, "remote");
    }
    assert.equal(parseExecution({ endpoint: "not a url", token_env: "bad-name" }).endpoint, undefined);
  });

  it("providerByName remote: needs an endpoint; a GitHub Actions endpoint is refused unless allow_actions", () => {
    const batch = openBatch(tmpDir("remote-cfg-"), "bt");
    assert.throws(() => providerByName("remote", { batch, repo: "o/r", exec: parseExecution({ mode: "remote", provider: "remote" }) }), (e) => e.code === "execution.provider.misconfigured");
    const actions = { mode: "remote", provider: "remote", endpoint: "https://api.github.com/repos/o/r/actions/workflows/lane.yml/dispatches" };
    assert.throws(() => providerByName("remote", { batch, repo: "o/r", exec: parseExecution(actions) }), (e) => e.code === "execution.provider.actions_refused");
    assert.equal(providerByName("remote", { batch, repo: "o/r", exec: parseExecution({ ...actions, allow_actions: "true" }), env: {} }).name, "remote");
    assert.equal(providerByName("remote", { batch, repo: "o/r", exec: parseExecution({ provider: "remote", endpoint: "https://pool.example/v1" }), env: {} }).name, "remote");
    assert.ok(isActionsEndpoint("https://ghe.example/api/v3/repos/o/r/actions/runs") && !isActionsEndpoint("https://pool.example/v1"));
    assert.equal(remoteTransportFor({}, { transport: fakeTransport() }) !== null, true);
  });

  it("resolveCredential: env first, then keychain, failures are null", () => {
    assert.equal(resolveCredential("FD_T", { env: { FD_T: "e" }, keychain: () => "k" }), "e");
    assert.equal(resolveCredential("FD_T", { env: { FD_T: "" }, keychain: (n) => (n === "FD_T" ? "k" : null) }), "k");
    assert.equal(resolveCredential("FD_T", { env: {}, keychain: () => { throw new Error("locked"); } }), null);
    assert.equal(resolveCredential("bad name", { env: { "bad name": "x" } }), null);
  });
});

describe("gc reaps a remote sandbox left by a dead dispatcher (#4254)", () => {
  it("destroys it through the transport and releases the ledger; failure keeps it listed", async () => {
    const home = tmpDir("remote-gc-");
    const root = join(home, ".forge", "ledger");
    mkdirSync(join(home, ".forge", "tmp"), { recursive: true });
    const led = makeLedger({ root, batch: "bt", lane: "sandbox-7", owner: "orch_1", issue: 7, host: HOST, pid: 424242 });
    led.register("sandbox", "fdrsbx-bt-7", { provider: "remote", handle: { provider: "remote", id: "fdrsbx-bt-7", issue: 7 } });
    const transport = fakeTransport();
    const probes = { cwd: home, host: HOST, ledgerRoot: root, forgeTmpRoot: join(home, ".forge", "tmp"), worktreeRoot: join(home, "wt"), alive: () => false, ppid: () => 0,
      procsInDir: () => [], dirSize: () => 0, docker: async () => "", git: async () => "", gh: async () => "[]", sandboxTransport: transport };
    const plan = await planGc({ probes, scopes: new Set(["sandboxes"]) });
    assert.deepEqual(plan.items.map((i) => [i.type, i.id, i.action]), [["sandbox", "fdrsbx-bt-7", "reclaim"]]);
    // Without a configured transport (no forge.yaml execution endpoint) the teardown fails and the entry stays.
    const failed = await applyGc(plan, { ...probes, sandboxTransport: undefined });
    assert.equal(failed.reclaimed.length, 0);
    assert.equal(existsSync(led.path), true);
    const res = await applyGc(plan, probes);
    assert.deepEqual(res.reclaimed.map((i) => i.id), ["fdrsbx-bt-7"]);
    assert.deepEqual(transport.destroyed, ["fdrsbx-bt-7"]);
    assert.equal(existsSync(led.path), false);
  });
});
