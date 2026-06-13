#!/usr/bin/env node

import { fileURLToPath } from "url";
import { dirname, join, relative } from "path";
import { mkdir, symlink, readlink, lstat, readdir, stat } from "fs/promises";
import {
  existsSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
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

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

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

  // Auto-generate forge.yaml if missing — no second command needed
  const forgeYamlPath = join(process.cwd(), "forge.yaml");
  if (!existsSync(forgeYamlPath)) {
    await init(true);
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
        // Skip lines that are just badges or HTML
        if (!inFirstParagraph && line.match(/^[!<\[]/)) continue;
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
  description: "${description}"

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
