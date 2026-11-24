import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./_tmp.mjs";
import { createRouter } from "../pool/router.mjs";
import { statusTable } from "../pool/cli.mjs";

const quiet = { info() {}, warn() {}, error() {} };
let clock = 1_000_000;
function mkRouter(extra = {}, fetchFn) {
  const cfg = { state_dir: tmpDir("pool-device-"), enroll_token: "enroll-secret", forgedock_token: "fd", repos: {}, ...extra };
  return createRouter(cfg, { log: quiet, now: () => clock, ...(fetchFn ? { fetchFn } : {}) });
}
async function hit(router, token, method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const r = { method, url: path, headers: token ? { authorization: `Bearer ${token}` } : {}, socket: {}, [Symbol.asyncIterator]: async function* () { yield* chunks; } };
  return new Promise((resolve) => {
    const res = { writeHead(status) { this.status = status; }, end(text) { let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; } resolve({ status: this.status, data }); } };
    router.handle(r, res);
  });
}
const fd = (router, m, p, b) => hit(router, "fd", m, p, b);
async function login(router, account, name) {
  const d = (await hit(router, null, "POST", "/device/code", {})).data;
  assert.equal((await fd(router, "POST", "/device/approve", { user_code: d.user_code, account })).status, 200);
  clock += 6000;
  const t = await hit(router, null, "POST", "/device/token", { device_code: d.device_code });
  assert.equal(t.status, 200);
  return router.enroll({ token: t.data.enroll_code, name });
}

describe("device-code login (#5886)", () => {
  it("pending -> approved -> enrolled with the account stamped; the code is single use", async () => {
    const router = mkRouter();
    const d = (await hit(router, null, "POST", "/device/code", {})).data;
    assert.match(d.user_code, /^[0-9A-F]{4}-[0-9A-F]{6}$/);
    clock += 6000;
    const pending = await hit(router, null, "POST", "/device/token", { device_code: d.device_code });
    assert.deepEqual([pending.status, pending.data.error], [400, "authorization_pending"]);
    assert.equal((await hit(router, null, "POST", "/device/approve", { user_code: d.user_code })).status, 401);
    assert.equal((await fd(router, "POST", "/device/approve", { user_code: d.user_code, account: "acme" })).status, 200);
    clock += 6000;
    const ok = await hit(router, null, "POST", "/device/token", { device_code: d.device_code });
    assert.equal(ok.data.account, "acme");
    const e = router.enroll({ token: ok.data.enroll_code, name: "box1" });
    assert.equal(e.status, 200);
    assert.equal(router.store.data.agents.box1.account, "acme");
    assert.equal(router.enroll({ token: ok.data.enroll_code, name: "box2" }).status, 401);
    clock += 6000;
    assert.equal((await hit(router, null, "POST", "/device/token", { device_code: d.device_code })).data.error, "expired_token");
  });

  it("refuses expired and unknown codes, and an invalid account label", async () => {
    const router = mkRouter({ device_ttl_s: 60 });
    const d = (await hit(router, null, "POST", "/device/code", {})).data;
    assert.equal((await fd(router, "POST", "/device/approve", { user_code: d.user_code, account: "bad account!" })).status, 400);
    assert.equal((await fd(router, "POST", "/device/approve", { user_code: "NOPE-000000" })).status, 404);
    clock += 61000;
    assert.equal((await fd(router, "POST", "/device/approve", { user_code: d.user_code })).status, 404);
    assert.equal((await hit(router, null, "POST", "/device/token", { device_code: d.device_code })).data.error, "expired_token");
    assert.equal((await hit(router, null, "POST", "/device/token", { device_code: "__proto__" })).data.error, "expired_token");
  });

  it("slow_down on fast polling, and /device/code is rate limited", async () => {
    const router = mkRouter({ device_codes_per_min: 3 });
    const d = (await hit(router, null, "POST", "/device/code", {})).data;
    await hit(router, null, "POST", "/device/token", { device_code: d.device_code });
    const fast = await hit(router, null, "POST", "/device/token", { device_code: d.device_code });
    assert.equal(fast.data.error, "slow_down");
    assert.ok(fast.data.interval > 5);
    await hit(router, null, "POST", "/device/code", {}); await hit(router, null, "POST", "/device/code", {});
    assert.equal((await hit(router, null, "POST", "/device/code", {})).status, 429);
  });

  it("legacy enroll token and one-time codes still enroll, with no account field", async () => {
    const router = mkRouter();
    assert.equal(router.enroll({ token: "enroll-secret", name: "old" }).status, 200);
    const { code } = router.issueCode();
    assert.equal(router.enroll({ token: code, name: "old2" }).status, 200);
    assert.deepEqual(Object.keys(router.store.data.agents.old2).sort(), ["enrolledAt", "name", "token", "transport"]);
    assert.equal(router.enroll({ token: code, name: "old3" }).status, 401);
  });
});

describe("account view, policy and placement (#5886)", () => {
  /** Two accounts' url agents plus one legacy agent, each answering /capacity and recording calls. */
  async function setup() {
    const calls = [];
    const fetchFn = async (url, init) => {
      const u = new URL(url), body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ host: u.hostname, method: init.method, path: u.pathname, body });
      const data = u.pathname === "/capacity" ? { cpus_free: 8, mem_free_gb: 16, paused: false } : u.pathname === "/sandboxes" ? { ok: true } : { ok: true };
      return { status: 200, ok: true, text: async () => JSON.stringify(data), headers: { get: () => null } };
    };
    const router = mkRouter({}, fetchFn);
    for (const [name, account] of [["a1", "acme"], ["b1", "beta"]]) {
      const e = await login(router, account, name);
      router.store.data.agents[name].url = `http://${name}.test`; delete router.store.data.agents[name].transport; assert.equal(e.status, 200);
    }
    router.enroll({ token: "enroll-secret", name: "legacy", url: "http://legacy.test" });
    return { router, calls };
  }

  it("GET /agents?account= filters, includes account, and leaves legacy records untouched", async () => {
    const { router } = await setup();
    const all = (await fd(router, "GET", "/agents")).data.agents;
    assert.deepEqual(all.map((a) => [a.name, a.account]), [["a1", "acme"], ["b1", "beta"], ["legacy", undefined]]);
    assert.ok(!("account" in all[2]) && !("policy" in all[2]));
    const mine = (await fd(router, "GET", "/agents?account=acme")).data.agents;
    assert.deepEqual(mine.map((a) => a.name), ["a1"]);
    assert.match(statusTable(all).split("\n")[0], /ACCOUNT/);
    assert.doesNotMatch(statusTable([all[2]]).split("\n")[0], /ACCOUNT/);
  });

  it("validates policy keys, stores the policy and pushes it to the agent", async () => {
    const { router, calls } = await setup();
    for (const bad of [{ evil: 1 }, { cpus: 0 }, { cpus: "4" }, { idle_only: "yes" }, { floors: { other: 1 } }, []]) assert.equal((await fd(router, "PUT", "/agents/a1/policy", bad)).status, 400, JSON.stringify(bad));
    assert.equal((await fd(router, "PUT", "/agents/nope/policy", { cpus: 2 })).status, 404);
    assert.equal((await hit(router, null, "PUT", "/agents/a1/policy", { cpus: 2 })).status, 401);
    const r = await fd(router, "PUT", "/agents/a1/policy", { cpus: 2, mem_gb: 4, idle_only: true, paused: true, floors: { host_disk_gb: 30 } });
    assert.deepEqual([r.status, r.data.pushed], [200, true]);
    const push = calls.find((c) => c.path === "/admin/policy");
    assert.deepEqual([push.host, push.body.cpus, push.body.floors.host_disk_gb, push.body.paused], ["a1.test", 2, 30, true]);
    assert.equal(router.store.data.agents.a1.policy.idle_only, true);
    assert.equal((await fd(router, "GET", "/agents?account=acme")).data.agents[0].policy.cpus, 2);
  });

  it("places a lane with spec.account only on that account's agents; without it, on any", async () => {
    const { router, calls } = await setup();
    const placed = [];
    for (const account of ["beta", "acme"]) {
      const r = await router.launch({ id: `lane-${account}`, account, repo: { slug: "o/r" } });
      placed.push(r.body.agent);
    }
    assert.deepEqual(placed, ["b1", "a1"]);
    const none = await router.launch({ id: "lane-x", account: "ghost", repo: { slug: "o/r" } });
    assert.equal(none.status, 503);
    assert.equal((await router.launch({ id: "lane-any", repo: { slug: "o/r" } })).status, 200);
    assert.ok(calls.some((c) => c.method === "POST" && c.path === "/sandboxes"));
  });
});

describe("agent applies a router-pushed policy (#5886)", () => {
  const docker = { async stats() { return {}; }, async listLabelled() { return []; }, async remove() {}, async kill() { return false; }, async wipe() {}, async removeWorkDir() {}, async pruneWorkDirs() {}, async listVolumes() { return []; }, async removeVolume() {} };
  const call = (agent, method, path, body) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const r = { method, url: path, headers: { authorization: "Bearer t" }, socket: {}, [Symbol.asyncIterator]: async function* () { yield* chunks; } };
    return new Promise((resolve) => agent.handle(r, { writeHead(s) { this.status = s; }, end(text) { resolve({ status: this.status, data: text ? JSON.parse(text) : null }); } }));
  };
  it("sets cpus, mem, idle_only, floors and policy pause; the owner pause is never cleared by it", async () => {
    const { createAgent } = await import("../pool/agent.mjs");
    const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://router:7710", state_dir: tmpDir("pool-device-agent-"), allow_cpus: 4, allow_mem_gb: 8, token: "t" }, { docker, log: quiet, vm: () => ({ cpus: 16, mem_gb: 32, swap_gb: 0 }) });
    assert.equal((await call(agent, "POST", "/pause")).status, 200);
    assert.equal((await call(agent, "POST", "/admin/policy", { evil: 1, cpus: 0 })).status, 400);
    const r = await call(agent, "POST", "/admin/policy", { cpus: 2, mem_gb: 3, idle_only: true, paused: false, floors: { host_disk_gb: 40 } });
    assert.equal(r.status, 200);
    assert.equal(r.data.owner_paused, true);
    assert.equal(r.data.paused, true); // the router's paused:false did not clear the owner pause
    const cap = agent.capacity();
    assert.deepEqual([cap.configured.cpus, cap.configured.mem_gb, cap.idle_only, cap.owner_paused], [2, 3, true, true]);
    await call(agent, "POST", "/resume");
    assert.equal((await call(agent, "POST", "/admin/policy", { paused: true })).data.paused, true);
    assert.equal((await call(agent, "POST", "/admin/policy", { paused: false })).data.paused, false);
  });
});
