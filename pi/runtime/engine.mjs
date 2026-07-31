// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pi-backed ForgeDock runtime.
 *
 * The durable engine owns phase selection, leases, retries, and GitHub state.
 * This module only supplies the execution runtime: each phase is run by an
 * isolated Pi process in the appropriate repository/worktree.
 */

import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runIssue } from "../../bin/engine.mjs";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 100 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PRE_BUILD_PHASES = new Set([
  "work-on/investigate",
  "work-on/build/context",
  "work-on/build/architect",
  "work-on/build",
]);

function piExecutable() {
  return process.platform === "win32" ? "pi.cmd" : "pi";
}

function phaseLabel(commandName) {
  return commandName.replace(/^work-on\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "phase";
}

/**
 * Convert a Pi model object or an explicit provider/model string into the
 * pattern accepted by Pi's --model flag.
 */
export function modelPattern(model) {
  if (!model) return undefined;
  if (typeof model === "string") return model.trim() || undefined;
  if (model.provider && model.id) return `${model.provider}/${model.id}`;
  if (model.id) return String(model.id);
  return undefined;
}

/** Build the model/thinking portion of a Pi worker argv. */
export function buildPiModelArgs({ model, thinkingLevel } = {}) {
  const args = [];
  const pattern = modelPattern(model);
  if (pattern) args.push("--model", pattern);
  if (thinkingLevel && THINKING_LEVELS.has(thinkingLevel)) args.push("--thinking", thinkingLevel);
  return args;
}

/**
 * Build an isolated Pi worker command. Explicitly disabling extension
 * discovery prevents a globally-installed copy of ForgeDock from being loaded
 * a second time; the exact extension path is then loaded explicitly.
 */
export function buildPiPhaseArgs({ extensionPath, model, thinkingLevel, name, prompt } = {}) {
  if (!extensionPath) throw new Error("Pi runtime requires the ForgeDock extension path");
  if (!prompt) throw new Error("Pi runtime requires a phase prompt");
  return [
    "--no-session",
    "--approve",
    "--no-extensions",
    "-e",
    extensionPath,
    ...buildPiModelArgs({ model, thinkingLevel }),
    "--name",
    name || "forge-pi-phase",
    "-p",
    prompt,
  ];
}

/**
 * Parse `git worktree list --porcelain` output without relying on platform
 * path separators. The branch ref is the durable identity; paths may contain
 * spaces on Windows.
 */
export function parseWorktrees(output) {
  const records = [];
  let current;
  const flush = () => {
    if (current?.path) records.push(current);
    current = undefined;
  };
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length);
    } else if (line === "detached" && current) {
      current.detached = true;
    }
  }
  flush();
  return records;
}

export function worktreeForBranch(output, branch) {
  const ref = `refs/heads/${branch}`;
  return parseWorktrees(output).find((record) => record.branch === ref)?.path;
}

/** Build the bounded, explicit prompt sent to one Pi phase worker. */
export function buildPiPhasePrompt({ forgeHome, projectRoot, phaseCwd, issue, commandName, args = [] } = {}) {
  const specPath = join(forgeHome, "commands", `${commandName}.md`);
  const piDocs = join(forgeHome, "docs", "PI.md");
  const projectInstructions = join(projectRoot, "AGENTS.md");
  const paths = [specPath, piDocs, existsSync(projectInstructions) ? projectInstructions : null]
    .filter(Boolean)
    .map((path) => `- ${path}`)
    .join("\n");
  return [
    `You are the ForgeDock Pi runtime worker for issue #${issue}.`,
    `Execute exactly one workflow phase: ${commandName}.`,
    `The durable ForgeDock engine selected this phase and will verify its GitHub marker/label after you exit.`,
    "",
    "Read these files before acting:",
    paths,
    "",
    `Project root: ${projectRoot}`,
    `Current working directory: ${phaseCwd}`,
    `Phase arguments: ${args.join(" ") || String(issue)}`,
    "",
    "Runtime rules:",
    "- Work only on this issue and only in the current phase.",
    "- Use Pi-native tools and translate Claude Skill/Task/Agent references according to docs/PI.md.",
    "- Do not run or summarize a later phase; the engine will invoke it separately.",
    "- Preserve GitHub labels, FORGE annotations, branches, PR rules, and fail-closed behavior.",
    "- Do not claim completion unless the phase's required durable GitHub output was actually written.",
    "- If state is ambiguous or a required operation is unavailable, stop safely and report the blocker.",
  ].join("\n");
}

function makeIo(cwd) {
  const run = async (command, args) => {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return result.stdout;
  };
  return { gh: (args) => run("gh", args), git: (args) => run("git", args) };
}

async function builderBranch({ projectRoot, repo, issue }) {
  const result = await execFileAsync("gh", ["api", `repos/${repo}/issues/${issue}/comments`], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  let comments;
  try {
    comments = JSON.parse(result.stdout || "[]");
  } catch {
    throw new Error(`Unable to parse issue #${issue} comments while resolving the Pi worktree`);
  }
  for (const comment of [...comments].reverse()) {
    const body = String(comment?.body || "");
    if (!body.includes("FORGE:BUILDER") || !body.includes("FORGE:BUILDER:COMPLETE")) continue;
    const match = body.match(/\*\*Branch\*\*:\s*`([^`]+)`/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

async function resolvePhaseCwd({ projectRoot, repo, issue, commandName, worktree }) {
  if (PRE_BUILD_PHASES.has(commandName)) return { cwd: projectRoot, worktree };
  if (worktree) return { cwd: worktree, worktree };

  const branch = await builderBranch({ projectRoot, repo, issue });
  if (!branch) {
    throw Object.assign(
      new Error(`Pi phase ${commandName} cannot resolve the builder branch for issue #${issue}`),
      { code: "PI_WORKTREE_NOT_FOUND" },
    );
  }
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw Object.assign(
      new Error(String(result.stderr || `git worktree list failed for issue #${issue}`).trim()),
      { code: "PI_WORKTREE_NOT_FOUND" },
    );
  }
  const resolved = worktreeForBranch(result.stdout, branch);
  if (!resolved) {
    throw Object.assign(
      new Error(`Pi phase ${commandName} cannot find worktree for branch ${branch}`),
      { code: "PI_WORKTREE_NOT_FOUND" },
    );
  }
  return { cwd: resolve(resolved), worktree: resolve(resolved) };
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
  } else if (!child.killed) {
    child.kill("SIGTERM");
  }
}

async function runPiPhase({ extensionPath, forgeHome, projectRoot, repo, issue, commandName, args, model, thinkingLevel, worktree, signal, onOutput }) {
  const phaseCwd = await resolvePhaseCwd({ projectRoot, repo, issue, commandName, worktree });
  const prompt = buildPiPhasePrompt({ forgeHome, projectRoot, phaseCwd: phaseCwd.cwd, issue, commandName, args });
  const child = spawn(piExecutable(), buildPiPhaseArgs({
    extensionPath,
    model,
    thinkingLevel,
    name: `forge-pi-${issue}-${phaseLabel(commandName)}`,
    prompt,
  }), {
    cwd: phaseCwd.cwd,
    env: {
      ...process.env,
      FORGE_HOME: forgeHome,
      FORGE_RUNTIME: "pi",
      FORGE_PI_WORKER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let output = "";
  const collect = (chunk) => {
    const text = String(chunk);
    output += text;
    onOutput?.(text);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  let aborted = false;
  const abort = () => {
    aborted = true;
    killProcessTree(child);
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  try {
    const code = await new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", resolvePromise);
    });
    if (aborted) {
      throw Object.assign(new Error(`Pi phase ${commandName} was aborted`), { code: "PI_RUNNER_ABORTED" });
    }
    if (code !== 0) {
      throw Object.assign(
        new Error(`Pi phase ${commandName} exited with code ${code}\n${output.slice(-12000)}`),
        { code: "PI_BACKEND_FAILED" },
      );
    }
    return { code, output, worktree: phaseCwd.worktree };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * Run one issue through the existing durable Forge engine using Pi workers.
 * The engine remains the state owner; Pi only executes the selected phase.
 */
export async function runPiIssue({
  issue,
  projectRoot,
  forgeHome,
  extensionPath,
  repo,
  lane = "staging",
  model,
  thinkingLevel,
  signal,
  onProgress,
  onOutput,
  agentId = `pi_${process.pid}_${issue}_${Math.random().toString(36).slice(2, 8)}`,
} = {}) {
  if (!Number.isInteger(Number(issue))) throw new Error("Pi engine requires a numeric issue number");
  if (!projectRoot || !forgeHome || !extensionPath || !repo) {
    throw new Error("Pi engine requires projectRoot, forgeHome, extensionPath, and repo");
  }

  let worktree;
  const runner = async ({ commandsDir, commandName, args }) => {
    const result = await runPiPhase({
      extensionPath,
      forgeHome,
      projectRoot,
      repo,
      issue: Number(issue),
      commandName,
      args,
      model,
      thinkingLevel,
      worktree,
      signal,
      onOutput,
    });
    worktree = result.worktree || worktree;
    return { status: "completed", output: result.output, model: modelPattern(model), thinkingLevel };
  };

  return runIssue({
    issue: Number(issue),
    dir: join(homedir(), ".forge", "runs"),
    agentId,
    lane,
    io: makeIo(projectRoot),
    runner,
    commandsDir: join(forgeHome, "commands"),
  });
}
