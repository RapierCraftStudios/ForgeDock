// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { exportNames, enumeratingTests, missingEntries, unjustified } from "./enumerating.mjs";
import { enumeratingPlanNote, enumeratingBuildRule, missingEntriesPrompt, builderPlanPrompt } from "./prompts.mjs";

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const gitIn = (cwd) => async (a) => sh(cwd, ...a);
const put = (root, files) => { for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); } };
function repo(files) {
  const d = tmpDir("enum-");
  sh(d, "init", "-q", "-b", "main");
  put(d, files);
  sh(d, "add", "-A"); sh(d, "commit", "-qm", "base");
  return d;
}

const CORE = "export async function getUser() {}\nexport const listUsers = () => [];\nexport function deleteUser() {}\nexport { helperA as renamedHelper, type Foo } from './x';\n";
const FILES = {
  "packages/core/package.json": JSON.stringify({ name: "@acme/core" }),
  "packages/core/src/index.ts": CORE,
  "packages/core/test/registry.test.ts": "import * as core from '../src/index';\nconst SERVICE_TESTS = { getUser: 1, listUsers: 1 };\nconst NOT_A_SERVICE = ['deleteUser', 'renamedHelper'];\nexpect(Object.keys(core).filter((k) => !(k in SERVICE_TESTS) && !NOT_A_SERVICE.includes(k))).toEqual([]);\n",
  "packages/web/test/pkg.test.ts": "import * as c from '@acme/core';\nit('all', () => expect(Object.keys(c).length).toBe(4));\n",
  "packages/core/test/unrelated.test.ts": "import { getUser } from '../src/index';\nit('x', () => getUser());\n",
  "locales/en/common.json": "{}", "locales/en/auth.json": "{}", "locales/en/billing.json": "{}",
  "tests/catalog.test.ts": "const NAMESPACES = ['common', 'auth', 'billing'];\n",
};

describe("enumerating tests (#4322)", () => {
  it("reads JS/TS and Python exports", () => {
    assert.deepEqual(exportNames(CORE, "a.ts").sort(), ["deleteUser", "getUser", "listUsers", "renamedHelper"]);
    assert.deepEqual(exportNames("__all__ = ['a', \"bb\"]\ndef c(): pass", "m.py"), ["a", "bb"]);
    assert.deepEqual(exportNames("def run():\n  pass\nclass Job: pass\ndef _private(): pass", "m.py"), ["run", "Job"]);
  });

  it("plan: lists every test enumerating the exports of a module the issue names (literal list, Object.keys of a relative or package import)", async () => {
    const d = repo(FILES);
    const list = await enumeratingTests({ git: gitIn(d), cwd: d, paths: ["packages/core/src/index.ts"] });
    const tests = list.filter((e) => e.module === "packages/core/src/index.ts").map((e) => e.test).sort();
    assert.deepEqual(tests, ["packages/core/test/registry.test.ts", "packages/web/test/pkg.test.ts"]);
    assert.ok(!list.some((e) => e.test.endsWith("unrelated.test.ts")), "a test importing one export does not enumerate them");
    assert.match(list.find((e) => e.test.endsWith("registry.test.ts")).why, /literal list of [34] sibling export names/);
    assert.match(list.find((e) => e.test.endsWith("pkg.test.ts")).why, /^Object\.keys\(c\)$/);
    const files = await enumeratingTests({ git: gitIn(d), cwd: d, paths: ["locales/en"] });
    assert.deepEqual(files.map((e) => [e.module, e.test, e.line]), [["locales/en", "tests/catalog.test.ts", 1]]);
  });

  it("plan note and build rule cite the list; no enumerating tests means no new plan step (prompt unchanged)", async () => {
    const d = repo(FILES);
    assert.deepEqual(await enumeratingTests({ git: gitIn(d), cwd: d, paths: ["README.md", "packages/core/package.json"] }), []);
    assert.equal(enumeratingPlanNote([]), ""); assert.equal(enumeratingPlanNote(null), "");
    assert.equal(enumeratingBuildRule([]), "");
    const list = [{ module: "packages/core/src/index.ts", test: "packages/core/test/registry.test.ts", line: 2, why: "literal list of 4 sibling export names" }];
    assert.match(enumeratingPlanNote(list), /Enumerating tests[\s\S]*Affected Files[\s\S]*validate command[\s\S]*- packages\/core\/src\/index\.ts -> packages\/core\/test\/registry\.test\.ts:2/);
    const rule = enumeratingBuildRule(list);
    assert.match(rule, /one test-list edit per new symbol/);
    assert.match(rule, /"not_members"/);
    assert.match(rule, /registry\.test\.ts:2/);
    assert.ok(!builderPlanPrompt(7).includes("Enumerating tests"));
  });

  it("after implement: a new export missing from an enumerating test is reported; a listed one or a justified not-member is not", async () => {
    const d = repo(FILES);
    sh(d, "checkout", "-qb", "lane");
    put(d, { "packages/core/src/index.ts": `${CORE}export function getProfile() {}\nexport function updateProfile() {}\n` });
    put(d, { "packages/core/test/registry.test.ts": FILES["packages/core/test/registry.test.ts"].replace("listUsers: 1", "listUsers: 1, updateProfile: 1") });
    put(d, { "locales/en/profile.json": "{}" });
    sh(d, "add", "-A"); sh(d, "commit", "-qm", "lane");
    const miss = await missingEntries({ git: gitIn(d), cwd: d, base: "main" });
    const keys = miss.map((m) => `${m.symbol} -> ${m.test}`).sort();
    assert.deepEqual(keys, [
      "getProfile -> packages/core/test/registry.test.ts",
      "getProfile -> packages/web/test/pkg.test.ts",
      "profile -> tests/catalog.test.ts",
      "updateProfile -> packages/web/test/pkg.test.ts",
    ]);
    const left = unjustified(miss, [{ symbol: "getProfile", test: "packages/web/test/pkg.test.ts", why: "count test, not a list" }, { symbol: "profile", test: "tests/catalog.test.ts", why: "" }]);
    assert.equal(left.length, 3, "a not-member needs a non-empty why");
    assert.match(missingEntriesPrompt(miss), /getProfile \(packages\/core\/src\/index\.ts\) -> packages\/core\/test\/registry\.test\.ts:\d+[\s\S]*not_members/);
  });

  it("a lane that adds no enumerable symbol gets nothing; a broken git never throws", async () => {
    const d = repo(FILES);
    sh(d, "checkout", "-qb", "lane");
    put(d, { "packages/core/src/index.ts": `${CORE}// comment only\n` });
    sh(d, "add", "-A"); sh(d, "commit", "-qm", "lane");
    assert.deepEqual(await missingEntries({ git: gitIn(d), cwd: d, base: "main" }), []);
    const bad = async () => { throw new Error("boom"); };
    assert.deepEqual(await missingEntries({ git: bad, cwd: d, base: "main" }), []);
    assert.deepEqual(await enumeratingTests({ git: bad, cwd: d, paths: ["x"] }), []);
  });
});
