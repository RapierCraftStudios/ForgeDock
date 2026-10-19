// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { makeLedger, countLiveLanes, safeSegment, LEDGER_TTL_MS, dockerLabels } from "./ledger.mjs";

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

describe("live lane count (#4182)", () => {
  it("counts only live, same-host, unexpired lane files across batches, and deletes nothing", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const root = tmpDir("ledger-count-");
    const t = 10_000;
    const lane = (batch, name, o) => { mkdirSync(join(root, batch), { recursive: true }); writeFileSync(join(root, batch, `${name}.json`), typeof o === "string" ? o : JSON.stringify({ v: 1, host: "h", pid: 11, expires: t + 1, resources: [], ...o })); };
    lane("b1", "lean-1", {});
    lane("b1", "lean-2", { pid: 12 });
    lane("adhoc", "lean-3", { pid: 13 });
    lane("b1", "dead", { pid: 99 });
    lane("b1", "other-host", { host: "zzz" });
    lane("b1", "expired", { expires: t });
    lane("b1", "malformed", "{not json");
    lane("b1", "no-pid", { pid: null });
    writeFileSync(join(root, "b1", "lean-1.json.tmp-5"), "{}");
    writeFileSync(join(root, "stray-file"), "x");
    const before = readdirSync(join(root, "b1")).sort();
    const seen = [];
    const n = countLiveLanes({ root, host: "h", now: () => t, alive: (pid) => { seen.push(pid); return pid !== 99; } });
    assert.equal(n, 3);
    assert.ok(!seen.includes(null));
    assert.deepEqual(readdirSync(join(root, "b1")).sort(), before, "read-only");
    assert.equal(countLiveLanes({ root: join(root, "missing"), host: "h" }), 0);
  });

  it("a registered lane counts itself by default (own pid alive)", () => {
    const root = tmpDir("ledger-self-");
    const l = makeLedger({ root, batch: "adhoc", lane: "lean-9", owner: "core_1", issue: 9, host: "h" });
    assert.equal(countLiveLanes({ root, host: "h" }), 0, "nothing registered yet: no file");
    l.register("tmp", "/x/runs/9-1");
    assert.equal(countLiveLanes({ root, host: "h" }), 1);
    assert.equal(countLiveLanes({ root, host: "other" }), 0);
  });
});

describe("docker ownership labels (#4181)", () => {
  it("owner, batch, lane, issue and expires, in order; values cannot inject", () => {
    assert.deepEqual(dockerLabels({ batch: "b1", lane: "lean-7", issue: 7, expires: 123 }),
      ["forgedock.owner=1", "forgedock.batch=b1", "forgedock.lane=lean-7", "forgedock.issue=7", "forgedock.expires=123"]);
    const l = dockerLabels({ batch: "a b;rm -rf", lane: "", issue: null, expires: undefined });
    assert.equal(l[1], "forgedock.batch=a-b-rm--rf"); assert.equal(l[2], "forgedock.lane=unknown"); assert.equal(l[3], "forgedock.issue=unknown");
    for (const e of l) assert.match(e, /^forgedock\.[a-z]+=[A-Za-z0-9_.-]+$/);
  });
});
