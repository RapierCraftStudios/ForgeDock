// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { isWeakGuardTest } from "./weakguard.mjs";

const HEAD = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nconst src = readFileSync("bin/lean/prompts.mjs", "utf8");\n`;

test("weak: literal-presence assertions over file text (includes, regex match, toContain)", () => {
  assert.equal(isWeakGuardTest(`${HEAD}test("rule", () => { assert.ok(src.includes("negative examples")); assert.ok(!src.includes("old rule")); });\n`, "a.test.mjs"), true);
  assert.equal(isWeakGuardTest(`${HEAD}test("rule", () => { assert.match(src, /supersedes/); assert.doesNotMatch(src, /legacy/); });\n`, "a.test.mjs"), true);
  assert.equal(isWeakGuardTest(`${HEAD}test("rule", () => assert(/guard_weak/.test(src)));\n`, "a.test.mjs"), true);
  assert.equal(isWeakGuardTest(`import { readFileSync } from "node:fs";\nimport { tmpDir } from "../tests/_tmp.mjs";\nconst s = readFileSync("x.ts", "utf8");\nit("has it", () => { expect(s).toContain("LIT"); expect(s).not.toMatch(/OLD/); });\n`, "x.test.ts"), true);
});

test("strong: a test that calls an imported local function is behavioural", () => {
  assert.equal(isWeakGuardTest(`${HEAD}import { price } from "./a.mjs";\ntest("p", () => { assert.match(String(price()), /2/); assert.ok(src.includes("price")); });\n`, "a.test.mjs"), false);
  assert.equal(isWeakGuardTest(`const { price } = require("../src/a");\nconst fs = require("fs");\nconst s = fs.readFileSync("a.js", "utf8");\nassert.match(s, /x/);\n`, "a.test.js"), false);
});

test("strong: a mixed file (one literal check plus an equality on a computed value)", () => {
  assert.equal(isWeakGuardTest(`${HEAD}test("m", () => { assert.match(src, /x/); assert.equal(src.split("\\n").length > 3, true); });\n`, "a.test.mjs"), false);
  assert.equal(isWeakGuardTest(`${HEAD}test("m", () => { expect(src).toContain("x"); expect(src.length).toBe(12); });\n`, "a.test.mjs"), false);
});

test("negative examples: inputs the classifier must not call weak", () => {
  // no file read: a pure computation
  assert.equal(isWeakGuardTest(`import assert from "node:assert/strict";\nassert.match("abc", /b/);\n`, "a.test.mjs"), false);
  // runs a program and matches its output: behavioural (inputs -> outputs), even with only match assertions
  assert.equal(isWeakGuardTest(`${HEAD}import { spawnSync } from "node:child_process";\nconst r = spawnSync("node", ["cli.mjs"], { encoding: "utf8" });\nassert.match(r.stdout, /ok/);\nassert.ok(src.includes("x"));\n`, "a.test.mjs"), false);
  // reads a file but asserts nothing
  assert.equal(isWeakGuardTest(HEAD, "a.test.mjs"), false);
  // a commented-out import or assertion does not change the verdict; a real deepEqual makes it strong
  assert.equal(isWeakGuardTest(`${HEAD}// import { x } from "./a.mjs";\n// assert.equal(1, 1);\nassert.match(src, /y/);\n`, "a.test.mjs"), true);
  assert.equal(isWeakGuardTest(`${HEAD}assert.deepEqual(JSON.parse(src), { a: 1 });\n`, "a.test.mjs"), false);
  // includes() equality is an equality assertion, not the literal-presence form
  assert.equal(isWeakGuardTest(`${HEAD}assert.equal(src.includes("x"), true);\n`, "a.test.mjs"), false);
  // empty or missing source
  assert.equal(isWeakGuardTest("", "a.test.mjs"), false);
  assert.equal(isWeakGuardTest(undefined), false);
});

test("python: literal-in-text and re.search over read_text are weak; calling project code is strong", () => {
  const PY = `import re\nfrom pathlib import Path\nsrc = Path("app/x.py").read_text()\n`;
  assert.equal(isWeakGuardTest(`${PY}def test_lit():\n    assert "FLAG" in src\n    assert "OLD" not in src, "gone"\n    assert re.search(r"def handler", src)\n`, "tests/test_x.py"), true);
  assert.equal(isWeakGuardTest(`import unittest\nclass T(unittest.TestCase):\n    def test(self):\n        s = open("a.py").read()\n        self.assertIn("X", s)\n`, "tests/test_y.py"), true);
  assert.equal(isWeakGuardTest(`${PY}from app.x import handler\ndef test_h():\n    assert handler(1) == 2\n`, "tests/test_x.py"), false);
  assert.equal(isWeakGuardTest(`${PY}def test_len():\n    assert len(src) > 10\n`, "tests/test_x.py"), false);
  assert.equal(isWeakGuardTest(`${PY}import subprocess\ndef test_cli():\n    out = subprocess.run(["x"], capture_output=True, text=True).stdout\n    assert "ok" in out\n`, "tests/test_x.py"), false);
  assert.equal(isWeakGuardTest(`def test_no_read():\n    assert "a" in "abc"\n`, "tests/test_z.py"), false);
});

test("regex-literal presence check stays linear on many backslash escapes (CodeQL js/redos)", () => {
  const evil = `assert.ok(/${"\\a".repeat(5000)}\n)`; // an unterminated regex literal full of escapes
  const t0 = Date.now();
  assert.equal(isWeakGuardTest(`${HEAD}test("r", () => { ${evil}; });\n`, "a.test.mjs"), false);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.equal(isWeakGuardTest(`${HEAD}test("r", () => assert.ok(/a\\/b\\.c/.test(src)));\n`, "a.test.mjs"), true); // escaped "/" and "." still parse
});
