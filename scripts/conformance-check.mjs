#!/usr/bin/env node
/**
 * scripts/conformance-check.mjs — FORGE Annotation Protocol conformance suite (#1293)
 *
 * Validates FORGE annotation output (from any producer — Claude Code, Codex adapter,
 * Cursor, Aider, or fixtures) against the FORGE Annotation Protocol v1.0 as defined
 * in docs/spec/forge-protocol-v1.md.
 *
 * This script is the conformance surface referenced in #1293: once run against
 * real or fixture-captured Codex-adapter-produced annotations, it closes the loop
 * on the "second implementation, not just a second document" vendor-neutrality claim.
 *
 * Usage:
 *   node scripts/conformance-check.mjs <input.md|input.json>   # validate from file
 *   node scripts/conformance-check.mjs -                       # read comment bodies from stdin (one per line JSON or raw text)
 *   echo '<!-- FORGE:INVESTIGATOR -->\n...' | node scripts/conformance-check.mjs
 *
 * Input format:
 *   - A plain text file containing one or more FORGE annotation blocks (as they would
 *     appear in a GitHub issue/PR comment body)
 *   - A JSON file: array of comment body strings (e.g. from `gh api .../comments --jq '[.[].body]'`)
 *   - stdin: same formats
 *
 * Exit codes:
 *   0 = all annotations conform (or only unknown types found — tolerant by spec §7.2)
 *   1 = one or more conformance violations found
 *   2 = input parse error
 *
 * Conformance rules implemented (per forge-protocol-v1.md):
 *   - §3.1  Opening tag format: <!-- FORGE:{TYPE} -->
 *   - §3.2  Completion sentinel present for known annotation types
 *   - §3.3  Partial sentinel noted (warning, not error — producer may have been interrupted)
 *   - §4.1  FORGE:INVESTIGATOR required fields: Verdict, Confidence, Severity, Task Type, Decomposition Assessment
 *   - §4.1  FORGE:INVESTIGATOR Verdict values: CONFIRMED | PARTIAL | INVALID
 *   - §4.1  FORGE:INVESTIGATOR Confidence values: HIGH | MEDIUM | LOW
 *   - §4.1  FORGE:INVESTIGATOR Severity values: CRITICAL | HIGH | MEDIUM | LOW
 *   - §4.2  FORGE:CONTRACT required fields: Problem, Acceptance Criteria
 *   - §4.3  FORGE:CONTEXT required fields: Historical Context
 *   - §4.4  FORGE:ARCHITECT required fields: Approach
 *   - §4.5  FORGE:BUILDER required fields: Branch, Commits, Files changed
 *   - §4.5  FORGE:BUILDER completion sentinel: <!-- FORGE:BUILDER:COMPLETE -->
 *   - §7.2  Unknown annotation types are tolerated (not errors)
 *   - §3.2  Interrupted annotations (no completion, no partial sentinel) are flagged
 */

import { readFileSync } from "fs";

// ── Spec-defined annotation types and their validation rules ──────────────────

const KNOWN_TYPES = new Set([
  "INVESTIGATOR", "CONTRACT", "CONTEXT", "ARCHITECT", "BUILDER",
  "REVIEWER", "TRAJECTORY", "DECISION_RECORD", "CHECKPOINT",
  "PHASE:COMPLETE", "GATE_FAILED", "ANCESTRY_FAILED", "AUDIT-AGENTS",
  "STALL_DETECTED", "CARD",
]);

/**
 * Per-type validation: returns an array of violation strings (empty = conforming).
 * Completion sentinel is checked separately.
 */
const TYPE_VALIDATORS = {
  INVESTIGATOR(body) {
    const errs = [];
    if (!/\*\*Verdict\*\*:\s*(CONFIRMED|PARTIAL|INVALID)/i.test(body))
      errs.push("Missing or invalid Verdict (expected CONFIRMED | PARTIAL | INVALID)");
    if (!/\*\*Confidence\*\*:\s*(HIGH|MEDIUM|LOW)/i.test(body))
      errs.push("Missing or invalid Confidence (expected HIGH | MEDIUM | LOW)");
    if (!/\*\*Severity\*\*:\s*(CRITICAL|HIGH|MEDIUM|LOW)/i.test(body))
      errs.push("Missing or invalid Severity (expected CRITICAL | HIGH | MEDIUM | LOW)");
    if (!/\*\*Task Type\*\*:/i.test(body))
      errs.push("Missing Task Type field");
    if (!/decomposition assessment/i.test(body))
      errs.push("Missing Decomposition Assessment");
    return errs;
  },
  CONTRACT(body) {
    const errs = [];
    if (!/problem|what needs to (be done|change)/i.test(body))
      errs.push("Missing Problem/scope description");
    if (!/acceptance criteria/i.test(body))
      errs.push("Missing Acceptance Criteria");
    return errs;
  },
  CONTEXT(body) {
    const errs = [];
    if (!/historical context|prior findings|knowledge graph/i.test(body))
      errs.push("Missing Historical Context section");
    return errs;
  },
  ARCHITECT(body) {
    const errs = [];
    if (!/approach|implementation plan|design/i.test(body))
      errs.push("Missing Approach/design section");
    return errs;
  },
  BUILDER(body) {
    const errs = [];
    if (!/\*\*Branch\*\*:/i.test(body))
      errs.push("Missing Branch field");
    if (!/\*\*Commits?\*\*:/i.test(body))
      errs.push("Missing Commits field");
    if (!/\*\*Files changed\*\*:/i.test(body))
      errs.push("Missing Files changed field");
    return errs;
  },
};

// Per-type completion sentinels (§3.2 — domain-specific sentinels where specified)
const COMPLETION_SENTINELS = {
  INVESTIGATOR: /<!--\s*INVESTIGATION:COMPLETE\s*-->/,
  BUILDER: /<!--\s*FORGE:BUILDER:COMPLETE\s*-->/,
  // For all other known types: generic pattern <!-- {TYPE}:COMPLETE -->
};

function completionSentinelFor(type) {
  if (COMPLETION_SENTINELS[type]) return COMPLETION_SENTINELS[type];
  return new RegExp(`<!--\\s*${type.replace(":", "\\:")}:COMPLETE\\s*-->`);
}

// ── Annotation extraction ─────────────────────────────────────────────────────

/**
 * Extract all FORGE annotations from a comment body string.
 * Returns [{type, body, startLine}]
 */
function extractAnnotations(commentBody) {
  const lines = commentBody.split("\n");
  const annotations = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const openMatch = line.match(/^<!--\s*FORGE:([A-Z][A-Z0-9_:]*)\s*-->/);
    if (openMatch) {
      if (current) annotations.push(current);
      current = { type: openMatch[1], body: line + "\n", startLine: i + 1 };
    } else if (current) {
      current.body += line + "\n";
    }
  }
  if (current) annotations.push(current);
  return annotations;
}

// ── Conformance check ─────────────────────────────────────────────────────────

function checkAnnotation(ann) {
  const { type, body } = ann;
  const results = { type, startLine: ann.startLine, violations: [], warnings: [] };

  // §7.2 — unknown types are tolerated
  if (!KNOWN_TYPES.has(type)) {
    results.warnings.push(`Unknown annotation type '${type}' — tolerated per §7.2`);
    return results;
  }

  // §3.2 — completion sentinel check
  const sentinel = completionSentinelFor(type);
  const hasCompletion = sentinel.test(body);
  const hasPartial = new RegExp(`<!--\\s*${type.replace(":", "\\:")}:PARTIAL\\s*-->`).test(body);

  if (!hasCompletion) {
    if (hasPartial) {
      results.warnings.push(`Partial sentinel present — producer was interrupted (§3.3)`);
    } else {
      results.violations.push(`Missing completion sentinel (expected per §3.2)`);
    }
  }

  // Per-type field validation
  const validator = TYPE_VALIDATORS[type];
  if (validator) {
    results.violations.push(...validator(body));
  }

  return results;
}

// ── Input parsing ─────────────────────────────────────────────────────────────

function parseInput(raw) {
  // Try JSON array of comment body strings
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.map(String);
    } catch (_) { /* fall through */ }
  }
  // Single JSON string
  if (trimmed.startsWith('"')) {
    try { return [JSON.parse(trimmed)]; } catch (_) { /* fall through */ }
  }
  // Raw text — treat as single comment body
  return [raw];
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let raw;

try {
  if (args.length === 0 || args[0] === "-") {
    raw = readFileSync("/dev/stdin", "utf8");
  } else {
    raw = readFileSync(args[0], "utf8");
  }
} catch (e) {
  console.error(`conformance-check: cannot read input — ${e.message}`);
  process.exit(2);
}

const commentBodies = parseInput(raw);
if (!commentBodies.length) {
  console.error("conformance-check: no comment bodies to validate");
  process.exit(2);
}

let totalAnnotations = 0;
let totalViolations = 0;
let totalWarnings = 0;

for (const [idx, body] of commentBodies.entries()) {
  const annotations = extractAnnotations(body);
  if (!annotations.length) continue;

  for (const ann of annotations) {
    totalAnnotations++;
    const result = checkAnnotation(ann);

    const prefix = `[comment ${idx + 1}, line ${result.startLine}] FORGE:${result.type}`;

    if (result.violations.length === 0 && result.warnings.length === 0) {
      console.log(`PASS  ${prefix}`);
    } else {
      for (const v of result.violations) {
        console.error(`FAIL  ${prefix} — ${v}`);
        totalViolations++;
      }
      for (const w of result.warnings) {
        console.warn(`WARN  ${prefix} — ${w}`);
        totalWarnings++;
      }
    }
  }
}

console.log(`\nSummary: ${totalAnnotations} annotation(s), ${totalViolations} violation(s), ${totalWarnings} warning(s)`);

if (totalAnnotations === 0) {
  console.log("No FORGE annotations found in input.");
}

process.exit(totalViolations > 0 ? 1 : 0);
