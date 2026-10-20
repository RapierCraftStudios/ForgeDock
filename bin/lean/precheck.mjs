// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pre-PR declared check commands (#4240), one round (#4331): the commands run concurrently up to the host worker cap
 * (the caller holds one heavy-step slot for the whole round), each timed, inside one total budget. A command that never
 * started before the budget ran out, or that the budget cut short, is left to CI (`deferred-to-ci`), never a failure.
 * Repo-agnostic: commands are opaque `bash -c` strings run through the injected `run`.
 */

/** rc of a command killed by its timeout (effects.mjs runCheckCommand). */
const TIMEOUT_RC = 124;

/**
 * @param {{commands:string[], parallelism?:number, budgetMs:number, perCommandMs:number, now?:() => number,
 *   run:(a:{command:string, timeoutMs:number}) => Promise<{rc:number, output?:string}>}} p
 * @returns {Promise<{results:{command:string, rc:number, output:string, ms:number}[], deferred:string[], ms:number}>}
 *   results in input order (commands that ran and were not cut by the budget); deferred in input order
 */
export async function runChecks({ commands, parallelism = 1, budgetMs, perCommandMs, now = () => Date.now(), run }) {
  const list = Array.isArray(commands) ? commands : [];
  const workers = Math.max(1, Math.floor(Number(parallelism)) || 1);
  const start = now(), deadline = start + (Number(budgetMs) > 0 ? Number(budgetMs) : 0);
  const per = Number(perCommandMs) > 0 ? Number(perCommandMs) : Infinity;
  const slots = new Array(list.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++, command = list[i], left = deadline - now();
      if (left <= 0) { slots[i] = { deferred: true }; continue; }
      const timeoutMs = Math.min(per, left), t = now();
      let r;
      try { r = await run({ command, timeoutMs }); } catch (e) { r = { rc: 127, output: String(e?.message ?? e) }; }
      const rc = Number.isInteger(r?.rc) ? r.rc : 1;
      // the budget, not the command's own timeout, cut it short: CI runs it
      if (rc === TIMEOUT_RC && timeoutMs < per) { slots[i] = { deferred: true }; continue; }
      slots[i] = { command, rc, output: String(r?.output ?? ""), ms: Math.max(0, now() - t) };
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, list.length) }, worker));
  const results = [], deferred = [];
  slots.forEach((s, i) => { if (s?.deferred) deferred.push(list[i]); else if (s) results.push(s); });
  return { results, deferred, ms: Math.max(0, now() - start) };
}

/**
 * #4331 batch-report line: pre-PR check wall time summed over the rows' `precheck_ms`, and the commands deferred to CI
 * (`precheck_deferred`). Null when no lane ran pre-PR checks.
 */
export function formatPrecheckSummary(rows) {
  const ran = (rows ?? []).filter((r) => Number.isFinite(r?.precheck_ms) && r.precheck_ms >= 0);
  if (!ran.length) return null;
  const ms = ran.reduce((a, r) => a + r.precheck_ms, 0);
  const deferred = ran.reduce((a, r) => a + (Number.isInteger(r.precheck_deferred) ? r.precheck_deferred : 0), 0);
  return `precheck: ${(ms / 60000).toFixed(1)}m total over ${ran.length} lane${ran.length === 1 ? "" : "s"}${deferred ? `, ${deferred} deferred to CI` : ""}`;
}
