// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5967: WSL host-memory admission. Neighbour VMs squeeze the lane VM invisibly; the agent reads Windows free RAM, refuses new
// sandboxes under host_mem_floor_gb (503 pool.host_mem), pauses the newest below half of it, and reports it in pool status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostMemFree } from "../pool/health.mjs";
import { createAgent, safeName } from "../pool/agent.mjs";
import { createRouter } from "../pool/router.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { poolFromCli } from "../engine-cli.mjs";
import { httpTransport } from "../lean/sandbox-remote.mjs";
import { tmpDir } from "./_tmp.mjs";

const WSL = () => "5.15.167.4-microsoft-standard-WSL2\n";
const NATIVE = () => "6.8.0-45-generic\n";
const PS = JSON.stringify({ free_kb: 3355443, vmmem: [{ name: "vmmemWSL", bytes: 8 * 1024 ** 3 }, { name: "vmmem", bytes: 2.5 * 1024 ** 3 }] });

test("hostMemFree parses FreePhysicalMemory (KB) and vmmem working sets (#5967)", () => {
  const calls = [];
  const r = hostMemFree({ osrelease: WSL, run: (cmd, args) => { calls.push([cmd, ...args].join(" ")); return PS; }, env: {} });
  assert.deepEqual(r, { free_gb: 3.2, vmmem: [{ name: "vmmemWSL", gb: 8 }, { name: "vmmem", gb: 2.5 }] });
  assert.match(calls[0], /powershell\.exe .*FreePhysicalMemory.*vmmem/);
  // PowerShell collapses a one-element array to an object; no vmmem at all is an empty list.
  assert.deepEqual(hostMemFree({ osrelease: WSL, run: () => JSON.stringify({ free_kb: 1048576, vmmem: { name: "vmmem", bytes: 1073741824 } }), env: {} }), { free_gb: 1, vmmem: [{ name: "vmmem", gb: 1 }] });
  assert.deepEqual(hostMemFree({ osrelease: WSL, run: () => JSON.stringify({ free_kb: 1048576, vmmem: null }), env: {} }), { free_gb: 1, vmmem: [] });
});

test("hostMemFree is null off WSL and on any error (#5967)", () => {
  let ran = false;
  assert.equal(hostMemFree({ osrelease: NATIVE, run: () => { ran = true; return PS; }, env: {} }), null);
  assert.equal(ran, false);
  assert.equal(hostMemFree({ osrelease: () => { throw new Error("no /proc"); } }), null);
  assert.equal(hostMemFree({ osrelease: WSL, run: () => null, env: {} }), null);
  assert.equal(hostMemFree({ osrelease: WSL, run: () => { throw new Error("interop"); }, env: {} }), null);
  assert.equal(hostMemFree({ osrelease: WSL, run: () => "not json", env: {} }), null);
  assert.equal(hostMemFree({ osrelease: WSL, run: () => JSON.stringify({ free_kb: "x" }), env: {} }), null);
});

function fakeDocker() {
  return {
    runs: [], paused: [], unpaused: [],
    async run(args) { this.runs.push(args); return "cid"; },
    async inspect() { return { running: true, exitCode: 0, startedAt: new Date().toISOString(), finishedAt: "" }; },
    async pause(n) { this.paused.push(n); }, async unpause(n) { this.unpaused.push(n); },
    async remove() {}, async kill() { return false; }, async listLabelled() { return []; }, async wipe() {},
    async removeWorkDir() {}, async pruneWorkDirs() {}, async listVolumes() { return []; }, async removeVolume() {},
  };
}
const quiet = { info() {}, warn() {}, error() {} };
const spec = (id) => ({ id, issue: 1, batch: "b1", repo: { slug: "o/r", url: "https://github.com/o/r.git", ref: "staging" }, command: ["forgedock", "run-issue", "1"], result_file: "/result/1.json" });
function agentFixture(hostMem, opts = {}) {
  const docker = fakeDocker();
  const dir = tmpDir("cs-mem-");
  const clock = { t: 1_000_000 };
  const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://router:7710", state_dir: dir, allow_cpus: 16, allow_mem_gb: 32, lease_ttl_s: 600, token: "t", ...opts }, { docker, now: () => clock.t, log: quiet, live: () => ({ ok: true }), vm: () => ({ cpus: 64, mem_gb: 256, swap_gb: 0 }), hostDisk: () => null, hostMem });
  return { agent, docker, dir, clock };
}

test("the probe is cached for 30 s (#5967)", () => {
  let n = 0;
  const { agent, clock } = agentFixture(() => ({ free_gb: 10 + n++, vmmem: [] }));
  assert.equal(agent.capacity().host_mem_free_gb, 10);
  clock.t += 29_000;
  assert.equal(agent.capacity().host_mem_free_gb, 10);
  clock.t += 1_000;
  assert.equal(agent.capacity().host_mem_free_gb, 11);
});

test("capacity carries host_mem_free_gb, the floor and vmmem; null probe adds nothing (#5967)", () => {
  const { agent } = agentFixture(() => ({ free_gb: 12.5, vmmem: [{ name: "vmmemWSL", gb: 8 }] }));
  const c = agent.capacity();
  assert.equal(c.host_mem_free_gb, 12.5);
  assert.equal(c.host_mem_low, false);
  assert.equal(c.host_mem_floor_gb, 4);
  assert.deepEqual(c.vmmem, [{ name: "vmmemWSL", gb: 8 }]);
  const none = agentFixture(() => null).agent.capacity();
  for (const k of ["host_mem_free_gb", "host_mem_low", "host_mem_floor_gb", "vmmem"]) assert.equal(k in none, false);
});

test("launch under the floor is 503 pool.host_mem and runs no docker (#5967)", async () => {
  const { agent, docker, dir } = agentFixture(() => ({ free_gb: 3.2, vmmem: [] }));
  const r = await agent.launch({ spec: spec("m1"), cpus: 2, mem_gb: 3 });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "pool.host_mem");
  assert.equal(r.body.reason, "host_mem");
  assert.equal(r.body.host_mem_free_gb, 3.2);
  assert.equal(r.body.floor_gb, 4);
  assert.equal(r.retryAfter, 60);
  assert.equal(docker.runs.length, 0);
  assert.equal(agent.store.data.sandboxes.m1, undefined);
  assert.equal(existsSync(join(dir, "sandboxes", safeName("m1"))), false);
  assert.equal((await agentFixture(() => ({ free_gb: 3.2 }), { host_mem_retry_after_s: 15 }).agent.launch({ spec: spec("m2"), cpus: 1, mem_gb: 1 })).retryAfter, 15);
});

test("launch at or above the floor, with a null or throwing probe, is admitted (#5967)", async () => {
  assert.equal((await agentFixture(() => ({ free_gb: 4, vmmem: [] })).agent.launch({ spec: spec("o1"), cpus: 2, mem_gb: 3 })).status, 201);
  assert.equal((await agentFixture(() => ({ free_gb: 3.5 }), { host_mem_floor_gb: 3 }).agent.launch({ spec: spec("o2"), cpus: 2, mem_gb: 3 })).status, 201);
  assert.equal((await agentFixture(() => null).agent.launch({ spec: spec("o3"), cpus: 2, mem_gb: 3 })).status, 201);
  assert.equal((await agentFixture(() => { throw new Error("interop hung"); }).agent.launch({ spec: spec("o4"), cpus: 2, mem_gb: 3 })).status, 201);
});

test("below half the floor the newest sandbox is paused, lease kept; recovery resumes it (#5967)", async () => {
  let free = 20;
  const { agent, docker, clock } = agentFixture(() => ({ free_gb: free, vmmem: [] }));
  for (const id of ["p1", "p2"]) { assert.equal((await agent.launch({ spec: spec(id), cpus: 1, mem_gb: 1 })).status, 201); clock.t += 1000; }
  await agent.reap();
  assert.deepEqual(docker.paused, []);
  free = 3; // under the floor (4) but not under half of it: only the gate acts
  clock.t += 31_000; await agent.reap();
  assert.deepEqual(docker.paused, []);
  free = 1.5;
  clock.t += 31_000; await agent.reap();
  assert.equal(docker.paused.length, 1);
  const rec = (id) => agent.store.data.sandboxes[id];
  assert.equal(rec("p2").state, "paused");
  assert.equal(rec("p2").memPaused, true);
  assert.equal(rec("p1").state, "running");
  assert.equal(agent.capacity().mem_paused, 1);
  clock.t += 31_000; await agent.reap(); // already one paused: no second pause, lease kept
  assert.equal(docker.paused.length, 1);
  assert.equal(rec("p2").lease, clock.t);
  free = 4.5; // above the floor but inside the resume margin: stays paused
  clock.t += 31_000; await agent.reap();
  assert.equal(docker.unpaused.length, 0);
  free = 6;
  clock.t += 31_000; await agent.reap();
  assert.equal(docker.unpaused.length, 1);
  assert.equal(rec("p2").state, "running");
  assert.equal(rec("p2").memPaused, false);
  assert.equal("mem_paused" in agent.capacity(), false);
});

test("a null probe never pauses anything (#5967)", async () => {
  const { agent, docker, clock } = agentFixture(() => null);
  await agent.launch({ spec: spec("n1"), cpus: 1, mem_gb: 1 });
  clock.t += 31_000; await agent.reap();
  assert.deepEqual(docker.paused, []);
});

function routerFixture(caps) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.hostname}${u.pathname}`);
    if (u.pathname === "/capacity") return new Response(JSON.stringify(caps[u.hostname]), { status: 200, headers: { "content-type": "application/json" } });
    const p = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: p.spec.id, state: "running" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const router = createRouter({ state_dir: tmpDir("cs-mem-router-"), lane: { cpus: 2, mem_gb: 3 }, enroll_token: "e", forgedock_token: "fd", repos: {} }, { fetchFn, now: () => 5_000_000, log: quiet });
  for (const name of Object.keys(caps)) router.store.data.agents[name] = { url: `http://${name}:7711`, token: "t" };
  return { router, calls };
}

test("router defers on pool.host_mem without posting, and the lane sees a retryable capacity error (#5967)", async () => {
  const { router, calls } = routerFixture({ legion: { cpus_free: 8, mem_free_gb: 16, host_mem_free_gb: 2, host_mem_low: true } });
  const r = await router.launch(spec("r1"));
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "pool.host_mem");
  assert.deepEqual(r.body.agents, ["legion"]);
  assert.equal(calls.some((c) => c.startsWith("POST ")), false);
  const t = httpTransport({ endpoint: "http://router:7710", fetchFn: async () => new Response(JSON.stringify(r.body), { status: r.status, headers: { "retry-after": String(r.retryAfter) } }) });
  await assert.rejects(t.launch(spec("r1")), (e) => e.retryable === true && e.status === 503);
});

test("router places on a host with memory and skips the low one; status reports memory (#5967)", async () => {
  const { router, calls } = routerFixture({ low: { cpus_free: 12, mem_free_gb: 24, host_mem_free_gb: 2, host_mem_low: true, vmmem: [{ name: "vmmem", gb: 9 }] }, ok: { cpus_free: 4, mem_free_gb: 8, host_mem_free_gb: 20, host_mem_low: false }, native: { cpus_free: 2, mem_free_gb: 4 } });
  const r = await router.launch(spec("r2"));
  assert.equal(r.body.agent, "ok");
  assert.equal(calls.includes("POST low/sandboxes"), false);
  const st = (await router.status()).agents;
  const by = Object.fromEntries(st.map((a) => [a.name, a]));
  assert.equal(by.low.host_mem_free_gb, 2);
  assert.deepEqual(by.low.vmmem, [{ name: "vmmem", gb: 9 }]);
  assert.equal(by.low.host_mem_low, true);
  assert.equal(by.ok.host_mem_free_gb, 20);
  assert.equal("host_mem_free_gb" in by.native, false);
});

test("pool status prints host_mem_free_gb, the other VMs and the warning, even without a disk figure (#5967)", async () => {
  const dir = tmpDir("pool-mem-cli-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "forgedock.token"), "FD\n");
  writeFileSync(join(dir, "enroll.token"), "EN\n");
  const config = join(dir, "router.json");
  writeFileSync(config, JSON.stringify({ listen: { host: "100.1.2.3", port: 7710 }, public_url: "http://100.1.2.3:7710", enroll_token_file: join(dir, "enroll.token") }));
  const agents = [{ name: "a1", host_mem_free_gb: 2.5, host_mem_low: true, vmmem: [{ name: "vmmemWSL", gb: 8 }, { name: "vmmem", gb: 2.5 }] }, { name: "a2", host_mem_free_gb: 20, host_mem_low: false }, { name: "a3" }];
  const err = [], error = console.error, log = console.log;
  console.error = (...a) => err.push(a.join(" ")); console.log = () => {};
  try { await poolFromCli(["status", "--config", config], { poolDeps: { call: async () => ({ ok: true, status: 200, data: { agents } }) } }); } finally { console.error = error; console.log = log; }
  const out = err.join("\n");
  assert.match(out, /a1: host_mem_free_gb 2\.5, other VMs: vmmemWSL 8 GB, vmmem 2\.5 GB WARNING: host memory below the floor/);
  assert.match(out, /a2: host_mem_free_gb 20$/m);
  assert.doesNotMatch(out, /a3/);
});
