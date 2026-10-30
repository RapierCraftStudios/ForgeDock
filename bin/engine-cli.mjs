/**
 * Headless entry point: `forgedock run-issue <issue>` drives one issue through the
 * durable engine; scanStalls finds dead-lease issues for the orchestrator to resume.
 * `forgedock resume-stalled [--dry-run] [--lane <lane>]` enumerates all in-flight
 * issues, calls scanStalls, and re-dispatches each stalled issue via run-issue.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir, hostname, cpus } from "node:os";
import { localLaneCap } from "./lean/admission.mjs";
import { memAvailableMb } from "./lean/heavy.mjs";
import { join, resolve as resolvePath } from "node:path";
import { runIssue, DEFAULT_MAX_ATTEMPTS, sanitizeLeaseHost } from "./engine.mjs";
import { makeProjector } from "./engine/projector.mjs";
import { isTrustedActor, parseDependsOn } from "./engine/phases.mjs";
import { readLog, readLogFile, deriveState, runLogPath, migrateRunLogs } from "./engine/runlog.mjs";
import { assertOpenCodeNativeRuntime } from "./runner.mjs";
import { parseForgeYaml } from "./forge-utils.mjs";
import { makeEmitTelemetry } from "./engine/telemetry-seam.mjs";
import { makeEventEmitter, probeSweepEvents, experimentEvent } from "./engine/events.mjs";
import { readExperiment } from "./experiment.mjs";
import { readBranches, resolveLane, isDefaultLane } from "./lean/lane.mjs";
import { parseVerify } from "./lean/verify.mjs";
import { parseExecution, detectNeeds, placementText } from "./lean/execution.mjs";
import { relayPrefetchCommands } from "./lean/relay.mjs";
import { parseTurnBudgets, formatTurnSummary, TURN_BUDGET_DEFAULTS } from "./lean/budget.mjs";
import { writeAtomic as writeResultAtomic } from "./lean/batch.mjs";
import { parseLightConfig, LIGHT_DEFAULTS } from "./lean/light.mjs";
import { OUTCOME_CODES } from "./engine/outcome-codes.mjs";

/**
 * Workflow labels that mark an issue as "in the pipeline" (not yet terminal).
 * Shared by resume-stalled's candidate enumeration and countEngineActivity()
 * (the re-entry dashboard's in-flight/stalled counter, #1945) so both surfaces
 * agree on what "in-flight" means — a single source of truth rather than two
 * lists that can silently drift apart.
 */
export const ACTIVE_WORKFLOW_LABELS = [
  "workflow:investigating",
  "workflow:ready-to-build",
  "workflow:building",
  "workflow:in-review",
  "workflow:remediating",
];

const pexec = promisify(execFile);

/**
 * Real gh/git accessors.
 *
 * `timeout: 10000` matches the convention already used for the sibling
 * `gh pr list` call in the interactive dashboard (bin/forgedock.mjs's
 * gatherDashboardData()). Every io.gh()/io.git() call site issues a single,
 * normally-fast metadata command (gh issue view, gh api .../comments,
 * gh pr list/view, git rev-list --count) — none are legitimately
 * long-running — so one shared timeout is appropriate across all callers
 * (the interactive status dashboard, run-issue, and resume-stalled). A
 * hung/black-holed gh process (flaky network, corporate proxy, stuck auth
 * prompt) would otherwise hang commands like `npx forgedock status`
 * indefinitely (#1962). Callers already wrap every io.gh()/io.git() call in
 * try/catch and degrade to null/"unknown" on any rejection, so a timeout
 * fails closed gracefully with no additional error handling required.
 */
export function makeIo() {
  const run = (bin) => async (args) => {
    const { stdout } = await pexec(bin, args, { maxBuffer: 100 * 1024 * 1024, timeout: 10000 });
    return stdout;
  };
  // CI wait seam (scripts/wait-ci-green.sh, argv only, no shell). Resolves { rc, text } for any exit code.
  // `ignore` (forge#4270): check names dropped before deciding (`--ignore-check`); omitted, the argv is unchanged.
  const waitCiGreen = async (pr, repo, timeoutSec, { ignore = [] } = {}) => {
    const script = fileURLToPath(new URL("../scripts/wait-ci-green.sh", import.meta.url));
    try {
      // The engine owns the backoff and the budget: each call is ONE read (no in-script polling, no settle hold;
      // the re-dispatched phase re-runs the full gate before any merge).
      const { stdout } = await pexec("bash", [script, String(pr), "-R", String(repo), "--timeout", String(timeoutSec), ...ignore.flatMap((n) => ["--ignore-check", String(n)])],
        { maxBuffer: 10 * 1024 * 1024, timeout: (timeoutSec + 120) * 1000, env: { ...process.env, FORGE_CI_SETTLE: "0" } });
      return { rc: 0, text: stdout };
    } catch (e) { return { rc: Number.isInteger(e?.code) ? e.code : 2, text: String(e?.stdout ?? "") }; }
  };
  // REST budget seam (`gh api rate_limit`, argv only; the call itself is not rate-limited). Resolves { remaining, limit, reset } or null.
  const rateLimit = async () => {
    try {
      const { stdout } = await pexec("gh", ["api", "rate_limit", "--jq", ".resources.core"], { maxBuffer: 1024 * 1024, timeout: 10000 });
      const j = JSON.parse(stdout);
      return { remaining: j.remaining, limit: j.limit, reset: j.reset };
    } catch { return null; }
  };
  return { gh: run("gh"), git: run("git"), waitCiGreen, rateLimit };
}

/** forge.yaml `engine.ci_pending_max_minutes` from the cwd checkout; undefined when absent or invalid. */
export function readCiPendingMaxMinutes(cwd = process.cwd()) {
  try {
    const n = Number(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.engine?.ci_pending_max_minutes);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch { return undefined; }
}

/** forge.yaml `engine.path` (core|full|lean|auto) from the cwd checkout; undefined when absent or invalid. */
export function readEnginePath(cwd = process.cwd()) {
  try {
    const v = String(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.engine?.path ?? "").trim();
    return ENGINE_PATHS.includes(v) ? v : undefined;
  } catch { return undefined; }
}
/** forge.yaml `engine.conformance` (shadow|enforce) for the core work-on gate; undefined when absent or invalid (the core defaults to shadow). */
export function readConformanceMode(cwd = process.cwd()) {
  try {
    const v = String(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.engine?.conformance ?? "").trim();
    return ["shadow", "enforce"].includes(v) ? v : undefined;
  } catch { return undefined; }
}
/** forge.yaml `engine.review_incomplete` (needs-human|degraded, #4160); undefined when absent or invalid (the core defaults to needs-human). */
export function readReviewIncomplete(cwd = process.cwd()) {
  try {
    const v = String(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.engine?.review_incomplete ?? "").trim();
    return ["needs-human", "degraded"].includes(v) ? v : undefined;
  } catch { return undefined; }
}
/** forge.yaml `engine.lane_instructions` (#4395): repo-relative lane instruction file; undefined when absent, empty or unreadable. */
export function readLaneInstructions(cwd = process.cwd()) {
  try {
    const v = String(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.engine?.lane_instructions ?? "").trim();
    return v || undefined;
  } catch { return undefined; }
}
const warnedContextPack = new Set();
const stderrWarn = (m) => { if (!warnedContextPack.has(m)) { warnedContextPack.add(m); process.stderr.write(`${m}\n`); } };
/** Run each emitter in order; one failing never blocks the next (#4630). */
function composeEmit(...fns) { return async (rec) => { for (const f of fns) { try { await f(rec); } catch { /* telemetry and events never fail a run */ } } }; }
/**
 * forge.yaml `events:` (#4630): `webhook_url`, `webhook_secret_env` (the NAME of the env var holding the HMAC secret; the secret itself is
 * never read from forge.yaml) and `dir` (local JSONL directory). Returns {webhookUrl, secretEnv, dir}; {} when none is set.
 */
export function readEvents(cwd = process.cwd()) {
  try {
    const e = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.events ?? {};
    const v = (k) => String(e[k] ?? "").trim();
    return { ...(v("webhook_url") ? { webhookUrl: v("webhook_url") } : {}), ...(/^[A-Za-z_][A-Za-z0-9_]*$/.test(v("webhook_secret_env")) ? { secretEnv: v("webhook_secret_env") } : {}), ...(v("dir") ? { dir: v("dir") } : {}) };
  } catch { return {}; }
}
/** The probe sweep's `onResult`: one probe.passed / probe.failed event per recorded pass or fail row. Never throws. */
function probeEventSink(repo) {
  const events = makeEventEmitter({ repo, config: readEvents() });
  return async (row) => { for (const p of probeSweepEvents(row)) await events.emitEvent(p.type, p.data, p.ctx); };
}
/** `forgedock stats --experiment <id> --emit-event` (#4632): one experiment.verdict event for a met or missed report; inconclusive emits nothing. Never throws. */
export async function experimentEventSink(repo, report) {
  try {
    const p = experimentEvent(report);
    if (p && p.data.verdict !== "inconclusive") await makeEventEmitter({ repo, config: readEvents() }).emitEvent(p.type, p.data, p.ctx);
  } catch { /* events never fail stats */ }
}
/**
 * forge.yaml context pack (#4275), flat keys under `engine` (the parser flattens one level): `context_pack`
 * (shadow|on|off|ab, #4444), `context_pack_sources` (comma list of graph,attempts,ledger,facts), `context_pack_bytes`,
 * `context_pack_days`. undefined when none is set (the core defaults to shadow). An invalid mode warns through `warn`
 * (stderr, once per message per process) and is dropped; the other keys are kept (#4298).
 */
export function readContextPack(cwd = process.cwd(), warn = stderrWarn) {
  try {
    const e = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.engine ?? {};
    let mode = String(e.context_pack ?? "").trim().toLowerCase();
    if (mode && !["shadow", "on", "off", "ab"].includes(mode)) {
      warn(`forge.yaml engine.context_pack: invalid mode "${mode}" (expected shadow|on|off|ab); using the default, other context_pack_* keys kept`);
      mode = "";
    }
    const out = { ...(mode ? { mode } : {}), ...(e.context_pack_sources != null ? { sources: String(e.context_pack_sources) } : {}),
      ...(e.context_pack_bytes != null ? { bytes: Number(e.context_pack_bytes) } : {}), ...(e.context_pack_days != null ? { days: Number(e.context_pack_days) } : {}),
      ...(e.context_pack_pitfall_lanes != null ? { pitfallLanes: Number(e.context_pack_pitfall_lanes) } : {}) }; // #4375
    return Object.keys(out).length ? out : undefined;
  } catch { return undefined; }
}
/**
 * forge.yaml `review.trigger` (shadow|enforce|off) and `review.risk_paths` (#4273): a comma-separated scalar or a block
 * list (`  risk_paths:` then `    - glob`). Returns {mode, riskPaths}; undefined when neither is set (the core defaults to
 * shadow with the built-in risk patterns). An invalid mode reads as unset.
 */
export function readReviewTrigger(cwd = process.cwd()) {
  let raw;
  try { raw = readFileSync(join(cwd, "forge.yaml"), "utf8"); } catch { return undefined; }
  let sec = {};
  try { sec = parseForgeYaml(raw)?.review ?? {}; } catch { /* unreadable: no trigger config */ }
  const m = String(sec?.trigger ?? "").trim();
  const mode = ["shadow", "enforce", "off"].includes(m) ? m : undefined;
  const riskPaths = typeof sec?.risk_paths === "string" ? sec.risk_paths.split(",").map((x) => x.trim()).filter(Boolean) : [];
  let inReview = false, listIndent = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) { inReview = /^review:\s*(#.*)?$/.test(line); listIndent = null; continue; }
    if (!inReview) continue;
    const indent = line.length - line.trimStart().length;
    if (listIndent === null) { if (/^\s+risk_paths:\s*(#.*)?$/.test(line)) listIndent = indent; continue; }
    if (indent <= listIndent) { listIndent = /^\s+risk_paths:\s*(#.*)?$/.test(line) ? indent : null; continue; }
    const li = /^\s+-\s+["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(line);
    if (li) riskPaths.push(li[1].trim());
  }
  return mode || riskPaths.length ? { mode: mode ?? "shadow", riskPaths } : undefined;
}
/**
 * forge.yaml `review.verifier` (off|shadow|enforce) and `review.verifier_model`, else `engine.lean_verifier_model` (#4397).
 * Returns {mode, model}; undefined when neither is set or valid (the core defaults to off).
 */
export function readVerifier(cwd = process.cwd()) {
  let sec = {};
  try { sec = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.review ?? {}; } catch { /* absent or unreadable */ }
  const m = String(sec?.verifier ?? "").trim();
  const mode = ["off", "shadow", "enforce"].includes(m) ? m : undefined;
  const v = String(sec?.verifier_model ?? "").trim();
  const model = /^[A-Za-z0-9._:[\]-]+$/.test(v) ? v : readLeanSetting("verifier_model", cwd);
  return mode || model ? { mode: mode ?? "off", ...(model ? { model } : {}) } : undefined;
}
/** forge.yaml `lean.repro_test` (off|prefer, #4271); undefined when absent or invalid (the core defaults to prefer). */
export function readReproTest(cwd = process.cwd()) {
  try {
    const v = String(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.lean?.repro_test ?? "").trim();
    return ["off", "prefer"].includes(v) ? v : undefined;
  } catch { return undefined; }
}
/** forge.yaml `decomposition.close_parent` (#3736, #4337): true closes a decomposed parent at decomposition; anything else keeps it open. */
export function readCloseParent(cwd = process.cwd()) {
  try { return String(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.decomposition?.close_parent ?? "").trim() === "true"; } catch { return false; }
}
/** forge.yaml `lean.fix_model` (#4363, else `engine.lean_fix_model`): the model of fresh fix-round sessions; undefined when absent or invalid. */
export function readFixModel(cwd = process.cwd()) {
  try {
    const v = String(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.lean?.fix_model ?? "").trim();
    if (/^[A-Za-z0-9._:[\]-]+$/.test(v)) return v;
  } catch { /* fall through to engine.lean_fix_model */ }
  return readLeanSetting("fix_model", cwd);
}
/**
 * forge.yaml `lean.builder_routing` (on|off, #4394) and `lean.builder_mid_model` (else `engine.lean_builder_mid_model`):
 * {mode?, midModel?}; undefined when neither is set or valid (the core defaults to on with claude-sonnet-5-5).
 */
export function readBuilderRouting(cwd = process.cwd()) {
  let sec = {};
  try { sec = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.lean ?? {}; } catch { /* absent or unreadable */ }
  const m = String(sec?.builder_routing ?? "").trim().toLowerCase();
  const mode = ["on", "off"].includes(m) ? m : undefined;
  const v = String(sec?.builder_mid_model ?? "").trim();
  const midModel = /^[A-Za-z0-9._:[\]-]+$/.test(v) ? v : readLeanSetting("builder_mid_model", cwd);
  return mode || midModel ? { ...(mode ? { mode } : {}), ...(midModel ? { midModel } : {}) } : undefined;
}
/**
 * forge.yaml `lean.base_merge_*` (#4588): deterministic base-merge resolution of sibling-lane conflicts. Comma lists of globs
 * `union_globs` (append-only), `json_globs` (JSON maps, key union), `generated_globs` + `generated_command` (base side taken,
 * then regenerated) (flat keys only). undefined when nothing is configured.
 */
export function readBaseMerge(cwd = process.cwd()) {
  let l = {};
  try { l = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.lean ?? {}; } catch { return undefined; }
  const list = (v) => String(v ?? "").replace(/^\[|\]$/g, "").split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const cfg = { unionGlobs: list(l.base_merge_union_globs), jsonGlobs: list(l.base_merge_json_globs), generatedGlobs: list(l.base_merge_generated_globs), generatedCommand: String(l.base_merge_generated_command ?? "").trim() };
  return cfg.unionGlobs.length || cfg.jsonGlobs.length || cfg.generatedGlobs.length ? cfg : undefined;
}

/**
 * forge.yaml `lean.sequence.regenerate` (#4386): the command that regenerates a schema-changing migration's snapshot
 * after a deterministic renumber. The one-level parser flattens the nested block to `lean.regenerate`; flat
 * `lean.sequence_regenerate` also works and wins. undefined when absent or unreadable.
 */
export function readSequenceRegenerate(cwd = process.cwd()) {
  try { const l = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.lean ?? {}; return String(l.sequence_regenerate ?? l.regenerate ?? "").trim() || undefined; } catch { return undefined; }
}
/** #4664: forge.yaml `followups.default_milestone` (milestone title for deferred follow-ups whose parent's milestone has shipped), or undefined. */
export function readFollowupsDefaultMilestone(cwd = process.cwd()) {
  try { return String(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.followups?.default_milestone ?? "").trim() || undefined; } catch { return undefined; }
}
/** #4389: forge.yaml `post_deploy.precondition_cmd` (exit 0 = ready, 1 = parked, other = ignored), or null. */
export function readPreconditionCmd(cwd = process.cwd()) {
  try {
    const v = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.post_deploy?.precondition_cmd;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch { return null; }
}
/** #4425: forge.yaml `post_deploy.min_age` ("24h", "7d"; opt-in soak window for parked post-deploy follow-ups) in ms, or null. */
export async function readPostDeployMinAge(cwd = process.cwd()) {
  try {
    const { parseMinAge } = await import("./lean/prefilter.mjs");
    return parseMinAge(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.post_deploy?.min_age);
  } catch { return null; }
}
/** forge.yaml `milestones.close_on` (#4657): `staging` or `default` (the default). */
export function readMilestoneCloseOn(cwd = process.cwd()) {
  try { return String(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.milestones?.close_on ?? "").trim().toLowerCase() === "staging" ? "staging" : "default"; } catch { return "default"; }
}
/** forge.yaml `lean.explore` (on|off) and `lean.explore_model` (#4391): the builder's explorer subagent; undefined when neither is set or valid. */
export function readExplore(cwd = process.cwd()) {
  try {
    const l = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.lean ?? {};
    const mode = String(l.explore ?? "").trim().toLowerCase(), model = String(l.explore_model ?? "").trim();
    const out = { ...(["on", "off"].includes(mode) ? { mode } : {}), ...(/^[A-Za-z0-9._:[\]-]+$/.test(model) ? { model } : {}) };
    return Object.keys(out).length ? out : undefined;
  } catch { return undefined; }
}
/** forge.yaml `lean.light` (#4448): {mode: off|shadow|on, maxLines, maxFiles} for bin/lean/light.mjs; the defaults when absent or unreadable. */
export function readLight(cwd = process.cwd()) {
  try { return parseLightConfig(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.lean ?? {}); } catch { return { ...LIGHT_DEFAULTS }; }
}
function readLeanSetting(key, cwd = process.cwd()) {
  try {
    const v = String(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.engine?.[`lean_${key}`] ?? "").trim();
    return /^[A-Za-z0-9._:[\]-]+$/.test(v) ? v : undefined;
  } catch { return undefined; }
}
// core is the default; lean and auto are aliases of core. full is the legacy multi-phase pipeline.
/**
 * forge.yaml `engine.admission` (#4105). The parser flattens one nested level into `engine`, so the keys are read as
 * `engine.enabled|min_free_mem_mb|min_free_tmp_mb|max_load_per_core`, or flat `admission_*` equivalents.
 */
/** #4777: `sched.cap` as a function: min(global_parallel, the host-derived local lane cap), re-probed at every admission attempt. */
export function liveLaneCap(globalParallel, { cfg = readAdmission(), host = { cores: () => cpus().length, memAvailableMb } } = {}) {
  return () => {
    let derived = null;
    try { derived = localLaneCap({ cfg, cores: host.cores(), memAvailableMb: host.memAvailableMb() }); } catch { derived = null; }
    return derived === null ? globalParallel : globalParallel === null ? derived : Math.min(globalParallel, derived);
  };
}
export function readAdmission(cwd = process.cwd()) {
  try {
    const e = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.engine ?? {};
    const num = (v) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : undefined; };
    const pos = (v) => { const n = num(v); return n > 0 ? n : undefined; };
    const en = String(e.admission_enabled ?? e.enabled ?? "").trim().toLowerCase();
    return { ...(en === "false" ? { enabled: false } : {}),
      min_free_mem_mb: num(e.min_free_mem_mb ?? e.admission_min_free_mem_mb), min_free_tmp_mb: num(e.min_free_tmp_mb ?? e.admission_min_free_tmp_mb),
      max_load_per_core: num(e.max_load_per_core ?? e.admission_max_load_per_core),
      lane_cpu_reservation: pos(e.lane_cpu_reservation ?? e.admission_lane_cpu_reservation), lane_mem_mb: pos(e.lane_mem_mb ?? e.admission_lane_mem_mb) };
  } catch { return {}; }
}
/**
 * forge.yaml heavy-step semaphore (#4169), read next to `engine.admission`: `engine.heavy_enabled|heavy_max|
 * heavy_step_mem_mb|heavy_reserve_mb` (or flat `admission_heavy_*`). Unset keys keep the heavy.mjs defaults.
 */
export function readHeavy(cwd = process.cwd()) {
  try {
    const e = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.engine ?? {};
    const num = (v) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n > 0 ? n : undefined; };
    const pick = (k) => e[`heavy_${k}`] ?? e[`admission_heavy_${k}`];
    const en = String(pick("enabled") ?? "").trim().toLowerCase();
    const out = { ...(en === "false" ? { enabled: false } : {}), max: num(pick("max")), step_mem_mb: num(pick("step_mem_mb")), reserve_mb: num(pick("reserve_mb")) };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
  } catch { return {}; }
}
/**
 * forge.yaml lane caps and CLI timeouts for the core path (#4115, #4112). The parser flattens one nested level, so
 * `pipeline:`/`engine:` then `lane_limits:` with `memory_max`/`cpu_quota` arrives as `memory_max`/`cpu_quota` (or flat
 * `lane_limits_memory_max`/`lane_limits_cpu_quota`), plus `tasks_max` (#4690, default 1024). `engine.cli_idle_minutes` (default 15) and `engine.cli_max_minutes` (default 180).
 * `engine.cli_busy_minutes` (default 45, #4405): extra silence allowed while the builder has a live heavy step or heavy-queue entry.
 * #4390: `engine.context_ceiling_tokens` (default 120000 in runCore; 0 = off).
 * #4392: `engine.turn_budget_s|m|l` (implement turn budget per lane size; defaults 25/60/100, always returned; 0 = off).
 */
export function readCoreLimits(cwd = process.cwd()) {
  try {
    const y = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8")) ?? {};
    const pick = (k) => { for (const sec of [y.pipeline, y.engine]) { const v = sec?.[k] ?? sec?.[`lane_limits_${k}`]; if (v !== undefined && v !== "") return String(v).trim(); } return undefined; };
    const mem = pick("memory_max"), cpu = pick("cpu_quota"), tasks = pick("tasks_max");
    const posNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; };
    return {
      // #4690: lanes get TasksMax by default; MemoryMax is opt-in (a default K-derived cap killed healthy lanes, #4740); `off`/0 disables one limit
      laneLimits: { ...(mem ? { memory_max: mem } : {}), ...(cpu ? { cpu_quota: cpu } : {}), ...(tasks ? { tasks_max: tasks } : {}) },
      ...(posNum(y.engine?.cli_idle_minutes) ? { cliIdleMinutes: posNum(y.engine.cli_idle_minutes) } : {}),
      ...(posNum(y.engine?.cli_max_minutes) ? { cliMaxMinutes: posNum(y.engine.cli_max_minutes) } : {}),
      ...(posNum(y.engine?.cli_busy_minutes) ? { cliBusyMinutes: posNum(y.engine.cli_busy_minutes) } : {}),
      ...(/^\d+$/.test(String(y.engine?.context_ceiling_tokens ?? "").trim()) ? { contextCeilingTokens: Number(y.engine.context_ceiling_tokens) } : {}),
      turnBudgets: parseTurnBudgets(y.engine) ?? { ...TURN_BUDGET_DEFAULTS }, // #4392: lanes are budgeted by default
    };
  } catch { return { laneLimits: {}, turnBudgets: { ...TURN_BUDGET_DEFAULTS } }; }
}
/** forge.yaml `engine.merge_wait` (required|all|none); undefined when absent or invalid. */
export function readMergeWait(cwd = process.cwd()) {
  try {
    const v = String(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.engine?.merge_wait ?? "").trim();
    return ["required", "all", "none"].includes(v) ? v : undefined;
  } catch { return undefined; }
}
/**
 * forge.yaml `verify:` section (#4167, block style: `verify:` then `  mode: ci`, `  workflow: verify.yml`, `  paths_input`,
 * `  skip_paths` comma-separated, `  max_rounds`, `  check_run: true` (#4270)) for the core path; undefined when the
 * section is absent or unreadable.
 */
export function readVerify(cwd = process.cwd()) {
  try {
    const sec = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.verify;
    if (!sec || typeof sec !== "object") return undefined;
    const invariants = readInvariants(cwd), flaky = readYamlList(cwd, "verify", "flaky");
    return parseVerify({ ...sec, ...(invariants ? { invariants } : {}), ...(flaky ? { flaky } : {}) });
  } catch { return undefined; }
}
/** #4542: forge.yaml `execution.host_capabilities` (+ patterns) for a lane's remote-block mapping; undefined when none are declared. */
export function readHostCaps(cwd = process.cwd()) {
  const e = readExecution(cwd);
  return e?.hostCapabilities?.length ? { hostCapabilities: e.hostCapabilities, ...(e.hostCapabilityPatterns ? { hostCapabilityPatterns: e.hostCapabilityPatterns } : {}) } : undefined;
}
/** #4778: the capabilities the dispatching host relays to this sandbox lane (`CS_RELAY_CAPS`, set by the remote provider); `{}` when none. */
export function readRelayCaps(env = process.env) {
  const caps = String(env.CS_RELAY_CAPS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z][a-z0-9_-]*$/.test(x));
  return caps.length ? { relayCaps: [...new Set(caps)] } : {};
}
/**
 * forge.yaml `execution:` section (#4253, block style: `execution:` then `  mode: remote`, `  max_remote: 4`,
 * `  provider: container`, `  image`, `  secrets` comma-separated env names; remote provider #4254: `  endpoint`,
 * `  token_env`, `  cache_store`, `  allow_actions`; #4255 budget: `  budget_minutes`, `  budget_usd`, `  day_budget_minutes`,
 * `  day_budget_usd`, `  on_budget: stop|local`, `  cost_per_minute`) for `orchestrate`; undefined when the section is
 * absent or unreadable.
 */
export function readExecution(cwd = process.cwd()) {
  try {
    const sec = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.execution;
    return sec && typeof sec === "object" ? parseExecution(sec) : undefined;
  } catch { return undefined; }
}
/**
 * forge.yaml `learned.test_commands` (#4240): the repo's declared check commands, run by the core path in the lane
 * worktree before the PR. A block list (`  test_commands:` then `    - "cmd"` or `    - cmd`); parseForgeYaml reads
 * scalars only. undefined when absent, empty or unreadable.
 */
export function readPrecheckCommands(cwd = process.cwd()) {
  return readYamlList(cwd, "learned", "test_commands");
}
/** #4585: forge.yaml `verify.invariants`, a block list of repo-wide check commands; undefined when absent or empty. */
export function readInvariants(cwd = process.cwd()) {
  return readYamlList(cwd, "verify", "invariants");
}
function readYamlList(cwd, section, key) {
  let raw;
  try { raw = readFileSync(join(cwd, "forge.yaml"), "utf8"); } catch { return undefined; }
  const out = [];
  const head = new RegExp(`^${section}:\\s*(#.*)?$`), keyRe = new RegExp(`^\\s+${key}:\\s*(#.*)?$`);
  let inSection = false, listIndent = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) { inSection = head.test(line); listIndent = null; continue; }
    if (!inSection) continue;
    const indent = line.length - line.trimStart().length;
    if (listIndent === null) {
      if (keyRe.test(line)) listIndent = indent;
      continue;
    }
    if (indent <= listIndent) { listIndent = keyRe.test(line) ? indent : null; continue; }
    const m = /^\s+-\s+(.*)$/.exec(line);
    if (!m) continue;
    let v = m[1].trim();
    const q = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(v) ?? /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(v);
    if (q) v = v.startsWith('"') ? q[1].replace(/\\(["\\])/g, "$1") : q[1].replace(/''/g, "'");
    else v = v.replace(/\s+#.*$/, "").trim();
    if (v) out.push(v);
  }
  return out.length ? out : undefined;
}
/**
 * forge.yaml `lean.precheck.max_minutes` (#4331): the pre-PR check round budget in minutes (1..120). The one-level
 * parser flattens a nested `precheck:` block under `lean:` to `lean.max_minutes`; flat `lean.precheck_max_minutes` also
 * works and wins. undefined when absent, invalid or unreadable (runCore then uses verify.precheck_total_seconds, default 600 s).
 */
export function readPrecheckBudget(cwd = process.cwd()) {
  try {
    const l = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.lean ?? {};
    const raw = String(l.precheck_max_minutes ?? l.max_minutes ?? "").trim(), n = Number(raw);
    return raw !== "" && Number.isFinite(n) && n >= 1 && n <= 120 ? n : undefined;
  } catch { return undefined; }
}
/** runCore `precheck` option: {commands, maxMinutes} from learned.test_commands and lean.precheck.max_minutes; {} when neither is set. */
function readPrecheckOptions(cwd = process.cwd()) {
  const commands = readPrecheckCommands(cwd), maxMinutes = readPrecheckBudget(cwd);
  return commands || maxMinutes ? { precheck: { ...(commands ? { commands } : {}), ...(maxMinutes ? { maxMinutes } : {}) } } : {};
}
/**
 * forge.yaml `env` for core lanes (#4163): `env.toolchain` ("<pm>@<x.y.z>" or "off") and `env.setup` (a command run once
 * per fresh worktree before the builder); `env.sparse_max_kb` (#4221: sparse lane checkout threshold, 0 = off). Returns runCore options; {} when absent.
 */
export function readEnvConfig(cwd = process.cwd()) {
  try {
    const e = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.env ?? {};
    const s = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const kb = typeof e.sparse_max_kb === "string" && /^\d+$/.test(e.sparse_max_kb.trim()) ? Number(e.sparse_max_kb) : e.sparse_max_kb;
    return { ...(s(e.toolchain) ? { toolchainOverride: s(e.toolchain) } : {}), ...(s(e.setup) ? { envSetup: s(e.setup) } : {}),
      ...(Number.isInteger(kb) && kb >= 0 ? { sparseMaxKb: kb } : {}) };
  } catch { return {}; }
}
export const ENGINE_PATHS = ["core", "full", "lean", "auto"];

export function runDir() { return join(homedir(), ".forge", "runs"); }

/**
 * Sums the four token-usage fields across every `PHASE_COMMIT`/`PHASE_FAILED`
 * run-log event that carries a non-null `usage` object. Mirrors the writer
 * shape and `?? 0` accumulation convention used by `bin/engine.mjs:411,500`
 * (`usage: outcome.usage ?? null`) and `bin/runner.mjs:1699-1723` (the
 * canonical per-run accumulator) — same field names, same null-safe adds.
 *
 * Only `PHASE_COMMIT`/`PHASE_FAILED` events carry `usage`; other event types
 * are skipped without inspecting their shape.
 *
 * @param {Array<object>} events - run-log events (from readLog())
 * @returns {{input_tokens: number, output_tokens: number, cache_creation_input_tokens: number, cache_read_input_tokens: number} | null}
 *   `null` when no event carried usage data (e.g. an all-CLI-backend run) —
 *   callers MUST treat `null` as "omit the line", never substitute zeros
 *   (a `0 tokens` line would misleadingly imply usage was measured and was
 *   zero, rather than "not measured at all").
 */
export function aggregateUsage(events) {
  let found = false;
  const total = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  // forge#3696: PHASE_COMMIT.usage is cumulative over all attempts, so summing it with
  // PHASE_FAILED would double count. For a phase that has PHASE_ATTEMPT_USAGE events,
  // sum ONLY those; otherwise (old logs) fall back to the legacy COMMIT + FAILED sum.
  const attemptPhases = new Set(events.filter((e) => e.event === "PHASE_ATTEMPT_USAGE").map((e) => e.phase));
  for (const e of events) {
    if (e.event === "PHASE_ATTEMPT_USAGE") {
      // counted as-is (usage null => nothing to add)
    } else if (e.event === "PHASE_COMMIT" || e.event === "PHASE_FAILED") {
      if (attemptPhases.has(e.phase)) continue;
    } else continue;
    if (!e.usage || typeof e.usage !== "object") continue;
    found = true;
    total.input_tokens += e.usage.input_tokens ?? 0;
    total.output_tokens += e.usage.output_tokens ?? 0;
    total.cache_creation_input_tokens += e.usage.cache_creation_input_tokens ?? 0;
    total.cache_read_input_tokens += e.usage.cache_read_input_tokens ?? 0;
  }
  return found ? total : null;
}

/**
 * Renders a single usage-summary line from an `aggregateUsage()` result, or
 * `""` when `usage` is `null` — callers must skip printing entirely in that
 * case rather than print a placeholder/zero line.
 * @param {{input_tokens:number, output_tokens:number, cache_creation_input_tokens:number, cache_read_input_tokens:number} | null} usage
 * @returns {string}
 */
export function formatUsageLine(usage) {
  if (!usage) return "";
  return `  usage:   ${usage.input_tokens} in / ${usage.output_tokens} out (${usage.cache_read_input_tokens} cache-read / ${usage.cache_creation_input_tokens} cache-write)`;
}

/**
 * Renders the diagnostic block printed below the bare terminal line whenever
 * a run does not terminate `merged` (forge#2175). Reconstructs the failing
 * phase, attempt count, and `PHASE_FAILED.reason` from the durable run-log
 * (the same data `bin/engine.mjs`'s `runPhaseWithRetry()` already appends via
 * `appendEvent()`), plus the final committed/branch/pr state, the aggregate
 * per-run token usage (forge#2399 — omitted when no event carries usage
 * data), and the run-log path — closing the gap where an operator previously
 * had to manually open `~/.forge/runs/{issue}.jsonl` and read engine source
 * to interpret a bare `issue #N -> needs-human` line.
 *
 * Best-effort: if the run-log is empty/unreadable (e.g. a `deferred` early
 * return before any event was appended), only the run-log path line is
 * printed — never throws.
 *
 * Validates `issue` internally (mirrors the `Number.isInteger` guard in
 * `lastLocalRun()` below) rather than relying solely on the caller —
 * `runFromCli()` already validates before calling this, but this is an
 * exported helper and a future caller could forget to (forge#2190).
 *
 * @param {string} dir - runDir() (or an injected override for tests)
 * @param {number} issue
 * @param {string|null} [repo] - "owner/repo" (#4432: the run log is keyed by repo + issue); null = legacy `<issue>.jsonl`
 * @returns {string} multi-line diagnostic block (no trailing newline)
 */
export function formatTerminalDiagnostics(dir, issue, repo = null) {
  if (!Number.isInteger(issue)) {
    return `  run-log: <invalid issue: ${JSON.stringify(issue)}>`;
  }
  const logPath = runLogPath(dir, issue, repo);
  let events = [];
  try {
    events = readLog(dir, issue, { repo });
  } catch {
    // Corrupt/unreadable log — degrade to just the run-log path line below.
  }

  const lines = [];
  if (events.length > 0) {
    const state = deriveState(events);
    const lastFailure = [...events].reverse().find((e) => e.event === "PHASE_FAILED");
    if (lastFailure) {
      lines.push(`  phase:   ${lastFailure.phase} (failed ${lastFailure.attempt}/${lastFailure.maxAttempts ?? DEFAULT_MAX_ATTEMPTS} attempts)`);
      lines.push(`  reason:  ${lastFailure.reason}`);
    }
    const committed = state.committed.length ? state.committed.join(",") : "";
    lines.push(`  state:   committed=[${committed}] branch=${state.branch ?? "null"} pr=${state.pr ?? "null"}`);
  }
  lines.push(`  run-log: ${logPath}`);
  const usageLine = formatUsageLine(aggregateUsage(events));
  if (usageLine) lines.push(usageLine);
  return lines.join("\n");
}

// forge#4157: backoff between `gh repo view` attempts. Under host load one call can exceed makeIo's exec timeout.
export const REPO_VIEW_BACKOFF_MS = [2000, 4000];
// forge#4157: how long an orchestrate lane waits before rerunning after `gh` stayed unreachable.
export const GH_UNAVAILABLE_RETRY_S = 60;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolves the repo `gh` would target by default (i.e. resolved from the cwd
 * git remote), via `gh repo view`. Used to validate an explicit `--repo` flag
 * against the ambient context — see `assertRepoMatchesCwd`. A failed call is
 * retried with backoff (forge#4157: it is usually a transient timeout under load).
 * @param {{gh: Function}} io
 * @param {{sleep?: (ms:number)=>Promise<void>, detail?: boolean}} [opts] - `detail: true` returns
 *   `{repo, failed}` so a caller can tell "every attempt errored" from an answer.
 * @returns {Promise<string|null|{repo:string|null, failed:boolean}>} "owner/repo", or null if it can't be determined
 */
async function resolveDefaultRepo(io, { sleep = realSleep, detail = false } = {}) {
  let failed = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await io.gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
      const repo = String(out).trim() || null;
      return detail ? { repo, failed: false } : repo;
    } catch {
      failed = true;
      if (attempt >= REPO_VIEW_BACKOFF_MS.length) break;
      await sleep(REPO_VIEW_BACKOFF_MS[attempt]);
    }
  }
  return detail ? { repo: null, failed } : null;
}

/**
 * #4125: the default (production) branch is never a lane, on any path or entry point. Checks forge.yaml
 * `branches.default` and GitHub's default branch (best effort here; the core path re-checks it fail-closed).
 */
export async function assertLaneNotDefault(io, lane, repo = null, cwd = process.cwd()) {
  if (!lane) return;
  let gh = null;
  try { gh = String(await io.gh(["repo", "view", ...(repo ? [repo] : []), "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])).trim() || null; } catch { gh = null; }
  if (isDefaultLane(lane, [readBranches(cwd).default, gh].filter(Boolean))) {
    throw new Error(`lane.default_branch: --lane ${lane} is the default branch. Lanes are staging or milestone/<slug>; promotion to the default branch is a human-merged release PR.`);
  }
}

/**
 * Guards against cross-repo state confusion (forge#1593): `--repo` used to be
 * threaded into the `gh issue list` enumeration call but never into the
 * projector's state reads/writes or into re-dispatch, so a mismatched
 * `--repo` silently read/wrote FORGE:STATE in the cwd-resolved repo instead
 * of the requested one. Fully threading `--repo` through every `io.gh`/
 * `io.git` call site the engine makes during a run (phases.mjs, reconcile.mjs,
 * projector.mjs) would be a much larger, riskier change. Instead, this fails
 * closed: if `--repo` is given and doesn't match the repo `gh` would use by
 * default, refuse to run at all rather than silently mixing repos.
 * @param {{gh: Function}} io
 * @param {string|null} repo
 * @param {{sleep?: Function}} [opts] - backoff seam for the `gh repo view` retries
 * @returns {Promise<void>}
 */
async function assertRepoMatchesCwd(io, repo, { sleep } = {}) {
  if (!repo) return;
  const { repo: defaultRepo, failed } = await resolveDefaultRepo(io, { sleep, detail: true });
  if (defaultRepo === null) {
    const err = new Error(
      `--repo ${repo} was given, but the current repo could not be determined (\`gh repo view\` failed) to ` +
      `verify it matches. Refusing to run cross-repo without verification.`
    );
    // forge#4157: `gh` kept failing after retries; transient, so run-issue defers instead of erroring.
    if (failed) err.code = OUTCOME_CODES.GH_UNAVAILABLE;
    throw err;
  }
  if (defaultRepo !== repo) {
    throw new Error(
      `--repo ${repo} does not match the current repo (${defaultRepo}). Cross-repo dispatch is not supported — ` +
      `state reads/writes (issue view/edit) are cwd-scoped and would silently target ${defaultRepo} instead of ` +
      `${repo}. Run this command with cwd set to a checkout of ${repo}, or omit --repo to operate on ${defaultRepo}.`
    );
  }
}

/**
 * @param {number[]} issues
 * @param {{readState:(i:number)=>Promise<{terminal:boolean,lease:?{until:number}}|null>}} io
 * @param {number} now
 * @returns {Promise<number[]>} issues that appear stalled (expired lease, non-terminal)
 */
export async function scanStalls(issues, io, now) {
  const stalled = [];
  for (const i of issues) {
    const s = await io.readState(i);
    if (s && !s.terminal && s.lease && s.lease.until < now) stalled.push(i);
  }
  return stalled;
}

/**
 * Read-only in-flight/stalled counter for the `status`/`install` re-entry
 * dashboard (#1945). Reuses the exact same enumeration + lease-expiry logic
 * as `resumeStalledFromCli` (workflow-label search via `gh issue list`, then
 * `scanStalls` against the GitHub-authoritative FORGE:STATE via the
 * projector) — GitHub is this codebase's source of truth for run state, not
 * the local `~/.forge/runs` hot-path log, so the dashboard counts the same
 * way the orchestrator does. Never dispatches or mutates anything.
 *
 * Best-effort: a `gh issue list` failure for one label is swallowed (treated
 * as zero matches for that label) — consistent with resumeStalledFromCli's
 * existing tolerance — so one bad label search never blocks the others.
 *
 * @param {{gh: Function}} io
 * @param {string|null} repo - "owner/repo", or null to use gh's cwd-resolved default
 * @param {number} now
 * @returns {Promise<{total: number, inFlight: number, stalled: number}>}
 */
export async function countEngineActivity(io, repo, now) {
  const repoFlag = repo ? ["--repo", repo] : [];
  const issueSet = new Set();

  for (const label of ACTIVE_WORKFLOW_LABELS) {
    try {
      const out = await io.gh([
        "issue", "list",
        ...repoFlag,
        "--state", "open",
        "--label", label,
        "--limit", "100",
        "--json", "number",
      ]);
      const items = JSON.parse(out);
      for (const { number } of items) issueSet.add(number);
    } catch {
      // gh may return non-zero when no issues match, or fail transiently —
      // treat as empty for this label rather than aborting the whole count.
    }
  }

  if (issueSet.size === 0) return { total: 0, inFlight: 0, stalled: 0 };

  const projector = makeProjector(io);
  const candidates = [...issueSet];
  const stalled = await scanStalls(candidates, projector, now);
  return { total: candidates.length, inFlight: candidates.length - stalled.length, stalled: stalled.length };
}

/**
 * Best-effort summary of the most recently modified local run-log under
 * `~/.forge/runs` (runDir()). This is a MACHINE-LOCAL view — the crash-safe
 * hot-path log described in engine/runlog.mjs, not the GitHub-authoritative
 * state used by countEngineActivity() above. Appropriate only for a "what did
 * I last run here" dashboard row, not for cross-machine in-flight/stalled
 * counts.
 *
 * Never throws: returns null when the runs dir doesn't exist, holds no
 * `.jsonl` files, or the newest file can't be read/parsed. A single corrupt
 * or unreadable file is skipped in favor of the next-newest one rather than
 * failing the whole lookup (forge#1528 — batch operations here must not abort
 * on one bad item).
 *
 * @param {string} dir - runDir()
 * @returns {{issue: number, terminal: boolean, terminalReason: string|null} | null}
 */
export function lastLocalRun(dir) {
  let entries;
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }

  // Sort newest-first by mtime so a corrupt newest file falls through to the
  // next-newest candidate instead of giving up entirely.
  const withMtime = [];
  for (const f of entries) {
    try {
      withMtime.push({ f, mtime: statSync(join(dir, f)).mtimeMs });
    } catch {
      // unreadable — skip
    }
  }
  withMtime.sort((a, b) => b.mtime - a.mtime);

  for (const { f } of withMtime) {
    // #4432: `<issue>.jsonl` (legacy) or `<owner>__<repo>__<issue>.jsonl`; the issue is the trailing number.
    const m = /(?:^|__)(\d+)\.jsonl$/.exec(f);
    if (!m) continue;
    const issue = Number(m[1]);
    try {
      const events = readLogFile(join(dir, f));
      if (events.length === 0) continue;
      const state = deriveState(events);
      return { issue, terminal: state.terminal, terminalReason: state.terminalReason };
    } catch {
      continue; // corrupt file — try the next-newest
    }
  }
  return null;
}

/**
 * @param {string[]} argv
 * @param {{io?: {gh: Function}, runIssue?: Function}} [deps]
 *   Injectable for tests — defaults to real `gh`/`git` (makeIo()) and the real
 *   `runIssue` engine driver.
 *
 * Flags:
 *   --lane <lane>          Core path: optional assertion. The lane is worked out from the issue (milestone →
 *                          forge.yaml branches.feature_pattern, else branches.staging); a different --lane is refused
 *                          (`lane-refused`, lane.mismatch) unless --lane-override. Full path: required.
 *                          The default branch is never accepted (#4125).
 *   --lane-override        Core path: accept a --lane that differs from the resolved lane (recorded in the trajectory).
 *   --repo <owner/repo>    Optional — must match the cwd-resolved repo (forge#1593).
 *   --backend <cli|api|auto>  Optional (forge#2028). Forwarded to every phase's
 *                          `runCommand()` call. Omit to keep runner.mjs's own
 *                          default ("auto" ladder — probes the `claude` CLI, falls
 *                          back to the API). Mirrors `bin/forgedock.mjs`'s `run()`
 *                          `--backend` semantics — validation (rejecting invalid
 *                          values) is left to `runCommand()`'s own `resolveBackend()`
 *                          rather than duplicated here.
 *   --model <id>           Optional (forge#2028). Forwarded to every phase's
 *                          `runCommand()` call; only applies on the "api" backend.
 *                          Omit to keep runner.mjs's default (`FORGEDOCK_MODEL` env
 *                          or its built-in default).
 *   --wait-lease           Optional (forge#3574). If another live holder owns the
 *                          run's lease, wait (bounded by the lease TTL) until it
 *                          expires or its same-host pid is dead, then continue.
 *                          Without it, a held lease exits `deferred` (code 75).
 *   --path <core|full|lean|auto>  Engine path; overrides forge.yaml engine.path. Default core (lean work-on); lean/auto are aliases; full is the legacy multi-phase pipeline.
 *   --result-file <path>   Core path (#4121): write the run result as JSON to <path> (atomically, also when the run
 *                          throws). `forgedock orchestrate` lanes report through it.
 *   --retry                Optional (forge#3511). Reopen a run that ended `engine-error`
 *                          (e.g. a session-limit hit) and resume from its last committed
 *                          phase. A run that ended `phase-complete` (multi-phase issue, phase merged,
 *                          more remain) starts its next cycle from investigate. Other
 *                          terminal reasons are not reopened.
 */
export async function runFromCli(argv, deps = {}) {
  const issue = parseInt(argv[0], 10);
  if (!Number.isInteger(issue)) throw new Error("usage: forgedock run-issue <issue-number> [--lane <lane>] [--lane-override] [--path core|full] [--recover <code> [--recover-attempt n] [--recover-nonfinal]] [--retry] [--wait-lease]");
  assertOpenCodeNativeRuntime({ operation: "forgedock run-issue" });
  const lane = flag(argv, "--lane");
  if (argv.includes("--lane") && (!lane || lane.startsWith("--"))) throw new Error("--lane requires a value: staging or milestone/<slug>");
  const laneOverride = argv.includes("--lane-override");
  const repo = flag(argv, "--repo");
  const backend = flag(argv, "--backend");
  const model = flag(argv, "--model");
  // Boolean flag: only counts at a flag position, never as another flag's value.
  const retry = argv.some((a, i) => a === "--retry" && !["--lane", "--repo", "--backend", "--model", "--path", "--result-file", "--placement", "--placement-reason", "--recover", "--recover-attempt"].includes(argv[i - 1]));
  // forge#3574: --wait-lease blocks (bounded by the lease TTL) until a live
  // holder's lease expires or becomes reclaimable. Same flag-position guard.
  const waitLease = argv.some((a, i) => a === "--wait-lease" && !["--lane", "--repo", "--backend", "--model"].includes(argv[i - 1]));
  const pathFlag = flag(argv, "--path");
  if (argv.includes("--path") && (!pathFlag || pathFlag.startsWith("--"))) throw new Error(`--path requires a value: ${ENGINE_PATHS.join("|")}`);
  if (pathFlag && !ENGINE_PATHS.includes(pathFlag)) throw new Error(`--path must be one of ${ENGINE_PATHS.join("|")}`);
  const enginePath = pathFlag ?? readEnginePath() ?? "core";
  if (enginePath !== "full" && (retry || waitLease)) {
    throw new Error("--retry and --wait-lease are not supported with the core path (a rerun resumes from the open PR or remote branch automatically); use --path full for them");
  }
  // The full path takes the lane as given (its spec runs classify-lane), so it must be explicit; no default.
  if (enginePath === "full" && !lane) throw new Error("--lane is required with --path full: staging or milestone/<slug>. No default to prevent accidental production targeting.");
  // #4298: recovery lanes (#4267) exist only on the core path; the legacy full path would silently ignore --recover.
  if (enginePath === "full" && argv.includes("--recover")) throw new Error("--recover is not supported with --path full (recovery lanes run on the core path only)");
  const io = deps.io ?? makeIo();
  const resultFile = flag(argv, "--result-file");
  // #4256: where the dispatcher placed this lane (hybrid execution), recorded in the lane's FORGE:STATE.
  const placementWhere = flag(argv, "--placement");
  const placement = placementWhere === "local" || placementWhere === "remote"
    ? { where: placementWhere, reason: String(flag(argv, "--placement-reason") ?? "").slice(0, 300), mode: readExecution()?.mode ?? "local" } : null;
  // #4267: a batch recovery lane for a mechanical needs-human (`--recover <code> [--recover-attempt n]`); #4302: `--recover-nonfinal`
  // marks an attempt the runner may follow with another, so the lane leaves the needs-human relabel to the runner.
  const recoverCode = flag(argv, "--recover");
  const recoverAttempt = Number(flag(argv, "--recover-attempt"));
  const recover = recoverCode && !recoverCode.startsWith("--") ? { code: recoverCode, attempt: Number.isInteger(recoverAttempt) && recoverAttempt > 0 ? recoverAttempt : 1, final: !argv.includes("--recover-nonfinal") } : null;
  const report = (r) => { if (resultFile) (deps.writeAtomic ?? writeResultAtomic)(resultFile, JSON.stringify(r) + "\n"); return r; };
  try {
    await assertRepoMatchesCwd(io, repo, { sleep: deps.sleep });
  } catch (e) {
    if (e?.code !== OUTCOME_CODES.GH_UNAVAILABLE) throw e;
    // forge#4157: a scheduling fact, not an engine error; the batch requeues it and the breaker never sees it.
    const res = report({ terminalReason: "deferred", code: OUTCOME_CODES.GH_UNAVAILABLE, detail: e.message, retryInSeconds: GH_UNAVAILABLE_RETRY_S });
    console.log(`issue #${issue} → deferred (${res.detail})`);
    return res;
  }
  await assertLaneNotDefault(io, lane, repo);
  const runIssueFn = deps.runIssue ?? runIssue;
  const agentId = `cli_${sanitizeLeaseHost(hostname())}_${process.pid}`;
  // Injectable for tests (forge#2175) — defaults to the real ~/.forge/runs dir.
  const dir = deps.dir ?? runDir();
  migrateRunLogs(dir); // #4432: split legacy per-issue logs by repo (best effort, never throws)
  // #4432: the run log is keyed by repo + issue. The core path needs the repo anyway; the full path tries once per
  // backoff step without waiting (engine.mjs resolves it again itself), and an unresolved repo keeps the legacy name.
  const logRepo = repo ?? (await resolveDefaultRepo(io, enginePath === "full" ? { sleep: async () => {} } : {}));
  // forge#2240: print the run-log path at the very start of the run, not only
  // in the non-merged completion diagnostics (formatTerminalDiagnostics prints
  // it too, but only post-completion and only for non-"merged" outcomes). A
  // caller tailing this process's stdout should be able to find the run-log
  // to inspect immediately, without waiting for the run to finish.
  console.log(`run-log: ${runLogPath(dir, issue, logRepo)}`);
  // forge#2240: phase-boundary progress lines — the only stdout emitted
  // during the run itself. `runIssue()`'s `onProgress` callback defaults to a
  // no-op, so this is purely additive; engine.mjs never calls console.log
  // directly (keeps it injectable/testable — see its onProgress param doc).
  const onProgress = (e) => {
    if (e.event === "phase_enter") console.log(`→ phase ${e.phase} started`);
    else if (e.event === "phase_exit" && e.status === "committed") console.log(`✓ phase ${e.phase} committed`);
    else if (e.event === "phase_exit" && e.status === "blocked") console.log(`✗ phase ${e.phase} blocked: ${e.detail ?? "no detail"}`);
    // forge#2524: session-limit pause — the engine is waiting in-process
    // until the reported reset time before retrying this same phase, rather
    // than terminating. Distinct glyph from the exit/blocked lines above so
    // an operator tailing this stdout can tell "still alive, just waiting"
    // from "phase actually failed".
    else if (e.event === "phase_paused") console.log(`⏸ phase ${e.phase} paused: ${e.detail ?? "session limit"}`);
  };
  if (enginePath !== "full") {
    // Core work-on (lean): one builder session, one reviewer, GitHub as the register.
    const leanRepo = logRepo;
    if (!leanRepo) throw new Error("core path needs the repo: pass --repo or run inside a checkout with a GitHub remote");
    const { runCore } = deps.leanModule ?? (await import("./lean/lean.mjs"));
    const leanIo = deps.leanIo ?? (await import("./lean/effects.mjs")).makeLeanIo({ repo: leanRepo });
    // #4121: a batch lane reports its result through --result-file (written atomically, also for a thrown run).
    // #4179: SIGTERM/SIGINT run the lane's teardown (ledger, checkpoint, worktree, lease), report deferred run.interrupted, exit 128+signo.
    let teardown = null, interrupted = false;
    const on = deps.processOn ?? ((s, f) => process.on(s, f)), off = deps.processOff ?? ((s, f) => process.removeListener(s, f));
    const exit = deps.exit ?? ((c) => process.exit(c));
    const SIGNO = { SIGINT: 2, SIGTERM: 15 };
    const handlers = Object.fromEntries(Object.keys(SIGNO).map((sig) => [sig, async () => {
      if (interrupted) return;
      interrupted = true;
      let r = null;
      try { r = teardown ? await teardown(sig) : null; } catch { r = null; }
      try { report({ ...(r ?? {}), terminalReason: "deferred", code: OUTCOME_CODES.RUN_INTERRUPTED, detail: r?.detail ?? `interrupted by ${sig}` }); } catch { /* exit anyway */ }
      console.log(`issue #${issue} → deferred (interrupted by ${sig})`);
      exit(128 + SIGNO[sig]);
    }]));
    for (const [sig, f] of Object.entries(handlers)) on(sig, f);
    const env = deps.env ?? process.env;
    let lres;
    try {
      lres = await runCore({ issue, repo: leanRepo, ...(lane ? { lane } : {}), laneOverride, branches: readBranches(), cwd: process.cwd(), dir, io: leanIo, path: enginePath, onProgress,
      onTeardown: (fn) => { teardown = fn; }, ...(env.FORGEDOCK_BATCH_ID ? { batchId: env.FORGEDOCK_BATCH_ID } : {}), ...(placement ? { placement } : {}), ...(recover ? { recover } : {}),
      emitTelemetry: deps.emitTelemetry ?? composeEmit(makeEmitTelemetry({ repo: leanRepo }), makeEventEmitter({ repo: leanRepo, config: readEvents() }).emit),
      admission: readAdmission(), heavy: readHeavy(), ...readCoreLimits(), ...readEnvConfig(), ...(readMergeWait() ? { mergeWait: readMergeWait() } : {}), ...(readConformanceMode() ? { conformance: readConformanceMode() } : {}), ...(readContextPack() ? { contextPack: readContextPack() } : {}), ...(readReviewIncomplete() ? { reviewIncomplete: readReviewIncomplete() } : {}), ...(readLaneInstructions() ? { laneInstructions: readLaneInstructions() } : {}), ...(readReproTest() ? { reproTest: readReproTest() } : {}), ...(readExplore() ? { explore: readExplore() } : {}), ...(readExperiment() ? { experiment: readExperiment() } : {}), light: readLight(), ...(readCloseParent() ? { closeParent: true } : {}), ...(readReviewTrigger() ? { reviewTrigger: readReviewTrigger() } : {}), ...(readVerify() ? { verify: readVerify() } : {}), ...readPrecheckOptions(), ...(model ? { builderModel: model } : {}), ...(readLeanSetting("reviewer_model") ? { reviewerModel: readLeanSetting("reviewer_model") } : {}), ...(readFixModel() ? { fixModel: readFixModel() } : {}), ...(readBuilderRouting() ? { builderRouting: readBuilderRouting() } : {}), ...(readVerifier() ? { verifier: readVerifier() } : {}), ...(readHostCaps() ? { hostCaps: readHostCaps() } : {}), ...readRelayCaps(), ...(readSequenceRegenerate() ? { sequenceRegenerate: readSequenceRegenerate() } : {}), ...(readBaseMerge() ? { baseMerge: readBaseMerge() } : {}), ...(readFollowupsDefaultMilestone() ? { followupsDefaultMilestone: readFollowupsDefaultMilestone() } : {}) });
    } catch (e) { if (!interrupted) report({ terminalReason: "engine-error", detail: String(e?.message ?? e).slice(0, 500) }); throw e; }
    finally { if (!interrupted) for (const [sig, f] of Object.entries(handlers)) off(sig, f); }
    if (interrupted) return lres; // the signal handler reported and exits
    report(lres);
    if (lres.code === "host.busy") { console.log(`issue #${issue} → deferred (${lres.detail})`); return lres; }
    if (lres.terminalReason === "lane-refused") { console.log(`issue #${issue} → lane-refused ${lres.code} (${lres.detail})`); return lres; }
    console.log(`issue #${issue} → ${lres.terminalReason}`);
    if (!["merged", "invalid"].includes(lres.terminalReason)) console.log(lres.detail ?? "");
    return lres;
  }
  const res = await runIssueFn({ issue, dir, agentId, lane, io,
    ...(repo ? { repo } : {}),
    runner: (await import("./runner.mjs")).runCommand, now: () => Date.now(),
    onProgress,
    // forge#3835: phase_attempt / run_terminal records reach GitHub so `forgedock stats` works from any machine.
    emitTelemetry: deps.emitTelemetry ?? makeEmitTelemetry({ repo }),
    // Only forwarded when explicitly provided — omitting them preserves
    // runIssue's/runner.mjs's existing defaults (forge#2028).
    ...(backend ? { backend } : {}),
    ...(model ? { model } : {}),
    ...(readCiPendingMaxMinutes() ? { ciPendingMaxMinutes: readCiPendingMaxMinutes() } : {}),
    ...(retry ? { retry: true } : {}),
    ...(waitLease ? { waitLease: true } : {}) });
  console.log(`issue #${issue} → ${res.terminalReason}`);
  if (res.terminalReason === "deferred") {
    // forge#3574: say WHY (holder + expiry); the empty-log diagnostics add nothing.
    console.log(res.detail ?? "run deferred: another holder owns the lease");
    return res;
  }
  if (res.terminalReason === "not-retryable") {
    console.log(res.detail ?? "run is not retryable");
    return res;
  }
  // forge#3932: refused before any state write (open or unreadable **Depends on**); nothing ran.
  if (res.terminalReason === "dependency-open" || res.terminalReason === "dependency-unreadable" || res.code === "path.switch_conflict") {
    console.log(res.detail ?? "run refused: dependency check");
    return res;
  }
  // forge#2175: a non-success termination previously printed nothing beyond
  // the bare reason above — the actual failing phase/attempt/reason was only
  // recoverable by manually reading ~/.forge/runs/{issue}.jsonl and then the
  // engine source. Print it here instead, reconstructed from the same
  // run-log runIssue() just wrote. Skipped for "merged" (the success case)
  // to avoid regressing/cluttering the existing happy-path output.
  if (res.terminalReason !== "merged") {
    console.log(formatTerminalDiagnostics(dir, issue, logRepo));
  } else {
    // forge#2399: formatTerminalDiagnostics() (and its phase/reason/state
    // block) intentionally stays gated to non-merged outcomes above, but the
    // aggregate token-usage total should print for "total tokens per run" to
    // hold on the common success case too — surface just the usage line here
    // rather than the full diagnostic block.
    try {
      const usageLine = formatUsageLine(aggregateUsage(readLog(dir, issue, { repo: logRepo })));
      if (usageLine) console.log(usageLine);
    } catch {
      // Corrupt/unreadable log — degrade silently, same as formatTerminalDiagnostics.
    }
  }
  return res;
}

/**
 * `forgedock resume-stalled [--dry-run] [--lane <lane>] [--repo <owner/repo>]`
 *
 * Enumerates all open issues carrying non-terminal workflow labels, reads each
 * issue's FORGE:STATE block via the projector, identifies those with an expired
 * lease (stalled), and re-dispatches them through the existing run-issue path.
 *
 * Flags:
 *   --dry-run   Print the stalled list and exit 0 without dispatching anything.
 *   --lane      Optional lane assertion passed to run-issue. Omit it to let each issue's lane be worked out from
 *               its milestone (#4125); the default branch is refused.
 *   --repo      GitHub repo (owner/repo). Must match the repo `gh` resolves by default
 *               (the cwd git remote) — cross-repo dispatch is refused (forge#1593),
 *               since state reads/writes are cwd-scoped and would otherwise silently
 *               target the wrong repo. Omit --repo to operate on the cwd-resolved repo.
 *
 * Per-issue dispatch failures are caught and isolated — one issue's engine error
 * (e.g. NO_API_KEY/NO_SDK or any other uncaught phase error from runIssue) does
 * not abort dispatch of the remaining stalled issues in the batch. Failures are
 * recorded in the returned `failed` array; the caller decides how to surface them.
 *
 * @param {string[]} argv
 * @param {{io?: {gh: Function}, dispatch?: (argv: string[]) => Promise<any>}} [deps]
 *   Injectable for tests — defaults to real `gh`/`git` (makeIo()) and the real
 *   `runFromCli` dispatcher.
 */
export async function resumeStalledFromCli(argv, deps = {}) {
  const dryRun = argv.includes("--dry-run");
  const lane   = flag(argv, "--lane");
  if (argv.includes("--lane") && (!lane || lane.startsWith("--"))) throw new Error("--lane requires a value: staging or milestone/<slug>");
  const repo   = flag(argv, "--repo");

  const io = deps.io ?? makeIo();
  await assertRepoMatchesCwd(io, repo, { sleep: deps.sleep });
  await assertLaneNotDefault(io, lane, repo);
  const dispatch = deps.dispatch ?? runFromCli;
  const projector = makeProjector(io);
  const now = Date.now();

  // Collect candidate issue numbers from all non-terminal workflow labels
  // (ACTIVE_WORKFLOW_LABELS — shared with countEngineActivity() so both
  // surfaces agree on what "in-flight" means).
  const repoFlag = repo ? ["--repo", repo] : [];
  const issueSet = new Set();

  for (const label of ACTIVE_WORKFLOW_LABELS) {
    try {
      const out = await io.gh([
        "issue", "list",
        ...repoFlag,
        "--state", "open",
        "--label", label,
        "--limit", "100",
        "--json", "number",
      ]);
      const items = JSON.parse(out);
      for (const { number } of items) issueSet.add(number);
    } catch {
      // gh may return non-zero when no issues match — treat as empty.
    }
  }

  if (issueSet.size === 0) {
    console.log("resume-stalled: no in-flight issues found.");
    return { stalled: [], dispatched: [], failed: [] };
  }

  const candidates = [...issueSet];
  const stalled = await scanStalls(candidates, projector, now);

  if (stalled.length === 0) {
    console.log("resume-stalled: all in-flight issues have active leases — nothing stalled.");
    return { stalled: [], dispatched: [], failed: [] };
  }

  console.log(`resume-stalled: ${stalled.length} stalled issue(s) found: ${stalled.map((n) => `#${n}`).join(", ")}`);

  if (dryRun) {
    console.log("resume-stalled: --dry-run — not dispatching.");
    return { stalled, dispatched: [], failed: [] };
  }

  const dispatched = [];
  const failed = [];
  for (const issue of stalled) {
    console.log(`resume-stalled: dispatching #${issue} …`);
    try {
      await dispatch([String(issue), ...(lane ? ["--lane", lane] : []), ...(repo ? ["--repo", repo] : [])]);
      dispatched.push(issue);
    } catch (err) {
      const message = err?.message ?? String(err);
      console.error(`resume-stalled: #${issue} failed: ${message}`);
      failed.push({ issue, error: message });
    }
  }

  if (failed.length > 0) {
    console.log(
      `resume-stalled: ${dispatched.length} dispatched, ${failed.length} failed: ` +
        `${failed.map((f) => `#${f.issue}`).join(", ")}`,
    );
  }

  return { stalled, dispatched, failed };
}

function flag(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }

/**
 * `forgedock orchestrate <issue...> [--parallel K] [--lane L] [--lane-override] [--repo owner/repo] [--no-prefilter]`
 * `forgedock orchestrate --resume <batch-id> [issue...]` · `forgedock orchestrate --set-parallel <batch-id> <K>` · `forgedock orchestrate --add <batch-id> <issue...>`
 * `forgedock orchestrate --cancel <batch-id>`
 * Runs core work-on per issue with K concurrency (default 3), honouring `Depends on` / `Blocked by` among the given issues.
 * A `dependency-open` issue is requeued behind its dependency; a `decomposed` one adds its sub-issues (#4124).
 * The already-fixed pre-filter (#4123) runs before each lane unless `--no-prefilter`. Every start, requeues included, first
 * checks GitHub (#4481, `makeDispatchCheck`): a closed issue or a merged `feat/issue-N-lean` PR ends the row without a lane.
 * Declared acceptance probes (#4399, `lean/probe.mjs`) are swept once at batch start unless `--no-probes`.
 * Each issue gets its own lane, worked out from its milestone (#4125); `--lane` is an assertion checked per issue (a
 * mismatch ends `lane-refused`). Dependency edges between lanes are printed before any lane starts. Prints a summary table.
 * Durable (#4121): the batch is kept in `~/.forge/batches/<id>/` and each lane is a detached `run-issue` process, so
 * `--resume <id>` continues after the dispatcher dies, re-adopting live lanes. `deferred` lanes are requeued by code,
 * forge.yaml `orchestration.breaker` ({errors, window_min}, default 3 in 30) stops admissions on an engine-error
 * burst, and `--set-parallel <id> K` changes K of a running batch.
 * Maintenance budget (#4197), only with forge.yaml `maintenance.enabled: true` (or `deps.maintenance`): open issues carrying
 * a `maintenance.labels` label join the batch, each issue is classified from its labels (maintenance; `priority:P<n>`,
 * unlabelled = P2) and admission reserves `maintenance.share` of lane starts for maintenance (`when_idle` drains the rest).
 * Host lane registry (#4191): every lane takes a slot in `~/.forge/sched/` (or `FORGEDOCK_SCHED_DIR`), capped host-wide by
 * `forgedock sched cap N` or forge.yaml `orchestration.global_parallel`; each issue's priority comes from its
 * `priority:P<n>` / `P<n>` labels (unlabelled = P2), read in the same gh call as its body.
 * Host scheduler (#4192): the batch runs in the `forgedock schedd` daemon (auto-spawned, `lean/schedd.mjs`), one process
 * for every batch on the host. This command submits it and streams the rows; Ctrl-C detaches and the batch keeps
 * running; `--resume <id>` reattaches (or replays the report of a finished batch); `--set-parallel` goes through the
 * daemon. `--foreground` or `FORGEDOCK_SCHEDD=0` runs the batch in this process as before (also for injected test deps).
 * `--add <id> N...` (#4408) adds issues to that batch instead of starting a second one: they run under its K and DAG
 * (a running batch picks them up on its next pass, a stopped one on its next `--resume`); `--resume <id> N...` adds N too.
 * `--requeue <id> N... [--reason]` (#4550) returns a terminal issue (and the dependents skipped behind it) to pending after an operator decision.
 * `--cancel <id>` (#4376) stops that one batch, never the shared daemon: it admits nothing more, its running local lanes get
 * SIGTERM (their teardown saves the work), remote lanes run to their result and the rest end `held`; `--resume <id>` continues it.
 */
export async function orchestrateFromCli(argv, deps = {}) {
  const inProcess = deps.inProcess || deps.leanModule || deps.laneScript || deps.batchRoot || deps.leanIo
    || argv.includes("--foreground") || process.env.FORGEDOCK_SCHEDD === "0";
  if (inProcess) return runBatch({ argv: argv.filter((a) => a !== "--foreground"), cwd: process.cwd(), env: process.env, sink: consoleSink(), deps });
  return orchestrateClient(argv, deps);
}

const formatRowLine = (r) => (r.issue == null ? `${r.outcome}: ${r.detail}` : `#${r.issue} → ${r.waiting && /^dependency #(\d+) /.test(r.detail ?? "") ? `waiting on #${/^dependency #(\d+) /.exec(r.detail)[1]}` : r.outcome}${r.detail && r.outcome !== "merged" ? ` (${r.detail})` : ""}`);
const consoleSink = () => ({ batch: () => {}, row: (r) => console.log(formatRowLine(r)), line: (t) => console.log(t) });

/** forge.yaml `orchestration.env_passthrough` / `path_exclude` (comma-separated) and `execution.token_env` (#4691): what the pinned env keeps beyond the allowlist. */
function readPinnedEnvConfig(cwd) {
  try {
    const y = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"));
    const list = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const tok = String(y?.execution?.token_env ?? "").trim();
    return { passthrough: [...list(y?.orchestration?.env_passthrough), ...(/^[A-Za-z_][A-Za-z0-9_]*$/.test(tok) ? [tok] : [])], pathExclude: list(y?.orchestration?.path_exclude) };
  } catch { return { passthrough: [], pathExclude: [] }; }
}

/** `--show-env <id>` (secrets redacted), `--set-env <id> KEY=VAL`, `--unset-env <id> KEY` (#4691): edits the batch's pinned env in plan.json; newly launched lanes read it. */
async function envBatch({ argv, root, print = (l) => console.log(l) }) {
  const op = ["--show-env", "--set-env", "--unset-env"].find((f) => argv.includes(f));
  const i = argv.indexOf(op), id = argv[i + 1], arg = argv[i + 2];
  if (!id || id.startsWith("--") || (op !== "--show-env" && !arg)) throw new Error(ORCH_USAGE);
  const batchMod = await import("./lean/batch.mjs"), { redactEnv } = await import("./lean/schedd.mjs");
  if (op === "--set-env" && batchMod.SECRET_ENV.test(arg.split("=")[0])) throw new Error(`--set-env: ${arg.split("=")[0]} looks like a secret and is never stored in batch state; set it in the daemon's environment (or keychain) instead`);
  const b = batchMod.openBatch(root, id);
  const plan = b.readPlan();
  if (!plan) throw new Error(`no batch ${id} in ${root}`);
  if (op === "--show-env") {
    const env = redactEnv(plan.env);
    print(plan.env ? Object.entries(env).sort(([a], [c]) => (a < c ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n") : `batch ${id}: pins no env (its lanes use the daemon's)`);
    return { ok: true, batch: id, env };
  }
  const env = { ...(plan.env ?? {}) };
  if (op === "--set-env") {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(arg);
    if (!m) throw new Error("--set-env needs KEY=VAL");
    env[m[1]] = m[2];
    print(`batch ${id}: set ${m[1]} (applies to newly launched lanes)`);
  } else {
    delete env[arg];
    print(`batch ${id}: unset ${arg} (applies to newly launched lanes)`);
  }
  b.writePlan({ ...plan, env });
  return { ok: true, batch: id };
}

const ORCH_USAGE = "usage: forgedock orchestrate <issue...> [--parallel K] [--lane L] [--lane-override] [--force <reason>] [--repo owner/repo] | --resume <id> [issue...] | --set-parallel <id> <K> | --clear-breaker <id> | --add <id> <issue...> | --requeue <id> <issue...> [--reason <text>] | --cancel <id> [--stop-remote] | --hold <id> <issue...> | --release <id> <issue...> | --show-env <id> | --set-env <id> KEY=VAL | --unset-env <id> KEY";
const ORCH_VALUED = ["--parallel", "--lane", "--repo", "--model", "--prefilter-model", "--reason", "--force"];
const issuesOf = (argv) => {
  const issues = [];
  for (let i = 0; i < argv.length; i++) {
    if (ORCH_VALUED.includes(argv[i])) { i++; continue; }
    if (/^#?\d+$/.test(argv[i])) issues.push(parseInt(argv[i].replace("#", ""), 10));
  }
  return issues;
};
/** #4469: the operands among `tokens` (`--add`/`--resume` extras): no flags, and no value of a valued flag (`--parallel 5` is not issue #5). */
const operandsOf = (tokens) => {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (ORCH_VALUED.includes(tokens[i])) { i++; continue; }
    if (!String(tokens[i]).startsWith("--")) out.push(tokens[i]);
  }
  return out;
};
const parallelOf = (argv) => {
  const parallel = flag(argv, "--parallel") == null ? 3 : parseInt(flag(argv, "--parallel"), 10);
  if (!Number.isInteger(parallel) || parallel < 1) throw new Error("--parallel must be a positive integer");
  return parallel;
};

/**
 * #4773: the `Blocked by` / `Depends on` edges the added issues imply: declaration lines of a trusted body whose target is still open
 * (a closed or unreadable target is a no-op, the scheduler skips it too). @returns {{from:number,to:number}[]}
 */
async function addedEdges({ added, records, io, repo }) {
  const edges = [], seen = new Map();
  for (const n of added) {
    const rec = records.get(n);
    if (!rec || !bodyTrusted(rec)) continue;
    for (const d of parseDependsOn(rec.body, n)) {
      if (!seen.has(d)) {
        let st = null;
        try { st = JSON.parse(await io.gh(["issue", "view", String(d), ...(repo ? ["-R", repo] : []), "--json", "state"]))?.state ?? null; } catch { st = null; }
        seen.set(d, st);
      }
      if (seen.get(d) === "OPEN") edges.push({ from: n, to: d });
    }
  }
  return edges;
}

/**
 * #4408: add `tokens` to batch `id`. Not a plain integer: skipped; not OPEN on the batch's repo (`gh issue view --json
 * state`): skipped `closed` (`unreadable` when the read fails); the rest go to the batch's `add` file, through the daemon
 * when `viaDaemon(issues)` answers (non-null), else written here (batch.mjs `addIssues` skips issues already in the batch).
 */
async function addToBatch({ id, tokens, root, io, viaDaemon = null, print = (l) => console.log(l) }) {
  const batchMod = await import("./lean/batch.mjs");
  const b = batchMod.openBatch(root, id);
  if (!b.exists()) throw new Error(`no batch ${id} in ${root}`);
  const repo = b.readPlan()?.repo ?? null;
  const skipped = [], ints = [], state = new Map(), records = new Map();
  for (const t of tokens) {
    if (/^#?\d+$/.test(String(t))) ints.push(parseInt(String(t).replace("#", ""), 10));
    else skipped.push({ issue: t, reason: "not an integer" });
  }
  for (const n of new Set(ints)) {
    let st = null;
    let v = null;
    try { v = JSON.parse(await io.gh(["issue", "view", String(n), ...(repo ? ["-R", repo] : []), "--json", "state,body,author,authorAssociation"])); st = v?.state ?? null; } catch { st = null; }
    state.set(n, st); records.set(n, v);
  }
  const open = [];
  for (const n of ints) {
    const st = state.get(n);
    if (st === "OPEN") open.push(n);
    else if (!skipped.some((x) => x.issue === n)) skipped.push({ issue: n, reason: st ? "closed" : "unreadable" });
  }
  let res = { added: [], skipped: [], requeued: [] };
  if (open.length) {
    res = (viaDaemon ? await viaDaemon(open) : null) ?? b.addIssues(open);
    if (res.reopened === undefined && res.requeued?.length && b.readReport()) b.clearReport(); // #4687: no daemon: the next --resume reruns it
  }
  const out = { ok: true, batch: id, added: res.added ?? [], requeued: res.requeued ?? [], skipped: [...(res.skipped ?? []), ...skipped] };
  out.edges = await addedEdges({ added: out.added, records, io, repo }); // #4773
  print(`batch ${id}: added ${out.added.map((n) => `#${n}`).join(" ") || (out.requeued.length ? "" : "(none)")}${out.requeued.length ? `${out.added.length ? " " : ""}${out.requeued.map((n) => `requeued #${n}`).join(" ")}` : ""}${out.skipped.length ? `; skipped ${out.skipped.map((x) => `${/^\d+$/.test(String(x.issue)) ? "#" : ""}${x.issue} (${x.reason})`).join(", ")}` : ""}`);
  if (out.edges.length) print(`batch ${id}: edges ${out.edges.map((e) => `#${e.from} blocked by #${e.to}`).join(", ")}`);
  return out;
}

/** #4592: a resume's release line, only when it freed something. */
const onlyReleased = (l, out = (t) => console.log(t)) => { if (!l.endsWith("(none)")) out(l); };

/**
 * `--hold <id> N...` / `--release <id> N...` (#4592): the batch's `hold` file, through the daemon (`viaDaemon(op, issues)`, null
 * when none runs) or directly. A held issue is not admitted (a running lane is not stopped); `--release` (or a `--resume` that
 * names it) lets it run again. @returns {{ok, batch, changed:number[]}}
 */
async function holdBatch({ op, id, tokens, root, viaDaemon = null, print = (l) => console.log(l) }) {
  const issues = tokens.filter((t) => /^#?\d+$/.test(String(t))).map((t) => parseInt(String(t).replace("#", ""), 10));
  if (!id || String(id).startsWith("--") || !issues.length) throw new Error(ORCH_USAGE);
  let res = viaDaemon ? await viaDaemon(op, issues) : null;
  if (!res) {
    const b = (await import("./lean/batch.mjs")).openBatch(root, id);
    if (!b.exists()) throw new Error(`no batch ${id} in ${root}`);
    res = { changed: op === "hold" ? b.holdIssues(issues) : b.releaseIssues(issues) };
  }
  const list = (res.changed ?? []).map((n) => `#${n}`).join(" ") || "(none)";
  print(op === "hold" ? `batch ${id}: held ${list}; forgedock orchestrate --release ${id} <issue...> (or --resume ${id} <issue...>) re-admits them`
    : `batch ${id}: released ${list}`);
  return { ok: true, batch: id, changed: res.changed ?? [] };
}

/**
 * `--requeue <id> N... [--reason "..."]` (#4550): after an operator decision, a terminal issue of the batch (and the dependents
 * skipped behind it) goes back to pending. Closed issues and issues still labelled `needs-human` are refused before anything is
 * written. Through the daemon (`viaDaemon`, null when none runs: the batch's `requeue` file, and a finished batch's report is
 * cleared so `--resume` runs it again). The runner applies the entries and posts the FORGE:DECISION.
 */
async function requeueBatch({ id, tokens, reason, root, io, viaDaemon = null, print = (l) => console.log(l) }) {
  if (!id || String(id).startsWith("--") || !tokens.length) throw new Error(ORCH_USAGE);
  const batchMod = await import("./lean/batch.mjs");
  const b = batchMod.openBatch(root, id);
  if (!b.exists()) throw new Error(`no batch ${id} in ${root}`);
  const repo = b.readPlan()?.repo ?? null;
  const refused = [], open = [];
  for (const t of tokens) {
    if (!/^#?\d+$/.test(String(t))) { refused.push({ issue: t, reason: "not an integer" }); continue; }
    const n = parseInt(String(t).replace("#", ""), 10);
    if (open.includes(n) || refused.some((x) => x.issue === n)) continue;
    let v = null;
    try { v = JSON.parse(await io.gh(["issue", "view", String(n), ...(repo ? ["-R", repo] : []), "--json", "state,labels"])); } catch { v = null; }
    if (!v) refused.push({ issue: n, reason: "unreadable" });
    else if (v.state !== "OPEN") refused.push({ issue: n, reason: "closed" });
    else if ((v.labels ?? []).some((l) => (l?.name ?? l) === "needs-human")) refused.push({ issue: n, reason: "still labelled needs-human: record the decision and remove the label first" });
    else open.push(n);
  }
  const why = reason || "operator decision", by = "operator";
  let res = { requeued: [], refused: [] };
  if (open.length) {
    res = (viaDaemon ? await viaDaemon(open, why, by) : null) ?? b.requeue(open, { reason: why, by });
    if (res.reopened === undefined && res.requeued?.length && b.readReport()) b.clearReport(); // no daemon: the next --resume reruns it
  }
  const out = { ok: true, batch: id, requeued: res.requeued ?? [], refused: [...(res.refused ?? []), ...refused] };
  print(`batch ${id}: ${out.requeued.map((n) => `requeued #${n}`).join(" ") || "requeued (none)"}${out.refused.length ? `; refused ${out.refused.map((x) => `${/^\d+$/.test(String(x.issue)) ? "#" : ""}${x.issue} (${x.reason})`).join(", ")}` : ""}`);
  return out;
}

/**
 * `--cancel <id>` (#4376): through the daemon (`viaDaemon`, null when none runs) or the batch's `cancel` file directly.
 * A finished batch (report written) is left alone.
 */
async function cancelBatch({ id, root, stopRemote = false, viaDaemon = null, print = (l) => console.log(l) }) {
  if (!id || String(id).startsWith("--")) throw new Error(ORCH_USAGE);
  let res = viaDaemon ? await viaDaemon() : null;
  if (!res) {
    const b = (await import("./lean/batch.mjs")).openBatch(root, id);
    if (!b.exists()) throw new Error(`no batch ${id} in ${root}`);
    if (b.readReport()) res = { cancelled: false, finished: true };
    else { b.requestCancel({ reason: "operator", stopRemote }); res = { cancelled: true }; }
  }
  print(res.cancelled ? `batch ${id}: cancel requested; running lanes stop through their teardown${stopRemote ? " (remote sandboxes too, #4612)" : ""}, the rest stay held (forgedock orchestrate --resume ${id} continues)`
    : `batch ${id}: already finished`);
  return { ok: true, batch: id, cancelled: !!res.cancelled };
}

/**
 * Daemon client (#4192): argument checks here, then submit / attach / set-parallel over the schedd socket. Prints the
 * streamed rows and lines like the in-process run and returns the same `{rows, crossLane, batch, ok}`.
 */
async function orchestrateClient(argv, deps = {}) {
  const schedd = await import("./lean/schedd.mjs");
  const dir = deps.scheddDir ?? (await import("./lean/sched.mjs")).schedDir();
  const connect = () => schedd.connectDaemon({ dir, ...(deps.spawnDaemon !== undefined ? { spawnDaemon: deps.spawnDaemon } : {}), ...(deps.waitMs ? { waitMs: deps.waitMs } : {}) });
  if (argv.includes("--set-parallel")) {
    const i = argv.indexOf("--set-parallel");
    const id = argv[i + 1], k = Number(argv[i + 2]);
    if (!Number.isInteger(k) || k < 1) throw new Error("parallel must be a positive integer");
    let sock = null;
    try { sock = await schedd.connectDaemon({ dir, spawnDaemon: null }); } catch { sock = null; }
    if (sock) await schedd.request(sock, { op: "set-parallel", id, k });
    else {
      // No daemon: the batch is not running anywhere; the parallel file is all there is to change.
      const batchMod = await import("./lean/batch.mjs");
      const b = batchMod.openBatch(batchMod.batchRoot(), id);
      if (!b.exists()) throw new Error(`no batch ${id} in ${batchMod.batchRoot()}`);
      b.setParallel(k);
    }
    console.log(`batch ${id}: parallel set to ${k}`);
    return { ok: true, batch: id, parallel: k };
  }
  // #4408: --add, and the extra issues of --resume <id> N..., go to the batch (through the daemon when one runs).
  const addVia = (id) => async (issues) => {
    let sock = null;
    try { sock = await schedd.connectDaemon({ dir, spawnDaemon: null }); } catch { sock = null; }
    return sock ? schedd.request(sock, { op: "add", id, issues }) : null;
  };
  const requeueVia = (id) => async (issues, reason, by) => {
    let sock = null;
    try { sock = await schedd.connectDaemon({ dir, spawnDaemon: null }); } catch { sock = null; }
    return sock ? schedd.request(sock, { op: "requeue", id, issues, reason, by }) : null;
  };
  const holdVia = (id) => async (op, issues) => {
    let sock = null;
    try { sock = await schedd.connectDaemon({ dir, spawnDaemon: null }); } catch { sock = null; }
    return sock ? schedd.request(sock, { op, id, issues }) : null;
  };
  const batchRootOf = async () => (await import("./lean/batch.mjs")).batchRoot();
  if (["--show-env", "--set-env", "--unset-env"].some((f) => argv.includes(f))) return envBatch({ argv, root: await batchRootOf() });
  if (argv.includes("--clear-breaker")) return runBatch({ argv, deps, sink: consoleSink() });
  if (argv.includes("--cancel")) {
    const id = flag(argv, "--cancel");
    return cancelBatch({ id, root: await batchRootOf(), stopRemote: argv.includes("--stop-remote"), viaDaemon: async () => {
      let sock = null;
      try { sock = await schedd.connectDaemon({ dir, spawnDaemon: null }); } catch { sock = null; }
      return sock ? schedd.request(sock, { op: "cancel", id, stopRemote: argv.includes("--stop-remote") }) : null;
    } });
  }
  if (argv.includes("--requeue")) {
    const i = argv.indexOf("--requeue"), id = argv[i + 1];
    return requeueBatch({ id, tokens: operandsOf(argv.slice(i + 2)), reason: flag(argv, "--reason"), root: await batchRootOf(), io: deps.io ?? makeIo(), viaDaemon: requeueVia(id) });
  }
  for (const op of ["hold", "release"]) if (argv.includes(`--${op}`)) {
    const id = flag(argv, `--${op}`);
    return holdBatch({ op, id, tokens: operandsOf(argv.slice(argv.indexOf(`--${op}`) + 2)), root: await batchRootOf(), viaDaemon: holdVia(id) });
  }
  if (argv.includes("--add")) {
    const i = argv.indexOf("--add"), id = argv[i + 1];
    if (!id || i + 2 >= argv.length) throw new Error(ORCH_USAGE);
    return addToBatch({ id, tokens: operandsOf(argv.slice(i + 2)), root: await batchRootOf(), io: deps.io ?? makeIo(), viaDaemon: addVia(id) });
  }
  const resumeId = flag(argv, "--resume");
  const resumeExtra = resumeId ? operandsOf(argv.slice(argv.indexOf("--resume") + 2)) : [];
  if (resumeExtra.length) {
    await addToBatch({ id: resumeId, tokens: resumeExtra, root: await batchRootOf(), io: deps.io ?? makeIo(), viaDaemon: addVia(resumeId) });
    await holdBatch({ op: "release", id: resumeId, tokens: resumeExtra, root: await batchRootOf(), viaDaemon: holdVia(resumeId), print: (l) => onlyReleased(l) }); // #4592: a named, held issue is re-admitted
  }
  let msg;
  if (resumeId) msg = { op: "attach", id: resumeId, resume: true };
  else {
    if (!issuesOf(argv).length) throw new Error(ORCH_USAGE);
    parallelOf(argv);
    let sub = [...argv];
    if (!flag(sub, "--repo")) {
      const repo = await resolveDefaultRepo(deps.io ?? makeIo());
      if (!repo) throw new Error("orchestrate needs the repo: pass --repo or run inside a checkout with a GitHub remote");
      sub = [...sub, "--repo", repo];
    }
    const pinned = schedd.batchEnv(process.env, readPinnedEnvConfig(process.cwd()));
    const dropped = schedd.droppedEnv(process.env, pinned);
    if (dropped.length) console.log(`orchestrate: not pinned into the batch (lanes use the daemon's env or resolve them at lane start): ${dropped.join(", ")}; name them in forge.yaml orchestration.env_passthrough to pin them`);
    msg = { op: "submit", argv: sub, cwd: process.cwd(), env: pinned };
  }
  let sock = await connect(), req = msg, reattached = false, losses = 0;
  let id = resumeId;
  const onMsg = (m) => {
    if (m.type === "batch") id = m.id;
    else if (m.type === "row") { if (!(reattached && m.replay)) console.log(formatRowLine(m.row)); }
    else if (m.type === "line") console.log(m.text);
    else if (m.type === "done" && m.replay && m.report) console.log(m.report);
  };
  // #4503: when the daemon dies mid-batch, reconnect (spawning one unless `spawnDaemon: null`) and re-attach, within `reconnectMs`.
  const reconnectMs = deps.reconnectMs ?? 60_000, sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (;;) {
    try {
      return (await schedd.request(sock, req, onMsg)).result;
    } catch (e) {
      if (!id || !(/closed the connection/.test(e?.message ?? "") || ["ECONNRESET", "EPIPE"].includes(e?.code))) throw e;
      const giveUp = () => new Error(`${e.message}; the batch keeps its state: forgedock orchestrate --resume ${id}`);
      if (++losses > 10) throw giveUp();
      console.log(`schedd connection lost; reconnecting to batch ${id}`);
      const end = Date.now() + reconnectMs;
      for (sock = null; !sock;) {
        try { sock = await connect(); } catch {
          if (Date.now() >= end) throw giveUp();
          await sleep(250);
        }
      }
      req = { op: "attach", id };
      reattached = true;
    }
  }
}

/**
 * One batch from start to report, in this process: the in-process `orchestrate` path and the schedd daemon's per-batch
 * runner (#4192). `cwd` and `env` are the submitting client's (`env` picks the lanes' account); output goes to `sink`
 * (`batch(b)` once the batch exists, `row(r)` per update, `line(text)` otherwise). A daemon-hosted batch records
 * `daemon: true` and the allowlisted env in its plan, so a restarted daemon resumes it on the same account; `keepBreaker`
 * (a daemon restart, not the operator's resume) leaves a tripped breaker tripped. Writes `report.json` when done.
 */
export async function runBatch({ argv, cwd: callerCwd = process.cwd(), env: callerEnv = process.env, sink = consoleSink(), deps = {}, keepBreaker = false, daemon = false, signal = null }) {
  const batchMod = await import("./lean/batch.mjs");
  const root = deps.batchRoot ?? batchMod.batchRoot();
  if (argv.includes("--clear-breaker")) {
    // #4685: close a tripped breaker without editing state.json; the next --resume (or a running batch's next save) starts closed.
    const b = batchMod.openBatch(root, flag(argv, "--clear-breaker"));
    if (!b.exists()) throw new Error(`no batch ${flag(argv, "--clear-breaker")} in ${root}`);
    const st = b.store.load();
    if (st) b.store.save({ ...st, breaker: null, errorTimes: [] });
    sink.line(`batch ${b.id}: ${st?.breaker ? "breaker cleared" : "no breaker was tripped"}`);
    return { ok: true, batch: b.id, cleared: Boolean(st?.breaker) };
  }
  if (argv.includes("--set-parallel")) {
    const i = argv.indexOf("--set-parallel");
    const b = batchMod.openBatch(root, argv[i + 1]);
    if (!b.exists()) throw new Error(`no batch ${argv[i + 1]} in ${root}`);
    const k = Number(argv[i + 2]);
    b.setParallel(k);
    sink.line(`batch ${b.id}: parallel set to ${k}`);
    return { ok: true, batch: b.id, parallel: k };
  }
  if (["--show-env", "--set-env", "--unset-env"].some((f) => argv.includes(f))) return envBatch({ argv, root, print: (l) => sink.line(l) });
  if (argv.includes("--cancel")) return cancelBatch({ id: flag(argv, "--cancel"), root, stopRemote: argv.includes("--stop-remote"), print: (l) => sink.line(l) });
  if (argv.includes("--requeue")) {
    const i = argv.indexOf("--requeue");
    return requeueBatch({ id: argv[i + 1], tokens: operandsOf(argv.slice(i + 2)), reason: flag(argv, "--reason"), root, io: deps.io ?? makeIo(), print: (l) => sink.line(l) });
  }
  for (const op of ["hold", "release"]) if (argv.includes(`--${op}`)) {
    return holdBatch({ op, id: flag(argv, `--${op}`), tokens: operandsOf(argv.slice(argv.indexOf(`--${op}`) + 2)), root, print: (l) => sink.line(l) });
  }
  if (argv.includes("--add")) {
    const i = argv.indexOf("--add");
    if (!argv[i + 1] || i + 2 >= argv.length) throw new Error(ORCH_USAGE);
    return addToBatch({ id: argv[i + 1], tokens: operandsOf(argv.slice(i + 2)), root, io: deps.io ?? makeIo(), print: (l) => sink.line(l) });
  }
  const resumeId = flag(argv, "--resume");
  const resumeExtra = resumeId ? operandsOf(argv.slice(argv.indexOf("--resume") + 2)) : [];
  if (resumeExtra.length) {
    await addToBatch({ id: resumeId, tokens: resumeExtra, root, io: deps.io ?? makeIo(), print: (l) => sink.line(l) });
    await holdBatch({ op: "release", id: resumeId, tokens: resumeExtra, root, print: (l) => onlyReleased(l, (t) => sink.line(t)) }); // #4592
  }
  let batch, plan = null;
  if (resumeId) {
    batch = batchMod.openBatch(root, resumeId);
    batch.scrubPlan(); // #4787: a pre-fix plan.json keeps no secret; the lanes re-read it from the environment
    plan = batch.readPlan();
    if (!plan) throw new Error(`no batch ${resumeId} in ${root}`);
    argv = plan.argv;
  }
  const issues = issuesOf(argv);
  if (!issues.length) throw new Error(ORCH_USAGE);
  const parallel = parallelOf(argv);
  // The lanes' env: a resumed daemon batch uses the env its plan kept, over the daemon's own.
  // A pre-#4192 batch resumed by the daemon kept no env: its lanes use the daemon's.
  // #4691: a fresh pin is allowlisted and PATH-sanitised again here (idempotent for a client that already did it).
  const scheddMod = await import("./lean/schedd.mjs");
  const kept = plan?.env ?? (resumeId ? null : daemon || callerEnv !== process.env ? scheddMod.batchEnv(callerEnv, readPinnedEnvConfig(plan?.cwd ?? callerCwd)) : null);
  const env = kept ? scheddMod.mergeEnv(process.env, kept) : process.env;
  const lane = flag(argv, "--lane");
  const laneOverride = argv.includes("--lane-override");
  const model = flag(argv, "--model");
  const io = deps.io ?? makeIo();
  const repo = flag(argv, "--repo") ?? plan?.repo ?? (await resolveDefaultRepo(io));
  if (!repo) throw new Error("orchestrate needs the repo: pass --repo or run inside a checkout with a GitHub remote");
  const cwd = plan?.cwd ?? callerCwd;
  await assertLaneNotDefault(io, lane, repo, cwd);
  if (!deps.allowTmpfs && process.env.FORGEDOCK_BATCH_ALLOW_TMPFS !== "1") batchMod.assertDiskPath(root);
  if (!batch) {
    // #4659: a milestone start is refused unless every dependency of its issues is merged into its lane, or --force <reason>
    const force = flag(argv, "--force");
    if (argv.includes("--force") && (!force || force.startsWith("--"))) throw new Error("--force requires a reason: --force \"<why the unmet dependencies are acceptable>\"");
    if (!force) {
      const { unmetDependencies } = await import("../scripts/plan-validate-live.mjs");
      const gateBranches = readBranches(cwd);
      const gateIo = deps.leanIo ?? (await import("./lean/effects.mjs")).makeLeanIo({ repo });
      const unmet = await unmetDependencies({ issues, repo, gh: io.gh, baseOf: async (n) => {
        const r = await resolveLane({ issue: n, repo, io: gateIo, cwd, branches: gateBranches, requested: lane, override: laneOverride });
        return r.ok ? r.lane : null;
      } });
      if (unmet.length) throw new Error(`parallel milestone start refused: ${unmet.map((u) => `#${u.issue} depends on #${u.dep} (${u.why}; base ${u.base})`).join("; ")}. Merge the dependencies first, or pass --force "<reason>".`);
    }
    const base = deps.batchId ?? batchMod.newBatchId();
    batch = batchMod.openBatch(root, base);
    for (let i = 2; batch.exists(); i++) batch = batchMod.openBatch(root, `${base}.${i}`); // never resume by accident
    plan = { v: 1, id: batch.id, argv: [...argv], repo, cwd, created: new Date().toISOString(), ...(force ? { forced: force } : {}), ...(daemon ? { daemon: true, env: kept } : {}) };
    batch.writePlan(plan);
    batch.setParallel(parallel);
  } else {
    // A resume is the operator's decision to continue: the breaker starts closed again.
    const st = batch.store.load();
    if (st && (!keepBreaker || st.breaker?.transport)) batch.store.save({ ...st, breaker: null, errorTimes: [] });
    if (!keepBreaker) batch.clearCancel(); // #4376: the operator's resume continues a cancelled batch
    if (daemon && !plan.daemon) batch.writePlan({ ...plan, daemon: true }); // a daemon restart resumes it from now on
    batch.clearReport();
  }
  sink.batch?.(batch);
  sink.line(`batch: ${batch.id} (${batch.dir}); resume with: forgedock orchestrate --resume ${batch.id}`);
  const dir = deps.dir ?? runDir();
  migrateRunLogs(dir); // #4432: split legacy per-issue logs by repo before any lane runs (best effort, never throws)
  const { orchestrate, formatTable, formatWaitSummary, formatSandboxSummary, formatOutcomeLists, formatAlertLines, estimateLaneMinutes, laneHistory, formatEstimateSummary } = await import("./lean/orchestrate.mjs");
  const { formatPrecheckSummary } = await import("./lean/precheck.mjs");
  const { formatFirstPassSummary } = await import("./lean/fixround.mjs");
  const { formatDecompositionSummary } = await import("./lean/decompose.mjs");
  const { formatShadowSummary } = await import("./lean/conformance.mjs");
  const leanIo = deps.leanIo ?? (await import("./lean/effects.mjs")).makeLeanIo({ repo });
  // #4399: declared acceptance probes of closed issues whose fix reached the default branch; never fails the batch
  const sweep = deps.sweepProbes !== undefined ? deps.sweepProbes : (await import("./lean/probe.mjs")).sweepProbes;
  if (sweep && !argv.includes("--no-probes")) {
    try { const s = (await import("./lean/probe.mjs")).formatProbeSummary(await sweep({ repo, cwd, io: leanIo, onResult: probeEventSink(repo) })); if (s) sink.line(s); } catch (e) { sink.line(`probes: sweep failed (${String(e?.message ?? e).slice(0, 160)})`); }
  }
  const { makePrefilter, formatPrefilterSummary, lazyDefaultBranch } = await import("./lean/prefilter.mjs");
  const branches = readBranches(cwd);
  // #4389: the post-deploy gate's default branch is resolved and fetched once, only when a gated issue asks
  const prefilter = argv.includes("--no-prefilter") ? null
    : makePrefilter({ repo, cwd, io: leanIo, ...prefilterModel(argv), defaultBranch: lazyDefaultBranch({ io: leanIo, repo, cwd, configured: branches.default }), preconditionCmd: readPreconditionCmd(cwd), minAge: await readPostDeployMinAge(cwd) });
  const fetched = new Set();
  const laneOf = async (n) => {
    const r = await resolveLane({ issue: n, repo, io: leanIo, cwd, branches, requested: lane, override: laneOverride });
    if (r.ok && prefilter && !fetched.has(r.lane)) { fetched.add(r.lane); try { await leanIo.git(["fetch", "origin", r.lane], { cwd }); } catch { /* offline: use the local ref */ } }
    return r;
  };
  // Lanes: in-process `runCore` when a lean module is injected (tests), otherwise detached `run-issue` processes, or
  // sandboxes when forge.yaml `execution` places them remote (#4253).
  const labelsOf = new Map(); // issue -> label names, filled by readBody (one gh call per issue)
  const trustedOf = new Map(); // #4773: issue -> its body author is trusted (a `Blocked by` line is an edge only then), filled by readBody
  const needsOf = new Map(); // issue -> host-only capabilities its body names (#4542), filled by readBody
  const prefetchOf = new Map(); // issue -> the frozen contract's relayable read-only commands (#4778), filled by readBody
  let execForNeeds = null;
  let lanes, remote = null, execBudget = null, execConf = null, hybrid = false;
  const execMode = () => (deps.execution !== undefined ? deps.execution : readExecution(cwd))?.mode ?? "local";
  if (deps.leanModule) {
    const { runCore } = deps.leanModule;
    const emitTelemetry = deps.emitTelemetry ?? makeEmitTelemetry({ repo });
    lanes = { adopt: null, runOne: (n, ln, ctx = {}) => runCore({ issue: n, repo, lane: ln, laneOverride, ...(ctx.placement ? { placement: { ...ctx.placement, mode: execMode() } } : {}), ...(ctx.recover ? { recover: ctx.recover } : {}), branches, cwd, dir, io: leanIo, agentId: `orch_${process.pid}_${n}`, emitTelemetry, batchId: batch.id,
      admission: readAdmission(cwd), heavy: readHeavy(cwd), ...readCoreLimits(cwd), ...readEnvConfig(cwd), ...(readMergeWait(cwd) ? { mergeWait: readMergeWait(cwd) } : {}), ...(readConformanceMode(cwd) ? { conformance: readConformanceMode(cwd) } : {}), ...(readContextPack(cwd) ? { contextPack: readContextPack(cwd) } : {}), ...(readReviewIncomplete(cwd) ? { reviewIncomplete: readReviewIncomplete(cwd) } : {}), ...(readLaneInstructions(cwd) ? { laneInstructions: readLaneInstructions(cwd) } : {}), ...(readReproTest(cwd) ? { reproTest: readReproTest(cwd) } : {}), ...(readExplore(cwd) ? { explore: readExplore(cwd) } : {}), ...(readExperiment(cwd) ? { experiment: readExperiment(cwd) } : {}), light: readLight(cwd), ...(readCloseParent(cwd) ? { closeParent: true } : {}), ...(readReviewTrigger(cwd) ? { reviewTrigger: readReviewTrigger(cwd) } : {}), ...(readVerify(cwd) ? { verify: readVerify(cwd) } : {}), ...readPrecheckOptions(cwd), ...(model ? { builderModel: model } : {}), ...(readLeanSetting("reviewer_model", cwd) ? { reviewerModel: readLeanSetting("reviewer_model", cwd) } : {}), ...(readFixModel(cwd) ? { fixModel: readFixModel(cwd) } : {}), ...(readBuilderRouting(cwd) ? { builderRouting: readBuilderRouting(cwd) } : {}), ...(readVerifier(cwd) ? { verifier: readVerifier(cwd) } : {}), ...(readHostCaps(cwd) ? { hostCaps: readHostCaps(cwd) } : {}), ...readRelayCaps(), ...(readSequenceRegenerate(cwd) ? { sequenceRegenerate: readSequenceRegenerate(cwd) } : {}), ...(readBaseMerge(cwd) ? { baseMerge: readBaseMerge(cwd) } : {}), ...(readFollowupsDefaultMilestone(cwd) ? { followupsDefaultMilestone: readFollowupsDefaultMilestone(cwd) } : {}) }) };
  } else {
    const laneScript = deps.laneScript ?? fileURLToPath(new URL("./forgedock.mjs", import.meta.url));
    // #4690: lanes learn K (the default MemoryMax is derived from it); one line says so when no scope caps them.
    const laneEnv = { ...env, FORGEDOCK_LANE_PARALLEL: String(parallel) };
    // #4691: --set-env / --unset-env edit plan.json while the batch runs; each newly launched lane re-reads the pinned env.
    const laneSpawn = (bin, args, o) => {
      const p = batch.readPlan();
      const fresh = p?.env ? { ...scheddMod.mergeEnv(process.env, p.env), FORGEDOCK_LANE_PARALLEL: String(parallel) } : null;
      return (deps.spawnFn ?? spawn)(bin, args, fresh ? { ...o, env: { ...fresh, FORGEDOCK_BATCH_ID: o.env?.FORGEDOCK_BATCH_ID } } : o);
    };
    const effects = await import("./lean/effects.mjs");
    const uncapped = effects.laneCapNotice(deps.laneCapProbe ?? effects.systemdRunAvailable);
    if (uncapped) (deps.out ?? ((l) => console.log(l)))(uncapped);
    // #4256: the placement orchestrate decided for a lane (ctx.placement) reaches it as --placement/--placement-reason.
    // #4267: a recovery lane (ctx.recover) reaches it as --recover/--recover-attempt.
    const placementOf = new Map(), recoverOf = new Map();
    const laneArgs = (n, ln) => { const pl = placementOf.get(n), rc = recoverOf.get(n); return ["--repo", repo, ...(ln ? ["--lane", ln] : []), ...(laneOverride ? ["--lane-override"] : []), ...(model ? ["--model", model] : []),
      ...(pl ? ["--placement", pl.where, "--placement-reason", pl.reason ?? ""] : []), ...(rc ? ["--recover", rc.code, "--recover-attempt", String(rc.attempt ?? 1), ...(rc.final === false ? ["--recover-nonfinal"] : [])] : [])]; };
    const withPlacement = (l) => ({ runOne: (n, ln, ctx = {}) => {
      if (ctx.placement) placementOf.set(n, ctx.placement); else placementOf.delete(n);
      if (ctx.recover) recoverOf.set(n, ctx.recover); else recoverOf.delete(n);
      return l.runOne(n, ln, ctx);
    }, adopt: l.adopt });
    const execMod = await import("./lean/execution.mjs");
    const exec = deps.execution !== undefined ? deps.execution : readExecution(cwd);
    execForNeeds = exec ?? null;
    hybrid = exec?.mode === "hybrid" && Number.isInteger(exec.maxRemote) && exec.maxRemote >= 1;
    let remoteStop = null; // #4612: the sandbox provider's checkpoint stop, used only when the cancel asks for it
    if (exec && (execMod.placement(exec) === "remote" || hybrid)) {
      // #4253: lanes run in sandboxes, ledger-tracked per lane, admitted against max_remote instead of the host cap.
      let gitDir = null;
      try { gitDir = resolvePath(cwd, String(await leanIo.git(["rev-parse", "--git-common-dir"], { cwd })).trim()); } catch { gitDir = null; }
      const provider = deps.sandboxProvider ?? execMod.providerByName(exec.provider, { batch, repo, cwd, image: exec.image, gitDir, script: laneScript, bin: deps.laneBin, exec, env, prefetch: (n) => prefetchOf.get(n) ?? [] });
      const { makeLedger } = await import("./lean/ledger.mjs");
      const ledgerFor = deps.sandboxLedger ?? ((n) => makeLedger({ batch: batch.id, lane: `sandbox-${n}`, owner: `orch_${process.pid}`, issue: n }));
      const bud = exec.budget ?? {};
      const remoteLanes = execMod.providerLanes({ provider, laneArgs, ledgerFor, env, secrets: exec.secrets, costPerMinute: bud.costPerMinute ?? 0,
        ...(Number.isFinite(exec.unreachableWindowMin) ? { unreachableWindowMs: exec.unreachableWindowMin * 60000 } : {}),
        ...(deps.now ? { now: deps.now } : {}), ...(deps.pollMs ? { pollMs: deps.pollMs } : {}) });
      remoteStop = remoteLanes.stopLane;
      lanes = withPlacement(remoteLanes);
      {
        // #4255: once the budget refuses a remote lane, the rest run as detached host lanes. #4256: hybrid mixes both.
        const local = batchMod.detachedLanes({ batch, cwd, env: laneEnv, script: laneScript, bin: deps.laneBin, pollMs: deps.pollMs, laneArgs, spawnFn: laneSpawn });
        lanes = withPlacement({
          runOne: (n, ln, ctx = {}) => (ctx.remote ? remoteLanes : local).runOne(n, ln, ctx),
          adopt: (n, rec, ctx) => (rec?.remote || rec?.handle ? remoteLanes : local).adopt(n, rec, ctx),
        });
      }
      // #4255: hard execution budget per batch and per host UTC day; every settled sandbox is recorded and reported.
      execConf = exec;
      execBudget = deps.executionBudget ?? execMod.openExecutionBudget({ budget: bud, file: execMod.executionBudgetFile(env), ...(deps.now ? { now: deps.now } : {}) });
      const emitSbx = deps.emitTelemetry ?? makeEmitTelemetry({ repo });
      // #4256: hybrid places each lane from facts (pure placeLane); validation weight is a repo fact, read once per batch.
      const relays = Array.isArray(provider.relays) ? provider.relays : [];
      const place = !hybrid ? (n) => execMod.placeLane({ exec, needs: needsOf.get(n) ?? [], relays }) : await (async () => {
        const verifyMode = (deps.verify !== undefined ? deps.verify : readVerify(cwd))?.mode ?? "local";
        let weight = deps.validationWeight ?? null;
        if (!weight) { try { weight = await execMod.validationWeight({ cwd, precheckCommands: readPrecheckCommands(cwd) ?? [] }); } catch { weight = { heavy: false, signals: [] }; } }
        const headroom = deps.hostHeadroom ?? (() => execMod.hostHeadroom({ cfg: readAdmission(cwd), heavyCfg: readHeavy(cwd) }));
        return (n) => execMod.placeLane({ exec, verifyMode, labels: labelsOf.get(n) ?? [], weight, headroom: headroom(), needs: needsOf.get(n) ?? [], relays });
      })();
      // #4540: provider free slots, refreshed in the background (admission is sync); unknown (null) never blocks.
      let capSample = null, onlineSample = null, capAt = 0, capLast = -Infinity; // #4547: online = agents alive, null unknown
      const capacity = () => {
        const t = deps.now ? deps.now() : Date.now();
        if (typeof provider.capacity === "function" && t - capLast >= (deps.pollMs ?? 5000)) {
          capLast = t;
          Promise.resolve().then(() => provider.capacity()).then((c) => { capSample = c && Number.isInteger(c.free) ? c.free : null; onlineSample = c && Number.isInteger(c.online) ? c.online : null; capAt++; }, () => { capSample = null; onlineSample = null; capAt++; });
        }
        return capSample === null && onlineSample === null ? null : { free: capSample, online: onlineSample, at: capAt };
      };
      remote = {
        capacity, max: exec.maxRemote, isRemote: () => true, place, ...(hybrid ? { fallbackLocal: true } : {}), ...(exec.fallbackLocal ? { offlineFallback: true } : {}), onBudget: bud.onBudget ?? "stop", costPerMinute: bud.costPerMinute ?? 0,
        admit: (u) => execBudget.admit(u),
        onUsage: (n, sb, rec) => {
          const startedAt = rec?.handle?.startedAt ?? rec?.startedAt ?? "?";
          try { execBudget.record(`${batch.id}#${sb.id ?? n}#${startedAt}`, sb); } catch { /* the batch total still counts it */ }
          Promise.resolve(emitSbx({ event: "SANDBOX_USAGE", issue: n, provider: sb.provider, sandbox_id: sb.id, minutes: sb.minutes, cost_usd: sb.cost_usd, batch: batch.id })).catch(() => {});
        },
      };
      sink.line(`execution: ${hybrid ? "hybrid" : "remote"} via ${provider.name}, max_remote ${exec.maxRemote}`);
    } else {
      lanes = withPlacement(batchMod.detachedLanes({ batch, cwd, env: laneEnv, script: laneScript, bin: deps.laneBin, pollMs: deps.pollMs, laneArgs, spawnFn: laneSpawn }));
    }
    // #4376: a cancel stops detached host lanes by SIGTERM to their group (pid-reuse checked by the result path); sandboxes run on unless `--cancel --stop-remote` (#4612).
    const { killLedgerPid } = await import("./lean/effects.mjs");
    const stopLane = deps.stopLane ?? ((n, rec) => (rec?.remote || rec?.handle ? remoteStop?.(n, rec) ?? false : rec?.pid ? killLedgerPid(rec.pid, batch.resultFile(n)) : false));
    lanes = { ...lanes, stopLane };
  }
  const orch = deps.orchestration ?? readOrchestration(cwd);
  // #4304: recovery lanes run on the core path only (run-issue throws on --recover with full), so a full-path repo gets none.
  const recoveryOn = Boolean(orch.recovery?.maxAttempts) && (deps.enginePath !== undefined ? deps.enginePath : readEnginePath(cwd)) !== "full";
  if (orch.recovery?.maxAttempts && !recoveryOn) sink.line("recovery: off (engine.path is full; recovery lanes run on the core path only)");
  // #4190: usage-limit holds live in the host store keyed by the account the next lane would use.
  const limitsMod = await import("./lean/limits.mjs");
  const limits = deps.limits ?? limitsMod.openLimits(limitsMod.limitsFile(env));
  const identity = deps.identity ?? (() => limitsMod.laneBackendId(env));
  const maint = deps.maintenance !== undefined ? deps.maintenance : readMaintenance(cwd);
  const schedMod = await import("./lean/sched.mjs");
  const registry = deps.sched !== undefined ? deps.sched : schedMod.openSched(schedMod.schedDir());
  const labelNames = async (n) => {
    if (!labelsOf.has(n)) labelsOf.set(n, (JSON.parse(await leanIo.gh(["issue", "view", String(n), "-R", repo, "--json", "labels"])).labels ?? []).map((x) => x.name));
    return labelsOf.get(n);
  };
  let budget = {};
  if (maint) {
    const mLabels = maint.labels ?? DEFAULT_MAINTENANCE_LABELS;
    for (const l of mLabels) {
      let listed = [];
      try { listed = JSON.parse(await leanIo.gh(["issue", "list", "-R", repo, "--state", "open", "--label", l, "--json", "number,labels", "--limit", "100"])); } catch { listed = []; }
      for (const it of Array.isArray(listed) ? listed : []) {
        const names = (it.labels ?? []).map((x) => x.name);
        if (!labelsOf.has(it.number)) labelsOf.set(it.number, names);
        if (!names.includes("needs-human") && !issues.includes(it.number)) issues.push(it.number);
      }
    }
    const classify = async (n) => {
      const names = await labelNames(n);
      const p = names.map((x) => /^priority:P(\d+)$/i.exec(x)?.[1]).find((x) => x !== undefined);
      return { maintenance: names.some((x) => mLabels.includes(x)), priority: p === undefined ? 2 : Number(p) };
    };
    budget = { classify, maintenance: { share: maint.share ?? 0.2, whenIdle: maint.whenIdle ?? true } };
  }
  // forge#4161: milestone drift. Always folds merged milestone lanes into the summary; thresholds and holds only with config.
  let drift = deps.drift;
  if (drift === undefined) {
    const { makeDrift } = await import("./lean/drift.mjs");
    const { affectedFiles } = await import("./orchestrate-preflight.mjs");
    drift = makeDrift({ repo, cwd, io: leanIo, config: readDrift(cwd), stagingBranch: branches.staging ?? "staging", affectedFiles,
      onEvent: (e) => console.log(`#${e.issue} → ${e.detail}`) });
  }
  let lifecycle = deps.lifecycle; // forge#4657: milestone lifecycle; closes at `milestones.close_on`
  if (lifecycle === undefined) {
    const { makeLifecycle } = await import("./lean/lifecycle.mjs");
    lifecycle = makeLifecycle({ gh: leanIo.gh, git: (a) => leanIo.git(a, { cwd }), repo, closeOn: readMilestoneCloseOn(cwd), defaultBranch: branches.default ?? "main" });
  }
  // forge#4667: milestone integration runs (every N lane merges) and the red-streak admission hold; off without forge.yaml ci.workflow.
  let integration = deps.integration;
  if (integration === undefined) {
    const { makeIntegration } = await import("./lean/integration.mjs");
    integration = makeIntegration({ repo, io: leanIo, cfg: await readIntegration(cwd), pattern: branches.featurePattern ?? undefined,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)), onEvent: (e) => console.log(`#${e.issue} → ${e.detail}`) });
    try { await integration?.prime(); } catch { /* streaks unknown: nothing is held */ }
  }
  const crossLane = [];
  // #4183: owned-resource GC in preflight and before an admission when the host is near the ceiling (forge.yaml hygiene).
  const gcMod = await import("./gc.mjs");
  // #4361: GC never holds admission for long; what it cannot finish in the budget resumes at the next beforeAdmit interval.
  const GC_BUDGET_MS = 60 * 1000;
  const hygiene = deps.hygiene ?? gcMod.readHygiene(cwd);
  const testDeps = deps.leanIo || deps.leanModule || deps.laneScript;
  const gcRun = !hygiene.auto_gc ? null : deps.gc !== undefined ? deps.gc
    : testDeps ? null : async () => gcMod.runOwnedGc({ probes: gcMod.makeGcProbes({ cwd }), hygiene, budgetMs: GC_BUDGET_MS });
  const reclaimed = { enabled: !!hygiene.auto_gc, items: 0, bytes: 0, preflight: 0, admissions: 0, runs: 0 };
  const nowMs = deps.now ?? (() => Date.now());
  let lastGcAt = null, gcPending = false;
  const runGcPhase = async (phase) => {
    if (!gcRun) return;
    lastGcAt = nowMs();
    try {
      const r = (await gcRun({ phase })) ?? {};
      const n = Number(r.reclaimed) || 0;
      reclaimed.items += n; reclaimed.bytes += Number(r.bytes) || 0; reclaimed.runs++;
      reclaimed[phase === "preflight" ? "preflight" : "admissions"] += n;
      for (const note of r.plan?.notes ?? []) console.log(`gc (${phase}): ${note}`);
      gcPending = Number(r.deferred) > 0;
      if (gcPending) console.log(`gc (${phase}): ${Number(r.deferred)} item(s) deferred to the next admission`);
    } catch (e) { console.log(`gc (${phase}) failed: ${String(e?.message ?? e).slice(0, 200)}`); }
  };
  await runGcPhase("preflight");
  const GC_ADMISSION_INTERVAL_MS = 5 * 60 * 1000;
  const beforeAdmit = !gcRun ? null : async () => {
    if (lastGcAt !== null && nowMs() - lastGcAt < GC_ADMISSION_INTERVAL_MS) return;
    let near = false;
    try {
      const { nearCeiling } = await import("./lean/admission.mjs");
      const host = deps.host ?? (await import("./lean/effects.mjs")).makeHostProbe();
      near = await nearCeiling({ cfg: readAdmission(cwd), host, ratio: hygiene.max_host_load_ratio });
    } catch { near = false; }
    if (near || gcPending) await runGcPhase("admission");
  };
  // #4318: SIGINT/SIGTERM of a foreground dispatcher run the batch-exit relabel, then exit 128+signo (the lane pattern above).
  let exitRelabel = null, interrupted = false;
  const on = deps.processOn ?? ((s, f) => process.on(s, f)), off = deps.processOff ?? ((s, f) => process.removeListener(s, f));
  const exitProc = deps.exit ?? ((c) => process.exit(c));
  const SIGNO = { SIGINT: 2, SIGTERM: 15 };
  const handlers = daemon ? {} : Object.fromEntries(Object.keys(SIGNO).map((sig) => [sig, async () => {
    if (interrupted) return;
    interrupted = true;
    try { if (exitRelabel) await exitRelabel(`interrupted by ${sig}`); } catch { /* exit anyway */ }
    exitProc(128 + SIGNO[sig]);
  }]));
  for (const [sig, f] of Object.entries(handlers)) on(sig, f);
  // #4409: longest-first admission; lane estimates from the size label, a post-deploy-only body and this repo's run history.
  let estimate = deps.estimate;
  if (estimate === undefined) {
    let history = {};
    try { const { readLocalRuns } = await import("./stats/local-source.mjs"); history = laneHistory(readLocalRuns(dir), repo); } catch { history = {}; }
    estimate = async (n, { body }) => estimateLaneMinutes({ labels: await labelNames(n), body, history });
  }
  let rows;
  try {
    rows = await orchestrate({
      ...(estimate ? { estimate } : {}),
      beforeAdmit,
      ...(orch.blockedLabel ? { getBlocked: async () => JSON.parse(await leanIo.gh(["issue", "list", "-R", repo, "--label", orch.blockedLabel, "--state", "open", "--limit", "200", "--json", "number"])).map((x) => x.number) } : {}), // #4773
      trusted: (n) => trustedOf.get(n) === true,
      issues, parallel, prefilter, resolveLane: laneOf, store: batch.store, getParallel: batch.readParallel, getAdded: batch.readAdded, getRequeued: batch.readRequeued, getCancelled: batch.readCancel, getHeld: batch.readHeld, getGates: batch.readGates, ...lanes,
      breaker: orch.breaker, maxDeferrals: orch.maxDeferrals, ...(deps.pollMs ? { pollMs: deps.pollMs } : {}), ...budget, limits, identity, batchId: batch.id, drift, lifecycle, integration,
      ...(registry ? { sched: { registry, batch: batch.id, repo, cap: liveLaneCap(orch.globalParallel ?? null), exclusive: true }, priorityOf: async (n) => schedMod.priorityFromLabels(await labelNames(n)) } : {}),
      ...(remote ? { remote } : {}),
      // #4267: mechanical needs-human outcomes are recovered in the batch; every runner decision is a FORGE:DECISION.
      ...(recoveryOn ? { recovery: orch.recovery } : {}),
      decide: deps.decide ?? (async (d) => {
        if (d?.issue == null) { sink.line(`decision: ${d?.what} (why: ${d?.why}; alternative: ${d?.alternative})`); return; }
        const body = `<!-- FORGE:DECISION -->\n## Decision (batch ${batch.id})\n**What**: ${d.what}\n**Why**: ${d.why}\n**Alternative**: ${d.alternative}`;
        try { await leanIo.gh(["issue", "comment", String(d.issue), "-R", repo, "--body", body]); } catch { /* best effort: the batch log keeps the row */ }
      }),
      // A recovery that ended for good without the lane relabelling it (engine-error, deferred): needs-human back, one comment.
      relabelNeedsHuman: deps.relabelNeedsHuman ?? makeRelabelNeedsHuman({ gh: (a) => leanIo.gh(a), repo }),
      // #4481: a requeued or resumed issue that was closed or whose lane PR merged meanwhile is not run again
      dispatchCheck: deps.dispatchCheck !== undefined ? deps.dispatchCheck : makeDispatchCheck({ gh: (a) => leanIo.gh(a), repo }),
      // #4387: an out-of-set dependency labelled needs-human is not pulled into the batch
      issueLabels: labelNames,
      // #4725: a closed (completed) dependency is satisfied even when it still carries a stale needs-human label
      issueState: async (n) => { const v = JSON.parse(await leanIo.gh(["issue", "view", String(n), "-R", repo, "--json", "state,stateReason"])); return v.state === "CLOSED" && String(v.stateReason ?? "COMPLETED").toUpperCase() !== "COMPLETED" ? "CLOSED_NOT_PLANNED" : v.state; },
      // #4318: a dispatcher signal relabels the queued recoveries before it exits (the daemon resumes its batches instead)
      ...(daemon ? {} : { onExit: (fn) => { exitRelabel = fn; } }),
      // #4454: the daemon's shutdown stop; orchestrate throws batch.stopped, so no report is written and a resume adopts the lanes
      ...(signal ? { signal } : {}),
      // #4525: a parked needs-human PR is merged with its moved base: clean or union-resolved merges are pushed, other conflicts reported
      ...(deps.syncParked !== undefined ? (deps.syncParked ? { syncParked: deps.syncParked } : {}) : orch.baseSync?.enabled !== true ? {} : { syncParked: async ({ pr, last }) => {
        try {
          const v = JSON.parse(await leanIo.gh(["pr", "view", String(pr), "-R", repo, "--json", "state,headRefName,baseRefName,isCrossRepository"]));
          if (v.state !== "OPEN" || v.isCrossRepository) return { status: "unchanged" };
          const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
          const run = promisify(execFile);
          return await (await import("./lean/basesync.mjs")).syncParked({ git: async (a, o = {}) => String((await run("git", a, { cwd: o.cwd ?? cwd, maxBuffer: 1 << 24 })).stdout), base: v.baseRefName, branch: v.headRefName,
            unionGlobs: orch.baseSync?.unionGlobs ?? [], last });
        } catch (e) { return { status: "error", detail: String(e?.message ?? e).slice(0, 160) }; }
      } }),
      conflicting: deps.conflicting ?? (async (_n, pr) => {
        try { return JSON.parse(await leanIo.gh(["pr", "view", String(pr), "-R", repo, "--json", "mergeable"]))?.mergeable === "CONFLICTING"; } catch { return false; }
      }),
      onCrossLane: (e) => {
        crossLane.push(e);
        sink.line(`cross-lane: #${e.issue} (${e.lane}) depends on #${e.dependency} (${e.dependencyLane}); its fix will not be on ${e.lane}: re-milestone #${e.dependency} or wait for a milestone sync`);
      },
      readBody: maint || registry || hybrid
        ? async (n) => { const v = JSON.parse(await leanIo.gh(["issue", "view", String(n), "-R", repo, "--json", "body,labels,comments,author,authorAssociation"])); trustedOf.set(n, bodyTrusted(v)); labelsOf.set(n, (v.labels ?? []).map((x) => x.name)); needsOf.set(n, detectNeeds(placementText(v), execForNeeds)); if (execForNeeds?.relay) prefetchOf.set(n, relayPrefetchCommands(v, execForNeeds.relay)); return v.body; }
        : async (n) => { const v = JSON.parse(await leanIo.gh(["issue", "view", String(n), "-R", repo, "--json", "body,comments,author,authorAssociation"])); trustedOf.set(n, bodyTrusted(v)); needsOf.set(n, detectNeeds(placementText(v), execForNeeds)); if (execForNeeds?.relay) prefetchOf.set(n, relayPrefetchCommands(v, execForNeeds.relay)); return v.body; }, // #4785: decisions and the frozen contract's validate commands too
      onUpdate: (r) => sink.row(r),
    });
  } finally { for (const [sig, f] of Object.entries(handlers)) off(sig, f); }
  try { await integration?.settle?.(); } catch { /* best effort: the state block is the record */ }
  const report = ["\n" + formatTable(rows), ...formatOutcomeLists(rows)];
  const pfLine = formatPrefilterSummary(rows);
  if (pfLine) report.push(pfLine);
  let heavyStats = null; // #4169: live heavy-semaphore queue next to the per-phase waits the lanes reported
  try { heavyStats = deps.heavyStats !== undefined ? deps.heavyStats : (await import("./lean/heavy.mjs")).openHeavy(schedMod.schedDir()).stats(); } catch { heavyStats = null; }
  const waitLine = formatWaitSummary(rows, heavyStats);
  if (waitLine) report.push(waitLine);
  const precheckLine = formatPrecheckSummary(rows); // #4331
  if (precheckLine) report.push(precheckLine);
  const firstPassLine = formatFirstPassSummary(rows); // #4362
  if (firstPassLine) report.push(firstPassLine);
  const turnLine = formatTurnSummary(rows); // #4392
  if (turnLine) report.push(turnLine);
  const estLine = formatEstimateSummary(rows); // #4409
  if (estLine) report.push(estLine);
  try { // #4402: $/merge, turns, context, retries by cause, no-action lanes, issue quality, acceptance; never fails a batch
    const { batchEfficiency, formatEfficiencyLines } = await import("./stats/efficiency.mjs");
    report.push(...formatEfficiencyLines(await (deps.efficiency ?? batchEfficiency)({ batchDir: batch.dir, runsDir: dir, repo, gh: (a) => leanIo.gh(a), rows })));
  } catch (e) { report.push(`efficiency: n/a (${String(e?.message ?? e).split("\n")[0].slice(0, 160)})`); }
  const shadowLine = formatShadowSummary(rows); // #4398
  if (shadowLine) report.push(shadowLine);
  const decompLine = formatDecompositionSummary(rows); // #4396
  if (decompLine) report.push(decompLine);
  let day = null;
  try { day = execBudget ? execBudget.dayTotals() : null; } catch { day = null; }
  const sbxLine = formatSandboxSummary(rows, { budget: execConf?.budget ?? null, day });
  if (sbxLine) report.push(sbxLine);
  if (crossLane.length) report.push(`cross-lane edges: ${crossLane.map((e) => `#${e.issue} (${e.lane}) → #${e.dependency} (${e.dependencyLane})`).join(", ")}`);
  if (rows.some((r) => r.outcome === "held")) report.push(`held issues stay pending: forgedock orchestrate --resume ${batch.id}`);
  report.push(formatReclaimed(reclaimed));
  try { // #4354: fail-soft alerts for the batch's repo from the local run logs, last; nothing when none fired
    const [{ computeAlerts }, { readLanes }, { readAlertConfig }] = await Promise.all([import("./stats/aggregate.mjs"), import("./stats/local-source.mjs"), import("./stats/index.mjs")]);
    report.push(...formatAlertLines(computeAlerts(readLanes(dir), { repo, ...(deps.alertConfig ?? readAlertConfig(cwd)) })));
  } catch { /* alerts never fail a batch */ }
  for (const l of report) sink.line(l);
  const ok = rows.every((r) => ["merged", "invalid", "decomposed"].includes(r.outcome));
  try { batch.writeReport({ rows, crossLane, ok, reclaimed, report: report.join("\n") }); } catch { /* the report is a cache of the rows */ }
  return { rows, crossLane, batch: batch.id, reclaimed, ok };
}

/**
 * #4481: the dispatch-time "already done" check: `{outcome:"merged", pr}` when the issue's own lane PR
 * (`feat/issue-N-lean`) merged, `{outcome:"invalid"}` when the issue is closed without one, else null. Anything
 * unreadable (no state, non-JSON, a non-array PR list, a gh error) is null: the lane runs.
 * Release review #4500: an OPEN issue reopened after that PR merged (a failed acceptance probe, #4399, or an operator
 * reopening it for rework) is new work, so the lane runs; an unreadable reopen history also runs the lane.
 */
export function makeDispatchCheck({ gh, repo }) {
  const json = async (args) => { try { return JSON.parse(String(await gh(args))); } catch { return null; } };
  /** Latest `reopened` event time (ms) on the issue, 0 when never reopened, null when unreadable. */
  const lastReopen = async (n) => {
    try {
      const out = String(await gh(["api", `repos/${repo}/issues/${n}/events`, "--paginate", "--jq", '.[] | select(.event == "reopened") | .created_at']));
      return out.split("\n").map((l) => Date.parse(l.trim())).filter(Number.isFinite).reduce((a, b) => Math.max(a, b), 0);
    } catch { return null; }
  };
  return async (n) => {
    const iss = await json(["issue", "view", String(n), "-R", repo, "--json", "state,stateReason"]);
    const state = typeof iss?.state === "string" ? iss.state.toUpperCase() : null;
    const notPlanned = String(iss?.stateReason ?? "").toUpperCase().replace(/\s/g, "_") === "NOT_PLANNED";
    const prs = await json(["pr", "list", "-R", repo, "--head", `feat/issue-${n}-lean`, "--state", "merged", "--json", "number,mergedAt", "--limit", "1"]);
    const pr = Array.isArray(prs) && Number.isInteger(prs[0]?.number) ? prs[0].number : null;
    if (pr !== null && state === "OPEN") {
      const mergedAt = Date.parse(prs[0]?.mergedAt ?? "");
      const reopened = await lastReopen(n);
      if (reopened === null || !Number.isFinite(mergedAt) || reopened > mergedAt) return null;
    }
    if (pr !== null) return { outcome: "merged", pr, detail: `PR #${pr} already merged` };
    if (state === "CLOSED") return notPlanned ? { outcome: "invalid", detail: "issue closed (not planned)", final: true } : { outcome: "invalid", detail: "issue closed" }; // #4687: final = its dependents stay skipped
    return null;
  };
}

/**
 * #4318: the batch runner's needs-human relabel. Re-reads the issue first: closed, or a live FORGE:STATE lease (the runner
 * never holds one, so it is another actor's) → "skipped". Label first: a failed label add → "failed" with no comment (a
 * resume retries); then the capped FORGE:NEEDS_HUMAN comment, whose failure keeps the label → true.
 */
export function makeRelabelNeedsHuman({ gh, repo, now = () => Date.now() }) {
  return async ({ issue, evidence, parked = null }) => {
    const { stateOf } = await import("./lean/context.mjs");
    try {
      const v = JSON.parse(await gh(["issue", "view", String(issue), "-R", repo, "--json", "state,body"]));
      if (String(v?.state ?? "").toUpperCase() === "CLOSED") return "skipped";
      const lease = stateOf(v?.body)?.lease;
      if (lease && Number(lease.until) > now()) return "skipped";
    } catch { /* unreadable: relabel as before */ }
    // #4656: a mechanical park carries its code and PR on `parked:<code>` and joins the remediation queue, not the human queue.
    if (parked?.code) {
      const { parkedLabel, REMEDIATION_QUEUE_LABEL } = await import("./engine/outcome-codes.mjs");
      try { await gh(["label", "create", parkedLabel(parked.code), "-R", repo, "--force", "--color", "C5DEF5", "--description", "Mechanical park on a terminal code. Managed by ForgeDock."]); } catch { /* exists, or no rights: the edit says */ }
      try { await gh(["issue", "edit", String(issue), "-R", repo, "--add-label", `${parkedLabel(parked.code)},${REMEDIATION_QUEUE_LABEL}`, "--remove-label", "needs-human"]); } catch { return "failed"; }
      try {
        const { capComment } = await import("./lean/render.mjs");
        await gh(["issue", "comment", String(issue), "-R", repo, "--body", capComment(`<!-- FORGE:PARKED code=${parked.code}${parked.pr ? ` pr=${parked.pr}` : ""} -->\n## Parked (\`${parked.code}\`)\nCode: \`${parked.code}\`\nPR: ${parked.pr ? `#${parked.pr}` : "none"}\nQueue: \`${REMEDIATION_QUEUE_LABEL}\` (\`/work-on:remediate\`)\n${evidence}`)]);
      } catch { /* best effort */ }
      return true;
    }
    // #4656: a human-owned wait is `needs-human:external` and its comment names the owner and the unblock condition.
    {
      const external = { owner: "", unblock: "" }; // the default non-parked relabel is a human-owned wait
      const { NEEDS_HUMAN_EXTERNAL_LABEL } = await import("./engine/outcome-codes.mjs");
      // #4725: a recorded premise that already holds is not a blocker; an identical owner ask links to its entry instead of a new one.
      const prem = await import("./lean/needs-human-premise.mjs");
      const predicate = prem.parsePredicate(evidence);
      if (predicate && await prem.evalPredicate(predicate, { repo, io: { gh, pkgVersion: prem.registryPkgVersion }, now: now() }) === true) return "skipped";
      const reg = await prem.registerAsk({ repo, io: { gh }, issue, ask: String(evidence ?? "") });
      const extra = [prem.premiseAnnotation(predicate), reg.existing ? `Same owner ask as #${reg.existing} (one ask, linked): answering it unblocks this issue too.` : ""].filter(Boolean).join("\n");
      try { await gh(["issue", "edit", String(issue), "-R", repo, "--add-label", `needs-human,${NEEDS_HUMAN_EXTERNAL_LABEL}`]); } catch { return "failed"; }
      try {
        const { capComment } = await import("./lean/render.mjs");
        await gh(["issue", "comment", String(issue), "-R", repo, "--body", capComment(`<!-- FORGE:NEEDS_HUMAN external=true -->\n## Needs human (external)\nOwner: ${external.owner || "unassigned (name an owner)"}\nUnblock condition: ${external.unblock || "unstated (name the condition that unblocks this issue)"}\n${extra ? `${extra}\n` : ""}${evidence}${!reg.existing && reg.entry ? `\n\n${reg.entry}` : ""}`)]);
      } catch { /* best effort */ }
      return true;
    }
  };
}

/** The batch report's "reclaimed" line (#4183). */
export function formatReclaimed(r) {
  if (!r?.enabled) return "reclaimed: off (hygiene.auto_gc: false)";
  const b = r.bytes, size = b >= 1073741824 ? `${(b / 1073741824).toFixed(1)}G` : b >= 1048576 ? `${(b / 1048576).toFixed(1)}M` : b >= 1024 ? `${Math.round(b / 1024)}K` : `${b}B`;
  return `reclaimed: ${r.items} item(s), ${size} (preflight ${r.preflight}, admissions ${r.admissions})`;
}

/** #4627: the daemon's timer callback: re-run the due windowed post-deploy checks of the cwd repo. No repo, no work. */
async function scheddDue() {
  const io = makeIo();
  const repo = await resolveDefaultRepo(io);
  if (!repo) return;
  const { sweepDue } = await import("./lean/postdeploy-monitor.mjs");
  const leanIo = (await import("./lean/effects.mjs")).makeLeanIo({ repo });
  await sweepDue({ repo, cwd: process.cwd(), io: leanIo, onResult: probeEventSink(repo) });
  await sweepParkedFollowups({ repo, io: leanIo }); // #4689: re-queue parked post-deploy follow-ups on the same pass
  try { const prem = await import("./lean/needs-human-premise.mjs"); await prem.sweepPremises({ repo, io: { gh: (a) => leanIo.gh(a), pkgVersion: prem.registryPkgVersion } }); } catch { /* best effort (#4725) */ } // clear needs-human whose recorded premise now holds
}

/** #4689: re-evaluate the parked post-deploy follow-ups of the repo (promotion, due date, check now defined); never throws. */
async function sweepParkedFollowups({ repo, io, dryRun = false }) {
  try {
    const { sweepParked } = await import("./lean/parked-sweep.mjs");
    const branches = readBranches();
    return await sweepParked({ repo, cwd: process.cwd(), io, dryRun, defaultBranch: (await import("./lean/prefilter.mjs")).lazyDefaultBranch({ io, repo, cwd: process.cwd(), configured: branches.default }), preconditionCmd: readPreconditionCmd(), minAge: await readPostDeployMinAge() });
  } catch { return []; }
}

/**
 * `forgedock schedd` (foreground; for a systemd-user unit: `ExecStart=forgedock schedd`) · `forgedock schedd status` (#4192)
 */
export async function scheddFromCli(argv, deps = {}) {
  const schedd = await import("./lean/schedd.mjs");
  const dir = deps.scheddDir ?? (await import("./lean/sched.mjs")).schedDir();
  if (argv[0] === "status") {
    let sock;
    try { sock = await schedd.connectDaemon({ dir, spawnDaemon: null }); } catch { console.log("schedd: not running"); return { running: false }; }
    const st = await schedd.request(sock, { op: "status" });
    console.log(`schedd: pid ${st.pid}, ${st.batches.length} batch(es)${st.batches.length ? ": " + st.batches.map((b) => b.id).join(", ") : ""}${Number.isFinite(st.lastTick) ? `, last tick ${Math.round((Date.now() - st.lastTick) / 1000)} s ago` : ""}`);
    return { running: true, ...st };
  }
  if (argv[0] === "watchdog") { // #4780: run by the schedd watchdog timer; signals a live daemon whose heartbeat went stale
    const health = await import("./lean/schedd-health.mjs");
    const i = argv.indexOf("--stall-sec"), sec = i >= 0 ? Number(argv[i + 1]) : NaN;
    if (i >= 0 && !(sec > 0)) throw new Error("usage: forgedock schedd watchdog [--stall-sec N]");
    return (deps.watchdog ?? health.watchdog)({ dir, ...(sec > 0 ? { stallMs: sec * 1000 } : {}) });
  }
  if (argv.length) throw new Error("usage: forgedock schedd [status | watchdog [--stall-sec N]]");
  (deps.renice ?? (await import("./lean/schedd-health.mjs")).bestEffortRenice)(); // #4780: lanes must not starve the scheduler
  process.title = "forgedock-schedd"; // distinctive name for OOM-killer avoid lists and ps (#4673)
  const d = await schedd.startDaemon({ dir, runBatch: (a) => runBatch({ ...a, daemon: true, deps: deps.batchDeps ?? {} }), ...(deps.due !== undefined ? { due: deps.due } : { due: scheddDue }) });
  if (!d.running) return d;
  // #4454: a signal stops the hosted batch loops, then releases the lock and socket, then exits 128+signo
  schedd.exitOnSignals(d, { ...(deps.processOn ? { on: deps.processOn } : {}), ...(deps.exit ? { exit: deps.exit } : {}) });
  await d.closed;
  return { running: false };
}

/**
 * `forgedock pool router [install] | enroll [--cpus N --mem GB] | status | upgrade [agent] | remove <agent>` (#4544)
 * The built-in remote compute pool (`bin/pool/`). `pool router` runs in the foreground (for a systemd-user unit:
 * `ExecStart=forgedock pool router`); `router install` installs that unit. `enroll` prints the one-time install command.
 */
export async function poolFromCli(argv, deps = {}) {
  const { runPoolCli } = await import("./pool/cli.mjs");
  return (deps.runPoolCli ?? runPoolCli)(argv, deps.poolDeps ?? {});
}

/**
 * `forgedock limits show` · `forgedock limits clear <id>|--all` (#4190)
 * Usage-limit holds are kept per account (backend identity) in `~/.forge/limits.json` (or `FORGEDOCK_LIMITS_FILE`) and
 * shared by every batch on the host. `show` lists the active holds (identity, reset time, source; `*` marks the account
 * this shell's lanes would use); `clear` drops one hold or all of them, so held batches admit on their next pass.
 */
export async function limitsFromCli(argv, deps = {}) {
  const limitsMod = await import("./lean/limits.mjs");
  const limits = deps.limits ?? limitsMod.openLimits(limitsMod.limitsFile());
  const current = (deps.identity ?? (() => limitsMod.laneBackendId(process.env)))();
  const usage = "usage: forgedock limits show | forgedock limits clear <id>|--all";
  const [sub, arg] = argv;
  if (!sub || sub === "show") {
    const holds = limits.list();
    if (!holds.length) console.log(`no usage-limit holds (this account: ${current})`);
    for (const h of holds) console.log(`${h.id === current ? "*" : " "} ${h.id}  until ${new Date(h.until).toISOString()}  source ${h.source ?? "-"}`);
    return { holds, current };
  }
  if (sub === "clear") {
    if (arg === "--all") { const n = limits.clearAll(); console.log(`cleared ${n} usage-limit hold(s)`); return { cleared: n }; }
    if (!arg || arg.startsWith("--")) throw new Error(usage);
    if (!limits.clear(arg)) throw new Error(`no active usage-limit hold for ${arg}`);
    console.log(`cleared usage-limit hold for ${arg}`);
    return { cleared: 1 };
  }
  throw new Error(usage);
}

/**
 * `forgedock decisions list [--stale] [--refresh] [--repo OWNER/NAME] [--base REF]` (#4695): the anchored decisions of the
 * local index (`~/.forge/decisions/`); `--refresh` rebuilds it from the repo's FORGE:DECISION comments first; `--stale`
 * lists the active ones with an anchor that matches no file on the base ref (default HEAD). Read-only apart from the index.
 */
export async function decisionsFromCli(argv, deps = {}) {
  const dec = await import("./lean/decisions.mjs");
  const usage = "usage: forgedock decisions list [--stale] [--refresh] [--repo OWNER/NAME] [--base REF]";
  const [sub, ...rest] = argv;
  if (sub !== "list") throw new Error(usage);
  const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null; };
  const run = deps.exec ?? (async (cmd, args) => String((await pexec(cmd, args, { maxBuffer: 64 * 1024 * 1024 })).stdout));
  const repo = flag("--repo") ?? String(await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  if (rest.includes("--refresh")) {
    const jq = '.[] | select(.body | startswith("<!-- FORGE:DECISION {")) | {body, user, author_association, issue_url} | tojson';
    const lines = String(await run("gh", ["api", "--paginate", `repos/${repo}/issues/comments?per_page=100`, "--jq", jq])).split("\n").filter(Boolean);
    const { isTrustedIssueComment } = await import("./lean/prefilter.mjs");
    const recs = [];
    for (const l of lines) {
      try {
        const c = JSON.parse(l);
        const r = isTrustedIssueComment(c) ? dec.parseDecisionComment(c.body, { issue: Number(/(\d+)$/.exec(c.issue_url ?? "")?.[1]) || null }) : null;
        if (r) recs.push(r);
      } catch { /* skip a malformed comment */ }
    }
    dec.writeDecisionIndex(repo, recs);
  }
  const all = dec.foldDecisions(dec.readDecisionIndex(repo));
  let rows = all.filter((d) => d.status !== "superseded").map((d) => ({ decision: d, dead: [] }));
  if (rest.includes("--stale")) rows = dec.staleDecisions(all, String(await run("git", ["ls-tree", "-r", "--name-only", flag("--base") ?? "HEAD"])).split("\n").filter(Boolean));
  for (const { decision: d, dead } of rows) console.log(`${d.id}  #${d.issue ?? "?"}  ${d.choice}  [${d.anchors.join(", ")}]${dead.length ? `  stale: ${dead.join(", ")}` : ""}${d.supersedes ? `  supersedes ${d.supersedes}` : ""}`);
  if (!rows.length) console.log(rest.includes("--stale") ? "no stale decisions" : "no active decisions");
  return { rows };
}

/**
 * `forgedock check [--repo DIR] [--base REF] [--json]` (#4364): runs in the lane worktree what the engine runs after the
 * builder: the frozen validate commands (.forge-lean/contract.json) and the change-scoped pre-PR checks, with the plan
 * the engine wrote (.forge-lean/check-plan.json; else this checkout's forge.yaml) and the caller's env (lane TMPDIR,
 * pinned toolchain, heavy shims). Local only: no gh, no push, no workflow. Prints a pass/fail table, records the run in
 * .forge-lean/self-check.json, and returns {ok, exitCode} (0 pass, 1 fail, 2 usage).
 */
export async function checkFromCli(argv, deps = {}) {
  const usage = "usage: forgedock check [--repo DIR] [--base REF] [--json]";
  const pre = await import("./lean/precheck.mjs");
  const { readTestMap, readTestMapAtRef } = await import("./lean/testmap.mjs");
  const fsp = await import("node:fs/promises");
  const out = deps.out ?? ((l) => console.log(l)), env = deps.env ?? process.env;
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--repo" || t === "--base") { if (!argv[i + 1]) throw Object.assign(new Error(usage), { exitCode: 2 }); o[t.slice(2)] = argv[++i]; }
    else if (t === "--json") o.json = true;
    else throw Object.assign(new Error(usage), { exitCode: 2 });
  }
  const run0 = deps.git ?? (async (args, cwd) => (await promisify(execFile)("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout);
  const repo = resolvePath(o.repo ?? String(await run0(["rev-parse", "--show-toplevel"], deps.cwd ?? process.cwd())).trim());
  const git = (args) => run0(args, repo);
  const readJson = async (f) => { try { return JSON.parse(await (deps.readFile ?? ((p) => fsp.readFile(p, "utf8")))(join(repo, f))); } catch { return null; } };
  const contract = await readJson(".forge-lean/contract.json");
  if (!contract) throw Object.assign(new Error(`check: no .forge-lean/contract.json in ${repo}\n${usage}`), { exitCode: 2 });
  const plan = await readJson(pre.CHECK_PLAN_FILE);
  const base = o.base ?? plan?.base;
  if (!base) throw Object.assign(new Error(`check: no check plan from the engine; pass --base REF\n${usage}`), { exitCode: 2 });
  const verify = plan ? { mode: plan.mode, precheckTotalSeconds: plan.precheckTotalSeconds, precheckTimeoutSeconds: plan.precheckTimeoutSeconds, invariants: Array.isArray(plan.invariants) ? plan.invariants : [] } : { ...parseVerify({}), ...(readVerify(repo) ?? {}) };
  const learned = plan ? plan.learned : readPrecheckCommands(repo) ?? [];
  const maxMinutes = plan ? plan.maxMinutes : readPrecheckBudget(repo);
  // the engine's changed files (lean.mjs changedFiles: base...HEAD still differing from base), plus uncommitted work
  const names = (x) => String(x ?? "").split("\n").map((f) => f.trim()).filter(Boolean);
  const touched = names(await git(["diff", "--name-only", `${base}...HEAD`])), differs = new Set(names(await git(["diff", "--name-only", base, "HEAD"])));
  const files = [...new Set([...touched.filter((f) => differs.has(f)), ...names(await git(["diff", "--name-only", "HEAD"])), ...names(await git(["ls-files", "-o", "--exclude-standard"]))])]
    .filter((f) => !f.startsWith(".forge-lean/"));
  const testMap = (await readTestMapAtRef(git, base)) ?? (await readTestMap([repo], (p) => fsp.readFile(p, "utf8")));
  const picked = pre.planPrecheck({ testMap, files, learned, maxMinutes, verify });
  const par = String(env.FORGE_HOST_PARALLELISM ?? "").trim(), pinned = /^\d+$/.test(par) && Number(par) > 0;
  const runCommand = deps.runCommand ?? (await import("./lean/effects.mjs")).runCheckCommand;
  const r = await pre.selfCheck({ contract, plan: { mode: verify.mode, commands: picked.commands, budgetMs: picked.budgetMs, perCommandMs: picked.perCommandMs },
    parallelism: pinned ? Number(par) : 1, now: deps.now,
    run: ({ command, timeoutMs, workers }) => runCommand({ command, cwd: repo, timeoutMs, env: pinned ? { FORGE_HOST_PARALLELISM: String(workers) } : null }) });
  // #4390: each failure's full output goes to .forge-lean/logs/ (git-excluded); the table shows its tail, ids and the path
  const failing = [...r.validate.map((x) => [x, `check-${x.id}`]), ...r.commands.map((x, i) => [x, `check-cmd${i + 1}`])].filter(([x]) => !x.status && x.rc !== 0);
  if (failing.length) {
    try {
      await (deps.mkdir ?? ((p) => fsp.mkdir(p, { recursive: true })))(join(repo, pre.CHECK_LOG_DIR));
      for (const [x, name] of failing) {
        const rel = `${pre.CHECK_LOG_DIR}/${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`;
        await (deps.writeFile ?? ((p, t) => fsp.writeFile(p, t)))(join(repo, rel), String(x.output ?? ""));
        x.logPath = rel;
      }
    } catch { /* no log files: the table still shows the tails */ }
  }
  let fingerprint = null;
  try { fingerprint = await pre.worktreeFingerprint({ git, base }); } catch { /* recorded without one: the engine reads it as skipped */ }
  const strip = (x) => (x.status ? { ...(x.id ? { id: x.id } : {}), command: x.command, status: x.status } : { ...(x.id ? { id: x.id } : {}), command: x.command, rc: x.rc, ms: x.ms });
  const record = { v: 1, at: new Date((deps.now ?? Date.now)()).toISOString(), base, fingerprint, ok: r.ok, validate: r.validate.map(strip), commands: [...r.commands.map(strip), ...r.deferred.map((command) => ({ command, status: "deferred-to-ci" }))] };
  try { await (deps.writeFile ?? ((p, t) => fsp.writeFile(p, t)))(join(repo, pre.SELF_CHECK_FILE), `${JSON.stringify(record)}\n`); } catch { /* .forge-lean missing: still print */ }
  out(o.json ? JSON.stringify({ ...r, base, fingerprint }, null, 2) : pre.formatCheckTable(r));
  return { ...r, base, fingerprint, files, exitCode: r.ok ? 0 : 1 };
}

/**
 * `forgedock sched show` · `forgedock sched cap <N>|--clear` (#4191) · `forgedock sched weight <owner/repo> <N>|--clear` (#4193)
 * The host lane registry (`~/.forge/sched/`, or `FORGEDOCK_SCHED_DIR`) shared by every `forgedock orchestrate` batch.
 * `show` prints the cap, the repo weights, the running slots and the queued issues in grant order; `cap N` sets the
 * host-wide cap live (the next admission pass of every batch uses it); `cap --clear` falls back to each batch's
 * `orchestration.global_parallel`. `weight <owner/repo> N` sets that repo's share of slots within a priority (default 1);
 * `--clear` resets it to 1.
 */
export async function schedFromCli(argv, deps = {}) {
  const schedMod = await import("./lean/sched.mjs");
  const reg = deps.sched ?? schedMod.openSched(schedMod.schedDir());
  const health = await import("./lean/schedd-health.mjs");
  const usage = "usage: forgedock sched show | forgedock sched cap <N>|--clear | forgedock sched weight <owner/repo> <N>|--clear";
  const [sub, arg, arg2] = argv;
  if (!sub || sub === "show") {
    const st = reg.list();
    const who = (e) => `#${e.issue} ${e.repo ?? "-"} batch ${e.batch ?? "-"} P${e.priority}`;
    console.log(deps.tick ?? health.tickText(health.stallCheck({ dir: schedMod.schedDir() })));
    console.log(`host cap: ${st.cap ?? "none set here (each batch's orchestration.global_parallel applies)"}; running ${st.slots.length}, queued ${st.queue.length}`);
    const ws = Object.entries(st.weights ?? {});
    console.log(`repo weights: ${ws.length ? ws.map(([r, n]) => `${r}=${n}`).join(", ") : "equal (none set)"}`);
    for (const e of st.slots) console.log(`  running ${who(e)}  dispatcher ${e.pid}${e.lanePid ? ` lane ${e.lanePid}` : ""}`);
    for (const e of st.queue) console.log(`  queued  ${who(e)}  dispatcher ${e.pid}`);
    return st;
  }
  if (sub === "cap") {
    if (arg === "--clear") { reg.setCap(null); console.log("host cap cleared"); return { cap: null }; }
    const k = Number(arg);
    if (!/^\d+$/.test(String(arg ?? "")) || !Number.isInteger(k) || k < 1) throw new Error(usage);
    reg.setCap(k);
    console.log(`host cap set to ${k}`);
    return { cap: k };
  }
  if (sub === "weight") {
    if (!arg || arg.startsWith("-")) throw new Error(usage);
    if (arg2 === "--clear") { reg.setWeight(arg, null); console.log(`weight of ${arg} reset to 1`); return { repo: arg, weight: null }; }
    const n = Number(arg2);
    if (!/^\d+$/.test(String(arg2 ?? "")) || !Number.isInteger(n) || n < 1) throw new Error(usage);
    reg.setWeight(arg, n);
    console.log(`weight of ${arg} set to ${n}`);
    return { repo: arg, weight: n };
  }
  throw new Error(usage);
}

/** #4773: is the author of a `gh issue view --json author,authorAssociation` record trusted (the engine admission's `isTrustedActor`)? */
const bodyTrusted = (v) => isTrustedActor({ association: v?.authorAssociation, type: v?.author?.is_bot ? "Bot" : "User", login: v?.author?.login });

/**
 * forge.yaml `orchestration.breaker` ({errors, window_min}; default 3 engine-errors in 30 min; errors 0 turns it off),
 * `orchestration.max_deferrals` (default 3) and `orchestration.global_parallel` (#4191: host-wide lane cap; unset = none). The parser flattens one nested level, so the breaker keys arrive as
 * `orchestration.errors|window_min` (or flat `breaker_errors|breaker_window_min`).
 * `orchestration.recovery.max_attempts` (#4267; arrives as `max_attempts`, or flat `recovery_max_attempts`): recovery lanes per
 * issue for a mechanical needs-human, default 1, 0 turns recovery off. `orchestration.recovery.mechanical_max_attempts` (#4725; or
 * `mechanical_max_attempts`): the separate budget of env.*, base.conflict and conflicting-PR rows, default 2, never below `max_attempts`.
 * `orchestration.base_sync.enabled` (#4525; default true, false opts out) and `base_sync.union_globs` (comma list of globs of
 * append-only files whose two-sided line additions a parked PR's base sync keeps both of).
 * `orchestration.blocked_label` (#4773; default `blocked`, empty turns it off): an open issue carrying it is admitted but not dispatched.
 */
export function readOrchestration(cwd = process.cwd()) {
  let o = {};
  try { o = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.orchestration ?? {}; } catch { o = {}; }
  const int = (v, d) => { const n = Number(v); return v !== undefined && v !== "" && Number.isInteger(n) && n >= 0 ? n : d; };
  const errors = int(o.breaker_errors ?? o.errors, 3), windowMin = int(o.breaker_window_min ?? o.window_min, 30);
  const gp = int(o.global_parallel, null);
  const recoveryMax = int(o.recovery_max_attempts ?? o.max_attempts, 1);
  return { breaker: errors > 0 && windowMin > 0 ? { errors, window_min: windowMin } : null, maxDeferrals: int(o.max_deferrals, 3), blockedLabel: String(o.blocked_label ?? "blocked").trim(), globalParallel: gp >= 1 ? gp : null,
    recovery: { maxAttempts: recoveryMax, mechanicalMaxAttempts: Math.max(int(o.recovery_mechanical_max_attempts ?? o.mechanical_max_attempts, 2), recoveryMax) }, // #4725: env/base/sequence codes have their own budget
    // #4525: parked-PR base sync. The parser flattens one level, so `base_sync.enabled|union_globs` arrive as `enabled|union_globs` (or flat `base_sync_*`).
    baseSync: { enabled: String(o.base_sync_enabled ?? o.enabled ?? "true").trim().toLowerCase() !== "false",
      unionGlobs: String(o.base_sync_union_globs ?? o.union_globs ?? "").replace(/^\[|\]$/g, "").split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean) } };
}

/**
 * forge.yaml `orchestrate.drift` (#4161): `{pairGrowth, packageLines, fileLines, blockDispatch, generatedGlobs}` with
 * only the positive-integer thresholds set, or null when no threshold and no `block_dispatch: true` is set (summary
 * only: no script run, no issue, no hold). The parser flattens `orchestrate.drift.*` to `orchestrate.*`.
 */
export function readDrift(cwd = process.cwd()) {
  let o = null;
  try { o = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.orchestrate ?? null; } catch { o = null; }
  if (!o || typeof o !== "object") return null;
  const int = (v) => { const n = Number(v); return v !== undefined && String(v).trim() !== "" && Number.isInteger(n) && n > 0 ? n : null; };
  const out = { pairGrowth: int(o.pair_growth), packageLines: int(o.package_lines), fileLines: int(o.file_lines),
    blockDispatch: String(o.block_dispatch ?? "").trim() === "true",
    generatedGlobs: String(o.generated_globs ?? "").split(",").map((x) => x.trim()).filter(Boolean) };
  return out.pairGrowth == null && out.packageLines == null && out.fileLines == null && !out.blockDispatch ? null : out;
}

/**
 * forge.yaml text without the `maintenance.hotspot:` sub-map (forge#4195, read by scripts/hotspots.sh via yq). The
 * parser flattens one nested level, so its `enabled`/`file_lines` would otherwise overwrite the budget's own keys.
 */
function withoutHotspotMap(raw) {
  let inMaint = false, sub = -1;
  return String(raw).split(/\r?\n/).filter((l) => {
    if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(l)) { inMaint = /^maintenance:\s*(?:#.*)?$/.test(l); sub = -1; return true; }
    const indent = /^\s*/.exec(l)[0].length;
    if (sub >= 0) { if (/^\s*(?:#.*)?$/.test(l) || indent > sub) return false; sub = -1; }
    if (inMaint && /^\s+hotspot:\s*(?:#.*)?$/.test(l)) { sub = indent; return false; }
    return true;
  }).join("\n");
}

export const DEFAULT_MAINTENANCE_LABELS = ["maintenance", "refactor:split", "dead-code"];

/**
 * forge.yaml `maintenance:` (#4197): null unless `enabled: true`. `share` in (0,1] (default 0.2), `when_idle` (default
 * true), `labels` comma-separated (default maintenance,refactor:split,dead-code), `scan` (default weekly), and the
 * maintenance-scan thresholds `file_lines` (2000) / `doc_kb` (64). Block form only: the parser does not read `{ ... }`.
 */
export function readMaintenance(cwd = process.cwd()) {
  let m = null;
  try { m = parseForgeYaml(withoutHotspotMap(readFileSync(join(cwd, "forge.yaml"), "utf8")))?.maintenance ?? null; } catch { m = null; }
  if (!m || typeof m !== "object" || String(m.enabled ?? "").trim() !== "true") return null;
  const num = (v, d, ok) => { const n = Number(v); return v !== undefined && v !== "" && ok(n) ? n : d; };
  const labels = String(m.labels ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return { share: num(m.share, 0.2, (n) => n > 0 && n <= 1), whenIdle: String(m.when_idle ?? "true").trim() !== "false",
    labels: labels.length ? labels : [...DEFAULT_MAINTENANCE_LABELS], scan: String(m.scan ?? "weekly").trim() || "weekly",
    fileLines: num(m.file_lines, 2000, (n) => Number.isInteger(n) && n > 0), docKb: num(m.doc_kb, 64, (n) => n > 0) };
}

/** `--prefilter-model M`, else forge.yaml `engine.lean_prefilter_model`, else the pre-filter default. */
function prefilterModel(argv) {
  const m = flag(argv, "--prefilter-model") ?? readLeanSetting("prefilter_model");
  return m ? { model: m } : {};
}

/**
 * `forgedock triage <issue...> [--parallel K] [--lane L] [--repo owner/repo] [--dry-run] [--prefilter-model M]` (#4123)
 * Issues are checked through a bounded pool of K (default 8, #4141); each lane is fetched once; rows print in input order.
 * Each issue is checked against its own lane (#4125); `--lane` is an assertion, a refused lane is reported and dropped.
 * Runs only the already-fixed pre-filter: closes issues it proves fixed (with evidence), parks post-deploy follow-ups
 * whose parent fix is not on the default branch (#4389), and prints the issues that still need a lane as the last line (`lanes: #1 #2`). `--dry-run` reports candidates without a model call or close.
 */
export async function triageFromCli(argv, deps = {}) {
  const valued = ["--lane", "--repo", "--prefilter-model", "--parallel"];
  const issues = [];
  for (let i = 0; i < argv.length; i++) {
    if (valued.includes(argv[i])) { i++; continue; }
    if (/^#?\d+$/.test(argv[i])) issues.push(parseInt(argv[i].replace("#", ""), 10));
  }
  if (!issues.length) throw new Error("usage: forgedock triage <issue...> [--lane L] [--repo owner/repo] [--dry-run]");
  const lane = flag(argv, "--lane");
  const io = deps.io ?? makeIo();
  const repo = flag(argv, "--repo") ?? (await resolveDefaultRepo(io));
  if (!repo) throw new Error("triage needs the repo: pass --repo or run inside a checkout with a GitHub remote");
  const leanIo = deps.leanIo ?? (await import("./lean/effects.mjs")).makeLeanIo({ repo });
  const { prefilterIssue, formatPrefilterSummary, formatParkedLine, lazyDefaultBranch } = await import("./lean/prefilter.mjs");
  const branches = readBranches();
  const gate = { defaultBranch: lazyDefaultBranch({ io: leanIo, repo, cwd: process.cwd(), configured: branches.default }), preconditionCmd: readPreconditionCmd(), minAge: await readPostDeployMinAge() }; // #4389, #4425
  const parallel = flag(argv, "--parallel") == null ? 8 : parseInt(flag(argv, "--parallel"), 10);
  if (!Number.isInteger(parallel) || parallel < 1) throw new Error("--parallel must be a positive integer");
  // #4141: bounded pool. Each lane is fetched once (memoized promise); output stays in input order.
  const fetched = new Map();
  const fetchLane = (l) => {
    if (!fetched.has(l)) fetched.set(l, leanIo.git(["fetch", "origin", l], { cwd: process.cwd() }).catch(() => { /* offline: use the local ref */ }));
    return fetched.get(l);
  };
  const uniq = [...new Set(issues)];
  const out = new Array(uniq.length);
  const checkOne = async (n) => {
    // #4125: each issue's own lane; `--lane` is an assertion. A refused lane never reaches the pre-filter or a lane.
    const ln = await resolveLane({ issue: n, repo, io: leanIo, cwd: process.cwd(), branches, requested: lane, override: argv.includes("--lane-override") });
    if (!ln.ok) return { line: `#${n} → lane-refused (${ln.code}: ${ln.detail})`, row: { issue: n, outcome: "lane-refused", cost_usd: 0, prefilter: null } };
    await fetchLane(ln.lane);
    const pf = await prefilterIssue({ issue: n, repo, lane: ln.lane, cwd: process.cwd(), io: leanIo, dryRun: argv.includes("--dry-run"), ...prefilterModel(argv), ...gate });
    if (pf.parked) return { line: `#${n} → parked (${pf.kind}: ${pf.detail})`, row: { issue: n, outcome: pf.kind, cost_usd: 0, prefilter: pf } };
    return { line: `#${n} → ${pf.closed ? "closed" : pf.candidate ? "candidate" : "lane"} (${pf.detail})`, row: { issue: n, outcome: pf.closed ? "invalid" : "pending", cost_usd: pf.cost_usd, prefilter: pf } };
  };
  let next = 0, printed = 0;
  const flush = () => { while (printed < out.length && out[printed]) console.log(out[printed++].line); };
  await Promise.all(Array.from({ length: Math.min(parallel, uniq.length) }, async () => {
    while (next < uniq.length) {
      const i = next++;
      try { out[i] = await checkOne(uniq[i]); } catch (e) {
        out[i] = { line: `#${uniq[i]} → lane (pre-filter error: ${String(e?.message ?? e).slice(0, 120)})`, row: { issue: uniq[i], outcome: "pending", cost_usd: 0, prefilter: { closed: false, candidate: false, detail: "pre-filter error", cost_usd: 0 } } };
      }
      flush();
    }
  }));
  const rows = out.map((r) => r.row);
  const lanes = rows.filter((r) => r.prefilter && !r.prefilter.closed && !r.prefilter.parked).map((r) => r.issue);
  console.log(formatPrefilterSummary(rows));
  const parked = formatParkedLine(rows);
  if (parked) console.log(parked);
  console.log(`lanes: ${lanes.map((n) => `#${n}`).join(" ") || "(none)"}`);
  return { rows, lanes };
}

/**
 * `forgedock probe [issue...] [--repo owner/repo] [--dry-run] [--limit N] [--due]` (#4399; `--due` #4627: re-run due windowed post-deploy checks)
 * Runs the declared acceptance probes (`lean/probe.mjs`) of the given issues, or of the recently closed issues that
 * declare one, once their fix is on the default branch; records FORGE:PROBE and reopens on a fail. No model call.
 */
/** `forgedock integration run` (#4667): one pass of the milestone integration runs (lean/integration.mjs). Resolves the exit code. */
export async function integrationFromCli(argv, deps = {}) {
  const { runIntegrationCli: run } = await import("./lean/integration.mjs");
  return run(argv, deps);
}

/** `forgedock milestone-sync <slug> --reason ...` (#4663): on-demand milestone branch sync (lean/milestonesync.mjs). Resolves the exit code. */
export async function milestoneSyncFromCli(argv, deps = {}) {
  const { runMilestoneSyncCli: run } = await import("./lean/milestonesync.mjs");
  return run(argv, deps);
}

/**
 * `forgedock milestone train` (#4658): lean/train.mjs over `orchestrateFromCli` (one batch per milestone) and the #4657 lifecycle.
 * The train reads forge.yaml (`orchestration.global_parallel`, `milestones.close_on`) and never writes it.
 */
export async function trainFromCli(argv, deps = {}) {
  const { trainCli } = await import("./lean/train.mjs");
  const batchMod = await import("./lean/batch.mjs");
  const cwd = process.cwd();
  const io = deps.io ?? makeIo();
  const repo = flag(argv, "--repo") ?? (await resolveDefaultRepo(io));
  if (!repo) throw new Error("milestone train needs the repo: pass --repo or run inside a checkout with a GitHub remote");
  const leanIo = deps.leanIo ?? (await import("./lean/effects.mjs")).makeLeanIo({ repo });
  const { makeLifecycle } = await import("./lean/lifecycle.mjs");
  const { readLive } = await import("../scripts/plan-validate-live.mjs");
  const orchestrate = deps.orchestrate ?? orchestrateFromCli;
  return trainCli(argv, {
    root: deps.batchRoot ?? batchMod.batchRoot(), repo, id: deps.id, print: deps.print,
    globalParallel: readOrchestration(cwd).globalParallel,
    readLive: deps.readLive ?? (() => readLive({ gh: io.gh, repo })),
    onBatchEnd: (titles) => (deps.lifecycle ?? makeLifecycle({ gh: leanIo.gh, git: (a) => leanIo.git(a, { cwd }), repo, closeOn: readMilestoneCloseOn(cwd), defaultBranch: readBranches(cwd).default ?? "main" })).onBatchEnd(titles),
    runMilestone: async (title, { parallel, resume }) => {
      if (resume) return orchestrate(["--resume", resume, "--repo", repo]);
      const open = JSON.parse(String(await io.gh(["issue", "list", "-R", repo, "--milestone", title, "--state", "open", "--limit", "200", "--json", "number"])) || "[]");
      if (!open.length) return { ok: true, rows: [] };
      return orchestrate([...open.map((i) => String(i.number)), "--parallel", String(parallel), "--repo", repo]);
    },
  });
}

/** `forgedock guards list|backfill` (#4692): fix guards from the FORGE:GUARD comments on GitHub. */
export async function guardsFromCli(argv, deps = {}) {
  const { guardsCli } = await import("./lean/guards.mjs");
  const io = deps.io ?? makeIo();
  const repo = flag(argv, "--repo") ?? (await resolveDefaultRepo(io));
  if (!repo) throw new Error("guards needs the repo: pass --repo or run inside a checkout with a GitHub remote");
  const leanIo = deps.leanIo ?? (await import("./lean/effects.mjs")).makeLeanIo({ repo });
  return guardsCli(argv.filter((a, i) => a !== "--repo" && argv[i - 1] !== "--repo"), { gh: (a) => leanIo.gh(a), git: (a) => leanIo.git(a, { cwd: process.cwd() }), repo, print: deps.print, root: deps.root });
}

/** forge.yaml `ci` (#4667): the milestone integration config, or null when no `workflow` is set (feature off). */
export function readIntegration(cwd = process.cwd()) {
  let ci = null;
  try { ci = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.ci ?? null; } catch { ci = null; }
  return import("./lean/integration.mjs").then((m) => m.parseIntegration(ci));
}

export async function probeFromCli(argv, deps = {}) {
  const valued = ["--repo", "--limit"];
  const issues = [];
  const due = argv.includes("--due"); // #4627
  for (let i = 0; i < argv.length; i++) {
    if (valued.includes(argv[i])) { i++; continue; }
    if (/^#?\d+$/.test(argv[i])) issues.push(parseInt(argv[i].replace("#", ""), 10));
  }
  const io = deps.io ?? makeIo();
  const repo = flag(argv, "--repo") ?? (await resolveDefaultRepo(io));
  if (!repo) throw new Error("probe needs the repo: pass --repo or run inside a checkout with a GitHub remote");
  const limit = flag(argv, "--limit") == null ? 50 : parseInt(flag(argv, "--limit"), 10);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  const leanIo = deps.leanIo ?? (await import("./lean/effects.mjs")).makeLeanIo({ repo });
  if (due) {
    const { sweepDue, formatDueSummary } = await import("./lean/postdeploy-monitor.mjs");
    const rows = await sweepDue({ repo, cwd: process.cwd(), io: leanIo, dryRun: argv.includes("--dry-run"), onResult: probeEventSink(repo), ...(deps.spawn ? { spawn: deps.spawn } : {}) });
    for (const r of rows) console.log(`#${r.issue} → ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`);
    console.log(formatDueSummary(rows) || "monitoring: nothing due");
    const parkedRows = await sweepParkedFollowups({ repo, io: leanIo, dryRun: argv.includes("--dry-run") }); // #4689
    for (const r of parkedRows) console.log(`#${r.issue} → ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`);
    const { formatParkedSweepSummary } = await import("./lean/parked-sweep.mjs");
    console.log(formatParkedSweepSummary(parkedRows) || "parked: nothing released");
    return { rows, parkedRows };
  }
  const { sweepProbes, formatProbeSummary } = await import("./lean/probe.mjs");
  const rows = await sweepProbes({ repo, cwd: process.cwd(), io: leanIo, issues: [...new Set(issues)], limit, dryRun: argv.includes("--dry-run"), onResult: probeEventSink(repo), ...(deps.spawn ? { spawn: deps.spawn } : {}) });
  for (const r of rows) console.log(`#${r.issue} → ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`);
  console.log(formatProbeSummary(rows) || "probes: nothing to run");
  return { rows };
}
