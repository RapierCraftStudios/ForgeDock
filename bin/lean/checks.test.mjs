// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** #4218: change-scoped typecheck/lint/test commands and the shared tsc/eslint cache (fixture repos, no tool runs). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { discoverChecks, scopedChecks, cacheEntry, hydrate, publish, withCacheFlags, LOCAL_CACHE } from "./checks.mjs";

const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "checks-4218-"));
process.env.FORGE_CI_LOCAL_HOME = path.join(TMP, "forge-home");
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (repo, ...a) => execFileSync("git", ["-C", repo, ...a], { env: GIT_ENV, encoding: "utf8" });
let n = 0;

/** A throwaway repo: `files` committed on main, then branch feat checked out; node_modules/ is ignored. */
function repo(files) {
  const r = path.join(TMP, `repo${n++}`);
  write(r, { ".gitignore": "node_modules/\n", ...files });
  git(r, "init", "-q", "-b", "main");
  git(r, "add", "-A");
  git(r, "commit", "-qm", "base");
  git(r, "checkout", "-qb", "feat");
  fs.mkdirSync(path.join(r, "node_modules"), { recursive: true });
  return r;
}
function write(r, files) {
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true });
    fs.writeFileSync(path.join(r, f), body);
  }
}
const touch = (r, ...fs_) => { for (const f of fs_) fs.appendFileSync(path.join(r, f), "\n// change\n"); };
const byKind = (checks) => Object.fromEntries(checks.map((c) => [c.kind, c]));

const pnpmMonorepo = () => repo({
  "package.json": JSON.stringify({ name: "root", private: true, scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run" } }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "apps/web" }, { path: "packages/ui" }] }),
  "apps/web/package.json": JSON.stringify({ name: "web" }),
  "apps/web/tsconfig.json": "{\n  // web app\n  \"compilerOptions\": { \"jsx\": \"preserve\", },\n  \"references\": [{ \"path\": \"../../packages/ui\" }]\n}\n",
  "apps/web/src/page.tsx": "import { Button } from \"../../../packages/ui/src/button\";\nexport const Page = () => Button;\n",
  "apps/web/src/page.test.tsx": "import { Page } from \"./page\";\ntest(\"page\", () => Page);\n",
  "packages/ui/package.json": JSON.stringify({ name: "ui" }),
  "packages/ui/tsconfig.json": JSON.stringify({ compilerOptions: { composite: true } }),
  "packages/ui/src/button.tsx": "export const Button = 1;\n",
  "packages/ui/src/button.test.tsx": "import { Button } from \"./button\";\ntest(\"button\", () => Button);\n",
  ".github/workflows/ci.yml": "on: pull_request\n",
});

test("JS/TS pnpm monorepo: one web file scopes typecheck to its project, lint to the file, tests to related", () => {
  const r = pnpmMonorepo();
  assert.deepEqual(discoverChecks(r).map((c) => `${c.kind}:${c.command}:${c.cwd}`), ["typecheck:pnpm run typecheck:.", "lint:pnpm run lint:.", "test:pnpm run test:."]);
  touch(r, "apps/web/src/page.tsx");
  const c = byKind(scopedChecks({ repo: r, base: "main" }));
  assert.equal(c.typecheck.mode, "scoped");
  assert.equal(c.typecheck.selector, "tsc-project");
  assert.match(c.typecheck.command, /^pnpm exec tsc --incremental --tsBuildInfoFile node_modules\/\.cache\/forge-verify\/tsc-[0-9a-f]{12}\.tsbuildinfo -p apps\/web --noEmit$/);
  assert.equal(c.lint.mode, "scoped");
  assert.equal(c.lint.command, "pnpm exec eslint --cache --cache-strategy content --cache-location node_modules/.cache/forge-verify/eslintcache apps/web/src/page.tsx");
  assert.equal(c.test.mode, "scoped");
  assert.match(c.test.command, /vitest related --run --passWithNoTests apps\/web\/src\/page\.tsx$/);
});

test("JS/TS pnpm monorepo: a shared package change builds every reached composite/referenced project with tsc -b", () => {
  const r = pnpmMonorepo();
  touch(r, "packages/ui/src/button.tsx");
  const c = byKind(scopedChecks({ repo: r, base: "main" }));
  assert.equal(c.typecheck.mode, "scoped");
  assert.equal(c.typecheck.command, "pnpm exec tsc -b apps/web packages/ui");
});

test("npm single-package TS repo: the root project runs the full typecheck", () => {
  const r = repo({
    "package.json": JSON.stringify({ name: "one", scripts: { typecheck: "tsc --noEmit" } }),
    "package-lock.json": "{}\n",
    "tsconfig.json": "{}\n",
    "src/a.ts": "export const a = 1;\n",
    "src/a.test.ts": "import { a } from './a';\n",
  });
  touch(r, "src/a.ts");
  const [c] = scopedChecks({ repo: r, base: "main" });
  assert.equal(c.command.startsWith("npx tsc --incremental"), true);
  assert.equal(c.mode, "full");
  assert.equal(c.widen_reason, "root-project");
});

// Regression (#4218 AC2): unknown impact never narrows.
for (const [file, reason] of [["pnpm-lock.yaml", "lockfile"], ["apps/web/tsconfig.json", "build-config"], [".github/workflows/ci.yml", "ci-config"]]) {
  test(`unknown impact (${file}) runs every check in full`, () => {
    const r = pnpmMonorepo();
    fs.appendFileSync(path.join(r, file), "\n");
    touch(r, "apps/web/src/page.tsx");
    const checks = scopedChecks({ repo: r, base: "main" });
    assert.equal(checks.length, 3);
    for (const c of checks) {
      assert.equal(c.mode, "full", `${c.kind} ${c.command}`);
      assert.match(c.widen_reason, new RegExp(`^${reason}: ${file.replace(/\./g, "\\.")}$`));
    }
  });
}

const pyRepo = (lock, lockBody) => repo({
  "pyproject.toml": "[project]\nname = \"pkg\"\n\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n\n[tool.ruff]\nline-length = 100\n",
  [lock]: lockBody,
  "pkg/__init__.py": "",
  "pkg/alpha.py": "def f():\n    return 1\n",
  "pkg/beta.py": "def g():\n    return 2\n",
  "tests/test_alpha.py": "from pkg.alpha import f\n\ndef test_f():\n    assert f() == 1\n",
  "tests/test_beta.py": "from pkg.beta import g\n\ndef test_g():\n    assert g() == 2\n",
});

test("Python uv repo: one module scopes pytest to its tests and ruff to the file; uv.lock widens", () => {
  const r = pyRepo("uv.lock", "version = 1\n");
  assert.deepEqual(discoverChecks(r).map((c) => c.command), ["uv run ruff check .", "uv run pytest"]);
  fs.appendFileSync(path.join(r, "pkg/alpha.py"), "# change\n");
  const c = byKind(scopedChecks({ repo: r, base: "main" }));
  assert.equal(c.test.mode, "scoped");
  assert.equal(c.test.command, "uv run pytest tests/test_alpha.py");
  assert.equal(c.lint.command, "uv run ruff check pkg/alpha.py");
  fs.appendFileSync(path.join(r, "uv.lock"), "# change\n");
  for (const x of scopedChecks({ repo: r, base: "main" })) { assert.equal(x.mode, "full"); assert.equal(x.widen_reason, "lockfile: uv.lock"); }
});

test("Python poetry repo: poetry run prefix; poetry.lock widens", () => {
  const r = pyRepo("poetry.lock", "# lock\n");
  fs.appendFileSync(path.join(r, "pkg/beta.py"), "# change\n");
  const c = byKind(scopedChecks({ repo: r, base: "main" }));
  assert.equal(c.test.command, "poetry run pytest tests/test_beta.py");
  fs.appendFileSync(path.join(r, "poetry.lock"), "# change\n");
  const t = byKind(scopedChecks({ repo: r, base: "main" })).test;
  assert.equal(t.mode, "full");
  assert.equal(t.command, "poetry run pytest");
  assert.equal(t.widen_reason, "lockfile: poetry.lock");
});

test("shared cache: keyed by base commit, hydrated by copy, published once and never modified", () => {
  const a = pnpmMonorepo();
  const base = git(a, "rev-parse", "main").trim();
  const entry = cacheEntry(a, base);
  assert.ok(entry.startsWith(path.join(process.env.FORGE_CI_LOCAL_HOME, "verify-cache")));
  assert.ok(entry.endsWith(base));
  assert.deepEqual(publish(a, entry), { published: false, reason: "no local cache" });
  write(a, { [`${LOCAL_CACHE}/eslintcache`]: "v1", [`${LOCAL_CACHE}/tsc-x.tsbuildinfo`]: "b1" });
  assert.equal(publish(a, entry).published, true);
  assert.equal(fs.readFileSync(path.join(entry, "eslintcache"), "utf8"), "v1");
  // A second lane's different caches never overwrite the entry (first writer wins).
  write(a, { [`${LOCAL_CACHE}/eslintcache`]: "v2" });
  assert.deepEqual(publish(a, entry), { published: false, reason: "entry exists" });
  assert.equal(fs.readFileSync(path.join(entry, "eslintcache"), "utf8"), "v1");
  // Another worktree of the same repo shares the entry; hydrate copies, and a later local write leaves the entry alone.
  const wt = path.join(TMP, `wt${n++}`);
  git(a, "worktree", "add", "-q", wt, "main");
  assert.equal(cacheEntry(wt, base), entry);
  fs.mkdirSync(path.join(wt, "node_modules"));
  assert.deepEqual(hydrate(wt, entry).hydrated.sort(), ["eslintcache", "tsc-x.tsbuildinfo"]);
  fs.writeFileSync(path.join(wt, LOCAL_CACHE, "eslintcache"), "lane-write");
  assert.equal(fs.readFileSync(path.join(entry, "eslintcache"), "utf8"), "v1");
  assert.deepEqual(hydrate(wt, entry).hydrated, [], "files the lane already has are kept");
  assert.equal(fs.readFileSync(path.join(wt, LOCAL_CACHE, "eslintcache"), "utf8"), "lane-write");
});

test("withCacheFlags: tsc -p and eslint get cache flags relative to cwd; tsc -b and no node_modules are untouched", () => {
  const r = pnpmMonorepo();
  assert.match(withCacheFlags({ command: "tsc --noEmit", cwd: "apps/web" }, r).command, /^tsc --incremental --tsBuildInfoFile \.\.\/\.\.\/node_modules\/\.cache\/forge-verify\/tsc-[0-9a-f]{12}\.tsbuildinfo --noEmit$/);
  assert.equal(withCacheFlags({ command: "tsc -b apps/web", cwd: "." }, r).command, "tsc -b apps/web");
  assert.equal(withCacheFlags({ command: "eslint --cache-location x a.ts", cwd: "." }, r).command, "eslint --cache-location x a.ts");
  fs.rmSync(path.join(r, "node_modules"), { recursive: true });
  assert.equal(withCacheFlags({ command: "eslint a.ts", cwd: "." }, r).command, "eslint a.ts");
});

test("discovery: declared workspace packages' scripts win over the root; undeclared package.json files are ignored", () => {
  const r = repo({
    "package.json": JSON.stringify({ name: "root", private: true, scripts: { test: "node --test" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
    "apps/web/package.json": JSON.stringify({ name: "web", scripts: { typecheck: "tsc --noEmit" } }),
    "scripts/fixtures/demo/package.json": JSON.stringify({ name: "demo", scripts: { test: "jest", lint: "eslint ." } }),
  });
  assert.deepEqual(discoverChecks(r).map((c) => `${c.kind}:${c.command}:${c.cwd}`), ["typecheck:pnpm run typecheck:apps/web", "test:pnpm run test:."]);
});
