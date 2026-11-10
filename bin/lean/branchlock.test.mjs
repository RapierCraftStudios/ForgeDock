import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBranchLock, waitPidsExit, LOCK_DIR } from "./branchlock.mjs";

const common = () => mkdtempSync(join(tmpdir(), "branchlock-"));

describe("branch writer lock (#5333)", () => {
  it("two sessions cannot hold the same lane branch at once; the second reports the holder", async () => {
    const dir = common();
    const a = await acquireBranchLock({ gitCommonDir: dir, branch: "feat/issue-7-lean", owner: "A", alive: () => true });
    assert.equal(a.ok, true);
    const b = await acquireBranchLock({ gitCommonDir: dir, branch: "feat/issue-7-lean", owner: "B", alive: () => true });
    assert.equal(b.ok, false);
    assert.equal(b.holder.owner, "A");
  });
  it("another branch is independent; release lets the waiter in", async () => {
    const dir = common();
    const a = await acquireBranchLock({ gitCommonDir: dir, branch: "x", owner: "A", alive: () => true });
    assert.equal((await acquireBranchLock({ gitCommonDir: dir, branch: "y", owner: "B", alive: () => true })).ok, true);
    let waited = 0;
    const b = await acquireBranchLock({ gitCommonDir: dir, branch: "x", owner: "B", alive: () => true, waitMs: 1000, pollMs: 10, sleep: async () => { if (++waited === 2) a.release(); } });
    assert.equal(b.ok, true);
    assert.ok(waited >= 2);
  });
  it("the same owner re-enters without releasing the outer hold", async () => {
    const dir = common();
    const a = await acquireBranchLock({ gitCommonDir: dir, branch: "x", owner: "A", alive: () => true });
    const again = await acquireBranchLock({ gitCommonDir: dir, branch: "x", owner: "A", alive: () => true });
    again.release();
    assert.equal(existsSync(join(dir, LOCK_DIR, "x")), true);
    a.release();
    assert.equal(existsSync(join(dir, LOCK_DIR, "x")), false);
  });
  it("a lock whose holder died is taken over", async () => {
    const dir = common();
    mkdirSync(join(dir, LOCK_DIR));
    writeFileSync(join(dir, LOCK_DIR, "x"), JSON.stringify({ owner: "dead", pid: 999999 }));
    assert.equal((await acquireBranchLock({ gitCommonDir: dir, branch: "x", owner: "B", alive: () => false })).ok, true);
  });
  it("waitPidsExit escalates to SIGKILL and reports survivors", async () => {
    const alive = new Set([1, 2]), kills = [];
    const left = await waitPidsExit([1, 2], { alive: (p) => alive.has(p), kill: (p, s) => { kills.push([p, s]); if (p === 1) alive.delete(p); }, sleep: async () => {}, graceMs: 500, killMs: 500 });
    assert.deepEqual(left, [2]);
    assert.deepEqual(kills, [[1, "SIGKILL"], [2, "SIGKILL"]]);
  });
});
