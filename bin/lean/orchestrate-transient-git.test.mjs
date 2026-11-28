// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5947: git transport failures (curl 56, early EOF, invalid index-pack output) are `net.transient` deferrals with backoff,
// never engine-errors, and never reach the circuit breaker; any other engine-error still counts. --clear-breaker reaches a live runner.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate, isTransientEngineError, GIT_TRANSPORT_TEXT } from "./orchestrate.mjs";

const memStore = () => { let st = null; return { load: () => (st ? JSON.parse(JSON.stringify(st)) : null), save: (s) => { st = JSON.parse(JSON.stringify(s)); }, log: () => {}, peek: () => st }; };
const EE = (detail) => ({ terminalReason: "engine-error", detail });
const MERGED = { terminalReason: "merged", pr: 9 };
const run = async ({ script, issues, breaker = { errors: 2, window_min: 10 }, extra = {} }) => {
  let t = 1_000_000;
  const store = memStore(), updates = [];
  const calls = [];
  const rows = await orchestrate({ issues, parallel: 1, readBody: async () => "", now: () => t, store, pollMs: 1000, breaker,
    sleep: async (ms) => { t += Math.max(1, Number(ms) || 0); },
    runOne: async (n) => { calls.push(n); t += 1000; const l = script[n]; return l[Math.min(calls.filter((c) => c === n).length - 1, l.length - 1)]; },
    onUpdate: (r) => updates.push(r), ...extra });
  return { rows, calls, updates, store };
};

describe("#5947 git transport failures", () => {
  it("classifies git transport text, and not an ordinary failure (negative examples)", () => {
    for (const d of ["error: RPC failed; curl 56 GnuTLS recv error", "fatal: early EOF", "fatal: invalid index-pack output", "fatal: the remote end hung up: unexpected disconnect while reading", "curl 28 Operation timed out", "'/cache/git/x.git' is not a local repository"]) assert.ok(GIT_TRANSPORT_TEXT.test(d) && isTransientEngineError(d), d);
    for (const d of ["TypeError: x is not a function", "validate failed: 56 tests", "curl 5600 bytes"]) assert.equal(GIT_TRANSPORT_TEXT.test(d), false, d);
  });

  it("engine-errors with curl 56 / invalid index-pack output defer as net.transient; the breaker stays closed", async () => {
    const r = await run({ issues: [1, 2], script: { 1: [EE("fatal: early EOF\nerror: RPC failed; curl 56 recv"), MERGED], 2: [EE("fatal: invalid index-pack output"), MERGED] } });
    const d = r.updates.filter((u) => u.outcome === "deferred");
    assert.equal(d.length, 2);
    assert.ok(d.every((u) => u.code === "net.transient"));
    assert.deepEqual(r.rows.map((x) => x.outcome).sort(), ["merged", "merged"]);
    const st = r.store.peek();
    assert.deepEqual(st.errorTimes, []);
    assert.equal(st.breaker ?? null, null);
    assert.equal(r.updates.some((u) => u.outcome === "breaker" || u.outcome === "engine-error"), false);
  });

  it("a non-transport engine-error still counts toward the breaker", async () => {
    const r = await run({ issues: [1, 2, 3], breaker: { errors: 2, window_min: 10 }, script: { 1: [EE("boom A")], 2: [EE("boom B")], 3: [MERGED] } });
    assert.ok(r.updates.some((u) => u.outcome === "breaker"), "two real engine-errors trip it");
  });

  it("getClearBreaker resets a tripped breaker in the running batch and acks", async () => {
    let tripSeen = false; const acks = [];
    const r = await run({ issues: [1, 2, 3], breaker: { errors: 2, window_min: 10 }, script: { 1: [EE("boom A")], 2: [EE("boom B")], 3: [MERGED] },
      extra: { onUpdate: (u) => { if (u.outcome === "breaker") tripSeen = true; }, getClearBreaker: () => tripSeen, ackClearBreaker: (i) => acks.push(i) } });
    assert.ok(acks.length >= 1 && acks[0].cleared === true, "the live runner acked a real clear");
    assert.equal(r.store.peek().breaker ?? null, null);
  });
});

describe("#6264 unreadable dependency from a network error", () => {
  const DU = (detail) => ({ terminalReason: "dependency-unreadable", code: "dependency.unreadable", detail });
  it("a network/transport unreadable is requeued as a net.transient deferral and runs again; the lane is not left terminal", async () => {
    const r = await run({ issues: [1], script: { 1: [DU('dependency #3 named by the builder could not be read: Post "https://api.github.com/graphql": i/o timeout'), MERGED] } });
    const d = r.updates.filter((u) => u.outcome === "deferred");
    assert.equal(d.length, 1);
    assert.equal(d[0].code, "net.transient");
    assert.deepEqual(r.rows.map((x) => x.outcome), ["merged"]);
    assert.equal(r.updates.some((u) => u.outcome === "dependency-unreadable"), false);
  });
  it("error connecting to api.github.com is requeued too; a persistent non-network failure stays dependency-unreadable", async () => {
    const a = await run({ issues: [1], script: { 1: [DU("sub-issue #4 could not be read: error connecting to api.github.com"), MERGED] } });
    assert.equal(a.updates.find((u) => u.outcome === "deferred")?.code, "net.transient");
    const b = await run({ issues: [2], script: { 2: [DU("dependency #3 could not be read: Could not resolve to an issue with the number of 3")] } });
    assert.equal(b.updates.some((u) => u.outcome === "deferred"), false);
    assert.deepEqual(b.rows.map((x) => x.outcome), ["dependency-unreadable"]);
  });
});
