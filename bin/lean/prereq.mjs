// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Dependency-ordered admission (#5340): a declared prerequisite (`Depends on #N`) outside the batch is open on GitHub, so
 * a run of the dependent can only end `dependency-open` and is retried. Orchestrate pulls such a prerequisite into the
 * batch up front, so its DAG orders it first, instead of discovering it after a wasted run. A closed prerequisite is
 * satisfied; a `needs-human` one is parked and not pulled in (the engine's own admission still refuses the dependent).
 * Fail-open: an unreadable state or label adds nothing. Probes are injected.
 */

/**
 * @param {{deps:number[], inBatch:(n:number)=>boolean, results?:Map<number,object>, issueState?:Function, issueLabels?:Function}} p
 * @returns {Promise<{pull:number[], parked:number[]}>} open prerequisites to add to the batch, and parked ones left out
 */
export async function openPrerequisites({ deps = [], inBatch, results = new Map(), issueState = null, issueLabels = null }) {
  const pull = [], parked = [];
  if (typeof issueState !== "function") return { pull, parked }; // no state probe: nothing is known to be open
  for (const d of [...new Set(deps)]) {
    if (inBatch(d) || results.has(d)) continue;
    let st = "";
    try { st = String((await issueState(d)) ?? "").toUpperCase(); } catch { st = ""; }
    if (st !== "OPEN") continue; // closed (satisfied) or unreadable (fail-open)
    let names = [];
    try { names = typeof issueLabels === "function" ? ((await issueLabels(d)) ?? []) : []; } catch { names = []; }
    (Array.isArray(names) && names.includes("needs-human") ? parked : pull).push(d);
  }
  return { pull, parked };
}
