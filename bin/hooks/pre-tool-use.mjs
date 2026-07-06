#!/usr/bin/env node
import { createRequire } from "module";
import { existsSync } from "fs";
import { dirname, join, resolve as resolvePath } from "path";
import { fileURLToPath, pathToFileURL } from "url";
const _require = createRequire(import.meta.url);

/** Absolute path to the ForgeDock installation root (parent of bin/). */
const FORGE_HOME = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

  process.exit(0);
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
 * @param {string} command
 * @returns {string|null} Error message to show, or null if allowed.
 */
function checkPrTarget(command) {
  // Only check gh pr create commands.
  if (!/gh\s+pr\s+create/.test(command)) return null;

  const base = extractFlag(command, "--base") || extractFlag(command, "-B");
  if (!base) return null; // no --base flag — gh will use the default

  if (FORBIDDEN_PR_BASES.includes(base.toLowerCase())) {
    return [
      `[ForgeDock] BLOCKED: PR targets "${base}" — pipeline rule violation.`,
      ``,
      `PRs MUST target "staging" (fast lane) or "milestone/<slug>" (feature lane).`,
      `A PR to "${base}" is a hard pipeline violation. Fix the --base flag.`,
      ``,
      `Allowed targets: staging | milestone/<slug>`,
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
