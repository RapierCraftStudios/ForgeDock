#!/usr/bin/env node

import { fileURLToPath } from "url";
import { dirname, join, relative } from "path";
import { mkdir, symlink, readlink, lstat, readdir, stat } from "fs/promises";
import { existsSync, appendFileSync, readFileSync, writeFileSync, renameSync } from "fs";
import { execSync } from "child_process";
import {
  BOLD, GREEN, YELLOW, CYAN, RED, RESET,
  bold, dim, green, yellow, cyan, red,
  box, spinner, stepHeader, select, confirm,
} from "./tui.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FORGE_HOME = dirname(__dirname);
const COMMANDS_DIR = join(FORGE_HOME, "commands");
const TARGET_DIR = join(process.env.HOME ?? "", ".claude", "commands");

const args = process.argv.slice(2);
const command = args[0];

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
          // If handled (retried successfully or skipped), continue
          if (step.status !== "done" && step.status !== "skipped") {
            // Was skipped via handler
            continue;
          }
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
      this.currentIndex++;
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
// Legacy commands (install, uninstall, update, init, help)
// ---------------------------------------------------------------------------

async function install() {
  checkPrerequisites();

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
          `  ${YELLOW}WARNING${RESET}: ${rel} is a regular file — skipping (remove it manually to let ForgeDock manage it)`
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
    `Done. ${GREEN}Installed: ${installed}${RESET}, Updated: ${updated}, Skipped: ${skipped}`
  );
  console.log("");

  // Set FORGE_HOME in shell profiles
  let profileUpdated = false;
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
        console.log(`  Added FORGE_HOME to ${profile}`);
        profileUpdated = true;
      }
    }
  }

  console.log(
    `${GREEN}ForgeDock commands are now available as slash commands in any Claude Code session.${RESET}`
  );
  console.log("");

  // forge.yaml advisory — guide users to run init if config is missing
  const forgeYamlPath = join(process.cwd(), "forge.yaml");
  if (!existsSync(forgeYamlPath)) {
    console.log(`${YELLOW}No forge.yaml found in current directory.${RESET}`);
    console.log(
      `  Run ${CYAN}npx forgedock init${RESET} in your project root to generate forge.yaml`
    );
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
    const httpsMatch = remoteUrl.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);

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
        `  ${YELLOW}Warning${RESET}: Could not parse git remote URL — using placeholder values`
      );
    }
  } catch {
    console.log(
      `  ${YELLOW}Warning${RESET}: No git remote found — using placeholder values`
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
      console.log(`  Default branch:  ${CYAN}${defaultBranch}${RESET} (from current branch)`);
    } catch {
      console.log(
        `  ${YELLOW}Warning${RESET}: Could not detect default branch — defaulting to "main"`
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
        `  Staging branch:  ${CYAN}${defaultBranch}${RESET} (no staging branch found — using default)`
      );
    }
  } catch {
    console.log(
      `  ${YELLOW}Warning${RESET}: Could not read remote branches — defaulting staging to "${defaultBranch}"`
    );
    stagingBranch = defaultBranch;
  }

  // --- Handle existing forge.yaml ---
  if (existsSync(outputPath)) {
    const baseBak = join(cwd, "forge.yaml.bak");
    const backupPath = existsSync(baseBak)
      ? join(
          cwd,
          `forge.yaml.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`
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
  description: ""

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
  console.log(`${BOLD}Next steps:${RESET}`);
  console.log(`  1. Edit ${CYAN}forge.yaml${RESET} — fill in your project details`);
  console.log(`     Required: project.name, project.description`);
  if (!remoteDetected) {
    console.log(`     Required: project.owner, project.repo (could not auto-detect)`);
  }
  console.log(`  2. Add ${CYAN}forge.yaml${RESET} to ${CYAN}.gitignore${RESET} if it contains sensitive paths`);
  console.log(`  3. Run ${CYAN}/forgedock-init${RESET} inside Claude Code for guided AI-powered setup`);
  console.log("");
}

function help() {
  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — GitHub as a knowledge graph for AI agents`);
  console.log("");
  console.log("Usage:");
  console.log(`  ${CYAN}npx forgedock${RESET}            Launch TUI onboarding (interactive)`);
  console.log(`  ${CYAN}npx forgedock install${RESET}    Install commands`);
  console.log(`  ${CYAN}npx forgedock init${RESET}       Generate forge.yaml config for your project`);
  console.log(`  ${CYAN}npx forgedock uninstall${RESET}  Remove commands`);
  console.log(`  ${CYAN}npx forgedock update${RESET}     Pull latest & reinstall`);
  console.log(`  ${CYAN}npx forgedock help${RESET}       Show this help`);
  console.log("");
}

// ---------------------------------------------------------------------------
// TUI Onboarding — interactive step-based flow (default when no command given)
// ---------------------------------------------------------------------------

async function tuiOnboarding() {
  splash();

  // Non-TTY fallback: skip TUI, run install directly
  if (!process.stdout.isTTY) {
    console.log(dim("  Non-interactive environment detected — running install."));
    console.log("");
    await install();
    return;
  }

  const steps = [
    {
      name: "Preflight Checks",
      optional: false,
      run: async () => {
        checkPrerequisites();
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
