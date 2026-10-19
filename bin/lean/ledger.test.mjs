// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { makeLedger, safeSegment, LEDGER_TTL_MS } from "./ledger.mjs";

describe("lane resource ledger (#4179)", () => {
  it("register/release round trip carries owner, batch, lane, issue, created and expires", () => {
    const root = tmpDir("ledger-");
    let t = 1000;
    const l = makeLedger({ root, batch: "b20261019-1", lane: "lean-7", owner: "core_1", issue: 7, host: "h", pid: 11, now: () => t });
    assert.equal(l.path, join(root, "b20261019-1", "lean-7.json"));
    assert.equal(l.read(), null);
    assert.equal(l.register("worktree", "/wt/lean-7"), true);
    l.register("branch", "feat/issue-7-lean");
    l.register("pid", 4242, { marker: "claude" });
    l.register("worktree", "/wt/lean-7"); // idempotent
    t = 2000;
    l.register("container", "lean7-pg");
    const j = JSON.parse(readFileSync(l.path, "utf8"));
    assert.deepEqual({ owner: j.owner, batch: j.batch, lane: j.lane, issue: j.issue, host: j.host, pid: j.pid, created: j.created }, { owner: "core_1", batch: "b20261019-1", lane: "lean-7", issue: 7, host: "h", pid: 11, created: 1000 });
    assert.equal(j.expires, 2000 + LEDGER_TTL_MS, "each registration extends expiry");
    assert.deepEqual(j.resources.map((r) => `${r.kind}:${r.value}`), ["worktree:/wt/lean-7", "branch:feat/issue-7-lean", "pid:4242", "container:lean7-pg"]);
    assert.equal(l.entries("pid")[0].marker, "claude");
    assert.equal(l.register("nonsense", "x"), false, "unknown kinds are refused");
    assert.equal(l.release("pid", "4242"), true);
    assert.equal(l.release("pid", 4242), false);
    assert.equal(l.remove(), false, "a ledger that still lists resources is kept");
    for (const r of l.entries()) l.release(r.kind, r.value);
    assert.equal(l.remove(), true);
    assert.equal(existsSync(l.path), false);
  });

  it("writes are atomic (no tmp file left behind) and names cannot escape the root", () => {
    const root = tmpDir("ledger-");
    const l = makeLedger({ root, batch: "../../etc", lane: "../passwd", issue: 1 });
    l.register("tmp", "/x");
    assert.equal(dirname(dirname(l.path)), root);
    assert.deepEqual(readdirSync(dirname(l.path)), [l.path.split("/").at(-1)]);
    for (const [i, o] of [["..", "_"], [".", "_"], ["", "_"], ["a/b", "a_b"], ["milestone/x", "milestone_x"], ["b1.2", "b1.2"]]) assert.equal(safeSegment(i), o);
  });

  it("a simulated crash (no teardown) leaves every registered resource readable by a fresh process", () => {
    const root = tmpDir("ledger-");
    const l = makeLedger({ root, batch: "b1", lane: "lean-9", owner: "core_9", issue: 9 });
    for (const [k, v] of [["tmp", "/home/x/.forge/tmp/runs/9-1"], ["branch", "feat/issue-9-lean"], ["worktree", "/wt/lean-9"], ["pid", 77]]) l.register(k, v);
    // the process dies here: nothing is released
    const after = makeLedger({ root, batch: "b1", lane: "lean-9", issue: 9 }).read();
    assert.equal(after.owner, "core_9");
    assert.deepEqual(after.resources.map((r) => r.kind), ["tmp", "branch", "worktree", "pid"]);
  });
});
