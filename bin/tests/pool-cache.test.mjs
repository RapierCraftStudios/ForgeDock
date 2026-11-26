// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { planCacheCap, planDepcacheCap, planIdleEviction, sweepVolume, PACKAGE_STORES, LEGACY_STORES, CACHE_LABEL } from "../pool/cache-sweep.mjs";
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

describe("depcache cap (#5901)", () => {
  it("planDepcacheCap evicts least-recently-used snapshots until under the cap", () => {
    const e = [1, 2, 3, 4, 5].map((n) => ({ path: `s${n}`, bytes: 10, lastUsedMs: n * 100 }));
    const p = planDepcacheCap(e, 25);
    assert.deepEqual(p.delete, ["s1", "s2", "s3"]);
    assert.equal(p.after, 20);
    assert.deepEqual(planDepcacheCap([{ path: "s", bytes: 10, lastUsedMs: 1, live: true }], 1).delete, []);
  });
  const snap = (root, repo, key, kb, usedAgoDays) => {
    const d = join(root, "forge-depcache", repo, `npm-${key}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "f"), "x".repeat(kb * 1024));
    writeFileSync(join(d, "last-used"), String(Date.now() - usedAgoDays * DAY));
    return d;
  };
  it("sweepVolume removes the oldest snapshots past the per-repo cap before newer ones", () => {
    const root = tmpDir("cs-sweep-");
    const [o, m, n] = [snap(root, "acme_shop", "0000000000000001", 400, 3), snap(root, "acme_shop", "0000000000000002", 400, 2), snap(root, "acme_shop", "0000000000000003", 400, 1)];
    const other = snap(root, "other", "0000000000000004", 400, 9);
    const r = sweepVolume({ root, maxAgeDays: 14, maxDepcacheGb: 0.0009, keep: [] });
    assert.ok(!existsSync(o) && existsSync(m) && existsSync(n));
    assert.ok(existsSync(other)); // its own repo, under the cap
  });
  it("a locked snapshot is never evicted", () => {
    const root = tmpDir("cs-sweep-");
    const o = snap(root, "r", "0000000000000001", 400, 3);
    writeFileSync(`${o}.lock`, "{}");
    snap(root, "r", "0000000000000002", 400, 1);
    sweepVolume({ root, maxAgeDays: 14, maxDepcacheGb: 0.0005, keep: [] });
    assert.ok(existsSync(o));
  });
  it("sweep result reports depcache bytes per repo", () => {
    const root = tmpDir("cs-sweep-");
    snap(root, "a_b", "0000000000000001", 100, 1);
    snap(root, "c_d", "0000000000000002", 200, 1);
    const r = sweepVolume({ root, maxAgeDays: 14, keep: [] });
    assert.ok(r.depcache_bytes.a_b >= 100 * 1024 && r.depcache_bytes.c_d >= 200 * 1024);
  });
});

describe("sweepVolume age-out", () => {
  it("deletes package cache and env entries older than the max age", () => {
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
  it("every /cache path exported by entrypoint.sh is under a PACKAGE_STORES entry (#5969)", () => {
    const src = readFileSync(new URL("../../pool/image/entrypoint.sh", import.meta.url), "utf8");
    const paths = src.split("\n").filter((l) => /^\s*export\s/.test(l)).flatMap((l) => [...l.matchAll(/=(\/cache\/[\w./-]+)/g)].map((m) => m[1]));
    assert.ok(paths.length >= 4);
    for (const p of paths) assert.ok(PACKAGE_STORES.some((s) => p === `/cache/${s}` || p.startsWith(`/cache/${s}/`)) || p === "/cache/forge-depcache", p);
  });
  it("legacy dirs an old entrypoint exported (/cache/uv ...) stay covered and age out (#5969)", () => {
    for (const d of ["uv", "npm", "pip", "poetry"]) assert.ok(LEGACY_STORES.includes(d) && PACKAGE_STORES.includes(d), d);
    const root = tmpDir("cs-sweep-");
    const old = (Date.now() - 40 * DAY) / 1000, fresh = join(root, "uv/k/new");
    for (const d of LEGACY_STORES) { const f = join(root, d, "k/blob"); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, "x"); utimesSync(f, old, old); }
    writeFileSync(fresh, "x");
    const r = sweepVolume({ root, maxAgeDays: 14, keep: [] });
    for (const d of LEGACY_STORES) assert.ok(!existsSync(join(root, d, "k/blob")), d);
    assert.ok(existsSync(fresh));
    assert.equal(r.errors.length, 0);
  });
  it("depcache snapshots age by last-used, not dir mtime, and a live lock protects them (#5898)", () => {
    const root = tmpDir("cs-sweep-");
    const oldS = (Date.now() - 40 * DAY) / 1000, freshMs = Date.now() - DAY;
    const mk = (n, lastMs) => { const d = join(root, "forge-depcache/rk", n); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "manifest.json"), JSON.stringify({ created: Date.now() - 40 * DAY })); writeFileSync(join(d, "last-used"), String(lastMs)); utimesSync(d, oldS, oldS); return d; };
    const inUse = mk("pnpm-aaaaaaaaaaaaaaaa", freshMs), idle = mk("pnpm-bbbbbbbbbbbbbbbb", Date.now() - 40 * DAY), locked = mk("npm-cccccccccccccccc", Date.now() - 40 * DAY);
    writeFileSync(`${locked}.lock`, "{}");
    utimesSync(join(root, "forge-depcache/rk"), oldS, oldS);
    const r = sweepVolume({ root, maxAgeDays: 14, keep: [] });
    assert.ok(existsSync(inUse), "recently used snapshot kept");
    assert.ok(!existsSync(idle), "idle snapshot removed");
    assert.ok(existsSync(locked), "snapshot with a live lock kept");
    assert.equal(r.errors.length, 0);
  });
  it("cap never deletes a locked depcache snapshot (#5898)", () => {
    const root = tmpDir("cs-sweep-");
    const big = "x".repeat(300000), t0 = Date.now() - DAY;
    const mk = (n, lastMs) => { const d = join(root, "forge-depcache/rk", n); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "manifest.json"), "{}"); writeFileSync(join(d, "blob"), big); writeFileSync(join(d, "last-used"), String(lastMs)); return d; };
    const locked = mk("pnpm-aaaaaaaaaaaaaaaa", t0 - 5 * DAY), other = mk("pnpm-bbbbbbbbbbbbbbbb", t0);
    writeFileSync(`${locked}.lock`, "{}");
    sweepVolume({ root, maxAgeDays: 14, maxGb: 0.0003, keep: [] });
    assert.ok(existsSync(locked), "locked snapshot survives the cap");
    assert.ok(!existsSync(other), "unlocked snapshot is evicted instead");
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
    async sweepCache(v) { this.swept.push(v); if (this.failSweep) throw Object.assign(new Error("timeout"), { stderr: "timed out" }); return { size_bytes: 5 * GB, last_used_ms: v === "cs-cache-idle" || v === "cs-cache-marcode" ? 1000 : null, removed: 0, errors: [], ...(this.depcache ? { depcache_bytes: this.depcache } : {}) }; },
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
  it("capacity carries depcache_gb per repo", async () => {
    const docker = fakeDocker();
    docker.depcache = { acme_shop: 3 * GB };
    const agent = mk(docker);
    await agent.reap();
    assert.deepEqual(agent.capacity().cache_volumes["cs-cache-o_r"].depcache_gb, { acme_shop: 3 });
  });
  it("a launch sweeps the cache volumes first, once per minute, so the depcache cap holds before the lane writes", async () => {
    const docker = fakeDocker();
    const agent = mk(docker);
    await agent.launch({ spec: { id: "s1", repo: { slug: "o/r", url: "u" }, command: ["x"] }, cpus: 1, mem_gb: 1 });
    const n = docker.swept.length;
    assert.ok(n > 0);
    await agent.launch({ spec: { id: "s2", repo: { slug: "o/r", url: "u" }, command: ["x"] }, cpus: 1, mem_gb: 1 });
    assert.equal(docker.swept.length, n);
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
