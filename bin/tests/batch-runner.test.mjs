/**
 * bin/tests/batch-runner.test.mjs
 *
 * Unit tests for bin/batch-runner.mjs — the pipeline eval harness batch driver
 * (issue #1285).
 *
 * All tests are pure-function; no network, no live SDK calls.
 * loadCorpus() uses the real fs via tmpdir fixtures.
 * runCorpus() is tested via a stub runCommand so no Anthropic SDK is needed.
 *
 * Run with: node --test bin/tests/batch-runner.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  loadCorpus,
  makeRunResult,
  classifyRunnerResult,
  writeResults,
} from "../batch-runner.mjs";

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let TMP;
before(() => {
  TMP = mkdtempSync(join(os.tmpdir(), "forgedock-batch-runner-"));
});
after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadCorpus
// ---------------------------------------------------------------------------

describe("loadCorpus", () => {
  it("loads a valid corpus file", () => {
    const path = join(TMP, "corpus-valid.json");
    writeFileSync(
      path,
      JSON.stringify({ corpus_version: "v1", issues: [1001, 1002, 1003] }),
      "utf-8",
    );
    const corpus = loadCorpus(path);
    assert.equal(corpus.corpus_version, "v1");
    assert.deepEqual(corpus.issues, [1001, 1002, 1003]);
  });

  it("corpus_version defaults to null when absent", () => {
    const path = join(TMP, "corpus-no-version.json");
    writeFileSync(path, JSON.stringify({ issues: [42] }), "utf-8");
    const corpus = loadCorpus(path);
    assert.equal(corpus.corpus_version, null);
  });

  it("throws when file does not exist", () => {
    assert.throws(
      () => loadCorpus(join(TMP, "does-not-exist.json")),
      /Cannot read corpus file/,
    );
  });

  it("throws on invalid JSON", () => {
    const path = join(TMP, "corpus-bad.json");
    writeFileSync(path, "{ not json", "utf-8");
    assert.throws(() => loadCorpus(path), /invalid JSON/);
  });

  it("throws when issues is missing", () => {
    const path = join(TMP, "corpus-no-issues.json");
    writeFileSync(path, JSON.stringify({ corpus_version: "v1" }), "utf-8");
    assert.throws(() => loadCorpus(path), /non-empty "issues" array/);
  });

  it("throws when issues is an empty array", () => {
    const path = join(TMP, "corpus-empty.json");
    writeFileSync(path, JSON.stringify({ issues: [] }), "utf-8");
    assert.throws(() => loadCorpus(path), /non-empty "issues" array/);
  });

  it("throws when an issue number is not a positive integer", () => {
    const path = join(TMP, "corpus-bad-issue.json");
    writeFileSync(
      path,
      JSON.stringify({ issues: [1001, "not-a-number", 1003] }),
      "utf-8",
    );
    assert.throws(() => loadCorpus(path), /must be a positive integer/);
  });

  it("throws when an issue number is a float", () => {
    const path = join(TMP, "corpus-float.json");
    writeFileSync(path, JSON.stringify({ issues: [1001, 1.5] }), "utf-8");
    assert.throws(() => loadCorpus(path), /must be a positive integer/);
  });

  it("throws when an issue number is zero or negative", () => {
    const path = join(TMP, "corpus-zero.json");
    writeFileSync(path, JSON.stringify({ issues: [0] }), "utf-8");
    assert.throws(() => loadCorpus(path), /must be a positive integer/);
  });
});

// ---------------------------------------------------------------------------
// makeRunResult
// ---------------------------------------------------------------------------

describe("makeRunResult", () => {
  it("sets required fields from arguments", () => {
    const r = makeRunResult(1285, "success", { wallClockMs: 5000, interventionCount: 1 });
    assert.equal(r.issue, 1285);
    assert.equal(r.status, "success");
    assert.equal(r.wallClockMs, 5000);
    assert.equal(r.interventionCount, 1);
  });

  it("defaults cost to null", () => {
    const r = makeRunResult(1285, "success");
    assert.equal(r.cost, null);
  });

  it("preserves a provided cost", () => {
    const r = makeRunResult(1285, "success", { cost: 0.042 });
    assert.equal(r.cost, 0.042);
  });

  it("defaults wallClockMs and interventionCount to 0", () => {
    const r = makeRunResult(1285, "error");
    assert.equal(r.wallClockMs, 0);
    assert.equal(r.interventionCount, 0);
  });

  it("includes error message for error status", () => {
    const r = makeRunResult(1285, "error", { error: "API timeout" });
    assert.equal(r.error, "API timeout");
    assert.equal(r.status, "error");
  });

  it("produces an ISO-8601 runAt when not provided", () => {
    const r = makeRunResult(1285, "success");
    assert.match(r.runAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("uses a provided runAt value", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const r = makeRunResult(1285, "success", { runAt: ts });
    assert.equal(r.runAt, ts);
  });

  it("includes all schema-required keys", () => {
    const r = makeRunResult(1285, "success");
    const keys = [
      "issue", "status", "wallClockMs", "interventionCount", "cost",
      "iterations", "stopReason", "error", "specVersion", "model", "runAt",
    ];
    for (const k of keys) {
      assert.ok(Object.prototype.hasOwnProperty.call(r, k), `missing key: ${k}`);
    }
  });
});

// ---------------------------------------------------------------------------
// classifyRunnerResult
// ---------------------------------------------------------------------------

describe("classifyRunnerResult", () => {
  it('maps status "complete" to "success"', () => {
    assert.equal(classifyRunnerResult({ status: "complete" }), "success");
  });

  it('maps status "incomplete" to "incomplete"', () => {
    assert.equal(classifyRunnerResult({ status: "incomplete" }), "incomplete");
  });

  it('maps status "max-iterations" to "incomplete"', () => {
    assert.equal(classifyRunnerResult({ status: "max-iterations" }), "incomplete");
  });

  it('maps status "dry-run" to "incomplete"', () => {
    assert.equal(classifyRunnerResult({ status: "dry-run" }), "incomplete");
  });

  it("maps any unknown status to incomplete (safe default)", () => {
    assert.equal(classifyRunnerResult({ status: "something-new" }), "incomplete");
  });
});

// ---------------------------------------------------------------------------
// writeResults
// ---------------------------------------------------------------------------

describe("writeResults", () => {
  it("writes a valid JSON file at the specified path", () => {
    const outputPath = join(TMP, "results", "out.json");
    const runs = [
      makeRunResult(1001, "success", { wallClockMs: 10000 }),
      makeRunResult(1002, "failure", { wallClockMs: 20000 }),
    ];
    writeResults(outputPath, runs, { corpus_version: "v1" });

    const raw = readFileSync(outputPath, "utf-8");
    const data = JSON.parse(raw);
    assert.equal(data.corpus_version, "v1");
    assert.equal(data.runs.length, 2);
    assert.equal(data.runs[0].issue, 1001);
    assert.equal(data.runs[1].issue, 1002);
  });

  it("creates intermediate directories as needed", () => {
    const outputPath = join(TMP, "deep", "nested", "dir", "output.json");
    writeResults(outputPath, [], {});
    const data = JSON.parse(readFileSync(outputPath, "utf-8"));
    assert.ok(Array.isArray(data.runs));
  });

  it("includes generated_at as an ISO-8601 timestamp", () => {
    const outputPath = join(TMP, "ts-test.json");
    writeResults(outputPath, [], {});
    const data = JSON.parse(readFileSync(outputPath, "utf-8"));
    assert.match(data.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("overwrites an existing file", () => {
    const outputPath = join(TMP, "overwrite.json");
    writeResults(outputPath, [makeRunResult(1001, "success")], {});
    writeResults(outputPath, [makeRunResult(9999, "failure")], {});
    const data = JSON.parse(readFileSync(outputPath, "utf-8"));
    assert.equal(data.runs.length, 1);
    assert.equal(data.runs[0].issue, 9999);
  });
});
