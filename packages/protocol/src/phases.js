/**
 * Canonical FORGE pipeline phase table — single source of truth for phase ids
 * (in dispatch order) and the exact marker/label strings that indicate each
 * phase has committed.
 *
 * Consumers: `bin/engine/phases.mjs` (the authoritative engine gate) and
 * `bin/hooks/interactive-engine.mjs` (the interactive-session SubagentStop
 * hook) both import this module instead of hand-declaring their own copies
 * of the marker strings. Before this module existed, the two files carried
 * independent literal copies of the same strings and drifted out of sync at
 * least twice (forge#1669 established the strict `:COMPLETE` gate for
 * `context`/`architect`; forge#2375/PR#2395 then had to hand-patch the hook's
 * copy back into agreement with the engine's). See forge#2378.
 *
 * `completionMarker` values are sourced from `RESERVED_TYPES[*].completionSentinel`
 * wherever that reserved annotation type exists (INVESTIGATOR, CONTEXT,
 * ARCHITECT, BUILDER) — so the reserved-annotation registry in `types.js` and
 * this phase registry cannot drift apart for those four phases; there is
 * exactly one literal declaration of each of those marker strings in the
 * entire codebase, in `types.js`.
 *
 * `review` and `close` have no corresponding `RESERVED_TYPES` entry with a
 * matching sentinel today (`REVIEWER` has no `completionSentinel` defined in
 * spec §4.1; `close` is gated on a GitHub *label*, not a comment annotation),
 * so those two are declared directly in this file — still single-sourced
 * across the two consumers, just not additionally derived from `types.js`.
 *
 * @license MIT
 */

import { RESERVED_TYPES } from './types.js';

/** Phase ids, in canonical dispatch order (mirrors `commands/work-on.md`'s
 * "Universal Phase Dispatcher" table and `bin/engine/phases.mjs`'s `PHASES`
 * array).
 *
 * `decompose` and `remediate` (forge#2379) are branch phases, not part of the
 * six-phase linear happy path — `decompose` is reached only when `investigate`
 * signals `DECOMPOSE:YES`, and `remediate` only when `review` escalates to
 * `needs-human`. They are still declared here, in the exact same array
 * position `bin/engine/phases.mjs`'s `PHASES` array declares them, because
 * `scripts/check-phase-registry-drift.mjs` requires the two lists to match
 * index-for-index — see that file's own doc comment. */
export const PHASE_IDS = ['investigate', 'decompose', 'context', 'architect', 'build', 'review', 'remediate', 'close'];

/**
 * @typedef {Object} PhaseMarkerEntry
 * @property {string} [completionMarker] - marker/sentinel string (or label, for `close`)
 *   whose presence means this phase has committed.
 * @property {string} [invalidMarker] - (investigate only) marks the issue INVALID.
 * @property {string} [decomposedMarker] - (investigate only) marks the issue DECOMPOSED.
 * @property {string} [partialMarker] - sentinel for an interrupted/partial annotation.
 * @property {string} [presenceMarker] - bare annotation-opener substring, used only by
 *   phases whose completion is non-critical (see `context` below) — presence alone
 *   (without `:COMPLETE`) is enough to report a soft/visible skip rather than a hard fail.
 * @property {string} [completionLabel] - a GitHub issue *label* (not a comment marker)
 *   whose presence means this phase has committed. Only `close` uses this form.
 */

/** @type {Object.<string, PhaseMarkerEntry>} */
export const PHASE_MARKERS = {
  investigate: {
    completionMarker: RESERVED_TYPES.INVESTIGATOR.completionSentinel, // 'INVESTIGATION:COMPLETE'
    invalidMarker: 'INVESTIGATION:INVALID',
    decomposedMarker: 'DECOMPOSE:YES',
  },
  // forge#2379: `decompose` actually runs work-on/decompose (sub-issue
  // fan-out) once `investigate` hands off on `DECOMPOSE:YES` — see
  // bin/engine/phases.mjs's `decompose` phase entry for the handoff mechanics.
  decompose: {
    completionMarker: RESERVED_TYPES.DECOMPOSED.completionSentinel, // 'FORGE:DECOMPOSED:COMPLETE'
  },
  context: {
    completionMarker: RESERVED_TYPES.CONTEXT.completionSentinel, // 'FORGE:CONTEXT:COMPLETE'
    partialMarker: RESERVED_TYPES.CONTEXT.partialSentinel, // 'FORGE:CONTEXT:PARTIAL'
    // Bare presence marker: context is documented as non-critical (spec §7) — a
    // missing completion marker is a visible skip, not a hard fail. Only
    // bin/engine/phases.mjs's `context.detectOutcome` uses this bare form;
    // `context.reconcile` (and everything in interactive-engine.mjs) uses the
    // strict `completionMarker` above. Do not collapse these two fields.
    presenceMarker: `FORGE:${RESERVED_TYPES.CONTEXT.type}`, // 'FORGE:CONTEXT'
  },
  architect: {
    completionMarker: RESERVED_TYPES.ARCHITECT.completionSentinel, // 'FORGE:ARCHITECT:COMPLETE'
    partialMarker: RESERVED_TYPES.ARCHITECT.partialSentinel, // 'FORGE:ARCHITECT:PARTIAL'
  },
  build: {
    completionMarker: RESERVED_TYPES.BUILDER.completionSentinel, // 'FORGE:BUILDER:COMPLETE'
  },
  review: {
    // No RESERVED_TYPES entry defines this sentinel (REVIEWER has no
    // completionSentinel in spec §4.1) — declared directly here.
    completionMarker: 'FORGE:REVIEWER:MERGED',
  },
  // forge#2379: `remediate` re-drives a needs-human PR (commands/work-on/remediate.md).
  // Posted to BOTH the PR and the linked issue (Phase M8) — bin/engine/phases.mjs's
  // `remediate` phase reads it off the issue, consistent with every other phase here.
  remediate: {
    completionMarker: RESERVED_TYPES.REMEDIATION.completionSentinel, // 'FORGE:REMEDIATION:COMPLETE'
  },
  close: {
    // A GitHub label, not a comment marker — see `completionLabel` above.
    completionLabel: 'workflow:merged',
  },
};

/**
 * Per-phase JSON-schema-shaped input contracts for the `report_result` tool
 * (forge#2380). This is the schema-enforced counterpart to `PHASE_MARKERS`
 * above: instead of a phase asserting completion by posting an exact-substring
 * marker in a GitHub comment (parsed post-hoc, out-of-band), the API-backend
 * tool loop (`bin/runner.mjs`) requires a validated `report_result` tool call
 * carrying one of these shapes before it will let the phase terminate.
 *
 * Single-sourced the same way `PHASE_MARKERS` is: `enum` constraints are
 * pulled from `RESERVED_TYPES[*]` wherever an equivalent enum already exists
 * there (`INVESTIGATOR.verdictValues`, `REVIEWER.verdictValues`), rather than
 * re-declaring a second, potentially-drifting copy of the same value list.
 *
 * `context` and `architect` deliberately do NOT accept any "partial" or
 * "degraded" success value — forge#1669 (PR #1682) established that
 * `architect`'s marker gate must reject anything short of full `:COMPLETE`
 * because the architect's plan is the builder's primary implementation
 * guide, and PR #2400 made that strictness structural via `PHASE_MARKERS`
 * above. A schema that accepted e.g. `{ status: "partial" }` as valid input
 * here would silently reopen exactly the gap that decision closed — so
 * neither schema below defines a `status`/`complete` field at all; the sole
 * completion signal for those two phases is "the call validated", full stop.
 *
 * Not every phase id has a registered schema. Absence of a `PHASE_IDS` entry
 * here is a deliberate, supported state — `validatePhaseResult()` treats an
 * unregistered phase id as "nothing to enforce" (`{ valid: true, errors: [] }`),
 * and `bin/runner.mjs`'s loop only engages `report_result` enforcement for
 * phases that DO have a schema.
 *
 * @typedef {Object} JsonSchemaLite
 * @property {'object'} type
 * @property {Object.<string, {type: string, enum?: string[], items?: {type: string}}>} properties
 * @property {string[]} required
 */

/** @type {Object.<string, JsonSchemaLite>} */
export const PHASE_RESULT_SCHEMAS = {
  investigate: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: RESERVED_TYPES.INVESTIGATOR.verdictValues }, // CONFIRMED | PARTIAL | INVALID
      decompose: { type: 'boolean' },
      rootCause: { type: 'string' },
    },
    required: ['verdict', 'decompose'],
  },
  build: {
    type: 'object',
    properties: {
      branch: { type: 'string' },
      commits: { type: 'array', items: { type: 'string' } },
    },
    required: ['branch', 'commits'],
  },
  review: {
    type: 'object',
    properties: {
      pr: { type: 'number' },
      disposition: { type: 'string', enum: RESERVED_TYPES.REVIEWER.verdictValues }, // APPROVED | CHANGES_REQUESTED | COMMENTED
    },
    required: ['pr', 'disposition'],
  },
  close: {
    type: 'object',
    properties: {
      merged: { type: 'boolean' },
    },
    required: ['merged'],
  },
  // context/architect intentionally define no accepted fields beyond a free-form
  // `summary` — see the doc comment above for why no partial/degraded-success
  // value exists for either. A schema-valid call with an empty object `{}` is
  // sufficient completion signal; `summary` is optional metadata only.
  context: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
    },
    required: [],
  },
  architect: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
    },
    required: [],
  },
};

/**
 * Narrow `typeof` that also distinguishes arrays and null, matching the
 * vocabulary `PHASE_RESULT_SCHEMAS` above uses for its `type`/`items.type`
 * fields ('object', 'array', 'string', 'number', 'boolean', 'null').
 * @param {*} v
 * @returns {string}
 */
function typeOfForSchema(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/**
 * Validate a `report_result` tool call's input against the registered schema
 * for `phaseId`. This is intentionally a small, dependency-free subset of
 * JSON Schema — just what `PHASE_RESULT_SCHEMAS` above actually uses (object
 * type check, required-field presence, per-property type check, enum
 * membership, and one level of array `items.type` checking) — not a general
 * JSON Schema implementation.
 *
 * A `phaseId` with no registered schema returns `{ valid: true, errors: [] }`
 * ("nothing to enforce"), matching how `bin/runner.mjs`'s enforcement loop
 * only engages for phases that have one.
 *
 * @param {string} phaseId
 * @param {*} input - the `report_result` tool call's parsed `input` object.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePhaseResult(phaseId, input) {
  const schema = PHASE_RESULT_SCHEMAS[phaseId];
  if (!schema) return { valid: true, errors: [] };

  if (typeOfForSchema(input) !== 'object') {
    return { valid: false, errors: [`report_result input must be a JSON object, got "${typeOfForSchema(input)}"`] };
  }

  const errors = [];

  for (const field of schema.required) {
    if (!(field in input) || input[field] === '' || input[field] === null || input[field] === undefined) {
      errors.push(`Required field "${field}" is missing or empty`);
    }
  }

  for (const [key, def] of Object.entries(schema.properties)) {
    if (!(key in input)) continue;
    const value = input[key];
    const actualType = typeOfForSchema(value);
    if (def.type && actualType !== def.type) {
      errors.push(`Field "${key}" must be of type "${def.type}", got "${actualType}"`);
      continue;
    }
    if (def.enum && !def.enum.includes(value)) {
      errors.push(`Field "${key}" must be one of: ${def.enum.join(', ')} — got: ${JSON.stringify(value)}`);
    }
    if (def.type === 'array' && def.items && Array.isArray(value)) {
      value.forEach((item, i) => {
        const itemType = typeOfForSchema(item);
        if (def.items.type && itemType !== def.items.type) {
          errors.push(`Field "${key}[${i}]" must be of type "${def.items.type}", got "${itemType}"`);
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
