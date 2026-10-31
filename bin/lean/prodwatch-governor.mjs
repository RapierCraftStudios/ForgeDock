// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Prod-watch governor (#4835, part of #4768): rate limits and a storm summary over validated triage clusters. Pure: the
 * clock (`now`) and the filing history (`state.filed`, ISO timestamps) are passed in; no fs, gh or exec. Keys:
 * `max_issues_per_hour` (rolling hour), `max_open_prod_issues` (standing cap) and `max_cost_usd_per_round`
 * (signal-planner's `max_cost_usd`, per poll round). A missing or invalid limit is unlimited for that key.
 */
const HOUR_MS = 3600000;
const CLASS_RANK = { incident: 0, defect: 1 };
const SEV_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

const limit = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" && Number(v) >= 0 ? Number(v) : Infinity);
const toMs = (t) => { const n = t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t); return Number.isFinite(n) ? n : null; };

function byPriority(a, b) {
  return (CLASS_RANK[a.class] ?? 2) - (CLASS_RANK[b.class] ?? 2)
    || (SEV_RANK[a.severity] ?? 4) - (SEV_RANK[b.severity] ?? 4)
    || (b.count ?? 0) - (a.count ?? 0)
    || String(a.fingerprint).localeCompare(String(b.fingerprint));
}

/**
 * `{file, summary}`: `file` is the clusters to open issues for (incidents before defects, then severity, then size);
 * `summary` is `null` or ONE `{title, body}` listing every deferred cluster. Candidates are fileable, non-duplicate,
 * non-expected-class clusters. The budget is the smallest of the hourly, open-issue and cost allowances; cost per
 * cluster is `cluster.cost_usd ?? governor.cost_per_issue_usd ?? 0` (0 leaves the cost cap unused).
 */
export function admit(clusters, { governor = {}, state = {}, openProdIssues = [], now } = {}) {
  const nowMs = toMs(now) ?? 0;
  const cands = (Array.isArray(clusters) ? clusters : [])
    .filter((c) => c && c.fileable !== false && c.duplicateOf == null && c.class !== "expected-class")
    .sort(byPriority);
  const filedRecent = (Array.isArray(state?.filed) ? state.filed : []).filter((t) => { const m = toMs(t && typeof t === "object" && !(t instanceof Date) ? t.at : t); return m != null && m > nowMs - HOUR_MS && m <= nowMs; }).length;
  const open = Array.isArray(openProdIssues) ? openProdIssues.length : Number(openProdIssues) || 0;
  const maxHour = limit(governor?.max_issues_per_hour), maxOpen = limit(governor?.max_open_prod_issues), maxCost = limit(governor?.max_cost_usd_per_round);
  const defaultCost = Number(governor?.cost_per_issue_usd) > 0 ? Number(governor.cost_per_issue_usd) : 0;
  let spent = 0;
  const file = [], deferred = [];
  for (const c of cands) {
    const cost = Number(c.cost_usd) > 0 ? Number(c.cost_usd) : defaultCost;
    let why = null;
    if (maxHour - filedRecent - file.length <= 0) why = "max_issues_per_hour";
    else if (maxOpen - open - file.length <= 0) why = "max_open_prod_issues";
    else if (spent + cost > maxCost) why = "max_cost_usd_per_round";
    if (why) deferred.push({ c, why }); else { file.push(c); spent += cost; }
  }
  if (!deferred.length) return { file, summary: null };
  const lines = deferred.map(({ c, why }) => `- ${c.class ?? "defect"} ${c.severity ?? "unknown"} x${c.count ?? 1}: ${String(c.signals?.[0]?.title ?? c.fingerprint).replace(/\s+/g, " ").slice(0, 120)} (seen ${c.first_seen ?? "?"} .. ${c.last_seen ?? "?"}; deferred by ${why})`);
  return {
    file,
    summary: {
      title: `prod-watch: ${deferred.length} cluster(s) deferred by the governor`,
      body: `The governor admitted ${file.length} cluster(s) this round and deferred ${deferred.length} instead of filing them one by one.\n\n${lines.join("\n")}\n\nDeferred clusters carry no signal reference, so a later round re-admits them when the limits allow.`,
    },
  };
}
