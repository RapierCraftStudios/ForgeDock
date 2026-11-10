// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forgedock stats --first-merge (#5290): time from setup start to the first merged PR on a first-run repo.
 * Start = the FORGE:FIRST_RUN marker in the issues `forgedock first-run` filed (earliest wins); merge = the earliest
 * mergedAt among the PRs that closed those issues. GitHub is the register: no local state is read.
 */
import { parseFirstRunMarker } from "../first-run.mjs";

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** issues: [{number, body, closedByPullRequestsReferences: [{mergedAt}]}] -> {repo, started, merged, minutes, median_minutes, target_minutes, met}. */
export function firstMergeReport({ issues, repo = null }) {
  const marked = (issues ?? []).map((i) => ({ i, m: parseFirstRunMarker(i?.body) })).filter((x) => x.m);
  if (!marked.length) return { repo, started: null, merged: null, minutes: null, median_minutes: null, target_minutes: 15, met: null, issues: 0 };
  const started = Math.min(...marked.map((x) => Date.parse(x.m.started)));
  const merges = marked.flatMap(({ i }) => (i.closedByPullRequestsReferences ?? []).map((p) => Date.parse(p?.mergedAt)).filter(Number.isFinite));
  const merged = merges.length ? Math.min(...merges) : null;
  const minutes = merged == null ? null : Math.max(0, (merged - started) / 60000);
  return { repo, started: new Date(started).toISOString(), merged: merged == null ? null : new Date(merged).toISOString(), minutes, median_minutes: minutes, target_minutes: 15, met: minutes == null ? null : minutes <= 15, issues: marked.length };
}

/** Median over several repos' reports (those with a merge). */
export const medianMinutes = (reports) => median(reports.map((r) => r.minutes).filter((x) => x != null));

/** gh: async (args) => stdout. Unreadable output throws (never a silent "no data"). */
export async function gatherFirstRunIssues({ gh, repo }) {
  const out = await gh(["issue", "list", "-R", repo, "--state", "all", "--search", "FORGE:FIRST_RUN in:body", "--limit", "100", "--json", "number,body,closedByPullRequestsReferences"]);
  let issues;
  try { issues = JSON.parse(String(out ?? "")); } catch { throw new Error(`first-merge: unreadable gh issue list output for ${repo}`); }
  if (!Array.isArray(issues)) throw new Error(`first-merge: gh issue list for ${repo} did not return a list`);
  return issues;
}

export function renderFirstMerge(r) {
  if (!r.started) return `time to first merged PR, ${r.repo ?? "?"}: no first-run issues found (run: npx forgedock first-run)`;
  if (r.minutes == null) return `time to first merged PR, ${r.repo ?? "?"}: not merged yet (setup started ${r.started}, ${r.issues} first-run issue${r.issues === 1 ? "" : "s"})`;
  return `time to first merged PR, ${r.repo ?? "?"}: ${r.minutes.toFixed(1)} min (target <= ${r.target_minutes}: ${r.met ? "met" : "not met"}); setup ${r.started}, merged ${r.merged}`;
}
