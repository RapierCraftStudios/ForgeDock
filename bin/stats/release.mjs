// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#4628: per-release regression rule over the `aggregate()` groups. Each metric is null when its own sample is
 * below minN; a verdict is null when either side is null. There is no "pass" value, only regressed|improved|flat|null.
 */
import { DEFAULT_MIN_N, UNKNOWN, compareVersions } from "./aggregate.mjs";

export const METRICS_MARKER = "<!-- FORGE:METRICS v1 -->";
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
// lower is better for all but the first-pass rate
const METRICS = [
  { key: "usd_median", label: "median cost/run", lowerBetter: true, flat: 0.05 },
  { key: "wall_p50_ms", label: "wall p50", lowerBetter: true, flat: 0.05 },
  { key: "first_pass_rate", label: "first-pass rate", lowerBetter: false, flat: 0.02 },
  { key: "needs_human_rate", label: "needs-human rate", lowerBetter: true, flat: 0.02 },
];

/** The metric values of one group, each null below minN (its own n). */
function valuesOf(g, minN) {
  const pick = (n, v) => (isNum(n) && n >= minN && isNum(v) ? v : null);
  return {
    n: g.n,
    usd_median: pick(g.cost?.usdN, g.cost?.usdMedian),
    wall_p50_ms: pick(g.time?.wall?.n, g.time?.wall?.p50),
    first_pass_rate: pick(g.firstPass?.n, g.firstPass?.rate),
    needs_human_rate: pick(g.flow?.n, g.flow?.needsHumanPct),
  };
}

/** Relative change for cost and time, absolute for rates; flat inside the tolerance. */
function verdict(m, cur, prev) {
  if (!isNum(cur) || !isNum(prev)) return null;
  const rate = m.key.endsWith("_rate");
  const d = rate ? cur - prev : prev === 0 ? (cur === 0 ? 0 : Infinity) : (cur - prev) / prev;
  if (Math.abs(d) <= m.flat) return "flat";
  return (d < 0) === m.lowerBetter ? "improved" : "regressed";
}

/** Known versions of one repo, oldest first, each with its metrics and the verdicts against the previous one. */
export function releaseMetrics(groups, { minN = DEFAULT_MIN_N, repo = null } = {}) {
  const known = groups.filter((g) => g.version !== UNKNOWN && (repo == null || g.repo === repo))
    .sort((a, b) => compareVersions(a.version, b.version));
  const versions = known.map((g, i) => {
    const metrics = valuesOf(g, minN), prev = i ? valuesOf(known[i - 1], minN) : null;
    const verdicts = Object.fromEntries(METRICS.map((m) => [m.key, prev ? verdict(m, metrics[m.key], prev[m.key]) : null]));
    return { version: g.version, against: i ? known[i - 1].version : null, ...metrics, verdicts };
  });
  return { repo, minN, versions };
}

const fmt = (key, v) => (v == null ? "n/a" : key === "usd_median" ? `$${v.toFixed(2)}` : key === "wall_p50_ms" ? `${(v / 60000).toFixed(1)}m` : `${(v * 100).toFixed(0)}%`);

export function renderReleaseMetrics(rm) {
  const rows = rm.versions.map((v) => [v.version, String(v.n), ...METRICS.map((m) => `${fmt(m.key, v[m.key])} (${v.verdicts[m.key] ?? "n/a"})`)]);
  const head = ["version", "n", ...METRICS.map((m) => m.label)];
  const line = (r) => `| ${r.join(" | ")} |`;
  return [`Release metrics (min n ${rm.minN}; n/a below it)`, line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

/** The FORGE:METRICS comment: marker, table and the snapshot as fenced JSON. */
export function metricsComment(rm) {
  return `${METRICS_MARKER}\n${renderReleaseMetrics(rm)}\n\n\`\`\`json\n${JSON.stringify(rm)}\n\`\`\`\n`;
}

/** Create the FORGE:METRICS comment on the PR, or update the existing one (argv-based gh). */
export async function postMetrics({ gh, repo, pr, body }) {
  const raw = await gh(["api", "--paginate", `repos/${repo}/issues/${pr}/comments`]);
  const pages = String(raw ?? "").trim().replace(/\]\s*\[/g, ",");
  const list = pages ? JSON.parse(pages.startsWith("[") ? pages : `[${pages}]`) : [];
  const mine = list.filter((c) => typeof c?.body === "string" && c.body.startsWith(METRICS_MARKER)).pop();
  if (mine) await gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${mine.id}`, "-f", `body=${body}`]);
  else await gh(["api", "-X", "POST", `repos/${repo}/issues/${pr}/comments`, "-f", `body=${body}`]);
  return mine ? "updated" : "created";
}
