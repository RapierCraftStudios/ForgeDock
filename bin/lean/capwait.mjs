// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Capacity wait (#4909): a lane whose sandbox launch was refused for capacity (`sandbox.capacity`) is admitted again only
 * once the pool reports a free slot (`capacity() -> {free}`), not on a blind timer retry; the wait is recorded as queue
 * time (`waits.queue`, ms). A pool that does not report `free` is unknown: the provider's retry-in applies as before.
 * #5985: a refusal that names its reason (`pool.host_load`, `pool.host_mem`) waits on that condition clearing (load below
 * 1.0, free memory above the floor) instead; with no figures for it the slot count above is the fallback.
 */
import { conditionCleared } from "./concurrency.mjs";

export function makeCapWait({ now = Date.now } = {}) {
  const since = new Map(); // issue -> when its launch was refused for capacity
  const reasons = new Map(); // issue -> the pool reason of its refusal (#5985)
  const waited = new Map(); // issue -> queue ms accumulated, not yet recorded on a row
  const isFree = (cap) => Boolean(cap) && Number.isInteger(cap.free) && cap.free > 0;
  const isFull = (cap) => Boolean(cap) && Number.isInteger(cap.free) && cap.free <= 0;
  return {
    /** A launch of `issue` was refused for capacity. */
    refused(issue, reason = null) { if (!since.has(issue)) since.set(issue, now()); if (reason) reasons.set(issue, reason); else reasons.delete(issue); },
    /** True while a refused `issue` must keep waiting: the sampled pool reports no free slot. */
    blocked(issue, cap) {
      if (!since.has(issue)) return false;
      const c = conditionCleared(reasons.get(issue), cap);
      return c === null ? isFull(cap) : !c;
    },
    /** True when `cap` has the figures the refusal's named condition needs (the timer is not the wake). */
    conditional(issue, cap) { return since.has(issue) && conditionCleared(reasons.get(issue), cap) !== null; },
    /** `issue` was admitted: bank its wait as queue time. Returns the ms waited (0 when it was not refused). */
    admitted(issue) {
      if (!since.has(issue)) return 0;
      const ms = Math.max(0, now() - since.get(issue));
      since.delete(issue); reasons.delete(issue);
      waited.set(issue, (waited.get(issue) ?? 0) + ms);
      return ms;
    },
    /** `waits` ({phase: ms}) of a lane result with the banked queue wait added; the same object when none. */
    take(issue, waits) {
      const ms = waited.get(issue);
      if (!ms) return waits;
      waited.delete(issue);
      const base = waits && typeof waits === "object" ? waits : {};
      return { ...base, queue: (Number.isFinite(base.queue) ? base.queue : 0) + ms };
    },
    isFree,
  };
}
