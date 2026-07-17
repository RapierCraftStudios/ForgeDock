/**
 * Durable per-phase engine loop. Drives one pipeline phase at a time via an
 * injected runner (runCommand-shaped), determining each phase's outcome from
 * GitHub state (phase.detectOutcome). All effects are injected → fully testable.
 */
import { fileURLToPath } from "node:url";
import { appendEvent, readLog, deriveState, rewriteLog } from "./engine/runlog.mjs";
import { pickPhase, TERMINAL_REASONS, issueSnapshot } from "./engine/phases.mjs";
import { reconcileState } from "./engine/reconcile.mjs";
import { makeProjector } from "./engine/projector.mjs";
import { VALID_BACKENDS } from "./runner.mjs";

// Exported (forge#2175) so bin/engine-cli.mjs can render "failed N/M attempts"
// diagnostics without duplicating the retry budget constant.
export const DEFAULT_MAX_ATTEMPTS = 3;

// forge#2239: lease TTL and renewal-interval defaults. Exported/overridable
// (mirrors DEFAULT_MAX_ATTEMPTS) so tests can exercise "phase outlives the
// TTL, lease gets renewed" without waiting on real 10-minute wall-clock time.
export const DEFAULT_LEASE_TTL_MS = 600000;
export const DEFAULT_LEASE_RENEW_INTERVAL_MS = 240000;

/**
 * Validates the subset of `runIssue()`'s options that must fail fast,
 * synchronously, before any state I/O or timer creation — `backend` and the
 * lease-timing pair. Extracted from `runIssue()` (forge#2452) purely for
 * readability; call-order and thrown-error shape are unchanged from the
 * inline block this replaces, and MUST stay that way — see the per-check
 * rationale comments below, all of which trace back to real review findings.
 *
 * @param {object} params
 * @param {string} [params.backend] - "cli" | "api" | "auto" (forge#2028).
 * @param {number} params.leaseTtlMs - forge#2239: how long a claimed lease is valid for.
 * @param {number} params.leaseRenewIntervalMs - forge#2239: how often the lease is re-written.
 * @throws {Error & {code: "INVALID_BACKEND"|"INVALID_LEASE_CONFIG"}}
 */
function validateRunIssueOptions({ backend, leaseTtlMs, leaseRenewIntervalMs }) {
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

  // forge#2313: validate the lease-timing relationship before anything else —
  // same placement/rationale as the INVALID_BACKEND check above (before state
  // is read/written, before the phase loop begins). `leaseTtlMs` controls how
  // long a claimed lease is valid for; `leaseRenewIntervalMs` controls how
  // often the in-flight heartbeat (forge#2239) re-writes it. If the renew
  // interval is >= the TTL, the first renewal tick fires at or after the
  // moment the previously-written lease already expired — reopening the exact
  // "phase outlives its lease" gap #2239 closed, because a genuinely-alive
  // run would publish (or be caught holding) an expired `lease.until` in that
  // window, which both the I3 concurrency guard above and the stall-recovery
  // scanner (commands/orchestrate/phase-3-dependency.md) read directly. Both
  // parameters are overridable-for-tests options with no current production
  // caller forwarding them (bin/engine-cli.mjs's runFromCli() only forwards
  // `backend`/`model`), so this only guards a future caller/config typo —
  // reject rather than silently clamp, matching INVALID_BACKEND's precedent.
  //
  // forge#2329: guard for finite numbers BEFORE the relational check below.
  // Every relational comparison against NaN evaluates to false in JS, so a
  // NaN in either parameter silently passes `leaseRenewIntervalMs >=
  // leaseTtlMs` (both `NaN >= x` and `x >= NaN` are false) — reopening the
  // exact gap this whole guard exists to close, just via a different bad
  // input. Infinity/-Infinity are "numbers" per `typeof` but are equally
  // nonsensical as a lease duration/interval and are not reliably caught by
  // the relational check either. Non-number types (strings, null, objects)
  // are coerced by `>=` instead of rejected, which can silently poison
  // downstream arithmetic (`now() + leaseTtlMs`) with string concatenation
  // instead of numeric addition. Same placement precedent as the relational
  // check itself: synchronous, before any state I/O or timer creation, so it
  // cannot interact with the async lease-renewal heartbeat or the
  // crash-and-relaunch write-then-throw architecture (bin/tests/engine-crash.test.mjs).
  for (const [name, value] of [["leaseTtlMs", leaseTtlMs], ["leaseRenewIntervalMs", leaseRenewIntervalMs]]) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw Object.assign(
        new Error(
          `Invalid lease config: ${name} must be a finite number, got ${typeof value === "number" ? value : `${typeof value} (${JSON.stringify(value)})`}.`,
        ),
        { code: "INVALID_LEASE_CONFIG" },
      );
    }
  }
  if (leaseRenewIntervalMs >= leaseTtlMs) {
    throw Object.assign(
      new Error(
        `Invalid lease config: leaseRenewIntervalMs (${leaseRenewIntervalMs}) must be less than leaseTtlMs (${leaseTtlMs}), or a live run's lease can expire before the next renewal.`,
      ),
      { code: "INVALID_LEASE_CONFIG" },
    );
  }
}

/**
 * Builds the defensive `emitProgress` wrapper around a caller-supplied
 * `onProgress` observer. Extracted from `runIssue()` (forge#2452) — purely a
 * factory, no shared state beyond the `onProgress` closure itself, so this
 * carries no behavioral risk.
 *
 * forge#2240: a caller's onProgress must never be able to crash an otherwise
 * healthy run. A plain try/catch only guards a *synchronous* throw — if
 * onProgress is (or becomes) async and its returned promise rejects, that
 * rejection is never awaited/caught here, producing an unhandled promise
 * rejection that terminates the whole Node process (Node >=15 default
 * behavior) well after runIssue() itself has already resolved. That is
 * strictly worse than the silent-hang bug this issue fixes. Detect a
 * thenable return value and attach a no-op .catch() to it (fire-and-forget —
 * onProgress is not awaited either way, consistent with its documented
 * synchronous-observer contract) so a rejection can never escape as
 * unhandled. (review finding, #2240)
 *
 * @param {(event: {event: string, phase: string, status?: string, detail?: string}) => void} onProgress
 * @returns {(event: object) => void}
 */
function makeProgressEmitter(onProgress) {
  return (event) => {
    try {
      const result = onProgress(event);
      if (result && typeof result.then === "function") {
        result.catch(() => { /* best-effort observer, never fatal */ });
      }
    } catch { /* best-effort observer, never fatal */ }
  };
}

/**
 * @param {object} opts
 * @param {string} [opts.backend] - "cli" | "api" | "auto" (forge#2028). Forwarded
 *   to every phase's `runner()` call when supplied. Omit to keep runner.mjs's own
 *   default ("auto" ladder — probes the `claude` CLI, falls back to the API).
 *   An invalid value throws synchronously (see below) rather than being forwarded.
 * @param {string} [opts.model] - Model id (forge#2028). Forwarded to every phase's
 *   `runner()` call when supplied; only applies on the "api" backend. Omit to keep
 *   runner.mjs's default (`FORGEDOCK_MODEL` env or its built-in default).
 * @param {number} [opts.leaseTtlMs] - forge#2239: how long a claimed lease is
 *   valid for. Defaults to DEFAULT_LEASE_TTL_MS. Overridable for tests.
 * @param {number} [opts.leaseRenewIntervalMs] - forge#2239: how often the lease
 *   is re-written while an unsatisfied phase's runner is executing. Defaults to
 *   DEFAULT_LEASE_RENEW_INTERVAL_MS. Overridable for tests.
 * @param {(event: {event: string, phase: string, status?: string, detail?: string}) => void} [opts.onProgress] -
 *   forge#2240: optional phase-boundary observer. Called with
 *   `{event: "phase_enter", phase}` right before a phase's runner is about to
 *   execute (i.e. the phase was NOT already satisfied on reconcile), and with
 *   `{event: "phase_exit", phase, status: "committed"|"blocked", detail?}`
 *   once that phase's outcome is known. Defaults to a no-op so every existing
 *   caller/test is unaffected. Deliberately engine.mjs's ONLY new surface for
 *   this issue — no `console.log`/stdout write is added here; printing is the
 *   CLI layer's job (bin/engine-cli.mjs), preserving the io-injection/testability
 *   convention this module already follows. Invocations are wrapped so a
 *   throwing callback can never crash a run.
 */
export async function runIssue(opts) {
  const { issue, dir, agentId, lane = "staging", io, runner,
          now = () => Date.now(), maxAttempts = DEFAULT_MAX_ATTEMPTS,
          commandsDir = fileURLToPath(new URL("../commands", import.meta.url)),
          // Optional execution-backend override for every phase's `runner()`
          // call (forge#2028 / MAT-3). Left undefined by default so existing
          // callers keep runner.mjs's own "auto" ladder default unchanged —
          // this is purely additive pass-through, not a new default.
          backend, model,
          leaseTtlMs = DEFAULT_LEASE_TTL_MS,
          leaseRenewIntervalMs = DEFAULT_LEASE_RENEW_INTERVAL_MS,
          onProgress = () => {} } = opts;

  // forge#2452: extracted into makeProgressEmitter() — see its docstring for
  // the forge#2240 rationale this wrapper implements.
  const emitProgress = makeProgressEmitter(onProgress);

  // forge#2452: extracted into validateRunIssueOptions() — see its docstring
  // for the forge#2054/#2313/#2329 rationale and required call-order (before
  // any state I/O or timer creation, unchanged from the inline block this
  // replaces).
  validateRunIssueOptions({ backend, leaseTtlMs, leaseRenewIntervalMs });

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
  } else if (action === "hydrate") {
    // GitHub is ahead of (or the only source of) local state. Rebuild the
    // local run-log to match the remote compact index so downstream
    // `deriveState(readLog(...))` calls stay consistent — otherwise the
    // post-commit re-derive below would fold over an empty/stale local log
    // and regress committed/issue/v (C2).
    rewriteLog(dir, issue, eventsFromIndex(state));
    state = deriveState(readLog(dir, issue));
  }
  // forge#2239: claim the lease unconditionally here — before the phase loop
  // starts, for EVERY reconcile action ("fresh", "remirror", "hydrate", and
  // "local"). Previously only "fresh"/"remirror"/"hydrate" wrote any state at
  // all at this point, and none of them claimed a real (non-null) lease — the
  // lease was only ever written retroactively after a phase's PHASE_COMMIT
  // (see the write inside the loop below), leaving the entire first phase
  // (and, for the "local" action, every phase before the first commit)
  // publishing lease:null. That is indistinguishable from a dead run to both
  // the I3 concurrency guard above and the stall-recovery scan in
  // commands/orchestrate/phase-3-dependency.md. This write MUST stay after the I3 guard
  // check above (commit 541a3e5 fixed the reverse ordering as a real bug —
  // do not reintroduce it).
  await projector.writeState(issue, { ...state, lease: { by: agentId, until: now() + leaseTtlMs } });

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
    // forge#2352: state-vs-GitHub divergence guard. Every phase's own
    // `entryCondition` only ever checked `state.committed` (local run-log
    // progress) — never the issue's live GitHub state/labels — so a phase
    // could run to completion against an issue that was independently closed
    // (e.g. by a human, or by the investigate phase's own marker path) or
    // labeled `workflow:invalid`/`needs-human` after this run's local state
    // was last derived. `close` is deliberately exempt: it is the one phase
    // whose entire job IS to read and act on this exact state (see its
    // reconcile/detectOutcome in bin/engine/phases.mjs), so guarding it here
    // would be redundant and could race with its own read of the same data.
    //
    // Cost: one extra `gh issue view` per loop iteration (skipped only for
    // `close`, which already pays this cost itself) — bounded by the phase
    // count (currently 6), not the retry budget inside a single phase.
    //
    // Fail-open on a snapshot error (`!snap.ok`): a transient `gh`/network
    // failure here must not block a healthy run any more than the identical
    // fail-open behavior in `close`'s own `reconcile` (bin/engine/phases.mjs)
    // or the `reconcile` try/catch just below in this same loop.
    if (phase.id !== "close") {
      let snap;
      try {
        snap = await issueSnapshot(issue, io);
      } catch {
        snap = { ok: false, state: null, labels: [] };
      }
      if (snap.ok) {
        // `workflow:invalid`, or CLOSED without `workflow:merged`, means the
        // issue is dead — nothing a further phase does can be consequential.
        // Reuses the existing "invalid" terminal reason (TERMINAL_REASONS)
        // rather than inventing a new one; #2353 makes the same choice for
        // `close`'s own CLOSED-not-merged case.
        const isDead = snap.labels.includes("workflow:invalid") ||
          (snap.state === "CLOSED" && !snap.labels.includes("workflow:merged"));
        if (isDead) {
          const detail = `issue ${issue} is ${snap.state === "CLOSED" ? "closed" : "open"} ` +
            `with divergent state before phase ${phase.id} (labels: ${snap.labels.join(", ") || "none"})`;
          return await terminate(state, "invalid", detail);
        }
        // `needs-human` is a PAUSE, not a death sentence — a human may still
        // resolve it, and /orchestrate's classify_predecessor_state() already
        // treats this label as GATED (not FAILED), so terminating here with
        // the same reason composes with that existing contract instead of
        // conflating "paused pending a human" with "dead". Deliberately does
        // NOT check `workflow:invalid`/CLOSED here — those are handled above.
        if (snap.labels.includes("needs-human")) {
          const detail = `issue ${issue} carries needs-human — pausing before phase ${phase.id}`;
          return await terminate(state, "needs-human", detail);
        }
      }
    }
    // forge#2321: tracks whether `phase_enter` was actually emitted for this
    // loop iteration. Re-declared `false` on every iteration (never hoisted
    // above the loop) so a reconcile-satisfied phase can never inherit a
    // stale `true` from a previous iteration's actually-run phase. Only the
    // committed-exit emission below needs this guard — the blocked-exit
    // emission is unreachable from the `reconciled.satisfied` branch, since
    // that branch always yields `status: "committed"` (see below), never
    // "blocked".
    let phaseEntered = false;
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
      // forge#2240: the phase is actually about to run (not a resume no-op)
      // — this is the one point in the loop where "entering phase X" is true.
      phaseEntered = true;
      emitProgress({ event: "phase_enter", phase: phase.id });
      // forge#2239: renew the lease immediately before running this phase's
      // runner, then keep renewing it on a heartbeat for as long as the
      // runner is in flight. A single phase can legitimately run longer than
      // leaseTtlMs — without renewal, a healthy, still-running phase would
      // eventually publish an *expired* (not just null) lease and get reaped
      // by stall recovery even though the run is fine. The interval is
      // `.unref()`'d so it can never keep the process alive on its own, and
      // is always cleared in `finally` so it cannot outlive this phase's
      // execution — covers the committed path, the blocked path, and the
      // engine-error fail-fast throw caught just below.
      await projector.writeState(issue, { ...state, lease: { by: agentId, until: now() + leaseTtlMs } });
      // forge#2239 (review finding): `projector.writeState` is a plain
      // read-body/edit-body round trip with no CAS — whichever `gh issue
      // edit` call actually lands last on GitHub wins, regardless of dispatch
      // order. A fire-and-forget renewal write left in flight when this
      // phase finishes could land AFTER the post-commit write or even after
      // terminate()'s `lease: null` write, resurrecting a phantom lease on an
      // already-terminated run. Track the most recently dispatched renewal's
      // promise and await it in `finally` (below) before letting the loop
      // proceed — this guarantees no renewal write is still in flight when
      // control moves on to the next write (commit or terminate).
      // forge#2348 (review finding): the above join-tracking scheme only
      // ever holds ONE promise in `pendingRenewal` — it protects against a
      // single in-flight write landing late, but has no backpressure against
      // a SECOND renewal tick firing while the first write is still in
      // flight (write round trip > leaseRenewIntervalMs). Without a guard,
      // `pendingRenewal` would simply be overwritten with the newer write's
      // promise, silently orphaning the earlier one from every join point
      // (both this closure's own `finally` below and the #2338 catch-path
      // join) — the earlier write could then land on GitHub after a later
      // write, or after the terminate()/commit write joins only the latest
      // promise and proceeds. Guarding here so at most one renewal write is
      // ever in flight keeps the existing single-variable join points
      // correct and sufficient: skip this tick entirely if a previous
      // renewal write hasn't settled yet, and clear `pendingRenewal` back to
      // null once it does (success or failure) so the guard never
      // permanently wedges future renewals.
      let pendingRenewal = null;
      const renewLease = () => {
        if (pendingRenewal) return;
        pendingRenewal = projector.writeState(issue, { ...state, lease: { by: agentId, until: now() + leaseTtlMs } }).catch(() => {
          // Best-effort: a transient renewal failure must not crash the run.
          // The next scheduled renewal (or the post-commit write) will retry.
        }).finally(() => {
          pendingRenewal = null;
        });
      };
      const renewTimer = setInterval(renewLease, leaseRenewIntervalMs);
      if (typeof renewTimer.unref === "function") renewTimer.unref();
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
          // forge#2241: when the runner attached a session-limit reset time
          // (bin/runner.mjs's extractSessionLimitResetTime(), only ever set
          // for a genuine session-limit CLI_BACKEND_FAILED — never
          // fabricated), append it so the terminal state is legible without
          // reading raw logs. Purely additive: the base detail string is
          // unchanged, and this appends nothing when e.resetAt is absent.
          const resetSuffix = e.resetAt ? ` (resets: ${e.resetAt})` : "";
          const detail = `phase ${phase.id}: ${e.code} - ${e.message}${resetSuffix}`;
          // forge#2240 (review finding): this fail-fast path previously left
          // phase_exit unreported — a caller tailing progress output would see
          // "→ phase X started" and then nothing, dangling exactly on the
          // phase that actually failed. Report it as blocked before
          // terminating so the progress trail stays complete on this path too.
          emitProgress({ event: "phase_exit", phase: phase.id, status: "blocked", detail });
          // forge#2338 (review finding): `return await terminate(...)` here
          // sits INSIDE this catch block, so per try/catch/finally semantics
          // its expression is fully evaluated — including terminate()'s own
          // `lease: null` write completing — BEFORE the `finally` block below
          // ever runs `clearInterval`/`await pendingRenewal`. A renewal write
          // already dispatched before this throw can therefore land on
          // GitHub AFTER terminate()'s `lease: null` write, resurrecting a
          // phantom lease on an already-terminated run — reopening the exact
          // race #2239 was written to close, just on this one call site the
          // #2239 fix (07b3b8a) didn't cover. Explicitly join here, before
          // calling terminate(), rather than relying on `finally` (too
          // late). The `finally` block's identical calls remain below as a
          // harmless idempotent safety net for the `throw e;` path.
          clearInterval(renewTimer);
          if (pendingRenewal) await pendingRenewal;
          return await terminate(state, "engine-error", detail);
        }
        throw e;
      } finally {
        clearInterval(renewTimer);
        // Join any renewal write already dispatched before this phase's
        // outcome is allowed to reach a commit/terminate write — closes the
        // TOCTOU window above. `pendingRenewal` already swallows its own
        // rejection (see renewLease()), so this await never throws.
        if (pendingRenewal) await pendingRenewal;
      }
    }

    if (outcome.status === "blocked") {
      emitProgress({ event: "phase_exit", phase: phase.id, status: "blocked", detail: outcome.detail });
      return await terminate(state, outcome.reason || "needs-human", outcome.detail);
    }

    // committed
    // forge#2321: only report a phase_exit if a matching phase_enter was
    // actually emitted for this phase this iteration. A reconcile-satisfied
    // phase (short-circuited above without ever entering the `else` branch)
    // never "started" this run — emitting phase_exit for it produced a
    // dangling exit with no preceding enter (bin/engine-cli.mjs prints
    // "✓ phase X committed" with no prior "→ phase X started" line).
    // Suppressing the unmatched exit is correct here rather than fabricating
    // a synthetic phase_enter, since the phase's runner genuinely never ran.
    if (phaseEntered) emitProgress({ event: "phase_exit", phase: phase.id, status: "committed" });
    // forge#2377: `outcome.usage` is populated by runPhaseWithRetry() below
    // from the injected runner()'s (== bin/runner.mjs's runCommand()) return
    // value — null when the backend doesn't report usage (CLI backend today)
    // or when detectOutcome() never ran (this call site is only reached on
    // the "committed" path, so that case doesn't apply here). Kept as a
    // sibling of `outputs` rather than nested inside it, since `outputs` is
    // owned by phase.detectOutcome() (bin/engine/phases.mjs).
    appendEvent(dir, issue, { event: "PHASE_COMMIT", phase: phase.id, outputs: outcome.outputs || {}, usage: outcome.usage ?? null });
    state = deriveState(readLog(dir, issue));
    if (outcome.terminalReason) state.terminalReason = outcome.terminalReason;
    await projector.writeState(issue, { ...state, lease: { by: agentId, until: now() + leaseTtlMs } });

    // forge#2379: the "investigate" phase reporting terminalReason "decomposed"
    // is a HANDOFF to the "decompose" phase (bin/engine/phases.mjs), not a
    // dead end — decompose is what actually dispatches work-on/decompose
    // (sub-issue fan-out, FORGE:DECOMPOSED posting). Before this change,
    // "decomposed" being a member of TERMINAL_REASONS meant the run
    // terminated the instant investigate reported it, and decompose's own
    // entryCondition (state.terminalReason === "decomposed") was never
    // actually reachable through pickPhase. Narrowly exempting exactly this
    // phase/reason combination — and no other phase, no other reason — lets
    // the loop continue to pickPhase, which now correctly selects "decompose"
    // next (investigate.isTerminalAfter was narrowed to only "invalid" in
    // the same change, so it no longer independently forces termination
    // here either). Once the "decompose" phase itself later reports
    // terminalReason "decomposed" (re-affirming it after FORGE:DECOMPOSED:COMPLETE
    // is seen), phase.id is "decompose" — not "investigate" — so this
    // exemption does not apply and the normal terminate() path below fires,
    // ending the run for real.
    const isDecomposeHandoff = phase.id === "investigate" && outcome.terminalReason === "decomposed";
    if (outcome.terminalReason && TERMINAL_REASONS.includes(outcome.terminalReason) && !isDecomposeHandoff)
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
  // forge#2377: the last successful attempt's `usage` (from runner()'s ==
  // runCommand()'s resolved value — {input_tokens, output_tokens,
  // cache_creation_input_tokens, cache_read_input_tokens} on the API
  // backend, or null on the CLI backend / when the field is absent). Reset
  // is unnecessary since a thrown attempt never reaches the assignment
  // below — `lastUsage` simply stays whatever the previous successful
  // attempt (if any) set it to, which is correct: it always reflects the
  // most recent attempt that actually produced a result.
  let lastUsage = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    appendEvent(dir, issue, { event: "PHASE_START", phase: phase.id, attempt });
    let result;
    try {
      result = await runner({
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
      // forge#2377: no `usage` field here — the runner threw, so no result
      // (and therefore no usage data) was ever produced for this attempt.
      // Do not fabricate a value; omitting the field (rather than a stale
      // `lastUsage` from a prior attempt) keeps this event's usage
      // trustworthy as "usage actually observed on this attempt".
      appendEvent(dir, issue, { event: "PHASE_FAILED", phase: phase.id, attempt, reason: e.message, maxAttempts });
      continue;
    }
    allAttemptsThrew = false;
    lastUsage = result?.usage ?? null;
    const outcome = await phase.detectOutcome(state, io);
    if (outcome.status === "committed" || outcome.status === "blocked") return { ...outcome, usage: lastUsage };
    appendEvent(dir, issue, { event: "PHASE_FAILED", phase: phase.id, attempt, reason: outcome.detail, maxAttempts, usage: lastUsage });
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
      return { status: "blocked", detail: outcome.detail, usage: lastUsage };
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
      usage: null,
    };
  }
  return { status: "blocked", detail: `phase ${phase.id} failed after ${maxAttempts} attempts`, usage: lastUsage };
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
