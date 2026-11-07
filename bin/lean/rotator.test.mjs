// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { parseLive, openRotator, rotatorRetry, quotaRequeue, rotatorKind, realClaude, accountOfPid, ROTATOR_KINDS, HEADROOM_PCT } from "./rotator.mjs";
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

describe("account rotator: detection, staleness, exclusion, pick (#5205)", () => {
  const exe = (path, body = "#!/bin/sh\nexit 0\n") => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, body, { mode: 0o755 }); return path; };

  it("#5205 rotatorKind: explicit wins, off disables, TOKENBATON_HOME or the shim first on PATH detects, absent -> null", () => {
    const root = tmpDir("kind-");
    const shimDir = join(root, ".tokenbaton", "shim"), realDir = join(root, "bin");
    exe(join(shimDir, "claude")); exe(join(realDir, "claude"));
    assert.equal(rotatorKind({ execution: { accountRotator: "tokenbaton" }, env: { FORGEDOCK_ACCOUNT_ROTATOR: "off" } }), "tokenbaton");
    assert.equal(rotatorKind({ execution: { accountRotator: "off" }, env: { TOKENBATON_HOME: root } }), null);
    assert.equal(rotatorKind({ execution: {}, env: { TOKENBATON_HOME: root, FORGEDOCK_ACCOUNT_ROTATOR: "off" } }), null);
    assert.equal(rotatorKind({ execution: null, env: { TOKENBATON_HOME: root } }), "tokenbaton");
    assert.equal(rotatorKind({ env: { PATH: `${shimDir}:${realDir}` } }), "tokenbaton", "shim first on PATH");
    assert.equal(rotatorKind({ env: { PATH: `${realDir}:${shimDir}` } }), null, "real claude first");
    assert.equal(rotatorKind({ env: { PATH: "" } }), null, "absent");
    assert.equal(realClaude({ PATH: `${shimDir}:${realDir}` }), join(realDir, "claude"));
    assert.equal(parseExecution({ account_rotator: "off" }).accountRotator, "off");
    assert.equal(parseExecution({ account_rotator: "none" }).accountRotator, "off");
    assert.equal(parseExecution({}).accountRotator, undefined);
    assert.equal(openRotator({ kind: "off", home: baton(1, { 1: [0, T0 + H, 0, T0 + H] }).home }), null);
  });

  it("#5205 TOKENBATON_HOME is the state dir as-is", () => {
    const b = baton(2, { 1: [10, T0 + H, 0, T0 + 9 * H], 2: [20, T0 + H, 0, T0 + 9 * H] });
    const rot = openRotator({ kind: "tokenbaton", env: { TOKENBATON_HOME: join(b.home, ".tokenbaton") }, now: () => T0 });
    assert.equal(rot.dir, join(b.home, ".tokenbaton"));
    assert.deepEqual(rot.accounts.map((a) => a.n), [1, 2]);
    assert.equal(rot.current(), 2);
  });

  it("#5205 a stale sample is unknown, never 0%: ranked after a fresh one, and an excluded account never counts as room", () => {
    // account 1: 99% with a passed reset (stale); account 4: fresh 47%; account 2: fresh 97% (full)
    const b = baton(1, { 1: [99, T0 - H, 50, T0 + 90 * H], 2: [97, T0 + 2 * H, 10, T0 + 90 * H], 4: [47, T0 + H, 10, T0 + 90 * H] });
    const noCli = () => ({ status: 1, stdout: "3\n" }); // installed tokenbaton without tokenbaton#3: a bare number
    const rot = openRotator({ kind: "tokenbaton", home: b.home, env: {}, now: () => T0, exec: noCli });
    assert.equal(rot.accounts.find((a) => a.n === 1).stale, true);
    assert.deepEqual(rot.pick(), { account: 4, stale: false }, "fresh 47% before stale");
    assert.deepEqual(rot.pick({ exclude: [4] }), { account: 1, stale: true }, "stale is worth one try");
    assert.equal(rot.headroom([4]), true);
    assert.equal(rot.headroom([1, 4]), false, "excluded never counts as room; 2 is full");
    const none = rot.pick({ exclude: new Map([[1, T0 + 3 * H], [4, T0 + 4 * H]]) });
    assert.deepEqual(none, { account: null, earliestReset: T0 + 2 * H });
    assert.equal(rot.resumeAt(new Map([[1, T0 + 3 * H], [4, T0 + 4 * H]])), T0 + 2 * H);
    assert.equal(rotatorRetry(rot, 0, [1, 2, 4]), false);
    assert.equal(quotaRequeue({ rotator: rot, r: {}, delayMs: 5, exclude: [1, 4] }), null);
  });

  it("#5205 pick uses tokenbaton#3 --pick --json --exclude when it prints JSON (exit 2 = none, earliest_reset)", () => {
    const b = baton(1, { 1: [10, T0 + H, 0, T0 + 9 * H], 2: [20, T0 + H, 0, T0 + 9 * H] });
    const calls = [];
    let reply = { status: 0, stdout: '{"account":2}' };
    const exec = (cmd, args, opts) => { calls.push([cmd, args, opts.env.TOKENBATON_HOME]); return reply; };
    const rot = openRotator({ kind: "tokenbaton", home: b.home, env: {}, now: () => T0, exec });
    assert.deepEqual(rot.pick({ exclude: [1] }), { account: 2, stale: false });
    assert.deepEqual(calls[0], ["tokenbaton", ["--pick", "--json", "--exclude", "1"], join(b.home, ".tokenbaton")]);
    reply = { status: 2, stdout: JSON.stringify({ account: null, earliest_reset: Math.round((T0 + 5 * H) / 1000) }) };
    assert.deepEqual(rot.pick({ exclude: [1, 2] }), { account: null, earliestReset: T0 + 5 * H });
    reply = { status: 0, stdout: "1\n" }; // pre-#3 CLI: live.N fallback
    assert.deepEqual(rot.pick({ exclude: [1] }), { account: 2, stale: false });
    reply = { status: 0, stdout: "" };
    assert.equal(rot.markLimited(1, T0 + H), true);
    assert.deepEqual(calls.at(-1).slice(0, 2), ["tokenbaton-ctl", ["mark-limited", "1", "--until", String(Math.round((T0 + H) / 1000))]]);
    reply = { status: 2, stdout: "unknown command" };
    assert.equal(rot.markLimited(1, T0 + H), false, "unsupported: ignored");
    assert.equal(openRotator({ kind: "tokenbaton", home: b.home, env: {}, now: () => T0, exec: () => { throw new Error("boom"); } }).pick().account, 1, "fails open to live.N");
  });

  it("#5205 accountOfPid reads TOKENBATON_ACCOUNT, else CLAUDE_CONFIG_DIR, from /proc/<pid>/environ; null when unreadable", () => {
    const proc = tmpDir("proc-");
    const env = (pid, vars) => { mkdirSync(join(proc, String(pid)), { recursive: true }); writeFileSync(join(proc, String(pid), "environ"), `${vars.join("\0")}\0`); };
    env(11, ["PATH=/bin", "TOKENBATON_ACCOUNT=3", "CLAUDE_CONFIG_DIR=/home/x/.claude-1"]);
    env(12, ["PATH=/bin", "CLAUDE_CONFIG_DIR=/home/x/.claude-2"]);
    env(13, ["PATH=/bin", "CLAUDE_CONFIG_DIR=/home/x/.claude"]);
    assert.equal(accountOfPid(11, { procRoot: proc }), 3);
    assert.equal(accountOfPid(12, { procRoot: proc }), 2);
    assert.equal(accountOfPid(13, { procRoot: proc }), null);
    assert.equal(accountOfPid(99, { procRoot: proc }), null);
    assert.equal(accountOfPid(undefined, { procRoot: proc }), null);
  });
});
