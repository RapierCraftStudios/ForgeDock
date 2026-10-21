// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Rendering for `forgedock stats` (forge#3835): full markdown, compact table (review-pr-staging) and JSON. */

const NA = "n/a";
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const k = (x) => (isNum(x) ? `${Math.round(x / 1000)}k` : NA);
const pct = (x) => (isNum(x) ? `${Math.round(x * 100)}%` : NA);
const usd = (x) => (isNum(x) ? `$${x.toFixed(2)}` : NA);
const f1 = (x) => (isNum(x) ? (Math.round(x * 10) / 10).toString() : NA);
const dur = (ms) => {
  if (!isNum(ms)) return NA;
  const s = ms / 1000;
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${f1(s / 3600)}h`;
};
const signed = (x, fmt) => (isNum(x) ? `${x > 0 ? "+" : x < 0 ? "-" : ""}${fmt(Math.abs(x))}` : NA);
const dpp = (x) => signed(x, (v) => `${Math.round(v * 100)}pp`);
const flag = (g) => (g.lowN ? ` (low-n <${g.minN})` : "");
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)];

export const renderJson = (report) => JSON.stringify(report, null, 2);

const label = (g) => `${g.version} / ${g.repo}`;

function sections(g) {
  const out = [`## ${label(g)}  n=${g.n}${flag(g)}`, ""];
  const c = g.cost;
  out.push("### Cost", ...table(["metric", "value"], [
    ["cache-read tokens per issue (mean / median)", `${k(c.cacheReadMean)} / ${k(c.cacheReadMedian)}`],
    ["output tokens per issue (mean)", k(c.outputMean)],
    ["per phase (mean)", Object.entries(c.perPhase).filter(([, v]) => isNum(v)).map(([p, v]) => `${p} ${k(v)}`).join(", ") || NA],
    ["cache-read tokens per merged issue", k(c.perMergedIssue)],
    ["USD per issue (n=" + c.usdN + ")", usd(c.usdMean)],
  ]), "");
  const t = g.time;
  const phaseRows = Object.entries(t.phases).map(([p, v]) => [p, String(v.n), dur(v.p50), dur(v.p90)]);
  out.push("### Time", ...table(["phase", "n", "p50", "p90"], [...phaseRows, ["wall per issue", String(t.wall.n), dur(t.wall.p50), dur(t.wall.p90)]]), "");
  const f = g.flow;
  out.push("### Flow", ...table(["metric", "value"], [
    ["merged", pct(f.mergedPct)], ["needs-human", pct(f.needsHumanPct)], ["remediation rate", pct(f.remediationPct)],
    ["top outcome codes (n=" + f.codesN + ")", f.codes.slice(0, 5).map((x) => `${x.code} ${x.count} (${pct(x.pct)})`).join(", ") || NA],
    ...(g.firstPass ? [["first-pass rate", `${pct(g.firstPass.rate)} (${g.firstPass.firstPass}/${g.firstPass.n} lanes that reached the build, ${g.firstPass.unknown} unknown)`]] : []),
    // #4375: the same rate split by whether the context pack carried pitfalls matching the issue's files
    ...(g.firstPassByPitfalls && (g.firstPassByPitfalls.with.n || g.firstPassByPitfalls.without.n)
      ? [["with", "without"].map((k) => [`first-pass ${k} matching pitfalls`, `${pct(g.firstPassByPitfalls[k].rate)} (${g.firstPassByPitfalls[k].firstPass}/${g.firstPassByPitfalls[k].n})`])].flat() : []),
  ]), "");
  if (g.rework) { // #4362: builder rework rounds by trigger; untagged (older) attempts are "unknown"
    const w = g.rework, rows = Object.entries(w.byTrigger).sort((a, b) => b[1].usd - a[1].usd || a[0].localeCompare(b[0]));
    out.push("### Rework by trigger", ...(rows.length ? table(["trigger", "count", "cost"], [...rows.map(([t, d]) => [t, String(d.n), usd(d.usd)]), ["total", String(w.n), usd(w.usd)]])
      : ["No rework attempts."]), "");
  }
  const r = g.funnel;
  const sev = Object.entries(r.bySeverity).map(([s, d]) => [s, String(d.total), f1(d.perReview), String(d.ISSUE), String(d.NOTE), String(d.INPR_FIX)]);
  out.push("### Review funnel", `${r.reviews} reviews, ${r.findings} findings (${f1(r.perReview)} per review). Validated issues: ${r.validated}, false positives: ${r.falsePositive}.`, "",
    ...(sev.length ? table(["severity", "findings", "per review", "ISSUE", "NOTE", "in-PR fix"], sev) : [`No finding records: ${NA}`]), "");
  const q = g.gates;
  const rate = (x) => (x.n ? `${pct(x.rate)} (${x.blocked}/${x.n})` : NA);
  out.push("### Gates", ...table(["gate", "block rate"], [
    ["acceptance", rate(q.acceptance)], ["diff size (OVER)", rate(q.diffSize)], ["ci", rate(q.ci)], ["liveness", rate(q.liveness)],
  ]), `Malformed-check rate: ${pct(q.malformedRate)}. Diff size: COHESIVE ${q.diffSize.cohesive}, OVER ${q.diffSize.over}.`, "");
  const i = g.issueFlow;
  const kv = (o) => Object.entries(o).map(([a, b]) => `${a} ${b}`).join(", ") || NA;
  out.push("### Issue flow", ...table(["metric", "value"], [
    ["created by source", kv(i.created)], ["closed by kind", kv(i.closed)],
    ["net flow (created - closed)", isNum(i.net) ? signed(i.net, String) : NA], ["findings per merged issue", f1(i.findingsPerMerge)], ["introduced findings per merged issue", f1(i.introducedPerMerge)],
  ]), "");
  if (g.delta) {
    const d = g.delta;
    out.push(`Delta vs ${d.against}: cache-read/issue ${signed(d.cacheReadMean, k)}, merged ${dpp(d.mergedPct)}, needs-human ${dpp(d.needsHumanPct)}, remediation ${dpp(d.remediationPct)}, wall p50 ${signed(d.wallP50, dur)}`, "");
  } else out.push(`Delta: ${NA} (no previous version)`, "");
  return out;
}

export function renderMarkdown(report) {
  const out = ["# ForgeDock stats", ""];
  if (!report.groups.length) out.push("No data: no finished runs, telemetry records or issues were found.", "");
  for (const g of report.groups) out.push(...sections(g));
  if (report.alerts?.length) out.push("## ALERTS", "", ...renderAlerts(report.alerts).map((l) => `- ${l}`), "");
  const e = report.excluded;
  out.push(`Finished runs only. Excluded: ${e.unfinished} unfinished, ${e.noUsage} without usage data (hydrated or empty). "~" = version estimated from release times; "unknown" = no version available. Groups with n < ${report.minN} are flagged low-n.`);
  return out.join("\n");
}

/** One row per (version, repo): the embedded table for the staging review summary. */
export function renderCompact(report) {
  if (!report.groups.length) return "No stats data.";
  const rows = report.groups.map((g) => [g.version, g.repo, String(g.n), k(g.cost.cacheReadMean), pct(g.flow.mergedPct), pct(g.flow.needsHumanPct),
    pct(g.flow.remediationPct), dur(g.time.wall.p50), f1(g.funnel.perReview), pct(g.gates.acceptance.rate), g.delta ? signed(g.delta.cacheReadMean, k) : NA, g.lowN ? `low-n (<${g.minN})` : "ok"]);
  return table(["Version", "Repo", "n", "Cache-read/issue", "Merged", "Needs-human", "Remediated", "Wall p50", "Findings/review", "Acceptance block", "Delta tokens", "Confidence"], rows).join("\n");
}

/**
 * forge#4354: one line per fail-soft alert: event, rate, count/sample lanes, threshold and one example reason. Outcome-code
 * alerts carry the previous-window share and a factor threshold instead of a percentage.
 */
export function renderAlerts(alerts) {
  return (alerts ?? []).map((a) => {
    const limit = isNum(a.prevRate) ? `previous window ${pct(a.prevRate)}, threshold ${a.threshold}x` : `threshold ${pct(a.threshold)}`;
    const ex = a.example ? `, e.g. ${JSON.stringify(String(a.example).slice(0, 200))}` : "";
    return `${a.event}: ${pct(a.rate)} (${a.count}/${a.sample} lanes, ${limit})${ex}`;
  });
}
