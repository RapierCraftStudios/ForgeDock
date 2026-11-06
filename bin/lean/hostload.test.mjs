// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5174: host overload hold (orchestrate grant), status host line, heavy-step niceness.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPriority } from "node:os";
import { OVERLOAD_DEFAULTS, HEAVY_NICE, overloadThreshold, hostOverload, liveOverload, formatOverload, formatHostLoad, lowerPriority, spawnIoniceIdle } from "./hostload.mjs";
import { orchestrate } from "./orchestrate.mjs";
import { spawnInherit, runWrapped } from "./heavy.mjs";

const host = (load1, cores) => ({ loadAvg1: () => load1, cores: () => cores });
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms ?? 1, 5)));

describe("#5174 hostload", () => {
  it("overloadThreshold: default 2, > 0 sets, 0 disables, invalid is the default", () => {
    assert.equal(OVERLOAD_DEFAULTS.load_per_core, 2);
    assert.equal(overloadThreshold({}), 2);
    assert.equal(overloadThreshold(), 2);
    assert.equal(overloadThreshold({ overload_load_per_core: 3.5 }), 3.5);
    assert.equal(overloadThreshold({ overload_load_per_core: 0 }), null);
    assert.equal(overloadThreshold({ overload_load_per_core: -1 }), 2);
    assert.equal(overloadThreshold({ overload_load_per_core: "x" }), 2);
  });

  it("hostOverload: overloaded only when load1/cores > threshold; unreadable probes and a disabled threshold never are", () => {
    assert.deepEqual(hostOverload({ threshold: 2, host: host(18, 4) }), { overloaded: true, load1: 18, cores: 4, perCore: 4.5, threshold: 2 });
    assert.equal(hostOverload({ threshold: 2, host: host(8, 4) }).overloaded, false, "exactly at the threshold is not over it");
    assert.equal(hostOverload({ threshold: 2, host: host(4, 4) }).overloaded, false);
    assert.equal(hostOverload({ threshold: null, host: host(18, 4) }).overloaded, false);
    assert.equal(hostOverload({ threshold: 2, host: { loadAvg1: () => { throw new Error("no /proc"); }, cores: () => 4 } }).overloaded, false);
    assert.equal(hostOverload({ threshold: 2, host: host(NaN, 4) }).overloaded, false);
    assert.equal(hostOverload({ threshold: 2, host: host(18, 0) }).overloaded, false);
    assert.equal(liveOverload({ overload_load_per_core: 1 }, { host: host(18, 4) })().overloaded, true);
    assert.equal(liveOverload({ overload_load_per_core: 0 }, { host: host(18, 4) })().overloaded, false);
    const live = liveOverload({})();
    assert.equal(typeof live.overloaded, "boolean");
  });

  it("formatOverload / formatHostLoad render the status lines", () => {
    const over = hostOverload({ threshold: 2, host: host(18, 4) });
    assert.equal(formatOverload(over), "host_overloaded (load 4.5/core > 2): new local admissions held");
    assert.equal(formatHostLoad(over), "host_overloaded (load 4.5/core > 2): new local admissions held");
    const ok = hostOverload({ threshold: 2, host: host(2, 4) });
    assert.equal(formatOverload(ok), null);
    assert.equal(formatHostLoad(ok), "load 0.5/core (threshold 2)");
    assert.equal(formatHostLoad(hostOverload({ threshold: null, host: host(2, 4) })), "load 0.5/core (overload hold off)");
    assert.equal(formatHostLoad(null), null);
    assert.equal(formatOverload(undefined), null);
  });

  it("lowerPriority: nice 10, ionice idle on Linux only, never throws", () => {
    const calls = [];
    assert.equal(lowerPriority(123, { setPriority: (p, l) => calls.push(["nice", p, l]), spawnIonice: (p) => calls.push(["ionice", p]), platform: "linux" }), true);
    assert.deepEqual(calls, [["nice", 123, HEAVY_NICE], ["ionice", 123]]);
    calls.length = 0;
    assert.equal(lowerPriority(123, { setPriority: (p, l) => calls.push(["nice", p, l]), spawnIonice: (p) => calls.push(["ionice", p]), platform: "darwin" }), true);
    assert.deepEqual(calls, [["nice", 123, 10]]);
    assert.equal(lowerPriority(123, { setPriority: () => { throw new Error("EPERM"); }, spawnIonice: () => { throw new Error("x"); }, platform: "linux" }), false);
    assert.equal(lowerPriority(0), false);
    assert.equal(lowerPriority(undefined), false);
    const spawned = [];
    assert.equal(spawnIoniceIdle(42, { find: () => "/usr/bin/ionice", run: (c, a, o) => { spawned.push([c, a, o.detached]); return { on() {}, unref() {} }; } }), true);
    assert.deepEqual(spawned, [["/usr/bin/ionice", ["-c3", "-p", "42"], true]]);
    assert.equal(spawnIoniceIdle(42, { find: () => null, run: () => assert.fail("no ionice") }), false);
  });

  it("spawnInherit runs onSpawn with the child; a real heavy child ends up at nice 10 and its exit code propagates", async () => {
    let pid = null, nice = null;
    const r = await spawnInherit(process.execPath, ["-e", "setTimeout(() => process.exit(4), 300)"], process.env, (c) => {
      pid = c.pid; lowerPriority(c.pid); try { nice = getPriority(c.pid); } catch { nice = null; }
    });
    assert.deepEqual(r, { code: 4, signal: null });
    assert.ok(Number.isInteger(pid));
    assert.equal(nice, Math.max(HEAVY_NICE, getPriority()), "the heavy child runs at nice 10 (or the parent's, if already lower)");
  });

  it("runWrapped passes the priority hook on the gated path only (llm and nested steps pass through)", async () => {
    const seen = [];
    const run = async (cmd, args, env, onSpawn) => { seen.push(typeof onSpawn); return { code: 0, signal: null }; };
    const open = () => ({ stats: () => ({ holders: 0 }) });
    const host2 = { memAvailableMb: () => 64000, cores: () => 8 };
    await runWrapped(["run", "--name", "x", "--", "/r/x"], { env: { FORGE_HEAVY_HELD: "1" }, run, host: host2, open });
    await runWrapped(["run", "--name", "claude", "--", "/r/claude"], { env: { FORGE_HEAVY_DISABLED: "1" }, run, host: host2, open });
    assert.deepEqual(seen, ["undefined", "undefined"]);
  });

  it("orchestrate holds new local admissions while overloaded, one host-overloaded row per episode, then admits", async () => {
    let over = true, probes = 0;
    const snap = () => { probes++; return hostOverload({ threshold: 2, host: host(over ? 18 : 2, 4) }); };
    const rows = [], started = [];
    const runOne = async (n) => { started.push(n); return { terminalReason: "merged", pr: n }; };
    const done = orchestrate({ issues: [1, 2], parallel: 2, runOne, readBody: async () => "", overload: snap, onUpdate: (r) => rows.push(r), pollMs: 1, sleep });
    for (let i = 0; i < 200 && probes < 5; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(started, [], "nothing admitted while overloaded");
    over = false;
    const out = await done;
    assert.deepEqual(out.map((r) => r.outcome).sort(), ["merged", "merged"]);
    const held = rows.filter((r) => r.outcome === "host-overloaded");
    assert.equal(held.length, 1, "one row per episode");
    assert.equal(held[0].detail, "host_overloaded (load 4.5/core > 2): new local admissions held");
  });

  it("a throwing probe is not overloaded; remote placements are never held", async () => {
    const started = [];
    const runOne = async (n) => { started.push(n); return { terminalReason: "merged", pr: n }; };
    await orchestrate({ issues: [1], parallel: 1, runOne, readBody: async () => "", overload: () => { throw new Error("x"); }, pollMs: 1, sleep });
    assert.deepEqual(started, [1]);
    let probes = 0;
    const out = await orchestrate({ issues: [2], parallel: 1, runOne, readBody: async () => "", pollMs: 1, sleep,
      overload: () => { probes++; return { overloaded: true }; }, remote: { max: 1, isRemote: () => true } });
    assert.deepEqual(out.map((r) => r.outcome), ["merged"]);
    assert.equal(probes, 0, "the remote placement never consults the overload gate");
  });
});
