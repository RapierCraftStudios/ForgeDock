// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Fixed comment templates for the core work-on. Pure functions, no model calls. Missing fields read "not reported". */

export const NR = "not reported";

/** Single-line, table-safe text: collapse newlines, escape pipes. */
export const cell = (v) => {
  const s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  const t = s.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
  return t || NR;
};
/** Inline text: newlines collapsed (keeps list items and one-liners intact). */
const line = (v) => cell(v).replace(/\\\|/g, "|");
const arr = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const bullets = (v) => {
  const items = arr(v).map((x) => line(typeof x === "object" && x ? Object.values(x).join(" - ") : x)).filter((x) => x !== NR);
  return items.length ? items.map((x) => `- ${x}`).join("\n") : NR;
};

const norm = (r) => r ?? {};
const objs = (v, keys) => arr(v).map((x) => (x && typeof x === "object" ? x : { [keys[0]]: x }));

export function changesTable(r, gitFiles = []) {
  let rows = objs(norm(r).changes, ["file"]);
  if (!rows.length) rows = gitFiles.map((file) => ({ file }));
  if (!rows.length) return NR;
  return ["| file | change | why |", "| --- | --- | --- |", ...rows.map((x) => `| ${cell(x.file)} | ${cell(x.change)} | ${cell(x.why)} |`)].join("\n");
}

export function verification(r) {
  const rows = objs(norm(r).tests, ["command"]);
  if (!rows.length) return NR;
  return rows.map((t) => `- \`${line(t.command).replace(/`/g, "'")}\`: ${line(t.result)}; fails without fix: ${t.fails_without_fix === true ? "yes" : t.fails_without_fix === false ? "no" : "unknown"}`).join("\n");
}

export function renderValidate(r, verdict) {
  const x = norm(r);
  return `## Validation: ${verdict}\n**Verdict:** ${verdict}\n\n**Evidence**\n${bullets(x.evidence)}\n\n**Root cause:** ${line(x.root_cause)}\n\n**Summary:** ${line(String(x.summary ?? "").split("\n")[0].slice(0, 300))}`;
}

export function renderPlan(r, gitFiles = []) {
  const x = norm(r);
  const files = objs(x.changes, ["file"]).map((c) => c.file).filter(Boolean);
  const testPlan = objs(x.tests, ["command"]).map((t) => t.command).filter(Boolean);
  return `## Plan\n**Approach:** ${line(x.approach)}\n\n**Files**\n${bullets(files.length ? files : gitFiles)}\n\n**Sibling sites checked**\n${bullets(Array.isArray(x.sibling_sites_checked) ? x.sibling_sites_checked.map((s) => (s && typeof s === "object" ? Object.values(s).join(": ") : s)) : x.sibling_sites_checked)}\n\n**Test plan**\n${bullets(testPlan)}`;
}

export function renderReview(rv) {
  const yn = (b) => (b ? "yes" : "no");
  return `## Review: ${rv.verdict}\n**Fixes the issue:** ${yn(rv.fixes_issue)}${rv.fixes_issue ? "" : ` - ${line(rv.reason)}`}\n**Regression:** ${yn(rv.regression)}${rv.regression ? ` - ${line(rv.reason)}` : ""}\n**Reason:** ${line(rv.reason)}\n**Checked:** ${line(rv.checked)}`;
}

export function renderSummary(r, gitFiles = []) {
  return `**Root cause:** ${line(norm(r).root_cause)}\n\n**Changes**\n${changesTable(r, gitFiles)}\n\n**Verification**\n${verification(r)}`;
}

export function renderRegister({ result, gitFiles = [], review, links = {}, prUrl, usage, policy }) {
  const x = norm(result);
  const link = (k, v) => (v ? `- ${k}: ${v}\n` : "");
  return `## Work-on: fixed\n**Summary:** ${line(x.summary)}\n\n${renderSummary(result, gitFiles)}\n\n**Risks:** ${line(Array.isArray(x.risks) ? x.risks.join("; ") : x.risks)}\n**Follow-ups:** ${line(Array.isArray(x.follow_ups) ? x.follow_ups.join("; ") : x.follow_ups)}\n\n**Review:** ${review.verdict} (fixes issue: ${review.fixes_issue ? "yes" : "no"}, regression: ${review.regression ? "yes" : "no"}) ${line(review.reason)}\n\n**Links**\n${link("Validation", links.validate)}${link("Plan", links.plan)}${link("Review", links.review)}- PR: ${prUrl}\n\n**Merge policy:** ${line(policy)}\n\n_${usage}_`;
}

export function renderPrBody({ issue, result, gitFiles = [] }) {
  return `Closes #${issue}\n\n${renderSummary(result, gitFiles)}`;
}
