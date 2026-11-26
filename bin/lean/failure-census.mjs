// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Failure census (2026-11-26): classify why lanes did not take the happy path, from the register itself, so an agent
 * working on a pipeline fix reads measured failure classes instead of guessing. Pure functions only (no I/O): the CLI
 * (scripts/failure-census.mjs) feeds issue comments and batch log rows in.
 *
 * Inputs it understands (all ForgeDock annotations on issues):
 * - FORGE:NEEDS_HUMAN / FORGE:PARKED bodies: one park each, classified into a bucket and normalised failure rows;
 * - FORGE:AMENDMENT-STATE JSON: the last state per issue gives the distinct amendments (kind + why class);
 * - FORGE:BASE_SYNC bodies: conflicted files.
 * Batch log rows (`~/.forge/batches/<id>/log.jsonl`): outcome/code counts and per-phase timing.
 */

/** Ordered: the first matching bucket wins. Patterns match the park body (rows and prose). */
export const PARK_BUCKETS = Object.freeze([
  ["sandbox_tool_gap", /Remote sandbox lacks|lane_tools recipe|sandbox is missing/i],
  ["recurrence_design", /recurrence\.design_missing/],
  ["post_deploy_check_id", /post-deploy check (id|'[^']*') is neither/],
  ["amendment_syntax", /unknown or incomplete amendment|amendment kind '|amendment not accepted/],
  ["substitute_validate", /substituted `|substitute-validate|substitute_unverified/],
  ["deferral", /unjustified_deferral|untracked_deferral|reported "deferred"/],
  ["no_status", /reported "no status"/],
  ["omission_narrowed", /conformance\.omission|requirement narrowed/],
  ["scope_creep", /scope_creep|outside the contract's deliverables/],
  ["validate_failed", /validate [A-Z]?\d+ .*failed|frozen command runs and fails|Declared check command\(s\) failing/],
  ["ci_red", /Required check\(s\) failed|ci\.red|CI verification failed/],
  ["env_setup", /Environment error|env\.(setup_failed|tool_missing|validate_timeout|validate_placement|repro_unrunnable|capability_remote)/],
  ["builder_blocked", /Builder is blocked|builder\.(blocked|no_commit)|Builder made no commit/],
  ["review_incomplete", /review\.(incomplete|failed|unparseable)|Review FAIL/],
  ["e2e_unverified", /e2e_unverified|e2e_placement/],
  ["design_spec", /design\.spec_required|FORGE:DESIGN_SPEC|Design gate/],
  ["contract_invalid", /contract is still invalid|contract\.invalid/],
]);

/** Bucket of one park body; "other" when no pattern matches. */
export function parkBucket(body) {
  const b = String(body ?? "");
  for (const [name, re] of PARK_BUCKETS) if (re.test(b)) return name;
  return "other";
}

/** The `- code: detail` rows of a NEEDS_HUMAN/PARKED body, normalised so repeats across issues group together. */
export function parkRows(body) {
  return String(body ?? "").split("\n").filter((l) => /^- [a-z_]+\.[a-z_]+:/.test(l)).map(normalizeRow);
}

/** Collapse ids, numbers, quotes and code spans so identical defects compare equal. */
export function normalizeRow(row) {
  return String(row).replace(/^- /, "").replace(/\bR\d+\b/g, "R#").replace(/\b[GV]\d+\b/g, "V#").replace(/#\d+/g, "#N")
    .replace(/`[^`]*`/g, "`…`").replace(/\("[^]*$/, "").replace(/"[^"]{40,}"/g, "\"…\"").replace(/\d+/g, "N").trim().slice(0, 140);
}

const AMENDMENT_STATE_RE = /FORGE:AMENDMENT-STATE (\{.*\}) -->/;
/** The distinct amendments of the LAST amendment state on an issue (earlier states are replayed into it). */
export function lastAmendments(comments) {
  let last = null;
  for (const c of comments ?? []) {
    const m = AMENDMENT_STATE_RE.exec(String(c?.body ?? ""));
    if (!m) continue;
    try { last = JSON.parse(m[1]); } catch { /* a malformed state is skipped */ }
  }
  return Array.isArray(last?.amendments) ? last.amendments : [];
}

/** Why-class of one amendment: broken frozen command, post-deploy measurement, naming, or other. */
export function amendmentWhyClass(a) {
  const w = String(a?.why ?? "");
  if (/on the (unchanged )?base|origin\/staging|fails before|not on the .*path|ModuleNotFound|cannot import|not installed|command not found|timed out|sandbox|lacks/i.test(w)) return "frozen_command_broken_or_env";
  if (/requirement|post-deploy|measur|production|after deploy/i.test(w)) return "post_deploy_or_measurement";
  if (/duplicate|rename|name/i.test(w)) return "naming_or_decision";
  if (/docs freshness|dossier|registry|check id/i.test(w)) return "forced_by_another_gate";
  return "other";
}

/** Conflicted files listed by a FORGE:BASE_SYNC body ("conflicts in `a`, `b`"). */
export function baseSyncConflicts(body) {
  const m = /\*\*Result:\*\* conflicts in ([^\n]+)/.exec(String(body ?? ""));
  return m ? [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]) : [];
}

const inc = (o, k, by = 1) => { o[k] = (o[k] ?? 0) + by; return o; };
const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);

/**
 * Census over issues: `issues` = [{number, title, comments: [{body, createdAt, author}]}]. Returns plain data:
 * parks by bucket (+ issues), by day x bucket, top normalised rows, repeat parks (identical rows back to back),
 * amendments by kind x why class, conflict hotspots, and the most-parked issues.
 */
export function censusIssues(issues) {
  const out = { issues: 0, withParks: 0, parks: 0, repeats: 0, buckets: {}, bucketIssues: {}, byDay: {}, rows: {}, amendments: {}, amendmentIssues: {}, conflicts: {}, baseSyncs: 0, mostParked: [] };
  const perIssue = [];
  for (const iss of issues ?? []) {
    out.issues++;
    let parks = 0, prev = null;
    for (const c of iss.comments ?? []) {
      const body = String(c?.body ?? "");
      if (/FORGE:BASE_SYNC/.test(body)) { out.baseSyncs++; for (const f of baseSyncConflicts(body)) inc(out.conflicts, f); }
      if (!/FORGE:(NEEDS_HUMAN|PARKED)/.test(body)) continue;
      const rows = parkRows(body), bucket = parkBucket(body), key = rows.slice().sort().join("|");
      parks++; out.parks++;
      inc(out.buckets, bucket);
      (out.bucketIssues[bucket] ??= new Set()).add(iss.number);
      const day = String(c?.createdAt ?? "").slice(0, 10) || "unknown";
      inc((out.byDay[day] ??= {}), bucket);
      if (prev !== null && rows.length && key === prev) out.repeats++;
      prev = key;
      for (const r of new Set(rows)) inc(out.rows, r);
    }
    for (const a of lastAmendments(iss.comments)) {
      const k = `${a?.kind ?? "?"} :: ${amendmentWhyClass(a)}`;
      inc(out.amendments, k);
      (out.amendmentIssues[k] ??= new Set()).add(iss.number);
    }
    if (parks) { out.withParks++; perIssue.push({ number: iss.number, title: String(iss.title ?? "").slice(0, 80), parks }); }
  }
  out.mostParked = perIssue.sort((a, b) => b.parks - a.parks).slice(0, 15);
  for (const k of ["bucketIssues", "amendmentIssues"]) for (const b of Object.keys(out[k])) out[k][b] = out[k][b].size;
  return out;
}

/** Census over batch log rows ({outcome, code, phases:{name:{ms}}}): outcome/code counts and per-phase median/p90 (merged lanes). */
export function censusBatchRows(rows) {
  const outcomes = {}, deferred = {}, needsHuman = {}, phases = {};
  for (const r of rows ?? []) {
    if (!r || r.outcome == null) continue;
    inc(outcomes, r.outcome);
    if (r.outcome === "deferred") inc(deferred, r.code ?? "null");
    if (r.outcome === "needs-human") inc(needsHuman, r.code ?? "null");
    if (r.outcome === "merged" && r.phases && typeof r.phases === "object") {
      for (const [k, v] of Object.entries(r.phases)) if (Number.isFinite(v?.ms)) (phases[k] ??= []).push(v.ms);
    }
  }
  const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };
  const phaseStats = Object.fromEntries(Object.entries(phases).map(([k, xs]) => [k, { n: xs.length, median_min: Math.round(q(xs, 0.5) / 6000) / 10, p90_min: Math.round(q(xs, 0.9) / 6000) / 10 }]));
  return { outcomes, deferred, needsHuman, phases: phaseStats };
}

/** Markdown report of both censuses. */
export function renderCensus({ repo, since, issues, batches }) {
  const L = [`# Failure census: ${repo}${since ? ` (since ${since})` : ""}`, ""];
  if (issues) {
    L.push(`Issues scanned: ${issues.issues}; with parks: ${issues.withParks}; parks (NEEDS_HUMAN/PARKED): ${issues.parks}; identical back-to-back repeats: ${issues.repeats}`, "", "## Parks by class", "", "| class | parks | issues |", "|---|---|---|");
    for (const [b, n] of top(issues.buckets, 30)) L.push(`| ${b} | ${n} | ${issues.bucketIssues[b] ?? 0} |`);
    const days = Object.keys(issues.byDay).sort(), cls = top(issues.buckets, 6).map(([b]) => b);
    if (days.length) {
      L.push("", "## Parks per day (top classes)", "", `| day | ${cls.join(" | ")} | other |`, `|---|${cls.map(() => "---").join("|")}|---|`);
      for (const d of days) { const row = issues.byDay[d]; const rest = Object.entries(row).filter(([k]) => !cls.includes(k)).reduce((s, [, v]) => s + v, 0); L.push(`| ${d} | ${cls.map((c) => row[c] ?? 0).join(" | ")} | ${rest} |`); }
    }
    L.push("", "## Most frequent failure rows (normalised)", "", "| count | row |", "|---|---|");
    for (const [r, n] of top(issues.rows, 20)) L.push(`| ${n} | ${r.replace(/\|/g, "\\|")} |`);
    L.push("", "## Amendments (last state per issue): kind :: why class", "", "| amendment | count | issues |", "|---|---|---|");
    for (const [k, n] of top(issues.amendments, 20)) L.push(`| ${k} | ${n} | ${issues.amendmentIssues[k] ?? 0} |`);
    L.push("", `## Base-sync conflict hotspots (${issues.baseSyncs} base syncs)`, "", "| file | conflicts |", "|---|---|");
    for (const [f, n] of top(issues.conflicts, 15)) L.push(`| \`${f}\` | ${n} |`);
    L.push("", "## Most-parked issues", "", "| issue | parks | title |", "|---|---|---|");
    for (const i of issues.mostParked) L.push(`| #${i.number} | ${i.parks} | ${i.title.replace(/\|/g, "\\|")} |`);
  }
  if (batches) {
    L.push("", "## Batch logs", "", "| outcome | rows |", "|---|---|");
    for (const [k, n] of top(batches.outcomes, 15)) L.push(`| ${k} | ${n} |`);
    L.push("", "| deferred code | rows |", "|---|---|");
    for (const [k, n] of top(batches.deferred, 10)) L.push(`| ${k} | ${n} |`);
    L.push("", "| needs-human code | rows |", "|---|---|");
    for (const [k, n] of top(batches.needsHuman, 12)) L.push(`| ${k} | ${n} |`);
    L.push("", "| phase (merged lanes) | n | median min | p90 min |", "|---|---|---|---|");
    for (const [k, v] of Object.entries(batches.phases).sort((a, b) => b[1].median_min - a[1].median_min)) L.push(`| ${k} | ${v.n} | ${v.median_min} | ${v.p90_min} |`);
  }
  return L.join("\n") + "\n";
}
