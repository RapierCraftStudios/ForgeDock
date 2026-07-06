/**
 * @forgedock/protocol — FORGE Annotation Protocol v1.0 reference implementation.
 *
 * Provides parse, validate, and emit for all 13 reserved annotation types
 * defined in the FORGE Annotation Protocol specification (CC-BY-4.0).
 *
 * @example
 * import { parse, validate, emit } from '@forgedock/protocol';
 *
 * // Parse annotations from a GitHub issue/PR comment body
 * const annotations = parse(commentBody);
 *
 * // Validate a parsed annotation
 * const { valid, errors } = validate(annotations[0]);
 *
 * // Emit a well-formed annotation string
 * const text = emit('INVESTIGATOR', {
 *   Verdict: 'CONFIRMED',
 *   Confidence: 'HIGH',
 *   Severity: 'MEDIUM',
 *   'Task Type': 'Bug Fix',
 *   'Decomposition Assessment': 'NO — single-file fix',
 * });
 *
 * @license MIT
 */

export { parse } from './parse.js';
export { validate } from './validate.js';
export { emit, emitPartial, isKnownType } from './emit.js';
export { RESERVED_TYPES, RESERVED_TYPE_NAMES, Category, SentinelState } from './types.js';

/**
 * @typedef {Object} ParsedAnnotation
 * @property {string} type - Annotation type identifier (e.g. "INVESTIGATOR")
 * @property {string} raw - Full annotation text including opening tag
 * @property {string} body - Markdown body (lines after opening tag)
 * @property {string|null} inlineValue - Value for inline-value form, null otherwise
 * @property {import('./types.js').SentinelState} sentinelState - complete/partial/interrupted
 * @property {boolean} isReserved - True if type is in the reserved set
 * @property {boolean} isControl - True if type is a control/error marker
 * @property {Object.<string,string>} fields - Extracted **Key**: value pairs
 */
