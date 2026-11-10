// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Context-ceiling helpers (#5346): the per-size ceiling, the pre-build restart prediction and the restart hand-off facts.
 * Pure: no I/O. The ceiling itself (#4390) is applied in lean.mjs `builder()`; the mid-edit deferral lives in runner.mjs.
 */

export const SIZES = ["S", "M", "L"];
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

/** The ceiling for a lane of `size`: its per-size entry, else the global one. */
export function ceilingFor(size, { tokens = 0, bySize = null } = {}) {
  const v = bySize && SIZES.includes(size) ? bySize[size] : undefined;
  return Number.isFinite(v) && v >= 0 ? v : tokens;
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
