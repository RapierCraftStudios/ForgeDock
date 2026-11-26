// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6061: per-worker lane target (grow under headroom, halve on pressure, drain = accept none) and the router's handling of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { step, drainState } from "../pool/lane-target.mjs";
import { createAgent } from "../pool/agent.mjs";
import { createRouter } from "../pool/router.mjs";
import { tmpDir } from "./_tmp.mjs";

const GREEN = { load_per_core: 0.2, mem_available_gb: 20 };
const HOLD = 60_000;

test("step grows by one per hold window while headroom is green, never above the ceiling", () => {
  let s = { target: 1, greenSince: null }, t = 0;
  s = step({ ...s, ceiling: 3, live: GREEN, now: t });
  assert.equal(s.target, 1); // the window has only started
  s = step({ ...s, ceiling: 3, live: GREEN, now: (t += HOLD) });
  assert.deepEqual([s.target, s.change], [2, "grow"]);
  s = step({ ...s, ceiling: 3, live: GREEN, now: (t += HOLD - 1) });
  assert.equal(s.target, 2); // each step needs a fresh window
  s = step({ ...s, ceiling: 3, live: GREEN, now: (t += 1) });
  s = step({ ...s, ceiling: 3, live: GREEN, now: (t += HOLD) });
  assert.equal(s.target, 3);
  assert.equal(step({ ...s, ceiling: 3, live: GREEN, now: (t += HOLD) }).target, 3);
});

test("step halves (min 1) on high load or low memory, and a mid-band load neither grows nor halves", () => {
  assert.equal(step({ target: 8, ceiling: 8, live: { load_per_core: 1.8, mem_available_gb: 20 }, now: 0 }).target, 4);
  assert.equal(step({ target: 5, ceiling: 8, live: { load_per_core: 0.1, mem_available_gb: 3 }, now: 0 }).target, 2);
  assert.equal(step({ target: 1, ceiling: 8, live: { load_per_core: 3, mem_available_gb: 20 }, now: 0 }).target, 1);
  assert.equal(step({ target: 4, ceiling: 8, live: GREEN, refused: true, now: 0 }).target, 2);
  const mid = step({ target: 2, ceiling: 8, live: { load_per_core: 1.2, mem_available_gb: 20 }, now: 0, greenSince: 0 });
  assert.deepEqual([mid.target, mid.greenSince, mid.change], [2, null, null]);
  assert.equal(step({ target: 2, ceiling: 8, live: {}, now: HOLD * 9, greenSince: 0 }).target, 2); // unknown figures never grow
});

test("drainState: pause or sustained busy drains; a short busy spell does not", () => {
  assert.equal(drainState({}).draining, false);
  assert.equal(drainState({ busyForMs: 1000 }).draining, false);
  assert.equal(drainState({ busyForMs: 5 * 60_000 }).draining, true);
  assert.equal(drainState({ paused: true, ownerPaused: true }).reason, "paused by owner");
  assert.equal(drainState({ paused: true, policyPaused: true }).reason, "paused by policy");
});

const quiet = { info() {}, warn() {}, error() {} };
const spec = (id) => ({ id, issue: 1, batch: "b1", repo: { slug: "o/r", url: "https://github.com/o/r.git", ref: "staging" }, command: ["forgedock", "run-issue", "1"], result_file: "/result/1.json" });
function fakeDocker() {
  return { runs: [], async run(a) { this.runs.push(a); return "cid"; }, async inspect() { return { running: true, exitCode: 0, startedAt: new Date().toISOString(), finishedAt: "" }; },
    async pause() {}, async unpause() {}, async remove() {}, async kill() { return false; }, async listLabelled() { return []; }, async wipe() {}, async removeWorkDir() {}, async pruneWorkDirs() {}, async listVolumes() { return []; }, async removeVolume() {} };
}
function agentFixture(opts = {}) {
  const docker = fakeDocker(), clock = { t: 1_000_000 }, h = { ok: true, ...GREEN };
  const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://r:7710", state_dir: tmpDir("cs-lt-"), allow_cpus: 16, allow_mem_gb: 32, lease_ttl_s: 600, token: "t", ...opts },
    { docker, now: () => clock.t, log: quiet, live: () => h, vm: () => ({ cpus: 64, mem_gb: 256, swap_gb: 0 }), hostDisk: () => null, hostMem: () => null });
  return { agent, docker, clock, h };
}

test("agent: target grows per reap under headroom and a launch past it is refused 503 pool.lane_target", async () => {
  const { agent, clock } = agentFixture({ max_lanes: 3 });
  assert.equal(agent.capacity().lane_target, 1);
  assert.equal(agent.capacity().lane_ceiling, 3);
  assert.equal((await agent.launch({ spec: spec("l1"), cpus: 1, mem_gb: 1 })).status, 201);
  const r = await agent.launch({ spec: spec("l2"), cpus: 1, mem_gb: 1 });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "pool.lane_target");
  await agent.reap(); clock.t += 61_000; await agent.reap(); // starts the window, then it elapses
  assert.equal(agent.capacity().lane_target, 2);
  assert.equal((await agent.launch({ spec: spec("l2"), cpus: 1, mem_gb: 1 })).status, 201);
});

test("agent: pressure halves the target; sustained busy drains, refuses launches and keeps the running lane", async () => {
  const { agent, clock, h, docker } = agentFixture({ max_lanes: 4, lane_start: 4 });
  assert.equal((await agent.launch({ spec: spec("d1"), cpus: 1, mem_gb: 1 })).status, 201);
  Object.assign(h, { load_per_core: 2 });
  await agent.reap();
  assert.equal(agent.capacity().lane_target, 2);
  assert.equal(agent.capacity().draining, false);
  clock.t += 6 * 60_000; await agent.reap();
  const c = agent.capacity();
  assert.deepEqual([c.draining, c.accepting, c.active], [true, false, 1]);
  const r = await agent.launch({ spec: spec("d2"), cpus: 1, mem_gb: 1 });
  assert.deepEqual([r.status, r.body.code], [503, "pool.draining"]);
  assert.equal(agent.capacity().active, 1);
  assert.equal(docker.runs.length, 1);
  Object.assign(h, GREEN); await agent.reap();
  assert.equal(agent.capacity().draining, false);
});

const call = (agent, method, url) => new Promise((resolve) => agent.handle({ async *[Symbol.asyncIterator]() {}, method, url, headers: { authorization: "Bearer t" }, socket: { remoteAddress: "127.0.0.1" } }, { writeHead(s) { this.s = s; }, setHeader() {}, write() {}, end(x) { resolve(); } }));

test("agent: owner pause drains and refuses while the running lane persists; without max_lanes no target is reported or enforced", async () => {
  const { agent, docker } = agentFixture({ max_lanes: 2, lane_start: 2 });
  assert.equal((await agent.launch({ spec: spec("p1"), cpus: 1, mem_gb: 1 })).status, 201);
  await call(agent, "POST", "/pause");
  const c = agent.capacity();
  assert.deepEqual([c.draining, c.accepting, c.draining_reason, c.active], [true, false, "paused by owner", 1]);
  assert.equal((await agent.launch({ spec: spec("p2"), cpus: 1, mem_gb: 1 })).status, 503);
  assert.equal(docker.runs.length, 1);
  const plain = agentFixture();
  assert.equal("lane_target" in plain.agent.capacity(), false);
  for (const id of ["u1", "u2", "u3"]) assert.equal((await plain.agent.launch({ spec: spec(id), cpus: 1, mem_gb: 1 })).status, 201);
});

function routerFixture(caps, { agentsCfg = {} } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.hostname}${u.pathname}`);
    if (u.pathname === "/capacity") return caps[u.hostname] ? new Response(JSON.stringify(caps[u.hostname]), { status: 200, headers: { "content-type": "application/json" } }) : Promise.reject(new Error("gone"));
    const p = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: p.spec.id, state: "running" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const router = createRouter({ state_dir: tmpDir("cs-lt-router-"), lane: { cpus: 2, mem_gb: 3 }, enroll_token: "e", forgedock_token: "fd", repos: {}, agents: agentsCfg }, { fetchFn, now: () => 5_000_000, log: quiet });
  for (const name of Object.keys(caps)) router.store.data.agents[name] = { url: `http://${name}:7711`, token: "t" };
  return { router, calls, caps };
}
const cap = (x = {}) => ({ cpus_free: 8, mem_free_gb: 16, ...x });

test("router skips a draining agent and uses the lower of max_lanes and the reported lane_target", async () => {
  const { router, calls } = routerFixture({ drain: cap({ draining: true, accepting: false }), live: cap({ lane_target: 1, lane_ceiling: 5 }) });
  router.store.data.agents.live.max_lanes = 5;
  const r = await router.launch(spec("fdrsbx-1-a"));
  assert.equal(r.body.agent, "live");
  assert.equal(calls.some((c) => c.startsWith("POST drain")), false);
  assert.equal(router.store.data.agents.live.max_lanes, 5); // the configured ceiling is untouched
  const r2 = await router.launch(spec("fdrsbx-2-a")); // lane_target 1 is now used
  assert.equal(r2.status, 503);
  assert.equal(r2.body.code, "pool.host_lane_ceiling");
});

test("router: a vanished agent frees its pending slots and a newly enrolled agent gets the next placement", async () => {
  const { router, caps } = routerFixture({ old: cap({ lane_target: 1 }) });
  router.store.data.agents.old.max_lanes = 1;
  assert.equal((await router.launch(spec("fdrsbx-1-a"))).body.agent, "old");
  delete caps.old; // leaves mid-batch: stops answering
  const gone = await router.launch(spec("fdrsbx-2-a"));
  assert.equal(gone.status, 503);
  caps.fresh = cap(); router.store.data.agents.fresh = { url: "http://fresh:7711", token: "t" }; // joins mid-batch
  const joined = await router.launch(spec("fdrsbx-3-a"));
  assert.equal(joined.status, 201);
  assert.equal(joined.body.agent, "fresh");
});
