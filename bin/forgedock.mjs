#!/usr/bin/env node

import { fileURLToPath } from "url";
import { dirname, join, relative } from "path";
import { mkdir, symlink, readlink, lstat, readdir, stat } from "fs/promises";
import { existsSync, appendFileSync, readFileSync, writeFileSync, renameSync } from "fs";
import { execSync } from "child_process";
import {
  BOLD, GREEN, YELLOW, CYAN, RED, RESET,
  bold, dim, green, yellow, cyan, red,
  box, stepHeader, select, confirm, input, createProgressBar, spinner,
} from "./tui.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FORGE_HOME = dirname(__dirname);
const COMMANDS_DIR = join(FORGE_HOME, "commands");
const TARGET_DIR = join(process.env.HOME ?? "", ".claude", "commands");

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
// Install state detection
// ---------------------------------------------------------------------------

/**
 * @typedef {'fresh-install' | 'up-to-date' | 'update-available' | 'config-missing'} InstallState
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
    return { state: "fresh-install", installedVersion: null, currentVersion };
  }

  // Commands are installed — now determine sub-state
  const forgeYamlPath = join(process.cwd(), "forge.yaml");
  const hasConfig = existsSync(forgeYamlPath);

  if (!hasConfig) {
    return { state: "config-missing", installedVersion, currentVersion };
  }

  // Both commands and config are present — compare versions
  if (installedVersion !== null && installedVersion !== currentVersion) {
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

  /** @type {Array<{rel: string, action: 'installed'|'updated'|'skipped'|'conflict'}>} */
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
          await symlink(file, target + ".tmp");
          const { rename } = await import("fs/promises");
          await rename(target + ".tmp", target);
          updated++;
          results.push({ rel, action: "updated" });
          bar.tick(1, rel);
        }
      } else {
        // Regular file is blocking the symlink — record as conflict
        skipped++;
        conflicts.push(rel);
        results.push({ rel, action: "conflict" });
        bar.tick(1, rel);
      }
    } catch {
      // Doesn't exist — create symlink
      await symlink(file, target);
      installed++;
      results.push({ rel, action: "installed" });
      bar.tick(1, rel);
    }
  }

  const totalLabel =
    installed > 0
      ? `${green("✔")} Installed ${installed + updated}/${files.length} commands`
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

  return { installed, updated, skipped };
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
    summaryLines.push(`  ${red("Commands")}:   ${bold(String(toRemove.length))} symlinks in ${dim(TARGET_DIR)}`);
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
          writeFileSync(profile, cleaned, "utf-8");
          const profileShort = profile.replace(process.env.HOME ?? "", "~");
          console.log(`  ${green("✔")} Removed FORGE_HOME from ${profileShort}`);
        } catch (err) {
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
        `  ${YELLOW}Cannot fast-forward — local changes exist. Skipping.${RESET}`
      );
    }
  } else {
    console.log(`  Installed via npm. Run ${CYAN}npm update -g forgedock${RESET} to update.`);
  }
  console.log("");
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
    _printNextSteps({ remoteDetected, cyan: (s) => `${CYAN}${s}${RESET}`, bold: (s) => `${BOLD}${s}${RESET}` });
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
      // --- Handle existing forge.yaml with confirmation ---
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
      });

      console.log("");
      console.log(`  ${GREEN}Created${RESET}: forge.yaml`);
      console.log("");
      _printNextSteps({ remoteDetected: ownerInput !== "your-github-org", cyan: (s) => `${CYAN}${s}${RESET}`, bold: (s) => `${BOLD}${s}${RESET}` });
      await validate(outputPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers for init()
// ---------------------------------------------------------------------------

/**
 * Build the forge.yaml file content string from gathered values.
 * Returns only the required sections (project, paths, branches) plus commented optional sections.
 */
function buildForgeYamlContent({ owner, repo, projectName, description, root, worktreeBase, defaultBranch, stagingBranch }) {
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

# repos:
#   default:
#     repo: "${owner}/${repo}"
#     staging_branch: "${stagingBranch}"
#   satellites:
#     - prefix: "mcp"
#       repo: "${owner}/your-satellite-repo"
#       staging_branch: "main"
#       local_path: "${join(root, "..", "your-satellite-repo")}"

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
}

/** Write forge.yaml to disk. */
function _writeForgeYaml(opts) {
  const content = buildForgeYamlContent(opts);
  writeFileSync(opts.outputPath, content, "utf-8");
}

/** Print next-steps guidance after forge.yaml is written. */
function _printNextSteps({ remoteDetected, cyan, bold }) {
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
 * @returns {string}       - Trimmed value, or empty string if not found
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
      execSync(`gh repo view "${owner}/${repo}" --json name`, {
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
        const result = execSync(`git ls-remote --heads origin "${branch}"`, {
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
    } else if (!projectId.startsWith("PVT_")) {
      checks.push({
        label: "Project board configured",
        status: "error",
        note: `project_id must start with PVT_ (got: ${projectId.slice(0, 12)}...)`,
      });
    } else {
      try {
        const result = execSync(
          `gh api graphql -f query='query { node(id: "${projectId}") { id __typename } }'`,
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
          execSync(`gh repo view "${sat}" --json name`, {
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
