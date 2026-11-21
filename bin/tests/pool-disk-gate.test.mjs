// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5733: WSL host-disk admission. The lane disk is a vhdx on the Windows drive; the agent reports that drive's free space
// and refuses new sandboxes (503 pool.disk_low) before it fills, and the router defers instead of failing the lane.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostDiskFree } from "../pool/health.mjs";
import { createAgent, safeName } from "../pool/agent.mjs";
import { createRouter } from "../pool/router.mjs";
import { httpTransport } from "../lean/sandbox-remote.mjs";
import { tmpDir } from "./_tmp.mjs";

const WSL = () => "5.15.167.4-microsoft-standard-WSL2\n";
const NATIVE = () => "6.8.0-45-generic\n";
const GB = 1024 ** 3;
const fsWith = (byPath) => (p) => { if (!(p in byPath)) throw new Error(`ENOENT ${p}`); return { bavail: (byPath[p] * GB) / 4096, bsize: 4096 }; };
const REG = [
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{11111111-aaaa}",
  "    DistributionName    REG_SZ    Debian",
  "    BasePath    REG_SZ    C:\\Users\\me\\AppData\\Local\\Packages\\Debian\\LocalState",
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{22222222-bbbb}",
  "    BasePath    REG_EXPAND_SZ    \\\\?\\D:\\WSL\\Ubuntu",
  "    DistributionName    REG_SZ    Ubuntu",
  "",
].join("\r\n");

test("hostDiskFree resolves the drive backing the distro (#5733)", () => {
  const statfs = fsWith({ "/mnt/c": 25.8, "/mnt/d": 14, "/mnt/e": 300 });
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args].join(" ")); return REG; };
  assert.deepEqual(hostDiskFree({ osrelease: WSL, statfs, run, env: { WSL_DISTRO_NAME: "Ubuntu" } }), { gb: 14, path: "/mnt/d" });
  assert.match(calls[0], /reg\.exe query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss \/s$/);
  assert.deepEqual(hostDiskFree({ osrelease: WSL, statfs, run, env: { WSL_DISTRO_NAME: "Debian" } }), { gb: 25.8, path: "/mnt/c" });
  // An explicit host_disk_path wins; no BasePath match or a failing reg.exe falls back to /mnt/c.
  assert.deepEqual(hostDiskFree({ path: "/mnt/e", osrelease: WSL, statfs, run: () => { throw new Error("no reg"); }, env: {} }), { gb: 300, path: "/mnt/e" });
  assert.deepEqual(hostDiskFree({ osrelease: WSL, statfs, run, env: { WSL_DISTRO_NAME: "Other" } }), { gb: 25.8, path: "/mnt/c" });
  assert.deepEqual(hostDiskFree({ osrelease: WSL, statfs, run: () => null, env: {} }), { gb: 25.8, path: "/mnt/c" });
});

test("hostDiskFree is null on non-WSL hosts and when the drive cannot be read (#5733)", () => {
  let ran = false;
  assert.equal(hostDiskFree({ osrelease: NATIVE, statfs: () => { ran = true; return { bavail: 1, bsize: 1 }; }, run: () => { ran = true; return REG; }, env: {} }), null);
  assert.equal(ran, false);
  assert.equal(hostDiskFree({ osrelease: () => { throw new Error("no /proc"); } }), null);
  assert.equal(hostDiskFree({ osrelease: WSL, statfs: () => { throw new Error("EIO"); }, run: () => null, env: {} }), null);
});

function fakeDocker() {
  return {
    runs: [],
    async run(args) { this.runs.push(args); return "cid"; },
    async inspect() { return { running: true, exitCode: 0, startedAt: new Date().toISOString(), finishedAt: "" }; },
    async remove() {}, async kill() { return false; }, async listLabelled() { return []; }, async wipe() {},
    async removeWorkDir() {}, async pruneWorkDirs() {}, async listVolumes() { return []; }, async removeVolume() {},
  };
}
const quiet = { info() {}, warn() {}, error() {} };
const spec = (id) => ({ id, issue: 1, batch: "b1", repo: { slug: "o/r", url: "https://github.com/o/r.git", ref: "staging" }, command: ["forgedock", "run-issue", "1"], result_file: "/result/1.json" });
function agentFixture(hostDisk, opts = {}) {
  const docker = fakeDocker();
  const dir = tmpDir("cs-disk-");
  const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://router:7710", state_dir: dir, allow_cpus: 16, allow_mem_gb: 32, lease_ttl_s: 600, token: "t", ...opts }, { docker, now: () => 1_000_000, log: quiet, live: () => ({ ok: true }), hostDisk });
  return { agent, docker, dir };
}
async function health(agent) {
  let body = "";
  await agent.handle({ method: "GET", url: "/health", headers: { authorization: "Bearer t" }, socket: { remoteAddress: "127.0.0.1" } }, { writeHead() {}, setHeader() {}, write(x) { body += x; }, end(x) { body += x ?? ""; } });
  return JSON.parse(body);
}

test("agent /health carries host_disk_free_gb on WSL (#5733)", async () => {
  const { agent } = agentFixture(() => hostDiskFree({ osrelease: WSL, statfs: fsWith({ "/mnt/c": 120.4 }), run: () => null, env: {} }));
  const h = await health(agent);
  assert.equal(h.ok, true);
  assert.equal(h.host_disk_free_gb, 120.4);
  assert.equal(h.host_disk_low, false);
  assert.equal(typeof h.disk_free_gb, "number"); // #5535 field kept
  assert.equal(agent.capacity().host_disk_free_gb, 120.4);
});

test("non-WSL agent has no host disk field and no gate (#5733)", async () => {
  const { agent, docker } = agentFixture(() => hostDiskFree({ osrelease: NATIVE }));
  const h = await health(agent);
  assert.equal("host_disk_free_gb" in h, false);
  assert.equal("host_disk_low" in h, false);
  const r = await agent.launch({ spec: spec("n1"), cpus: 2, mem_gb: 3 });
  assert.equal(r.status, 201);
  assert.ok(docker.runs.length > 0);
});

test("agent refuses a launch with 503 pool.disk_low when host disk is under the floor and runs nothing (#5733)", async () => {
  const { agent, docker, dir } = agentFixture(() => ({ gb: 14, path: "/mnt/c" }));
  assert.equal(agent.capacity().host_disk_low, true);
  const r = await agent.launch({ spec: spec("d1"), cpus: 2, mem_gb: 3 });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "pool.disk_low");
  assert.equal(r.body.host_disk_free_gb, 14);
  assert.equal(r.body.floor_gb, 25);
  assert.equal(r.retryAfter, 300);
  assert.equal(docker.runs.length, 0);
  assert.equal(agent.store.data.sandboxes.d1, undefined);
  assert.equal(existsSync(join(dir, "sandboxes", safeName("d1"))), false);
});

test("projected per-sandbox growth crossing the floor refuses a launch (#5733)", async () => {
  let free = 40;
  const { agent, docker } = agentFixture(() => ({ gb: free, path: "/mnt/c" }), { min_host_disk_free_gb: 25, sandbox_disk_growth_gb: 3.5, disk_low_retry_after_s: 120 });
  // 40 - 3.5 x 1 >= 25, 40 - 3.5 x 2 >= 25 ... admitted until (active + 1) x 3.5 pushes below 25.
  for (const id of ["g1", "g2", "g3", "g4"]) assert.equal((await agent.launch({ spec: spec(id), cpus: 1, mem_gb: 1 })).status, 201, id);
  const runs = docker.runs.length;
  const r = await agent.launch({ spec: spec("g5"), cpus: 1, mem_gb: 1 }); // 40 - 3.5 x 5 = 22.5 < 25
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "pool.disk_low");
  assert.equal(r.retryAfter, 120);
  assert.equal(docker.runs.length, runs);
  assert.equal(agent.capacity().host_disk_low, true);
  free = 400; // the gate reads the current figure
  assert.equal((await agent.launch({ spec: spec("g5"), cpus: 1, mem_gb: 1 })).status, 201);
});

test("agent launch is admitted when the host disk is unknown (#5733)", async () => {
  const { agent } = agentFixture(() => null);
  assert.equal("host_disk_free_gb" in agent.capacity(), false);
  assert.equal((await agent.launch({ spec: spec("u1"), cpus: 2, mem_gb: 3 })).status, 201);
  const thrower = agentFixture(() => { throw new Error("reg.exe hung"); });
  assert.equal((await thrower.agent.launch({ spec: spec("u2"), cpus: 2, mem_gb: 3 })).status, 201);
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
  const router = createRouter({ state_dir: tmpDir("cs-disk-router-"), lane: { cpus: 2, mem_gb: 3 }, enroll_token: "e", forgedock_token: "fd", repos: {} }, { fetchFn, now: () => 5_000_000, log: quiet });
  for (const name of Object.keys(caps)) router.store.data.agents[name] = { url: `http://${name}:7711`, token: "t" };
  return { router, calls };
}

test("router defers on pool.disk_low without posting to a disk-low agent (#5733)", async () => {
  const { router, calls } = routerFixture({ legion: { cpus_free: 8, mem_free_gb: 16, host_disk_free_gb: 14, host_disk_low: true } });
  const r = await router.launch(spec("r1"));
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "pool.disk_low");
  assert.deepEqual(r.body.agents, ["legion"]);
  assert.equal(r.retryAfter, 300);
  assert.equal(calls.some((c) => c.startsWith("POST ")), false);
  assert.equal(router.store.data.sandboxes.r1, undefined);
  // The lane transport turns that answer into a retryable capacity error (deferred SANDBOX_CAPACITY), not a failure.
  const t = httpTransport({ endpoint: "http://router:7710", fetchFn: async () => new Response(JSON.stringify(r.body), { status: r.status, headers: { "retry-after": String(r.retryAfter) } }) });
  await assert.rejects(t.launch(spec("r1")), (e) => e.retryable === true && e.retryInSeconds === 300 && e.status === 503);
});

test("router places on a host with disk headroom and skips the disk-low one (#5733)", async () => {
  const { router, calls } = routerFixture({ low: { cpus_free: 12, mem_free_gb: 24, host_disk_low: true }, ok: { cpus_free: 4, mem_free_gb: 8, host_disk_low: false }, native: { cpus_free: 2, mem_free_gb: 4 } });
  const r = await router.launch(spec("r2"));
  assert.equal(r.status, 201);
  assert.equal(r.body.agent, "ok");
  assert.equal(calls.includes("POST low/sandboxes"), false);
});
