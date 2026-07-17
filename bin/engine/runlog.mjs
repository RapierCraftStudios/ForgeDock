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
  appendFileSync(path, JSON.stringify({ seq, ...event }) + "\n");
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
export function deriveState(events) {
  /** @type {import("./phases.mjs").RunState} */
  const s = { v: 0, run: null, issue: null, lane: "staging", committed: [],
              phase: null, branch: null, pr: null, terminal: false,
              terminalReason: null, lease: null, lastRateLimit: null };
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
        break;
      case "RUN_TERMINAL":
        s.terminal = true; s.terminalReason = e.reason ?? "done"; s.v = e.seq;
        break;
      // forge#2524: a session-limit pause is purely informational — it does
      // NOT touch committed/terminal/terminalReason. The phase that hit the
      // pause is, by construction, not yet committed (the engine is about to
      // retry it from scratch once the wait elapses), so a resumed/hydrated
      // run correctly re-enters pickPhase at the same phase with no special
      // casing needed here beyond recording the diagnostic below.
      case "PHASE_RATE_LIMITED":
        s.lastRateLimit = { phase: e.phase, resetAt: e.resetAt ?? null, waitMs: e.waitMs ?? null };
        s.v = e.seq;
        break;
      // PHASE_START / PHASE_FAILED do not change committed state
    }
  }
  return s;
}
