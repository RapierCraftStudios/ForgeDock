// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Parked post-deploy follow-up sweep (#4689). A follow-up parked by the #4389 gate (`awaiting-promotion`, `awaiting-due`,
 * `awaiting-measurement`) is re-evaluated on the daemon timer, next to `sweepDue`, instead of waiting for the next batch:
 * `prefilterIssue` with `gateOnly` re-runs the same deterministic gate (git ancestry, due date, soak window, precondition,
 * named checks; no model call, no lane). A released issue loses its wait labels and is picked up by the next scheduler pass;
 * one that is still waiting is left as it is.
 */
import { prefilterIssue, lazyDefaultBranch, AWAITING_PROMOTION_LABEL, AWAITING_DUE_LABEL } from "./prefilter.mjs";
import { AWAITING_MEASUREMENT_LABEL } from "./postdeploy-check.mjs";

export const PARKED_LABELS = [AWAITING_PROMOTION_LABEL, AWAITING_DUE_LABEL, AWAITING_MEASUREMENT_LABEL];

/**
 * Re-evaluate every parked follow-up of the repo. Sequential; an error is an `error` row, never a throw.
 * Outcomes: released | closed | still-parked | skipped | error.
 */
export async function sweepParked({ repo, cwd = process.cwd(), io, defaultBranch = null, preconditionCmd = null, minAge = null, dryRun = false, onResult = null } = {}) {
  const found = new Set();
  for (const label of PARKED_LABELS) {
    try {
      const list = JSON.parse(String(await io.gh(["issue", "list", "-R", repo, "--state", "open", "--label", label, "--limit", "100", "--json", "number"])));
      for (const i of Array.isArray(list) ? list : []) if (Number.isInteger(i?.number)) found.add(i.number);
    } catch { /* one unreadable label list: the others still run */ }
  }
  const resolve = defaultBranch ?? lazyDefaultBranch({ io, repo, cwd });
  const rows = [];
  for (const issue of [...found].sort((a, b) => a - b)) {
    let row;
    try {
      const r = await prefilterIssue({ issue, repo, cwd, io, dryRun, defaultBranch: resolve, preconditionCmd, minAge, gateOnly: true });
      row = { issue, outcome: /^pre-filter error/.test(r.detail) ? "error" : r.closed ? "closed" : r.parked ? "still-parked" : /^released/.test(r.detail) ? "released" : "skipped", detail: r.detail, kind: r.kind ?? null };
    } catch (e) { row = { issue, outcome: "error", detail: String(e?.message ?? e).slice(0, 160) }; }
    rows.push(row);
    try { if (!dryRun) await onResult?.(row); } catch { /* an event sink never fails the sweep */ }
  }
  return rows;
}

/** One line, e.g. `parked: released #4 #5; closed #6`; "" when nothing changed. */
export function formatParkedSweepSummary(rows) {
  const parts = [["released", "released"], ["closed", "closed"], ["error", "error"]].map(([k, l]) => [l, (rows ?? []).filter((r) => r.outcome === k).map((r) => `#${r.issue}`)]).filter(([, a]) => a.length).map(([l, a]) => `${l} ${a.join(" ")}`);
  return parts.length ? `parked: ${parts.join("; ")}` : "";
}
