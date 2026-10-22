// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#3835: the engine's `emitTelemetry` seam writer. Maps the run-log shaped records the engine hands to the
 * seam onto FORGE:TELEMETRY events so `forgedock stats` can rebuild Cost, Time and outcome codes from GitHub alone:
 *   PHASE_ATTEMPT_USAGE -> `phase_attempt` (attempt, model, backend, turns, duration_ms, cost_usd, cost_usd_delta, cost_usd_session, *_tokens)
 *   RUN_TERMINAL        -> `run_terminal`  (reason, code, wall_ms; lean adds milestone, conformance_mode, shadow_would, the pr and
 *                          builder_tier/class/model/escalated 0|1, forge#4394)
 *   SANDBOX_USAGE       -> `sandbox_usage` (provider, sandbox_id, minutes, cost_usd, batch; one per settled remote lane, forge#4255)
 *   STRUCTURE_DELTA     -> `structure_delta` (edges_added/removed, import_files_added/removed, boundary_changed/loosened 0|1; forge#4159)
 *                          lean's merge-time record (forge#4165) adds milestone, the pr and string lists: deps_added and
 *                          new_edges / removed_edges as "from:to" comma-joined, top_growth "file+N", decisions "K1:lint",
 *                          plus decisions_doc/lint/precedent/spec counts. Values are capped at 200 chars by the emitter.
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

const SOURCES = ["doc", "lint", "precedent", "spec"];
const prOf = (rec) => (Number.isSafeInteger(rec.pr) && rec.pr > 0 ? { pr: rec.pr } : {});
/** "a:b,c:d" from [{from,to}] (forge#4165); undefined for a non-array so compact() drops it. An empty list is "". */
const pairs = (v) => (Array.isArray(v) ? v.map((e) => `${e?.from}:${e?.to}`).join(",") : undefined);
const nonEmpty = (v) => (v === "" ? "none" : v);
/** Lean's forge#4165 extras of a STRUCTURE_DELTA record; {} for the implement-time counts-only shape. */
function structureLists(rec) {
  if (!Array.isArray(rec.decisions) && !Array.isArray(rec.new_edges) && !Array.isArray(rec.deps_added)) return {};
  const dec = Array.isArray(rec.decisions) ? rec.decisions : [];
  const out = {
    milestone: rec.milestone, deps_added: nonEmpty(pairs(rec.deps_added)), new_edges: nonEmpty(pairs(rec.new_edges)), removed_edges: nonEmpty(pairs(rec.removed_edges)),
    top_growth: Array.isArray(rec.top_growth) ? nonEmpty(rec.top_growth.map((g) => `${g?.file}+${g?.lines}`).join(",")) : undefined,
    decisions: nonEmpty(dec.map((k) => `${k?.id}:${k?.source ?? "none"}`).join(",")),
  };
  for (const src of SOURCES) out[`decisions_${src}`] = dec.filter((k) => k?.source === src).length;
  return out;
}

/** Pure mapping, exported for tests: returns { event, payload, phase, pr? } or null when the record is not mapped. */
export function mapRecord(rec, wallMs) {
  if (!rec || typeof rec !== "object") return null;
  if (rec.event === "PHASE_ATTEMPT_USAGE") {
    return { event: "phase_attempt", phase: rec.phase, payload: compact({
      attempt: rec.attempt, trigger: rec.trigger ?? undefined, restart_of: rec.restart_of ?? undefined, model: rec.model, backend: rec.backend ?? undefined, stages: rec.stages, turns: rec.turns, duration_ms: rec.duration_ms,
      cost_usd: Number.isFinite(rec.cost_usd) ? Math.round(rec.cost_usd * 1e6) / 1e6 : undefined,
      cost_usd_delta: Number.isFinite(rec.cost_usd_delta) ? Math.round(rec.cost_usd_delta * 1e6) / 1e6 : undefined, // #4407
      cost_usd_session: Number.isFinite(rec.cost_usd_session) ? Math.round(rec.cost_usd_session * 1e6) / 1e6 : undefined,
      input_tokens: tok(rec.usage, "input_tokens"), output_tokens: tok(rec.usage, "output_tokens"),
      cache_read_tokens: tok(rec.usage, "cache_read_input_tokens"), cache_creation_tokens: tok(rec.usage, "cache_creation_input_tokens"),
    }) };
  }
  if (rec.event === "RUN_TERMINAL") {
    return { event: "run_terminal", phase: null, ...prOf(rec), payload: compact({ reason: rec.reason, code: rec.code, wall_ms: wallMs,
      milestone: rec.milestone, conformance_mode: rec.conformance_mode, shadow_would: rec.shadow_would,
      builder_tier: rec.builder_tier, builder_class: rec.builder_class, builder_model: rec.builder_model, // #4394: the model per merge
      builder_escalated: typeof rec.builder_escalated === "boolean" ? Number(rec.builder_escalated) : undefined }) };
  }
  if (rec.event === "SANDBOX_USAGE") {
    return { event: "sandbox_usage", phase: null, payload: compact({ provider: rec.provider, sandbox_id: rec.sandbox_id, minutes: rec.minutes,
      cost_usd: Number.isFinite(rec.cost_usd) ? Math.round(rec.cost_usd * 1e6) / 1e6 : undefined, batch: rec.batch }) };
  }
  if (rec.event === "STRUCTURE_DELTA") {
    const bit = (v) => (typeof v === "boolean" ? Number(v) : v);
    return { event: "structure_delta", phase: rec.phase ?? "implement", ...prOf(rec), payload: compact({ edges_added: rec.edges_added, edges_removed: rec.edges_removed,
      import_files_added: rec.import_files_added, import_files_removed: rec.import_files_removed, boundary_changed: bit(rec.boundary_changed), boundary_loosened: bit(rec.boundary_loosened),
      ...structureLists(rec) }) };
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
      emitFn(mapped.event, mapped.payload, { repo: resolved, issue: rec.issue, run: `r_${rec.issue}_${Math.floor(startedAt / 1000)}`, phase: mapped.phase ?? undefined,
        ...(Number.isSafeInteger(mapped.pr) ? { pr: mapped.pr } : {}) });
    } catch { /* telemetry never fails a run */ }
  };
}
