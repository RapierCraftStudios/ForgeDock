import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codedError, parseModel } from "./config.mjs";

const DEFAULT_RUNTIME_ROOT = fileURLToPath(new URL("../../runtimes/opencode/work-on", import.meta.url));
const PHASE_BY_COMMAND = new Map([
  ["work-on/investigate", "investigate"],
  ["work-on/decompose", "decompose"],
  ["work-on/build/context", "context"],
  ["work-on/build/architect", "architect"],
  ["work-on/build", "build"],
  ["work-on/review", "review"],
  ["work-on/remediate", "remediate"],
  ["work-on/close", "close"],
]);

export function phasePromptBytes(runtimeRoot = DEFAULT_RUNTIME_ROOT) {
  const common = Buffer.byteLength(readFileSync(join(runtimeRoot, "common.md"), "utf8"));
  const phases = {};
  for (const phase of new Set(PHASE_BY_COMMAND.values())) {
    phases[phase] = common + Buffer.byteLength(readFileSync(join(runtimeRoot, `${phase}.md`), "utf8"));
  }
  return phases;
}

export function assertOpenCodeClient(client) {
  for (const method of ["create", "prompt", "abort"]) {
    if (typeof client?.session?.[method] !== "function") {
      throw codedError("OPENCODE_CLIENT_UNAVAILABLE", `OpenCode host client is missing session.${method}().`);
    }
  }
}

function unwrap(response, operation) {
  if (response?.error !== undefined && response.error !== null) {
    const detail = response.error?.data?.message || response.error?.message || response.error?.name || "request failed";
    throw codedError("OPENCODE_CLIENT_ERROR", `${operation}: ${String(detail).slice(0, 800)}`);
  }
  if (!response || response.data === undefined || response.data === null) {
    throw codedError("OPENCODE_CLIENT_ERROR", `${operation}: OpenCode returned no data.`);
  }
  return response.data;
}

function assistantText(parts) {
  return (parts || [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .slice(-8_000);
}

function usageFromInfo(info) {
  if (!info?.tokens) return null;
  return {
    input_tokens: info.tokens.input ?? 0,
    output_tokens: (info.tokens.output ?? 0) + (info.tokens.reasoning ?? 0),
    cache_creation_input_tokens: info.tokens.cache?.write ?? 0,
    cache_read_input_tokens: info.tokens.cache?.read ?? 0,
    reasoning_tokens: info.tokens.reasoning ?? 0,
    cost_usd: info.cost ?? 0,
  };
}

function errorSummary(error) {
  if (!error) return "";
  const name = error.name || error.data?.name || "OpenCodeError";
  const message = error.message || error.data?.message || error.data?.data?.message || "assistant execution failed";
  return `${name}: ${String(message).slice(0, 700)}`;
}

async function createSession(client, { directory, title }) {
  return unwrap(await client.session.create({
    body: { title },
    query: { directory },
  }), "create OpenCode phase session");
}

async function promptSession(client, { sessionID, directory, system, text, model }) {
  return unwrap(await client.session.prompt({
    path: { id: sessionID },
    query: { directory },
    body: {
      agent: "build",
      ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
      ...(model?.variant ? { variant: model.variant } : {}),
      system,
      tools: {
        task: false,
        skill: false,
        forge_work_on: false,
        forge_orchestrate: false,
      },
      parts: [{ type: "text", text }],
    },
  }), "run OpenCode phase session");
}

async function abortSession(client, sessionID, directory) {
  try {
    unwrap(
      await client.session.abort({ path: { id: sessionID }, query: { directory } }),
      "abort OpenCode phase session",
    );
    return null;
  } catch (error) {
    return error;
  }
}

function cancelledError() {
  return codedError("OPENCODE_CANCELLED", "OpenCode ForgeDock run was cancelled.");
}

export function createOpenCodePhaseRunner({
  client,
  context,
  runtimeRoot = DEFAULT_RUNTIME_ROOT,
  preparePhase = async () => context.cwd,
  onSession = () => {},
  onRuntimeEvent = () => {},
  onProgress = () => {},
  signal,
} = {}) {
  assertOpenCodeClient(client);
  const common = readFileSync(join(runtimeRoot, "common.md"), "utf8");
  const model = context.model ? parseModel(context.model, context.variant) : null;
  const active = new Map();

  const abortRecord = async (record) => {
    if (!record.abortPromise) {
      record.abortPromise = (async () => {
        const error = await abortSession(client, record.sessionID, record.directory);
        if (!error) return "";
        const failure = errorSummary(error) || "OpenCode session abort failed";
        try {
          await onRuntimeEvent({
            event: "OPENCODE_SESSION_ABORT_FAILED",
            phase: record.phase,
            sessionID: record.sessionID,
            failure,
          });
        } catch {
          // Cancellation must continue even when its diagnostic sink is unavailable.
        }
        return failure;
      })();
    }
    return record.abortPromise;
  };

  const runner = async ({ commandName, args }) => {
    const phase = PHASE_BY_COMMAND.get(commandName);
    if (!phase) throw codedError("OPENCODE_PHASE_UNKNOWN", `No OpenCode-native phase card for ${commandName}.`);
    let cancelled = signal?.aborted === true;
    let directory = "";
    let record = null;
    let terminalReported = false;
    const abort = () => {
      cancelled = true;
      if (record) void abortRecord(record);
    };
    // Register before preparation/session creation. AbortSignal does not replay
    // an earlier abort, so `cancelled` above is the explicit replay path.
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (cancelled) throw cancelledError();
      const prepared = await preparePhase({ phase, commandName });
      if (cancelled || signal?.aborted) throw cancelledError();
      directory = resolve(prepared);
      const card = readFileSync(join(runtimeRoot, `${phase}.md`), "utf8");
      const invocation = {
        schema: "forgedock-opencode-phase-v1",
        phase,
        issue: context.issue,
        repo: context.repo,
        repositoryRoot: context.cwd,
        workingDirectory: directory,
        baseBranch: context.lane,
        branch: context.branch || null,
        worktree: context.worktree || null,
        orchestrated: context.underOrchestration === true,
        arguments: args || [],
      };
      const title = `ForgeDock #${context.issue} ${phase}`;
      onProgress({ event: "runtime_session_starting", phase, title });
      if (cancelled || signal?.aborted) throw cancelledError();
      const session = await createSession(client, { directory, title });
      const sessionID = session.id;
      if (!sessionID) throw codedError("OPENCODE_CLIENT_ERROR", "OpenCode created a phase session without an id.");
      record = { sessionID, phase, directory, abortPromise: null, prompted: false };
      active.set(sessionID, record);
      if (cancelled || signal?.aborted) {
        await abortRecord(record);
        throw cancelledError();
      }
      await onSession({ sessionID, phase, directory });
      if (cancelled || signal?.aborted) throw cancelledError();
      await onRuntimeEvent({ event: "OPENCODE_SESSION_BOUND", phase, sessionID, directory });
      if (cancelled || signal?.aborted) throw cancelledError();
      onProgress({ event: "runtime_session_started", phase, sessionID, title });
      if (cancelled || signal?.aborted) throw cancelledError();

      record.prompted = true;
      const result = await promptSession(client, {
        sessionID,
        directory,
        model,
        system: common,
        text: `${card}\n\n## Invocation Context\n\n\`\`\`json\n${JSON.stringify(invocation, null, 2)}\n\`\`\`\n`,
      });
      if (cancelled || signal?.aborted) throw cancelledError();
      const usage = usageFromInfo(result.info);
      const failure = errorSummary(result.info?.error);
      terminalReported = true;
      await onRuntimeEvent({
        event: "OPENCODE_SESSION_TERMINAL",
        phase,
        sessionID,
        finish: result.info?.finish || null,
        failure: failure || null,
        usage,
      });
      if (cancelled || signal?.aborted) throw cancelledError();
      onProgress({ event: "runtime_session_finished", phase, sessionID, failure: failure || undefined });
      if (cancelled || signal?.aborted) throw cancelledError();
      return {
        usage,
        sessionID,
        text: assistantText(result.parts),
        ...(failure ? { runtimeFailure: { code: "OPENCODE_ASSISTANT_ERROR", message: failure, retryable: true } } : {}),
      };
    } catch (error) {
      if (error.code === "OPENCODE_CANCELLED" || cancelled || signal?.aborted) {
        if (record) await abortRecord(record);
        if (record && !terminalReported) {
          terminalReported = true;
          try {
            await onRuntimeEvent({
              event: "OPENCODE_SESSION_TERMINAL",
              phase,
              sessionID: record.sessionID,
              failure: "cancelled",
              usage: null,
            });
          } catch {
            // The cancellation remains authoritative if telemetry cannot be recorded.
          }
        }
        throw cancelledError();
      }
      if (!record) throw error;
      if (!record.prompted) {
        await abortRecord(record);
        if (cancelled || signal?.aborted) throw cancelledError();
      }
      const message = String(error.message || error).slice(0, 800);
      if (!terminalReported) {
        terminalReported = true;
        try {
          await onRuntimeEvent({
            event: "OPENCODE_SESSION_TERMINAL",
            phase,
            sessionID: record.sessionID,
            failure: message,
            usage: null,
          });
        } catch {
          // Runtime telemetry is diagnostic; the engine result remains authoritative.
        }
        if (cancelled || signal?.aborted) throw cancelledError();
      }
      return {
        usage: null,
        sessionID: record.sessionID,
        runtimeFailure: { code: error.code || "OPENCODE_SESSION_FAILED", message, retryable: true },
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      if (record) active.delete(record.sessionID);
    }
  };

  runner.abort = async () => {
    return (await Promise.all([...active.values()].map((record) => abortRecord(record)))).filter(Boolean);
  };
  return runner;
}
