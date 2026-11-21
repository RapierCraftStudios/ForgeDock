// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { ceilingEnv, ceilingSep, listedWorktree, normPath, quarantineDir, samePath, verifyLaneWorktree } from "./laneconfine.mjs";

// git with a clean environment: the host's own GIT_* variables (a hook, a ceiling) never leak into a fixture
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const gitSync = (args, cwd, env = {}) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...baseEnv, ...env }, stdio: ["ignore", "pipe", "pipe"] });
const git = async (args, { cwd, env } = {}) => gitSync(args, cwd, env);
const exists = async (p) => existsSync(p);

/** A repo whose lane root sits inside its checkout, as `<repo>/.claude/worktrees/`, with an untracked operator file. */
function repo() {
  const r = join(tmpDir("lc5825-"), "r");
  mkdirSync(r, { recursive: true });
  gitSync(["init", "-q", "-b", "main"], r);
  writeFileSync(join(r, "a.txt"), "a\n");
  gitSync(["add", "a.txt"], r);
  gitSync(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], r);
  writeFileSync(join(r, "operator-untracked.txt"), "mine\n");
  const root = join(r, ".claude", "worktrees");
  mkdirSync(root, { recursive: true });
  return { r, root, wt: join(root, "lean-5") };
}
const staged = (r) => gitSync(["diff", "--cached", "--name-only"], r).trim();

describe("ceilingEnv / path comparison (#5825)", () => {
  it("win32: the ceiling is the worktree parent, joined with `;` (git's PATH_SEP), never split on the drive colon", () => {
    const wt = "C:\\Users\\u\\repo\\.claude\\worktrees\\lean-5";
    assert.deepEqual(ceilingEnv(wt, { platform: "win32", env: {} }), { GIT_CEILING_DIRECTORIES: "C:\\Users\\u\\repo\\.claude\\worktrees" });
    assert.deepEqual(ceilingEnv(wt, { platform: "win32", env: { GIT_CEILING_DIRECTORIES: "D:\\x;c:/users/u/repo/.claude/worktrees" } }), { GIT_CEILING_DIRECTORIES: "C:\\Users\\u\\repo\\.claude\\worktrees;D:\\x" });
    const v = ceilingEnv(wt, { platform: "win32", env: {} }).GIT_CEILING_DIRECTORIES;
    assert.ok(!v.split(ceilingSep("win32")).some((d) => /lean-5/.test(d)), "no entry carries the lane folder");
  });
  it("posix: `:` join; a parent containing the separator is refused (null), never split into fragments", () => {
    assert.deepEqual(ceilingEnv("/r/.claude/worktrees/lean-5", { platform: "linux", env: { GIT_CEILING_DIRECTORIES: "/x" } }), { GIT_CEILING_DIRECTORIES: "/r/.claude/worktrees:/x" });
    assert.equal(ceilingEnv("/a:b/lean-5", { platform: "linux", env: {} }), null);
    assert.equal(ceilingEnv("C:\\a;C\\lean-5", { platform: "win32", env: {} }), null);
  });
  it("paths compare in the platform's form: git's `C:/...` equals `C:\\...` on win32; case matters on posix", () => {
    assert.ok(samePath("C:/Users/U/repo/.claude/worktrees/lean-5", "c:\\users\\u\\repo\\.claude\\worktrees\\lean-5\\", { platform: "win32" }));
    assert.ok(!samePath("/r/Lean-5", "/r/lean-5", { platform: "linux" }));
    assert.equal(normPath("/", { platform: "linux" }), "/");
    const porcelain = "worktree C:/r\nHEAD abc\n\nworktree C:/r/.claude/worktrees/lean-5\nbranch refs/heads/x\n";
    assert.ok(listedWorktree(porcelain, "C:\\r\\.claude\\worktrees\\lean-5", { platform: "win32" }));
    assert.ok(!listedWorktree(porcelain, "C:\\r\\.claude\\worktrees\\lean-6", { platform: "win32" }));
  });
});

describe("lane git confinement against real git (#5825)", () => {
  it("a git call from a lane folder without .git does not reach the parent checkout once the ceiling is set", () => {
    const { r, wt } = repo();
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "x.js"), "x\n");
    // control: without the ceiling git walks up to the operator's checkout (the bug)
    assert.equal(normPath(gitSync(["rev-parse", "--show-toplevel"], join(wt, "src")).trim()), normPath(gitSync(["rev-parse", "--show-toplevel"], r).trim()));
    const env = ceilingEnv(wt);
    assert.throws(() => gitSync(["add", "-A"], wt, env), /not a git repository/i);
    assert.throws(() => gitSync(["status", "--porcelain"], join(wt, "src"), env), /not a git repository/i);
    assert.equal(staged(r), "", "nothing staged in the operator's checkout");
  });

  it("verify: a folder with no .git link fails before any git call; a stale .git link fails; a registered worktree passes", async () => {
    const { r, wt } = repo();
    mkdirSync(wt);
    const calls = [];
    const v1 = await verifyLaneWorktree({ git: async (a, o) => { calls.push(a); return git(a, o); }, exists, wt, cwd: r });
    assert.equal(v1.ok, false); assert.match(v1.why, /no \.git link/); assert.deepEqual(calls, []);
    writeFileSync(join(wt, ".git"), `gitdir: ${join(r, ".git", "worktrees", "gone")}\n`);
    const v2 = await verifyLaneWorktree({ git, exists, wt, cwd: r });
    assert.equal(v2.ok, false); assert.match(v2.why, /rev-parse failed in the lane folder/);
    assert.equal(staged(r), "");
  });

  it("verify: a worktree of another repository fails on the common dir, with evidence", async () => {
    const a = repo(), b = repo();
    gitSync(["worktree", "add", "-q", "--detach", a.wt], b.r); // b's worktree sitting where a's lane folder belongs
    const v = await verifyLaneWorktree({ git, exists, wt: a.wt, cwd: a.r });
    assert.equal(v.ok, false); assert.match(v.why, /not the repository's/);
    assert.ok(v.evidence.common_dir && v.evidence.repo_common_dir && v.evidence.toplevel);
  });

  it("salvage path: an unlinked folder is quarantined, then a fresh registered worktree is added and verifies", async () => {
    const { r, root, wt } = repo();
    mkdirSync(join(wt, "half-deleted"), { recursive: true });
    writeFileSync(join(wt, "half-deleted", "f.txt"), "left\n");
    assert.equal((await verifyLaneWorktree({ git, exists, wt, cwd: r })).ok, false);
    const to = quarantineDir(wt, { now: () => 1 });
    assert.equal(to, join(root, ".quarantine", "lean-5-1"));
    assert.ok(existsSync(join(to, "half-deleted", "f.txt")) && !existsSync(wt), "moved aside, not deleted");
    gitSync(["worktree", "add", "-q", "-b", "feat/issue-5-lean", wt, "main"], r);
    assert.ok(listedWorktree(gitSync(["worktree", "list", "--porcelain"], r), wt), "registered");
    const v = await verifyLaneWorktree({ git, exists, wt, cwd: r });
    assert.equal(v.ok, true, v.why);
    assert.equal(staged(r), "", "the operator's checkout is untouched");
  });

  it("quarantine never overwrites an earlier quarantined folder; a failed move throws", () => {
    const { wt } = repo();
    mkdirSync(wt);
    const first = quarantineDir(wt, { now: () => 7 });
    mkdirSync(wt);
    const second = quarantineDir(wt, { now: () => 7 });
    assert.notEqual(first, second);
    mkdirSync(wt);
    assert.throws(() => quarantineDir(wt, { rename: () => { throw new Error("EBUSY: resource busy or locked"); } }), /EBUSY/);
  });
});
