/**
 * Tests for @forgedock/protocol parse()
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parse.js';
import { SentinelState } from '../src/types.js';

test('parse: empty string returns empty array', () => {
  assert.deepEqual(parse(''), []);
});

test('parse: throws on non-string input', () => {
  assert.throws(() => parse(null), TypeError);
  assert.throws(() => parse(42), TypeError);
});

test('parse: extracts INVESTIGATOR opening tag', () => {
  const body = `<!-- FORGE:INVESTIGATOR -->\n**Verdict**: CONFIRMED\n<!-- INVESTIGATION:COMPLETE -->`;
  const [ann] = parse(body);
  assert.equal(ann.type, 'INVESTIGATOR');
  assert.equal(ann.isReserved, true);
  assert.equal(ann.isControl, false);
  assert.equal(ann.inlineValue, null);
});

test('parse: INVESTIGATOR with complete sentinel → sentinelState complete', () => {
  const body = `<!-- FORGE:INVESTIGATOR -->\n**Verdict**: CONFIRMED\n**Confidence**: HIGH\n**Severity**: LOW\n**Task Type**: Bug Fix\n**Decomposition Assessment**: NO — simple.\n<!-- INVESTIGATION:COMPLETE -->`;
  const [ann] = parse(body);
  assert.equal(ann.sentinelState, SentinelState.COMPLETE);
});

test('parse: INVESTIGATOR without sentinel → sentinelState interrupted', () => {
  const body = `<!-- FORGE:INVESTIGATOR -->\n**Verdict**: CONFIRMED`;
  const [ann] = parse(body);
  assert.equal(ann.sentinelState, SentinelState.INTERRUPTED);
});

test('parse: CONTEXT with FORGE:CONTEXT:PARTIAL → sentinelState partial', () => {
  const body = `<!-- FORGE:CONTEXT -->\nSome context.\n<!-- FORGE:CONTEXT:PARTIAL -->`;
  const [ann] = parse(body);
  assert.equal(ann.sentinelState, SentinelState.PARTIAL);
});

test('parse: inline-value form KNOWLEDGE_GIST', () => {
  const body = `<!-- FORGE:KNOWLEDGE_GIST: https://example.com/gist -->`;
  const [ann] = parse(body);
  assert.equal(ann.type, 'KNOWLEDGE_GIST');
  assert.equal(ann.inlineValue, 'https://example.com/gist');
});

test('parse: control marker REVIEW_STARTED has no body', () => {
  const body = `<!-- FORGE:REVIEW_STARTED -->`;
  const [ann] = parse(body);
  assert.equal(ann.type, 'REVIEW_STARTED');
  assert.equal(ann.isControl, true);
  assert.equal(ann.sentinelState, SentinelState.COMPLETE);
});

test('parse: multiple annotations in one comment', () => {
  const body = [
    `<!-- FORGE:BUILDER -->`,
    `**Branch**: \`fix/example\``,
    `**Commits**: abc123`,
    `**Files changed**: 1`,
    `<!-- FORGE:BUILDER:COMPLETE -->`,
    `<!-- FORGE:TRAJECTORY -->`,
    `## Pipeline Trajectory`,
  ].join('\n');
  const annotations = parse(body);
  assert.equal(annotations.length, 2);
  assert.equal(annotations[0].type, 'BUILDER');
  assert.equal(annotations[1].type, 'TRAJECTORY');
});

test('parse: unknown type is tolerated (§7.2.4)', () => {
  const body = `<!-- FORGE:CUSTOM_VENDOR_TYPE -->\nContent.\n<!-- CUSTOM_VENDOR_TYPE:COMPLETE -->`;
  const [ann] = parse(body);
  assert.equal(ann.type, 'CUSTOM_VENDOR_TYPE');
  assert.equal(ann.isReserved, false);
});

test('parse: fields extracted from bold-key lines', () => {
  const body = `<!-- FORGE:INVESTIGATOR -->\n**Verdict**: CONFIRMED\n**Confidence**: HIGH\n<!-- INVESTIGATION:COMPLETE -->`;
  const [ann] = parse(body);
  assert.equal(ann.fields['Verdict'], 'CONFIRMED');
  assert.equal(ann.fields['Confidence'], 'HIGH');
});

test('parse: DECOMPOSED complete sentinel', () => {
  const body = `<!-- FORGE:DECOMPOSED -->\n## Decomposition Complete\n<!-- FORGE:DECOMPOSED:COMPLETE -->`;
  const [ann] = parse(body);
  assert.equal(ann.sentinelState, SentinelState.COMPLETE);
});

test('parse: BUILDER annotation body ends at next FORGE: tag', () => {
  const body = `<!-- FORGE:BUILDER -->\n**Branch**: \`fix/x\`\n**Commits**: abc\n**Files changed**: 1\n<!-- FORGE:BUILDER:COMPLETE -->\n<!-- FORGE:TRAJECTORY -->\nTrajectory content`;
  const [builder] = parse(body);
  assert.ok(!builder.body.includes('Trajectory content'));
});

test('parse: FORGE-tag-shaped substring embedded in a field value does not split/corrupt the annotation (forge#1524)', () => {
  const body = [
    `<!-- FORGE:BUILDER -->`,
    `**Branch**: \`fix/example\``,
    `**Commits**: abc123 fixes docs mentioning <!-- FORGE:CONTRACT --> example text`,
    `**Files changed**: 1`,
    `<!-- FORGE:BUILDER:COMPLETE -->`,
  ].join('\n');
  const annotations = parse(body);
  assert.equal(annotations.length, 1);
  const [builder] = annotations;
  assert.equal(builder.type, 'BUILDER');
  assert.equal(builder.sentinelState, SentinelState.COMPLETE);
  assert.equal(builder.fields['Commits'], 'abc123 fixes docs mentioning <!-- FORGE:CONTRACT --> example text');
  assert.equal(builder.fields['Files changed'], '1');
});

test('parse: FORGE-tag-shaped substring embedded mid-line inside a body loop line does not open a new annotation (forge#1524)', () => {
  const body = [
    `<!-- FORGE:INVESTIGATOR -->`,
    `**Verdict**: CONFIRMED`,
    `**Confidence**: HIGH`,
    `**Severity**: HIGH`,
    `**Task Type**: Bug Fix`,
    `### Evidence`,
    `See docs referencing <!-- FORGE:CONTEXT --> for prior art.`,
    `<!-- INVESTIGATION:COMPLETE -->`,
  ].join('\n');
  const annotations = parse(body);
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].type, 'INVESTIGATOR');
  assert.equal(annotations[0].sentinelState, SentinelState.COMPLETE);
});
