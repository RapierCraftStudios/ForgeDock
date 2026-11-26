// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5820: the PR's required CI checks, run in the lane before the PR opens. No LLM, no new planner: the check set is
 * `scripts/ci-local` `buildPlan` (workflow parsing, path filters, matrix, secrets/deploy deferral, change scoping) narrowed
 * here to what the PR must pass:
 * - Required: jobs whose name or id is a required status check on the lane base (`io.requiredChecks`: classic protection
 *   plus rulesets), plus the jobs a required aggregator job `needs`. No required check maps to a job (none configured,
 *   unreadable, or only non-workflow checks): the conservative fallback, the lint, typecheck and unit-test jobs.
 * - Heavy jobs (e2e, visual/storybook, lighthouse, app builds, docker images) stay CI-only unless forge.yaml
 *   `lean.ci_precheck_include` names them; `lean.ci_precheck_exclude` always wins; at most `lean.ci_precheck_max_jobs`.
 * - Each selected job is one pre-PR check command: `ci-local.sh run --plan <one-job plan>`, so the job runs with
 *   ci-local's env, services, result cache and machine-wide slots, inside the engine's precheck round (heavy slot, budget,
 *   per-command timeout). Exit 1 is a failure (the precheck fix round); exit 2, 124 or 127 is unrunnable (recorded with
 *   its reason, never a fix round, never blocking the PR).
 * Pure apart from `writeFile`; lean.mjs owns every effect and the events (`CI_PRECHECK_PLAN`, `CI_PRECHECK_RESULT`).
 */
import { fileURLToPath } from "node:url";

/** The ci-local entry the derived commands call (install root, never the lane worktree). */
export const CI_LOCAL_SH = fileURLToPath(new URL("../../scripts/ci-local.sh", import.meta.url));
/** Per-job plan files, under the lane's untracked tool state. */
export const CI_PRECHECK_DIR = ".forge-lean/ci-precheck";
export const DEFAULT_MAX_JOBS = 8;
/** ci-local adapters that read CI definitions (task runners, portability and extra_commands are not CI jobs). */
const CI_SOURCES = new Set(["github-actions", "gitlab-ci", "circleci", "azure-pipelines", "bitbucket", "buildkite"]);
/** Job kinds that stay CI-only by default (#5820), first match wins; `text` is id + name, `cmds` the job's step commands. */
const HEAVY = [
  ["e2e", (t, c) => /\be2e\b|end[-_ ]to[-_ ]end|playwright|cypress|webdriver|selenium/i.test(`${t}\n${c}`)],
  ["visual", (t, c) => /storybook|chromatic|\bvisual\b|percy|backstop|\bloki\b/i.test(`${t}\n${c}`)],
  ["lighthouse", (t, c) => /lighthouse|\blhci\b/i.test(`${t}\n${c}`)],
  ["docker", (t, c) => /\bdocker\b|\bimages?\b|\bcontainer\b/i.test(t) || /docker\s+(?:buildx\s+)?build\b|docker\s+compose\s+build\b|\bpodman\s+build\b/.test(c)],
  ["build", (t, c) => /(?:^|[^a-z])(?:build|bundle|dist)(?:[^a-z]|$)/i.test(t) || /\b(?:next|vite|nuxt|astro|remix|webpack)\s+build\b|\bturbo\s+(?:run\s+)?build\b/.test(c)],
];
const CHEAP = [
  ["typecheck", /type-?check|\btsc\b|\bmypy\b|pyright|\btypes\b/i],
  ["lint", /lint|eslint|ruff|prettier|\bformat|\bfmt\b|\bblack\b|gofmt|rustfmt|clippy|shellcheck|golangci|\bvet\b|stylelint|biome/i],
  ["wiring", /wiring|registered|\bmanifest\b|\bcoverage[-_ ]map\b/i],
  ["test", /test|vitest|jest|pytest|\bspec\b|mocha|\bbats\b/i],
];
export const HEAVY_KINDS = HEAVY.map(([k]) => k);

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
/** A forge.yaml list value: a block list (array), a flow list `[a, b]` or a comma-separated string. */
const list = (v) => (Array.isArray(v) ? v : str(v).replace(/^\[|\]$/g, "").split(",")).map((x) => str(x).replace(/^(["'])(.*)\1$/, "$2")).filter(Boolean);
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const globRe = (g) => new RegExp(`^${String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");

/**
 * forge.yaml `lean:` (one-level, flat keys) -> {mode, include, exclude, maxJobs}. `ci_precheck: off` turns it off;
 * include/exclude entries are a heavy kind (`e2e`, `visual`, `lighthouse`, `docker`, `build`), a job id (`gha:ci:lint`) or
 * a job name, `*` globs allowed.
 */
export function parseCiPrecheckConfig(sec) {
  const s = sec && typeof sec === "object" ? sec : {};
  const mode = /^(off|false|no|0)$/i.test(str(s.ci_precheck)) ? "off" : "on";
  const raw = str(s.ci_precheck_max_jobs), n = Number(raw);
  return { mode, include: list(s.ci_precheck_include), exclude: list(s.ci_precheck_exclude), maxJobs: raw !== "" && Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_JOBS };
}

/** The job's runnable step commands (install, noop, builtin and scope-skipped steps dropped). */
const liveSteps = (j) => (Array.isArray(j?.steps) ? j.steps : []).filter((s) => s && !s.noop && !s.skip && !s.builtin && s.kind !== "install" && str(s.command));

/** {kind, heavy}: the first heavy class, else lint/typecheck/test, else `other`. */
export function classifyJob(job) {
  const key = str(job?.id).split(":").pop();
  const text = `${key}\n${str(job?.name)}`, cmds = liveSteps(job).map((s) => s.command).join("\n");
  for (const [kind, hit] of HEAVY) if (hit(text, cmds)) return { kind, heavy: true };
  for (const [kind, re] of CHEAP) if (re.test(text)) return { kind, heavy: false };
  for (const [kind, re] of CHEAP) if (re.test(cmds)) return { kind, heavy: false };
  return { kind: "other", heavy: false };
}

const matchesEntry = (job, kind, entry) => {
  const e = str(entry);
  if (!e) return false;
  if (e.toLowerCase() === kind) return true;
  const re = globRe(e), key = str(job.id).split(":").pop();
  return re.test(str(job.id)) || re.test(str(job.name)) || re.test(key);
};

/** The required check contexts this job reports as: its name or job key, alone, with a matrix suffix `name (a, b)`, or behind a caller `caller / name`. */
export function requiredFor(job, required) {
  const names = [...new Set([str(job?.name), str(job?.id).split(":").pop()].filter(Boolean))];
  return (required ?? []).filter((ctx) => {
    const c = str(ctx);
    return names.some((n) => c === n || c.startsWith(`${n} (`) || c.endsWith(` / ${n}`) || c.includes(` / ${n} (`));
  });
}

/**
 * Narrow a ci-local plan to the precheck set.
 * @param {{plan:object, required:string[]|null, cfg?:object}} p
 * @returns {{source:"required"|"fallback", run:object[], skipped:{job,name,reason}[], unrunnable:{job,name,reason}[], note:string}}
 *   run: [{job, name, workflow, kind, why, steps: string[], plan: object}] (plan: a one-job ci-local plan)
 */
export function selectCiPrecheck({ plan, required = null, releaseRequired = null, cfg = parseCiPrecheckConfig(null) }) {
  const jobs = (Array.isArray(plan?.jobs) ? plan.jobs : []).filter((j) => j && CI_SOURCES.has(j.source) && !/:variants$/.test(str(j.id)));
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const req = (Array.isArray(required) ? required : []).map(str).filter(Boolean);
  // required jobs, then (transitively) the jobs an aggregator required job needs
  const why = new Map();
  for (const j of jobs) { const hit = requiredFor(j, req); if (hit.length) why.set(j.id, `required check ${hit.map((h) => `"${h}"`).join(", ")}`); }
  // #6049: required checks of the release branch, run in the lane too (a release-only formatter or wiring job)
  const relReq = (Array.isArray(releaseRequired) ? releaseRequired : []).map(str).filter(Boolean);
  const relHit = new Set();
  for (const j of jobs) {
    const hit = requiredFor(j, relReq);
    for (const h of hit) relHit.add(h);
    if (hit.length && !why.has(j.id)) why.set(j.id, `required check ${hit.map((h) => `"${h}"`).join(", ")} on release branch`);
  }
  const queue = [...why.keys()];
  while (queue.length) {
    const id = queue.shift();
    for (const n of byId.get(id)?.needs ?? []) if (byId.has(n) && !why.has(n)) { why.set(n, `needed by required job ${id}`); queue.push(n); }
  }
  const source = why.size ? "required" : "fallback";
  const note = why.size ? "" : req.length ? "no required check maps to a CI job; conservative lint/typecheck/test set" : "no required checks readable on the base; conservative lint/typecheck/test set";
  const run = [], skipped = [], unrunnable = [];
  for (const j of jobs) {
    const { kind, heavy } = classifyJob(j);
    const base = { job: j.id, name: str(j.name) || j.id };
    if (j.not_applicable) { skipped.push({ ...base, reason: str(j.not_applicable) }); continue; }
    const included = cfg.include.some((e) => matchesEntry(j, kind, e));
    if (cfg.exclude.some((e) => matchesEntry(j, kind, e))) { skipped.push({ ...base, reason: "excluded by lean.ci_precheck_exclude" }); continue; }
    let reason = why.get(j.id) ?? null;
    if (!reason && source === "fallback" && ["lint", "typecheck", "test"].includes(kind)) reason = `${kind} job (fallback set)`;
    if (!reason && included) reason = "named by lean.ci_precheck_include";
    if (heavy && !included && (reason || source === "fallback")) { skipped.push({ ...base, reason: `heavy (${kind}): CI-only unless lean.ci_precheck_include names it` }); continue; }
    if (!reason) { skipped.push({ ...base, reason: source === "required" ? "not a required check" : `${kind} job is not in the fallback set` }); continue; }
    if (j.deferred_reason) { unrunnable.push({ ...base, reason: str(j.deferred_reason) }); continue; }
    const steps = liveSteps(j).map((s) => (s.cwd && s.cwd !== "." ? `cd ${s.cwd} && ${s.command}` : s.command));
    if (!steps.length) { skipped.push({ ...base, reason: "no step runs for this change (scoped out)" }); continue; }
    run.push({ ...base, workflow: str(j.workflow) || null, kind, why: reason, steps, plan: { ...plan, jobs: [j] } });
  }
  const cap = Number.isInteger(cfg.maxJobs) ? cfg.maxJobs : DEFAULT_MAX_JOBS;
  for (const r of run.splice(cap)) skipped.push({ job: r.job, name: r.name, reason: `over lean.ci_precheck_max_jobs (${cap}): left to CI` });
  // #6049: release-required contexts with no job the lane runs (no job maps, or the job is skipped / unrunnable here)
  const covered = new Set(run.flatMap((r) => requiredFor(jobs.find((j) => j.id === r.job), relReq)));
  const parity = relReq.filter((c) => !covered.has(c)).map((context) => {
    const j = jobs.find((x) => requiredFor(x, [context]).length);
    if (!j) return { context, reason: "no CI job maps to this required release check" };
    const s = [...skipped, ...unrunnable].find((x) => x.job === j.id);
    return { context, job: j.id, reason: s?.reason ?? "job not run in the lane" };
  });
  return { source, run, skipped, unrunnable, note, parity };
}

const slug = (id) => str(id).replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120) || "job";

/** The pre-PR check command of one selected job; ci-local's own budget ends a little before the engine's timeout. */
export function ciPrecheckCommand(sel, { perCommandMs = 300000, script = CI_LOCAL_SH } = {}) {
  const minutes = Math.max(1, Math.floor((Number(perCommandMs) > 0 ? Number(perCommandMs) : 300000) / 60000) - 1);
  return `FORGE_CI_LOCAL_MAX_PARALLEL=1 bash ${q(script)} run --repo . --plan ${q(`${CI_PRECHECK_DIR}/${slug(sel.job)}.json`)} --budget-minutes ${minutes}`;
}

/**
 * One round's plan: build the ci-local plan, select, write the one-job plans, and return the commands.
 * Never throws: a planner failure (no yq, unreadable repo) is one unrunnable entry with its reason.
 * @param {{buildPlan:Function, required:string[]|null, cfg:object, wt:string, base:string, lane:string, files:string[], perCommandMs?:number, writeFile:Function, skipJobs?:Set<string>}} p
 *   skipJobs: job ids an earlier round found unrunnable (not rerun)
 * @returns {Promise<{source, note, commands:{job,name,workflow,kind,why,steps,command}[], skipped, unrunnable}>}
 */
export async function deriveCiPrecheck({ buildPlan, required = null, releaseRequired = null, releaseBranch = "", cfg, wt, base, lane, files = [], perCommandMs, writeFile, skipJobs = new Set() }) {
  let plan;
  try { plan = await buildPlan({ repo: wt, base, baseBranch: lane, ...(releaseBranch ? { releaseBranch } : {}), files }); } catch (e) {
    return { source: "none", note: "", commands: [], skipped: [], unrunnable: [{ job: "*", name: "ci-local plan", reason: `CI check plan unavailable: ${str(e?.message ?? e).split("\n")[0].slice(0, 200)}` }], parity: [] };
  }
  const sel = selectCiPrecheck({ plan, required, releaseRequired, cfg });
  const commands = [], unrunnable = [...sel.unrunnable], skipped = [...sel.skipped];
  for (const r of sel.run) {
    if (skipJobs.has(r.job)) { skipped.push({ job: r.job, name: r.name, reason: "unrunnable in an earlier round: left to CI" }); continue; }
    try { await writeFile(`${CI_PRECHECK_DIR}/${slug(r.job)}.json`, `${JSON.stringify(r.plan)}\n`); } catch (e) { unrunnable.push({ job: r.job, name: r.name, reason: `plan file not written: ${str(e?.message ?? e).slice(0, 120)}` }); continue; }
    commands.push({ job: r.job, name: r.name, workflow: r.workflow, kind: r.kind, why: r.why, steps: r.steps, command: ciPrecheckCommand(r, { perCommandMs }) });
  }
  return { source: sel.source, note: sel.note, commands, skipped, unrunnable, parity: sel.parity };
}

/** The first line of `output` starting with `prefix`, without it; "" when none. */
const lineAfter = (output, prefix) => (String(output ?? "").split("\n").find((l) => l.startsWith(prefix)) ?? "").slice(prefix.length).trim();

/**
 * One derived command's result -> {status: pass|fail|unrunnable|deferred, reason}. Exit 1 is a real failure; exit 2
 * (ci-local DEGRADED: budget, job timeout, missing yq), 124 (killed by the engine's timeout) and 127 (no bash/node) are
 * unrunnable; exit 0 with a CI_LOCAL_DEFERRED line is a job ci-local could not prove here (left to CI).
 */
export function ciPrecheckOutcome(r) {
  const rc = Number(r?.rc), out = String(r?.output ?? "");
  if (rc === 1) return { status: "fail", reason: lineAfter(out, "CI_LOCAL_FAIL:") || "exit 1" };
  if (rc === 0) { const d = lineAfter(out, "CI_LOCAL_DEFERRED:"); return d ? { status: "deferred", reason: d.split(" | ").slice(2).join(" | ") || d } : { status: "pass", reason: "" }; }
  if (rc === 124) return { status: "unrunnable", reason: "timed out (host load or a long suite); left to CI" };
  if (rc === 127) return { status: "unrunnable", reason: `could not start: ${out.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 160) ?? "command not found"}` };
  const deg = lineAfter(out, "CI_LOCAL_RESULT: DEGRADED");
  return { status: "unrunnable", reason: (deg.replace(/^reason=/, "") || lineAfter(out, "CI_LOCAL_DEGRADED:") || `exit ${Number.isFinite(rc) ? rc : "?"}`).slice(0, 200) };
}
