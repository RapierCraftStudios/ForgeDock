/**
 * Append-only per-issue run-log (the crash-safe local hot path).
 * One JSON event per line at {dir}/{issue}.jsonl. seq is assigned monotonically.
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

function logPath(dir, issue) { return join(dir, `${issue}.jsonl`); }

/** Append an event; assigns the next seq based on the current line count. */
export function appendEvent(dir, issue, event) {
  mkdirSync(dir, { recursive: true });
  const path = logPath(dir, issue);
  const seq = readLog(dir, issue).length + 1;
  appendFileSync(path, JSON.stringify({ seq, ...event }) + "\n");
}

/** Read all complete events; a truncated final line (crash mid-write) is ignored. */
export function readLog(dir, issue) {
  const path = logPath(dir, issue);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial final line: ignore */ }
  }
  return out;
}

/** Fold events into a RunState. The commit rule lives here. */
export function deriveState(events) {
  /** @type {import("./phases.mjs").RunState} */
  const s = { v: 0, run: null, issue: null, lane: "staging", committed: [],
              phase: null, branch: null, pr: null, terminal: false,
              terminalReason: null, lease: null };
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
      // PHASE_START / PHASE_FAILED do not change committed state
    }
  }
  return s;
}
