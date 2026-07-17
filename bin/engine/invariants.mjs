/**
 * bin/engine/invariants.mjs — ForgeDock pipeline invariant evaluator.
 *
 * Evaluates three classes of invariants declared in forge-invariants.yaml:
 *
 *   pretooluse  — preconditions checked in pre-tool-use.mjs before tool
 *                 execution (e.g. branch-must-exist-on-remote)
 *   runlog      — temporal ordering rules over the append-only run-log
 *                 (e.g. review-precedes-merge)
 *   close       — terminal-state assertions checked before trajectory post
 *                 (e.g. issue-closed-at-terminal)
 *
 * === Design constraints ===
 *
 * • No circular imports: only imports node:fs, node:child_process, node:path,
 *   node:url. Does NOT import engine.mjs or phases.mjs.
 * • Fail-open: every exported function returns a result object on error
 *   rather than throwing. A missing forge-invariants.yaml or yq returns [].
 * • Single-pass temporal evaluation: O(n) over the run-log event list.
 *   No GitHub API calls.
 * • Named violations: every failed result includes { ok: false, id, violated }
 *   so callers can surface the proposition by name.
 *
 * === Usage ===
 *
 * // Load all declared invariants:
 * const invariants = loadInvariants(forgeInvariantsYamlPath);
 *
 * // Evaluate temporal rules over a run-log event stream:
 * const results = evaluateTemporalRules(invariants, events);
 *
 * // Check a hook precondition (branch must exist):
 * const result = await checkPrecondition(invariants, "branch_must_exist_on_remote", { branch });
 *
 * // Assert close-time invariants before posting trajectory:
 * const results = assertCloseInvariants(invariants, events);
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// YAML loader — uses yq (pipeline dependency) for proper array support.
// forge-utils.mjs's minimal parser does not handle YAML sequences.
// ---------------------------------------------------------------------------

/**
 * Load invariant declarations from forge-invariants.yaml.
 *
 * Returns an empty array if:
 *   - forge-invariants.yaml is absent (fresh install before file ships)
 *   - yq is not installed (graceful degradation)
 *   - any parse error occurs
 *
 * @param {string} [yamlPath] Absolute path to forge-invariants.yaml.
 *   Defaults to {repo root}/forge-invariants.yaml resolved relative to
 *   this file's location.
 * @returns {Invariant[]}
 */
export function loadInvariants(yamlPath) {
  // Default: resolve relative to bin/engine/ → repo root / forge-invariants.yaml
  const DEFAULT_PATH = resolve(
    fileURLToPath(import.meta.url),
    "..", "..", "..", "forge-invariants.yaml",
  );
  const target = yamlPath || DEFAULT_PATH;

  if (!existsSync(target)) return []; // file absent — fail-open, not an error

  try {
    // Use yq to convert YAML → JSON (handles arrays; yq is a pipeline dep).
    const json = execFileSync("yq", ["-o", "json", ".", target], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    const parsed = JSON.parse(json);
    const items = parsed?.invariants;
    if (!Array.isArray(items)) return [];
    return items.filter(
      (i) => i && typeof i.id === "string" && typeof i.scope === "string",
    );
  } catch {
    // yq not installed, parse error, or any other failure — fail-open.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Temporal rule evaluation (single-pass, O(n), no I/O)
// ---------------------------------------------------------------------------

/**
 * Evaluate all runlog-scope invariants against an event list.
 *
 * @param {Invariant[]} invariants  Full invariant list from loadInvariants().
 * @param {object[]}    events      Event list from readLog() / deriveState().
 * @returns {InvariantResult[]}
 */
export function evaluateTemporalRules(invariants, events) {
  const rules = invariants.filter((i) => i.scope === "runlog");
  if (!rules.length || !events.length) return rules.map((r) => ({ ok: true, id: r.id }));

  // Single-pass: collect per-event-type positions.
  const phaseCommits = {}; // phase id → first commit seq
  let firstTerminal = null;
  let terminalCount = 0;
  let terminalReason = null;

  for (const e of events) {
    if (e.event === "PHASE_COMMIT" && e.phase) {
      if (!(e.phase in phaseCommits)) phaseCommits[e.phase] = e.seq;
    } else if (e.event === "RUN_TERMINAL") {
      terminalCount++;
      if (firstTerminal === null) { firstTerminal = e.seq; terminalReason = e.reason; }
    }
  }

  return rules.map((r) => {
    try {
      return evaluateOneRule(r, { phaseCommits, firstTerminal, terminalCount, terminalReason });
    } catch {
      return { ok: true, id: r.id }; // evaluator error → fail-open
    }
  });
}

function evaluateOneRule(rule, { phaseCommits, firstTerminal, terminalCount, terminalReason }) {
  switch (rule.id) {
    case "review_precedes_merge": {
      // Only check when the run ended with 'merged'.
      if (terminalReason !== "merged") return { ok: true, id: rule.id };
      const reviewSeq = phaseCommits["review"] ?? null;
      if (reviewSeq === null || (firstTerminal !== null && reviewSeq > firstTerminal)) {
        return {
          ok: false, id: rule.id,
          violated: rule.proposition,
          detail: `RUN_TERMINAL(merged) at seq ${firstTerminal} but no PHASE_COMMIT(review) precedes it`,
        };
      }
      return { ok: true, id: rule.id };
    }

    case "gate_event_precedes_review": {
      const buildSeq = phaseCommits["build"] ?? null;
      const reviewSeq = phaseCommits["review"] ?? null;
      if (reviewSeq !== null && (buildSeq === null || buildSeq > reviewSeq)) {
        return {
          ok: false, id: rule.id,
          violated: rule.proposition,
          detail: `PHASE_COMMIT(review) at seq ${reviewSeq} but PHASE_COMMIT(build) ${buildSeq === null ? "absent" : `at seq ${buildSeq} (after review)`}`,
        };
      }
      return { ok: true, id: rule.id };
    }

    case "terminal_state_once": {
      if (terminalCount > 1) {
        return {
          ok: false, id: rule.id,
          violated: rule.proposition,
          detail: `RUN_TERMINAL appears ${terminalCount} times in run-log (expected ≤1)`,
        };
      }
      return { ok: true, id: rule.id };
    }

    default:
      // Unknown runlog invariant ID — fail-open (future invariants not yet in evaluator).
      return { ok: true, id: rule.id };
  }
}

// ---------------------------------------------------------------------------
// Hook precondition checks (async — may shell out for git ls-remote)
// ---------------------------------------------------------------------------

/**
 * Evaluate a named pretooluse-scope precondition.
 *
 * @param {Invariant[]} invariants  Full invariant list from loadInvariants().
 * @param {string}      id         Invariant ID to evaluate.
 * @param {object}      context    Evaluation context (e.g. { branch, repoPath }).
 * @returns {Promise<InvariantResult>}
 */
export async function checkPrecondition(invariants, id, context) {
  const inv = invariants.find((i) => i.scope === "pretooluse" && i.id === id);
  if (!inv) return { ok: true, id }; // not declared — fail-open

  try {
    return await evaluateOnePrecondition(inv, context);
  } catch {
    return { ok: true, id }; // evaluator error → fail-open
  }
}

/**
 * Evaluate all pretooluse-scope preconditions matching a named context.
 * Returns all results so the caller can surface the first failure.
 *
 * @param {Invariant[]} invariants
 * @param {object}      context
 * @returns {Promise<InvariantResult[]>}
 */
export async function checkAllPreconditions(invariants, context) {
  const rules = invariants.filter((i) => i.scope === "pretooluse");
  const results = [];
  for (const r of rules) {
    try {
      results.push(await evaluateOnePrecondition(r, context));
    } catch {
      results.push({ ok: true, id: r.id }); // fail-open
    }
  }
  return results;
}

async function evaluateOnePrecondition(inv, context) {
  switch (inv.id) {
    case "branch_must_exist_on_remote": {
      const branch = context?.branch;
      if (!branch) return { ok: true, id: inv.id }; // no branch in context — skip

      // git ls-remote --exit-code: exits 0 if ref found, 2 if not found.
      // Use a cached local-only check first (avoids network round-trip when
      // the branch is already fetched).
      try {
        execFileSync("git", ["rev-parse", "--verify", `origin/${branch}`], {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
        });
        return { ok: true, id: inv.id }; // local origin ref exists
      } catch {
        // Not in local refs — fall through to remote check.
      }

      try {
        const url = getRemoteUrl();
        if (!url) return { ok: true, id: inv.id }; // no remote configured — fail-open

        execFileSync("git", ["ls-remote", "--exit-code", "origin", branch], {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10000,
        });
        return { ok: true, id: inv.id }; // remote ref found
      } catch (e) {
        const exitCode = e?.status ?? null;
        if (exitCode === 2) {
          // Exit code 2 from ls-remote means ref not found.
          return {
            ok: false, id: inv.id,
            violated: inv.proposition,
            detail: `Branch '${branch}' not found on origin — checkout would fail`,
          };
        }
        // Other errors (network, auth, etc.) → fail-open.
        return { ok: true, id: inv.id };
      }
    }

    default:
      return { ok: true, id: inv.id }; // unknown precondition — fail-open
  }
}

function getRemoteUrl() {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    }).trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Close-time assertions (synchronous — run-log only, no I/O)
// ---------------------------------------------------------------------------

/**
 * Assert close-scope invariants before the trajectory annotation is posted.
 * These run in the close phase after the PR is merged and issue is closed.
 *
 * @param {Invariant[]} invariants  Full invariant list from loadInvariants().
 * @param {object[]}    events      Event list from readLog().
 * @returns {InvariantResult[]}
 */
export function assertCloseInvariants(invariants, events) {
  const assertions = invariants.filter((i) => i.scope === "close");
  if (!assertions.length) return [];

  return assertions.map((a) => {
    try {
      return evaluateOneCloseAssertion(a, events);
    } catch {
      return { ok: true, id: a.id }; // evaluator error → fail-open
    }
  });
}

function evaluateOneCloseAssertion(assertion, events) {
  switch (assertion.id) {
    case "run_log_terminal_at_close": {
      const hasTerminal = events.some((e) => e.event === "RUN_TERMINAL");
      if (!hasTerminal) {
        return {
          ok: false, id: assertion.id,
          violated: assertion.proposition,
          detail: "RUN_TERMINAL event absent from run-log — pipeline may have exited abnormally",
        };
      }
      return { ok: true, id: assertion.id };
    }

    case "issue_closed_at_terminal":
      // forge#2352: this assertion is enforced inside the engine itself now —
      // not just "evaluated externally" as the previous version of this
      // comment claimed. Two real, wired-up call sites cover it:
      //   1. bin/engine.mjs's runIssue() phase loop: a per-iteration
      //      divergence guard (`issueSnapshot()` from bin/engine/phases.mjs)
      //      that terminates the run ("invalid" or "needs-human") the moment
      //      the issue's live GitHub state/labels diverge from the local
      //      run-log, for every phase except `close`.
      //   2. The `close` phase's own reconcile/detectOutcome
      //      (bin/engine/phases.mjs), which is exempt from (1) because
      //      reading and acting on exactly this state IS its job.
      // This function has no GitHub I/O access (it's a pure assertion
      // evaluator — see the module header), so it cannot re-verify the live
      // issue state itself; it stays a structural pass-through by design.
      // The real enforcement lives in the two call sites above — this case
      // exists so `assertCloseInvariants` callers get a defined, non-throwing
      // result for this assertion id rather than an unhandled default.
      return { ok: true, id: assertion.id };

    default:
      return { ok: true, id: assertion.id }; // unknown close assertion — fail-open
  }
}

// ---------------------------------------------------------------------------
// Convenience: format a violation for human output
// ---------------------------------------------------------------------------

/**
 * Format a failed InvariantResult into a human-readable block.
 * Safe to call on ok:true results (returns null).
 *
 * @param {InvariantResult} result
 * @returns {string|null}
 */
export function formatViolation(result) {
  if (result.ok) return null;
  return [
    `[ForgeDock] INVARIANT VIOLATION: ${result.id}`,
    ``,
    `Violated proposition: "${result.violated}"`,
    result.detail ? `Detail: ${result.detail}` : "",
  ].filter((l) => l !== undefined).join("\n");
}

// ---------------------------------------------------------------------------
// JSDoc types
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, scope: string, proposition: string, enforcement: string, description?: string }} Invariant
 * @typedef {{ ok: boolean, id: string, violated?: string, detail?: string }} InvariantResult
 */
