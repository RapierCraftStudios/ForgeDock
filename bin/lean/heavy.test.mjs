// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { guardChain, isPassThroughWrapper, SHIM_LOOP_MAX, classifyStep, heavyConfig, openHeavy, acquireHeavy, writeHeavyShims, heavyShimScript, sumWaits, runWrapped, HEAVY_BINS, isHeavyProcess } from "./heavy.mjs";
import { checkAdmission, ADMISSION_DEFAULTS, localLaneCap } from "./admission.mjs";
import { formatAlertLines, formatWaitSummary } from "./orchestrate.mjs";
import { readHeavy, liveLaneCap } from "../engine-cli.mjs";

// Injected pids, clock and host: `live` is the set of pids the registry sees as alive; `mem` the MemAvailable in MB.
const world = ({ mem = 12000, cores = 4, swapFree = 0 } = {}) => {
  const live = new Set(), clock = { t: 1_000_000 }, h = { mem, cores, swapFree };
  const dir = tmpDir("heavy-");
  const host = { memAvailableMb: () => h.mem, cores: () => h.cores, swapFreeMb: () => h.swapFree };
  const handle = (pid, cfg = {}) => { live.add(pid); return openHeavy(dir, { pid, alive: (p) => live.has(p), now: () => clock.t, host, cfg }); };
  return { dir, live, clock, h, handle };
};

describe("step classes (#4169)", () => {
  it("installs, checkers, test runners and containers are heavy across ecosystems; metadata calls and the rest are llm", () => {
    const heavy = [["pnpm", ["install"]], ["npm", ["ci"]], ["yarn", []], ["pnpm", ["--filter", "web", "test"]], ["npm", ["run", "typecheck"]], ["bun", ["test"]],
      ["npx", ["tsc", "--noEmit"]], ["tsc", ["-p", "."]], ["eslint", ["."]], ["vitest", ["run"]], ["jest", []], ["pytest", ["-q"]], ["mypy", ["src"]],
      ["cargo", ["test"]], ["cargo", ["--locked", "clippy"]], ["go", ["test", "./..."]], ["docker", ["run", "--rm", "pg"]], ["docker", ["compose", "up"]],
      ["docker-compose", ["up"]], ["mvn", ["verify"]], ["gradle", ["build"]], ["/usr/bin/tsc", ["-b"]]];
    for (const [n, a] of heavy) assert.equal(classifyStep(n, a), "heavy", `${n} ${a.join(" ")}`);
    const llm = [["pnpm", ["--version"]], ["npm", ["ls"]], ["pnpm", []], ["npm", ["view", "x"]], ["tsc", ["--version"]], ["eslint", ["-v"]], ["npx", []],
      ["cargo", ["--version"]], ["go", ["env"]], ["docker", ["ps"]], ["docker", ["logs", "x"]], ["git", ["status"]], ["node", ["x.js"]], ["claude", ["--print"]]];
    for (const [n, a] of llm) assert.equal(classifyStep(n, a), "llm", `${n} ${a.join(" ")}`);
  });

  it("load average is no longer a default admission signal; an explicit max_load_per_core still is", async () => {
    assert.equal(ADMISSION_DEFAULTS.max_load_per_core, null);
    const host = { memAvailableMb: () => 8000, freeMb: async () => 8000, tmpPaths: () => ["/tmp"], loadAvg1: () => 17, cores: () => 4 };
    assert.equal((await checkAdmission({ host })).ok, true, "load 4.25/core does not refuse a lane by default");
    const r = await checkAdmission({ cfg: { max_load_per_core: 4 }, host });
    assert.equal(r.ok, false); assert.match(r.detail, /load 4\.3\/core > 4/);
  });

  it("config: defaults, forge.yaml keys, env overrides; readHeavy parses engine.heavy_*", () => {
    assert.deepEqual(heavyConfig(), { enabled: true, max: null, step_mem_mb: 2048, reserve_mb: 1024, ramp_s: 60, max_wait_s: 1800 });
    const c = heavyConfig({ max: 2, step_mem_mb: 3000, enabled: false }, { FORGE_HEAVY_MAX: "5", FORGE_HEAVY_RESERVE_MB: "bad" });
    assert.equal(c.max, 5); assert.equal(c.step_mem_mb, 3000); assert.equal(c.reserve_mb, 1024); assert.equal(c.enabled, false);
    const d = tmpDir("heavy-yaml-");
    writeFileSync(join(d, "forge.yaml"), "engine:\n  heavy_max: 2\n  heavy_step_mem_mb: 2500\n  heavy_enabled: false\n");
    assert.deepEqual(readHeavy(d), { enabled: false, max: 2, step_mem_mb: 2500 });
    assert.deepEqual(readHeavy(tmpDir("heavy-none-")), {});
  });
});

describe("idle-detector inputs (#4405)", () => {
  it("isHeavyProcess: shim steps, test runners and linters behind an interpreter are heavy; pollers, MCP servers and git are not", () => {
    for (const c of ["/usr/bin/node /x/bin/lean/heavy.mjs run --name npm -- /usr/bin/npm test", "/bin/sh /x/vitest run", "node /x/node_modules/.bin/eslint .",
      "node --test a.test.mjs", "python3 -m pytest -q", "pytest -x", "cargo test", "env CI=1 jest"]) assert.equal(isHeavyProcess(c), true, c);
    for (const c of ["sleep 10", "bash -c until grep -q done out; do sleep 10; done", "node mcp-server.js", "git status", "npm --version", "", null]) assert.equal(isHeavyProcess(c), false, String(c));
  });

  it("lane(pids) counts only this session's live queued and running entries, read-only", () => {
    const { handle, live, dir } = world({ mem: 64000, cores: 2 });
    const a = handle(201), b = handle(202), c = handle(301);
    assert.equal(a.tryAcquire("a", { issue: 7 }).ok, true);
    assert.equal(b.tryAcquire("b", { issue: 7 }).ok, false);
    assert.equal(c.tryAcquire("c", { issue: 7 }).ok, false);
    const before = readFileSync(join(dir, "heavy.json"), "utf8");
    assert.deepEqual(a.lane([201, 202, 999]), { queued: 1, running: 1 });
    assert.deepEqual(a.lane([301]), { queued: 1, running: 0 }, "same issue number, other session: matched by pid only");
    assert.deepEqual(a.lane([]), { queued: 0, running: 0 });
    live.delete(201);
    assert.deepEqual(a.lane([201, 202]), { queued: 1, running: 0 }, "a dead holder does not count");
    assert.equal(readFileSync(join(dir, "heavy.json"), "utf8"), before, "lane() never writes the registry");
  });
});

describe("heavy-step semaphore (#4169)", () => {
  it("caps live holders at max(1, cores-1) and frees a slot on release or holder death", () => {
    const { handle, live } = world({ mem: 64000, cores: 4 });
    const hs = [1, 2, 3, 4].map((p) => handle(100 + p));
    assert.deepEqual(hs.map((h, i) => h.tryAcquire(`k${i}`, { issue: i }).ok), [true, true, true, false]);
    assert.match(hs[3].tryAcquire("k3").reason, /heavy cap 3 reached/);
    hs[0].release("k0");
    assert.equal(hs[3].tryAcquire("k3").ok, true);
    live.delete(102); // a holder whose process died is reaped
    const h5 = handle(105);
    assert.equal(h5.tryAcquire("k5").ok, true);
    assert.equal(handle(106, { max: 1 }).max(), 1);
  });

  it("adapts to free memory: ramping steps count at their reservation, then live MemAvailable decides; swap never counts", () => {
    const w = world({ mem: 7000, cores: 16, swapFree: 32000 });
    const a = w.handle(1), b = w.handle(2), c = w.handle(3);
    assert.equal(a.tryAcquire("a").ok, true);
    assert.equal(b.tryAcquire("b").ok, true, "7000 − 2048 = 4952 ≥ 3072");
    const r = c.tryAcquire("c");
    assert.equal(r.ok, false, "7000 − 4096 = 2904 < 3072; 32 GB of free swap does not help");
    assert.match(r.reason, /free memory 7000 MB/);
    w.clock.t += 61_000; // a and b are past the ramp window: their real use is in MemAvailable now
    w.h.mem = 2500;
    assert.equal(c.tryAcquire("c").ok, false, "2500 < 3072 with holders: never push the host into swap");
    w.h.mem = 3100;
    assert.equal(c.tryAcquire("c").ok, true);
  });

  it("with no holder one step may run while MemAvailable ≥ reserve, so a step is not starved; below the reserve it waits", () => {
    const w = world({ mem: 1500, cores: 4 });
    assert.equal(w.handle(1).tryAcquire("a").ok, true);
    const w2 = world({ mem: 900, cores: 4 });
    assert.equal(w2.handle(1).tryAcquire("a").ok, false);
  });

  it("queues by priority then FIFO: a P0 offered last is granted before queued P2s", () => {
    const { handle } = world({ mem: 64000, cores: 2 }); // max 1
    const hold = handle(1), p2a = handle(2), p2b = handle(3), p0 = handle(4);
    assert.equal(hold.tryAcquire("hold").ok, true);
    assert.equal(p2a.tryAcquire("p2a", { priority: 2 }).ok, false);
    assert.equal(p2b.tryAcquire("p2b", { priority: 2 }).ok, false);
    assert.equal(p0.tryAcquire("p0", { priority: 0 }).ok, false);
    hold.release("hold");
    assert.match(p2a.tryAcquire("p2a", { priority: 2 }).reason, /queued behind 1/);
    assert.equal(p0.tryAcquire("p0", { priority: 0 }).ok, true);
    p0.release("p0");
    assert.equal(p2b.tryAcquire("p2b", { priority: 2 }).ok, false, "FIFO within P2: p2a first");
    assert.equal(p2a.tryAcquire("p2a", { priority: 2 }).ok, true);
    const st = hold.stats();
    assert.equal(st.holders, 1); assert.equal(st.queued, 1); assert.equal(st.maxQueued, 3);
  });

  it("fails open on a corrupt registry; stats is read-only and null when unreadable", () => {
    const w = world();
    mkdirSync(w.dir, { recursive: true });
    writeFileSync(join(w.dir, "heavy.json"), "{not json");
    const r = w.handle(1).tryAcquire("a");
    assert.equal(r.ok, true); assert.equal(r.fallback, true);
    assert.equal(w.handle(1).stats(), null);
  });

  it("acquireHeavy polls until granted, reports the wait and the longest queue seen; gives up after max_wait_s (ungated)", async () => {
    const w = world({ mem: 64000, cores: 2 });
    const holder = w.handle(1);
    holder.tryAcquire("hold");
    const h = w.handle(2);
    let polls = 0;
    const g = await acquireHeavy(h, { phase: "precheck" }, { pid: 2, now: () => w.clock.t, sleep: async (ms) => { w.clock.t += ms; if (++polls === 3) holder.release("hold"); } });
    assert.equal(g.waitMs, 6000); assert.equal(g.queued, 1); assert.equal(h.stats().holders, 1);
    g.release();
    assert.equal(h.stats().holders, 0);
    holder.tryAcquire("hold2");
    const h2 = w.handle(3, { max_wait_s: 10 });
    const t = await acquireHeavy(h2, {}, { pid: 3, now: () => w.clock.t, sleep: async (ms) => { w.clock.t += ms; } });
    assert.equal(t.timedOut, true); assert.equal(h2.stats().queued, 0, "a timed-out waiter is withdrawn");
  });

  it("R4 simulation: 20 lanes on a 4-core/16 GB host at load 17 are all admitted, none deferred on load; ≤3 heavy steps at once", async () => {
    const w = world({ mem: 16384, cores: 4 });
    const lanes = 20, laneRss = 265, tscRss = 2048;
    const admitHost = { memAvailableMb: () => w.h.mem, freeMb: async () => 50000, tmpPaths: () => ["/tmp"], loadAvg1: () => 17, cores: () => 4 };
    w.h.mem = 16384 - lanes * laneRss; // every lane's agent is resident: 11084 MB left
    const admitted = await Promise.all(Array.from({ length: lanes }, () => checkAdmission({ host: admitHost })));
    assert.equal(admitted.filter((a) => a.ok).length, lanes, "all 20 lanes admitted into their LLM phases");
    // Each lane runs one heavy step; a granted step consumes its tsc RSS once past the ramp window.
    const hs = Array.from({ length: lanes }, (_, i) => w.handle(1000 + i));
    const holding = new Set();
    let peak = 0, done = 0;
    for (let tick = 0; done < lanes && tick < 1000; tick++) {
      for (let i = 0; i < lanes; i++) {
        if (holding.has(i) || hs[i].done) continue;
        if (hs[i].tryAcquire(`s${i}`, { issue: i }).ok) holding.add(i);
      }
      peak = Math.max(peak, holding.size);
      w.clock.t += 61_000;
      w.h.mem = 16384 - lanes * laneRss - holding.size * tscRss;
      for (const i of [...holding].slice(0, 1)) { hs[i].release(`s${i}`); hs[i].done = true; holding.delete(i); done++; }
      w.h.mem = 16384 - lanes * laneRss - holding.size * tscRss;
    }
    assert.equal(done, lanes, "every heavy step eventually ran");
    assert.ok(peak <= 3 && peak >= 2, `2-3 heavy steps at once on 4 cores (peak ${peak})`);
    // Less free memory shrinks heavy concurrency to what fits.
    const w2 = world({ mem: 5000, cores: 4 });
    const g = [1, 2, 3].map((p) => w2.handle(p).tryAcquire(`k${p}`).ok);
    assert.deepEqual(g, [true, false, false], "5000 MB fits one 2 GB step plus the 1 GB reserve, not two");
  });
});

describe("heavy shims and the run wrapper (#4169)", () => {
  it("shims are written only for heavy names on PATH and never resolve to themselves", async () => {
    const d = tmpDir("heavy-shim-"), real = join(d, "real"), bin = join(d, "bin");
    mkdirSync(real, { recursive: true });
    for (const n of ["tsc", "pnpm", "git"]) { writeFileSync(join(real, n), "#!/bin/sh\n"); chmodSync(join(real, n), 0o755); }
    const names = await writeHeavyShims(bin, { path: `${bin}:${real}` });
    assert.deepEqual(names.sort(), ["pnpm", "tsc"]);
    assert.ok(!existsSync(join(bin, "git")));
    const s = readFileSync(join(bin, "tsc"), "utf8");
    assert.match(s, new RegExp(`-- '${real}/tsc' "\\$@"`));
    assert.ok(!s.includes(`'${bin}/tsc'`));
    assert.deepEqual(await writeHeavyShims(join(d, "none"), { path: join(d, "empty") }), []);
    assert.ok(HEAVY_BINS.includes("docker") && HEAVY_BINS.includes("pytest"));
    assert.match(heavyShimScript("x", "/r/x", { node: "/n", script: "/s" }), /^#!\/bin\/sh\n[\s\S]*exec '\/n' '\/s' run --name 'x' -- '\/r\/x' "\$@"\n$/);
  });

  it("run: heavy steps hold a slot for their duration, get FORGE_HEAVY_HELD and per-holder parallelism, record the wait; llm and nested pass through", async () => {
    const w = world({ mem: 64000, cores: 8 });
    const waitsFile = join(w.dir, "waits.jsonl");
    const calls = [];
    const env = { FORGEDOCK_SCHED_DIR: w.dir, FORGE_HEAVY_WAITS: waitsFile, FORGE_LANE_PHASE: "implement", FORGE_LANE_PRIORITY: "1", FORGE_LANE_ISSUE: "7" };
    const open = (dir, o) => { w.live.add(process.pid); return openHeavy(dir, { ...o, alive: (p) => w.live.has(p) }); };
    const host = { memAvailableMb: () => 64000, cores: () => 8 };
    const run = async (cmd, args, e) => { calls.push({ cmd, args, held: e.FORGE_HEAVY_HELD, par: e.FORGE_HOST_PARALLELISM, holders: openHeavy(w.dir, { host }).stats().holders }); return { code: 3, signal: null }; };
    assert.deepEqual(await runWrapped(["run", "--name", "tsc", "--", "/r/tsc", "--noEmit"], { env, open, run, host }), { code: 3, signal: null });
    assert.deepEqual(calls[0], { cmd: "/r/tsc", args: ["--noEmit"], held: "1", par: "8", holders: 1 });
    assert.equal(openHeavy(w.dir, { host }).stats().holders, 0, "released after the step");
    assert.deepEqual(sumWaits(readFileSync(waitsFile, "utf8")), { waits: { implement: JSON.parse(readFileSync(waitsFile, "utf8")).waitMs }, queueMax: 1 });
    await runWrapped(["run", "--name", "tsc", "--", "/r/tsc", "--version"], { env, open, run, host });
    await runWrapped(["run", "--name", "pnpm", "--", "/r/pnpm", "install"], { env: { ...env, FORGE_HEAVY_HELD: "1" }, open, run, host });
    assert.deepEqual(calls.slice(1).map((c) => [c.held, c.holders]), [[undefined, 0], ["1", 0]], "llm and nested calls take no slot");
    await runWrapped(["run", "--name", "tsc", "--", "/r/tsc"], { env: { ...env, FORGE_HOST_PARALLELISM: "2", FORGE_HEAVY_PARALLELISM_PINNED: "1" }, open, run, host });
    assert.equal(calls.at(-1).par, "2", "an operator-set FORGE_HOST_PARALLELISM wins");
    await assert.rejects(runWrapped(["run", "--name", "x"], { env, open, run, host }), /usage/);
  });

  it("sumWaits sums per phase and ignores bad lines; formatWaitSummary renders the batch-report line", () => {
    assert.deepEqual(sumWaits('{"phase":"implement","waitMs":1000,"queued":2}\nnot json\n{"phase":"implement","waitMs":500}\n{"phase":"fix","waitMs":60000,"queued":4}\n'),
      { waits: { implement: 1500, fix: 60000 }, queueMax: 4 });
    const rows = [{ issue: 1, waits: { implement: 180000, setup: 6000 }, heavyQueueMax: 2 }, { issue: 2, waits: { implement: 12000 }, heavyQueueMax: 5 }, { issue: 3 }];
    assert.equal(formatWaitSummary(rows, { queued: 1, maxQueued: 9 }), "waits by phase: implement 3.2m, setup 0.1m; heavy queue: now 1, max 5");
    assert.equal(formatWaitSummary([{ issue: 3 }], null), null);
    assert.equal(formatWaitSummary([{ issue: 3 }], { queued: 0 }), null, "no waits and an empty queue print no line");
    assert.equal(formatWaitSummary([{ issue: 3 }], { queued: 2 }), "waits by phase: none; heavy queue: now 2, max 0");
  });

  it("formatAlertLines (#4354): the batch-report alert tail, nothing when no alert fired", () => {
    assert.deepEqual(formatAlertLines([]), []);
    assert.deepEqual(formatAlertLines(undefined), []);
    assert.deepEqual(formatAlertLines([{ event: "deferred-to-ci", rate: 0.4, count: 4, sample: 10, threshold: 0.3, example: "npx tsc" }]),
      ["ALERTS", 'deferred-to-ci: 40% (4/10 lanes, threshold 30%), e.g. "npx tsc"']);
  });
});

describe("shim re-entry through a pass-through wrapper (#4680)", () => {
  it("shim with pass-through wrapper runs once", async () => {
    const d = tmpDir("heavy-wrap-"), wrap = join(d, "wrap"), real = join(d, "real"), bin = join(d, "bin"), log = join(d, "log");
    mkdirSync(wrap, { recursive: true }); mkdirSync(real, { recursive: true });
    writeFileSync(join(wrap, "docker"), `#!/bin/sh\necho w >> ${log}\nexec "$(PATH="\${PATH#${wrap}:}" command -v docker)" "$@"\n`);
    writeFileSync(join(real, "docker"), `#!/bin/sh\necho r >> ${log}\necho "Docker version 1"\n`);
    for (const dir of [wrap, real]) chmodSync(join(dir, "docker"), 0o755);
    const path = `${wrap}:${bin}:${real}`;
    const warnings = [];
    assert.deepEqual(await writeHeavyShims(bin, { path, warn: (m) => warnings.push(m) }), ["docker"]);
    assert.match(readFileSync(join(bin, "docker"), "utf8"), new RegExp(`-- '${real}/docker' "\\$@"`), "wrapper skipped at write time, real binary baked");
    assert.deepEqual(warnings, []);
    // Force the runtime guard: bake the wrapper itself, as a shim written before the wrapper appeared would.
    writeFileSync(join(bin, "docker"), heavyShimScript("docker", join(wrap, "docker")));
    chmodSync(join(bin, "docker"), 0o755);
    const r = spawnSync(join(bin, "docker"), ["--version"], { env: { ...process.env, PATH: `${bin}:${wrap}:${real}:/usr/bin:/bin`, FORGE_HEAVY_DISABLED: "1" }, encoding: "utf8", timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Docker version 1/);
    assert.equal(readFileSync(log, "utf8"), "w\nr\n", "wrapper and real binary each ran once (two shim node processes at most)");
  });

  it("a name+cmd seen twice resolves past the shim and chain dirs; no match or depth above the cap is env.shim_loop", () => {
    const d = tmpDir("heavy-chain-"), a = join(d, "a"), b = join(d, "b"), s = join(d, "s");
    for (const x of [a, b, s]) { mkdirSync(x, { recursive: true }); writeFileSync(join(x, "tsc"), '#!/bin/sh\nexec "$(command -v tsc)" "$@"\n'); chmodSync(join(x, "tsc"), 0o755); }
    const env = { PATH: [s, a, b].join(":"), FORGE_HEAVY_SHIM_DIR: s };
    const first = guardChain("tsc", join(a, "tsc"), env);
    assert.equal(first.cmd, join(a, "tsc")); assert.equal(first.env.FORGE_HEAVY_CHAIN, `tsc:${join(a, "tsc")}`);
    const again = guardChain("tsc", join(a, "tsc"), first.env);
    assert.equal(again.cmd, join(b, "tsc"));
    assert.equal(again.env.FORGE_HEAVY_CHAIN, `tsc:${join(a, "tsc")}|tsc:${join(b, "tsc")}`);
    const none = guardChain("tsc", join(b, "tsc"), { ...again.env, PATH: [s, a, b].join(":") });
    assert.match(none.error, /^env\.shim_loop: tsc .*no other tsc/);
    const deep = guardChain("tsc", "/x/tsc", { ...env, FORGE_HEAVY_CHAIN: Array.from({ length: SHIM_LOOP_MAX }, (_, i) => `tsc:/d${i}/tsc`).join("|") });
    assert.match(deep.error, /^env\.shim_loop: tsc re-entered .*more than 4 times.*\/d0/);
  });

  it("a nested call to the same real binary (not a wrapper) passes through at any depth, unrecorded", async () => {
    const real = "/home/u/.nvm/bin/npm", spawned = [];
    const run = async (cmd, a, e) => { spawned.push([cmd, e.FORGE_HEAVY_CHAIN]); return { code: 0, signal: null }; };
    const chain = Array.from({ length: SHIM_LOOP_MAX - 1 }, (_, i) => `npm:/d${i}/npm`).concat(`npm:${real}`).join("|");
    for (const FORGE_HEAVY_CHAIN of [`npm:${real}`, chain]) {
      const env = { PATH: "/shim:/home/u/.nvm/bin", FORGE_HEAVY_CHAIN, FORGE_HEAVY_HELD: "1" };
      assert.equal((await runWrapped(["run", "--name", "npm", "--", real, "run", "build"], { env, run })).code, 0);
    }
    assert.equal(chain.split("|").length, SHIM_LOOP_MAX);
    assert.deepEqual(spawned, [[real, `npm:${real}`], [real, chain]]);
  });

  it("runWrapped refuses to spawn on a loop and records the chain otherwise", async () => {
    const spawned = [];
    const run = async (cmd, a, e) => { spawned.push([cmd, e.FORGE_HEAVY_CHAIN]); return { code: 0, signal: null }; };
    const env = { FORGE_HEAVY_HELD: "1", FORGE_HEAVY_CHAIN: Array.from({ length: SHIM_LOOP_MAX }, (_, i) => `x:/d${i}/x`).join("|") };
    assert.equal((await runWrapped(["run", "--name", "x", "--", "/r/x"], { env, run })).code, 126);
    assert.deepEqual(spawned, []);
    await runWrapped(["run", "--name", "x", "--", "/r/x"], { env: { FORGE_HEAVY_HELD: "1" }, run });
    assert.deepEqual(spawned, [["/r/x", "x:/r/x"]]);
  });

  it("wrapper detection: PATH-lookup shell scripts only; a wrapper with nothing behind it is skipped with a warning", async () => {
    assert.ok(isPassThroughWrapper('#!/bin/sh\nexec "$(command -v docker)" "$@"', "docker"));
    assert.ok(!isPassThroughWrapper("#!/bin/sh\necho hi\n", "docker"));
    assert.ok(!isPassThroughWrapper("\x7fELF command -v docker", "docker"));
    const d = tmpDir("heavy-skip-"), wrap = join(d, "wrap"), bin = join(d, "bin");
    mkdirSync(wrap, { recursive: true });
    writeFileSync(join(wrap, "docker"), '#!/bin/sh\nexec "$(command -v docker)" "$@"\n'); chmodSync(join(wrap, "docker"), 0o755);
    const warnings = [];
    assert.deepEqual(await writeHeavyShims(bin, { path: `${bin}:${wrap}`, warn: (m) => warnings.push(m) }), []);
    assert.equal(warnings.length, 1); assert.match(warnings[0], /docker .*wrapper/);
    assert.ok(!existsSync(join(bin, "docker")));
  });
});

describe("validation steps and the local lane cap (#4777)", () => {
  it("python project managers, promtool, pip, make and python -m <test runner> are heavy; metadata and plain scripts are llm", () => {
    const heavy = [["poetry", ["run", "pytest", "-q"]], ["poetry", ["run", "python", "-m", "pytest"]], ["uv", ["run", "--", "pytest"]], ["poetry", ["install"]], ["uv", ["sync"]],
      ["promtool", ["test", "rules", "r.yml"]], ["promtool", ["check", "config", "p.yml"]], ["pip", ["install", "x"]], ["python3", ["-m", "pytest"]], ["ruff", ["check", "."]], ["make", ["test"]]];
    for (const [n, a] of heavy) assert.equal(classifyStep(n, a), "heavy", `${n} ${a.join(" ")}`);
    const llm = [["poetry", ["--version"]], ["poetry", ["run", "python", "x.py"]], ["poetry", ["show"]], ["promtool", ["query", "instant", "u", "q"]], ["python", ["x.py"]], ["python3", ["-c", "print(1)"]], ["make", ["--version"]]];
    for (const [n, a] of llm) assert.equal(classifyStep(n, a), "llm", `${n} ${a.join(" ")}`);
    for (const n of ["poetry", "uv", "promtool", "pip", "python3", "make"]) assert.ok(HEAVY_BINS.includes(n), n);
  });

  it("localLaneCap follows cores and free memory, keeps at least one lane, and is off when admission is disabled or probes are unknown", () => {
    assert.equal(localLaneCap({ cores: 4, memAvailableMb: 64000 }), 4);
    assert.equal(localLaneCap({ cores: 4, memAvailableMb: 64000, cfg: { lane_cpu_reservation: 2 } }), 2);
    assert.equal(localLaneCap({ cores: 16, memAvailableMb: 2048 + 3 * 2048 + 10 }), 3, "memory binds: (free - min_free_mem_mb) / lane_mem_mb");
    assert.equal(localLaneCap({ cores: 4, memAvailableMb: 100 }), 1);
    assert.equal(localLaneCap({ cores: 4, memAvailableMb: 64000, cfg: { enabled: false } }), null);
    assert.equal(localLaneCap({}), null);
    assert.equal(localLaneCap({ cores: 8 }), 8);
  });

  it("liveLaneCap re-probes at each call and honours global_parallel", () => {
    const h = { c: 4, m: 64000 };
    const cap = liveLaneCap(null, { cfg: {}, host: { cores: () => h.c, memAvailableMb: () => h.m } });
    assert.equal(cap(), 4); h.c = 2; assert.equal(cap(), 2);
    assert.equal(liveLaneCap(1, { cfg: {}, host: { cores: () => 8, memAvailableMb: () => 64000 } })(), 1);
    assert.equal(liveLaneCap(3, { cfg: { enabled: false }, host: { cores: () => 8, memAvailableMb: () => 64000 } })(), 3);
  });
});
