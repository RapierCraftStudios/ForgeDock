// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Fixed comment templates for the core work-on. Pure functions, no model calls. Missing fields read "not reported". */

export const NR = "not reported";
export const MAX_COMMENT_CHARS = 60000;

/** Single-line, table-safe text: collapse newlines, escape pipes. */
export const cell = (v) => {
  const s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  const t = s.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
  return t || NR;
};
const line = (v) => cell(v).replace(/\\\|/g, "|");
const arr = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const bullets = (v) => {
  const items = arr(v).map((x) => line(typeof x === "object" && x ? Object.values(x).join(" - ") : x)).filter((x) => x !== NR);
  return items.length ? items.map((x) => `- ${x}`).join("\n") : NR;
};
const objs = (v, key) => arr(v).map((x) => (x && typeof x === "object" ? x : { [key]: x }));
const norm = (r) => r ?? {};

/** Builder-written markdown is untrusted: drop any FORGE marker comment (even unterminated ones) and normalise newlines. */
export function sanitizeMd(md) {
  return String(md ?? "").replace(/\r\n/g, "\n").replace(/<!--\s*FORGE:[\s\S]*?(?:-->|$)/gi, "").trim();
}
/** Cap a whole comment (marker lines included) at `max` chars, noting the truncation. */
export function capComment(body, max = MAX_COMMENT_CHARS) {
  const s = String(body);
  if (s.length <= max) return s;
  const note = "\n\n_[truncated: comment exceeded the size cap]_";
  return s.slice(0, max - note.length) + note;
}
const usable = (md) => sanitizeMd(md).replace(/\s+/g, " ").length >= 20;

/** Text of the `### heading` section (up to the next heading), or "". */
export function section(md, heading) {
  const s = sanitizeMd(md);
  const re = new RegExp(`^#{2,4}\\s*${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im");
  const m = re.exec(s);
  if (!m) return "";
  const rest = s.slice(m.index + m[0].length);
  const next = /^#{2,4}\s/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

const VERDICTS = { fixed: "CONFIRMED", "already-fixed": "ALREADY-FIXED", invalid: "INVALID", blocked: "BLOCKED" };

// ---- fallbacks rendered from result.json fields ----
function investigationFallback(r) {
  const x = norm(r);
  return `**Verdict**: ${VERDICTS[x.status] ?? NR}\n**Confidence**: ${NR}\n**Severity**: ${NR}\n**Task Type**: ${NR}\n\n### What Was Claimed\n${NR}\n\n### What We Found\n${bullets(x.evidence)}\n\n### Root Cause\n${line(x.root_cause)}\n\n### Affected Files\n${bullets(objs(x.changes, "file").map((c) => `${c.file ?? ""}${c.change ? `: ${c.change}` : ""}`))}\n\n### Sibling Sweep\n${bullets(x.sibling_sites_checked)}\n\n### History\n${NR}\n\n### Recommendation\n${line(x.summary)}\n\n### Related Issues\n${NR}`;
}
function planFallback(r, gitFiles) {
  const x = norm(r);
  const rows = objs(x.changes, "file");
  const files = rows.length ? rows : gitFiles.map((file) => ({ file }));
  const table = files.length ? ["| File | Change | Why |", "| --- | --- | --- |", ...files.map((c) => `| ${cell(c.file)} | ${cell(c.change)} | ${cell(c.why)} |`)].join("\n") : NR;
  return `### Approach\n${line(x.approach ?? x.summary)}\n\n### Deliverables\n${table}\n\n### Acceptance Criteria\n${NR}\n\n### Implementation Order\n${NR}\n\n### Out of Scope\n${NR}\n\n### Risk Assessment\n${bullets(x.risks)}`;
}
export function verification(r) {
  const rows = objs(norm(r).tests, "command");
  if (!rows.length) return NR;
  return rows.map((t) => `- \`${line(t.command).replace(/`/g, "'")}\`: ${line(t.result)}; fails without fix: ${t.fails_without_fix === true ? "yes" : t.fails_without_fix === false ? "no" : "unknown"}`).join("\n");
}
function implementationFallback(r, gitFiles) {
  const x = norm(r);
  const rows = objs(x.changes, "file");
  const changes = rows.length ? rows.map((c) => `- ${line(c.file)}: ${line(c.change)}`).join("\n") : bullets(gitFiles);
  return `### Approach\n${line(x.approach ?? x.summary)}\n\n### Changes\n${changes}\n\n### Acceptance Criteria Status\n${NR}\n\n### Verification\n${verification(r)}\n\n### Notes\n${bullets([...arr(x.risks), ...arr(x.follow_ups)])}`;
}

// ---- stage comments ----
export function renderInvestigation(md, result) {
  return `## Investigation Report\n${usable(md) ? sanitizeMd(md) : investigationFallback(result)}`;
}
export function renderPlan(md, result, gitFiles = []) {
  return `## Implementation Plan\n${usable(md) ? sanitizeMd(md) : planFallback(result, gitFiles)}`;
}
export function renderImplementation(md, result, { branch, files = [] } = {}) {
  return `## Implementation Complete\n**Branch:** \`${branch ?? NR}\`\n**Files changed:**\n${bullets(files.map((f) => `\`${f}\``))}\n\n${usable(md) ? sanitizeMd(md) : implementationFallback(result, files)}`;
}

/** Builder/reviewer text in a comment: `<` escaped so it can never open an HTML or FORGE marker comment. */
const esc = (v) => cell(v).replace(/</g, "&lt;");
const escl = (v) => line(v).replace(/</g, "&lt;");
/** Canonical contract JSON: stable, and `<` escaped so builder text can never open an HTML/FORGE comment. */
export const contractJson = (c) => JSON.stringify(c, null, 1).replace(/</g, "\\u003c");
const CONTRACT_BLOCK_RE = /<summary>contract\.json \(sha256 ([0-9a-f]{12})\)<\/summary>\s*```json\n([\s\S]*?)\n```/;

/** FORGE:CONTRACT body: readable tables plus the frozen JSON and its hash (read back on a rerun). */
export function renderContract(c, hash, { compact = false } = {}) {
  const json = `<details><summary>contract.json (sha256 ${hash})</summary>\n\n\`\`\`json\n${contractJson(c)}\n\`\`\`\n</details>`;
  if (compact) return `## Builder Contract (frozen \`${hash}\`)\n\n${c.requirements.length} requirement(s), ${(c.deliverables ?? []).length} deliverable(s); the tables are omitted because the contract is large.\n\n${json}`;
  const disp = (r) => `${r.disposition}${r.tracked ? ` → ${r.tracked}` : ["defer", "post-deploy"].includes(r.disposition) ? " (filed after review accepts it)" : ""}${r.why ? ` (${escl(r.why)})` : ""}`;
  const req = c.requirements.map((r) => `| ${esc(r.id)} | ${esc(r.quote)} | ${esc(disp(r))} |`).join("\n");
  const del = (c.deliverables ?? []).map((d) => `| ${esc(d.id)} | \`${esc(d.path)}\` | ${esc(d.change)} | ${esc((d.requirements ?? []).join(", "))} |`).join("\n");
  return `## Builder Contract (frozen \`${hash}\`)\n\n### Requirements\n| Id | From the issue | Disposition |\n| --- | --- | --- |\n${req}\n\n### Deliverables\n${del ? `| Id | Path | Change | Requirements |\n| --- | --- | --- | --- |\n${del}` : "None."}\n\n### Preserve\n${(c.preserve ?? []).map((p) => `- ${escl(p.id)}: ${escl(p.what)}`).join("\n") || "None."}\n\n### Validate\n${(c.validate ?? []).map((v) => `- ${escl(v.id)}: \`${escl(v.command).replace(/`/g, "'")}\``).join("\n") || NR}\n\n${json}`;
}
/** {contract, hash, text} from a FORGE:CONTRACT comment body, or null. */
export function parseContractComment(body) {
  const m = CONTRACT_BLOCK_RE.exec(String(body ?? ""));
  if (!m) return null;
  try { return { hash: m[1], text: m[2], contract: JSON.parse(m[2]) }; } catch { return null; }
}

/** Typed amendments, posted visibly before review. */
export function renderAmendments(applied, filed = {}) {
  return `## Contract Amendments\n| Kind | Target | Why |\n| --- | --- | --- |\n${applied.map((a) => `| ${esc(a.kind)} | ${esc(a.target)}${filed[a.target] ? ` → ${filed[a.target]}` : ""} | ${esc(a.why)} |`).join("\n")}`;
}

/** FORGE:REVIEW for a conforming change: the engine-computed verdict and the reviewer's rows. */
export function renderReview(rv, contract) {
  const rows = contract.requirements.map((r) => {
    const x = (rv.requirements ?? []).find((y) => y.id === r.id) ?? {};
    return `| ${esc(r.id)} | ${esc(x.status)}${r.tracked ? ` (tracked ${r.tracked})` : ""} | ${esc(x.evidence)} | ${esc(x.validated_by)} |`;
  }).join("\n");
  const cov = rv.issue_coverage ?? [];
  return `## Conformance Review\n**Verdict:** CONFORMS (computed by the engine from the rows below)\n\n| Requirement | Status | Evidence | Validated by |\n| --- | --- | --- | --- |\n${rows}\n\n**Issue coverage:** ${cov.filter((c) => c.status === "covered").length}/${cov.length} issue requirement(s) covered by the contract\n**Scope:** ${(rv.scope ?? []).map((s) => `\`${escl(s.file)}\` ← ${escl(s.authorized_by)}`).join(", ") || NR}\n**Preserve:** ${(rv.preserve ?? []).map((p) => `${escl(p.id)} ${escl(p.status)}`).join(", ") || "none"}\n**Regressions:** none\n\n**Notes:** ${escl(rv.summary)}`;
}

/** FORGE:REVIEW in shadow mode: what the enforced gate would have done, without enforcing it. */
export function renderShadowReview({ would, failures = [], review, contract, unfiled = [] }) {
  const head = would === "conforms" ? "would PASS" : `would BLOCK (${escl(would)})`;
  const rows = review ? `\n\n${renderReview(review, contract).split("\n").slice(2).join("\n")}` : "";
  const fl = failures.length ? `\n\n**What the enforced gate would have flagged:**\n${failures.slice(0, 30).map((f) => `- \`${escl(f.code)}\`: ${escl(f.detail)}`).join("\n")}` : "";
  const uf = unfiled.length ? `\n\n**Deferrals not filed in shadow mode:** ${unfiled.map((r) => `${escl(r.id)} (${escl(r.disposition)})`).join(", ")}` : "";
  return `## Conformance Review (shadow mode: not enforced)\n**Gate verdict:** ${head}. Only a requirement found not implemented, or a regression, blocks in shadow mode.${fl}${uf}${rows}`;
}

// ---- PR body ----
export function renderPrBody({ issue, investigation, contract, implementation, result, gitFiles = [], tracked = [] }) {
  const root = section(investigation, "Root Cause") || line(norm(result).root_cause);
  const dels = contract?.deliverables ?? [];
  const deliver = dels.length ? ["| File | Change | Requirements |", "| --- | --- | --- |", ...dels.map((d) => `| ${esc(d.path)} | ${esc(d.change)} | ${esc((d.requirements ?? []).join(", "))} |`)].join("\n")
    : planFallback(result, gitFiles).split("### Deliverables\n")[1].split("\n\n### ")[0];
  const verify = section(implementation, "Verification") || verification(result);
  const remaining = tracked.length ? `\n\n## Remaining work tracked\n${tracked.map((t) => `- ${t}`).join("\n")}` : "";
  return `## Root cause\n${root}\n\n## Deliverables\n${deliver}\n\n## Verification\n${verify}${remaining}\n\nCloses #${issue}`;
}

// ---- trajectory ----
export function renderTrajectory(T) {
  const rows = [["Validate", T.validate], ["Plan", T.plan], ["Implement", T.implement], ["Review", T.review], ["PR", T.pr], ["Base Sync", T.baseSync ?? "not needed"], ["Merge", T.merge], ["Close", T.close]];
  const cellPair = (v) => {
    const [res, notes] = Array.isArray(v) ? v : [v, ""];
    return `${cell(res ?? "not reached")} | ${notes ? cell(notes) : "-"}`;
  };
  return `## Pipeline Trajectory — #${T.issue}\n\n| Phase | Result | Notes |\n| --- | --- | --- |\n${rows.map(([p, v]) => `| ${p} | ${cellPair(v)} |`).join("\n")}\n\n**Decisions**\n${(T.decisions ?? []).length ? T.decisions.map((d) => `- ${line(d)}`).join("\n") : "- none"}\n\n**Anomalies**\n${(T.anomalies ?? []).length ? T.anomalies.map((d) => `- ${line(d)}`).join("\n") : "- none"}\n\n${T.usage ? `_${T.usage}_` : ""}`;
}
