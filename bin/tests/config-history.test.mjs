import { tmpDir } from "./_tmp.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordVersion, listVersions, readVersion, diffVersion, rollback, importBak, backupToHistory, runConfigCommand, historyRepoKey } from "../config-history.mjs";
import { backupForgeYaml } from "../journey.mjs";

const setup = () => { const d = tmpDir("fd-cfghist-"); const root = join(d, "hist"); const repo = join(d, "repo"); return { root, repo, file: join(repo, "forge.yaml"), d }; };

describe("config history (#5315)", () => {
  it("records versions with reasons, skipping an unchanged text", () => {
    const { root } = setup();
    assert.equal(recordVersion({ root, repo: "o__r", text: "a: 1\n", reason: "init" }).n, 1);
    assert.equal(recordVersion({ root, repo: "o__r", text: "a: 2\n", reason: "tune" }).n, 2);
    assert.equal(recordVersion({ root, repo: "o__r", text: "a: 2\n", reason: "again" }).recorded, false);
    assert.deepEqual(listVersions({ root, repo: "o__r" }).map((v) => v.reason), ["init", "tune"]);
    assert.equal(readVersion({ root, repo: "o__r", n: 1 }), "a: 1\n");
    assert.equal(readVersion({ root, repo: "o__r", n: 9 }), null);
  });
  it("diffs a version against the current file", () => {
    const { root, repo, file } = setup();
    mkdirp(repo); writeFileSync(file, "a: 2\nb: 1\n");
    recordVersion({ root, repo: "k", text: "a: 1\nb: 1\n", reason: "x" });
    assert.equal(diffVersion({ root, repo: "k", n: 1, file }), "- a: 1\n+ a: 2");
  });
  it("rollback restores a version and records the current content first (undoable)", () => {
    const { root, repo, file } = setup();
    mkdirp(repo); writeFileSync(file, "a: 1\n");
    recordVersion({ root, repo: "k", text: "a: 1\n", reason: "v1" });
    writeFileSync(file, "a: 2\n");
    const r = rollback({ root, repo: "k", n: 1, file });
    assert.deepEqual([r.ok, r.saved], [true, 2]);
    assert.equal(readFileSync(file, "utf8"), "a: 1\n");
    assert.equal(readVersion({ root, repo: "k", n: 2 }), "a: 2\n");
    assert.equal(rollback({ root, repo: "k", n: 7, file }).ok, false);
  });
  it("imports forge.yaml.bak-* files once, deleting them on request", () => {
    const { root, repo } = setup();
    mkdirp(repo);
    writeFileSync(join(repo, "forge.yaml.bak-2026-10-21-extra"), "a: 1\n");
    writeFileSync(join(repo, "forge.yaml.bak"), "a: 2\n");
    writeFileSync(join(repo, "forge.yaml"), "a: 3\n");
    const r1 = importBak({ root, repo: "k", dir: repo });
    assert.equal(r1.imported.length, 2);
    assert.equal(importBak({ root, repo: "k", dir: repo }).imported.length, 0, "idempotent");
    assert.equal(listVersions({ root, repo: "k" }).length, 2);
    assert.deepEqual(importBak({ root, repo: "k", dir: repo, del: true }).deleted.length, 2);
    assert.deepEqual(readdirSync(repo), ["forge.yaml"]);
  });
  it("a setup edit records a version and leaves no .bak in the repo", () => {
    const { root, repo, file } = setup();
    mkdirp(repo);
    writeFileSync(file, 'project:\n  owner: "o"\n  repo: "r"\n');
    const saved = process.env.FORGE_CONFIG_HISTORY_DIR;
    process.env.FORGE_CONFIG_HISTORY_DIR = root;
    try {
      const b = backupForgeYaml(file, "setup");
      assert.match(b.backupName, /o__r v1/);
    } finally { if (saved === undefined) delete process.env.FORGE_CONFIG_HISTORY_DIR; else process.env.FORGE_CONFIG_HISTORY_DIR = saved; }
    assert.deepEqual(readdirSync(repo), []);
    assert.equal(listVersions({ root, repo: "o__r" })[0].reason, "setup");
    assert.equal(backupToHistory(join(repo, "none.yaml"), "x"), null);
  });
  it("CLI: history lists reasons, rollback restores", () => {
    const { root, repo, file } = setup();
    mkdirp(repo); writeFileSync(file, "a: 1\n");
    const env = { FORGE_CONFIG_HISTORY_DIR: root };
    const lines = []; const out = (s) => lines.push(s);
    assert.equal(runConfigCommand("record", ["first", "cut"], { cwd: repo, env, out }), 0);
    writeFileSync(file, "a: 2\n");
    assert.equal(runConfigCommand("history", [], { cwd: repo, env, out }), 0);
    assert.match(lines.join("\n"), /v1 .*first cut/);
    assert.equal(runConfigCommand("rollback", ["1"], { cwd: repo, env, out }), 0);
    assert.equal(readFileSync(file, "utf8"), "a: 1\n");
    assert.equal(runConfigCommand("rollback", [], { cwd: repo, env, out }), 1);
    assert.equal(historyRepoKey(repo, ""), "repo");
  });
});
import { mkdirSync } from "node:fs";
function mkdirp(p) { mkdirSync(p, { recursive: true }); }
