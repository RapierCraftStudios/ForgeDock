// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// bin/lean/stacking.mjs — stacked lanes, phase 1 (#5831, epic #5822). A dependent whose only unmet gates are in-batch
// dependencies still pending or running is planned (contract frozen, no build) in an idle slot; its build lane later reuses
// that contract unless the dependency's merged diff made it stale. Pure: facts in, verdicts out; no I/O.

export const STACKING_MODES = ["off", "plan", "full"];

/** forge.yaml `orchestration.stacking`: off (default) | plan | full (plan lanes plus stacked builds at PR-ready, #5832); anything else is off. */
export function normalizeStacking(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "plan" || v === "full" ? v : "off";
}

/**
 * Whether `n` may run as a plan lane now: it has in-batch dependencies, at least one still unmet (pending or running, not
 * ended), none ended unsatisfied, it is not running, and it has not been planned or tried before (one plan lane per issue per batch).
 * @param {{n:number, edges:number[], results:Map, pending:number[], running:Map|Set, planTried:Set, satisfied:Set<string>}} a
 */
export function planAdmissible({ n, edges, results, pending, running, planTried, satisfied }) {
  if (!edges.length || planTried.has(n) || results.has(n) || running.has(n) || !pending.includes(n)) return false;
  let unmet = false;
  for (const d of edges) {
    const r = results.get(d);
    if (!r) { if (!pending.includes(d) && !running.has(d)) return false; unmet = true; continue; }
    if (!satisfied.has(r.outcome)) return false;
  }
  return unmet;
}

/** `--planned <hash>:<sha>` <-> {contractHash, baseSha}; null when malformed. */
export const formatPlanned = (p) => (p?.contractHash && p?.baseSha ? `${p.contractHash}:${p.baseSha}` : null);
export function parsePlanned(text) {
  const m = /^([0-9a-f]{6,64}):([0-9a-f]{7,64})$/.exec(String(text ?? "").trim());
  return m ? { contractHash: m[1], baseSha: m[2] } : null;
}

/**
 * Why a plan-lane contract cannot be reused by the build lane, or null. Stale when the frozen contract is not the planned
 * one (the scope changed and it was re-planned), when the plan's base is no longer an ancestor of the lane (lane changed),
 * or when the commits landed on the lane since the plan (the dependency's merge) touch a deliverable path.
 * @param {{planned:{contractHash:string, baseSha:string}, contractHash:string, ancestor:boolean, changedPaths:string[], deliverablePaths:string[]}} a
 */
export function planStale({ planned, contractHash, ancestor, changedPaths = [], deliverablePaths = [] }) {
  if (!planned) return "no plan";
  if (planned.contractHash !== contractHash) return `contract ${planned.contractHash} -> ${contractHash}`;
  if (!ancestor) return `lane moved: planned base ${planned.baseSha} is not an ancestor of the lane head`;
  const want = new Set(deliverablePaths);
  const hit = changedPaths.filter((p) => want.has(p));
  return hit.length ? `dependency diff touches deliverable path(s): ${hit.slice(0, 5).join(", ")}` : null;
}

/**
 * #5832 (phase 2): whether `n` may build now on its dependency's lane head. Exactly one in-batch dependency is unmerged (running, not
 * ended) and it is PR-ready (`prReady`: issue -> {pr, branch, sha}); every other dependency ended satisfied. Never for a lane that
 * is running, has a result, or was stacked before (one stacked build per issue per batch).
 * @param {{n:number, edges:number[], results:Map, pending:number[], running:Map|Set, prReady:Map, stackedTried:Set, satisfied:Set<string>}} a
 * @returns {{dependency:number, branch:string, sha:string}|null}
 */
export function stackAdmissible({ n, edges, results, pending, running, prReady, stackedTried, satisfied }) {
  if (!edges.length || stackedTried.has(n) || results.has(n) || running.has(n) || !pending.includes(n)) return null;
  let open = null;
  for (const d of edges) {
    const r = results.get(d);
    if (r) { if (!satisfied.has(r.outcome)) return null; continue; }
    if (open !== null || !running.has(d)) return null;
    open = d;
  }
  const rd = open === null ? null : prReady.get(open);
  return rd?.branch && rd?.sha ? { dependency: open, branch: String(rd.branch), sha: String(rd.sha) } : null;
}

/** `stackedOn` {dependency, branch, sha} <-> `--stacked-on <dep>:<sha>:<branch>`; null when malformed. */
export const formatStackedOn = (s) => (s?.dependency && s?.branch && s?.sha ? `${s.dependency}:${s.sha}:${s.branch}` : null);
export function parseStackedOn(text) {
  const m = /^(\d+):([0-9a-f]{7,64}):(.+)$/.exec(String(text ?? "").trim());
  return m ? { dependency: Number(m[1]), sha: m[2], branch: m[3] } : null;
}

/** Valid `stackedOn` object (from ctx/CLI) or null. */
export const validStackedOn = (s) => (Number.isInteger(s?.dependency) && typeof s?.branch === "string" && s.branch && typeof s?.sha === "string" && /^[0-9a-f]{7,64}$/.test(s.sha) ? { dependency: s.dependency, branch: s.branch, sha: s.sha } : null);

/**
 * Engine guard `merge.stacked_base` (#5832): why a PR may not be merged now, or null. A PR whose base is not the lane is a
 * stacked PR; it never merges into the dependency branch (or anything but the lane), and not while a `Depends on` is unmerged.
 * @param {{prBase:string, lane:string, stackedBranch?:string|null, dependencyMerged:boolean}} a
 */
export function stackedBaseBlock({ prBase, lane, stackedBranch = null, dependencyMerged }) {
  const stacked = Boolean(stackedBranch) || (prBase && lane && prBase !== lane);
  if (!stacked) return null;
  if (!dependencyMerged) return `merge.stacked_base: PR base ${prBase || "?"} is not the lane ${lane} and its dependency is unmerged`;
  if (prBase !== lane) return `merge.stacked_base: PR base ${prBase || "?"} is not the lane ${lane}`;
  return null;
}

/** #5833 (phase 3): cascade kinds recorded on a stacked dependent's row (`cascade`, `cascades`). */
export const CASCADES = ["rebase", "reverify", "restart", "replan"];

/**
 * Which cascade a stacked dependent needs now, or null (nothing moved). `depState`: open | merged | closed (closed = ended without a merge).
 * merged -> rebase onto the lane; closed -> replan on the lane base; open with a moved head -> reverify (clean rebase) or restart (conflict).
 * @param {{depState:string, depHeadSha?:string|null, stackedSha?:string|null, rebaseConflict?:boolean}} a
 */
export function cascadeDecision({ depState, depHeadSha = null, stackedSha = null, rebaseConflict = false }) {
  if (depState === "merged") return "rebase";
  if (depState === "closed") return "replan";
  if (depState !== "open" || !depHeadSha || !stackedSha || depHeadSha === stackedSha) return null;
  return rebaseConflict ? "restart" : "reverify";
}

/**
 * The checks the dependency's final diff invalidates: a command naming a path (token with `/`) is kept when a changed path equals it or
 * lies under it (or it lies under the changed path); a command naming no path cannot be scoped and is always kept.
 * @param {{changedPaths:string[], checks:string[]}} a
 */
export function invalidatedChecks({ changedPaths = [], checks = [] }) {
  const norm = (t) => t.replace(/^["']|["']$/g, "").replace(/^\.\//, "").replace(/\/+$/, "");
  return checks.filter((c) => {
    const toks = String(c).split(/\s+/).map(norm).filter((t) => t.includes("/") && !t.startsWith("-") && !/^[a-z]+:\/\//.test(t));
    if (!toks.length) return true;
    return toks.some((t) => changedPaths.some((p) => p === t || p.startsWith(`${t}/`) || t.startsWith(`${p}/`)));
  });
}

/** Batch-report metric: cascades per stacked dependent and the cost of the rework (rows carry `stacked`, `cascades`, `cascade_cost_usd`, `cascade_minutes`). */
export function cascadeRate(rows = []) {
  const st = rows.filter((r) => r?.stacked);
  const list = st.map((r) => (Array.isArray(r.cascades) ? r.cascades : r.cascade ? [r.cascade] : []));
  const cascades = list.reduce((s, l) => s + l.length, 0);
  const round = (x, k) => Math.round(x * k) / k;
  return { stacked: st.length, cascades, perStacked: st.length ? round(cascades / st.length, 100) : 0,
    reworkCostUsd: round(st.reduce((s, r) => s + (Number(r.cascade_cost_usd) || 0), 0), 1e6), reworkMinutes: round(st.reduce((s, r) => s + (Number(r.cascade_minutes) || 0), 0), 10) };
}

/** One report line, or null when nothing was stacked. */
export function formatCascadeSummary(rows) {
  const m = cascadeRate(rows);
  return m.stacked ? `stacked lanes: ${m.stacked} dependent(s), ${m.cascades} cascade(s) (${m.perStacked}/dependent), rework $${m.reworkCostUsd.toFixed(2)} / ${m.reworkMinutes} min` : null;
}
