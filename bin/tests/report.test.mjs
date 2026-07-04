/**
 * bin/tests/report.test.mjs — Unit tests for bin/report.mjs.
 *
 * Tests stat computation, formatters, and edge-case paths using
 * fixture data only — no live network calls.
 *
 * Run with: node --test bin/tests/report.test.mjs
 *
 * SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  median,
  p90,
  fmtMinutes,
  fmtPct,
  hasIssueRef,
  isBot,
  minutesBetween,
  computeStats,
  renderTerminal,
  renderMarkdown,
  renderJson,
} from "../report.mjs";

// ---------------------------------------------------------------------------
// median()
// ---------------------------------------------------------------------------

describe("median", () => {
  it("returns null for empty array", () => {
    assert.equal(median([]), null);
  });

  it("returns null for null input", () => {
    assert.equal(median(null), null);
  });

  it("returns the single element for a one-element array", () => {
    assert.equal(median([42]), 42);
  });

  it("returns middle element for odd-length array", () => {
    assert.equal(median([10, 30, 20]), 20);
  });

  it("returns average of two middle elements for even-length array", () => {
    assert.equal(median([10, 20, 30, 40]), 25);
  });

  it("handles duplicate values", () => {
    assert.equal(median([5, 5, 5]), 5);
  });

  it("handles floats", () => {
    assert.equal(median([1.5, 2.5, 3.5]), 2.5);
  });

  it("does not mutate the input array", () => {
    const arr = [30, 10, 20];
    median(arr);
    assert.deepEqual(arr, [30, 10, 20]);
  });
});

// ---------------------------------------------------------------------------
// p90()
// ---------------------------------------------------------------------------

describe("p90", () => {
  it("returns null for empty array", () => {
    assert.equal(p90([]), null);
  });

  it("returns null for null input", () => {
    assert.equal(p90(null), null);
  });

  it("returns the only element for a one-element array", () => {
    assert.equal(p90([99]), 99);
  });

  it("returns the 9th element (1-based rank 9) for 10 elements", () => {
    // sorted [1..10], rank = ceil(0.9 * 10) = 9 → value at index 8 = 9
    assert.equal(p90([5, 3, 1, 8, 2, 9, 4, 6, 7, 10]), 9);
  });

  it("p90 >= median for any non-empty array", () => {
    const values = [10, 50, 20, 80, 30, 70, 40, 60, 90, 100];
    assert.ok(p90(values) >= median(values));
  });
});

// ---------------------------------------------------------------------------
// fmtMinutes()
// ---------------------------------------------------------------------------

describe("fmtMinutes", () => {
  it("returns em dash for null", () => {
    assert.equal(fmtMinutes(null), "—");
  });

  it("formats sub-hour minutes", () => {
    assert.equal(fmtMinutes(45), "45m");
  });

  it("formats exact hours", () => {
    assert.equal(fmtMinutes(120), "2h");
  });

  it("formats hours and minutes", () => {
    assert.equal(fmtMinutes(95), "1h 35m");
  });

  it("rounds fractional minutes", () => {
    assert.equal(fmtMinutes(0.4), "0m");
    assert.equal(fmtMinutes(0.6), "1m");
  });
});

// ---------------------------------------------------------------------------
// fmtPct()
// ---------------------------------------------------------------------------

describe("fmtPct", () => {
  it("returns em dash for null", () => {
    assert.equal(fmtPct(null), "—");
  });

  it("rounds and appends percent sign", () => {
    assert.equal(fmtPct(57.4), "57%");
    assert.equal(fmtPct(57.6), "58%");
  });

  it("handles 0 and 100", () => {
    assert.equal(fmtPct(0), "0%");
    assert.equal(fmtPct(100), "100%");
  });
});

// ---------------------------------------------------------------------------
// hasIssueRef()
// ---------------------------------------------------------------------------

describe("hasIssueRef", () => {
  it("returns false for empty/null body", () => {
    assert.equal(hasIssueRef(""), false);
    assert.equal(hasIssueRef(null), false);
  });

  it("matches Closes #N", () => {
    assert.equal(hasIssueRef("Closes #42"), true);
  });

  it("matches Fixes #N (case-insensitive)", () => {
    assert.equal(hasIssueRef("fixes #100"), true);
  });

  it("matches Resolves #N", () => {
    assert.equal(hasIssueRef("Resolves #7"), true);
  });

  it("does not match plain #N mentions", () => {
    assert.equal(hasIssueRef("Related to #42"), false);
  });

  it("does not match partial words", () => {
    assert.equal(hasIssueRef("discloses #1"), false);
  });
});

// ---------------------------------------------------------------------------
// isBot()
// ---------------------------------------------------------------------------

describe("isBot", () => {
  it("returns true for [bot] suffix", () => {
    assert.equal(isBot("github-actions[bot]"), true);
    assert.equal(isBot("rapiercraft-forge[bot]"), true);
  });

  it("returns true for github-actions", () => {
    assert.equal(isBot("github-actions"), true);
  });

  it("returns false for human logins", () => {
    assert.equal(isBot("mrdubey"), false);
    assert.equal(isBot("alice"), false);
  });

  it("returns false for empty string", () => {
    assert.equal(isBot(""), false);
  });
});

// ---------------------------------------------------------------------------
// minutesBetween()
// ---------------------------------------------------------------------------

describe("minutesBetween", () => {
  it("returns null for missing timestamps", () => {
    assert.equal(minutesBetween(null, null), null);
    assert.equal(minutesBetween("2026-06-01T00:00:00Z", null), null);
  });

  it("computes minutes correctly", () => {
    assert.equal(
      minutesBetween("2026-06-01T00:00:00Z", "2026-06-01T01:00:00Z"),
      60,
    );
  });

  it("returns null for negative duration", () => {
    assert.equal(
      minutesBetween("2026-06-01T02:00:00Z", "2026-06-01T01:00:00Z"),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// computeStats() — fixture-based
// ---------------------------------------------------------------------------

describe("computeStats", () => {
  // Minimal fixture: 5 closed issues, 3 merged PRs
  const makeIssue = (overrides) => ({
    number: 1,
    createdAt: "2026-06-01T00:00:00Z",
    closedAt: "2026-06-01T01:00:00Z",
    labels: [],
    body: "",
    author: { login: "alice" },
    ...overrides,
  });

  const makePR = (overrides) => ({
    number: 100,
    mergedAt: "2026-06-02T00:00:00Z",
    body: "",
    author: { login: "alice" },
    ...overrides,
  });

  it("returns zero stats for empty history", () => {
    const stats = computeStats([], [], {
      since: "2026-06-01",
      until: "2026-07-01",
      days: 30,
    });
    assert.equal(stats.totalIssues, 0);
    assert.equal(stats.totalPRs, 0);
    assert.equal(stats.medianClose, null);
    assert.equal(stats.p90Close, null);
    assert.equal(stats.prRefRate, null);
    assert.equal(stats.machineShare, null);
  });

  it("counts FORGE:TRAJECTORY annotations", () => {
    const issues = [
      makeIssue({ body: "<!-- FORGE:TRAJECTORY -->" }),
      makeIssue({ body: "<!-- FORGE:TRAJECTORY -->" }),
      makeIssue({ body: "" }),
    ];
    const stats = computeStats(issues, [], { days: 30 });
    assert.equal(stats.withTrajectory, 2);
  });

  it("counts FORGE:INVESTIGATOR annotations", () => {
    const issues = [
      makeIssue({ body: "<!-- FORGE:INVESTIGATOR -->" }),
      makeIssue({ body: "" }),
    ];
    const stats = computeStats(issues, [], { days: 30 });
    assert.equal(stats.withInvestigator, 1);
  });

  it("computes median close time", () => {
    const issues = [
      makeIssue({
        createdAt: "2026-06-01T00:00:00Z",
        closedAt: "2026-06-01T01:00:00Z", // 60 min
      }),
      makeIssue({
        createdAt: "2026-06-01T00:00:00Z",
        closedAt: "2026-06-01T02:00:00Z", // 120 min
      }),
      makeIssue({
        createdAt: "2026-06-01T00:00:00Z",
        closedAt: "2026-06-01T03:00:00Z", // 180 min
      }),
    ];
    const stats = computeStats(issues, [], { days: 30 });
    assert.equal(stats.medianClose, 120);
  });

  it("computes p90 close time", () => {
    // 10 issues, 9th when sorted = 9h
    const times = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // hours
    const issues = times.map((h) =>
      makeIssue({
        createdAt: "2026-06-01T00:00:00Z",
        closedAt: `2026-06-01T${String(h).padStart(2, "0")}:00:00Z`,
      }),
    );
    const stats = computeStats(issues, [], { days: 30 });
    // p90 = 9th element (sorted) = 540 minutes
    assert.equal(stats.p90Close, 540);
  });

  it("counts PRs with issue references", () => {
    const prs = [
      makePR({ body: "Closes #42" }),
      makePR({ body: "Fixes #100" }),
      makePR({ body: "No reference here" }),
    ];
    const stats = computeStats([], prs, { days: 30 });
    assert.equal(stats.prsWithRef, 2);
    assert.ok(Math.abs(stats.prRefRate - 66.67) < 1);
  });

  it("counts review-finding issues", () => {
    const issues = [
      makeIssue({ labels: [{ name: "review-finding" }] }),
      makeIssue({ labels: [{ name: "enhancement" }] }),
    ];
    const stats = computeStats(issues, [], { days: 30 });
    assert.equal(stats.reviewFindings, 1);
  });

  it("counts workflow:invalid issues", () => {
    const issues = [
      makeIssue({ labels: [{ name: "workflow:invalid" }] }),
      makeIssue({ labels: [] }),
    ];
    const stats = computeStats(issues, [], { days: 30 });
    assert.equal(stats.invalidIssues, 1);
  });

  it("counts machine-filed issues via [bot] login", () => {
    const issues = [
      makeIssue({ author: { login: "rapiercraft-forge[bot]" } }),
      makeIssue({ author: { login: "alice" } }),
    ];
    const stats = computeStats(issues, [], { days: 30 });
    assert.equal(stats.machineFiled, 1);
    assert.equal(stats.machineShare, 50);
  });

  it("labels approximate counts (machine-filed) in terminal output", () => {
    const issues = [
      makeIssue({ author: { login: "rapiercraft-forge[bot]" } }),
    ];
    const stats = computeStats(issues, [], {
      since: "2026-06-01",
      until: "2026-07-01",
      days: 30,
    });
    const output = renderTerminal(stats, "test/repo");
    // Approximate counts must carry a ~ prefix
    assert.match(output, /~1/);
  });
});

// ---------------------------------------------------------------------------
// renderTerminal()
// ---------------------------------------------------------------------------

describe("renderTerminal", () => {
  const emptyStats = computeStats([], [], {
    since: "2026-06-01",
    until: "2026-07-01",
    days: 30,
  });

  it("shows no-history pointer when empty", () => {
    const out = renderTerminal(emptyStats, "org/repo");
    assert.match(out, /No ForgeDock activity/i);
    assert.match(out, /\/work-on/);
  });

  it("shows repo name in header", () => {
    const out = renderTerminal(emptyStats, "acme/platform");
    assert.match(out, /acme\/platform/);
  });

  it("shows days in header", () => {
    const out = renderTerminal(emptyStats, "acme/platform");
    assert.match(out, /30 days/);
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown()
// ---------------------------------------------------------------------------

describe("renderMarkdown", () => {
  const emptyStats = computeStats([], [], {
    since: "2026-06-01",
    until: "2026-07-01",
    days: 30,
  });

  it("shows no-history blockquote when empty", () => {
    const out = renderMarkdown(emptyStats, "org/repo");
    assert.match(out, /No ForgeDock activity/i);
  });

  it("includes fleet pointer by default", () => {
    const issue = {
      number: 1,
      createdAt: "2026-06-01T00:00:00Z",
      closedAt: "2026-06-01T01:00:00Z",
      labels: [],
      body: "",
      author: { login: "alice" },
    };
    const stats = computeStats([issue], [], {
      since: "2026-06-01",
      until: "2026-07-01",
      days: 30,
    });
    const out = renderMarkdown(stats, "org/repo");
    assert.match(out, /forgedock\.com\/for-companies/);
  });

  it("suppresses fleet pointer with --quiet", () => {
    const issue = {
      number: 1,
      createdAt: "2026-06-01T00:00:00Z",
      closedAt: "2026-06-01T01:00:00Z",
      labels: [],
      body: "",
      author: { login: "alice" },
    };
    const stats = computeStats([issue], [], {
      since: "2026-06-01",
      until: "2026-07-01",
      days: 30,
    });
    const out = renderMarkdown(stats, "org/repo", { quiet: true });
    assert.doesNotMatch(out, /forgedock\.com\/for-companies/);
  });

  it("renders a markdown table with expected headers", () => {
    const issue = {
      number: 1,
      createdAt: "2026-06-01T00:00:00Z",
      closedAt: "2026-06-01T02:00:00Z",
      labels: [],
      body: "",
      author: { login: "alice" },
    };
    const stats = computeStats([issue], [], {
      since: "2026-06-01",
      until: "2026-07-01",
      days: 30,
    });
    const out = renderMarkdown(stats, "org/repo");
    assert.match(out, /\| Metric \| Value \|/);
    assert.match(out, /Issues closed/);
    assert.match(out, /Median close time/);
  });
});

// ---------------------------------------------------------------------------
// renderJson()
// ---------------------------------------------------------------------------

describe("renderJson", () => {
  it("produces valid JSON", () => {
    const stats = computeStats([], [], {
      since: "2026-06-01",
      until: "2026-07-01",
      days: 30,
    });
    const json = renderJson(stats, "org/repo");
    assert.doesNotThrow(() => JSON.parse(json));
  });

  it("includes repo field", () => {
    const stats = computeStats([], [], {
      since: "2026-06-01",
      until: "2026-07-01",
      days: 30,
    });
    const parsed = JSON.parse(renderJson(stats, "org/repo"));
    assert.equal(parsed.repo, "org/repo");
  });

  it("includes totalIssues and totalPRs", () => {
    const stats = computeStats([], [], {
      since: "2026-06-01",
      until: "2026-07-01",
      days: 30,
    });
    const parsed = JSON.parse(renderJson(stats, "org/repo"));
    assert.equal(parsed.totalIssues, 0);
    assert.equal(parsed.totalPRs, 0);
  });
});
