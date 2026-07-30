import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { runPreflight } from "../orchestrate-preflight.mjs";
import { batchPlanDigest, createBatchStore, newBatchId } from "./batch-store.mjs";
import { codedError, parseOrchestrateArguments, readForgeConfig } from "./config.mjs";
import { runNativeWorkOn } from "./control.mjs";
import { phasePromptBytes } from "./runner.mjs";

const exec = promisify(execFile);
const DURABLE_STATES = new Set(["done", "invalid", "engine-failed", "decomposed", "failed", "skipped"]);
const RETRYABLE_STATES = new Set(["gated", "deferred", "cancelled", "blocked", "running", "external-blocked"]);
const TERMINAL_STATES = new Set([...DURABLE_STATES, ...RETRYABLE_STATES].filter((state) => state !== "running" && state !== "external-blocked"));

async function command(bin, args, cwd) {
  try {
    const { stdout } = await exec(bin, args, {
      cwd,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return String(stdout || "");
  } catch (error) {
    const detail = String(error.stderr || error.message || `${bin} failed`).trim();
    throw codedError("OPENCODE_COMMAND_FAILED", `${bin} ${args.slice(0, 3).join(" ")} failed: ${detail.slice(0, 1_000)}`);
  }
}

async function repositoryRoot(cwd) {
  return resolve((await command("git", ["rev-parse", "--show-toplevel"], cwd)).trim());
}

async function assertRepository(cwd, expected) {
  const actual = (await command("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd)).trim();
  if (actual !== expected) {
    throw codedError("OPENCODE_REPOSITORY_MISMATCH", `ForgeDock resolved ${expected}, but ${cwd} is connected to ${actual}.`);
  }
}

function priorStates(events) {
  const states = new Map();
  for (const event of events) {
    if (event.event === "ISSUE_STARTED") states.set(event.issue, "running");
    if (event.event === "ISSUE_TERMINAL") states.set(event.issue, event.state);
    if (event.event === "ISSUE_RESET") states.delete(event.issue);
  }
  return states;
}

function classifyWorker(result) {
  switch (result?.terminalReason) {
    case "merged": return "done";
    case "needs-human":
    case "awaiting-merge": return "gated";
    case "cancelled": return "cancelled";
    case "deferred": return "deferred";
    case "invalid": return "invalid";
    case "decomposed": return "decomposed";
    default: return "engine-failed";
  }
}

export function classifyExternalDependency(issue) {
  const labels = new Set((issue?.labels || []).map((label) => label.name || label));
  if (labels.has("workflow:invalid") || labels.has("workflow:engine-error") || labels.has("workflow:decomposed")) return "failed";
  if (labels.has("workflow:merged")) return "done";
  if (labels.has("needs-human") || labels.has("workflow:awaiting-merge") || labels.has("blocked-on-human-merge")) {
    return "blocked";
  }
  return String(issue?.state || "").toUpperCase() === "CLOSED" ? "done" : "blocked";
}

async function externalDependencyState({ cwd, repo, number }) {
  try {
    const raw = await command("gh", ["issue", "view", String(number), "-R", repo, "--json", "state,labels"], cwd);
    return classifyExternalDependency(JSON.parse(raw));
  } catch {
    return "unknown";
  }
}

function resetRetryableIssues(plan, store) {
  const states = priorStates(store.readEvents());
  for (const record of plan.issues) {
    const state = states.get(record.number);
    if (!RETRYABLE_STATES.has(state)) continue;
    store.append({
      event: "ISSUE_RESET",
      issue: record.number,
      from: state,
      reason: "explicit confirmed resume",
    });
  }
}

export async function runBatchScheduler({
  plan,
  store,
  worker,
  cwd,
  repo,
  maxConcurrent,
  signal,
  resume = false,
  resolveExternalDependency = externalDependencyState,
  onProgress = () => {},
}) {
  const records = new Map(plan.issues.map((issue) => [issue.number, issue]));
  if (resume) resetRetryableIssues(plan, store);
  const states = priorStates(store.readEvents());
  const running = new Map();
  const external = new Map();
  for (const record of plan.issues) {
    for (const dependency of record.externalDependencies || []) {
      if (!external.has(dependency)) {
        external.set(dependency, await resolveExternalDependency({ cwd, repo, number: dependency }));
      }
    }
  }

  const ordered = plan.issues.map((issue) => issue.number);
  const persistTerminal = (issue, state, detail = null, result = null) => {
    if (states.get(issue) === state && TERMINAL_STATES.has(state)) return;
    states.set(issue, state);
    store.append({ event: "ISSUE_TERMINAL", issue, state, detail, result });
    onProgress({ event: "issue_terminal", issue, state, detail });
  };

  const evaluatePending = () => {
    for (const number of ordered) {
      if (states.has(number) || running.has(number)) continue;
      const record = records.get(number);
      const predecessorStates = record.predecessors.map((dependency) => states.get(dependency));
      if (predecessorStates.some((state) => TERMINAL_STATES.has(state) && state !== "done")) {
        persistTerminal(number, "blocked", "predecessor did not complete successfully");
        continue;
      }
      if ((record.externalDependencies || []).some((dependency) => external.get(dependency) !== "done")) {
        states.set(number, "external-blocked");
        continue;
      }
      if (predecessorStates.every((state) => state === "done")) states.set(number, "ready");
    }
  };

  const launch = (number) => {
    states.set(number, "running");
    store.append({ event: "ISSUE_STARTED", issue: number });
    onProgress({ event: "issue_started", issue: number });
    const settled = Promise.resolve()
      .then(() => worker(number))
      .then((result) => ({ number, result }))
      .catch((error) => ({ number, error }));
    running.set(number, settled);
  };

  let cancellationRecorded = false;
  for (;;) {
    if (signal?.aborted) {
      if (!cancellationRecorded) {
        store.append({ event: "BATCH_CANCEL_REQUESTED" });
        cancellationRecorded = true;
      }
      for (const number of ordered) {
        if (!TERMINAL_STATES.has(states.get(number)) && !running.has(number)) persistTerminal(number, "cancelled", "batch cancelled");
      }
    }
    evaluatePending();
    if (!signal?.aborted) {
      for (const number of ordered) {
        if (running.size >= maxConcurrent) break;
        if (states.get(number) === "ready") launch(number);
      }
    }
    if (running.size === 0) {
      const unresolved = ordered.filter((number) => !TERMINAL_STATES.has(states.get(number)));
      if (!unresolved.length) break;
      for (const number of unresolved) {
        const state = states.get(number);
        persistTerminal(
          number,
          "blocked",
          state === "external-blocked" ? "external dependency is open or could not be verified" : "dependency cycle or unresolved predecessor",
        );
      }
      break;
    }
    const settled = await Promise.race(running.values());
    running.delete(settled.number);
    if (settled.error) {
      persistTerminal(settled.number, signal?.aborted ? "cancelled" : "engine-failed", String(settled.error.message || settled.error).slice(0, 1_000));
      continue;
    }
    const state = classifyWorker(settled.result);
    persistTerminal(settled.number, state, settled.result?.detail || null, {
      terminalReason: settled.result?.terminalReason,
      branch: settled.result?.branch,
      runLog: settled.result?.runLog,
      usage: settled.result?.usage,
    });
  }

  const summary = Object.fromEntries(ordered.map((number) => [number, states.get(number)]));
  const counts = {};
  for (const state of Object.values(summary)) counts[state] = (counts[state] || 0) + 1;
  return { states: summary, counts };
}

function assertDispatchablePlan(plan) {
  const hasInvestigation = (plan.investigations || []).length > 0 ||
    (plan.issues || []).some((issue) => issue.classification === "INVESTIGATION");
  if (plan.requiresDeepPlan || hasInvestigation) {
    throw codedError(
      "OPENCODE_DEEP_PLAN_REQUIRED",
      "This query requires a Wave-0/deep-plan replan, which the deterministic native scheduler cannot yet persist. No issues were dispatched.",
    );
  }
}

function assertBatchIdentity(planEnvelope, { batchId, repo, root }) {
  if (planEnvelope.batchId !== batchId || planEnvelope.repo !== repo || planEnvelope.cwd !== root) {
    throw codedError("OPENCODE_BATCH_MISMATCH", `Batch ${batchId} belongs to ${planEnvelope.repo} at ${planEnvelope.cwd}.`);
  }
}

function verifyPlanDigest(store, planEnvelope) {
  const events = store.readEvents();
  const planned = events.find((event) => event.event === "BATCH_PLANNED");
  if (!planned?.planDigest) {
    throw codedError("OPENCODE_BATCH_PLAN_MISMATCH", `Batch ${planEnvelope.batchId} has no durable planned-plan digest; compile a new batch.`);
  }
  const actual = batchPlanDigest(planEnvelope);
  if (actual !== planned.planDigest) {
    throw codedError("OPENCODE_BATCH_PLAN_MISMATCH", `Batch ${planEnvelope.batchId} plan changed after BATCH_PLANNED; compile and review a new batch.`);
  }
  const mismatchedAuthorization = events.find((event) =>
    (event.event === "BATCH_AUTHORIZED" || event.event === "BATCH_RESUMED") && event.planDigest !== actual);
  if (mismatchedAuthorization) {
    throw codedError("OPENCODE_BATCH_PLAN_MISMATCH", `Batch ${planEnvelope.batchId} authorization does not match its persisted plan.`);
  }
  return actual;
}

export async function runNativeOrchestrate({
  client,
  cwd = process.cwd(),
  arguments: rawArguments = "",
  signal,
  onSession = () => {},
  onProgress = () => {},
  batchRoot,
  runWorkOn = runNativeWorkOn,
  compilePlan = runPreflight,
  loadConfig = readForgeConfig,
  resolveRoot = repositoryRoot,
  verifyRepository = assertRepository,
} = {}) {
  const options = parseOrchestrateArguments(rawArguments);
  const config = loadConfig(cwd);
  const root = await resolveRoot(cwd);
  const repo = options.repo || config.repo;
  await verifyRepository(root, repo);

  let planEnvelope;
  let store;
  let resumed = false;
  let planDigest;
  if (options.resume) {
    store = createBatchStore({ repo, batchId: options.resume, root: batchRoot });
    planEnvelope = store.readPlan();
    assertBatchIdentity(planEnvelope, { batchId: options.resume, repo, root });
    planDigest = verifyPlanDigest(store, planEnvelope);
    assertDispatchablePlan(planEnvelope.plan);
    resumed = true;
  } else {
    if (!options.query) throw codedError("OPENCODE_INVALID_ARGUMENTS", "Orchestration requires an issue query or --resume <batch-id>.");
    const plan = compilePlan({ cwd: root, repo, input: options.preflightInput });
    assertDispatchablePlan(plan);
    if (!plan.supported) {
      throw codedError("OPENCODE_ORCHESTRATION_UNSUPPORTED", `${plan.reason}. The native controller will not fall back to prose orchestration.`);
    }
    const batchId = newBatchId(repo, options.query);
    store = createBatchStore({ repo, batchId, root: batchRoot });
    planEnvelope = {
      schema: "forgedock-opencode-batch-plan-v1",
      batchId,
      repo,
      cwd: root,
      query: options.query,
      ...(options.lane ? { lane: options.lane } : {}),
      model: options.model || "",
      variant: options.variant || "",
      maxAttempts: options.maxAttempts ?? null,
      maxConcurrent: options.maxConcurrent ?? config.maxConcurrent,
      keepWorktrees: options.keepWorktrees,
      createdAt: new Date().toISOString(),
      plan,
    };
    store.writePlan(planEnvelope);
    planEnvelope = store.readPlan();
    planDigest = batchPlanDigest(planEnvelope);
    store.append({ event: "BATCH_PLANNED", total: plan.total, query: options.query, planDigest });
    if (options.confirm) {
      throw codedError(
        "OPENCODE_CONFIRM_REQUIRES_RESUME",
        `Batch ${batchId} was persisted for review. Authorize it with --resume ${batchId} --confirm.`,
        { batchId, planPath: store.planPath },
      );
    }
  }

  const promptBytes = phasePromptBytes();
  const expectedBatchId = options.resume || planEnvelope.batchId;
  if (options.dryRun || !options.confirmed) {
    return {
      schema: "forgedock-opencode-orchestrate-result-v1",
      status: options.dryRun ? "dry-run" : "confirmation-required",
      batchId: planEnvelope.batchId,
      repo,
      query: planEnvelope.query,
      plan: planEnvelope.plan,
      planPath: store.planPath,
      eventLog: store.eventPath,
      planDigest,
      promptBytes,
      mutations: [],
    };
  }

  const releaseLease = store.acquireLease();
  try {
    planEnvelope = store.readPlan();
    assertBatchIdentity(planEnvelope, { batchId: expectedBatchId, repo, root });
    planDigest = verifyPlanDigest(store, planEnvelope);
    assertDispatchablePlan(planEnvelope.plan);
    store.append({
      event: resumed ? "BATCH_RESUMED" : "BATCH_AUTHORIZED",
      authorization: options.auto ? "auto" : "confirm",
      planDigest,
    });
    const lane = planEnvelope.lane || "";
    const model = planEnvelope.model || "";
    const variant = planEnvelope.variant || "";
    const maxAttempts = planEnvelope.maxAttempts;
    const result = await runBatchScheduler({
      plan: planEnvelope.plan,
      store,
      cwd: root,
      repo,
      maxConcurrent: planEnvelope.maxConcurrent,
      signal,
      resume: resumed,
      onProgress,
      worker: (issue) => runWorkOn({
        client,
        cwd: root,
        arguments: [
          String(issue),
          ...(lane ? ["--lane", lane] : []),
          "--repo", repo,
          "--under-orchestration",
          ...(model ? ["--model", model] : []),
          ...(variant ? ["--variant", variant] : []),
          ...(maxAttempts ? ["--max-attempts", String(maxAttempts)] : []),
          ...(planEnvelope.keepWorktrees ? ["--keep-worktree"] : []),
        ].join(" "),
        signal,
        onSession: (session) => onSession({ ...session, issue }),
        onProgress: (event) => onProgress({ ...event, issue }),
      }),
    });
    const status = signal?.aborted
      ? "cancelled"
      : Object.entries(result.counts).some(([state, count]) => state !== "done" && count > 0)
        ? "partial"
        : "complete";
    store.append({ event: "BATCH_TERMINAL", status, counts: result.counts, planDigest });
    return {
      schema: "forgedock-opencode-orchestrate-result-v1",
      status,
      batchId: planEnvelope.batchId,
      repo,
      query: planEnvelope.query,
      counts: result.counts,
      issues: result.states,
      planPath: store.planPath,
      eventLog: store.eventPath,
      planDigest,
    };
  } finally {
    releaseLease();
  }
}

export function formatNativeOrchestrateResult(result) {
  if (result.status === "dry-run" || result.status === "confirmation-required") {
    const ready = result.plan.ready || [];
    const lines = [
      `OpenCode-native orchestration ${result.status}: ${result.repo}`,
      `batch: ${result.batchId}`,
      `query: ${result.query}`,
      `issues: ${result.plan.total}`,
      `initial ready: ${ready.length ? ready.map((issue) => `#${issue}`).join(", ") : "none"}`,
      `plan: ${result.planPath}`,
      "mutations: none",
    ];
    if (result.status === "confirmation-required") {
      lines.push(`Authorize the reviewed persisted plan with --resume ${result.batchId} --confirm.`);
    }
    return lines.join("\n");
  }
  return [
    `OpenCode-native orchestration ${result.status}: ${result.repo}`,
    `batch: ${result.batchId}`,
    `counts: ${JSON.stringify(result.counts)}`,
    `events: ${result.eventLog}`,
  ].join("\n");
}
