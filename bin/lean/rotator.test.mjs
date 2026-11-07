// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { parseLive, openRotator, rotatorRetry, quotaRequeue, ROTATOR_KINDS, HEADROOM_PCT } from "./rotator.mjs";
import { laneBackendId, openLimits } from "./limits.mjs";
import { orchestrate, formatTable } from "./orchestrate.mjs";
import { parseExecution } from "./execution.mjs";

const T0 = 1_800_000_000_000; // epoch ms
const fakeClock = () => { const c = { t: T0 }; return { c, now: () => c.t, sleep: async (ms) => { c.t += ms; } }; };
/** A tokenbaton home: `accounts` maps n -> [5h %, 5h reset ms, weekly %, weekly reset ms]. */
const baton = (current, accounts) => {
  const home = tmpDir("baton-"), dir = join(home, ".tokenbaton");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "current"), `${current}\n`);
  const write = (n, [p5, r5, pw, rw]) => writeFileSync(join(dir, `live.${n}`), `${p5} ${Math.round(r5 / 1000)} ${pw} ${Math.round(rw / 1000)} ${Math.round(T0 / 1000)}\n`);
  for (const [n, v] of Object.entries(accounts)) write(n, v);
  return { home, write, setCurrent: (n) => writeFileSync(join(dir, "current"), `${n}\n`) };
};
const H = 3_600_000;

describe("account rotator adapter (#5094)", () => {
  it("parseLive reads the five fields and rejects malformed lines", () => {
    assert.deepEqual(parseLive("42 1800000100 7 1800500000 1800000000"), { fiveHourPct: 42, fiveHourResetMs: 1_800_000_100_000, weeklyPct: 7, weeklyResetMs: 1_800_500_000_000 });
    assert.equal(parseLive(""), null);
    assert.equal(parseLive("12 abc 3 4"), null);
    assert.equal(parseLive("1 2 3"), null);
  });

  it("openRotator is null for an unknown kind or unreadable state; parseExecution keeps only tokenbaton", () => {
    assert.deepEqual(ROTATOR_KINDS, ["tokenbaton"]);
    assert.equal(openRotator({ kind: undefined }), null);
    assert.equal(openRotator({ kind: "other", home: baton(1, { 1: [0, T0 + H, 0, T0 + H] }).home }), null);
    assert.equal(openRotator({ kind: "tokenbaton", home: tmpDir("empty-") }), null);
    assert.equal(openRotator({ kind: "tokenbaton", home: baton(1, {}).home }), null, "no live.N");
    assert.equal(parseExecution({ account_rotator: "tokenbaton" }).accountRotator, "tokenbaton");
    assert.equal("accountRotator" in parseExecution({ account_rotator: "nope" }), false);
    assert.equal("accountRotator" in parseExecution({}), false);
  });

  it("headroom: 5h under 95% and weekly under 100%; a passed reset counts as 0; resumeAt is the earliest regain; state is re-read", () => {
    const { c, now } = fakeClock();
    const b = baton(1, { 1: [HEADROOM_PCT, T0 + 2 * H, 10, T0 + 100 * H], 2: [99, T0 + 4 * H, 100, T0 + 3 * H] });
    const rot = openRotator({ kind: "tokenbaton", home: b.home, now });
    assert.equal(rot.headroom(), false);
    assert.equal(rot.resumeAt(), T0 + 2 * H, "account 1 regains at its 5h reset; account 2 needs both resets (4h)");
    assert.deepEqual(rot.accounts.map((a) => a.n), [1, 2]);
    c.t = T0 + 2 * H; // account 1's 5h window reset: counts as 0
    assert.equal(rot.headroom(), true);
    assert.equal(rot.resumeAt(), c.t);
    c.t = T0;
    b.write(2, [10, T0 + H, 10, T0 + 100 * H]); // tokenbaton refreshed live.2
    assert.equal(rot.headroom(), true, "no cache: the new file is read");
    assert.equal(rot.current(), 1);
    b.setCurrent(2);
    assert.equal(rot.current(), 2);
  });

  it("account identity is the lane identity on ~/.claude-<n>; isAccount; laneBackendId follows the rotator's current account", () => {
    const b = baton(1, { 1: [0, T0 + H, 0, T0 + H], 2: [0, T0 + H, 0, T0 + H] });
    const rot = openRotator({ kind: "tokenbaton", home: b.home, env: {}, now: () => T0 });
    assert.equal(rot.accountIdentity(2), laneBackendId({ CLAUDE_CONFIG_DIR: join(b.home, ".claude-2") }));
    assert.equal(rot.isAccount(rot.accountIdentity(1)), true);
    assert.equal(rot.isAccount("remote-credential"), false);
    assert.equal(laneBackendId({}, rot), rot.accountIdentity(1));
    b.setCurrent(2);
    assert.equal(laneBackendId({}, rot), rot.accountIdentity(2), "#R13: the identity changes when tokenbaton rotates");
    assert.equal(laneBackendId({ CLAUDE_CONFIG_DIR: "/x" }, null), laneBackendId({ CLAUDE_CONFIG_DIR: "/x" }), "no rotator: unchanged");
    assert.equal(laneBackendId({ CLAUDE_CONFIG_DIR: "/x" }, { currentIdentity: () => { throw new Error("x"); } }), laneBackendId({ CLAUDE_CONFIG_DIR: "/x" }), "fail-open");
  });

  it("rotatorRetry and quotaRequeue: rotation is capped at the account count; a remote credential waits for its own reset", () => {
    const rot = { accounts: [{ n: 1 }, { n: 2 }], headroom: () => true, isAccount: (id) => id === "acct-1" };
    assert.equal(rotatorRetry(rot, 0), true);
    assert.equal(rotatorRetry(rot, 2), false);
    assert.equal(rotatorRetry(null, 0), false);
    assert.equal(rotatorRetry({ ...rot, headroom: () => false }, 0), false);
    assert.deepEqual(quotaRequeue({ rotator: rot, r: { backendId: "acct-1" }, delayMs: 600_000 }), { delayMs: 0, rotated: true });
    assert.deepEqual(quotaRequeue({ rotator: rot, r: {}, delayMs: 600_000 }), { delayMs: 0, rotated: true });
    assert.deepEqual(quotaRequeue({ rotator: rot, r: { backendId: "acct-1" }, prior: { rotations: 2 }, delayMs: 600_000 }), { delayMs: 600_000, rotated: false });
    assert.deepEqual(quotaRequeue({ rotator: rot, r: { backendId: "sandbox-cred" }, delayMs: 600_000 }), { delayMs: 600_000, rotated: false }, "R6: remote credential");
    assert.deepEqual(quotaRequeue({ rotator: rot, r: { backendId: "remote:pool" }, delayMs: 600_000, poolId: "remote:pool" }), { delayMs: 0, rotated: true }, "#5203: the pool rotates");
    assert.deepEqual(quotaRequeue({ rotator: rot, r: { backendId: "remote:pool" }, prior: { rotations: 2 }, delayMs: 600_000, poolId: "remote:pool" }), { delayMs: 600_000, rotated: false }, "#5203: capped at the account count");
    assert.deepEqual(quotaRequeue({ rotator: rot, r: { backendId: "sandbox-cred" }, delayMs: 600_000, poolId: "remote:pool" }), { delayMs: 600_000, rotated: false });
    assert.equal(quotaRequeue({ rotator: { ...rot, headroom: () => false }, r: { backendId: "remote:pool" }, delayMs: 1, poolId: "remote:pool" }), null);
    assert.equal(quotaRequeue({ rotator: { ...rot, headroom: () => false }, r: {}, delayMs: 1 }), null);
    assert.equal(quotaRequeue({ rotator: null, r: {}, delayMs: 1 }), null);
  });
});

describe("orchestrate with an account rotator (#5094)", () => {
  const limited = (id, until, cost = 0.5, minutes = 3) => ({ terminalReason: "deferred", code: "rate_limited", resetAtEpochMs: until, backendId: id, cost_usd: cost, minutes });

  it("every account exhausted: admissions stop, and resume by themselves when the first account resets", async () => {
    const { now, sleep } = fakeClock();
    const rot = { accounts: [{ n: 1 }, { n: 2 }], headroom: () => now() >= T0 + 2 * H, resumeAt: () => T0 + 2 * H, isAccount: () => true, currentIdentity: () => "acct-1" };
    const starts = [];
    const rows = await orchestrate({ issues: [1], now, sleep, readBody: async () => "", rotator: rot, limits: openLimits(join(tmpDir("lim-"), "l.json"), { now }), identity: () => "acct-1",
      runOne: async () => { starts.push(now()); return { terminalReason: "merged" }; } });
    assert.deepEqual(rows.map((r) => r.outcome), ["merged"]);
    assert.equal(starts[0], T0 + 2 * H, "held until the rotator's resumeAt, then admitted without operator action");
  });

  it("report: the requeue row is 'paused (quota)' with its resume time, never 'deferred', and the paused cost is counted once", async () => {
    const { now, sleep } = fakeClock();
    const updates = [];
    let runs = 0;
    const rows = await orchestrate({ issues: [1], now, sleep, readBody: async () => "", limits: openLimits(join(tmpDir("lim-"), "l.json"), { now }), identity: () => "A",
      onUpdate: (u) => updates.push(u), runOne: async () => (++runs === 1 ? limited("A", T0 + H) : { terminalReason: "merged", cost_usd: 1.25, minutes: 4 }) });
    const paused = updates.find((u) => u.issue === 1 && u.outcome === "paused");
    assert.ok(paused, `paused row: ${JSON.stringify(updates.map((u) => u.outcome))}`);
    assert.equal(updates.some((u) => u.outcome === "deferred"), false);
    assert.equal(paused.quota.resumeAt, new Date(T0 + H).toISOString());
    assert.match(paused.detail, /^paused \(quota\) until /);
    assert.equal(rows[0].outcome, "merged");
    assert.equal(rows[0].cost_usd, 1.75, "paused attempt + rerun, once");
    assert.match(formatTable([{ ...paused }]), /paused \(quota\) until \d{4}-/);
  });

  it("a batch that ends while quota-paused leaves a resumable 'held' row with the quota resume time and the paused cost", async () => {
    const { now, sleep } = fakeClock();
    // #2's engine-errors trip the breaker while #1 waits for its quota: the batch ends with #1 pending.
    const rows = await orchestrate({ issues: [2, 1], parallel: 1, now, sleep, readBody: async () => "", breaker: { errors: 2, window_min: 600 },
      limits: openLimits(join(tmpDir("lim-"), "l.json"), { now }), identity: () => "A", runOne: async (n) => { if (n === 2) throw new Error("boom"); return limited("A", T0 + H); } });
    const row = rows.find((r) => r.issue === 1);
    assert.equal(row.outcome, "held", "P4: held stays the resumable marker");
    assert.equal(row.quota?.resumeAt, new Date(T0 + H).toISOString());
    assert.equal(row.cost_usd, 0.5);
    assert.equal(row.detail, `paused (quota) until ${new Date(T0 + H).toISOString()}`);
    assert.match(formatTable(rows), /paused \(quota\) until /);
  });

  it("a remote lane limited on its own credential waits for its own reset and sets no host hold while the rotator has headroom", async () => {
    const { now, sleep } = fakeClock();
    const limits = openLimits(join(tmpDir("lim-"), "l.json"), { now });
    const rot = { accounts: [{ n: 1 }], headroom: () => true, resumeAt: () => now(), isAccount: (id) => id === "acct-1", currentIdentity: () => "acct-1" };
    const starts = [];
    await orchestrate({ issues: [1], now, sleep, readBody: async () => "", rotator: rot, limits, identity: () => "acct-1",
      runOne: async () => { starts.push(now()); return starts.length === 1 ? limited("sandbox-cred", T0 + H) : { terminalReason: "merged" }; } });
    assert.deepEqual(limits.list(), []);
    assert.equal(starts[1], T0 + H);
  });
});
