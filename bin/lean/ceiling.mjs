// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Context-ceiling helpers (#5346): the per-size ceiling, the pre-build restart prediction and the restart hand-off facts.
 * Pure: no I/O. The ceiling itself (#4390) is applied in lean.mjs `builder()`; the mid-edit deferral lives in runner.mjs.
 */

import { SIZES } from "./budget.mjs";

/** A session that starts above this share of the ceiling restarts whatever the builder does. */
export const PREDICT_SHARE = 0.6;
/** Rough bytes per token for source and prose. */
export const BYTES_PER_TOKEN = 4;
export const HANDOFF_FILES_MAX = 30;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** `engine.context_ceiling_by_size`: "S=80000,M=120000,L=160000" or `{S, M, L}`; a null when absent or without a valid entry. 0 = no ceiling for that size. */
export function parseCeilingBySize(engine) {
  const raw = engine?.context_ceiling_by_size ?? engine?.contextCeilingBySize;
  if (raw == null || raw === "") return null;
  const out = {};
  const put = (k, v) => { const key = String(k).trim().toUpperCase(); if (SIZES.includes(key) && /^\d+$/.test(String(v).trim())) out[key] = Number(String(v).trim()); };
  if (typeof raw === "object" && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) put(k, v);
  else for (const part of String(raw).split(/[,;]/)) { const [k, v] = part.split(/[=:]/); if (v !== undefined) put(k, v); }
  return Object.keys(out).length ? out : null;
}

/** The ceiling a model without a known window keeps (#4390). */
export const DEFAULT_CEILING = 120000;
/** #5829: the share of a model's input window used as its default ceiling. */
export const WINDOW_SHARE = 0.5;
/** #5829: a session at this share of the window always restarts (digest), whatever continuing costs. */
export const REAL_LIMIT_SHARE = 0.9;
/** #5829: cache-read USD per token and an estimated restart cost, used when a model has no entry or the engine sets none. */
export const RESTART_COST_USD = 0.5;
export const CACHE_READ_USD = 0.5 / 1e6;
/** #5829: static input windows (tokens) and cache-read prices (USD per token), first match wins; no model-API lookup (this module is pure). */
export const MODEL_WINDOWS = [
  { match: /1m/i, window: 1000000, cacheRead: 0.5 / 1e6 },
  { match: /opus/i, window: 200000, cacheRead: 0.5 / 1e6 },
  { match: /sonnet/i, window: 200000, cacheRead: 0.3 / 1e6 },
  { match: /haiku/i, window: 200000, cacheRead: 0.1 / 1e6 },
];
/** The static entry for a routed model id; null when unknown. */
export function modelInfo(model) {
  const m = String(model ?? "");
  return m ? MODEL_WINDOWS.find((e) => e.match.test(m)) ?? null : null;
}
/** The default ceiling for `model`: `share` of its window; DEFAULT_CEILING for an unknown model. */
export function modelCeiling(model, share = WINDOW_SHARE) {
  const e = modelInfo(model);
  const sh = Number.isFinite(share) && share > 0 && share <= 1 ? share : WINDOW_SHARE;
  return e ? Math.floor(e.window * sh) : DEFAULT_CEILING;
}

/**
 * The ceiling for a lane of `size`: its per-size entry, else the global explicit one, else (#5829) the routed model's default
 * when `model` is given and the global one was not set explicitly (`tokens` null/undefined), else `tokens`.
 */
export function ceilingFor(size, { tokens = 0, bySize = null, model = null, share = WINDOW_SHARE } = {}) {
  const v = bySize && SIZES.includes(size) ? bySize[size] : undefined;
  if (Number.isFinite(v) && v >= 0) return v;
  if (tokens == null && model != null) return modelCeiling(model, share);
  return tokens ?? 0;
}

/**
 * #5829: at a context stop, continue the session or restart it from the digest. Continuing costs `turnsLeft x context x cachePrice`;
 * restarting costs `restartCost`. A session at REAL_LIMIT_SHARE of a known `window` always restarts; an unknown window never continues.
 */
export function restartDecision({ context = 0, turnsLeft = 0, cachePrice = CACHE_READ_USD, restartCost = RESTART_COST_USD, window = 0 } = {}) {
  const continueCost = Math.max(0, turnsLeft) * Math.max(0, context) * cachePrice;
  if (!(window > 0)) return { action: "restart", reason: "unknown_window", continueCost, restartCost };
  if (context >= window * REAL_LIMIT_SHARE) return { action: "restart", reason: "real_limit", continueCost, restartCost };
  return continueCost > restartCost ? { action: "restart", reason: "cost", continueCost, restartCost } : { action: "continue", reason: "cost", continueCost, restartCost };
}

/**
 * Whether a build session is predicted to restart. `promptBytes` is the build prompt, `fileBytes` the named files' size.
 * `certain`: the named files alone exceed the ceiling, so any session that reads them restarts.
 * `predicted`: the start (prompt + files) is at or above PREDICT_SHARE of the ceiling.
 */
export function predictRestart({ ceiling = 0, promptBytes = 0, fileBytes = 0 } = {}) {
  const files = Math.ceil(Math.max(0, fileBytes) / BYTES_PER_TOKEN);
  const estimate = Math.ceil(Math.max(0, promptBytes) / BYTES_PER_TOKEN) + files;
  if (!(ceiling > 0)) return { predicted: false, certain: false, estimate, ceiling };
  const certain = files > ceiling;
  return { predicted: certain || estimate >= ceiling * PREDICT_SHARE, certain, estimate, ceiling };
}

/** The tool uses' first edit: the 1-based turn (distinct assistant message) of the first Edit/Write, null when none. */
export function firstEditTurn(toolUses) {
  const msgs = new Map();
  for (const u of Array.isArray(toolUses) ? toolUses : []) {
    if (!u || typeof u !== "object") continue;
    const k = u.msg ?? `#${msgs.size}`;
    if (!msgs.has(k)) msgs.set(k, msgs.size + 1);
    if (EDIT_TOOLS.has(u.name)) return msgs.get(k);
  }
  return null;
}

/** What the stopped session had established: files read, files edited (deduped, capped) and the last tool call. */
export function handoffFacts(toolUses, lastTool = null) {
  const read = new Set(), edited = new Set();
  for (const u of Array.isArray(toolUses) ? toolUses : []) {
    if (!u || typeof u.path !== "string" || !u.path) continue;
    if (EDIT_TOOLS.has(u.name)) edited.add(u.path); else if (u.name === "Read") read.add(u.path);
  }
  const readOnly = [...read].filter((p) => !edited.has(p));
  return { read: readOnly.slice(0, HANDOFF_FILES_MAX), edited: [...edited].slice(0, HANDOFF_FILES_MAX), readMore: Math.max(0, readOnly.length - HANDOFF_FILES_MAX),
    last: lastTool && typeof lastTool.name === "string" ? { name: lastTool.name, input: String(lastTool.input ?? "").slice(0, 200) } : null };
}

/** Appended to the build prompt of a lane predicted to restart: read the named files, do not survey. */
export const NARROW_NOTE = "\n\nContext is tight on this lane (the contract's files and this prompt already fill much of the session window): read only the files the contract names and the code you edit, skip surveys of unrelated code, and make each edit as soon as you know it.";

/** #5812: the route digest's byte cap (about 8000 tokens); a smaller hand-off bound lowers it to the bound in bytes, a quarter of it in tokens. */
export const ROUTE_DIGEST_MAX_BYTES = 32 * 1024;

/**
 * #5812: whether the routed build resumes the planning session or starts fresh from a digest. `planTokens` is the planning
 * session's last-turn context (null when unknown: resume, as before), `bound` is `engine.route_handoff_tokens` (0 = always
 * resume), capped at half the lane's ceiling so a build never opens near it. Above the bound: digest.
 */
export function routeHandoff({ planTokens = null, bound = 0, ceiling = 0 } = {}) {
  const b = bound > 0 ? (ceiling > 0 ? Math.min(bound, Math.floor(ceiling / 2)) : bound) : 0;
  const digest = b > 0 && Number.isFinite(planTokens) && planTokens > b;
  return { digest, planTokens: Number.isFinite(planTokens) ? planTokens : null, bound: b, digestBytes: Math.min(ROUTE_DIGEST_MAX_BYTES, Math.max(2048, b)) };
}

/** #5812: the planning reply's closing "Build reads:" list (the files and searches the build opens with); "" when absent. */
export function buildReadsOf(text) {
  const s = String(text ?? ""), i = s.lastIndexOf("Build reads:");
  return i < 0 ? "" : s.slice(i + "Build reads:".length).trim().slice(0, 3000);
}
