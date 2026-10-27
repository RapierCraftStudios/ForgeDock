/**
 * forge#4656: ship-gate watchdog. A gate (a settle pass, a hold list, `/milestone ship` pre-flight) that waits on an issue the
 * scheduler will not admit never resolves; this pure module names those waits so the batch reports `GATE_DEADLOCK` within one pass
 * instead of polling silently. No I/O.
 */

/**
 * `gates`: [{ name, waitsOn: [issue...], since?: ms }]; `admissible(n)`: true when the scheduler could still run or finish `n`;
 * `now`: ms. Returns one { issue, gate, ageMs } per (gate, issue) wait that cannot resolve, in gate order.
 */
export function detectGateDeadlock({ gates, admissible, now = Date.now(), firstSeen = null }) {
  const out = [];
  for (const g of Array.isArray(gates) ? gates : []) {
    for (const n of Array.isArray(g?.waitsOn) ? g.waitsOn : []) {
      let ok = true;
      try { ok = admissible(n) !== false; } catch { ok = true; }
      if (ok) continue;
      const key = `${g.name}#${n}`;
      if (firstSeen && !firstSeen.has(key)) firstSeen.set(key, Number.isFinite(g.since) ? g.since : now);
      const since = firstSeen?.get(key) ?? (Number.isFinite(g.since) ? g.since : now);
      out.push({ issue: n, gate: String(g.name), ageMs: Math.max(0, now - since) });
    }
  }
  return out;
}

/** One `pipeline-status` line: `GATE_DEADLOCK issue=#N gate=G age=12m`. */
export function formatGateDeadlock(d) {
  const m = Math.round((Number(d.ageMs) || 0) / 60000);
  return `GATE_DEADLOCK issue=#${d.issue} gate=${d.gate} age=${m}m`;
}
