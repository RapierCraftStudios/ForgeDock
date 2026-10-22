// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Core work-on: ONE plain builder session does the work, ONE read-only reviewer answers two questions, and
 * ForgeDock registers everything on GitHub (labels, one register comment, PR, merge). No investigation, synthesis,
 * severity taxonomy, risk tiers or local CI gates. All effects are injected through `io` so it is unit-testable.
 */
import { join, dirname, basename, delimiter } from "node:path";
import { hostname as osHostname } from "node:os";
import { appendEvent } from "../engine/runlog.mjs";
import { readSelfReview, compareSelfReview } from "./selfreview.mjs";
import { codeForTerminalReason, OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { ciPollDelayMs, ENGINE_VERSION, DEFAULT_MAX_SESSION_LIMIT_PAUSES, DEFAULT_SESSION_LIMIT_WAIT_MS, parseLeaseHolder, sanitizeLeaseHost } from "../engine.mjs";
import { openDependency, isTrustedComment, decomposedSubissues, isDecomposedRecord, reopenRevokedDecomposition } from "../engine/phases.mjs";
import { createHash } from "node:crypto";
import { TRACKED, isBugIssue, scopeText, explainFailures, inIssue, validateContract, applyAmendments, precheck, repoTracks, dropScopeValidates, parseReview, decide, mergeReviewRows, evidencePathOnly, closePlan, followupItems, pendingTracking, unnamedEdges, structureNote } from "./conformance.mjs";
import { checkAdmission, hostParallelism, ADMISSION_RETRY_SECONDS } from "./admission.mjs";
import { namedPaths } from "./prefilter.mjs";
import { preflightProbes, preflightProblems, unsetEnvVars, runPreflight, knownToContract } from "./preflight.mjs";
import { resolveLane, isDefaultLane } from "./lane.mjs";
import { dockerLabels, LEDGER_TTL_MS } from "./ledger.mjs";
import { repoKey } from "../runner.mjs";
import { prepareToolchain } from "./toolchain.mjs";
import { readTestMap, readTestMapAtRef, factsPath, TEST_MAP_FILE } from "./testmap.mjs";
import { runChecks, planPrecheck, worktreeFingerprint, selfCheckState, quietFailure, CHECK_PLAN_FILE, SELF_CHECK_FILE, CHECK_LOG_DIR } from "./precheck.mjs";
import { retrying, PUSH_TRANSIENT_RE, PUSH_PERMANENT_RE, GH_TRANSIENT_RE, MERGE_TRANSIENT_RE, MERGE_CONFLICT_RE } from "./retry.mjs";
import { renderInvestigation, renderImplementation, renderReview, renderPrBody, renderTrajectory, renderContract, renderAmendments, renderShadowReview, parseContractComment, contractJson, capComment, sanitizeMd, MAX_COMMENT_CHARS, recoveryEvidence } from "./render.mjs";
import { parseVerifierConfig, pickVerifierModel, changedSymbols, callersOf, verifierBudget, verifierPrompt, parseVerifierFindings, findingsToFailures, renderVerifierNote, VERIFIER_SYSTEM } from "./verifier.mjs";
import { computeTrigger, riskPathHits, TRIGGER_MODES } from "./review-trigger.mjs";
import { REVIEWER_SYSTEM, LEAN_DIR, RESULT_FILE, INVESTIGATION_FILE, IMPLEMENTATION_FILE, CONTRACT_FILE, builderPlanPrompt, builderImplementPrompt, contractCorrectionPrompt, conformanceResumePrompt, reviewerPrompt, reviewerRepairPrompt, REVIEW_DIFF_MAX_BYTES, blockCorrectionPrompt, HUMAN_BLOCK_REASONS, structurePrompt, hotspotPlanNote, hotspotBuildRule, reproPlanNote, contextPackNote, docsPrompt, ciFailurePrompt, ciUnavailablePrompt, precheckFailurePrompt, contextRestartPrompt, turnBudgetWrapupPrompt, syncChecks, GROUPING_SYSTEM, enumeratingPlanNote, enumeratingBuildRule, missingEntriesPrompt, sequencePrompt, sequenceSyncNote, fixSessionPrompt } from "./prompts.mjs";
import { freshFix, issueSummary, firstPassOf } from "./fixround.mjs";
import { makeTurnBudget, laneSize, wrapupGrant, budgetDigest } from "./budget.mjs";
import { pendingPitfall, pitfallRecord, foldPitfalls, selectPitfalls, failureLog } from "./pitfalls.mjs";
import { unjustified } from "./enumerating.mjs";
import { addLaneWorktree, DEFAULT_SPARSE_MAX_KB } from "./worktree.mjs";
import { parseVerify, runCiVerify, collectFailedLogs, capLogs, VERIFY_MODES, VERIFY_CHECK_NAME, verifyReport } from "./verify.mjs";
import { e2eWanted, ownFailures, runE2eGate, NO_TRIGGER } from "./e2e.mjs";
import { laneBackendId } from "./limits.mjs";
import { SPLIT_LABEL } from "./refactor.mjs";
import { writeHeavyShims, sumWaits } from "./heavy.mjs";
import { priorityFromLabels } from "./sched.mjs";
import { parseContextPackConfig, contextPackFor, renderContextRecord, laneType, priorAttempts, linkStateStamp } from "./context.mjs";

/**
 * #4267: what a recovery lane does per code. Codebase-agnostic: the repo's own checks and logs only. Keys stay in step
 * with RECOVERABLE_CODES (bin/engine/outcome-codes.mjs); recovery.test.mjs checks it (#4298).
 */
export const RECOVER_HOW = Object.freeze({
  [OUTCOME_CODES.CI_RED]: "the PR's required checks failed. Read the failed checks' logs (`gh run view <run-id> --log-failed`, or the repo's declared check commands), fix the causes, re-run those checks locally and push new commits only (never rewrite history)",
  [OUTCOME_CODES.BASE_CONFLICT]: "the PR conflicts with origin/BASE. Merge origin/BASE, resolve every conflict keeping both sides' intent, re-run the validate commands and push new commits only",
  [OUTCOME_CODES.BUILDER_BLOCK_UNTYPED]: "an earlier run escalated an in-scope technical choice. Do not block on it: pick the option most consistent with the issue, the repo's conventions and prior merged decisions, and name the alternative you did not take in your summary",
  [OUTCOME_CODES.CONTRACT_INVALID]: "the issue was edited while the earlier run planned. Plan against the current issue text",
  [OUTCOME_CODES.BUDGET_EXCEEDED]: "an earlier run spent the implement turn budget for this issue's size; its digest is in the earlier run's detail and the branch holds its checkpointed work. Continue from the checkpoint against the frozen contract without starting over; if the remaining work cannot fit the budget, stop with a typed split-required block naming the sub-issues instead of grinding",
  [OUTCOME_CODES.ENV_TOOL_MISSING]: "a validate command could not run because the host lacks the tool or module named in the earlier run's detail; the change may already be correct. Do not edit the deliverables for it and never install anything globally: run the same check through the repo's own toolchain (its virtualenv, lockfile-pinned runner or package scripts), record that exit under the same validate id and name the command you used in your summary",
  [OUTCOME_CODES.ENV_REPRO_UNRUNNABLE]: "the repro harness could not run the contract's repro_test on head (timeout, missing runner or dependencies); the change may already be correct. Do not edit the deliverables or stub dependencies for it and never install anything globally: run the repro command through the repo's own toolchain and installed dependencies, and when it cannot run in this checkout, fix the repro_test command (not the code) so it does",
});
/** #4323/#4334: precheck failure codes that are environment errors (state "environment"), never a builder resume. */
const ENV_CODES = Object.freeze([OUTCOME_CODES.ENV_TOOL_MISSING, OUTCOME_CODES.ENV_REPRO_UNRUNNABLE]);
export const DEFAULT_REVIEWER_MODEL = "claude-sonnet-5-5";
/** forge.yaml engine.conformance: "shadow" (default) posts and logs the gate's verdict without enforcing it; "enforce" blocks on it. */
export const CONFORMANCE_MODES = Object.freeze(["shadow", "enforce"]);
/**
 * In shadow mode only what the previous two-question reviewer blocked on still blocks: a requirement not done, a regression
 * (precheck form: SHADOW_PRE_BLOCKS). A review without usable rows never merges either.
 */
const SHADOW_BLOCKS = [OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED, OUTCOME_CODES.CONFORMANCE_REGRESSION];
/**
 * Precheck failures that block in shadow mode too (#4160): every precheck or amendment failure coded
 * conformance.unimplemented (a validate command that failed or has no recorded result, a deliver requirement reported as
 * not done, an invalid amendment) or conformance.regression, the same codes a review blocks on, and unexempted growth of an
 * over-threshold file (maintenance.hotspot_growth, forge#4195). Scope creep stays recorded-only.
 */
const SHADOW_PRE_BLOCKS = [...SHADOW_BLOCKS, OUTCOME_CODES.MAINTENANCE_HOTSPOT_GROWTH];
/** forge.yaml engine.review_incomplete (#4160): "needs-human" (default), or "degraded": in shadow, merge an incomplete review with a review-degraded label and a tracked follow-up. */
export const REVIEW_INCOMPLETE_MODES = Object.freeze(["needs-human", "degraded"]);
export const REVIEW_DEGRADED_LABEL = "review-degraded";
const UNUSABLE_REVIEW_CODES = { "review.unparseable": OUTCOME_CODES.REVIEW_NO_VERDICT, "review.incomplete": OUTCOME_CODES.REVIEW_INCOMPLETE, "review.inconsistent": OUTCOME_CODES.REVIEW_INCONSISTENT };
export const REGISTER_MARKER = "FORGE:WORK-ON"; // alias marker carried by the FORGE:TRAJECTORY comment
const num = (v) => (Number.isFinite(v) ? v : null);
export const MAX_SUBISSUES = 8;
/** #4266: required checks with no rollup entry this long into a CI wait on a MERGEABLE PR log CI_NOT_STARTED (once per wait). */
export const CI_NOT_STARTED_GRACE_MS = 10 * 60 * 1000;
/** 12-hex sha256 of the canonical contract JSON text (renderContract embeds the same text). */
export const contractHash = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 12);

/**
 * #4385: siblings that declare a shared file (a barrel, union type, shared fixture, index doc) would conflict after the
 * first merges; each later sub-issue gets an edge to every earlier one it shares a file with and does not already reach
 * through its dependsOn. Mutates dependsOn; returns the added edges [{from, to, files}]. No `files`: no edge.
 */
export function serializeShared(subs) {
  const added = [], reach = [];
  subs.forEach((s, j) => {
    for (let i = j - 1; i >= 0; i--) { // nearest first: a chain, not a fan-in
      const shared = (s.files ?? []).filter((f) => (subs[i].files ?? []).includes(f));
      const r = new Set(s.dependsOn.flatMap((k) => [k, ...reach[k]]));
      if (shared.length && !r.has(i)) { s.dependsOn.push(i); added.push({ from: j, to: i, files: shared }); }
    }
    reach[j] = [...new Set(s.dependsOn.flatMap((k) => [k, ...reach[k]]))];
  });
  return added;
}

/**
 * Typed builder block (#4124), from result.json `block`. Returns {kind:"dependency", issues} | {kind:"split", subissues}
 * | {kind:"human", why} | {kind:"untyped", problem}. Only `human` with an allowed reason may end as needs-human.
 */
export function classifyBlock(result, issue) {
  const b = result?.block;
  if (!b || typeof b !== "object" || Array.isArray(b)) return { kind: "untyped", problem: "it has no typed \"block\" object" };
  if (b.kind === "dependency") {
    const issues = [...new Set((Array.isArray(b.issues) ? b.issues : []).map((x) => Number(String(x).replace(/^#/, ""))))].filter((n) => Number.isSafeInteger(n) && n > 0 && n !== Number(issue));
    return issues.length ? { kind: "dependency", issues } : { kind: "untyped", problem: "the dependency block names no other issue number" };
  }
  if (b.kind === "split-required") {
    const subs = (Array.isArray(b.subissues) ? b.subissues : []).filter((x) => x && typeof x.title === "string" && x.title.trim() && typeof x.body === "string");
    if (!subs.length) return { kind: "untyped", problem: "the split-required block lists no sub-issues with a title and body" };
    if (subs.length > MAX_SUBISSUES) return { kind: "untyped", problem: `the split-required block lists ${subs.length} sub-issues (at most ${MAX_SUBISSUES})` };
    const subissues = subs.map((x, i) => ({ title: x.title.trim(), body: x.body,
      dependsOn: [...new Set((Array.isArray(x.depends_on) ? x.depends_on : []).filter((j) => Number.isInteger(j) && j >= 0 && j < i))],
      ...(Array.isArray(x.files) ? { files: [...new Set(x.files.filter((f) => typeof f === "string").map((f) => f.trim().replace(/^\.?\/+/, "")).filter(Boolean))] } : {}) }));
    return { kind: "split", subissues, serialized: serializeShared(subissues) };
  }
  if (b.kind === "human") {
    return HUMAN_BLOCK_REASONS.includes(b.why) ? { kind: "human", why: b.why }
      : { kind: "untyped", problem: `"${String(b.why ?? "").slice(0, 80)}" is not a human-only reason (${HUMAN_BLOCK_REASONS.join(", ")})` };
  }
  return { kind: "untyped", problem: `block kind "${String(b.kind ?? "").slice(0, 40)}" is unknown` };
}

/**
 * Never a branch-deletion target (#4179): anything but the issue's own `feat/issue-<n>-lean`, and never main, master,
 * staging, the lane, forge.yaml's default/staging branch, `milestone/*` or a default branch of the repo.
 */
export function isProtectedLaneBranch(b, { issue, lane = null, branches = {}, defaults = [] } = {}) {
  if (typeof b !== "string" || b !== `feat/issue-${issue}-lean`) return true;
  return ["main", "master", "staging", lane, branches?.default, branches?.staging].includes(b) || /^milestone\//.test(b) || isDefaultLane(b, defaults);
}

/**
 * @param {object} o
 * @param {number} o.issue
 * @param {string} o.repo            "owner/repo"
 * @param {string} [o.lane]          requested lane: an assertion checked against the lane resolved from the issue (#4125)
 * @param {boolean} [o.laneOverride] accept a requested lane that differs from the resolved one (never the default branch)
 * @param {object} [o.branches]      forge.yaml branches {default, staging, featurePattern} (lane.mjs readBranches)
 * @param {string} o.cwd             main checkout (worktrees are added from here)
 * @param {string} o.dir             run-log dir
 * @param {object} o.io              injected effects: gh, git, runner, waitCiGreen, transitionLabel, fs, projector?, now?, sleep?
 * @param {string} [o.builderModel]  default: CLI default
 * @param {string} [o.reviewerModel] default claude-sonnet-5-5
 * @param {string} [o.fixModel]     model of fresh fix-round sessions (#4363, forge.yaml lean.fix_model); default the reviewer model
 * @param {number} [o.ciMaxMinutes]  remote-CI wait budget (default 360); exhaustion is NOT needs-human
 * @param {"shadow"|"enforce"} [o.conformance] conformance gate mode (default shadow)
 * @param {"needs-human"|"degraded"} [o.reviewIncomplete] shadow only: what an incomplete review after the re-ask does (default needs-human)
 * @param {object} [o.reviewTrigger] forge.yaml review.trigger/risk_paths (#4273): {mode: shadow (default)|enforce|off, riskPaths: globs}
 * @param {object} [o.verifier]      forge.yaml review.verifier/verifier_model (#4397): {mode: off (default)|shadow|enforce, model}
 * @param {object} [o.verify]        forge.yaml verify (verify.mjs parseVerify): mode local (default) | ci | hybrid (#4167)
 * @param {object} [o.precheck]      {commands, maxMinutes}: forge.yaml learned.test_commands, run in the worktree before the PR (#4240);
 *                                   maxMinutes: lean.precheck.max_minutes, the round budget (#4331, else verify.precheck_total_seconds)
 * @param {boolean} [o.closeParent] forge.yaml decomposition.close_parent (#3736): close a decomposed parent at decomposition (default false)
 * @param {"off"|"prefer"} [o.reproTest] forge.yaml lean.repro_test (#4271): prefer (default) freezes a red-green repro_test on bug lanes; off is today's contract
 * @param {object} [o.refactorModule] refactor:split step module (default ./refactor.mjs; injectable for tests, #4211)
 * @param {number} [o.splitMaxLines] refactor:split moved-line budget per PR (default 4000); the rest becomes a chained issue (#4211)
 * @param {string} [o.toolchainOverride] forge.yaml env.toolchain: "<pm>@<x.y.z>" or "off" (#4163)
 * @param {string} [o.envSetup]      forge.yaml env.setup: run once per fresh worktree before the builder (#4163)
 * @param {number} [o.sparseMaxKb]   forge.yaml env.sparse_max_kb: tracked blobs >= this many KB stay out of the lane checkout (default 1024; 0 = off, #4221)
 * @param {object} [o.placement]     {where: local|remote, reason, mode}: the dispatcher's lane placement (#4256), kept in FORGE:STATE
 * @param {object} [o.contextPack]   {mode: shadow|on|off, sources, bytes, days}: forge.yaml engine.context_pack* (#4275, default shadow)
 * @param {object} [o.recover]       {code, attempt, final}: a batch recovery lane (#4267) for a mechanical needs-human; removes the label,
 *                                   posts FORGE:DECISION and resumes the open PR on the rerun path with a recovery note. `final`
 *                                   (default true) is false when the runner may launch another attempt: the lane then never relabels (#4302)
 */
export async function runCore(o) {
  const { issue, repo, lane: requestedLane = null, laneOverride = false, branches = {}, cwd, dir, io, builderModel = null, reviewerModel = DEFAULT_REVIEWER_MODEL, fixModel = null,
    toolchainOverride = null, envSetup = null, ciMaxMinutes = 360, conformance = "shadow", reviewIncomplete = "needs-human", reproTest = "prefer", closeParent = false, mergeWait = "required", maxSessionLimitPauses = DEFAULT_MAX_SESSION_LIMIT_PAUSES, cliIdleMinutes = 15, cliMaxMinutes = 180, contextCeilingTokens = 120000, turnBudgets = null, laneLimits = null, maxMergeRetries = 5, sessionLimitMaxWaitMs = DEFAULT_SESSION_LIMIT_WAIT_MS, onProgress = () => {}, emitTelemetry = null, random = Math.random } = o;
  const now = io.now ?? (() => Date.now());
  const vcfg = { ...parseVerify({}), ...(o.verify ?? {}) };
  const learnedCommands = (Array.isArray(o.precheck?.commands) ? o.precheck.commands : []).map((c) => String(c ?? "").trim()).filter(Boolean);
  if (!VERIFY_MODES.includes(vcfg.mode)) vcfg.mode = "local";
  const remoteVerify = vcfg.mode !== "local";
  const triggerMode = TRIGGER_MODES.includes(o.reviewTrigger?.mode) ? o.reviewTrigger.mode : "shadow";
  const riskPaths = Array.isArray(o.reviewTrigger?.riskPaths) ? o.reviewTrigger.riskPaths : [];
  const verifierCfg = parseVerifierConfig(o.verifier ?? {});
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lane = null, base = null, defaults = [], milestone = null; // set by lane resolution, before the lease
  // #4267: a batch recovery lane for a mechanical needs-human ({code, attempt, final}); #4302: only a final attempt relabels.
  const recover = o.recover && typeof o.recover.code === "string" ? { code: o.recover.code, attempt: Number.isInteger(o.recover.attempt) ? o.recover.attempt : 1, final: o.recover.final !== false } : null;
  const branch = `feat/issue-${issue}-lean`;
  const wt = join(o.worktreeRoot ?? join(cwd, ".claude", "worktrees"), `lean-${issue}`);
  const t0 = now();
  const usage = { cost_usd: 0, input: 0, output: 0, cache: 0 };
  let sessionId = null;

  const ev = (e) => appendEvent(dir, issue, e);
  const emit = async (rec) => { try { await emitTelemetry?.({ ...rec, issue }); } catch { /* never fails a run */ } };
  const ghc = (args) => io.gh(args);
  const sleepFn = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  /** gh writes (comment, pr create, issue edit/close): retried for 5xx and secondary rate limits (#4114). */
  const ghw = (args) => retrying(() => io.gh(args), { transient: GH_TRANSIENT_RE, attempts: 4, sleep: sleepFn, random });
  const git = (args) => io.git(args, { cwd: wt });

  const builderTriggers = []; // #4362: implement-attempt triggers in order, for the lane's first-pass flag
  const impl = { cost: 0, models: new Set() }; // #4397: implement spend and reported models, for the verifier
  // #4392: implement turn budget for the lane's size, and its turn tally; off unless given (the CLI passes readCoreLimits' defaults)
  const tb = makeTurnBudget(turnBudgets ?? { S: 0, M: 0, L: 0 });
  /** `trigger` (#4362): why the attempt ran, one of fixround.mjs TRIGGERS. */
  async function attempt(phase, n, r, mode = null, trigger = null, restartOf = null) {
    const rec = { event: "PHASE_ATTEMPT_USAGE", phase, attempt: n, trigger, ...(restartOf ? { restart_of: restartOf } : {}), usage: r?.usage ?? null, duration_ms: num(r?.durationMs) ?? 0,
      cost_usd: num(r?.costUsd), model: r?.model ?? null, turns: num(r?.turns), ...(mode ? { mode } : {}) };
    if (phase === "implement") { builderTriggers.push({ trigger, restart_of: restartOf }); impl.cost += num(r?.costUsd) ?? 0; if (r?.model && r.model !== "default") impl.models.add(r.model); tb.note(num(r?.turns), stage === "implement"); }
    ev(rec); await emit(rec);
    const u = r?.usage ?? {};
    usage.cost_usd += r?.costUsd ?? 0;
    usage.input += u.input_tokens ?? 0; usage.output += u.output_tokens ?? 0;
    usage.cache += (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  const post = async (marker, body) => {
    const marks = (Array.isArray(marker) ? marker : [marker]).map((m) => `<!-- ${m} -->`).join("\n");
    const out = String(await ghw(["issue", "comment", String(issue), "-R", repo, "--body", capComment(`${marks}\n${body}`)])).trim();
    return /https?:\/\/\S+/.exec(out)?.[0] ?? null;
  };
  /** Best effort; `true` when the transition succeeded (#4337: the decomposed close needs to know). */
  const label = async (state) => { try { await retrying(() => io.transitionLabel(issue, state), { transient: GH_TRANSIENT_RE, attempts: 4, sleep: sleepFn, random }); return true; } catch { /* labels are best effort */ return false; } };
  const usageLine = () => `cost $${usage.cost_usd.toFixed(4)}, tokens ${usage.input} in / ${usage.output} out / ${usage.cache} cache, wall ${Math.round((now() - t0) / 60000 * 10) / 10} min`;

  // ---- lease (same FORGE:STATE lease the full path uses) ----
  const agentId = o.agentId ?? `core_${process.pid}`;
  const myHost = o.hostName ?? osHostname();
  const leaseObj = () => ({ by: agentId, until: now() + leaseTtlMs, host: myHost, pid: o.pid ?? process.pid });
  /** Provably dead: same host and `kill(pid, 0)` throws ESRCH. A different host keeps the TTL behaviour. */
  const holderDead = (l) => {
    const parsed = parseLeaseHolder(l?.by);
    const h = l?.host ?? parsed?.host, pid = l?.pid ?? parsed?.pid;
    if (!h || !Number.isSafeInteger(pid) || pid <= 0 || sanitizeLeaseHost(h) !== sanitizeLeaseHost(myHost)) return false;
    try { (o.killFn ?? process.kill.bind(process))(pid, 0); return false; } catch (e) { return e?.code === "ESRCH"; }
  };
  const leaseTtlMs = o.leaseTtlMs ?? 25 * 60000; // below the projector's 30 min honour cap
  let leaseState = null, leaseTimer = null;
  const writeLease = (lease, extra = {}) => io.projector.writeState(issue, { ...leaseState, ...extra, lease });
  const renew = async () => { if (io.projector && leaseState && !finishing) { /* never re-take a lease a finish (or signal) released */ try { await writeLease(leaseObj()); } catch { /* best effort */ } } };
  async function releaseLease(reason, code = null) {
    if (leaseTimer) { clearInterval(leaseTimer); leaseTimer = null; }
    if (!io.projector || !leaseState) return;
    const terminal = ["merged", "invalid", "needs-human", "engine-error"].includes(reason);
    // forge#4275: the typed outcome code and failure classes ride on FORGE:STATE, so the next run's context pack reads them typed.
    const typed = terminal ? { terminalCode: code ?? null, failureClasses: [...failureClasses].sort() } : {};
    try { await writeLease(null, terminal ? { terminal: true, terminalReason: reason, ...typed } : {}); } catch { /* best effort */ }
  }

  // Pipeline trajectory (posted once at the end): phase rows, decisions, anomalies.
  const T = { issue, validate: null, plan: null, implement: null, review: null, pr: null, merge: null, close: null, decisions: [], anomalies: [] };
  const failureClasses = new Set(); // forge#4275: conformance failure codes seen this run (gate failures, shadow would-fail)
  const ctxCfg = parseContextPackConfig(o.contextPack ?? {});
  let ctxLane = null; // forge#4275: rerun | child | first, set once the issue is read
  let pitMatched = null; // #4375: pitfalls in the pack that match the issue's files; null when no pack was compiled
  let shadowWould = null; // forge#4165: the shadow gate's verdict, carried on RUN_TERMINAL (no telemetry write of its own)
  let riskEnforced = null, gateRan = false; // #4398: declared risk paths that made a shadow lane enforce (sticky); the gate ran
  let done = null, finishing = null, wtCreated = false, salvagedRef = null;
  let recoverUnlabelled = false; // #4297: the recovery lane removed needs-human; a final ci-pending (or needsHuman()) puts it back
  const runId = `${issue}-${t0}`;
  let runTmp = null;
  let sparse = null; // #4221: {excluded, maxKb} when the lane worktree is a sparse checkout; null leaves prompts unchanged
  let toolchain = null; // #4163: {env, summary} when the repo pins its toolchain (env only with a pm shim); null leaves runner env and prompts unchanged
  // #4169: heavy steps take a host semaphore slot (io.heavy); LLM phases are not gated. `heavyEnv` puts the heavy shims on
  // the runner PATH; `waits` ({phase: ms}) and `heavyQueueMax` ride on the lane result for the batch report.
  const heavyCfg = o.heavy ?? {}, heavyOn = Boolean(io.heavy) && heavyCfg.enabled !== false;
  let heavyEnv = null, heavyWaitsFile = null, heavyQueueMax = 0, stage = "plan", iss;
  const waits = {};
  let precheckMs = 0, precheckDeferred = 0, precheckRan = false; // #4331: pre-PR check wall time and deferrals, for the batch report
  const addWait = (phase, ms, queued = 0) => {
    if (Number.isFinite(ms) && ms > 0) waits[phase] = (waits[phase] ?? 0) + ms;
    if (Number.isInteger(queued)) heavyQueueMax = Math.max(heavyQueueMax, queued);
  };
  const lanePriority = () => priorityFromLabels(iss?.labels);
  /** A host heavy-step slot for an engine-side step, or null (no io.heavy, disabled, or the registry failed: ungated). */
  async function heavyAcquire(phase) {
    if (!heavyOn) return null;
    try { const g = await io.heavy.acquire({ issue, phase, priority: lanePriority() }, heavyCfg); addWait(phase, g?.waitMs, g?.queued); return g; } catch { return null; }
  }
  async function heavyStep(phase, fn) { const g = await heavyAcquire(phase); try { return await fn(); } finally { try { g?.release?.(); } catch { /* fail-open */ } } }
  // ---- lane resource ledger (#4179): every owned resource is registered before it is created, released after its teardown ----
  let ledger = null, deleteLocalBranch = false;
  const ledgerDo = (fn) => { if (!ledger) return; try { fn(ledger); } catch (e) { ev({ event: "LEDGER_ERROR", error: String(e?.message ?? e).slice(0, 300) }); } };
  const protectedBranch = (b) => isProtectedLaneBranch(b, { issue, lane, branches, defaults });
  /** Teardown from the ledger (#4179), on every exit path: builder pids, checkpoint of unpushed work, run tmp, worktree, branch, docker. */
  async function teardown(reason, extra) {
    for (const p of ledger ? ledger.entries("pid") : []) {
      try { if (await io.killGroup?.(p.value, p.marker)) ledgerDo((l) => l.release("pid", p.value)); } catch { /* keep it listed */ }
    }
    // Never discard work silently: an unmerged lane commits and pushes what is left before its worktree goes.
    const saved = !wtCreated || reason === "merged" || (await checkpoint(`exit (${reason})`));
    if (runTmp) {
      try { if ((await io.runTmp.remove(runTmp)) !== false) ledgerDo((l) => l.release("tmp", runTmp)); } catch { /* best effort */ }
      runTmp = null;
    } // every terminal, including engine-error and deferred
    if (wtCreated && saved) {
      let removed = false;
      try { await io.git(["worktree", "remove", "--force", wt], { cwd }); removed = true; } catch { /* best effort */ }
      try { await io.git(["worktree", "prune"], { cwd }); } catch { /* best effort */ }
      if (removed) ledgerDo((l) => l.release("worktree", wt));
      let branchDone = true;
      if ((reason === "invalid" && !extra.pr) || (reason === "merged" && deleteLocalBranch)) {
        try { await io.git(["branch", "-D", branch], { cwd }); } catch { branchDone = reason !== "merged"; }
      }
      if (branchDone) ledgerDo((l) => l.release("branch", branch));
    } else if (wtCreated) {
      ev({ event: "TEARDOWN_KEPT", reason: "checkpoint failed: worktree and branch kept so no work is lost", worktree: wt });
    }
    for (const kind of ["container", "volume"]) {
      for (const r of ledger ? ledger.entries(kind) : []) {
        if (!io.docker) continue;
        try { await io.docker(kind === "container" ? ["rm", "-f", String(r.value)] : ["volume", "rm", String(r.value)]); ledgerDo((l) => l.release(kind, r.value)); } catch { /* docker absent or busy: keep it listed */ }
      }
    }
    ledgerDo((l) => { if (l.remove()) ev({ event: "LEDGER_CLEARED", path: l.path }); else ev({ event: "LEDGER_KEPT", path: l.path, resources: l.entries().map((r) => `${r.kind}:${r.value}`) }); });
  }
  /**
   * #4162: save the worktree's uncommitted work (tracked, untracked and .forge-lean/) to refs/forge/salvage/<issue>/<ms>
   * before an earlier run's worktree is removed at the start of this run (a run that died hard never ran its
   * teardown checkpoint, #4179). It stages into the worktree's own index, which is discarded with the worktree, and
   * the ref lives in the shared repo, so it survives the removal. Returns the ref, or null when there is nothing to save.
   */
  async function salvage(why) {
    if (!io.fs?.exists || !(await io.fs.exists(wt))) return null;
    const g = (a) => io.git(a, { cwd: wt });
    try {
      await g(["add", "-A"]);
      if (await io.fs.exists(join(wt, LEAN_DIR))) await g(["add", "-f", "--", LEAN_DIR]);
      const tree = String(await g(["write-tree"])).trim();
      const headTree = String(await g(["rev-parse", "HEAD^{tree}"])).trim();
      if (!/^[0-9a-f]{40,64}$/.test(tree) || tree === headTree) return null;
      const commit = String(await g(["-c", "user.name=forgedock", "-c", "user.email=forgedock@localhost", "commit-tree", tree, "-p", "HEAD", "-m", `forge salvage #${issue}: ${why}`])).trim();
      if (!/^[0-9a-f]{40,64}$/.test(commit)) return null;
      const ref = `refs/forge/salvage/${issue}/${now()}`;
      await io.git(["update-ref", ref, commit], { cwd });
      ev({ event: "WORKTREE_SALVAGED", ref, why });
      T.anomalies.push(`Uncommitted work from ${why} saved to \`${ref}\` (inspect: \`git diff HEAD ${ref} --stat\`)`);
      return ref;
    } catch (e) {
      ev({ event: "WORKTREE_SALVAGE_FAILED", why, error: String(e?.message ?? e).slice(0, 300) });
      return null;
    }
  }
  /** #4162: stop processes still running inside the worktree (an orphaned runner from a dead run) before it is removed. */
  async function stopWorktreeProcs() {
    if (!io.proc) return;
    const procs = await Promise.resolve(io.proc.inDir(wt)).catch(() => []);
    if (!procs.length) return;
    for (const p of procs) io.proc.kill(p.pid, "SIGTERM");
    for (let i = 0; i < 10 && procs.some((p) => io.proc.alive(p.pid)); i++) await sleep(500);
    const left = procs.filter((p) => io.proc.alive(p.pid));
    for (const p of left) io.proc.kill(p.pid, "SIGKILL");
    ev({ event: "WORKTREE_PROCS_STOPPED", pids: procs.map((p) => p.pid), killed: left.map((p) => p.pid) });
    T.anomalies.push(`Stopped ${procs.length} process(es) still running in the worktree from an earlier run: ${procs.map((p) => `${p.pid} ${p.cmd ?? ""}`.trim().slice(0, 80)).join("; ")}`);
  }
  function finish(...args) {
    if (done) return Promise.resolve(done);
    finishing ??= finishOnce(...args); // a signal during a normal finish waits for the same teardown
    return finishing;
  }
  async function finishOnce(reason, detail = "", extra = {}, codeOverride = null) {
    if (heavyWaitsFile) { // #4169: builder-run heavy waits, read before teardown removes the run TMPDIR
      try { heavyQueueMax = Math.max(heavyQueueMax, sumWaits(await io.fs.read(heavyWaitsFile), waits).queueMax); } catch { /* no heavy step ran */ }
    }
    await teardown(reason, extra); // first: unpushed work is pushed while this run still holds the lease
    const code = codeOverride ?? codeForTerminalReason(reason);
    // forge#4165: pr, milestone and the conformance verdict ride on the existing RUN_TERMINAL write (verdict-mix queries).
    const term = { event: "RUN_TERMINAL", reason, code, ...(extra.pr ? { pr: extra.pr } : {}), ...(milestone ? { milestone } : {}),
      conformance_mode: conformance === "enforce" || riskEnforced ? "enforce" : "shadow", ...(shadowWould ? { shadow_would: shadowWould } : {}),
      context_pack: ctxCfg.mode, ...(ctxLane ? { lane_type: ctxLane } : {}), ...(pitMatched != null ? { pitfalls_matched: pitMatched } : {}), ...(tb.record() ? { turns: tb.record() } : {}) }; // forge#4275: the on/off A/B groups runs by these
    ev(term);
    await emit(term);
    // #4297: only a final failure the runner never requeues puts needs-human back (needsHuman() relabels on its own path). invalid,
    // decomposed and dependency-* are legitimate non-failure endings; deferred/engine-error may be requeued, so the batch runner
    // (orchestrate settle, relabelNeedsHuman) relabels those once they are final. #4302: a non-final attempt never relabels; the runner
    // either launches the next attempt or relabels in settle.
    if (recoverUnlabelled && recover.final && reason === "ci-pending") {
      try {
        await post("FORGE:NEEDS_HUMAN", `## Needs human\n${laneRecoveryEvidence(reason, code, detail)}\n\n_${usageLine()}_`);
        await ghc(["issue", "edit", String(issue), "-R", repo, "--add-label", "needs-human"]);
      } catch { /* best effort */ }
    }
    if (["needs-human", "engine-error", "dependency-open", "dependency-blocked", "dependency-unreadable", "decomposed"].includes(reason)) {
      const wf = ["investigating", "building", "in-review"].map((x) => `workflow:${x}`).join(",");
      try { await ghc(["issue", "edit", String(issue), "-R", repo, "--remove-label", wf]); } catch { /* best effort */ }
    }
    if (["merged", "invalid", "needs-human"].includes(reason)) {
      if (reason === "merged") T.close = [extra.close === "partial" ? "issue closed (partial)" : "issue closed (completed)", "label workflow:merged"];
      else if (reason === "invalid") T.close = ["issue closed (not planned)", "label workflow:invalid"];
      else { T.close = ["left open", "label needs-human"]; T.anomalies.push(`needs-human: ${String(detail).split("\n")[0].slice(0, 300)}`); }
      try { await post(["FORGE:TRAJECTORY", REGISTER_MARKER], renderTrajectory({ ...T, usage: usageLine() })); } catch { /* best effort */ }
    }
    await releaseLease(reason, code);
    done = { terminalReason: reason, detail, branch, worktree: wt, cost_usd: usage.cost_usd, tokens: { input: usage.input, output: usage.output, cache: usage.cache }, wall_ms: now() - t0,
      ...(Object.keys(waits).length ? { waits: { ...waits } } : {}), ...(heavyQueueMax ? { heavyQueueMax } : {}), ...(precheckRan ? { precheckMs, precheckDeferred } : {}),
      ...(firstPassOf(builderTriggers) != null ? { firstPass: firstPassOf(builderTriggers) } : {}), ...(tb.record() ? { turns: tb.record() } : {}), // #4392
      ...(gateRan ? { conformance: { mode: conformance === "enforce" || riskEnforced ? "enforce" : "shadow", would: shadowWould, risk: Boolean(riskEnforced) } } : {}), ...extra };
    return done;
  }
  /** #4297/#4316: a recovery lane that ended unmerged keeps needs-human with this evidence (shared text in render.mjs). */
  const laneRecoveryEvidence = (reason, code, detail) => recoveryEvidence({ code: recover.code, attempt: recover.attempt, outcome: reason, resultCode: code, detail });
  async function needsHuman(why, code = OUTCOME_CODES.ENGINE_ERROR, extra = {}) {
    if (!recover || recover.final) try {
      await post("FORGE:NEEDS_HUMAN", `## Needs human\n${why}${recoverUnlabelled ? `\n\n${laneRecoveryEvidence("needs-human", code, "")}` : ""}\n\n_${usageLine()}_`);
      await ghc(["issue", "edit", String(issue), "-R", repo, "--add-label", "needs-human"]);
    } catch { /* best effort */ }
    return finish("needs-human", why, { code, ...extra, ...(recover ? { recovery: true } : {}) }, code);
  }

  // ---- stage notes: investigation.md, plan.md, implementation.md become their own comments ----
  const STAGES = [
    { key: "investigation", file: INVESTIGATION_FILE, marker: ["FORGE:INVESTIGATION", "FORGE:VALIDATE"], render: (md, ctx) => renderInvestigation(md, ctx.result) },
    { key: "implementation", file: IMPLEMENTATION_FILE, marker: ["FORGE:IMPLEMENTATION"], render: (md, ctx) => renderImplementation(md, ctx.result, { branch, files: ctx.files }) },
  ];
  const posted = {}; // key -> comment url (or "" when posted without a link)
  const readStage = async (st) => { try { return await io.fs.read(`${wt}/${st.file}`); } catch { return null; } };
  const usableMd = (md) => sanitizeMd(md).replace(/\s+/g, " ").length >= 20;
  const stageFiles = async () => {
    const out = String(await git(["diff", "--name-only", `${base}...HEAD`]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean);
    if (out.length) return out;
    return String(await git(["diff", "--name-only", "HEAD"]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean);
  };
  async function postStage(st, result, md) {
    const files = st.key === "implementation" ? await stageFiles() : [];
    const url = await post(st.marker, st.render(md, { result, files }));
    posted[st.key] = url ?? "";
  }
  /** Re-render a stage note that changed after a resume: edit the posted comment in place; post it when it was never posted or the edit fails. */
  async function upsertStage(key) {
    const st = STAGES.find((x) => x.key === key);
    const id = /#issuecomment-(\d+)/.exec(posted[key] ?? "")?.[1];
    const res = await readResult(), md = await readStage(st);
    if (id) {
      const files = key === "implementation" ? await stageFiles() : [];
      const marks = st.marker.map((m) => `<!-- ${m} -->`).join("\n");
      try { await ghw(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${id}`, "-f", `body=${capComment(`${marks}\n${st.render(usableMd(md) ? md : null, { result: res, files })}`)}`]); return; } catch { /* fall back to a new comment */ }
    }
    delete posted[key];
    await flushStages(res, [key]);
  }
  /** Post stage notes in order that exist, are stable (mtime unchanged for stableMs) and not yet posted. */
  const seen = {};
  let liveKeys = ["investigation"]; // which stage notes the running builder call may publish live (plan: investigation; implement: implementation)
  async function livePoll() {
    for (const st of STAGES) {
      if (!liveKeys.includes(st.key)) continue;
      if (st.key in posted) continue;
      let m = null;
      try { m = await io.fs.stat(`${wt}/${st.file}`); } catch { m = null; }
      if (!m) return;
      const e = seen[st.key];
      if (!e || e.mtime !== m.mtimeMs) { seen[st.key] = { mtime: m.mtimeMs, since: Date.now() }; return; }
      if (Date.now() - e.since < (o.stableMs ?? 2000)) return;
      const md = await readStage(st);
      if (!usableMd(md)) return;
      try { await postStage(st, null, md); } catch { return; }
    }
  }
  /** Post whatever was not posted live, in order; a missing file falls back to the result.json fields. */
  async function flushStages(result, keys) {
    for (const st of STAGES) {
      if (!keys.includes(st.key) || st.key in posted) continue;
      const md = await readStage(st);
      if (!usableMd(md)) {
        if (!result && st.key === "investigation") continue; // nothing to render
        T.anomalies.push(`${st.file} missing or empty: rendered from result.json`);
      }
      await postStage(st, result, md);
    }
  }

  /** Verification worker cap for this call (#4182): an operator-set positive int wins, else cores / live lanes; null when unknown. */
  function verifyParallelism() {
    const set = String(process.env.FORGE_HOST_PARALLELISM ?? "").trim();
    if (/^\d+$/.test(set) && Number(set) > 0) return set;
    if (!io.host?.cores) return null;
    try { return String(hostParallelism({ cores: io.host.cores(), lanes: io.host.activeLanes?.() })); } catch { return null; }
  }
  /**
   * #4325: the lane env every engine-run command shares with the builder: shared package-manager stores (#4220), the run
   * TMPDIR (#4104), FORGE_HOST_PARALLELISM (#4182) and the pinned toolchain (#4163); the engine's own keys win over the stores.
   */
  function laneEnv() {
    let deps = {};
    try { deps = io.deps?.env?.() ?? {}; } catch { deps = {}; }
    const par = verifyParallelism();
    return { ...deps, ...(runTmp ? { TMPDIR: runTmp } : {}), ...(par ? { FORGE_HOST_PARALLELISM: par } : {}), ...(toolchain?.env ?? {}) };
  }
  /** Runner call with the per-run TMPDIR and FORGE_HOST_PARALLELISM; a usage limit pauses and resumes the same step, or defers past the cap (#4101). */
  async function callRunner(args) {
    let pauses = 0;
    for (;;) {
      // #4181: every Docker resource the builder creates carries the lane's ownership labels (same batch/lane as the ledger).
      const labels = dockerLabels({ batch: o.batchId ?? "adhoc", lane: `lean-${issue}`, issue, expires: now() + LEDGER_TTL_MS }).join(" ");
      // #4169: heavy shims first on PATH; the phase/issue/priority label each heavy step's slot and wait record.
      const heavy = heavyEnv ? { ...heavyEnv, FORGE_LANE_PHASE: args.role === "builder" ? stage : String(args.role ?? "step"), FORGE_LANE_ISSUE: String(issue), FORGE_LANE_PRIORITY: String(lanePriority()) } : {};
      try { return await io.runner({ ...args, env: { ...laneEnv(), FORGE_DOCKER_LABELS: labels, ...(runTmp ? { CLAUDE_CODE_TMPDIR: runTmp } : {}), ...(toolchain?.env ?? {}), ...heavy } }); }
      catch (e) {
        const epoch = Number.isFinite(e?.resetAtEpochMs) ? e.resetAtEpochMs : null;
        if (!(e?.usageLimit === true || epoch !== null)) throw e;
        const waitMs = epoch !== null && epoch > now() ? epoch - now() : DEFAULT_SESSION_LIMIT_WAIT_MS;
        if (pauses >= maxSessionLimitPauses || waitMs > sessionLimitMaxWaitMs) { e.deferUsageLimit = true; throw e; }
        pauses++;
        ev({ event: "PHASE_RATE_LIMITED", phase: args.role, resetAt: epoch, resetAtDisplay: e.resetAt ?? null, waitMs });
        onProgress({ event: "phase_paused", phase: args.role, reason: "session-limit", detail: `session limit hit; pausing until ${e.resetAt || new Date(now() + waitMs).toISOString()}` });
        await sleep(waitMs);
      }
    }
  }

  /** git push with transient retry (#4114): 4 attempts; permission/protected-branch rejections fail at once. */
  const gitPush = async (args) => {
    try { return await retrying(() => git(args), { transient: PUSH_TRANSIENT_RE, permanent: PUSH_PERMANENT_RE, attempts: 4, sleep: sleepFn, random }); }
    catch (e) {
      if (e?.transientExhausted) { e.deferCode = OUTCOME_CODES.PUSH_TRANSIENT; e.deferDetail = `git push kept failing transiently after 4 attempts: ${String(e?.stderr ?? e?.message ?? e).slice(0, 300)}`; }
      else if (e?.permanent) e.pushRejected = true;
      throw e;
    }
  };

  /** After a timeout/idle kill: commit uncommitted work as a checkpoint and push the lane branch so a rerun resumes from it (#4112). */
  async function checkpoint(reason) {
    try {
      const dirty = String(await git(["status", "--porcelain"])).trim();
      if (dirty) { await git(["add", "-A"]); await git(["commit", "--no-verify", "-m", `wip(forge): checkpoint after ${reason}`]); }
      const ahead = String(await git(["diff", "--name-only", `${base}...HEAD`])).trim();
      if (ahead) await gitPush(["push", "-u", "origin", branch]);
      ev({ event: "CHECKPOINT", reason, dirty: Boolean(dirty), pushed: Boolean(ahead) });
      return true;
    } catch (e) { ev({ event: "CHECKPOINT_FAILED", reason, error: String(e?.message ?? e).slice(0, 300) }); return false; }
  }
  const CONTINUE_NOTE = "\n\nThe branch already holds work from an earlier session that was interrupted (see the latest `wip(forge): checkpoint` commit). Continue from it: read `git log` and `git diff origin/BASE...HEAD`, do not start over.";
  const recoverNote = () => (recover ? `\n\nRecovery pass (${recover.code}): ${(RECOVER_HOW[recover.code] ?? "an earlier run ended needs-human for a mechanical reason; resolve it").replaceAll("BASE", lane)}.` : "");
  const PLAN_RERUN_NOTE = "\n\nThis is a rerun: the branch already holds commits from an earlier run. Read `git log` and `git diff origin/BASE...HEAD` to see what exists, but plan against the issue itself. This step is still planning only: do not edit code, do not commit, and do not write the result file unless the issue is invalid, already fixed or blocked.";
  const SALVAGE_NOTE = "\n\nAn earlier run on this issue stopped with uncommitted work, saved at `REF` (not on the branch). Inspect it with `git diff HEAD REF --stat` and reuse what fits the contract (`git checkout REF -- <path>`) instead of rewriting it.";
  const RERUN_NOTE = `\n\nThis is a rerun: the branch already holds commits from an earlier run. Read \`git log\` and \`git diff origin/BASE...HEAD\`, verify that work against the contract, complete what is missing, ${vcfg.mode === "ci" ? "re-run the light checks (the engine verifies on CI)" : "re-run every validate command"} and write the result file. Do not start over.`;

  /**
   * Continuous admission (#4115): while the builder runs, pause its process group when the host is over the ceiling, resume
   * when under. Since #4169 the ceiling is the mem/tmp floors (load average only when configured); paused time is a wait.
   */
  function startGovernor(control) {
    if (!io.host || o.governor === false || o.admission?.enabled === false) return { stop() {} };
    const pollMs = o.governorPollMs ?? 15000, maxPauseMs = o.maxPauseMs ?? 600000;
    let stopped = false, paused = false, forced = false, pausedAt = 0, wake = null, t = null;
    const loop = (async () => {
      while (!stopped) {
        await new Promise((res) => { wake = res; t = setTimeout(res, pollMs); });
        clearTimeout(t);
        if (stopped) break;
        let ok = true;
        try { ok = (await checkAdmission({ cfg: o.admission, host: io.host })).ok; } catch { ok = true; }
        const nowMs = Date.now();
        if (!ok && !paused && !forced && control.pause) { if (control.pause()) { paused = true; pausedAt = nowMs; ev({ event: "LANE_PAUSED", reason: "host over ceiling" }); onProgress({ event: "phase_paused", phase: "builder", reason: "host-busy", detail: "host over the admission ceiling; lane paused" }); } }
        else if (ok && paused) { control.resume?.(); paused = false; forced = false; addWait(stage, nowMs - pausedAt); ev({ event: "LANE_RESUMED", reason: "host recovered" }); }
        else if (ok) forced = false;
        else if (paused && nowMs - pausedAt >= maxPauseMs) { control.resume?.(); paused = false; forced = true; addWait(stage, nowMs - pausedAt); ev({ event: "LANE_RESUMED", reason: "max pause reached" }); }
      }
    })();
    return { async stop() { stopped = true; wake?.(); clearTimeout(t); await loop; if (paused) { control.resume?.(); paused = false; addWait(stage, Date.now() - pausedAt); } } };
  }

  /** A timeout restart starts a fresh session; by default it continues the implementation against the frozen contract. */
  let facts = null; // #4272: path of an optional .forge/repo-facts.json (worktree, then main checkout), cited in builder prompts
  const tcOpts = () => ({ toolchain: toolchain?.summary ?? null, sparse, ...(facts ? { facts } : {}) });
  let hotFacts = null; // forge#4195: scripts/hotspots.sh facts for the files the issue names, read once before the plan call
  let enumList = []; // #4322: tests enumerating the members of the paths the issue names, read once before the plan call
  const implementRestart = () => builderImplementPrompt(vcfg.mode, tcOpts()) + hotspotBuildRule(hotFacts) + enumeratingBuildRule(enumList) + CONTINUE_NOTE.replace("BASE", lane);
  /** #4390: builder calls stopped at the context ceiling restart fresh; planning (and its corrections) run uncapped. */
  const UNCEILED = ["plan", "contract_correction", "block_correction"], CONTEXT_RESTARTS_MAX = 3;
  async function builder(n, prompt, resume, live = false, restart = implementRestart, opts = {}) {
    let timeoutRetries = 0, contextRestarts = 0, p = prompt;
    opts = { ...opts };
    const ceiled = contextCeilingTokens > 0 && !UNCEILED.includes(opts.trigger);
    for (;;) {
      // after CONTEXT_RESTARTS_MAX restarts the call runs uncapped: a loop guard, never a refusal of work
      opts.contextMax = ceiled && contextRestarts < CONTEXT_RESTARTS_MAX ? contextCeilingTokens : 0;
      const budgeted = stage === "implement" && tb.on(); // #4392: the build and its restarts spend the implement turn budget
      if (budgeted && tb.remaining() <= 0) return await budgetWrapup(n, opts);
      opts.turnMax = budgeted ? tb.remaining() : 0;
      try { return await builderOnce(n, p, resume, live, opts); } catch (e) {
        if (e?.code === "CLI_TURNS") {
          await attempt("implement", n, { usage: e.usage ?? null, turns: e.turns ?? null, costUsd: null, model: opts.model ?? builderModel ?? null }, opts.mode, opts.trigger, opts.restartOf);
          return await budgetWrapup(n, opts);
        }
        if (e?.code === "CLI_CONTEXT") {
          contextRestarts++;
          ev({ event: "CONTEXT_CEILING", context_tokens: e.context ?? null, ceiling: contextCeilingTokens, turns: e.turns ?? null, trigger: opts.trigger ?? null, restart: contextRestarts });
          await attempt("implement", n, { usage: e.usage ?? null, turns: e.turns ?? null, costUsd: null, model: opts.model ?? builderModel ?? null }, opts.mode, opts.trigger, opts.restartOf);
          await checkpoint("context ceiling");
          T.decisions.push(`Builder session reached ${e.context ?? "?"} context tokens (ceiling ${contextCeilingTokens}): checkpointed, restarted fresh from the contract, diff and last validate result`);
          p = restart() + await contextRestartNote(); resume = null; opts.restartOf ??= opts.trigger ?? null; opts.trigger = "context_restart";
          continue;
        }
        if (!(e?.code === "CLI_IDLE" || e?.code === "CLI_TIMEOUT")) throw e;
        const idle = e.code === "CLI_IDLE";
        const reason = idle ? "idle timeout" : "timeout";
        ev({ event: idle ? "CLI_IDLE_KILL" : "CLI_TIMEOUT_KILL", reason, lastTool: e.lastTool ?? null, children: e.children ?? [] });
        await checkpoint(reason);
        if (timeoutRetries++ >= 1) { e.deferCode = idle ? OUTCOME_CODES.CLI_IDLE : OUTCOME_CODES.CLI_TIMEOUT; e.deferDetail = `builder ${reason}; work checkpointed to ${branch}; rerun resumes from it. ${String(e.message).slice(0, 300)}`; throw e; }
        T.anomalies.push(`builder ${reason}: checkpointed, retried once`);
        T.decisions.push(`Builder ${reason}: uncommitted work checkpointed to the lane branch; retrying once from the checkpoint`);
        p = restart(); resume = null; opts.restartOf ??= opts.trigger ?? null; opts.trigger = "timeout_restart";
      }
    }
  }

  /** opts (#4363): {model, mode, keepSession, trigger and restartOf (#4362)}; a fresh fix session keeps the build session id for a fallback resume. */
  async function builderOnce(n, prompt, resume, live = false, { model = null, mode = null, keepSession = false, trigger = null, restartOf = null, contextMax = 0, turnMax = 0 } = {}) {
    onProgress({ event: "phase_enter", phase: "build" });
    await renew();
    const control = {};
    const governor = startGovernor(control);
    let spawned = null;
    const onSpawn = (child) => { if (Number.isSafeInteger(child?.pid) && !finishing) { spawned = child.pid; ledgerDo((l) => l.register("pid", child.pid, { marker: basename(String(child.spawnfile ?? "")) || null })); } };
    const call = Promise.resolve(callRunner({ role: "builder", issue, cwd: wt, model: model ?? builderModel, resume, system: "", prompt, control, onSpawn,
      idleMs: Math.round(cliIdleMinutes * 60000), maxMs: Math.round(cliMaxMinutes * 60000), laneLimits, ...(contextMax > 0 ? { contextMax } : {}), ...(turnMax > 0 ? { turnMax } : {}) }));
    call.then(() => {}, () => {}).finally(() => { if (spawned) ledgerDo((l) => l.release("pid", spawned)); });
    let r;
    call.catch(() => governor.stop());
    if (live && io.fs.stat) {
      let settled = false;
      const tracked = call.then((v) => { settled = true; return v; }, (e) => { settled = true; throw e; });
      tracked.catch(() => {});
      while (!settled) {
        let t;
        await Promise.race([tracked.catch(() => {}), new Promise((res) => { t = setTimeout(res, o.livePollMs ?? 1000); })]);
        clearTimeout(t);
        if (!settled) { try { await livePoll(); } catch { /* live posting is best effort */ } }
      }
      r = await tracked;
    } else { try { r = await call; } finally { /* governor stops below */ } }
    await governor.stop();
    await renew();
    await registerReported();
    if (r?.sessionId && !keepSession) sessionId = r.sessionId;
    await attempt("implement", n, r, mode, trigger, restartOf);
    onProgress({ event: "phase_exit", phase: "build", status: "committed" });
    return r;
  }
  /** #4390: the restart summary: `git diff --stat` and hunks against the lane base, and the last `forgedock check` record. */
  async function restartFacts() {
    const ex = [".", `:!${LEAN_DIR}`];
    const stat = String(await git(["diff", "--stat", `${base}...HEAD`, "--", ...ex]).catch(() => "")), diff = String(await git(["diff", `${base}...HEAD`, "--", ...ex]).catch(() => ""));
    let check = "";
    try { check = String(await io.fs.read(`${wt}/${SELF_CHECK_FILE}`)); } catch { /* none recorded */ }
    return { stat, diff, base, check };
  }
  const contextRestartNote = async () => contextRestartPrompt({ ...await restartFacts(), ceiling: contextCeilingTokens });
  /**
   * #4392: the implement turn budget is spent. Checkpoint, then one fresh session of `wrapupGrant` turns either finishes
   * (its result flows on as usual) or stops with a digest; a stop or an overrun ends needs-human `budget.exceeded`.
   */
  async function budgetWrapup(n, opts) {
    const size = tb.size, budget = tb.budget(), used = tb.record().build, grant = wrapupGrant(budget);
    tb.markExceeded();
    ev({ event: "TURN_BUDGET_EXCEEDED", size, budget, turns: used, grant });
    await checkpoint("turn budget");
    T.decisions.push(`Implement turn budget spent (size ${size}, ${used}/${budget} turns): checkpointed; one wrap-up session of ${grant} turns to finish or stop with a digest`);
    const facts = await restartFacts();
    const wopts = { ...opts, trigger: "budget_wrapup", restartOf: opts.restartOf ?? opts.trigger ?? null, contextMax: 0, turnMax: grant };
    let r = null, overran = false;
    try { r = await builderOnce(n, implementRestart() + turnBudgetWrapupPrompt({ size, budget, used, grant, ...facts }), null, false, wopts); } catch (e) {
      if (e?.code !== "CLI_TURNS") throw e;
      overran = true;
      await attempt("implement", n, { usage: e.usage ?? null, turns: e.turns ?? null, costUsd: null, model: opts.model ?? builderModel ?? null }, opts.mode, wopts.trigger, wopts.restartOf);
      await checkpoint("turn budget wrap-up");
    }
    const res = await readResult();
    if (!overran && res?.status !== "budget-exceeded") return r;
    ev({ event: "TURN_BUDGET_STOP", size, budget, turns: tb.record().build, overran });
    const digest = budgetDigest({ size, budget, used: tb.record().build, digest: res?.status === "budget-exceeded" ? res.digest : null, stat: facts.stat, check: facts.check });
    throw Object.assign(new Error(digest), { laneCode: OUTCOME_CODES.BUDGET_EXCEEDED });
  }
  const readContract = async () => { try { const j = JSON.parse(await io.fs.read(`${wt}/${CONTRACT_FILE}`)); return j && typeof j === "object" ? j : null; } catch { return null; } };
  const readResult = async () => { try { const j = JSON.parse(await io.fs.read(`${wt}/${RESULT_FILE}`)); return j && typeof j === "object" ? j : null; } catch { return null; } };
  /** Containers/volumes the builder reported in result.json `resources` go into the ledger, so teardown removes them. */
  async function registerReported() {
    if (!ledger || finishing) return; // after teardown nothing new is owned
    const res = (await readResult())?.resources;
    if (!res || typeof res !== "object") return;
    for (const [key, kind] of [["containers", "container"], ["volumes", "volume"]]) {
      for (const v of Array.isArray(res[key]) ? res[key] : []) {
        if (typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v)) ledgerDo((l) => l.register(kind, v));
      }
    }
  }

  /** Live-checks a builder block (#4124). Dependency issues are re-read, so a closed or unknown number is not a block. */
  async function resolveBlock(r) {
    const b = classifyBlock(r, issue);
    if (b.kind !== "dependency") return b;
    const open = [], blockers = [];
    for (const d of b.issues) {
      let v;
      try { v = JSON.parse(String(await ghc(["issue", "view", String(d), "-R", repo, "--json", "state,labels"]))); } catch (e) {
        return { kind: "unreadable", detail: `dependency #${d} named by the builder could not be read: ${String(e?.message ?? e).slice(0, 200)}` };
      }
      // #4153 / #4337: a decomposed parent, open or closed, resolves to its open sub-issues; it is satisfied once they all
      // close. Without a usable trail the parent itself is the dependency, even when closed (fail closed).
      const decomposed = isDecomposedRecord(v) && ["OPEN", "CLOSED"].includes(String(v?.state).toUpperCase());
      if (!decomposed && String(v?.state).toUpperCase() !== "OPEN") continue;
      const subs = decomposed ? await decomposedSubissues(d, io) : null;
      const recs = [];
      if (!subs) recs.push([d, { ...v, state: "OPEN" }]);
      else for (const n of subs) {
        try { recs.push([n, JSON.parse(String(await ghc(["issue", "view", String(n), "-R", repo, "--json", "state,labels"])))]); } catch (e) {
          return { kind: "unreadable", detail: `sub-issue #${n} of decomposed dependency #${d} could not be read: ${String(e?.message ?? e).slice(0, 200)}` };
        }
      }
      for (const [n, rec] of recs) {
        if (String(rec?.state).toUpperCase() !== "OPEN" || n === Number(issue) || open.includes(n)) continue;
        open.push(n);
        if ((rec.labels ?? []).some((l) => (l?.name ?? l) === "needs-human")) blockers.push(n);
      }
    }
    if (!open.length) return { kind: "untyped", problem: `its dependencies ${b.issues.map((n) => `#${n}`).join(", ")} are not open` };
    return { kind: "dependency", issues: open, blockers };
  }
  /** Ends a run whose builder stayed blocked: only a typed human reason is needs-human. */
  async function endBlocked(b, summary) {
    const s = summary ?? "(no summary)";
    const refs = (ns) => ns.map((n) => `#${n}`).join(", ");
    if (b.kind === "human") return await needsHuman(`Builder is blocked (${b.why}): ${s}`, OUTCOME_CODES.BUILDER_BLOCKED);
    if (b.kind === "unreadable") return await finish("dependency-unreadable", b.detail);
    if (b.kind === "dependency") {
      const blocked = b.blockers.length > 0;
      const detail = blocked
        ? `blocked by ${refs(b.blockers)} (needs-human); depends on ${refs(b.issues)}. ${s}`
        : `depends on ${refs(b.issues)} which is still open; requeue behind it. ${s}`;
      T.decisions.push(`Builder block: dependency on ${refs(b.issues)}${blocked ? ` (needs-human: ${refs(b.blockers)})` : ""}`);
      try { await post("FORGE:DEPENDENCY", `## ${blocked ? "Blocked by" : "Waiting on"} ${refs(blocked ? b.blockers : b.issues)}\n${detail}\n\n_${usageLine()}_`); } catch { /* best effort */ }
      return blocked
        ? await finish("dependency-blocked", detail, { code: OUTCOME_CODES.DEPENDENCY_BLOCKED, dependencies: b.issues, blockers: b.blockers }, OUTCOME_CODES.DEPENDENCY_BLOCKED)
        : await finish("dependency-open", detail, { code: OUTCOME_CODES.DEPENDENCY_OPEN, dependencies: b.issues }, OUTCOME_CODES.DEPENDENCY_OPEN);
    }
    if (b.kind === "split") {
      const filed = [];
      try {
        for (const sub of b.subissues) {
          const lines = [`**Parent**: #${issue}`, ...sub.dependsOn.map((j) => `**Depends on**: #${filed[j]}`)];
          // #4153: the parent's milestone, so each sub-issue derives the parent's lane before any lane runs.
          const out = String(await ghw(["issue", "create", "-R", repo, "--title", sub.title, "--body", `${sub.body.trim()}\n\n${lines.join("\n")}`, ...(milestone ? ["--milestone", milestone] : [])]));
          const n = Number(/\/issues\/(\d+)/.exec(out)?.[1]);
          if (!Number.isSafeInteger(n)) throw new Error(`cannot parse the sub-issue number from: ${out.slice(0, 200)}`);
          filed.push(n);
        }
      } catch (e) { return await finish("engine-error", `filing sub-issues failed after ${refs(filed) || "none"}: ${e?.message ?? e}`, { subissues: filed }); }
      T.decisions.push(`Builder block: split into ${refs(filed)}`);
      for (const e of b.serialized ?? []) T.decisions.push(`Serialised sub-issue #${filed[e.from]} behind #${filed[e.to]}: both edit ${e.files.slice(0, 5).join(", ")} (#4385)`);
      let marked = false;
      try { await post("FORGE:DECOMPOSED", `## Split into sub-issues\n${filed.map((n, i) => `- #${n} ${b.subissues[i].title}`).join("\n")}\n\n${s}`); marked = true; } catch { /* best effort */ }
      // #4337: with decomposition.close_parent, the tracker closes only once its trail and label exist: dependents then wait on the sub-issues, not on it.
      if (await label("decomposed") && marked && closeParent) {
        try {
          await ghw(["issue", "close", String(issue), "-R", repo, "--reason", "not planned", "--comment",
            `Decomposed into ${refs(filed)}; this tracker is closed and its dependents wait on the sub-issues. A trusted \`FORGE:DECOMPOSED:REVOKED\` reopens it.`]);
          T.decisions.push(`Closed the decomposed parent (not planned); tracked by ${refs(filed)}`);
        } catch { /* best effort: the parent stays open, as before #4337 */ }
      }
      return await finish("decomposed", `split into ${refs(filed)}`, { code: OUTCOME_CODES.DECOMPOSED, subissues: filed });
    }
    return await needsHuman(`Builder is blocked without a valid typed reason after one correction (${b.problem}): ${s}`, OUTCOME_CODES.BUILDER_BLOCK_UNTYPED);
  }

  // ---- host admission (#4105): before the lease, the worktree or any GitHub call ----
  if (io.host && o.admission?.enabled !== false) {
    const a = await checkAdmission({ cfg: o.admission, host: io.host });
    if (!a.ok) return { terminalReason: "deferred", code: OUTCOME_CODES.HOST_BUSY, detail: a.detail, retryInSeconds: ADMISSION_RETRY_SECONDS };
  }
  // ---- lane (#4125): worked out from the issue before any lease, comment or worktree; fail closed ----
  {
    const r = await resolveLane({ issue, repo, io, cwd, branches, requested: requestedLane, override: laneOverride });
    if (!r.ok) return { terminalReason: "lane-refused", code: r.code, detail: r.detail };
    lane = r.lane; base = `origin/${lane}`; defaults = r.defaults; milestone = r.milestone ?? null;
    if (r.overridden) T.decisions.push(`Lane override: ${lane} instead of the resolved ${r.expected}`);
    if (o.placement?.where) T.decisions.push(`Placement: ${o.placement.where}${o.placement.reason ? ` (${o.placement.reason})` : ""}`);
  }
  /** Last guard before a PR is created or merged: the default branch is never a lane. */
  const laneGuard = (target, what) => {
    if (isDefaultLane(target, defaults)) throw Object.assign(new Error(`refusing to ${what} into the default branch ${target}`), { laneCode: OUTCOME_CODES.LANE_DEFAULT_BRANCH });
  };
  // ---- admission: Depends-on refusal, then lease ----
  {
    let dep = null;
    try { dep = await openDependency(issue, io); } catch (e) { dep = { unreadable: true, detail: `issue ${issue} **Depends on** check failed: ${e?.message || e}` }; }
    if (dep?.unreadable) return { terminalReason: "dependency-unreadable", code: OUTCOME_CODES.DEPENDENCY_UNREADABLE, detail: dep.detail };
    if (dep?.open?.length) {
      return { terminalReason: "dependency-open", code: OUTCOME_CODES.DEPENDENCY_OPEN, dependencies: dep.open,
        detail: `issue ${issue} **Depends on** ${dep.open.map((n) => `#${n}`).join(", ")} which is still open; re-run once it is closed` };
    }
  }
  if (io.projector) {
    let st = null;
    try { st = await io.projector.readState(issue); } catch { /* unreadable: proceed */ }
    if (st?.lease && st.lease.until > now() && st.lease.by !== agentId && holderDead(st.lease)) {
      ev({ event: "LEASE_TAKEOVER", from: st.lease.by, host: st.lease.host ?? null, pid: st.lease.pid ?? null });
      onProgress({ event: "lease_takeover", detail: `taking over the lease of dead holder ${st.lease.by} (pid ${st.lease.pid ?? "?"} gone)` });
    } else if (st?.lease && st.lease.until > now() && st.lease.by !== agentId) {
      return { terminalReason: "deferred", code: "lease-held", detail: `issue ${issue} leased by ${st.lease.by} until ${new Date(st.lease.until).toISOString()}`, branch, worktree: wt };
    }
    leaseState = { ...(st ?? { v: 1, run: `core_${issue}`, issue, lane, committed: [], phase: null, branch: null, pr: null, terminalReason: null }), terminal: false,
      ...(o.placement ? { placement: o.placement } : {}) }; // #4256: the latest placement replaces an earlier run's
    try { await writeLease(leaseObj()); } catch { /* best effort */ }
    leaseTimer = setInterval(() => { writeLease(leaseObj()).catch(() => {}); }, o.leaseRenewMs ?? 120000);
    leaseTimer.unref?.();
  }

  if (io.ledger) {
    try { ledger = io.ledger({ batch: o.batchId ?? "adhoc", lane: `lean-${issue}`, owner: agentId, issue, host: myHost }); } catch { ledger = null; }
  }
  // A signal (engine-cli SIGTERM/SIGINT) runs the same teardown and lease release as any other exit.
  o.onTeardown?.((signal) => finish("deferred", `interrupted by ${signal}`, { code: OUTCOME_CODES.RUN_INTERRUPTED }, OUTCOME_CODES.RUN_INTERRUPTED));
  if (io.runTmp) {
    try { await io.runTmp.prune?.(); } catch { /* best effort */ }
    const planned = io.runTmp.path?.(runId);
    if (planned) ledgerDo((l) => l.register("tmp", planned));
    try { runTmp = await io.runTmp.make(issue, runId); } catch { runTmp = null; }
    if (runTmp && runTmp !== planned) ledgerDo((l) => l.register("tmp", runTmp));
  }
  ev({ event: "RUN_START", run: `core_${issue}_${t0}`, issue, lane, path: "core", version: ENGINE_VERSION, forge_version: ENGINE_VERSION, repo });
  try {
    iss = JSON.parse(await ghc(["issue", "view", String(issue), "-R", repo, "--json", "number,title,body,state,comments,labels,updatedAt"]));
  } catch (e) { return finish("engine-error", `cannot read issue: ${e.message}`); }
  if (String(iss.state).toUpperCase() === "CLOSED") {
    // #4337: a closed decomposed tracker is not "already done": its dependents wait on its sub-issues (the batch re-points
    // them). A trusted revocation reopens it and the run continues. An unreadable trail lists none (fail closed).
    if (!isDecomposedRecord(iss)) return finish("invalid", "issue already closed");
    if (await reopenRevokedDecomposition(issue, io)) iss.state = "OPEN";
    else return finish("decomposed", "closed decomposed tracker; dependents wait on its sub-issues", { code: OUTCOME_CODES.DECOMPOSED, subissues: (await decomposedSubissues(issue, io)) ?? [] });
  }

  try {
    // ---- 1. claim ----
    await label("investigating");
    await post("FORGE:STARTED", `Started work on #${issue} (base \`${lane}\`).`);
    if (recover) {
      // #4267: the batch decided to recover this issue itself; the label goes so the issue is live again.
      try { await ghc(["issue", "edit", String(issue), "-R", repo, "--remove-label", "needs-human"]); } catch { /* best effort */ }
      recoverUnlabelled = true;
      try {
        await post("FORGE:DECISION", `## Decision: recovery pass for \`${recover.code}\` (attempt ${recover.attempt})\n**What**: removed \`needs-human\` and resumed the open PR / branch on \`${lane}\` (${(RECOVER_HOW[recover.code] ?? "rerun").split(".")[0]}).\n**Why**: \`${recover.code}\` is a mechanical outcome an agent can fix without operator input.\n**Alternative**: leave the issue \`needs-human\` and skip its dependents until the operator relaunches it.`);
      } catch { /* best effort */ }
      T.decisions.push(`Recovery pass for ${recover.code} (attempt ${recover.attempt}): needs-human removed, PR resumed`);
      ev({ event: "RECOVERY_START", code: recover.code, attempt: recover.attempt });
    }

    // ---- 2. worktree (resume an open PR / remote branch) ----
    try { await io.git(["fetch", "origin", lane], { cwd }); } catch { /* offline: use the local ref */ }
    let resumed = null;
    try {
      const prs = JSON.parse(String(await ghc(["pr", "list", "-R", repo, "--head", branch, "--state", "open", "--json", "number,headRefOid,baseRefName"])) || "[]");
      const remote = String(await io.git(["ls-remote", "--heads", "origin", branch], { cwd })).trim();
      if (prs.length || remote) resumed = { pr: prs[0]?.number ?? null, base: prs[0]?.baseRefName ?? null };
    } catch { /* no resume info: start fresh */ }
    // An open PR on another base (a hand-retargeted PR, or one opened before lane resolution) is never merged (#4125).
    if (resumed?.base && resumed.base !== lane) {
      return await needsHuman(`Open PR #${resumed.pr} targets \`${resumed.base}\`, but #${issue}'s lane is \`${lane}\`; retarget or close it before rerunning.`,
        isDefaultLane(resumed.base, defaults) ? OUTCOME_CODES.LANE_DEFAULT_BRANCH : OUTCOME_CODES.LANE_MISMATCH);
    }
    // #4162: a run that died can leave its runner writing into this worktree, and uncommitted work in it. Stop the
    // processes and save the work before the worktree is removed; the lease above makes this run the only one doing so.
    await stopWorktreeProcs();
    salvagedRef = await salvage("an earlier run");
    try { await io.git(["worktree", "remove", "--force", wt], { cwd }); } catch { /* none */ }
    try { await io.git(["worktree", "prune"], { cwd }); } catch { /* best effort */ }
    // Concurrent lanes in one repo race on .git/config.lock / index.lock during `worktree add`; retry with jitter.
    // A leftover dir that git no longer lists as a worktree blocks `worktree add`. Remove ONLY this issue's lean dir under the lean root.
    const wtRoot = o.worktreeRoot ?? join(cwd, ".claude", "worktrees");
    const leftoverDir = async () => {
      if (!io.fs.exists || !io.fs.rmdir || dirname(wt) !== wtRoot || basename(wt) !== `lean-${issue}`) return false;
      if (!(await io.fs.exists(wt))) return false;
      const listed = String(await io.git(["worktree", "list", "--porcelain"], { cwd }).catch(() => "")).split("\n").some((l) => l === `worktree ${wt}`);
      if (listed) return false;
      await io.fs.rmdir(wt);
      ev({ event: "WORKTREE_LEFTOVER_REMOVED", path: wt });
      return true;
    };
    await leftoverDir();
    const LOCK_RE = /could not lock|cannot lock ref|\.lock'?: File exists|Unable to create .*\.lock|index\.lock|packed-refs\.lock/i;
    // #4221: tracked blobs >= sparseMaxKb stay out of the checkout (lockfiles/manifests always in); falls back to a full checkout.
    const sparseMaxKb = Number.isFinite(o.sparseMaxKb) && o.sparseMaxKb >= 0 ? o.sparseMaxKb : DEFAULT_SPARSE_MAX_KB;
    const addWorktree = async (args, ref) => {
      let cleaned = false;
      for (let i = 0; ; i++) {
        try { return await addLaneWorktree(io.git, io.fs?.write, { cwd, wt, addArgs: args, ref, maxBlobBytes: sparseMaxKb * 1024 }); } catch (e) {
          const msg = String(e?.stderr ?? e?.message ?? e);
          if (!cleaned && /already exists/i.test(msg) && (await leftoverDir())) { cleaned = true; continue; }
          if (i >= 4 || !LOCK_RE.test(msg)) throw e;
          await sleep(500 * (i + 1) + Math.floor(random() * 500));
        }
      }
    };
    if (resumed) { try { await io.git(["fetch", "origin", branch], { cwd }); } catch { /* remote branch may not exist (PR-less resume) */ } }
    // #4118: a local lane branch with commits not yet pushed (e.g. a reviewed commit whose push failed) must never be reset.
    // Reuse it when it is ahead of the base and contains everything the remote branch has.
    let keepLocal = false;
    try {
      const ahead = Number(String(await io.git(["rev-list", "--count", `${base}..refs/heads/${branch}`], { cwd })).trim());
      if (ahead > 0) {
        let containsRemote = true;
        if (resumed) { try { await io.git(["merge-base", "--is-ancestor", `origin/${branch}`, `refs/heads/${branch}`], { cwd }); } catch { containsRemote = false; } }
        keepLocal = containsRemote;
      }
    } catch { /* no local branch */ }
    ledgerDo((l) => { l.register("branch", branch); l.register("worktree", wt); });
    let wtInfo = null;
    if (keepLocal) {
      wtInfo = await addWorktree(["worktree", "add", wt, branch], `refs/heads/${branch}`);
      resumed = resumed ?? { pr: null, local: true };
      ev({ event: "LOCAL_BRANCH_REUSED", branch });
    } else if (resumed) {
      wtInfo = await addWorktree(["worktree", "add", "-B", branch, wt, `origin/${branch}`], `origin/${branch}`);
    } else {
      wtInfo = await addWorktree(["worktree", "add", "-B", branch, wt, base], base);
    }
    wtCreated = true;
    if (wtInfo?.sparse) {
      sparse = { excluded: wtInfo.excluded, maxKb: sparseMaxKb };
      ev({ event: "WORKTREE_SPARSE", excluded: wtInfo.excluded, excluded_bytes: wtInfo.bytes, max_kb: sparseMaxKb });
      T.decisions.push(`Sparse worktree: ${wtInfo.excluded} tracked file(s) >= ${sparseMaxKb} KB (${Math.round(wtInfo.bytes / 1048576)} MB) left out of the checkout`);
    } else if (wtInfo?.fallback) {
      ev({ event: "WORKTREE_SPARSE_FALLBACK", reason: wtInfo.fallback });
      T.anomalies.push(`Sparse checkout failed, full checkout used: ${wtInfo.fallback}`);
    }
    const excl = String(await git(["rev-parse", "--git-path", "info/exclude"])).trim();
    await io.fs.append(excl.startsWith("/") ? excl : `${wt}/${excl}`, `\n${LEAN_DIR}/\n`);
    // ---- 2b. toolchain pins + env.setup (#4163): before the builder; zero LLM. No pins and no setup changes nothing ----
    try {
      const tc = await (io.prepareToolchain ?? prepareToolchain)({ dir: wt, override: toolchainOverride, read: io.fs.read,
        binDir: join(runTmp ?? join(wt, LEAN_DIR), "toolchain", "bin") });
      if (tc?.summary) {
        toolchain = { env: tc.env ?? null, summary: tc.summary };
        ev({ event: "TOOLCHAIN_PINNED", pins: tc.summary, shims: tc.shims });
        T.decisions.push(tc.env ? `Toolchain pinned on the runner PATH: ${tc.summary}` : `Toolchain pins detected (no shim): ${tc.summary}`);
      }
      if (tc?.warning) { T.anomalies.push(tc.warning); ev({ event: "TOOLCHAIN_WARNING", warning: tc.warning }); }
      for (const n of tc?.notes ?? []) T.anomalies.push(n);
    } catch (e) { T.anomalies.push(`Toolchain detection failed (host toolchain used): ${String(e?.message ?? e).slice(0, 200)}`); }
    // #4220: link node_modules/.venv from the shared cache keyed by lock hash (or install once and publish). Never fails the run.
    // After 2b (#4347): installs run with the toolchain env, so a pm only its shim provides resolves; no env is the host PATH.
    if (io.deps?.prepare) {
      let res;
      try { res = await io.deps.prepare({ wt, repoKey: repoKey(cwd), env: toolchain?.env ?? undefined }); } catch (e) { res = [{ status: "failed", eco: null, key: null, ms: 0, reason: String(e?.message ?? e).slice(0, 300) }]; }
      for (const r of Array.isArray(res) ? res : []) {
        ev({ event: "DEPS_PREPARED", status: r?.status ?? null, eco: r?.eco ?? null, key: r?.key ?? null, ms: r?.ms ?? null, reason: r?.reason ?? null });
        if (r?.eco) T.decisions.push(`Dependencies (${r.eco}${r.key ? ` ${r.key}` : ""}): ${r.status}${r.reason ? ` (${r.reason})` : ""}${Number.isFinite(r.ms) ? ` in ${Math.round(r.ms / 100) / 10}s` : ""}`);
      }
    }
    // ---- 2c. heavy-step shims (#4169): after the toolchain, so a heavy shim's real binary is the pinned toolchain shim ----
    if (heavyOn) {
      try {
        const root = runTmp ?? join(wt, LEAN_DIR), binDir = join(root, "heavy", "bin"), path = toolchain?.env?.PATH ?? process.env.PATH ?? "";
        const names = await (io.writeHeavyShims ?? writeHeavyShims)(binDir, { path });
        if (names?.length) {
          heavyWaitsFile = join(root, "heavy-waits.jsonl");
          const pinned = /^\d+$/.test(String(process.env.FORGE_HOST_PARALLELISM ?? "").trim()) && Number(process.env.FORGE_HOST_PARALLELISM) > 0;
          heavyEnv = { PATH: path ? `${binDir}${delimiter}${path}` : binDir, FORGE_HEAVY_WAITS: heavyWaitsFile, ...(pinned ? { FORGE_HEAVY_PARALLELISM_PINNED: "1" } : {}),
            ...Object.fromEntries([["FORGE_HEAVY_MAX", heavyCfg.max], ["FORGE_HEAVY_STEP_MEM_MB", heavyCfg.step_mem_mb], ["FORGE_HEAVY_RESERVE_MB", heavyCfg.reserve_mb]].filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, String(v)])) };
          ev({ event: "HEAVY_SHIMS", names });
        }
      } catch (e) { T.anomalies.push(`Heavy-step shims not written (builder steps ungated): ${String(e?.message ?? e).slice(0, 200)}`); }
    }
    if (typeof envSetup === "string" && envSetup.trim()) {
      let r;
      if (!io.runSetup) r = { exit: 1, stderr: "no setup effect is configured" };
      else { try { r = await heavyStep("setup", () => io.runSetup({ cwd: wt, command: envSetup, env: laneEnv() })); } catch (e) { r = { exit: 1, stderr: String(e?.message ?? e) }; } }
      ev({ event: "ENV_SETUP", exit: r?.exit ?? 1 });
      if (r?.exit !== 0) {
        const tail = String(r?.stderr || r?.stdout || "").trim().slice(-800);
        T.anomalies.push(`Environment error: forge.yaml env.setup exited ${r?.exit ?? "?"}; the builder did not run`);
        return await needsHuman(`Environment error (not a build failure): forge.yaml \`env.setup\` (\`${envSetup.slice(0, 200)}\`) exited ${r?.exit ?? "?"} in the fresh worktree, so the builder was not started. Fix the setup command or the environment, then rerun.${tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ""}`, OUTCOME_CODES.ENV_SETUP_FAILED);
      }
      T.decisions.push("forge.yaml env.setup ran once in the fresh worktree");
    }
    const names = (out) => String(out).split("\n").map((s) => s.trim()).filter(Boolean);
    // #4160: files the branch touched (three-dot) whose content still differs from the base tip (two-dot); a file merged
    // in from the base by a base-sync equals the base and drops out of the scope check.
    const changedFiles = async () => {
      const touched = names(await git(["diff", "--name-only", `${base}...HEAD`]));
      if (!touched.length) return touched;
      const differs = new Set(names(await git(["diff", "--name-only", base, "HEAD"])));
      return touched.filter((f) => differs.has(f));
    };
    /** #4364: the last `forgedock check` record vs the current tree: skipped|stale|red|green; any read or git error is skipped. */
    const selfCheckNow = async () => {
      try { return selfCheckState(JSON.parse(await io.fs.read(`${wt}/${SELF_CHECK_FILE}`)), await worktreeFingerprint({ git, base })); } catch { return "skipped"; }
    };
    /** forge#4195: scripts/hotspots.sh facts in the worktree, or null (no io.hotspots, script failure): never fails a run. */
    const hotspotsOf = async (args) => {
      if (!io.hotspots) return null;
      const h = await io.hotspots({ cwd: wt, ...args }).catch(() => null);
      return h && typeof h === "object" && Array.isArray(h.files) ? h : null;
    };
    /** #4271: a bug lane with lean.repro_test on; refactor:split lanes never set it (no plan call, no repro_test). */
    const reproOn = () => reproTest !== "off" && isBugIssue(iss?.labels);
    let reproNoted = false;
    /** #4271: the frozen repro_test's red-green words for precheck, or null (gate off, "none", no io.redGreen). */
    const reproOf = async (c) => {
      const t = c?.repro_test;
      if (!reproOn() || !io.redGreen || !t || typeof t !== "object") {
        if (reproOn() && t === "none" && !reproNoted) { reproNoted = true; T.decisions.push(`repro_test: none (${String(c.repro_test_reason ?? "").slice(0, 200)})`); }
        return null;
      }
      const rg = await heavyStep("precheck", () => io.redGreen({ cwd: wt, base, command: String(t.command), env: laneEnv() })).catch(() => null);
      const words = rg?.base && rg?.head ? rg : { base: "UNRUNNABLE", head: "UNRUNNABLE" };
      ev({ event: "REPRO_RED_GREEN", ...words });
      T.decisions.push(`repro_test ${t.path ?? ""}${t.id ? ` ${t.id}` : ""}: BASE=${words.base} HEAD=${words.head}`);
      return words;
    };

    // ---- 3. builder: plan call -> frozen contract -> implement call in the same session ----
    let result = null, attemptN = 0, reviewN = 0;
    const lastSubject = resumed ? String(await git(["log", "-1", "--format=%s"]).catch(() => "")).trim() : "";
    const fromCheckpoint = lastSubject.startsWith("wip(forge): checkpoint");
    const hasCommits = resumed ? (await changedFiles()).length > 0 : false;
    // Requirements may only be quoted from the issue and trusted comments: an untrusted commenter cannot add a contract requirement.
    const trustedOf = (i) => (i.comments ?? []).filter((c) => {
      const login = String(c?.author?.login ?? c?.user?.login ?? "");
      return isTrustedComment({ author_association: c?.authorAssociation ?? c?.author_association, user: { login, type: c?.user?.type ?? (/\[bot\]$|^app\//.test(login) ? "Bot" : "User") } });
    });
    // #4297: engine-posted `<!-- FORGE:` comments (FORGE:CONTEXT carries linked-issue text) are never quotable, as in scopeText
    const isEngineComment = (b) => b.trimStart().startsWith("<!-- FORGE:");
    const textOf = (i, tc) => [i.title, i.body ?? "", ...tc.map((c) => String(c?.body ?? "")).filter((b) => !isEngineComment(b))].join("\n\n");
    let trustedComments = trustedOf(iss), issueEdited = false;
    let issueText = textOf(iss, trustedComments);
    let scopeHash = contractHash(scopeText(iss, trustedComments)); // #4265: the edit signal and the frozen contract's provenance
    ctxLane = laneType({ resumed: Boolean(resumed || salvagedRef), attempts: priorAttempts(iss.body, trustedComments), body: iss.body });
    /**
     * forge#4275: compile (or read from the cache) the context pack, log CONTEXT_PACK and post FORGE:CONTEXT. Off, no
     * io.contextFacts or any failure gives null: never fails a run. The pack never enters issueText (contract quotes).
     */
    async function contextPackStep() {
      const pits = await lanePitfalls();
      if (ctxCfg.mode === "off" || !io.contextFacts) return null;
      try {
        const headSha = String(await git(["rev-parse", base])).trim();
        // #4316: linked-issue states are part of the key; a failed lookup only drops them from it
        const links = await linkStateStamp({ gh: ghc, repo, issue, body: iss.body }).catch(() => "");
        const r = await contextPackFor({ cfg: ctxCfg, issue, headSha, cacheDir: dir, fs: io.fs, stamp: { scope: scopeHash, attempts: priorAttempts(iss.body, trustedComments), links, pitfalls: pits.map((x) => x.sig) },
          gather: () => io.contextFacts({ repo, issue, iss, comments: trustedComments, cwd: wt, base, sources: ctxCfg.sources, days: ctxCfg.days, now: now(), pitfalls: pits }) });
        const p = r.pack;
        const inPack = Array.isArray(p.pitfalls) ? p.pitfalls : [];
        pitMatched = inPack.filter((x) => x.match === "files").length;
        // #4375: which pitfalls were in the pack (signatures only, run log only: never telemetry or a comment)
        const rec = { event: "CONTEXT_PACK", mode: ctxCfg.mode, lane_type: ctxLane, sources: p.sources, found: p.found, bytes: p.bytes, items: p.items, truncated: p.truncated,
          hash: p.hash, cached: r.cached, ...(r.errors?.length ? { errors: r.errors } : {}) };
        ev({ ...rec, pitfalls: inPack }); await emit(rec);
        const seen = trustedComments.some((c) => String(c?.body ?? "").startsWith("<!-- FORGE:CONTEXT -->") && String(c.body).includes(`hash ${p.hash})`));
        if (p.items && !seen) { try { await post("FORGE:CONTEXT", renderContextRecord(p, { mode: ctxCfg.mode, laneType: ctxLane })); } catch { /* best effort */ } }
        T.decisions.push(`Context pack (${ctxCfg.mode}): ${p.items} item(s), ${p.bytes} bytes${p.truncated ? `, ${p.truncated} dropped` : ""}, ${ctxCfg.mode === "on" ? "given to the builder" : "recorded only"}`);
        return p;
      } catch (e) { T.anomalies.push(`Context pack not compiled (builder prompt unchanged): ${String(e?.message ?? e).slice(0, 200)}`); return null; }
    }
    /** #4375: tick the repo's lane clock (pitfall aging) and select its pitfalls for this issue; [] without io.pitfalls or on any error. */
    async function lanePitfalls() {
      if (!io.pitfalls) return [];
      try {
        await io.pitfalls.append(repo, { t: "lane", run: runId, ts: new Date(now()).toISOString() });
        if (!ctxCfg.sources.includes("pitfalls")) return [];
        return selectPitfalls(foldPitfalls(await io.pitfalls.read(repo), { maxAge: ctxCfg.pitfallLanes }), { paths: namedPaths(iss.body ?? "") });
      } catch { return []; }
    }
    /** #4188: the builder reads the live issue, so quotes are checked against the current text, not the RUN_START snapshot. Best effort. */
    async function refreshIssue(stage) {
      let next;
      try { next = JSON.parse(String(await ghc(["issue", "view", String(issue), "-R", repo, "--json", "number,title,body,state,comments,labels,updatedAt"]))); } catch { return; }
      if (!next || typeof next !== "object") return;
      const tc = trustedOf(next), text = textOf(next, tc);
      if (contractHash(issueText) === contractHash(text)) return;
      // #4265: the engine's own writes (FORGE:STATE, FORGE:* comments) refresh the text but are not an issue edit
      const old = scopeHash, now = contractHash(scopeText(next, tc));
      iss = next; trustedComments = tc; issueText = text; scopeHash = now;
      if (old === now) return;
      issueEdited = true;
      ev({ event: "ISSUE_EDITED", old, new: now, stage });
      T.decisions.push(`Issue edited during the run (${old} -> ${now}); ${stage} uses the current text`);
    }
    /** A typed block (with one corrective resume for an untyped one) ends the run; returns the terminal or null. */
    async function endIfBlocked() {
      let block = result?.status === "blocked" ? await resolveBlock(result) : null;
      if (block?.kind === "untyped" && sessionId) { // #4124: one corrective resume before any untyped block can reach needs-human
        T.decisions.push(`Builder block rejected (${block.problem}); resumed once`);
        await builder(++attemptN, blockCorrectionPrompt(block.problem), sessionId, false, undefined, { trigger: "block_correction" });
        result = await readResult();
        block = result?.status === "blocked" ? await resolveBlock(result) : null;
      }
      return block ? await endBlocked(block, result.summary) : null;
    }
    /** File (or append to) the parent's one batched follow-up issue for these requirements, then verify each tracking issue is open. */
    async function track(reqs, why) {
      const fail = (detail) => Object.assign(new Error(detail), { deferCode: OUTCOME_CODES.FOLLOWUP_UNAVAILABLE, deferDetail: `${detail}; nothing merged, rerun to retry` });
      if (!io.fileFollowups) throw fail("no follow-up filing effect is configured");
      const items = followupItems(reqs);
      let filed;
      try { filed = await io.fileFollowups({ parent: issue, repo, items }); } catch (e) { throw fail(`filing the follow-up issue failed: ${String(e?.message ?? e).slice(0, 200)}`); }
      for (const [i, r] of reqs.entries()) {
        const n = Number(filed?.[items[i].key]);
        if (!Number.isSafeInteger(n) || n <= 0) throw fail(`no tracking issue was returned for ${r.id}`);
        let st = null;
        try { st = JSON.parse(String(await ghc(["issue", "view", String(n), "-R", repo, "--json", "number,state"]))); } catch { st = null; }
        if (String(st?.state).toUpperCase() !== "OPEN") throw fail(`tracking issue #${n} for ${r.id} is not open or unreadable`);
        r.tracked = `#${n}`;
      }
      T.decisions.push(`Tracked ${reqs.map((r) => `${r.id} (${r.disposition})`).join(", ")} in ${[...new Set(reqs.map((r) => r.tracked))].join(", ")} (${why})`);
    }
    /**
     * #4328: probe the host for the tools and modules a contract's validate commands need; #4393: then flag `$NAME`s the lane
     * env leaves empty and run each remaining command once on the base worktree (io.preflightRun). The misses; [] without either hook.
     */
    async function preflightValidates(contract) {
      if ((!io.probeCommand && !io.preflightRun) || !contract || typeof contract !== "object") return [];
      const files = String(await git(["ls-files"]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean);
      const env = laneEnv(), missing = new Set(), misses = []; // #4325: the env the validate commands run with
      if (io.probeCommand) {
        const { probes, dropped } = preflightProbes(contract, { repoHas: repoTracks(files) });
        if (dropped) T.anomalies.push(`Validate preflight probed ${probes.length} tool(s); ${dropped} more not probed`);
        for (const p of probes) {
          if (p.needs && missing.has(p.needs)) continue;
          let r;
          try { r = await io.probeCommand({ command: p.probe, cwd: wt, timeoutMs: 15000, env }); } catch { r = { rc: 127 }; }
          if (r?.rc === 0 || r?.rc === 124) continue; // a timed-out probe is no evidence either way
          if (p.kind === "command") missing.add(p.tool);
          misses.push({ ...p, source: "probe" });
        }
      }
      const fullEnv = { ...process.env, ...env };
      for (const v of Array.isArray(contract.validate) ? contract.validate : []) {
        if (v?.id && typeof v.command === "string") for (const name of unsetEnvVars(v.command, fullEnv)) misses.push({ ids: [v.id], tool: name, kind: "env-var", source: "env" });
      }
      if (io.preflightRun) {
        const skipIds = [...new Set(misses.flatMap((m) => m.ids))];
        const run = (a) => heavyStep("precheck", () => io.preflightRun({ ...a, cwd: wt }));
        const r = await runPreflight({ contract, run, git, env, skipIds, now, ...knownToContract(contract, files) });
        misses.push(...r.misses);
        if (r.skipped.length) T.anomalies.push(`Validate preflight run budget spent; ${r.skipped.join(", ")} not run on base`);
        if (r.reverted.length) T.anomalies.push(`Validate preflight reverted ${r.reverted.length} path(s) its runs changed: ${r.reverted.slice(0, 5).join(", ")}`);
      }
      return misses;
    }
    /**
     * The frozen contract posted by an earlier run of this issue, verified against its hash; null when absent. `humanAfter`
     * (#4265): a trusted comment that the engine did not post came after it.
     */
    async function readFrozenContract() {
      let out = "";
      try { out = String(await ghc(["api", "--paginate", `repos/${repo}/issues/${issue}/comments`, "--jq", ".[] | {body, author_association, user: {type: .user.type, login: .user.login}}"])); } catch { return null; }
      let found = null;
      for (const l of out.split("\n")) {
        let c; try { c = JSON.parse(l); } catch { continue; }
        if (!isTrustedComment(c)) continue;
        const b = String(c?.body ?? "");
        if (!b.startsWith("<!-- FORGE:CONTRACT -->")) { if (found && b.trim() && !b.trimStart().startsWith("<!-- FORGE:")) found.humanAfter = true; continue; }
        const fc = parseContractComment(b);
        if (fc && contractHash(fc.text) === fc.hash) found = { ...fc, humanAfter: false };
      }
      return found;
    }

    const isSplit = (iss.labels ?? []).some((l) => (l?.name ?? l) === SPLIT_LABEL);
    /**
     * #4211: the refactor:split step. One tool-less grouping call over the symbol index (none for a chained plan), the
     * codemod move and its deterministic proof (bin/lean/refactor.mjs). A rerun on a branch that already holds the move
     * re-verifies it instead. Returns {done} (needs-human, worktree left at its start commit) or the split result with a
     * synthetic location-only contract for the renderers.
     */
    async function splitStep() {
      await label("building");
      const mod = o.refactorModule ?? (await import("./refactor.mjs"));
      const body = String(iss.body ?? "");
      const precheckList = Array.isArray(o.precheck?.commands) ? o.precheck.commands : [];
      let r;
      if (hasCommits) {
        const target = mod.parseSplitTarget(body) ?? mod.parseSplitPlan(body)?.target, testCmd = mod.parseTestCmd(body, precheckList);
        r = target && testCmd ? await heavyStep("split", () => mod.reverifySplit({ wt, base, target, testCmd, runTmp, git })) : { ok: false, code: OUTCOME_CODES.SPLIT_PLAN_INVALID, reason: "rerun of a split branch without a target or test command in the issue" };
        if (r.ok) {
          r = { ...r, target, testCmd, package: null, modules: {}, rest: null, grouped: false };
          T.anomalies.push("Rerun of a split branch: the existing move was re-verified; a chained remainder is not recomputed");
        }
      } else {
        let slot = await heavyAcquire("split"); // the grouper's LLM call gives the slot back while it runs (#4169)
        try {
          r = await mod.runSplitStep({ wt, base, issue, issueBody: body, precheckCommands: precheckList, runTmp, git, ...(o.splitMaxLines ? { maxLines: o.splitMaxLines } : {}),
            callGrouper: async (prompt, { cwd } = {}) => {
              try { slot?.release?.(); } catch { /* fail-open */ }
              slot = null;
              try {
                await renew();
                const rr = await callRunner({ role: "grouper", issue, cwd: cwd ?? runTmp ?? wt, model: reviewerModel, resume: null, system: GROUPING_SYSTEM, prompt, noTools: true });
                await renew();
                await attempt("group", 1, rr, null, "plan");
                return rr?.text ?? "";
              } finally { slot = await heavyAcquire("split"); }
            } });
        } finally { try { slot?.release?.(); } catch { /* fail-open */ } }
      }
      ev({ event: "SPLIT", ok: r.ok, code: r.code ?? null, grouped: Boolean(r.grouped), modules: Object.keys(r.modules ?? {}).length, rest: Object.keys(r.rest ?? {}).length });
      if (!r.ok) {
        T.validate = ["SPLIT REFUSED", r.code]; T.plan = "skipped"; T.implement = "none (worktree reset)"; T.review = "skipped"; T.pr = "none"; T.merge = "n/a";
        return { done: await needsHuman(`refactor:split refused (${r.code}); nothing was pushed:\n${r.reason}`, r.code) };
      }
      const moved = await changedFiles();
      const contract = { requirements: [], deliverables: moved.map((path, i) => ({ id: `D${i + 1}`, path, change: "location-only: moved verbatim or re-export shim", requirements: [] })), preserve: [], validate: [] };
      const mods = Object.entries(r.modules ?? {});
      try {
        await post("FORGE:SPLIT", `## refactor:split\n**Target:** \`${r.target}\`\n**Package:** \`${r.package ?? "(rerun)"}\`\n**Modules:** ${mods.map(([m, l]) => `\`${m}\` (${l.length})`).join(", ") || "n/a"}\n**Plan:** ${r.grouped ? "one grouping call over the symbol index" : "no LLM call"}\n**Remaining:** ${Object.keys(r.rest ?? {}).length} module(s)\n\n\`\`\`json\n${JSON.stringify(r.verify ?? {})}\n\`\`\``);
      } catch { /* best effort */ }
      T.validate = ["CONFIRMED", `refactor:split \`${r.target}\``];
      T.decisions.push(`refactor:split: ${r.grouped ? "one grouping call" : "no LLM call"}, ${mods.length} module(s) into ${r.package ?? "(rerun)"}, refactor-verify ok${r.rest ? `, ${Object.keys(r.rest).length} module(s) chained` : ""}`);
      T.implement = [`${moved.length} file(s)`, branch];
      sessionId = null;
      return { ...r, contract };
    }
    let frozen = null, hash = null, planned = false, files = [], split = null;
    const pendingPits = []; // #4375: rework rounds whose gate has not passed again yet
    async function notePitfall(trigger, text) {
      const pit = io.pitfalls ? pendingPitfall(trigger, text) : null;
      if (pit) { try { pit.before = String(await git(["rev-parse", "HEAD"])).trim(); pendingPits.push(pit); } catch { /* best effort */ } }
    }
    /** #4375: the gate of `triggers` (all when none) passed: record its pending rework rounds as pitfalls. Never fails a run. */
    async function gatePassed(...triggers) {
      for (const pit of pendingPits.filter((x) => !triggers.length || triggers.includes(x.trigger))) {
        pendingPits.splice(pendingPits.indexOf(pit), 1);
        try {
          const changed = String(await git(["diff", "--name-only", `${pit.before}..HEAD`])).split("\n").map((f) => f.trim()).filter(Boolean);
          await io.pitfalls.append(repo, pitfallRecord({ pending: pit, files: changed, run: runId, ts: new Date(now()).toISOString() }));
          ev({ event: "PITFALL_RECORDED", trigger: pit.trigger, sig: pit.sig });
        } catch { /* the ledger is a cache */ }
      }
    }
    /**
     * #4363: one fix round. Mechanical failures (and a conformance/review FAIL citing file:line) run in a fresh session on
     * the fix model with a narrow prompt; one resume of the build session follows when it made no commit. Else: a resume.
     */
    async function fixRound(kind, task, failures, trigger, failureText = "") {
      await notePitfall(trigger, failureText); // #4375: learned once the same gate passes
      if (!freshFix(kind, failures)) return await builder(++attemptN, task, sessionId ?? null, false, undefined, { mode: "resume", trigger });
      const before = String(await git(["rev-parse", "HEAD"])).trim();
      const ex = [".", `:!${LEAN_DIR}`], diff = String(await git(["diff", `${base}...HEAD`, "--", ...ex]).catch(() => "")), stat = String(await git(["diff", "--stat", `${base}...HEAD`, "--", ...ex]).catch(() => ""));
      const prompt = fixSessionPrompt({ task, diff, stat, base, contract: frozen, title: iss?.title ?? "", summary: issueSummary(iss?.body) });
      const r = await builder(++attemptN, prompt, null, false, () => prompt, { model: fixModel ?? reviewerModel, mode: "fresh", keepSession: true, trigger });
      if (!sessionId || String(await git(["rev-parse", "HEAD"])).trim() !== before) return r;
      T.decisions.push(`Fresh ${kind} fix session made no commit; builder session resumed once`);
      return await builder(++attemptN, task, sessionId, false, undefined, { mode: "resume", trigger });
    }
    if (isSplit) {
      // ---- 3'. refactor:split (#4211): deterministic move + proof replaces the builder; no builder session exists ----
      split = await splitStep();
      if (split.done) return split.done;
      frozen = split.contract; hash = contractHash(contractJson(frozen));
      files = await changedFiles();
    } else {
      if (resumed) {
        const fc = await readFrozenContract();
        if (fc) {
          // #4265: a contract planned from an older issue scope is stale: re-plan and freeze a new one instead of judging against it
          await refreshIssue("rerun contract check");
          const gone = (Array.isArray(fc.contract?.requirements) ? fc.contract.requirements : []).filter((r) => r?.disposition === "deliver" && !inIssue(r.quote, issueText)).map((r) => r.id);
          const stale = fc.scope ? (fc.scope !== scopeHash ? `issue scope ${fc.scope} -> ${scopeHash}` : null)
            : fc.humanAfter ? "a human comment was posted after it" : gone.length ? `quote(s) no longer in the issue: ${gone.join(", ")}` : null;
          if (stale) {
            ev({ event: "CONTRACT_STALE", hash: fc.hash, scope: fc.scope, now: scopeHash, reason: stale });
            T.decisions.push(`Rerun: frozen contract ${fc.hash} is stale (${stale}); re-planning`);
          } else { frozen = fc.contract; hash = fc.hash; T.decisions.push(`Rerun: frozen contract ${hash} recovered from the issue`); }
        }
      }
      await label("building");
      hotFacts = await hotspotsOf({ paths: namedPaths(iss.body ?? "") });
      enumList = io.enumeratingTests ? ((await io.enumeratingTests({ cwd: wt, paths: namedPaths(iss.body ?? "") }).catch(() => null)) ?? []) : [];
      facts = await factsPath([wt, cwd], io.fs?.exists);
      const ctxPack = frozen ? null : await contextPackStep();
      const planPrompt = () => builderPlanPrompt(issue, tcOpts()) + hotspotPlanNote(hotFacts) + enumeratingPlanNote(enumList) + reproPlanNote(reproOn()) + (ctxCfg.mode === "on" ? contextPackNote(ctxPack) : "");
      if (!frozen) {
        await builder(++attemptN, planPrompt() + (hasCommits ? PLAN_RERUN_NOTE.replace("BASE", lane) : "") + recoverNote(), null, true, planPrompt, { trigger: "plan" });
        planned = true;
        result = await readResult();
        const evidence = (Array.isArray(result?.evidence) ? result.evidence : []).filter((x) => typeof x === "string" && x.trim());
        const closes = ["invalid", "already-fixed"].includes(result?.status);
        if (closes || result?.status === "blocked") await flushStages(result, ["investigation"]); // the evidence comment for invalid/already-fixed
        T.validate = [result?.status ? String(result.status === "fixed" ? "CONFIRMED" : result.status).toUpperCase() : "CONFIRMED", `${evidence.length} evidence item(s)`];
        if (closes && !evidence.length) return await needsHuman(`Builder reported "${result.status}" without evidence, so the issue is not closed automatically.\n\n${result.summary ?? "(no summary)"}`, OUTCOME_CODES.BUILDER_NO_EVIDENCE);
        if (closes) {
          T.plan = "skipped"; T.implement = "skipped"; T.review = "skipped"; T.pr = "none"; T.merge = "n/a";
          T.decisions.push(`Builder verdict: ${result.status}`);
          await ghw(["issue", "close", String(issue), "-R", repo, "--reason", "not planned"]);
          await label("invalid");
          return await finish("invalid", result.summary ?? result.status);
        }
        const blocked = await endIfBlocked();
        if (blocked) return blocked;
        // #4353: the engine's scope gate is the only scope authority; a pure file-scope validate is dropped before it is checked or frozen
        const dropScope = (c) => {
          const d = dropScopeValidates(c);
          if (d.dropped.length) {
            ev({ event: "CONTRACT_SCOPE_VALIDATE_DROPPED", runs: d.dropped });
            const note = `Scope-check validate ${d.dropped.map((x) => x.id).join(", ")} dropped at contract freeze: the engine's scope gate (deliverables plus typed amendments) enforces scope`;
            if (!T.decisions.includes(note)) T.decisions.push(note);
          }
          return d.contract;
        };
        let contract = dropScope(await readContract());
        await refreshIssue("contract validation");
        let vc = validateContract(contract, issueText, { repro: reproOn() });
        const missed = await preflightValidates(contract); // #4328: validate commands the host cannot run share the one correction
        let misses = missed;
        if ((!vc.ok || missed.length) && sessionId) {
          const problems = [...vc.problems, ...preflightProblems(missed)];
          T.decisions.push(`Contract rejected (${problems[0]}); resumed once`);
          await builder(++attemptN, contractCorrectionPrompt(problems), sessionId, false, planPrompt, { trigger: "contract_correction" });
          contract = dropScope(await readContract());
          await refreshIssue("contract validation");
          vc = validateContract(contract, issueText, { repro: reproOn() });
          if (missed.length) misses = await preflightValidates(contract);
        }
        if (missed.length) {
          ev({ event: "VALIDATE_PREFLIGHT", misses: misses.map((m) => ({ ids: m.ids, tool: m.tool, kind: m.kind, source: m.source })), found: missed.map((m) => ({ ids: m.ids, tool: m.tool, kind: m.kind, source: m.source })), corrected: misses.length === 0 });
          if (misses.length) {
            T.anomalies.push(`Validate preflight: the host lacks ${misses.map((m) => m.tool).join(", ")} after the contract correction (advisory; a failed rerun ends env.tool_missing)`);
            T.decisions.push(`Validate preflight left ${misses.length} miss(es) after one correction; contract frozen anyway`);
          }
        }
        await flushStages(result ?? { status: "fixed" }, ["investigation"]); // always posted: FORGE:INVESTIGATION/VALIDATE are read downstream
        if (!vc.ok) return await needsHuman(`The builder's contract is still invalid after one correction:\n${vc.problems.slice(0, 12).map((x) => `- ${x}`).join("\n")}`, OUTCOME_CODES.CONTRACT_INVALID, issueEdited ? { issueEdited: true } : {});
        frozen = contract;
        hash = contractHash(contractJson(frozen));
        let body = renderContract(frozen, hash, { scope: scopeHash });
        if (body.length > MAX_COMMENT_CHARS - 500) body = renderContract(frozen, hash, { compact: true, scope: scopeHash }); // the JSON must survive the comment cap
        await post(["FORGE:CONTRACT", "FORGE:PLAN"], body);
        const deferredN = frozen.requirements.filter((r) => TRACKED.includes(r.disposition)).length;
        ev({ event: "CONTRACT_FROZEN", hash, requirements: frozen.requirements.length, deferred: deferredN });
        T.decisions.push(`Contract frozen (${hash}): ${frozen.requirements.length} requirement(s), ${deferredN} deferred pending review`);
      } else {
        T.validate = "resumed (existing branch)";
      }
      T.plan = [`contract ${hash}`, `${frozen.requirements.length} requirement(s)`];
      tb.setSize(laneSize({ contract: frozen, labels: (iss?.labels ?? []).map((l) => l?.name ?? l) })); // #4392
      if (io.fs.write) { try { await io.fs.write(`${wt}/${CONTRACT_FILE}`, `${contractJson(frozen)}\n`); } catch { /* the prompt still names it */ } }
      // #4364: what `forgedock check` needs from the operator's forge.yaml (gitignored, so not in the worktree)
      if (io.fs.write) { try { await io.fs.write(`${wt}/${CHECK_PLAN_FILE}`, `${JSON.stringify({ v: 1, base, mode: vcfg.mode, learned: learnedCommands, maxMinutes: Number(o.precheck?.maxMinutes) > 0 ? Number(o.precheck.maxMinutes) : null, precheckTotalSeconds: vcfg.precheckTotalSeconds, precheckTimeoutSeconds: vcfg.precheckTimeoutSeconds })}\n`); } catch { /* the CLI falls back to forge.yaml */ } }
      const implementPrompt = builderImplementPrompt(vcfg.mode, tcOpts()) + hotspotBuildRule(hotFacts) + enumeratingBuildRule(enumList) + (planned ? "" : (fromCheckpoint ? CONTINUE_NOTE : RERUN_NOTE).replace("BASE", lane)) + (salvagedRef ? SALVAGE_NOTE.replaceAll("REF", salvagedRef) : "") + recoverNote();
      liveKeys = ["implementation"];
      stage = "implement";
      await builder(++attemptN, implementPrompt, planned ? sessionId : null, true, undefined, { trigger: "build" });
      stage = "fix"; // later builder rounds fix precheck, CI, structure, docs or conformance findings
      result = await readResult();
      { // #4374: the builder's self-review against the shared rubric, log only
        const sr = readSelfReview(result);
        if (sr) ev(sr.state === "present" ? { event: "SELF_REVIEW", answers: sr.items.length, no: sr.no } : { event: "SELF_REVIEW_MISSING", state: sr.state });
      }
      // #4364: a builder that writes fixed without a green `forgedock check` on its final tree; recorded, never a failure
      if (result?.status === "fixed") { const state = await selfCheckNow(); if (state !== "green") ev({ event: "SELF_CHECK_MISSING", state }); }
      {
        const blocked = await endIfBlocked();
        if (blocked) return blocked;
      }
      files = await changedFiles();
      if (!files.length) return await needsHuman(`Builder made no commit${result ? ` (status "${result.status}")` : " and wrote no result.json"}.\n\n${result?.summary ?? ""}`, OUTCOME_CODES.BUILDER_NO_COMMIT);
      await flushStages(result, ["implementation"]);
      T.implement = [`${files.length} file(s)`, branch];
      T.decisions.push(`Builder verdict: ${result?.status ?? "none"}`);
    }

    // ---- 3a. declared check commands (#4240): the repo's own cheap gates (forge.yaml learned.test_commands), run locally in
    // the worktree before review and PR; no Actions minutes. A failure goes back to the builder in-session (#4149), up to
    // verify.max_rounds; a round with no commit or exhausted rounds is an anomaly, not a stop: CI stays the gate.
    let checkCommandsFailing = false; // #4273: a failed gate triggers the reviewer
    // #4272: an optional .forge/test-map.json picks the commands for the changed files; no map or no match keeps the list.
    // #4297: its commands run, so the map comes from the base ref (else the operator's checkout), never the lane worktree
    const testMap = io.runCommand ? (await readTestMapAtRef(git, base)) ?? (await readTestMap([cwd], io.fs?.read)) : null;
    // #4331: a learned command the map covers runs only when its globs match a changed file; unmapped ones always run (#4315)
    const pickChecks = () => planPrecheck({ testMap, files, learned: learnedCommands, maxMinutes: o.precheck?.maxMinutes, verify: vcfg });
    let picked = pickChecks();
    // #4270: the last result of each deterministic gate, as computed below; only reportVerify (verify.check_run) reads it
    const verifyFacts = { commands: null, structure: null, undeclaredEdges: [], docs: null, precheck: null, amendments: [], hotspots: false };
    if (picked.source !== "learned") T.decisions.push(`Pre-PR checks selected from ${TEST_MAP_FILE}: ${picked.selected} of ${testMap.entries.length} entries${learnedCommands.length ? `, plus ${learnedCommands.length - picked.dropped.length} learned` : ""}${picked.dropped.length ? `; ${picked.dropped.length} mapped learned command(s) not matching the changed files left to CI` : ""}`);
    if (picked.commands.length && io.runCommand) {
      precheckRan = true;
      for (let round = 0; ; round++) {
        await renew();
        if (round) picked = pickChecks();
        const precheckCommands = picked.commands;
        // #4318/#4331: one round has a total budget (lean.precheck.max_minutes, else verify.precheck_total_seconds); the
        // commands run concurrently up to the host worker cap; the rest are deferred to CI, not failed. #4344: one heavy
        // slot per running command, and the worker cap is divided among them (FORGE_HOST_PARALLELISM = floor(N / k))
        const totalMs = picked.budgetMs;
        const parallelism = Number(verifyParallelism()) || 1;
        let workers = 1;
        const round$ = await runChecks({ commands: precheckCommands, parallelism, budgetMs: totalMs, perCommandMs: picked.perCommandMs, now,
          acquire: () => heavyAcquire("precheck"),
          run: ({ command, timeoutMs, workers: share }) => { workers = share; const env = laneEnv(); return io.runCommand({ command, cwd: wt, timeoutMs, env: env.FORGE_HOST_PARALLELISM ? { ...env, FORGE_HOST_PARALLELISM: String(share) } : env }); } });
        const { results, deferred } = round$;
        precheckMs += round$.ms; precheckDeferred += deferred.length;
        if (deferred.length) T.anomalies.push(`deferred-to-ci: pre-PR check budget ${totalMs / 1000} s reached; left to CI: ${deferred.map((c) => `\`${c}\``).join(", ")}`);
        const roundFailed = results.some((r) => r.rc !== 0);
        ev({ event: "PRECHECK_COMMANDS", round, results: [...results.map(({ command, rc, ms }) => ({ command, rc, ms })), ...deferred.map((command) => ({ command, status: "deferred-to-ci" }))],
          ms: round$.ms, parallelism, workers, ...(picked.source !== "learned" ? { source: picked.source } : {}), ...(roundFailed ? { self_check: await selfCheckNow() } : {}) });
        verifyFacts.commands = results.map(({ command, rc }) => ({ command, rc }));
        const failed = results.filter((r) => r.rc !== 0);
        if (!failed.length) { checkCommandsFailing = false; if (round) T.decisions.push(`Declared check commands pass after ${round} builder fix round(s)`); await gatePassed("precheck"); break; }
        const names = failed.map((f) => `\`${f.command}\` (exit ${f.rc})`).join(", ");
        if (isSplit) return await needsHuman(`Declared check command(s) fail on the refactor:split move (no builder edits a split); nothing merged: ${names}`, OUTCOME_CODES.CI_RED);
        checkCommandsFailing = true;
        if (round >= vcfg.maxRounds || !sessionId) { T.anomalies.push(`Declared check command(s) still failing before the PR: ${names}`); break; }
        T.decisions.push(`Declared check command(s) failed: ${names}; builder resumed (round ${round + 1}/${vcfg.maxRounds})`);
        const before = String(await git(["rev-parse", "HEAD"])).trim();
        const capped = capLogs(failed.map((f) => ({ ...f, log: f.output }))).map((f) => ({ command: f.command, rc: f.rc, output: f.log }));
        // #4390: the builder sees each failure quiet (tail, failing ids, full-log path); the pitfall text stays the capped tail
        const quiet = await Promise.all(failed.map(async (f, i) => {
          const rel = `${CHECK_LOG_DIR}/precheck-${round + 1}-${i + 1}.log`;
          let logPath = null;
          if (io.fs.write) { try { await io.fs.write(`${wt}/${rel}`, String(f.output ?? "")); logPath = rel; } catch { /* tail only */ } }
          return { command: f.command, rc: f.rc, output: quietFailure(f.output, { maxChars: capped[i].output.length || 500, logPath }) };
        }));
        await fixRound("precheck", precheckFailurePrompt(quiet, vcfg.mode), [], "precheck", capped.map((f) => `${f.command}\n${f.output ?? ""}`).join("\n"));
        await upsertStage("implementation");
        result = (await readResult()) ?? result;
        if (String(await git(["rev-parse", "HEAD"])).trim() === before) { T.anomalies.push(`Declared check command(s) failing and the builder made no new commit for them: ${names}`); break; }
        files = await changedFiles();
      }
    }

    // ---- 3b. structure delta (forge#4159): deterministic, before the conformance review; no reviewer run of its own ----
    // A package.json edge between workspace packages the contract does not name blocks (one builder resume) in either
    // conformance mode; import-pair growth and boundary-config loosening only add one line to the reviewer prompt.
    const structureOf = async () => {
      if (!io.structureDelta) return null;
      const d = await io.structureDelta({ cwd: wt, base }).catch(() => null);
      return d && typeof d === "object" && Array.isArray(d.package_edges_added) ? d : null; // `{}`: no workspace packages
    };
    let structure = await structureOf();
    if (structure) {
      const pairs = structure.import_pairs ?? [], sum = (k) => pairs.reduce((n, p) => n + (Number(p?.[k]) || 0), 0);
      const rec = { event: "STRUCTURE_DELTA", edges_added: structure.package_edges_added.length, edges_removed: (structure.package_edges_removed ?? []).length,
        import_files_added: sum("files_added"), import_files_removed: sum("files_removed"), boundary_changed: Boolean(structure.boundary_config_changed?.changed), boundary_loosened: Boolean(structure.boundary_config_changed?.loosens) };
      ev(rec); // run log only: the telemetry write is the merge-time record (forge#4165)
      const undeclared = () => unnamedEdges(applyAmendments(frozen, result?.amendments, issueText).contract, structure);
      let edges = undeclared();
      if (edges.length && sessionId) {
        T.decisions.push(`Undeclared package edge(s) ${edges.map((e) => `${e.from}→${e.to}`).join(", ")}; builder resumed once`);
        await fixRound("structure", structurePrompt(edges, vcfg.mode), [], "structure", edges.map((e) => `undeclared package edge \`${e.from}\` -> \`${e.to}\` (${e.manifest})`).join("\n"));
        await upsertStage("implementation");
        result = (await readResult()) ?? result;
        structure = (await structureOf()) ?? structure;
        edges = undeclared();
      }
      verifyFacts.structure = structure; verifyFacts.undeclaredEdges = edges;
      if (!edges.length) await gatePassed("structure");
      if (edges.length) {
        return await needsHuman(`The change adds dependencies between workspace packages that the frozen contract does not name${sessionId ? ", after one builder resume" : ""}; nothing merged:\n${edges.slice(0, 15).map((e) => `- ${e.from} → ${e.to} (${e.kind}, \`${e.manifest}\`)`).join("\n")}\n\nAdd each to the contract with a reason, or remove it.`, OUTCOME_CODES.STRUCTURE_UNDECLARED_EDGE);
      }
    }
    // ---- 3c. the target repo's devdocs freshness rule, when it has one: deterministic, before any PR, so a lane does not
    // pay for a failed required check. Exit 1 resumes the builder once; still failing is needs-human docs.stale.
    if (io.docsFreshness) {
      let docs = await io.docsFreshness({ cwd: wt, base }).catch(() => null);
      if (docs && !docs.ok && sessionId) {
        ev({ event: "DOCS_STALE", round: 1 });
        T.decisions.push("Docs freshness check failed; builder resumed once");
        await fixRound("docs", docsPrompt(docs.output), [], "docs", String(docs.output ?? ""));
        await upsertStage("implementation");
        result = (await readResult()) ?? result;
        docs = await io.docsFreshness({ cwd: wt, base }).catch(() => null);
      }
      verifyFacts.docs = docs;
      if (docs?.ok) await gatePassed("docs");
      if (docs && !docs.ok) {
        return await needsHuman(`The repository's docs freshness check still fails${sessionId ? " after one builder resume" : ""}; nothing merged:\n\n${String(docs.output).slice(0, 2000)}`, OUTCOME_CODES.DOCS_STALE);
      }
    }
    // ---- 3d. enumerating tests (#4322): new symbols that tests listing their siblings do not name; one resume, then an
    // anomaly (CI stays the gate). Sequence numbers the base already uses: renumbered at hand-off, still colliding = base.conflict.
    if (io.enumeratingMissing && !isSplit) {
      const missingNow = async () => unjustified((await io.enumeratingMissing({ cwd: wt, base }).catch(() => null)) ?? [], result?.not_members);
      let missing = await missingNow();
      if (missing.length && sessionId) {
        ev({ event: "ENUMERATING_MISSING", count: missing.length });
        T.decisions.push(`Enumerating test(s) miss new symbol(s): ${missing.slice(0, 5).map((m) => `${m.symbol} → ${m.test}`).join(", ")}; builder resumed once`);
        await fixRound("enumerating", missingEntriesPrompt(missing, vcfg.mode), [], "enumerating", missing.map((m) => `enumerating test ${m.test} misses new member \`${m.symbol}\``).join("\n"));
        await upsertStage("implementation");
        result = (await readResult()) ?? result;
        missing = await missingNow();
      }
      if (!missing.length) await gatePassed("enumerating");
      if (missing.length) T.anomalies.push(`Enumerating test(s) still miss new symbol(s): ${missing.slice(0, 5).map((m) => `${m.symbol} → ${m.test}`).join(", ")}`);
    }
    /** #4322: null (nothing to do), {done} (terminal), or {renumbered: true}. Fetches the lane, so the check sees its tip. */
    async function sequenceHandoff(trigger) {
      if (!io.sequenceCheck || isSplit) return null;
      try { await git(["fetch", "origin", lane]); } catch { /* offline: use the local ref */ }
      const collisions = (await io.sequenceCheck({ cwd: wt, base }).catch(() => null)) ?? [];
      if (!collisions.length) return null;
      const before = (await io.sequenceSnapshot?.({ cwd: wt, base }).catch(() => null)) ?? [];
      ev({ event: "SEQUENCE_COLLISION", trigger, files: collisions.map((c) => c.lane) });
      T.decisions.push(`Sequence number(s) taken on ${lane} (${trigger}): ${collisions.filter((c) => c.base.length).map((c) => `${c.lane} vs ${c.base.join(", ")}`).join("; ")}; builder renumbers`);
      await fixRound("sequence", sequencePrompt(collisions, lane, vcfg.mode), [], "sequence", collisions.map((c) => `sequence number collision: ${c.lane} already taken by ${(c.base ?? []).join(", ")}`).join("\n"));
      result = (await readResult()) ?? result;
      const v = (await io.sequenceVerify?.({ cwd: wt, base, before }).catch(() => null)) ?? { ok: false, problems: ["renumber could not be verified"] };
      if (!v.ok) return { done: await needsHuman(`Sequence-numbered files still collide with ${lane} after the builder renumbered (${trigger}); nothing merged:\n${v.problems.slice(0, 10).map((x) => `- ${x}`).join("\n")}`, OUTCOME_CODES.BASE_CONFLICT) };
      await gatePassed("sequence");
      files = await changedFiles();
      return { renumbered: true };
    }
    { const sq = await sequenceHandoff("hand-off"); if (sq?.done) return sq.done; }
    const structureLine = structureNote(structure);

    // ---- 3c. verify by CI (#4167): ci|hybrid push the branch and run the repo's CI on GitHub runners, before review ----
    // A red run resumes the builder with the failed jobs' logs (verify.max_rounds), slow CI ends ci-pending, and CI that
    // cannot run falls back once to local validation. A head verified here lets the precheck accept validate ids left to CI.
    let ciVerifiedHead = null, ciFellBack = false, ciRounds = 0;
    const ciSeenRuns = [];
    /** Verifies the current head; returns {done} with a terminal result, or {fixes} (builder CI-fix rounds that moved the head). */
    async function ciVerify(trigger) {
      let fixes = 0;
      for (;;) {
        const head = String(await git(["rev-parse", "HEAD"])).trim();
        if (head === ciVerifiedHead || ciFellBack) return { fixes };
        files = await changedFiles();
        const v = await runCiVerify({ io, branch, head, changedFiles: files, verify: vcfg, ciMaxMinutes, now, sleep, random, exclude: ciSeenRuns,
          push: () => gitPush(["push", "-u", "origin", branch]),
          onPoll: async () => { await renew(); onProgress({ event: "phase_paused", phase: "verify", detail: `CI verification pending on ${branch}` }); } });
        if (v.runId != null) ciSeenRuns.push(v.runId);
        const rec = { event: "CI_VERIFY", trigger, mode: vcfg.mode, round: ciRounds, result: v.result, skipped: v.result === "skipped", run_url: v.runUrl ?? null, failures: v.failures.map((f) => f.job) };
        ev(rec); await emit({ ...rec, phase: "verify" });
        const row = (res) => { T.verify = [res, `mode ${vcfg.mode}, ${ciRounds} fix round(s)${v.runUrl ? `, ${v.runUrl}` : ""}`]; };
        if (v.result === "pass" || v.result === "skipped") {
          ciVerifiedHead = head;
          if (v.result === "pass") await gatePassed("ci_red", "merge_ci");
          row(v.result === "pass" ? `CI green at ${head.slice(0, 12)}` : "skipped (docs-only change)");
          if (v.result === "skipped") T.decisions.push(`CI verification skipped: ${v.detail}`);
          return { fixes };
        }
        if (v.result === "timeout") {
          row("CI pending");
          T.anomalies.push("CI verification still pending at the wait budget");
          return { done: await finish("ci-pending", `CI verification of ${branch} still pending after ${ciMaxMinutes} min; rerun resumes the branch`) };
        }
        if (v.result === "unavailable") {
          if (isSplit) return { done: await needsHuman(`CI verification unavailable for the refactor:split move (${v.detail}); a split never falls back to builder validation; nothing merged.`) };
          ciFellBack = true;
          row("unavailable: local fallback");
          T.decisions.push(`CI verification unavailable (${v.detail}); builder runs the validate commands locally`);
          await builder(++attemptN, ciUnavailablePrompt(), sessionId ?? null, false, undefined, { trigger: "ci_unavailable" });
          await upsertStage("implementation");
          result = (await readResult()) ?? result;
          return { fixes: fixes + 1 };
        }
        // fail
        const jobs = v.failures.map((f) => f.job).join(", ") || "unknown job";
        row(`CI red (${jobs})`);
        if (ciRounds >= vcfg.maxRounds || !sessionId) {
          return { done: await needsHuman(`CI verification failed on \`${branch}\` at \`${head.slice(0, 12)}\` after ${ciRounds} fix round(s); nothing merged:\n${v.failures.slice(0, 10).map((f) => `- ${f.job}${f.url ? ` (${f.url})` : ""}`).join("\n")}`, OUTCOME_CODES.CI_RED) };
        }
        ciRounds++; fixes++;
        T.decisions.push(`CI verification red (${jobs}); builder resumed with the failed logs (round ${ciRounds}/${vcfg.maxRounds})`);
        ev({ event: "CI_FIX_ROUND", trigger, round: ciRounds, jobs: v.failures.map((f) => f.job) });
        await fixRound("ci", ciFailurePrompt(v.failures, vcfg.mode), [], "ci_red", failureLog(v.failures));
        await upsertStage("implementation");
        result = (await readResult()) ?? result;
        if (String(await git(["rev-parse", "HEAD"])).trim() === head) {
          return { done: await needsHuman(`CI verification failed on \`${branch}\` (${jobs}) and the builder made no new commit for it; nothing merged.`, OUTCOME_CODES.CI_RED) };
        }
      }
    }

    // ---- 4. conformance: typed amendments, deterministic precheck, structured review; the engine computes the verdict ----
    // enforce: every failure class blocks (one builder resume, then needs-human). shadow: the verdict is computed and posted,
    // but only what the previous reviewer enforced blocks (a review that finds a requirement not implemented, or a regression),
    // plus the precheck's equivalent: a failed validate command or a requirement the builder reported as not done (#4160).
    // A review without usable rows ends needs-human (or, with engine.review_incomplete: degraded, merges flagged).
    await label("in-review");
    let shadow = conformance !== "enforce";
    let effective = frozen, review = null, lastAmend = "", resumes = 0, verdict = null, degraded = null, triggerSkipped = false, selfReviewCompared = false;
    const TRIGGER_SKIP = "skipped (review.trigger enforce: no risk trigger)";
    const triggerSkipNote = "## Conformance Review\n**Skipped by `review.trigger: enforce`:** no risk path, package edge or hotspot in the diff, and every deterministic gate passed; no reviewer ran (#4273).";
    async function amend() {
      const a = applyAmendments(frozen, result?.amendments, issueText);
      const sig = JSON.stringify(a.applied);
      if (a.applied.length && sig !== lastAmend) {
        lastAmend = sig;
        await post("FORGE:AMENDMENT", renderAmendments(a.applied));
        T.decisions.push(`Contract amended: ${a.applied.map((x) => `${x.kind} ${x.target}`).join(", ")}`);
      }
      effective = a.contract;
      return a.problems.map((d) => ({ code: OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED, detail: d }));
    }
    const IGNORE = [`${LEAN_DIR}/`];
    /** Up to two reviewer runs; a reply without usable rows (unparseable, incomplete, inconsistent) is re-asked, never charged to the builder. */
    async function reviewOnce() {
      const diff = String(await git(["diff", `${base}...HEAD`]));
      const stat = Buffer.byteLength(diff, "utf-8") > REVIEW_DIFF_MAX_BYTES ? String(await git(["diff", "--stat=200", `${base}...HEAD`]).catch(() => "")) : "";
      const listed = new Set(String(await git(["ls-files"]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean));
      const ctx = { contract: effective, changedFiles: files, issueText, pathExists: (x) => listed.has(x), repoFiles: listed, ignore: IGNORE };
      let d = null, first = null;
      for (let t = 0; t < 3; t++) {
        // #4327: a third run only when the repaired reply is incomplete solely by evidence paths that did not resolve.
        if (t === 2) {
          if (d.state !== "review.incomplete" || !evidencePathOnly(d.failures.map((f) => f.detail))) break;
          T.decisions.push(`Review incomplete only by unresolved evidence paths (${(d.missing ?? []).join(", ")}); reviewer re-asked once more`);
        }
        // #4160: a reply with rows missing is re-asked for those ids only; an unparseable one gets the full prompt again.
        const repair = first && (d.state === "review.incomplete" || d.state === "review.inconsistent");
        await renew();
        const rr = await callRunner({ role: "reviewer", issue, cwd: wt, model: reviewerModel, resume: null, system: REVIEWER_SYSTEM, readOnly: true,
          prompt: repair ? reviewerRepairPrompt({ missing: d.missing ?? [], problems: d.failures.map((f) => f.detail), rows: first })
            : reviewerPrompt({ issue: iss, comments: trustedComments, contract: effective, result, files, diff, stat, base, structure: structureLine, ignore: IGNORE }) });
        await renew();
        await attempt("review", ++reviewN, rr, null, "review");
        const parsed = parseReview(rr?.text);
        review = repair ? mergeReviewRows(first, parsed) : parsed;
        first = review;
        d = decide(review, ctx);
        if (d.review) review = d.review;
        ev({ event: "CONFORMANCE", round: reviewN, state: d.state, failures: d.failures.map((x) => x.code), mode: shadow ? "shadow" : "enforce" });
        const cmp = selfReviewCompared ? null : compareSelfReview(readSelfReview(result), d); // #4374: once, on the first judgement
        if (cmp) { selfReviewCompared = true; ev({ event: cmp.agreed ? "SELF_REVIEW_AGREED" : "SELF_REVIEW_DISAGREED", reviewer: cmp.reviewer, self_no: cmp.self_no, failures: d.failures.map((x) => x.code) }); }
        if (!d.state.startsWith("review.")) return d;
      }
      return d;
    }
    /**
     * #4397: one independent adversarial verifier call per head: fresh context, read-only, never the builder's model, result
     * or notes. Returns the failures to enforce ([] in shadow, on an empty diff or on a verifier error, which is an anomaly).
     */
    const verifiedHeads = new Map();
    let verifierRun = null, verifyN = 0;
    async function runVerifier() {
      const head = String(await git(["rev-parse", "HEAD"])).trim();
      if (verifiedHeads.has(head)) return verifiedHeads.get(head);
      const diff = String(await git(["diff", `${base}...HEAD`]));
      const run = { mode: verifierCfg.mode, head, findings: [], model: null, swapped: false, cost_usd: 0 };
      if (!diff.trim()) run.skipped = "empty_diff";
      else {
        const bytes = Buffer.byteLength(diff, "utf-8");
        const stat = bytes > REVIEW_DIFF_MAX_BYTES ? String(await git(["diff", "--stat=200", `${base}...HEAD`]).catch(() => "")) : "";
        const listed = new Set(String(await git(["ls-files"]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean));
        const callers = await callersOf({ symbols: changedSymbols(diff), gitGrep: git, ignore: IGNORE });
        Object.assign(run, pickVerifierModel({ configured: verifierCfg.model, builderModel, builderReported: [...impl.models] }));
        const { maxMs, maxTurns } = verifierBudget(bytes);
        try {
          await renew();
          const rr = await callRunner({ role: "verifier", issue, cwd: wt, model: run.model, resume: null, system: VERIFIER_SYSTEM, readOnly: true, maxMs, maxTurns,
            prompt: verifierPrompt({ issue: iss, comments: trustedComments, contract: effective, diff, stat, base, files, callers }) });
          await renew();
          await attempt("verify", ++verifyN, rr, null, "verifier");
          run.findings = parseVerifierFindings(rr?.text, { pathExists: (x) => listed.has(x) });
          run.cost_usd = num(rr?.costUsd) ?? 0;
        } catch (e) {
          if (e?.deferUsageLimit) throw e;
          run.error = String(e?.code || e?.message || e).split("\n")[0].slice(0, 200);
          T.anomalies.push(`Independent verifier failed at ${head.slice(0, 12)}: ${run.error}`);
        }
      }
      const failures = verifierCfg.mode === "enforce" ? findingsToFailures(run.findings) : [];
      ev({ event: "VERIFIER", mode: run.mode, head, model: run.model, swapped: run.swapped, findings: run.findings.length, cost_usd: run.cost_usd, implement_cost_usd: impl.cost,
        ratio: impl.cost > 0 ? Math.round((run.cost_usd / impl.cost) * 1000) / 1000 : null, ...(run.skipped ? { skipped: run.skipped } : {}), ...(run.error ? { error: run.error } : {}) });
      if (run.findings.length) T.decisions.push(`Independent verifier (${run.mode}) found ${run.findings.length} defect(s): ${run.findings.slice(0, 3).map((f) => `${f.file}:${f.line}`).join(", ")}`);
      verifiedHeads.set(head, failures);
      verifierRun = run;
      return failures;
    }
    const verifierSection = () => { const n = renderVerifierNote(verifierRun); return n ? `\n\n${n}` : ""; };
    /** #4323: rerun once each validate command the builder recorded as failed, with the lane env; {[id]: {rc, output}} or null. */
    async function rerunFailedValidates(contract) {
      if (!io.runCommand) return null;
      const runs = Array.isArray(result?.validation) ? result.validation : [], out = {};
      const env = laneEnv();
      for (const v of contract.validate ?? []) {
        const r = runs.find((x) => x?.id === v.id);
        if (!r || r.exit === undefined || r.exit === 0) continue;
        let x;
        try { x = await heavyStep("precheck", () => io.runCommand({ command: String(v.command), cwd: wt, timeoutMs: vcfg.precheckTimeoutSeconds * 1000, env })); } catch (e) { x = { rc: 127, output: String(e?.message ?? e) }; }
        out[v.id] = { rc: Number.isInteger(x?.rc) ? x.rc : 1, output: String(x?.output ?? "") };
      }
      if (Object.keys(out).length) ev({ event: "VALIDATE_RERUN", runs: Object.entries(out).map(([id, x]) => ({ id, rc: x.rc })) });
      return out;
    }
    /** Precheck then review, on the current result and changed files (also the base-sync re-review). */
    async function gate() {
      await refreshIssue("conformance");
      result = (await readResult()) ?? result;
      files = await changedFiles();
      gateRan = true;
      // #4398: a diff touching a declared review.risk_paths glob makes this lane enforce from here on (sticky)
      const hits = shadow ? riskPathHits(files, riskPaths) : [];
      if (hits.length) {
        shadow = false; riskEnforced = hits;
        ev({ event: "CONFORMANCE_RISK_ENFORCED", paths: hits });
        T.decisions.push(`Conformance enforced (review.risk_paths): ${hits.slice(0, 10).join(", ")}${hits.length > 10 ? ` and ${hits.length - 10} more` : ""}`);
      }
      const amendProblems = await amend();
      const ciVerified = remoteVerify && ciVerifiedHead !== null && ciVerifiedHead === String(await git(["rev-parse", "HEAD"])).trim();
      const hotspots = await hotspotsOf({ base, paths: files });
      const validateRuns = await rerunFailedValidates(effective);
      const repoHas = validateRuns && Object.keys(validateRuns).length ? repoTracks(String(await git(["ls-files"]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean)) : undefined;
      const pc = precheck({ contract: effective, result, changedFiles: files, ignore: IGNORE, ciVerified, hotspots, repro: await reproOf(effective), validateRuns, repoHas, frozen });
      // #4350: a scope-check validate stale only by amended deliverables is judged by the engine's scope gate instead
      if (pc.superseded?.length) {
        ev({ event: "VALIDATE_SUPERSEDED", runs: pc.superseded });
        const note = `Scope-check validate ${pc.superseded.map((x) => x.id).join(", ")} superseded by the scope gate (amended: ${[...new Set(pc.superseded.flatMap((x) => x.files))].join(", ")})`;
        if (!T.decisions.includes(note)) T.decisions.push(note);
      }
      Object.assign(verifyFacts, { precheck: pc.failures, amendments: amendProblems, hotspots: Boolean(hotspots && hotspots.enabled !== false && Array.isArray(hotspots.files)) });
      // #4323/#4334: a missing host tool or module, or a repro test the harness could not run, is an environment error:
      // never a conformance failure, never a builder resume
      const envFails = pc.failures.filter((f) => ENV_CODES.includes(f.code));
      const pre = [...pc.failures.filter((f) => !ENV_CODES.includes(f.code)), ...amendProblems];
      if (pre.length) ev({ event: "PRECHECK", failures: pre.map((f) => f.code) });
      if (pre.length && !shadow) return { state: "nonconforming", by: "precheck", failures: pre };
      // shadow: the builder's own failed checks block before any reviewer tokens are spent (#4160)
      const hard = shadow ? pre.filter((f) => SHADOW_PRE_BLOCKS.includes(f.code)) : [];
      if (hard.length) return { state: "nonconforming", by: "precheck", failures: hard, would: "nonconforming", wouldFail: pre, reviewState: null };
      if (envFails.length) return { state: "environment", by: "precheck", failures: envFails };
      // #4273: deterministic review trigger; off computes nothing, shadow logs and always reviews, enforce skips when untriggered
      if (triggerMode !== "off") {
        let t = null;
        try { t = computeTrigger({ files, riskPaths, structure, hotspots, gates: { precheckFailures: pre, checkCommandsFailing, ciFellBack }, contract: effective }); } catch { /* fall back to reviewing */ }
        const skip = triggerMode === "enforce" && t?.would_skip === true;
        ev({ event: "REVIEW_TRIGGER", mode: triggerMode, would_skip: t ? t.would_skip : false, reasons: t ? t.reasons.map((r) => r.code) : ["trigger.error"], skipped: skip });
        if (skip) {
          triggerSkipped = true;
          return { state: "conforms", by: "trigger", failures: [], ...(shadow ? { would: "conforms", wouldFail: [], reviewState: null } : {}) };
        }
        triggerSkipped = false;
      }
      let d = await reviewOnce();
      // #4397: the verifier runs only on a change every gate and the reviewer passed; in enforce its findings block
      if (verifierCfg.mode !== "off" && d.state === "conforms" && !pre.length) {
        const vf = await runVerifier();
        if (vf.length) d = { state: "nonconforming", failures: vf, by: "verifier" };
      }
      if (!shadow) return { ...d, by: d.by ?? "review" };
      // shadow: record what enforce would have done; block only on what the previous reviewer blocked on
      const would = d.state === "conforms" && !pre.length ? "conforms" : d.state.startsWith("review.") ? d.state : "nonconforming";
      const wouldFail = [...pre, ...(d.state === "conforms" ? [] : d.failures)];
      if (d.state.startsWith("review.")) return { ...d, by: "review", would, wouldFail, reviewState: d.state };
      const blocking = d.state === "nonconforming" ? d.failures.filter((f) => SHADOW_BLOCKS.includes(f.code)) : [];
      return { state: blocking.length ? "nonconforming" : "conforms", by: d.by ?? "review", failures: blocking, would, wouldFail, reviewState: d.state };
    }
    const verifyReported = new Set();
    /**
     * #4270 verify.check_run: one `forgedock/verify` check run per pushed head, reporting the gates' last results (no gate
     * logic, never blocks). Off: no call, no event. A missing seam or a Checks API failure is an anomaly, never a lane failure.
     */
    async function reportVerify() {
      if (vcfg.checkRun !== true) return;
      let head = "";
      try { head = String(await git(["rev-parse", "HEAD"])).trim(); } catch { return; }
      if (!head || verifyReported.has(head)) return;
      verifyReported.add(head);
      const r = verifyReport({ head, ...verifyFacts, contract: effective, result });
      let posted = false, url = null, error = null;
      try {
        if (!io.createCheckRun) throw new Error("no Checks API seam");
        const c = await io.createCheckRun({ sha: head, name: VERIFY_CHECK_NAME, conclusion: r.conclusion, title: r.title, summary: r.summary, text: r.text });
        posted = true; url = c?.html_url ?? null;
      } catch (e) {
        error = String(e?.stderr || e?.message || e).split("\n")[0].slice(0, 200);
        T.anomalies.push(`${VERIFY_CHECK_NAME} check run not posted for ${head.slice(0, 12)}: ${error}`);
      }
      ev({ event: "VERIFY", head, conclusion: r.conclusion, gates: r.gates.map((g) => ({ id: g.id, ok: g.ok })), posted, url, ...(error ? { error } : {}) });
    }
    /** #4323: a validate command the host could not run ends needs-human env.tool_missing (recoverable), never a builder resume. */
    // #4334: a repro test the harness could not run on head (and nothing else) ends env.repro_unrunnable (recoverable)
    async function envNeedsHuman(failures) {
      if (failures.every((f) => f.code === OUTCOME_CODES.ENV_REPRO_UNRUNNABLE)) {
        T.anomalies.push("Environment error: the repro harness could not run the repro test on head");
        return await needsHuman(`Environment error (not a conformance failure): the repro harness could not run the repro test on head; no builder resume was spent and nothing merged:\n${failures.map((f) => `- ${f.code}: ${f.detail}`).join("\n")}\n\nRun the repro command through the repo's own toolchain and installed dependencies, then rerun.`, OUTCOME_CODES.ENV_REPRO_UNRUNNABLE);
      }
      const tools = [...new Set(failures.filter((f) => f.tool).map((f) => f.tool))].join(", ");
      T.anomalies.push(`Environment error: validate command(s) could not run, the host is missing ${tools}`);
      return await needsHuman(`Environment error (not a conformance failure): the host is missing ${tools}, so validate command(s) could not run; no builder resume was spent and nothing merged:\n${failures.map((f) => `- ${f.code}: ${f.detail}`).join("\n")}\n\nInstall it on the host or run the check through the repo's own toolchain, then rerun.`, OUTCOME_CODES.ENV_TOOL_MISSING);
    }
    /** Shape the base-sync path expects: {unusable: state} when no usable review, {env: failures} for a missing host tool, else {fail, verdict, reason, failures}. */
    const doReview = async () => {
      const d = await gate();
      if (d.state === "environment") return { env: d.failures };
      if (d.state.startsWith("review.")) return { unusable: d.state, failures: d.failures };
      return { fail: d.state !== "conforms", verdict: d.state === "conforms" ? "CONFORMS" : "NONCONFORMING", reason: d.failures.map((f) => `${f.code}: ${f.detail}`).join("; "), failures: d.failures };
    };
    let degradedReq = null;
    if (isSplit) {
      // #4211: location-only change proved by refactor-verify; no conformance reviewer (the optional review is not spent)
      if (remoteVerify) { const v = await ciVerify("build"); if (v.done) return v.done; }
      T.review = "skipped (refactor-verify passed: location-only change)";
    } else {
      for (;;) {
        if (remoteVerify) { const v = await ciVerify("build"); if (v.done) return v.done; }
        const outcome = await gate();
        verdict = outcome;
        for (const f of [...(outcome.failures ?? []), ...(outcome.wouldFail ?? [])]) if (f?.code) failureClasses.add(f.code);
        if (outcome.state === "conforms") { await gatePassed("conformance"); break; }
        const explained = explainFailures(outcome.failures, effective); // #4265: name the unmet requirement, not only the code
        const list = explained.slice(0, 15).map((f) => `- ${f.code}: ${f.detail}`).join("\n");
        if (outcome.state === "environment") return await envNeedsHuman(outcome.failures);
        if (outcome.state === "review.unparseable") return await needsHuman(`The conformance reviewer returned no parseable JSON twice; nothing merged.`, OUTCOME_CODES.REVIEW_NO_VERDICT);
        if (shadow && reviewIncomplete === "degraded" && (outcome.state === "review.incomplete" || outcome.state === "review.inconsistent")) {
          degraded = { state: outcome.state, missing: outcome.missing ?? [] };
          T.decisions.push(`Review degraded (${outcome.state} after the targeted re-ask${degraded.missing.length ? `: ${degraded.missing.join(", ")}` : ""}); merging with label ${REVIEW_DEGRADED_LABEL} and a tracked follow-up`);
          break;
        }
        if (outcome.state === "review.incomplete") return await needsHuman(`The conformance review was incomplete twice (a review without complete rows cannot pass); nothing merged:\n${list}`, OUTCOME_CODES.REVIEW_INCOMPLETE);
        if (outcome.state === "review.inconsistent") return await needsHuman(`The conformance reviewer twice said NONCONFORMING without a failing row; nothing merged.`, OUTCOME_CODES.REVIEW_INCONSISTENT);
        if (resumes >= 1 || !sessionId) return await needsHuman(`The change does not conform to the issue and its frozen contract after ${resumes ? "one builder resume" : "the build (no session to resume)"} (${outcome.by}); nothing merged:\n${list}`, outcome.failures[0].code);
        resumes++;
        T.decisions.push(`Not conforming (${outcome.by}${outcome.inconsistent ? ", reviewer verdict contradicted its rows" : ""}): ${[...new Set(outcome.failures.map((f) => f.code))].join(", ")} (${explained.slice(0, 5).map((f) => String(f.detail).slice(0, 160)).join("; ")}); builder resumed once`);
        // A failed validate may only mean the base moved on: fetch the lane so the resume can merge it (never rebase).
        if (outcome.failures.some((f) => f?.kind === "validate_failed")) { try { await io.git(["fetch", "origin", lane], { cwd: wt }); } catch { /* offline: the resume uses the local ref */ } }
        await fixRound("conformance", conformanceResumePrompt(outcome.failures, vcfg.mode, lane), outcome.failures, "conformance", failureLog(outcome.failures));
        await upsertStage("implementation"); // the published note follows the code after every resume
      }
      // Deferrals the reviewer accepted are filed now, before any PR: the batched follow-up must exist and be linked.
      const toFile = pendingTracking(effective);
      if (toFile.length) await track(toFile, "accepted by the conformance review");
      degradedReq = degraded ? { id: "REVIEW", quote: `conformance review ${degraded.state}: re-run the review`, disposition: "defer", why: `${REVIEW_DEGRADED_LABEL}: rows still missing for ${degraded.missing.join(", ") || "the verdict"}` } : null;
      if (degradedReq) await track([degradedReq], "the conformance review stayed incomplete");
      if (triggerSkipped) {
        T.decisions.push("Conformance reviewer skipped by review.trigger enforce: no trigger reason (risk path, package edge, hotspot, failed or ambiguous gate)");
        if (shadow) {
          shadowWould = verdict.would;
          ev({ event: "CONFORMANCE_SHADOW", would: verdict.would, failures: [] });
          await emit({ event: "CONFORMANCE_SHADOW", would: verdict.would, failures: [] });
        }
        T.review = [TRIGGER_SKIP, `${reviewN} reviewer run(s), ${resumes + 1} round(s)`];
        await post("FORGE:REVIEW", triggerSkipNote);
      } else if (shadow) {
        const wf = verdict.wouldFail ?? [];
        shadowWould = verdict.would;
        ev({ event: "CONFORMANCE_SHADOW", would: verdict.would, failures: wf.map((f) => f.code) });
        await emit({ event: "CONFORMANCE_SHADOW", would: verdict.would, failures: wf.map((f) => f.code) });
        T.review = [`shadow: would ${verdict.would === "conforms" ? "pass" : `block (${verdict.would})`}`, `${reviewN} reviewer run(s), ${resumes + 1} round(s)`];
        await post("FORGE:REVIEW", renderShadowReview({ would: verdict.would, failures: wf, review: verdict.reviewState === "conforms" || verdict.reviewState === "nonconforming" ? review : null, contract: effective, degraded: degradedReq?.tracked ?? (degraded ? "untracked" : null) }) + verifierSection());
      } else {
        T.review = ["CONFORMS", `${reviewN} reviewer run(s), ${resumes + 1} round(s)`];
        await post("FORGE:REVIEW", renderReview(review, effective) + verifierSection());
      }
    }
    ev({ event: "PHASE_COMMIT", phase: "review" });
    const closing = closePlan(effective, { title: iss.title, review });
    if (closing.reason === "partial") { // #4398: an investigation whose question is not answered carries it forward
      const untracked = closing.open.filter((r) => !r.tracked);
      if (untracked.length) {
        const carried = untracked.map((r) => ({ ...r, disposition: "defer", why: "investigation question not answered" }));
        await track(carried, "the investigation's question is not answered");
        for (const [i, r] of untracked.entries()) r.tracked = carried[i].tracked;
      }
      for (const t of closing.open.map((r) => r.tracked).filter(Boolean)) if (!closing.tracked.includes(t)) closing.tracked.push(t);
      T.decisions.push(`Investigation not answered (${closing.open.map((r) => r.id).join(", ")}): closing as partial, carried forward in ${closing.tracked.join(", ")}`);
    }
    if (degradedReq?.tracked && !closing.tracked.includes(degradedReq.tracked)) closing.tracked.push(degradedReq.tracked);

    // ---- 5. push + PR ----
    files = await changedFiles();
    await gitPush(["push", "-u", "origin", branch]);
    laneGuard(lane, "open a PR");
    const prOut = resumed?.pr ? `/pull/${resumed.pr}` : String(await ghw(["pr", "create", "-R", repo, "--base", lane, "--head", branch,
      "--title", `${iss.title} (#${issue})`, "--body", isSplit ? (o.refactorModule ?? (await import("./refactor.mjs"))).renderSplitPrBody({ issue, ...split })
        : renderPrBody({ issue, investigation: await readStage(STAGES[0]), contract: effective, implementation: await readStage(STAGES[1]), result, gitFiles: files, tracked: closing.tracked })])).trim();
    const pr = Number(/\/pull\/(\d+)/.exec(prOut)?.[1] ?? /(\d+)\s*$/.exec(prOut)?.[1]);
    if (!Number.isInteger(pr)) return await needsHuman(`Could not parse the PR number from: ${prOut.slice(0, 200)}`);
    ev({ event: "PR_OPENED", pr });
    if (resumed?.pr && closing.tracked.length) { // an existing PR still has to link the tracking issues visibly
      try { await ghw(["pr", "edit", String(pr), "-R", repo, "--body", renderPrBody({ issue, investigation: await readStage(STAGES[0]), contract: effective, implementation: await readStage(STAGES[1]), result, gitFiles: files, tracked: closing.tracked })]); }
      catch (e) { e.deferCode = OUTCOME_CODES.FOLLOWUP_UNAVAILABLE; e.deferDetail = `could not link the tracking issues on PR #${pr}; nothing merged, rerun to retry`; throw e; }
    }
    if (degraded) {
      try { await ghw(["label", "create", REVIEW_DEGRADED_LABEL, "-R", repo, "--force", "--color", "FBCA04", "--description", "Merged with an incomplete conformance review. Managed by ForgeDock."]); } catch { /* exists, or no rights: the edit below says */ }
      try { await ghw(["pr", "edit", String(pr), "-R", repo, "--add-label", REVIEW_DEGRADED_LABEL]); }
      catch (e) { e.deferCode = OUTCOME_CODES.FOLLOWUP_UNAVAILABLE; e.deferDetail = `could not label PR #${pr} ${REVIEW_DEGRADED_LABEL}; nothing merged, rerun to retry`; throw e; }
    }
    T.pr = [`#${pr}`, resumed?.pr ? "existing" : "opened"];
    const prUrl = /https?:\/\/\S+/.exec(prOut)?.[0] ?? `https://github.com/${repo}/pull/${pr}`;
    let localHead = String(await git(["rev-parse", "HEAD"])).trim();
    await reportVerify();

    // ---- 6. merge policy: required (default) | all | none ----
    let policy = mergeWait, required = [];
    if (mergeWait === "required") {
      try { required = (await io.requiredChecks?.(lane)) ?? []; } catch { required = []; }
    }
    const policyText = mergeWait === "required" ? (required.length ? `required (${required.join(", ")})` : "required (no required checks: merged right after review)") : mergeWait;
    T.merge = [policyText, "waiting"];
    T.decisions.push(`merge_wait=${mergeWait}: ${policyText}`);

    // ---- base-sync (#4100): merge the lane into the branch when the PR conflicts; merge only, never rebase or force-push ----
    let syncs = 0, mergeRetries = 0;
    const MAX_SYNCS = 2;
    const gitOut = async (args) => { try { return String(await git(args)).trim(); } catch { return ""; } };
    /** CONFLICTING / DIRTY, or UNKNOWN after one short re-poll. Unreadable state counts as not conflicting. */
    const prConflicting = async () => {
      for (let i = 0; i < 2; i++) {
        let j;
        try { j = JSON.parse(String(await ghc(["pr", "view", String(pr), "-R", repo, "--json", "mergeable,mergeStateStatus"])) || "{}"); } catch { return false; }
        const m = String(j.mergeable ?? "").toUpperCase(), st = String(j.mergeStateStatus ?? "").toUpperCase();
        if (m === "CONFLICTING" || st === "DIRTY") return "conflict";
        if (m !== "UNKNOWN") return false;
        if (i === 0) await sleep(2000);
      }
      return "unknown";
    };
    /** #4158: MERGEABLE but BLOCKED is a base branch policy block (ruleset / required checks pending), not a conflict. */
    const policyBlocked = async () => {
      let j;
      try { j = JSON.parse(String(await ghc(["pr", "view", String(pr), "-R", repo, "--json", "mergeable,mergeStateStatus"])) || "{}"); } catch { return false; }
      return String(j.mergeable ?? "").toUpperCase() === "MERGEABLE" && String(j.mergeStateStatus ?? "").toUpperCase() === "BLOCKED";
    };
    /** #4266: one mergeability read inside the CI wait: "conflict", "mergeable", or null (unknown / unreadable / other). */
    const waitMergeState = async () => {
      let j;
      try { j = JSON.parse(String(await ghc(["pr", "view", String(pr), "-R", repo, "--json", "mergeable,mergeStateStatus"])) || "{}"); } catch { return null; }
      const m = String(j.mergeable ?? "").toUpperCase(), st = String(j.mergeStateStatus ?? "").toUpperCase();
      return m === "CONFLICTING" || st === "DIRTY" ? "conflict" : m === "MERGEABLE" ? "mergeable" : null;
    };
    let blockStartedAt = null, blockPollIndex = 0;
    const conflictFiles = async () => (await gitOut(["diff", "--name-only", "--diff-filter=U"])).split("\n").map((x) => x.trim()).filter(Boolean);
    const unresolved = async () => (await conflictFiles()).length > 0 || (await gitOut(["grep", "-n", "-e", "^<<<<<<< ", "-e", "^>>>>>>> "])) !== ""
      || (await gitOut(["diff", "--check"])) !== "" || (await gitOut(["rev-parse", "-q", "--verify", "MERGE_HEAD"])) !== "";
    const syncRow = [];
    /** Returns null to continue with the merge flow, or a terminal result. */
    async function baseSync(trigger, soft = false) {
      if (syncs >= MAX_SYNCS) return await needsHuman(`PR #${pr} still conflicts with ${lane} after ${MAX_SYNCS} base-syncs (${trigger}).`, OUTCOME_CODES.BASE_CONFLICT);
      syncs++;
      await renew();
      try { await git(["fetch", "origin", lane]); } catch { /* offline: use the local ref */ }
      const baseSha = (await gitOut(["rev-parse", base])).slice(0, 12);
      const before = await gitOut(["rev-parse", "HEAD"]);
      let clean = true, files = [];
      try { await git(["merge", "--no-edit", base]); } catch { clean = false; files = await conflictFiles(); }
      if (isSplit && !clean) { // #4211: no builder resolves a split's conflicts; a fresh run re-splits on the new base
        await gitOut(["merge", "--abort"]);
        return await needsHuman(`PR #${pr} (refactor:split) conflicts with ${lane} in ${files.join(", ") || "unknown files"}; a split is never resolved by an LLM. Close the PR and rerun on the new base.`, OUTCOME_CODES.BASE_CONFLICT);
      }
      let how, tests = "not required (clean merge)", rereview = "not required (conflict-free base merge)";
      if (clean) {
        how = "clean merge of the base into the branch";
      } else {
        T.decisions.push(`Base-sync ${syncs}: merging ${base} conflicts in ${files.join(", ") || "unknown files"}; builder resolves`);
        const prompt = `Merging ${base} into this branch conflicts in: ${files.join(", ") || "(see git status)"}. Resolve the conflicts preserving both this fix's intent and the base's changes, ${syncChecks(vcfg.mode)}, and commit the merge.${sequenceSyncNote(files)} Do not push.`;
        await builder(++attemptN, prompt, sessionId ?? null, false, undefined, { trigger: "recovery" }); // #4362: base-sync conflict
        if (await unresolved()) {
          await gitOut(["merge", "--abort"]);
          return await needsHuman(`Base-sync could not resolve the conflicts in ${files.join(", ")} (conflict markers or an unfinished merge remain).`, OUTCOME_CODES.BASE_CONFLICT);
        }
        how = `builder resolved ${files.length} conflicted file(s) and committed the merge`;
        const r2 = await readResult();
        tests = Array.isArray(r2?.tests) && r2.tests.length ? r2.tests.map((t) => (typeof t === "string" ? t : `${t.command}: ${t.result}`)).join("; ") : NR_TESTS;
      }
      const sq = await sequenceHandoff(`base-sync ${syncs}`); // #4322: a clean text merge can still bring a taken number
      if (sq?.done) return sq.done;
      if (sq?.renumbered) { how += "; builder renumbered sequence-numbered files"; }
      const after = await gitOut(["rev-parse", "HEAD"]);
      if (soft && clean && after === before) { syncs--; return null; } // UNKNOWN state and nothing to merge: not a conflict
      if (after !== before) await gitPush(["push", "origin", branch]); // plain push of a merge commit: never force
      let ciFixes = 0;
      if (isSplit && after !== before) { // #4211: the merged head must still be a pure move against the new base
        const rv = await (o.refactorModule ?? (await import("./refactor.mjs"))).reverifySplit({ wt, base, target: split.target, testCmd: split.testCmd, runTmp, git });
        if (!rv.ok) return await needsHuman(`refactor:split no longer verifies after merging ${base}: ${rv.reason}`, rv.code);
        rereview = "refactor-verify re-run against the new base: ok";
      }
      if (remoteVerify && after !== before) { const v = await ciVerify("base-sync"); if (v.done) return v.done; ciFixes = v.fixes; }
      if (!isSplit && (!clean || sq?.renumbered || ciFixes)) {
        let rv = await doReview();
        if (rv.env) return await envNeedsHuman(rv.env);
        if (rv?.fail) {
          T.decisions.push(`Base-sync re-review FAIL: builder resumed with the reason`);
          await fixRound("review", conformanceResumePrompt(rv.failures, vcfg.mode), rv.failures, "review", failureLog(rv.failures));
          if (await unresolved()) return await needsHuman("Base-sync re-review fix left conflict markers.", OUTCOME_CODES.BASE_CONFLICT);
          if ((await gitOut(["rev-parse", "HEAD"])) !== after) await gitPush(["push", "origin", branch]);
          rv = await doReview();
          if (rv.env) return await envNeedsHuman(rv.env);
        }
        if (rv.unusable) return await needsHuman(`Reviewer returned no usable review after base-sync (${rv.unusable}).`, UNUSABLE_REVIEW_CODES[rv.unusable]);
        if (rv.fail) return await needsHuman(`Review FAIL after base-sync: ${rv.reason}`, OUTCOME_CODES.REVIEW_FAILED);
        await gatePassed("review");
        rereview = `${rv.verdict}: ${rv.reason || "no concrete failure"}`;
      }
      localHead = await gitOut(["rev-parse", "HEAD"]);
      await reportVerify();
      syncRow.push(`${trigger}: ${clean ? "clean" : "conflicts"} (${baseSha})`);
      T.baseSync = [`${syncs} sync(s)`, syncRow.join("; ")];
      await post("FORGE:BASE_SYNC", `## Base Sync\n**Trigger:** ${trigger}\n**Base merged:** \`${base}\` at \`${baseSha}\`\n**Result:** ${clean ? "clean merge" : `conflicts in ${files.map((f) => `\`${f}\``).join(", ") || "unknown files"}`}\n**Resolution:** ${how}\n**Tests run:** ${tests}\n**Re-review:** ${rereview}\n**New head:** \`${localHead.slice(0, 12)}\``);
      return null;
    }
    const NR_TESTS = "not reported";
    /**
     * #4240: a required check failed at merge (any verify mode). One CI fix round in the builder session with the failed
     * logs, shared with ciVerify's verify.max_rounds budget; the fixed head is re-reviewed and pushed, then the wait restarts.
     * Returns null to wait again, or a terminal result (rounds exhausted, no session, no new commit, review failure).
     */
    async function mergeFixRound(checks) {
      const jobs = checks.map((c) => c.name);
      if (ciRounds >= vcfg.maxRounds || !sessionId) {
        return await needsHuman(`Required check(s) failed on PR #${pr}: ${jobs.join(", ")}${ciRounds ? ` (after ${ciRounds} CI fix round(s))` : ""}`, OUTCOME_CODES.CI_RED);
      }
      const failures = await collectFailedLogs(io, checks);
      ciRounds++;
      T.decisions.push(`Required check(s) failed on PR #${pr} (${jobs.join(", ")}); builder resumed with the failed logs (round ${ciRounds}/${vcfg.maxRounds})`);
      ev({ event: "CI_FIX_ROUND", trigger: "merge", round: ciRounds, jobs, pr });
      const before = await gitOut(["rev-parse", "HEAD"]);
      await fixRound("ci", ciFailurePrompt(failures, vcfg.mode), [], "merge_ci", failureLog(failures));
      await upsertStage("implementation");
      result = (await readResult()) ?? result;
      if ((await gitOut(["rev-parse", "HEAD"])) === before) {
        return await needsHuman(`Required check(s) failed on PR #${pr} (${jobs.join(", ")}) and the builder made no new commit for it; nothing merged.`, OUTCOME_CODES.CI_RED);
      }
      const rv = await doReview(); // never merge an unreviewed head
      if (!rv) return await needsHuman("Reviewer returned no parseable verdict after a CI fix round.", OUTCOME_CODES.REVIEW_NO_VERDICT);
      if (rv.env) return await envNeedsHuman(rv.env);
      if (rv.fail) return await needsHuman(`Review FAIL after a CI fix round: ${rv.reason}`, OUTCOME_CODES.REVIEW_FAILED);
      await gitPush(["push", "origin", branch]); // plain push of the fix commit: never force
      localHead = await gitOut(["rev-parse", "HEAD"]);
      await reportVerify();
      return null;
    }
    /** After the merge (#4179): delete the lane branch on origin; finish() deletes it locally after the worktree is gone. */
    async function deleteMergedBranch() {
      const skip = (why) => { ev({ event: "BRANCH_DELETE_SKIPPED", branch, why }); T.decisions.push(`Lane branch kept: ${why}`); };
      if (protectedBranch(branch)) return skip("protected branch name");
      for (const side of ["--head", "--base"]) {
        let open;
        try { open = JSON.parse(String(await ghc(["pr", "list", "-R", repo, side, branch, "--state", "open", "--json", "number"])) || "[]"); } catch { return skip("open-PR check failed"); }
        if (open.length) return skip(`open PR #${open[0].number} uses it as ${side.slice(2)}`);
      }
      deleteLocalBranch = true;
      try { await io.git(["push", "origin", "--delete", branch], { cwd }); ev({ event: "BRANCH_DELETED", branch, where: "origin" }); }
      catch (e) { ev({ event: "BRANCH_DELETE_FAILED", branch, where: "origin", error: String(e?.stderr ?? e?.message ?? e).slice(0, 300) }); }
    }

    /**
     * forge#4165: one STRUCTURE_DELTA telemetry record per merged run, from scripts/structure-delta.sh (the only place the
     * delta is computed) plus one local `git diff --numstat` for growth and the contract's decision provenance. Local git
     * only: the single telemetry write is the run's one extra API call. Also feeds the trajectory's Structure table.
     */
    async function recordStructure(pr) {
      const d = (await structureOf()) ?? {};
      const numstat = String(await git(["diff", "--numstat", "--no-renames", `${base}...HEAD`]).catch(() => ""));
      const top_growth = numstat.split("\n").map((l) => l.split("\t")).filter((x) => x.length >= 3 && /^\d+$/.test(x[0]) && Number(x[0]) > 0 && !x[2].startsWith(`${LEAN_DIR}/`))
        .map(([a, , file]) => ({ file, lines: Number(a) })).sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file)).slice(0, 5);
      const pairs = Array.isArray(d.import_pairs) ? d.import_pairs : [], sum = (k) => pairs.reduce((n, x) => n + (Number(x?.[k]) || 0), 0);
      const edge = (e) => ({ from: e?.from, to: e?.to });
      const s = {
        deps_added: (d.package_edges_added ?? []).map((e) => ({ ...edge(e), kind: e?.kind, manifest: e?.manifest })),
        deps_removed: (d.package_edges_removed ?? []).map((e) => ({ ...edge(e), kind: e?.kind, manifest: e?.manifest })),
        new_edges: pairs.filter((x) => x?.files_added > 0).map((x) => ({ ...edge(x), file: Array.isArray(x.files) ? x.files[0] ?? null : null, files: x.files_added })),
        removed_edges: pairs.filter((x) => x?.files_removed > 0).map((x) => ({ ...edge(x), files: x.files_removed })),
        top_growth,
        decisions: (Array.isArray(effective?.decisions) ? effective.decisions : []).filter((k) => k?.id).map((k) => ({ id: k.id, source: k.source ?? null })),
      };
      T.structure = s;
      const rec = { event: "STRUCTURE_DELTA", phase: "merge", pr, ...(milestone ? { milestone } : {}), ...s,
        edges_added: s.deps_added.length, edges_removed: s.deps_removed.length, import_files_added: sum("files_added"), import_files_removed: sum("files_removed"),
        boundary_changed: Boolean(d.boundary_config_changed?.changed), boundary_loosened: Boolean(d.boundary_config_changed?.loosens) };
      ev(rec);
      await emit(rec);
    }

    /**
     * #4403 e2e merge gate (e2e.mjs): a lane touching e2e specs or with [type:e2e] criteria runs the repo's e2e (label or
     * dispatch) on the reviewed head before merge. Returns null to merge, {again} after a fix round, or {done}.
     */
    let e2eHead = null;
    const e2eRuns = [];
    async function e2eGate() {
      const cur = await changedFiles(), want = e2eWanted({ cfg: vcfg.e2e, files: cur, contract: effective });
      if (!want.run) { if (want.reason === NO_TRIGGER && want.specs.length) T.decisions.push(`e2e not run: ${want.specs.length} e2e spec(s) changed but ${NO_TRIGGER}`); e2eHead = localHead; return null; }
      const v = await runE2eGate({ io: { ...io, addPrLabel: (n, l) => ghw(["pr", "edit", String(n), "-R", repo, "--add-label", l]) }, pr, branch, head: localHead, cfg: vcfg.e2e, specs: want.specs,
        changedFiles: cur, ciMaxMinutes, now, sleep, random, exclude: e2eRuns, onPoll: async () => { await renew(); onProgress({ event: "phase_paused", phase: "merge", detail: `e2e pending on PR #${pr}` }); } });
      if (v.runId != null) e2eRuns.push(v.runId);
      const own = v.result === "fail" ? (vcfg.e2e.blocking === "all" ? v.failures : ownFailures(v.failures, want.specs)) : [];
      const rec = { event: "E2E_VERIFY", pr, head: localHead, reason: want.reason, result: v.result, specs: want.specs, failures: v.failures.map((f) => f.job), own: own.map((f) => f.job), blocking: vcfg.e2e.blocking };
      ev(rec); await emit({ ...rec, phase: "merge" });
      T.decisions.push(`e2e (${want.reason}): ${v.result} at ${localHead.slice(0, 12)}${v.detail ? ` (${v.detail})` : ""}`);
      if (v.result === "timeout") return { done: await finish("ci-pending", `PR #${pr} e2e still pending after ${ciMaxMinutes} min`, { pr }) };
      if (v.result === "unavailable") return { done: await needsHuman(`e2e verification unavailable on PR #${pr} (${v.detail}); nothing merged.`) };
      if (own.length) { const r = await mergeFixRound(own.map((f) => ({ name: f.job, url: f.url }))); return r ? { done: r } : { again: true }; }
      if (v.result === "fail") T.anomalies.push(`Pre-existing e2e failure(s) reported, not blocking: ${v.failures.map((f) => f.job).join(", ")}`);
      e2eHead = localHead;
      return null;
    }

    // ---- 7. (sync) wait per policy, (sync) merge at the reviewed head ----
    // A rerun on an existing PR goes through the same conflict check, so a conflicting PR from an earlier run recovers.
    for (;;) {
      const c0 = await prConflicting();
      if (c0) { const r = await baseSync(c0 === "unknown" ? "PR mergeability unknown" : "PR is conflicting", c0 === "unknown"); if (r) return r; }
      if (policy === "none" || (policy === "required" && !required.length)) {
        // merge right after review
        T.merge = [policyText, "merged right after review"];
      } else {
        let startedAt = now();
        let pollIndex = 0, gateHead = null, conflicted = false, notStartedLogged = false;
        for (;;) {
          await renew();
          let states = [];
          // a rollup of another head (the PR before a fix push lands) counts as pending, never as this head's result
          const current = (x) => !x.head || !localHead || String(x.head).startsWith(localHead) || localHead.startsWith(String(x.head));
          if (policy === "all") {
            // #4270: the lane's own report-only check never gates its own merge
            const w = await io.waitCiGreen(pr, repo, 0, ...(vcfg.checkRun === true ? [{ ignore: [VERIFY_CHECK_NAME] }] : [])).catch(() => ({ rc: 2, text: "" }));
            if (w.rc === 0) { gateHead = /CI_GATE_HEAD:\s*([0-9a-f]{7,40})/.exec(w.text ?? "")?.[1] ?? null; break; }
            if (w.rc === 1) return await needsHuman(`Remote CI failed on PR #${pr}:\n${String(w.text).slice(-2000)}`, OUTCOME_CODES.CI_RED);
          } else {
            try { states = (await io.checkStates(pr)) ?? []; } catch { states = []; }
            const check = (n) => states.find((x) => x.name === n && current(x));
            const st = (n) => check(n)?.state ?? "pending";
            const failed = required.filter((n) => st(n) === "failure");
            if (failed.length) {
              const r = await mergeFixRound(failed.map((n) => ({ name: n, url: check(n)?.url ?? null })));
              if (r) return r;
              startedAt = now(); pollIndex = 0; // the fixed head gets the full wait budget
              continue;
            }
            if (required.every((n) => st(n) === "success")) break;
          }
          // #4266: a PR that turns conflicting gets no merge ref, so its pull_request workflows never start: base-sync now.
          const ms = await waitMergeState();
          if (ms === "conflict") { conflicted = true; break; }
          if (policy !== "all" && ms === "mergeable" && !notStartedLogged && now() - startedAt >= CI_NOT_STARTED_GRACE_MS
            && required.every((n) => !states.some((x) => x.name === n && current(x)))) {
            notStartedLogged = true;
            const minutes = Math.round((now() - startedAt) / 60000);
            ev({ event: "CI_NOT_STARTED", pr, checks: required, minutes });
            T.anomalies.push(`Required check(s) ${required.join(", ")} not started on PR #${pr} after ${minutes} min (missing workflow trigger?)`);
          }
          if (now() - startedAt >= ciMaxMinutes * 60000) {
            // Slow CI is never a needs-human: leave the PR open and resumable.
            ev({ event: "CI_PENDING_WAIT", state: "end", pr, result: "timeout" });
            T.anomalies.push("CI still pending at the wait budget");
            return await finish("ci-pending", `PR #${pr} still waiting on CI after ${ciMaxMinutes} min`, { pr });
          }
          onProgress({ event: "phase_paused", phase: "merge", detail: `CI pending on PR #${pr}` });
          await sleep(ciPollDelayMs(pollIndex++, random));
        }
        if (conflicted) {
          const r = await baseSync("PR became conflicting while waiting for CI"); if (r) return r;
          continue; // wait again on the synced head with a fresh budget
        }
        if (gateHead && !(localHead.startsWith(gateHead) || gateHead.startsWith(localHead))) {
          return await needsHuman(`CI passed for ${gateHead.slice(0, 12)} but the reviewed head is ${localHead.slice(0, 12)}; refusing to merge an unreviewed head.`, OUTCOME_CODES.MERGE_HEAD_MISMATCH);
        }
      }
      if (e2eHead !== localHead) { const g = await e2eGate(); if (g?.done) return g.done; if (g?.again) continue; }
      if (syncs > 0 && (await prConflicting()) === "conflict") continue; // the base moved again while waiting
      T.merge = [policyText, `merged at ${localHead.slice(0, 12)}`];
      laneGuard(resumed?.base ?? lane, "merge");
      try {
        await ghc(["pr", "merge", String(pr), "-R", repo, "--merge", "--match-head-commit", localHead]);
        break;
      } catch (e) {
        const msg = `${e?.stderr ?? ""}${e?.message ?? ""}`;
        if (MERGE_TRANSIENT_RE.test(msg) && !/not mergeable|merge conflict/i.test(msg)) {
          // "Base branch was modified", GraphQL and 5xx are transient: back off, then the loop top re-reads mergeable and the head.
          if (++mergeRetries > maxMergeRetries) return await finish("deferred", `gh pr merge kept failing transiently (${mergeRetries - 1} retries): ${msg.slice(0, 300)}`, { pr, code: OUTCOME_CODES.MERGE_TRANSIENT }, OUTCOME_CODES.MERGE_TRANSIENT);
          T.anomalies.push(`gh pr merge transient failure (retry ${mergeRetries}): ${msg.split("\n")[0].slice(0, 120)}`);
          await sleepFn(Math.min(60000, 1000 * 2 ** (mergeRetries - 1)) + Math.floor(random() * 250));
          continue;
        }
        if (await policyBlocked()) {
          // Policy block: wait and retry at the reviewed head; never base-sync, never base.conflict (#4158).
          if (blockStartedAt === null) {
            blockStartedAt = now();
            T.decisions.push("merge blocked by base branch policy (ruleset/required checks); waiting");
            T.anomalies.push(`gh pr merge blocked by base branch policy: ${msg.split("\n")[0].slice(0, 120)}`);
          }
          if (now() - blockStartedAt >= ciMaxMinutes * 60000) {
            T.merge = [policyText, "blocked by base branch policy"];
            return await finish("ci-pending", `PR #${pr} blocked by base branch policy after ${ciMaxMinutes} min (checks pending or ruleset requirement unmet)`, { pr });
          }
          onProgress({ event: "phase_paused", phase: "merge", detail: `PR #${pr} blocked by base branch policy` });
          await sleep(ciPollDelayMs(blockPollIndex++, random));
          await renew();
          continue;
        }
        if (!MERGE_CONFLICT_RE.test(msg)) throw e;
        const r = await baseSync("gh pr merge reported a conflict"); if (r) return r;
      }
    }
    try { await recordStructure(pr); } catch (e) { ev({ event: "STRUCTURE_DELTA_FAILED", error: String(e?.message ?? e).slice(0, 300) }); }
    await deleteMergedBranch();
    const partial = closing.reason === "partial";
    await ghw(["issue", "close", String(issue), "-R", repo, "--reason", partial ? "not planned" : "completed"]).catch(() => {});
    if (partial) {
      try { await post("FORGE:TRACKED", `## Closed as partial\nThe investigation's stated question is not answered in this change (PR #${pr}); carried forward in ${closing.tracked.join(", ")}.`); } catch { /* the PR body links them too */ }
    } else if (closing.tracked.length) {
      try { await post("FORGE:TRACKED", `## Remaining work tracked\nClosed as completed by PR #${pr}. The contracted deferred and post-deploy requirements are tracked in ${closing.tracked.join(", ")}.`); } catch { /* the PR body links them too */ }
    }
    if (isSplit && split.rest) { // #4211: the rest of a large split is the next PR of the chain, planned already (no grouping call)
      const mod = o.refactorModule ?? (await import("./refactor.mjs"));
      const c = mod.renderChainIssue({ parent: issue, target: split.target, packageName: split.packageName, rest: split.rest, testCmd: mod.parseTestCmd(iss.body ?? "", []) });
      try {
        const out = String(await ghw(["issue", "create", "-R", repo, "--title", c.title, "--body", c.body, ...c.labels.flatMap((l) => ["--label", l]), ...(milestone ? ["--milestone", milestone] : [])]));
        T.decisions.push(`refactor:split chain: ${Object.keys(split.rest).length} module(s) left, filed ${/\/issues\/(\d+)/.exec(out)?.[1] ? `#${/\/issues\/(\d+)/.exec(out)[1]}` : out.trim().slice(0, 120)}`);
      } catch (e) { T.anomalies.push(`refactor:split chain issue not filed (the maintenance scan re-files the hotspot): ${String(e?.message ?? e).slice(0, 200)}`); }
    }
    await label("merged");
    // forge#4161: the merge-time structure record and the milestone ride on the lane result for orchestrate's drift fold.
    await gatePassed("merge_ci", "ci_red"); // #4375: merged means the required checks are green after a CI fix round
    return await finish("merged", `PR #${pr}`, { pr, ...(partial ? { close: "partial" } : {}), structure: T.structure ?? null, ...(milestone ? { milestone } : {}), ...(lane ? { lane } : {}) });
  } catch (e) {
    if (e?.deferUsageLimit) {
      const when = e.resetAt || (Number.isFinite(e.resetAtEpochMs) ? new Date(e.resetAtEpochMs).toISOString() : "unknown");
      return finish("deferred", `usage limit hit; resets at ${when}`, { code: OUTCOME_CODES.RATE_LIMITED, resetAt: when, resetAtEpochMs: Number.isFinite(e.resetAtEpochMs) ? e.resetAtEpochMs : null, backendId: laneBackendId(process.env) }, OUTCOME_CODES.RATE_LIMITED);
    }
    if (e?.deferCode) return finish("deferred", e.deferDetail ?? String(e.message), { code: e.deferCode }, e.deferCode);
    if (e?.laneCode) return await needsHuman(e.message, e.laneCode);
    if (e?.code === "CLI_SPAWN_FAILED" || e?.spawnDeterministic === true) { // #4129: certain to fail again, so not engine-error (orchestrate would relaunch it)
      return await needsHuman(`The claude CLI could not be started (${e.spawnErrno ?? "spawn error"}); a rerun fails the same way: ${String(e.message).slice(0, 400)}`, OUTCOME_CODES.CLI_SPAWN_FAILED);
    }
    if (e?.pushRejected) return await needsHuman(`git push was rejected (no retry): ${String(e?.stderr ?? e?.message ?? e).slice(0, 400)}`);
    return finish("engine-error", e?.message ?? String(e));
  }
}

export const runLean = runCore;
