// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4651: sign-off rewrite of a lane's own unpushed commits, on a real temp git repo (bare origin + clone).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { ensureSignedOff, needsSignoff, offendersOf } from "./signoff.mjs";

const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));
const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...CLEAN, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
const PLACEHOLDER = ["-c", "user.name=forgedock", "-c", "user.email=forgedock@localhost"];

function fixture() {
  const root = tmpDir("signoff-"), origin = join(root, "origin.git"), wt = join(root, "wt");
  sh(root, "init", "--bare", "-b", "staging", origin);
  sh(root, "clone", origin, wt);
  sh(wt, "config", "user.name", "Lane Bot"); sh(wt, "config", "user.email", "lane@example.com");
  const commit = (file, msg, ...flags) => { writeFileSync(join(wt, file), `${file}\n`); sh(wt, "add", file); sh(wt, ...(flags.includes("placeholder") ? PLACEHOLDER : []), "commit", "-q", "-m", msg, ...flags.filter((f) => f !== "placeholder")); return sh(wt, "rev-parse", "HEAD"); };
  commit("base.txt", "base");
  sh(wt, "push", "-q", "origin", "HEAD:staging");
  sh(wt, "checkout", "-q", "-b", "feat/x");
  const git = async (a, o = {}) => execFileSync("git", a, { cwd: wt, encoding: "utf8", env: { ...CLEAN, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...(o.env ?? {}) } }).trim();
  return { wt, commit, git, sh: (...a) => sh(wt, ...a) };
}

describe("needsSignoff / offendersOf", () => {
  it("flags placeholder authors and missing or mismatched sign-offs", () => {
    assert.equal(needsSignoff({ authorEmail: "a@x.io", committerEmail: "a@x.io", signedOff: ["A <a@x.io>"] }), false);
    assert.equal(needsSignoff({ authorEmail: "a@x.io", committerEmail: "a@x.io", signedOff: [] }), true);
    assert.equal(needsSignoff({ authorEmail: "a@x.io", committerEmail: "a@x.io", signedOff: ["B <b@x.io>"] }), true);
    assert.equal(needsSignoff({ authorEmail: "forgedock@localhost", committerEmail: "forgedock@localhost", signedOff: ["F <forgedock@localhost>"] }), true);
    assert.deepEqual(offendersOf(""), []);
  });
});

describe("ensureSignedOff", () => {
  it("rewrites unpushed placeholder-author commits and leaves pushed commits alone", async () => {
    const f = fixture();
    const pushed = f.commit("a.txt", "pushed unsigned", "placeholder");
    f.sh("push", "-q", "origin", "feat/x");
    const bad = f.commit("b.txt", "unpushed placeholder", "placeholder");
    const unsigned = f.commit("c.txt", "unpushed unsigned");
    const good = f.commit("d.txt", "unpushed signed", "--signoff");
    const r = await ensureSignedOff({ git: f.git, lane: "staging", branch: "feat/x", env: {} });
    assert.equal(r.rewritten, 2);
    const rows = f.sh("log", "--format=%H|%ae|%(trailers:key=Signed-off-by,valueonly,separator=;)", "origin/feat/x..HEAD").split("\n").map((l) => l.split("|"));
    assert.equal(rows.length, 3);
    for (const [, email, so] of rows) { assert.equal(email, "lane@example.com"); assert.match(so, /Lane Bot <lane@example\.com>/); }
    const shas = rows.map((x) => x[0]);
    assert.ok(!shas.includes(bad) && !shas.includes(unsigned), "originals are gone from the pushed range");
    assert.equal(f.sh("rev-parse", "origin/feat/x"), pushed);
    assert.equal(f.sh("merge-base", "--is-ancestor", pushed, "HEAD") ?? "", "");
    assert.equal(f.sh("log", "-1", "--format=%ae", pushed), "forgedock@localhost"); // the pushed commit itself is untouched
    assert.equal(f.sh("rev-parse", "HEAD~3"), pushed);
    assert.equal(f.sh("show", "-s", "--format=%an", "HEAD"), "Lane Bot"); // the already-signed one is authored by the lane here, so it is unchanged
    assert.ok(good);
  });
  it("never rewrites commits already on origin/<lane>, nor a clean range", async () => {
    const f = fixture();
    f.sh("checkout", "-q", "staging");
    const onLane = f.commit("l.txt", "lane commit unsigned", "placeholder");
    f.sh("push", "-q", "origin", "staging");
    f.sh("checkout", "-q", "feat/x"); f.sh("merge", "-q", "--no-edit", "staging");
    f.commit("m.txt", "mine", "--signoff");
    const before = f.sh("rev-parse", "HEAD");
    const r = await ensureSignedOff({ git: f.git, lane: "staging", branch: "feat/x", env: {} });
    assert.equal(r.rewritten, 0);
    assert.equal(f.sh("rev-parse", "HEAD"), before);
    assert.equal(f.sh("merge-base", "--is-ancestor", onLane, "HEAD") ?? "", "");
  });
  it("rewrites with a merge commit in the range and keeps lane commits intact", async () => {
    const f = fixture();
    f.sh("checkout", "-q", "staging");
    const onLane = f.commit("l.txt", "lane commit", "placeholder");
    f.sh("push", "-q", "origin", "staging");
    f.sh("checkout", "-q", "feat/x");
    f.commit("b.txt", "unpushed placeholder", "placeholder");
    f.sh("merge", "-q", "--no-edit", "staging");
    const r = await ensureSignedOff({ git: f.git, lane: "staging", branch: "feat/x", env: {} });
    assert.equal(r.rewritten, 1);
    assert.equal(f.sh("merge-base", "--is-ancestor", onLane, "HEAD") ?? "", "");
    assert.equal(f.sh("log", "--format=%ae", "origin/staging..HEAD", "--no-merges"), "lane@example.com");
    assert.equal(f.sh("log", "-1", "--format=%ae", onLane), "forgedock@localhost");
  });
  it("uses GIT_AUTHOR_* from the env over the worktree config (sandbox lanes)", async () => {
    const f = fixture();
    f.commit("b.txt", "unpushed placeholder", "placeholder");
    await ensureSignedOff({ git: f.git, lane: "staging", branch: "feat/x", env: { GIT_AUTHOR_NAME: "Host Dev", GIT_AUTHOR_EMAIL: "host@example.com" } });
    assert.equal(f.sh("log", "-1", "--format=%ae|%an"), "host@example.com|Host Dev");
    assert.match(f.sh("log", "-1", "--format=%(trailers:key=Signed-off-by,valueonly)"), /Host Dev <host@example\.com>/);
  });
  it("throws noIdentity (and rewrites nothing) when the worktree has no usable identity", async () => {
    const f = fixture();
    const bad = f.commit("b.txt", "unpushed placeholder", "placeholder");
    f.sh("config", "user.email", "forgedock@localhost");
    await assert.rejects(ensureSignedOff({ git: f.git, lane: "staging", branch: "feat/x", env: {} }), (e) => e.noIdentity === true);
    assert.equal(f.sh("rev-parse", "HEAD"), bad);
  });
});
