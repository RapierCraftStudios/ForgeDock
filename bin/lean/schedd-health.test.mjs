// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { writeHeartbeat, readHeartbeat, clearHeartbeat, stallCheck, tickText, watchdog, bestEffortRenice } from "./schedd-health.mjs";

describe("schedd heartbeat and watchdog (#4780)", () => {
  it("heartbeat round-trips and clears", () => {
    const dir = tmpDir("hb-");
    assert.equal(readHeartbeat(dir), null);
    writeHeartbeat({ dir, pid: 42, now: () => 1000 });
    assert.deepEqual(readHeartbeat(dir), { pid: 42, ts: 1000 });
    clearHeartbeat(dir);
    assert.equal(readHeartbeat(dir), null);
  });

  it("stallCheck: ok when fresh, stalled when old with a live pid, down when pid gone or no file", () => {
    const dir = tmpDir("hb-");
    assert.equal(stallCheck({ dir }).status, "down");
    writeHeartbeat({ dir, pid: 42, now: () => 1000 });
    const at = (t, alive = true) => stallCheck({ dir, stallMs: 60_000, now: () => t, alive: () => alive });
    assert.equal(at(1000 + 30_000).status, "ok");
    assert.equal(at(1000 + 61_000).status, "stalled");
    assert.equal(at(1000 + 61_000, false).status, "down");
    assert.match(tickText(at(1000 + 30_000)), /pid 42, last tick 30 s ago/);
    assert.match(tickText(at(1000 + 90_000)), /last tick 90 s ago \(STALLED\)/);
    assert.equal(tickText(at(1000, false)), "schedd: not running");
  });

  it("watchdog signals only a stalled live daemon: TERM, then KILL when it survives", async () => {
    const dir = tmpDir("hb-");
    writeHeartbeat({ dir, pid: 42, now: () => 0 });
    const sent = [];
    const run = (t, alive) => watchdog({ dir, stallMs: 60_000, now: () => t, alive, kill: (p, s) => sent.push([p, s]), sleep: async () => {}, graceMs: 0, log: () => {} });
    assert.equal((await run(30_000, () => true)).killed, null);
    assert.equal((await run(90_000, () => false)).killed, null);
    assert.deepEqual(sent, [], "a fresh or dead daemon is never signalled");
    let calls = 0;
    assert.equal((await run(90_000, () => ++calls === 1)).killed, "SIGTERM");
    assert.deepEqual(sent, [[42, "SIGTERM"]]);
    sent.length = 0;
    assert.equal((await run(90_000, () => true)).killed, "SIGKILL");
    assert.deepEqual(sent, [[42, "SIGTERM"], [42, "SIGKILL"]]);
  });

  it("#5806: a down daemon with unfinished daemon batches is started once per watchdog run; with none it is left down", async () => {
    const dir = tmpDir("hb-"), lines = [];
    let starts = 0;
    const run = (unfinished, start = async () => { starts++; }) => watchdog({ dir, now: () => 0, alive: () => false, unfinished, start, log: (m) => lines.push(m) });
    assert.equal((await run(() => [])).started, undefined);
    assert.equal(starts, 0);
    const r = await run(() => ["b1", "b2"]);
    assert.deepEqual([r.status, r.started, starts], ["down", true, 1]);
    assert.match(lines.join("\n"), /FORGE:DECISION daemon down with 2 unfinished batch\(es\) \(b1 b2\); starting it/);
    assert.equal((await run(() => ["b1"], async () => { throw new Error("no unit"); })).started, false);
    assert.match(lines.at(-1), /start failed: no unit/);
  });

  it("#5938: the watchdog logs one verdict line per batch and leaves the heartbeat behaviour alone", async () => {
    const dir = tmpDir("hb-verdict-"), lines = [];
    const r = await watchdog({ dir, now: () => 0, alive: () => false, log: (m) => lines.push(m), batchVerdicts: () => ["batch b1: healthy", "batch b2: stalled -> no action, needs you (x)"] });
    assert.equal(r.status, "down");
    assert.deepEqual(lines, ["schedd watchdog: batch b1: healthy", "schedd watchdog: batch b2: stalled -> no action, needs you (x)"]);
  });

  it("bestEffortRenice never throws", () => {
    assert.equal(bestEffortRenice(() => { throw new Error("EACCES"); }), false);
    assert.equal(bestEffortRenice(() => {}), true);
  });

  it("#5966: a down daemon while the unit is active alerts, emits an event and restarts the unit, even with no unfinished batches", async () => {
    const dir = tmpDir("schedd-wd-unit-"), lines = [], events = [];
    let starts = 0, restarts = 0;
    const run = (unit, restart = async () => { restarts++; }) => watchdog({ dir, now: () => 0, alive: () => false, unfinished: () => [], start: async () => { starts++; }, restart, unit, emit: (e) => events.push(e), log: (m) => lines.push(m) });
    const r = await run(() => "active");
    assert.equal(r.started, true);
    assert.equal(r.alerted, true);
    assert.equal(r.restarted, true);
    assert.deepEqual([restarts, starts], [1, 0], "an active unit is restarted, never started");
    assert.equal(events[0].type, "schedd.unit-no-daemon");
    assert.ok(lines.some((l) => l.includes("ALERT")));
    await run(() => "inactive");
    await run(() => null);
    assert.equal(restarts, 1, "an inactive or absent unit with nothing unfinished is left down");
    const f = await run(() => "active", async () => { throw new Error("denied"); });
    assert.deepEqual([f.started, f.restarted, f.alerted], [false, false, true]);
    assert.match(lines.at(-1), /restart failed: denied/);
  });
});
