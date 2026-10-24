// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4525: parked-PR base sync. Unit tests for the union resolver, and a real temp git repo (bare origin + clone).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { readOrchestration } from "../engine-cli.mjs";
import { orchestrate } from "./orchestrate.mjs";
import { unionResolve, matchesGlobs, isSequenceFile, syncParked } from "./basesync.mjs";

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const put = (root, files) => { for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); } };
const commit = (d, m) => { sh(d, "add", "-A"); sh(d, "commit", "-qm", m); };

const hunk = (ours, base, theirs) => `top\n<<<<<<< HEAD\n${ours}||||||| base\n${base}=======\n${theirs}>>>>>>> origin/main\nbottom\n`;

describe("unionResolve (#4525)", () => {
  it("keeps both sides when both only added lines", () => {
    assert.equal(unionResolve(hunk("a\n", "", "b\n")), "top\na\nb\nbottom\n");
  });
  it("refuses a hunk that modified or deleted base lines", () => {
    assert.equal(unionResolve(hunk("a\n", "x\n", "b\n")), null);
    assert.equal(unionResolve(hunk("", "x\n", "b\n")), null);
  });
  it("refuses text with no base section or no conflict", () => {
    assert.equal(unionResolve("top\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n"), null);
    assert.equal(unionResolve("plain\n"), null);
  });
  it("refuses a file when any one hunk is not a pure addition", () => {
    assert.equal(unionResolve(`${hunk("a\n", "", "b\n")}${hunk("c\n", "y\n", "d\n")}`), null);
  });
  it("matches globs and excludes sequence files", () => {
    assert.ok(matchesGlobs("src/registry/index.ts", ["src/registry/*.ts"]));
    assert.ok(matchesGlobs("a/b/CHANGELOG.md", ["CHANGELOG.md"]));
    assert.ok(matchesGlobs("a/b/c.txt", ["a/**"]));
    assert.ok(!matchesGlobs("a/b/c.txt", ["a/*.txt"]));
    assert.ok(!matchesGlobs("x", []));
    assert.ok(isSequenceFile("db/drizzle/meta/_journal.json"));
    assert.ok(isSequenceFile("db/drizzle/0007_usage.sql"));
    assert.ok(!isSequenceFile("src/registry.ts"));
  });
});

/** origin (bare) + clone `d` on main with registry.txt, other.txt; branch `lane` from main. Returns helpers. */
function fixture() {
  const root = tmpDir("basesync-");
  sh(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  const d = join(root, "work");
  sh(root, "clone", "-q", "origin.git", "work");
  sh(d, "checkout", "-qb", "main");
  put(d, { "reg/registry.txt": "a\nb\n", "other.txt": "one\ntwo\n", "db/_journal.json": "{}\n" });
  commit(d, "init"); sh(d, "push", "-q", "origin", "main");
  sh(d, "checkout", "-qb", "lane");
  const onLane = (files) => { sh(d, "checkout", "-q", "lane"); put(d, files); commit(d, "lane"); sh(d, "push", "-q", "origin", "lane"); };
  const onMain = (files) => { sh(d, "checkout", "-q", "main"); put(d, files); commit(d, "base"); sh(d, "push", "-q", "origin", "main"); };
  const git = async (a, o = {}) => sh(o.cwd ?? d, ...a);
  const tip = (b) => sh(root, "--git-dir", "origin.git", "rev-parse", b).trim();
  const show = (b, f) => sh(root, "--git-dir", "origin.git", "show", `${b}:${f}`);
  return { d, onLane, onMain, git, tip, show, tmp: root };
}

describe("syncParked (#4525)", () => {
  it("pushes a clean merge of the base into the branch", async () => {
    const f = fixture();
    f.onLane({ "lane.txt": "x\n" });
    f.onMain({ "other.txt": "one\ntwo\nthree\n" });
    const r = await syncParked({ git: f.git, base: "main", branch: "lane", tmp: f.tmp });
    assert.equal(r.status, "merged");
    assert.equal(f.show("lane", "other.txt"), "one\ntwo\nthree\n");
    assert.equal(f.show("lane", "lane.txt"), "x\n");
  });
  it("is up-to-date when the base is already merged, and unchanged for a handled base sha", async () => {
    const f = fixture();
    f.onLane({ "lane.txt": "x\n" });
    const r = await syncParked({ git: f.git, base: "main", branch: "lane", tmp: f.tmp });
    assert.equal(r.status, "up-to-date");
    f.onMain({ "m.txt": "m\n" });
    const r2 = await syncParked({ git: f.git, base: "main", branch: "lane", tmp: f.tmp, last: f.tip("main") });
    assert.equal(r2.status, "unchanged");
  });
  it("union-resolves a two-sided list addition in a matching file and pushes", async () => {
    const f = fixture();
    f.onLane({ "reg/registry.txt": "a\nb\nlane\n" });
    f.onMain({ "reg/registry.txt": "a\nb\nbase\n" });
    const r = await syncParked({ git: f.git, base: "main", branch: "lane", unionGlobs: ["reg/*.txt"], tmp: f.tmp });
    assert.equal(r.status, "merged");
    assert.equal(f.show("lane", "reg/registry.txt"), "a\nb\nlane\nbase\n");
  });
  it("reports other conflicts and leaves the branch alone", async () => {
    const f = fixture();
    f.onLane({ "other.txt": "one\nLANE\n" });
    f.onMain({ "other.txt": "one\nBASE\n" });
    const before = f.tip("lane");
    const r = await syncParked({ git: f.git, base: "main", branch: "lane", unionGlobs: ["reg/*.txt"], tmp: f.tmp });
    assert.equal(r.status, "conflict");
    assert.deepEqual(r.paths, ["other.txt"]);
    assert.equal(f.tip("lane"), before);
  });
  it("does not union-resolve a file outside the globs, or a _journal.json even when matched", async () => {
    const f = fixture();
    f.onLane({ "reg/registry.txt": "a\nb\nlane\n", "db/_journal.json": "{\"l\":1}\n" });
    f.onMain({ "reg/registry.txt": "a\nb\nbase\n", "db/_journal.json": "{\"b\":1}\n" });
    const r = await syncParked({ git: f.git, base: "main", branch: "lane", unionGlobs: ["**/*.json"], tmp: f.tmp });
    assert.equal(r.status, "conflict");
    assert.deepEqual(r.paths.sort(), ["db/_journal.json", "reg/registry.txt"]);
    assert.equal(readFileSync(join(f.d, "other.txt"), "utf8").length > 0, true);
  });
  it("returns an error (never throws) when git fails", async () => {
    const r = await syncParked({ git: async () => { throw new Error("boom\nmore"); }, base: "main", branch: "lane" });
    assert.deepEqual(r, { status: "error", detail: "boom" });
  });
});

describe("orchestrate parked-PR sync seam (#4525)", () => {
  it("syncs a parked needs-human PR while the batch runs; comments conflicting paths once per base sha", async () => {
    const calls = [];
    let release; const gate = new Promise((r) => { release = r; });
    const decisions = [];
    const seam = async (a) => { calls.push(a); if (calls.length >= 3) release(); return a.last ? { status: "unchanged", base: a.last } : { status: "conflict", base: "b".repeat(40), paths: ["x.ts", "y.ts"] }; };
    const rows = await orchestrate({ issues: [1, 2], parallel: 2, readBody: async () => "", pollMs: 5, syncEveryMs: 10, syncParked: seam,
      runOne: async (n) => { if (n === 1) return { terminalReason: "needs-human", pr: 101, detail: "stuck" }; await gate; return { terminalReason: "merged", pr: 102 }; },
      decide: (d) => { decisions.push(d); } });
    assert.equal(rows.find((r) => r.issue === 1).outcome, "needs-human");
    assert.ok(calls.length >= 3 && calls.every((c) => c.issue === 1 && c.pr === 101));
    assert.equal(calls[0].last, null);
    assert.equal(calls[1].last, "b".repeat(40));
    const mine = decisions.filter((d) => d.issue === 1 && /conflicts with its base/.test(d.what));
    assert.equal(mine.length, 1);
    assert.match(mine[0].what, /x\.ts, y\.ts/);
  });
  it("without the seam nothing is synced and rows are unchanged", async () => {
    const decisions = [];
    const rows = await orchestrate({ issues: [1, 2], parallel: 2, readBody: async () => "", syncEveryMs: 1, decide: (d) => { decisions.push(d); },
      runOne: async (n) => (n === 1 ? { terminalReason: "needs-human", pr: 101, detail: "stuck" } : { terminalReason: "merged", pr: 102 }) });
    assert.deepEqual(rows.map((r) => r.outcome), ["needs-human", "merged"]);
    assert.equal(decisions.length, 0);
  });
});

describe("readOrchestration base_sync (#4525)", () => {
  const read = (yaml) => { const d = tmpDir("basesync-cfg-"); writeFileSync(join(d, "forge.yaml"), yaml); return readOrchestration(d).baseSync; };
  it("defaults on with no globs; parses enabled and union_globs; false opts out", () => {
    assert.deepEqual(read("project:\n  name: x\n"), { enabled: true, unionGlobs: [] });
    assert.deepEqual(read("orchestration:\n  base_sync:\n    enabled: true\n    union_globs: \"reg/*.ts, CHANGELOG.md\"\n"), { enabled: true, unionGlobs: ["reg/*.ts", "CHANGELOG.md"] });
    assert.equal(read("orchestration:\n  base_sync:\n    enabled: false\n").enabled, false);
    assert.equal(read("orchestration:\n  base_sync_enabled: false\n").enabled, false);
  });
});
