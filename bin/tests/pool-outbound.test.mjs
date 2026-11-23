import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../pool/router.mjs";
import { startPoll } from "../pool/agent.mjs";

const quiet = { info() {}, warn() {}, error() {} };
function mkRouter(extra = {}) {
  const cfg = { state_dir: mkdtempSync(join(tmpdir(), "pool-outbound-")), enroll_token: "enroll-secret", forgedock_token: "fd", repos: {}, ...extra };
  return createRouter(cfg, { log: quiet });
}
const req = (token, method = "GET", path = "/") => ({ method, url: path, headers: { authorization: `Bearer ${token}` }, socket: {} });
/** Drive router.handle with an in-memory request/response. */
async function hit(router, token, method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const r = Object.assign(req(token, method, path), { [Symbol.asyncIterator]: async function* () { yield* chunks; } });
  return new Promise((resolve) => {
    const res = { writeHead(status) { this.status = status; }, end(text) { let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; } resolve({ status: this.status, data }); } };
    router.handle(r, res);
  });
}
const enrollPoll = (router, name = "natbox") => router.enroll({ token: "enroll-secret", name }).body.agent_token;
const fdCall = (router, method, path, body) => hit(router, "fd", method, path, body);

describe("outbound-only agent connection (#5882)", () => {
  it("enrolls without a url as a poll agent; a bad url is still rejected", () => {
    const router = mkRouter();
    const ok = router.enroll({ token: "enroll-secret", name: "natbox" });
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(router.store.data.agents.natbox).sort(), ["enrolledAt", "name", "token", "transport"]);
    assert.equal(router.store.data.agents.natbox.transport, "poll");
    assert.equal(router.enroll({ token: "enroll-secret", name: "x", url: "not a url" }).status, 400);
    assert.equal(router.enroll({ token: "wrong", name: "y" }).status, 401);
  });

  it("poll requires an agent token", async () => {
    const router = mkRouter();
    assert.equal((await hit(router, "nope", "GET", "/agent/poll?wait=0")).status, 401);
    assert.equal((await hit(router, "nope", "POST", "/agent/reply/abc", {})).status, 401);
  });

  it("delivers a router call over the poll and returns the agent's reply, with no agent listener", async () => {
    const router = mkRouter();
    const token = enrollPoll(router);
    const seen = [];
    // The agent: real startPoll against the real router handler; dispatch stands in for the agent's local API.
    const fetchFn = async (url, init) => {
      const u = new URL(url), r = await hit(router, token, init.method, u.pathname + u.search, init.body ? JSON.parse(init.body) : undefined);
      return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => (r.data === null ? "" : JSON.stringify(r.data)), headers: { get: () => null } };
    };
    const dispatch = async (method, path, body) => { seen.push({ method, path, body }); return path === "/capacity" ? { status: 200, data: { cpus_free: 4 } } : { status: 404, data: { state: "gone" } }; };
    const poll = startPoll({ router_url: "http://router", token, listen: { port: 1 } }, { fetchFn, dispatch, waitS: 1, log: quiet });
    try {
      const caps = await router.capacities();
      assert.deepEqual(caps.map((c) => ({ name: c.name, ok: c.ok, transport: c.transport, cpus_free: c.cpus_free })), [{ name: "natbox", ok: true, transport: "poll", cpus_free: 4 }]);
      assert.deepEqual(seen[0], { method: "GET", path: "/capacity", body: undefined });
      const st = await router.status();
      assert.equal(st.online, 1);
      const gone = await fdCall(router, "GET", "/sandboxes/nope");
      assert.equal(gone.status, 404);
    } finally { poll.stop(); }
  });

  it("an agent that never polled is offline and calls fail fast", async () => {
    const router = mkRouter();
    enrollPoll(router);
    const caps = await router.capacities();
    assert.equal(caps[0].ok, false);
    assert.match(caps[0].error, /offline/);
    assert.equal((await router.status()).online, 0);
  });

  it("a stale agent goes offline after poll_offline_s", async () => {
    let t = 1000;
    const cfg = { state_dir: mkdtempSync(join(tmpdir(), "pool-outbound-")), enroll_token: "e", forgedock_token: "fd", repos: {}, poll_offline_s: 10 };
    const router = createRouter(cfg, { log: quiet, now: () => t });
    const token = router.enroll({ token: "e", name: "a" }).body.agent_token;
    assert.equal((await hit(router, token, "GET", "/agent/poll?wait=0")).status, 204);
    t += 5000;
    t += 20000;
    assert.match((await router.capacities())[0].error, /offline/);
  });

  it("reply for an unknown request, or another agent's request, is 404", async () => {
    const router = mkRouter();
    const a = enrollPoll(router, "a"), b = enrollPoll(router, "b");
    assert.equal((await hit(router, a, "POST", "/agent/reply/deadbeef", { status: 200 })).status, 404);
    await hit(router, a, "GET", "/agent/poll?wait=0");
    await hit(router, b, "GET", "/agent/poll?wait=0");
    const pending = router.capacities();
    const item = (await hit(router, a, "GET", "/agent/poll?wait=0")).data;
    assert.ok(item?.rid);
    assert.equal((await hit(router, b, "POST", `/agent/reply/${item.rid}`, { status: 200, data: {} })).status, 404);
    assert.equal((await hit(router, a, "POST", `/agent/reply/${item.rid}`, { status: 200, data: { cpus_free: 1 } })).status, 200);
    const bItem = (await hit(router, b, "GET", "/agent/poll?wait=0")).data;
    await hit(router, b, "POST", `/agent/reply/${bItem.rid}`, { status: 200, data: {} });
    assert.equal((await pending).every((c) => c.ok), true);
  });

  it("direct-url agents are still dialed over HTTP", async () => {
    const calls = [];
    const fetchFn = async (url, init) => { calls.push(`${init.method} ${url}`); return { status: 200, ok: true, text: async () => JSON.stringify({ cpus_free: 2 }), headers: { get: () => null } }; };
    const router = createRouter({ state_dir: mkdtempSync(join(tmpdir(), "pool-outbound-")), enroll_token: "e", forgedock_token: "fd", repos: {} }, { log: quiet, fetchFn });
    assert.equal(router.enroll({ token: "e", name: "d", url: "http://10.0.0.5:7711" }).status, 200);
    const caps = await router.capacities();
    assert.equal(caps[0].ok, true);
    assert.deepEqual(calls, ["GET http://10.0.0.5:7711/capacity"]);
  });

  it("startPoll rejects an unsafe polled path without dispatching it", async () => {
    const replies = [];
    let n = 0;
    const fetchFn = async (url, init) => {
      const u = new URL(url);
      if (u.pathname === "/agent/poll") return n++ ? await new Promise((r) => setTimeout(() => r({ status: 204, ok: true, text: async () => "", headers: { get: () => null } }), 5)) : { status: 200, ok: true, text: async () => JSON.stringify({ rid: "r1", method: "GET", path: "//evil.example/x" }), headers: { get: () => null } };
      replies.push(JSON.parse(init.body));
      return { status: 200, ok: true, text: async () => "{}", headers: { get: () => null } };
    };
    let dispatched = 0;
    const poll = startPoll({ router_url: "http://router", token: "t", listen: { port: 1 } }, { fetchFn, dispatch: async () => { dispatched++; return { status: 200 }; }, waitS: 1, log: quiet, sleep: () => new Promise((r) => setTimeout(r, 5)) });
    for (let i = 0; i < 200 && !replies.length; i++) await new Promise((r) => setTimeout(r, 10));
    poll.stop();
    assert.equal(dispatched, 0);
    assert.equal(replies[0].status, 400);
  });
});
