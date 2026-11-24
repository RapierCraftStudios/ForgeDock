// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5752: declared outcome-evidence areas. forge.yaml `outcome_evidence: {paths: {area: globs}, corpus: {area: globs}}`.
 * Absent or no `paths` area = off. A lane whose non-test changed files match an area must record a before/after measurement on
 * recorded real inputs (a replay corpus, production samples) in its result: `outcome_evidence: [{area, metric, corpus, before,
 * after, better}]`; and a post-deploy check of such a lane must be a metric with a baseline, not a string match. Failures are
 * conformance.unimplemented rows (no new outcome code), each naming the area, the files and the required shape.
 * Deterministic, 0 LLM calls, repo-agnostic like docsgate.mjs.
 */
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { globToRegex } from "../../scripts/ci-local/lib.mjs";
import { CHECKS_FILE } from "./postdeploy-check.mjs";

const TEST_RE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$/;
const norm = (p) => String(p ?? "").trim().replace(/^\.\//, "");
const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.replace(/^\[|\]$/g, "").split(",") : []).map((x) => String(x ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim()).filter(Boolean);
const areaMap = (raw) => {
  const out = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) { const g = list(v).map(norm); if (k.trim() && g.length) out[k.trim()] = g; }
  return out;
};
const anyGlob = (globs, f) => (globs ?? []).some((g) => globToRegex(g).test(f));
const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const BETTER = ["higher", "lower"];

/** forge.yaml outcome_evidence: section -> {paths: {area: globs}, corpus: {area: globs}} or null when off. */
export function parseOutcomeEvidenceConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const paths = areaMap(raw.paths);
  if (!Object.keys(paths).length) return null;
  return { paths, corpus: areaMap(raw.corpus) };
}

/** Touched areas `{area: [files]}`: non-test changed files matching an area's globs (corpus files themselves do not count). */
export function touchedAreas(cfg, files) {
  const out = {};
  if (!cfg) return out;
  const corpusGlobs = Object.values(cfg.corpus ?? {}).flat();
  for (const f0 of files ?? []) {
    const f = norm(f0);
    if (!f || TEST_RE.test(f) || anyGlob(corpusGlobs, f)) continue;
    for (const [area, globs] of Object.entries(cfg.paths)) if (anyGlob(globs, f)) (out[area] ??= []).push(f);
  }
  return out;
}

const shape = (area, cfg) => `result.outcome_evidence: [{"area":"${area}","metric":"<name>","corpus":"<recorded real inputs${cfg.corpus?.[area]?.length ? ` matching ${cfg.corpus[area].join(", ")}` : ""}>","before":<number>,"after":<number>,"better":"higher|lower"}]`;

/** The reason a row cannot stand as evidence for `area`, or null when it is well formed. */
function rowProblem(row, area, cfg, exists) {
  if (typeof row.metric !== "string" || !row.metric.trim()) return "metric is missing (name what was measured)";
  const corpus = norm(row.corpus);
  if (!corpus) return "corpus is missing (the recorded real inputs measured: a replay corpus or production samples, not mocks)";
  if (cfg.corpus?.[area]?.length && !anyGlob(cfg.corpus[area], corpus)) return `corpus ${corpus} is not a declared corpus for this area (${cfg.corpus[area].join(", ")})`;
  if (exists && !exists(corpus)) return `corpus ${corpus} does not exist in the tree`;
  if (!Number.isFinite(num(row.before)) || !Number.isFinite(num(row.after))) return `before (${JSON.stringify(row.before ?? null)}) and after (${JSON.stringify(row.after ?? null)}) must be numbers`;
  if (row.better !== undefined && !BETTER.includes(row.better)) return `better must be "higher" or "lower", not ${JSON.stringify(row.better)}`;
  return null;
}

/** The raw post-deploy checks entries {id: entry} at each git ref (later refs win); parseChecks drops the baseline field this gate reads. */
export async function rawChecksAt(git, refs) {
  const out = {};
  for (const ref of refs) {
    try { const j = JSON.parse(String(await git(["show", `${ref}:${CHECKS_FILE}`]))); if (j && typeof j === "object" && !Array.isArray(j)) for (const [id, v] of Object.entries(j)) out[id] = v && typeof v === "object" ? v : { run: v }; } catch { /* no file at this ref */ }
  }
  return out;
}

/** A post-deploy check's baseline is a metric: {metric, value: number, better?}. */
const baselineOk = (b) => b && typeof b === "object" && typeof b.metric === "string" && b.metric.trim() && Number.isFinite(num(b.value)) && (b.better === undefined || BETTER.includes(b.better));

/**
 * Blocking failures (conformance.unimplemented) for touched areas: `outcome_evidence_missing` (no result row for the area),
 * `outcome_evidence_invalid` (no metric, corpus not real/declared/present, non-numeric values), `outcome_evidence_regressed`
 * (after is worse than before), `outcome_evidence_baseline_missing` (a post-deploy check of this lane with no metric baseline).
 * `checks` is the post-deploy checks map {id: entry}; `exists(path)` tells whether a file is in the lane tree.
 */
export function outcomeEvidenceFailures({ cfg, files = [], result = null, exists = null, checks = null, contract = null }) {
  if (!cfg) return [];
  const touched = touchedAreas(cfg, files), areas = Object.keys(touched);
  if (!areas.length) return [];
  const C = OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED, out = [];
  const rows = (Array.isArray(result?.outcome_evidence) ? result.outcome_evidence : []).filter((r) => r && typeof r === "object");
  for (const area of areas) {
    const fs = touched[area], where = `outcome-evidence area '${area}' (forge.yaml outcome_evidence.paths) touched by ${fs.slice(0, 5).join(", ")}${fs.length > 5 ? ` (+${fs.length - 5} more)` : ""}`;
    const mine = rows.filter((r) => String(r.area ?? "").trim() === area);
    if (!mine.length) { out.push({ code: C, kind: "outcome_evidence_missing", area, detail: `${where} has no before/after measurement on recorded real inputs: add ${shape(area, cfg)}` }); continue; }
    for (const row of mine) {
      const bad = rowProblem(row, area, cfg, exists);
      if (bad) { out.push({ code: C, kind: "outcome_evidence_invalid", area, detail: `${where}: outcome_evidence row ${bad}; expected ${shape(area, cfg)}` }); continue; }
      const before = num(row.before), after = num(row.after), better = row.better ?? "higher";
      if (better === "higher" ? after < before : after > before) out.push({ code: C, kind: "outcome_evidence_regressed", area, detail: `${where}: ${row.metric} on ${norm(row.corpus)} got worse (before ${before}, after ${after}, ${better} is better)` });
    }
  }
  for (const r of contract?.requirements ?? []) {
    if (r?.disposition !== "post-deploy" || !r.check) continue;
    const entry = checks?.[r.check];
    if (!entry) continue; // an unknown check id is check_unknown's finding
    if (!baselineOk(entry.baseline)) out.push({ code: C, kind: "outcome_evidence_baseline_missing", area: areas.join(", "), detail: `${r.id} post-deploy check '${r.check}' covers outcome-evidence area ${areas.map((a) => `'${a}'`).join(", ")} but has no metric baseline: give it "baseline": {"metric":"<name>","value":<number>,"better":"higher|lower"} in .forge/post-deploy-checks.json, a metric with a baseline, not a string match` });
  }
  return out;
}
