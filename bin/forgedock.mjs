#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fileURLToPath } from "url";
import { dirname, join, relative, resolve } from "path";
import { mkdir, lstat, readlink, readdir, unlink, readFile, writeFile } from "fs/promises";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "fs";
import { execSync, execFileSync } from "child_process";
import { homedir } from "os";
import {
  makeCtx,
  runJourney,
  forge,
  read,
  review,
  celebrate,
  findMarkdownFiles,
  parseInstallTier,
  writeForgeYaml,
  backupExisting,
  manualLowConfidenceKeys,
} from "./journey.mjs";
import { removeSessionStartHook } from "./settings-hook.mjs";
import { resolveState, setOptOut, clearNudgeSeen } from "./registry.mjs";
import { renderMark, ember } from "./cinema.mjs";
import {
  renderLogo,
  box,
  table,
  input,
  dim,
  green,
  yellow,
  cyan,
  createProgressBar,
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

// Resolve home cross-platform: HOME on Unix, USERPROFILE on Windows, with
// os.homedir() as the always-available fallback (no hard exit — see #744).
const HOME = process.env.HOME || process.env.USERPROFILE || homedir();

const TARGET_DIR = join(HOME, ".claude", "commands");
const MANIFEST_PATH = join(HOME, ".claude", "forgedock", "copied-commands.json");
const SCRIPTS_DIR = join(FORGE_HOME, "scripts");
const SCRIPTS_TARGET_DIR = join(HOME, ".claude", "scripts");

/**
 * Allowlist of pipeline-agent scripts that `uninstall` cleans up from
 * ~/.claude/scripts/. The journey-based install no longer writes these
 * itself — this set only identifies leftovers from legacy installs so
 * `uninstall` can find and remove them.
 *
 * Internal tooling (gen-logo.mjs, verify-*.sh) lives in scripts/ but is NOT
 * covered here — those scripts are invoked directly via $FORGE_HOME/scripts/ by
 * review-pr.md and quality-gate.md and should not pollute the user's Claude
 * scripts namespace.
 */
const PIPELINE_SCRIPTS = new Set([
  "classify-lane.sh",
  "transition-label.sh",
  "validate-pr-target.sh",
]);

// Journey flags are stripped from positionals and fed to makeCtx via ctx().
// --minimal is init-only. Subcommands with their own flag parsing (run,
// run-issue, demo) receive restArgs — everything after the command token.
const rawArgs = process.argv.slice(2);
const FLAGS = new Set(["--fast", "--manual", "--verbose", "--minimal"]);
const flags = rawArgs.filter((a) => FLAGS.has(a));
const positional = rawArgs.filter((a) => !FLAGS.has(a));
const command = positional[0] || "install";
const cmdIdx = rawArgs.findIndex((a) => !FLAGS.has(a));
const restArgs = cmdIdx === -1 ? [] : rawArgs.slice(cmdIdx + 1);

// ---------------------------------------------------------------------------
// SessionStart hook — settings.json helpers
// ---------------------------------------------------------------------------

/**
 * Path to the user-level Claude Code settings file.
 * This is where the SessionStart hook entry is written/removed.
 */
const CLAUDE_SETTINGS_PATH = join(HOME, ".claude", "settings.json");

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

// ---------------------------------------------------------------------------
// Shell profile FORGE_HOME removal
// ---------------------------------------------------------------------------

/**
 * The sentinel comment line legacy installs wrote immediately before the
 * `export FORGE_HOME=` line. The journey-based install no longer writes this
 * block — this constant is used by `uninstall` cleanup for legacy installs
 * that still have it in a shell profile. It is the reliable anchor for
 * removal — never present in organic shell profiles.
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

  // Step 1: Remove the 2-line ForgeDock block (comment + export) that
  // installs from older builds appended, preceded by an optional leading
  // blank line. The \r? handles profiles with CRLF line endings.
  // The value pattern (?:[^"\\]|\\.)*  matches a double-quoted shell string
  // that may contain backslash-escape sequences (e.g. \" or \\) written by
  // the old installer's shell escaping. The simpler [^"]* would stop
  // prematurely at the escaped-quote character inside \".
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

// ---------------------------------------------------------------------------
// Journey context + status screen + init flow (onboarding surface)
// ---------------------------------------------------------------------------

function ctx() {
  const c = makeCtx({ argv: flags });
  c.forgeHome = FORGE_HOME;
  c.home = HOME;
  return c;
}

/** Compact status screen for configured/managed directories. */
function statusScreen(c) {
  const state = resolveState(c.cwd);
  const mark = renderMark("compact", c.mode);
  const dim = (s) => (c.mode === "none" ? s : `\x1b[2m${s}\x1b[22m`);
  c.stdout.write("\n" + mark[0] + "\n");
  c.stdout.write(mark[1] + "  " + ember("FORGEDOCK", c.mode) + " " + dim("status") + "\n");
  c.stdout.write(mark[2] + "\n" + mark[3] + "\n\n");
  const configured = existsSync(join(c.cwd, "forge.yaml"));
  c.stdout.write(`  directory   ${state}\n`);
  c.stdout.write(`  forge.yaml  ${configured ? "present" : "missing"}\n`);
  c.stdout.write(`  commands    ${existsSync(TARGET_DIR) ? "installed at " + TARGET_DIR : "not installed"}\n`);
  if (state === "managed-optedout") {
    c.stdout.write(`\n  ForgeDock is disabled (opted out) here. Re-enable: npx forgedock enable\n`);
  } else if (state === "unmanaged") {
    c.stdout.write(`\n  ForgeDock is not active in this directory. Activate: npx forgedock enable\n`);
  } else if (!configured) {
    c.stdout.write(`\n  Generate config: npx forgedock init\n`);
  } else {
    c.stdout.write(`\n  Reconfigure: npx forgedock init · Refresh commands + hook: npx forgedock update\n`);
  }
  c.stdout.write("\n");
}

async function initFlow(c) {
  const outputPath = join(c.cwd, "forge.yaml");
  if (existsSync(outputPath) && process.stdin.isTTY !== true) {
    const dim = (s) => (c.mode === "none" ? s : `\x1b[2m${s}\x1b[22m`);
    c.stdout.write("\n  forge.yaml already exists — non-interactive run, aborting to protect it.\n");
    c.stdout.write("  " + dim("Run interactively (or delete forge.yaml) to regenerate.") + "\n");
    return 1;
  }

  if (flags.includes("--minimal")) {
    // Staging semantics preserved (#1148): detection → minimal template with
    // only the three required sections. No review screen — this is the
    // power-user escape hatch for a ~20-line forge.yaml.
    const { draft, description } = await read(c);
    const backup = backupExisting(outputPath);
    if (backup) c.stdout.write(`  Backed up: forge.yaml → ${backup.backupName}\n`);
    const content = buildMinimalForgeYaml({
      projectName: draft.project.name.value,
      owner: draft.project.owner.value,
      repo: draft.project.repo.value,
      description: description.value,
      root: draft.paths.root.value,
      worktreeBase: draft.paths.worktreeBase.value,
      defaultBranch: draft.branches.default.value,
      stagingBranch: draft.branches.staging.value,
    });
    atomicWriteFile(outputPath, content);
    celebrate(c, { written: true, todoCount: 0 });
    return 0;
  }

  if (flags.includes("--manual")) {
    // Manual escape hatch: plain prompts, detection values as defaults.
    const { draft, description } = await read(c);
    const v = {
      owner: await input("GitHub owner", draft.project.owner.value),
      repo: await input("Repository", draft.project.repo.value),
      name: await input("Project name", draft.project.name.value),
      description: await input("Description", description.value),
      root: await input("Repo root", draft.paths.root.value),
      worktreeBase: await input("Worktree base", draft.paths.worktreeBase.value),
      defaultBranch: await input("Default branch", draft.branches.default.value),
      stagingBranch: await input("Staging branch", draft.branches.staging.value),
    };
    const backup = backupExisting(outputPath);
    if (backup) c.stdout.write(`  Backed up: forge.yaml → ${backup.backupName}\n`);
    const lowKeys = manualLowConfidenceKeys(draft, description, v);
    const { todoCount } = writeForgeYaml(v, lowKeys, outputPath);
    celebrate(c, { written: true, todoCount });
    return 0;
  }
  const { draft, description } = await read(c);
  const reviewed = await review(c, draft, description);
  celebrate(c, reviewed);
  return reviewed.aborted ? 1 : 0;
}

async function uninstall() {
  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — Removing pipeline commands`);
  console.log("");

  const files = await findMarkdownFiles(COMMANDS_DIR);
  let removed = 0;

  // Ownership manifest for copy-installed commands (Windows without Developer
  // Mode, or a symlink→copy fallback from a previous run). Loaded up front:
  // manifest-tracked copies are removed via the manifest loop below; the
  // content-match branch in the main loop only covers copies written by older
  // installs that predate the manifest.
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf-8"));
  } catch {
    manifest = null;
  }
  const manifestFiles =
    manifest && manifest.files && typeof manifest.files === "object"
      ? manifest.files
      : {};

  for (const file of files) {
    const rel = relative(COMMANDS_DIR, file);
    const target = join(TARGET_DIR, rel);

    try {
      const stats = await lstat(target);
      if (stats.isSymbolicLink()) {
        const current = await readlink(target);
        if (current === file) {
          await unlink(target);
          console.log(`  ${RED}Removed${RESET}: ${rel}`);
          removed++;
        }
      } else if (
        stats.isFile() &&
        !manifestFiles[rel] &&
        readFileSync(file, "utf-8") === readFileSync(target, "utf-8")
      ) {
        // Regular file installed by an older copy-mode build (no manifest
        // entry) — content matches the source, so it is ours to remove.
        await unlink(target);
        console.log(`  ${RED}Removed${RESET}: ${rel}`);
        removed++;
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error(
          `  ${RED}Error${RESET}: Cannot access ${rel} — ${err.code ?? err.message}`,
        );
        throw err;
      }
      // Doesn't exist — nothing to do
    }
  }

  // Remove copy-installed commands tracked in the ownership manifest. These
  // are regular files, not symlinks, so the symlink branch above never touches
  // them — the manifest is the only record of ForgeDock's ownership over them.
  const manifestRels = Object.keys(manifestFiles);
  for (const rel of manifestRels) {
    const target = join(TARGET_DIR, rel);
    try {
      const stats = await lstat(target);
      if (stats.isFile() && !stats.isSymbolicLink()) {
        await unlink(target);
        console.log(`  ${RED}Removed${RESET}: ${rel} ${YELLOW}(copied)${RESET}`);
        removed++;
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error(
          `  ${RED}Error${RESET}: Cannot access ${rel} — ${err.code ?? err.message}`,
        );
        throw err;
      }
      // Already gone — nothing to do
    }
  }
  if (manifest && manifestRels.length > 0) {
    manifest.files = {};
    try {
      await mkdir(dirname(MANIFEST_PATH), { recursive: true });
      await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    } catch {
      // Best-effort — a failed manifest write is non-fatal
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

  // Remove the SessionStart hook from ~/.claude/settings.json via the
  // hardened settings-hook module (never writes through malformed JSON).
  const { status: hookRemoveResult } = removeSessionStartHook(
    join(HOME, ".claude", "settings.json"),
  );
  if (hookRemoveResult === "removed") {
    console.log(
      `  ${GREEN}✔${RESET}  Removed SessionStart hook from ${CYAN}~/.claude/settings.json${RESET}`,
    );
  } else if (hookRemoveResult === "absent") {
    console.log(
      `  ✔  SessionStart hook already absent from ~/.claude/settings.json`,
    );
  } else {
    console.log(
      `  ${YELLOW}⚠${RESET}  Could not update ~/.claude/settings.json — remove the hook manually.`,
    );
  }
  console.log("");

  // Remove ForgeDock managed block from CLAUDE.md and AGENTS.md (if present).
  // The journey install no longer writes these, but installs from older builds
  // did — uninstall stays responsible for cleaning them up.
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

  // Remove FORGE_HOME export from shell profiles (.bashrc, .zshrc) — written
  // by installs from older builds; harmless no-op when absent.
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

// Reinstall = relink commands + re-register the hook. Never the full
// journey: update must not reach read/review, which could overwrite a
// curated forge.yaml (and re-runs AI enrichment on every update). Also
// idempotent, so it's the repair path for a configured repo whose
// symlinks or hook registration got out of sync.
async function relinkAndHint() {
  const c = ctx();
  await forge(c);
  if (!existsSync(join(c.cwd, "forge.yaml"))) {
    const dim = (s) => (c.mode === "none" ? s : `\x1b[2m${s}\x1b[22m`);
    c.stdout.write("  " + dim("Configure this repo: npx forgedock init") + "\n");
  }
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
      }
      await relinkAndHint();
    } catch (err) {
      console.log(
        `  ${YELLOW}Cannot fast-forward — local changes exist. Skipping.${RESET}`,
      );
    }
  } else {
    console.log(
      `  Installed via npm. Run ${CYAN}npm update -g forgedock${RESET} to update.`,
    );
    await relinkAndHint();
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Labels Bootstrap — idempotently create/update all ForgeDock-managed labels
// ---------------------------------------------------------------------------

/**
 * Resolve the target repo for the labels command.
 *
 * Priority order:
 *   1. --repo <owner/repo> passed on the CLI
 *   2. forge.yaml → project.owner + project.repo in the current working directory
 *   3. Returns null if neither is available (caller prints an error)
 *
 * @param {string[]} subArgs - CLI args after "labels [setup]"
 * @returns {string|null} "owner/repo" string or null
 */
function resolveLabelsRepo(subArgs) {
  // 1. Explicit --repo flag
  const repoFlagIdx = subArgs.indexOf("--repo");
  if (repoFlagIdx !== -1 && subArgs[repoFlagIdx + 1]) {
    return subArgs[repoFlagIdx + 1];
  }

  // 2. forge.yaml in cwd
  const forgeYamlPath = join(process.cwd(), "forge.yaml");
  if (existsSync(forgeYamlPath)) {
    try {
      const raw = readFileSync(forgeYamlPath, "utf-8");
      const ownerMatch = raw.match(/^\s*owner:\s*["']?([^\s"'#]+)["']?/m);
      const repoMatch = raw.match(/^\s*repo:\s*["']?([^\s"'#]+)["']?/m);
      if (ownerMatch && repoMatch) {
        return `${ownerMatch[1]}/${repoMatch[1]}`;
      }
    } catch {
      // fall through
    }
  }

  return null;
}

/**
 * Idempotently create or update all ForgeDock-managed labels on a GitHub repo.
 *
 * Reads the canonical manifest from bin/labels.json (co-located with this
 * script). For each label entry, calls:
 *
 *   gh label create <name> --color <hex> --description <desc> --force --repo <repo>
 *
 * --force makes the call idempotent: it creates the label if absent, or updates
 * its color and description if it already exists. Safe to re-run at any time.
 *
 * @param {string} repo - "owner/repo" string
 * @returns {{ created: number, failed: string[] }}
 */
async function labelsSetup(repo) {
  const manifestPath = join(__dirname, "labels.json");

  if (!existsSync(manifestPath)) {
    console.log(`${RED}Label manifest not found: ${manifestPath}${RESET}`);
    process.exit(1);
  }

  /** @type {Array<{name: string, color: string, description: string}>} */
  let labels;
  try {
    labels = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    console.log(`${RED}Failed to parse labels.json: ${err.message}${RESET}`);
    process.exit(1);
  }

  console.log("");
  console.log(`${BOLD}ForgeDock Label Bootstrap${RESET}`);
  console.log(`  Repository: ${cyan(repo)}`);
  console.log(`  Labels:     ${labels.length} managed labels`);
  console.log("");

  const bar = createProgressBar(labels.length, {
    label: "  Bootstrapping labels...",
  });

  let created = 0;
  const failed = [];

  for (const { name, color, description } of labels) {
    bar.tick(1, dim(name));
    try {
      execFileSync(
        "gh",
        [
          "label",
          "create",
          name,
          "--color",
          color,
          "--description",
          description,
          "--force",
          "--repo",
          repo,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      created++;
    } catch {
      failed.push(name);
      // Continue — don't abort the whole bootstrap for one failure
    }
  }

  bar.done(
    failed.length === 0
      ? `${green("✔")} Bootstrapped ${created}/${labels.length} labels on ${cyan(repo)}`
      : `${yellow("⚠")} Bootstrapped ${created}/${labels.length} labels — ${failed.length} failed`,
  );

  if (failed.length > 0) {
    console.log("");
    console.log(`  ${RED}Failed labels:${RESET}`);
    for (const name of failed) {
      console.log(`    ${dim("•")} ${name}`);
    }
    console.log(
      `\n  Run ${cyan("gh auth status")} to verify GitHub authentication.`,
    );
  }

  console.log("");
  return { created, failed };
}

/**
 * Run installation health checks and report pass/fail for each.
 *
 * Checks (in order):
 *   1.  Command symlinks — TARGET_DIR entries point to correct COMMANDS_DIR files
 *   2.  gh CLI installed and authenticated
 *   3.  git configured (user.name + user.email)
 *   4.  forge.yaml exists and has required keys
 *   5.  SessionStart hook registered in ~/.claude/settings.json
 *   6.  CLAUDE.md legacy managed block (cwd) — informational only; the
 *       journey install never injects one, session context comes from the
 *       SessionStart hook
 *   7.  Required workflow labels exist on the GitHub repo (needs forge.yaml + gh auth)
 *   8.  FORGE_HOME environment variable — informational only; not required
 *       by the journey install
 *   9.  Playwright MCP registered in ~/.claude/mcp_servers.json (advisory warn — required for /qa-sweep)
 *   10. yq installed (hard dependency for forge.yaml parsing)
 *   11. Claude Code installed and version compatible (advisory warn if not on PATH)
 *
 * Returns 0 if all checks pass (warnings allowed), 1 if any hard check fails.
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
      // Collect installable .md files from COMMANDS_DIR using the same tier filter
      // applied by forge() / findMarkdownFiles() — doctor() must validate the filtered
      // install surface, not the raw directory walk, or it would report false failures
      // for 'internal' specs that were deliberately excluded from the install.
      const sourceFiles = await findMarkdownFiles(COMMANDS_DIR);

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
            // forge() falls back to copyFile() on EPERM/EACCES, so a regular
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

  // ── Check 6: CLAUDE.md legacy managed block (cwd, informational) ──────────
  // The journey-based install never injects a CLAUDE.md block — session
  // context comes from the SessionStart hook (see Check 5). A block's absence
  // is therefore normal and PASSes. Its presence means a legacy block from an
  // older install is still around; that's informational, not a failure —
  // `npx forgedock uninstall` removes it.
  {
    const claudeMdPath = join(process.cwd(), "CLAUDE.md");
    if (!existsSync(claudeMdPath)) {
      pass(
        "CLAUDE.md legacy block",
        "no CLAUDE.md found — session context comes from the SessionStart hook",
      );
    } else {
      try {
        const content = readFileSync(claudeMdPath, "utf-8");
        if (
          content.includes(CLAUDE_BLOCK_BEGIN) &&
          content.includes(CLAUDE_BLOCK_END)
        ) {
          warn(
            "CLAUDE.md legacy block",
            `legacy ForgeDock block found in ${claudeMdPath} — uninstall removes it; the SessionStart hook has replaced it`,
          );
        } else {
          pass(
            "CLAUDE.md legacy block",
            "no legacy ForgeDock block — session context comes from the SessionStart hook",
          );
        }
      } catch (err) {
        fail("CLAUDE.md legacy block", `Cannot read CLAUDE.md: ${err.message}`);
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
              `Create the missing labels manually, e.g.: gh label create "<name>" --color <hex> --description "<desc>" -R ${forgeOwner}/${forgeRepo}  (see bin/labels.json for definitions; missing: ${missingLabels.join(", ")})`,
            );
          }
        }
      }
    }
  }

  // ── Check 8: FORGE_HOME environment variable (informational) ──────────────
  // The journey-based install never exports FORGE_HOME — it isn't required
  // for the pipeline to run. It only affects orchestrate's legacy
  // classify-lane script fallback (tracked as a follow-up), so a missing
  // value is a warning, not a failure.
  {
    const envForgeHome = process.env.FORGE_HOME;
    if (envForgeHome) {
      pass("FORGE_HOME env var", `set to "${envForgeHome}"`);
    } else {
      warn(
        "FORGE_HOME env var",
        "not exported — only affects orchestrate's legacy classify-lane script fallback (tracked as a follow-up). Not required for normal use.",
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

  return failures > 0 ? 1 : 0;
}

function help() {
  // splash() already rendered the logo to stderr — the command table itself
  // goes to stdout (help output is the requested artifact).
  const commands = [
    ["Command", "Description"],
    ["npx forgedock", "Guided setup: install commands + configure repo (default)"],
    ["npx forgedock install", "Install commands"],
    ["npx forgedock init", "Generate forge.yaml config for your project"],
    ["npx forgedock init --minimal", "Generate a minimal forge.yaml (required sections only)"],
    ["npx forgedock enable [dir]", "Activate ForgeDock in a directory"],
    ["npx forgedock disable [dir]", "Opt a directory out of ForgeDock"],
    ["npx forgedock status [dir]", "Show ForgeDock state for a directory"],
    ["npx forgedock run <cmd> [args]", "Run a command headlessly via the Anthropic API"],
    ["npx forgedock run-issue <issue>", "Drive one issue through the durable engine"],
    ["npx forgedock demo", "Set up a risk-free demo repo and print next steps"],
    ["npx forgedock labels [setup] [--repo owner/repo]", "Bootstrap ForgeDock-managed labels on a GitHub repo (idempotent)"],
    ["npx forgedock doctor", "Check installation health"],
    ["npx forgedock update", "Pull latest & reinstall"],
    ["npx forgedock uninstall", "Remove commands"],
    ["npx forgedock help", "Show this help"],
  ];
  const flagRows = [
    ["Flag", "Description"],
    ["--fast", "Skip animation/motion"],
    ["--manual", "Plain text prompts instead of the review screen (init)"],
    ["--verbose", "Show detection sources for every field (init)"],
    ["--minimal", "Generate a minimal forge.yaml with required sections only (init)"],
  ];

  process.stdout.write(
    box(table(commands, { header: true }), { title: "Usage" }) + "\n",
  );
  process.stdout.write(
    box(table(flagRows, { header: true }), { title: "Flags" }) + "\n",
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
  const runArgs = restArgs;
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
      args: restArgs,
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

// The journey-routed commands render their own branded marks (hero/compact);
// splash() would double-brand them. Engine-surface commands, help, and
// unknown-command output keep the logo.
const SPLASH_COMMANDS = new Set(["run", "run-issue", "demo", "doctor", "help", "--help", "-h"]);
const KNOWN_COMMANDS = new Set([
  "install", "init", "enable", "disable", "status", "uninstall", "update",
  "run", "run-issue", "demo", "doctor", "help", "--help", "-h",
]);
if (SPLASH_COMMANDS.has(command) || !KNOWN_COMMANDS.has(command)) splash();

let exitCode = 0;
switch (command) {
  case "install": {
    const c = ctx();
    if (existsSync(join(c.cwd, "forge.yaml")) && resolveState(c.cwd) === "managed-active") {
      statusScreen(c);
    } else {
      exitCode = await runJourney(c);
    }
    break;
  }
  case "init":
    exitCode = await initFlow(ctx());
    break;
  case "enable": {
    const c = ctx();
    const dir = positional[1] ? resolve(positional[1]) : c.cwd;
    await setOptOut(dir, false);
    if (!existsSync(join(dir, "forge.yaml")) && !existsSync(join(dir, ".forgedock"))) {
      writeFileSync(join(dir, ".forgedock"), "", "utf-8");
    }
    c.stdout.write(`\n  ForgeDock enabled in ${dir}.\n\n`);
    break;
  }
  case "disable": {
    const c = ctx();
    const dir = positional[1] ? resolve(positional[1]) : c.cwd;
    await setOptOut(dir, true);
    c.stdout.write(`\n  ForgeDock disabled in ${dir}. Re-enable: npx forgedock enable\n\n`);
    break;
  }
  case "status": {
    const c = ctx();
    if (positional[1]) c.cwd = resolve(positional[1]);
    statusScreen(c);
    break;
  }
  case "uninstall":
    await uninstall();
    break;
  case "update":
    await update();
    break;
  case "run":
    await run();
    break;
  case "run-issue": {
    const { runFromCli } = await import("./engine-cli.mjs");
    await runFromCli(restArgs);
    break;
  }
  case "demo":
    await demo();
    break;
  case "doctor":
    exitCode = await doctor();
    break;
  case "labels": {
    const subcommand = positional[1];
    if (!subcommand || subcommand === "setup" || subcommand.startsWith("--")) {
      const repo = resolveLabelsRepo(restArgs);
      if (!repo) {
        console.log(
          `${RED}No repository specified.${RESET}\n` +
            `  Pass ${cyan("--repo owner/repo")} or run from a directory with ${cyan("forge.yaml")}.`,
        );
        exitCode = 1;
      } else {
        await labelsSetup(repo);
      }
    } else {
      console.log(`${RED}Unknown labels subcommand: ${subcommand}${RESET}`);
      console.log(
        `Usage: ${CYAN}npx forgedock labels [setup] [--repo owner/repo]${RESET}`,
      );
      exitCode = 1;
    }
    break;
  }
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    console.log(`${RED}Unknown command: ${command}${RESET}`);
    help();
    exitCode = 1;
}
// Natural exit: set the code and let the event loop drain so stdout is never
// truncated (spinner timers are unref'd; SIGINT listeners are removed).
// Subcommands (run/demo) may set process.exitCode themselves — never clobber
// a failure they recorded with a success code from the router.
if (exitCode !== 0) process.exitCode = exitCode;
