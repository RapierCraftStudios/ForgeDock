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

  it("#5094 #5095 #5203 a limited pool account rotates under a rotator with headroom (no pool hold); once every account was tried it keeps its own hold", async () => {
    const { c, now, sleep } = fakeClock();
    const t0 = c.t;
    const limits = openLimits(storeFile(), { now });
    const rotator = { accounts: [{ n: 1 }], headroom: () => true, resumeAt: () => now(), isAccount: (id) => id === "acct-1", currentIdentity: () => "acct-1" };
    const remote = { max: 2, fallbackLocal: true, isRemote: () => true, place: () => ({ where: "remote", reason: "heavy" }), identity: () => "remote:pool" };
    const runs = [], pausedHolds = [];
    const rows = await orchestrate({ issues: [1, 2], parallel: 1, now, sleep, readBody: async () => "", limits, rotator, remote, identity: () => laneBackendId({}, rotator),
      onUpdate: (u) => { if (u.outcome === "paused") pausedHolds.push(limits.holdUntil("remote:pool")); },
      runOne: async (n, _l, ctx) => {
        runs.push({ n, at: now(), where: ctx.placement?.where, poolHeld: limits.holdUntil("remote:pool"), hostHeld: limits.holdUntil("acct-1") });
        return n === 1 && runs.filter((x) => x.n === 1).length <= 2 ? limited("remote:pool", t0 + 600_000) : { terminalReason: "merged" };
      } });
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged"]);
    const ones = runs.filter((x) => x.n === 1);
    assert.equal(ones[0].where, "remote");
    assert.equal(ones[1].at, t0, "the pool limit reruns at once (the router hands out another login, #5165)");
    assert.equal(ones[1].poolHeld, null, "no pool hold while an account has headroom (#5203)");
    assert.equal(ones[1].where, "remote");
    assert.ok(runs.every((x) => !(x.hostHeld > x.at)), "no host-wide hold while the rotator has headroom");
    // the second limit exhausted the one-account rotation budget: the pool's own hold applies again (#5095)
    assert.deepEqual(pausedHolds, [null, t0 + 600_000], "only the second limit records the pool hold (#5095)");
  });

  it("#5203 a rate-limited pool lane with another usable account rotates and sets no batch-wide notBefore", async () => {
    const { c, now, sleep } = fakeClock();
    const t0 = c.t;
    const limits = openLimits(storeFile(), { now });
    const rotator = { accounts: [{ n: 1 }, { n: 3 }, { n: 5 }], headroom: () => true, resumeAt: () => now(), isAccount: (id) => /^acct-/.test(id), currentIdentity: () => "acct-1" };
    const remote = { max: 2, fallbackLocal: false, isRemote: () => true, place: () => ({ where: "remote", reason: "heavy" }), identity: () => "remote:pool" };
    let state = null;
    const store = { load: () => state, save: (s) => { state = JSON.parse(JSON.stringify(s)); } };
    const runs = [];
    const rows = await orchestrate({ issues: [1, 2, 3], parallel: 1, now, sleep, readBody: async () => "", limits, rotator, remote, store, identity: () => laneBackendId({}, rotator),
      runOne: async (n) => {
        runs.push({ n, at: now(), poolHeld: limits.holdUntil("remote:pool"), notBefore: { ...(state?.notBefore ?? {}) }, quota: state?.quota?.[1] ?? null });
        return n === 1 && runs.length === 1 ? limited("remote:pool", t0 + 2 * 3_600_000) : { terminalReason: "merged" };
      } });
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged", "merged"]);
    assert.ok(runs.every((x) => x.at === t0), "every lane starts at once: nothing waits for the limited account's reset");
    const rerun = runs.filter((x) => x.n === 1)[1];
    assert.equal(rerun.quota.rotations, 1, "rotations >= 1");
    assert.equal(rerun.poolHeld, null, "no pool hold");
    assert.ok(runs.every((x) => Object.values(x.notBefore).every((v) => !(v > t0))), "no batch-wide notBefore");
  });

  it("#5203 when every account is limited, the pool hold and notBefore are the earliest reset across accounts", async () => {
    const { c, now, sleep } = fakeClock();
    const t0 = c.t;
    let everyLimited = false; // the rotator has headroom until the lane reports the limit
    const earliest = t0 + 1_800_000, laneReset = t0 + 3 * 3_600_000;
    const limits = openLimits(storeFile(), { now });
    const rotator = { accounts: [{ n: 1 }, { n: 2 }], headroom: () => !everyLimited || now() >= earliest, resumeAt: () => Math.max(earliest, now()), isAccount: (id) => /^acct-/.test(id), currentIdentity: () => "acct-1" };
    const remote = { max: 2, fallbackLocal: false, isRemote: () => true, place: () => ({ where: "remote", reason: "heavy" }), identity: () => "remote:pool" };
    let poolHold = null;
    const runs = [], log = [];
    const rows = await orchestrate({ issues: [1, 2], parallel: 1, now, sleep, readBody: async () => "", limits, rotator, remote, identity: () => laneBackendId({}, rotator),
      onUpdate: (u) => { log.push(u); if (u.outcome === "paused") poolHold = limits.holdUntil("remote:pool"); },
      runOne: async (n) => {
        runs.push({ n, at: now() });
        if (n === 1 && runs.length === 1) { everyLimited = true; return limited("remote:pool", laneReset); }
        return { terminalReason: "merged" };
      } });
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged"]);
    assert.equal(poolHold, earliest, "the pool hold (the notBefore of every remote-placed issue) is the earliest reset across accounts, not the lane's own");
    assert.equal(runs.find((x) => x.n === 2).at, earliest, "the next lane starts at the earliest reset");
    assert.match(log.find((u) => u.outcome === "paused").detail, new RegExp(`until ${new Date(earliest).toISOString()}`));
  });

  it("#5203 --requeue of a quota-paused pending issue clears its notBefore and the pool hold", async () => {
    const { c, now, sleep } = fakeClock();
    const t0 = c.t;
    const limits = openLimits(storeFile(), { now });
    const remote = { max: 2, fallbackLocal: false, isRemote: () => true, place: () => ({ where: "remote", reason: "heavy" }), identity: () => "remote:pool" };
    let paused = false;
    const runs = [], log = [];
    const rows = await orchestrate({ issues: [1], parallel: 1, now, sleep, pollMs: 5000, readBody: async () => "", limits, remote, identity: () => "local", onUpdate: (u) => log.push(u),
      getRequeued: () => (paused ? [{ issue: 1, reason: "accounts 1, 3, 5 usable", by: "operator", at: "2026-11-07T08:05:00Z" }] : []),
      runOne: async (n) => {
        runs.push({ n, at: now() });
        if (runs.length === 1) { paused = true; return limited("remote:pool", t0 + 2 * 3_600_000); }
        return { terminalReason: "merged" };
      } });
    assert.equal(rows[0].outcome, "merged");
    assert.equal(runs.length, 2);
    assert.ok(runs[1].at < t0 + 60_000, `the released issue runs on the next poll, not at the reset (ran at +${runs[1].at - t0}ms)`);
    assert.equal(limits.holdUntil("remote:pool"), null, "the pool hold is cleared");
    assert.ok(log.some((u) => u.issue === 1 && u.outcome === "requeued" && /quota pause released/.test(u.detail)));
  });
});

describe("tokenbaton rotation holds (#5205)", () => {
  const H = 3_600_000;
  const memStore = () => { const states = []; return { states, load: () => null, save: (s) => states.push(JSON.parse(JSON.stringify(s))) }; };

  it("#5205 all accounts limited: the hold lasts until tokenbaton's earliest reset, not the limited account's own; rotations summed", async () => {
    const { c, now, sleep } = fakeClock();
    const t0 = c.t, earliest = t0 + 2 * H, own = t0 + 5 * H;
    const picks = [];
    let exhausted = false; // every account limited once the first run returns
    const rot = { accounts: [{ n: 1 }, { n: 2 }, { n: 3 }], headroom: () => !exhausted || now() >= earliest, resumeAt: () => t0 + 4 * H, isAccount: (id) => id === "acct-1", currentIdentity: () => "acct-1",
      pick: ({ exclude }) => { picks.push([...exclude.keys()]); return now() >= earliest ? { account: 2, stale: false } : { account: null, earliestReset: earliest }; } };
    const limits = openLimits(storeFile(), { now }), store = memStore(), updates = [], starts = [];
    const rows = await orchestrate({ issues: [1], now, sleep, readBody: async () => "", rotator: rot, limits, identity: () => "acct-1", store, onUpdate: (u) => updates.push(u),
      runOne: async () => { starts.push(now()); exhausted = true; return starts.length === 1 ? { ...limited("acct-1", own), rotations: 2, limited: [{ account: 1, until: own }, { account: 3, until: t0 + 3 * H }] } : { terminalReason: "merged" }; } });
    assert.equal(rows[0].outcome, "merged");
    assert.equal(limits.holdUntil("acct-1") ?? earliest, earliest, "the hold is tokenbaton's earliest reset");
    const paused = updates.find((u) => u.outcome === "paused");
    assert.equal(paused.quota.resumeAt, new Date(earliest).toISOString());
    assert.equal(starts[1], earliest, "rerun at the earliest reset, not the account's own reset");
    assert.deepEqual(picks[0]?.sort(), [1, 3], `lane-reported limited accounts are excluded: ${JSON.stringify({ picks, starts, u: updates.map((u) => u.outcome) })}`);
    const st = store.states.find((s) => s.quota?.["1"]);
    assert.equal(st.quota["1"].rotations, 2, "lane-reported rotations add to quota.rotations");
    assert.deepEqual(Object.keys(st.limitedAccounts).sort(), ["1", "3"], "limited accounts persist with the batch");
  });

  it("#5205 a lane-reported limited account is excluded from headroom until its reset", async () => {
    const { c, now, sleep } = fakeClock();
    const t0 = c.t, seen = [];
    const rot = { accounts: [{ n: 1 }, { n: 2 }], headroom: (ex) => { seen.push(ex ? [...ex.keys()] : []); return !(ex?.has(1) && ex?.has(2)); }, resumeAt: () => t0 + H, isAccount: () => true, currentIdentity: () => "acct-1", pick: () => ({ account: null, earliestReset: t0 + H }) };
    let runs = 0;
    await orchestrate({ issues: [1, 2], parallel: 1, now, sleep, readBody: async () => "", rotator: rot, limits: openLimits(storeFile(), { now }), identity: () => "acct-1",
      runOne: async (n) => { runs++; return n === 1 ? { terminalReason: "merged", rotations: 1, limited: [{ account: 1, until: t0 + H }] } : { terminalReason: "merged" }; } });
    assert.equal(runs, 2);
    assert.ok(seen.some((x) => x.includes(1)), `headroom saw the limited account excluded: ${JSON.stringify(seen)}`);
  });

  it("#5205 no rotator: the hold is now + the reset delay, as before", async () => {
    const { c, now, sleep } = fakeClock();
    const limits = openLimits(storeFile(), { now });
    const until = c.t + H;
    await orchestrate({ issues: [1], now, sleep, readBody: async () => "", limits, identity: () => "A",
      runOne: async () => { if (now() < until) { const r = limited("A", until); setImmediate(() => {}); return r; } return { terminalReason: "merged" }; },
      onUpdate: (u) => { if (u.outcome === "paused") assert.equal(limits.holdUntil("A"), until); } });
  });
});
