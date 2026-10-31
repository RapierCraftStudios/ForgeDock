// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Conformance gate for the core work-on: the builder's frozen contract, typed amendments, deterministic prechecks,
 * the structured conformance review and the close plan. Pure functions; lean.mjs owns every effect.
 *
 * The reviewer supplies per-row judgements; the engine computes the verdict. A review without rows (a generic
 * "PASS") is incomplete, and incomplete never merges.
 */
import { OUTCOME_CODES, ENV_VALIDATE_TIMEOUT } from "../engine/outcome-codes.mjs";
import { noComments } from "./context.mjs";
import { activationFailures } from "./activation.mjs";

export const DISPOSITIONS = Object.freeze(["deliver", "defer", "not-applicable", "post-deploy"]);
/** Dispositions the engine files as a tracked follow-up issue before anything merges. */
export const TRACKED = Object.freeze(["defer", "post-deploy"]);
/** forge#4165: where a plan decision's justification comes from; audits filter on lint|precedent. */
export const DECISION_SOURCES = Object.freeze(["doc", "lint", "precedent", "spec"]);
const REQ_STATUS = ["implemented", "partial", "missing", "deferred", "post-deploy", "not-applicable"];
const COVER_STATUS = ["covered", "narrowed", "missing"];
const PRESERVE_STATUS = ["intact", "violated", "unverified"];
/** A path:line inside one evidence token; the path may hold ( ) [ ] segments (route groups, [slug], [...slug]) (#4327). */
const EVIDENCE_RE = /([^:]+):(\d+)/;
/** Test files in any common ecosystem: test dirs, *.test.* / *.spec.*, test_*.*, *_test.*, *Test(s).java|kt|cs|php|scala, *_spec.rb, tests.rs, conftest.py, snapshots. */
const TEST_RE = /(^|\/)(test|tests|__tests__|spec|specs|testdata|__snapshots__)\/|\.(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.[a-z0-9]+$|_test\.[a-z0-9]+$|Tests?\.(java|kt|kts|cs|php|scala|swift)$|_spec\.rb$|(^|\/)tests\.rs$|(^|\/)conftest\.py$|\.bats$|\.snap$/;
/** Files any change may touch without being a deliverable: changelogs and dependency lockfiles. */
const INCIDENTAL_RE = /(^|\/)(CHANGELOG|CHANGES|HISTORY)(\.[a-z]+)?$|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock|mix\.lock|pubspec\.lock|Package\.resolved|gradle\.lockfile)$/i;
export const MIN_QUOTE_CHARS = 12;
/** A contract larger than this cannot be posted whole in one comment (the comment cap is 60k). */
export const MAX_CONTRACT_CHARS = 40000;
import { CHECK_ID_RE } from "./postdeploy-check.mjs";
import { normaliseDecision, deadAnchors } from "./decisions.mjs";
const C = OUTCOME_CODES;

/** #4789: folds what a builder retyping a quote changes: unicode punctuation, markdown links/markup, escapes, invisible chars. */
export const norm = (s) => String(s ?? "")
  .normalize("NFKC")
  .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "")
  .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'").replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
  .replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\u2026/g, "...")
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/\\([^A-Za-z0-9\s])/g, "$1")
  .replace(/[`*_>~#]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const WORD_RE = /[a-z0-9]{3,}/g;
/** The issue line sharing the most words with a quote that missed (for the correction prompt); "" when none shares any. */
export function nearestSpan(quote, issueText) {
  const qw = new Set(norm(quote).match(WORD_RE) ?? []);
  let best = "", bestN = 0;
  for (const l of String(issueText ?? "").split("\n")) {
    const n = norm(l);
    if (!n) continue;
    let hit = 0;
    for (const w of new Set(n.match(WORD_RE) ?? [])) if (qw.has(w)) hit++;
    if (hit > bestN) { bestN = hit; best = l.trim(); }
  }
  return bestN >= 2 ? best.slice(0, 120) : "";
}
const quoteMiss = (id, quote, issueText) => {
  const near = nearestSpan(quote, issueText);
  return `${id}: quote is not verbatim from the issue (at least ${MIN_QUOTE_CHARS} characters)${near ? `; nearest issue text: "${near}"` : ""}`;
};
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
// Scan-based (not a one-pass regex), so nested or unclosed markers cannot survive into the scope hash.
const stripHtmlComments = (s) => noComments(s).replace(/\r\n/g, "\n").trim();
/**
 * #4265: the human scope of an issue: title, body and trusted comments without the engine's own annotations (HTML comment
 * blocks such as FORGE:STATE, and comments the engine posted, which start with "<!-- FORGE:"). Its hash is the edit signal
 * and the provenance of a frozen contract; quote validation keeps using the full text.
 * #4298 (SEC-5): EVERY HTML comment is cut, human ones too. GitHub does not render them, so they are not the scope a
 * human reads, and an edit that only touches a hidden comment is not a scope edit.
 */
export function scopeText(iss, trustedComments = []) {
  const human = (trustedComments ?? []).map((c) => String(c?.body ?? "")).filter((b) => !b.trimStart().startsWith("<!-- FORGE:"));
  return [iss?.title ?? "", stripHtmlComments(iss?.body), ...human.map(stripHtmlComments)].join("\n\n");
}
/** #4265: failures whose detail starts with a contract requirement id also quote that requirement, so a needs-human names what is unmet. */
export function explainFailures(failures, contract) {
  const reqs = new Map((contract?.requirements ?? []).map((r) => [String(r?.id ?? ""), String(r?.quote ?? "")]));
  const amended = new Map((contract?.requirements ?? []).filter((r) => r?.amendment?.text).map((r) => [String(r.id), String(r.amendment.text)]));
  return (failures ?? []).map((f) => {
    const id = /^([A-Za-z][\w-]*)\b/.exec(String(f?.detail ?? ""))?.[1];
    const q = id && reqs.get(id);
    if (!q) return f;
    const am = amended.get(id);
    return { ...f, detail: `${f.detail} ("${q.length > 160 ? `${q.slice(0, 157)}...` : q}"${am ? `, amended to "${am.length > 160 ? `${am.slice(0, 157)}...` : am}"` : ""})` };
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
// A doc a freshness rule can demand: a prose file under a docs directory. Build and dependency files (`requirements.txt`,
// `CMakeLists.txt`) and agent-instruction or workflow-spec files outside a docs directory (`CLAUDE.md`, `commands/*.md`) never
// match, so the exemption cannot carry them past scope_creep.
const DOC_FILE_RE = /(?:^|\/)(?:docs?|devdocs|documentation)\/(?:[^/]+\/)*[^/]+\.(?:md|mdx|rst|adoc)$/i;
/**
 * The docs-freshness rule demands a doc edit the frozen contract cannot name: add-deliverable amendments (why "docs freshness
 * rule") for doc files (`DOC_FILE_RE`) that `after` has and `before` lacked and no deliverable, test or incidental rule authorizes.
 * Only when the freshness check failed before the round (`wasFailing`) and passes after it (`nowOk`); code files stay scope creep.
 */
export function impliedDocDeliverables({ before = [], after = [], contract, wasFailing = false, nowOk = false }) {
  if (!wasFailing || !nowOk) return [];
  const had = new Set(before.map(cleanPath));
  return [...new Set(after.map(cleanPath))]
    .filter((f) => !had.has(f) && DOC_FILE_RE.test(f) && !authorizationOf(contract ?? {}, f))
    .map((path) => ({ kind: "add-deliverable", path, why: "docs freshness rule" }));
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
 * Only revisions count: anything after a standalone `--` is a pathspec (`git diff HEAD -- origin/x.txt`, #4298).
 */
export function movingBaseDiff(command) {
  for (const whole of String(command ?? "").split(/&&|\|\||;|\|/)) {
    const seg = whole.split(/(?:^|\s)--(?=\s|$)/)[0];
    if (!/\bgit\b(?:\s+-C\s+\S+)?(?:\s+-c\s+\S+)*\s+diff\b/.test(seg)) continue;
    const ref = /(?:^|[\s=])(origin\/[A-Za-z0-9._\/-]+)/.exec(seg)?.[1];
    if (!ref || seg.includes("...") || /merge-base/.test(seg)) continue;
    return ref.replace(/\.\.?$/, "");
  }
  return null;
}

/**
 * #4350: true when a command lists the change's file names: a `git diff|log|show` segment with --name-only, --name-status,
 * --stat or --numstat, or `git status --porcelain|--short`. Such a validate is a hand-written scope check; the engine's
 * scope gate (deliverables plus typed amendments) is the authority over it.
 */
export function isScopeCheck(command) {
  return String(command ?? "").split(/&&|\|\||;|\||\$\(|\)|`/).some((seg) =>
    /\bgit\b(?:\s+-C\s+\S+)?(?:\s+-c\s+\S+)*\s+(?:diff|log|show)\b[^]*?\s--(?:name-only|name-status|stat|numstat)\b/.test(seg)
    || /\bgit\b(?:\s+-C\s+\S+)?(?:\s+-c\s+\S+)*\s+status\b[^]*?\s(?:--porcelain|--short|-s)\b/.test(seg));
}

const SCOPE_UTILS = new Set(["grep", "egrep", "fgrep", "sort", "uniq", "wc", "test", "[", "[[", "]", "]]", "echo", "printf", "awk", "sed", "head", "tail", "tr", "cut", "comm", "true", "false", "exit"]);
const SCOPE_GIT = new Set(["diff", "log", "show", "status", "merge-base", "rev-parse"]);
/**
 * #4353: true when a command is only a changed-files allowlist or denylist: isScopeCheck holds and every segment's command
 * is git diff|log|show|status|merge-base|rev-parse or a filter (grep, sort, wc, test, awk, sed…). A command that also runs
 * anything else (`node --test x && git diff --stat`) is not pure, so it stays a real validate.
 */
export function isPureScopeCheck(command) {
  if (!isScopeCheck(command)) return false;
  // text after a `)` belongs to the outer command (its arguments), so `)` is dropped instead of starting a segment
  return String(command ?? "").replace(/\)/g, " ").split(/&&|\|\||;|\||\$\(|`|\n/).every((seg) => {
    const toks = seg.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']+|["']+$/g, ""));
    let i = 0;
    while (i < toks.length && (toks[i] === "!" || toks[i] === "" || /^[A-Za-z_]\w*=/.test(toks[i]))) i++;
    if (i >= toks.length) return true;
    const cmd = toks[i];
    if (cmd !== "git") return SCOPE_UTILS.has(cmd);
    for (i++; i < toks.length && (toks[i] === "-C" || toks[i] === "-c"); i += 2);
    return SCOPE_GIT.has(toks[i]);
  });
}

/**
 * #4353: the contract without its pure scope-check validates (isPureScopeCheck): the engine's scope gate (deliverables plus
 * typed amendments) is the only scope authority, so they are dropped at freeze, not rejected. Returns {contract, dropped:
 * [{id, command}]}; a contract that is not an object or has no validate array comes back unchanged.
 */
export function dropScopeValidates(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract) || !Array.isArray(contract.validate)) return { contract, dropped: [] };
  const dropped = contract.validate.filter((v) => isPureScopeCheck(v?.command)).map((v) => ({ id: v.id, command: v.command }));
  if (!dropped.length) return { contract, dropped };
  return { contract: { ...contract, validate: contract.validate.filter((v) => !isPureScopeCheck(v?.command)) }, dropped };
}

/** #4404: how a deliver requirement is verified: in the lane (default) or by a job outside it (`evidence` names the job). */
export const VERIFY_MODES = Object.freeze(["in_lane", "out_of_band"]);
/**
 * #4404: a requirement quote whose result is only measured outside the lane: Lighthouse, web vitals, field perf or a field
 * or throttled device profile, a nightly or report-only suite, and the perf metric acronyms (matched case-sensitively below).
 */
export const OUT_OF_BAND_RE = /\blighthouse\b|\bweb[- ]vitals\b|\bfield[- ](?:perf\w*|profiles?|data|metrics?)\b|\bthrottled\b|\b(?:nightly|report[- ]only)\b[^.;\n]{0,40}?\b(?:suites?|jobs?|runs?|bench\w*|workflows?)\b/i;
const PERF_METRIC_RE = /\b(?:LCP|INP|TTI|FCP|TTFB)\b/;
export const isOutOfBand = (r) => r?.verify === "out_of_band";
const tagsOutOfBand = (r) => r?.disposition === "deliver" && r?.verify == null && (OUT_OF_BAND_RE.test(String(r?.quote ?? "")) || PERF_METRIC_RE.test(String(r?.quote ?? "")));
/**
 * #4404: at freeze, every deliver requirement without a `verify` whose quote names an out-of-lane measurement becomes
 * verify "out_of_band"; an explicit verify (in_lane too) is never overwritten. Returns {contract, tagged: [ids]}.
 */
export function tagOutOfBand(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract) || !Array.isArray(contract.requirements)) return { contract, tagged: [] };
  const tagged = contract.requirements.filter(tagsOutOfBand).map((r) => r.id);
  if (!tagged.length) return { contract, tagged };
  return { contract: { ...contract, requirements: contract.requirements.map((r) => (tagsOutOfBand(r) ? { ...r, verify: "out_of_band" } : r)) }, tagged };
}
/** #4404: the out-of-band requirements as [{id, quote, job}] (job = the requirement's evidence), for the PR body. */
export const outOfBandRequirements = (contract) => (contract?.requirements ?? []).filter(isOutOfBand).map((r) => ({ id: r.id, quote: r.quote, job: String(r.evidence ?? "").trim() }));

/** Option names whose value a tool writes (output, report, cache or temp dirs), not reads (#4325). */
const WRITE_OPT = /^-(?:o|O|-?[\w-]*(?:out|dir|temp|tmp|cache|report|junit|xml|log)[\w-]*)$/i;
const TMP_PATH = /\$(?:\{TMPDIR(?::-[^}]*)?\}|TMPDIR)\/([^\s"'`;|&<>()=]+)/g;
/**
 * #4325: the `$TMPDIR/<name>` paths a frozen command reads without creating them itself. The run TMPDIR is per run, so such
 * a file (written by the builder before) is gone for the engine's red-green check and for any rerun. A path counts as
 * created when it, or a directory above it, was earlier the target of `>`/`>>`, `tee`, `touch|mkdir|mktemp`, the last
 * argument of `cp|mv|ln|install`, an output-like option (`-o`, `--output`, `--basetemp`, `--junitxml`, `--cache-dir`…) or an
 * env assignment (`X=$TMPDIR/y`). Returns the read paths in first-use order (deduped), e.g. ["$TMPDIR/req.txt"].
 */
export function tmpdirInputs(command) {
  const made = [], reads = [];
  const createdAbove = (p) => made.some((m) => p === m || p.startsWith(`${m}/`));
  for (const seg of String(command ?? "").split(/&&|\|\||;|\||\n/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']+|["']+$/g, ""));
    const words = toks.filter((t) => !/^[A-Za-z_]\w*=/.test(t));
    const cmd = (words[0] ?? "").replace(/^.*\//, "");
    toks.forEach((tok, i) => {
      for (const m of tok.matchAll(TMP_PATH)) {
        const path = m[1].replace(/\/+$/, "");
        const before = tok.slice(0, m.index), prev = toks[i - 1] ?? "";
        const opt = /^(-[\w-]+)=["']?$/.exec(before)?.[1] ?? (before === "" && /^-/.test(prev) ? prev : null);
        const write = /\d*>>?$|&>$/.test(before) || (before === "" && /^(?:\d*>>?|&>)$/.test(prev))
          || /^[A-Za-z_]\w*=["']?$/.test(before) || (opt !== null && WRITE_OPT.test(opt))
          || cmd === "tee" || ["touch", "mkdir", "mktemp"].includes(cmd)
          || (["cp", "mv", "ln", "install"].includes(cmd) && i === toks.length - 1);
        if (write) made.push(path);
        else if (!createdAbove(path) && !reads.includes(`$TMPDIR/${path}`)) reads.push(`$TMPDIR/${path}`);
      }
    });
  }
  return reads;
}

const tmpInputProblem = (id, p) => `${id}: reads ${p}, which the command does not create; the run TMPDIR is per run, so the engine's rerun and red-green check will not find it. Create the file inside the command (\`… > ${p} && …\`) or use a path the repo tracks`;

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
    if (!inIssue(r?.quote, issueText)) problems.push(quoteMiss(id, r?.quote, issueText));
    if (TRACKED.includes(r?.disposition) && blank(r?.why)) problems.push(`${id}: ${r.disposition} needs a why`);
    if (r?.disposition === "post-deploy" && !CHECK_ID_RE.test(String(r?.check ?? ""))) problems.push(`${id}: post-deploy needs a check id (\`check\`, e.g. "login-smoke") naming an entry of .forge/post-deploy-checks.json on the default branch`);
    if (r?.disposition === "not-applicable" && blank(r?.evidence)) problems.push(`${id}: not-applicable needs file:line evidence`);
    for (const m of bucketProblems(r)) problems.push(`${id}: ${m}`);
    if (r?.class != null && !FOLLOWUP_CLASSES.includes(r.class)) problems.push(`${id}: class must be one of ${FOLLOWUP_CLASSES.join("|")}`);
    if (r?.verify != null && !VERIFY_MODES.includes(r.verify)) problems.push(`${id}: verify must be one of ${VERIFY_MODES.join("|")}`);
    if (isOutOfBand(r) && r?.disposition !== "deliver") problems.push(`${id}: verify out_of_band applies only to a deliver requirement`);
    else if (isOutOfBand(r) && blank(r?.evidence)) problems.push(`${id}: verify out_of_band needs evidence naming the job or workflow that measures it (or set verify "in_lane" if this change can check it)`);
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
    for (const p of tmpdirInputs(v.command)) problems.push(tmpInputProblem(v.id, p));
    if (vitestQuietFlag(v.command)) problems.push(`${v.id}: vitest 3 rejects -q/--quiet (usage error before any test runs); use --reporter=dot`);
  }
  if (repro) {
    const t = c.repro_test;
    if (t === "none") { if (blank(c.repro_test_reason)) problems.push(`repro_test "none" needs a one-line repro_test_reason`); }
    else if (!t || typeof t !== "object" || Array.isArray(t) || blank(t.path) || blank(t.command)) problems.push(`this is a bug: repro_test must be {"path","id","command"} (a test that fails on the base and passes after the fix) or "none" with a repro_test_reason`);
    else {
      for (const p of tmpdirInputs(t.command)) problems.push(tmpInputProblem("repro_test", p));
      if (vitestQuietFlag(t.command)) problems.push("repro_test: vitest 3 rejects -q/--quiet; use --reporter=dot");
    }
  }
  if (JSON.stringify(c).length > MAX_CONTRACT_CHARS) problems.push(`the contract is over ${MAX_CONTRACT_CHARS} characters; keep quotes to the requirement sentence and descriptions short`);
  return { ok: problems.length === 0, problems };
}

/** forge#4519: a shell pattern as in scripts/hotspots.sh `case` (`*` crosses `/`, `?` one character), anchored. */
const shellGlobRe = (g) => new RegExp(`^${String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

const AMEND_KINDS = ["add-deliverable", "add-requirement", ...TRACKED, "amend-requirement", "supersedes", "decision"];
const GUARD_ID_RE = /^#?\d+$/;
const AMEND_SLIPS = { "amend-requirement": "defer", limitation: "defer" };
// #4916: near-synonyms builders emit for the per-guard `supersedes` amendment
const SUPERSEDES_SYNONYMS = ["supersede-guard", "supersede", "supersedes-guard"];

/** forge#4574: common builder slips: `type` for `kind`, amend-requirement/limitation as defer, an `R#` in `id` as the requirement. */
function normalizeAmendment(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return a;
  const n = { ...a };
  if (blank(n.kind) && !blank(n.type)) n.kind = n.type;
  // #4594: amend-requirement with a revised `text` is a real amendment; without one it stays the slip for defer
  if (Object.hasOwn(AMEND_SLIPS, n.kind) && !(n.kind === "amend-requirement" && !blank(n.text))) n.kind = AMEND_SLIPS[n.kind];
  if (SUPERSEDES_SYNONYMS.includes(n.kind)) n.kind = "supersedes";
  if (TRACKED.includes(n.kind) && blank(n.requirement) && /^R\d+$/.test(String(n.id ?? ""))) n.requirement = n.id;
  return n;
}

const REF_SEP_RE = /\s*(?:[/,;&+]|\band\b)\s*/i, REF_RANGE_RE = /^R(\d+)\s*[-\u2013\u2014]\s*R?(\d+)$/i, REF_MAX = 50;

/** forge#4655: a slash/comma-joined or ranged requirement reference (`R2/R3`, `R2, R3`, `R2–R3`) as its individual ids; a single id or anything else is returned as is. */
function splitRequirementRefs(ref) {
  if (typeof ref !== "string") return [ref];
  const ids = [];
  for (const part of ref.trim().split(REF_SEP_RE)) {
    const m = REF_RANGE_RE.exec(part);
    if (m && +m[1] <= +m[2] && +m[2] - +m[1] < REF_MAX) for (let i = +m[1]; i <= +m[2]; i++) ids.push(`R${i}`);
    else ids.push(part);
  }
  return ids.length > 1 ? ids : [ref];
}

/** The rejection reason, naming the valid kinds or the missing field so the builder's correction round can fix it. */
function amendmentProblem(a, tag) {
  const kind = a?.kind;
  const need = kind === "add-deliverable" ? "needs a path" : kind === "add-requirement" ? "needs requirement {id, quote}"
    : kind === "supersedes" ? "needs guard: \"#N\" (the guarded issue)" : TRACKED.includes(kind) ? "needs requirement: \"R#\"" : kind === "amend-requirement" ? "needs requirement: \"R#\" and text (the revised wording)"
      : kind === "decision" ? "needs decision {choice, anchors: [paths or globs], symbols?, supersedes?: decision id}" : null;
  const why = need ? `amendment kind '${kind}' ${need}` : `unknown kind '${kind ?? ""}'; valid kinds are ${AMEND_KINDS.join(", ")}`;
  return `unknown or incomplete amendment: ${why}: ${tag}`;
}

/**
 * Apply result.json amendments to the frozen contract. Kinds: add-deliverable {path}, add-requirement {requirement},
 * defer|post-deploy {requirement: id}. Every amendment needs a why. Returns {contract, applied[], toTrack[], problems[]}.
 * `generatedPaths` (forge#4519, forge.yaml maintenance.generated_paths via scripts/hotspots.sh): an add-deliverable on a
 * matching path is refused; the repo's generator or bot owns that file.
 * `decision` {decision:{choice, anchors, symbols?, supersedes?}} (#4695): every anchor must match a file of `baseFiles` (the
 * base tree; null skips the check); `supersedes` names the decision whose engine-authored preserve row it replaces and
 * drops that row; returns the records in `decisions`.
 */
export function applyAmendments(frozen, amendments, issueText = null, { generatedPaths = [], baseFiles = null } = {}) {
  const c = structuredClone(frozen);
  c.deliverables = c.deliverables ?? [];
  const applied = [], toTrack = [], problems = [], decisions = [];
  const genRes = (Array.isArray(generatedPaths) ? generatedPaths : []).filter((g) => typeof g === "string" && g).map(shellGlobRe);
  const rows = [];
  for (const raw of Array.isArray(amendments) ? amendments : []) {
    const n = normalizeAmendment(raw);
    if (n && (TRACKED.includes(n.kind) || n.kind === "amend-requirement") && typeof n.requirement === "string") {
      const ids = splitRequirementRefs(n.requirement);
      if (ids.length > 1) { for (const id of ids) rows.push({ a: { ...n, requirement: id }, raw }); continue; }
    }
    if (n?.kind === "supersedes" && Array.isArray(n.guards) && n.guards.length) {
      // #4916: one supersedes row per guard id; each still hits the GUARD_ID_RE check below
      const { guards, ...rest } = n;
      const ids = blank(rest.guard) ? guards : [rest.guard, ...guards];
      for (const guard of ids) rows.push({ a: { ...rest, guard }, raw });
      continue;
    }
    rows.push({ a: n, raw });
  }
  for (const { a, raw } of rows) {
    const tag = JSON.stringify(raw ?? null).slice(0, 400);
    if (blank(a?.why)) { problems.push(`amendment without why: ${tag}`); continue; }
    if (a.kind === "add-deliverable" && !blank(a.path)) {
      if (genRes.some((re) => re.test(cleanPath(a.path)))) {
        problems.push(`add-deliverable ${a.path}: generated path (forge.yaml maintenance.generated_paths) is owned by the repo's generator/bot; revert the file instead of amending it in`);
        continue;
      }
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
      if (tagsOutOfBand(r)) r.verify = "out_of_band"; // #4404: same freeze-time tag as the planned requirements
      c.requirements.push(r);
      if (TRACKED.includes(r.disposition)) toTrack.push(r);
    } else if (a.kind === "supersedes" && GUARD_ID_RE.test(String(a.guard ?? "").trim())) {
      // #4693: retires one guard's guard_broken for this lane; the reviewer judges it, the engine tells the guarded issue after merge
      const guard = `#${String(a.guard).trim().replace(/^#/, "")}`;
      c.supersedes = [...(c.supersedes ?? []).filter((s) => s.guard !== guard), { guard, why: String(a.why).trim() }];
      applied.push({ kind: a.kind, target: guard, why: String(a.why).trim() });
      continue;
    } else if (a.kind === "amend-requirement" && !blank(a.requirement)) {
      // #4594: the requirement stays deliver and keeps its verbatim quote; the reviewer judges it against amendment.text
      const r = c.requirements.find((x) => x.id === a.requirement);
      if (!r) { problems.push(`amendment names unknown requirement ${a.requirement}`); continue; }
      r.amendment = { text: String(a.text).trim(), why: String(a.why).trim() }; r.amended = true;
    } else if (TRACKED.includes(a.kind) && a.requirement) {
      const r = c.requirements.find((x) => x.id === a.requirement);
      if (!r) { problems.push(`amendment names unknown requirement ${a.requirement}`); continue; }
      if (!TRACKED.includes(r.disposition)) {
        if (a.bucket != null) r.bucket = a.bucket; // #4724
        if (a.kind === "post-deploy" && !CHECK_ID_RE.test(String(a.check ?? r.check ?? ""))) { problems.push(`amendment post-deploy ${a.requirement} needs a check id (check)`); continue; }
        r.disposition = a.kind; r.why = a.why; r.amended = true; r.bucket ??= "post-deploy"; toTrack.push(r); // #4724: an amendment without a bucket defaults to post-deploy
        if (a.kind === "post-deploy") r.check = a.check ?? r.check; // #4626
      }
    } else if (a.kind === "decision") {
      const d = normaliseDecision({ ...a.decision, why: a.decision?.why ?? a.why });
      if (!d) { problems.push(amendmentProblem(a, tag)); continue; }
      const dead = Array.isArray(baseFiles) ? deadAnchors(d.anchors, baseFiles) : [];
      if (dead.length) { problems.push(`decision anchor(s) ${dead.join(", ")} match no file on the base; anchor a path that exists there`); continue; }
      if (!blank(a.decision?.supersedes)) c.preserve = (c.preserve ?? []).filter((p) => p.decision !== a.decision.supersedes && p.id !== a.decision.supersedes);
      decisions.push(a.decision?.supersedes ? { ...d, supersedes: String(a.decision.supersedes) } : d);
      applied.push({ kind: a.kind, target: d.choice.slice(0, 60), why: String(a.why).trim() });
      continue;
    } else { problems.push(amendmentProblem(a, tag)); continue; }
    applied.push({ kind: a.kind, target: a.path ?? a.requirement?.id ?? a.requirement, why: String(a.why).trim() });
  }
  return { contract: c, applied, toTrack, problems, decisions };
}

const PY_MISSING_RE = /ModuleNotFoundError: No module named '([^']+)'|ImportError: No module named '?([\w.]+)'?/;
const NODE_MISSING_RE = /Cannot find (?:module|package) '([^']+)'/;
const CMD_NOT_FOUND_RE = /([^\s:'"`]+): command not found/, SH_NOT_FOUND_RE = /([^\s:'"`]+): not found\b/;
// #4761: a runner rejecting its own flags is a defect of the frozen command, not of the change
const CLI_USAGE_RE = /\bUnknown option\b|Unrecognized CLI Parameter|error: unrecognized arguments|unknown (?:shorthand )?flag\b|bad option:/i;
const VITEST_QUIET_RE = /\bvitest\b[^&|;]*\s(?:-q|--quiet)(?=\s|$)/;
/** #4761: a validate/repro command that passes vitest `-q`/`--quiet`, which vitest 3 rejects; null when fine. */
export function vitestQuietFlag(command) {
  return VITEST_QUIET_RE.test(String(command ?? "")) ? "-q" : null;
}
/** #4761: `-q`/`--quiet` on a vitest segment becomes `--reporter=dot`; other commands come back unchanged. */
export function normalizeRunnerCommand(command) {
  return String(command ?? "").split(/(&&|\|\||;|\|)/).map((seg) => (/\bvitest\b/.test(seg) ? seg.replace(/(\s)(?:-q|--quiet)(?=\s|$)/g, "$1--reporter=dot") : seg)).join("");
}
/** #4761: true when a failed command's {rc, output} is a runner CLI usage error (vitest `Unknown option`, jest `Unrecognized CLI Parameter`, pytest `unrecognized arguments`), not a test failure. */
export function cliUsageError({ rc, output } = {}) {
  return rc !== 0 && CLI_USAGE_RE.test(String(output ?? ""));
}
const KIND_NAME = { command: "command", "python-module": "Python module", "node-module": "Node package" };
/**
 * forge#4323: the host tool or module a failed command could not find, from its {rc, output}: bash/sh "X: command not found"
 * (or rc 127), python "No module named x" (top-level package), node "Cannot find module|package 'x'" (bare specifiers only).
 * Returns {tool, kind: command|python-module|node-module} or null. A path, a relative specifier or a name the repo tracks
 * (`repoHas(name)`) is null: a module the change forgot to create is a code defect, not the environment.
 */
export function missingTool({ rc, output } = {}, { repoHas = () => false, command = "" } = {}) {
  const out = String(output ?? "");
  const local = (name) => !name || name.startsWith(".") || name.startsWith("/") || name.startsWith("file:") || repoHas(name);
  const py = PY_MISSING_RE.exec(out);
  if (py) { const tool = String(py[1] ?? py[2]).split(".")[0]; return local(tool) ? null : { tool, kind: "python-module" }; }
  const js = NODE_MISSING_RE.exec(out);
  if (js) {
    const spec = js[1], scoped = spec.startsWith("@");
    if (!scoped && spec.includes("/")) return null;
    const tool = scoped ? spec.split("/").slice(0, 2).join("/") : spec;
    return local(tool) || (scoped && !tool.includes("/")) ? null : { tool, kind: "node-module" };
  }
  const cmd = CMD_NOT_FOUND_RE.exec(out)?.[1] ?? (rc === 127 ? SH_NOT_FOUND_RE.exec(out)?.[1] ?? String(command).trim().split(/\s+/)[0] : null);
  if (!cmd || cmd.includes("/") || local(cmd)) return null;
  return { tool: cmd, kind: "command" };
}

/** `repoHas` for missingTool: true when any tracked path has a segment equal to `name` or `name.py`. */
export function repoTracks(paths) {
  const segs = new Set();
  for (const p of paths ?? []) for (const x of String(p).split("/")) segs.add(x);
  return (name) => segs.has(name) || segs.has(`${name}.py`);
}

/**
 * Deterministic checks before any reviewer tokens are spent: unauthorized files, failed or missing validation,
 * requirements not implemented, deferrals without a tracking issue, and unexempted hotspot growth. Returns {ok, failures[], superseded[]}; each failure carries a
 * `kind` (scope_creep, validate_missing, validate_failed, validate_env, requirement_unimplemented, untracked_deferral, hotspot_growth, repro_red_green, repro_env) so callers can
 * tell the builder's own failed checks apart from bookkeeping gaps. `ciVerified` (#4167): the current head passed the
 * engine's CI verification, so a validate id left to CI is not missing; a recorded non-zero exit still fails. `repro` (#4271): the repro_test red-green words, checked when given.
 * `validateRuns` (#4323): the engine's rerun {[id]: {rc, output}} of validate commands recorded as failed. A rerun that passes
 * counts as passed; one that could not find a host tool or module (missingTool, with `repoHas`) is kind validate_env, code
 * env.tool_missing (skipped on a CI-verified head), not a conformance failure.
 * `frozen` (#4350): the contract before typed amendments. A failed scope-check validate (isScopeCheck) whose only files
 * outside `frozen` are covered by deliverables an amendment added, with no scope creep left, is superseded by the engine's
 * scope gate: listed in `superseded` [{id, files}], not a failure. Without `frozen`, `superseded` is always [].
 * `ciCovered` (#4527): the validate ids accepted only because the head is CI-verified (no local result, or a missing host
 * tool), for the trajectory; always an array.
 */
export function precheck({ contract, result, changedFiles, ignore = [], ciVerified = false, hotspots = null, repro = null, validateRuns = null, repoHas = () => false, frozen = null, checkIds = null, guardFailures = null, newOffKeys = null }) {
  const failures = [], superseded = [], ciCovered = [];
  // #4626: a post-deploy check id must be on the default branch or added by this PR (`checkIds`: ids of both checks files; null = not resolved)
  if (checkIds) for (const r of contract.requirements ?? []) {
    if (r.disposition === "post-deploy" && !(r.check && checkIds.has(r.check))) failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "check_unknown", detail: `${r.id} post-deploy check ${r.check ? `'${r.check}'` : "id"} is neither on the default branch nor added by this PR (.forge/post-deploy-checks.json)` });
  }
  // #4769: a default-off rollout entry added by the diff needs an activation row
  if (newOffKeys?.length) for (const f of activationFailures(contract, newOffKeys)) failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, ...f });
  const outside = (k) => changedFiles.filter((f) => !ignore.some((p) => f.startsWith(p)) && !authorizationOf(k, f));
  const creep = outside(contract);
  const amendedOnly = frozenAmendedFiles(frozen, contract, outside, creep);
  if (creep.length) failures.push({ code: C.CONFORMANCE_SCOPE_CREEP, kind: "scope_creep", detail: `changed outside the contract's deliverables: ${creep.join(", ")}` });
  const runs = Array.isArray(result?.validation) ? result.validation : [];
  for (const v of contract.validate ?? []) {
    const r = runs.find((x) => x?.id === v.id);
    // #4167: a head the engine verified on CI covers validate ids the builder left to CI (no result, or ci:true without an exit)
    const leftToCi = !r || (r.ci === true && r.exit === undefined);
    if (ciVerified && leftToCi) { ciCovered.push(v.id); continue; }
    if (leftToCi) failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "validate_missing", detail: `validate ${v.id} (\`${v.command}\`) has no recorded result` });
    else if (r.exit !== 0) {
      const rerun = validateRuns?.[v.id];
      if (rerun?.rc === 0) continue;
      if (rerun && cliUsageError(rerun)) { failures.push({ code: C.CONTRACT_INVALID_COMMAND, kind: "validate_command_invalid", detail: `validate ${v.id} (\`${v.command}\`) is a CLI usage error of the runner, a defect of the frozen command rather than of the change` }); continue; }
      // #4906: the rerun timed out (even after the longer retry): host load, not a verdict on the change. A CI-verified head covers it; else an environment error.
      if (rerun?.rc === 124) {
        if (ciVerified) { ciCovered.push(v.id); continue; }
        failures.push({ code: ENV_VALIDATE_TIMEOUT, kind: "validate_timeout", detail: `validate ${v.id} (\`${v.command}\`) timed out (exit 124) on the engine's rerun: infrastructure (host load), not a failed check` });
        continue;
      }
      const miss = rerun ? missingTool(rerun, { repoHas, command: v.command }) : null;
      if (miss && ciVerified) { ciCovered.push(v.id); continue; }
      if (miss) failures.push({ code: C.ENV_TOOL_MISSING, kind: "validate_env", tool: miss.tool, detail: `validate ${v.id} (\`${v.command}\`) could not run: the host is missing ${KIND_NAME[miss.kind]} '${miss.tool}' (environment, not the change)` });
      else if (amendedOnly && isScopeCheck(v.command)) superseded.push({ id: v.id, files: amendedOnly });
      else failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "validate_failed", detail: `validate ${v.id} (\`${v.command}\`) failed (exit ${r.exit})` });
    }
  }
  const st = Array.isArray(result?.requirements) ? result.requirements : [];
  for (const r of contract.requirements ?? []) {
    const s = st.find((x) => x?.id === r.id)?.status;
    if (TRACKED.includes(r.disposition)) continue; // typed deferrals are judged by the reviewer, then filed before the PR
    if (r.disposition === "deliver" && isOutOfBand(r)) {
      // #4404: measured outside the lane; the builder delivers its instrumentation (budget test or bench committed, job configured)
      const row = st.find((x) => x?.id === r.id);
      if (row?.instrumented !== true && s !== "implemented") failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "requirement_unimplemented", detail: `${r.id} is verified out of band${r.evidence ? ` by ${r.evidence}` : ""} but reported "${s ?? "no status"}" without instrumented: true` });
    } else if (r.disposition === "deliver") {
      if (s === "deferred" || s === "post-deploy") failures.push({ code: C.CONFORMANCE_UNTRACKED_DEFERRAL, kind: "untracked_deferral", detail: `${r.id} was contracted as deliver but reported "${s}" without a typed amendment` });
      else if (s !== "implemented") failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "requirement_unimplemented", detail: `${r.id} reported "${s ?? "no status"}"` });
    }
  }
  failures.push(...hotspotGrowth({ contract, result, hotspots, changedFiles }));
  if (repro) failures.push(...reproFailures(contract, repro));
  // #4693: a broken guard fails unless the contract carries a supersedes amendment for it
  const retired = new Set((contract.supersedes ?? []).map((s) => s.guard));
  for (const f of guardFailures ?? []) if (!retired.has(f.guard)) failures.push(f);
  return { ok: failures.length === 0, failures, superseded, ciCovered };
}

/**
 * #4350: the changed files outside the frozen contract when every one of them is covered by a deliverable an amendment
 * added (a path the frozen contract does not list) and the amended contract leaves no scope creep; otherwise null.
 */
function frozenAmendedFiles(frozen, contract, outside, creep) {
  if (!frozen || creep.length) return null;
  const before = outside(frozen);
  if (!before.length) return null;
  const had = new Set((frozen.deliverables ?? []).map((d) => cleanPath(d.path)));
  const added = (contract.deliverables ?? []).filter((d) => !had.has(cleanPath(d.path)));
  return before.every((f) => added.some((d) => pathCovers(d.path, f))) ? before : null;
}

/**
 * #4271: the frozen repro_test's red-green proof ({base, head} words from scripts/acceptance-red-green.sh). Anything but
 * HEAD=RAN BASE=FAILED fails; code conformance.unimplemented, so it blocks in shadow too and goes back to the builder.
 * #4334: HEAD=UNRUNNABLE or no words (the harness could not run the test) is env.repro_unrunnable, kind repro_env: an
 * environment error, never a builder resume.
 */
export function reproFailures(contract, { base, head } = {}) {
  if (head === "RAN" && base === "FAILED") return [];
  const t = contract?.repro_test ?? {};
  const name = [t.path, t.id].filter((x) => !blank(x)).join(" ") || "repro_test";
  if (!head || head === "UNRUNNABLE") {
    return [{ code: C.ENV_REPRO_UNRUNNABLE, kind: "repro_env",
      detail: `repro test ${name} (\`${t.command ?? ""}\`): the harness could not run the test on head (environment, not the change); got BASE=${base ?? "UNRUNNABLE"} HEAD=${head ?? "UNRUNNABLE"}` }];
  }
  const skipped = base === "SKIPPED" ? " (base not run: head did not pass)" : "";
  return [{ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "repro_red_green",
    detail: `repro test ${name} (\`${t.command ?? ""}\`) must fail on the base and pass on head; got BASE=${base ?? "UNRUNNABLE"} HEAD=${head}${skipped}` }];
}

const EXEMPT_RE = /hotspot-exempt:\s*\S/i;
/**
 * forge#4195: a changed file already over `file_lines` (not generated, vendored or glob-excluded; forge#4519: a
 * `generated` row, from linguist-generated, maintenance.generated_paths or a generated header, never counts) that grew by more
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
    .filter((h) => h?.over && !h.excluded && !h.generated && Number(h.growth) > limit && changed.has(cleanPath(h.path)) && !exempt(h.path))
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
const count = (s, ch) => s.split(ch).length - 1;
/** Drops a leading or trailing bracket that has no partner inside the path: `(src/a.js` -> `src/a.js`, `(g)/a.tsx` stays. */
function trimUnbalanced(p) {
  for (let again = true; again && p;) {
    again = false;
    for (const [o, c] of [["(", ")"], ["[", "]"]]) {
      if (p.startsWith(o) && count(p, o) > count(p, c)) { p = p.slice(1); again = true; }
      if (p.endsWith(c) && count(p, c) > count(p, o)) { p = p.slice(0, -1); again = true; }
    }
  }
  return p;
}
/**
 * The first path:line anywhere in the evidence text, verbatim (#4327: `(group)`, `[slug]`, `[...slug]` segments kept).
 * Backticks and quotes are ignored, a markdown link `[label](path:line)` yields its target, and only brackets with no
 * partner inside the path (prose like `(src/a.js:3)`) are dropped.
 */
export function evidencePathLine(text) {
  for (let tok of String(text ?? "").replace(/[`'"]/g, "").split(/[\s,;<>]+/)) {
    const link = tok.lastIndexOf("](");
    if (link >= 0) tok = tok.slice(link + 2);
    const m = EVIDENCE_RE.exec(tok);
    const path = m && trimUnbalanced(m[1]);
    if (path) return { path, line: m[2] };
  }
  return null;
}
/** The path:line in an evidence string, with the path normalized; null when there is none. */
function evidenceOf(text, ctx) {
  const m = evidencePathLine(text);
  return m ? { path: normalizeEvidencePath(m.path, ctx), line: m.line } : null;
}
const MISSING_PATH_RE = /^[^:]+: evidence path .+ does not exist$/;
/** #4327: true when every problem of an incomplete review is an evidence path that did not resolve (a re-ask can fix it). */
export function evidencePathOnly(problems = []) {
  return problems.length > 0 && problems.every((p) => MISSING_PATH_RE.test(String(p)));
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
      if (r?.status !== "implemented" && r?.instrumented !== true) return r;
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
    if (isOutOfBand(r) && typeof row.instrumented !== "boolean") miss(r.id, `${r.id}: a requirement verified out of band needs instrumented true|false (is its budget test or bench committed and its job configured?)`);
    if (row.status === "implemented" || (isOutOfBand(r) && row.instrumented === true)) {
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


/** #4726: a requirement quote that carries a `[type:e2e]` criterion. */
const wantsE2e = (r) => /\[type:e2e\]/i.test(String(r?.quote ?? ""));
const E2E_CMD_RE = /\b(?:playwright|cypress|e2e|live[- ]stack|wdio)\b/i;
/**
 * #4726: whether a validate command runs a real end-to-end check: an entry of `verify.e2e_checks`, a file of the e2e spec set
 * (`e2e.isSpec`), or Playwright/Cypress/e2e/live-stack. A unit test file with stubbed I/O is not one.
 */
export function isE2eCommand(command, e2e = null) {
  const cmd = String(command ?? "");
  if ((e2e?.checks ?? []).some((c) => c && cmd.includes(c))) return true;
  if (typeof e2e?.isSpec === "function" && cmd.split(/\s+/).some((t) => t && e2e.isSpec(t.replace(/^["']+|["']+$/g, "")))) return true;
  return E2E_CMD_RE.test(cmd);
}
/** #4726: true when a V-ref named in the row's `validated_by` resolves to a contract validate command that is a real e2e check. */
export function e2eVerified(row, contract, e2e = null) {
  const by = String(row?.validated_by ?? "");
  const refs = (contract?.validate ?? []).filter((v) => v?.id && new RegExp(`(?:^|[^A-Za-z0-9_])${v.id}(?![A-Za-z0-9_])`).test(by));
  return refs.some((v) => isE2eCommand(v.command, e2e)) || (!refs.length && isE2eCommand(by, e2e));
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
  const amendedOf = (ids) => (ctx.contract.requirements ?? []).find((r) => r.amendment?.text && (ids ?? []).includes(r.id));
  const notAccepted = (r) => (r ? `amendment not accepted (${r.id} amended to "${String(r.amendment.text).slice(0, 200)}"): ` : "");
  for (const c of rv.issue_coverage) if (c.status !== "covered") f.push({ code: C.CONFORMANCE_OMISSION, detail: `${notAccepted(amendedOf(c.contract_ids))}issue requirement ${c.status}: "${c.quote}"${c.note ? ` (${c.note})` : ""}` });
  for (const r of ctx.contract.requirements) {
    const row = rv.requirements.find((x) => x.id === r.id);
    if (r.disposition === "deliver" && isOutOfBand(r)) {
      // #4404: the measured result lives in the named job; only the instrumentation is judged here
      if (row.instrumented !== true) f.push({ code: C.CONFORMANCE_UNIMPLEMENTED, detail: `${r.id} verified out of band${r.evidence ? ` by ${r.evidence}` : ""}: instrumentation missing${row.note ? `: ${row.note}` : ""}${row.evidence ? ` (${row.evidence})` : ""}` });
    } else if (r.disposition === "deliver" && row.status !== "implemented") {
      f.push({ code: ["deferred", "post-deploy"].includes(row.status) ? C.CONFORMANCE_UNTRACKED_DEFERRAL : C.CONFORMANCE_UNIMPLEMENTED, detail: `${r.amendment?.text ? `${r.id} amendment not accepted (amended to "${String(r.amendment.text).slice(0, 200)}"): ` : `${r.id} `}${row.status}${row.note ? `: ${row.note}` : ""}${row.evidence ? ` (${row.evidence})` : ""}` });
    } else if (r.disposition === "deliver" && wantsE2e(r) && !e2eVerified(row, ctx.contract, ctx.e2e)) {
      f.push({ code: C.CONFORMANCE_E2E_UNVERIFIED, detail: `${r.id} is a [type:e2e] criterion but ${row.validated_by || "its validated_by"} is not a real end-to-end check (the repo's e2e set, Playwright/browser/live stack); run one, or mark ${r.id} post-deploy with a tracked follow-up` });
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
    requirements: reqs.map((r) => ({ id: r.id, status: "", evidence: "", validated_by: "", ...(TRACKED.includes(r.disposition) ? { deferral_ok: null } : {}), ...(isOutOfBand(r) ? { verify: "out_of_band", job: r.evidence ?? "", instrumented: null } : {}), note: "" })),
    scope: reviewedFiles(changedFiles, ignore).map((f) => ({ file: f, authorized_by: authorizationOf(contract ?? {}, f) ?? "none", note: "" })),
    preserve: (contract?.preserve ?? []).map((x) => ({ id: x.id, status: "unverified", evidence: "" })),
    regressions: [], verdict: "", summary: "",
  };
}

/** Requirements the reviewer accepted as deferred or post-deploy that still need a tracking issue. */
export const pendingTracking = (contract) => (contract.requirements ?? []).filter((r) => TRACKED.includes(r.disposition) && !r.tracked);

/** #4398: an `investigate(` (or `investigate:`) issue, whose stated question must be answered before it closes as completed. */
export const isInvestigation = (title) => /^\s*investigate[(:]/i.test(String(title ?? ""));

/**
 * After a conforming merge: close as completed, linking every tracking issue. #4398: an investigation with a deferred or
 * post-deploy requirement, or a deliver requirement whose review row is not implemented, closes "partial" instead; `open`
 * holds those requirements (the open question, carried forward). A null review (reviewer skipped) judges dispositions only.
 */
export function closePlan(contract, { title = null, review = null } = {}) {
  const reqs = contract.requirements ?? [];
  const tracked = [...new Set(reqs.filter((r) => TRACKED.includes(r.disposition)).map((r) => r.tracked).filter(Boolean))];
  if (!isInvestigation(title)) return { reason: "completed", tracked };
  const rows = Array.isArray(review?.requirements) ? review.requirements : null;
  const open = reqs.filter((r) => TRACKED.includes(r.disposition)
    || (r.disposition === "deliver" && rows && rows.find((x) => x?.id === r.id)?.status !== "implemented"));
  return open.length ? { reason: "partial", tracked, open } : { reason: "completed", tracked };
}

const UNUSABLE_REVIEW = ["review.incomplete", "review.inconsistent", "review.unparseable"];
/**
 * #4398 batch-report line from the lane rows' `conformance` ({mode, would, risk}): shadow lanes, how many the enforced
 * gate would have blocked, the false-block share (a would-block on an unusable review, the scripts/calibration.mjs
 * recommendEnforce proxy) and the lanes enforced by a declared risk path. Null when no row carries conformance.
 */
export function formatShadowSummary(rows) {
  const cs = (rows ?? []).map((r) => r?.conformance).filter((c) => c && typeof c === "object");
  if (!cs.length) return null;
  const sh = cs.filter((c) => c.mode === "shadow");
  const would = sh.filter((c) => typeof c.would === "string" && c.would !== "conforms").length;
  const falseB = sh.filter((c) => UNUSABLE_REVIEW.includes(c.would)).length;
  const pct = (k) => (sh.length ? `${Math.round((k / sh.length) * 100)}%` : "n/a");
  const risk = cs.filter((c) => c.risk === true).length;
  const byKind = {};
  for (const c of cs) for (const k of new Set(Array.isArray(c.kinds) ? c.kinds : [])) byKind[k] = (byKind[k] ?? 0) + 1;
  const kinds = Object.entries(byKind).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}/${cs.length} (${Math.round((n / cs.length) * 100)}%)`);
  return `conformance: ${sh.length} shadow lane${sh.length === 1 ? "" : "s"}, would block ${would} (${pct(would)}), false-block ${falseB} (${pct(falseB)}: would-block on an incomplete/inconsistent/unparseable review); risk-path enforced: ${risk}${kinds.length ? `; per kind: ${kinds.join(", ")}` : ""}`;
}

/** #4664: follow-up classes, one issue each per parent (scripts/file-deferred-followups.sh); post-deploy is one rollup per release lane (#4724). */
export const FOLLOWUP_CLASSES = ["engineering", "post-deploy", "external", "ops"];
/** #4724: the bucket every deferred row gets at contract time. `date:<YYYY-MM-DD>` and `owner:<action>` carry a value. */
export const BUCKETS = Object.freeze(["post-deploy", "verify-now", "date", "owner", "new-issue"]);
const DATE_BUCKET_RE = /^date:(\d{4})-(\d{2})-(\d{2})$/;
/** The kind of a bucket (`date:2026-12-01` -> `date`), or null when absent or unknown. */
export const bucketKind = (b) => { const k = String(b ?? "").split(":")[0]; return BUCKETS.includes(k) ? k : null; };
/** #4724: problems with a deferred row's bucket (a defer or post-deploy row needs exactly one; owner actions are never post-deploy). */
export function bucketProblems(r) {
  const b = r?.bucket;
  if (!TRACKED.includes(r?.disposition)) return b == null ? [] : ["bucket applies only to a defer or post-deploy requirement"];
  if (b == null || b === "") return [`${r.disposition} needs a bucket (${BUCKETS.join("|")}; \`date:<YYYY-MM-DD>\`, \`owner:<action>\`)`];
  const k = bucketKind(b), out = [];
  if (!k || (k !== "date" && k !== "owner" && b !== k)) out.push(`bucket '${b}' must be post-deploy, verify-now, date:<YYYY-MM-DD>, owner:<action> or new-issue`);
  else if (k === "date") {
    const m = DATE_BUCKET_RE.exec(String(b)), d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!m || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) out.push(`bucket '${b}' must be an absolute date:<YYYY-MM-DD>, not a relative wait`);
  } else if (k === "owner" && blank(String(b).slice(6))) out.push("bucket owner needs the action: owner:<action>");
  if (r.disposition === "post-deploy" && (k === "owner" || k === "new-issue")) out.push(`a ${k} item is never post-deploy: use disposition defer`);
  if (k === "owner" && r.class != null && r.class !== "external" && r.class !== "ops") out.push("an owner bucket belongs in class external or ops, never post-deploy");
  return out;
}
/** The follow-up class of a requirement: owner -> external, new-issue -> engineering, other buckets post-deploy; else its `class`, else post-deploy for that disposition, else engineering. */
export function followupClass(r) {
  const k = bucketKind(r?.bucket);
  if (k === "owner") return r?.class === "ops" ? "ops" : "external";
  if (k === "new-issue") return r?.class && r.class !== "post-deploy" && FOLLOWUP_CLASSES.includes(r.class) ? r.class : "engineering";
  if (k) return "post-deploy";
  return FOLLOWUP_CLASSES.includes(r?.class) ? r.class : r?.disposition === "post-deploy" ? "post-deploy" : "engineering";
}
/** #4724: deferred items per bucket kind (`none` = no bucket), for the batch telemetry line. */
export const bucketTally = (reqs) => (reqs ?? []).reduce((t, r) => { const k = bucketKind(r?.bucket) ?? "none"; t[k] = (t[k] ?? 0) + 1; return t; }, {});

/**
 * One line per requirement for the follow-up script: a stable key (id + quote), a why and a class. Tabs and newlines removed.
 * #4724: a bucketed row's why carries `[bucket:<kind>]` (the script counts and routes on it) and a date bucket's `due:<date>`
 * plus `from:<date>` (the contract-time anchor, `now` ms) that the gate re-anchors when the parent ships later.
 */
export function followupItems(reqs, { now = Date.now() } = {}) {
  const flat = (s) => String(s ?? "").replace(/[\t\r\n`]+/g, " ").replace(/\s+/g, " ").trim();
  const check = (r) => (r.disposition === "post-deploy" && r.check ? `[check:${flat(r.check)}] ` : ""); // #4626: the follow-up item names its check
  return reqs.map((r) => {
    const k = bucketKind(r.bucket);
    const tag = k ? `[bucket:${k}] ` : "";
    const due = k === "date" ? `due:${String(r.bucket).slice(5)} from:${new Date(now).toISOString().slice(0, 10)} ` : "";
    const head = k === "owner" ? `owner: ${flat(String(r.bucket).slice(6))}. ` : k && k !== "new-issue" ? "post-deploy: " : `${r.disposition}: `;
    return { id: r.id, class: followupClass(r), key: flat(`${r.id}: ${r.quote}`).slice(0, 240).trim(), why: flat(`${head}${tag}${check(r)}${due}${r.why ?? ""}`).slice(0, 400).trim() };
  });
}

/** #4388: the follow-up script's `key\tissue` lines as {[item.key]: issue}, matched on trimmed keys (the script trims what it echoes); unmatched items omitted. */
export function followupMap(out, items) {
  const echoed = new Map();
  for (const l of String(out ?? "").split("\n")) { const [k, n] = l.split("\t"); if (k && /^\d+$/.test(String(n ?? "").trim())) echoed.set(k.trim(), Number(n)); }
  return Object.fromEntries(items.filter((i) => echoed.has(String(i.key).trim())).map((i) => [i.key, echoed.get(String(i.key).trim())]));
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

/** engine.conformance_kinds: a failure code's own gate mode; "enforce" blocks, "shadow" is recorded only. */
export const KIND_MODES = Object.freeze(["enforce", "shadow"]);

/**
 * The valid `{code: mode}` entries of a config map, or of forge.yaml's flat form `"code=mode, code=mode"` (the
 * forge.yaml reader has no third nesting level); anything else is dropped. {} when absent.
 */
export function normalizeKindModes(raw) {
  const out = {};
  if (typeof raw === "string") raw = Object.fromEntries(raw.split(",").map((x) => x.trim()).filter(Boolean).map((p) => p.split("=").map((x) => x.trim())));
  if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) if (String(k).trim() && KIND_MODES.includes(String(v).trim())) out[String(k).trim()] = String(v).trim();
  return out;
}

/**
 * Split gate failures into those that block and those only recorded. A kind with its own mode follows it; every other
 * kind follows the lane: an enforce lane blocks it, a shadow lane blocks only the codes in `allow` (the previous reviewer's set).
 * @param {{code?: string}[]} failures
 * @param {{shadow?: boolean, kinds?: Record<string,string>|null, allow?: string[]}} [o]
 */
export function blockingFailures(failures, { shadow = false, kinds = null, allow = [] } = {}) {
  const block = [], record = [];
  for (const f of failures ?? []) {
    const own = kinds?.[f?.code];
    (own ? own === "enforce" : !shadow || allow.includes(f?.code)) ? block.push(f) : record.push(f);
  }
  return { block, record };
}

/**
 * Deliver requirements with no executed evidence test: one row per requirement id. Evidence is a test deliverable linked to the
 * requirement (`deliverables[].requirements`) that a validate command names and that ran green (the engine's rerun, else the
 * builder's result, else CI). Requirements verified out of band are judged by their instrumentation and skipped.
 * @returns {{id: string, reason: string}[]}
 */
export function unverifiedRequirements(contract, { runs = [], reruns = null, ciCovered = [] } = {}) {
  const green = (v) => {
    const rerun = reruns?.[v.id];
    if (rerun) return rerun.rc === 0;
    return (Array.isArray(runs) ? runs : []).some((x) => x?.id === v.id && x.exit === 0) || ciCovered.includes(v.id);
  };
  const out = [];
  for (const r of contract?.requirements ?? []) {
    if (r.disposition !== "deliver" || isOutOfBand(r)) continue;
    const tests = (contract.deliverables ?? []).filter((d) => (d.requirements ?? []).includes(r.id) && isTestPath(d.path)).map((d) => String(d.path));
    if (!tests.length) { out.push({ id: r.id, reason: "no test deliverable linked to the requirement" }); continue; }
    const ran = (contract.validate ?? []).some((v) => tests.some((t) => String(v.command).includes(t) || String(v.command).includes(t.split("/").pop())) && green(v));
    if (!ran) out.push({ id: r.id, reason: `no executed passing validate runs its test (${tests.join(", ")})` });
  }
  return out;
}
