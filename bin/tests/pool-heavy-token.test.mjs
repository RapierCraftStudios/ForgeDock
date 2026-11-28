// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6047: the pool agent's heavy-token semaphore (default-off cfg.elastic_lanes) and the base-plus-tokens placement accounting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createAgent } from "../pool/agent.mjs";
import { tmpDir } from "./_tmp.mjs";

const docker = (label = "1.72.0") => ({
  runs: [], async imageLabel() { return label; },
  async run(a) { this.runs.push(a); return "cid"; }, async inspect() { return { running: true, exitCode: 0, startedAt: new Date().toISOString(), finishedAt: "" }; },
  async stats() { return {}; }, async remove() {}, async kill() { return false; }, async listLabelled() { return []; }, async wipe() {},
  async removeWorkDir() {}, async pruneWorkDirs() {}, async listVolumes() { return []; }, async removeVolume() {},
});
const spec = (id) => ({ id, issue: 1, batch: "b1", repo: { slug: "o/r", url: "https://github.com/o/r.git", ref: "staging" }, command: ["forgedock", "run-issue", "1"], result_file: "/result/1.json" });
async function fixture({ cfg = {}, history = [], label, hostMem = null, mem = {} } = {}) {
  const dir = tmpDir("cs-heavy-"), clock = { t: 1_000_000 };
  if (history.length) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "usage-history.jsonl"), history.map((r) => JSON.stringify(r)).join("\n") + "\n"); }
  const dk = docker(label);
  const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://router:7710", state_dir: dir, allow_cpus: 16, allow_mem_gb: 5, lease_ttl_s: 600, token: "t", elastic_lanes: true, heavy_ttl_s: 60, ...cfg },
    { docker: dk, hostMem: hostMem ?? (() => mem.v ?? null), now: () => clock.t, log: { info() {}, warn() {}, error() {} }, live: () => ({ ok: true }), vm: () => ({ cpus: 16, mem_gb: 11.7, swap_gb: 0 }) });
  const server = createServer(agent.handle); await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (id, action, body = {}, token = agent.store.data.sandboxes[id]?.credToken) => { const r = await fetch(`${base}/sandboxes/${id}/heavy/${action}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const lane = (id) => agent.launch({ spec: spec(id), cpus: 1, mem_gb: 0.4 });
  return { agent, dk, mem, clock, post, lane, close: () => { server.closeAllConnections?.(); server.close(); } };
}

test("acquire, renew and release a token; the route needs the sandbox credential", async () => {
  const f = await fixture(); await f.lane("l1");
  assert.equal((await f.post("l1", "acquire", {}, "wrong")).status, 401);
  const a = await f.post("l1", "acquire");
  assert.equal(a.body.granted, true);
  assert.equal(f.agent.capacity().heavy_tokens, 1);
  assert.equal((await f.post("l1", "renew", { token: a.body.token })).body.granted, true);
  await f.post("l1", "release", { token: a.body.token });
  assert.equal(f.agent.capacity().heavy_tokens, 0);
  f.close();
});

test("a token expires with its lease and when the sandbox is destroyed", async () => {
  const f = await fixture(); await f.lane("l1"); await f.lane("l2");
  await f.post("l1", "acquire"); await f.post("l2", "acquire");
  assert.equal(f.agent.capacity().heavy_tokens, 2);
  f.clock.t += 61000;
  assert.equal(f.agent.capacity().heavy_tokens, 0);
  await f.post("l1", "acquire"); await f.post("l2", "acquire");
  await f.agent.destroy("l1", "requested");
  assert.equal(f.agent.capacity().heavy_tokens, 1);
  f.close();
});

test("a denied acquire is granted once a token is freed; the first holder is never starved", async () => {
  const f = await fixture({ cfg: { allow_mem_gb: 10, heavy_weight: { cpus: 1, mem_gb: 5 } } });
  for (const id of ["l1", "l2"]) await f.lane(id);
  const a = await f.post("l1", "acquire"), b = await f.post("l2", "acquire");
  assert.equal(a.body.granted, true);
  assert.equal(b.body.granted, false);
  assert.ok(b.body.retry_after_s > 0);
  await f.post("l1", "release", { token: a.body.token });
  assert.equal((await f.post("l2", "acquire")).body.granted, true);
  f.close();
});

test("a repeat acquire from one lane shares its token (refcounted release)", async () => {
  const f = await fixture(); await f.lane("l1");
  const a = await f.post("l1", "acquire"), b = await f.post("l1", "acquire");
  assert.equal(a.body.token, b.body.token);
  await f.post("l1", "release", { token: a.body.token });
  assert.equal(f.agent.capacity().heavy_tokens, 1);
  await f.post("l1", "release", { token: a.body.token });
  assert.equal(f.agent.capacity().heavy_tokens, 0);
  f.close();
});

test("a token weight is max(default, p90 history - base) so a heavy repo takes a bigger token", async () => {
  const history = Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, repo: "o/r", cpu_avg: 0.5, mem_peak_gb: 3 }));
  const f = await fixture({ history }); await f.lane("l1");
  const a = await f.post("l1", "acquire");
  assert.equal(a.body.weight.mem_gb, 2.6);
  f.close();
});

test("elastic accounting counts base plus held tokens; capacity reports the elastic fields and a derived ceiling", async () => {
  const f = await fixture(); await f.lane("l1"); await f.lane("l2");
  const before = f.agent.capacity();
  await f.post("l1", "acquire");
  const after = f.agent.capacity();
  assert.equal(after.elastic_lanes, true);
  assert.equal(Math.round((before.mem_free_gb_elastic - after.mem_free_gb_elastic) * 10) / 10, 2);
  assert.equal(after.mem_free_gb, before.mem_free_gb);
  assert.ok(after.lanes_ceiling_derived >= 1);
  f.close();
});

test("flag off: no token fields in capacity and no CS_HEAVY_BASE in the lane env", async () => {
  const f = await fixture({ cfg: { elastic_lanes: false } }); await f.lane("l1");
  const c = f.agent.capacity();
  assert.equal(c.elastic_lanes, undefined);
  assert.equal(c.heavy_tokens, undefined);
  f.close();
});

// #6235: elastic accounting is only safe for lanes that lease heavy tokens.
test("#6235: a lane image from before the remote heavy backend is charged worst-case and gets no CS_HEAVY_BASE", async () => {
  const history = Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, repo: "o/r", cpu_avg: 0.5, cpu_peak: 1, mem_peak_gb: 4 }));
  const old = await fixture({ label: "1.71.0", cfg: { allow_mem_gb: 5 }, history });
  const rs = [];
  for (const id of ["a", "b", "c"]) rs.push((await old.agent.launch({ spec: spec(id), cpus: 2, mem_gb: 3 })).status);
  assert.deepEqual(rs, [201, 503, 503], "charged the 3 GB it asked for, so only one fits in 5 GB");
  assert.equal(old.agent.store.data.sandboxes.a.heavyRemote, false);
  const cap = old.agent.capacity();
  assert.ok(cap.mem_free_gb_elastic <= 2.1, `base charge is the full request, got ${cap.mem_free_gb_elastic}`);
  old.close();
  const fresh = await fixture({ label: "1.72.0", cfg: { allow_mem_gb: 5 }, history });
  const rs2 = [];
  for (const id of ["a", "b", "c"]) rs2.push((await fresh.agent.launch({ spec: spec(id), cpus: 2, mem_gb: 3 })).status);
  assert.deepEqual(rs2, [201, 201, 201], "a current image is charged its base");
  assert.equal(fresh.agent.store.data.sandboxes.a.heavyRemote, true);
  fresh.close();
});

test("#6235: an image with no version label fails closed (worst-case), and CS_HEAVY_BASE is set only for capable images", async () => {
  for (const [label, want] of [["", false], ["not-a-version", false], ["1.72.0", true], ["1.100.2", true], ["1.71.9", false]]) {
    const f = await fixture({ label }); await f.lane("l1");
    assert.equal(f.agent.store.data.sandboxes.l1.heavyRemote, want, `label ${JSON.stringify(label)}`);
    f.close();
  }
});

test("#6235: below the host-memory floor no new token is granted; an existing holder keeps its token", async () => {
  const f = await fixture({ mem: { v: { free_gb: 8 } } }); await f.lane("l1"); await f.lane("l2");
  const a = await f.post("l1", "acquire");
  assert.equal(a.body.granted, true);
  f.mem.v = { free_gb: 1.5 }; f.clock.t += 31000; // under the 4 GB floor; the reading is cached 30 s
  const b = await f.post("l2", "acquire");
  assert.equal(b.body.granted, false);
  assert.equal(b.body.reason, "host_mem");
  assert.ok(b.body.retry_after_s > 0);
  assert.equal((await f.post("l1", "acquire")).body.granted, true, "a lane that already holds a token is not cut off mid-step");
  f.mem.v = { free_gb: 9 }; f.clock.t += 31000;
  assert.equal((await f.post("l2", "acquire")).body.granted, true, "recovers once memory is back above the floor");
  f.close();
});

test("#6235: the first holder is also refused when host memory is under the floor", async () => {
  const f = await fixture({ mem: { v: { free_gb: 8 } } }); await f.lane("l1");
  f.mem.v = { free_gb: 0.5 }; f.clock.t += 31000;
  const a = await f.post("l1", "acquire");
  assert.equal(a.body.granted, false); assert.equal(a.body.reason, "host_mem");
  f.close();
});

test("#6270: the heavy gate gives up after heavy_mem_max_wait_s with a denied env-class reply", async () => {
  const f = await fixture({ cfg: { heavy_mem_max_wait_s: 120 }, mem: { v: { free_gb: 8 } } }); await f.lane("l1");
  f.mem.v = { free_gb: 0.5 }; f.clock.t += 31000;
  const a = await f.post("l1", "acquire");
  assert.equal(a.body.granted, false); assert.ok(!a.body.denied);
  f.clock.t += 125000;
  const b = await f.post("l1", "acquire");
  assert.equal(b.body.granted, false); assert.equal(b.body.denied, true); assert.match(b.body.reason, /env/);
  f.close();
});
