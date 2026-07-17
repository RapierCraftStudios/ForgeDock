/**
 * Durable per-phase engine loop. Drives one pipeline phase at a time via an
 * injected runner (runCommand-shaped), determining each phase's outcome from
 * GitHub state (phase.detectOutcome). All effects are injected → fully testable.
 */
import { fileURLToPath } from "node:url";
import { appendEvent, readLog, deriveState, rewriteLog } from "./engine/runlog.mjs";
import { pickPhase, TERMINAL_REASONS, issueSnapshot, issueMarkers, PHASES } from "./engine/phases.mjs";
import { reconcileState } from "./engine/reconcile.mjs";
import { makeProjector } from "./engine/projector.mjs";
import { VALID_BACKENDS } from "./runner.mjs";
import { buildContextPack } from "./engine/context-pack.mjs";

// Exported (forge#2175) so bin/engine-cli.mjs can render "failed N/M attempts"
// diagnostics without duplicating the retry budget constant.
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * forge#2382: engine-issued `workflow:*` label transitions — an in-process
 * port of scripts/transition-label.sh's state machine (see
 * bin/engine/projector.mjs's `setWorkflowLabel`, which this calls; that
 * method is the shared add-target/remove-stale/clear-needs-human-on-
 * awaiting-merge logic transition-label.sh implements as a standalone
 * script). Maps a just-committed phase id to the `workflow:*` label
 * representing the NEXT stage the run is entering, mirroring
 * commands/work-on.md's own label-transition points (Phase 1D
 * `ready-to-build`, Phase 3D `building`) so an engine-driven run reaches the
 * identical label sequence an LLM-driven run would — deterministically, and
 * without depending on any phase spec's own `gh issue edit` prose firing
 * correctly.
 *
 * "review" is intentionally absent: `workflow:in-review` is conditional on a
 * PR actually existing (adopted OR created), not on the `build` phase merely
 * committing — the `review` phase's own `reconcile` (bin/engine/phases.mjs,
 * forge#2382) issues that transition itself once a PR is resolved. "close" is
 * likewise absent — `close.execute()` (forge#2381) already sets
 * `workflow:merged` directly. "investigate" maps to `ready-to-build` and
 * "architect" maps to `building` (the last phase to commit before the `build`
 * phase itself dispatches, matching work-on.md Phase 3D's placement — right
 * before the actual build work begins). "decompose"/"remediate" are absent:
 * both are branch phases whose own LLM-authored specs (work-on/decompose.md,
 * work-on/remediate.md Phase M8) own their terminal-state labeling already.
 *
 * Illegal transitions are impossible by construction: this map is only ever
 * consulted with the fixed `phase.id` of whatever phase just committed in
 * THIS iteration of the loop below, each id appears at most once as a key,
 * and `setWorkflowLabel` itself throws on any value outside its own
 * canonical state list — there is no code path that can request an
 * unrecognized `workflow:*` label through this mechanism.
 */
const WORKFLOW_LABEL_AFTER_COMMIT = {
  investigate: "ready-to-build",
  architect: "building",
};

// forge#2239: lease TTL and renewal-interval defaults. Exported/overridable
// (mirrors DEFAULT_MAX_ATTEMPTS) so tests can exercise "phase outlives the
// TTL, lease gets renewed" without waiting on real 10-minute wall-clock time.
export const DEFAULT_LEASE_TTL_MS = 600000;
export const DEFAULT_LEASE_RENEW_INTERVAL_MS = 240000;

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

  // forge#2240: defensive wrapper — a caller's onProgress must never be able
  // to crash an otherwise-healthy run. A plain try/catch only guards a
  // *synchronous* throw — if onProgress is (or becomes) async and its
  // returned promise rejects, that rejection is never awaited/caught here,
  // producing an unhandled promise rejection that terminates the whole
  // Node process (Node >=15 default behavior) well after runIssue() itself
  // has already resolved. That is strictly worse than the silent-hang bug
  // this issue fixes. Detect a thenable return value and attach a no-op
  // .catch() to it (fire-and-forget — onProgress is not awaited either way,
  // consistent with its documented synchronous-observer contract) so a
  // rejection can never escape as unhandled. (review finding, #2240)
  const emitProgress = (event) => {
    try {
      const result = onProgress(event);
      if (result && typeof result.then === "function") {
        result.catch(() => { /* best-effort observer, never fatal */ });
      }
    } catch { /* best-effort observer, never fatal */ }
  };

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
      // forge#2382: engine-owned worktree lifecycle, before dispatching ANY
      // phase whose runner needs the build's worktree on disk — see
      // ensureWorktreeForBuild()'s own doc comment for why this is scoped to
      // `state.branch` already being known rather than to `phase.id ===
      // "build"` specifically. `state.branch` is set exactly once, by the
      // "build" phase's own PHASE_COMMIT — so on the very iteration "build"
      // itself is about to dispatch, `state.branch` is still null (a
      // first-time build owns its own initial worktree/branch creation, and
      // this call is correctly a no-op there). The case this DOES catch: a
      // later phase in the SAME lineage (review, remediate) dispatching
      // after a resume/hydrate where the worktree directory was lost
      // out-of-band between sessions but the branch survived — those phase
      // specs `cd {WORKTREE_PATH}` and would otherwise fail outright instead
      // of getting the re-attach commands/work-on/build.md's own worktree
      // logic (Phase B1C) would have performed had IT been the one resuming.
      if (state.branch) {
        try { await ensureWorktreeForBuild(state, io); } catch { /* best-effort — the phase's own runner is the fallback */ }
      }
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
        // forge#2381: engine-native phases (those declaring `execute` — see
        // the `close` entry in bin/engine/phases.mjs) skip runner()/the LLM
        // subagent entirely. runExecutePhase() normalizes execute()'s return
        // to the exact same {status, outputs, terminalReason?, usage} shape
        // runPhaseWithRetry() returns, so every downstream branch (commit,
        // blocked, terminate, PHASE_COMMIT emission below) needs no
        // execute()-specific special-casing beyond this one dispatch check.
        outcome = phase.execute
          ? await runExecutePhase(phase, state, io, dir)
          : await runPhaseWithRetry(phase, state, { io, runner, dir, issue, commandsDir, maxAttempts, backend, model });
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
    // forge#2381: `engineNative` distinguishes a PHASE_COMMIT produced by
    // phase.execute() (zero LLM tokens) from the default runner()/LLM path —
    // additive-only field; bin/engine/runlog.mjs's deriveState()/eventsFromIndex()
    // pass unrecognized event fields through untouched, so every existing
    // consumer of PHASE_COMMIT events is unaffected by its presence/absence.
    appendEvent(dir, issue, { event: "PHASE_COMMIT", phase: phase.id, outputs: outcome.outputs || {}, usage: outcome.usage ?? null, engineNative: !!phase.execute });
    state = deriveState(readLog(dir, issue));
    if (outcome.terminalReason) state.terminalReason = outcome.terminalReason;
    await projector.writeState(issue, { ...state, lease: { by: agentId, until: now() + leaseTtlMs } });

    // forge#2382: engine-issued workflow:* label transition for this commit —
    // see WORKFLOW_LABEL_AFTER_COMMIT's doc comment above. Deliberately
    // scoped to forward-progress commits only: a terminal outcome on this
    // same phase (investigate reporting "invalid"/"decomposed") must NOT
    // also get stamped with the forward-progress label on its way out — that
    // phase's own terminal path (invalid via investigate.md itself; decomposed
    // via the handoff to the "decompose" phase) owns the label in that case.
    if (!outcome.terminalReason) {
      const nextLabel = WORKFLOW_LABEL_AFTER_COMMIT[phase.id];
      if (nextLabel) {
        try { await projector.setWorkflowLabel(issue, nextLabel); } catch { /* best-effort — a label-transition failure must not crash a healthy run */ }
      }
    }

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
    // forge#2382: prune the worktree/branch once the run reaches a genuinely
    // final state with no further branch-based work possible — see
    // cleanupWorktreeAfterTerminal()'s own doc comment for the full
    // rationale. Deliberately scoped to "merged" only: needs-human/
    // engine-error/awaiting-merge keep the branch/worktree alive on purpose
    // (a human, or a future `--remediate` run, may still need it).
    // "invalid"/"decomposed" never have a branch to clean up in the first
    // place (state.branch is only ever set once the build phase commits,
    // which cannot happen before either of those reasons is reached) — this
    // is enforced by cleanupWorktreeAfterTerminal's own `!s.branch` guard,
    // not by narrowing this call site further, so no branch/worktree state
    // is ever silently destroyed on a path a human might still need.
    if (reason === "merged") {
      try { await cleanupWorktreeAfterTerminal(final, io); } catch { /* best-effort — never mask the real terminal reason being returned */ }
    }
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

/**
 * forge#2382: engine-owned worktree lifecycle — an in-process port of
 * scripts/worktree-lifecycle.sh's `ensure`/`cleanup` subcommands (ported
 * rather than shelled out, matching how the label state machine above was
 * ported into bin/engine/projector.mjs — same rationale: "reusing ... logic
 * in-process" per this issue's own item 3 wording). Both operate purely
 * through the injected `io.git` — no direct filesystem access beyond what
 * `git worktree`/`git branch` themselves touch, and no dependency on the
 * standalone script being present on disk.
 *
 * Unlike the standalone script, the branch name is not always known ahead of
 * the build phase's own runner() dispatch — commands/work-on/build.md's
 * Phase B1A derives it from the issue title via LLM judgment, and that
 * choice cannot be guessed here (see the pre-existing comment above this
 * file's phase loop, just above `let phase;`). `state.branch` is set exactly
 * once: by the "build" phase's own PHASE_COMMIT (bin/engine/phases.mjs's
 * `build.detectOutcome`), which means on the very iteration the "build" phase
 * ITSELF is about to dispatch, `state.branch` is still null — a first-time
 * build owns its own initial worktree/branch creation, and this function is
 * correctly a no-op there (see the `!state.branch` guard below).
 *
 * `ensureWorktreeForBuild` is therefore scoped to the case that IS knowable
 * ahead of a dispatch: a LATER phase in the same lineage — "review" or
 * "remediate" — about to run after `state.branch` is already resolved (a
 * resume/hydrate, or simply the very next loop iteration after "build"
 * commits), whose worktree directory has gone missing out-of-band (a lost
 * session, an unrelated `/cleanup` sweep). Those phase specs `cd
 * {WORKTREE_PATH}` for `git push`/etc. and would otherwise fail outright
 * instead of getting the exact re-attach commands/work-on/build.md's own
 * Phase B1C worktree logic performs for itself on a resumed build. Called
 * from the phase loop below (`if (state.branch) { ... }`) — not gated to
 * `phase.id === "build"` — for exactly this reason.
 *
 * @param {import("./engine/phases.mjs").RunState} state
 * @param {{gh: Function, git: Function}} io
 */
async function ensureWorktreeForBuild(state, io) {
  if (!state.branch) return; // nothing to ensure yet — first-time build owns its own creation
  const hasLocalBranch = await branchExistsLocally(state.branch, io);
  if (!hasLocalBranch) return; // branch doesn't exist yet either — nothing to re-attach
  const registeredPath = await worktreePathForBranch(state.branch, io);
  if (registeredPath) return; // already has a worktree registered — nothing to do
  // forge#2508: an out-of-band `rm -rf` of a worktree directory (instead of
  // `git worktree remove`/`prune`) leaves stale administrative metadata behind
  // that `git worktree list --porcelain` no longer reports (so the check
  // above sees no registered path) but that `git worktree add` can still
  // collide with. Best-effort/fail-open, matching every other git probe in
  // this file: a prune failure must never block the add attempt below.
  try {
    await io.git(["worktree", "prune"]);
  } catch { /* best-effort — proceed to the add attempt regardless */ }
  await io.git(["worktree", "add", "--", worktreeEnsureFallbackPath(state.issue), state.branch]);
}

/**
 * forge#2382: engine-native worktree cleanup — called from `terminate()`
 * above, scoped to `reason === "merged"` so a run that ends needs-human/
 * invalid/engine-error/awaiting-merge/decomposed never loses a branch a
 * human (or a future `--remediate` run) might still need. In-process port of
 * worktree-lifecycle.sh's `cleanup` subcommand, generalized to not require a
 * precomputed path: the actual worktree path is discovered from `git
 * worktree list` by matching `state.branch` (see `worktreePathForBranch`),
 * since — as documented on `ensureWorktreeForBuild` above — the engine never
 * learns the exact path the build runner chose for it.
 *
 * Both steps (worktree removal, branch deletion) are independently
 * best-effort/tolerant of an already-removed state, matching the standalone
 * script's own `|| true` tolerance.
 *
 * @param {import("./engine/phases.mjs").RunState} state
 * @param {{gh: Function, git: Function}} io
 */
async function cleanupWorktreeAfterTerminal(state, io) {
  if (!state.branch) return; // no build ever ran — nothing to clean up
  // forge#2506: defense-in-depth — `state.branch` is only ever engine/LLM-set
  // once, by the build phase's own PHASE_COMMIT, to a `fix/*-{issue}` or
  // `feat/*-{issue}` slug, so this guard has no known live trigger today. It
  // exists so this destructive cleanup never relies solely on git's own
  // implicit checked-out-branch protection if that assumption ever changes.
  if (isProtectedBranch(state.branch)) return;
  try {
    const path = await worktreePathForBranch(state.branch, io);
    if (path) await io.git(["worktree", "remove", path, "--force"]);
  } catch { /* best-effort — tolerate an already-removed worktree */ }
  try {
    await io.git(["branch", "-D", "--", state.branch]);
  } catch { /* best-effort — tolerate an already-deleted branch */ }
}

/**
 * forge#2506: `true` if `branch` is a protected branch name that
 * `cleanupWorktreeAfterTerminal` must never delete — the two known deploy
 * lanes (`main`, `staging`) and any `milestone/*` feature-lane branch.
 * @returns {boolean}
 */
function isProtectedBranch(branch) {
  return branch === "main" || branch === "staging" || branch.startsWith("milestone/");
}

/** @returns {Promise<boolean>} whether a local branch ref exists for `branch`. */
async function branchExistsLocally(branch, io) {
  try {
    await io.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the worktree path currently registered for `branch`, by scanning
 * `git worktree list --porcelain` for a `worktree <path>` line immediately
 * (within the same record) followed by a matching `branch refs/heads/<branch>`
 * line. Returns null if no worktree is registered for that branch (including
 * on any `git` failure — fail-open, consistent with every other best-effort
 * git probe in this file).
 * @returns {Promise<string|null>}
 */
async function worktreePathForBranch(branch, io) {
  let out;
  try {
    out = await io.git(["worktree", "list", "--porcelain"]);
  } catch {
    return null;
  }
  const ref = `refs/heads/${branch}`;
  let currentPath = null;
  for (const line of String(out || "").split("\n")) {
    if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ") && line.slice("branch ".length).trim() === ref) return currentPath;
  }
  return null;
}

/**
 * Deterministic, collision-safe fallback path for `ensureWorktreeForBuild`'s
 * re-attach. The build runner's own slug-derived path
 * (commands/work-on/build.md Phase B1A/B1C) is unknown here, so this
 * intentionally does NOT try to reproduce it — `git worktree add` only needs
 * A valid, currently-unused path, not the same one a prior run used.
 */
function worktreeEnsureFallbackPath(issue) {
  return `.claude/worktrees/engine-resume-${issue}`;
}

/**
 * forge#2381: dispatch for engine-native phases (those declaring `execute` —
 * e.g. `close` in bin/engine/phases.mjs). Runs the phase's own code directly,
 * with zero LLM/runner() invocation and no retry loop (execute() is plain
 * deterministic code, not a flaky external subagent — a thrown error here is
 * a genuine bug, not a transient failure worth retrying blindly). Normalizes
 * the return to the same {status, outputs, terminalReason?, usage} shape
 * runPhaseWithRetry() returns below, so the caller's downstream handling
 * (commit/blocked/terminate, PHASE_COMMIT emission) needs no special-casing
 * beyond the `phase.execute` dispatch check itself.
 */
async function runExecutePhase(phase, state, io, dir) {
  try {
    const result = await phase.execute(state, io, { dir });
    return { ...result, usage: result.usage ?? null };
  } catch (e) {
    return { status: "blocked", detail: `phase ${phase.id} execute() threw: ${e.message}`, usage: null };
  }
}

// forge#2383: per-phase context-pack byte budget passed to
// bin/engine/context-pack.mjs's buildContextPack(). Matches the 20-40KB
// range the parent issue itself proposed; picked the midpoint rather than
// the low or high end so a typical STANDARD-complexity issue's investigation
// + contract + a few annotations fits without truncation, while still
// leaving real headroom below the phase system prompt's own token budget.
const CONTEXT_PACK_BUDGET_BYTES = 32000;

/**
 * forge#2383: assemble this phase's deterministic context pack — issue
 * title/body, prior phases' typed outputs (from this run's own local
 * run-log), and recent FORGE annotations — before its runner() dispatch.
 *
 * Entirely best-effort/fail-open: every fetch below is independently
 * try/catch-wrapped, and a total failure (or simply nothing to report)
 * degrades to `buildContextPack({})`, which resolves to an empty pack
 * (`bytes: 0`, `sections: []`). `runPhaseWithRetry` below only forwards
 * `contextPack` to `runner()` when `pack.text` is non-empty, so a fully
 * failed/empty pack is IDENTICAL to this function never having been called
 * — no phase's correctness can depend on this pack (matches the parent
 * issue's own acceptance criteria).
 *
 * Deliberately called ONCE per phase dispatch (outside the attempt retry
 * loop in `runPhaseWithRetry`, not once per attempt) — a phase's context
 * does not meaningfully change between same-phase retry attempts a few
 * seconds apart, so re-fetching per attempt would just be the exact
 * redundant-round-trip tax this issue exists to reduce.
 *
 * Prior phase outputs are read from the LOCAL run-log (`readLog`), not
 * fetched over the network — this is the one piece of "engine already has
 * this data" reuse the parent issue's proposal specifically called out.
 * Issue title/body and recent FORGE annotations still cost one `gh` call
 * each (title/body is not part of `state`, and `issueMarkers()` — reused
 * from bin/engine/phases.mjs rather than duplicated — is invoked directly
 * here since `phase.reconcile()`'s own internal call is encapsulated per
 * phase and not surfaced back to this call site); both are bounded, one-shot
 * calls, not the N-calls-per-phase-spec pattern this issue is aimed at.
 *
 * @param {import("./engine/phases.mjs").RunState} state
 * @param {{gh: Function, git: Function}} io
 * @param {string} dir - run-log directory (for readLog)
 * @returns {Promise<{text: string, bytes: number, sections: string[], truncated: string[]}>}
 */
async function buildContextPackForPhase(state, io, dir) {
  const priorOutputs = {};
  try {
    for (const e of readLog(dir, state.issue)) {
      if (e.event === "PHASE_COMMIT" && e.outputs && Object.keys(e.outputs).length > 0) {
        priorOutputs[e.phase] = e.outputs;
      }
    }
  } catch { /* best-effort — an unreadable local run-log degrades to no prior-outputs section */ }

  let issue;
  try {
    const out = await io.gh(["issue", "view", String(state.issue), "--json", "title,body"]);
    const j = JSON.parse(out || "{}");
    issue = { number: state.issue, title: j.title || "", body: j.body || "" };
  } catch { /* best-effort — pack simply omits the issue section */ }

  // Relevant FORGE annotations: reuse the last 8 comments containing a
  // "<!-- FORGE:" marker. Capped (not just budget-truncated later) so a very
  // long-running issue's full comment history doesn't dominate every other
  // section before byte-truncation even gets a say.
  let annotations = [];
  try {
    const { comments } = await issueMarkers(state.issue, io);
    annotations = comments.filter((c) => typeof c === "string" && c.includes("<!-- FORGE:")).slice(-8);
  } catch { /* best-effort — pack simply omits the annotations section */ }

  return buildContextPack({ issue, priorOutputs, annotations }, { budgetBytes: CONTEXT_PACK_BUDGET_BYTES });
}

async function runPhaseWithRetry(phase, state, ctx) {
  const { io, runner, dir, issue, commandsDir, maxAttempts, backend, model } = ctx;

  // forge#2383: build once, reused across every retry attempt below (see
  // buildContextPackForPhase's own doc comment for why per-attempt rebuilding
  // would be wasteful). A thrown/failed build degrades to `contextPack: null`
  // — treated identically to the option never being supplied.
  let contextPack = null;
  try {
    contextPack = await buildContextPackForPhase(state, io, dir);
  } catch { contextPack = null; }

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
    // forge#2383: packBytes/packSections are additive fields — null when no
    // pack was built (or the pack came back empty), so a downstream
    // PHASE_START consumer that doesn't know about this feature yet sees
    // exactly what it saw before (extra unknown fields, safe to ignore).
    appendEvent(dir, issue, {
      event: "PHASE_START", phase: phase.id, attempt,
      packBytes: contextPack?.bytes ?? null,
      packSections: contextPack?.sections ?? null,
    });
    let result;
    try {
      result = await runner({
        commandsDir, commandName: phase.command, args: [String(issue)],
        // Only forwarded when explicitly provided — omitting them preserves
        // runner.mjs's existing default ("auto" backend / DEFAULT_MODEL).
        ...(backend ? { backend } : {}),
        ...(model ? { model } : {}),
        // forge#2383: only forwarded when the pack actually has content —
        // an empty/failed pack must produce the exact same runner() call
        // shape as today (no `contextPack` key at all), matching the
        // existing backend/model spread convention above.
        ...(contextPack?.text ? { contextPack: contextPack.text } : {}),
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
    // forge#2387: replay complexity the same way branch/pr are replayed —
    // idx.complexity round-trips through the compact FORGE:STATE index
    // automatically (state.mjs's serializeState/parseState are generic), but
    // deriveState() only restores it from a PHASE_COMMIT's outputs, so a
    // hydrate reconstruction must re-attach it to the phase that produced it.
    if (phase === "investigate" && idx.complexity) outputs.complexity = idx.complexity;
    // forge#2442: `engineNative` (forge#2381) isn't carried by the compact
    // FORGE:STATE index (`idx.committed` is a flat phase-id string[] — see
    // bin/engine/state.mjs), so it can't be replayed from idx directly. It's
    // derived on read instead: `engineNative` is a property of the phase
    // *definition* (does this phase id dispatch via `execute()`?), not of
    // any per-run data, so looking it up in the same static `PHASES` table
    // the live write path reads from (line ~425's `!!phase.execute`) is
    // exactly equivalent to what would have been persisted — with zero risk
    // of drift, since both paths share one source of truth. Deliberately
    // NOT persisted into the compact index itself (see bin/engine/state.mjs
    // — `committed` staying a flat string[] is relied on by 7+ call sites).
    const phaseDef = PHASES.find((p) => p.id === phase);
    events.push({ event: "PHASE_COMMIT", phase, outputs, engineNative: !!phaseDef?.execute });
  }
  if (idx.terminal) events.push({ event: "RUN_TERMINAL", reason: idx.terminalReason });
  return events;
}

function freshState(issue, lane) {
  // forge#2387: complexity: null matches runlog.mjs's deriveState() base shape —
  // both are hand-written RunState object literals with no shared factory, so
  // both must declare every field. See that file's own comment on this field.
  return { v: 0, run: `r_${issue}_${lane}`, issue, lane, committed: [], phase: null,
           branch: null, pr: null, terminal: false, terminalReason: null, lease: null,
           complexity: null };
}
