/**
 * Tests for @forgedock/protocol context-pack schema/validator
 * (packages/protocol/src/contextpack-schema.js — forge#2700).
 *
 * Covers the required test matrix from the acceptance criteria: a valid
 * pack, a pack missing a required field, a pack with the wrong
 * schema_version, and a pack that hit a size cap and was truncated.
 *
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION,
  PACK_SLICE_NAMES,
  MAX_PACK_BYTES,
  MAX_SLICE_BYTES,
  MAX_SLICES,
  TRUNCATED_FIELD,
  validateContextPack,
} from '../src/contextpack-schema.js';

function validPack(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    issue: 2700,
    slices: [{ phase: 'investigate', content: 'root cause: ...' }],
    ...overrides,
  };
}

test('contextpack-schema: SCHEMA_VERSION and PACK_SLICE_NAMES are exported and well-formed', () => {
  assert.equal(typeof SCHEMA_VERSION, 'number');
  assert.ok(Array.isArray(PACK_SLICE_NAMES));
  assert.ok(PACK_SLICE_NAMES.includes('investigate'));
  assert.ok(PACK_SLICE_NAMES.includes('build'));
  assert.ok(PACK_SLICE_NAMES.includes('review'));
});

test('contextpack-schema: validateContextPack accepts a well-formed pack', () => {
  const result = validateContextPack(validPack());
  assert.deepEqual(result, { valid: true, errors: [], truncated: false });
});

test('contextpack-schema: validateContextPack accepts a pack with multiple valid slices', () => {
  const pack = validPack({
    slices: [
      { phase: 'investigate', content: 'a' },
      { phase: 'build', content: 'b' },
      { phase: 'review', content: 'c' },
    ],
  });
  const result = validateContextPack(pack);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('contextpack-schema: validateContextPack rejects a pack missing a required field ("issue")', () => {
  const pack = validPack();
  delete pack.issue;
  const result = validateContextPack(pack);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('issue')));
});

test('contextpack-schema: validateContextPack rejects a pack missing "schema_version"', () => {
  const pack = validPack();
  delete pack.schema_version;
  const result = validateContextPack(pack);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('schema_version')));
});

test('contextpack-schema: validateContextPack rejects a pack missing "slices"', () => {
  const pack = validPack();
  delete pack.slices;
  const result = validateContextPack(pack);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('slices')));
});

test('contextpack-schema: validateContextPack rejects wrong schema_version with a distinct message from "missing"', () => {
  const pack = validPack({ schema_version: SCHEMA_VERSION + 1 });
  const result = validateContextPack(pack);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Unsupported schema_version')));
  assert.ok(!result.errors.some((e) => e.includes('Missing required field "schema_version"')));
});

test('contextpack-schema: validateContextPack rejects wrong-type fields without throwing', () => {
  const pack = validPack({ schema_version: '1', issue: 'not-a-number', slices: 'not-an-array' });
  const result = validateContextPack(pack);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 3);
});

test('contextpack-schema: validateContextPack rejects a slice with an unrecognized phase name', () => {
  const pack = validPack({ slices: [{ phase: 'nonexistent-phase', content: 'x' }] });
  const result = validateContextPack(pack);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('nonexistent-phase')));
});

test('contextpack-schema: validateContextPack rejects an oversized slice with no truncation marker', () => {
  const oversized = 'x'.repeat(MAX_SLICE_BYTES + 1);
  const pack = validPack({ slices: [{ phase: 'build', content: oversized }] });
  const result = validateContextPack(pack);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('MAX_SLICE_BYTES')));
});

test('contextpack-schema: validateContextPack accepts an oversized slice explicitly marked truncated', () => {
  const oversized = 'x'.repeat(MAX_SLICE_BYTES + 1);
  const pack = validPack({
    slices: [{ phase: 'build', content: oversized, [TRUNCATED_FIELD]: true }],
  });
  const result = validateContextPack(pack);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('contextpack-schema: validateContextPack rejects a whole pack over MAX_PACK_BYTES with no truncation marker', () => {
  // Build a pack whose slices individually respect MAX_SLICE_BYTES but whose
  // combined serialized size exceeds MAX_PACK_BYTES.
  const chunk = 'x'.repeat(MAX_SLICE_BYTES - 200);
  const pack = validPack({
    slices: [
      { phase: 'investigate', content: chunk },
      { phase: 'build', content: chunk },
      { phase: 'review', content: chunk },
    ],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(pack), 'utf8') > MAX_PACK_BYTES);
  const result = validateContextPack(pack);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('MAX_PACK_BYTES')));
});

test('contextpack-schema: validateContextPack accepts a whole pack over MAX_PACK_BYTES explicitly marked truncated', () => {
  const chunk = 'x'.repeat(MAX_SLICE_BYTES - 200);
  const pack = validPack({
    slices: [
      { phase: 'investigate', content: chunk },
      { phase: 'build', content: chunk },
      { phase: 'review', content: chunk },
    ],
    [TRUNCATED_FIELD]: true,
  });
  const result = validateContextPack(pack);
  assert.equal(result.valid, true);
  assert.equal(result.truncated, true);
});

test('contextpack-schema: validateContextPack rejects a pack whose slices array exceeds MAX_SLICES, without requiring oversized content', () => {
  // Every slice here is trivially small and individually well within
  // MAX_SLICE_BYTES — only the *count* of slices is invalid. This proves the
  // MAX_SLICES cap fires on its own, independent of MAX_PACK_BYTES/MAX_SLICE_BYTES.
  const slices = Array.from({ length: MAX_SLICES + 1 }, (_, i) => ({
    phase: 'investigate',
    content: `slice-${i}`,
  }));
  const pack = validPack({ slices });
  const result = validateContextPack(pack);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('MAX_SLICES')));
});

test('contextpack-schema: validateContextPack accepts a pack with exactly MAX_SLICES slices', () => {
  const slices = Array.from({ length: MAX_SLICES }, (_, i) => ({
    phase: 'investigate',
    content: `slice-${i}`,
  }));
  const pack = validPack({ slices });
  const result = validateContextPack(pack);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('contextpack-schema: validateContextPack throws TypeError for non-object input', () => {
  assert.throws(() => validateContextPack(null), TypeError);
  assert.throws(() => validateContextPack(undefined), TypeError);
  assert.throws(() => validateContextPack('a string'), TypeError);
  assert.throws(() => validateContextPack([]), TypeError);
  assert.throws(() => validateContextPack(42), TypeError);
});

test('contextpack-schema: validateContextPack never throws for malformed-but-object pack content', () => {
  assert.doesNotThrow(() => validateContextPack({}));
  assert.doesNotThrow(() => validateContextPack({ schema_version: null, issue: null, slices: null }));
  assert.doesNotThrow(() => validateContextPack({ slices: [null, 1, 'x', []] }));
});
