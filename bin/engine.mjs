/**
 * Durable per-phase engine loop. Drives one pipeline phase at a time via an
 * injected runner (runCommand-shaped), determining each phase's outcome from
 * GitHub state (phase.detectOutcome). All effects are injected → fully testable.
 */
import { appendEvent, readLog, deriveState } from "./engine/runlog.mjs";
import { PHASES, pickPhase, TERMINAL_REASONS } from "./engine/phases.mjs";
import { reconcileState } from "./engine/reconcile.mjs";
import { makeProjector } from "./engine/projector.mjs";

const DEFAULT_MAX_ATTEMPTS = 3;

export async function runIssue(opts) {
  const { issue, dir, agentId, lane = "staging", io, runner,
          now = () => Date.now(), maxAttempts = DEFAULT_MAX_ATTEMPTS,
          commandsDir = new URL("../commands", import.meta.url).pathname } = opts;
  const projector = makeProjector(io);

  // 1. Load + reconcile (GitHub wins).
  const local = readLog(dir, issue).length ? deriveState(readLog(dir, issue)) : null;
  const remote = await projector.readState(issue);
  let { state, action } = reconcileState(local, remote);
  if (!state) {
    state = freshState(issue, lane);
    appendEvent(dir, issue, { event: "RUN_START", issue, run: state.run, lane });
    await projector.writeState(issue, state);
  } else if (action === "remirror") {
    await projector.writeState(issue, state);
  }

  // 2. Drive phases until terminal.
  let phase;
  while ((phase = pickPhase(state))) {
    // Every issue's build works on a deterministic branch; set it before build runs.
    if (phase.id === "build" && !state.branch) state.branch = `fix/pipeline-${issue}`;

    const reconciled = phase.reconcile ? await phase.reconcile(state, io) : { satisfied: false };
    let outcome;
    if (reconciled.satisfied) {
      outcome = { status: "committed", outputs: reconciled.outputs || {} };
    } else {
      if (reconciled.outputs?.pr) state.pr = reconciled.outputs.pr;
      outcome = await runPhaseWithRetry(phase, state, { io, runner, dir, issue, commandsDir, maxAttempts });
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
  const { io, runner, dir, issue, commandsDir, maxAttempts } = ctx;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    appendEvent(dir, issue, { event: "PHASE_START", phase: phase.id, attempt });
    try {
      await runner({ commandsDir, commandName: phase.command, args: [String(issue)] });
    } catch (e) {
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

function freshState(issue, lane) {
  return { v: 0, run: `r_${issue}_${lane}`, issue, lane, committed: [], phase: null,
           branch: null, pr: null, terminal: false, terminalReason: null, lease: null };
}
