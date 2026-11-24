// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5884: lane disk hard cap, pressure prune, fstrim, sparse VHD installer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { laneDiskUsedGb, planDiskCap, fstrimDue, fstrimArgv, runFstrim } from "../pool/disk.mjs";
import { createAgent } from "../pool/agent.mjs";
import { createRouter } from "../pool/router.mjs";
import { tmpDir } from "./_tmp.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const spec = (id) => ({ id, issue: 1, batch: "b1", repo: { slug: "o/r", url: "https://github.com/o/r.git", ref: "staging" }, command: ["forgedock", "run-issue", "1"], result_file: "/result/1.json" });
function fakeDocker() {
  return {
    runs: [], pruned: [],
    async run(a) { this.runs.push(a); return "cid"; },
    async inspect() { return { running: true, exitCode: 0, startedAt: new Date().toISOString(), finishedAt: "" }; },
    async remove() {}, async kill() { return false; }, async listLabelled() { return []; }, async wipe() {},
    async removeWorkDir() {}, async pruneWorkDirs() {}, async listVolumes() { return []; }, async removeVolume() {},
    async containerPrune(l) { this.pruned.push(["container", l]); }, async imagePrune(l) { this.pruned.push(["image", l]); },
  };
}
function fixture(opts = {}, deps = {}) {
  const docker = fakeDocker();
  const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://router:7710", state_dir: tmpDir("cs-cap-"), allow_cpus: 16, allow_mem_gb: 32, lease_ttl_s: 600, token: "t", ...opts }, { docker, now: () => 1_000_000, log: quiet, live: () => ({ ok: true }), vm: () => ({ cpus: 64, mem_gb: 256, swap_gb: 0 }), ...deps });
  return { agent, docker };
}

test("planDiskCap: ok under threshold, prune from it, full at the cap, off when unset", () => {
  assert.equal(planDiskCap({ usedGb: 50, capGb: 100 }), "ok");
  assert.equal(planDiskCap({ usedGb: 80, capGb: 100 }), "prune");
  assert.equal(planDiskCap({ usedGb: 60, capGb: 100, pruneAtPct: 50 }), "prune");
  assert.equal(planDiskCap({ usedGb: 100, capGb: 100 }), "full");
  assert.equal(planDiskCap({ usedGb: 999, capGb: undefined }), "ok");
  assert.equal(laneDiskUsedGb({ sandboxMb: { a: 2048 }, cacheVolumes: { v: { size_bytes: 2 ** 30 } } }), 3);
});

test("fstrim: interval gate, sudo when not root, failure never throws", async () => {
  assert.equal(fstrimDue({ now: 1000, last: -Infinity }), true);
  assert.equal(fstrimDue({ now: 1000, last: 0, intervalS: 3600 }), false);
  assert.equal(fstrimDue({ now: 1000, last: 0, intervalS: 3600, force: true }), true);
  assert.deepEqual(fstrimArgv({ root: "/d", uid: 0 }), ["fstrim", "-v", "/d"]);
  assert.deepEqual(fstrimArgv({ root: "/d", uid: 1000 }), ["sudo", "-n", "fstrim", "-v", "/d"]);
  assert.equal((await runFstrim({ run: async () => "ok", uid: 0 })).ok, true);
  const bad = await runFstrim({ run: async () => { throw new Error("sudo: a password is required"); }, uid: 1000 });
  assert.equal(bad.ok, false);
});

test("no cap configured: /capacity has no lane disk fields and launches are admitted", async () => {
  const { agent } = fixture();
  const c = agent.capacity();
  assert.equal("lane_disk_cap_gb" in c, false);
  assert.equal("disk_capped" in c, false);
  assert.equal((await agent.launch({ spec: spec("n1"), cpus: 2, mem_gb: 3 })).status, 201);
});

// A cache volume the sweep measured at 5 GiB drives the cap deterministically (sandbox dirs are sampled on wall time).
const withCache = (docker) => Object.assign(docker, { async listVolumes(p) { return p === "cs-cache-" ? ["cs-cache-x"] : []; }, async sweepCache() { return { size_bytes: 5 * 2 ** 30, errors: [] }; } });

test("launch over lane_disk_cap_gb answers 503 pool.disk_cap and runs nothing", async () => {
  const { agent, docker } = fixture({ lane_disk_cap_gb: 4 });
  withCache(docker);
  await agent.reap(); // the cache sweep measures 5 GiB
  const c = agent.capacity();
  assert.equal(c.lane_disk_used_gb, 5);
  assert.equal(c.disk_capped, true);
  const r = await agent.launch({ spec: spec("c1"), cpus: 2, mem_gb: 3 });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "pool.disk_cap");
  assert.equal(docker.runs.length, 0);
  const { agent: roomy, docker: d2 } = fixture({ lane_disk_cap_gb: 50 });
  withCache(d2);
  await roomy.reap();
  assert.equal(roomy.capacity().disk_capped, false);
  assert.equal((await roomy.launch({ spec: spec("c2"), cpus: 2, mem_gb: 3 })).status, 201);
});

test("pressure prune is agent-label scoped and fstrim is interval gated", async () => {
  const trims = [];
  const { agent, docker } = fixture({ lane_disk_cap_gb: 6, disk_prune_at_pct: 50, fstrim_interval_s: 3600 }, { trim: async (o) => { trims.push(o); return { ok: true }; } });
  withCache(docker);
  await agent.reap(); // measures 5 GiB; first fstrim (never run)
  assert.equal(trims.length, 1);
  assert.deepEqual(docker.pruned, []);
  await agent.reap(); // 5 of 6 GB is over 50%: prune, and fstrim forced after it
  assert.equal(docker.pruned.length, 2);
  for (const [, l] of docker.pruned) assert.ok([].concat(l).some((x) => /^computeshare\.agent=/.test(x)) && [].concat(l).includes("computeshare=1"), JSON.stringify(l));
  assert.equal(trims.length, 2);
  const { agent: calm, docker: d3 } = fixture({ fstrim_interval_s: 3600 }, { trim: async (o) => { trims.push(o); return { ok: true }; } });
  await calm.reap(); await calm.reap(); // no cap: never prunes; second reap inside the interval does not trim again
  assert.deepEqual(d3.pruned, []);
  assert.equal(trims.length, 3);
});

test("a failing fstrim is only logged", async () => {
  const warns = [];
  const { agent } = fixture({}, { trim: async () => ({ ok: false, error: "no fstrim" }), log: { info() {}, warn: (m) => warns.push(m), error() {} } });
  await agent.reap();
  assert.ok(warns.some((m) => /fstrim: no fstrim/.test(m)));
});

test("installers: sparse VHD on WSL, reverted by the backup on uninstall, fstrim.timer on Linux", () => {
  const ps = readFileSync(new URL("../../pool/install/install-agent.ps1", import.meta.url), "utf8");
  const un = readFileSync(new URL("../../pool/install/uninstall-agent.ps1", import.meta.url), "utf8");
  const sh = readFileSync(new URL("../../pool/install/install-agent-linux.sh", import.meta.url), "utf8");
  assert.match(ps, /sparseVhd=true/);
  assert.match(ps, /'--manage', \$Distro, '--set-sparse', 'true'/);
  assert.match(un, /computeshare-backup/);
  assert.match(un, /sparseVhd/);
  assert.match(sh, /enable --now fstrim\.timer/);
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
  const router = createRouter({ state_dir: tmpDir("cs-cap-router-"), lane: { cpus: 2, mem_gb: 3 }, enroll_token: "e", forgedock_token: "fd", repos: {} }, { fetchFn, now: () => 5_000_000, log: quiet });
  for (const name of Object.keys(caps)) router.store.data.agents[name] = { url: `http://${name}:7711`, token: "t" };
  return { router, calls };
}

test("router skips disk_capped agents and defers with pool.disk_cap", async () => {
  const full = { cpus_free: 8, mem_free_gb: 16, disk_capped: true, lane_disk_used_gb: 9, lane_disk_cap_gb: 8 };
  const only = routerFixture({ legion: full });
  const r = await only.router.launch(spec("r1"));
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "pool.disk_cap");
  assert.deepEqual(r.body.agents, ["legion"]);
  assert.equal(only.calls.some((c) => c.startsWith("POST ")), false);
  const both = routerFixture({ legion: full, vm2: { cpus_free: 4, mem_free_gb: 8 } });
  const ok = await both.router.launch(spec("r2"));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.agent, "vm2");
});
