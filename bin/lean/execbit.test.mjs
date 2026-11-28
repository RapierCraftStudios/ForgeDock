// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { execBitFindings, applyExecBits, invokesDirectly } from "./execbit.mjs";

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const put = (root, files) => { for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); } };
function repo(base, lane, { exec = [] } = {}) {
  const d = tmpDir("execbit-");
  sh(d, "init", "-q", "-b", "main");
  sh(d, "config", "core.fileMode", "true");
  put(d, base); for (const p of exec) chmodSync(join(d, p), 0o755);
  sh(d, "add", "-A"); sh(d, "commit", "-qm", "base", "--allow-empty");
  sh(d, "checkout", "-q", "-b", "lane");
  put(d, lane); sh(d, "add", "-A"); sh(d, "commit", "-qm", "lane");
  return d;
}
const find = (d) => execBitFindings({
  git: async (a) => sh(d, ...a), base: "main",
  readFile: async (p) => readFileSync(join(d, p), "utf8"),
  listFiles: async () => sh(d, "ls-files").split("\n").filter(Boolean),
});

describe("execbit (#6239)", () => {
  it("flags an added shebang file at 100644", async () => {
    const d = repo({ "a.txt": "x" }, { "bin/run": "#!/usr/bin/env node\n" });
    assert.deepEqual((await find(d)).map((f) => [f.path, f.kind]), [["bin/run", "missing-x"]]);
  });
  it("flags a *.sh invoked ./x.sh from a workflow", async () => {
    const d = repo({ "a.txt": "x" }, { "scripts/x.sh": "echo hi\n", ".github/workflows/ci.yml": "steps:\n  - run: ./scripts/x.sh\n" });
    assert.deepEqual((await find(d)).map((f) => f.path), ["scripts/x.sh"]);
  });
  it("does not flag a *.sh that callers run through bash", async () => {
    const d = repo({ "a.txt": "x" }, { "scripts/x.sh": "echo hi\n", "package.json": '{"scripts":{"t":"bash scripts/x.sh"}}' });
    assert.deepEqual(await find(d), []);
  });
  it("flags a 100755 -> 100644 regression", async () => {
    const d = repo({ "t.sh": "#!/bin/sh\n" }, { "t.sh": "#!/bin/sh\n# edit\n" }, { exec: ["t.sh"] });
    sh(d, "update-index", "--chmod=-x", "t.sh"); sh(d, "commit", "-qm", "drop x");
    assert.deepEqual((await find(d)).map((f) => [f.path, f.kind]), [["t.sh", "regression"]]);
  });
  it("leaves already-executable, non-script and fixture files alone", async () => {
    const d = repo({ "a.txt": "x" }, { "ok.sh": "#!/bin/sh\n", "notes.md": "text\n", "test/fixtures/f.sh": "#!/bin/sh\n" });
    sh(d, "update-index", "--chmod=+x", "ok.sh"); sh(d, "commit", "-qm", "x");
    assert.deepEqual(await find(d), []);
  });
  it("invokesDirectly negatives: interpreter, source and prefix-extended names", () => {
    assert.equal(invokesDirectly("sh scripts/x.sh", "scripts/x.sh"), false);
    assert.equal(invokesDirectly("source scripts/x.sh", "scripts/x.sh"), false);
    assert.equal(invokesDirectly("run: scripts/x.sh.bak", "scripts/x.sh"), false);
    assert.equal(invokesDirectly("run: scripts/x.sh --flag", "scripts/x.sh"), true);
  });
  it("applyExecBits issues update-index --chmod=+x", async () => {
    const calls = [];
    const fixed = await applyExecBits({ git: async (a) => { calls.push(a); }, findings: [{ path: "a.sh", kind: "missing-x" }, { path: "b", kind: "other" }] });
    assert.deepEqual(fixed, ["a.sh"]);
    assert.deepEqual(calls, [["update-index", "--chmod=+x", "--", "a.sh"]]);
  });
});
