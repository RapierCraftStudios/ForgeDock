/**
 * Tests for @forgedock/protocol PHASE_RESULT_SCHEMAS / validatePhaseResult
 * (forge#2380 — schema-enforced report_result tool).
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE_IDS,
  PHASE_MARKERS,
  PHASE_RESULT_SCHEMAS,
  SOFT_SKIP_RESULT_PHASES,
  validatePhaseResult,
} from '../src/phases.js';
import { RESERVED_TYPES } from '../src/types.js';

test('PHASE_RESULT_SCHEMAS: every registered key is a member of PHASE_IDS', () => {
  for (const phaseId of Object.keys(PHASE_RESULT_SCHEMAS)) {
    assert.ok(PHASE_IDS.includes(phaseId), `"${phaseId}" is not in PHASE_IDS`);
  }
});

test('PHASE_RESULT_SCHEMAS: investigate.verdict enum matches RESERVED_TYPES.INVESTIGATOR.verdictValues (single-sourced)', () => {
  assert.deepEqual(
    PHASE_RESULT_SCHEMAS.investigate.properties.verdict.enum,
    RESERVED_TYPES.INVESTIGATOR.verdictValues,
  );
});

test('PHASE_RESULT_SCHEMAS: review.disposition enum matches RESERVED_TYPES.REVIEWER.verdictValues (single-sourced)', () => {
  assert.deepEqual(
    PHASE_RESULT_SCHEMAS.review.properties.disposition.enum,
    RESERVED_TYPES.REVIEWER.verdictValues,
  );
});

test('PHASE_RESULT_SCHEMAS: context/architect define no completion-strength field (forge#1669 — no partial/degraded success)', () => {
  for (const phaseId of ['context', 'architect']) {
    const schema = PHASE_RESULT_SCHEMAS[phaseId];
    assert.equal(schema.required.length, 0, `${phaseId} schema must not require any field`);
    for (const key of Object.keys(schema.properties)) {
      assert.equal(
        /status|complete|partial/.test(key.toLowerCase()),
        false,
        `unexpected completion-strength-like field "${key}" on ${phaseId} schema`,
      );
    }
  }
});

test('PHASE_RESULT_SCHEMAS: every registered entry declares additionalProperties: false (forge#2435 — model-facing schema must mirror the server-side closed key set validatePhaseResult() already enforces)', () => {
  for (const [phaseId, schema] of Object.entries(PHASE_RESULT_SCHEMAS)) {
    assert.equal(
      schema.additionalProperties,
      false,
      `PHASE_RESULT_SCHEMAS.${phaseId} must declare additionalProperties: false`,
    );
  }
});

test('validatePhaseResult: context/architect still accept an empty object after additionalProperties: false is added (forge#2435 — required-field behavior is untouched)', () => {
  assert.equal(validatePhaseResult('context', {}).valid, true);
  assert.equal(validatePhaseResult('architect', {}).valid, true);
});

test('validatePhaseResult: unregistered phase id is a no-op (nothing to enforce)', () => {
  const { valid, errors } = validatePhaseResult('not-a-real-phase', { anything: 'goes' });
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validatePhaseResult: non-object input is rejected for a registered phase', () => {
  const { valid, errors } = validatePhaseResult('build', 'not an object');
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('JSON object')));
});

test('validatePhaseResult: investigate — valid input passes', () => {
  const { valid, errors } = validatePhaseResult('investigate', {
    verdict: 'CONFIRMED',
    decompose: false,
    rootCause: 'root cause text',
  });
  assert.equal(valid, true, `Expected valid, got errors: ${errors.join(', ')}`);
});

test('validatePhaseResult: investigate — missing required field is rejected', () => {
  const { valid, errors } = validatePhaseResult('investigate', { verdict: 'CONFIRMED' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('"decompose"')));
});

test('validatePhaseResult: investigate — invalid verdict enum value is rejected', () => {
  const { valid, errors } = validatePhaseResult('investigate', {
    verdict: 'MAYBE',
    decompose: false,
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('verdict') && e.includes('MAYBE')));
});

test('validatePhaseResult: investigate — wrong type for decompose is rejected', () => {
  const { valid, errors } = validatePhaseResult('investigate', {
    verdict: 'CONFIRMED',
    decompose: 'yes',
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('"decompose"') && e.includes('boolean')));
});

test('validatePhaseResult: build — valid input passes', () => {
  const { valid, errors } = validatePhaseResult('build', {
    branch: 'fix/example-123',
    commits: ['abc1234', 'def5678'],
  });
  assert.equal(valid, true, `Expected valid, got errors: ${errors.join(', ')}`);
});

test('validatePhaseResult: build — non-array commits is rejected', () => {
  const { valid, errors } = validatePhaseResult('build', {
    branch: 'fix/example-123',
    commits: 'abc1234',
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('"commits"') && e.includes('array')));
});

test('validatePhaseResult: build — wrong-typed array item is rejected', () => {
  const { valid, errors } = validatePhaseResult('build', {
    branch: 'fix/example-123',
    commits: ['abc1234', 42],
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('commits[1]')));
});

test('validatePhaseResult: review — valid input passes', () => {
  const { valid, errors } = validatePhaseResult('review', { pr: 2380, disposition: 'APPROVED' });
  assert.equal(valid, true, `Expected valid, got errors: ${errors.join(', ')}`);
});

test('validatePhaseResult: review — invalid disposition enum value is rejected', () => {
  const { valid, errors } = validatePhaseResult('review', { pr: 2380, disposition: 'MAYBE' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('disposition')));
});

test('validatePhaseResult: close — valid input passes', () => {
  const { valid } = validatePhaseResult('close', { merged: true });
  assert.equal(valid, true);
});

test('validatePhaseResult: close — missing required field is rejected', () => {
  const { valid, errors } = validatePhaseResult('close', {});
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('"merged"')));
});

test('validatePhaseResult: context — empty object is valid (no required fields, no partial-success path)', () => {
  const { valid, errors } = validatePhaseResult('context', {});
  assert.equal(valid, true, `Expected valid, got errors: ${errors.join(', ')}`);
});

test('validatePhaseResult: architect — empty object is valid (no required fields, no partial-success path)', () => {
  const { valid, errors } = validatePhaseResult('architect', {});
  assert.equal(valid, true, `Expected valid, got errors: ${errors.join(', ')}`);
});

test('validatePhaseResult: architect — optional summary field, wrong type is still rejected', () => {
  const { valid, errors } = validatePhaseResult('architect', { summary: 42 });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('"summary"') && e.includes('string')));
});

test('SOFT_SKIP_RESULT_PHASES: exactly context and architect (rebuild constraint "was #2404")', () => {
  assert.deepEqual([...SOFT_SKIP_RESULT_PHASES].sort(), ['architect', 'context']);
});

test('SOFT_SKIP_RESULT_PHASES: every entry is a member of PHASE_IDS', () => {
  for (const phaseId of SOFT_SKIP_RESULT_PHASES) {
    assert.ok(PHASE_IDS.includes(phaseId), `"${phaseId}" is not in PHASE_IDS`);
  }
});

test('SOFT_SKIP_RESULT_PHASES: investigate/build/review/close are NOT soft-skip (still hard-enforced)', () => {
  for (const phaseId of ['investigate', 'build', 'review', 'close']) {
    assert.equal(SOFT_SKIP_RESULT_PHASES.includes(phaseId), false, `"${phaseId}" must not be soft-skip`);
  }
});

test('validatePhaseResult: rejects a key not declared in the schema (rebuild constraint "was #2408")', () => {
  const { valid, errors } = validatePhaseResult('build', {
    branch: 'fix/example-123',
    commits: ['abc1234'],
    unexpectedField: 'sneaky',
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('unexpectedField')));
});

test('validatePhaseResult: rejects a __proto__ key even though it is not iterated by naive for...in checks', () => {
  // JSON.parse never triggers the Object.prototype accessor for "__proto__" —
  // it always creates a real, own, enumerable data property with that name.
  // Confirm validatePhaseResult treats it like any other unexpected key.
  const input = JSON.parse('{"branch": "fix/x-1", "commits": [], "__proto__": {"polluted": true}}');
  assert.ok(Object.prototype.hasOwnProperty.call(input, '__proto__'), 'sanity: input carries an own __proto__ key');
  const { valid, errors } = validatePhaseResult('build', input);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('__proto__')));
});

test('validatePhaseResult: context/architect still accept an empty object with the new key allow-list (no regression)', () => {
  assert.equal(validatePhaseResult('context', {}).valid, true);
  assert.equal(validatePhaseResult('architect', {}).valid, true);
});

test('sanity: PHASE_MARKERS is unchanged/untouched by this addition', () => {
  assert.equal(PHASE_MARKERS.build.completionMarker, 'FORGE:BUILDER:COMPLETE');
  assert.equal(PHASE_MARKERS.close.completionLabel, 'workflow:merged');
});
