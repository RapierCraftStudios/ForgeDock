import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import {
  parseOrchestrateArguments,
  parseWorkOnArguments,
  readForgeConfig,
  splitArguments,
} from "../opencode/config.mjs";
import { batchPlanDigest, createBatchStore } from "../opencode/batch-store.mjs";
import { classifyExternalDependency, runBatchScheduler, runNativeOrchestrate } from "../opencode/orchestrator.mjs";
import { createOpenCodePhaseRunner, phasePromptBytes } from "../opencode/runner.mjs";

const roots = [];
const execFileAsync = promisify(execFile);

function temp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function compactPlan(records = [{ number: 1, predecessors: [] }]) {
  const issues = records.map((record) => ({
    externalDependencies: [],
    classification: "IMPLEMENTATION",
    priority: 1,
    ...record,
  }));
  return {
    supported: true,
    requiresDeepPlan: false,
    total: issues.length,
    issues,
    investigations: [],
    ready: issues.filter((item) => item.predecessors.length === 0).map((item) => item.number),
  };
}

function runTestOrchestration({ root, batchRoot, args, plan = compactPlan(), runWorkOn, signal }) {
  return runNativeOrchestrate({
    cwd: root,
    batchRoot,
    arguments: args,
    signal,
    compilePlan: () => plan,
    loadConfig: () => ({ repo: "acme/app", maxConcurrent: 2 }),
    resolveRoot: async () => root,
    verifyRepository: async () => {},
    runWorkOn: runWorkOn || (async () => ({ terminalReason: "merged" })),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function successfulAssistant(overrides = {}) {
  return {
    info: {
      id: "message-1",
      sessionID: "session-1",
      role: "assistant",
      time: { created: 1, completed: 2 },
      modelID: "model",
      providerID: "provider",
      mode: "build",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0.25,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 10 } },
      finish: "stop",
      ...overrides,
    },
    parts: [{ type: "text", text: "phase finished" }],
  };
}

function fakeClient({ prompt = async () => ({ data: successfulAssistant() }) } = {}) {
  const calls = { create: [], prompt: [], abort: [] };
  let next = 0;
  return {
    calls,
    client: {
      session: {
        create: async (options) => {
          calls.create.push(options);
          return { data: { id: `session-${++next}` } };
        },
        prompt: async (options) => {
          calls.prompt.push(options);
          return prompt(options);
        },
        abort: async (options) => {
          calls.abort.push(options);
          return { data: true };
        },
      },
    },
  };
}

describe("OpenCode native argument/config boundary", () => {
  it("parses quoted arguments and rejects unknown flags", () => {
    assert.deepEqual(splitArguments('42 --lane "release candidate"'), ["42", "--lane", "release candidate"]);
    assert.equal(parseWorkOnArguments('"42 --dry-run"').issue, 42);
    assert.equal(parseWorkOnArguments('"42 --dry-run"').dryRun, true);
    assert.deepEqual(parseWorkOnArguments("#42 --lane staging --model acme/model --dry-run"), {
      issue: 42,
      prefix: "",
      lane: "staging",
      repo: "",
      model: "acme/model",
      variant: "",
      maxAttempts: undefined,
      dryRun: true,
      keepWorktree: false,
      underOrchestration: false,
    });
    assert.throws(() => parseWorkOnArguments("42 --unknown"), /Unknown ForgeDock flag/);
    assert.throws(() => parseWorkOnArguments("42 --model missing-provider"), /provider\/model/);
    assert.throws(() => parseWorkOnArguments("42 --variant fast"), /--variant requires --model/);
  });

  it("keeps authorization and scheduler controls separate from the issue query", () => {
    const parsed = parseOrchestrateArguments("milestone checkout --confirm --max-concurrent 4 --lane test/native");
    assert.equal(parsed.query, "milestone checkout");
    assert.equal(parsed.preflightInput, "milestone checkout --max-concurrent 4");
    assert.equal(parsed.confirmed, true);
    assert.equal(parsed.maxConcurrent, 4);
    assert.equal(parsed.lane, "test/native");
    assert.throws(() => parseOrchestrateArguments("1 --variant fast"), /--variant requires --model/);
    assert.throws(
      () => parseOrchestrateArguments("--resume batch-1 --max-concurrent 2"),
      (error) => error.code === "OPENCODE_RESUME_OVERRIDE",
    );
  });

  it("reads only the ForgeDock config fields needed by native control", () => {
    const root = temp("fd-native-config-");
    writeFileSync(join(root, "forge.yaml"), `project:
  owner: "acme"
  repo: "app"
paths:
  root: "${root.replaceAll("\\", "/")}"
branches:
  default: "main"
  staging: "staging"
  feature_pattern: "feature/{slug}"
orchestration:
  max_concurrent: 7
repos:
  satellites:
    - prefix: "api"
      repo: "acme/api"
      staging_branch: "main"
      local_path: "${root.replaceAll("\\", "/")}/api"
`);
    const config = readForgeConfig(root);
    assert.equal(config.repo, "acme/app");
    assert.equal(config.stagingBranch, "staging");
    assert.equal(config.featurePattern, "feature/{slug}");
    assert.equal(config.maxConcurrent, 7);
    assert.deepEqual(config.satellites, [{
      prefix: "api",
      repo: "acme/api",
      staging_branch: "main",
      local_path: `${root.replaceAll("\\", "/")}/api`,
    }]);
  });
});

describe("OpenCode durable batch store", () => {
  it("serializes concurrent append sequence assignment", async () => {
    const root = temp("fd-native-append-");
    const workerPath = join(root, "append-worker.mjs");
    const moduleUrl = new URL("../opencode/batch-store.mjs", import.meta.url).href;
    writeFileSync(workerPath, `
import { createBatchStore } from ${JSON.stringify(moduleUrl)};
const [root, offset, count] = process.argv.slice(2);
const store = createBatchStore({ repo: "acme/app", batchId: "append-batch", root });
for (let index = 0; index < Number(count); index++) {
  store.append({ event: "TEST_APPEND", value: Number(offset) + index });
}
`, "utf8");

    await Promise.all(Array.from({ length: 4 }, (_, index) =>
      execFileAsync(process.execPath, [workerPath, root, String(index * 20), "20"], { windowsHide: true })));

    const events = createBatchStore({ repo: "acme/app", batchId: "append-batch", root }).readEvents();
    assert.equal(events.length, 80);
    assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 80 }, (_, index) => index + 1));
    assert.equal(new Set(events.map((event) => event.value)).size, 80);
  });

  it("denies a concurrent lease and reclaims one left by a crashed process", async () => {
    const root = temp("fd-native-lease-");
    const workerPath = join(root, "lease-worker.mjs");
    const moduleUrl = new URL("../opencode/batch-store.mjs", import.meta.url).href;
    writeFileSync(workerPath, `
import { createBatchStore } from ${JSON.stringify(moduleUrl)};
const store = createBatchStore({ repo: "acme/app", batchId: "lease-batch", root: process.argv[2] });
store.acquireLease();
`, "utf8");
    await execFileAsync(process.execPath, [workerPath, root], { windowsHide: true });

    const store = createBatchStore({ repo: "acme/app", batchId: "lease-batch", root });
    const release = store.acquireLease();
    assert.throws(() => store.acquireLease(), (error) => error.code === "OPENCODE_BATCH_BUSY");
    release();
    const reacquired = store.acquireLease();
    reacquired();
  });

  it("uses a canonical digest for persisted plan content", () => {
    assert.equal(batchPlanDigest({ b: 2, a: { d: 4, c: 3 } }), batchPlanDigest({ a: { c: 3, d: 4 }, b: 2 }));
    assert.notEqual(batchPlanDigest({ a: 1 }), batchPlanDigest({ a: 2 }));
  });

  it("does not allow event payloads to override assigned ordering fields", () => {
    const root = temp("fd-native-event-fields-");
    const store = createBatchStore({ repo: "acme/app", batchId: "event-fields", root });
    store.append({ event: "TEST_APPEND", seq: 99, at: 1 });
    assert.equal(store.readEvents()[0].seq, 1);
    assert.notEqual(store.readEvents()[0].at, 1);
  });

  it("repairs a valid final event that is missing only its newline", () => {
    const root = temp("fd-native-event-newline-");
    const store = createBatchStore({ repo: "acme/app", batchId: "event-newline", root });
    store.append({ event: "FIRST" });
    writeFileSync(store.eventPath, readFileSync(store.eventPath, "utf8").trimEnd(), "utf8");
    store.append({ event: "SECOND" });
    assert.deepEqual(store.readEvents().map((event) => [event.seq, event.event]), [[1, "FIRST"], [2, "SECOND"]]);
  });
});

describe("OpenCode native orchestration authorization", () => {
  it("persists no implicit lane and resolves workers from the reviewed plan on resume", async () => {
    const root = temp("fd-native-orchestrate-root-");
    const batchRoot = temp("fd-native-orchestrate-batches-");
    const workerArguments = [];
    const runWorkOn = async (options) => {
      workerArguments.push(options.arguments);
      return { terminalReason: "merged" };
    };
    const compiled = await runTestOrchestration({ root, batchRoot, args: "1", runWorkOn });

    assert.equal(compiled.status, "confirmation-required");
    const persisted = JSON.parse(readFileSync(compiled.planPath, "utf8"));
    assert.equal(Object.hasOwn(persisted, "lane"), false);
    const planned = createBatchStore({ repo: "acme/app", batchId: compiled.batchId, root: batchRoot }).readEvents()[0];
    assert.equal(planned.event, "BATCH_PLANNED");
    assert.equal(planned.planDigest, batchPlanDigest(persisted));

    const resumed = await runTestOrchestration({
      root,
      batchRoot,
      args: `--resume ${compiled.batchId} --confirm`,
      runWorkOn,
    });
    assert.equal(resumed.status, "complete");
    assert.equal(parseWorkOnArguments(workerArguments[0]).lane, "");

    const unauthorizedAgain = await runTestOrchestration({
      root,
      batchRoot,
      args: `--resume ${compiled.batchId}`,
      runWorkOn,
    });
    assert.equal(unauthorizedAgain.status, "confirmation-required");
    assert.equal(workerArguments.length, 1);
  });

  it("supports explicit one-shot authorization using exactly the persisted batch options", async () => {
    const root = temp("fd-native-auto-root-");
    const batchRoot = temp("fd-native-auto-batches-");
    const workerArguments = [];
    const result = await runTestOrchestration({
      root,
      batchRoot,
      args: "1 --lane milestone/all --model acme/model --variant fast --max-attempts 2 --keep-worktrees --auto",
      runWorkOn: async (options) => {
        workerArguments.push(options.arguments);
        return { terminalReason: "merged" };
      },
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(parseWorkOnArguments(workerArguments[0]), {
      issue: 1,
      prefix: "",
      lane: "milestone/all",
      repo: "acme/app",
      model: "acme/model",
      variant: "fast",
      maxAttempts: 2,
      dryRun: false,
      keepWorktree: true,
      underOrchestration: true,
    });
    assert.equal(JSON.parse(readFileSync(result.planPath, "utf8")).lane, "milestone/all");
  });

  it("rejects fresh --confirm and detects plan edits before resumed dispatch", async () => {
    const root = temp("fd-native-digest-root-");
    const batchRoot = temp("fd-native-digest-batches-");
    await assert.rejects(
      runTestOrchestration({ root, batchRoot, args: "1 --confirm" }),
      (error) => error.code === "OPENCODE_CONFIRM_REQUIRES_RESUME" && /--resume .* --confirm/.test(error.message),
    );

    const compiled = await runTestOrchestration({ root, batchRoot, args: "1" });
    const edited = JSON.parse(readFileSync(compiled.planPath, "utf8"));
    edited.maxConcurrent++;
    writeFileSync(compiled.planPath, `${JSON.stringify(edited, null, 2)}\n`, "utf8");
    await assert.rejects(
      runTestOrchestration({ root, batchRoot, args: `--resume ${compiled.batchId} --confirm` }),
      (error) => error.code === "OPENCODE_BATCH_PLAN_MISMATCH",
    );
  });

  it("holds one exclusive scheduler lease across resumed execution", async () => {
    const root = temp("fd-native-busy-root-");
    const batchRoot = temp("fd-native-busy-batches-");
    const compiled = await runTestOrchestration({ root, batchRoot, args: "1" });
    let markStarted;
    let finishWorker;
    const started = new Promise((resolvePromise) => { markStarted = resolvePromise; });
    const workerDone = new Promise((resolvePromise) => { finishWorker = resolvePromise; });
    const runWorkOn = async () => {
      markStarted();
      await workerDone;
      return { terminalReason: "merged" };
    };
    const first = runTestOrchestration({
      root,
      batchRoot,
      args: `--resume ${compiled.batchId} --confirm`,
      runWorkOn,
    });
    await started;
    await assert.rejects(
      runTestOrchestration({
        root,
        batchRoot,
        args: `--resume ${compiled.batchId} --confirm`,
        runWorkOn,
      }),
      (error) => error.code === "OPENCODE_BATCH_BUSY",
    );
    finishWorker();
    assert.equal((await first).status, "complete");
  });

  it("never reports an entirely cancelled batch as complete", async () => {
    const root = temp("fd-native-cancel-root-");
    const batchRoot = temp("fd-native-cancel-batches-");
    const controller = new AbortController();
    controller.abort();
    const result = await runTestOrchestration({ root, batchRoot, args: "1 --auto", signal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.counts, { cancelled: 1 });
  });

  it("fails closed when any persisted issue record is investigation-class", async () => {
    const root = temp("fd-native-investigation-root-");
    const batchRoot = temp("fd-native-investigation-batches-");
    const plan = compactPlan();
    plan.issues[0].classification = "INVESTIGATION";
    await assert.rejects(
      runTestOrchestration({ root, batchRoot, args: "1 --auto", plan }),
      (error) => error.code === "OPENCODE_DEEP_PLAN_REQUIRED",
    );
  });
});

describe("OpenCode native phase runner", () => {
  it("loads compact native cards and never loads the Claude control plane", () => {
    const bytes = phasePromptBytes();
    assert.deepEqual(Object.keys(bytes), ["investigate", "decompose", "context", "architect", "build", "review", "remediate", "close"]);
    assert.ok(Object.values(bytes).every((value) => value < 5_000));
    assert.ok(Object.values(bytes).reduce((sum, value) => sum + value, 0) < 35_000);
    const source = readFileSync(new URL("../opencode/runner.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(source, /commands[\\/]work-on\.md|commands[\\/]orchestrate/);
  });

  it("creates a fresh root session, disables recursive tools, and normalizes usage", async () => {
    const { client, calls } = fakeClient();
    const sessions = [];
    const events = [];
    const runner = createOpenCodePhaseRunner({
      client,
      context: {
        issue: 42,
        repo: "acme/app",
        cwd: resolve("/repo"),
        lane: "staging",
        branch: "fix/example-42",
        worktree: null,
        model: "acme/model",
        variant: "fast",
      },
      preparePhase: async () => resolve("/repo"),
      onSession: (session) => sessions.push(session),
      onRuntimeEvent: (event) => events.push(event),
    });

    const result = await runner({ commandName: "work-on/investigate", args: ["42"] });

    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0].body.parentID, undefined);
    assert.equal(calls.prompt[0].path.id, "session-1");
    assert.equal(calls.prompt[0].body.agent, "build");
    assert.deepEqual(calls.prompt[0].body.model, { providerID: "acme", modelID: "model" });
    assert.deepEqual(calls.prompt[0].body.tools, {
      task: false,
      skill: false,
      forge_work_on: false,
      forge_orchestrate: false,
    });
    assert.match(calls.prompt[0].body.parts[0].text, /"phase": "investigate"/);
    assert.doesNotMatch(calls.prompt[0].body.parts[0].text, /commands\/work-on\.md/);
    assert.deepEqual(result.usage, {
      input_tokens: 100,
      output_tokens: 25,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 40,
      reasoning_tokens: 5,
      cost_usd: 0.25,
    });
    assert.equal(sessions[0].sessionID, "session-1");
    assert.deepEqual(events.map((event) => event.event), ["OPENCODE_SESSION_BOUND", "OPENCODE_SESSION_TERMINAL"]);
  });

  it("returns assistant/provider failures for authoritative engine reconciliation", async () => {
    const { client } = fakeClient({
      prompt: async () => ({ data: successfulAssistant({ error: { name: "APIError", message: "provider unavailable" } }) }),
    });
    const runner = createOpenCodePhaseRunner({
      client,
      context: { issue: 1, repo: "acme/app", cwd: resolve("/repo"), lane: "staging" },
    });
    const result = await runner({ commandName: "work-on/investigate", args: ["1"] });
    assert.equal(result.runtimeFailure.code, "OPENCODE_ASSISTANT_ERROR");
    assert.match(result.runtimeFailure.message, /provider unavailable/);
  });

  it("aborts the active OpenCode session when the host tool is cancelled", async () => {
    const controller = new AbortController();
    let release;
    const promptDone = new Promise((resolvePromise) => { release = resolvePromise; });
    const fake = fakeClient({ prompt: () => promptDone });
    fake.client.session.abort = async (options) => {
      fake.calls.abort.push(options);
      release({ data: successfulAssistant() });
      return { data: true };
    };
    const runner = createOpenCodePhaseRunner({
      client: fake.client,
      context: { issue: 1, repo: "acme/app", cwd: resolve("/repo"), lane: "staging" },
      signal: controller.signal,
    });
    const running = runner({ commandName: "work-on/investigate", args: ["1"] });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    controller.abort();
    await assert.rejects(running, (error) => error.code === "OPENCODE_CANCELLED");
    assert.equal(fake.calls.abort.length, 1);
    assert.equal(fake.calls.abort[0].path.id, "session-1");
  });
});

describe("OpenCode deterministic batch scheduler", () => {
  function plan(records) {
    return { issues: records.map((record) => ({ externalDependencies: [], priority: 1, ...record })) };
  }

  it("runs ready issues concurrently and unlocks successors per completion", async () => {
    const root = temp("fd-native-batch-");
    const store = createBatchStore({ repo: "acme/app", batchId: "batch-1", root });
    const starts = [];
    let active = 0;
    let peak = 0;
    const result = await runBatchScheduler({
      plan: plan([
        { number: 1, predecessors: [] },
        { number: 2, predecessors: [1] },
        { number: 3, predecessors: [] },
      ]),
      store,
      cwd: root,
      repo: "acme/app",
      maxConcurrent: 2,
      worker: async (issue) => {
        starts.push(issue);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, issue === 1 ? 15 : 2));
        active--;
        return { terminalReason: "merged", branch: `fix/${issue}`, sessions: [] };
      },
    });
    assert.equal(peak, 2);
    assert.deepEqual(new Set(starts.slice(0, 2)), new Set([1, 3]));
    assert.equal(starts.at(-1), 2);
    assert.deepEqual(result.counts, { done: 3 });
  });

  it("blocks dependents after a failed predecessor without dispatching them", async () => {
    const root = temp("fd-native-batch-fail-");
    const store = createBatchStore({ repo: "acme/app", batchId: "batch-2", root });
    const starts = [];
    const result = await runBatchScheduler({
      plan: plan([{ number: 1, predecessors: [] }, { number: 2, predecessors: [1] }]),
      store,
      cwd: root,
      repo: "acme/app",
      maxConcurrent: 2,
      worker: async (issue) => {
        starts.push(issue);
        return { terminalReason: "engine-error", sessions: [] };
      },
    });
    assert.deepEqual(starts, [1]);
    assert.equal(result.states[1], "engine-failed");
    assert.equal(result.states[2], "blocked");
  });

  it("treats decomposition as a durable non-success", async () => {
    const root = temp("fd-native-batch-decomposed-");
    const store = createBatchStore({ repo: "acme/app", batchId: "batch-decomposed", root });
    const starts = [];
    const result = await runBatchScheduler({
      plan: plan([{ number: 1, predecessors: [] }, { number: 2, predecessors: [1] }]),
      store,
      cwd: root,
      repo: "acme/app",
      maxConcurrent: 1,
      worker: async (issue) => {
        starts.push(issue);
        return { terminalReason: "decomposed" };
      },
    });
    assert.deepEqual(starts, [1]);
    assert.equal(result.states[1], "decomposed");
    assert.equal(result.states[2], "blocked");
  });

  it("resumes from persisted terminal events and tolerates a truncated final record", async () => {
    const root = temp("fd-native-batch-resume-");
    const store = createBatchStore({ repo: "acme/app", batchId: "batch-3", root });
    mkdirSync(store.directory, { recursive: true });
    store.append({ event: "ISSUE_TERMINAL", issue: 1, state: "done" });
    appendFileSync(store.eventPath, "{truncated", "utf8");
    assert.equal(store.readEvents().length, 1);
    const starts = [];
    const result = await runBatchScheduler({
      plan: plan([{ number: 1, predecessors: [] }, { number: 2, predecessors: [1] }]),
      store,
      cwd: root,
      repo: "acme/app",
      maxConcurrent: 1,
      worker: async (issue) => {
        starts.push(issue);
        return { terminalReason: "merged", sessions: [] };
      },
    });
    assert.deepEqual(starts, [2]);
    assert.deepEqual(result.counts, { done: 2 });
  });

  it("resets cancelled issues and their blocked successors on confirmed resume", async () => {
    const root = temp("fd-native-batch-cancel-resume-");
    const store = createBatchStore({ repo: "acme/app", batchId: "batch-cancel-resume", root });
    store.append({ event: "ISSUE_TERMINAL", issue: 1, state: "cancelled" });
    store.append({ event: "ISSUE_TERMINAL", issue: 2, state: "blocked" });
    const starts = [];
    const result = await runBatchScheduler({
      plan: plan([{ number: 1, predecessors: [] }, { number: 2, predecessors: [1] }]),
      store,
      cwd: root,
      repo: "acme/app",
      maxConcurrent: 1,
      resume: true,
      worker: async (issue) => {
        starts.push(issue);
        return { terminalReason: "merged" };
      },
    });
    assert.deepEqual(starts, [1, 2]);
    assert.deepEqual(result.counts, { done: 2 });
    assert.deepEqual(
      store.readEvents().filter((event) => event.event === "ISSUE_RESET").map((event) => [event.issue, event.from]),
      [[1, "cancelled"], [2, "blocked"]],
    );
  });

  it("resets deferred issues before allowing successors to run", async () => {
    const root = temp("fd-native-batch-deferred-resume-");
    const store = createBatchStore({ repo: "acme/app", batchId: "batch-deferred-resume", root });
    store.append({ event: "ISSUE_TERMINAL", issue: 1, state: "deferred" });
    store.append({ event: "ISSUE_TERMINAL", issue: 2, state: "blocked" });
    const starts = [];
    const result = await runBatchScheduler({
      plan: plan([{ number: 1, predecessors: [] }, { number: 2, predecessors: [1] }]),
      store,
      cwd: root,
      repo: "acme/app",
      maxConcurrent: 2,
      resume: true,
      worker: async (issue) => {
        starts.push(issue);
        return { terminalReason: "merged" };
      },
    });
    assert.deepEqual(starts, [1, 2]);
    assert.deepEqual(result.counts, { done: 2 });
  });

  it("resets an ISSUE_STARTED crash remnant before redispatch", async () => {
    const root = temp("fd-native-batch-crash-resume-");
    const store = createBatchStore({ repo: "acme/app", batchId: "batch-crash-resume", root });
    store.append({ event: "ISSUE_STARTED", issue: 1 });
    const starts = [];
    const result = await runBatchScheduler({
      plan: plan([{ number: 1, predecessors: [] }]),
      store,
      cwd: root,
      repo: "acme/app",
      maxConcurrent: 1,
      resume: true,
      worker: async (issue) => {
        starts.push(issue);
        return { terminalReason: "merged" };
      },
    });
    assert.deepEqual(starts, [1]);
    assert.deepEqual(result.counts, { done: 1 });
    assert.ok(store.readEvents().some((event) => event.event === "ISSUE_RESET" && event.issue === 1 && event.from === "running"));
  });

  it("preserves durable invalid outcomes while recomputing transient blocks", async () => {
    const root = temp("fd-native-batch-invalid-resume-");
    const store = createBatchStore({ repo: "acme/app", batchId: "batch-invalid-resume", root });
    store.append({ event: "ISSUE_TERMINAL", issue: 1, state: "invalid" });
    store.append({ event: "ISSUE_TERMINAL", issue: 2, state: "blocked" });
    const starts = [];
    const result = await runBatchScheduler({
      plan: plan([{ number: 1, predecessors: [] }, { number: 2, predecessors: [1] }]),
      store,
      cwd: root,
      repo: "acme/app",
      maxConcurrent: 1,
      resume: true,
      worker: async (issue) => {
        starts.push(issue);
        return { terminalReason: "merged" };
      },
    });
    assert.deepEqual(starts, []);
    assert.deepEqual(result.states, { 1: "invalid", 2: "blocked" });
    assert.equal(store.readEvents().some((event) => event.event === "ISSUE_RESET" && event.issue === 1), false);
  });

  it("applies terminal labels before generic external CLOSED state", () => {
    assert.equal(classifyExternalDependency({ state: "OPEN", labels: [{ name: "workflow:merged" }] }), "done");
    assert.equal(classifyExternalDependency({ state: "CLOSED", labels: [{ name: "workflow:invalid" }] }), "failed");
    assert.equal(classifyExternalDependency({ state: "CLOSED", labels: [{ name: "needs-human" }] }), "blocked");
    assert.equal(classifyExternalDependency({ state: "CLOSED", labels: [{ name: "workflow:decomposed" }] }), "failed");
    assert.equal(classifyExternalDependency({ state: "OPEN", labels: [] }), "blocked");
    assert.equal(classifyExternalDependency({ state: "CLOSED", labels: [] }), "done");
  });

  it("preserves a durable worker success that races with batch cancellation", async () => {
    const root = temp("fd-native-batch-cancel-race-");
    const store = createBatchStore({ repo: "acme/app", batchId: "batch-cancel-race", root });
    const controller = new AbortController();
    let finish;
    const workerDone = new Promise((resolvePromise) => { finish = resolvePromise; });
    const running = runBatchScheduler({
      plan: plan([{ number: 1, predecessors: [] }]),
      store,
      cwd: root,
      repo: "acme/app",
      maxConcurrent: 1,
      signal: controller.signal,
      worker: async () => {
        await workerDone;
        return { terminalReason: "merged" };
      },
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    controller.abort();
    finish();
    const result = await running;
    assert.deepEqual(result.counts, { done: 1 });
  });
});
