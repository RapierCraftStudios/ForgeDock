/**
 * Tests for @forgedock/protocol CARD codec (packages/protocol/src/card.js)
 *
 * Covers the codec functions directly (encodeCard/decodeCardInlineValue),
 * independent of the fixture/conformance-runner layer, per forge#2121:
 *   - round-trip: encode → decode → deep-equal, through the real production
 *     code path (not a reimplementation)
 *   - unicode payloads
 *   - payloads whose string values contain literal HTML-comment-delimiter
 *     text ("-->", "<!--") — proves the Base64url design's structural
 *     safety claim (design decision 2026-07-08, see card.js header comment)
 *   - corrupted sha8 integrity prefix is rejected
 *   - malformed Base64url is rejected
 *
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson, toBase64url, encodeCard, decodeCardInlineValue } from '../src/card.js';

test('card: encodeCard → decodeCardInlineValue round-trips a plain object', () => {
  const payload = { type: 'CARD', issue: 2121, status: 'merged' };
  const { inlineValue } = encodeCard(payload);
  const decoded = decodeCardInlineValue(inlineValue);
  assert.deepEqual(decoded, payload);
});

test('card: round-trip preserves unicode payloads (accented Latin, CJK, emoji)', () => {
  const payload = {
    type: 'CARD',
    note: 'café, 日本語, emoji 🚀, Cyrillic Привет',
  };
  const { inlineValue } = encodeCard(payload);
  const decoded = decodeCardInlineValue(inlineValue);
  assert.deepEqual(decoded, payload);
});

test('card: round-trip preserves literal comment-delimiter strings in payload values', () => {
  // The Base64url alphabet [A-Za-z0-9_-] cannot contain '>', '<', or '!' — so a
  // payload value containing "-->" or "<!--" is encoded losslessly with no
  // escaping required. This is the structural safety guarantee referenced in
  // card.js's header comment; assert it holds through the real codec.
  const payload = {
    type: 'CARD',
    dangerous: 'text with --> and <!-- and --!> embedded literally',
  };
  const { inlineValue, b64url } = encodeCard(payload);

  // The encoded wire form itself must not contain any raw tag-boundary
  // characters — this is what makes the format "structurally safe".
  assert.ok(!b64url.includes('-->'), 'b64url must not contain a raw -->');
  assert.ok(!b64url.includes('<!--'), 'b64url must not contain a raw <!--');
  assert.match(b64url, /^[A-Za-z0-9_-]+$/, 'b64url must only use the Base64url alphabet');

  const decoded = decodeCardInlineValue(inlineValue);
  assert.deepEqual(decoded, payload);
});

test('card: round-trip preserves arrays and nested objects', () => {
  const payload = { type: 'CARD', tags: ['a', 'b', 'c'], nested: { x: 1, y: [true, false, null] } };
  const { inlineValue } = encodeCard(payload);
  const decoded = decodeCardInlineValue(inlineValue);
  assert.deepEqual(decoded, payload);
});

test('card: canonicalJson sorts keys deeply regardless of input order', () => {
  const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
});

test('card: toBase64url produces only URL-safe characters, no padding', () => {
  const encoded = toBase64url('hello world — needs padding?');
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.ok(!encoded.includes('='), 'must have no padding characters');
});

test('card: decodeCardInlineValue rejects a corrupted sha8 integrity prefix', () => {
  const { inlineValue } = encodeCard({ type: 'CARD', issue: 2121 });
  // Flip the last hex character of the sha8 prefix to simulate tampering/corruption.
  const corrupted = inlineValue.replace(
    /sha:([0-9a-f]{7})([0-9a-f])/,
    (_m, prefix, lastChar) => `sha:${prefix}${lastChar === '0' ? '1' : '0'}`,
  );
  assert.notEqual(corrupted, inlineValue, 'test setup must actually change the sha8 value');
  assert.equal(decodeCardInlineValue(corrupted), null);
});

test('card: decodeCardInlineValue rejects malformed Base64url (invalid alphabet character)', () => {
  const { inlineValue } = encodeCard({ type: 'CARD', issue: 2121 });
  const malformed = inlineValue.replace('b64:', 'b64:+');
  assert.equal(decodeCardInlineValue(malformed), null);
});

test('card: decodeCardInlineValue rejects an unrecognized format', () => {
  assert.equal(decodeCardInlineValue('not a card value'), null);
  assert.equal(decodeCardInlineValue(''), null);
  assert.equal(decodeCardInlineValue(null), null);
  assert.equal(decodeCardInlineValue(undefined), null);
});

test('card: decodeCardInlineValue rejects a well-formed but non-JSON payload (integrity mismatch on tamper)', () => {
  // Base64url-encode a non-JSON string directly, with a correctly matching sha8
  // (this is a payload that "decodes" past the integrity check but fails JSON.parse).
  const raw = 'this is not json';
  const b64url = toBase64url(raw);
  const sha8 = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8);
  const inlineValue = `v1 sha:${sha8} b64:${b64url}`;
  assert.equal(decodeCardInlineValue(inlineValue), null);
});
