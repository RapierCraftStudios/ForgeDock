#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join, relative, resolve } from "path";
import { mkdir, symlink, readlink, lstat, readdir, stat, unlink } from "fs/promises";
import {
  existsSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "fs";
import { execSync, execFileSync } from "child_process";
import { homedir } from "os";
import {
  renderLogo,
  runSteps,
  box,
  table,
  bold,
  dim,
  green,
  red,
  yellow,
  cyan,
  RESET,
  BOLD,
  GREEN,
  RED,
  YELLOW,
  CYAN,
} from "./tui.mjs";
import { buildMinimalForgeYaml } from "./init-detect.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FORGE_HOME = dirname(__dirname);
const COMMANDS_DIR = join(FORGE_HOME, "commands");

// Resolve home directory cross-platform: HOME on Unix, USERPROFILE on Windows.
// os.homedir() handles all supported platforms without a hard exit — see #744.
const HOME = homedir();

const TARGET_DIR = join(HOME, ".claude", "commands");
const SCRIPTS_DIR = join(FORGE_HOME, "scripts");
const SCRIPTS_TARGET_DIR = join(HOME, ".claude", "scripts");

/**
 * Allowlist of pipeline-agent scripts that get installed to ~/.claude/scripts/.
 * Only these files are symlinked (or copied on Windows) during install/update.
 *
 * Internal tooling (gen-logo.mjs, verify-*.sh) lives in scripts/ but is NOT
 * installed — those scripts are invoked directly via $FORGE_HOME/scripts/ by
 * review-pr.md and quality-gate.md and should not pollute the user's Claude
 * scripts namespace.
 *
 * When adding a new pipeline-agent script, add its filename here.
 */
const PIPELINE_SCRIPTS = new Set([
  "classify-lane.sh",
  "transition-label.sh",
  "validate-pr-target.sh",
]);

const args = process.argv.slice(2);
const command = args[0] || "install";

// ---------------------------------------------------------------------------
// SessionStart hook — settings.json helpers
// ---------------------------------------------------------------------------

/**
 * Path to the user-level Claude Code settings file.
 * This is where the SessionStart hook entry is written/removed.
 */
const CLAUDE_SETTINGS_PATH = join(HOME, ".claude", "settings.json");

/**
 * Timeout (in seconds) for the SessionStart hook entry written into
 * ~/.claude/settings.json. Claude Code hook timeouts are in seconds —
 * not milliseconds like the Node.js child_process timeouts elsewhere in
 * this file.
 */
const SESSION_START_HOOK_TIMEOUT_SECONDS = 10;

/**
 * Escape all shell metacharacters that receive special treatment inside
 * POSIX double-quoted strings.  Apply this to any filesystem path before
 * embedding it in a double-quoted shell assignment or command argument.
 *
 * Characters escaped and why:
 *   "  → \"   (closes the double-quoted context — ref: forge#451)
 *   $  → \$   (variable expansion and $(...) command substitution — ref: forge#792)
 *   `  → \`   (legacy backtick command substitution — ref: forge#792)
 *   !  → \!   (bash history expansion — harmless in sh but risky in bash — ref: forge#792)
 *
 * Backslash (\) is intentionally NOT escaped here: path.join() backslashes
 * must be converted to forward slashes by the caller before this function
 * is applied (see sessionStartHookCommand below).  On POSIX systems,
 * paths never contain backslashes, so this is a no-op for shell profiles.
 *
 * <!-- Added: forge#808 -->
 *
 * @param {string} path - Filesystem path to escape for shell double-quote context.
 * @returns {string} - Path safe for embedding inside a double-quoted shell string.
 */
function shellEscapeDoubleQuotedPath(path) {
  return path
    .replace(/\\/g, '\\\\') // backslash — must be first to avoid double-escaping
    .replace(/"/g, '\\"')   // double quote — breaks out of the argument
    .replace(/\$/g, '\\$')  // dollar sign — variable/command substitution
    .replace(/`/g, '\\`')   // backtick — legacy command substitution
    .replace(/!/g, '\\!');  // exclamation mark — bash history expansion
}

/**
 * The command value written into the SessionStart hook entry.
 * Uses forward slashes even on Windows — Node accepts them natively and
 * they avoid any backslash-related issues in the hook command string.
 * Backslashes emitted by path.join() on Windows are normalised to forward
 * slashes on line 101 before any escaping is applied.
 *
 * When Claude Code's hook runner passes the command string through a POSIX
 * shell (sh -c), the following characters receive special treatment inside
 * double-quoted strings and must be escaped — see shellEscapeDoubleQuotedPath().
 *
 * `node --` is used to terminate Node.js option parsing so that a path
 * component beginning with `-` cannot be misinterpreted as a CLI flag.
 *
 * @returns {string}
 */
function sessionStartHookCommand() {
  const hookPath = join(
    FORGE_HOME,
    "bin",
    "hooks",
    "session-start.mjs",
  ).replace(/\\/g, "/");
  const safePath = shellEscapeDoubleQuotedPath(hookPath);
  return `node -- "${safePath}"`;
}

/**
 * Check whether a hook command string refers to the ForgeDock SessionStart hook.
 *
 * Uses a platform-safe RegExp that matches both POSIX forward-slash paths
 * (Linux/macOS) and Windows backslash paths, so uninstall can locate and
 * remove the hook even when FORGE_HOME was different at install time.
 *
 * @param {string} command - The command string from a hook entry.
 * @returns {boolean}
 */
function isForgeSessionStartHook(command) {
  // Match: ...bin[/\]hooks[/\]session-start.mjs (quote-terminated or EOL)
  return /[/\\]bin[/\\]hooks[/\\]session-start\.mjs["']?\s*$/.test(command);
}

/**
 * Strip JSONC syntax (single-line comments, block comments, trailing commas)
 * from a raw JSON string, returning a plain JSON string that JSON.parse() accepts.
 *
 * Handles settings.json files that Claude Code's own editor may annotate
 * with comments and trailing commas.
 *
 * @param {string} raw - Raw text of a JSONC file.
 * @returns {string} - Valid JSON string.
 */
function stripJsonc(raw) {
  let result = "";
  let i = 0;
  const len = raw.length;

  while (i < len) {
    const ch = raw[i];

    // Inside a string literal — copy until unescaped closing quote
    if (ch === '"') {
      result += ch;
      i++;
      while (i < len) {
        const sc = raw[i];
        result += sc;
        if (sc === "\\" && i + 1 < len) {
          i++;
          result += raw[i];
        } else if (sc === '"') {
          break;
        }
        i++;
      }
      i++;
      continue;
    }

    // Single-line comment — skip until newline
    if (ch === "/" && i + 1 < len && raw[i + 1] === "/") {
      while (i < len && raw[i] !== "\n") i++;
      continue;
    }

    // Block comment — skip until */
    if (ch === "/" && i + 1 < len && raw[i + 1] === "*") {
      i += 2;
      while (i + 1 < len && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      if (i + 1 < len) i += 2; // only advance past */ if terminator was found
      continue;
    }

    // Trailing comma — skip if next structural char (past whitespace and
    // comments) is } or ].
    // This must run OUTSIDE the string-literal branch above so string content
    // containing ",}" or ",]" is never touched.
    // The lookahead skips whitespace AND inline comments so that patterns like
    //   `value, /* note */ }` or `value, // note\n}` are handled correctly.
    if (ch === ",") {
      let j = i + 1;
      // Advance j past whitespace and comments
      let advanced = true;
      while (advanced && j < len) {
        advanced = false;
        // Skip whitespace
        while (
          j < len &&
          (raw[j] === " " ||
            raw[j] === "\t" ||
            raw[j] === "\r" ||
            raw[j] === "\n")
        ) {
          j++;
          advanced = true;
        }
        // Skip single-line comment
        if (j + 1 < len && raw[j] === "/" && raw[j + 1] === "/") {
          while (j < len && raw[j] !== "\n") j++;
          advanced = true;
        }
        // Skip block comment
        if (j + 1 < len && raw[j] === "/" && raw[j + 1] === "*") {
          j += 2;
          while (j + 1 < len && !(raw[j] === "*" && raw[j + 1] === "/")) j++;
          if (j + 1 < len) j += 2; // only advance past */ if terminator was found
          advanced = true;
        }
      }
      if (j < len && (raw[j] === "}" || raw[j] === "]")) {
        i++;
        continue; // skip trailing comma
      }
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * Read ~/.claude/settings.json, returning a parsed object.
 * Returns an empty object if the file does not exist.
 * Tolerates JSONC syntax (comments, trailing commas) that Claude Code's
 * own settings editor may insert.
 * Throws if the file exists but cannot be parsed even after JSONC stripping.
 *
 * @returns {object}
 */
function readClaudeSettings() {
  try {
    const raw = readFileSync(CLAUDE_SETTINGS_PATH, "utf-8");
    return JSON.parse(stripJsonc(raw));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Atomically write an object to ~/.claude/settings.json.
 * Uses a .tmp sibling + renameSync to avoid partial writes.
 * Cleans up the tmp file on failure. (ref: forge#444)
 *
 * @param {object} settings
 */
function writeClaudeSettings(settings) {
  const tmpPath = CLAUDE_SETTINGS_PATH + ".forgedock.tmp";
  try {
    writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, CLAUDE_SETTINGS_PATH);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* already gone or never created */
    }
    throw err;
  }
}

/**
 * Atomically write text content to a file.
 * Uses a .forgedock.tmp sibling + renameSync to avoid partial writes on
 * crash or SIGINT. Cleans up the tmp file on failure. (ref: forge#813)
 *
 * @param {string} filePath - Absolute path to write
 * @param {string} content  - UTF-8 string content
 */
function atomicWriteFile(filePath, content) {
  const tmpPath = filePath + ".forgedock.tmp";
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* already gone or never created */
    }
    throw err;
  }
}

/**
 * Idempotently write a `.symlink-source` sentinel file to TARGET_DIR
 * (~/.claude/commands/) so other installers can detect that ForgeDock
 * owns this namespace.
 *
 * The sentinel is a plain UTF-8 text file (not a symlink) containing
 * the source path, a reinstall hint, and the install timestamp.  It is
 * updated on every install so the timestamp stays fresh.  Write failures
 * are non-fatal — the function returns 'failed' and the caller logs a
 * warning; install continues regardless.
 *
 * Calling convention matches the other state-write helpers:
 *   'written'  — sentinel was newly created or refreshed
 *   'failed'   — an error occurred (non-fatal; install continues)
 *
 * <!-- Added: forge#1038 -->
 *
 * @returns {'written' | 'failed'}
 */
function writeSymlinkSentinel() {
  const sentinelPath = join(TARGET_DIR, ".symlink-source");
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const content =
    `# ForgeDock command symlinks — DO NOT REPOINT\n` +
    `# Source: ${COMMANDS_DIR}\n` +
    // Machine-readable version line — read by install() on the next run to
    // detect first-time vs. update installs and render a version diff (#1146).
    `# Version: ${getVersion()}\n` +
    `#\n` +
    `# These symlinks are managed by ForgeDock (https://forgedock.com).\n` +
    `# ForgeDock owns the global ~/.claude/commands/ namespace.\n` +
    `# Project-specific commands should install to the project's\n` +
    `# .claude/commands/ directory instead (Claude Code merges both;\n` +
    `# project-local commands win on name collisions).\n` +
    `#\n` +
    `# Running another installer here will silently repoint these\n` +
    `# symlinks, breaking all ForgeDock commands globally.\n` +
    `#\n` +
    `# To reinstall ForgeDock: npx forgedock install\n` +
    `# Last installed: ${timestamp}\n`;
  try {
    atomicWriteFile(sentinelPath, content);
    return "written";
  } catch {
    return "failed";
  }
}

/**
 * Install the ForgeDock SessionStart hook into ~/.claude/settings.json
 * idempotently. Does not modify any existing hooks unrelated to ForgeDock.
 *
 * Returns:
 *   'installed'       — hook was newly added
 *   'already-present' — hook was already there (idempotent)
 *   'failed'          — an error occurred (non-fatal; install continues)
 *
 * @returns {Promise<'installed' | 'already-present' | 'failed'>}
 */
async function installSessionStartHook() {
  try {
    const settings = readClaudeSettings();

    // Ensure the hooks section exists
    if (!settings.hooks || typeof settings.hooks !== "object") {
      settings.hooks = {};
    }

    // Ensure SessionStart array exists
    if (!Array.isArray(settings.hooks.SessionStart)) {
      settings.hooks.SessionStart = [];
    }

    const cmd = sessionStartHookCommand();

    // Check if already present — match by path suffix so uninstall/reinstall
    // across different FORGE_HOME paths still works correctly. (ref: forge#537)
    const alreadyPresent = settings.hooks.SessionStart.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
      return hooks.some(
        (h) =>
          h &&
          typeof h.command === "string" &&
          isForgeSessionStartHook(h.command),
      );
    });

    if (alreadyPresent) return "already-present";

    // Append the new hook entry (matcher omitted — fires on every session start)
    settings.hooks.SessionStart.push({
      hooks: [
        {
          type: "command",
          command: cmd,
          timeout: SESSION_START_HOOK_TIMEOUT_SECONDS,
        },
      ],
    });

    writeClaudeSettings(settings);
    return "installed";
  } catch {
    return "failed";
  }
}

/**
 * Remove the ForgeDock SessionStart hook from ~/.claude/settings.json
 * idempotently. Only removes the entry written by installSessionStartHook().
 * Unrelated hooks are preserved.
 *
 * Returns:
 *   'removed'     — hook was found and removed
 *   'not-present' — hook was not in settings.json (already clean)
 *   'failed'      — an error occurred (non-fatal; uninstall continues)
 *
 * @returns {Promise<'removed' | 'not-present' | 'failed'>}
 */
async function removeSessionStartHook() {
  try {
    const settings = readClaudeSettings();

    if (
      !settings.hooks ||
      !Array.isArray(settings.hooks.SessionStart) ||
      settings.hooks.SessionStart.length === 0
    ) {
      return "not-present";
    }

    const originalLength = settings.hooks.SessionStart.length;

    // Filter out the ForgeDock-managed entry, keep everything else
    settings.hooks.SessionStart = settings.hooks.SessionStart.filter(
      (entry) => {
        if (!entry || typeof entry !== "object") return true;
        const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
        const isForgeEntry = hooks.some(
          (h) =>
            h &&
            typeof h.command === "string" &&
            isForgeSessionStartHook(h.command),
        );
        return !isForgeEntry;
      },
    );

    if (settings.hooks.SessionStart.length === originalLength) {
      return "not-present";
    }

    // Clean up empty SessionStart array to leave settings.json tidy
    if (settings.hooks.SessionStart.length === 0) {
      delete settings.hooks.SessionStart;
    }

    // Clean up empty hooks object
    if (
      settings.hooks &&
      typeof settings.hooks === "object" &&
      Object.keys(settings.hooks).length === 0
    ) {
      delete settings.hooks;
    }

    writeClaudeSettings(settings);
    return "removed";
  } catch {
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Version + splash — read package.json version and render branded logo
// ---------------------------------------------------------------------------

function getVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(join(FORGE_HOME, "package.json"), "utf-8"),
    );
    return pkg.version || "";
  } catch {
    return "";
  }
}

function splash() {
  const version = getVersion();
  process.stderr.write(renderLogo({ version }) + "\n");
}

// ---------------------------------------------------------------------------
// CLAUDE.md / AGENTS.md managed-block injection
// ---------------------------------------------------------------------------

/**
 * Marker strings that delimit the ForgeDock-managed block in CLAUDE.md / AGENTS.md.
 * Must be exact — used for both detection and regex anchoring.
 */
const CLAUDE_BLOCK_BEGIN = "<!-- BEGIN FORGEDOCK -->";
const CLAUDE_BLOCK_END = "<!-- END FORGEDOCK -->";

/**
 * The behavioral rules block injected into the project's CLAUDE.md.
 * Kept ≤30 lines (per issue #607 requirement).
 * Content is fixed — this is NOT documentation, it is behavioral guidance.
 */
const FORGEDOCK_MANAGED_BLOCK = `${CLAUDE_BLOCK_BEGIN}
## ForgeDock Pipeline Rules

This project uses ForgeDock for structured development. Follow these rules:

1. **Issue-first**: When the user describes a bug, feature, or task conversationally — create a GitHub issue with \`/issue\` before writing any code. Never inline-fix without an issue number.
2. **Pipeline flow**: All implementation goes through \`/work-on <issue#>\`. This runs: investigate → architect → build → review → merge.
3. **Traceability**: Every code change must link to a GitHub issue. Use FORGE annotations to pass context between pipeline phases.
4. **Findings become issues**: When you discover bugs, inconsistencies, or improvements during other work — create a GitHub issue (\`gh issue create\`), don't fix inline.
5. **Available commands**: \`/work-on\`, \`/issue\`, \`/review-pr\`, \`/orchestrate\`, \`/quality-gate\`, \`/milestone\`, \`/autopilot\`

For full documentation, see: [ForgeDock docs](https://forgedock.com/docs)
${CLAUDE_BLOCK_END}`;

/**
 * Returns true if `dir` is inside a git work tree.
 * Used to guard CLAUDE.md injection against non-project directories.
 *
 * @param {string} dir
 * @returns {boolean}
 */
function isGitWorkTree(dir) {
  try {
    const out = execSync("git rev-parse --is-inside-work-tree", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Idempotently inject the ForgeDock managed block into a single file.
 *
 * Handles all corrupt marker states (ref: forge#269, forge#291):
 *   - File missing            → create file containing block only
 *   - No markers              → append block to existing content
 *   - BEGIN + END (correct)   → replace content between markers
 *   - BEGIN only              → strip orphaned BEGIN, re-append full block
 *   - END only                → strip orphaned END, re-append full block
 *   - END before BEGIN        → strip both + content between, re-append full block
 *   - Block already current   → return 'unchanged'
 *
 * Returns:
 *   'created'   — file was created with block
 *   'updated'   — existing block was replaced with new content
 *   'unchanged' — block was already present and current
 *   'appended'  — block was appended (no prior markers)
 *
 * @param {string} filePath - Absolute path to CLAUDE.md or AGENTS.md
 * @returns {'created' | 'updated' | 'unchanged' | 'appended'}
 */
function injectManagedBlock(filePath) {
  const managed = FORGEDOCK_MANAGED_BLOCK;

  // File does not exist — create it with the block
  if (!existsSync(filePath)) {
    atomicWriteFile(filePath, managed + "\n");
    return "created";
  }

  let existing = readFileSync(filePath, "utf-8");

  const hasBegin = existing.includes(CLAUDE_BLOCK_BEGIN);
  const hasEnd = existing.includes(CLAUDE_BLOCK_END);

  if (hasBegin && hasEnd) {
    // Determine marker order
    const beginIdx = existing.indexOf(CLAUDE_BLOCK_BEGIN);
    const endIdx = existing.indexOf(CLAUDE_BLOCK_END);

    if (beginIdx < endIdx) {
      // Normal order — replace content between markers (inclusive)
      // Non-greedy match so we don't over-consume if someone manually
      // duplicated the markers.
      const blockRegex = new RegExp(
        escapeRegExp(CLAUDE_BLOCK_BEGIN) +
          "[\\s\\S]*?" +
          escapeRegExp(CLAUDE_BLOCK_END),
      );
      if (!blockRegex.test(existing)) {
        // Should not happen: both markers were confirmed above via includes() and
        // indexOf() ordering. Guard against silent misclassification — if the regex
        // somehow fails to match, replaced === existing would incorrectly return
        // 'unchanged' instead of surfacing the broken state.
        throw new Error(
          `injectManagedBlock: regex failed to match markers in ${filePath}`,
        );
      }
      const replaced = existing.replace(blockRegex, managed);
      if (replaced === existing) {
        // Content between markers was already identical to the managed block
        return "unchanged";
      }
      atomicWriteFile(filePath, replaced);
      return "updated";
    } else {
      // Reversed markers (END before BEGIN) — strip both markers + everything
      // between them, then fall through to append. (ref: forge#291 BUG-2)
      const strippedReversed = existing
        .replace(
          new RegExp(
            escapeRegExp(CLAUDE_BLOCK_END) +
              "[\\s\\S]*?" +
              escapeRegExp(CLAUDE_BLOCK_BEGIN),
          ),
          "",
        )
        // Strip any leftover isolated markers
        .replace(new RegExp(escapeRegExp(CLAUDE_BLOCK_BEGIN), "g"), "")
        .replace(new RegExp(escapeRegExp(CLAUDE_BLOCK_END), "g"), "");
      existing = strippedReversed.trimEnd();
      // Fall through to append
    }
  } else if (hasBegin) {
    // Orphaned BEGIN — strip it, then fall through to append. (ref: forge#269)
    existing = existing
      .replace(new RegExp(escapeRegExp(CLAUDE_BLOCK_BEGIN), "g"), "")
      .trimEnd();
    // Fall through to append
  } else if (hasEnd) {
    // Orphaned END — strip it, then fall through to append. (ref: forge#291 BUG-1)
    existing = existing
      .replace(new RegExp(escapeRegExp(CLAUDE_BLOCK_END), "g"), "")
      .trimEnd();
    // Fall through to append
  }

  // No valid block present — append
  const separator = existing.length > 0 ? "\n\n" : "";
  atomicWriteFile(filePath, existing + separator + managed + "\n");
  return hasBegin || hasEnd ? "updated" : "appended";
}

/**
 * Remove the ForgeDock managed block from a single file.
 * Strips only the marker-bounded section; all surrounding content is preserved.
 * No-ops if the file doesn't exist or contains no markers.
 *
 * Returns:
 *   'removed'     — block was found and removed
 *   'not-present' — no block in file (or file doesn't exist)
 *
 * @param {string} filePath - Absolute path to CLAUDE.md or AGENTS.md
 * @returns {'removed' | 'not-present'}
 */
function removeManagedBlock(filePath) {
  if (!existsSync(filePath)) return "not-present";

  const existing = readFileSync(filePath, "utf-8");
  const hasBegin = existing.includes(CLAUDE_BLOCK_BEGIN);
  const hasEnd = existing.includes(CLAUDE_BLOCK_END);

  if (!hasBegin && !hasEnd) return "not-present";

  let cleaned = existing;

  if (hasBegin && hasEnd) {
    const beginIdx = existing.indexOf(CLAUDE_BLOCK_BEGIN);
    const endIdx = existing.indexOf(CLAUDE_BLOCK_END);

    if (beginIdx < endIdx) {
      // Normal block — remove it
      cleaned = existing
        .replace(
          new RegExp(
            escapeRegExp(CLAUDE_BLOCK_BEGIN) +
              "[\\s\\S]*?" +
              escapeRegExp(CLAUDE_BLOCK_END),
          ),
          "",
        )
        .trimEnd();
    } else {
      // Reversed — strip both and content between
      cleaned = existing
        .replace(
          new RegExp(
            escapeRegExp(CLAUDE_BLOCK_END) +
              "[\\s\\S]*?" +
              escapeRegExp(CLAUDE_BLOCK_BEGIN),
          ),
          "",
        )
        .replace(new RegExp(escapeRegExp(CLAUDE_BLOCK_BEGIN), "g"), "")
        .replace(new RegExp(escapeRegExp(CLAUDE_BLOCK_END), "g"), "")
        .trimEnd();
    }
  } else {
    // Orphaned markers — strip them
    cleaned = cleaned
      .replace(new RegExp(escapeRegExp(CLAUDE_BLOCK_BEGIN), "g"), "")
      .replace(new RegExp(escapeRegExp(CLAUDE_BLOCK_END), "g"), "")
      .trimEnd();
  }

  if (cleaned === existing.trimEnd()) return "not-present";

  atomicWriteFile(filePath, cleaned.length > 0 ? cleaned + "\n" : "");
  return "removed";
}

/**
 * Escape a string for use inside a RegExp constructor.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findMarkdownFiles(dir) {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findMarkdownFiles(full)));
    } else if (entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Shell profile FORGE_HOME removal
// ---------------------------------------------------------------------------

/**
 * The sentinel comment line written by install() immediately before the
 * `export FORGE_HOME=` line. This is the reliable anchor for removal —
 * it is never present in organic shell profiles.
 */
const FORGE_HOME_COMMENT = "# ForgeDock — autonomous development pipeline";

/**
 * Remove the ForgeDock FORGE_HOME block from a single shell profile file.
 *
 * install() appends exactly this 2-line block (preceded by a blank line):
 *
 *   # ForgeDock — autonomous development pipeline
 *   export FORGE_HOME="<path>"
 *
 * This function strips that block (and any orphaned `export FORGE_HOME=...`
 * lines immediately following the comment, or any standalone
 * `export FORGE_HOME=...` lines that have no paired comment). All other
 * content is preserved.
 *
 * Uses an atomic write (tmp file + rename) to avoid partial writes.
 *
 * Returns:
 *   'removed'     — block was found and removed
 *   'not-present' — block not found in file (or file does not exist)
 *   'failed'      — write error (non-fatal; callers warn and continue)
 *
 * @param {string} profilePath - Absolute path to .bashrc or .zshrc
 * @returns {'removed' | 'not-present' | 'failed'}
 */
function removeForgeHomeFromProfile(profilePath) {
  if (!existsSync(profilePath)) return "not-present";

  let content;
  try {
    content = readFileSync(profilePath, "utf-8");
  } catch {
    return "failed";
  }

  if (!content.includes(FORGE_HOME_COMMENT) && !content.includes("export FORGE_HOME=")) {
    return "not-present";
  }

  // Step 1: Remove the 2-line ForgeDock block (comment + export), preceded
  // by an optional leading blank line that install() inserts.
  // The \r? handles profiles with CRLF line endings.
  // The value pattern (?:[^"\\]|\\.)*  matches a double-quoted shell string
  // that may contain backslash-escape sequences (e.g. \" or \\) written by
  // shellEscapeDoubleQuotedPath(). The simpler [^"]* would stop prematurely
  // at the escaped-quote character inside \", failing to match the full line.
  let cleaned = content.replace(
    /\r?\n[ \t]*# ForgeDock — autonomous development pipeline\r?\nexport FORGE_HOME="(?:[^"\\]|\\.)*"\r?\n/g,
    "\n",
  );

  // Step 2: Remove any orphaned `export FORGE_HOME=...` lines that may
  // remain if the comment line was already manually deleted.
  cleaned = cleaned.replace(/^export FORGE_HOME=.*\r?\n/gm, "");

  // Step 3: Trim trailing blank lines introduced by the removal, but
  // preserve a single trailing newline if the original file had one.
  const hadTrailingNewline = content.endsWith("\n");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trimEnd();
  if (cleaned.length > 0 && hadTrailingNewline) {
    cleaned += "\n";
  }

  if (cleaned === content) return "not-present";

  const tmpPath = profilePath + ".forgedock.tmp";
  try {
    writeFileSync(tmpPath, cleaned, "utf-8");
    renameSync(tmpPath, profilePath);
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* already gone or never created */
    }
    return "failed";
  }

  return "removed";
}

/**
 * Link (symlink) all commands from COMMANDS_DIR to TARGET_DIR.
 * Called inside a runSteps() step — uses step.progress() and step.note().
 *
 * @param {object} step - StepAPI from runSteps
 * @returns {Promise<{installed: number, updated: number, skipped: number}>}
 */
async function linkCommands(step) {
  const files = await findMarkdownFiles(COMMANDS_DIR);
  const total = files.length;
  let installed = 0;
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rel = relative(COMMANDS_DIR, file);
    const target = join(TARGET_DIR, rel);
    const targetDir = dirname(target);

    await mkdir(targetDir, { recursive: true });
    step.progress(i + 1, total);

    try {
      const stats = await lstat(target);

      if (stats.isSymbolicLink()) {
        const current = await readlink(target);
        if (current === file) {
          skipped++;
        } else {
          // Symlink points to a different source — warn if it appears to belong
          // to another Forge/ForgeDock installation (i.e. not a broken link that
          // already pointed here under a different absolute path).
          // Only emit the warning once per install to avoid log spam.
          // <!-- Added: forge#1038 -->
          if (!current.startsWith(COMMANDS_DIR)) {
            step.note(
              yellow(`collision: ${rel} was → ${current} — repointing to ForgeDock`),
            );
          }
          try {
            await symlink(file, target + ".tmp");
            const { rename } = await import("fs/promises");
            await rename(target + ".tmp", target);
            updated++;
          } catch (renameErr) {
            try {
              await unlink(target + ".tmp");
            } catch {
              /* .tmp already gone or was never created */
            }
            if (renameErr.code === "EPERM" || renameErr.code === "EACCES") {
              // Windows without Developer Mode: symlink() throws EPERM/EACCES.
              // Fall back to a direct copy (matches new-install fallback behaviour).
              const { copyFile } = await import("fs/promises");
              await copyFile(file, target);
              updated++;
            } else {
              throw renameErr;
            }
          }
        }
      } else {
        // Regular file — skip; user must remove manually
        skipped++;
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // Doesn't exist — create symlink; fall back to copy on Windows EPERM/EACCES.
      try {
        await symlink(file, target);
      } catch (linkErr) {
        if (linkErr.code === "EPERM" || linkErr.code === "EACCES") {
          const { copyFile } = await import("fs/promises");
          await copyFile(file, target);
        } else {
          throw linkErr;
        }
      }
      installed++;
    }
  }

  return { installed, updated, skipped };
}

/**
 * Enumerate pipeline-agent scripts in SCRIPTS_DIR that should be installed
 * to ~/.claude/scripts/. Only files present in PIPELINE_SCRIPTS are returned.
 * Subdirectories are not traversed — scripts/ is a flat directory.
 *
 * @param {string} dir - Absolute path to the scripts source directory.
 * @returns {Promise<string[]>} Sorted list of absolute file paths.
 */
async function findScriptFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return results; // scripts/ dir absent — skip silently
    throw err;
  }
  for (const entry of entries) {
    if (entry.isFile() && PIPELINE_SCRIPTS.has(entry.name)) {
      results.push(join(dir, entry.name));
    }
  }
  return results.sort();
}

/**
 * Link or copy all scripts from SCRIPTS_DIR into SCRIPTS_TARGET_DIR (~/.claude/scripts/).
 * Mirrors linkCommands() behaviour: symlink where permitted, copy on EPERM/EACCES (Windows).
 * Called inside a runSteps() step — uses step.progress() and step.note().
 *
 * @param {object} step - StepAPI from runSteps
 * @returns {Promise<{installed: number, updated: number, skipped: number}>}
 */
async function linkScripts(step) {
  const files = await findScriptFiles(SCRIPTS_DIR);
  const total = files.length;

  if (total === 0) {
    step.skip("no scripts to link");
    return { installed: 0, updated: 0, skipped: 0 };
  }

  await mkdir(SCRIPTS_TARGET_DIR, { recursive: true });

  let installed = 0;
  let updated = 0;
  let skipped = 0;

  for (let idx = 0; idx < files.length; idx++) {
    const file = files[idx];
    const rel = relative(SCRIPTS_DIR, file);
    const target = join(SCRIPTS_TARGET_DIR, rel);

    step.progress(idx + 1, total);

    try {
      const stats = await lstat(target);

      if (stats.isSymbolicLink()) {
        const current = await readlink(target);
        if (current === file) {
          skipped++;
        } else {
          try {
            await symlink(file, target + ".tmp");
            const { rename } = await import("fs/promises");
            await rename(target + ".tmp", target);
            updated++;
          } catch (renameErr) {
            try {
              await unlink(target + ".tmp");
            } catch {
              /* .tmp already gone or was never created */
            }
            if (renameErr.code === "EPERM" || renameErr.code === "EACCES") {
              // Windows without Developer Mode: symlink() throws EPERM/EACCES.
              // Fall back to a direct copy (matches new-install fallback behaviour).
              const { copyFile } = await import("fs/promises");
              await copyFile(file, target);
              updated++;
            } else {
              throw renameErr;
            }
          }
        }
      } else {
        // Existing regular file — refresh if contents differ.
        if (readFileSync(file, "utf-8") === readFileSync(target, "utf-8")) {
          skipped++;
        } else {
          const { copyFile } = await import("fs/promises");
          await copyFile(file, target);
          updated++;
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // Doesn't exist — create symlink; fall back to copy on Windows EPERM/EACCES.
      try {
        await symlink(file, target);
      } catch (linkErr) {
        if (linkErr.code === "EPERM" || linkErr.code === "EACCES") {
          const { copyFile } = await import("fs/promises");
          await copyFile(file, target);
        } else {
          throw linkErr;
        }
      }
      installed++;
    }
  }

  return { installed, updated, skipped };
}

async function install() {
  // Detect first-time vs. update install by inspecting the namespace sentinel
  // BEFORE the install steps overwrite it. A missing sentinel means this is a
  // first install; a present one carries the previously installed version (if
  // it was written by a build that records `# Version:`). Reading is non-fatal:
  // any error is treated as a first install so guidance still renders. (#1146)
  const sentinelPath = join(TARGET_DIR, ".symlink-source");
  let priorSentinel = null;
  try {
    priorSentinel = readFileSync(sentinelPath, "utf-8");
  } catch {
    priorSentinel = null;
  }
  const isFirstInstall = priorSentinel === null;
  const priorVersion = priorSentinel
    ? priorSentinel.match(/^# Version:\s*(.+)$/m)?.[1]?.trim() || null
    : null;
  const currentVersion = getVersion();

  // Captured from the "Linking commands" step so the post-install summary can
  // report how many commands were installed/changed without recounting.
  let linkStats = { installed: 0, updated: 0, skipped: 0 };

  const result = await runSteps([
    {
      label: "Checking environment",
      async run(step) {
        // Worktree guard — refuse to install when FORGE_HOME is a git worktree.
        // In a worktree, FORGE_HOME/.git is a regular file (not a directory).
        // Installing from a worktree would bake an ephemeral path into the
        // symlinks and SessionStart hook; the path breaks when the worktree
        // is cleaned up, taking all Forge commands offline globally.
        // <!-- Added: forge#1037 -->
        const gitPath = join(FORGE_HOME, ".git");
        let gitStat = null;
        try {
          gitStat = await lstat(gitPath);
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
          // .git absent — npm install or detached checkout; not a worktree.
        }
        if (gitStat !== null && gitStat.isFile()) {
          throw new Error(
            `install() is running from a git worktree (${FORGE_HOME}).\n` +
            `  Installing from a worktree would repoint ~/.claude/commands/ symlinks\n` +
            `  to an ephemeral path that breaks when the worktree is deleted.\n` +
            `  Run \`npx forgedock install\` from the main repository clone instead.`,
          );
        }

        await mkdir(TARGET_DIR, { recursive: true });
        step.note(cyan(TARGET_DIR));
      },
    },
    {
      label: "Linking commands",
      async run(step) {
        const { installed, updated, skipped } = await linkCommands(step);
        const total = installed + updated + skipped;
        // Hoist for the post-install summary box (#1146).
        linkStats = { installed, updated, skipped };
        step.note(
          `${green(String(installed))} installed, ${updated} updated, ${dim(String(skipped))} skipped  (${total} commands total)`,
        );
      },
    },
    {
      label: "Writing namespace sentinel",
      async run(step) {
        // Write .symlink-source to ~/.claude/commands/ so other installers
        // can detect that ForgeDock owns this namespace. Non-fatal on failure.
        // <!-- Added: forge#1038 -->
        const result = writeSymlinkSentinel();
        if (result === "failed") {
          step.note("could not write .symlink-source — run npx forgedock install again to retry");
        } else {
          step.note(cyan(join(TARGET_DIR, ".symlink-source")));
        }
      },
    },
    {
      label: "Linking scripts",
      async run(step) {
        const { installed, updated, skipped } = await linkScripts(step);
        if (installed + updated + skipped > 0) {
          step.note(
            `${green(String(installed))} installed, ${updated} updated, ${dim(String(skipped))} skipped`,
          );
        }
      },
    },
    {
      label: "Configuring shell profile",
      async run(step) {
        // Set FORGE_HOME in shell profiles
        let profileUpdated = false;
        for (const profile of [
          join(HOME, ".bashrc"),
          join(HOME, ".zshrc"),
        ]) {
          if (existsSync(profile)) {
            const content = readFileSync(profile, "utf-8");
            // Escape shell metacharacters in FORGE_HOME before embedding it in
            // a double-quoted shell assignment.  A crafted install path
            // containing $(...), backticks, or " characters would otherwise
            // inject arbitrary shell commands executed on the user's next login.
            // shellEscapeDoubleQuotedPath() applies the same escaping used for
            // the SessionStart hook command (ref: forge#808, forge#792, forge#451).
            const safeForgeHome = shellEscapeDoubleQuotedPath(FORGE_HOME);
            const exactExport = `export FORGE_HOME="${safeForgeHome}"`;
            if (content.includes(exactExport)) {
              // Already set to the current path — no update needed.
            } else {
              // Either not present, or set to a stale path — refresh it.
              if (content.includes("FORGE_HOME")) {
                // Strip the old block before appending the updated one.
                const removeResult = removeForgeHomeFromProfile(profile);
                if (removeResult === "failed") {
                  // Removal failed — old export still present. Skip append to
                  // avoid writing a duplicate FORGE_HOME export. (ref: forge#846)
                  continue;
                }
              }
              appendFileSync(
                profile,
                `\n# ForgeDock — autonomous development pipeline\nexport FORGE_HOME="${safeForgeHome}"\n`,
              );
              profileUpdated = true;
            }
          }
        }
        if (!profileUpdated) {
          step.skip("FORGE_HOME already set");
        }
      },
    },
    {
      label: "Registering SessionStart hook",
      async run(step) {
        const hookResult = await installSessionStartHook();
        if (hookResult === "already-present") {
          step.skip("already present");
        } else if (hookResult === "failed") {
          // Non-fatal — warn but don't throw
          step.note("could not write — run npx forgedock install again to retry");
        }
      },
    },
    {
      label: "Generating forge.yaml",
      async run(step) {
        // Auto-generate forge.yaml if missing — no second command needed.
        // Only do this inside a real git project (ref: forge#585).
        const cwd = process.cwd();
        const forgeYamlPath = join(cwd, "forge.yaml");
        if (existsSync(forgeYamlPath)) {
          step.skip("forge.yaml already exists");
          return;
        }
        if (!isGitWorkTree(cwd)) {
          step.skip("not a git project — run npx forgedock init inside your project");
          return;
        }
        await init(true);
      },
    },
    {
      label: "Updating CLAUDE.md",
      async run(step) {
        // Inject behavioral rules into CLAUDE.md (and AGENTS.md if present).
        // Only inside a git project — guards against non-project cwd (ref: forge#585).
        const installCwd = process.cwd();
        if (!isGitWorkTree(installCwd)) {
          step.skip("not a git project");
          return;
        }

        const claudeMdPath = join(installCwd, "CLAUDE.md");
        const agentsMdPath = join(installCwd, "AGENTS.md");

        const claudeResult = injectManagedBlock(claudeMdPath);
        let note = "";
        if (claudeResult === "created") {
          note = "CLAUDE.md created";
        } else if (claudeResult === "updated") {
          note = "CLAUDE.md block refreshed";
        } else if (claudeResult === "appended") {
          note = "CLAUDE.md rules appended";
        } else {
          note = "CLAUDE.md already current";
        }

        // Mirror to AGENTS.md only if it already exists (never create it)
        if (existsSync(agentsMdPath)) {
          const agentsResult = injectManagedBlock(agentsMdPath);
          if (agentsResult === "updated" || agentsResult === "appended") {
            note += " · AGENTS.md mirrored";
          }
        }

        step.note(note);
      },
    },
  ]);

  if (result.ok) {
    const totalCommands =
      linkStats.installed + linkStats.updated + linkStats.skipped;
    const changedCommands = linkStats.installed + linkStats.updated;
    const versionLabel = currentVersion ? `v${currentVersion}` : "";

    if (isFirstInstall) {
      // First-time install — show the full guided next-steps box so the user
      // has a prioritized path from "installed" to "using it". (#1146)
      const cmd = (text) => cyan(text.padEnd(22));
      process.stderr.write(
        box(
          [
            `${green("✔")} ${bold(`ForgeDock ${versionLabel}`.trim())} installed`,
            `${green("✔")} ${totalCommands} commands → ${cyan(TARGET_DIR)}`,
            "",
            bold("What's next?"),
            "",
            dim("First time?"),
            `  ${cmd("npx forgedock demo")}${dim("Try the pipeline risk-free")}`,
            "",
            dim("Setting up your repo?"),
            `  ${cmd("npx forgedock init")}${dim("Configure forge.yaml")}`,
            `  ${cmd("npx forgedock doctor")}${dim("Verify your setup")}`,
            "",
            dim("Ready to go?"),
            `  ${cyan("/work-on #N".padEnd(22))}${dim("Run it in Claude Code")}`,
          ],
          { title: "ForgeDock Installed" },
        ) + "\n",
      );
    } else {
      // Update install — show a compact version diff and what changed, with a
      // changelog link instead of the full first-run guidance. (#1146)
      let headline;
      if (priorVersion && currentVersion && priorVersion !== currentVersion) {
        headline = `Updated from ${bold(`v${priorVersion}`)} → ${bold(`v${currentVersion}`)}.`;
      } else if (currentVersion && priorVersion === currentVersion) {
        headline = `Reinstalled ${bold(`v${currentVersion}`)}.`;
      } else if (currentVersion) {
        headline = `Updated to ${bold(`v${currentVersion}`)}.`;
      } else {
        headline = "Update complete.";
      }
      const changeNote =
        changedCommands > 0
          ? ` ${changedCommands} new/changed command${changedCommands === 1 ? "" : "s"}.`
          : " Commands already up to date.";
      process.stderr.write(
        box(
          [
            `${green("✔")} ${headline}${changeNote}`,
            "",
            `Changelog: ${cyan("https://github.com/RapierCraftStudios/ForgeDock/releases")}`,
            `Verify:    ${cyan("npx forgedock doctor")}`,
          ],
          { title: "ForgeDock Updated" },
        ) + "\n",
      );
    }
  }
}

async function uninstall() {
  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — Removing pipeline commands`);
  console.log("");

  const files = await findMarkdownFiles(COMMANDS_DIR);
  let removed = 0;

  for (const file of files) {
    const rel = relative(COMMANDS_DIR, file);
    const target = join(TARGET_DIR, rel);

    try {
      const stats = await lstat(target);
      if (stats.isSymbolicLink()) {
        const current = await readlink(target);
        if (current === file) {
          const { unlink } = await import("fs/promises");
          await unlink(target);
          console.log(`  ${RED}Removed${RESET}: ${rel}`);
          removed++;
        }
      } else if (
        readFileSync(file, "utf-8") === readFileSync(target, "utf-8")
      ) {
        // Regular file installed by ForgeDock in copy mode — content matches.
        const { unlink } = await import("fs/promises");
        await unlink(target);
        console.log(`  ${RED}Removed${RESET}: ${rel}`);
        removed++;
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // Doesn't exist — nothing to do
    }
  }

  console.log("");
  console.log(`Done. Removed: ${removed} commands.`);
  console.log("");

  // Remove scripts installed by ForgeDock from ~/.claude/scripts/
  const scriptFiles = await findScriptFiles(SCRIPTS_DIR);
  let scriptsRemoved = 0;

  for (const file of scriptFiles) {
    const rel = relative(SCRIPTS_DIR, file);
    const target = join(SCRIPTS_TARGET_DIR, rel);

    try {
      const stats = await lstat(target);
      const { unlink } = await import("fs/promises");
      if (stats.isSymbolicLink()) {
        const current = await readlink(target);
        if (current === file) {
          await unlink(target);
          console.log(`  ${RED}Removed${RESET}: scripts/${rel}`);
          scriptsRemoved++;
        }
      } else if (
        readFileSync(file, "utf-8") === readFileSync(target, "utf-8")
      ) {
        // Regular file installed by ForgeDock in copy mode — content matches.
        await unlink(target);
        console.log(`  ${RED}Removed${RESET}: scripts/${rel}`);
        scriptsRemoved++;
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // Doesn't exist — nothing to do
    }
  }

  if (scriptFiles.length > 0) {
    console.log("");
    console.log(`Done. Removed: ${scriptsRemoved} scripts.`);
    console.log("");
  }

  // Remove the SessionStart hook from ~/.claude/settings.json
  const hookRemoveResult = await removeSessionStartHook();
  if (hookRemoveResult === "removed") {
    console.log(
      `  ${GREEN}✔${RESET}  Removed SessionStart hook from ${CYAN}~/.claude/settings.json${RESET}`,
    );
  } else if (hookRemoveResult === "not-present") {
    console.log(
      `  ✔  SessionStart hook already absent from ~/.claude/settings.json`,
    );
  } else {
    console.log(
      `  ${YELLOW}⚠${RESET}  Could not update ~/.claude/settings.json — remove the hook manually.`,
    );
  }
  console.log("");

  // Remove ForgeDock managed block from CLAUDE.md and AGENTS.md (if present)
  const uninstallCwd = process.cwd();
  const claudeMdPath = join(uninstallCwd, "CLAUDE.md");
  const agentsMdPath = join(uninstallCwd, "AGENTS.md");

  const claudeRemoveResult = removeManagedBlock(claudeMdPath);
  if (claudeRemoveResult === "removed") {
    console.log(
      `  ${GREEN}✔${RESET}  Removed ForgeDock pipeline rules from ${CYAN}CLAUDE.md${RESET}`,
    );
  } else {
    console.log(`  ✔  No ForgeDock block in CLAUDE.md — nothing to remove`);
  }

  if (existsSync(agentsMdPath)) {
    const agentsRemoveResult = removeManagedBlock(agentsMdPath);
    if (agentsRemoveResult === "removed") {
      console.log(
        `  ${GREEN}✔${RESET}  Removed ForgeDock pipeline rules from ${CYAN}AGENTS.md${RESET}`,
      );
    } else {
      console.log(`  ✔  No ForgeDock block in AGENTS.md — nothing to remove`);
    }
  }
  console.log("");

  // Remove FORGE_HOME export from shell profiles (.bashrc, .zshrc)
  for (const profileName of [".bashrc", ".zshrc"]) {
    const profilePath = join(HOME, profileName);
    const profileResult = removeForgeHomeFromProfile(profilePath);
    if (profileResult === "removed") {
      console.log(
        `  ${GREEN}✔${RESET}  Removed FORGE_HOME export from ${CYAN}~/${profileName}${RESET}`,
      );
    } else if (profileResult === "not-present") {
      console.log(`  ✔  No FORGE_HOME entry in ~/${profileName} — nothing to remove`);
    } else {
      console.log(
        `  ${YELLOW}⚠${RESET}  Could not update ~/${profileName} — remove the FORGE_HOME export manually.`,
      );
    }
  }
  console.log("");

  // Remove .forgedock marker file from cwd (created by `npx forgedock enable`)
  const markerPath = join(uninstallCwd, ".forgedock");
  if (existsSync(markerPath)) {
    try {
      unlinkSync(markerPath);
      console.log(
        `  ${GREEN}✔${RESET}  Removed ${CYAN}.forgedock${RESET} marker from ${CYAN}${uninstallCwd}${RESET}`,
      );
    } catch {
      console.log(
        `  ${YELLOW}⚠${RESET}  Could not remove .forgedock marker — remove it manually: ${markerPath}`,
      );
    }
  } else {
    console.log(`  ✔  No .forgedock marker in current directory — nothing to remove`);
  }
  console.log("");

  // Clean up registry nudgeSeen entry for cwd (written by the session-start hook)
  try {
    const { clearNudgeSeen } = await import(
      pathToFileURL(join(FORGE_HOME, "bin", "registry.mjs")).href
    );
    await clearNudgeSeen(uninstallCwd);
    console.log(
      `  ${GREEN}✔${RESET}  Cleaned registry entries for ${CYAN}${uninstallCwd}${RESET}`,
    );
  } catch {
    // Non-fatal — registry is best-effort
    console.log(
      `  ${YELLOW}⚠${RESET}  Could not clean registry entries — safe to ignore.`,
    );
  }
  console.log("");

  console.log(`${GREEN}ForgeDock uninstalled.${RESET} No residue remains from this directory.`);
  console.log(`  Re-install at any time with: ${CYAN}npx forgedock${RESET}`);
  console.log("");
}

async function update() {
  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — Checking for updates`);
  console.log("");

  // Check if installed via npm (no .git directory) or via git clone
  const gitDir = join(FORGE_HOME, ".git");
  if (existsSync(gitDir)) {
    try {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: FORGE_HOME,
        encoding: "utf-8",
      }).trim();
      if (branch !== "main") {
        console.log(`  Not on main branch (${branch}) — skipping`);
        return;
      }

      const before = execSync("git rev-parse HEAD", {
        cwd: FORGE_HOME,
        encoding: "utf-8",
      }).trim();
      execSync("git fetch origin main --quiet", { cwd: FORGE_HOME });
      execSync("git merge --ff-only origin/main --quiet", {
        cwd: FORGE_HOME,
      });
      const after = execSync("git rev-parse HEAD", {
        cwd: FORGE_HOME,
        encoding: "utf-8",
      }).trim();

      if (before === after) {
        console.log(`  Already up to date.`);
      } else {
        console.log(`  ${GREEN}Updated to latest.${RESET}`);
        await install();
      }
    } catch (err) {
      console.log(
        `  ${YELLOW}Cannot fast-forward — local changes exist. Skipping.${RESET}`,
      );
    }
  } else {
    console.log(
      `  Installed via npm. Run ${CYAN}npm update -g forgedock${RESET} to update.`,
    );
  }
  console.log("");
}

async function init(fromInstall = false, minimal = false) {
  // When called from install() via runSteps(), suppress stdout to prevent
  // interleaving with the TUI spinner on stderr. runSteps() provides the
  // "Generating forge.yaml" step label as visual feedback. (#812)
  const log = fromInstall ? () => {} : console.log;
  log("");
  log(
    `${BOLD}ForgeDock${RESET} — Generating forge.yaml${minimal ? " (minimal)" : ""}`,
  );
  log("");

  const cwd = process.cwd();
  const worktreeBase = join(cwd, ".claude", "worktrees");
  const outputPath = join(cwd, "forge.yaml");

  // --- Detect git remote URL and parse owner/repo ---
  let owner = "your-github-org";
  let repo = "your-repo-name";
  let remoteDetected = false;

  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // SSH: git@github.com:owner/repo.git
    const sshMatch = remoteUrl.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
    // HTTPS: https://github.com/owner/repo.git
    const httpsMatch = remoteUrl.match(
      /^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/,
    );

    if (sshMatch) {
      owner = sshMatch[1];
      repo = sshMatch[2];
      remoteDetected = true;
    } else if (httpsMatch) {
      owner = httpsMatch[1];
      repo = httpsMatch[2];
      remoteDetected = true;
    } else {
      log(
        `  ${YELLOW}Warning${RESET}: Could not parse git remote URL — using placeholder values`,
      );
    }
  } catch {
    log(
      `  ${YELLOW}Warning${RESET}: No git remote found — using placeholder values`,
    );
  }

  if (remoteDetected) {
    log(`  Detected repo:   ${CYAN}${owner}/${repo}${RESET}`);
  }

  // --- Detect default branch ---
  let defaultBranch = "main";
  try {
    const headRef = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // refs/remotes/origin/main → main
    defaultBranch = headRef.replace(/^refs\/remotes\/origin\//, "");
    log(`  Default branch:  ${CYAN}${defaultBranch}${RESET}`);
  } catch {
    // Fallback: try git rev-parse
    try {
      defaultBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (defaultBranch === "HEAD") defaultBranch = "main";
      log(
        `  Default branch:  ${CYAN}${defaultBranch}${RESET} (from current branch)`,
      );
    } catch {
      log(
        `  ${YELLOW}Warning${RESET}: Could not detect default branch — defaulting to "main"`,
      );
    }
  }

  // --- Detect staging branch ---
  let stagingBranch = "staging";
  try {
    const remoteBranches = execSync("git branch -r", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (remoteBranches.includes("origin/staging")) {
      stagingBranch = "staging";
      log(`  Staging branch:  ${CYAN}staging${RESET} (detected)`);
    } else {
      stagingBranch = defaultBranch;
      log(
        `  Staging branch:  ${CYAN}${defaultBranch}${RESET} (no staging branch found — using default)`,
      );
    }
  } catch {
    log(
      `  ${YELLOW}Warning${RESET}: Could not read remote branches — defaulting staging to "${defaultBranch}"`,
    );
    stagingBranch = defaultBranch;
  }

  // --- Auto-detect project description from README.md ---
  let description = "";
  try {
    const readmePath = join(cwd, "README.md");
    if (existsSync(readmePath)) {
      const readmeContent = readFileSync(readmePath, "utf-8").slice(0, 2048);
      // Skip the first heading line (# Title), grab the first non-empty paragraph
      const lines = readmeContent.split("\n");
      let inFirstParagraph = false;
      const paragraphLines = [];
      for (const line of lines) {
        // Skip heading lines at the top
        if (!inFirstParagraph && line.match(/^#/)) continue;
        // Skip blank lines before paragraph starts
        if (!inFirstParagraph && line.trim() === "") continue;
        // Skip lines that are just badges, HTML, code fences, horizontal rules, or tables
        if (!inFirstParagraph && line.match(/^[!<\[`|]/)) continue;
        if (!inFirstParagraph && line.match(/^---/)) continue;
        // Start collecting
        if (!inFirstParagraph) {
          inFirstParagraph = true;
        }
        // Stop at blank line (end of paragraph)
        if (line.trim() === "") break;
        paragraphLines.push(line.trim());
      }
      if (paragraphLines.length > 0) {
        // Flatten to single line, strip markdown links/bold/inline code
        description = paragraphLines
          .join(" ")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/`([^`]+)`/g, "$1")
          .slice(0, 200)
          .trim();
      }
    }
  } catch {
    // Best-effort only — silently fall back to empty description
  }

  if (description) {
    log(
      `  Description:     ${CYAN}${description.slice(0, 60)}${description.length > 60 ? "…" : ""}${RESET} (from README.md)`,
    );
  }

  // --- Auto-detect project description from CLAUDE.md (fallback) ---
  if (!description) {
    try {
      const claudePath = join(cwd, "CLAUDE.md");
      if (existsSync(claudePath)) {
        const claudeContent = readFileSync(claudePath, "utf-8").slice(0, 2048);
        const lines = claudeContent.split("\n");
        let inFirstParagraph = false;
        const paragraphLines = [];
        for (const line of lines) {
          // Skip heading lines at the top
          if (!inFirstParagraph && line.match(/^#/)) continue;
          // Skip blank lines before paragraph starts
          if (!inFirstParagraph && line.trim() === "") continue;
          // Skip lines that are just badges, HTML comments, code fences, horizontal rules, or tables
          if (!inFirstParagraph && line.match(/^[!<\[`|]/)) continue;
          if (!inFirstParagraph && line.match(/^---/)) continue;
          // Start collecting
          if (!inFirstParagraph) {
            inFirstParagraph = true;
          }
          // Stop at blank line (end of paragraph)
          if (line.trim() === "") break;
          paragraphLines.push(line.trim());
        }
        if (paragraphLines.length > 0) {
          // Flatten to single line, strip markdown links/bold/inline code
          description = paragraphLines
            .join(" ")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .replace(/\*\*([^*]+)\*\*/g, "$1")
            .replace(/`([^`]+)`/g, "$1")
            .slice(0, 200)
            .trim();
        }
      }
    } catch {
      // Best-effort only — silently fall back to empty description
    }

    if (description) {
      log(
        `  Description:     ${CYAN}${description.slice(0, 60)}${description.length > 60 ? "…" : ""}${RESET} (from CLAUDE.md)`,
      );
    }
  }

  // --- Handle existing forge.yaml ---
  if (existsSync(outputPath)) {
    const baseBak = join(cwd, "forge.yaml.bak");
    const backupPath = existsSync(baseBak)
      ? join(
          cwd,
          `forge.yaml.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`,
        )
      : baseBak;
    const backupName = backupPath.split("/").pop();
    renameSync(outputPath, backupPath);
    log(`  ${YELLOW}Backed up${RESET}: forge.yaml → ${backupName}`);
  }

  // --- Generate forge.yaml content ---
  const projectName = repo
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  // Pre-escape values for embedding in YAML double-quoted strings.
  // Backslash must be escaped first to avoid double-escaping.
  const safeOwner = owner.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeRepo = repo.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeProjectName = projectName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeDefaultBranch = defaultBranch.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeStagingBranch = stagingBranch.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const fullContent = `# forge.yaml — ForgeDock Configuration
#
# Auto-generated by: npx forgedock init
# Edit this file with your project details.
#
# Required sections: project, paths, branches
# Optional sections: repos, project_board, services, review, verification
#
# See docs/CONFIG.md for full reference.

# =============================================================================
# PROJECT (REQUIRED)
# =============================================================================

project:
  name: "${safeProjectName}"
  owner: "${safeOwner}"
  repo: "${safeRepo}"
  description: "${description.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"

# =============================================================================
# PATHS (REQUIRED)
# =============================================================================

paths:
  root: "${cwd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
  worktree_base: "${worktreeBase.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"

# =============================================================================
# BRANCHES (REQUIRED)
# =============================================================================

branches:
  default: "${safeDefaultBranch}"
  staging: "${safeStagingBranch}"
  feature_pattern: "milestone/{slug}"

# =============================================================================
# REPOS (OPTIONAL)
# Multi-repo configuration. Remove the # to enable.
# =============================================================================

# repos:
#   default:
#     repo: "${safeOwner}/${safeRepo}"
#     staging_branch: "${safeStagingBranch}"
#   satellites:
#     - prefix: "mcp"
#       repo: "${safeOwner}/your-satellite-repo"
#       staging_branch: "main"
#       local_path: "${join(cwd, "..", "your-satellite-repo").replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"

# =============================================================================
# PROJECT BOARD (OPTIONAL)
# GitHub Projects v2 integration.
# To find IDs: gh project list --owner ${safeOwner}
# =============================================================================

# project_board:
#   owner: "${safeOwner}"
#   project_number: 1
#   project_id: "PVT_kwHOxxxxxxxxxxxxxxxx"
#   field_ids:
#     status: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
#     lane: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
#     component: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
#     priority: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
#     workflow: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"

# =============================================================================
# REVIEW (OPTIONAL)
# Context injected into review agent prompts.
# =============================================================================

# review:
#   tech_stack: "Node.js, TypeScript, PostgreSQL"
#   context: |
#     Describe your repo structure and any unusual conventions here.

# =============================================================================
# VERIFICATION (OPTIONAL)
# Health-check patterns for quality gate and validate commands.
# =============================================================================

# verification:
#   health_endpoint: "https://api.${safeRepo}.io/health"
#   health_patterns:
#     - '"status": "ok"'
#
#   # Integration test suites run by /test-gate against the provisioned cluster.
#   # Each entry specifies a logical cluster (matched to test_services), the shell
#   # command to execute, and the working directory (relative to project root).
#   # Used by: test-gate (Phase 3 Provision + Phase 4 Fan out)
#   #
#   # integration_tests:
#   #   - cluster: "api"
#   #     command: "pytest tests/integration/ -q --tb=short"
#   #     working_dir: "."
#
#   # Maps logical cluster names (from integration_tests) to running container
#   # names. /test-gate checks these containers are live before running tests.
#   # Omit entries for clusters that do not use Docker.
#   # Used by: test-gate (Phase 3 Provision)
#   #
#   # test_services:
#   #   api: "${safeRepo}-api-blue"
#   #   worker: "${safeRepo}-worker-blue"
#
#   # Controls /test-gate posture at the staging-to-main deploy boundary.
#   # posture: blocking (default) or advisory.
#   # override_phrase: exact comment text an operator posts to bypass a BLOCK.
#   # Used by: test-gate (Phase 7 Verdict), review-pr-staging (Phase 6.5)
#   #
#   # test_gate:
#   #   posture: "blocking"
#   #   override_phrase: "OVERRIDE: shipping with test failures \u2014"
`;

  // When --minimal is requested, emit only the three required sections
  // (project, paths, branches) — no commented optional blocks. The minimal
  // output still passes `forgedock doctor` and drives `/work-on`, while staying
  // ~20 lines instead of ~200. (#1148)
  const content = minimal
    ? buildMinimalForgeYaml({
        projectName,
        owner,
        repo,
        description,
        root: cwd,
        worktreeBase,
        defaultBranch,
        stagingBranch,
      })
    : fullContent;

  atomicWriteFile(outputPath, content);

  log(`  ${GREEN}Created${RESET}: forge.yaml${minimal ? " (minimal)" : ""}`);
  log("");

  if (fromInstall) {
    // Called automatically from install() — only print what still needs attention.
    // NOTE: log() is a no-op when fromInstall=true (stdout suppressed to avoid
    // interleaving with TUI spinner on stderr). If git remote was not detected,
    // the user will see the incomplete placeholder values in forge.yaml directly. (#812)
    if (!remoteDetected) {
      log(`${YELLOW}Action required:${RESET}`);
      log(
        `  Edit ${CYAN}forge.yaml${RESET} — fill in ${CYAN}project.owner${RESET} and ${CYAN}project.repo${RESET} (git remote not detected)`,
      );
      log("");
    }
  } else {
    // Called explicitly via `npx forgedock init` — print full next steps
    log(`${BOLD}Next steps:${RESET}`);
    if (!remoteDetected) {
      log(
        `  1. Edit ${CYAN}forge.yaml${RESET} — fill in ${CYAN}project.owner${RESET} and ${CYAN}project.repo${RESET}`,
      );
    } else {
      log(
        `  1. Review ${CYAN}forge.yaml${RESET} — all required fields were auto-detected`,
      );
    }
    log(
      `  2. Add ${CYAN}forge.yaml${RESET} to ${CYAN}.gitignore${RESET} if it contains sensitive paths`,
    );
    if (minimal) {
      log(
        `  3. Need more? Add optional sections from ${CYAN}forge.yaml.example${RESET} (see ${CYAN}docs/CONFIG.md${RESET})`,
      );
    } else {
      log(
        `  3. Run ${CYAN}/forgedock-init${RESET} inside Claude Code for guided AI-powered setup`,
      );
    }
    log("");
  }
}

/**
 * Mark a directory as ForgeDock-managed by removing it from the opt-out
 * registry and creating a .forgedock marker file.
 *
 * @param {string} [dir] - Directory to enable (default: process.cwd()).
 */
async function enable(dir) {
  const targetDir = resolve(dir || process.cwd());

  let setOptOut;
  try {
    ({ setOptOut } = await import(
      pathToFileURL(join(FORGE_HOME, "bin", "registry.mjs")).href
    ));
  } catch (err) {
    console.error(`${RED}Error: could not load registry module: ${err.message}${RESET}`);
    process.exit(1);
  }

  // Remove from opt-out registry
  try {
    await setOptOut(targetDir, false);
  } catch (err) {
    console.error(`${RED}Error updating registry: ${err.message}${RESET}`);
    process.exit(1);
  }

  // Create .forgedock marker file so the directory is treated as managed
  // even without a forge.yaml (user can run `npx forgedock init` next)
  const markerPath = join(targetDir, ".forgedock");
  if (!existsSync(markerPath)) {
    try {
      writeFileSync(markerPath, "", "utf-8");
      console.log(`  ${GREEN}Created${RESET}: .forgedock marker in ${targetDir}`);
    } catch (err) {
      console.log(`  ${YELLOW}Warning${RESET}: could not create .forgedock marker: ${err.message}`);
    }
  } else {
    console.log(`  ✔  .forgedock marker already present in ${targetDir}`);
  }

  console.log(`  ${GREEN}✔${RESET}  ForgeDock ${GREEN}enabled${RESET} in: ${CYAN}${targetDir}${RESET}`);
  console.log(`     Removed from opt-out registry. Run ${CYAN}npx forgedock init${RESET} to generate forge.yaml.`);
  console.log("");
}

/**
 * Opt a directory out of ForgeDock by adding it to the opt-out registry.
 * The session-start hook will be silent for this directory in future sessions.
 *
 * @param {string} [dir] - Directory to disable (default: process.cwd()).
 */
async function disable(dir) {
  const targetDir = resolve(dir || process.cwd());

  let setOptOut;
  try {
    ({ setOptOut } = await import(
      pathToFileURL(join(FORGE_HOME, "bin", "registry.mjs")).href
    ));
  } catch (err) {
    console.error(`${RED}Error: could not load registry module: ${err.message}${RESET}`);
    process.exit(1);
  }

  try {
    await setOptOut(targetDir, true);
  } catch (err) {
    console.error(`${RED}Error updating registry: ${err.message}${RESET}`);
    process.exit(1);
  }

  console.log(`  ${GREEN}✔${RESET}  ForgeDock ${YELLOW}disabled${RESET} in: ${CYAN}${targetDir}${RESET}`);
  console.log(`     Added to opt-out registry. The session-start hook will be silent here.`);
  console.log(`     To re-enable: ${CYAN}npx forgedock enable${RESET}`);
  console.log("");
}

/**
 * Show the resolved ForgeDock state for a directory.
 * Prints human-readable state (managed-active, managed-optedout, unmanaged)
 * with relevant detail about what markers or registry entries were found.
 *
 * @param {string} [dir] - Directory to inspect (default: process.cwd()).
 */
async function status(dir) {
  const targetDir = resolve(dir || process.cwd());

  let resolveState;
  try {
    ({ resolveState } = await import(
      pathToFileURL(join(FORGE_HOME, "bin", "registry.mjs")).href
    ));
  } catch (err) {
    console.error(`${RED}Error: could not load registry module: ${err.message}${RESET}`);
    process.exit(1);
  }

  let state;
  try {
    state = resolveState(targetDir);
  } catch (err) {
    console.error(`${RED}Error resolving state: ${err.message}${RESET}`);
    process.exit(1);
  }

  const hasForgeYaml = existsSync(join(targetDir, "forge.yaml"));
  const hasMarker = existsSync(join(targetDir, ".forgedock"));

  console.log("");
  console.log(`${BOLD}ForgeDock Status${RESET}`);
  console.log(`  Directory: ${CYAN}${targetDir}${RESET}`);
  console.log("");

  switch (state) {
    case "managed-active":
      console.log(`  State: ${GREEN}managed-active${RESET}`);
      console.log(`  ForgeDock is active in this directory.`);
      if (hasForgeYaml) console.log(`  ${GREEN}✔${RESET}  forge.yaml found`);
      if (hasMarker)    console.log(`  ${GREEN}✔${RESET}  .forgedock marker found`);
      console.log(`  The session-start hook will inject context on session start.`);
      console.log(`  To disable: ${CYAN}npx forgedock disable${RESET}`);
      break;

    case "managed-optedout":
      console.log(`  State: ${YELLOW}managed-optedout${RESET}`);
      console.log(`  ForgeDock is installed but opted out for this directory.`);
      if (hasForgeYaml) console.log(`  ${GREEN}✔${RESET}  forge.yaml found`);
      if (hasMarker)    console.log(`  ${GREEN}✔${RESET}  .forgedock marker found`);
      console.log(`  The session-start hook is silent here (opt-out registry entry present).`);
      console.log(`  To re-enable: ${CYAN}npx forgedock enable${RESET}`);
      break;

    case "unmanaged":
    default:
      console.log(`  State: ${RED}unmanaged${RESET}`);
      console.log(`  ForgeDock is not active in this directory.`);
      console.log(`  No forge.yaml or .forgedock marker found.`);
      console.log(`  To enable: ${CYAN}npx forgedock enable${RESET}`);
      console.log(`  To set up:  ${CYAN}npx forgedock init${RESET}`);
      break;
  }
  console.log("");
}

/**
 * Run installation health checks and report pass/fail for each.
 *
 * Checks (in order):
 *   1. Command symlinks — TARGET_DIR entries point to correct COMMANDS_DIR files
 *   2. gh CLI installed and authenticated
 *   3. git configured (user.name + user.email)
 *   4. forge.yaml exists and has required keys
 *   5. SessionStart hook registered in ~/.claude/settings.json
 *   6. CLAUDE.md has the ForgeDock behavioral block (cwd)
 *   7. Required workflow labels exist on the GitHub repo (needs forge.yaml + gh auth)
 *   8. FORGE_HOME environment variable is set
 *   9. Playwright MCP registered in ~/.claude/mcp_servers.json (advisory warn — required for /qa-sweep)
 *
 * Exits with code 0 if all checks pass, code 1 if any fail.
 */
async function doctor() {
  console.log("");
  console.log(`${BOLD}ForgeDock Doctor${RESET} — Installation Health Check`);
  console.log("");

  let failures = 0;
  let warnings = 0;

  /**
   * Print a pass line.
   * @param {string} label
   * @param {string} [detail]
   */
  function pass(label, detail) {
    const suffix = detail ? `  ${detail}` : "";
    console.log(`  ${GREEN}✔${RESET}  ${label}${suffix}`);
  }

  /**
   * Print a fail line with a remediation hint.
   * @param {string} label
   * @param {string} hint
   */
  function fail(label, hint) {
    failures++;
    console.log(`  ${RED}✗${RESET}  ${BOLD}${label}${RESET}`);
    console.log(`       Fix: ${hint}`);
  }

  /**
   * Print a warning line (informational, does not count as failure).
   * @param {string} label
   * @param {string} hint
   */
  function warn(label, hint) {
    warnings++;
    console.log(`  ${YELLOW}⚠${RESET}  ${label}`);
    console.log(`       Note: ${hint}`);
  }

  // ── Check 1: Command symlinks ──────────────────────────────────────────────
  {
    let symlinkOk = true;
    let checked = 0;
    let broken = 0;
    const brokenLinks = [];

    try {
      // Collect all .md files from COMMANDS_DIR recursively
      const collectMd = async (dir) => {
        const results = [];
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return results;
        }
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            results.push(...(await collectMd(full)));
          } else if (entry.name.endsWith(".md")) {
            results.push(full);
          }
        }
        return results;
      };

      const sourceFiles = await collectMd(COMMANDS_DIR);

      for (const src of sourceFiles) {
        const rel = relative(COMMANDS_DIR, src);
        const tgt = join(TARGET_DIR, rel);
        checked++;
        try {
          const lstats = await lstat(tgt);
          if (lstats.isSymbolicLink()) {
            const dest = await readlink(tgt);
            if (dest !== src) {
              broken++;
              brokenLinks.push(rel);
              symlinkOk = false;
            }
          } else {
            // Regular file — copy-mode install (Windows without Developer Mode).
            // linkCommands() falls back to copyFile() on EPERM/EACCES, so a regular
            // file is valid as long as its content matches the source. <!-- Added: forge#1174 -->
            try {
              const srcContent = readFileSync(src, "utf-8");
              const tgtContent = readFileSync(tgt, "utf-8");
              if (srcContent !== tgtContent) {
                broken++;
                brokenLinks.push(`${rel} (stale copy)`);
                symlinkOk = false;
              }
              // else: content matches — valid copy-mode install, not broken
            } catch {
              // Could not read one of the files — treat as broken.
              broken++;
              brokenLinks.push(`${rel} (unreadable)`);
              symlinkOk = false;
            }
          }
        } catch {
          // File missing
          broken++;
          brokenLinks.push(`${rel} (missing)`);
          symlinkOk = false;
        }
      }

      if (symlinkOk) {
        pass("Command files", `${checked} files installed`);
      } else {
        fail(
          "Command files",
          `Run: npx forgedock install  (${broken}/${checked} broken: ${brokenLinks.slice(0, 3).join(", ")}${brokenLinks.length > 3 ? "…" : ""})`,
        );
      }
    } catch (err) {
      fail("Command files", `Could not read commands directory: ${err.message}`);
    }
  }

  // ── Check 2: gh CLI installed + authenticated ──────────────────────────────
  let ghAvailable = false;
  {
    let ghInstalled = false;
    let ghAuthed = false;
    try {
      execSync("gh --version", { stdio: ["ignore", "pipe", "ignore"] });
      ghInstalled = true;
    } catch {
      // gh not installed
    }

    if (!ghInstalled) {
      fail("gh CLI", "Install the GitHub CLI: https://cli.github.com/");
    } else {
      try {
        execSync("gh auth status", { stdio: ["ignore", "pipe", "ignore"] });
        ghAuthed = true;
      } catch {
        // Not authenticated
      }

      if (ghAuthed) {
        pass("gh CLI", "installed and authenticated");
        ghAvailable = true;
      } else {
        fail("gh CLI", "Run: gh auth login");
      }
    }
  }

  // ── Check 3: git configured ────────────────────────────────────────────────
  {
    let gitName = "";
    let gitEmail = "";
    try {
      gitName = execSync("git config --global user.name", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
      }).trim();
    } catch {
      /* not set */
    }
    try {
      gitEmail = execSync("git config --global user.email", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
      }).trim();
    } catch {
      /* not set */
    }

    if (gitName && gitEmail) {
      pass("git config", `user.name="${gitName}", user.email="${gitEmail}"`);
    } else {
      const missing = [
        !gitName && "user.name",
        !gitEmail && "user.email",
      ].filter(Boolean).join(", ");
      fail(
        "git config",
        `Run: git config --global user.name "Your Name"  and  git config --global user.email "you@example.com"  (missing: ${missing})`,
      );
    }
  }

  // ── Check 4: forge.yaml exists + has required keys ─────────────────────────
  let forgeOwner = null;
  let forgeRepo = null;
  {
    const forgeYamlPath = join(process.cwd(), "forge.yaml");
    if (!existsSync(forgeYamlPath)) {
      warn(
        "forge.yaml",
        "No forge.yaml in current directory. Run: npx forgedock init",
      );
    } else {
      let content = "";
      try {
        content = readFileSync(forgeYamlPath, "utf-8");
      } catch (err) {
        fail("forge.yaml", `Cannot read forge.yaml: ${err.message}`);
      }

      if (content) {
        const hasProject = /^project:/m.test(content);
        const hasPaths = /^paths:/m.test(content);
        const hasBranches = /^branches:/m.test(content);
        const missing = [
          !hasProject && "project",
          !hasPaths && "paths",
          !hasBranches && "branches",
        ].filter(Boolean);

        if (missing.length === 0) {
          pass("forge.yaml", "exists with required keys");
          // Extract owner and repo for the label check (simple regex, no YAML parser needed)
          const ownerMatch = content.match(/^\s+owner:\s+"?([^"\n]+)"?\s*$/m);
          const repoMatch = content.match(/^\s+repo:\s+"?([^"\n]+)"?\s*$/m);
          if (ownerMatch) forgeOwner = ownerMatch[1].trim();
          if (repoMatch) forgeRepo = repoMatch[1].trim();
        } else {
          fail("forge.yaml", `Missing required keys: ${missing.join(", ")}. Edit forge.yaml or run: npx forgedock init`);
        }
      }
    }
  }

  // ── Check 5: SessionStart hook registered ─────────────────────────────────
  {
    try {
      const settings = readClaudeSettings();
      const sessionStartEntries = Array.isArray(settings?.hooks?.SessionStart)
        ? settings.hooks.SessionStart
        : [];
      const hookPresent = sessionStartEntries.some((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
        return hooks.some(
          (h) =>
            h &&
            typeof h.command === "string" &&
            isForgeSessionStartHook(h.command),
        );
      });

      if (hookPresent) {
        pass("SessionStart hook", "registered in ~/.claude/settings.json");
      } else {
        fail(
          "SessionStart hook",
          "Run: npx forgedock install  (writes hook entry to ~/.claude/settings.json)",
        );
      }
    } catch (err) {
      fail("SessionStart hook", `Cannot read ~/.claude/settings.json: ${err.message}. Run: npx forgedock install`);
    }
  }

  // ── Check 6: CLAUDE.md has ForgeDock block (cwd) ──────────────────────────
  {
    const claudeMdPath = join(process.cwd(), "CLAUDE.md");
    if (!existsSync(claudeMdPath)) {
      warn(
        "CLAUDE.md behavioral block",
        `No CLAUDE.md found in ${process.cwd()}. Run: npx forgedock install  (from your project directory)`,
      );
    } else {
      try {
        const content = readFileSync(claudeMdPath, "utf-8");
        if (
          content.includes(CLAUDE_BLOCK_BEGIN) &&
          content.includes(CLAUDE_BLOCK_END)
        ) {
          pass("CLAUDE.md behavioral block", `found in ${claudeMdPath}`);
        } else {
          fail(
            "CLAUDE.md behavioral block",
            `Run: npx forgedock install  (from ${process.cwd()}) to inject the ForgeDock pipeline rules block`,
          );
        }
      } catch (err) {
        fail("CLAUDE.md behavioral block", `Cannot read CLAUDE.md: ${err.message}`);
      }
    }
  }

  // ── Check 7: Required workflow labels on GitHub repo ───────────────────────
  {
    if (!forgeOwner || !forgeRepo) {
      warn(
        "GitHub workflow labels",
        "Skipped — could not resolve owner/repo from forge.yaml",
      );
    } else if (!ghAvailable) {
      warn(
        "GitHub workflow labels",
        "Skipped — gh CLI not authenticated (see check 2 above)",
      );
    } else {
      // Read expected labels from labels.json (co-located in bin/)
      const labelsJsonPath = join(__dirname, "labels.json");
      let expectedLabels = [];
      let labelsJsonOk = false;
      try {
        const labelsRaw = readFileSync(labelsJsonPath, "utf-8");
        const allLabels = JSON.parse(labelsRaw);
        expectedLabels = allLabels
          .filter((l) => l.name.startsWith("workflow:"))
          .map((l) => l.name);
        labelsJsonOk = true;
      } catch {
        warn(
          "GitHub workflow labels",
          "Could not read bin/labels.json — skipping label check",
        );
      }

      if (labelsJsonOk && expectedLabels.length > 0) {
        let existingLabels = [];
        let ghLabelOk = false;
        try {
          const out = execFileSync(
            "gh",
            ["label", "list", "-R", `${forgeOwner}/${forgeRepo}`, "--json", "name", "--limit", "200"],
            { stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" },
          );
          const parsed = JSON.parse(out);
          existingLabels = parsed.map((l) => l.name);
          ghLabelOk = true;
        } catch {
          warn(
            "GitHub workflow labels",
            `Could not fetch labels from ${forgeOwner}/${forgeRepo}. Ensure gh is authenticated and repo is accessible.`,
          );
        }

        if (ghLabelOk) {
          const missingLabels = expectedLabels.filter(
            (l) => !existingLabels.includes(l),
          );
          if (missingLabels.length === 0) {
            pass(
              "GitHub workflow labels",
              `all ${expectedLabels.length} workflow labels present on ${forgeOwner}/${forgeRepo}`,
            );
          } else {
            fail(
              "GitHub workflow labels",
              `Run: npx forgedock labels setup  (missing: ${missingLabels.join(", ")})`,
            );
          }
        }
      }
    }
  }

  // ── Check 8: FORGE_HOME environment variable ───────────────────────────────
  {
    const envForgeHome = process.env.FORGE_HOME;
    if (envForgeHome) {
      pass("FORGE_HOME env var", `set to "${envForgeHome}"`);
    } else {
      fail(
        "FORGE_HOME env var",
        `Add to your shell profile: export FORGE_HOME="${FORGE_HOME}"  then restart your shell (or run: source ~/.bashrc)`,
      );
    }
  }

  // ── Check 9: Playwright MCP registered ────────────────────────────────────
  // Playwright MCP is a guaranteed ForgeDock dependency for browser automation
  // commands (/qa-sweep). This check is advisory (warn, not fail) because MCP
  // server presence is orthogonal to the core ForgeDock install — but missing
  // it causes /qa-sweep to silently fail mid-sweep.
  {
    const mcpServersPath = join(HOME, ".claude", "mcp_servers.json");
    let playwrightFound = false;
    let fileReadable = false;
    let hasMcpServers = false;

    try {
      const mcpRaw = readFileSync(mcpServersPath, "utf-8");
      const mcpConfig = JSON.parse(mcpRaw);
      // Read + parse succeeded — the file exists and contains valid JSON.
      fileReadable = true;
      const servers = mcpConfig?.mcpServers;
      if (servers && typeof servers === "object") {
        hasMcpServers = true;
        // Search for a registered server whose name or command references playwright
        for (const [name, entry] of Object.entries(servers)) {
          const nameLower = name.toLowerCase();
          const cmdStr = [
            entry?.command ?? "",
            ...(Array.isArray(entry?.args) ? entry.args : []),
          ].join(" ").toLowerCase();
          if (nameLower.includes("playwright") || cmdStr.includes("playwright")) {
            playwrightFound = true;
            break;
          }
        }
      }
    } catch {
      // File absent or unreadable — treat as no MCP servers configured
    }

    if (!fileReadable) {
      warn(
        "Playwright MCP",
        "No MCP servers file found (~/.claude/mcp_servers.json). Register Playwright MCP to enable /qa-sweep: claude mcp add playwright npx @playwright/mcp@latest",
      );
    } else if (!hasMcpServers) {
      warn(
        "Playwright MCP",
        "MCP servers file found (~/.claude/mcp_servers.json) but it has no 'mcpServers' key. Register Playwright MCP to enable /qa-sweep: claude mcp add playwright npx @playwright/mcp@latest",
      );
    } else if (playwrightFound) {
      pass("Playwright MCP", "registered in Claude Code MCP servers");
    } else {
      warn(
        "Playwright MCP",
        "Not registered — /qa-sweep and browser automation commands will fail. Run: claude mcp add playwright npx @playwright/mcp@latest",
      );
    }
  }

  // ── Check 10: yq installed ────────────────────────────────────────────────
  // yq is a hard dependency: pipeline commands (work-on, review-pr, orchestrate)
  // read forge.yaml via yq. Without it, those commands fail. Fixed literal
  // command — no interpolation, so no injection surface (cf. #663/#789/#807).
  {
    let yqVersion = "";
    try {
      yqVersion = execSync("yq --version", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    } catch {
      // yq not installed or not on PATH
    }

    if (yqVersion) {
      pass("yq", yqVersion);
    } else {
      fail(
        "yq",
        "Install the YAML processor (used to read forge.yaml): https://github.com/mikefarah/yq#install",
      );
    }
  }

  // ── Check 11: Claude Code installed + version compatible ───────────────────
  // The compatibility floor is the @anthropic-ai/claude-code peerDependency in
  // package.json (read dynamically so it never drifts from the declared floor).
  // Not-on-PATH is a warning, not a failure: Claude Code may run as the host
  // process without exposing the `claude` CLI on PATH, so a hard fail would be a
  // false negative. Only an installed-but-too-old version is a hard failure.
  {
    // Resolve the minimum compatible version from package.json peerDependencies.
    let minClaudeVersion = "2.0.0";
    try {
      const pkgRaw = readFileSync(join(FORGE_HOME, "package.json"), "utf-8");
      const pkg = JSON.parse(pkgRaw);
      const range = pkg?.peerDependencies?.["@anthropic-ai/claude-code"];
      if (typeof range === "string") {
        const m = range.match(/(\d+\.\d+\.\d+)/);
        if (m) minClaudeVersion = m[1];
      }
    } catch {
      // package.json unreadable — keep the hardcoded fallback floor.
    }

    let claudeRaw = "";
    let claudeInstalled = false;
    try {
      claudeRaw = execSync("claude --version", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      claudeInstalled = true;
    } catch {
      // claude CLI not on PATH
    }

    if (!claudeInstalled) {
      warn(
        "Claude Code",
        `\`claude\` CLI not found on PATH (need >= v${minClaudeVersion}). If you run Claude Code without the CLI on PATH this is fine; otherwise install it: https://docs.anthropic.com/en/docs/claude-code`,
      );
    } else {
      const verMatch = claudeRaw.match(/(\d+)\.(\d+)\.(\d+)/);
      if (!verMatch) {
        warn(
          "Claude Code",
          `installed but version string could not be parsed ("${claudeRaw}"). Expected >= v${minClaudeVersion}.`,
        );
      } else {
        const found = [
          Number(verMatch[1]),
          Number(verMatch[2]),
          Number(verMatch[3]),
        ];
        const floor = minClaudeVersion.split(".").map(Number);
        // Lexicographic semver comparison: found >= floor ?
        let compatible = true;
        for (let i = 0; i < 3; i++) {
          if (found[i] > floor[i]) break;
          if (found[i] < floor[i]) {
            compatible = false;
            break;
          }
        }
        if (compatible) {
          pass("Claude Code", `v${found.join(".")} (compatible, >= v${minClaudeVersion})`);
        } else {
          fail(
            "Claude Code",
            `v${found.join(".")} is below the supported floor v${minClaudeVersion}. Update Claude Code: https://docs.anthropic.com/en/docs/claude-code`,
          );
        }
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("");
  if (failures === 0 && warnings === 0) {
    console.log(`${GREEN}${BOLD}All checks passed.${RESET} ForgeDock installation is healthy.`);
  } else if (failures === 0) {
    console.log(`${YELLOW}${BOLD}${warnings} warning(s).${RESET} Checks passed with notes above.`);
  } else {
    console.log(
      `${RED}${BOLD}${failures} check(s) failed${warnings > 0 ? `, ${warnings} warning(s)` : ""}.${RESET} See fix hints above.`,
    );
  }
  console.log("");

  if (failures > 0) {
    process.exit(1);
  }
}

function help() {
  // renderLogo already shown by splash() above — show the command table
  const commands = [
    ["Command", "Description"],
    ["npx forgedock", "Install commands (default)"],
    ["npx forgedock install", "Install commands"],
    ["npx forgedock init", "Generate forge.yaml config for your project"],
    ["npx forgedock init --minimal", "Generate a minimal forge.yaml (required sections only)"],
    ["npx forgedock uninstall", "Remove commands"],
    ["npx forgedock update", "Pull latest & reinstall"],
    ["npx forgedock run <cmd> [args]", "Run a command headlessly via the Anthropic API"],
    ["npx forgedock demo", "Set up a risk-free demo repo and print next steps"],
    ["npx forgedock enable [dir]", "Mark directory as ForgeDock-managed"],
    ["npx forgedock disable [dir]", "Opt directory out of ForgeDock"],
    ["npx forgedock status [dir]", "Show resolved state for a directory"],
    ["npx forgedock doctor", "Check installation health"],
    ["npx forgedock help", "Show this help"],
  ];

  process.stderr.write(
    box(table(commands, { header: true }), { title: "Usage" }) + "\n",
  );
}

/**
 * `forgedock run <command> [args...]` — execute a ForgeDock command spec
 * directly via the Anthropic API, outside of Claude Code (headless / CI).
 *
 * Flags:
 *   --dry-run               Preview the assembled prompt + tool plan; no API call.
 *   --model <id>            Override the model (default: claude-sonnet-4-5 or $FORGEDOCK_MODEL).
 *   --max-iterations <n>    Bound the tool-use loop (default: 50).
 *
 * The live loop requires ANTHROPIC_API_KEY and the optional @anthropic-ai/sdk
 * dependency. The runtime itself lives in bin/runner.mjs.
 *
 * Env:
 *   FORGEDOCK_MODEL   Default model id when --model is omitted.
 *   FORGEDOCK_SHELL   Override the shell used by run_bash. Defaults to bash when
 *                     found (Git Bash / WSL on Windows, /bin/bash on POSIX),
 *                     falling back to the platform default shell otherwise.
 */
async function run() {
  const runArgs = args.slice(1);
  let dryRun = false;
  let model;
  let maxIterations;
  const positional = [];
  for (let i = 0; i < runArgs.length; i++) {
    const a = runArgs[i];
    if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--model") {
      model = runArgs[++i];
    } else if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
    } else if (a === "--max-iterations") {
      maxIterations = parseInt(runArgs[++i], 10);
    } else if (a.startsWith("--max-iterations=")) {
      maxIterations = parseInt(a.slice("--max-iterations=".length), 10);
    } else {
      positional.push(a);
    }
  }

  const commandName = positional[0];
  const commandArgs = positional.slice(1);

  if (!commandName) {
    process.stderr.write(
      `${RED}Usage: forgedock run <command> [args...] [--dry-run] [--model <id>] [--max-iterations <n>]${RESET}\n`,
    );
    process.exit(1);
  }

  const { runCommand } = await import("./runner.mjs");
  try {
    const result = await runCommand({
      commandsDir: COMMANDS_DIR,
      commandName,
      args: commandArgs,
      cwd: process.cwd(),
      dryRun,
      ...(model ? { model } : {}),
      ...(Number.isInteger(maxIterations) && maxIterations > 0
        ? { maxIterations }
        : {}),
    });
    // Treat a non-clean stop (iteration cap hit, or a max_tokens-truncated
    // turn) as a failed run so CI/headless callers notice.
    if (
      result &&
      (result.status === "max-iterations" || result.status === "incomplete")
    ) {
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`${RED}${err.message}${RESET}\n`);
    process.exit(1);
  }
}

/**
 * `forgedock demo` — one-command demo mode (issue #1145).
 *
 * Stands up a runnable ForgeDock demo at a predictable location (default
 * ~/forgedock-demo) with zero required decisions, then prints the exact next
 * steps. Clones the live demo repo when available, otherwise falls back to the
 * bundled scaffold at FORGE_HOME/examples/forgedock-demo. The runtime lives in
 * bin/demo.mjs.
 */
async function demo() {
  const { runDemo } = await import("./demo.mjs");
  try {
    const result = await runDemo({
      forgeHome: FORGE_HOME,
      args: args.slice(1),
      cwd: process.cwd(),
    });
    if (result && result.status === "error") {
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`${RED}${err.message}${RESET}\n`);
    process.exit(1);
  }
}

splash();

switch (command) {
  case "install":
    await install();
    break;
  case "init":
    await init(false, args.includes("--minimal"));
    break;
  case "uninstall":
    await uninstall();
    break;
  case "update":
    await update();
    break;
  case "run":
    await run();
    break;
  case "demo":
    await demo();
    break;
  case "enable":
    await enable(args[1]);
    break;
  case "disable":
    await disable(args[1]);
    break;
  case "status":
    await status(args[1]);
    break;
  case "doctor":
    await doctor();
    break;
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    process.stderr.write(`${RED}Unknown command: ${command}${RESET}\n`);
    help();
    process.exit(1);
}
