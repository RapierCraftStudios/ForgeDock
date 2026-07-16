/**
 * Declarative phase table for the headless work-on pipeline. The ENGINE (not an
 * LLM) chooses the next phase via pickPhase. Each phase's outcome is read from
 * GitHub/git AFTER the run (detectOutcome); the runner's return is advisory.
 * @typedef ... (see plan "Shared types")
 */

export const TERMINAL_REASONS = ["merged", "invalid", "needs-human", "decomposed"];

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
 * from a genuine, successfully-computed 0. This distinction matters to the
 * build phase's `detectOutcome` (forge#2176): a *genuine* 0 ahead (git ran
 * cleanly and reported no new commits) is a stable fixed point safe to mark
 * non-retryable, but a transient git error folded into the same 0 would not
 * be — the very next attempt could see a different, non-erroring result with
 * no external input having changed, so it must remain retryable. Callers that
 * only compare `> 0` (reconcile()'s satisfied check) are unaffected: -1 is
 * still not `> 0`, so existing behavior there is unchanged.
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
    if (!body || !body.includes("FORGE:BUILDER:COMPLETE")) continue;
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
      if (has(blob, "INVESTIGATION:INVALID"))
        return { status: "committed", terminalReason: "invalid", outputs: { verdict: "INVALID" } };
      if (has(blob, "DECOMPOSE:YES"))
        return { status: "committed", terminalReason: "decomposed", outputs: { decompose: true } };
      if (has(blob, "INVESTIGATION:COMPLETE"))
        return { status: "committed", outputs: { verdict: "CONFIRMED" } };
      return { status: "failed", detail: "no INVESTIGATION:COMPLETE marker" };
    },
    isTerminalAfter: (s) => s.terminalReason === "invalid" || s.terminalReason === "decomposed",
  },
  {
    id: "context",
    command: "work-on/build/context",
    entryCondition: (s) => s.committed.includes("investigate"),
    async reconcile(state, io) {
      // Idempotent resume: FORGE:CONTEXT:COMPLETE present → skip the LLM re-run.
      // Bare FORGE:CONTEXT matches a partial/interrupted annotation — require :COMPLETE.
      const { blob } = await issueMarkers(state.issue, io);
      return has(blob, "FORGE:CONTEXT:COMPLETE") ? { satisfied: true } : { satisfied: false };
    },
    async detectOutcome(state, io) {
      const { blob } = await issueMarkers(state.issue, io);
      // Context is non-critical: a missing marker is a VISIBLE skip, not a hard fail (spec §7).
      if (has(blob, "FORGE:CONTEXT")) return { status: "committed", outputs: {} };
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
      return has(blob, "FORGE:ARCHITECT:COMPLETE") ? { satisfied: true } : { satisfied: false };
    },
    async detectOutcome(state, io) {
      const { blob } = await issueMarkers(state.issue, io);
      return has(blob, "FORGE:ARCHITECT:COMPLETE")
        ? { status: "committed", outputs: {} }
        : { status: "failed", detail: "no FORGE:ARCHITECT:COMPLETE" };
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
      if (branch && has(blob, "FORGE:BUILDER:COMPLETE") && (await commitsAhead(state.lane, branch, io)) > 0) {
        return { satisfied: true, outputs: { branch } };
      }
      return { satisfied: false };
    },
    async detectOutcome(state, io) {
      const { blob, comments } = await issueMarkers(state.issue, io);
      const complete = has(blob, "FORGE:BUILDER:COMPLETE");        // #1305: require :COMPLETE …
      // Resolve the branch the builder actually created from the FORGE:BUILDER:COMPLETE
      // comment (ground truth), scoped to that specific comment — see
      // resolveBranch()/parseBranchFromMarkers() above (forge#2174, forge#2184).
      const branch = resolveBranch(state, comments);
      const ahead = branch ? await commitsAhead(state.lane, branch, io) : 0; // … AND real commits
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
      // `ahead === -1` means commitsAhead() itself failed (transient git
      // error), NOT a confirmed zero — that is exactly the kind of failure
      // a retry might resolve, so it must stay retryable too. Only a
      // successfully-computed ahead of 0 (a real "nothing new to commit"
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
    id: "close",
    command: "work-on/close",
    entryCondition: (s) => s.committed.includes("review"),
    async reconcile(state, io) {
      // Idempotent resume: issue already closed or workflow:merged label set → skip the LLM re-run.
      const out = await io.gh(["issue", "view", String(state.issue), "--json", "state,labels"]);
      let j;
      try { j = JSON.parse(out || "{}"); } catch { return { satisfied: false }; }
      const labels = (j.labels || []).map((l) => l.name || l);
      return (j.state === "CLOSED" || labels.includes("workflow:merged"))
        ? { satisfied: true }
        : { satisfied: false };
    },
    async detectOutcome(state, io) {
      const out = await io.gh(["issue", "view", String(state.issue), "--json", "state,labels"]);
      let j;
      try { j = JSON.parse(out || "{}"); } catch { return { status: "failed", detail: "malformed gh response" }; }
      const labels = (j.labels || []).map((l) => l.name || l);
      if (j.state === "CLOSED" || labels.includes("workflow:merged"))
        return { status: "committed", terminalReason: "merged", outputs: {} };
      return { status: "failed", detail: "issue not closed" };
    },
    isTerminalAfter: () => true,
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

/** The engine's transition function: first uncommitted phase whose gate holds. */
export function pickPhase(state) {
  if (state.terminal) return null;
  for (const p of PHASES) {
    if (state.committed.includes(p.id)) continue;
    if (p.entryCondition(state)) return p;
  }
  return null;
}
