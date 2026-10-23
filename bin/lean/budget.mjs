// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Per-size implement turn budgets (#4392). A lane's size comes from facts, never a model: a `size:S|M|L` issue label,
 * else the frozen contract's distinct deliverable paths (S <= 2, M <= 5, else L). The budget for the size is forge.yaml
 * `engine.turn_budget_s|m|l` (defaults 25/60/100; 0 disables that size). The implement stage (the build call and its
 * context/timeout restarts) spends it; on overrun the builder gets one wrap-up grant to finish or stop with a digest, and
 * an unfinished lane ends the non-human `budget-exceeded` reason (code `budget.exceeded`, #4505): the batch recovers it once
 * from the checkpoint at the next size (`recoverySize`); only a final recovery that overruns too ends needs-human. Pure module: no I/O.
 */

export const TURN_BUDGET_DEFAULTS = Object.freeze({ S: 25, M: 60, L: 100 });
export const SIZES = Object.freeze(["S", "M", "L"]);
/** Max chars of the builder's digest carried into the needs-human detail. */
export const DIGEST_MAX = 1500;

/** forge.yaml engine section -> {S, M, L} budgets; a missing or junk key keeps its default. null when no key is set (callers use the defaults). */
export function parseTurnBudgets(engine) {
  if (!engine || typeof engine !== "object") return null;
  const out = { ...TURN_BUDGET_DEFAULTS };
  let set = false;
  for (const s of SIZES) {
    const v = String(engine[`turn_budget_${s.toLowerCase()}`] ?? "").trim();
    if (/^\d+$/.test(v)) { out[s] = Number(v); set = true; }
  }
  return set ? out : null;
}

/** "S" | "M" | "L" for a lane: a `size:X` label wins, else the contract's distinct deliverable paths. null without either. */
export function laneSize({ contract = null, labels = [] } = {}) {
  for (const l of Array.isArray(labels) ? labels : []) {
    const m = /^size[:/]\s*([SML])$/i.exec(String(l?.name ?? l ?? "").trim());
    if (m) return m[1].toUpperCase();
  }
  if (!contract || !Array.isArray(contract.deliverables)) return null;
  const n = new Set(contract.deliverables.map((d) => d?.path).filter((p) => typeof p === "string" && p.trim())).size;
  return n <= 2 ? "S" : n <= 5 ? "M" : "L";
}

/** #4505: the next size up (S -> M -> L; L stays L); anything else unchanged. */
export const nextSize = (size) => (SIZES.includes(size) ? SIZES[Math.min(SIZES.indexOf(size) + 1, SIZES.length - 1)] : size);
/** #4505: a `budget.exceeded` recovery lane runs at the next size's budget; any other lane keeps its size. */
export const recoverySize = (size, recover) => (recover?.code === "budget.exceeded" ? nextSize(size) : size);

/** Turns the wrap-up call may use after the budget is spent. */
export const wrapupGrant = (budget) => Math.max(5, Math.ceil(budget / 5));

/**
 * Lane turn accounting. `note(turns, build)` adds one builder attempt's turns (build: it ran in the implement stage);
 * `remaining()` is the implement budget left (Infinity when off or unsized); `record()` rides on the lane result and
 * RUN_TERMINAL ({size, budget, build, total, exceeded}), null while the lane is unsized.
 */
export function makeTurnBudget(budgets = TURN_BUDGET_DEFAULTS) {
  const b = { ...TURN_BUDGET_DEFAULTS, ...(budgets ?? {}) };
  let size = null, build = 0, total = 0, exceeded = false;
  const budget = () => (size && Number.isFinite(b[size]) && b[size] > 0 ? b[size] : 0);
  return {
    setSize(s) { if (SIZES.includes(s)) size = s; },
    get size() { return size; },
    budget,
    on: () => budget() > 0,
    note(turns, isBuild) { const t = Number.isFinite(turns) && turns > 0 ? turns : 0; total += t; if (isBuild) build += t; },
    remaining: () => (budget() > 0 ? budget() - build : Infinity),
    markExceeded() { exceeded = true; },
    record: () => (size ? { size, budget: budget(), build, total, exceeded } : null),
  };
}

/** The needs-human detail: the builder's digest (capped), else the diff stat and the last self-check state. */
export function budgetDigest({ size, budget, used, digest = null, stat = "", check = null }) {
  const head = `Implement turn budget spent (size ${size}, ${budget} turns; ${used} used) and the wrap-up did not finish; work is checkpointed on the lane branch.`;
  const d = typeof digest === "string" && digest.trim() ? digest.trim().slice(0, DIGEST_MAX) : null;
  if (d) return `${head}\n\nBuilder digest:\n${d}`;
  return `${head}\n\nNo builder digest; changes so far:\n${String(stat || "(no diff)").trim().slice(0, DIGEST_MAX)}${check ? `\nLast self-check: ${check}` : ""}`;
}

const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))];
/**
 * Batch-report line (#4392): implement turns per size over the merged rows (`turns.build`), then the lanes that went
 * over budget. null when no row carries turns.
 */
export function formatTurnSummary(rows) {
  const withTurns = (rows ?? []).filter((r) => r?.turns && SIZES.includes(r.turns.size));
  if (!withTurns.length) return null;
  const parts = [];
  for (const s of SIZES) {
    const merged = withTurns.filter((r) => r.outcome === "merged" && r.turns.size === s);
    if (!merged.length) continue;
    const xs = merged.map((r) => Number(r.turns.build) || 0).sort((a, c) => a - c);
    const budget = Number(merged[0].turns.budget) || 0;
    parts.push(`${s} n=${xs.length} p50 ${pct(xs, 0.5)} max ${xs[xs.length - 1]}/${budget > 0 ? budget : "off"}`);
  }
  const over = withTurns.filter((r) => r.turns.exceeded).map((r) => `#${r.issue} (${r.turns.size} ${r.turns.budget})`);
  return `turns by size: ${parts.join("; ") || "no merged lanes"}${over.length ? `; over budget: ${over.join(" ")}` : ""}`;
}
