// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** #5985: closed-loop lane concurrency. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeController, classifyRepo, conditionCleared, formatConcurrency, poolReason, REFUSAL_HOLD_MS } from "./concurrency.mjs";

const green = { load_per_core: 0.4, mem_available_gb: 12 };
const mk = (o = {}) => { const c = { t: 1_000_000 }; return { c, ctl: makeController({ ceiling: 8, now: () => c.t, ...o }) }; };

describe("controller (#5985)", () => {
  it("halves on pool.host_load, increases +1 under a green pool, never above the ceiling or below 1", () => {
    const { c, ctl } = mk();
    assert.equal(ctl.operating(), 8, "no signal: K is the ceiling");
    const e = ctl.refused({ issue: 1, code: "pool.host_load", live: { load_per_core: 2.2 } });
    assert.equal(e.change, "decrease");
    assert.equal(ctl.operating(), 4);
    assert.equal(ctl.observe(green), null, "refusal in the last N minutes: no increase");
    c.t += REFUSAL_HOLD_MS;
    assert.equal(ctl.observe(green).change, "increase");
    assert.equal(ctl.operating(), 5);
    for (let i = 0; i < 10; i++) ctl.observe(green);
    assert.equal(ctl.operating(), 8);
    assert.equal(ctl.limiting(), "ceiling");
    for (let i = 0; i < 6; i++) { c.t += 2000; ctl.refused({ code: "pool.host_mem" }); }
    assert.equal(ctl.operating(), 1);
  });
  it("a high load alone halves; an unknown pool and a non-pool refusal leave K unchanged", () => {
    const { ctl } = mk();
    assert.equal(ctl.refused({ code: "sandbox.capacity" }), null);
    assert.equal(ctl.observe(null), null);
    assert.equal(ctl.observe({ load_per_core: 0.2 }), null);
    assert.ok(ctl.refused({ live: { load_per_core: 1.8 } }));
    assert.equal(ctl.operating(), 4);
    assert.equal(ctl.limiting(), "host_load");
  });
  it("a red pool (low memory or load >= 1.5) does not increase", () => {
    const { c, ctl } = mk();
    ctl.refused({ code: "pool.host_load" }); c.t += REFUSAL_HOLD_MS * 4;
    assert.equal(ctl.observe({ load_per_core: 1.8, mem_available_gb: 12 }), null);
    assert.equal(ctl.observe({ load_per_core: 0.3, mem_available_gb: 5 }), null);
  });
  it("#6204: a host sitting at 1.0-1.5/core recovers toward the ceiling slowly after quiet, and never within the first hold", () => {
    const { c, ctl } = mk();
    ctl.refused({ code: "pool.host_load" }); // 8 -> 4
    const mid = { load_per_core: 1.2, mem_available_gb: 12 };
    c.t += REFUSAL_HOLD_MS;
    assert.equal(ctl.observe(mid), null, "one hold of quiet is not enough at moderate load");
    c.t += REFUSAL_HOLD_MS * 2;
    assert.equal(ctl.observe(mid).change, "increase");
    assert.equal(ctl.observe(mid), null, "grows are paced");
    for (let i = 0; i < 4; i++) { c.t += REFUSAL_HOLD_MS; ctl.observe(mid); }
    assert.equal(ctl.operating(), 8);
    assert.equal(ctl.limiting(), "ceiling");
  });
  it("classifies heavy repos from usage-history cpu_avg > 1.5 and caps heavy lanes below light", () => {
    const rows = [{ repo: "a/h", cpu_avg: 3 }, { repo: "a/h", cpu_avg: 2 }, { repo: "a/l", cpu_avg: 0.4 }];
    assert.equal(classifyRepo(rows, "a/h"), "heavy");
    assert.equal(classifyRepo(rows, "a/l"), "light");
    assert.equal(classifyRepo(rows, "a/none"), "light", "no history: light");
    const { ctl } = mk({ ceiling: 16 });
    assert.equal(ctl.operating("light"), 16);
    assert.equal(ctl.operating("heavy"), 6);
    assert.equal(ctl.limiting("heavy"), "heavy cap");
  });
  it("names the cleared condition and formats running/K/ceiling (limiting factor)", () => {
    assert.equal(conditionCleared("pool.host_load", { load_per_core: 1.2 }), false);
    assert.equal(conditionCleared("host_load", { load_per_core: 0.9 }), true);
    assert.equal(conditionCleared("pool.host_mem", { mem_available_gb: 9 }), true);
    assert.equal(conditionCleared("pool.host_mem", {}), null);
    assert.equal(conditionCleared("pool.projected_peak", green), null);
    assert.equal(poolReason("pool.disk_cap"), "disk");
    assert.equal(poolReason("sandbox.capacity"), "");
    assert.equal(formatConcurrency({ running: 3, k: 4, ceiling: 8, factor: "host_load" }), "concurrency: 3/4/8 (host_load)");
  });
});

describe("503-storm replay (#5985)", () => {
  it("at most 1 refusal per lane per 5 min: refused lanes hold until the condition clears", () => {
    const fx = JSON.parse(readFileSync(new URL("./fixtures/capacity-storm.json", import.meta.url), "utf8"));
    const c = { t: 0 };
    const ctl = makeController({ ceiling: fx.lanes, now: () => c.t });
    const byLane = new Map();
    for (const a of fx.attempts) (byLane.get(a.lane) ?? byLane.set(a.lane, []).get(a.lane)).push(a);
    const refusals = new Map();
    for (c.t = 0; c.t <= fx.endMs; c.t += fx.pollMs) {
      const cap = c.t < fx.clearsAtMs ? { load_per_core: 2.1, mem_available_gb: 1.2 } : { load_per_core: 0.6, mem_available_gb: 9 };
      ctl.observe(cap);
      for (const [lane, rows] of byLane) {
        if (ctl.holding(lane, cap)) continue;
        const storm = c.t < fx.clearsAtMs;
        if (!storm) { ctl.release(lane); continue; }
        const rec = rows.reduce((b, r) => (Math.abs(r.at - c.t) < Math.abs(b.at - c.t) ? r : b)); // the recorded refusal code nearest this attempt
        ctl.refused({ issue: lane, code: rec.code, live: cap });
        (refusals.get(lane) ?? refusals.set(lane, []).get(lane)).push(c.t);
      }
    }
    assert.ok(refusals.size === fx.lanes);
    for (const [lane, ts] of refusals) for (let i = 0; i < ts.length; i++) {
      const inWin = ts.filter((x) => x >= ts[i] && x < ts[i] + 300_000).length;
      assert.ok(inWin <= 1, `lane ${lane}: ${inWin} refusals within 5 min`);
    }
    const unreplayed = fx.attempts.length; // the unconstrained timer retry would have refused each lane every minute
    assert.ok([...refusals.values()].flat().length < unreplayed / 3);
  });
});

describe("heavy lanes in orchestrate (#5985)", () => {
  it("a heavy repo's lanes run at most the heavy cap at once while light lanes keep the rest of K", async () => {
    const { orchestrate } = await import("./orchestrate.mjs");
    const usageRows = [{ repo: "o/heavy", cpu_avg: 3 }, { repo: "o/light", cpu_avg: 0.3 }];
    const run = async (repo) => {
      let cur = 0, max = 0;
      const events = [];
      await orchestrate({ issues: [1, 2, 3, 4, 5, 6], parallel: 6, usageRows: () => usageRows, repoSlug: "o/none", repoOf: () => repo, readBody: async () => "", onUpdate: (e) => events.push(e),
        sleep: async () => { await new Promise((r) => setImmediate(r)); },
        runOne: async () => { cur++; max = Math.max(max, cur); await new Promise((r) => setTimeout(r, 20)); cur--; return { terminalReason: "merged", pr: 1 }; } });
      return { max, events };
    };
    const heavy = await run("o/heavy"), light = await run("o/light");
    assert.equal(heavy.max, 2, "ceiling 6, heavy cap ceil(6/3)");
    assert.equal(light.max, 6);
    assert.ok(heavy.events.some((e) => e.event === "concurrency" && e.change === "heavy-cap"));
  });
});
