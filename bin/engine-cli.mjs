/**
 * Headless entry point: `forgedock run-issue <issue>` drives one issue through the
 * durable engine; scanStalls finds dead-lease issues for the orchestrator to resume.
 * `forgedock resume-stalled [--dry-run] [--lane <lane>]` enumerates all in-flight
 * issues, calls scanStalls, and re-dispatches each stalled issue via run-issue.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir, hostname } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { runIssue, DEFAULT_MAX_ATTEMPTS, sanitizeLeaseHost } from "./engine.mjs";
import { makeProjector } from "./engine/projector.mjs";
import { readLog, deriveState } from "./engine/runlog.mjs";
import { assertOpenCodeNativeRuntime } from "./runner.mjs";
import { parseForgeYaml } from "./forge-utils.mjs";
import { makeEmitTelemetry } from "./engine/telemetry-seam.mjs";
import { readBranches, resolveLane, isDefaultLane } from "./lean/lane.mjs";
import { parseVerify } from "./lean/verify.mjs";
import { parseExecution } from "./lean/execution.mjs";
import { writeAtomic as writeResultAtomic } from "./lean/batch.mjs";
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
const warnedContextPack = new Set();
const stderrWarn = (m) => { if (!warnedContextPack.has(m)) { warnedContextPack.add(m); process.stderr.write(`${m}\n`); } };
/**
 * forge.yaml context pack (#4275), flat keys under `engine` (the parser flattens one level): `context_pack`
 * (shadow|on|off), `context_pack_sources` (comma list of graph,attempts,ledger,facts), `context_pack_bytes`,
 * `context_pack_days`. undefined when none is set (the core defaults to shadow). An invalid mode warns through `warn`
 * (stderr, once per message per process) and is dropped; the other keys are kept (#4298).
 */
export function readContextPack(cwd = process.cwd(), warn = stderrWarn) {
  try {
    const e = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.engine ?? {};
    let mode = String(e.context_pack ?? "").trim().toLowerCase();
    if (mode && !["shadow", "on", "off"].includes(mode)) {
      warn(`forge.yaml engine.context_pack: invalid mode "${mode}" (expected shadow|on|off); using the default, other context_pack_* keys kept`);
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
export function readAdmission(cwd = process.cwd()) {
  try {
    const e = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.engine ?? {};
    const num = (v) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : undefined; };
    const en = String(e.admission_enabled ?? e.enabled ?? "").trim().toLowerCase();
    return { ...(en === "false" ? { enabled: false } : {}),
      min_free_mem_mb: num(e.min_free_mem_mb ?? e.admission_min_free_mem_mb), min_free_tmp_mb: num(e.min_free_tmp_mb ?? e.admission_min_free_tmp_mb),
      max_load_per_core: num(e.max_load_per_core ?? e.admission_max_load_per_core) };
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
 * `lane_limits_memory_max`/`lane_limits_cpu_quota`). `engine.cli_idle_minutes` (default 15) and `engine.cli_max_minutes` (default 180).
 */
export function readCoreLimits(cwd = process.cwd()) {
  try {
    const y = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8")) ?? {};
    const pick = (k) => { for (const sec of [y.pipeline, y.engine]) { const v = sec?.[k] ?? sec?.[`lane_limits_${k}`]; if (v !== undefined && v !== "") return String(v).trim(); } return undefined; };
    const mem = pick("memory_max"), cpu = pick("cpu_quota");
    const posNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; };
    return {
      ...(mem || cpu ? { laneLimits: { ...(mem ? { memory_max: mem } : {}), ...(cpu ? { cpu_quota: cpu } : {}) } } : {}),
      ...(posNum(y.engine?.cli_idle_minutes) ? { cliIdleMinutes: posNum(y.engine.cli_idle_minutes) } : {}),
      ...(posNum(y.engine?.cli_max_minutes) ? { cliMaxMinutes: posNum(y.engine.cli_max_minutes) } : {}),
    };
  } catch { return {}; }
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
    return sec && typeof sec === "object" ? parseVerify(sec) : undefined;
  } catch { return undefined; }
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
  let raw;
  try { raw = readFileSync(join(cwd, "forge.yaml"), "utf8"); } catch { return undefined; }
  const out = [];
  let inLearned = false, listIndent = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) { inLearned = /^learned:\s*(#.*)?$/.test(line); listIndent = null; continue; }
    if (!inLearned) continue;
    const indent = line.length - line.trimStart().length;
    if (listIndent === null) {
      if (/^\s+test_commands:\s*(#.*)?$/.test(line)) listIndent = indent;
      continue;
    }
    if (indent <= listIndent) { listIndent = /^\s+test_commands:\s*(#.*)?$/.test(line) ? indent : null; continue; }
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
 * @returns {string} multi-line diagnostic block (no trailing newline)
 */
export function formatTerminalDiagnostics(dir, issue) {
  if (!Number.isInteger(issue)) {
    return `  run-log: <invalid issue: ${JSON.stringify(issue)}>`;
  }
  const runLogPath = join(dir, `${issue}.jsonl`);
  let events = [];
  try {
    events = readLog(dir, issue);
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
  lines.push(`  run-log: ${runLogPath}`);
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
    const issue = parseInt(f.slice(0, -".jsonl".length), 10);
    if (!Number.isInteger(issue)) continue;
    try {
      const events = readLog(dir, issue);
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
  // forge#2240: print the run-log path at the very start of the run, not only
  // in the non-merged completion diagnostics (formatTerminalDiagnostics prints
  // it too, but only post-completion and only for non-"merged" outcomes). A
  // caller tailing this process's stdout should be able to find the run-log
  // to inspect immediately, without waiting for the run to finish.
  console.log(`run-log: ${join(dir, `${issue}.jsonl`)}`);
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
    const leanRepo = repo ?? (await resolveDefaultRepo(io));
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
      emitTelemetry: deps.emitTelemetry ?? makeEmitTelemetry({ repo: leanRepo }),
      admission: readAdmission(), heavy: readHeavy(), ...readCoreLimits(), ...readEnvConfig(), ...(readMergeWait() ? { mergeWait: readMergeWait() } : {}), ...(readConformanceMode() ? { conformance: readConformanceMode() } : {}), ...(readContextPack() ? { contextPack: readContextPack() } : {}), ...(readReviewIncomplete() ? { reviewIncomplete: readReviewIncomplete() } : {}), ...(readReproTest() ? { reproTest: readReproTest() } : {}), ...(readCloseParent() ? { closeParent: true } : {}), ...(readReviewTrigger() ? { reviewTrigger: readReviewTrigger() } : {}), ...(readVerify() ? { verify: readVerify() } : {}), ...readPrecheckOptions(), ...(model ? { builderModel: model } : {}), ...(readLeanSetting("reviewer_model") ? { reviewerModel: readLeanSetting("reviewer_model") } : {}), ...(readFixModel() ? { fixModel: readFixModel() } : {}), ...(readVerifier() ? { verifier: readVerifier() } : {}) });
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
    console.log(formatTerminalDiagnostics(dir, issue));
  } else {
    // forge#2399: formatTerminalDiagnostics() (and its phase/reason/state
    // block) intentionally stays gated to non-merged outcomes above, but the
    // aggregate token-usage total should print for "total tokens per run" to
    // hold on the common success case too — surface just the usage line here
    // rather than the full diagnostic block.
    try {
      const usageLine = formatUsageLine(aggregateUsage(readLog(dir, issue)));
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
 * `forgedock orchestrate --resume <batch-id>` · `forgedock orchestrate --set-parallel <batch-id> <K>`
 * Runs core work-on per issue with K concurrency (default 3), honouring `Depends on` / `Blocked by` among the given issues.
 * A `dependency-open` issue is requeued behind its dependency; a `decomposed` one adds its sub-issues (#4124).
 * The already-fixed pre-filter (#4123) runs before each lane unless `--no-prefilter`.
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
 */
export async function orchestrateFromCli(argv, deps = {}) {
  const inProcess = deps.inProcess || deps.leanModule || deps.laneScript || deps.batchRoot || deps.leanIo
    || argv.includes("--foreground") || process.env.FORGEDOCK_SCHEDD === "0";
  if (inProcess) return runBatch({ argv: argv.filter((a) => a !== "--foreground"), cwd: process.cwd(), env: process.env, sink: consoleSink(), deps });
  return orchestrateClient(argv, deps);
}

const formatRowLine = (r) => (r.issue == null ? `${r.outcome}: ${r.detail}` : `#${r.issue} → ${r.outcome}${r.detail && r.outcome !== "merged" ? ` (${r.detail})` : ""}`);
const consoleSink = () => ({ batch: () => {}, row: (r) => console.log(formatRowLine(r)), line: (t) => console.log(t) });

const ORCH_USAGE = "usage: forgedock orchestrate <issue...> [--parallel K] [--lane L] [--lane-override] [--repo owner/repo] | --resume <id> | --set-parallel <id> <K>";
const ORCH_VALUED = ["--parallel", "--lane", "--repo", "--model", "--prefilter-model"];
const issuesOf = (argv) => {
  const issues = [];
  for (let i = 0; i < argv.length; i++) {
    if (ORCH_VALUED.includes(argv[i])) { i++; continue; }
    if (/^#?\d+$/.test(argv[i])) issues.push(parseInt(argv[i].replace("#", ""), 10));
  }
  return issues;
};
const parallelOf = (argv) => {
  const parallel = flag(argv, "--parallel") == null ? 3 : parseInt(flag(argv, "--parallel"), 10);
  if (!Number.isInteger(parallel) || parallel < 1) throw new Error("--parallel must be a positive integer");
  return parallel;
};

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
  const resumeId = flag(argv, "--resume");
  let msg;
  if (resumeId) msg = { op: "attach", id: resumeId };
  else {
    if (!issuesOf(argv).length) throw new Error(ORCH_USAGE);
    parallelOf(argv);
    let sub = [...argv];
    if (!flag(sub, "--repo")) {
      const repo = await resolveDefaultRepo(deps.io ?? makeIo());
      if (!repo) throw new Error("orchestrate needs the repo: pass --repo or run inside a checkout with a GitHub remote");
      sub = [...sub, "--repo", repo];
    }
    msg = { op: "submit", argv: sub, cwd: process.cwd(), env: schedd.batchEnv(process.env) };
  }
  const sock = await connect();
  let id = resumeId;
  try {
    const done = await schedd.request(sock, msg, (m) => {
      if (m.type === "batch") id = m.id;
      else if (m.type === "row") console.log(formatRowLine(m.row));
      else if (m.type === "line") console.log(m.text);
      else if (m.type === "done" && m.replay && m.report) console.log(m.report);
    });
    return done.result;
  } catch (e) {
    if (id && /closed the connection/.test(e?.message ?? "")) throw new Error(`${e.message}; the batch keeps its state: forgedock orchestrate --resume ${id}`);
    throw e;
  }
}

/**
 * One batch from start to report, in this process: the in-process `orchestrate` path and the schedd daemon's per-batch
 * runner (#4192). `cwd` and `env` are the submitting client's (`env` picks the lanes' account); output goes to `sink`
 * (`batch(b)` once the batch exists, `row(r)` per update, `line(text)` otherwise). A daemon-hosted batch records
 * `daemon: true` and the allowlisted env in its plan, so a restarted daemon resumes it on the same account; `keepBreaker`
 * (a daemon restart, not the operator's resume) leaves a tripped breaker tripped. Writes `report.json` when done.
 */
export async function runBatch({ argv, cwd: callerCwd = process.cwd(), env: callerEnv = process.env, sink = consoleSink(), deps = {}, keepBreaker = false, daemon = false }) {
  const batchMod = await import("./lean/batch.mjs");
  const root = deps.batchRoot ?? batchMod.batchRoot();
  if (argv.includes("--set-parallel")) {
    const i = argv.indexOf("--set-parallel");
    const b = batchMod.openBatch(root, argv[i + 1]);
    if (!b.exists()) throw new Error(`no batch ${argv[i + 1]} in ${root}`);
    const k = Number(argv[i + 2]);
    b.setParallel(k);
    sink.line(`batch ${b.id}: parallel set to ${k}`);
    return { ok: true, batch: b.id, parallel: k };
  }
  const resumeId = flag(argv, "--resume");
  let batch, plan = null;
  if (resumeId) {
    batch = batchMod.openBatch(root, resumeId);
    plan = batch.readPlan();
    if (!plan) throw new Error(`no batch ${resumeId} in ${root}`);
    argv = plan.argv;
  }
  const issues = issuesOf(argv);
  if (!issues.length) throw new Error(ORCH_USAGE);
  const parallel = parallelOf(argv);
  // The lanes' env: a resumed daemon batch uses the env its plan kept, over the daemon's own.
  // A pre-#4192 batch resumed by the daemon kept no env: its lanes use the daemon's.
  const kept = plan?.env ?? (resumeId ? null : daemon || callerEnv !== process.env ? callerEnv : null);
  const env = kept ? (await import("./lean/schedd.mjs")).mergeEnv(process.env, kept) : process.env;
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
    const base = deps.batchId ?? batchMod.newBatchId();
    batch = batchMod.openBatch(root, base);
    for (let i = 2; batch.exists(); i++) batch = batchMod.openBatch(root, `${base}.${i}`); // never resume by accident
    plan = { v: 1, id: batch.id, argv: [...argv], repo, cwd, created: new Date().toISOString(), ...(daemon ? { daemon: true, env: kept } : {}) };
    batch.writePlan(plan);
    batch.setParallel(parallel);
  } else {
    // A resume is the operator's decision to continue: the breaker starts closed again.
    const st = batch.store.load();
    if (st && !keepBreaker) batch.store.save({ ...st, breaker: null, errorTimes: [] });
    if (daemon && !plan.daemon) batch.writePlan({ ...plan, daemon: true }); // a daemon restart resumes it from now on
    batch.clearReport();
  }
  sink.batch?.(batch);
  sink.line(`batch: ${batch.id} (${batch.dir}); resume with: forgedock orchestrate --resume ${batch.id}`);
  const dir = deps.dir ?? runDir();
  const { orchestrate, formatTable, formatWaitSummary, formatSandboxSummary, formatOutcomeLists, formatAlertLines } = await import("./lean/orchestrate.mjs");
  const { formatPrecheckSummary } = await import("./lean/precheck.mjs");
  const { formatFirstPassSummary } = await import("./lean/fixround.mjs");
  const leanIo = deps.leanIo ?? (await import("./lean/effects.mjs")).makeLeanIo({ repo });
  const { makePrefilter, formatPrefilterSummary } = await import("./lean/prefilter.mjs");
  const prefilter = argv.includes("--no-prefilter") ? null
    : makePrefilter({ repo, cwd, io: leanIo, ...prefilterModel(argv) });
  const branches = readBranches(cwd);
  const fetched = new Set();
  const laneOf = async (n) => {
    const r = await resolveLane({ issue: n, repo, io: leanIo, cwd, branches, requested: lane, override: laneOverride });
    if (r.ok && prefilter && !fetched.has(r.lane)) { fetched.add(r.lane); try { await leanIo.git(["fetch", "origin", r.lane], { cwd }); } catch { /* offline: use the local ref */ } }
    return r;
  };
  // Lanes: in-process `runCore` when a lean module is injected (tests), otherwise detached `run-issue` processes, or
  // sandboxes when forge.yaml `execution` places them remote (#4253).
  const labelsOf = new Map(); // issue -> label names, filled by readBody (one gh call per issue)
  let lanes, remote = null, execBudget = null, execConf = null, hybrid = false;
  const execMode = () => (deps.execution !== undefined ? deps.execution : readExecution(cwd))?.mode ?? "local";
  if (deps.leanModule) {
    const { runCore } = deps.leanModule;
    const emitTelemetry = deps.emitTelemetry ?? makeEmitTelemetry({ repo });
    lanes = { adopt: null, runOne: (n, ln, ctx = {}) => runCore({ issue: n, repo, lane: ln, laneOverride, ...(ctx.placement ? { placement: { ...ctx.placement, mode: execMode() } } : {}), ...(ctx.recover ? { recover: ctx.recover } : {}), branches, cwd, dir, io: leanIo, agentId: `orch_${process.pid}_${n}`, emitTelemetry, batchId: batch.id,
      admission: readAdmission(cwd), heavy: readHeavy(cwd), ...readCoreLimits(cwd), ...readEnvConfig(cwd), ...(readMergeWait(cwd) ? { mergeWait: readMergeWait(cwd) } : {}), ...(readConformanceMode(cwd) ? { conformance: readConformanceMode(cwd) } : {}), ...(readContextPack(cwd) ? { contextPack: readContextPack(cwd) } : {}), ...(readReviewIncomplete(cwd) ? { reviewIncomplete: readReviewIncomplete(cwd) } : {}), ...(readReproTest(cwd) ? { reproTest: readReproTest(cwd) } : {}), ...(readCloseParent(cwd) ? { closeParent: true } : {}), ...(readReviewTrigger(cwd) ? { reviewTrigger: readReviewTrigger(cwd) } : {}), ...(readVerify(cwd) ? { verify: readVerify(cwd) } : {}), ...readPrecheckOptions(cwd), ...(model ? { builderModel: model } : {}), ...(readLeanSetting("reviewer_model", cwd) ? { reviewerModel: readLeanSetting("reviewer_model", cwd) } : {}), ...(readFixModel(cwd) ? { fixModel: readFixModel(cwd) } : {}), ...(readVerifier(cwd) ? { verifier: readVerifier(cwd) } : {}) }) };
  } else {
    const laneScript = deps.laneScript ?? fileURLToPath(new URL("./forgedock.mjs", import.meta.url));
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
    hybrid = exec?.mode === "hybrid" && Number.isInteger(exec.maxRemote) && exec.maxRemote >= 1;
    if (exec && (execMod.placement(exec) === "remote" || hybrid)) {
      // #4253: lanes run in sandboxes, ledger-tracked per lane, admitted against max_remote instead of the host cap.
      let gitDir = null;
      try { gitDir = resolvePath(cwd, String(await leanIo.git(["rev-parse", "--git-common-dir"], { cwd })).trim()); } catch { gitDir = null; }
      const provider = deps.sandboxProvider ?? execMod.providerByName(exec.provider, { batch, repo, cwd, image: exec.image, gitDir, script: laneScript, bin: deps.laneBin, exec, env });
      const { makeLedger } = await import("./lean/ledger.mjs");
      const ledgerFor = deps.sandboxLedger ?? ((n) => makeLedger({ batch: batch.id, lane: `sandbox-${n}`, owner: `orch_${process.pid}`, issue: n }));
      const bud = exec.budget ?? {};
      const remoteLanes = execMod.providerLanes({ provider, laneArgs, ledgerFor, env, secrets: exec.secrets, costPerMinute: bud.costPerMinute ?? 0,
        ...(deps.now ? { now: deps.now } : {}), ...(deps.pollMs ? { pollMs: deps.pollMs } : {}) });
      lanes = withPlacement(remoteLanes);
      if (bud.onBudget === "local" || hybrid) {
        // #4255: once the budget refuses a remote lane, the rest run as detached host lanes. #4256: hybrid mixes both.
        const local = batchMod.detachedLanes({ batch, cwd, env, script: laneScript, bin: deps.laneBin, pollMs: deps.pollMs, laneArgs });
        lanes = withPlacement({
          runOne: (n, ln, ctx = {}) => (ctx.remote ? remoteLanes : local).runOne(n, ln, ctx),
          adopt: (n, rec) => (rec?.remote || rec?.handle ? remoteLanes : local).adopt(n, rec),
        });
      }
      // #4255: hard execution budget per batch and per host UTC day; every settled sandbox is recorded and reported.
      execConf = exec;
      execBudget = deps.executionBudget ?? execMod.openExecutionBudget({ budget: bud, file: execMod.executionBudgetFile(env), ...(deps.now ? { now: deps.now } : {}) });
      const emitSbx = deps.emitTelemetry ?? makeEmitTelemetry({ repo });
      // #4256: hybrid places each lane from facts (pure placeLane); validation weight is a repo fact, read once per batch.
      const place = hybrid ? await (async () => {
        const verifyMode = (deps.verify !== undefined ? deps.verify : readVerify(cwd))?.mode ?? "local";
        let weight = deps.validationWeight ?? null;
        if (!weight) { try { weight = await execMod.validationWeight({ cwd, precheckCommands: readPrecheckCommands(cwd) ?? [] }); } catch { weight = { heavy: false, signals: [] }; } }
        const headroom = deps.hostHeadroom ?? (() => execMod.hostHeadroom({ cfg: readAdmission(cwd), heavyCfg: readHeavy(cwd) }));
        return (n) => execMod.placeLane({ exec, verifyMode, labels: labelsOf.get(n) ?? [], weight, headroom: headroom() });
      })() : null;
      remote = {
        max: exec.maxRemote, isRemote: () => true, ...(place ? { place, fallbackLocal: true } : {}), onBudget: bud.onBudget ?? "stop", costPerMinute: bud.costPerMinute ?? 0,
        admit: (u) => execBudget.admit(u),
        onUsage: (n, sb, rec) => {
          const startedAt = rec?.handle?.startedAt ?? rec?.startedAt ?? "?";
          try { execBudget.record(`${batch.id}#${sb.id ?? n}#${startedAt}`, sb); } catch { /* the batch total still counts it */ }
          Promise.resolve(emitSbx({ event: "SANDBOX_USAGE", issue: n, provider: sb.provider, sandbox_id: sb.id, minutes: sb.minutes, cost_usd: sb.cost_usd, batch: batch.id })).catch(() => {});
        },
      };
      sink.line(`execution: ${hybrid ? "hybrid" : "remote"} via ${provider.name}, max_remote ${exec.maxRemote}`);
    } else {
      lanes = withPlacement(batchMod.detachedLanes({ batch, cwd, env, script: laneScript, bin: deps.laneBin, pollMs: deps.pollMs, laneArgs }));
    }
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
  let rows;
  try {
    rows = await orchestrate({
      beforeAdmit,
      issues, parallel, prefilter, resolveLane: laneOf, store: batch.store, getParallel: batch.readParallel, ...lanes,
      breaker: orch.breaker, maxDeferrals: orch.maxDeferrals, ...(deps.pollMs ? { pollMs: deps.pollMs } : {}), ...budget, limits, identity, batchId: batch.id, drift,
      ...(registry ? { sched: { registry, batch: batch.id, repo, cap: orch.globalParallel ?? null }, priorityOf: async (n) => schedMod.priorityFromLabels(await labelNames(n)) } : {}),
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
      // #4318: a dispatcher signal relabels the queued recoveries before it exits (the daemon resumes its batches instead)
      ...(daemon ? {} : { onExit: (fn) => { exitRelabel = fn; } }),
      conflicting: deps.conflicting ?? (async (_n, pr) => {
        try { return JSON.parse(await leanIo.gh(["pr", "view", String(pr), "-R", repo, "--json", "mergeable"]))?.mergeable === "CONFLICTING"; } catch { return false; }
      }),
      onCrossLane: (e) => {
        crossLane.push(e);
        sink.line(`cross-lane: #${e.issue} (${e.lane}) depends on #${e.dependency} (${e.dependencyLane}); its fix will not be on ${e.lane}: re-milestone #${e.dependency} or wait for a milestone sync`);
      },
      readBody: maint || registry || hybrid
        ? async (n) => { const v = JSON.parse(await leanIo.gh(["issue", "view", String(n), "-R", repo, "--json", "body,labels"])); labelsOf.set(n, (v.labels ?? []).map((x) => x.name)); return v.body; }
        : async (n) => JSON.parse(await leanIo.gh(["issue", "view", String(n), "-R", repo, "--json", "body"])).body,
      onUpdate: (r) => sink.row(r),
    });
  } finally { for (const [sig, f] of Object.entries(handlers)) off(sig, f); }
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
 * #4318: the batch runner's needs-human relabel. Re-reads the issue first: closed, or a live FORGE:STATE lease (the runner
 * never holds one, so it is another actor's) → "skipped". Label first: a failed label add → "failed" with no comment (a
 * resume retries); then the capped FORGE:NEEDS_HUMAN comment, whose failure keeps the label → true.
 */
export function makeRelabelNeedsHuman({ gh, repo, now = () => Date.now() }) {
  return async ({ issue, evidence }) => {
    const { stateOf } = await import("./lean/context.mjs");
    try {
      const v = JSON.parse(await gh(["issue", "view", String(issue), "-R", repo, "--json", "state,body"]));
      if (String(v?.state ?? "").toUpperCase() === "CLOSED") return "skipped";
      const lease = stateOf(v?.body)?.lease;
      if (lease && Number(lease.until) > now()) return "skipped";
    } catch { /* unreadable: relabel as before */ }
    try { await gh(["issue", "edit", String(issue), "-R", repo, "--add-label", "needs-human"]); } catch { return "failed"; }
    try {
      // #4315: the evidence carries the full lane reason; capped so it never exceeds GitHub's comment limit
      const { capComment } = await import("./lean/render.mjs");
      await gh(["issue", "comment", String(issue), "-R", repo, "--body", capComment(`<!-- FORGE:NEEDS_HUMAN -->\n## Needs human\n${evidence}`)]);
    } catch { /* best effort: the label is on, the batch row keeps the evidence */ }
    return true;
  };
}

/** The batch report's "reclaimed" line (#4183). */
export function formatReclaimed(r) {
  if (!r?.enabled) return "reclaimed: off (hygiene.auto_gc: false)";
  const b = r.bytes, size = b >= 1073741824 ? `${(b / 1073741824).toFixed(1)}G` : b >= 1048576 ? `${(b / 1048576).toFixed(1)}M` : b >= 1024 ? `${Math.round(b / 1024)}K` : `${b}B`;
  return `reclaimed: ${r.items} item(s), ${size} (preflight ${r.preflight}, admissions ${r.admissions})`;
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
    console.log(`schedd: pid ${st.pid}, ${st.batches.length} batch(es)${st.batches.length ? ": " + st.batches.map((b) => b.id).join(", ") : ""}`);
    return { running: true, ...st };
  }
  if (argv.length) throw new Error("usage: forgedock schedd [status]");
  const d = await schedd.startDaemon({ dir, runBatch: (a) => runBatch({ ...a, daemon: true, deps: deps.batchDeps ?? {} }) });
  if (!d.running) return d;
  for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, () => d.close());
  await d.closed;
  return { running: false };
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
  const verify = plan ? { mode: plan.mode, precheckTotalSeconds: plan.precheckTotalSeconds, precheckTimeoutSeconds: plan.precheckTimeoutSeconds } : { ...parseVerify({}), ...(readVerify(repo) ?? {}) };
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
  const usage = "usage: forgedock sched show | forgedock sched cap <N>|--clear | forgedock sched weight <owner/repo> <N>|--clear";
  const [sub, arg, arg2] = argv;
  if (!sub || sub === "show") {
    const st = reg.list();
    const who = (e) => `#${e.issue} ${e.repo ?? "-"} batch ${e.batch ?? "-"} P${e.priority}`;
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

/**
 * forge.yaml `orchestration.breaker` ({errors, window_min}; default 3 engine-errors in 30 min; errors 0 turns it off),
 * `orchestration.max_deferrals` (default 3) and `orchestration.global_parallel` (#4191: host-wide lane cap; unset = none). The parser flattens one nested level, so the breaker keys arrive as
 * `orchestration.errors|window_min` (or flat `breaker_errors|breaker_window_min`).
 * `orchestration.recovery.max_attempts` (#4267; arrives as `max_attempts`, or flat `recovery_max_attempts`): recovery lanes per
 * issue for a mechanical needs-human, default 1, 0 turns recovery off.
 */
export function readOrchestration(cwd = process.cwd()) {
  let o = {};
  try { o = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.orchestration ?? {}; } catch { o = {}; }
  const int = (v, d) => { const n = Number(v); return v !== undefined && v !== "" && Number.isInteger(n) && n >= 0 ? n : d; };
  const errors = int(o.breaker_errors ?? o.errors, 3), windowMin = int(o.breaker_window_min ?? o.window_min, 30);
  const gp = int(o.global_parallel, null);
  const recoveryMax = int(o.recovery_max_attempts ?? o.max_attempts, 1);
  return { breaker: errors > 0 && windowMin > 0 ? { errors, window_min: windowMin } : null, maxDeferrals: int(o.max_deferrals, 3), globalParallel: gp >= 1 ? gp : null,
    recovery: { maxAttempts: recoveryMax } };
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
 * Runs only the already-fixed pre-filter: closes issues it proves fixed (with evidence) and prints the issues that
 * still need a lane as the last line (`lanes: #1 #2`). `--dry-run` reports candidates without a model call or close.
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
  const { prefilterIssue, formatPrefilterSummary } = await import("./lean/prefilter.mjs");
  const branches = readBranches();
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
    const pf = await prefilterIssue({ issue: n, repo, lane: ln.lane, cwd: process.cwd(), io: leanIo, dryRun: argv.includes("--dry-run"), ...prefilterModel(argv) });
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
  const lanes = rows.filter((r) => r.prefilter && !r.prefilter.closed).map((r) => r.issue);
  console.log(formatPrefilterSummary(rows));
  console.log(`lanes: ${lanes.map((n) => `#${n}`).join(" ") || "(none)"}`);
  return { rows, lanes };
}
