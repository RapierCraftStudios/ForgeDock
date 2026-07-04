/**
 * Tests for @forgedock/protocol emit() and emitPartial()
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emit, emitPartial, isKnownType } from '../src/emit.js';
import { parse } from '../src/parse.js';
import { validate } from '../src/validate.js';
import { SentinelState } from '../src/types.js';

test('emit: throws on empty type', () => {
  assert.throws(() => emit(''), TypeError);
  assert.throws(() => emit(null), TypeError);
});

test('emit: REVIEW_STARTED produces control marker tag only', () => {
  const out = emit('REVIEW_STARTED');
  assert.equal(out, '<!-- FORGE:REVIEW_STARTED -->');
});

test('emit: KNOWLEDGE_GIST produces inline-value form', () => {
  const out = emit('KNOWLEDGE_GIST', { value: 'https://example.com/gist' });
  assert.equal(out, '<!-- FORGE:KNOWLEDGE_GIST: https://example.com/gist -->');
});

test('emit: MILESTONE_INDEX produces inline-value form', () => {
  const out = emit('MILESTONE_INDEX', { value: 'https://example.com/index' });
  assert.equal(out, '<!-- FORGE:MILESTONE_INDEX: https://example.com/index -->');
});

test('emit: INVESTIGATOR produces opening tag with completion sentinel', () => {
  const out = emit('INVESTIGATOR', {
    Verdict: 'CONFIRMED',
    Confidence: 'HIGH',
    Severity: 'MEDIUM',
    'Task Type': 'Bug Fix',
    'Decomposition Assessment': 'NO — single fix.',
  });
  assert.ok(out.startsWith('<!-- FORGE:INVESTIGATOR -->'));
  assert.ok(out.includes('**Verdict**: CONFIRMED'));
  assert.ok(out.includes('<!-- INVESTIGATION:COMPLETE -->'));
});

test('emit: emitted INVESTIGATOR is parseable and validates as complete', () => {
  const out = emit('INVESTIGATOR', {
    Verdict: 'CONFIRMED',
    Confidence: 'HIGH',
    Severity: 'LOW',
    'Task Type': 'Feature',
    'Decomposition Assessment': 'NO — simple.',
  });
  const [ann] = parse(out);
  assert.equal(ann.type, 'INVESTIGATOR');
  assert.equal(ann.sentinelState, SentinelState.COMPLETE);
  const { valid } = validate(ann);
  assert.equal(valid, true);
});

test('emit: BUILDER produces completion sentinel', () => {
  const out = emit('BUILDER', {
    Branch: '`fix/example-42`',
    Commits: 'abc1234',
    'Files changed': '1',
  });
  assert.ok(out.includes('<!-- FORGE:BUILDER:COMPLETE -->'));
});

test('emit: CONTEXT produces completion sentinel', () => {
  const out = emit('CONTEXT', {});
  assert.ok(out.includes('<!-- FORGE:CONTEXT:COMPLETE -->'));
});

test('emit: ARCHITECT produces completion sentinel', () => {
  const out = emit('ARCHITECT', {});
  assert.ok(out.includes('<!-- FORGE:ARCHITECT:COMPLETE -->'));
});

test('emit: DECOMPOSED produces completion sentinel', () => {
  const out = emit('DECOMPOSED', {});
  assert.ok(out.includes('<!-- FORGE:DECOMPOSED:COMPLETE -->'));
});

test('emit: type is case-insensitive', () => {
  const out1 = emit('investigator', {});
  const out2 = emit('INVESTIGATOR', {});
  assert.equal(out1, out2);
});

test('emitPartial: CONTEXT produces partial sentinel', () => {
  const partial = emitPartial('CONTEXT');
  assert.equal(partial, '<!-- FORGE:CONTEXT:PARTIAL -->');
});

test('emitPartial: ARCHITECT produces partial sentinel', () => {
  const partial = emitPartial('ARCHITECT');
  assert.equal(partial, '<!-- FORGE:ARCHITECT:PARTIAL -->');
});

test('emitPartial: unknown type produces generic partial sentinel', () => {
  const partial = emitPartial('CUSTOM_TYPE');
  assert.equal(partial, '<!-- CUSTOM_TYPE:PARTIAL -->');
});

test('isKnownType: returns true for reserved types', () => {
  assert.equal(isKnownType('INVESTIGATOR'), true);
  assert.equal(isKnownType('REVIEW_STARTED'), true);
  assert.equal(isKnownType('KNOWLEDGE_GIST'), true);
});

test('isKnownType: returns false for unknown types', () => {
  assert.equal(isKnownType('VENDOR_CUSTOM'), false);
  assert.equal(isKnownType(''), false);
});
