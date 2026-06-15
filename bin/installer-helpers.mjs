/**
 * bin/installer-helpers.mjs
 *
 * Pure helper functions for the ForgeDock stub-based installer.
 *
 * Extracted from bin/forgedock.mjs so they can be unit-tested independently.
 * All functions are pure (no I/O) and depend only on their arguments.
 *
 * Exports:
 *   STUB_MARKER          — the sentinel string embedded in every stub file
 *   parseFrontmatter     — extract description + argument-hint from markdown frontmatter
 *   generateStubContent  — build the content of a stub file
 *   isForgeStub          — detect whether a file was written by ForgeDock
 */

/**
 * Marker string embedded in every stub file written to ~/.claude/commands/.
 * Presence of this string is the ONLY signal used to identify ForgeDock-managed
 * stub files — it must be unique enough that user-authored command files will
 * never contain it incidentally.
 */
export const STUB_MARKER = "<!-- FORGEDOCK:STUB -->";

/**
 * Parse YAML frontmatter from a markdown file's content string.
 *
 * Extracts only the fields ForgeDock needs for stubs:
 *   - `description` — one-line command description shown to Claude
 *   - `argument-hint` — optional argument format hint
 *
 * Handles the standard `---\nkey: value\n---` frontmatter block.
 * Returns empty strings for any field not found — stub generation is
 * best-effort; a stub with no description still works.
 *
 * @param {string} content - Raw markdown file content.
 * @returns {{ description: string, argumentHint: string }}
 */
export function parseFrontmatter(content) {
  // Strip UTF-8 BOM if present — Node.js readFileSync('utf-8') does not strip it,
  // and startsWith("---") returns false on BOM-prefixed files, causing silent fallback.
  const stripped = content.replace(/^\uFEFF/, "");

  // Frontmatter must start at the very beginning of the file
  if (!stripped.startsWith("---")) {
    return { description: "", argumentHint: "" };
  }

  // Find the closing ---
  const closingIdx = stripped.indexOf("\n---", 3);
  if (closingIdx === -1) {
    return { description: "", argumentHint: "" };
  }

  const block = stripped.slice(3, closingIdx); // between the two ---

  let description = "";
  let argumentHint = "";

  for (const line of block.split("\n")) {
    // Match `key: value` — value may be quoted or unquoted
    const m = line.match(/^([\w-]+):\s*(.+)$/);
    if (!m) continue;

    const key = m[1].toLowerCase();
    // Strip surrounding quotes if present (single or double)
    const val = m[2].trim().replace(/^["']|["']$/g, "");

    if (key === "description") description = val;
    else if (key === "argument-hint") argumentHint = val;
  }

  return { description, argumentHint };
}

/**
 * Generate the content of a stub file for a given command spec.
 *
 * The stub is a minimal markdown file that:
 *   1. Carries the same frontmatter Claude Code reads for slash-command
 *      metadata (description, argument-hint).
 *   2. Contains a single body instruction telling Claude to read the full
 *      spec from its canonical FORGE_HOME path when the command is invoked.
 *   3. Embeds the STUB_MARKER so the installer can recognize and manage it.
 *
 * @param {string} rel       - Relative path from COMMANDS_DIR (e.g. "work-on.md").
 * @param {string} fullPath  - Absolute path to the full spec file in FORGE_HOME.
 * @param {string} description   - Command description (from frontmatter).
 * @param {string} argumentHint  - Argument hint string (from frontmatter, may be empty).
 * @returns {string} Stub file content.
 */
export function generateStubContent(rel, fullPath, description, argumentHint) {
  const argHintLine = argumentHint
    ? `argument-hint: ${argumentHint}\n`
    : "";

  // Use forward slashes in the displayed path for readability on all platforms
  const displayPath = fullPath.replace(/\\/g, "/");

  return `---
description: ${description || rel}
${argHintLine}---
${STUB_MARKER}

When this command is invoked, read the full spec using the Read tool:
**Spec path**: \`${displayPath}\`

Then follow all instructions in that file exactly.
`;
}

/**
 * Return true if the given file content was written by ForgeDock as a stub.
 *
 * Uses the STUB_MARKER as the sole detection signal — this is more robust
 * than checking file type (which would break on Windows where symlinks are
 * unavailable) and more precise than checking the file path pattern.
 *
 * @param {string} content - File content to check.
 * @returns {boolean}
 */
export function isForgeStub(content) {
  return content.includes(STUB_MARKER);
}
