// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Public-API-shape detector (forge#4449): bin/lean/apishape.mjs against throwaway git repos built from
// scripts/fixtures/apishape/<lang>/<case>/{base,head}/ and the real symbol indexers.
// The JS/TS cases need the `typescript` (or `ts-morph`) package: APISHAPE_TS_NODE_MODULES=<node_modules holding it> is
// symlinked into each repo; without it they skip, and APISHAPE_REQUIRE_TS=1 turns the skip into a failure (CI).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../tests/_tmp.mjs";
import { classifyPath, compareIndexes, detectApiShape, parseNameStatus } from "./apishape.mjs";

const FIX = fileURLToPath(new URL("../../scripts/fixtures/apishape/", import.meta.url));
const CLI = fileURLToPath(new URL("./apishape.mjs", import.meta.url));
const TS_MODULES = process.env.APISHAPE_TS_NODE_MODULES || "";
const HAS_TS = !!TS_MODULES && (existsSync(join(TS_MODULES, "typescript")) || existsSync(join(TS_MODULES, "ts-morph")));
const tsSkip = HAS_TS ? false : "TS-parser cases skipped (set APISHAPE_TS_NODE_MODULES)";
if (!HAS_TS && process.env.APISHAPE_REQUIRE_TS === "1") {
  throw new Error("APISHAPE_REQUIRE_TS=1 but APISHAPE_TS_NODE_MODULES holds neither typescript nor ts-morph");
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function clearTracked(dir) {
  for (const ent of readdirSync(dir)) if (ent !== ".git" && ent !== "node_modules") rmSync(join(dir, ent), { recursive: true, force: true });
}

/** A repo with commit `base` (fixture base/) and commit `head` (fixture head/), or explicit file maps. */
function repo({ fixture, base, head, ts = false }) {
  const dir = tmpDir("apishape-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  if (ts) symlinkSync(TS_MODULES, join(dir, "node_modules"));
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  const put = (side, files) => {
    clearTracked(dir);
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    if (fixture) cpSync(join(FIX, fixture, side), dir, { recursive: true });
    for (const [p, body] of Object.entries(files ?? {})) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), body); }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--allow-empty", "-m", side);
    git(dir, "tag", side);
  };
  put("base", base);
  put("head", head);
  return dir;
}

const detect = (cwd) => detectApiShape({ cwd, base: "base", head: "head" });
const brief = (r) => r.changes.map((c) => `${c.change}:${c.symbol}:${c.before}>${c.after}`);

describe("apishape: Python fixtures", () => {
  it("signature: a new keyword-only parameter", async () => {
    const r = await detect(repo({ fixture: "python/signature" }));
    assert.equal(r.status, "changed");
    assert.deepEqual(brief(r), ["signature:area:(width, height)>(width, height, *, scale=)"]);
    assert.equal(r.changes[0].file, "shapes.py");
  });

  it("sync-async: a top-level function and a method", async () => {
    const r = await detect(repo({ fixture: "python/sync-async" }));
    assert.deepEqual(brief(r), ["sync-async:Client.get:sync>async", "sync-async:fetch:sync>async"]);
  });

  it("generator-function: a generator def becomes a list-returning def", async () => {
    const r = await detect(repo({ fixture: "python/generator-function" }));
    assert.deepEqual(brief(r), ["generator-function:pairs:generator>function"]);
  });

  it("removed public symbol", async () => {
    const r = await detect(repo({ fixture: "python/removed" }));
    assert.deepEqual(brief(r), ["removed:sub:sub>null"]);
  });

  it("renamed public symbol (same kind and shape)", async () => {
    const r = await detect(repo({ fixture: "python/renamed" }));
    assert.deepEqual(brief(r), ["renamed:slugify:slugify>to_slug"]);
  });

  it("private/internal edit reports nothing", async () => {
    const r = await detect(repo({ fixture: "python/private-edit" }));
    assert.deepEqual(r, { status: "none", changes: [], unknown: [] });
  });

  it("regression #4442: more-itertools ichunked generator → plain function is flagged", async () => {
    const r = await detect(repo({ fixture: "python/ichunked" }));
    assert.equal(r.status, "changed");
    assert.deepEqual(brief(r), ["generator-function:ichunked:generator>function"]);
  });
});

describe("apishape: JS/TS fixtures", () => {
  const ts = (fixture) => detect(repo({ fixture, ts: true }));
  it("signature: a new defaulted parameter (.ts)", { skip: tsSkip }, async () => {
    const r = await ts("ts/signature");
    assert.deepEqual(brief(r), ["signature:area:(width: number, height: number) -> number>(width: number, height: number, scale=) -> number"]);
  });

  it("sync-async: a function and an arrow const (.mjs)", { skip: tsSkip }, async () => {
    const r = await ts("ts/sync-async");
    assert.deepEqual(brief(r), ["sync-async:fetchUrl:sync>async", "sync-async:load:sync>async"]);
  });

  it("generator-function: function* becomes a plain function (.js)", { skip: tsSkip }, async () => {
    const r = await ts("ts/generator-function");
    assert.deepEqual(brief(r), ["generator-function:pairs:generator>function"]);
  });

  it("removed exported symbol", { skip: tsSkip }, async () => {
    const r = await ts("ts/removed");
    assert.deepEqual(brief(r), ["removed:sub:sub>null"]);
  });

  it("renamed exported symbol", { skip: tsSkip }, async () => {
    const r = await ts("ts/renamed");
    assert.deepEqual(brief(r), ["renamed:slugify:slugify>toSlug"]);
  });

  it("non-exported edit reports nothing", { skip: tsSkip }, async () => {
    const r = await ts("ts/private-edit");
    assert.deepEqual(r, { status: "none", changes: [], unknown: [] });
  });
});

describe("apishape: scope and unknown", () => {
  it("a language without an indexer reports unknown", async () => {
    const r = await detect(repo({ fixture: "other/go-change" }));
    assert.equal(r.status, "unknown");
    assert.deepEqual(r.unknown, [{ file: "x.go", lang: "go", reason: "unsupported-language" }]);
  });

  it("docs-only change, an added public file and a test-file signature change report nothing", async () => {
    const r = await detect(repo({
      base: { "README.md": "a\n", "tests/test_x.py": "def test_a(x):\n    pass\n" },
      head: { "README.md": "b\n", "tests/test_x.py": "def test_a(x, y):\n    pass\n", "new.py": "def f():\n    pass\n" },
    }));
    assert.deepEqual(r, { status: "none", changes: [], unknown: [] });
  });

  it("a deleted file reports each public symbol as removed; a renamed file compares old vs new path", async () => {
    const r = await detect(repo({
      base: { "a.py": "def keep(x):\n    pass\n\n\ndef _p():\n    pass\n", "b.py": "def gone():\n    pass\n" },
      head: { "pkg/a.py": "def keep(x):\n    pass\n\n\ndef _p():\n    pass\n" },
    }));
    assert.deepEqual(r.changes.map((c) => `${c.file}:${c.change}:${c.symbol}`), ["b.py:removed:gone"]);
  });

  it("a head that does not parse reports unknown, public→private counts as removed", async () => {
    const r = await detect(repo({ base: { "a.py": "def f():\n    pass\n" }, head: { "a.py": "def f(:\n" } }));
    assert.equal(r.status, "unknown");
    assert.match(r.unknown[0].reason, /^parse-error/);
    const p = compareIndexes("a.py", { symbols: [{ name: "f", kind: "function", public: true, sig: "()" }] },
      { symbols: [{ name: "f", kind: "function", public: false, sig: "()" }] });
    assert.deepEqual(p.map((c) => c.change), ["removed"]);
  });

  it("classifyPath and parseNameStatus", () => {
    assert.equal(classifyPath("src/a.py"), "python");
    assert.equal(classifyPath("src/a.tsx"), "ts");
    assert.equal(classifyPath("src/a.cjs"), "js");
    assert.deepEqual(classifyPath("cmd/main.rs"), { unknown: "rust" });
    for (const p of ["README.md", "x.json", "src/a.test.ts", "__tests__/b.js", "pkg/test_a.py", "a_test.py", "conftest.py", "types.d.ts"]) {
      assert.equal(classifyPath(p), null, p);
    }
    assert.deepEqual(parseNameStatus("M\0a.py\0R100\0b.py\0c.py\0A\0d.py\0D\0e.py\0"), [
      { status: "M", before: "a.py", after: "a.py" },
      { status: "R", before: "b.py", after: "c.py" },
      { status: "A", before: null, after: "d.py" },
      { status: "D", before: "e.py", after: null },
    ]);
  });

  it("CLI: exit 2 on a bad ref, JSON status none on an empty diff", () => {
    const dir = repo({ base: { "a.py": "def f():\n    pass\n" }, head: { "a.py": "def f():\n    pass\n" } });
    const bad = spawnSync(process.execPath, [CLI, "nope...head"], { cwd: dir, encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /bad ref: nope/);
    assert.equal(spawnSync(process.execPath, [CLI], { cwd: dir }).status, 2);
    const ok = spawnSync(process.execPath, [CLI, "base", "head"], { cwd: dir, encoding: "utf8" });
    assert.equal(ok.status, 0);
    assert.deepEqual(JSON.parse(ok.stdout), { status: "none", changes: [], unknown: [] });
  });
});
