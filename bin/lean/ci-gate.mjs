// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5760: CI budget gate. A lane that adds a workflow file, a job, or a CI step running one test file must fold it into the
 * forge.yaml `ci.budget.shared_regression_job` or carry a `# FORGE:CI_BUDGET trigger=<scope> minutes=<N>/month why=<text>`
 * comment in the workflow YAML; a new workflow or job needs concurrency, timeout-minutes, path scoping and (issue/comment
 * events) a job-level `if:`; `max_workflows`/`max_ci_jobs` cap the counts unless the same diff removes as many. Deterministic,
 * 0 LLM calls, no YAML dependency (an indentation scan like bin/forge-utils.mjs). The one-level forge.yaml parser flattens
 * `ci.budget.*` into `ci`, so `ci.budget.monthly_minutes` is the same key as #5278's `ci.monthly_minutes`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { parseForgeYaml } from "../forge-utils.mjs";

const C = OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED;
export const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const COMMENT_EVENTS = ["issues", "issue_comment", "pull_request_review_comment", "discussion_comment"];
const PATH_EVENTS = ["push", "pull_request", "pull_request_target"];
const RUNNER_RE = /\b(?:node\s+(?:[^\s]+\s+)*--test|vitest|jest|pytest|go\s+test|playwright\s+test|mocha|bash|sh)\b/;
const TEST_FILE_RE = /^(?:[^\s'"]*\/)?(?:[^\s/'"]+\.(?:test|spec)\.[a-z0-9]+|[^\s/'"]+_test\.[a-z0-9]+|test_[^\s/'"]+\.py)$/i;
const ANNOT_RE = /#\s*FORGE:CI_BUDGET\b(.*)$/;

const posInt = (v) => { const n = Number(String(v ?? "").trim()); return String(v ?? "").trim() !== "" && Number.isInteger(n) && n >= 0 ? n : null; };
const str = (v) => (typeof v === "string" && v.trim() ? v.trim().replace(/^(["'])(.*)\1$/, "$2") : null);
const indentOf = (l) => l.match(/^ */)[0].length;
const blank = (l) => /^\s*(#.*)?$/.test(l);
const keyOf = (l) => l.match(/^\s*["']?([A-Za-z_][\w-]*)["']?\s*:(?:\s+(.*))?$/);

/** forge.yaml `ci` section (flat) -> {maxWorkflows, maxCiJobs, monthlyMinutes, sharedJob}; junk is null. */
export function parseCiBudget(sec) {
  const s = sec && typeof sec === "object" ? sec : {};
  return { maxWorkflows: posInt(s.max_workflows), maxCiJobs: posInt(s.max_ci_jobs), monthlyMinutes: posInt(s.monthly_minutes), sharedJob: str(s.shared_regression_job) };
}

/** `# FORGE:CI_BUDGET trigger=<scope> minutes=<N>[/month] why=<text>` -> {trigger, minutes, why, missing:[...]}, or null when no marker. */
export function parseAnnotation(line) {
  const m = String(line ?? "").match(ANNOT_RE);
  if (!m) return null;
  const body = m[1];
  const why = body.match(/\bwhy=(.*)$/)?.[1]?.trim() || null;
  const head = body.replace(/\bwhy=.*$/, "");
  const trigger = head.match(/\btrigger=(\S+)/)?.[1] ?? null;
  const mm = head.match(/\bminutes=(\d+(?:\.\d+)?)(?:\/month)?(?=\s|$)/);
  const minutes = mm ? Number(mm[1]) : null;
  const missing = [...(trigger ? [] : ["trigger"]), ...(minutes == null ? ["minutes"] : []), ...(why ? [] : ["why"])];
  return { trigger, minutes, why, missing };
}

/** Children (key lines) of the block whose header is at line `at`, at the first deeper indent, until a line at or above `ind`. */
function children(lines, at, ind, end = lines.length) {
  const out = [];
  let child = -1;
  for (let i = at + 1; i < end; i++) {
    const l = lines[i];
    if (blank(l)) continue;
    const n = indentOf(l);
    if (n <= ind) break;
    if (child < 0) child = n;
    if (n !== child) continue;
    const k = keyOf(l);
    if (k) out.push({ key: k[1], value: (k[2] ?? "").replace(/\s+#.*$/, "").trim(), line: i });
    else { const it = l.match(/^\s*-\s+["']?([\w-]+)["']?\s*$/); if (it) out.push({ key: it[1], value: "", line: i }); }
  }
  return out;
}
const blockEnd = (lines, at, ind) => { let i = at + 1; for (; i < lines.length; i++) if (!blank(lines[i]) && indentOf(lines[i]) <= ind) break; return i; };

/** Indentation scan of one workflow file: triggers, concurrency, jobs (with their line ranges) and FORGE:CI_BUDGET annotations. */
export function scanWorkflow(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const top = children(lines, -1, -1);
  const triggers = {};
  const on = top.find((t) => t.key === "on" || t.key === "true");
  if (on) {
    const flow = on.value.replace(/^\[|\]$/g, "");
    if (on.value) for (const t of flow.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean)) triggers[t] = { paths: false };
    else for (const t of children(lines, on.line, 0)) {
      const e = blockEnd(lines, t.line, indentOf(lines[t.line]));
      triggers[t.key] = { paths: lines.slice(t.line + 1, e).some((l) => /^\s*(paths|paths-ignore)\s*:/.test(l)) };
    }
  }
  const jobs = [];
  const jb = top.find((t) => t.key === "jobs");
  if (jb) {
    const end = blockEnd(lines, jb.line, 0);
    const ids = children(lines, jb.line, 0, end).filter((c) => keyOf(lines[c.line]));
    ids.forEach((c, i) => {
      const stop = i + 1 < ids.length ? ids[i + 1].line : end;
      let start = c.line;
      while (start > 0 && /^\s*#/.test(lines[start - 1])) start--;
      const kids = children(lines, c.line, indentOf(lines[c.line]), stop).map((k) => k.key);
      jobs.push({ id: c.key, line: c.line, start, end: stop - 1, timeout: kids.includes("timeout-minutes"), concurrency: kids.includes("concurrency"), if: kids.includes("if") });
    });
  }
  const annotations = [];
  lines.forEach((l, i) => { const a = parseAnnotation(l); if (a) annotations.push({ line: i, ...a }); });
  return { lines, triggers, concurrency: top.some((t) => t.key === "concurrency"), jobs, annotations };
}

/** Lines of `head` not matched by a line of `base` (multiset on trimmed text), as indexes into head. */
function addedLineIdx(base, head) {
  const left = new Map();
  for (const l of String(base ?? "").split(/\r?\n/)) left.set(l.trim(), (left.get(l.trim()) ?? 0) + 1);
  const out = [];
  String(head ?? "").split(/\r?\n/).forEach((l, i) => { const k = l.trim(); if (left.get(k) > 0) left.set(k, left.get(k) - 1); else out.push(i); });
  return out;
}

/** The single test file a run line invokes, or null (a test runner with exactly one test-file argument). */
export function singleTestFile(line) {
  const cmd = String(line ?? "").replace(/^\s*-?\s*(?:run\s*:\s*[|>]?)?/, "").trim();
  if (!cmd || cmd.startsWith("#") || !RUNNER_RE.test(cmd)) return null;
  const files = cmd.split(/\s+/).map((t) => t.replace(/^["']|["'];?$/g, "")).filter((t) => TEST_FILE_RE.test(t));
  return files.length === 1 ? files[0] : null;
}

/** Single-test-file steps among `addedLines` (strings): [{line, file}]. */
export function singleTestFileSteps(addedLines) {
  return (addedLines ?? []).map((l, i) => ({ line: i, file: singleTestFile(l) })).filter((x) => x.file);
}

const fail = (kind, detail) => ({ code: C, kind, detail });
const FIX = (shared) => `${shared ? `fold it into the shared job \`${shared}\` (forge.yaml ci.budget.shared_regression_job) or ` : ""}add \`# FORGE:CI_BUDGET trigger=<scope> minutes=<N>/month why=<why a shared job cannot hold it>\` in the workflow YAML`;

/** Annotation verdict over the scan's annotations inside [from, to]: "ok" | {invalid: missing[]} | null (none). */
function annotated(scan, from, to) {
  const inScope = scan.annotations.filter((a) => a.line >= from && a.line <= to);
  if (inScope.some((a) => !a.missing.length)) return "ok";
  return inScope.length ? { invalid: inScope[0].missing } : null;
}
function annotationFailure(where, verdict, shared) {
  if (verdict === "ok") return [];
  if (verdict?.invalid) return [fail("ci_budget_annotation_invalid", `${where}: the FORGE:CI_BUDGET annotation is missing ${verdict.invalid.join(", ")} (needs trigger=, minutes= and why=)`)];
  return [fail("ci_budget_unannotated", `${where} adds CI with no cost statement: ${FIX(shared)}`)];
}

function hygiene(file, scan, job, { wholeFile }) {
  const gaps = [];
  if (!scan.concurrency && !job.concurrency) gaps.push("concurrency");
  if (!job.timeout) gaps.push("timeout-minutes");
  const pathTriggers = PATH_EVENTS.filter((e) => scan.triggers[e] && !scan.triggers[e].paths);
  if (pathTriggers.length && (wholeFile || !job.if)) gaps.push(`path scoping (paths/paths-ignore on ${pathTriggers.join(", ")})`);
  if (COMMENT_EVENTS.some((e) => scan.triggers[e]) && !job.if) gaps.push("a job-level if: filter for issue/comment events");
  return gaps.length ? [fail("ci_hygiene", `${file} job \`${job.id}\` is new but has no ${gaps.join(", no ")}`)] : [];
}

const countJobs = (scans) => Object.values(scans).reduce((n, s) => n + s.jobs.length, 0);

/**
 * The gate over base and head workflow maps ({path: text}, only `.github/workflows/*.yml|yaml` are read).
 * @returns {{code, kind, detail}[]} kinds: ci_budget_unannotated, ci_budget_annotation_invalid, ci_budget_exceeded, ci_hygiene
 */
export function ciGateFindings({ cfg = parseCiBudget(null), base = {}, head = {} } = {}) {
  const wf = (m) => Object.fromEntries(Object.entries(m ?? {}).filter(([p]) => WORKFLOW_RE.test(p)).map(([p, t]) => [p, scanWorkflow(t)]));
  const b = wf(base), h = wf(head), out = [];
  const shared = cfg?.sharedJob ?? null;
  const sharedDir = shared && shared.includes("/") ? shared.replace(/\/+$/, "") + "/" : null;
  for (const [file, scan] of Object.entries(h)) {
    if (!b[file]) {
      out.push(...annotationFailure(`new workflow ${file}`, annotated(scan, 0, scan.lines.length), shared));
      for (const j of scan.jobs) out.push(...hygiene(file, scan, j, { wholeFile: true }));
      continue;
    }
    const baseIds = new Set(b[file].jobs.map((j) => j.id));
    const added = new Set(addedLineIdx(base[file], head[file]));
    for (const j of scan.jobs) {
      if (baseIds.has(j.id)) continue;
      out.push(...annotationFailure(`${file} new job \`${j.id}\``, annotated(scan, j.start, j.end), shared));
      out.push(...hygiene(file, scan, j, { wholeFile: false }));
    }
    for (const i of added) {
      const test = singleTestFile(scan.lines[i]);
      if (!test) continue;
      const j = scan.jobs.find((x) => i >= x.start && i <= x.end);
      if (!j || !baseIds.has(j.id)) continue; // outside a job, or inside a new job (judged above)
      if (shared && (j.id === shared || (sharedDir && test.replace(/^\.\//, "").startsWith(sharedDir)))) continue;
      out.push(...annotationFailure(`${file} job \`${j.id}\` step running only ${test}`, annotated(scan, j.start, j.end), shared));
    }
  }
  const [wb, wh, jbn, jhn] = [Object.keys(b).length, Object.keys(h).length, countJobs(b), countJobs(h)];
  if (cfg?.maxWorkflows != null && wh > cfg.maxWorkflows && wh > wb) out.push(fail("ci_budget_exceeded", `${wh} workflow files exceed ci.budget.max_workflows ${cfg.maxWorkflows} (+${wh - wb} in this diff): remove or fold as many workflows as you add`));
  if (cfg?.maxCiJobs != null && jhn > cfg.maxCiJobs && jhn > jbn) out.push(fail("ci_budget_exceeded", `${jhn} CI jobs exceed ci.budget.max_ci_jobs ${cfg.maxCiJobs} (+${jhn - jbn} in this diff): fold the new job(s) into an existing job or remove as many`));
  return out;
}

/** Net CI change between two workflow maps: {workflows, jobs, minutes, line}. */
export function netCiChange({ base = {}, head = {}, cfg = null } = {}) {
  const wf = (m) => Object.entries(m ?? {}).filter(([p]) => WORKFLOW_RE.test(p)).map(([, t]) => scanWorkflow(t));
  const [b, h] = [wf(base), wf(head)];
  const mins = (s) => s.reduce((n, x) => n + x.annotations.reduce((k, a) => k + (a.minutes ?? 0), 0), 0);
  const jobs = (s) => s.reduce((n, x) => n + x.jobs.length, 0);
  const r = { workflows: h.length - b.length, jobs: jobs(h) - jobs(b), minutes: mins(h) - mins(b) };
  const sg = (n) => (n >= 0 ? `+${n}` : String(n));
  return { ...r, line: `CI_NET: workflows ${sg(r.workflows)}, jobs ${sg(r.jobs)}, est. minutes/month ${sg(r.minutes)}${cfg?.monthlyMinutes ? ` of ${cfg.monthlyMinutes} budget` : ""}` };
}

/** Workflow map {path: text} of a git ref through `git(args) -> stdout`. */
async function workflowsAt(git, ref) {
  const names = String(await git(["ls-tree", "-r", "--name-only", ref, "--", ".github/workflows"])).split("\n").map((x) => x.trim()).filter((p) => WORKFLOW_RE.test(p));
  const out = {};
  for (const p of names) out[p] = String(await git(["show", `${ref}:${p}`]));
  return out;
}

/** Lane wiring: [] after one `git diff` when the diff touches no workflow file; else the gate over merge-base vs HEAD. */
export async function ciBudgetFailures({ cfg = null, base, git }) {
  const changed = String(await git(["diff", "--name-only", `${base}...HEAD`, "--", ".github/workflows"])).split("\n").map((x) => x.trim()).filter((p) => WORKFLOW_RE.test(p));
  if (!changed.length) return [];
  const mb = String(await git(["merge-base", base, "HEAD"])).trim() || base;
  return ciGateFindings({ cfg: cfg ?? parseCiBudget(null), base: await workflowsAt(git, mb), head: await workflowsAt(git, "HEAD") });
}

/** `node bin/lean/ci-gate.mjs net --base REF --head REF [--cwd DIR]`: prints the CI_NET line; exit 0, `CI_NET: unknown (<why>)` on failure. */
export async function ciGateCli(argv, { print = (s) => process.stdout.write(s + "\n"), cwd: cwdIn = process.cwd() } = {}) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  if (argv[0] !== "net" || !arg("--base") || !arg("--head")) { print("usage: ci-gate.mjs net --base REF --head REF [--cwd DIR]"); return 2; }
  const cwd = arg("--cwd") ?? cwdIn;
  try {
    const git = async (a) => execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
    let cfg = null;
    try { cfg = parseCiBudget(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.ci); } catch { /* no forge.yaml */ }
    print(netCiChange({ base: await workflowsAt(git, arg("--base")), head: await workflowsAt(git, arg("--head")), cfg }).line);
  } catch (e) {
    print(`CI_NET: unknown (${String(e?.stderr || e?.message || e).split("\n")[0].trim()})`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await ciGateCli(process.argv.slice(2));
