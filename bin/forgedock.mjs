#!/usr/bin/env node

import { fileURLToPath } from "url";
import { dirname, join, relative } from "path";
import { mkdir, symlink, readlink, lstat, readdir, stat } from "fs/promises";
import { existsSync, appendFileSync, readFileSync } from "fs";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FORGE_HOME = dirname(__dirname);
const COMMANDS_DIR = join(FORGE_HOME, "commands");
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
    join(process.env.HOME, ".bashrc"),
    join(process.env.HOME, ".zshrc"),
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

function help() {
  console.log("");
  console.log(`${BOLD}ForgeDock${RESET} — GitHub as a knowledge graph for AI agents`);
  console.log("");
  console.log("Usage:");
  console.log(`  ${CYAN}npx forgedock${RESET}            Install commands (default)`);
  console.log(`  ${CYAN}npx forgedock install${RESET}    Install commands`);
  console.log(`  ${CYAN}npx forgedock uninstall${RESET}  Remove commands`);
  console.log(`  ${CYAN}npx forgedock update${RESET}     Pull latest & reinstall`);
  console.log(`  ${CYAN}npx forgedock help${RESET}       Show this help`);
  console.log("");
}

switch (command) {
  case "install":
    await install();
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
