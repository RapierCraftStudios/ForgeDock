// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#3835: the engine's `emitTelemetry` seam writer. Maps the run-log shaped records the engine hands to the
 * seam onto FORGE:TELEMETRY events so `forgedock stats` can rebuild Cost, Time and outcome codes from GitHub alone:
 *   PHASE_ATTEMPT_USAGE -> `phase_attempt` (attempt, model, turns, duration_ms, cost_usd, *_tokens)
 *   RUN_TERMINAL        -> `run_terminal`  (reason, code, wall_ms)
 * Other records are ignored. The returned function NEVER throws and honours FORGE_TELEMETRY=off. Telemetry values
 * are scalars (the emitter stringifies objects), so the `usage` object is flattened here; absent values are omitted.
 */
import { execFileSync } from "node:child_process";
import { emit } from "./telemetry.mjs";

export function defaultResolveRepo() {
  try {
    const r = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).trim();
    return /^[\w.-]+\/[\w.-]+$/.test(r) ? r : null;
  } catch { return null; }
}

const scalar = (v) => (typeof v === "number" ? Number.isFinite(v) : typeof v === "string" && v !== "");
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => scalar(v)));
const tok = (u, k) => (u && typeof u === "object" && Number.isFinite(u[k]) ? u[k] : undefined);

/** Pure mapping, exported for tests: returns { event, payload, phase } or null when the record is not mapped. */
export function mapRecord(rec, wallMs) {
  if (!rec || typeof rec !== "object") return null;
  if (rec.event === "PHASE_ATTEMPT_USAGE") {
    return { event: "phase_attempt", phase: rec.phase, payload: compact({
      attempt: rec.attempt, model: rec.model, stages: rec.stages, turns: rec.turns, duration_ms: rec.duration_ms,
      cost_usd: Number.isFinite(rec.cost_usd) ? Math.round(rec.cost_usd * 1e6) / 1e6 : undefined,
      input_tokens: tok(rec.usage, "input_tokens"), output_tokens: tok(rec.usage, "output_tokens"),
      cache_read_tokens: tok(rec.usage, "cache_read_input_tokens"), cache_creation_tokens: tok(rec.usage, "cache_creation_input_tokens"),
    }) };
  }
  if (rec.event === "RUN_TERMINAL") {
    return { event: "run_terminal", phase: null, payload: compact({ reason: rec.reason, code: rec.code, wall_ms: wallMs }) };
  }
  if (rec.event === "CI_PENDING_WAIT") {
    return { event: "ci_pending_wait", phase: rec.phase ?? "review", payload: compact({ pr: rec.pr, minutes_waited: rec.minutes_waited, result: rec.result, polls: rec.polls, rate_limit_sleeps: rec.rate_limit_sleeps }) };
  }
  return null;
}

/**
 * @param {{repo?: string|null, emitFn?: Function, now?: () => number, resolveRepo?: () => string|null, env?: object}} o
 * @returns {(rec: object) => Promise<void>}
 */
export function makeEmitTelemetry({ repo = null, emitFn = emit, now = Date.now, resolveRepo = defaultResolveRepo, env = process.env } = {}) {
  const startedAt = now();
  let resolved = repo || env.FORGE_REPO || null;
  let tried = Boolean(resolved);
  return async (rec) => {
    try {
      if ((env.FORGE_TELEMETRY || "on") === "off") return;
      const mapped = mapRecord(rec, now() - startedAt);
      if (!mapped || rec.issue == null) return;
      if (!tried) { tried = true; resolved = resolveRepo() || null; }
      if (!resolved) return; // no destination: the Node emitter would drop it anyway
      // ctx carries repo/issue/run/phase: emit() drops those reserved keys from the payload.
      emitFn(mapped.event, mapped.payload, { repo: resolved, issue: rec.issue, run: `r_${rec.issue}_${Math.floor(startedAt / 1000)}`, phase: mapped.phase ?? undefined });
    } catch { /* telemetry never fails a run */ }
  };
}
