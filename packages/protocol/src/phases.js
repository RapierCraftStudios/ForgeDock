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
