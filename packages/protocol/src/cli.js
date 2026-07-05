#!/usr/bin/env node
/**
 * forge-protocol-conformance — FORGE Annotation Protocol conformance test runner.
 *
 * Usage:
 *   forge-protocol-conformance [fixtures-dir]
 *   node src/cli.js [fixtures-dir]
 *
 * Reads fixtures from the given directory (default: ./fixtures/).
 * Each fixture is a JSON file with:
 *   {
 *     "description": "human-readable test name",
 *     "input": "comment body string to parse",
 *     "expect": {
 *       "type": "INVESTIGATOR",
 *       "valid": true,
 *       "sentinelState": "complete",
 *       "inlineValue": null,
 *       "fieldChecks": { "Verdict": "CONFIRMED" }  // optional
 *     }
 *   }
 *
 * Exit code: 0 if all fixtures pass, 1 if any fail.
 *
 * @license MIT
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { parse } from './parse.js';
import { validate } from './validate.js';

const fixturesDir = resolve(process.argv[2] ?? 'fixtures');

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
