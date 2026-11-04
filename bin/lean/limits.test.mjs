// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { openLimits, laneBackendId, limitsFile } from "./limits.mjs";
import { orchestrate } from "./orchestrate.mjs";
import { limitsFromCli } from "../engine-cli.mjs";

const fakeClock = () => { const c = { t: 1_000_000 }; return { c, now: () => c.t, sleep: async (ms) => { c.t += ms; } }; };
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const storeFile = () => join(tmpDir("limits-"), "limits.json");
const limited = (id, until) => ({ terminalReason: "deferred", code: "rate_limited", resetAtEpochMs: until, backendId: id });

describe("account-scoped usage-limit holds (#4190)", () => {
  it("store: set keeps the later reset, expiry drops a hold, clear and clearAll remove holds", () => {
    const { c, now } = fakeClock();
    const file = storeFile();
    const a = openLimits(file, { now });
    assert.equal(a.holdUntil("A"), null);
    a.set("A", c.t + 1000, "batch b1 #1");
    a.set("A", c.t + 500, "batch b1 #2"); // an earlier reset never shortens the hold
    assert.equal(a.holdUntil("A"), c.t + 1000);
    assert.deepEqual(a.list().map((h) => [h.id, h.source]), [["A", "batch b1 #1"]]);
    // a second handle on the same file (another batch) sees the hold
    const b = openLimits(file, { now });
    assert.equal(b.holdUntil("A"), c.t + 1000);
    b.set("B", c.t + 5000, "batch b2 #9");
    assert.equal(a.holdUntil("B"), c.t + 5000);
    assert.equal(a.clear("B"), true);
    assert.equal(a.clear("B"), false);
    c.t += 1000; // expiry
    assert.equal(a.holdUntil("A"), null);
    a.set("C", c.t + 10, "x");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).holds), ["C"], "expired holds are pruned on write");
    assert.equal(a.clearAll(), 1);
    assert.deepEqual(a.list(), []);
  });

  it("store: a missing or corrupt file reads as no holds", () => {
    const file = storeFile();
    assert.deepEqual(openLimits(file).list(), []);
    writeFileSync(file, "{not json");
    assert.equal(openLimits(file).holdUntil("A"), null);
    openLimits(file).set("A", Date.now() + 60_000, "s");
    assert.ok(openLimits(file).holdUntil("A") > Date.now());
  });

  it("identity follows the account (CLAUDE_CONFIG_DIR) and the store path honours FORGEDOCK_LIMITS_FILE", () => {
    assert.notEqual(laneBackendId({ CLAUDE_CONFIG_DIR: "/acct/one" }), laneBackendId({ CLAUDE_CONFIG_DIR: "/acct/two" }));
    assert.equal(laneBackendId({ CLAUDE_CONFIG_DIR: "/acct/one" }), laneBackendId({ CLAUDE_CONFIG_DIR: "/acct/one" }));
    assert.equal(limitsFile({ FORGEDOCK_LIMITS_FILE: "/x/l.json" }), "/x/l.json");
    assert.match(limitsFile({}), /\.forge[/\\]limits\.json$/);
  });

  it("a hold is tied to the account: after an account switch the limited issue and the rest run at once", async () => {
    const { c, now, sleep } = fakeClock();
    const t0 = c.t;
    const limits = openLimits(storeFile(), { now });
    let acct = "A";
    const starts = {};
    let heldAtRetry;
    const rows = await orchestrate({ issues: [1, 2], parallel: 1, now, sleep, readBody: async () => "", limits, identity: () => acct, batchId: "b1",
      runOne: async (n) => {
        (starts[n] ??= []).push(now());
        if (n === 1 && starts[1].length === 1) { acct = "B"; return limited("A", t0 + 600_000); } // the operator switches accounts
        heldAtRetry ??= { A: limits.holdUntil("A"), B: limits.holdUntil("B"), source: limits.list()[0]?.source };
        return { terminalReason: "merged" };
      } });
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged"]);
    assert.equal(starts[2][0], t0, "#2 runs on account B without waiting for A's reset");
    assert.equal(starts[1][1], t0, "#1 is retried on account B at once");
    assert.deepEqual(heldAtRetry, { A: t0 + 600_000, B: null, source: "batch b1 #1" }, "A stays held in the host store; B is not");
  });

  it("a hold on the same account still waits for the reset", async () => {
    const { c, now, sleep } = fakeClock();
    const t0 = c.t;
    const limits = openLimits(storeFile(), { now });
    const starts = [];
    await orchestrate({ issues: [1], now, sleep, readBody: async () => "", limits, identity: () => "A",
      runOne: async () => { starts.push(now()); return starts.length === 1 ? limited("A", t0 + 600_000) : { terminalReason: "merged" }; } });
    assert.deepEqual(starts, [t0, t0 + 600_000]);
  });

  it("two batches on the same account share one hold; a batch on another account is not held", async () => {
    // Each batch is its own dispatcher with its own clock and its own handle on the one host file.
    const file = storeFile();
    const k1 = fakeClock(), t0 = k1.c.t;
    const b1 = [];
    await orchestrate({ issues: [1], now: k1.now, sleep: k1.sleep, readBody: async () => "", limits: openLimits(file, { now: k1.now }), identity: () => "A", batchId: "b1",
      runOne: async () => { b1.push(k1.now()); return b1.length === 1 ? limited("A", t0 + 600_000) : { terminalReason: "merged" }; } });
    const k2 = fakeClock(), same = [];
    await orchestrate({ issues: [7], now: k2.now, sleep: k2.sleep, readBody: async () => "", limits: openLimits(file, { now: k2.now }), identity: () => "A", batchId: "b2",
      runOne: async () => { same.push(k2.now()); return { terminalReason: "merged" }; } });
    assert.equal(same[0], t0 + 600_000, "batch 2 on account A waited for batch 1's hold");
    const k3 = fakeClock(), other = [];
    await orchestrate({ issues: [8], now: k3.now, sleep: k3.sleep, readBody: async () => "", limits: openLimits(file, { now: k3.now }), identity: () => "B", batchId: "b3",
      runOne: async () => { other.push(k3.now()); return { terminalReason: "merged" }; } });
    assert.equal(other[0], t0, "batch 3 on account B is not held");
  });

  it("clearing a hold lets a held batch admit on its next pass", async () => {
    const { c, now } = fakeClock();
    const t0 = c.t;
    const limits = openLimits(storeFile(), { now });
    limits.set("A", t0 + 3_600_000, "batch b0 #1");
    const starts = [];
    const sleep = async (ms) => { limits.clear("A"); c.t += ms; }; // faithful: a sleep advances the full time asked for
    await orchestrate({ issues: [1], now, sleep, readBody: async () => "", limits, identity: () => "A", getParallel: () => 1, pollMs: 5000,
      runOne: async () => { starts.push(now()); return { terminalReason: "merged" }; } });
    assert.equal(starts[0], t0 + 5000, "admitted on the poll after the clear, not at the hour-long reset");
  });

  it("a held batch polls the host store: limits clear admits within one poll without getCancelled or getParallel (#4446)", async () => {
    const { c, now } = fakeClock();
    const t0 = c.t;
    const file = storeFile();
    const limits = openLimits(file, { now });
    limits.set("A", t0 + 3_600_000, "batch b0 #1");
    const sleeps = [];
    // The operator clears the hold from another process (its own handle on the host file) while the batch sleeps.
    const sleep = async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 1) await quiet(() => limitsFromCli(["clear", "A"], { limits: openLimits(file, { now }), identity: () => "A" }));
      c.t += ms;
    };
    const starts = [];
    const rows = await orchestrate({ issues: [1, 2], parallel: 2, now, sleep, readBody: async () => "", limits, identity: () => "A", pollMs: 5000,
      runOne: async (n) => { starts.push([n, now()]); return { terminalReason: "merged" }; } });
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged"]);
    assert.ok(starts.every(([, at]) => at <= t0 + 30_000), `admitted within 30s of the clear, got ${JSON.stringify(starts)}`);
    assert.deepEqual(starts, [[1, t0 + 5000], [2, t0 + 5000]], "admitted on the first poll after the clear");
  });

  it("a held batch keeps waiting while the hold is present (#4446)", async () => {
    const { c, now } = fakeClock();
    const t0 = c.t;
    const limits = openLimits(storeFile(), { now });
    limits.set("A", t0 + 3_600_000, "batch b0 #1");
    const sleeps = [];
    const sleep = async (ms) => { sleeps.push(ms); c.t += ms; };
    const starts = [];
    await orchestrate({ issues: [1], now, sleep, readBody: async () => "", limits, identity: () => "A", pollMs: 5000,
      runOne: async () => { starts.push(now()); return { terminalReason: "merged" }; } });
    assert.deepEqual(starts, [t0 + 3_600_000], "admitted exactly at the reset, never earlier");
    assert.ok(sleeps.length > 1 && sleeps.every((ms) => ms > 0 && ms <= 5000), "re-read the store every poll while held");
  });

  it("a legacy batch-local holdUntil is ignored on resume and no longer persisted", async () => {
    const { c, now, sleep } = fakeClock();
    let state = { v: 1, order: [1], pending: [1], holdUntil: c.t + 3_600_000 };
    const store = { load: () => state, save: (s) => { state = s; } };
    const starts = [];
    const rows = await orchestrate({ issues: [], now, sleep, readBody: async () => "", store, limits: openLimits(storeFile(), { now }), identity: () => "A",
      runOne: async () => { starts.push(now()); return { terminalReason: "merged" }; } });
    assert.equal(rows[0].outcome, "merged");
    assert.equal(starts[0], 1_000_000);
    assert.equal("holdUntil" in state, false);
  });

  it("forgedock limits show lists holds and marks this account; clear <id> and clear --all drop them", async () => {
    const limits = openLimits(storeFile());
    const until = Date.now() + 600_000;
    limits.set("aaaa", until, "batch b1 #1");
    limits.set("bbbb", until, "batch b2 #2");
    const lines = [];
    const l = console.log; console.log = (s) => lines.push(s);
    let shown;
    try { shown = await limitsFromCli(["show"], { limits, identity: () => "aaaa" }); } finally { console.log = l; }
    assert.equal(shown.current, "aaaa");
    assert.equal(shown.holds.length, 2);
    assert.match(lines.join("\n"), new RegExp(`^\\* aaaa  until ${new Date(until).toISOString()}  source batch b1 #1$`, "m"));
    assert.match(lines.join("\n"), /^ {2}bbbb .*source batch b2 #2$/m);
    await quiet(() => limitsFromCli(["clear", "bbbb"], { limits, identity: () => "aaaa" }));
    assert.equal(limits.holdUntil("bbbb"), null);
    await assert.rejects(() => quiet(() => limitsFromCli(["clear", "bbbb"], { limits })), /no active usage-limit hold/);
    await assert.rejects(() => quiet(() => limitsFromCli(["clear"], { limits })), /usage: forgedock limits/);
    await assert.rejects(() => quiet(() => limitsFromCli(["nope"], { limits })), /usage: forgedock limits/);
    assert.deepEqual(await quiet(() => limitsFromCli(["clear", "--all"], { limits })), { cleared: 1 });
    assert.deepEqual(limits.list(), []);
  });
});

describe("#5095: a held pool account places hybrid lanes local", () => {
  const remoteFor = (extra = {}) => ({ max: 2, isRemote: () => true, place: () => ({ where: "remote", reason: "heavy" }), identity: () => "remote:pool", ...extra });
  const runWith = async ({ hold, remote }) => {
    const { c, now, sleep } = fakeClock();
    const limits = openLimits(storeFile(), { now });
    for (const [id, ms] of Object.entries(hold)) limits.set(id, c.t + ms, "test");
    const ctxs = [];
    const rows = await orchestrate({ issues: [1], parallel: 1, now, sleep, readBody: async () => "", limits, identity: () => "local", remote,
      runOne: async (n, _l, ctx) => { ctxs.push({ at: now() - 1_000_000, remote: ctx.remote, placement: ctx.placement }); return { terminalReason: "merged" }; } });
    return { rows, ctxs };
  };

  it("hybrid: a hold on the remote identity and none on the local one places the next admission local", async () => {
    const { rows, ctxs } = await runWith({ hold: { "remote:pool": 600_000 }, remote: remoteFor({ fallbackLocal: true }) });
    assert.equal(rows[0].outcome, "merged");
    assert.equal(ctxs.length, 1);
    assert.equal(ctxs[0].at, 0, "admitted at once, not held");
    assert.equal(ctxs[0].remote, false);
    assert.equal(ctxs[0].placement.where, "local");
    assert.match(ctxs[0].placement.reason, /fallback to local: pool usage limit until/);
  });

  it("remote-only: a held pool account waits for the reset; no hold places the lane remote", async () => {
    const held = await runWith({ hold: { "remote:pool": 600_000 }, remote: remoteFor() });
    assert.equal(held.ctxs[0].remote, true);
    assert.ok(held.ctxs[0].at >= 600_000, "the remote lane starts after the pool reset");
    const free = await runWith({ hold: {}, remote: remoteFor({ fallbackLocal: true }) });
    assert.deepEqual([free.ctxs[0].at, free.ctxs[0].remote, free.ctxs[0].placement.where], [0, true, "remote"]);
  });
});

describe("account rotator and usage-limit holds (#5094)", () => {
  it("#5094 rotator headroom: a rate_limited lane records no host hold and admissions continue", async () => {
    const { c, now, sleep } = fakeClock();
    const t0 = c.t;
    const limits = openLimits(storeFile(), { now });
    let acct = "acct-1";
    const rotator = { kind: "tokenbaton", accounts: [{ n: 1 }, { n: 2 }], headroom: () => true, resumeAt: () => now(),
      isAccount: (id) => id === "acct-1" || id === "acct-2", currentIdentity: () => acct };
    const starts = {};
    const rows = await orchestrate({ issues: [1, 2], parallel: 1, now, sleep, readBody: async () => "", limits, rotator, identity: () => laneBackendId({}, rotator), batchId: "b1",
      runOne: async (n) => {
        (starts[n] ??= []).push(now());
        if (n === 1 && starts[1].length === 1) { acct = "acct-2"; return limited("acct-1", t0 + 600_000); } // tokenbaton rotates
        return { terminalReason: "merged" };
      } });
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged"]);
    assert.deepEqual(limits.list(), [], "no host-wide hold while an account has headroom");
    assert.equal(starts[2][0], t0, "admissions continue");
    assert.equal(starts[1][1], t0, "the limited issue reruns at once on the next account");
  });

  it("#5094 a hold set for identity A does not block admissions once the rotator's active identity is B", async () => {
    const { c, now, sleep } = fakeClock();
    const t0 = c.t;
    const limits = openLimits(storeFile(), { now });
    limits.set("acct-1", t0 + 3_600_000, "batch b0 #1");
    const rotator = { currentIdentity: () => "acct-2" };
    const starts = [];
    await orchestrate({ issues: [1], now, sleep, readBody: async () => "", limits, identity: () => laneBackendId({}, rotator),
      runOne: async () => { starts.push(now()); return { terminalReason: "merged" }; } });
    assert.deepEqual(starts, [t0]);
  });

  it("#5094 #5095 a limited pool account keeps its own hold under a rotator with headroom; the host account is never held", async () => {
    const { c, now, sleep } = fakeClock();
    const t0 = c.t;
    const limits = openLimits(storeFile(), { now });
    const rotator = { accounts: [{ n: 1 }], headroom: () => true, resumeAt: () => now(), isAccount: (id) => id === "acct-1", currentIdentity: () => "acct-1" };
    const remote = { max: 2, fallbackLocal: true, isRemote: () => true, place: () => ({ where: "remote", reason: "heavy" }), identity: () => "remote:pool" };
    const runs = [];
    const rows = await orchestrate({ issues: [1, 2], parallel: 1, now, sleep, readBody: async () => "", limits, rotator, remote, identity: () => laneBackendId({}, rotator),
      runOne: async (n, _l, ctx) => {
        runs.push({ n, at: now(), where: ctx.placement?.where, poolHeld: limits.holdUntil("remote:pool"), hostHeld: limits.holdUntil("acct-1") });
        return n === 1 && runs.length === 1 ? limited("remote:pool", t0 + 600_000) : { terminalReason: "merged" };
      } });
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged"]);
    const second = runs.find((x) => x.n === 2);
    assert.equal(runs[0].where, "remote");
    assert.equal(second.at, t0, "the host account is not held: admissions continue");
    assert.equal(second.poolHeld, t0 + 600_000, "the pool's own hold is recorded (#5095)");
    assert.ok(!(second.hostHeld > now()), "no host-wide hold while the rotator has headroom");
    assert.equal(second.where, "local", "hybrid falls back local while the pool is held");
  });
});
