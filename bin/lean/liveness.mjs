// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5991: owner-based liveness under the clock fallbacks (25 min lease TTL, 300 s unreachable window, per-attempt budget key).
 * Pure helpers; the callers supply the facts (live batches, agent online state).
 */

/** The transport-failure window once the pool agent answers: the sandbox is gone, not the network. */
export const AGENT_UP_WINDOW_MS = 90000;

/**
 * A lease whose holder batch is provably not live. `liveBatches` is the ids of the batches that still own the issue
 * (array or Set); `null`/`undefined` means unknown, and a lease without a `batch` has no owner to ask: both keep the TTL.
 */
export function holderGone(lease, { liveBatches = null } = {}) {
  const batch = typeof lease?.batch === "string" && lease.batch ? lease.batch : null;
  if (!batch || liveBatches == null) return false;
  const live = liveBatches instanceof Set ? liveBatches.has(batch) : Array.isArray(liveBatches) ? liveBatches.includes(batch) : null;
  return live === false;
}

/**
 * What a transport failure means after `waitedMs` in a row: "unreachable" ends the wait, "wait" keeps retrying. With the pool
 * agent online (`agentOnline === true`) the window shrinks to 90 s; offline or unknown (`false`/`null`) keeps `windowMs`.
 */
export function classifyTransportLoss({ agentOnline = null, waitedMs = 0, windowMs = 300000 } = {}) {
  const limit = agentOnline === true ? Math.min(windowMs, AGENT_UP_WINDOW_MS) : windowMs;
  return waitedMs >= limit ? "unreachable" : "wait";
}

/**
 * One budget row per sandbox lifetime. #6023: a pool reuses the sandbox id across an issue's attempts, so the attempt's
 * start time is part of the key; a replay of the same attempt keeps its key (the record keeps the larger usage).
 */
export function sandboxBudgetKey(batchId, sandboxId, startedAt = null) {
  return `${batchId}#${sandboxId}${startedAt != null && startedAt !== "" ? `#${startedAt}` : ""}`;
}
