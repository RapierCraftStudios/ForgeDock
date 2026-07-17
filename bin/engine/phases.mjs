/**
 * Declarative phase table for the headless work-on pipeline. The ENGINE (not an
 * LLM) chooses the next phase via pickPhase. Each phase's outcome is read from
 * GitHub/git AFTER the run (detectOutcome); the runner's return is advisory.
 * @typedef ... (see plan "Shared types")
 */

// forge#2378: marker/label strings are single-sourced from packages/protocol's
// phase registry (itself derived from RESERVED_TYPES' completionSentinel fields
// where available) — do NOT reintroduce inline "FORGE:..."/"INVESTIGATION:..."/
// "workflow:merged" literals in this file. bin/hooks/interactive-engine.mjs
// imports the identical registry, so the two can no longer drift apart the way
// they did in forge#2375/PR#2395.
import { PHASE_MARKERS } from "../../packages/protocol/src/phases.js";
// forge#2381: close.execute() reuses the existing io.gh-based projector helpers
// instead of hand-rolling new gh calls, and evaluates close-scope invariants
// in-process via the existing (previously test-only) invariants.mjs API.
import { makeProjector } from "./projector.mjs";
import { loadInvariants, assertCloseInvariants } from "./invariants.mjs";
import { readLog } from "./runlog.mjs";

// forge#2261: "engine-error" is a distinct terminal reason for engine/tool-level
// failures (e.g. an exhausted retry loop where the runner itself never once
// succeeded, or a fail-fast CLI_BACKEND_FAILED/NO_API_KEY/NO_SDK throw) — kept
// separate from "needs-human" so it is never misclassified as a genuine
// human-judgment block by /orchestrate's classify_predecessor_state().
//
// forge#2379: "awaiting-merge" mirrors the `workflow:awaiting-merge` label
// commands/work-on/remediate.md's Phase M8 sets on a HELD-AWAITING-MERGE
// re-gate outcome (a clean re-review that didn't clear the #1809 Q1 auto-land
// bar) — already recognized as a terminal state by work-on.md's Universal
// Phase Dispatcher; this just gives the `remediate` phase's detectOutcome a
// matching engine-level terminal reason to report instead of overloading
// "needs-human" (which would misrepresent a clean-but-unmet-bar re-review as
// a fresh human-judgment escalation).
export const TERMINAL_REASONS = ["merged", "invalid", "needs-human", "decomposed", "engine-error", "awaiting-merge"];

/**
 * forge#2381: close-scope invariant ids (forge-invariants.yaml) that are
 * structurally unsatisfiable at `close.execute()`'s call point and are
 * therefore excluded from its in-process check rather than fabricated into
 * passing.
 *
 * `run_log_terminal_at_close` asserts a RUN_TERMINAL event is present in the
 * run-log. In the engine-native path RUN_TERMINAL is written by
 * bin/engine.mjs's `terminate()` strictly AFTER this phase's outcome commits
 * (`close.isTerminalAfter` is always true), so it cannot be present yet when
 * `execute()` runs — evaluating it here would fail every healthy run. The
 * assertion targets the interactive `commands/work-on/close.md` path, whose
 * run-log ordering differs; it remains meaningful there and is still
 * evaluated by `bin/tests/engine-invariants.test.mjs`.
 *
 * Do NOT "fix" an unsatisfiable assertion by synthesizing the event it looks
 * for — that silently converts the gate into a no-op. Exclude it here (loudly,
 * by id, with a reason) or change the assertion.
 */
const CLOSE_INVARIANTS_NOT_APPLICABLE_TO_EXECUTE = new Set(["run_log_terminal_at_close"]);

/**
 * Fetch the issue's comments. Returns both:
 *  - `blob`: all bodies joined into one string, for simple marker-presence checks
 *    (`has(blob, marker)`) where it doesn't matter which comment posted the marker.
 *  - `comments`: an array of individual comment bodies, preserving per-comment
 *    boundaries, for extraction that MUST be scoped to a specific comment (see
 *    `parseBranchFromMarkers()` below — forge#2184).
 *
 * The `--jq '[.[].body]'` query asks `gh` for a JSON array of bodies. If the
 * response isn't valid JSON (a non-JSON gh error string, or a test mock that
 * supplies a raw marker string instead of the real API shape), fall back to
 * treating the whole blob as a single pseudo-comment — `has()` checks are
 * unaffected either way, and comment-scoped extraction simply won't match,
 * which is the safe, conservative behavior.
 */
async function issueMarkers(issue, io) {
  const out = await io.gh(["api", `repos/{owner}/{repo}/issues/${issue}/comments`, "--jq", "[.[].body]"]);
  const blob = out || "";
  let comments = [];
  try {
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) {
      comments = parsed.map((c) => (typeof c === "string" ? c : (c && c.body) || ""));
    }
  } catch {
    comments = blob ? [blob] : [];
  }
  return { blob, comments };
}
/**
 * Count commits on `branch` ahead of `lane`'s base. On the first build the
 * branch does not exist yet, so real git rejects the ref range — swallow
 * that (and any other git failure) as "0 ahead" rather than letting it
 * propagate and crash runIssue (C1).
 *
 * Takes explicit `lane`/`branch` args (rather than reading them off `state`)
 * so every call site is forced to resolve the branch it means to check —
 * see `resolveBranch()` below (forge#2174: the previous `state.branch`-only
 * signature let the build phase evaluate this against a guessed branch name
 * that never matched the branch the builder actually created).
 *
 * Returns -1 (rather than 0) when the underlying `git` call itself failed
 * (lock contention, transient I/O error, ref not yet fetched, etc.) — distinct
 * from a genuine, successfully-computed 0. More generally, -1 means "this
 * count was not computed" — that includes both a git failure here AND a
 * caller that had no resolvable branch to check in the first place (forge#2211:
 * `detectOutcome` mirrors this same -1 sentinel for its unresolved-branch case
 * rather than synthesizing its own 0). This distinction matters to the
 * build phase's `detectOutcome` (forge#2176): a *genuine* 0 ahead (git ran
 * cleanly and reported no new commits) is a stable fixed point safe to mark
 * non-retryable, but a transient git error — or a not-yet-resolved branch —
 * folded into the same 0 would not be — the very next attempt could see a
 * different, computed result with no external input having changed, so it
 * must remain retryable. Callers that only compare `> 0` (reconcile()'s
 * satisfied check) are unaffected: -1 is still not `> 0`, so existing
 * behavior there is unchanged.
 */
async function commitsAhead(lane, branch, io) {
  try {
    const n = await io.git(["rev-list", "--count", `origin/${lane}..${branch}`]);
    return parseInt(String(n).trim(), 10) || 0;
  } catch {
    return -1;
  }
}
/**
 * Marker-presence check used throughout this file — including
 * `FORGE:BUILDER:COMPLETE` eligibility gates in the "build" phase's
 * `reconcile`/`detectOutcome` below (forge#2194 — investigated, no change).
 *
 * This is a plain substring test, deliberately, for consistency: every other
 * marker gate in this file (`INVESTIGATION:INVALID`, `DECOMPOSE:YES`,
 * `INVESTIGATION:COMPLETE`, `FORGE:CONTEXT:COMPLETE`,
 * `FORGE:ARCHITECT:COMPLETE`, `workflow:merged`) uses the identical
 * substring/membership technique — singling out `FORGE:BUILDER:COMPLETE`
 * alone for a "structured" parse would be inconsistent and would not close
 * any real gap: the actual trust boundary for issue-comment content is
 * *authorship* (can an untrusted actor post a comment on this issue at all),
 * not *format*. Nothing in this engine validates comment authorship for any
 * marker today, so an actor able to post an arbitrary comment could just as
 * easily post whatever "structured" shape a parser would accept — format
 * hardening alone buys nothing here. If comment-spoofing is ever a concern
 * worth addressing, the fix is an author allowlist applied uniformly to all
 * markers, not a bespoke parser for this one field.
 */
function has(blob, marker) { return blob.includes(marker); }

/**
 * Fetch the issue's live `state` (OPEN/CLOSED) and `labels` in one call.
 *
 * This is the single data source for two consumers (forge#2352):
 *  - the `close` phase's `reconcile`/`detectOutcome` below (which already made
 *    this exact call inline before this helper existed — factored out here so
 *    both call sites share one shape instead of drifting independently);
 *  - the divergence guard in `bin/engine.mjs`'s `runIssue()` phase loop, which
 *    calls this once per loop iteration (before running any phase other than
 *    `close`) to detect an issue that was closed / labeled `workflow:invalid`
 *    / labeled `needs-human` out from under an in-flight run.
 *
 * Returns `{ ok: false, state: null, labels: [] }` on any fetch/parse failure
 * — callers must treat `ok: false` as "could not determine, do not act on
 * this" rather than "issue has no labels/is not closed". This mirrors the
 * existing fail-open behavior `close`'s `reconcile` already had (a `gh`
 * failure there degrades to "not satisfied", never to a false positive).
 */
export async function issueSnapshot(issue, io) {
  const out = await io.gh(["issue", "view", String(issue), "--json", "state,labels"]);
  let j;
  try {
    j = JSON.parse(out || "{}");
  } catch {
    return { ok: false, state: null, labels: [] };
  }
  const labels = (j.labels || []).map((l) => l.name || l);
  return { ok: true, state: j.state || null, labels };
}

/**
 * Parse the real branch name out of the `FORGE:BUILDER` comment's
 * `**Branch**: \`{BRANCH}\`` field (see `commands/work-on/build/implement.md`
 * Phase I6 — this is the exact format the builder posts). Ground truth for
 * "what branch did the builder actually create" — the engine has no other
 * reliable source, since the branch name is slug-derived from the issue
 * title and cannot be guessed or precomputed (forge#2174).
 *
 * SCOPING (forge#2184): only comments whose body contains `FORGE:BUILDER:COMPLETE`
 * — the same completion marker the build phase already gates on — are eligible
 * to supply the branch. A `**Branch**:` field inside any other comment (a
 * FORGE:CONTRACT, FORGE:ARCHITECT, FORGE:CONTEXT, reviewer, or remediation
 * comment) is never considered, even if it happens to match the same regex
 * shape. If more than one FORGE:BUILDER:COMPLETE comment exists (e.g. a
 * resumed/retried build re-posting a fresh completion comment), the LAST one
 * — by array/chronological order — wins, so the most recent build attempt's
 * branch is used. Returns null (never invents a value) if no eligible comment
 * contains the field.
 *
 * WITHIN-COMMENT FIELD ORDER (forge#2193 — investigated, no change): once the
 * winning comment is selected (comment-level last-match, above — settled by
 * forge#2184, do not conflate with this paragraph), `body.match(re)` returns
 * the FIRST `**Branch**:` occurrence in that comment, because `re` has no
 * `/g` flag. This is intentional, not an oversight: there is exactly one
 * producer of this field — `commands/work-on/build/implement.md` Phase I6 —
 * which posts `**Branch**: \`{BRANCH}\`` exactly once per FORGE:BUILDER
 * comment. `FORGE:BUILDER:COMPLETE` is appended IN PLACE to that same
 * existing comment by `commands/work-on/build/validate.md` Phase V5 (an edit,
 * not a new comment), so no code path in this pipeline ever produces two
 * `**Branch**:` fields inside one FORGE:BUILDER:COMPLETE-eligible comment.
 * First-match and last-match are therefore equivalent for every real input;
 * first-match is kept because it's the simpler default. If a future producer
 * ever posts more than one `**Branch**:` field in a single eligible comment,
 * this will silently keep returning the first one — revisit this comment
 * before changing that invariant.
 */
function parseBranchFromMarkers(comments) {
  const re = /\*\*Branch\*\*:\s*`([^`]+)`/;
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i];
    if (!body || !body.includes(PHASE_MARKERS.build.completionMarker)) continue;
    const match = body.match(re);
    if (match) return match[1];
  }
  return null;
}

/**
 * Resolve the branch to evaluate the build phase against: ground truth from
 * the FORGE:BUILDER:COMPLETE comment if present (see `parseBranchFromMarkers()`
 * for the exact scoping rule), else whatever `state.branch` already holds
 * (e.g. a real branch carried forward from a prior PHASE_COMMIT — see
 * `runlog.mjs:deriveState`). Never invents a value.
 */
function resolveBranch(state, comments) {
  return parseBranchFromMarkers(comments) || state.branch || null;
}

/** @type {Phase[]} */
export const PHASES = [
  {
    id: "investigate",
    command: "work-on/investigate",
    entryCondition: () => true,
    async detectOutcome(state, io) {
      const { blob } = await issueMarkers(state.issue, io);
      if (has(blob, PHASE_MARKERS.investigate.invalidMarker))
        return { status: "committed", terminalReason: "invalid", outputs: { verdict: "INVALID" } };
      if (has(blob, PHASE_MARKERS.investigate.decomposedMarker))
        return { status: "committed", terminalReason: "decomposed", outputs: { decompose: true } };
      if (has(blob, PHASE_MARKERS.investigate.completionMarker))
        return { status: "committed", outputs: { verdict: "CONFIRMED" } };
      return { status: "failed", detail: `no ${PHASE_MARKERS.investigate.completionMarker} marker` };
    },
    // forge#2379: no longer terminal after "decomposed" — that reason now
    // hands off to the "decompose" phase below (see bin/engine.mjs's
    // runIssue(), which special-cases exactly this phase/reason combination
    // to skip its own immediate-terminate check and let pickPhase run again).
    // "invalid" is unaffected — investigate.md never posts anything further
    // after INVESTIGATION:INVALID, so that path still terminates in place.
    isTerminalAfter: (s) => s.terminalReason === "invalid",
  },
  {
    // forge#2379: "decompose" was previously only a terminal reason on
    // investigate (the run stopped the instant DECOMPOSE:YES was seen) —
    // work-on/decompose (sub-issue fan-out, FORGE:DECOMPOSED posting) was
    // never actually dispatched by the engine. This phase closes that gap:
    // entryCondition fires exactly when investigate's own outcome signaled
    // decompose, so pickPhase now genuinely dispatches work-on/decompose
    // before the run terminates.
    id: "decompose",
    command: "work-on/decompose",
    entryCondition: (s) => s.terminalReason === "decomposed",
    async detectOutcome(state, io) {
      const { blob } = await issueMarkers(state.issue, io);
      if (has(blob, PHASE_MARKERS.decompose.completionMarker))
        return { status: "committed", terminalReason: "decomposed", outputs: {} };
      return { status: "failed", detail: `no ${PHASE_MARKERS.decompose.completionMarker} marker` };
    },
    // Always terminal: decomposition spawns independent sub-issues, each of
    // which runs its own /work-on pipeline — nothing more for THIS run to do.
    isTerminalAfter: () => true,
  },
  {
    id: "context",
    command: "work-on/build/context",
    entryCondition: (s) => s.committed.includes("investigate"),
    async reconcile(state, io) {
      // Idempotent resume: FORGE:CONTEXT:COMPLETE present → skip the LLM re-run.
      // Bare FORGE:CONTEXT matches a partial/interrupted annotation — require :COMPLETE.
      const { blob } = await issueMarkers(state.issue, io);
      return has(blob, PHASE_MARKERS.context.completionMarker) ? { satisfied: true } : { satisfied: false };
    },
    async detectOutcome(state, io) {
      const { blob } = await issueMarkers(state.issue, io);
      // Context is non-critical: a missing marker is a VISIBLE skip, not a hard fail (spec §7).
      if (has(blob, PHASE_MARKERS.context.presenceMarker)) return { status: "committed", outputs: {} };
      return { status: "committed", outputs: { skipped: true, which: "context" } };
    },
  },
  {
    id: "architect",
    command: "work-on/build/architect",
    entryCondition: (s) => s.committed.includes("context"),
    async reconcile(state, io) {
      // Idempotent resume: FORGE:ARCHITECT:COMPLETE present → skip the LLM re-run.
      // Bare FORGE:ARCHITECT matches a partial/interrupted annotation — require :COMPLETE.
      const { blob } = await issueMarkers(state.issue, io);
      return has(blob, PHASE_MARKERS.architect.completionMarker) ? { satisfied: true } : { satisfied: false };
    },
    async detectOutcome(state, io) {
      const { blob } = await issueMarkers(state.issue, io);
      return has(blob, PHASE_MARKERS.architect.completionMarker)
        ? { status: "committed", outputs: {} }
        : { status: "failed", detail: `no ${PHASE_MARKERS.architect.completionMarker}` };
    },
  },
  {
    id: "build",
    command: "work-on/build",
    entryCondition: (s) => s.committed.includes("architect"),
    async reconcile(state, io) {
      // Idempotent resume: resolve the real branch from ground truth (FORGE:BUILDER
      // comment) rather than trusting a possibly-stale/absent state.branch, then
      // check it's already ahead of base → treat as done, skip the LLM (forge#2174).
      const { blob, comments } = await issueMarkers(state.issue, io);
      const branch = resolveBranch(state, comments);
      if (branch && has(blob, PHASE_MARKERS.build.completionMarker) && (await commitsAhead(state.lane, branch, io)) > 0) {
        return { satisfied: true, outputs: { branch } };
      }
      return { satisfied: false };
    },
    async detectOutcome(state, io) {
      const { blob, comments } = await issueMarkers(state.issue, io);
      const complete = has(blob, PHASE_MARKERS.build.completionMarker); // #1305: require :COMPLETE …
      // Resolve the branch the builder actually created from the FORGE:BUILDER:COMPLETE
      // comment (ground truth), scoped to that specific comment — see
      // resolveBranch()/parseBranchFromMarkers() above (forge#2174, forge#2184).
      const branch = resolveBranch(state, comments);
      // forge#2211: an unresolved branch means the commit count was never
      // computed at all — mirror commitsAhead()'s own "-1 = not computed"
      // sentinel here instead of synthesizing a `0`, which is indistinguishable
      // from a genuine git-confirmed zero and would wrongly trip the
      // non-retryable guard below on the very first attempt.
      const ahead = branch ? await commitsAhead(state.lane, branch, io) : -1; // … AND real commits
      if (complete && ahead > 0) return { status: "committed", outputs: { branch } };
      const detail = `builder complete=${complete} commitsAhead=${ahead} branch=${branch || "unresolved"}`;
      // forge#2176: when the builder has already posted FORGE:BUILDER:COMPLETE
      // but the resolved (real, ground-truth) branch has zero commits ahead of
      // the lane base, this is a stable fixed point, not a transient failure.
      // commands/work-on/build.md's own early-exit (Phase B0) means any
      // subsequent re-invocation of this phase's runner will see
      // FORGE:BUILDER:COMPLETE already present and immediately no-op with
      // `BUILD_RESULT: status: ALREADY_DONE` — it will never touch git again,
      // so `ahead` cannot change without new, out-of-band input (e.g. a human
      // pushing a commit). Retrying is therefore guaranteed to reproduce this
      // exact result; mark it non-retryable so the engine escalates after a
      // single attempt instead of burning the full attempt budget.
      //
      // When `complete` is false, the builder never finished at all (crashed,
      // ran out of iterations, or was interrupted) — that IS worth a fresh
      // retry, so this branch intentionally leaves `retryable` unset
      // (defaults to retryable in bin/engine.mjs's runPhaseWithRetry).
      //
      // `ahead === -1` means the count was never computed — either
      // commitsAhead() itself failed (transient git error) or the branch
      // could not be resolved at all (forge#2211: `resolveBranch()` returned
      // null, e.g. on the very first build attempt before any
      // FORGE:BUILDER:COMPLETE comment names a branch). Neither is a
      // confirmed zero — both are exactly the kind of failure a retry might
      // resolve, so both must stay retryable. Only a successfully-computed
      // ahead of 0 on a *resolved* branch (a real "nothing new to commit"
      // result) is the true fixed point this non-retryable signal targets.
      if (complete && ahead !== -1) return { status: "failed", detail, retryable: false };
      return { status: "failed", detail };
    },
  },
  {
    id: "review",
    command: "work-on/review",
    entryCondition: (s) => s.committed.includes("build"),
    async reconcile(state, io) {
      const pr = await openPrFor(state, io);   // adopt an existing PR instead of opening a second
      return pr ? { satisfied: false, outputs: { pr } } : { satisfied: false };
    },
    async detectOutcome(state, io) {
      const pr = await prStatusFor(state, io);
      if (!pr) return { status: "failed", detail: "no PR created" };
      if (pr.merged) return { status: "committed", outputs: { pr: pr.number } };
      if (pr.needsHuman) return { status: "blocked", detail: "review escalated", outputs: { pr: pr.number } };
      return { status: "failed", detail: "PR open, not merged" };
    },
  },
  {
    // forge#2379: `remediate` re-drives a needs-human PR via
    // commands/work-on/remediate.md (checkout → classify FIXABLE/UNFIXABLE →
    // fix → quality-gate → re-review → #1809 auto-land bar → merge-or-hold),
    // finishing with a `FORGE:REMEDIATION`/`FORGE:REMEDIATION:COMPLETE`
    // marker posted to BOTH the PR and this issue (Phase M8), carrying a
    // `**Re-gate outcome**: AUTO-LANDED | HELD-AWAITING-MERGE | RE-ESCALATED
    // | UNFIXABLE` field. This entry registers that outcome vocabulary in the
    // phase table (closing the literal "remediate appears nowhere in the
    // engine" gap) and is fully unit-tested via `pickPhase`/`detectOutcome`.
    //
    // KNOWN LIMITATION (documented, not fixed here — see forge#2379
    // investigation "What We Found"): `review`'s `"blocked"` outcome (the
    // needs-human escalation) causes `bin/engine.mjs`'s `runIssue()` to
    // `terminate()` immediately, before `review` is ever added to
    // `state.committed` — and the divergence guard just above that also
    // pauses before any non-`close` phase once the issue carries
    // `needs-human`. So a single continuous `runIssue()` walk cannot reach
    // this phase's `entryCondition` today. In practice `remediate.md` is
    // (correctly, per `work-on.md` Phase 0A.1) invoked as its own separate
    // top-level entry point (`/work-on <pr> --remediate`), not as a
    // continuation of the original run — this phase entry documents and
    // tests the target state shape for a future run that reconstructs
    // `committed`/`terminalReason` from live GitHub state (e.g. a dedicated
    // remediation-run entry point) rather than from a fresh local run-log.
    // Making that live wiring real is out of this issue's scope — it needs
    // changes to `review`'s `"blocked"` contract and to `bin/tests/engine.test.mjs`,
    // both outside this issue's declared file set.
    id: "remediate",
    command: "work-on/remediate",
    entryCondition: (s) => s.committed.includes("review") && s.terminalReason === "needs-human",
    async detectOutcome(state, io) {
      const { blob } = await issueMarkers(state.issue, io);
      if (!has(blob, PHASE_MARKERS.remediate.completionMarker))
        return { status: "failed", detail: `no ${PHASE_MARKERS.remediate.completionMarker} marker` };
      // Parse the **Re-gate outcome**: field remediate.md's Phase M8 posts
      // (e.g. "**Re-gate outcome**: AUTO-LANDED to staging" — value is the
      // first whitespace-delimited token after the colon).
      const match = blob.match(/\*\*Re-gate outcome\*\*:\s*([A-Z-]+)/);
      const reGateOutcome = match ? match[1] : null;
      switch (reGateOutcome) {
        case "AUTO-LANDED":
          // remediate.md's own Phase M8 already drove close in this case
          // (see that file's "If the outcome was AUTO-LANDED" branch) — the
          // issue should already carry workflow:merged by the time this
          // reads, but the terminal reason here is what THIS phase reports,
          // independent of close's own idempotent detectOutcome re-check.
          return { status: "committed", terminalReason: "merged", outputs: { reGateOutcome } };
        case "HELD-AWAITING-MERGE":
          return { status: "committed", terminalReason: "awaiting-merge", outputs: { reGateOutcome } };
        case "RE-ESCALATED":
        case "UNFIXABLE":
          // Both leave the issue at needs-human (a fresh escalation, or a
          // policy judgment call respectively) — reuse the existing
          // "needs-human" terminal reason rather than inventing two more,
          // matching the #2352/#2353 precedent of reusing an existing
          // TERMINAL_REASONS value where semantically equivalent.
          return { status: "committed", terminalReason: "needs-human", outputs: { reGateOutcome } };
        default:
          return { status: "failed", detail: `FORGE:REMEDIATION:COMPLETE present but Re-gate outcome unrecognized/missing: ${reGateOutcome || "none"}` };
      }
    },
    isTerminalAfter: () => true,
  },
  {
    id: "close",
    command: "work-on/close",
    entryCondition: (s) => s.committed.includes("review"),
    async reconcile(state, io) {
      // Idempotent resume: issue already closed or workflow:merged label set → skip the LLM re-run.
      const snap = await issueSnapshot(state.issue, io);
      if (!snap.ok) return { satisfied: false };
      return (snap.state === "CLOSED" || snap.labels.includes(PHASE_MARKERS.close.completionLabel))
        ? { satisfied: true }
        : { satisfied: false };
    },
    async detectOutcome(state, io) {
      const snap = await issueSnapshot(state.issue, io);
      if (!snap.ok) return { status: "failed", detail: "malformed gh response" };
      // forge#2353: a bare `state === "CLOSED"` is NOT sufficient evidence that
      // a PR actually merged — the divergence guard in bin/engine.mjs (forge#2352)
      // can now route a closed-as-invalid or otherwise closed-not-merged issue
      // into this phase (see that guard's own comment for why `close` is exempt
      // from it), and reporting `terminalReason: "merged"` for that case would
      // inflate run-log/telemetry merge-rate consumers with runs that never
      // shipped a PR. Only `workflow:merged` — the label the review phase's own
      // merge flow sets — is proof of an actual merge. A CLOSED issue without
      // that label is still a real terminal state (nothing left for this phase
      // to do), just not a "merged" one — reuse the existing "invalid" reason
      // (already in TERMINAL_REASONS) rather than inventing a new one.
      if (snap.labels.includes(PHASE_MARKERS.close.completionLabel))
        return { status: "committed", terminalReason: "merged", outputs: {} };
      if (snap.state === "CLOSED")
        return { status: "committed", terminalReason: "invalid", outputs: {} };
      return { status: "failed", detail: "issue not closed" };
    },
    isTerminalAfter: () => true,
    /**
     * forge#2381: engine-native close — performs commands/work-on/close.md's
     * mechanical operations directly via io.gh, with zero LLM invocation:
     * (1) close-scope invariant check (escalates to needs-human on violation,
     * BEFORE any mutating call — a violation must never reach workflow:merged),
     * (2) final issue-body checklist completion, (3) best-effort project-board
     * sync, (4) `gh issue close` + `workflow:merged` label — the two load-bearing
     * operations, (5) parent-tracker checkbox update (sub-issues only), (6) a
     * templated FORGE:TRAJECTORY summary comment composed from already-known
     * typed state — no generated narrative (spec point 3: an LLM narrative is
     * explicitly out of scope here).
     *
     * bin/engine.mjs's phase loop calls this directly (see `runExecutePhase`)
     * instead of `runPhaseWithRetry`/`runner()` whenever a phase declares
     * `execute` — see that file's dispatch branch for the calling contract.
     *
     * @param {import("./phases.mjs").RunState} state
     * @param {object} io - injected { gh, git } (see bin/engine.mjs)
     * @param {{dir?: string, invariants?: object[]}} [ctx] - dir: local run-log
     *   directory, used only to evaluate close-scope invariants
     *   (bin/engine/invariants.mjs). Optional — when absent, invariant evaluation
     *   is skipped (fail-open, matching every other fail-open convention already
     *   in this file, e.g. `issueSnapshot`). invariants: optional injected
     *   declaration list, defaulting to `loadInvariants()`. This is a test seam —
     *   it lets bin/tests/engine-phases.test.mjs exercise the violation path with
     *   a genuinely-failing assertion rather than asserting the gate's shape and
     *   calling that coverage. excludeInvariants: optional Set of assertion ids
     *   to skip, defaulting to CLOSE_INVARIANTS_NOT_APPLICABLE_TO_EXECUTE — also
     *   a test seam, so the violation/blocked path can be exercised end-to-end.
     *   Production callers (bin/engine.mjs's runExecutePhase) never pass either.
     * @returns {Promise<{status: "committed"|"blocked", outputs: object, terminalReason?: string, detail?: string}>}
     */
    async execute(state, io, ctx = {}) {
      // 1. Close-scope invariant check, before any mutating gh call.
      if (ctx.dir) {
        const events = readLog(ctx.dir, state.issue);
        const declared = ctx.invariants ?? loadInvariants();
        const excluded = ctx.excludeInvariants ?? CLOSE_INVARIANTS_NOT_APPLICABLE_TO_EXECUTE;
        const invariants = declared.filter((i) => !excluded.has(i.id));
        // Evaluate the REAL event list — never a fabricated one. An earlier
        // revision appended a synthetic RUN_TERMINAL here so that
        // `run_log_terminal_at_close` would pass; that made the whole gate
        // vacuous (the assertion only checks that such an event exists, so
        // synthesizing one guaranteed ok:true and nothing could ever block).
        // Structurally-unsatisfiable assertions are excluded by id instead —
        // see CLOSE_INVARIANTS_NOT_APPLICABLE_TO_EXECUTE — so every assertion
        // that IS evaluated here is evaluated against real state and can
        // genuinely fail.
        const results = assertCloseInvariants(invariants, events);
        const violations = results.filter((r) => !r.ok);
        if (violations.length) {
          return {
            status: "blocked",
            detail: `close invariant violation(s): ${violations.map((v) => `${v.id} (${v.violated})`).join("; ")}`,
            outputs: {},
          };
        }
      }

      // 2. Final issue-body checklist completion — best-effort, never fatal.
      try {
        await completeIssueBodyChecklist(state.issue, io);
      } catch { /* best-effort — a checklist-edit failure must not block close */ }

      // 3. Project-board sync — best-effort. Full field-ID-based Status/Workflow
      // sync (forge.yaml → project_board.field_ids) requires repo-specific config
      // this pure io.gh-based phase has no access to (phases.mjs reads no config
      // today); this stays a documented no-op placeholder rather than a hard
      // dependency, matching close.md's own "best-effort" framing for board sync.
      try {
        await updateProjectBoard(state.issue, io);
      } catch { /* best-effort */ }

      // 4. The load-bearing operations: close the issue + set workflow:merged.
      const projector = makeProjector(io);
      const prLabel = state.pr != null ? `PR #${state.pr}` : "no PR";
      await io.gh(["issue", "close", String(state.issue), "--comment", `Closed: ${prLabel} merged. Closes #${state.issue}.`]);
      await projector.setLabel(state.issue, PHASE_MARKERS.close.completionLabel);

      // 5. Parent-tracker checkbox (sub-issues only) — best-effort.
      try {
        await updateParentTracker(state.issue, io);
      } catch { /* best-effort */ }

      // 6. Templated trajectory summary — composed from typed state, no LLM call.
      try {
        await postTrajectoryComment(state, io);
      } catch { /* best-effort — the close itself already succeeded above */ }

      return { status: "committed", outputs: {}, terminalReason: "merged" };
    },
  },
];

async function openPrFor(state, io) {
  if (!state.branch) return null;
  const out = await io.gh(["pr", "list", "--head", state.branch, "--json", "number", "--state", "all"]);
  try { const a = JSON.parse(out || "[]"); return a[0]?.number ?? null; } catch { return null; }
}
async function prStatusFor(state, io) {
  const n = await openPrFor(state, io);
  if (!n) return null;
  const out = await io.gh(["pr", "view", String(n), "--json", "number,state,labels,mergedAt"]);
  let j;
  try { j = JSON.parse(out || "{}"); } catch { return null; }
  const labels = (j.labels || []).map((l) => l.name || l);
  return { number: j.number, merged: !!j.mergedAt || j.state === "MERGED",
           needsHuman: labels.includes("needs-human") };
}

// ---------------------------------------------------------------------------
// forge#2381: close.execute() helpers — mechanical GitHub operations ported
// from commands/work-on/close.md, each best-effort/non-fatal except where
// the phase's `execute` body above explicitly treats a step as load-bearing.
// ---------------------------------------------------------------------------

/** Check off every remaining `- [ ]` checklist item in the issue body. */
async function completeIssueBodyChecklist(issue, io) {
  const out = await io.gh(["issue", "view", String(issue), "--json", "body"]);
  let body;
  try { body = JSON.parse(out || "{}").body ?? ""; } catch { return; }
  const updated = body.replace(/^- \[ \] /gm, "- [x] ");
  if (updated !== body) await io.gh(["issue", "edit", String(issue), "--body", updated]);
}

/**
 * Project-board Status/Workflow sync — currently a documented no-op. Full
 * field-ID-based sync (forge.yaml → project_board.field_ids) requires
 * repo-specific config this pure io.gh-based phase has no access to (no
 * phase in this file reads forge.yaml today); left as a placeholder so the
 * call site in `execute()` above needs no change once that config is threaded
 * through in a future issue.
 */
async function updateProjectBoard(_issue, _io) {
  return;
}

/**
 * If this issue's body references a parent tracker issue, check off this
 * issue's line in the parent's tracker checklist. If every sub-issue line in
 * the parent is now checked, close the parent too (mirrors close.md's Phase
 * 6D "if ALL sub-issues checked off → close parent with workflow:merged").
 */
async function updateParentTracker(issue, io) {
  const out = await io.gh(["issue", "view", String(issue), "--json", "body"]);
  let body;
  try { body = JSON.parse(out || "{}").body ?? ""; } catch { return; }
  const stripped = body.replace(/[*_]+/g, "");
  const match = stripped.match(/(?:part of|spawned from|sub-issue of|parent issue:?|parent:)\s*#(\d+)/i);
  if (!match) return;
  const parentNum = match[1];

  const parentOut = await io.gh(["issue", "view", parentNum, "--json", "body"]);
  let parentBody;
  try { parentBody = JSON.parse(parentOut || "{}").body ?? ""; } catch { return; }
  const issueRef = new RegExp(`- \\[ \\] #${issue}\\b`);
  if (!issueRef.test(parentBody)) return;

  const updatedParentBody = parentBody.replace(issueRef, `- [x] #${issue}`);
  await io.gh(["issue", "edit", parentNum, "--body", updatedParentBody]);

  const remaining = (updatedParentBody.match(/- \[ \] #\d+/g) || []).length;
  if (remaining === 0) {
    await io.gh(["issue", "close", parentNum, "--comment", "All sub-issues merged. Closing parent."]);
    await makeProjector(io).setLabel(parentNum, PHASE_MARKERS.close.completionLabel);
  }
}

/**
 * Templated FORGE:TRAJECTORY summary comment, composed from already-known
 * typed state — no generated narrative (spec point 3: an LLM narrative call
 * for this is explicitly optional/future, not built here).
 */
async function postTrajectoryComment(state, io) {
  const timestamp = new Date().toISOString();
  const prLine = state.pr != null ? `PR #${state.pr}` : "no PR";
  const phaseRows = state.committed.map((p) => `| ${p} | ✅ Complete |`).join("\n");
  const body = `<!-- FORGE:TRAJECTORY -->
## Pipeline Trajectory — #${state.issue}

| Phase | Result |
|-------|--------|
${phaseRows}
| close | ✅ Complete (engine-native) |

**Branch**: \`${state.branch ?? "—"}\`
**PR**: ${prLine}
**Pipeline completed**: ${timestamp}
**Executed by**: engine (\`bin/engine/phases.mjs\` \`close.execute\` — zero LLM tokens)`;
  await io.gh(["issue", "comment", String(state.issue), "--body", body]);
}

/** The engine's transition function: first uncommitted phase whose gate holds. */
export function pickPhase(state) {
  if (state.terminal) return null;
  for (const p of PHASES) {
    if (state.committed.includes(p.id)) continue;
    if (p.entryCondition(state)) return p;
  }
  return null;
}
