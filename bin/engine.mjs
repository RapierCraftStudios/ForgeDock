/**
 * Durable per-phase engine loop. Drives one pipeline phase at a time via an
 * injected runner (runCommand-shaped), determining each phase's outcome from
 * GitHub state (phase.detectOutcome). All effects are injected → fully testable.
 */
import { fileURLToPath } from "node:url";
import { appendEvent, readLog, deriveState, rewriteLog } from "./engine/runlog.mjs";
import { pickPhase, TERMINAL_REASONS } from "./engine/phases.mjs";
import { reconcileState } from "./engine/reconcile.mjs";
import { makeProjector } from "./engine/projector.mjs";

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * @param {object} opts
 * @param {string} [opts.backend] - "cli" | "api" | "auto" (forge#2028). Forwarded
 *   to every phase's `runner()` call when supplied. Omit to keep runner.mjs's own
 *   default ("auto" ladder — probes the `claude` CLI, falls back to the API).
 * @param {string} [opts.model] - Model id (forge#2028). Forwarded to every phase's
 *   `runner()` call when supplied; only applies on the "api" backend. Omit to keep
 *   runner.mjs's default (`FORGEDOCK_MODEL` env or its built-in default).
 */
export async function runIssue(opts) {
  const { issue, dir, agentId, lane = "staging", io, runner,
          now = () => Date.now(), maxAttempts = DEFAULT_MAX_ATTEMPTS,
          commandsDir = fileURLToPath(new URL("../commands", import.meta.url)),
          // Optional execution-backend override for every phase's `runner()`
          // call (forge#2028 / MAT-3). Left undefined by default so existing
          // callers keep runner.mjs's own "auto" ladder default unchanged —
          // this is purely additive pass-through, not a new default.
          backend, model } = opts;
  const projector = makeProjector(io);

  // 1. Load + reconcile (GitHub wins).
  const local = readLog(dir, issue).length ? deriveState(readLog(dir, issue)) : null;
  const remote = await projector.readState(issue);
  let { state, action } = reconcileState(local, remote);

  // I3 (best-effort): GitHub issue-edit is not an atomic CAS, so this is a
  // courtesy check, not a hard mutual-exclusion guarantee — a concurrent
  // start can still race between this read and the next lease write.
  // MUST come before any projector.writeState() — remirror/hydrate branches
  // must not overwrite GitHub state when another agent holds a valid lease.
  if (remote?.lease && remote.lease.until > now() && remote.lease.by !== agentId) {
    return { terminalReason: "deferred", detail: `issue ${issue} leased by ${remote.lease.by}` };
  }

  if (!state) {
    state = freshState(issue, lane);
    appendEvent(dir, issue, { event: "RUN_START", issue, run: state.run, lane });
    await projector.writeState(issue, state);
  } else if (action === "remirror") {
    await projector.writeState(issue, state);
  } else if (action === "hydrate") {
    // GitHub is ahead of (or the only source of) local state. Rebuild the
    // local run-log to match the remote compact index so downstream
    // `deriveState(readLog(...))` calls stay consistent — otherwise the
    // post-commit re-derive below would fold over an empty/stale local log
    // and regress committed/issue/v (C2).
    rewriteLog(dir, issue, eventsFromIndex(state));
    state = deriveState(readLog(dir, issue));
    await projector.writeState(issue, state);
  }

  // 2. Drive phases until terminal.
  let phase;
  while ((phase = pickPhase(state))) {
    // Every issue's build works on a deterministic branch; set it before build runs.
    if (phase.id === "build" && !state.branch) state.branch = `fix/pipeline-${issue}`;

    let reconciled;
    try {
      reconciled = phase.reconcile ? await phase.reconcile(state, io) : { satisfied: false };
    } catch {
      // A reconcile probe (gh/git) failing must not crash the run — degrade
      // to "not satisfied" so the phase runs normally instead (C1).
      reconciled = { satisfied: false };
    }
    let outcome;
    if (reconciled.satisfied) {
      outcome = { status: "committed", outputs: reconciled.outputs || {} };
    } else {
      if (reconciled.outputs?.pr) state.pr = reconciled.outputs.pr;
      outcome = await runPhaseWithRetry(phase, state, { io, runner, dir, issue, commandsDir, maxAttempts, backend, model });
    }

    if (outcome.status === "blocked") return await terminate(state, "needs-human", outcome.detail);

    // committed
    appendEvent(dir, issue, { event: "PHASE_COMMIT", phase: phase.id, outputs: outcome.outputs || {} });
    state = deriveState(readLog(dir, issue));
    if (outcome.terminalReason) state.terminalReason = outcome.terminalReason;
    await projector.writeState(issue, { ...state, lease: { by: agentId, until: now() + 600000 } });

    if (outcome.terminalReason && TERMINAL_REASONS.includes(outcome.terminalReason))
      return await terminate(state, outcome.terminalReason);
    if (phase.isTerminalAfter && phase.isTerminalAfter(state))
      return await terminate(state, state.terminalReason || "merged");
  }
  return await terminate(state, state.terminalReason || "merged");

  async function terminate(s, reason, detail) {
    appendEvent(dir, issue, { event: "RUN_TERMINAL", reason });
    const final = { ...deriveState(readLog(dir, issue)), terminal: true, terminalReason: reason, lease: null };
    await projector.writeState(issue, final);
    if (reason === "needs-human") await projector.setLabel(issue, "needs-human");
    return { terminalReason: reason, detail };
  }
}

async function runPhaseWithRetry(phase, state, ctx) {
  const { io, runner, dir, issue, commandsDir, maxAttempts, backend, model } = ctx;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    appendEvent(dir, issue, { event: "PHASE_START", phase: phase.id, attempt });
    try {
      await runner({
        commandsDir, commandName: phase.command, args: [String(issue)],
        // Only forwarded when explicitly provided — omitting them preserves
        // runner.mjs's existing default ("auto" backend / DEFAULT_MODEL).
        ...(backend ? { backend } : {}),
        ...(model ? { model } : {}),
      });
    } catch (e) {
      // A missing API key / SDK is a config error, not a transient phase
      // failure — surface it distinctly instead of burning retries and
      // escalating to needs-human as if the LLM run itself misbehaved.
      if (e.code === "NO_API_KEY" || e.code === "NO_SDK") throw e;
      appendEvent(dir, issue, { event: "PHASE_FAILED", phase: phase.id, attempt, reason: e.message });
      continue;
    }
    const outcome = await phase.detectOutcome(state, io);
    if (outcome.status === "committed" || outcome.status === "blocked") return outcome;
    appendEvent(dir, issue, { event: "PHASE_FAILED", phase: phase.id, attempt, reason: outcome.detail });
  }
  // Exhausted transient retries → escalate (spec §7).
  return { status: "blocked", detail: `phase ${phase.id} failed after ${maxAttempts} attempts` };
}

/**
 * Build a run-log event sequence that reproduces a compact FORGE:STATE index,
 * used to reconstruct the local run-log on hydrate (C2).
 */
function eventsFromIndex(idx) {
  const events = [{ event: "RUN_START", issue: idx.issue, run: idx.run, lane: idx.lane }];
  for (const phase of idx.committed) {
    const outputs = {};
    if (phase === "build" && idx.branch) outputs.branch = idx.branch;
    if (phase === "review" && idx.pr != null) outputs.pr = idx.pr;
    events.push({ event: "PHASE_COMMIT", phase, outputs });
  }
  if (idx.terminal) events.push({ event: "RUN_TERMINAL", reason: idx.terminalReason });
  return events;
}

function freshState(issue, lane) {
  return { v: 0, run: `r_${issue}_${lane}`, issue, lane, committed: [], phase: null,
           branch: null, pr: null, terminal: false, terminalReason: null, lease: null };
}
