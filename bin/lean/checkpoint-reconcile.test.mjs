// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5202: a pushed checkpoint the lane amended locally is merged back in before the push, on a real temp git repo (bare origin + clone).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { reconcileCheckpoints } from "./checkpoint-reconcile.mjs";

const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));
const ENV = { ...CLEAN, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
const CKPT = "wip(forge): checkpoint after context ceiling";

function fixture() {
  const root = tmpDir("reconcile-"), origin = join(root, "origin.git"), wt = join(root, "wt");
  sh(root, "init", "--bare", "-b", "staging", origin);
  sh(root, "clone", "-q", origin, wt);
  sh(wt, "config", "user.name", "Lane Bot"); sh(wt, "config", "user.email", "lane@example.com");
  const commit = (file, msg, dir = wt) => { writeFileSync(join(dir, file), `${file}\n`); sh(dir, "add", file); sh(dir, "commit", "-q", "-m", msg); return sh(dir, "rev-parse", "HEAD"); };
  commit("base.txt", "base");
  sh(wt, "push", "-q", "origin", "HEAD:staging");
  sh(wt, "checkout", "-q", "-b", "feat/x");
  const git = async (a) => execFileSync("git", a, { cwd: wt, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { root, origin, wt, commit, git, sh: (...a) => sh(wt, ...a) };
}
const isAncestor = (f, a, b) => { try { f.sh("merge-base", "--is-ancestor", a, b); return true; } catch { return false; } };

describe("reconcileCheckpoints (#5202)", () => {
  it("#5202 a pushed checkpoint the lane amended is merged in: HEAD descends from it, the tree is kept, a plain push succeeds", async () => {
    const f = fixture();
    const ckpt = f.commit("a.txt", CKPT);
    f.sh("push", "-q", "-u", "origin", "feat/x");
    f.sh("commit", "-q", "--amend", "-m", "fix: a proper message");
    f.commit("b.txt", "feat: more");
    const tree = f.sh("rev-parse", "HEAD^{tree}");
    assert.equal(isAncestor(f, ckpt, "HEAD"), false);
    const r = await reconcileCheckpoints({ git: f.git, branch: "feat/x" });
    assert.equal(r.state, "reconciled");
    assert.equal(r.sha, ckpt);
    assert.equal(r.commits.length, 1);
    assert.equal(isAncestor(f, ckpt, "HEAD"), true);
    assert.equal(f.sh("rev-parse", "HEAD^{tree}"), tree);
    f.sh("push", "-q", "origin", "feat/x"); // plain push, no force
    assert.equal(sh(f.origin, "rev-parse", "feat/x"), f.sh("rev-parse", "HEAD"));
  });

  it("#5202 a branch already ahead of origin is left alone", async () => {
    const f = fixture();
    f.commit("a.txt", CKPT);
    f.sh("push", "-q", "-u", "origin", "feat/x");
    const head = f.commit("b.txt", "feat: more");
    assert.equal((await reconcileCheckpoints({ git: f.git, branch: "feat/x" })).state, "ok");
    assert.equal(f.sh("rev-parse", "HEAD"), head);
  });

  it("#5202 an unpushed branch is 'none'", async () => {
    const f = fixture();
    f.commit("a.txt", "feat: a");
    assert.equal((await reconcileCheckpoints({ git: f.git, branch: "feat/x" })).state, "none");
  });

  it("#5202 a remote-only commit that is not a checkpoint is 'foreign' and HEAD is unchanged", async () => {
    const f = fixture();
    f.commit("a.txt", "feat: a");
    f.sh("push", "-q", "-u", "origin", "feat/x");
    f.sh("commit", "-q", "--amend", "-m", "feat: a reworded");
    const head = f.sh("rev-parse", "HEAD");
    const r = await reconcileCheckpoints({ git: f.git, branch: "feat/x" });
    assert.equal(r.state, "foreign");
    assert.equal(f.sh("rev-parse", "HEAD"), head);
  });

  it("#5202 a checkpoint pushed from another clone (not in this reflog) is 'foreign'", async () => {
    const f = fixture();
    f.commit("a.txt", "feat: a");
    f.sh("push", "-q", "-u", "origin", "feat/x");
    const other = join(f.root, "other");
    sh(f.root, "clone", "-q", "-b", "feat/x", f.origin, other);
    sh(other, "config", "user.name", "Other"); sh(other, "config", "user.email", "other@example.com");
    f.commit("c.txt", CKPT, other);
    sh(other, "push", "-q", "origin", "feat/x");
    const head = f.commit("b.txt", "feat: b");
    const r = await reconcileCheckpoints({ git: f.git, branch: "feat/x" });
    assert.equal(r.state, "foreign");
    assert.equal(f.sh("rev-parse", "HEAD"), head);
  });

  it("#5202 git failures never throw", async () => {
    const r = await reconcileCheckpoints({ git: async (a) => { if (a[0] === "fetch") throw new Error("offline"); if (a[0] === "rev-parse") return "x"; if (a[0] === "merge-base") throw new Error("no"); throw new Error("boom"); }, branch: "feat/x" });
    assert.equal(r.state, "error");
  });
});
