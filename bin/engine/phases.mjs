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
//
// forge#3545: "phase-complete" is the `close` phase's PHASE_COMPLETE exit
// (commands/work-on/close.md Phase C2): the PR merged and the phase is done, but
// the issue is deliberately left OPEN because later phases remain. It is a
// committed terminal state for THIS run, distinct from "merged" (issue closed)
// and from "awaiting-merge" (a PR is still waiting to merge).
export const TERMINAL_REASONS = ["merged", "invalid", "needs-human", "decomposed", "engine-error", "awaiting-merge", "phase-complete"];

/**
 * Fetch the issue's comments. Returns both:
 *  - `blob`: all bodies joined into one string, for simple marker-presence checks
 *    (`has(blob, marker)`) where it doesn't matter which comment posted the marker.
 *  - `comments`: an array of individual comment bodies, preserving per-comment
 *    boundaries, for extraction that MUST be scoped to a specific comment (see
 *    `parseBranchFromMarkers()` below — forge#2184).
 *
 * The `--jq '.[].body | @json'` query asks `gh` for one JSON string per comment
 * (paginated); a single JSON array of bodies is also accepted. If the
 * response isn't valid JSON (a non-JSON gh error string, or a test mock that
 * supplies a raw marker string instead of the real API shape), fall back to
 * treating the whole blob as a single pseudo-comment — `has()` checks are
 * unaffected either way, and comment-scoped extraction simply won't match,
 * which is the safe, conservative behavior.
 */
async function issueMarkers(issue, io) {
  // `--paginate` so an issue with >30 comments still exposes its newest trail;
  // `.[].body | @json` emits one JSON string per line per page, which (unlike
  // `[.[].body]`, one array per page) concatenates safely across pages.
  const out = await io.gh(["api", "--paginate", `repos/{owner}/{repo}/issues/${issue}/comments`, "--jq", ".[].body | @json"]);
  const blob = out || "";
  const toBody = (c) => (typeof c === "string" ? c : (c && c.body) || "");
  let comments = null;
  try {
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) comments = parsed.map(toBody);
  } catch { /* not a single JSON document — try one JSON string per line */ }
  if (!comments) {
    const lines = blob.split("\n").filter((l) => l.trim());
    try {
      const bodies = lines.map((l) => JSON.parse(l));
      if (bodies.length > 0 && bodies.every((b) => typeof b === "string")) comments = bodies;
    } catch { /* fall through */ }
  }
  if (!comments) comments = blob ? [blob] : [];
  return { blob, comments };
}
/**
 * Trust predicate for FORGE marker comments — mirrors scripts/trusted-comments.sh
 * exactly (the ONE spec predicate). A comment is trusted when its
 * `author_association` is in FORGE_TRAIL_TRUSTED_ASSOCIATIONS (default
 * OWNER,MEMBER,COLLABORATOR; `${VAR-default}` semantics, so an explicitly empty
 * value trusts no association), OR `user.type` is "Bot", OR `user.login` is in
 * FORGE_TRAIL_TRUSTED_LOGINS (default empty). Absent author data is untrusted.
 */
function isTrustedComment(c) {
  if (!c || typeof c !== "object") return false;
  const list = (v) => v.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
  const assoc = list(process.env.FORGE_TRAIL_TRUSTED_ASSOCIATIONS ?? "OWNER,MEMBER,COLLABORATOR");
  const logins = list(process.env.FORGE_TRAIL_TRUSTED_LOGINS ?? "");
  const user = c.user && typeof c.user === "object" ? c.user : {};
  return assoc.includes(c.author_association || "")
    || (user.type || "") === "Bot"
    || logins.includes(user.login || "");
}

/**
 * Fetch the issue's comments WITH author fields and return only the bodies of
 * trusted authors (see isTrustedComment), chronological. Fail closed: a fetch
 * error, unparsable output, or comments lacking author data yield `[]`.
 * Used for markers that drive a state-changing branch (size-gate routing).
 */
async function trustedCommentBodies(issue, io) {
  let out;
  try {
    out = await io.gh(["api", "--paginate", `repos/{owner}/{repo}/issues/${issue}/comments`,
      "--jq", ".[] | {body, author_association, user: {login: .user.login, type: .user.type}} | @json"]);
  } catch { return []; }
  let items = null;
  try {
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) items = parsed;
  } catch { /* not a single document — try one JSON object per line */ }
  if (!items) {
    try { items = String(out || "").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); }
    catch { return []; }
  }
  return items.filter(isTrustedComment).map((c) => (typeof c.body === "string" ? c.body : ""));
}

/** build.md B5.5 Step 2: a SIZE_OVERRIDE needs a non-empty justification — the first non-blank, non-HTML-comment line after the marker line. */
function overrideHasJustification(body) {
  const lines = String(body).replace(/\r\n/g, "\n").split("\n");
  return lines.slice(1).some((l) => l.trim() !== "" && !l.trimStart().startsWith("<!--"));
}

/**
 * Size-gate routing (build.md B5.5). True only when the latest `FORGE:DIFF_SIZE`
 * says `result: OVER`, carries a `### Split Proposal` (the discriminator against
 * the decompose-loop-guard Blocked exit, which also posts OVER but must not
 * re-enter decompose), and no justified `FORGE:SIZE_OVERRIDE` comment follows it,
 * and the issue is not already decomposed. `comments` MUST be TRUSTED bodies in
 * chronological order (see trustedCommentBodies); an untrusted comment never
 * reaches this function.
 */
function sizeGateRoutesToDecompose(comments) {
  const gate = PHASE_MARKERS.build.sizeGateMarker;
  const override = PHASE_MARKERS.build.sizeOverrideMarker;
  const starts = (c, m) => typeof c === "string" && c.trimStart().startsWith(`<!-- ${m}`);
  if (comments.some((c) => starts(c, "FORGE:DECOMPOSED"))) return false;
  let idx = -1;
  for (let i = comments.length - 1; i >= 0; i--) if (starts(comments[i], gate)) { idx = i; break; }
  if (idx < 0) return false;
  const body = comments[idx].replace(/\r\n/g, "\n");
  const m = /^result:[ \t]*(OK|OVERRIDDEN|OVER)[ \t]*$/m.exec(body);
  if (!m || m[1] !== "OVER" || !/^###[ \t]+Split Proposal\b/m.test(body)) return false;
  return !comments.slice(idx + 1).some((c) => starts(c, override) && overrideHasJustification(c));
}
/** Cheap untrusted pre-check: does ANY comment look like an OVER gate? Only then is the trusted fetch worth making. */
function mayRouteToDecompose(comments) {
  const gate = PHASE_MARKERS.build.sizeGateMarker;
  return comments.some((c) => typeof c === "string" && c.trimStart().startsWith(`<!-- ${gate}`) && /^result:[ \t]*OVER[ \t]*\r?$/m.test(c));
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
 * not *format*. Only the size-gate markers (DIFF_SIZE / SIZE_OVERRIDE) are
 * author-filtered (trustedCommentBodies); nothing else here validates authorship for any
 * marker today, so an actor able to post an arbitrary comment could just as
 * easily post whatever "structured" shape a parser would accept — format
 * hardening alone buys nothing here. If comment-spoofing is ever a concern
 * worth addressing, the fix is an author allowlist applied uniformly to all
 * markers, not a bespoke parser for this one field.
 */
function has(blob, marker) { return blob.includes(marker); }

/**
 * forge#3545: newest-wins state of the build acceptance gate, decided by comment ORDER
 * (`issueMarkers().comments` is oldest-first), never by blob substring presence.
 * `FORGE:BUILDER:COMPLETE` is appended at validate V5, BEFORE the B6.5 acceptance gate, so
 * the completion marker alone does not prove the gate passed.
 *
 * Scans newest to oldest; the first comment carrying a gate marker decides:
 *   ACCEPTANCE_GATE:PASSED                              -> "pass"
 *   ACCEPTANCE_GATE:FAILED / :BLOCKED / BUILD_BLOCKED   -> "blocked"
 *   none                                                -> "none" (no-marker crash path / legacy)
 * `index` is that comment's position (-1 for "none").
 */
const GATE_PASS_MARKER = "FORGE:ACCEPTANCE_GATE:PASSED";
const GATE_BLOCK_MARKERS = ["FORGE:ACCEPTANCE_GATE:FAILED", "FORGE:ACCEPTANCE_GATE:BLOCKED", "FORGE:BUILD_BLOCKED"];
function latestGateState(comments) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (has(c, GATE_PASS_MARKER)) return { state: "pass", index: i };
    if (GATE_BLOCK_MARKERS.some((m) => has(c, m))) return { state: "blocked", index: i };
  }
  return { state: "none", index: -1 };
}

/** Index of the newest FORGE:DIFF_SIZE comment whose `result:` is OVER, or -1 (forge#3545). */
function latestDiffSizeOverIndex(comments) {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (!has(comments[i], "FORGE:DIFF_SIZE")) continue;
    // newest DIFF_SIZE comment decides (build.md B5.5 edits it in place; OVERRIDDEN supersedes OVER)
    return /^result:\s*OVER\s*$/m.test(comments[i]) ? i : -1;
  }
  return -1;
}

/** Index of the newest FORGE:PHASE:COMPLETE comment, or -1 (forge#3545). */
function latestPhaseCompleteIndex(comments) {
  for (let i = comments.length - 1; i >= 0; i--) if (has(comments[i], "FORGE:PHASE:COMPLETE")) return i;
  return -1;
}

/**
 * The interactive workflow persists its conservative complexity decision in a
 * FORGE:FAST_PATH comment. The engine must consume that decision too; otherwise
 * its separate context/architect phases negate the documented trivial path.
 * Only an exact TRIVIAL value is eligible to skip work, so malformed or absent
 * annotations continue through the full pipeline.
 */
function complexityBand(comments) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i];
    if (!body?.includes("FORGE:FAST_PATH")) continue;
    const match = body.match(/\*\*COMPLEXITY_BAND\*\*:\s*([A-Z_]+)/);
    if (match) return match[1];
  }
  return null;
}

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


/**
 * forge#3499: non-blocking evidence about the context / architect children that
 * `work-on/build` now runs itself. Recorded for visibility only — a missing
 * marker NEVER fails build (context is advisory; the TRIVIAL band legitimately
 * skips both children). A BLOCKED / missing-arg child is not hidden here: it
 * shows up as `absent`, never as a fabricated "skipped" commit.
 */
function buildChildEvidence(blob, comments) {
  const trivial = complexityBand(comments) === "TRIVIAL";
  const state = (marker) => (has(blob, marker) ? "complete" : trivial ? "skipped-trivial" : "absent");
  return {
    context: state(PHASE_MARKERS.context.completionMarker),
    architect: state(PHASE_MARKERS.architect.completionMarker),
  };
}

// ---------------------------------------------------------------------------
// forge#3499: per-phase argument construction.
//
// Every `work-on` phase sub-skill takes ALL of its inputs as arguments (forge#3398
// forked-phase router) and stops with BLOCKED when one is missing. Each phase's
// `buildArgs` emits exactly the flags its `commands/<command>.md` `argument-hint`
// requires; bin/engine/phases-args.test.mjs pins the two together.
//
// Values are validated against strict allowlists before use: the runner joins the
// args array with single spaces into the prompt, so a value with whitespace,
// quotes or newlines would splice extra arguments (forge#3466 class).
// ---------------------------------------------------------------------------

export class PhaseArgsError extends Error {
  constructor(message) { super(message); this.name = "PhaseArgsError"; this.code = "PHASE_ARGS_INVALID"; }
}

/**
 * forge#3530: review `remediation` kind -> the bound marker router Phase 4R posts
 * (commands/work-on.md). review.md R4 counts these; remediate.md M0 keys its per-kind
 * guard on them.
 */
export const REMEDIATION_BOUND_MARKERS = Object.freeze({
  "ci-gate": "CI_REMEDIATION",
  "inpr-fix": "INPR_REMEDIATION",
  "base-sync": "BASESYNC_REMEDIATION",
});
function isRemediationKind(k) {
  return typeof k === "string" && Object.hasOwn(REMEDIATION_BOUND_MARKERS, k);
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._][A-Za-z0-9._\/-]*$/;
const LANE_RE = BRANCH_RE;
const PATH_RE = /^[A-Za-z0-9_.\/\\:@+~-]+$/;

function need(value, name, re) {
  if (value === null || value === undefined || value === "") throw new PhaseArgsError(`missing ${name}`);
  const v = String(value);
  if (!re.test(v) || v.includes("..")) throw new PhaseArgsError(`invalid ${name}: ${JSON.stringify(v)}`);
  return v;
}
/** @returns {string[]} the `--repo`/`--gh-flag` pair (gh-flag is ONE quoted token, as in the argument-hint). */
function repoArgs(ctx) {
  const repo = need(ctx.repo, "repo", REPO_RE);
  return ["--repo", repo, "--gh-flag", `"-R ${repo}"`];
}
function baseArgs(state) { return ["--base", need(state.lane, "base (lane)", LANE_RE)]; }

/**
 * Resolve the linked worktree checked out on `branch` from `git worktree list
 * --porcelain` — the only engine-side ground truth (build.md B1C creates it).
 * Returns null when absent/prunable/unresolvable; never invents a path.
 */
export async function resolveWorktree(state, io) {
  if (state.worktree) return state.worktree;
  if (!state.branch) return null;
  let out;
  try { out = await io.git(["worktree", "list", "--porcelain"]); } catch { return null; }
  for (const block of String(out || "").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const wt = lines.find((l) => l.startsWith("worktree "));
    const br = lines.find((l) => l.startsWith("branch "));
    if (!wt || !br || lines.some((l) => l.startsWith("prunable"))) continue;
    if (br.slice("branch ".length).trim() === `refs/heads/${state.branch}`) return wt.slice("worktree ".length).trim();
  }
  return null;
}

async function reviewArgs(state, ctx, io) {
  const worktree = need(await resolveWorktree(state, io), "worktree (no linked worktree for branch)", PATH_RE);
  return [String(state.issue), ...repoArgs(ctx), "--worktree", worktree,
          "--branch", need(state.branch, "branch", BRANCH_RE), ...baseArgs(state)];
}

/** @type {Phase[]} */
export const PHASES = [
  {
    id: "investigate",
    command: "work-on/investigate",
    buildArgs: async (state, ctx) => [String(state.issue), ...repoArgs(ctx)],
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
    buildArgs: async (state, ctx) => [String(state.issue), ...repoArgs(ctx)],
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
    id: "build",
    command: "work-on/build",
    buildArgs: async (state, ctx) => [String(state.issue), ...repoArgs(ctx), ...baseArgs(state)],
    // forge#3499: work-on/build owns worktree creation and runs the context /
    // architect / implement / validate children itself (it needs the worktree
    // as `--repo-path`), so the engine no longer schedules context/architect as
    // top-level phases — build is eligible as soon as investigate committed.
    entryCondition: (s) => s.committed.includes("investigate"),
    async reconcile(state, io) {
      // Idempotent resume: resolve the real branch from ground truth (FORGE:BUILDER
      // comment) rather than trusting a possibly-stale/absent state.branch, then
      // check it's already ahead of base → treat as done, skip the LLM (forge#2174).
      const { blob, comments } = await issueMarkers(state.issue, io);
      const branch = resolveBranch(state, comments);
      // forge#3545: COMPLETE precedes the B6.5 acceptance gate — never skip build while the newest gate marker blocks.
      if (latestGateState(comments).state === "blocked") return { satisfied: false };
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
      // forge#3545: consult the phase's own declared state (newest wins, by comment order).
      const gate = latestGateState(comments);
      // BUILD_RESULT NEEDS_DECOMPOSE (build.md B5.5): no BUILDER:COMPLETE, newest DIFF_SIZE says OVER,
      // and no newer blocking marker (the decompose-loop-guard exit posts BUILD_BLOCKED after DIFF_SIZE).
      if (!complete) {
        const overIdx = latestDiffSizeOverIndex(comments);
        // Routing still goes through the trusted-author size-gate check (Split Proposal, justified override, #3547).
        if (overIdx >= 0 && overIdx > gate.index && mayRouteToDecompose(comments) &&
            sizeGateRoutesToDecompose(await trustedCommentBodies(state.issue, io)))
          return { status: "committed", terminalReason: "decomposed", outputs: { ...(branch ? { branch } : {}), decompose: true } };
      }
      // Fail closed: a FAILED/BLOCKED gate newer than any PASSED is not a committed build even though
      // COMPLETE + commits exist. Non-retryable: a re-run reproduces the same markers until a repair posts PASSED.
      if (gate.state === "blocked") {
        return { status: "failed", retryable: false,
          detail: `acceptance gate blocked/failed (newest gate marker); builder complete=${complete} commitsAhead=${ahead} branch=${branch || "unresolved"}` };
      }
      if (complete && ahead > 0) {
        return { status: "committed", outputs: { branch, ...buildChildEvidence(blob, comments) } };
      }
      // B5.5 NEEDS_DECOMPOSE: the size gate posts no FORGE:BUILDER:COMPLETE and
      // build.md says the router (not build) dispatches decompose with no
      // needs-human. Non-retryable by construction: a retry re-measures and
      // re-emits the same exit.
      if (!complete && mayRouteToDecompose(comments) && sizeGateRoutesToDecompose(await trustedCommentBodies(state.issue, io))) {
        return { status: "committed", terminalReason: "decomposed", outputs: branch ? { branch } : {} };
      }
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
    buildArgs: reviewArgs,
    entryCondition: (s) => s.committed.includes("build"),
    async reconcile(state, io) {
      const pr = await openPrFor(state, io);   // adopt an existing PR instead of opening a second
      return pr ? { satisfied: false, outputs: { pr } } : { satisfied: false };
    },
    async detectOutcome(state, io, result) {
      const pr = await prStatusFor(state, io);
      if (!pr) return { status: "failed", detail: "no PR created" };
      if (pr.merged) return { status: "committed", outputs: { pr: pr.number } };
      // forge#3521: the spec (commands/work-on/review.md) signals an in-PR fix
      // by labelling the ISSUE needs-human and returning REVIEW_RESULT
      // `status: NEXT / next: remediate`; the PR label is back-compat only.
      // The PR number from GitHub (openPrFor) always wins over parsed text.
      const outputs = { pr: pr.number };
      const escalated = { status: "blocked", detail: "review escalated", outputs };
      const rr = parseReviewResult(result?.text);
      // forge#3530: carry the review's remediation kind (router Phase 4R parity) so the
      // remediate phase can post the matching bound marker. Untrusted model output: only
      // the three known kinds are carried verbatim; any other non-empty value is recorded as
      // the "unknown" sentinel (never the raw text) so remediate's buildArgs fails closed.
      if (rr && rr.status === "NEXT" && rr.next === "remediate" && rr.remediation)
        outputs.remediation = isRemediationKind(rr.remediation) ? rr.remediation : "unknown";
      if (pr.needsHuman) return escalated;
      if (rr && rr.status === "NEXT" && rr.next === "remediate") return escalated;
      // An explicit REVIEW_RESULT status is authoritative: BLOCKED/COMPLETE exits
      // (phase trail, ci gate, base conflict, merge refusal) also label the issue
      // needs-human but are NOT remediation handoffs, so skip the label fallback.
      if (rr && rr.status) return { status: "failed", detail: "PR open, not merged", retryable: false, handoff: false, outputs };
      let snap = null;
      try { snap = await issueSnapshot(state.issue, io); } catch { snap = null; }
      if (snap?.ok && snap.labels.includes("needs-human")) return escalated;
      return { status: "failed", detail: "PR open, not merged", retryable: false, outputs };
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
    // A blocked review is committed with terminalReason "needs-human" before
    // the engine selects this phase, preserving the review verdict while
    // handing the PR to remediation in the same run.
    id: "remediate",
    command: "work-on/remediate",
    // forge#3530: this is the engine's second implementation of router Phase 4R
    // (commands/work-on.md): post the per-kind bound marker immediately BEFORE
    // dispatching remediation, so remediate.md M0's per-kind guard and review.md R4's
    // loop bounds see it. Fail closed (PhaseArgsError -> engine-error, no runner call)
    // on a missing/unknown kind or a marker that cannot be posted: an unrecorded bound
    // must not run. Keep in sync with Phase 4R.
    buildArgs: async (state, ctx, io) => {
      const pr = need(state.pr, "pr", /^[0-9]+$/);
      const kind = state.remediationKind ?? null;
      const legacyArgs = () => [pr, "--issue", String(state.issue), ...repoArgs(ctx), ...baseArgs(state)];
      // Legacy handoff with no kind (needs-human label fallback, or no REVIEW_RESULT): there
      // is nothing to bind, so dispatch as before. remediate.md M0 then applies its default
      // single-attempt guard. A present-but-unknown kind is never dispatched.
      if (kind === null) return legacyArgs();
      if (!isRemediationKind(kind))
        throw new PhaseArgsError(`unknown remediation kind: ${JSON.stringify(kind)}`);
      const boundMarker = REMEDIATION_BOUND_MARKERS[kind];
      const marker = `<!-- FORGE:${boundMarker}: pr=${pr} -->`;
      try {
        const { blob } = await issueMarkers(state.issue, io);
        // Resume idempotency: a handoff interrupted after the marker post must not double-count.
        if (!has(blob, marker)) {
          await io.gh(["issue", "comment", String(state.issue), "--body",
            `${marker}\nReview handed PR #${pr} to remediation (${kind}); the engine is dispatching it once.`]);
        }
      } catch (e) {
        throw new PhaseArgsError(`github-unavailable: could not post FORGE:${boundMarker}; remediation not invoked (${e?.message || e})`);
      }
      return legacyArgs();
    },
    entryCondition: (s) => s.committed.includes("review") && s.terminalReason === "needs-human",
    async detectOutcome(state, io) {
      // forge#3530: read the NEWEST completed trail only. A concatenated oldest-first blob
      // returned a stale outcome from an earlier remediation when a later one posted nothing.
      const { comments } = await issueMarkers(state.issue, io);
      const completion = PHASE_MARKERS.remediate.completionMarker;
      let latest = null;
      for (let i = comments.length - 1; i >= 0; i--) {
        if (has(comments[i], completion)) { latest = comments[i]; break; }
      }
      if (latest === null)
        return { status: "failed", detail: `no ${completion} marker` };
      // Parse the **Re-gate outcome**: field remediate.md's Phase M8 posts
      // (e.g. "**Re-gate outcome**: AUTO-LANDED to staging" — value is the
      // first whitespace-delimited token after the colon).
      const matches = [...latest.matchAll(/\*\*Re-gate outcome\*\*:\s*([A-Z-]+)/g)];
      const match = matches.length ? matches[matches.length - 1] : null;
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
    buildArgs: async (state, ctx, io) => {
      // Only --terminal-state is required by close.md; the rest are optional context.
      // forge#3506: fail closed — `merged` only from a null/merged reason. A residual
      // non-merged handoff reason (needs-human, awaiting-merge, engine-error, ...) must never
      // be closed as merged.
      const reason = state.terminalReason ?? null;
      if (reason !== null && !["merged", "decomposed", "invalid"].includes(reason))
        throw new PhaseArgsError(`refusing close --terminal-state merged from terminalReason ${JSON.stringify(reason)}`);
      const terminal = reason === "decomposed" ? "decomposed"
        : reason === "invalid" ? "invalid" : "merged";
      const args = [String(state.issue), ...repoArgs(ctx), ...baseArgs(state)];
      // forge#3504: a merged close with no PR is fabricated evidence — require it.
      if (state.pr != null || terminal === "merged") args.push("--pr", need(state.pr, "pr", /^[0-9]+$/));
      if (state.branch) args.push("--branch", need(state.branch, "branch", BRANCH_RE));
      const wt = await resolveWorktree(state, io);
      if (wt && PATH_RE.test(wt)) args.push("--worktree", wt);
      args.push("--terminal-state", terminal);
      return args;
    },
    entryCondition: (s) => s.committed.includes("review"),
    async reconcile(state, io) {
      // Idempotent resume: issue already closed or workflow:merged label set → skip the LLM re-run.
      const snap = await issueSnapshot(state.issue, io);
      if (!snap.ok) return { satisfied: false };
      if (snap.state === "CLOSED" || snap.labels.includes(PHASE_MARKERS.close.completionLabel))
        return { satisfied: true };
      // forge#3545: a PHASE_COMPLETE close already did its work; re-running it is a no-op.
      const { comments } = await issueMarkers(state.issue, io);
      return latestPhaseCompleteIndex(comments) >= 0 ? { satisfied: true } : { satisfied: false };
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
      // forge#3545: close.md C2 PHASE_COMPLETE — PR merged, issue deliberately left OPEN with
      // FORGE:PHASE:COMPLETE because later phases remain. A committed terminal state, not a crash:
      // retrying is a guaranteed no-op. Merged/CLOSED checks above stay first and unchanged.
      const { comments } = await issueMarkers(state.issue, io);
      if (latestPhaseCompleteIndex(comments) >= 0)
        return { status: "committed", terminalReason: "phase-complete", outputs: {} };
      return { status: "failed", detail: "issue not closed" };
    },
    isTerminalAfter: () => true,
  },
];

/**
 * Parse the LAST `REVIEW_RESULT:` block from a phase's final reply (forge#3521).
 * Untrusted model output: only the fixed keys below are read, via anchored
 * line matches; `pr_number` must be digits-only. Returns null when absent.
 */
export function parseReviewResult(text) {
  if (typeof text !== "string" || !text) return null;
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s*REVIEW_RESULT:\s*$/.test(lines[i])) start = i;
  if (start < 0) return null;
  const out = {};
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s+(status|next|remediation|pr_number):[ \t]*(\S*)[ \t]*$/.exec(lines[i]);
    if (m) { if (!(m[1] in out)) out[m[1]] = m[2]; continue; }
    if (/^\s+[A-Za-z_]+:/.test(lines[i]) || !lines[i].trim()) continue;
    break;
  }
  if (out.pr_number !== undefined && !/^[0-9]+$/.test(out.pr_number)) delete out.pr_number;
  return out;
}

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
