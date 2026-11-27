// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #6061: the per-worker lane target. Same AIMD thresholds as the orchestrator controller (bin/lean/concurrency.mjs, imported):
 * +1 while free memory is above floor + headroom and load per core is green for a hold window, halve (min 1) on load above
 * 1.5/core or low memory, never above the configured ceiling. `drainState` says when the worker accepts no new lane (running
 * lanes always finish). Pure: the caller keeps `greenSince` / busy timers and feeds the clock.
 */
import { LOAD_GREEN, LOAD_HALVE, MEM_FLOOR_GB, MEM_HEADROOM_GB } from "../lean/concurrency.mjs";

export const GREEN_HOLD_MS = 60_000;
export const DRAIN_AFTER_MS = 5 * 60_000;
const fin = (v) => typeof v === "number" && Number.isFinite(v);

/** Is the host over its pressure line (load above 1.5/core or free memory under the floor)? Unknown figures are not pressure. */
export const pressured = (live, { memFloorGb = MEM_FLOOR_GB } = {}) =>
  (fin(live?.load_per_core) && live.load_per_core > LOAD_HALVE) || (fin(live?.mem_available_gb) && live.mem_available_gb < memFloorGb);

/** Next `{ target, greenSince, change }` (change: "grow" | "halve" | null). `refused` (a pool.* refusal) also halves. */
export function step({ target, ceiling, live, refused = false, now = Date.now(), greenSince = null, holdMs = GREEN_HOLD_MS, memFloorGb = MEM_FLOOR_GB, memHeadroomGb = MEM_HEADROOM_GB } = {}) {
  const top = Math.max(1, Number.isInteger(ceiling) ? ceiling : 1);
  const t = Math.min(top, Math.max(1, Number.isInteger(target) ? target : 1));
  if (refused || pressured(live, { memFloorGb })) {
    const next = Math.max(1, Math.floor(t / 2));
    return { target: next, greenSince: null, change: next < t ? "halve" : null };
  }
  const green = fin(live?.load_per_core) && live.load_per_core < LOAD_GREEN && fin(live?.mem_available_gb) && live.mem_available_gb > memFloorGb + memHeadroomGb;
  if (!green) return { target: t, greenSince: null, change: null };
  const since = greenSince ?? now;
  if (t < top && now - since >= holdMs) return { target: t + 1, greenSince: now, change: "grow" }; // each step needs a fresh hold window
  return { target: t, greenSince: since, change: null };
}

/** `{ draining, reason }`: paused (owner, policy or config), or the host busy for `drainAfterMs`. */
export function drainState({ paused = false, ownerPaused = false, policyPaused = false, busyForMs = 0, drainAfterMs = DRAIN_AFTER_MS } = {}) {
  if (ownerPaused) return { draining: true, reason: "paused by owner" };
  if (policyPaused) return { draining: true, reason: "paused by policy" };
  if (paused) return { draining: true, reason: "paused" };
  if (busyForMs >= drainAfterMs) return { draining: true, reason: `host busy for ${Math.round(busyForMs / 60000)}m` };
  return { draining: false, reason: null };
}
