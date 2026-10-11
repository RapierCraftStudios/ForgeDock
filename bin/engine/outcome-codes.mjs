/**
 * Closed, versioned enum of engine outcome codes (forge#3833).
 *
 * Every PHASE_FAILED, blocked PHASE_COMMIT and RUN_TERMINAL run-log event carries
 * one `code` from this enum so stall causes can be counted and grouped without a
 * model reading prose. Codes are derived in code from structured evidence
 * (REVIEW_RESULT fields, FORGE markers, `err.code`), never from free-text `detail`.
 * The free-text `reason`/`detail` stays alongside for humans. Documented in
 * docs/OUTCOME-CODES.md (a test asserts enum/doc parity). Pure module: no I/O.
 */

/** Bump when a code is renamed or removed; adding a code is additive. */
export const OUTCOME_CODES_VERSION = 1;

/** Fallback for an absent or unknown code; the raw reason is kept alongside. */
export const UNCLASSIFIED = "unclassified";

export const OUTCOME_CODES = Object.freeze({
  REVIEW_CHANGES_REQUESTED: "review.changes_requested",
  REVIEW_ESCALATED: "review.escalated",
  REVIEW_REREVIEW_SKIPPED: "review.rereview_skipped",
  BUILD_ACCEPTANCE_FAILED: "build.acceptance_failed",
  BUILD_ACCEPTANCE_MALFORMED: "build.acceptance_malformed",
  BUILD_SIZE_OVER_GATE: "build.size_over_gate",
  BUILD_COHESIVE: "build.cohesive",
  REMEDIATE_NO_MARKER: "remediate.no_marker",
  REMEDIATE_DEFERRED_LIVE_RUN: "remediate.deferred_live_run",
  REMEDIATE_RE_ESCALATED: "remediate.re_escalated",
  REMEDIATE_UNFIXABLE: "remediate.unfixable",
  CI_RED: "ci.red",
  CI_TIMEOUT: "ci.timeout",
  BASE_CONFLICT: "base.conflict",
  RATE_LIMITED: "rate_limited",
  ENGINE_ERROR: "engine.error",
  LEASE_HELD: "lease.held",
  INVALID: "invalid",
  DECOMPOSED: "decomposed",
  // Non-failure terminals, so a RUN_TERMINAL for a healthy run is not counted as a gap.
  COMPLETED: "completed",
  AWAITING_MERGE: "awaiting_merge",
  UNCLASSIFIED,
});

const CODE_SET = new Set(Object.values(OUTCOME_CODES));

/** Every code, in declaration order. */
export const ALL_OUTCOME_CODES = Object.freeze([...CODE_SET]);

export function isOutcomeCode(code) {
  return typeof code === "string" && CODE_SET.has(code);
}

/** Absent or unknown -> `unclassified`; never throws. */
export function normalizeCode(code) {
  return isOutcomeCode(code) ? code : UNCLASSIFIED;
}

/** Code for a thrown runner error, from `err.code` / session-limit evidence only. */
export function codeForRunnerError(err) {
  if (!err || typeof err !== "object") return UNCLASSIFIED;
  if (err.usageLimit === true || (typeof err.resetAtEpochMs === "number" && Number.isFinite(err.resetAtEpochMs)))
    return OUTCOME_CODES.RATE_LIMITED;
  switch (err.code) {
    case "NO_API_KEY":
    case "NO_SDK":
    case "CLI_BACKEND_FAILED":
    case "PHASE_ARGS_INVALID":
    case "CLI_MAX_TURNS":
      return OUTCOME_CODES.ENGINE_ERROR;
    default:
      return UNCLASSIFIED;
  }
}

/**
 * Default code for a terminal reason when the producer supplied none. Only reasons that
 * name one cause map; `needs-human` has many causes, so it stays `unclassified`.
 */
export function codeForTerminalReason(reason) {
  switch (reason) {
    case "merged":
    case "phase-complete":
    case "investigation":
      return OUTCOME_CODES.COMPLETED;
    case "awaiting-merge": return OUTCOME_CODES.AWAITING_MERGE;
    case "invalid": return OUTCOME_CODES.INVALID;
    case "decomposed": return OUTCOME_CODES.DECOMPOSED;
    case "engine-error": return OUTCOME_CODES.ENGINE_ERROR;
    case "deferred": return OUTCOME_CODES.LEASE_HELD;
    default: return UNCLASSIFIED;
  }
}
