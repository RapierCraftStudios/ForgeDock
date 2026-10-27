/**
 * scripts/settle-scope.mjs — scope freeze and convergence for a milestone's settle (#4665). Pure, no I/O, no LLM.
 *
 * Settle (run the batch, re-check buildable, repeat) freezes the milestone's issue set when it begins. Issues filed
 * later are classified by source: decomposition children of a frozen issue stay in the milestone (the parent's
 * contract) and join the measured set; deferred follow-ups go to the next milestone or the backlog; review findings
 * and anything else are counted as growth but are not part of the measured set.
 */

const DEFERRED_FROM_RE = /<!--\s*FORGE:DEFERRED_FROM:\s*#(\d+)\s*-->/;
const FINDING_RE = /<!--\s*FORGE:REVIEW_FINDING\b|\breview[- ]finding\b/i;

export const SOURCES = ["decomposition-child", "deferred-followup", "review-finding", "other"];

/** The issue numbers open or closed in the milestone when settle begins. @param {Array<{number:number}|number>} issues */
export function freezeScope(issues) {
  return new Set((issues ?? []).map((i) => (typeof i === "number" ? i : i?.number)).filter(Number.isSafeInteger));
}

/**
 * @param {{ issue: { number: number, body?: string, parent?: number|null }, measured: Set<number>, decomposedParents?: Set<number> }} a
 * `measured` is the frozen set plus the children already admitted; `decomposedParents` the issues that were decomposed.
 * `issue.parent` is the decomposed parent when known (e.g. from the engine's decompose record).
 * @returns {{ source: string, target: "milestone"|"next-milestone-or-backlog"|"unchanged" }}
 */
export function classifyNew({ issue, measured, decomposedParents = new Set() }) {
  const body = String(issue?.body ?? "");
  const parent = Number.isSafeInteger(issue?.parent) ? issue.parent : null;
  if (parent !== null && measured.has(parent) && (decomposedParents.size === 0 || decomposedParents.has(parent))) {
    return { source: "decomposition-child", target: "milestone" };
  }
  if (DEFERRED_FROM_RE.test(body)) return { source: "deferred-followup", target: "next-milestone-or-backlog" };
  if (FINDING_RE.test(body)) return { source: "review-finding", target: "unchanged" };
  return { source: "other", target: "unchanged" };
}

/**
 * Convergence on the frozen set plus the (transitive) children of decomposed issues in it.
 * @param {{ frozen: Set<number>, current: Array<{ number: number, state?: string, body?: string, parent?: number|null }>, decomposedParents?: Set<number> }} a
 * @returns {{ measured: number[], open: number[], grew: number, bySource: Record<string, number[]>, converged: boolean }}
 */
export function convergence({ frozen, current, decomposedParents = new Set() }) {
  const measured = new Set(frozen);
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, []]));
  const fresh = (current ?? []).filter((i) => !frozen.has(i.number));
  // Children can be filed under children: admit until no more join.
  let changed = true;
  const seen = new Set();
  while (changed) {
    changed = false;
    for (const it of fresh) {
      if (seen.has(it.number)) continue;
      const c = classifyNew({ issue: it, measured, decomposedParents });
      if (c.source !== "decomposition-child") continue;
      seen.add(it.number); measured.add(it.number); bySource[c.source].push(it.number); changed = true;
    }
  }
  for (const it of fresh) {
    if (seen.has(it.number)) continue;
    bySource[classifyNew({ issue: it, measured, decomposedParents }).source].push(it.number);
  }
  const open = (current ?? []).filter((i) => measured.has(i.number) && String(i.state ?? "OPEN").toUpperCase() !== "CLOSED").map((i) => i.number);
  const grew = SOURCES.reduce((n, s) => n + bySource[s].length, 0);
  return { measured: [...measured], open, grew, bySource, converged: open.length === 0 };
}

/** The STOP report text: how much the set grew and where the new issues came from. */
export function formatStopReport({ frozen, result, passes = null, limit = null }) {
  const parts = SOURCES.filter((s) => result.bySource[s].length).map((s) => `${s} ${result.bySource[s].length} (${result.bySource[s].map((n) => `#${n}`).join(", ")})`);
  const pass = passes !== null && limit !== null ? ` after ${passes}/${limit} passes` : "";
  const open = result.open.map((n) => `#${n}`).join(", ") || "none";
  return `settle STOP${pass}: ${result.open.length} open in the measured set (${open}); frozen ${frozen.size}, set grew by ${result.grew}`
    + (parts.length ? `: ${parts.join("; ")}` : "");
}
