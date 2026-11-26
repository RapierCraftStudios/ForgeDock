// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5858: pool agent admission is clamped to the VM, sized from measured usage, and counts co-tenant containers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createAgent } from "../pool/agent.mjs";
import { tmpDir } from "./_tmp.mjs";

function fakeDocker(others = {}) {
  return {
    runs: [], others,
    async run(args) { this.runs.push(args); return "cid"; },
    async inspect() { return { running: true, exitCode: 0, startedAt: new Date().toISOString(), finishedAt: "" }; },
    async stats(label) { return Array.isArray(label) && label.length === 0 ? this.others : {}; },
    async remove() {}, async kill() { return false; }, async listLabelled() { return []; }, async wipe() {},
    async removeWorkDir() {}, async pruneWorkDirs() {}, async listVolumes() { return []; }, async removeVolume() {},
  };
}
const spec = (id) => ({ id, issue: 1, batch: "b1", repo: { slug: "o/r", url: "https://github.com/o/r.git", ref: "staging" }, command: ["forgedock", "run-issue", "1"], result_file: "/result/1.json" });
// Recorded usage: median cpu_avg 0.5, peaks up to 5 cpus, mem_peak up to 0.7 GB.
const rows = [0.3, 0.4, 0.5, 0.5, 0.5, 0.6, 0.7].map((m, i) => ({ id: `h${i}`, repo: "o/r", cpu_avg: 0.5, cpu_peak: i === 6 ? 5 : 1.5, mem_peak_gb: m }));
function fixture({ vm = { cpus: 16, mem_gb: 11.7, swap_gb: 0 }, cfg = {}, history = [], others = {} } = {}) {
  const dir = tmpDir("cs-adm-");
  if (history.length) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "usage-history.jsonl"), history.map((r) => JSON.stringify(r)).join("\n") + "\n"); }
  const warns = [], docker = fakeDocker(others);
  const log = { info() {}, warn: (m) => warns.push(m), error() {} };
  const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://router:7710", state_dir: dir, allow_cpus: 16, allow_mem_gb: 28, lease_ttl_s: 600, token: "t", ...cfg }, { docker, now: () => 1_000_000, log, live: () => ({ ok: true }), vm: () => vm });
  return { agent, docker, warns };
}
async function admitted(agent, n, slice = { cpus: 1, mem_gb: 0.4 }) {
  let ok = 0, last = null;
  for (let i = 0; i < n; i++) { const r = await agent.launch({ spec: spec(`l${i}`), ...slice }); if (r.status === 201) ok++; else { last = r; break; } }
  return { ok, last };
}

test("clamps advertised capacity to the VM minus host reserve and warns once", () => {
  const { agent, warns } = fixture();
  const c = agent.capacity();
  assert.ok(c.mem_total_gb <= 11.7 - 1, `total ${c.mem_total_gb}`);
  assert.equal(c.mem_total_gb, 10.5);
  assert.equal(c.cpus_total, 16);
  assert.equal(c.clamped, true);
  assert.deepEqual(c.configured, { cpus: 16, mem_gb: 28 });
  agent.capacity();
  assert.equal(warns.filter((w) => /exceeds the VM/.test(w)).length, 1);
});

test("status payload shows effective and configured capacity", () => {
  const { agent } = fixture({ cfg: { allow_cpus: 32, host_reserve_mem_gb: 2 } });
  const c = agent.capacity();
  assert.equal(c.cpus_total, 16);
  assert.equal(c.mem_total_gb, 9.7);
  assert.deepEqual(c.configured, { cpus: 32, mem_gb: 28 });
  assert.deepEqual(c.vm, { cpus: 16, mem_gb: 11.7, swap_gb: 0 });
});

test("admission estimate uses p90 mem_peak and p75 cpu_avg with slice floor", async () => {
  const { agent } = fixture({ history: rows });
  // 5 admitted by the 0.7 GB p90 estimate (10.5 / 0.7 = 15) -> fill, then the next is refused with the typed code.
  const r = await admitted(agent, 20);
  assert.equal(r.ok, 15);
  assert.equal(r.last.body.code, "pool.projected_peak");
  // A tiny-usage repo keeps the slice as its estimate.
  const tiny = fixture({ history: rows.map((x) => ({ ...x, mem_peak_gb: 0.05, cpu_avg: 0.01 })) });
  const t = await admitted(tiny.agent, 40, { cpus: 0.25, mem_gb: 0.4 });
  assert.equal(t.ok, 26); // floor(10.5 / 0.4)
});

test("admission is bounded by projected peak at low instantaneous load", async () => {
  const { agent } = fixture({ history: rows });
  const r = await admitted(agent, 20);
  assert.equal(r.last.status, 503);
  assert.ok(r.ok > 0 && r.ok < 20);
});

test("admits at most the sandboxes whose projected peak memory fits the VM", async () => {
  const { agent, docker } = fixture({ history: rows });
  const { ok } = await admitted(agent, 20);
  assert.ok(ok <= Math.floor(10.5 / 0.7), `admitted ${ok}`);
  assert.ok(ok > 0);
  assert.ok(docker.runs.length >= ok);
});

test("co-tenant containers are counted against free capacity", async () => {
  const { agent } = fixture({ others: { redis: { cpu: 1.5, mem_gb: 2 } } });
  await agent.reap();
  const c = agent.capacity();
  assert.equal(c.cotenant.mem_gb, 2);
  assert.equal(c.cpus_free, 14.5);
});

test("non-sandbox container memory reduces mem_free_gb", async () => {
  const base = fixture();
  const co = fixture({ others: { db: { cpu: 0, mem_gb: 2 } } });
  await co.agent.reap();
  assert.equal(base.agent.capacity().mem_free_gb - co.agent.capacity().mem_free_gb, 2);
  // and it shrinks what is admitted
  const a = await admitted(base.agent, 40, { cpus: 0.25, mem_gb: 0.4 }), b = await admitted(co.agent, 40, { cpus: 0.25, mem_gb: 0.4 });
  assert.ok(b.ok < a.ok);
});

test("unchanged capacity and admissions when config is below the VM", async () => {
  const { agent, warns } = fixture({ cfg: { allow_cpus: 4, allow_mem_gb: 6 }, history: rows.map((x) => ({ ...x, mem_peak_gb: 0.2 })) });
  const c = agent.capacity();
  assert.equal(c.cpus_total, 4); assert.equal(c.mem_total_gb, 6); assert.equal(c.clamped, false);
  assert.equal(c.cpus_free, 4); assert.equal(c.mem_free_gb, 6);
  assert.equal(warns.length, 0);
  const r = await admitted(agent, 20, { cpus: 1, mem_gb: 1.5 });
  assert.equal(r.ok, 4); // slice-bound: min(4 cpus, 6 / 1.5)
  assert.equal(r.last.body.error, "no capacity");
});

test("the load refusal carries code pool.host_load and the agent view exposes load_per_core (#5985)", async () => {
  const dir = tmpDir("cs-adm-");
  const log = { info() {}, warn() {}, error() {} };
  const live = () => ({ ok: false, reason: "load 2.4/core (> 2)", load_per_core: 2.4, mem_available_gb: 9 });
  const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://router:7710", state_dir: dir, allow_cpus: 16, allow_mem_gb: 28, lease_ttl_s: 600, token: "t" }, { docker: fakeDocker({}), now: () => 1_000_000, log, live, vm: () => ({ cpus: 16, mem_gb: 11.7, swap_gb: 0 }) });
  const r = await agent.launch({ spec: spec("l0"), cpus: 1, mem_gb: 0.4 });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "pool.host_load");
  assert.equal(r.body.live.load_per_core, 2.4);
  const c = agent.capacity();
  assert.equal(c.load_per_core, 2.4);
  assert.equal(c.mem_available_gb, 9);
});
