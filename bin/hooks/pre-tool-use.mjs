#!/usr/bin/env node
import { createRequire } from "module";
import { existsSync } from "fs";
import { dirname, join, resolve as resolvePath } from "path";
import { fileURLToPath, pathToFileURL } from "url";
const _require = createRequire(import.meta.url);

/** Absolute path to the ForgeDock installation root (parent of bin/). */
const FORGE_HOME = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Lazy-loaded invariants module and YAML declarations (loaded once on first use).
// Using a lazy import avoids top-level await and keeps the module synchronous
// for the simple path — invariant loading only happens when a branch checkout
// command is detected.
// Sentinel states for _invariants:
//   null   — import not yet attempted
//   false  — a prior import attempt failed (do NOT retry; stay fail-open)
//   object — successfully loaded module namespace (cached)
let _invariants = null;
let _invariantDecls = null;

async function getInvariants() {
  // A prior import attempt already failed — stay fail-open, do not retry.
  if (_invariants === false) return { module: null, decls: [] };
  // Successful load cached from a previous call.
  if (_invariants !== null) return { module: _invariants, decls: _invariantDecls };
  // Not yet attempted — try importing now.
  try {
    _invariants = await import(
      pathToFileURL(join(FORGE_HOME, "bin", "engine", "invariants.mjs")).href
    );
    _invariantDecls = _invariants.loadInvariants(
      join(FORGE_HOME, "forge-invariants.yaml")
    );
  } catch {
    // invariants.mjs unavailable (fresh install, partial update) — fail-open.
    // Mark the failure with a distinct sentinel so we don't re-attempt the
    // import on every subsequent call.
    _invariants = false;
    _invariantDecls = [];
    return { module: null, decls: [] };
  }
  return { module: _invariants, decls: _invariantDecls };
}

/**
 * bin/hooks/pre-tool-use.mjs — ForgeDock PreToolUse hook.
 *
 * Deterministic enforcement layer (issues #1250, #1323): intercepts tool
 * calls before they execute and hard-blocks pipeline violations.
 *
 * === Hook protocol ===
 *
 * Claude Code sends a JSON payload to stdin and reads the exit code:
 *   exit 0  — allow the tool call
 *   exit 2  — block the tool call (error message on stderr is shown to agent)
 *
 * Input payload (stdin JSON):
 *   {
 *     "hook_event_name": "PreToolUse",
 *     "session_id": "...",
 *     "tool_name": "Bash",
 *     "tool_input": { "command": "gh pr create ..." }
 *   }
 *
 * === Enforced rules ===
 *
 * 1. PR branch target validation
 *    Intercepts `gh pr create` and validates `--base` against the
 *    pipeline's allowed targets (staging, milestone/<slug>).
 *    Hard-blocks PRs targeting main.
 *
 * 2. Label transition validation
 *    Intercepts `gh issue edit --add-label` and validates the transition
 *    against the workflow label state machine.
 *    Blocks invalid transitions (e.g. jumping from investigating to merged).
 *
 * 3. Declared precondition checks (from forge-invariants.yaml)
 *    Intercepts git checkout / git worktree add / git switch commands and
 *    evaluates pretooluse-scope invariants declared in forge-invariants.yaml.
 *    Currently: branch_must_exist_on_remote — blocks checkouts of branches
 *    that don't exist on origin (catches hallucinated branch names before
 *    they cause a mid-build git failure).
 *
 * 4. Gist visibility guard (issue #1729)
 *    Intercepts `gh gist create --public` and hard-blocks it.
 *    Memory-bearing pipeline gists (FORGE:KNOWLEDGE_GIST, FORGE:MILESTONE_INDEX,
 *    FORGE:PRIOR_GIST, FORGE:MEMORY_INDEX) MUST be secret — publishing them to
 *    a world-readable Gist exposes root causes, file paths, and security findings.
 *    Override: set FORGE_ALLOW_PUBLIC_GIST=1 in the shell environment before
 *    starting Claude Code (operator-set only — agents cannot bypass this by
 *    setting env vars via Bash tool calls, as this hook reads process.env which
 *    is set at process start, not at tool-call time).
 *
 * 5. Filesystem-root `find` guard (issue #2034)
 *    Intercepts any Bash command containing a `find` invocation whose search
 *    root is `/` or a bare Git-Bash drive mount (`/c`, `/d`, ...) and
 *    hard-blocks it. On Windows Git Bash, `/` spans every mounted drive, so a
 *    root-anchored `find` never terminates and accumulates as an orphaned,
 *    CPU-exhausting process once its parent sub-agent exits (issue #1984 was
 *    a narrow, single-call-site precursor fix — this rule is the systemic,
 *    deterministic follow-up). No override — a root-anchored `find` has no
 *    legitimate use in any ForgeDock pipeline.
 *
 * 6. Attribution guard
 *    Intercepts commit / PR / issue / comment creation commands (`git commit`,
 *    `gh pr create|edit|comment`, `gh issue create|edit|comment`) and
 *    hard-blocks any whose message or body carries the Claude Code harness
 *    default attribution — "🤖 Generated with [Claude Code]", "Co-Authored-By:
 *    Claude", or the `noreply@anthropic.com` co-author trailer. Pipeline output
 *    is ForgeDock-branded; the assistant-tool attribution must never leak into
 *    a repo's public commit/PR/issue history. The agent is told to remove the
 *    attribution and, where a footer is wanted, use the ForgeDock signature.
 *    Override: set FORGE_ALLOW_AI_ATTRIBUTION=1 in the shell environment before
 *    starting Claude Code (operator-set only — same process.env semantics as
 *    the gist guard above).
 *
 * Rules 1-4 and 6 only apply inside a ForgeDock-managed directory (a directory
 * with a `forge.yaml` or `.forgedock` marker) — see `isForgeDockManagedCwd()`
 * (issue #1591). The hook installs into the user's global
 * `~/.claude/settings.json`, so without this guard every Bash call in every
 * repo on the machine would be subject to these ForgeDock-specific rules,
 * including unrelated repos where `main` is a legitimate PR target.
 *
 * Rule 5 is deliberately NOT gated by `isForgeDockManagedCwd()` — it runs
 * before that check. A filesystem-root `find` is a universal footgun with no
 * legitimate use anywhere (unlike Rules 1-4/6, which are ForgeDock-pipeline-
 * specific), and gating it the same way would leave it silently disabled
 * inside git worktrees, which typically carry no `forge.yaml`/`.forgedock`
 * marker of their own — exactly where build/review sub-agents run.
 *
 * === Fail-open contract ===
 *
 * Any uncaught error or parse failure exits 0 (allow) — this hook must
 * NEVER prevent a legitimate tool call due to a hook bug.
 *
 * === Wiring ===
 *
 * Installed into ~/.claude/settings.json under hooks.PreToolUse by
 * `forgedock install` (via bin/settings-hook.mjs). The install entry carries
 * `matcher: "Bash"` so Claude Code's harness only spawns this script for
 * Bash tool calls, not every tool call.
 * Removed by `forgedock uninstall`.
 */

// ---------------------------------------------------------------------------
// Label state machine
// Valid successors for each workflow label. Only forward transitions allowed.
// ---------------------------------------------------------------------------

/**
 * Allowed label transitions: from → [to, ...]
 * A label not in this map can be added freely (not a workflow: label).
 *
 * `workflow:invalid` is reachable from `ready-to-build`, `building`, and
 * `in-review` (issue #2326) — not just from `investigating` — because
 * invalidity is not always discovered where the pipeline first labels the
 * issue "ready to build". A cheap false positive is usually caught during
 * investigation; a subtler one is only disproved once the architect/build
 * phase reads the actual code and tests (see #2312: the premise wasn't
 * disproved until Phase 3C.6 read `bin/tests/engine-crash.test.mjs`).
 *
 * These three post-investigation successors are NOT unconditional, though —
 * see EVIDENCE_REQUIRED_TARGETS below and its enforcement in
 * checkLabelTransition(). Reaching `workflow:invalid` from any of these
 * three states requires a posted reversal comment (a second
 * `FORGE:INVESTIGATOR` comment carrying `**Verdict**: INVALID`) already on
 * the issue — the state machine still refuses a bare relabel with no
 * evidence trail. This preserves the original protection (see history below)
 * while making the terminal state reachable where it is actually discovered.
 *
 * History: this map was introduced by #1250/#1513 to stop arbitrary/skipped
 * label jumps (e.g. investigating → merged in one hop) — it enforces that
 * every workflow label transition follows the pipeline's real phase order,
 * with corrective error messages naming the legal next states. Widening a
 * terminal-reachability edge is safe as long as an equivalent guard (the
 * evidence precondition) replaces the blanket "not reachable at all" rule
 * for the specific case this hook was never asked to consider: legitimate,
 * evidenced invalidation discovered after ready-to-build.
 */
const LABEL_TRANSITIONS = {
  "workflow:investigating": ["workflow:ready-to-build", "workflow:invalid", "workflow:decomposed"],
  "workflow:ready-to-build": ["workflow:building", "workflow:invalid"],
  "workflow:building": ["workflow:in-review", "workflow:ready-to-build", "workflow:invalid"], // retry allowed; evidenced reversal allowed (#2326)
  "workflow:in-review": ["workflow:merged", "workflow:building", "workflow:invalid"],         // review → re-build allowed; evidenced reversal allowed (#2326)
  "workflow:merged": [],     // terminal — no successors
  "workflow:invalid": [],    // terminal
  "workflow:decomposed": [], // terminal
};

/**
 * States from which a transition to `workflow:invalid` requires posted
 * evidence (a reversal comment), rather than being freely allowed.
 * `workflow:investigating` is deliberately excluded — invalidation
 * discovered during initial investigation is the pipeline's normal,
 * unguarded path (Phase 1D) and needs no additional precondition.
 */
const EVIDENCE_REQUIRED_FOR_INVALID_FROM = new Set([
  "workflow:ready-to-build",
  "workflow:building",
  "workflow:in-review",
]);

/**
 * `authorAssociation` values (as returned by `gh issue view --json comments`,
 * which GitHub computes server-side from the commenter's actual repo/org
 * relationship) that are trusted to post reversal evidence. Deliberately
 * NOT a hardcoded bot login: the pipeline's own `gh` identity legitimately
 * rotates (issue #1722 — the primary automation account's token went invalid
 * mid-batch and a session switched to a maintainer's personal account to keep
 * working), and a literal-login allowlist would fail closed the next time
 * identity rotates. Checking the GitHub-computed relationship instead of a
 * specific account name survives that rotation: whichever account is
 * authenticated, as long as it is an org member / repo owner / granted
 * collaborator access, reports one of these three values regardless of which
 * account it is. Everything else — `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`,
 * `NONE`, or a missing/malformed field — is untrusted and must NOT satisfy
 * the evidence check (issue #2332: this repo is public with no interaction
 * restrictions, so any free GitHub account can otherwise post a comment
 * matching the marker + verdict text below).
 */
const TRUSTED_REVERSAL_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * A reversal comment is a `FORGE:INVESTIGATOR` annotation whose verdict is
 * INVALID — i.e. a second investigation report that supersedes the
 * original CONFIRMED/PARTIAL verdict with citable evidence (see #2312's
 * "Investigation Report — CORRECTED" comment for the live example this
 * pattern is modeled on). Matching on the marker + verdict line only (not
 * on incident-specific text like issue numbers or the word "CORRECTED")
 * keeps this a general-purpose evidence check, not a one-off special case.
 *
 * In addition to the marker + verdict text, the comment's author must carry
 * a trusted `authorAssociation` (see TRUSTED_REVERSAL_AUTHOR_ASSOCIATIONS
 * above, issue #2332) — otherwise any commenter, with no write access to the
 * repository, could forge the marker text and unlock this transition.
 *
 * @param {Array<{body?: string, authorAssociation?: string}>} comments
 * @returns {boolean}
 */
function hasInvalidReversalEvidence(comments) {
  if (!Array.isArray(comments)) return false;
  return comments.some((c) => {
    const body = String((c && c.body) || "");
    if (!body.includes("FORGE:INVESTIGATOR")) return false;
    if (!/\*\*Verdict\*\*:\s*INVALID/i.test(body)) return false;
    const association = String((c && c.authorAssociation) || "").toUpperCase();
    return TRUSTED_REVERSAL_AUTHOR_ASSOCIATIONS.has(association);
  });
}

/** Labels that are never allowed as a PR --base target. */
const FORBIDDEN_PR_BASES = ["main", "master"];

/** Labels that are always valid (non-workflow labels are not constrained). */
const WORKFLOW_LABEL_PREFIX = "workflow:";

// ---------------------------------------------------------------------------
// Rule 5 constants (issue #2034)
// Declared here — above the top-level `await main()` call — for the same
// reason the label-transition/PR-base constants above are: a top-level
// `await` suspends module evaluation at that statement, so any top-level
// `const` declared textually AFTER it (unlike hoisted `function` declarations)
// is still in its temporal dead zone when `main()` first runs, and would
// throw a ReferenceError the instant `checkFindRoot()` reads it — silently
// swallowed by main()'s fail-open catch, defeating the whole rule.
// ---------------------------------------------------------------------------

/**
 * Match a `find` search-root token that reaches the exact same whole-drive,
 * non-terminating scan on Git Bash as the bare filesystem root (`/`) or a
 * bare drive mount (`/c`, `/d`, ...). This includes trailing-slash drive
 * mounts (`/c/`) — a natural way to write the same root, since `/c` and
 * `/c/` are the identical directory — and the dot/double-slash root
 * variants `/.`, `/..`, `//`, which likewise resolve to (or immediately
 * above, which Git Bash still normalizes to) the same whole-drive tree
 * (issue #2113 — PR #2112 review finding SEC-1: `find /c/` was silently
 * ALLOWED because the prior regex had no trailing-slash/dot alternative).
 * This also includes the trailing-slash dot forms `/./` and `/../` — the
 * dot alternative did not originally carry the same optional trailing
 * slash the drive-letter alternative got in #2113, so those two bare
 * tokens reached the identical whole-drive scan but were wrongly ALLOWED
 * (issue #2213).
 *
 * Deliberately does NOT match `/c/Users/...`, `/./foo`, `/../foo` (with
 * anything beyond the trailing slash), or any other scoped absolute path —
 * only the bare root/drive-mount token itself, optionally followed by
 * exactly one trailing slash (drive-letter and dot/double-slash cases) or
 * standing alone. Case-insensitive on the drive letter only (POSIX paths
 * are otherwise case-sensitive).
 */
const FIND_ROOT_TOKEN_RE = /^\/(?:[a-zA-Z]\/?|\.{1,2}\/?|\/)?$/;

/**
 * Shell metacharacters that can glue a command name to an adjacent token
 * without whitespace (e.g. `cd /tmp;find /`, `$(find /...)`, `` `find /` ``,
 * `echo x&&find /`). `tokenizeCommand()` only splits on whitespace and
 * quotes, so without this extra split step a `find` immediately following
 * one of these characters stays fused into the previous token (e.g. the
 * single token `/tmp;find` or `$(find`) and is never recognized as a `find`
 * invocation — a real, exploitable bypass of Rule 5 (issue #2034 review
 * finding SEC-1). Declared here (above `try { await main(); }`) for the
 * same temporal-dead-zone reason as `FIND_ROOT_TOKEN_RE` above.
 */
const SHELL_METACHAR_SPLIT_RE = /[;&|()$`]+/;

// ---------------------------------------------------------------------------
// Attribution guard constants (Rule 6)
// Declared here — above the top-level `await main()` call — so they are
// initialized before the hook runs, for the same temporal-dead-zone reason
// documented for the Rule 5 constants above. `checkAttribution` (a hoisted
// function declaration) is defined further down, but the const values it
// closes over must exist at call time or the reference throws into the
// fail-open catch, silently defeating the rule.
// ---------------------------------------------------------------------------

/**
 * Canonical ForgeDock signature line. The single source of truth for the
 * pipeline's brand footer — command specs (work-on/review, review-pr,
 * work-on/investigate) render this same wording. Kept here so the enforcement
 * message can quote the exact replacement the agent should use.
 */
const FORGEDOCK_SIGNATURE =
  "⚒️ Orchestrated with [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock) — state, scheduling, review, and memory on GitHub.";

/**
 * Markers of the Claude Code harness default attribution. These are the exact
 * signatures the assistant appends by default to commits and PR bodies; none
 * of them belong in a repo's public commit/PR/issue history when the work is
 * produced by the ForgeDock pipeline.
 *
 * Matching is case-insensitive and scoped (below) to commands that actually
 * write a commit message or a GitHub body/comment, so mentions of "Claude
 * Code" in unrelated commands (docs edits, greps) never trip this rule.
 */
const AI_ATTRIBUTION_MARKERS = [
  /generated\s+with\s+\[?claude\s+code/i, // "🤖 Generated with [Claude Code](...)" / "Generated with Claude Code"
  /co-authored-by:\s*claude/i,            // "Co-Authored-By: Claude ..."
  /noreply@anthropic\.com/i,              // the anthropic co-author trailer email
];

/**
 * Commands that carry a commit message or a GitHub body/comment — the only
 * surfaces where an attribution footer can be persisted to history.
 */
const ATTRIBUTION_SCOPED_COMMANDS = [
  /git\s+commit\b/,
  /gh\s+pr\s+(?:create|edit|comment)\b/,
  /gh\s+issue\s+(?:create|edit|comment)\b/,
];

// ---------------------------------------------------------------------------
// Main — fail-open wrapper
// ---------------------------------------------------------------------------

try {
  await main();
} catch {
  // Fail open — never block a tool call due to a hook error.
  process.exit(0);
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) { process.exit(0); return; }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); return;
  }

  if (payload.hook_event_name !== "PreToolUse") { process.exit(0); return; }

  const toolName = payload.tool_name || "";
  const toolInput = payload.tool_input || {};

  // Only intercept Bash tool calls.
  if (toolName !== "Bash") { process.exit(0); return; }

  const command = String(toolInput.command || "");

  // --- Rule 5: Filesystem-root `find` guard ---
  // Deliberately checked BEFORE the isForgeDockManagedCwd() gate below — a
  // root-anchored `find` is a universal footgun with no legitimate use in
  // any directory (managed or not), and must fire inside git worktrees,
  // which typically carry no forge.yaml/.forgedock marker (issue #2034).
  const findRootViolation = checkFindRoot(command);
  if (findRootViolation) {
    process.stderr.write(findRootViolation);
    process.exit(2);
    return;
  }

  // Only enforce Rules 1-4 and 6 inside a ForgeDock-managed project — this hook
  // installs globally (~/.claude/settings.json), so without this guard those
  // rules would fire in every unrelated repo on the machine (issue #1591).
  if (!(await isForgeDockManagedCwd())) { process.exit(0); return; }

  // --- Rule 1: PR branch target validation ---
  const prViolation = checkPrTarget(command);
  if (prViolation) {
    process.stderr.write(prViolation);
    process.exit(2);
    return;
  }

  // --- Rule 2: Label transition validation ---
  const labelViolation = checkLabelTransition(command);
  if (labelViolation) {
    process.stderr.write(labelViolation);
    process.exit(2);
    return;
  }

  // --- Rule 3: Declared precondition checks (forge-invariants.yaml) ---
  const preconditionViolation = await checkDeclaredPreconditions(command);
  if (preconditionViolation) {
    process.stderr.write(preconditionViolation);
    process.exit(2);
    return;
  }

  // --- Rule 4: Gist visibility guard ---
  const gistViolation = checkGistVisibility(command);
  if (gistViolation) {
    process.stderr.write(gistViolation);
    process.exit(2);
    return;
  }

  // --- Rule 6: Attribution guard ---
  const attributionViolation = checkAttribution(command);
  if (attributionViolation) {
    process.stderr.write(attributionViolation);
    process.exit(2);
    return;
  }

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Rule 3: Declared precondition checks (forge-invariants.yaml)
// ---------------------------------------------------------------------------

/**
 * Check declared pretooluse-scope invariants from forge-invariants.yaml.
 *
 * Currently evaluates the branch_must_exist_on_remote precondition for:
 *   - git checkout <branch>
 *   - git worktree add <path> [-b <branch>] <base>
 *   - git switch <branch>
 *
 * Wrapped in a try/catch in the caller (main()) — fail-open on any error.
 *
 * @param {string} command
 * @returns {Promise<string|null>} Error message or null if allowed.
 */
async function checkDeclaredPreconditions(command) {
  // Only intercept git commands that reference a branch.
  const isCheckout = /git\s+(?:checkout|switch)/.test(command) &&
    !/git\s+checkout\s+-[bf]/.test(command); // -b creates new branch (no check needed)
  const isWorktreeAdd = /git\s+worktree\s+add/.test(command);

  if (!isCheckout && !isWorktreeAdd) return null;

  // Extract branch name from command.
  let branch = null;
  if (isCheckout) {
    // git checkout <branch> or git switch <branch>
    // Avoid matching flags: skip tokens starting with -
    const m = command.match(/git\s+(?:checkout|switch)\s+(?:--\s+)?([^\s-][^\s]*)/);
    if (m) branch = m[1];
  } else if (isWorktreeAdd) {
    // git worktree add <path> <base> — base is typically origin/<branch> or just <branch>
    // Also handle: git worktree add <path> -b <new-branch> <base>
    const tokens = tokenizeCommand(command).map((t) => t.value);
    // Find -b flag if present (new branch — no remote check needed)
    const bIdx = tokens.indexOf("-b");
    if (bIdx !== -1) return null; // creating new branch — no remote existence check
    // Otherwise the last non-option argument after 'add' and path is the base
    const addIdx = tokens.findIndex((t) => t === "add");
    if (addIdx !== -1 && addIdx + 2 < tokens.length) {
      const base = tokens[addIdx + 2];
      // base may be 'origin/<branch>' — strip the remote prefix
      branch = base.replace(/^origin\//, "");
    }
  }

  if (!branch || branch.startsWith("-") || branch === "HEAD") return null;

  // Load invariants (cached after first load).
  const { module, decls } = await getInvariants();
  if (!module || !decls?.length) return null;

  // Evaluate the branch_must_exist precondition.
  const result = await module.checkPrecondition(decls, "branch_must_exist_on_remote", { branch });
  if (!result.ok) {
    return module.formatViolation(result) + "\n";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Project-scope guard (issue #1591)
// ---------------------------------------------------------------------------

/**
 * Determine whether the current working directory is a ForgeDock-managed
 * project — i.e. whether pipeline enforcement rules should apply here at
 * all. This hook installs into the user's global `~/.claude/settings.json`,
 * so it fires for every Bash call in every repo unless explicitly scoped.
 *
 * Reuses `bin/registry.mjs::resolveState`, the same primitive
 * `bin/hooks/session-start.mjs` already uses to decide whether to inject
 * ForgeDock context — a directory is managed iff it has a `forge.yaml` or
 * `.forgedock` marker (and hasn't been explicitly opted out).
 *
 * Fail-open: if `registry.mjs` cannot be dynamically imported (broken
 * install, missing file), falls back to a direct `forge.yaml`/`.forgedock`
 * existence check on cwd. If even that throws, returns false (no
 * enforcement) rather than letting an error propagate — consistent with
 * this hook's overall fail-open contract.
 *
 * @returns {Promise<boolean>}
 */
async function isForgeDockManagedCwd() {
  const cwd = process.cwd();
  try {
    const { resolveState } = await import(
      pathToFileURL(join(FORGE_HOME, "bin", "registry.mjs")).href
    );
    return resolveState(cwd) === "managed-active";
  } catch {
    try {
      return existsSync(join(cwd, "forge.yaml")) || existsSync(join(cwd, ".forgedock"));
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 1: PR branch target validation
// ---------------------------------------------------------------------------

/**
 * Check whether a gh pr create command targets a forbidden base branch.
 *
 * Allows staging → main PRs (the deploy path) by detecting --head staging
 * or falling back to the current git branch. Feature branches targeting
 * main are still hard-blocked.
 *
 * @param {string} command
 * @returns {string|null} Error message to show, or null if allowed.
 */
function checkPrTarget(command) {
  // Only check gh pr create commands.
  if (!/gh\s+pr\s+create/.test(command)) return null;

  const base = extractFlag(command, "--base") || extractFlag(command, "-B");
  if (!base) return null; // no --base flag — gh will use the default

  if (FORBIDDEN_PR_BASES.includes(base.toLowerCase())) {
    // Allow staging → main (the deploy path, not a pipeline violation).
    const head = extractFlag(command, "--head") || extractFlag(command, "-H") || currentGitBranch();
    if (head && /^staging$/.test(head)) {
      return null; // deploy flow — allowed
    }

    return [
      `[ForgeDock] BLOCKED: PR targets "${base}" — pipeline rule violation.`,
      ``,
      `PRs MUST target "staging" (fast lane) or "milestone/<slug>" (feature lane).`,
      `A PR to "${base}" is a hard pipeline violation. Fix the --base flag.`,
      ``,
      `Allowed targets: staging | milestone/<slug>`,
      `Exception: staging → main (deploy flow) is allowed.`,
    ].join("\n");
  }

  // Warn if the base doesn't match expected patterns, but don't hard-block
  // (the project may have custom branch names).
  return null;
}

// ---------------------------------------------------------------------------
// Rule 2: Label transition validation
// ---------------------------------------------------------------------------

/**
 * Check whether a gh issue edit --add-label command represents a valid
 * label state-machine transition.
 *
 * Reads the current workflow labels from GitHub via `gh issue view` and
 * validates that the new label is a legal successor in the state machine.
 * Falls back to allow (exit 0) on a `gh` CLI error for ordinary transitions,
 * so the hook stays resilient to transient `gh`/network failures. The one
 * exception (#2347): when the attempted transition is to `workflow:invalid`
 * (`mayNeedEvidence`), the same lookup also fetches the reversal-evidence
 * comments required by the evidence gate below — a `gh` error there fails
 * *closed* instead, so a transient CLI error can never silently bypass the
 * evidence gate the way a blanket fail-open would.
 *
 * @param {string} command
 * @returns {string|null} Error message to show, or null if allowed.
 */
function checkLabelTransition(command) {
  // Only check gh issue edit commands that add labels.
  if (!/gh\s+issue\s+edit/.test(command)) return null;
  if (!command.includes("--add-label")) return null;

  const newLabel = extractFlag(command, "--add-label");
  if (!newLabel) return null;
  if (!newLabel.startsWith(WORKFLOW_LABEL_PREFIX)) return null; // non-workflow label, skip

  // The new label must be a known workflow label.
  if (!Object.prototype.hasOwnProperty.call(LABEL_TRANSITIONS, newLabel) &&
      !Object.values(LABEL_TRANSITIONS).some((arr) => arr.includes(newLabel))) {
    return null; // unknown workflow label — don't block
  }

  // Extract the issue number from the command.
  // Supports: `gh issue edit 123`, `gh issue edit #123`, `-R repo` or positional
  const issueNumM = command.match(/gh\s+issue\s+edit\s+(?:#?(\d+)|(\d+))/);
  if (!issueNumM) return null; // can't determine issue — fail-open
  const issueNum = issueNumM[1] || issueNumM[2];

  // Extract repo (-R flag) if present.
  const repoFlag = extractFlag(command, "-R") || extractFlag(command, "--repo");

  // Read current labels from GitHub synchronously. Also fetch comments when
  // the requested transition is one that requires reversal evidence (see
  // EVIDENCE_REQUIRED_FOR_INVALID_FROM) — deferred to a single conditional
  // extra field so the common case (any other transition) stays a
  // labels-only fetch, unchanged from before #2326.
  let currentWorkflowLabel = null;
  let comments = null;
  const mayNeedEvidence = newLabel === "workflow:invalid";
  try {
    const { execFileSync: exec } = _require("child_process");
    const fields = mayNeedEvidence ? "labels,comments" : "labels";
    const args = ["issue", "view", issueNum, "--json", fields];
    if (repoFlag) { args.push("-R", repoFlag); }
    const out = exec("gh", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 8000,
    });
    const parsed = JSON.parse(out);
    const labels = Array.isArray(parsed.labels)
      ? parsed.labels.map((l) => (typeof l === "string" ? l : l.name))
      : [];
    // Find the current workflow label (the most specific one, last wins).
    for (const lbl of labels) {
      if (lbl.startsWith(WORKFLOW_LABEL_PREFIX)) {
        currentWorkflowLabel = lbl;
      }
    }
    if (mayNeedEvidence) {
      comments = Array.isArray(parsed.comments) ? parsed.comments : [];
    }
  } catch {
    if (mayNeedEvidence) {
      // #2347: the lookup that failed is the same one that would have
      // fetched the reversal-evidence comments for the workflow:invalid
      // evidence gate (#2326/#2332). Fail closed here instead of silently
      // allowing an unverified workflow:invalid transition through.
      return [
        `[ForgeDock] BLOCKED: Unable to verify workflow:invalid evidence (gh CLI error).`,
        ``,
        `Attempted transition: → "workflow:invalid"`,
        ``,
        `This transition requires verifying a posted reversal comment, but the`,
        `"gh issue view" lookup used to fetch that evidence failed. Failing`,
        `closed rather than silently bypassing the evidence gate.`,
        ``,
        `This is transient, not permanent: retry once "gh issue view ${issueNum}"`,
        `succeeds again (e.g. after a network blip or rate-limit reset).`,
      ].join("\n");
    }
    return null; // gh CLI error on an ordinary transition — fail-open
  }

  if (!currentWorkflowLabel) {
    // No current workflow label — allow any workflow label to be added.
    return null;
  }

  // Terminal labels cannot be transitioned away from.
  if (isTerminalLabel(currentWorkflowLabel)) {
    return [
      `[ForgeDock] BLOCKED: Label transition violation.`,
      ``,
      `Issue is in terminal state "${currentWorkflowLabel}" — no further transitions allowed.`,
      `Attempted to add: "${newLabel}"`,
      ``,
      `Terminal states (${Object.keys(LABEL_TRANSITIONS).filter((k) => LABEL_TRANSITIONS[k].length === 0).join(", ")}) are final.`,
    ].join("\n");
  }

  // Validate the transition against the state machine.
  const allowed = LABEL_TRANSITIONS[currentWorkflowLabel] || null;
  if (allowed === null) {
    return null; // current state not in map — unknown, fail-open
  }
  if (!allowed.includes(newLabel)) {
    return [
      `[ForgeDock] BLOCKED: Invalid label transition.`,
      ``,
      `Current workflow state: "${currentWorkflowLabel}"`,
      `Attempted transition: → "${newLabel}"`,
      `Allowed next states  : ${allowed.length > 0 ? allowed.map((s) => `"${s}"`).join(", ") : "(none — terminal)"}`,
      ``,
      `Fix: check the pipeline phase and apply the correct next workflow label.`,
    ].join("\n");
  }

  // Evidence precondition (#2326): reaching workflow:invalid from
  // ready-to-build/building/in-review is structurally allowed above, but
  // still gated against *casual* invalidation — see checkInvalidReversalEvidence()
  // below for the full rationale and evidence requirements.
  const evidenceError = checkInvalidReversalEvidence(newLabel, currentWorkflowLabel, comments);
  if (evidenceError) return evidenceError;

  return null; // valid transition — allow
}

/**
 * Evidence precondition (#2326): reaching workflow:invalid from
 * ready-to-build/building/in-review is structurally allowed by the label
 * transition state machine, but still gated against *casual* invalidation —
 * a bare relabel with no paper trail is blocked. Require a posted reversal
 * comment (a second FORGE:INVESTIGATOR annotation carrying "**Verdict**:
 * INVALID") already on the issue before allowing the transition through,
 * from a trusted author (issue #2332 — marker text alone is forgeable by
 * anyone who can comment on a public issue; see
 * TRUSTED_REVERSAL_AUTHOR_ASSOCIATIONS).
 *
 * Extracted from checkLabelTransition() (issue #2453) as a separable
 * sub-concern — same inputs/outputs, no behavior change.
 *
 * @param {string} newLabel
 * @param {string|null} currentWorkflowLabel
 * @param {Array|null} comments
 * @returns {string|null} Error message to show, or null if allowed.
 */
function checkInvalidReversalEvidence(newLabel, currentWorkflowLabel, comments) {
  if (newLabel === "workflow:invalid" && EVIDENCE_REQUIRED_FOR_INVALID_FROM.has(currentWorkflowLabel)) {
    if (!hasInvalidReversalEvidence(comments)) {
      return [
        `[ForgeDock] BLOCKED: workflow:invalid requires reversal evidence.`,
        ``,
        `Current workflow state: "${currentWorkflowLabel}"`,
        `Attempted transition: → "workflow:invalid"`,
        ``,
        `This transition is allowed only when the issue carries a posted reversal:`,
        `a FORGE:INVESTIGATOR comment with "**Verdict**: INVALID" documenting the`,
        `evidence that disproved the original premise (see #2312 for the pattern),`,
        `posted by an author with a trusted authorAssociation (OWNER, MEMBER, or`,
        `COLLABORATOR — see #2332). A comment matching the marker text from any`,
        `other commenter does not satisfy this gate.`,
        ``,
        `Fix: post the corrected investigation report first (verdict INVALID, with`,
        `evidence, from a trusted account), then retry this label transition.`,
      ].join("\n");
    }
  }

  return null; // no evidence required, or evidence present — allow
}

// ---------------------------------------------------------------------------
// Rule 4: Gist visibility guard (issue #1729)
// ---------------------------------------------------------------------------

/**
 * Check whether a gh gist create command uses the --public flag.
 *
 * Pipeline gists (FORGE:KNOWLEDGE_GIST, FORGE:MILESTONE_INDEX, FORGE:PRIOR_GIST,
 * FORGE:MEMORY_INDEX) MUST be secret. Passing --public to gh gist create publishes
 * investigation findings — root causes, file paths, security details — to a
 * world-readable URL. gh gist create is secret by default; this rule blocks any
 * explicit --public override so a future spec edit cannot reintroduce a public gist.
 *
 * Override: FORGE_ALLOW_PUBLIC_GIST=1 in the operator's shell environment.
 * This env var must be set BEFORE starting Claude Code — it is read from process.env
 * at hook startup, not from the tool payload, so agents cannot bypass it by setting
 * the variable via a Bash tool call in the same session.
 *
 * @param {string} command
 * @returns {string|null} Error message to show, or null if allowed.
 */
function checkGistVisibility(command) {
  // Only check gh gist create commands.
  if (!/gh\s+gist\s+create/.test(command)) return null;

  // Allow operator override via env var.
  if (process.env.FORGE_ALLOW_PUBLIC_GIST === "1") return null;

  // Check for --public flag (space form, equals form, and standalone --public).
  // extractFlag handles --public=value; for the bare boolean flag --public we
  // additionally check whether "--public" appears as a standalone token.
  const tokens = tokenizeCommand(command);
  const hasPublicFlag = tokens.some(({ value }) => value === "--public") ||
    extractFlag(command, "--public") !== null;

  if (hasPublicFlag) {
    return [
      `[ForgeDock] BLOCKED: gh gist create --public is a pipeline violation.`,
      ``,
      `Pipeline gists (FORGE:KNOWLEDGE_GIST, FORGE:MILESTONE_INDEX, FORGE:PRIOR_GIST,`,
      `FORGE:MEMORY_INDEX) MUST be created secret. Passing --public publishes`,
      `investigation findings — root causes, file paths, security details — to a`,
      `world-readable URL. Remove the --public flag (gh gist create is secret by default).`,
      ``,
      `Exception: set FORGE_ALLOW_PUBLIC_GIST=1 in your shell environment BEFORE`,
      `starting Claude Code if you intentionally need a public gist.`,
    ].join("\n");
  }

  return null;
}

// ---------------------------------------------------------------------------
// Rule 5: Filesystem-root `find` guard (issue #2034)
// ---------------------------------------------------------------------------

/**
 * Break each unquoted token from `tokenizeCommand()` on shell metacharacters
 * (`;`, `&`, `|`, `(`, `)`, `$`, `` ` ``) to recover `find` as its own
 * logical token even when it was written with no separating whitespace from
 * a command separator or a command-substitution opener (`$(find ...)`).
 *
 * A token is only passed through UNSPLIT (treated as inert argument text —
 * e.g. a `--body` value that merely *mentions* `find /` in prose) when its
 * quoting actually spans EMBEDDED WHITESPACE, proving the quotes were used
 * to glue multiple real words into one argument. `quoted` alone is NOT a
 * sufficient signal: `tokenizeCommand()` sets `quoted = true` the moment ANY
 * quote character appears anywhere in a token, including a degenerate empty
 * pair (`""`, `''`) glued onto otherwise-unquoted text. A command like
 * `cd /tmp;""find /` tokenizes to a single token `/tmp;find` flagged
 * `quoted: true` even though nothing was actually protected by the empty
 * quotes — real shells treat `""find` as the plain word `find`. Passing
 * that token through unsplit hid `find` inside `/tmp;find`, which never
 * exact-matches `"find"` in `checkFindRoot()`, bypassing the guard (issue
 * #2059). This mirrors the exact discriminator `extractFlag()` already uses
 * for the same class of decoy (issues #1519, #1591): "was quoted at all" is
 * the wrong test; "does the token contain embedded whitespace" is right.
 *
 * @param {string} command
 * @returns {string[]} Flattened list of logical token strings, in order.
 */
function extractLogicalTokens(command) {
  const raw = tokenizeCommand(command);
  const logical = [];
  for (const { value, quoted } of raw) {
    if (quoted && /\s/.test(value)) {
      logical.push(value);
      continue;
    }
    for (const piece of value.split(SHELL_METACHAR_SPLIT_RE)) {
      if (piece.length > 0) logical.push(piece);
    }
  }
  return logical;
}

/**
 * Check whether a Bash command contains a `find` invocation whose search
 * root is the filesystem root (`/`), a bare Git-Bash drive mount (`/c`,
 * `/d`, ...), a trailing-slash drive mount (`/c/`), or a dot/double-slash
 * root variant (`/.`, `/..`, `//`). On Windows Git Bash, `/` spans every
 * mounted drive, so a root-anchored `find` never terminates and accumulates
 * as an orphaned, CPU-exhausting process (issue #2034 — #1984 was a narrow
 * precursor fix that only patched a single call site + added a prose
 * guardrail; this is the systemic, deterministic follow-up. Issue #2113
 * widened the root-token match to also cover the trailing-slash/dot
 * variants, which reach the identical whole-drive scan but were not
 * originally matched by `FIND_ROOT_TOKEN_RE`).
 *
 * Scans ALL logical tokens for a `find` occurrence (not just the first word
 * of the command), so it catches `find` appearing after `&&`, `;`, `|`, a
 * command-substitution opener (`$(find ...)`), or backticks — not just a
 * command that starts with `find`. Matching is case-insensitive on the
 * command name (Windows resolves `Find`/`FIND` to the same binary as
 * `find`) but NOT on the root-path token itself (POSIX paths are
 * case-sensitive). Uses `extractLogicalTokens()` (quote-aware, and
 * metacharacter-aware) so flag-shaped or path-shaped text embedded inside
 * an unrelated quoted `--title`/`--body` value is never misread as a real
 * `find` invocation (same class of decoy documented for `extractFlag()` —
 * issues #1519, #1591), while a `find` glued to a shell metacharacter with
 * no whitespace is still caught (issue #2034 review finding SEC-1/SEC-2).
 *
 * For each `find` token found, the search root is taken as the first
 * following token that is not itself a `find` option (an option either
 * starts with `-` or is `!` — `find`'s own root argument is always a bare
 * positional path, never flag-shaped; the grouping operators `(`/`)` are
 * shell metacharacters already stripped out by `extractLogicalTokens()`).
 * Only an EXACT match against `FIND_ROOT_TOKEN_RE` blocks — `find
 * /c/Users/.../repo -maxdepth 2 -name x` and `find "$REPO_PATH" ...` are
 * legitimate, scoped searches and must be allowed.
 *
 * No operator override exists for this rule (unlike Rules 4/6-attribution)
 * — a root-anchored `find` has no legitimate use in any ForgeDock pipeline.
 *
 * @param {string} command
 * @returns {string|null} Error message to show, or null if allowed.
 */
function checkFindRoot(command) {
  if (!command) return null;
  // Cheap pre-filter to skip tokenization for the common case of a command
  // with no `find` anywhere. Quote characters AND backslashes are stripped
  // first so a degenerate/empty quote pair (`"f"ind`) or a backslash-escape
  // (`f\ind` — real bash for the plain word `find`) glued inside the word
  // itself doesn't break the substring match and cause a false "no find
  // here" short-circuit that skips tokenization entirely (issue #2059,
  // including the backslash-escape variant found in that issue's review).
  if (!/find/i.test(command.replace(/["'\\]/g, ""))) return null;

  const tokens = extractLogicalTokens(command);

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].toLowerCase() !== "find") continue;

    // The search root is the first token after `find` that isn't a `find`
    // option. `find` options always start with `-` (e.g. -maxdepth, -iname)
    // or are `!` — the root path is always a bare positional token.
    let rootToken = null;
    for (let j = i + 1; j < tokens.length; j++) {
      const val = tokens[j];
      if (val.startsWith("-") || val === "!") continue;
      rootToken = val;
      break;
    }

    if (rootToken && FIND_ROOT_TOKEN_RE.test(rootToken)) {
      return [
        `[ForgeDock] BLOCKED: \`find\` rooted at filesystem root "${rootToken}".`,
        ``,
        `A \`find\` search starting at "${rootToken}" scans every mounted drive on`,
        `Windows and never terminates — it becomes an orphaned, CPU-exhausting`,
        `process once the parent sub-agent exits (issue #2034).`,
        ``,
        `Fix: scope the search to $REPO_PATH or a known path, e.g.:`,
        `  find "$REPO_PATH" -iname "<pattern>"`,
        ``,
        `No override exists for this rule — a root-anchored \`find\` has no`,
        `legitimate use in any ForgeDock pipeline.`,
      ].join("\n");
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Rule 6: Attribution guard
// ---------------------------------------------------------------------------

/**
 * Check whether a commit/PR/issue command carries Claude Code default
 * attribution. Blocks it so ForgeDock-branded pipeline output never inherits
 * the assistant-tool signature.
 *
 * Override: FORGE_ALLOW_AI_ATTRIBUTION=1 in the operator's shell environment
 * (read at hook startup, not from the tool payload — agents cannot set it via
 * a Bash tool call in the same session).
 *
 * @param {string} command
 * @returns {string|null} Error message to show, or null if allowed.
 */
function checkAttribution(command) {
  // Operator override.
  if (process.env.FORGE_ALLOW_AI_ATTRIBUTION === "1") return null;

  // Only scan commands that persist a message/body to history.
  if (!ATTRIBUTION_SCOPED_COMMANDS.some((re) => re.test(command))) return null;

  const hit = AI_ATTRIBUTION_MARKERS.find((re) => re.test(command));
  if (!hit) return null;

  return [
    `[ForgeDock] BLOCKED: Claude Code default attribution in a commit/PR/issue.`,
    ``,
    `The command carries the assistant-tool attribution ("🤖 Generated with`,
    `Claude Code" / "Co-Authored-By: Claude" / noreply@anthropic.com). Pipeline`,
    `output is ForgeDock-branded — this must never land in the repo's public`,
    `commit, PR, or issue history.`,
    ``,
    `Fix: remove the attribution line/trailer. If you want a brand footer, use`,
    `the ForgeDock signature instead:`,
    `  ${FORGEDOCK_SIGNATURE}`,
    ``,
    `Exception: set FORGE_ALLOW_AI_ATTRIBUTION=1 in your shell environment BEFORE`,
    `starting Claude Code if you intentionally need the assistant attribution.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Return the current git branch name, or null on any failure.
 * Used to detect the staging → main deploy path.
 */
function currentGitBranch() {
  try {
    const { execFileSync: exec } = _require("child_process");
    return exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CommandToken
 * @property {string} value    The token text, with surrounding quotes removed.
 * @property {boolean} quoted  True if ANY character of this token originated
 *                             inside single or double quotes.
 */

/**
 * Split a shell command string into argv-like tokens, honoring single and
 * double quotes so that quoted argument values (e.g. `--title "..."`) are
 * never split apart or scanned as separate tokens.
 *
 * Each token carries a `quoted` flag recording whether any of its characters
 * came from inside quotes. This flag is retained for diagnostics, but
 * `extractFlag` does NOT use it to decide whether a token can be a flag —
 * see the note on `extractFlag` (issue #1591) for why "was any character
 * quoted" is the wrong discriminator.
 *
 * This is intentionally NOT a full POSIX shell parser — it doesn't handle
 * `$()`, backticks, or command chaining. It DOES handle backslash-escapes
 * outside quotes (`\X` collapses to the literal character `X`, matching real
 * bash semantics) — added for issue #2059 to close a `find`-guard bypass
 * where `f\ind` tokenized with a literal backslash byte and never
 * exact-matched `"find"`. It only needs to be accurate enough to distinguish
 * "a flag in argument position" from "flag-shaped text embedded inside a
 * different argument's value", which is all `extractFlag` needs (issue
 * #1519), and to recover `find` as its own token regardless of escaping.
 *
 * @param {string} command
 * @returns {CommandToken[]}
 */
function tokenizeCommand(command) {
  const tokens = [];
  let current = "";
  let quoted = false;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }

    if (inDouble) {
      if (ch === '"') inDouble = false;
      else current += ch;
      continue;
    }

    // Backslash-escape (outside quotes only — matches real bash semantics for
    // `\X` when not already inside single/double quotes). A backslash strips
    // the special meaning of the following character and the pair collapses
    // to that character literally: `f\ind` is the plain word `find` to a real
    // shell. Without this, `extractLogicalTokens()`'s exact-match check
    // against `"find"` never fires because the token still contains a literal
    // backslash byte (issue #2059 review finding — CONFIRMED HIGH). If the
    // escaped character is whitespace, treat the token as `quoted` (glued
    // words), mirroring the embedded-whitespace decoy-protection discriminator
    // used elsewhere in this file for real quoting (issues #1519, #1591).
    if (ch === "\\" && i + 1 < command.length) {
      const next = command[i + 1];
      current += next;
      if (/\s/.test(next)) quoted = true;
      i++; // consume the escaped character; the for-loop's own increment moves past it
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      quoted = true;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      quoted = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push({ value: current, quoted });
      }
      current = "";
      quoted = false;
      continue;
    }

    current += ch;
  }

  if (current.length > 0) tokens.push({ value: current, quoted });
  return tokens;
}

/**
 * Extract the value of a CLI flag from a command string.
 * Handles `--flag value`, `--flag=value`, and — for single-dash, single-letter
 * short flags only (e.g. `-B`, `-R`) — the attached form `-Bvalue`.
 *
 * Tokenizes the command first (see `tokenizeCommand`) and matches the flag
 * against actual argv tokens — NOT against substrings anywhere in the raw
 * command string. This prevents flag-shaped text inside a quoted argument
 * value (e.g. `--title "Fix -B main thread bug"`) from being misread as a
 * real flag (issue #1519).
 *
 * The attached form is valid getopt-style syntax that real CLIs (including
 * `gh`) accept for single-dash short flags — e.g. `gh pr create -Bmain` is
 * equivalent to `gh pr create -B main`. Without this branch, a forbidden PR
 * base written as `-Bmain` would produce no match and bypass the hard block
 * (issue #1550). The attached-form check is scoped to 2-character single-dash
 * flags so long flags (`--base`) are never affected.
 *
 * DECOY RULE: the equals form (`-B=value`/`--base=value`) and the attached
 * form (`-Bvalue`) are skipped on any token that contains EMBEDDED
 * WHITESPACE — not on any token that was merely quoted.
 *
 * A shell token can only contain whitespace if quoting was used to glue
 * multiple words into a single argument (e.g. `--title "-Bstaging is
 * fine"` — the value is a whole sentence, not a flag). That is the actual
 * signature of the issue #1519 decoy: flag-shaped text embedded inside an
 * unrelated multi-word `--title`/`--body` value. Skipping on embedded
 * whitespace preserves that protection.
 *
 * A single-word token being quoted, on the other hand, changes nothing about
 * the resulting argv entry — `"-Bmain"`, `'-Bmain'`, and `-Bmain` are all
 * identical once the shell hands the argument to `gh`, as are `--base="main"`
 * and `--base=main`. Treating "was quoted at all" as reason enough to skip
 * (the previous behaviour) let these single-word quoted forms sail through
 * untouched — a real, commonly-written bypass (issue #1591), not a decoy.
 * So quoting alone must never exempt a token from these checks; only
 * embedded whitespace does. The exact form (`token === flag`) stays
 * quote-insensitive as before: a fully-quoted `"-B"` in flag position is
 * unambiguously the flag, and its value is the next token regardless of
 * quoting.
 *
 * @param {string} command
 * @param {string} flag  e.g. "--base" or "-B"
 * @returns {string|null}
 */
function extractFlag(command, flag) {
  const tokens = tokenizeCommand(command);
  const eqPrefix = `${flag}=`;
  const isShortFlag = flag.length === 2 && flag[0] === "-" && flag[1] !== "-";

  for (let i = 0; i < tokens.length; i++) {
    const { value: token } = tokens[i];

    // --flag value form (value is the next token). Quote-insensitive: an exact
    // token match is unambiguous even when the flag itself was quoted.
    if (token === flag) {
      return i + 1 < tokens.length ? tokens[i + 1].value : null;
    }

    // Prefix-based forms below must not fire on a token that required
    // quoting to glue multiple words into one argument — that shape is the
    // real #1519 decoy signature (e.g. a --title value that happens to
    // start with flag-looking text). A token can only contain whitespace if
    // it came from inside quotes, so embedded whitespace — not quoting
    // itself — is the correct discriminator (issue #1591).
    if (/\s/.test(token)) continue;

    // --flag=value form (also covers the equals form of a short flag, e.g. -B=value)
    if (token.startsWith(eqPrefix)) {
      return token.slice(eqPrefix.length);
    }

    // -Bvalue attached form (single-dash short flags only, e.g. -Bmain)
    if (isShortFlag && token.startsWith(flag) && token.length > flag.length) {
      return token.slice(flag.length);
    }
  }

  return null;
}

function isTerminalLabel(label) {
  const successors = LABEL_TRANSITIONS[label];
  return successors !== undefined && successors.length === 0;
}

// ---------------------------------------------------------------------------
// stdin reader
// ---------------------------------------------------------------------------

async function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(""));
    setTimeout(() => resolve(buf), 1000);
  });
}
