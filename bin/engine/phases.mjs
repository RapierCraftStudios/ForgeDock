/**
 * Declarative phase table for the headless work-on pipeline. The ENGINE (not an
 * LLM) chooses the next phase via pickPhase. Each phase's outcome is read from
 * GitHub/git AFTER the run (detectOutcome); the runner's return is advisory.
 * @typedef ... (see plan "Shared types")
 */

export const TERMINAL_REASONS = ["merged", "invalid", "needs-human", "decomposed"];

/** Fetch the issue's comment bodies as one blob for marker checks. */
async function issueMarkers(issue, io) {
  const out = await io.gh(["api", `repos/{owner}/{repo}/issues/${issue}/comments`, "--jq", ".[].body"]);
  return out || "";
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
 */
async function commitsAhead(lane, branch, io) {
  try {
    const n = await io.git(["rev-list", "--count", `origin/${lane}..${branch}`]);
    return parseInt(String(n).trim(), 10) || 0;
  } catch {
    return 0;
  }
}
function has(blob, marker) { return blob.includes(marker); }

/**
 * Parse the real branch name out of the `FORGE:BUILDER` comment's
 * `**Branch**: \`{BRANCH}\`` field (see `commands/work-on/build/implement.md`
 * Phase I6 — this is the exact format the builder posts). Ground truth for
 * "what branch did the builder actually create" — the engine has no other
 * reliable source, since the branch name is slug-derived from the issue
 * title and cannot be guessed or precomputed (forge#2174).
 *
 * Returns the LAST match so a resumed/retried build's most recent comment
 * wins over any stale attempt.
 */
function parseBranchFromMarkers(blob) {
  const re = /\*\*Branch\*\*:\s*`([^`]+)`/g;
  let match, last = null;
  while ((match = re.exec(blob)) !== null) last = match[1];
  return last;
}

/**
 * Resolve the branch to evaluate the build phase against: ground truth from
 * the FORGE:BUILDER comment if present, else whatever `state.branch` already
 * holds (e.g. a real branch carried forward from a prior PHASE_COMMIT — see
 * `runlog.mjs:deriveState`). Never invents a value.
 */
function resolveBranch(state, markersBlob) {
  return parseBranchFromMarkers(markersBlob) || state.branch || null;
}

/** @type {Phase[]} */
export const PHASES = [
  {
    id: "investigate",
    command: "work-on/investigate",
    entryCondition: () => true,
    async detectOutcome(state, io) {
      const m = await issueMarkers(state.issue, io);
      if (has(m, "INVESTIGATION:INVALID"))
        return { status: "committed", terminalReason: "invalid", outputs: { verdict: "INVALID" } };
      if (has(m, "DECOMPOSE:YES"))
        return { status: "committed", terminalReason: "decomposed", outputs: { decompose: true } };
      if (has(m, "INVESTIGATION:COMPLETE"))
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
      const m = await issueMarkers(state.issue, io);
      return has(m, "FORGE:CONTEXT:COMPLETE") ? { satisfied: true } : { satisfied: false };
    },
    async detectOutcome(state, io) {
      const m = await issueMarkers(state.issue, io);
      // Context is non-critical: a missing marker is a VISIBLE skip, not a hard fail (spec §7).
      if (has(m, "FORGE:CONTEXT")) return { status: "committed", outputs: {} };
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
      const m = await issueMarkers(state.issue, io);
      return has(m, "FORGE:ARCHITECT:COMPLETE") ? { satisfied: true } : { satisfied: false };
    },
    async detectOutcome(state, io) {
      const m = await issueMarkers(state.issue, io);
      return has(m, "FORGE:ARCHITECT:COMPLETE")
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
      const m = await issueMarkers(state.issue, io);
      const branch = resolveBranch(state, m);
      if (branch && has(m, "FORGE:BUILDER:COMPLETE") && (await commitsAhead(state.lane, branch, io)) > 0) {
        return { satisfied: true, outputs: { branch } };
      }
      return { satisfied: false };
    },
    async detectOutcome(state, io) {
      const m = await issueMarkers(state.issue, io);
      const complete = has(m, "FORGE:BUILDER:COMPLETE");           // #1305: require :COMPLETE …
      // Resolve the branch the builder actually created from the FORGE:BUILDER
      // comment (ground truth) instead of a guessed/self-referential state.branch
      // — see resolveBranch()/parseBranchFromMarkers() above (forge#2174).
      const branch = resolveBranch(state, m);
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
      if (complete) return { status: "failed", detail, retryable: false };
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
