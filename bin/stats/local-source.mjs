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
/** #4407: an attempt's own cost; `cost_usd` is a running total for a resumed session, so the delta wins when present. */
const costOf = (e) => (Number.isFinite(e.cost_usd_delta) ? e.cost_usd_delta : e.cost_usd);

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
    if (attempt && Number.isFinite(costOf(e))) p.usd = (p.usd ?? 0) + costOf(e);
  }
  const finished = t >= 0 && (r < 0 || t > r);
  // forge#4275: the context-pack A/B inputs. Builder calls log as phase "implement" (the plan call is the first).
  const term = finished ? ev[t] : null;
  const cp = [...ev].reverse().find((e) => e.event === "CONTEXT_PACK");
  const usage = ev.filter((e) => e.event === "PHASE_ATTEMPT_USAGE");
  const builderCalls = usage.filter((e) => e.phase === "implement");
  const reviewCalls = usage.filter((e) => e.phase === "review").length;
  const contextPack = { mode: term?.context_pack ?? cp?.mode ?? "off", laneType: term?.lane_type ?? cp?.lane_type ?? null };
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
    contextPack,
    // #4362: builder attempts in log order with their trigger (null before the field existed)
    builderAttempts: builderCalls.map((e) => ({ attempt: e.attempt ?? null, trigger: e.trigger ?? null, restart_of: e.restart_of ?? null, cost_usd: Number.isFinite(costOf(e)) ? costOf(e) : null })),
    // #4375: pitfalls in the pack matching the issue's files (RUN_TERMINAL, else the last CONTEXT_PACK); null before the field
    pitfallsMatched: Number.isInteger(term?.pitfalls_matched) ? term.pitfalls_matched
      : Array.isArray(cp?.pitfalls) ? cp.pitfalls.filter((p) => p?.match === "files").length : null,
    builderTurns: builderCalls.reduce((x, e) => x + n(e.turns), 0),
    size: term?.turns?.size ?? null, // #4409: S|M|L from the lane's turn record, buckets the admission estimate history
    cacheTokens: usage.reduce((x, e) => x + n(e.usage?.cache_read_input_tokens) + n(e.usage?.cache_creation_input_tokens), 0),
    costUsd: usage.reduce((x, e) => x + n(costOf(e)), 0),
    // #4394: the builder tier (RUN_TERMINAL builder_*, else the BUILDER_ROUTE / BUILDER_ESCALATED events); null before routing
    builderRoute: routeOf(term, ev),
    conformanceRound: builderCalls.some((e) => e.trigger === "conformance" || e.trigger === "review"),
    shadowWould: typeof term?.shadow_would === "string" ? term.shadow_would : null,
    reachedReview: reviewCalls > 0 || typeof term?.shadow_would === "string",
    // #4394: routes of earlier runs in this log that ended merged: a later run of the same issue is post-merge rework
    reworkedMerges: earlierMergedRoutes(events.slice(0, s)),
    // first pass: merged off one plan + one implement call, at most one review, no CI fix round
    firstPass: finished && term?.reason === "merged" && builderCalls.length <= 2 && reviewCalls <= 1 && !ev.some((e) => e.event === "CI_FIX_ROUND"),
    // #4436: the lane profile (#4395) of this slice's sessions ("mixed" when they differ, null before the field) and the
    // fresh sessions' first-turn baseline_tokens per phase (resumed sessions carry none)
    laneProfile: profileOf(usage),
    baselines: usage.reduce((acc, e) => { if (Number.isFinite(e.baseline_tokens)) (acc[e.phase ?? "other"] ??= []).push(e.baseline_tokens); return acc; }, {}),
  };
}

/** #4436: the one lane_profile of the usage records, "mixed" when they differ, null when none carries it. */
function profileOf(usage) {
  const ps = new Set(usage.map((e) => e.lane_profile).filter((p) => typeof p === "string" && p));
  return ps.size === 0 ? null : ps.size === 1 ? [...ps][0] : "mixed";
}

/** #4394: {tier, class, escalated, model} of a lane, or null when it computed no builder route. */
function routeOf(term, ev) {
  if (typeof term?.builder_tier === "string") {
    return { tier: term.builder_tier, class: term.builder_class ?? null, escalated: term.builder_escalated === true, model: term.builder_model ?? null };
  }
  const r = [...ev].reverse().find((e) => e.event === "BUILDER_ROUTE");
  if (!r) return null;
  return { tier: r.tier ?? null, class: r.class ?? null, escalated: ev.some((e) => e.event === "BUILDER_ESCALATED"), model: r.model ?? null };
}

/** #4394: the routes ({tier, class, escalated, model}) of the RUN_START slices in `events` that ended merged with a route. */
function earlierMergedRoutes(events) {
  const out = [];
  let slice = null;
  const close = () => {
    if (!slice) return;
    const term = [...slice].reverse().find((e) => e.event === "RUN_TERMINAL");
    const rt = term?.reason === "merged" ? routeOf(term, slice) : null;
    if (rt) out.push(rt);
  };
  for (const e of events) {
    if (e.event === "RUN_START") { close(); slice = []; }
    if (slice) slice.push(e);
  }
  close();
  return out;
}

/**
 * All run summaries in `dir` (a missing dir or an unreadable log yields nothing, never an error). One per log (its last
 * RUN_START slice); with `allSlices` (#4436) one per RUN_START slice, so a before and an after run of one issue both count.
 */
export function readLocalRuns(dir = runsDir(), { allSlices = false } = {}) {
  if (!existsSync(dir)) return [];
  const runs = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const m = /(?:^|__)(\d+)\.jsonl$/.exec(f); // #4432: `<issue>.jsonl` or `<owner>__<repo>__<issue>.jsonl`
      const events = parseLog(readFileSync(join(dir, f), "utf8"));
      const starts = allSlices ? events.flatMap((e, i) => (e.event === "RUN_START" ? [i] : [])) : [events.length];
      const mtimeTs = new Date(statSync(join(dir, f)).mtimeMs).toISOString();
      starts.forEach((_, k) => {
        const sum = summariseLog(allSlices ? events.slice(0, starts[k + 1] ?? events.length) : events, m ? Number(m[1]) : null);
        if (sum) runs.push({ ...sum, mtimeTs });
      });
    } catch { /* unreadable log */ }
  }
  return runs;
}

/**
 * forge#4354: one lane per RUN_START..next-RUN_START slice (every slice, not only the last), with the fail-soft events the
 * alert pass rates: DEPS_PREPARED rows, TOOLCHAIN_WARNING texts, deferred-to-ci precheck commands and the terminal code.
 */
export function lanesOfLog(events, fallbackIssue = null, fallbackTs = null) {
  const lanes = [];
  let cur = null;
  for (const e of events) {
    if (e.event === "RUN_START") {
      cur = { repo: e.repo ?? null, issue: e.issue ?? fallbackIssue, startTs: e.ts ?? fallbackTs, code: null, reason: null,
        deps: [], toolchainWarnings: [], deferred: [], sparseFallback: null };
      lanes.push(cur);
      continue;
    }
    if (!cur) continue;
    if (e.event === "RUN_TERMINAL") { cur.code = e.code ?? null; cur.reason = e.reason ?? null; }
    else if (e.event === "DEPS_PREPARED") cur.deps.push({ eco: e.eco ?? null, status: e.status ?? null, reason: e.reason ?? null });
    else if (e.event === "TOOLCHAIN_WARNING" && e.warning) cur.toolchainWarnings.push(String(e.warning));
    else if (e.event === "PRECHECK_COMMANDS" && Array.isArray(e.results)) {
      for (const r of e.results) if (r?.status === "deferred-to-ci") cur.deferred.push(String(r.command ?? ""));
    } else if (e.event === "WORKTREE_SPARSE_FALLBACK") cur.sparseFallback = e.reason ?? "";
  }
  return lanes;
}

/** All lanes in `dir` (a missing dir or an unreadable log yields nothing, never an error). Local files only, no network. */
export function readLanes(dir = runsDir()) {
  if (!existsSync(dir)) return [];
  const lanes = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const m = /(?:^|__)(\d+)\.jsonl$/.exec(f); // #4432: `<issue>.jsonl` or `<owner>__<repo>__<issue>.jsonl`
      const mtime = new Date(statSync(join(dir, f)).mtimeMs).toISOString();
      lanes.push(...lanesOfLog(parseLog(readFileSync(join(dir, f), "utf8")), m ? Number(m[1]) : null, mtime));
    } catch { /* unreadable log */ }
  }
  return lanes;
}
