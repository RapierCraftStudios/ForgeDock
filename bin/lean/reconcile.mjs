// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5978: standing orders. A batch started with `--select <query>` keeps owning every open issue the selector matches:
// matching issues join, closed or moved ones leave, and an issue that ended deferred / held / engine-error / conformance-failed is
// re-admitted by policy instead of by an operator. Pure helpers; the runner (orchestrate.mjs) feeds the results through its
// existing add/requeue seams (the query is issue-watch's `search` selector, handed to gh unchanged, K2; no import, so batch.mjs can use this module), so the DAG, priority and lane rules are the ones a `--add` already gets (K1).

/** How often the runner re-reads the selector ("every few minutes"). */
export const RECONCILE_MS = 3 * 60 * 1000;
/** Deferred issues retry with exponential backoff from this base, capped at DEFER_CAP_MS. */
export const DEFER_BASE_MS = 5 * 60 * 1000;
export const DEFER_CAP_MS = 2 * 60 * 60 * 1000;
/** A held / engine-error issue is a fresh attempt after this cooldown even if no version moved. */
export const HELD_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/** The breaker auto-resets after this cooldown when its failures were environmental. */
export const BREAKER_COOLDOWN_MS = 15 * 60 * 1000;

/** gh args listing the open issues `select` matches (a GitHub search query: `no:milestone`, `milestone:X`, `label:Y`). */
export const selectArgs = (repo, select) => ["issue", "list", "-R", repo, "--state", "open", "--search", String(select), "--limit", "500", "--json", "number,labels,milestone,title"];

/** Open issue numbers (and labels) from the `gh issue list --json` output; null when it cannot be read (nobody leaves on a failed read). */
export function parseSelected(text) {
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(v)) return null;
  return v.filter((x) => Number.isSafeInteger(x?.number) && x.number > 0).map((x) => ({ number: x.number, labels: (x.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean) }));
}

/**
 * Diff the selector result against batch membership.
 * @returns {{join:number[], leave:number[]}} join: open matches not in the batch; leave: pending members (not running, no result row) no longer open/matching
 */
export function diffSelection({ open, members, pending, running, results }) {
  const have = new Set(members), now = new Set(open.map((o) => o.number));
  const join = [...now].filter((n) => !have.has(n)).sort((a, b) => a - b);
  const leave = pending.filter((n) => !now.has(n) && !running.has(n) && !results.has(n));
  return { join, leave };
}

/** Human codes (credentials, spend, customer, promotion, product decision): the only reasons an issue may stay unscheduled. */
const HUMAN = /\b(credentials?|secrets?\b.*\b(needed|missing|required)|api[ -]?keys?|spend|billing|payment|budget approval|customers?|promotion|promote|product decision|needs?[- ]decision|human[- ]code)\b/i;
export const HUMAN_LABEL = /^(human[:/-].+|needs?-(credentials|spend|customer|promotion|product-decision))$/i;
export const humanCode = (row, labels = []) => labels.some((l) => HUMAN_LABEL.test(l)) || (row?.outcome === "needs-human" && !row?.conformance && HUMAN.test(String(row?.detail ?? "")));

/** Failure details that are environmental (VM restart, mirror, network): a breaker tripped by them may close itself (#5947 classes). */
export const environmentalDetail = (detail) => /\b(vm (restart|reboot)|restart(ed|ing)|mirror|network|dns|econn(reset|refused)|etimedout|connection (reset|refused|timed out)|net\.transient|sandbox\.lost|unreachable)\b/i.test(String(detail ?? ""));

/** @returns {number} ms to wait before deferred attempt number `n` (0-based) is retried */
export const backoffMs = (n) => Math.min(DEFER_CAP_MS, DEFER_BASE_MS * 2 ** Math.max(0, Math.min(n, 16)));

/**
 * Re-admission policy for rows that ended without success. `state` is `Map<issue, {n, since, version, base, conformanceTried}>`
 * (kept in batch state); it is updated in place. Returns the issues to requeue with the reason, and the parked "needs decision" list.
 * @param {{results:Map<number,object>, state:Map<number,object>, now:number, version:string|null, base:string|null, labels?:(n:number)=>string[]}} p
 */
export function readmitDue({ results, state, now, version = null, base = null, labels = () => [] }) {
  const requeue = [], parked = [];
  for (const [n, row] of results) {
    const o = row?.outcome;
    const isConf = Boolean(row?.conformance) && o === "needs-human";
    if (!["deferred", "held", "engine-error"].includes(o) && !isConf) { state.delete(n); continue; }
    if (humanCode(row, labels(n))) continue;
    let s = state.get(n);
    if (!s || s.outcome !== o) { s = { n: s?.n ?? 0, since: now, version, base, outcome: o, conformanceTried: s?.conformanceTried ?? 0 }; state.set(n, s); }
    if (o === "deferred") {
      if (now - s.since >= backoffMs(s.n)) { requeue.push({ issue: n, reason: `deferred: retry ${s.n + 1} after backoff (cap ${DEFER_CAP_MS / 3600000} h)` }); state.set(n, { ...s, n: s.n + 1, since: now, outcome: null }); }
    } else if (isConf) {
      if (s.conformanceTried >= 1) { parked.push({ issue: n, why: "conformance failed after one retry on a moved base" }); continue; }
      if (base && s.base && base !== s.base) { requeue.push({ issue: n, reason: "conformance: one more attempt, the base moved" }); state.set(n, { ...s, conformanceTried: s.conformanceTried + 1, since: now, outcome: null, base }); }
      else if (!s.base && base) state.set(n, { ...s, base });
    } else {
      const moved = version && s.version && version !== s.version;
      if (moved || now - s.since >= HELD_COOLDOWN_MS) { requeue.push({ issue: n, reason: moved ? `${o}: agent/lane-image version changed` : `${o}: cooldown elapsed, fresh attempt` }); state.set(n, { ...s, since: now, version, outcome: null }); }
    }
  }
  return { requeue, parked };
}

/**
 * The breaker may close itself: an environmental failure signature, the cooldown elapsed and the pool healthy again.
 * (Lives in clear-breaker.mjs as `decideAutoReset`; re-exported here for the policy tests.)
 */
export { decideAutoReset } from "./clear-breaker.mjs";

/** One "needs decision" digest for the parked issues: a single decision body, empty string when nothing is parked. */
export const needsDecisionDigest = (parked) => (parked.length ? `needs decision (${parked.length}): ${parked.map((p) => `#${p.issue} (${p.why})`).join("; ")}` : "");

/** Whether a merge into `lane` leaves the issue open on GitHub (`Closes` only fires on the default branch): staging / milestone lanes. */
export const closesManually = (lane, defaultBranch = "main") => Boolean(lane) && lane !== defaultBranch && /^(staging|milestone\/|release\/|lane\/)/.test(String(lane));
