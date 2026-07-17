/**
 * FORGE Annotation Protocol v1.0 — type definitions and constants.
 * @license MIT
 */

/** @enum {string} Annotation categories */
export const Category = {
  LIFECYCLE: 'lifecycle',
  CROSS_ARTIFACT: 'cross_artifact',
  CONTROL: 'control',
};

/** @enum {string} Sentinel states */
export const SentinelState = {
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  INTERRUPTED: 'interrupted',
};

/**
 * All reserved annotation types from spec §4.
 * Spec ref: §4.1 lifecycle, §4.2 cross-artifact, §4.3 control/error markers.
 * Added CLAIM and CLAIM_RELEASED in forge#1736 — claims board for claim-level parallelism.
 * Added AUTOPILOT_CYCLE in forge#1753 — durable cycle state for /autopilot.
 */
export const RESERVED_TYPES = {
  // §4.1 Lifecycle annotations
  INVESTIGATOR: {
    type: 'INVESTIGATOR',
    category: Category.LIFECYCLE,
    completionSentinel: 'INVESTIGATION:COMPLETE',
    partialSentinel: null,
    inlineValue: false,
    requiredFields: ['Verdict', 'Confidence', 'Severity', 'Task Type', 'Decomposition Assessment'],
    verdictValues: ['CONFIRMED', 'PARTIAL', 'INVALID'],
    confidenceValues: ['HIGH', 'MEDIUM', 'LOW'],
    severityValues: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
    taskTypeValues: ['Bug Fix', 'Feature', 'Refactor', 'Maintenance', 'Investigation'],
  },
  DECOMPOSED: {
    type: 'DECOMPOSED',
    category: Category.LIFECYCLE,
    completionSentinel: 'FORGE:DECOMPOSED:COMPLETE',
    partialSentinel: null,
    inlineValue: false,
    requiredFields: [],
  },
  CONTRACT: {
    type: 'CONTRACT',
    category: Category.LIFECYCLE,
    completionSentinel: null, // no explicit completion sentinel defined in spec §4.1
    partialSentinel: null,
    inlineValue: false,
    requiredFields: ['Task type'],
  },
  CONTEXT: {
    type: 'CONTEXT',
    category: Category.LIFECYCLE,
    completionSentinel: 'FORGE:CONTEXT:COMPLETE',
    partialSentinel: 'FORGE:CONTEXT:PARTIAL',
    inlineValue: false,
    requiredFields: [],
  },
  ARCHITECT: {
    type: 'ARCHITECT',
    category: Category.LIFECYCLE,
    completionSentinel: 'FORGE:ARCHITECT:COMPLETE',
    partialSentinel: 'FORGE:ARCHITECT:PARTIAL',
    inlineValue: false,
    requiredFields: [],
  },
  BUILDER: {
    type: 'BUILDER',
    category: Category.LIFECYCLE,
    completionSentinel: 'FORGE:BUILDER:COMPLETE',
    partialSentinel: null,
    inlineValue: false,
    requiredFields: ['Branch', 'Commits', 'Files changed'],
  },
  REVIEWER: {
    type: 'REVIEWER',
    category: Category.LIFECYCLE,
    completionSentinel: null, // spec §4.1 does not define a sentinel for REVIEWER
    partialSentinel: null,
    inlineValue: false,
    requiredFields: ['Verdict'],
    verdictValues: ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'],
  },
  /**
   * REMEDIATION — paper trail for a needs-human PR re-driven by
   * commands/work-on/remediate.md. Posted to BOTH the PR and the linked
   * issue (Phase M8) once the re-gate outcome (AUTO-LANDED /
   * HELD-AWAITING-MERGE / RE-ESCALATED / UNFIXABLE) is known. Added in
   * forge#2379 to single-source the completion sentinel that
   * bin/engine/phases.mjs's `remediate` phase gates on. <!-- Added: forge#2379 -->
   */
  REMEDIATION: {
    type: 'REMEDIATION',
    category: Category.LIFECYCLE,
    completionSentinel: 'FORGE:REMEDIATION:COMPLETE',
    partialSentinel: null,
    inlineValue: false,
    requiredFields: [],
    reGateOutcomeValues: ['AUTO-LANDED', 'HELD-AWAITING-MERGE', 'RE-ESCALATED', 'UNFIXABLE'],
  },
  TRAJECTORY: {
    type: 'TRAJECTORY',
    category: Category.LIFECYCLE,
    completionSentinel: null,
    partialSentinel: null,
    inlineValue: false,
    requiredFields: [],
  },
  /**
   * AUTOPILOT_CYCLE — durable record of one /autopilot execution cycle.
   * Posted as a comment on the designated ops issue (label: autopilot-ops) at
   * the end of every cycle so that cycle N+1 can read baseline metrics, compute
   * deltas, and resume an interrupted cycle without re-executing committed phases.
   *
   * Required fields:
   *   cycle_id      — unique cycle identifier (e.g. "20260708-1" — date + counter)
   *   timestamp     — ISO-8601 UTC timestamp of cycle start
   *   baseline      — snapshot of key metrics at cycle start (JSON-encoded string)
   *   phase_markers — comma-separated list of completed phase names for resume
   *
   * Completion sentinel: <!-- FORGE:AUTOPILOT_CYCLE:COMPLETE -->
   * <!-- Added: forge#1753 — durable cycle state + baseline deltas + resume -->
   */
  AUTOPILOT_CYCLE: {
    type: 'AUTOPILOT_CYCLE',
    category: Category.LIFECYCLE,
    completionSentinel: 'FORGE:AUTOPILOT_CYCLE:COMPLETE',
    partialSentinel: null,
    inlineValue: false,
    requiredFields: ['cycle_id', 'timestamp', 'baseline', 'phase_markers'],
  },
  /**
   * CLAIM — an agent's active resource reservation, posted on the coordination issue
   * (claims board) when the agent begins implementation under an orchestration batch.
   * Required fields:
   *   Holder     — the issue/run reference holding this claim (e.g. "#1736 / run-abc")
   *   Files      — newline-separated list of claimed file paths
   *   Interfaces — preserved interface contracts (function signatures, API shapes)
   *   TTL        — auto-expire condition ("terminal state of Holder issue")
   * Released by posting a CLAIM_RELEASED control marker referencing the same Holder.
   * <!-- Added: forge#1736 — claims board for claim-level parallelism -->
   */
  CLAIM: {
    type: 'CLAIM',
    category: Category.LIFECYCLE,
    completionSentinel: 'CLAIM:COMPLETE',
    partialSentinel: null,
    inlineValue: false,
    requiredFields: ['Holder', 'Files', 'Interfaces', 'TTL'],
  },

  // §4.2 Cross-artifact annotations
  KNOWLEDGE_GIST: {
    type: 'KNOWLEDGE_GIST',
    category: Category.CROSS_ARTIFACT,
    completionSentinel: null,
    partialSentinel: null,
    inlineValue: true,
    requiredFields: [],
  },
  MILESTONE_INDEX: {
    type: 'MILESTONE_INDEX',
    category: Category.CROSS_ARTIFACT,
    completionSentinel: null,
    partialSentinel: null,
    inlineValue: true,
    requiredFields: [],
  },
  PRIOR_GIST: {
    type: 'PRIOR_GIST',
    category: Category.CROSS_ARTIFACT,
    completionSentinel: null,
    partialSentinel: null,
    inlineValue: true,
    requiredFields: [],
  },

  // §4.3 Control and error markers
  REVIEW_STARTED: {
    type: 'REVIEW_STARTED',
    category: Category.CONTROL,
    completionSentinel: null,
    partialSentinel: null,
    inlineValue: false,
    controlMarker: true,
    requiredFields: [],
  },
  ANCESTRY_FAILED: {
    type: 'ANCESTRY_FAILED',
    category: Category.CONTROL,
    completionSentinel: null,
    partialSentinel: null,
    inlineValue: false,
    controlMarker: true,
    requiredFields: [],
  },
  GATE_FAILED: {
    type: 'GATE_FAILED',
    category: Category.CONTROL,
    completionSentinel: null,
    partialSentinel: null,
    inlineValue: false,
    controlMarker: true,
    requiredFields: [],
  },
  PUSH_BLOCKED: {
    type: 'PUSH_BLOCKED',
    category: Category.CONTROL,
    completionSentinel: null,
    partialSentinel: null,
    inlineValue: false,
    controlMarker: true,
    requiredFields: [],
  },
  PUSH_FAILED: {
    type: 'PUSH_FAILED',
    category: Category.CONTROL,
    completionSentinel: null,
    partialSentinel: null,
    inlineValue: false,
    controlMarker: true,
    requiredFields: [],
  },
  /**
   * CLAIM_RELEASED — posted on the coordination issue when the Holder's issue reaches
   * a terminal state (workflow:merged, workflow:invalid, needs-human). Signals that all
   * files and interfaces declared in the preceding CLAIM annotation are no longer held.
   * Consumers MUST treat any CLAIM without a subsequent CLAIM_RELEASED from the same
   * Holder as expired when the Holder issue reaches a terminal state.
   * <!-- Added: forge#1736 — claims board for claim-level parallelism -->
   */
  CLAIM_RELEASED: {
    type: 'CLAIM_RELEASED',
    category: Category.CONTROL,
    completionSentinel: null,
    partialSentinel: null,
    inlineValue: false,
    controlMarker: true,
    requiredFields: [],
  },

  // §4.2 Machine-surface cross-artifact annotation (Base64url encoded — design decision 2026-07-08)
  // Format: <!-- FORGE:CARD: v1 sha:{sha8hex} b64:{base64url_of_canonical_json} -->
  // The inline value carries the full encoding: "v1 sha:XXXXXXXX b64:YYYYYY..."
  // This is an inline-value type — parse() extracts the full encoding as inlineValue.
  CARD: {
    type: 'CARD',
    category: Category.CROSS_ARTIFACT,
    completionSentinel: null,
    partialSentinel: null,
    inlineValue: true,
    requiredFields: [],
  },
};

/** Set of all reserved type strings for fast lookup */
export const RESERVED_TYPE_NAMES = new Set(Object.keys(RESERVED_TYPES));
