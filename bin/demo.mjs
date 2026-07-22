// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * bin/demo.mjs — `forgedock demo` one-command demo mode (issue #1145).
 *
 * Stands up a runnable ForgeDock demo at a PREDICTABLE location with ZERO
 * required decisions, then prints the exact next steps. It removes the
 * clone → cd → init → open friction that loses first-time users.
 *
 * Source precedence (robust + offline-friendly):
 *   1. `git clone` the live demo repo (RapierCraftStudios/forgedock-demo).
 *   2. On failure (repo absent / no network), fall back to copying the bundled
 *      scaffold shipped inside the installed package at
 *      `FORGE_HOME/examples/forgedock-demo`, then `git init` + initial commit.
 *
 * Re-runs are idempotent: an existing git clone is fast-forwarded
 * (`git pull --ff-only`); a scaffold copy is reused, never clobbered.
 *
 * Design notes:
 *   - All side effects (process spawning, filesystem, PATH lookup) are injected
 *     via `opts` so the unit tests in bin/tests/demo.test.mjs run with no
 *     network and no git/claude on the host.
 *   - Pure helpers (parseDemoArgs, resolveTargetDir, renderNextSteps,
 *     demoUsage, demoForgeYaml) are exported for direct testing.
 *
 * Exports:
 *   DEFAULT_DEMO_REPO, DEFAULT_DEMO_DIRNAME
 *   parseDemoArgs(args)            → {positional, dir, open, repo, help, error}
 *   resolveTargetDir(opts)         → string  (absolute target path)
 *   isGitRepo(dir, fsx)            → boolean
 *   demoUsage()                    → string
 *   demoForgeYaml(repoSlug)        → string
 *   renderNextSteps(ctx)           → string
 *   runDemo(opts)                  → Promise<{status, ...}>
 */

import {
  existsSync,
  mkdirSync,
  cpSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { join, dirname, resolve, isAbsolute, basename } from "path";
import { homedir } from "os";
import { spawnSync, spawn } from "child_process";

export const DEFAULT_DEMO_REPO = "RapierCraftStudios/forgedock-demo";
export const DEFAULT_DEMO_DIRNAME = "forgedock-demo";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse `forgedock demo` arguments.
 *
 * Flags:
 *   --dir <path> | --dir=<path>   Target directory (default: ~/forgedock-demo).
 *   --repo <slug> | --repo=<slug> Override the demo repo (owner/name).
 *   --open                        Launch Claude Code in the demo dir when found.
 *   --no-open                     Explicitly disable launching (the default).
 *   --run                         Run the seeded issue through /work-on automatically
 *                                 (requires ANTHROPIC_API_KEY; falls back to print-only
 *                                 instructions when the key is absent).
 *   --help | -h                   Show usage.
 *
 * The first non-flag argument is treated as the target directory (positional
 * convenience equivalent to --dir).
 *
 * @param {string[]} args
 * @returns {{positional: string|undefined, dir: string|undefined,
 *            repo: string|undefined, open: boolean, run: boolean,
 *            help: boolean, error: string|null}}
 */
export function parseDemoArgs(args = []) {
  const out = {
    positional: undefined,
    dir: undefined,
    repo: undefined,
    open: false,
    run: false,
    help: false,
    error: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--open") {
      out.open = true;
    } else if (a === "--no-open") {
      out.open = false;
    } else if (a === "--run") {
      out.run = true;
    } else if (a === "--dir") {
      out.dir = args[++i];
      if (out.dir === undefined) out.error = "--dir requires a path argument";
    } else if (a.startsWith("--dir=")) {
      out.dir = a.slice("--dir=".length);
    } else if (a === "--repo") {
      out.repo = args[++i];
      if (out.repo === undefined) out.error = "--repo requires an owner/name argument";
    } else if (a.startsWith("--repo=")) {
      out.repo = a.slice("--repo=".length);
    } else if (a.startsWith("--")) {
      out.error = `Unknown flag: ${a}`;
    } else if (out.positional === undefined) {
      out.positional = a;
    }
  }
  return out;
}

/**
 * Resolve the predictable target directory. Priority: --dir, then positional,
 * then ~/forgedock-demo. Always returned as an absolute path.
 *
 * @param {{dir?: string, positional?: string, home?: string, cwd?: string}} opts
 * @returns {string}
 */
export function resolveTargetDir({ dir, positional, home = homedir(), cwd = process.cwd() } = {}) {
  const chosen = dir || positional;
  if (chosen && chosen.trim() !== "") {
    return isAbsolute(chosen) ? chosen : resolve(cwd, chosen);
  }
  return join(home, DEFAULT_DEMO_DIRNAME);
}

/**
 * @param {string} dir
 * @param {{existsSync: Function}} fsx
 * @returns {boolean} true if dir contains a `.git` entry (worktree or repo).
 */
export function isGitRepo(dir, fsx) {
  return fsx.existsSync(join(dir, ".git"));
}

function isEmptyDir(dir, fsx) {
  try {
    return fsx.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function demoUsage() {
  return [
    "Usage: forgedock demo [dir] [--dir <path>] [--repo <owner/name>] [--open] [--run]",
    "",
    "Stand up a runnable ForgeDock demo at a predictable location (default",
    "~/forgedock-demo) and print the exact next steps. No configuration needed.",
    "",
    "  [dir]            Target directory (same as --dir).",
    "  --dir <path>     Where to create the demo (default: ~/forgedock-demo).",
    "  --repo <slug>    Demo repo to clone (default: RapierCraftStudios/forgedock-demo).",
    "  --open           Launch Claude Code in the demo directory if available.",
    "  --no-open        Do not launch Claude Code (default).",
    "  --run            Automatically run the seeded issue through /work-on to a",
    "                   merged PR (requires ANTHROPIC_API_KEY; falls back to",
    "                   print-only instructions when the key is absent).",
    "  -h, --help       Show this help.",
  ].join("\n");
}

/**
 * Minimal, valid forge.yaml for the demo repo so /work-on is usable immediately.
 * @param {string} repoSlug - "owner/name"
 * @returns {string}
 */
export function demoForgeYaml(repoSlug) {
  const [owner = "your-org", repo = DEFAULT_DEMO_DIRNAME] = String(repoSlug).split("/");
  return [
    "# forge.yaml — minimal ForgeDock config for the demo repo.",
    "# Auto-generated by: npx forgedock demo",
    "project:",
    '  name: "ForgeDock Demo"',
    `  owner: "${owner}"`,
    `  repo: "${repo}"`,
    '  description: "A tiny Notes API for trying ForgeDock risk-free."',
    "paths:",
    '  root: "."',
    '  worktree_base: ".forgedock/worktrees"',
    "branches:",
    '  default: "main"',
    '  staging: "main"',
    "",
  ].join("\n");
}

/**
 * Render the success / next-steps card.
 * @param {{target: string, source: string, claudeAvailable: boolean, apiKeyAvailable?: boolean}} ctx
 * @returns {string}
 */
export function renderNextSteps({ target, source, claudeAvailable, apiKeyAvailable = false }) {
  const sourceNote = {
    cloned: "Cloned the live demo repo.",
    pulled: "Demo already present — pulled the latest.",
    scaffold: "Live repo unavailable — built the demo from the bundled scaffold.",
    exists: "Reused the existing demo directory.",
  }[source] || "";

  const lines = [
    "",
    `✔ Demo repo ready at ${target}`,
    ...(sourceNote ? [`  (${sourceNote})`] : []),
    "",
    "Next: open Claude Code in that directory and run:",
    "",
    "    /work-on 1",
    "",
    "This picks up a pre-written bug issue and runs the full",
    "investigate → architect → build → review → merge pipeline.",
    "",
    `  cd ${target}`,
    claudeAvailable
      ? "  claude            # open Claude Code here (or re-run with --open)"
      : "  # then open Claude Code in this directory",
  ];

  if (!apiKeyAvailable) {
    lines.push(
      "",
      "Tip: set ANTHROPIC_API_KEY and re-run with --run to execute the pipeline",
      "automatically and watch a PR merge without opening Claude Code.",
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Default injectable side-effect implementations
// ---------------------------------------------------------------------------

const defaultFsx = { existsSync, mkdirSync, cpSync, readdirSync, writeFileSync };

/**
 * Run a command without throwing. Returns a normalized result.
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function defaultExec(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", ...opts });
  return {
    status: r.error ? 127 : (typeof r.status === "number" ? r.status : 1),
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

/** @returns {boolean} whether `bin` resolves on PATH. */
function defaultCommandExists(bin) {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [bin], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

/** Launch an interactive process in `cwd`, inheriting stdio. */
function defaultLaunch(bin, launchArgs, opts = {}) {
  spawn(bin, launchArgs, { stdio: "inherit", ...opts });
}

const defaultLogger = {
  log: (m) => process.stdout.write(`${m}\n`),
  error: (m) => process.stderr.write(`${m}\n`),
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Stand up the demo.
 *
 * @param {object} opts
 * @param {string}  opts.forgeHome            - Package root (for bundled scaffold and commands/).
 * @param {string[]} [opts.args]              - CLI args after `demo`.
 * @param {string}  [opts.home]               - Home dir (default os.homedir()).
 * @param {string}  [opts.cwd]                - Working dir (default process.cwd()).
 * @param {string}  [opts.demoRepo]           - Override demo repo slug.
 * @param {string}  [opts.apiKey]             - Anthropic API key (default ANTHROPIC_API_KEY env).
 * @param {Function} [opts.exec]              - (cmd, args, {cwd}) => {status,...}.
 * @param {object}  [opts.fsx]                - Filesystem facade.
 * @param {Function} [opts.commandExists]     - (bin) => boolean.
 * @param {Function} [opts.launch]            - (bin, args, {cwd}) => void.
 * @param {{log:Function,error:Function}} [opts.logger]
 * @returns {Promise<{status: string, target?: string, source?: string, error?: string}>}
 */
export async function runDemo(opts = {}) {
  const {
    forgeHome,
    args = [],
    home = homedir(),
    cwd = process.cwd(),
    apiKey = process.env.ANTHROPIC_API_KEY,
    exec = defaultExec,
    fsx = defaultFsx,
    commandExists = defaultCommandExists,
    launch = defaultLaunch,
    logger = defaultLogger,
  } = opts;

  const parsed = parseDemoArgs(args);
  if (parsed.help) {
    logger.log(demoUsage());
    return { status: "help" };
  }
  if (parsed.error) {
    logger.error(parsed.error);
    logger.error(demoUsage());
    return { status: "error", error: parsed.error };
  }

  const demoRepo =
    parsed.repo || opts.demoRepo || process.env.FORGEDOCK_DEMO_REPO || DEFAULT_DEMO_REPO;
  const target = resolveTargetDir({ dir: parsed.dir, positional: parsed.positional, home, cwd });
  const scaffold = forgeHome
    ? join(forgeHome, "examples", "forgedock-demo")
    : null;

  let source;

  if (fsx.existsSync(target) && !isEmptyDir(target, fsx)) {
    // Idempotent re-run — never clobber an existing demo.
    if (isGitRepo(target, fsx)) {
      const pull = exec("git", ["pull", "--ff-only"], { cwd: target });
      source = pull.status === 0 ? "pulled" : "exists";
      if (pull.status !== 0) {
        logger.log("Could not fast-forward the existing demo — leaving it untouched.");
      }
    } else {
      source = "exists";
    }
  } else {
    // Fresh setup: prefer the live repo, fall back to the bundled scaffold.
    fsx.mkdirSync(dirname(target), { recursive: true });
    const clone = exec(
      "git",
      ["clone", "--depth", "1", `https://github.com/${demoRepo}.git`, target],
      { cwd },
    );
    if (clone.status === 0) {
      source = "cloned";
    } else {
      if (!scaffold || !fsx.existsSync(scaffold)) {
        const msg =
          `Could not clone ${demoRepo} and no bundled scaffold was found` +
          (scaffold ? ` at ${scaffold}` : "") +
          ". Check your network or reinstall ForgeDock.";
        logger.error(msg);
        return { status: "error", error: msg };
      }
      // Copy everything except bootstrap.sh (that script is for standing up a
      // *live* GitHub repo and is not needed for a local demo).
      fsx.mkdirSync(target, { recursive: true });
      fsx.cpSync(scaffold, target, {
        recursive: true,
        filter: (src) => basename(src) !== "bootstrap.sh",
      });
      // Best-effort local git history so the demo feels like a real repo.
      exec("git", ["init", "-q"], { cwd: target });
      exec("git", ["add", "."], { cwd: target });
      exec(
        "git",
        [
          "-c",
          "user.name=forgedock-demo",
          "-c",
          "user.email=demo@forgedock.dev",
          "commit",
          "-q",
          "-m",
          "chore: initial demo scaffold",
        ],
        { cwd: target },
      );
      source = "scaffold";
    }
  }

  // Ensure a usable forge.yaml exists (the bundled scaffold ships without one).
  const forgeYamlPath = join(target, "forge.yaml");
  if (!fsx.existsSync(forgeYamlPath)) {
    fsx.writeFileSync(forgeYamlPath, demoForgeYaml(demoRepo));
  }

  const claudeAvailable = commandExists("claude");
  const apiKeyAvailable = Boolean(apiKey);

  // --run: drive the seeded issue through /work-on automatically.
  // Requires ANTHROPIC_API_KEY; falls back to print-only instructions gracefully.
  if (parsed.run) {
    if (!apiKeyAvailable) {
      logger.log(
        "\nANTHROPIC_API_KEY is not set — cannot run the pipeline automatically.\n" +
        "Export your key and re-run with --run, or open Claude Code manually:\n",
      );
      logger.log(renderNextSteps({ target, source, claudeAvailable, apiKeyAvailable: false }));
      return { status: "ok", target, source };
    }

    const commandsDir = forgeHome ? join(forgeHome, "commands") : null;
    if (!commandsDir || !fsx.existsSync(commandsDir)) {
      logger.error(
        "Could not locate the ForgeDock commands/ directory. " +
        "Falling back to manual instructions.",
      );
      logger.log(renderNextSteps({ target, source, claudeAvailable, apiKeyAvailable }));
      return { status: "ok", target, source };
    }

    logger.log(
      "\nRunning /work-on 1 in the demo repo — watch the full pipeline execute…\n",
    );

    let runCommand;
    try {
      ({ runCommand } = await import("./runner.mjs"));
    } catch {
      logger.error(
        "Could not load bin/runner.mjs. Falling back to manual instructions.",
      );
      logger.log(renderNextSteps({ target, source, claudeAvailable, apiKeyAvailable }));
      return { status: "ok", target, source };
    }

    try {
      const result = await runCommand({
        commandsDir,
        commandName: "work-on",
        args: ["1"],
        cwd: target,
        apiKey,
        logger: { log: logger.log, error: logger.error },
      });
      logger.log(`\nDemo pipeline finished with status: ${result.status}`);
      return { status: result.status === "ok" ? "ok" : result.status, target, source };
    } catch (err) {
      if (err.code === "NO_SDK") {
        logger.error(
          "\n@anthropic-ai/sdk is not installed. Install it with:\n" +
          "  npm install @anthropic-ai/sdk\n" +
          "Then re-run with --run, or open Claude Code manually:\n",
        );
      } else {
        logger.error(`\nPipeline error: ${err.message}\nFalling back to manual instructions.\n`);
      }
      logger.log(renderNextSteps({ target, source, claudeAvailable, apiKeyAvailable }));
      return { status: "ok", target, source };
    }
  }

  logger.log(renderNextSteps({ target, source, claudeAvailable, apiKeyAvailable }));

  if (parsed.open) {
    if (claudeAvailable) {
      logger.log("Launching Claude Code…");
      launch("claude", [], { cwd: target });
    } else {
      logger.log("`claude` was not found on PATH — open Claude Code manually in the demo directory.");
    }
  }

  return { status: "ok", target, source };
}
