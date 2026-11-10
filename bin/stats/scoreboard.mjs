// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#5341: feature scoreboard. `forgedock stats --milestone <id|title>` grades a whole milestone, not one issue:
 *   - journey status at ship per epic (#5336 FORGE:ACCEPTANCE comments: pass, fail or never-ran, with the head and time)
 *   - minutes from the first lane merge to the first green end-to-end run (journey record)
 *   - defects found after the last planned child merged, by class (release-review, post-deploy, hotfix, other)
 *   - rework share: issues that fix or redo a sibling of the same milestone
 *   - operator interventions: hand PRs (head branch is not a lane branch) and needs-human issues, plus needs-human run logs
 * Deterministic: GitHub (milestone issues, PRs, epic comments) and optional local run logs; no model, no clock; the gh runner is
 * injected. A missing signal is null (printed n/a), never 0.
 */
import { readEpics, acceptanceResultOf } from "../lean/acceptance.mjs";
import { listMilestones } from "../lean/lane.mjs";

export const DEFECT_CLASSES = Object.freeze(["release-review", "post-deploy", "hotfix", "other"]);
const LANE_BRANCH_RE = /^(?:feat|fix|chore|docs|refactor|perf|test)\/issue-\d+/;
const REWORK_RE = /\b(?:fix(?:es|ed)?|redo|rework|regress\w*|follow-?up|revert\w*)\b[^\n#]*#(\d+)/gi;
const labelsOf = (i) => (i.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
const has = (i, re) => labelsOf(i).some((l) => re.test(l)) || re.test(String(i.title ?? ""));
const ms = (t) => { const v = Date.parse(t); return Number.isFinite(v) ? v : null; };

/** The defect class of an issue from its labels or title, or null when it is no defect. */
export function defectClass(i) {
  if (has(i, /release[- ]review/i)) return "release-review";
  if (has(i, /post[- ]deploy/i)) return "post-deploy";
  if (has(i, /hotfix/i)) return "hotfix";
  return labelsOf(i).some((l) => /^(?:bug|defect|regression)$/i.test(l)) ? "other" : null;
}

/** Journey status of one epic's comments: {status: pass|fail|never-ran, head, at, journeys, first_green_at}. */
export function journeyStatus(epic) {
  const recs = (epic.comments ?? []).map((c) => { const r = acceptanceResultOf(c.body); return r ? { ...r, at: r.at ?? c.created_at } : null; }).filter(Boolean)
    .filter((r) => r.site !== "post-deploy").sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0));
  const last = recs.at(-1);
  const green = recs.find((r) => r.result === "pass");
  return { epic: epic.number, journeys: epic.declared?.journeys?.length ?? 0, status: last ? last.result : "never-ran", head: last?.head ?? null, at: last?.at ?? null, runs: recs.length, first_green_at: green?.at ?? null };
}

/**
 * Pure scoreboard. milestone {number, title, state, closed_at}; issues: the milestone's issues and PRs (GitHub issues API);
 * prs: [{number, merged_at, head_ref}] for the milestone's PRs; epics: readEpics rows; runs: local run summaries (optional).
 */
export function scoreboard({ milestone, issues = [], prs = [], epics = [], runs = [] }) {
  const plain = issues.filter((i) => !i.pull_request);
  const isEpic = (i) => labelsOf(i).includes("epic");
  const children = plain.filter((i) => !isEpic(i));
  const nums = new Set(children.map((i) => i.number));
  const planned = children.filter((i) => !defectClass(i));
  const mergeTimes = (prs.length ? prs.map((p) => ms(p.merged_at)) : planned.filter((i) => i.state === "closed").map((i) => ms(i.closed_at))).filter((t) => t != null).sort((a, b) => a - b);
  const closedPlanned = planned.map((i) => ms(i.closed_at)).filter((t) => t != null).sort((a, b) => a - b);
  const lastChild = planned.length && planned.every((i) => i.state === "closed") ? closedPlanned.at(-1) ?? null : null;
  const firstMerge = mergeTimes[0] ?? null;
  const journeys = epics.map(journeyStatus);
  const greens = journeys.map((j) => ms(j.first_green_at)).filter((t) => t != null);
  const firstGreen = greens.length ? Math.min(...greens) : null;
  const defects = Object.fromEntries(DEFECT_CLASSES.map((c) => [c, 0]));
  const defectIssues = [];
  for (const i of children) {
    const c = defectClass(i);
    if (c && lastChild != null && (ms(i.created_at) ?? 0) > lastChild) { defects[c]++; defectIssues.push(i.number); }
  }
  const rework = new Set();
  for (const i of children) {
    if (labelsOf(i).includes("rework")) rework.add(i.number);
    for (const m of String(i.body ?? "").matchAll(REWORK_RE)) if (Number(m[1]) !== i.number && nums.has(Number(m[1]))) rework.add(i.number);
  }
  const handPrs = prs.filter((p) => p.head_ref && !LANE_BRANCH_RE.test(p.head_ref) && !/^milestone\//.test(p.head_ref)).map((p) => p.number);
  const needsHuman = children.filter((i) => labelsOf(i).includes("needs-human")).map((i) => i.number);
  const mine = runs.filter((r) => nums.has(Number(r.issue)));
  const costs = mine.map((r) => r.usd ?? r.cost_usd).filter((x) => Number.isFinite(x));
  return {
    milestone: { number: milestone.number, title: milestone.title, state: milestone.state ?? null },
    children: children.length, merged: mergeTimes.length || null,
    journeys,
    journey_status_at_ship: !journeys.length ? null : journeys.every((j) => j.status === "pass") ? "pass" : journeys.some((j) => j.status === "fail") ? "fail" : "never-ran",
    minutes_first_merge_to_first_green: firstMerge != null && firstGreen != null ? Math.max(0, Math.round((firstGreen - firstMerge) / 60000)) : null,
    last_child_merged_at: lastChild != null ? new Date(lastChild).toISOString() : null,
    defects_after_last_child: lastChild != null ? { total: defectIssues.length, by_class: defects, issues: defectIssues } : null,
    rework: children.length ? { issues: [...rework].sort((a, b) => a - b), share: Math.round((rework.size / children.length) * 1e4) / 1e4 } : null,
    interventions: { hand_prs: handPrs, needs_human_issues: needsHuman, needs_human_runs: mine.filter((r) => r.reason === "needs-human").length, total: handPrs.length + needsHuman.length },
    cost_usd: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100 : null,
  };
}

const jsonl = (raw) => String(raw ?? "").split("\n").map((l) => l.trim()).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

/** The milestone whose number or title is `ref`, or null. */
export async function findMilestoneByRef({ io, repo, ref }) {
  const r = String(ref);
  return (await listMilestones({ gh: io.gh, repo, state: "all" })).find((m) => String(m.number) === r || m.title === r) ?? null;
}

/** Read a milestone (number or title) with its issues, PRs and epics through an injected `io.gh`; null when it does not exist. */
export async function gatherScoreboard({ io, repo, ref, runs = [] }) {
  const milestone = await findMilestoneByRef({ io, repo, ref });
  if (!milestone) return null;
  const issues = jsonl(await io.gh(["api", `repos/${repo}/issues?milestone=${milestone.number}&state=all&per_page=100`, "--paginate", "--jq", ".[] | @json"]));
  const prs = [];
  for (const p of issues.filter((i) => i.pull_request)) {
    const row = jsonl(await io.gh(["api", `repos/${repo}/pulls/${p.number}`, "--jq", "{number, merged_at, head_ref: .head.ref} | @json"]))[0];
    if (row) prs.push(row);
  }
  const epics = await readEpics({ io, repo, milestone });
  return scoreboard({ milestone: { ...milestone, state: milestone.state }, issues, prs, epics, runs });
}

const NA = "n/a";
const fmt = (x, f = String) => (x == null ? NA : f(x));

export function renderScoreboard(s) {
  if (!s) return "Feature scoreboard: milestone not found.";
  const d = s.defects_after_last_child, iv = s.interventions;
  return [`## Feature scoreboard: ${s.milestone.title} (#${s.milestone.number})`, "",
    "| metric | value |", "|---|---|",
    `| children | ${s.children} (merged ${fmt(s.merged)}) |`,
    `| journey status at ship | ${fmt(s.journey_status_at_ship)} |`,
    `| first lane merge to first green journey | ${fmt(s.minutes_first_merge_to_first_green, (m) => `${m}m`)} |`,
    `| defects after last child | ${d ? `${d.total} (${DEFECT_CLASSES.map((c) => `${c} ${d.by_class[c]}`).join(", ")})` : NA} |`,
    `| rework share | ${s.rework ? `${Math.round(s.rework.share * 100)}% (${s.rework.issues.length} issues)` : NA} |`,
    `| operator interventions | ${iv.total} (hand PRs ${iv.hand_prs.length}, needs-human ${iv.needs_human_issues.length}) |`,
    `| cost | ${fmt(s.cost_usd, (x) => `$${x.toFixed(2)}`)} |`,
    ...(s.journeys.length ? ["", "| epic | journeys | status | head | at |", "|---|---|---|---|---|", ...s.journeys.map((j) => `| #${j.epic} | ${j.journeys} | ${j.status} | ${j.head ? String(j.head).slice(0, 7) : NA} | ${j.at ?? NA} |`)] : [])].join("\n");
}

/**
 * Promotion gate for a default flag that touches milestone lanes: it passes only while the latest feature-benchmark scorecard
 * has no regression and, when a shipped-milestone scoreboard is given, its journeys are not red. {ok, reasons}.
 */
export function scoreboardGate({ bench = null, board = null } = {}) {
  const reasons = [];
  if (!bench) reasons.push("no feature benchmark scorecard recorded");
  else if (bench.regression) reasons.push(`feature benchmark regressed: ${bench.regression}`);
  if (board && board.journey_status_at_ship && board.journey_status_at_ship !== "pass") reasons.push(`milestone ${board.milestone.title}: journeys ${board.journey_status_at_ship} at ship`);
  return { ok: !reasons.length, reasons };
}
