// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { isToolState, denied, untrackToolState, unstageToolState, gitignoreAdditions, clearLaneScratch } from "./toolstate.mjs";

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
const put = (cwd, f, t = "x\n") => { mkdirSync(dirname(join(cwd, f)), { recursive: true }); writeFileSync(join(cwd, f), t); };
const repo = () => {
  const d = tmpDir("toolstate-repo-");
  sh(d, "init", "-q", "-b", "main"); sh(d, "config", "user.email", "t@t"); sh(d, "config", "user.name", "t");
  put(d, "src/a.js"); put(d, ".gitignore", "next-env.d.ts\n"); sh(d, "add", "-A"); sh(d, "commit", "-q", "-m", "base");
  sh(d, "checkout", "-q", "-b", "lane");
  return d;
};
const gitIn = (d) => async (args) => execFileSync("git", args, { cwd: d, encoding: "utf8" });

describe("isToolState (#4590)", () => {
  it("matches scratch and caches at any depth, nothing else", () => {
    for (const p of [".forge-lean/result.json", ".forge-lean/logs/x", "apps/worker/.eslintcache", ".eslintcache", "a/b/tsconfig.tsbuildinfo"]) assert.ok(isToolState(p), p);
    for (const p of ["src/eslintcache.ts", "src/.eslintcache.md", "forge-lean/x", "docs/.forge-lean.md", "apps/web/next-env.d.ts", "x.tsbuildinfo.json"]) assert.ok(!isToolState(p), p);
  });
  it("next-env.d.ts only when the repo ignores it", () => {
    assert.ok(isToolState("apps/web/next-env.d.ts", { nextEnvIgnored: true }));
    assert.deepEqual(denied(["a", ".eslintcache"]), [".eslintcache"]);
  });
});

describe("untrackToolState on a real repo (#4590)", () => {
  it("removes what the lane added, keeps product files and files the base tracks, then a second run is a no-op", async () => {
    const d = repo();
    put(d, "src/b.js"); put(d, ".forge-lean/result.json"); put(d, "apps/worker/.eslintcache"); put(d, "apps/web/next-env.d.ts");
    sh(d, "add", "-f", "-A");
    sh(d, "commit", "-q", "-m", "lane");
    const events = [];
    const removed = await untrackToolState({ git: gitIn(d), base: "main", ev: (e) => events.push(e) });
    assert.deepEqual(removed.sort(), [".forge-lean/result.json", "apps/web/next-env.d.ts", "apps/worker/.eslintcache"]);
    assert.equal(events[0].event, "TOOLSTATE_UNTRACKED");
    assert.deepEqual(sh(d, "diff", "--name-only", "main...HEAD").trim().split("\n"), ["src/b.js"]);
    assert.ok(sh(d, "status", "--porcelain").includes("?? .forge-lean/") || sh(d, "ls-files", "--others").includes(".forge-lean"), "files stay on disk");
    assert.deepEqual(await untrackToolState({ git: gitIn(d), base: "main" }), []);
  });

  it("a cache the base already tracks is the repo's own choice and stays", async () => {
    const d = repo(); sh(d, "checkout", "-q", "main");
    put(d, "pkg/.eslintcache"); sh(d, "add", "-A"); sh(d, "commit", "-q", "-m", "base cache"); sh(d, "checkout", "-q", "lane"); sh(d, "merge", "-q", "main");
    put(d, "src/c.js"); sh(d, "add", "-A"); sh(d, "commit", "-q", "-m", "lane");
    assert.deepEqual(await untrackToolState({ git: gitIn(d), base: "main" }), []);
    assert.ok(sh(d, "ls-files").includes("pkg/.eslintcache"));
  });

  it("a git failure never throws", async () => {
    const events = [];
    assert.deepEqual(await untrackToolState({ git: async () => { throw new Error("boom"); }, base: "main", ev: (e) => events.push(e) }), []);
    assert.equal(events[0].event, "TOOLSTATE_UNTRACK_FAILED");
  });
});

describe("unstageToolState (#4590)", () => {
  it("a checkpoint's add -A stages the work but not the scratch or caches", async () => {
    const d = repo(); put(d, "src/b.js"); put(d, ".eslintcache"); put(d, ".forge-lean/x");
    sh(d, "add", "-A", "-f");
    assert.equal(await unstageToolState(gitIn(d)), true);
    assert.equal(sh(d, "diff", "--cached", "--name-only").trim(), "src/b.js");
  });
  it("only tool state staged: nothing to commit", async () => {
    const d = repo(); put(d, ".eslintcache"); sh(d, "add", "-f", ".eslintcache");
    assert.equal(await unstageToolState(gitIn(d)), false);
  });
});

describe("gitignoreAdditions (#4590)", () => {
  it("adds only the missing lines, and next-env.d.ts only for Next.js", () => {
    assert.deepEqual(gitignoreAdditions(""), [".forge-lean/", ".eslintcache", "*.tsbuildinfo"]);
    assert.deepEqual(gitignoreAdditions("node_modules\n/.eslintcache\n.forge-lean/\n"), ["*.tsbuildinfo"]);
    assert.deepEqual(gitignoreAdditions(".forge-lean/\n.eslintcache\n*.tsbuildinfo\n"), []);
    assert.deepEqual(gitignoreAdditions(".forge-lean/\n.eslintcache\n*.tsbuildinfo\n", { next: true }), ["next-env.d.ts"]);
  });
});

describe("lane scratch is untracked and cleared (#4880)", () => {
  it("clearLaneScratch drops tracked and untracked on-disk scratch and leaves product files", async () => {
    const d = repo();
    put(d, ".forge-lean/result.json"); sh(d, "add", "-f", "-A"); sh(d, "commit", "-q", "-m", "tracked scratch");
    const fs = { exists: async (p) => existsSync(p) };
    assert.equal(await clearLaneScratch({ git: gitIn(d), fs, cwd: d }), true);
    assert.ok(!existsSync(join(d, ".forge-lean")));
    assert.equal(sh(d, "ls-files", ".forge-lean").trim(), "");
    assert.ok(existsSync(join(d, "src/a.js")));
    assert.equal(await clearLaneScratch({ git: gitIn(d), fs, cwd: d }), false, "nothing left to clear");
  });
  it("clearLaneScratch never throws, with or without fs.exists", async () => {
    const boom = async () => { throw new Error("git down"); };
    assert.equal(await clearLaneScratch({ git: boom, fs: {}, cwd: "/nope" }), false);
    assert.equal(await clearLaneScratch({ git: boom, fs: { exists: boom }, cwd: "/nope" }), false);
  });
  it("a checkpoint after add -A never commits .forge-lean files", async () => {
    const d = repo();
    put(d, ".forge-lean/investigation.md"); put(d, "src/b.js");
    sh(d, "add", "-f", "-A");
    assert.equal(await unstageToolState(gitIn(d)), true);
    sh(d, "commit", "-q", "-m", "checkpoint");
    assert.equal(sh(d, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter((f) => f.startsWith(".forge-lean/")).length, 0);
  });
  it("this repo ignores .forge-lean/ and no longer tracks it", () => {
    const root = join(dirname(new URL(import.meta.url).pathname), "..", "..");
    assert.ok(readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/).includes(".forge-lean/"));
    assert.equal(execFileSync("git", ["ls-files", ".forge-lean"], { cwd: root, encoding: "utf8" }).trim(), "");
  });
});
