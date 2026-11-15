// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJunit, parseTap, parseReport, attributeFile, fileDurations, failedFiles, planShards } from "./testengine-shard.mjs";

const rep = (n) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "testengine", "reports", n), "utf8");
const PY = ["tests/integration/test_checkout.py", "tests/unit/test_pricing.py", "tests/unit/test_tax.py"];
const JS = ["test/cart.test.js", "test/math.test.js", "web/__tests__/button.tsx"];

describe("parseJunit", () => {
  it("reads pytest cases: status, seconds, decoded names", () => {
    const r = parseJunit(rep("pytest-junit.xml"));
    assert.deepEqual(r.map((c) => [c.file, c.status, c.seconds]), [
      ["tests.unit.test_pricing", "pass", 0.25], ["tests.unit.test_tax", "fail", 1], ["tests.unit.test_tax", "skip", 0.5],
      ["tests.integration.test_checkout.TestCheckout", "pass", 1.5], ["tests.gone.test_removed", "fail", 0.25],
    ]);
  });
  it("reads vitest/jest cases: file from the classname or the suite name", () => {
    const r = parseJunit(rep("vitest-junit.xml"));
    assert.deepEqual(r.map((c) => [c.file, c.name, c.status]), [["test/cart.test.js", "cart > total", "fail"], ["test/cart.test.js", "cart > empty", "pass"], ["/work/repo/test/math.test.js", "add", "pass"]]);
  });
  it("prefers a file attribute and survives `>` inside attribute values", () => {
    const r = parseJunit('<testsuite name="s" file="a/b_test.py"><testcase name="x > y" classname="K" time="2"/><testcase name="z" file="c/test_d.py"><error/></testcase></testsuite>');
    assert.deepEqual(r, [{ file: "a/b_test.py", name: "x > y", status: "pass", seconds: 2 }, { file: "c/test_d.py", name: "z", status: "fail", seconds: 0 }]);
  });
});

describe("parseTap", () => {
  it("counts leaf tests of node --test output once, passing a suite's file down", () => {
    const r = parseTap(rep("node-test.tap"));
    assert.deepEqual(r, [
      { file: "/work/repo/test/math.test.js", name: "one", status: "pass", seconds: 0.0015 },
      { file: "/work/repo/test/math.test.js", name: "two <bad>", status: "fail", seconds: 0.0025 },
      { file: "", name: "top", status: "pass", seconds: 0.00025 },
      { file: "", name: "later", status: "skip", seconds: 0 },
    ]);
  });
  it("takes a path-like test name as the file (per-file TAP)", () => {
    assert.deepEqual(parseTap("ok 1 - test/a.test.js\n  ---\n  duration_ms: 1500\n  ...\nnot ok 2 - test/b.test.js\n"), [
      { file: "test/a.test.js", name: "test/a.test.js", status: "pass", seconds: 1.5 }, { file: "test/b.test.js", name: "test/b.test.js", status: "fail", seconds: 0 },
    ]);
  });
});

describe("parseReport", () => {
  it("picks the format by content", () => {
    assert.equal(parseReport(rep("pytest-junit.xml")).length, 5);
    assert.equal(parseReport(rep("node-test.tap")).length, 4);
    assert.deepEqual(parseReport('{"test/a.test.js": 2.5, "note": "x"}'), [{ file: "test/a.test.js", name: "", status: "pass", seconds: 2.5 }]);
    assert.deepEqual(parseReport("{broken"), []);
    assert.deepEqual(parseReport(""), []);
  });
});

describe("attribution", () => {
  it("maps report values to known test files, and never guesses between two", () => {
    assert.equal(attributeFile("test/math.test.js", JS), "test/math.test.js");
    assert.equal(attributeFile("/work/repo/test/math.test.js", JS), "test/math.test.js");
    assert.equal(attributeFile("./test/math.test.js", JS), "test/math.test.js");
    assert.equal(attributeFile("tests.unit.test_tax", PY), "tests/unit/test_tax.py");
    assert.equal(attributeFile("tests.integration.test_checkout.TestCheckout", PY), "tests/integration/test_checkout.py");
    assert.equal(attributeFile("unit.test_tax", PY), "tests/unit/test_tax.py");
    assert.equal(attributeFile("test_x", ["a/test_x.py", "b/test_x.py"]), null);
    assert.equal(attributeFile("tests.gone.test_removed", PY), null);
    assert.equal(attributeFile("", PY), null);
  });
  it("sums seconds per file and lists failing files plus unattributed failures", () => {
    const r = parseReport(rep("pytest-junit.xml"));
    assert.deepEqual(fileDurations(r, PY), { "tests/unit/test_pricing.py": 0.25, "tests/unit/test_tax.py": 1.5, "tests/integration/test_checkout.py": 1.5 });
    assert.deepEqual(failedFiles(r, PY), { failed: ["tests/unit/test_tax.py"], unattributed: ["tests.gone.test_removed"] });
    assert.deepEqual(failedFiles(parseReport(rep("node-test.tap")), JS), { failed: ["test/math.test.js"], unattributed: [] });
  });
});

describe("planShards", () => {
  const files = ["a", "b", "c", "d", "e", "f"];
  it("is greedy LPT over recorded durations", () => {
    const p = planShards({ files, durations: { a: 10, b: 8, c: 7, d: 3, e: 2, f: 1 }, shards: 2 });
    assert.deepEqual(p.shards.map((s) => [s.index, s.files, s.est_s]), [[1, ["a", "d", "e", "f"], 16], [2, ["b", "c"], 15]]);
    assert.deepEqual([p.source, p.known, p.est_total_s, p.est_max_s], ["durations", 6, 31, 16]);
    assert.deepEqual(p.matrix, { include: [{ shard: 1, total: 2, files: "a d e f" }, { shard: 2, total: 2, files: "b c" }] });
  });
  it("falls back to file count without history", () => {
    const p = planShards({ files, shards: 3 });
    assert.equal(p.source, "file-count");
    assert.deepEqual(p.shards.map((s) => s.files.length), [2, 2, 2]);
  });
  it("gives a file without history the median of the known ones", () => {
    const p = planShards({ files: ["a", "b", "new"], durations: { a: 10, b: 2 }, shards: 2 });
    assert.equal(p.est_total_s, 14);
    assert.equal(p.known, 2);
  });
  it("derives the shard count from a target, capped, and reports files no split can shorten", () => {
    const d = { a: 600, b: 100, c: 100, d: 100, e: 50, f: 50 };
    const p = planShards({ files, durations: d, targetS: 240 });
    assert.equal(p.shards.length, 5);
    assert.deepEqual(p.oversize, [{ file: "a", s: 600 }]);
    assert.equal(p.est_max_s, 600);
    assert.equal(planShards({ files, durations: d, targetS: 240, maxShards: 3 }).shards.length, 3);
    assert.equal(planShards({ files, durations: d, targetS: 1 }).shards.length, 6, "never more shards than files");
  });
  it("is deterministic, deduplicates, and handles the empty and default cases", () => {
    assert.deepEqual(planShards({ files: ["b", "a", "a"], shards: 2 }).shards.map((s) => s.files), [["a"], ["b"]]);
    assert.deepEqual(planShards({ files: [] }).shards, [{ index: 1, files: [], est_s: 0 }]);
    assert.equal(planShards({ files }).shards.length, 1);
  });
});
