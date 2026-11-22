// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { areaOf, acquireHotArea, countCounters, counterGrowth, counterExempt } from "./hotarea.mjs";
import { LOCK_DIR } from "./branchlock.mjs";
import { tmpDir } from "../tests/_tmp.mjs";

const AREAS = [{ name: "billing", paths: ["src/billing/**"] }, { name: "auth", paths: ["src/auth.js"] }];

describe("hot areas (#5751)", () => {
  it("areaOf matches declared globs, and a named directory containing a glob's root", () => {
    assert.deepEqual(areaOf(["src/billing/reserve.js", "README.md"], AREAS), ["billing"]);
    assert.deepEqual(areaOf(["./src/auth.js", "src/billing/x.js"], AREAS), ["auth", "billing"]);
    assert.deepEqual(areaOf(["src/billing"], AREAS), ["billing"]);
    assert.deepEqual(areaOf(["docs/x.md"], AREAS), []);
    assert.deepEqual(areaOf(["src/billing/x.js"], []), [], "no declared areas: inert");
  });
  it("a second lane cannot enter a hot area another lane holds, and is told the holder", async () => {
    const dir = tmpDir("hotarea-");
    const a = await acquireHotArea({ gitCommonDir: dir, areas: ["billing"], owner: "lane-A", alive: () => true });
    assert.equal(a.ok, true);
    assert.ok(readdirSync(join(dir, LOCK_DIR)).includes(encodeURIComponent("hot-area:billing")));
    const b = await acquireHotArea({ gitCommonDir: dir, areas: ["billing"], owner: "lane-B", alive: () => true });
    assert.equal(b.ok, false);
    assert.equal(b.area, "billing");
    assert.equal(b.holder.owner, "lane-A");
    assert.equal((await acquireHotArea({ gitCommonDir: dir, areas: ["auth"], owner: "lane-B", alive: () => true })).ok, true, "another area is independent");
  });
  it("a refused lane holds nothing: locks taken before the refusal are released", async () => {
    const dir = tmpDir("hotarea-");
    await acquireHotArea({ gitCommonDir: dir, areas: ["billing"], owner: "lane-A", alive: () => true });
    const b = await acquireHotArea({ gitCommonDir: dir, areas: ["billing", "auth"], owner: "lane-B", alive: () => true });
    assert.equal(b.ok, false);
    assert.equal((await acquireHotArea({ gitCommonDir: dir, areas: ["auth"], owner: "lane-C", alive: () => true })).ok, true);
  });
  it("release lets a waiting lane in; a dead holder is taken over", async () => {
    const dir = tmpDir("hotarea-");
    const a = await acquireHotArea({ gitCommonDir: dir, areas: ["billing"], owner: "lane-A", alive: () => true });
    let waited = 0;
    const b = await acquireHotArea({ gitCommonDir: dir, areas: ["billing"], owner: "lane-B", alive: () => true, waitMs: 1000, pollMs: 10, sleep: async () => { if (++waited === 2) a.release(); } });
    assert.equal(b.ok, true);
    b.release();
    assert.equal(existsSync(join(dir, LOCK_DIR, encodeURIComponent("hot-area:billing"))), false);
    mkdirSync(join(dir, LOCK_DIR), { recursive: true });
    writeFileSync(join(dir, LOCK_DIR, encodeURIComponent("hot-area:auth")), JSON.stringify({ owner: "gone", pid: 999999 }));
    assert.equal((await acquireHotArea({ gitCommonDir: dir, areas: ["auth"], owner: "lane-C", alive: (p) => p !== 999999 })).ok, true);
  });
});

describe("named counters (#5751)", () => {
  it("countCounters sums git grep -c at a ref; no match counts 0", async () => {
    const calls = [];
    const git = async (a) => { calls.push(a); if (a.includes("NONE")) throw new Error("exit 1"); return "origin/main:src/a.js:3\norigin/main:src/b.js:2\n"; };
    const c = await countCounters({ git, ref: "origin/main", counters: [{ name: "flags", pattern: "FLAG_", paths: ["src/**"] }, { name: "none", pattern: "NONE", paths: [] }] });
    assert.deepEqual(c, { flags: 5, none: 0 });
    assert.deepEqual(calls[0], ["grep", "-c", "-E", "-e", "FLAG_", "origin/main", "--", "src/**"]);
    assert.deepEqual(calls[1].slice(-2), ["--", "."]);
  });
  it("growth fails without a decision and passes with a counter-ok decision", () => {
    const f = counterGrowth({ before: { flags: 5 }, after: { flags: 6 }, contract: { decisions: [] } });
    assert.equal(f.length, 1);
    assert.equal(f[0].code, "maintenance.counter_growth");
    assert.equal(counterGrowth({ before: { flags: 5 }, after: { flags: 6 }, contract: { decisions: [{ choice: "counter-ok: flags one rollout flag, removed in #9" }] } }).length, 0);
    assert.equal(counterGrowth({ before: { flags: 5 }, after: { flags: 6 }, result: { amendments: [{ kind: "decision", decision: { choice: "counter-ok: flags needed" }, why: "x" }] } }).length, 0);
    assert.equal(counterExempt("flags", { decisions: [{ choice: "counter-ok: flags" }] }), false, "a reason is required");
    assert.equal(counterExempt("flags", { decisions: [{ choice: "counter-ok: flagsx because" }] }), false, "another counter's decision does not exempt");
    assert.equal(counterGrowth({ before: { flags: 5 }, after: { flags: 5 } }).length, 0);
    assert.equal(counterGrowth({ before: null, after: { flags: 9 } }).length, 0);
  });
});
