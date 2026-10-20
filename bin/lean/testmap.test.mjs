// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTestMap, readTestMap, selectCommands, mergeChecks, checkKey, factsPath, TEST_MAP_FILE, REPO_FACTS_FILE } from "./testmap.mjs";

const MAP = {
  version: 1,
  entries: [
    { globs: ["**/*.ts", "**/*.tsx"], command: "pnpm run lint", cwd: ".", source: "package.json#scripts.lint" },
    { globs: ["packages/ui/**/*.tsx"], command: "pnpm run test", cwd: "packages/ui", source: "packages/ui/package.json#scripts.test" },
    { globs: ["**/*.py"], command: "uv run pytest", cwd: ".", source: "pyproject.toml#tool.pytest" },
    { globs: ["**/*.go"], command: "golangci-lint run ./...", cwd: ".", source: ".github/workflows/ci.yml#jobs.lint" },
    { globs: ["**/*.ts"], command: "pnpm run lint", cwd: ".", source: "dup" },
    { globs: ["dir with space/**"], command: "make x", cwd: "dir with space", source: "x" },
  ],
};
const reader = (files) => async (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; };

describe("test map (#4272)", () => {
  it("parseTestMap accepts version 1 with command + globs on every entry, rejects the rest", () => {
    assert.deepEqual(parseTestMap(JSON.stringify(MAP)), MAP);
    for (const bad of ["", "nope", "null", "{}", '{"version":2,"entries":[]}', '{"version":1}',
      '{"version":1,"entries":[{"command":"x"}]}', '{"version":1,"entries":[{"command":"","globs":["**"]}]}',
      '{"version":1,"entries":[{"command":"x","globs":[]}]}', '{"version":1,"entries":[{"command":"x","globs":[3]}]}']) {
      assert.equal(parseTestMap(bad), null, bad);
    }
  });

  it("readTestMap: worktree before main checkout; missing or invalid files are skipped; never throws", async () => {
    const other = { version: 1, entries: [{ globs: ["**"], command: "make test" }] };
    assert.deepEqual(await readTestMap(["/wt", "/main"], reader({ [`/wt/${TEST_MAP_FILE}`]: JSON.stringify(MAP), [`/main/${TEST_MAP_FILE}`]: JSON.stringify(other) })), MAP);
    assert.deepEqual(await readTestMap(["/wt", "/main"], reader({ [`/main/${TEST_MAP_FILE}`]: JSON.stringify(other) })), other);
    assert.deepEqual(await readTestMap(["/wt", "/main"], reader({ [`/wt/${TEST_MAP_FILE}`]: "{broken", [`/main/${TEST_MAP_FILE}`]: JSON.stringify(other) })), other);
    assert.equal(await readTestMap(["/wt", "/main"], reader({})), null);
    assert.equal(await readTestMap(["/wt"], undefined), null);
    assert.equal(await readTestMap([null, "/wt"], reader({})), null);
  });

  it("selectCommands: matching entries in map order, deduped, non-root cwd as cd && cmd", () => {
    assert.deepEqual(selectCommands(MAP, ["src/a.ts"]), ["pnpm run lint"]);
    assert.deepEqual(selectCommands(MAP, ["packages/ui/src/b.tsx", "./svc/main.go"]), ["pnpm run lint", "cd packages/ui && pnpm run test", "golangci-lint run ./..."]);
    assert.deepEqual(selectCommands(MAP, ["a.py"]), ["uv run pytest"], "** matches a root-level file");
    assert.deepEqual(selectCommands(MAP, ["dir with space/f"]), ["cd 'dir with space' && make x"]);
    assert.deepEqual(selectCommands(MAP, ["README.md"]), []);
    assert.deepEqual(selectCommands(MAP, []), []);
    assert.deepEqual(selectCommands(null, ["a.ts"]), []);
  });

  it("factsPath: the first existing repo-facts file, else null", async () => {
    const exists = (set) => async (p) => set.includes(p);
    assert.equal(await factsPath(["/wt", "/main"], exists([`/main/${REPO_FACTS_FILE}`, `/wt/${REPO_FACTS_FILE}`])), `/wt/${REPO_FACTS_FILE}`);
    assert.equal(await factsPath(["/wt", "/main"], exists([`/main/${REPO_FACTS_FILE}`])), `/main/${REPO_FACTS_FILE}`);
    assert.equal(await factsPath(["/wt", "/main"], exists([])), null);
    assert.equal(await factsPath(["/wt"], undefined), null);
    assert.equal(await factsPath(["/wt"], async () => { throw new Error("EACCES"); }), null);
  });
});

describe("mergeChecks (#4315): the map can only add checks", () => {
  it("a partial map keeps every learned command and adds the ones it selects that learned lacks", () => {
    assert.deepEqual(mergeChecks(["npm test", "cd pkg && npm test"], ["make lint", "npm test"]),
      { commands: ["make lint", "npm test", "cd pkg && npm test"], added: 1, source: "test-map+learned" });
  });
  it("duplicates, whitespace variants included, appear once", () => {
    assert.deepEqual(mergeChecks(["npm  run   lint", " npm run lint", "npm test"], ["npm run lint ", "npm run lint"]).commands, ["npm run lint", "npm test"]);
  });
  it("an empty selection keeps the learned commands; no learned commands keep the map's selection", () => {
    assert.deepEqual(mergeChecks([], ["make lint"]), { commands: ["make lint"], added: 0, source: "learned" });
    assert.deepEqual(mergeChecks(["npm test"], []), { commands: ["npm test"], added: 1, source: "test-map" });
    assert.deepEqual(mergeChecks(undefined, undefined), { commands: [], added: 0, source: "learned" });
  });
});

describe("mergeChecks (#4318): one suite under two spellings runs once", () => {
  it("collapses <pm> run test / <pm> test, npx [--yes] X / X and cd . && X / X, keeping the first spelling", () => {
    assert.deepEqual(mergeChecks(["pnpm test", "vitest", "make lint"], ["pnpm run test", "npx --yes vitest", "cd . && make lint"]),
      { commands: ["pnpm run test", "npx --yes vitest", "cd . && make lint"], added: 0, source: "learned" });
    assert.deepEqual(mergeChecks(["cd pkg && npx vitest run", "cd other && vitest run"], ["cd pkg && vitest run"]).commands, ["cd pkg && vitest run", "cd other && vitest run"]);
  });
  it("checkKey keeps different suites apart", () => {
    assert.notEqual(checkKey("npm run test:unit"), checkKey("npm test"));
    assert.notEqual(checkKey("cd a && npm test"), checkKey("npm test"));
    assert.equal(checkKey("bunx -y  jest"), "jest");
  });
});
