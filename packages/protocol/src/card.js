/**
 * FORGE Annotation Protocol v1.0 — CARD codec.
 *
 * Implements the Base64url machine-surface encoding used by the CARD reserved
 * type (§4.2, forge#1727): `<!-- FORGE:CARD: v1 sha:<sha8hex> b64:<base64url> -->`.
 *
 * Design decision (2026-07-08): the Base64url alphabet [A-Za-z0-9_-] cannot
 * contain '>', '<', or '!' — so `-->`, `--!>`, and `<!--` are structurally
 * unrepresentable in the encoded payload, by construction. This sidesteps the
 * escaping-related round-trip bugs that affected the plain field-value/inline
 * form of other reserved types (forge#1637, forge#1638, forge#1662) — CARD
 * payloads never need escaping in the first place.
 *
 * This module is the single production code path for CARD encode/decode: it
 * is used by `cli.js` (the `emit --b64` / `parse --field` subcommands),
 * `validate.js` (CARD integrity checking), and the conformance test suite.
 *
 * @license MIT
 */

import { createHash } from 'node:crypto';

/**
 * Produce canonical JSON: sorted keys (recursively), single line, UTF-8.
 * This is the payload that gets Base64url-encoded in the CARD format.
 *
 * @param {*} obj
 * @returns {string}
 */
export function canonicalJson(obj) {
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
 *
 * @param {string} str — UTF-8 string to encode
 * @returns {string} Base64url-encoded string without padding
 */
export function toBase64url(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Encode a JS value into the CARD wire components: the sha8 integrity prefix
 * (first 8 hex chars of SHA-256 over the canonical JSON payload) and the
 * Base64url-encoded canonical payload.
 *
 * Composes the full inline value with `\`v1 sha:${sha8} b64:${b64url}\`` to
 * build the complete `<!-- FORGE:CARD: v1 sha:<sha8> b64:<base64url> -->` tag.
 *
 * @param {*} payload — the JS value to encode (typically a plain object)
 * @returns {{ sha8: string, b64url: string, inlineValue: string }}
 */
export function encodeCard(payload) {
  const canonical = canonicalJson(payload);
  const b64url = toBase64url(canonical);
  const sha8 = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 8);
  return { sha8, b64url, inlineValue: `v1 sha:${sha8} b64:${b64url}` };
}

/**
 * Decode a CARD inline value of the form "v1 sha:<sha8hex> b64:<base64url>"
 * and return the parsed JSON value, or null if the format is unrecognized,
 * the Base64url payload fails to decode, the sha8 integrity prefix does not
 * match, or the decoded payload is not valid JSON.
 *
 * @param {string} inlineValue — the parsed inlineValue from a CARD annotation
 * @returns {*|null}
 */
export function decodeCardInlineValue(inlineValue) {
  if (typeof inlineValue !== 'string') return null;

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
