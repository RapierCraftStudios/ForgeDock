// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock scorecard --repo R --release vX [--json]` (#6084): a per-release scorecard computed from the register
 * (GitHub telemetry records, optional batch rows and LANE_AUDIT annotations), compared to the previous release. No LLM
 * and no network beyond the injected `gh`. Each metric is null (n/a) when its source is absent or below min n; a verdict
 * is null when either side is null. Verdict rule and tolerances match bin/stats/release.mjs (#4628).
 */
import { DEFAULT_MIN_N, UNKNOWN, compareVersions, percentile } from "./aggregate.mjs";
import { defaultGh, fetchGithubRecords, isValidRepo, toModel } from "./github-source.mjs";

export const SCORECARD_MARKER = "<!-- FORGE:SCORECARD v1 -->";
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
// kind: rate (absolute tolerance) | rel (relative tolerance)
export const SCORECARD_METRICS = [
  { key: "first_pass_rate", label: "first-pass merge rate", lowerBetter: false, flat: 0.02, kind: "rate" },
  { key: "interventions_per_batch", label: "operator interventions/batch", lowerBetter: true, flat: 0.05, kind: "rel" },
  { key: "needs_human_genuine", label: "needs-human (genuine)", lowerBetter: true, flat: 0.05, kind: "rel" },
  { key: "needs_human_pipeline", label: "needs-human (pipeline)", lowerBetter: true, flat: 0.05, kind: "rel" },
  { key: "queue_min", label: "queue min/lane", lowerBetter: true, flat: 0.05, kind: "rel" },
  { key: "active_min", label: "active min/lane", lowerBetter: true, flat: 0.05, kind: "rel" },
  { key: "wait_min", label: "wait min/lane", lowerBetter: true, flat: 0.05, kind: "rel" },
  { key: "minutes_per_merge", label: "minutes/merge", lowerBetter: true, flat: 0.05, kind: "rel" },
  { key: "usd_per_merge", label: "$/merge", lowerBetter: true, flat: 0.05, kind: "rel" },
  { key: "revert_rate", label: "revert rate", lowerBetter: true, flat: 0.02, kind: "rate" },
  { key: "rework_rate", label: "rework rate", lowerBetter: true, flat: 0.02, kind: "rate" },
  { key: "tested_requirements_rate", label: "requirements covered by tests", lowerBetter: false, flat: 0.02, kind: "rate" },
  { key: "stuck_issues", label: "stuck issues (>1 attempt)", lowerBetter: true, flat: 0.05, kind: "rel" },
];

const ratio = (a, b, minN) => (b >= minN && b > 0 ? a / b : null);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (xs, minN) => (xs.length >= minN ? percentile(xs, 50) : null);
const phaseSum = (r, k) => { const v = Object.values(r.phases ?? {}).map((p) => p?.[k]).filter(isNum); return v.length ? sum(v) : null; };

/** The metric values of one release; every one null when its source is absent or its own sample is below minN. */
export function scorecardValues({ records = [], batchRows = [], laneAudits = [] } = {}, release, minN = DEFAULT_MIN_N) {
  const runs = records.filter((r) => r?.version === release && r.finished);
  const merged = runs.filter((r) => r.reason === "merged");
  const rows = batchRows.filter((b) => b && (b.release == null || b.release === release) && isNum(b.interventions));
  const audits = laneAudits.filter((a) => a && (a.release == null || a.release === release) && (a.class === "genuine" || a.class === "pipeline"));
  const nh = (c) => (audits.length >= minN ? audits.filter((a) => a.class === c).length : null);
  const wall = merged.map((r) => r.wallMs).filter(isNum);
  const usd = merged.map((r) => phaseSum(r, "usd")).filter(isNum);
  const field = (k) => median(merged.map((r) => r[k]).filter(isNum), minN);
  const active = merged.map((r) => phaseSum(r, "ms")).filter(isNum);
  const revFlagged = merged.filter((r) => typeof r.reverted === "boolean");
  const verifiable = merged.filter((r) => r.verified != null);
  const attempts = (r) => r.builderAttempts?.length ?? 0;
  return {
    n: runs.length,
    first_pass_rate: ratio(merged.filter((r) => !r.remediated && attempts(r) <= 1).length, merged.length, minN),
    interventions_per_batch: rows.length >= minN ? sum(rows.map((b) => b.interventions)) / rows.length : null,
    needs_human_genuine: nh("genuine"),
    needs_human_pipeline: nh("pipeline"),
    queue_min: field("queueMin"),
    active_min: active.length >= minN ? percentile(active, 50) / 60000 : null,
    wait_min: field("waitMin"),
    minutes_per_merge: wall.length >= minN ? percentile(wall, 50) / 60000 : null,
    usd_per_merge: usd.length >= minN ? sum(usd) / usd.length : null,
    revert_rate: ratio(revFlagged.filter((r) => r.reverted).length, revFlagged.length, minN),
    rework_rate: ratio(merged.filter((r) => r.remediated).length, merged.length, minN),
    tested_requirements_rate: ratio(verifiable.filter((r) => r.verified).length, verifiable.length, minN),
    stuck_issues: runs.length >= minN ? runs.filter((r) => attempts(r) > 1).length : null,
  };
}

function verdict(m, cur, prev) {
  if (!isNum(cur) || !isNum(prev)) return null;
  const d = m.kind === "rate" ? cur - prev : prev === 0 ? (cur === 0 ? 0 : Infinity) : (cur - prev) / prev;
  if (Math.abs(d) <= m.flat) return "flat";
  return (d < 0) === m.lowerBetter ? "improved" : "regressed";
}

/** Never throws: a malformed input yields an all-null scorecard. */
export function buildScorecard({ records = [], batchRows = [], laneAudits = [], release, prev = null, minN = DEFAULT_MIN_N } = {}) {
  try {
    const known = [...new Set((records ?? []).map((r) => r?.version).filter((v) => v && v !== UNKNOWN))].sort(compareVersions);
    const prevVersion = prev ?? (known.includes(release) ? known[known.indexOf(release) - 1] ?? null : null);
    const src = { records: records ?? [], batchRows: batchRows ?? [], laneAudits: laneAudits ?? [] };
    const values = scorecardValues(src, release, minN);
    const before = prevVersion ? scorecardValues(src, prevVersion, minN) : null;
    const verdicts = Object.fromEntries(SCORECARD_METRICS.map((m) => [m.key, before ? verdict(m, values[m.key], before[m.key]) : null]));
    const regressions = SCORECARD_METRICS.filter((m) => verdicts[m.key] === "regressed").map((m) => m.key);
    return { release, against: prevVersion, minN, values, previous: before, verdicts, regressions };
  } catch {
    const values = Object.fromEntries(SCORECARD_METRICS.map((m) => [m.key, null]));
    return { release, against: null, minN, values, previous: null, verdicts: Object.fromEntries(SCORECARD_METRICS.map((m) => [m.key, null])), regressions: [] };
  }
}

const fmt = (m, v) => (v == null ? "n/a" : m.kind === "rate" ? `${(v * 100).toFixed(0)}%` : m.key === "usd_per_merge" ? `$${v.toFixed(2)}` : String(Math.round(v * 100) / 100));

export function renderScorecard(sc) {
  const line = (r) => `| ${r.join(" | ")} |`;
  const head = ["metric", sc.release, sc.against ?? "previous", "verdict"];
  const rows = SCORECARD_METRICS.map((m) => [m.label, fmt(m, sc.values[m.key]), sc.previous ? fmt(m, sc.previous[m.key]) : "n/a", sc.verdicts[m.key] ?? "n/a"]);
  const reg = sc.regressions.length ? `Regressions vs ${sc.against}: ${SCORECARD_METRICS.filter((m) => sc.regressions.includes(m.key)).map((m) => m.label).join(", ")}` : `Regressions: none${sc.against ? ` vs ${sc.against}` : ""}`;
  return [`Release scorecard ${sc.release} (min n ${sc.minN}; n/a when the source is absent or below it)`, line(head), line(head.map(() => "---")), ...rows.map(line), "", reg].join("\n");
}

/** The FORGE:SCORECARD section: marker, table and snapshot as fenced JSON. */
export function scorecardComment(sc) {
  return `${SCORECARD_MARKER}\n${renderScorecard(sc)}\n\n\`\`\`json\n${JSON.stringify(sc)}\n\`\`\`\n`;
}

export const SCORECARD_HELP = `forgedock scorecard --repo <owner/repo> --release <vX> [--json] [--min-n N]
Per-release scorecard from the GitHub register, compared to the previous release. No LLM calls.
`;

export function parseScorecardArgs(argv) {
  const o = { repo: null, release: null, json: false, help: false, minN: DEFAULT_MIN_N, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--json") o.json = true;
    else if (a === "--repo" || a === "--release" || a === "--min-n") {
      const v = argv[++i];
      if (v == null || v.startsWith("--")) { o.error = `${a} needs a value`; break; }
      if (a === "--min-n") { const n = Number(v); if (!Number.isInteger(n) || n < 1) { o.error = "--min-n must be a positive integer"; break; } o.minN = n; }
      else o[a.slice(2)] = v;
    } else { o.error = `unknown argument ${a}`; break; }
  }
  return o;
}

/** Fetch the register and build the scorecard. `deps.gh`/`deps.fetch` are injectable. */
export async function gatherScorecard({ repo, release, minN = DEFAULT_MIN_N }, deps = {}) {
  const result = await (deps.fetch ?? fetchGithubRecords)({ repo, gh: deps.gh ?? defaultGh, useCache: deps.useCache ?? true });
  const { runs } = toModel(repo, result);
  return buildScorecard({ records: runs, batchRows: deps.batchRows ?? [], laneAudits: deps.laneAudits ?? [], release, minN });
}

export async function runScorecard(argv, deps = {}) {
  const o = parseScorecardArgs(argv);
  if (o.help) { process.stdout.write(SCORECARD_HELP); return 0; }
  const fail = (msg) => { process.stderr.write(`forgedock scorecard: ${msg}\n`); return 2; };
  if (o.error) return fail(o.error);
  if (!o.release) return fail("--release is required");
  if (!isValidRepo(o.repo)) return fail("--repo owner/repo is required");
  try {
    const sc = await gatherScorecard(o, deps);
    process.stdout.write(`${o.json ? JSON.stringify(sc) : renderScorecard(sc)}\n`);
    return 0;
  } catch (err) { process.stderr.write(`forgedock scorecard: ${err.message}\n`); return 1; }
}
