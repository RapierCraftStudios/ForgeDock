// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5947: pool/image/mirror.sh validates, quarantines and builds the shared bare mirror atomically, once.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./_tmp.mjs";

const SCRIPT = new URL("../../pool/image/mirror.sh", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString();
const prepare = (url, mirror, env = {}) => new Promise((res) => execFile("bash", [SCRIPT, "prepare", url, mirror], { env: { ...process.env, MIRROR_RETRY_SLEEP: "0", ...env } }, (e, out) => res({ code: e ? e.code : 0, out: out.trim() })));
const source = () => {
  const d = tmpDir("mirror-src-");
  git(d, "init", "-q", "-b", "main"); writeFileSync(join(d, "a"), "x"); git(d, "add", "a"); git(d, "commit", "-qm", "c");
  return d;
};

describe("#5947 mirror.sh", () => {
  it("builds a missing mirror, then reuses it", async () => {
    const src = source(), cache = tmpDir("mirror-cache-"), m = join(cache, "o_r.git");
    assert.equal((await prepare(src, m)).out, "ok");
    assert.ok(existsSync(join(m, "HEAD")));
    assert.equal((await prepare(src, m)).out, "ok");
  });

  it("an empty object file is detected, quarantined and bypassed with 'direct'; the mirror is rebuilt in the background", async () => {
    const src = source(), cache = tmpDir("mirror-cache-"), m = join(cache, "o_r.git");
    assert.equal((await prepare(src, m)).out, "ok");
    const obj = execFileSync("find", [join(m, "objects"), "-type", "f", "-path", "*/??/*"]).toString().split("\n")[0];
    rmSync(obj); // a local clone hardlinks objects: replace the file, never truncate the shared inode
    writeFileSync(obj, "");
    const r = await prepare(src, m);
    assert.equal(r.code, 0);
    assert.equal(r.out, "direct");
    await new Promise((res) => { const t = setInterval(() => { if (readdirSync(cache).some((n) => n.startsWith("o_r.git.corrupt-")) && existsSync(join(m, "HEAD"))) { clearInterval(t); res(); } }, 100); setTimeout(() => { clearInterval(t); res(); }, 15000); });
    assert.ok(readdirSync(cache).some((n) => n.startsWith("o_r.git.corrupt-")), "quarantined as .corrupt-<ts>");
    assert.equal((await prepare(src, m)).out, "ok", "rebuilt mirror is valid");
  });

  it("a mirror with no refs is invalid", async () => {
    const cache = tmpDir("mirror-cache-"), m = join(cache, "e.git");
    git(cache, "init", "-q", "--bare", m);
    assert.throws(() => execFileSync("bash", [SCRIPT, "valid", m], { stdio: "pipe" }));
  });

  it("ten concurrent invocations on a missing mirror build once", async () => {
    const src = source(), cache = tmpDir("mirror-cache-"), m = join(cache, "o_r.git"), log = join(cache, "builds.log");
    const rs = await Promise.all(Array.from({ length: 10 }, () => prepare(src, m, { MIRROR_BUILD_LOG: log })));
    assert.ok(rs.every((r) => r.out === "ok"), JSON.stringify(rs.map((r) => r.out)));
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
  });

  it("a failing fetch leaves no <name>.git and no tmp dir behind, and the lane is told 'direct'", async () => {
    const cache = tmpDir("mirror-cache-"), m = join(cache, "o_r.git");
    mkdirSync(cache, { recursive: true });
    const r = await prepare(join(cache, "no-such-remote"), m);
    assert.equal(r.out, "direct");
    assert.equal(existsSync(m), false);
    assert.deepEqual(readdirSync(cache).filter((n) => n.includes(".tmp-")), []);
  });
});
