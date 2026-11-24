// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5759: merge evidence for an OPEN issue, so no park writer labels a delivered issue and a repair pass clears the park labels a
 * merged issue still carries. Evidence is a merged PR on any head (closing references on the issue, `FORGE:STATE.pr`) or the
 * `workflow:merged` label. An issue reopened after the merge (a failed acceptance probe, #4500) is new work: no evidence.
 * Gh is injected; anything unreadable is "no evidence" (the park proceeds as before).
 */
import { stateOf } from "./context.mjs";
import { clearPipelineLabels, pipelineLabels } from "./statuscomment.mjs";

const MERGED_LABEL = "workflow:merged";
const nameOf = (l) => (typeof l === "string" ? l : l?.name);

/** Latest event times (ms) from the issue events: `{reopened, merged}` (0 = none), null when unreadable. */
async function eventTimes({ gh, repo, issue }) {
  try {
    const out = String(await gh(["api", `repos/${repo}/issues/${issue}/events`, "--paginate", "--jq", '.[] | [.event, .created_at, (.label.name // "")] | @tsv']));
    const t = { reopened: 0, merged: 0 };
    for (const line of out.split("\n")) {
      const [ev, at, name] = line.split("\t");
      const ms = Date.parse(at);
      if (!Number.isFinite(ms)) continue;
      if (ev === "reopened") t.reopened = Math.max(t.reopened, ms);
      if (ev === "labeled" && name === MERGED_LABEL) t.merged = Math.max(t.merged, ms);
    }
    return t;
  } catch { return null; }
}

/**
 * `{source, pr?}` when the open issue's fix merged and was not reopened afterwards, else null. `view` is an already-read
 * `{state, body, labels, closedByPullRequestsReferences}` (read here when null).
 */
export async function mergedEvidence({ gh, repo, issue, view = null }) {
  try {
    const v = view ?? JSON.parse(String(await gh(["issue", "view", String(issue), "-R", repo, "--json", "state,body,labels,closedByPullRequestsReferences"])));
    const labelled = (v?.labels ?? []).map(nameOf).includes(MERGED_LABEL);
    const cand = new Set([...(v?.closedByPullRequestsReferences ?? []).map((p) => p?.number), stateOf(v?.body)?.pr].map(Number).filter(Number.isInteger));
    let pr = null, mergedAt = 0;
    for (const n of cand) {
      try {
        const p = JSON.parse(String(await gh(["pr", "view", String(n), "-R", repo, "--json", "state,mergedAt"])));
        const at = Date.parse(p?.mergedAt ?? "");
        if (String(p?.state).toUpperCase() === "MERGED" && Number.isFinite(at) && (pr === null || at > mergedAt)) { pr = n; mergedAt = at; }
      } catch { /* an unreadable PR is not evidence */ }
    }
    if (pr === null && !labelled) return null;
    const t = await eventTimes({ gh, repo, issue });
    if (t === null) return null;
    const at = pr !== null ? mergedAt : t.merged;
    if (t.reopened > 0 && (at === 0 || t.reopened > at)) return null;
    return pr !== null ? { source: "pr", pr } : { source: "label" };
  } catch { return null; }
}

/**
 * Open issues carrying `workflow:merged` plus a pipeline label (needs-human*, parked:*, remediation-queue) are inconsistent: the park
 * labels come off unless the issue was reopened after the merge. `issues` is a list of `{number, labels}` (listed through the issues API when null; its pull requests are skipped).
 * @returns {Promise<{issue:number, flagged:string[], removed:string[]}[]>} one row per repaired issue.
 */
export async function repairMergedParked({ gh, repo, issues = null, onFail = null }) {
  let list = issues;
  if (!list) {
    try { list = JSON.parse(String(await gh(["api", `repos/${repo}/issues?state=open&labels=${encodeURIComponent(MERGED_LABEL)}&per_page=100`]))); } catch { return []; }
  }
  const out = [];
  for (const i of Array.isArray(list) ? list : []) {
    const flagged = pipelineLabels(i?.labels);
    if (!flagged.length || !Number.isInteger(i?.number) || i.pull_request) continue;
    if (!(await mergedEvidence({ gh, repo, issue: i.number, view: { labels: i.labels } }))) continue;
    const removed = await clearPipelineLabels({ gh, repo, issue: i.number, labels: i.labels, onFail });
    out.push({ issue: i.number, flagged, removed });
  }
  return out;
}
