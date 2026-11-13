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
  REVIEW_BLOCKING_ISSUE: "review.blocking_issue",
  REVIEW_PR_OPEN: "review.pr_open",
  REVIEW_CI_PENDING_TIMEOUT: "review.ci_pending_timeout",
  BUILD_ACCEPTANCE_FAILED: "build.acceptance_failed",
  BUILD_ACCEPTANCE_MALFORMED: "build.acceptance_malformed",
  BUILD_SIZE_OVER_GATE: "build.size_over_gate", // retired (forge#3862): never emitted; kept so historic runs parse
  BUILD_COHESIVE: "build.cohesive", // retired (forge#3862): never emitted
  REMEDIATE_NO_MARKER: "remediate.no_marker",
  REMEDIATE_DEFERRED_LIVE_RUN: "remediate.deferred_live_run",
  REMEDIATE_RE_ESCALATED: "remediate.re_escalated",
  REMEDIATE_UNFIXABLE: "remediate.unfixable",
  REMEDIATE_INPR_REQUESTED: "remediate.inpr_requested",
  CI_RED: "ci.red",
  CI_DCO: "ci.dco", // forge#4651: a failed DCO check (or no identity to sign off the lane's commits); never recoverable: a new commit cannot fix history
  CI_TIMEOUT: "ci.timeout",
  BASE_CONFLICT: "base.conflict",
  RATE_LIMITED: "rate_limited",
  BACKEND_AUTH: "backend.auth", // forge#5168: the claude CLI login failed ("Failed to authenticate"); deferred under the account hold, never engine-error, never the breaker
  QUOTA_EXHAUSTED: "quota.exhausted", // forge#5236: no account has capacity (every login at its ceiling); deferred until the earliest reset, never backend.auth
  HOST_BUSY: "host.busy",
  GH_UNAVAILABLE: "gh.unavailable", // forge#4157: `gh` unreachable after retries during the --repo identity check; run deferred, nothing posted
  GH_AUTH: "gh.auth", // forge#4662: gh answered HTTP 401 and one token refresh did not fix it; run deferred, a rerun resumes
  MERGE_TRANSIENT: "merge.transient",
  PUSH_TRANSIENT: "push.transient",
  CLI_IDLE: "cli.idle",
  RUN_INTERRUPTED: "run.interrupted", // forge#4179: SIGTERM/SIGINT on a core run; teardown ran from the ledger, lane requeued
  PATH_SWITCH_CONFLICT: "path.switch_conflict",
  ENGINE_ERROR: "engine.error",
  ENGINE_DCO_REWRITE: "engine.dco_rewrite", // forge#4997: the DCO sign-off rewrite of unpushed commits failed (git filter-branch); mechanical engine-error (not needs-human), relaunched by the batch runner
  ENGINE_PUSH_DIVERGED: "engine.push_diverged", // forge#5202: the lane-branch push was rejected non-fast-forward, no other lane owns the branch, and the divergence is not the lane's own reconcilable checkpoints; mechanical engine-error (not needs-human), relaunched by the batch runner
  ENGINE_VALIDATE_RESULT_LOST: "engine.validate_result_lost", // forge#4708: a validate result recorded before a CI fix round is missing after it and could not be carried forward
  INFRA_DISK_QUOTA: "infra.disk_quota",
  INFRA_CLI_SPAWN_TRANSIENT: "infra.cli_spawn_transient",
  CLI_TIMEOUT: "cli.timeout",
  CLI_HOST_KILLED: "cli.host_killed", // forge#4518: the builder CLI was SIGTERM/SIGKILLed from outside (host, OOM guard, operator); deferred, never counted by the breaker
  CLI_SPAWN_FAILED: "cli.spawn_failed", // forge#4129: deterministic spawn failure (E2BIG, ENOENT, EACCES, ...)
  ENV_SETUP_FAILED: "env.setup_failed", // forge#4163: forge.yaml env.setup failed before the builder; an environment error, not a build failure
  ENV_TOOL_MISSING: "env.tool_missing", // forge#4323: a validate command could not run because a host tool or module is missing; an environment error, not a conformance failure
  ENV_REPRO_UNRUNNABLE: "env.repro_unrunnable", // forge#4334: the repro harness could not run the repro test on head; an environment error, not a conformance failure
  ENV_LANE_LIMIT: "env.lane_limit", // forge#4690: the lane hit its own scope limit (TasksMax or MemoryMax) and was stopped; an environment error, never an engine-error, so the breaker ignores it
  ENV_CAPABILITY_REMOTE: "env.capability_remote", // forge#4542: a remote sandbox lane blocked only on a host-only capability (SOPS key, ops credentials, prod monitor SSH) the dispatching host has; recovered locally
  SANDBOX_START_FAILED: "sandbox.start_failed", // forge#4254: a lane sandbox could not start (a non-auth 4xx/config error or a non-HTTP start failure); needs-human, not relaunched
  BASE_RED: "base.red", // forge#5239: a verify.invariants guard fails on the base too; the lane is deferred behind the introducing issue, never needs-human
  SANDBOX_CAPACITY: "sandbox.capacity", // forge#4254: the sandbox provider had no capacity; deferred with backoff
  SANDBOX_TRANSIENT: "sandbox.transient", // forge#5095: the sandbox provider answered a 5xx on launch (router/agent infrastructure); deferred with backoff, capped by max_deferrals, never needs-human
  SANDBOX_AUTH: "sandbox.auth", // forge#4685: the sandbox provider refused or lacked the credential (HTTP 401/403, no token); deferred, never needs-human
  SANDBOX_UNREACHABLE: "sandbox.unreachable", // forge#4672: the sandbox provider stayed unreachable past execution.unreachable_window_min; deferred, the sandbox is kept for adopt
  LEASE_HELD: "lease.held",
  DEPENDENCY_OPEN: "dependency.open",
  DESIGN_SPEC_REQUIRED: "design.spec_required", // forge#5330: a page under forge.yaml design.routes has no FORGE:DESIGN_SPEC and design.gate is blocking; needs-human until /design approves a spec
  DESIGN_INVALIDATED: "design.invalidated", // forge#5342: a lane found the plan wrong; one spike amendment filed, siblings held; the rework-share rollup counts it
  DEPENDENCY_UNREADABLE: "dependency.unreadable",
  DEPENDENCY_BLOCKED: "dependency.blocked",
  // Lane resolution refusals (#4125): before any lease, comment or worktree; terminal reason `lane-refused`.
  LANE_MISMATCH: "lane.mismatch",
  LANE_DEFAULT_BRANCH: "lane.default_branch",
  LANE_BRANCH_MISSING: "lane.branch_missing",
  LANE_UNRESOLVED: "lane.unresolved",
  INVALID: "invalid",
  DECOMPOSED: "decomposed",
  // Lean core work-on (bin/lean) needs-human causes.
  BUILDER_BLOCKED: "builder.blocked",
  BUILDER_BLOCK_UNTYPED: "builder.block_untyped",
  BUILDER_NO_EVIDENCE: "builder.no_evidence",
  BUILDER_NO_COMMIT: "builder.no_commit",
  BUDGET_EXCEEDED: "budget.exceeded", // forge#4392: the implement turn budget for the lane's size was spent and the wrap-up did not finish; digest in detail
  REVIEW_FAILED: "review.failed",
  REVIEW_NO_VERDICT: "review.no_verdict",
  // Core work-on conformance gate (bin/lean/conformance.mjs).
  CONTRACT_INVALID: "contract.invalid",
  CONTRACT_INVALID_COMMAND: "contract.invalid_command",
  REVIEW_INCOMPLETE: "review.incomplete",
  REVIEW_INCONSISTENT: "review.inconsistent",
  CONFORMANCE_OMISSION: "conformance.omission",
  CONFORMANCE_UNIMPLEMENTED: "conformance.unimplemented",
  CONFORMANCE_E2E_UNVERIFIED: "conformance.e2e_unverified",
  CONFORMANCE_SCOPE_CREEP: "conformance.scope_creep",
  CONFORMANCE_UNTRACKED_DEFERRAL: "conformance.untracked_deferral",
  CONFORMANCE_UNJUSTIFIED_DEFERRAL: "conformance.unjustified_deferral",
  CONFORMANCE_PRESERVE_VIOLATED: "conformance.preserve_violated",
  CONFORMANCE_REGRESSION: "conformance.regression",
  CONFORMANCE_GUARD_BROKEN: "conformance.guard_broken", // forge#4693: the base version of a merged fix's guarding test fails against the lane's tree
  STRUCTURE_UNDECLARED_EDGE: "structure.undeclared_edge", // forge#4159: a workspace package.json edge the contract does not name
  DOCS_STALE: "docs.stale", // the target repo's devdocs freshness rule still fails after one builder resume
  MAINTENANCE_HOTSPOT_GROWTH: "maintenance.hotspot_growth", // forge#4195: an over-threshold file grew past growth_lines without hotspot-exempt
  FOLLOWUP_UNAVAILABLE: "followup.unavailable",
  MERGE_HEAD_MISMATCH: "merge.head_mismatch",
  // refactor:split lane (forge#4211): deterministic refusals and the move proof; every one leaves no edit behind.
  SPLIT_UNSUPPORTED: "split.unsupported", // no codemod or index tool for the target language, or libcst or ts-morph missing; refused before any edit
  SPLIT_PLAN_INVALID: "split.plan_invalid", // missing target/test command, unparseable grouping reply, or a plan symbol-move refuses
  SPLIT_VERIFY_FAILED: "split.verify_failed", // refactor-verify found a logic diff, missing symbol, changed counts or new cycle; branch reset
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

const DISK_QUOTA_RE = /EDQUOT|ENOSPC|(?:errno|system error) -?(?:28|122)\b|No space left|Disk quota exceeded/i;

/** True when runner/stderr text reports a full disk or exhausted quota (forge#3572). Match runner error text only, never review prose. */
export function isDiskQuotaText(text) {
  return typeof text === "string" && DISK_QUOTA_RE.test(text);
}

/** True when a thrown runner error is a disk-full/quota failure (message, errno or stderr). */
export function isDiskQuotaError(err) {
  if (!err || typeof err !== "object") return false;
  if (err.code === "ENOSPC" || err.code === "EDQUOT" || err.errno === -28 || err.errno === -122) return true;
  return isDiskQuotaText(err.message) || isDiskQuotaText(err.stderr);
}

/** True when a thrown runner error is a transient CLI spawn failure (ETIMEDOUT/EAGAIN/ENOMEM/EMFILE at spawn), forge#4021. */
export function isTransientSpawnError(err) {
  return !!err && typeof err === "object" && err.code === "CLI_SPAWN_TRANSIENT";
}

/** Code for a thrown runner error, from `err.code` / session-limit evidence only. */
export function codeForRunnerError(err) {
  if (!err || typeof err !== "object") return UNCLASSIFIED;
  if (isDiskQuotaError(err)) return OUTCOME_CODES.INFRA_DISK_QUOTA;
  if (err.usageLimit === true || (typeof err.resetAtEpochMs === "number" && Number.isFinite(err.resetAtEpochMs)))
    return OUTCOME_CODES.RATE_LIMITED;
  if (err.authFailure === true) return OUTCOME_CODES.BACKEND_AUTH; // forge#5168
  switch (err.code) {
    case "CLI_SPAWN_TRANSIENT":
      return OUTCOME_CODES.INFRA_CLI_SPAWN_TRANSIENT;
    case "CLI_TIMEOUT":
      return OUTCOME_CODES.CLI_TIMEOUT;
    case "CLI_SPAWN_FAILED":
      return OUTCOME_CODES.CLI_SPAWN_FAILED;
    case "NO_API_KEY":
    case "NO_SDK":
    case "CLI_BACKEND_UNAVAILABLE":
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
    case "awaiting-merge":
    case "ci-pending":
      return OUTCOME_CODES.AWAITING_MERGE;
    case "invalid": return OUTCOME_CODES.INVALID;
    case "decomposed": return OUTCOME_CODES.DECOMPOSED;
    case "engine-error": return OUTCOME_CODES.ENGINE_ERROR;
    case "deferred": return OUTCOME_CODES.LEASE_HELD;
    case "dependency-open": return OUTCOME_CODES.DEPENDENCY_OPEN;
    case "dependency-unreadable": return OUTCOME_CODES.DEPENDENCY_UNREADABLE;
    case "dependency-blocked": return OUTCOME_CODES.DEPENDENCY_BLOCKED;
    case "budget-exceeded": return OUTCOME_CODES.BUDGET_EXCEEDED; // forge#4505: the non-human turn-overrun end
    default: return UNCLASSIFIED;
  }
}

/** forge#4906: a validate command timed out (exit 124) on the engine's rerun: infrastructure, not an unimplemented contract item. Kept outside OUTCOME_CODES (the base enum guard lists that enum); recoverable and mechanical like the other env codes. */
export const ENV_VALIDATE_TIMEOUT = "env.validate_timeout";
/** forge#5371: a remote-placed lane's frozen validate failed in the sandbox; the host reruns it in a local recovery lane (a pass there is the change, a fail stays conformance.unimplemented). Outside OUTCOME_CODES like ENV_VALIDATE_TIMEOUT. */
export const ENV_VALIDATE_PLACEMENT = "env.validate_placement";

/**
 * Batch recovery classes of a lane result (forge#4267). The batch runner recovers `recoverable` rows once
 * (`orchestration.recovery.max_attempts`) and re-queues them; only `human` rows are escalations.
 */
export const RECOVERABLE_CODES = Object.freeze([OUTCOME_CODES.CI_RED, OUTCOME_CODES.BASE_CONFLICT, OUTCOME_CODES.BUILDER_BLOCK_UNTYPED, OUTCOME_CODES.CONTRACT_INVALID, OUTCOME_CODES.CONTRACT_INVALID_COMMAND, OUTCOME_CODES.ENV_TOOL_MISSING, OUTCOME_CODES.ENV_REPRO_UNRUNNABLE, ENV_VALIDATE_TIMEOUT, ENV_VALIDATE_PLACEMENT, OUTCOME_CODES.ENV_CAPABILITY_REMOTE, OUTCOME_CODES.BUDGET_EXCEEDED, OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED, OUTCOME_CODES.CONFORMANCE_OMISSION, OUTCOME_CODES.CONFORMANCE_UNJUSTIFIED_DEFERRAL]);
/** `builder.blocked` is only reached by a typed human block: credentials, spend, promotion, customer, product-decision. */
export const HUMAN_CODES = Object.freeze([OUTCOME_CODES.BUILDER_BLOCKED]);

/**
 * `recoverable` | `human` | `terminal` for a lane result row ({outcome|terminalReason, code, issueEdited?, conflicting?}).
 * Recoverable: needs-human `ci.red`, `base.conflict`, `builder.block_untyped`, `env.tool_missing`, `env.repro_unrunnable`, `env.validate_timeout`, `env.capability_remote`, `budget.exceeded`, `conformance.unimplemented` / `conformance.omission` / `conformance.unjustified_deferral` (#5035; regression, guard_broken, scope_creep and e2e_unverified stay terminal), `contract.invalid` after a mid-run issue
 * edit (`issueEdited`) or when every problem was an unmatched quote (`quoteMismatch`), `ci-pending` on a conflicting PR (`conflicting`), and the non-human `budget-exceeded` turn-overrun end (forge#4505). Human: `builder.blocked`. Anything else
 * (another code, or not a needs-human/ci-pending row) is terminal. Pure, never throws.
 */
export function classifyNeedsHuman(row, { parked = false } = {}) {
  const cls = classifyNeedsHumanBase(row);
  // forge#4656: opt-in `parked` class: a needs-human row ended on a mechanical terminal code (not a human block, not recoverable).
  return parked && cls === "terminal" && isTerminalCodeRow(row) ? "parked" : cls;
}

function isTerminalCodeRow(row) {
  return (row.outcome ?? row.terminalReason) === "needs-human" && typeof row.code === "string" && row.code !== "" && row.code !== UNCLASSIFIED;
}

function classifyNeedsHumanBase(row) {
  if (!row || typeof row !== "object") return "terminal";
  const outcome = row.outcome ?? row.terminalReason;
  if (outcome === "ci-pending") return row.conflicting === true ? "recoverable" : "terminal";
  if (outcome === "budget-exceeded") return "recoverable";
  if (outcome !== "needs-human") return "terminal";
  if (HUMAN_CODES.includes(row.code)) return "human";
  if (row.code === OUTCOME_CODES.CONTRACT_INVALID) return "recoverable"; // #5623: a fresh plan (one recovery requeue) before a person is asked
  return RECOVERABLE_CODES.includes(row.code) ? "recoverable" : "terminal";
}

/** forge#4725: mechanical/environment codes recover on their own budget (`recovery.mechanicalMaxAttempts`), apart from conformance failures. */
export const MECHANICAL_CODES = Object.freeze([OUTCOME_CODES.BASE_CONFLICT, OUTCOME_CODES.CONTRACT_INVALID_COMMAND, OUTCOME_CODES.ENV_TOOL_MISSING, OUTCOME_CODES.ENV_REPRO_UNRUNNABLE, ENV_VALIDATE_TIMEOUT, ENV_VALIDATE_PLACEMENT, OUTCOME_CODES.ENV_CAPABILITY_REMOTE]);

/** #5423: environment gaps the engine recovers itself: a first lane ending on one never labels the issue needs-human. */
export const ENV_ENGINE_OWNED_CODES = Object.freeze([OUTCOME_CODES.ENV_TOOL_MISSING, ENV_VALIDATE_PLACEMENT, ENV_VALIDATE_TIMEOUT, OUTCOME_CODES.ENV_CAPABILITY_REMOTE, OUTCOME_CODES.ENV_REPRO_UNRUNNABLE]);

/** `mechanical` | `conformance`: the recovery budget class of a lane result row (a conflicting `ci-pending` is a base conflict). */
export function recoveryClassOf(row) {
  return MECHANICAL_CODES.includes(recoveryCodeOf(row)) ? "mechanical" : "conformance";
}

/** The code a recovery lane works on: a conflicting `ci-pending` is recovered as a base conflict. */
export function recoveryCodeOf(row) {
  return (row?.outcome ?? row?.terminalReason) === "ci-pending" ? OUTCOME_CODES.BASE_CONFLICT : row?.code === ENV_VALIDATE_PLACEMENT ? ENV_VALIDATE_PLACEMENT : normalizeCode(row?.code); // #5371: kept outside OUTCOME_CODES, so normalizeCode alone would drop it
}

/** forge#4656: the label of a human-owned wait (an owner and an unblock condition are required in its comment). */
export const NEEDS_HUMAN_EXTERNAL_LABEL = "needs-human:external";
/** forge#4656: the single remediation queue (`/work-on:remediate`) a parked issue moves to once recovery attempts run out. */
export const REMEDIATION_QUEUE_LABEL = "remediation-queue";
/** forge#4656: `parked:<terminal-code>` label of a mechanical park. */
export function parkedLabel(code) {
  return `parked:${String(code ?? UNCLASSIFIED).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 40) || UNCLASSIFIED}`;
}

/**
 * forge#4656 migration: classify a legacy bare `needs-human` issue from its last FORGE terminal annotation text.
 * `{ kind: "parked", code }` when the text names a mechanical terminal code, else `{ kind: "external" }` (the default).
 */
export function classifyLegacyNeedsHuman(annotation) {
  const text = String(annotation ?? "");
  const m = /\b(ci\.red|ci\.timeout|base\.conflict|review_incomplete|builder\.block_untyped|conformance\.[a-z_]+|contract\.invalid|env\.[a-z_]+)\b/i.exec(text);
  if (m) return { kind: "parked", code: m[1].toLowerCase() };
  return { kind: "external" };
}
