#!/usr/bin/env node

import os from "os";
import { fileURLToPath } from "url";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "path";
import {
  mkdir,
  rm,
  symlink,
  copyFile,
  readlink,
  lstat,
  readdir,
  realpath,
  stat,
  writeFile,
  unlink as fsUnlink,
} from "fs/promises";
import {
  existsSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "fs";
import { execSync, execFileSync } from "child_process";
import {
  BOLD,
  GREEN,
  YELLOW,
  CYAN,
  RED,
  RESET,
  bold,
  dim,
  green,
  yellow,
  cyan,
  red,
  box,
  stepHeader,
  select,
  multiSelect,
  confirm,
  input,
  createProgressBar,
  spinner,
  annotatedReviewScreen,
} from "./tui.mjs";
import { detectConfig } from "./init-detect.mjs";
import { enrich as enrichViaAPI, parseEnrichedDraft } from "./init-enrich-api.mjs";
import { resolveState, setOptOut } from "./registry.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FORGE_HOME = dirname(__dirname);
const COMMANDS_DIR = join(FORGE_HOME, "commands");

// Resolve home directory cross-platform: HOME (POSIX), USERPROFILE (Windows), os.homedir() fallback.
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

const TARGET_DIR = join(HOME, ".claude", "commands");

const args = process.argv.slice(2);
const command = args[0];
const forceYes = args.includes("--yes") || args.includes("-y");
// --manual: bypass autopilot enrichment and run the full per-field guided wizard.
// --verbose: surface field detection sources and confidences during the init flow.
const manualMode = args.includes("--manual");
const verboseMode = args.includes("--verbose");

// ---------------------------------------------------------------------------
// Version — read dynamically from package.json
// ---------------------------------------------------------------------------

function getVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(join(FORGE_HOME, "package.json"), "utf-8"),
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ---------------------------------------------------------------------------
// Install-mode marker — written to TARGET_DIR when copy-based install is used
// (Windows standard users cannot create symlinks without Developer Mode).
// ---------------------------------------------------------------------------

/** Path to the install-mode marker file inside TARGET_DIR. */
const INSTALL_MODE_MARKER = join(TARGET_DIR, ".forgedock-install-mode");

/**
 * Read the install-mode marker, returning its parsed content or null if absent/invalid.
 * @returns {{ version: string, mode: string } | null}
 */
function readInstallModeMarker() {
  try {
    return JSON.parse(readFileSync(INSTALL_MODE_MARKER, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Write (or overwrite) the install-mode marker with the current version.
 * No-op on write failure — marker is best-effort.
 */
async function writeInstallModeMarker() {
  try {
    await writeFile(
      INSTALL_MODE_MARKER,
      JSON.stringify({ version: getVersion(), mode: "copy" }),
      "utf-8",
    );
  } catch {
    // Best-effort — do not block install on marker write failure
  }
}

/**
 * Remove the install-mode marker if it exists.
 * No-op on failure.
 */
async function removeInstallModeMarker() {
  try {
    await fsUnlink(INSTALL_MODE_MARKER);
  } catch {
    // Already absent — nothing to do
  }
}

// ---------------------------------------------------------------------------
// SessionStart hook — settings.json helpers
// ---------------------------------------------------------------------------

/**
 * Path to the user-level Claude Code settings file.
 * This is where the SessionStart hook entry is written/removed.
 */
const CLAUDE_SETTINGS_PATH = join(HOME, ".claude", "settings.json");

/**
 * The command value written into the SessionStart hook entry.
 * Identifies the hook by a path suffix so it can be found even if
 * FORGE_HOME changes between install and uninstall runs.
 */
function sessionStartHookCommand() {
  return `node "${join(FORGE_HOME, "bin", "hooks", "session-start.mjs")}"`;
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
 * Read ~/.claude/settings.json, returning a parsed object.
 * Returns an empty object if the file does not exist.
 * Throws if the file exists but cannot be parsed.
 *
 * @returns {object}
 */
function readClaudeSettings() {
  try {
    const raw = readFileSync(CLAUDE_SETTINGS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Atomically write an object to ~/.claude/settings.json.
 * Uses a .tmp sibling + renameSync to avoid partial writes.
 *
 * @param {object} settings
 */
function writeClaudeSettings(settings) {
  const tmpPath = CLAUDE_SETTINGS_PATH + ".forgedock.tmp";
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, CLAUDE_SETTINGS_PATH);
}

/**
 * Install the ForgeDock SessionStart hook into ~/.claude/settings.json
 * idempotently. Does not modify any existing hooks unrelated to ForgeDock.
 *
 * Returns:
 *   'installed'      — hook was newly added
 *   'already-present' — hook was already there (idempotent)
 *   'failed'         — an error occurred (non-fatal; install continues)
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

    const command = sessionStartHookCommand();

    // Check if already present (idempotent — match by path suffix)
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

    // Append the new hook entry
    settings.hooks.SessionStart.push({
      hooks: [
        {
          type: "command",
          command,
          timeout: 10,
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
 *   'removed'        — hook was found and removed
 *   'not-present'    — hook was not in settings.json (already clean)
 *   'failed'         — an error occurred (non-fatal; uninstall continues)
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
    settings.hooks.SessionStart = settings.hooks.SessionStart.filter((entry) => {
      if (!entry || typeof entry !== "object") return true;
      const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
      const isForgeEntry = hooks.some(
        (h) =>
          h &&
          typeof h.command === "string" &&
          isForgeSessionStartHook(h.command),
      );
      return !isForgeEntry;
    });

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
// Install state detection
// ---------------------------------------------------------------------------

/**
 * @typedef {'fresh-install' | 'up-to-date' | 'update-available' | 'config-missing' | 'version-unknown'} InstallState
 *
 * @typedef {Object} InstallDetectionResult
 * @property {InstallState} state
 * @property {string | null} installedVersion  - Version read from existing symlink target, or null
 * @property {string} currentVersion           - Version from the running package.json
 */

/**
 * Detect whether ForgeDock has been installed before and, if so, compare versions.
 *
 * Algorithm:
 *   1. Check if TARGET_DIR exists and has at least one ForgeDock-managed symlink.
 *   2. If symlinks exist, walk the symlink target to find the installed package.json
 *      and read its version.
 *   3. Compare installed version vs. current (running) version.
 *   4. If commands are installed but forge.yaml is absent → 'config-missing'.
 *
 * Always returns a safe result — never throws.
 *
 * @returns {Promise<InstallDetectionResult>}
 */
async function detectInstallState() {
  const currentVersion = getVersion();

  // Safely probe TARGET_DIR for ForgeDock-managed symlinks
  let installedVersion = null;
  let hasSymlinks = false;

  try {
    const entries = await readdir(TARGET_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.endsWith(".md") && !entry.isDirectory()) continue;

      const targetPath = join(TARGET_DIR, entry.name);
      try {
        const stats = await lstat(targetPath);
        if (stats.isSymbolicLink()) {
          const linkTarget = await readlink(targetPath);
          // Only count symlinks that point into a ForgeDock commands directory
          if (linkTarget.includes("commands") && linkTarget.endsWith(".md")) {
            hasSymlinks = true;
            // Derive the FORGE_HOME of the installed copy:
            //   linkTarget: /path/to/forge-home/commands/work-on.md
            //   dirname twice → /path/to/forge-home
            const installedForgeHome = dirname(dirname(linkTarget));
            const pkgPath = join(installedForgeHome, "package.json");
            try {
              const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
              installedVersion = pkg.version || null;
            } catch {
              // package.json missing or malformed — treat as version unknown
            }
            break; // One symlink is enough to establish install status
          }
        }
      } catch {
        // lstat/readlink failed — skip this entry
      }
    }
  } catch {
    // TARGET_DIR doesn't exist — definitively a fresh install
    return { state: "fresh-install", installedVersion: null, currentVersion };
  }

  if (!hasSymlinks) {
    // Check for copy-mode install (Windows: symlinks not available)
    const marker = readInstallModeMarker();
    if (marker) {
      installedVersion = marker.version ?? null;
    } else {
      return { state: "fresh-install", installedVersion: null, currentVersion };
    }
  }

  // Commands are installed — now determine sub-state
  const forgeYamlPath = join(process.cwd(), "forge.yaml");
  const hasConfig = existsSync(forgeYamlPath);

  if (!hasConfig) {
    return { state: "config-missing", installedVersion, currentVersion };
  }

  // Commands and config are present — but version may be unreadable
  if (installedVersion === null) {
    // package.json was missing or malformed — cannot determine installed version.
    // Return a distinct state so the caller can inform the user and offer a resolution
    // path (reinstall), rather than silently claiming "up to date".
    return { state: "version-unknown", installedVersion: null, currentVersion };
  }

  // Both versions known — compare them
  if (installedVersion !== currentVersion) {
    return { state: "update-available", installedVersion, currentVersion };
  }

  return { state: "up-to-date", installedVersion, currentVersion };
}

// ---------------------------------------------------------------------------
// Splash screen — ASCII art logo in a Unicode box
// ---------------------------------------------------------------------------

const LOGO_LINES = [
  `${bold(cyan("  ╔═╗╔═╗╦═╗╔═╗╔═╗╔╦╗╔═╗╔═╗╦╔═"))}`,
  `${bold(cyan("  ╠╣ ║ ║╠╦╝║ ╦║╣  ║║║ ║║  ╠╩╗"))}`,
  `${bold(cyan("  ╚  ╚═╝╩╚═╚═╝╚═╝═╩╝╚═╝╚═╝╩ ╩"))}`,
];

function splash() {
  const version = getVersion();
  const tagline = dim("GitHub as a knowledge graph for AI agents");
  const versionLine = dim(`v${version}`);

  const content = [
    "",
    ...LOGO_LINES,
    "",
    `  ${tagline}`,
    `  ${versionLine}`,
    "",
  ];

  process.stdout.write("\n" + box(content, { padding: 2 }) + "\n");
}

// ---------------------------------------------------------------------------
// Step Orchestrator — manages a sequence of named steps
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Step
 * @property {string} name           - Display name for the step
 * @property {() => Promise<void>} run - Async function to execute
 * @property {boolean} [optional]    - If true, failure offers skip option
 */

class StepOrchestrator {
  /**
   * @param {Step[]} steps
   */
  constructor(steps) {
    /** @type {Array<Step & { status: string }>} */
    this.steps = steps.map((s) => ({ ...s, status: "pending" }));
    this.currentIndex = 0;
    this._aborted = false;

    // SIGINT: clean exit — restore cursor, show final state
    this._sigintHandler = () => {
      this._aborted = true;
      // Mark current step as failed if it was active
      if (this.currentIndex < this.steps.length) {
        this.steps[this.currentIndex].status = "failed";
      }
      this._renderSteps();
      process.stdout.write("\n");
      console.log(`${red("Aborted")} — exiting cleanly.`);
      // Show cursor
      if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
      // Restore terminal to cooked mode in case a select/multiSelect prompt was active
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
      }
      process.exit(130);
    };
  }

  /**
   * Render the current step list to stdout.
   */
  _renderSteps() {
    const total = this.steps.length;
    console.log("");
    for (let i = 0; i < total; i++) {
      const step = this.steps[i];
      console.log("  " + stepHeader(i + 1, total, step.name, step.status));
    }
    console.log("");
  }

  /**
   * Execute all steps in sequence.
   * @returns {Promise<boolean>} true if all steps completed (or were skipped), false if aborted
   */
  async run() {
    process.on("SIGINT", this._sigintHandler);

    try {
      this._renderSteps();

      while (this.currentIndex < this.steps.length) {
        if (this._aborted) return false;

        const step = this.steps[this.currentIndex];
        step.status = "active";
        this._renderSteps();

        try {
          await step.run();
          step.status = "done";
        } catch (err) {
          step.status = "failed";
          this._renderSteps();

          const handled = await this._handleFailure(step, err);
          if (!handled) {
            // Abort
            this._aborted = true;
            return false;
          }
          // Handled (retried successfully or skipped) — advance normally
        }

        this.currentIndex++;
      }

      // All done
      this._renderSteps();
      return true;
    } finally {
      process.removeListener("SIGINT", this._sigintHandler);
    }
  }

  /**
   * Handle a step failure: offer retry/skip/abort.
   * @returns {Promise<boolean>} true if recovered (retry succeeded or skipped), false if abort
   */
  async _handleFailure(step, err) {
    console.log(`  ${red("Error")}: ${err.message || String(err)}`);
    console.log("");

    // Non-TTY: no interactive recovery — abort
    if (!process.stdin.isTTY) {
      console.log("  Non-interactive environment — aborting.");
      return false;
    }

    const choices = [{ label: "Retry", value: "retry" }];
    if (step.optional) {
      choices.push({ label: "Skip this step", value: "skip" });
    }
    choices.push({ label: "Abort", value: "abort" });

    const action = await select("What would you like to do?", choices);

    if (action === "retry") {
      // Re-run the step
      step.status = "active";
      this._renderSteps();
      try {
        await step.run();
        step.status = "done";
        return true;
      } catch (retryErr) {
        step.status = "failed";
        return this._handleFailure(step, retryErr);
      }
    } else if (action === "skip") {
      step.status = "skipped";
      return true;
    } else {
      // abort
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Prerequisites (unchanged logic, extracted for reuse)
// ---------------------------------------------------------------------------

function checkPrerequisites() {
  const issues = [];
  const warnings = [];

  // Check gh CLI
  try {
    execSync("gh --version", { stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    issues.push(
      `${RED}✗${RESET} GitHub CLI (gh) is not installed.\n` +
        `    Install: ${CYAN}https://cli.github.com${RESET}`,
    );
  }

  // Check gh auth (only if gh is installed)
  if (issues.length === 0) {
    try {
      execSync("gh auth status", { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      issues.push(
        `${RED}✗${RESET} GitHub CLI is not authenticated.\n` +
          `    Run: ${CYAN}gh auth login${RESET}`,
      );
    }
  }

  // Check Claude Code
  try {
    execSync("claude --version", { stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    warnings.push(
      `${YELLOW}!${RESET} Claude Code CLI not found on PATH.\n` +
        `    Install: ${CYAN}https://docs.anthropic.com/en/docs/claude-code${RESET}`,
    );
  }

  // Check Node version
  const nodeVersion = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeVersion < 18) {
    issues.push(
      `${RED}✗${RESET} Node.js >= 18 required (found ${process.versions.node}).\n` +
        `    Update: ${CYAN}https://nodejs.org${RESET}`,
    );
  }

  if (issues.length > 0 || warnings.length > 0) {
    console.log(`${BOLD}Preflight checks${RESET}`);
    console.log("");
    for (const issue of issues) console.log(`  ${issue}`);
    for (const warning of warnings) console.log(`  ${warning}`);
    console.log("");
  }

  if (issues.length > 0) {
    console.log(
      `${RED}${BOLD}Blocking issues found.${RESET} ForgeDock requires the GitHub CLI ` +
        `with authentication to function.\nResolve the issues above, then re-run the command.\n`,
    );
    process.exit(1);
  }

  // Warnings are non-blocking — continue with install
  return warnings.length === 0;
}

// ---------------------------------------------------------------------------
// Interactive prerequisite checklist (TUI flow)
// ---------------------------------------------------------------------------

/**
 * Run the interactive prerequisite checklist with live spinner rendering.
 *
 * Each check runs individually with a spinner that resolves to ✓, ✗, or ⚠.
 * Blocking checks (gh CLI, gh auth, Node.js) throw on failure, stopping the
 * StepOrchestrator step. Warning checks (git, Claude Code) emit ⚠ but do NOT throw.
 *
 * @returns {Promise<void>}
 */
async function runPrerequisiteChecklist() {
  // ── 1. GitHub CLI ──────────────────────────────────────────────────────────
  {
    const s = spinner("Checking GitHub CLI…");
    try {
      const out = execSync("gh --version", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const match = out.match(/gh version (\d+\.\d+\.\d+)/);
      const version = match ? `v${match[1]}` : "installed";
      s.stop("success", `${green("[✓]")} GitHub CLI          ${dim(version)}`);
    } catch {
      s.stop(
        "fail",
        `${red("[✗]")} GitHub CLI          not found — install: ${cyan("https://cli.github.com")}`,
      );
      throw new Error(
        "GitHub CLI (gh) is required. Install it from https://cli.github.com",
      );
    }
  }

  // ── 2. GitHub Auth ─────────────────────────────────────────────────────────
  {
    const s = spinner("Checking GitHub Auth…");
    try {
      // gh auth status writes to stderr; capture it via the error path too
      let combined = "";
      try {
        combined = execSync("gh auth status", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        combined = (err.stderr || "") + (err.stdout || "");
        if (!/Logged in/.test(combined)) {
          throw err;
        }
      }
      // Parse "Logged in to github.com account USERNAME (keyring|oauth)" from stderr
      const userMatch = combined.match(/account\s+(\S+)/);
      const username = userMatch ? `@${userMatch[1]}` : "authenticated";
      // Try to get primary org from gh api
      let orgLabel = "";
      try {
        const orgsJson = execFileSync(
          "gh",
          ["api", "/user/orgs", "--jq", ".[0].login"],
          {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          },
        ).trim();
        if (orgsJson && orgsJson !== "null" && orgsJson !== "") {
          orgLabel = ` (${orgsJson})`;
        }
      } catch {
        // Org lookup is best-effort — not required
      }
      s.stop(
        "success",
        `${green("[✓]")} GitHub Auth         ${dim(`logged in as ${username}${orgLabel}`)}`,
      );
    } catch {
      s.stop(
        "fail",
        `${red("[✗]")} GitHub Auth         not authenticated — run: ${cyan("gh auth login")}`,
      );
      throw new Error("GitHub CLI is not authenticated. Run: gh auth login");
    }
  }

  // ── 3. Node.js ─────────────────────────────────────────────────────────────
  {
    const s = spinner("Checking Node.js…");
    const nodeVersion = process.versions.node;
    const nodeMajor = parseInt(nodeVersion.split(".")[0], 10);
    if (nodeMajor < 18) {
      s.stop(
        "fail",
        `${red("[✗]")} Node.js             v${nodeVersion} (>= 18 required) — update: ${cyan("https://nodejs.org")}`,
      );
      throw new Error(
        `Node.js >= 18 required (found v${nodeVersion}). Update at https://nodejs.org`,
      );
    }
    s.stop(
      "success",
      `${green("[✓]")} Node.js             ${dim(`v${nodeVersion} (>= 18 required)`)}`,
    );
  }

  // ── 4. Git ─────────────────────────────────────────────────────────────────
  {
    const s = spinner("Checking Git…");
    try {
      const out = execSync("git --version", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const match = out.match(/git version (\d+\.\d+\.\d+)/);
      const version = match ? `v${match[1]}` : "installed";
      s.stop("success", `${green("[✓]")} Git                 ${dim(version)}`);
    } catch {
      s.stop(
        "warn",
        `${yellow("[!]")} Git                 not found — install: ${cyan("https://git-scm.com")}`,
      );
      // Git is a warning — do NOT throw
    }
  }

  // ── 5. Claude Code ─────────────────────────────────────────────────────────
  {
    const s = spinner("Checking Claude Code…");
    try {
      const out = execSync("claude --version", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const match = out.trim().match(/(\d+\.\d+\.\d+)/);
      const version = match ? `v${match[1]}` : "installed";
      s.stop("success", `${green("[✓]")} Claude Code         ${dim(version)}`);
    } catch {
      s.stop(
        "warn",
        `${yellow("[!]")} Claude Code         not found — install: ${cyan("https://docs.anthropic.com/en/docs/claude-code")}`,
      );
      // Claude Code is a warning — do NOT throw
    }
  }
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

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
// Command category mapping
// ---------------------------------------------------------------------------

/**
 * Maps command name stems (filename without .md extension, no path prefix)
 * to display categories. Sub-commands (e.g. work-on/build/architect) are
 * looked up by their stem — unmapped names fall into "Other".
 */
const COMMAND_CATEGORIES = {
  // Pipeline — core orchestration commands
  "work-on": "Pipeline",
  investigate: "Pipeline",
  build: "Pipeline",
  architect: "Pipeline",
  context: "Pipeline",
  implement: "Pipeline",
  review: "Pipeline",
  decompose: "Pipeline",
  close: "Pipeline",
  "review-pr": "Pipeline",
  "review-pr-agents": "Pipeline",
  "review-pr-staging": "Pipeline",
  orchestrate: "Pipeline",
  issue: "Pipeline",
  milestone: "Pipeline",
  "quality-gate": "Pipeline",
  "work-on-monolithic": "Pipeline",

  // Operations — ongoing automation and monitoring
  autopilot: "Operations",
  analytics: "Operations",
  "geo-audit": "Operations",
  "security-audit": "Operations",
  "pipeline-health": "Operations",
  audit: "Operations",
  "audit-agents": "Operations",
  "qa-sweep": "Operations",
  "forge-stats": "Operations",
  "sync-ecosystem": "Operations",

  // Incident — response and recovery
  "incident-response": "Incident",
  rollback: "Incident",
  "deploy-info": "Incident",
  "failure-recon": "Incident",

  // Ecosystem — project management utilities
  validate: "Ecosystem",
  cleanup: "Ecosystem",

  // Setup — initial configuration
  "forgedock-init": "Setup",
};

/** Canonical display order for categories. */
const CATEGORY_ORDER = [
  "Pipeline",
  "Operations",
  "Incident",
  "Ecosystem",
  "Setup",
  "Other",
];

// ---------------------------------------------------------------------------
// Legacy commands (install, uninstall, update, init, help)
// ---------------------------------------------------------------------------

async function install() {
  checkPrerequisites();

  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — Installing pipeline commands`);
  console.log(`  Source: ${dim(COMMANDS_DIR + "/")}`);
  console.log(`  Target: ${dim(TARGET_DIR + "/")}`);
  console.log("");

  await mkdir(TARGET_DIR, { recursive: true });

  const files = await findMarkdownFiles(COMMANDS_DIR);
  let installed = 0;
  let updated = 0;
  let skipped = 0;
  /** Number of files installed via copyFile fallback (Windows: symlinks unavailable). */
  let copied = 0;

  /** @type {Array<{rel: string, action: 'installed'|'updated'|'skipped'|'conflict'|'copied'}>} */
  const results = [];
  /** @type {string[]} Relative paths of files that could not be symlinked (regular file conflict) */
  const conflicts = [];

  // -------------------------------------------------------------------------
  // Phase 1: Symlink loop with live progress bar
  // -------------------------------------------------------------------------

  const bar = createProgressBar(files.length, {
    label: "  Installing commands...",
  });

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
          results.push({ rel, action: "skipped" });
          bar.tick(1, dim(rel));
        } else {
          try {
            await symlink(file, target + ".tmp");
            const { rename } = await import("fs/promises");
            await rename(target + ".tmp", target);
            updated++;
            results.push({ rel, action: "updated" });
            bar.tick(1, rel);
          } catch (symlinkErr) {
            if (symlinkErr.code === "EPERM" || symlinkErr.code === "ENOTSUP") {
              // Symlink not permitted (Windows standard user) — fall back to copy
              await copyFile(file, target);
              copied++;
              results.push({ rel, action: "copied" });
              bar.tick(1, rel);
            } else {
              throw symlinkErr;
            }
          }
        }
      } else {
        // Regular file present — could be a previous copy-mode install or a user conflict.
        // Distinguish: if the install-mode marker exists, treat as ForgeDock-managed copy.
        const isCopyModeInstall = readInstallModeMarker() !== null;
        if (isCopyModeInstall) {
          // Re-copy to update the file
          await copyFile(file, target);
          copied++;
          results.push({ rel, action: "copied" });
          bar.tick(1, rel);
        } else {
          // User-owned regular file is blocking — record as conflict
          skipped++;
          conflicts.push(rel);
          results.push({ rel, action: "conflict" });
          bar.tick(1, rel);
        }
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        // Target doesn't exist — try symlink, fall back to copy on EPERM/ENOTSUP
        try {
          await symlink(file, target);
          installed++;
          results.push({ rel, action: "installed" });
          bar.tick(1, rel);
        } catch (symlinkErr) {
          if (symlinkErr.code === "EPERM" || symlinkErr.code === "ENOTSUP") {
            // Symlink not permitted (Windows standard user) — fall back to copy
            await copyFile(file, target);
            copied++;
            results.push({ rel, action: "copied" });
            bar.tick(1, rel);
          } else {
            throw symlinkErr;
          }
        }
      } else {
        throw err;
      }
    }
  }

  // If any files were installed via copy, write the install-mode marker so that
  // subsequent runs (detectInstallState, getInstalledCommandNames, uninstall) know
  // that regular .md files in TARGET_DIR are ForgeDock-managed.
  if (copied > 0) {
    await writeInstallModeMarker();
  }

  // totalInstalled: fresh installs + copy-mode installs. Updated separately — mirrors
  // pre-existing behaviour where only `installed > 0` (not updates) triggers this branch.
  const totalInstalled = installed + copied;
  const totalLabel =
    totalInstalled > 0
      ? `${green("✔")} Installed ${totalInstalled + updated}/${files.length} commands`
      : updated > 0
        ? `${green("✔")} Updated ${updated} command${updated === 1 ? "" : "s"}`
        : `${dim("✔")} Commands up to date (${skipped} skipped)`;
  bar.done(totalLabel);

  // -------------------------------------------------------------------------
  // Phase 2: Category grouping summary
  // -------------------------------------------------------------------------

  // Group installed/updated commands by category
  /** @type {Map<string, string[]>} category → command stems */
  const categoryMap = new Map(CATEGORY_ORDER.map((c) => [c, []]));

  for (const { rel, action } of results) {
    if (action === "skipped" || action === "conflict") continue;
    const stem = rel.replace(/\.md$/, "").split("/").pop() ?? rel;
    // 'copied' actions are treated the same as 'installed' for category display
    const category = COMMAND_CATEGORIES[stem] ?? "Other";
    const bucket = categoryMap.get(category) ?? categoryMap.get("Other") ?? [];
    if (!categoryMap.has(category)) categoryMap.set(category, bucket);
    bucket.push(stem);
  }

  // Build category lines — only show categories with at least one command
  const categoryLines = [];
  for (const cat of CATEGORY_ORDER) {
    const cmds = categoryMap.get(cat) ?? [];
    if (cmds.length === 0) continue;
    const label = cat.padEnd(12);
    const cmdList = cmds.join(", ");
    const count = `(${cmds.length})`;
    categoryLines.push(`  ${bold(cyan(label))}  ${cmdList}  ${dim(count)}`);
  }

  if (categoryLines.length > 0) {
    console.log("");
    process.stdout.write(
      box(["", ...categoryLines, ""], { title: "Commands installed" }),
    );
  }

  // -------------------------------------------------------------------------
  // Phase 3: Summary box — total counts
  // -------------------------------------------------------------------------

  const summaryLines = [
    "",
    `  ${green("Installed")}  ${bold(String(installed))}`,
    `  ${yellow("Updated")}    ${bold(String(updated))}`,
    `  ${dim("Skipped")}    ${dim(String(skipped - conflicts.length))}`,
    "",
  ];
  if (copied > 0) {
    summaryLines.splice(
      summaryLines.length - 1,
      0,
      `  ${cyan("Copied")}     ${bold(String(copied))}  ${dim("(symlinks unavailable — files copied instead)")}`,
    );
  }
  process.stdout.write(box(summaryLines, { title: "Summary" }));

  // -------------------------------------------------------------------------
  // Phase 4: Conflict highlighting (prominent red block)
  // -------------------------------------------------------------------------

  if (conflicts.length > 0) {
    console.log("");
    const conflictLines = [
      "",
      `  ${bold(red("⚠  Regular files blocking symlink creation:"))}`,
      "",
      ...conflicts.map((c) => `    ${red("✖")}  ${c}`),
      "",
      `  ${dim("To let ForgeDock manage these, remove or rename each file:")}`,
      ...conflicts.map((c) => `    ${dim(`rm ~/.claude/commands/${c}`)}`),
      "",
    ];
    process.stdout.write(
      box(conflictLines, {
        title: `${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Phase 5: FORGE_HOME setup — distinct status line
  // -------------------------------------------------------------------------

  console.log("");
  let forgeHomeSet = false;
  for (const profile of [join(HOME, ".bashrc"), join(HOME, ".zshrc")]) {
    if (existsSync(profile)) {
      const content = readFileSync(profile, "utf-8");
      if (!content.includes("FORGE_HOME")) {
        appendFileSync(
          profile,
          `\n# ForgeDock — autonomous development pipeline\nexport FORGE_HOME="${FORGE_HOME}"\n`,
        );
        const profileShort = profile.replace(HOME, "~");
        console.log(
          `  ${green("✔")}  ${bold("FORGE_HOME")} set in ${cyan(profileShort)}`,
        );
        forgeHomeSet = true;
      }
    }
  }

  if (!forgeHomeSet) {
    console.log(
      `  ${dim("✔")}  ${dim("FORGE_HOME already set in shell profile")}`,
    );
  }

  console.log("");
  console.log(
    `${green("ForgeDock commands are now available as slash commands in any Claude Code session.")}`,
  );
  console.log("");

  // -------------------------------------------------------------------------
  // Phase 6: SessionStart hook — install into ~/.claude/settings.json
  // -------------------------------------------------------------------------

  const hookResult = await installSessionStartHook();
  if (hookResult === "installed") {
    console.log(
      `  ${green("✔")}  ${bold("SessionStart hook")} installed in ${cyan("~/.claude/settings.json")}`,
    );
  } else if (hookResult === "already-present") {
    console.log(
      `  ${dim("✔")}  ${dim("SessionStart hook already present in ~/.claude/settings.json")}`,
    );
  } else {
    // "failed" — warning only, does not block install
    console.log(
      `  ${yellow("⚠")}  ${yellow("Could not write SessionStart hook to ~/.claude/settings.json")}`,
    );
    console.log(
      `  ${dim("  Run")} ${cyan("npx forgedock install")} ${dim("again to retry.")}`,
    );
  }

  console.log("");

  // forge.yaml advisory — guide users to run init if config is missing
  const forgeYamlPath = join(process.cwd(), "forge.yaml");
  if (!existsSync(forgeYamlPath)) {
    console.log(`${yellow("No forge.yaml found in current directory.")}`);
    console.log(
      `  Run ${cyan("npx forgedock init")} in your project root to generate forge.yaml`,
    );
    console.log("");
  }

  return { installed, updated, skipped, copied };
}

async function uninstall() {
  const { unlink } = await import("fs/promises");

  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — Uninstall`);
  console.log("");

  // -------------------------------------------------------------------------
  // Phase 1: Dry-run scan — compute what would be removed
  // -------------------------------------------------------------------------

  const files = await findMarkdownFiles(COMMANDS_DIR);
  /** @type {Array<{file: string, rel: string, target: string}>} */
  const toRemove = [];
  const copyMode = readInstallModeMarker() !== null;

  for (const file of files) {
    const rel = relative(COMMANDS_DIR, file);
    const target = join(TARGET_DIR, rel);
    try {
      const stats = await lstat(target);
      if (stats.isSymbolicLink()) {
        const current = await readlink(target);
        if (current === file) {
          toRemove.push({ file, rel, target });
        }
      } else if (copyMode && rel.endsWith(".md")) {
        // Copy-mode install — regular files managed by ForgeDock
        toRemove.push({ file, rel, target });
      }
    } catch {
      // Target doesn't exist — nothing to remove
    }
  }

  // Scan shell profiles for FORGE_HOME block
  const FORGE_HOME_MARKER = "# ForgeDock — autonomous development pipeline";
  const shellProfiles = [join(HOME, ".bashrc"), join(HOME, ".zshrc")];
  /** @type {string[]} Profiles that contain the FORGE_HOME block */
  const profilesWithForgeHome = shellProfiles.filter((p) => {
    if (!existsSync(p)) return false;
    try {
      return readFileSync(p, "utf-8").includes(FORGE_HOME_MARKER);
    } catch {
      return false;
    }
  });

  // Check for forge.yaml in cwd
  const forgeYamlPath = join(process.cwd(), "forge.yaml");
  const hasForgeYaml = existsSync(forgeYamlPath);

  // Check whether the SessionStart hook is present in settings.json
  let hasSessionStartHook = false;
  try {
    const settings = readClaudeSettings();
    const sessionStartEntries = settings?.hooks?.SessionStart;
    if (Array.isArray(sessionStartEntries)) {
      hasSessionStartHook = sessionStartEntries.some((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
        return hooks.some(
          (h) =>
            h &&
            typeof h.command === "string" &&
            isForgeSessionStartHook(h.command),
        );
      });
    }
  } catch {
    // settings.json unreadable — treat as not present
  }

  // -------------------------------------------------------------------------
  // Phase 2: Pre-removal summary
  // -------------------------------------------------------------------------

  if (
    toRemove.length === 0 &&
    profilesWithForgeHome.length === 0 &&
    !hasForgeYaml &&
    !hasSessionStartHook
  ) {
    console.log(
      `  ${dim("Nothing to remove — ForgeDock does not appear to be installed.")}`,
    );
    console.log("");
    return;
  }

  const summaryLines = [""];
  if (toRemove.length > 0) {
    const fileLabel = copyMode ? "files (copy-mode install)" : "symlinks";
    summaryLines.push(
      `  ${red("Commands")}:   ${bold(String(toRemove.length))} ${fileLabel} in ${dim(TARGET_DIR)}`,
    );
  } else {
    summaryLines.push(`  ${dim("Commands:")}   none found`);
  }
  if (profilesWithForgeHome.length > 0) {
    summaryLines.push(
      `  ${yellow("Profiles")}:   FORGE_HOME export in ${bold(profilesWithForgeHome.map((p) => p.replace(HOME, "~")).join(", "))}`,
    );
  }
  if (hasSessionStartHook) {
    summaryLines.push(
      `  ${yellow("Hook")}:       SessionStart hook in ${dim("~/.claude/settings.json")}`,
    );
  }
  if (hasForgeYaml) {
    summaryLines.push(`  ${cyan("forge.yaml")}: present in current directory`);
  }
  summaryLines.push("");

  process.stdout.write(box(summaryLines, { title: "What will be removed" }));
  console.log("");

  // -------------------------------------------------------------------------
  // Phase 3: Main confirmation — default N (safe)
  // -------------------------------------------------------------------------

  const commandLabel =
    toRemove.length === 1 ? "1 command" : `${toRemove.length} commands`;
  const profileLabel =
    profilesWithForgeHome.length > 0
      ? ` and FORGE_HOME from ${profilesWithForgeHome.length === 1 ? "shell profile" : "shell profiles"}`
      : "";

  let confirmed = forceYes;
  if (!confirmed) {
    confirmed = await confirm(`Remove ${commandLabel}${profileLabel}?`, false);
  }

  if (!confirmed) {
    console.log("");
    console.log(`  ${dim("Aborted — nothing was removed.")}`);
    console.log("");
    return;
  }

  // -------------------------------------------------------------------------
  // Phase 4: Remove symlinks with progress bar
  // -------------------------------------------------------------------------

  if (toRemove.length > 0) {
    console.log("");
    const bar = createProgressBar(toRemove.length, {
      label: "  Removing commands",
    });
    let removed = 0;

    for (const { target, rel } of toRemove) {
      try {
        await unlink(target);
        removed++;
        bar.tick(1, rel);
      } catch (err) {
        bar.tick(1, `${red("failed:")} ${rel}`);
      }
    }

    bar.done(`${green("✔")} Removed ${removed}/${toRemove.length} commands`);

    // Clean up install-mode marker if copy-mode install was active
    if (copyMode) {
      await removeInstallModeMarker();
    }
  }

  // -------------------------------------------------------------------------
  // Phase 5: FORGE_HOME cleanup (only if detected)
  // -------------------------------------------------------------------------

  if (profilesWithForgeHome.length > 0) {
    console.log("");
    const cleanProfiles = forceYes
      ? true
      : await confirm("Remove FORGE_HOME export from shell profiles?", true);

    if (cleanProfiles) {
      for (const profile of profilesWithForgeHome) {
        const tmpPath = profile + ".forgedock.tmp";
        try {
          const content = readFileSync(profile, "utf-8");
          // Remove the two-line block written by install():
          //   \n# ForgeDock — autonomous development pipeline\nexport FORGE_HOME="..."\n
          // Also handle the case where it's at the very start of the file (no leading \n)
          const cleaned = content
            .replace(
              /\n# ForgeDock — autonomous development pipeline\nexport FORGE_HOME=[^\n]*\n/g,
              "\n",
            )
            .replace(
              /^# ForgeDock — autonomous development pipeline\nexport FORGE_HOME=[^\n]*\n/,
              "",
            );
          // Write to a temp file first, then atomically rename into place.
          // This prevents profile corruption if the process is killed mid-write.
          writeFileSync(tmpPath, cleaned, "utf-8");
          renameSync(tmpPath, profile);
          const profileShort = profile.replace(HOME, "~");
          console.log(
            `  ${green("✔")} Removed FORGE_HOME from ${profileShort}`,
          );
        } catch (err) {
          // Clean up temp file if it was created before the error
          try {
            unlinkSync(tmpPath);
          } catch {
            /* already gone or never created */
          }
          const profileShort = profile.replace(HOME, "~");
          console.log(
            `  ${red("✖")} Could not update ${profileShort}: ${err.message}`,
          );
        }
      }
    } else {
      console.log(`  ${dim("Skipped — FORGE_HOME left in shell profiles.")}`);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 6: SessionStart hook removal
  // -------------------------------------------------------------------------

  if (hasSessionStartHook) {
    console.log("");
    const removeHook = forceYes
      ? true
      : await confirm("Remove SessionStart hook from ~/.claude/settings.json?", true);

    if (removeHook) {
      const hookRemoveResult = await removeSessionStartHook();
      if (hookRemoveResult === "removed") {
        console.log(
          `  ${green("✔")} Removed SessionStart hook from ${dim("~/.claude/settings.json")}`,
        );
      } else if (hookRemoveResult === "not-present") {
        console.log(
          `  ${dim("✔")} SessionStart hook already absent from ~/.claude/settings.json`,
        );
      } else {
        console.log(
          `  ${red("✖")} Could not update ~/.claude/settings.json — remove the hook manually.`,
        );
      }
    } else {
      console.log(`  ${dim("Skipped — SessionStart hook left in settings.json.")}`);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 7: forge.yaml handling (default: keep)
  // -------------------------------------------------------------------------

  if (hasForgeYaml) {
    console.log("");
    const deleteForgeYaml = forceYes
      ? false // --yes flag: keep forge.yaml by default (safe)
      : await confirm("Delete forge.yaml from this project?", false);

    if (deleteForgeYaml) {
      try {
        await unlink(forgeYamlPath);
        console.log(`  ${green("✔")} Deleted forge.yaml`);
      } catch (err) {
        console.log(
          `  ${red("✖")} Could not delete forge.yaml: ${err.message}`,
        );
      }
    } else {
      console.log(`  ${dim("forge.yaml kept.")}`);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 8: Post-removal summary
  // -------------------------------------------------------------------------

  console.log("");
  console.log(
    `${green("Uninstall complete.")} ForgeDock commands have been removed.`,
  );
  if (profilesWithForgeHome.length > 0) {
    console.log(
      `  ${dim("Restart your shell or run")} ${cyan("source ~/.bashrc")} ${dim("(or")} ${cyan("~/.zshrc")}${dim(")")} ${dim("to apply profile changes.")}`,
    );
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Update helpers
// ---------------------------------------------------------------------------

/**
 * Query the npm registry for the latest published version of a package.
 * Returns null on any failure (offline, timeout, package not found).
 *
 * @param {string} pkg - npm package name (e.g. "forgedock")
 * @returns {string | null}
 */
function queryNpmRegistry(pkg) {
  try {
    const result = execFileSync("npm", ["view", pkg, "version"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
      shell: true,
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Proactive update check — cached remote version check
// ---------------------------------------------------------------------------

/**
 * Path to the update-check cache file.
 * Stored in ~/.forgedock/update-check.json.
 */
function _getUpdateCheckCachePath() {
  return join(HOME, ".forgedock", "update-check.json");
}

/** Default interval between automatic remote update checks (milliseconds). */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Check whether a newer version of ForgeDock is available, using a local cache
 * to avoid hitting the network on every invocation.
 *
 * For git installs: runs `git fetch origin main` (check-only, no merge) and
 * compares the local HEAD SHA against origin/main.
 * For npm installs: queries the npm registry via queryNpmRegistry().
 *
 * The cache file `~/.forgedock/update-check.json` stores the result with a
 * timestamp. If the cache is fresh (< UPDATE_CHECK_INTERVAL_MS old) and
 * `force` is false, the cached result is returned immediately without any
 * network call.
 *
 * Always returns null on any error — never throws.
 *
 * @param {boolean} [force=false]  When true, bypass cache and always hit network.
 * @returns {Promise<{updateAvailable: boolean, latestVersion: string|null, remoteHead: string|null} | null>}
 */
async function checkForRemoteUpdate(force = false) {
  const cachePath = _getUpdateCheckCachePath();

  // --- Read cache ---
  if (!force) {
    try {
      const raw = readFileSync(cachePath, "utf-8");
      const cached = JSON.parse(raw);
      const age = Date.now() - (cached.checkedAt ?? 0);
      if (age < UPDATE_CHECK_INTERVAL_MS) {
        // Cache is fresh — but for git installs, reconcile against the live
        // local HEAD before trusting the stored flag. A manual `git pull` in
        // FORGE_HOME (bypassing `forgedock update`) advances local HEAD to the
        // cached remoteHead without refreshing the cache, which would otherwise
        // keep showing a stale "Update available" notice until the TTL expires.
        // This recheck is local-only (no fetch/network) and offline-safe.
        if (cached.remoteHead && existsSync(join(FORGE_HOME, ".git"))) {
          try {
            const localHead = execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: FORGE_HOME,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
              timeout: 5000,
            }).trim();
            if (localHead === cached.remoteHead) {
              // Install has caught up out-of-band — no update available.
              return {
                updateAvailable: false,
                latestVersion: cached.latestVersion ?? null,
                remoteHead: cached.remoteHead,
              };
            }
          } catch {
            // git unavailable or not a repo — fall through to stored result.
          }
        }
        // Cache is fresh — return stored result
        return {
          updateAvailable: cached.updateAvailable ?? false,
          latestVersion: cached.latestVersion ?? null,
          remoteHead: cached.remoteHead ?? null,
        };
      }
    } catch {
      // Cache missing or malformed — proceed to network check
    }
  }

  // --- Perform network check ---
  const gitDir = join(FORGE_HOME, ".git");
  let result;

  if (existsSync(gitDir)) {
    // Git install: fetch and compare SHAs
    try {
      // Fetch — short timeout, offline-safe
      try {
        execFileSync("git", ["fetch", "origin", "main", "--quiet"], {
          cwd: FORGE_HOME,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10000,
        });
      } catch {
        // Offline or fetch failed — skip check, don't update cache
        return null;
      }

      const localHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: FORGE_HOME,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      }).trim();

      const remoteHead = execFileSync("git", ["rev-parse", "origin/main"], {
        cwd: FORGE_HOME,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      }).trim();

      // An update is only "available" when local HEAD is strictly BEHIND
      // origin/main. Plain SHA inequality is direction-agnostic: a checkout
      // that is ahead of or diverged from origin/main (e.g. a contributor with
      // local commits) would otherwise show a spurious "Update available"
      // notice. `git merge-base --is-ancestor HEAD origin/main` exits 0 when
      // HEAD is an ancestor of origin/main (behind or equal); combined with the
      // inequality below this means strictly behind. Any non-zero exit ("not an
      // ancestor") or error throws under execFileSync — treat all such cases as
      // "not behind" so we never show a false-positive notice.
      let headIsAncestorOfRemote = false;
      try {
        execFileSync(
          "git",
          ["merge-base", "--is-ancestor", "HEAD", "origin/main"],
          {
            cwd: FORGE_HOME,
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 5000,
          },
        );
        headIsAncestorOfRemote = true;
      } catch {
        // HEAD is ahead of, diverged from, or unrelated to origin/main — or git
        // failed. In every case, do not report an update as available.
        headIsAncestorOfRemote = false;
      }

      result = {
        updateAvailable: localHead !== remoteHead && headIsAncestorOfRemote,
        latestVersion: null,
        remoteHead,
      };
    } catch {
      return null;
    }
  } else {
    // npm install: query registry
    const latestVersion = queryNpmRegistry("forgedock");
    if (latestVersion === null) {
      // Offline or registry unreachable — skip check, don't update cache
      return null;
    }
    const currentVersion = getVersion();
    result = {
      updateAvailable: currentVersion !== latestVersion,
      latestVersion,
      remoteHead: null,
    };
  }

  // --- Write cache ---
  try {
    const cacheDir = join(HOME, ".forgedock");
    await mkdir(cacheDir, { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ checkedAt: Date.now(), ...result }, null, 2) + "\n",
      { encoding: "utf-8" },
    );
  } catch {
    // Best-effort — cache write failure is non-fatal
  }

  return result;
}

/**
 * Return a Set of relative paths for all ForgeDock-managed symlinks in TARGET_DIR.
 * Recursively walks subdirectories so commands installed under work-on/, work-on/build/,
 * etc. are included. Returns an empty Set if TARGET_DIR does not exist or cannot be read.
 *
 * @returns {Promise<Set<string>>}
 */
async function getInstalledCommandNames() {
  const names = new Set();
  const copyMode = readInstallModeMarker() !== null;

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        try {
          const stats = await lstat(fullPath);
          if (stats.isSymbolicLink()) {
            const linkTarget = await readlink(fullPath);
            if (linkTarget.includes("commands") && linkTarget.endsWith(".md")) {
              names.add(relative(TARGET_DIR, fullPath));
            }
          } else if (copyMode && entry.name.endsWith(".md")) {
            // Copy-mode install: regular .md files in TARGET_DIR are ForgeDock-managed
            names.add(relative(TARGET_DIR, fullPath));
          }
        } catch {
          // Skip unreadable entries
        }
      }
    }
  }

  await walk(TARGET_DIR);
  return names;
}

/**
 * Compute the added and removed command names between two Sets.
 * Returns formatted display lines, or an empty array if no diff.
 *
 * @param {Set<string>} before
 * @param {Set<string>} after
 * @returns {string[]}
 */
function formatCommandDiff(before, after) {
  const added = [...after]
    .filter((n) => !before.has(n))
    .map((n) => n.replace(/\.md$/, ""));
  const removed = [...before]
    .filter((n) => !after.has(n))
    .map((n) => n.replace(/\.md$/, ""));

  if (added.length === 0 && removed.length === 0) return [];

  const lines = [""];
  if (added.length > 0) {
    lines.push(`  ${green("Added")}    ${added.join(", ")}`);
  }
  if (removed.length > 0) {
    lines.push(`  ${red("Removed")}  ${removed.join(", ")}`);
  }
  lines.push("");
  return lines;
}

async function update() {
  const currentVersion = getVersion();

  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — Checking for updates`);
  console.log(`  ${dim(`Current version: v${currentVersion}`)}`);
  console.log("");

  // Determine install type: git clone (has .git) or npm global install
  const gitDir = join(FORGE_HOME, ".git");
  if (existsSync(gitDir)) {
    // -----------------------------------------------------------------------
    // Git install path
    // -----------------------------------------------------------------------
    // Snapshot installed commands before the update so we can show a diff after
    const commandsBefore = await getInstalledCommandNames();
    try {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: FORGE_HOME,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      }).trim();

      if (branch !== "main") {
        console.log(
          `  ${yellow("Not on main branch")} (${branch}) — skipping automatic update.`,
        );
        console.log(`  Switch to ${cyan("main")} and re-run to update.`);
        console.log("");
        return;
      }

      const before = execSync("git rev-parse HEAD", {
        cwd: FORGE_HOME,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      }).trim();

      // Fetch — graceful offline fallback
      try {
        execSync("git fetch origin main --quiet", {
          cwd: FORGE_HOME,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10000,
        });
      } catch {
        console.log(
          `  ${yellow("Offline or unreachable.")} Could not fetch from origin.`,
        );
        console.log(
          `  ${dim("Skipping update check — re-run when connected.")}`,
        );
        console.log("");
        return;
      }

      const remoteHead = execSync("git rev-parse origin/main", {
        cwd: FORGE_HOME,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      }).trim();

      if (before === remoteHead) {
        // Already up to date
        const lines = [
          "",
          `  ${green("✔")}  ForgeDock v${currentVersion} — already up to date`,
          "",
        ];
        process.stdout.write(box(lines, { title: "Up to date" }));
        console.log("");
        return;
      }

      // Show changelog between current HEAD and remote HEAD
      let changelogLines = [];
      try {
        const log = execSync(`git log --oneline ${before}..origin/main`, {
          cwd: FORGE_HOME,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
        }).trim();
        if (log) {
          changelogLines = log.split("\n").map((l) => `  ${dim(l)}`);
        }
      } catch {
        // Non-blocking — skip changelog if log fails
      }

      if (changelogLines.length > 0) {
        const boxLines = ["", ...changelogLines, ""];
        process.stdout.write(box(boxLines, { title: "What's new" }));
        console.log("");
      }

      // Apply update
      try {
        execSync("git merge --ff-only origin/main --quiet", {
          cwd: FORGE_HOME,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 15000,
        });
      } catch {
        // Check if the only changes are whitespace/line-ending noise (CRLF drift, etc.)
        let isWhitespaceOnly = false;
        try {
          const diffStat = execFileSync(
            "git",
            [
              "diff",
              "--ignore-all-space",
              "--ignore-blank-lines",
              "--name-only",
            ],
            {
              cwd: FORGE_HOME,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
              timeout: 5000,
            },
          ).trim();
          isWhitespaceOnly = diffStat === "";
        } catch {
          // Diff check failed — fall back to generic message
        }

        console.log(
          `  ${yellow("Cannot fast-forward")} — local changes exist. Skipping merge.`,
        );
        if (isWhitespaceOnly) {
          console.log(
            `  ${dim("Only whitespace/line-ending differences detected.")}`,
          );
          console.log(
            `  ${dim("Run")} ${cyan("git checkout -- .")} ${dim("to discard them, then re-run")} ${cyan("npx forgedock update")}${dim(".")}`,
          );
        } else {
          console.log(`  ${dim("Stash or discard local changes and re-run.")}`);
        }
        console.log("");
        return;
      }

      const after = execSync("git rev-parse HEAD", {
        cwd: FORGE_HOME,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      }).trim();

      const newVersion = getVersion();
      console.log(`  ${green("Updated")} v${currentVersion} → v${newVersion}`);
      console.log("");

      // Invalidate the update-check cache so the next tuiOnboarding() run
      // reflects the freshly-applied update without hitting the network again.
      try {
        const cacheDir = join(HOME, ".forgedock");
        await mkdir(cacheDir, { recursive: true });
        writeFileSync(
          _getUpdateCheckCachePath(),
          JSON.stringify(
            {
              checkedAt: Date.now(),
              updateAvailable: false,
              latestVersion: newVersion,
              remoteHead: after,
            },
            null,
            2,
          ) + "\n",
          { encoding: "utf-8" },
        );
      } catch {
        // Best-effort — cache write failure is non-fatal
      }

      // Re-run symlink installer to pick up new/removed commands
      await install();

      // Show command diff
      const commandsAfter = await getInstalledCommandNames();
      const diffLines = formatCommandDiff(commandsBefore, commandsAfter);
      if (diffLines.length > 0) {
        process.stdout.write(box(diffLines, { title: "Command changes" }));
        console.log("");
      }
    } catch (err) {
      console.log(
        `  ${RED}Update failed.${RESET} ${err instanceof Error ? err.message : String(err)}`,
      );
      console.log("");
    }
  } else {
    // -----------------------------------------------------------------------
    // npm install path
    // -----------------------------------------------------------------------
    console.log(`  ${dim("Installed via npm.")}`);
    console.log("");

    // Query registry for latest version — graceful offline fallback
    // Only use \r line-clearing trick in TTY environments; in non-TTY just print a static line
    if (process.stdout.isTTY) {
      process.stdout.write(`  Checking npm registry...`);
    } else {
      console.log(`  Checking npm registry...`);
    }
    const latestVersion = queryNpmRegistry("forgedock");

    if (latestVersion === null) {
      if (process.stdout.isTTY) {
        process.stdout.write(
          `\r  ${yellow("Offline or registry unreachable.")} Could not check for updates.\n`,
        );
      } else {
        console.log(
          `  Offline or registry unreachable. Could not check for updates.`,
        );
      }
      console.log(
        `  ${dim("Re-run when connected, or check: ")}${cyan("https://www.npmjs.com/package/forgedock")}`,
      );
      console.log("");
      return;
    }

    // Clear the "Checking..." line (TTY only — non-TTY already printed a newline above)
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${" ".repeat(50)}\r`);
    }

    if (currentVersion === latestVersion) {
      const lines = [
        "",
        `  ${green("✔")}  ForgeDock v${currentVersion} — already up to date`,
        "",
      ];
      process.stdout.write(box(lines, { title: "Up to date" }));
      console.log("");
      return;
    }

    // Update available
    const lines = [
      "",
      `  ${yellow("Update available:")}  v${currentVersion}  →  ${green(`v${latestVersion}`)}`,
      "",
      `  Run the following command to update:`,
      "",
      `    ${cyan(`npm update -g forgedock`)}`,
      "",
      `  Then re-run ${cyan("npx forgedock")} to refresh your commands.`,
      "",
    ];
    process.stdout.write(box(lines, { title: "npm update available" }));
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// Backend-selection ladder helpers — detect, enrich via skill, enrich via API
// ---------------------------------------------------------------------------

/**
 * Determine which enrichment backend is available.
 *
 * Ladder:
 *   1. skill  — running inside a Claude Code session (CLAUDE_CODE_SESSION_ID set)
 *   2. api    — ANTHROPIC_API_KEY env var is present and non-empty
 *   3. none   — fall through to deterministic baseline
 *
 * @returns {'skill'|'api'|'none'}
 */
function _detectBackend() {
  // Primary signal: Claude Code sets CLAUDE_CODE_SESSION_ID in its environment.
  // This is the only reliable indicator of an active CC session — non-TTY stdin
  // alone is not sufficient (CI/CD and piped scripts also run non-interactively).
  if (process.env.CLAUDE_CODE_SESSION_ID) {
    return "skill";
  }

  // API backend: BYO key present.
  if (process.env.ANTHROPIC_API_KEY) {
    return "api";
  }

  return "none";
}

/**
 * Enrich a ConfigDraft by invoking the /forgedock-init skill backend via the
 * Claude Code CLI (`claude -p`), with the full prompt piped via stdin.
 *
 * Uses execFileSync with the `input` option to pipe the prompt
 * (`/forgedock-init <draftJSON>`) to the claude process's stdin rather than
 * embedding it in a CLI argument. This avoids OS ARG_MAX limits for large
 * JSON payloads and keeps the argument list minimal.
 *
 * @param {object} draft  - ConfigDraft from detectConfig()
 * @param {string} cwd    - Working directory for the claude invocation
 * @returns {Promise<object>} Enriched ConfigDraft, or the original draft on failure
 */
async function _enrichViaSkill(draft, cwd) {
  try {
    const draftJson = JSON.stringify(draft);
    const output = execFileSync(
      "claude",
      ["-p"],
      {
        cwd,
        encoding: "utf-8",
        timeout: 120000, // 2 minutes — enrichment may take a while for large repos
        input: `/forgedock-init ${draftJson}`,
        stdio: ["pipe", "pipe", "pipe"],
        // On Windows, npm-installed CLIs like `claude` are .cmd shims. execFileSync
        // does not resolve .cmd extensions without a shell — shell: true enables the
        // cmd.exe lookup that finds claude.cmd on PATH. Safe here: executable name is
        // hardcoded, no user input is involved. (Ref: review-finding #382)
        shell: process.platform === "win32",
      },
    );

    return parseEnrichedDraft(output, draft);
  } catch (err) {
    // Log the failure at debug level but never surface to user — fall back silently.
    if (process.env.FORGEDOCK_DEBUG) {
      console.error(
        `  ${dim("[debug]")} skill enrichment failed: ${err.message}`,
      );
    }
    return draft;
  }
}

/**
 * Build an optionalSections object from an enriched ConfigDraft, promoting
 * sections that have medium-or-higher confidence to active (non-commented) YAML.
 * Sections with only low-confidence fields are omitted so they remain commented out.
 *
 * @param {object} enrichedDraft - ConfigDraft returned by an enrichment backend
 * @returns {object} optionalSections compatible with _writeForgeYaml / buildForgeYamlContent
 */
function _optionalSectionsFromDraft(enrichedDraft) {
  const sections = {};

  // project_board — include if project_number has at least medium confidence
  const pb = enrichedDraft.project_board;
  if (
    pb &&
    pb.project_number &&
    pb.project_number.confidence !== "low" &&
    pb.project_number.value
  ) {
    sections.projectBoard = {
      projectNumber: parseInt(pb.project_number.value, 10) || 1,
      projectId: pb.project_id?.value || "",
      fieldIds: {
        status: pb.field_ids?.status?.value || "",
        lane: pb.field_ids?.lane?.value || "",
        component: pb.field_ids?.component?.value || "",
        priority: pb.field_ids?.priority?.value || "",
        workflow: pb.field_ids?.workflow?.value || "",
      },
      optionIds: pb.option_ids || {},
    };
  }

  // repos.satellites — include if at least one satellite found
  const repos = enrichedDraft.repos;
  if (
    repos &&
    repos.satellites &&
    Array.isArray(repos.satellites) &&
    repos.satellites.length > 0
  ) {
    const first = repos.satellites[0];
    if (first && first.prefix && first.prefix.value) {
      sections.multiRepo = {
        prefix: first.prefix.value || "sat",
        satelliteRepo: (first.repo?.value || "").split("/").pop() || "satellite",
        satelliteBranch: first.staging_branch?.value || "main",
      };
    }
  }

  // review — include if tech_stack has at least medium confidence
  const review = enrichedDraft.review;
  if (
    review &&
    review.tech_stack &&
    review.tech_stack.confidence !== "low" &&
    review.tech_stack.value
  ) {
    sections.review = {
      techStack: review.tech_stack.value,
      context: review.context?.value || "",
    };
  }

  // verification — include if health_endpoint has at least medium confidence
  const verification = enrichedDraft.verification;
  if (
    verification &&
    verification.health_endpoint &&
    verification.health_endpoint.confidence !== "low" &&
    verification.health_endpoint.value
  ) {
    sections.verification = {
      healthEndpoint: verification.health_endpoint.value,
    };
  }

  return sections;
}

async function init() {
  // init() generates forge.yaml from prompts and git remote detection.
  // It does NOT require gh CLI or gh auth for core operation (project board
  // auto-discovery is optional and guarded separately). Only warn if Claude
  // Code is missing — it's the primary consumer of the generated config.
  try {
    execFileSync("claude", ["--version"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
      // On Windows, claude is a .cmd shim — execFileSync needs shell: true to find it.
      // (Ref: review-finding #382)
      shell: process.platform === "win32",
    });
  } catch {
    console.log(`  ${YELLOW}!${RESET} Claude Code CLI not found on PATH.`);
    console.log(
      `    Install: ${CYAN}https://docs.anthropic.com/en/docs/claude-code${RESET}`,
    );
    console.log("");
  }

  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — Generate forge.yaml`);
  console.log("");

  const cwd = process.cwd();
  const outputPath = join(cwd, "forge.yaml");

  // ---------------------------------------------------------------------------
  // Step 1: Auto-detect defaults via init-detect module.
  // Returns a ConfigDraft with per-field { value, confidence, source, why }.
  // ---------------------------------------------------------------------------

  const baseDraft = await detectConfig(cwd);
  const remoteDetected = baseDraft.meta.remoteDetected;

  // ---------------------------------------------------------------------------
  // Step 2: Backend-selection ladder — enrich the draft when possible.
  // Ladder: skill (Claude Code session) → api (ANTHROPIC_API_KEY) → none (baseline)
  // --manual bypasses enrichment entirely: power users get the full guided wizard
  // with unmodified detection results so they can review every field by hand.
  // ---------------------------------------------------------------------------

  const backend = _detectBackend();
  let draft = baseDraft;

  if (manualMode) {
    // Escape hatch: skip all AI enrichment and force the full per-field wizard.
    console.log(
      `  ${CYAN}--manual${RESET} mode: skipping autopilot enrichment — full guided wizard`,
    );
    console.log("");
  } else if (backend === "skill") {
    const s = spinner("Enriching config via skill backend…");
    draft = await _enrichViaSkill(baseDraft, cwd);
    const enriched = draft !== baseDraft || draft.meta?.enriched;
    s.stop(
      enriched ? "success" : "warn",
      enriched
        ? `${green("[✓]")} Config enriched via Claude Code`
        : `${yellow("[!]")} Skill enrichment unavailable — using detected baseline`,
    );
  } else if (backend === "api") {
    const s = spinner("Enriching config via Anthropic API…");
    draft = await enrichViaAPI(baseDraft);
    const enriched = draft !== baseDraft || draft.meta?.enriched;
    s.stop(
      enriched ? "success" : "warn",
      enriched
        ? `${green("[✓]")} Config enriched via Anthropic API`
        : `${yellow("[!]")} API enrichment unavailable — using detected baseline`,
    );
  }
  // backend === 'none' (or manualMode): proceed silently with the deterministic baseline

  const detectedOwner = draft.project.owner.value;
  const detectedRepo = draft.project.repo.value;
  const detectedName = draft.project.name.value;
  const detectedDefault = draft.branches.default.value;
  const detectedStaging = draft.branches.staging.value;

  // Non-TTY: enrich (done above) then silently write without interactive prompts.
  if (!process.stdin.isTTY) {
    if (!remoteDetected) {
      console.log(
        `  ${YELLOW}Warning${RESET}: No git remote found — using placeholder values`,
      );
    }
    // Derive optional sections from the enriched draft for the silent write.
    const enrichedSections = _optionalSectionsFromDraft(draft);
    _writeForgeYaml({
      outputPath,
      cwd,
      owner: detectedOwner,
      repo: detectedRepo,
      projectName: detectedName,
      description: "",
      root: cwd,
      worktreeBase: join(cwd, ".claude", "worktrees"),
      defaultBranch: detectedDefault,
      stagingBranch: detectedStaging,
      optionalSections: enrichedSections,
    });
    console.log(`  ${GREEN}Created${RESET}: forge.yaml`);
    console.log("");
    await injectClaudeMd(cwd);
    console.log("");
    _printNextSteps({ remoteDetected });
    await validate(outputPath);
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 3: Annotated review screen — single screen replacing the per-field wizard
  // ---------------------------------------------------------------------------

  // Read existing content for diff-style display if forge.yaml already exists.
  let existingContent = "";
  const hasExistingConfig = existsSync(outputPath);
  if (hasExistingConfig) {
    try {
      existingContent = readFileSync(outputPath, "utf-8");
    } catch {
      // Best-effort — missing or unreadable existing file is handled below
    }
  }

  // Show the annotated review screen. The enriched draft populates confidence
  // badges from both init-detect and init-enrich. Returns accepted/edited values
  // plus the list of field keys that had low confidence (for TODO comment injection).
  // --verbose: pass showSources:true so the screen surfaces each field's detection
  // source and confidence rationale (the .source and .why metadata from ConfigDraft).
  const reviewed = await annotatedReviewScreen(draft, {
    hasExistingConfig,
    existingContent,
    showSources: verboseMode,
  });

  const ownerInput = _sanitizeYamlValue(reviewed.owner || detectedOwner);
  const repoInput = _sanitizeYamlValue(reviewed.repo || detectedRepo);
  const nameInput = _sanitizeYamlValue(reviewed.name || detectedName);
  const descInput = _sanitizeYamlValue(reviewed.description || "");
  const rootInput = reviewed.root || cwd;
  const worktreeInput = reviewed.worktreeBase || join(cwd, ".claude", "worktrees");
  const defaultBranchInput = _sanitizeYamlValue(reviewed.defaultBranch || detectedDefault);
  const stagingBranchInput = _sanitizeYamlValue(reviewed.stagingBranch || detectedStaging);

  // -----------------------------------------------------------------------
  // Optional sections — pre-populate from enriched draft if available,
  // otherwise fall back to interactive multi-select + guided prompts.
  // -----------------------------------------------------------------------

  /** @type {Record<string, object>} */
  let optionalSections = {};

  // When enrichment succeeded, lift discovered sections directly from the draft.
  // Only sections with medium-or-higher confidence are included; low-confidence
  // sections remain commented-out in the output (no behaviour change for users
  // without an enrichment backend).
  // manualMode forces the full guided wizard regardless of enrichment backend.
  const enrichmentSucceeded =
    !manualMode && backend !== "none" && (draft !== baseDraft || draft.meta?.enriched);

  if (enrichmentSucceeded) {
    optionalSections = _optionalSectionsFromDraft(draft);

    // Surface which sections were auto-populated by enrichment.
    const autoSections = Object.keys(optionalSections);
    if (autoSections.length > 0) {
      console.log("");
      console.log(
        `  ${GREEN}Auto-configured${RESET} by enrichment: ${autoSections
          .map(
            (s) =>
              ({
                projectBoard: "project_board",
                multiRepo: "repos",
                review: "review",
                verification: "verification",
              })[s],
          )
          .join(", ")}`,
      );
    }

    // Still offer the multi-select so the user can add sections that enrichment
    // couldn't discover (e.g. project_board when gh is unauthenticated).
    const alreadyConfigured = new Set(autoSections);

    const OPTIONAL_SECTION_CHOICES = [
      {
        label:
          "Project Board   — GitHub Projects v2 integration for workflow tracking",
        value: "projectBoard",
      },
      {
        label: "Multi-Repo      — Satellite repos for cross-repo milestones",
        value: "multiRepo",
      },
      {
        label:
          "Review Context  — Tech stack and conventions for PR review agents",
        value: "review",
      },
      {
        label:
          "Verification    — Health check endpoints and response patterns",
        value: "verification",
      },
    ].filter((c) => !alreadyConfigured.has(c.value));

    if (OPTIONAL_SECTION_CHOICES.length > 0) {
      console.log("");
      console.log(bold("  Additional Optional Sections"));
      console.log(
        dim(
          "  The following sections were not auto-discovered. Select any to configure now.",
        ),
      );
      console.log("");

      const selectedSections = await multiSelect(
        "  Which additional sections would you like to configure?",
        OPTIONAL_SECTION_CHOICES,
      );

      // --- Project Board prompts (manual, only when enrichment didn't find it) ---
      if (selectedSections.includes("projectBoard")) {
        const discovered = await discoverProjectBoard(ownerInput || detectedOwner);
        if (discovered) {
          optionalSections.projectBoard = {
            projectNumber: discovered.projectNumber,
            projectId: discovered.projectId,
            fieldIds: discovered.fieldIds,
            optionIds: discovered.optionIds,
          };
        } else {
          console.log("");
          console.log(bold("  Project Board (manual)"));
          console.log(
            dim(
              "  Find your project number: gh project list --owner " +
                (ownerInput || detectedOwner),
            ),
          );
          const projectNumber = await input(
            "  GitHub Projects v2 project number",
            "1",
          );
          optionalSections.projectBoard = {
            projectNumber: parseInt(projectNumber, 10) || 1,
          };
          console.log(
            dim(
              "  Field IDs (PVT_/PVTSSF_ strings) must be added manually after generation.",
            ),
          );
          console.log(
            dim(
              "  Run: gh project field-list " +
                (projectNumber || "1") +
                " --owner " +
                (ownerInput || detectedOwner),
            ),
          );
        }
      }

      // --- Multi-Repo prompts ---
      if (selectedSections.includes("multiRepo")) {
        console.log("");
        console.log(bold("  Multi-Repo"));
        console.log(
          dim(
            "  Configure one satellite repo (add more by editing forge.yaml).",
          ),
        );
        const prefix = await input(
          "  Satellite repo prefix (e.g. 'mcp', 'sdk')",
          "sat",
        );
        const satelliteRepo = await input(
          "  Satellite repo name (just the name, owner will be reused)",
          "your-satellite-repo",
        );
        const satelliteBranch = await input(
          "  Satellite default/staging branch",
          "main",
        );
        optionalSections.multiRepo = { prefix, satelliteRepo, satelliteBranch };
      }

      // --- Review Context prompts ---
      if (selectedSections.includes("review")) {
        console.log("");
        console.log(bold("  Review Context"));
        const techStack = await input(
          "  Tech stack (e.g. Next.js, FastAPI, PostgreSQL)",
          "Node.js, TypeScript",
        );
        const context = await input(
          "  Architecture notes (one line; expand in forge.yaml later)",
          "",
        );
        optionalSections.review = { techStack, context };
      }

      // --- Verification prompts ---
      if (selectedSections.includes("verification")) {
        console.log("");
        console.log(bold("  Verification"));
        const healthEndpoint = await input(
          "  Health check endpoint URL",
          `https://api.${repoInput || detectedRepo}.io/health`,
        );
        optionalSections.verification = { healthEndpoint };
      }
    }
  } else {
    // No enrichment — use the full interactive multi-select wizard (existing behaviour).
    console.log("");
    console.log(bold("  Optional Sections"));
    console.log(
      dim(
        "  Select sections to configure now. Unselected sections are written as",
      ),
    );
    console.log(
      dim(
        "  commented-out placeholders — you can enable them later by editing forge.yaml.",
      ),
    );
    console.log("");

    const OPTIONAL_SECTION_CHOICES = [
      {
        label:
          "Project Board   — GitHub Projects v2 integration for workflow tracking",
        value: "projectBoard",
      },
      {
        label: "Multi-Repo      — Satellite repos for cross-repo milestones",
        value: "multiRepo",
      },
      {
        label:
          "Review Context  — Tech stack and conventions for PR review agents",
        value: "review",
      },
      {
        label:
          "Verification    — Health check endpoints and response patterns",
        value: "verification",
      },
    ];

    const selectedSections = await multiSelect(
      "  Which optional sections would you like to configure?",
      OPTIONAL_SECTION_CHOICES,
    );

    // --- Project Board prompts ---
    if (selectedSections.includes("projectBoard")) {
      const discovered = await discoverProjectBoard(ownerInput || detectedOwner);
      if (discovered) {
        optionalSections.projectBoard = {
          projectNumber: discovered.projectNumber,
          projectId: discovered.projectId,
          fieldIds: discovered.fieldIds,
          optionIds: discovered.optionIds,
        };
      } else {
        console.log("");
        console.log(bold("  Project Board (manual)"));
        console.log(
          dim(
            "  Find your project number: gh project list --owner " +
              (ownerInput || detectedOwner),
          ),
        );
        const projectNumber = await input(
          "  GitHub Projects v2 project number",
          "1",
        );
        optionalSections.projectBoard = {
          projectNumber: parseInt(projectNumber, 10) || 1,
        };
        console.log(
          dim(
            "  Field IDs (PVT_/PVTSSF_ strings) must be added manually after generation.",
          ),
        );
        console.log(
          dim(
            "  Run: gh project field-list " +
              (projectNumber || "1") +
              " --owner " +
              (ownerInput || detectedOwner),
          ),
        );
      }
    }

    // --- Multi-Repo prompts ---
    if (selectedSections.includes("multiRepo")) {
      console.log("");
      console.log(bold("  Multi-Repo"));
      console.log(
        dim(
          "  Configure one satellite repo (add more by editing forge.yaml).",
        ),
      );
      const prefix = await input(
        "  Satellite repo prefix (e.g. 'mcp', 'sdk')",
        "sat",
      );
      const satelliteRepo = await input(
        "  Satellite repo name (just the name, owner will be reused)",
        "your-satellite-repo",
      );
      const satelliteBranch = await input(
        "  Satellite default/staging branch",
        "main",
      );
      optionalSections.multiRepo = { prefix, satelliteRepo, satelliteBranch };
    }

    // --- Review Context prompts ---
    if (selectedSections.includes("review")) {
      console.log("");
      console.log(bold("  Review Context"));
      const techStack = await input(
        "  Tech stack (e.g. Next.js, FastAPI, PostgreSQL)",
        "Node.js, TypeScript",
      );
      const context = await input(
        "  Architecture notes (one line; expand in forge.yaml later)",
        "",
      );
      optionalSections.review = { techStack, context };
    }

    // --- Verification prompts ---
    if (selectedSections.includes("verification")) {
      console.log("");
      console.log(bold("  Verification"));
      const healthEndpoint = await input(
        "  Health check endpoint URL",
        `https://api.${repoInput || detectedRepo}.io/health`,
      );
      optionalSections.verification = { healthEndpoint };
    }
  }

  // -----------------------------------------------------------------------
  // Handle existing forge.yaml with backup
  // -----------------------------------------------------------------------
  if (hasExistingConfig) {
    console.log("");
    const shouldOverwrite = await confirm(
      "  Back up existing forge.yaml and overwrite?",
      true,
    );
    if (!shouldOverwrite) {
      console.log(`  ${dim("Cancelled.")} forge.yaml was not changed.`);
      console.log("");
      return;
    }

    // Backup with timestamped name if .bak already exists (fix from #36)
    const baseBak = join(cwd, "forge.yaml.bak");
    const backupPath = existsSync(baseBak)
      ? join(
          cwd,
          `forge.yaml.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`,
        )
      : baseBak;
    const backupName = basename(backupPath);
    renameSync(outputPath, backupPath);
    console.log(`  ${YELLOW}Backed up${RESET}: forge.yaml → ${backupName}`);
  }

  // Write the file — passing lowConfidenceKeys so _writeForgeYaml can inject
  // # TODO(forgedock:<field>) comments for fields that were low-confidence.
  _writeForgeYaml({
    outputPath,
    cwd,
    owner: ownerInput,
    repo: repoInput,
    projectName: nameInput,
    description: descInput,
    root: rootInput || cwd,
    worktreeBase: worktreeInput || join(cwd, ".claude", "worktrees"),
    defaultBranch: defaultBranchInput,
    stagingBranch: stagingBranchInput,
    optionalSections,
    lowConfidenceKeys: reviewed.lowConfidenceKeys ?? [],
  });

  console.log("");
  console.log(`  ${GREEN}Created${RESET}: forge.yaml`);
  const configuredSectionKeys = Object.keys(optionalSections);
  if (configuredSectionKeys.length > 0) {
    console.log(
      `  ${GREEN}Configured${RESET}: ${configuredSectionKeys
        .map(
          (s) =>
            ({
              projectBoard: "project_board",
              multiRepo: "repos",
              review: "review",
              verification: "verification",
            })[s],
        )
        .filter(Boolean)
        .join(", ")}`,
    );
  }

  // Show TODO flag summary for low-confidence fields written with comments
  if (reviewed.lowConfidenceKeys && reviewed.lowConfidenceKeys.length > 0) {
    console.log("");
    console.log(
      `  ${YELLOW}⚠${RESET}  ${reviewed.lowConfidenceKeys.length} field(s) written with ${CYAN}# TODO(forgedock:<field>)${RESET} comments:`,
    );
    for (const key of reviewed.lowConfidenceKeys) {
      console.log(`     ${dim("·")} ${key}`);
    }
    console.log(
      `  ${dim("Search for")} ${CYAN}TODO(forgedock:${RESET} ${dim("in forge.yaml to find them.")}`,
    );
  }

  console.log("");
  await injectClaudeMd(cwd);
  console.log("");
  _printNextSteps({ remoteDetected: ownerInput !== "your-github-org" });
  await validate(outputPath);
}

// ---------------------------------------------------------------------------
// CLAUDE.md Integration — injectClaudeMd()
// ---------------------------------------------------------------------------

const CLAUDE_BLOCK_BEGIN = "<!-- BEGIN FORGEDOCK -->";
const CLAUDE_BLOCK_END = "<!-- END FORGEDOCK -->";

/**
 * Extract the `description:` value from a command file's YAML frontmatter.
 * Returns null if no frontmatter or no description is found.
 *
 * @param {string} content - Full file content
 * @returns {string|null}
 */
function _extractFrontmatterDescription(content) {
  // Match YAML frontmatter block: starts with ---, ends with ---
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  // Extract description: value (may span the rest of the line)
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  if (!descMatch) return null;
  return descMatch[1].trim();
}

/**
 * Build the managed ForgeDock block content (between markers, not including them).
 * Reads all commands/*.md files, extracts frontmatter descriptions, and generates
 * a concise command index.
 *
 * @returns {Promise<string>} Block content
 */
async function _buildForgeDockBlock() {
  const files = await findMarkdownFiles(COMMANDS_DIR);

  /** @type {Array<{name: string, description: string}>} */
  const commands = [];

  for (const file of files) {
    let content = "";
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue; // skip unreadable files
    }
    const description = _extractFrontmatterDescription(content);
    if (!description) continue;

    // Derive display name: relative path from COMMANDS_DIR, remove .md extension
    const rel = relative(COMMANDS_DIR, file)
      .replace(/\\/g, "/")
      .replace(/\.md$/, "");
    commands.push({ name: rel, description });
  }

  // Sort: top-level commands first, then sub-commands alphabetically
  commands.sort((a, b) => {
    const aDepth = a.name.split("/").length;
    const bDepth = b.name.split("/").length;
    if (aDepth !== bDepth) return aDepth - bDepth;
    return a.name.localeCompare(b.name);
  });

  const indexLines = commands
    .map(({ name, description }) => `- \`/${name}\` — ${description}`)
    .join("\n");

  return `## ForgeDock — Autonomous Development Pipeline

This project is driven by **ForgeDock**. GitHub issues are the knowledge graph.
Core loop: **issue in → PR out** (PRs target \`staging\` fast-lane or \`milestone/{slug}\`).

### When to Use What

- \`/issue\` — file a pipeline-ready issue
- \`/work-on N\` — full investigate→build→review→merge for issue N
- \`/milestone\` + \`/orchestrate\` — plan and parallelize milestone work
- \`/review-pr\` — review a PR with domain agents
- \`/quality-gate\` — pre-commit quality check
- \`/validate\` — validate forge.yaml configuration

### Command Index

${indexLines}

### Conventions

- Fast-lane PRs target \`staging\`; milestone PRs target \`milestone/{slug}\`
- Review findings become separate issues (not merge blockers)
- \`forge.yaml\` is the project config — see \`docs/CONFIG.md\`
- Re-generate this block: \`npx forgedock integrate\``;
}

/**
 * Idempotently inject (or update) a managed ForgeDock usage block into a file.
 * The block is bounded by BEGIN FORGEDOCK / END FORGEDOCK HTML comment markers.
 * Content outside the markers is never modified.
 *
 * @param {string} filePath - Absolute path to the target file (CLAUDE.md or AGENTS.md)
 * @param {string} blockContent - Content to place between the markers
 * @param {boolean} createIfMissing - Create the file if it does not exist
 * @returns {'created'|'updated'|'skipped'} Result status
 */
function _injectManagedBlock(filePath, blockContent, createIfMissing) {
  const managed = `${CLAUDE_BLOCK_BEGIN}\n${blockContent}\n${CLAUDE_BLOCK_END}`;

  if (!existsSync(filePath)) {
    if (!createIfMissing) return "skipped";
    writeFileSync(filePath, `${managed}\n`, "utf-8");
    return "created";
  }

  let existing = readFileSync(filePath, "utf-8");

  if (
    existing.includes(CLAUDE_BLOCK_BEGIN) &&
    existing.includes(CLAUDE_BLOCK_END)
  ) {
    // Both markers present — replace existing block in place.
    // Guard: if markers are reversed (END before BEGIN) the regex finds no
    // forward-spanning match; fall through to the repair path instead of
    // writing the file unchanged and returning a false 'updated'. <!-- Added: forge#291 -->
    const escaped_begin = CLAUDE_BLOCK_BEGIN.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const escaped_end = CLAUDE_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const blockRegex = new RegExp(
      `${escaped_begin}[\\s\\S]*?${escaped_end}`,
      "g",
    );
    const replaced = existing.replace(blockRegex, managed);
    if (replaced !== existing) {
      writeFileSync(filePath, replaced, "utf-8");
      return "updated";
    }
    // Regex found no match (e.g. reversed markers) — strip both orphaned
    // markers below and fall through to the append path to repair the file.
    existing = existing
      .replace(CLAUDE_BLOCK_BEGIN, "")
      .replace(CLAUDE_BLOCK_END, "")
      .trimEnd();
  } else if (existing.includes(CLAUDE_BLOCK_BEGIN)) {
    // BEGIN present but END missing — file is truncated or malformed.
    // Strip the orphaned marker and everything after it, then fall through
    // to the append path below so the complete block is written correctly.
    existing = existing
      .slice(0, existing.indexOf(CLAUDE_BLOCK_BEGIN))
      .trimEnd();
  } else if (existing.includes(CLAUDE_BLOCK_END)) {
    // END present but BEGIN missing — orphaned END marker left by a previous
    // failed write. Strip it and fall through to append the complete block.
    // <!-- Added: forge#291 -->
    existing = existing.replace(CLAUDE_BLOCK_END, "").trimEnd();
  }

  // Append block to existing content, separated by a blank line
  const separator =
    existing.length === 0 || existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(filePath, `${existing}${separator}${managed}\n`, "utf-8");
  return "updated";
}

/**
 * Inject or update the managed ForgeDock block into the project CLAUDE.md.
 * Also mirrors the block into AGENTS.md if that file already exists.
 * Creates CLAUDE.md if absent; never creates AGENTS.md.
 *
 * @param {string} cwd - Project root directory
 * @returns {Promise<void>}
 */
async function injectClaudeMd(cwd) {
  const claudePath = join(cwd, "CLAUDE.md");
  const agentsPath = join(cwd, "AGENTS.md");

  let blockContent;
  try {
    blockContent = await _buildForgeDockBlock();
  } catch (err) {
    console.log(
      `  ${YELLOW}!${RESET}  Could not generate command index — skipping CLAUDE.md update (${err.message})`,
    );
    return;
  }

  const claudeResult = _injectManagedBlock(claudePath, blockContent, true);
  if (claudeResult === "created") {
    console.log(
      `  ${GREEN}✔${RESET}  CLAUDE.md created with ForgeDock integration block`,
    );
  } else {
    console.log(
      `  ${GREEN}✔${RESET}  CLAUDE.md updated — ForgeDock block refreshed`,
    );
  }

  if (existsSync(agentsPath)) {
    _injectManagedBlock(agentsPath, blockContent, false);
    console.log(`  ${GREEN}✔${RESET}  AGENTS.md mirrored`);
  }
}

// ---------------------------------------------------------------------------
// Helpers for init()
// ---------------------------------------------------------------------------

/**
 * Sanitize a string value for safe insertion into a YAML double-quoted scalar.
 * Escapes backslashes (so a trailing \ does not corrupt the closing quote),
 * then strips double-quotes and newlines to prevent YAML injection.
 * Backslash escaping MUST come first — before any other replacement.
 *
 * @param {string} value
 * @returns {string}
 */
function _sanitizeYamlValue(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "")
    .replace(/[\r\n]/g, " ")
    .trim();
}

/**
 * Sanitize a file-system path value for safe insertion into a YAML double-quoted scalar.
 * Escapes backslashes (Windows paths) in addition to stripping double-quotes and newlines.
 *
 * @param {string} value
 * @returns {string}
 */
function _sanitizePathValue(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "")
    .replace(/[\r\n]/g, " ")
    .trim();
}

/**
 * Attempt to auto-discover GitHub Projects v2 configuration for the given owner.
 *
 * Runs two gh CLI calls:
 *   1. gh project list --owner {owner} --format json  → project select menu
 *   2. gh project field-list {number} --owner {owner} --format json  → field/option mapping
 *
 * Shows a summary box and asks the user to confirm before returning data.
 *
 * @param {string} owner  - GitHub org or username (user-typed via \`input()\` — untrusted)
 * @returns {Promise<{projectNumber: number, projectId: string, fieldIds: object, optionIds: object} | null>}
 *   Resolved project board config, or null if skipped / discovery failed.
 *
 * @security \`owner\` is a raw user-typed value from an interactive prompt and is UNTRUSTED.
 *   All gh CLI invocations in this function MUST use \`execFileSync\` with an argument array —
 *   never interpolate \`owner\` into an \`execSync\` shell string. execFileSync does not invoke
 *   a shell, so metacharacters in \`owner\` are treated literally and cannot escape argument
 *   boundaries. (Ref: review-finding #149 — PR #148 originally used execSync template literals)
 */
async function discoverProjectBoard(owner) {
  // Non-TTY: skip auto-discovery — can't prompt
  if (!process.stdout.isTTY) {
    return null;
  }

  console.log("");
  console.log(bold("  Project Board"));
  console.log(dim("  Searching for GitHub Projects v2…"));

  // -------------------------------------------------------------------------
  // Step 1: List projects
  // -------------------------------------------------------------------------
  let projects = [];
  try {
    const raw = execFileSync(
      "gh",
      ["project", "list", "--owner", owner, "--format", "json"],
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const parsed = JSON.parse(raw);
    projects = parsed.projects || [];
  } catch {
    // gh not available, auth failure, or no projects access — fall back silently
    console.log(
      dim("  Could not list projects — falling back to manual entry."),
    );
    return null;
  }

  if (projects.length === 0) {
    console.log(dim("  No GitHub Projects v2 boards found for this owner."));
    console.log(
      dim(
        "  You can add project_board configuration manually in forge.yaml later.",
      ),
    );
    return null;
  }

  // Build select menu choices
  const projectChoices = projects.map((p) => ({
    label: `${p.title}  ${dim("(#" + p.number + ", " + (p.items?.totalCount ?? "?") + " items)")}`,
    value: p.number,
  }));
  projectChoices.push({
    label: dim("Skip — configure project board manually later"),
    value: null,
  });

  console.log("");
  const selectedNumber = await select(
    "  Which GitHub Project board?",
    projectChoices,
  );
  if (selectedNumber === null) {
    return null;
  }

  // Look up the selected project's id
  const selectedProject = projects.find((p) => p.number === selectedNumber);
  const projectId = selectedProject?.id ?? "";
  const projectTitle = _sanitizeYamlValue(
    selectedProject?.title ?? `Project #${selectedNumber}`,
  );

  // -------------------------------------------------------------------------
  // Step 2: Fetch field list
  // -------------------------------------------------------------------------
  console.log("");
  console.log(dim("  Fetching project fields…"));

  let fields = [];
  try {
    const raw = execFileSync(
      "gh",
      [
        "project",
        "field-list",
        String(selectedNumber),
        "--owner",
        owner,
        "--format",
        "json",
      ],
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const parsed = JSON.parse(raw);
    fields = (parsed.fields || []).filter(
      (f) => f.type === "ProjectV2SingleSelectField",
    );
  } catch {
    console.log(
      dim("  Could not fetch project fields — falling back to manual entry."),
    );
    return null;
  }

  // -------------------------------------------------------------------------
  // Step 3: Match fields and options by name
  // -------------------------------------------------------------------------

  /**
   * Match a field by checking if its name case-insensitively includes the target keyword.
   * Returns the field or null.
   */
  function matchField(keyword) {
    // Exact match first (case-insensitive)
    const exact = fields.find(
      (f) => f.name.toLowerCase() === keyword.toLowerCase(),
    );
    if (exact) return { field: exact, fuzzy: false };
    // Fuzzy: name contains keyword
    const fuzzy = fields.find((f) =>
      f.name.toLowerCase().includes(keyword.toLowerCase()),
    );
    if (fuzzy) return { field: fuzzy, fuzzy: true };
    return null;
  }

  // Known field keys and their expected name keywords
  const FIELD_TARGETS = [
    { key: "status", keywords: ["status"] },
    { key: "lane", keywords: ["lane", "track"] },
    { key: "component", keywords: ["component"] },
    { key: "priority", keywords: ["priority"] },
    { key: "workflow", keywords: ["workflow"] },
  ];

  // Known option name → forge.yaml key mappings per field
  const OPTION_MAPS = {
    status: { todo: "todo", "in progress": "in_progress", done: "done" },
    lane: { fast: "fast", feature: "feature", sync: "sync" },
    priority: { p0: "p0", p1: "p1", p2: "p2", p3: "p3" },
    workflow: {
      investigating: "investigating",
      "ready to build": "ready_to_build",
      building: "building",
      "in review": "in_review",
      merged: "merged",
      invalid: "invalid",
      decomposed: "decomposed",
    },
    component: {}, // component options vary by project — map all options by slugifying the name
  };

  const resolvedFieldIds = {};
  const resolvedOptionIds = {};
  const fuzzyMatches = [];

  for (const target of FIELD_TARGETS) {
    let match = null;
    for (const kw of target.keywords) {
      match = matchField(kw);
      if (match) break;
    }
    if (!match) continue;

    const { field, fuzzy } = match;
    if (fuzzy) {
      fuzzyMatches.push({ key: target.key, fieldName: field.name });
    }
    resolvedFieldIds[target.key] = field.id;

    // Map option IDs
    const optMap = OPTION_MAPS[target.key] ?? {};
    const mappedOptions = {};

    if (target.key === "component") {
      // For component, map every option by slugifying its name (a–z, 0–9, underscore)
      for (const opt of field.options || []) {
        const slug = opt.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "");
        mappedOptions[slug] = opt.id;
      }
    } else {
      for (const opt of field.options || []) {
        const nameLower = opt.name.toLowerCase();
        const mappedKey = optMap[nameLower];
        if (mappedKey) {
          mappedOptions[mappedKey] = opt.id;
        }
      }
    }

    if (Object.keys(mappedOptions).length > 0) {
      resolvedOptionIds[target.key] = mappedOptions;
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Confirm fuzzy matches (if any)
  // -------------------------------------------------------------------------
  for (const { key, fieldName } of fuzzyMatches) {
    console.log("");
    console.log(
      yellow(
        `  Fuzzy match: field "${fieldName}" mapped to forge.yaml key "${key}"`,
      ),
    );
    const accepted = await confirm(
      `  Accept this mapping (${fieldName} → ${key})?`,
      true,
    );
    if (!accepted) {
      delete resolvedFieldIds[key];
      delete resolvedOptionIds[key];
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Show summary box and confirm
  // -------------------------------------------------------------------------
  const summaryLines = [
    `Project:    ${projectTitle} (#${selectedNumber})`,
    `Project ID: ${projectId}`,
    "",
    "Fields:",
  ];
  for (const [key, id] of Object.entries(resolvedFieldIds)) {
    const optCount = resolvedOptionIds[key]
      ? Object.keys(resolvedOptionIds[key]).length
      : 0;
    const optLabel =
      optCount > 0 ? ` (${optCount} options)` : " (no options mapped)";
    summaryLines.push(`  ${key.padEnd(10)}: ${id}${optLabel}`);
  }
  const unmapped = FIELD_TARGETS.map((t) => t.key).filter(
    (k) => !resolvedFieldIds[k],
  );
  if (unmapped.length > 0) {
    summaryLines.push("");
    summaryLines.push(
      `Not found:  ${unmapped.join(", ")} — placeholders will be used`,
    );
  }

  console.log("");
  console.log(box(summaryLines, { title: "Project Board Config" }));

  const confirmed = await confirm("  Use this configuration?", true);
  if (!confirmed) {
    console.log(
      dim(
        "  Skipped auto-discovery. You can add project_board manually in forge.yaml.",
      ),
    );
    return null;
  }

  return {
    projectNumber: selectedNumber,
    projectId,
    fieldIds: resolvedFieldIds,
    optionIds: resolvedOptionIds,
  };
}

/**
 * Build the forge.yaml file content string from gathered values.
 * Required sections are always written as active YAML.
 * Optional sections are written as active YAML when config is provided in `optionalSections`,
 * or as commented-out placeholders when absent.
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.projectName
 * @param {string} opts.description
 * @param {string} opts.root
 * @param {string} opts.worktreeBase
 * @param {string} opts.defaultBranch
 * @param {string} opts.stagingBranch
 * @param {object} [opts.optionalSections] - Optional section configs; absent key = commented-out
 * @param {object} [opts.optionalSections.projectBoard] - project_board section config
 * @param {object} [opts.optionalSections.multiRepo]    - repos section config
 * @param {object} [opts.optionalSections.review]       - review section config
 * @param {object} [opts.optionalSections.verification] - verification section config
 */
function buildForgeYamlContent({
  owner,
  repo,
  projectName,
  description,
  root,
  worktreeBase,
  defaultBranch,
  stagingBranch,
  optionalSections = {},
}) {
  // Sanitize all user-supplied string values before template interpolation to prevent
  // YAML injection via double-quotes or embedded newlines in double-quoted scalars.
  owner = _sanitizeYamlValue(owner);
  repo = _sanitizeYamlValue(repo);
  projectName = _sanitizeYamlValue(projectName);
  description = _sanitizeYamlValue(description);
  defaultBranch = _sanitizeYamlValue(defaultBranch);
  stagingBranch = _sanitizeYamlValue(stagingBranch);
  // Path values: also escape backslashes so Windows paths are valid YAML.
  // Preserve rawRoot for use in path.join() operations — join() expects raw OS paths,
  // not YAML-escaped strings. Always apply _sanitizePathValue() to the join() result.
  const rawRoot = root;
  root = _sanitizePathValue(root);
  worktreeBase = _sanitizePathValue(worktreeBase);

  const { projectBoard, multiRepo, review, verification } = optionalSections;

  // Sanitize optional-section user-supplied strings.
  const safeMultiRepo = multiRepo
    ? {
        prefix: _sanitizeYamlValue(multiRepo.prefix || "sat"),
        satelliteRepo: _sanitizeYamlValue(
          multiRepo.satelliteRepo || "your-satellite-repo",
        ),
        satelliteBranch: _sanitizeYamlValue(
          multiRepo.satelliteBranch || "main",
        ),
      }
    : null;

  const safeReview = review
    ? {
        techStack: _sanitizeYamlValue(
          review.techStack || "Node.js, TypeScript, PostgreSQL",
        ),
        // context uses a block scalar (|) — only strip double-quotes; newlines are handled by split/join
        context: (
          review.context || "Add architecture notes and conventions here."
        ).replace(/"/g, ""),
      }
    : null;

  const safeVerification = verification
    ? {
        healthEndpoint: _sanitizeYamlValue(
          verification.healthEndpoint || `https://api.${repo}.io/health`,
        ),
      }
    : null;

  // --- repos section ---
  const reposSection = safeMultiRepo
    ? `repos:
  default:
    repo: "${owner}/${repo}"
    staging_branch: "${stagingBranch}"
  satellites:
    - prefix: "${safeMultiRepo.prefix}"
      repo: "${owner}/${safeMultiRepo.satelliteRepo}"
      staging_branch: "${safeMultiRepo.satelliteBranch}"
      local_path: "${_sanitizePathValue(join(rawRoot, "..", safeMultiRepo.satelliteRepo))}"`
    : `# repos:
#   default:
#     repo: "${owner}/${repo}"
#     staging_branch: "${stagingBranch}"
#   satellites:
#     - prefix: "mcp"
#       repo: "${owner}/your-satellite-repo"
#       staging_branch: "main"
#       local_path: "${_sanitizePathValue(join(rawRoot, "..", "your-satellite-repo"))}"`;

  // --- project_board section ---
  // Build field_ids block — use resolved IDs where available, placeholders otherwise
  const FIELD_KEYS = ["status", "lane", "component", "priority", "workflow"];
  const resolvedFieldIds = projectBoard?.fieldIds ?? {};
  const resolvedOptionIds = projectBoard?.optionIds ?? {};

  // Sanitize all LLM-derived project_board string values before YAML interpolation.
  // projectId and fieldIds come from the LLM enrichment path (_optionalSectionsFromDraft)
  // and must be treated as untrusted — a crafted response containing a double-quote or
  // newline would break out of the YAML double-quoted scalar.
  // projectNumber is numeric (unquoted in YAML) and does not need sanitization.
  // <!-- Added: forge#384 -->
  const safeProjectBoard = projectBoard
    ? {
        projectId: _sanitizeYamlValue(projectBoard.projectId ?? ""),
        projectNumber: projectBoard.projectNumber,
        fieldIds: Object.fromEntries(
          FIELD_KEYS.map((k) => [
            k,
            _sanitizeYamlValue(resolvedFieldIds[k] ?? ""),
          ]),
        ),
        optionIds: projectBoard.optionIds,
      }
    : null;

  /**
   * Build a YAML block for option_ids given a nested map of { fieldKey: { optionKey: id } }.
   * Only writes fields that have at least one mapped option.
   */
  function _buildOptionIdsBlock(optionIds) {
    const entries = Object.entries(optionIds).filter(
      ([, opts]) => Object.keys(opts).length > 0,
    );
    if (entries.length === 0) return "";
    const lines = ["  option_ids:"];
    for (const [fieldKey, opts] of entries) {
      lines.push(`    ${fieldKey}:`);
      for (const [optKey, optId] of Object.entries(opts)) {
        lines.push(`      ${optKey}: "${_sanitizeYamlValue(String(optId))}"`);
      }
    }
    return "\n" + lines.join("\n");
  }

  const fieldIdsBlock = FIELD_KEYS.map(
    (k) =>
      `    ${k}: "${safeProjectBoard?.fieldIds[k] || "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"}"`,
  ).join("\n");

  const optionIdsBlock = projectBoard?.optionIds
    ? _buildOptionIdsBlock(resolvedOptionIds)
    : "";

  const hasDiscoveredId = !!(safeProjectBoard?.projectId);

  const projectBoardSection = projectBoard
    ? `project_board:
  owner: "${owner}"
  project_number: ${projectBoard.projectNumber || 1}
  project_id: "${hasDiscoveredId ? safeProjectBoard.projectId : "PVT_kwHOxxxxxxxxxxxxxxxx"}"
  field_ids:
${fieldIdsBlock}${optionIdsBlock}${!hasDiscoveredId ? `\n# To find IDs: gh project field-list ${projectBoard.projectNumber || 1} --owner ${owner}` : ""}`
    : `# project_board:
#   owner: "${owner}"
#   project_number: 1
#   project_id: "PVT_kwHOxxxxxxxxxxxxxxxx"
#   field_ids:
#     status: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
#     lane: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
#     component: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
#     priority: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
#     workflow: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"`;

  // --- review section ---
  const reviewSection = safeReview
    ? `review:
  tech_stack: "${safeReview.techStack}"
  context: |
    ${safeReview.context.split("\n").join("\n    ")}`
    : `# review:
#   tech_stack: "Node.js, TypeScript, PostgreSQL"
#   context: |
#     Describe your repo structure and any unusual conventions here.`;

  // --- verification section ---
  const verificationSection = safeVerification
    ? `verification:
  health_endpoint: "${safeVerification.healthEndpoint}"
  health_patterns:
    - '"status": "ok"'`
    : `# verification:
#   health_endpoint: "https://api.${repo}.io/health"
#   health_patterns:
#     - '"status": "ok"'`;

  return `# forge.yaml — ForgeDock Configuration
#
# Generated by: npx forgedock init
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
  description: "${description}"

# =============================================================================
# PATHS (REQUIRED)
# =============================================================================

paths:
  root: "${root}"
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

${reposSection}

# =============================================================================
# PROJECT BOARD (OPTIONAL)
# GitHub Projects v2 integration.
# To find IDs: gh project list --owner ${owner}
# =============================================================================

${projectBoardSection}

# =============================================================================
# REVIEW (OPTIONAL)
# Context injected into review agent prompts.
# =============================================================================

${reviewSection}

# =============================================================================
# VERIFICATION (OPTIONAL)
# Health-check patterns for quality gate and validate commands.
# =============================================================================

${verificationSection}
`;
}

/**
 * Mapping from annotatedReviewScreen field keys to the YAML key patterns they
 * correspond to in the generated forge.yaml. Used to inject TODO comments.
 * Each entry is the leading whitespace + key prefix that identifies the line.
 */
const TODO_FIELD_YAML_KEYS = {
  owner:         "  owner:",
  repo:          "  repo:",
  name:          "  name:",
  description:   "  description:",
  root:          "  root:",
  worktreeBase:  "  worktree_base:",
  defaultBranch: "  default:",
  stagingBranch: "  staging:",
};

/**
 * Inject `# TODO(forgedock:<fieldKey>)` comments above each low-confidence
 * field line in the YAML content string.
 *
 * The comment is inserted as a full line above the matching key line.
 * Example output:
 *   # TODO(forgedock:owner) — low-confidence: verify and update
 *   owner: "your-github-org"
 *
 * @param {string} content - Generated forge.yaml content
 * @param {string[]} lowConfidenceKeys - Array of field key strings to flag
 * @returns {string} - Content with TODO comments injected
 */
function _injectTodoComments(content, lowConfidenceKeys) {
  if (!lowConfidenceKeys || lowConfidenceKeys.length === 0) return content;

  const lines = content.split("\n");
  const result = [];

  for (const line of lines) {
    // Check if this line matches any low-confidence field key pattern.
    for (const key of lowConfidenceKeys) {
      const pattern = TODO_FIELD_YAML_KEYS[key];
      if (pattern && line.startsWith(pattern)) {
        // Insert the TODO comment above the key line (same indentation).
        const indent = line.match(/^(\s*)/)[1];
        result.push(`${indent}# TODO(forgedock:${key}) — low-confidence: verify and update`);
        break;
      }
    }
    result.push(line);
  }

  return result.join("\n");
}

/** Write forge.yaml to disk. Accepts all params for buildForgeYamlContent plus outputPath and lowConfidenceKeys. */
function _writeForgeYaml(opts) {
  let content = buildForgeYamlContent(opts);
  // Inject TODO comments for low-confidence fields detected during review.
  if (opts.lowConfidenceKeys && opts.lowConfidenceKeys.length > 0) {
    content = _injectTodoComments(content, opts.lowConfidenceKeys);
  }
  writeFileSync(opts.outputPath, content, "utf-8");
}

/** Print next-steps guidance after forge.yaml is written. */
function _printNextSteps({ remoteDetected }) {
  console.log(`${BOLD}Next steps:${RESET}`);
  if (!remoteDetected) {
    console.log(
      `  ${YELLOW}!${RESET}  Edit ${CYAN}forge.yaml${RESET} — set project.owner and project.repo`,
    );
  }
  console.log(
    `  1. Add ${CYAN}forge.yaml${RESET} to ${CYAN}.gitignore${RESET} if it contains sensitive paths`,
  );
  console.log(
    `  2. Run ${CYAN}/forgedock-init${RESET} inside Claude Code for guided AI-powered setup`,
  );
  console.log("");
}

// ---------------------------------------------------------------------------
// Config Validation
// ---------------------------------------------------------------------------

/**
 * Parse a simple top-level YAML key from a forge.yaml string.
 * Only handles the specific patterns used in forge.yaml required sections.
 *
 * @param {string} content - File content
 * @param {string} key     - Dotted key, e.g. "project.owner"
 * @returns {string}       - Trimmed value with surrounding quotes stripped, or empty string if not found
 *
 * @security Values returned by this function are UNTRUSTED user-controlled strings from forge.yaml.
 *   - Callers MUST pass returned values as discrete arguments to execFileSync (args array) — never
 *     interpolate into an execSync shell command string.
 *   - execFileSync does not invoke a shell, so metacharacters in values are treated literally.
 *   - When interpolation into a string argument is unavoidable (e.g. GraphQL query fields),
 *     validate the value against a strict allowlist regex before use.
 */
function _parseYamlKey(content, key) {
  const parts = key.split(".");
  const lines = content.split("\n");

  if (parts.length === 2) {
    const [section, field] = parts;
    let inSection = false;
    for (const line of lines) {
      if (/^[a-z_]+:/.test(line)) {
        inSection = line.startsWith(`${section}:`);
        continue;
      }
      if (inSection && line.startsWith(`  ${field}:`)) {
        const raw = line.replace(`  ${field}:`, "").trim();
        return raw.replace(/^["']|["']$/g, "");
      }
    }
  }
  return "";
}

/**
 * Check whether a YAML section is active (uncommented) in the content.
 * @param {string} content
 * @param {string} section - top-level section name, e.g. "project_board"
 * @returns {boolean}
 */
function _sectionActive(content, section) {
  return content.split("\n").some((line) => line === `${section}:`);
}

/**
 * Extract all satellite repo values from an active repos: section.
 * Returns an array of "owner/repo" strings from lines like:
 *   repo: "owner/satellite-repo"
 * under the satellites: list (skipping the default: sub-key).
 *
 * @param {string} content
 * @returns {string[]}
 */
function _parseSatelliteRepos(content) {
  const lines = content.split("\n");
  const repos = [];
  let inRepos = false;
  let inSatellites = false;

  for (const line of lines) {
    if (/^[a-z_]+:/.test(line)) {
      inRepos = line.startsWith("repos:");
      inSatellites = false;
      continue;
    }
    if (!inRepos) continue;

    if (line.trim() === "default:") {
      continue;
    }
    if (line.trim() === "satellites:") {
      inSatellites = true;
      continue;
    }

    if (inSatellites && /^\s{6,}repo:/.test(line)) {
      const raw = line
        .replace(/^\s+repo:\s*/, "")
        .replace(/^["']|["']$/g, "")
        .trim();
      if (raw) repos.push(raw);
    }
  }
  return repos;
}

/**
 * Validate the forge.yaml at the given path.
 *
 * Runs a series of checks and renders a summary box.
 * Never throws — all check failures are surfaced as warnings/errors in the output.
 *
 * @param {string} forgeYamlPath - Absolute path to forge.yaml
 * @returns {Promise<{ passed: boolean, checks: Array<{label: string, status: 'ok'|'warn'|'error', note: string}> }>}
 */
async function validate(forgeYamlPath) {
  /** @type {Array<{label: string, status: 'ok'|'warn'|'error', note: string}>} */
  const checks = [];

  // 1. Read forge.yaml
  if (!existsSync(forgeYamlPath)) {
    checks.push({
      label: "forge.yaml found",
      status: "error",
      note: `Not found: ${forgeYamlPath}`,
    });
    _renderValidationSummary(checks);
    await _offerRemediations(checks, forgeYamlPath);
    return { passed: false, checks };
  }

  let content;
  try {
    content = readFileSync(forgeYamlPath, "utf-8");
  } catch (err) {
    checks.push({
      label: "forge.yaml found",
      status: "error",
      note: `Cannot read: ${err.message}`,
    });
    _renderValidationSummary(checks);
    await _offerRemediations(checks, forgeYamlPath);
    return { passed: false, checks };
  }

  checks.push({ label: "forge.yaml found", status: "ok", note: forgeYamlPath });

  // 2. Required fields
  const PLACEHOLDERS = new Set([
    "your-github-org",
    "your-repo-name",
    "",
    "your-org",
    "your-repo",
  ]);

  const owner = _parseYamlKey(content, "project.owner");
  const repo = _parseYamlKey(content, "project.repo");
  const root = _parseYamlKey(content, "paths.root");
  const worktreeBase = _parseYamlKey(content, "paths.worktree_base");
  const defaultBranch = _parseYamlKey(content, "branches.default");

  const missingFields = [];
  if (!owner || PLACEHOLDERS.has(owner)) missingFields.push("project.owner");
  if (!repo || PLACEHOLDERS.has(repo)) missingFields.push("project.repo");
  if (!root) missingFields.push("paths.root");
  if (!defaultBranch) missingFields.push("branches.default");

  if (missingFields.length === 0) {
    checks.push({
      label: "Required fields",
      status: "ok",
      note: `${owner}/${repo}`,
    });
  } else {
    checks.push({
      label: "Required fields",
      status: "error",
      note: `Missing or placeholder: ${missingFields.join(", ")}`,
    });
  }

  // 3. paths.root exists
  if (root) {
    if (existsSync(root)) {
      checks.push({ label: "paths.root exists", status: "ok", note: root });
    } else {
      checks.push({
        label: "paths.root exists",
        status: "warn",
        note: `Directory not found: ${root}`,
      });
    }
  }

  // 4. Create worktree_base if missing
  if (worktreeBase) {
    if (existsSync(worktreeBase)) {
      checks.push({
        label: "worktree_base exists",
        status: "ok",
        note: worktreeBase,
      });
    } else {
      try {
        await mkdir(worktreeBase, { recursive: true });
        checks.push({
          label: "worktree_base exists",
          status: "ok",
          note: `Created: ${worktreeBase}`,
        });
      } catch (err) {
        checks.push({
          label: "worktree_base exists",
          status: "warn",
          note: `Cannot create: ${err.message}`,
        });
      }
    }
  }

  // 5. GitHub repo access
  if (owner && repo && !PLACEHOLDERS.has(owner) && !PLACEHOLDERS.has(repo)) {
    try {
      execFileSync(
        "gh",
        ["repo", "view", `${owner}/${repo}`, "--json", "name"],
        {
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10000,
        },
      );
      checks.push({
        label: "GitHub repo accessible",
        status: "ok",
        note: `${owner}/${repo}`,
      });
    } catch {
      checks.push({
        label: "GitHub repo accessible",
        status: "warn",
        note: `Cannot access ${owner}/${repo} — check owner/repo or run: gh auth login`,
      });
    }
  } else {
    checks.push({
      label: "GitHub repo accessible",
      status: "warn",
      note: "Skipped — owner/repo not set",
    });
  }

  // 6. Branch existence on remote
  const stagingBranch = _parseYamlKey(content, "branches.staging");
  const branchesToCheck = [
    ...new Set([defaultBranch, stagingBranch].filter(Boolean)),
  ];

  if (root && existsSync(root) && branchesToCheck.length > 0) {
    for (const branch of branchesToCheck) {
      try {
        const result = execFileSync(
          "git",
          ["ls-remote", "--heads", "origin", branch],
          {
            cwd: root,
            stdio: ["pipe", "pipe", "pipe"],
            encoding: "utf-8",
            timeout: 10000,
          },
        );
        if (result.trim()) {
          checks.push({
            label: `Branch: ${branch}`,
            status: "ok",
            note: "Exists on remote",
          });
        } else {
          checks.push({
            label: `Branch: ${branch}`,
            status: "warn",
            note: "Not found on remote",
          });
        }
      } catch {
        checks.push({
          label: `Branch: ${branch}`,
          status: "warn",
          note: "Cannot verify — git error",
        });
      }
    }
  }

  // 7. Project board validation
  if (_sectionActive(content, "project_board")) {
    const projectId = _parseYamlKey(content, "project_board.project_id");
    if (!projectId || projectId.includes("xxxx")) {
      checks.push({
        label: "Project board configured",
        status: "warn",
        note: "project_id is a placeholder — run /forgedock-init to configure",
      });
    } else if (!/^PVT_[A-Za-z0-9_=\-]+$/.test(projectId)) {
      checks.push({
        label: "Project board configured",
        status: "error",
        note: `project_id must match /^PVT_[A-Za-z0-9_=\\-]+$/ (got: ${projectId.slice(0, 12)}...)`,
      });
    } else {
      try {
        // Use -F (typed variable) to pass projectId as a GraphQL variable rather than
        // interpolating it into the query string, even though the regex above already
        // validates it to safe characters.
        const result = execFileSync(
          "gh",
          [
            "api",
            "graphql",
            "-F",
            `id=${projectId}`,
            "-f",
            "query=query($id: ID!) { node(id: $id) { id __typename } }",
          ],
          {
            stdio: ["pipe", "pipe", "pipe"],
            encoding: "utf-8",
            timeout: 10000,
          },
        );
        const parsed = JSON.parse(result);
        if (parsed?.data?.node?.id) {
          checks.push({
            label: "Project board configured",
            status: "ok",
            note: `${projectId.slice(0, 16)}... resolves`,
          });
        } else {
          checks.push({
            label: "Project board configured",
            status: "warn",
            note: "project_id may be invalid — verify with: gh project list",
          });
        }
      } catch {
        checks.push({
          label: "Project board configured",
          status: "warn",
          note: "Cannot verify project_id — gh error",
        });
      }
    }
  } else {
    checks.push({
      label: "Project board",
      status: "warn",
      note: "Not configured (optional)",
    });
  }

  // 8. Satellite repo access
  if (_sectionActive(content, "repos")) {
    const satellites = _parseSatelliteRepos(content);
    if (satellites.length === 0) {
      checks.push({
        label: "Satellite repos",
        status: "warn",
        note: "repos: section active but no satellites found",
      });
    } else {
      for (const sat of satellites) {
        try {
          execFileSync("gh", ["repo", "view", sat, "--json", "name"], {
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 10000,
          });
          checks.push({
            label: `Satellite: ${sat}`,
            status: "ok",
            note: "Accessible",
          });
        } catch {
          checks.push({
            label: `Satellite: ${sat}`,
            status: "warn",
            note: "Cannot access — check repo name or gh auth",
          });
        }
      }
    }
  } else {
    checks.push({
      label: "Satellite repos",
      status: "warn",
      note: "Not configured (optional)",
    });
  }

  _renderValidationSummary(checks);
  await _offerRemediations(checks, forgeYamlPath);
  const hasError = checks.some((c) => c.status === "error");
  return { passed: !hasError, checks };
}

/**
 * Offer plain-language explanations and optional auto-fixes for each failing check.
 *
 * Runs after _renderValidationSummary() so the summary is always visible first.
 * For each check that is not 'ok':
 *   - Prints a plain-language sentence explaining why it matters and what to do.
 *   - Prints a copy-paste command where applicable.
 *   - For safe, deterministic fixes (directory creation, gh auth), offers an
 *     auto-apply step gated on a TTY confirmation prompt.
 *
 * Non-destructive policy:
 *   - Never auto-edits forge.yaml values.
 *   - Never auto-applies project board ID changes.
 *   - Auto-mkdir is offered only when the user explicitly listed the path in forge.yaml.
 *   - Spawning `gh auth login` is offered only in TTY environments.
 *   - Non-TTY: prints copy-paste text only, skips all interactive prompts.
 *
 * @param {Array<{label: string, status: 'ok'|'warn'|'error', note: string}>} checks
 * @param {string} forgeYamlPath - Absolute path to forge.yaml (used in explanations)
 * @returns {Promise<void>}
 */
async function _offerRemediations(checks, forgeYamlPath) {
  // Collect only failing checks — skip 'ok' and purely-optional skipped checks
  // that have no actionable remediation (e.g. "Not configured (optional)").
  const failing = checks.filter(
    (c) =>
      c.status !== "ok" &&
      !c.note.endsWith("(optional)") &&
      c.note !== "Not configured (optional)",
  );

  if (failing.length === 0) return;

  /** Whether we're in an interactive terminal — gates all prompts. */
  const isTTY = Boolean(process.stdin.isTTY);

  // Print section header
  console.log("");
  console.log(`  ${bold("Remediation guide:")}`);

  for (const check of failing) {
    const label = check.label;
    const note = check.note ?? "";
    const isError = check.status === "error";

    // ── 1. forge.yaml not found ─────────────────────────────────────────────
    if (label === "forge.yaml found") {
      console.log("");
      console.log(
        `  ${isError ? red("✗") : yellow("!")} ${bold(label)}`,
      );
      console.log(
        `    ForgeDock reads ${cyan("forge.yaml")} from your project root to know which`,
      );
      console.log(
        `    GitHub repo, branches, and paths to use. Without it, no pipeline commands`,
      );
      console.log(`    will function correctly.`);
      console.log(
        `    ${bold("Fix:")} Generate forge.yaml with AI assistance:`,
      );
      console.log(`      ${cyan("npx forgedock init")}`);
      continue;
    }

    // ── 2. Required fields missing ──────────────────────────────────────────
    if (label === "Required fields") {
      // Extract the field names from the note
      const missingMatch = note.match(/Missing or placeholder:\s*(.+)/);
      const fields = missingMatch ? missingMatch[1] : note;
      console.log("");
      console.log(`  ${isError ? red("✗") : yellow("!")} ${bold(label)}`);
      console.log(
        `    The following fields are required but missing or still set to`,
      );
      console.log(`    placeholder values: ${cyan(fields)}`);
      console.log(
        `    ForgeDock uses these to route all GitHub API calls and git operations.`,
      );
      console.log(
        `    ${bold("Fix:")} Open ${cyan("forge.yaml")} and fill in the real values:`,
      );
      for (const field of fields.split(",").map((f) => f.trim())) {
        let hint = "";
        if (field === "project.owner")
          hint = `  # your GitHub org or username`;
        else if (field === "project.repo")
          hint = `  # the repository name (without the owner prefix)`;
        else if (field === "paths.root")
          hint = `  # absolute path to this project on your machine`;
        else if (field === "branches.default")
          hint = `  # usually "main" or "master"`;
        console.log(`      ${cyan(field)}: "<value>"${dim(hint)}`);
      }
      continue;
    }

    // ── 3. paths.root does not exist ────────────────────────────────────────
    if (label === "paths.root exists") {
      const pathMatch = note.match(/Directory not found:\s*(.+)/);
      const missingPath = pathMatch ? pathMatch[1].trim() : note;
      console.log("");
      console.log(`  ${yellow("!")} ${bold(label)}`);
      console.log(
        `    ForgeDock uses ${cyan("paths.root")} as the base directory for all git`,
      );
      console.log(
        `    worktrees and file operations. The configured path does not exist:`,
      );
      console.log(`      ${dim(missingPath)}`);
      console.log(
        `    ${bold("Option A:")} If this is your project directory, create it:`,
      );
      console.log(`      ${cyan(`mkdir -p "${missingPath}"`)}`);
      console.log(
        `    ${bold("Option B:")} If the project already exists elsewhere, update forge.yaml:`,
      );
      console.log(
        `      ${cyan("paths.root")}: "<correct absolute path to your project>"`,
      );

      // Offer auto-mkdir if TTY — safe because the user explicitly listed this path
      if (isTTY) {
        console.log("");
        const shouldCreate = await confirm(
          `  Create ${dim(missingPath)} now?`,
          false,
        );
        if (shouldCreate) {
          try {
            await mkdir(missingPath, { recursive: true });
            console.log(`    ${green("✔")} Created: ${dim(missingPath)}`);
          } catch (mkdirErr) {
            console.log(
              `    ${red("✖")} Could not create directory: ${mkdirErr.message}`,
            );
          }
        }
      }
      continue;
    }

    // ── 4. worktree_base cannot be created ──────────────────────────────────
    if (label === "worktree_base exists" && note.startsWith("Cannot create:")) {
      const errMsg = note.replace("Cannot create:", "").trim();
      console.log("");
      console.log(`  ${yellow("!")} ${bold(label)}`);
      console.log(
        `    ForgeDock could not create the worktree directory automatically.`,
      );
      console.log(`    Error: ${dim(errMsg)}`);
      console.log(
        `    Worktrees are temporary checkout directories used during builds.`,
      );
      console.log(
        `    ${bold("Fix:")} Check that the parent directory is writable, or update`,
      );
      console.log(
        `    ${cyan("paths.worktree_base")} in forge.yaml to a writable location.`,
      );
      continue;
    }

    // ── 5. GitHub repo inaccessible ─────────────────────────────────────────
    if (label === "GitHub repo accessible") {
      // Try to detect whether gh is unauthenticated vs wrong repo name
      let isAuthIssue = false;
      try {
        execFileSync("gh", ["auth", "status"], {
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
        });
      } catch {
        isAuthIssue = true;
      }

      // Extract the repo slug from the note if possible
      const repoMatch = note.match(/Cannot access ([^\s]+)/);
      const repoSlug = repoMatch ? repoMatch[1] : "owner/repo";

      console.log("");
      console.log(`  ${yellow("!")} ${bold(label)}`);

      if (isAuthIssue) {
        console.log(
          `    The GitHub CLI is not authenticated. ForgeDock needs read access to`,
        );
        console.log(
          `    ${cyan(repoSlug)} to list issues, manage PRs, and run pipeline commands.`,
        );
        console.log(
          `    ${bold("Fix:")} Authenticate with the GitHub CLI:`,
        );
        console.log(`      ${cyan("gh auth login")}`);

        if (isTTY) {
          console.log("");
          const shouldAuth = await confirm(
            `  Run ${cyan("gh auth login")} now?`,
            false,
          );
          if (shouldAuth) {
            try {
              execSync("gh auth login", { stdio: "inherit" });
            } catch {
              // User may have cancelled — not an error from our side
            }
          }
        }
      } else {
        console.log(
          `    Cannot access ${cyan(repoSlug)}. The GitHub CLI is authenticated but`,
        );
        console.log(
          `    the repo may not exist, you may not have permission, or the owner/repo`,
        );
        console.log(`    values in forge.yaml are incorrect.`);
        console.log(`    ${bold("Fix:")} Verify the repo exists and is accessible:`);
        console.log(`      ${cyan(`gh repo view ${repoSlug}`)}`);
        console.log(
          `    Then update ${cyan("project.owner")} and ${cyan("project.repo")} in forge.yaml if needed.`,
        );
      }
      continue;
    }

    // ── 6. Branch not found on remote ───────────────────────────────────────
    if (label.startsWith("Branch: ")) {
      const branchName = label.replace("Branch: ", "").trim();
      console.log("");
      console.log(`  ${yellow("!")} ${bold(label)}`);
      console.log(
        `    Branch ${cyan(branchName)} was not found on the remote. ForgeDock uses`,
      );
      console.log(
        `    this branch for PRs and as a base for new work.`,
      );
      console.log(`    ${bold("Option A:")} Create and push the branch:`);
      console.log(
        `      ${cyan(`git checkout -b ${branchName} && git push -u origin ${branchName}`)}`,
      );
      console.log(
        `    ${bold("Option B:")} Update the branch name in forge.yaml to one that exists:`,
      );
      console.log(
        `      ${cyan("branches.default")} or ${cyan("branches.staging")} → the correct branch name`,
      );
      continue;
    }

    // ── 7. Project board not configured or invalid ──────────────────────────
    if (
      label === "Project board configured" ||
      label === "Project board"
    ) {
      if (note.includes("placeholder")) {
        console.log("");
        console.log(`  ${yellow("!")} ${bold(label)}`);
        console.log(
          `    The ${cyan("project_board.project_id")} in forge.yaml is still a placeholder.`,
        );
        console.log(
          `    This ID is required for the pipeline to move issues across the board automatically.`,
        );
        console.log(
          `    ${bold("Fix:")} Get your project ID from the GitHub CLI:`,
        );
        console.log(
          `      ${cyan("gh project list --owner <your-org-or-username>")}`,
        );
        console.log(
          `    Copy the ${cyan("PVT_...")} ID from the output and update ${cyan("project_board.project_id")} in forge.yaml.`,
        );
      } else if (isError) {
        // Malformed project_id
        console.log("");
        console.log(`  ${red("✗")} ${bold(label)}`);
        console.log(
          `    The ${cyan("project_board.project_id")} value does not match the expected`,
        );
        console.log(
          `    format (${cyan("PVT_...")} — a GitHub Projects GraphQL node ID).`,
        );
        console.log(`    ${bold("Fix:")} Look up your real project ID:`);
        console.log(
          `      ${cyan("gh project list --owner <your-org-or-username>")}`,
        );
        console.log(
          `    Replace the value in forge.yaml with the ${cyan("PVT_...")} ID shown.`,
        );
      } else if (note.includes("may be invalid")) {
        console.log("");
        console.log(`  ${yellow("!")} ${bold(label)}`);
        console.log(
          `    The ${cyan("project_board.project_id")} could not be verified via the GitHub API.`,
        );
        console.log(
          `    It may be invalid or the GitHub CLI may lack org-level permissions.`,
        );
        console.log(`    ${bold("Fix:")} Verify your project ID:`);
        console.log(
          `      ${cyan("gh project list --owner <your-org-or-username>")}`,
        );
      } else if (note.includes("gh error")) {
        console.log("");
        console.log(`  ${yellow("!")} ${bold(label)}`);
        console.log(
          `    Could not verify the project board ID — the GitHub API call failed.`,
        );
        console.log(
          `    This is usually a transient network issue or a permissions gap.`,
        );
        console.log(`    ${bold("Fix:")} Check your auth and try again:`);
        console.log(`      ${cyan("gh auth status")}`);
        console.log(
          `      ${cyan("gh project list --owner <your-org-or-username>")}`,
        );
      }
      continue;
    }

    // ── 8. Satellite repo inaccessible ──────────────────────────────────────
    if (label.startsWith("Satellite: ")) {
      const satRepo = label.replace("Satellite: ", "").trim();
      console.log("");
      console.log(`  ${yellow("!")} ${bold(label)}`);
      console.log(
        `    Cannot access satellite repo ${cyan(satRepo)}.`,
      );
      console.log(
        `    Satellite repos are used when your project spans multiple repositories.`,
      );
      console.log(`    ${bold("Fix:")} Verify the repo name and your access:`);
      console.log(`      ${cyan(`gh repo view ${satRepo}`)}`);
      console.log(
        `    If the repo name is wrong, update ${cyan("repos.satellites")} in forge.yaml.`,
      );
      console.log(
        `    If it is a private repo you cannot access, run: ${cyan("gh auth login")}`,
      );
      continue;
    }

    // ── 9. Satellite repos section misconfigured ─────────────────────────────
    if (label === "Satellite repos" && note.includes("no satellites found")) {
      console.log("");
      console.log(`  ${yellow("!")} ${bold(label)}`);
      console.log(
        `    The ${cyan("repos:")} section in forge.yaml is active (uncommented) but`,
      );
      console.log(
        `    contains no satellite entries. Either add satellites or comment out the section.`,
      );
      console.log(
        `    ${bold("Fix:")} Add a satellite entry or comment out the repos: section.`,
      );
      continue;
    }

    // ── Fallback: generic remediation for unexpected checks ──────────────────
    if (note && !note.endsWith("(optional)")) {
      console.log("");
      console.log(
        `  ${isError ? red("✗") : yellow("!")} ${bold(label)}: ${dim(note)}`,
      );
      console.log(
        `    Review the check above and update forge.yaml or run ${cyan("npx forgedock init")} to regenerate.`,
      );
    }
  }

  console.log("");
}

/**
 * Render the validation summary box to stdout.
 * @param {Array<{label: string, status: 'ok'|'warn'|'error', note: string}>} checks
 */
function _renderValidationSummary(checks) {
  const lines = [""];

  for (const check of checks) {
    let icon;
    let labelFn;
    if (check.status === "ok") {
      icon = green("✓");
      labelFn = (s) => s;
    } else if (check.status === "warn") {
      icon = yellow("!");
      labelFn = yellow;
    } else {
      icon = red("✗");
      labelFn = red;
    }

    const noteStr = check.note ? ` ${dim("(" + check.note + ")")}` : "";
    lines.push(`  ${icon} ${labelFn(check.label)}${noteStr}`);
  }

  const hasErrors = checks.some((c) => c.status === "error");
  const boardOk = checks.some(
    (c) => c.label === "Project board configured" && c.status === "ok",
  );

  lines.push("");
  lines.push(`  ${bold("Next steps:")}`);
  if (hasErrors) {
    lines.push(
      `  ${dim("•")} Edit ${cyan("forge.yaml")} to fix the errors above`,
    );
  }
  if (!boardOk) {
    lines.push(
      `  ${dim("•")} Run ${cyan("/forgedock-init")} for AI-powered optional section setup`,
    );
  }
  lines.push(
    `  ${dim("•")} Run ${cyan("/work-on next")} to start your first task`,
  );
  lines.push("");

  process.stdout.write(box(lines, { title: "Config Validation" }));
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
    } catch (err) {
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

// ---------------------------------------------------------------------------
// docs init — scaffold devdocs knowledge tree into a project
// ---------------------------------------------------------------------------

/**
 * Walk a directory tree and return all file paths (any extension).
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function _findAllFiles(dir) {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await _findAllFiles(full)));
    } else {
      results.push(full);
    }
  }
  return results.sort();
}

async function docsInit() {
  const cwd = process.cwd();

  // Resolve target devdocs path: forge.yaml → devdocs.path, default "devdocs/"
  let devdocsRelPath = "devdocs";
  const forgeYamlPath = join(cwd, "forge.yaml");
  if (existsSync(forgeYamlPath)) {
    try {
      const raw = readFileSync(forgeYamlPath, "utf-8");
      const parsed = _parseYamlKey(raw, "devdocs.path");
      if (parsed && parsed.trim()) {
        devdocsRelPath = _sanitizePathValue(parsed.trim().replace(/\/$/, ""));
      }
    } catch {
      // forge.yaml unreadable — use default
    }
  }

  const targetDir = isAbsolute(devdocsRelPath)
    ? devdocsRelPath
    : join(cwd, devdocsRelPath);

  // Security: assert targetDir is confined to the project directory.
  // Prevents path traversal via ../.. sequences, absolute paths, and symlinks in devdocs.path.
  //
  // Two hardening steps beyond the initial check:
  //
  // 1. realpath(cwd) — on Windows, process.cwd() may return a directory-junction path while
  //    realpath() returns the canonical target.  Comparing a canonical resolvedTarget against
  //    a non-canonical cwd would false-reject valid paths (BUG-3).
  //
  // 2. Walk-up-to-existing-ancestor resolution on ENOENT — when the target path does not yet
  //    exist, falling back to lexical resolve() fails to follow intermediate symlinks.  A
  //    symlink planted at "sub/" pointing outside the project would not be dereferenced, so
  //    the lexical result would appear inside the project and the containment check would
  //    pass, allowing mkdir() to write through the symlink (SEC-1).  Calling realpath() only
  //    one level up ("parent-first") still fails when the parent also does not exist (e.g.,
  //    devdocs.path = "sub/mid/leaf" where "sub" is a symlink but "sub/mid" is absent) —
  //    realpath("sub/mid") follows sub then ENOENT-s on mid, and the lexical fallback does
  //    not dereference sub (SEC-2).  Instead, walk up the directory hierarchy until finding
  //    an ancestor that exists, realpath() it to dereference any symlinks at that level, then
  //    reattach all collected suffix segments.
  const realCwd = await realpath(cwd).catch(() => resolve(cwd));
  let resolvedTarget;
  try {
    resolvedTarget = await realpath(targetDir);
  } catch {
    // targetDir does not exist — walk up the hierarchy to the nearest existing ancestor,
    // dereference it via realpath() to follow any intermediate symlinks, then reattach the
    // collected suffix segments.  Initialise resolvedTarget to the lexical path as a
    // last-resort sentinel (overwritten by the loop on the first successful realpath call).
    const trailSegments = [basename(targetDir)];
    let ancestor = dirname(targetDir);
    resolvedTarget = resolve(targetDir);
    while (true) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break; // reached filesystem root — keep lexical sentinel
      try {
        resolvedTarget = join(await realpath(ancestor), ...trailSegments);
        break;
      } catch {
        trailSegments.unshift(basename(ancestor));
        ancestor = parent;
      }
    }
  }
  if (resolvedTarget !== realCwd && !resolvedTarget.startsWith(realCwd + sep)) {
    console.log(
      `${RED}Error: devdocs.path must be inside the project directory.${RESET}`,
    );
    console.log(`  Resolved: ${resolvedTarget}`);
    console.log(`  Project:  ${realCwd}`);
    console.log(
      `  Fix: set ${CYAN}devdocs.path${RESET} to a relative path inside your project (e.g. "devdocs" or "docs/knowledge").`,
    );
    process.exit(1);
  }

  // Template source: templates/devdocs/ inside the ForgeDock package
  const templatesDir = join(FORGE_HOME, "templates", "devdocs");

  if (!existsSync(templatesDir)) {
    console.log(`${RED}DevDocs templates not found: ${templatesDir}${RESET}`);
    console.log(`  This usually means ForgeDock is not installed correctly.`);
    console.log(
      `  Try: ${CYAN}npm install -g forgedock${RESET} or ${CYAN}npx forgedock@latest docs init${RESET}`,
    );
    process.exit(1);
  }

  const templateFiles = await _findAllFiles(templatesDir);

  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — Scaffold DevDocs`);
  console.log(`  Source:  ${dim(templatesDir + "/")}`);
  console.log(`  Target:  ${dim(targetDir + "/")}`);
  console.log(`  Files:   ${templateFiles.length} seed files`);
  console.log("");

  // Use resolvedTarget (canonical path) rather than the raw targetDir string.  The
  // containment check above already resolved symlinks and validated the path; using the
  // canonical form here closes the TOCTOU window to the narrowest possible interval
  // and ensures mkdir does not follow a symlink that was NOT present when we checked.
  //
  // TOCTOU residual: a narrow window remains between the realpath check and this mkdir
  // on POSIX systems — a symlink planted at an intermediate path component during that
  // window could cause mkdir to create directories outside the project boundary.
  // Full elimination requires O_NOFOLLOW semantics (kernel-level, not available from
  // Node.js user-space).  We mitigate with a post-create re-validation below (SEC-5).
  await mkdir(resolvedTarget, { recursive: true });

  // SEC-5: Post-create re-validation — detect symlink planted during the TOCTOU window.
  // After mkdir succeeds, call realpath() on the now-existing directory to get its
  // canonical on-disk location.  If that location lies outside the project root a
  // symlink was planted between the containment check and the mkdir call.  In that case
  // we remove the directory tree that was created (wherever it landed) and abort.
  try {
    const postMkdirReal = await realpath(resolvedTarget);
    if (postMkdirReal !== realCwd && !postMkdirReal.startsWith(realCwd + sep)) {
      await rm(postMkdirReal, { recursive: true, force: true }).catch(() => {});
      console.log(
        `${RED}Error: devdocs directory escaped the project boundary after creation (TOCTOU).${RESET}`,
      );
      console.log(`  Created at: ${postMkdirReal}`);
      console.log(`  Project:    ${realCwd}`);
      console.log(
        `  A symlink was likely planted at an intermediate path component between the`,
      );
      console.log(
        `  containment check and the mkdir call.  The created directory has been removed.`,
      );
      process.exit(1);
    }
  } catch {
    // realpath() failure after a successful mkdir is unexpected; proceed — the directory
    // was created by us and the normal containment check already passed.
  }

  let copied = 0;
  let skipped = 0;

  for (const srcFile of templateFiles) {
    const rel = relative(templatesDir, srcFile);
    const destFile = join(resolvedTarget, rel);
    const destDir = dirname(destFile);

    await mkdir(destDir, { recursive: true });

    if (existsSync(destFile)) {
      skipped++;
      console.log(`  ${dim("skip")}  ${dim(rel)}`);
    } else {
      await copyFile(srcFile, destFile);
      copied++;
      console.log(`  ${green("+")}     ${rel}`);
    }
  }

  console.log("");
  if (copied > 0 && skipped === 0) {
    console.log(
      `${green("DevDocs scaffolded!")} ${copied} file${copied !== 1 ? "s" : ""} created in ${cyan(devdocsRelPath + "/")}.`,
    );
  } else if (copied > 0) {
    console.log(
      `${green("DevDocs scaffolded!")} ${copied} file${copied !== 1 ? "s" : ""} created, ${skipped} already existed (skipped).`,
    );
  } else {
    console.log(
      `${yellow("DevDocs already up to date.")} All ${skipped} file${skipped !== 1 ? "s" : ""} already exist — nothing was overwritten.`,
    );
  }

  console.log("");
  console.log(
    `  ${dim("Tip:")} Customise the files in ${cyan(devdocsRelPath + "/")} for your project.`,
  );
  console.log(
    `  ${dim("Agents read these files as authoritative project knowledge.")}`,
  );
  console.log("");
}

// ---------------------------------------------------------------------------
// enable / disable / status — per-directory state management
// ---------------------------------------------------------------------------

/**
 * Enable ForgeDock for a directory.
 *
 * - Clears any existing opt-out entry in the registry (so the directory becomes
 *   active again if it was previously disabled).
 * - Writes a lightweight `.forgedock` marker file if neither `forge.yaml` nor
 *   `.forgedock` already exists — this marks the directory as ForgeDock-managed
 *   before a full config is generated.
 *
 * @param {string} dir - Absolute path to the directory to enable.
 * @returns {Promise<void>}
 */
async function enableCommand(dir) {
  const absDir = resolve(dir);

  // Clear any opt-out entry so the directory becomes active
  await setOptOut(absDir, false);

  // Write .forgedock marker only if the directory is not already managed
  const hasForgeYaml = existsSync(join(absDir, "forge.yaml"));
  const hasMarker = existsSync(join(absDir, ".forgedock"));

  if (!hasForgeYaml && !hasMarker) {
    try {
      await writeFile(join(absDir, ".forgedock"), "", "utf-8");
      console.log(
        `${GREEN}✓${RESET} ForgeDock enabled for ${cyan(absDir)}`,
      );
      console.log(
        `  ${dim(".forgedock marker written — run")} ${cyan("npx forgedock init")} ${dim("to generate forge.yaml")}`,
      );
    } catch (err) {
      console.log(
        `${YELLOW}!${RESET} Could not write .forgedock marker: ${err.message}`,
      );
      console.log(
        `  ${dim("Opt-out cleared — directory will be treated as active once a marker or forge.yaml is added.")}`,
      );
    }
  } else {
    console.log(
      `${GREEN}✓${RESET} ForgeDock enabled for ${cyan(absDir)}`,
    );
    if (hasForgeYaml) {
      console.log(`  ${dim("forge.yaml already present — directory is managed.")}`);
    } else {
      console.log(`  ${dim(".forgedock marker already present — directory is managed.")}`);
    }
  }
}

/**
 * Disable ForgeDock for a directory.
 *
 * Records an explicit opt-out in the central registry so the SessionStart hook
 * stays completely silent in this directory. The `.forgedock` marker (if present)
 * is left untouched — re-enabling simply clears the opt-out entry.
 *
 * @param {string} dir - Absolute path to the directory to disable.
 * @returns {Promise<void>}
 */
async function disableCommand(dir) {
  const absDir = resolve(dir);

  await setOptOut(absDir, true);

  console.log(
    `${YELLOW}–${RESET} ForgeDock disabled for ${cyan(absDir)}`,
  );
  console.log(
    `  ${dim("The SessionStart hook will be silent in this directory.")}`,
  );
  console.log(
    `  ${dim("Re-enable with:")} ${cyan(`npx forgedock enable "${absDir}"`)}`,
  );
}

/**
 * Print the resolved ForgeDock state for a directory.
 *
 * Maps the three states returned by resolveState() to a human-readable
 * explanation of what ForgeDock will do in this directory.
 *
 * @param {string} dir - Absolute path to the directory to inspect.
 * @returns {Promise<void>}
 */
async function statusCommand(dir) {
  const absDir = resolve(dir);
  const state = resolveState(absDir);

  const hasForgeYaml = existsSync(join(absDir, "forge.yaml"));
  const hasMarker = existsSync(join(absDir, ".forgedock"));

  console.log("");
  console.log(`${BOLD}ForgeDock status${RESET} — ${cyan(absDir)}`);
  console.log("");

  switch (state) {
    case "managed-active":
      console.log(`  ${GREEN}● Active${RESET}`);
      console.log(
        `  ${dim("ForgeDock is managed and active in this directory.")}`,
      );
      if (hasForgeYaml) {
        console.log(`  ${dim("Managed via:")} forge.yaml`);
      } else if (hasMarker) {
        console.log(`  ${dim("Managed via:")} .forgedock marker`);
        console.log(
          `  ${dim("Run")} ${cyan("npx forgedock init")} ${dim("to generate a full forge.yaml.")}`,
        );
      }
      console.log(
        `  ${dim("To disable:")} ${cyan(`npx forgedock disable "${absDir}"`)}`,
      );
      break;

    case "managed-optedout":
      console.log(`  ${YELLOW}○ Disabled${RESET}`);
      console.log(
        `  ${dim("This directory is managed (has a forge.yaml or .forgedock marker)")}`,
      );
      console.log(
        `  ${dim("but has been explicitly opted out — the SessionStart hook is silent here.")}`,
      );
      if (hasForgeYaml) {
        console.log(`  ${dim("Managed via:")} forge.yaml`);
      } else if (hasMarker) {
        console.log(`  ${dim("Managed via:")} .forgedock marker`);
      }
      console.log(
        `  ${dim("To re-enable:")} ${cyan(`npx forgedock enable "${absDir}"`)}`,
      );
      break;

    case "unmanaged":
      console.log(`  ${dim("◌ Unmanaged")}`);
      console.log(
        `  ${dim("No forge.yaml or .forgedock marker found in this directory.")}`,
      );
      console.log(
        `  ${dim("ForgeDock is not active here.")}`,
      );
      console.log(
        `  ${dim("To enable:")} ${cyan(`npx forgedock enable "${absDir}"`)}`,
      );
      break;

    default:
      console.log(`  ${dim("Unknown state:")} ${state}`);
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
    `  ${CYAN}npx forgedock${RESET}            Launch TUI onboarding (interactive)`,
  );
  console.log(`  ${CYAN}npx forgedock install${RESET}    Install commands`);
  console.log(
    `  ${CYAN}npx forgedock init${RESET}       Generate forge.yaml config for your project`,
  );
  console.log(
    `  ${CYAN}npx forgedock init --manual${RESET}   Skip autopilot enrichment; run full per-field guided wizard`,
  );
  console.log(
    `  ${CYAN}npx forgedock init --verbose${RESET}  Show detection sources and confidence during init`,
  );
  console.log(
    `  ${CYAN}npx forgedock validate${RESET}   Validate forge.yaml configuration`,
  );
  console.log(
    `  ${CYAN}npx forgedock uninstall${RESET}  Remove commands (interactive, with confirmation)`,
  );
  console.log(
    `  ${CYAN}npx forgedock uninstall --yes${RESET}  Remove commands without prompts (non-interactive)`,
  );
  console.log(
    `  ${CYAN}npx forgedock update${RESET}     Pull latest & reinstall`,
  );
  console.log(
    `  ${CYAN}npx forgedock labels${RESET}     Bootstrap ForgeDock-managed labels on a GitHub repo`,
  );
  console.log(
    `  ${CYAN}npx forgedock labels setup${RESET}  Create/update all managed labels (idempotent)`,
  );
  console.log(
    `  ${CYAN}npx forgedock labels setup --repo owner/repo${RESET}  Target a specific repo`,
  );
  console.log(
    `  ${CYAN}npx forgedock integrate${RESET}  Inject/update ForgeDock usage block in project CLAUDE.md`,
  );
  console.log(
    `  ${CYAN}npx forgedock docs init${RESET}  Scaffold devdocs knowledge tree into current project`,
  );
  console.log(
    `  ${CYAN}npx forgedock enable [dir]${RESET}   Enable ForgeDock for a directory (default: cwd)`,
  );
  console.log(
    `  ${CYAN}npx forgedock disable [dir]${RESET}  Disable ForgeDock for a directory (default: cwd)`,
  );
  console.log(
    `  ${CYAN}npx forgedock status [dir]${RESET}   Show ForgeDock state for a directory (default: cwd)`,
  );
  console.log(`  ${CYAN}npx forgedock help${RESET}       Show this help`);
  console.log("");
}

// ---------------------------------------------------------------------------
// TUI Onboarding — interactive step-based flow (default when no command given)
// ---------------------------------------------------------------------------

async function tuiOnboarding() {
  splash();

  // Non-TTY fallback: skip TUI and detection, run install directly.
  // Print a prominent boxed notice so the user understands what happened and
  // what to do next. Best-effort update/checkout hints are folded into the box.
  if (!process.stdout.isTTY) {
    const noticeLines = [
      "",
      `  Non-interactive environment detected.`,
      `  ForgeDock's setup wizard requires an interactive terminal (TTY).`,
      "",
      `  ${dim("To run the interactive TUI:")} open a terminal and run ${cyan("npx forgedock")}`,
      "",
    ];

    // Best-effort remote check — fold results into the box, never block install.
    try {
      const remoteCheck = await checkForRemoteUpdate();
      if (remoteCheck?.updateAvailable) {
        const isGitCheckout = existsSync(join(FORGE_HOME, ".git"));
        if (isGitCheckout) {
          // User is running from the ForgeDock source checkout and it's behind remote.
          noticeLines.push(
            `  ${yellow("Stale local checkout:")} the working-tree bin is behind origin/main.`,
          );
          noticeLines.push(
            `  ${dim("Run")} ${cyan(`git pull`)} ${dim(`in`)} ${dim(FORGE_HOME)}`,
          );
          noticeLines.push(
            `  ${dim("Or use the published package:")} ${cyan("npx forgedock@latest")}`,
          );
        } else {
          const versionHint = remoteCheck.latestVersion
            ? ` (v${getVersion()} → v${remoteCheck.latestVersion})`
            : "";
          noticeLines.push(
            `  ${yellow(`Update available${versionHint}`)} — run: ${cyan("npx forgedock update")}`,
          );
        }
        noticeLines.push("");
      }
    } catch {
      // Best-effort — never block install
    }

    noticeLines.push(`  Running ${cyan("install")} now...`);
    noticeLines.push("");
    process.stdout.write(
      box(noticeLines, { title: "Non-interactive environment" }),
    );
    console.log("");
    await install();
    return;
  }

  // Detect install state before routing into a flow
  const detection = await detectInstallState();

  // -------------------------------------------------------------------------
  // Flow: up-to-date
  // Commands installed, forge.yaml present, same version — show summary
  // -------------------------------------------------------------------------
  if (detection.state === "up-to-date") {
    const versionLabel = detection.installedVersion
      ? `v${detection.installedVersion}`
      : `v${detection.currentVersion}`;
    console.log(
      `  ${green("Everything up to date.")} ForgeDock ${versionLabel} is installed and configured.`,
    );
    console.log("");

    // Proactive remote update check — cached, never blocks TUI startup
    let remoteUpdateInfo = null;
    try {
      remoteUpdateInfo = await checkForRemoteUpdate();
    } catch {
      // Best-effort — ignore all errors
    }

    if (remoteUpdateInfo?.updateAvailable) {
      // Surface a prominent notice when behind the remote
      const noticeLines = [""];
      if (remoteUpdateInfo.latestVersion) {
        noticeLines.push(
          `  ${yellow("Update available:")}  v${detection.currentVersion}  →  ${green(`v${remoteUpdateInfo.latestVersion}`)}`,
        );
      } else {
        // Git install: no version string, but commits available
        noticeLines.push(
          `  ${yellow("Update available")} — new commits on origin/main`,
        );
      }
      noticeLines.push(
        "",
        `  ${dim('Choose "Update now" below or run')} ${cyan("npx forgedock update")}`,
        "",
      );
      process.stdout.write(box(noticeLines, { title: "Update available" }));
      console.log("");
    }

    // Build the action menu — insert "Update now" as the first choice when behind
    /** @type {Array<{label: string, value: string}>} */
    const menuChoices = [];
    if (remoteUpdateInfo?.updateAvailable) {
      menuChoices.push({ label: "Update now", value: "update" });
    }
    menuChoices.push(
      { label: "Nothing — exit", value: "exit" },
      {
        label: "Reconfigure project (regenerate forge.yaml)",
        value: "reconfigure",
      },
      { label: "Reinstall commands", value: "reinstall" },
    );

    const action = await select("What would you like to do?", menuChoices);

    if (action === "update") {
      console.log("");
      await update();
    } else if (action === "reconfigure") {
      console.log("");
      await init();
    } else if (action === "reinstall") {
      console.log("");
      await install();
    }
    console.log("");
    return;
  }

  // -------------------------------------------------------------------------
  // Flow: update-available
  // Commands installed, forge.yaml present, newer version running — update
  // -------------------------------------------------------------------------
  if (detection.state === "update-available") {
    console.log(
      `  ${yellow("Update available.")} ` +
        `Installed: ${dim(`v${detection.installedVersion ?? "unknown"}`)}  →  ` +
        `New: ${green(`v${detection.currentVersion}`)}`,
    );
    console.log("");

    // Snapshot commands before update so we can show a diff after
    const commandsBeforeUpdate = await getInstalledCommandNames();

    const steps = [
      {
        name: "Preflight Checks",
        optional: false,
        run: async () => {
          await runPrerequisiteChecklist();
        },
      },
      {
        name: "Update Commands",
        optional: false,
        run: async () => {
          await install();
        },
      },
    ];

    const orchestrator = new StepOrchestrator(steps);
    const success = await orchestrator.run();

    if (success) {
      // Show command diff if any commands were added or removed
      const commandsAfterUpdate = await getInstalledCommandNames();
      const diffLines = formatCommandDiff(
        commandsBeforeUpdate,
        commandsAfterUpdate,
      );
      if (diffLines.length > 0) {
        process.stdout.write(box(diffLines, { title: "Command changes" }));
        console.log("");
      }

      console.log(
        green("Update complete!") +
          ` ForgeDock v${detection.currentVersion} is now active.`,
      );
      console.log("");
    } else {
      console.log("");
      console.log(
        yellow("Update incomplete.") +
          ` Re-run ${cyan("npx forgedock")} to try again.`,
      );
      console.log("");
      process.exit(1);
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Flow: config-missing
  // Commands installed but forge.yaml not found — skip to config step
  // -------------------------------------------------------------------------
  if (detection.state === "config-missing") {
    const versionLabel = detection.installedVersion
      ? `v${detection.installedVersion}`
      : `v${detection.currentVersion}`;
    console.log(
      `  ${yellow("Commands installed")} (${versionLabel}) but no ${cyan("forge.yaml")} found in this directory.`,
    );
    console.log("");

    const steps = [
      {
        name: "Project Configuration",
        optional: true,
        run: async () => {
          const shouldInit = await confirm(
            "Generate forge.yaml for this project?",
            true,
          );
          if (shouldInit) {
            await init();
          } else {
            console.log(
              `  ${dim("Skipped.")} Run ${cyan("npx forgedock init")} later to generate forge.yaml.`,
            );
          }
        },
      },
      {
        name: "Validate Configuration",
        optional: true,
        run: async () => {
          const forgeYamlPath = join(process.cwd(), "forge.yaml");
          if (!existsSync(forgeYamlPath)) {
            console.log(
              `  ${dim("No forge.yaml found — skipping validation.")}`,
            );
            return;
          }
          await validate(forgeYamlPath);
        },
      },
    ];

    const orchestrator = new StepOrchestrator(steps);
    const success = await orchestrator.run();

    if (success) {
      console.log(
        green("Done!") +
          ` Run ${cyan("/help")} inside Claude Code to see available commands.`,
      );
      console.log("");
    } else {
      console.log("");
      console.log(
        yellow("Setup incomplete.") +
          ` Re-run ${cyan("npx forgedock")} to try again.`,
      );
      console.log("");
      process.exit(1);
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Flow: version-unknown
  // Commands installed (symlinks found) but package.json unreadable — reinstall
  // -------------------------------------------------------------------------
  if (detection.state === "version-unknown") {
    console.log(
      `  ${yellow("ForgeDock commands are installed")} but the installed version could not be determined.`,
    );
    console.log(
      `  ${dim("The package.json for the installed copy is missing or unreadable.")}`,
    );
    console.log("");

    const action = await select("How would you like to proceed?", [
      { label: "Reinstall commands (recommended)", value: "reinstall" },
      { label: "Nothing — exit", value: "exit" },
    ]);

    if (action === "reinstall") {
      console.log("");
      await install();
    }
    console.log("");
    return;
  }

  // -------------------------------------------------------------------------
  // Flow: fresh-install (default)
  // No existing symlinks — run full onboarding
  // -------------------------------------------------------------------------
  const steps = [
    {
      name: "Preflight Checks",
      optional: false,
      run: async () => {
        await runPrerequisiteChecklist();
      },
    },
    {
      name: "Install Commands",
      optional: false,
      run: async () => {
        await install();
      },
    },
    {
      name: "Project Configuration",
      optional: true,
      run: async () => {
        const forgeYamlPath = join(process.cwd(), "forge.yaml");
        if (existsSync(forgeYamlPath)) {
          console.log(
            `  ${green("forge.yaml")} already exists — skipping generation.`,
          );
          return;
        }

        const shouldInit = await confirm(
          "No forge.yaml found. Generate one now?",
          true,
        );
        if (shouldInit) {
          await init();
        } else {
          console.log(
            `  ${dim("Skipped.")} Run ${cyan("npx forgedock init")} later to generate forge.yaml.`,
          );
        }
      },
    },
    {
      name: "Validate Configuration",
      optional: true,
      run: async () => {
        const forgeYamlPath = join(process.cwd(), "forge.yaml");
        if (!existsSync(forgeYamlPath)) {
          console.log(`  ${dim("No forge.yaml found — skipping validation.")}`);
          return;
        }
        await validate(forgeYamlPath);
      },
    },
  ];

  const orchestrator = new StepOrchestrator(steps);
  const success = await orchestrator.run();

  if (success) {
    console.log(
      green("Setup complete!") +
        ` Run ${cyan("/help")} inside Claude Code to see available commands.`,
    );
    console.log("");
  } else {
    console.log("");
    console.log(
      yellow("Setup incomplete.") +
        ` Re-run ${cyan("npx forgedock")} to try again.`,
    );
    console.log("");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

if (!command) {
  // No arguments — launch TUI onboarding
  await tuiOnboarding();
} else {
  switch (command) {
    case "install":
      await install();
      break;
    case "init":
      await init();
      break;
    case "validate": {
      const forgeYamlPath = join(process.cwd(), "forge.yaml");
      const result = await validate(forgeYamlPath);
      if (!result.passed) process.exit(1);
      break;
    }
    case "uninstall":
      await uninstall();
      break;
    case "update":
      await update();
      break;
    case "labels": {
      const subcommand = args[1];
      if (
        !subcommand ||
        subcommand === "setup" ||
        subcommand.startsWith("--")
      ) {
        const subArgs = args.slice(1);
        const repo = resolveLabelsRepo(subArgs);
        if (!repo) {
          console.log(
            `${RED}No repository specified.${RESET}\n` +
              `  Pass ${cyan("--repo owner/repo")} or run from a directory with ${cyan("forge.yaml")}.`,
          );
          process.exit(1);
        }
        await labelsSetup(repo);
      } else {
        console.log(`${RED}Unknown labels subcommand: ${subcommand}${RESET}`);
        console.log(
          `Usage: ${CYAN}npx forgedock labels [setup] [--repo owner/repo]${RESET}`,
        );
        process.exit(1);
      }
      break;
    }
    case "integrate":
      await injectClaudeMd(process.cwd());
      break;
    case "docs": {
      const docsSubcommand = args[1];
      if (!docsSubcommand || docsSubcommand === "init") {
        await docsInit();
      } else {
        console.log(`${RED}Unknown docs subcommand: ${docsSubcommand}${RESET}`);
        console.log(`Usage: ${CYAN}npx forgedock docs init${RESET}`);
        process.exit(1);
      }
      break;
    }
    case "enable":
      await enableCommand(args[1] || process.cwd());
      break;
    case "disable":
      await disableCommand(args[1] || process.cwd());
      break;
    case "status":
      await statusCommand(args[1] || process.cwd());
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
}
