#!/usr/bin/env node

import { fileURLToPath } from "url";
import { dirname, join, relative } from "path";
import { mkdir, lstat, readlink, unlink, readFile, writeFile } from "fs/promises";
import { existsSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import os from "os";
import {
  makeCtx,
  runJourney,
  read,
  review,
  celebrate,
  findMarkdownFiles,
  writeForgeYaml,
  backupExisting,
} from "./journey.mjs";
import { removeSessionStartHook } from "./settings-hook.mjs";
import { resolveState, setOptOut } from "./registry.mjs";
import { renderMark, ember } from "./cinema.mjs";
import { input } from "./tui.mjs";

const __filename = fileURLToPath(import.meta.url);
const FORGE_HOME = dirname(dirname(__filename));
const COMMANDS_DIR = join(FORGE_HOME, "commands");

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const TARGET_DIR = join(HOME, ".claude", "commands");
const MANIFEST_PATH = join(HOME, ".claude", "forgedock", "copied-commands.json");

const rawArgs = process.argv.slice(2);
const FLAGS = new Set(["--fast", "--manual", "--verbose"]);
const flags = rawArgs.filter((a) => FLAGS.has(a));
const positional = rawArgs.filter((a) => !FLAGS.has(a));
const command = positional[0] || "install";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

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
    c.stdout.write(`\n  Reconfigure: npx forgedock init · Full journey: npx forgedock install\n`);
  }
  c.stdout.write("\n");
}

async function initFlow(c) {
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
    const outputPath = join(c.cwd, "forge.yaml");
    const backup = backupExisting(outputPath);
    if (backup) c.stdout.write(`  Backed up: forge.yaml → ${backup.backupName}\n`);
    const { todoCount } = writeForgeYaml(v, [], outputPath);
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

  // Remove copy-installed commands (Windows without Developer Mode, or a
  // symlink→copy fallback from a previous run) tracked in the ownership
  // manifest. These are regular files, not symlinks, so the loop above
  // never touches them — the manifest is the only record of ForgeDock's
  // ownership over them.
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf-8"));
  } catch {
    manifest = null;
  }
  if (manifest && manifest.files && typeof manifest.files === "object") {
    const manifestRels = Object.keys(manifest.files);
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
    if (manifestRels.length > 0) {
      manifest.files = {};
      try {
        await mkdir(dirname(MANIFEST_PATH), { recursive: true });
        await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
      } catch {
        // Best-effort — a failed manifest write is non-fatal
      }
    }
  }

  console.log("");
  console.log(`Done. Removed: ${removed} commands.`);
  console.log("");

  const { status } = removeSessionStartHook(join(HOME, ".claude", "settings.json"));
  if (status === "removed") console.log("  Removed: SessionStart hook");
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
        await runJourney(ctx());
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
  console.log(`  ${CYAN}npx forgedock enable${RESET}     Activate ForgeDock in this directory`);
  console.log(`  ${CYAN}npx forgedock disable${RESET}    Opt out of ForgeDock in this directory`);
  console.log(`  ${CYAN}npx forgedock status${RESET}     Show ForgeDock state for this directory`);
  console.log(`  ${CYAN}npx forgedock uninstall${RESET}  Remove commands`);
  console.log(
    `  ${CYAN}npx forgedock update${RESET}     Pull latest & reinstall`,
  );
  console.log(`  ${CYAN}npx forgedock help${RESET}       Show this help`);
  console.log("");
  console.log("Flags:");
  console.log(`  ${CYAN}--fast${RESET}       Skip animation/motion`);
  console.log(`  ${CYAN}--manual${RESET}     Plain text prompts instead of the review screen (init)`);
  console.log(`  ${CYAN}--verbose${RESET}    Show detection sources for every field (init)`);
  console.log("");
}

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
    await setOptOut(c.cwd, false);
    if (!existsSync(join(c.cwd, "forge.yaml")) && !existsSync(join(c.cwd, ".forgedock"))) {
      writeFileSync(join(c.cwd, ".forgedock"), "", "utf-8");
    }
    c.stdout.write("\n  ForgeDock enabled in this directory.\n\n");
    break;
  }
  case "disable": {
    const c = ctx();
    await setOptOut(c.cwd, true);
    c.stdout.write("\n  ForgeDock disabled in this directory. Re-enable: npx forgedock enable\n\n");
    break;
  }
  case "status":
    statusScreen(ctx());
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
    exitCode = 1;
}
process.exit(exitCode);
