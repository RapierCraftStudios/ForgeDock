// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Optional extra source for `forgedock stats` (forge#3835): the engine run logs in ~/.forge/runs (FORGE_RUNS_DIR).
 * Needed only for runs that predate the GitHub `phase_attempt` / `run_terminal` records. Same counting rules as
 * scripts/cost-report.sh. Old logs lack `ts`, `code`, `version` and `repo`: those fields become null.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const runsDir = (env = process.env) => env.FORGE_RUNS_DIR || join(homedir(), ".forge", "runs");

function parseLog(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === "object") out.push(e); } catch { /* truncated or corrupt line */ }
  }
  return out;
}

const n = (x) => (Number.isFinite(x) ? x : 0);

/** Summarise one log: the last RUN_START..end slice. Returns null when there is no RUN_START. */
export function summariseLog(events, fallbackIssue = null) {
  let s = -1;
  events.forEach((e, i) => { if (e.event === "RUN_START") s = i; });
  if (s < 0) return null;
  const ev = events.slice(s);
  const start = ev[0];
  let t = -1; let r = -1;
  ev.forEach((e, i) => {
    if (e.event === "RUN_TERMINAL") t = i;
    if (e.event === "RUN_REOPEN" || e.event === "RUN_NEXT_CYCLE") r = i;
  });
  const attemptPhases = new Set(ev.filter((e) => e.event === "PHASE_ATTEMPT_USAGE").map((e) => e.phase));
  const phases = {};
  let usageEvents = 0;
  for (const e of ev) {
    const attempt = e.event === "PHASE_ATTEMPT_USAGE";
    const legacy = (e.event === "PHASE_COMMIT" || e.event === "PHASE_FAILED") && !attemptPhases.has(e.phase);
    if (!(attempt || legacy) || !e.usage || typeof e.usage !== "object") continue;
    usageEvents++;
    const p = (phases[e.phase ?? "other"] ??= { cr: 0, out: 0, usd: null, ms: null, attempts: 0 });
    p.cr += n(e.usage.cache_read_input_tokens);
    p.out += n(e.usage.output_tokens);
    p.attempts++;
    if (attempt && Number.isFinite(e.duration_ms)) p.ms = (p.ms ?? 0) + e.duration_ms;
    if (attempt && Number.isFinite(e.cost_usd)) p.usd = (p.usd ?? 0) + e.cost_usd;
  }
  const finished = t >= 0 && (r < 0 || t > r);
  const startTs = start.ts ?? null;
  const endTs = finished ? ev[t].ts ?? null : null;
  const a = Date.parse(startTs ?? ""); const b = Date.parse(endTs ?? "");
  return {
    source: "local", repo: start.repo ?? null, version: start.version ?? null, issue: start.issue ?? fallbackIssue, run: start.run ?? null,
    finished, hydrated: start.hydrated === true, usageEvents,
    reason: finished ? ev[t].reason ?? null : null, code: finished ? ev[t].code ?? null : null,
    remediated: ev.some((e) => e.event === "PHASE_COMMIT" && e.phase === "remediate"),
    startTs, endTs, wallMs: finished && !Number.isNaN(a) && !Number.isNaN(b) ? Math.max(0, b - a) : null,
    phases,
  };
}

/** All run summaries in `dir` (a missing dir or an unreadable log yields nothing, never an error). */
export function readLocalRuns(dir = runsDir()) {
  if (!existsSync(dir)) return [];
  const runs = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const m = /^(\d+)\.jsonl$/.exec(f);
      const sum = summariseLog(parseLog(readFileSync(join(dir, f), "utf8")), m ? Number(m[1]) : null);
      if (sum) runs.push({ ...sum, mtimeTs: new Date(statSync(join(dir, f)).mtimeMs).toISOString() });
    } catch { /* unreadable log */ }
  }
  return runs;
}
