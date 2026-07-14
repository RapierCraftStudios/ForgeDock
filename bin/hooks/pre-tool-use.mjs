#!/usr/bin/env node
import { createRequire } from "module";
import { existsSync, readFileSync } from "fs";
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
 * Both rules only apply inside a ForgeDock-managed directory (a directory
 * with a `forge.yaml` or `.forgedock` marker) — see `isForgeDockManagedCwd()`
 * (issue #1591). The hook installs into the user's global
 * `~/.claude/settings.json`, so without this guard every Bash call in every
 * repo on the machine would be subject to these ForgeDock-specific rules,
 * including unrelated repos where `main` is a legitimate PR target.
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
 */
const LABEL_TRANSITIONS = {
  "workflow:investigating": ["workflow:ready-to-build", "workflow:invalid", "workflow:decomposed"],
  "workflow:ready-to-build": ["workflow:building"],
  "workflow:building": ["workflow:in-review", "workflow:ready-to-build"], // retry allowed
  "workflow:in-review": ["workflow:merged", "workflow:building"],         // review → re-build allowed
  "workflow:merged": [],     // terminal — no successors
  "workflow:invalid": [],    // terminal
  "workflow:decomposed": [], // terminal
};

/** Labels that are never allowed as a PR --base target. */
const FORBIDDEN_PR_BASES = ["main", "master"];

/** Labels that are always valid (non-workflow labels are not constrained). */
const WORKFLOW_LABEL_PREFIX = "workflow:";

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

  // Only enforce inside a ForgeDock-managed project — this hook installs
  // globally (~/.claude/settings.json), so without this guard both rules
  // below would fire in every unrelated repo on the machine (issue #1591).
  if (!(await isForgeDockManagedCwd())) { process.exit(0); return; }

  const command = String(toolInput.command || "");

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
 * Read the configured project repo slug ("owner/repo") from the cwd's
 * `forge.yaml` → `project.owner` / `project.repo`.
 *
 * Deliberately a line-anchored regex rather than a YAML parse: this hook runs
 * on every tool call and must stay synchronous and dependency-free. The
 * `^\s*owner:` anchor cannot match a commented-out `#   owner:` line, so the
 * commented `repos:` template block that `forgedock init` emits is ignored.
 *
 * @returns {string|null} lowercased "owner/repo", or null if undeterminable.
 */
function projectRepoSlug() {
  try {
    const configPath = join(process.cwd(), "forge.yaml");
    if (!existsSync(configPath)) return null;
    const text = readFileSync(configPath, "utf-8");
    const owner = text.match(/^\s*owner:\s*["']?([A-Za-z0-9._-]+)/m)?.[1];
    const repo = text.match(/^\s*repo:\s*["']?([A-Za-z0-9._-]+)/m)?.[1];
    if (!owner || !repo) return null;
    return `${owner}/${repo}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Check whether a gh pr create command targets a forbidden base branch.
 *
 * Allows staging → main PRs (the deploy path) by detecting --head staging
 * or falling back to the current git branch. Feature branches targeting
 * main are still hard-blocked.
 *
 * Only governs the configured project repo. A `gh pr create -R other/repo`
 * targets a third-party repository whose branch conventions are not ours to
 * enforce — see the project-scope guard below.
 *
 * @param {string} command
 * @returns {string|null} Error message to show, or null if allowed.
 */
function checkPrTarget(command) {
  // Only check gh pr create commands.
  if (!/gh\s+pr\s+create/.test(command)) return null;

  const base = extractFlag(command, "--base") || extractFlag(command, "-B");
  if (!base) return null; // no --base flag — gh will use the default

  // Project-scope guard (forge#1920). This rule exists to protect THIS
  // project's deploy pipeline, where `main` is the deploy trigger. It must not
  // govern PRs to unrelated repositories: an upstream awesome-list, a docs
  // typo fix, or any third-party contribution typically has `main` as its ONLY
  // valid base and no `staging` branch at all, so blocking it is a guaranteed
  // false positive that makes legitimate external contribution impossible.
  //
  // Explicitly conservative: an UNDETERMINABLE project slug (no forge.yaml, or
  // no project.owner/repo in it) falls through to enforcement rather than
  // skipping it, so a malformed config can never silently disarm the guard on
  // the repo it is meant to protect. Only a *positive* mismatch — an explicit
  // --repo/-R naming a repo that is demonstrably not ours — is exempted.
  const targetRepo = extractFlag(command, "--repo") || extractFlag(command, "-R");
  if (targetRepo) {
    const ownSlug = projectRepoSlug();
    if (ownSlug && targetRepo.toLowerCase() !== ownSlug) {
      return null; // external repo — not ours to govern
    }
  }

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
 * Falls back to allow (exit 0) on any gh CLI error so the hook is fail-open.
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

  // Read current labels from GitHub synchronously.
  let currentWorkflowLabel = null;
  try {
    const { execFileSync: exec } = _require("child_process");
    const args = ["issue", "view", issueNum, "--json", "labels"];
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
  } catch {
    return null; // gh CLI error — fail-open
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

  return null; // valid transition — allow
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
 * escapes, `$()`, backticks, or command chaining. It only needs to be
 * accurate enough to distinguish "a flag in argument position" from
 * "flag-shaped text embedded inside a different argument's value", which is
 * all `extractFlag` needs (issue #1519).
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
