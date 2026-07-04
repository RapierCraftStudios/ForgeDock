/**
 * FORGE Annotation Protocol v1.0 — parser.
 *
 * parse(commentBody) → Array<ParsedAnnotation>
 *
 * Each ParsedAnnotation has:
 *   type        {string}   annotation type identifier (e.g. "INVESTIGATOR")
 *   raw         {string}   the full text of the annotation (opening tag + body)
 *   body        {string}   Markdown body (everything after the opening tag line)
 *   inlineValue {string|null}  value for inline-value form (§3.4), null otherwise
 *   sentinelState {SentinelState}  complete / partial / interrupted
 *   isReserved  {boolean}  true if type is in the reserved set (§4)
 *   isControl   {boolean}  true if type is a control/error marker (§4.3)
 *   fields      {Object}   key/value pairs extracted from bold-header lines
 *
 * @license MIT
 */

import { RESERVED_TYPES, RESERVED_TYPE_NAMES, SentinelState } from './types.js';

// Matches: <!-- FORGE:TYPE --> or <!-- FORGE:TYPE: value -->
const OPENING_TAG_RE = /<!--\s*FORGE:([A-Z_]+)(?::\s*(.*?))?\s*-->/;

// Sentinel suffixes that appear as inline-values in tags that look like opening tags
// but are actually completion/partial markers, e.g. <!-- FORGE:CONTEXT:COMPLETE -->
const SENTINEL_SUFFIXES = new Set(['COMPLETE', 'PARTIAL']);

// Matches bold-key lines: **Key**: value  (used for field extraction)
const BOLD_FIELD_RE = /^\*\*([^*]+)\*\*\s*:\s*(.+)$/;

/**
 * Determine sentinel state for an annotation body given its type definition.
 *
 * @param {string} body
 * @param {object|undefined} typeDef
 * @returns {SentinelState}
 */
function resolveSentinelState(body, typeDef) {
  if (!typeDef) {
    // Unknown type — look for generic sentinel patterns
    if (/<!--\s*[A-Z_:]+:COMPLETE\s*-->/.test(body)) return SentinelState.COMPLETE;
    if (/<!--\s*[A-Z_:]+:PARTIAL\s*-->/.test(body)) return SentinelState.PARTIAL;
    return SentinelState.INTERRUPTED;
  }

  if (typeDef.controlMarker) {
    // Control markers carry no body; their presence is the signal — treat as complete
    return SentinelState.COMPLETE;
  }

  if (!typeDef.completionSentinel) {
    // Types without a defined sentinel (CONTRACT, REVIEWER, TRAJECTORY) are
    // always treated as complete once they exist — there is no incompleteness signal.
    return SentinelState.COMPLETE;
  }

  const completionPattern = new RegExp(
    `<!--\\s*${escapeRegExp(typeDef.completionSentinel)}\\s*-->`,
  );
  if (completionPattern.test(body)) return SentinelState.COMPLETE;

  if (typeDef.partialSentinel) {
    const partialPattern = new RegExp(
      `<!--\\s*${escapeRegExp(typeDef.partialSentinel)}\\s*-->`,
    );
    if (partialPattern.test(body)) return SentinelState.PARTIAL;
  }

  return SentinelState.INTERRUPTED;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract **Key**: value fields from an annotation body.
 *
 * @param {string} body
 * @returns {Object.<string,string>}
 */
function extractFields(body) {
  const fields = {};
  for (const line of body.split('\n')) {
    const m = line.trim().match(BOLD_FIELD_RE);
    if (m) {
      fields[m[1].trim()] = m[2].trim();
    }
  }
  return fields;
}

/**
 * Parse all FORGE annotations from a comment body.
 *
 * Spec §3.1: an annotation ends at the next <!-- FORGE: tag or end of comment.
 * Spec §3.4: inline-value form — value is extracted directly from the tag.
 * Spec §7.2.4: unknown types are tolerated; never throw on them.
 *
 * @param {string} commentBody
 * @returns {Array<import('./index.js').ParsedAnnotation>}
 */
export function parse(commentBody) {
  if (typeof commentBody !== 'string') {
    throw new TypeError(`parse() expects a string, got ${typeof commentBody}`);
  }

  const lines = commentBody.split('\n');
  const annotations = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const tagMatch = line.match(OPENING_TAG_RE);

    if (!tagMatch) {
      i++;
      continue;
    }

    const type = tagMatch[1];
    const rawInlineValue = tagMatch[2] !== undefined ? tagMatch[2].trim() : null;

    // Sentinel lines like <!-- FORGE:CONTEXT:COMPLETE --> match the opening tag regex
    // because the regex captures "CONTEXT" as type and "COMPLETE" as inlineValue.
    // These are NOT new annotations — they are closing markers and must stay in
    // the preceding annotation's body. The inner body-accumulation loop handles
    // this by including such lines rather than breaking on them. However, if a
    // sentinel line appears at the very beginning (before any annotation), skip it.
    if (rawInlineValue !== null && SENTINEL_SUFFIXES.has(rawInlineValue)) {
      i++;
      continue;
    }

    const inlineValue = rawInlineValue;
    const typeDef = RESERVED_TYPES[type];
    const isControl = typeDef?.controlMarker === true;
    const isReserved = RESERVED_TYPE_NAMES.has(type);

    // Collect body lines until the next true annotation opening tag or end of comment.
    // Sentinel lines like <!-- FORGE:CONTEXT:COMPLETE --> match OPENING_TAG_RE but are
    // closing markers, not new annotation openings — include them in the body.
    const bodyLines = [];
    let j = i + 1;
    while (j < lines.length) {
      const bodyLineMatch = lines[j].match(OPENING_TAG_RE);
      if (bodyLineMatch) {
        const bodyLineInlineValue = bodyLineMatch[2] !== undefined ? bodyLineMatch[2].trim() : null;
        // Sentinel-like tags (COMPLETE/PARTIAL inline value) → include in body, don't break
        if (bodyLineInlineValue !== null && SENTINEL_SUFFIXES.has(bodyLineInlineValue)) {
          bodyLines.push(lines[j]);
          j++;
          continue;
        }
        // True opening tag → end this annotation's body
        break;
      }
      bodyLines.push(lines[j]);
      j++;
    }

    const body = bodyLines.join('\n');
    const raw = line + (body.length > 0 ? '\n' + body : '');
    const sentinelState = resolveSentinelState(body, typeDef);
    const fields = inlineValue !== null ? {} : extractFields(body);

    annotations.push({
      type,
      raw,
      body,
      inlineValue,
      sentinelState,
      isReserved,
      isControl,
      fields,
    });

    i = j;
  }

  return annotations;
}
