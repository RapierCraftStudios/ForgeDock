// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5760: CI budget reporting (the lane gate that parked on a missing `# FORGE:CI_BUDGET` annotation was cut in #6083; only the
 * `CI_NET` report of the net workflow/job/minutes change remains). Deterministic, 0 LLM calls, no YAML dependency (an indentation scan like bin/forge-utils.mjs). The one-level forge.yaml parser flattens
 * `ci.budget.*` into `ci`, so `ci.budget.monthly_minutes` is the same key as #5278's `ci.monthly_minutes`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseForgeYaml } from "../forge-utils.mjs";

export const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
// A runner at command position: segment start, after env assignments and a launcher, never inside a path or extension (#5787).
const RUNNER_RE = /^(?:\w+=\S*\s+)*(?:(?:npx|bunx|pnpm(?:\s+exec)?|yarn|uv\s+run|poetry\s+run|python3?\s+-m)\s+)?(?:[^\s;&|]*\/)?(?:node\s+(?:[^\s]+\s+)*--test|vitest|jest|pytest|go\s+test|playwright\s+test|mocha|bash|sh)(?=\s|$)/;
const YAML_KEY_RE = /^["']?[A-Za-z_][\w-]*["']?\s*:(?:\s|$)/;
const TEST_FILE_RE = /^(?:[^\s'"]*\/)?(?:[^\s/'"]+\.(?:test|spec)\.[a-z0-9]+|[^\s/'"]+_test\.[a-z0-9]+|test_[^\s/'"]+\.py)$/i;
// `# FORGE:CI_PATHS_EXEMPT why=<text>`: opt-out of path scoping for a push that must run on every merge (#5792).
const PATHS_EXEMPT_RE = /#\s*FORGE:CI_PATHS_EXEMPT\b.*\bwhy=\S/;
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
      const body = lines.slice(t.line + 1, e);
      const has = (re) => body.some((l) => re.test(l));
      triggers[t.key] = { paths: has(/^\s*(paths|paths-ignore)\s*:/), tagOnly: has(/^\s*tags(-ignore)?\s*:/) && !has(/^\s*branches(-ignore)?\s*:/) };
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
  const pathsExempt = lines.some((l) => PATHS_EXEMPT_RE.test(l));
  return { lines, triggers, pathsExempt, concurrency: top.some((t) => t.key === "concurrency"), jobs, annotations };
}

/** The single test file a run line invokes, or null (a test runner with exactly one test-file argument). */
export function singleTestFile(line) {
  const cmd = String(line ?? "").replace(/^\s*-?\s*(?:run\s*:\s*[|>]?)?/, "").trim();
  if (!cmd || cmd.startsWith("#") || YAML_KEY_RE.test(cmd)) return null; // name:, if:, with: keys are not commands
  if (!cmd.split(/&&|\|\||[;|]|\$\(/).some((seg) => RUNNER_RE.test(seg.trim()))) return null;
  const files = cmd.split(/\s+/).map((t) => t.replace(/^["']|["'];?$/g, "")).filter((t) => TEST_FILE_RE.test(t));
  return files.length === 1 ? files[0] : null;
}

/** Single-test-file steps among `addedLines` (strings): [{line, file}]. */
export function singleTestFileSteps(addedLines) {
  return (addedLines ?? []).map((l, i) => ({ line: i, file: singleTestFile(l) })).filter((x) => x.file);
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
