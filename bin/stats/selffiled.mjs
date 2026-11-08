// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forgedock stats --self-filed (#5207): the share of new issues the pipeline filed itself, by kind, against a 15% target.
 * The kind comes from the deterministic markers and labels the pipeline writes (scripts/file-deferred-followups.sh,
 * scripts/review-finalize.sh, bin/review-staging.mjs), never from the author: lane-created issues share the bot author.
 */

export const SELF_FILED_KINDS = Object.freeze(["follow-up", "review-finding", "staging-review", "rollup"]);
export const SELF_FILED_TARGET = 0.15;
const ROLLUP_RE = /FORGE:(POSTDEPLOY_ROLLUP|EXTERNAL_BATCH|BACKLOG_BATCH|HOST_BATCH):/;
const labelNames = (issue) => (issue?.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);

/** The pipeline-filed kind of one issue (precedence rollup, follow-up, staging-review, review-finding), else null. */
export function selfFiledKind(issue) {
  const body = String(issue?.body ?? ""), title = String(issue?.title ?? "");
  if (ROLLUP_RE.test(body)) return "rollup";
  if (body.includes("FORGE:DEFERRED_FROM") || /^follow-up:/i.test(title)) return "follow-up";
  const labels = labelNames(issue);
  if (labels.includes("staging-review")) return "staging-review";
  if (labels.includes("review-finding")) return "review-finding";
  return null;
}

/** {repo, since, total, pipeline, share, by_kind, target, met}; share is null when no issue was opened in the window. */
export function selfFiledReport({ issues, since = null, repo = null }) {
  const sinceMs = since ? Date.parse(since) : NaN;
  const inWindow = (issues ?? []).filter((i) => Number.isNaN(sinceMs) || !i?.createdAt || Date.parse(i.createdAt) >= sinceMs);
  const by_kind = Object.fromEntries(SELF_FILED_KINDS.map((k) => [k, 0]));
  for (const i of inWindow) { const k = selfFiledKind(i); if (k) by_kind[k]++; }
  const total = inWindow.length, pipeline = Object.values(by_kind).reduce((a, b) => a + b, 0);
  const share = total ? pipeline / total : null;
  return { repo, since, total, pipeline, share, by_kind, target: SELF_FILED_TARGET, met: share == null ? null : share < SELF_FILED_TARGET };
}

/** The issues created on/after `since` (YYYY-MM-DD). gh: async (args) => stdout. Unreadable output throws (never a silent 0%). */
export async function gatherIssues({ gh, repo, since }) {
  const out = await gh(["issue", "list", "-R", repo, "--state", "all", "--search", `created:>=${since}`, "--limit", "1000", "--json", "number,title,body,labels,createdAt"]);
  let issues;
  try { issues = JSON.parse(String(out ?? "")); } catch { throw new Error(`self-filed: unreadable gh issue list output for ${repo}`); }
  if (!Array.isArray(issues)) throw new Error(`self-filed: gh issue list for ${repo} did not return a list`);
  return issues;
}

const pct = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
/** One line per kind plus the total share against the target. */
export function renderSelfFiled(r) {
  const lines = [`self-filed issues, ${r.repo ?? "?"} since ${r.since ?? "?"}: ${r.total} new issue${r.total === 1 ? "" : "s"}`];
  for (const k of SELF_FILED_KINDS) lines.push(`  ${k.padEnd(15)} ${String(r.by_kind[k]).padStart(5)}  ${pct(r.total ? r.by_kind[k] / r.total : null)}`);
  lines.push(`  ${"total".padEnd(15)} ${String(r.pipeline).padStart(5)}  ${pct(r.share)} (target < ${pct(r.target)}: ${r.met == null ? "n/a" : r.met ? "met" : "not met"})`);
  return lines.join("\n");
}
