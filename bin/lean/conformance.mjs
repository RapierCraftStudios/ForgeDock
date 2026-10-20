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
/** forge#4165: where a plan decision's justification comes from; audits filter on lint|precedent. */
export const DECISION_SOURCES = Object.freeze(["doc", "lint", "precedent", "spec"]);
const REQ_STATUS = ["implemented", "partial", "missing", "deferred", "post-deploy", "not-applicable"];
const COVER_STATUS = ["covered", "narrowed", "missing"];
const PRESERVE_STATUS = ["intact", "violated", "unverified"];
/** The first path:line anywhere in the evidence text (backticks, quotes and brackets around it are ignored). */
const EVIDENCE_RE = /([^\s:`'"()[\]<>,;]+):(\d+)/;
/** Test files in any common ecosystem: test dirs, *.test.* / *.spec.*, test_*.*, *_test.*, *Test(s).java|kt|cs|php|scala, *_spec.rb, tests.rs, conftest.py, snapshots. */
const TEST_RE = /(^|\/)(test|tests|__tests__|spec|specs|testdata|__snapshots__)\/|\.(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.[a-z0-9]+$|_test\.[a-z0-9]+$|Tests?\.(java|kt|kts|cs|php|scala|swift)$|_spec\.rb$|(^|\/)tests\.rs$|(^|\/)conftest\.py$|\.bats$|\.snap$/;
/** Files any change may touch without being a deliverable: changelogs and dependency lockfiles. */
const INCIDENTAL_RE = /(^|\/)(CHANGELOG|CHANGES|HISTORY)(\.[a-z]+)?$|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock|mix\.lock|pubspec\.lock|Package\.resolved|gradle\.lockfile)$/i;
export const MIN_QUOTE_CHARS = 12;
/** A contract larger than this cannot be posted whole in one comment (the comment cap is 60k). */
export const MAX_CONTRACT_CHARS = 40000;
const C = OUTCOME_CODES;

export const norm = (s) => String(s ?? "").replace(/[`*_>]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const ITEM_PREFIX_RE = /^\s*(?:[-*+]\s+)?(?:\[[ xX]\]\s+)?(?:\d+[.)]\s+)?/;
/**
 * A quote must be verbatim (whitespace and markdown emphasis aside) from the issue text: a substring of at least
 * MIN_QUOTE_CHARS, or a shorter quote that is a whole line or list item (e.g. "- [ ] add --dry-run").
 */
export function inIssue(quote, issueText) {
  const q = norm(quote);
  if (q.length >= MIN_QUOTE_CHARS) return norm(issueText).includes(q);
  if (q.length < 3) return false;
  return String(issueText ?? "").split("\n").some((l) => norm(l.replace(ITEM_PREFIX_RE, "")) === q);
}
const stripHtmlComments = (s) => String(s ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n").trim();
/**
 * #4265: the human scope of an issue: title, body and trusted comments without the engine's own annotations (HTML comment
 * blocks such as FORGE:STATE, and comments the engine posted, which start with "<!-- FORGE:"). Its hash is the edit signal
 * and the provenance of a frozen contract; quote validation keeps using the full text.
 */
export function scopeText(iss, trustedComments = []) {
  const human = (trustedComments ?? []).map((c) => String(c?.body ?? "")).filter((b) => !b.trimStart().startsWith("<!-- FORGE:"));
  return [iss?.title ?? "", stripHtmlComments(iss?.body), ...human.map(stripHtmlComments)].join("\n\n");
}
/** #4265: failures whose detail starts with a contract requirement id also quote that requirement, so a needs-human names what is unmet. */
export function explainFailures(failures, contract) {
  const reqs = new Map((contract?.requirements ?? []).map((r) => [String(r?.id ?? ""), String(r?.quote ?? "")]));
  return (failures ?? []).map((f) => {
    const id = /^([A-Za-z][\w-]*)\b/.exec(String(f?.detail ?? ""))?.[1];
    const q = id && reqs.get(id);
    if (!q) return f;
    return { ...f, detail: `${f.detail} ("${q.length > 160 ? `${q.slice(0, 157)}...` : q}")` };
  });
}
export const isTestPath = (p) => TEST_RE.test(String(p));
export const isIncidentalPath = (p) => INCIDENTAL_RE.test(String(p));
const cleanPath = (p) => String(p ?? "").trim().replace(/^\.\//, "");
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*")}$`);
/** True when deliverable `d` (a file, a dir ending in "/", or a glob) covers changed file `f`. */
export function pathCovers(d, f) {
  const p = cleanPath(d), file = cleanPath(f);
  if (!p) return false;
  if (p.endsWith("/")) return file.startsWith(p);
  if (/[*?]/.test(p)) return globRe(p).test(file);
  return p === file;
}
/** The deliverable id that authorizes `f`, "test", "incidental", or null. */
export function authorizationOf(contract, f) {
  const d = (contract.deliverables ?? []).find((x) => pathCovers(x.path, f));
  if (d) return d.id;
  if (isTestPath(f)) return "test";
  if (isIncidentalPath(f)) return "incidental";
  return null;
}
const blank = (s) => !String(s ?? "").trim() || /^none$/i.test(String(s).trim());

/** forge.yaml lean.repro_test (#4271): "prefer" (default) asks a bug lane for a red-green repro test; "off" is today's contract. */
export const REPRO_MODES = Object.freeze(["off", "prefer"]);
/** True when the issue carries a `bug` or `type:bug` label (names or {name} objects). */
export const isBugIssue = (labels) => (Array.isArray(labels) ? labels : []).some((l) => ["bug", "type:bug"].includes(String(l?.name ?? l).trim().toLowerCase()));

/**
 * Shape check of the builder's contract.json against the issue text. Returns {ok, problems[]}. `repro` (#4271): a bug
 * lane with lean.repro_test on also needs repro_test: {path, id?, command}, or "none" with a repro_test_reason.
 */
/**
 * A validate command that diffs against a remote branch tip (`git diff origin/x`, `git diff origin/x HEAD`) breaks as
 * soon as the base moves on, even when the change is fine. Returns the remote ref it diffs against, or null when every
 * `git diff` segment compares against the merge base (`origin/x...HEAD`, `$(git merge-base …)`) or no remote ref.
 */
export function movingBaseDiff(command) {
  for (const seg of String(command ?? "").split(/&&|\|\||;|\|/)) {
    if (!/\bgit\b(?:\s+-C\s+\S+)?(?:\s+-c\s+\S+)*\s+diff\b/.test(seg)) continue;
    const ref = /(?:^|[\s=])(origin\/[A-Za-z0-9._\/-]+)/.exec(seg)?.[1];
    if (!ref || seg.includes("...") || /merge-base/.test(seg)) continue;
    return ref.replace(/\.\.?$/, "");
  }
  return null;
}

export function validateContract(c, issueText, { repro = false } = {}) {
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
  // forge#4165: decision provenance is optional (contracts frozen before it stay valid) and checked when present.
  if (c.decisions != null && !Array.isArray(c.decisions)) problems.push("decisions must be an array");
  for (const k of Array.isArray(c.decisions) ? c.decisions : []) {
    if (!k?.id || blank(k?.choice)) problems.push(`decision without id or choice: ${JSON.stringify(k ?? null).slice(0, 80)}`);
    else if (!DECISION_SOURCES.includes(k?.source)) problems.push(`${k.id}: decision source must be one of ${DECISION_SOURCES.join("|")}`);
  }
  if (!Array.isArray(c.validate) || !c.validate.length) problems.push("the contract names no validate[] commands");
  else for (const v of c.validate) {
    if (!v?.id || blank(v?.command)) { problems.push("validate entry without id or command"); continue; }
    const ref = movingBaseDiff(v.command);
    if (ref) problems.push(`${v.id}: \`git diff\` against the moving ${ref} tip fails as soon as the base moves on, even when the change is fine; compare against the merge base instead (\`${ref}...HEAD\` or \`$(git merge-base HEAD ${ref})\`)`);
  }
  if (repro) {
    const t = c.repro_test;
    if (t === "none") { if (blank(c.repro_test_reason)) problems.push(`repro_test "none" needs a one-line repro_test_reason`); }
    else if (!t || typeof t !== "object" || Array.isArray(t) || blank(t.path) || blank(t.command)) problems.push(`this is a bug: repro_test must be {"path","id","command"} (a test that fails on the base and passes after the fix) or "none" with a repro_test_reason`);
  }
  if (JSON.stringify(c).length > MAX_CONTRACT_CHARS) problems.push(`the contract is over ${MAX_CONTRACT_CHARS} characters; keep quotes to the requirement sentence and descriptions short`);
  return { ok: problems.length === 0, problems };
}

/**
 * Apply result.json amendments to the frozen contract. Kinds: add-deliverable {path}, add-requirement {requirement},
 * defer|post-deploy {requirement: id}. Every amendment needs a why. Returns {contract, applied[], toTrack[], problems[]}.
 */
export function applyAmendments(frozen, amendments, issueText = null) {
  const c = structuredClone(frozen);
  c.deliverables = c.deliverables ?? [];
  const applied = [], toTrack = [], problems = [];
  for (const a of Array.isArray(amendments) ? amendments : []) {
    const tag = JSON.stringify(a ?? null).slice(0, 100);
    if (blank(a?.why)) { problems.push(`amendment without why: ${tag}`); continue; }
    if (a.kind === "add-deliverable" && !blank(a.path)) {
      const have = c.deliverables.find((d) => d.path === a.path);
      // An existing deliverable keeps its id and gains the why, so an amendment naming a package on an already-listed
      // package.json declares the edge (forge#4159); before, it was reported as applied but changed nothing.
      if (have) { have.change = have.change ? `${have.change}; ${a.why}` : a.why; have.amended = true; }
      else c.deliverables.push({ id: a.id ?? `A${c.deliverables.length + 1}`, path: a.path, change: a.why, amended: true });
    } else if (a.kind === "add-requirement" && a.requirement?.id && !blank(a.requirement?.quote)) {
      if (c.requirements.some((r) => r.id === a.requirement.id)) { problems.push(`add-requirement reuses id ${a.requirement.id}`); continue; }
      if (issueText != null && !inIssue(a.requirement.quote, issueText)) { problems.push(`add-requirement ${a.requirement.id}: quote is not verbatim from the issue`); continue; }
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
 * requirements not implemented, deferrals without a tracking issue, and unexempted hotspot growth. Returns {ok, failures[]}; each failure carries a
 * `kind` (scope_creep, validate_missing, validate_failed, requirement_unimplemented, untracked_deferral, hotspot_growth, repro_red_green) so callers can
 * tell the builder's own failed checks apart from bookkeeping gaps. `ciVerified` (#4167): the current head passed the
 * engine's CI verification, so a validate id left to CI is not missing; a recorded non-zero exit still fails. `repro` (#4271): the repro_test red-green words, checked when given.
 */
export function precheck({ contract, result, changedFiles, ignore = [], ciVerified = false, hotspots = null, repro = null }) {
  const failures = [];
  const creep = changedFiles.filter((f) => !ignore.some((p) => f.startsWith(p)) && !authorizationOf(contract, f));
  if (creep.length) failures.push({ code: C.CONFORMANCE_SCOPE_CREEP, kind: "scope_creep", detail: `changed outside the contract's deliverables: ${creep.join(", ")}` });
  const runs = Array.isArray(result?.validation) ? result.validation : [];
  for (const v of contract.validate ?? []) {
    const r = runs.find((x) => x?.id === v.id);
    // #4167: a head the engine verified on CI covers validate ids the builder left to CI (no result, or ci:true without an exit)
    const leftToCi = !r || (r.ci === true && r.exit === undefined);
    if (ciVerified && leftToCi) continue;
    if (leftToCi) failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "validate_missing", detail: `validate ${v.id} (\`${v.command}\`) has no recorded result` });
    else if (r.exit !== 0) failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "validate_failed", detail: `validate ${v.id} (\`${v.command}\`) failed (exit ${r.exit})` });
  }
  const st = Array.isArray(result?.requirements) ? result.requirements : [];
  for (const r of contract.requirements ?? []) {
    const s = st.find((x) => x?.id === r.id)?.status;
    if (TRACKED.includes(r.disposition)) continue; // typed deferrals are judged by the reviewer, then filed before the PR
    if (r.disposition === "deliver") {
      if (s === "deferred" || s === "post-deploy") failures.push({ code: C.CONFORMANCE_UNTRACKED_DEFERRAL, kind: "untracked_deferral", detail: `${r.id} was contracted as deliver but reported "${s}" without a typed amendment` });
      else if (s !== "implemented") failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "requirement_unimplemented", detail: `${r.id} reported "${s ?? "no status"}"` });
    }
  }
  failures.push(...hotspotGrowth({ contract, result, hotspots, changedFiles }));
  if (repro) failures.push(...reproFailures(contract, repro));
  return { ok: failures.length === 0, failures };
}

/**
 * #4271: the frozen repro_test's red-green proof ({base, head} words from scripts/acceptance-red-green.sh). Anything but
 * HEAD=RAN BASE=FAILED fails; code conformance.unimplemented, so it blocks in shadow too and goes back to the builder.
 */
export function reproFailures(contract, { base, head } = {}) {
  if (head === "RAN" && base === "FAILED") return [];
  const t = contract?.repro_test ?? {};
  const name = [t.path, t.id].filter((x) => !blank(x)).join(" ") || "repro_test";
  return [{ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "repro_red_green",
    detail: `repro test ${name} (\`${t.command ?? ""}\`) must fail on the base and pass on head; got BASE=${base ?? "UNRUNNABLE"} HEAD=${head ?? "UNRUNNABLE"}` }];
}

const EXEMPT_RE = /hotspot-exempt:\s*\S/i;
/**
 * forge#4195: a changed file already over `file_lines` (not generated, vendored or glob-excluded) that grew by more
 * than `growth_lines` since the base, with no `hotspot-exempt: <reason>` in a covering deliverable's change or an
 * add-deliverable amendment's why. `hotspots` is scripts/hotspots.sh --base output; null or disabled checks nothing.
 */
export function hotspotGrowth({ contract, result, hotspots, changedFiles = [] }) {
  if (!hotspots || hotspots.enabled === false || !Array.isArray(hotspots.files)) return [];
  const limit = Number(hotspots.growth_lines) || 0, max = Number(hotspots.file_lines) || 0;
  const changed = new Set(changedFiles.map(cleanPath));
  const amends = Array.isArray(result?.amendments) ? result.amendments : [];
  const exempt = (f) => (contract?.deliverables ?? []).some((d) => pathCovers(d.path, f) && EXEMPT_RE.test(String(d.change ?? "")))
    || amends.some((a) => a?.kind === "add-deliverable" && pathCovers(a.path, f) && EXEMPT_RE.test(String(a.why ?? "")));
  return hotspots.files
    .filter((h) => h?.over && !h.excluded && Number(h.growth) > limit && changed.has(cleanPath(h.path)) && !exempt(h.path))
    .map((h) => ({ code: C.MAINTENANCE_HOTSPOT_GROWTH, kind: "hotspot_growth",
      detail: `${h.path} grew by ${h.growth} lines (now ${h.lines}, limit +${limit} over ${max}) without hotspot-exempt` }));
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

/**
 * A basename or path suffix in reviewer evidence, resolved to the one repo path it names (changed files first, then
 * `repoFiles`). An exact match, an ambiguous name or an unknown name is returned unchanged.
 */
export function normalizeEvidencePath(path, { changedFiles = [], repoFiles = [], listed = null } = {}) {
  const p = cleanPath(path);
  if (listed) repoFiles = listed;
  if (!p) return p;
  for (const pool of [changedFiles, repoFiles]) {
    const files = [...pool];
    if (files.includes(p)) return p;
    const hits = [...new Set(files.filter((f) => String(f).endsWith(`/${p}`)))];
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return p;
  }
  return p;
}
/**
 * #4160: an evidence path the reviewer gave as a bare or partial name (`route.ts`, `pdf/route.ts`) resolves to the one
 * changed file it names. Returns the repo path, or null when it is not a unique match.
 */
export function resolveEvidencePath(p, changedFiles = []) {
  const n = normalizeEvidencePath(p, { changedFiles });
  return n && changedFiles.includes(n) ? n : null;
}
/** The path:line in an evidence string, with the path normalized; null when there is none. */
function evidenceOf(text, ctx) {
  const m = EVIDENCE_RE.exec(String(text ?? ""));
  return m ? { path: normalizeEvidencePath(m[1], ctx), line: m[2] } : null;
}
const reviewedFiles = (changedFiles, ignore) => changedFiles.filter((x) => !ignore.some((pre) => x.startsWith(pre)));

/**
 * The rows the engine can fill itself, so bookkeeping is never "incomplete": a scope row per changed file from the
 * contract's own authorization ("none" when unauthorized, still scope creep), a preserve row per id as "unverified"
 * (still preserve_violated), and implemented evidence rewritten to `path:line` with the repo path. Returns a new object.
 */
export function fillEngineRows(rv, { contract, changedFiles = [], repoFiles = [], ignore = [] }) {
  if (!rv || typeof rv !== "object") return rv;
  const out = { ...rv };
  const scope = Array.isArray(rv.scope) ? [...rv.scope] : [];
  for (const f of reviewedFiles(changedFiles, ignore)) if (!scope.some((s) => s?.file === f)) scope.push({ file: f, authorized_by: authorizationOf(contract, f) ?? "none", note: "row filled by the engine", filled: true });
  out.scope = scope;
  const pres = Array.isArray(rv.preserve) ? [...rv.preserve] : [];
  for (const c of contract.preserve ?? []) if (!pres.some((x) => x?.id === c.id)) pres.push({ id: c.id, status: "unverified", note: "no row from the reviewer", filled: true });
  out.preserve = pres;
  if (Array.isArray(rv.requirements)) {
    out.requirements = rv.requirements.map((r) => {
      if (r?.status !== "implemented") return r;
      const e = evidenceOf(r.evidence, { changedFiles, repoFiles });
      return e ? { ...r, evidence: `${e.path}:${e.line}` } : r;
    });
  }
  return out;
}

/** Row completeness: every contract requirement, preserve item and changed file has a well-formed row. */
export function checkCompleteness(rv, { contract, changedFiles, issueText, pathExists = () => false, ignore = [], repoFiles = [] }) {
  const p = [], ids = new Set();
  const miss = (id, msg) => { p.push(msg); ids.add(id); };
  const arr = (k) => (Array.isArray(rv?.[k]) ? rv[k] : null);
  if (!["CONFORMS", "NONCONFORMING"].includes(rv?.verdict)) miss("verdict", "verdict must be CONFORMS or NONCONFORMING");
  const cov = arr("issue_coverage");
  if (!cov?.length) miss("issue_coverage", "issue_coverage is missing or empty");
  for (const c of cov ?? []) {
    if (!COVER_STATUS.includes(c?.status)) miss("issue_coverage", `issue_coverage status invalid: ${c?.status}`);
    if (!inIssue(c?.quote, issueText)) miss("issue_coverage", `issue_coverage quote is not verbatim from the issue: "${String(c?.quote ?? "").slice(0, 60)}"`);
  }
  const reqs = arr("requirements");
  if (!reqs) p.push("requirements rows are missing");
  for (const r of contract.requirements) {
    const rows = (reqs ?? []).filter((x) => x?.id === r.id);
    if (rows.length !== 1) { miss(r.id, `requirement ${r.id} needs exactly one row (has ${rows.length})`); continue; }
    const row = rows[0];
    if (!REQ_STATUS.includes(row.status)) { miss(r.id, `${r.id}: status invalid: ${row.status}`); continue; }
    if (TRACKED.includes(r.disposition) && typeof row.deferral_ok !== "boolean") miss(r.id, `${r.id}: a ${r.disposition} requirement needs deferral_ok true|false (is deferring it justified?)`);
    if (row.status === "implemented") {
      const e = evidenceOf(row.evidence, { changedFiles, repoFiles });
      if (!e) miss(r.id, `${r.id}: implemented needs path:line evidence`);
      else if (!changedFiles.includes(e.path) && !pathExists(e.path)) miss(r.id, `${r.id}: evidence path ${e.path} does not exist`);
      if (blank(row.validated_by)) miss(r.id, `${r.id}: implemented needs validated_by (a validate id or test)`);
    }
  }
  const scope = arr("scope");
  if (!scope) miss("scope", "scope rows are missing");
  // #4160: a file the contract authorizes (deliverable, test, incidental) is already settled by the deterministic precheck;
  // a row is required only for the files it could not authorize (decide() fills those as "none"). A given row is still judged.
  for (const f of reviewedFiles(changedFiles, ignore).filter((x) => !authorizationOf(contract, x))) if (!(scope ?? []).some((s) => s?.file === f)) miss(f, `changed file ${f} has no scope row`);
  const pres = arr("preserve") ?? [];
  for (const c of contract.preserve ?? []) {
    const row = pres.find((x) => x?.id === c.id);
    if (!row || !PRESERVE_STATUS.includes(row.status)) miss(c.id, `preserve ${c.id} needs a row with status ${PRESERVE_STATUS.join("|")}`);
  }
  if (rv && rv.regressions != null && !Array.isArray(rv.regressions)) miss("regressions", "regressions must be an array");
  if (!reqs) for (const r of contract.requirements) ids.add(r.id);
  return { complete: p.length === 0, problems: p, missing: [...ids] };
}

/**
 * The engine's decision from the reviewer's rows. state: conforms | nonconforming | review.unparseable | review.incomplete
 * | review.inconsistent. failures[] are {code, detail}; `inconsistent` marks a CONFORMS verdict whose rows fail;
 * `missing` lists the ids (or sections) a targeted re-ask must fill; `review` is the reply with the engine-filled rows.
 */
export function decide(raw, ctx) {
  if (!raw) return { state: "review.unparseable", failures: [{ code: C.REVIEW_NO_VERDICT, detail: "no JSON object in the reviewer reply" }] };
  const rv = fillEngineRows(raw, ctx);
  const comp = checkCompleteness(rv, ctx);
  if (!comp.complete) return { state: "review.incomplete", failures: comp.problems.map((d) => ({ code: C.REVIEW_INCOMPLETE, detail: d })), missing: comp.missing, review: rv };
  const f = [];
  for (const c of rv.issue_coverage) if (c.status !== "covered") f.push({ code: C.CONFORMANCE_OMISSION, detail: `issue requirement ${c.status}: "${c.quote}"${c.note ? ` (${c.note})` : ""}` });
  for (const r of ctx.contract.requirements) {
    const row = rv.requirements.find((x) => x.id === r.id);
    if (r.disposition === "deliver" && row.status !== "implemented") {
      f.push({ code: ["deferred", "post-deploy"].includes(row.status) ? C.CONFORMANCE_UNTRACKED_DEFERRAL : C.CONFORMANCE_UNIMPLEMENTED, detail: `${r.id} ${row.status}${row.note ? `: ${row.note}` : ""}${row.evidence ? ` (${row.evidence})` : ""}` });
    }
    if (TRACKED.includes(r.disposition) && row.deferral_ok === false) f.push({ code: C.CONFORMANCE_UNJUSTIFIED_DEFERRAL, detail: `${r.id} ${r.disposition} is not justified${row.note ? `: ${row.note}` : ""}; implement it` });
  }
  for (const s of rv.scope) {
    if (!blank(s.authorized_by)) continue;
    const engine = authorizationOf(ctx.contract, s.file);
    if (engine === "test" || engine === "incidental") continue; // always allowed; a reviewer "none" here is a misreading, not creep
    f.push({ code: C.CONFORMANCE_SCOPE_CREEP, detail: `${s.file}: ${s.note || "not authorized by the contract"}` });
  }
  for (const p of rv.preserve ?? []) if (p.status !== "intact") f.push({ code: C.CONFORMANCE_PRESERVE_VIOLATED, detail: `${p.id} ${p.status}${p.evidence ? ` (${p.evidence})` : ""}${p.note ? `: ${p.note}` : ""}` });
  for (const r of rv.regressions ?? []) f.push({ code: C.CONFORMANCE_REGRESSION, detail: `${r?.at ?? "?"}: ${r?.failure ?? ""}` });
  if (f.length) return { state: "nonconforming", failures: f, inconsistent: rv.verdict === "CONFORMS", review: rv };
  // A NONCONFORMING verdict with every row passing gives the builder nothing to fix: re-ask the reviewer.
  if (rv.verdict !== "CONFORMS") return { state: "review.inconsistent", failures: [{ code: C.REVIEW_INCONSISTENT, detail: "verdict NONCONFORMING with no failing row" }], missing: ["verdict"], review: rv };
  return { state: "conforms", failures: [], review: rv };
}

/** The ids (or sections) a targeted re-ask must fill: requirement ids without a valid row, issue_coverage problems, ...; [] when complete. */
export function missingIds(rv, ctx) {
  if (!rv || typeof rv !== "object") return [];
  return checkCompleteness(fillEngineRows(rv, ctx), ctx).missing;
}

/**
 * The reviewer's first reply with the rows of a targeted re-ask applied: a repair row replaces the row with the same id
 * (scope: file), issue_coverage is replaced when the repair sends any, verdict and summary follow the repair when valid.
 */
export function mergeReviewRows(first, repair) {
  if (!first || typeof first !== "object") return repair ?? null;
  if (!repair || typeof repair !== "object") return first;
  const out = { ...first };
  for (const [k, key] of [["requirements", "id"], ["preserve", "id"], ["scope", "file"]]) {
    if (!Array.isArray(repair[k])) continue;
    const rows = Array.isArray(first[k]) ? first[k].filter((x) => !x?.filled) : [];
    for (const r of repair[k]) { const i = rows.findIndex((x) => x?.[key] === r?.[key]); if (i >= 0) rows[i] = r; else rows.push(r); }
    out[k] = rows;
  }
  if (Array.isArray(repair.issue_coverage) && repair.issue_coverage.length) out.issue_coverage = repair.issue_coverage;
  if (Array.isArray(repair.regressions)) out.regressions = [...(Array.isArray(first.regressions) ? first.regressions : []), ...repair.regressions];
  if (["CONFORMS", "NONCONFORMING"].includes(repair.verdict)) { out.verdict = repair.verdict; if (repair.summary) out.summary = repair.summary; }
  return out;
}

/**
 * #4160: the rows the engine requires, pre-filled with every id so the reviewer fills statuses instead of composing rows:
 * one requirement row per R id (status empty), one preserve row per P id ("unverified" until checked), one scope row per
 * changed file pre-filled with the engine's authorization, and one issue_coverage row per contract quote (the reviewer adds
 * any the contract missed). Called as (contract, changedFiles, ignore) or ({contract, changedFiles, ignore}).
 */
export function reviewSkeleton(contract, changedFiles = [], ignore = []) {
  if (contract && !Array.isArray(contract.requirements) && "contract" in contract) ({ contract, changedFiles = [], ignore = [] } = contract);
  const reqs = contract?.requirements ?? [];
  return {
    issue_coverage: reqs.map((r) => ({ quote: r.quote, contract_ids: [r.id], status: "" })),
    requirements: reqs.map((r) => ({ id: r.id, status: "", evidence: "", validated_by: "", ...(TRACKED.includes(r.disposition) ? { deferral_ok: null } : {}), note: "" })),
    scope: reviewedFiles(changedFiles, ignore).map((f) => ({ file: f, authorized_by: authorizationOf(contract ?? {}, f) ?? "none", note: "" })),
    preserve: (contract?.preserve ?? []).map((x) => ({ id: x.id, status: "unverified", evidence: "" })),
    regressions: [], verdict: "", summary: "",
  };
}

/** Requirements the reviewer accepted as deferred or post-deploy that still need a tracking issue. */
export const pendingTracking = (contract) => (contract.requirements ?? []).filter((r) => TRACKED.includes(r.disposition) && !r.tracked);

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

/**
 * forge#4159: package.json edges between workspace packages (scripts/structure-delta.sh `package_edges_added`) that
 * the contract does not name. Named = a deliverable covering the edge's manifest whose `change` names the target
 * package (an add-deliverable amendment counts: its change is the why). A null or `{}` delta names nothing to check.
 */
export function unnamedEdges(contract, delta) {
  const edges = Array.isArray(delta?.package_edges_added) ? delta.package_edges_added : [];
  const dels = contract?.deliverables ?? [];
  return edges.filter((e) => e?.manifest && e?.to && !dels.some((d) => pathCovers(d.path, e.manifest) && String(d.change ?? "").includes(e.to)));
}

/**
 * forge#4159: the one report-only line for the existing reviewer prompt, or "" when there is no import-pair growth
 * and no boundary-config loosening. Never blocks; adds no reviewer run.
 */
export function structureNote(delta) {
  const grow = (Array.isArray(delta?.import_pairs) ? delta.import_pairs : []).filter((p) => p?.files_added > 0);
  const b = delta?.boundary_config_changed;
  const loosened = Boolean(b?.loosens);
  if (!grow.length && !loosened) return "";
  const pairs = grow.map((p) => `${p.files_added} value import${p.files_added === 1 ? "" : "s"} ${p.from}→${p.to}`).join(", ");
  const files = (Array.isArray(b?.files) ? b.files : []).join(", ");
  const config = loosened ? `the repo's boundary config was loosened in this PR (${files})` : "the repo's boundary config allows it";
  const s = grow.length ? `this PR adds ${pairs} (files); ${config}` : `this PR loosens the repo's boundary config (${files})`;
  return `Structure (report only): ${s}; flag only if the contract or the architecture doc says otherwise.`.replace(/[\r\n]+/g, " ");
}
