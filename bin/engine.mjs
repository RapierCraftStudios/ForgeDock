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
import { VALID_BACKENDS } from "./runner.mjs";

// Exported (forge#2175) so bin/engine-cli.mjs can render "failed N/M attempts"
// diagnostics without duplicating the retry budget constant.
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * @param {object} opts
 * @param {string} [opts.backend] - "cli" | "api" | "auto" (forge#2028). Forwarded
 *   to every phase's `runner()` call when supplied. Omit to keep runner.mjs's own
 *   default ("auto" ladder — probes the `claude` CLI, falls back to the API).
 *   An invalid value throws synchronously (see below) rather than being forwarded.
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

  // forge#2054: validate `backend` before anything else — before state is
  // read/written and before the phase/retry loop begins below. An invalid
  // value must fail fast and non-retryably. Without this check, an invalid
  // backend instead reaches runner.mjs's resolveBackend() deep inside
  // runPhaseWithRetry()'s per-attempt try/catch, throws an uncoded Error, and
  // is silently retried up to `maxAttempts` times (the catch there only
  // fast-fails on `.code === "NO_API_KEY"/"NO_SDK"`) before escalating to
  // needs-human — burning retries on what is actually a config error, not a
  // transient phase failure. runIssue() is the single production choke point
  // (its only caller is bin/engine-cli.mjs's runFromCli()), so validating
  // here protects every current and future caller without requiring each one
  // to remember to validate independently.
  if (backend !== undefined && !VALID_BACKENDS.has(backend)) {
    throw Object.assign(
      new Error(`Invalid backend "${backend}". Must be one of: ${[...VALID_BACKENDS].join(", ")}.`),
      { code: "INVALID_BACKEND" },
    );
  }

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
  //
  // Note: the build phase's branch is NOT precomputed here. The real branch
  // name is slug-derived from the issue title by `commands/work-on/build.md`
  // (Phase B1A) and cannot be guessed ahead of time — a prior guessed default
  // (`fix/pipeline-{issue}`) was never communicated to the builder and never
  // matched the branch it actually created, so `commitsAhead()` always ran
  // against a nonexistent ref and silently evaluated to 0 (forge#2174). The
  // build phase's `reconcile`/`detectOutcome` (bin/engine/phases.mjs) resolve
  // the real branch from the `FORGE:BUILDER` comment instead.
  let phase;
  while ((phase = pickPhase(state))) {
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
      try {
        outcome = await runPhaseWithRetry(phase, state, { io, runner, dir, issue, commandsDir, maxAttempts, backend, model });
      } catch (e) {
        // forge#2261: NO_API_KEY/NO_SDK/CLI_BACKEND_FAILED are fail-fast
        // rethrown by runPhaseWithRetry() (see its own catch below) instead
        // of being retried — but until now that throw was never caught here,
        // so it propagated all the way out of runIssue() uncaught (through
        // bin/engine-cli.mjs's runFromCli(), which also has no try/catch)
        // and only landed in bin/forgedock.mjs's outermost `run-issue` case,
        // which just prints the message to stderr and exits 1 — no terminal
        // state or label was ever written, leaving the issue stuck on
        // whatever workflow label it already had. Catch it here instead and
        // reach a clean terminal state: "engine-error" is deliberately NOT
        // "needs-human" — this is the engine/tool breaking, not a genuine
        // human-judgment block (see #2244/#2261). Any other thrown error is
        // a true unexpected crash and keeps propagating unchanged.
        if (e.code === "NO_API_KEY" || e.code === "NO_SDK" || e.code === "CLI_BACKEND_FAILED") {
          return await terminate(state, "engine-error", `phase ${phase.id}: ${e.code} - ${e.message}`);
        }
        throw e;
      }
    }

    if (outcome.status === "blocked") return await terminate(state, outcome.reason || "needs-human", outcome.detail);

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
    // forge#2261: a distinct label for engine/tool-level failures (broken CLI
    // invocation, exhausted retries where the runner itself never once
    // succeeded) — NOT needs-human. /orchestrate's classify_predecessor_state()
    // (commands/orchestrate/phase-4-execution.md) must not treat this as GATED:
    // there is no human decision pending, just a tool that needs to be re-run.
    else if (reason === "engine-error") await projector.setLabel(issue, "workflow:engine-error");
    return { terminalReason: reason, detail };
  }
}

async function runPhaseWithRetry(phase, state, ctx) {
  const { io, runner, dir, issue, commandsDir, maxAttempts, backend, model } = ctx;
  // forge#2261: true only if EVERY attempt failed by the runner itself
  // throwing (never once reached phase.detectOutcome()). This is the signal
  // that distinguishes an engine/tool crash (the tool never even produced a
  // result to evaluate) from a genuine content-level block (the tool ran
  // fine, but the phase's own completion criteria weren't met — e.g. an
  // unmerged PR, an unresolved branch, or a fixed-point zero-commits case).
  // Flips to false the instant any attempt's runner() call succeeds, even if
  // that attempt's detectOutcome() itself reports failure.
  let allAttemptsThrew = true;
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
      //
      // forge#2259: a non-zero exit from the nested `claude` CLI
      // (bin/runner.mjs's runCliBackend(), which sets err.code =
      // "CLI_BACKEND_FAILED" on any non-zero `result.status`) is likewise
      // not a transient phase failure — same argv/cwd/session state
      // reproduces the identical crash on every attempt. Retrying it
      // `maxAttempts` times burns the entire retry budget (observed live in
      // #2244: 3 nested-CLI invocations, zero PRs/commits) on a failure that
      // was never going to succeed. Fail fast instead, mirroring the
      // NO_API_KEY/NO_SDK precedent (commit 570cb10 / #2054 established this
      // exact dispatch pattern for INVALID_BACKEND). This does not assume
      // *why* the CLI exited 1 (the quota/session-limit theory in #2244 is
      // unproven) — a deterministic tool crash should not be retried as if
      // transient regardless of its root cause.
      if (e.code === "NO_API_KEY" || e.code === "NO_SDK" || e.code === "CLI_BACKEND_FAILED") throw e;
      appendEvent(dir, issue, { event: "PHASE_FAILED", phase: phase.id, attempt, reason: e.message, maxAttempts });
      continue;
    }
    allAttemptsThrew = false;
    const outcome = await phase.detectOutcome(state, io);
    if (outcome.status === "committed" || outcome.status === "blocked") return outcome;
    appendEvent(dir, issue, { event: "PHASE_FAILED", phase: phase.id, attempt, reason: outcome.detail, maxAttempts });
    // forge#2176: a phase's detectOutcome can mark a failure as a known,
    // state-derived fixed point — re-running the phase's runner is
    // guaranteed to reproduce the identical failure (e.g. the build phase's
    // builder already completed and will no-op on any re-invocation, per
    // commands/work-on/build.md's own `BUILD_RESULT: status: ALREADY_DONE`
    // early-exit). Honor that signal by stopping immediately rather than
    // burning the remaining attempt budget on a guaranteed-identical result.
    // Absent/undefined `retryable` defaults to retryable (existing behavior
    // for every phase that doesn't opt in — investigate/context/architect/
    // review/close — is unchanged, preserving transient-failure retries).
    if (outcome.retryable === false) {
      return { status: "blocked", detail: outcome.detail };
    }
  }
  // Exhausted transient retries → escalate (spec §7).
  // forge#2261: if the runner itself threw on every single attempt (it never
  // once produced a result for detectOutcome() to evaluate), this is an
  // engine/tool failure, not a content-level judgment call — tag the outcome
  // so runIssue()'s terminate() writes a distinct label instead of
  // needs-human. If at least one attempt reached detectOutcome() (the tool
  // ran, the phase just isn't done), this stays the existing untagged shape,
  // which runIssue() defaults to "needs-human" — unchanged behavior for every
  // genuine content-level block (unmerged PR, unresolved branch, a transient
  // git error inside commitsAhead(), etc.).
  if (allAttemptsThrew) {
    return {
      status: "blocked",
      detail: `phase ${phase.id} failed after ${maxAttempts} attempts (runner threw every attempt)`,
      reason: "engine-error",
    };
  }
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
