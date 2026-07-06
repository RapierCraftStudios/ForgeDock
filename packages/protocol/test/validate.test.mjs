/**
 * Tests for @forgedock/protocol validate()
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parse.js';
import { validate } from '../src/validate.js';
import { SentinelState } from '../src/types.js';

function parseOne(body, type) {
  return parse(body).find(a => a.type === type);
}

test('validate: throws on non-object input', () => {
  assert.throws(() => validate(null), TypeError);
  assert.throws(() => validate('string'), TypeError);
});

test('validate: valid INVESTIGATOR passes', () => {
  const ann = parseOne(
    `<!-- FORGE:INVESTIGATOR -->\n**Verdict**: CONFIRMED\n**Confidence**: HIGH\n**Severity**: MEDIUM\n**Task Type**: Bug Fix\n**Decomposition Assessment**: NO — single fix.\n<!-- INVESTIGATION:COMPLETE -->`,
    'INVESTIGATOR',
  );
  const { valid, errors } = validate(ann);
  assert.equal(valid, true, `Expected valid but got errors: ${errors.join(', ')}`);
});

test('validate: INVESTIGATOR missing sentinel → invalid', () => {
  const ann = parseOne(
    `<!-- FORGE:INVESTIGATOR -->\n**Verdict**: CONFIRMED\n**Confidence**: HIGH\n**Severity**: LOW\n**Task Type**: Feature\n**Decomposition Assessment**: NO — simple.`,
    'INVESTIGATOR',
  );
  const { valid, errors } = validate(ann);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('completion sentinel')));
});

test('validate: INVESTIGATOR invalid Verdict → invalid', () => {
  const ann = parseOne(
    `<!-- FORGE:INVESTIGATOR -->\n**Verdict**: MAYBE\n**Confidence**: HIGH\n**Severity**: LOW\n**Task Type**: Bug Fix\n**Decomposition Assessment**: NO.\n<!-- INVESTIGATION:COMPLETE -->`,
    'INVESTIGATOR',
  );
  const { valid, errors } = validate(ann);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('Verdict')));
});

test('validate: INVESTIGATOR invalid Confidence → invalid', () => {
  const ann = parseOne(
    `<!-- FORGE:INVESTIGATOR -->\n**Verdict**: CONFIRMED\n**Confidence**: SURE\n**Severity**: LOW\n**Task Type**: Bug Fix\n**Decomposition Assessment**: NO.\n<!-- INVESTIGATION:COMPLETE -->`,
    'INVESTIGATOR',
  );
  const { valid, errors } = validate(ann);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('Confidence')));
});

test('validate: INVESTIGATOR missing required fields → invalid', () => {
  const ann = parseOne(
    `<!-- FORGE:INVESTIGATOR -->\n**Verdict**: CONFIRMED\n<!-- INVESTIGATION:COMPLETE -->`,
    'INVESTIGATOR',
  );
  const { valid, errors } = validate(ann);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('Confidence')));
  assert.ok(errors.some(e => e.includes('Severity')));
});

test('validate: CONTEXT partial → invalid with warning', () => {
  const ann = parseOne(
    `<!-- FORGE:CONTEXT -->\nSome context.\n<!-- FORGE:CONTEXT:PARTIAL -->`,
    'CONTEXT',
  );
  const { valid, warnings } = validate(ann);
  assert.equal(valid, false);
  assert.ok(warnings.some(w => w.includes('PARTIAL')));
});

test('validate: CONTEXT complete → valid', () => {
  const ann = parseOne(
    `<!-- FORGE:CONTEXT -->\nSome context.\n<!-- FORGE:CONTEXT:COMPLETE -->`,
    'CONTEXT',
  );
  const { valid } = validate(ann);
  assert.equal(valid, true);
});

test('validate: BUILDER missing Branch field → invalid', () => {
  const ann = parseOne(
    `<!-- FORGE:BUILDER -->\n**Commits**: abc123\n**Files changed**: 1\n<!-- FORGE:BUILDER:COMPLETE -->`,
    'BUILDER',
  );
  const { valid, errors } = validate(ann);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('Branch')));
});

test('validate: KNOWLEDGE_GIST with non-empty value → valid', () => {
  const ann = parseOne(
    `<!-- FORGE:KNOWLEDGE_GIST: https://example.com/gist -->`,
    'KNOWLEDGE_GIST',
  );
  const { valid } = validate(ann);
  assert.equal(valid, true);
});

test('validate: KNOWLEDGE_GIST with empty value → invalid', () => {
  const ann = parseOne(
    `<!-- FORGE:KNOWLEDGE_GIST:  -->`,
    'KNOWLEDGE_GIST',
  );
  const { valid, errors } = validate(ann);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('non-empty value')));
});

test('validate: REVIEW_STARTED control marker → valid', () => {
  const ann = parseOne(`<!-- FORGE:REVIEW_STARTED -->`, 'REVIEW_STARTED');
  const { valid } = validate(ann);
  assert.equal(valid, true);
});

test('validate: GATE_FAILED control marker → valid', () => {
  const ann = parseOne(`<!-- FORGE:GATE_FAILED -->`, 'GATE_FAILED');
  const { valid } = validate(ann);
  assert.equal(valid, true);
});

test('validate: unknown type is tolerated → valid with warning (§7.2.4)', () => {
  const ann = parseOne(
    `<!-- FORGE:VENDOR_CUSTOM -->\nSome content.`,
    'VENDOR_CUSTOM',
  );
  const { valid, warnings } = validate(ann);
  assert.equal(valid, true);
  assert.ok(warnings.some(w => w.includes('not a reserved type')));
});

test('validate: REVIEWER with invalid Verdict → invalid', () => {
  const ann = parseOne(
    `<!-- FORGE:REVIEWER -->\n**Verdict**: REJECTED`,
    'REVIEWER',
  );
  const { valid, errors } = validate(ann);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('Verdict')));
});

test('validate: REVIEWER with valid CHANGES_REQUESTED verdict → valid', () => {
  const ann = parseOne(
    `<!-- FORGE:REVIEWER -->\n**Verdict**: CHANGES_REQUESTED\n\n### Findings\nFound issues.`,
    'REVIEWER',
  );
  const { valid } = validate(ann);
  assert.equal(valid, true);
});

test('validate: CONTRACT missing Task type → invalid', () => {
  const ann = parseOne(
    `<!-- FORGE:CONTRACT -->\n### Proposed Approach\nSome approach.`,
    'CONTRACT',
  );
  const { valid, errors } = validate(ann);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('Task type')));
});
