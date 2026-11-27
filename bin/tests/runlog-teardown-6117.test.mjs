// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6117: the sandbox's run log and log tail reach the dispatcher before teardown on every terminal path; the agent and router
// keep the last log for a grace period after destroy; a probe never reports bash missing because the lane PATH lacks /usr/bin.
import { tmpDir } from "./_tmp.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { remoteProvider, httpTransport } from "../lean/sandbox-remote.mjs";
import { providerLanes } from "../lean/execution.mjs";
import { runCheckCommand, withSystemDirs } from "../lean/effects.mjs";
import { createAgent } from "../pool/agent.mjs";
import { createRouter } from "../pool/router.mjs";
import { readLog } from "../engine/runlog.mjs";

const REPO = "o/r";
const RUN_LOG = ['{"seq":1,"event":"RUN_START"}', '{"seq":2,"event":"REMOTE_PROVISIONED"}', '{"seq":3,"event":"REMOTE_TOOLS_GENERIC"}'].join("\n") + "\n";

/** A fake pool: the sandbox's log served in two chunks, then evidence; destroy records the order. */
function setup({ result = null, runlog = { runLog: RUN_LOG, tail: "boom: line 200\n" }, logsFail = false } = {}) {
  const dir = tmpDir("rl6117-");
  const calls = [];
  let destroyed = false;
  const chunks = ["engine line 1\n", "engine line 2\n"];
  const transport = {
    launch: async () => ({}),
    status: async () => "exited",
    logs: async (_id, cursor = 0) => { calls.push("logs"); if (logsFail) throw new Error("agent unreachable"); const t = chunks[cursor] ?? ""; return { text: t, cursor: Math.min(cursor + 1, chunks.length) }; },
    result: async () => result,
    usage: async () => null,
    runlog: async () => { calls.push("runlog"); if (destroyed && !runlog.graced) return null; return runlog; },
    destroy: async () => { calls.push("destroy"); destroyed = true; return true; },
  };
  const batch = { id: "b1", logFile: (n) => join(dir, "lanes", `${n}.log`), resultFile: (n) => join(dir, "lanes", `${n}.json`) };
  const provider = remoteProvider({ batch, repo: REPO, settings: {}, transport, env: { FORGE_RUNS_DIR: join(dir, "runs") }, credentials: () => null, gitIdentity: () => ({}) });
  const lanes = providerLanes({ provider, laneArgs: () => [], ledgerFor: () => null, pollMs: 1, now: () => 1000, sleep: async () => {} });
  return { dir, calls, lanes, batch };
}

describe("run log copied before teardown (#6117)", () => {
  for (const [name, result] of [
    ["merged", { terminalReason: "merged", pr: 9 }],
    ["needs-human", { terminalReason: "needs-human", code: "env.tool_missing", detail: "Remote sandbox lacks yaml" }],
    ["deferred", { terminalReason: "deferred", code: "sandbox.capacity" }],
    ["engine-error", { terminalReason: "engine-error", detail: "boom" }],
    ["no result at all (exited without one)", null],
  ]) {
    it(`${name}: lane log is complete, <n>.runlog.jsonl exists, and both come before destroy`, async () => {
      const { dir, calls, lanes, batch } = setup({ result });
      const r = await lanes.runOne(7, "staging");
      await r.postRun?.();
      assert.ok(calls.indexOf("destroy") > calls.lastIndexOf("runlog"), `evidence before destroy: ${calls.join(",")}`);
      assert.ok(calls.indexOf("destroy") > calls.lastIndexOf("logs"));
      assert.equal(readFileSync(batch.logFile(7), "utf8"), "engine line 1\nengine line 2\n");
      const f = join(dir, "lanes", "7.runlog.jsonl");
      assert.ok(existsSync(f));
      assert.match(readFileSync(f, "utf8"), /REMOTE_TOOLS_GENERIC/);
      assert.ok(readLog(join(dir, "runs"), 7, { repo: REPO }).some((e) => e.event === "REMOTE_PROVISIONED"));
    });
  }

  it("when the live log cannot be drained, the stderr tail is appended to the lane log", async () => {
    const { calls, lanes, batch } = setup({ result: { terminalReason: "needs-human" }, logsFail: true });
    const r = await lanes.runOne(7, "staging");
    await r.postRun?.();
    assert.match(readFileSync(batch.logFile(7), "utf8"), /last lines of its log[\s\S]*boom: line 200/);
    assert.ok(calls.includes("destroy"));
  });

  it("a pool without the runlog endpoint (404) still tears down", async () => {
    const t = httpTransport({ endpoint: "http://pool", fetchFn: async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }) });
    assert.equal(await t.runlog("x"), null);
  });

  it("a late teardown (sandbox already destroyed) still gets the log from the agent's grace copy", async () => {
    const { dir, lanes } = setup({ result: { terminalReason: "merged" }, runlog: { runLog: RUN_LOG, tail: "", graced: true } });
    const r = await lanes.runOne(7, "staging");
    await r.postRun?.();
    assert.ok(existsSync(join(dir, "lanes", "7.runlog.jsonl")));
  });
});

describe("agent keeps the last log after destroy (#6117)", () => {
  const quiet = { info() {}, warn() {}, error() {} };
  const spec = (id) => ({ id, issue: 7, batch: "b1", repo: { slug: REPO, url: "https://github.com/o/r.git", ref: "staging" }, command: ["forgedock", "run-issue", "7"], result_file: "/result/7.json" });
  function fixture(clock, extra = {}) {
    const removed = [];
    const docker = {
      runs: [],
      async run(a) { this.runs.push(a); return "cid"; },
      async inspect() { return { running: false, exitCode: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }; },
      async remove(n) { removed.push(n); }, async kill() { return false; }, async listLabelled() { return []; }, async wipe() {},
      async removeWorkDir() {}, async pruneWorkDirs() {}, async listVolumes() { return []; }, async removeVolume() {},
      async copyOut(_name, _src, dest) { writeFileSync(join(dest, "o__r__7.jsonl"), RUN_LOG); writeFileSync(join(dest, "o__r__8.jsonl"), "other\n"); },
    };
    const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://router:7710", state_dir: tmpDir("cs-6117-"), allow_cpus: 16, allow_mem_gb: 32, lease_ttl_s: 600, token: "t", ...extra }, { docker, now: () => clock.t, log: quiet, live: () => ({ ok: true }), vm: () => ({ cpus: 64, mem_gb: 256, swap_gb: 0 }) });
    return { agent, docker, removed };
  }
  async function launched(clock) {
    const f = fixture(clock);
    await f.agent.launch({ spec: spec("s7"), cpus: 2, mem_gb: 3 });
    const dir = join(f.agent.store.data?.sandboxes?.s7?.dir ?? "");
    return { ...f, dir };
  }

  it("serves the run log, the tail and the remaining log after destroy, then drops them after the grace period", async () => {
    const clock = { t: 1_000_000 };
    const { agent, removed } = await launched(clock);
    const rec = Object.values(agent.store.data.sandboxes)[0];
    mkdirSync(join(rec.dir, "out"), { recursive: true });
    writeFileSync(join(rec.dir, "out", "lane.log"), Array.from({ length: 300 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
    const live = await agent.evidence("s7");
    assert.match(live.run_log, /REMOTE_PROVISIONED/);
    assert.ok(!live.run_log.includes("other"), "only this issue's run log");
    assert.ok(live.tail.split("\n").filter(Boolean).length <= 201 && live.tail.includes("l300"));

    assert.equal(await agent.destroy("s7", "requested"), true);
    assert.ok(removed.length > 0);
    const after = await agent.evidence("s7");
    assert.match(after.run_log, /REMOTE_TOOLS_GENERIC/);
    assert.ok(after.tail.includes("l300"));
    const l = agent.graveLog("s7", 0);
    assert.ok(l.text.endsWith("l300\n"));
    assert.equal(agent.graveLog("s7", l.cursor).text, "");

    clock.t += 11 * 60 * 1000; // past keep_log_s (600)
    assert.equal(await agent.evidence("s7"), null);
    assert.equal(agent.graveLog("s7", 0), null);
  });
});

describe("router forwards log reads to the placing agent after destroy (#6117)", () => {
  it("GET /runlog after DELETE reaches the agent within the grace period, then 404", async () => {
    const clock = { t: 1_000_000 };
    const seen = [];
    const fetchFn = async (url, init = {}) => { seen.push(`${init.method ?? "GET"} ${new URL(url).pathname}`); return new Response(JSON.stringify({ run_log: RUN_LOG, tail: "" }), { status: 200 }); };
    const router = createRouter({ state_dir: tmpDir("rt-6117-"), token: "t", enroll_token: "e" }, { fetchFn, now: () => clock.t, log: { info() {}, warn() {}, error() {} } });
    router.store.data.agents.a1 = { url: "http://a1:7711", token: "x", enrolled: clock.t };
    router.store.data.sandboxes.s7 = { agent: "a1", issue: 7, batch: "b", createdAt: clock.t, touched: clock.t };
    const del = await router.forward("s7", "DELETE", "/sandboxes/s7");
    assert.equal(del.status, 200);
    const late = await router.forwardRead("s7", "/sandboxes/s7/runlog");
    assert.equal(late.status, 200);
    assert.ok(seen.at(-1).endsWith("/sandboxes/s7/runlog"));
    clock.t += 11 * 60 * 1000;
    assert.equal((await router.forwardRead("s7", "/sandboxes/s7/runlog")).status, 404);
  });
});

describe("probe PATH always has the system dirs (#6117)", () => {
  it("withSystemDirs appends only the missing dirs, after the pins", () => {
    assert.equal(withSystemDirs("/opt/x"), "/opt/x:/usr/local/bin:/usr/bin:/bin");
    assert.equal(withSystemDirs("/usr/bin:/opt/x"), "/usr/bin:/opt/x:/usr/local/bin:/bin");
    assert.equal(withSystemDirs("/opt/x", { platform: "win32" }), "/opt/x");
  });
  it("lane env PATH=/opt/x only: probing bash still finds it", async () => {
    const r = await runCheckCommand({ command: "command -v -- 'bash' >/dev/null 2>&1", cwd: tmpDir("p-"), env: { PATH: "/opt/x" } });
    assert.equal(r.rc, 0, r.output);
  });
  it("a tool pinned earlier on the PATH still wins", async () => {
    const bin = tmpDir("pin-"); writeFileSync(join(bin, "pinned-tool"), "#!/bin/sh\n", { mode: 0o755 });
    const r = await runCheckCommand({ command: "command -v pinned-tool", cwd: bin, env: { PATH: bin } });
    assert.equal(r.rc, 0);
    assert.match(r.output, new RegExp(bin));
  });
});
