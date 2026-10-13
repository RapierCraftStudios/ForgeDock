/**
 * Append-only per-issue run-log (the crash-safe local hot path).
 * One JSON event per line at {dir}/{issue}.jsonl. seq is assigned monotonically.
 */
import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function logPath(dir, issue) { return join(dir, `${issue}.jsonl`); }

/** Append an event; assigns the next seq based on the current line count. */
export function appendEvent(dir, issue, event) {
  mkdirSync(dir, { recursive: true });
  const path = logPath(dir, issue);
  const seq = readLog(dir, issue).length + 1;
  // forge#3696: wall-clock ISO-8601 `ts` on every appended event. Placed before the
  // spread so a caller-supplied `ts` wins. rewriteLog() deliberately does not stamp:
  // a hydrated rewrite time would be a false timestamp. Old logs lack `ts` and still parse.
  appendFileSync(path, JSON.stringify({ seq, ts: new Date().toISOString(), ...event }) + "\n");
}

/**
 * Overwrite the local run-log with a fresh set of events (fresh seq each).
 * Used to reconstruct the local log from a remote FORGE:STATE index on
 * hydrate (C2), so the local log and the GitHub-wins state stay consistent.
 */
export function rewriteLog(dir, issue, events) {
  mkdirSync(dir, { recursive: true });
  const path = logPath(dir, issue);
  const lines = events.map((e, i) => JSON.stringify({ seq: i + 1, ...e }));
  writeFileSync(path, lines.length ? lines.join("\n") + "\n" : "");
}

/** Read all complete events; a truncated final line (crash mid-write) is ignored. */
export function readLog(dir, issue) {
  const path = logPath(dir, issue);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n");
  // Drop trailing empty lines to find the last non-empty line.
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      // Only tolerate parse failure on the final non-empty line (crash mid-write).
      if (i === lines.length - 1) {
        break; // Ignore truncated final line.
      }
      throw new Error(`corrupt run-log line ${i + 1} in ${path}`);
    }
  }
  return out;
}

/** Fold events into a RunState. The commit rule lives here. */
/**
 * #4109: the run log is shared by the full and the core path. Keep only the events of runs whose `path` (from RUN_START;
 * missing means "full", for historic logs) equals `path`, so one path never replays the other's commits or terminals.
 */
export function scopeEvents(events, path = "full") {
  let cur = "full";
  const out = [];
  for (const e of events) {
    if (e.event === "RUN_START") cur = e.path ?? "full";
    if (cur === path) out.push(e);
  }
  return out;
}

export function deriveState(allEvents, { path = "full" } = {}) {
  const events = scopeEvents(allEvents, path);
  /** @type {import("./phases.mjs").RunState} */
  const s = { v: 0, run: null, issue: null, lane: "staging", committed: [],
              phase: null, branch: null, pr: null, terminal: false,
              terminalReason: null, lease: null, lastRateLimit: null,
              remediationKind: null, outcomeCode: null };
  // forge#3833: outcome code of the LAST PHASE_COMMIT only (replaced, like lastCommitReason).
  let lastCommitCode = null;
  // forge#3528: handoff reason of the LAST PHASE_COMMIT only (replaced, not sticky).
  let lastCommitReason = null;
  // forge#3754: phase of the LAST PHASE_COMMIT, so a reopen can tell a remediate-terminal run.
  let lastCommitPhase = null;
  // forge#3772: reason of the LAST RUN_TERMINAL, so a reopen can tell a needs-human terminal
  // (label cleared by a human) from an engine-error retry.
  let lastTerminalReason = null;
  for (const e of events) {
    switch (e.event) {
      case "RUN_START":
        s.run = e.run ?? s.run; s.issue = e.issue ?? s.issue; s.lane = e.lane ?? s.lane;
        break;
      case "PHASE_COMMIT":
        if (!s.committed.includes(e.phase)) s.committed.push(e.phase);
        s.v = e.seq;
        if (e.outputs?.branch) s.branch = e.outputs.branch;
        if (e.outputs?.pr != null) s.pr = e.outputs.pr;
        // forge#3504: a blocked phase persists its reason so a resumed run still routes to
        // remediate instead of defaulting to a "merged" close.
        if (e.terminalReason) s.terminalReason = e.terminalReason;
        lastCommitReason = e.terminalReason ?? null;
        lastCommitCode = e.code ?? null;
        if (e.code) s.outcomeCode = e.code;
        lastCommitPhase = e.phase ?? null;
        // forge#3530: the review's remediation kind must survive resume. A later review
        // commit replaces it; a committed remediate consumes it, so it is never reused.
        if (e.phase === "review") s.remediationKind = e.outputs?.remediation ?? null;
        else if (e.phase === "remediate") {
          // forge#4021: a re-gate that requested an in-PR fix re-arms remediate once (bounded in
          // phases.mjs by the INPR_REMEDIATION marker count); every other remediate commit consumes the kind.
          const rearm = e.outputs?.remediation === "inpr-fix";
          s.remediationKind = rearm ? "inpr-fix" : null;
          if (rearm) s.committed = s.committed.filter((ph) => ph !== "remediate");
        }
        break;
      case "RUN_TERMINAL":
        s.terminal = true; s.terminalReason = e.reason ?? "done"; s.v = e.seq;
        lastTerminalReason = s.terminalReason;
        if (e.code) s.outcomeCode = e.code;
        break;
      // forge#3511: an explicit `run-issue --retry` reopens an engine-error
      // terminal. Bumping `v` makes the local state newer than the stale
      // remote terminal index so reconcile remirrors instead of re-terminating.
      // forge#3528: RUN_TERMINAL overwrote the persisted handoff reason
      // (needs-human / decomposed); restore the last commit's reason so the
      // retry re-enters remediate/decompose instead of close/build.
      case "RUN_REOPEN":
        s.terminal = false; s.terminalReason = lastCommitReason; s.outcomeCode = lastCommitCode; s.v = e.seq;
        // forge#3862: a `decomposed` terminal whose decomposition was revoked (trusted GitHub state,
        // checked by the engine before it appends this event) reopens at build: un-commit the
        // phases named in `uncommit` and drop the stale handoff reason so pickPhase re-selects build.
        if (Array.isArray(e.uncommit) && e.uncommit.length) {
          s.committed = s.committed.filter((p) => !e.uncommit.includes(p));
          s.terminalReason = null; s.outcomeCode = null;
          // the revoked handoff reason must not be restored by a later RUN_REOPEN (e.g. after an engine-error)
          lastCommitReason = null; lastCommitCode = null;
        }
        // forge#3754: a remediate that ended needs-human is re-run after a human clears the
        // label. Un-commit it (new array, no in-place mutation) so the forge#3506 resume guard
        // does not re-terminate and remediate's entryCondition re-selects it.
        // forge#3772: only when the terminal being reopened was itself needs-human (the engine
        // reopens that only after a live read shows the label cleared). An engine-error retry
        // keeps remediate committed so the resume guard is not bypassed.
        if (lastCommitPhase === "remediate" && lastCommitReason === "needs-human"
            && lastTerminalReason === "needs-human") {
          s.committed = s.committed.filter((ph) => ph !== "remediate");
        }
        lastTerminalReason = null;
        s.lastRateLimit = null; // forge#3791: an explicit reopen never re-enters a stale pause
        break;
      // forge#3562: an explicit `run-issue --retry` on a `phase-complete` run
      // (multi-phase issue: this phase merged, more remain) starts a NEW cycle.
      // RUN_REOPEN keeps `committed`, so pickPhase would find nothing to run and
      // re-terminate; a new cycle clears committed/branch/pr so it restarts at
      // investigate with a fresh branch. `v` is bumped like RUN_REOPEN, and
      // lastCommitReason is reset so a stale handoff reason cannot leak into
      // the new cycle through a later RUN_REOPEN.
      case "RUN_NEXT_CYCLE":
        s.terminal = false; s.terminalReason = null; s.committed = []; s.outcomeCode = null;
        s.branch = null; s.pr = null; s.remediationKind = null;
        lastCommitReason = null; lastCommitPhase = null; lastCommitCode = null; lastTerminalReason = null; s.v = e.seq;
        s.lastRateLimit = null; // forge#3791
        break;
      // forge#2524: a session-limit pause is purely informational — it does
      // NOT touch committed/terminal/terminalReason. The phase that hit the
      // pause is, by construction, not yet committed (the engine is about to
      // retry it from scratch once the wait elapses), so a resumed/hydrated
      // run correctly re-enters pickPhase at the same phase with no special
      // casing needed here beyond recording the diagnostic below.
      case "PHASE_RATE_LIMITED":
        // forge#3791: backendId is the non-secret identity of the backend/account that hit the limit.
        s.lastRateLimit = { phase: e.phase, resetAt: e.resetAt ?? null, waitMs: e.waitMs ?? null, backendId: e.backendId ?? null };
        s.v = e.seq;
        break;
      // forge#3791: the paused phase attempting again means the pause is over. A crash
      // mid-pause appends no PHASE_START, so a same-backend relaunch still resumes the wait.
      // `v` is intentionally not bumped.
      case "PHASE_START":
        if (s.lastRateLimit && e.phase === s.lastRateLimit.phase) s.lastRateLimit = null;
        break;
      // PHASE_START / PHASE_FAILED do not change committed state
    }
  }
  return s;
}
