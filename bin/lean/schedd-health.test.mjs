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

  it("bestEffortRenice never throws", () => {
    assert.equal(bestEffortRenice(() => { throw new Error("EACCES"); }), false);
    assert.equal(bestEffortRenice(() => {}), true);
  });
});
