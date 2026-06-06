#!/usr/bin/env node

import { fileURLToPath } from "url";
import { dirname, join, relative, resolve } from "path";
import { mkdir, symlink, copyFile, readlink, lstat, readdir, stat, writeFile, unlink as fsUnlink } from "fs/promises";
import { existsSync, appendFileSync, chmodSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { execSync, execFileSync } from "child_process";
import { createSign } from "crypto";
import {
  BOLD, GREEN, YELLOW, CYAN, RED, RESET,
  bold, dim, green, yellow, cyan, red,
  box, stepHeader, select, multiSelect, confirm, input, createProgressBar, spinner,
} from "./tui.mjs";

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
const command = args[0];
const forceYes = args.includes("--yes") || args.includes("-y");

// ---------------------------------------------------------------------------
// Version — read dynamically from package.json
// ---------------------------------------------------------------------------

function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(FORGE_HOME, "package.json"), "utf-8"));
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
        try { process.stdin.setRawMode(false); } catch { /* ignore */ }
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
      `    Install: ${CYAN}https://cli.github.com${RESET}`
    );
  }

  // Check gh auth (only if gh is installed)
  if (issues.length === 0) {
    try {
      execSync("gh auth status", { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      issues.push(
        `${RED}✗${RESET} GitHub CLI is not authenticated.\n` +
        `    Run: ${CYAN}gh auth login${RESET}`
      );
    }
  }

  // Check Claude Code
  try {
    execSync("claude --version", { stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    warnings.push(
      `${YELLOW}!${RESET} Claude Code CLI not found on PATH.\n` +
      `    Install: ${CYAN}https://docs.anthropic.com/en/docs/claude-code${RESET}`
    );
  }

  // Check Node version
  const nodeVersion = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeVersion < 18) {
    issues.push(
      `${RED}✗${RESET} Node.js >= 18 required (found ${process.versions.node}).\n` +
      `    Update: ${CYAN}https://nodejs.org${RESET}`
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
      `with authentication to function.\nResolve the issues above, then re-run the command.\n`
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
      const out = execSync("gh --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      const match = out.match(/gh version (\d+\.\d+\.\d+)/);
      const version = match ? `v${match[1]}` : "installed";
      s.stop("success", `${green("[✓]")} GitHub CLI          ${dim(version)}`);
    } catch {
      s.stop("fail", `${red("[✗]")} GitHub CLI          not found — install: ${cyan("https://cli.github.com")}`);
      throw new Error("GitHub CLI (gh) is required. Install it from https://cli.github.com");
    }
  }

  // ── 2. GitHub Auth ─────────────────────────────────────────────────────────
  {
    const s = spinner("Checking GitHub Auth…");
    try {
      // gh auth status writes to stderr; capture it via the error path too
      let combined = "";
      try {
        combined = execSync("gh auth status", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
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
        const orgsJson = execSync("gh api /user/orgs --jq '.[0].login'", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        if (orgsJson && orgsJson !== "null" && orgsJson !== "") {
          orgLabel = ` (${orgsJson})`;
        }
      } catch {
        // Org lookup is best-effort — not required
      }
      s.stop("success", `${green("[✓]")} GitHub Auth         ${dim(`logged in as ${username}${orgLabel}`)}`);
    } catch {
      s.stop("fail", `${red("[✗]")} GitHub Auth         not authenticated — run: ${cyan("gh auth login")}`);
      throw new Error("GitHub CLI is not authenticated. Run: gh auth login");
    }
  }

  // ── 3. Node.js ─────────────────────────────────────────────────────────────
  {
    const s = spinner("Checking Node.js…");
    const nodeVersion = process.versions.node;
    const nodeMajor = parseInt(nodeVersion.split(".")[0], 10);
    if (nodeMajor < 18) {
      s.stop("fail", `${red("[✗]")} Node.js             v${nodeVersion} (>= 18 required) — update: ${cyan("https://nodejs.org")}`);
      throw new Error(`Node.js >= 18 required (found v${nodeVersion}). Update at https://nodejs.org`);
    }
    s.stop("success", `${green("[✓]")} Node.js             ${dim(`v${nodeVersion} (>= 18 required)`)}`);
  }

  // ── 4. Git ─────────────────────────────────────────────────────────────────
  {
    const s = spinner("Checking Git…");
    try {
      const out = execSync("git --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      const match = out.match(/git version (\d+\.\d+\.\d+)/);
      const version = match ? `v${match[1]}` : "installed";
      s.stop("success", `${green("[✓]")} Git                 ${dim(version)}`);
    } catch {
      s.stop("warn", `${yellow("[!]")} Git                 not found — install: ${cyan("https://git-scm.com")}`);
      // Git is a warning — do NOT throw
    }
  }

  // ── 5. Claude Code ─────────────────────────────────────────────────────────
  {
    const s = spinner("Checking Claude Code…");
    try {
      const out = execSync("claude --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      const match = out.trim().match(/(\d+\.\d+\.\d+)/);
      const version = match ? `v${match[1]}` : "installed";
      s.stop("success", `${green("[✓]")} Claude Code         ${dim(version)}`);
    } catch {
      s.stop("warn", `${yellow("[!]")} Claude Code         not found — install: ${cyan("https://docs.anthropic.com/en/docs/claude-code")}`);
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
  "work-on":           "Pipeline",
  "investigate":       "Pipeline",
  "build":             "Pipeline",
  "architect":         "Pipeline",
  "context":           "Pipeline",
  "implement":         "Pipeline",
  "review":            "Pipeline",
  "decompose":         "Pipeline",
  "close":             "Pipeline",
  "review-pr":         "Pipeline",
  "review-pr-agents":  "Pipeline",
  "review-pr-staging": "Pipeline",
  "orchestrate":       "Pipeline",
  "issue":             "Pipeline",
  "milestone":         "Pipeline",
  "quality-gate":      "Pipeline",
  "work-on-monolithic":"Pipeline",

  // Operations — ongoing automation and monitoring
  "autopilot":         "Operations",
  "analytics":         "Operations",
  "geo-audit":         "Operations",
  "security-audit":    "Operations",
  "pipeline-health":   "Operations",
  "audit":             "Operations",
  "audit-agents":      "Operations",
  "qa-sweep":          "Operations",
  "forge-stats":       "Operations",
  "sync-ecosystem":    "Operations",

  // Incident — response and recovery
  "incident-response": "Incident",
  "rollback":          "Incident",
  "deploy-info":       "Incident",
  "failure-recon":     "Incident",

  // Ecosystem — project management utilities
  "validate":          "Ecosystem",
  "cleanup":           "Ecosystem",

  // Setup — initial configuration
  "forgedock-init":    "Setup",
};

/** Canonical display order for categories. */
const CATEGORY_ORDER = ["Pipeline", "Operations", "Incident", "Ecosystem", "Setup", "Other"];

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

  const bar = createProgressBar(files.length, { label: "  Installing commands..." });

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
    process.stdout.write(box(["", ...categoryLines, ""], { title: "Commands installed" }));
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
    summaryLines.splice(summaryLines.length - 1, 0,
      `  ${cyan("Copied")}     ${bold(String(copied))}  ${dim("(symlinks unavailable — files copied instead)")}`
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
    process.stdout.write(box(conflictLines, { title: `${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}` }));
  }

  // -------------------------------------------------------------------------
  // Phase 5: FORGE_HOME setup — distinct status line
  // -------------------------------------------------------------------------

  console.log("");
  let forgeHomeSet = false;
  for (const profile of [
    join(process.env.HOME ?? "", ".bashrc"),
    join(process.env.HOME ?? "", ".zshrc"),
  ]) {
    if (existsSync(profile)) {
      const content = readFileSync(profile, "utf-8");
      if (!content.includes("FORGE_HOME")) {
        appendFileSync(
          profile,
          `\n# ForgeDock — autonomous development pipeline\nexport FORGE_HOME="${FORGE_HOME}"\n`
        );
        const profileShort = profile.replace(process.env.HOME ?? "", "~");
        console.log(`  ${green("✔")}  ${bold("FORGE_HOME")} set in ${cyan(profileShort)}`);
        forgeHomeSet = true;
      }
    }
  }

  if (!forgeHomeSet) {
    console.log(`  ${dim("✔")}  ${dim("FORGE_HOME already set in shell profile")}`);
  }

  console.log("");
  console.log(
    `${green("ForgeDock commands are now available as slash commands in any Claude Code session.")}`
  );
  console.log("");

  // forge.yaml advisory — guide users to run init if config is missing
  const forgeYamlPath = join(process.cwd(), "forge.yaml");
  if (!existsSync(forgeYamlPath)) {
    console.log(`${yellow("No forge.yaml found in current directory.")}`);
    console.log(
      `  Run ${cyan("npx forgedock init")} in your project root to generate forge.yaml`
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
  const shellProfiles = [
    join(process.env.HOME ?? "", ".bashrc"),
    join(process.env.HOME ?? "", ".zshrc"),
  ];
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

  // -------------------------------------------------------------------------
  // Phase 2: Pre-removal summary
  // -------------------------------------------------------------------------

  if (toRemove.length === 0 && profilesWithForgeHome.length === 0 && !hasForgeYaml) {
    console.log(`  ${dim("Nothing to remove — ForgeDock does not appear to be installed.")}`);
    console.log("");
    return;
  }

  const summaryLines = [""];
  if (toRemove.length > 0) {
    const fileLabel = copyMode ? "files (copy-mode install)" : "symlinks";
    summaryLines.push(`  ${red("Commands")}:   ${bold(String(toRemove.length))} ${fileLabel} in ${dim(TARGET_DIR)}`);
  } else {
    summaryLines.push(`  ${dim("Commands:")}   none found`);
  }
  if (profilesWithForgeHome.length > 0) {
    summaryLines.push(
      `  ${yellow("Profiles")}:   FORGE_HOME export in ${bold(profilesWithForgeHome.map((p) => p.replace(process.env.HOME ?? "", "~")).join(", "))}`
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
    confirmed = await confirm(
      `Remove ${commandLabel}${profileLabel}?`,
      false
    );
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
    const bar = createProgressBar(toRemove.length, { label: "  Removing commands" });
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
              "\n"
            )
            .replace(
              /^# ForgeDock — autonomous development pipeline\nexport FORGE_HOME=[^\n]*\n/,
              ""
            );
          // Write to a temp file first, then atomically rename into place.
          // This prevents profile corruption if the process is killed mid-write.
          writeFileSync(tmpPath, cleaned, "utf-8");
          renameSync(tmpPath, profile);
          const profileShort = profile.replace(process.env.HOME ?? "", "~");
          console.log(`  ${green("✔")} Removed FORGE_HOME from ${profileShort}`);
        } catch (err) {
          // Clean up temp file if it was created before the error
          try { unlinkSync(tmpPath); } catch { /* already gone or never created */ }
          const profileShort = profile.replace(process.env.HOME ?? "", "~");
          console.log(`  ${red("✖")} Could not update ${profileShort}: ${err.message}`);
        }
      }
    } else {
      console.log(`  ${dim("Skipped — FORGE_HOME left in shell profiles.")}`);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 6: forge.yaml handling (default: keep)
  // -------------------------------------------------------------------------

  if (hasForgeYaml) {
    console.log("");
    const deleteForgeYaml = forceYes
      ? false  // --yes flag: keep forge.yaml by default (safe)
      : await confirm("Delete forge.yaml from this project?", false);

    if (deleteForgeYaml) {
      try {
        await unlink(forgeYamlPath);
        console.log(`  ${green("✔")} Deleted forge.yaml`);
      } catch (err) {
        console.log(`  ${red("✖")} Could not delete forge.yaml: ${err.message}`);
      }
    } else {
      console.log(`  ${dim("forge.yaml kept.")}`);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 7: Post-removal summary
  // -------------------------------------------------------------------------

  console.log("");
  console.log(`${green("Uninstall complete.")} ForgeDock commands have been removed.`);
  if (profilesWithForgeHome.length > 0) {
    console.log(`  ${dim("Restart your shell or run")} ${cyan("source ~/.bashrc")} ${dim("(or")} ${cyan("~/.zshrc")}${dim(")")} ${dim("to apply profile changes.")}`);
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
    });
    return result.trim() || null;
  } catch {
    return null;
  }
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
  const added = [...after].filter((n) => !before.has(n)).map((n) => n.replace(/\.md$/, ""));
  const removed = [...before].filter((n) => !after.has(n)).map((n) => n.replace(/\.md$/, ""));

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
        console.log(`  ${yellow("Not on main branch")} (${branch}) — skipping automatic update.`);
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
        console.log(`  ${yellow("Offline or unreachable.")} Could not fetch from origin.`);
        console.log(`  ${dim("Skipping update check — re-run when connected.")}`);
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
        console.log(
          `  ${yellow("Cannot fast-forward")} — local changes exist. Skipping merge.`
        );
        console.log(`  ${dim("Stash or discard local changes and re-run.")}`);
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
      console.log(
        `  ${green("Updated")} v${currentVersion} → v${newVersion}`
      );
      console.log("");

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
        `  ${RED}Update failed.${RESET} ${err instanceof Error ? err.message : String(err)}`
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
        process.stdout.write(`\r  ${yellow("Offline or registry unreachable.")} Could not check for updates.\n`);
      } else {
        console.log(`  Offline or registry unreachable. Could not check for updates.`);
      }
      console.log(`  ${dim("Re-run when connected, or check: ")}${cyan("https://www.npmjs.com/package/forgedock")}`);
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

async function init() {
  checkPrerequisites();

  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — Generate forge.yaml`);
  console.log("");

  const cwd = process.cwd();
  const outputPath = join(cwd, "forge.yaml");

  // ---------------------------------------------------------------------------
  // Auto-detect defaults (silent — used as pre-fill values for prompts)
  // ---------------------------------------------------------------------------

  // Detect git remote URL and parse owner/repo
  let detectedOwner = "your-github-org";
  let detectedRepo = "your-repo-name";
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
    const httpsMatch = remoteUrl.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);

    if (sshMatch) {
      detectedOwner = sshMatch[1];
      detectedRepo = sshMatch[2];
      remoteDetected = true;
    } else if (httpsMatch) {
      detectedOwner = httpsMatch[1];
      detectedRepo = httpsMatch[2];
      remoteDetected = true;
    }
  } catch {
    // No remote — use placeholders
  }

  // Detect default branch
  let detectedDefault = "main";
  try {
    const headRef = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    detectedDefault = headRef.replace(/^refs\/remotes\/origin\//, "");
  } catch {
    try {
      const cur = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (cur && cur !== "HEAD") detectedDefault = cur;
    } catch {
      // Keep "main"
    }
  }

  // Detect staging branch
  let detectedStaging = detectedDefault;
  try {
    const remoteBranches = execSync("git branch -r", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (remoteBranches.includes("origin/staging")) {
      detectedStaging = "staging";
    }
  } catch {
    // Keep default
  }

  // Derive project name from repo slug
  const detectedName = detectedRepo
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  // Non-TTY: skip interactive prompts and use detected values directly
  if (!process.stdin.isTTY) {
    if (!remoteDetected) {
      console.log(
        `  ${YELLOW}Warning${RESET}: No git remote found — using placeholder values`
      );
    }
    // Silent write — same as pre-interactive behavior
    _writeForgeYaml({
      outputPath, cwd,
      owner: detectedOwner, repo: detectedRepo,
      projectName: detectedName, description: "",
      root: cwd, worktreeBase: join(cwd, ".claude", "worktrees"),
      defaultBranch: detectedDefault, stagingBranch: detectedStaging,
    });
    console.log(`  ${GREEN}Created${RESET}: forge.yaml`);
    console.log("");
    _printNextSteps({ remoteDetected });
    await validate(outputPath);
    return;
  }

  // ---------------------------------------------------------------------------
  // Interactive flow — prompt for each required section
  // ---------------------------------------------------------------------------

  // Loop until user confirms the preview
  let confirmed = false;

  while (!confirmed) {
    console.log(dim("  Auto-detected values are shown as defaults. Press Enter to accept."));
    console.log("");

    // --- Project section ---
    console.log(bold("  Project"));

    const ownerInput = await input("  GitHub owner (org or user)", detectedOwner);
    const repoInput = await input("  Repository name", detectedRepo);
    const nameInput = await input(
      "  Project name",
      detectedName !== "Your-repo-name" ? detectedName : repoInput.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
    );
    const descInput = await input("  Brief description", "");

    // --- Paths section ---
    console.log("");
    console.log(bold("  Paths"));

    const rootInput = await input("  Repository root (absolute path)", cwd);
    const worktreeInput = await input(
      "  Worktree base (for git worktrees)",
      join(rootInput || cwd, ".claude", "worktrees")
    );

    // --- Branches section ---
    console.log("");
    console.log(bold("  Branches"));

    const defaultBranchInput = await input("  Default branch", detectedDefault);
    const stagingBranchInput = await input("  Staging branch (PR target for fast-lane changes)", detectedStaging);

    // --- Preview ---
    console.log("");

    const previewLines = buildForgeYamlContent({
      owner: ownerInput,
      repo: repoInput,
      projectName: nameInput,
      description: descInput,
      root: rootInput || cwd,
      worktreeBase: worktreeInput || join(cwd, ".claude", "worktrees"),
      defaultBranch: defaultBranchInput,
      stagingBranch: stagingBranchInput,
    });

    // Show preview in a box
    const previewDisplay = previewLines
      .split("\n")
      .slice(0, 30) // show first 30 lines of required sections only
      .join("\n");

    process.stdout.write(
      box(previewDisplay, { title: "forge.yaml preview (required sections)", padding: 1 })
    );

    confirmed = await confirm("  Write this forge.yaml?", true);

    if (!confirmed) {
      console.log("");
      console.log(dim("  Starting over — re-enter values below."));
      console.log("");
    } else {
      // -----------------------------------------------------------------------
      // Optional sections — multi-select, then guided prompts per section
      // -----------------------------------------------------------------------
      console.log("");
      console.log(bold("  Optional Sections"));
      console.log(dim("  Select sections to configure now. Unselected sections are written as"));
      console.log(dim("  commented-out placeholders — you can enable them later by editing forge.yaml."));
      console.log("");

      const OPTIONAL_SECTION_CHOICES = [
        {
          label: "Project Board   — GitHub Projects v2 integration for workflow tracking",
          value: "projectBoard",
        },
        {
          label: "Multi-Repo      — Satellite repos for cross-repo milestones",
          value: "multiRepo",
        },
        {
          label: "Review Context  — Tech stack and conventions for PR review agents",
          value: "review",
        },
        {
          label: "Verification    — Health check endpoints and response patterns",
          value: "verification",
        },
      ];

      const selectedSections = await multiSelect(
        "  Which optional sections would you like to configure?",
        OPTIONAL_SECTION_CHOICES
      );

      /** @type {Record<string, object>} */
      const optionalSections = {};

      // --- Project Board prompts ---
      if (selectedSections.includes("projectBoard")) {
        const discovered = await discoverProjectBoard(ownerInput || detectedOwner);
        if (discovered) {
          // Auto-discovery succeeded — use resolved IDs
          optionalSections.projectBoard = {
            projectNumber: discovered.projectNumber,
            projectId:     discovered.projectId,
            fieldIds:      discovered.fieldIds,
            optionIds:     discovered.optionIds,
          };
        } else {
          // Fallback: manual entry (no regression from previous behaviour)
          console.log("");
          console.log(bold("  Project Board (manual)"));
          console.log(dim("  Find your project number: gh project list --owner " + (ownerInput || detectedOwner)));
          const projectNumber = await input(
            "  GitHub Projects v2 project number",
            "1"
          );
          optionalSections.projectBoard = {
            projectNumber: parseInt(projectNumber, 10) || 1,
          };
          console.log(dim("  Field IDs (PVT_/PVTSSF_ strings) must be added manually after generation."));
          console.log(dim("  Run: gh project field-list " + (projectNumber || "1") + " --owner " + (ownerInput || detectedOwner)));
        }
      }

      // --- Multi-Repo prompts ---
      if (selectedSections.includes("multiRepo")) {
        console.log("");
        console.log(bold("  Multi-Repo"));
        console.log(dim("  Configure one satellite repo (add more by editing forge.yaml)."));
        const prefix = await input(
          "  Satellite repo prefix (e.g. 'mcp', 'sdk')",
          "sat"
        );
        const satelliteRepo = await input(
          "  Satellite repo name (just the name, owner will be reused)",
          "your-satellite-repo"
        );
        const satelliteBranch = await input(
          "  Satellite default/staging branch",
          "main"
        );
        optionalSections.multiRepo = { prefix, satelliteRepo, satelliteBranch };
      }

      // --- Review Context prompts ---
      if (selectedSections.includes("review")) {
        console.log("");
        console.log(bold("  Review Context"));
        const techStack = await input(
          "  Tech stack (e.g. Next.js, FastAPI, PostgreSQL)",
          "Node.js, TypeScript"
        );
        const context = await input(
          "  Architecture notes (one line; expand in forge.yaml later)",
          ""
        );
        optionalSections.review = { techStack, context };
      }

      // --- Verification prompts ---
      if (selectedSections.includes("verification")) {
        console.log("");
        console.log(bold("  Verification"));
        const healthEndpoint = await input(
          "  Health check endpoint URL",
          `https://api.${repoInput || detectedRepo}.io/health`
        );
        optionalSections.verification = { healthEndpoint };
      }

      // -----------------------------------------------------------------------
      // Handle existing forge.yaml with confirmation
      // -----------------------------------------------------------------------
      if (existsSync(outputPath)) {
        console.log("");
        console.log(`  ${YELLOW}forge.yaml already exists.${RESET}`);
        const shouldOverwrite = await confirm(
          "  Back up existing forge.yaml and overwrite?",
          true
        );
        if (!shouldOverwrite) {
          console.log(`  ${dim("Cancelled.")} forge.yaml was not changed.`);
          console.log("");
          return;
        }

        // Backup with timestamped name if .bak already exists (fix from #36)
        const baseBak = join(cwd, "forge.yaml.bak");
        const backupPath = existsSync(baseBak)
          ? join(cwd, `forge.yaml.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`)
          : baseBak;
        const backupName = backupPath.split("/").pop();
        renameSync(outputPath, backupPath);
        console.log(`  ${YELLOW}Backed up${RESET}: forge.yaml → ${backupName}`);
      }

      // Write the file
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
      });

      console.log("");
      console.log(`  ${GREEN}Created${RESET}: forge.yaml`);
      if (selectedSections.length > 0) {
        console.log(`  ${GREEN}Configured${RESET}: ${selectedSections.map((s) => ({
          projectBoard: "project_board",
          multiRepo: "repos",
          review: "review",
          verification: "verification",
        })[s]).join(", ")}`);
      }
      console.log("");
      _printNextSteps({ remoteDetected: ownerInput !== "your-github-org" });
      await validate(outputPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers for init()
// ---------------------------------------------------------------------------

/**
 * Sanitize a string value for safe insertion into a YAML double-quoted scalar.
 * Strips double-quotes and newlines to prevent YAML injection.
 *
 * @param {string} value
 * @returns {string}
 */
function _sanitizeYamlValue(value) {
  return String(value).replace(/"/g, "").replace(/[\r\n]/g, " ").trim();
}

/**
 * Sanitize a file-system path value for safe insertion into a YAML double-quoted scalar.
 * Escapes backslashes (Windows paths) in addition to stripping double-quotes and newlines.
 *
 * @param {string} value
 * @returns {string}
 */
function _sanitizePathValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "").replace(/[\r\n]/g, " ").trim();
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
    const raw = execFileSync("gh", ["project", "list", "--owner", owner, "--format", "json"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(raw);
    projects = parsed.projects || [];
  } catch {
    // gh not available, auth failure, or no projects access — fall back silently
    console.log(dim("  Could not list projects — falling back to manual entry."));
    return null;
  }

  if (projects.length === 0) {
    console.log(dim("  No GitHub Projects v2 boards found for this owner."));
    console.log(dim("  You can add project_board configuration manually in forge.yaml later."));
    return null;
  }

  // Build select menu choices
  const projectChoices = projects.map((p) => ({
    label: `${p.title}  ${dim("(#" + p.number + ", " + (p.items?.totalCount ?? "?") + " items)")}`,
    value: p.number,
  }));
  projectChoices.push({ label: dim("Skip — configure project board manually later"), value: null });

  console.log("");
  const selectedNumber = await select("  Which GitHub Project board?", projectChoices);
  if (selectedNumber === null) {
    return null;
  }

  // Look up the selected project's id
  const selectedProject = projects.find((p) => p.number === selectedNumber);
  const projectId = selectedProject?.id ?? "";
  const projectTitle = _sanitizeYamlValue(selectedProject?.title ?? `Project #${selectedNumber}`);

  // -------------------------------------------------------------------------
  // Step 2: Fetch field list
  // -------------------------------------------------------------------------
  console.log("");
  console.log(dim("  Fetching project fields…"));

  let fields = [];
  try {
    const raw = execFileSync("gh", ["project", "field-list", String(selectedNumber), "--owner", owner, "--format", "json"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(raw);
    fields = (parsed.fields || []).filter((f) => f.type === "ProjectV2SingleSelectField");
  } catch {
    console.log(dim("  Could not fetch project fields — falling back to manual entry."));
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
    const exact = fields.find((f) => f.name.toLowerCase() === keyword.toLowerCase());
    if (exact) return { field: exact, fuzzy: false };
    // Fuzzy: name contains keyword
    const fuzzy = fields.find((f) => f.name.toLowerCase().includes(keyword.toLowerCase()));
    if (fuzzy) return { field: fuzzy, fuzzy: true };
    return null;
  }

  // Known field keys and their expected name keywords
  const FIELD_TARGETS = [
    { key: "status",    keywords: ["status"] },
    { key: "lane",      keywords: ["lane", "track"] },
    { key: "component", keywords: ["component"] },
    { key: "priority",  keywords: ["priority"] },
    { key: "workflow",  keywords: ["workflow"] },
  ];

  // Known option name → forge.yaml key mappings per field
  const OPTION_MAPS = {
    status:   { "todo": "todo", "in progress": "in_progress", "done": "done" },
    lane:     { "fast": "fast", "feature": "feature", "sync": "sync" },
    priority: { "p0": "p0", "p1": "p1", "p2": "p2", "p3": "p3" },
    workflow: {
      "investigating": "investigating",
      "ready to build": "ready_to_build",
      "building": "building",
      "in review": "in_review",
      "merged": "merged",
      "invalid": "invalid",
      "decomposed": "decomposed",
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
        const slug = opt.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
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
    console.log(yellow(`  Fuzzy match: field "${fieldName}" mapped to forge.yaml key "${key}"`));
    const accepted = await confirm(`  Accept this mapping (${fieldName} → ${key})?`, true);
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
    const optCount = resolvedOptionIds[key] ? Object.keys(resolvedOptionIds[key]).length : 0;
    const optLabel = optCount > 0 ? ` (${optCount} options)` : " (no options mapped)";
    summaryLines.push(`  ${key.padEnd(10)}: ${id}${optLabel}`);
  }
  const unmapped = FIELD_TARGETS.map((t) => t.key).filter((k) => !resolvedFieldIds[k]);
  if (unmapped.length > 0) {
    summaryLines.push("");
    summaryLines.push(`Not found:  ${unmapped.join(", ")} — placeholders will be used`);
  }

  console.log("");
  console.log(box(summaryLines, { title: "Project Board Config" }));

  const confirmed = await confirm("  Use this configuration?", true);
  if (!confirmed) {
    console.log(dim("  Skipped auto-discovery. You can add project_board manually in forge.yaml."));
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
function buildForgeYamlContent({ owner, repo, projectName, description, root, worktreeBase, defaultBranch, stagingBranch, optionalSections = {} }) {
  // Sanitize all user-supplied string values before template interpolation to prevent
  // YAML injection via double-quotes or embedded newlines in double-quoted scalars.
  owner         = _sanitizeYamlValue(owner);
  repo          = _sanitizeYamlValue(repo);
  projectName   = _sanitizeYamlValue(projectName);
  description   = _sanitizeYamlValue(description);
  defaultBranch = _sanitizeYamlValue(defaultBranch);
  stagingBranch = _sanitizeYamlValue(stagingBranch);
  // Path values: also escape backslashes so Windows paths are valid YAML.
  // Preserve rawRoot for use in path.join() operations — join() expects raw OS paths,
  // not YAML-escaped strings. Always apply _sanitizePathValue() to the join() result.
  const rawRoot = root;
  root          = _sanitizePathValue(root);
  worktreeBase  = _sanitizePathValue(worktreeBase);

  const { projectBoard, multiRepo, review, verification } = optionalSections;

  // Sanitize optional-section user-supplied strings.
  const safeMultiRepo = multiRepo ? {
    prefix:         _sanitizeYamlValue(multiRepo.prefix         || "sat"),
    satelliteRepo:  _sanitizeYamlValue(multiRepo.satelliteRepo  || "your-satellite-repo"),
    satelliteBranch: _sanitizeYamlValue(multiRepo.satelliteBranch || "main"),
  } : null;

  const safeReview = review ? {
    techStack: _sanitizeYamlValue(review.techStack || "Node.js, TypeScript, PostgreSQL"),
    // context uses a block scalar (|) — only strip double-quotes; newlines are handled by split/join
    context:   (review.context || "Add architecture notes and conventions here.").replace(/"/g, ""),
  } : null;

  const safeVerification = verification ? {
    healthEndpoint: _sanitizeYamlValue(verification.healthEndpoint || `https://api.${repo}.io/health`),
  } : null;

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

  /**
   * Build a YAML block for option_ids given a nested map of { fieldKey: { optionKey: id } }.
   * Only writes fields that have at least one mapped option.
   */
  function _buildOptionIdsBlock(optionIds) {
    const entries = Object.entries(optionIds).filter(([, opts]) => Object.keys(opts).length > 0);
    if (entries.length === 0) return "";
    const lines = ["  option_ids:"];
    for (const [fieldKey, opts] of entries) {
      lines.push(`    ${fieldKey}:`);
      for (const [optKey, optId] of Object.entries(opts)) {
        lines.push(`      ${optKey}: "${optId}"`);
      }
    }
    return "\n" + lines.join("\n");
  }

  const fieldIdsBlock = FIELD_KEYS
    .map((k) => `    ${k}: "${resolvedFieldIds[k] ?? "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"}"`)
    .join("\n");

  const optionIdsBlock = projectBoard?.optionIds ? _buildOptionIdsBlock(resolvedOptionIds) : "";

  const hasDiscoveredId = !!(projectBoard?.projectId);

  const projectBoardSection = projectBoard
    ? `project_board:
  owner: "${owner}"
  project_number: ${projectBoard.projectNumber || 1}
  project_id: "${hasDiscoveredId ? projectBoard.projectId : "PVT_kwHOxxxxxxxxxxxxxxxx"}"
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

# =============================================================================
# BOT (OPTIONAL)
# GitHub App bot identity for pipeline operations.
# Credentials are stored separately in ~/.forgedock/credentials.json — not here.
# Run: npx forgedock bot setup  to configure interactively.
# Run: npx forgedock bot status to verify.
# =============================================================================

# bot:
#   app_id: 12345
#   installation_id: 67890
#   private_key_path: "~/.forgedock/forgedock-bot.private-key.pem"
#   # When configured, pipeline commands use the app token instead of personal token.
#   # Bot-authored comments include <!-- forgedock-bot --> for audit filtering.
`;
}

/** Write forge.yaml to disk. Accepts all params for buildForgeYamlContent plus outputPath. */
function _writeForgeYaml(opts) {
  const content = buildForgeYamlContent(opts);
  writeFileSync(opts.outputPath, content, "utf-8");
}

/** Print next-steps guidance after forge.yaml is written. */
function _printNextSteps({ remoteDetected }) {
  console.log(`${BOLD}Next steps:${RESET}`);
  if (!remoteDetected) {
    console.log(`  ${YELLOW}!${RESET}  Edit ${CYAN}forge.yaml${RESET} — set project.owner and project.repo`);
  }
  console.log(`  1. Add ${CYAN}forge.yaml${RESET} to ${CYAN}.gitignore${RESET} if it contains sensitive paths`);
  console.log(`  2. Run ${CYAN}/forgedock-init${RESET} inside Claude Code for guided AI-powered setup`);
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

    if (line.trim() === "default:") { continue; }
    if (line.trim() === "satellites:") { inSatellites = true; continue; }

    if (inSatellites && /^\s{6,}repo:/.test(line)) {
      const raw = line.replace(/^\s+repo:\s*/, "").replace(/^["']|["']$/g, "").trim();
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
    checks.push({ label: "forge.yaml found", status: "error", note: `Not found: ${forgeYamlPath}` });
    _renderValidationSummary(checks);
    return { passed: false, checks };
  }

  let content;
  try {
    content = readFileSync(forgeYamlPath, "utf-8");
  } catch (err) {
    checks.push({ label: "forge.yaml found", status: "error", note: `Cannot read: ${err.message}` });
    _renderValidationSummary(checks);
    return { passed: false, checks };
  }

  checks.push({ label: "forge.yaml found", status: "ok", note: forgeYamlPath });

  // 2. Required fields
  const PLACEHOLDERS = new Set(["your-github-org", "your-repo-name", "", "your-org", "your-repo"]);

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
    checks.push({ label: "Required fields", status: "ok", note: `${owner}/${repo}` });
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
      checks.push({ label: "paths.root exists", status: "warn", note: `Directory not found: ${root}` });
    }
  }

  // 4. Create worktree_base if missing
  if (worktreeBase) {
    if (existsSync(worktreeBase)) {
      checks.push({ label: "worktree_base exists", status: "ok", note: worktreeBase });
    } else {
      try {
        await mkdir(worktreeBase, { recursive: true });
        checks.push({ label: "worktree_base exists", status: "ok", note: `Created: ${worktreeBase}` });
      } catch (err) {
        checks.push({ label: "worktree_base exists", status: "warn", note: `Cannot create: ${err.message}` });
      }
    }
  }

  // 5. GitHub repo access
  if (owner && repo && !PLACEHOLDERS.has(owner) && !PLACEHOLDERS.has(repo)) {
    try {
      execFileSync("gh", ["repo", "view", `${owner}/${repo}`, "--json", "name"], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
      });
      checks.push({ label: "GitHub repo accessible", status: "ok", note: `${owner}/${repo}` });
    } catch {
      checks.push({
        label: "GitHub repo accessible",
        status: "warn",
        note: `Cannot access ${owner}/${repo} — check owner/repo or run: gh auth login`,
      });
    }
  } else {
    checks.push({ label: "GitHub repo accessible", status: "warn", note: "Skipped — owner/repo not set" });
  }

  // 6. Branch existence on remote
  const stagingBranch = _parseYamlKey(content, "branches.staging");
  const branchesToCheck = [...new Set([defaultBranch, stagingBranch].filter(Boolean))];

  if (root && existsSync(root) && branchesToCheck.length > 0) {
    for (const branch of branchesToCheck) {
      try {
        const result = execFileSync("git", ["ls-remote", "--heads", "origin", branch], {
          cwd: root,
          stdio: ["pipe", "pipe", "pipe"],
          encoding: "utf-8",
          timeout: 10000,
        });
        if (result.trim()) {
          checks.push({ label: `Branch: ${branch}`, status: "ok", note: "Exists on remote" });
        } else {
          checks.push({ label: `Branch: ${branch}`, status: "warn", note: "Not found on remote" });
        }
      } catch {
        checks.push({ label: `Branch: ${branch}`, status: "warn", note: "Cannot verify — git error" });
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
            "api", "graphql",
            "-F", `id=${projectId}`,
            "-f", "query=query($id: ID!) { node(id: $id) { id __typename } }",
          ],
          { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8", timeout: 10000 }
        );
        const parsed = JSON.parse(result);
        if (parsed?.data?.node?.id) {
          checks.push({ label: "Project board configured", status: "ok", note: `${projectId.slice(0, 16)}... resolves` });
        } else {
          checks.push({ label: "Project board configured", status: "warn", note: "project_id may be invalid — verify with: gh project list" });
        }
      } catch {
        checks.push({ label: "Project board configured", status: "warn", note: "Cannot verify project_id — gh error" });
      }
    }
  } else {
    checks.push({ label: "Project board", status: "warn", note: "Not configured (optional)" });
  }

  // 8. Satellite repo access
  if (_sectionActive(content, "repos")) {
    const satellites = _parseSatelliteRepos(content);
    if (satellites.length === 0) {
      checks.push({ label: "Satellite repos", status: "warn", note: "repos: section active but no satellites found" });
    } else {
      for (const sat of satellites) {
        try {
          execFileSync("gh", ["repo", "view", sat, "--json", "name"], {
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 10000,
          });
          checks.push({ label: `Satellite: ${sat}`, status: "ok", note: "Accessible" });
        } catch {
          checks.push({ label: `Satellite: ${sat}`, status: "warn", note: "Cannot access — check repo name or gh auth" });
        }
      }
    }
  } else {
    checks.push({ label: "Satellite repos", status: "warn", note: "Not configured (optional)" });
  }

  _renderValidationSummary(checks);
  const hasError = checks.some((c) => c.status === "error");
  return { passed: !hasError, checks };
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
  const boardOk = checks.some((c) => c.label === "Project board configured" && c.status === "ok");

  lines.push("");
  lines.push(`  ${bold("Next steps:")}`);
  if (hasErrors) {
    lines.push(`  ${dim("•")} Edit ${cyan("forge.yaml")} to fix the errors above`);
  }
  if (!boardOk) {
    lines.push(`  ${dim("•")} Run ${cyan("/forgedock-init")} for AI-powered optional section setup`);
  }
  lines.push(`  ${dim("•")} Run ${cyan("/work-on next")} to start your first task`);
  lines.push("");

  process.stdout.write(box(lines, { title: "Config Validation" }));
}

// ---------------------------------------------------------------------------
// Bot credentials — store in ~/.forgedock/credentials.json (NOT forge.yaml)
// ---------------------------------------------------------------------------

const FORGEDOCK_HOME = join(process.env.HOME, ".forgedock");
const CREDENTIALS_FILE = join(FORGEDOCK_HOME, "credentials.json");

/**
 * Save bot credentials to ~/.forgedock/credentials.json.
 * The private key itself is NOT stored — only the path.
 *
 * @param {{ appId: string, installationId: string, privateKeyPath: string }} creds
 */
async function saveBotCredentials(creds) {
  await mkdir(FORGEDOCK_HOME, { recursive: true, mode: 0o700 });
  // Tighten permissions on pre-existing installs: fs.mkdir({ recursive: true }) ignores
  // mode when the directory already exists (Linux kernel behaviour). chmodSync enforces
  // 0o700 unconditionally, matching the intent of the mode option above.
  chmodSync(FORGEDOCK_HOME, 0o700);
  const existing = loadBotCredentials() ?? {};
  const updated = { ...existing, bot: creds };
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(updated, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  // Tighten permissions on files created before this fix (mode is only applied at creation time)
  chmodSync(CREDENTIALS_FILE, 0o600);
}

/**
 * Load bot credentials from ~/.forgedock/credentials.json.
 * Returns null if the file is absent or malformed.
 *
 * @returns {{ appId: string, installationId: string, privateKeyPath: string } | null}
 */
function loadBotCredentials() {
  try {
    const raw = readFileSync(CREDENTIALS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed.bot ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GitHub App JWT — generates a short-lived RS256 JWT for App-level API calls
// ---------------------------------------------------------------------------

/**
 * Generate a GitHub App JWT (valid for 10 minutes).
 *
 * @param {string} appId      - GitHub App ID (numeric string)
 * @param {string} privateKey - PEM-encoded PKCS#8 or PKCS#1 RSA private key content
 * @returns {string} Signed JWT
 */
function generateAppJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,   // issued 60s ago to account for clock skew
    exp: now + 600,  // expires in 10 minutes (GitHub max)
    iss: appId,
  };

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const unsigned = `${header}.${body}`;

  const sign = createSign("RSA-SHA256");
  sign.update(unsigned);
  const signature = sign.sign(privateKey, "base64url");

  return `${unsigned}.${signature}`;
}

// ---------------------------------------------------------------------------
// Bot — connect existing GitHub App
// ---------------------------------------------------------------------------

/**
 * Interactive flow: prompt for App ID, private key path, installation ID.
 * Validates credentials against the GitHub API before saving.
 */
async function connectExistingBot() {
  console.log("");
  console.log(box(
    [
      `${bold("Connect an existing GitHub App")}`,
      "",
      "You'll need:",
      `  • App ID  (GitHub → Settings → Developer settings → GitHub Apps → your app)`,
      `  • Private key file  (.pem downloaded from app settings)`,
      `  • Installation ID  (GitHub → your org → Settings → Installed Apps → your app → configure → URL)`,
    ].join("\n"),
    { title: "Connect GitHub App" }
  ));
  console.log("");

  const appId = await input("App ID (numeric):", "");
  if (!appId || !/^\d+$/.test(appId.trim())) {
    console.log(`  ${RED}Invalid App ID — must be a numeric string.${RESET}`);
    return false;
  }

  const privateKeyPath = await input("Private key path (.pem):", "");
  const HOME = process.env.HOME ?? "";
  const expanded = privateKeyPath.trim().replace(/^~/, HOME);
  const resolvedKeyPath = resolve(expanded);
  if (privateKeyPath.trim().startsWith("~") && HOME && !resolvedKeyPath.startsWith(HOME + "/") && resolvedKeyPath !== HOME) {
    console.log(`  ${RED}Invalid path: cannot traverse outside home directory.${RESET}`);
    return false;
  }
  if (!existsSync(resolvedKeyPath)) {
    console.log(`  ${RED}File not found: ${resolvedKeyPath}${RESET}`);
    return false;
  }

  const installationId = await input("Installation ID (numeric):", "");
  if (!installationId || !/^\d+$/.test(installationId.trim())) {
    console.log(`  ${RED}Invalid Installation ID — must be a numeric string.${RESET}`);
    return false;
  }

  // Validate credentials with GitHub API
  console.log("");
  console.log(`  Validating credentials…`);
  let privateKey;
  try {
    privateKey = readFileSync(resolvedKeyPath, "utf-8");
  } catch (err) {
    console.log(`  ${RED}Cannot read private key: ${err.message}${RESET}`);
    return false;
  }

  try {
    const jwt = generateAppJwt(appId.trim(), privateKey);
    const resp = await fetch("https://api.github.com/app", {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      console.log(`  ${RED}GitHub API error ${resp.status}: ${body.message ?? "unknown"}${RESET}`);
      return false;
    }
    const appData = await resp.json();
    console.log(`  ${GREEN}Connected!${RESET} App: ${bold(appData.name)} (id: ${appId.trim()})`);
  } catch (err) {
    console.log(`  ${RED}Validation failed: ${err.message}${RESET}`);
    return false;
  }

  await saveBotCredentials({
    appId: appId.trim(),
    installationId: installationId.trim(),
    privateKeyPath: resolvedKeyPath,
  });

  console.log(`  Credentials saved to ${cyan(CREDENTIALS_FILE)}`);
  return true;
}

// ---------------------------------------------------------------------------
// Bot — status command
// ---------------------------------------------------------------------------

/**
 * Show bot health, identity, and rate limit usage.
 * Gracefully handles missing credentials.
 */
async function botStatus() {
  console.log("");
  console.log(`${BOLD}ForgeDock Bot Status${RESET}`);
  console.log("");

  const creds = loadBotCredentials();
  if (!creds) {
    console.log(
      `  ${YELLOW}No bot credentials found.${RESET}\n` +
      `  Run ${cyan("npx forgedock bot setup")} to configure a GitHub App, or\n` +
      `  add credentials to ${cyan(CREDENTIALS_FILE)}.`
    );
    console.log("");
    return;
  }

  console.log(`  App ID:          ${cyan(creds.appId)}`);
  console.log(`  Installation ID: ${cyan(creds.installationId)}`);
  console.log(`  Private key:     ${cyan(creds.privateKeyPath)}`);
  console.log("");

  // Check private key file
  if (!existsSync(creds.privateKeyPath)) {
    console.log(`  ${RED}Private key file not found: ${creds.privateKeyPath}${RESET}`);
    console.log(`  Run ${cyan("npx forgedock bot setup")} to reconfigure.`);
    console.log("");
    return;
  }

  console.log("  Verifying with GitHub API…");
  let privateKey;
  try {
    privateKey = readFileSync(creds.privateKeyPath, "utf-8");
  } catch (err) {
    console.log(`  ${RED}Cannot read private key: ${err.message}${RESET}`);
    console.log("");
    return;
  }

  try {
    const jwt = generateAppJwt(creds.appId, privateKey);

    // App identity
    const appResp = await fetch("https://api.github.com/app", {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!appResp.ok) {
      const body = await appResp.json().catch(() => ({}));
      console.log(`  ${RED}GitHub API error ${appResp.status}: ${body.message ?? "unknown"}${RESET}`);
      console.log("");
      return;
    }
    const appData = await appResp.json();
    console.log(`  ${GREEN}Connected${RESET} — App: ${bold(appData.name)} (slug: @${appData.slug})`);

    // Rate limit for app
    const rlResp = await fetch("https://api.github.com/rate_limit", {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (rlResp.ok) {
      const rl = await rlResp.json();
      const core = rl.resources?.core;
      if (core) {
        const used = core.limit - core.remaining;
        const resetTime = new Date(core.reset * 1000).toLocaleTimeString();
        console.log(`  Rate limit:      ${cyan(core.remaining)}/${core.limit} remaining (${used} used, resets ${resetTime})`);
      }
    }
  } catch (err) {
    console.log(`  ${RED}Error: ${err.message}${RESET}`);
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Bot — setup TUI step (called from StepOrchestrator or directly)
// ---------------------------------------------------------------------------

/**
 * Interactive bot setup step.
 * Shows options: Create new app / Connect existing / Skip.
 * Called as an optional step in tuiOnboarding() or via `npx forgedock bot setup`.
 */
async function botSetup() {
  console.log("");
  console.log(box(
    [
      `${bold("GitHub Bot Setup")} ${dim("(Optional)")}`,
      "",
      "A GitHub App gives ForgeDock its own identity",
      "for pipeline operations. Benefits:",
      `  ${cyan("•")} Separate audit trail for bot actions`,
      `  ${cyan("•")} Higher API rate limits`,
      `  ${cyan("•")} Webhook-driven automation (future)`,
      `  ${cyan("•")} Multi-user team support`,
    ].join("\n"),
    { title: "GitHub Bot" }
  ));
  console.log("");

  const action = await select("How would you like to set up the bot?", [
    { label: "Create new GitHub App (opens browser)", value: "create" },
    { label: "Connect existing GitHub App", value: "connect" },
    { label: "Skip — use personal token (current default)", value: "skip" },
  ]);

  if (action === "skip") {
    console.log(
      `  ${dim("Skipped.")} Run ${cyan("npx forgedock bot setup")} later to configure a bot identity.`
    );
    return;
  }

  if (action === "create") {
    // Build the GitHub App manifest URL — opens the browser-based creation flow
    const manifestPath = join(dirname(__filename), "github-app-manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      console.log(`  ${RED}Could not read github-app-manifest.json — skipping.${RESET}`);
      return;
    }

    const encodedManifest = encodeURIComponent(JSON.stringify(manifest));
    const createUrl = `https://github.com/settings/apps/new?manifest=${encodedManifest}`;

    console.log("");
    console.log(`  ${bold("Opening GitHub App registration in your browser…")}`);
    console.log(`  URL: ${cyan(createUrl.substring(0, 80))}…`);
    console.log("");

    // Try to open the browser
    try {
      const opener = process.platform === "win32" ? "start" :
                     process.platform === "darwin" ? "open" : "xdg-open";
      // On Windows, `start "url"` treats the first quoted arg as the window title.
      // Pass an empty title placeholder so the URL is treated as the target: `start "" "url"`.
      const cmd = process.platform === "win32"
        ? `start "" "${createUrl}"`
        : `${opener} "${createUrl}"`;
      execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      console.log(`  ${YELLOW}Could not open browser automatically.${RESET}`);
      console.log(`  Please open this URL manually:`);
      console.log(`  ${cyan(createUrl)}`);
    }

    console.log("");
    console.log("  After creating the app in your browser:");
    console.log(`  1. Download the private key (.pem) from the app settings`);
    console.log(`  2. Note your App ID and Installation ID`);
    console.log(`  3. Run ${cyan("npx forgedock bot setup")} again and choose \"Connect existing\"`);
    console.log("");
    return;
  }

  // action === "connect"
  const connected = await connectExistingBot();
  if (!connected) {
    throw new Error("Bot connection failed — credentials were not saved.");
  }
}

function help() {
  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — GitHub as a knowledge graph for AI agents`);
  console.log("");
  console.log("Usage:");
  console.log(`  ${CYAN}npx forgedock${RESET}            Launch TUI onboarding (interactive)`);
  console.log(`  ${CYAN}npx forgedock install${RESET}    Install commands`);
  console.log(`  ${CYAN}npx forgedock init${RESET}       Generate forge.yaml config for your project`);
  console.log(`  ${CYAN}npx forgedock validate${RESET}   Validate forge.yaml configuration`);
  console.log(`  ${CYAN}npx forgedock uninstall${RESET}  Remove commands (interactive, with confirmation)`);
  console.log(`  ${CYAN}npx forgedock uninstall --yes${RESET}  Remove commands without prompts (non-interactive)`);
  console.log(`  ${CYAN}npx forgedock update${RESET}     Pull latest & reinstall`);
  console.log(`  ${CYAN}npx forgedock bot${RESET}        Manage GitHub App bot identity`);
  console.log(`  ${CYAN}npx forgedock bot status${RESET} Show bot health and rate limit usage`);
  console.log(`  ${CYAN}npx forgedock bot setup${RESET}  Configure GitHub App bot (interactive)`);
  console.log(`  ${CYAN}npx forgedock help${RESET}       Show this help`);
  console.log("");
}

// ---------------------------------------------------------------------------
// TUI Onboarding — interactive step-based flow (default when no command given)
// ---------------------------------------------------------------------------

async function tuiOnboarding() {
  splash();

  // Non-TTY fallback: skip TUI and detection, run install directly
  if (!process.stdout.isTTY) {
    console.log(dim("  Non-interactive environment detected — running install."));
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
      `  ${green("Everything up to date.")} ForgeDock ${versionLabel} is installed and configured.`
    );
    console.log("");

    const action = await select("What would you like to do?", [
      { label: "Nothing — exit", value: "exit" },
      { label: "Reconfigure project (regenerate forge.yaml)", value: "reconfigure" },
      { label: "Reinstall commands", value: "reinstall" },
    ]);

    if (action === "reconfigure") {
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
      `New: ${green(`v${detection.currentVersion}`)}`
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
      const diffLines = formatCommandDiff(commandsBeforeUpdate, commandsAfterUpdate);
      if (diffLines.length > 0) {
        process.stdout.write(box(diffLines, { title: "Command changes" }));
        console.log("");
      }

      console.log(
        green("Update complete!") +
        ` ForgeDock v${detection.currentVersion} is now active.`
      );
      console.log("");
    } else {
      console.log("");
      console.log(
        yellow("Update incomplete.") +
        ` Re-run ${cyan("npx forgedock")} to try again.`
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
      `  ${yellow("Commands installed")} (${versionLabel}) but no ${cyan("forge.yaml")} found in this directory.`
    );
    console.log("");

    const steps = [
      {
        name: "Project Configuration",
        optional: true,
        run: async () => {
          const shouldInit = await confirm(
            "Generate forge.yaml for this project?",
            true
          );
          if (shouldInit) {
            await init();
          } else {
            console.log(
              `  ${dim("Skipped.")} Run ${cyan("npx forgedock init")} later to generate forge.yaml.`
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
        green("Done!") +
        ` Run ${cyan("/help")} inside Claude Code to see available commands.`
      );
      console.log("");
    } else {
      console.log("");
      console.log(
        yellow("Setup incomplete.") +
        ` Re-run ${cyan("npx forgedock")} to try again.`
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
      `  ${yellow("ForgeDock commands are installed")} but the installed version could not be determined.`
    );
    console.log(
      `  ${dim("The package.json for the installed copy is missing or unreadable.")}`
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
          console.log(`  ${green("forge.yaml")} already exists — skipping generation.`);
          return;
        }

        const shouldInit = await confirm(
          "No forge.yaml found. Generate one now?",
          true
        );
        if (shouldInit) {
          await init();
        } else {
          console.log(
            `  ${dim("Skipped.")} Run ${cyan("npx forgedock init")} later to generate forge.yaml.`
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
    {
      name: "GitHub Bot Setup",
      optional: true,
      run: async () => {
        await botSetup();
      },
    },
  ];

  const orchestrator = new StepOrchestrator(steps);
  const success = await orchestrator.run();

  if (success) {
    console.log(
      green("Setup complete!") +
      ` Run ${cyan("/help")} inside Claude Code to see available commands.`
    );
    console.log("");
  } else {
    console.log("");
    console.log(
      yellow("Setup incomplete.") +
      ` Re-run ${cyan("npx forgedock")} to try again.`
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
    case "bot": {
      const subcommand = args[1];
      if (!subcommand || subcommand === "status") {
        await botStatus();
      } else if (subcommand === "setup") {
        await botSetup();
      } else {
        console.log(`${RED}Unknown bot subcommand: ${subcommand}${RESET}`);
        console.log(`Usage: ${CYAN}npx forgedock bot [status|setup]${RESET}`);
        process.exit(1);
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
      process.exit(1);
  }
}
