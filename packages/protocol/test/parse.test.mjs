/**
 * Tests for @forgedock/protocol parse()
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parse.js';
import { emit } from '../src/emit.js';
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

// forge#1526: inline-value types (KNOWLEDGE_GIST, MILESTONE_INDEX, PRIOR_GIST) whose value
// is exactly "COMPLETE" or "PARTIAL" collide in shape with sentinel/closing markers
// (<!-- FORGE:CONTEXT:COMPLETE -->). These must still parse as real annotations.

test('parse: PRIOR_GIST with inline value "COMPLETE" as the first line is not dropped as a sentinel (forge#1526)', () => {
  const body = `<!-- FORGE:PRIOR_GIST: COMPLETE -->`;
  const annotations = parse(body);
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].type, 'PRIOR_GIST');
  assert.equal(annotations[0].inlineValue, 'COMPLETE');
});

test('parse: KNOWLEDGE_GIST with inline value "PARTIAL" as the first line is not dropped as a sentinel (forge#1526)', () => {
  const body = `<!-- FORGE:KNOWLEDGE_GIST: PARTIAL -->`;
  const annotations = parse(body);
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].type, 'KNOWLEDGE_GIST');
  assert.equal(annotations[0].inlineValue, 'PARTIAL');
});

test('parse: MILESTONE_INDEX with inline value "COMPLETE" following another annotation starts its own annotation, not folded into the preceding body (forge#1526)', () => {
  const body = [
    `<!-- FORGE:BUILDER -->`,
    `**Branch**: \`fix/example\``,
    `**Commits**: abc123`,
    `**Files changed**: 1`,
    `<!-- FORGE:BUILDER:COMPLETE -->`,
    `<!-- FORGE:MILESTONE_INDEX: COMPLETE -->`,
  ].join('\n');
  const annotations = parse(body);
  assert.equal(annotations.length, 2);
  assert.equal(annotations[0].type, 'BUILDER');
  assert.ok(!annotations[0].body.includes('MILESTONE_INDEX'));
  assert.equal(annotations[1].type, 'MILESTONE_INDEX');
  assert.equal(annotations[1].inlineValue, 'COMPLETE');
});

test('parse: non-inline-value sentinel folding is unchanged for COMPLETE/PARTIAL (forge#1526 non-regression)', () => {
  // CONTEXT does not declare inlineValue: true — its FORGE:CONTEXT:COMPLETE /
  // FORGE:CONTEXT:PARTIAL sentinels must still fold into the CONTEXT annotation's body,
  // not start a new annotation.
  const completeBody = `<!-- FORGE:CONTEXT -->\nSome context.\n<!-- FORGE:CONTEXT:COMPLETE -->`;
  const completeAnnotations = parse(completeBody);
  assert.equal(completeAnnotations.length, 1);
  assert.equal(completeAnnotations[0].type, 'CONTEXT');
  assert.equal(completeAnnotations[0].sentinelState, SentinelState.COMPLETE);

  const partialBody = `<!-- FORGE:CONTEXT -->\nSome context.\n<!-- FORGE:CONTEXT:PARTIAL -->`;
  const partialAnnotations = parse(partialBody);
  assert.equal(partialAnnotations.length, 1);
  assert.equal(partialAnnotations[0].type, 'CONTEXT');
  assert.equal(partialAnnotations[0].sentinelState, SentinelState.PARTIAL);
});

test('parse: sentinel text embedded inside a field value does NOT spoof completion (forge#1594)', () => {
  // A **Commits** field that merely mentions the literal completion sentinel text
  // (e.g. quoting it in a changelog note) must not flip sentinelState to complete —
  // only a sentinel occupying its own whole line is a real sentinel. This is the
  // sentinel-detection mirror of the #1524 opening-tag anchor fix.
  const body =
    `<!-- FORGE:BUILDER -->\n**Branch**: \`fix/example\`\n` +
    `**Commits**: see note about <!-- FORGE:BUILDER:COMPLETE --> in the changelog\n` +
    `**Files changed**: 1`;
  const [ann] = parse(body);
  assert.equal(ann.type, 'BUILDER');
  assert.equal(ann.sentinelState, SentinelState.INTERRUPTED);
});

test('parse: a real completion sentinel on its own line still completes normally (forge#1594 non-regression)', () => {
  const body =
    `<!-- FORGE:BUILDER -->\n**Branch**: \`fix/example\`\n**Commits**: abc123\n` +
    `**Files changed**: 1\n<!-- FORGE:BUILDER:COMPLETE -->`;
  const [ann] = parse(body);
  assert.equal(ann.sentinelState, SentinelState.COMPLETE);
});

test('parse: unknown-type generic sentinel detection is also line-anchored (forge#1594)', () => {
  const body = `<!-- FORGE:CUSTOM_VENDOR_TYPE -->\nNote: some text mentions <!-- X:COMPLETE --> mid-sentence.`;
  const [ann] = parse(body);
  assert.equal(ann.isReserved, false);
  assert.equal(ann.sentinelState, SentinelState.INTERRUPTED);
});

// ── Round-trip unescape (forge#1662) ──────────────────────────────────────────
//
// emit() escapes HTML comment delimiters in field keys, field values, and inline
// values to protect GitHub's renderer. parse() must reverse these escapes so that
// parse(emit(...)) is lossless. These tests cover all three escape sequences:
//   1. `-->` / `--!>` — comment closer forms (forge#1594)
//   2. `<!--`          — comment opener form (forge#1638)
// and verify the unescape is applied to both field values and inline values.

test('parse(emit(...)): field value containing "-->" round-trips losslessly (forge#1662)', () => {
  const original = 'ends with --> right here';
  const [ann] = parse(emit('CONTEXT', { Note: original }));
  assert.equal(ann.fields['Note'], original);
});

test('parse(emit(...)): field value containing "--!>" round-trips losslessly (forge#1662)', () => {
  const original = 'weird --!> sequence';
  const [ann] = parse(emit('CONTEXT', { Note: original }));
  assert.equal(ann.fields['Note'], original);
});

test('parse(emit(...)): field value containing "<!--" round-trips losslessly (forge#1662)', () => {
  const original = 'starts with <!-- right here';
  const [ann] = parse(emit('CONTEXT', { Note: original }));
  assert.equal(ann.fields['Note'], original);
});

test('parse(emit(...)): field key containing "-->" round-trips losslessly (forge#1662)', () => {
  const keyName = 'Key-->Name';
  const [ann] = parse(emit('CONTEXT', { [keyName]: 'safe-value' }));
  assert.ok(keyName in ann.fields, `Expected key "${keyName}" in fields, got: ${JSON.stringify(Object.keys(ann.fields))}`);
  assert.equal(ann.fields[keyName], 'safe-value');
});

test('parse(emit(...)): inline value containing "-->" round-trips losslessly (forge#1662)', () => {
  const original = 'https://example.com/a-->b';
  const [ann] = parse(emit('KNOWLEDGE_GIST', { value: original }));
  assert.equal(ann.inlineValue, original);
});

test('parse(emit(...)): inline value containing "<!--" round-trips losslessly (forge#1662)', () => {
  const original = 'https://example.com/a<!--b';
  const [ann] = parse(emit('KNOWLEDGE_GIST', { value: original }));
  assert.equal(ann.inlineValue, original);
});

test('parse(emit(...)): field value with multiple escape sequences round-trips losslessly (forge#1662)', () => {
  const original = 'from <!-- start --> to --!> end';
  const [ann] = parse(emit('CONTEXT', { Note: original }));
  assert.equal(ann.fields['Note'], original);
});

// ── CARD annotation — Base64url machine-surface form (forge#1727) ──────────
//
// The FORGE:CARD type uses the colon inline-value syntax (§3.4):
//   <!-- FORGE:CARD: v1 sha:<sha8hex> b64:<base64url_of_canonical_json> -->
// parse() extracts the inline value "v1 sha:X b64:Y" as inlineValue.
// The cli.js decodeCardInlineValue() function handles decoding; these tests
// verify that parse() correctly identifies CARD as an inline-value annotation.

test('parse: CARD annotation is recognized as inline-value type (forge#1727)', () => {
  const body = '<!-- FORGE:CARD: v1 sha:7234c2d8 b64:eyJpc3N1ZSI6IjEzNzAiLCJzdGF0dXMiOiJtZXJnZWQiLCJ0eXBlIjoiQ0FSRCJ9 -->';
  const annotations = parse(body);
  assert.equal(annotations.length, 1);
  const [ann] = annotations;
  assert.equal(ann.type, 'CARD');
  assert.equal(ann.isReserved, true);
  assert.ok(ann.inlineValue !== null, 'CARD annotation should have an inlineValue');
  assert.ok(ann.inlineValue.startsWith('v1 sha:'), `inlineValue should start with "v1 sha:", got: "${ann.inlineValue}"`);
});

test('parse: CARD annotation inlineValue contains sha8 prefix and b64 payload (forge#1727)', () => {
  const body = '<!-- FORGE:CARD: v1 sha:7234c2d8 b64:eyJpc3N1ZSI6IjEzNzAiLCJzdGF0dXMiOiJtZXJnZWQiLCJ0eXBlIjoiQ0FSRCJ9 -->';
  const [ann] = parse(body);
  assert.match(ann.inlineValue, /^v1 sha:[0-9a-f]{8} b64:[A-Za-z0-9_-]+$/);
});

// ── CLAIM and CLAIM_RELEASED (forge#1736) ─────────────────────────────────
//
// CLAIM is a lifecycle annotation with a completion sentinel 'CLAIM:COMPLETE'.
// CLAIM_RELEASED is a control marker (no body, presence is the signal).

test('parse: CLAIM annotation is recognized as lifecycle type with sentinel (forge#1736)', () => {
  const body = [
    '<!-- FORGE:CLAIM -->',
    '**Holder**: #1736 / run-abc123',
    '**Files**: commands/orchestrate/phase-3-dependency.md',
    '**Interfaces**: Step 3C conflict detection API',
    '**TTL**: terminal state of Holder issue #1736',
    '<!-- CLAIM:COMPLETE -->',
  ].join('\n');
  const annotations = parse(body);
  assert.equal(annotations.length, 1);
  const [ann] = annotations;
  assert.equal(ann.type, 'CLAIM');
  assert.equal(ann.isReserved, true);
  assert.equal(ann.isControl, false);
  assert.equal(ann.inlineValue, null);
  assert.equal(ann.sentinelState, SentinelState.COMPLETE);
  assert.equal(ann.fields['Holder'], '#1736 / run-abc123');
  assert.equal(ann.fields['TTL'], 'terminal state of Holder issue #1736');
});

test('parse: CLAIM without sentinel → sentinelState interrupted (forge#1736)', () => {
  const body = [
    '<!-- FORGE:CLAIM -->',
    '**Holder**: #1736 / run-abc',
    '**Files**: commands/orchestrate/phase-3-dependency.md',
    '**Interfaces**: Step 3C API',
    '**TTL**: terminal',
  ].join('\n');
  const [ann] = parse(body);
  assert.equal(ann.type, 'CLAIM');
  assert.equal(ann.sentinelState, SentinelState.INTERRUPTED);
});

test('parse: CLAIM_RELEASED is a control marker (forge#1736)', () => {
  const body = '<!-- FORGE:CLAIM_RELEASED -->';
  const annotations = parse(body);
  assert.equal(annotations.length, 1);
  const [ann] = annotations;
  assert.equal(ann.type, 'CLAIM_RELEASED');
  assert.equal(ann.isReserved, true);
  assert.equal(ann.isControl, true);
  assert.equal(ann.sentinelState, SentinelState.COMPLETE);
});

test('parse(emit(...)): CLAIM round-trips with sanitized field values (forge#1736)', () => {
  const emitted = emit('CLAIM', {
    Holder: '#1736 / run-abc',
    Files: 'commands/orchestrate/phase-3-dependency.md',
    Interfaces: 'Step 3C API',
    TTL: 'terminal state of Holder issue #1736',
  });
  // CLAIM has a completionSentinel — emit() appends it
  const [ann] = parse(emitted);
  assert.equal(ann.type, 'CLAIM');
  assert.equal(ann.sentinelState, SentinelState.COMPLETE);
  assert.equal(ann.fields['Holder'], '#1736 / run-abc');
  assert.equal(ann.fields['Files'], 'commands/orchestrate/phase-3-dependency.md');
  assert.equal(ann.fields['Interfaces'], 'Step 3C API');
  assert.equal(ann.fields['TTL'], 'terminal state of Holder issue #1736');
});

test('parse: CLAIM_RELEASED following CLAIM in one comment — two annotations (forge#1736)', () => {
  const body = [
    '<!-- FORGE:CLAIM -->',
    '**Holder**: #1736 / run-abc',
    '**Files**: commands/orchestrate/phase-3-dependency.md',
    '**Interfaces**: Step 3C API',
    '**TTL**: terminal',
    '<!-- CLAIM:COMPLETE -->',
    '<!-- FORGE:CLAIM_RELEASED -->',
  ].join('\n');
  const annotations = parse(body);
  assert.equal(annotations.length, 2);
  assert.equal(annotations[0].type, 'CLAIM');
  assert.equal(annotations[1].type, 'CLAIM_RELEASED');
});

test('parse: CARD annotation following another annotation starts its own annotation (forge#1727)', () => {
  const body = [
    '<!-- FORGE:BUILDER -->',
    '**Branch**: `fix/example`',
    '**Commits**: abc123',
    '**Files changed**: 1',
    '<!-- FORGE:BUILDER:COMPLETE -->',
    '<!-- FORGE:CARD: v1 sha:7234c2d8 b64:eyJpc3N1ZSI6IjEzNzAiLCJzdGF0dXMiOiJtZXJnZWQiLCJ0eXBlIjoiQ0FSRCJ9 -->',
  ].join('\n');
  const annotations = parse(body);
  assert.equal(annotations.length, 2);
  assert.equal(annotations[0].type, 'BUILDER');
  assert.equal(annotations[1].type, 'CARD');
  assert.ok(annotations[1].inlineValue, 'Second annotation should be a CARD with an inlineValue');
});

test('parse: CARD with inline value "COMPLETE" parses as real annotation (not dropped as sentinel) (forge#1727)', () => {
  // CARD is an inline-value type — "COMPLETE" is a legitimate inline value, not a sentinel.
  // This parallels the PRIOR_GIST / KNOWLEDGE_GIST / MILESTONE_INDEX fix from forge#1526.
  const body = '<!-- FORGE:CARD: COMPLETE -->';
  const annotations = parse(body);
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].type, 'CARD');
  assert.equal(annotations[0].inlineValue, 'COMPLETE');
});
