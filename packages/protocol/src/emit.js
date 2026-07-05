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
    return `<!-- FORGE:${upperType}: ${value} -->`;
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
      lines.push(`**${key}**: ${val}`);
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
