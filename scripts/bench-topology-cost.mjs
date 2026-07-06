#!/usr/bin/env node
/**
 * scripts/bench-topology-cost.mjs — end-to-end token-cost benchmark for pipeline topologies (#1279)
 *
 * Deterministic, zero-dependency aggregator for comparing per-issue token cost across
 * ForgeDock pipeline topologies (e.g. "spawned" vs "inline-sequential").
 *
 * Measures the cost reduction claim from the agent topology refactor (#1254):
 * eliminating 6-8 fresh-context establishments per standard run reduces token cost.
 *
 * Benchmark corpus: the 5 seeded issues in examples/forgedock-demo/
 *   Issue 1 — Bug / security:  DELETE is missing an auth check
 *   Issue 2 — Feature / security: Safe filtering for GET /notes
 *   Issue 3 — Refactor: Extract the router module
 *   Issue 4 — Performance: O(1) findById
 *   Issue 5 — Docs: Add an API reference
 *
 * Input schema (runs.json):
 * {
 *   "runs": [
 *     {
 *       "topology": "spawned | inline-sequential",
 *       "date": "ISO-8601",
 *       "claude_model": "claude-sonnet-4-5 | ...",
 *       "issues": [
 *         {
 *           "number": 1,
 *           "title": "string",
 *           "input_tokens": 12345,
 *           "output_tokens": 2345,
 *           "cache_read_tokens": 1000,
 *           "cache_write_tokens": 500,
 *           "quality_gate_passed": true
 *         }
 *       ]
 *     }
 *   ]
 * }
 *
 * Measurements can be populated from:
 *   1. Session log parsing (when bin/runner.mjs emits usage metadata — see #1295)
 *   2. Manual capture from Claude Code session summaries
 *
 * Usage:
 *   node scripts/bench-topology-cost.mjs <runs.json>   # read file, print scorecard JSON
 *   node scripts/bench-topology-cost.mjs -              # read runs JSON from stdin
 *   cat runs.json | node scripts/bench-topology-cost.mjs  # (no arg) read from stdin
 *
 * Exit codes:
 *   0 = scorecard emitted successfully
 *   1 = invalid input (bad JSON, missing required fields, unknown topology)
 *   2 = quality gate regression detected (scorecard still emitted to stdout)
 */

const CORPUS_ISSUES = [1, 2, 3, 4, 5];
const KNOWN_TOPOLOGIES = new Set(["spawned", "inline-sequential"]);
const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"];

/**
 * Total tokens billed for a single issue run.
 * Cache reads are billed at a lower rate but still count against context budget.
 * cache_write_tokens are not billed but indicate context establishment cost.
 */
export function totalTokens(issue) {
  return (issue.input_tokens || 0) + (issue.output_tokens || 0);
}

/**
 * Total context establishment cost: input + cache_write (fresh-context proxy).
 * Reducing cache_write_tokens is the primary signal for the topology refactor —
 * fewer spawned agents means fewer fresh context establishments.
 */
export function contextEstablishmentTokens(issue) {
  return (issue.input_tokens || 0) + (issue.cache_write_tokens || 0);
}

/**
 * Per-run aggregate: sum and per-issue breakdown.
 */
export function aggregateRun(run) {
  const issues = run.issues || [];
  const perIssue = issues.map((iss) => ({
    number: iss.number,
    title: iss.title || `Issue #${iss.number}`,
    total_tokens: totalTokens(iss),
    context_tokens: contextEstablishmentTokens(iss),
    input_tokens: iss.input_tokens || 0,
    output_tokens: iss.output_tokens || 0,
    cache_read_tokens: iss.cache_read_tokens || 0,
    cache_write_tokens: iss.cache_write_tokens || 0,
    quality_gate_passed: iss.quality_gate_passed ?? null,
  }));

  const totals = perIssue.reduce(
    (acc, iss) => {
      acc.total_tokens += iss.total_tokens;
      acc.context_tokens += iss.context_tokens;
      acc.input_tokens += iss.input_tokens;
      acc.output_tokens += iss.output_tokens;
      acc.cache_read_tokens += iss.cache_read_tokens;
      acc.cache_write_tokens += iss.cache_write_tokens;
      return acc;
    },
    {
      total_tokens: 0,
      context_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  );

  const issueCount = perIssue.length;
  const qualityGatePassed = perIssue.every((iss) => iss.quality_gate_passed !== false);
  const qualityGateRegressions = perIssue.filter((iss) => iss.quality_gate_passed === false);

  return {
    topology: run.topology,
    date: run.date || null,
    claude_model: run.claude_model || null,
    issue_count: issueCount,
    per_issue: perIssue,
    totals,
    averages:
      issueCount > 0
        ? {
            total_tokens: round(totals.total_tokens / issueCount),
            context_tokens: round(totals.context_tokens / issueCount),
            input_tokens: round(totals.input_tokens / issueCount),
            output_tokens: round(totals.output_tokens / issueCount),
            cache_read_tokens: round(totals.cache_read_tokens / issueCount),
            cache_write_tokens: round(totals.cache_write_tokens / issueCount),
          }
        : null,
    quality_gates: {
      all_passed: qualityGatePassed,
      regressions: qualityGateRegressions.map((iss) => iss.number),
    },
  };
}

/**
 * Compute delta between two aggregated runs (topology comparison).
 * Positive delta means `after` uses MORE tokens than `before` (regression).
 * Negative delta means `after` uses FEWER tokens (improvement).
 */
export function computeDelta(before, after) {
  if (!before || !after) return null;

  const pct = (b, a) => (b === 0 ? null : round(((a - b) / b) * 100));

  return {
    total_tokens: {
      before: before.totals.total_tokens,
      after: after.totals.total_tokens,
      delta: after.totals.total_tokens - before.totals.total_tokens,
      delta_pct: pct(before.totals.total_tokens, after.totals.total_tokens),
    },
    context_tokens: {
      before: before.totals.context_tokens,
      after: after.totals.context_tokens,
      delta: after.totals.context_tokens - before.totals.context_tokens,
      delta_pct: pct(before.totals.context_tokens, after.totals.context_tokens),
    },
    cache_write_tokens: {
      before: before.totals.cache_write_tokens,
      after: after.totals.cache_write_tokens,
      delta: after.totals.cache_write_tokens - before.totals.cache_write_tokens,
      delta_pct: pct(before.totals.cache_write_tokens, after.totals.cache_write_tokens),
    },
    quality_gates_unchanged:
      before.quality_gates.all_passed && after.quality_gates.all_passed,
  };
}

/**
 * Validate the runs file shape. Throws on any violation.
 */
export function validate(data) {
  if (!data || typeof data !== "object") throw new Error("runs file must be a JSON object");
  if (!Array.isArray(data.runs) || data.runs.length === 0) {
    throw new Error("runs file must contain a non-empty `runs` array");
  }

  for (let i = 0; i < data.runs.length; i++) {
    const run = data.runs[i];
    if (!run.topology) {
      throw new Error(`runs[${i}] must have a "topology" field`);
    }
    if (!KNOWN_TOPOLOGIES.has(run.topology)) {
      throw new Error(
        `runs[${i}].topology "${run.topology}" is unknown. Valid values: ${[...KNOWN_TOPOLOGIES].join(", ")}`,
      );
    }
    if (!Array.isArray(run.issues) || run.issues.length === 0) {
      throw new Error(`runs[${i}] (topology: ${run.topology}) must have a non-empty "issues" array`);
    }
    if (run.issues.length !== CORPUS_ISSUES.length) {
      process.stderr.write(
        `WARNING: runs[${i}] (topology: ${run.topology}) has ${run.issues.length} issue(s) ` +
          `but the standard corpus is ${CORPUS_ISSUES.length} issues. ` +
          `Partial runs produce non-comparable deltas.\n`,
      );
    }
    for (let j = 0; j < run.issues.length; j++) {
      const iss = run.issues[j];
      if (typeof iss.number !== "number") {
        throw new Error(`runs[${i}].issues[${j}] must have a numeric "number" field`);
      }
      for (const field of TOKEN_FIELDS) {
        if (iss[field] !== undefined && typeof iss[field] !== "number") {
          throw new Error(
            `runs[${i}].issues[${j}].${field} must be a number (got ${typeof iss[field]})`,
          );
        }
      }
    }
  }
}

/**
 * Aggregate all runs and produce the scorecard.
 * Throws on validation failure.
 */
export function aggregate(data) {
  validate(data);

  const aggregated = data.runs.map(aggregateRun);

  // Group by topology for comparison
  const byTopology = {};
  for (const run of aggregated) {
    if (!byTopology[run.topology]) byTopology[run.topology] = [];
    byTopology[run.topology].push(run);
  }

  // Pick the most recent run per topology for comparison
  const latestByTopology = {};
  for (const [topology, runs] of Object.entries(byTopology)) {
    latestByTopology[topology] = runs[runs.length - 1];
  }

  // Compute delta: spawned (baseline) vs inline-sequential (after refactor)
  const baseline = latestByTopology["spawned"] || null;
  const refactored = latestByTopology["inline-sequential"] || null;
  const delta = computeDelta(baseline, refactored);

  // Quality gate regression check
  const qualityRegressions = aggregated
    .filter((r) => !r.quality_gates.all_passed)
    .map((r) => ({ topology: r.topology, date: r.date, regressions: r.quality_gates.regressions }));

  return {
    corpus: {
      description: "ForgeDock demo repo — 5 seeded issues (examples/forgedock-demo/)",
      issue_numbers: CORPUS_ISSUES,
    },
    runs: aggregated,
    topology_comparison: delta
      ? {
          baseline_topology: "spawned",
          refactored_topology: "inline-sequential",
          delta,
          verdict:
            delta.total_tokens.delta < 0
              ? "IMPROVEMENT"
              : delta.total_tokens.delta === 0
                ? "NEUTRAL"
                : "REGRESSION",
          quality_gates_confirmed: delta.quality_gates_unchanged,
        }
      : null,
    quality_gate_summary: {
      all_runs_passed: qualityRegressions.length === 0,
      regressions: qualityRegressions,
    },
  };
}

function round(x) {
  return Math.round(x * 100) / 100;
}

async function readInput(arg) {
  const { readFileSync } = await import("node:fs");
  if (!arg || arg === "-") {
    return readFileSync(0, "utf8"); // fd 0 = stdin
  }
  return readFileSync(arg, "utf8");
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/bench-topology-cost.mjs <runs.json>",
      "  node scripts/bench-topology-cost.mjs -   (read from stdin)",
      "",
      "Input schema (runs.json):",
      '  { "runs": [{ "topology": "spawned|inline-sequential", "date": "ISO-8601",',
      '     "claude_model": "string", "issues": [{ "number": 1, "title": "string",',
      '     "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,',
      '     "cache_write_tokens": 0, "quality_gate_passed": true }] }] }',
      "",
      "Benchmark corpus: examples/forgedock-demo/ issues #1–#5",
      "Topologies measured: spawned (baseline) vs inline-sequential (refactored)",
      "",
      "Output: JSON scorecard to stdout",
      "Exit 0 = OK, Exit 1 = invalid input, Exit 2 = quality gate regression",
    ].join("\n") + "\n",
  );
}

async function main() {
  const arg = process.argv[2];

  if (arg === "--help" || arg === "-h") {
    printUsage();
    process.exit(0);
  }

  if (!arg) {
    // No argument and no piped input — print usage
    const isTTY = process.stdin.isTTY;
    if (isTTY) {
      printUsage();
      process.exit(0);
    }
  }

  let raw;
  try {
    raw = await readInput(arg);
  } catch (e) {
    process.stderr.write(`ERROR: cannot read input: ${e.message}\n`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`ERROR: invalid JSON: ${e.message}\n`);
    process.exit(1);
  }

  let scorecard;
  try {
    scorecard = aggregate(data);
  } catch (e) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(scorecard, null, 2) + "\n");

  if (!scorecard.quality_gate_summary.all_runs_passed) {
    const regressions = scorecard.quality_gate_summary.regressions;
    process.stderr.write(
      `WARNING: quality gate regressions detected in ${regressions.length} run(s). ` +
        `Issues with failures: ${regressions.map((r) => `[${r.topology}] #${r.regressions.join(", #")}`).join("; ")}\n`,
    );
    process.exit(2);
  }
}

// Run as CLI only when invoked directly, not when imported by tests.
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
