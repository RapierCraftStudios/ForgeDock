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
import { codeForTerminalReason, OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { ciPollDelayMs, ENGINE_VERSION, DEFAULT_MAX_SESSION_LIMIT_PAUSES, DEFAULT_SESSION_LIMIT_WAIT_MS, parseLeaseHolder, sanitizeLeaseHost } from "../engine.mjs";
import { openDependency, isTrustedComment, decomposedSubissues, isDecomposedRecord } from "../engine/phases.mjs";
import { createHash } from "node:crypto";
import { TRACKED, isBugIssue, validateContract, applyAmendments, precheck, parseReview, decide, mergeReviewRows, closePlan, followupItems, pendingTracking, unnamedEdges, structureNote } from "./conformance.mjs";
import { checkAdmission, hostParallelism, ADMISSION_RETRY_SECONDS } from "./admission.mjs";
import { namedPaths } from "./prefilter.mjs";
import { resolveLane, isDefaultLane } from "./lane.mjs";
import { dockerLabels, LEDGER_TTL_MS } from "./ledger.mjs";
import { repoKey } from "../runner.mjs";
import { prepareToolchain } from "./toolchain.mjs";
import { retrying, PUSH_TRANSIENT_RE, PUSH_PERMANENT_RE, GH_TRANSIENT_RE, MERGE_TRANSIENT_RE, MERGE_CONFLICT_RE } from "./retry.mjs";
import { renderInvestigation, renderImplementation, renderReview, renderPrBody, renderTrajectory, renderContract, renderAmendments, renderShadowReview, parseContractComment, contractJson, capComment, sanitizeMd, MAX_COMMENT_CHARS } from "./render.mjs";
import { REVIEWER_SYSTEM, LEAN_DIR, RESULT_FILE, INVESTIGATION_FILE, IMPLEMENTATION_FILE, CONTRACT_FILE, builderPlanPrompt, builderImplementPrompt, contractCorrectionPrompt, conformanceResumePrompt, reviewerPrompt, reviewerRepairPrompt, REVIEW_DIFF_MAX_BYTES, blockCorrectionPrompt, HUMAN_BLOCK_REASONS, structurePrompt, hotspotPlanNote, hotspotBuildRule, reproPlanNote, docsPrompt, ciFailurePrompt, ciUnavailablePrompt, precheckFailurePrompt, syncChecks, GROUPING_SYSTEM } from "./prompts.mjs";
import { addLaneWorktree, DEFAULT_SPARSE_MAX_KB } from "./worktree.mjs";
import { parseVerify, runCiVerify, collectFailedLogs, capLogs, VERIFY_MODES } from "./verify.mjs";
import { laneBackendId } from "./limits.mjs";
import { SPLIT_LABEL } from "./refactor.mjs";
import { writeHeavyShims, sumWaits } from "./heavy.mjs";
import { priorityFromLabels } from "./sched.mjs";

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
    return { kind: "split", subissues: subs.map((x, i) => ({ title: x.title.trim(), body: x.body,
      dependsOn: [...new Set((Array.isArray(x.depends_on) ? x.depends_on : []).filter((j) => Number.isInteger(j) && j >= 0 && j < i))] })) };
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
 * @param {number} [o.ciMaxMinutes]  remote-CI wait budget (default 360); exhaustion is NOT needs-human
 * @param {"shadow"|"enforce"} [o.conformance] conformance gate mode (default shadow)
 * @param {"needs-human"|"degraded"} [o.reviewIncomplete] shadow only: what an incomplete review after the re-ask does (default needs-human)
 * @param {object} [o.verify]        forge.yaml verify (verify.mjs parseVerify): mode local (default) | ci | hybrid (#4167)
 * @param {object} [o.precheck]      {commands}: forge.yaml learned.test_commands, run in the worktree before the PR (#4240)
 * @param {"off"|"prefer"} [o.reproTest] forge.yaml lean.repro_test (#4271): prefer (default) freezes a red-green repro_test on bug lanes; off is today's contract
 * @param {object} [o.refactorModule] refactor:split step module (default ./refactor.mjs; injectable for tests, #4211)
 * @param {number} [o.splitMaxLines] refactor:split moved-line budget per PR (default 4000); the rest becomes a chained issue (#4211)
 * @param {string} [o.toolchainOverride] forge.yaml env.toolchain: "<pm>@<x.y.z>" or "off" (#4163)
 * @param {string} [o.envSetup]      forge.yaml env.setup: run once per fresh worktree before the builder (#4163)
 * @param {number} [o.sparseMaxKb]   forge.yaml env.sparse_max_kb: tracked blobs >= this many KB stay out of the lane checkout (default 1024; 0 = off, #4221)
 * @param {object} [o.placement]     {where: local|remote, reason, mode}: the dispatcher's lane placement (#4256), kept in FORGE:STATE
 */
export async function runCore(o) {
  const { issue, repo, lane: requestedLane = null, laneOverride = false, branches = {}, cwd, dir, io, builderModel = null, reviewerModel = DEFAULT_REVIEWER_MODEL,
    toolchainOverride = null, envSetup = null, ciMaxMinutes = 360, conformance = "shadow", reviewIncomplete = "needs-human", reproTest = "prefer", mergeWait = "required", maxSessionLimitPauses = DEFAULT_MAX_SESSION_LIMIT_PAUSES, cliIdleMinutes = 15, cliMaxMinutes = 180, laneLimits = null, maxMergeRetries = 5, sessionLimitMaxWaitMs = DEFAULT_SESSION_LIMIT_WAIT_MS, onProgress = () => {}, emitTelemetry = null, random = Math.random } = o;
  const now = io.now ?? (() => Date.now());
  const vcfg = { ...parseVerify({}), ...(o.verify ?? {}) };
  if (!VERIFY_MODES.includes(vcfg.mode)) vcfg.mode = "local";
  const remoteVerify = vcfg.mode !== "local";
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lane = null, base = null, defaults = [], milestone = null; // set by lane resolution, before the lease
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

  async function attempt(phase, n, r) {
    const rec = { event: "PHASE_ATTEMPT_USAGE", phase, attempt: n, usage: r?.usage ?? null, duration_ms: num(r?.durationMs) ?? 0,
      cost_usd: num(r?.costUsd), model: r?.model ?? null, turns: num(r?.turns) };
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
  const label = async (state) => { try { await retrying(() => io.transitionLabel(issue, state), { transient: GH_TRANSIENT_RE, attempts: 4, sleep: sleepFn, random }); } catch { /* labels are best effort */ } };
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
  async function releaseLease(reason) {
    if (leaseTimer) { clearInterval(leaseTimer); leaseTimer = null; }
    if (!io.projector || !leaseState) return;
    const terminal = ["merged", "invalid", "needs-human", "engine-error"].includes(reason);
    try { await writeLease(null, terminal ? { terminal: true, terminalReason: reason } : {}); } catch { /* best effort */ }
  }

  // Pipeline trajectory (posted once at the end): phase rows, decisions, anomalies.
  const T = { issue, validate: null, plan: null, implement: null, review: null, pr: null, merge: null, close: null, decisions: [], anomalies: [] };
  let shadowWould = null; // forge#4165: the shadow gate's verdict, carried on RUN_TERMINAL (no telemetry write of its own)
  let done = null, finishing = null, wtCreated = false, salvagedRef = null;
  const runId = `${issue}-${t0}`;
  let runTmp = null;
  let sparse = null; // #4221: {excluded, maxKb} when the lane worktree is a sparse checkout; null leaves prompts unchanged
  let toolchain = null; // #4163: {env, summary} when the repo pins its toolchain (env only with a pm shim); null leaves runner env and prompts unchanged
  // #4169: heavy steps take a host semaphore slot (io.heavy); LLM phases are not gated. `heavyEnv` puts the heavy shims on
  // the runner PATH; `waits` ({phase: ms}) and `heavyQueueMax` ride on the lane result for the batch report.
  const heavyCfg = o.heavy ?? {}, heavyOn = Boolean(io.heavy) && heavyCfg.enabled !== false;
  let heavyEnv = null, heavyWaitsFile = null, heavyQueueMax = 0, stage = "plan", iss;
  const waits = {};
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
      conformance_mode: conformance === "enforce" ? "enforce" : "shadow", ...(shadowWould ? { shadow_would: shadowWould } : {}) };
    ev(term);
    await emit(term);
    if (["needs-human", "engine-error", "dependency-open", "dependency-blocked", "dependency-unreadable", "decomposed"].includes(reason)) {
      const wf = ["investigating", "building", "in-review"].map((x) => `workflow:${x}`).join(",");
      try { await ghc(["issue", "edit", String(issue), "-R", repo, "--remove-label", wf]); } catch { /* best effort */ }
    }
    if (["merged", "invalid", "needs-human"].includes(reason)) {
      if (reason === "merged") T.close = ["issue closed (completed)", "label workflow:merged"];
      else if (reason === "invalid") T.close = ["issue closed (not planned)", "label workflow:invalid"];
      else { T.close = ["left open", "label needs-human"]; T.anomalies.push(`needs-human: ${String(detail).split("\n")[0].slice(0, 300)}`); }
      try { await post(["FORGE:TRAJECTORY", REGISTER_MARKER], renderTrajectory({ ...T, usage: usageLine() })); } catch { /* best effort */ }
    }
    await releaseLease(reason);
    done = { terminalReason: reason, detail, branch, worktree: wt, cost_usd: usage.cost_usd, tokens: { input: usage.input, output: usage.output, cache: usage.cache }, wall_ms: now() - t0,
      ...(Object.keys(waits).length ? { waits: { ...waits } } : {}), ...(heavyQueueMax ? { heavyQueueMax } : {}), ...extra };
    return done;
  }
  async function needsHuman(why, code = OUTCOME_CODES.ENGINE_ERROR) {
    try {
      await post("FORGE:NEEDS_HUMAN", `## Needs human\n${why}\n\n_${usageLine()}_`);
      await ghc(["issue", "edit", String(issue), "-R", repo, "--add-label", "needs-human"]);
    } catch { /* best effort */ }
    return finish("needs-human", why, { code }, code);
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
  /** Runner call with the per-run TMPDIR and FORGE_HOST_PARALLELISM; a usage limit pauses and resumes the same step, or defers past the cap (#4101). */
  async function callRunner(args) {
    let pauses = 0;
    for (;;) {
      // #4181: every Docker resource the builder creates carries the lane's ownership labels (same batch/lane as the ledger).
      const labels = dockerLabels({ batch: o.batchId ?? "adhoc", lane: `lean-${issue}`, issue, expires: now() + LEDGER_TTL_MS }).join(" ");
      const par = verifyParallelism(); // #4182
      let deps = {}; // #4220: shared package-manager stores; the engine's own keys win
      try { deps = io.deps?.env?.() ?? {}; } catch { deps = {}; }
      // #4169: heavy shims first on PATH; the phase/issue/priority label each heavy step's slot and wait record.
      const heavy = heavyEnv ? { ...heavyEnv, FORGE_LANE_PHASE: args.role === "builder" ? stage : String(args.role ?? "step"), FORGE_LANE_ISSUE: String(issue), FORGE_LANE_PRIORITY: String(lanePriority()) } : {};
      try { return await io.runner({ ...args, env: { ...deps, FORGE_DOCKER_LABELS: labels, ...(runTmp ? { TMPDIR: runTmp, CLAUDE_CODE_TMPDIR: runTmp } : {}), ...(par ? { FORGE_HOST_PARALLELISM: par } : {}), ...(toolchain?.env ?? {}), ...heavy } }); }
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
  const tcOpts = () => ({ toolchain: toolchain?.summary ?? null, sparse });
  let hotFacts = null; // forge#4195: scripts/hotspots.sh facts for the files the issue names, read once before the plan call
  const implementRestart = () => builderImplementPrompt(vcfg.mode, tcOpts()) + hotspotBuildRule(hotFacts) + CONTINUE_NOTE.replace("BASE", lane);
  async function builder(n, prompt, resume, live = false, restart = implementRestart) {
    let timeoutRetries = 0, p = prompt;
    for (;;) {
      try { return await builderOnce(n, p, resume, live); } catch (e) {
        if (!(e?.code === "CLI_IDLE" || e?.code === "CLI_TIMEOUT")) throw e;
        const idle = e.code === "CLI_IDLE";
        const reason = idle ? "idle timeout" : "timeout";
        ev({ event: idle ? "CLI_IDLE_KILL" : "CLI_TIMEOUT_KILL", reason, lastTool: e.lastTool ?? null, children: e.children ?? [] });
        await checkpoint(reason);
        if (timeoutRetries++ >= 1) { e.deferCode = idle ? OUTCOME_CODES.CLI_IDLE : OUTCOME_CODES.CLI_TIMEOUT; e.deferDetail = `builder ${reason}; work checkpointed to ${branch}; rerun resumes from it. ${String(e.message).slice(0, 300)}`; throw e; }
        T.anomalies.push(`builder ${reason}: checkpointed, retried once`);
        T.decisions.push(`Builder ${reason}: uncommitted work checkpointed to the lane branch; retrying once from the checkpoint`);
        p = restart(); resume = null;
      }
    }
  }

  async function builderOnce(n, prompt, resume, live = false) {
    onProgress({ event: "phase_enter", phase: "build" });
    await renew();
    const control = {};
    const governor = startGovernor(control);
    let spawned = null;
    const onSpawn = (child) => { if (Number.isSafeInteger(child?.pid) && !finishing) { spawned = child.pid; ledgerDo((l) => l.register("pid", child.pid, { marker: basename(String(child.spawnfile ?? "")) || null })); } };
    const call = Promise.resolve(callRunner({ role: "builder", issue, cwd: wt, model: builderModel, resume, system: "", prompt, control, onSpawn,
      idleMs: Math.round(cliIdleMinutes * 60000), maxMs: Math.round(cliMaxMinutes * 60000), laneLimits }));
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
    if (r?.sessionId) sessionId = r.sessionId;
    await attempt("implement", n, r);
    onProgress({ event: "phase_exit", phase: "build", status: "committed" });
    return r;
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
      if (String(v?.state).toUpperCase() !== "OPEN") continue;
      // #4153: an open decomposed parent resolves to its open sub-issues; it is satisfied once they all close.
      const subs = isDecomposedRecord(v) ? await decomposedSubissues(d, io) : null;
      const recs = [];
      if (!subs) recs.push([d, v]);
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
      try { await post("FORGE:DECOMPOSED", `## Split into sub-issues\n${filed.map((n, i) => `- #${n} ${b.subissues[i].title}`).join("\n")}\n\n${s}`); } catch { /* best effort */ }
      await label("decomposed");
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
    iss = JSON.parse(await ghc(["issue", "view", String(issue), "-R", repo, "--json", "number,title,body,state,comments,labels"]));
  } catch (e) { return finish("engine-error", `cannot read issue: ${e.message}`); }
  if (String(iss.state).toUpperCase() === "CLOSED") return finish("invalid", "issue already closed");

  try {
    // ---- 1. claim ----
    await label("investigating");
    await post("FORGE:STARTED", `Started work on #${issue} (base \`${lane}\`).`);

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
    // #4220: link node_modules/.venv from the shared cache keyed by lock hash (or install once and publish). Never fails the run.
    if (io.deps?.prepare) {
      let res;
      try { res = await io.deps.prepare({ wt, repoKey: repoKey(cwd) }); } catch (e) { res = [{ status: "failed", eco: null, key: null, ms: 0, reason: String(e?.message ?? e).slice(0, 300) }]; }
      for (const r of Array.isArray(res) ? res : []) {
        ev({ event: "DEPS_PREPARED", status: r?.status ?? null, eco: r?.eco ?? null, key: r?.key ?? null, ms: r?.ms ?? null, reason: r?.reason ?? null });
        if (r?.eco) T.decisions.push(`Dependencies (${r.eco}${r.key ? ` ${r.key}` : ""}): ${r.status}${r.reason ? ` (${r.reason})` : ""}${Number.isFinite(r.ms) ? ` in ${Math.round(r.ms / 100) / 10}s` : ""}`);
      }
    }
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
      else { try { r = await heavyStep("setup", () => io.runSetup({ cwd: wt, command: envSetup, env: { ...(runTmp ? { TMPDIR: runTmp } : {}), ...(toolchain?.env ?? {}) } })); } catch (e) { r = { exit: 1, stderr: String(e?.message ?? e) }; } }
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
      const rg = await heavyStep("precheck", () => io.redGreen({ cwd: wt, base, command: String(t.command) })).catch(() => null);
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
    const textOf = (i, tc) => [i.title, i.body ?? "", ...tc.map((c) => c?.body ?? "")].join("\n\n");
    let trustedComments = trustedOf(iss);
    let issueText = textOf(iss, trustedComments);
    /** #4188: the builder reads the live issue, so quotes are checked against the current text, not the RUN_START snapshot. Best effort. */
    async function refreshIssue(stage) {
      let next;
      try { next = JSON.parse(String(await ghc(["issue", "view", String(issue), "-R", repo, "--json", "number,title,body,state,comments,labels"]))); } catch { return; }
      if (!next || typeof next !== "object") return;
      const tc = trustedOf(next), text = textOf(next, tc);
      const old = contractHash(issueText), now = contractHash(text);
      if (old === now) return;
      iss = next; trustedComments = tc; issueText = text;
      ev({ event: "ISSUE_EDITED", old, new: now, stage });
      T.decisions.push(`Issue edited during the run (${old} -> ${now}); ${stage} uses the current text`);
    }
    /** A typed block (with one corrective resume for an untyped one) ends the run; returns the terminal or null. */
    async function endIfBlocked() {
      let block = result?.status === "blocked" ? await resolveBlock(result) : null;
      if (block?.kind === "untyped" && sessionId) { // #4124: one corrective resume before any untyped block can reach needs-human
        T.decisions.push(`Builder block rejected (${block.problem}); resumed once`);
        await builder(++attemptN, blockCorrectionPrompt(block.problem), sessionId);
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
    /** The frozen contract posted by an earlier run of this issue, verified against its hash; null when absent. */
    async function readFrozenContract() {
      let out = "";
      try { out = String(await ghc(["api", "--paginate", `repos/${repo}/issues/${issue}/comments`, "--jq", ".[] | {body, author_association, user: {type: .user.type, login: .user.login}}"])); } catch { return null; }
      let found = null;
      for (const l of out.split("\n")) {
        let c; try { c = JSON.parse(l); } catch { continue; }
        if (!String(c?.body ?? "").startsWith("<!-- FORGE:CONTRACT -->") || !isTrustedComment(c)) continue;
        const fc = parseContractComment(c.body);
        if (fc && contractHash(fc.text) === fc.hash) found = fc;
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
                await attempt("group", 1, rr);
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
    if (isSplit) {
      // ---- 3'. refactor:split (#4211): deterministic move + proof replaces the builder; no builder session exists ----
      split = await splitStep();
      if (split.done) return split.done;
      frozen = split.contract; hash = contractHash(contractJson(frozen));
      files = await changedFiles();
    } else {
      if (resumed) {
        const fc = await readFrozenContract();
        if (fc) { frozen = fc.contract; hash = fc.hash; T.decisions.push(`Rerun: frozen contract ${hash} recovered from the issue`); }
      }
      await label("building");
      hotFacts = await hotspotsOf({ paths: namedPaths(iss.body ?? "") });
      const planPrompt = () => builderPlanPrompt(issue, tcOpts()) + hotspotPlanNote(hotFacts) + reproPlanNote(reproOn());
      if (!frozen) {
        await builder(++attemptN, planPrompt() + (hasCommits ? PLAN_RERUN_NOTE.replace("BASE", lane) : ""), null, true, planPrompt);
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
        let contract = await readContract();
        await refreshIssue("contract validation");
        let vc = validateContract(contract, issueText, { repro: reproOn() });
        if (!vc.ok && sessionId) {
          T.decisions.push(`Contract rejected (${vc.problems[0]}); resumed once`);
          await builder(++attemptN, contractCorrectionPrompt(vc.problems), sessionId, false, planPrompt);
          contract = await readContract();
          await refreshIssue("contract validation");
          vc = validateContract(contract, issueText, { repro: reproOn() });
        }
        await flushStages(result ?? { status: "fixed" }, ["investigation"]); // always posted: FORGE:INVESTIGATION/VALIDATE are read downstream
        if (!vc.ok) return await needsHuman(`The builder's contract is still invalid after one correction:\n${vc.problems.slice(0, 12).map((x) => `- ${x}`).join("\n")}`, OUTCOME_CODES.CONTRACT_INVALID);
        frozen = contract;
        hash = contractHash(contractJson(frozen));
        let body = renderContract(frozen, hash);
        if (body.length > MAX_COMMENT_CHARS - 500) body = renderContract(frozen, hash, { compact: true }); // the JSON must survive the comment cap
        await post(["FORGE:CONTRACT", "FORGE:PLAN"], body);
        const deferredN = frozen.requirements.filter((r) => TRACKED.includes(r.disposition)).length;
        ev({ event: "CONTRACT_FROZEN", hash, requirements: frozen.requirements.length, deferred: deferredN });
        T.decisions.push(`Contract frozen (${hash}): ${frozen.requirements.length} requirement(s), ${deferredN} deferred pending review`);
      } else {
        T.validate = "resumed (existing branch)";
      }
      T.plan = [`contract ${hash}`, `${frozen.requirements.length} requirement(s)`];
      if (io.fs.write) { try { await io.fs.write(`${wt}/${CONTRACT_FILE}`, `${contractJson(frozen)}\n`); } catch { /* the prompt still names it */ } }
      const implementPrompt = builderImplementPrompt(vcfg.mode, tcOpts()) + hotspotBuildRule(hotFacts) + (planned ? "" : (fromCheckpoint ? CONTINUE_NOTE : RERUN_NOTE).replace("BASE", lane)) + (salvagedRef ? SALVAGE_NOTE.replaceAll("REF", salvagedRef) : "");
      liveKeys = ["implementation"];
      stage = "implement";
      await builder(++attemptN, implementPrompt, planned ? sessionId : null, true);
      stage = "fix"; // later builder rounds fix precheck, CI, structure, docs or conformance findings
      result = await readResult();
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
    const precheckCommands = (Array.isArray(o.precheck?.commands) ? o.precheck.commands : []).map((c) => String(c ?? "").trim()).filter(Boolean);
    if (precheckCommands.length && io.runCommand) {
      for (let round = 0; ; round++) {
        await renew();
        const results = [];
        for (const command of precheckCommands) {
          let r;
          try { r = await heavyStep("precheck", () => io.runCommand({ command, cwd: wt, timeoutMs: vcfg.precheckTimeoutSeconds * 1000 })); } catch (e) { r = { rc: 127, output: String(e?.message ?? e) }; }
          results.push({ command, rc: Number.isInteger(r?.rc) ? r.rc : 1, output: String(r?.output ?? "") });
        }
        ev({ event: "PRECHECK_COMMANDS", round, results: results.map(({ command, rc }) => ({ command, rc })) });
        const failed = results.filter((r) => r.rc !== 0);
        if (!failed.length) { if (round) T.decisions.push(`Declared check commands pass after ${round} builder fix round(s)`); break; }
        const names = failed.map((f) => `\`${f.command}\` (exit ${f.rc})`).join(", ");
        if (isSplit) return await needsHuman(`Declared check command(s) fail on the refactor:split move (no builder edits a split); nothing merged: ${names}`, OUTCOME_CODES.CI_RED);
        if (round >= vcfg.maxRounds || !sessionId) { T.anomalies.push(`Declared check command(s) still failing before the PR: ${names}`); break; }
        T.decisions.push(`Declared check command(s) failed: ${names}; builder resumed (round ${round + 1}/${vcfg.maxRounds})`);
        const before = String(await git(["rev-parse", "HEAD"])).trim();
        const capped = capLogs(failed.map((f) => ({ ...f, log: f.output }))).map((f) => ({ command: f.command, rc: f.rc, output: f.log }));
        await builder(++attemptN, precheckFailurePrompt(capped, vcfg.mode), sessionId);
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
        await builder(++attemptN, structurePrompt(edges, vcfg.mode), sessionId);
        await upsertStage("implementation");
        result = (await readResult()) ?? result;
        structure = (await structureOf()) ?? structure;
        edges = undeclared();
      }
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
        await builder(++attemptN, docsPrompt(docs.output), sessionId);
        await upsertStage("implementation");
        result = (await readResult()) ?? result;
        docs = await io.docsFreshness({ cwd: wt, base }).catch(() => null);
      }
      if (docs && !docs.ok) {
        return await needsHuman(`The repository's docs freshness check still fails${sessionId ? " after one builder resume" : ""}; nothing merged:\n\n${String(docs.output).slice(0, 2000)}`, OUTCOME_CODES.DOCS_STALE);
      }
    }
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
          await builder(++attemptN, ciUnavailablePrompt(), sessionId ?? null);
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
        await builder(++attemptN, ciFailurePrompt(v.failures, vcfg.mode), sessionId);
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
    const shadow = conformance !== "enforce";
    let effective = frozen, review = null, lastAmend = "", resumes = 0, verdict = null, degraded = null;
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
      for (let t = 0; t < 2; t++) {
        // #4160: a reply with rows missing is re-asked for those ids only; an unparseable one gets the full prompt again.
        const repair = first && (d.state === "review.incomplete" || d.state === "review.inconsistent");
        await renew();
        const rr = await callRunner({ role: "reviewer", issue, cwd: wt, model: reviewerModel, resume: null, system: REVIEWER_SYSTEM, readOnly: true,
          prompt: repair ? reviewerRepairPrompt({ missing: d.missing ?? [], problems: d.failures.map((f) => f.detail), rows: first })
            : reviewerPrompt({ issue: iss, comments: trustedComments, contract: effective, result, files, diff, stat, base, structure: structureLine, ignore: IGNORE }) });
        await renew();
        await attempt("review", ++reviewN, rr);
        const parsed = parseReview(rr?.text);
        review = repair ? mergeReviewRows(first, parsed) : parsed;
        first = review;
        d = decide(review, ctx);
        if (d.review) review = d.review;
        ev({ event: "CONFORMANCE", round: reviewN, state: d.state, failures: d.failures.map((x) => x.code), mode: shadow ? "shadow" : "enforce" });
        if (!d.state.startsWith("review.")) return d;
      }
      return d;
    }
    /** Precheck then review, on the current result and changed files (also the base-sync re-review). */
    async function gate() {
      await refreshIssue("conformance");
      result = (await readResult()) ?? result;
      files = await changedFiles();
      const amendProblems = await amend();
      const ciVerified = remoteVerify && ciVerifiedHead !== null && ciVerifiedHead === String(await git(["rev-parse", "HEAD"])).trim();
      const pc = precheck({ contract: effective, result, changedFiles: files, ignore: IGNORE, ciVerified, hotspots: await hotspotsOf({ base, paths: files }), repro: await reproOf(effective) });
      const pre = [...pc.failures, ...amendProblems];
      if (pre.length) ev({ event: "PRECHECK", failures: pre.map((f) => f.code) });
      if (pre.length && !shadow) return { state: "nonconforming", by: "precheck", failures: pre };
      // shadow: the builder's own failed checks block before any reviewer tokens are spent (#4160)
      const hard = shadow ? pre.filter((f) => SHADOW_PRE_BLOCKS.includes(f.code)) : [];
      if (hard.length) return { state: "nonconforming", by: "precheck", failures: hard, would: "nonconforming", wouldFail: pre, reviewState: null };
      const d = await reviewOnce();
      if (!shadow) return { ...d, by: "review" };
      // shadow: record what enforce would have done; block only on what the previous reviewer blocked on
      const would = d.state === "conforms" && !pre.length ? "conforms" : d.state.startsWith("review.") ? d.state : "nonconforming";
      const wouldFail = [...pre, ...(d.state === "conforms" ? [] : d.failures)];
      if (d.state.startsWith("review.")) return { ...d, by: "review", would, wouldFail, reviewState: d.state };
      const blocking = d.state === "nonconforming" ? d.failures.filter((f) => SHADOW_BLOCKS.includes(f.code)) : [];
      return { state: blocking.length ? "nonconforming" : "conforms", by: "review", failures: blocking, would, wouldFail, reviewState: d.state };
    }
    /** Shape the base-sync path expects: {unusable: state} when no usable review, else {fail, verdict, reason, failures}. */
    const doReview = async () => {
      const d = await gate();
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
        if (outcome.state === "conforms") break;
        const list = outcome.failures.slice(0, 15).map((f) => `- ${f.code}: ${f.detail}`).join("\n");
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
        T.decisions.push(`Not conforming (${outcome.by}${outcome.inconsistent ? ", reviewer verdict contradicted its rows" : ""}): ${[...new Set(outcome.failures.map((f) => f.code))].join(", ")}; builder resumed once`);
        await builder(++attemptN, conformanceResumePrompt(outcome.failures, vcfg.mode), sessionId);
        await upsertStage("implementation"); // the published note follows the code after every resume
      }
      // Deferrals the reviewer accepted are filed now, before any PR: the batched follow-up must exist and be linked.
      const toFile = pendingTracking(effective);
      if (toFile.length) await track(toFile, "accepted by the conformance review");
      degradedReq = degraded ? { id: "REVIEW", quote: `conformance review ${degraded.state}: re-run the review`, disposition: "defer", why: `${REVIEW_DEGRADED_LABEL}: rows still missing for ${degraded.missing.join(", ") || "the verdict"}` } : null;
      if (degradedReq) await track([degradedReq], "the conformance review stayed incomplete");
      if (shadow) {
        const wf = verdict.wouldFail ?? [];
        shadowWould = verdict.would;
        ev({ event: "CONFORMANCE_SHADOW", would: verdict.would, failures: wf.map((f) => f.code) });
        await emit({ event: "CONFORMANCE_SHADOW", would: verdict.would, failures: wf.map((f) => f.code) });
        T.review = [`shadow: would ${verdict.would === "conforms" ? "pass" : `block (${verdict.would})`}`, `${reviewN} reviewer run(s), ${resumes + 1} round(s)`];
        await post("FORGE:REVIEW", renderShadowReview({ would: verdict.would, failures: wf, review: verdict.reviewState === "conforms" || verdict.reviewState === "nonconforming" ? review : null, contract: effective, degraded: degradedReq?.tracked ?? (degraded ? "untracked" : null) }));
      } else {
        T.review = ["CONFORMS", `${reviewN} reviewer run(s), ${resumes + 1} round(s)`];
        await post("FORGE:REVIEW", renderReview(review, effective));
      }
    }
    ev({ event: "PHASE_COMMIT", phase: "review" });
    const closing = closePlan(effective);
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
        const prompt = `Merging ${base} into this branch conflicts in: ${files.join(", ") || "(see git status)"}. Resolve the conflicts preserving both this fix's intent and the base's changes, ${syncChecks(vcfg.mode)}, and commit the merge. Do not push.`;
        await builder(++attemptN, prompt, sessionId ?? null);
        if (await unresolved()) {
          await gitOut(["merge", "--abort"]);
          return await needsHuman(`Base-sync could not resolve the conflicts in ${files.join(", ")} (conflict markers or an unfinished merge remain).`, OUTCOME_CODES.BASE_CONFLICT);
        }
        how = `builder resolved ${files.length} conflicted file(s) and committed the merge`;
        const r2 = await readResult();
        tests = Array.isArray(r2?.tests) && r2.tests.length ? r2.tests.map((t) => (typeof t === "string" ? t : `${t.command}: ${t.result}`)).join("; ") : NR_TESTS;
      }
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
      if (!isSplit && (!clean || ciFixes)) {
        let rv = await doReview();
        if (rv?.fail) {
          T.decisions.push(`Base-sync re-review FAIL: builder resumed with the reason`);
          await builder(++attemptN, conformanceResumePrompt(rv.failures, vcfg.mode), sessionId ?? null);
          if (await unresolved()) return await needsHuman("Base-sync re-review fix left conflict markers.", OUTCOME_CODES.BASE_CONFLICT);
          if ((await gitOut(["rev-parse", "HEAD"])) !== after) await gitPush(["push", "origin", branch]);
          rv = await doReview();
        }
        if (rv.unusable) return await needsHuman(`Reviewer returned no usable review after base-sync (${rv.unusable}).`, UNUSABLE_REVIEW_CODES[rv.unusable]);
        if (rv.fail) return await needsHuman(`Review FAIL after base-sync: ${rv.reason}`, OUTCOME_CODES.REVIEW_FAILED);
        rereview = `${rv.verdict}: ${rv.reason || "no concrete failure"}`;
      }
      localHead = await gitOut(["rev-parse", "HEAD"]);
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
      await builder(++attemptN, ciFailurePrompt(failures, vcfg.mode), sessionId);
      await upsertStage("implementation");
      result = (await readResult()) ?? result;
      if ((await gitOut(["rev-parse", "HEAD"])) === before) {
        return await needsHuman(`Required check(s) failed on PR #${pr} (${jobs.join(", ")}) and the builder made no new commit for it; nothing merged.`, OUTCOME_CODES.CI_RED);
      }
      const rv = await doReview(); // never merge an unreviewed head
      if (!rv) return await needsHuman("Reviewer returned no parseable verdict after a CI fix round.", OUTCOME_CODES.REVIEW_NO_VERDICT);
      if (rv.fail) return await needsHuman(`Review FAIL after a CI fix round: ${rv.reason}`, OUTCOME_CODES.REVIEW_FAILED);
      await gitPush(["push", "origin", branch]); // plain push of the fix commit: never force
      localHead = await gitOut(["rev-parse", "HEAD"]);
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
            const w = await io.waitCiGreen(pr, repo, 0).catch(() => ({ rc: 2, text: "" }));
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
    await ghw(["issue", "close", String(issue), "-R", repo, "--reason", "completed"]).catch(() => {});
    if (closing.tracked.length) {
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
    return await finish("merged", `PR #${pr}`, { pr, structure: T.structure ?? null, ...(milestone ? { milestone } : {}), ...(lane ? { lane } : {}) });
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
