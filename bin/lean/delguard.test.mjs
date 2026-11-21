// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** #5819: the checkpoint deletion guard on a real git repo. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { guardStagedDeletions, parseStagedDeletions, maxForeignDeletions, deletionEvidence } from "./delguard.mjs";

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
const put = (cwd, f, t = "x\n") => { mkdirSync(dirname(join(cwd, f)), { recursive: true }); writeFileSync(join(cwd, f), t); };
const PKG = Array.from({ length: 12 }, (_, i) => `packages/adapters/src/f${i}.ts`);
const repo = () => {
  const d = tmpDir("delguard-repo-");
  sh(d, "init", "-q", "-b", "main"); sh(d, "config", "user.email", "t@t"); sh(d, "config", "user.name", "t");
  for (const f of ["src/a.js", "src/b.js", "docs/old.md", ...PKG]) put(d, f, `${f}\n`);
  sh(d, "add", "-A"); sh(d, "commit", "-q", "-m", "base");
  sh(d, "checkout", "-q", "-b", "lane");
  return d;
};
const gitIn = (d) => async (args) => execFileSync("git", args, { cwd: d, encoding: "utf8" });
const stagedNames = (d) => sh(d, "diff", "--cached", "--name-status").trim().split("\n").filter(Boolean);
const checkpoint = async (d, o) => { sh(d, "add", "-A"); const g = await guardStagedDeletions({ git: gitIn(d), base: "main", ...o }); return g; };

describe("guardStagedDeletions (#5819)", () => {
  it("a staged diff deleting tracked files outside the deliverables is refused: the files are unstaged and back on disk, the rest still commits", async () => {
    const d = repo();
    put(d, "src/a.js", "fixed\n");
    rmSync(join(d, "packages"), { recursive: true }); // what the failed publish did
    const g = await checkpoint(d, { keep: ["src/a.js"] });
    assert.equal(g.refused, true);
    assert.equal(g.foreign.length, PKG.length);
    assert.equal(g.restored, true);
    for (const f of PKG) assert.ok(existsSync(join(d, f)), f);
    assert.deepEqual(stagedNames(d), ["M\tsrc/a.js"], "only the real change stays staged");
    sh(d, "commit", "-q", "-m", "wip(forge): checkpoint after exit (needs-human)");
    assert.equal(sh(d, "diff", "--name-status", "main", "HEAD").trim(), "M\tsrc/a.js");
    assert.match(deletionEvidence(g), /deleted 12 tracked file\(s\) outside the contract deliverables .*restored in the worktree and nothing was pushed/);
  });

  it("deletions listed as deliverables (a file or a directory) commit unchanged", async () => {
    const d = repo();
    rmSync(join(d, "src/b.js")); rmSync(join(d, "packages"), { recursive: true });
    const g = await checkpoint(d, { keep: ["src/b.js", "packages/adapters/"] });
    assert.equal(g.refused, false);
    assert.equal(g.deleted.length, PKG.length + 1);
    assert.deepEqual(g.foreign, []);
    assert.ok(!existsSync(join(d, "src/b.js")));
    assert.equal(stagedNames(d).filter((l) => l.startsWith("D\t")).length, PKG.length + 1);
  });

  it("a file the lane added itself (absent on the base) is the lane's to delete", async () => {
    const d = repo();
    put(d, "src/tmp-helper.js"); sh(d, "add", "-A"); sh(d, "commit", "-q", "-m", "lane add");
    rmSync(join(d, "src/tmp-helper.js"));
    const g = await checkpoint(d, { keep: [] });
    assert.equal(g.refused, false);
    assert.deepEqual(g.deleted, ["src/tmp-helper.js"]);
  });

  it("the threshold tolerates up to `max` foreign deletions", async () => {
    const d = repo();
    rmSync(join(d, "src/b.js")); rmSync(join(d, "docs/old.md"));
    assert.equal((await checkpoint(d, { keep: [], max: 2 })).refused, false);
    const g = await checkpoint(d, { keep: [], max: 1 });
    assert.equal(g.refused, true);
    assert.ok(existsSync(join(d, "src/b.js")) && existsSync(join(d, "docs/old.md")));
  });

  it("a rename into a deliverable commits; a rename of a non-deliverable is undone on both sides", async () => {
    const d = repo();
    renameSync(join(d, "docs/old.md"), join(d, "docs/new.md"));
    assert.equal((await checkpoint(d, { keep: ["docs/new.md"] })).refused, false);
    sh(d, "reset", "-q"); renameSync(join(d, "docs/new.md"), join(d, "docs/old.md"));
    renameSync(join(d, "src/b.js"), join(d, "src/c.js"));
    const g = await checkpoint(d, { keep: ["src/a.js"] });
    assert.equal(g.refused, true);
    assert.deepEqual(g.foreign, ["src/b.js"]);
    assert.ok(existsSync(join(d, "src/b.js")), "original restored");
    assert.deepEqual(stagedNames(d), [], "neither side of the rename stays staged");
  });

  it("nothing staged, or git unreadable: no refusal", async () => {
    const d = repo();
    assert.deepEqual(await checkpoint(d, { keep: [] }), { refused: false, deleted: [], foreign: [] });
    assert.equal((await guardStagedDeletions({ git: async () => { throw new Error("boom"); } })).refused, false);
  });
});

describe("delguard helpers (#5819)", () => {
  it("parses diff-index -z output and ignores anything else", () => {
    assert.deepEqual(parseStagedDeletions("D\0a/b.js\0R087\0old.js\0new.js\0"), [{ path: "a/b.js", to: null }, { path: "old.js", to: "new.js" }]);
    assert.deepEqual(parseStagedDeletions("diff --git a/src/foo.js b/src/foo.js\n+fix"), []);
    assert.deepEqual(parseStagedDeletions(""), []);
  });
  it("FORGE_CHECKPOINT_MAX_DELETIONS: a non-negative integer, else 0", () => {
    assert.equal(maxForeignDeletions({}), 0);
    assert.equal(maxForeignDeletions({ FORGE_CHECKPOINT_MAX_DELETIONS: "5" }), 5);
    assert.equal(maxForeignDeletions({ FORGE_CHECKPOINT_MAX_DELETIONS: "-1" }), 0);
    assert.equal(maxForeignDeletions({ FORGE_CHECKPOINT_MAX_DELETIONS: "lots" }), 0);
  });
});
