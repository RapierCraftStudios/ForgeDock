// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { claimWarm, refillWarm, warmTreeCount } from "./warmtree.mjs";

const gitSync = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = async (args, { cwd } = {}) => gitSync(args, cwd);
const commit = (r, f, c) => { writeFileSync(join(r, f), c); gitSync(["add", "-A"], r); gitSync(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", f], r); return gitSync(["rev-parse", "HEAD"], r).trim(); };
function fixture() {
  const dir = tmpDir("wt5435-"), r = join(dir, "r"), root = join(dir, "wts");
  mkdirSync(r); mkdirSync(root);
  gitSync(["init", "-q", "-b", "main"], r);
  return { r, root, wt: join(root, "lean-1"), first: commit(r, "a.txt", "1") };
}

describe("local warm worktrees (#5435)", () => {
  it("warmTreeCount is off unless a positive integer", () => {
    assert.equal(warmTreeCount(undefined, {}), 0);
    assert.equal(warmTreeCount("x", {}), 0);
    assert.equal(warmTreeCount(2, {}), 2);
    assert.equal(warmTreeCount(undefined, { FORGE_LOCAL_WARM_TREES: "99" }), 4);
  });
  it("claims a warm tree on the lane branch at the base sha", async () => {
    const { r, root, wt, first } = fixture();
    assert.equal(await refillWarm({ git, cwd: r, root, ref: "main", n: 1 }), 1);
    const got = await claimWarm({ git, cwd: r, root, wt, branch: "feat/issue-1-lean", base: "main", n: 1 });
    assert.equal(got.warm, true);
    assert.equal(gitSync(["rev-parse", "HEAD"], wt).trim(), first);
    assert.equal(gitSync(["branch", "--show-current"], wt).trim(), "feat/issue-1-lean");
  });
  it("never hands out a stale base: a pooled tree behind the base is moved to the base sha", async () => {
    const { r, root, wt } = fixture();
    await refillWarm({ git, cwd: r, root, ref: "main", n: 1 });
    const tip = commit(r, "b.txt", "2");
    const got = await claimWarm({ git, cwd: r, root, wt, branch: "feat/issue-1-lean", base: "main", n: 1 });
    assert.equal(got.sha, tip);
    assert.equal(gitSync(["rev-parse", "HEAD"], wt).trim(), tip);
    assert.equal(readFileSync(join(wt, "b.txt"), "utf8"), "2");
  });
  it("refill moves a stale slot to the new tip", async () => {
    const { r, root } = fixture();
    await refillWarm({ git, cwd: r, root, ref: "main", n: 1 });
    const tip = commit(r, "b.txt", "2");
    await refillWarm({ git, cwd: r, root, ref: "main", n: 1 });
    assert.equal(gitSync(["rev-parse", "HEAD"], join(root, "warm", "warm-0")).trim(), tip);
  });
  it("returns null (cold path) with an empty pool, an unknown base or a failing move", async () => {
    const { r, root, wt } = fixture();
    assert.equal(await claimWarm({ git, cwd: r, root, wt, branch: "b", base: "main", n: 1 }), null);
    await refillWarm({ git, cwd: r, root, ref: "main", n: 1 });
    assert.equal(await claimWarm({ git, cwd: r, root, wt, branch: "b", base: "origin/nope", n: 1 }), null);
    const bad = async (args, o) => { if (args[1] === "move") throw new Error("claimed elsewhere"); return git(args, o); };
    assert.equal(await claimWarm({ git: bad, cwd: r, root, wt, branch: "b", base: "main", n: 1 }), null);
    assert.equal(existsSync(wt), false);
  });
  it("a failed verification removes the claimed tree", async () => {
    const { r, root, wt } = fixture();
    await refillWarm({ git, cwd: r, root, ref: "main", n: 1 });
    const bad = async (args, o) => { if (args[0] === "checkout") throw new Error("boom"); return git(args, o); };
    assert.equal(await claimWarm({ git: bad, cwd: r, root, wt, branch: "b", base: "main", n: 1 }), null);
    assert.equal(existsSync(wt), false);
  });
});
