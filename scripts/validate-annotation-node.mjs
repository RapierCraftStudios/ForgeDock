#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: MIT
//
// validate-annotation-node.mjs — Thin Node.js adapter: validates FORGE annotation bodies
// against the MIT/Apache protocol validation library (packages/protocol/, built in #1291).
//
// This script is the dogfooding consumer for the protocol library (#1291), satisfying
// the requirement from #1292. It wraps the library's validate() API with:
//   - Graceful degradation when the library is not yet installed (exits 0 with WARN)
//   - A stable CLI that matches forge-annotation.sh validate's argument shape,
//     so future forge-annotation.sh validate integration (#1267) is a one-line shim
//   - MIT license: this file is NOT AGPL — it must remain importable by MIT/Apache
//     consumers without license contamination. Do not import AGPL modules here.
//
// Usage:
//   node scripts/validate-annotation-node.mjs <MARKER> [FILE]
//   echo '<!-- FORGE:INVESTIGATOR -->...' | node scripts/validate-annotation-node.mjs INVESTIGATOR
//
// Arguments:
//   MARKER  Annotation type to validate (e.g. INVESTIGATOR, CONTRACT, BUILDER).
//           May include the FORGE: prefix — it will be stripped automatically.
//   FILE    Path to a file containing the annotation body. If omitted (or '-'),
//           reads from stdin.
//
// Exit codes:
//   0 = annotation is well-formed, OR library is not yet installed (graceful degradation)
//   1 = annotation is malformed (library reports a conformance error)
//   2 = usage/argument error (bad MARKER, unreadable FILE, etc.)
//
// Integration notes:
//   - When packages/protocol/ (issue #1291) is built and published, this script will
//     work without any changes. The dynamic import path resolves relative to this script.
//   - When forge-annotation.sh (issue #1267) is merged, its `validate` subcommand can
//     shell out to this script for conformance checks: the Bash side handles sentinel
//     and structure (AGPL, format rules), the Node side handles spec conformance (MIT).
//   - Call-site wiring in commands/*.md is tracked separately in #1247.

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_NAME = 'validate-annotation-node.mjs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
function usage() {
  process.stderr.write(
    `Usage:\n` +
    `  ${SCRIPT_NAME} <MARKER> [FILE]\n` +
    `  echo '<body>' | ${SCRIPT_NAME} <MARKER>\n` +
    `\n` +
    `Arguments:\n` +
    `  MARKER  Annotation type (e.g. INVESTIGATOR, FORGE:INVESTIGATOR, CONTRACT, BUILDER)\n` +
    `  FILE    File containing the annotation body (reads stdin if omitted or '-')\n` +
    `\n` +
    `Exit codes:\n` +
    `  0  Valid annotation, or library not yet installed (graceful degradation)\n` +
    `  1  Invalid annotation (library conformance check failed)\n` +
    `  2  Usage/argument error\n`
  );
}

// ---------------------------------------------------------------------------
// Normalize marker: strip FORGE: prefix, uppercase
// Mirrors forge-annotation.sh normalize_marker() so both tools agree on marker names.
// ---------------------------------------------------------------------------
function normalizeMarker(raw) {
  return raw.toUpperCase().replace(/^FORGE:/, '');
}

// ---------------------------------------------------------------------------
// Read body from file path or stdin
// ---------------------------------------------------------------------------
async function readBody(fileArg) {
  if (!fileArg || fileArg === '-') {
    // Read from stdin
    return new Promise((resolve, reject) => {
      const chunks = [];
      process.stdin.on('data', (chunk) => chunks.push(chunk));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', reject);
    });
  }

  if (!existsSync(fileArg)) {
    process.stderr.write(`ERROR: file not found: ${fileArg}\n`);
    process.exit(2);
  }

  try {
    return readFileSync(fileArg, 'utf8');
  } catch (err) {
    process.stderr.write(`ERROR: cannot read file '${fileArg}': ${err.message}\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Locate the protocol library
// Library expected at packages/protocol/src/index.js relative to the repo
// root (per packages/protocol/package.json main/exports).
// Repo root is two directories above this script (scripts/ → repo root).
// ---------------------------------------------------------------------------
function resolveLibraryPath() {
  const repoRoot = resolve(__dirname, '..');
  return resolve(repoRoot, 'packages', 'protocol', 'src', 'index.js');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    usage();
    process.exit(args.length === 0 ? 2 : 0);
  }

  const markerRaw = args[0];
  const fileArg = args[1] || null;
  const marker = normalizeMarker(markerRaw);

  if (!marker || !/^[A-Z_]+$/.test(marker)) {
    process.stderr.write(`ERROR: invalid MARKER '${markerRaw}' — must be a non-empty string (letters and underscores only after prefix stripping)\n`);
    usage();
    process.exit(2);
  }

  const body = await readBody(fileArg);

  if (!body.trim()) {
    process.stderr.write(`ERROR: annotation body is empty — nothing to validate\n`);
    process.exit(2);
  }

  // ---------------------------------------------------------------------------
  // Attempt to load the protocol library (graceful degradation if absent)
  // ---------------------------------------------------------------------------
  const libraryPath = resolveLibraryPath();

  if (!existsSync(libraryPath)) {
    // Library not yet built (#1291 not merged) — exit 0 with a warning.
    // This is the expected state until #1291 lands; the pipeline must not break.
    process.stdout.write(
      `WARN: forge-protocol library not found at packages/protocol/src/index.js\n` +
      `  Conformance validation skipped — install the library from #1291 to enable spec-conformance checks.\n` +
      `  Annotation posting will proceed without library validation.\n`
    );
    process.exit(0);
  }

  let library;
  try {
    // Dynamic import() requires a file:// URL for absolute paths on Windows
    // (a bare "C:\..." path is misparsed as a URL with protocol "c:"). Using
    // pathToFileURL() makes this work identically on Windows and POSIX.
    library = await import(pathToFileURL(libraryPath));
  } catch (err) {
    // Library file exists but failed to load — log and degrade gracefully.
    process.stdout.write(
      `WARN: forge-protocol library found at packages/protocol/src/index.js but failed to load: ${err.message}\n` +
      `  Conformance validation skipped. Check that the library is built correctly.\n`
    );
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // Parse the body into a structured annotation, then call library.validate().
  // The library's validate() expects a ParsedAnnotation (the output of parse()),
  // NOT a raw { type, body } literal — validate() reads annotation.isReserved,
  // .fields, .sentinelState, etc., all of which only exist after parse() runs.
  // Passing an unparsed literal makes validate() take its "unknown type, tolerate"
  // early-return path (§7.2.4) and always report { valid: true }, silently
  // skipping every real conformance check.
  // ---------------------------------------------------------------------------
  if (typeof library.parse !== 'function' || typeof library.validate !== 'function') {
    process.stderr.write(
      `ERROR: forge-protocol library does not export the expected 'parse' and 'validate' functions.\n` +
      `  Found exports: ${Object.keys(library).join(', ') || '(none)'}\n`
    );
    process.exit(2);
  }

  let annotation;
  try {
    const parsed = library.parse(body);
    annotation = parsed.find((a) => a.type === marker);
  } catch (err) {
    process.stderr.write(`ERROR: library.parse() threw an exception: ${err.message}\n`);
    process.exit(1);
  }

  if (!annotation) {
    process.stderr.write(
      `ERROR: no '${marker}' annotation found in the provided body — expected an opening tag ` +
      `like <!-- FORGE:${marker} --> somewhere in the input.\n`
    );
    process.exit(2);
  }

  let result;
  try {
    result = library.validate(annotation);
  } catch (err) {
    process.stderr.write(`ERROR: library.validate() threw an exception: ${err.message}\n`);
    process.exit(1);
  }

  if (result && result.valid === true) {
    process.stdout.write(`OK: '${marker}' annotation is well-formed (forge-protocol conformance check passed)\n`);
    process.exit(0);
  } else {
    const errors = (result && Array.isArray(result.errors) && result.errors.length > 0)
      ? result.errors.join('\n  - ')
      : 'no error details returned by library';
    process.stderr.write(
      `ERROR: '${marker}' annotation failed forge-protocol conformance check:\n` +
      `  - ${errors}\n`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err.message}\n`);
  process.exit(2);
});
