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
import { noComments } from "./context.mjs";

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
    if (!inIssue(r?.quote, issueText)) problems.push(`${id}: quote is not verbatim from the issue (at least ${MIN_QUOTE_CHARS} characters)`);
    if (TRACKED.includes(r?.disposition) && blank(r?.why)) problems.push(`${id}: ${r.disposition} needs a why`);
    if (r?.disposition === "not-applicable" && blank(r?.evidence)) problems.push(`${id}: not-applicable needs file:line evidence`);
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
  }
  if (repro) {
    const t = c.repro_test;
    if (t === "none") { if (blank(c.repro_test_reason)) problems.push(`repro_test "none" needs a one-line repro_test_reason`); }
    else if (!t || typeof t !== "object" || Array.isArray(t) || blank(t.path) || blank(t.command)) problems.push(`this is a bug: repro_test must be {"path","id","command"} (a test that fails on the base and passes after the fix) or "none" with a repro_test_reason`);
    else for (const p of tmpdirInputs(t.command)) problems.push(tmpInputProblem("repro_test", p));
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
      if (tagsOutOfBand(r)) r.verify = "out_of_band"; // #4404: same freeze-time tag as the planned requirements
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

const PY_MISSING_RE = /ModuleNotFoundError: No module named '([^']+)'|ImportError: No module named '?([\w.]+)'?/;
const NODE_MISSING_RE = /Cannot find (?:module|package) '([^']+)'/;
const CMD_NOT_FOUND_RE = /([^\s:'"`]+): command not found/, SH_NOT_FOUND_RE = /([^\s:'"`]+): not found\b/;
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
 */
export function precheck({ contract, result, changedFiles, ignore = [], ciVerified = false, hotspots = null, repro = null, validateRuns = null, repoHas = () => false, frozen = null }) {
  const failures = [], superseded = [];
  const outside = (k) => changedFiles.filter((f) => !ignore.some((p) => f.startsWith(p)) && !authorizationOf(k, f));
  const creep = outside(contract);
  const amendedOnly = frozenAmendedFiles(frozen, contract, outside, creep);
  if (creep.length) failures.push({ code: C.CONFORMANCE_SCOPE_CREEP, kind: "scope_creep", detail: `changed outside the contract's deliverables: ${creep.join(", ")}` });
  const runs = Array.isArray(result?.validation) ? result.validation : [];
  for (const v of contract.validate ?? []) {
    const r = runs.find((x) => x?.id === v.id);
    // #4167: a head the engine verified on CI covers validate ids the builder left to CI (no result, or ci:true without an exit)
    const leftToCi = !r || (r.ci === true && r.exit === undefined);
    if (ciVerified && leftToCi) continue;
    if (leftToCi) failures.push({ code: C.CONFORMANCE_UNIMPLEMENTED, kind: "validate_missing", detail: `validate ${v.id} (\`${v.command}\`) has no recorded result` });
    else if (r.exit !== 0) {
      const rerun = validateRuns?.[v.id];
      if (rerun?.rc === 0) continue;
      const miss = rerun ? missingTool(rerun, { repoHas, command: v.command }) : null;
      if (miss && ciVerified) continue;
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
  return { ok: failures.length === 0, failures, superseded };
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
    if (r.disposition === "deliver" && isOutOfBand(r)) {
      // #4404: the measured result lives in the named job; only the instrumentation is judged here
      if (row.instrumented !== true) f.push({ code: C.CONFORMANCE_UNIMPLEMENTED, detail: `${r.id} verified out of band${r.evidence ? ` by ${r.evidence}` : ""}: instrumentation missing${row.note ? `: ${row.note}` : ""}${row.evidence ? ` (${row.evidence})` : ""}` });
    } else if (r.disposition === "deliver" && row.status !== "implemented") {
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
  return `conformance: ${sh.length} shadow lane${sh.length === 1 ? "" : "s"}, would block ${would} (${pct(would)}), false-block ${falseB} (${pct(falseB)}: would-block on an incomplete/inconsistent/unparseable review); risk-path enforced: ${risk}`;
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
