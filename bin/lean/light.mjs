// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Light-lane eligibility and upgrade triggers (#4448, parent #4442). Rules first: an issue is eligible for the light
 * lane (one builder session, deterministic gates) when it has a concrete repro or expected behaviour, predicts 1..max_files
 * non-test files, is size S, touches no risk path and is not an investigation, post-deploy or decision issue. A missing
 * repro or file prediction is `ambiguous` (the caller's cheap classifier decides). During a light lane, any upgrade
 * trigger (oversized diff, repro not red on base, two test failures, risk path, public-API-shape change from #4449)
 * moves the lane to the full pipeline. forge.yaml `lean.light` {mode: off|shadow (default)|on, max_lines: 40,
 * max_files: 2}: off is never eligible, shadow reports the verdict without changing the lane shape, on lets an eligible
 * issue run light (lane wiring: #4450). Pure: no I/O, no model call.
 */
import { riskClassOf, riskPathHits } from "./review-trigger.mjs";
import { classifyPath } from "./routing.mjs";
import { laneSize } from "./budget.mjs";
import { isInvestigation } from "./conformance.mjs";
import { postDeployOnly } from "./prefilter.mjs";

export const LIGHT_MODES = Object.freeze(["off", "shadow", "on"]);
export const LIGHT_DEFAULTS = Object.freeze({ mode: "shadow", maxLines: 40, maxFiles: 2 });

const posInt = (v) => { const s = String(v ?? "").trim(); return /^\d+$/.test(s) && Number(s) > 0 ? Number(s) : null; };

/**
 * forge.yaml lean section -> {mode, maxLines, maxFiles}. The one-level parser flattens a nested `light:` block to
 * `lean.mode|max_lines|max_files`; flat `lean.light_mode|light_max_lines|light_max_files` also work and win.
 * An unknown mode is shadow; a limit that is not a positive integer keeps its default.
 */
export function parseLightConfig(lean = {}) {
  const l = lean && typeof lean === "object" ? lean : {};
  const m = String(l.light_mode ?? l.mode ?? "").trim().toLowerCase();
  return {
    mode: LIGHT_MODES.includes(m) ? m : LIGHT_DEFAULTS.mode,
    maxLines: posInt(l.light_max_lines) ?? posInt(l.max_lines) ?? LIGHT_DEFAULTS.maxLines,
    maxFiles: posInt(l.light_max_files) ?? posInt(l.max_files) ?? LIGHT_DEFAULTS.maxFiles,
  };
}

/** A parsed config, or the defaults merged with whatever valid fields `cfg` carries. */
const cfgOf = (cfg) => {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  return {
    mode: LIGHT_MODES.includes(c.mode) ? c.mode : LIGHT_DEFAULTS.mode,
    maxLines: posInt(c.maxLines) ?? LIGHT_DEFAULTS.maxLines,
    maxFiles: posInt(c.maxFiles) ?? LIGHT_DEFAULTS.maxFiles,
  };
};

const uniquePaths = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map((p) => String(p ?? "").trim().replace(/^\.\//, "")).filter(Boolean))].sort();
const labelNames = (labels) => (Array.isArray(labels) ? labels : []).map((l) => String(l?.name ?? l ?? "").trim()).filter(Boolean);
const sortReasons = (rs) => rs.sort((a, b) => a.code.localeCompare(b.code) || a.detail.localeCompare(b.detail));

const REPRO_RE = /steps to reproduce|\brepro(duction|duce)?\b|\bexpected[ _-]+(behaviou?r|result|output)\b|\bactual[ _-]+(behaviou?r|result|output)\b/i;
const FENCE_RE = /^\s*(```|~~~)/m;
const DECISION_LABEL_RE = /^(type[:/]\s*)?(decision|needs-decision|product-decision|rfc|adr)$/i;
const DECISION_TITLE_RE = /^\s*(decision|rfc|adr)[(:]/i;
const POST_DEPLOY_LABELS = new Set(["post-deploy", "awaiting-promotion"]);

/** Risk details for `files`: a built-in risk word or a declared review.risk_paths glob. */
function riskDetails(files, riskPaths) {
  const declared = new Set(riskPathHits(files, riskPaths));
  const out = [];
  for (const f of files) {
    const cls = riskClassOf(f);
    if (cls) out.push(`${f} (${cls})`);
    else if (declared.has(f)) out.push(`${f} (review.risk_paths)`);
  }
  return out;
}

/**
 * Light-lane eligibility of one issue: {mode, verdict, eligible, light, reasons:[{code, detail}]}.
 * verdict: off | eligible | ineligible (a hard reason: files, size, risk_path, investigate, post_deploy, decision) |
 * ambiguous (only soft reasons: no_repro, files_unknown). `light` is the lane shape: true only in mode on when eligible.
 */
export function lightEligibility({ title = "", body = "", labels = [], predictedFiles = [], riskPaths = [], cfg = {} } = {}) {
  const c = cfgOf(cfg);
  if (c.mode === "off") return { mode: "off", verdict: "off", eligible: false, light: false, reasons: [] };
  const hard = [], soft = [];
  const text = String(body ?? "").replace(/<!--[\s\S]*?-->/g, " ");
  if (!FENCE_RE.test(text) && !REPRO_RE.test(text)) soft.push({ code: "no_repro", detail: "no repro, expected behaviour or code block in the body" });

  const files = uniquePaths(predictedFiles);
  const nonTest = files.filter((f) => classifyPath(f) !== "test");
  if (nonTest.length > c.maxFiles) hard.push({ code: "files", detail: `${nonTest.length} predicted non-test files (max ${c.maxFiles})` });
  else if (!nonTest.length) soft.push({ code: "files_unknown", detail: "no predicted non-test files" });

  const names = labelNames(labels);
  const size = laneSize({ labels: names });
  if (size && size !== "S") hard.push({ code: "size", detail: `size:${size}` });

  for (const d of riskDetails(files, riskPaths)) hard.push({ code: "risk_path", detail: d });

  if (isInvestigation(title)) hard.push({ code: "investigate", detail: "investigate( issue" });
  const pdLabel = names.find((n) => POST_DEPLOY_LABELS.has(n.toLowerCase()));
  if (pdLabel) hard.push({ code: "post_deploy", detail: `label ${pdLabel}` });
  else if (postDeployOnly(body)) hard.push({ code: "post_deploy", detail: "every checklist item is a post-deploy check" });
  const decLabel = names.find((n) => DECISION_LABEL_RE.test(n));
  if (decLabel) hard.push({ code: "decision", detail: `label ${decLabel}` });
  else if (DECISION_TITLE_RE.test(String(title ?? ""))) hard.push({ code: "decision", detail: "decision title" });

  const verdict = hard.length ? "ineligible" : soft.length ? "ambiguous" : "eligible";
  const eligible = verdict === "eligible";
  return { mode: c.mode, verdict, eligible, light: c.mode === "on" && eligible, reasons: sortReasons([...hard, ...soft]) };
}

const lineCount = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

/**
 * Upgrade triggers of a light lane: {upgrade, reasons:[{code, detail}]}. diff: {files:[{path, added, deleted}]}
 * (git numstat; "-" binary counts 0). repro: {base, head} words of scripts/acceptance-red-green.sh. testFailures: count
 * of failed targeted-test runs. apiShape: public-API-shape changes from #4449 (strings or {symbol, kind}).
 * Codes: diff_lines, diff_files (non-test files only), repro_not_red, tests_failed_twice, risk_path (every path), api_shape.
 */
export function upgradeTriggers({ diff = null, repro = null, testFailures = 0, riskPaths = [], apiShape = [], cfg = {} } = {}) {
  const c = cfgOf(cfg);
  const reasons = [];
  const rows = (Array.isArray(diff?.files) ? diff.files : []).filter((f) => f && String(f.path ?? "").trim());
  const nonTest = rows.filter((f) => classifyPath(String(f.path).trim()) !== "test");
  const lines = nonTest.reduce((n, f) => n + lineCount(f.added) + lineCount(f.deleted), 0);
  if (lines > c.maxLines) reasons.push({ code: "diff_lines", detail: `${lines} non-test lines (max ${c.maxLines})` });
  const nFiles = uniquePaths(nonTest.map((f) => f.path)).length;
  if (nFiles > c.maxFiles) reasons.push({ code: "diff_files", detail: `${nFiles} non-test files (max ${c.maxFiles})` });
  const base = repro && typeof repro === "object" ? String(repro.base ?? "") : "";
  if (base !== "FAILED") reasons.push({ code: "repro_not_red", detail: base ? `repro on base: ${base}` : "no repro result" });
  const fails = Number(testFailures);
  if (Number.isFinite(fails) && fails >= 2) reasons.push({ code: "tests_failed_twice", detail: `${fails} failed test runs` });
  for (const d of riskDetails(uniquePaths(rows.map((f) => f.path)), riskPaths)) reasons.push({ code: "risk_path", detail: d });
  for (const a of Array.isArray(apiShape) ? apiShape : []) {
    const d = typeof a === "string" ? a.trim() : a && typeof a === "object" ? [a.symbol, a.kind].filter(Boolean).map(String).join(": ") : "";
    if (d) reasons.push({ code: "api_shape", detail: d });
  }
  sortReasons(reasons);
  return { upgrade: reasons.length > 0, reasons };
}
