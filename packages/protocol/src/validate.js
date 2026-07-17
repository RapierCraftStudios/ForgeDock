/**
 * FORGE Annotation Protocol v1.0 — validator.
 *
 * validate(annotation) → { valid: boolean, errors: string[] }
 *
 * Checks:
 *   - Completion sentinel presence (§3.2) — for types that define one
 *   - Required field presence (§4.1 per-type field tables)
 *   - Required field enum values (Verdict, Confidence, Severity, Task Type, Re-gate outcome)
 *   - Inline-value non-empty (§3.4)
 *   - CARD inline-value decodability + sha8 integrity (§4.2 — see card.js)
 *   - Partial sentinel marking (§3.3) — generates a warning, not an error
 *
 * @license MIT
 */

import { RESERVED_TYPES, SentinelState } from './types.js';
import { decodeCardInlineValue } from './card.js';

/**
 * Validate a parsed annotation against the spec.
 *
 * @param {import('./index.js').ParsedAnnotation} annotation
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validate(annotation) {
  if (!annotation || typeof annotation !== 'object') {
    throw new TypeError('validate() expects a ParsedAnnotation object');
  }

  const errors = [];
  const warnings = [];
  const { type, sentinelState, inlineValue, fields, isReserved, isControl } = annotation;

  // Unknown types: tolerate per §7.2.4 — no validation errors
  if (!isReserved) {
    return { valid: true, errors: [], warnings: [`Type "${type}" is not a reserved type; skipping field validation (§7.2.4)`] };
  }

  const typeDef = RESERVED_TYPES[type];

  // Control markers: presence is the signal; no body or fields to validate
  if (isControl) {
    return { valid: true, errors: [], warnings: [] };
  }

  // Inline-value form (§3.4): value must be non-empty
  if (typeDef.inlineValue) {
    if (inlineValue === null || inlineValue === '') {
      errors.push(`Inline-value annotation "${type}" must carry a non-empty value (§3.4)`);
    } else if (type === 'CARD') {
      // CARD-specific (§4.2): the inline value must decode via the Base64url
      // codec and pass its sha8 integrity check. A malformed encoding or a
      // tampered/corrupted payload must not be treated as a valid annotation.
      if (decodeCardInlineValue(inlineValue) === null) {
        errors.push(
          `Inline-value "CARD" annotation failed to decode or failed its sha8 integrity check (§4.2)`,
        );
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  // Completion sentinel check (§3.2): annotations with a defined sentinel must be complete.
  // Both PARTIAL and INTERRUPTED states mean the annotation is not safely consumable.
  if (typeDef.completionSentinel) {
    if (sentinelState === SentinelState.PARTIAL) {
      // Partial: producer was interrupted and marked it — consumer SHOULD request re-run (§3.3).
      // Treat as invalid since consumers MUST NOT treat it as complete (§3.2).
      errors.push(
        `Annotation "${type}" is marked PARTIAL (${typeDef.partialSentinel ?? 'PARTIAL sentinel'}) — not safe to consume (§3.2/§3.3)`,
      );
      warnings.push(
        `Annotation "${type}" is marked PARTIAL — consumer SHOULD request re-run (§3.3)`,
      );
    } else if (sentinelState === SentinelState.INTERRUPTED) {
      errors.push(
        `Annotation "${type}" is missing its completion sentinel "<!-- ${typeDef.completionSentinel} -->" (§3.2)`,
      );
    }
  }

  // Required field checks per type
  for (const fieldName of typeDef.requiredFields) {
    if (!(fieldName in fields) || fields[fieldName] === '') {
      errors.push(`Required field "${fieldName}" is missing or empty in "${type}" annotation`);
    }
  }

  // INVESTIGATOR-specific enum validation
  if (type === 'INVESTIGATOR') {
    if (fields['Verdict'] && !typeDef.verdictValues.includes(fields['Verdict'])) {
      errors.push(
        `Invalid Verdict "${fields['Verdict']}" — must be one of: ${typeDef.verdictValues.join(', ')}`,
      );
    }
    if (fields['Confidence'] && !typeDef.confidenceValues.includes(fields['Confidence'])) {
      errors.push(
        `Invalid Confidence "${fields['Confidence']}" — must be one of: ${typeDef.confidenceValues.join(', ')}`,
      );
    }
    if (fields['Severity'] && !typeDef.severityValues.includes(fields['Severity'])) {
      errors.push(
        `Invalid Severity "${fields['Severity']}" — must be one of: ${typeDef.severityValues.join(', ')}`,
      );
    }
    if (fields['Task Type'] && !typeDef.taskTypeValues.includes(fields['Task Type'])) {
      errors.push(
        `Invalid Task Type "${fields['Task Type']}" — must be one of: ${typeDef.taskTypeValues.join(', ')}`,
      );
    }
    // Decomposition Assessment must start with YES or NO
    if (fields['Decomposition Assessment']) {
      const da = fields['Decomposition Assessment'];
      if (!/^(YES|NO)\b/.test(da)) {
        errors.push(
          `Decomposition Assessment must start with "YES" or "NO", got: "${da}"`,
        );
      }
    }
  }

  // REVIEWER-specific enum validation
  if (type === 'REVIEWER') {
    if (fields['Verdict'] && !typeDef.verdictValues.includes(fields['Verdict'])) {
      errors.push(
        `Invalid Verdict "${fields['Verdict']}" — must be one of: ${typeDef.verdictValues.join(', ')}`,
      );
    }
  }

  // REMEDIATION-specific enum validation (forge#2450): the Re-gate outcome field is
  // optional at the required-field-presence layer (it is absent until
  // commands/work-on/remediate.md's Phase M8 posts it), but when present its value
  // must come from the single-sourced registry list — not a second hardcoded copy.
  //
  // Phase M8 posts this field as "**Re-gate outcome**: ${RE_GATE_OUTCOME} ${OUTCOME_DETAIL}"
  // (see commands/work-on/remediate.md), so the parsed field value carries trailing free-text
  // detail (e.g. "AUTO-LANDED to staging"), not just the bare outcome token. Only the leading
  // token is the actual outcome — extract it the same way bin/engine/phases.mjs's own
  // `/\*\*Re-gate outcome\*\*:\s*([A-Z-]+)/` regex does, so real production annotations with
  // trailing detail text are not falsely rejected.
  if (type === 'REMEDIATION') {
    const reGateOutcome = fields['Re-gate outcome'];
    if (reGateOutcome) {
      const outcomeToken = reGateOutcome.match(/^([A-Z-]+)/)?.[1] ?? reGateOutcome;
      if (!typeDef.reGateOutcomeValues.includes(outcomeToken)) {
        errors.push(
          `Invalid Re-gate outcome "${outcomeToken}" — must be one of: ${typeDef.reGateOutcomeValues.join(', ')}`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
