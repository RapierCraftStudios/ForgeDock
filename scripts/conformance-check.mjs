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
 * Conformance rules:
 *   This script does NOT reimplement the FORGE Annotation Protocol parsing/validation
 *   rules itself. It delegates entirely to the spec reference implementation,
 *   `@forgedock/protocol` (packages/protocol/src/{parse,validate,types}.js), which
 *   implements §3.1 (opening tag format), §3.2 (completion sentinels), §3.3 (partial
 *   sentinels), §4.x (per-type required fields and enum values), and §7.2 (tolerant
 *   handling of unknown/unreserved annotation types). Delegating avoids a second,
 *   independently-drifting parser (see #1521 — a prior standalone regex here diverged
 *   from the library and rejected valid `TYPE:COMPLETE` sentinels as new annotations).
 */

import { readFileSync } from "fs";
import { parse, validate } from "../packages/protocol/src/index.js";

// ── Line-number recovery ──────────────────────────────────────────────────────
//
// parse() returns ParsedAnnotation objects ({ type, raw, body, ... }) without a
// line number — it only needs character-level text, not position, for its own
// purposes. This script's console output has always reported a 1-indexed line
// number per annotation, so we recover it here by matching each annotation's
// opening-tag line against the original comment body, scanning forward from the
// end of the previous match. Annotations are contiguous in the source (parse()
// assigns every line from an opening tag onward to that annotation until the
// next true opening tag), so a single forward-scanning pass is sufficient.
function withStartLines(commentBody, annotations) {
  const lines = commentBody.split("\n");
  let searchFrom = 0;
  return annotations.map((ann) => {
    const openingLine = ann.raw.split("\n")[0];
    let idx = lines.indexOf(openingLine, searchFrom);
    if (idx === -1) idx = searchFrom;
    searchFrom = idx + 1;
    return { ...ann, startLine: idx + 1 };
  });
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
  const parsed = parse(body);
  if (!parsed.length) continue;

  const annotations = withStartLines(body, parsed);

  for (const ann of annotations) {
    totalAnnotations++;
    const { errors, warnings } = validate(ann);

    const prefix = `[comment ${idx + 1}, line ${ann.startLine}] FORGE:${ann.type}`;

    if (errors.length === 0 && warnings.length === 0) {
      console.log(`PASS  ${prefix}`);
    } else {
      for (const v of errors) {
        console.error(`FAIL  ${prefix} — ${v}`);
        totalViolations++;
      }
      for (const w of warnings) {
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
