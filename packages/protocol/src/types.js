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
 * All 13 reserved annotation types from spec §4.
 * Spec ref: §4.1 lifecycle, §4.2 cross-artifact, §4.3 control/error markers.
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
  TRAJECTORY: {
    type: 'TRAJECTORY',
    category: Category.LIFECYCLE,
    completionSentinel: null,
    partialSentinel: null,
    inlineValue: false,
    requiredFields: [],
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

  // §4.2 Machine-surface cross-artifact annotation (Base64url encoded — design decision 2026-07-08)
  // Format: <!-- FORGE:CARD v1 sha:{sha8hex} b64:{base64url_of_canonical_json} -->
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
