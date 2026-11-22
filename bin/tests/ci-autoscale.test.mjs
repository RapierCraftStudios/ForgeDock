/**
 * bin/tests/ci-autoscale.test.mjs — CI runner autoscaler (#5695): pure admit/planScale and the router/agent wiring.
 * Run with: node --test bin/tests/ci-autoscale.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { admitRunner, planScale, runnerPriority, PRIORITY } from "../pool/ci-autoscale.mjs";
import { createRouter } from "../pool/router.mjs";
import { createAgent, netRx } from "../pool/agent.mjs";
import { tmpDir } from "./_tmp.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const FREE = { mem_available_gb: 8, load_per_cpu: 0.2, vcpus: 14, cpus_free: 10, mem_free_gb: 10 };
const LABELS = { "alterlab-ci": { min: 0, max: 4, size: { cpus: 1, mem_gb: 2 } }, "alterlab-deploy": { min: 0, max: 1, size: { cpus: 1, mem_gb: 2 } } };
const q = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: i + 1, ...extra }));

test("admit enforces the MemAvailable floor after the reservation", () => {
  assert.equal(admitRunner({ free: { ...FREE, mem_available_gb: 5 }, job: { label: "x" } }).admit, true);
  const v = admitRunner({ free: { ...FREE, mem_available_gb: 4.5 }, job: { label: "x" } });
  assert.equal(v.admit, false);
  assert.match(v.reason, /MemAvailable/);
  assert.equal(v.inputs.floors.mem_available_gb, 3);
  assert.equal(admitRunner({ free: { ...FREE, mem_available_gb: 8 }, reserved: { cpus: 0, mem_gb: 4 }, job: {} }).admit, false); // earlier admissions count
});

test("admit enforces the load floor (0.8 x vCPU) and the lane floor", () => {
  assert.equal(admitRunner({ free: { ...FREE, load_per_cpu: 0.79 }, job: {} }).admit, false);
  assert.equal(admitRunner({ free: { ...FREE, load_per_cpu: 0.7 }, job: {} }).admit, true);
  const lane = admitRunner({ free: { ...FREE, cpus_free: 2.5 }, job: {}, floors: { lane_cpus: 2 } });
  assert.equal(lane.admit, false);
  assert.match(lane.reason, /lane floor/);
  assert.equal(admitRunner({ free: { ...FREE, mem_free_gb: 4 }, job: { priority: PRIORITY.deploy }, floors: { lane_mem_gb: 3 } }).admit, false); // not even deploy starves a lane
});

test("admit refuses a saturated network except for deploy", () => {
  const floors = { net_rx_mbps_max: 2 }, net = { rx_mbps: 3 };
  assert.equal(admitRunner({ free: FREE, floors, net, job: { label: "alterlab-ci" } }).admit, false);
  assert.equal(admitRunner({ free: FREE, floors, net, job: { label: "alterlab-deploy" } }).admit, true);
  assert.equal(admitRunner({ free: FREE, floors, net: { rx_mbps: 1 }, job: {} }).admit, true);
  assert.deepEqual(admitRunner({ free: FREE, floors, net, job: {} }).inputs.net, net);
});

test("runnerPriority: deploy > release > lane > PR", () => {
  assert.equal(runnerPriority({ label: "alterlab-deploy" }), PRIORITY.deploy);
  assert.equal(runnerPriority({ label: "alterlab-ci", head_branch: "release/1.2" }), PRIORITY.release);
  assert.equal(runnerPriority({ label: "alterlab-ci", head_branch: "feat/x" }), PRIORITY.pr);
  assert.ok(PRIORITY.deploy < PRIORITY.release && PRIORITY.release < PRIORITY.lane && PRIORITY.lane < PRIORITY.pr);
});

test("planScale admits in priority order and stops when the floor is hit", () => {
  const demand = { "alterlab-ci": [{ id: 1 }, { id: 2, head_branch: "release/9" }], "alterlab-deploy": [{ id: 3 }] };
  const plan = planScale({ demand, labels: LABELS, free: { ...FREE, mem_available_gb: 8 }, floors: { mem_available_gb: 3 }, now: 1 });
  const acts = plan.filter((d) => d.action === "start" || (d.action === "hold" && d.admit === false));
  assert.deepEqual(acts.map((d) => [d.job, d.action]), [[3, "start"], [2, "start"], [1, "hold"]]); // 8 GB: two runners fit above the 3 GB floor
  assert.ok(acts.every((d) => d.inputs.free && d.inputs.floors), "every decision carries its inputs");
});

test("planScale honours per-label min (warm) and max", () => {
  const warm = planScale({ demand: {}, running: { "alterlab-ci": { total: 1, busy: 0 } }, labels: { "alterlab-ci": { min: 2, max: 4 } }, free: FREE });
  assert.equal(warm.filter((d) => d.action === "start").length, 1);
  const capped = planScale({ demand: { "alterlab-ci": q(10) }, running: { "alterlab-ci": { total: 3, busy: 3 } }, labels: LABELS, free: FREE });
  assert.equal(capped.filter((d) => d.action === "start").length, 1); // max 4
  const idle = planScale({ demand: {}, running: { "alterlab-ci": { total: 3, busy: 0 } }, labels: { "alterlab-ci": { min: 1, max: 4 } }, free: FREE });
  assert.equal(idle.find((d) => d.action === "stop").inputs.surplus, 2);
});

test("planScale does nothing inside a maintenance window and holds ordinary CI for a waiting lane", () => {
  const w = planScale({ demand: { "alterlab-ci": q(2) }, labels: LABELS, free: FREE, window: [{ from: 0, to: 100, why: "alterlab-72" }], now: 50 });
  assert.equal(w.some((d) => d.action === "start"), false);
  assert.match(w.find((d) => d.job).reason, /maintenance window: alterlab-72/);
  const l = planScale({ demand: { "alterlab-ci": q(1), "alterlab-deploy": q(1) }, labels: LABELS, free: FREE, lanes: { waiting: 1 } });
  assert.deepEqual(l.filter((d) => d.action === "start").map((d) => d.label), ["alterlab-deploy"]);
});

// ---- router wiring ----
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
function routerFixture(ci, { cap = {} } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? "GET", host: u.hostname, path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    if (u.hostname === "api.github.com") return json({ encoded_jit_config: "QUJD", workflow_runs: [] });
    if (u.pathname === "/capacity") return json({ cpus_total: 14, cpus_free: 12, mem_free_gb: 12, live: { mem_available_gb: 9, load_per_core: 0.1 }, vm: { cpus: 14 }, runners: [], ...cap });
    return json({ ok: true }, 201);
  };
  const router = createRouter({ state_dir: tmpDir("ci-as-"), enroll_token: "e", forgedock_token: "fd", ci_tokens: ["ci"], gh_bin: "true", repos: {}, ci_autoscale: ci }, { fetchFn, now: () => 5_000_000, log: quiet });
  router.store.data.agents.legion = { url: "http://legion:7711", token: "t" };
  return { router, calls };
}
const post = (router, url, body, token) => new Promise((resolve) => {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url, headers: token ? { authorization: `Bearer ${token}` } : {}, socket: {} });
  let data = "";
  router.handle(req, { writeHead(s) { this.s = s; }, setHeader() {}, write(x) { data += x; }, end(x) { data += x ?? ""; resolve({ status: this.s, body: data ? JSON.parse(data) : null }); } });
});
const wj = (id, status = "queued") => ({ action: status, workflow_job: { id, status, labels: ["self-hosted", "alterlab-ci"], head_branch: "feat/x" } });
const CFG = { enabled: true, labels: { "alterlab-ci": { min: 0, max: 3, size: { cpus: 1, mem_gb: 2 } } }, repo: "o/alterlab" };

test("POST /ci/workflow-job: ci token accepted, bad or missing token 401", async () => {
  const { router } = routerFixture(CFG);
  const ok = await post(router, "/ci/workflow-job", wj(1), "ci");
  assert.equal(ok.status, 202);
  assert.deepEqual([ok.body.enabled, ok.body.tracked, ok.body.label], [true, true, "alterlab-ci"]);
  assert.equal((await post(router, "/ci/workflow-job", wj(2), "nope")).status, 401);
  assert.equal((await post(router, "/ci/workflow-job", wj(2))).status, 401);
  assert.equal(router.autoscale().jobs.size, 1);
  await post(router, "/ci/workflow-job", wj(1, "completed"), "ci");
  assert.equal(router.autoscale().jobs.size, 0);
});

test("disabled by default: the webhook is ignored and no runner is requested", async () => {
  const { router, calls } = routerFixture(undefined);
  const r = await post(router, "/ci/workflow-job", wj(1), "ci");
  assert.deepEqual([r.status, r.body.enabled, r.body.tracked], [202, false, false]);
  await router.tick();
  assert.equal(calls.some((c) => c.path === "/runners" || c.host === "api.github.com"), false);
});

test("dry_run logs the decision with inputs and starts nothing", async () => {
  const { router, calls } = routerFixture({ ...CFG, dry_run: true });
  await post(router, "/ci/workflow-job", wj(1), "ci");
  const plan = await router.autoscale().reconcile();
  const d = plan.find((x) => x.action === "start");
  assert.ok(d && d.dry_run === true && d.inputs.free.mem_available_gb === 9);
  assert.equal(calls.some((c) => c.path === "/runners" || c.path.endsWith("/generate-jitconfig")), false); // the read-only jobs poll may run
  assert.equal(router.autoscale().decisions.length, plan.length);
});

test("enabled: a queued job gets an ephemeral runner request carrying a JIT config", async () => {
  const { router, calls } = routerFixture(CFG);
  await post(router, "/ci/workflow-job", wj(1), "ci");
  await post(router, "/ci/workflow-job", wj(2), "ci");
  await router.tick();
  const jit = calls.filter((c) => c.path === "/repos/o/alterlab/actions/runners/generate-jitconfig");
  const runners = calls.filter((c) => c.path === "/runners");
  assert.equal(jit.length, 2);
  assert.deepEqual(jit[0].body.labels, ["self-hosted", "alterlab-ci"]);
  assert.equal(runners.length, 2);
  assert.equal(runners[0].body.jitconfig, "QUJD");
  assert.equal(runners[0].body.label, "alterlab-ci");
});

test("a lane keeps its floor: no runner when free cpus are at the lane floor", async () => {
  const { router, calls } = routerFixture({ ...CFG, lane_floor: { cpus: 2, mem_gb: 3 } }, { cap: { cpus_free: 2 } });
  await post(router, "/ci/workflow-job", wj(1), "ci");
  const plan = await router.autoscale().reconcile();
  assert.match(plan.find((d) => d.admit === false).reason, /lane floor/);
  assert.equal(calls.some((c) => c.path === "/runners"), false);
});

// ---- agent wiring ----
function agentFixture(opts = {}) {
  const ran = [];
  const docker = { async run(a) { ran.push(a); return "id"; }, async remove() {}, async listLabelled() { return []; }, async inspect() { return {}; }, async listVolumes() { return []; } };
  const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://r:7710", state_dir: tmpDir("ci-as-agent-"), allow_cpus: 8, allow_mem_gb: 16, token: "t", ...opts }, { docker, now: () => 1_000_000, log: quiet, live: () => ({ ok: true }) });
  return { agent, ran };
}
const call = (agent, method, url, body) => new Promise((resolve) => {
  const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method, url, headers: { authorization: "Bearer t" }, socket: { remoteAddress: "127.0.0.1" } });
  let data = "";
  agent.handle(req, { writeHead(s) { this.s = s; }, setHeader() {}, write(x) { data += x; }, end(x) { data += x ?? ""; resolve({ status: this.s, body: data ? JSON.parse(data) : null }); } });
});

test("agent POST /runners: labelled, capped, jitconfig via env-file, counted in capacity", async () => {
  const { agent, ran } = agentFixture();
  const before = agent.capacity();
  const r = await call(agent, "POST", "/runners", { name: "ci-1", label: "alterlab-ci", jitconfig: "QUJD", cpus: 1, mem_gb: 2 });
  assert.equal(r.status, 201);
  const args = ran[0];
  assert.ok(args.includes("--rm") && args.includes("computeshare.runner=1") && args.includes("2048m"));
  assert.equal(args.includes("computeshare=1"), false, "the orphan reaper label is not set");
  assert.equal(args.some((a) => a.includes("QUJD")), false, "the JIT config is not on argv");
  const after = agent.capacity();
  assert.equal(after.mem_free_gb, before.mem_free_gb - 2);
  assert.equal(after.cpus_free, before.cpus_free - 1);
  assert.deepEqual(after.runners, [{ name: "ci-1", label: "alterlab-ci" }]);
  assert.equal((await call(agent, "POST", "/runners", { name: "../x", label: "l", jitconfig: "QUJD" })).status, 400);
  assert.equal((await call(agent, "DELETE", "/runners/ci-1")).status, 200);
  assert.equal(agent.capacity().mem_free_gb, before.mem_free_gb);
});

test("agent refuses a runner without capacity; netRx reports MB/s between samples", async () => {
  const { agent, ran } = agentFixture({ allow_mem_gb: 1 });
  assert.equal((await call(agent, "POST", "/runners", { name: "ci-1", label: "l", jitconfig: "QUJD", cpus: 1, mem_gb: 2 })).status, 503);
  assert.equal(ran.length, 0);
  const dev = (rx) => `h1\nh2\n  lo: 999 0\n eth0: ${rx} 0\n`;
  assert.equal(netRx(1000, () => dev(0)), null);
  assert.deepEqual(netRx(3000, () => dev(4_000_000)), { rx_mbps: 2 });
});
