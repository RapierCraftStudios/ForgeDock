// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { planCacheCap, planIdleEviction, sweepVolume, PACKAGE_STORES, CACHE_LABEL } from "../pool/cache-sweep.mjs";
import { createAgent } from "../pool/agent.mjs";
import { tmpDir } from "./_tmp.mjs";

const GB = 1024 ** 3, DAY = 86400000;
const quiet = { info() {}, warn() {}, error() {} };

describe("planCacheCap", () => {
  it("deletes oldest first until under the cap, never a live dir", () => {
    const e = [{ path: "live", bytes: 4 * GB, mtimeMs: 1, live: true }, { path: "a", bytes: 3 * GB, mtimeMs: 2 }, { path: "b", bytes: 3 * GB, mtimeMs: 3 }, { path: "c", bytes: 3 * GB, mtimeMs: 4 }];
    const p = planCacheCap(e, 8 * GB);
    assert.deepEqual(p.delete, ["a", "b"]);
    assert.ok(p.after <= 8 * GB);
  });
  it("under the cap or no cap: nothing", () => {
    assert.deepEqual(planCacheCap([{ path: "a", bytes: 1, mtimeMs: 1 }], GB).delete, []);
    assert.deepEqual(planCacheCap([{ path: "a", bytes: 1, mtimeMs: 1 }], NaN).delete, []);
  });
});

describe("planIdleEviction", () => {
  const now = 100 * DAY;
  const vols = [{ name: "old", lastUsedMs: 10 * DAY }, { name: "ref", lastUsedMs: 10 * DAY }, { name: "never", lastUsedMs: 10 * DAY }, { name: "fresh", lastUsedMs: 99 * DAY }, { name: "unknown", lastUsedMs: null }];
  it("evicts only idle, unreferenced, known, non-protected volumes", () => {
    assert.deepEqual(planIdleEviction({ volumes: vols, referenced: new Set(["ref"]), neverEvict: ["never"], now, idleMs: 30 * DAY }), ["old"]);
  });
});

describe("sweepVolume age-out", () => {
  it("deletes package cache, depcache and env entries older than the max age", () => {
    const root = tmpDir("cs-sweep-");
    const old = (Date.now() - 40 * DAY) / 1000;
    for (const f of ["forge-depcache/stores/uv-cache/a/x.bin", "pnpm-store/y.bin"]) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), "x"); utimesSync(join(root, f), old, old); }
    for (const d of ["forge-depcache/pnpm-0123456789abcdef", "env/snap-old", "env/snap-new"]) mkdirSync(join(root, d), { recursive: true });
    for (const d of ["forge-depcache/pnpm-0123456789abcdef", "env/snap-old"]) utimesSync(join(root, d), old, old);
    const r = sweepVolume({ root, maxAgeDays: 14, keep: [] });
    assert.ok(!existsSync(join(root, "forge-depcache/stores/uv-cache/a/x.bin")) && !existsSync(join(root, "pnpm-store/y.bin")));
    assert.ok(!existsSync(join(root, "forge-depcache/pnpm-0123456789abcdef")) && !existsSync(join(root, "env/snap-old")));
    assert.ok(existsSync(join(root, "env/snap-new")));
    assert.equal(r.errors.length, 0);
  });
  it("ages out old files under every PACKAGE_STORES dir, the layout the lanes really use (#5955)", () => {
    const root = tmpDir("cs-sweep-");
    const old = (Date.now() - 40 * DAY) / 1000;
    for (const d of PACKAGE_STORES) { const f = join(root, d, "k/blob"); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, "x".repeat(2000)); utimesSync(f, old, old); }
    const r = sweepVolume({ root, maxAgeDays: 14, keep: [] });
    for (const d of PACKAGE_STORES) assert.ok(!existsSync(join(root, d, "k/blob")), d);
    assert.equal(r.errors.length, 0);
  });
  it("PACKAGE_STORES covers every store depcache.mjs points the lane env at (#5955)", () => {
    const src = readFileSync(new URL("../lean/depcache.mjs", import.meta.url), "utf8");
    const names = [...src.matchAll(/store\("([\w-]+)"\)/g)].map((m) => m[1]);
    assert.ok(names.length >= 5);
    for (const n of names) assert.ok(PACKAGE_STORES.includes(n === "pnpm-store" ? "forge-depcache/stores/pnpm-store" : `forge-depcache/stores/${n}`), n);
    assert.ok(PACKAGE_STORES.includes("pnpm-store"));
  });
  it("cap shrinks work dirs oldest-first but keeps live ones; reports last use", () => {
    const root = tmpDir("cs-sweep-");
    const big = "x".repeat(300000);
    for (const [d, age] of [["work/live", 50], ["work/o1", 30], ["work/o2", 5]]) { mkdirSync(join(root, d), { recursive: true }); writeFileSync(join(root, d, "f"), big); const t = (Date.now() - age * DAY) / 1000; utimesSync(join(root, d), t, t); }
    writeFileSync(join(root, ".last-used"), "1700000000\n");
    const r = sweepVolume({ root, maxAgeDays: 999, maxGb: 0.0007, keep: [join(root, "work/live")] });
    assert.ok(existsSync(join(root, "work/live")) && !existsSync(join(root, "work/o1")));
    assert.equal(r.last_used_ms, 1700000000000);
  });
});

function fakeDocker() {
  return {
    containers: new Map(), runs: [], labels: [], swept: [], removed: [], failSweep: false, volumes: new Set(["cs-cache-o_r", "cs-cache-marcode", "cs-cache-idle"]),
    async run(args) { this.runs.push(args); return "cid"; },
    async inspect() { return null; }, async remove() {}, async kill() { return false; }, async listLabelled() { return []; }, async wipe() {}, async removeWorkDir() {}, async pruneWorkDirs() {},
    async listVolumes(prefix) { return [...this.volumes].filter((v) => v.startsWith(prefix)); },
    async removeVolume(v) { this.removed.push(v); this.volumes.delete(v); },
    async createVolume(n, l) { this.labels.push([n, l]); },
    async sweepCache(v) { this.swept.push(v); if (this.failSweep) throw Object.assign(new Error("timeout"), { stderr: "timed out" }); return { size_bytes: 5 * GB, last_used_ms: v === "cs-cache-idle" || v === "cs-cache-marcode" ? 1000 : null, removed: 0, errors: [] }; },
  };
}
const mk = (docker, cfg = {}) => createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://x", state_dir: tmpDir("cs-agent-"), allow_cpus: 4, allow_mem_gb: 8, token: "t", ...cfg }, { docker, now: () => 100 * DAY, log: quiet, live: () => ({ ok: true }), vm: () => ({ cpus: 64, mem_gb: 256, swap_gb: 0 }) });

describe("agent cache sweep", () => {
  it("evicts idle unreferenced volumes, never the never-evict list, and reports sizes", async () => {
    const docker = fakeDocker();
    const agent = mk(docker, { cache_idle_days: 30, cache_never_evict: ["cs-cache-marcode"] });
    await agent.reap();
    assert.deepEqual(docker.removed, ["cs-cache-idle"]);
    assert.ok(!docker.swept.includes("cs-cache-marcode"));
    const cap = agent.capacity();
    assert.equal(cap.cache_sweep_error, undefined);
    assert.equal(cap.cache_volumes["cs-cache-o_r"].size_gb, 5);
  });
  it("a failing sweep surfaces as cache_sweep_error in capacity", async () => {
    const docker = fakeDocker();
    docker.failSweep = true;
    const agent = mk(docker);
    await agent.reap();
    assert.match(agent.capacity().cache_sweep_error, /cache sweep cs-cache-.*timed out/);
    assert.deepEqual(docker.removed, []);
  });
  it("launch creates the cache volume with the ownership label", async () => {
    const docker = fakeDocker();
    const agent = mk(docker);
    await agent.launch({ spec: { id: "s1", repo: { slug: "o/r", url: "u" }, command: ["x"] }, cpus: 1, mem_gb: 1 });
    assert.deepEqual(docker.labels, [["cs-cache-o-r", [CACHE_LABEL, "computeshare.agent=a1"]]]);
  });
  it("a pre-label cache volume the agent mounts is swept and work-pruned; a foreign unlabelled one is not", async () => {
    const docker = fakeDocker();
    docker.volumes = new Set(["cs-cache-o-r", "cs-cache-foreign"]);
    docker.listVolumes = async function (prefix, label) { return label ? [] : [...this.volumes].filter((v) => v.startsWith(prefix)); }; // nothing carries the label
    docker.volumeLabels = async () => ({});
    docker.pruned = [];
    docker.pruneWorkDirs = async function (v) { this.pruned.push(v); };
    const agent = mk(docker);
    await agent.launch({ spec: { id: "s1", repo: { slug: "o/r", url: "u" }, command: ["x"] }, cpus: 1, mem_gb: 1 });
    await agent.reap();
    assert.ok(docker.swept.includes("cs-cache-o-r"));
    assert.ok(docker.pruned.includes("cs-cache-o-r"));
    assert.ok(!docker.swept.includes("cs-cache-foreign") && !docker.pruned.includes("cs-cache-foreign"));
  });
});
