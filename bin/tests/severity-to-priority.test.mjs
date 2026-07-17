/**
 * bin/tests/severity-to-priority.test.mjs
 *
 * Unit tests for scripts/severity-to-priority.sh — the single source of truth
 * for the finding `**Severity**` -> `priority:*` label mapping.
 *
 * Regression coverage for forge#2447: commands/review-pr.md and
 * commands/review-pr-staging.md previously derived the `priority:*` label
 * from a finding's Confidence (CONFIRMED/LIKELY/POSSIBLE) instead of its
 * Severity (CRITICAL/HIGH/MEDIUM/LOW). A finding with
 * `**Severity**: LOW` and `**Confidence**: CONFIRMED` was mislabeled
 * `priority:P1`, which defeats /orchestrate's P3 batching rule (P1/P2
 * findings are never batched).
 *
 * Also covers forge#2480: an `INFO -> priority:P3` branch was originally
 * added alongside the mapping above, but no `commands/review-pr-agents/*.md`
 * persona or finding-body template ever documented/emitted `INFO` as a valid
 * Severity value, making it permanently unreachable dead code. The branch
 * was removed from scripts/severity-to-priority.sh; `INFO` is now asserted to
 * be rejected as an unrecognized severity, same as any other invalid input.
 *
 * This suite exercises scripts/severity-to-priority.sh directly via bash
 * (mirrors the script's own `#!/usr/bin/env bash` shebang — works under
 * Git Bash on Windows and natively on Linux CI), asserting the full mapping
 * table plus the explicit LOW -> priority:P3 regression case named in the
 * issue.
 *
 * Run with: node --test bin/tests/severity-to-priority.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "severity-to-priority.sh");

/**
 * Run severity-to-priority.sh via bash with the given arguments.
 * Returns { stdout, stderr, status }.
 */
function run(args) {
  const result = spawnSync("bash", [SCRIPT_PATH, ...args], {
    encoding: "utf-8",
    timeout: 10000,
  });
  return result;
}

describe("scripts/severity-to-priority.sh — Severity -> priority:* mapping (forge#2447)", () => {
  const MAPPING_TABLE = [
    ["CRITICAL", "priority:P0"],
    ["HIGH", "priority:P1"],
    ["MEDIUM", "priority:P2"],
    ["LOW", "priority:P3"],
  ];

  for (const [severity, expectedLabel] of MAPPING_TABLE) {
    it(`maps ${severity} -> ${expectedLabel}`, () => {
      const result = run([severity]);
      assert.equal(result.status, 0, `expected exit 0 for ${severity}, got ${result.status}. stderr: ${result.stderr}`);
      assert.equal(result.stdout.trim(), expectedLabel);
    });
  }

  it("REGRESSION (forge#2447): LOW severity maps to priority:P3, never priority:P1", () => {
    // This is the exact reproduction case from the issue: a finding with
    // **Severity**: LOW and **Confidence**: CONFIRMED was previously labeled
    // priority:P1 because the label was derived from Confidence, not
    // Severity. The mapping must be a pure function of severity alone.
    const result = run(["LOW"]);
    assert.equal(result.status, 0);
    const label = result.stdout.trim();
    assert.equal(label, "priority:P3");
    assert.notEqual(label, "priority:P1", "LOW severity must never be labeled priority:P1");
  });

  it("exits 1 with no stdout label for an unrecognized severity", () => {
    const result = run(["BOGUS"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), "");
    assert.match(result.stderr, /Unrecognized severity/);
  });

  it("REGRESSION (forge#2480): INFO is rejected as unrecognized — it was removed as an unreachable dead branch", () => {
    // INFO -> priority:P3 previously existed here but no producer (any
    // review-pr-agents persona, or either finding-body template's Severity
    // enum) ever emitted it. It must now behave exactly like any other
    // invalid severity token, not silently map to a priority.
    const result = run(["INFO"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), "");
    assert.match(result.stderr, /Unrecognized severity/);
  });

  it("exits 1 when called with no arguments", () => {
    const result = run([]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), "");
    assert.match(result.stderr, /Usage/);
  });

  it("is case-sensitive — lowercase severity is rejected rather than silently guessed", () => {
    const result = run(["low"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), "");
  });
});
