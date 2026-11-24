// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5891: running sandboxes must not overcommit the WSL host drive: measured-disk admission, prune-then-pause-then-stop under
// pressure, dead-data reap that never touches cs-cache-*, and the growth rate / time-to-full report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../pool/agent.mjs";
import { createRouter } from "../pool/router.mjs";
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { httpTransport } from "../lean/sandbox-remote.mjs";
import { tmpDir } from "./_tmp.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const spec = (id, slug = "o/r") => ({ id, issue: 1, batch: "b1", repo: { slug, url: `https://github.com/${slug}.git`, ref: "staging" }, command: ["forgedock", "run-issue", "1"], result_file: "/result/1.json" });

function fixture(opts = {}) {
  const st = { t: 1_000_000, free: 200, exited: new Set() };
  const calls = [];
  const docker = {
    runs: [], calls, volumes: [],
    async run(args) { this.runs.push(args); return "cid"; },
    async inspect(n) { return st.exited.has(n) ? { running: false, exitCode: 1, startedAt: "", finishedAt: new Date(st.t).toISOString() } : { running: true, exitCode: 0, startedAt: new Date().toISOString(), finishedAt: "" }; },
    async remove(n) { calls.push(`rm ${n}`); }, async kill(n, sig) { calls.push(`kill ${n} ${sig}`); return true; }, async listLabelled() { return []; }, async wipe() {},
    async removeWorkDir(v, i, d) { calls.push(`rmwork ${d}`); }, async pruneWorkDirs() {},
    async listVolumes(prefix) { return this.volumes.filter((v) => v.startsWith(prefix)); }, async removeVolume(v) { calls.push(`rmvol ${v}`); },
    async pause(n) { calls.push(`pause ${n}`); }, async unpause(n) { calls.push(`unpause ${n}`); },
    async builderPrune() { calls.push("builderPrune"); if (st.pruneFrees) st.free += st.pruneFrees; }, async pruneImages() { calls.push("pruneImages"); }, async pruneCaches(n) { calls.push(`pruneCaches ${n}`); },
  };
  const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://router:7710", state_dir: tmpDir("cs-pressure-"), allow_cpus: 32, allow_mem_gb: 64, lease_ttl_s: 600, token: "t", host_disk_floor_gb: 25, ...opts },
    { docker, now: () => st.t, log: quiet, live: () => ({ ok: true }), hostDisk: () => ({ gb: st.free, path: "/mnt/c" }) });
  const go = async (...ids) => { for (const id of ids) assert.equal((await agent.launch({ spec: spec(id), cpus: 1, mem_gb: 1 })).status, 201, id); };
  return { agent, docker, st, calls, go, rec: (id) => agent.store.data.sandboxes[id] };
}

test("admission refuses when the repo's p90 reservations exceed host free minus the floor (#5891)", async () => {
  const f = fixture();
  f.agent.store.data.disk_hist = { "o/r": [8000, 9000, 10240, 10240, 10240, 10240, 10240, 10240, 10240, 10240] }; // p90 = 10 GB per lane
  f.st.free = 60;
  await f.go("a1", "a2", "a3"); // 60 - 10 x (n + 1) stays >= 25 for n = 0, 1, 2
  const runs = f.docker.runs.length;
  const r = await f.agent.launch({ spec: spec("a4"), cpus: 1, mem_gb: 1 }); // 60 - 40 = 20 < 25
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "pool.disk_low");
  assert.equal(f.docker.runs.length, runs);
  f.st.free = 400; // the gate reads the current figure
  assert.equal((await f.agent.launch({ spec: spec("a4"), cpus: 1, mem_gb: 1 })).status, 201);
});

test("below the floor pruning frees enough: nothing is paused or stopped (#5891)", async () => {
  const f = fixture({ min_host_disk_free_gb: 25 });
  await f.go("p1", "p2");
  f.st.free = 20; f.st.pruneFrees = 30;
  await f.agent.reap();
  assert.ok(f.calls.includes("builderPrune") && f.calls.includes("pruneImages"));
  assert.ok(f.calls.some((c) => c.startsWith("pruneCaches ")));
  assert.equal(f.calls.some((c) => c.startsWith("pause ") || c.startsWith("kill ")), false);
  assert.equal(f.rec("p1").state, "running");
  assert.equal(f.rec("p2").state, "running");
});

test("pruning not enough: the fastest grower is paused with its lease kept, then resumed on recovery (#5891)", async () => {
  const f = fixture();
  await f.go("s1", "s2", "s3");
  f.rec("s1").growthMbH = 100; f.rec("s2").growthMbH = 9000; f.rec("s3").growthMbH = 500;
  f.st.free = 20; // under the floor (25), above the hard floor (12.5)
  await f.agent.reap();
  assert.ok(f.calls.includes("builderPrune"));
  assert.ok(f.calls.includes("pause cs-s2"), f.calls.join(","));
  assert.equal(f.calls.filter((c) => c.startsWith("pause ")).length, 1);
  assert.equal(f.rec("s2").state, "paused");
  assert.equal(f.agent.capacity().disk_paused, 1);
  assert.equal(f.agent.capacity().host_disk_low, true); // admission stops while a lane is paused
  assert.equal((await f.agent.launch({ spec: spec("x1"), cpus: 1, mem_gb: 1 })).status, 503);
  f.st.t += 2000_000; // every other lease expires; the paused lane's does not
  await f.agent.reap();
  assert.ok(f.rec("s2"), "paused lane survives lease expiry");
  assert.equal(f.rec("s2").state, "paused");
  assert.equal(f.rec("s2").error, undefined);
  f.st.free = 40;
  await f.agent.reap();
  assert.ok(f.calls.some((c) => /^unpause cs-s2/.test(c)));
  assert.equal(f.rec("s2").state, "running");
  assert.equal(f.rec("s2").diskPaused, false);
});

test("below the hard floor the paused lane stops with sandbox.disk_pressure and its requeue resumes from the kept worktree (#5891)", async () => {
  const f = fixture();
  await f.go("h1", "h2");
  f.rec("h1").growthMbH = 5000;
  f.st.free = 10; // under floor / 2
  await f.agent.reap();
  const r = f.rec("h1");
  assert.ok(f.calls.some((c) => /^pause cs-h1/.test(c)));
  assert.ok(f.calls.some((c) => /^kill cs-h1 KILL/.test(c)));
  assert.equal(r.state, "exited");
  assert.equal(r.diskPressure, true);
  assert.equal(f.agent.store.data.sandboxes.h2.state, "running"); // the other lane is saved
  assert.equal(OUTCOME_CODES.SANDBOX_DISK_PRESSURE, "sandbox.disk_pressure");
  const v = (await f.agent.launch({ spec: spec("h1"), cpus: 1, mem_gb: 1 })); // refused: still under the floor, nothing destroyed
  assert.equal(v.status, 503);
  f.st.free = 300;
  assert.equal(f.calls.some((c) => c.startsWith("rmwork")), false, "the worktree is kept after the stop");
  const workDir = r.workDir;
  const again = await f.agent.launch({ spec: spec("h1"), cpus: 1, mem_gb: 1 });
  assert.equal(again.status, 201);
  assert.equal(f.calls.some((c) => c.startsWith("rmwork")), false, "the resumed lane adopts the kept worktree");
  assert.equal(f.rec("h1").workDir, workDir);
  assert.equal(f.rec("h1").diskPressure, undefined);
});

test("dead fdrsbx-* data is reaped within the TTL and cs-cache-* is never removed (#5891)", async () => {
  const f = fixture({ dead_ttl_s: 600 });
  f.docker.volumes = ["fdrsbx-gone-1-data", "fdrsbx-live-2-data", "cs-cache-o-r"];
  await f.go("fdrsbx-live-2");
  f.st.exited.add("cs-fdrsbx-live-2");
  await f.agent.reap(); // marks exited; younger than the TTL
  assert.equal(f.calls.includes("rm cs-fdrsbx-live-2"), false);
  f.st.t += 601_000;
  f.agent.store.data.sandboxes["fdrsbx-live-2"].lease = f.st.t;
  await f.agent.reap();
  assert.ok(f.calls.includes("rm cs-fdrsbx-live-2"), "exited container removed after the TTL");
  assert.ok(f.calls.includes("rmvol fdrsbx-gone-1-data"), "orphan fdrsbx volume removed");
  assert.equal(f.calls.includes("rmvol fdrsbx-live-2-data"), false, "a known sandbox's volume stays for its resume");
  assert.equal(f.calls.some((c) => c === "rmvol cs-cache-o-r"), false);
});

test("capacity reports host_disk_free_gb, its growth rate and time to full (#5891)", async () => {
  const f = fixture();
  f.st.free = 100;
  assert.equal(f.agent.capacity().host_disk_free_gb, 100);
  assert.equal("host_disk_growth_gb_per_h" in f.agent.capacity(), false);
  f.st.t += 3600_000; f.st.free = 80; // -20 GB in an hour
  const c = f.agent.capacity();
  assert.equal(c.host_disk_growth_gb_per_h, 20);
  assert.equal(c.host_disk_full_in_h, 4);
});

test("router status carries host drive free and growth, and warns under 2 h to full (#5891)", async () => {
  const caps = { legion: { cpus_free: 8, mem_free_gb: 16, host_disk_free_gb: 30, host_disk_growth_gb_per_h: 20, host_disk_full_in_h: 1.5 }, calm: { cpus_free: 8, mem_free_gb: 16, host_disk_free_gb: 300, host_disk_growth_gb_per_h: 1, host_disk_full_in_h: 300 } };
  const warns = [];
  const fetchFn = async (url) => new Response(JSON.stringify(caps[new URL(url).hostname]), { status: 200, headers: { "content-type": "application/json" } });
  const router = createRouter({ state_dir: tmpDir("cs-pressure-router-"), lane: { cpus: 2, mem_gb: 3 }, enroll_token: "e", forgedock_token: "fd", repos: {} }, { fetchFn, now: () => 5_000_000, log: { ...quiet, warn: (m) => warns.push(m) } });
  for (const name of Object.keys(caps)) router.store.data.agents[name] = { url: `http://${name}:7711`, token: "t" };
  const s = await router.status();
  const legion = s.agents.find((a) => a.name === "legion"), calm = s.agents.find((a) => a.name === "calm");
  assert.equal(legion.host_disk_free_gb, 30);
  assert.equal(legion.host_disk_growth_gb_per_h, 20);
  assert.match(legion.disk_warning, /full in ~1\.5 h/);
  assert.equal(calm.disk_warning, undefined);
  assert.equal(warns.filter((w) => /legion/.test(w)).length, 1);
});

test("the lane's remote provider settles a disk-pressure stop as a deferred sandbox.disk_pressure outcome, not a failure (#5891)", async () => {
  const f = fixture();
  await f.go("h1", "h2");
  f.rec("h1").growthMbH = 5000;
  f.st.free = 10;
  await f.agent.reap();
  assert.equal(f.rec("h1").state, "exited");
  const fetchFn = async (url) => { // the router forwards /sandboxes/:id/result to the agent; serve that agent route directly
    let body = "", status = 200;
    await f.agent.handle({ method: "GET", url: new URL(url).pathname, headers: { authorization: "Bearer t" }, socket: { remoteAddress: "127.0.0.1" } },
      { writeHead(s) { status = s; }, setHeader() {}, write(x) { body += x; }, end(x) { body += x ?? ""; } });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  };
  const t = httpTransport({ endpoint: "http://router:7710", token: "t", fetchFn });
  const r = await t.result("h1");
  assert.equal(r.terminalReason, "deferred");
  assert.equal(r.code, OUTCOME_CODES.SANDBOX_DISK_PRESSURE);
  assert.ok(r.retryInSeconds > 0);
});
