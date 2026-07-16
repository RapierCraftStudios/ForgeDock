#!/usr/bin/env node
/**
 * forge-protocol-conformance / forge-protocol CLI
 *
 * Subcommands:
 *
 *   emit <TYPE> [--field KEY=VALUE]... [--b64]
 *     Emits a well-formed FORGE annotation body to stdout.
 *     Each --field KEY=VALUE pair is passed to emit() as a field.
 *     --b64  Produces the Base64url machine-surface form:
 *            <!-- FORGE:CARD: v1 sha:<sha8hex> b64:<base64url> -->
 *            (only valid for CARD type; TYPE is ignored when --b64 is passed)
 *     Exit code: 0 on success, 1 on error.
 *
 *   parse [--type TYPE] [--field KEY]
 *     Reads a comment body from stdin.
 *     --type TYPE  If given, filters to annotations of that type (case-insensitive).
 *                  If absent, operates on the first annotation found.
 *     --field KEY  If given, prints only the named field value (or inlineValue for
 *                  inline-value types). Exits 1 if the field is missing.
 *                  If absent, prints the full annotation as JSON.
 *     Exit code: 0 on success, 1 if no matching annotation found or field missing.
 *
 *   [fixtures-dir]  (legacy positional — no subcommand keyword)
 *     Conformance runner: reads fixtures from the given directory (default: ./fixtures/).
 *     Exit code: 0 if all fixtures pass, 1 if any fail.
 *
 * Usage examples:
 *   node src/cli.js emit INVESTIGATOR \
 *     --field Verdict=CONFIRMED --field Confidence=HIGH \
 *     --field Severity=MEDIUM --field "Task Type=Bug Fix" \
 *     --field "Decomposition Assessment=NO — simple."
 *
 *   echo '<!-- FORGE:INVESTIGATOR -->...' | \
 *     node src/cli.js parse --type INVESTIGATOR --field Verdict
 *
 *   node src/cli.js                    # conformance runner (legacy)
 *   node src/cli.js fixtures/          # conformance runner with explicit dir
 *
 * @license MIT
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from './parse.js';
import { validate } from './validate.js';
import { emit } from './emit.js';

// ---------------------------------------------------------------------------
// Argv routing
//
// If argv[2] is a known subcommand keyword ('emit' or 'parse'), route to the
// corresponding handler. Otherwise fall through to the legacy conformance
// runner (argv[2] is either a fixtures directory path or absent).
// ---------------------------------------------------------------------------

const SUBCOMMANDS = new Set(['emit', 'parse']);
const args = process.argv.slice(2);
const subcommand = args[0];

if (SUBCOMMANDS.has(subcommand)) {
  if (subcommand === 'emit') {
    cmdEmit(args.slice(1));
  } else {
    cmdParse(args.slice(1));
  }
} else {
  // Legacy conformance runner: forward the full argv slice so the directory
  // positional (if any) is still at index 0 of the slice passed in.
  cmdConformance(args);
}

// ---------------------------------------------------------------------------
// emit subcommand
// ---------------------------------------------------------------------------

function cmdEmit(argv) {
  let type = null;
  const fields = {};
  let b64 = false;
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--field' || arg === '-f') {
      if (i + 1 >= argv.length) {
        die('--field requires KEY=VALUE');
      }
      const pair = argv[++i];
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) {
        die(`--field value must be KEY=VALUE, got: ${JSON.stringify(pair)}`);
      }
      const key = pair.slice(0, eqIdx);
      const val = pair.slice(eqIdx + 1);
      fields[key] = val;
    } else if (arg === '--b64') {
      b64 = true;
    } else if (!type && !arg.startsWith('-')) {
      type = arg;
    } else {
      die(`Unknown argument: ${JSON.stringify(arg)}`);
    }
    i++;
  }

  if (!type && !b64) {
    die('Usage: emit <TYPE> [--field KEY=VALUE]... [--b64]');
  }

  if (b64) {
    // Base64url machine-surface form for CARD (design decision 2026-07-08).
    // Payload: canonical JSON (sorted keys, single line, UTF-8).
    // The Base64url alphabet [A-Za-z0-9_-] cannot contain '>', '<', or '!' —
    // so -->, --!>, and <!-- are structurally unrepresentable by construction.
    const payload = Object.keys(fields).length > 0 ? { ...fields } : {};
    if (type) payload.type = type.toUpperCase();
    const canonical = canonicalJson(payload);
    const b64url = toBase64url(canonical);
    const sha8 = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 8);
    // The colon-separator form "<!-- FORGE:CARD: v1 sha:X b64:Y -->" matches
    // OPENING_TAG_RE so parse() can extract the inline value "v1 sha:X b64:Y".
    // This keeps the canonical FORGE inline-value syntax (§3.4) while adding
    // the sha8 integrity prefix and Base64url payload from the design decision.
    process.stdout.write(`<!-- FORGE:CARD: v1 sha:${sha8} b64:${b64url} -->\n`);
    return;
  }

  let output;
  try {
    output = emit(type, fields);
  } catch (err) {
    die(err.message);
  }

  process.stdout.write(output + '\n');
}

// ---------------------------------------------------------------------------
// parse subcommand
// ---------------------------------------------------------------------------

function cmdParse(argv) {
  let filterType = null;
  let filterField = null;
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--type' || arg === '-t') {
      if (i + 1 >= argv.length) die('--type requires a value');
      filterType = argv[++i].toUpperCase();
    } else if (arg === '--field' || arg === '-f') {
      if (i + 1 >= argv.length) die('--field requires a value');
      filterField = argv[++i];
    } else {
      die(`Unknown argument: ${JSON.stringify(arg)}`);
    }
    i++;
  }

  // Read stdin. Use readFileSync(0) (fd 0) instead of '/dev/stdin' — the POSIX
  // path does not exist on Windows (ENOENT, exit 2). See fix in #1594.
  let body;
  try {
    body = readFileSync(0, 'utf8');
  } catch (err) {
    die(`Failed to read stdin: ${err.message}`);
  }

  const annotations = parse(body);
  if (annotations.length === 0) {
    die('No FORGE annotations found in stdin');
  }

  let ann;
  if (filterType) {
    ann = annotations.find(a => a.type === filterType);
    if (!ann) {
      die(`No annotation of type "${filterType}" found`);
    }
  } else {
    ann = annotations[0];
  }

  // CARD Base64url machine-surface: decode the b64 payload and return its fields.
  if (ann.type === 'CARD' && ann.inlineValue) {
    const decoded = decodeCardInlineValue(ann.inlineValue);
    if (decoded !== null) {
      if (filterField) {
        const val = decoded[filterField];
        if (val === undefined) {
          die(`Field "${filterField}" not found in CARD payload`);
        }
        process.stdout.write(String(val) + '\n');
      } else {
        process.stdout.write(JSON.stringify({ type: 'CARD', payload: decoded }, null, 2) + '\n');
      }
      return;
    }
    // Fall through to generic inline-value handling if the CARD format is unrecognized.
  }

  if (filterField) {
    // For inline-value annotations, 'value' or 'inlineValue' accesses the value.
    if (ann.inlineValue !== null) {
      if (filterField === 'value' || filterField === 'inlineValue') {
        process.stdout.write(ann.inlineValue + '\n');
        return;
      }
      die(
        `Annotation "${ann.type}" is an inline-value type; ` +
        `only field name "value" or "inlineValue" is available (got "${filterField}")`,
      );
    }
    const val = ann.fields[filterField];
    if (val === undefined) {
      die(`Field "${filterField}" not found in annotation "${ann.type}"`);
    }
    process.stdout.write(val + '\n');
  } else {
    // Output full annotation as JSON.
    const out = {
      type: ann.type,
      sentinelState: ann.sentinelState,
      isReserved: ann.isReserved,
      isControl: ann.isControl,
      inlineValue: ann.inlineValue,
      fields: ann.fields,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  }
}

// ---------------------------------------------------------------------------
// Conformance runner (legacy — no subcommand keyword)
// ---------------------------------------------------------------------------

function cmdConformance(argv) {
  const fixturesDir = resolve(argv[0] ?? 'fixtures');

  let passed = 0;
  let failed = 0;
  const failures = [];

  let files;
  try {
    files = readdirSync(fixturesDir).filter(f => extname(f) === '.json').sort();
  } catch (err) {
    console.error(`Cannot read fixtures directory: ${fixturesDir}`);
    console.error(err.message);
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(`No .json fixtures found in ${fixturesDir}`);
    process.exit(1);
  }

  for (const file of files) {
    const fixturePath = resolve(fixturesDir, file);
    let fixture;
    try {
      fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    } catch (err) {
      console.error(`SKIP  ${file} — cannot parse JSON: ${err.message}`);
      continue;
    }

    const { description, input, expect: expected } = fixture;
    const label = `${file}: ${description ?? '(no description)'}`;

    if (typeof input !== 'string') {
      console.error(`SKIP  ${label} — "input" must be a string`);
      continue;
    }

    const annotations = parse(input);

    // Find the annotation matching the expected type
    const ann = annotations.find(a => a.type === expected.type);

    const fixtureErrors = [];

    if (!ann) {
      fixtureErrors.push(`Expected annotation type "${expected.type}" not found in parsed output`);
    } else {
      // Sentinel state check
      if (expected.sentinelState !== undefined && ann.sentinelState !== expected.sentinelState) {
        fixtureErrors.push(
          `sentinelState: expected "${expected.sentinelState}", got "${ann.sentinelState}"`,
        );
      }

      // Inline value check
      if ('inlineValue' in expected) {
        if (ann.inlineValue !== expected.inlineValue) {
          fixtureErrors.push(
            `inlineValue: expected ${JSON.stringify(expected.inlineValue)}, got ${JSON.stringify(ann.inlineValue)}`,
          );
        }
      }

      // Field checks
      if (expected.fieldChecks) {
        for (const [key, val] of Object.entries(expected.fieldChecks)) {
          if (ann.fields[key] !== val) {
            fixtureErrors.push(
              `field "${key}": expected "${val}", got "${ann.fields[key] ?? '(missing)'}"`,
            );
          }
        }
      }

      // validate() result check
      const { valid, errors } = validate(ann);
      if (expected.valid === true && !valid) {
        fixtureErrors.push(`Expected valid=true but got errors: ${errors.join('; ')}`);
      } else if (expected.valid === false && valid) {
        fixtureErrors.push(`Expected valid=false but annotation passed validation`);
      }
    }

    if (fixtureErrors.length === 0) {
      console.log(`ok    ${label}`);
      passed++;
    } else {
      console.log(`FAIL  ${label}`);
      for (const e of fixtureErrors) {
        console.log(`        ${e}`);
      }
      failures.push(label);
      failed++;
    }
  }

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed (${files.length} fixtures total)`);

  if (failed > 0) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg) {
  process.stderr.write(`forge-protocol-cli: ${msg}\n`);
  process.exit(1);
}

/**
 * Produce canonical JSON: sorted keys, single line, UTF-8.
 * This is the payload that gets Base64url-encoded in the CARD format.
 */
function canonicalJson(obj) {
  return JSON.stringify(sortKeysDeep(obj));
}

function sortKeysDeep(val) {
  if (Array.isArray(val)) return val.map(sortKeysDeep);
  if (val !== null && typeof val === 'object') {
    return Object.fromEntries(
      Object.keys(val)
        .sort()
        .map(k => [k, sortKeysDeep(val[k])]),
    );
  }
  return val;
}

/**
 * Encode a UTF-8 string as Base64url (URL-safe alphabet, no padding).
 * The Base64url alphabet [A-Za-z0-9_-] cannot contain '>', '<', or '!' —
 * so -->, --!>, and <!-- are structurally unrepresentable by construction
 * (design decision 2026-07-08: encoding beats escaping).
 *
 * @param {string} str — UTF-8 string to encode
 * @returns {string} Base64url-encoded string without padding
 */
function toBase64url(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Decode a CARD inline value of the form "v1 sha:<sha8hex> b64:<base64url>"
 * and return the parsed JSON object, or null if the format is unrecognized.
 * Verifies the sha8 integrity prefix; returns null on corruption or tampering.
 *
 * @param {string} inlineValue — the parsed inlineValue from a CARD annotation
 * @returns {object|null}
 */
function decodeCardInlineValue(inlineValue) {
  const m = inlineValue.match(/^v1\s+sha:([0-9a-f]{8})\s+b64:([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const [, sha8, b64url] = m;

  // Restore standard Base64 padding and swap the URL-safe alphabet back.
  const b64std = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64std + '='.repeat((4 - (b64std.length % 4)) % 4);

  let canonical;
  try {
    canonical = Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }

  // Integrity check: first 8 hex chars of SHA-256 must match the prefix.
  const expectedSha8 = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 8);
  if (expectedSha8 !== sha8) return null;

  try {
    return JSON.parse(canonical);
  } catch {
    return null;
  }
}
