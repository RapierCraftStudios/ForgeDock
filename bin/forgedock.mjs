#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fileURLToPath } from "url";
import { dirname, join, relative, resolve, sep } from "path";
import { mkdir, lstat, readlink, readdir, unlink, readFile, writeFile } from "fs/promises";
import {
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "fs";
import { execSync, execFileSync, spawnSync } from "child_process";
import { homedir } from "os";
import https from "https";
import {
  makeCtx,
  runJourney,
  forge,
  read,
  review,
  celebrate,
  maybeOfferDemo,
  findMarkdownFiles,
  parseInstallTier,
  writeForgeYaml,
  backupExisting,
  backfillForgeYaml,
  manualLowConfidenceKeys,
  isEphemeralCachePath,
  writeInstallReceipt,
  persistHome,
  PIPELINE_SCRIPTS,
} from "./journey.mjs";
import {
  deriveWorkflowLabels,
  FINDINGS_LANE_LABEL,
  classifyFindingStatus,
  hasWorkflowLabel,
  normalizePriority,
  parseSatelliteRepos,
  buildHeartbeatBatchQuery,
  parseHeartbeatBatchResponse,
  chunkArray,
} from "./watch-utils.mjs";
import {
  removeSessionStartHook,
  removeSubagentStopHook,
  removePreToolUseHook,
  removeSubagentStopEnforceHook,
} from "./settings-hook.mjs";
import {
  resolveState,
  setOptOut,
  clearNudgeSeen,
  detectClaudeVersion,
  loadBreakpoints,
  hasFeature,
  setPersistedHomeState,
  getInstalledCommandsDriftStatus,
} from "./registry.mjs";
import { renderMark, ember } from "./cinema.mjs";
import {
  renderLogo,
  getLogoTagline,
  box,
  table,
  input,
  confirm,
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
import {
  parseNameStatusDiff,
  classifyCommandChanges,
  countBreakingCommits,
  parseGitHubOwnerRepo,
  classifyConventionalCommitLines,
  formatUpdateChangelogSummary,
  formatVersionAvailableSummary,
} from "./forge-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the real ForgeDock installation root, guarding against the case
 * where forgedock.mjs is executed from inside a git worktree.
 *
 * A git worktree always has a `.git` FILE (not directory) at its root that
 * points back to the main repository's `.git` directory. When forgedock runs
 * from a worktree, `dirname(__dirname)` resolves to the ephemeral worktree
 * path — causing symlinks in `~/.claude/commands/` to point inside the
 * worktree. After the worktree is cleaned up, those symlinks become dangling
 * refs and all slash commands fail.
 *
 * Detection: if `dir/.git` is a regular file, we are inside a worktree.
 * Resolution: run `git rev-parse --git-common-dir` (cwd: dir) which returns
 * the path to the main `.git` directory; its parent is the stable repo root.
 *
 * Falls back to `dir` unchanged when:
 *  - `dir/.git` is a directory (normal git clone — already correct)
 *  - `dir/.git` does not exist (npm-installed package — already correct)
 *  - Any error occurs (git not available, unexpected structure, etc.)
 *
 * @param {string} dir - Candidate FORGE_HOME (typically dirname(__dirname))
 * @returns {string} Stable repo root, or `dir` if no worktree is detected
 */
function resolveRealForgeHome(dir) {
  try {
    const gitEntry = join(dir, ".git");
    let stat;
    try {
      stat = lstatSync(gitEntry);
    } catch {
      // ENOENT → npm-installed package with no .git at all — return as-is
      return dir;
    }
    if (!stat.isFile()) {
      // .git is a directory → normal git clone, already points at the real root
      return dir;
    }
    // .git is a file → we are inside a git worktree.
    // `git rev-parse --git-common-dir` returns the path to the shared .git dir
    // of the main worktree.  On some git versions the path is relative to cwd,
    // so resolve it against `dir` before taking dirname.
    const commonDir = execSync("git rev-parse --git-common-dir", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
    // dirname(".git") = "." when commonDir is a bare ".git" string
    const mainRepoRoot = dirname(resolve(dir, commonDir));
    return mainRepoRoot;
  } catch {
    // Any failure (git not found, exit non-zero, etc.) — fail safe
    return dir;
  }
}

const FORGE_HOME = resolveRealForgeHome(dirname(__dirname));
const COMMANDS_DIR = join(FORGE_HOME, "commands");

// Resolve home cross-platform: HOME on Unix, USERPROFILE on Windows, with
// os.homedir() as the always-available fallback (no hard exit — see #744).
const HOME = process.env.HOME || process.env.USERPROFILE || homedir();

// ---------------------------------------------------------------------------
// Install-mode path resolution
// ---------------------------------------------------------------------------
// ForgeDock installs commands globally, to ~/.claude/. That is the only
// location the installer (bin/journey.mjs: forge()) ever writes to — it
// resolves its target from ctx.home (HOME/USERPROFILE/os.homedir()), never
// from process.cwd(). A prior refactor (#1288/#1500) added a project-scoped-
// by-default detection layer here without updating the installer to match,
// producing a split-brain where status/doctor/uninstall could report a
// "project-scoped" location that install() never actually wrote to (see
// #1589). This was backed out: detection now always agrees with what the
// installer does.
//
// --global is still accepted as a CLI flag for backward compatibility with
// existing invocations, but it is now a no-op — global is the only supported
// install location.

const GLOBAL_CLAUDE_DIR = join(HOME, ".claude");

/**
 * Resolve the install target directories for the current invocation.
 * Always resolves to the global (~/.claude) location — see the block
 * comment above for why project-scoped resolution was removed.
 *
 * @returns {{ targetDir: string, scriptsTargetDir: string, manifestPath: string, isGlobal: boolean }}
 */
function resolveInstallPaths() {
  return {
    targetDir: join(GLOBAL_CLAUDE_DIR, "commands"),
    scriptsTargetDir: join(GLOBAL_CLAUDE_DIR, "scripts"),
    manifestPath: join(GLOBAL_CLAUDE_DIR, "forgedock", "copied-commands.json"),
    isGlobal: true,
  };
}

/**
 * Resolve install paths for uninstall/update/doctor/status. Kept as a
 * distinct entry point (rather than calling resolveInstallPaths() directly)
 * since these commands conceptually "detect" an existing install; today
 * that always resolves to the same global location as resolveInstallPaths().
 *
 * @returns {{ targetDir: string, scriptsTargetDir: string, manifestPath: string, isGlobal: boolean }}
 */
function detectInstallPaths() {
  return resolveInstallPaths();
}

const SCRIPTS_DIR = join(FORGE_HOME, "scripts");

// PIPELINE_SCRIPTS (the allowlist of universal pipeline-agent scripts linked
// to ~/.claude/scripts/) is defined in journey.mjs — forge()'s
// linkPipelineScripts() step is what writes them there (forge#1885,
// restoring the linkScripts() step dropped from the legacy install()/
// update() flow). Imported here so uninstall() removes exactly what forge()
// installs, off a single source of truth.
//
// Internal tooling (gen-logo.mjs, verify-*.sh) lives in scripts/ but is NOT
// covered here — those scripts are invoked directly via $FORGE_HOME/scripts/ by
// review-pr.md and quality-gate.md and should not pollute the user's Claude
// scripts namespace (forge#715).

// Journey flags are stripped from positionals and fed to makeCtx via ctx().
// --minimal is init-only. Subcommands with their own flag parsing (run,
// run-issue, demo) receive restArgs — everything after the command token.
const rawArgs = process.argv.slice(2);
const FLAGS = new Set(["--fast", "--manual", "--verbose", "--minimal", "--extras"]);
const flags = rawArgs.filter((a) => FLAGS.has(a));
// --global is stripped from positionals/restArgs for backward compatibility
// with existing invocations, but is otherwise a no-op — see the install-mode
// path resolution block above (global is now the only install location).
const positional = rawArgs.filter((a) => !FLAGS.has(a) && a !== "--global");
const command = positional[0] || "install";
const cmdIdx = rawArgs.findIndex((a) => !FLAGS.has(a) && a !== "--global");
const restArgs = cmdIdx === -1 ? [] : rawArgs.slice(cmdIdx + 1).filter((a) => a !== "--global");

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

/**
 * Compare two dotted version strings component-wise (numeric, not
 * lexicographic — "1.9.0" must compare as older than "1.10.0").
 * Each component's leading numeric prefix is used (e.g. a prerelease-suffixed
 * component like "3-beta" compares as 3, not 0 — parseInt reads the leading
 * digits and stops at the first non-digit character, unlike Number() which
 * would reject the whole component as NaN). Components with no leading
 * numeric prefix, or missing components, are treated as 0.
 *
 * Note: `parseInt(n, 10)` is used deliberately, not `Number(n)`. This means
 * component parsing only targets plain decimal digit runs — it does not
 * interpret hex (`"0x10"`) or exponential (`"1e3"`) numeric-literal forms
 * the way `Number()` would. That's intentional: real semver/npm version
 * segments are never hex- or exponential-shaped, and swapping back to
 * `Number()` to "fix" that mismatch would reintroduce the prerelease-suffix
 * coercion bug this function was fixed for (see the note above).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a < b, positive if a > b, 0 if equal
 */
function compareVersions(a, b) {
  const pa = String(a)
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b)
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Fetch the latest published version of the `forgedock` package straight
 * from the npm registry over HTTPS.
 *
 * Deliberately does NOT shell out to `npm view` — on some Windows setups
 * `execSync("npm view ...")` reliably hangs until the timeout kills it
 * (npm.cmd spawned via cmd.exe), even though the same command runs
 * instantly from an interactive shell. A direct registry request has no
 * such dependency on npm being on PATH or well-behaved under a subshell,
 * and matches what npm's own update-notifier does internally.
 *
 * Resolves to "" (never rejects) on any failure — offline, DNS failure,
 * non-200 response, oversized response body, malformed JSON, or timeout —
 * so callers can treat "" as "could not determine" without their own
 * try/catch.
 *
 * @returns {Promise<string>} latest version string, or "" if unknown
 */
function fetchLatestVersion() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // Real payload is ~1-2 KB; this is generous headroom against an
    // unbounded response body buffering before JSON.parse (issue #1931).
    const MAX_RESPONSE_BYTES = 65536;

    try {
      const req = https.get(
        "https://registry.npmjs.org/forgedock/latest",
        { timeout: 5000, headers: { Accept: "application/json" } },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return done("");
          }
          let data = "";
          res.on("data", (chunk) => {
            if (settled) return;
            data += chunk;
            if (data.length > MAX_RESPONSE_BYTES) {
              res.destroy();
              done("");
            }
          });
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              done(typeof json.version === "string" ? json.version : "");
            } catch {
              done("");
            }
          });
          res.on("error", () => done(""));
        },
      );
      req.on("timeout", () => {
        req.destroy();
        done("");
      });
      req.on("error", () => done(""));
    } catch {
      done("");
    }
  });
}

/**
 * Fetch the release notes ("What's Changed" body + html_url) for a tagged
 * GitHub release, used to build the diff-aware changelog summary
 * (forge#1947) when a newer version is available in npm/npx mode.
 *
 * Mirrors fetchLatestVersion()'s defensive contract: resolves to `null`
 * (never rejects) on any failure — offline, DNS failure, non-200 response
 * (including 404 for an unpublished tag or 403 for rate-limiting), oversized
 * response body, malformed JSON, or timeout. Callers treat `null` as
 * "changelog unavailable" and skip the summary silently — this must never
 * block or fail the update itself.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} tag - Release tag, e.g. "v1.1.9".
 * @returns {Promise<{body: string, html_url: string}|null>}
 */
function fetchGitHubReleaseNotes(owner, repo, tag) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // Release bodies can be a few KB for a busy release — generous headroom
    // against an unbounded response body buffering before JSON.parse.
    const MAX_RESPONSE_BYTES = 262144;

    try {
      const req = https.get(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`,
        {
          timeout: 5000,
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "forgedock-cli",
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return done(null);
          }
          let data = "";
          res.on("data", (chunk) => {
            if (settled) return;
            data += chunk;
            if (data.length > MAX_RESPONSE_BYTES) {
              res.destroy();
              done(null);
            }
          });
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              if (typeof json.body !== "string") return done(null);
              done({
                body: json.body,
                html_url: typeof json.html_url === "string" ? json.html_url : "",
              });
            } catch {
              done(null);
            }
          });
          res.on("error", () => done(null));
        },
      );
      req.on("timeout", () => {
        req.destroy();
        done(null);
      });
      req.on("error", () => done(null));
    } catch {
      done(null);
    }
  });
}

function splash(context = "") {
  const version = getVersion();
  process.stderr.write(renderLogo({ version, context }) + "\n");
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
  c.includeExtras = flags.includes("--extras");
  // Detect installed Claude Code version for version-gated install paths (#1252).
  // Fail-open: null means version is unknown; callers must handle gracefully.
  c.claudeVersion = detectClaudeVersion();
  c.breakpoints = loadBreakpoints(FORGE_HOME);
  return c;
}

/**
 * Extract `project.owner`/`project.repo` and `branches.staging` from a
 * forge.yaml's raw text, using the same tolerant, no-YAML-parser regex style
 * as resolveLabelsRepo()/doctor's Check 4 (quoted or unquoted scalar, ignores
 * inline comments). Deliberately separate from resolveLabelsRepo() — that
 * function also consults a CLI `--repo` flag, which doesn't apply here.
 * @param {string} raw - forge.yaml file contents
 * @returns {{repo: string|null, staging: string|null}}
 */
function extractRepoAndStaging(raw) {
  const ownerMatch = raw.match(/^\s*owner:\s*["']?([^\s"'#]+)["']?/m);
  const repoMatch = raw.match(/^\s*repo:\s*["']?([^\s"'#]+)["']?/m);
  const stagingMatch = raw.match(/^\s*staging:\s*["']?([^\s"'#]+)["']?/m);
  return {
    repo: ownerMatch && repoMatch ? `${ownerMatch[1]}/${repoMatch[1]}` : null,
    staging: stagingMatch ? stagingMatch[1] : null,
  };
}

/**
 * Best-effort re-entry dashboard data (issue #1945): staging PR count and
 * engine in-flight/stalled counts. Every source is independently try/caught —
 * one failing (no gh auth, no forge.yaml, empty ~/.forge/runs) degrades that
 * row to "unknown"/"none" rather than blocking the others or crashing the
 * whole status screen. `engine-cli.mjs` is dynamically imported (matching the
 * existing `run-issue`/`resume-stalled` call sites in this file) so `status`
 * doesn't pay the engine module's load cost unless it's actually reachable.
 * @param {string} cwd
 * @returns {Promise<{repo: string|null, staging: string|null,
 *   prCount: number|null, engine: {total:number,inFlight:number,stalled:number}|null,
 *   lastRun: {issue:number,terminal:boolean,terminalReason:string|null}|null}>}
 */
async function gatherDashboardData(cwd) {
  const result = { repo: null, staging: null, prCount: null, engine: null, lastRun: null };

  const forgeYamlPath = join(cwd, "forge.yaml");
  if (existsSync(forgeYamlPath)) {
    try {
      const raw = readFileSync(forgeYamlPath, "utf-8");
      const { repo, staging } = extractRepoAndStaging(raw);
      result.repo = repo;
      result.staging = staging;
    } catch {
      // leave repo/staging null — dashboard rows degrade below
    }
  }

  let engineCli = null;
  try {
    engineCli = await import("./engine-cli.mjs");
  } catch {
    // engine module unavailable — engine/lastRun rows stay null
  }

  if (result.repo) {
    try {
      const args = ["pr", "list", "-R", result.repo, "--state", "open", "--json", "number"];
      if (result.staging) args.push("--base", result.staging);
      const out = execFileSync("gh", args, {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
        timeout: 10000,
      });
      result.prCount = JSON.parse(out).length;
    } catch {
      // gh not authenticated, not installed, or timed out — leave prCount null ("unknown")
    }
  }

  if (engineCli) {
    try {
      const io = engineCli.makeIo();
      result.engine = await engineCli.countEngineActivity(io, result.repo, Date.now());
    } catch {
      // leave engine null ("unknown")
    }
    try {
      result.lastRun = engineCli.lastLocalRun(engineCli.runDir());
    } catch {
      // leave lastRun null ("none")
    }
  }

  return result;
}

/** Compact status screen for configured/managed directories. */
async function statusScreen(c) {
  const state = resolveState(c.cwd);
  const mark = renderMark("compact", c.mode);
  const dim = (s) => (c.mode === "none" ? s : `\x1b[2m${s}\x1b[22m`);
  c.stdout.write("\n" + mark[0] + "\n");
  c.stdout.write(mark[1] + "  " + ember("FORGEDOCK", c.mode) + " " + dim("status") + "\n");
  c.stdout.write(mark[2] + "\n" + mark[3] + "\n");
  c.stdout.write("  " + dim(getLogoTagline("status")) + "\n\n");
  const configured = existsSync(join(c.cwd, "forge.yaml"));
  c.stdout.write(`  directory   ${state}\n`);
  c.stdout.write(`  forge.yaml  ${configured ? "present" : "missing"}\n`);
  const { targetDir: statusTargetDir } = detectInstallPaths();
  c.stdout.write(`  commands    ${existsSync(statusTargetDir) ? "installed at " + statusTargetDir : "not installed"}\n`);

  // Re-entry mini-dashboard (#1945) — only meaningful once the repo is
  // actually configured; an unconfigured/unmanaged directory has nothing to
  // report yet and would otherwise render a wall of "unknown" rows.
  if (configured && (state === "managed-active")) {
    const data = await gatherDashboardData(c.cwd);
    c.stdout.write("\n");
    c.stdout.write(
      `  staging PRs  ${data.prCount === null ? dim("unknown") : `${data.prCount} open${data.staging ? " → " + data.staging : ""}`}\n`,
    );
    c.stdout.write(
      `  engine       ${data.engine === null ? dim("unknown") : (data.engine.total === 0 ? "none in-flight" : `${data.engine.inFlight} in-flight, ${data.engine.stalled} stalled`)}\n`,
    );
    c.stdout.write(`  bot token    ${dim("not available — see docs/CONFIG.md (GitHub App Install)")}\n`);
    c.stdout.write(
      `  last run     ${data.lastRun === null ? dim("none") : `#${data.lastRun.issue} — ${data.lastRun.terminal ? (data.lastRun.terminalReason || "done") : "in progress"}`}\n`,
    );
  }

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

/**
 * `npx forgedock init` — detect + AI-enrich + review `forge.yaml`.
 *
 * AI enrichment backend selection (bin/init-enrich.mjs `resolveEnrichBackend`,
 * issue #2004): prefers a local, authenticated `claude` CLI when present,
 * otherwise falls back to the Anthropic API when ANTHROPIC_API_KEY is set,
 * otherwise skips enrichment.
 *
 * Env:
 *   FORGEDOCK_INIT_BACKEND   Override ("cli"|"api"|"none"|"auto"; default
 *                            "auto") — pins the enrichment backend instead of
 *                            the auto-detect ladder above (issue #2023).
 *                            Independent of FORGEDOCK_BACKEND, which controls
 *                            the separate `forgedock run` engine backend.
 */
async function initFlow(c) {
  const outputPath = join(c.cwd, "forge.yaml");
  const hasExisting = existsSync(outputPath);
  if (hasExisting && process.stdin.isTTY !== true) {
    const dim = (s) => (c.mode === "none" ? s : `\x1b[2m${s}\x1b[22m`);
    c.stdout.write("\n  forge.yaml already exists — non-interactive run, aborting to protect it.\n");
    c.stdout.write("  " + dim("Run interactively (or delete forge.yaml) to regenerate.") + "\n");
    return 1;
  }

  // Restore the #578 overwrite-confirmation gate for the --minimal/--manual
  // escape hatches (forge#1850): these branches previously went straight to
  // backupExisting() + write with ZERO on-screen warning in TTY mode — worse
  // than the default review() flow below, which at least shows an
  // "Overwrite Mode" banner. The default flow's own gate lives in
  // journey.mjs review() (ctx.confirmFn).
  if (hasExisting && (flags.includes("--minimal") || flags.includes("--manual"))) {
    const confirmed = await confirm(
      "forge.yaml already exists. Overwrite it? A backup will be created.",
      false,
    );
    if (!confirmed) {
      c.stdout.write("\n  Overwrite cancelled — forge.yaml left untouched.\n");
      return 1;
    }
  }

  if (flags.includes("--minimal")) {
    // Staging semantics preserved (#1148): detection → minimal template with
    // only the three required sections. No review screen — this is the
    // power-user escape hatch for a ~20-line forge.yaml.
    const { draft, description } = await read(c);
    // Hard-fail on unresolved identity placeholders when overwriting an
    // existing config (forge#1850 spec item 4) — never destroy a working
    // forge.yaml in favor of one that can't address a repo.
    if (hasExisting && (draft.project.owner.value === "your-github-org" || draft.project.repo.value === "your-repo-name")) {
      c.stdout.write("\n  Could not determine the GitHub owner/repo for this project.\n");
      c.stdout.write("  Run this inside the target git repository, or use interactive init (npx forgedock init) to edit those fields.\n");
      return 1;
    }
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
    celebrate(c, { written: true, todoCount: 0, isMinimal: true });
    await maybeOfferDemo(c);
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
    // Checked on the FINAL accepted values (post-prompt), not the draft —
    // the user may have typed over a placeholder default.
    if (hasExisting && (v.owner === "your-github-org" || v.repo === "your-repo-name")) {
      c.stdout.write("\n  Could not determine the GitHub owner/repo for this project.\n");
      c.stdout.write("  Enter real values, or run this inside the target git repository.\n");
      return 1;
    }
    const backup = backupExisting(outputPath);
    if (backup) c.stdout.write(`  Backed up: forge.yaml → ${backup.backupName}\n`);
    const lowKeys = manualLowConfidenceKeys(draft, description, v);
    const { todoCount } = writeForgeYaml(v, lowKeys, outputPath);
    celebrate(c, { written: true, todoCount });
    await maybeOfferDemo(c);
    return 0;
  }
  const { draft, description } = await read(c);
  const reviewed = await review(c, draft, description);
  celebrate(c, reviewed);
  if (!reviewed.aborted) await maybeOfferDemo(c);
  return reviewed.aborted ? 1 : 0;
}

async function uninstall() {
  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — Removing pipeline commands`);
  console.log("");

  const { targetDir, scriptsTargetDir, manifestPath } = detectInstallPaths();
  console.log(`  Mode: global (~/.claude)`);
  console.log(`  ${dim(getLogoTagline("uninstall"))}`);
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
    manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  } catch {
    manifest = null;
  }
  const manifestFiles =
    manifest && manifest.files && typeof manifest.files === "object"
      ? manifest.files
      : {};

  for (const file of files) {
    const rel = relative(COMMANDS_DIR, file);
    const target = join(targetDir, rel);

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
    const target = join(targetDir, rel);
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
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    } catch {
      // Best-effort — a failed manifest write is non-fatal
    }
  }

  console.log("");
  console.log(`Done. Removed: ${removed} commands.`);
  console.log("");

  // Remove scripts installed by ForgeDock from the detected scripts target dir
  const scriptFiles = await findScriptFiles(SCRIPTS_DIR);
  let scriptsRemoved = 0;

  for (const file of scriptFiles) {
    const rel = relative(SCRIPTS_DIR, file);
    const target = join(scriptsTargetDir, rel);

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
  const settingsJsonPath = join(HOME, ".claude", "settings.json");
  const { status: hookRemoveResult } = removeSessionStartHook(settingsJsonPath);
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

  // Remove enforcement hooks (#1250): PreToolUse, SubagentStop interactive
  // engine adapter, and SubagentStop annotation verifier.
  const { status: preToolUseRemoveResult } = removePreToolUseHook(settingsJsonPath);
  if (preToolUseRemoveResult === "removed") {
    console.log(`  ${GREEN}✔${RESET}  Removed PreToolUse enforcement hook from ${CYAN}~/.claude/settings.json${RESET}`);
  } else if (preToolUseRemoveResult !== "absent") {
    console.log(`  ${YELLOW}⚠${RESET}  Could not remove PreToolUse hook — check ${CYAN}~/.claude/settings.json${RESET} manually.`);
  }
  const { status: subagentStopRemoveResult } = removeSubagentStopHook(settingsJsonPath);
  if (subagentStopRemoveResult === "removed") {
    console.log(`  ${GREEN}✔${RESET}  Removed SubagentStop hook from ${CYAN}~/.claude/settings.json${RESET}`);
  }
  const { status: subagentStopEnforceRemoveResult } = removeSubagentStopEnforceHook(settingsJsonPath);
  if (subagentStopEnforceRemoveResult === "removed") {
    console.log(`  ${GREEN}✔${RESET}  Removed SubagentStop enforcement hook from ${CYAN}~/.claude/settings.json${RESET}`);
  } else if (subagentStopEnforceRemoveResult !== "absent") {
    console.log(`  ${YELLOW}⚠${RESET}  Could not remove SubagentStop enforcement hook — check ${CYAN}~/.claude/settings.json${RESET} manually.`);
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
  const forged = await forge(c);
  // Refresh the install receipt (#1946) — relinkAndHint() is called from
  // BOTH update() branches (the git-clone fast-forward path and the npm
  // version-check path), so wiring it here covers "refreshed after every
  // successful update" without duplicating the call at each branch. Note:
  // this is NOT reached by install's already-managed-active short-circuit
  // (that path calls statusScreen(), never relinkAndHint()) — see the
  // writeInstallReceipt() JSDoc in journey.mjs for the full picture.
  await writeInstallReceipt(c, { forged });
  if (!existsSync(join(c.cwd, "forge.yaml"))) {
    const dim = (s) => (c.mode === "none" ? s : `\x1b[2m${s}\x1b[22m`);
    c.stdout.write("  " + dim("Configure this repo: npx forgedock init") + "\n");
  }
}

/**
 * Print a condensed, diff-aware changelog summary after a successful
 * git-clone-mode fast-forward update (forge#1947).
 *
 * Sourced entirely from local git history — no network call needed here,
 * since the git-clone install already has the full commit range available.
 * Reads old/new package.json versions from the before/after commits, diffs
 * `commands/` + `bin/engine/` for added/updated/removed files, scans commit
 * subjects for breaking-change markers, and derives a compare-URL from the
 * `origin` remote (omitted if the remote isn't a recognizable GitHub URL).
 *
 * Best-effort and read-only: any failure (git command error, JSON parse
 * error, unparseable remote) is swallowed silently so it can never block or
 * fail the update itself — the caller has already printed "Updated to
 * latest." by the time this runs.
 *
 * All git subprocess calls use execFileSync with an argument array (never a
 * template-literal string passed to execSync) — see forge#1703/forge#413:
 * interpolating a variable into an execSync string spawns `/bin/sh -c` and
 * shell-parses it.
 *
 * @param {string} before - HEAD SHA before the merge.
 * @param {string} after - HEAD SHA after the merge.
 */
function printGitCloneChangelogSummary(before, after) {
  try {
    let fromVersion = "";
    try {
      const beforePkgRaw = execFileSync("git", ["show", `${before}:package.json`], {
        cwd: FORGE_HOME,
        encoding: "utf-8",
      });
      fromVersion = JSON.parse(beforePkgRaw).version || "";
    } catch {
      // package.json may not have existed at `before` (fresh install range)
      // or failed to parse — the summary still works without a from-version.
    }
    const toVersion = getVersion();

    const diffOutput = execFileSync(
      "git",
      ["diff", "--name-status", before, after, "--", "commands/", "bin/engine/"],
      { cwd: FORGE_HOME, encoding: "utf-8" },
    );
    const { commandsAdded, commandsUpdated, commandsRemoved, engineChanged } =
      classifyCommandChanges(parseNameStatusDiff(diffOutput));

    const subjectsOutput = execFileSync(
      "git",
      ["log", "--pretty=%s", `${before}..${after}`],
      { cwd: FORGE_HOME, encoding: "utf-8" },
    );
    const breakingCount = countBreakingCommits(subjectsOutput.split(/\r?\n/));

    let compareUrl;
    try {
      const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: FORGE_HOME,
        encoding: "utf-8",
      }).trim();
      const ownerRepo = parseGitHubOwnerRepo(remoteUrl);
      if (ownerRepo && fromVersion && toVersion) {
        compareUrl = `https://github.com/${ownerRepo.owner}/${ownerRepo.repo}/compare/v${fromVersion}...v${toVersion}`;
      }
    } catch {
      // No `origin` remote, or an unparseable/non-GitHub URL — the summary
      // still prints, just without a compare link.
    }

    const summary = formatUpdateChangelogSummary({
      fromVersion,
      toVersion,
      commandsAdded,
      commandsUpdated,
      commandsRemoved,
      engineChanged,
      breakingCount,
      compareUrl,
    });
    for (const line of summary.split("\n")) {
      console.log(`  ${dim(line)}`);
    }
  } catch {
    // Changelog summary is best-effort only — never block or fail the
    // update itself over a diff/parse error.
  }
}

/**
 * Best-effort fetch + print of a diff-aware changelog summary when a newer
 * version is available in npm/npx mode (forge#1947).
 *
 * npm/npx mode never runs the actual update itself (the user is told to run
 * `npx forgedock@latest`), so there is no local before/after diff to source
 * from. Instead, this fetches the newest published GitHub release's notes
 * (hardcoded canonical repo — npm-installed forgedock always originates
 * there, there is no local git remote to inspect) and condenses its
 * auto-generated "What's Changed" bullet list into conventional-commit-type
 * counts.
 *
 * Any failure (network down, rate-limited, unpublished tag) resolves to
 * `null` from fetchGitHubReleaseNotes() and is silently skipped — the
 * existing "New version available" message has already been printed by the
 * caller regardless.
 *
 * @param {string} localVersion
 * @param {string} latestVersion
 */
async function printVersionAvailableChangelog(localVersion, latestVersion) {
  try {
    const notes = await fetchGitHubReleaseNotes(
      "RapierCraftStudios",
      "ForgeDock",
      `v${latestVersion}`,
    );
    if (!notes) return;

    const { counts, breakingCount } = classifyConventionalCommitLines(notes.body);
    const summary = formatVersionAvailableSummary({
      currentVersion: localVersion,
      latestVersion,
      typeCounts: counts,
      breakingCount,
      releaseUrl: notes.html_url,
    });
    for (const line of summary.split("\n")) {
      console.log(`  ${dim(line)}`);
    }
  } catch {
    // Best-effort only — a failure here must never block the update advice
    // already printed by the caller.
  }
}

/**
 * Resolve the absolute path npm's global install tree would use for a
 * `forgedock` package, i.e. `{npm root -g}/forgedock`. Shared by
 * `isGlobalNpmInstall()` and `findSeparateGlobalInstall()` (forge#2273) so
 * the `npm root -g` shell-out and path-join logic exists in exactly one
 * place instead of being duplicated across both callers.
 *
 * Fails closed (returns null) on any error, timeout, or empty `npm root -g`
 * output — callers treat null identically to their pre-existing "detection
 * inconclusive" fallback (isGlobalNpmInstall: false; findSeparateGlobalInstall: null).
 *
 * @returns {string|null} absolute path to `{globalRoot}/forgedock`, or null
 */
function resolveGlobalNpmForgedockDir() {
  try {
    const globalRoot = execSync("npm root -g", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
    if (!globalRoot) return null;
    return resolve(join(globalRoot, "forgedock"));
  } catch {
    return null;
  }
}

/**
 * Compare two already-`resolve()`d absolute paths for equality or containment
 * (child equals parent, or sits strictly under it). On case-insensitive
 * filesystems (win32/darwin) the same physical directory can resolve with
 * differing letter casing (drive letter, path segments), so both operands are
 * lowercased before comparing there; on Linux the comparison stays
 * case-sensitive byte-for-byte (forge#2668). On the case-insensitive branch
 * both operands are also Unicode-normalized to NFC: macOS APFS/HFS+ enumerate
 * filenames NFD-normalized while CLI args/env vars typically arrive NFC, and
 * `resolve()` preserves the input form — so without normalization two paths
 * for the same physical directory containing accented characters can compare
 * unequal (forge#2674). NFC is idempotent for pure-ASCII and pre-composed
 * paths, so ASCII behavior is unchanged; win32 normalizes harmlessly. The
 * `+ sep` boundary keeps `/foo-bar` from matching parent `/foo`. Callers pass
 * paths that are already resolved — this helper deliberately does not
 * re-resolve.
 *
 * Known limitation: `caseInsensitive` is gated on `process.platform`, an
 * OS-level constant, not on the actual case-sensitivity of the volume
 * FORGE_HOME/the npm global root live on. This is the correct assumption for
 * the default filesystem format on each OS (NTFS on win32, APFS/HFS+ on
 * darwin), but a volume explicitly formatted case-sensitive (e.g. opt-in
 * case-sensitive APFS) would still be case-folded here, and two distinct
 * directories differing only by case could be treated as equal. This is an
 * accepted approximation, not a probe of real volume semantics — both call
 * sites (`isGlobalNpmInstall`, `findSeparateGlobalInstall`) already fail
 * closed / stay advisory-only, so a false match here degrades to their
 * pre-existing "detection inconclusive" behavior rather than causing any
 * destructive or incorrect action (forge#2675). Probing the actual volume
 * (e.g. an `existsSync` case-twist check) is deliberately not done — the
 * added complexity and syscall aren't warranted for a purely advisory path.
 *
 * @param {string} child - resolved absolute path being tested
 * @param {string} parent - resolved absolute path of the candidate ancestor
 * @returns {boolean}
 */
function samePathOrUnder(child, parent) {
  const caseInsensitive =
    process.platform === "win32" || process.platform === "darwin";
  const fold = (p) => (caseInsensitive ? p.normalize("NFC").toLowerCase() : p);
  const a = fold(child);
  const b = fold(parent);
  return a === b || a.startsWith(b + sep);
}

/**
 * Detect whether FORGE_HOME resolves inside npm's global install tree, i.e.
 * this process is running as a globally-installed `forgedock` package (not
 * an ephemeral npx/dlx cache extraction). Used by update()'s npm-mode branch
 * (forge#2133) to decide whether a newer published version can be installed
 * in place with `npm install -g forgedock@latest`, versus the npx-cache case
 * where there is nothing durable to reinstall over.
 *
 * Resolution: `resolveGlobalNpmForgedockDir()` (forge#2273) reports where npm's
 * global install tree would place a `forgedock` package; if FORGE_HOME sits
 * under that path, this is a global install. Fails closed (returns false) on
 * any error — the pre-existing advisory-only behavior is always a safe
 * fallback when detection is inconclusive.
 *
 * @returns {boolean}
 */
function isGlobalNpmInstall() {
  const globalPkgDir = resolveGlobalNpmForgedockDir();
  if (!globalPkgDir) return false;
  const home = resolve(FORGE_HOME);
  return samePathOrUnder(home, globalPkgDir);
}

/**
 * Detect a separate global npm install of `forgedock` that is NOT the
 * `FORGE_HOME` this process resolved to (forge#2220). This is the classic
 * `npx`-shadowing scenario: running `npx forgedock update` from inside a
 * ForgeDock git clone resolves `FORGE_HOME` to the clone (because the clone
 * itself is the `forgedock` package on disk), so the git-clone update path
 * runs and updates the checkout — while a genuinely separate global npm
 * install elsewhere on disk is silently left untouched.
 *
 * Resolution mirrors `isGlobalNpmInstall()` via the shared
 * `resolveGlobalNpmForgedockDir()` helper (forge#2273): if a `forgedock`
 * package exists at the resolved global path AND it is a different path than
 * the current `FORGE_HOME`, a separate global install exists. Fails closed
 * (returns null) on any error or timeout — this is an advisory notice only
 * and must never block or alter the update itself.
 *
 * @returns {string|null} absolute path to the separate global install, or null
 */
function findSeparateGlobalInstall() {
  const globalPkgDir = resolveGlobalNpmForgedockDir();
  if (!globalPkgDir) return null;
  const home = resolve(FORGE_HOME);
  if (samePathOrUnder(home, globalPkgDir)) {
    // Current FORGE_HOME already IS the global install — nothing separate.
    return null;
  }
  return existsSync(globalPkgDir) ? globalPkgDir : null;
}

/**
 * Maximum number of additional self-update re-exec attempts allowed after the
 * first (i.e. up to MAX_SELF_UPDATE_ATTEMPTS + 1 total `npm install -g`
 * attempts across the parent process and its re-exec'd children). Guards
 * against unbounded recursion when `npm install -g` reports success but the
 * resolved version never actually advances (stale registry mirror/proxy,
 * cache issue, mismatched FORGE_HOME resolution) — see forge#2158.
 */
const MAX_SELF_UPDATE_ATTEMPTS = 1;

/**
 * Strict semver-shape check for a version string before it is interpolated
 * into a shell-invoked command (see forge#2180). Intentionally narrow —
 * digits-dot-digits-dot-digits with an optional `-prerelease`/`+build`
 * suffix restricted to `[0-9A-Za-z.-]` — so it accepts every real value
 * `fetchLatestVersion()` can return from the npm registry's `version` field,
 * while rejecting anything containing shell metacharacters
 * (`; | & $ \` ( ) < > " ' \n` etc.) that `shell: true` would otherwise
 * hand straight to cmd.exe/`/bin/sh`.
 *
 * The regex above is fully anchored (`^...$`) but its quantifiers (`\d+`,
 * `[0-9A-Za-z.-]+`) are unbounded, so shape validity alone does not bound
 * string *length* — a pathologically long value could still match. This
 * is defense-in-depth only (see forge#2195): the character-class
 * restriction already rules out shell metacharacters at any length, and
 * `fetchLatestVersion()`'s 65536-byte HTTP response cap already bounds
 * `version` in practice. The explicit length cap below rejects oversized
 * input before the regex ever runs, closing the gap outright rather than
 * relying on an upstream cap this function has no visibility into.
 *
 * @param {string} version
 * @returns {boolean}
 */
function isValidSemverShape(version) {
  const MAX_VERSION_LENGTH = 100;
  return (
    typeof version === "string" &&
    version.length <= MAX_VERSION_LENGTH &&
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
  );
}

/**
 * Install the newer published version globally via `npm install -g
 * forgedock@{version}`, then re-exec this same file path (which npm has just
 * overwritten with the new package's contents) so the rest of update()'s
 * persist/relink phase runs against the *new* payload instead of the stale
 * in-memory one (forge#2133 — previously the advisory-only branch would
 * persist/relink from whatever was already resolved, silently downgrading
 * a newer persisted ~/.forge/ or leaving the global install stuck on the
 * old version indefinitely).
 *
 * Depth guard (forge#2158): the re-exec'd child process could, in principle,
 * observe the same "newer version available" condition again (e.g. a stale
 * registry mirror/proxy reports success without the resolved version ever
 * advancing) and recurse indefinitely, each cycle blocking up to ~125s. The
 * attempt count is propagated across the re-exec via the
 * `FORGEDOCK_SELF_UPDATE_ATTEMPT` environment variable (parent process env is
 * never mutated — the counter is only passed to the spawned child's own
 * environment). Once `MAX_SELF_UPDATE_ATTEMPTS` is reached, this function
 * fails loudly with an actionable message and returns `false` instead of
 * attempting another install/re-exec cycle.
 *
 * Fail-open: any error during install or re-exec falls back to the
 * pre-existing advisory message — the caller must treat a `false` return as
 * "could not self-update, printed manual instructions instead."
 *
 * Windows note (forge#2180): `npm` is a `.cmd` batch launcher on Windows, and
 * Node's `execFileSync`/`spawnSync` cannot invoke `.cmd`/`.bat` files without
 * `shell: true` (nodejs/node#3675) — confirmed empirically on a real Windows
 * 11 machine: `execFileSync("npm", [...])` ENOENTs, and even the exact
 * `npm.cmd` filename EINVALs, without a shell. `shell: true` is required
 * here so the install actually runs on Windows. Because that widens the
 * command line to shell interpretation, `version` — sourced from an
 * unauthenticated `https://registry.npmjs.org` response in
 * `fetchLatestVersion()` — is validated against a strict semver shape
 * (`isValidSemverShape`) before it is ever interpolated into the command,
 * closing the injection surface `shell: true` would otherwise open (see the
 * repo-wide execSync→execFileSync shell-injection hardening precedent in
 * forge#1703/forge#413).
 *
 * @param {string} version - target version to install (e.g. "1.2.0")
 * @returns {boolean} true if re-exec was launched (process will exit before
 *   returning in the success path); false if self-update failed, was capped
 *   by the depth guard, and the caller should fall back to advisory-only
 *   behavior.
 */
function selfUpdateGlobalInstall(version) {
  // Math.max(0, ...) clamps out negative values: `Number.parseInt(x, 10) || 0`
  // only substitutes 0 for NaN/0/"" — a negative numeric string (e.g. a
  // corrupted or manually-set FORGEDOCK_SELF_UPDATE_ATTEMPT="-1") is truthy
  // and passes through unclamped, which would let a negative attempt count
  // stay perpetually below MAX_SELF_UPDATE_ATTEMPTS. Defense-in-depth only —
  // no known path sets this env var to a negative value today. (forge#2168)
  const attempt = Math.max(
    0,
    Number.parseInt(process.env.FORGEDOCK_SELF_UPDATE_ATTEMPT, 10) || 0,
  );

  // `attempt` counts completed installs so far (0 = no installs yet). The
  // guard must allow MAX_SELF_UPDATE_ATTEMPTS + 1 total installs (see the
  // doc comment above this function) — i.e. it should only trip once
  // `attempt` has already reached that total, not one call early. Using
  // `>=` here tripped after only 1 install instead of the documented 2
  // (forge#2203 — the retry this guard exists to allow never actually ran).
  if (attempt > MAX_SELF_UPDATE_ATTEMPTS) {
    console.log(
      `  ${YELLOW}Self-update did not converge after ${attempt} attempt(s) — the installed version may not be advancing (stale registry mirror/cache?).${RESET}`,
    );
    console.log(
      `  Run ${CYAN}npm install -g forgedock@latest${RESET} manually, then ${CYAN}npx forgedock update${RESET} again.`,
    );
    return false;
  }

  // Validate before this value ever reaches the shell-invoked install below
  // (forge#2180) — fail open to the same advisory message a failed install
  // would print, rather than throwing or passing an unvalidated string to
  // `shell: true`.
  if (!isValidSemverShape(version)) {
    console.log(
      `  ${YELLOW}Self-update aborted: received an unexpected version string ("${version}").${RESET}`,
    );
    console.log(
      `  Run ${CYAN}npm install -g forgedock@latest${RESET} manually, then ${CYAN}npx forgedock update${RESET} again.`,
    );
    return false;
  }

  try {
    console.log(`  Installing ${CYAN}forgedock@${version}${RESET} globally...`);
    // shell: true is required to resolve npm.cmd on Windows (see the
    // Windows note in this function's doc comment, forge#2180). `version`
    // is validated as strict semver above before this point.
    execFileSync("npm", ["install", "-g", `forgedock@${version}`], {
      stdio: "inherit",
      timeout: 120000,
      shell: true,
    });
  } catch (err) {
    console.log(
      `  ${YELLOW}Global self-update failed: ${err && err.message ? err.message : String(err)}${RESET}`,
    );
    console.log(
      `  Run ${CYAN}npm install -g forgedock@latest${RESET} manually, then ${CYAN}npx forgedock update${RESET} again.`,
    );
    return false;
  }

  console.log(
    `  ${GREEN}Installed v${version}.${RESET} Re-running update to finish persist/relink...`,
  );
  try {
    const result = spawnSync(process.execPath, [__filename, "update"], {
      stdio: "inherit",
      env: {
        ...process.env,
        FORGEDOCK_SELF_UPDATE_ATTEMPT: String(attempt + 1),
      },
    });
    // `result.signal` is set (non-null) when the re-exec'd child was
    // terminated by a signal (e.g. SIGTERM/SIGKILL) rather than exiting
    // cleanly — in that case `result.status` is `null`, and
    // `result.status ?? 0` would silently collapse a killed child into a
    // reported "success" (exit 0). Exit non-zero explicitly for the
    // signal-killed case; the non-signaled path is unchanged. (forge#2159)
    process.exit(result.signal ? 1 : (result.status ?? 0));
    // Unreachable — process.exit() above terminates the process. Present
    // only to satisfy linters expecting a return on every path.
    return true;
  } catch (err) {
    console.log(
      `  ${YELLOW}Could not re-run update after install: ${err && err.message ? err.message : String(err)}${RESET}`,
    );
    console.log(`  Run ${CYAN}npx forgedock update${RESET} again manually.`);
    return false;
  }
}

async function update() {
  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — Checking for updates`);
  console.log("");

  console.log(`  ${dim(getLogoTagline("update"))}`);

  // Check if installed via npm (no .git directory) or via git clone
  const gitDir = join(FORGE_HOME, ".git");
  if (existsSync(gitDir)) {
    // forge#2220 — state the actual install being updated. Printing this
    // only after the git-dir check (rather than an unconditional "global"
    // line before it) is the fix: a clone resolved via npx-shadowing was
    // previously reported as "Mode: global (~/.claude)", which reads as
    // "your global install was updated" when in fact only this checkout was.
    console.log(`  Mode: git clone at ${CYAN}${FORGE_HOME}${RESET}`);
    const separateGlobalInstall = findSeparateGlobalInstall();
    if (separateGlobalInstall) {
      console.log(
        `  ${YELLOW}Note: this updates the git clone above. Your global npm install at ${separateGlobalInstall} was NOT touched.${RESET}`,
      );
      console.log(
        `  ${YELLOW}Run 'npm update -g forgedock', or 'npx forgedock update' from outside a clone, to update it.${RESET}`,
      );
    }
    try {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: FORGE_HOME,
        encoding: "utf-8",
      }).trim();

      // If on a non-main branch, switch to main for the update then restore.
      // Detached HEAD ("HEAD") is treated as non-restorable — we leave on main
      // after the update and warn the user.
      const isDetached = branch === "HEAD";
      const needsCheckout = branch !== "main";
      if (needsCheckout) {
        // Dirty-tree guard: refuse to move HEAD in this clone if there are
        // uncommitted TRACKED changes. Untracked files are intentionally
        // excluded (--untracked-files=no) so a clean checkout with stray
        // scratch/log files does not spuriously block the update.
        const porcelain = execFileSync(
          "git",
          ["status", "--porcelain", "--untracked-files=no"],
          { cwd: FORGE_HOME, encoding: "utf-8" },
        ).trim();
        if (porcelain) {
          console.log(
            `  ${YELLOW}Working tree has uncommitted changes on branch ${branch} — skipping git-based update.${RESET}`,
          );

          // forge#2460 — distinguish "developing on this checkout" from a
          // dirty git-clone install elsewhere with unrelated changes. The
          // former (npx-shadowing: FORGE_HOME resolves to the directory the
          // user is physically running the CLI from) has a git-independent
          // fallback available — relinkAndHint() only copies commands/hooks
          // off disk, it never touches git state, so it's safe to run on a
          // dirty tree. HEAD is still never moved in either case.
          const cwdResolved = resolve(process.cwd());
          const forgeHomeResolved = resolve(FORGE_HOME);
          const isSourceRepoSelf = samePathOrUnder(
            cwdResolved,
            forgeHomeResolved,
          );

          if (isSourceRepoSelf) {
            console.log(
              `  ${YELLOW}This looks like the ForgeDock source repo itself — syncing commands/hooks from the working tree instead (HEAD was NOT moved).${RESET}`,
            );
            // forge#2493 — relinkAndHint() is wrapped in its own try/catch
            // here so a failure inside it (forge()/writeInstallReceipt()
            // disk-write errors) doesn't fall through to the outer catch
            // below, which prints a fast-forward/merge message that would be
            // actively wrong for this path — no fast-forward or merge is
            // ever attempted when isSourceRepoSelf is true.
            try {
              await relinkAndHint();
            } catch (relinkErr) {
              console.log(
                `  ${YELLOW}Could not sync commands/hooks from the working tree: ${relinkErr.message}${RESET}`,
              );
            }
            console.log(
              `  To pull the latest published release instead: ${CYAN}npm install -g forgedock@latest && npx forgedock doctor --fix${RESET}`,
            );
          } else {
            console.log(
              `  ${YELLOW}Commit or stash your changes before updating, or run from a clean clone. HEAD was NOT moved.${RESET}`,
            );
          }
          return;
        }

        if (isDetached) {
          console.log(
            `  ${YELLOW}Detached HEAD state — switching to main for update.${RESET}`,
          );
        } else {
          console.log(
            `  On branch ${CYAN}${branch}${RESET} — switching to ${CYAN}main${RESET} for update...`,
          );
        }
        execFileSync("git", ["checkout", "main", "--quiet"], { cwd: FORGE_HOME });
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
        printGitCloneChangelogSummary(before, after);
      }
      await relinkAndHint();

      // Restore original branch after a successful update.
      if (needsCheckout && !isDetached) {
        try {
          execFileSync("git", ["checkout", branch, "--quiet"], { cwd: FORGE_HOME });
          console.log(
            `  Restored branch ${CYAN}${branch}${RESET}.`,
          );
        } catch {
          console.log(
            `  ${YELLOW}⚠  Could not restore branch ${branch} — you are now on main.${RESET}`,
          );
        }
      }
    } catch (err) {
      console.log(
        `  ${YELLOW}Cannot fast-forward — local changes exist. Skipping.${RESET}`,
      );
    }
  } else {
    // npm/npx install (no .git dir in FORGE_HOME) — most commonly the npx
    // cache path (`npx forgedock`), which was never globally installed, so
    // "npm update -g forgedock" is a no-op. Check the actual published
    // version instead and give advice that reflects the real install model.
    //
    // forge#2220 — state the actual resolved install kind + path up front,
    // computed once and reused below, so the mode line can never drift from
    // the branch actually taken (isGlobalNpmInstall() is also consulted
    // later to decide whether to self-update in place).
    const globalInstall = isGlobalNpmInstall();
    console.log(
      globalInstall
        ? `  Mode: global npm install at ${CYAN}${FORGE_HOME}${RESET}`
        : `  Mode: npx (ad-hoc, not installed) — resolved from ${CYAN}${FORGE_HOME}${RESET}`,
    );

    const localVersion = getVersion();
    const latestVersion = await fetchLatestVersion();

    if (!latestVersion) {
      console.log(
        `  ${YELLOW}Could not check npm for the latest version.${RESET} To force a refresh: ${CYAN}npx forgedock@latest${RESET}`,
      );
    } else if (!localVersion) {
      console.log(
        `  Latest published version is ${CYAN}v${latestVersion}${RESET}. To update: ${CYAN}npx forgedock@latest${RESET}`,
      );
    } else if (compareVersions(latestVersion, localVersion) > 0) {
      console.log(
        `  ${GREEN}New version available: v${latestVersion}${RESET} (you have v${localVersion}).`,
      );
      await printVersionAvailableChangelog(localVersion, latestVersion);

      // forge#2133 — a global npm install can actually be upgraded in place;
      // do that instead of only printing an advisory (which previously left
      // global installs stuck on whatever version was first installed,
      // since every subsequent `npx forgedock update` re-resolves the same
      // stale global binary). selfUpdateGlobalInstall() re-execs and exits
      // the process on success, so anything after this block only runs when
      // self-update wasn't attempted or failed.
      if (globalInstall) {
        selfUpdateGlobalInstall(latestVersion);
        // selfUpdateGlobalInstall() only returns (rather than exiting the
        // process) when the install or re-exec failed — it already printed
        // manual-recovery instructions, so fall through to the persist
        // refresh below using the still-stale local payload (fail-open,
        // matches pre-existing behavior for this failure case).
      } else {
        console.log(`  Run ${CYAN}npx forgedock@latest${RESET} to fetch it.`);
      }
    } else {
      console.log(`  Already up to date (v${localVersion}).`);
    }

    // Refresh the persisted ~/.forge/ copy from the currently-resolved
    // package (forge#1943). The version-check above is advisory only — it
    // tells the user to re-run npx forgedock@latest but never touched disk.
    // This actually copies whatever payload FORGE_HOME resolves to right now
    // (the just-fetched npx package on `npx forgedock@latest update`, or
    // whatever was already resolved on a plain `npx forgedock update`) into
    // ~/.forge/, so the persisted copy doesn't go stale between full
    // install/init runs. Skipped as a no-op for git-clone installs (handled
    // by the `if (existsSync(gitDir))` branch above — this code path only
    // runs for npm/npx installs). Fail-open: any error here must never block
    // relinkAndHint() below.
    try {
      const persisted = await persistHome(ctx());
      if (!persisted.skipped) {
        await setPersistedHomeState({
          path: persisted.forgeHome,
          version: persisted.version,
        });
        if (persisted.migrated) {
          console.log(`  ${GREEN}Refreshed ~/.forge/${RESET} (v${persisted.version || "unknown"}).`);
        }
      }
    } catch {
      // Best-effort — persisted-home refresh must never block the update.
    }

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
 *   12. GitHub App / bot token status — informational only; reports that
 *       pipeline gh calls use the active `gh auth` context (personal token
 *       unless the operator has manually configured a bot token). Installing
 *       the GitHub App alone does not create a bot token (see forge#1890).
 *
 * `--fix` (fix=true): auto-applies remediation for checks with a safe,
 * deterministic, no-input-needed fix — Command symlinks (1), SessionStart
 * hook registration (5), SessionStart hook script path integrity (5c),
 * CLAUDE.md legacy block (6), and GitHub workflow labels (7). Checks that
 * require user interaction (gh auth login, git identity, forge.yaml init,
 * yq/Claude Code installs, Playwright MCP registration) are always
 * report-only — `--fix` never touches them. See forge#1944.
 *
 * Returns 0 if all checks pass (warnings allowed), 1 if any hard check fails.
 * @param {boolean} [fix] - When true, auto-apply deterministic remediations.
 */
async function doctor(fix = false) {
  console.log("");
  console.log(`${BOLD}ForgeDock Doctor${RESET} — Installation Health Check`);
  console.log("");

  const { targetDir: TARGET_DIR } = detectInstallPaths();
  console.log(`  Mode: global (~/.claude)`);
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

  /**
   * Print a "fixed" line — distinct from pass/fail/warn — for a check that
   * failed or warned on first detection but was successfully auto-remediated
   * during this run. Does not count toward failures/warnings.
   * @param {string} label
   * @param {string} [detail]
   */
  let fixesApplied = 0;
  function fixed(label, detail) {
    fixesApplied++;
    const suffix = detail ? `  ${detail}` : "";
    console.log(`  ${CYAN}↻${RESET}  ${BOLD}${label}${RESET}${suffix}`);
  }

  const settingsPath = join(HOME, ".claude", "settings.json");

  /**
   * Detect whether the registered SessionStart hook entry (if any) points at
   * a script path that no longer exists on disk — the same detection Check 5c
   * reports on. Shared with runInstallRepairOnce() below: forge()'s
   * installSessionStartHook() treats ANY existing ForgeDock-marked entry as
   * "already registered" regardless of whether its script path still
   * resolves, so a dangling entry must be explicitly cleared before forge()
   * will register a fresh one. (forge#1895)
   * @returns {{state: 'ok'|'no-entry'|'unparseable'|'dangling'|'error', path: (string|null), command?: string, ephemeral?: boolean, error: (string|null)}}
   */
  function detectSessionStartHookPath() {
    try {
      const settings = readClaudeSettings();
      const sessionStartEntries = Array.isArray(settings?.hooks?.SessionStart)
        ? settings.hooks.SessionStart
        : [];

      let hookCommand = null;
      outer: for (const entry of sessionStartEntries) {
        if (!entry || typeof entry !== "object") continue;
        const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
        for (const h of hooks) {
          if (h && typeof h.command === "string" && isForgeSessionStartHook(h.command)) {
            hookCommand = h.command;
            break outer;
          }
        }
      }

      if (!hookCommand) return { state: "no-entry", path: null, error: null };

      const pathMatch = hookCommand.match(/node\s+"([^"]+)"/);
      const hookScriptPath = pathMatch ? pathMatch[1] : null;
      if (!hookScriptPath) {
        return { state: "unparseable", path: null, command: hookCommand, error: null };
      }
      if (existsSync(hookScriptPath)) {
        return { state: "ok", path: hookScriptPath, error: null };
      }
      return {
        state: "dangling",
        path: hookScriptPath,
        ephemeral: isEphemeralCachePath(hookScriptPath),
        error: null,
      };
    } catch (err) {
      return { state: "error", path: null, error: err.message };
    }
  }

  /**
   * Shared repair primitive for Checks 1 (command symlinks), 5 (SessionStart
   * hook registration), and 5c (SessionStart hook script path integrity).
   * Memoized so it only runs once per `doctor --fix` invocation even though
   * more than one check can trigger it.
   *
   * Reuses forge() (bin/journey.mjs) verbatim — the same repair path already
   * used by `npx forgedock update` (see relinkAndHint()) — rather than
   * duplicating symlink/copy-mode or hook-registration logic here.
   *
   * NOTE: `installRepairRan` only memoizes whether the repair primitive
   * itself has executed during this invocation — it is a cross-check flag
   * by necessity (any of the three checks below can trigger it, and it must
   * not re-run for the other two). It must NOT be read by an individual
   * check to decide whether THAT check was fixed — a check that was already
   * healthy before a sibling check triggered repair would incorrectly
   * report "repaired" too. Each check below tracks its own pre-repair
   * broken state in a local `*WasBroken` variable for that decision instead.
   * (forge#1975)
   */
  let installRepairRan = false;
  async function runInstallRepairOnce() {
    if (installRepairRan) return;
    installRepairRan = true;
    console.log(`  ${CYAN}↻${RESET}  Repairing command links + SessionStart hook...`);
    try {
      const staleHook = detectSessionStartHookPath();
      if (staleHook.state === "dangling") {
        removeSessionStartHook(settingsPath);
      }
      await forge(ctx());
    } catch (err) {
      console.log(`  ${RED}Repair failed:${RESET} ${err.message}`);
    }
  }

  // ── Check 1: Command symlinks ──────────────────────────────────────────────
  {
    async function detectCommandFiles() {
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

        return { ok: symlinkOk, checked, broken, brokenLinks, error: null };
      } catch (err) {
        return { ok: false, checked, broken, brokenLinks, error: err.message };
      }
    }

    let cmdFiles = await detectCommandFiles();
    let cmdFilesWasBroken = false;
    if (!cmdFiles.error && !cmdFiles.ok && fix) {
      cmdFilesWasBroken = true;
      await runInstallRepairOnce();
      cmdFiles = await detectCommandFiles();
    }

    if (cmdFiles.error) {
      fail("Command files", `Could not read commands directory: ${cmdFiles.error}`);
    } else if (cmdFiles.ok) {
      if (fix && cmdFilesWasBroken) {
        fixed("Command files", `${cmdFiles.checked} files installed (repaired)`);
      } else {
        pass("Command files", `${cmdFiles.checked} files installed`);
      }
    } else {
      fail(
        "Command files",
        `Run: npx forgedock doctor --fix  (or: npx forgedock install)  (${cmdFiles.broken}/${cmdFiles.checked} broken: ${cmdFiles.brokenLinks.slice(0, 3).join(", ")}${cmdFiles.brokenLinks.length > 3 ? "…" : ""})`,
      );
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
          // Extract owner and repo for the label check (simple regex, no YAML
          // parser needed). Anchored on the quoted value only (not "rest of
          // line must be blank") so a trailing `# TODO(forgedock:...)`
          // comment — exactly what a placeholder/low-confidence field gets —
          // doesn't prevent extraction. (forge#1850: the previous `\s*$`
          // anchor silently failed to extract any TODO-flagged value, which
          // is the one case doctor most needs to see.)
          const ownerMatch = content.match(/^\s+owner:\s+"([^"]*)"/m);
          const repoMatch = content.match(/^\s+repo:\s+"([^"]*)"/m);
          if (ownerMatch) forgeOwner = ownerMatch[1].trim();
          if (repoMatch) forgeRepo = repoMatch[1].trim();

          // ── Placeholder / staleness checks (forge#1850) ────────────────
          // A config can pass the structural check above (has all three
          // required top-level keys) and still be a stubbed placeholder —
          // catch that here so it's flagged before any pipeline command
          // silently consumes it (e.g. opening PRs against a wrong/guessed
          // branches.staging). Advisory (warn, not fail): a bare `--fast`
          // install with no git remote yet is a legitimate, already-tested
          // "get started, fill in details later" path — doctor should
          // surface the gap loudly without turning normal onboarding into a
          // broken-install exit code.
          if (forgeOwner === "your-github-org" || forgeRepo === "your-repo-name") {
            warn(
              "forge.yaml identity",
              "owner/repo are still placeholder values (your-github-org / your-repo-name). Run: npx forgedock init",
            );
          }

          const todoMarkers = content.match(/# TODO\(forgedock:[a-zA-Z]+\)/g) || [];
          if (todoMarkers.length > 0) {
            const uniqueFields = [...new Set(todoMarkers)].join(", ");
            warn(
              "forge.yaml placeholders",
              `${todoMarkers.length} field(s) still flagged with # TODO(forgedock:...) — verify and fill in: ${uniqueFields}`,
            );
          }

          const defaultMatch = content.match(/^\s+default:\s+"([^"]*)"/m);
          const stagingMatch = content.match(/^\s+staging:\s+"([^"]*)"/m);
          if (
            defaultMatch &&
            stagingMatch &&
            defaultMatch[1].trim() === stagingMatch[1].trim()
          ) {
            warn(
              "forge.yaml branches",
              `branches.staging equals branches.default ('${stagingMatch[1].trim()}') — verify this is intentional (some projects have no separate staging branch) rather than an undetected 'origin/staging' fallback. See docs/CONFIG.md.`,
            );
          }
        } else {
          fail("forge.yaml", `Missing required keys: ${missing.join(", ")}. Edit forge.yaml or run: npx forgedock init`);
        }
      }
    }
  }

  // ── Check 5: SessionStart hook registered ─────────────────────────────────
  {
    function detectSessionStartHookRegistered() {
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
        return { ok: hookPresent, error: null };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    let hookReg = detectSessionStartHookRegistered();
    let hookRegWasBroken = false;
    if (!hookReg.error && !hookReg.ok && fix) {
      hookRegWasBroken = true;
      await runInstallRepairOnce();
      hookReg = detectSessionStartHookRegistered();
    }

    if (hookReg.error) {
      fail("SessionStart hook", `Cannot read ~/.claude/settings.json: ${hookReg.error}. Run: npx forgedock install`);
    } else if (hookReg.ok) {
      if (fix && hookRegWasBroken) {
        fixed("SessionStart hook", "registered in ~/.claude/settings.json (repaired)");
      } else {
        pass("SessionStart hook", "registered in ~/.claude/settings.json");
      }
    } else {
      fail(
        "SessionStart hook",
        "Run: npx forgedock doctor --fix  (or: npx forgedock install)  (writes hook entry to ~/.claude/settings.json)",
      );
    }
  }

  // ── Check 5b: 2026 feature-gated install capabilities ─────────────────────
  {
    const detectedVer = detectClaudeVersion();
    const breakpoints = loadBreakpoints(FORGE_HOME);
    if (detectedVer === null) {
      warn(
        "Version-gated features",
        "claude CLI not detected — cannot assess 2026 feature availability. Install or add claude to PATH.",
      );
    } else {
      const vStr = Array.isArray(detectedVer) ? detectedVer.join(".") : String(detectedVer);
      const featureChecks = [
        ["effort levels", "effort_levels", "2.1.154"],
        ["SubagentStop context injection", "stop_subagent_stop_additional_context", "2.1.163"],
        ["Tool(param:value) permission rules", "tool_param_value_permission_rules", "2.1.178"],
        ["skills/commands merge", "skills_commands_merge", "2.1.196"],
        ["Sonnet 5 default + 1M context", "sonnet_5_default_1m_context", "2.1.197"],
      ];
      const unavailable = featureChecks
        .filter(([, key]) => !hasFeature(breakpoints, key, vStr))
        .map(([label, , minVer]) => `${label} (requires v${minVer}+)`);
      if (unavailable.length === 0) {
        pass(
          "Version-gated features",
          `v${vStr} — all 2026 features available`,
        );
      } else {
        warn(
          "Version-gated features",
          `v${vStr} — unavailable: ${unavailable.join(", ")}. Update Claude Code to unlock.`,
        );
      }
    }
  }

  // ── Check 5c: SessionStart hook script path integrity ─────────────────────
  // Check 5 only verifies a ForgeDock SessionStart hook ENTRY is registered
  // in settings.json — it never checks whether the script path baked into
  // that entry's command still exists on disk. For `npx forgedock` installs,
  // FORGE_HOME (and therefore the hook's script path) can resolve inside an
  // ephemeral npm/npx/pnpm/yarn cache directory (see isEphemeralCachePath()
  // in journey.mjs). If that cache is later pruned, the registered entry
  // still looks healthy to Check 5 while the file it points at is gone —
  // Claude Code sessions get no ForgeDock context injected and no error is
  // ever surfaced. This check catches that silent-failure case. (forge#1895)
  {
    let hookPathResult = detectSessionStartHookPath();
    let hookPathWasBroken = false;
    if (hookPathResult.state === "dangling" && fix) {
      hookPathWasBroken = true;
      await runInstallRepairOnce();
      hookPathResult = detectSessionStartHookPath();
    }

    if (hookPathResult.state === "error") {
      fail("SessionStart hook script path", `Cannot verify hook script path: ${hookPathResult.error}. Run: npx forgedock install`);
    } else if (hookPathResult.state === "no-entry") {
      // No registered entry — Check 5 already reports this; nothing new here.
      pass("SessionStart hook script path", "skipped — no registered hook entry (see SessionStart hook check above)");
    } else if (hookPathResult.state === "unparseable") {
      warn(
        "SessionStart hook script path",
        `Could not parse a script path out of the registered hook command ("${hookPathResult.command}"). Run: npx forgedock install`,
      );
    } else if (hookPathResult.state === "ok") {
      if (fix && hookPathWasBroken) {
        fixed("SessionStart hook script path", `refreshed to a valid path (${hookPathResult.path})`);
      } else {
        pass("SessionStart hook script path", `exists on disk (${hookPathResult.path})`);
      }
    } else {
      // Still dangling — either --fix wasn't passed, or the repair attempt
      // above failed to produce a resolvable path.
      fail(
        "SessionStart hook script path",
        hookPathResult.ephemeral
          ? `${hookPathResult.path} no longer exists — it was installed from an ephemeral npm/npx/pnpm/yarn cache directory that has since been cleared. Run: npx forgedock doctor --fix  (or: npm install -g forgedock  then  npx forgedock install)`
          : `${hookPathResult.path} no longer exists. Run: npx forgedock doctor --fix  (or: npx forgedock install)`,
      );
    }
  }

  // ── Check 5d: Persisted toolset home (~/.forge) ────────────────────────────
  // persistHome() (bin/journey.mjs, forge#1943) copies bin/commands/scripts/
  // templates from wherever FORGE_HOME resolved into a stable ~/.forge/ copy
  // on every `npx forgedock` install/init/update run, so ~/.claude/commands
  // symlinks and the SessionStart hook keep working after the npm/npx cache
  // that originally served them is evicted. This check reports that copy's
  // state — it is a SIBLING of (and unrelated to) the pre-existing
  // ~/.forge/{runs,index} engine-data directories used by the run-issue
  // engine (bin/engine.mjs) and the recall knowledge index (bin/recall.mjs);
  // this check never reads or writes those.
  //
  // A git-clone dev install is explicitly exempt: persistHome() skips it on
  // purpose (a clone is already stable and user-owned — see Acceptance
  // Criteria #5 on #1943), so ~/.forge/{bin,commands,...} correctly does not
  // exist for that install mode. pass() silently rather than warn — an
  // absence that isn't a problem should not read as one.
  {
    try {
      const isGitCloneInstall = existsSync(join(FORGE_HOME, ".git"));
      if (isGitCloneInstall) {
        pass("Persisted toolset home (~/.forge)", "skipped — git-clone install links directly from the clone");
      } else {
        const persistedHome = join(HOME, ".forge");
        const payloadDirs = ["bin", "commands", "scripts", "templates"];
        const missingDirs = payloadDirs.filter((d) => !existsSync(join(persistedHome, d)));
        const versionPath = join(persistedHome, "version");

        if (missingDirs.length === payloadDirs.length && !existsSync(versionPath)) {
          // Pre-migration state — persistHome() simply hasn't run yet for
          // this user. Not a failure: the very next `npx forgedock` run
          // creates it.
          warn(
            "Persisted toolset home (~/.forge)",
            "not yet created — run: npx forgedock install  (or npx forgedock update)",
          );
        } else if (missingDirs.length > 0) {
          warn(
            "Persisted toolset home (~/.forge)",
            `incomplete (missing: ${missingDirs.join(", ")}). Run: npx forgedock install`,
          );
        } else {
          // Package-vs-installed-commands drift comparison is factored into
          // a single shared helper (bin/registry.mjs's
          // getInstalledCommandsDriftStatus, forge#2719) so doctor, the
          // `version` command, and the SessionStart hook all agree on one
          // source of truth instead of re-deriving this logic independently.
          const { persistedVersion, isStale, unknown } = getInstalledCommandsDriftStatus(FORGE_HOME);
          if (!unknown && isStale) {
            warn(
              "Persisted toolset home (~/.forge)",
              `v${persistedVersion} — source is v${getVersion()}. Run: npx forgedock update`,
            );
          } else {
            pass("Persisted toolset home (~/.forge)", `v${persistedVersion || "unknown"} at ${persistedHome}`);
          }
        }
      }
    } catch (err) {
      warn("Persisted toolset home (~/.forge)", `Could not verify: ${err.message}`);
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

    function detectClaudeMdBlock() {
      if (!existsSync(claudeMdPath)) return { state: "no-file", error: null };
      try {
        const content = readFileSync(claudeMdPath, "utf-8");
        if (content.includes(CLAUDE_BLOCK_BEGIN) && content.includes(CLAUDE_BLOCK_END)) {
          return { state: "has-block", error: null };
        }
        return { state: "no-block", error: null };
      } catch (err) {
        return { state: "error", error: err.message };
      }
    }

    let claudeMdResult = detectClaudeMdBlock();
    let claudeMdFixed = false;
    if (claudeMdResult.state === "has-block" && fix) {
      if (removeManagedBlock(claudeMdPath) === "removed") {
        claudeMdFixed = true;
        claudeMdResult = detectClaudeMdBlock();
      }
    }

    if (claudeMdResult.state === "error") {
      fail("CLAUDE.md legacy block", `Cannot read CLAUDE.md: ${claudeMdResult.error}`);
    } else if (claudeMdResult.state === "no-file") {
      pass(
        "CLAUDE.md legacy block",
        "no CLAUDE.md found — session context comes from the SessionStart hook",
      );
    } else if (claudeMdResult.state === "no-block") {
      if (claudeMdFixed) {
        fixed("CLAUDE.md legacy block", `removed legacy ForgeDock block from ${claudeMdPath}`);
      } else {
        pass(
          "CLAUDE.md legacy block",
          "no legacy ForgeDock block — session context comes from the SessionStart hook",
        );
      }
    } else {
      warn(
        "CLAUDE.md legacy block",
        `legacy ForgeDock block found in ${claudeMdPath} — uninstall removes it; the SessionStart hook has replaced it.${fix ? "" : " Run: npx forgedock doctor --fix"}`,
      );
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
          let missingLabels = expectedLabels.filter(
            (l) => !existingLabels.includes(l),
          );
          let labelsFixed = false;

          if (missingLabels.length > 0 && fix) {
            console.log(
              `  ${CYAN}↻${RESET}  Bootstrapping ${missingLabels.length} missing workflow label(s) on ${forgeOwner}/${forgeRepo}...`,
            );
            try {
              await labelsSetup(`${forgeOwner}/${forgeRepo}`);
              labelsFixed = true;
              const recheckOut = execFileSync(
                "gh",
                ["label", "list", "-R", `${forgeOwner}/${forgeRepo}`, "--json", "name", "--limit", "200"],
                { stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" },
              );
              existingLabels = JSON.parse(recheckOut).map((l) => l.name);
              missingLabels = expectedLabels.filter((l) => !existingLabels.includes(l));
            } catch {
              // labelsSetup() already reports its own per-label failures to
              // stdout; leave missingLabels as computed pre-fix if the
              // recheck itself fails (e.g. transient network error).
            }
          }

          if (missingLabels.length === 0) {
            if (fix && labelsFixed) {
              fixed(
                "GitHub workflow labels",
                `all ${expectedLabels.length} workflow labels now present on ${forgeOwner}/${forgeRepo}`,
              );
            } else {
              pass(
                "GitHub workflow labels",
                `all ${expectedLabels.length} workflow labels present on ${forgeOwner}/${forgeRepo}`,
              );
            }
          } else {
            fail(
              "GitHub workflow labels",
              `Run: npx forgedock doctor --fix  (or: npx forgedock labels setup --repo ${forgeOwner}/${forgeRepo})  (see bin/labels.json for definitions; missing: ${missingLabels.join(", ")})`,
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

  // ── Check 12: GitHub App / bot token status ─────────────────────────────────
  // Informational only — never a hard failure. Installing the ForgeDock GitHub
  // App registers it against the account/org but does not, by itself, mint a
  // bot token: that requires the app's private key, which only the app owner
  // holds. Pipeline gh calls always use whatever `gh auth` context is active
  // locally (personal token unless the operator manually configured a bot
  // token) — this check exists so that state is surfaced instead of silent.
  // See docs/CONFIG.md "GitHub App Install" and forge#1890.
  {
    warn(
      "GitHub App / bot token",
      "pipeline commands use your active `gh auth` (personal token, unless you've manually configured a bot token). Installing the GitHub App alone does not create one — see docs/CONFIG.md \"GitHub App Install\".",
    );
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("");
  if (fix && fixesApplied > 0) {
    console.log(`${CYAN}${BOLD}${fixesApplied} issue(s) auto-fixed.${RESET}`);
  }
  if (failures === 0 && warnings === 0) {
    console.log(`${GREEN}${BOLD}All checks passed.${RESET} ForgeDock installation is healthy.`);
  } else if (failures === 0) {
    console.log(`${YELLOW}${BOLD}${warnings} warning(s).${RESET} Checks passed with notes above.`);
  } else {
    console.log(
      `${RED}${BOLD}${failures} check(s) failed${warnings > 0 ? `, ${warnings} warning(s)` : ""}.${RESET} See fix hints above.`,
    );
    if (!fix) {
      console.log(`  Some of these may be auto-fixable: run ${CYAN}npx forgedock doctor --fix${RESET}`);
    }
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
    ["npx forgedock install", "Install commands to ~/.claude/"],
    ["npx forgedock init", "Generate forge.yaml config for your project"],
    ["npx forgedock init --minimal", "Generate a minimal forge.yaml (required sections only)"],
    ["npx forgedock enable [dir]", "Activate ForgeDock in a directory"],
    ["npx forgedock disable [dir]", "Opt a directory out of ForgeDock"],
    ["npx forgedock status [dir]", "Show ForgeDock state for a directory"],
    ["npx forgedock run <cmd> [args]", "Run a command headlessly (local claude CLI or Anthropic API)"],
    ["npx forgedock run-issue <issue>", "Drive one issue through the durable engine"],
    ["npx forgedock resume-stalled [--dry-run]", "Fleet stall recovery — re-dispatch expired-lease issues"],
    ["npx forgedock demo", "Set up a risk-free demo repo and print next steps"],
    ["npx forgedock labels [setup] [--repo owner/repo]", "Bootstrap ForgeDock-managed labels on a GitHub repo (idempotent)"],
    ["npx forgedock config migrate [dir]", "Backfill missing optional sections into an existing forge.yaml (idempotent)"],
    ["npx forgedock watch [--repo owner/repo]", "Live per-agent orchestration view (Ctrl+C to exit)"],
    ["npx forgedock report [--days 30] [--md] [--json]", "30-day pipeline impact receipts for your repo"],
    ["npx forgedock doctor", "Check installation health"],
    ["npx forgedock doctor --fix", "Auto-fix deterministic issues (symlinks, hook, labels, legacy block)"],
    ["npx forgedock update", "Pull latest & reinstall"],
    ["npx forgedock uninstall", "Remove commands"],
    ["npx forgedock version", "Print the installed version and check for updates"],
    ["npx forgedock help", "Show this help"],
  ];
  const flagRows = [
    ["Flag", "Description"],
    ["--fast", "Skip animation/motion"],
    ["--manual", "Plain text prompts instead of the review screen (init)"],
    ["--verbose", "Show detection sources for every field (init)"],
    ["--minimal", "Generate a minimal forge.yaml with required sections only (init)"],
    ["--version, -v", "Print the installed version and check for updates"],
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
 * headlessly, outside of an interactive Claude Code session (CI or local).
 *
 * Flags:
 *   --dry-run                    Preview the assembled prompt + tool plan; no call made.
 *   --model <id>                 Override the model (see resolution order below; api backend only).
 *   --max-iterations <n>         Bound the tool-use loop (default: 50; api backend only).
 *   --backend <cli|api|auto>     Execution backend (see below; default: auto).
 *
 * Two execution backends (issue #2003):
 *   - "cli": shells out to the local Claude Code CLI (`claude --print ...`),
 *     reusing whatever credentials it already has (Pro/Max OAuth or a
 *     CLI-managed key). No ANTHROPIC_API_KEY needed. Requires `claude` on PATH.
 *   - "api": drives the Anthropic SDK directly. Requires ANTHROPIC_API_KEY and
 *     the optional @anthropic-ai/sdk dependency. Needed for CI/headless
 *     environments without an interactively-authenticated `claude` CLI.
 *   - "auto" (default): prefers "cli" when a working `claude` install is
 *     detected, otherwise falls back to "api" unchanged — existing callers
 *     that never pass --backend see no behavior change when `claude` isn't
 *     installed.
 *
 * The runtime itself lives in bin/runner.mjs.
 *
 * Model resolution order (highest precedence first; api backend only — the
 * cli backend uses whatever model the `claude` CLI itself is configured for):
 *   1. --model <id>                        This flag.
 *   2. $FORGEDOCK_MODEL                    Env var, below.
 *   3. forge.yaml `agents.default_model`   Read from the run's cwd, if present.
 *   4. Hardcoded default                   "claude-sonnet-5" (bin/runner.mjs DEFAULT_MODEL).
 *
 * Env:
 *   FORGEDOCK_BACKEND      Default backend ("cli"|"api"|"auto") when --backend is omitted.
 *   FORGEDOCK_MODEL        Default model id when --model is omitted.
 *   FORGEDOCK_CLI_TIMEOUT_MS  Wall-clock timeout (ms) for the cli backend invocation.
 *   FORGEDOCK_SHELL        Override the shell used by run_bash / the cli backend.
 *                          Defaults to bash when found (Git Bash / WSL on
 *                          Windows, /bin/bash on POSIX), falling back to the
 *                          platform default shell otherwise.
 */
async function run() {
  const runArgs = restArgs;
  let dryRun = false;
  let model;
  let maxIterations;
  let backend;
  const positional = [];
  // Consume the value for a `--flag <value>` pair at index `idx` (the flag
  // itself). Errors loudly instead of silently returning `undefined` when
  // the flag is the last token or is immediately followed by another flag —
  // both cases previously left the corresponding variable `undefined`,
  // which downstream validation treats identically to "flag omitted",
  // silently falling back to the default instead of erroring. Returns the
  // consumed value; the caller is responsible for advancing its own loop
  // index past the consumed token.
  const requireFlagValue = (flagName, idx) => {
    const value = runArgs[idx + 1];
    if (value === undefined || value.startsWith("--")) {
      process.stderr.write(
        `${RED}Missing value for ${flagName}. Usage: ${flagName} <value>${RESET}\n`,
      );
      process.exit(1);
    }
    return value;
  };
  for (let i = 0; i < runArgs.length; i++) {
    const a = runArgs[i];
    if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--model") {
      model = requireFlagValue("--model", i);
      i++;
    } else if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
    } else if (a === "--max-iterations") {
      maxIterations = parseInt(requireFlagValue("--max-iterations", i), 10);
      i++;
    } else if (a.startsWith("--max-iterations=")) {
      maxIterations = parseInt(a.slice("--max-iterations=".length), 10);
    } else if (a === "--backend") {
      backend = requireFlagValue("--backend", i);
      i++;
    } else if (a.startsWith("--backend=")) {
      backend = a.slice("--backend=".length);
    } else {
      positional.push(a);
    }
  }

  const commandName = positional[0];
  const commandArgs = positional.slice(1);

  if (!commandName) {
    process.stderr.write(
      `${RED}Usage: forgedock run <command> [args...] [--dry-run] [--model <id>] [--max-iterations <n>] [--backend <cli|api|auto>]${RESET}\n`,
    );
    process.exit(1);
  }

  // VALID_BACKENDS is imported from bin/runner.mjs (not re-hardcoded here) so
  // this CLI-layer flag check and runner.mjs's own library-layer
  // resolveBackend() validation can never structurally diverge on the set of
  // accepted values or the wording of the resulting error message (issue
  // #2013 — the two were previously independently-hardcoded Sets with
  // near-identical but not-quite-matching error text).
  const { runCommand, VALID_BACKENDS } = await import("./runner.mjs");
  if (backend !== undefined && !VALID_BACKENDS.has(backend)) {
    process.stderr.write(
      `${RED}Invalid --backend "${backend}". Must be one of: ${[...VALID_BACKENDS].join(", ")}.${RESET}\n`,
    );
    process.exit(1);
  }

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
      ...(backend ? { backend } : {}),
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

/**
 * `forgedock watch` — live per-agent orchestration view
 *
 * Polls GitHub every 5 seconds for in-flight issues (those carrying any
 * label in the workflow-prefixed / needs-human family, derived from
 * bin/labels.json — see deriveWorkflowLabels() in bin/watch-utils.mjs,
 * forge#2235) and renders
 * a per-agent table with issue#, title, phase, elapsed time, and staleness
 * status. All data is sourced from FORGE:HEARTBEAT comments written by the
 * pipeline at each phase boundary.
 *
 * A second, independent "Findings" lane renders review-finding issues
 * regardless of workflow:* state (forge#2235) — a finding is born without
 * any workflow:* label and may never acquire one (deferred findings), so it
 * must not depend on the in-flight label set to be visible. Findings render
 * with a distinct queued/deferred/validated status, never "running".
 *
 * Stalled agents (no HEARTBEAT update within pipeline.stall_timeout_minutes)
 * are highlighted in yellow.
 *
 * If `forge.yaml` defines `repos.satellites`, each satellite repo is watched
 * in its own section in addition to the default/`--repo` repo.
 *
 * Run:  npx forgedock watch [--repo owner/repo]
 * Exit: Ctrl+C
 */
async function watch() {
  const POLL_INTERVAL_MS = 5000;
  const USE_ANSI_WATCH = process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const ISSUE_LIST_LIMIT = 500; // forge#2235 — was 30; matches phase-1-resolve.md's --limit 500 mandate
  const HEARTBEAT_BATCH_CHUNK_SIZE = 25; // keep GraphQL query size/complexity bounded

  // ── Resolve repo(s) ────────────────────────────────────────────────────────
  const explicitRepoFlag = restArgs.includes("--repo");
  const watchRepo = resolveLabelsRepo(restArgs);
  if (!watchRepo) {
    process.stderr.write(
      `${RED}No repository found.${RESET}\n` +
      `  Run from a directory with ${cyan("forge.yaml")}, or pass ${cyan("--repo owner/repo")}.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Satellite repos (forge.yaml → repos.satellites) are watched in addition
  // to the primary repo, unless the caller explicitly overrode --repo (an
  // explicit --repo means "just this one repo"). Returns [] when no
  // satellites section is present, so single-repo behavior is unchanged.
  let satelliteRepos = [];
  if (!explicitRepoFlag) {
    const forgeYamlPathForSatellites = join(process.cwd(), "forge.yaml");
    if (existsSync(forgeYamlPathForSatellites)) {
      try {
        const raw = readFileSync(forgeYamlPathForSatellites, "utf-8");
        satelliteRepos = parseSatelliteRepos(raw).filter((r) => r !== watchRepo);
      } catch { /* ignore — stay default-repo-only */ }
    }
  }
  const watchedRepos = [watchRepo, ...satelliteRepos];

  // ── Validate gh CLI auth ───────────────────────────────────────────────────
  try {
    execSync("gh auth status", { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    process.stderr.write(
      `${RED}gh CLI is not authenticated.${RESET}\n` +
      `  Fix: run ${cyan("gh auth login")} then retry.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // ── Resolve stall timeout ─────────────────────────────────────────────────
  let stallMinutes = 15;
  const forgeYamlPath = join(process.cwd(), "forge.yaml");
  if (existsSync(forgeYamlPath)) {
    try {
      const raw = readFileSync(forgeYamlPath, "utf-8");
      const m = raw.match(/^\s*stall_timeout_minutes:\s*(\d+)/m);
      if (m) stallMinutes = parseInt(m[1], 10);
    } catch { /* ignore */ }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function extractPhase(heartbeatBody) {
    const m = heartbeatBody.match(/\*\*Phase\*\*:\s*(.+)/);
    return m ? m[1].trim() : "unknown";
  }

  function extractTimestamp(heartbeatBody) {
    const m = heartbeatBody.match(/\*\*Timestamp\*\*:\s*(\S+)/);
    return m ? m[1].trim() : null;
  }

  function elapsedMin(isoTimestamp) {
    if (!isoTimestamp) return null;
    const ms = Date.now() - new Date(isoTimestamp).getTime();
    return Math.floor(ms / 60000);
  }

  function elapsedStr(minutes) {
    if (minutes === null) return "—";
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  // ── Cleanup on exit ────────────────────────────────────────────────────────
  let intervalHandle;
  function cleanup() {
    if (intervalHandle) clearTimeout(intervalHandle);
    if (USE_ANSI_WATCH) {
      process.stdout.write("\x1b[?25h"); // show cursor
    }
    process.exit(0);
  }
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  if (USE_ANSI_WATCH) {
    process.stdout.write("\x1b[?25l"); // hide cursor
  }

  // ── Render loop ────────────────────────────────────────────────────────────
  // Derived from bin/labels.json (forge#2235) instead of a hardcoded literal,
  // so a newly-added workflow:* label (e.g. workflow:engine-error) is watched
  // automatically without a code change. Falls back to a conservative
  // built-in list if the manifest is missing/unreadable.
  const WORKFLOW_LABELS = deriveWorkflowLabels(join(__dirname, "labels.json"));

  // Batch-fetch the latest FORGE:HEARTBEAT comment for a set of issue numbers
  // in ONE `gh api graphql` round-trip (chunked) instead of one REST call per
  // issue (forge#2235 — de-N+1). Falls back to the old per-issue REST fetch
  // for the whole set on any GraphQL error, so this optimization can never
  // make watch() go blind.
  async function fetchHeartbeatsBatch(repo, issueNumbers) {
    const result = new Map();
    if (issueNumbers.length === 0) return result;
    const [owner, name] = repo.split("/");
    if (!owner || !name) return fetchHeartbeatsPerIssueFallback(repo, issueNumbers);

    try {
      for (const chunk of chunkArray(issueNumbers, HEARTBEAT_BATCH_CHUNK_SIZE)) {
        const query = buildHeartbeatBatchQuery(owner, name, chunk);
        const raw = execFileSync(
          "gh",
          ["api", "graphql", "-f", `query=${query}`],
          { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
        );
        const parsed = parseHeartbeatBatchResponse(JSON.parse(raw));
        for (const [num, body] of parsed) result.set(num, body);
      }
      return result;
    } catch {
      // GraphQL batch failed (auth scope gap, malformed query, rate limit) —
      // fall back to the pre-forge#2235 per-issue REST behavior so watch()
      // degrades gracefully instead of losing heartbeat data entirely.
      return fetchHeartbeatsPerIssueFallback(repo, issueNumbers);
    }
  }

  function fetchHeartbeatsPerIssueFallback(repo, issueNumbers) {
    const result = new Map();
    for (const num of issueNumbers) {
      try {
        const commentsJson = execFileSync(
          "gh",
          ["api", `repos/${repo}/issues/${num}/comments`,
           "--jq", "[.[] | select(.body | contains(\"FORGE:HEARTBEAT\"))] | last | .body // \"\""],
          { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim();
        if (commentsJson && commentsJson !== '""' && commentsJson !== "") {
          result.set(num, commentsJson.replace(/^"|"$/g, "").replace(/\\n/g, "\n"));
        } else {
          result.set(num, null);
        }
      } catch {
        result.set(num, null);
      }
    }
    return result;
  }

  // Renders a normalized priority for the "Pri" column, accepting both the
  // canonical `priority:P<n>` label form and the bare `P<n>` form used by
  // some consumer repos (forge#2232 / forge#2235).
  function priorityCell(issue) {
    return normalizePriority(issue.labels || []) || "—";
  }

  async function renderRepo(repo) {
    const rows = [["#", "Pri", "Title", "Phase", "Elapsed", "Status"]];
    const findingsRows = [["#", "Pri", "Title", "Status"]];
    let anyIssues = false;
    const inFlightNumbers = new Set();
    const issuesByLabel = [];

    // ── In-flight lane: one query per workflow:*/needs-human label ──────────
    for (const label of WORKFLOW_LABELS) {
      let issueJson;
      try {
        // Use execFileSync with argument array to avoid shell injection via repo
        issueJson = execFileSync(
          "gh",
          ["issue", "list", "-R", repo, "--state", "open",
           "--label", label, "--limit", String(ISSUE_LIST_LIMIT), "--json", "number,title,labels"],
          { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch {
        continue;
      }

      let issues;
      try { issues = JSON.parse(issueJson); } catch { continue; }

      if (issues.length === ISSUE_LIST_LIMIT) {
        process.stderr.write(
          `${YELLOW}WARNING: label '${label}' on ${repo} returned exactly ${ISSUE_LIST_LIMIT} issues — ` +
          `results may be truncated.${RESET}\n`,
        );
      }

      issuesByLabel.push({ label, issues });
      for (const issue of issues) inFlightNumbers.add(issue.number);
    }

    // Batch-fetch heartbeats once for every in-flight issue across all labels
    const heartbeats = await fetchHeartbeatsBatch(repo, [...inFlightNumbers]);

    for (const { label, issues } of issuesByLabel) {
      for (const issue of issues) {
        anyIssues = true;
        let phase = label.replace("workflow:", "");
        let elapsed = null;

        const body = heartbeats.get(issue.number);
        if (body) {
          phase = extractPhase(body) || phase;
          const ts = extractTimestamp(body);
          elapsed = elapsedMin(ts);
        }

        const isStalled = elapsed !== null && elapsed >= stallMinutes;
        const isBlocked = label === "needs-human";
        const status = isBlocked ? "BLOCKED" : isStalled ? "STALLED" : "running";

        const titleTrunc = issue.title.length > 38 ? issue.title.slice(0, 35) + "..." : issue.title;
        const phaseShort = phase.length > 30 ? phase.slice(0, 27) + "..." : phase;

        const statusColored = USE_ANSI_WATCH
          ? (isBlocked ? `\x1b[31m${status}\x1b[0m` : isStalled ? `\x1b[33m${status}\x1b[0m` : `\x1b[32m${status}\x1b[0m`)
          : status;

        const titleColored = USE_ANSI_WATCH && (isStalled || isBlocked)
          ? `\x1b[33m${titleTrunc}\x1b[0m`
          : titleTrunc;

        rows.push([
          `#${issue.number}`,
          priorityCell(issue),
          titleColored,
          phaseShort,
          elapsedStr(elapsed),
          statusColored,
        ]);
      }
    }

    // ── Findings lane: review-finding issues, regardless of workflow:* state ─
    // A finding is born without any workflow:* label and may never acquire
    // one (deferred/PERMANENT_DEFERRED findings) — this lane makes them
    // visible from creation instead of only during the narrow in-flight
    // window (forge#2235).
    let anyFindings = false;
    try {
      const findingsJson = execFileSync(
        "gh",
        ["issue", "list", "-R", repo, "--state", "open",
         "--label", FINDINGS_LANE_LABEL, "--limit", String(ISSUE_LIST_LIMIT), "--json", "number,title,labels"],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const findings = JSON.parse(findingsJson);
      if (findings.length === ISSUE_LIST_LIMIT) {
        process.stderr.write(
          `${YELLOW}WARNING: label '${FINDINGS_LANE_LABEL}' on ${repo} returned exactly ${ISSUE_LIST_LIMIT} issues — ` +
          `results may be truncated.${RESET}\n`,
        );
      }
      for (const issue of findings) {
        // Findings that already carry a workflow:* label are in-flight and
        // already rendered above — do not double-render them here.
        if (hasWorkflowLabel(issue.labels || [], WORKFLOW_LABELS)) continue;

        anyFindings = true;
        const findingStatus = classifyFindingStatus(issue.labels || []); // validated | false-positive | queued | deferred
        const statusDisplay = findingStatus.toUpperCase();
        const statusColored = USE_ANSI_WATCH
          ? (findingStatus === "validated" ? `\x1b[32m${statusDisplay}\x1b[0m`
             : findingStatus === "false-positive" ? `\x1b[90m${statusDisplay}\x1b[0m`
             : `\x1b[36m${statusDisplay}\x1b[0m`) // queued / deferred
          : statusDisplay;

        const titleTrunc = issue.title.length > 38 ? issue.title.slice(0, 35) + "..." : issue.title;

        findingsRows.push([
          `#${issue.number}`,
          priorityCell(issue),
          titleTrunc,
          statusColored,
        ]);
      }
    } catch { /* findings lane best-effort — never blocks the in-flight table */ }

    return { repo, rows, anyIssues, findingsRows, anyFindings };
  }

  async function render() {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
    const results = [];
    for (const repo of watchedRepos) {
      results.push(await renderRepo(repo));
    }

    if (USE_ANSI_WATCH) {
      process.stdout.write("\x1b[2J\x1b[H"); // clear screen + home
    } else {
      process.stdout.write(`\n${"─".repeat(60)}\n`);
    }

    const repoLabel = watchedRepos.length > 1 ? `${watchedRepos.length} repos` : watchRepo;
    process.stdout.write(`${BOLD}ForgeDock Watch${RESET} — ${dim(repoLabel)}  ${dim(now)}\n\n`);

    for (const { repo, rows, anyIssues, findingsRows, anyFindings } of results) {
      if (watchedRepos.length > 1) {
        process.stdout.write(`${BOLD}${repo}${RESET}\n`);
      }

      if (!anyIssues || rows.length === 1) {
        process.stdout.write(`  ${dim("No in-flight issues. All quiet.")}\n`);
      } else {
        process.stdout.write(table(rows, { header: true }));
      }

      if (anyFindings && findingsRows.length > 1) {
        process.stdout.write(`\n${BOLD}Findings${RESET} ${dim("(review-finding — queued/deferred/validated)")}\n`);
        process.stdout.write(table(findingsRows, { header: true }));
      }

      if (watchedRepos.length > 1) process.stdout.write("\n");
    }

    if (USE_ANSI_WATCH) {
      process.stdout.write(`\n${dim("Refreshing every 5s — Ctrl+C to exit")}\n`);
    }
  }

  // Self-scheduling render loop — each render awaits completion before
  // scheduling the next, preventing overlapping cycles when GitHub API
  // latency exceeds the poll interval (forge#1428). The scheduled timeout is
  // the ONLY handle keeping the event loop alive for this command — it must
  // stay ref'd, or Node exits after the first render despite printing
  // "Refreshing every Ns — Ctrl+C to exit" (forge#1593). The only intended
  // exit path is SIGINT/SIGTERM → cleanup(), which restores the cursor.
  async function scheduleRender() {
    await render();
    intervalHandle = setTimeout(scheduleRender, POLL_INTERVAL_MS);
  }
  await scheduleRender();
}

// The journey-routed commands render their own branded marks (hero/compact);
// splash() would double-brand them. Engine-surface commands, help, and
// unknown-command output keep the logo.
const SPLASH_COMMANDS = new Set(["run", "run-issue", "resume-stalled", "demo", "doctor", "watch", "help", "--help", "-h"]);
const KNOWN_COMMANDS = new Set([
  "install", "init", "enable", "disable", "status", "uninstall", "update",
  "run", "backend-check", "run-issue", "resume-stalled", "demo", "doctor", "watch", "labels", "config", "help", "--help", "-h",
  "version", "--version", "-v",
]);
if (SPLASH_COMMANDS.has(command) || !KNOWN_COMMANDS.has(command)) splash(command);

let exitCode = 0;
switch (command) {
  case "install": {
    const c = ctx();
    // Version-gated install path (#1252): detect Claude Code version and advise
    // on features available or missing. Fail-open — null version skips checks.
    if (c.claudeVersion) {
      // Gate: effort levels require v2.1.154+
      if (!hasFeature(c.breakpoints, "effort_levels", c.claudeVersion)) {
        process.stderr.write(
          `  ${YELLOW}note${RESET}  Claude Code v${c.claudeVersion} detected — effort-level frontmatter requires v2.1.154+. ` +
          `Some orchestration features will use fallback mode.\n`
        );
      }
      // Gate: tool permission rules require v2.1.178+
      if (!hasFeature(c.breakpoints, "tool_param_value_permission_rules", c.claudeVersion)) {
        process.stderr.write(
          `  ${YELLOW}note${RESET}  Claude Code v${c.claudeVersion} detected — Tool(param:value) permission rules require v2.1.178+. ` +
          `Hook-based enforcement (#1250) will not be installed.\n`
        );
      } else {
        // v2.1.178+ supports permission rules — suggest opt-in rules for pipeline safety.
        process.stderr.write(
          `  ${CYAN}tip${RESET}   Claude Code v${c.claudeVersion} supports permission rules. ` +
          `Consider adding to ~/.claude/settings.json:\n` +
          `         { "permissions": { "deny": ["Bash(git push origin main*)"] } }\n` +
          `         This prevents accidental direct pushes to main.\n`
        );
      }
    }
    if (existsSync(join(c.cwd, "forge.yaml")) && resolveState(c.cwd) === "managed-active") {
      await statusScreen(c);
    } else {
      exitCode = await runJourney(c);
      // Record persistHome()'s outcome (set on c.persistHomeResult inside
      // runJourney()) in the registry (forge#1943), mirroring update()'s npm
      // branch — a single, centrally-updated source of truth for doctor()
      // rather than each command re-deriving persisted-home state on its own
      // (forge#1589 split-brain precedent). Best-effort: a failed write here
      // must never turn a successful install into a failing one.
      if (c.persistHomeResult && !c.persistHomeResult.skipped) {
        try {
          await setPersistedHomeState({
            path: c.persistHomeResult.forgeHome,
            version: c.persistHomeResult.version,
          });
        } catch {
          // best-effort — see comment above
        }
      }
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
    await statusScreen(c);
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
  case "backend-check": {
    const { checkExecutionBackend } = await import("./runner.mjs");
    const result = checkExecutionBackend();
    if (!restArgs.includes("--quiet")) {
      process.stdout.write(`${result.ready ? "ready" : "unavailable"}: ${result.backend} (${result.reason})\n`);
    }
    if (!result.ready) exitCode = 1;
    break;
  }
  case "run-issue": {
    const { runFromCli } = await import("./engine-cli.mjs");
    try {
      const result = await runFromCli(restArgs);
      // forge#2175: make a needs-human escalation distinguishable from a
      // successful run by exit code, mirroring the resume-stalled case's
      // existing convention below (result.failed.length > 0 -> exitCode 1).
      // forge#2261: "engine-error" (the engine/tool itself broke — a fail-fast
      // CLI_BACKEND_FAILED/NO_API_KEY/NO_SDK, or an exhausted retry loop where
      // the runner never once succeeded) previously reached this same case via
      // an uncaught throw, which already set exitCode = 1 below. Now that
      // runIssue() resolves cleanly with a terminalReason instead of throwing,
      // preserve that same non-zero exit code for this reason too.
      if (result && (result.terminalReason === "needs-human" || result.terminalReason === "engine-error")) exitCode = 1;
    } catch (err) {
      process.stderr.write(`${RED}${err.message}${RESET}\n`);
      exitCode = 1;
    }
    break;
  }
  case "resume-stalled": {
    const { resumeStalledFromCli } = await import("./engine-cli.mjs");
    try {
      const result = await resumeStalledFromCli(restArgs);
      if (result && result.failed && result.failed.length > 0) exitCode = 1;
    } catch (err) {
      process.stderr.write(`${RED}${err.message}${RESET}\n`);
      exitCode = 1;
    }
    break;
  }
  case "demo":
    await demo();
    break;
  case "doctor":
    exitCode = await doctor(restArgs.includes("--fix"));
    break;
  case "report": {
    const { runReport } = await import("./report.mjs");
    await runReport(restArgs);
    break;
  }
  case "watch":
    await watch();
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
  case "config": {
    const subcommand = positional[1];
    if (subcommand === "migrate") {
      // Directory override mirrors `status [dir]` — defaults to cwd.
      const dir = positional[2] ? resolve(positional[2]) : process.cwd();
      const result = backfillForgeYaml(dir);
      if (!result.present) {
        console.log(
          `${RED}No forge.yaml found in ${dir}.${RESET}\n` +
            `  Run ${cyan("npx forgedock init")} to generate one.`,
        );
        exitCode = 1;
      } else if (result.added.length === 0) {
        console.log(
          `${GREEN}forge.yaml already has all ${result.alreadyPresent.length} optional sections.${RESET} Nothing to migrate.`,
        );
      } else {
        console.log(`${GREEN}Backfilled ${result.added.length} missing optional section(s) into forge.yaml:${RESET}`);
        for (const key of result.added) console.log(`  ${GREEN}+${RESET} ${key}`);
        console.log(`\n  Sections already present (unchanged): ${result.alreadyPresent.join(", ") || "none"}`);
        console.log(`\n  All added sections are commented out — edit forge.yaml to enable the ones you need.`);
      }
    } else {
      console.log(`${RED}Unknown config subcommand: ${subcommand ?? "(none)"}${RESET}`);
      console.log(
        `Usage: ${CYAN}npx forgedock config migrate [dir]${RESET}\n` +
          `  Backfills any of the 16 optional forge.yaml sections missing from an existing config (idempotent).`,
      );
      exitCode = 1;
    }
    break;
  }
  case "version":
  case "--version":
  case "-v": {
    // Print the local version immediately — must work offline/instantly,
    // no network dependency for the primary output (getVersion() reads
    // package.json off disk only). The latest-version check below is
    // best-effort: fetchLatestVersion() has its own 5s timeout and never
    // rejects, so a slow/offline network never blocks or fails this
    // command. Mirrors the version-check message pattern already used by
    // update() (see the npm/npx branch above).
    const localVersion = getVersion();
    console.log(`forgedock ${localVersion ? `v${localVersion}` : `${YELLOW}version unknown${RESET}`}`);

    // forge#2460 — getVersion() always reads FORGE_HOME/package.json. In a
    // git-clone install (including the npx-shadowing case where FORGE_HOME
    // resolves to whatever checkout the CLI is being run from), that's this
    // checkout's own version — not necessarily what a separate global npm
    // install elsewhere would report. Surface that ambiguity explicitly
    // rather than letting this read as "the" installed version, mirroring
    // the disambiguation messaging update() already prints (forge#2220).
    // WIRE:PROVEN — manual: every existing "version command" test in
    // bin/tests/router.test.mjs spawns this actual bin/forgedock.mjs file,
    // whose FORGE_HOME resolves to this repo's own git-clone root (a real
    // .git directory), so this guard evaluates true on every run of that
    // suite (`node --test bin/tests/router.test.mjs`, confirmed passing).
    // findSeparateGlobalInstall() itself fails closed to null on any error
    // (see its JSDoc) and is exercised by the "update — global npm install
    // self-update" suite below via the same resolveGlobalNpmForgedockDir()
    // helper it shares with isGlobalNpmInstall().
    if (existsSync(join(FORGE_HOME, ".git"))) {
      const separateGlobalInstall = findSeparateGlobalInstall();
      if (separateGlobalInstall) {
        console.log(
          `  ${YELLOW}Note: this is the git clone at ${FORGE_HOME}. Your global npm install at ${separateGlobalInstall} may report a different version.${RESET}`,
        );
      }
    }

    const latestVersion = await fetchLatestVersion();
    if (latestVersion && localVersion && compareVersions(latestVersion, localVersion) > 0) {
      console.log(
        `  ${GREEN}New version available: v${latestVersion}${RESET} (you have v${localVersion}). ` +
          `Run ${CYAN}npx forgedock update${RESET} to fetch it.`,
      );
    }

    // forge#2719 — surface package-vs-installed-commands drift (previously
    // only visible via `doctor` Check 5d). Uses the same shared helper doctor
    // calls, so both surfaces agree. Silent when versions match or when
    // either version is unknown (e.g. a git-clone dev install, which never
    // persists to ~/.forge — see registry.mjs's getInstalledCommandsDriftStatus).
    const driftStatus = getInstalledCommandsDriftStatus(FORGE_HOME);
    if (!driftStatus.unknown && driftStatus.isStale) {
      console.log(
        `  ${YELLOW}Installed commands are stale (v${driftStatus.persistedVersion}) vs package v${driftStatus.sourceVersion}${RESET} — run: ${CYAN}npx forgedock update${RESET}`,
      );
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
