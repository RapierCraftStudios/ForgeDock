// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Conformance gate for the core work-on: the builder's frozen contract, typed amendments, deterministic prechecks,
 * the structured conformance review and the close plan. Pure functions; lean.mjs owns every effect.
 *
 * The reviewer supplies per-row judgements; the engine computes the verdict. A review without rows (a generic
 * "PASS") is incomplete, and incomplete never merges.
 */
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";

export const DISPOSITIONS = Object.freeze(["deliver", "defer", "not-applicable", "post-deploy"]);
/** Dispositions the engine files as a tracked follow-up issue before anything merges. */
export const TRACKED = Object.freeze(["defer", "post-deploy"]);
const REQ_STATUS = ["implemented", "partial", "missing", "deferred", "post-deploy", "not-applicable"];
const COVER_STATUS = ["covered", "narrowed", "missing"];
const PRESERVE_STATUS = ["intact", "violated", "unverified"];
const EVIDENCE_RE = /^([^\s:]+):(\d+)/;
const TEST_RE = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go|rb)$|\.bats$/;
export const MIN_QUOTE_CHARS = 12;
const C = OUTCOME_CODES;

export const norm = (s) => String(s ?? "").replace(/[`*_>]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
/** A quote must be verbatim (whitespace and markdown emphasis aside) from the issue text. */
export const inIssue = (quote, issueText) => norm(quote).length >= MIN_QUOTE_CHARS && norm(issueText).includes(norm(quote));
export const isTestPath = (p) => TEST_RE.test(String(p));
const blank = (s) => !String(s ?? "").trim() || /^none$/i.test(String(s).trim());

/** Shape check of the builder's contract.json against the issue text. Returns {ok, problems[]}. */
export function validateContract(c, issueText) {
  const problems = [];
  if (!c || typeof c !== "object" || Array.isArray(c)) return { ok: false, problems: ["contract.json is missing or not a JSON object"] };
  const reqs = Array.isArray(c.requirements) ? c.requirements : [];
  if (!reqs.length) problems.push("the contract lists no requirements");
  const ids = new Set();
  for (const r of reqs) {
    const id = r?.id;
    if (!id || ids.has(id)) problems.push(`requirement id missing or duplicated: ${id}`);
    ids.add(id);
    if (!DISPOSITIONS.includes(r?.disposition)) problems.push(`${id}: disposition must be one of ${DISPOSITIONS.join("|")}`);
    if (!inIssue(r?.quote, issueText)) problems.push(`${id}: quote is not verbatim from the issue (at least ${MIN_QUOTE_CHARS} characters)`);
    if (TRACKED.includes(r?.disposition) && blank(r?.why)) problems.push(`${id}: ${r.disposition} needs a why`);
    if (r?.disposition === "not-applicable" && blank(r?.evidence)) problems.push(`${id}: not-applicable needs file:line evidence`);
  }
  const dels = Array.isArray(c.deliverables) ? c.deliverables : [];
  if (reqs.some((r) => r?.disposition === "deliver") && !dels.length) problems.push("deliver requirements but no deliverables");
  for (const d of dels) if (!d?.id || !d?.path) problems.push(`deliverable without id or path: ${JSON.stringify(d).slice(0, 80)}`);
  for (const p of Array.isArray(c.preserve) ? c.preserve : []) if (!p?.id || blank(p?.what)) problems.push("preserve entry without id or what");
  if (!Array.isArray(c.validate) || !c.validate.length) problems.push("the contract names no validate[] commands");
  else for (const v of c.validate) if (!v?.id || blank(v?.command)) problems.push("validate entry without id or command");
  return { ok: problems.length === 0, problems };
}

/**
 * Apply result.json amendments to the frozen contract. Kinds: add-deliverable {path}, add-requirement {requirement},
 * defer|post-deploy {requirement: id}. Every amendment needs a why. Returns {contract, applied[], toTrack[], problems[]}.
 */
export function applyAmendments(frozen, amendments) {
  const c = structuredClone(frozen);
  c.deliverables = c.deliverables ?? [];
  const applied = [], toTrack = [], problems = [];
  for (const a of Array.isArray(amendments) ? amendments : []) {
    const tag = JSON.stringify(a ?? null).slice(0, 100);
    if (blank(a?.why)) { problems.push(`amendment without why: ${tag}`); continue; }
    if (a.kind === "add-deliverable" && !blank(a.path)) {
      if (!c.deliverables.some((d) => d.path === a.path)) c.deliverables.push({ id: a.id ?? `A${c.deliverables.length + 1}`, path: a.path, change: a.why, amended: true });
    } else if (a.kind === "add-requirement" && a.requirement?.id && !blank(a.requirement?.quote)) {
      if (c.requirements.some((r) => r.id === a.requirement.id)) { problems.push(`add-requirement reuses id ${a.requirement.id}`); continue; }
      const r = { disposition: "deliver", ...a.requirement, amended: true };
      if (!DISPOSITIONS.includes(r.disposition)) { problems.push(`add-requirement ${r.id}: bad disposition ${r.disposition}`); continue; }
      if (TRACKED.includes(r.disposition) && blank(r.why)) r.why = a.why;
      c.requirements.push(r);
      if (TRACKED.includes(r.disposition)) toTrack.push(r);
    } else if (TRACKED.includes(a.kind) && a.requirement) {
      const r = c.requirements.find((x) => x.id === a.requirement);
      if (!r) { problems.push(`amendment names unknown requirement ${a.requirement}`); continue; }
      if (!TRACKED.includes(r.disposition)) { r.disposition = a.kind; r.why = a.why; r.amended = true; toTrack.push(r); }
    } else { problems.push(`unknown or incomplete amendment: ${tag}`); continue; }
    applied.push({ kind: a.kind, target: a.path ?? a.requirement?.id ?? a.requirement, why: String(a.why).trim() });
  }
  return { contract: c, applied, toTrack, problems };
}

/**
 * Deterministic checks before any reviewer tokens are spent: unauthorized files, failed or missing validation,
 * requirements not implemented, and deferrals without a tracking issue. Returns {ok, failures[]}.
 */
export function precheck({ contract, result, changedFiles, ignore = [] }) {
  const failures = [];
  const authorized = new Set((contract.deliverables ?? []).map((d) => d.path));
  const creep = changedFiles.filter((f) => !ignore.some((p) => f.startsWith(p)) && !authorized.has(f) && !isTestPath(f));
  if (creep.length) failures.push({ code: C.CONFORMANCE_SCOPE_CREEP, detail: `changed outside the contract's deliverables: ${creep.join(", ")}` });
  const runs = Array.isArray(result?.validation) ? result.validation : [];
  for (const v of contract.validate ?? []) {
    const r = runs.find((x) => x?.id === v.id);
    if (!r) failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, detail: `validate ${v.id} (\`${v.command}\`) has no recorded result` });
    else if (r.exit !== 0) failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, detail: `validate ${v.id} failed (exit ${r.exit})` });
  }
  const st = Array.isArray(result?.requirements) ? result.requirements : [];
  for (const r of contract.requirements ?? []) {
    const s = st.find((x) => x?.id === r.id)?.status;
    if (TRACKED.includes(r.disposition)) {
      if (!r.tracked) failures.push({ code: C.CONFORMANCE_UNTRACKED_DEFERRAL, detail: `${r.id} is ${r.disposition} with no tracking issue` });
    } else if (r.disposition === "deliver") {
      if (s === "deferred" || s === "post-deploy") failures.push({ code: C.CONFORMANCE_UNTRACKED_DEFERRAL, detail: `${r.id} was contracted as deliver but reported "${s}" without a typed amendment` });
      else if (s !== "implemented") failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, detail: `${r.id} reported "${s ?? "no status"}"` });
    }
  }
  return { ok: failures.length === 0, failures };
}

/** The reviewer's JSON object (a json fence first, then the outermost braces), or null. */
export function parseReview(text) {
  const s = String(text ?? "");
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s)?.[1];
  for (const cand of [fence, s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)]) {
    if (!cand) continue;
    try { const j = JSON.parse(cand); if (j && typeof j === "object" && !Array.isArray(j)) return j; } catch { /* next candidate */ }
  }
  return null;
}

/** Row completeness: every contract requirement, preserve item and changed file has a well-formed row. */
export function checkCompleteness(rv, { contract, changedFiles, issueText, pathExists = () => false, ignore = [] }) {
  const p = [];
  const arr = (k) => (Array.isArray(rv?.[k]) ? rv[k] : null);
  if (!["CONFORMS", "NONCONFORMING"].includes(rv?.verdict)) p.push("verdict must be CONFORMS or NONCONFORMING");
  const cov = arr("issue_coverage");
  if (!cov?.length) p.push("issue_coverage is missing or empty");
  for (const c of cov ?? []) {
    if (!COVER_STATUS.includes(c?.status)) p.push(`issue_coverage status invalid: ${c?.status}`);
    if (!inIssue(c?.quote, issueText)) p.push(`issue_coverage quote is not verbatim from the issue: "${String(c?.quote ?? "").slice(0, 60)}"`);
  }
  const reqs = arr("requirements");
  if (!reqs) p.push("requirements rows are missing");
  for (const r of contract.requirements) {
    const rows = (reqs ?? []).filter((x) => x?.id === r.id);
    if (rows.length !== 1) { p.push(`requirement ${r.id} needs exactly one row (has ${rows.length})`); continue; }
    const row = rows[0];
    if (!REQ_STATUS.includes(row.status)) { p.push(`${r.id}: status invalid: ${row.status}`); continue; }
    if (row.status === "implemented") {
      const m = EVIDENCE_RE.exec(String(row.evidence ?? ""));
      if (!m) p.push(`${r.id}: implemented needs path:line evidence`);
      else if (!changedFiles.includes(m[1]) && !pathExists(m[1])) p.push(`${r.id}: evidence path ${m[1]} does not exist`);
      if (blank(row.validated_by)) p.push(`${r.id}: implemented needs validated_by (a validate id or test)`);
    }
  }
  const scope = arr("scope");
  if (!scope) p.push("scope rows are missing");
  for (const f of changedFiles.filter((x) => !ignore.some((pre) => x.startsWith(pre)))) if (!(scope ?? []).some((s) => s?.file === f)) p.push(`changed file ${f} has no scope row`);
  const pres = arr("preserve") ?? [];
  for (const c of contract.preserve ?? []) {
    const row = pres.find((x) => x?.id === c.id);
    if (!row || !PRESERVE_STATUS.includes(row.status)) p.push(`preserve ${c.id} needs a row with status ${PRESERVE_STATUS.join("|")}`);
  }
  if (rv && rv.regressions != null && !Array.isArray(rv.regressions)) p.push("regressions must be an array");
  return { complete: p.length === 0, problems: p };
}

/**
 * The engine's decision from the reviewer's rows. state: conforms | nonconforming | review.unparseable | review.incomplete.
 * failures[] are {code, detail}; `inconsistent` marks a CONFORMS verdict whose rows fail.
 */
export function decide(rv, ctx) {
  if (!rv) return { state: "review.unparseable", failures: [{ code: C.REVIEW_NO_VERDICT, detail: "no JSON object in the reviewer reply" }] };
  const comp = checkCompleteness(rv, ctx);
  if (!comp.complete) return { state: "review.incomplete", failures: comp.problems.map((d) => ({ code: C.REVIEW_INCOMPLETE, detail: d })) };
  const f = [];
  for (const c of rv.issue_coverage) if (c.status !== "covered") f.push({ code: C.CONFORMANCE_OMISSION, detail: `issue requirement ${c.status}: "${c.quote}"${c.note ? ` (${c.note})` : ""}` });
  for (const r of ctx.contract.requirements) {
    const row = rv.requirements.find((x) => x.id === r.id);
    if (r.disposition === "deliver" && row.status !== "implemented") {
      f.push({ code: ["deferred", "post-deploy"].includes(row.status) ? C.CONFORMANCE_UNTRACKED_DEFERRAL : C.CONFORMANCE_UNIMPLEMENTED, detail: `${r.id} ${row.status}${row.note ? `: ${row.note}` : ""}${row.evidence ? ` (${row.evidence})` : ""}` });
    }
    if (TRACKED.includes(r.disposition) && !r.tracked) f.push({ code: C.CONFORMANCE_UNTRACKED_DEFERRAL, detail: `${r.id} ${r.disposition} without a tracking issue` });
  }
  for (const s of rv.scope) if (blank(s.authorized_by)) f.push({ code: C.CONFORMANCE_SCOPE_CREEP, detail: `${s.file}: ${s.note || "not authorized by the contract"}` });
  for (const p of rv.preserve ?? []) if (p.status !== "intact") f.push({ code: C.CONFORMANCE_PRESERVE_VIOLATED, detail: `${p.id} ${p.status}${p.evidence ? ` (${p.evidence})` : ""}${p.note ? `: ${p.note}` : ""}` });
  for (const r of rv.regressions ?? []) f.push({ code: C.CONFORMANCE_REGRESSION, detail: `${r?.at ?? "?"}: ${r?.failure ?? ""}` });
  if (f.length) return { state: "nonconforming", failures: f, inconsistent: rv.verdict === "CONFORMS" };
  if (rv.verdict !== "CONFORMS") return { state: "nonconforming", failures: [{ code: C.REVIEW_INCONSISTENT, detail: "verdict NONCONFORMING with no failing row" }] };
  return { state: "conforms", failures: [] };
}

/** After a conforming merge: close as completed, linking every tracking issue. */
export function closePlan(contract) {
  const tracked = [...new Set((contract.requirements ?? []).filter((r) => TRACKED.includes(r.disposition)).map((r) => r.tracked).filter(Boolean))];
  return { reason: "completed", tracked };
}

/** One line per requirement for the follow-up script: a stable key (id + quote) and a why. Tabs and newlines removed. */
export function followupItems(reqs) {
  const flat = (s) => String(s ?? "").replace(/[\t\r\n`]+/g, " ").replace(/\s+/g, " ").trim();
  return reqs.map((r) => ({ id: r.id, key: flat(`${r.id}: ${r.quote}`).slice(0, 240), why: flat(`${r.disposition}: ${r.why ?? ""}`).slice(0, 400) }));
}
