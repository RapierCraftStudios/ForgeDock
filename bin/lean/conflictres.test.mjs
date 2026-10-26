// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4588: deterministic base-merge conflict resolution, on real temp git repos.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { readBaseMerge } from "../engine-cli.mjs";
import { resolveBaseConflicts, jsonUnionText } from "./conflictres.mjs";

const sh = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const put = (root, files) => { for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); } };
const commit = (d, m) => { sh(d, "add", "-A"); sh(d, "commit", "-qm", m); };

/** A repo whose lane and main both edited `files`; the merge of main into the lane is left in progress. */
function conflicted(root, start, lane, main) {
  sh(root, "init", "-q", "-b", "main"); put(root, start); commit(root, "base");
  sh(root, "checkout", "-qb", "lane"); put(root, lane); commit(root, "lane");
  sh(root, "checkout", "-q", "main"); put(root, main); commit(root, "main");
  sh(root, "checkout", "-q", "lane");
  try { sh(root, "merge", "--no-edit", "main"); } catch { /* conflicts */ }
  return Object.keys(start).filter((f) => sh(root, "diff", "--name-only", "--diff-filter=U").split("\n").includes(f));
}
const env = (root) => ({ git: async (a) => sh(root, ...a), cwd: root });

describe("resolveBaseConflicts (#4588)", () => {
  it("union: two lanes appending to one barrel keep both lines", async () => {
    const root = tmpDir("cr-union"); const files = conflicted(root, { "index.ts": "a\n" }, { "index.ts": "a\nlane\n" }, { "index.ts": "a\nmain\n" });
    const r = await resolveBaseConflicts({ ...env(root), files, cfg: { unionGlobs: ["index.ts"] } });
    assert.deepEqual(r, { resolved: ["index.ts"], remaining: [] });
    assert.equal(readFileSync(join(root, "index.ts"), "utf8"), "a\nlane\nmain\n");
    sh(root, "commit", "--no-edit"); // all staged: the merge commits
  });

  it("union: a hunk that edits a base line is refused and stays conflicted", async () => {
    const root = tmpDir("cr-union-edit"); const files = conflicted(root, { "index.ts": "a\n" }, { "index.ts": "x\n" }, { "index.ts": "y\n" });
    assert.deepEqual(await resolveBaseConflicts({ ...env(root), files, cfg: { unionGlobs: ["index.ts"] } }), { resolved: [], remaining: ["index.ts"] });
  });

  it("json: key union of a status map; the lane's indent is kept", async () => {
    const root = tmpDir("cr-json");
    const files = conflicted(root, { "status.json": '{\n    "a": 1\n}\n' }, { "status.json": '{\n    "a": 1,\n    "lane": 2\n}\n' }, { "status.json": '{\n    "a": 1,\n    "main": 3\n}\n' });
    const r = await resolveBaseConflicts({ ...env(root), files, cfg: { jsonGlobs: ["status.json"] } });
    assert.deepEqual(r.resolved, ["status.json"]);
    assert.equal(readFileSync(join(root, "status.json"), "utf8"), '{\n    "a": 1,\n    "lane": 2,\n    "main": 3\n}\n');
  });

  it("json: the same key changed differently on both sides is refused", async () => {
    const root = tmpDir("cr-json-clash");
    const files = conflicted(root, { "status.json": '{"a":1}\n' }, { "status.json": '{"a":2}\n' }, { "status.json": '{"a":3}\n' });
    assert.deepEqual(await resolveBaseConflicts({ ...env(root), files, cfg: { jsonGlobs: ["status.json"] } }), { resolved: [], remaining: ["status.json"] });
    assert.throws(() => jsonUnionText('[1]', '[2]', '[3]'));
  });

  it("generated: the base side is taken and the command regenerates the file", async () => {
    const root = tmpDir("cr-gen");
    const files = conflicted(root, { "gen/out.txt": "v0\n", "src.txt": "s\n" }, { "gen/out.txt": "lane\n" }, { "gen/out.txt": "main\n" });
    const r = await resolveBaseConflicts({ ...env(root), files, cfg: { generatedGlobs: ["gen/*"], generatedCommand: "echo regenerated > gen/out.txt" } });
    assert.deepEqual(r, { resolved: ["gen/out.txt"], remaining: [] });
    assert.equal(readFileSync(join(root, "gen/out.txt"), "utf8"), "regenerated\n");
    assert.equal(sh(root, "diff", "--name-only", "--diff-filter=U"), "");
  });

  it("generated: a failing command leaves the file conflicted", async () => {
    const root = tmpDir("cr-gen-fail");
    const files = conflicted(root, { "gen/out.txt": "v0\n" }, { "gen/out.txt": "lane\n" }, { "gen/out.txt": "main\n" });
    const r = await resolveBaseConflicts({ ...env(root), files, cfg: { generatedGlobs: ["gen/*"], generatedCommand: "exit 3" } });
    assert.deepEqual(r.resolved, []);
    assert.deepEqual(r.remaining, ["gen/out.txt"]);
    assert.match(r.note, /generated command failed/);
    assert.match(readFileSync(join(root, "gen/out.txt"), "utf8"), /<<<<<<</);
  });

  it("sequence files and unconfigured files are left alone", async () => {
    const root = tmpDir("cr-skip");
    const files = conflicted(root, { "db/meta/_journal.json": '{"a":1}\n', "x.ts": "a\n" }, { "db/meta/_journal.json": '{"a":1,"l":1}\n', "x.ts": "a\nl\n" }, { "db/meta/_journal.json": '{"a":1,"m":1}\n', "x.ts": "a\nm\n" });
    const r = await resolveBaseConflicts({ ...env(root), files, cfg: { jsonGlobs: ["*.json"] } });
    assert.deepEqual(r.resolved, []);
    assert.deepEqual(r.remaining.sort(), ["db/meta/_journal.json", "x.ts"]);
    assert.deepEqual(await resolveBaseConflicts({ ...env(root), files, cfg: {} }), { resolved: [], remaining: files });
  });
});

describe("readBaseMerge (#4588)", () => {
  it("reads lean.base_merge_* and is undefined when no glob is set", () => {
    const root = tmpDir("cr-cfg");
    assert.equal(readBaseMerge(root), undefined);
    writeFileSync(join(root, "forge.yaml"), 'lean:\n  base_merge_union_globs: "index.ts, **/messages.ts"\n  base_merge_json_globs: "status.json"\n  base_merge_generated_globs: "gen/**"\n  base_merge_generated_command: "pnpm gen"\n');
    assert.deepEqual(readBaseMerge(root), { unionGlobs: ["index.ts", "**/messages.ts"], jsonGlobs: ["status.json"], generatedGlobs: ["gen/**"], generatedCommand: "pnpm gen" });
  });
});
