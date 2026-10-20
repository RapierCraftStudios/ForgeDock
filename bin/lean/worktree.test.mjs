// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpDir } from "../tests/_tmp.mjs";
import { join, dirname } from "node:path";
import { sparsePlan, sparsePatterns, addLaneWorktree } from "./worktree.mjs";

const MiB = 1024 * 1024;
const gitSync = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * MiB, stdio: ["ignore", "pipe", "pipe"] });
const git = async (args, { cwd } = {}) => gitSync(args, cwd);
const write = async (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const blob = (n, ch = "x") => ch.repeat(n);

/** A fixture repo: {path: content}. Returns its dir. */
function repo(files) {
  const dir = tmpDir("wt4221-");
  const r = join(dir, "r");
  mkdirSync(r);
  gitSync(["init", "-q", "-b", "main"], r);
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(r, p)), { recursive: true }); writeFileSync(join(r, p), c); }
  gitSync(["add", "-A"], r);
  gitSync(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], r);
  return { dir, r, wt: join(dir, "wt") };
}
/** Bytes of regular files on disk under `d`, skipping .git. */
function diskBytes(d) {
  let n = 0;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = join(d, e.name);
    if (e.isDirectory()) n += diskBytes(p); else if (e.isFile()) n += statSync(p).size;
  }
  return n;
}

const FIXTURES = {
  "npm JS/TS": {
    files: { "package.json": '{"name":"a","version":"1.0.0"}\n', "package-lock.json": `{"lockfileVersion":3,"pad":"${blob(MiB + 10)}"}\n`,
      "tsconfig.json": "{}\n", "src/index.ts": "export const x = 1;\n", "public/asset.json": blob(2 * MiB) },
    big: "public/asset.json", kept: ["package.json", "package-lock.json", "src/index.ts", "tsconfig.json"],
  },
  "uv Python": {
    files: { "pyproject.toml": '[project]\nname = "a"\nversion = "0.1.0"\n', "uv.lock": `version = 1\n# ${blob(MiB + 10)}\n`,
      "app/main.py": "print(1)\n", "data/blob.bin": blob(2 * MiB, "\u0001") },
    big: "data/blob.bin", kept: ["pyproject.toml", "uv.lock", "app/main.py"],
  },
};

describe("sparse lane worktrees (#4221)", () => {
  for (const [name, fx] of Object.entries(FIXTURES)) {
    it(`${name}: large blobs stay out, lockfiles and manifests stay in, git sees no change`, async () => {
      const { dir, r, wt } = repo(fx.files);
      try {
        const res = await addLaneWorktree(git, write, { cwd: r, wt, addArgs: ["worktree", "add", "-B", "feat/issue-1-lean", wt, "main"], ref: "main", maxBlobBytes: MiB });
        assert.deepEqual(res, { sparse: true, excluded: 1, bytes: 2 * MiB });
        assert.equal(existsSync(join(wt, fx.big)), false);
        assert.match(gitSync(["ls-files", "-t", fx.big], wt), /^S /);
        for (const k of fx.kept) assert.ok(existsSync(join(wt, k)), `${k} checked out`);
        assert.equal(gitSync(["status", "--porcelain"], wt), "");
        gitSync(["add", "-A"], wt);
        assert.equal(gitSync(["diff", "--cached", "--name-only"], wt), "", "git add -A stages no deletion");
        // R5: on-disk checkout is no more than the included blobs (+1 MiB slack): the left-out blob costs nothing.
        const included = Object.entries(fx.files).filter(([p]) => p !== fx.big).reduce((n, [, c]) => n + Buffer.byteLength(c), 0);
        assert.ok(diskBytes(wt) <= included + MiB, `disk ${diskBytes(wt)} <= ${included + MiB}`);
        assert.throws(() => gitSync(["config", "--get", "core.sparseCheckout"], r), "main checkout has no core.sparseCheckout");
        assert.equal(Object.keys(fx.files).every((p) => existsSync(join(r, p))), true);
        mkdirSync(dirname(join(wt, fx.big)), { recursive: true });
        writeFileSync(join(wt, fx.big), "regenerated\n");
        assert.match(gitSync(["status", "--porcelain"], wt), new RegExp(` M ${fx.big}`));
        gitSync(["checkout", "--", fx.big], wt);
        gitSync(["sparse-checkout", "add", `/${fx.big}`], wt);
        assert.equal(statSync(join(wt, fx.big)).size, 2 * MiB);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  it("a repo with no large blob gets today's plain worktree add", async () => {
    const { dir, r, wt } = repo({ "package.json": "{}\n", "src/a.js": "1\n" });
    try {
      const calls = [];
      const spy = async (a, o) => { calls.push(a); return git(a, o); };
      const addArgs = ["worktree", "add", "-B", "feat/issue-1-lean", wt, "main"];
      assert.deepEqual(await addLaneWorktree(spy, write, { cwd: r, wt, addArgs, ref: "main" }), { sparse: false, excluded: 0, bytes: 0 });
      assert.deepEqual(calls.filter((a) => a[0] === "worktree"), [addArgs]);
      assert.equal(calls.some((a) => a[0] === "sparse-checkout"), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("maxBlobBytes 0 disables it; a failing sparse step falls back to a full checkout", async () => {
    const { dir, r, wt } = repo({ "a.bin": blob(2 * MiB), "b.txt": "1\n" });
    try {
      const calls = [];
      const spy = async (a, o) => { calls.push(a); return git(a, o); };
      await addLaneWorktree(spy, write, { cwd: r, wt, addArgs: ["worktree", "add", "-B", "lane", wt, "main"], ref: "main", maxBlobBytes: 0 });
      assert.equal(calls.some((a) => a[0] === "ls-tree" || a.includes("--no-checkout")), false);
      assert.ok(existsSync(join(wt, "a.bin")));
      gitSync(["worktree", "remove", "--force", wt], r);
      const failing = async (a, o) => { if (a[0] === "read-tree" && !failing.done) { failing.done = true; throw Object.assign(new Error("boom"), { stderr: "fatal: boom" }); } return git(a, o); };
      const res = await addLaneWorktree(failing, write, { cwd: r, wt, addArgs: ["worktree", "add", "-B", "lane", wt, "main"], ref: "main", maxBlobBytes: MiB });
      assert.equal(res.sparse, false);
      assert.match(res.fallback, /boom/);
      assert.ok(existsSync(join(wt, "a.bin")) && existsSync(join(wt, "b.txt")));
      assert.equal(gitSync(["status", "--porcelain"], wt), "");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a failing worktree add is rethrown unchanged (the caller retries lock races)", async () => {
    const e = Object.assign(new Error("lock"), { stderr: "could not lock config file" });
    const g = async (a) => { if (a[0] === "worktree") throw e; return "100644 blob " + "a".repeat(40) + " 2000000\tbig.bin\0"; };
    await assert.rejects(addLaneWorktree(g, write, { cwd: "/x", wt: "/x/wt", addArgs: ["worktree", "add", "/x/wt", "main"], ref: "main" }), (x) => x === e);
  });

  it("sparsePlan: threshold, keep-list, symlinks and gitlinks; patterns escape glob characters", () => {
    const h = "a".repeat(40);
    const out = [
      `100644 blob ${h} 2000000\tweb/openapi.json`, `100755 blob ${h} 1048576\tbin/tool`, `100644 blob ${h}  1048575\tsmall.txt`,
      `120000 blob ${h}      40\tlink`, `160000 commit ${h}       -\tsub`, `100644 blob ${h} 3000000\tpnpm-lock.yaml`,
      `100644 blob ${h} 3000000\tsvc/requirements-dev.txt`, `100644 blob ${h} 3000000\tpkg/tsconfig.base.json`, `100644 blob ${h} 5000000\ta [x]*?.bin `,
    ].join("\0") + "\0";
    const p = sparsePlan(out, { maxBlobBytes: MiB });
    assert.deepEqual(p.excludes, ["web/openapi.json", "bin/tool", "a [x]*?.bin "]);
    assert.equal(p.bytes, 2000000 + 1048576 + 5000000);
    assert.deepEqual(sparsePlan(out, { maxBlobBytes: 0 }).excludes, []);
    assert.deepEqual(sparsePatterns(p.excludes), ["/*", "!/web/openapi.json", "!/bin/tool", "!/a \\[x]\\*\\?.bin\\ "]);
  });

  it("an escaped pattern really matches its odd path", async () => {
    const odd = "d/a [x]*?.bin";
    const { dir, r, wt } = repo({ [odd]: blob(2 * MiB), "d/a x.bin": "keep\n", "f.txt": "1\n" });
    try {
      const res = await addLaneWorktree(git, write, { cwd: r, wt, addArgs: ["worktree", "add", "-B", "lane", wt, "main"], ref: "main", maxBlobBytes: MiB });
      assert.equal(res.sparse, true);
      assert.equal(existsSync(join(wt, odd)), false);
      assert.ok(existsSync(join(wt, "d/a x.bin")));
      assert.equal(gitSync(["status", "--porcelain"], wt), "");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
