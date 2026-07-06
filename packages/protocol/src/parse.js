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
// Anchored to require the tag to be the ENTIRE (trimmed) line — a FORGE-tag-shaped
// substring embedded inside other line content (e.g. a **Commits**: field value that
// happens to mention a FORGE tag) is never a structural annotation opener. Every real
// FORGE tag emission (opening tags and sentinel markers alike) occupies its own line;
// this anchor makes "is the whole line" the structural test instead of a bare substring
// search, which previously let field-value text split/corrupt annotations. (forge#1524)
const OPENING_TAG_RE = /^\s*<!--\s*FORGE:([A-Z_]+)(?::\s*(.*?))?\s*-->\s*$/;

// Sentinel suffixes that appear as inline-values in tags that look like opening tags
// but are actually completion/partial markers, e.g. <!-- FORGE:CONTEXT:COMPLETE -->
const SENTINEL_SUFFIXES = new Set(['COMPLETE', 'PARTIAL']);

// Matches bold-key lines: **Key**: value  (used for field extraction)
const BOLD_FIELD_RE = /^\*\*([^*]+)\*\*\s*:\s*(.+)$/;

// Generic (unknown-type) sentinel patterns, anchored to a whole line — see
// resolveSentinelState() below for why anchoring matters. (forge#1594)
const GENERIC_COMPLETE_RE = /^\s*<!--\s*[A-Z_:]+:COMPLETE\s*-->\s*$/m;
const GENERIC_PARTIAL_RE = /^\s*<!--\s*[A-Z_:]+:PARTIAL\s*-->\s*$/m;

/**
 * Determine sentinel state for an annotation body given its type definition.
 *
 * @param {string} body
 * @param {object|undefined} typeDef
 * @returns {SentinelState}
 */
function resolveSentinelState(body, typeDef) {
  if (!typeDef) {
    // Unknown type — look for generic sentinel patterns. Anchored to require the
    // sentinel to occupy its own (trimmed) line — the same structural test as
    // OPENING_TAG_RE above. A field value that merely *mentions* sentinel-shaped
    // text (e.g. **Commits**: ... <!-- FORGE:BUILDER:COMPLETE -->) must not be
    // able to spoof completion; only a sentinel on its own line is real. (forge#1594)
    if (GENERIC_COMPLETE_RE.test(body)) return SentinelState.COMPLETE;
    if (GENERIC_PARTIAL_RE.test(body)) return SentinelState.PARTIAL;
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

  // Anchored to a whole line (with the `m` flag so `^`/`$` match at every line
  // boundary within body, not just start/end of the whole string) — a real
  // sentinel always occupies its own line (see emit.js, which always emits it
  // that way). This is the sentinel-detection mirror of the OPENING_TAG_RE
  // anchor above: an unanchored substring test previously let a field value
  // that merely *contains* the sentinel text (e.g. a **Commits** message quoting
  // it) spoof completion for an annotation that was never actually completed.
  // (forge#1594 — inverse of the #1524 opening-tag anchor gap)
  const completionPattern = new RegExp(
    `^\\s*<!--\\s*${escapeRegExp(typeDef.completionSentinel)}\\s*-->\\s*$`,
    'm',
  );
  if (completionPattern.test(body)) return SentinelState.COMPLETE;

  if (typeDef.partialSentinel) {
    const partialPattern = new RegExp(
      `^\\s*<!--\\s*${escapeRegExp(typeDef.partialSentinel)}\\s*-->\\s*$`,
      'm',
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
    const typeDefForTag = RESERVED_TYPES[type];

    // Sentinel lines like <!-- FORGE:CONTEXT:COMPLETE --> match the opening tag regex
    // because the regex captures "CONTEXT" as type and "COMPLETE" as inlineValue.
    // These are NOT new annotations — they are closing markers and must stay in
    // the preceding annotation's body. The inner body-accumulation loop handles
    // this by including such lines rather than breaking on them. However, if a
    // sentinel line appears at the very beginning (before any annotation), skip it.
    //
    // Exception: types that declare inlineValue: true (KNOWLEDGE_GIST, MILESTONE_INDEX,
    // PRIOR_GIST) use COMPLETE/PARTIAL as legitimate inline values, not sentinel markers
    // — e.g. <!-- FORGE:PRIOR_GIST: COMPLETE --> is a real annotation whose value is the
    // string "COMPLETE". Only guess "sentinel" for types that don't use inline-value form
    // (typeDefForTag?.inlineValue is false/undefined for all of those, including unknown
    // types where typeDefForTag itself is undefined). (forge#1526)
    if (
      rawInlineValue !== null &&
      SENTINEL_SUFFIXES.has(rawInlineValue) &&
      !typeDefForTag?.inlineValue
    ) {
      i++;
      continue;
    }

    const inlineValue = rawInlineValue;
    const typeDef = typeDefForTag;
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
        const bodyLineType = bodyLineMatch[1];
        const bodyLineInlineValue = bodyLineMatch[2] !== undefined ? bodyLineMatch[2].trim() : null;
        const bodyLineTypeDef = RESERVED_TYPES[bodyLineType];
        // Sentinel-like tags (COMPLETE/PARTIAL inline value) → include in body, don't break.
        // Exception: if bodyLineType is an inline-value type (KNOWLEDGE_GIST, MILESTONE_INDEX,
        // PRIOR_GIST), COMPLETE/PARTIAL is a genuine inline value for a NEW annotation, not a
        // sentinel — fall through to "True opening tag" below so it starts its own annotation
        // instead of being folded into the preceding one's body. (forge#1526)
        if (
          bodyLineInlineValue !== null &&
          SENTINEL_SUFFIXES.has(bodyLineInlineValue) &&
          !bodyLineTypeDef?.inlineValue
        ) {
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
