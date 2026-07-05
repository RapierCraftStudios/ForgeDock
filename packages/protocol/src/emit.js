/**
 * FORGE Annotation Protocol v1.0 — emitter.
 *
 * emit(type, fields) → well-formed annotation string
 *
 * Produces the canonical text for a FORGE annotation including:
 *   - Opening tag (§3.1)
 *   - Inline-value form (§3.4) when the type uses it
 *   - Completion sentinel (§3.2) when the type defines one
 *
 * @license MIT
 */

import { RESERVED_TYPES, RESERVED_TYPE_NAMES } from './types.js';

// A folded field/inline value that is itself (whole, trimmed) shaped like a FORGE
// opening tag or a generic sentinel line has no legitimate reason to look that way —
// parse()'s line-anchored matching (see parse.js OPENING_TAG_RE / resolveSentinelState)
// treats any line matching this shape as live protocol structure. Untrusted text
// (issue titles, branch names, freeform error/output strings) flowing into emit()
// must never be able to forge one. (forge#1594)
const FORGE_TAG_LINE_RE =
  /^\s*<!--\s*(?:FORGE:[A-Z_]+(?::.*)?|[A-Z_][A-Z_:]*:(?:COMPLETE|PARTIAL))\s*-->\s*$/;

// Newline variants that would let a value spill onto its own line(s).
const NEWLINE_RE = /\r\n|\r|\n/g;

/**
 * Sanitize a value before it is serialized into a `**Key**: value` field line or
 * an inline-value tag. Two independent protections:
 *
 *   1. Newlines are folded to a single space so a multi-line value can never
 *      produce a new line of its own — every real FORGE tag (opening tag,
 *      sentinel, control marker) occupies a whole line, so folding denies an
 *      injected value the only shape parse() treats as structural.
 *   2. HTML comment terminators (`-->` and `--!>`) are escaped so a value can
 *      never prematurely close the enclosing `<!-- ... -->` comment — GitHub's
 *      renderer ends the comment at the literal first `-->` regardless of
 *      Markdown escaping, which would otherwise leak the remainder of the
 *      annotation as visible rendered text (and any FORGE tag inside that
 *      remainder as parseable structure).
 *
 * As defense in depth, if a value still folds down to a line that is itself a
 * bare FORGE tag/sentinel shape, emit() rejects it outright rather than silently
 * emitting something a parser could mistake for real protocol structure.
 *
 * @param {*} rawValue
 * @returns {string}
 */
function sanitizeFieldValue(rawValue) {
  const folded = String(rawValue).replace(NEWLINE_RE, ' ');
  if (FORGE_TAG_LINE_RE.test(folded.trim())) {
    throw new TypeError(
      `emit(): field value resolves to a bare FORGE tag/sentinel line, which is not permitted: ${JSON.stringify(rawValue)}`,
    );
  }
  // Escape both HTML comment-close forms ("-->" and "--!>") — only replacing the
  // literal character sequence (not just documenting the risk) prevents the
  // enclosing comment from terminating early. (forge#1594; noted but never fixed
  // for the FORGE:STATE codec in bin/engine/state.mjs — see issue investigation)
  return folded.replace(/--(!)?>/g, (_, bang) => `--${bang || ''}&gt;`);
}

/**
 * Emit a well-formed FORGE annotation string.
 *
 * @param {string} type  - Annotation type (e.g. "INVESTIGATOR", "KNOWLEDGE_GIST")
 * @param {Object} [fields={}]  - Key/value pairs to include as **Key**: value lines,
 *   OR for inline-value types, pass { value: 'https://...' }
 * @returns {string}
 */
export function emit(type, fields = {}) {
  if (typeof type !== 'string' || !type) {
    throw new TypeError('emit() requires a non-empty type string');
  }

  const upperType = type.toUpperCase();
  const typeDef = RESERVED_TYPES[upperType];

  // Inline-value form (§3.4)
  if (typeDef?.inlineValue) {
    const value = fields.value ?? '';
    return `<!-- FORGE:${upperType}: ${sanitizeFieldValue(value)} -->`;
  }

  // Control marker form (§4.3) — just the tag, no body
  if (typeDef?.controlMarker) {
    return `<!-- FORGE:${upperType} -->`;
  }

  // Full annotation form
  const lines = [`<!-- FORGE:${upperType} -->`];

  // Emit each field as a **Key**: value line
  const fieldEntries = Object.entries(fields);
  if (fieldEntries.length > 0) {
    for (const [key, val] of fieldEntries) {
      lines.push(`**${key}**: ${sanitizeFieldValue(val)}`);
    }
  }

  // Completion sentinel (§3.2)
  if (typeDef?.completionSentinel) {
    lines.push(`<!-- ${typeDef.completionSentinel} -->`);
  }

  return lines.join('\n');
}

/**
 * Emit a partial sentinel for an annotation that was interrupted.
 * Spec §3.3: producers MAY mark interrupted annotations partial.
 *
 * @param {string} type
 * @returns {string}
 */
export function emitPartial(type) {
  const upperType = type.toUpperCase();
  const typeDef = RESERVED_TYPES[upperType];

  if (typeDef?.partialSentinel) {
    return `<!-- ${typeDef.partialSentinel} -->`;
  }
  // Fallback generic form
  return `<!-- ${upperType}:PARTIAL -->`;
}

/**
 * Check if a type is known/reserved.
 *
 * @param {string} type
 * @returns {boolean}
 */
export function isKnownType(type) {
  return RESERVED_TYPE_NAMES.has(typeof type === 'string' ? type.toUpperCase() : type);
}
