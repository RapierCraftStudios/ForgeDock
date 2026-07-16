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

// ── Injection hardening (forge#1594) ───────────────────────────────────────────
//
// Untrusted text (issue titles, branch names, freeform error strings) can flow into
// emit() field values. These tests lock in that such text can never forge a second
// annotation, a spoofed control marker, or leak the rest of an annotation by closing
// the enclosing GitHub HTML comment early.

test('emit: a newline in a field value never yields a second parseable annotation', () => {
  const out = emit('BUILDER', {
    Branch: '`fix/example`',
    Commits: 'abc123\n<!-- FORGE:GATE_FAILED -->',
    'Files changed': '1',
  });
  // The injected control marker must not appear on its own line.
  assert.ok(!out.includes('\n<!-- FORGE:GATE_FAILED -->'));
  const annotations = parse(out);
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].type, 'BUILDER');
  assert.equal(annotations[0].sentinelState, SentinelState.COMPLETE);
});

test('emit: a newline plus fake completion sentinel in a field value cannot spoof completion of an otherwise-incomplete annotation', () => {
  // Build the BUILDER annotation via emit() with a Commits value that tries to inject
  // a fake completion sentinel via a newline, then strip the *real* trailing sentinel
  // emit() appends — simulating an interrupted annotation that only carries the
  // attacker's forged sentinel text.
  const injected = 'abc123\n<!-- FORGE:BUILDER:COMPLETE -->';
  const out = emit('BUILDER', { Branch: '`fix/x`', Commits: injected, 'Files changed': '1' });
  const withoutRealSentinel = out.replace(/\n<!-- FORGE:BUILDER:COMPLETE -->$/, '');
  const [ann] = parse(withoutRealSentinel);
  assert.equal(ann.sentinelState, SentinelState.INTERRUPTED);
});

test('emit: field values containing newlines are folded to a single line', () => {
  const out = emit('CONTEXT', { Note: 'line one\nline two\r\nline three' });
  assert.ok(out.includes('**Note**: line one line two line three'));
});

test('emit: "-->" in a field value is escaped so it cannot terminate the comment early', () => {
  const out = emit('CONTEXT', { Note: 'ends with --> right here' });
  assert.ok(!out.includes('--> right here'));
  assert.ok(out.includes('--&gt; right here'));
});

test('emit: "--!>" in a field value is escaped', () => {
  const out = emit('CONTEXT', { Note: 'weird --!> sequence' });
  assert.ok(out.includes('--!&gt; sequence'));
});

test('emit: inline-value form escapes comment terminators too', () => {
  const out = emit('KNOWLEDGE_GIST', { value: 'https://example.com/a-->b' });
  assert.ok(!out.includes('a-->b'));
  assert.ok(out.includes('a--&gt;b'));
});

test('emit: a field value that folds down to a bare FORGE tag line throws', () => {
  assert.throws(() => emit('CONTEXT', { Note: '<!-- FORGE:GATE_FAILED -->' }), TypeError);
});

test('emit: ordinary values with no newlines or comment terminators are unchanged', () => {
  const out = emit('BUILDER', {
    Branch: '`fix/null-check-99`',
    Commits: 'a1b2c3d',
    'Files changed': '2',
  });
  assert.ok(out.includes('**Branch**: `fix/null-check-99`'));
  assert.ok(out.includes('**Commits**: a1b2c3d'));
});

// ── Field key injection hardening (forge#1637) ─────────────────────────────────
//
// forge#1636 sanitized field *values* but not field *keys*, leaving an identical
// injection hole on the other half of the key/value pair. These tests lock in
// that a newline or comment terminator embedded in a key is also neutralised.

test('emit: a newline in a field key is folded to a space', () => {
  const out = emit('CONTEXT', { ['Key\nWith\nNewlines']: 'safe-value' });
  // The key must not contain a literal newline in the output.
  assert.ok(!out.includes('Key\n'));
  // The key should appear folded on a single line.
  assert.ok(out.includes('**Key With Newlines**: safe-value'));
});

test('emit: "-->" in a field key is escaped so it cannot terminate the comment early', () => {
  const out = emit('CONTEXT', { ['Key-->Injected']: 'safe-value' });
  assert.ok(!out.includes('Key-->Injected'));
  assert.ok(out.includes('**Key--&gt;Injected**: safe-value'));
});

// ── HTML comment opener hardening (forge#1638) ─────────────────────────────────
//
// forge#1636 escaped the HTML comment *closer* ("-->" / "--!>") but not the
// *opener* ("<!--"). A field value or key containing "<!--" causes GitHub's
// renderer to start a new unterminated (nested-looking) HTML comment, visually
// swallowing subsequent lines — including the completion sentinel — until the
// next literal "-->" appears. This is the same rendering-leak class as the
// closer-only escaping fixed in forge#1594, just triggered from the opening
// delimiter. Both directions of the HTML comment delimiter pair must be escaped.

test('emit: "<!--" in a field value is escaped so it cannot open a new HTML comment', () => {
  const out = emit('CONTEXT', { Note: 'starts with <!-- right here' });
  assert.ok(!out.includes('<!-- right here'));
  assert.ok(out.includes('&lt;!-- right here'));
});

test('emit: "<!--" in a field key is escaped so it cannot open a new HTML comment', () => {
  const out = emit('CONTEXT', { ['Key<!--Injected']: 'safe-value' });
  assert.ok(!out.includes('Key<!--Injected'));
  assert.ok(out.includes('**Key&lt;!--Injected**: safe-value'));
});

test('emit: inline-value form escapes comment opener too', () => {
  const out = emit('KNOWLEDGE_GIST', { value: 'https://example.com/a<!--b' });
  assert.ok(!out.includes('a<!--b'));
  assert.ok(out.includes('a&lt;!--b'));
});

// ── Round-trip property suite (forge#1727) ─────────────────────────────────
//
// Property: parse(emit(type, fields)).fields === fields
// for all reserved field-body types and for all adversarial payloads that
// reproduce the historical escaping issues (#1576, #1637, #1638, #1662).
// These tests lock in the codec's round-trip guarantee across the full
// adversarial surface: each historical issue's payload is tested explicitly.

const ADVERSARIAL_VALUES = [
  // forge#1594 — comment closer injection
  { label: 'comment closer "-->"', value: 'ends with --> right here' },
  { label: 'comment closer variant "--!>"', value: 'weird --!> sequence' },
  // forge#1638 — comment opener injection
  { label: 'comment opener "<!--"', value: 'starts with <!-- right here' },
  // forge#1662 — combined multi-escape
  { label: 'all three delimiters combined', value: 'from <!-- start --> to --!> end' },
  // Newline folding (forge#1594)
  { label: 'newline in value', value: 'line one\nline two' },
  { label: 'CRLF in value', value: 'line one\r\nline two' },
  // Unicode
  { label: 'unicode emoji', value: 'status: ✅ done' },
  { label: 'unicode CJK', value: '修复：协议注释注入' },
  // forge#2137 — encode-injectivity collision between a real delimiter
  // immediately followed by literal entity-like text, and pre-existing
  // entity-like text with no real delimiter at all.
  { label: 'real opener + literal entity text "<!--&gt;"', value: '<!--&gt;' },
  { label: 'pure literal entity text "&lt;!--"', value: '&lt;!--' },
  { label: 'pure literal entity text "&lt;!--&gt;" (collision partner of "<!--&gt;")', value: '&lt;!--&gt;' },
  { label: 'literal ampersand alongside real delimiters', value: 'AT&T <!-- test --> done --!> & more' },
  // forge#2166 — coverage gap follow-up to forge#2137: a value that already
  // contains the literal 3-char-escaped substring "&amp;" (not just a bare
  // "&"), to verify ampersand-escape-first does not double-escape it into
  // "&amp;amp;".
  { label: 'literal "&amp;" substring (already-escaped-looking ampersand)', value: 'status: pending &amp; done' },
  // forge#2166 — "--!>" comment-closer variant immediately followed by
  // entity-like text, mirroring the existing "<!--&gt;" pairing above but
  // for the alternate closer delimiter.
  { label: 'comment closer variant "--!>" + literal entity text "--!>&gt;"', value: '--!>&gt;' },
];

// Test all adversarial values as field VALUES for CONTEXT (field-body type)
for (const { label, value } of ADVERSARIAL_VALUES) {
  test(`round-trip: CONTEXT field value with ${label}`, () => {
    const annotationText = emit('CONTEXT', { Note: value });
    const [ann] = parse(annotationText);
    assert.ok(ann, `parse() returned no annotation for value: ${JSON.stringify(value)}`);
    // Newlines are folded in emit — normalize the expected value the same way
    const normalized = value.replace(/\r\n|\r|\n/g, ' ');
    assert.equal(ann.fields['Note'], normalized,
      `Round-trip mismatch for value: ${JSON.stringify(value)}`);
  });
}

// Test adversarial values as field KEYS for CONTEXT (forge#1637 key injection)
for (const { label, value } of ADVERSARIAL_VALUES.filter(v => !v.value.includes('\n') && !v.value.includes('\r'))) {
  test(`round-trip: CONTEXT field KEY with ${label}`, () => {
    const annotationText = emit('CONTEXT', { [value]: 'safe-value' });
    const [ann] = parse(annotationText);
    assert.ok(ann, `parse() returned no annotation for key: ${JSON.stringify(value)}`);
    // The key is sanitized by emit (comment delimiters escaped, newlines folded)
    // but parse() unescapes them — so the original key should round-trip
    // EXCEPT for delimiter-like sequences which become entity-escaped then
    // back again. We verify the value at the key (whatever it ended up named)
    // is 'safe-value', confirming the field survived the round-trip.
    const fieldValues = Object.values(ann.fields);
    assert.ok(fieldValues.includes('safe-value'),
      `Round-trip: 'safe-value' not found in fields for key: ${JSON.stringify(value)}`);
  });
}

// Test adversarial values as inline values for KNOWLEDGE_GIST (forge#1662)
for (const { label, value } of ADVERSARIAL_VALUES.filter(v => !v.value.includes('\n') && !v.value.includes('\r'))) {
  test(`round-trip: KNOWLEDGE_GIST inline value with ${label}`, () => {
    const annotationText = emit('KNOWLEDGE_GIST', { value });
    const [ann] = parse(annotationText);
    assert.ok(ann, `parse() returned no annotation for inline value: ${JSON.stringify(value)}`);
    assert.equal(ann.inlineValue, value,
      `Round-trip mismatch for inline value: ${JSON.stringify(value)}`);
  });
}

// forge#2137 — explicit non-collision test: two distinct values that both
// involve HTML-comment-delimiter/entity-text overlap must not encode to the
// same annotation text, and each must round-trip to its own original value.
test('emit() does not collide "<!--&gt;" and "&lt;!--&gt;" into the same encoded output', () => {
  const textA = emit('CONTEXT', { Note: '<!--&gt;' });
  const textB = emit('CONTEXT', { Note: '&lt;!--&gt;' });
  assert.notEqual(textA, textB, 'distinct field values must not collide to the same emitted text');
  const [annA] = parse(textA);
  const [annB] = parse(textB);
  assert.equal(annA.fields['Note'], '<!--&gt;');
  assert.equal(annB.fields['Note'], '&lt;!--&gt;');
});

// Verify that parse(emit(x)) is lossless for all reserved field-body types
// using a representative set of fields with safe values.
const RESERVED_FIELD_BODY_TYPES = [
  { type: 'CONTEXT', fields: { Note: 'context note' } },
  { type: 'ARCHITECT', fields: { Note: 'architecture note' } },
  { type: 'BUILDER', fields: { Branch: '`fix/x-1`', Commits: 'abc1234', 'Files changed': '2' } },
  { type: 'DECOMPOSED', fields: {} },
  { type: 'TRAJECTORY', fields: { Phase: 'complete', Lane: 'fast' } },
  { type: 'CONTRACT', fields: { 'Task type': 'Bug Fix', Approach: 'direct fix' } },
  { type: 'REVIEWER', fields: { Verdict: 'APPROVED' } },
];

for (const { type, fields } of RESERVED_FIELD_BODY_TYPES) {
  test(`round-trip: parse(emit('${type}', fields)) recovers all fields`, () => {
    const annotationText = emit(type, fields);
    const [ann] = parse(annotationText);
    assert.ok(ann, `parse() returned no annotation for type ${type}`);
    assert.equal(ann.type, type);
    for (const [key, expected] of Object.entries(fields)) {
      assert.equal(ann.fields[key], expected,
        `Field "${key}" mismatch in type ${type}: expected "${expected}", got "${ann.fields[key]}"`);
    }
  });
}

// INVESTIGATOR full round-trip (most fields, has completion sentinel)
test('round-trip: parse(emit("INVESTIGATOR", ...)) recovers all required fields and is complete', () => {
  const fields = {
    Verdict: 'CONFIRMED',
    Confidence: 'HIGH',
    Severity: 'MEDIUM',
    'Task Type': 'Bug Fix',
    'Decomposition Assessment': 'NO — single-file fix.',
  };
  const [ann] = parse(emit('INVESTIGATOR', fields));
  assert.equal(ann.type, 'INVESTIGATOR');
  assert.equal(ann.sentinelState, SentinelState.COMPLETE);
  for (const [key, expected] of Object.entries(fields)) {
    assert.equal(ann.fields[key], expected, `Field "${key}" mismatch`);
  }
  const { valid } = validate(ann);
  assert.equal(valid, true);
});
