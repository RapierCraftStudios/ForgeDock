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
  ({ resolveState, nudgeSeen, markNudgeSeen } = await import(
    pathToFileURL(join(FORGE_HOME, "bin", "registry.mjs")).href
  ));

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
  const project = forgeYaml.project ?? {};
  const projectName = sanitizeContextValue(project.name ?? null, 200);
  const repo =
    project.owner && project.repo
      ? `${project.owner}/${project.repo}`
      : project.repo ?? null;
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
**ForgeDock** is active in this directory (${dir}).
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
To disable ForgeDock in this directory: \`npx forgedock disable\``;
}

/**
 * Build the context string shown when a managed directory is missing or has
 * a corrupt forge.yaml.
 *
 * @param {string} dir - Absolute path to the project directory.
 * @returns {string}
 */
function buildMissingConfigContext(dir) {
  return `\
<!-- ForgeDock: managed-active (no forge.yaml) -->
**ForgeDock** is active in this directory (${dir}) but no \`forge.yaml\` was found.

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
  return `\
<!-- ForgeDock: unmanaged nudge -->
**ForgeDock** is installed but not active in this directory (${dir}).

To enable the autonomous development pipeline here:
  \`npx forgedock enable\`   — mark this directory and stay silent until you run init
  \`npx forgedock init\`     — immediately generate forge.yaml with AI autopilot

This message will not appear again in this directory.
To suppress it globally, run: \`npx forgedock disable\``;
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

/**
 * Minimal two-level YAML parser for forge.yaml.
 *
 * Handles:
 *   - Top-level keys: `key:`
 *   - Nested scalar values: `  key: "value"` or `  key: value`
 *   - Quoted and unquoted values
 *   - Comment lines (#) and blank lines
 *
 * Does not handle: arrays, multiline strings, anchors, flow style.
 * These are not needed for the fields session-start reads.
 *
 * @param {string} raw - Raw YAML text.
 * @returns {object}
 */
function parseForgeYaml(raw) {
  const result = {};
  let currentSection = null;

  for (const line of raw.split("\n")) {
    // Skip comments and blank lines
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;

    // Top-level section header: `section:` (no value on same line)
    const sectionMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(?:#.*)?$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      result[currentSection] = {};
      continue;
    }

    // Top-level scalar: `key: value` (no leading whitespace)
    const topScalarMatch = line.match(
      /^([a-zA-Z_][a-zA-Z0-9_]*):\s+"([^"]*)"(?:\s*#.*)?$|^([a-zA-Z_][a-zA-Z0-9_]*):\s+([^#\n]+?)(?:\s*#.*)?$/,
    );
    if (topScalarMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      const key = topScalarMatch[1] ?? topScalarMatch[3];
      const value = topScalarMatch[2] ?? topScalarMatch[4]?.trim();
      if (key && value !== undefined) {
        currentSection = null;
        result[key] = value;
      }
      continue;
    }

    // Nested scalar under current section: `  key: value`
    if (currentSection && /^\s+/.test(line)) {
      const nestedMatch = line.match(
        /^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s+"([^"]*)"(?:\s*#.*)?$|^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s+([^#\n]+?)(?:\s*#.*)?$/,
      );
      if (nestedMatch) {
        const key = nestedMatch[1] ?? nestedMatch[3];
        const value = nestedMatch[2] ?? nestedMatch[4]?.trim();
        if (key && value !== undefined && typeof result[currentSection] === "object") {
          result[currentSection][key] = value;
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Context value sanitizer
// ---------------------------------------------------------------------------

/**
 * Sanitize a forge.yaml value before injecting it into the session context.
 *
 * A forge.yaml file may originate from a cloned repository rather than from
 * ForgeDock's own sanitized writer. This function ensures that untrusted
 * field values cannot inject markdown structural sequences or control
 * characters into the LLM session context.
 *
 * Strips:
 *   - Control characters U+0000-U+001F and U+007F-U+009F (including \r, \n, \t)
 *   - Leading markdown heading markers (one or more `#` followed by space)
 *   - YAML/Markdown horizontal rules (`---` at start of value)
 *   - HTML comment delimiters (`<!--` and `-->`)
 *   - Triple backtick sequences (fenced code block markers)
 *
 * Caps the value to `maxLen` characters after stripping.
 * Trims leading/trailing whitespace.
 *
 * Returns `null` for null/undefined input (preserves existing null guards in
 * the callers so that optional notes are omitted when the field is absent).
 *
 * Never throws — any internal error returns `null` so the hook stays fail-open.
 * <!-- fix: forge#418 -->
 *
 * @param {string|null|undefined} value  - Raw value from forge.yaml.
 * @param {number}                maxLen - Maximum allowed length after stripping.
 * @returns {string|null}
 */
function sanitizeContextValue(value, maxLen) {
  try {
    if (value == null) return null;
    // eslint-disable-next-line no-control-regex
    const str = String(value)
      // Strip control characters (C0 block U+0000-U+001F, DEL U+007F, C1 block U+0080-U+009F)
      .replace(/[\x00-\x1F\x7F-\x9F]/g, "")
      // Strip leading markdown headings (e.g. "## Title" → "Title")
      .replace(/^#+\s+/g, "")
      // Strip horizontal rule patterns at start of value
      .replace(/^---+/g, "")
      // Strip HTML comment delimiters
      .replace(/<!--/g, "")
      .replace(/-->/g, "")
      // Strip triple backtick fenced code block markers
      .replace(/`{3}/g, "")
      .trim()
      .slice(0, maxLen);
    return str.length > 0 ? str : null;
  } catch {
    return null;
  }
}
