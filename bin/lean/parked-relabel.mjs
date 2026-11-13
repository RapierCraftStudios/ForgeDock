// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { parkedLabel, REMEDIATION_QUEUE_LABEL } from "../engine/outcome-codes.mjs";

/**
 * #5466: the mechanical-park relabel. Both labels are created first (`--force`); `remediation-queue` is skipped when it
 * cannot be created. Labels are added, then read back, and only then is `needs-human` removed, so a failure at any step
 * leaves the issue with `needs-human` (labels this call added are rolled back). Returns `{ ok, queued }`.
 */
export async function parkedRelabel({ gh, repo, issue, code }) {
  const parked = parkedLabel(code);
  const n = String(issue);
  try { await gh(["label", "create", parked, "-R", repo, "--force", "--color", "C5DEF5", "--description", "Mechanical park on a terminal code. Managed by ForgeDock."]); } catch { /* exists, or no rights: the add says */ }
  let queued = true;
  try { await gh(["label", "create", REMEDIATION_QUEUE_LABEL, "-R", repo, "--force", "--color", "C5DEF5", "--description", "Parked issues awaiting remediation. Managed by ForgeDock."]); } catch { queued = false; }
  const want = queued ? [parked, REMEDIATION_QUEUE_LABEL] : [parked];
  const rollback = async () => { try { await gh(["issue", "edit", n, "-R", repo, "--remove-label", want.join(",")]); } catch { /* needs-human is still on */ } };
  try {
    await gh(["issue", "edit", n, "-R", repo, "--add-label", want.join(",")]);
  } catch {
    // The add may have applied some labels: if the queue label was the problem, retry with the parked label alone.
    if (!queued) { await rollback(); return { ok: false, queued }; }
    try { await gh(["issue", "edit", n, "-R", repo, "--add-label", parked]); queued = false; } catch { await rollback(); return { ok: false, queued }; }
  }
  try {
    const names = (JSON.parse(await gh(["issue", "view", n, "-R", repo, "--json", "labels"]))?.labels ?? []).map((l) => l?.name);
    if (!names.includes(parked)) { await rollback(); return { ok: false, queued }; }
    if (queued && !names.includes(REMEDIATION_QUEUE_LABEL)) queued = false;
  } catch { await rollback(); return { ok: false, queued }; }
  try { await gh(["issue", "edit", n, "-R", repo, "--remove-label", "needs-human"]); } catch { return { ok: false, queued }; }
  return { ok: true, queued };
}

/** #5600: the labels a requeue or a merge must not leave behind (`needs-human`, `needs-human:external`, `parked:*`, `remediation-queue`). */
export const isPipelineLabel = (l) => l === "needs-human" || l === "needs-human:external" || l === REMEDIATION_QUEUE_LABEL || String(l).startsWith("parked:");

/** Removes the pipeline labels the issue carries (read back first, so nothing absent is named); best effort. Returns the removed names. */
export async function clearPipelineLabels({ gh, repo, issue, labels = null }) {
  const n = String(issue);
  try {
    const names = labels ?? (JSON.parse(await gh(["issue", "view", n, "-R", repo, "--json", "labels"]))?.labels ?? []).map((l) => l?.name);
    const stale = names.filter(isPipelineLabel);
    if (!stale.length) return [];
    await gh(["issue", "edit", n, "-R", repo, ...stale.flatMap((l) => ["--remove-label", l])]);
    return stale;
  } catch { return []; }
}
