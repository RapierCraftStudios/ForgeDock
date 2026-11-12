// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Conformance gate for the core work-on: the builder's frozen contract, typed amendments, deterministic prechecks,
 * the structured conformance review and the close plan. Pure functions; lean.mjs owns every effect.
 *
 * The reviewer supplies per-row judgements; the engine computes the verdict. A review without rows (a generic
 * "PASS") is incomplete, and incomplete never merges.
 */
import { spawnSync } from "node:child_process";
import { OUTCOME_CODES, ENV_VALIDATE_TIMEOUT } from "../engine/outcome-codes.mjs";
import { noComments } from "./context.mjs";
import { seqNumber } from "./sequence.mjs";
import { activationFailures } from "./activation.mjs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";

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
import { CHECK_ID_RE, e2eCheckFor } from "./postdeploy-check.mjs";
import { normaliseDecision, deadAnchors, anchorMatches } from "./decisions.mjs";
import { globToRegex } from "../../scripts/ci-local/lib.mjs";
import { contractBriefProblems } from "./pagegate.mjs"; // #5428
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
  if (q.length >= MIN_QUOTE_CHARS) return norm(issueText).includes(q) || elidedIn(q, norm(issueText)) || compact(issueText).includes(compact(q));
  if (q.length < 3) return false;
  return String(issueText ?? "").split("\n").some((l) => norm(l.replace(ITEM_PREFIX_RE, "")) === q);
}
/** #5244: alphanumerics only, so `SLI_X` retyped as "SLI X" or a dropped punctuation mark still compares equal. */
const compact = (s) => norm(s).replace(/[^a-z0-9]/g, "");
/** #5244: a quote shortened with "..." (norm folds the ellipsis char): every segment is in the issue, in order, and one is a full-length quote. */
function elidedIn(q, issue) {
  if (!q.includes("...")) return false;
  const segs = q.split("...").map((x) => x.trim()).filter(Boolean);
  if (!segs.some((x) => x.length >= MIN_QUOTE_CHARS)) return false;
  let at = 0;
  for (const seg of segs) { const i = issue.indexOf(seg, at); if (i < 0) return false; at = i + seg.length; }
  return true;
}
const SNAP_MIN = 0.9;
const tokens = (s) => norm(String(s ?? "").replace(/_/g, " ")).match(/[a-z0-9]+/g) ?? [];
/**
 * #5244: the issue's exact line or sentence a near-verbatim quote stands for, or null. At least SNAP_MIN of the quote's tokens must be
 * in exactly one line or sentence (the shortest of the best scorers; a rival that is not nested in it makes the match ambiguous).
 */
export function snapQuote(quote, issueText) {
  const qt = [...new Set(tokens(quote))];
  if (qt.length < 4) return null;
  const seen = new Set(), cands = [];
  for (const line of String(noComments(String(issueText ?? ""))).split("\n")) {
    const l = line.replace(ITEM_PREFIX_RE, "").trim();
    for (const raw of [l, ...l.split(/(?<=[.!?])\s+/)]) {
      const n = norm(raw);
      if (n.length < MIN_QUOTE_CHARS || seen.has(n)) continue;
      seen.add(n);
      const ct = new Set(tokens(raw));
      cands.push({ raw, n, score: qt.filter((w) => ct.has(w)).length / qt.length });
    }
  }
  const ok = cands.filter((c) => c.score >= SNAP_MIN);
  if (!ok.length) return null;
  const top = Math.max(...ok.map((c) => c.score));
  const best = ok.filter((c) => c.score === top).sort((a, b) => a.n.length - b.n.length)[0];
  const rival = ok.some((c) => c !== best && !c.n.includes(best.n) && !best.n.includes(c.n));
  return rival ? null : best.raw;
}
/** #5244: replaces each failing requirement quote with the issue line it snaps to (original kept as `requoted`). */
export function snapQuotes(contract, issueText) {
  const reqs = contract?.requirements;
  if (!Array.isArray(reqs) || issueText == null) return { contract, snapped: [] };
  const snapped = [];
  const requirements = reqs.map((r) => {
    if (!r || typeof r.quote !== "string" || inIssue(r.quote, issueText)) return r;
    const to = snapQuote(r.quote, issueText);
    if (!to || !inIssue(to, issueText)) return r;
    snapped.push({ id: r.id, from: r.quote, to });
    return { ...r, quote: to, requoted: r.quote };
  });
  return { contract: snapped.length ? { ...contract, requirements } : contract, snapped };
}
/** #5164: the issue's list or checklist item lines (item marker stripped), or every non-empty line when it has none. */
export function criterionLines(issueText) {
  const lines = String(noComments(String(issueText ?? ""))).split("\n");
  const items = lines.filter((l) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(l)).map((l) => l.replace(ITEM_PREFIX_RE, "").trim()).filter((l) => norm(l));
  return items.length ? items : lines.map((l) => l.trim()).filter((l) => norm(l));
}
/** #5164: norm() plus what a reviewer retyping a criterion slips on: `#N` reference digits, trailing punctuation, a plural `s`. */
const loose = (s) => norm(String(s ?? "").replace(/#\d+/g, "#")).replace(/[\s.,;:!?)\]]+$/, "").replace(/\b([a-z]{3,})s\b/g, "$1");
const MATCH_MIN = 0.8;
/**
 * #5164: the issue's exact criterion line a near-verbatim quote stands for, or null. After loose normalisation the quote is a
 * prefix covering at least 80% of exactly one line, or else at least 80% of its words are in exactly one line (no ties).
 */
export function matchCriterion(quote, issueText) {
  const q = loose(quote);
  if (q.length < MIN_QUOTE_CHARS) return null;
  const lines = criterionLines(issueText).map((raw) => ({ raw, l: loose(raw) }));
  const prefix = lines.filter(({ l }) => l.startsWith(q) && q.length >= MATCH_MIN * l.length);
  if (prefix.length === 1) return prefix[0].raw;
  if (prefix.length > 1) return null;
  const qw = [...new Set(q.match(WORD_RE) ?? [])];
  if (qw.length < 3) return null;
  const hits = lines.filter(({ l }) => { const lw = new Set(l.match(WORD_RE) ?? []); return qw.filter((w) => lw.has(w)).length / qw.length >= MATCH_MIN; });
  return hits.length === 1 ? hits[0].raw : null;
}
const MISQUOTE_PREFIX = "issue_coverage quote is not verbatim from the issue";
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
const dirOf = (p) => p.slice(0, p.lastIndexOf("/") + 1);
/**
 * #5440: `file` with its sequence number replaced by the one in deliverable `p`, when both sit in one directory and both
 * names start with a (different) sequence number: an in-lane renumber (0637_x -> 0639_x) is an add from the base, so git
 * rename detection cannot see it. null otherwise.
 */
function renumberedAs(p, file) {
  const was = seqNumber(p.slice(dirOf(p).length)), now = seqNumber(file.slice(dirOf(file).length));
  if (!was || !now || was === now || dirOf(p) !== dirOf(file)) return null;
  return `${dirOf(file)}${was}${file.slice(dirOf(file).length + now.length)}`;
}
/** True when deliverable `d` (a file, a directory with or without a trailing "/", or a glob) covers changed file `f`. */
export function pathCovers(d, f) {
  const p = cleanPath(d), file = cleanPath(f);
  if (!p) return false;
  if (p.endsWith("/")) return file.startsWith(p);
  const hit = (x) => (/[*?]/.test(p) ? globRe(p).test(x) : p === x);
  // a file and a directory cannot share a path, so a slash-less deliverable that prefixes `file/` is a directory
  if (!/[*?]/.test(p) && file.startsWith(`${p}/`)) return true;
  if (hit(file)) return true;
  const as = renumberedAs(p, file);
  return as !== null && hit(as);
}
/** #5365: explicit coupling map: editing `when` (a deliverable) also puts `also` in scope (a test asserts parity between them). */
const COUPLED_PATHS = [{ when: "bin/engine/outcome-codes.mjs", also: ["docs/OUTCOME-CODES.md"] }];
/** The deliverable id that authorizes `f`, "test", "incidental", or null. */
export function authorizationOf(contract, f) {
  const d = (contract.deliverables ?? []).find((x) => pathCovers(x.path, f));
  if (d) return d.id;
  if (isTestPath(f)) return "test";
  if (isIncidentalPath(f)) return "incidental";
  // #5365: a file a parity test reads alongside a changed deliverable is in scope with it
  if (COUPLED_PATHS.some((c) => c.also.some((g) => pathCovers(g, f)) && (contract.deliverables ?? []).some((x) => pathCovers(x.path, c.when) || pathCovers(c.when, x.path)))) return "coupled";
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
 * argument of `cp|mv|ln|install`, an output-like option (`-o`, `--output`, `--basetemp`, `--junitxml`, `--cache-dir`…), the dir argument of
 * `uv venv`, `virtualenv`, `python[3] -m venv`, `git worktree add` (first) or `git clone` (last), or an env assignment (`X=$TMPDIR/y`). Returns the read paths in first-use order (deduped), e.g. ["$TMPDIR/req.txt"].
 */
export function tmpdirInputs(command) {
  const made = [], reads = [];
  const createdAbove = (p) => made.some((m) => p === m || p.startsWith(`${m}/`));
  for (const seg of String(command ?? "").split(/&&|\|\||;|\||\n/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']+|["']+$/g, ""));
    const words = toks.filter((t) => !/^[A-Za-z_]\w*=/.test(t));
    const cmd = (words[0] ?? "").replace(/^.*\//, "");
    // #5230: tools whose positional dir argument they create: the first $TMPDIR token (clone: the last token) is made.
    const makesDir = (cmd === "uv" && words[1] === "venv") || cmd === "virtualenv"
      || (/^python[\d.]*$/.test(cmd) && words.includes("-m") && words[words.indexOf("-m") + 1] === "venv")
      || (cmd === "git" && words[1] === "worktree" && words[2] === "add");
    const cloneDir = cmd === "git" && words[1] === "clone";
    const firstTmp = toks.findIndex((t) => /\$(?:\{TMPDIR|TMPDIR)/.test(t));
    toks.forEach((tok, i) => {
      for (const m of tok.matchAll(TMP_PATH)) {
        const path = m[1].replace(/\/+$/, "");
        const before = tok.slice(0, m.index), prev = toks[i - 1] ?? "";
        const opt = /^(-[\w-]+)=["']?$/.exec(before)?.[1] ?? (before === "" && /^-/.test(prev) ? prev : null);
        const write = /\d*>>?$|&>$/.test(before) || (before === "" && /^(?:\d*>>?|&>)$/.test(prev))
          || /^[A-Za-z_]\w*=["']?$/.test(before) || (opt !== null && WRITE_OPT.test(opt))
          || cmd === "tee" || ["touch", "mkdir", "mktemp"].includes(cmd)
          || (["cp", "mv", "ln", "install"].includes(cmd) && i === toks.length - 1)
          || (makesDir && i === firstTmp) || (cloneDir && i === toks.length - 1);
        if (write) made.push(path);
        else if (!createdAbove(path) && !reads.includes(`$TMPDIR/${path}`)) reads.push(`$TMPDIR/${path}`);
      }
    });
  }
  return reads;
}

const tmpInputProblem = (id, p) => `${id}: reads ${p}, which the command does not create; the run TMPDIR is per run, so the engine's rerun and red-green check will not find it. Create the file inside the command (\`… > ${p} && …\`) or use a path the repo tracks`;

const E2E_TERM = String.raw`(?:e2e|end-to-end|integration|playwright|cypress|live[- ]stack)`;
const E2E_WORD_RE = new RegExp(String.raw`\b${E2E_TERM}\b`, "i");
const MOCKED_TERM = String.raw`(?:mock\w*|stub\w*|fake\w*|unit(?:[- ]?test\w*)?|(?:use[sd]?|using|via|by)\s+units|vitest|jest|component tests?|route tests?)`;
const MOCKED_RE = new RegExp(String.raw`\b${MOCKED_TERM}\b`, "i");
// #5116: a negated mock ("do not mock", "no stubs") or a fake clock is not a substitute for the e2e check.
const NEG_MOCK_RE = /\b(?:do(?:es)? not|don't|never|no|not|without)\s+(?:use\s+|any\s+)?(?:mock\w*|stub\w*|fake\w*)/gi;
// #5130: a negated weakener ("do not skip the e2e suite", "e2e tests are not replaced") keeps the e2e check.
const NEG_LEAD = String.raw`(?:be\s+|been\s+|being\s+|(?:going|planning|intending|about|trying)\s+to\s+|intend\w*\s+to\s+)?`;
const NEG_DROP_RE = new RegExp(String.raw`\b(?:do(?:es)? not|don't|won't|never|not)\s+${NEG_LEAD}(?:skip|drop|replac|swap|downgrad)\w*`, "gi");
// A negated omission ("will not forget to add the e2e test") is a double negative: the e2e check stays.
const NEG_OMIT_RE = new RegExp(String.raw`\b(?:do(?:es)? not|don't|won't|never|not)\s+${NEG_LEAD}(?:forget|fail|omit|neglect)\w*`, "gi");
const FAKE_CLOCK_RE = /\bfake[- ](?:timers?|clocks?)\b/gi;
// A weakener governs the e2e term only within a few words and the same clause (no . or ; between them).
const GAP = String.raw`(?:[\s,]+\w+){0,5}?[\s,]+`;
// #5145/#5157: only the determiner "no" ("no new fixtures needed for e2e") stops at a preposition, since it negates a noun. not/without/never
// negate the verb that governs e2e ("not need to run e2e", "not with e2e") and "no need/reason/point/requirement" negates the action; all keep the wide GAP.
const NEG_GAP = String.raw`(?:[\s,]+(?!(?:for|of|in|on|at|by|with|from|via)\b)\w+){0,5}?[\s,]+`;
const DROP_BEFORE_RE = new RegExp(String.raw`\b(?:no${NEG_GAP}|(?:not|without|never|no\s+(?:need|reason|point|requirement)|drop(?:ped|s|ping)?|skip(?:ped|s|ping)?|replac\w+|downgrad\w+|swap\w*)${GAP})${E2E_TERM}\b`, "i");
const DROP_AFTER_RE = new RegExp(String.raw`\b${E2E_TERM}${GAP}(?:replaced|dropped|skipped|swapped|downgraded|unnecessary|(?:not|no longer)\s+(?:needed|required|necessary|run\w*|used|executed))\b`, "i");
const INSTEAD_OF_RE = new RegExp(String.raw`\b${MOCKED_TERM}[^.;]{0,60}?\b(?:instead of|rather than|in lieu of)\b${GAP}${E2E_TERM}\b`, "i");
const PROBE_RE = /forge-probe|acceptance[- ]probe/i;
const NEG_PROBE_RE = /\b(?:no|not|without|never)\b[^.;]{0,30}(?:forge-probe|acceptance[- ]probe)/i;
/**
 * #5232: a `uv run --no-project --offline` command whose dependencies are a hand-picked `--with` list (no
 * `--with-requirements`) cannot import a project's full dependency set; true for such a command. The environment must come
 * from the repo's lockfile or toolchain (`uv run --with-requirements <export>`, the project runner, forge.yaml validate.recipes).
 */
export function guessedUvEnv(command) {
  const c = String(command ?? "");
  return /\buv\s+run\b/.test(c) && /--no-project\b/.test(c) && /--offline\b/.test(c) && /--with(?:\s|=)/.test(c) && !/--with-requirements\b/.test(c);
}
const guessedUvProblem = (id) => `${id}: the command builds its environment from a hand-picked \`uv run --offline --no-project --with ...\` list, which cannot import the project's full dependency set (env.repro_unrunnable); derive it from the repo's lockfile or toolchain (\`--with-requirements\` of an export, the project runner, or a forge.yaml validate.recipes entry)`;
const PROJECT_DIR_RE = /^(?:\.\/)?(.+?)\/?$/;
const ARG_PATH_LIKE_RE = /\/|\.py(?:::|$)|::/;
const stripDot = (t) => String(t).replace(PROJECT_DIR_RE, "$1");
/**
 * #5234: the project dir a segment moves into (`poetry -C D run ...`, `poetry --directory D`, `uv run --project D`, `uv --directory D`)
 * with its token indexes, or null.
 */
function projectDirOf(tokens) {
  const runner = tokens.findIndex((t) => t === "poetry" || t === "uv");
  if (runner < 0) return null;
  const flags = tokens[runner] === "poetry" ? ["-C", "--directory"] : ["--project", "--directory"];
  for (let i = runner + 1; i < tokens.length; i++) {
    const t = tokens[i], eq = flags.find((f) => t.startsWith(`${f}=`));
    if (eq) return { dir: stripDot(t.slice(eq.length + 1)), at: [i] };
    if (flags.includes(t) && tokens[i + 1]) return { dir: stripDot(tokens[i + 1]), at: [i, i + 1] };
  }
  return null;
}
/**
 * #5234: a frozen command that moves its cwd with `poetry -C D` / `uv run --project D` but names pytest paths relative to the
 * repo root (`D/tests/x.py`), which do not exist from D: pytest exits 4. Returns {dir, paths} (the D-prefixed path args) or null.
 * Pure string check, one runner segment at a time.
 */
export function projectDirPathMiss(command) {
  for (const seg of String(command ?? "").split(/&&|\|\||;|\|/)) {
    const tokens = seg.trim().split(/\s+/), pd = projectDirOf(tokens);
    const py = tokens.findIndex((t) => t === "pytest" || t === "py.test");
    if (!pd || py < 0) continue;
    const paths = tokens.slice(py + 1).filter((t) => !t.startsWith("-") && ARG_PATH_LIKE_RE.test(t) && stripDot(t).startsWith(`${pd.dir}/`));
    if (paths.length) return { dir: pd.dir, paths };
  }
  return null;
}
/**
 * #5234: `poetry -C D run pytest D/x.py` -> `cd D && poetry run pytest x.py` (uv: `cd D && uv run pytest x.py`) when the command is
 * one segment and every path-like pytest arg is D-prefixed; any other command comes back unchanged (validateContract rejects it).
 */
export function rewriteProjectDirCommand(command) {
  const cmd = String(command ?? "");
  if (/&&|\|\||;|\||[\n'"]/.test(cmd) || !projectDirPathMiss(cmd)) return cmd;
  const tokens = cmd.trim().split(/\s+/), pd = projectDirOf(tokens), py = tokens.findIndex((t) => t === "pytest" || t === "py.test");
  const like = (t) => !t.startsWith("-") && ARG_PATH_LIKE_RE.test(t);
  if (tokens.slice(py + 1).some((t) => like(t) && !stripDot(t).startsWith(`${pd.dir}/`))) return cmd;
  const out = tokens.map((t, i) => (i > py && like(t) ? stripDot(t).slice(pd.dir.length + 1) : t)).filter((_, i) => !pd.at.includes(i));
  return `cd ${pd.dir} && ${out.join(" ")}`;
}
const projectDirProblem = (id, m) => `${id}: the command moves its cwd to \`${m.dir}\` (poetry -C / uv --project) but names repo-root-relative paths (${m.paths.map((x) => `\`${x}\``).join(", ")}) that do not exist from there, so pytest exits 4 before any test runs; use \`cd ${m.dir} && poetry run pytest <${m.dir}-relative paths>\` instead`;
/**
 * #5087: a plan decision whose effect is to drop an e2e/integration check for mocked tests ("no Playwright e2e; integration
 * coverage via route and component tests"). The #4726 rule keys on the `[type:e2e]` tag, which a reworded criterion
 * escapes. Exempt when an acceptance probe (#4399) is declared: in the decision itself, or by another row of the contract.
 * Returns the decision ids; pure.
 */
export function weakenedE2eDecisions(c) {
  const decisions = Array.isArray(c?.decisions) ? c.decisions : [];
  const elsewhere = (id) => JSON.stringify({ r: c?.requirements ?? [], d: c?.deliverables ?? [], k: decisions.filter((k) => k?.id !== id) });
  return decisions.filter((k) => {
    const choice = String(k?.choice ?? "");
    if (!E2E_WORD_RE.test(choice)) return false;
    const mocked = choice.replace(NEG_MOCK_RE, " ").replace(FAKE_CLOCK_RE, " ").replace(NEG_DROP_RE, " ").replace(NEG_OMIT_RE, " ");
    if (!MOCKED_RE.test(mocked) || !(DROP_BEFORE_RE.test(mocked) || DROP_AFTER_RE.test(mocked) || INSTEAD_OF_RE.test(mocked))) return false;
    const own = `${choice} ${k?.justification ?? ""}`;
    return !((PROBE_RE.test(own) && !NEG_PROBE_RE.test(own)) || /forge-probe/i.test(elsewhere(k?.id)));
  }).map((k) => k.id).filter(Boolean);
}

const TEST_LEVELS = ["unit", "integration", "e2e", "live"];
const planWords = (t) => new Set(String(t ?? "").toLowerCase().match(/[a-z0-9]{3,}/g)?.map((w) => w.slice(0, 5)) ?? []);
const MOCK_RE = /\b(?:mock|stub|fake)\w*/i, NEG_MOCK_PLAN_RE = /\b(?:no|not|never|without|non|avoid\w*)[ -]+(?:\w+[ -]+)?(?:mock|stub|fake)\w*/gi;
/** #5445: a proof whose words are (almost) all in the deliverable text of its requirement only restates the fix. Pure. */
export function proofEchoesDeliverable(proof, deliverables) {
  const pw = planWords(proof);
  if (!pw.size) return false;
  return deliverables.some((d) => { const dw = planWords(`${d?.change ?? ""} ${d?.path ?? ""}`); let n = 0; for (const w of pw) if (dw.has(w)) n++; return n / pw.size >= 0.7; });
}
/**
 * #5445: problems with the frozen test plan `test_plan: [{requirement, proof, level, level_reason, repro, reason, regression, env, command}]`.
 * Shape is checked whenever present; `required` (a bug lane with repro on) also needs one row per deliver requirement.
 */
export function testPlanProblems(c, { required = false } = {}) {
  const plan = c?.test_plan, problems = [];
  if (plan == null) { if (!required) return problems; }
  else if (!Array.isArray(plan)) return ["test_plan must be an array of rows"];
  const rows = Array.isArray(plan) ? plan : [], dels = Array.isArray(c?.deliverables) ? c.deliverables : [];
  if (required) for (const r of (Array.isArray(c?.requirements) ? c.requirements : []).filter((x) => x?.disposition === "deliver")) if (!rows.some((t) => t?.requirement === r.id)) problems.push(`${r.id}: test_plan needs a row for this bug requirement (proof, level, level_reason, repro or no-repro with reason, command)`);
  for (const t of rows) {
    const id = t?.requirement ?? "test_plan row";
    if (!t || typeof t !== "object" || !t.requirement) { problems.push("test_plan row without a requirement id"); continue; }
    if (blank(t.proof)) problems.push(`${id}: test_plan proof must name the root-cause observable that shows the cause is fixed`);
    else if (proofEchoesDeliverable(t.proof, dels.filter((d) => (d?.requirements ?? []).includes(t.requirement)))) problems.push(`${id}: test_plan proof only restates a deliverable; describe the observable that was wrong (the symptom or root cause), not the presence of the fix`);
    if (!TEST_LEVELS.includes(t.level)) problems.push(`${id}: test_plan level must be one of ${TEST_LEVELS.join("|")}`);
    if (blank(t.level_reason)) problems.push(`${id}: test_plan level needs a level_reason (why the cheapest level that observes the cause)`);
    else if (MOCK_RE.test(String(t.level_reason).replace(NEG_MOCK_PLAN_RE, " "))) problems.push(`${id}: test_plan may not prove the cause fixed by mocking the component the bug lives in; pick a level that exercises it`);
    if (blank(t.repro)) problems.push(`${id}: test_plan repro must be a test id (red on base, green on head) or "no-repro" with a reason`);
    else if (/^no-repro$/i.test(String(t.repro).trim()) && blank(t.reason)) problems.push(`${id}: test_plan no-repro needs a reason the reviewer can reject`);
    if (blank(t.command)) problems.push(`${id}: test_plan needs the exact command validate runs`);
    else {
      for (const p of tmpdirInputs(t.command)) problems.push(tmpInputProblem(id, p));
      if (vitestQuietFlag(t.command)) problems.push(`${id}: test_plan command: vitest 3 rejects -q/--quiet; use --reporter=dot`);
      const syn = shellSyntaxError(t.command);
      if (syn) problems.push(`${id}: test_plan command is not valid shell (bash -n: ${syn})`);
    }
  }
  return problems;
}

/** #5448: a requirement that starts as an imperative build verb is development work, not a prod-only measurement. */
const DEV_WORK_RE = /^\W*(?:\w+\s+){0,2}?(?:find|fix|implement|develop|build|write|patch|add|change)\b/i;
export function validateContract(c, issueText, { repro = false, pages = null, testPlan = false } = {}) {
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
    if (r?.disposition === "post-deploy" && blank(r?.local_infeasible_why)) problems.push(`${id}: post-deploy needs local_infeasible_why: why a fixture or recorded response cannot check this locally (#5448)`);
    if (r?.disposition === "post-deploy" && (inLaneDeferral(r) || (bucketKind(r?.bucket) !== "owner" && bucketKind(r?.bucket) !== "host" && DEV_WORK_RE.test(String(r?.quote ?? ""))))) problems.push(`${id}: development work (finding or fixing the signal) is delivered in-lane, never deferred as prod-only; deliver it and keep only the measurement post-deploy (#5448)`);
    if (r?.disposition === "not-applicable" && blank(r?.evidence)) problems.push(`${id}: not-applicable needs file:line evidence`);
    for (const m of bucketProblems(r)) problems.push(`${id}: ${m}`);
    if (r?.class != null && !FOLLOWUP_CLASSES.includes(r.class)) problems.push(`${id}: class must be one of ${FOLLOWUP_CLASSES.join("|")}`);
    if (r?.verify != null && !VERIFY_MODES.includes(r.verify)) problems.push(`${id}: verify must be one of ${VERIFY_MODES.join("|")}`);
    if (isOutOfBand(r) && r?.disposition !== "deliver") problems.push(`${id}: verify out_of_band applies only to a deliver requirement`);
    else if (isOutOfBand(r) && blank(r?.evidence)) problems.push(`${id}: verify out_of_band needs evidence naming the job or workflow that measures it (or set verify "in_lane" if this change can check it)`);
  }
  if (c.regression != null && !Array.isArray(c.regression)) problems.push("regression must be an array of {id, command, covers}");
  for (const g of Array.isArray(c.regression) ? c.regression : []) {
    if (!g?.id || blank(g?.command)) { problems.push(`regression entry without id or command: ${JSON.stringify(g ?? null).slice(0, 80)}`); continue; }
    for (const p of tmpdirInputs(g.command)) problems.push(tmpInputProblem(g.id, p));
    const syn = shellSyntaxError(g.command);
    if (syn) problems.push(`${g.id}: the command is not valid shell (bash -n: ${syn})`);
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
  for (const id of weakenedE2eDecisions(c)) problems.push(`${id}: a plan decision may not replace an e2e/integration check with mocked tests; run a real e2e check, or declare a \`forge-probe\` acceptance probe (#4399) that runs after promotion and reopens on failure`);
  if (!Array.isArray(c.validate) || !c.validate.length) problems.push("the contract names no validate[] commands");
  else for (const v of c.validate) {
    if (!v?.id || blank(v?.command)) { problems.push("validate entry without id or command"); continue; }
    const ref = movingBaseDiff(v.command);
    if (ref) problems.push(`${v.id}: \`git diff\` against the moving ${ref} tip fails as soon as the base moves on, even when the change is fine; compare against the merge base instead (\`${ref}...HEAD\` or \`$(git merge-base HEAD ${ref})\`)`);
    for (const p of tmpdirInputs(v.command)) problems.push(tmpInputProblem(v.id, p));
    if (guessedUvEnv(v.command)) problems.push(guessedUvProblem(v.id));
    const pdm = projectDirPathMiss(v.command);
    if (pdm) problems.push(projectDirProblem(v.id, pdm));
    if (vitestQuietFlag(v.command)) problems.push(`${v.id}: vitest 3 rejects -q/--quiet (usage error before any test runs); use --reporter=dot`);
    const syn = shellSyntaxError(v.command);
    if (syn) problems.push(`${v.id}: the command is not valid shell (bash -n: ${syn}); keep notes out of the command`);
  }
  if (repro) {
    const t = c.repro_test;
    if (t === "none") { if (blank(c.repro_test_reason)) problems.push(`repro_test "none" needs a one-line repro_test_reason`); }
    else if (!t || typeof t !== "object" || Array.isArray(t) || blank(t.path) || blank(t.command)) problems.push(`this is a bug: repro_test must be {"path","id","command"} (a test that fails on the base and passes after the fix) or "none" with a repro_test_reason`);
    else {
      for (const p of tmpdirInputs(t.command)) problems.push(tmpInputProblem("repro_test", p));
      if (guessedUvEnv(t.command)) problems.push(guessedUvProblem("repro_test"));
      const pdr = projectDirPathMiss(t.command);
      if (pdr) problems.push(projectDirProblem("repro_test", pdr));
      if (vitestQuietFlag(t.command)) problems.push("repro_test: vitest 3 rejects -q/--quiet; use --reporter=dot");
      const syn = shellSyntaxError(t.command);
      if (syn) problems.push(`repro_test: the command is not valid shell (bash -n: ${syn})`);
    }
  }
  problems.push(...testPlanProblems(c, { required: testPlan }));
  if (JSON.stringify(c).length > MAX_CONTRACT_CHARS) problems.push(`the contract is over ${MAX_CONTRACT_CHARS} characters; keep quotes to the requirement sentence and descriptions short`);
  if (pages) problems.push(...contractBriefProblems(c, pages)); // #5428: page deliverables need page_gate briefs
  return { ok: problems.length === 0, problems };
}

/** forge#4519: a shell pattern as in scripts/hotspots.sh `case` (`*` crosses `/`, `?` one character), anchored. */
const shellGlobRe = (g) => new RegExp(`^${String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

const AMEND_KINDS = ["add-deliverable", "add-requirement", ...TRACKED, "amend-requirement", "supersedes", "decision", "substitute-validate", "out-of-band"];
const UNRELATED_CI_KIND = "unrelated-ci-failure";
const GUARD_ID_RE = /^#?\d+$/;
const AMEND_SLIPS = { "amend-requirement": "defer", limitation: "defer", deferred: "defer", deferral: "defer", "scope-deferral": "defer", "verification-substitution": "substitute-validate", "out-of-band-verification": "out-of-band" };
// #5036: annotation-only kinds change no requirement: recorded for the reviewer, never a problem (like UNRELATED_CI_KIND)
const INFO_KINDS = ["scope-note", "scope", "scope-clarification", "interpretation", "environment", "validation-unavailable"];
// #5036: deferral-shaped kinds (scope narrowing/reduction, defer-*, deferred-*) are `defer` once they name a requirement
const DEFER_FAMILY_RE = /^(?:scope-(?:narrowing|reduction)|defer-.+|deferred-.+)$/;
// #4916: near-synonyms builders emit for the per-guard `supersedes` amendment
const SUPERSEDES_SYNONYMS = ["supersede-guard", "supersede", "supersedes-guard"];

/** forge#4574: common builder slips: `type` for `kind`, amend-requirement/limitation as defer, an `R#` in `id` as the requirement. */
function normalizeAmendment(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return a;
  const n = { ...a };
  if (blank(n.kind) && !blank(n.type)) n.kind = n.type;
  // #4594: amend-requirement with a revised `text` is a real amendment; without one it stays the slip for defer
  // #4856: kinds compare case-insensitively with `_` as `-`; only a recognised kind or alias is rewritten, so unknown kinds keep their spelling in the error
  if (typeof n.kind === "string") {
    const k = n.kind.trim().toLowerCase().replace(/_/g, "-");
    if (AMEND_KINDS.includes(k) || Object.hasOwn(AMEND_SLIPS, k) || INFO_KINDS.includes(k)) n.kind = k;
    else if (DEFER_FAMILY_RE.test(k) && (!blank(n.requirement) || /^R\d+$/.test(String(n.id ?? "")))) n.kind = "defer";
  }
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
      : kind === "substitute-validate" ? "needs validate: \"V#\" and command" : kind === "out-of-band" ? "needs requirement: \"R#\" and evidence (the job or workflow that measures it)"
      : kind === "decision" ? "needs decision {choice, anchors: [paths or globs], symbols?, supersedes?: decision id}" : null;
  const why = need ? `amendment kind '${kind}' ${need}` : `unknown kind '${kind ?? ""}'; valid kinds are ${AMEND_KINDS.join(", ")}`;
  return `unknown or incomplete amendment: ${why}: ${tag}`;
}

/** #5089: shape-only check of the builder's amendments (unknown kind, missing path or requirement), run before the gate so one in-lane correction can fix them. Returns the rejection strings; [] when valid. */
export function amendmentKindProblems(amendments) {
  const out = [];
  for (const raw of Array.isArray(amendments) ? amendments : []) {
    const a = normalizeAmendment(raw);
    if (a?.kind === UNRELATED_CI_KIND || INFO_KINDS.includes(a?.kind)) continue;
    const tag = JSON.stringify(raw ?? null).slice(0, 400);
    const known = AMEND_KINDS.includes(a?.kind);
    const missing = a?.kind === "add-deliverable" ? blank(a.path)
      : TRACKED.includes(a?.kind) || a?.kind === "amend-requirement" ? blank(a.requirement) : false;
    if (!known || missing) out.push(amendmentProblem(a, tag));
  }
  return out;
}

/**
 * Apply result.json amendments to the frozen contract. Kinds: add-deliverable {path}, add-requirement {requirement},
 * defer|post-deploy {requirement: id}. Every amendment needs a why (or the engine's defaultWhy); `addedPaths` are lane-added files that count as decision anchors when a deliverable lists them. Returns {contract, applied[], toTrack[], problems[]}.
 * `generatedPaths` (forge#4519, forge.yaml maintenance.generated_paths via scripts/hotspots.sh): an add-deliverable on a
 * matching path is refused; the repo's generator or bot owns that file.
 * `decision` {decision:{choice, anchors, symbols?, supersedes?}} (#4695): every anchor must match a file of `baseFiles` (the
 * base tree; null skips the check); `supersedes` names the decision whose engine-authored preserve row it replaces and
 * drops that row; returns the records in `decisions`.
 */
export function applyAmendments(frozen, amendments, issueText = null, { generatedPaths = [], baseFiles = null, addedPaths = [], defaultWhy = null } = {}) {
  const c = structuredClone(frozen);
  c.deliverables = c.deliverables ?? [];
  for (const v of c.validate ?? []) if (v && typeof v === "object") delete v.substituted; // SEC-21: only a substitute-validate amendment sets it, never the frozen contract
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
  for (let { a, raw } of rows) {
    // an unrelated out-of-diff CI failure is not a contract change: informational, never a problem
    if (a?.kind === UNRELATED_CI_KIND) { applied.push({ kind: a.kind, target: String(a.target ?? "unrelated check"), why: String(a.why ?? "").trim() || "unrelated to the diff" }); continue; }
    if (INFO_KINDS.includes(a?.kind)) { applied.push({ kind: a.kind, target: String(a.target ?? a.requirement ?? a.id ?? "note").slice(0, 60), why: String(a.why ?? a.text ?? a.note ?? "").trim() || "informational" }); continue; }
    const tag = JSON.stringify(raw ?? null).slice(0, 400);
    if (a && blank(a.why) && !blank(defaultWhy)) a = { ...a, why: String(defaultWhy) }; // the engine demanded the change: its reason is the why
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
    } else if (a.kind === "substitute-validate" && !blank(a.validate)) {
      // #4857: a runnable equivalent of an unrunnable frozen validate command; same id, same checks as a planned command
      const v = (c.validate ?? []).find((x) => x.id === a.validate);
      if (!v) { problems.push(`substitute-validate names unknown validate ${a.validate}`); continue; }
      const bad = blank(a.command) ? "no command" : substituteShellProblem(a.command) ? "not valid shell (bash -n)" : noopCommand(a.command) ? "runs no check (true, :, exit 0, echo)" : movingBaseDiff(a.command) ? "diffs against a moving base tip" : tmpdirInputs(a.command).length ? "reads a $TMPDIR file it did not create" : null;
      if (bad) { problems.push(`substitute-validate ${a.validate}: ${bad}`); continue; }
      // SEC-11: a second substitute of the same id keeps the frozen command as `from`, so the engine always reruns the original
      v.substituted = { from: v.substituted?.from ?? v.command, why: String(a.why).trim() }; v.command = String(a.command).trim();
      applied.push({ kind: a.kind, target: a.validate, why: String(a.why).trim() });
      continue;
    } else if (a.kind === "out-of-band" && !blank(a.requirement) && !blank(a.evidence ?? a.job)) {
      // #5036: the existing out_of_band path for a deliver requirement; evidence names the job that measures it
      const r = c.requirements.find((x) => x.id === a.requirement);
      if (!r) { problems.push(`amendment names unknown requirement ${a.requirement}`); continue; }
      if (r.disposition !== "deliver") { problems.push(`out-of-band ${r.id}: applies only to a deliver requirement`); continue; }
      r.verify = "out_of_band"; r.evidence = String(a.evidence ?? a.job).trim(); r.amended = true;
      applied.push({ kind: a.kind, target: r.id, why: String(a.why).trim() });
      continue;
    } else if (a.kind === "add-requirement" && a.requirement?.id && !blank(a.requirement?.quote)) {
      if (c.requirements.some((r) => r.id === a.requirement.id)) {
        // #5365: a taken id is renumbered to the next free R<n>, never a failure; the remap is recorded in `applied`
        const was = a.requirement.id, free = `R${Math.max(0, ...c.requirements.map((r) => Number(/^R(\d+)$/.exec(String(r.id))?.[1] ?? 0))) + 1}`;
        a = { ...a, requirement: { ...a.requirement, id: free } };
        applied.push({ kind: "add-requirement", target: `${was} -> ${free}`, why: `id ${was} already in the contract; renumbered to ${free}` });
      }
      let snapTo = null;
      if (issueText != null && !inIssue(a.requirement.quote, issueText)) {
        snapTo = snapQuote(a.requirement.quote, issueText);
        if (!snapTo) { problems.push(`add-requirement ${a.requirement.id}: quote is not verbatim from the issue`); continue; }
      }
      const r = { disposition: "deliver", ...a.requirement, ...(snapTo ? { quote: snapTo, requoted: a.requirement.quote } : {}), amended: true };
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
      if (TRACKED.includes(r.disposition)) {
        // SEC-31/SPEC-33: a flip that would orphan a check id or a filed tracking issue must name it and say why it is now delivered
        const named = [r.check, r.tracked ? String(r.tracked).replace(/\D/g, "") : null].filter((k) => !blank(k));
        const said = `${a.why} ${a.text}`;
        const missing = named.filter((k) => !new RegExp(`(^|[^\\w-])#?${String(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(said));
        if (missing.length) { problems.push(`amendment flips ${r.disposition} ${r.id} to deliver but does not name its ${missing.join(", ")} (check id or tracking issue) and why it is now delivered in the diff`); continue; }
        // #4984: deliver text on a deferred requirement puts it in scope: it is delivered, not tracked in a follow-up; amended_from keeps the original for the reviewer
        r.amended_from ??= Object.fromEntries(["quote", "disposition", "why", "bucket", "check", "tracked", "class"].filter((k) => r[k] != null).map((k) => [k, r[k]]));
        r.disposition = "deliver"; for (const k of ["bucket", "why", "check", "tracked", "class"]) delete r[k];
      }
      r.amendment = { text: String(a.text).trim(), why: String(a.why).trim() }; r.amended = true;
    } else if (TRACKED.includes(a.kind) && a.requirement) {
      const r = c.requirements.find((x) => x.id === a.requirement);
      if (!r) { problems.push(`amendment names unknown requirement ${a.requirement}`); continue; }
      if (!TRACKED.includes(r.disposition)) {
        if (a.bucket != null) r.bucket = a.bucket; // #4724
        if (a.kind === "post-deploy" && !CHECK_ID_RE.test(String(a.check ?? r.check ?? ""))) { // #5020: no runnable check: a manual or credentialed action is deferred to the orchestrator, never a conformance failure
          r.disposition = "defer"; r.why = a.why; r.amended = true; r.bucket = String(a.bucket ?? "").startsWith("owner:") ? a.bucket : ORCHESTRATOR_BUCKET; toTrack.push(r); continue;
        }
        r.disposition = a.kind; r.why = a.why; r.amended = true; r.bucket ??= "post-deploy"; toTrack.push(r); // #4724: an amendment without a bucket defaults to post-deploy
        if (a.kind === "post-deploy") r.check = a.check ?? r.check; // #4626
      }
    } else if (a.kind === "decision") {
      const d = normaliseDecision({ ...a.decision, why: a.decision?.why ?? a.why });
      if (!d) { problems.push(amendmentProblem(a, tag)); continue; }
      // #5036: any file the lane adds is a valid anchor; one the contract does not list becomes a deliverable
      const listed = new Set(c.deliverables.map((x) => x.path));
      const added = Array.isArray(addedPaths) ? addedPaths : [];
      const dead = Array.isArray(baseFiles) ? deadAnchors(d.anchors, [...baseFiles, ...added]) : [];
      if (dead.length) { problems.push(`decision anchor(s) ${dead.join(", ")} match no file on the base; anchor a path that exists there`); continue; }
      for (const f of added) {
        if (listed.has(f) || (Array.isArray(baseFiles) && baseFiles.includes(f)) || !d.anchors.some((x) => anchorMatches(x, f))) continue;
        c.deliverables.push({ id: `A${c.deliverables.length + 1}`, path: f, change: `new file anchoring decision: ${d.choice.slice(0, 80)}`, amended: true }); listed.add(f);
      }
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
const POETRY_NOT_FOUND_RE = /^\s*Command not found: (\S+)/m;
const CMD_NOT_FOUND_RE = /([^\s:'"`]+): command not found/, SH_NOT_FOUND_RE = /([^\s:'"`]+): not found\b/;
// #5371: exit-1 failures that are the executor's environment (no Docker daemon, a bind-mount source that is absent where the step runs,
// no Playwright browser, no network for npm), never a failing assertion of the change
const ENV_SIGNATURES = [
  [/Cannot connect to the Docker daemon|docker\.sock|error during connect|Is the docker daemon running/i, "Docker daemon"],
  [/invalid mount config for type "bind"|bind source path does not exist|error while creating mount source path|mounts denied/i, "Docker bind-mount source"],
  [/Executable doesn't exist at|npx playwright install|browserType\.launch: Executable/i, "Playwright browser"],
  [/\bENOTFOUND\b|\bEAI_AGAIN\b|npm (?:ERR!|error) network|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)/i, "network access for npm"],
];
const envSignature = (out) => { const hit = ENV_SIGNATURES.find(([re]) => re.test(out)); return hit ? { tool: hit[1], kind: "environment" } : null; };
const SECRET_PAIR_RE = /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*)\S+/gi;
const SECRET_SHAPE_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b|Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g;
/** #5371: the last `lines` lines of a command's output with secret-looking values redacted, as an indented block for a failure detail ("" when empty). */
export function outputTail(output, lines = 40) {
  const t = String(output ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n").map((l) => l.trimEnd());
  while (t.length && !t[t.length - 1]) t.pop();
  const tail = t.slice(-lines).join("\n").replace(SECRET_PAIR_RE, "$1[redacted]").replace(SECRET_SHAPE_RE, "[redacted]").slice(-4000);
  return tail ? `\n  output tail (last ${Math.min(lines, t.length)} lines):\n${tail.split("\n").map((l) => `    ${l}`).join("\n")}` : "";
}
/** #4857: why a command is not valid bash (`bash -n`), or null when it parses (or bash is unavailable). Catches prose left on a command. */
export function shellSyntaxError(command) {
  const r = spawnSync("bash", ["-n", "-c", String(command ?? "")], { encoding: "utf8", timeout: 5000 });
  if (r.error || r.status === 0 || r.status == null) return null;
  return String(r.stderr || "syntax error").trim().split("\n")[0].replace(/^bash: (?:line \d+: )?/, "").slice(0, 160);
}
/** #5020: like shellSyntaxError, but fails closed: when bash cannot run the check the command is not shown to parse. */
export function substituteShellProblem(command) {
  const r = spawnSync("bash", ["-n", "-c", String(command ?? "")], { encoding: "utf8", timeout: 5000 });
  if (r.error || r.status == null) return "bash -n could not run, so the command is unverified";
  return r.status === 0 ? null : shellSyntaxError(command) ?? "syntax error";
}
export const ORCHESTRATOR_BUCKET = "owner:orchestrator";
/**
 * #5020: a post-deploy requirement that names no check id (a manual or production-credential action) becomes a `defer` with an
 * `owner:orchestrator` bucket, the legal disposition the engine files as a follow-up. Pure; returns {contract, converted[]}.
 */
export function deferChecklessPostDeploy(contract) {
  const converted = [];
  const requirements = (Array.isArray(contract?.requirements) ? contract.requirements : []).map((r) => {
    if (r?.disposition !== "post-deploy" || CHECK_ID_RE.test(String(r?.check ?? ""))) return r;
    // #5448: only a row that truly needs an owner or read-only prod data is converted; any other check-less prod-only claim stays post-deploy so freeze rejects it
    if (!EXTERNAL_NEED_RE.test(`${r.bucket ?? ""} ${r.why ?? ""}`) && !READONLY_PROD_RE.test(`${r.bucket ?? ""} ${r.why ?? ""}`)) return r;
    converted.push(r.id);
    return { ...r, disposition: "defer", bucket: String(r.bucket ?? "").startsWith("owner:") ? r.bucket : ORCHESTRATOR_BUCKET, why: r.why ?? "post-deploy action with no registered check: deferred to the orchestrator" };
  });
  return { contract: converted.length ? { ...contract, requirements } : contract, converted };
}
/**
 * #5020: apply forge.yaml `validate.recipes` ([{match, replace}], match a regex source) to each validate command and the
 * repro_test command at freeze, first matching recipe per command. Pure; returns {contract, applied[{id, from, to}]}.
 */
export function applyValidateRecipes(contract, recipes) {
  const list = (Array.isArray(recipes) ? recipes : []).map((r) => { try { return typeof r?.replace === "string" && r?.match ? { re: new RegExp(String(r.match)), replace: r.replace } : null; } catch { return null; } }).filter(Boolean);
  if (!list.length || !contract || typeof contract !== "object") return { contract, applied: [] };
  const applied = [];
  const rewrite = (id, cmd) => {
    if (typeof cmd !== "string") return cmd;
    for (const { re, replace } of list) if (re.test(cmd)) { const to = cmd.replace(re, replace); if (to !== cmd) applied.push({ id, from: cmd, to }); return to; }
    return cmd;
  };
  const out = { ...contract };
  if (Array.isArray(contract.validate)) out.validate = contract.validate.map((v) => (v && typeof v === "object" ? { ...v, command: rewrite(v.id, v.command) } : v));
  const t = contract.repro_test;
  if (t && typeof t === "object" && !Array.isArray(t)) out.repro_test = { ...t, command: rewrite("repro_test", t.command) };
  if (Array.isArray(contract.test_plan)) out.test_plan = contract.test_plan.map((r) => (r && typeof r === "object" ? { ...r, command: rewrite(`test_plan ${r.requirement}`, r.command) } : r)); // #5445
  return { contract: applied.length ? out : contract, applied };
}
/** #5020: the env.* verdict for a repro command that failed on head because a tool is missing (e.g. an uninstalled Poetry env); null when the failure is the test's own. */
export function reproEnvMiss(run, opts) {
  return run && run.rc !== 0 && run.rc !== 124 ? missingTool(run, opts) : null;
}
const NOOP_SEGMENT_RE = /^(?:true|false|:|exit(?:\s+\d+)?|echo(?:\s.*)?|printf(?:\s.*)?|sleep(?:\s+[\d.]+)?|test\s+-?\w+|\[\s+-?\w+\s+\]|fi|done|node\s+-e\s+['"]?[\d;\s]*['"]?|python3?\s+-c\s+['"]?(?:pass|0|None)?['"]?)$/;
const KEYWORD_RE = /^(if|then|else|elif|do|while|until)(?:\s+|$)/;
const CONST_FALSE_RE = /^(?:false|\[\s+0\s+=\s+1\s+\]|\[\s+1\s+=\s+0\s+\]|test\s+0\s+=\s+1|test\s+-n\s+(?:""|'')|\[\s+-n\s+(?:""|'')\s+\])$/;
/**
 * #4979 SPEC-2: a command every segment of which is a no-op (true, :, exit N, echo, printf, sleep, a constant test,
 * shell keywords, `node -e 0`, `python -c pass`) checks nothing. A best-effort denylist: the engine's rerun of the
 * frozen command (`substituteVerdict`) is the real gate.
 */
export function noopCommand(command) {
  // SEC-22: a leading shell keyword is stripped and the rest judged, so `if [ -f x ]; then pytest; fi` is a real check
  const segs = String(command ?? "").split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  const live = [];
  let dead = false; // #4995: inside the body of an if/elif/while whose condition is a constant false
  for (const raw of segs) {
    let s = raw, cond = false, m;
    while ((m = KEYWORD_RE.exec(s))) {
      s = s.slice(m[0].length);
      if (m[1] === "else" || m[1] === "elif") dead = false;
      cond = m[1] === "if" || m[1] === "elif" || m[1] === "while";
    }
    if (s === "fi" || s === "done") dead = false;
    if (cond) { if (CONST_FALSE_RE.test(s)) dead = true; else if (!dead && s) live.push(s); continue; }
    if (!dead && s) live.push(s);
  }
  return segs.length > 0 && live.every((s) => NOOP_SEGMENT_RE.test(s));
}
/**
 * #4979 SPEC-2: a substitute-validate stands only when the frozen command it replaced cannot run (died before any test,
 * a runner usage error, a missing host tool, exit 127) or passes anyway. A frozen command that runs and fails is a real
 * failure the substitute may not hide. `run` is the engine's rerun of the frozen command; null when none was made.
 */
export function substituteVerdict(run, { repoHas = () => false, command = "" } = {}) {
  if (!run) return "unverified";
  if (run.rc === 0 || run.rc === 127 || unrunnableValidate(run, command) || cliUsageError(run) || missingTool(run, { repoHas, command })) return "ok";
  return run.rc === 124 ? "timeout" : "runs";
}
/**
 * #4990 SEC-13: the paths of `removed` (deleted, or the old side of a rename, in the diff) that a frozen command names:
 * a whitespace token equal to the path, or a directory token above it. A builder that removes the target of its frozen
 * validate makes the engine's rerun read "unrunnable", so the substitute is judged on the diff instead.
 */
const TEST_FILE_RE = /\.(?:test|spec)\.[a-z0-9]+$|^test_[^/]+\.[a-z0-9]+$|_test\.[a-z0-9]+$|Tests?\.(?:java|kt|kts|cs|php|scala|swift)$|_spec\.rb$|^tests\.rs$|^conftest\.py$|\.bats$/;
/** #5003: a runnable test FILE (by basename), unlike `isTestPath`, which also matches fixtures under tests/. */
const isTestFile = (p) => TEST_FILE_RE.test(String(p).split("/").pop());
/**
 * #4990 SEC-13: the paths of `removed` (deleted, or the old side of a rename, in the diff) that a frozen command names.
 * #5003: a token is stripped of quotes, a `--flag=` prefix and a pytest `::node` suffix; a glob is expanded against
 * `baseFiles`; an exact path matches itself; a directory or bare-word token matches only a removed test file under it.
 */
export function removedNamedPaths(command, removed = [], baseFiles = []) {
  const toks = String(command ?? "").split(/\s+/).map((t) => t.replace(/^['"`(]+|['"`);]+$/g, "").replace(/^-[^=\/]*=/, "").replace(/::.*$/, "").replace(/^['"`]+|['"`]+$/g, "").replace(/^\.\//, "").replace(/\/+$/, "")).filter((t) => t && t !== ".");
  const files = new Set(baseFiles);
  return removed.filter((p) => toks.some((t) => {
    if (/[*?]/.test(t)) return globRe(t).test(p) && (files.size === 0 || files.has(p));
    return p === t || (p.startsWith(`${t}/`) && isTestFile(p));
  }));
}
/** #4990: paths the lane's diff deletes or renames away from (the old side). #5003: `-z` (unquoted), null on a git error (fail closed). */
export async function removedPathsOf(git, base) {
  let out;
  try { out = String(await git(["diff", "--name-status", "-z", "-M", `${base}...HEAD`])); } catch { return null; }
  const f = out.split("\0"), gone = [];
  for (let i = 0; i < f.length; i++) {
    const st = f[i];
    if (!/^[A-Z]/.test(st)) continue;
    const two = /^[RC]/.test(st);
    if (/^[DR]/.test(st) && f[i + 1]) gone.push(f[i + 1]);
    i += two ? 2 : 1;
  }
  return gone;
}
const UNRUNNABLE_RE = /ERROR: file or directory not found|ERROR: not found:|no tests ran|collected 0 items|no tests found|could not find (?:the )?pyproject|poetry could not find|syntax error near|unexpected EOF while looking/i;
/** #4857: a failed rerun that died before any test ran (no tests selected, no project at the cwd, invalid shell): a defect of the frozen command. */
export function unrunnableValidate({ rc, output } = {}, command = "") {
  // #5234: pytest's own exit 4 (usage error, path not found) and 5 (no tests collected) are never a test failure
  if ((rc === 4 || rc === 5) && /\b(?:py\.?test|pytest)\b/.test(String(command ?? ""))) return true;
  return rc !== 0 && rc !== 124 && UNRUNNABLE_RE.test(String(output ?? ""));
}
const BLOCK_VALIDATE_RE = /\b(?:V\d+|validate|repro)\b/i;
const BLOCK_UNRUNNABLE_RE = /unrunnable|cannot (?:be )?run|could not (?:be )?run|can't run|not runnable|command not found|No module named|no tests (?:ran|were collected)|collected 0 items|syntax error|pyproject|(?:tool|module)s? (?:is|are) missing|fails? before any test/i;
/** #4857: a blocked result's text that says a validate/repro command could not run: an environment defect, never a product decision. */
export function describesUnrunnableCommand(text) {
  const t = String(text ?? "");
  return BLOCK_VALIDATE_RE.test(t) && BLOCK_UNRUNNABLE_RE.test(t);
}
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
const FORGEDOCK_ENTRY_RE = /^\/.*\/forgedock\/bin\/(?:lean\/checks|forgedock)\.mjs$/;
const FORGEDOCK_TOKEN_RE = /(?<![\w./-])\/[^\s'"`;&|()]*\/forgedock\/bin\/(lean\/checks|forgedock)\.mjs/g;
/**
 * #5005: a frozen validate command names forgedock's own entry point by the absolute path of the install that wrote it; on
 * the host that runs it that path may not exist. Rewrites each such token whose file is missing to this install's path.
 */
export function resolveForgedockPaths(command, { exists = () => true, checksCli, forgedockCli } = {}) {
  return String(command ?? "").replace(FORGEDOCK_TOKEN_RE, (tok, which) => {
    const here = which === "forgedock" ? forgedockCli : checksCli;
    return here && !exists(tok) ? here : tok;
  });
}
const KIND_NAME = { command: "command", "python-module": "Python module", "node-module": "Node package", environment: "environment service" };
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
  if (js && FORGEDOCK_ENTRY_RE.test(js[1])) return { tool: "forgedock", kind: "command" }; // #5005: the host's forgedock install is not at the frozen path
  if (js) {
    const spec = js[1], scoped = spec.startsWith("@");
    if (!scoped && spec.includes("/")) return null;
    const tool = scoped ? spec.split("/").slice(0, 2).join("/") : spec;
    return local(tool) || (scoped && !tool.includes("/")) ? null : { tool, kind: "node-module" };
  }
  const po = POETRY_NOT_FOUND_RE.exec(out)?.[1]; // #5020: `poetry run pytest` in an env that was never installed
  if (po) return local(po) ? null : { tool: po, kind: "command" };
  const cmd = CMD_NOT_FOUND_RE.exec(out)?.[1] ?? (rc === 127 ? SH_NOT_FOUND_RE.exec(out)?.[1] ?? String(command).trim().split(/\s+/)[0] : null);
  if (!cmd || cmd.includes("/") || local(cmd)) return envSignature(out); // #5371
  return { tool: cmd, kind: "command" };
}

/** `repoHas` for missingTool: true when any tracked path has a segment equal to `name` or `name.py`. */
export function repoTracks(paths) {
  const segs = new Set();
  for (const p of paths ?? []) for (const x of String(p).split("/")) segs.add(x);
  return (name) => segs.has(name) || segs.has(`${name}.py`);
}

/**
 * #5338: a changed file under the anchors of an active decision row (architecture choice or spike `Interfaces` row,
 * engine-authored preserve row) needs the builder's `result.preserve` row for it with status "intact"; a lane that really
 * changes the interface amends {kind:"decision", decision:{..., supersedes:"<id>"}}, which removes the row. Pure.
 */
export function interfaceDecisionFailures(contract, result, changedFiles) {
  const out = [];
  for (const p of contract?.preserve ?? []) {
    if (p?.source !== "decision" || !Array.isArray(p.anchors)) continue;
    const hit = (changedFiles ?? []).filter((f) => p.anchors.some((a) => anchorMatches(a, f)));
    if (!hit.length) continue;
    const ack = (result?.preserve ?? []).find((x) => x?.id === p.id);
    if (ack?.status !== "intact") out.push({ code: C.CONFORMANCE_PRESERVE_VIOLATED, kind: "decision_unsuperseded", detail: `${p.id} (decision ${p.decision}): ${hit.slice(0, 3).join(", ")} changed under its anchors without a supersedes decision; report preserve ${p.id} intact, or amend {kind:"decision", decision:{choice, anchors, supersedes:"${p.decision}"}, why}` });
  }
  return out;
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
export function precheck({ contract, result, changedFiles, ignore = [], ciVerified = false, hotspots = null, repro = null, validateRuns = null, repoHas = () => false, frozen = null, checkIds = null, baselineFailures = null, guardFailures = null, coupledFailures = null, relaxationFailures = null, routeFailures = null, docsFailures = null, pageFailures = null, docsPaths = null, prodParityFailures = null, seamFailures = null, newOffKeys = null, substitutedRuns = null, removedPaths = [], baseFiles = [], uiBrowser = null }) {
  const failures = [], superseded = [], ciCovered = [];
  // #4626: a post-deploy check id must be on the default branch or added by this PR (`checkIds`: ids of both checks files; null = not resolved)
  if (checkIds) for (const r of contract.requirements ?? []) {
    if (r.disposition === "post-deploy" && !(r.check && checkIds.has(r.check))) failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "check_unknown", detail: `${r.id} post-deploy check ${r.check ? `'${r.check}'` : "id"} is neither on the default branch nor added by this PR (.forge/post-deploy-checks.json)` });
  }
  // #4769: a default-off rollout entry added by the diff needs an activation row
  if (newOffKeys?.length) for (const f of activationFailures(contract, newOffKeys)) failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, ...f });
  // #5285: interactive UI changed on a high-risk surface with no real-browser check configured: a recorded skip that blocks
  if (uiBrowser?.files?.length && uiBrowser.highRisk && !uiBrowser.ran) failures.push({ code: C.CONFORMANCE_E2E_UNVERIFIED, kind: "ui_browser_unverified", detail: `interactive UI changed (${uiBrowser.files.slice(0, 5).join(", ")}) on a high-risk surface but no real-browser check runs (${uiBrowser.reason}); configure verify.e2e_label/e2e_workflow or add a Playwright spec` });
  const outside = (k) => changedFiles.filter((f) => !ignore.some((p) => f.startsWith(p)) && !authorizationOf(k, f) && !(docsPaths?.length && docsPaths.some((g) => globToRegex(g).test(f)))); // #5419: configured docs.paths/registries are authorized
  const creep = outside(contract);
  const amendedOnly = frozenAmendedFiles(frozen, contract, outside, creep);
  if (creep.length) failures.push({ code: C.CONFORMANCE_SCOPE_CREEP, kind: "scope_creep", detail: `changed outside the contract's deliverables: ${creep.join(", ")}` });
  const runs = Array.isArray(result?.validation) ? result.validation : [];
  for (const v of contract.validate ?? []) {
    // #4979 SPEC-2: a substitute counts only when the frozen command it replaced cannot run (or passes); checked first, never CI-covered
    if (v.substituted) {
      const shellBad = substituteShellProblem(v.command); // #5020: re-checked before the substitute is used
      if (shellBad) { failures.push({ code: C.CONTRACT_INVALID_COMMAND, kind: "validate_command_invalid", detail: `validate ${v.id} substitute \`${v.command}\` is not valid shell (bash -n: ${shellBad})` }); continue; }
      if (removedPaths === null) { failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "substitute_unverified", detail: `validate ${v.id} substituted \`${v.command}\` for the frozen \`${v.substituted.from}\`, but the engine could not read the diff's removed paths to show the frozen command's target survives` }); continue; }
      const gone = removedNamedPaths(v.substituted.from, removedPaths, baseFiles);
      if (gone.length) { failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "substitute_removed_path", detail: `validate ${v.id} substituted \`${v.command}\` for the frozen \`${v.substituted.from}\`, but the diff removes ${gone.map((x) => `\`${x}\``).join(", ")} that the frozen command names: a substitute may not replace a check by deleting its target` }); continue; }
      const verdict = substituteVerdict(substitutedRuns?.[v.id], { repoHas, command: v.substituted.from });
      const from = `validate ${v.id} substituted \`${v.command}\` for the frozen \`${v.substituted.from}\``;
      if (verdict === "unverified") { failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "substitute_unverified", detail: `${from}, but the engine has no rerun of the frozen command to show it cannot run` }); continue; }
      if (verdict === "runs") { failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "validate_failed", detail: `${from}, but the frozen command runs and fails (exit ${substitutedRuns[v.id].rc}): a substitute-validate replaces only a command that cannot run, never a failing check${outputTail(substitutedRuns[v.id].output)}` }); continue; }
      if (verdict === "timeout" && !ciVerified) { failures.push({ code: ENV_VALIDATE_TIMEOUT, kind: "validate_timeout", detail: `${from}, and the frozen command timed out (exit 124) on the engine's rerun, so its substitution cannot be judged: infrastructure (host load)` }); continue; }
    }
    const r = runs.find((x) => x?.id === v.id);
    // #4167: a head the engine verified on CI covers validate ids the builder left to CI (no result, or ci:true without an exit)
    const leftToCi = !r || (r.ci === true && r.exit === undefined);
    if (ciVerified && leftToCi) { ciCovered.push(v.id); continue; }
    if (leftToCi) failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "validate_missing", detail: `validate ${v.id} (\`${v.command}\`) has no recorded result` });
    else if (r.exit !== 0) {
      const rerun = validateRuns?.[v.id];
      if (rerun?.rc === 0) continue;
      if (rerun && cliUsageError(rerun)) { failures.push({ code: C.CONTRACT_INVALID_COMMAND, kind: "validate_command_invalid", detail: `validate ${v.id} (\`${v.command}\`) is a CLI usage error of the runner, a defect of the frozen command rather than of the change` }); continue; }
      if (rerun && unrunnableValidate(rerun, v.command)) { failures.push({ code: C.CONTRACT_INVALID_COMMAND, kind: "validate_command_invalid", detail: `validate ${v.id} (\`${v.command}\`) died before any test ran (no tests selected, no project at its cwd or invalid shell), a defect of the frozen command rather than of the change; substitute a runnable equivalent with a substitute-validate amendment` }); continue; }
      // #4906: the rerun timed out (even after the longer retry): host load, not a verdict on the change. A CI-verified head covers it; else an environment error.
      if (rerun?.rc === 124) {
        if (ciVerified) { ciCovered.push(v.id); continue; }
        failures.push({ code: ENV_VALIDATE_TIMEOUT, kind: "validate_timeout", detail: `validate ${v.id} (\`${v.command}\`) timed out (exit 124) on the engine's rerun: infrastructure (host load), not a failed check` });
        continue;
      }
      const miss = rerun ? missingTool(rerun, { repoHas, command: v.command }) : null;
      // #5447: CI may not run this test, so a missing tool on the rerun is never covered by a CI-verified head
      if (miss) failures.push({ code: C.ENV_TOOL_MISSING, kind: "validate_env", tool: miss.tool, detail: `validate ${v.id} (\`${v.command}\`) could not run: the host is missing ${KIND_NAME[miss.kind]} '${miss.tool}' (environment, not the change)${outputTail(rerun.output)}` });
      else if (amendedOnly && isScopeCheck(v.command)) superseded.push({ id: v.id, files: amendedOnly });
      else failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "validate_failed", detail: `validate ${v.id} (\`${v.command}\`) failed (exit ${r.exit})${outputTail(rerun?.output)}` });
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
  for (const f of baselineFailures ?? []) failures.push({ code: C.CONFORMANCE_REGRESSION, ...f }); // #5448
  failures.push(...hotspotGrowth({ contract, result, hotspots, changedFiles }));
  if (repro) failures.push(...reproFailures(contract, repro), ...reproQualityFailures(repro));
  failures.push(...sourceDeliverableFailures(contract, changedFiles, ignore));
  // #4693: a broken guard fails unless the contract carries a supersedes amendment for it
  const retired = new Set((contract.supersedes ?? []).map((s) => s.guard));
  for (const f of guardFailures ?? []) if (!retired.has(f.guard)) failures.push(f);
  for (const f of coupledFailures ?? []) failures.push(f); // #5079
  for (const f of relaxationFailures ?? []) failures.push(f); // #5237
  failures.push(...(routeFailures ?? [])); // #5087: topology.route_reachability, blocking when declared
  failures.push(...(docsFailures ?? [])); // #5419: forge.yaml docs
  failures.push(...(pageFailures ?? [])); // #5428: forge.yaml pages
  failures.push(...(prodParityFailures ?? [])); // #5284: topology.prod_parity
  failures.push(...interfaceDecisionFailures(contract, result, changedFiles)); // #5338
  failures.push(...(seamFailures ?? [])); // #5338: a declared interface's provider and consumer no longer agree
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
  // #5080: the test already passes on the base: the fix is there (a hotfix or another PR), not missing from this change
  if (base === "RAN") return [{ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "repro_base_green",
    detail: `repro test ${name} (\`${t.command ?? ""}\`) must fail on the base and pass on head; got BASE=RAN HEAD=RAN: it passes on the base already (the fix may already be on the base)` }];
  return [{ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "repro_red_green",
    detail: `repro test ${name} (\`${t.command ?? ""}\`) must fail on the base and pass on head; got BASE=${base ?? "UNRUNNABLE"} HEAD=${head}${skipped}` }];
}

/** #5446: a repro_test every targeted mutation of the fix survived. Only under lean.repro_quality: enforce; patch_echo is the reviewer's call. */
export function reproQualityFailures({ quality, enforce } = {}) {
  if (!enforce || quality !== "mutation_survivor") return [];
  return [{ code: MUTATION_SURVIVED, kind: "repro_mutation_survivor",
    detail: "repro_test still passes with the fix's changed lines mutated (flipped condition, early return, dropped call): it does not exercise the fix" }];
}

const DOC_ONLY_RE = /\.(?:md|mdx|txt|rst|adoc)$/i;
const SOURCE_EXT_RE = /\.(?:m?[jt]sx?|cjs|py|go|rs|rb|java|kt|swift|php|cs|c|cc|cpp|h|hpp|sh)$/i;
/**
 * #5080: a diff of test files only, for a contract that names a code deliverable (a non-test source file): the tests pin
 * behaviour but nothing was changed, so it must not be accepted as the fix. Returns the failure rows ([] otherwise).
 */
export function sourceDeliverableFailures(contract, changedFiles = [], ignore = []) {
  const files = changedFiles.filter((f) => !ignore.some((p) => f.startsWith(p)));
  if (!files.length || !files.every(isTestPath)) return [];
  const src = (contract.deliverables ?? []).map((d) => cleanPath(d.path)).filter((p) => p && !/[*?]|\/$/.test(p) && !isTestPath(p) && SOURCE_EXT_RE.test(p));
  if (!src.length) return [];
  return [{ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "source_deliverable_untouched",
    detail: `the diff changes only test files (${files.slice(0, 3).join(", ")}${files.length > 3 ? ", ..." : ""}) but the contract names source deliverable(s) ${src.slice(0, 3).join(", ")}: tests that pin current behaviour are not the fix` }];
}

/**
 * #5080: the repro already passes on the base (repro_base_green), the diff has no non-test source change, and the only other
 * failure is source_deliverable_untouched: the issue is already fixed on the base, so it closes as delivered instead of
 * needs-human. A diff that changes source keeps the conformance.unimplemented path (K3).
 */
export function alreadyFixedOnBase(failures = [], changedFiles = [], ignore = []) {
  const files = changedFiles.filter((f) => !ignore.some((p) => f.startsWith(p)));
  // Release review of #5103 (MAT-1): any non-test, non-doc change (css, json, yaml, sql, tf, ...) is work the lane did, never "already fixed".
  if (files.some((f) => !isTestPath(f) && !DOC_ONLY_RE.test(f))) return false;
  return failures.some((f) => f.kind === "repro_base_green") && failures.every((f) => f.kind === "repro_base_green" || f.kind === "source_deliverable_untouched");
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
/**
 * #5164: true when every problem of an incomplete review is a reviewer slip a targeted re-ask can fix: an evidence path that
 * did not resolve (#4327) or an issue_coverage misquote. #5345: so is any single missing or invalid row (requirement, preserve,
 * scope, issue_coverage, verdict): the reply is repaired in place for those ids, never a new review round. A whole absent
 * `requirements` section is not a slip: it keeps the two-run limit. A real coverage gap is a failure, not an incompleteness.
 */
const ROW_GAP_RE = /needs exactly one row|status invalid|needs deferral_ok|needs instrumented|needs path:line evidence|needs validated_by|has no scope row|needs a row with status|issue_coverage is missing or empty|verdict must be|regressions must be/;
export function reaskable(problems = []) {
  return problems.length > 0 && problems.every((p) => MISSING_PATH_RE.test(String(p)) || String(p).startsWith(MISQUOTE_PREFIX) || ROW_GAP_RE.test(String(p)));
}
const reviewedFiles = (changedFiles, ignore) => changedFiles.filter((x) => !ignore.some((pre) => x.startsWith(pre)));

/**
 * The rows the engine can fill itself, so bookkeeping is never "incomplete": a scope row per changed file from the
 * contract's own authorization ("none" when unauthorized, still scope creep), a preserve row per id as "unverified"
 * (still preserve_violated), and implemented evidence rewritten to `path:line` with the repo path. Returns a new object.
 */
export function fillEngineRows(rv, { contract, changedFiles = [], repoFiles = [], ignore = [], issueText = null }) {
  if (!rv || typeof rv !== "object") return rv;
  const out = { ...rv };
  const scope = Array.isArray(rv.scope) ? [...rv.scope] : [];
  for (const f of reviewedFiles(changedFiles, ignore)) if (!scope.some((s) => s?.file === f)) scope.push({ file: f, authorized_by: authorizationOf(contract, f) ?? "none", note: "row filled by the engine", filled: true });
  out.scope = scope;
  const pres = Array.isArray(rv.preserve) ? [...rv.preserve] : [];
  for (const c of contract.preserve ?? []) if (!pres.some((x) => x?.id === c.id)) pres.push({ id: c.id, status: "unverified", note: "no row from the reviewer", filled: true });
  out.preserve = pres;
  // #5164: a near-verbatim coverage quote is replaced by the issue's exact criterion line; the original stays as `requoted`
  if (Array.isArray(rv.issue_coverage) && issueText != null) {
    out.issue_coverage = rv.issue_coverage.map((c) => {
      if (!c || typeof c !== "object" || typeof c.quote !== "string" || inIssue(c.quote, issueText)) return c;
      const line = matchCriterion(c.quote, issueText);
      return line ? { ...c, quote: line, requoted: c.quote } : c;
    });
  }
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
    if (!inIssue(c?.quote, issueText)) {
      const near = nearestSpan(c?.quote, criterionLines(issueText).join("\n"));
      miss("issue_coverage", `${MISQUOTE_PREFIX}: "${String(c?.quote ?? "").slice(0, 60)}"${near ? `; nearest criterion line: "${near}"` : ""}`);
    }
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


/** #4726, #5339: a requirement quote that carries a `[type:e2e]` or `[type:manual]` criterion. */
const wantsE2e = (r) => /\[type:(?:e2e|manual)\]/i.test(String(r?.quote ?? ""));
/** #5339: failure kinds enforced without an `engine.conformance_kinds` entry (the entry still overrides). */
// #5449: test_missing/test_weak are only generated for bug lanes (testadequacy.mjs), so enforcing the kinds is bug-only.
const DEFAULT_ENFORCED_KINDS = ["e2e_row", "test_missing", "test_weak"];
const E2E_CMD_RE = /\b(?:playwright|cypress|e2e|live[- ]stack|wdio)\b/i;
/**
 * #4726: whether a validate command runs a real end-to-end check: an entry of `verify.e2e_checks`, a file of the e2e spec set
 * (`e2e.isSpec`), or Playwright/Cypress/e2e/live-stack. A unit test file with stubbed I/O is not one.
 */
export function isE2eCommand(command, e2e = null) {
  const cmd = String(command ?? "");
  if ((e2e?.checks ?? []).some((c) => c && cmd.includes(c))) return true;
  if ((e2e?.faked ?? []).some((f) => f && cmd.includes(f))) return false; // #5339: names a test that fakes the real path
  if (typeof e2e?.isSpec === "function" && cmd.split(/\s+/).some((t) => t && e2e.isSpec(t.replace(/^["']+|["']+$/g, "")))) return true;
  return E2E_CMD_RE.test(cmd);
}
/** #5468: a `[type:e2e]`/`[type:manual]` quote whose observable only exists in production (live URL, deploy, prod probe); local stack, browser and sandbox wording is runnable pre-merge. */
export function prodOnlyE2e(quote) {
  const q = String(quote ?? "");
  if (/\b(?:localhost|127\.0\.0\.1|local stack|playwright|browser|sandbox|staging)\b/i.test(q)) return false;
  return /https?:\/\//i.test(q) || /\b(?:after (?:the )?deploy|production|prod probe|live (?:domain|site)|prod)\b/i.test(q);
}
/**
 * #5468: rewrite production-only e2e/manual rows (deliver or defer; only `only` ids when given) to `post-deploy` with a generated
 * check id. Pure; returns {contract, converted:[{id, check, entry}]}. A row whose quote names no probeable URL is left alone.
 */
export function autoPostDeployE2e(contract, only = null) {
  const converted = [];
  const requirements = (Array.isArray(contract?.requirements) ? contract.requirements : []).map((r) => {
    if (!["deliver", "defer"].includes(r?.disposition) || !wantsE2e(r) || (only && !only.includes(r.id)) || isOutOfBand(r) || !prodOnlyE2e(r.quote)) return r;
    const g = e2eCheckFor(r.id, r.quote);
    if (!g) return r;
    converted.push({ id: r.id, check: g.id, entry: g.entry });
    return { ...r, disposition: "post-deploy", bucket: "post-deploy", check: g.id, local_infeasible_why: "the observable exists only in production (live domain or deploy), so no local fixture can check it", why: "production-only e2e/manual criterion: converted by the engine to a post-deploy check (#5468)" };
  });
  return { contract: converted.length ? { ...contract, requirements } : contract, converted };
}
/** #5468: the row ids named by `e2e_row` failures when every failure is one; null otherwise (anything else blocks as before). */
export function loneE2eRows(failures) {
  const fs = failures ?? [];
  if (!fs.length || !fs.every((f) => f?.code === C.CONFORMANCE_E2E_UNVERIFIED && f.kind === "e2e_row")) return null;
  const ids = fs.map((f) => /^(\S+) is a /.exec(String(f.detail ?? ""))?.[1]);
  return ids.every(Boolean) ? [...new Set(ids)] : null;
}
/** #5468 (#5450): a validate that declares `env` names of configured test sandboxes (forge.yaml `sandboxes`) runs against a provisioned live service: the route for an e2e check that can run pre-merge. */
export function sandboxedRun(v, e2e = null) {
  const known = e2e?.sandboxes ?? [];
  const names = Array.isArray(v?.env) ? v.env : typeof v?.env === "string" ? v.env.split(",") : [];
  return names.some((n) => known.includes(String(n).trim()));
}
/** #4726: true when a V-ref named in the row's `validated_by` resolves to a contract validate command that is a real e2e check. */
export function e2eVerified(row, contract, e2e = null) {
  const by = String(row?.validated_by ?? "");
  const refs = (contract?.validate ?? []).filter((v) => v?.id && new RegExp(`(?:^|[^A-Za-z0-9_])${v.id}(?![A-Za-z0-9_])`).test(by));
  return refs.some((v) => isE2eCommand(v.command, e2e) || sandboxedRun(v, e2e)) || (!refs.length && isE2eCommand(by, e2e));
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
  const f = [], converted = [];
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
      const faked = (ctx.e2e?.faked ?? []).length ? `; faked or mocked components in ${ctx.e2e.faked.slice(0, 3).join(", ")}` : "";
      f.push({ code: C.CONFORMANCE_E2E_UNVERIFIED, kind: "e2e_row", detail: `${r.id} is a [type:e2e]/[type:manual] criterion but ${row.validated_by || "its validated_by"} is not a real end-to-end check (the repo's e2e set, Playwright/browser/live stack${faked}); run one, or mark ${r.id} post-deploy so it is transferred to the epic's acceptance${ctx.e2e?.sandboxes?.length ? `; it can run pre-merge: declare env: [${ctx.e2e.sandboxes.slice(0, 3).join(", ")}] on its validate to use the test sandbox (#5450), do not defer it` : ""}` });
    } else if (r.disposition === "defer" && wantsE2e(r)) {
      // #5339: a deferred e2e/manual requirement is not met; only a post-deploy one is transferred to the epic (the lane closes partial)
      f.push({ code: C.CONFORMANCE_E2E_UNVERIFIED, kind: "e2e_row", detail: `${r.id} is a [type:e2e]/[type:manual] criterion deferred without a run; run the real path, or mark ${r.id} post-deploy so it is transferred to the epic's acceptance` });
    }
    // #5207: in-lane engineering work is never deferrable, whatever the reviewer says; one failure per row.
    if (TRACKED.includes(r.disposition) && row.status === "implemented" && (inLaneDeferral(r) || row.deferral_ok === false)) converted.push({ id: r.id, evidence: String(row.evidence ?? "") }); // #5365: delivered in the diff
    else if (inLaneDeferral(r)) f.push({ code: C.CONFORMANCE_UNJUSTIFIED_DEFERRAL, detail: `${r.id} is in-lane engineering work (bucket ${r.bucket ?? "none"}): deliver it (amend-requirement to deliver); only post-deploy, owner and external items may be deferred (#5207)` });
    else if (TRACKED.includes(r.disposition) && row.deferral_ok === false) f.push({ code: C.CONFORMANCE_UNJUSTIFIED_DEFERRAL, detail: `${r.id} ${r.disposition} is not justified${row.note ? `: ${row.note}` : ""}; implement it` });
  }
  for (const s of rv.scope) {
    if (!blank(s.authorized_by)) continue;
    const engine = authorizationOf(ctx.contract, s.file);
    if (engine === "test" || engine === "incidental" || engine === "coupled") continue; // always allowed; a reviewer "none" here is a misreading, not creep
    f.push({ code: C.CONFORMANCE_SCOPE_CREEP, detail: `${s.file}: ${s.note || "not authorized by the contract"}` });
  }
  for (const p of rv.preserve ?? []) if (p.status !== "intact") f.push({ code: C.CONFORMANCE_PRESERVE_VIOLATED, detail: `${p.id} ${p.status}${p.evidence ? ` (${p.evidence})` : ""}${p.note ? `: ${p.note}` : ""}` });
  for (const r of rv.regressions ?? []) f.push({ code: C.CONFORMANCE_REGRESSION, detail: `${r?.at ?? "?"}: ${r?.failure ?? ""}` });
  if (f.length) return { state: "nonconforming", failures: f, inconsistent: rv.verdict === "CONFORMS", review: rv, converted };
  // A NONCONFORMING verdict with every row passing gives the builder nothing to fix: re-ask the reviewer.
  if (rv.verdict !== "CONFORMS") return { state: "review.inconsistent", failures: [{ code: C.REVIEW_INCONSISTENT, detail: "verdict NONCONFORMING with no failing row" }], missing: ["verdict"], review: rv };
  return { state: "conforms", failures: [], review: rv, converted };
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
/** #5365: flips the requirements `converted` names (decide) to deliver, keeping the original row in amended_from; returns a new contract. */
export function convertDelivered(contract, converted) {
  const by = new Map((converted ?? []).map((x) => [x.id, x.evidence]));
  return { ...contract, requirements: (contract.requirements ?? []).map((r) => {
    if (!by.has(r.id) || !TRACKED.includes(r.disposition)) return r;
    const { bucket, why, check, tracked, class: cls, ...rest } = r;
    return { ...rest, disposition: "deliver", amended: true, amended_from: r.amended_from ?? Object.fromEntries(["quote", "disposition", "why", "bucket", "check", "tracked", "class"].filter((k) => r[k] != null).map((k) => [k, r[k]])), amendment: { text: `delivered in the diff (${by.get(r.id) || "reviewer evidence"})`, why: "reviewer found the deferred requirement delivered" } };
  }) };
}
/** #5207: in-lane engineering deferrals are never filed (decide() sends them back to the builder). */
export const pendingTracking = (contract) => (contract.requirements ?? []).filter((r) => TRACKED.includes(r.disposition) && !r.tracked && !inLaneDeferral(r));

/** #4398: an `investigate(` (or `investigate:`) issue, whose stated question must be answered before it closes as completed. */
export const isInvestigation = (title) => /^\s*investigate[(:]/i.test(String(title ?? ""));

/**
 * After a conforming merge: close as completed, linking every tracking issue. #4398: an investigation with a deferred or
 * post-deploy requirement, or a deliver requirement whose review row is not implemented, closes "partial" instead; `open`
 * holds those requirements (the open question, carried forward). A null review (reviewer skipped) judges dispositions only.
 */
export function closePlan(contract, { title = null, review = null, issueText = null, liveBlocks = [] } = {}) {
  const reqs = contract.requirements ?? [];
  const tracked = [...new Set(reqs.filter((r) => TRACKED.includes(r.disposition)).map((r) => r.tracked).filter(Boolean))];
  // #5339: an e2e/manual requirement that was not run in the lane is transferred to the epic, not met: the issue stays partial
  const transferred = reqs.filter((r) => r.disposition === "post-deploy" && wantsE2e(r));
  // #5285: a default-on change whose live acceptance is deferred is not closed as completed; #5382: it still transfers its e2e/manual rows
  if (liveBlocks.length) {
    const live = reqs.filter((r) => liveBlocks.some((b) => b.id === r.id));
    return { reason: "partial", tracked, liveBlocked: true, blocks: liveBlocks, open: live, ...(transferred.length ? { transferred: true, transfer: transferred } : {}) };
  }
  if (transferred.length) return { reason: "partial", tracked, transferred: true, open: transferred };
  const rows = Array.isArray(review?.requirements) ? review.requirements : null;
  if (!isInvestigation(title)) {
    const unticked = unmetChecklist(reqs, rows, issueText);
    return unticked.length ? { reason: "partial", tracked, checklist: true, open: unticked.map((u) => u.req), unticked: unticked.map((u) => u.item) } : { reason: "completed", tracked };
  }
  const open = reqs.filter((r) => TRACKED.includes(r.disposition)
    || (r.disposition === "deliver" && rows && rows.find((x) => x?.id === r.id)?.status !== "implemented"));
  return open.length ? { reason: "partial", tracked, open } : { reason: "completed", tracked };
}

const UNTICKED_RE = /^\s*[-*+]\s+\[ \]\s+(.+?)\s*$/;
/**
 * #5240: the issue's unticked `- [ ]` acceptance items whose requirement is not settled: a deliver row the review did not mark
 * implemented, or a defer/post-deploy row with no tracking issue. An item no contract quote matches is not judged here (the
 * reviewer's issue_coverage gate owns coverage), and a skipped review (null rows) judges dispositions only.
 */
function unmetChecklist(reqs, rows, issueText) {
  if (!issueText) return [];
  const out = [];
  for (const line of String(noComments(String(issueText))).split("\n")) {
    const item = UNTICKED_RE.exec(line)?.[1];
    if (!item) continue;
    const req = reqs.find((r) => r?.quote && matchCriterion(String(r.quote).replace(ITEM_PREFIX_RE, ""), item) !== null);
    if (!req) continue;
    const unmet = TRACKED.includes(req.disposition) ? !req.tracked
      : req.disposition === "deliver" && rows && rows.find((x) => x?.id === req.id)?.status !== "implemented";
    if (unmet) out.push({ item, req });
  }
  return out;
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

/** #4664/#5207: follow-up classes (scripts/file-deferred-followups.sh files aggregates only, never a per-parent issue): post-deploy is one rollup per release lane (#4724), external and ops one aggregate per batch, host one host-task aggregate per batch (#5078); engineering is never filed, it is built in-lane. */
export const FOLLOWUP_CLASSES = ["engineering", "post-deploy", "external", "ops", "host"];
/** #4724: the bucket every deferred row gets at contract time. `date:<YYYY-MM-DD>` and `owner:<action>` carry a value. */
export const BUCKETS = Object.freeze(["post-deploy", "verify-now", "date", "owner", "new-issue", "host"]);
const DATE_BUCKET_RE = /^date:(\d{4})-(\d{2})-(\d{2})$/;
/** The kind of a bucket (`date:2026-12-01` -> `date`), or null when absent or unknown. */
export const bucketKind = (b) => { const k = String(b ?? "").split(":")[0]; return BUCKETS.includes(k) ? k : null; };
/** #4724: problems with a deferred row's bucket (a defer or post-deploy row needs exactly one; owner actions are never post-deploy). */
export function bucketProblems(r) {
  const b = r?.bucket;
  if (!TRACKED.includes(r?.disposition)) return b == null ? [] : ["bucket applies only to a defer or post-deploy requirement"];
  if (b == null || b === "") return [`${r.disposition} needs a bucket (${BUCKETS.join("|")}; \`date:<YYYY-MM-DD>\`, \`owner:<action>\`)`];
  const k = bucketKind(b), out = [];
  if (!k || (k !== "date" && k !== "owner" && b !== k)) out.push(`bucket '${b}' must be post-deploy, verify-now, date:<YYYY-MM-DD>, owner:<action>, new-issue or host`);
  else if (k === "date") {
    const m = DATE_BUCKET_RE.exec(String(b)), d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!m || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) out.push(`bucket '${b}' must be an absolute date:<YYYY-MM-DD>, not a relative wait`);
  } else if (k === "owner" && blank(String(b).slice(6))) out.push("bucket owner needs the action: owner:<action>");
  if (r.disposition === "post-deploy" && (k === "owner" || k === "new-issue" || k === "host")) out.push(`a ${k} item is never post-deploy: use disposition defer`);
  if (k === "owner" && ownerRoute(r) === "host") out.push("read-only production data or capture is not an owner action: use bucket host");
  if (k === "owner" && r.class != null && r.class !== "external" && r.class !== "ops") out.push("an owner bucket belongs in class external or ops, never post-deploy");
  return out;
}
/** #5078: post-promotion / production-verify / rollout text (the rollup) and read-only production data or capture (the host: the prod_monitor signals of execution.mjs plus a read-only prod query). Single source: scripts/file-deferred-followups.sh routes through scripts/followup-route.mjs (#5197). */
const POST_PROMOTION_RE = /(?:after|post)[- ]?(?:promotion|release|deploy)|in production after|production[- ]verif|promot(?:e|ion)|rollout|purge|deploy[- ]time/i;
export const READONLY_PROD_RE = /\bssh\s+[\w.-]*-monitor\b|\bobs-psql\b|\bprod(?:uction)?[ _-]monitor\b|\bread[- ]only\b[^.]{0,40}\bprod(?:uction)?\b|\bprod(?:uction)?\b[^.]{0,30}\b(?:query|queries|capture|telemetry|logs?)\b/i;
/** An item that truly needs the outside world (or a write to production) stays external even when it also reads production. */
export const EXTERNAL_NEED_RE = /credential|secret|api[- ]?key|token|password|passphrase|ssh[- ]?keys?\b|private[- ]key|\blogin\b|\bsudo\b|spend|budget|purchase|payment|account|third[- ]party|vendor|customer|contract sign|legal|\b(?:delete|drop|truncate|wipe|destroy|modify|migrate|write|update|restart|rotate|remove|grant|alter)\b/i;
/**
 * #5078: where an owner deferral goes. `owner:orchestrator`, `owner:promote:*` or post-promotion text -> post-deploy (the
 * rollup); read-only production data or capture (with no credential/spend/account/third-party/customer need) -> host; else external (credentials, spend, an account, a third party or a customer).
 */
export function ownerRoute(r) {
  const action = String(r?.bucket ?? "").replace(/^owner:/, "");
  if (/^(?:orchestrator$|promote(?::|$))/i.test(action)) return "post-deploy";
  const text = `${action} ${r?.why ?? ""}`;
  // Release review #5103 (BUG-3): a credential/spend/write need is external even when it also names a rollout or release.
  if (POST_PROMOTION_RE.test(text) && !EXTERNAL_NEED_RE.test(text)) return "post-deploy";
  return READONLY_PROD_RE.test(text) && !EXTERNAL_NEED_RE.test(text) ? "host" : "external";
}
/** #5250: an acceptance criterion that can only be met by measuring live production or capturing in a real browser. */
const LIVE_EVIDENCE_RE = /\b(?:measur\w*|capture\w*)\b[^.\n]{0,60}\b(?:production|prod|live)\b|\b(?:production|prod|live)\b[^.\n]{0,40}\b(?:measur\w*|capture\w*|clear rate|success rate|latency|traffic)\b|\breal[- ](?:browser|chrome|device)s?\b|\b(?:real|headless)[- ]browser\b[^.\n]{0,40}\bcaptures?\b/i;
/**
 * #5250: intake triage. `{host:true, items}` when the issue's acceptance checklist is non-empty and EVERY item needs live
 * production measurement or a real-browser capture (and none needs a credential, spend or write: EXTERNAL_NEED_RE). One
 * code-shaped item keeps it a code lane. Backlog aggregates (FORGE:DEFERRED_FROM / BACKLOG_BATCH) only quote such text and are never host work.
 */
export function intakeHostWork(body) {
  const text = String(body ?? "");
  if (/FORGE:(?:DEFERRED_FROM|BACKLOG_BATCH)/.test(text)) return { host: false, items: [] };
  const section = noComments(text).split(/^#{1,2}\s+(?=\S)/m).find((s) => /^acceptance\b/i.test(s)) ?? "";
  const items = [...section.matchAll(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/gm)].map((m) => m[1].trim());
  const host = items.length > 0 && items.every((t) => (LIVE_EVIDENCE_RE.test(t) || READONLY_PROD_RE.test(t)) && !EXTERNAL_NEED_RE.test(t));
  return { host, items: host ? items : [] };
}
const PRE_PROMOTION_RE = /(?:before|pre)[- ]?(?:promotion|release|deploy)/i;
/** #5186: an explicit host deferral that is post-promotion text (and needs nothing external) joins the release rollup; work needed before promotion stays host. Single source for scripts/file-deferred-followups.sh host_route (#5197). */
export function hostRoute(r) {
  const text = `${r?.bucket ?? ""} ${r?.why ?? ""}`;
  return POST_PROMOTION_RE.test(text) && !PRE_PROMOTION_RE.test(text) && !EXTERNAL_NEED_RE.test(text) ? "post-deploy" : "host";
}
/** The follow-up class of a requirement: owner -> ownerRoute (ops kept), host -> hostRoute, new-issue -> engineering (#5207: built in-lane, never filed), other buckets post-deploy; else its `class`, else post-deploy for that disposition, else engineering. */
export function followupClass(r) {
  const k = bucketKind(r?.bucket);
  if (k === "owner") return r?.class === "ops" ? "ops" : ownerRoute(r);
  if (k === "host") return hostRoute(r);
  if (k === "new-issue") return "engineering"; // #5207: anything this lane can build in this repo is delivered, not deferred
  if (k) return "post-deploy";
  return FOLLOWUP_CLASSES.includes(r?.class) ? r.class : r?.disposition === "post-deploy" ? "post-deploy" : "engineering";
}
/** #5207: a defer/post-deploy row that is in-lane engineering work (bucket new-issue, or no bucket and no out-of-lane class): not deliverable as a deferral. */
export const inLaneDeferral = (r) => TRACKED.includes(r?.disposition) && followupClass(r) === "engineering";
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
    const head = k === "owner" ? `owner: ${flat(String(r.bucket).slice(6))}. ` : k === "host" ? "host: " : k && k !== "new-issue" ? "post-deploy: " : `${r.disposition}: `;
    return { id: r.id, class: followupClass(r), key: flat(`${r.id}: ${r.quote}`).slice(0, 240).trim(), why: flat(`${head}${tag}${check(r)}${due}${r.why ?? ""}`).slice(0, 400).trim() };
  });
}

/**
 * #5141: the FORGE:FOLLOWUP_PENDING note for follow-ups the lane could not file before or after the merge. Each row keeps the
 * requirement text and the `FORGE:DEFERRED_FROM: #<n>` marker the follow-up script looks up, so a later pass files it once.
 */
export function renderPendingFollowups(rows, pr) {
  const flat = (s) => String(s ?? "").replace(/[\t\r\n]+/g, " ").trim();
  return [`## Follow-up pending`, `Merged by PR #${pr}, but the tracking issue could not be filed, so this issue stays open until it is. Still to file (idempotent by the marker):`, "",
    ...rows.map((r) => `- ${flat(r.id)} (${flat(r.disposition)}): ${flat(r.quote)} | why: ${flat(r.why)} | \`${r.marker}\``)].join("\n");
}

/**
 * #4388: the follow-up script's `key\tissue` lines as {[item.key]: issue}; unmatched items omitted. Both sides get every
 * identity rule of scripts/file-deferred-followups.sh: trimmed (#4388), backticks stripped (#4984) and repeated leading
 * `R<n>: R<m>:` prefixes collapsed to the first (#5141: a quote starting with its own id looped on followup.unavailable).
 * An item still unmatched takes the one echoed row whose identity starts with `<item.id>:`; never when several do.
 */
export function followupMap(out, items) {
  const norm = (k) => {
    let s = String(k).replace(/`/g, "").trim(), m;
    while ((m = /^(R\d+:)\s*R\d+:\s*(.*)$/s.exec(s))) s = `${m[1]} ${m[2]}`;
    return s;
  };
  const echoed = new Map();
  for (const l of String(out ?? "").split("\n")) { const [k, n] = l.split("\t"); if (k && /^\d+$/.test(String(n ?? "").trim())) echoed.set(norm(k), Number(n)); }
  const byId = (id) => { const hits = [...echoed].filter(([k]) => k.startsWith(`${id}:`)); return hits.length === 1 ? hits[0][1] : undefined; };
  const res = {};
  for (const i of items) {
    const n = echoed.get(norm(i.key)) ?? (i.id ? byId(String(i.id)) : undefined);
    if (n !== undefined) res[i.key] = n;
  }
  return res;
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
    const own = kinds?.[f?.code] ?? (DEFAULT_ENFORCED_KINDS.includes(f?.kind) ? "enforce" : undefined);
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
  const out = [];
  for (const r of contract?.requirements ?? []) {
    if (r.disposition !== "deliver" || isOutOfBand(r)) continue;
    const tests = evidenceTests(contract, r);
    if (!tests.length) { out.push({ id: r.id, reason: "no test deliverable linked to the requirement" }); continue; }
    if (!greenEvidence(contract, tests, { runs, reruns, ciCovered }).length) out.push({ id: r.id, reason: `no executed passing validate runs its test (${tests.join(", ")})` });
  }
  return out;
}

const evidenceTests = (contract, r) => (contract.deliverables ?? []).filter((d) => (d.requirements ?? []).includes(r.id) && isTestPath(d.path)).map((d) => String(d.path));
/** The validate commands that name one of `tests` and ran green (the engine's rerun, else the builder's result, else CI). */
function greenEvidence(contract, tests, { runs = [], reruns = null, ciCovered = [] } = {}) {
  const green = (v) => {
    const rerun = reruns?.[v.id];
    if (rerun) return rerun.rc === 0;
    return (Array.isArray(runs) ? runs : []).some((x) => x?.id === v.id && x.exit === 0) || ciCovered.includes(v.id);
  };
  return (contract.validate ?? []).filter((v) => tests.some((t) => String(v.command).includes(t) || String(v.command).includes(t.split("/").pop())) && green(v));
}

/** #4913 engine.conformance_mutation: the failure code of an evidence test that still passes with the change reverted. */
export const MUTATION_SURVIVED = "conformance.mutation_survived";

/**
 * Deliver requirements whose executed evidence test can be mutation-checked: one row per requirement id with the green
 * evidence commands and the non-test files of the diff (the change to revert). Out-of-band requirements and requirements
 * with no green evidence are skipped; with no non-test file changed there is nothing to revert.
 * @returns {{id: string, commands: {id: string, command: string}[]}[]}
 */
export function mutationTargets(contract, evidence = {}) {
  const out = [];
  for (const r of contract?.requirements ?? []) {
    if (r.disposition !== "deliver" || isOutOfBand(r)) continue;
    const tests = evidenceTests(contract, r);
    const commands = tests.length ? greenEvidence(contract, tests, evidence).map((v) => ({ id: v.id, command: String(v.command) })) : [];
    if (commands.length) out.push({ id: r.id, commands });
  }
  return out;
}

/** conformance.mutation_survived rows: a result still green with the change reverted. A skipped or killed result never fails. */
export function mutationFailures(results) {
  return (results ?? []).filter((x) => x?.status === "survived").map((x) => ({
    code: MUTATION_SURVIVED, kind: "mutation_survived",
    detail: `${x.id} evidence test passes with the change reverted (\`${x.command}\`, exit 0): it does not prove the requirement`,
  }));
}

/**
 * Rerun each target's evidence commands with the diff's non-test files reverted to the merge base (git apply -R of the
 * non-test diff), then restore them from HEAD in a finally. The commits stay in HEAD, so no work is lost. A dirty tree,
 * a failed revert, a timeout (124) or a missing runner (127) is skipped, never a failure.
 * @returns {{results: {id: string, command: string, status: "survived"|"killed"|"skipped", note?: string}[], skipped: string, ms: number}}
 */
export async function runMutationCheck({ targets, files, base, git, runCommand, cwd, env, capMs = 120000, tmp = tmpdir(), fs = nodeFs, now = Date.now }) {
  const t0 = now(), results = [];
  const nonTest = (files ?? []).filter((f) => !isTestPath(f));
  const skip = (note) => ({ results, skipped: note, ms: now() - t0 });
  if (!targets?.length) return skip("");
  if (!nonTest.length) return skip("no non-test file changed");
  if (String(await git(["status", "--porcelain"]).catch(() => "x")).trim()) return skip("working tree not clean");
  const patch = `${tmp}/mutation-${process.pid}.patch`;
  let reverted = false, restoreFailed = "";
  try {
    fs.writeFileSync(patch, await git(["diff", "--binary", `${base}...HEAD`, "--", ...nonTest]));
    try { await git(["apply", "-R", "--whitespace=nowarn", patch]); reverted = true; } catch { return skip("could not revert the change"); }
    for (const t of targets) for (const c of t.commands) {
      const left = capMs - (now() - t0);
      if (left <= 0) { results.push({ id: t.id, command: c.command, status: "skipped", note: "over the cap" }); continue; }
      let r;
      try { r = await runCommand({ command: c.command, cwd, timeoutMs: left, env }); } catch (e) { r = { rc: 127, output: String(e?.message ?? e) }; }
      const rc = Number.isInteger(r?.rc) ? r.rc : 1;
      results.push({ id: t.id, command: c.command, status: rc === 124 || rc === 127 ? "skipped" : rc === 0 ? "survived" : "killed" });
    }
  } finally {
    // Release review #4931: the tree was clean, so HEAD is the exact restore point. `checkout HEAD -- <files>` failed as a
    // whole on a file the change deleted (the revert re-creates it untracked) and restored nothing; reset + clean of
    // those paths does not, and a tree still dirty there afterwards throws (fail closed: never push the reverted change).
    if (reverted) {
      await git(["reset", "-q", "--hard", "HEAD"]).catch(() => {});
      await git(["clean", "-fdq", "--", ...nonTest]).catch(() => {});
      const left = await git(["status", "--porcelain", "--", ...nonTest]).catch(() => "unreadable");
      if (String(left).trim()) restoreFailed = String(left).trim();
    }
    try { fs.rmSync(patch, { force: true }); } catch { /* best effort */ }
  }
  if (restoreFailed) throw new Error(`mutation check could not restore the worktree: ${restoreFailed}`);
  return { results, skipped: "", ms: now() - t0 };
}
