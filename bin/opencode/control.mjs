import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { runIssue } from "../engine.mjs";
import { appendEvent, readLog } from "../engine/runlog.mjs";
import { parseState } from "../engine/state.mjs";
import {
  codedError,
  parseWorkOnArguments,
  resolveRepository,
  slugify,
} from "./config.mjs";
import { createOpenCodePhaseRunner, phasePromptBytes } from "./runner.mjs";
import {
  branchForIssue,
  cleanupMergedWorktree,
  ensureWorktree,
  isSafeBranchName,
  worktreePath,
} from "./worktree.mjs";

const exec = promisify(execFile);

function repoRunDir(repo) {
  return join(homedir(), ".forge", "runs", repo.replace(/[^A-Za-z0-9._-]+/g, "_"));
}

async function command(bin, args, cwd, timeout = 30_000) {
  try {
    const { stdout } = await exec(bin, args, {
      cwd,
      windowsHide: true,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    });
    return String(stdout || "");
  } catch (error) {
    const detail = String(error.stderr || error.message || `${bin} failed`).trim();
    throw codedError("OPENCODE_COMMAND_FAILED", `${bin} ${args.slice(0, 3).join(" ")} failed: ${detail.slice(0, 1_000)}`);
  }
}

function makeIo(cwd, execute = command) {
  return {
    gh: (args) => execute("gh", args, cwd),
    git: (args) => execute("git", args, cwd),
  };
}

async function repositoryRoot(cwd, execute = command) {
  return resolve((await execute("git", ["rev-parse", "--show-toplevel"], cwd)).trim());
}

async function repositoryWorktreeRoot(cwd, execute = command) {
  const common = (await execute("git", ["rev-parse", "--git-common-dir"], cwd)).trim();
  const absolute = resolve(cwd, common);
  return basename(absolute) === ".git" ? dirname(absolute) : await repositoryRoot(cwd, execute);
}

async function assertRepository(cwd, expected, execute = command) {
  const actual = (await execute("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd)).trim();
  if (actual !== expected) {
    throw codedError(
      "OPENCODE_REPOSITORY_MISMATCH",
      `ForgeDock resolved ${expected}, but ${cwd} is connected to ${actual || "an unknown repository"}.`,
    );
  }
}

async function readIssue(cwd, repo, issue, execute = command) {
  const raw = await execute("gh", [
    "issue", "view", String(issue), "-R", repo,
    "--json", "number,title,body,state,labels,milestone,url",
  ], cwd);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw codedError("OPENCODE_GITHUB_INVALID", `GitHub returned invalid JSON for ${repo}#${issue}.`);
  }
  if (!value?.number) throw codedError("OPENCODE_ISSUE_NOT_FOUND", `Issue ${repo}#${issue} was not found.`);
  return value;
}

function laneForIssue(issue, options, config, stagingBranch) {
  if (options.lane) return options.lane;
  const milestone = issue.milestone?.title;
  if (!milestone) return stagingBranch;
  return config.featurePattern.replace("{slug}", slugify(milestone));
}

const TRUSTED_COMMENT_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export async function existingBuilderBranch(io, issue, {
  repo,
  base,
  defaultBranch,
  protectedBranches = [],
} = {}) {
  try {
    const repositoryApi = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || "") ? `repos/${repo}` : "";
    if (!repositoryApi) return "";
    let viewer = "";
    try {
      viewer = String(await io.gh(["api", "user", "--jq", ".login"])).trim().toLowerCase();
    } catch {
      // Trusted repository associations remain authoritative if viewer lookup is unavailable.
    }
    const raw = await io.gh(["issue", "view", String(issue), "--json", "comments"]);
    const payload = JSON.parse(raw || "{}");
    const comments = Array.isArray(payload.comments) ? payload.comments : [];
    const repositoryDefault = String(await io.gh(["api", repositoryApi, "--jq", ".default_branch"])).trim();
    if (!isSafeBranchName(repositoryDefault)) return "";
    const forbidden = new Set([base, defaultBranch, repositoryDefault, ...protectedBranches].filter(Boolean));
    for (let index = comments.length - 1; index >= 0; index--) {
      const comment = comments[index] || {};
      const body = comment.body;
      if (typeof body !== "string" || !body.includes("FORGE:BUILDER:COMPLETE")) continue;
      const association = String(comment.authorAssociation || "").toUpperCase();
      const login = String(comment.author?.login || comment.login || "").trim().toLowerCase();
      if (!TRUSTED_COMMENT_ASSOCIATIONS.has(association) && (!viewer || login !== viewer)) continue;
      const match = body.match(/\*\*Branch\*\*:\s*`([^`]+)`/);
      if (!match) continue;
      const branch = match[1];
      if (!isSafeBranchName(branch) || forbidden.has(branch)) return "";
      const branchRaw = await io.gh(["api", `${repositoryApi}/branches/${encodeURIComponent(branch)}`]);
      const branchInfo = JSON.parse(branchRaw || "{}");
      if (branchInfo.name !== branch || branchInfo.protected !== false) return "";
      return branch;
    }
  } catch {
    // A missing historical marker is normal before the build phase.
  }
  return "";
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw codedError("OPENCODE_CANCELLED", "OpenCode ForgeDock run was cancelled.");
}

function aggregateNativeUsage(events) {
  let measured = false;
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 0,
  };
  for (const event of events) {
    if (event.event !== "PHASE_COMMIT" && event.event !== "PHASE_FAILED") continue;
    const item = event.usage;
    if (!item || typeof item !== "object") continue;
    measured = true;
    for (const key of Object.keys(usage)) usage[key] += Number(item[key]) || 0;
  }
  return measured ? usage : null;
}

export async function runNativeWorkOn({
  client,
  cwd = process.cwd(),
  arguments: rawArguments = "",
  signal,
  onSession = () => {},
  onProgress = () => {},
  dir,
  execute = command,
} = {}) {
  const options = parseWorkOnArguments(rawArguments);
  throwIfCancelled(signal);
  const target = resolveRepository({ cwd, prefix: options.prefix, repo: options.repo });
  const root = await repositoryRoot(target.cwd, execute);
  throwIfCancelled(signal);
  const worktreeRoot = await repositoryWorktreeRoot(target.cwd, execute);
  throwIfCancelled(signal);
  await assertRepository(root, target.repo, execute);
  throwIfCancelled(signal);
  const issue = await readIssue(root, target.repo, options.issue, execute);
  throwIfCancelled(signal);
  const labels = (issue.labels || []).map((label) => label.name || label);
  if (String(issue.state).toUpperCase() === "CLOSED") {
    if (!labels.includes("workflow:merged") && !labels.includes("workflow:invalid")) {
      throw codedError("OPENCODE_ISSUE_CLOSED", `${target.repo}#${options.issue} is closed without a ForgeDock terminal label.`);
    }
  }
  const lane = laneForIssue(issue, options, target.config, target.stagingBranch);
  const runLogDir = dir || repoRunDir(target.repo);
  if (String(issue.state).toUpperCase() === "CLOSED") {
    const terminalReason = labels.includes("workflow:invalid") ? "invalid" : "merged";
    const events = readLog(runLogDir, options.issue);
    const remoteState = parseState(issue.body);
    return {
      schema: "forgedock-opencode-work-on-result-v1",
      status: terminalReason === "merged" ? "complete" : terminalReason,
      issue: options.issue,
      repo: target.repo,
      lane,
      branch: remoteState?.branch || null,
      worktree: null,
      terminalReason,
      detail: null,
      sessions: [],
      usage: aggregateNativeUsage(events),
      runLog: join(runLogDir, `${options.issue}.jsonl`),
      cleanup: { removed: false, reason: "already-terminal" },
    };
  }

  const io = makeIo(root, execute);
  const priorBranch = await existingBuilderBranch(io, options.issue, {
    repo: target.repo,
    base: lane,
    defaultBranch: target.config.defaultBranch,
    protectedBranches: [target.stagingBranch],
  });
  throwIfCancelled(signal);
  const runtimeContext = {
    issue: options.issue,
    repo: target.repo,
    cwd: root,
    lane,
    model: options.model,
    variant: options.variant,
    branch: priorBranch || branchForIssue(issue),
    worktree: null,
    underOrchestration: options.underOrchestration,
  };
  const prompts = phasePromptBytes();
  if (options.dryRun) {
    return {
      schema: "forgedock-opencode-work-on-result-v1",
      status: "dry-run",
      issue: options.issue,
      repo: target.repo,
      lane,
      branch: runtimeContext.branch,
      worktree: worktreePath(worktreeRoot, runtimeContext.branch),
      promptBytes: prompts,
      totalPromptBytes: Object.values(prompts).reduce((sum, value) => sum + value, 0),
      mutations: [],
    };
  }

  const sessions = [];
  let ensuredWorktree = null;
  const preparePhase = async ({ phase }) => {
    if (!["build", "review", "remediate"].includes(phase)) return root;
    if (!ensuredWorktree) {
      ensuredWorktree = await ensureWorktree({
        repoRoot: root,
        worktreeRoot,
        branch: runtimeContext.branch,
        base: lane,
        path: worktreePath(worktreeRoot, runtimeContext.branch),
        protectedBranches: [target.config.defaultBranch, target.stagingBranch, lane],
      });
      runtimeContext.worktree = ensuredWorktree.path;
      runtimeContext.branch = ensuredWorktree.branch;
    }
    return ensuredWorktree.path;
  };
  const runtimeEvent = async (event) => appendEvent(runLogDir, options.issue, event);
  const runner = createOpenCodePhaseRunner({
    client,
    context: runtimeContext,
    preparePhase,
    signal,
    onSession: async (session) => {
      sessions.push(session);
      await onSession(session);
    },
    onRuntimeEvent: runtimeEvent,
    onProgress,
  });
  const abort = () => void runner.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let result;
  try {
    if (signal?.aborted) await runner.abort();
    result = await runIssue({
      issue: options.issue,
      dir: runLogDir,
      agentId: `opencode_${process.pid}_${randomUUID()}`,
      lane,
      io,
      runner,
      ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
      onProgress: (event) => onProgress(event),
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    if (signal?.aborted) await runner.abort();
  }

  let cleanup = { removed: false, reason: "not-merged" };
  if (result.terminalReason === "merged" && ensuredWorktree && !options.keepWorktree) {
    cleanup = await cleanupMergedWorktree({
      repoRoot: root,
      worktreeRoot,
      path: ensuredWorktree.path,
      branch: ensuredWorktree.branch,
      base: lane,
    });
  }
  const events = readLog(runLogDir, options.issue);
  return {
    schema: "forgedock-opencode-work-on-result-v1",
    status: result.terminalReason === "merged" ? "complete" : result.terminalReason,
    issue: options.issue,
    repo: target.repo,
    lane,
    branch: runtimeContext.branch,
    worktree: runtimeContext.worktree,
    terminalReason: result.terminalReason,
    detail: result.detail || null,
    sessions: sessions.map(({ sessionID, phase, directory }) => ({ sessionID, phase, directory })),
    usage: aggregateNativeUsage(events),
    runLog: join(runLogDir, `${options.issue}.jsonl`),
    cleanup,
  };
}

export function formatNativeWorkOnResult(result) {
  if (result.status === "dry-run") {
    return [
      `OpenCode-native work-on dry run for ${result.repo}#${result.issue}`,
      `lane: ${result.lane}`,
      `branch: ${result.branch}`,
      `worktree: ${result.worktree}`,
      `phase prompt bytes: ${result.totalPromptBytes}`,
      "mutations: none",
    ].join("\n");
  }
  const lines = [
    `OpenCode-native work-on ${result.repo}#${result.issue}: ${result.terminalReason}`,
    `lane: ${result.lane}`,
    `branch: ${result.branch || "none"}`,
    `sessions: ${result.sessions.length}`,
    `run-log: ${result.runLog}`,
  ];
  if (result.usage) {
    lines.push(`usage: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out / $${result.usage.cost_usd.toFixed(4)}`);
  }
  if (result.detail) lines.push(`detail: ${result.detail}`);
  return lines.join("\n");
}
