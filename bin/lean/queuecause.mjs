// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * queue_wait by cause (#6203). One clock per batch: an issue's wait starts when it is first seen pending ("ready") and
 * accrues per cause while it is pending; it does NOT reset on a requeue (the old `enqueued` stamp did), and it stops while the
 * issue runs. The runner calls `tick` once per scheduling pass with a pure `causeOf(issue)`; `take` closes the issue's
 * accrual when its lane starts and returns the totals so far. State is plain JSON so a resumed batch keeps it.
 */
export const QUEUE_CAUSES = Object.freeze(["hold", "pause", "capacity", "breaker", "dependency", "host_offline", "other"]);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

export function createQueueClock(saved = null) {
  const acc = new Map(Object.entries(saved?.acc ?? {}).map(([n, c]) => [n, { ...c }]));
  const readyAt = new Map(Object.entries(saved?.readyAt ?? {}));
  const last = new Map(); // issue -> {at, cause}; not persisted: a restart opens a fresh segment
  const add = (n, cause, ms) => { if (ms > 0) { const a = acc.get(n) ?? {}; a[cause] = (a[cause] ?? 0) + ms; acc.set(n, a); } };
  const close = (n, t) => { const l = last.get(n); if (l) add(String(n), l.cause, Math.max(0, t - l.at)); last.delete(n); };
  return {
    /** Attribute the time since the previous tick to the issue's previous cause, then open a segment with its current cause. */
    tick(pending, causeOf, t) {
      const keep = new Set();
      for (const n of pending) {
        const k = String(n); keep.add(k);
        if (!readyAt.has(k)) readyAt.set(k, t);
        close(k, t);
        let c = "other"; try { c = causeOf(n); } catch { /* fail-open */ }
        last.set(k, { at: t, cause: QUEUE_CAUSES.includes(c) ? c : "other" });
      }
      for (const k of [...last.keys()]) if (!keep.has(k)) close(k, t); // left the queue without take(): stop accruing
    },
    /** The issue starts: close its segment and return {total_ms, causes, ready_at}; null when it was never queued. */
    take(n, t) {
      const k = String(n); close(k, t);
      const causes = acc.get(k);
      if (!causes) return null;
      return { total_ms: Math.round(Object.values(causes).reduce((a, b) => a + b, 0)), causes: Object.fromEntries(Object.entries(causes).map(([c, v]) => [c, Math.round(v)])), ready_at: isNum(Number(readyAt.get(k))) ? Number(readyAt.get(k)) : null };
    },
    /** The issue ended for good: forget it. */
    drop(n) { const k = String(n); acc.delete(k); readyAt.delete(k); last.delete(k); },
    toJSON: () => ({ acc: Object.fromEntries(acc), readyAt: Object.fromEntries(readyAt) }),
  };
}
