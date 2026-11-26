// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Thin orchestrate: run core work-on for several issues with bounded concurrency, honouring `Depends on` / `Blocked by`
 * among the given issues (wait for the dependency to merge; skip when it ends anywhere but merged/invalid).
 * A `dependency-open` run is requeued behind its dependencies, pulling an out-of-set one into the batch; a
 * `decomposed` run adds its sub-issues and its dependents wait on them instead (#4124); an issue read later (`--add`,
 * `--requeue`, a resume, a body re-read) resolves a decomposed dependency to its sub-issues too (#5112). A dependency that is parked
 * (ended needs-human in this batch, or an out-of-set issue labelled needs-human per `issueLabels(n)`) is never pulled in:
 * the issue ends `skipped` (`dependency #N needs-human`) and its dependents with it (#4387).
 * A skipped dependent whose blocker later closes or merges outside its lane is re-admitted (#4595, needs `dispatchCheck`).
 * No investigation, synthesis or agent spawning. `runOne(issue)` and `readBody(issue)` are injected.
 * Optional `prefilter(issue, lane)` (#4123) runs in the lane slot before `runOne`: when it closed the issue, no lane starts.
 * When it parked the issue (#4389, `parked: true`), no lane starts either and the row ends with the parked kind.
 * Optional `resolveLane(issue)` (#4125) works out each issue's own lane (milestone branch or staging): an issue whose
 * lane is refused ends `lane-refused` without a run, and a dependency edge between two lanes goes to `onCrossLane`.
 *
 * Durable batch runner (#4121): with a `store` every transition is persisted, so a restarted dispatcher continues the
 * batch; lanes it launched that are still alive are re-attached through `adopt(issue, rec, {onLive})` instead of relaunched.
 * A seam calls `onLive()` before it waits on a live lane (#4504); an adopt that resolves first is settled (or requeued on null)
 * before scheduling, so a live lane does not hold up the others.
 * `deferred` is a scheduling fact, not an end: each typed code is requeued with its retry-at (`deferPolicy`), a usage
 * limit (and #5168 a claude login failure, `backend.auth`) holds admissions for that account until its reset, and deferrals other than a wait (`host.busy`,
 * `sandbox.capacity`, #4528; `sandbox.unreachable`, #4788; `rate_limited`, #4784; `backend.auth`, #5168; `backend.cli_failed`, #5762, a capped short retry; `quota.exhausted`, #5236) stop after `maxDeferrals`.
 * #5161: an engine-error whose detail is a transport/gateway failure (`isTransientEngineError`) is requeued with backoff
 * (`transientRetryDelayMs`) up to `transientRetries` times, not counted against `ENGINE_ERROR_RELAUNCHES`; then it ends engine-error.
 * #5112: with `remote.offlineFallback` (`execution.fallback_local`), an issue deferred `remote.capacityFallbackAfter` times (default
 * `CAPACITY_FALLBACK_AFTER`) for `sandbox.capacity` runs on the host when `remote.headroom()` (host-busy guard) allows it.
 * Usage-limit holds (#4190) are keyed by backend identity in `limits` (the host store, shared by every batch on the
 * host; in memory when absent): admission checks the hold of `identity()`, the account the next lane would use. While held, the
 * batch re-reads the store every `pollMs` (#4446), so `forgedock limits clear` admits on the next poll, not at the reset.
 * #5095: `remote.identity()` names the pool's account (execution.mjs `remoteHoldId`); while it is held, a remote-placed lane
 * runs local in hybrid (`fallbackLocal`, local account not held) or waits for the reset; admission is not held. #5203: under a
 * rotator with headroom a pool usage limit reruns at once (`quotaRequeue` `poolId`) and records no pool hold; with no headroom the
 * hold lasts until `rotator.resumeAt()` (the earliest reset). `--requeue` of a quota-paused pending issue clears its notBefore
 * and the pool hold (`drainRequeues`). An `engine-error` is
 * relaunched once; `breaker` ({errors, window_min}) stops admissions after a burst and lets running lanes finish, the
 * rest stay pending (outcome `held`) for a resume. `getParallel()` is read on every pass, so K can change live.
 * #5805: with `envHold: {version(), envFingerprint(), missingTools(tools)}` an engine-error whose signature repeats (`failureSignature`,
 * per engine version) and an env defect the host still has (`env.tool_missing` / `env.repro_unrunnable`) end `held` with `envHold`
 * instead of relaunching or ending; an engine version change, a batch env change or the tool appearing re-admits them (watchEnvHolds).
 * #5138: `remote.max`, `remote.fallbackLocal` and `remote.place` are read on every grant too (engine-cli puts live getters on
 * them, live-execution.mjs), so `--set-max-remote` / `--set-placement` change a running batch; running lanes are not stopped.
 * `getChildren()` + `autoChildren {mode, pollS, epics}` (#4965, `orchestration.auto_add_children`): with mode `epic`|`all`, at most once per `pollS`
 * it reads one `{list, elsewhere}` and adds the open children (`**Parent**: #P`, sub-issues) of every batch issue and `epics` through the same
 * path as `getAdded` (one decision and one `added` row listing the edges); mode `off` also stops the decomposed-lane join.
 * `getAdded()` (#4408, `forgedock orchestrate --add`) is read on every pass too: issues it returns that are not in the batch
 * join it through `addIssues` (the still-pending issues' `Depends on` are re-read first, so edges hold both ways), with one
 * batch decision and one `added` row; while it is set, lanes running with an empty queue still wake every `pollMs`.
 * `getHeld()` (#4592, `--hold`/`--release`) is read on every pass: the issues it returns are never admitted (a running lane is not stopped);
 * when only held issues (and their dependents) remain and nothing runs, the batch ends with them `held` ("held by operator"), and a `--resume <id> <issue...>` naming them (or `--release`) re-admits them.
 * `getBlocked()` (#4773, the `blocked` label) is read on every pass: the issues it returns are in the batch but not dispatched; removing the label
 * releases them on the next pass (the batch polls while only blocked issues wait). `trusted(n)` gates `Blocked by`/`Depends on` edges to a trusted body author.
 * `logicalDeps(n)` (#5824) adds the plan's logical edges (bin/lean/dag.mjs: a dependency's new contract deliverable the issue names).
 *
 * Maintenance budget (#4197), off unless `maintenance: {share, whenIdle}` is passed: `classify(issue)` gives each issue
 * `{maintenance, priority}` (persisted as `classes`) and admission follows `pickNext`: P0/P1 features, then a maintenance
 * issue while maintenance starts stay within `share` of all lane starts (`dispatch: {started, maint}`, persisted), then
 * P2+ features, then (`whenIdle`) maintenance once no feature is pending. Maintenance the budget never admits ends `held`.
 *
 * Milestone lifecycle (#4657), off unless `lifecycle` is passed (`bin/lean/lifecycle.mjs` makeLifecycle): at batch end
 * `lifecycle.onBatchEnd(titles)` advances/closes each milestone a `merged` row's result named. Errors never change an outcome.
 * Milestone drift (#4161), off unless `drift` is passed (`bin/lean/drift.mjs` makeDrift): a `merged` milestone-lane run
 * whose result carries `structure` awaits `drift.onMerged(issue, row, result)` before its slot frees. A drift error is
 * reported as a `drift` row and never changes the outcome. With `drift.holds(issue, {body, lane})` (block_dispatch), a
 * pending issue it returns a package for is not started; it ends `held` (`drift: <package> flagged`) if nothing else runs.
 *
 * Host lane registry (#4191), off unless `sched: {registry, batch, repo, cap}` is passed (`sched.mjs` `openSched`): a lane
 * starts only when the batch is under its K and the registry grants it a host slot; `priorityOf(issue)` (persisted as
 * `priorities`) ranks it host-wide, and the batch's ready issues are tried in priority order. Ready issues it cannot
 * start yet stay offered in the registry (polled every `pollMs`) and are withdrawn once no longer ready; a settled lane
 * releases its slot, an adopted one re-records it. `sched.cap` may be a function, evaluated at each admission attempt
 * (#4777: the live local lane cap from cores and memory; running lanes are never revoked, over-cap issues stay queued).
 * Per-issue lock (#4481), on with `sched.exclusive` (registry entries ask `exclusive: true`): when another batch holds a live slot for the same repo and issue (`tryAcquire` `conflict`, or
 * `registry.holder` for a lane placed remote), the issue is not started: it is retried after `pollMs` with one `deferred`
 * row naming that batch (no deferral count, no breaker), and admission goes on with the next ready issue.
 *
 * Dispatch check (#4481), off unless `dispatchCheck(issue)` is passed: it runs before EVERY lane start (first and
 * requeued, unlike the once-per-issue pre-filter) and returns null (run) or `{outcome: "merged", pr}` / `{outcome:
 * "invalid"}` for an issue already closed or whose PR merged; the row ends with that outcome and no lane starts. Fail-open.
 *
 * Remote lanes (#4253), off unless `remote: {max, isRemote(issue)}` is passed (execution.mjs): a lane `isRemote` places
 * in a sandbox takes no host registry slot; it starts only while fewer than `max` remote lanes of this batch run (the
 * batch K still applies). Its run record keeps `remote: true` and the provider handle, so a resume re-counts and adopts it.
 * `runOne` gets `ctx.remote` (true for a lane admitted remote).
 *
 * Execution budget (#4255): a lane result's `sandbox: {minutes, cost_usd}` is summed per issue (persisted as `sandbox`,
 * over attempts) onto the row and handed to `remote.onUsage(issue, sandbox, rec)`. Before a remote lane is admitted,
 * `remote.admit(usage)` gets the batch's settled usage plus the running remote lanes' elapsed minutes
 * (× `remote.costPerMinute`); when it refuses, running lanes finish and the queue either runs the rest locally
 * (`remote.onBudget: "local"`, host path) or stops: the rest end `held` ("execution budget: ...") for a resume.
 *
 * Hybrid placement (#4256): `remote.place(issue) -> {where, reason}` (execution.mjs `placeLane`) replaces `isRemote`.
 * With `remote.fallbackLocal`, a lane placed remote runs on the host path instead of waiting when `max` remote lanes run,
 * and instead of stopping when the budget refuses. The final `{where, reason}` is kept on the run record and the row as
 * `placement` and passed to `runOne` as `ctx.placement` (the lane records it in its FORGE:STATE).
 * #5174: `overload() -> {overloaded, ...}` (hostload.mjs `liveOverload`) holds every new non-remote admission while the
 * host is overloaded (retry after `pollMs`), with one `host-overloaded` row per episode; remote placements are never held.
 *
 * In-batch recovery (#4267), on by default: this module recovers only when `recovery: {maxAttempts}` is passed, and the
 * CLI always passes it (forge.yaml `orchestration.recovery.max_attempts`, default 1; 0 disables): a row `classifyNeedsHuman` calls
 * recoverable (needs-human `ci.red` / `base.conflict` / `builder.block_untyped`, `contract.invalid` after a mid-run issue
 * edit, `ci-pending` whose PR `conflicting(issue, pr)` says conflicts, the non-human `budget-exceeded` turn overrun of #4505,
 * recovered at the next size budget) is not final while its persisted `recoveries` stay
 * under its class budget (#4725: `maxAttempts`; mechanical/env codes `mechanicalMaxAttempts`, default 2, never below `maxAttempts`): it is requeued as a recovery lane (`ctx.recover = {code, attempt, final}`, `final` when attempt ==
 * `maxAttempts`) under the same admission as any lane, so its dependents stay queued. Only a final lane relabels needs-human
 * itself; a non-final attempt that ends needs-human/ci-pending/budget-exceeded without a successor is relabelled here, once (#4302),
 * as is a first-run budget-exceeded the batch does not recover (#4505: the lane never labels it). A recovery
 * still queued when the batch exits (breaker, budget, hold, or a resume that does not relaunch it) is relabelled once with the
 * full persisted lane reason (#4315); also when the loop throws, and through `onExit(fn)` (the caller's signal handler
 * awaits `fn(cause)`), each once (#4318). `relabelNeedsHuman` may return `false`/"failed" (not recorded, a resume retries)
 * or "skipped" (closed or leased issue: recorded); any other result counts as relabelled.
 * A merged recovery row carries `recovered: <code>`; any other end is final with `recovery` evidence. Human codes (`builder.blocked`) are never recovered. Every operational decision the runner takes
 * (recovery, engine-error relaunch, dependency requeue, sub-issues added) goes to `decide({issue, what, why, alternative})`,
 * fire-and-forget: the runner never waits on it.
 * Daemon shutdown (#4454): an aborted `signal` stops the runner without ending the batch: nothing more is admitted, every wait
 * wakes, running lanes are neither awaited nor stopped (they are detached), nothing is relabelled and the state is saved once
 * with its `running` records, so a `--resume` re-adopts the lanes; then it throws `code: "batch.stopped"` (no rows, no report).
 *
 * Longest-first admission (#4409): `estimate(issue, {body})` (minutes; off when null, persisted as `estimates`) ranks the
 * ready issues inside a priority level. All admission paths order them by priority (unchanged), then the head band
 * (sub-issues of a decomposed lane, inserted at the front of the queue; with an estimate also issues queued longer than
 * `starveMs`, oldest first), then the estimate plus the estimates of their in-batch dependents (critical path), descending,
 * then queue order. A sub-issue's estimate is the parent's ÷ N, floored at the M default. Without `estimate` the order is
 * the queue order except that decomposed sub-issues go first. A settled row carries `est_minutes` (estimated vs. actual).
 */
import { decideClear, decideAutoReset } from "./clear-breaker.mjs";
import { RECONCILE_MS, BREAKER_COOLDOWN_MS, diffSelection, readmitDue, needsDecisionDigest, environmentalDetail, closesManually } from "./reconcile.mjs";
import { parseDependsOn } from "../engine/phases.mjs";
import { classifyNeedsHuman, recoveryCodeOf, recoveryClassOf, OUTCOME_CODES, ENV_VALIDATE_PLACEMENT, ENV_VALIDATE_TIMEOUT, MECHANICAL_CODES } from "../engine/outcome-codes.mjs";
import { detectGateDeadlock, formatGateDeadlock } from "./gatewatch.mjs";
import { recoveryEvidence } from "./render.mjs";
import { renderAlerts } from "../stats/render.mjs";
import { formatParkedLine, postDeployOnly } from "./prefilter.mjs";
import { laneSize, SIZES } from "./budget.mjs";
import { requeueKey, REQUEUABLE } from "./batch.mjs";
import { makeCapWait } from "./capwait.mjs";
import { mapLimit } from "./pmap.mjs";
import { quotaRequeue, nextAccountAfterAuthFailure } from "./rotator.mjs";
import { holdExpiryWarnings } from "./limits.mjs";
import { joinsDecomposed, addsEpicChildren, selectChildren, edgeText, DEFAULT_POLL_S } from "./autochildren.mjs";
import { formatOverload } from "./hostload.mjs";
import { normalizeStacking, planAdmissible, stackAdmissible } from "./stacking.mjs";
import { lackedTools } from "./toolplace.mjs";
import { openPrerequisites } from "./prereq.mjs";
import { makeController, classifyRepo, formatConcurrency } from "./concurrency.mjs";
import { admitInput, breach, recordFailure, markEscalated, NO_NEW_INPUT } from "./attempts.mjs";

// A dependency that finished like this no longer blocks its dependents.
const SATISFIED = new Set(["merged", "invalid"]);
const PLAN_VERDICT = new Set(["invalid", "needs-human", "decomposed", "budget-exceeded"]); // #5909: plan-lane ends that settle the issue
const DEFAULT_TRAIN_EVERY_MS = 30000; // #5836: merge-train poll period
// #5836: a lane that ended pr-ready is waiting on the merge train, not failed: its dependents wait
const WAITING_ON_TRAIN = (row) => row?.outcome === "pr-ready";
// #5162: a dependent of a root that ended like this is held (resumable), not skipped. #5805: also behind a root held on an engine/env change.
const ATTEMPT_FAILED = ["needs-human", "engine-error", "budget-exceeded", "failed"]; // #5986: final lane outcomes that count as a failed attempt
const HOLD_ROOT = new Set(["needs-human", "engine-error", "deferred", "budget-exceeded", "held"]);
/** #5162: members of a real dependency cycle (a nontrivial SCC or a self-loop) among `nodes`; `edgesOf(n)` lists n's dependencies. */
export function cyclicNodes(nodes, edgesOf) {
  const inSet = new Set(nodes), idx = new Map(), low = new Map(), stack = [], on = new Set(), out = new Set();
  let i = 0;
  const visit = (v) => {
    idx.set(v, i); low.set(v, i); i++; stack.push(v); on.add(v);
    for (const w of edgesOf(v).filter((d) => inSet.has(d))) {
      if (w === v) out.add(v);
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      for (let w; w !== v;) { w = stack.pop(); on.delete(w); comp.push(w); }
      if (comp.length > 1) for (const c of comp) out.add(c);
    }
  };
  for (const n of nodes) if (!idx.has(n)) visit(n);
  return out;
}
const WATCH_EVERY_MS = 60_000; // #4595
// Times one issue may be requeued behind a dependency before its dependency-open row is final.
export const MAX_REQUEUES = 2;
// Deferrals other than a wait (UNCAPPED_DEFERRALS, usage limit) one issue may take before its deferred row is final.
export const DEFAULT_MAX_DEFERRALS = 3;
// Relaunches of an issue whose lane ended engine-error.
export const ENGINE_ERROR_RELAUNCHES = 1;
// #5859: lanes of one pool agent lost without a result within the window that make it an agent restart (`sandbox.lost`), and their requeue delay
export const AGENT_LOST_MIN = 3;
export const AGENT_LOST_WINDOW_MS = 60000;
export const AGENT_LOST_REQUEUE_MS = 60000;
// #5988: a backend.auth outage is probed every AUTH_PROBE_MS, holds admissions at most AUTH_ESCALATE_MS, then escalates once.
export const AUTH_PROBE_MS = 5 * 60000;
export const AUTH_ESCALATE_MS = 30 * 60000;
export const HOLD_RAMP_STEP_MS = 30000; // #5988: hold-expiry release ramp: one more lane per step
/** #5988: a cause that belongs to one placement host: errors are counted per (signature, agent), not batch-wide. */
const hostSignature = (r, detail) => (/\bsandbox\.exited\b/.test(`${r?.code ?? ""} ${detail ?? ""}`) ? "sandbox.exited" : null);
export const HOST_BUSY_RETRY_S = 60;
// #4528: a busy host or a full sandbox pool is a wait, not a failure: requeued after its retry-in, never capped.
// A lane that could not be resolved because gh/git failed (network blip) is the same kind of wait (#4791).
// #4788: an unreachable pool is a wait too (the lane already retried for unreachable_window_min); a stall is reported by poolStall.
const UNCAPPED_DEFERRALS = new Set(["host.busy", "sandbox.capacity", "sandbox.unreachable", "sandbox.repo_missing", "lane.unresolved", "base.red"]); // #5992: a red base is the base's wait, never the issue's
export const POOL_OFFLINE_ALERT_MIN = 10;
// #5112: `sandbox.capacity` deferrals of one issue after which `execution.fallback_local` runs it on the host (headroom permitting).
export const CAPACITY_FALLBACK_AFTER = 3;
export const RATE_LIMIT_FALLBACK_S = 15 * 60;
export const DEFER_BACKOFF_S = 120;
export const DEFER_BACKOFF_MAX_S = 30 * 60;
// #4685 + #5161: an engine-error detail that names a link or gateway failure (curl's "returned error: 502", HTTP/1.1 503, ...).
// #5947: git transport failures (a dropped clone/fetch, a half-built mirror): a `net.transient` deferral, never an engine-error.
export const GIT_TRANSPORT_TEXT = /curl (56|28)\b|early EOF|RPC failed|invalid index-pack output|unexpected disconnect|is not a local repository/i;
export const TRANSPORT_TEXT = new RegExp(`fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|HTTP 50[234]|returned error: 5\\d\\d|HTTP\\/\\d(\\.\\d)? 5\\d\\d|Bad Gateway|Service Unavailable|overloaded|${GIT_TRANSPORT_TEXT.source}`, "i");
/** #5161: a transient engine failure (model gateway 5xx, connection reset): retried with backoff, not the single relaunch. */
export const isTransientEngineError = (detail) => TRANSPORT_TEXT.test(String(detail ?? ""));
// #5161: transient engine-error retries per issue (forge.yaml `orchestration.transient_retries`) and their backoff: 30s, 2m, 8m, then 15m.
export const DEFAULT_TRANSIENT_RETRIES = 4;
export const TRANSIENT_BACKOFF_S = 30;
export const TRANSIENT_BACKOFF_MAX_S = 15 * 60;
export const transientRetryDelayMs = (k) => Math.min(TRANSIENT_BACKOFF_S * 4 ** (Math.max(1, k) - 1), TRANSIENT_BACKOFF_MAX_S) * 1000;
// #5805: an engine/env-caused failure that would repeat is held (outcome `held`, row `envHold`) instead of relaunched or ended;
// the batch stays open up to ENV_HOLD_MAX_MS re-checking every ENV_WATCH_MS for an engine version change, a batch env change or the tool.
export const ENV_HOLD_MAX_MS = 24 * 3600_000;
export const ENV_WATCH_MS = 30_000;
/** #5805: `code|first message line`, with times, hex ids and numbers normalised, so a pid or path id does not make a repeat look new. */
export function failureSignature(code, detail) {
  const line = String(detail ?? "").split("\n").find((l) => l.trim()) ?? "";
  const msg = line.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, "<t>").replace(/\b[0-9a-f]{8,}\b/gi, "<h>").replace(/\d+/g, "<n>").replace(/\s+/g, " ").trim().slice(0, 240);
  return `${code || "engine-error"}|${msg}`;
}
// A dependency-open whose dependencies already finished satisfied (GitHub not yet closed): wait before relaunching.
export const DEP_REQUEUE_DELAY_S = 60;

// #4409 lane duration estimates (minutes) without history; the ratio follows the S/M/L turn budgets.
export const EST_DEFAULT_MIN = Object.freeze({ S: 10, M: 25, L: 50 });
// A post-deploy-only follow-up starts no real lane (the pre-filter parks or closes it).
export const POST_DEPLOY_EST_MIN = 2;
// A ready issue queued longer than this joins the head band (starvation guard; only with an estimator).
export const DEFAULT_STARVE_MS = 30 * 60000;
/** #4963: issues read at once while a batch sets up. */
export const DEFAULT_SETUP_CONCURRENCY = 6;
// Merged runs of one repo and size needed before their median replaces the default.
export const HISTORY_MIN_SAMPLES = 3;

/** #4409: estimated lane minutes from facts: post-deploy-only body, else the `size:` label (unsized = M) -> history median or default. */
export function estimateLaneMinutes({ labels = [], body = "", history = null } = {}) {
  if (postDeployOnly(body)) return POST_DEPLOY_EST_MIN;
  const size = laneSize({ labels }) ?? "M";
  const h = Number(history?.[size]);
  return Number.isFinite(h) && h > 0 ? h : EST_DEFAULT_MIN[size];
}

/** #4409: {S?, M?, L?} median wall minutes of `repo`'s merged runs (summariseLog rows) per size, only sizes with enough samples. */
export function laneHistory(runs, repo) {
  const by = {};
  for (const r of runs ?? []) {
    if (r?.repo !== repo || r?.reason !== "merged" || !SIZES.includes(r?.size) || !Number.isFinite(r?.wallMs)) continue;
    (by[r.size] ??= []).push(r.wallMs / 60000);
  }
  const out = {};
  for (const [s, xs] of Object.entries(by)) {
    if (xs.length < HISTORY_MIN_SAMPLES) continue;
    xs.sort((a, b) => a - b);
    const m = xs.length >> 1;
    out[s] = Math.round((xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2) * 10) / 10;
  }
  return out;
}

/** Declared dependencies of an issue body; the same parser as the engine's admission (`openDependency`). */
export function parseDeps(body, issue) {
  return parseDependsOn(body, issue);
}

const posNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

/**
 * When to run a `deferred` issue again. `deferrals` counts this issue's earlier capped deferrals (not UNCAPPED_DEFERRALS or a usage limit).
 * @returns {{delayMs:number, host?:true, hold?:true} | {capped:true}}
 */
export function deferPolicy(r, { now, deferrals = 0, maxDeferrals = DEFAULT_MAX_DEFERRALS }) {
  const code = r?.code ?? null;
  if (UNCAPPED_DEFERRALS.has(code)) return { delayMs: (posNum(r?.retryInSeconds) ?? HOST_BUSY_RETRY_S) * 1000, host: true };
  // #4784: a usage limit is a known-time wait gated by the account hold, never capped.
  if (code === "rate_limited" || code === "quota.exhausted") { // #5236: no account has capacity: held until the earliest reset
    const at = posNum(r?.resetAtEpochMs) && r.resetAtEpochMs > now ? r.resetAtEpochMs : now + (posNum(r?.retryInSeconds) ?? RATE_LIMIT_FALLBACK_S) * 1000;
    return { delayMs: at - now, hold: true };
  }
  // #5168: a failed claude login is an account condition, not an engine fault: held like a usage limit, never capped.
  if (code === "backend.auth") return { delayMs: (posNum(r?.retryInSeconds) ?? RATE_LIMIT_FALLBACK_S) * 1000, hold: true };
  // #5762: backend.cli_failed (the CLI exited without reaching the API) is a plain capped retry: no account hold.
  const k = deferrals + 1;
  if (k > maxDeferrals) return { capped: true };
  if (posNum(r?.retryInSeconds)) return { delayMs: r.retryInSeconds * 1000 };
  if (code === "run.interrupted") return { delayMs: 0 }; // #5654: its lease was released, so there is nothing to wait out
  // lease-held: "leased by X until <ISO>"
  const until = /\buntil (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(String(r?.detail ?? ""))?.[1];
  const at = until ? Date.parse(until) : NaN;
  if (Number.isFinite(at) && at > now) return { delayMs: Math.min(at - now + 5000, DEFER_BACKOFF_MAX_S * 1000) };
  return { delayMs: Math.min(DEFER_BACKOFF_S * 2 ** (k - 1), DEFER_BACKOFF_MAX_S) * 1000 };
}

// #5241: a cancel re-sends a stop that was not accepted every STOP_RETRY_MS and reports a lane still running after STOP_TIMEOUT_MS.
const STOP_RETRY_MS = 15 * 1000;
const STOP_TIMEOUT_MS = 120 * 1000;

const cancellableSleep = (ms, signal) => new Promise((res) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
});

// In-memory hold store with the `openLimits` interface, for callers without the host store.
const memoryLimits = (now) => {
  const holds = new Map();
  return {
    holdUntil: (id) => { const u = holds.get(id)?.until; return u > now() ? u : null; },
    set: (id, untilMs, source = null) => {
      const prev = holds.get(id);
      if (!(prev?.until > untilMs)) holds.set(id, { until: untilMs, source, setAt: now() });
      return holds.get(id).until;
    },
    clear: (id) => { const live = !!(holds.get(id)?.until > now()); holds.delete(id); return live; },
    clearAll: () => { const n = [...holds.values()].filter((h) => h.until > now()).length; holds.clear(); return n; },
    list: () => [...holds].filter(([, h]) => h.until > now()).map(([id, h]) => ({ id, ...h })),
  };
};

const clsOf = (classes, n) => (classes instanceof Map ? classes.get(n) : classes?.[n]) ?? { maintenance: false, priority: 2 };

/**
 * The next issue to start from `ready` (pending order) under the maintenance budget, or null when none may start now.
 * Order: P0/P1 features; maintenance while `maint + 1 <= floor(share * (started + 1))`; P2+ features; maintenance
 * regardless of share when `whenIdle` and no feature is pending at all.
 */
export function pickNext(ready, { classes, share, whenIdle = false, started = 0, maint = 0, featuresPending = true }) {
  const isM = (n) => !!clsOf(classes, n).maintenance;
  const urgent = ready.find((n) => !isM(n) && Number(clsOf(classes, n).priority) <= 1);
  if (urgent !== undefined) return urgent;
  const m = ready.find(isM);
  if (m !== undefined && maint + 1 <= Math.floor(share * (started + 1) + 1e-9)) return m;
  const f = ready.find((n) => !isM(n));
  if (f !== undefined) return f;
  if (m !== undefined && whenIdle && !featuresPending) return m;
  return null;
}

const toObj = (m) => Object.fromEntries([...m].map(([k, v]) => [String(k), v]));
/** #4525: how often a parked needs-human PR is re-synced with its base while the batch runs. */
export const DEFAULT_SYNC_EVERY_MS = 10 * 60 * 1000;
const toMap = (o) => new Map(Object.entries(o ?? {}).map(([k, v]) => [Number(k), v]));

/**
 * @returns {Promise<Array<{issue:number, outcome:string, pr:?number, cost_usd:number, minutes:number, detail?:string}>>}
 */
export async function orchestrate({ issues, parallel = 3, runOne, readBody, prefilter = null, resolveLane = null, now = () => Date.now(), blockedRefreshMs = 60000, onUpdate = () => {}, onCrossLane = () => {},
  store = null, adopt = null, getParallel = null, usageRows = null, repoSlug = null, repoOf = null, getAdded = null, getRequeued = null, reconcile = null, select = null, breaker = null, maxDeferrals = DEFAULT_MAX_DEFERRALS, sleep = cancellableSleep, pollMs = 5000, getClearBreaker = null, consumeClearBreaker = null, ackClearBreaker = null,
  classify = null, maintenance = null, limits = null, identity = () => "default", batchId = null, drift = null, integration = null, sched = null, priorityOf = null, remote = null, beforeAdmit = null, preflight = null, baseProbe = null,
  recovery = null, decide = () => {}, conflicting = null, relabelNeedsHuman = null, markRecovering = null, onExit = null, issueLabels = null, heldFacts = null, issueState = null, getCancelled = null, getHeld = null, expireHolds = null, getPause = null, expirePause = null, getHoldInfo = null, authProbe = null, onEscalate = null, quarantineAgent = null, reseedCache = null, suspendLane = null, getBlocked = null, trusted = null, getGates = null, stopLane = null, releaseLease = null, stopRetryMs = STOP_RETRY_MS, stopTimeoutMs = STOP_TIMEOUT_MS,
  estimate = null, starveMs = DEFAULT_STARVE_MS, setupConcurrency = DEFAULT_SETUP_CONCURRENCY, signal = null, dispatchCheck = null, syncParked = null, syncEveryMs = DEFAULT_SYNC_EVERY_MS, lifecycle = null,
  getChildren = null, autoChildren = null, baseWait = null, rotator = null, stacking = "off", readPrReady = null, transientRetries = DEFAULT_TRANSIENT_RETRIES, overload = null, version = null, onInterrupted = null, envHold = null, envIssue = null, logicalDeps = null,
  train = null, trainEveryMs = DEFAULT_TRAIN_EVERY_MS, attempts = null }) {
  const saved = store?.load?.() ?? null;
  if (train && saved?.train) train.restore(saved.train); // #5836: the merge train resumes with the batch
  const order = saved ? [...saved.order] : [];
  const set = new Set(order);
  const deps = toMap(saved?.deps); // issue -> declared dependencies (any issue); only those in `set` are edges
  const lanes = toMap(saved?.lanes); // issue -> resolveLane result
  const crossSeen = new Set(saved?.crossSeen ?? []);
  const results = toMap(saved?.results); // issue -> final row
  const running = new Map(); // issue -> promise
  const keptBoxes = toMap(saved?.kept); // #6008: issue -> {issue, since, phase}: sandboxes kept for adopt (no dispatcher lease)
  const runRecs = toMap(saved?.running); // issue -> {startedAt, lane, pid?}: persisted so a restart can adopt the lane
  const pending = [...(saved?.pending ?? [])];
  const selMatched = new Set(saved?.selMatched ?? []); // #6029: issues the selector has matched (persisted: a resumed runner keeps the leave provenance)
  const notBefore = toMap(saved?.notBefore);
  const requeues = toMap(saved?.requeues);
  const deferrals = toMap(saved?.deferrals);
  const capReasons = toMap(saved?.capReasons); // #5938: issue -> the pool's last `sandbox.capacity` / host-disk reason (read by the batch health stall verdict)
  const capDefers = toMap(saved?.capDeferrals); // #5112: issue -> `sandbox.capacity` deferrals (uncapped, so not in `deferrals`)
  const capFellBack = new Set(); // #5112: issues already reported as a capacity fallback (one decision each)
  const engineErrors = toMap(saved?.engineErrors);
  const transients = toMap(saved?.transientRetries); // #5161: issue -> transient engine-error retries taken
  const transientMax = Number.isInteger(transientRetries) && transientRetries >= 0 ? transientRetries : DEFAULT_TRANSIENT_RETRIES;
  // #5805: engine/env holds (off unless `envHold` is passed). `engineSigs`: issue -> signature of its relaunched engine-error;
  // `deterministic`: `version|signature` seen twice (never relaunched again on that version); `toolReadmits`: `issue|signature`
  // already re-admitted because the probe found the tool (a lane that still misses it waits for an engine or env change instead).
  const ehOn = !!envHold || !!envIssue;
  // #5755: env.* failures are one engine/env defect per signature: `envSigs` signature -> {issues, number} (the env issue the `envIssue` seam
  // filed or updated); affected product issues are held on it (never needs-human) and 2+ issues on a signature stop admitting lanes that need it.
  const envSigs = toMap(saved?.envSigs);
  const engineSigs = toMap(saved?.engineSigs);
  const heldSigs = toMap(saved?.heldSigs); // #5893: root -> {sig, removedAt} of the needs-human block last released; an identical block needs a newer removal event
  const readmit = toMap(saved?.readmit); // #5978: re-admission policy state (backoff step, version and base seen) per ended issue
  const ledgers = toMap(saved?.attempts); // #5986: issue -> attempts ledger; never cleared by releaseHeld, --requeue or --set-env (see attempts.mjs)
  const deterministic = new Set(saved?.deterministicSigs ?? []);
  const toolReadmits = new Set(saved?.toolReadmits ?? []);
  const ehMaxMs = Number(envHold?.maxMs) > 0 ? Number(envHold.maxMs) : ENV_HOLD_MAX_MS;
  const ehWatchMs = Number(envHold?.watchMs) > 0 ? Number(envHold.watchMs) : ENV_WATCH_MS;
  const curVersion = () => { try { return envHold?.version?.() ?? version ?? null; } catch { return version ?? null; } };
  const curEnv = () => { try { return envHold?.envFingerprint?.() ?? null; } catch { return null; } };
  const missingTools = async (tools) => { if (typeof envHold?.missingTools !== "function") return null; try { const m = await envHold.missingTools(tools); return Array.isArray(m) ? m : null; } catch { return null; } };
  const checked = toMap(saved?.prefilter); // issue -> pre-filter result
  const estimates = toMap(saved?.estimates); // #4409: issue -> estimated lane minutes; only with `estimate`
  const enqueued = toMap(saved?.enqueued); // #4409: issue -> when it last entered the queue (starvation guard)
  const heads = new Set(saved?.heads ?? []); // #4409: decomposed sub-issues not started yet: the head of their priority band
  let errorTimes = [...(saved?.errorTimes ?? [])];
  const ceilingK = () => { let k = null; try { k = getParallel?.(); } catch { k = null; } return Number.isInteger(k) && k >= 1 ? k : parallel; }; // #5988: declared early: refreshHeld reads it
  const holdWarned = new Set(); let holdRamp = null; // #5988: declared early: the hoisted refreshHeld reads them from finish/recovery callbacks
  // #5859: agent restarts of this batch (one record each, shown by `status --batch`) and the lanes already requeued as `sandbox.lost`
  const agentRestarts = [...(saved?.agentRestarts ?? [])];
  const lostOnce = new Set(saved?.lostRequeued ?? []); // a lane lost again after its requeue is an ordinary engine-error
  // A legacy batch-local `holdUntil` (pre-#4190) names no account and is ignored: a same-account lane re-sets the hold.
  const holds = limits ?? memoryLimits(now);
  // #5205: accounts lanes reported limited (account -> until ms), persisted with the batch, excluded from headroom until then.
  const limitedAccounts = toMap(saved?.limitedAccounts);
  const excluded = () => { for (const [k, u] of limitedAccounts) if (!(Number(u) > now())) limitedAccounts.delete(k); return limitedAccounts; };
  const noteLimited = (r) => { for (const l of Array.isArray(r?.limited) ? r.limited : []) { const a = Number(l?.account), u = Number(l?.until); if (Number.isInteger(a) && a > 0 && Number.isFinite(u)) limitedAccounts.set(a, Math.max(u, Number(limitedAccounts.get(a)) || 0)); } };
  // #5094: with an account rotator, admissions stop only when no account has headroom, and resume when the first one resets.
  const rotatorHold = () => {
    if (!rotator) return undefined;
    try { if (rotator.headroom(excluded())) return null; const u = rotator.resumeAt(excluded()); return Number.isFinite(u) && u > now() ? u : undefined; } catch { return undefined; }
  };
  const heldUntil = () => {
    const r = rotatorHold();
    if (r !== undefined) return r;
    try { const id = identity(); const u = holds.holdUntil(id); return Number.isFinite(u) && u > now() ? u : null; } catch { return null; }
  };
  // #5094: a quota pause carries its attempt's cost and minutes into the issue's next row once; the resume time labels the report row.
  const quota = toMap(saved?.quota); // issue -> {cost_usd, minutes, resumeAt (epoch ms), rotations}
  let tripped = saved?.breaker ?? null;
  let pfAll = false, pfRemote = false, pfNoted = new Set(); // #4866: lane preflight holds
  let baseRedHold = null; // #5992: {sha, issue, detail}: the base is red; only the attributed fixer is admitted until the sha moves or the guard passes
  let opHeld = new Set(); // #4592: operator-held issues this pass (the batch `hold` file is the authority)
  const opHeldHit = new Set(); // held issues that were pending this pass
  let opPause = null, pauseHit = false; // #5975: the batch-level pause (the `pause` file is the authority); pauseHit: an issue was pending behind it this pass
  // #4376: operator cancel (the batch `cancel` file through `getCancelled`); persisted, but the file stays the authority.
  let cancelled = getCancelled ? (saved?.cancelled ?? null) : null;
  const budget = maintenance && Number(maintenance.share) > 0 ? { share: Number(maintenance.share), whenIdle: !!maintenance.whenIdle } : null;
  const classes = toMap(saved?.classes); // issue -> {maintenance, priority}; only with a maintenance budget
  const dispatch = { started: saved?.dispatch?.started ?? 0, maint: saved?.dispatch?.maint ?? 0 };
  let budgetHeld = false;
  const parkedBase = new Map(); // #4525: issue -> base sha its parked PR was last synced (or reported conflicting) against
  let lastParkedSync = null;
  const bodies = new Map(); // issue -> body, kept in memory for drift.holds only
  const lifecycleTitles = new Set(); // #4657: milestones this batch merged into, re-evaluated at batch end
  const driftHeld = new Map(); // issue -> flagged package dir holding it this pass
  const integHeld = new Map(); // issue -> reason (red integration streak on its milestone lane, #4667) holding it this pass
  const reg = sched?.registry ?? null;
  const priorities = toMap(saved?.priorities); // issue -> priority number; only with the registry
  // #5138: read on every grant, so `--set-max-remote` reaches a running batch (a getter on `remote`); running lanes are never stopped.
  const remoteMax = () => { const m = remote?.max; return Number.isInteger(m) && m >= 0 ? m : 0; };
  const maxHeldNoted = new Set(); // #5746: issues already announced as waiting on max_remote 0
  const remoteCapped = new Set(); // #5138: issues waiting for a max_remote slot; polled so a raised live max_remote admits them
  let poolOfflineSince = null, poolStallNoted = false; // #4788: when sampled online first read 0, and whether the stall was reported
  const capWait = makeCapWait({ now }); // #4909: a lane refused for capacity waits for a free slot, recorded as queue time
  let capAt, capAdmits = 0; // #4540: provider capacity sample and the remote admissions made since it
  const remoteRun = new Set(); // remote lanes running now (#4253): admitted against remoteMax, never the host cap
  let budgetLocal = false; // the execution budget refused a remote lane under on_budget local: the rest run on the host
  // #4256: where a lane goes before capacity: `remote.place` (hybrid) or `remote.isRemote` (remote mode).
  const hostFallbackOn = () => remote?.hostFallback !== false; // #5652: unset keeps the host re-placement
  const placeOf = (n) => {
    if (!remote) return null;
    // #4542: a lane recovering from a remote capability block runs on the host, which has the capability.
    // #4785: a tool-missing recovery too: the sandbox that lacked the tool is not chosen again.
    // #5727: a tool no lane_tools recipe can install is never retried in another sandbox (toolNoRecipe), only on the host below
    // #5423: the lane now provisions the sandbox before ending tool_missing, so the first tool-missing recovery of a remote run retries remotely (not parked behind host load); a repeat goes to the host
    const rec = recovering.get(n);
    if (rec?.code === OUTCOME_CODES.ENV_TOOL_MISSING && rec.where === "remote" && !rec.toolNoRecipe && (rec.attempt ?? 1) <= 1 && !budgetLocal) return { where: "remote", reason: "retry remotely after sandbox provisioning" };
    // #5652: with host fallback off (execution.host_fallback / host.role: orchestrator) the host is orchestrator-only: no re-placement here
    if (hostFallbackOn() && [OUTCOME_CODES.ENV_CAPABILITY_REMOTE, OUTCOME_CODES.ENV_TOOL_MISSING].includes(recovering.get(n)?.code)) return { where: "local", reason: `host capability: recovering ${recovering.get(n).code}` };
    // #5371: a mechanical recovery never repeats the placement of the run that failed (a remote sandbox env defect recurs there), and a remote validate failure is rerun on the host
    if (recovering.get(n)?.code === ENV_VALIDATE_PLACEMENT || (MECHANICAL_CODES.includes(recovering.get(n)?.code) && recovering.get(n)?.where === "remote")) {
      if (hostFallbackOn()) return { where: "local", reason: `different placement: recovering ${rec.code} off the remote run` };
      // #5746: the host is not allowed: retry remotely (a fresh sandbox) instead of the orchestrator
      if (!budgetLocal) return { where: "remote", reason: `retry remotely, host fallback off: recovering ${rec.code}` };
    }
    if (hostFallbackOn()) { // #5331: a frozen contract naming a tool the sandbox is known to lack runs on the host (`remote.lacks`, `remote.contractOf(n)`; both optional)
      const lk = lackedTools(remote.contractOf?.(n), remote.lacks);
      if (lk.tools.length) return { where: "local", reason: `host tool: sandbox lacks ${lk.tools.join(", ")}` };
    }
    if (budgetLocal) return { where: "local", reason: `fallback to local: execution budget: ${budgetHit ?? "cap reached"}` };
    try {
      if (typeof remote.place === "function") {
        const p = remote.place(n);
        return { where: p?.where === "remote" ? "remote" : "local", reason: String(p?.reason ?? "") };
      }
      return remote.isRemote?.(n) ? { where: "remote", reason: "mode remote" } : { where: "local", reason: "local" };
    } catch { return hostFallbackOn() ? { where: "local", reason: "placement failed" } : { where: "remote", reason: "placement failed, host fallback off: retry remotely" }; } // #5746
  };
  const isRemote = (n) => placeOf(n)?.where === "remote";
  const placed = new Map(); // issue -> {where, reason} granted this pass, picked up by start()
  const sandboxUse = toMap(saved?.sandbox); // issue -> {minutes, cost_usd, attempts} (#4255)
  const remoteCpm = Number(remote?.costPerMinute) > 0 ? Number(remote.costPerMinute) : 0;
  let budgetStop = null, budgetHit = null; // this pass's refusal under on_budget stop; the last refusal reason
  const recoveryMax = Number.isInteger(recovery?.maxAttempts) && recovery.maxAttempts > 0 ? recovery.maxAttempts : 0;
  // #4725: mechanical/env codes recover on their own budget (>= the conformance one); 0 maxAttempts still turns recovery off.
  const mechMax = recoveryMax && Number.isInteger(recovery?.mechanicalMaxAttempts) && recovery.mechanicalMaxAttempts > 0 ? Math.max(recovery.mechanicalMaxAttempts, recoveryMax) : recoveryMax;
  const REPEAT_ENV_CODES = [OUTCOME_CODES.ENV_REPRO_UNRUNNABLE, OUTCOME_CODES.ENV_TOOL_MISSING]; // #5232: deterministic for a frozen command (a timeout is load, not listed)
  const sigOf = (d) => String(d ?? "").replace(/\s+/g, " ").trim();
  // #5592: env.tool_missing repeats are the same defect when the same tools are missing, whatever else the detail says (probe lines, ids, paths vary per run)
  const toolsOf = (d) => { const m = /(?:host|sandbox) is missing ([^\n]+?), so validate command/i.exec(String(d ?? "")); return m ? m[1].split(/\s*,\s*/).sort().join(",") : null; };
  const envSig = (code, d) => (code === OUTCOME_CODES.ENV_TOOL_MISSING ? toolsOf(d) : null) ?? sigOf(d);
  const ENV_ALL_CODES = [...REPEAT_ENV_CODES, ENV_VALIDATE_TIMEOUT, OUTCOME_CODES.ENV_CAPABILITY_REMOTE]; // #5755
  const envKey = (code, d) => `${code}|${code === OUTCOME_CODES.ENV_TOOL_MISSING && toolsOf(d) ? toolsOf(d) : failureSignature(code, d).split("|").slice(1).join("|")}`;
  const maxFor = (cls) => (cls === "mechanical" ? mechMax : recoveryMax);
  const classUsed = toMap(saved?.recoveryClasses); // `${issue}:${class}` -> recovery lanes launched in that class
  const recoveries = toMap(saved?.recoveries); // issue -> recovery lanes launched (#4267)
  // #5831 stacked lanes: `planned` = issue -> {contractHash, baseSha} of its finished plan lane; `planTried` = issues that had their one plan lane
  const stackOn = normalizeStacking(stacking) !== "off";
  // #5832 phase 2 (`full`): `prReady` = running issue -> {pr, branch, sha} of its PR-ready lane head (FORGE:STATE via `readPrReady`);
  // `stackedTried` = issues whose one stacked build was admitted; `stackedOf` = issue -> {dependency, branch, sha} of that build.
  const stackFull = normalizeStacking(stacking) === "full" && typeof readPrReady === "function";
  const prReady = new Map();
  const stackedOf = toMap(saved?.stacked);
  const stackedTried = new Set(saved?.stackedTried ?? []);
  const planned = toMap(saved?.planned);
  const planTried = new Set(saved?.planTried ?? []);
  const firstAdmit = new Map(), planMs = new Map(); // #5834: issue -> first admission ms; issue -> plan lane run ms (chain metrics)
  const recovering = toMap(saved?.recovering); // issue -> {code, attempt, detail, outcome, ...} of the recovery lane queued or running
  const freeRecovered = new Set(); // #5727: issues whose one free (no-attempt) recovery for a recipe-less remote tool miss was spent
  const requeueApplied = new Set(saved?.requeueApplied ?? []); // #4550: `--requeue` entries already applied (batch `requeue` file)
  const requeuedInfo = toMap(saved?.requeued); // #4550: issue -> {reason, by, at, prior: [earlier rows]}
  const everRelabelled = new Set(saved?.relabelled ?? []); // #4656: issues the runner already relabelled; never parked on top
  const relabelled = new Set(saved?.relabelled ?? []); // #4315: queued recoveries relabelled needs-human when a batch stopped
  // #4267: decisions are recorded, never awaited: a failing or slow recorder cannot block the batch.
  // #5985: the controller moves are persisted to log.jsonl with their inputs (the post-deploy check reads them)
  const conc = makeController({ ceiling: parallel, now });
  let heavyHeldHit = false;
  const concEmit = (e) => { if (!e) return; const ev = { ...e, batch: batchId ?? null, running: running.size, line: formatConcurrency({ running: running.size, k: e.k, ceiling: e.ceiling, factor: e.factor }) }; try { store?.log?.(ev); } catch { /* advisory */ } onUpdate(ev); };
  const decided = (d) => { try { Promise.resolve(decide?.(d)).catch(() => {}); } catch { /* best effort */ } };
  const firstLine = (x) => String(x ?? "").split("\n")[0].slice(0, 300);

  let setup = null; // #4963: {read, total} while the initial per-issue reads run; written with phase "setup" so a slow start is visible
  let halted = false; // #4454: stopped by `signal`; the batch's state is no longer this process's to write
  const save = () => {
    if (!store || halted) return;
    store.save({ v: 1, ...(setup ? { phase: "setup", setup: { ...setup } } : {}), engineVersion: version, order, deps: toObj(deps), lanes: toObj(lanes), crossSeen: [...crossSeen], results: toObj(results), running: toObj(runRecs), ...(keptBoxes.size ? { kept: toObj(keptBoxes) } : {}),
      pending, notBefore: toObj(notBefore), requeues: toObj(requeues), deferrals: toObj(deferrals), engineErrors: toObj(engineErrors), ...(transients.size ? { transientRetries: toObj(transients) } : {}), ...(quota.size ? { quota: toObj(quota) } : {}), ...(limitedAccounts.size ? { limitedAccounts: toObj(limitedAccounts) } : {}), ...(capDefers.size ? { capDeferrals: toObj(capDefers) } : {}), ...(capReasons.size ? { capReasons: toObj(capReasons) } : {}),
      prefilter: toObj(checked), errorTimes, breaker: tripped, ...(agentRestarts.length ? { agentRestarts, lostRequeued: [...lostOnce] } : {}), ...(budget ? { classes: toObj(classes), dispatch: { ...dispatch } } : {}),
      ...(reg ? { priorities: toObj(priorities) } : {}), ...(sandboxUse.size ? { sandbox: toObj(sandboxUse) } : {}),
      ...(recoveries.size || recovering.size ? { recoveries: toObj(recoveries), recovering: toObj(recovering), recoveryClasses: toObj(classUsed) } : {}),
      ...(planned.size || planTried.size ? { planned: toObj(planned), planTried: [...planTried] } : {}),
      ...(stackedTried.size ? { stacked: toObj(stackedOf), stackedTried: [...stackedTried] } : {}),
      ...(requeueApplied.size ? { requeueApplied: [...requeueApplied], requeued: toObj(requeuedInfo) } : {}),
      ...(relabelled.size ? { relabelled: [...relabelled] } : {}), ...(cancelled ? { cancelled } : {}), ...(train ? { train: train.snapshot() } : {}),
      ...(estimate ? { estimates: toObj(estimates), enqueued: toObj(enqueued) } : {}), ...(heads.size ? { heads: [...heads] } : {}),
      ...(engineSigs.size ? { engineSigs: toObj(engineSigs) } : {}), ...(heldSigs.size ? { heldSigs: toObj(heldSigs) } : {}), ...(deterministic.size ? { deterministicSigs: [...deterministic] } : {}), ...(toolReadmits.size ? { toolReadmits: [...toolReadmits] } : {}), ...(select ? { select } : {}), ...(readmit.size ? { readmit: toObj(readmit) } : {}), ...(envSigs.size ? { envSigs: toObj(envSigs) } : {}), ...(ledgers.size ? { attempts: toObj(ledgers) } : {}), ...(selMatched.size ? { selMatched: [...selMatched] } : {}) });
  };
  const update = (row) => { store?.log?.(row); onUpdate(row); };
  // #5978 R11: a merge into a staging lane branch does not fire `Closes`: the seam closes the issue and folds its post-deploy checks into the release rollup.
  const closeOnLane = async (n, lane, row) => {
    if (!reconcile?.closeIssue || !closesManually(lane)) return;
    try { await reconcile.closeIssue(n, { lane, row }); update({ issue: n, outcome: "closed", detail: `closed on merge into ${lane}` }); } catch (err) { update({ issue: n, outcome: "close-failed", detail: String(err?.message ?? err).slice(0, 200) }); }
  };
  /** #5755: records `issue` on its signature and files or updates the one env issue (seam `envIssue.ensure`); the issue number, or null when none could be filed. */
  const fileEnvIssue = async ({ sig, code, issue, tools, evidence }) => {
    const e = envSigs.get(sig) ?? { issues: [], number: null };
    if (!e.issues.includes(issue)) e.issues.push(issue);
    if (!e.text) e.text = firstLine(evidence).slice(0, 240); // the raw line: the signature digit-normalises its tokens
    envSigs.set(sig, e);
    try {
      const r = await envIssue.ensure({ sig, code, issues: [...e.issues], tools, evidence, number: e.number });
      const no = Number.isInteger(r) ? r : r?.number;
      if (Number.isInteger(no) && no > 0) e.number = no;
    } catch { /* best effort: without an env issue the existing flow applies */ }
    save();
    return e.number;
  };
  const envBodies = new Map();
  /** #5755: once 2 issues hit one env signature, a pending issue whose contract needs it is held on the env issue instead of admitted (seam `envIssue.needs(n, sig)`, else its body names a missing tool). */
  const gateEnvSigs = async () => {
    if (!envIssue || tripped || cancelled) return;
    const gated = [...envSigs].filter(([, e]) => e.issues.length >= 2 && e.number);
    if (!gated.length) return;
    for (const n of [...pending]) {
      if (results.has(n) || running.has(n)) continue;
      for (const [sig, e] of gated) {
        let need = false;
        try {
          if (typeof envIssue.needs === "function") need = (await envIssue.needs(n, sig, e)) === true;
          else {
            // the contract text (frozen contract when known, else the issue body) is matched against the signature's tools, or for other env codes its path/command tokens
            if (!envBodies.has(n)) envBodies.set(n, `${String(await readBody(n) ?? "")}\n${JSON.stringify(remote?.contractOf?.(n) ?? "")}`);
            const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const toks = sig.startsWith(`${OUTCOME_CODES.ENV_TOOL_MISSING}|`) ? sig.split("|")[1].split(",") : (e.text ?? "").split(/[\s,;:'"`()]+/).filter((t) => t.length >= 4 && /[/.\\]/.test(t) && !/^\d/.test(t));
            need = toks.some((t) => t && new RegExp(`(^|[^\\w-])${esc(t)}($|[^\\w-])`).test(envBodies.get(n)));
          }
        } catch { need = false; }
        if (!need) continue;
        pending.splice(pending.indexOf(n), 1);
        const tools = sig.startsWith(`${OUTCOME_CODES.ENV_TOOL_MISSING}|`) ? sig.split("|")[1].split(",") : null;
        if (!e.issues.includes(n)) e.issues.push(n);
        const final = { issue: n, outcome: "held", cost_usd: 0, minutes: 0, detail: `waiting on env issue #${e.number}: ${sig.split("|")[0]} hit ${e.issues.length - 1} issues; admitted again when it closes`,
          envHold: { kind: tools ? "tool" : "env", sig, from: "pending", version: curVersion(), env: curEnv(), ...(tools ? { tools } : {}), envIssue: e.number, since: now() }, waiting: true };
        results.set(n, final); save();
        decided({ issue: n, what: `held: not admitted, its contract needs the env that env issue #${e.number} tracks (${sig})`, why: `${e.issues.length} issues hit the same signature`, alternative: "admit it into the same env failure" });
        update(final);
        break;
      }
    }
  };
  const classifyOne = async (n) => {
    if (!budget) return;
    let c = null;
    try { c = classify ? await classify(n) : null; } catch { c = null; } // unclassifiable: an ordinary P2 feature
    classes.set(n, { maintenance: !!c?.maintenance, priority: Number.isFinite(Number(c?.priority)) ? Number(c.priority) : 2 });
  };
  const readPriority = async (n) => {
    if (!reg) return;
    let p = null;
    try { p = priorityOf ? await priorityOf(n) : null; } catch { p = null; }
    priorities.set(n, p !== null && p !== "" && Number.isFinite(Number(p)) ? Number(p) : 2);
  };
  // #4409: fail-open: a thrown or junk estimate is the M default.
  const readEstimate = async (n, body) => {
    if (!estimate || estimates.has(n)) return;
    let v = null;
    try { v = Number(await estimate(n, { body })); } catch { v = null; }
    estimates.set(n, Number.isFinite(v) && v > 0 ? v : EST_DEFAULT_MIN.M);
  };
  // #4773: a declaration line is an edge only when the body's author is trusted (the engine's admission applies the same rule).
  // #5824: `logicalDeps(n)` adds the plan's code-derived logical edges (bin/lean/dag.mjs), trusted or not.
  const declared = async (n, body) => {
    let extra = [];
    try { extra = typeof logicalDeps === "function" ? (logicalDeps(n) ?? []).filter((d) => Number.isSafeInteger(d) && d > 0 && d !== n) : []; } catch { extra = []; }
    if (typeof trusted === "function") { let ok = false; try { ok = (await trusted(n)) === true; } catch { ok = false; } if (!ok) return extra; }
    return [...new Set([...parseDeps(body, n), ...extra])];
  };
  // #5112: a dependency that ended `decomposed` (sub-issues joined, mode not off) is its sub-issues, to a fixpoint; used on every edge write.
  const throughDecomposed = (ds) => {
    if (!joinsDecomposed(autoChildren?.mode ?? "decomposed")) return [...new Set(ds)];
    const out = [], seen = new Set(), stack = [...ds].reverse();
    while (stack.length) {
      const d = stack.pop();
      if (seen.has(d)) continue;
      seen.add(d);
      const r = results.get(d), subs = r?.outcome === "decomposed" && Array.isArray(r.subissues) ? r.subissues.filter((x) => Number.isSafeInteger(x) && x > 0) : [];
      if (subs.length) stack.push(...[...subs].reverse()); else out.push(d);
    }
    return [...new Set(out)];
  };
  // #5112: the issue's declared edges re-read from its body (null when unreadable: the caller keeps what it has).
  const reread = async (n) => {
    let body;
    try { body = await readBody(n); } catch { return null; }
    if (drift?.holds) bodies.set(n, body);
    return declared(n, body);
  };
  const readDeps = async (n) => {
    let body = "";
    try { body = await readBody(n); } catch { /* unreadable: no ordering info, work-on's own check still applies */ }
    if (drift?.holds) bodies.set(n, body);
    const d = await declared(n, body);
    await readEstimate(n, body);
    await classifyOne(n);
    await readPriority(n);
    if (resolveLane) { let l; try { l = await resolveLane(n); } catch (e) { l = { ok: false, code: "lane.unresolved", detail: e?.message ?? String(e), transient: true }; } lanes.set(n, l); }
    // deps marks the issue read (a resume skips it): set it last, so a concurrent setup save never persists a half-read issue (#4963)
    deps.set(n, throughDecomposed(d));
  };
  const edges = (n) => (deps.get(n) ?? []).filter((d) => set.has(d));
  // A milestone issue waiting on a staging fix (or the reverse) never sees that fix on its own base: surface the edge.
  const noteCrossLane = () => {
    for (const n of order) for (const d of edges(n)) {
      const a = lanes.get(n), b = lanes.get(d), key = `${n}<${d}`;
      if (!a?.ok || !b?.ok || a.lane === b.lane || crossSeen.has(key)) continue;
      crossSeen.add(key);
      onCrossLane({ issue: n, lane: a.lane, dependency: d, dependencyLane: b.lane });
    }
  };
  // #4409: `head` (decomposed sub-issues) puts them at the front of the queue in their given order; a sub-issue's
  // estimate is the parent's ÷ N, floored at the M default.
  // #5340: an open declared prerequisite outside the batch joins it, so edges() orders it first (no run that can only end dependency-open).
  const pullPrerequisites = async (ns) => {
    for (const n of ns) {
      if (results.has(n)) continue;
      const { pull } = await openPrerequisites({ deps: deps.get(n) ?? [], inBatch: (d) => set.has(d), results, issueState, issueLabels });
      if (pull.length) { await addIssues(pull); decided({ issue: n, what: `prerequisite ${pull.map((d) => `#${d}`).join(", ")} is open: pulled into the batch ahead of it`, why: "declared Depends on, outside the batch", alternative: "start the run and end dependency-open" }); }
    }
  };
  const addIssues = async (ns, { head = false, parent = null } = {}) => {
    const fresh = ns.filter((d) => !set.has(d));
    for (const d of fresh) {
      set.add(d); order.push(d);
      if (estimate && parent !== null && estimates.has(parent)) estimates.set(d, Math.max(EST_DEFAULT_MIN.M, estimates.get(parent) / ns.length));
    }
    let at = 0;
    for (const d of fresh) {
      await readDeps(d);
      if (head) { pending.splice(at++, 0, d); heads.add(d); } else pending.push(d);
      enqueued.set(d, now());
    }
    await pullPrerequisites(fresh);
    noteCrossLane();
  };
  // New issues (a fresh batch, or extra issues passed to a resume) join the queue.
  for (const n of issues) if (!set.has(n)) { set.add(n); order.push(n); pending.push(n); }
  for (const n of pending) if (!enqueued.has(n)) enqueued.set(n, now());
  // #4963: bounded-concurrency setup reads; each issue's result lands in Maps keyed by issue, so `order` and the edges are unchanged.
  const unread = order.filter((n) => !deps.has(n));
  if (unread.length) {
    setup = { read: 0, total: unread.length };
    save();
    await mapLimit(unread, setupConcurrency, async (n) => { await readDeps(n); setup.read++; save(); });
    setup = null;
  }
  await pullPrerequisites([...pending]);
  if (estimate) for (const n of order) { // a resume that enabled the estimator
    if (estimates.has(n) || results.has(n)) continue;
    let b = ""; try { b = await readBody(n); } catch { b = ""; }
    await readEstimate(n, b);
  }
  if (budget) for (const n of order) if (!classes.has(n)) await classifyOne(n); // a resume that enabled the budget
  if (drift?.holds) for (const n of pending) if (!bodies.has(n)) { try { bodies.set(n, await readBody(n)); } catch { bodies.set(n, ""); } } // a resume
  if (reg) for (const n of order) if (!priorities.has(n)) await readPriority(n); // a resume of a pre-#4191 batch
  noteCrossLane();
  save();

  // Host registry seams (#4191): `offered` issues are queued for a slot, `slotted` ones hold one.
  const offered = new Set(), slotted = new Set();
  let fellBack = false;
  // #4777: `sched.cap` may be a function (the host-derived local lane cap), evaluated at every attempt so it stays live.
  const liveCap = () => { try { return typeof sched.cap === "function" ? sched.cap() : sched.cap; } catch { return null; } };
  const keyOf = (n) => `${sched?.batch ?? batchId ?? "?"}#${n}`;
  const prioOf = (n) => priorities.get(n) ?? 2;
  // #4409: priority, then the head band (decomposed sub-issues; with an estimator also starved issues, oldest first), then
  // the estimate plus in-batch dependents' estimates descending, then queue order. Without an estimator: queue order.
  const rank = (ready) => {
    const t = now(), idx = new Map(pending.map((n, i) => [n, i]));
    const starved = (n) => !!estimate && !heads.has(n) && t - (enqueued.get(n) ?? t) > starveMs;
    const weight = (n) => {
      if (!estimate) return 0;
      let w = estimates.get(n) ?? 0;
      for (const m of order) if (m !== n && !results.has(m) && edges(m).includes(n)) w += estimates.get(m) ?? 0;
      return w;
    };
    return ready.map((n) => ({ n, p: prioOf(n), b: heads.has(n) || starved(n) ? 0 : 1, s: starved(n) ? enqueued.get(n) : 0, w: weight(n), i: idx.get(n) ?? 0 }))
      .sort((a, b) => a.p - b.p || a.b - b.b || a.s - b.s || b.w - a.w || a.i - b.i).map((x) => x.n);
  };
  const entryOf = (n) => ({ key: keyOf(n), batch: sched?.batch ?? batchId ?? null, repo: sched?.repo ?? null, issue: n, priority: prioOf(n), ...(sched?.exclusive ? { exclusive: true } : {}) });
  // #4964: remote lanes are published to the registry for `sched show` only; they never take a slot
  const endRemote = (n) => { if (remoteRun.delete(n)) reg?.dropRemote?.(keyOf(n)); };
  const noteRemote = (n, h) => { reg?.noteRemote?.(keyOf(n), { ...entryOf(n), sandbox: h?.id ?? null, agent: h?.agent ?? null }); };
  let poolDown = false;
  const notePool = (down, reason) => { if (down === poolDown) return; poolDown = down; reg?.notePool?.(sched?.batch ?? batchId ?? "?", down ? { reason } : null); };
  const releaseSlot = (n) => { if (reg && slotted.delete(n)) reg.release(keyOf(n)); };
  const offerFresh = (ns) => { const fresh = ns.filter((n) => !offered.has(n)); if (!fresh.length) return; reg.offer(fresh.map(entryOf)); for (const n of fresh) offered.add(n); };
  const withdrawExcept = (keep) => {
    const gone = [...offered].filter((n) => !keep.has(n));
    if (!gone.length) return;
    reg.withdraw(gone.map(keyOf));
    for (const n of gone) offered.delete(n);
  };
  // The batch's sandbox usage: settled (persisted) plus the running remote lanes' elapsed minutes so far.
  const remoteUsage = () => {
    let minutes = 0, cost_usd = 0, rm = 0;
    for (const u of sandboxUse.values()) { minutes += Number(u?.minutes) || 0; cost_usd += Number(u?.cost_usd) || 0; }
    const t = now();
    for (const n of remoteRun) { const st = runRecs.get(n)?.startedAt; if (Number.isFinite(st)) rm += Math.max(0, t - st) / 60000; }
    return { minutes: minutes + rm, cost_usd: cost_usd + rm * remoteCpm, running: { minutes: rm, cost_usd: rm * remoteCpm } };
  };
  // A thrown budget check refuses: the cap is hard.
  const admitRemote = () => {
    if (typeof remote?.admit !== "function") return { ok: true };
    try { const a = remote.admit(remoteUsage()); return a?.ok === false ? { ok: false, reason: a.reason ?? "cap reached" } : { ok: true }; }
    catch (e) { return { ok: false, reason: `budget check failed: ${e?.message ?? e}` }; }
  };
  const noteBudget = (reason) => {
    if (budgetHit === null) update({ issue: null, outcome: "budget", detail: `execution budget reached: ${reason}; ${remote?.onBudget === "local" || remote?.fallbackLocal ? "remaining lanes run locally" : "no further remote lanes admitted"}` });
    budgetHit = reason;
  };
  // #4481: another batch runs a lane for `n` now: retry after a poll, one row (and decision) per other batch.
  const busyNoted = new Map(); // issue -> the other batch last reported
  const busy = (n, other, wanted) => {
    const delayMs = Math.max(pollMs, 1);
    notBefore.set(n, now() + delayMs); offered.delete(n); wanted.delete(n);
    if (busyNoted.get(n) !== other) {
      busyNoted.set(n, other); save();
      decided({ issue: n, what: `deferred: batch ${other} runs a lane for #${n}`, why: "one lane per issue on the host (two batches include it)", alternative: "run a second lane on the same branch" });
      update({ issue: n, outcome: "deferred", pr: null, cost_usd: 0, minutes: 0, detail: `#${n} has a live lane in batch ${other}; retried in ${Math.round(delayMs / 1000)}s` });
    }
    return "busy";
  };
  // #5112: opt-in (`execution.fallback_local`): an issue the pool refused `capacityFallbackAfter` times (default CAPACITY_FALLBACK_AFTER)
  // for `sandbox.capacity` runs on the host when the host-busy guard (`remote.headroom()`, absent = allowed) passes; not ok or a throw waits.
  const capacityFallback = (n) => {
    if (!remote?.offlineFallback || !hostFallbackOn()) return false; // #5746: host_fallback: false keeps the lane on the pool
    const after = Number.isInteger(remote.capacityFallbackAfter) && remote.capacityFallbackAfter > 0 ? remote.capacityFallbackAfter : CAPACITY_FALLBACK_AFTER;
    if ((capDefers.get(n) ?? 0) < after) return false;
    // #5592: an overloaded host holds every local admission (host_overloaded), so falling back would park the lane indefinitely: keep retrying the pool
    if (overload) { try { if (overload()?.overloaded) return false; } catch { /* unknown load: the headroom guard decides */ } }
    if (typeof remote.headroom !== "function") return true;
    try { return remote.headroom()?.ok !== false; } catch { return false; }
  };
  // A host slot for `n` (a lane-refused issue runs nothing and needs none); refused: `n` stays queued in the registry.
  // true: start it; false: no capacity now; "busy" (#4481): another batch runs `n`, try the next issue.
  let overloadNoted = false; // #5174: one host-overloaded row per overload episode
  const grant = (n, wanted) => {
    if (lanes.get(n)?.ok === false) return true;
    let p = placeOf(n);
    if (p?.where === "remote" && typeof remote?.identity === "function") {
      // #5095: the pool account is held for a usage limit: hybrid runs the lane on the host, remote-only waits for the reset
      let poolHeld = null;
      try { const u = holds.holdUntil(remote.identity()); poolHeld = Number.isFinite(u) && u > now() ? u : null; } catch { poolHeld = null; }
      if (poolHeld !== null) {
        if (!remote.fallbackLocal || heldUntil() !== null) { notBefore.set(n, poolHeld); return false; }
        p = { where: "local", reason: `fallback to local: pool usage limit until ${new Date(poolHeld).toISOString()}` };
      }
    }
    if (p?.where === "remote" && reg?.holder) {
      let other = null;
      try { other = reg.holder(entryOf(n)) ?? null; } catch { other = null; }
      if (other !== null) return busy(n, other, wanted);
    }
    if (p?.where === "remote") {
      const adm = admitRemote();
      if (adm.ok) {
        // #4540: the provider's free slots (`remote.capacity() -> {free, at}`, sync, null = unknown) cap admissions per sample `at`; the issue queues here instead of a 503.
        let cap = null, probeFailed = false;
        try { cap = remote.capacity?.() ?? null; } catch { probeFailed = true; }
        // #5048: only a failed probe (a throw) marks the pool down; null is unknown (first pass, no capacity()) and leaves the state; a sample clears it.
        if (probeFailed) notePool(true, "capacity probe failed"); else if (cap !== null) { notePool(false); concEmit(conc.observe(cap)); } // #5985: the live sample moves the operating point
        // #4788: zero live agents for longer than `remote.poolOfflineMin` (default 10): one loud batch event, none while online > 0.
        if (cap && cap.online === 0) {
          poolOfflineSince ??= now();
          const limitMs = (posNum(remote.poolOfflineMin) ?? POOL_OFFLINE_ALERT_MIN) * 60000;
          if (!poolStallNoted && now() - poolOfflineSince > limitMs) {
            poolStallNoted = true;
            update({ issue: null, outcome: "pool-offline", detail: `STALLED: no compute pool agent online for over ${Math.round(limitMs / 60000)} min; ${remote.offlineFallback ? "lanes fall back to the host" : "remote lanes wait (set execution.fallback_local or use mode local to run on the host)"}` });
          }
        } else if (cap && cap.online > 0) { poolOfflineSince = null; poolStallNoted = false; }
        // #4547: opt-in (`execution.fallback_local`): every pool agent offline or asleep (sampled online 0) runs the lane on the host.
        if (remote.offlineFallback && hostFallbackOn() && cap && cap.online === 0) {
          p = { where: "local", reason: `fallback to local: no pool agent online (${p.reason})` };
        } else if (capacityFallback(n)) {
          p = { where: "local", reason: `fallback to local: pool at capacity after ${capDefers.get(n)} deferrals (${p.reason})` };
          if (!capFellBack.has(n)) {
            capFellBack.add(n);
            decided({ issue: n, what: `run #${n} on the host: the pool refused it ${capDefers.get(n)} times for capacity (execution.fallback_local)`, why: "sustained sandbox.capacity and the host has headroom",
              alternative: "keep deferring until a pool slot frees" });
          }
        } else if (cap && (Number.isInteger(cap.free) || capWait.conditional(n, cap))) {
          if (cap.at !== capAt) { capAt = cap.at; capAdmits = 0; }
          // #5985: a refusal's named condition (load < 1.0, free mem > floor) and the per-lane refusal hold gate the relaunch, not the timer
          if (capWait.blocked(n, cap) || conc.holding(n, cap)) { notBefore.set(n, now() + Math.max(pollMs, 1)); return false; }
          if (Number.isInteger(cap.free) && capAdmits >= cap.free && remoteRun.size < remoteMax()) { notBefore.set(n, now() + Math.max(pollMs, 1)); return false; }
        }
        if (p.where === "remote" && remoteRun.size < remoteMax()) { remoteCapped.delete(n); capWait.admitted(n); remoteRun.add(n); capAdmits++; placed.set(n, p); return true; }
        if (p.where === "remote" && (!remote.fallbackLocal || !hostFallbackOn())) { // #5746: host_fallback: false never runs a capped remote lane on the host
          if (remoteMax() < 1 && !maxHeldNoted.has(n)) { maxHeldNoted.add(n); decided({ issue: n, what: `waiting: max_remote 0 (#${n} is queued, not run on the host)`, why: "remote mode holds admissions while max_remote is 0", alternative: "raise max_remote or set execution.host_fallback: true" }); }
          remoteCapped.add(n); return false;
        }
        if (p.where === "remote") p = { where: "local", reason: `fallback to local: max_remote ${remoteMax()} reached (${p.reason})` }; // #4256: hybrid runs it on the host
      } else {
        noteBudget(adm.reason);
        if ((remote.onBudget !== "local" && !remote.fallbackLocal) || !hostFallbackOn()) { budgetStop = adm.reason; return false; } // #5746: host_fallback: false stops instead of using the host
        budgetLocal = true; // falls through to the host path
        p = { where: "local", reason: `fallback to local: execution budget: ${adm.reason}` };
      }
    }
    if (p?.where !== "remote" && overload) {
      let snap = null;
      try { snap = overload(); } catch { snap = null; }
      if (snap?.overloaded) {
        if (!overloadNoted) { overloadNoted = true; update({ issue: null, outcome: "host-overloaded", detail: formatOverload(snap) }); }
        notBefore.set(n, now() + Math.max(pollMs, 1));
        return false;
      }
      overloadNoted = false;
    }
    if (!reg) { if (p) placed.set(n, p); return true; }
    const r = reg.tryAcquire(keyOf(n), entryOf(n), liveCap());
    if (!r?.ok && r?.conflict != null) return busy(n, r.conflict, wanted);
    if (!r?.ok) { offered.add(n); wanted.add(n); return false; }
    offered.delete(n); slotted.add(n);
    if (p) placed.set(n, p);
    if (r.fallback && !fellBack) { fellBack = true; update({ issue: null, outcome: "sched", detail: `host lane registry unavailable, admitting without the global cap: ${r.reason}` }); }
    return true;
  };

  // #4687: a dependency skip is a waiting state while a blocker re-check can still re-admit it (`waiting`, cleared when the batch ends);
  // the log row names the triggering issue.
  const skip = (n, detail, trigger = null) => {
    results.set(n, { issue: n, outcome: "skipped", pr: null, cost_usd: 0, minutes: 0, detail, ...(trigger !== null && dispatchCheck ? { waiting: true } : {}) });
    update({ ...results.get(n), ...(trigger !== null ? { trigger } : {}) });
  };
  // #5162: a dependent of a failed root ends held (trigger = the root, not the parent) and is released with the root.
  const holdBehind = (n, root, rootOutcome) => {
    results.set(n, { issue: n, outcome: "held", pr: null, cost_usd: 0, minutes: 0, detail: `blocked by #${root} (${rootOutcome})`, root, ...(dispatchCheck ? { waiting: true } : {}) });
    update({ ...results.get(n), trigger: root });
  };
  const requeue = (n, delayMs) => { pending.push(n); enqueued.set(n, now()); if (delayMs > 0) notBefore.set(n, now() + delayMs); else notBefore.delete(n); };
  const TRANSPORT_COOLDOWN_MS = 5 * 60000;
  const netTransients = new Map(); // #5947: issue -> net.transient deferrals (backoff step)
  const envDetails = []; // #5978: the details of the recent engine-errors, for the breaker auto-reset
  let transportErrors = 0; // #4685: engine-errors in the current window that were link failures
  const noteEngineError = (detail = "") => {
    if (!breaker) return;
    const t = now(), windowMs = breaker.window_min * 60000;
    errorTimes = [...errorTimes.filter((x) => t - x < windowMs), t];
    envDetails.push(detail); if (envDetails.length > breaker.errors) envDetails.shift();
    transportErrors = isTransientEngineError(detail) ? Math.min(transportErrors + 1, errorTimes.length) : 0;
    if (!tripped && errorTimes.length >= breaker.errors) {
      tripped = { at: t, ...(envDetails.length && envDetails.every(environmentalDetail) ? { environmental: true } : {}), ...(transportErrors >= errorTimes.length ? { transport: true } : {}), detail: `circuit breaker: ${errorTimes.length} engine-errors within ${breaker.window_min} min; admissions stopped` };
      update({ issue: null, outcome: "breaker", detail: tripped.detail });
    }
    return t;
  };
  // #5859: sandboxes of one pool agent ending without a result in a burst (AGENT_LOST_MIN within AGENT_LOST_WINDOW_MS) are an agent/VM
  // restart: `sandbox.lost`, requeued once (after `remote.agentHealthy(agent)` answers, when the provider has it), never counted by the
  // breaker or the engine-error relaunch. Lanes of the burst that settled as engine-errors first are rolled back. One batch event each.
  // #5988: one backend.auth outage at a time: probed on a clock, rotated, escalated once; `authPass` runs every loop pass.
  let authOutage = null;
  const authPass = async () => {
    const o = authOutage; if (!o) return;
    const t = now();
    if (!o.escalated && t - o.since >= AUTH_ESCALATE_MS) {
      o.escalated = true;
      const detail = `backend.auth: the claude login has failed for ${Math.round((t - o.since) / 60000)} min (accounts tried: ${[...o.failed].join(", ") || "none"}); admissions no longer held, operator action needed`;
      try { holds.clear(o.key); } catch { /* fail-open */ }
      for (const m of o.issues) notBefore.delete(m);
      for (const f of o.failed) limitedAccounts.delete(f);
      update({ issue: null, outcome: "auth-escalation", detail });
      try { await onEscalate?.({ detail, issues: [...o.issues], batch: batchId ?? null }); } catch { /* advisory */ }
      return;
    }
    if (o.escalated || !authProbe || t < o.nextProbe) return;
    const next = nextAccountAfterAuthFailure(rotator, o.last ? [o.last] : []); // the account after the one that failed last
    let ok = false; try { ok = Boolean((await authProbe({ account: next, configDir: next ? rotator?.configDir?.(next) ?? null : null }))?.ok); } catch { ok = false; }
    if (ok) {
      try { holds.clear(o.key); } catch { /* fail-open */ }
      for (const m of o.issues) notBefore.delete(m);
      for (const f of o.failed) limitedAccounts.delete(f);
      authOutage = null;
      update({ issue: null, outcome: "auth-resumed", detail: `backend.auth recovered after ${Math.round((t - o.since) / 60000)} min; admissions resumed${next ? ` on account ${next}` : ""}` });
    } else {
      if (next) o.last = next;
      o.nextProbe = t + AUTH_PROBE_MS;
    }
  };
  // #5988: engine-errors with one host-bound signature on one agent are counted per (signature, agent): at the breaker's threshold only that
  // agent is quarantined (its cache reseeded once); the batch breaker never sees them, so unaffected agents keep admitting.
  const QUARANTINE_REQUEUES = 3, quarantineRequeues = new Map(), scopedSeen = new Map(), quarantined = new Map(), reseeded = new Set(); // quarantined: key -> until
  const scopedEngineError = async (agent, sig) => {
    const t = now(), key = `${sig}|${agent}`, windowMs = breaker.window_min * 60000, win = [...(scopedSeen.get(key) ?? []).filter((x) => t - x < windowMs), t];
    scopedSeen.set(key, win);
    if (quarantined.get(key) > t) return { quarantined: true };
    if (win.length >= breaker.errors) {
      quarantined.set(key, t + windowMs);
      if (!reseeded.has(agent)) { reseeded.add(agent); try { await reseedCache?.({ agent, signature: sig }); } catch { /* advisory */ } }
      try { await quarantineAgent?.({ agent, signature: sig, errors: win.length }); } catch { /* advisory */ }
      update({ issue: null, outcome: "agent-quarantine", detail: `agent ${agent} quarantined: ${win.length} engine-errors (${sig}) within ${breaker.window_min} min; other agents keep admitting` });
      return { quarantined: true };
    }
    return { quarantined: false };
  };
  const lostSeen = new Map(); // agent -> [{n, at, err, ee, tr, sig}]: lost lanes settled as ordinary engine-errors in the window
  const openRestart = (agent, t) => agentRestarts.find((g) => g.agent === agent && !g.closed && t - g.last < AGENT_LOST_WINDOW_MS);
  const markLost = (agent, n, row, why) => {
    lostOnce.add(n);
    let g = openRestart(agent, now());
    if (!g) agentRestarts.push(g = { agent, at: new Date(now()).toISOString(), last: now(), lanes: [] });
    if (!g.lanes.includes(n)) g.lanes.push(n);
    g.last = now(); g.requeued = g.lanes.length;
    update({ ...row, outcome: "deferred", code: OUTCOME_CODES.SANDBOX_LOST, detail: `requeued: ${OUTCOME_CODES.SANDBOX_LOST} (agent ${agent} restarted): ${why ?? ""}` });
  };
  const rollBackLost = (agent, x) => {
    if (x.err !== undefined) { const i = errorTimes.lastIndexOf(x.err); if (i >= 0) errorTimes.splice(i, 1); transportErrors = Math.min(transportErrors, errorTimes.length); }
    if (!pending.includes(x.n) && !running.has(x.n)) return; // it already ended (its relaunch was used before): only the breaker count goes
    for (const [m, v] of [[engineErrors, x.ee], [transients, x.tr], [engineSigs, x.sig]]) { if (v === undefined) m.delete(x.n); else m.set(x.n, v); }
    if (pending.includes(x.n)) notBefore.set(x.n, now() + AGENT_LOST_REQUEUE_MS);
    markLost(agent, x.n, { issue: x.n }, "settled as an engine-error before the restart was visible; rolled back");
  };
  const closeRestart = (g) => {
    g.closed = true; g.requeued = g.lanes.length; g.detail = `agent ${g.agent} restarted at ${g.at}; ${g.lanes.length} lanes requeued`;
    const ev = { event: "agent.restarted", batch: batchId ?? null, agent: g.agent, at: g.at, requeued: g.lanes.length, issues: [...g.lanes], detail: g.detail };
    try { store?.log?.(ev); } catch { /* best effort */ }
    onUpdate(ev);
  };
  const agentLostPass = async (t) => {
    let changed = false;
    for (const g of agentRestarts) {
      if (g.closed) continue;
      if (!g.healthyAt) {
        let ok = true;
        if (typeof remote?.agentHealthy === "function") { try { ok = (await remote.agentHealthy(g.agent)) === true; } catch { ok = false; } }
        if (ok) { g.healthyAt = new Date(t).toISOString(); changed = true; } else for (const m of g.lanes) if (pending.includes(m)) notBefore.set(m, Math.max(notBefore.get(m) ?? 0, t + pollMs));
      }
      if (g.healthyAt && t - g.last >= AGENT_LOST_WINDOW_MS) { closeRestart(g); changed = true; }
    }
    if (changed) save();
  };

  // #5986: a failed lane lands in the issue's ledger; a lifetime-budget breach escalates once (FORGE:ESCALATION, needs-human) and parks the row.
  const recordAttempt = async (n, row, r) => {
    try {
      const hash = (await attempts.hash?.(n)) ?? null;
      let l = ledgers.get(n) ?? (await attempts.load?.(n)) ?? null;
      l = recordFailure(l, { signature: failureSignature(row.code ?? r?.code, row.detail), hash, spend: Number(row.cost_usd) || 0, run: r?.runUrl ?? null });
      const b = breach(l, attempts.cfg);
      if (b && !l.escalated) {
        l = markEscalated(l);
        await attempts.notify?.({ issue: n, code: "escalate", ledger: l, reason: b.detail });
        if (row.outcome !== "needs-human") { row.detail = `attempts.exhausted: ${b.detail}\n${String(row.detail ?? "")}`; row.outcome = "needs-human"; }
        decided({ issue: n, what: `escalated #${n} to a person: ${b.detail}`, why: "lifetime attempt budget (#5986)", alternative: "run another lane on the same input" });
      }
      ledgers.set(n, l);
      const comments = await attempts.mirror?.(n, l);
      if (Number.isInteger(comments)) ledgers.set(n, { ...l, comments });
    } catch { /* the ledger is best effort: a failed write never changes the lane's outcome */ }
  };
  // Apply one lane's result: requeue it (deferred, dependency-open, engine-error) or record its final row.
  const settleLane = async (n, r, rec, pf) => {
    if (halted) return; // #4454: a resume adopts the lane and settles it
    // #5947: a git transport failure ends the lane as a `net.transient` deferral with backoff; the breaker never sees it.
    if (!cancelled && (r?.terminalReason ?? "engine-error") === "engine-error" && GIT_TRANSPORT_TEXT.test(String(r?.detail ?? ""))) {
      const k = (netTransients.get(n) ?? 0) + 1;
      netTransients.set(n, k);
      r = { ...r, terminalReason: "deferred", code: OUTCOME_CODES.NET_TRANSIENT, retryInSeconds: Math.round(transientRetryDelayMs(k) / 1000), detail: r.detail };
    }
    // #5241: the lane ended: its lease goes with it. #5654: also an interrupted or engine-error end, which is requeued at once
    if (releaseLease && (cancelled || (r?.terminalReason ?? "engine-error") === "engine-error" || (r?.terminalReason === "deferred" && r?.code === "run.interrupted"))) { try { await releaseLease(n, rec); } catch { /* best effort: the lease expires */ } }
    // #4304: the pre-filter runs once per issue; a recovery pass's row adds the earlier attempt's cost, which already holds it.
    const pfCost = recovering.has(n) ? 0 : (pf?.cost_usd ?? 0);
    const row = { issue: n, outcome: r?.terminalReason ?? "engine-error", pr: r?.pr ?? null, cost_usd: (r?.cost_usd ?? 0) + pfCost, minutes: Math.round((now() - rec.startedAt) / 6000) / 10, detail: r?.detail, ...(r?.code ? { code: r.code } : {}), ...(r?.culprit ? { culprit: r.culprit } : {}), ...(pf ? { prefilter: pf } : {}), ...(rec?.stackedOn ? { stacked: true, stackedOn: rec.stackedOn } : {}),
      ...(() => { const w = capWait.take(n, r?.waits); return w && typeof w === "object" ? { waits: w } : {}; })(), ...(Number.isInteger(r?.heavyQueueMax) ? { heavyQueueMax: r.heavyQueueMax } : {}),
      ...(Number.isFinite(r?.wall_ms) ? { wall_ms: r.wall_ms } : {}), ...(Number.isFinite(r?.model_ms) ? { model_ms: r.model_ms } : {}), // #4451
      ...(phasesOf(r, rec) ? { phases: phasesOf(r, rec) } : {}), // #4908
      ...(Array.isArray(r?.followups) && r.followups.length ? { followups: r.followups } : {}), // #5078
      ...(r?.cascade ? { cascade: r.cascade, cascades: Array.isArray(r.cascades) ? r.cascades : [r.cascade], ...(Number.isFinite(r.cascade_cost_usd) ? { cascade_cost_usd: r.cascade_cost_usd } : {}), ...(Number.isFinite(r.cascade_minutes) ? { cascade_minutes: r.cascade_minutes } : {}) } : {}), // #5833
      ...(edges(n).length ? { deps: edges(n) } : {}), ...(firstAdmit.has(n) ? { admitted_at: firstAdmit.get(n), ended_at: now() } : {}), ...(planMs.has(n) ? { plan_minutes: Math.round(planMs.get(n) / 6000) / 10 } : {}), // #5834
      ...(Number.isFinite(r?.precheckMs) ? { precheck_ms: r.precheckMs } : {}), ...(Number.isInteger(r?.precheckDeferred) && r.precheckDeferred > 0 ? { precheck_deferred: r.precheckDeferred } : {}), // #4331
      ...(typeof r?.firstPass === "boolean" ? { first_pass: r.firstPass } : {}), // #4362
      ...(r?.turns && typeof r.turns === "object" ? { turns: r.turns } : {}), // #4392
      ...(r?.conformance && typeof r.conformance === "object" ? { conformance: r.conformance } : {}), // #4398
      ...(rec?.placement ? { placement: rec.placement } : {}), ...(estimates.has(n) ? { est_minutes: Math.round(estimates.get(n) * 10) / 10 } : {}) }; // #4409
    noteLimited(r); // #5205
    const quotaPause = row.outcome === "deferred" && (r?.code === "rate_limited" || r?.code === "quota.exhausted") && !cancelled;
    if (!quotaPause && quota.has(n)) { // #5094: the paused attempts' cost, added once
      const q = quota.get(n); quota.delete(n);
      row.cost_usd = Math.round(((Number(row.cost_usd) || 0) + (Number(q.cost_usd) || 0)) * 1e6) / 1e6;
      row.minutes = Math.round(((Number(row.minutes) || 0) + (Number(q.minutes) || 0)) * 10) / 10;
    }
    const depList = (Array.isArray(r?.dependencies) ? r.dependencies : []).filter((d) => Number.isSafeInteger(d) && d > 0 && d !== n);
    const subs = (Array.isArray(r?.subissues) ? r.subissues : []).filter((d) => Number.isSafeInteger(d) && d > 0 && d !== n);
    if (subs.length) row.subissues = subs; // #4396: links a decomposed parent to its sub-lanes in the report
    if (r?.decomposition && typeof r.decomposition === "object") row.decomposition = r.decomposition;
    if (r?.sandbox && typeof r.sandbox === "object") {
      const prev = sandboxUse.get(n) ?? { minutes: 0, cost_usd: 0, attempts: 0 };
      const m = Number(r.sandbox.minutes) >= 0 ? Number(r.sandbox.minutes) : 0, c = Number(r.sandbox.cost_usd) >= 0 ? Number(r.sandbox.cost_usd) : 0;
      const by = { ...(prev.by_agent ?? {}) }; // #4549: minutes per pool agent, over attempts
      if (typeof r.sandbox.agent === "string" && r.sandbox.agent) by[r.sandbox.agent] = Math.round(((by[r.sandbox.agent] ?? 0) + m) * 10) / 10;
      sandboxUse.set(n, { minutes: Math.round((prev.minutes + m) * 10) / 10, cost_usd: Math.round((prev.cost_usd + c) * 1e6) / 1e6, attempts: prev.attempts + 1, ...(Object.keys(by).length ? { by_agent: by } : {}) });
      try { remote?.onUsage?.(n, r.sandbox, rec); } catch { /* the batch total still counts it */ }
    }
    if (sandboxUse.has(n)) row.sandbox = { ...sandboxUse.get(n), ...(sandboxUse.get(n).by_agent ? { by_agent: { ...sandboxUse.get(n).by_agent } } : {}) };
    const done = () => { running.delete(n); runRecs.delete(n); releaseSlot(n); endRemote(n); };
    if (train && row.outcome === "pr-ready" && Number.isInteger(r?.pr) && r?.head) { // #5836: the slot frees now; the train merges the PR
      const p = recovering.get(n);
      if (p) { recovering.delete(n); row.cost_usd = Math.round(((Number(row.cost_usd) || 0) + (Number(p.cost_usd) || 0)) * 1e6) / 1e6; row.minutes = Math.round(((Number(row.minutes) || 0) + (Number(p.minutes) || 0)) * 10) / 10; }
      train.add({ issue: n, pr: r.pr, head: r.head, required: Array.isArray(r.required) ? r.required : [], policy: r.policy, lane: r.lane ?? rec?.lane ?? null, milestone: r.milestone, postMerge: r.postMerge, laneSide: r.laneSide });
      results.set(n, row); done(); save(); update(row);
      return;
    }
    const planVerdict = rec?.plan && r?.terminalReason !== "planned" && PLAN_VERDICT.has(row.outcome);
    if (planVerdict) { // #5909: a verdict end (invalid, needs-human, ...) is the issue's answer: it settles as a final row below, no build lane
      planMs.set(n, (planMs.get(n) ?? 0) + Math.max(0, now() - rec.startedAt));
      store?.log?.({ event: "STACK_PLAN_FAILED", issue: n, reason: row.outcome });
    } else if (rec?.plan) {
      // #5831: a plan lane ends `planned` or `plan-failed` and goes back to pending for its build lane. It is never a final row and
      // never counts toward the breaker, the engine-error relaunch, the deferral or the requeue budgets (it returns before them).
      done();
      planMs.set(n, (planMs.get(n) ?? 0) + Math.max(0, now() - rec.startedAt)); // #5834
      const ok = r?.terminalReason === "planned" && r?.planned?.contractHash && r?.planned?.baseSha;
      if (ok) planned.set(n, { contractHash: r.planned.contractHash, baseSha: r.planned.baseSha });
      store?.log?.({ event: ok ? "STACK_PLANNED" : "STACK_PLAN_FAILED", issue: n, ...(ok ? { contractHash: r.planned.contractHash, baseSha: r.planned.baseSha } : { reason: row.outcome }) });
      requeue(n, 0); save();
      if (!ok) decided({ issue: n, what: `plan lane for #${n} ended ${row.outcome}; it will run as a normal build lane after its dependencies`, why: firstLine(row.detail) || row.outcome, alternative: "retry the plan lane" });
      update({ ...row, outcome: ok ? "planned" : "plan-failed", ...(ok ? { detail: `contract ${r.planned.contractHash} frozen at ${String(r.planned.baseSha).slice(0, 12)}` } : {}) });
      return;
    }
    // #5805: an engine/env-caused end that would repeat as-is: held with its signature, re-admitted by watchEnvHolds, never terminal.
    const holdEnv = ({ kind, sig, tools = null, why, envIssueNo = null }) => {
      const p = recovering.get(n);
      if (p) { // a recovery lane that hit an engine-error: its earlier attempts' cost stays on the row
        recovering.delete(n);
        row.cost_usd = Math.round(((Number(row.cost_usd) || 0) + (Number(p.cost_usd) || 0)) * 1e6) / 1e6;
        row.minutes = Math.round(((Number(row.minutes) || 0) + (Number(p.minutes) || 0)) * 10) / 10;
      }
      const triggers = [...(envIssueNo ? [`env issue #${envIssueNo} closing`] : []), "an engine upgrade", ...(envHold?.envFingerprint ? ["a --set-env"] : []), ...(tools?.length && envHold?.missingTools ? [`${tools.join(", ")} found on the host`] : [])];
      const final = { ...row, outcome: "held", detail: `waiting on engine/env change: ${why}; re-admitted on ${triggers.join(" or ")}\n${String(row.detail ?? "")}`,
        envHold: { kind, sig, from: row.outcome, version: curVersion(), env: curEnv(), ...(tools?.length ? { tools } : {}), ...(envIssueNo ? { envIssue: envIssueNo } : {}), since: now() }, waiting: true };
      results.set(n, final); done(); save();
      decided({ issue: n, what: `held: waiting on engine/env change (${why})`, why: firstLine(row.detail) || row.outcome,
        alternative: kind === "engine" ? "relaunch into the same engine-error, or end engine-error and wait for a manual --requeue" : "launch a recovery that fails the same way, or end needs-human and wait for a manual --requeue" });
      update(final);
    };
    if (row.outcome === "dependency-open" && depList.length) {
      // #4387: a parked dependency is not pulled in again (fail-open on an unreadable label).
      let parked;
      for (const d of depList) {
        if (["needs-human", "budget-exceeded"].includes(results.get(d)?.outcome)) { parked = d; break; } // #4505: an unrecovered overrun parks too
        if (set.has(d) || typeof issueLabels !== "function") continue;
        if (typeof issueState === "function") { // #4725: a closed (completed) dependency is satisfied: its stale needs-human label is not a blocker
          let st = "";
          try { st = String((await issueState(d)) ?? "").toUpperCase(); } catch { st = ""; }
          if (st === "CLOSED") continue;
        }
        let names = [];
        try { names = (await issueLabels(d)) ?? []; } catch { names = []; }
        if (Array.isArray(names) && names.includes("needs-human")) { parked = d; break; }
      }
      if (parked !== undefined) {
        done();
        const final = { ...row, outcome: "skipped", detail: `dependency #${parked} needs-human`, ...(dispatchCheck ? { waiting: true } : {}) };
        results.set(n, final); save();
        decided({ issue: n, what: `skipped: dependency #${parked} needs-human (not pulled into the batch)`, why: firstLine(row.detail) || "the lane reported an open dependency",
          alternative: `pull #${parked} in and run it again` });
        update({ ...final, trigger: parked });
        return;
      }
    }
    if (row.outcome === "dependency-open" && depList.length && (requeues.get(n) ?? 0) < MAX_REQUEUES) {
      // A scheduling fact, not a failure: add the edge, pull the dependency in, and run this issue again after it.
      requeues.set(n, (requeues.get(n) ?? 0) + 1);
      deps.set(n, throughDecomposed([...(deps.get(n) ?? []), ...depList]));
      await addIssues(depList);
      // Dependencies already done but still open on GitHub: a delay instead of a hot relaunch loop.
      const allDone = depList.every((d) => results.has(d) && SATISFIED.has(results.get(d).outcome));
      requeue(n, allDone ? DEP_REQUEUE_DELAY_S * 1000 : 0); done(); save();
      decided({ issue: n, what: `requeued behind ${depList.map((d) => `#${d}`).join(", ")} (Depends on edge added)`, why: firstLine(row.detail) || "the lane reported an open dependency",
        alternative: "skip the issue and its dependents" });
      update({ ...row, detail: `requeued behind ${depList.map((d) => `#${d}`).join(", ")}` });
      return;
    }
    // #4376: a lane stopped by a cancel is not a scheduling failure: requeued (held at the end), no deferral, no hold.
    if (cancelled && (row.outcome === "deferred" || row.outcome === "engine-error")) {
      requeue(n, 0); done(); save();
      update({ ...row, detail: `stopped by cancel: ${r?.code ?? row.outcome}${r?.detail ? ` ${r.detail}` : ""}` });
      return;
    }
    if (!(row.outcome === "deferred" && r?.code === "sandbox.capacity")) capDefers.delete(n); // #5746: a lane the pool accepted resets the capacity count
    if (row.outcome === "deferred" && (r?.code === "stack.replan" || r?.code === "stack.restart") && !cancelled) {
      // #5833: the stacked dependent's PR and branch were dropped. replan: it builds as a normal lane on the lane base (today's held/skipped
      // rules decide while its dependency is unsatisfied); restart: it may stack again on the dependency's new head, from the frozen contract.
      const so = stackedOf.get(n);
      stackedOf.delete(n); planned.delete(n);
      if (r.code === "stack.restart") { stackedTried.delete(n); if (so) prReady.delete(so.dependency); }
      requeue(n, 0); done(); save();
      store?.log?.({ event: "STACK_CASCADE", issue: n, cascade: r.cascade, ...(so ? { dependency: so.dependency } : {}) });
      decided({ issue: n, what: `stacked cascade ${r.cascade} for #${n}`, why: firstLine(row.detail) || "the stacked dependency moved or ended", alternative: "keep the stacked PR" });
      update({ ...row, detail: `requeued after cascade ${r.cascade}: ${firstLine(row.detail)}` });
      return;
    }
    if (row.outcome === "deferred") {
      const pol = deferPolicy(r, { now: now(), deferrals: deferrals.get(n) ?? 0, maxDeferrals });
      let capGated = false; // #4909: the pool reports free slots, so the slot (not the retry-in timer) gates the relaunch
      if (r?.code === "sandbox.unreachable") notePool(true, r.detail ?? "sandbox unreachable");
      if (r?.code === "base.red" && baseProbe && !baseRedHold) { // #5992: a lane's base.red result raises the one batch hold at once (its guardRed verdict is cached, so this runs no second probe)
        try { const v = await baseProbe(); if (v?.red) { const issue = Number.isInteger(v.att?.issue) ? v.att.issue : null, detail = `base.red: base ${String(v.sha).slice(0, 12)} is red on ${(v.commands ?? []).join(", ") || "a guard command"}${v.att ? `; last change ${String(v.att.sha).slice(0, 12)}${issue ? ` (#${issue})` : ""}` : ""}; admissions paused until the base moves`; update({ issue: null, outcome: "preflight", code: "base.red", detail }); baseRedHold = { sha: v.sha, issue, detail }; } } catch { /* the next pass probes */ }
      }
      if (r?.code === "sandbox.capacity") {
        capWait.refused(n, r.reason ?? null);
        concEmit(conc.refused({ issue: n, code: r.code, reason: r.reason, live: r.live ?? null })); // #5985
        if (r.detail) capReasons.set(n, String(r.detail).slice(0, 300));
        // #5112: counted for the fallback_local capacity fallback; #5746: a host-busy refusal is not pool capacity
        if (!/host[ _-]?busy|headroom/i.test(String(r.detail ?? ""))) capDefers.set(n, (capDefers.get(n) ?? 0) + 1);
        try { const c = remote?.capacity?.(); capGated = Number.isInteger(c?.free) || capWait.conditional(n, c); } catch { capGated = false; }
      }
      if (!pol.capped) {
        if (!pol.host && !pol.hold) deferrals.set(n, (deferrals.get(n) ?? 0) + 1);
        // A usage limit is held per account; the hold, not a per-issue delay, gates the retry, so a lane on another
        // account runs it at once. If the hold cannot be recorded, the reset delay applies to this issue instead.
        let delayMs = pol.delayMs;
        if (pol.hold) {
          // #5094: an account rotator with headroom means another account runs the next call, so no host hold is recorded.
          // #5203: a usage limit on the pool account rotates like a rotator account (the router hands the next sandbox the
          // lowest-usage login, #5165), so it sets no pool hold and no batch-wide notBefore while any account has headroom.
          const usage = r?.code === "rate_limited" || r?.code === "quota.exhausted";
          let poolId = null;
          if (usage) { try { poolId = remote?.identity?.() ?? null; } catch { poolId = null; } }
          const rq = quotaRequeue({ rotator, r, prior: quota.get(n), delayMs: pol.delayMs, exclude: excluded(), poolId });
          // #5205: no account with room: hold until the rotator's earliest reset (tokenbaton's, over every account), not now+delay
          let rotAt = null;
          if (!rq && rotator && (!r?.backendId || (poolId && r.backendId === poolId) || (() => { try { return rotator.isAccount(r.backendId); } catch { return false; } })())) { // a remote credential keeps its own reset
            try { const p = typeof rotator.pick === "function" ? rotator.pick({ exclude: excluded() }) : null; rotAt = p && p.account === null && Number.isFinite(p.earliestReset) ? p.earliestReset : rotator.resumeAt(excluded()); } catch { rotAt = null; }
            if (!(Number.isFinite(rotAt) && rotAt > now())) rotAt = null;
          }
          // #5203: no account has headroom: the hold lasts until the earliest reset across accounts, not this lane's own reset.
          let holdMs = usage && rotAt !== null ? rotAt - now() : pol.delayMs;
          if (r?.code === "backend.auth") { // #5988: probe every 5 min, never hold past the 30 min escalation, rotate to the next account
            const t0 = now();
            if (!authOutage) authOutage = { since: t0, nextProbe: t0 + AUTH_PROBE_MS, failed: new Set(), escalated: false, key: r?.backendId ?? identity(), issues: new Set() };
            authOutage.issues.add(n);
            try { const cur = authOutage.escalated ? null : rotator?.current?.(); if (cur) { authOutage.failed.add(cur); authOutage.last = cur; limitedAccounts.set(cur, t0 + AUTH_PROBE_MS); try { rotator.markLimited?.(cur, t0 + AUTH_PROBE_MS); } catch { /* best effort */ } } } catch { /* fail-open */ }
            holdMs = Math.min(holdMs, AUTH_PROBE_MS);
            if (t0 - authOutage.since >= AUTH_ESCALATE_MS) { await authPass(); holdMs = 0; }
          }
          if (rq) {
            delayMs = rq.delayMs;
            // #5095 + #5094: the pool account's own hold (not the host's) still routes hybrid lanes local until its reset.
            try { const pool = remote?.identity?.(); if (!rq.rotated && pool && r?.backendId === pool) holds.set(pool, now() + pol.delayMs, `batch ${batchId ?? "?"} #${n}`); } catch { /* fail-open */ }
          } else if (holdMs > 0 || r?.code !== "backend.auth") try { holds.set(r?.backendId ?? identity(), rotAt ?? now() + holdMs, `batch ${batchId ?? "?"} #${n}`); delayMs = 0; } catch { /* fail-open */ }
          else delayMs = AUTH_PROBE_MS; // #5988: escalated: no hold; the lane retries as its own probe
          const q = quota.get(n) ?? { cost_usd: 0, minutes: 0, rotations: 0 };
          const resumeAt = usage ? now() + (rq ? rq.delayMs : holdMs) : Math.max(now() + (rq ? rq.delayMs : pol.delayMs), rotAt ?? 0);
          quota.set(n, { cost_usd: Math.round(((Number(q.cost_usd) || 0) + (Number(row.cost_usd) || 0)) * 1e6) / 1e6, minutes: Math.round(((Number(q.minutes) || 0) + (Number(row.minutes) || 0)) * 10) / 10,
            resumeAt, rotations: (q.rotations ?? 0) + (rq?.rotated ? 1 : 0) + (Number(r?.rotations) || 0) }); // #5205: plus the lane's own in-phase rotations
          requeue(n, delayMs); done(); save();
          const iso = new Date(resumeAt).toISOString();
          update({ ...row, outcome: "paused", quota: { resumeAt: iso }, detail: `paused (${r?.code === "backend.auth" ? "backend.auth" : "quota"}) until ${iso}: ${r?.code ?? "deferred"}${r?.detail ? ` ${r.detail}` : ""}` });
          if (r?.code === "quota.exhausted") { const ev = { event: "quota.exhausted", issue: n, batch: batchId ?? null, resumeAt: iso, detail: `quota.exhausted: no account has capacity; resuming ${iso}` }; try { store?.log?.(ev); } catch { /* best effort */ } onUpdate(ev); } // #5236: batch-level event supervisors see
          return;
        }
        requeue(n, capGated ? 0 : delayMs); done(); save();
        update({ ...row, detail: `requeued in ${Math.round(pol.delayMs / 1000)}s: ${r?.code ?? "deferred"}${r?.detail ? ` ${r.detail}` : ""}` });
        return;
      }
      row.detail = `gave up after ${deferrals.get(n) ?? 0} deferrals: ${r?.detail ?? r?.code ?? ""}`;
    }
    const la = row.outcome === "engine-error" && r?.lostWithoutResult && !cancelled && !lostOnce.has(n) ? (r.agent ?? r.sandbox?.agent ?? null) : null;
    let lostNow = null;
    if (la) { // #5859
      const t = now(), win = (lostSeen.get(la) ?? []).filter((x) => t - x.at < AGENT_LOST_WINDOW_MS);
      if (openRestart(la, t) || win.length + 1 >= AGENT_LOST_MIN) {
        lostSeen.delete(la);
        for (const x of win) rollBackLost(la, x);
        if (tripped && !tripped.transport && breaker && errorTimes.length < breaker.errors && win.length && tripped.at >= win[0].at) {
          tripped = null;
          update({ issue: null, outcome: "breaker", detail: `circuit breaker cleared: the engine-errors were agent ${la} restarting (${OUTCOME_CODES.SANDBOX_LOST})` });
        }
        markLost(la, n, row, row.detail);
        requeue(n, AGENT_LOST_REQUEUE_MS); done(); save();
        return;
      }
      lostNow = { n, at: t, ee: engineErrors.get(n), tr: transients.get(n), sig: engineSigs.get(n) };
      lostSeen.set(la, [...win, lostNow]);
    }
    if (row.outcome === "engine-error") {
      const ag = r?.agent ?? r?.sandbox?.agent ?? null, hs = ag && breaker ? hostSignature(r, row.detail) : null;
      const sc = hs ? await scopedEngineError(ag, hs) : null;
      const qn = sc?.quarantined ? (quarantineRequeues.get(n) ?? 0) + 1 : 0; // a lane waits out the quarantine a bounded number of times, then counts as an ordinary engine-error (batch breaker included)
      if (sc?.quarantined && qn <= QUARANTINE_REQUEUES) { quarantineRequeues.set(n, qn); // #5988: an agent in quarantine: its lane waits and is requeued without a relaunch or breaker count; unaffected agents keep admitting
        requeue(n, AGENT_LOST_REQUEUE_MS); done(); save();
        update({ ...row, outcome: "requeued", detail: `requeued: agent ${ag} is quarantined (${hs}); retried in ${Math.round(AGENT_LOST_REQUEUE_MS / 1000)}s` });
        return;
      }
      const errAt = hs && !sc?.quarantined ? undefined : noteEngineError(r?.detail);
      if (lostNow) lostNow.err = errAt;
      // #5161: a transient failure (gateway 5xx, reset) waits out the outage with backoff instead of the single immediate relaunch.
      if (transientMax > 0 && isTransientEngineError(row.detail)) {
        const k = (transients.get(n) ?? 0) + 1;
        if (k <= transientMax) {
          const delayMs = transientRetryDelayMs(k), secs = Math.round(delayMs / 1000);
          transients.set(n, k);
          requeue(n, delayMs); done(); save();
          decided({ issue: n, what: `retry after transient engine-error (${k}/${transientMax}) in ${secs}s`, why: `transient: ${firstLine(row.detail) || "engine-error"}`,
            alternative: "end the issue engine-error and skip its dependents" });
          update({ ...row, detail: `transient retry ${k}/${transientMax} in ${secs}s: ${row.detail ?? ""}` });
          return;
        }
        row.detail = `gave up after ${transientMax} transient retries: ${row.detail ?? ""}`;
      } else if (ehOn && deterministic.has(`${curVersion()}|${failureSignature(r?.code, row.detail)}`)) {
        // #5805: this exact engine-error already repeated on this engine version: a relaunch would hit it again
        return holdEnv({ kind: "engine", sig: failureSignature(r?.code, row.detail), why: `the same engine-error already repeated on engine v${curVersion() ?? "?"}` });
      } else if ((engineErrors.get(n) ?? 0) < ENGINE_ERROR_RELAUNCHES) {
        engineErrors.set(n, (engineErrors.get(n) ?? 0) + 1);
        if (ehOn) engineSigs.set(n, failureSignature(r?.code, row.detail));
        requeue(n, 0); done(); save();
        decided({ issue: n, what: "relaunch once after engine-error", why: firstLine(row.detail) || "engine-error", alternative: "end the issue engine-error and skip its dependents" });
        update({ ...row, detail: `relaunching once: ${row.detail ?? ""}` });
        return;
      } else if (ehOn && engineSigs.get(n) === failureSignature(r?.code, row.detail)) {
        // #5805: the relaunch failed identically: deterministic for this engine version, held (not terminal) until the engine or env changes
        const sig = failureSignature(r?.code, row.detail);
        deterministic.add(`${curVersion()}|${sig}`);
        return holdEnv({ kind: "engine", sig, why: `the relaunch failed with the same engine-error on engine v${curVersion() ?? "?"}` });
      }
    }
    if (row.outcome === "decomposed" && subs.length && joinsDecomposed(autoChildren?.mode ?? "decomposed")) {
      await addIssues(subs, { head: true, parent: n }); // #4409: on the batch's critical path by construction
      decided({ issue: n, what: `added sub-issues ${subs.map((d) => `#${d}`).join(", ")} to the batch; dependents wait on them`, why: "the builder decomposed the issue",
        alternative: "end the batch row decomposed and let dependents wait for a later batch" });
      for (const [m, ds] of deps) if (ds.includes(n)) deps.set(m, [...new Set(ds.flatMap((d) => (d === n ? subs : [d])))]);
      noteCrossLane();
    }
    // #4267: a recovery pass ends here; a recoverable row under the attempt cap is requeued as a recovery lane.
    const prior = recovering.get(n) ?? null;
    // #4318: the full persisted lane reason (capped by the comment writer), not its first 300 chars
    const evidence = () => recoveryEvidence({ code: prior.code, attempt: prior.attempt, outcome: row.outcome, resultCode: row.code, detail: row.detail, full: true });
    if (prior) {
      recovering.delete(n);
      // #4298: the row reports the whole issue: earlier attempts' cost and minutes are summed into the recovery's.
      row.cost_usd = Math.round(((Number(row.cost_usd) || 0) + (Number(prior.cost_usd) || 0)) * 1e6) / 1e6;
      row.minutes = Math.round(((Number(row.minutes) || 0) + (Number(prior.minutes) || 0)) * 10) / 10;
      if (row.outcome === "merged") row.recovered = prior.code;
      else row.recovery = { code: prior.code, attempts: recoveries.get(n) ?? prior.attempt, outcome: row.outcome, ...(row.code ? { result_code: row.code } : {}), detail: firstLine(row.detail) };
      // A recovery that failed for good keeps needs-human. The lane relabels needs-human/ci-pending itself; engine-error (after its
      // relaunch) and deferred (no longer requeued) end here, so the runner does it, once. invalid/decomposed/dependency-*/merged never.
      if (["engine-error", "deferred"].includes(row.outcome) && typeof relabelNeedsHuman === "function") {
        try { await relabelNeedsHuman({ issue: n, evidence: evidence() }); } catch { /* best effort */ }
      }
    }
    // #5526: the hold is re-read here (it is only read once per pass): a held issue's terminal outcome starts no recovery lane.
    // #5755: an env.* needs-human end is the engine's defect: one env issue per signature, the product issue held on it (waiting-dependency), no needs-human.
    if (envIssue && row.outcome === "needs-human" && ENV_ALL_CODES.includes(row.code)) {
      const tools = row.code === OUTCOME_CODES.ENV_TOOL_MISSING ? toolsOf(row.detail) : null;
      const sig = envKey(row.code, row.detail);
      const no = await fileEnvIssue({ sig, code: row.code, issue: n, tools: tools ? tools.split(",") : null, evidence: String(row.detail ?? "") });
      // A security issue is not parked behind an env fix and never sits in remediation-queue: it keeps its needs-human for a person.
      let names = []; try { names = typeof issueLabels === "function" ? ((await issueLabels(n)) ?? []) : []; } catch { names = []; }
      if (names.some((l) => /security/i.test(String(l?.name ?? l)))) {
        row.securityEscalated = true;
        row.detail = `Security issue escalated: ${row.code} is an env defect tracked${no ? ` on env issue #${no}` : ""}; it is not parked in the remediation queue.\n${String(row.detail ?? "")}`;
        if (typeof relabelNeedsHuman === "function") { try { await relabelNeedsHuman({ issue: n, evidence: `Security issue escalated: \`${row.code}\` env defect${no ? ` (env issue #${no})` : ""}:\n${String(row.detail ?? "")}` }); } catch { /* best effort */ } }
        decided({ issue: n, what: `escalated: ${row.code} on a security issue, not held or queued for remediation`, why: firstLine(row.detail), alternative: "hold it on the env issue like other product issues" });
      } else return holdEnv({ kind: tools ? "tool" : "env", sig, tools: tools ? tools.split(",") : null, envIssueNo: no, why: no ? `${row.code}: env issue #${no} owns the fix` : `${row.code}: the env issue could not be filed; held, never needs-human` });
    }
    const heldNow = recoveryMax && ["needs-human", "ci-pending", "budget-exceeded"].includes(row.outcome) && (refreshHeld(), opHeld.has(n));
    if (heldNow) decided({ issue: n, what: `no recovery lane for #${n}: ${heldByOperator(n)}`, why: firstLine(row.detail) || row.outcome, alternative: "recover while the operator holds it" });
    if (recoveryMax && !heldNow && ["needs-human", "ci-pending", "budget-exceeded"].includes(row.outcome)) {
      let isConflicting = false;
      if (row.outcome === "ci-pending" && typeof conflicting === "function" && Number.isInteger(row.pr)) {
        try { isConflicting = (await conflicting(n, row.pr)) === true; } catch { isConflicting = false; }
      }
      const facts = { ...row, issueEdited: r?.issueEdited === true, quoteMismatch: r?.quoteMismatch === true, conflicting: isConflicting };
      if (prior) { const pk = `${n}:${recoveryClassOf({ code: prior.code })}`; classUsed.set(pk, Math.max(classUsed.get(pk) ?? 0, prior.free ? prior.attempt - 1 : prior.attempt)); } // #5727: a free recovery spent no attempt // state saved before #4725 has no class counts
      const cls = recoveryClassOf(facts), max = maxFor(cls), used = classUsed.get(`${n}:${cls}`) ?? 0;
      // #5232: a deterministic env defect of the frozen command that a recovery attempt repeated verbatim is not rebuilt again
      const repeatEnv = prior && REPEAT_ENV_CODES.includes(row.code) && prior.code === row.code && envSig(row.code, prior.detail) === envSig(row.code, row.detail);
      // #5592: a first env.tool_missing that ran on this host (not a remote sandbox) would be replayed with the identical frozen contract on the same host and fail identically: not launched as-is
      const sameHostReplay = !repeatEnv && !prior && row.code === OUTCOME_CODES.ENV_TOOL_MISSING && row.placement?.where !== "remote" && toolsOf(row.detail) !== null;
      // #5805: an env defect the host still has is held until the engine, the batch env or the host changes, not ended or re-run.
      // A tool-missing recovery that would run on the host (not the #5423 remote retry) is not launched while the probe still misses the tool.
      const envNoHost = !hostFallbackOn() && row.placement?.where === "remote" && [OUTCOME_CODES.ENV_CAPABILITY_REMOTE, OUTCOME_CODES.ENV_TOOL_MISSING].includes(row.code);
      const lacking = row.code === OUTCOME_CODES.ENV_TOOL_MISSING ? toolsOf(row.detail) : null;
      if (ehOn && !envNoHost && !row.securityEscalated) {
        let stillLacks = false;
        if (!repeatEnv && !sameHostReplay && lacking && classifyNeedsHuman(facts) === "recoverable" && used < max && !(row.placement?.where === "remote" && used === 0 && !budgetLocal)) {
          const miss = await missingTools(lacking.split(","));
          stillLacks = !!miss?.length;
        }
        if (repeatEnv || sameHostReplay || stillLacks) {
          return holdEnv({ kind: lacking ? "tool" : "env", sig: `${row.code}|${envSig(row.code, row.detail)}`, tools: lacking ? lacking.split(",") : null,
            why: repeatEnv ? `the recovery repeated the same ${row.code}` : `the host ${sameHostReplay ? "that ran it " : "still "}lacks ${lacking}` });
        }
      }
      if (sameHostReplay) {
        row.detail = `Environment defect: the run already executed on the host that lacks ${toolsOf(row.detail)}, and a recovery would replay the identical frozen contract on that same host, so none is launched. Install the tool or fix the dependency install on the host (or amend the contract's validate/env), then requeue.\n${String(row.detail ?? "")}`;
        decided({ issue: n, what: `no recovery for ${row.code}: the frozen contract would fail identically on the same host`, why: firstLine(row.detail), alternative: "requeue a recovery lane that replays the same frozen contract on the same host" });
      }
      if (repeatEnv) {
        row.detail = `Environment defect: the recovery attempt failed with the same \`${row.code}\` as the run before it, so no further rebuild is spent; run the command below on the host with the project's real dependencies.\n${String(row.detail ?? "")}`;
        decided({ issue: n, what: `no further recovery for ${row.code}: the same failure repeated`, why: firstLine(row.detail), alternative: "requeue another recovery lane that rebuilds against the same frozen command" });
      }
      // #5652: a remote lane's tool/capability end is not recovered on the host when host fallback is off; the lane message names the fix
      const noHostRecovery = !hostFallbackOn() && row.placement?.where === "remote" && [OUTCOME_CODES.ENV_CAPABILITY_REMOTE, OUTCOME_CODES.ENV_TOOL_MISSING].includes(row.code);
      if (noHostRecovery) decided({ issue: n, what: `no host re-placement for ${row.code}: host fallback is off (execution.host_fallback / host.role: orchestrator)`, why: firstLine(row.detail), alternative: "re-place the lane on the host" });
      // #5979: failure.repeated is a typed park (not in RECOVERABLE_CODES): never relaunched, reported parked below
      if (!repeatEnv && !noHostRecovery && !sameHostReplay && row.code !== OUTCOME_CODES.FAILURE_REPEATED && classifyNeedsHuman(facts) === "recoverable" && used < max) {
        // #5727: the first remote end on a tool no recipe can install, before any build work, is re-placed on the host without spending an attempt
        const free = !prior && r?.toolNoRecipe === true && row.code === OUTCOME_CODES.ENV_TOOL_MISSING && row.placement?.where === "remote" && !freeRecovered.has(n);
        const code = recoveryCodeOf(facts), attempt = used + 1;
        if (free) freeRecovered.add(n); else classUsed.set(`${n}:${cls}`, attempt);
        // #4315: the full lane detail is kept (never firstLine) for the relabel when the batch stops before this attempt
        recoveries.set(n, (recoveries.get(n) ?? 0) + 1); recovering.set(n, { code, attempt, max, cost_usd: Number(row.cost_usd) || 0, minutes: Number(row.minutes) || 0,
          detail: String(row.detail ?? ""), outcome: row.outcome, ...(row.placement?.where ? { where: row.placement.where } : {}), ...(free ? { free: true, toolNoRecipe: true } : r?.toolNoRecipe === true ? { toolNoRecipe: true } : {}), ...(row.code ? { result_code: row.code } : {}), prev_attempt: prior?.attempt ?? 0 });
        requeue(n, 0); done(); save();
        // #5647: the first lane labelled needs-human before the batch chose to recover; swap it for workflow:recovering while the recovery runs
        if (typeof markRecovering === "function") { try { await markRecovering({ issue: n, code, attempt, max }); } catch { /* best effort: needs-human stays */ } }
        decided({ issue: n, what: `recovery lane for ${code} (attempt ${attempt}/${max}); dependents stay queued`, why: firstLine(row.detail) || code,
          alternative: "leave needs-human for the operator and skip the dependents" });
        update({ ...row, outcome: "recovering", detail: `recovering (${code}), attempt ${attempt}/${max}: ${firstLine(row.detail)}` });
        return;
      }
    }
    // #4302: a non-final recovery attempt left needs-human/ci-pending unlabelled for its successor; none is launched, so relabel once.
    if (prior && prior.attempt < (prior.max ?? recoveryMax) && ["needs-human", "ci-pending", "budget-exceeded"].includes(row.outcome) && typeof relabelNeedsHuman === "function") {
      try { await relabelNeedsHuman({ issue: n, evidence: evidence() }); } catch { /* best effort */ }
    }
    // #4505: a first-run turn overrun is unlabelled by its lane; no recovery follows (off or cap used), so the runner labels it once.
    if (!prior && row.outcome === "budget-exceeded" && typeof relabelNeedsHuman === "function") {
      try { await relabelNeedsHuman({ issue: n, evidence: `Implement turn budget overrun (\`budget.exceeded\`) not recovered in this batch:\n${String(row.detail ?? "")}` }); } catch { /* best effort */ }
    }
    // #4656: a mechanical terminal park (recovery spent or none applies) moves to the remediation queue, not the human queue.
    if (row.outcome === "needs-human" && !row.parkedQueued && !row.securityEscalated && !everRelabelled.has(n) && typeof relabelNeedsHuman === "function" && (cls => cls === "parked" || (cls === "recoverable" && prior))(classifyNeedsHuman({ ...row, issueEdited: r?.issueEdited === true }, { parked: true }))) { // a recoverable row with a finished recovery has used its attempts
      try { const res = await relabelNeedsHuman({ issue: n, parked: { code: row.code, pr: Number.isInteger(row.pr) ? row.pr : null }, evidence: `Mechanical park \`${row.code}\`${Number.isInteger(row.pr) ? ` (PR #${row.pr})` : ""}:\n${String(row.detail ?? "")}` }); if (res !== false && res !== "failed" && res !== "skipped") row.parkedQueued = true; else if (res === false || res === "failed") { const ev = { event: "relabel.failed", issue: n, batch: batchId ?? null, detail: `parked relabel failed (${row.code}): needs-human kept` }; try { store?.log?.(ev); } catch { /* best effort */ } onUpdate(ev); } } catch { /* best effort */ }
    }
    if (attempts && ATTEMPT_FAILED.includes(row.outcome)) await recordAttempt(n, row, r); // #5986
    results.set(n, row);
    if (row.outcome === "merged" && lifecycle && r?.milestone) lifecycleTitles.add(String(r.milestone)); // #4657
    if (row.outcome === "merged") await closeOnLane(n, rec?.lane ?? r?.lane, row);
    if (row.outcome === "merged" && integration?.onMerged && String(rec?.lane ?? r?.lane ?? "").startsWith("milestone/")) {
      // #4667: counts the merge toward the milestone's integration run; an error is a row, never the outcome.
      try { await integration.onMerged(n, { ...row, lane: rec?.lane ?? r?.lane }, r); } catch (e) { update({ issue: n, outcome: "integration", detail: `integration check failed: ${String(e?.message ?? e).slice(0, 300)}` }); }
    }
    if (row.outcome === "merged" && drift?.onMerged && r?.structure && String(rec?.lane ?? r?.lane ?? "").startsWith("milestone/")) {
      save(); update(row);
      // Before the slot frees: the batch never ends with a fold pending, and block_dispatch sees the new flags.
      try { await drift.onMerged(n, { ...row, lane: rec?.lane ?? r?.lane }, r); } catch (e) { update({ issue: n, outcome: "drift", detail: `drift check failed: ${String(e?.message ?? e).slice(0, 300)}` }); }
      done(); save();
      return;
    }
    done(); save(); update(row);
  };

  // #5437: a lane's post-run bookkeeping (r.postRun) starts once its slot is free; the batch waits for it before it ends.
  const postRuns = new Set();
  const settle = async (n, r, rec, pf) => {
    if (r?.kept) keptBoxes.set(n, r.kept); // #6008
    await settleLane(n, r, rec, pf);
    if (typeof r?.postRun !== "function") return;
    const p = Promise.resolve().then(() => r.postRun()).catch(() => {}).finally(() => postRuns.delete(p));
    postRuns.add(p);
  };
  const track = (n, p) => { running.set(n, p.catch((e) => settle(n, { terminalReason: "engine-error", detail: e?.message ?? String(e) }, runRecs.get(n), null))); };
  const laneRetries = new Map(); // #4791: transient lane-resolution failures per issue; never counted in `deferrals`
  // A transient refusal (gh/git failed) re-resolves; the settled `deferred` frees the slot and requeues with backoff.
  const retryLane = (n, rec) => track(n, (async () => {
    let l; try { l = await resolveLane(n); } catch (e) { l = { ok: false, code: "lane.unresolved", detail: e?.message ?? String(e), transient: true }; }
    lanes.set(n, l);
    if (l.ok || !l.transient) { laneRetries.delete(n); return { terminalReason: "deferred", code: "lane.unresolved", retryInSeconds: 1, cost_usd: 0, detail: l.ok ? "lane resolved" : `${l.code}: ${l.detail}` }; }
    const k = laneRetries.get(n) ?? 0; laneRetries.set(n, k + 1);
    return { terminalReason: "deferred", code: "lane.unresolved", retryInSeconds: Math.min(DEFER_BACKOFF_S * 2 ** k, DEFER_BACKOFF_MAX_S), cost_usd: 0, detail: l.detail };
  })().then((x) => settle(n, x, rec, null)));
  const start = (n, { plan = false, stackedOn = null } = {}) => {
    const ln = lanes.get(n);
    if (ln && !ln.ok && ln.transient && resolveLane) { retryLane(n, runRecs.get(n) ?? { startedAt: now() }); return; }
    if (ln && !ln.ok) { // settled synchronously: nothing runs, no lease, no comment
      const row = { issue: n, outcome: "lane-refused", pr: null, cost_usd: 0, minutes: 0, detail: `${ln.code}: ${ln.detail}`, code: ln.code };
      results.set(n, row); save(); update(row);
      return;
    }
    const lane = ln?.lane;
    if (relabelled.delete(n)) save(); // #4315: the recovery lane launches after all; it removes needs-human itself
    const pl = placed.get(n);
    placed.delete(n);
    const queueMs = Number.isFinite(enqueued.get(n)) ? Math.max(0, now() - enqueued.get(n)) : null; // #4908: queue_wait in the phase ledger
    heads.delete(n); enqueued.delete(n); busyNoted.delete(n);
    const rec = { startedAt: now(), ...(plan ? { plan: true } : {}), ...(stackedOn ? { stackedOn } : {}), ...(queueMs != null ? { queueMs } : {}), ...(lane ? { lane } : {}), ...(remoteRun.has(n) ? { remote: true } : {}), ...(pl ? { placement: pl } : {}) };
    if (!firstAdmit.has(n)) firstAdmit.set(n, rec.startedAt); // #5834: chain wall time starts at the first admission, plan lane included
    runRecs.set(n, rec); keptBoxes.delete(n); notBefore.delete(n); capReasons.delete(n); save();
    track(n, (async () => {
      // Pre-filter once per issue (a requeued issue is not re-checked); fail-open: an error means a normal lane.
      if (prefilter && !checked.has(n)) { let pf = null; try { pf = await prefilter(n, lane); } catch { pf = null; } checked.set(n, pf); save(); }
      const pf = checked.get(n) ?? null;
      // #4481: every start re-checks GitHub: a closed issue or a merged PR ends the row without a lane (fail-open).
      let gone = null;
      if (dispatchCheck && !cancelled && !pf?.closed && !pf?.parked) {
        try { gone = (await dispatchCheck(n)) ?? null; } catch { gone = null; }
        if (!["merged", "invalid", "deferred"].includes(gone?.outcome)) gone = null; // #4920: deferred = another lane owns the issue (lease or open PR on GitHub)
      }
      // #5526: a hold placed since the pass read is honoured at launch: the issue goes back to pending, no lane
      if (!cancelled && !halted) { refreshHeld(); refreshPause(); if (opHeld.has(n) || opPause) { running.delete(n); runRecs.delete(n); releaseSlot(n); endRemote(n); requeue(n, 0); save(); return; } }
      if (halted) return; // #4454: stopped before launch; no pid, so a resume queues it again
      let r;
      if (cancelled) r = { terminalReason: "deferred", code: "run.interrupted", cost_usd: 0, detail: "cancelled before launch" }; // #4376
      else if (pf?.closed) r = { terminalReason: "invalid", cost_usd: 0, detail: `pre-filter: ${pf.detail}` };
      else if (gone) r = { terminalReason: gone.outcome, ...(gone.outcome === "deferred" && gone.code ? { code: gone.code } : {}), pr: Number.isInteger(gone.pr) ? gone.pr : null, cost_usd: 0, detail: `skipped at dispatch: ${gone.detail ?? gone.outcome}` };
      // #4389: a parked post-deploy follow-up starts no lane; it ends awaiting-promotion|awaiting-precondition, re-checked next batch.
      else if (pf?.parked) r = { terminalReason: pf.kind, cost_usd: 0, detail: `pre-filter: ${pf.detail}` };
      else {
        try {
          r = await runOne(n, lane, { ...(signal ? { signal } : {}), remote: !!rec.remote, ...(rec.placement ? { placement: rec.placement } : {}), ...(plan ? { plan: true } : planned.has(n) ? { planned: planned.get(n) } : {}), ...(rec.stackedOn ? { stackedOn: rec.stackedOn } : {}), ...(recovering.has(n) ? { recover: { code: recovering.get(n).code, attempt: recovering.get(n).attempt, final: recovering.get(n).attempt >= (recovering.get(n).max ?? recoveryMax) } } : {}), onStart: (info) => {
            Object.assign(rec, info ?? {}); save();
            if (rec.remote && remoteRun.has(n)) noteRemote(n, rec.handle);
            if (cancelled) stop(n, rec); // #4376: launched while the cancel arrived
            if (reg && slotted.has(n) && info?.pid) reg.setLanePid(keyOf(n), info.pid);
          } });
        }
        catch (e) { r = { terminalReason: "engine-error", detail: e?.message ?? String(e) }; }
      }
      await settle(n, r, rec, pf);
    })());
  };

  // Lanes launched by an earlier dispatcher: re-attach to the live ones, queue the rest again (no result was recorded).
  // #4504: every adopt starts at once and races its `onLive` signal, so a live lane never holds up the others: one that
  // already ended is settled from its result (or requeued without one) before scheduling; a live one is awaited in the background.
  // #5204: a requeue is never silent: one `deferred`/`run.interrupted` row names the cause (an upgrade or a plain restart)
  // and `onInterrupted` reconciles the issue's labels. It consumes no deferral, engine-error or recovery attempt.
  const interruptCause = saved?.engineVersion && version && saved.engineVersion !== version ? `upgrade v${saved.engineVersion}→v${version}` : "dispatcher restart";
  const requeueLost = async (n, why) => {
    const rec = runRecs.get(n);
    runRecs.delete(n);
    if (pending.includes(n) || results.has(n)) return;
    // #5654: the lost lane's own lease would defer the requeue as lease.held for its whole TTL
    if (releaseLease) { try { await releaseLease(n, rec); } catch { /* best effort: the lease expires */ } }
    if (pending.includes(n) || results.has(n)) return;
    pending.unshift(n); enqueued.set(n, now());
    update({ issue: n, outcome: "deferred", code: "run.interrupted", pr: null, cost_usd: 0, minutes: 0, detail: `interrupted: ${interruptCause}; ${why}; requeued` });
    decided({ issue: n, what: "requeued (interrupted)", why, alternative: "leave it pending silently" });
    try { Promise.resolve(onInterrupted?.(n, { cause: interruptCause, why })).catch(() => {}); } catch { /* best effort */ }
  };
  const adoptErrors = new Map(); // #5204: issue -> adopt error message, kept for the interrupted row
  const adopting = [...runRecs].map(([n, rec]) => {
    // #5204: a remote record that lost its handle still adopts: the remote seam finds the sandbox through its ledger.
    if (!adopt || !(rec?.pid || rec?.handle || rec?.remote)) return { n, rec, live: false, p: Promise.resolve(null) };
    let onLive;
    const isLive = new Promise((r) => { onLive = () => r(true); });
    const p = Promise.resolve().then(() => adopt(n, rec, { onLive, ...(signal ? { signal } : {}) })).catch((e) => { adoptErrors.set(n, `adopt failed: ${firstLine(e?.message ?? e)}`); return null; });
    return { n, rec, p, first: Promise.race([p.then(() => false), isLive]) };
  });
  for (const a of adopting) a.live = a.first ? await a.first : false;
  for (const { n, rec, p, live } of adopting) {
    if (live) {
      if (rec.remote) { remoteRun.add(n); noteRemote(n, rec.handle); }
      else if (reg) { reg.adoptSlot(keyOf(n), { ...entryOf(n), lanePid: rec.pid }); slotted.add(n); }
      track(n, p.then(async (r) => {
        if (r) return settle(n, r, rec, checked.get(n) ?? null);
        if (halted) return; // #4454: kept for the next resume
        running.delete(n); releaseSlot(n); endRemote(n); await requeueLost(n, "the adopted lane ended without a result"); save(); // ended without a result after all
      }));
      continue;
    }
    const r = await p;
    if (!r) {
      const why = adoptErrors.get(n) ?? (!adopt || !(rec?.pid || rec?.handle || rec?.remote) ? "no adoptable pid or handle" : "the lane ended without a result");
      await requeueLost(n, why); continue;
    }
    if (rec.remote) { remoteRun.add(n); noteRemote(n, rec.handle); }
    else if (reg) { reg.adoptSlot(keyOf(n), { ...entryOf(n), lanePid: rec.pid }); slotted.add(n); } // released by the settle
    track(n, Promise.resolve(r).then((x) => settle(n, x, rec, checked.get(n) ?? null)));
    await running.get(n); // settled before scheduling
  }
  // A resume re-derives each unfinished issue's lane from its current milestone (#4153): a re-milestone takes effect.
  if (saved && resolveLane) {
    for (const n of order) {
      if (results.has(n) || running.has(n)) continue;
      let l; try { l = await resolveLane(n); } catch (e) { l = { ok: false, code: "lane.unresolved", detail: e?.message ?? String(e), transient: true }; }
      lanes.set(n, l);
    }
    noteCrossLane();
  }
  save();

  // #5469: a final held row names the owner and since when the hold recorded them (`forgedock orchestrate --hold ... --for`)
  const heldByOperator = (n) => { let e = null; try { e = getHoldInfo?.()?.[n] ?? null; } catch { e = null; } return e ? `held by operator (${e.owner}, since ${e.since})` : "held by operator"; };
  const heldDetail = (n) => cancelled ? "cancelled by operator" : opHeld.has(n) ? heldByOperator(n) : opPause ? pauseText() : baseHeld.has(n) ? baseHeld.get(n) : tripped?.detail ?? (integHeld.has(n) ? `integration: ${integHeld.get(n)}` : (driftHeld.has(n) ? `drift: ${driftHeld.get(n)} flagged` : budgetStop ? `execution budget: ${budgetStop}` : budgetHeld ? "maintenance share" : "not run"));
  // #4315: a recovery queued but never launched (the batch stopped: breaker, budget, hold; or a resume that did not relaunch a
  // lost run) left the issue without needs-human, since a non-final attempt does not relabel. Relabel it once, with the full reason.
  // #4318: also on a throw out of the loop and on a signal (`onExit`); `cause` overrides the held reason. Runs once per process.
  let exitRelabel = null;
  const relabelQueued = (cause = null) => (exitRelabel ??= (async () => {
    for (const [n, q] of recovering) {
      if (running.has(n) || results.has(n) || relabelled.has(n) || typeof relabelNeedsHuman !== "function") continue;
      const why = cause ?? (heldDetail(n) === "not run" ? "batch stopped" : heldDetail(n));
      const evidence = recoveryEvidence({ code: q.code, attempt: q.prev_attempt, outcome: q.outcome, resultCode: q.result_code, detail: q.detail, full: true,
        queued: q.attempt, cause: why, recoveryMax });
      let res;
      try { res = await relabelNeedsHuman({ issue: n, evidence }); } catch { res = "failed"; }
      if (res !== false && res !== "failed") { relabelled.add(n); everRelabelled.add(n); } // a failed label add is retried by a resume
    }
    save();
  })());
  if (typeof onExit === "function") { try { onExit(relabelQueued); } catch { /* best effort */ } }

  // #4408: issues added to the running batch; returns how many joined. Re-reading the cumulative list is a no-op.
  // #5978: standing order (`--select`): one reconcile per interval. Matching open issues and engine-filed env.* issues join through
  // the `getAdded` path below; closed or moved pending issues leave; ended deferred/held/engine-error/conformance rows are requeued
  // through `drainRequeues` by policy (reconcile.mjs). Same DAG, priority and lane rules as an operator `--add`/`--requeue`.
  let nextReconcile = 0, parkedDigest = "";
  const selFresh = [], autoRequeues = []; // #6022: selMatched (declared with the restores) = issues the selector has matched
  const reconcileTick = async () => {
    if (!reconcile) return;
    const t = now();
    if (t < nextReconcile) return;
    nextReconcile = t + (reconcile.everyMs ?? RECONCILE_MS);
    let open = null;
    try { open = await reconcile.list(); } catch { open = null; } // a failed read never makes anything leave
    const labels = new Map((open ?? []).map((o) => [o.number, o.labels ?? []]));
    if (open) {
      const { join, leave } = diffSelection({ open, members: [...set], pending, running, results, matched: selMatched });
      const matchedBefore = selMatched.size;
      for (const o of open) selMatched.add(o.number);
      selFresh.push(...join);
      for (const n of leave) {
        pending.splice(pending.indexOf(n), 1);
        skip(n, "left the selector: closed or moved");
      }
      if (leave.length || selMatched.size > matchedBefore) save();
    }
    for (const e of envSigs.values()) if (Number.isInteger(e.number) && !set.has(e.number)) selFresh.push(e.number); // R7: the engine-filed env.* issue joins the order
    let base = null;
    try { base = (await reconcile.base?.()) ?? null; } catch { base = null; }
    const { requeue, parked } = readmitDue({ results, state: readmit, now: t, version: reconcile.version?.() ?? null, base, labels: (n) => labels.get(n) ?? [] });
    for (const q of requeue) autoRequeues.push({ issue: q.issue, at: `reconcile-${t}`, reason: q.reason, by: "reconcile" });
    const digest = needsDecisionDigest(parked);
    if (digest !== parkedDigest) {
      parkedDigest = digest;
      if (digest) decided({ issue: null, what: digest, why: "one recovery attempt used; parked for an operator instead of lost", alternative: "forgedock orchestrate --requeue after deciding" });
    }
    if (requeue.length || parked.length) save();
  };
  const drainAdds = async () => {
    const kids = await drainChildren();
    await reconcileTick();
    if (!getAdded && !selFresh.length) return kids;
    let got = [];
    try { got = [...(getAdded?.() ?? []), ...selFresh.splice(0)]; } catch { got = []; }
    const fresh = [...new Set((Array.isArray(got) ? got : []).filter((n) => Number.isSafeInteger(n) && n > 0 && !set.has(n)))];
    if (!fresh.length) return kids;
    // An edge an operator wrote into a pending issue after the batch started (it waits on an added issue) holds too.
    for (const n of pending) {
      const d = await reread(n);
      if (d) deps.set(n, throughDecomposed([...(deps.get(n) ?? []), ...d]));
    }
    await addIssues(fresh);
    save();
    const list = fresh.map((n) => `#${n}`).join(", ");
    decided({ issue: null, what: `added ${list} to the batch (forgedock orchestrate --add)`, why: "operator request", alternative: "start a second batch" });
    update({ issue: null, outcome: "added", detail: list });
    return fresh.length + kids;
  };
  // #4965: epic and late children (`orchestration.auto_add_children` epic|all): at most one `getChildren()` list call per poll window.
  let nextChildScan = 0, childScanFailed = false;
  const skippedKids = new Set(); // #4982: one row per untrusted child, not one per scan
  const skipChild = ({ number, reason }) => {
    if (skippedKids.has(number)) return;
    skippedKids.add(number);
    update({ issue: number, outcome: "skipped", detail: `#${number} not auto-added: ${reason} (orchestration.auto_add_children)` });
  };
  const drainChildren = async () => {
    if (!getChildren || !addsEpicChildren(autoChildren?.mode)) return 0;
    const t = now();
    if (t < nextChildScan) return 0;
    nextChildScan = t + Math.max(0, autoChildren.pollS ?? DEFAULT_POLL_S) * 1000;
    let list, elsewhere;
    try { ({ list, elsewhere } = await getChildren()); } catch (e) {
      if (!childScanFailed) { childScanFailed = true; decided({ issue: null, what: `auto_add_children: child scan failed (${firstLine(e?.message ?? e)}); retried every ${autoChildren.pollS ?? DEFAULT_POLL_S}s`, why: "the open-issue list could not be read", alternative: "add the children by hand with forgedock orchestrate --add" }); }
      return 0;
    }
    childScanFailed = false;
    const fresh = selectChildren({ list, roots: [...set, ...(autoChildren.epics ?? [])], skip: [...set, ...(elsewhere ?? [])], onSkip: skipChild })
      .filter((n) => { try { return !(reg?.holder && reg.holder(entryOf(n)) != null); } catch { return true; } });
    if (!fresh.length) return 0;
    for (const n of pending) {
      const d = await reread(n);
      if (d) deps.set(n, throughDecomposed([...(deps.get(n) ?? []), ...d]));
    }
    await addIssues(fresh);
    save();
    const list2 = fresh.map((n) => `#${n}`).join(", ");
    const created = fresh.flatMap((n) => edges(n).map((d) => ({ from: n, to: d })));
    for (const n of pending) if (!fresh.includes(n)) for (const d of edges(n)) if (fresh.includes(d)) created.push({ from: n, to: d });
    const detail = created.length ? `${list2}; edges ${edgeText(created)}` : list2;
    decided({ issue: null, what: `added ${list2} to the batch (orchestration.auto_add_children: ${autoChildren.mode})${created.length ? `; edges ${edgeText(created)}` : ""}`, why: "open children of a batch issue or epic", alternative: "add them by hand with forgedock orchestrate --add" });
    update({ issue: null, outcome: "added", detail });
    return fresh.length;
  };
  // #4550: `--requeue` entries (batch `requeue` file) not applied yet: a terminal issue and the dependents skipped behind it
  // return to pending, the prior rows kept in history; their `Depends on` edges are re-read from the body and replaced (#5112).
  const drainRequeues = async () => {
    if (!getRequeued && !autoRequeues.length) return 0;
    let got = [];
    try { got = [...(getRequeued?.() ?? []), ...autoRequeues.splice(0)]; } catch { got = []; }
    const fresh = (Array.isArray(got) ? got : []).filter((e) => Number.isSafeInteger(e?.issue) && !requeueApplied.has(requeueKey(e)));
    let n = 0;
    for (const e of fresh) {
      requeueApplied.add(requeueKey(e));
      const row = results.get(e.issue);
      // #5203: a quota-paused issue (pending, no row) is released: its notBefore and the pool hold go, so the next grant admits it.
      // #5241: so is an issue waiting out a deferral (e.g. lease-held by a cancelled batch's lane): the next pass admits it.
      if (!row && pending.includes(e.issue) && (quota.has(e.issue) || notBefore.has(e.issue)) && !running.has(e.issue)) {
        notBefore.delete(e.issue);
        if (!quota.has(e.issue)) { deferrals.delete(e.issue); update({ issue: e.issue, outcome: "requeued", detail: `${e.reason || "operator decision"} (deferral released)` }); n++; continue; }
        try { const pool = remote?.identity?.(); if (pool) holds.clear(pool); } catch { /* fail-open */ }
        decided({ issue: e.issue, what: `released quota pause of #${e.issue} by ${e.by ?? "operator"} (forgedock orchestrate --requeue)`, why: e.reason || "operator decision", alternative: "wait for the account reset" });
        update({ issue: e.issue, outcome: "requeued", detail: `${e.reason || "operator decision"} (quota pause released)` });
        n++;
        continue;
      }
      if (!row || !REQUEUABLE(row.outcome) || running.has(e.issue)) continue;
      train?.drop(e.issue); // #5836: a requeued pr-ready row leaves the train
      const moved = [e.issue], priors = new Map([[e.issue, row]]);
      results.delete(e.issue);
      for (let i = 0; i < moved.length; i++) { // dependents skipped behind a requeued issue (fixpoint)
        for (const [m, r] of [...results]) {
          const heldBehind = r?.outcome === "held" && r.root === moved[i]; // #5162
          if (!heldBehind && (r?.outcome !== "skipped" || Number(/^dependency #(\d+)/.exec(r.detail ?? "")?.[1]) !== moved[i])) continue;
          priors.set(m, r); results.delete(m); moved.push(m);
        }
      }
      for (const m of moved) {
        for (const x of [requeues, deferrals, capDefers, engineErrors, engineSigs, transients, recoveries, recovering]) x.delete(m);
        relabelled.delete(m);
        if (m === e.issue) requeuedInfo.set(m, { reason: e.reason, by: e.by, at: e.at, prior: [...(requeuedInfo.get(m)?.prior ?? []), priors.get(m)] });
        if (!pending.includes(m)) requeue(m, 0);
      }
      // #5112: the requeued issues' `Depends on` edges are re-read and replaced, so a body edit drops or repoints an edge
      // (a decomposed dependency resolves to its sub-issues); an unreadable body keeps the edges it had.
      const edited = [];
      for (const m of moved) {
        const d = await reread(m);
        if (!d) continue;
        const before = deps.get(m) ?? [], after = throughDecomposed(d);
        deps.set(m, after);
        if (before.length !== after.length || before.some((x) => !after.includes(x))) edited.push(`#${m} -> ${after.length ? after.map((x) => `#${x}`).join(", ") : "none"}`);
      }
      noteCrossLane();
      save();
      const list = moved.filter((m) => m !== e.issue).map((m) => `#${m}`);
      decided({ issue: e.issue, what: `requeued by ${e.by ?? "operator"} (forgedock orchestrate --requeue); prior outcome ${row.outcome}${list.length ? `; dependents back to pending: ${list.join(", ")}` : ""}${edited.length ? `; edges re-read: ${edited.join("; ")}` : ""}`,
        why: e.reason || "operator decision", alternative: "start a second batch" });
      update({ issue: e.issue, outcome: "requeued", detail: `${e.reason || "operator decision"} (was ${row.outcome})` });
      for (const m of moved) if (m !== e.issue) update({ issue: m, outcome: "requeued", detail: `dependency #${e.issue} requeued`, trigger: e.issue }); // #4687
      n++;
    }
    if (fresh.length) save();
    return n;
  };
  // #4376: one SIGTERM per running local lane (their teardown saves the work); remote lanes run to their result unless the cancel carries `stopRemote` (#4612).
  // #5241: a stop not accepted is retried and, once the lane outlives the teardown timeout, reported (never silent).
  const stopSent = new Map(); // issue -> {at, accepted, since, reported}
  function stop(n, rec) {
    if (!stopLane || (rec?.remote && cancelled?.stopRemote !== true)) return; // #4612: remote lanes only when the cancel asked for it
    const t = now(), s = stopSent.get(n) ?? { at: null, accepted: false, since: t, reported: false };
    stopSent.set(n, s);
    if (!s.reported && t - s.since >= stopTimeoutMs) {
      s.reported = true;
      const why = rec?.stopNote ?? (s.accepted ? "stop sent, the lane has not exited" : "stop not accepted");
      update({ issue: null, outcome: "cancelled", detail: `#${n} not confirmed stopped after ${Math.round(stopTimeoutMs / 1000)}s: ${why}; its lease stays held until it exits` });
      decided({ issue: n, what: `#${n} not confirmed stopped by the cancel`, why, alternative: "stop the lane by hand" });
    }
    if (s.accepted || (s.at !== null && t - s.at < stopRetryMs)) return;
    s.at = t;
    try { Promise.resolve(stopLane(n, rec)).then((ok) => { if (ok !== false) s.accepted = true; }, () => {}); } catch { /* best effort */ }
  }
  // #6008: hold and pause reach a kept sandbox through the durable marker on its issue (the sandbox cannot read batch files); cleared on release/unpause.
  const markKept = (ns, on, reason) => { if (!suspendLane) return; for (const n of ns) { try { Promise.resolve(suspendLane(n, on, reason)).catch(() => {}); } catch { /* best effort */ } } };
  // #5975: the batch pause. `paused (reason, until …)`, the one text every surface shows.
  function pauseText(p = opPause) { return `paused (${p?.reason ?? "no reason given"}, until ${p?.expiresAt ?? "unpause"})`; }
  function refreshPause() {
    if (!getPause) return;
    if (expirePause) { // like #5469 holds: a pause past its expiry is lifted here, with a row and a decision
      let e = null; try { e = expirePause() ?? null; } catch { e = null; }
      if (e) {
        decided({ issue: null, what: `pause expired (paused by ${e.owner} since ${e.since}${e.reason ? `: ${e.reason}` : ""}); admission resumed`, why: "pause expiry (--pause --for)", alternative: "pause it again" });
        update({ issue: null, outcome: "pause-expired", detail: `${e.owner}, since ${e.since}` });
        if (e.ownerGone) update({ issue: null, outcome: "hold-alert", detail: `the pause owner session (${e.owner}) is gone; the pause expired and admission resumed` });
      }
    }
    let got = null; try { got = getPause() ?? null; } catch { got = opPause; }
    const next = got && typeof got === "object" ? got : null;
    if (next && !opPause) {
      decided({ issue: null, what: `batch ${pauseText(next)} (forgedock orchestrate --pause); running lanes continue`, why: "operator request", alternative: "cancel the batch" });
      update({ issue: null, outcome: "pause", detail: pauseText(next) });
    } else if (!next && opPause) {
      decided({ issue: null, what: "batch unpaused (forgedock orchestrate --unpause); admission resumed", why: "operator request", alternative: "resume the batch" });
      update({ issue: null, outcome: "unpause", detail: "admission resumed" });
    }
    if (next && !opPause) markKept([...keptBoxes.keys()], true, "paused");
    else if (!next && opPause) markKept([...keptBoxes.keys()].filter((n) => !opHeld.has(n)), false, "paused");
    opPause = next;
  }
  // #4592: re-read the hold set; one decision and one row when it changes.
  const holdExpiring = (list) => { let info = null; try { info = getHoldInfo?.() ?? null; } catch { info = null; } return !!expireHolds && list.some((n) => Number.isFinite(Date.parse(info?.[n]?.expiresAt))); }; // #5469
  // #5632: a function declaration (hoisted): finish/recovery callbacks of a resumed batch can call it before this line runs
  function refreshHeld() {
    if (!getHeld) return;
    if (expireHolds) { // #5469: a hold past its expiry is released here; the diff below then admits it. A dead owner session is an alert.
      let due = []; try { due = expireHolds() ?? []; } catch { due = []; }
      if (due.length > 1) holdRamp = { at: now() };
      if (due.length > 1) concEmit({ event: "concurrency", change: "hold-release", k: conc.operating("light"), ceiling: ceilingK(), factor: "hold expiry", inputs: { released: due.length } }); // #5988: the release is paced by K(), never all at once
      for (const e of due) {
        decided({ issue: null, what: `hold on #${e.issue} expired (held by ${e.owner} since ${e.since}${e.reason ? `: ${e.reason}` : ""}); re-admitted`, why: "hold expiry (--hold --for)", alternative: "hold it again" });
        update({ issue: null, outcome: "hold-expired", detail: `#${e.issue} (${e.owner}, since ${e.since})` });
        if (e.ownerGone) update({ issue: null, outcome: "hold-alert", detail: `#${e.issue}: the hold owner session (${e.owner}) is gone; the hold expired and the issue was re-admitted` });
      }
    }
    if (expireHolds) { // #5988: one alert per hold at T-30 min
      let info = null; try { info = getHoldInfo?.() ?? null; } catch { info = null; }
      for (const w of holdExpiryWarnings(info, { now: now(), warned: holdWarned })) {
        holdWarned.add(w.key);
        update({ issue: null, outcome: "hold-alert", detail: `#${w.issue}: the hold expires at ${w.expiresAt} (in ${Math.round(w.inMs / 60000)} min); release or extend it, or it re-admits through the concurrency controller` });
      }
    }
    let got = [];
    try { got = getHeld() ?? []; } catch { got = opHeld.size ? [...opHeld] : []; }
    const next = new Set((Array.isArray(got) ? got : []).filter((n) => Number.isSafeInteger(n) && n > 0));
    const fmt = (ns) => ns.map((n) => `#${n}`).join(", ");
    const held = [...next].filter((n) => !opHeld.has(n)), freed = [...opHeld].filter((n) => !next.has(n));
    opHeld = next;
    markKept(held.filter((n) => keptBoxes.has(n)), true, "held");
    markKept(freed.filter((n) => keptBoxes.has(n) && !opPause), false, "held");
    for (const n of held) if (running.has(n)) update({ issue: n, outcome: "hold", detail: `#${n} held after launch: lane still running` }); // #5526
    if (held.length) {
      decided({ issue: null, what: `held ${fmt(held)} (forgedock orchestrate --hold)`, why: "operator request", alternative: "cancel the batch" });
      update({ issue: null, outcome: "hold", detail: fmt(held) });
    }
    if (freed.length) {
      decided({ issue: null, what: `released ${fmt(freed)} (forgedock orchestrate --release)`, why: "operator request", alternative: "resume the batch" });
      update({ issue: null, outcome: "release", detail: fmt(freed) });
    }
 }
  // #4773: re-read the issues carrying the blocked label; one decision and row per change. A failed read keeps the last set.
  let blocked = new Set();
  const blockedHit = new Set(); // blocked issues that were pending this pass
  // #5031: `baseWait(n)` (async, default off) returns a detail string while a dependency's merge commit is not yet on n's base, else null.
  // The issue is admitted but not dispatched; it is re-checked every pass until released (a commit that landed stays landed). Fail-open.
  const baseHeld = new Map(), baseHit = new Set(), baseDone = new Set();
  const refreshBaseWaits = async () => {
    if (!baseWait) return;
    for (const n of pending) {
      if (baseDone.has(n) || results.has(n)) continue;
      let why = null;
      try { why = (await baseWait(n)) ?? null; } catch { why = null; }
      if (why && !baseHeld.has(n)) update({ issue: n, outcome: "held", detail: why });
      if (why) { baseHeld.set(n, why); continue; }
      if (baseHeld.delete(n)) { decided({ issue: n, what: "released: dependency commit is on the base", why: "the awaited merge commit landed", alternative: "keep waiting" }); update({ issue: n, outcome: "unblocked", detail: "dependency commit landed" }); }
      baseDone.add(n);
    }
  };
  let blockedReadAt = -Infinity; // #5592 follow-up: the label list is one `gh issue list` per call; a waiting batch makes several passes a second
  const refreshBlocked = async () => {
    if (!getBlocked) return;
    if (now() - blockedReadAt < blockedRefreshMs) return;
    blockedReadAt = now();
    let got;
    try { got = await getBlocked(); } catch { return; }
    const next = new Set((Array.isArray(got) ? got : [...(got ?? [])]).filter((n) => Number.isSafeInteger(n) && n > 0));
    const fmt = (ns) => ns.map((n) => `#${n}`).join(", ");
    const on = [...next].filter((n) => !blocked.has(n) && set.has(n) && !results.has(n)), off = [...blocked].filter((n) => !next.has(n));
    blocked = next;
    if (on.length) {
      decided({ issue: null, what: `blocked ${fmt(on)} (blocked label)`, why: "admitted to the batch, not dispatched while the label is set", alternative: "remove the label" });
      update({ issue: null, outcome: "blocked", detail: fmt(on) });
    }
    if (off.length) {
      decided({ issue: null, what: `unblocked ${fmt(off)} (blocked label removed)`, why: "the label is gone", alternative: "keep waiting" });
      update({ issue: null, outcome: "unblocked", detail: fmt(off) });
    }
  };
  // #4656: a gate (hold list, settle, ship pre-flight) waiting on an issue the scheduler will not admit: one decision and row per (gate, issue).
  const gateSeen = new Map(), gateReported = new Set();
  const checkGates = () => {
    const gates = [];
    if (opHeld.size) gates.push({ name: "hold", waitsOn: [...opHeld] });
    if (getGates) { try { gates.push(...(getGates() ?? [])); } catch { /* best effort */ } }
    if (!gates.length) return;
    const unadmittable = (n) => { const x = results.get(n); return !(x && (x.outcome === "needs-human" || x.parkedQueued)); };
    for (const d of detectGateDeadlock({ gates, admissible: unadmittable, now: now(), firstSeen: gateSeen })) {
      const key = `${d.gate}#${d.issue}`;
      if (gateReported.has(key)) continue;
      gateReported.add(key);
      decided({ issue: d.issue, what: formatGateDeadlock(d), why: "the gate waits on a parked issue the scheduler will not admit", alternative: "/work-on:remediate the parked issue or release the gate" });
      update({ issue: d.issue, outcome: "GATE_DEADLOCK", detail: formatGateDeadlock(d) });
    }
  };
  const checkCancel = () => {
    if (!getCancelled) return;
    let c = null;
    try { c = getCancelled() ?? null; } catch { c = null; }
    if (!c) { if (cancelled) { cancelled = null; save(); } return; }
    const first = !cancelled;
    cancelled = c;
    if (first) {
      save();
      decided({ issue: null, what: "cancelled the batch (forgedock orchestrate --cancel)", why: "operator request", alternative: "stop the shared schedd" });
      update({ issue: null, outcome: "cancelled", detail: "cancelled by operator (forgedock orchestrate --cancel)" });
      if (reg) withdrawExcept(new Set());
    }
    for (const [n, rec] of runRecs) if (running.has(n)) stop(n, rec);
  };
  // #4454: the shutdown stop; every wait races it and cancels its sleep.
  const aborted = signal ? new Promise((r) => { if (signal.aborted) r(); else signal.addEventListener("abort", () => r(), { once: true }); }) : null;
  const nap = (ms) => {
    const ac = new AbortController();
    return Promise.race([sleep(ms, ac.signal), ...(aborted ? [aborted] : [])]).finally(() => ac.abort());
  };
  const race = (ps) => Promise.race([...ps, ...(aborted ? [aborted] : [])]);
  const halt = () => {
    if (reg) withdrawExcept(new Set());
    save();
    halted = true;
    return Object.assign(new Error("batch stopped: schedd shutting down"), { code: "batch.stopped" });
  };
  // #4595: a skipped row whose blocker (`dependency #B ...`) was finished outside the lane is re-admitted: B is re-checked
  // through `dispatchCheck` (at most every WATCH_EVERY_MS, and once before the batch would end); fail-open.
  let lastWatch = null;
  const settled = new Set(); // #4687: blockers whose close is final (not planned): their dependents stay skipped, no more re-checks
  const readmitted = new Set(); // "n:b": re-admit n on blocker b once; a lane that re-skips on b stays skipped
  const blockerOf = (n) => { const r = results.get(n); const m = r?.outcome === "skipped" ? /^dependency #(\d+) /.exec(r.detail ?? "") : null; return m ? Number(m[1]) : null; };
  const watchable = () => !!dispatchCheck && [...results.keys()].some((n) => blockerOf(n) !== null);
  // #5986: readmission needs a new input hash. false = refused (loop.no_new_input: the label stays, one note per hash); a missing ledger or unreadable input admits.
  const refusedNoted = new Set();
  const gateAdmit = async (n, { relabel = false } = {}) => {
    if (!attempts) return true;
    try {
      let l = ledgers.get(n) ?? null;
      if (!l) { l = (await attempts.load?.(n)) ?? null; if (l) ledgers.set(n, l); }
      if (!l) return true;
      const hash = (await attempts.hash?.(n)) ?? null, a = admitInput(l, hash, attempts.cfg);
      if (a.ok) return true;
      const key = `${n}|${hash}|${a.code}`;
      if (!refusedNoted.has(key)) {
        refusedNoted.add(key);
        if (a.code === "escalate") { l = markEscalated(l); ledgers.set(n, l); save(); await attempts.mirror?.(n, l); }
        await attempts.notify?.({ issue: n, code: a.code, ledger: l, reason: a.reason, relabel });
        update({ issue: n, event: NO_NEW_INPUT, code: NO_NEW_INPUT, detail: `${NO_NEW_INPUT}: ${a.reason}`, batch: batchId ?? null });
      }
      return false;
    } catch { return true; }
  };
  // #5162: held rows behind `root` return to pending (and the root too when `withRoot`: requeued, counters reset), parents first via the edges.
  const releaseHeld = (root, withRoot, why) => {
    const moved = withRoot && results.has(root) ? [root] : [];
    if (moved.length) results.delete(root);
    for (const [m, r] of [...results]) if (r?.outcome === "held" && r.root === root) { results.delete(m); moved.push(m); }
    for (const m of moved) {
      for (const x of [requeues, deferrals, capDefers, engineErrors, engineSigs, transients, recoveries, recovering]) x.delete(m);
      relabelled.delete(m);
      if (!pending.includes(m)) requeue(m, 0);
      update({ issue: m, outcome: "readmitted", detail: m === root ? why : `dependency #${root} ${why}`, trigger: root });
    }
    if (moved.length) { save(); decided({ issue: root, what: `released held subtree of #${root}: ${moved.filter((m) => m !== root).map((m) => `#${m}`).join(", ") || "none"}`, why, alternative: "leave it held until a --requeue" }); }
  };
  // #5805: held engine/env failures are re-checked (every ehWatchMs, and at once when nothing else runs): a changed engine version, a
  // changed batch env (--set-env) or a probe that now finds every missing tool re-admits the issue and its held dependents, like --requeue.
  let envWatchAt = null;
  const envHeld = () => [...results.values()].filter((r) => r?.outcome === "held" && r.envHold);
  const envWaiting = () => ehOn && !cancelled && !tripped && !budgetStop && envHeld().some((r) => now() - (Number(r.envHold.since) || 0) < ehMaxMs);
  let envClosedAt = null;
  const watchEnvHolds = async (force = false) => {
    if (!ehOn || cancelled) return;
    const rows = envHeld();
    if (!rows.length || (!force && envWatchAt !== null && now() - envWatchAt < ehWatchMs)) return;
    envWatchAt = now();
    const v = curVersion(), fp = curEnv(), checkClosed = dispatchCheck && (envClosedAt === null || now() - envClosedAt >= WATCH_EVERY_MS);
    if (checkClosed) envClosedAt = now();
    for (const r of rows) {
      const n = r.issue, h = r.envHold;
      if (running.has(n) || results.get(n) !== r) continue;
      if (checkClosed) { // closed or merged outside the batch: no longer waited on
        let g = null;
        try { g = (await dispatchCheck(n)) ?? null; } catch { g = null; }
        if (g && (g.final || SATISFIED.has(g.outcome))) {
          const { waiting, envHold: _h, ...rest } = r;
          results.set(n, { ...rest, outcome: SATISFIED.has(g.outcome) ? g.outcome : "invalid", pr: Number.isInteger(g.pr) ? g.pr : rest.pr, detail: g.detail ?? `closed while waiting on engine/env change` });
          update(results.get(n));
          if (SATISFIED.has(g.outcome)) releaseHeld(n, false, "merged or closed"); else save();
          continue;
        }
      }
      let why = null;
      if (h.envIssue && typeof envIssue?.isClosed === "function") { let c = false; try { c = (await envIssue.isClosed(h.envIssue)) === true; } catch { c = false; } if (c) why = `env issue #${h.envIssue} closed`; }
      if (!why && v && h.version && v !== h.version) why = `engine version changed v${h.version} → v${v}`;
      if (why) { /* env issue closed */ } else if (fp && h.env && fp !== h.env) why = "batch env changed (--set-env)";
      else if (h.tools?.length && !toolReadmits.has(`${n}|${h.sig}`) && (await missingTools(h.tools))?.length === 0) { why = `${h.tools.join(", ")} now found on the host`; toolReadmits.add(`${n}|${h.sig}`); }
      if (why) { if (!(await gateAdmit(n))) continue; engineSigs.delete(n); releaseHeld(n, true, `re-admitted: ${why}`); continue; }
      if (now() - (Number(h.since) || 0) >= ehMaxMs && !/no engine\/env change within/.test(r.detail ?? "")) { // the wait is over: the row stays held (resumable, --requeue), the batch may end
        const { waiting, ...rest } = r;
        const [head, ...tail] = String(rest.detail ?? "").split("\n");
        results.set(n, { ...rest, detail: [`${head}; no engine/env change within ${Math.round(ehMaxMs / 3600_000 * 10) / 10}h (forgedock orchestrate --requeue retries it)`, ...tail].join("\n") });
        save(); update(results.get(n));
      }
    }
  };
  const restoredHeld = new Set([...results.values()].filter((r) => r?.outcome === "held" && Number.isInteger(r.root)).map((r) => r.root)); // roots held by an earlier run of this batch
  const watchHeldRoots = async () => {
    for (const root of new Set([...results.values()].filter((r) => r?.outcome === "held" && Number.isInteger(r.root)).map((r) => r.root))) {
      const ro = results.get(root)?.outcome;
      if (ro === undefined || running.has(root) || settled.has(root)) continue;
      if (restoredHeld.has(root) && ["needs-human", "budget-exceeded"].includes(ro) && typeof issueLabels === "function") { // label removed: requeue the root, its subtree follows
        let names = null;
        try { names = await issueLabels(root, { fresh: true }); } catch { names = null; } // #5893: never the memoized read
        if (Array.isArray(names) && !names.includes("needs-human")) {
          let sig = null;
          if (typeof heldFacts === "function") { // the removal must post-date the block; unreadable evidence fails closed
            let f = null; try { f = (await heldFacts(root)) ?? null; } catch { f = null; }
            if (!f || !Number.isFinite(f.removedAt) || !Number.isFinite(f.blockedAt) || f.removedAt <= f.blockedAt) continue;
            const prev = heldSigs.get(root);
            sig = { sig: `${ro}:${f.askKey ?? ""}`, removedAt: f.removedAt };
            if (prev && prev.sig === sig.sig && f.removedAt <= prev.removedAt) continue; // identical block, no new removal event
          }
          if (await gateAdmit(root, { relabel: true })) { if (sig) heldSigs.set(root, sig); releaseHeld(root, true, "needs-human label removed"); }
          continue;
        }
      }
      if (!dispatchCheck) continue;
      let g = null;
      try { g = (await dispatchCheck(root)) ?? null; } catch { g = null; }
      if (g?.final) { // closed as not planned: terminal for its held dependents
        settled.add(root);
        for (const [m, r] of [...results]) if (r?.outcome === "held" && r.root === root && r.waiting) { const { waiting, ...rest } = r; results.set(m, rest); update({ ...rest, trigger: root }); }
        continue;
      }
      if (g && SATISFIED.has(g.outcome)) { // merged or closed outside the batch
        results.set(root, { ...results.get(root), outcome: g.outcome, pr: Number.isInteger(g.pr) ? g.pr : results.get(root).pr, detail: g.detail ?? results.get(root).detail });
        update(results.get(root)); releaseHeld(root, false, "merged or closed");
      }
    }
  };
  const watchBlockers = async (final) => {
    if (!cancelled && !tripped && (final || lastWatch === null || now() - lastWatch >= WATCH_EVERY_MS) && [...results.values()].some((r) => r?.outcome === "held" && Number.isInteger(r.root))) await watchHeldRoots();
    if (!watchable() || cancelled || tripped) return;
    const t0 = now();
    if (!final && lastWatch !== null && t0 - lastWatch < WATCH_EVERY_MS) return;
    lastWatch = t0;
    const resolved = new Set();
    const roots = new Set([...results.keys()].filter((n) => !readmitted.has(`${n}:${blockerOf(n)}`)).map(blockerOf).filter((b) => b !== null && blockerOf(b) === null && !settled.has(b)));
    for (const b of roots) {
      let g = null;
      try { g = (await dispatchCheck(b)) ?? null; } catch { g = null; }
      if (g?.final) { // #4687: closed as not planned: terminal for its dependents
        settled.add(b);
        for (const n of results.keys()) {
          const r = results.get(n);
          if (blockerOf(n) === b && r.waiting) { const { waiting, ...rest } = r; results.set(n, rest); update({ ...rest, trigger: b }); }
        }
        continue;
      }
      if (!g || !SATISFIED.has(g.outcome)) continue;
      resolved.add(b);
      const row = results.get(b);
      if (row) { results.set(b, { ...row, outcome: g.outcome, pr: Number.isInteger(g.pr) ? g.pr : row.pr, detail: g.detail ?? row.detail }); update(results.get(b)); }
    }
    const back = new Set();
    for (let grew = true; grew;) {
      grew = false;
      for (const n of results.keys()) {
        const b = blockerOf(n);
        if (b !== null && !back.has(n) && !readmitted.has(`${n}:${b}`) && (resolved.has(b) || back.has(b))) { back.add(n); grew = true; }
      }
    }
    for (const n of back) {
      const b = blockerOf(n);
      readmitted.add(`${n}:${b}`);
      results.delete(n);
      pending.push(n);
      update({ issue: n, outcome: "readmitted", detail: `dependency #${b} merged or closed`, trigger: b }); // #4687
      decided({ issue: n, what: `re-admitted: dependency #${b} merged or closed after this issue was skipped`, why: "the blocker was finished outside this batch lane",
        alternative: "leave it skipped until the next batch" });
    }
    if (back.size) save();
  };
  // #5985: K is the ceiling; the controller's operating point (and a lower heavy-lane cap) sits under it. A pool with no load/memory data leaves K unchanged.
  // #5985: light/heavy per lane (its repo's recent cpu_avg from usage-history rows, array or getter); heavy lanes have their own concurrent cap
  const laneClassOf = (n) => { let rows = null; try { rows = typeof usageRows === "function" ? usageRows() : usageRows; } catch { rows = null; } let repo = repoSlug; try { repo = repoOf?.(n) ?? repoSlug; } catch { repo = repoSlug; } return rows && repo ? classifyRepo(rows, repo) : "light"; };
  const heavyFull = (n) => { if (laneClassOf(n) !== "heavy") return false; let h = 0; for (const m of running.keys()) if (m !== n && laneClassOf(m) === "heavy") h++; if (h < conc.heavyLimit()) return false; if (!heavyHeldHit) { heavyHeldHit = true; concEmit({ event: "concurrency", change: "heavy-cap", k: conc.operating("light"), ceiling: ceilingK(), factor: "heavy cap", inputs: { heavy_limit: conc.heavyLimit() } }); } return true; };
  // #5988: a hold expiry releasing several issues re-admits them on a ramp (one more lane per HOLD_RAMP_STEP_MS), as new work ramps, not all at once.
  const K = () => { conc.setCeiling(ceilingK()); const k = conc.operating("light"); if (!holdRamp) return k; const step = 1 + Math.floor((now() - holdRamp.at) / HOLD_RAMP_STEP_MS); if (step >= k) { holdRamp = null; return k; } return step; };
  // #5836: one train poll (throttled): a merged PR becomes a merged row; a red, conflicting or moved-head PR is handed back as a
  // needs-human row through the normal settle path, so in-batch recovery requeues a fix lane.
  let lastTrainTick = -Infinity;
  const runTrain = async () => {
    if (!train?.size() || signal?.aborted || now() - lastTrainTick < trainEveryMs) return;
    lastTrainTick = now();
    let evs = [];
    try { evs = await train.tick(); } catch { evs = []; }
    for (const e of evs) {
      const n = e.issue, prev = results.get(n) ?? { issue: n };
      if (e.kind === "merged") {
        const { waiting, ...rest } = prev;
        const row = { ...rest, outcome: "merged", detail: e.detail };
        results.set(n, row);
        if (lifecycle && e.entry.milestone) lifecycleTitles.add(String(e.entry.milestone));
        await closeOnLane(n, e.entry.lane, row);
        if (integration?.onMerged && String(e.entry.lane ?? "").startsWith("milestone/")) {
          try { await integration.onMerged(n, { ...row, lane: e.entry.lane }, { milestone: e.entry.milestone }); } catch (err) { update({ issue: n, outcome: "integration", detail: `integration check failed: ${String(err?.message ?? err).slice(0, 300)}` }); }
        }
        save(); update(row);
      } else {
        results.delete(n);
        // #5838: a bisection culprit broke the merged tree of its batch, not its own head; the recovery note leads with that.
        const c = e.culprit, detail = c ? `Recovery note: PR #${c.pr} broke the merged tree of train batch ${c.batch} (required check ${c.check}${c.url ? ` ${c.url}` : ""}), not its own head; fix it against ${e.entry.lane ?? "the base"} with the PRs merged before it.\n${e.detail}` : e.detail;
        await settleLane(n, { terminalReason: "needs-human", code: e.code, detail, pr: e.pr, cost_usd: prev.cost_usd ?? 0, lane: e.entry.lane, ...(c ? { culprit: c } : {}) }, { startedAt: now() - Math.round((Number(prev.minutes) || 0) * 60000), lane: e.entry.lane }, null);
        if (results.get(n)?.outcome === "needs-human" && !everRelabelled.has(n) && typeof relabelNeedsHuman === "function") {
          everRelabelled.add(n);
          try { await relabelNeedsHuman({ issue: n, evidence: detail }); } catch { /* best effort */ }
        }
      }
    }
    save();
  };
  let firstPass = true; // #5805: a resume (e.g. after an upgrade) re-checks the engine/env holds at once
  try {
    for (;;) {
      if (signal?.aborted) throw halt();
      await drainAdds();
      await drainRequeues();
      checkCancel();
      await runTrain();
      await watchBlockers(!pending.length && !running.size);
      await watchEnvHolds(firstPass || (!pending.length && !running.size)); // #5805
      firstPass = false;
      if (!pending.length && !running.size && !train?.size()) {
        if (envWaiting() && !signal?.aborted) { await nap(ehWatchMs); continue; } // #5805: only engine/env holds remain: keep re-checking them
        if (reconcile && !signal?.aborted && !cancelled && !tripped) { await nap(reconcile.everyMs ?? RECONCILE_MS); continue; } // #5978: a standing order stays open: the next reconcile may bring issues
        break;
      }
      // Resolve skips first: a dependency that finished unsatisfied (or never can) skips its dependents.
      for (let again = true; again;) { // #4595: to a fixpoint, so a chain's tail is skipped on its blocker, not as a "cycle"
        again = false;
        for (let i = pending.length - 1; i >= 0; i--) {
          const n = pending[i];
          if (results.has(n)) { pending.splice(i, 1); continue; }
          const bad = edges(n).find((d) => results.has(d) && !SATISFIED.has(results.get(d).outcome) && !WAITING_ON_TRAIN(results.get(d)));
          if (bad !== undefined) {
            pending.splice(i, 1); again = true;
            const br = results.get(bad), root = br.root ?? bad, ro = results.get(root)?.outcome ?? br.outcome;
            if (HOLD_ROOT.has(ro)) holdBehind(n, root, ro); // #5162
            else skip(n, `dependency #${bad} ended ${br.outcome}`, bad);
          }
        }
      }
      if (agentRestarts.length) await agentLostPass(now()); // #5859
      const t = now();
      const holdUntil = heldUntil();
      let started = 0;
      driftHeld.clear();
      integHeld.clear();
      opHeldHit.clear();
      pauseHit = false;
      blockedHit.clear();
      baseHit.clear();
      refreshHeld();
      refreshPause();
      await authPass(); // #5988
      await refreshBlocked();
      await refreshBaseWaits();
      checkGates();
      // #4866: lane preflight. A failing check holds admission (all lanes, or only remote ones by its scope), says why once per batch,
      // and is re-checked every pass so the batch resumes on its own; it is not an engine-error, so the breaker never sees it.
      pfAll = false; pfRemote = false;
      if (preflight && !tripped && !cancelled && !holdUntil && pending.length) {
        let fails = [];
        try { fails = (await preflight()) ?? []; } catch { fails = []; }
        for (const f of fails) { if (f.scope === "remote") pfRemote = true; else pfAll = true; }
        const keys = new Set(fails.map((f) => `${f.code}|${f.detail}`));
        for (const f of fails) if (!pfNoted.has(`${f.code}|${f.detail}`)) update({ issue: null, outcome: "preflight", code: f.code, detail: `${f.code}: ${f.detail}; admissions paused until it clears` });
        if (pfNoted.size && !keys.size) update({ issue: null, outcome: "preflight", detail: "preflight cleared; admissions resumed" });
        pfNoted = keys;
      }
      // #5992: one dispatcher probe per (repo, base sha) while lanes wait; red holds every admission but the attributed fixer's.
      if (baseProbe && !tripped && !cancelled && !holdUntil && pending.length) {
        let v = null;
        try { v = await baseProbe(); } catch { v = null; }
        if (v?.red) {
          const issue = Number.isInteger(v.att?.issue) ? v.att.issue : null;
          const detail = `base.red: base ${String(v.sha).slice(0, 12)} is red on ${(v.commands ?? []).join(", ") || "a guard command"}${v.att ? `; last change ${String(v.att.sha).slice(0, 12)}${issue ? ` (#${issue})` : ""}` : ""}; admissions paused until the base moves`;
          if (baseRedHold?.sha !== v.sha) update({ issue: null, outcome: "preflight", code: "base.red", detail });
          baseRedHold = { sha: v.sha, issue, detail };
        } else if (baseRedHold) { update({ issue: null, outcome: "preflight", detail: "base.red cleared; admissions resumed" }); baseRedHold = null; }
      }
      let planPass = false; // #5831: the plan pass evaluates every other gate but the in-batch dependencies
      await gateEnvSigs(); // #5755
      const isReady = (n) => {
        if (pfAll || (pfRemote && isRemote(n))) return false;
        if (baseRedHold && n !== baseRedHold.issue) return false; // #5992
        if (opPause) { pauseHit = true; return false; } // #5975: every admission path (dependency merge, env/engine re-admit, requeue, add, recovery) ends here
        if (opHeld.has(n)) { opHeldHit.add(n); return false; }
        if (blocked.has(n)) { blockedHit.add(n); return false; } // #4773
        if (baseHeld.has(n)) { baseHit.add(n); return false; } // #5031
        if (!((notBefore.get(n) ?? 0) <= t && (planPass || edges(n).every((d) => results.has(d) && SATISFIED.has(results.get(d).outcome))))) return false;
        if (heavyFull(n)) return false; // #5985: a wave of heavy (test-suite) lanes never takes the whole ceiling
        if (integration?.holds) {
          let why = null;
          try { why = integration.holds(n, { lane: lanes.get(n)?.lane ?? null }); } catch { why = null; }
          if (why) { integHeld.set(n, why); return false; }
        }
        if (!drift?.holds) return true;
        let pkg = null;
        try { pkg = drift.holds(n, { body: bodies.get(n) ?? "", lane: lanes.get(n)?.lane ?? null }); } catch { pkg = null; }
        if (pkg) driftHeld.set(n, pkg);
        return !pkg;
      };
      budgetHeld = false;
      // #4183: a hook (owned-resource GC near the host ceiling) before lanes are admitted; its errors never stop the batch.
      if (beforeAdmit && !tripped && !cancelled && !holdUntil && running.size < K() && pending.some(isReady)) { try { await beforeAdmit(); } catch { /* ignored */ } }
      if (signal?.aborted) throw halt();
      budgetStop = null;
      const wanted = new Set(); // issues that stay offered in the host registry after this pass
      if (!tripped && !cancelled && !holdUntil && budget) {
        while (running.size < K()) {
          const ready = rank(pending.filter(isReady));
          const n = pickNext(ready, { classes, share: budget.share, whenIdle: budget.whenIdle, started: dispatch.started, maint: dispatch.maint,
            featuresPending: pending.some((p) => !clsOf(classes, p).maintenance) });
          if (n === null) { budgetHeld = ready.length > 0; break; }
          const g = grant(n, wanted);
          if (g === "busy") continue; // #4481: not ready any more this pass (notBefore), so `ready` drops it
          if (!g && (notBefore.get(n) ?? 0) > t) continue; // #5592: this issue waits on its own (host overload, pool slots): the issues behind it are still tried
          if (!g) break;
          pending.splice(pending.indexOf(n), 1);
          if (lanes.get(n)?.ok !== false) { dispatch.started++; if (clsOf(classes, n).maintenance) dispatch.maint++; }
          start(n); started++;
        }
      } else if (!tripped && !cancelled && !holdUntil && reg) {
        // Priority first, then `rank` within a priority; the free per-batch K is offered so the host queue keeps FIFO.
        const ready = rank(pending.filter(isReady));
        const want = ready.filter((n) => lanes.get(n)?.ok !== false && !isRemote(n)).slice(0, Math.max(0, K() - running.size));
        offerFresh(want);
        for (const n of want) wanted.add(n);
        for (const n of ready) {
          if (running.size >= K()) break;
          if (heavyFull(n)) continue; // #5985
          const g = grant(n, wanted);
          if (g === "busy") continue; // #4481
          if (!g && (notBefore.get(n) ?? 0) > t) continue; // #5592: per-issue wait, not a full host queue
          if (!g) break;
          pending.splice(pending.indexOf(n), 1); start(n); started++;
        }
      } else if (!tripped && !cancelled && !holdUntil) {
        for (const n of rank(pending.filter(isReady))) {
          if (running.size >= K()) break;
          if (heavyFull(n)) continue; // #5985
          if (grant(n, new Set()) === true) { pending.splice(pending.indexOf(n), 1); start(n); started++; }
        }
      }
      // #5832: stacked lanes (phase 2, `full`). A dependent whose one unmerged in-batch dependency is PR-ready (precheck green, review
      // passed) builds now on that lane head; its PR targets the dependency branch and the merge step holds it until the dependency merged.
      if (stackFull && !tripped && !cancelled && !holdUntil && !pfAll && running.size < K()) {
        const watch = new Set(pending.filter((n) => !stackedTried.has(n)).flatMap((n) => edges(n)).filter((d) => running.has(d) && !results.has(d)));
        for (const d of watch) {
          if (prReady.has(d)) continue;
          let rd = null;
          try { rd = await readPrReady(d); } catch { rd = null; }
          if (rd?.branch && rd?.sha) prReady.set(d, rd);
        }
        planPass = true;
        let sc = [];
        try { sc = rank(pending.filter((n) => stackAdmissible({ n, edges: edges(n), results, pending, running, prReady, stackedTried, satisfied: SATISFIED }) && isReady(n))); } finally { planPass = false; }
        for (const n of sc) {
          if (running.size >= K()) break;
          if (heavyFull(n)) continue; // #5985
          if (lanes.get(n)?.ok === false || (notBefore.get(n) ?? 0) > t) continue;
          const so = stackAdmissible({ n, edges: edges(n), results, pending, running, prReady, stackedTried, satisfied: SATISFIED });
          if (!so || grant(n, new Set()) !== true) continue;
          pending.splice(pending.indexOf(n), 1);
          stackedTried.add(n); stackedOf.set(n, so);
          store?.log?.({ event: "STACK_BUILD_START", issue: n, stacked: true, stackedOn: so });
          decided({ issue: n, what: `stacked build for #${n} on #${so.dependency}'s lane head ${String(so.sha).slice(0, 12)}`, why: "orchestration.stacking: full builds a dependent once its dependency's PR is ready; the PR targets the dependency branch and merges only after the dependency", alternative: "wait for the dependency to merge" });
          start(n, { stackedOn: so }); started++;
        }
        if (sc.length) save();
      }
      // #5831: stacked lanes (phase 1). After every ready issue, an idle slot plans a dependent whose only unmet gates are in-batch
      // dependencies still pending or running: one plan lane per issue per batch (contract frozen, no build).
      if (stackOn && !tripped && !cancelled && !holdUntil && !pfAll && running.size < K() && !pending.some(isReady)) {
        planPass = true;
        let cands = [];
        try { cands = rank(pending.filter((n) => planAdmissible({ n, edges: edges(n), results, pending, running, planTried, satisfied: SATISFIED }) && isReady(n))); } finally { planPass = false; }
        for (const n of cands) {
          if (running.size >= K()) break;
          if (heavyFull(n)) continue; // #5985
          if (lanes.get(n)?.ok === false || (notBefore.get(n) ?? 0) > t) continue;
          if (grant(n, new Set()) !== true) continue;
          pending.splice(pending.indexOf(n), 1);
          planTried.add(n);
          const open = edges(n).filter((d) => !results.has(d));
          store?.log?.({ event: "STACK_PLAN_START", issue: n, dependencies: open });
          decided({ issue: n, what: `plan lane for #${n} while ${open.map((d) => `#${d}`).join(", ")} ${open.length > 1 ? "are" : "is"} still open`, why: "orchestration.stacking: plan admits a dependent in an idle slot; the contract freezes now and the build starts after its dependencies merged", alternative: "leave the slot idle until the dependencies merge" });
          start(n, { plan: true }); started++;
        }
        if (cands.length) save();
      }
      if (reg) withdrawExcept(wanted);
      // #4685: a breaker tripped only by link failures (a router restart) closes itself after a cooldown
      if (tripped?.transport && now() - tripped.at >= TRANSPORT_COOLDOWN_MS) { tripped = null; errorTimes = []; transportErrors = 0; save(); }
      // #5978: a standing order's breaker closes itself after a cooldown when the failures were environmental and the pool is healthy
      if (tripped && !tripped.transport) { // #6042: every batch, not only a standing order
        let healthy = true; try { healthy = reconcile?.poolHealthy ? reconcile.poolHealthy() !== false : true; } catch { healthy = true; }
        const d = decideAutoReset({ tripped, now: now(), cooldownMs: BREAKER_COOLDOWN_MS, environmental: tripped.environmental === true, poolHealthy: healthy });
        if (d.reset) {
          tripped = null; errorTimes = []; transportErrors = 0; save();
          decided({ issue: null, what: `circuit breaker reset automatically: ${d.why}`, why: "FORGE:DECISION: the engine-errors were environmental (VM restart, mirror, network) and the pool is healthy again", alternative: "forgedock orchestrate --clear-breaker" });
          update({ issue: null, outcome: "breaker", detail: `circuit breaker cleared automatically: ${d.why}` });
          continue;
        }
      }
      // #5947: --clear-breaker on a schedd-hosted batch reaches this runner through the batch's request file
      if (getClearBreaker) { // #5964: time-scoped; the request is consumed only after the decision, so a long pass never loses it
        let req = null; try { req = getClearBreaker(); } catch { req = null; }
        if (req) {
          const d = decideClear({ tripped, requestAt: req });
          const wasTripped = Boolean(tripped);
          if (d.clear) { const was = wasTripped; tripped = null; errorTimes = []; transportErrors = 0; save(); try { ackClearBreaker?.({ cleared: was }); } catch { /* advisory */ } }
          else if (d.stale) { try { ackClearBreaker?.({ cleared: false }); } catch { /* advisory */ } }
          try { consumeClearBreaker?.(); } catch { /* advisory */ }
          if (d.clear && wasTripped) continue; // admission ran before this check: re-run the pass so the cleared batch resumes instead of falling to the "nothing runnable" skip
        }
      }
      // #6042: a breaker pauses admission; it ends the run only when nothing can clear it (a non-environmental trip with no hosted clear channel)
      const breakerClearable = Boolean(tripped && pending.length && !cancelled && !budgetStop && !signal?.aborted && (tripped.environmental || tripped.transport || getClearBreaker));
      if (tripped && !running.size && breakerClearable) { await nap(pollMs); continue; }
      if (tripped && !running.size) { await drainAdds(); break; } // breaker: let running lanes finish, keep the rest pending for a resume
      if (cancelled && !running.size) { await drainAdds(); break; } // #4376: cancel: the rest end held for a resume
      if (budgetStop && !running.size) { await drainAdds(); break; } // execution budget (stop): the same, the rest end held
      // #4525: a parked needs-human PR is merged with its moved base (seam `syncParked`); non-union conflicts are commented once per base sha.
      const parkedPrs = () => (syncParked ? [...results].filter(([, x]) => x?.outcome === "needs-human" && Number.isInteger(x.pr)) : []);
      if (syncParked && !signal?.aborted && (lastParkedSync === null || t - lastParkedSync >= syncEveryMs)) {
        const rows = parkedPrs();
        if (rows.length) lastParkedSync = t;
        for (const [n, x] of rows) {
          let r = null;
          try { r = await syncParked({ issue: n, pr: x.pr, last: parkedBase.get(n) ?? null }); } catch { r = null; }
          if (!r?.base || r.status === "error" || r.status === "unchanged") continue;
          parkedBase.set(n, r.base);
          if (r.status === "conflict") decided({ issue: n, what: `parked PR #${x.pr} conflicts with its base (${String(r.base).slice(0, 12)}) in ${(r.paths ?? []).join(", ")}`,
            why: "base-sync of a parked needs-human PR merges only clean or pure list-addition conflicts", alternative: "resolve these paths by hand or rerun the issue on the new base" });
        }
      }
      // Wake for a delayed issue, the end of a usage-limit hold, or (with a live K) a poll.
      const waits = pending.map((n) => notBefore.get(n) ?? 0).filter((x) => x > t);
      if (holdUntil) waits.push(holdUntil);
      let wake = waits.length ? Math.max(0, Math.min(...waits) - t) : null;
      if (holdUntil && pending.length) wake = Math.min(wake ?? pollMs, pollMs); // #4446: a cleared hold (forgedock limits clear) admits on the next poll
      if (getPause && pending.length && (opPause || running.size)) wake = Math.min(wake ?? pollMs, pollMs); // #5975: an --unpause or expiry
      if ((getParallel || getHeld) && pending.length) wake = Math.min(wake ?? pollMs, pollMs);
      if (offered.size && pending.length) wake = Math.min(wake ?? pollMs, pollMs); // a slot another batch frees
      if (pending.some((n) => remoteCapped.has(n))) wake = Math.min(wake ?? pollMs, pollMs); // #5138: a live --set-max-remote raise
      if ((getAdded || getRequeued || (getChildren && addsEpicChildren(autoChildren?.mode))) && running.size) wake = Math.min(wake ?? pollMs, pollMs); // #4408/#4550: an add or requeue while only lanes run
      if (getRequeued && pending.some((n) => quota.has(n) || notBefore.has(n))) wake = Math.min(wake ?? pollMs, pollMs); // #5203: a --requeue releasing a quota pause
      if ((pfAll || pfRemote || baseRedHold) && pending.length) wake = Math.min(wake ?? pollMs, pollMs); // #4866
      if (baseWait && pending.length && baseHeld.size) wake = Math.min(wake ?? pollMs, pollMs); // #5031: a landed commit releases on the next tick
      if (getBlocked && pending.length && blockedHit.size) wake = Math.min(wake ?? pollMs, pollMs); // #4773: a removed label releases on the next tick
      if (getHeld && running.size) wake = Math.min(wake ?? pollMs, pollMs); // #4592: a release while only lanes run
      if (syncParked && running.size && parkedPrs().length) wake = Math.min(wake ?? syncEveryMs, Math.max(0, syncEveryMs - (t - (lastParkedSync ?? t)))); // #4525
      if (running.size && watchable()) wake = Math.min(wake ?? WATCH_EVERY_MS, WATCH_EVERY_MS); // #4595: re-check the blockers of skipped rows
      if (running.size && envWaiting()) wake = Math.min(wake ?? ehWatchMs, ehWatchMs); // #5805: re-check engine/env holds while lanes run
      if (train?.size()) wake = Math.min(wake ?? trainEveryMs, Math.max(0, trainEveryMs - (now() - lastTrainTick))); // #5836
      if (reconcile && running.size) wake = Math.min(wake ?? reconcile.everyMs ?? RECONCILE_MS, reconcile.everyMs ?? RECONCILE_MS); // #5978
      if (tripped) wake = getClearBreaker || tripped.environmental || tripped.transport ? Math.min(wake ?? pollMs, pollMs) : null;
      if (getCancelled && running.size && (!cancelled || [...running.keys()].some((n) => { const x = stopSent.get(n); return x && !(x.accepted && x.reported); }))) wake = Math.min(wake ?? pollMs, pollMs); // #5241: a cancel keeps polling a lane whose stop is unconfirmed // #4376: notice a cancel while lanes run
      if (running.size) {
        if (wake === null) await race(running.values());
        else { const ac = new AbortController(); await race([...running.values(), sleep(wake, ac.signal)]); ac.abort(); }
      } else if (started) continue; // only lane-refused rows settled (synchronously): re-resolve skips first
      else if (train?.size()) await nap(wake ?? trainEveryMs); // #5836: only train-held PRs are left: poll the train
      else if (pending.length && offered.size) await nap(wake); // waiting for a host slot
      else if (pending.length && (pfAll || pfRemote || baseRedHold)) await nap(Math.min(wake ?? pollMs, pollMs)); // #4866: a failing lane preflight is re-checked on the next poll
      else if (pending.length && blockedHit.size) await nap(wake ?? pollMs); // #4773: only blocked issues wait: poll for the label's removal
      else if (pending.length && baseHit.size) await nap(wake ?? pollMs); // #5031: only issues waiting for a base commit: poll for it
      else if (pending.length && waits.length) await nap(Math.min(wake, getCancelled ? pollMs : Infinity)); // wake is poll-capped by a hold or a live K; #4454: nap wakes on a stop
      else if (pending.length && budgetHeld) { if (await drainAdds()) continue; break; } // maintenance the budget does not admit now: held for a later batch
      else if (pending.length && opPause && pauseHit && Number.isFinite(Date.parse(opPause.expiresAt)) && !cancelled) await nap(wake ?? pollMs); // #5975: a timed pause keeps the batch open until it expires, not finalised silently
      else if (pending.length && opPause && pauseHit) { if (await drainAdds()) continue; break; } // #5975: paused with no expiry: pending for a --resume after --unpause
      else if (pending.length && opHeldHit.size && !pending.some((n) => !opHeldHit.has(n) && isReady(n)) && holdExpiring([...opHeldHit]) && !cancelled) await nap(wake ?? pollMs); // #5469: a hold with an expiry keeps the batch open until it expires (re-admit or alert), not finalised silently
      else if (pending.length && opHeldHit.size && !pending.some((n) => !opHeldHit.has(n) && isReady(n))) { if (await drainAdds()) continue; break; } // #4592: held by the operator: pending for a --resume
      else if (pending.length && (driftHeld.size || integHeld.size)) { if (await drainAdds()) continue; break; } // held by a drift flag (block_dispatch) or a red integration streak (#4667): pending for a later batch
      else if (pending.some((n) => remoteCapped.has(n))) await nap(wake ?? pollMs); // #5138: live max_remote 0: wait for a raise or another placement
      else if (pending.length) { // nothing runnable, nothing running, nothing waiting on time: a dependency cycle
        // #5162: only real cycles are labelled so; the rest name the cycle member (or failed root) that blocks them
        const cyc = cyclicNodes(pending, edges), inP = new Set(pending);
        const blocker = (n, seen = new Set()) => {
          for (const d of edges(n)) {
            if (cyc.has(d)) return d;
            if (inP.has(d) && !seen.has(d)) { seen.add(d); const b = blocker(d, seen); if (b !== null) return b; }
          }
          return null;
        };
        for (const n of pending.splice(0)) {
          const b = cyc.has(n) ? null : blocker(n);
          skip(n, cyc.has(n) ? "dependency cycle" : b !== null ? `blocked by #${b} (dependency cycle)` : "blocked: no dependency path is runnable");
        }
        save();
      }
    }
  } catch (e) {
    // #4318: an exception out of the loop still relabels the queued recoveries before it propagates (not a #4454 stop)
    if (!halted) try { await relabelQueued(`batch failed: ${firstLine(e?.message ?? e)}`); } catch { /* best effort */ }
    throw e;
  }
  await Promise.allSettled([...postRuns]); // #5437
  if (agentRestarts.some((g) => !g.closed) && !halted) { for (const g of agentRestarts) if (!g.closed) closeRestart(g); save(); } // #5859
  if (reg) withdrawExcept(new Set());
  await relabelQueued();
  // #4657: a milestone whose `close_on` state is reached closes here; a failure is a row, never an outcome change.
  if (lifecycle?.onBatchEnd && lifecycleTitles.size && !halted) {
    try { await lifecycle.onBatchEnd([...lifecycleTitles]); } catch (e) { onUpdate({ issue: 0, outcome: "lifecycle", detail: `lifecycle check failed: ${String(e?.message ?? e).slice(0, 300)}` }); }
  }
  for (const [n, r] of results) if (r?.waiting) { const { waiting, ...rest } = r; results.set(n, rest); } // #4687: the batch ended: skipped for good
  save();
  const withRequeue = (r) => (r && requeuedInfo.has(r.issue) ? { ...r, requeued: { reason: requeuedInfo.get(r.issue).reason, by: requeuedInfo.get(r.issue).by, prior: requeuedInfo.get(r.issue).prior.map((p) => ({ outcome: p.outcome, detail: p.detail ?? null, pr: p.pr ?? null })) } } : r);
  const quotaRow = (n) => { // #5094: still pending after a quota pause: held (resumable), labelled paused (quota), with the paused attempts' cost
    const q = quota.get(n);
    if (!q || cancelled || opHeld.has(n)) return {};
    const iso = new Date(Number(q.resumeAt) || now()).toISOString();
    return { cost_usd: Number(q.cost_usd) || 0, minutes: Number(q.minutes) || 0, quota: { resumeAt: iso }, detail: `paused (quota) until ${iso}` };
  };
  return order.map((n) => withRequeue(results.get(n)) ?? { issue: n, outcome: "held", pr: null, cost_usd: 0, minutes: 0, detail: heldDetail(n), ...quotaRow(n),
    ...(recovering.has(n) ? { recovery: { code: recovering.get(n).code, attempts: recoveries.get(n) ?? recovering.get(n).attempt, outcome: recovering.get(n).outcome ?? "needs-human",
      ...(recovering.get(n).result_code ? { result_code: recovering.get(n).result_code } : {}), detail: firstLine(recovering.get(n).detail ?? recovering.get(n).code) } } : {}) });
}

/**
 * #4409 batch-report line: estimated vs. actual lane minutes over the rows that ran with an estimate (feeds the estimator).
 * Null when no row has both.
 */
export function formatEstimateSummary(rows) {
  const xs = (rows ?? []).filter((r) => Number.isFinite(r?.est_minutes) && Number(r?.minutes) > 0 && !["held", "skipped", "lane-refused"].includes(r.outcome));
  if (!xs.length) return null;
  const sum = (f) => xs.reduce((a, r) => a + f(r), 0);
  const errs = xs.map((r) => Math.abs(r.minutes - r.est_minutes)).sort((a, b) => a - b);
  const med = errs.length % 2 ? errs[errs.length >> 1] : (errs[errs.length / 2 - 1] + errs[errs.length / 2]) / 2;
  const worst = xs.reduce((a, r) => (Math.abs(r.minutes - r.est_minutes) > Math.abs(a.minutes - a.est_minutes) ? r : a));
  return `estimates: ${xs.length} lane${xs.length === 1 ? "" : "s"}, est ${sum((r) => r.est_minutes).toFixed(1)} min vs actual ${sum((r) => r.minutes).toFixed(1)} min; median |error| ${med.toFixed(1)} min; worst #${worst.issue} est ${worst.est_minutes} actual ${worst.minutes}`;
}

/** Max chars of one row's detail in the batch-report outcome lists (#4298). */
export const OUTCOME_LINE_MAX = 200;
/**
 * #4267 batch-report lines after the table: `recovered: #A (ci.red) #B (base.conflict)`, one `unrecovered:` line per
 * mechanical needs-human row (failed recovery or a terminal code), then one escalation list holding only human codes,
 * asked once at the end of the batch. Empty when there is nothing to list.
 */
/**
 * #5078: one `follow-ups appended:` line grouped by issue across rows: `#N (<class>: k item(s) from #a,#b)`, the post-deploy
 * rollup named as such. Null when no row filed follow-ups.
 */
function formatFollowupsLine(rows) {
  const by = new Map();
  for (const r of rows ?? []) for (const f of Array.isArray(r?.followups) ? r.followups : []) {
    if (!Number.isInteger(f?.issue) || f.issue <= 0) continue;
    const g = by.get(f.issue) ?? { classes: new Set(), count: 0, from: new Set() };
    if (f.class) g.classes.add(String(f.class));
    g.count += Number(f.count) || 0; g.from.add(r.issue); by.set(f.issue, g);
  }
  if (!by.size) return null;
  const name = (c) => (c === "post-deploy" ? "post-deploy rollup" : c === "external" ? "external aggregate" : c);
  return `follow-ups appended: ${[...by].sort((a, b) => a[0] - b[0]).map(([n, g]) => `#${n} (${[...g.classes].sort().map(name).join("+") || "follow-up"}: ${g.count} item(s) from ${[...g.from].map((i) => `#${i}`).join(",")})`).join(" ")}`;
}
export function formatOutcomeLists(rows) {
  const out = [];
  const one = (x) => String(x ?? "").split("\n")[0].slice(0, OUTCOME_LINE_MAX);
  const requeued = (rows ?? []).filter((r) => r?.requeued); // #4550: operator --requeue after a decision; the row is the latest outcome
  if (requeued.length) out.push(`requeued: ${requeued.map((r) => `#${r.issue} (${one(r.requeued.reason)})`).join(" ")}`);
  const heldBy = new Map(); // #5162: held subtrees by root, one --requeue command each
  for (const r of rows ?? []) if (r?.outcome === "held" && Number.isInteger(r.root)) heldBy.set(r.root, [...(heldBy.get(r.root) ?? []), r.issue]);
  for (const [root, xs] of heldBy) { const ro = (rows ?? []).find((r) => r?.issue === root)?.outcome ?? "failed"; out.push(`held subtree: #${root} (${ro}) holds ${xs.map((x) => `#${x}`).join(" ")}; release: forgedock orchestrate --requeue <batch> ${root}`); }
  const rec = (rows ?? []).filter((r) => r?.recovered);
  if (rec.length) out.push(`recovered: ${rec.map((r) => `#${r.issue} (${r.recovered})`).join(" ")}`);
  for (const r of rows ?? []) {
    if (!r || r.recovered) continue;
    const human = r.outcome === "needs-human" && classifyNeedsHuman(r) === "human";
    if (r.parkedQueued && r.outcome === "needs-human") continue; // #4656: listed on the remediation line below, not as unrecovered
    if (!human && (r.outcome === "needs-human" || r.outcome === "budget-exceeded" || r.recovery)) out.push(`unrecovered: #${r.issue} (${r.code ?? r.recovery?.code ?? "unclassified"}: ${one(r.recovery ? `recovery ${r.recovery.code} ended ${r.recovery.outcome}: ${r.recovery.detail}` : r.detail)})`);
  }
  const esc = (rows ?? []).filter((r) => r?.outcome === "needs-human" && classifyNeedsHuman(r) === "human");
  const rq = (rows ?? []).filter((r) => r?.outcome === "needs-human" && r.parkedQueued); // #4656: parked past recovery: the single remediation queue, not escalation
  if (rq.length) out.push(`remediation queue (/work-on:remediate): ${rq.map((r) => `#${r.issue} (parked:${r.code}${r.pr ? ` PR #${r.pr}` : ""})`).join(" ")}`);
  const parked = formatParkedLine(rows); // #4389: one line for every parked post-deploy follow-up, never an escalation
  if (parked) out.push(parked);
  const fu = formatFollowupsLine(rows); // #5078: follow-ups appended, not "issues filed"
  if (fu) out.push(fu);
  const decided = (rows ?? []).filter((r) => r?.decided); // #4766: settled by the decision engine, listed not hidden
  if (decided.length) out.push(["decided (north-star engine, veto with the forge:decision-veto label):", ...decided.map((r) => `- #${r.issue}: ${one(r.decided.choice)}${r.decided.shadow ? " (shadow)" : ""}`)].join("\n"));
  if (esc.length) out.push(["escalations (human decisions, asked once):", ...esc.map((r) => `- #${r.issue} (${r.code}): ${one(r.detail)}`)].join("\n"));
  return out;
}

export function formatTable(rows) {
  // #4255: sandbox minutes and cost next to the token cost, only when some lane ran in a sandbox.
  const sbx = rows.some((r) => r?.sandbox);
  const head = ["issue", "outcome", "PR", "cost", ...(sbx ? ["sbx-min", "sbx-$"] : []), "min"];
  const body = rows.map((r) => [`#${r.issue}`, r.quota?.resumeAt && ["held", "paused"].includes(r.outcome) ? `paused (quota) until ${r.quota.resumeAt}` : (r.waiting && /^dependency #(\d+) /.test(r.detail ?? "") ? `waiting on #${/^dependency #(\d+) /.exec(r.detail)[1]}` : r.outcome) + (["skipped", "held"].includes(r.outcome) && r.detail ? ` (${String(r.detail).split("\n")[0]})` : r.prefilter?.closed || r.prefilter?.parked ? " (pre-filter)" : ""), r.pr ? `#${r.pr}` : "-", `$${(r.cost_usd ?? 0).toFixed(2)}`,
    ...(sbx ? (r.sandbox ? [(Number(r.sandbox.minutes) || 0).toFixed(1), `$${(Number(r.sandbox.cost_usd) || 0).toFixed(2)}`] : ["-", "-"]) : []), String(r.minutes ?? 0)]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (c) => c.map((x, i) => x.padEnd(w[i])).join("  ").trimEnd();
  return [line(head), line(w.map((n) => "-".repeat(n))), ...body.map(line)].join("\n");
}

/**
 * #4169 batch-report line: wait time per phase summed over the rows' lane `waits` ({phase: ms}), and the heavy-step
 * semaphore queue: `now` live from `heavyStats.queued`, `max` the longest queue a lane of this batch saw. Null when nothing waited or queued.
 */
/**
 * #4908: the lane's phase ledger for its batch row, plus `queue_wait` (the admission wait the batch saw; it precedes the lane
 * clock, so the other phases still sum to `wall_ms`). Null without a ledger.
 */
export function phasesOf(r, rec) {
  if (!r?.phases || typeof r.phases !== "object" || !Object.keys(r.phases).length) return null;
  return { ...(Number.isFinite(rec?.queueMs) && rec.queueMs > 0 ? { queue_wait: { ms: Math.round(rec.queueMs) } } : {}), ...r.phases };
}

export function formatWaitSummary(rows, heavyStats = null) {
  const by = {};
  for (const r of rows ?? []) for (const [p, ms] of Object.entries(r?.waits ?? {})) if (Number.isFinite(ms) && ms >= 0) by[p] = (by[p] ?? 0) + ms;
  const seen = Math.max(0, ...(rows ?? []).map((r) => (Number.isInteger(r?.heavyQueueMax) ? r.heavyQueueMax : 0)));
  const hasRows = Object.keys(by).length > 0, hasStats = heavyStats && typeof heavyStats === "object";
  if (!hasRows && !seen && !(hasStats && heavyStats.queued > 0)) return null; // nothing waited, nothing queued: no line
  const waits = hasRows ? Object.entries(by).sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, ms]) => `${p} ${(ms / 60000).toFixed(1)}m`).join(", ") : "none";
  return `waits by phase: ${waits}; heavy queue: now ${hasStats && Number.isInteger(heavyStats.queued) ? heavyStats.queued : "?"}, max ${seen}`;
}

/** #4354 batch-report tail: the fail-soft alerts (stats computeAlerts) for the batch's repo; [] when none fired. */
export function formatAlertLines(alerts) {
  return alerts?.length ? ["ALERTS", ...renderAlerts(alerts)] : [];
}

/**
 * #4255 batch-report line: sandbox lanes, minutes and cost next to those lanes' token cost, plus the execution budget
 * (`budget` from parseExecution, `day` from openExecutionBudget `dayTotals`) when a cap is set. Null without sandbox usage.
 */
export function formatSandboxSummary(rows, { budget = null, day = null } = {}) {
  const sb = (rows ?? []).filter((r) => r?.sandbox);
  if (!sb.length) return null;
  const sum = (f) => sb.reduce((a, r) => a + (Number(f(r)) || 0), 0);
  const parts = [`sandbox: ${sb.length} lane${sb.length === 1 ? "" : "s"}, ${sum((r) => r.sandbox.minutes).toFixed(1)} min, $${sum((r) => r.sandbox.cost_usd).toFixed(2)} (token cost $${sum((r) => r.cost_usd).toFixed(2)})`];
  const agents = {}; // #4549: remote lane minutes per pool agent
  for (const r of sb) for (const [a, m] of Object.entries(r.sandbox.by_agent ?? {})) agents[a] = (agents[a] ?? 0) + (Number(m) || 0);
  if (Object.keys(agents).length) parts.push(`by agent: ${Object.entries(agents).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([a, m]) => `${a} ${m.toFixed(1)} min`).join(", ")}`);
  const caps = [];
  if (budget?.batchMinutes != null) caps.push(`batch ${budget.batchMinutes} min`);
  if (budget?.batchUsd != null) caps.push(`batch $${budget.batchUsd}`);
  if (budget?.dayMinutes != null) caps.push(`day ${budget.dayMinutes} min`);
  if (budget?.dayUsd != null) caps.push(`day $${budget.dayUsd}`);
  if (caps.length) {
    let b = `budget: ${caps.join(", ")}`;
    if (day?.ok) b += `; host today ${Number(day.minutes).toFixed(1)} min, $${Number(day.cost_usd).toFixed(2)}`;
    const held = (rows ?? []).filter((r) => r?.outcome === "held" && String(r.detail ?? "").startsWith("execution budget")).length;
    if (held) b += `; cap reached, ${held} held`;
    parts.push(b);
  }
  return parts.join("; ");
}
