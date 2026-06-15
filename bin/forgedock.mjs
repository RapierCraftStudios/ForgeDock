#!/usr/bin/env node

import { fileURLToPath } from "url";
import { dirname, join, relative } from "path";
import { mkdir, symlink, readlink, lstat, readdir } from "fs/promises";
import {
  existsSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
} from "fs";
import { execSync } from "child_process";
import readline from "readline";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FORGE_HOME = dirname(__dirname);
const COMMANDS_DIR = join(FORGE_HOME, "commands");
const SCRIPTS_DIR = join(FORGE_HOME, "scripts");

if (!process.env.HOME) {
  process.stderr.write(
    "Error: HOME environment variable is not set. Cannot determine install location.\n",
  );
  process.exit(1);
}

const TARGET_DIR = join(process.env.HOME, ".claude", "commands");
const SCRIPTS_TARGET_DIR = join(process.env.HOME, ".claude", "scripts");

const args = process.argv.slice(2);
const command = args[0] || "install";

// ---------------------------------------------------------------------------
// Splash — the ForgeDock F-monogram logo shown at startup
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

/**
 * Prompt the user for a yes/no confirmation.
 * Returns false (safe default) when stdin is not a TTY (e.g. CI or piped input).
 */
async function confirmOverwrite(question) {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      `  ${YELLOW}Non-interactive environment detected — aborting to protect existing config.${RESET}\n`,
    );
    return false;
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(
        answer.trim().toLowerCase() === "y" ||
          answer.trim().toLowerCase() === "yes",
      );
    });
  });
}

/**
 * Returns true if `dir` is inside a git work tree. Used to avoid generating
 * forge.yaml in non-project directories — e.g. when npx defaults cwd to a
 * system folder (C:\Windows) because the launching shell sat on an
 * unsupported UNC/WSL path. The command is a fixed string with no
 * interpolated input, so there is no shell-injection surface (ref #151).
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
// Shared file-linking logic — used by both install() and update()
// ---------------------------------------------------------------------------

/**
 * Link or copy all commands from COMMANDS_DIR into TARGET_DIR.
 * Calls step.progress(idx+1, total) on each file.
 * Returns { installed, updated, skipped }.
 */
async function linkCommands(step) {
  const files = await findMarkdownFiles(COMMANDS_DIR);
  const total = files.length;
  let installed = 0;
  let updated = 0;
  let skipped = 0;

  for (let idx = 0; idx < files.length; idx++) {
    const file = files[idx];
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
          updated++;
        }
      } else {
        // Existing regular file — a ForgeDock-shipped command copied by a prior
        // install (common on Windows, where symlinks aren't permitted). It is
        // ForgeDock-managed (we only iterate shipped command names), so refresh
        // it: skip if already current, otherwise overwrite with a fresh copy.
        if (readFileSync(file, "utf-8") === readFileSync(target, "utf-8")) {
          skipped++;
        } else {
          copyFileSync(file, target);
          updated++;
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
      // Doesn't exist — create it. Prefer a symlink; fall back to a copy on
      // systems where symlink creation is not permitted (e.g. Windows without
      // Developer Mode / admin), which would otherwise throw EPERM. See #587.
      try {
        await symlink(file, target);
      } catch (linkErr) {
        if (linkErr.code === "EPERM" || linkErr.code === "EACCES") {
          copyFileSync(file, target);
        } else {
          throw linkErr;
        }
      }
      installed++;
    }

    step.progress(idx + 1, total);
  }

  return { installed, updated, skipped };
}

/**
 * Enumerate all executable scripts in SCRIPTS_DIR (*.sh, *.mjs).
 * Subdirectories are not traversed — scripts/ is a flat directory.
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
    if (entry.isFile() && (entry.name.endsWith(".sh") || entry.name.endsWith(".mjs"))) {
      results.push(join(dir, entry.name));
    }
  }
  return results.sort();
}

/**
 * Link or copy all scripts from SCRIPTS_DIR into SCRIPTS_TARGET_DIR (~/.claude/scripts/).
 * Mirrors linkCommands() behaviour: symlink where permitted, copy on EPERM/EACCES (Windows).
 * Calls step.progress(idx+1, total) on each file.
 * Returns { installed, updated, skipped }.
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
          updated++;
        }
      } else {
        // Existing regular file — refresh if contents differ.
        if (readFileSync(file, "utf-8") === readFileSync(target, "utf-8")) {
          skipped++;
        } else {
          copyFileSync(file, target);
          updated++;
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
      // Doesn't exist — create symlink; fall back to copy on Windows EPERM/EACCES.
      try {
        await symlink(file, target);
      } catch (linkErr) {
        if (linkErr.code === "EPERM" || linkErr.code === "EACCES") {
          copyFileSync(file, target);
        } else {
          throw linkErr;
        }
      }
      installed++;
    }

    step.progress(idx + 1, total);
  }

  return { installed, updated, skipped };
}

// ---------------------------------------------------------------------------
// Core forge.yaml detection + write — used by both install() and init()
// ---------------------------------------------------------------------------

/**
 * Detect project info from the current working directory and write forge.yaml.
 * Returns the detected config object.
 * This is pure logic — no TUI output. Called from inside step callbacks.
 *
 * @param {string} cwd - Current working directory
 * @param {object} [opts]
 * @param {(text: string) => void} [opts.onNote] - Called with incremental progress notes
 * @returns {Promise<{owner, repo, remoteDetected, defaultBranch, stagingBranch, description, outputPath, wrote: boolean, skipped: boolean, skipReason: string}>}
 */
async function detectAndBuildForgeYaml(cwd, opts = {}) {
  const { onNote = () => {} } = opts;
  const worktreeBase = join(cwd, ".claude", "worktrees");
  const outputPath = join(cwd, "forge.yaml");

  const detected = {
    owner: "your-github-org",
    repo: "your-repo-name",
    remoteDetected: false,
    defaultBranch: "main",
    stagingBranch: "staging",
    description: "",
  };

  // --- Detect git remote URL and parse owner/repo ---
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
      detected.owner = sshMatch[1];
      detected.repo = sshMatch[2];
      detected.remoteDetected = true;
    } else if (httpsMatch) {
      detected.owner = httpsMatch[1];
      detected.repo = httpsMatch[2];
      detected.remoteDetected = true;
    }
  } catch {
    // No git remote — use placeholders
  }

  onNote(
    detected.remoteDetected
      ? `${detected.owner}/${detected.repo}`
      : "no git remote — using placeholders",
  );

  // --- Detect default branch ---
  try {
    const headRef = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    detected.defaultBranch = headRef.replace(/^refs\/remotes\/origin\//, "");
  } catch {
    try {
      detected.defaultBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (detected.defaultBranch === "HEAD") detected.defaultBranch = "main";
    } catch {
      // Use default "main"
    }
  }

  // --- Detect staging branch ---
  try {
    const remoteBranches = execSync("git branch -r", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    detected.stagingBranch = remoteBranches.includes("origin/staging")
      ? "staging"
      : detected.defaultBranch;
  } catch {
    detected.stagingBranch = detected.defaultBranch;
  }

  // --- Auto-detect project description from README.md / CLAUDE.md ---
  function extractFirstParagraph(text) {
    const lines = text.split("\n");
    let inFirstParagraph = false;
    const paragraphLines = [];
    for (const line of lines) {
      if (!inFirstParagraph && line.match(/^#/)) continue;
      if (!inFirstParagraph && line.trim() === "") continue;
      if (!inFirstParagraph && line.match(/^[!<\[`|]/)) continue;
      if (!inFirstParagraph && line.match(/^---/)) continue;
      if (!inFirstParagraph) {
        inFirstParagraph = true;
      }
      if (line.trim() === "") break;
      paragraphLines.push(line.trim());
    }
    if (paragraphLines.length === 0) return "";
    return paragraphLines
      .join(" ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .slice(0, 200)
      .trim();
  }

  for (const fname of ["README.md", "CLAUDE.md"]) {
    if (detected.description) break;
    try {
      const fpath = join(cwd, fname);
      if (existsSync(fpath)) {
        detected.description = extractFirstParagraph(
          readFileSync(fpath, "utf-8").slice(0, 2048),
        );
      }
    } catch {
      // Best-effort only
    }
  }

  // --- Build forge.yaml content ---
  const { owner, repo, defaultBranch, stagingBranch, description } = detected;

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
  description: "${description.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"

# =============================================================================
# PATHS (REQUIRED)
# =============================================================================

paths:
  root: "${cwd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
  worktree_base: "${worktreeBase.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"

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

  try {
    writeFileSync(outputPath, content, "utf-8");
  } catch (err) {
    throw new Error(
      `Could not write forge.yaml to ${outputPath} — ${err.code ?? err.message}. ` +
        `Run npx forgedock init from a writable project directory.`,
    );
  }

  return { ...detected, outputPath, wrote: true };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function install() {
  const result = await runSteps([
    {
      label: "Checking environment",
      async run(step) {
        await mkdir(TARGET_DIR, { recursive: true });
        step.note(cyan(TARGET_DIR));
      },
    },
    {
      label: "Linking commands",
      async run(step) {
        const { installed, updated, skipped } = await linkCommands(step);
        step.note(
          `${green(String(installed))} installed, ${updated} updated, ${dim(String(skipped))} skipped`,
        );
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
      label: "Configuring session hook",
      async run(step) {
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
      label: "Generating forge.yaml",
      async run(step) {
        // Auto-generate forge.yaml if missing — no second command needed.
        // Only do this inside a real git project; otherwise cwd may be a system or
        // read-only directory (e.g. C:\Windows when npx is launched from a WSL path),
        // and writing forge.yaml there would crash. See #585.
        const cwd = process.cwd();
        const forgeYamlPath = join(cwd, "forge.yaml");
        if (existsSync(forgeYamlPath)) {
          step.skip("forge.yaml already exists");
          return;
        }
        if (!isGitWorkTree(cwd)) {
          step.skip(
            "not a git project — run npx forgedock init inside your project",
          );
          return;
        }
        const detected = await detectAndBuildForgeYaml(cwd, {
          onNote: () => {},
        });
        if (!detected.remoteDetected) {
          step.note("created — fill in project.owner and project.repo");
        } else {
          step.note(`created for ${detected.owner}/${detected.repo}`);
        }
      },
    },
  ]);

  if (result.ok) {
    process.stderr.write(
      box(
        [
          `${green("✔")} ${bold("ForgeDock is ready")}`,
          "",
          `Commands installed to ${cyan(TARGET_DIR)}`,
          `Scripts installed to  ${cyan(SCRIPTS_TARGET_DIR)}`,
          `Next: ${cyan("cd <your-project>")} then ${cyan("npx forgedock init")}`,
        ],
        { title: "ForgeDock Installed" },
      ) + "\n",
    );
  }
}

async function uninstall() {
  const result = await runSteps([
    {
      label: "Removing commands",
      async run(step) {
        const files = await findMarkdownFiles(COMMANDS_DIR);
        const total = files.length;
        let removed = 0;

        for (let idx = 0; idx < files.length; idx++) {
          const file = files[idx];
          const rel = relative(COMMANDS_DIR, file);
          const target = join(TARGET_DIR, rel);

          try {
            const stats = await lstat(target);
            const { unlink } = await import("fs/promises");
            if (stats.isSymbolicLink()) {
              const current = await readlink(target);
              if (current === file) {
                await unlink(target);
                removed++;
              }
            } else if (
              readFileSync(file, "utf-8") === readFileSync(target, "utf-8")
            ) {
              // Regular file installed by ForgeDock in copy mode (content matches the
              // shipped command). Safe to remove. Content-differing files are left
              // in place in case the user edited them.
              await unlink(target);
              removed++;
            }
          } catch (err) {
            if (err.code !== "ENOENT") {
              throw err;
            }
            // Doesn't exist — nothing to do
          }

          step.progress(idx + 1, total);
        }

        step.note(`${red(String(removed))} removed`);
      },
    },
  ]);

  if (result.ok) {
    process.stderr.write(
      box(
        [
          `${green("✔")} ForgeDock commands removed`,
          "",
          `Re-install anytime: ${cyan("npx forgedock")}`,
        ],
        { title: "ForgeDock Uninstalled" },
      ) + "\n",
    );
  }
}

async function update() {
  // Check if installed via npm (no .git directory) or via git clone
  const gitDir = join(FORGE_HOME, ".git");
  if (!existsSync(gitDir)) {
    await runSteps([
      {
        label: "Checking update path",
        async run(step) {
          step.skip(`installed via npm — run ${cyan("npm update -g forgedock")}`);
        },
      },
    ]);
    return;
  }

  const result = await runSteps([
    {
      label: "Checking current branch",
      async run(step) {
        const branch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: FORGE_HOME,
          encoding: "utf-8",
        }).trim();
        if (branch !== "main") {
          step.skip(`not on main (${branch})`);
        } else {
          step.note("on main");
        }
      },
    },
    {
      label: "Fetching latest",
      async run(step) {
        const branch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: FORGE_HOME,
          encoding: "utf-8",
        }).trim();
        if (branch !== "main") {
          step.skip("skipped — not on main");
          return;
        }
        const before = execSync("git rev-parse HEAD", {
          cwd: FORGE_HOME,
          encoding: "utf-8",
        }).trim();
        try {
          execSync("git fetch origin main --quiet", { cwd: FORGE_HOME });
          execSync("git merge --ff-only origin/main --quiet", {
            cwd: FORGE_HOME,
          });
        } catch {
          step.skip("cannot fast-forward — local changes exist");
          return;
        }
        const after = execSync("git rev-parse HEAD", {
          cwd: FORGE_HOME,
          encoding: "utf-8",
        }).trim();
        if (before === after) {
          step.skip("already up to date");
        } else {
          step.note(`${before.slice(0, 7)} → ${after.slice(0, 7)}`);
        }
      },
    },
    {
      label: "Reinstalling commands",
      async run(step) {
        const branch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: FORGE_HOME,
          encoding: "utf-8",
        }).trim();
        if (branch !== "main") {
          step.skip("skipped — not on main");
          return;
        }
        const { installed, updated, skipped } = await linkCommands(step);
        step.note(
          `${green(String(installed))} installed, ${updated} updated, ${dim(String(skipped))} skipped`,
        );
      },
    },
    {
      label: "Reinstalling scripts",
      async run(step) {
        const branch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: FORGE_HOME,
          encoding: "utf-8",
        }).trim();
        if (branch !== "main") {
          step.skip("skipped — not on main");
          return;
        }
        const { installed, updated, skipped } = await linkScripts(step);
        if (installed + updated + skipped > 0) {
          step.note(
            `${green(String(installed))} installed, ${updated} updated, ${dim(String(skipped))} skipped`,
          );
        }
      },
    },
  ]);

  if (result.ok) {
    process.stderr.write(
      box([`${green("✔")} ForgeDock is up to date`], {
        title: "ForgeDock Updated",
      }) + "\n",
    );
  }
}

/**
 * Scaffold the .forgedock/scripts/ directory in the project root.
 *
 * Idempotent — safe to call on every `npx forgedock init` run:
 *   - mkdir uses { recursive: true } so it never errors if the dir exists
 *   - README.md is only written if it doesn't already exist
 *   - .gitignore entry is only appended if not already present
 */
async function scaffoldAdaptiveScriptsDir(cwd) {
  const scriptsDir = join(cwd, ".forgedock", "scripts");
  const readmePath = join(scriptsDir, "README.md");
  const gitignorePath = join(cwd, ".gitignore");
  const GITIGNORE_ENTRY = ".forgedock/scripts/";
  const GITIGNORE_COMMENT =
    "# Per-repo adaptive scripts — gitignored by default.\n# Remove the line below to commit scripts to version control.";

  const README_CONTENT = `# .forgedock/scripts/

Per-repo adaptive scripts for this project. Generated and maintained by ForgeDock.

## Purpose

This directory stores project-specific scripts that encode patterns ForgeDock has
learned about this repository — branch naming conventions, label schemes, test paths,
commit formats, and other recurring workflow details.

## Gitignore behaviour

This directory is gitignored by default. To commit scripts to version control, remove
the \`.forgedock/scripts/\` line from your \`.gitignore\`.

## Usage

Scripts here are discovered automatically by ForgeDock pipeline agents. They take
precedence over universal scripts shipped with ForgeDock, so you can override any
default behaviour by adding a same-named script here.

See: https://github.com/RapierCraftStudios/ForgeDock for full documentation.
`;

  // 1. Create directory (idempotent)
  await mkdir(scriptsDir, { recursive: true });

  // 2. Write README.md only if not already present
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, README_CONTENT, "utf-8");
  }

  // 3. Append .gitignore entry only if not already present
  if (existsSync(gitignorePath)) {
    const current = readFileSync(gitignorePath, "utf-8");
    if (!current.includes(GITIGNORE_ENTRY)) {
      appendFileSync(
        gitignorePath,
        `\n${GITIGNORE_COMMENT}\n${GITIGNORE_ENTRY}\n`,
      );
    }
  } else {
    writeFileSync(
      gitignorePath,
      `${GITIGNORE_COMMENT}\n${GITIGNORE_ENTRY}\n`,
      "utf-8",
    );
  }
}

async function init(fromInstall = false) {
  const cwd = process.cwd();
  const outputPath = join(cwd, "forge.yaml");

  // When called from install(), we already know forge.yaml doesn't exist
  // and cwd is a git work tree — go straight to detection and write.
  if (fromInstall) {
    const detected = await detectAndBuildForgeYaml(cwd, { onNote: () => {} });
    if (!detected.remoteDetected) {
      process.stderr.write(
        box(
          [
            `${yellow("Action required:")}`,
            `Edit ${cyan("forge.yaml")} — fill in ${cyan("project.owner")} and ${cyan("project.repo")}`,
            "(git remote not detected)",
          ],
          { title: "forge.yaml Generated" },
        ) + "\n",
      );
    }
    await scaffoldAdaptiveScriptsDir(cwd);
    return;
  }

  // Interactive path — run as a step-checklist with a full summary box.
  let detected = null;
  let aborted = false;

  // Handle existing forge.yaml before entering runSteps (needs interactive prompt)
  if (existsSync(outputPath)) {
    process.stderr.write(
      `\n  ${YELLOW}Warning:${RESET} forge.yaml already exists at ${outputPath}\n`,
    );
    process.stderr.write(
      `  Continuing will back up your existing config and replace it.\n\n`,
    );
    const confirmed = await confirmOverwrite(`  Overwrite? [y/N] `);
    if (!confirmed) {
      process.stderr.write(
        `\n  ${YELLOW}Aborted.${RESET} Your forge.yaml was not modified.\n\n`,
      );
      return;
    }
    process.stderr.write("\n");

    // Back up existing file before proceeding
    const baseBak = join(cwd, "forge.yaml.bak");
    const backupPath = existsSync(baseBak)
      ? join(
          cwd,
          `forge.yaml.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`,
        )
      : baseBak;
    const backupName = backupPath.split("/").pop();
    renameSync(outputPath, backupPath);
    process.stderr.write(`  ${YELLOW}Backed up${RESET}: forge.yaml → ${backupName}\n\n`);
  }

  const result = await runSteps([
    {
      label: "Detecting project",
      async run(step) {
        detected = await detectAndBuildForgeYaml(cwd, {
          onNote: (msg) => step.note(msg),
        });
      },
    },
  ]);

  if (!result.ok || !detected) return;

  const {
    owner,
    repo,
    defaultBranch,
    stagingBranch,
    remoteDetected,
    description,
  } = detected;

  const summaryLines = [
    `${green("✔")} forge.yaml generated`,
    "",
    `  repo:     ${cyan(owner + "/" + repo)}`,
    `  default:  ${cyan(defaultBranch)}`,
    `  staging:  ${cyan(stagingBranch)}`,
  ];
  if (description) {
    summaryLines.push(
      `  desc:     ${dim(
        description.slice(0, 60) + (description.length > 60 ? "…" : ""),
      )}`,
    );
  }
  summaryLines.push("");
  if (!remoteDetected) {
    summaryLines.push(
      `${yellow("→")} Edit ${cyan("forge.yaml")} — fill in ${cyan("project.owner")} and ${cyan("project.repo")}`,
    );
  } else {
    summaryLines.push(
      `${green("→")} Review ${cyan("forge.yaml")} — all required fields were auto-detected`,
    );
  }
  summaryLines.push(
    `${green("→")} Add ${cyan("forge.yaml")} to ${cyan(".gitignore")} if it contains sensitive paths`,
  );
  summaryLines.push(
    `${green("→")} Run ${cyan("/forgedock-init")} inside Claude Code for guided AI-powered setup`,
  );

  process.stderr.write(
    box(summaryLines, { title: "forge.yaml Generated" }) + "\n",
  );

  await scaffoldAdaptiveScriptsDir(cwd);
}

/**
 * Scaffold the devdocs tree from ForgeDock's seed templates into the project's
 * configured devdocs path. Reads forge.yaml to determine the target path.
 * Idempotent: skips files that already exist so user edits are preserved.
 *
 * This implements the `npx forgedock docs init` command referenced in CONFIG.md
 * and the devdocs loading phases of work-on/build/context and architect.
 */
async function docsInit() {
  const cwd = process.cwd();

  // --- Resolve target devdocs path from forge.yaml ---
  let devdocsRel = "devdocs";
  const forgeYamlPath = join(cwd, "forge.yaml");

  if (existsSync(forgeYamlPath)) {
    try {
      const yaml = readFileSync(forgeYamlPath, "utf-8");
      const match = yaml.match(/^devdocs:\s*\n(?:\s+[^\n]*\n)*?\s+path:\s*["']?([^"'\n]+)["']?/m);
      if (match) {
        devdocsRel = match[1].trim();
      }
    } catch {
      // Best-effort; use default
    }
  }

  const devdocsTarget = join(cwd, devdocsRel);
  const templatesSource = join(FORGE_HOME, "templates", "devdocs");

  if (!existsSync(templatesSource)) {
    process.stderr.write(
      `${RED}Error: templates/devdocs not found at ${templatesSource}${RESET}\n` +
      `This usually means ForgeDock was installed via npm but the template directory is missing.\n` +
      `Try reinstalling: ${cyan("npm install -g forgedock")}\n`,
    );
    process.exit(1);
  }

  /**
   * Recursively copy files from src to dest.
   * Skips files that already exist at dest (idempotent — user edits preserved).
   * Returns { copied, skipped }.
   */
  async function copyTree(src, dest, step) {
    let copied = 0;
    let skipped = 0;

    await mkdir(dest, { recursive: true });

    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);

      if (entry.isDirectory()) {
        const result = await copyTree(srcPath, destPath, step);
        copied += result.copied;
        skipped += result.skipped;
      } else {
        if (existsSync(destPath)) {
          skipped++;
        } else {
          copyFileSync(srcPath, destPath);
          copied++;
        }
      }
    }

    return { copied, skipped };
  }

  const result = await runSteps([
    {
      label: `Scaffolding devdocs → ${cyan(devdocsRel + "/")}`,
      async run(step) {
        const { copied, skipped } = await copyTree(
          templatesSource,
          devdocsTarget,
          step,
        );
        step.note(
          `${green(String(copied))} created, ${dim(String(skipped))} already exist (skipped)`,
        );
      },
    },
  ]);

  if (result.ok) {
    process.stderr.write(
      box(
        [
          `${green("✔")} DevDocs scaffolded to ${cyan(devdocsRel + "/")}`,
          "",
          `  ${green("→")} Edit ${cyan(devdocsRel + "/project/*.md")} with your project's stack, architecture, and conventions`,
          `  ${green("→")} Edit ${cyan(devdocsRel + "/project/custom-instructions.md")} for binding agent directives`,
          `  ${green("→")} Review ${cyan(devdocsRel + "/index.yaml")} to configure selective domain loading`,
          `  ${dim("→")} ${cyan(devdocsRel + "/agent/*.md")} — ForgeDock defaults; edit only to override pipeline behavior`,
          "",
          `  Docs are gitignored by default if ${cyan("devdocs/")} is in ${cyan(".gitignore")}.`,
          `  Commit ${cyan(devdocsRel + "/")} to share conventions with your team.`,
        ],
        { title: "DevDocs Initialised" },
      ) + "\n",
    );
  }
}

function help() {
  // renderLogo already shown by splash() above — show the command table
  const commands = [
    ["Command", "Description"],
    ["npx forgedock", "Install commands (default)"],
    ["npx forgedock install", "Install commands"],
    ["npx forgedock init", "Generate forge.yaml config for your project"],
    ["npx forgedock docs init", "Scaffold devdocs/ knowledge tree from seed templates"],
    ["npx forgedock uninstall", "Remove commands"],
    ["npx forgedock update", "Pull latest & reinstall"],
    ["npx forgedock help", "Show this help"],
  ];

  process.stderr.write(
    box(table(commands, { header: true }), { title: "Usage" }) + "\n",
  );
}

splash();

switch (command) {
  case "install":
    await install();
    break;
  case "init":
    await init();
    break;
  case "docs": {
    const subcommand = args[1];
    if (subcommand === "init") {
      await docsInit();
    } else {
      process.stderr.write(
        `${RED}Unknown docs subcommand: ${subcommand ?? "(none)"}${RESET}\n` +
        `Available: ${cyan("npx forgedock docs init")}\n`,
      );
      process.exit(1);
    }
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
    process.stderr.write(`${RED}Unknown command: ${command}${RESET}\n`);
    help();
    process.exit(1);
}
