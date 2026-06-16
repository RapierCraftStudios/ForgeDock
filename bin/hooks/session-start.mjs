#!/usr/bin/env node
/**
 * session-start.mjs — ForgeDock SessionStart hook.
 *
 * Installed into ~/.claude/settings.json by `forgedock install`.
 * Removed by `forgedock uninstall`.
 *
 * Called by Claude Code at the start of every session. Resolves the
 * per-directory ForgeDock state and acts accordingly:
 *
 *   managed-active   → print ForgeDock context to stdout (forge.yaml summary
 *                       + available commands). If forge.yaml is missing or
 *                       stale, offer a one-shot autopilot init suggestion.
 *   managed-optedout → completely silent (no output, no context injection).
 *   unmanaged        → print a one-time, suppressible "Enable ForgeDock here?"
 *                       nudge. Subsequent sessions for the same directory are
 *                       silent after the nudge is recorded.
 *
 * Fail-open contract: any uncaught error is swallowed and the hook exits 0
 * so that a broken hook never prevents a Claude Code session from starting.
 *
 * Environment:
 *   Claude Code sets the working directory before invoking the hook, so
 *   process.cwd() reliably returns the session's project directory.
 *   FORGE_HOME is resolved at install time and baked into the command path,
 *   so this file's __dirname is always the hooks/ directory inside the
 *   ForgeDock installation.
 */

import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join, resolve } from "path";
import { existsSync, readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Bootstrap — resolve paths from the hook's own location, not from cwd
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** Absolute path to the ForgeDock installation root (parent of bin/). */
const FORGE_HOME = resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Registry helpers — populated inside the try block to honour fail-open
// ---------------------------------------------------------------------------

// Declared at module scope so they are accessible from handler functions
// (handleUnmanaged) called from within the try block. Assigned inside the
// try/catch so that any import failure (missing file, permissions error,
// syntax error) is caught and the hook still exits 0. <!-- fix: forge#383 -->
let resolveState;
let nudgeSeen;
let markNudgeSeen;

// ---------------------------------------------------------------------------
// forge-utils helpers — populated inside the try block to honour fail-open
// ---------------------------------------------------------------------------

// Declared at module scope so they are accessible from context-builder
// functions called from within the try block. Assigned inside the try/catch
// so that any import failure (missing file, permissions error, syntax error)
// is caught and the hook still exits 0. <!-- fix: forge#489 -->
let parseForgeYaml;
let sanitizeContextValue;

// ---------------------------------------------------------------------------
// Main — wrapped in try/catch to guarantee fail-open
// ---------------------------------------------------------------------------

try {
  // Import registry helpers from the same installation.
  // Placed inside try/catch to honour the fail-open contract: if registry.mjs
  // cannot be loaded (broken install, missing file, permissions error) the
  // catch block below ensures we still exit 0 without blocking Claude Code.
  //
  // Use pathToFileURL() to convert the OS-native path to a file:// URL before
  // passing it to dynamic import(). On Windows, join() produces backslash paths
  // that import() rejects with ERR_UNSUPPORTED_ESM_URL_SCHEME.
  /** @type {import('../registry.mjs')} */
  (
    { resolveState, nudgeSeen, markNudgeSeen } = await import(
      pathToFileURL(join(FORGE_HOME, "bin", "registry.mjs")).href
    )
  );

  // Import forge-utils helpers from the same installation.
  // Placed inside try/catch to honour the fail-open contract: if forge-utils.mjs
  // cannot be loaded (broken install, missing file, permissions error) the
  // catch block below ensures we still exit 0 without blocking Claude Code.
  //
  // Use pathToFileURL() to convert the OS-native path to a file:// URL before
  // passing it to dynamic import(). On Windows, join() produces backslash paths
  // that import() rejects with ERR_UNSUPPORTED_ESM_URL_SCHEME.
  /** @type {import('../forge-utils.mjs')} */
  (
    { parseForgeYaml, sanitizeContextValue } = await import(
      pathToFileURL(join(FORGE_HOME, "bin", "forge-utils.mjs")).href
    )
  );

  const cwd = process.cwd();
  const state = resolveState(cwd);

  switch (state) {
    case "managed-active":
      await handleManagedActive(cwd);
      break;

    case "managed-optedout":
      // Completely silent — no output, no context injection
      break;

    case "unmanaged":
      await handleUnmanaged(cwd);
      break;

    default:
      // Unknown state — fail open (silent)
      break;
  }
} catch {
  // Fail open — never block a Claude Code session
  process.exit(0);
}

// Always exit 0 regardless of what happened above
process.exit(0);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Emit ForgeDock context for a managed-active directory.
 *
 * Prints a concise forge.yaml summary plus the list of available pipeline
 * commands. If forge.yaml is absent, prints a suggestion to run init instead.
 *
 * @param {string} dir - Absolute path to the project directory.
 */
async function handleManagedActive(dir) {
  const forgeYamlPath = join(dir, "forge.yaml");

  if (!existsSync(forgeYamlPath)) {
    // Directory is managed (has .forgedock marker) but has no forge.yaml yet
    console.log(buildMissingConfigContext(dir));
    return;
  }

  let forgeYaml;
  try {
    forgeYaml = readForgeYaml(forgeYamlPath);
  } catch {
    // Unreadable or corrupt forge.yaml — suggest init
    console.log(buildMissingConfigContext(dir));
    return;
  }

  console.log(buildActiveContext(dir, forgeYaml));
}

/**
 * Show a one-time suppressible nudge for unmanaged directories.
 *
 * Uses the registry to ensure the nudge fires at most once per directory.
 * After showing, records the directory so subsequent sessions are silent.
 *
 * @param {string} dir - Absolute path to the project directory.
 */
async function handleUnmanaged(dir) {
  if (nudgeSeen(dir)) {
    // Nudge already shown — stay silent
    return;
  }

  // Show the nudge, then record it so it won't show again
  console.log(buildNudgeContext(dir));

  // Best-effort — if this fails the nudge may show once more next session
  await markNudgeSeen(dir).catch(() => {});
}

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

/**
 * Build the context string injected for a managed-active directory with a
 * valid forge.yaml.
 *
 * @param {string} dir       - Absolute path to the project directory.
 * @param {object} forgeYaml - Parsed forge.yaml object.
 * @returns {string}
 */
function buildActiveContext(dir, forgeYaml) {
  // Sanitize the directory path before interpolating it into the context output.
  // process.cwd() is user-controlled on Linux (directory names may contain <, >,
  // or sequences that form <!-- -->), so it must be treated like any other
  // untrusted value. <!-- fix: forge#450 -->
  const safeDir = sanitizeContextValue(dir, 500) ?? "[project directory]";
  const project = forgeYaml.project ?? {};
  const projectName = sanitizeContextValue(project.name ?? null, 200);
  const owner = sanitizeContextValue(project.owner ?? null, 200);
  const repoName = sanitizeContextValue(project.repo ?? null, 200);
  const repo = owner && repoName ? `${owner}/${repoName}` : (repoName ?? null);
  const description = sanitizeContextValue(project.description ?? null, 400);

  const rawMilestone = sanitizeContextValue(forgeYaml.milestone ?? null, 200);
  const milestoneNote = rawMilestone
    ? `\n- **Active milestone**: ${rawMilestone}`
    : "";

  const nameNote = projectName ? `\n- **Project**: ${projectName}` : "";
  const repoNote = repo ? `\n- **Repo**: ${repo}` : "";
  const descNote = description ? `\n- **Description**: ${description}` : "";

  const stagingBranch = sanitizeContextValue(
    forgeYaml.branches?.staging ?? "staging",
    200,
  );
  const featurePattern = sanitizeContextValue(
    forgeYaml.branches?.feature_pattern ?? "milestone/{slug}",
    200,
  );

  return `\
<!-- ForgeDock: managed-active -->
**ForgeDock** is active in this directory (${safeDir}).
${nameNote}${repoNote}${descNote}${milestoneNote}
- **Staging branch**: \`${stagingBranch}\`
- **Feature branch pattern**: \`${featurePattern}\`

### Available pipeline commands

| Command | Purpose |
|---------|---------|
| /work-on | Pick up a GitHub issue and run the full pipeline |
| /orchestrate | Parallel work on multiple issues or a milestone |
| /review-pr | Context-aware PR review |
| /quality-gate | Pre-commit quality check |
| /issue | Create a well-structured GitHub issue |
| /milestone | Create, manage, and ship milestones |
| /deploy-info | Show what will deploy next |
| /analytics | Pull production analytics and create issues |
| /autopilot | Autonomous platform improvement cycle |

Run \`/help\` to see the full command list.
To remove ForgeDock commands: \`npx forgedock uninstall\``;
}

/**
 * Build the context string shown when a managed directory is missing or has
 * a corrupt forge.yaml.
 *
 * @param {string} dir - Absolute path to the project directory.
 * @returns {string}
 */
function buildMissingConfigContext(dir) {
  // Sanitize dir before display — see forge#450.
  const safeDir = sanitizeContextValue(dir, 500) ?? "[project directory]";
  return `\
<!-- ForgeDock: managed-active (no forge.yaml) -->
**ForgeDock** is active in this directory (${safeDir}) but no \`forge.yaml\` was found.

Run autopilot init to generate your configuration automatically:
  \`npx forgedock init\`

ForgeDock's AI will infer your project structure, GitHub repo, and pipeline settings
from the codebase — then present a single annotated review screen for you to confirm.`;
}

/**
 * Build the one-time nudge shown for unmanaged directories.
 *
 * @param {string} dir - Absolute path to the project directory.
 * @returns {string}
 */
function buildNudgeContext(dir) {
  // Sanitize dir before display — see forge#450.
  const safeDir = sanitizeContextValue(dir, 500) ?? "[project directory]";
  return `\
<!-- ForgeDock: unmanaged nudge -->
**ForgeDock** is installed but not active in this directory (${safeDir}).

To activate the autonomous development pipeline here:
  \`npx forgedock init\`   — generate forge.yaml and activate ForgeDock for this project

This message will not appear again in this directory.
To remove ForgeDock commands globally, run: \`npx forgedock uninstall\``;
}

// ---------------------------------------------------------------------------
// forge.yaml reader
// ---------------------------------------------------------------------------

/**
 * Read and parse forge.yaml from the given path.
 *
 * Uses a minimal YAML parser (key: "value" lines only — sufficient for the
 * fields we need from forge.yaml). Does NOT pull in a full YAML library so
 * the hook stays fast and dependency-free.
 *
 * The real forge.yaml schema has nested sections; this returns a two-level
 * object covering the top-level keys that session-start needs.
 *
 * @param {string} path - Absolute path to forge.yaml.
 * @returns {object} Parsed forge.yaml as a plain object.
 * @throws {Error} If the file cannot be read.
 */
function readForgeYaml(path) {
  const raw = readFileSync(path, "utf-8");
  return parseForgeYaml(raw);
}

// parseForgeYaml and sanitizeContextValue are dynamically imported from
// ../forge-utils.mjs inside the try block to honour the fail-open contract.
