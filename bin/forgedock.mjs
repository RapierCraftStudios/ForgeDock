#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join, relative, resolve } from "path";
import { mkdir, symlink, readlink, lstat, readdir, stat } from "fs/promises";
import {
  existsSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "fs";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FORGE_HOME = dirname(__dirname);
const COMMANDS_DIR = join(FORGE_HOME, "commands");

if (!process.env.HOME) {
  console.error(
    "Error: HOME environment variable is not set. Cannot determine install location.",
  );
  process.exit(1);
}

const TARGET_DIR = join(process.env.HOME, ".claude", "commands");

const args = process.argv.slice(2);
const command = args[0] || "install";

// ---------------------------------------------------------------------------
// SessionStart hook — settings.json helpers
// ---------------------------------------------------------------------------

/**
 * Path to the user-level Claude Code settings file.
 * This is where the SessionStart hook entry is written/removed.
 */
const CLAUDE_SETTINGS_PATH = join(process.env.HOME, ".claude", "settings.json");

/**
 * Timeout (in seconds) for the SessionStart hook entry written into
 * ~/.claude/settings.json. Claude Code hook timeouts are in seconds —
 * not milliseconds like the Node.js child_process timeouts elsewhere in
 * this file.
 */
const SESSION_START_HOOK_TIMEOUT_SECONDS = 10;

/**
 * The command value written into the SessionStart hook entry.
 * Uses forward slashes even on Windows — Node accepts them natively and
 * they survive hook-runner invocations that do not go through a shell.
 * Backslashes emitted by path.join() on Windows would be fragile when the
 * hook runner has no shell to interpret the quoted command string.
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
  // Escape embedded double quotes so a crafted install path cannot break out
  // of the quoted argument and inject shell tokens. (ref: forge#451)
  const safePath = hookPath.replace(/"/g, '\\"');
  return `node "${safePath}"`;
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
      i += 2;
      continue;
    }

    result += ch;
    i++;
  }

  // Remove trailing commas before } or ]
  return result.replace(/,(\s*[}\]])/g, "$1");
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

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

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
    writeFileSync(filePath, managed + "\n", "utf-8");
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
      const replaced = existing.replace(blockRegex, managed);
      if (replaced === existing) {
        // Regex matched but content was already identical
        return "unchanged";
      }
      writeFileSync(filePath, replaced, "utf-8");
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
  writeFileSync(filePath, existing + separator + managed + "\n", "utf-8");
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

  writeFileSync(filePath, cleaned.length > 0 ? cleaned + "\n" : "", "utf-8");
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

async function install() {
  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — Installing pipeline commands`);
  console.log(`  Source: ${CYAN}${COMMANDS_DIR}/${RESET}`);
  console.log(`  Target: ${CYAN}${TARGET_DIR}/${RESET}`);
  console.log("");

  await mkdir(TARGET_DIR, { recursive: true });

  const files = await findMarkdownFiles(COMMANDS_DIR);
  let installed = 0;
  let updated = 0;
  let skipped = 0;

  for (const file of files) {
    const rel = relative(COMMANDS_DIR, file);
    const target = join(TARGET_DIR, rel);
    const targetDir = dirname(target);

    await mkdir(targetDir, { recursive: true });

    try {
      const stats = await lstat(target);

      if (stats.isSymbolicLink()) {
        const current = await readlink(target);
        if (current === file) {
          skipped++;
        } else {
          await symlink(file, target + ".tmp");
          const { rename } = await import("fs/promises");
          await rename(target + ".tmp", target);
          console.log(`  ${YELLOW}Updated${RESET}: ${rel}`);
          updated++;
        }
      } else {
        console.log(
          `  ${YELLOW}WARNING${RESET}: ${rel} is a regular file — skipping (remove it manually to let ForgeDock manage it)`,
        );
        skipped++;
      }
    } catch {
      // Doesn't exist — create symlink
      await symlink(file, target);
      console.log(`  ${GREEN}Installed${RESET}: ${rel}`);
      installed++;
    }
  }

  console.log("");
  console.log(
    `Done. ${GREEN}Installed: ${installed}${RESET}, Updated: ${updated}, Skipped: ${skipped}`,
  );
  console.log("");

  // Set FORGE_HOME in shell profiles
  let profileUpdated = false;
  for (const profile of [
    join(process.env.HOME, ".bashrc"),
    join(process.env.HOME, ".zshrc"),
  ]) {
    if (existsSync(profile)) {
      const content = readFileSync(profile, "utf-8");
      if (!content.includes("FORGE_HOME")) {
        appendFileSync(
          profile,
          `\n# ForgeDock — autonomous development pipeline\nexport FORGE_HOME="${FORGE_HOME}"\n`,
        );
        console.log(`  Added FORGE_HOME to ${profile}`);
        profileUpdated = true;
      }
    }
  }

  console.log(
    `${GREEN}ForgeDock commands are now available as slash commands in any Claude Code session.${RESET}`,
  );
  console.log("");

  // Register session-start.mjs as a SessionStart hook in ~/.claude/settings.json
  const hookResult = await installSessionStartHook();
  if (hookResult === "installed") {
    console.log(
      `  ${GREEN}✔${RESET}  ${BOLD}SessionStart hook${RESET} installed in ${CYAN}~/.claude/settings.json${RESET}`,
    );
  } else if (hookResult === "already-present") {
    console.log(
      `  ✔  SessionStart hook already present in ~/.claude/settings.json`,
    );
  } else {
    // "failed" — warning only, does not block install
    console.log(
      `  ${YELLOW}⚠${RESET}  Could not write SessionStart hook to ~/.claude/settings.json`,
    );
    console.log(
      `     Run ${CYAN}npx forgedock install${RESET} again to retry.`,
    );
  }
  console.log("");

  // Auto-generate forge.yaml if missing — no second command needed
  const forgeYamlPath = join(process.cwd(), "forge.yaml");
  if (!existsSync(forgeYamlPath)) {
    await init(true);
  }

  // Inject behavioral rules into CLAUDE.md (and AGENTS.md if present).
  // Only inside a git project — guards against non-project cwd (ref: forge#585).
  const installCwd = process.cwd();
  if (isGitWorkTree(installCwd)) {
    const claudeMdPath = join(installCwd, "CLAUDE.md");
    const agentsMdPath = join(installCwd, "AGENTS.md");

    const claudeResult = injectManagedBlock(claudeMdPath);
    if (claudeResult === "created") {
      console.log(
        `  ${GREEN}✔${RESET}  ${BOLD}CLAUDE.md${RESET} created with ForgeDock pipeline rules`,
      );
    } else if (claudeResult === "updated") {
      console.log(
        `  ${GREEN}✔${RESET}  ${BOLD}CLAUDE.md${RESET} updated — ForgeDock block refreshed`,
      );
    } else if (claudeResult === "appended") {
      console.log(
        `  ${GREEN}✔${RESET}  ${BOLD}CLAUDE.md${RESET} updated — ForgeDock pipeline rules appended`,
      );
    } else {
      // unchanged
      console.log(
        `  ✔  CLAUDE.md already contains current ForgeDock pipeline rules`,
      );
    }

    // Mirror to AGENTS.md only if it already exists (never create it)
    if (existsSync(agentsMdPath)) {
      const agentsResult = injectManagedBlock(agentsMdPath);
      if (agentsResult === "created") {
        // Should not happen since we checked existsSync, but handle gracefully
        console.log(`  ${GREEN}✔${RESET}  AGENTS.md created with ForgeDock pipeline rules`);
      } else if (agentsResult === "updated" || agentsResult === "appended") {
        console.log(`  ${GREEN}✔${RESET}  AGENTS.md updated — ForgeDock pipeline rules mirrored`);
      } else {
        console.log(`  ✔  AGENTS.md already contains current ForgeDock pipeline rules`);
      }
    }
    console.log("");
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
      }
    } catch {
      // Doesn't exist — nothing to do
    }
  }

  console.log("");
  console.log(`Done. Removed: ${removed} commands.`);
  console.log("");

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

async function init(fromInstall = false) {
  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — Generating forge.yaml`);
  console.log("");

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
      console.log(
        `  ${YELLOW}Warning${RESET}: Could not parse git remote URL — using placeholder values`,
      );
    }
  } catch {
    console.log(
      `  ${YELLOW}Warning${RESET}: No git remote found — using placeholder values`,
    );
  }

  if (remoteDetected) {
    console.log(`  Detected repo:   ${CYAN}${owner}/${repo}${RESET}`);
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
    console.log(`  Default branch:  ${CYAN}${defaultBranch}${RESET}`);
  } catch {
    // Fallback: try git rev-parse
    try {
      defaultBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (defaultBranch === "HEAD") defaultBranch = "main";
      console.log(
        `  Default branch:  ${CYAN}${defaultBranch}${RESET} (from current branch)`,
      );
    } catch {
      console.log(
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
      console.log(`  Staging branch:  ${CYAN}staging${RESET} (detected)`);
    } else {
      stagingBranch = defaultBranch;
      console.log(
        `  Staging branch:  ${CYAN}${defaultBranch}${RESET} (no staging branch found — using default)`,
      );
    }
  } catch {
    console.log(
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
    console.log(
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
      console.log(
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
    console.log(`  ${YELLOW}Backed up${RESET}: forge.yaml → ${backupName}`);
  }

  // --- Generate forge.yaml content ---
  const projectName = repo
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  const content = `# forge.yaml — ForgeDock Configuration
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
  name: "${projectName}"
  owner: "${owner}"
  repo: "${repo}"
  description: "${description.replace(/"/g, '\\"')}"

# =============================================================================
# PATHS (REQUIRED)
# =============================================================================

paths:
  root: "${cwd}"
  worktree_base: "${worktreeBase}"

# =============================================================================
# BRANCHES (REQUIRED)
# =============================================================================

branches:
  default: "${defaultBranch}"
  staging: "${stagingBranch}"
  feature_pattern: "milestone/{slug}"

# =============================================================================
# REPOS (OPTIONAL)
# Multi-repo configuration. Remove the # to enable.
# =============================================================================

# repos:
#   default:
#     repo: "${owner}/${repo}"
#     staging_branch: "${stagingBranch}"
#   satellites:
#     - prefix: "mcp"
#       repo: "${owner}/your-satellite-repo"
#       staging_branch: "main"
#       local_path: "${join(cwd, "..", "your-satellite-repo")}"

# =============================================================================
# PROJECT BOARD (OPTIONAL)
# GitHub Projects v2 integration.
# To find IDs: gh project list --owner ${owner}
# =============================================================================

# project_board:
#   owner: "${owner}"
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
#   health_endpoint: "https://api.${repo}.io/health"
#   health_patterns:
#     - '"status": "ok"'
`;

  writeFileSync(outputPath, content, "utf-8");

  console.log(`  ${GREEN}Created${RESET}: forge.yaml`);
  console.log("");

  if (fromInstall) {
    // Called automatically from install() — only print what still needs attention
    if (!remoteDetected) {
      console.log(`${YELLOW}Action required:${RESET}`);
      console.log(
        `  Edit ${CYAN}forge.yaml${RESET} — fill in ${CYAN}project.owner${RESET} and ${CYAN}project.repo${RESET} (git remote not detected)`,
      );
      console.log("");
    }
  } else {
    // Called explicitly via `npx forgedock init` — print full next steps
    console.log(`${BOLD}Next steps:${RESET}`);
    if (!remoteDetected) {
      console.log(
        `  1. Edit ${CYAN}forge.yaml${RESET} — fill in ${CYAN}project.owner${RESET} and ${CYAN}project.repo${RESET}`,
      );
    } else {
      console.log(
        `  1. Review ${CYAN}forge.yaml${RESET} — all required fields were auto-detected`,
      );
    }
    console.log(
      `  2. Add ${CYAN}forge.yaml${RESET} to ${CYAN}.gitignore${RESET} if it contains sensitive paths`,
    );
    console.log(
      `  3. Run ${CYAN}/forgedock-init${RESET} inside Claude Code for guided AI-powered setup`,
    );
    console.log("");
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

function help() {
  console.log("");
  console.log(
    `${BOLD}ForgeDock${RESET} — GitHub as a knowledge graph for AI agents`,
  );
  console.log("");
  console.log("Usage:");
  console.log(
    `  ${CYAN}npx forgedock${RESET}            Install commands (default)`,
  );
  console.log(`  ${CYAN}npx forgedock install${RESET}    Install commands`);
  console.log(
    `  ${CYAN}npx forgedock init${RESET}       Generate forge.yaml config for your project`,
  );
  console.log(`  ${CYAN}npx forgedock uninstall${RESET}  Remove commands`);
  console.log(
    `  ${CYAN}npx forgedock update${RESET}     Pull latest & reinstall`,
  );
  console.log(`  ${CYAN}npx forgedock enable [dir]${RESET}  Mark directory as ForgeDock-managed`);
  console.log(`  ${CYAN}npx forgedock disable [dir]${RESET} Opt directory out of ForgeDock`);
  console.log(`  ${CYAN}npx forgedock status [dir]${RESET}  Show resolved state for a directory`);
  console.log(`  ${CYAN}npx forgedock help${RESET}       Show this help`);
  console.log("");
}

switch (command) {
  case "install":
    await install();
    break;
  case "init":
    await init();
    break;
  case "uninstall":
    await uninstall();
    break;
  case "update":
    await update();
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
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    console.log(`${RED}Unknown command: ${command}${RESET}`);
    help();
    process.exit(1);
}
