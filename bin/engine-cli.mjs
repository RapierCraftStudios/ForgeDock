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
import { join } from "node:path";
import { runIssue, DEFAULT_MAX_ATTEMPTS, sanitizeLeaseHost } from "./engine.mjs";
import { makeProjector } from "./engine/projector.mjs";
import { readLog, deriveState } from "./engine/runlog.mjs";
import { assertOpenCodeNativeRuntime } from "./runner.mjs";
import { parseForgeYaml } from "./forge-utils.mjs";
import { makeEmitTelemetry } from "./engine/telemetry-seam.mjs";

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
  const waitCiGreen = async (pr, repo, timeoutSec) => {
    const script = fileURLToPath(new URL("../scripts/wait-ci-green.sh", import.meta.url));
    try {
      // The engine owns the backoff and the budget: each call is ONE read (no in-script polling, no settle hold;
      // the re-dispatched phase re-runs the full gate before any merge).
      const { stdout } = await pexec("bash", [script, String(pr), "-R", String(repo), "--timeout", String(timeoutSec)],
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

/**
 * Resolves the repo `gh` would target by default (i.e. resolved from the cwd
 * git remote), via `gh repo view`. Used to validate an explicit `--repo` flag
 * against the ambient context — see `assertRepoMatchesCwd`.
 * @param {{gh: Function}} io
 * @returns {Promise<string|null>} "owner/repo", or null if it can't be determined
 */
async function resolveDefaultRepo(io) {
  try {
    const out = await io.gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    const repo = String(out).trim();
    return repo || null;
  } catch {
    return null;
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
 * @returns {Promise<void>}
 */
async function assertRepoMatchesCwd(io, repo) {
  if (!repo) return;
  const defaultRepo = await resolveDefaultRepo(io);
  if (defaultRepo === null) {
    throw new Error(
      `--repo ${repo} was given, but the current repo could not be determined (\`gh repo view\` failed) to ` +
      `verify it matches. Refusing to run cross-repo without verification.`
    );
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
 *   --lane <lane>          Required — e.g. `main` or `staging`.
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
 *   --retry                Optional (forge#3511). Reopen a run that ended `engine-error`
 *                          (e.g. a session-limit hit) and resume from its last committed
 *                          phase. A run that ended `phase-complete` (multi-phase issue, phase merged,
 *                          more remain) starts its next cycle from investigate. Other
 *                          terminal reasons are not reopened.
 */
export async function runFromCli(argv, deps = {}) {
  const issue = parseInt(argv[0], 10);
  if (!Number.isInteger(issue)) throw new Error("usage: forgedock run-issue <issue-number> --lane <lane> [--retry] [--wait-lease]");
  assertOpenCodeNativeRuntime({ operation: "forgedock run-issue" });
  const lane = flag(argv, "--lane");
  if (!lane) throw new Error("--lane is required: e.g. --lane main or --lane staging. No default to prevent accidental production targeting.");
  const repo = flag(argv, "--repo");
  const backend = flag(argv, "--backend");
  const model = flag(argv, "--model");
  // Boolean flag: only counts at a flag position, never as another flag's value.
  const retry = argv.some((a, i) => a === "--retry" && !["--lane", "--repo", "--backend", "--model", "--path"].includes(argv[i - 1]));
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
  const io = deps.io ?? makeIo();
  await assertRepoMatchesCwd(io, repo);
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
    const lres = await runCore({ issue, repo: leanRepo, lane, cwd: process.cwd(), dir, io: leanIo, path: enginePath, onProgress,
      emitTelemetry: deps.emitTelemetry ?? makeEmitTelemetry({ repo: leanRepo }),
      admission: readAdmission(), ...readCoreLimits(), ...(readMergeWait() ? { mergeWait: readMergeWait() } : {}), ...(model ? { builderModel: model } : {}), ...(readLeanSetting("reviewer_model") ? { reviewerModel: readLeanSetting("reviewer_model") } : {}) });
    if (lres.code === "host.busy") { console.log(`issue #${issue} → deferred (${lres.detail})`); return lres; }
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
 *   --lane      Lane to pass to run-issue (required — no default to prevent accidental production targeting).
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
  if (!lane) throw new Error("--lane is required for resume-stalled: e.g. --lane main or --lane staging.");
  const repo   = flag(argv, "--repo");

  const io = deps.io ?? makeIo();
  await assertRepoMatchesCwd(io, repo);
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
      await dispatch([String(issue), "--lane", lane, ...(repo ? ["--repo", repo] : [])]);
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
 * `forgedock orchestrate <issue...> [--parallel K] [--lane L] [--repo owner/repo] [--no-prefilter]`
 * Runs core work-on per issue with K concurrency (default 3), honouring `**Depends on**: #X` among the given issues.
 * The already-fixed pre-filter (#4123) runs before each lane unless `--no-prefilter`.
 * Prints a compact summary table. Lane defaults to staging.
 */
export async function orchestrateFromCli(argv, deps = {}) {
  const valued = ["--parallel", "--lane", "--repo", "--model", "--prefilter-model"];
  const issues = [];
  for (let i = 0; i < argv.length; i++) {
    if (valued.includes(argv[i])) { i++; continue; }
    if (/^#?\d+$/.test(argv[i])) issues.push(parseInt(argv[i].replace("#", ""), 10));
  }
  if (!issues.length) throw new Error("usage: forgedock orchestrate <issue...> [--parallel K] [--lane L] [--repo owner/repo]");
  const parallel = flag(argv, "--parallel") == null ? 3 : parseInt(flag(argv, "--parallel"), 10);
  if (!Number.isInteger(parallel) || parallel < 1) throw new Error("--parallel must be a positive integer");
  const lane = flag(argv, "--lane") ?? "staging";
  const model = flag(argv, "--model");
  const io = deps.io ?? makeIo();
  const repo = flag(argv, "--repo") ?? (await resolveDefaultRepo(io));
  if (!repo) throw new Error("orchestrate needs the repo: pass --repo or run inside a checkout with a GitHub remote");
  const dir = deps.dir ?? runDir();
  const { runCore } = deps.leanModule ?? (await import("./lean/lean.mjs"));
  const { orchestrate, formatTable } = await import("./lean/orchestrate.mjs");
  const leanIo = deps.leanIo ?? (await import("./lean/effects.mjs")).makeLeanIo({ repo });
  const emitTelemetry = deps.emitTelemetry ?? makeEmitTelemetry({ repo });
  const { makePrefilter, formatPrefilterSummary } = await import("./lean/prefilter.mjs");
  const prefilter = argv.includes("--no-prefilter") ? null
    : makePrefilter({ repo, lane, cwd: process.cwd(), io: leanIo, ...prefilterModel(argv) });
  if (prefilter) { try { await leanIo.git(["fetch", "origin", lane], { cwd: process.cwd() }); } catch { /* offline: use the local ref */ } }
  const rows = await orchestrate({
    issues, parallel, prefilter,
    readBody: async (n) => JSON.parse(await leanIo.gh(["issue", "view", String(n), "-R", repo, "--json", "body"])).body,
    runOne: (n) => runCore({ issue: n, repo, lane, cwd: process.cwd(), dir, io: leanIo, agentId: `orch_${process.pid}_${n}`, emitTelemetry,
      admission: readAdmission(), ...readCoreLimits(), ...(readMergeWait() ? { mergeWait: readMergeWait() } : {}), ...(model ? { builderModel: model } : {}), ...(readLeanSetting("reviewer_model") ? { reviewerModel: readLeanSetting("reviewer_model") } : {}) }),
    onUpdate: (r) => console.log(`#${r.issue} → ${r.outcome}${r.detail && r.outcome !== "merged" ? ` (${r.detail})` : ""}`),
  });
  console.log("\n" + formatTable(rows));
  const pfLine = formatPrefilterSummary(rows);
  if (pfLine) console.log(pfLine);
  return { rows, ok: rows.every((r) => ["merged", "invalid"].includes(r.outcome)) };
}

/** `--prefilter-model M`, else forge.yaml `engine.lean_prefilter_model`, else the pre-filter default. */
function prefilterModel(argv) {
  const m = flag(argv, "--prefilter-model") ?? readLeanSetting("prefilter_model");
  return m ? { model: m } : {};
}

/**
 * `forgedock triage <issue...> [--lane L] [--repo owner/repo] [--dry-run] [--prefilter-model M]` (#4123)
 * Runs only the already-fixed pre-filter: closes issues it proves fixed (with evidence) and prints the issues that
 * still need a lane as the last line (`lanes: #1 #2`). `--dry-run` reports candidates without a model call or close.
 */
export async function triageFromCli(argv, deps = {}) {
  const valued = ["--lane", "--repo", "--prefilter-model"];
  const issues = [];
  for (let i = 0; i < argv.length; i++) {
    if (valued.includes(argv[i])) { i++; continue; }
    if (/^#?\d+$/.test(argv[i])) issues.push(parseInt(argv[i].replace("#", ""), 10));
  }
  if (!issues.length) throw new Error("usage: forgedock triage <issue...> [--lane L] [--repo owner/repo] [--dry-run]");
  const lane = flag(argv, "--lane") ?? "staging";
  const io = deps.io ?? makeIo();
  const repo = flag(argv, "--repo") ?? (await resolveDefaultRepo(io));
  if (!repo) throw new Error("triage needs the repo: pass --repo or run inside a checkout with a GitHub remote");
  const leanIo = deps.leanIo ?? (await import("./lean/effects.mjs")).makeLeanIo({ repo });
  const { prefilterIssue, formatPrefilterSummary } = await import("./lean/prefilter.mjs");
  try { await leanIo.git(["fetch", "origin", lane], { cwd: process.cwd() }); } catch { /* offline: use the local ref */ }
  const rows = [];
  for (const n of [...new Set(issues)]) {
    const pf = await prefilterIssue({ issue: n, repo, lane, cwd: process.cwd(), io: leanIo, dryRun: argv.includes("--dry-run"), ...prefilterModel(argv) });
    console.log(`#${n} → ${pf.closed ? "closed" : pf.candidate ? "candidate" : "lane"} (${pf.detail})`);
    rows.push({ issue: n, outcome: pf.closed ? "invalid" : "pending", cost_usd: pf.cost_usd, prefilter: pf });
  }
  const lanes = rows.filter((r) => !r.prefilter.closed).map((r) => r.issue);
  console.log(formatPrefilterSummary(rows));
  console.log(`lanes: ${lanes.map((n) => `#${n}`).join(" ") || "(none)"}`);
  return { rows, lanes };
}
