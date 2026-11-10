// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forgedock stats --origin (#5294): requested vs pipeline-generated work. Every issue opened in the window is classed by
 * deterministic markers and labels (selfFiledKind, the FORGE:PRODWATCH marker, the author's bot flag), never guessed:
 * an issue without positive evidence stays "unknown". Pipeline-originated issues also report how they closed and their
 * cost share, from the trusted FORGE:TELEMETRY runs (an issue with no recorded cost is counted apart, never as $0).
 */
import { selfFiledKind } from "./selffiled.mjs";

export const ORIGINS = Object.freeze(["requested", "production", "review-finding", "follow-up", "unknown"]);
export const PIPELINE_ORIGINS = Object.freeze(["production", "review-finding", "follow-up"]);
export const OUTCOMES = Object.freeze(["merged", "closed-invalid", "other-closed", "open"]);
const PRODWATCH_RE = /<!--\s*FORGE:PRODWATCH\b/;
const INVALID_LABELS = new Set(["invalid", "duplicate", "wontfix"]);
const labelNames = (issue) => (issue?.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);

/** requested | production | review-finding | follow-up | unknown. Pipeline markers win; a human (non-bot) author is the requested evidence. */
export function originKind(issue) {
  if (PRODWATCH_RE.test(String(issue?.body ?? "")) || labelNames(issue).includes("prod-watch")) return "production";
  const k = selfFiledKind(issue);
  if (k === "review-finding" || k === "staging-review") return "review-finding";
  if (k === "follow-up" || k === "rollup") return "follow-up";
  const a = issue?.author;
  return a && a.is_bot === false ? "requested" : "unknown";
}

/** merged | closed-invalid | other-closed | open. `run` is the issue's telemetry run (reason "merged" wins over a bare close). */
export function outcomeOf(issue, run = null) {
  if (String(issue?.state ?? "").toUpperCase() !== "CLOSED") return "open";
  const reason = String(issue?.stateReason ?? "").toUpperCase();
  if (run?.reason === "merged") return "merged";
  if (reason === "NOT_PLANNED" || reason === "DUPLICATE" || labelNames(issue).some((l) => INVALID_LABELS.has(l))) return "closed-invalid";
  return reason === "COMPLETED" ? "merged" : "other-closed";
}

const runUsd = (run) => {
  const v = Object.values(run?.phases ?? {}).map((p) => p.usd).filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};

/** {repo, since, total, by_origin:{o:{count, cost_usd, cost_unknown, outcomes}}, cost_usd, pipeline:{count, cost_usd, cost_share}}. */
export function originReport({ issues, runs = [], since = null, repo = null }) {
  const sinceMs = since ? Date.parse(since) : NaN;
  const inWindow = (issues ?? []).filter((i) => !i?.isPr && (Number.isNaN(sinceMs) || !i?.createdAt || Date.parse(i.createdAt) >= sinceMs));
  const runOf = new Map((runs ?? []).filter((r) => r?.issue != null).map((r) => [Number(r.issue), r]));
  const by_origin = Object.fromEntries(ORIGINS.map((o) => [o, { count: 0, cost_usd: 0, cost_unknown: 0, outcomes: Object.fromEntries(OUTCOMES.map((x) => [x, 0])) }]));
  for (const i of inWindow) {
    const o = by_origin[originKind(i)], run = runOf.get(Number(i.number));
    o.count++;
    o.outcomes[outcomeOf(i, run)]++;
    const usd = runUsd(run);
    if (usd == null) o.cost_unknown++; else o.cost_usd += usd;
  }
  const cost_usd = ORIGINS.reduce((a, k) => a + by_origin[k].cost_usd, 0);
  const pCount = PIPELINE_ORIGINS.reduce((a, k) => a + by_origin[k].count, 0), pCost = PIPELINE_ORIGINS.reduce((a, k) => a + by_origin[k].cost_usd, 0);
  return { repo, since, total: inWindow.length, by_origin, cost_usd, pipeline: { count: pCount, cost_usd: pCost, cost_share: cost_usd > 0 ? pCost / cost_usd : null } };
}

/** Issues created on/after `since` with state and close reason. gh: async (args) => stdout. Unreadable output throws. */
export async function gatherOriginIssues({ gh, repo, since }) {
  const out = await gh(["issue", "list", "-R", repo, "--state", "all", "--search", `created:>=${since}`, "--limit", "1000", "--json", "number,title,body,labels,createdAt,closedAt,state,stateReason,author"]);
  let issues;
  try { issues = JSON.parse(String(out ?? "")); } catch { throw new Error(`origin: unreadable gh issue list output for ${repo}`); }
  if (!Array.isArray(issues)) throw new Error(`origin: gh issue list for ${repo} did not return a list`);
  return issues;
}

const pct = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const usd = (x) => `$${x.toFixed(2)}`;
export function renderOrigin(r) {
  const lines = [`issue origin, ${r.repo ?? "?"} since ${r.since ?? "?"}: ${r.total} issue${r.total === 1 ? "" : "s"}`,
    `  ${"origin".padEnd(15)} ${"count".padStart(5)} ${"cost".padStart(9)} ${"no-cost".padStart(7)}  outcomes (merged/invalid/other/open)`];
  for (const k of ORIGINS) {
    const o = r.by_origin[k];
    lines.push(`  ${k.padEnd(15)} ${String(o.count).padStart(5)} ${usd(o.cost_usd).padStart(9)} ${String(o.cost_unknown).padStart(7)}  ${OUTCOMES.map((x) => o.outcomes[x]).join("/")}`);
  }
  lines.push(`  pipeline-originated: ${r.pipeline.count} issue${r.pipeline.count === 1 ? "" : "s"}, ${usd(r.pipeline.cost_usd)} of ${usd(r.cost_usd)} (${pct(r.pipeline.cost_share)} of recorded cost)`);
  return lines.join("\n");
}
