// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Core work-on: ONE plain builder session does the work, ONE read-only reviewer answers two questions, and
 * ForgeDock registers everything on GitHub (labels, one register comment, PR, merge). No investigation, synthesis,
 * severity taxonomy, risk tiers or local CI gates. All effects are injected through `io` so it is unit-testable.
 */
import { issuePrMarker, supersedeOlderPrs, openPrBlockingClose } from "./orphan-pr.mjs";
import { resolveFindingLabel } from "./findinglabel.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, basename, delimiter } from "node:path";
import { hostname as osHostname } from "node:os";
import { appendEvent } from "../engine/runlog.mjs";
import { testAdequacyRows, testAdequacyFailures, testAdequacyTelemetry, adequacyCounts, regressionRan } from "./testadequacy.mjs";
import { readSelfReview, compareSelfReview, firstReviewRecord, selfCheckFailures } from "./selfreview.mjs";
import { codeForTerminalReason, OUTCOME_CODES, ENV_VALIDATE_TIMEOUT, ENV_VALIDATE_PLACEMENT, ENV_ENGINE_OWNED_CODES } from "../engine/outcome-codes.mjs";
import { ciPollDelayMs, ENGINE_VERSION, DEFAULT_MAX_SESSION_LIMIT_PAUSES, DEFAULT_SESSION_LIMIT_WAIT_MS, parseLeaseHolder, sanitizeLeaseHost } from "../engine.mjs";
import { openDependency, laneMergedPrs, dependencyOnLane, isTrustedComment, decomposedSubissues, isDecomposedRecord, reopenRevokedDecomposition } from "../engine/phases.mjs";
import { createHash, randomBytes } from "node:crypto";
import { otherLaneOwner } from "./lanelock.mjs";
import { stampText, checkStamp } from "./stagestamp.mjs";
import { acquireBranchLock, waitPidsExit } from "./branchlock.mjs";
import { contractRuleCounts, onlyTestPlanProblems, isTestPath, applyValidateRecipes, rewriteProjectDirCommand, deferChecklessPostDeploy, autoPostDeployE2e, applyRequirementDecisions, loneE2eRows, reproEnvMiss, resolveForgedockPaths, describesUnrunnableCommand, removedPathsOf, TRACKED, normalizeKindModes, blockingFailures, unverifiedRequirements, mutationTargets, mutationFailures, runMutationCheck, MUTATION_SURVIVED, isBugIssue, scopeText, explainFailures, inIssue, validateContract, snapQuotes, cliUsageError, normalizeRunnerCommand, applyAmendments, amendmentKindProblems, precheck, alreadyFixedOnBase, READONLY_PROD_RE, EXTERNAL_NEED_RE, intakeHostWork, repoTracks, dropScopeValidates, tagOutOfBand, parseReview, decide, mergeReviewRows, reaskable, criterionLines, closePlan, followupItems, renderPendingFollowups, bucketTally, pendingTracking, unnamedEdges, structureNote, impliedDocDeliverables, convertDelivered } from "./conformance.mjs";
import { checkAdmission, hostParallelism, ADMISSION_RETRY_SECONDS } from "./admission.mjs";
import { namedPaths, isTrustedIssueComment } from "./prefilter.mjs";
import { writeStatus, postUpsert, isStatusPost, isUpsertPost, hasSection, clearPipelineLabels } from "./statuscomment.mjs";
import { checksAt, mergeCheckEntries, CHECKS_FILE } from "./postdeploy-check.mjs";
import { matchBaselines, baselineFailures, foldRegression } from "./baselines.mjs";
import { readRollouts, detectNewOffKeys, rolloutModes, liveDeferralBlocks } from "./activation.mjs";
import { toolMisses } from "./toolplace.mjs";
import { hasRecipe, installLaneTools } from "../pool/lane-tools.mjs";
import { testRunnerProblems, preflightProbes, preflightProblems, unsetEnvVars, runPreflight, knownToContract, declaredEnv, depInstallFailures, testRunSummary, projectBinDirs, withLocalBins } from "./preflight.mjs";
import { resolveLane, isDefaultLane, isShippedLane, DEFAULT_STAGING_BRANCH } from "./lane.mjs";
import { splitGate, rationaleLine } from "./decompose.mjs";
import { ceilingFor, predictRestart, handoffFacts, NARROW_NOTE } from "./ceiling.mjs";
import { dockerLabels, LEDGER_TTL_MS } from "./ledger.mjs";
import { batchImageCache, envNamesOf, provisionSandboxes } from "./testsandbox.mjs";
import { repoKey, estimateCostUsd } from "../runner.mjs";
import { prepareToolchain } from "./toolchain.mjs";
import { toolStats } from "./toolstats.mjs";
import { readTestMap, readTestMapAtRef, selectCommands, mergeChecks, factsPath, TEST_MAP_FILE } from "./testmap.mjs";
import { runChecks, runWithTimeoutRetry, splitPrecheckResults, timedOutDetail, planPrecheck, worktreeFingerprint, selfCheckState, quietFailure, CHECK_PLAN_FILE, SELF_CHECK_FILE, CHECK_LOG_DIR } from "./precheck.mjs";
import { retrying, ghCacheRetry, refreshAuthOnce, runRefreshScript, GH_AUTH_RE, GH_AUTH_RETRY_SECONDS, PUSH_TRANSIENT_RE, PUSH_PERMANENT_RE, GH_TRANSIENT_RE, MERGE_TRANSIENT_RE, MERGE_CONFLICT_RE } from "./retry.mjs";
import { renderInvestigation, renderImplementation, renderReview, renderPrBody, renderTrajectory, renderContract, renderAmendments, renderShadowReview, parseContractComment, parseAmendmentsComment, contractJson, capComment, sanitizeMd, MAX_COMMENT_CHARS, recoveryEvidence } from "./render.mjs";
import { parseVerifierConfig, pickVerifierModel, changedSymbols, callersOf, verifierBudget, verifierPrompt, parseVerifierFindings, findingsToFailures, renderVerifierNote, VERIFIER_SYSTEM } from "./verifier.mjs";
import { computeTrigger, riskPathHits, TRIGGER_MODES, pathDomains, parseEnforceDomains } from "./review-trigger.mjs";
import { hostCapabilityBlock, contractHostNeeds } from "./execution.mjs";

const MISSING_TOOL_RE = /command not found|not found in PATH|no such file or directory.*\b(?:docker|promtool)\b|\b(?:docker|promtool)\b[^\n]{0,80}(?:not (?:installed|found|available)|no such file|cannot connect|daemon)|cannot connect to the docker daemon|no docker daemon|no module named|ModuleNotFoundError|\bENOENT\b[^\n]{0,60}spawn/i;
/** #4685: true when a builder's block summary names a missing tool or module (environment), not a credential. */
/** #5623: a contract problem the builder can fix in its own session (shape, typed fields, test-plan rules, check ids), as
 * opposed to one that needs the issue changed (quote not verbatim) or a person. */
export function contractSelfCorrectable(problems) {
  const list = Array.isArray(problems) ? problems : [];
  return list.length > 0 && !list.every((x) => /: quote is not verbatim/.test(String(x)));
}

export function missingToolBlock(summary) { return MISSING_TOOL_RE.test(String(summary ?? "")); }
import { reserveForBuild, revalidate } from "./seqreserve.mjs";
import { patchEcho, mutationsOf, runReproMutations, classifyRepro } from "./reproquality.mjs";
import { CHECKS_CLI, FORGEDOCK_CLI, REVIEWER_SYSTEM, LEAN_DIR, RESULT_FILE, INVESTIGATION_FILE, IMPLEMENTATION_FILE, CONTRACT_FILE, builderPlanPrompt, builderImplementPrompt, contractCorrectionPrompt, conformanceResumePrompt, amendmentCorrectionPrompt, reviewerPrompt, investigationVerdict, decisionNote, reviewerRepairPrompt, REVIEW_DIFF_MAX_BYTES, blockCorrectionPrompt, HUMAN_BLOCK_REASONS, structurePrompt, hotspotPlanNote, hotspotBuildRule, reproPlanNote, unrunnableValidateNote, docsPlanNote, pagePlanNote, contextPackNote, buildOpeningNote, sequenceBuildRule, docsPrompt, ciFailurePrompt, ciUnavailablePrompt, precheckFailurePrompt, contextRestartPrompt, turnBudgetWrapupPrompt, syncChecks, GROUPING_SYSTEM, enumeratingPlanNote, enumeratingBuildRule, invariantsPlanNote, invariantsBuildRule, missingEntriesPrompt, sequencePrompt, sequenceSyncNote, sequenceSyncPrompt, fixSessionPrompt, postMergeFailurePrompt, duplicateExportsPrompt, migrationGeneratorPrompt, i18nCopiesPrompt, narrowFixPrompt } from "./prompts.mjs";
import { postMergeCommands } from "./postmerge.mjs";
import { classifyBaseRed, attribute as attributeBaseRed, runOnBase, reportBaseRed } from "./basered.mjs"; // #5239
import { guardAfterMerge, withHistoryRows } from "./guards.mjs";
import { parseProdParity, prodParityFailures as prodParityOf } from "./prodparity.mjs";
import { routePathsFromFiles, routeReachabilityFailures } from "./routecheck.mjs";
import { docsFailures } from "./docsgate.mjs";
import { pageFailures, designSpecApproved, designLabelApproved } from "./pagegate.mjs"; // #5428
import { uiBuildRule, uiIssue, uiChanged } from "./ui-quality.mjs"; // #5330
import { designGate, designGateNote, designFailures, specApproved as designSpecOk } from "./design-gate.mjs"; // #5330
import { parseCoupled, coupledFailures } from "./coupled.mjs";
import { analyzeRelaxations, relaxationFailures } from "./relaxation.mjs";
import { startSpeculative } from "./overlap.mjs";
import { loadGuards, selectGuards, runGuards, supersededIds, supersessionComment } from "./guardgate.mjs";
import { freshFix, issueSummary, firstPassOf, sessionCostDelta, mergeNarrowTasks } from "./fixround.mjs";
import { parseBuilderRouting, routeBuilder, shouldEscalate } from "./routing.mjs";
import { makeTurnBudget, TURN_BUDGET_DEFAULTS, scaledExtra, laneSize, recoverySize, wrapupGrant, budgetDigest } from "./budget.mjs";
import { pendingPitfall, pitfallRecord, foldPitfalls, selectPitfalls, failureLog } from "./pitfalls.mjs";
import { unjustified } from "./enumerating.mjs";
import { applyEnumerating, renameDuplicates, verifyApplied } from "./mechfix.mjs"; // #5348
import { addLaneWorktree, DEFAULT_SPARSE_MAX_KB } from "./worktree.mjs";
import { claimWarm, refillWarm, warmTreeCount, NO_HOOKS } from "./warmtree.mjs";
import { parseVerify, runCiVerify, collectFailedLogs, capLogs, VERIFY_MODES, VERIFY_CHECK_NAME, verifyReport, ciGate, rerunFailedOnce, rerunTarget, splitFlaky } from "./verify.mjs";
import { e2eSpecs, e2eWanted, uiInteractiveChanged, ownFailures, runE2eGate, fakedPaths, NO_TRIGGER } from "./e2e.mjs";
import { transferToEpic } from "./acceptance.mjs";
import { laneBackendId } from "./limits.mjs";
import { openRotator, rotatorRetry } from "./rotator.mjs";
import { poolExhausted, exhaustedDeferral, quotaFacts } from "./quota.mjs"; // #5236
import { watchAccount } from "./account-watch.mjs"; // #5268
import { SPLIT_LABEL } from "./refactor.mjs";
import { writeHeavyShims, sumWaits, isHeavyProcess } from "./heavy.mjs";
import { priorityFromLabels } from "./sched.mjs";
import { applyArmOverrides } from "../experiment.mjs";
import { parseExploreConfig, explorerAgents, explorePlanRule, exploreBuildRule } from "./explore.mjs";
import { normaliseFacts, renderFactsRecord, FACTS_MARKER } from "./facts.mjs";
import { readDecisionIndex, withDecisionRows, recordDecisions } from "./decisions.mjs";
import { seamFailures } from "./seam.mjs"; // #5338
import { notifyConsumers } from "./interfaces.mjs"; // #5338
import { normaliseInvalidation, epicOf, fileAmendment, REPLAN_MARKER } from "./replan.mjs";
import { claimSurfaces, parseSharedSurfaces, generatorNote } from "./surfaces.mjs";
import { parseContextPackConfig, resolveContextMode, parentOf, contextArm, contextPackFor, renderContextRecord, laneType, priorAttempts, linkStateStamp, stateOf } from "./context.mjs";
import { isExternalKill } from "./hostkill.mjs";
import { buildResumeDigest } from "./resume.mjs";
import { parsePredicate, evalPredicate, premiseAnnotation, registerAsk, registryPkgVersion, closedEdgeNote, onlyAsk, fileRemainder } from "./needs-human-premise.mjs";
import { lightEligibility } from "./light.mjs";
import { fastForwardSource, parseTriage, fastForwardEligibility, fastForwardEvent, skippedStages, skippedLine, investigationOnlyPrompt, contractStepPrompt, TRIAGE_FILE, FF_BUILD_LEAD } from "./fastforward.mjs"; // #5426
import { untrackToolState, unstageToolState, isToolState, clearLaneScratch } from "./toolstate.mjs";
import { pickSalvage } from "./salvage-resume.mjs";
import { makePostRun } from "./postrun.mjs";
import { ensureSignedOff, salvageBranch, dropSalvageTracking } from "./signoff.mjs";
import { reconcileCheckpoints } from "./checkpoint-reconcile.mjs";
import { createLedger, flattenPhases } from "./phaseledger.mjs";
import { DEFAULT_CATALOG_SOURCES, deriveCatalog, mergeRecipes, rewriteMissed, isDriftFailure } from "./validate-catalog.mjs";
import { runLightStep, runLightTests, lightBuildPrompt, upgradeNote, renderLiteReceipt } from "./lightlane.mjs";

/**
 * #4267: what a recovery lane does per code. Codebase-agnostic: the repo's own checks and logs only. Keys stay in step
 * with RECOVERABLE_CODES (bin/engine/outcome-codes.mjs); recovery.test.mjs checks it (#4298).
 */
export const RECOVER_HOW = Object.freeze({
  [OUTCOME_CODES.CI_RED]: "the PR's required checks failed. Read the failed checks' logs (`gh run view <run-id> --log-failed`, or the repo's declared check commands), fix the causes, re-run those checks locally and push new commits only (never rewrite history)",
  [OUTCOME_CODES.BASE_CONFLICT]: "the PR conflicts with origin/BASE. Merge origin/BASE, resolve every conflict keeping both sides' intent, re-run the validate commands and push new commits only",
  [OUTCOME_CODES.BUILDER_BLOCK_UNTYPED]: "an earlier run escalated an in-scope technical choice. Do not block on it: pick the option most consistent with the issue, the repo's conventions and prior merged decisions, and name the alternative you did not take in your summary",
  [OUTCOME_CODES.CONTRACT_INVALID]: "the issue was edited while the earlier run planned, or its requirement quotes did not match the issue text. Plan against the current issue text and quote each requirement verbatim from it",
  [OUTCOME_CODES.BUDGET_EXCEEDED]: "an earlier run spent the implement turn budget for this issue's size; its digest is in the earlier run's detail and the branch holds its checkpointed work. Continue from the checkpoint against the frozen contract without starting over; if the remaining work cannot fit the budget, stop with a typed split-required block naming the sub-issues instead of grinding",
  [OUTCOME_CODES.CONTRACT_INVALID_COMMAND]: "a frozen validate command was rejected by its runner's CLI (vitest 3 rejects -q). The change may already be correct: rerun the validate with the runner's own flags (vitest: --reporter=dot) and amend the command, do not rewrite the deliverables",
  [OUTCOME_CODES.ENV_TOOL_MISSING]: "a validate command could not run because the host lacks the tool or module named in the earlier run's detail; the change may already be correct. Do not edit the deliverables for it and never install anything globally: run the same check through the repo's own toolchain (its virtualenv, lockfile-pinned runner or package scripts), record that exit under the same validate id and name the command you used in your summary",
  [ENV_VALIDATE_PLACEMENT]: "an earlier run in a remote sandbox saw a frozen validate command fail; this host is a different environment (Docker, browsers, network, repo-local services). Rerun the frozen command unchanged here and record its real exit under the same validate id; change the deliverables only if it fails here too, and never substitute or narrow it for an environment gap",
  [ENV_VALIDATE_TIMEOUT]: "a validate command timed out (exit 124) on the engine's rerun, even after one longer retry: host load, not a failed check; the change may already be correct. Do not edit the deliverables for it: run the same command narrowed to the changed files (or through the repo's own cached toolchain) with a longer timeout, record that exit under the same validate id and name the command in your summary",
  [OUTCOME_CODES.ENV_CAPABILITY_REMOTE]: "the earlier run ran in a remote sandbox that lacks a host-only capability (SOPS/age key, ops credentials, read-only prod monitor SSH); this host has it. Do the work that needed it now, with the host's own tools and credentials, and never print or commit a secret in the clear",
  [OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED]: "an earlier run's conformance check found a requirement or validate command not done after one builder resume; the branch holds its work. For each named gap deliver the requirement against the frozen contract, adding any file it needs as an `add-deliverable` amendment, and re-run the validate commands",
  [OUTCOME_CODES.CONFORMANCE_OMISSION]: "an earlier run's review found a requirement the change left out or narrowed after one builder resume; the branch holds its work. For each named gap either deliver the requirement (adding any needed file as an `add-deliverable` amendment) or, when the clause is optional, unquantified or outside the issue's acceptance criteria, record an `add-requirement` / `defer` amendment with a why so the engine files a tracked follow-up instead of stopping",
  [OUTCOME_CODES.CONFORMANCE_UNJUSTIFIED_DEFERRAL]: "an earlier run deferred a requirement without a sufficient why after one builder resume; the branch holds its work. An in-lane engineering deferral (bucket new-issue or none) must be delivered, never deferred (#5207). For each other named gap either deliver the requirement (adding any needed file as an `add-deliverable` amendment) or, when the clause is optional, unquantified or outside the issue's acceptance criteria, record a `defer` amendment with a concrete why so the engine files a tracked follow-up instead of stopping",
  [OUTCOME_CODES.CONFORMANCE_REGRESSION]: "an earlier run's review found a regression (a compile, type or test failure the diff introduced, e.g. a removed symbol still referenced) that stayed after the builder resume rounds; the branch holds its work. Re-plan from the frozen contract: fix each named failure in the code and re-run the validate commands",
  [OUTCOME_CODES.CONFORMANCE_SCOPE_CREEP]: "an earlier run changed files no deliverable names after the builder resume rounds; the branch holds its work. Re-plan from the frozen contract: revert each unnamed file or add it as an `add-deliverable` amendment with a why",
  [OUTCOME_CODES.ENV_REPRO_UNRUNNABLE]: "the repro harness could not run the contract's repro_test on head (timeout, missing runner or dependencies); the change may already be correct. Do not edit the deliverables or stub dependencies for it and never install anything globally: run the repro command through the repo's own toolchain and installed dependencies, and when it cannot run in this checkout, fix the repro_test command (not the code) so it does",
});
/** #5644: review/conformance findings a builder can fix itself (code, test, deferral or scope gaps); an empty set is not fixable. */
const BUILDER_FIXABLE = [OUTCOME_CODES.CONFORMANCE_REGRESSION, OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED, OUTCOME_CODES.CONFORMANCE_OMISSION, OUTCOME_CODES.CONFORMANCE_UNJUSTIFIED_DEFERRAL, OUTCOME_CODES.CONFORMANCE_UNTRACKED_DEFERRAL, OUTCOME_CODES.CONFORMANCE_SCOPE_CREEP, OUTCOME_CODES.CONFORMANCE_PRESERVE_VIOLATED];
export function builderFixable(failures) {
  const list = Array.isArray(failures) ? failures : [];
  return list.length > 0 && list.every((f) => BUILDER_FIXABLE.includes(f?.code));
}
/** #5168: retry-in for a `backend.auth` deferral; the batch holds the account for it (an operator `--set-env` fix runs under a new identity). */
const AUTH_RETRY_SECONDS = 900;
/** #4323/#4334: precheck failure codes that are environment errors (state "environment"), never a builder resume. */
const ENV_CODES = Object.freeze([OUTCOME_CODES.ENV_TOOL_MISSING, OUTCOME_CODES.ENV_REPRO_UNRUNNABLE, ENV_VALIDATE_TIMEOUT, OUTCOME_CODES.CONTRACT_INVALID_COMMAND]);
export const DEFAULT_REVIEWER_MODEL = "claude-sonnet-5-5";
/** forge.yaml engine.conformance: "shadow" (default) posts and logs the gate's verdict without enforcing it; "enforce" blocks on it. */
export const CONFORMANCE_MODES = Object.freeze(["shadow", "enforce"]);
/**
 * In shadow mode only what the previous two-question reviewer blocked on still blocks: a requirement not done, a regression
 * (precheck form: SHADOW_PRE_BLOCKS). A review without usable rows never merges either.
 */
const SHADOW_BLOCKS = [OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED, OUTCOME_CODES.CONFORMANCE_REGRESSION, OUTCOME_CODES.CONFORMANCE_UNJUSTIFIED_DEFERRAL]; // #5207: an engineering deferral is undelivered work
/**
 * Precheck failures that block in shadow mode too (#4160): every precheck or amendment failure coded
 * conformance.unimplemented (a validate command that failed or has no recorded result, a deliver requirement reported as
 * not done, an invalid amendment) or conformance.regression, the same codes a review blocks on, and unexempted growth of an
 * over-threshold file (maintenance.hotspot_growth, forge#4195). Scope creep stays recorded-only.
 */
const SHADOW_PRE_BLOCKS = [...SHADOW_BLOCKS, OUTCOME_CODES.MAINTENANCE_HOTSPOT_GROWTH];
/** #4395: cap on the engine.lane_instructions file; a larger one is not slim and falls back to CLAUDE.md. */
export const LANE_INSTRUCTIONS_MAX_BYTES = 16384;
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
    const gate = splitGate({ ...b, subissues: subs }); // #4396: disjoint parts or over the size budget; else one lane
    if (!gate.ok) return { kind: "untyped", problem: gate.problem };
    const subissues = subs.map((x, i) => ({ title: x.title.trim(), body: x.body,
      dependsOn: [...new Set((Array.isArray(x.depends_on) ? x.depends_on : []).filter((j) => Number.isInteger(j) && j >= 0 && j < i))],
      ...(Array.isArray(x.files) ? { files: [...new Set(x.files.filter((f) => typeof f === "string").map((f) => f.trim().replace(/^\.?\/+/, "")).filter(Boolean))] } : {}) }));
    return { kind: "split", rationale: gate.rationale, subissues, serialized: serializeShared(subissues) };
  }
  if (b.kind === "design-invalidated") { // #5342
    const inv = normaliseInvalidation(b, issue);
    return inv ? { kind: "design-invalidated", ...inv } : { kind: "untyped", problem: "the design-invalidated block names no decision or no why" };
  }
  if (b.kind === "human") {
    const remainder = (Array.isArray(b.remainder) ? b.remainder : []).filter((x) => x && typeof x.title === "string" && x.title.trim() && typeof x.body === "string").slice(0, MAX_SUBISSUES).map((x) => ({ title: x.title.trim(), body: x.body })); // #4730
    if (b.why === "product-decision" && describesUnrunnableCommand(`${result?.summary ?? ""} ${b.reason ?? ""} ${b.detail ?? ""}`)) { // #4857
      return { kind: "untyped", problem: "an unrunnable validate command is an environment defect, never a product-decision: run an equivalent through the repo's toolchain and record it as a substitute-validate amendment" };
    }
    return HUMAN_BLOCK_REASONS.includes(b.why) ? { kind: "human", why: b.why, ...(remainder.length ? { remainder } : {}) }
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

/** #5205: cap on `cs-cred claude --limited` relaunches of one phase in a sandbox. */
export const SANDBOX_CRED_RETRIES = 8;
const defaultCredExec = (args) => {
  const r = spawnSync("cs-cred", args, { encoding: "utf8", timeout: 30000, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  return { status: r.error ? null : r.status, stderr: String(r.stderr ?? "") };
};

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
 * @param {object} [o.builderRouting] forge.yaml lean.builder_routing/builder_mid_model (#4394): {mode: on (default)|off, midModel}
 * @param {string} [o.followupsDefaultMilestone] forge.yaml followups.default_milestone (#4664): milestone of deferred follow-ups whose parent's milestone has shipped and has no next one
 * @param {string} [o.followupsRollupLabel] forge.yaml followups.rollup_issue_label (#5078): a repo's own open issue with this label is the post-deploy rollup when no marked one is open
 * @param {string} [o.sequenceRegenerate] forge.yaml lean.sequence.regenerate (#4386): snapshot generator for a schema-changing renumbered migration
 * @param {object} [o.baseMerge] forge.yaml lean.base_merge_* (#4588): {unionGlobs, jsonGlobs, generatedGlobs, generatedCommand} for deterministic base-merge conflict resolution
 * @param {number} [o.ciMaxMinutes]  remote-CI wait budget (default 360); exhaustion is NOT needs-human
 * @param {"shadow"|"enforce"} [o.conformance] conformance gate mode (default shadow)
 * @param {"off"|"report"} [o.conformanceMutation] forge.yaml engine.conformance_mutation (#4913): rerun each evidence test with the change reverted; a survivor is conformance.mutation_survived (shadow unless conformance_kinds enforces it)
 * @param {Record<string,"enforce"|"shadow">} [o.conformanceKinds] forge.yaml engine.conformance_kinds: a failure code's own mode (enforce blocks, shadow is recorded only); others follow `conformance`
 * @param {"needs-human"|"degraded"} [o.reviewIncomplete] shadow only: what an incomplete review after the re-ask does (default needs-human)
 * @param {object} [o.reviewTrigger] forge.yaml review.trigger/risk_paths (#4273): {mode: shadow (default)|enforce|off, riskPaths: globs,
 *                                   enforceDomains: review.enforce_domains (#5099), a touched listed domain makes the lane enforce}
 * @param {object} [o.verifier]      forge.yaml review.verifier/verifier_model (#4397): {mode: off (default)|shadow|enforce, model}
 * @param {object} [o.verify]        forge.yaml verify (verify.mjs parseVerify): mode local (default) | ci | hybrid (#4167)
 * @param {object} [o.precheck]      {commands, maxMinutes}: forge.yaml learned.test_commands, run in the worktree before the PR (#4240);
 *                                   maxMinutes: lean.precheck.max_minutes, the round budget (#4331, else verify.precheck_total_seconds)
 * @param {boolean} [o.closeParent] forge.yaml decomposition.close_parent (#3736): close a decomposed parent at decomposition (default false)
 * @param {"off"|"prefer"} [o.reproTest] forge.yaml lean.repro_test (#4271): prefer (default) freezes a red-green repro_test on bug lanes; off is today's contract
 * @param {object} [o.refactorModule] refactor:split step module (default ./refactor.mjs; injectable for tests, #4211)
 * @param {number} [o.splitMaxLines] refactor:split moved-line budget per PR (default 4000); the rest becomes a chained issue (#4211)
 * @param {object} [o.testRunners] forge.yaml verification.test_runners (#4857): {path prefix: runner command prefix}
 * @param {string} [o.toolchainOverride] forge.yaml env.toolchain: "<pm>@<x.y.z>" or "off" (#4163)
 * @param {string} [o.envSetup]      forge.yaml env.setup: run once per fresh worktree before the builder (#4163)
 * @param {string} [o.laneInstructions] forge.yaml engine.lane_instructions (#4395): repo-relative file appended to fresh sessions instead of CLAUDE.md
 * @param {number} [o.sparseMaxKb]   forge.yaml env.sparse_max_kb: tracked blobs >= this many KB stay out of the lane checkout (default 1024; 0 = off, #4221)
 * @param {object} [o.hostCaps]      {hostCapabilities, hostCapabilityPatterns}: forge.yaml execution.host_capabilities (#4542); a remote credentials block naming one is env.capability_remote
 * @param {string[]} [o.relayCaps]   capabilities the dispatching host relays to this sandbox (#4778, env CS_RELAY_CAPS): no env.capability_remote end before building for them
 * @param {object} [o.placement]     {where: local|remote, reason, mode}: the dispatcher's lane placement (#4256), kept in FORGE:STATE
 * @param {object} [o.explore]       {mode: on|off, model}: forge.yaml lean.explore / lean.explore_model (#4391, default off): the explorer subagent
 * @param {object} [o.contextPack]   {mode: shadow|on|off, sources, bytes, days}: forge.yaml engine.context_pack* (#4275, default shadow)
 * @param {object} [o.recover]       {code, attempt, final}: a batch recovery lane (#4267) for a mechanical needs-human; removes the label,
 *                                   posts FORGE:DECISION and resumes the open PR on the rerun path with a recovery note. `final`
 *                                   (default true) is false when the runner may launch another attempt: the lane then never relabels (#4302)
 */
export async function runCore(o) {
  const armed = applyArmOverrides(o, o.issue); o = armed.options; // #5206: the arm's overrides shape the lane before any config is parsed
  const { issue, repo, lane: requestedLane = null, laneOverride = false, branches = {}, cwd, dir, io, builderModel = null, reviewerModel = DEFAULT_REVIEWER_MODEL, fixModel = null,
    toolchainOverride = null, testRunners = null, coupledFiles = null, validateRecipes = null, validateRegenerate = null, validateCatalogSources = null, routeReachability = null, docsConfig = null, pagesConfig = null, designConfig = null, prodParity = null, envSetup = null, ciMaxMinutes = 360, conformance = "shadow", conformanceKinds = null, conformanceMutation = "off", reviewIncomplete = "needs-human", reproTest = "prefer", reproQuality = "shadow", closeParent = false, mergeWait = "required", maxSessionLimitPauses = DEFAULT_MAX_SESSION_LIMIT_PAUSES, cliIdleMinutes = 15, cliMaxMinutes = 180, cliBusyMinutes = 45, contextCeilingTokens = 120000, contextCeilingBySize = null, turnBudgets = null, laneLimits = null, maxMergeRetries = 5, contractMaxCorrections = 3, reviewMaxResumes = 3, sessionLimitMaxWaitMs = DEFAULT_SESSION_LIMIT_WAIT_MS, contextWaitSeconds = 5, onProgress = () => {}, emitTelemetry = null, random = Math.random } = o;
  const now = io.now ?? (() => Date.now());
  const rotator = io.rotator !== undefined ? io.rotator : openRotator({ kind: o.accountRotator }); // #5094
  // #5205: a rotator with pick() relaunches a limited phase pinned to another account; lane-level rotations and limited accounts
  const smartRotator = Boolean(rotator) && typeof rotator.pick === "function";
  let laneRotations = 0;
  const laneLimited = new Map(); // account -> until epoch ms
  const rotationFacts = () => ({ rotations: laneRotations, limited: [...laneLimited].map(([account, until]) => ({ account, until })) });
  // #5205: in a sandbox (CS_CRED_BASE) a usage limit is reported with `cs-cred claude --limited`, which hands the next login
  const sandboxCred = Boolean((io.env ?? process.env).CS_CRED_BASE);
  const credExec = io.credExec ?? defaultCredExec;
  const vcfg = { ...parseVerify({}), ...(o.verify ?? {}) };
  const learnedCommands = (Array.isArray(o.precheck?.commands) ? o.precheck.commands : []).map((c) => String(c ?? "").trim()).filter(Boolean);
  if (!VERIFY_MODES.includes(vcfg.mode)) vcfg.mode = "local";
  const remoteVerify = vcfg.mode !== "local";
  const triggerMode = TRIGGER_MODES.includes(o.reviewTrigger?.mode) ? o.reviewTrigger.mode : "shadow";
  const riskPaths = Array.isArray(o.reviewTrigger?.riskPaths) ? o.reviewTrigger.riskPaths : [];
  const enforceDomains = parseEnforceDomains(o.reviewTrigger?.enforceDomains ?? []); // #5099
  const verifierCfg = parseVerifierConfig(o.verifier ?? {});
  const routingCfg = parseBuilderRouting(o.builderRouting ?? {});
  // #4394: the build's model tier, routed from the frozen contract; a failed validate round on the mid tier escalates once
  let route = null, escalated = false;
  const laneModel = () => (route?.tier === "mid" && !escalated ? route.model : builderModel);
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lane = null, base = null, defaults = [], milestone = null; // set by lane resolution, before the lease
  // #4267: a batch recovery lane for a mechanical needs-human ({code, attempt, final}); #4302: only a final attempt relabels.
  const recover = o.recover && typeof o.recover.code === "string" ? { code: o.recover.code, attempt: Number.isInteger(o.recover.attempt) ? o.recover.attempt : 1, final: o.recover.final !== false } : null;
  const withLink = (body) => `${issuePrMarker(issue)}\n${body}`; // #5505: the issue → PR link GitHub does not record for a staging PR
  const closeBlockers = (reason, exceptPr = null) => openPrBlockingClose({ repo, io: { gh: ghw }, issue, reason, exceptPr }).catch(() => []); // #5505: fail open
  let branch = `feat/issue-${issue}-lean`; // #5469: an adopted PR's own head branch replaces it
  const wt = join(o.worktreeRoot ?? join(cwd, ".claude", "worktrees"), `lean-${issue}`);
  const t0 = now();
  const phaseLedger = createLedger(now, "sandbox_start", t0); // #4908: where the lane wall time goes
  const usage = { cost_usd: 0, input: 0, output: 0, cache: 0 };
  const sessionCosts = new Map(); // #4407: session id -> last reported cumulative cost
  let sessionId = null;

  const ev = (e) => appendEvent(dir, issue, e, { repo }); // #4432: the run log is keyed by repo + issue
  /** #5435: time one sandbox_start step (SANDBOX_STEP event + ledger sub-timing); the result and errors pass through. */
  const step = async (name, fn) => {
    const s0 = now();
    try { return await fn(); } finally { const ms = Math.max(0, now() - s0); phaseLedger.addStep("sandbox_start", name, ms); ev({ event: "SANDBOX_STEP", step: name, ms }); }
  };
  const expTag = armed.tag; // #4629: same arm for the whole run; #5206: plus the applied overrides
  const emit = async (rec) => { try { await emitTelemetry?.({ ...rec, issue }); } catch { /* never fails a run */ } };
  let ghCache = null; // #4507: the run's own gh HTTP cache (set once the run tmp dir exists)
  const authState = { refreshed: false }; // #4662: one token refresh at a time, shared by every gh call of the run
  const ghc = (args) => refreshAuthOnce(() => ghCacheRetry((env) => io.gh(args, env ? { env } : undefined), ghCache), { refresh: io.refreshAuth ?? runRefreshScript, state: authState });
  const sleepFn = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  /** gh writes (comment, pr create, issue edit/close): retried for 5xx and secondary rate limits (#4114). */
  const ghw = (args) => retrying(() => ghc(args), { transient: GH_TRANSIENT_RE, attempts: 4, sleep: sleepFn, random });
  const git = (args, o = {}) => io.git(args, { cwd: wt, ...o });

  const builderTriggers = []; // #4362: implement-attempt triggers in order, for the lane's first-pass flag
  let usageUnknown = false, inflight = null; // #5334: a killed session streamed nothing; the builder call in flight (flushed when a signal ends the run)
  const impl = { cost: 0, models: new Set() }; // #4397: implement spend and reported models, for the verifier
  // #4392: implement turn budget for the lane's size, and its turn tally; off unless given (the CLI passes readCoreLimits' defaults)
  const tb = makeTurnBudget(turnBudgets ?? { S: 0, M: 0, L: 0 });
  /** `trigger` (#4362): why the attempt ran, one of fixround.mjs TRIGGERS; `resume` (#4407): the session it resumed. */
  async function attempt(phase, n, r, mode = null, trigger = null, restartOf = null, resume = null) {
    const killed = r?.killed === true; // #5334: a session cut off before its result line: cost estimated from the streamed tokens, unknown when none streamed
    const est = killed && num(r?.costUsd) == null ? estimateCostUsd(r?.usage, r?.model) : null;
    const c = sessionCostDelta(sessionCosts, { resume, sessionId: r?.sessionId ?? null, cost: est ?? num(r?.costUsd) });
    if (killed && !r?.usage) usageUnknown = true;
    const rec = { event: "PHASE_ATTEMPT_USAGE", phase, attempt: n, trigger, ...(restartOf ? { restart_of: restartOf } : {}), usage: r?.usage ?? null, duration_ms: num(r?.durationMs) ?? 0,
      cost_usd: est ?? num(r?.costUsd), cost_usd_delta: c.delta, ...(est != null ? { cost_estimated: true } : {}), ...(killed && !r?.usage ? { usage_unknown: true } : {}), cost_usd_session: c.session, model: r?.model ?? null, turns: num(r?.turns), ...(mode ? { mode } : {}),
      ...(num(r?.baselineTokens) != null ? { baseline_tokens: num(r.baselineTokens) } : {}), ...(r?.tools ? { tools: r.tools } : {}), lane_profile: r?.laneProfile ?? laneProfile.name, ...expTag }; // #4410, #4629
    if (phase === "implement") { builderTriggers.push({ trigger, restart_of: restartOf }); impl.cost += c.delta ?? 0; if (r?.model && r.model !== "default") impl.models.add(r.model); tb.note(num(r?.turns), stage === "implement"); }
    ev(rec); await emit(rec);
    modelMs += rec.duration_ms; // #4451: model time next to the lane's wall time
    const ledgerNow = phaseLedger.current(); // #5649: model time of contract and fix calls lands in those phases
    phaseLedger.addModel(phase === "review" ? "review" : ledgerNow === "contract" || ledgerNow === "fix" ? ledgerNow : stage === "plan" ? "plan" : "implement", rec.duration_ms, c.delta);
    const u = r?.usage ?? {};
    usage.cost_usd += c.delta ?? 0;
    usage.input += u.input_tokens ?? 0; usage.output += u.output_tokens ?? 0;
    usage.cache += (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  let statusCache = null; // #5592: {id, sections} of this issue's one FORGE:STATUS comment, edited in place
  const post = async (marker, body, on = issue) => {
    if (on === issue && isStatusPost(marker)) { // machine-state markers: a section of the one status comment, not a comment of their own
      try {
        const r = await writeStatus({ known: statusCache, comments: iss?.comments, trusted: isTrustedIssueComment, markers: Array.isArray(marker) ? marker : [marker], text: body, cap: capComment,
          create: async (b) => /https?:\/\/\S+/.exec(String(await ghw(["issue", "comment", String(on), "-R", repo, "--body", b])))?.[0] ?? null,
          patch: (id, b) => ghw(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${id}`, "-f", `body=${b}`]) });
        statusCache = { id: r.id, sections: r.sections };
        return r.url;
      } catch (e) { if (e?.deferCode) throw e; /* a failed status edit falls back to a plain comment below */ }
    }
    if (on === issue && isUpsertPost(marker)) { // one comment edited in place across requeues (the marker still leads the body)
      return postUpsert({ gh: ghw, repo, issue: on, markers: marker, body, comments: iss?.comments, cap: capComment });
    }
    const marks = (Array.isArray(marker) ? marker : [marker]).map((m) => `<!-- ${m} -->`).join("\n");
    const out = String(await ghw(["issue", "comment", String(on), "-R", repo, "--body", capComment(`${marks}\n${body}`)])).trim();
    return /https?:\/\/\S+/.exec(out)?.[0] ?? null;
  };
  /** Best effort; `true` when the transition succeeded (#4337: the decomposed close needs to know). */
  const label = async (state) => { try { await retrying(() => io.transitionLabel(issue, state), { transient: GH_TRANSIENT_RE, attempts: 4, sleep: sleepFn, random }); return true; } catch { /* labels are best effort */ return false; } };
  const postRun = makePostRun({ ev, sleep: sleepFn, now }); // #5437: bookkeeping after RUN_TERMINAL, idempotent and retried
  const usageLine = () => `cost $${usage.cost_usd.toFixed(4)}, tokens ${usage.input} in / ${usage.output} out / ${usage.cache} cache, wall ${Math.round((now() - t0) / 60000 * 10) / 10} min`;

  // ---- lease (same FORGE:STATE lease the full path uses) ----
  const myHost = o.hostName ?? osHostname();
  // #4920: unique per lane. A sandbox's pid is 1, so `core_<pid>` made every remote lane the same holder and the lease never refused one.
  const agentId = o.agentId ?? `core_${sanitizeLeaseHost(myHost)}_${o.pid ?? process.pid}_${randomBytes(3).toString("hex")}`;
  const leaseObj = () => ({ by: agentId, until: now() + leaseTtlMs, host: myHost, pid: o.pid ?? process.pid, ...(o.batchId ? { batch: o.batchId } : {}) }); // #5654: the batch id lets its own requeue tell this lease from a foreign one
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
  async function releaseLease(reason, code = null, mergedTo = null) {
    if (leaseTimer) { clearInterval(leaseTimer); leaseTimer = null; }
    if (!io.projector || !leaseState) return;
    const terminal = ["merged", "invalid", "needs-human", "engine-error"].includes(reason);
    // forge#4275: the typed outcome code and failure classes ride on FORGE:STATE, so the next run's context pack reads them typed.
    const typed = terminal ? { terminalCode: code ?? null, failureClasses: [...failureClasses].sort(), ...(reason === "merged" && mergedTo ? { mergedTo } : {}) } : {}; // #4711: where the change landed
    const pending = pendingRecord().length ? { pendingFollowups: pendingRecord() } : {}; // #5141: unfiled follow-ups, filed later by the marker
    try { await writeLease(null, terminal ? { terminal: true, terminalReason: reason, ...typed, ...pending } : pending); } catch { /* best effort */ }
  }

  // Pipeline trajectory (posted once at the end): phase rows, decisions, anomalies.
  let depResults = [], gateProvisioned = false; // #5447
  const T = { issue, validate: null, plan: null, implement: null, review: null, pr: null, merge: null, close: null, decisions: [], anomalies: [] };
  const failureClasses = new Set(); // forge#4275: conformance failure codes seen this run (gate failures, shadow would-fail)
  const ctxBase = parseContextPackConfig(o.contextPack ?? {});
  const ctxArm = contextArm({ mode: ctxBase.mode, repo, issue }); // #4444: ab picks a stable on|shadow arm per issue
  let ctxCfg = { ...ctxBase, mode: ctxArm.mode }; // #5340: re-resolved once the issue is read (milestone/parent default)
  let surfaceClaim = null; // #5340: the shared-surface slots held from contract freeze to teardown
  const claimSurfaceSlots = async (frozen) => { // every path that settles `frozen` (light, fresh, recovered) calls this once; idempotent
    const surfaces = parseSharedSurfaces(o.sharedSurfaces);
    if (!surfaces.length || !io.sequenceLease || surfaceClaim || !frozen) return;
    surfaceClaim = await claimSurfaces({ lease: io.sequenceLease, repo, issue, surfaces, paths: (frozen.deliverables ?? []).map((d) => d.path), maxWaitS: ciMaxMinutes * 60 }).catch(() => null);
    if (surfaceClaim?.names.length) T.decisions.push(surfaceClaim.timedOut ? `Shared surface slot ${surfaceClaim.names.join(", ")} timed out (fail-open)` : `Shared surface slot held: ${surfaceClaim.names.join(", ")} (waited ${Math.round(surfaceClaim.waitMs / 1000)}s)`);
  };
  const ctxAb = ctxArm.ab ? { context_ab: true } : {};
  if (ctxArm.ab) T.decisions.push(`Context pack A/B (#4444): arm ${ctxArm.mode}`);
  const exploreCfg = parseExploreConfig(o.explore ?? {}); // #4391
  if (exploreCfg.mode === "on") T.decisions.push(`Explorer subagent (on): model ${exploreCfg.model}`);
  let ctxLane = null; // forge#4275: rerun | child | first, set once the issue is read
  let pitMatched = null; // #4375: pitfalls in the pack that match the issue's files; null when no pack was compiled
  let factsSeen = []; // #4401: trusted comment bodies on the issue, so an identical FORGE:FACTS is never posted twice
  let guardAddedMs = 0; // #4705 (R12): wall time the guard gate added, summed over the lane, carried on RUN_TERMINAL
  let verifiedLane = null; // #5339: true when the lane merged with no transferred or unverified requirement (carried on RUN_TERMINAL)
  let shadowWould = null; // forge#4165: the shadow gate's verdict, carried on RUN_TERMINAL (no telemetry write of its own)
  const kinds = normalizeKindModes(conformanceKinds); // engine.conformance_kinds: a failure code's own mode
  let domains = [], domainsLogged = null; // #5099: review domains the diff touches (review-roster.sh path triggers)
  let reproQ = null; // #5446: repro_quality of the frozen repro_test, carried on RUN_TERMINAL
  let firstReview = null; // #5345: the first gate judgement and review.incomplete of the first reply, on RUN_TERMINAL
  let adequacy = null, adequacyIn = {}, adequacyTel = null; // #5449: the Test adequacy rows of the last gate and the facts they were computed from
  let riskEnforced = null, gateRan = false; // #4398: declared risk paths that made a shadow lane enforce (sticky); the gate ran
  let done = null, finishing = null, wtCreated = false, salvagedRef = null;
  let light = false, modelMs = 0; // #4451: the light lane finished without an upgrade (the same structure/hotspot gates as the full lane, #4502); summed session time
  let lightVerdict = null, lightUpgrade = null; // #4453: the eligibility verdict and the upgrade reason codes, on the run result for the bench
  let recoverUnlabelled = false; // #4297: the recovery lane removed needs-human; a final ci-pending (or needsHuman()) puts it back
  const runId = `${issue}-${t0}`;
  let runTmp = null, sandboxEnv = {}, sandboxDown = null; // #5450: test sandboxes of this lane (testsandbox.mjs)
  /** #5557: after the plan call, derive the classification record from Affected Files + the base-ref unit map, post FORGE:CLASSIFY and namespaced labels. Fail-open; a no-op without `.forge/release.yaml`. */
  async function classifyStage(correct) {
    try {
      const { parsePolicy, validatePolicy, POLICY_PATH } = await import("./release-config.mjs");
      const C = await import("./release-classify.mjs");
      let text; try { text = String(await git(["show", `${base}:${POLICY_PATH}`])); } catch { return; }
      const { policy } = parsePolicy(text);
      if (!policy || validatePolicy(policy).length) return;
      const md = await io.fs.read(`${wt}/${INVESTIGATION_FILE}`).catch(() => "");
      const { affectedFilesOf } = await import("./fastforward.mjs");
      const files = affectedFilesOf(md);
      const texts = {};
      for (const f of files.filter((x) => /migrations\//.test(x))) texts[f] = String(await io.fs.read(`${wt}/${f}`).catch(() => ""));
      const facts = C.deriveFacts(policy, files, { texts });
      let llm = null; try { llm = JSON.parse(await io.fs.read(`${wt}/${C.CLASSIFICATION_FILE}`)); } catch { /* text-only below */ }
      let problems = llm ? C.validateClassification(llm) : ["classification.json missing or unreadable"];
      if (problems.length && correct) { // one correction, as for the contract; a second failure falls back to text-only
        await correct(problems);
        try { llm = JSON.parse(await io.fs.read(`${wt}/${C.CLASSIFICATION_FILE}`)); problems = C.validateClassification(llm); } catch { llm = null; problems = ["classification.json missing or unreadable"]; }
      }
      if (problems.length) { ev({ event: "CLASSIFY_INVALID", problems }); llm = { type: "chore", severity: "P3", exists_in: "unknown", confidence: 0.3 }; }
      const live = policy.branches?.release;
      let liveSha = null; if (live) liveSha = String(await git(["rev-parse", `origin/${live}`]).catch(() => "")).trim() || null;
      let rec = C.buildClassifyRecord(llm, policy, facts, { text: problems.length > 0 });
      const run = async (command, sha) => { // repro on a detached checkout of the live sha under the run TMPDIR (#5557)
        const dir = `${runTmp ?? process.env.TMPDIR ?? "/tmp"}/classify-live-${issue}`;
        await git(["worktree", "add", "--detach", dir, sha]);
        try { const x = await io.runCommand({ command, cwd: dir, timeoutMs: 120000, env: laneEnv() }); const r = x?.r ?? x; const c = r?.rc ?? r?.exit; return typeof c === "number" ? c : 1; /* runCommand reports rc */ }
        finally { await git(["worktree", "remove", "--force", dir]).catch(() => {}); }
      };
      rec = await C.verifyExistsIn(rec, { git: (a) => git(a), liveSha, run: io.runCommand ? run : undefined });
      if (rec.exists_in === "unknown" && rec.lane_hint === "none") rec.lane_hint = "release";
      await io.fs.write?.(`${wt}/${C.CLASSIFICATION_FILE}`, JSON.stringify(rec, null, 1));
      await post("FORGE:CLASSIFY", C.renderClassify(rec));
      for (const l of C.labelsOf(rec)) { try { await ghc(["issue", "edit", String(issue), "-R", repo, "--add-label", l]); } catch { /* label may not exist */ } }
    } catch (e) { ev({ event: "CLASSIFY_FAILED", error: String(e?.message ?? e).slice(0, 200) }); }
  }
  let sparse = null; // #4221: {excluded, maxKb} when the lane worktree is a sparse checkout; null leaves prompts unchanged
  // #4395: lane profile. full (FORGEDOCK_FULL_SESSION=1): unchanged sessions; memory-off: no auto-memory; lane: also no CLAUDE.md, the lane file appended
  let laneProfile = { name: process.env.FORGEDOCK_FULL_SESSION === "1" ? "full" : "memory-off", text: null };
  let toolchain = null; // #4163: {env, summary} when the repo pins its toolchain (env only with a pm shim); null leaves runner env and prompts unchanged
  // #4169: heavy steps take a host semaphore slot (io.heavy); LLM phases are not gated. `heavyEnv` puts the heavy shims on
  // the runner PATH; `waits` ({phase: ms}) and `heavyQueueMax` ride on the lane result for the batch report.
  const heavyCfg = o.heavy ?? {}, heavyOn = Boolean(io.heavy) && heavyCfg.enabled !== false;
  let heavyEnv = null, heavyWaitsFile = null, heavyQueueMax = 0, stage = "plan", iss;
  let seqBuildNote = ""; // #5235: numbers reserved for this lane at build start (prompt paragraph)
  let seqLease = null; // #4386: the host sequence lease, held from the merge-gate renumber through the merge
  const waits = {};
  const followupsFiled = []; // #5078: {issue, class, count} per tracking issue this lane filed into, for the batch report
  const pendingFollowups = []; // #5141: {req, why} whose filing kept failing in-lane; filed after the merge, else recorded
  const pendingRecord = () => pendingFollowups.filter((p) => !p.req.tracked).map((p) => ({ id: p.req.id, quote: String(p.req.quote ?? ""), disposition: p.req.disposition, why: p.why, marker: `FORGE:DEFERRED_FROM: #${issue}` }));
  let precheckMs = 0, precheckDeferred = 0, precheckRan = false; // #4331: pre-PR check wall time and deferrals, for the batch report
  const addWait = (phase, ms, queued = 0, cause = "heavy_queue") => {
    if (Number.isFinite(ms) && ms > 0) { waits[phase] = (waits[phase] ?? 0) + ms; phaseLedger.addWait(phase, cause, ms); } // #5349: by cause into the phase ledger
    if (Number.isInteger(queued)) heavyQueueMax = Math.max(heavyQueueMax, queued);
  };
  const lanePriority = () => priorityFromLabels(iss?.labels);
  /** A host heavy-step slot for an engine-side step, or null (no io.heavy, disabled, or the registry failed: ungated). */
  async function heavyAcquire(phase) {
    if (!heavyOn) return null;
    try { const g = await io.heavy.acquire({ issue, phase, priority: lanePriority() }, heavyCfg); addWait(phase, g?.waitMs, g?.queued); return g; } catch (e) { if (e?.code === "DISK_LOW") throw e; return null; } // #5421: a low disk refuses the step, any other failure is fail-open
  }
  async function heavyStep(phase, fn) { const g = await heavyAcquire(phase); try { return await fn(); } finally { try { g?.release?.(); } catch { /* fail-open */ } } }
  // ---- lane resource ledger (#4179): every owned resource is registered before it is created, released after its teardown ----
  let ledger = null, deleteLocalBranch = false, laneHead = null; // #4958: laneHead = {branch, sha, pushedTo}
  const ledgerDo = (fn) => { if (!ledger) return; try { fn(ledger); } catch (e) { ev({ event: "LEDGER_ERROR", error: String(e?.message ?? e).slice(0, 300) }); } };
  const protectedBranch = (b) => isProtectedLaneBranch(b, { issue, lane, branches, defaults });
  /** Teardown from the ledger (#4179), on every exit path: builder pids, checkpoint of unpushed work, run tmp, worktree, branch, docker. */
  async function teardown(reason, extra) {
    const builderPids = (ledger ? ledger.entries("pid") : []).map((p) => Number(p.value));
    for (const p of ledger ? ledger.entries("pid") : []) {
      try { if (await io.killGroup?.(p.value, p.marker)) ledgerDo((l) => l.release("pid", p.value)); } catch { /* keep it listed */ }
    }
    // #5333: the worktree goes only after the builder processes exited (SIGTERM, then SIGKILL after a grace period).
    const stillRunning = io.proc?.alive && builderPids.length ? await waitPidsExit(builderPids, { alive: io.proc.alive, kill: io.proc.kill, sleep }).catch(() => []) : [];
    // Never discard work silently: an unmerged lane commits and pushes what is left before its worktree goes.
    const saved = !wtCreated || reason === "merged" || (await checkpoint(`exit (${reason})`));
    await reportLaneHead(reason);
    try { ghCache?.dispose?.(); } catch { /* best effort */ }
    if (runTmp) {
      try { if ((await io.runTmp.remove(runTmp)) !== false) ledgerDo((l) => l.release("tmp", runTmp)); } catch { /* best effort */ }
      runTmp = null;
    } // every terminal, including engine-error and deferred
    if (wtCreated && saved && !stillRunning.length) {
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
      ev({ event: "TEARDOWN_KEPT", reason: stillRunning.length ? `builder process ${stillRunning.join(",")} still running: worktree and branch kept` : "checkpoint failed: worktree and branch kept so no work is lost", worktree: wt });
    }
    if (sandboxDown) { try { await sandboxDown(); } catch { /* the ledger loop below retries */ } sandboxDown = null; }
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
    if (laneRotations || laneLimited.size) args[2] = { ...(args[2] ?? {}), ...rotationFacts() }; // #5205: rotations + limited accounts ride on the lane result
    finishing ??= finishOnce(...args); // a signal during a normal finish waits for the same teardown
    return finishing;
  }
  async function finishOnce(reason, detail = "", extra = {}, codeOverride = null) {
    await flushInflight(); // #5334: a signal mid-attempt: the session's usage so far is recorded before RUN_TERMINAL
    try { seqLease?.release(); } catch { /* fail-open */ }
    seqLease = null;
    try { surfaceClaim?.release(); } catch { /* fail-open */ }
    surfaceClaim = null;
    try { await io.sequenceLease?.undeclare?.({ repo, issue }); } catch { /* fail-open (#5340) */ }
    try { await io.sequenceLease?.unreserve?.({ repo, lane, issue }); } catch { /* fail-open (#4526) */ }
    if (heavyWaitsFile) { // #4169: builder-run heavy waits, read before teardown removes the run TMPDIR
      try { const sw = sumWaits(await io.fs.read(heavyWaitsFile)); heavyQueueMax = Math.max(heavyQueueMax, sw.queueMax); for (const [ph, ms] of Object.entries(sw.waits)) addWait(ph, ms); } catch { /* no heavy step ran */ }
    }
    if (setupWait) await setupWait.catch(() => {}); // #5434: never remove the worktree under a running install
    const deferTail = reason === "merged"; // #5437: a merged lane's facts, trajectory and teardown run after RUN_TERMINAL (postRun)
    if (!deferTail) {
      await postLaneFacts(); // #4401: before teardown removes the worktree's result.json
      await teardown(reason, extra); // first: unpushed work is pushed while this run still holds the lease
    }
    const code = codeOverride ?? codeForTerminalReason(reason);
    // forge#4165: pr, milestone and the conformance verdict ride on the existing RUN_TERMINAL write (verdict-mix queries).
    const term = { event: "RUN_TERMINAL", reason, code, ...(extra.pr ? { pr: extra.pr } : {}), ...(milestone ? { milestone } : {}), ...(verifiedLane != null ? { verified: verifiedLane } : {}),
      ...(reproQ ? { repro_quality: reproQ } : {}), conformance_mode: conformance === "enforce" || riskEnforced ? "enforce" : "shadow", ...(shadowWould ? { shadow_would: shadowWould } : {}), ...(firstReview ? { first_review: firstReview } : {}), ...(adequacyTel ?? {}),
      ...(laneHead && reason !== "merged" ? { lane_branch: laneHead.pushedTo ?? "unpushed", lane_sha: laneHead.sha } : {}), context_pack: ctxCfg.mode, ...ctxAb, ...expTag, explore: exploreCfg.mode, wall_ms: now() - t0, ...(guardAddedMs ? { guard_added_ms: guardAddedMs } : {}), model_ms: modelMs, ...(usageUnknown ? { usage_unknown: true } : {}), light, ...(ctxLane ? { lane_type: ctxLane } : {}), ...(pitMatched != null ? { pitfalls_matched: pitMatched } : {}), ...(tb.record() ? { turns: tb.record() } : {}),
      ...(route ? { builder_tier: route.tier, builder_class: route.class, builder_escalated: escalated, builder_model: route.model ?? "default" } : {}) }; // forge#4275: the on/off A/B groups runs by these; #4394: per-tier stats
    const phases = phaseLedger.snapshot(); // #4908: run log gets the nested ledger, FORGE:TELEMETRY the flattened scalars
    ev({ ...term, phases });
    await emit({ ...term, ...flattenPhases(phases) });
    // #4297: only a final failure the runner never requeues puts needs-human back (needsHuman() relabels on its own path). invalid,
    // decomposed and dependency-* are legitimate non-failure endings; deferred/engine-error may be requeued, so the batch runner
    // (orchestrate settle, relabelNeedsHuman) relabels those once they are final. #4302: a non-final attempt never relabels; the runner
    // either launches the next attempt or relabels in settle.
    if (recoverUnlabelled && recover.final && (reason === "ci-pending" || reason === "budget-exceeded")) { // #4505: budget-exceeded too
      try {
        await post("FORGE:NEEDS_HUMAN", `## Needs human\n${laneRecoveryEvidence(reason, code, detail)}\n\n_${usageLine()}_`);
        await ghc(["issue", "edit", String(issue), "-R", repo, "--add-label", "needs-human"]);
      } catch { /* best effort */ }
    }
    if (["needs-human", "engine-error", "dependency-open", "dependency-blocked", "dependency-unreadable", "decomposed", "host-task"].includes(reason)) {
      const wf = ["investigating", "building", "in-review"].map((x) => `workflow:${x}`).join(",");
      try { await ghc(["issue", "edit", String(issue), "-R", repo, "--remove-label", wf]); } catch { /* best effort */ }
    }
    if (recover) { try { await ghc(["issue", "edit", String(issue), "-R", repo, "--remove-label", "workflow:recovering"]); } catch { /* best effort (#5647): the batch re-marks a requeued attempt */ } }
    if (["merged", "invalid", "needs-human", "budget-exceeded"].includes(reason)) {
      if (reason === "budget-exceeded") T.close = ["left open", "recoverable budget.exceeded"]; // #4505: not a human escalation
      else if (reason === "merged") T.close = [extra.keptOpen ? "left open (follow-up pending)" : extra.close === "partial" ? "issue closed (partial)" : "issue closed (completed)", "label workflow:merged"]; // #5159
      else if (reason === "invalid" && extra.close === "already-fixed") T.close = ["issue closed (completed)", "already fixed on the base"]; // #5080
      else if (reason === "invalid") T.close = ["issue closed (not planned)", "label workflow:invalid"];
      else { T.close = ["left open", "label needs-human"]; T.anomalies.push(`needs-human: ${String(detail).split("\n")[0].slice(0, 300)}`); }
      const postTrajectory = async () => { try { await post(["FORGE:TRAJECTORY", REGISTER_MARKER], renderTrajectory({ ...T, usage: usageLine() })); } catch { /* best effort */ } };
      if (deferTail) { postRun.add("lane-facts", postLaneFacts); postRun.add("trajectory", postTrajectory); } else await postTrajectory();
    }
    if (deferTail) postRun.add("teardown", () => teardown(reason, extra)); // last: the structure delta and guard read the worktree
    if (reason === "merged" || reason === "invalid") await clearPipelineLabels({ gh: ghc, repo, issue }); // #5592: a merged or closed issue keeps no needs-human / parked:* / remediation-queue
    await releaseLease(reason, code, extra.mergedTo ?? null);
    done = { terminalReason: reason, detail, branch, worktree: wt, cost_usd: usage.cost_usd, tokens: { input: usage.input, output: usage.output, cache: usage.cache }, wall_ms: now() - t0, model_ms: modelMs, phases: phaseLedger.snapshot(),
      ...(laneHead && reason !== "merged" ? { laneHead: { ...laneHead } } : {}), light, ...(lightVerdict ? { light_eligibility: lightVerdict } : {}), ...(lightUpgrade ? { light_upgrade: lightUpgrade } : {}), // #4453
      ...(Object.keys(waits).length ? { waits: { ...waits } } : {}), ...(followupsFiled.length ? { followups: followupsFiled.map((f) => ({ ...f })) } : {}), ...(pendingRecord().length ? { pendingFollowups: pendingRecord() } : {}), ...(heavyQueueMax ? { heavyQueueMax } : {}), ...(precheckRan ? { precheckMs, precheckDeferred } : {}),
      ...(firstPassOf(builderTriggers) != null ? { firstPass: firstPassOf(builderTriggers) } : {}), ...(tb.record() ? { turns: tb.record() } : {}), // #4392
      ...(route ? { builderRoute: { tier: route.tier, class: route.class, escalated, model: route.model ?? "default" } } : {}),
      ...(gateRan ? { conformance: { mode: conformance === "enforce" || riskEnforced ? "enforce" : "shadow", would: shadowWould, ...(adequacyCounts(adequacy) ? { test_adequacy: adequacyCounts(adequacy) } : {}), risk: Boolean(riskEnforced), ...(Object.keys(kinds).length ? { kinds: [...failureClasses] } : {}) } } : {}), ...extra };
    if (deferTail && o.deferPostRun) done.postRun = () => postRun.run(); // the caller runs it once the lane slot is free
    else await postRun.run();
    return done;
  }
  /** #4401: post the lane's FORGE:FACTS (result.json facts and validation, changed files, contract decisions); never fails a run. */
  async function postLaneFacts() {
    if (!base) return;
    try {
      const result = await readResult();
      const rec = result ? normaliseFacts(result, { files: await stageFiles(), contract: await readContract(), head: String(await git(["rev-parse", "HEAD"]).catch(() => "")).trim() }) : null;
      if (!rec) return;
      const body = renderFactsRecord(rec);
      if (factsSeen.some((b) => String(b ?? "").includes(body))) return;
      await post(FACTS_MARKER, body);
      T.decisions.push(`FORGE:FACTS: ${rec.rejected.length} rejected approach(es), ${rec.hotspots.length} hot spot(s) on ${rec.files.length} file(s)`);
    } catch { /* best effort */ }
  }
  /** #4297/#4316: a recovery lane that ended unmerged keeps needs-human with this evidence (shared text in render.mjs). */
  const laneRecoveryEvidence = (reason, code, detail) => recoveryEvidence({ code: recover.code, attempt: recover.attempt, outcome: reason, resultCode: code, detail });
  let closedDeps = []; // #4725: `Depends on` edges the live check found closed: satisfied, flagged in the needs-human comment
  /** #4730: an issue whose only content is an ask already registered on #existing is closed as a duplicate, linked; any extra content keeps it open. */
  async function duplicateAskIssue(existing, asks) {
    try {
      const v = JSON.parse(String(await ghc(["issue", "view", String(issue), "-R", repo, "--json", "title,body"])));
      if (!asks.some((a) => a && onlyAsk(v.title, v.body, a))) return false;
      await ghw(["issue", "close", String(issue), "-R", repo, "--reason", "not planned", "--comment", `Duplicate owner ask: its only content is the ask already recorded on #${existing}. Answering #${existing} covers this issue.`]);
      await label("invalid");
      T.decisions.push(`Closed as a duplicate of the owner ask on #${existing}`);
      return true;
    } catch { return false; }
  }
  const labelFailed = (step, e) => { // #4905: a failed needs-human comment/label call is recorded, not swallowed (the issue showed needs-human with no label)
    const error = String(e?.message ?? e).slice(0, 200);
    T.anomalies.push(`needs-human ${step} failed: ${error}`); ev({ event: "NEEDS_HUMAN_LABEL_FAILED", step, error });
  };
  async function needsHuman(why, code = OUTCOME_CODES.ENGINE_ERROR, { ask: askText, note: askNote = "", ...extra } = {}) {
    // #4725: a recorded premise (`Premise: <kind>:<arg>`) that already holds is no blocker: no label, the lane runs again.
    const predicate = parsePredicate(why);
    if (predicate && (!recover || recover.final) && await evalPredicate(predicate, { repo, io: { gh: ghc, pkgVersion: io.pkgVersion ?? registryPkgVersion } }) === true) {
      try { await post("FORGE:DECISION", `## Decision: no needs-human\n**What**: the recorded premise \`${predicate.kind}:${predicate.arg}\` already holds, so the label was not applied.\n**Why**: the blocker named an external fact that has since changed.\n**Alternative**: label needs-human and wait for the sweep to clear it.`); } catch { /* best effort */ }
      return finish("deferred", `premise ${predicate.kind}:${predicate.arg} holds; re-queued instead of needs-human`, { retryInSeconds: 30 });
    }
    if (!recover || recover.final) try {
      let link = "";
      if (code === OUTCOME_CODES.BUILDER_BLOCKED) { // #4725: one owner ask, linked across issues
        const reg = await registerAsk({ repo, io: { gh: ghc }, issue, ask: why });
        if (reg.existing && (!recover || recover.final) && await duplicateAskIssue(reg.existing, [why, askText])) return finish("invalid", `only content is the owner ask of #${reg.existing}; closed as a duplicate`); // #4730
        link = reg.existing ? `Same owner ask as #${reg.existing} (one ask, linked): answering it unblocks this issue too.` : reg.entry ?? "";
      }
      const notes = [premiseAnnotation(predicate), closedEdgeNote(closedDeps), link, askNote].filter(Boolean).join("\n");
      try { await post("FORGE:NEEDS_HUMAN", `## Needs human\n${why}${notes ? `\n\n${notes}` : ""}${recoverUnlabelled ? `\n\n${laneRecoveryEvidence("needs-human", code, "")}` : ""}\n\n_${usageLine()}_`); }
      catch (e) { labelFailed("comment", e); }
      // #5423: an environment gap is the engine's to recover (the batch requeues it), so a first lane leaves the issue visible; a final recovery lane still labels
      if (!(!recover && ENV_ENGINE_OWNED_CODES.includes(code))) {
        try { await ghc(["issue", "edit", String(issue), "-R", repo, "--add-label", "needs-human"]); }
        catch (e) { labelFailed("label", e); }
      }
    } catch { /* best effort */ }
    return finish("needs-human", why, { code, ...extra, ...(recover ? { recovery: true } : {}) }, code);
  }

  // ---- stage notes: investigation.md, plan.md, implementation.md become their own comments ----
  const STAGES = [
    { key: "investigation", file: INVESTIGATION_FILE, marker: ["FORGE:INVESTIGATION", "FORGE:VALIDATE"], render: (md, ctx) => renderInvestigation(md, ctx.result) },
    { key: "implementation", file: IMPLEMENTATION_FILE, marker: ["FORGE:IMPLEMENTATION"], render: (md, ctx) => renderImplementation(md, ctx.result, { branch, files: ctx.files }) },
  ];
  const posted = {}; // key -> comment url (or "" when posted without a link)
  let stampHash = null; // #5333: the frozen contract hash the stage notes are stamped with (set before the implement call)
  const stageBad = {}; // key -> true while the stage file on disk carries another issue's or contract's stamp
  const readStage = async (st) => {
    let md = null;
    try { md = await io.fs.read(`${wt}/${st.file}`); } catch { return null; }
    const c = checkStamp(md, { issue, hash: st.key === "implementation" ? stampHash : null });
    if (c.ok) { delete stageBad[st.key]; return c.md; }
    if (!stageBad[st.key]) { ev({ event: "STAGE_STAMP_MISMATCH", file: st.file, reason: c.reason }); T.anomalies.push(`${st.file} not posted: ${c.reason} (another lane's file, e.g. a git stash pop)`); }
    stageBad[st.key] = true;
    return null;
  };
  /** #5333: after the builder's final turn, a note posted live whose file now carries a foreign stamp is re-rendered from result.json. */
  async function recheckStages(keys) {
    for (const key of keys) {
      if (!(key in posted)) continue;
      await readStage(STAGES.find((x) => x.key === key));
      if (stageBad[key]) await upsertStage(key);
    }
  }
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
  let signoffEnv = {};
  const SIGNOFF_HOOK = '#!/bin/sh\nid=$(git var GIT_COMMITTER_IDENT 2>/dev/null | sed \'s/>.*/>/\')\ncase "$id" in ""|*@localhost\\>) ;; *) git interpret-trailers --in-place --if-exists addIfDifferent --trailer "Signed-off-by: $id" "$1" ;; esac\n';
  /** #5437: builder commits are signed off when made (a worktree commit-msg hook via GIT_CONFIG_*, the repo's own hooks chained), so signOffUnpushed finds nothing to rewrite. Best effort: without it the rewrite stays the fallback. */
  async function installSignoffHook() {
    if (!runTmp || !io.fs?.list || !io.runCommand) return;
    try {
      const orig = String(await git(["rev-parse", "--git-path", "hooks"])).trim(), abs = orig.startsWith("/") ? orig : `${wt}/${orig}`, dir = `${runTmp}/hooks`;
      const q = (x) => `'${String(x).replace(/'/g, "'\\''")}'`, own = ((await io.fs.list(abs)) ?? []).filter((n) => n && !n.endsWith(".sample"));
      for (const n of own.filter((x) => x !== "commit-msg")) await io.fs.write(`${dir}/${n}`, `#!/bin/sh\nexec ${q(`${abs}/${n}`)} "$@"\n`);
      await io.fs.write(`${dir}/commit-msg`, `${SIGNOFF_HOOK}${own.includes("commit-msg") ? `exec ${q(`${abs}/commit-msg`)} "$@"\n` : "exit 0\n"}`);
      const x = await io.runCommand({ command: `chmod +x ${q(dir)}/*`, cwd: wt, timeoutMs: 10000, env: laneEnv() }), r = x?.r ?? x;
      if (r?.exit) throw new Error("chmod failed");
      signoffEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: dir };
      ev({ event: "SIGNOFF_HOOK", dir });
    } catch { signoffEnv = {}; }
  }
  function laneEnv() {
    let deps = {};
    try { deps = io.deps?.env?.() ?? {}; } catch { deps = {}; }
    const par = verifyParallelism();
    return { ...deps, ...(runTmp ? { TMPDIR: runTmp } : {}), ...(par ? { FORGE_HOST_PARALLELISM: par } : {}), FORGE_LANE_WORKTREE: "1", ...sandboxEnv, ...(toolchain?.env ?? {}) }; // #5333: the hook denies git stash where this is set
  }
  /** #5168: a failed claude login ends the lane `deferred` `backend.auth`, held per account by the batch (never the relaunch or the breaker). */
  const authDeferral = (e) => Object.assign(e, { deferCode: OUTCOME_CODES.BACKEND_AUTH, retryInSeconds: AUTH_RETRY_SECONDS, backendId: laneBackendId(process.env, rotator),
    deferDetail: `claude CLI authentication failed (login expired or invalid); held until the login is fixed: ${String(e?.message ?? e).split("\n")[0].slice(0, 300)}` });
  /** #5236: no account has room: the lane ends deferred `quota.exhausted` (earliest reset) and emits QUOTA_EXHAUSTED, never a spawn or a far pause. */
  const exhaustedStop = (e, x, role) => { ev({ event: "QUOTA_EXHAUSTED", phase: role, earliestReset: x.earliestReset }); return exhaustedDeferral(e, { earliestReset: x.earliestReset, backendId: laneBackendId(process.env, rotator), now: now() }); };
  /** Runner call with the per-run TMPDIR and FORGE_HOST_PARALLELISM; a usage limit pauses and resumes the same step, or defers past the cap (#4101). */
  let firstSession = false, setupWait = null, firstCallAt = null, packDoneAt = null, spawnLogged = false; // #5434
  async function callRunner(args) {
    let pauses = 0, rotations = 0, pinned = null, credTries = 0;
    if (!firstSession) { firstSession = true; firstCallAt = now(); ev({ event: "FIRST_SESSION", ms: firstCallAt - t0, role: args.role ?? null, ...(packDoneAt != null ? { since_context_pack_ms: firstCallAt - packDoneAt } : {}) }); } // #5434: lane start to the first model session
    for (;;) {
      if (smartRotator && !pinned) { const x = poolExhausted(rotator, laneLimited); if (x) throw exhaustedStop(new Error("no account has capacity"), x, args.role); } // #5236: the shim would fall back to the default profile
      // #4181: every Docker resource the builder creates carries the lane's ownership labels (same batch/lane as the ledger).
      const labels = dockerLabels({ batch: o.batchId ?? "adhoc", lane: `lean-${issue}`, issue, expires: now() + LEDGER_TTL_MS }).join(" ");
      // #4169: heavy shims first on PATH; the phase/issue/priority label each heavy step's slot and wait record.
      const heavy = heavyEnv ? { ...heavyEnv, FORGE_LANE_PHASE: args.role === "builder" ? stage : String(args.role ?? "step"), FORGE_LANE_ISSUE: String(issue), FORGE_LANE_PRIORITY: String(lanePriority()) } : {};
      const lp = args.profile === "narrow" && laneProfile.name !== "full" ? "narrow" : laneProfile.name, profEnv = lp === "full" ? {} : { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ...(lp === "lane" || lp === "narrow" ? { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } : {}) };
      const system = lp === "lane" && !args.resume && !args.noTools ? [args.system, laneProfile.text].filter(Boolean).join("\n\n") : args.system;
      // #5205: capture the account the run uses (the shim exports it, then execs claude) and pin a rotation relaunch.
      let account = pinned?.account ?? null;
      let watch = null; // #5268: the shim execs claude (same pid) after spawn, so keep reading until the account shows
      const spawnHook = smartRotator ? { onSpawn: (child, ...rest) => { if (account === null && !watch) { const pid = child?.pid ?? child; watch = watchAccount(() => rotator.accountOfPid(pid), { onFound: (a) => { account = a; } }); } return args.onSpawn?.(child, ...rest); } } : {};
      const pin = pinned ? { ...(pinned.bin ? { bin: pinned.bin } : {}) } : {};
      try { const res = await io.runner({ ...args, ...spawnHook, ...pin, system, env: { ...laneEnv(), ...signoffEnv, FORGE_DOCKER_LABELS: labels, COMPOSE_PROJECT_NAME: `forgedock-lane-${issue}`, ...(runTmp ? { CLAUDE_CODE_TMPDIR: runTmp } : {}), ...(toolchain?.env ?? {}), ...heavy, ...profEnv, ...(pinned?.env ?? {}) } }); watch?.stop(); return res; }
      catch (e) {
        watch?.stop(); watch?.refresh(); // #5268: the account the shim exec'd, read before the limited child is gone or now
        let epoch = Number.isFinite(e?.resetAtEpochMs) ? e.resetAtEpochMs : null;
        if (e?.authFailure === true && e.usageLimit !== true && epoch === null) { const x = smartRotator ? poolExhausted(rotator, laneLimited) : null; throw x ? exhaustedStop(e, x, args.role) : authDeferral(e); } // #5236: an auth failure with no account room is exhaustion // #5168: an account condition, never engine-error
        if (!(e?.usageLimit === true || epoch !== null)) throw e;
        if (smartRotator) { // #5205: exclude the limited account and relaunch the same args (resume kept) pinned to another, at once
          if (account !== null) { const until = epoch !== null && epoch > now() ? epoch : now() + DEFAULT_SESSION_LIMIT_WAIT_MS; laneLimited.set(account, until); try { rotator.markLimited(account, until); } catch { /* best effort */ } }
          let next = null;
          try { next = rotator.pick({ exclude: laneLimited }); } catch { next = null; }
          let size = 0; try { size = rotator.accounts.length; } catch { size = 0; }
          if (Number.isInteger(next?.account) && rotations < size) {
            rotations++; laneRotations++;
            ev({ event: "PHASE_ACCOUNT_ROTATED", phase: args.role, from: account, to: next.account });
            pinned = { account: next.account, bin: rotator.realClaude() ?? null, env: { CLAUDE_CONFIG_DIR: rotator.configDir(next.account) } };
            continue;
          }
          if (next && next.account === null) throw exhaustedStop(e, { earliestReset: Number.isFinite(next.earliestReset) ? next.earliestReset : null }, args.role); // #5236
        } else if (rotatorRetry(rotator, rotations)) { rotations++; laneRotations++; ev({ event: "PHASE_ACCOUNT_ROTATED", phase: args.role }); continue; } // #5094: same args (resume too), next account
        else if (!rotator && sandboxCred && credTries < SANDBOX_CRED_RETRIES) { // #5205: a sandbox reports the limit; the router hands another login
          credTries++;
          let ok = false;
          try { ok = (await credExec(["claude", "--limited", epoch !== null ? String(Math.round(epoch / 1000)) : "unknown"]))?.status === 0; } catch { ok = false; }
          if (ok) { laneRotations++; ev({ event: "PHASE_ACCOUNT_ROTATED", phase: args.role, via: "cs-cred" }); continue; }
          credTries = SANDBOX_CRED_RETRIES; // the router has no login with room (429): the existing defer
        }
        const waitMs = epoch !== null && epoch > now() ? epoch - now() : DEFAULT_SESSION_LIMIT_WAIT_MS;
        if (pauses >= maxSessionLimitPauses || waitMs > sessionLimitMaxWaitMs) { e.deferUsageLimit = true; throw e; }
        pauses++; pinned = null; // after the wait the shim picks again
        ev({ event: "PHASE_RATE_LIMITED", phase: args.role, resetAt: epoch, resetAtDisplay: e.resetAt ?? null, waitMs });
        onProgress({ event: "phase_paused", phase: args.role, reason: "session-limit", detail: `session limit hit; pausing until ${e.resetAt || new Date(now() + waitMs).toISOString()}` });
        const limitedAt = now();
        await sleep(waitMs);
        phaseLedger.addWait(args.role === "review" ? "review" : stage, "rate_limit", now() - limitedAt); // #5349
      }
    }
  }

  /** git push with transient retry (#4114): 4 attempts; permission/protected-branch rejections fail at once. */
  /** #4651: the commits a push would add are signed off with the lane identity first (placeholder or unsigned ones are rewritten; pushed ones never). */
  const signOffUnpushed = async () => {
    try {
      const r = await ensureSignedOff({ git, lane, branch });
      if (r.rewritten) { T.decisions.push(`Rewrote ${r.rewritten} unpushed commit(s) with the lane identity and a sign-off (placeholder author or no Signed-off-by, #4651)`); ev({ event: "DCO_SIGNOFF_REWRITE", count: r.rewritten, ...(r.dirty ? { dirty: r.dirty } : {}) }); }
    } catch (e) { throw Object.assign(e, e?.noIdentity === true ? { laneCode: OUTCOME_CODES.CI_DCO } : { engineCode: OUTCOME_CODES.ENGINE_DCO_REWRITE }); } // #4997: a failed rewrite is mechanical (engine-error, recoverable), only a missing identity is a human block
  };
  /** #5202: the lane's own pushed checkpoints a fresh session amended are merged in (-s ours) so the push stays a fast-forward. */
  const reconcileLaneBranch = async () => {
    const r = await reconcileCheckpoints({ git, branch });
    if (r.state === "reconciled") {
      ev({ event: "CHECKPOINT_RECONCILED", count: r.commits.length, sha: r.sha });
      T.decisions.push(`origin/${branch} held ${r.commits.length} pushed checkpoint commit(s) the lane had rewritten locally: merged in (-s ours, ${r.sha.slice(0, 10)}) so the push stays a fast-forward`);
    } else if (r.state === "foreign" || r.state === "error") ev({ event: "CHECKPOINT_RECONCILE_SKIPPED", state: r.state, ...(r.commits ? { commits: r.commits.length } : {}), ...(r.error ? { error: r.error } : {}) });
    return r;
  };
  const gitPush = async (args) => {
    if (!args.includes("--delete")) { await untrackToolState({ git, base, ev, keep: await keepPaths() });
      await reconcileLaneBranch();
      try { await signOffUnpushed(); }
      catch (e) { // #4905: a failed rewrite must not cost the lane's finished commits: push them as-is before reporting; #5047: to a salvage ref, never the lane branch (the sign-off range excludes origin/<branch>)
        if (!e?.noIdentity) { try { const sha = String(await git(["rev-parse", "HEAD"])).trim(), ref = salvageBranch(issue, sha); await git(["push", "origin", `${sha}:refs/heads/${ref}`]); laneHead = { branch, sha, pushedTo: ref }; ev({ event: "DCO_RESCUE_PUSH", branch: ref }); } catch (pe) { ev({ event: "DCO_RESCUE_PUSH_FAILED", error: String(pe?.message ?? pe).slice(0, 200) }); } }
        throw e;
      }
    } // #4590: never push .forge-lean/ or tool caches this branch added
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
      if (dirty) { await git(["add", "-A"]); if (await unstageToolState(git)) await git(["commit", "--no-verify", "-m", `wip(forge): checkpoint after ${reason}`]); } // #4590: tool state is never staged
      const ahead = String(await git(["diff", "--name-only", `${base}...HEAD`])).trim();
      if (ahead) { laneHead = { branch, sha: String(await git(["rev-parse", "HEAD"])).trim(), pushedTo: null }; await gitPush(["push", "-u", "origin", branch]); laneHead.pushedTo = branch; }
      ev({ event: "CHECKPOINT", reason, dirty: Boolean(dirty), pushed: Boolean(ahead) });
      return true;
    } catch (e) { ev({ event: "CHECKPOINT_FAILED", reason, error: String(e?.message ?? e).slice(0, 300) }); return laneHead ? await rescuePush(reason, e?.pushRejected || e?.engineCode === OUTCOME_CODES.ENGINE_DCO_REWRITE) : false; }
  }
  /** #4958: the normal push failed (sign-off rewrite, rejection): push HEAD as is to the lane branch, else to a salvage branch, so a torn-down remote sandbox never takes the commits with it. */
  async function rescuePush(reason, rejected) {
    // #5014: gitPush untracks tool state and rewrites unpushed commits for DCO before it pushes, so HEAD may have moved since the capture
    try { const now = String(await git(["rev-parse", "HEAD"])).trim(); if (now) laneHead.sha = now; } catch { /* keep the captured sha */ }
    // a rejected lane-branch push (protected branch, permissions) would be rejected again: go straight to the salvage branch
    for (const ref of [...(rejected ? [] : [branch]), salvageBranch(issue, laneHead.sha)]) {
      try {
        await git(["push", "origin", `${laneHead.sha}:refs/heads/${ref}`]);
        laneHead.pushedTo = ref;
        ev({ event: "CHECKPOINT_RESCUED", reason, ref, sha: laneHead.sha });
        return !String(await git(["status", "--porcelain"])).trim(); // an uncommitted remainder keeps the worktree
      } catch (e) { ev({ event: "CHECKPOINT_RESCUE_FAILED", reason, ref, error: String(e?.message ?? e).slice(0, 300) }); }
    }
    return false;
  }
  /** #4958: where the lane's commits ended up, for the terminal comment, RUN_TERMINAL and the returned result. */
  async function reportLaneHead(reason) {
    if (!laneHead || reason === "merged") return;
    const { branch: b, sha, pushedTo } = laneHead;
    const line = pushedTo ? `Lane commits pushed: branch \`${pushedTo}\` at ${sha.slice(0, 10)}; a rerun or --requeue resumes from it` : `Lane commits NOT pushed: ${sha.slice(0, 10)} on \`${b}\` exists only in this lane's worktree and is lost if its sandbox is torn down`;
    T.anomalies.push(line);
    if (!["invalid", "needs-human", "budget-exceeded"].includes(reason)) { try { await post("FORGE:LANE_BRANCH", `## Lane branch\n${line}`); } catch { /* best effort */ } }
  }
  const CONTINUE_NOTE = "\n\nThe branch already holds work from an earlier session that was interrupted (see the latest `wip(forge): checkpoint` commit). Continue from it: read `git log` and `git diff origin/BASE...HEAD`, do not start over. The checkpoint commit is already pushed: do not amend, reword, squash, reset or rebase existing commits; add new commits on top.";
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
        else if (ok && paused) { control.resume?.(); paused = false; forced = false; addWait(stage, nowMs - pausedAt, 0, "host_load"); ev({ event: "LANE_RESUMED", reason: "host recovered" }); }
        else if (ok) forced = false;
        else if (paused && nowMs - pausedAt >= maxPauseMs) { control.resume?.(); paused = false; forced = true; addWait(stage, nowMs - pausedAt, 0, "host_load"); ev({ event: "LANE_RESUMED", reason: "max pause reached" }); }
      }
    })();
    return { async stop() { stopped = true; wake?.(); clearTimeout(t); await loop; if (paused) { control.resume?.(); paused = false; addWait(stage, Date.now() - pausedAt, 0, "host_load"); } } };
  }

  /** A timeout restart starts a fresh session; by default it continues the implementation against the frozen contract. */
  let facts = null; // #4272: path of an optional .forge/repo-facts.json (worktree, then main checkout), cited in builder prompts
  const tcOpts = () => ({ toolchain: toolchain?.summary ?? null, sparse, ...(facts ? { facts } : {}), stamp: stampText({ issue, hash: stampHash }) });
  let hotFacts = null; // forge#4195: scripts/hotspots.sh facts for the files the issue names, read once before the plan call
  let enumList = []; // #4322: tests enumerating the members of the paths the issue names, read once before the plan call
  let decisionsNote = ""; // #4901: trusted FORGE:DECISION comments newer than the frozen contract, "" otherwise
  let carriedPasses = []; // #5331: validate ids that passed on the resume head (resume digest); carried into the builder result while HEAD is unchanged
  let resumeNote = ""; // #4400: the resume digest of the last run (resume.mjs), "" on a first run or with context_pack off
  let uiOn = false; // #5330: the lane changes user-visible frontend (issue text, then contract deliverables): the design-system and visual self-check rules join its prompts
  const implementRestart = () => builderImplementPrompt(vcfg.mode, tcOpts()) + seqBuildNote + hotspotBuildRule(hotFacts) + enumeratingBuildRule(enumList) + invariantsBuildRule(vcfg.invariants) + exploreBuildRule(exploreCfg) + uiBuildRule(uiOn, designConfig) + CONTINUE_NOTE.replace("BASE", lane) + resumeNote;
  /** #5334: records a builder session that ended without its result line (kill, signal) as one attempt; `at` = its start. */
  const killedAttempt = (n, e, opts, at) => attempt("implement", n, { killed: true, usage: e.usage ?? null, turns: e.turns ?? null, tools: toolStats(e.toolUses), costUsd: null, durationMs: now() - at, model: opts.model ?? laneModel() ?? null }, opts.mode, opts.trigger, opts.restartOf);
  async function flushInflight() {
    const cur = inflight;
    if (!cur || cur.flushed) return;
    cur.flushed = true;
    let snap = null; try { snap = cur.session.snapshot?.() ?? null; } catch { snap = null; }
    try { await killedAttempt(cur.n, snap ?? {}, cur.opts, cur.at); } catch { /* telemetry never blocks the teardown */ }
  }
  /** #4390: builder calls stopped at the context ceiling restart fresh; planning (and its corrections) run uncapped. */
  let laneCeiling = contextCeilingTokens; // #5346: set to the lane size's ceiling once the contract is frozen
  const UNCEILED = ["plan", "contract_correction", "block_correction"], CONTEXT_RESTARTS_MAX = 3;
  async function builder(n, prompt, resume, live = false, restart = implementRestart, opts = {}) {
    let timeoutRetries = 0, contextRestarts = 0, p = prompt;
    opts = { ...opts };
    const ceiled = laneCeiling > 0 && !opts.noCeiling && !UNCEILED.includes(opts.trigger); // #5346: per-size ceiling; noCeiling = a restart is certain
    for (;;) {
      // after CONTEXT_RESTARTS_MAX restarts the call runs uncapped: a loop guard, never a refusal of work
      opts.contextMax = ceiled && contextRestarts < CONTEXT_RESTARTS_MAX ? laneCeiling : 0;
      const budgeted = stage === "implement" && tb.on(); // #4392: the build and its restarts spend the implement turn budget
      if (budgeted && tb.remaining() <= 0) return await budgetWrapup(n, opts);
      opts.turnMax = budgeted ? tb.remaining() : 0;
      try { return await builderOnce(n, p, resume, live, opts); } catch (e) {
        if (e?.code === "CLI_TURNS") {
          await attempt("implement", n, { usage: e.usage ?? null, turns: e.turns ?? null, tools: toolStats(e.toolUses), costUsd: null, model: opts.model ?? builderModel ?? null }, opts.mode, opts.trigger, opts.restartOf);
          return await budgetWrapup(n, opts);
        }
        if (e?.code === "CLI_CONTEXT") {
          contextRestarts++;
          ev({ event: "CONTEXT_CEILING", context_tokens: e.context ?? null, ceiling: laneCeiling, turns: e.turns ?? null, trigger: opts.trigger ?? null, restart: contextRestarts, last_tool: e.lastTool?.name ?? null });
          await attempt("implement", n, { usage: e.usage ?? null, turns: e.turns ?? null, tools: toolStats(e.toolUses), costUsd: null, model: opts.model ?? laneModel() ?? null }, opts.mode, opts.trigger, opts.restartOf);
          await checkpoint("context ceiling");
          T.decisions.push(`Builder session reached ${e.context ?? "?"} context tokens (ceiling ${laneCeiling}): checkpointed, restarted fresh from the contract, diff and last validate result`);
          p = restart() + await contextRestartNote(handoffFacts(e.toolUses, e.lastTool)); resume = null; opts.restartOf ??= opts.trigger ?? null; opts.trigger = "context_restart";
          continue;
        }
        if (["CLI_LANE_LIMIT", "CLI_IDLE", "CLI_TIMEOUT"].includes(e?.code) || isExternalKill(e)) { // #5334: a kill still spent tokens: record them before the checkpoint and retry
          if (!e.usageRecorded) await killedAttempt(n, e, opts, e.sessionAt ?? now());
        }
        if (e?.code === "CLI_LANE_LIMIT") { // #4690: the lane hit its own scope limit: a rerun hits it again, so typed needs-human (env.lane_limit), never engine-error
          ev({ event: "CLI_LANE_LIMIT", limit: e.limit ?? null, unit: e.unit ?? null });
          await checkpoint(`scope ${e.limit} limit`);
          e.laneCode = OUTCOME_CODES.ENV_LANE_LIMIT;
          e.message = `The lane hit its own ${e.limit === "memory" ? "MemoryMax (memory)" : "TasksMax (process count)"} scope limit and was stopped; work checkpointed to ${branch}. Raise engine.lane_limits.${e.limit === "memory" ? "memory_max" : "tasks_max"} in forge.yaml if the work is legitimate, or find the runaway step.`;
          throw e;
        }
        const hostKilled = isExternalKill(e); // #4518: SIGTERM/143 we did not send restarts like a timeout, and never ends engine-error
        if (!(hostKilled || e?.code === "CLI_IDLE" || e?.code === "CLI_TIMEOUT")) throw e;
        const idle = e.code === "CLI_IDLE";
        const reason = hostKilled ? "host kill" : idle ? "idle timeout" : "timeout";
        ev({ event: hostKilled ? "CLI_HOST_KILL" : idle ? "CLI_IDLE_KILL" : "CLI_TIMEOUT_KILL", reason, lastTool: e.lastTool ?? null, children: e.children ?? [],
          ...(idle ? { heavyQueue: e.heavyQueue ?? null, extended: e.extended === true } : {}) });
        await checkpoint(reason);
        if (timeoutRetries++ >= 1) { e.deferCode = hostKilled ? OUTCOME_CODES.CLI_HOST_KILLED : idle ? OUTCOME_CODES.CLI_IDLE : OUTCOME_CODES.CLI_TIMEOUT; e.deferDetail = `builder ${reason}; work checkpointed to ${branch}; rerun resumes from it. ${String(e.message).slice(0, 300)}`; throw e; }
        T.anomalies.push(`builder ${reason}: checkpointed, retried once`);
        T.decisions.push(`Builder ${reason}: uncommitted work checkpointed to the lane branch; retrying once from the checkpoint`);
        p = restart(); resume = null; opts.restartOf ??= opts.trigger ?? null; opts.trigger = "timeout_restart";
      }
    }
  }

  /** #4405: a silent builder is busy (idle window extended) while a child is a heavy step or its heavy-queue entry is queued/running. */
  function sessionBusy(children) {
    const work = children.filter((c) => isHeavyProcess(c.cmd));
    let heavyQueue = null;
    try { heavyQueue = io.heavy?.lane?.(children.map((c) => c.pid)) ?? null; } catch { heavyQueue = null; }
    return work.length || heavyQueue?.queued > 0 || heavyQueue?.running > 0 ? { children: work, heavyQueue } : null;
  }

  /** opts (#4363): {model, mode, keepSession, trigger and restartOf (#4362)}; a fresh fix session keeps the build session id for a fallback resume. */
  async function builderOnce(n, prompt, resume, live = false, { model = null, mode = null, keepSession = false, trigger = null, restartOf = null, contextMax = 0, turnMax = 0, profile = null } = {}) {
    onProgress({ event: "phase_enter", phase: "build" });
    await renew();
    if (wtCreated && io.fs.exists && !(await io.fs.exists(wt))) throw Object.assign(new Error("lane worktree is gone"), { deferCode: OUTCOME_CODES.RUN_INTERRUPTED, deferDetail: `worktree ${wt} no longer exists; no builder session starts in it, a rerun recreates it` }); // #5333
    const lock = await takeBranchLock();
    try { return await builderSession(); } finally { try { lock?.release(); } catch { /* best effort */ } }
    async function builderSession() {
    const control = {};
    const governor = startGovernor(control);
    let spawned = null;
    const onSpawn = (child) => { if (!spawnLogged && firstCallAt != null) { spawnLogged = true; ev({ event: "LANE_SETUP_TIMING", step: "cli_init", ms: now() - firstCallAt }); } // #5434: runner call to process spawn
      if (Number.isSafeInteger(child?.pid) && !finishing) { spawned = child.pid; ledgerDo((l) => l.register("pid", child.pid, { marker: basename(String(child.spawnfile ?? "")) || null })); } };
    const session = {}, cur = inflight = { n, session, at: now(), flushed: false, opts: { model, mode, trigger, restartOf } };
    const call = Promise.resolve(callRunner({ role: "builder", issue, cwd: wt, model: model ?? laneModel(), resume, system: "", prompt, control, ...(profile ? { profile } : {}), onSpawn, session, agents: explorerAgents(exploreCfg), rereadNudge: true,
      idleMs: Math.round(cliIdleMinutes * 60000), maxMs: Math.round(cliMaxMinutes * 60000), laneLimits, ...(contextMax > 0 ? { contextMax } : {}), ...(turnMax > 0 ? { turnMax } : {}),
      busy: sessionBusy, busyMs: Math.round(cliBusyMinutes * 60000),
      onIdleExtend: (info) => ev({ event: "CLI_IDLE_EXTENDED", children: info.children, heavyQueue: info.heavyQueue }) }));
    call.catch((err) => { if (err && typeof err === "object") { err.sessionAt = cur.at; if (cur.flushed) err.usageRecorded = true; } }); // #5334
    call.then(() => {}, () => {}).finally(() => { if (inflight === cur) inflight = null; if (spawned) ledgerDo((l) => l.release("pid", spawned)); });
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
    await attempt("implement", n, profile && r ? { ...r, laneProfile: profile === "narrow" && laneProfile.name === "full" ? "full" : profile } : r, mode, trigger, restartOf, resume);
    onProgress({ event: "phase_exit", phase: "build", status: "committed" });
    return r;
    }
  }
  /** #5333: one writer per lane branch. A second session (a fix-up beside a recovery) waits for the holder, then defers `host.busy`. Fail-open when the shared git dir is unknown. */
  async function takeBranchLock() {
    let dir = null;
    try { const d = String(await io.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: wt })).trim(); if (d.startsWith("/") && existsSync(d)) dir = d; } catch { dir = null; }
    if (!dir) return null;
    let lock;
    try { lock = await acquireBranchLock({ gitCommonDir: dir, branch, owner: agentId, waitMs: o.branchLockWaitMs ?? 600000, pollMs: o.branchLockPollMs ?? 15000, sleep: async (ms) => { await renew(); await sleep(ms); } }); } catch { return null; }
    if (lock.ok) return lock;
    throw Object.assign(new Error(`lane branch ${branch} is being written by another session`), { deferCode: OUTCOME_CODES.HOST_BUSY, retryInSeconds: 120, deferDetail: `another session (pid ${lock.holder?.pid ?? "?"}, ${lock.holder?.owner ?? "?"}) holds the writer lock of ${branch}; retried later` });
  }
  /** #4390: the restart summary: `git diff --stat` and hunks against the lane base, and the last `forgedock check` record. */
  async function restartFacts() {
    const ex = [".", `:!${LEAN_DIR}`];
    const stat = String(await git(["diff", "--stat", `${base}...HEAD`, "--", ...ex]).catch(() => "")), diff = String(await git(["diff", `${base}...HEAD`, "--", ...ex]).catch(() => ""));
    let check = "";
    try { check = String(await io.fs.read(`${wt}/${SELF_CHECK_FILE}`)); } catch { /* none recorded */ }
    return { stat, diff, base, check };
  }
  /** #5346: bytes of the contract's deliverable files that exist in the worktree (capped at 60 files); 0 for the rest. */
  const namedFileBytes = async (c) => {
    let n = 0;
    for (const d of [...new Set((c?.deliverables ?? []).map((x) => x?.path).filter((x) => typeof x === "string" && x))].slice(0, 60)) { try { n += Buffer.byteLength(String(await io.fs.read(`${wt}/${d}`) ?? "")); } catch { /* new file */ } }
    return n;
  };
  const contextRestartNote = async (established = null) => contextRestartPrompt({ ...await restartFacts(), ceiling: laneCeiling, established });
  /**
   * #4392: the implement turn budget is spent. Checkpoint, then one fresh session of `wrapupGrant` turns either finishes
   * (its result flows on as usual) or stops with a digest; a stop or an overrun ends the non-human `budget-exceeded` reason
   * (#4505: no label, no NEEDS_HUMAN comment; the batch recovers it at the next size), needs-human only in a final budget.exceeded recovery.
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
      await attempt("implement", n, { usage: e.usage ?? null, turns: e.turns ?? null, tools: toolStats(e.toolUses), costUsd: null, model: opts.model ?? builderModel ?? null }, opts.mode, wopts.trigger, wopts.restartOf);
      await checkpoint("turn budget wrap-up");
    }
    const res = await readResult();
    if (!overran && res?.status !== "budget-exceeded") return r;
    ev({ event: "TURN_BUDGET_STOP", size, budget, turns: tb.record().build, overran });
    const digest = budgetDigest({ size, budget, used: tb.record().build, digest: res?.status === "budget-exceeded" ? res.digest : null, stat: facts.stat, check: facts.check });
    throw Object.assign(new Error(digest), { laneCode: OUTCOME_CODES.BUDGET_EXCEEDED });
  }
  const keepPaths = async () => ((await readContract())?.deliverables ?? []).map((d) => d?.path).filter((x) => typeof x === "string"); // #4959: deliverables are never untracked as generated files
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
    const lanePrs = lane ? laneMergedPrs(lane, io) : null;
    for (const d of b.issues) {
      let v;
      try { v = JSON.parse(String(await ghc(["issue", "view", String(d), "-R", repo, "--json", "state,labels"]))); } catch (e) {
        return { kind: "unreadable", detail: `dependency #${d} named by the builder could not be read: ${String(e?.message ?? e).slice(0, 200)}` };
      }
      // #4153 / #4337: a decomposed parent, open or closed, resolves to its open sub-issues; it is satisfied once they all
      // close. Without a usable trail the parent itself is the dependency, even when closed (fail closed).
      const decomposed = isDecomposedRecord(v) && ["OPEN", "CLOSED"].includes(String(v?.state).toUpperCase());
      if (!decomposed && String(v?.state).toUpperCase() !== "OPEN") { if (String(v?.state).toUpperCase() === "CLOSED" && !closedDeps.includes(d)) closedDeps.push(d); continue; }
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
        let full = null; // #4711: the REST record carries the body (FORGE:STATE mergedTo) and the author association
        if (lane) try { full = JSON.parse(String(await io.gh(["api", `repos/{owner}/{repo}/issues/${n}`])) || "null"); } catch { /* the PR-ancestry rule still applies */ }
        if (lane && await dependencyOnLane(n, lane, lanePrs ? await lanePrs : null, io, full)) continue; // #4686: its change is on the lane: neither open nor a needs-human blocker
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
    if (b.kind === "human" && b.why === "credentials" && o.placement?.where === "remote") {
      // #4542: the sandbox relays none of the host's capabilities; a block naming only declared ones is an environment error the host recovers.
      const caps = hostCapabilityBlock(s, o.hostCaps);
      if (caps.length) return await needsHuman(`Remote sandbox lacks host capability ${caps.join(", ")} (Builder is blocked (credentials)): ${s}\n\nThe dispatching host has it; the lane is recovered locally.`, OUTCOME_CODES.ENV_CAPABILITY_REMOTE);
    }
    if (b.kind === "human" && b.why === "credentials" && READONLY_PROD_RE.test(s) && !EXTERNAL_NEED_RE.test(s)) {
      // #5080: read-only production access with no credential/spend/account need is host work: recovered on the host, never a human ask
      T.decisions.push("Builder block: read-only production access is host work (host-task), not an owner ask");
      if (o.placement?.where !== "remote") { // on the host already: a host task (label host-task), never needs-human
        const why = `Host-task: the lane needs read-only production access (Builder is blocked (credentials)): ${s}\n\nNot a credential or an owner ask: run it on the host with its read-only prod tools.`;
        try { await post("FORGE:HOST_TASK", `## Host task\n${why}\n\n_${usageLine()}_`); } catch { /* best effort */ }
        try { await ghc(["issue", "edit", String(issue), "-R", repo, "--add-label", "host-task"]); } catch { /* best effort */ }
        return await finish("host-task", why, { code: OUTCOME_CODES.ENV_CAPABILITY_REMOTE }, OUTCOME_CODES.ENV_CAPABILITY_REMOTE);
      }
      return await needsHuman(`Host-task: the lane needs read-only production access, which the dispatching host has (Builder is blocked (credentials)): ${s}\n\nNot a credential: the lane is recovered on the host.`, OUTCOME_CODES.ENV_CAPABILITY_REMOTE);
    }
    if (b.kind === "human" && b.why === "credentials" && o.placement?.where === "remote" && missingToolBlock(s)) {
      // #4685: a tool the sandbox lacks (docker, promtool, a Python module) is an environment gap the host recovers, never a credential.
      return await needsHuman(`Remote sandbox lacks a validate tool (Builder is blocked (credentials)): ${s}\n\nNot a credential: the lane is recovered where the tool exists.`, OUTCOME_CODES.ENV_TOOL_MISSING);
    }
    if (b.kind === "human") {
      // #4730: the agent-doable remainder is re-queued as its own lane; only the owner step keeps needs-human.
      let note = "";
      if (b.remainder?.length) {
        try {
          const filed = await fileRemainder({ repo, io: { gh: ghc, create: ghw }, issue, items: b.remainder, milestone });
          T.decisions.push(`Builder block: remainder re-queued as ${refs(filed)}; #${issue} keeps only the owner step`);
          note = `The agent-doable remainder was re-queued as ${refs(filed)}; this issue keeps only the owner step.`;
        } catch (e) { return await finish("engine-error", `filing the remainder issues failed: ${e?.message ?? e}`); }
      }
      return await needsHuman(`Builder is blocked (${b.why}): ${s}`, OUTCOME_CODES.BUILDER_BLOCKED, { ask: s, note });
    }
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
    if (b.kind === "design-invalidated") { // #5342: one amendment issue, siblings held behind it, decision superseded
      const epic = epicOf(b, iss?.body);
      if (!epic) return await needsHuman(`Builder reported a design-invalidated block but no epic: set "epic" or a **Parent** line (${b.decision}): ${s}`, OUTCOME_CODES.BUILDER_BLOCK_UNTYPED);
      let f;
      try { f = await fileAmendment({ gh: ghc, create: ghw, repo, issue, inv: b, epic, milestone }); } catch (e) { return await finish("engine-error", `filing the spike amendment failed: ${e?.message ?? e}`); }
      T.decisions.push(`Builder block: design invalidated (${b.decision}); amendment #${f.amendment} ${f.created ? "filed" : "joined"}, held ${refs(f.held)}`);
      try { await post(REPLAN_MARKER, `## Design invalidated\n${b.decision}\n\nWhy: ${b.why}\n\nAmendment: #${f.amendment}; held until it merges: ${refs(f.held)}.\n\n${s}`); } catch { /* best effort */ }
      if (b.paths.length) try { await recordDecisions([{ choice: `${b.decision} no longer holds; replaced by the amendment`, why: b.why, anchors: b.paths, ...(b.supersedes ? { supersedes: b.supersedes } : {}) }], { issue: f.amendment, repo, post }); } catch { /* the register is best effort */ }
      return await finish("dependency-open", `design invalidated; waiting on amendment #${f.amendment}`, { code: OUTCOME_CODES.DESIGN_INVALIDATED, dependencies: [f.amendment], amendment: f.amendment, epic }, OUTCOME_CODES.DESIGN_INVALIDATED);
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
      const why = rationaleLine(b.rationale);
      T.decisions.push(`Builder block: split into ${refs(filed)} (${why})`);
      for (const e of b.serialized ?? []) T.decisions.push(`Serialised sub-issue #${filed[e.from]} behind #${filed[e.to]}: both edit ${e.files.slice(0, 5).join(", ")} (#4385)`);
      let marked = false;
      try { await post("FORGE:DECOMPOSED", `## Split into sub-issues\n${filed.map((n, i) => `- #${n} ${b.subissues[i].title}`).join("\n")}\n\nRationale: ${why}\n\n${s}`); marked = true; } catch { /* best effort */ }
      // #4337: with decomposition.close_parent, the tracker closes only once its trail and label exist: dependents then wait on the sub-issues, not on it.
      if (await label("decomposed") && marked && closeParent) {
        try {
          // #5152: the scope moved to the sub-issues, it was not dropped: `completed`, never `not planned`
          await ghw(["issue", "close", String(issue), "-R", repo, "--reason", "completed", "--comment",
            `Decomposed into ${refs(filed)}; this tracker is closed and its dependents wait on the sub-issues. A trusted \`FORGE:DECOMPOSED:REVOKED\` reopens it.`]);
          T.decisions.push(`Closed the decomposed parent (completed; scope moved to sub-issues); tracked by ${refs(filed)}`);
        } catch { /* best effort: the parent stays open, as before #4337 */ }
      }
      return await finish("decomposed", `split into ${refs(filed)}`, { code: OUTCOME_CODES.DECOMPOSED, subissues: filed, decomposition: b.rationale });
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
    const laneIo = { ...io, gh: (a, opts) => refreshAuthOnce(() => io.gh(a, opts), { refresh: io.refreshAuth ?? runRefreshScript, state: authState }) }; // #4662
    const r = await resolveLane({ issue, repo, io: laneIo, cwd, branches, requested: requestedLane, override: laneOverride });
    if (!r.ok && GH_AUTH_RE.test(r.detail ?? "")) return { terminalReason: "deferred", code: OUTCOME_CODES.GH_AUTH, detail: r.detail, retryInSeconds: GH_AUTH_RETRY_SECONDS }; // #4662: a dead token is not a lane problem
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
    try { dep = await openDependency(issue, io, { lane }); } catch (e) { dep = { unreadable: true, detail: `issue ${issue} **Depends on** check failed: ${e?.message || e}` }; }
    if (dep?.unreadable) return { terminalReason: "dependency-unreadable", code: OUTCOME_CODES.DEPENDENCY_UNREADABLE, detail: dep.detail };
    if (dep?.satisfied?.length) { // #4686: open on GitHub, but its PR is already on this lane
      const names = dep.satisfied.map((x) => `#${x.issue} (PR #${x.pr}, merge commit ${x.sha.slice(0, 12)} on origin/${lane})`).join(", ");
      T.decisions.push(`Dependency satisfied by lane merge: ${names}`);
      try { await post("FORGE:DEPENDENCY", `## Dependency satisfied\n${names} merged into ${lane}; the issue stays open until promotion, so the **Depends on** edge is met.`); } catch { /* best effort */ }
    }
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
    try { // #4920: read it back; a lane that wrote at the same moment and won leaves its id here, so this one defers
      const back = await io.projector.readState(issue);
      if (back?.lease && back.lease.until > now() && back.lease.by !== agentId && back.lease.by !== st?.lease?.by) { // a holder this lane just took over (dead) is not a racer
        return { terminalReason: "deferred", code: "lease-held", detail: `issue ${issue} leased by ${back.lease.by} until ${new Date(back.lease.until).toISOString()}`, branch, worktree: wt };
      }
    } catch { /* unreadable: proceed */ }
    leaseTimer = setInterval(() => { writeLease(leaseObj()).catch(() => {}); }, o.leaseRenewMs ?? 120000);
    leaseTimer.unref?.();
  }

  if (io.ledger) {
    try { ledger = io.ledger({ batch: o.batchId ?? "adhoc", lane: `lean-${issue}`, owner: agentId, issue, repo, host: myHost }); } catch { ledger = null; }
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
  ghCache = io.ghCache?.(runTmp) ?? null;
  ev({ event: "RUN_START", run: `core_${issue}_${t0}`, issue, lane, path: "core", version: ENGINE_VERSION, forge_version: ENGINE_VERSION, repo });
  await emit({ event: "RUN_START", run: `core_${issue}_${t0}`, lane, path: "core" }); // #4630: lifecycle event stream
  try {
    iss = JSON.parse(await ghc(["issue", "view", String(issue), "-R", repo, "--json", "number,title,body,state,comments,labels,updatedAt"]));
  } catch (e) {
    if (e?.deferCode) return finish("deferred", e.deferDetail ?? String(e.message), { code: e.deferCode, ...(e.retryInSeconds ? { retryInSeconds: e.retryInSeconds } : {}), ...(e.backendId ? { backendId: e.backendId } : {}) }, e.deferCode); // #4662; #5168 backendId
    return finish("engine-error", `cannot read issue: ${e.message}`);
  }
  const priorState = stateOf(iss.body); // #4400: the last run's end (the lease write keeps its terminal fields), read before this run ends
  if (String(iss.state).toUpperCase() === "CLOSED") {
    // #4337: a closed decomposed tracker is not "already done": its dependents wait on its sub-issues (the batch re-points
    // them). A trusted revocation reopens it and the run continues. An unreadable trail lists none (fail closed).
    if (!isDecomposedRecord(iss)) return finish("invalid", "issue already closed");
    if (await reopenRevokedDecomposition(issue, io)) iss.state = "OPEN";
    else return finish("decomposed", "closed decomposed tracker; dependents wait on its sub-issues", { code: OUTCOME_CODES.DECOMPOSED, subissues: (await decomposedSubissues(issue, io)) ?? [] });
  }

  try {
    // ---- 1. claim ----
    // #5435: the lane fetch is independent of the claim's GitHub writes; start it now and await it before the resume probe.
    const fetchP = step("fetch", async () => { try { await io.git(["fetch", "origin", lane], { cwd }); } catch { /* offline: use the local ref */ } });
    await step("claim", async () => {
    await label("investigating");
    // #5592: a live lane is not parked: needs-human, needs-human:*, parked:* and remediation-queue from an earlier run come off (a later park puts them back)
    await clearPipelineLabels({ gh: ghc, repo, issue, labels: iss.labels });
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
    });

    // ---- 2. worktree (resume an open PR / remote branch) ----
    await fetchP;
    let resumed = null, fromSalvage = false;
    // #5469: adopt: the open PR to the lane base that references this issue and was not made by the pipeline; its head branch is the lane branch
    let adoptPr = null;
    if (o.adopt) {
      await step("adopt_probe", async () => { try {
        const prs = JSON.parse(String(await ghc(["pr", "list", "-R", repo, "--state", "open", "--base", lane, "--json", "number,headRefName,body,closingIssuesReferences"])) || "[]");
        adoptPr = prs.find((x) => x.headRefName !== branch && ((x.closingIssuesReferences ?? []).some((r) => r.number === issue) || new RegExp(`#${issue}(?!\\d)`).test(x.body ?? ""))) ?? null;
      } catch { adoptPr = null; } });
      if (!adoptPr) return await needsHuman(`--adopt: no open PR to \`${lane}\` references #${issue} from a branch other than ${branch}; nothing to adopt.`, OUTCOME_CODES.LANE_MISMATCH);
      branch = adoptPr.headRefName;
      T.decisions.push(`Adopting PR #${adoptPr.number} (${branch}): review, base-sync and merge without a rebuild`);
    }
    await step("resume_probe", async () => { try {
      const [prsRaw, remoteRaw] = await Promise.all([ // #5435: independent network reads, in parallel
        ghc(["pr", "list", "-R", repo, "--head", branch, "--state", "open", "--json", "number,headRefOid,baseRefName"]),
        io.git(["ls-remote", "--heads", "origin", branch], { cwd })]);
      const prs = JSON.parse(String(prsRaw) || "[]");
      const remote = String(remoteRaw).trim();
      if (prs.length || remote) resumed = { pr: prs[0]?.number ?? null, base: prs[0]?.baseRefName ?? null };
      const salv = (await pickSalvage({ io, cwd, issue, branch, hasBranch: Boolean(remote) }).catch((e) => { ev({ event: "SALVAGE_PICK_FAILED", error: String(e?.message ?? e).slice(0, 200) }); return null; }))?.ref; // release #5068 delta SPEC-2: never silent // #4958, #5063: the newest salvage ref that is not behind the lane branch
      if (salv) { await io.git(["fetch", "origin", `${salv}:refs/remotes/origin/${branch}`], { cwd }); resumed = { pr: prs[0]?.number ?? null, base: prs[0]?.baseRefName ?? null }; fromSalvage = true; ev({ event: "RESUME_FROM_SALVAGE", ref: salv }); }
    } catch { /* no resume info: start fresh */ } });
    // An open PR on another base (a hand-retargeted PR, or one opened before lane resolution) is never merged (#4125).
    // #4593: a shipped milestone lane (fully merged into staging) cannot take new work; follow the open PR's live base.
    if (resumed?.base && resumed.base !== lane && !isDefaultLane(resumed.base, defaults)) {
      const staging = branches.staging || DEFAULT_STAGING_BRANCH;
      let baseOnOrigin = false;
      try { baseOnOrigin = !!String(await io.git(["ls-remote", "--heads", "origin", `refs/heads/${resumed.base}`], { cwd })).trim(); } catch { /* fail closed */ }
      if (baseOnOrigin && await isShippedLane({ lane, staging, io, cwd }) && !(await isShippedLane({ lane: resumed.base, staging, io, cwd }))) {
        T.decisions.push(`Lane ${lane} has shipped (merged into ${staging}); following open PR #${resumed.pr} base ${resumed.base}`);
        ev({ event: "LANE_FOLLOWED_PR_BASE", from: lane, to: resumed.base, pr: resumed.pr });
        lane = resumed.base; base = `origin/${lane}`;
      }
    }
    if (resumed?.base && resumed.base !== lane) {
      return await needsHuman(`Open PR #${resumed.pr} targets \`${resumed.base}\`, but #${issue}'s lane is \`${lane}\`; retarget or close it before rerunning.`,
        isDefaultLane(resumed.base, defaults) ? OUTCOME_CODES.LANE_DEFAULT_BRANCH : OUTCOME_CODES.LANE_MISMATCH);
    }
    if (!resumed && !recover) { // #5250: every acceptance item needs live production measurement or a real-browser capture: host work, not a code lane
      const hw = intakeHostWork(iss.body);
      if (hw.host) {
        T.decisions.push("Intake: every acceptance criterion needs live production measurement or a real-browser capture (host-task), no code lane");
        const why = `Host-task: every acceptance criterion needs live production measurement or a real-browser capture:\n${hw.items.map((t) => `- ${t}`).join("\n")}\n\nNot a code lane: run it on the host with its read-only prod tools and real browser.`;
        try { await post("FORGE:HOST_TASK", `## Host task\n${why}\n\n_${usageLine()}_`); } catch { /* best effort */ }
        try { await ghc(["issue", "edit", String(issue), "-R", repo, "--add-label", "host-task"]); } catch { /* best effort */ }
        return await finish("host-task", why, { code: OUTCOME_CODES.ENV_CAPABILITY_REMOTE }, OUTCOME_CODES.ENV_CAPABILITY_REMOTE);
      }
    }
    // #4162: a run that died can leave its runner writing into this worktree, and uncommitted work in it. Stop the
    // processes and save the work before the worktree is removed; the lease above makes this run the only one doing so.
    await step("salvage_cleanup", async () => {
    await stopWorktreeProcs();
    salvagedRef = await salvage("an earlier run");
    try { await io.git(["worktree", "remove", "--force", wt], { cwd }); } catch { /* none */ }
    try { await io.git(["worktree", "prune"], { cwd }); } catch { /* best effort */ }
    });
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
    // #5435: attribute the cold add to its git calls: the sparse plan (ls-tree), the add + checkout (which runs any post-checkout hook), the sparse checkout
    const GIT_STEP = { "ls-tree": "sparse_plan", worktree: "git_worktree_add", "sparse-checkout": "sparse_checkout", "read-tree": "sparse_checkout" };
    // #5435 (R2): the lane's own checkout never needs the repo's post-checkout hook (husky/lfs installs); it is skipped for these calls only.
    const timedGit = async (args, opts) => {
      const name = GIT_STEP[args[0]], s0 = now();
      try { return await io.git(args, name && args[0] !== "ls-tree" ? { ...opts, env: { ...opts?.env, ...NO_HOOKS } } : opts); } finally { if (name) { const ms = Math.max(0, now() - s0); phaseLedger.addStep("sandbox_start", name, ms); ev({ event: "SANDBOX_STEP", step: name, ms }); } }
    };
    const addWorktree = async (args, ref) => {
      let cleaned = false;
      for (let i = 0; ; i++) {
        try { return await addLaneWorktree(timedGit, io.fs?.write, { cwd, wt, addArgs: args, ref, maxBlobBytes: sparseMaxKb * 1024 }); } catch (e) {
          const msg = String(e?.stderr ?? e?.message ?? e);
          if (!cleaned && /already exists/i.test(msg) && (await leftoverDir())) { cleaned = true; continue; }
          if (i >= 4 || !LOCK_RE.test(msg)) throw e;
          await sleep(500 * (i + 1) + Math.floor(random() * 500));
        }
      }
    };
    if (resumed && !fromSalvage) { try { await io.git(["fetch", "origin", branch], { cwd }); } catch { /* remote branch may not exist (PR-less resume) */ } }
    // #4786: an open-PR-less remote branch whose only changes vs the base are tool state (.forge-lean/ scratch) holds no work: plan fresh, never resume its stale contract.
    const toolOnly = async (ref) => { const n = String(await io.git(["diff", "--name-only", `${base}...${ref}`], { cwd })).split("\n").map((x) => x.trim()).filter(Boolean); return n.every((f) => isToolState(f)); };
    let scratchOnly = false;
    if (resumed && !resumed.pr) { try { scratchOnly = await toolOnly(`origin/${branch}`); } catch { /* unreadable: resume as before */ } }
    // #4118: a local lane branch with commits not yet pushed (e.g. a reviewed commit whose push failed) must never be reset.
    // Reuse it when it is ahead of the base and contains everything the remote branch has.
    let keepLocal = false;
    try {
      const ahead = Number(String(await io.git(["rev-list", "--count", `${base}..refs/heads/${branch}`], { cwd })).trim());
      if (ahead > 0 && !(await toolOnly(`refs/heads/${branch}`).catch(() => false))) { // #4786: a scratch-only local branch is not reused
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
      if (scratchOnly) { // from origin/<branch> so the later plain push stays fast-forward; the scratch goes out in a normal commit
        await io.git(["rm", "-r", "-f", "-q", "--ignore-unmatch", "--", LEAN_DIR], { cwd: wt }).catch(() => {});
        if (String(await io.git(["diff", "--cached", "--name-only"], { cwd: wt }).catch(() => "")).trim()) await io.git(["commit", "--no-verify", "-m", "chore(forge): drop stale .forge-lean scratch from the lane branch"], { cwd: wt }).catch(() => {});
        resumed = null;
        ev({ event: "SCRATCH_BRANCH_DROPPED", branch });
        T.decisions.push(`Lane branch ${branch} held only ${LEAN_DIR}/ scratch: its stale checkpoint was dropped and the issue is planned fresh`);
      }
    } else {
      const warmN = warmTreeCount(o.warmTrees);
      const wtRootDir = o.worktreeRoot ?? join(cwd, ".claude", "worktrees");
      if (warmN) { // #5435: a pooled tree is claimed and its HEAD verified against the base sha; any failure is the cold add below
        wtInfo = await step("warm_claim", () => claimWarm({ git: io.git, cwd, root: wtRootDir, wt, branch, base, n: warmN }).catch(() => null));
        if (wtInfo) ev({ event: "WARM_TREE_CLAIMED", sha: wtInfo.sha });
      }
      if (!wtInfo) wtInfo = await step("worktree_add", () => addWorktree(["worktree", "add", "-B", branch, wt, base], base));
      if (warmN) refillWarm({ git: io.git, cwd, root: wtRootDir, ref: base, n: warmN, maxBlobBytes: sparseMaxKb * 1024, write: io.fs?.write }).catch(() => {});
    }
    wtCreated = true;
    if (fromSalvage) await dropSalvageTracking({ git, branch }); // #5047: the salvaged commits are unpublished: the sign-off range must include them
    if (wtInfo?.sparse) {
      sparse = { excluded: wtInfo.excluded, maxKb: sparseMaxKb };
      ev({ event: "WORKTREE_SPARSE", excluded: wtInfo.excluded, excluded_bytes: wtInfo.bytes, max_kb: sparseMaxKb });
      T.decisions.push(`Sparse worktree: ${wtInfo.excluded} tracked file(s) >= ${sparseMaxKb} KB (${Math.round(wtInfo.bytes / 1048576)} MB) left out of the checkout`);
    } else if (wtInfo?.fallback) {
      ev({ event: "WORKTREE_SPARSE_FALLBACK", reason: wtInfo.fallback });
      T.anomalies.push(`Sparse checkout failed, full checkout used: ${wtInfo.fallback}`);
    }
    await step("scratch_setup", async () => { // #5435: timed with the other startup steps
    const excl = String(await git(["rev-parse", "--git-path", "info/exclude"])).trim();
    await io.fs.append(excl.startsWith("/") ? excl : `${wt}/${excl}`, `\n${LEAN_DIR}/\n`);
    await installSignoffHook();
    if (!resumed && await clearLaneScratch({ git, fs: io.fs, cwd: wt })) ev({ event: "LANE_SCRATCH_CLEARED" }); // #4880: never read a previous lane's scratch
    });
    // ---- 2a. lane profile (#4395): the repo's lane instruction file replaces CLAUDE.md; a bad one falls back with an anomaly ----
    const lanePath = typeof o.laneInstructions === "string" ? o.laneInstructions.trim() : "";
    if (laneProfile.name !== "full" && lanePath) {
      let why = null, text = "";
      if (lanePath.startsWith("/") || lanePath.split(/[\\/]/).includes("..")) why = "not a repo-relative path";
      else { try { text = String(await io.fs.read(`${wt}/${lanePath}`) ?? "").trim(); } catch { why = "not readable in the lane worktree"; } }
      if (!why && !text) why = "empty";
      if (!why && Buffer.byteLength(text, "utf8") > LANE_INSTRUCTIONS_MAX_BYTES) why = `over ${LANE_INSTRUCTIONS_MAX_BYTES} bytes`;
      if (why) T.anomalies.push(`forge.yaml engine.lane_instructions \`${lanePath.slice(0, 200)}\` ${why}; lanes keep CLAUDE.md (auto-memory off)`);
      else laneProfile = { name: "lane", text };
    }
    T.decisions.push(laneProfile.name === "lane" ? `Lane profile: ${lanePath} (${Buffer.byteLength(laneProfile.text, "utf8")} bytes) instead of CLAUDE.md, auto-memory off`
      : laneProfile.name === "full" ? "Lane profile: full session (FORGEDOCK_FULL_SESSION=1)" : "Lane profile: auto-memory off, CLAUDE.md loaded");
    // ---- 2b. toolchain pins + env.setup (#4163): before the builder; zero LLM. No pins and no setup changes nothing ----
    try {
      const tc = await step("toolchain", () => (io.prepareToolchain ?? prepareToolchain)({ dir: wt, override: toolchainOverride, read: io.fs.read,
        binDir: join(runTmp ?? join(wt, LEAN_DIR), "toolchain", "bin") }));
      if (tc?.summary) {
        toolchain = { env: tc.env ?? null, summary: tc.summary };
        ev({ event: "TOOLCHAIN_PINNED", pins: tc.summary, shims: tc.shims });
        T.decisions.push(tc.env ? `Toolchain pinned on the runner PATH: ${tc.summary}` : `Toolchain pins detected (no shim): ${tc.summary}`);
      }
      if (tc?.warning) { T.anomalies.push(tc.warning); ev({ event: "TOOLCHAIN_WARNING", warning: tc.warning }); }
      for (const n of tc?.notes ?? []) T.anomalies.push(n);
    } catch (e) { T.anomalies.push(`Toolchain detection failed (host toolchain used): ${String(e?.message ?? e).slice(0, 200)}`); }
    // #5434: deps, heavy shims and env.setup overlap the plan session (read-only); gateSetup() awaits them before anything that builds or runs commands.
    let setupSettled = false;
    const setupStep = (step, t) => ev({ event: "LANE_SETUP_TIMING", step, ms: now() - t });
    const setupP = (async () => {
    // #4220: link node_modules/.venv from the shared cache keyed by lock hash (or install once and publish). Never fails the run.
    // After 2b (#4347): installs run with the toolchain env, so a pm only its shim provides resolves; no env is the host PATH.
    if (io.deps?.prepare) {
      const tD = now();
      let res;
      try { res = await io.deps.prepare({ wt, repoKey: repoKey(cwd), env: toolchain?.env ?? undefined }); } catch (e) { res = [{ status: "failed", eco: null, key: null, ms: 0, reason: String(e?.message ?? e).slice(0, 300) }]; }
      depResults = Array.isArray(res) ? res : []; // #5447: classified against the changed files at the gate
      setupStep("deps", tD);
      for (const r of Array.isArray(res) ? res : []) {
        ev({ event: "DEPS_PREPARED", status: r?.status ?? null, eco: r?.eco ?? null, key: r?.key ?? null, ms: r?.ms ?? null, reason: r?.reason ?? null });
        if (r?.eco) T.decisions.push(`Dependencies (${r.eco}${r.key ? ` ${r.key}` : ""}): ${r.status}${r.reason ? ` (${r.reason})` : ""}${Number.isFinite(r.ms) ? ` in ${Math.round(r.ms / 100) / 10}s` : ""}`);
      }
    }
    // ---- 2c. heavy-step shims (#4169): after the toolchain, so a heavy shim's real binary is the pinned toolchain shim ----
    const tH = now();
    if (heavyOn) {
      try {
        const root = runTmp ?? join(wt, LEAN_DIR), binDir = join(root, "heavy", "bin"), path0 = toolchain?.env?.PATH ?? process.env.PATH ?? "";
        // #5592: a tool that only exists in a project's .venv/bin or node_modules/.bin (poetry/uv in-project venv, monorepo service) is shimmed too, so the preflight probe and the shim agree
        let tracked = []; try { tracked = String(await git(["ls-files"])).split("\n").map((x) => x.trim()).filter(Boolean); } catch { /* no git listing */ }
        const path = withLocalBins(path0, projectBinDirs(wt, tracked));
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
    setupStep("heavy_shims", tH);
    if (typeof envSetup === "string" && envSetup.trim()) {
      const tE = now();
      let r;
      if (!io.runSetup) r = { exit: 1, stderr: "no setup effect is configured" };
      else { try { r = await heavyStep("setup", () => io.runSetup({ cwd: wt, command: envSetup, env: laneEnv() })); } catch (e) { r = { exit: 1, stderr: String(e?.message ?? e) }; } }
      ev({ event: "ENV_SETUP", exit: r?.exit ?? 1 }); setupStep("env_setup", tE);
      if (r?.exit !== 0) {
        const tail = String(r?.stderr || r?.stdout || "").trim().slice(-800);
        T.anomalies.push(`Environment error: forge.yaml env.setup exited ${r?.exit ?? "?"}; the build did not run`);
        return () => needsHuman(`Environment error (not a build failure): forge.yaml \`env.setup\` (\`${envSetup.slice(0, 200)}\`) exited ${r?.exit ?? "?"} in the fresh worktree, so the build was not started. Fix the setup command or the environment, then rerun.${tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ""}`, OUTCOME_CODES.ENV_SETUP_FAILED);
      }
      T.decisions.push("forge.yaml env.setup ran once in the fresh worktree");
    }
      return null;
    })().finally(() => { setupSettled = true; });
    setupWait = setupP;
    const TIMED_OUT = Symbol("timed-out");
    /** #5434: `p` or TIMED_OUT after `ms` (0 = no bound); a rejection is null. The work keeps running. */
    const within = (p, ms) => new Promise((res) => { const t = ms > 0 ? setTimeout(() => res(TIMED_OUT), ms) : null; Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, () => { clearTimeout(t); res(null); }); });
    /** #5434: the setup is awaited (the residual wait is the deps_install phase); a failed env.setup ends the lane needs-human. Returns the terminal or null. */
    let setupFail;
    const gateSetup = async () => {
      if (setupFail === undefined) { const r = setupSettled ? await setupP : await phaseLedger.during("deps_install", () => setupP); setupFail = typeof r === "function" ? await r() : null; }
      return setupFail;
    };
    const names = (out) => String(out).split("\n").map((s) => s.trim()).filter(Boolean);
    // #4160: files the branch touched (three-dot) whose content still differs from the base tip (two-dot); a file merged
    // in from the base by a base-sync equals the base and drops out of the scope check.
    const changedFiles = async () => {
      const touched = names(await git(["diff", "--name-only", `${base}...HEAD`])).filter((f) => !isToolState(f)); // #4786
      if (!touched.length) return touched;
      const differs = new Set(names(await git(["diff", "--name-only", base, "HEAD"])));
      return touched.filter((f) => differs.has(f));
    };
    /** #5079: verification.coupled_files failures for the lane diff ([] when unconfigured; added files only read when a rule needs them) */
    const coupledOf = async (files) => {
      const rules = parseCoupled(coupledFiles);
      if (!rules.length) return null;
      const addedFiles = rules.some((r) => r.addedOnly) ? names(await git(["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`]).catch(() => "")) : [];
      return coupledFailures({ rules, changedFiles: files, addedFiles });
    };
    /** #5237: relaxed rules in declared review.risk_paths files ({relaxations, negatives}); empty when no glob matches or git fails */
    let relaxations = [];
    const relaxationsOf = async (files) => {
      const empty = { relaxations: [], negatives: 0 };
      if (!riskPathHits(files, riskPaths).length) return empty;
      try { return analyzeRelaxations({ diff: String(await git(["diff", "-U0", `${base}...HEAD`])), riskPaths }); } catch { return empty; }
    };
    /** #4364: the last `forgedock check` record vs the current tree: skipped|stale|red|green; any read or git error is skipped. */
    const selfCheckNow = async () => {
      try { return selfCheckState(JSON.parse(await io.fs.read(`${wt}/${SELF_CHECK_FILE}`)), await worktreeFingerprint({ git, base })); } catch { return "skipped"; }
    };
    /** forge#4195: scripts/hotspots.sh facts in the worktree, or null (no io.hotspots, script failure): never fails a run. */
    let hotCfgNoted = false;
    const hotspotsOf = async (args) => {
      if (!io.hotspots) return null;
      const config = existsSync(join(cwd, "forge.yaml")) ? join(cwd, "forge.yaml") : null; // #5163: forge.yaml is often gitignored, so the worktree has none
      const h = await io.hotspots({ cwd: wt, config, ...args }).catch(() => null);
      if (!(h && typeof h === "object" && Array.isArray(h.files))) return null;
      if (h.config_source === null && !hotCfgNoted) { hotCfgNoted = true; T.anomalies.push("hotspot_config_missing: no forge.yaml readable for the hotspot gate (exclude_globs and generated_paths not applied; defaults used)"); }
      return h;
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
      let words = rg?.base && rg?.head ? rg : { base: "UNRUNNABLE", head: "UNRUNNABLE" };
      if (words.head === "FAILED" && io.runCommand) { // #5020: a head that failed because a tool or env is missing is env.repro_unrunnable, not a red-green verdict
        const hr = await io.runCommand({ command: String(t.command), cwd: wt, timeoutMs: 120000, env: laneEnv() }).then((x) => x?.r ?? x).catch(() => null);
        // release review BUG-1: a module the repo tracks is the change's own failure, never an env miss (same repoHas as the validate rerun)
        const repoHas = repoTracks(String(await git(["ls-files"]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean));
        if (reproEnvMiss(hr, { command: String(t.command), repoHas })) words = { ...words, head: "UNRUNNABLE" };
      }
      ev({ event: "REPRO_RED_GREEN", ...words });
      T.decisions.push(`repro_test ${t.path ?? ""}${t.id ? ` ${t.id}` : ""}: BASE=${words.base} HEAD=${words.head}`);
      if (reproQuality !== "off" && words.base === "FAILED" && words.head === "RAN") words = { ...words, ...(await reproQualityOf(t)) };
      return words;
    };

    /** #5446: patch-echo + targeted mutation of the fix; {quality, enforce}. Never throws (a dirty tree after a mutation is an anomaly). */
    const reproQualityOf = async (t) => {
      try {
        const files = (await changedFiles()).filter((f) => !isTestPath(f));
        const srcDiff = files.length ? String(await git(["diff", "-U0", `${base}...HEAD`, "--", ...files])) : "";
        const tests = (await changedFiles()).filter((f) => isTestPath(f));
        const testDiff = tests.length ? String(await git(["diff", "-U0", `${base}...HEAD`, "--", ...tests])) : "";
        const echo = patchEcho({ testDiff, srcDiff });
        const m = echo ? { results: [] } : await runReproMutations({ mutations: mutationsOf(srcDiff), command: String(t.command), git, runCommand: async (a) => io.runCommand(a).then((x) => x?.r ?? x), cwd: wt, env: laneEnv(), readFile: io.fs.read, writeFile: io.fs.write });
        const quality = classifyRepro({ repro_test: t, echo, mutations: m.results });
        reproQ = quality;
        ev({ event: "REPRO_QUALITY", quality, mutations: m.results.map((x) => `${x.kind}:${x.file}:${x.line}:${x.status}`), ...(m.skipped ? { skipped: m.skipped } : {}) });
        T.decisions.push(`repro_quality: ${quality}`);
        return { quality, enforce: reproQuality === "enforce" };
      } catch (e) { T.anomalies.push(`repro_quality: ${String(e?.message ?? e).slice(0, 200)}`); return {}; }
    };

    // ---- 3. builder: plan call -> frozen contract -> implement call in the same session ----
    phaseLedger.enter("plan");
    let result = null, attemptN = 0, reviewN = 0;
    const lastSubject = resumed ? String(await git(["log", "-1", "--format=%s"]).catch(() => "")).trim() : "";
    const fromCheckpoint = lastSubject.startsWith("wip(forge): checkpoint");
    const hasCommits = resumed ? (await changedFiles()).length > 0 : false;
    // Requirements may only be quoted from the issue and trusted comments: an untrusted commenter cannot add a contract requirement.
    const trustedOf = (i) => (i.comments ?? []).filter(isTrustedIssueComment); // #4467: gh shape, the App has no [bot]
    // #4297: engine-posted `<!-- FORGE:` comments (FORGE:CONTEXT carries linked-issue text) are never quotable, as in scopeText
    const isEngineComment = (b) => b.trimStart().startsWith("<!-- FORGE:");
    const textOf = (i, tc) => [i.title, i.body ?? "", ...tc.map((c) => String(c?.body ?? "")).filter((b) => !isEngineComment(b))].join("\n\n");
    let trustedComments = trustedOf(iss), issueEdited = false;
    factsSeen = trustedComments.map((c) => c?.body);
    let issueText = textOf(iss, trustedComments);
    let scopeHash = contractHash(scopeText(iss, trustedComments)); // #4265: the edit signal and the frozen contract's provenance
    { const m = resolveContextMode(o.contextPack, ctxCfg, { milestone, parent: parentOf(iss.body ?? "") }); if (m !== ctxCfg.mode) { ctxCfg = { ...ctxCfg, mode: m }; T.decisions.push(`Context pack (${m}): lane has a milestone or parent epic (#5340)`); } }
    ctxLane = laneType({ resumed: Boolean(resumed || salvagedRef), attempts: priorAttempts(iss.body, trustedComments), body: iss.body });
    /**
     * forge#4275: compile (or read from the cache) the context pack, log CONTEXT_PACK and post FORGE:CONTEXT. Off, no
     * io.contextFacts or any failure gives null: never fails a run. The pack never enters issueText (contract quotes).
     */
    async function contextPackStep() {
      const tPits = now(), pits = await lanePitfalls();
      setupStep("pack_pitfalls", tPits);
      if (ctxCfg.mode === "off" || !io.contextFacts) return null;
      try {
        const tGh = now();
        const headSha = String(await git(["rev-parse", base])).trim();
        // #4316: linked-issue states are part of the key; a failed lookup only drops them from it
        const links = await linkStateStamp({ gh: ghc, repo, issue, body: iss.body }).catch(() => "");
        setupStep("pack_gh_reads", tGh);
        const tCp = now();
        const r = await contextPackFor({ cfg: ctxCfg, issue, repo, headSha, cacheDir: dir, fs: io.fs, stamp: { scope: scopeHash, attempts: priorAttempts(iss.body, trustedComments), links, pitfalls: pits.map((x) => x.sig) },
          gather: () => io.contextFacts({ milestone, repo, issue, iss, comments: trustedComments, cwd: wt, checkout: cwd, base, sources: ctxCfg.sources, days: ctxCfg.days, now: now(), pitfalls: pits }) });
        setupStep("pack_compile", tCp); packDoneAt = now();
        const p = r.pack;
        const inPack = Array.isArray(p.pitfalls) ? p.pitfalls : [];
        pitMatched = inPack.filter((x) => x.match === "files").length;
        // #4375: which pitfalls were in the pack (signatures only, run log only: never telemetry or a comment)
        const rec = { event: "CONTEXT_PACK", mode: ctxCfg.mode, ...ctxAb, lane_type: ctxLane, sources: p.sources, found: p.found, bytes: p.bytes, items: p.items, truncated: p.truncated,
          hash: p.hash, cached: r.cached, ...(p.recall ? { recall: p.recall.present ? "present" : "absent" } : {}), ...(r.errors?.length ? { errors: r.errors } : {}) };
        ev({ ...rec, pitfalls: inPack }); await emit(rec);
        const seen = trustedComments.some((c) => hasSection(c?.body, "FORGE:CONTEXT") && String(c.body).includes(`hash ${p.hash})`));
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
      iss = next; trustedComments = tc; factsSeen = tc.map((c) => c?.body); issueText = text; scopeHash = now;
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
    /**
     * File (or append to) the parent's one batched follow-up issue for these requirements, then verify each tracking issue is open.
     * #5141: the whole step is retried in-lane (3 attempts, 5s then 15s): the script is idempotent (claim marker /
     * FORGE:DEFERRED_FROM lookup, checklist dedup, duplicate close), so only a persistent failure defers the run.
     * A malformed TSV (DEFERRED_TSV=INVALID) is deterministic and never retried. #5141: when the retries are spent the run
     * keeps going (keep): the untracked requirements join pendingFollowups, recorded in FORGE:STATE and filed after the merge.
     */
    async function track(reqs, why, { keep = true } = {}) {
      const fail = (detail, final = true) => Object.assign(new Error(detail), { deferCode: OUTCOME_CODES.FOLLOWUP_UNAVAILABLE, deferDetail: `${detail}; nothing merged, rerun to retry`, final });
      if (!io.fileFollowups) throw fail("no follow-up filing effect is configured");
      const items = followupItems(reqs, { now: now() });
      const attempt = async () => {
        let filed;
        try { filed = await io.fileFollowups({ parent: issue, repo, items, milestone, defaultMilestone: o.followupsDefaultMilestone ?? null, lane, batchId: o.batchId ?? null, rollupLabel: o.followupsRollupLabel ?? null }); } catch (e) {
          throw fail(`filing the follow-up issue failed: ${String(e?.message ?? e).slice(0, 200)}`, /DEFERRED_TSV=INVALID/.test(`${e?.stdout ?? ""}${e?.message ?? ""}`));
        }
        for (const [i, r] of reqs.entries()) {
          if (recorded.has(i)) continue; // tracked in an earlier attempt: keeps its r.tracked, never re-counted
          const n = Number(filed?.[items[i].key]);
          if (!Number.isSafeInteger(n) || n <= 0) throw fail(`no tracking issue was returned for ${r.id}`, false);
          let st = null;
          try { st = JSON.parse(String(await ghc(["issue", "view", String(n), "-R", repo, "--json", "number,state"]))); } catch { st = null; }
          if (String(st?.state).toUpperCase() !== "OPEN") throw fail(`tracking issue #${n} for ${r.id} is not open or unreadable`, false);
          recorded.add(i);
          r.tracked = `#${n}`;
          const f = followupsFiled.find((x) => x.issue === n && x.class === items[i].class); // #5078: grouped per issue and class
          if (f) f.count += 1; else followupsFiled.push({ issue: n, class: items[i].class, count: 1 });
        }
      };
      const recorded = new Set();
      const waits = [5000, 15000];
      for (let k = 0; ; k++) {
        try { await attempt(); break; } catch (e) {
          if (e.final || (k >= waits.length && !keep)) throw e;
          if (k >= waits.length) { // #5141: keep the merge-capable work; the close step files these after the merge
            const left = reqs.filter((_, i) => !recorded.has(i));
            for (const r of left) if (!pendingFollowups.some((p) => p.req === r)) pendingFollowups.push({ req: r, why });
            T.anomalies.push(`follow-up filing failed ${k + 1} times (${String(e.message).slice(0, 160)}): ${left.map((r) => r.id).join(", ")} pending, filed after the merge (FORGE:DEFERRED_FROM: #${issue})`);
            break;
          }
          T.decisions.push(`Follow-up filing attempt ${k + 1} failed (${String(e.message).slice(0, 160)}); retrying in-lane in ${waits[k] / 1000}s`);
          await sleep(waits[k]);
        }
      }
      const done = reqs.filter((r) => r.tracked);
      if (!done.length) return;
      const buckets = Object.entries(bucketTally(done)).map(([k, c]) => `${k}:${c}`).join(","); // #4724
      T.decisions.push(`Tracked ${done.map((r) => `${r.id} (${r.disposition})`).join(", ")} in ${[...new Set(done.map((r) => r.tracked))].join(", ")} (${why}; buckets ${buckets})`);
    }
    /**
     * #4328: probe the host for the tools and modules a contract's validate commands need; #4393: then flag `$NAME`s the lane
     * env leaves empty and run each remaining command once on the base worktree (io.preflightRun). The misses; [] without either hook.
     */
    /** #5020: forge.yaml validate.recipes rewrite frozen commands; a check-less post-deploy requirement becomes a defer to the orchestrator. */
    const genChecks = {}; // #5468: generated post-deploy check entries, committed with the lane
    async function persistGenChecks() {
      if (!Object.keys(genChecks).length || !io.fs?.write) return;
      try {
        const cur = await io.fs.read(`${wt}/${CHECKS_FILE}`).catch(() => "");
        await io.fs.write(`${wt}/${CHECKS_FILE}`, mergeCheckEntries(cur, genChecks));
        await git(["add", "--", CHECKS_FILE]); await git(["commit", "--no-verify", "-m", "chore(forge): generated post-deploy checks for production-only e2e requirements (#5468)"]);
      } catch (e) { T.anomalies.push(`generated post-deploy checks not committed: ${String(e?.message ?? e).slice(0, 160)}`); }
    }
    function freezeRewrites(c) {
      const r = applyValidateRecipes(c, validateRecipes);
      const pd = (id, cmd) => { const to = rewriteProjectDirCommand(cmd); if (to !== cmd) T.decisions.push(`project-dir rewrite of ${id}: \`${cmd}\` -> \`${to}\``); return to; };
      if (r.contract && typeof r.contract === "object") { // #5234
        if (Array.isArray(r.contract.validate)) r.contract = { ...r.contract, validate: r.contract.validate.map((v) => (v && typeof v.command === "string" ? { ...v, command: pd(v.id, v.command) } : v)) };
        const t = r.contract.repro_test;
        if (t && typeof t === "object" && typeof t.command === "string") r.contract = { ...r.contract, repro_test: { ...t, command: pd("repro_test", t.command) } };
      }
      for (const x of r.applied) T.decisions.push(`validate recipe rewrote ${x.id}: \`${x.from}\` -> \`${x.to}\``);
      r.contract = foldRegression(r.contract); // #5448: the blast-radius regression set runs as validate G# entries
      const e = autoPostDeployE2e(r.contract); // #5468: production-only e2e/manual rows become post-deploy with a generated check
      for (const x of e.converted) { if (x.check) genChecks[x.check] = x.entry; T.decisions.push(`Production-only e2e/manual requirement ${x.id} frozen as post-deploy with ${x.check ? `generated check ${x.check}` : "no check (production observation window)"}`); }
      r.contract = e.contract;
      const d = deferChecklessPostDeploy(r.contract);
      if (d.converted.length) T.decisions.push(`Post-deploy with no registered check deferred to the orchestrator: ${d.converted.join(", ")}`);
      return d.contract;
    }
    async function preflightValidates(contract) {
      if ((!io.probeCommand && !io.preflightRun) || !contract || typeof contract !== "object") return [];
      const files = String(await git(["ls-files"]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean);
      const env = laneEnv(), missing = new Set(), misses = []; // #4325: the env the validate commands run with
      // #5592: tools resolve where the lane runs them from: project-local .venv/bin and node_modules/.bin (as the heavy shims do)
      const local = projectBinDirs(wt, files);
      if (local.length) env.PATH = withLocalBins(env.PATH ?? process.env.PATH ?? "", local);
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
      const amendLog = []; // #4899: trusted FORGE:AMENDMENT payloads in order, bound to a contract hash
      for (const l of out.split("\n")) {
        let c; try { c = JSON.parse(l); } catch { continue; }
        if (!isTrustedComment(c)) continue;
        const b = String(c?.body ?? "");
        const am = parseAmendmentsComment(b);
        if (am) amendLog.push(am);
        if (!b.startsWith("<!-- FORGE:CONTRACT -->")) { if (found && b.trim() && !b.trimStart().startsWith("<!-- FORGE:")) found.humanAfter = true; continue; }
        const fc = parseContractComment(b);
        if (fc && contractHash(fc.text) === fc.hash) found = { ...fc, humanAfter: false };
      }
      if (found) {
        const seen = new Set(); found.amendments = [];
        for (const st of amendLog) if (st.contract === found.hash) for (const a of st.amendments) { const k = JSON.stringify(a); if (!seen.has(k)) { seen.add(k); found.amendments.push(a); } }
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
    /** #4694: the engine appends guard-derived H preserve rows from the local index (one file read; the same contract when none apply). */
    const historyRows = (c) => { const w = withHistoryRows(c, { repo, issue }); const n = (w.preserve ?? []).length - (c.preserve ?? []).length; if (w !== c && n > 0) T.decisions.push(`History preserve rows: ${w.preserve.filter((p) => p.source === "guard").map((p) => p.id).join(", ")} from guards (#4694)`); return w; };
    let frozen = null, hash = null, planned = false, files = [], split = null, planMisses = null; // planMisses (#5331): validate preflight misses from this run
    const impliedDocs = []; // add-deliverable amendments for doc edits the docs-freshness rule demanded (docs round, CI fix round)
    /** Doc files a fix round added to satisfy the freshness rule: recorded only when the rule failed before and passes after. */
    async function noteFreshnessDocs(before, wasFailing) {
      if (!io.docsFreshness || !wasFailing) return;
      const nowOk = (await io.docsFreshness({ cwd: wt, base }).catch(() => null))?.ok === true;
      for (const a of impliedDocDeliverables({ before, after: await changedFiles(), contract: frozen, wasFailing, nowOk })) if (!impliedDocs.some((x) => x.path === a.path)) impliedDocs.push(a);
    }
    let priorAmendments = []; // #4899: accepted amendments recovered with the frozen contract
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
    /** #4394: a failed validate round on the mid tier moves this fix round and every later builder call to the top model. */
    async function escalateOn(trigger) {
      if (!shouldEscalate(route, escalated, trigger)) return;
      escalated = true;
      const rec = { event: "BUILDER_ESCALATED", from: route.model, to: builderModel ?? "default", trigger };
      ev(rec); await emit(rec);
      T.decisions.push(`Builder escalated from ${route.model} to the top model after a failed ${trigger} round`);
    }
    /**
     * #4363: one fix round. Mechanical failures (and a conformance/review FAIL citing file:line) run in a fresh session on
     * the fix model with a narrow prompt; one resume of the build session follows when it made no commit. Else: a resume.
     */
    function fixRound(...a) { return phaseLedger.during("fix", () => fixRoundRaw(...a)); } // #5649: fix rounds are their own ledger phase
    async function fixRoundRaw(kind, task, failures, trigger, failureText = "", narrow = null) { // #5348: `narrow` {files} = the minimal profile (no diff, no lane text)
      await notePitfall(trigger, failureText); await escalateOn(trigger); // #4375: learned once the same gate passes; #4394
      if (!freshFix(kind, failures)) return await builder(++attemptN, task, sessionId ?? null, false, undefined, { mode: "resume", trigger });
      const before = String(await git(["rev-parse", "HEAD"])).trim();
      const ex = [".", `:!${LEAN_DIR}`], diff = narrow ? "" : String(await git(["diff", `${base}...HEAD`, "--", ...ex]).catch(() => "")), stat = narrow ? "" : String(await git(["diff", "--stat", `${base}...HEAD`, "--", ...ex]).catch(() => ""));
      const prompt = narrow ? narrowFixPrompt({ task, contract: frozen, files: narrow.files }) : fixSessionPrompt({ task, diff, stat, base, contract: frozen, title: iss?.title ?? "", summary: issueSummary(iss?.body) });
      const r = await builder(++attemptN, prompt, null, false, () => prompt, { model: escalated ? null : fixModel ?? reviewerModel, mode: "fresh", keepSession: true, ...(narrow ? { profile: "narrow" } : {}), trigger });
      if (!sessionId || String(await git(["rev-parse", "HEAD"])).trim() !== before) return r;
      T.decisions.push(`Fresh ${kind} fix session made no commit; builder session resumed once`);
      return await builder(++attemptN, task, sessionId, false, undefined, { mode: "resume", trigger });
    }
    /** #5348: commit what the engine applied without a model (only the files it wrote); the findings it fixed were named by a detector. */
    async function mechCommit(gate, applied, paths) {
      if (!applied.length) return 0;
      ev({ event: "MECHANICAL_FIX", gate, count: applied.length });
      T.decisions.push(`Mechanical ${gate} fix applied without a model session: ${applied.slice(0, 5).map((x) => x.symbol).join(", ")}`);
      try { await git(["add", "--", ...new Set(paths)]); await git(["commit", "--no-verify", "-m", `fix(forge): ${gate} fix applied by the engine, no model session (#5348)`]); } catch { /* the detector re-run decides */ }
      files = await changedFiles();
      return applied.length;
    }
    const mech = io.mechFix ?? { applyEnumerating, renameDuplicates }; // #5348: a test seam; the engine uses mechfix.mjs
    /** #5480: apply the enumerating edits, then run each edited test; a red or unrunnable one is restored and left to a session. */
    async function enumeratingMech(missing) {
      const r = await mech.applyEnumerating({ missing, cwd: wt });
      if (!r.applied.length) return r;
      const runTest = async (t) => {
        if (!io.runCommand || !/\.[cm]?js$/.test(t)) return false;
        const x = await io.runCommand({ command: `node --test ${/^[\w./@-]+$/.test(t) ? t : `'${t.replace(/'/g, "'\\''")}'`}`, cwd: wt, timeoutMs: 120000, env: laneEnv() }).then((y) => y?.r ?? y).catch(() => null);
        return x?.rc === 0;
      };
      return io.mechFix ? r : await verifyApplied({ result: r, cwd: wt, runTest });
    }
    let dupMech = 0; // #5348: duplicate renames the last dupsResidual() applied
    /** Duplicate-export findings that still need a model: the detector, then the deterministic rename, then the detector again. */
    async function dupsResidual() {
      const found = async () => (await io.duplicateExports({ cwd: wt, base }).catch(() => null)) ?? [];
      let dups = await found();
      dupMech = 0;
      if (dups.length) {
        const m = await mech.renameDuplicates({ dups, cwd: wt, git: (a) => git(a) });
        dupMech = await mechCommit("duplicate", m.applied, m.applied.map((d) => d.path));
        if (dupMech) dups = await found();
      }
      return dups;
    }
    if (adoptPr) {
      // ---- 3''. #5469 adopt: the PR's diff is the change; no plan and no builder session, a location-only contract for the renderers ----
      { const f = await gateSetup(); if (f) return f; }
      files = await changedFiles();
      frozen = { requirements: [], deliverables: files.map((path, i) => ({ id: `D${i + 1}`, path, change: `adopted from PR #${adoptPr.number}: reviewed as built`, requirements: [] })), preserve: [], validate: [] };
      hash = contractHash(contractJson(frozen));
      T.decisions.push(`Adopted PR #${adoptPr.number}: ${files.length} changed file(s) go to review as built`);
    } else if (isSplit) {
      // ---- 3'. refactor:split (#4211): deterministic move + proof replaces the builder; no builder session exists ----
      { const f = await gateSetup(); if (f) return f; } // #5434
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
          } else {
            frozen = fc.contract; hash = fc.hash; priorAmendments = fc.amendments ?? []; T.decisions.push(`Rerun: frozen contract ${hash} recovered from the issue`);
            const ad = applyRequirementDecisions(frozen, trustedComments); // #5547: a structured operator decision amends the frozen row
            if (ad.applied.length) { frozen = deferChecklessPostDeploy(ad.contract).contract; T.decisions.push(`FORGE:DECISION applied to the frozen contract: ${ad.applied.join(", ")} tracked post-deploy`); }
          }
        }
      }
      if ((resumed || salvagedRef || recover) && ctxCfg.mode !== "off") {
        // #4400: the last run's own records as a bounded digest in the builder prompts; never in issueText (contract quotes)
        const d = buildResumeDigest({ state: priorState, comments: trustedComments, contract: frozen, files: resumed ? await changedFiles().catch(() => []) : [], lane, head: String(await git(["rev-parse", "HEAD"]).catch(() => "")).trim() });
        resumeNote = d.text; carriedPasses = d.passes ?? [];
        if (d.text) {
          ev({ event: "RESUME_DIGEST", bytes: Buffer.byteLength(d.text, "utf8"), files: d.files, validates: d.validates, reason: d.reason });
          T.decisions.push(`Resume digest given to the builder: ${d.files} file(s), ${d.validates} validate result(s)${d.reason ? `, last run ${d.reason}` : ""}`);
        }
      }
      decisionsNote = frozen && (resumed || salvagedRef || recover) ? decisionNote(trustedComments) : ""; // #4901
      if (decisionsNote) T.decisions.push("Trusted FORGE:DECISION comment(s) posted after the contract froze are binding notes for the builder");
      await label("building");
      // #4450: the light lane (lean.light mode on, eligible, fresh lane): one builder session, derived contract, or an upgrade
      const waitMs = Math.max(0, Number(contextWaitSeconds) || 0) * 1000, tHot = now();
      const hotR = await within(hotspotsOf({ paths: namedPaths(iss.body ?? "") }), waitMs); // #5209: churn and hotspot signals for eligibility; #5434: bounded, overlaps the install
      const hotLate = hotR === TIMED_OUT, namedHot = hotLate ? null : hotR;
      setupStep("hotspots", tHot);
      if (hotLate) T.decisions.push(`Hotspots not ready in ${waitMs / 1000}s: light lane skipped, plan starts without hotspot facts`);
      const elig = lightEligibility({ title: iss.title, body: iss.body ?? "", labels: iss.labels ?? [], predictedFiles: namedPaths(iss.body ?? ""), riskPaths, hotspots: namedHot?.files ?? [], cfg: o.light ?? {} });
      ev({ event: "LIGHT_ELIGIBILITY", mode: elig.mode, verdict: elig.verdict, light: elig.light, reasons: elig.reasons, signals: elig.signals });
      lightVerdict = elig.verdict;
      if (elig.mode !== "off") T.decisions.push(`Light lane ${elig.mode}: ${elig.verdict}${elig.reasons.length ? ` (${elig.reasons.map((x) => x.code).join(", ")})` : ""}`);
      // #4451: a light try skips the hotspots and the context pack; an upgrade computes them before the plan call
      const ffSource = fastForwardSource(o.light), ffFresh = ffSource === "investigation" && !frozen && !resumed && !salvagedRef && !recover; // #5426: the text verdict above is only a shadow signal then
      const lightTry = ffSource === "text" && elig.light && !hotLate && !frozen && !resumed && !salvagedRef && !recover;
      if (!lightTry) hotFacts = namedHot; // #4451: a light try still gives its builder no hotspot facts
      enumList = io.enumeratingTests ? ((await within(io.enumeratingTests({ cwd: wt, paths: namedPaths(iss.body ?? "") }), waitMs)) ?? []) : [];
      if (enumList === TIMED_OUT) enumList = [];
      facts = await factsPath([wt, cwd], io.fs?.exists);
      let ctxPack = null, packP = null;
      if (!(frozen || lightTry)) { // #5434: the plan waits for the pack at most waitMs; a late pack still posts and is read before implement
        const tPack = now(); packP = contextPackStep(); ctxPack = await within(packP, waitMs); setupStep("context_pack", tPack);
        if (ctxPack === TIMED_OUT) { ctxPack = null; T.decisions.push(`Context pack not ready in ${waitMs / 1000}s: the plan starts without it`); }
      }
      const planPrompt = () => builderPlanPrompt(issue, tcOpts()) + uiBuildRule(uiOn = uiOn || uiIssue(iss ?? {}), designConfig) + hotspotPlanNote(hotFacts) + enumeratingPlanNote(enumList) + invariantsPlanNote(vcfg.invariants) + reproPlanNote(reproOn()) + docsPlanNote(docsConfig) + pagePlanNote(pagesConfig) + unrunnableValidateNote(testRunners) + explorePlanRule(exploreCfg) + (ctxCfg.mode === "on" ? contextPackNote(ctxPack) : "");
      let lightDone = false, lightCommits = false;
      let ffPlan = "full", ffGo = false, lightElig = elig, lightPred = null, ffTriage = null; // #5426: how the plan call runs; ffGo = fast-forward to the light step
      const ffTriageOf = async (raw) => parseTriage(raw, await io.fs.read(`${wt}/${INVESTIGATION_FILE}`).catch(() => ""));
      if (ffFresh && elig.mode === "on") { // #5426: investigation first; its verdict, predicted files and size pick the depth
        await builder(++attemptN, investigationOnlyPrompt(issue, tcOpts()), null, true, () => investigationOnlyPrompt(issue, tcOpts()), { trigger: "plan" });
        planned = true; result = await readResult();
        if (["invalid", "already-fixed", "blocked"].includes(result?.status)) ffPlan = "none"; // the shared close/block handling below
        else {
          ffTriage = await ffTriageOf(await io.fs.read(`${wt}/${TRIAGE_FILE}`).catch(() => null));
          const fh = await hotspotsOf({ paths: ffTriage.files });
          lightElig = fastForwardEligibility({ title: iss.title, body: iss.body ?? "", labels: iss.labels ?? [], triage: ffTriage, textFiles: namedPaths(iss.body ?? ""), riskPaths, hotspots: fh?.files ?? [], cfg: o.light ?? {} });
          ev(fastForwardEvent(lightElig, ffTriage));
          T.decisions.push(`Investigation decides depth: ${lightElig.verdict}${lightElig.reasons.length ? ` (${lightElig.reasons.map((x) => x.code).join(", ")})` : ""}`);
          ffGo = lightElig.light; lightPred = ffTriage.files; hotFacts = fh ?? hotFacts;
          if (!ffGo) ffPlan = "contract";
        }
      }
      if (lightTry || ffGo) {
        { const f = await gateSetup(); if (f) return f; } // #5434: the light build is an implement-class session
        liveKeys = ["implementation"]; stage = "implement"; phaseLedger.enter("implement");
        tb.setSize(recoverySize(laneSize({ labels: (iss?.labels ?? []).map((l) => l?.name ?? l) }), recover)); // #4505
        const lightBase = pagesConfig ? String(await git(["ls-tree", "-r", "-z", "--name-only", base]).catch(() => "")).split("\0").filter(Boolean) : null; // #5648: pages already on the base are modified, not new
        const lr = await runLightStep({ title: iss.title, issueText, riskPaths, predictedFiles: lightPred ?? namedPaths(iss.body ?? ""), cfg: o.light ?? {}, validate: (c) => validateContract(c, issueText, { repro: reproOn(), pages: pagesConfig, baseFiles: lightBase, testPlan: reproOn() }),
          build: () => builder(++attemptN, (ffGo ? FF_BUILD_LEAD : "") + lightBuildPrompt(issue, tcOpts()) + hotspotBuildRule(hotFacts) + enumeratingBuildRule(enumList) + invariantsBuildRule(vcfg.invariants), ffGo ? sessionId : null, true, undefined, { trigger: "build" }),
          readResult, checkpoint: () => checkpoint("light build"), changedFiles, reproOf, numstat: () => git(["diff", "--numstat", `${base}...HEAD`]),
          runTests: async (cmds) => (io.runCommand ? runLightTests({ commands: mergeChecks(vcfg.invariants ?? [], cmds).commands, parallelism: Number(verifyParallelism()) || 1, now, timeoutMs: vcfg.precheckTimeoutSeconds * 1000, acquire: () => heavyAcquire("precheck"), // #4451: host-capped
            run: ({ command, timeoutMs, workers }) => { const env = laneEnv(); return io.runCommand({ command, cwd: wt, timeoutMs, env: env.FORGE_HOST_PARALLELISM ? { ...env, FORGE_HOST_PARALLELISM: String(workers) } : env }); } }) : null),
          fixTests: (failed) => builder(++attemptN, precheckFailurePrompt(capLogs(failed.map((f) => ({ ...f, log: f.output }))).map((f) => ({ command: f.command, rc: f.rc, output: f.log })), vcfg.mode), sessionId, false, undefined, { mode: "resume", trigger: "precheck" }),
          apiShape: () => (io.apiShape ? io.apiShape({ cwd: wt, base }).catch(() => null) : null) });
        stage = "plan"; liveKeys = ["investigation"]; result = (await readResult()) ?? result;
        if (!lr.upgrade) {
          lightDone = true; light = true; frozen = historyRows(lr.contract); hash = contractHash(contractJson(frozen));
          let body = renderContract(frozen, hash, { scope: scopeHash });
          if (body.length > MAX_COMMENT_CHARS - 500) body = renderContract(frozen, hash, { compact: true, scope: scopeHash });
          await post(["FORGE:CONTRACT", "FORGE:PLAN"], body);
          await claimSurfaceSlots(frozen);
          ev({ event: "CONTRACT_FROZEN", hash, requirements: frozen.requirements.length, deferred: 0, derived: "light" });
          await emit({ event: "CONTRACT_FROZEN", hash, requirements: frozen.requirements.length, deferred: 0, derived: "light" });
          ev({ event: "LIGHT_DONE", files: lr.files.length, test_failures: lr.testFailures, repro: lr.repro, cost_usd: usage.cost_usd });
          T.decisions.push(`Light lane: one builder session, contract ${hash} derived from the diff and the test`);
          if (ffGo) { T.decisions.push(skippedLine(lightElig)); await flushStages({ status: "fixed" }, ["investigation"]); } // #5426: FORGE:INVESTIGATION is read downstream
          try { await post("FORGE:LITE", renderLiteReceipt({ lr, eligibility: lightElig, costUsd: usage.cost_usd, contractHash: hash, skipped: ffGo ? skippedStages(lightElig) : [] })); } catch { /* #4452: the receipt is best effort */ }
        } else {
          lightCommits = lr.files.length > 0;
          ev({ event: "LIGHT_UPGRADE", reasons: lr.reasons, cost_usd: usage.cost_usd });
          lightUpgrade = lr.reasons.map((x) => x.code);
          T.decisions.push(`Light lane upgraded to the full lane: ${lr.reasons.map((x) => x.code).join(", ")}`);
          try { await post("FORGE:LITE", renderLiteReceipt({ lr, eligibility: lightElig, costUsd: usage.cost_usd })); } catch { /* #4452: the receipt is best effort */ }
          const d = buildResumeDigest({ state: null, comments: trustedComments, contract: null, files: lr.files, lane });
          resumeNote = d.text + upgradeNote(lr.reasons);
          result = null; // the light result.json must not read as the plan's verdict
          if (io.fs.write) { try { await io.fs.write(`${wt}/${RESULT_FILE}`, "{}\n"); } catch { /* the plan overwrites it */ } }
          hotFacts = await hotspotsOf({ paths: namedPaths(iss.body ?? "") }); // #4451: the full lane keeps its plan facts
          ctxPack = await contextPackStep();
        }
      }
      if (!frozen) {
        if (ffPlan === "contract") await phaseLedger.during("contract", () => builder(++attemptN, contractStepPrompt(issue, tcOpts()) + recoverNote() + decisionsNote, sessionId, true, planPrompt, { mode: "resume", trigger: "plan" })); // #5426: same session, investigation already written
        else if (ffPlan === "full") { const tPrompt = now(), planText = planPrompt(); setupStep("prompt_assembly", tPrompt); await builder(++attemptN, planText + (hasCommits || lightCommits ? PLAN_RERUN_NOTE.replace("BASE", lane) : "") + recoverNote() + resumeNote + decisionsNote, null, true, planPrompt, { trigger: "plan" }); }
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
          // #5152: already-fixed is delivered behaviour (`completed`); only invalid is dropped scope (`not planned`)
          await Promise.all([result.status === "already-fixed" && (await closeBlockers("completed", resumed?.pr ?? null)).length ? null : ghw(["issue", "close", String(issue), "-R", repo, "--reason", result.status === "already-fixed" ? "completed" : "not planned"]), label("invalid")]); // #5437: independent calls
          if (result.status === "invalid") { const f = await resolveFindingLabel({ io, issue, labels: iss.labels, reason: "invalid" }); if (f.error) T.anomalies.push(`finding label not resolved: ${f.error}`); } // #5254
          return await finish("invalid", result.summary ?? result.status, result.status === "already-fixed" ? { close: "already-fixed" } : {});
        }
        const blocked = await endIfBlocked();
        if (blocked) return blocked;
        if (ffFresh && elig.mode === "shadow") { const tri = await ffTriageOf(null); ev(fastForwardEvent(fastForwardEligibility({ title: iss.title, body: iss.body ?? "", labels: iss.labels ?? [], triage: tri, textFiles: namedPaths(iss.body ?? ""), riskPaths, hotspots: (hotFacts?.files ?? []).filter((f) => tri.files.includes(f?.path ?? f)), cfg: o.light ?? {} }), tri, { shadow: true })); } // #5426: zero extra cost, no extra runner call
        { const f = await gateSetup(); if (f) return f; } // #5434: the contract checks below run commands with the lane env
        // #4353: the engine's scope gate is the only scope authority; a pure file-scope validate is dropped before it is checked or frozen
        const dropScope = (c) => {
          const d = dropScopeValidates(c);
          if (d.dropped.length) {
            ev({ event: "CONTRACT_SCOPE_VALIDATE_DROPPED", runs: d.dropped });
            const note = `Scope-check validate ${d.dropped.map((x) => x.id).join(", ")} dropped at contract freeze: the engine's scope gate (deliverables plus typed amendments) enforces scope`;
            if (!T.decisions.includes(note)) T.decisions.push(note);
          }
          const o = tagOutOfBand(d.contract); // #4404: a requirement measured outside the lane is judged by its instrumentation
          if (o.tagged.length) {
            ev({ event: "CONTRACT_OUT_OF_BAND_TAGGED", ids: o.tagged });
            const note = `Requirement(s) ${o.tagged.join(", ")} tagged verify out_of_band at contract freeze (measured by a job outside the lane)`;
            if (!T.decisions.includes(note)) T.decisions.push(note);
          }
          return o.contract;
        };
        let contract = dropScope(await readContract());
        contract = freezeRewrites(contract);
        await persistGenChecks();
        await refreshIssue("contract validation");
        const snapContract = (c) => { // #5244: a near-verbatim quote snaps to the issue's exact sentence instead of ending needs-human
          const sq = snapQuotes(c, issueText);
          for (const x of sq.snapped) { ev({ event: "CONTRACT_QUOTE_SNAPPED", id: x.id }); T.decisions.push(`Contract quote ${x.id} snapped to the issue sentence "${x.to.slice(0, 120)}"`); }
          return sq.contract;
        };
        contract = snapContract(contract);
        await classifyStage(sessionId ? (problems) => builder(++attemptN, `${contractCorrectionPrompt(problems)}\nThis concerns .forge-lean/classification.json: fix only the invalid fields.`, sessionId, false, planPrompt, { trigger: "contract_correction" }) : null);
        const wtRead = (p) => { try { return readFileSync(join(wt, p), "utf8"); } catch { return ""; } }; // #5585: noindex pages are not public
        const freezeBase = pagesConfig ? String(await git(["ls-tree", "-r", "-z", "--name-only", base]).catch(() => "")).split("\0").filter(Boolean) : null; // #5648
        const freezeCheckIds = await (async () => { try { return new Set(Object.keys(await checksAt(git, [base], wt))); } catch { return null; } })(); // first-pass: the base's registered post-deploy check ids
        let vc = validateContract(contract, issueText, { repro: reproOn(), pages: pagesConfig, baseFiles: freezeBase, testPlan: reproOn(), readFile: wtRead, checkIds: freezeCheckIds });
        const found0 = await preflightValidates(contract); // #4328: validate commands the host cannot run share the one correction
        let missed = found0;
        // #5653: an unrunnable command is rewritten from the repo catalogue (forge.yaml recipes first, then CI-derived) before any builder correction
        if (found0.length) {
          const texts = (validateCatalogSources ?? DEFAULT_CATALOG_SOURCES).map(wtRead);
          const rw = rewriteMissed(contract, mergeRecipes(validateRecipes, deriveCatalog(texts)), found0.flatMap((m) => m.ids ?? []), applyValidateRecipes);
          if (rw.applied.length) {
            contract = snapContract(rw.contract);
            for (const x of rw.applied) T.decisions.push(`validate catalogue rewrote unrunnable ${x.id}: \`${x.from}\` -> \`${x.to}\``);
            vc = validateContract(contract, issueText, { repro: reproOn(), pages: pagesConfig, baseFiles: freezeBase, testPlan: reproOn(), readFile: wtRead, checkIds: freezeCheckIds });
            missed = await preflightValidates(contract);
          }
        }
        let misses = missed;
        const correctContract = async (problems, note) => {
          T.decisions.push(`Contract rejected (${problems[0]}); ${note}`);
          await builder(++attemptN, contractCorrectionPrompt(problems), sessionId, false, planPrompt, { trigger: "contract_correction" });
          contract = freezeRewrites(dropScope(await readContract()));
          await persistGenChecks();
          await refreshIssue("contract validation");
          contract = snapContract(contract);
          vc = validateContract(contract, issueText, { repro: reproOn(), pages: pagesConfig, baseFiles: freezeBase, testPlan: reproOn(), readFile: wtRead, checkIds: freezeCheckIds });
        };
        if ((!vc.ok || missed.length || testRunnerProblems(contract, testRunners).length) && sessionId) {
          await correctContract([...vc.problems, ...preflightProblems(missed), ...testRunnerProblems(contract, testRunners)], "resumed once");
          if (missed.length) misses = await preflightValidates(contract);
        }
        // #5623: builder-correctable contract problems get up to contractMaxCorrections rounds (default 3), each with only the
        // problems still open; the round ends early when a correction changes nothing (same problem set twice).
        let rounds = vc.ok ? 0 : 1, lastProblems = null;
        while (!vc.ok && sessionId && rounds < contractMaxCorrections && contractSelfCorrectable(vc.problems)) {
          const key = JSON.stringify([...vc.problems].sort());
          if (key === lastProblems) break;
          lastProblems = key; rounds++;
          await correctContract(vc.problems, `${vc.problems.length} problem(s) still open, correction round ${rounds} of ${contractMaxCorrections}`);
        }
        if (!vc.ok) ev({ event: "CONTRACT_INVALID_RULES", rules: contractRuleCounts(vc.problems) }), await emit({ event: "CONTRACT_INVALID_RULES", rules: contractRuleCounts(vc.problems) }); // #5587: per-rule counts for the batch false-park rate
        planMisses = misses;
        if (found0.length) {
          ev({ event: "VALIDATE_PREFLIGHT", misses: misses.map((m) => ({ ids: m.ids, tool: m.tool, kind: m.kind, source: m.source })), found: found0.map((m) => ({ ids: m.ids, tool: m.tool, kind: m.kind, source: m.source })), corrected: misses.length === 0 });
          if (misses.length) {
            T.anomalies.push(`Validate preflight: the host lacks ${misses.map((m) => m.tool).join(", ")} after the contract correction (advisory; a failed rerun ends env.tool_missing)`);
            T.decisions.push(`Validate preflight left ${misses.length} miss(es) after one correction; contract frozen anyway`);
          }
        }
        await flushStages(result ?? { status: "fixed" }, ["investigation"]); // always posted: FORGE:INVESTIGATION/VALIDATE are read downstream
        if (!vc.ok) return await needsHuman(`The builder's contract is still invalid after ${rounds} correction(s):\n${vc.problems.slice(0, 12).map((x) => `- ${x}`).join("\n")}`, OUTCOME_CODES.CONTRACT_INVALID, { ...(issueEdited ? { issueEdited: true } : {}), ...(vc.problems.every((x) => /: quote is not verbatim/.test(x)) ? { quoteMismatch: true } : {}) });
        frozen = historyRows(contract); // #4694 guards
        frozen = withDecisionRows(frozen, readDecisionIndex(repo)); // #4695: anchored decisions on the deliverable paths; one index read
        const hRows = (frozen.preserve ?? []).filter((p) => p.source === "decision");
        if (hRows.length) T.decisions.push(`Anchored decisions bind this lane: ${hRows.map((p) => `${p.id} (${p.decision})`).join(", ")}`);
        hash = contractHash(contractJson(frozen));
        let body = renderContract(frozen, hash, { scope: scopeHash });
        if (body.length > MAX_COMMENT_CHARS - 500) body = renderContract(frozen, hash, { compact: true, scope: scopeHash }); // the JSON must survive the comment cap
        await post(["FORGE:CONTRACT", "FORGE:PLAN"], body);
        const deferredN = frozen.requirements.filter((r) => TRACKED.includes(r.disposition)).length;
        ev({ event: "CONTRACT_FROZEN", hash, requirements: frozen.requirements.length, deferred: deferredN });
        await emit({ event: "CONTRACT_FROZEN", hash, requirements: frozen.requirements.length, deferred: deferredN });
        T.decisions.push(`Contract frozen (${hash}): ${frozen.requirements.length} requirement(s), ${deferredN} deferred pending review`);
      } else {
        T.validate = lightDone ? "light lane (no plan session)" : "resumed (existing branch)";
      }
      const dgFiles = (frozen?.deliverables ?? []).map((d) => d?.path).filter(Boolean);
      const designComments = (iss?.comments ?? []).filter(isTrustedIssueComment);
      const dgBase = dgFiles.length && designConfig ? String(await git(["ls-tree", "--name-only", base, "--", ...dgFiles]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean) : []; // #5648: deliverables already on the base are modified pages
      const designRoute = designGate({ files: dgFiles, cfg: designConfig, comments: designComments, labels: iss?.labels, baseFiles: dgBase }); // #5330: opt-in (forge.yaml design.routes): a page without a FORGE:DESIGN_SPEC goes to /design
      if (designRoute.route) {
        ev({ event: "DESIGN_ROUTED", pages: designRoute.pages, blocked: designRoute.blocked });
        T.decisions.push(`Design gate: ${designRoute.reason}${designRoute.blocked ? " (design.gate: blocking, lane stopped)" : " (advisory)"}`);
        if (designRoute.blocked) return await needsHuman(`Design gate (forge.yaml design.gate: blocking): ${designRoute.reason}.\n\nRun /design on #${issue}; a FORGE:DESIGN_SPEC comment or the \`${designConfig.specLabel}\` label lifts the hold.`, OUTCOME_CODES.DESIGN_SPEC_REQUIRED, { ask: `Run /design for #${issue} (${designRoute.pages.slice(0, 3).join(", ")})` });
      }
      { // #5447: the test plan's declared env is checked on the host the lane runs on before building; a missing runner is provisioned once, else the lane ends env.tool_missing (the orchestrator re-places it on a host that has it)
        const probeEnv = async () => { const miss = []; for (const t of declaredEnv(frozen)) { const r = io.runCommand ? await io.runCommand({ command: t === "pytest" ? "python3 -m pytest --version" : `command -v ${t} >/dev/null || { test -d node_modules/${t} && ! test -e node_modules/.bin/${t}; } || ls -d .venv/lib/python*/site-packages/${t} >/dev/null 2>&1`, cwd: wt, timeoutMs: 30000, env: laneEnv() }).catch(() => ({ rc: 1 })) : { rc: 0 }; if ((r?.rc ?? 0) !== 0) miss.push(t); } return miss; };
        let envMiss = await probeEnv();
        if (envMiss.length) {
          try {
            if (io.deps?.prepare) await io.deps.prepare({ wt, repoKey: repoKey(cwd), env: toolchain?.env ?? undefined });
            if (envMiss.includes("pytest") && io.runCommand) await io.runCommand({ command: "python3 -m pip install --user --quiet pytest", cwd: wt, timeoutMs: 180000, env: laneEnv() });
            envMiss = await probeEnv();
            ev({ event: "TESTPLAN_ENV_PROVISIONED", remaining: envMiss });
          } catch { /* keep the original miss */ }
        }
        if (envMiss.length) return await needsHuman(`This host lacks ${envMiss.join(", ")}, which the contract's test plan declares in env; the lane is re-placed on a host that has it before the builder implements.`, OUTCOME_CODES.ENV_TOOL_MISSING);
      }
      { // #5450: the frozen validate entries' `env` names verify.sandboxes; none declared: no provider call
        const names = envNamesOf(frozen);
        if (names.length && !sandboxDown) {
          const labels = dockerLabels({ batch: o.batchId ?? "adhoc", lane: `lean-${issue}`, issue, expires: now() + LEDGER_TTL_MS });
          const sb = await provisionSandboxes({ names, specs: vcfg.sandboxes ?? {}, lane: `lean-${issue}`, docker: (a) => io.docker(a), exec: (a) => io.runCommand({ command: a.command, cwd: wt, timeoutMs: 600000, env: { ...laneEnv(), ...a.env } }).then((x) => x?.r ?? x), ledger, labels, cwd: wt, now, cache: batchImageCache });
          if (!sb.ok) return await needsHuman(`Test sandbox unavailable (${sb.reason}): ${sb.detail}. Nothing was skipped and nothing merged.`, sb.reason === "no_docker" ? OUTCOME_CODES.ENV_TOOL_MISSING : OUTCOME_CODES.ENGINE_ERROR);
          sandboxEnv = sb.env; sandboxDown = sb.down;
          for (const l of sb.lines) T.decisions.push(l);
        }
      }
      if (o.placement?.where === "remote" && !recover) { // #4785: the frozen validate commands need a tool only the host has
        const relayed = new Set(o.relayCaps ?? []); // #4778: a relayed capability is served to the sandbox, so the lane builds there
        const hn = contractHostNeeds(frozen, o.hostCaps && { ...o.hostCaps, hostCapabilities: (o.hostCaps.hostCapabilities ?? []).filter((c) => !relayed.has(c)) });
        if (hn.caps.length) return await needsHuman(`Remote sandbox lacks host capability ${hn.caps.join(", ")}, which the frozen contract's validate command(s) ${hn.ids.join(", ")} need.\n\nThe dispatching host has it; the lane is recovered locally with the frozen contract.`, OUTCOME_CODES.ENV_CAPABILITY_REMOTE);
        // #5331: a tool the sandbox itself lacks (probed where the lane runs) ends the lane before the builder implements; the tool-missing recovery places it on the host (orchestrate placeOf)
        let tm = toolMisses(planMisses ?? await preflightValidates(frozen).catch(() => []));
        if (tm.tools.length) { // #5423: provision the sandbox once (nested lockfiles, pytest) and re-probe before giving the lane up
          try {
            if (io.deps?.prepare) await io.deps.prepare({ wt, repoKey: repoKey(cwd), env: toolchain?.env ?? undefined });
            if (tm.tools.includes("pytest") && io.runCommand) await io.runCommand({ command: "python3 -m pip install --user --quiet pytest", cwd: wt, timeoutMs: 180000, env: laneEnv() });
            tm = toolMisses(await preflightValidates(frozen).catch(() => []));
            ev({ event: "REMOTE_PROVISIONED", remaining: tm.tools });
          } catch { /* keep the original miss */ }
        }
        if (tm.tools.length) { // #5652: a recipe-backed tool is installed in this sandbox and re-probed before any host re-placement
          const withRecipe = tm.tools.filter(hasRecipe), noRecipe = tm.tools.filter((t) => !hasRecipe(t));
          if (withRecipe.length && io.runCommand) {
            const ins = await installLaneTools(withRecipe, { run: (a) => io.runCommand({ command: a.command, cwd: wt, timeoutMs: a.timeoutMs, env: laneEnv() }), root: process.getuid?.() === 0 });
            ev({ event: "REMOTE_TOOLS_INSTALLED", tools: withRecipe, ok: ins.ok });
            if (!ins.ok) return await needsHuman(`Installing ${ins.tool} in the remote sandbox failed (execution.lane_tools recipe); not re-placed on the host. Install stderr tail:\n${ins.stderrTail}`, OUTCOME_CODES.ENV_TOOL_MISSING);
            tm = toolMisses(await preflightValidates(frozen).catch(() => []));
            ev({ event: "REMOTE_PROVISIONED", remaining: tm.tools });
          }
          if (noRecipe.length && tm.tools.some((t) => noRecipe.includes(t))) return await needsHuman(`Remote sandbox lacks ${noRecipe.join(", ")}, and no lane_tools recipe exists for ${noRecipe.length > 1 ? "them" : "it"}. Add it to \`execution.lane_tools\` in forge.yaml once a recipe exists, or add a recipe for ${noRecipe.join(", ")} in bin/pool/lane-tools.mjs (RECIPES).`, OUTCOME_CODES.ENV_TOOL_MISSING);
        }
        if (tm.tools.length) {
          ev({ event: "REMOTE_TOOL_MISSING", tools: tm.tools, ids: tm.ids });
          return await needsHuman(`Remote sandbox lacks ${tm.tools.join(", ")}, which the frozen contract's validate command(s) ${tm.ids.join(", ")} need; the lane is re-placed on the host before the builder implements.`, OUTCOME_CODES.ENV_TOOL_MISSING);
        }
      }
      T.plan = [`contract ${hash}${lightDone ? " (derived, light lane)" : ""}`, `${frozen.requirements.length} requirement(s)`];
      { // #4392, #4505: next size on a budget recovery; #4587: a big L contract and an L recovery get extra turns
        const sz = recoverySize(laneSize({ contract: frozen, labels: (iss?.labels ?? []).map((l) => l?.name ?? l) }), recover);
        tb.setSize(sz, scaledExtra({ size: sz, contract: frozen, recover, base: (turnBudgets ?? {}).L ?? TURN_BUDGET_DEFAULTS.L }));
        laneCeiling = ceilingFor(sz, { tokens: contextCeilingTokens, bySize: contextCeilingBySize }); // #5346
      }
      if (io.fs.write) { try { await io.fs.write(`${wt}/${CONTRACT_FILE}`, `${contractJson(frozen)}\n`); } catch { /* the prompt still names it */ } }
      // #4364: what `forgedock check` needs from the operator's forge.yaml (gitignored, so not in the worktree)
      if (io.fs.write) { try { await io.fs.write(`${wt}/${CHECK_PLAN_FILE}`, `${JSON.stringify({ v: 1, base, mode: vcfg.mode, learned: learnedCommands, invariants: vcfg.invariants ?? [], maxMinutes: Number(o.precheck?.maxMinutes) > 0 ? Number(o.precheck.maxMinutes) : null, precheckTotalSeconds: vcfg.precheckTotalSeconds, precheckTimeoutSeconds: vcfg.precheckTimeoutSeconds })}\n`); } catch { /* the CLI falls back to forge.yaml */ } }
      route = routeBuilder({ contract: frozen, riskPaths, cfg: routingCfg, topModel: builderModel }); // #4394
      {
        const rec = { event: "BUILDER_ROUTE", mode: route.mode, class: route.class, tier: route.tier, model: route.model ?? "default", risk: route.risk };
        ev(rec); await emit(rec);
        T.decisions.push(`Builder routed to the ${route.tier} tier (${route.class}; ${route.model ?? "CLI default"})`);
      }
      if (!isSplit && !adoptPr && io.sequenceReserveBuild) { // #5235: reserve numbers / versions before the builder picks them from its stale snapshot
        const rs = await io.sequenceReserveBuild({ cwd: wt, base, lane, repo, issue, deliverables: frozen?.deliverables ?? [], versioned: o.sequenceVersioned ?? [] }).catch(() => []);
        seqBuildNote = sequenceBuildRule(rs);
        if (rs.length) { ev({ event: "SEQUENCE_RESERVED", reservations: rs }); T.decisions.push(`Sequence numbers reserved at build start: ${rs.map((r) => `${r.cls ?? r.dir}=${r.numbers.join(",")}`).join("; ")}`); }
      }
      stampHash = hash; // #5333
      await claimSurfaceSlots(frozen); // #5340: the full and recovered paths reach the builder here with the contract settled
      if (!ctxPack && packP) ctxPack = await packP.catch(() => null); // #5434: a pack that missed the plan wait still reaches the build
      const openPaths = (frozen?.deliverables ?? []).map((d) => d?.path); // #5347: facts for the build's opening batch
      const openMap = io.runCommand ? await readTestMapAtRef(git, base).catch(() => null) : null;
      const implementPrompt = builderImplementPrompt(vcfg.mode, tcOpts()) + seqBuildNote + buildOpeningNote({ paths: openPaths, tests: selectCommands(openMap, openPaths), packFiles: ctxCfg.mode === "on" ? ctxPack?.files : [] }) + hotspotBuildRule(hotFacts) + enumeratingBuildRule(enumList) + invariantsBuildRule(vcfg.invariants) + exploreBuildRule(exploreCfg) + uiBuildRule(uiOn = uiOn || uiChanged(dgFiles).length > 0, designConfig) + designGateNote(designRoute) + generatorNote(surfaceClaim?.generated) + (planned ? "" : (fromCheckpoint ? CONTINUE_NOTE : RERUN_NOTE).replace("BASE", lane)) + (salvagedRef ? SALVAGE_NOTE.replaceAll("REF", salvagedRef) : "") + recoverNote() + (planned ? "" : resumeNote + decisionsNote);
      liveKeys = ["implementation"];
      { const f = await gateSetup(); if (f) return f; } // #5434: resumed or frozen lanes skip the plan
      stage = "implement"; phaseLedger.enter("implement");
      let buildPrompt = implementPrompt, noCeiling = false;
      if (!lightDone) { // #5346: a session certain to restart is narrowed (or, when the named files alone exceed the ceiling, left uncapped) before it starts
        const pred = predictRestart({ ceiling: laneCeiling, promptBytes: Buffer.byteLength(implementPrompt), fileBytes: await namedFileBytes(frozen) });
        if (pred.predicted) {
          buildPrompt = implementPrompt.replace(exploreBuildRule(exploreCfg), "") + NARROW_NOTE;
          noCeiling = pred.certain;
          ev({ event: "CONTEXT_PREDICT", estimate_tokens: pred.estimate, ceiling: pred.ceiling, certain: pred.certain });
          T.decisions.push(`Build predicted to restart (about ${pred.estimate} of ${pred.ceiling} context tokens at start): context narrowed${pred.certain ? "; the named files alone exceed the ceiling, so this build runs without it" : ""}`);
        }
        await builder(++attemptN, buildPrompt, planned ? sessionId : null, true, undefined, { trigger: "build", noCeiling });
      }
      stage = "fix"; // later builder rounds fix precheck, CI, structure, docs or conformance findings
      result = await readResult();
      if (carriedPasses.length && result && io.fs.write) { // #5331: a validate id that passed on this same head is not re-run: its row is carried, marked
        const headNow = String(await git(["rev-parse", "HEAD"]).catch(() => "")).trim(), rows = Array.isArray(result.validation) ? result.validation : [];
        const carry = carriedPasses.filter((x) => x.head === headNow && !rows.some((r) => r?.id === x.id) && (frozen?.validate ?? []).some((v) => v.id === x.id));
        if (carry.length) {
          result = { ...result, validation: [...rows, ...carry.map((x) => ({ id: x.id, command: x.command, exit: 0, carried: true }))] };
          try { await io.fs.write(`${wt}/${RESULT_FILE}`, `${JSON.stringify(result)}\n`); T.decisions.push(`Validate result(s) ${carry.map((x) => x.id).join(", ")} carried from an earlier run: passed on this same head`); } catch { /* the gate reads what is on disk */ }
        }
      }
      { // #4374: the builder's self-review against the shared rubric, log only
        const sr = readSelfReview(result);
        if (sr) ev(sr.state === "present" ? { event: "SELF_REVIEW", answers: sr.items.length, no: sr.no } : { event: "SELF_REVIEW_MISSING", state: sr.state });
      }
      // #4364: a builder that writes fixed without a green `forgedock check` on its final tree; recorded, never a failure
      if (result?.status === "fixed") { const state = await selfCheckNow(); if (state !== "green") ev({ event: "SELF_CHECK_MISSING", state }); }
      if (result?.status === "fixed" && sessionId && !result.amendments?.length) { // #5345: a red self-check on the final tree is fixed before any reviewer runs
        let rec = null; try { rec = JSON.parse(await io.fs.read(`${wt}/${SELF_CHECK_FILE}`)); } catch { /* none recorded */ }
        const red = (await selfCheckNow()) === "red" ? selfCheckFailures(rec) : [];
        if (red.length) ev({ event: "SELF_CHECK_RED", codes: red.map((f) => f.code) });
        if (red.length) await fixRound("conformance", conformanceResumePrompt(red, vcfg.mode, lane), red, "conformance", failureLog(red));
        if (red.length) result = (await readResult()) ?? result;
      }
      {
        const blocked = await endIfBlocked();
        if (blocked) return blocked;
      }
      files = await changedFiles();
      if (!files.length) return await needsHuman(`Builder made no commit${result ? ` (status "${result.status}")` : " and wrote no result.json"}.\n\n${result?.summary ?? ""}`, OUTCOME_CODES.BUILDER_NO_COMMIT);
      await recheckStages(["implementation"]); // #5333
      await flushStages(result, ["implementation"]);
      T.implement = [`${files.length} file(s)`, branch];
      T.decisions.push(`Builder verdict: ${result?.status ?? "none"}`);
    }

    phaseLedger.enter("precheck");
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
        const { failed, timedOut } = splitPrecheckResults(results); // #5332: rc 124 is host load, never a failing check
        const roundFailed = failed.length > 0 || timedOut.length > 0;
        ev({ event: "PRECHECK_COMMANDS", round, results: [...results.map(({ command, rc, ms }) => ({ command, rc, ms })), ...deferred.map((command) => ({ command, status: "deferred-to-ci" }))],
          ms: round$.ms, parallelism, workers, ...(picked.source !== "learned" ? { source: picked.source } : {}), ...(roundFailed ? { self_check: timedOut.length ? "timed_out" : await selfCheckNow() } : {}) });
        verifyFacts.commands = results.map(({ command, rc }) => ({ command, rc }));
        const timedNames = timedOut.length ? timedOutDetail(timedOut, picked.perCommandMs) : "";
        if (timedOut.length) T.anomalies.push(`deferred-to-ci: pre-PR check timed out (host load, not a code failure); left to CI: ${timedNames}`);
        if (!failed.length && timedOut.length && (vcfg.precheckBlock || guardFailing(timedOut))) return await needsHuman(`Environment error (not a check failure): pre-PR check command(s) timed out even after one longer retry, which is host load rather than a failing check; no builder resume was spent, the branch is pushed and nothing merged: ${timedNames}`, ENV_VALIDATE_TIMEOUT);
        if (!failed.length) { checkCommandsFailing = false; if (round) T.decisions.push(`Declared check commands pass after ${round} builder fix round(s)`); await gatePassed("precheck"); break; }
        const names = failed.map((f) => `\`${f.command}\` (exit ${f.rc})`).join(", ");
        if (isSplit) return await needsHuman(`Declared check command(s) fail on the refactor:split move (no builder edits a split); nothing merged: ${names}`, OUTCOME_CODES.CI_RED);
        checkCommandsFailing = true;
        { const red = await guardRed(failed); if (red) return red; } // #5239: a guard that also fails on the base defers the lane
        if (round >= vcfg.maxRounds || !sessionId) { if (vcfg.precheckBlock || guardFailing(failed)) return await needsHuman(`Declared check command(s) still failing before the PR (verify.precheck_block); nothing merged: ${names}`, OUTCOME_CODES.CI_RED); T.anomalies.push(`Declared check command(s) still failing before the PR: ${names}`); break; }
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
        if (String(await git(["rev-parse", "HEAD"])).trim() === before) { if (vcfg.precheckBlock || guardFailing(failed)) return await needsHuman(`Declared check command(s) failing and the builder made no new commit for them (verify.precheck_block); nothing merged: ${names}`, OUTCOME_CODES.CI_RED); T.anomalies.push(`Declared check command(s) failing and the builder made no new commit for them: ${names}`); break; }
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
    let structure = await structureOf(); // #4502: a light lane gets the same structure gate
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
        const docsBefore = await changedFiles();
        await fixRound("docs", docsPrompt(docs.output), [], "docs", String(docs.output ?? ""));
        await upsertStage("implementation");
        result = (await readResult()) ?? result;
        await noteFreshnessDocs(docsBefore, true);
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
      if (missing.length && vcfg.enumeratingMechanical !== false) { // #5348: the detector names the list entry: write it, then re-check; a session only for the rest (#5480: forge.yaml lean.enumerating.mechanical false skips it)
        const m = await enumeratingMech(missing);
        if (await mechCommit("enumerating", m.applied, m.applied.map((x) => x.test))) missing = await missingNow();
      }
      if (missing.length && sessionId) {
        ev({ event: "ENUMERATING_MISSING", count: missing.length });
        T.decisions.push(`Enumerating test(s) miss new symbol(s): ${missing.slice(0, 5).map((m) => `${m.symbol} → ${m.test}`).join(", ")}; builder resumed once`);
        // #5348: one narrow session per stage: pending duplicate-export and English-copy findings ride along (their gates re-check)
        const pend = [];
        if (io.duplicateExports && vcfg.duplicateExports !== false) { const d = await dupsResidual(); if (d.length) pend.push({ title: "Duplicate exports", text: duplicateExportsPrompt(d, vcfg.mode), files: d.flatMap((x) => [x.path, ...(x.others ?? [])]) }); }
        if (io.englishCopies) { const c = (await io.englishCopies({ cwd: wt, base }).catch(() => null)) ?? []; if (c.length) pend.push({ title: "English copies", text: i18nCopiesPrompt(c, vcfg.mode), files: c.map((x) => x.path) }); }
        const task = pend.length ? mergeNarrowTasks([{ title: "Enumerating tests", text: missingEntriesPrompt(missing, vcfg.mode) }, ...pend]) : missingEntriesPrompt(missing, vcfg.mode);
        if (pend.length) T.decisions.push(`Batched narrow fix: enumerating tests with ${pend.map((x) => x.title.toLowerCase()).join(", ")} in one session`);
        await fixRound("enumerating", String(task), [], "enumerating", missing.map((m) => `enumerating test ${m.test} misses new member \`${m.symbol}\``).join("\n") + pend.map((x) => `\n${x.text}`).join(""), { files: [...new Set([...missing.map((m) => m.test), ...pend.flatMap((x) => x.files)])] });
        await upsertStage("implementation");
        result = (await readResult()) ?? result;
        missing = await missingNow();
      }
      if (!missing.length) await gatePassed("enumerating");
      if (missing.length) T.anomalies.push(`Enumerating test(s) still miss new symbol(s): ${missing.slice(0, 5).map((m) => `${m.symbol} → ${m.test}`).join(", ")}`);
    }
    /**
     * #4322: null (nothing to do), {done} (terminal), or {renumbered: true, deterministic?}. Fetches the lane, so the check
     * sees its tip. #4386: the engine renumbers first (no builder, no session); the builder only when that is unsupported.
     * `laneRef`: the pre-merge lane head after a base-sync took the base side of sequence-only conflicts.
     */
    /** #5235: a renumber (hand-off or base-sync) reruns the frozen validates (one fix round on failure, then an anomaly) before the merge. */
    async function revalidateRenumbered(trigger) {
      if (!io.runCommand || !frozen?.validate?.length) return;
      const env = laneEnv();
      const runAll = () => revalidate({ validates: frozen.validate, runOne: async (v) => { const x = (await heavyStep("precheck", async () => (await runWithTimeoutRetry((timeoutMs) => io.runCommand({ command: resolveForgedockPaths(String(v.command), { exists: existsSync, checksCli: CHECKS_CLI, forgedockCli: FORGEDOCK_CLI }), cwd: wt, timeoutMs, env }), vcfg.precheckTimeoutSeconds * 1000)).r)) ?? {}; return { rc: x.rc, output: x.output }; } });
      let bad = await runAll();
      ev({ event: "SEQUENCE_REVALIDATED", trigger, failed: bad.map((x) => x.id) });
      if (bad.length && sessionId) {
        const log = bad.map((x) => `${x.id} (exit ${x.rc}): ${x.output.slice(-1500)}`).join("\n");
        const renumberTask = () => `The sequence renumber after ${trigger} changed the tree and these frozen validate commands now fail:\n${log}\n\nFix the cause (the renumber itself is correct), ${syncChecks(vcfg.mode)}, commit. Do not push.`; // called below so the #4362 trigger-literal check parses the call
        await fixRound("sequence", renumberTask(), [], "sequence", log);
        files = await changedFiles();
        bad = await runAll();
      }
      if (bad.length) T.anomalies.push(`Frozen validate(s) fail after the ${trigger} renumber: ${bad.map((x) => x.id).join(", ")}`);
    }
    async function sequenceHandoff(trigger, { laneRef = null } = {}) {
      if (!io.sequenceCheck || isSplit) return null;
      try { await git(["fetch", "origin", lane]); } catch { /* offline: use the local ref */ }
      const collisions = (await io.sequenceCheck({ cwd: wt, base, versioned: o.sequenceVersioned }).catch(() => null)) ?? [];
      if (!collisions.length) return null;
      const before = (await io.sequenceSnapshot?.({ cwd: wt, base }).catch(() => null)) ?? [];
      ev({ event: "SEQUENCE_COLLISION", trigger, files: collisions.map((c) => c.lane) });
      const taken = collisions.filter((c) => c.base.length).map((c) => `${c.lane} vs ${c.base.join(", ")}`).join("; ");
      if (io.sequenceRenumber) {
        const renumber = async (ref) => (await io.sequenceRenumber({ cwd: wt, base, ...(ref ? { laneRef: ref } : {}), regenerate: o.sequenceRegenerate ?? null, versioned: o.sequenceVersioned ?? [], reserve: io.sequenceLease?.reserve ? (x) => io.sequenceLease.reserve({ repo, lane, issue, ...x }) : null, openNumbers: io.sequenceOpenNumbers ? (x) => io.sequenceOpenNumbers({ cwd: wt, lane, ...x }) : null }).catch((e) => ({ unsupported: String(e?.message ?? e) }))) ?? { unsupported: "no result" };
        let det = await renumber(laneRef);
        if (det.nonSequence?.length && !laneRef) { // #4732: base-sync first (sequence files take the base side, the builder resolves the rest), then renumber deterministically
          const pre = String(await git(["rev-parse", "HEAD"])).trim(), left = async () => String(await git(["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean);
          let synced = true;
          try { await git(["merge", "--no-edit", base]); } catch {
            const rs = await io.sequenceResolve?.({ cwd: wt, files: await left(), partial: true }).catch(() => null);
            if (rs?.remaining?.length) {
              T.decisions.push(`Sequence renumber (${trigger}): base-sync conflicts in ${rs.remaining.join(", ")}; builder resolves, then the engine renumbers`);
              await fixRound("sequence", sequenceSyncPrompt(base, rs.remaining, vcfg.mode), [], "sequence", `base-sync conflict: ${rs.remaining.join(", ")}`);
            } else synced = Boolean(rs?.ok);
            if (!synced || (await left()).length) { try { await git(["merge", "--abort"]); } catch { /* none */ } try { await git(["reset", "-q", "--hard", pre]); } catch { /* best effort */ } synced = false; }
          }
          if (synced) { det = await renumber(pre); if (det.ok) ev({ event: "SEQUENCE_SYNC_FIRST", trigger, files: det.moves?.length ?? 0 }); }
        }
        if (det.ok && det.moves?.length) {
          ev({ event: "SEQUENCE_RENUMBERED", trigger, mode: "deterministic", moves: det.moves });
          T.decisions.push(`Sequence number(s) taken on ${lane} (${trigger}): ${taken}; renumbered deterministically (no builder): ${det.moves.map((m) => `${m.from} → ${m.to}`).join(", ")}`);
          const v = (await io.sequenceVerify?.({ cwd: wt, base, before, moves: det.moves, versioned: o.sequenceVersioned }).catch(() => null)) ?? { ok: false, problems: ["renumber could not be verified"] };
          if (!v.ok) return { done: await needsHuman(`Sequence-numbered files still collide with ${lane} after the deterministic renumber (${trigger}); nothing merged:\n${v.problems.slice(0, 10).map((x) => `- ${x}`).join("\n")}`, OUTCOME_CODES.BASE_CONFLICT) };
          await gatePassed("sequence");
          files = await changedFiles();
          await revalidateRenumbered(trigger);
          return { renumbered: true, deterministic: true };
        }
        const why = det.unsupported ?? "no movable sequence file";
        ev({ event: "SEQUENCE_RENUMBER_FALLBACK", trigger, reason: why });
        T.decisions.push(`Deterministic renumber not possible (${why}); builder renumbers`);
      }
      T.decisions.push(`Sequence number(s) taken on ${lane} (${trigger}): ${taken}; builder renumbers`);
      await fixRound("sequence", sequencePrompt(collisions, lane, vcfg.mode), [], "sequence", collisions.map((c) => `sequence number collision: ${c.lane} already taken by ${(c.base ?? []).join(", ")}`).join("\n"));
      result = (await readResult()) ?? result;
      const v = (await io.sequenceVerify?.({ cwd: wt, base, before, versioned: o.sequenceVersioned }).catch(() => null)) ?? { ok: false, problems: ["renumber could not be verified"] };
      if (!v.ok) return { done: await needsHuman(`Sequence-numbered files still collide with ${lane} after the builder renumbered (${trigger}); nothing merged:\n${v.problems.slice(0, 10).map((x) => `- ${x}`).join("\n")}`, OUTCOME_CODES.BASE_CONFLICT) };
      await gatePassed("sequence");
      files = await changedFiles();
      await revalidateRenumbered(trigger);
      return { renumbered: true };
    }
    { const sq = await sequenceHandoff("hand-off"); if (sq?.done) return sq.done; }
    /** #4406: same-app duplicate exports (verify.duplicate_exports): one "rename or reuse" round, then an anomaly. True when a fix round ran. */
    let engineWhy = null; // the reason an amendment gets when the engine demanded the change (a blank builder why is not its fault)
    async function duplicateGate(trigger) {
      if (!io.duplicateExports || isSplit || vcfg.duplicateExports === false) return false;
      const found = async () => (await io.duplicateExports({ cwd: wt, base }).catch(() => null)) ?? [];
      let dups = await dupsResidual(); // #5348: the deterministic rename first
      const mech = dupMech > 0;
      if (dups.length && sessionId) {
        const text = dups.map((d) => `duplicate export \`${d.symbol}\`: ${d.path} and ${(d.others ?? []).join(", ")}`).join("\n");
        ev({ event: "DUPLICATE_EXPORTS", trigger, count: dups.length });
        T.decisions.push(`Duplicate export(s) (${trigger}): ${dups.slice(0, 5).map((d) => `${d.symbol} in ${d.path} vs ${(d.others ?? []).join(", ")}`).join("; ")}; builder resumed once`);
        engineWhy = `engine-demanded rename: duplicate export(s) ${dups.slice(0, 5).map((d) => d.symbol).join(", ")} (${trigger})`;
        await fixRound("duplicate", duplicateExportsPrompt(dups, vcfg.mode), [], "duplicate", text, { files: dups.flatMap((d) => [d.path, ...(d.others ?? [])]) });
        result = (await readResult()) ?? result;
        files = await changedFiles();
        dups = await found();
        if (dups.length) T.anomalies.push(`Duplicate export(s) remain (${trigger}): ${dups.slice(0, 5).map((d) => `${d.symbol} in ${d.path} vs ${(d.others ?? []).join(", ")}`).join("; ")}`);
        else await gatePassed("duplicate");
        return true;
      }
      if (dups.length) T.anomalies.push(`Duplicate export(s) (${trigger}): ${dups.slice(0, 5).map((d) => `${d.symbol} in ${d.path}`).join("; ")}`);
      else if (mech) await gatePassed("duplicate");
      return mech;
    }
    await duplicateGate("hand-off");
    /** #4591: lane-added migrations the repo's generator did not produce: one builder round (stage "sequence"), then an anomaly. */
    async function migrationGate(trigger) {
      if (!io.migrationGenerator || isSplit) return;
      const found = async () => (await io.migrationGenerator({ cwd: wt, base }).catch(() => null)) ?? [];
      let bad = await found();
      if (!bad.length) return;
      ev({ event: "MIGRATION_HAND_NAMED", trigger, count: bad.length });
      if (sessionId) {
        T.decisions.push(`Hand-named migration(s) (${trigger}): ${bad.slice(0, 5).join("; ")}; builder resumed once`);
        await fixRound("sequence", migrationGeneratorPrompt(bad, vcfg.mode), [], "sequence", bad.join("\n"));
        result = (await readResult()) ?? result;
        files = await changedFiles();
        bad = await found();
      }
      if (bad.length) T.anomalies.push(`Hand-named migration(s) remain (${trigger}): ${bad.slice(0, 5).join("; ")}`);
      else await gatePassed("sequence");
    }
    await migrationGate("hand-off");
    /** #4596: keys added to a non-en locale catalog as English copies: one translate round, then an anomaly. True when a fix round ran. */
    async function i18nGate(trigger) {
      if (!io.englishCopies || isSplit) return false;
      const found = async () => (await io.englishCopies({ cwd: wt, base }).catch(() => null)) ?? [];
      let cp = await found();
      const brief = () => cp.slice(0, 5).map((d) => `${d.path}:${d.key}`).join("; ");
      if (cp.length && sessionId) {
        ev({ event: "I18N_ENGLISH_COPIES", trigger, count: cp.length });
        T.decisions.push(`English copies in locale catalogs (${trigger}): ${brief()}; builder resumed once`);
        await fixRound("duplicate", i18nCopiesPrompt(cp, vcfg.mode), [], "duplicate", cp.map((d) => `english copy \`${d.key}\` in ${d.path}`).join("\n"));
        result = (await readResult()) ?? result;
        files = await changedFiles();
        const before = cp;
        cp = await found();
        if (cp.length) T.anomalies.push(`English copies remain in locale catalogs (${trigger}): ${brief()}`);
        else await gatePassed("i18n");
        return before.length > 0;
      }
      if (cp.length) T.anomalies.push(`English copies in locale catalogs (${trigger}): ${brief()}`);
      return false;
    }
    await i18nGate("hand-off");
    /** #4406: verify.post_merge (else the scoped typecheck) on the merged tree before the base-sync push; fix rounds up to verify.max_rounds. */
    async function postMergeGate(trigger) {
      const commands = io.runCommand && !isSplit ? [...new Set([...postMergeCommands({ configured: vcfg.postMerge, scoped: (await io.postMergeChecks?.({ cwd: wt, base }).catch(() => [])) ?? [], mode: vcfg.mode }), ...(guardOn() ? vcfg.invariants : [])])] : []; // #5239: the guard set also runs on the merged tree
      let fixed = false, results = [];
      for (let round = 0; commands.length; round++) {
        await renew();
        results = [];
        for (const command of commands) {
          let x; try { x = await heavyStep("precheck", async () => (await runWithTimeoutRetry((timeoutMs) => io.runCommand({ command, cwd: wt, timeoutMs, env: laneEnv() }), vcfg.precheckTimeoutSeconds * 1000)).r); } catch (e) { x = { rc: 127, output: String(e?.message ?? e) }; }
          results.push({ command, rc: Number(x?.rc ?? 1), output: String(x?.output ?? "") });
        }
        ev({ event: "POST_MERGE_CHECKS", trigger, round, results: results.map(({ command, rc }) => ({ command, rc })) });
        const failed = results.filter((r) => r.rc !== 0), names = failed.map((f) => `\`${f.command}\` (exit ${f.rc})`).join(", ");
        if (!failed.length) { if (round) await gatePassed("post_merge"); break; }
        if (round >= vcfg.maxRounds || !sessionId) { T.anomalies.push(`Post-merge check(s) still fail after merging ${base} (${trigger}): ${names}`); break; }
        T.decisions.push(`Post-merge check(s) failed after merging ${base} (${trigger}): ${names}; builder resumed before the push (round ${round + 1}/${vcfg.maxRounds})`);
        const before = String(await git(["rev-parse", "HEAD"])).trim();
        const capped = capLogs(failed.map((f) => ({ ...f, log: f.output }))).map((f) => ({ command: f.command, rc: f.rc, output: f.log }));
        await fixRound("post_merge", postMergeFailurePrompt(capped, vcfg.mode), [], "post_merge", capped.map((f) => `${f.command}\n${f.output ?? ""}`).join("\n"));
        result = (await readResult()) ?? result;
        fixed = true;
        if ((String(await git(["rev-parse", "HEAD"])).trim()) === before) { T.anomalies.push(`Post-merge check(s) failing and the builder made no new commit for them: ${names}`); break; }
      }
      return { fixed, stuck: results.filter((r) => r.rc !== 0 && guardFailing([r])), ran: results.map(({ command, rc }) => `${command}: ${rc === 0 ? "pass" : `fail (exit ${rc})`}`).join("; ") };
    }
    /** #5239: verify.invariants are the pre-merge guard set; blocking unless verify.guard_block is false. */
    function guardOn() { return vcfg.guardBlock !== false && (vcfg.invariants ?? []).length > 0; }
    function guardFailing(failed) { return guardOn() && failed.some((f) => vcfg.invariants.includes(f.command)); }
    /** #5239: guard commands failing here are run once on the base; failing there too, the lane is deferred (base.red) and the introducing issue is told. null: the failure is the lane's. */
    async function guardRed(failed) {
      const g = failed.filter((f) => guardFailing([f]));
      if (!g.length || isSplit || !io.runCommand) return null;
      const baseRuns = await heavyStep("precheck", () => runOnBase({ commands: g.map((f) => f.command), git, runCommand: io.runCommand, mergeBase: base, cwd: wt, env: laneEnv(), timeoutMs: vcfg.precheckTimeoutSeconds * 1000 }));
      const { baseRed } = classifyBaseRed({ failed: g, baseRuns });
      if (!baseRed.length) return null;
      const att = await attributeBaseRed({ failed: baseRed, git, base });
      const cmds = baseRed.map((f) => f.command), n = await reportBaseRed({ ghc: ghw, repo, base, att, laneIssue: issue, commands: cmds });
      T.decisions.push(`Guard command(s) ${cmds.map((c) => `\`${c}\``).join(", ")} also fail on ${base}${att ? ` (last change ${att.sha.slice(0, 12)}${att.issue ? `, #${att.issue}` : ""})` : ""}; lane deferred behind ${n ? `#${n}` : "the base fix"}`);
      ev({ event: "BASE_RED", commands: cmds, sha: att?.sha ?? null, issue: att?.issue ?? null, tracked: n });
      return await finish("deferred", `base ${base} is red on guard command(s) ${cmds.join(", ")}; deferred behind ${n ? `#${n}` : "the base fix"}`, { code: OUTCOME_CODES.BASE_RED, retryInSeconds: 900 }, OUTCOME_CODES.BASE_RED);
    }
    const structureLine = structureNote(structure);

    phaseLedger.enter("ci_wait");
    // ---- 3c. verify by CI (#4167): ci|hybrid push the branch and run the repo's CI on GitHub runners, before review ----
    // A red run resumes the builder with the failed jobs' logs (verify.max_rounds), slow CI ends ci-pending, and CI that
    // cannot run falls back once to local validation. A head verified here lets the precheck accept validate ids left to CI.
    let ciVerifiedHead = null, ciFellBack = false, ciRounds = 0;
    const ciSeenRuns = [];
    const ciReruns = new Map(); // #4586: head -> {rr} of the one rerun of its failed jobs, spent before any fix round
    let ciGateNames; // #4387: checks that gate CI verification, read once per lane
    /** Verifies the current head; returns {done} with a terminal result, or {fixes} (builder CI-fix rounds that moved the head). */
    async function ciVerify(trigger) {
      let fixes = 0;
      for (;;) {
        await untrackToolState({ git, base, ev, keep: await keepPaths() }); // #4621: gitPush's untrack commit would move HEAD after `head` was read; do it first so head is the pushed tip
        await reconcileLaneBranch(); // #5202: likewise the checkpoint reconcile merge
        await signOffUnpushed(); // #4651: likewise the sign-off rewrite
        const head = String(await git(["rev-parse", "HEAD"])).trim();
        if (head === ciVerifiedHead || ciFellBack) return { fixes };
        files = await changedFiles();
        if (ciGateNames === undefined) ciGateNames = vcfg.workflow ? null : await ciGate({ io, lane, mergeWait, verify: vcfg });
        const verifyArgs = { io, branch, head, changedFiles: files, verify: vcfg, ciMaxMinutes, now, sleep, random, exclude: ciSeenRuns, gate: ciGateNames,
          push: () => gitPush(["push", "-u", "origin", branch]),
          onPoll: async () => { await renew(); onProgress({ event: "phase_paused", phase: "verify", detail: `CI verification pending on ${branch}` }); } };
        let v = await runCiVerify(verifyArgs);
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
        // #4586: `verify.flaky` failures are reported, never block; the rest are rerun once before any round is counted.
        let sp = splitFlaky(v.failures, vcfg.flaky);
        const greenNow = (note) => { ciVerifiedHead = head; row(`CI green at ${head.slice(0, 12)}${note}`); return gatePassed("ci_red", "merge_ci"); };
        const reportFlaky = () => { if (!sp.flaky.length) return; const n = sp.flaky.map((f) => f.job); T.anomalies.push(`Known-flaky CI failure(s) reported, not blocking (verify.flaky): ${n.join(", ")}`); ev({ event: "CI_FLAKY_REPORTED", trigger, head, jobs: n }); };
        reportFlaky();
        if (!sp.own.length) { await greenNow(" (only verify.flaky failures)"); return { fixes }; }
        if (!isSplit && !ciReruns.has(head)) {
          const own = new Set(sp.own.map((f) => f.job)), vOwn = { ...v, failures: sp.own, failedChecks: v.failedChecks?.filter((c) => own.has(c.name)) };
          const rr = await rerunFailedOnce({ io, v: vOwn });
          ciReruns.set(head, { rr });
          const v2 = rr.ok ? await runCiVerify({ ...verifyArgs, rerunOf: rerunTarget(vOwn) }) : null;
          if (rr.detail !== "no rerun seam") ev({ event: "CI_FLAKE_RERUN", trigger, head, runs: rr.runs, jobs: rr.jobs, result: v2?.result ?? "rerun-failed", detail: v2?.detail ?? rr.detail });
          if (v2?.result === "pass") {
            await greenNow(" after a rerun of the failed jobs");
            T.decisions.push(`CI verification red (${sp.own.map((f) => f.job).join(", ")}); green after one rerun of the failed jobs (flake), no fix round spent`);
            return { fixes };
          }
          if (v2?.result === "timeout") return { done: await finish("ci-pending", `CI rerun of the failed jobs on ${branch} still pending after ${ciMaxMinutes} min; rerun resumes the branch`) };
          if (v2?.result === "fail") {
            v = v2; if (v.runId != null) ciSeenRuns.push(v.runId);
            sp = splitFlaky(v.failures, vcfg.flaky); reportFlaky();
            if (!sp.own.length) { await greenNow(" (only verify.flaky failures)"); return { fixes }; }
          }
        }
        const jobs = sp.own.map((f) => f.job).join(", ") || "unknown job";
        row(`CI red (${jobs})`);
        if (ciRounds >= vcfg.maxRounds || !sessionId) {
          return { done: await needsHuman(`CI verification failed on \`${branch}\` at \`${head.slice(0, 12)}\` after ${ciRounds} fix round(s); nothing merged:\n${sp.own.slice(0, 10).map((f) => `- ${f.job}${f.url ? ` (${f.url})` : ""}`).join("\n")}`, OUTCOME_CODES.CI_RED) };
        }
        ciRounds++; fixes++;
        T.decisions.push(`CI verification red (${jobs}); builder resumed with the failed logs (round ${ciRounds}/${vcfg.maxRounds})`);
        ev({ event: "CI_FIX_ROUND", trigger, round: ciRounds, jobs: sp.own.map((f) => f.job) });
        const ciBefore = io.docsFreshness ? await changedFiles() : [];
        const ciDocsStale = io.docsFreshness ? (await io.docsFreshness({ cwd: wt, base }).catch(() => null))?.ok === false : false;
        await fixRound("ci", ciFailurePrompt(sp.own, vcfg.mode), [], "ci_red", failureLog(sp.own));
        await upsertStage("implementation");
        result = (await readResult()) ?? result;
        await noteFreshnessDocs(ciBefore, ciDocsStale);
        if (String(await git(["rev-parse", "HEAD"])).trim() === head) {
          // #4387/#4586: no commit says the failure is not the change's; the failed jobs were already rerun once on this head (before the round).
          const rr = ciReruns.get(head)?.rr ?? { ok: false, detail: isSplit ? "refactor:split" : "no rerun seam" };
          const how = !rr.ok ? (rr.detail === "no rerun seam" ? "" : ` (rerun of the failed jobs not possible: ${rr.detail})`) : " and stayed red after one rerun of the failed jobs";
          return { done: await needsHuman(`CI verification failed on \`${branch}\` (${jobs}) and the builder made no new commit for it${how}; nothing merged.`, OUTCOME_CODES.CI_RED) };
        }
      }
    }

    phaseLedger.enter("precheck");
    // ---- 4. conformance: typed amendments, deterministic precheck, structured review; the engine computes the verdict ----
    // enforce: every failure class blocks (one builder resume, then needs-human). shadow: the verdict is computed and posted,
    // but only what the previous reviewer enforced blocks (a review that finds a requirement not implemented, or a regression),
    // plus the precheck's equivalent: a failed validate command or a requirement the builder reported as not done (#4160).
    // A review without usable rows ends needs-human (or, with engine.review_incomplete: degraded, merges flagged).
    await label("in-review");
    let shadow = conformance !== "enforce";
    // per-kind modes (engine.conformance_kinds) apply until a risk path forces the whole lane to enforce (#4398)
    const kindsNow = () => (riskEnforced ? null : kinds);
    const recording = () => shadow || (!riskEnforced && Object.keys(kinds).length > 0); // the gate records what it would have blocked
    const blockingOf = (fs, allow) => blockingFailures(fs, { shadow, kinds: kindsNow(), allow });
    let effective = frozen, review = null, lastAmend = "", resumes = 0, lastFailKey = null, verdict = null, degraded = null, triggerSkipped = false, selfReviewCompared = false;
    const TRIGGER_SKIP = "skipped (review.trigger enforce: no risk trigger)";
    const triggerSkipNote = "## Conformance Review\n**Skipped by `review.trigger: enforce`:** no risk path, package edge or hotspot in the diff, and every deterministic gate passed; no reviewer ran (#4273).";
    let pendingDecisions = [], firstRounds = null, firstReply = null;
    let baseTree = null; // #4695: the base file list, read once and only when a decision amendment needs it
    let genPaths = null; // forge#4519: maintenance.generated_paths from hotspots.sh (plan facts; one config-only call without them, never on light lanes)
    async function amend() {
      genPaths ??= (hotFacts ? hotFacts.generated_paths : light ? [] : (await hotspotsOf({ paths: [] }))?.generated_paths) ?? [];
      const wantsDecision = (Array.isArray(result?.amendments) ? result.amendments : []).some((x) => x?.kind === "decision");
      baseTree ??= wantsDecision ? String(await git(["ls-tree", "-r", "-z", "--name-only", base]).catch(() => "")).split("\0").filter(Boolean) : null;
      const addedPaths = wantsDecision ? String(await git(["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`]).catch(() => "")).split("\n").filter(Boolean) : [];
      const own = [...(Array.isArray(result?.amendments) ? result.amendments : []), ...impliedDocs];
      const ownKeys = new Set(own.map((x) => JSON.stringify(x)));
      const all = [...priorAmendments.filter((x) => !ownKeys.has(JSON.stringify(x))), ...own];
      const a = applyAmendments(frozen, all, issueText, { generatedPaths: genPaths, baseFiles: baseTree?.length ? baseTree : null, addedPaths, defaultWhy: engineWhy });
      const sig = JSON.stringify(a.applied);
      if (a.applied.length && sig !== lastAmend) {
        lastAmend = sig;
        try { await post("FORGE:AMENDMENT", renderAmendments(a.applied, {}, { contract: hash, amendments: all })); } // #5020: retried by ghw; a still-failing post is an anomaly, never an engine-error
        catch (e) { T.anomalies.push(`FORGE:AMENDMENT comment not posted: ${String(e?.message ?? e).slice(0, 160)}`); }
        T.decisions.push(`Contract amended: ${a.applied.map((x) => `${x.kind} ${x.target}`).join(", ")}`);
      }
      pendingDecisions = a.decisions; // #4737: persisted only once the PR merges
      effective = a.contract;
      return a.problems.map((d) => ({ code: OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED, detail: d }));
    }
    const IGNORE = [`${LEAN_DIR}/`];
    /** Up to two reviewer runs; a reply without usable rows (unparseable, incomplete, inconsistent) is re-asked, never charged to the builder. */
    function reviewOnce() { return phaseLedger.during("review", reviewOnceRaw); }
    /** The reviewer's inputs and full prompt for the current head: no lane state is touched, so it can run before precheck finishes (#5436). */
    async function reviewPrep() {
      const diff = String(await git(["diff", `${base}...HEAD`]));
      const stat = Buffer.byteLength(diff, "utf-8") > REVIEW_DIFF_MAX_BYTES ? String(await git(["diff", "--stat=200", `${base}...HEAD`]).catch(() => "")) : "";
      const listed = new Set(String(await git(["ls-files"]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean));
      // #5339: validate-command paths that fake the real path (mocks, fakes, stubs): they cannot verify an e2e/manual requirement
      const cmdPaths = [...new Set((effective.validate ?? []).flatMap((v) => String(v.command ?? "").split(/\s+/)).map((t) => t.replace(/^["']+|["']+$/g, "")).filter((t) => listed.has(t)))];
      const ctx = { contract: effective, changedFiles: files, issueText, pathExists: (x) => listed.has(x), repoFiles: listed, ignore: IGNORE, e2e: { faked: fakedPaths(cmdPaths, (x) => readFileSync(join(wt, x), "utf8")), checks: vcfg.e2e?.checks ?? [], sandboxes: Object.keys(vcfg.sandboxes ?? {}), isSpec: (x) => e2eSpecs([x], vcfg.e2e).length > 0 } };
      const prompt = reviewerPrompt({ reproFlag: reproQ, issue: iss, comments: trustedComments, contract: effective, result, files, diff, stat, base, structure: structureLine, ignore: IGNORE, domains, relaxations, investigationVerdict: investigationVerdict(await io.fs.read(`${wt}/.forge-lean/investigation.md`).catch(() => null)) });
      return { ctx, prompt };
    }
    const reviewerCall = (prompt) => callRunner({ role: "reviewer", issue, cwd: wt, model: reviewerModel, resume: null, system: REVIEWER_SYSTEM, readOnly: true, prompt });
    /** #5436: the first reviewer call, started beside guard+precheck by gate(); null when none is pending. */
    let specReview = null;
    async function reviewOnceRaw() {
      const spec = specReview; specReview = null;
      const { ctx, prompt } = await reviewPrep();
      let d = null, first = null;
      for (let t = 0; t < 3; t++) {
        // #4327/#5164: a third run only when the repaired reply is incomplete solely by reviewer slips (unresolved evidence paths, coverage misquotes).
        if (t === 2) {
          if (d.state !== "review.incomplete" || !reaskable(d.failures.map((f) => f.detail))) break;
          T.decisions.push(`Review incomplete only by row gaps, unresolved evidence paths or coverage misquotes (${(d.missing ?? []).join(", ")}); reviewer re-asked once more`);
        }
        // #4160: a reply with rows missing is re-asked for those ids only; an unparseable one gets the full prompt again.
        const repair = first && (d.state === "review.incomplete" || d.state === "review.inconsistent");
        await renew();
        let rr, got = false;
        if (t === 0 && spec) { try { rr = await spec.adopt(); got = true; T.decisions.push("Review started beside guard+precheck and adopted (#5436)"); } catch { got = false; } }
        if (!got) rr = await reviewerCall(repair ? reviewerRepairPrompt({ missing: d.missing ?? [], problems: d.failures.map((f) => f.detail), rows: first, criteria: (d.missing ?? []).includes("issue_coverage") ? criterionLines(issueText) : [] }) : prompt);
        await renew();
        await attempt("review", ++reviewN, rr, null, "review");
        const parsed = parseReview(rr?.text);
        review = repair ? mergeReviewRows(first, parsed) : parsed;
        first = review;
        d = decide(review, ctx);
        if (d.converted?.length) effective = convertDelivered(effective, d.converted); // #5365: a defer row the review found delivered is judged as deliver
        firstReply ??= d.state;
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
      const run = { mode: relaxations.length ? "enforce" : verifierCfg.mode, head, findings: [], model: null, swapped: false, cost_usd: 0 };
      if (!diff.trim()) run.skipped = "empty_diff";
      else {
        const bytes = Buffer.byteLength(diff, "utf-8");
        const stat = bytes > REVIEW_DIFF_MAX_BYTES ? String(await git(["diff", "--stat=200", `${base}...HEAD`]).catch(() => "")) : "";
        const listed = new Set(String(await git(["ls-files"]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean));
        const callers = await callersOf({ symbols: changedSymbols(diff), gitGrep: git, ignore: IGNORE });
        Object.assign(run, pickVerifierModel({ configured: verifierCfg.model, builderModel, builderReported: [...impl.models, ...(route?.tier === "mid" ? [route.model] : [])] }));
        const { maxMs, maxTurns } = verifierBudget(bytes);
        try {
          await renew();
          const rr = await callRunner({ role: "verifier", issue, cwd: wt, model: run.model, resume: null, system: VERIFIER_SYSTEM, readOnly: true, maxMs, maxTurns,
            prompt: verifierPrompt({ issue: iss, comments: trustedComments, contract: effective, diff, stat, base, files, callers, relaxations }) });
          await renew();
          await attempt("verify", ++verifyN, rr, null, "verifier");
          run.findings = parseVerifierFindings(rr?.text, { pathExists: (x) => listed.has(x) });
          run.cost_usd = num(rr?.costUsd) ?? 0;
        } catch (e) {
          if (e?.deferUsageLimit || e?.deferCode === OUTCOME_CODES.BACKEND_AUTH) throw e; // #5168: a login failure (backend.auth) is not swallowed as a verifier error
          run.error = String(e?.code || e?.message || e).split("\n")[0].slice(0, 200);
          T.anomalies.push(`Independent verifier failed at ${head.slice(0, 12)}: ${run.error}`);
        }
      }
      const failures = run.mode === "enforce" ? findingsToFailures(run.findings) : [];
      ev({ event: "VERIFIER", mode: run.mode, head, model: run.model, swapped: run.swapped, findings: run.findings.length, cost_usd: run.cost_usd, implement_cost_usd: impl.cost,
        ratio: impl.cost > 0 ? Math.round((run.cost_usd / impl.cost) * 1000) / 1000 : null, ...(run.skipped ? { skipped: run.skipped } : {}), ...(run.error ? { error: run.error } : {}) });
      if (run.findings.length) T.decisions.push(`Independent verifier (${run.mode}) found ${run.findings.length} defect(s): ${run.findings.slice(0, 3).map((f) => `${f.file}:${f.line}`).join(", ")}`);
      verifiedHeads.set(head, failures);
      verifierRun = run;
      return failures;
    }
    const verifierSection = () => { const n = renderVerifierNote(verifierRun); return n ? `\n\n${n}` : ""; };
    /** #4323: rerun once each validate command the builder recorded as failed, with the lane env; {[id]: {rc, output}} or null. */
    /** #5005: a frozen forgedock entry-point path missing on this host is replaced by this install's own. */
    const forgedockResolved = (c) => resolveForgedockPaths(String(c), { exists: existsSync, checksCli: CHECKS_CLI, forgedockCli: FORGEDOCK_CLI });
    async function rerunFailedValidatesRaw(contract) {
      if (!io.runCommand) return null;
      const runs = Array.isArray(result?.validation) ? result.validation : [], out = {};
      const env = laneEnv();
      for (const v of contract.validate ?? []) {
        const r = runs.find((x) => x?.id === v.id);
        if (!r || r.exit === undefined || r.exit === 0) continue;
        let x;
        try { x = await heavyStep("precheck", async () => (await runWithTimeoutRetry((timeoutMs) => io.runCommand({ command: forgedockResolved(v.command), cwd: wt, timeoutMs, env }), vcfg.precheckTimeoutSeconds * 1000)).r); } catch (e) { x = { rc: 127, output: String(e?.message ?? e) }; }
        // #4761: a runner usage error (vitest -q) is the frozen command's defect: try the normalised command once
        const fixed = cliUsageError(x ?? {}) ? normalizeRunnerCommand(v.command) : null;
        if (fixed && fixed !== String(v.command)) {
          try { x = await heavyStep("precheck", async () => (await runWithTimeoutRetry((timeoutMs) => io.runCommand({ command: forgedockResolved(fixed), cwd: wt, timeoutMs, env }), vcfg.precheckTimeoutSeconds * 1000)).r); } catch (e) { x = { rc: 127, output: String(e?.message ?? e) }; }
          const note = `Validate ${v.id} hit a runner usage error; reran normalised (\`${fixed}\`): exit ${x?.rc}`;
          if (!T.decisions.includes(note)) T.decisions.push(note);
        }
        // #5653: a stale generated artifact (base drift) is mechanical: base-sync (a clean merge of the lane tip), then the repo's configured regenerate command, then one rerun
        if (x && x.rc !== 0 && x.rc !== 124 && isDriftFailure(x.output)) {
          try {
            const rerunV = async () => await heavyStep("precheck", async () => (await runWithTimeoutRetry((timeoutMs) => io.runCommand({ command: forgedockResolved(v.command), cwd: wt, timeoutMs, env }), vcfg.precheckTimeoutSeconds * 1000)).r);
            let note = "";
            if (Number(String(await git(["rev-list", "--count", `HEAD..${base}`]).catch(() => "0")).trim()) > 0) {
              try { await git(["merge", "--no-edit", base]); note = `base-synced onto ${base}`; } catch { await git(["merge", "--abort"]).catch(() => {}); }
              if (note) { const again = await rerunV(); if (again?.rc === 0) { x = again; T.decisions.push(`Validate ${v.id} failed on a stale generated artifact; ${note} and the rerun passed (base drift, not a conformance failure)`); } }
            }
            if (validateRegenerate && x.rc !== 0) {
              const status = async () => String(await git(["status", "--porcelain"]).catch(() => "")).split("\n").filter(Boolean);
              const before = new Set(await status());
              await heavyStep("precheck", () => io.runCommand({ command: forgedockResolved(validateRegenerate), cwd: wt, timeoutMs: vcfg.precheckTimeoutSeconds * 1000, env }));
              const added = (await status()).filter((l) => !before.has(l)); // regeneration must leave nothing new to commit: the lane's diff stays its own
              if (!added.length) {
                const again = await rerunV();
                if (again?.rc === 0) { x = again; T.decisions.push(`Validate ${v.id} failed on a stale generated artifact; ${note ? `${note}, ` : ""}\`${validateRegenerate}\` then a rerun passed (base drift, not a conformance failure)`); }
              } else for (const l of added.filter((l) => /^ M /.test(l))) await git(["checkout", "--", l.slice(3)]).catch(() => {}); // undo only the files regeneration modified
            }
          } catch { /* fail-open: the original failure stands */ }
        }
        out[v.id] = { rc: Number.isInteger(x?.rc) ? x.rc : 1, output: String(x?.output ?? "") };
      }
      if (Object.keys(out).length) ev({ event: "VALIDATE_RERUN", runs: Object.entries(out).map(([id, x]) => ({ id, rc: x.rc })) });
      return out;
    }
    /** #4979 SPEC-2: rerun the frozen command of every substituted validate, so precheck accepts a substitute only for a command that cannot run. */
    async function rerunSubstitutedOriginals(contract) {
      const out = {};
      if (!io.runCommand) return out;
      const env = laneEnv();
      for (const v of contract.validate ?? []) {
        if (!v.substituted?.from) continue;
        let x;
        try { x = await heavyStep("precheck", async () => (await runWithTimeoutRetry((timeoutMs) => io.runCommand({ command: forgedockResolved(v.substituted.from), cwd: wt, timeoutMs, env }), vcfg.precheckTimeoutSeconds * 1000)).r); } catch (e) { x = { rc: 127, output: String(e?.message ?? e) }; }
        out[v.id] = { rc: Number.isInteger(x?.rc) ? x.rc : 1, output: String(x?.output ?? "") };
        // #5653: the substitute runs too, so conformance can judge "same test ids, same result" (equivalentRuns)
        if (out[v.id].rc !== 0 && out[v.id].rc !== 124) {
          let y; try { y = await heavyStep("precheck", async () => (await runWithTimeoutRetry((timeoutMs) => io.runCommand({ command: forgedockResolved(v.command), cwd: wt, timeoutMs, env }), vcfg.precheckTimeoutSeconds * 1000)).r); } catch { y = null; }
          if (y) out[v.id].sub = { rc: Number.isInteger(y.rc) ? y.rc : 1, output: String(y.output ?? "") };
        }
      }
      if (Object.keys(out).length) ev({ event: "SUBSTITUTE_RERUN", runs: Object.entries(out).map(([id, x]) => ({ id, rc: x.rc })) });
      return out;
    }
    /** #4693: select the guards this diff intersects and rerun their base test files; zero cost when none is selected. Best effort: an error skips the gate. */
    let guardSel = [], guardNoted = ""; let guardEv = null; // #4705: this pass's guard_run event, emitted by the caller once the added wall time is known
    async function guardGate(files) {
      let sel = [], r = null; guardEv = null;
      try {
        const guards = await (o.loadGuards ?? loadGuards)({ repo, gh: (a) => io.gh(a) });
        const picked = guards.length ? await selectGuards({ guards, files, git: (a) => git(a), base }) : { selected: [], mergeBase: null };
        sel = picked.selected; guardSel = sel;
        if (!sel.length) return [];
        r = await runGuards({ selected: sel, mergeBase: picked.mergeBase, contract: effective, guardCommand: vcfg.guardCommand, git: (a) => git(a), runCommand: (a) => io.runCommand(a), cwd: wt, env: laneEnv(), parallelism: Number(process.env.FORGE_HOST_PARALLELISM) || 2 });
      } catch (e) { T.anomalies.push(`Guard gate skipped: ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}`); guardEv = { event: "guard_run", selected: sel.map((x) => x.guard.issue), ran: 0, broken: 0, skipped: 0, wall_ms: 0, error: true }; return []; }
      const note = `Guard gate selected ${sel.map((x) => `#${x.guard.issue} (${x.reason})`).join("; ")}${r.skipped.length ? `; skipped: ${r.skipped.join("; ")}` : ""}${r.failures.length && shadow ? "; shadow: would block" : ""}`;
      if (note !== guardNoted) { guardNoted = note; T.decisions.push(note); }
      guardEv = { event: "guard_run", selected: sel.map((x) => x.guard.issue), reasons: Object.fromEntries(sel.map((x) => [x.guard.issue, x.reason])), batches: r.batches, ran: r.runs.length, broken: r.failures.length, skipped: r.skipped.length, wall_ms: r.ms };
      for (const f of r.failures) ev({ event: "guard_broken", guard: f.guard, test: f.test });
      return r.failures;
    }
    /** Precheck then review, on the current result and changed files (also the base-sync re-review). */
    /** #4769: default-off keys the diff adds to the forge.yaml `rollouts` registry; [] when none is declared. */
    async function newOffKeysOf() {
      const cfg = readRollouts(wt);
      return cfg ? detectNewOffKeys(cfg, String(await git(["diff", "-U0", `${base}...HEAD`, "--", ...cfg.files]).catch(() => ""))) : [];
    }
    /** #5285: interactive UI files changed, whether a real-browser (e2e) check is configured for them, and whether a declared risk path is hit. */
    function uiBrowserOf(fs) {
      const ui = uiInteractiveChanged(fs);
      if (!ui.length) return null;
      const want = e2eWanted({ cfg: vcfg.e2e, files: fs, contract: effective });
      if (!want.run) T.decisions.push(`Real-browser check skipped for interactive UI change (${ui.slice(0, 3).join(", ")}): ${want.reason} (#5285)`);
      return { files: ui, ran: want.run, reason: want.reason, highRisk: riskPathHits(ui, riskPaths).length > 0 };
    }
    let amendFixed = false;
    /** #5436: a review started beside guard+precheck is dropped on every return that does not reach the reviewer. */
    async function gate() {
      try { return await gateRun(); } finally { specReview?.discard(); specReview = null; }
    }
    async function gateRun() {
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
      // #5099: the domains the diff touches get domain checks in the review; a review.enforce_domains hit enforces (sticky)
      const pd = pathDomains(files, { docs: docsConfig, pages: pagesConfig });
      const dErr = "Review domains unavailable: scripts/review-roster.sh failed; reviewed without domain checks";
      if (pd === null && !T.anomalies.includes(dErr)) T.anomalies.push(dErr);
      domains = pd ?? [];
      const dHits = shadow ? domains.filter((d) => enforceDomains.includes(d)) : [];
      if (dHits.length) {
        shadow = false; riskEnforced = dHits.map((d) => `domain:${d}`);
        T.decisions.push(`Conformance enforced (review.enforce_domains): ${dHits.join(", ")}`);
      }
      if (domainsLogged !== domains.join(",")) {
        domainsLogged = domains.join(",");
        ev({ event: "REVIEW_DOMAINS", domains, enforced: dHits.length ? dHits : undefined, ...(pd === null ? { error: "roster.failed" } : {}) });
      }
      if (!amendFixed && sessionId && amendmentKindProblems(result?.amendments).length) { // #5089: one in-lane correction, outside the conformance resume budget
        amendFixed = true;
        const bad = amendmentKindProblems(result.amendments);
        T.decisions.push(`Amendment kinds invalid (${bad.length}); builder asked to correct ${RESULT_FILE} once`);
        await builder(++attemptN, amendmentCorrectionPrompt(bad), sessionId, false, undefined, { mode: "resume", trigger: "contract_correction" });
        result = (await readResult()) ?? result;
        files = await changedFiles();
      }
      const amendProblems = await amend();
      const gateHead = String(await git(["rev-parse", "HEAD"])).trim();
      const ciVerified = remoteVerify && ciVerifiedHead !== null && ciVerifiedHead === gateHead;
      const hotspots = await hotspotsOf({ base, paths: files }); // #4502
      const rx = await relaxationsOf(files); // #5237
      relaxations = rx.relaxations;
      if (relaxations.length) {
        ev({ event: "RELAXATION_DETECTED", files: [...new Set(relaxations.map((r) => r.file))], count: relaxations.length, negatives: rx.negatives });
        const note = `Relaxation in a declared risk path (${[...new Set(relaxations.map((r) => r.file))].slice(0, 5).join(", ")}): negative tests added ${rx.negatives}; independent verifier enforced`;
        if (!T.decisions.includes(note)) T.decisions.push(note);
      }
      // #5436: the review reads the same committed diff as guard+precheck, so its session starts now; reviewOnce adopts it, any earlier return discards it
      const repro = await reproOf(effective);
      // a precheck that already fails on facts at hand (no engine rerun) would discard the review, so it is not started then
      const early = triggerMode === "enforce" || amendProblems.length ? null : precheck({ contract: effective, result, changedFiles: files, ignore: IGNORE, ciVerified, hotspots, frozen, repro, repoHas: repoTracks(String(await git(["ls-files"]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean)) });
      specReview = !early || early.failures.length ? null : startSpeculative(async () => reviewerCall((await reviewPrep()).prompt));
      const gateT0 = now(); let validateMs = 0;
      // #4693: guards run beside the validate rerun; SPEC-11: the substituted-original rerun shares the one validate phase
      const validatePhase = phaseLedger.during("validate", async () => ({ runs: await rerunFailedValidatesRaw(effective), subs: await rerunSubstitutedOriginals(effective) })).finally(() => { validateMs = now() - gateT0; });
      const [{ runs: validateRuns, subs: substitutedRuns }, guardFailures] = await Promise.all([validatePhase, guardGate(files)]);
      // #5087: forge.yaml topology.route_reachability gates the route handlers this diff adds; unset = no check
      const routeFailures = routeReachability && io.runCommand ? await routeReachabilityFailures({ command: routeReachability, paths: routePathsFromFiles(String(await git(["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean)), run: async ({ command }) => (await io.runCommand({ command, cwd: wt, timeoutMs: vcfg.precheckTimeoutSeconds * 1000, env: laneEnv() }).then((x) => x?.r ?? x)) ?? { rc: 127 } }) : [];
      // #5419: forge.yaml docs: user-facing surfaces need docs, and added /docs links must resolve; unset = no check
      const docsFail = docsConfig ? await docsFailures({ cfg: docsConfig, files, result, diff: String(await git(["diff", "-U0", `${base}...HEAD`]).catch(() => "")), tracked: String(await git(["ls-files"]).catch(() => "")).split("\n").filter(Boolean), run: io.runCommand ? async ({ command }) => (await io.runCommand({ command, cwd: wt, timeoutMs: vcfg.precheckTimeoutSeconds * 1000, env: laneEnv() }).then((x) => x?.r ?? x)) ?? { rc: 127 } : null }) : [];
      // #5428: forge.yaml pages: a public page needs design, SEO and GEO briefs and passes the deterministic page checks; unset = no check
      const addedNow = String(await git(["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean); // #5648: new vs modified pages
      const pageFail = pagesConfig ? await pageFailures({ cfg: pagesConfig, files, result, added: addedNow, diff: String(await git(["diff", "-U0", `${base}...HEAD`]).catch(() => "")), tracked: String(await git(["ls-files"]).catch(() => "")).split("\n").filter(Boolean), readFile: (p) => { try { return readFileSync(join(wt, p), "utf8"); } catch { return ""; } }, designApproved: designLabelApproved(iss?.labels) || designSpecApproved((iss?.comments ?? []).filter(isTrustedIssueComment)), run: io.runCommand ? async ({ command }) => (await io.runCommand({ command, cwd: wt, timeoutMs: vcfg.precheckTimeoutSeconds * 1000, env: laneEnv() }).then((x) => x?.r ?? x)) ?? { rc: 127 } : null }) : [];
      // #5330: forge.yaml design.routes (opt-in, blocking only): a user-visible page needs an approved spec and passes the deterministic visual critique
      const designFail = designFailures({ cfg: designConfig, files, added: addedNow, diff: String(await git(["diff", "-U0", `${base}...HEAD`]).catch(() => "")), specs: designSpecOk({ comments: (iss?.comments ?? []).filter(isTrustedIssueComment), labels: iss?.labels, cfg: designConfig }), readFile: (p) => { try { return readFileSync(join(wt, p), "utf8"); } catch { return ""; } } });
      // #5284: forge.yaml topology.prod_parity: declared production-only surfaces this diff touches need a check result or a justification
      const parityRules = parseProdParity(prodParity);
      const prodParityFailures = parityRules.length && io.runCommand ? await prodParityOf({ rules: parityRules, changedFiles: files, result, run: async ({ command }) => (await io.runCommand({ command, cwd: wt, timeoutMs: vcfg.precheckTimeoutSeconds * 1000, env: laneEnv() }).then((x) => x?.r ?? x)) ?? { rc: 127 } }) : [];
      // #5338: a declared interface whose provider and consumer no longer agree (route, signature, payload) is flagged at lane review
      const seamRecs = [...readDecisionIndex(repo), ...pendingDecisions].filter((r) => r.seam);
      const ls = seamRecs.length ? String(await git(["ls-files"]).catch(() => "")).split("\n").filter(Boolean) : [];
      const seamFail = seamRecs.length ? seamFailures({ records: seamRecs, changedFiles: files, read: (p) => { try { return readFileSync(join(wt, p), "utf8"); } catch { return ""; } }, list: () => ls, superseded: pendingDecisions.map((d) => d.supersedes).filter(Boolean) }) : [];
      // #4705: only the part not hidden behind the validate rerun; 0 when the gate errored or skipped
      const guardRunMs = guardEv && !guardEv.error ? Math.max(0, now() - gateT0 - validateMs) : 0;
      guardAddedMs += guardRunMs;
      if (guardEv) ev({ ...guardEv, added_wall_ms: guardRunMs });
      const repoHas = (validateRuns && Object.keys(validateRuns).length) || Object.keys(substitutedRuns ?? {}).length ? repoTracks(String(await git(["ls-files"]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean)) : undefined;
      // #4626: post-deploy check ids resolve against the lane base's checks file or this PR's
      const checkIds = effective.requirements?.some((r) => r.disposition === "post-deploy") ? new Set(Object.keys(await checksAt(git, [base, "HEAD"], wt))) : null;
      const removedPaths = (effective.validate ?? []).some((v) => v.substituted) ? await removedPathsOf(git, base) : []; // #4990
      const subBaseFiles = (effective.validate ?? []).some((v) => v.substituted) ? String(await git(["ls-tree", "-r", "-z", "--name-only", base]).catch(() => "")).split("\0").filter(Boolean) : []; // #5003
      const baselineRuns = [];
      for (const b of matchBaselines(files, vcfg.baselines)) { // #5448: project baseline suites for the changed paths, enforced
        let x;
        try { x = await heavyStep("precheck", async () => (await runWithTimeoutRetry((timeoutMs) => io.runCommand({ command: b.run, cwd: wt, timeoutMs, env: laneEnv() }), vcfg.precheckTimeoutSeconds * 1000)).r); } catch (e) { x = { rc: 127, output: String(e?.message ?? e) }; }
        baselineRuns.push({ ...b, rc: Number.isInteger(x?.rc) ? x.rc : 1, output: String(x?.output ?? "") });
      }
      if (baselineRuns.length) ev({ event: "BASELINES_RUN", runs: baselineRuns.map((b) => ({ run: b.run, rc: b.rc })) });
      const pc = precheck({ baselineFailures: baselineFailures(baselineRuns), contract: effective, result, changedFiles: files, ignore: IGNORE, ciVerified, hotspots, repro: (adequacyIn.repro = repro), validateRuns, repoHas, frozen, checkIds, guardFailures, coupledFailures: await coupledOf(files), relaxationFailures: relaxationFailures(rx), routeFailures, docsFailures: docsFail, pageFailures: [...pageFail, ...designFail], seamFailures: seamFail, docsPaths: docsConfig ? [...(docsConfig.paths ?? []), ...(docsConfig.registries ?? [])] : null, prodParityFailures, newOffKeys: await newOffKeysOf(), uiBrowser: uiBrowserOf(files), substitutedRuns, removedPaths, baseFiles: subBaseFiles });
      // #5447: an install failure for a package the changed files import blocks (env.tool_missing); unrelated ones are logged
      const depFail = depInstallFailures({ results: depResults, changedFiles: files });
      for (const l of depFail.logged) if (!T.decisions.includes(l)) T.decisions.push(l);
      pc.failures.push(...depFail.block);
      // #5447: a test that could not run gets one provisioning pass (dependencies, pytest) and a fresh gate before the lane is given up
      const unrun = pc.failures.filter((f) => ["validate_env", "repro_env", "dep_install"].includes(f.kind));
      const wantsPytest = unrun.some((f) => /pytest/.test(`${f.tool ?? ""} ${f.detail}`));
      if (unrun.length && !gateProvisioned && (io.deps?.prepare || (wantsPytest && io.runCommand))) {
        gateProvisioned = true;
        try {
          if (io.deps?.prepare) { const rp = await io.deps.prepare({ wt, repoKey: repoKey(cwd), env: toolchain?.env ?? undefined }); depResults = Array.isArray(rp) ? rp : []; }
          if (wantsPytest && io.runCommand) await io.runCommand({ command: "python3 -m pip install --user --quiet pytest", cwd: wt, timeoutMs: 180000, env: laneEnv() });
        } catch { /* the rerun below reports what is still missing */ }
        ev({ event: "GATE_PROVISIONED", kinds: [...new Set(unrun.map((f) => f.kind))] });
        return await gate();
      }
      T.tests = testRunSummary({ contract: effective, failures: pc.failures, repro: repro });
      // #4350: a scope-check validate stale only by amended deliverables is judged by the engine's scope gate instead
      if (pc.superseded?.length) {
        ev({ event: "VALIDATE_SUPERSEDED", runs: pc.superseded });
        const note = `Scope-check validate ${pc.superseded.map((x) => x.id).join(", ")} superseded by the scope gate (amended: ${[...new Set(pc.superseded.flatMap((x) => x.files))].join(", ")})`;
        if (!T.decisions.includes(note)) T.decisions.push(note);
      }
      // #4527: name the validate ids CI verified instead of a local run
      if (pc.ciCovered?.length) {
        ev({ event: "VALIDATE_CI_VERIFIED", ids: pc.ciCovered, head: gateHead });
        const note = `Validate ${pc.ciCovered.join(", ")} verified by CI at ${gateHead.slice(0, 12)} (no local result)`;
        if (!T.decisions.includes(note)) T.decisions.push(note);
      }
      // report-only: a deliver requirement whose test never ran green is named, not judged on prose
      const unverified = unverifiedRequirements(effective, { runs: result?.validation, reruns: validateRuns, ciCovered: pc.ciCovered });
      if (unverified.length) {
        ev({ event: "REQUIREMENT_UNVERIFIED", ids: unverified.map((u) => u.id) });
        const note = `Unverified (no executed evidence test): ${unverified.map((u) => u.id).join(", ")}`;
        if (!T.decisions.includes(note)) T.decisions.push(note);
      }
      let mutBlock = [];
      if (conformanceMutation === "report" && io.runCommand) { // #4913: report-only unless conformance_kinds enforces the kind
        const m = await phaseLedger.during("validate", () => runMutationCheck({ targets: mutationTargets(effective, { runs: result?.validation, reruns: validateRuns, ciCovered: pc.ciCovered }), files, base, git: (a) => git(a), runCommand: (a) => io.runCommand(a), cwd: wt, env: laneEnv(), tmp: runTmp ?? undefined }));
        adequacyIn.mutation = m.results;
        const mf = mutationFailures(m.results);
        if (m.results.length || m.skipped) ev({ event: "REQUIREMENT_MUTATION_SURVIVED", ids: mf.map((f) => f.detail.split(" ")[0]), checked: m.results.length, skipped: m.skipped || undefined });
        if (mf.length) {
          mutBlock = blockingFailures(mf, { shadow: true, kinds: { [MUTATION_SURVIVED]: "shadow", ...kinds } }).block;
          const note = `Mutation check: evidence test still passes with the change reverted for ${mf.map((f) => f.detail.split(" ")[0]).join(", ")}${mutBlock.length ? "" : " (shadow: not blocking)"}`;
          if (!T.decisions.includes(note)) T.decisions.push(note);
        }
      }
      // #5449: test adequacy per requirement; missing blocks a bug lane, weak gets one builder resume
      const adqEv = { runs: result?.validation, reruns: validateRuns, ciCovered: pc.ciCovered };
      // enforced on a bug lane with lean.repro_test on, unless the plan declared the bug untestable (repro_test "none" with a reason)
      Object.assign(adequacyIn, adqEv, { bug: reproOn() && effective.repro_test !== "none" });
      adequacy = testAdequacyRows(effective, { ...adqEv, mutation: adequacyIn.mutation, repro: adequacyIn.repro });
      adequacyTel = testAdequacyTelemetry(effective, adequacy, { repro: adequacyIn.repro, mutation: adequacyIn.mutation, regression: regressionRan(effective, adequacyIn) });
      // an environment or repro-verdict failure is settled first (already-fixed, env.repro_unrunnable): adequacy never mixes into it
      const adqFail = pc.failures.some((f) => ENV_CODES.includes(f.code) || String(f.kind ?? "").startsWith("repro")) ? [] : testAdequacyFailures(adequacy, { bug: adequacyIn.bug, firstRound: resumes === 0 });
      Object.assign(verifyFacts, { precheck: pc.failures, amendments: amendProblems, hotspots: Boolean(hotspots && hotspots.enabled !== false && Array.isArray(hotspots.files)) });
      // #4323/#4334: a missing host tool or module, or a repro test the harness could not run, is an environment error:
      // never a conformance failure, never a builder resume
      const envFails = pc.failures.filter((f) => ENV_CODES.includes(f.code));
      const pre = [...pc.failures.filter((f) => !ENV_CODES.includes(f.code)), ...amendProblems, ...mutBlock, ...adqFail];
      if (pre.length) ev({ event: "PRECHECK", failures: pre.map((f) => f.code) });
      // #5080: the repro already passes on the base and the diff changes no source: the fix is on the base, not missing
      if (alreadyFixedOnBase(pre, files, IGNORE)) return { state: "already-fixed", by: "precheck", failures: pre };
      if (pre.length && !recording()) return { state: "nonconforming", by: "precheck", failures: pre };
      // shadow: the builder's own failed checks block before any reviewer tokens are spent (#4160)
      const hard = recording() ? blockingOf(pre, SHADOW_PRE_BLOCKS).block : [];
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
          return { state: "conforms", by: "trigger", failures: [], ...(recording() ? { would: "conforms", wouldFail: [], reviewState: null } : {}) };
        }
        triggerSkipped = false;
      }
      let d = await reviewOnce();
      { // #5468: a lone e2e_unverified on production-only rows converts to post-deploy checks and the lane continues instead of parking
        const ids = d.state === "nonconforming" ? loneE2eRows(d.failures) : null;
        const cv = ids ? autoPostDeployE2e(effective, ids) : null;
        if (cv && cv.converted.length === ids.length) {
          for (const x of cv.converted) if (x.check) genChecks[x.check] = x.entry;
          effective = deferChecklessPostDeploy(cv.contract).contract; // #5524: checkless rows route to the orchestrator
          await persistGenChecks();
          T.decisions.push(`FORGE:DECISION e2e_unverified on ${ids.join(", ")} converted to post-deploy ${cv.converted.map((x) => x.check ?? "checkless").join(", ")}: the observable is production-only`);
          d = { state: "conforms", failures: [], review: d.review ?? review, by: "review" };
        }
      }
      if (d.state === "conforms" || d.state === "nonconforming") { // #5449: the reviewer's test_adequacy judgment joins the engine's rows
        adequacy = testAdequacyRows(effective, { ...adequacyIn, mutation: adequacyIn.mutation, review });
        adequacyTel = testAdequacyTelemetry(effective, adequacy, { repro: adequacyIn.repro, mutation: adequacyIn.mutation, regression: regressionRan(effective, adequacyIn) });
        const seen = new Set(pre.map((f) => f.detail));
        const more = testAdequacyFailures(adequacy, { bug: adequacyIn.bug, firstRound: resumes === 0 }).filter((f) => !seen.has(f.detail));
        if (more.length) d = { state: "nonconforming", failures: [...(d.state === "nonconforming" ? d.failures : []), ...more], by: "review", review };
      }
      // #4397: the verifier runs only on a change every gate and the reviewer passed; in enforce its findings block
      if ((verifierCfg.mode !== "off" || relaxations.length) && d.state === "conforms" && !pre.length) { // #5237: a relaxation lane always gets the independent second look
        const vf = await runVerifier();
        if (vf.length) d = { state: "nonconforming", failures: vf, by: "verifier" };
      }
      if (!recording()) return { ...d, by: d.by ?? "review" };
      // shadow: record what enforce would have done; block only on what the previous reviewer blocked on
      const would = d.state === "conforms" && !pre.length ? "conforms" : d.state.startsWith("review.") ? d.state : "nonconforming";
      const wouldFail = [...pre, ...(d.state === "conforms" ? [] : d.failures)];
      if (d.state.startsWith("review.")) return { ...d, by: "review", would, wouldFail, reviewState: d.state };
      const blocking = d.state === "nonconforming" ? blockingOf(d.failures, SHADOW_BLOCKS).block : [];
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
        return await needsHuman(`Environment error (not a conformance failure): the repro harness could not run the repro test on head; no builder resume was spent and nothing merged:\n${failures.map((f) => `- ${f.code}: ${f.detail}`).join("\n")}\n\nEnvironment defect: run the repro command above on the host with the project's real dependencies (its lockfile or toolchain), then rerun.`, OUTCOME_CODES.ENV_REPRO_UNRUNNABLE);
      }
      if (failures.every((f) => f.code === ENV_VALIDATE_TIMEOUT)) { // #4906: the teardown below pushes the lane's commits, so CI and recovery still see them
        T.anomalies.push("Environment error: a validate command timed out on the engine's rerun (infra, exit 124)");
        return await needsHuman(`Environment error (not a conformance failure): a validate command timed out (exit 124) even after one longer retry, which is host load rather than a failed check; no builder resume was spent, the branch is pushed and nothing merged:\n${failures.map((f) => `- ${f.code}: ${f.detail}`).join("\n")}\n\nRecovery reruns the command narrowed to the changed files; CI decides the head.`, ENV_VALIDATE_TIMEOUT);
      }
      if (failures.every((f) => f.code === OUTCOME_CODES.CONTRACT_INVALID_COMMAND)) {
        T.anomalies.push("Contract defect: a frozen validate command is a runner CLI usage error");
        return await needsHuman(`Contract defect (not a conformance failure): a frozen validate command is rejected by its runner's CLI, so no builder resume was spent and nothing merged:\n${failures.map((f) => `- ${f.code}: ${f.detail}`).join("\n")}\n\nRecovery re-plans the command (vitest: --reporter=dot, not -q).`, OUTCOME_CODES.CONTRACT_INVALID_COMMAND);
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
        (firstRounds ??= []).push({ state: outcome.state, failures: (outcome.failures ?? []).map((f) => f?.code) });
        firstReview = firstReviewRecord({ rounds: firstRounds, firstReply, labels: iss?.labels, files });
        for (const f of [...(outcome.failures ?? []), ...(outcome.wouldFail ?? [])]) if (f?.code) failureClasses.add(f.code);
        if (outcome.state === "conforms") { await gatePassed("conformance"); break; }
        const explained = explainFailures(outcome.failures, effective); // #4265: name the unmet requirement, not only the code
        const list = explained.slice(0, 15).map((f) => `- ${f.code}: ${f.detail}`).join("\n");
        if (outcome.state === "environment") return await envNeedsHuman(outcome.failures);
        // #5371: a remote sandbox is a different environment from the host: its failed frozen validate is rerun once in a local recovery lane before it counts
        if (o.placement?.where === "remote" && !recover && outcome.failures?.length && outcome.failures.every((f) => f?.kind === "validate_failed")) {
          T.anomalies.push("Remote validate failure: rerun on the host in a local recovery lane before it is terminal");
          return await needsHuman(`A frozen validate command failed in the remote sandbox (exit non-zero on the engine's rerun). The sandbox is a different environment from the host, so no builder resume was spent; the branch is pushed and a local recovery lane reruns the frozen command on the host (pass: the change stands; fail: conformance.unimplemented):\n${list}`, ENV_VALIDATE_PLACEMENT);
        }
        if (outcome.state === "already-fixed") { // #5080: close as delivered, citing the base commit
          const sha = String(await git(["rev-parse", base]).catch(() => "")).trim().slice(0, 12) || base;
          const note = `Already fixed on the base: the repro test passes on \`${base}\` (${sha}) without this change, and the diff changes no source file. Closing as delivered.\n\n${list}`;
          T.decisions.push(`Already fixed on base ${sha} (repro BASE=RAN HEAD=RAN)`);
          if (!(await closeBlockers("completed", resumed?.pr ?? null)).length) await ghw(["issue", "close", String(issue), "-R", repo, "--reason", "completed", "--comment", note]);
          return await finish("invalid", `already fixed on base ${sha}`, { close: "already-fixed" });
        }
        if (outcome.state === "review.unparseable") return await needsHuman(`The conformance reviewer returned no parseable JSON twice; nothing merged.`, OUTCOME_CODES.REVIEW_NO_VERDICT);
        if (shadow && reviewIncomplete === "degraded" && (outcome.state === "review.incomplete" || outcome.state === "review.inconsistent")) {
          degraded = { state: outcome.state, missing: outcome.missing ?? [] };
          T.decisions.push(`Review degraded (${outcome.state} after the targeted re-ask${degraded.missing.length ? `: ${degraded.missing.join(", ")}` : ""}); merging with label ${REVIEW_DEGRADED_LABEL} and a tracked follow-up`);
          break;
        }
        if (outcome.state === "review.incomplete") return await needsHuman(`The conformance review was incomplete twice (a review without complete rows cannot pass); nothing merged:\n${list}`, OUTCOME_CODES.REVIEW_INCOMPLETE);
        if (outcome.state === "review.inconsistent") return await needsHuman(`The conformance reviewer twice said NONCONFORMING without a failing row; nothing merged.`, OUTCOME_CODES.REVIEW_INCONSISTENT);
        let failKey = JSON.stringify((outcome.failures ?? []).map((f) => `${f.code}|${f.detail}`).sort()); // #5644: a round that leaves the failure set unchanged ends the rounds
        if (!sessionId || resumes >= (builderFixable(outcome.failures) ? reviewMaxResumes : 1) || failKey === lastFailKey) return await needsHuman(`The change does not conform to the issue and its frozen contract after ${resumes ? (resumes === 1 ? "one builder resume" : `${resumes} builder resumes`) : "the build (no session to resume)"} (${outcome.by}); nothing merged:\n${list}`, outcome.failures?.[0]?.code);
        lastFailKey = failKey;
        resumes++;
        T.decisions.push(`Not conforming (${outcome.by}${outcome.inconsistent ? ", reviewer verdict contradicted its rows" : ""}): ${[...new Set(outcome.failures.map((f) => f.code))].join(", ")} (${explained.slice(0, 5).map((f) => String(f.detail).slice(0, 160)).join("; ")}); builder resumed (round ${resumes} of ${reviewMaxResumes})`);
        // A failed validate may only mean the base moved on: fetch the lane so the resume can merge it (never rebase).
        if (outcome.failures.some((f) => f?.kind === "validate_failed")) { try { await io.git(["fetch", "origin", lane], { cwd: wt }); } catch { /* offline: the resume uses the local ref */ } }
        await fixRound("conformance", conformanceResumePrompt(outcome.failures, vcfg.mode, lane), outcome.failures, "conformance", failureLog(outcome.failures));
        await upsertStage("implementation"); // the published note follows the code after every resume
      }
      // Deferrals the reviewer accepted are filed now, before any PR: the batched follow-up must exist and be linked.
      const toFile = pendingTracking(effective);
      if (toFile.length) await track(toFile, "accepted by the conformance review");
      degradedReq = degraded ? { id: "REVIEW", quote: `conformance review ${degraded.state}: re-run the review`, disposition: "defer", class: "ops", why: `${REVIEW_DEGRADED_LABEL}: rows still missing for ${degraded.missing.join(", ") || "the verdict"}` } : null;
      if (degradedReq) await track([degradedReq], "the conformance review stayed incomplete");
      if (triggerSkipped) {
        T.decisions.push("Conformance reviewer skipped by review.trigger enforce: no trigger reason (risk path, package edge, hotspot, failed or ambiguous gate)");
        if (recording()) {
          shadowWould = verdict.would;
          ev({ event: "CONFORMANCE_SHADOW", would: verdict.would, failures: [] });
          await emit({ event: "CONFORMANCE_SHADOW", would: verdict.would, failures: [] });
        }
        T.review = [TRIGGER_SKIP, `${reviewN} reviewer run(s), ${resumes + 1} round(s)`];
        await post("FORGE:REVIEW", triggerSkipNote);
      } else if (recording()) {
        const wf = verdict.wouldFail ?? [];
        shadowWould = verdict.would;
        ev({ event: "CONFORMANCE_SHADOW", would: verdict.would, failures: wf.map((f) => f.code) });
        await emit({ event: "CONFORMANCE_SHADOW", would: verdict.would, failures: wf.map((f) => f.code) });
        T.review = [`shadow: would ${verdict.would === "conforms" ? "pass" : `block (${verdict.would})`}`, `${reviewN} reviewer run(s), ${resumes + 1} round(s)`];
        await post("FORGE:REVIEW", renderShadowReview({ adequacy, would: verdict.would, failures: wf, review: verdict.reviewState === "conforms" || verdict.reviewState === "nonconforming" ? review : null, contract: effective, degraded: degradedReq?.tracked ?? (degraded ? "untracked" : null) }) + verifierSection());
      } else {
        T.review = ["CONFORMS", `${reviewN} reviewer run(s), ${resumes + 1} round(s)`];
        await post("FORGE:REVIEW", renderReview(review, effective, adequacy) + verifierSection());
      }
    }
    ev({ event: "PHASE_COMMIT", phase: "review" });
    // #5240: a delivered change behind a rollout that is not live (shadow/off) is inert in production: say so, never claim the outcome
    const rcfg = readRollouts(wt);
    const modes = rcfg ? rolloutModes(rcfg, files, (f) => readFileSync(join(wt, f), "utf8")) : [];
    const inert = modes.filter((m) => !m.live);
    const liveBlocks = liveDeferralBlocks(effective, modes); // #5285
    const closing = closePlan(effective, { title: iss.title, review, issueText, liveBlocks });
    if (closing.liveBlocked) T.decisions.push(`Default-on rollout with live acceptance deferred (${liveBlocks.map((b) => `${b.id} on ${b.flag}`).join(", ")}): issue left open as partial (#5285)`);
    if (inert.length) T.decisions.push(`Inert in production: the change touches rollout ${inert.map((m) => `${m.flag} (mode ${m.mode})`).join(", ")}; the issue's production outcome is not claimed (#5240)`);
    const xfer = closing.transfer ?? closing.open; // #5382: a liveBlocked plan carries its transferred rows apart from the live-blocked ones
    if (closing.transferred) { // #5339: unrun e2e/manual requirements go to the epic's acceptance; the issue records them transferred, not met
      let epicNo = null;
      try { epicNo = await transferToEpic({ io: { gh: ghc }, repo, milestoneTitle: milestone, issue, reqs: xfer }); } catch (e) { T.anomalies.push(`transfer to the epic failed: ${String(e?.message ?? e).slice(0, 120)}`); }
      for (const r of xfer) r.transferred = epicNo ?? false;
      T.decisions.push(epicNo ? `Requirements ${xfer.map((r) => r.id).join(", ")} transferred to epic #${epicNo} (post-deploy journey): not met, issue left open as partial (#5339)` : `Requirements ${xfer.map((r) => r.id).join(", ")} need a real run and no epic exists to take them: issue left open as partial (#5339)`);
    }
    verifiedLane = !closing.transferred && !closing.liveBlocked && !closing.checklist;
    if (closing.checklist) T.decisions.push(`Unticked acceptance criteria unmet (${closing.open.map((r) => r.id).join(", ")}): issue left open as partial (#5240)`);
    if (closing.reason === "partial" && !closing.checklist && !closing.transferred) { // #4398: an investigation whose question is not answered carries it forward
      const untracked = closing.open.filter((r) => !r.tracked);
      if (untracked.length) {
        const carried = untracked.map((r) => ({ ...r, disposition: "defer", class: "ops", why: "investigation question not answered" })); // #5207: the batch aggregate
        await track(carried, "the investigation's question is not answered");
        for (const [i, r] of untracked.entries()) r.tracked = carried[i].tracked;
      }
      for (const t of closing.open.map((r) => r.tracked).filter(Boolean)) if (!closing.tracked.includes(t)) closing.tracked.push(t);
      T.decisions.push(`Investigation not answered (${closing.open.map((r) => r.id).join(", ")}): closing as partial, carried forward in ${closing.tracked.join(", ")}`);
    }
    if (degradedReq?.tracked && !closing.tracked.includes(degradedReq.tracked)) closing.tracked.push(degradedReq.tracked);

    phaseLedger.enter("ci_wait");
    // ---- 5. push + PR ----
    files = await changedFiles();
    await gitPush(["push", "-u", "origin", branch]);
    laneGuard(lane, "open a PR");
    const prOut = resumed?.pr ? `/pull/${resumed.pr}` : String(await ghw(["pr", "create", "-R", repo, "--base", lane, "--head", branch,
      "--title", `${iss.title} (#${issue})`, "--body", withLink(isSplit ? (o.refactorModule ?? (await import("./refactor.mjs"))).renderSplitPrBody({ issue, ...split })
        : renderPrBody({ issue, investigation: await readStage(STAGES[0]), contract: effective, implementation: await readStage(STAGES[1]), result, gitFiles: files, tracked: closing.tracked }))])).trim();
    const pr = Number(/\/pull\/(\d+)/.exec(prOut)?.[1] ?? /(\d+)\s*$/.exec(prOut)?.[1]);
    if (!Number.isInteger(pr)) return await needsHuman(`Could not parse the PR number from: ${prOut.slice(0, 200)}`);
    ev({ event: "PR_OPENED", pr });
    await emit({ event: "PR_OPENED", pr });
    if (!resumed?.pr && !adoptPr) { try { const old = await supersedeOlderPrs({ repo, io: { gh: ghw }, issue, newPr: pr }); if (old.length) T.decisions.push(`Superseded older open PR(s) ${old.map((n) => `#${n}`).join(", ")} (one live PR per issue)`); } catch { /* best effort: the orphan sweep closes it later */ } } // #5505
    if (resumed?.pr && closing.tracked.length) { // an existing PR still has to link the tracking issues visibly
      try { await ghw(["pr", "edit", String(pr), "-R", repo, "--body", withLink(renderPrBody({ issue, investigation: await readStage(STAGES[0]), contract: effective, implementation: await readStage(STAGES[1]), result, gitFiles: files, tracked: closing.tracked }))]); }
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
    // #4386: the bound counts syncs against one base head; a sync overtaken by a new base head made progress.
    let syncs = 0, sameBaseSyncs = 0, lastSyncBase = null, mergeRetries = 0;
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
    /** #4507: true only when the PR reads MERGED; unreadable counts as not merged. */
    const prMerged = async () => {
      try { return String(JSON.parse(String(await ghc(["pr", "view", String(pr), "-R", repo, "--json", "state"])) || "{}").state ?? "").toUpperCase() === "MERGED"; } catch { return false; }
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
    /** #5583 follow-up: the builder resolved a base-sync whose conflicts were all documentation files, and the lane's non-doc
     * diff against the new base equals its non-doc diff against the old fork point (so no code changed in the resolution). */
    const DOC_FILE_RE = /\.(md|mdx|markdown|rst|adoc|txt)$/i, DOC_EXCLUDES = ["md", "mdx", "markdown", "rst", "adoc", "txt"].map((e) => `:(exclude)*.${e}`);
    const docsOnlyConflict = async (conflicted, laneBefore) => {
      if (!conflicted.length || !conflicted.every((f) => DOC_FILE_RE.test(f))) return false;
      try {
        const fork = await gitOut(["merge-base", laneBefore, "HEAD^2"]);
        if (!/^[0-9a-f]{7,}$/.test(fork)) return false; // gitOut swallows errors as "": never treat that as "unchanged"
        const was = await gitOut(["diff", fork, laneBefore, "--", ".", ...DOC_EXCLUDES]);
        const now = await gitOut(["diff", "HEAD^2", "HEAD", "--", ".", ...DOC_EXCLUDES]);
        return was === now;
      } catch { return false; }
    };
    const unresolved = async () => (await conflictFiles()).length > 0 || (await gitOut(["grep", "-n", "-e", "^<<<<<<< ", "-e", "^>>>>>>> "])) !== ""
      || (await gitOut(["diff", "--check"])) !== "" || (await gitOut(["rev-parse", "-q", "--verify", "MERGE_HEAD"])) !== "";
    const syncRow = [];
    /** Returns null to continue with the merge flow, or a terminal result. */
    function baseSync(trigger, soft = false) { return phaseLedger.during("base_sync", () => baseSyncRaw(trigger, soft)); }
    async function baseSyncRaw(trigger, soft = false) {
      await renew();
      try { await git(["fetch", "origin", lane]); } catch { /* offline: use the local ref */ }
      const baseFull = await gitOut(["rev-parse", base]), baseSha = baseFull.slice(0, 12);
      if (baseFull !== lastSyncBase) { lastSyncBase = baseFull; sameBaseSyncs = 0; }
      if (sameBaseSyncs >= MAX_SYNCS) return await needsHuman(`PR #${pr} still conflicts with ${lane} after ${MAX_SYNCS} base-syncs against ${baseSha || base} (${trigger}).`, OUTCOME_CODES.BASE_CONFLICT);
      sameBaseSyncs++; syncs++;
      const before = await gitOut(["rev-parse", "HEAD"]);
      let clean = true, files = [];
      try { await git(["merge", "--no-edit", base]); } catch { clean = false; files = await conflictFiles(); }
      if (isSplit && !clean) { // #4211: no builder resolves a split's conflicts; a fresh run re-splits on the new base
        await gitOut(["merge", "--abort"]);
        return await needsHuman(`PR #${pr} (refactor:split) conflicts with ${lane} in ${files.join(", ") || "unknown files"}; a split is never resolved by an LLM. Close the PR and rerun on the new base.`, OUTCOME_CODES.BASE_CONFLICT);
      }
      let how, tests = "not required (clean merge)", rereview = "not required (conflict-free base merge)", detResolved = false;
      // #4386: conflicts only in sequence files (numbered, journal, snapshot, their index) resolve without a builder
      // #4588: union / JSON-map / generated files resolve first; only the files left go to the sequence resolver
      const bm = o.baseMerge, cr = !clean && io.conflictResolve && bm && Object.values(bm).some((v) => v?.length) ? await io.conflictResolve({ cwd: wt, files, cfg: bm }).catch(() => null) : null;
      let seqFiles = cr?.resolved?.length ? cr.remaining : files, crDone = false, docsOnlySync = false;
      if (cr?.resolved?.length && !seqFiles.length) { try { await git(["commit", "--no-edit"]); crDone = true; } catch { /* the builder finishes the merge */ } }
      if (cr?.note) T.decisions.push(`Base-sync ${syncs}: ${cr.note}`);
      const rs = !clean && !crDone && seqFiles.length && io.sequenceResolve ? ((await io.sequenceResolve({ cwd: wt, files: seqFiles }).catch((e) => ({ unsupported: String(e?.message ?? e) }))) ?? {}) : null;
      if (rs?.unsupported) T.decisions.push(`Base-sync ${syncs}: no deterministic resolution (${rs.unsupported})`);
      if (clean) {
        how = "clean merge of the base into the branch";
      } else if (crDone) {
        detResolved = true;
        T.decisions.push(`Base-sync ${syncs}: conflicts only in union / JSON-map / generated files (${files.join(", ")}); resolved by the engine (no builder)`);
        how = `deterministic: ${files.length} union / JSON-map / generated file(s) resolved`;
        tests = "not required (deterministic base-merge resolution)";
      } else if (rs?.ok) {
        detResolved = true;
        T.decisions.push(`Base-sync ${syncs}: conflicts only in sequence files (${files.join(", ")}); base side taken, lane files renumbered by the engine (no builder)`);
        how = `deterministic: base side taken for ${files.length} sequence file(s)`;
        tests = "not required (deterministic sequence resolution)";
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
        docsOnlySync = await docsOnlyConflict(files, before); // #5583 follow-up
        if (docsOnlySync) { T.decisions.push(`Base-sync ${syncs}: conflicts only in documentation (${files.join(", ")}) and the lane's code diff is unchanged; no re-review`); tests = "not required (documentation-only conflicts; lane code diff unchanged)"; }
      }
      const sq = await sequenceHandoff(`base-sync ${syncs}`, detResolved ? { laneRef: before } : {}); // #4322: a clean text merge can still bring a taken number
      if (sq?.done) return sq.done;
      if (sq?.renumbered) { how += sq.deterministic ? "; lane files renumbered deterministically" : "; builder renumbered sequence-numbered files"; }
      let pm = { fixed: false, ran: "" }, dupFixed = false;
      if ((await gitOut(["rev-parse", "HEAD"])) !== before) { // #4406: the merged tree, before the push
        pm = await postMergeGate(`base-sync ${syncs}`);
        if (pm.stuck?.length) return (await guardRed(pm.stuck)) ?? await needsHuman(`Guard command(s) still fail on the merged tree after ${base} was merged in (${pm.stuck.map((f) => f.command).join(", ")}); nothing merged.`, OUTCOME_CODES.CI_RED); // #5239
        if (pm.ran) tests = clean ? pm.ran : `${tests}; post-merge: ${pm.ran}`;
        if (pm.fixed) how += "; builder fixed post-merge check failures";
        dupFixed = await duplicateGate(`base-sync ${syncs}`);
        if (dupFixed) how += "; builder resolved duplicate exports";
        if (await i18nGate(`base-sync ${syncs}`)) how += "; builder translated English-copy keys";
      }
      const after = await gitOut(["rev-parse", "HEAD"]);
      if (soft && clean && after === before) { syncs--; sameBaseSyncs--; return null; } // UNKNOWN state and nothing to merge: not a conflict
      if (after !== before) await gitPush(["push", "origin", branch]); // plain push of a merge commit: never force
      let ciFixes = 0;
      if (isSplit && after !== before) { // #4211: the merged head must still be a pure move against the new base
        const rv = await (o.refactorModule ?? (await import("./refactor.mjs"))).reverifySplit({ wt, base, target: split.target, testCmd: split.testCmd, runTmp, git });
        if (!rv.ok) return await needsHuman(`refactor:split no longer verifies after merging ${base}: ${rv.reason}`, rv.code);
        rereview = "refactor-verify re-run against the new base: ok";
      }
      if (remoteVerify && after !== before) { const v = await ciVerify("base-sync"); if (v.done) return v.done; ciFixes = v.fixes; }
      const engineOnly = !ciFixes && !pm.fixed && !dupFixed && (clean || detResolved) && (!sq?.renumbered || sq.deterministic); // #4386: no builder touched the delta
      if (!isSplit && engineOnly && (detResolved || sq?.deterministic)) rereview = "not required (deterministic renumber + base merge)";
      else if (!isSplit && docsOnlySync && !ciFixes && !pm.fixed && !dupFixed && !sq?.renumbered) rereview = "not required (documentation-only conflicts; lane code diff unchanged)";
      else if (!isSplit && (!clean || sq?.renumbered || ciFixes || pm.fixed || dupFixed)) {
        let rv = await doReview();
        if (rv.env) return await envNeedsHuman(rv.env);
        if (rv?.fail) {
          T.decisions.push(`Base-sync re-review FAIL: builder resumed with the reason`);
          await fixRound("review", conformanceResumePrompt(rv.failures, vcfg.mode), rv.failures, "review", failureLog(rv.failures));
          if (await unresolved()) return await needsHuman("Base-sync re-review fix left conflict markers.", OUTCOME_CODES.BASE_CONFLICT);
          if ((await gitOut(["rev-parse", "HEAD"])) !== after) await gitPush(["push", "origin", branch]);
          // #4527: the fix round's head is CI-verified before the retry review, as in the main loop
          if (remoteVerify) { const v = await ciVerify("base-sync"); if (v.done) return v.done; }
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
      // #4586: the failed runs are rerun once per head before a round is counted; the red check is waited out until the rerun reports (bounded).
      const rkey = `merge:${localHead}`, rerun = ciReruns.get(rkey);
      if (!rerun && !isSplit) {
        const rr = await rerunFailedOnce({ io, v: { failedChecks: checks, failures: checks.map((c) => ({ job: c.name })) } });
        ciReruns.set(rkey, { rr, urls: new Map(checks.map((c) => [c.name, c.url ?? null])), waits: 0 });
        ev({ event: "CI_FLAKE_RERUN", trigger: "merge", head: localHead, runs: rr.runs, jobs: rr.jobs, result: rr.ok ? "rerun-started" : "rerun-failed", detail: rr.detail });
        if (rr.ok) { await sleep(20000); return null; }
      } else if (rerun?.rr.ok && rerun.waits < 20 && checks.every((c) => (c.url ?? null) === rerun.urls.get(c.name))) {
        rerun.waits++; await sleep(20000); return null; // still the attempt that was rerun
      }
      const flakyNames = checks.filter((c) => vcfg.flaky?.includes(c.name)).map((c) => c.name);
      if (flakyNames.length) { T.anomalies.push(`Known-flaky required check(s) reported (verify.flaky): ${flakyNames.join(", ")}`); ev({ event: "CI_FLAKY_REPORTED", trigger: "merge", head: localHead, jobs: flakyNames }); }
      checks = checks.filter((c) => !flakyNames.includes(c.name));
      const jobs = checks.map((c) => c.name);
      if (!checks.length) return await needsHuman(`Required check(s) ${flakyNames.join(", ")} (verify.flaky) still failed on PR #${pr} after one rerun; a required check blocks the merge whatever verify.flaky says; nothing merged.`, OUTCOME_CODES.CI_RED);
      if (ciRounds >= vcfg.maxRounds || !sessionId) {
        return await needsHuman(`Required check(s) failed on PR #${pr}: ${jobs.join(", ")}${ciRounds ? ` (after ${ciRounds} CI fix round(s))` : ""}`, OUTCOME_CODES.CI_RED);
      }
      const failures = await collectFailedLogs(io, checks);
      ciRounds++;
      T.decisions.push(`Required check(s) failed on PR #${pr} (${jobs.join(", ")}); builder resumed with the failed logs (round ${ciRounds}/${vcfg.maxRounds})`);
      ev({ event: "CI_FIX_ROUND", trigger: "merge", round: ciRounds, jobs, pr });
      const before = await gitOut(["rev-parse", "HEAD"]);
      const priorRows = Array.isArray(result?.validation) ? result.validation : [];
      await fixRound("ci", ciFailurePrompt(failures, vcfg.mode), [], "merge_ci", failureLog(failures));
      await upsertStage("implementation");
      result = (await readResult()) ?? result;
      if ((await gitOut(["rev-parse", "HEAD"])) === before) {
        return await needsHuman(`Required check(s) failed on PR #${pr} (${jobs.join(", ")}) and the builder made no new commit for it; nothing merged.`, OUTCOME_CODES.CI_RED);
      }
      // #4708: the fix session may rewrite result.json without the validate rows recorded earlier: carry those forward (marked) onto disk, which gate() re-reads
      const have = new Set((Array.isArray(result?.validation) ? result.validation : []).map((x) => x?.id)), carried = priorRows.filter((x) => x?.id && !have.has(x.id));
      if (carried.length && io.fs.write) {
        result = { ...result, validation: [...(Array.isArray(result?.validation) ? result.validation : []), ...carried.map((x) => ({ ...x, carried: true }))] };
        try { await io.fs.write(`${wt}/${RESULT_FILE}`, `${JSON.stringify(result)}\n`); } catch { /* the gate reads what is on disk */ }
        T.decisions.push(`Validate result(s) ${carried.map((x) => x.id).join(", ")} carried forward across the CI fix round`);
      }
      // #4708: the fix head is CI-verified before its review, as in the base-sync retry (#4527), so validates left to CI are covered
      if (remoteVerify) { const v = await ciVerify("merge"); if (v.done) return v.done; }
      const rows = Array.isArray(result?.validation) ? result.validation : [], headNow = await gitOut(["rev-parse", "HEAD"]);
      const lost = (effective.validate ?? []).filter((v) => !rows.some((x) => x?.id === v.id) && !(remoteVerify && ciVerifiedHead === headNow)).map((v) => v.id);
      if (lost.length) return await needsHuman(`Validate result(s) ${lost.join(", ")} missing after a CI fix round on PR #${pr}: the earlier results were lost and none could be carried forward; nothing merged.`, OUTCOME_CODES.ENGINE_VALIDATE_RESULT_LOST);
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
      catch (e) {
        const error = String(e?.stderr ?? e?.message ?? e).slice(0, 300);
        if (/remote ref does not exist/i.test(error)) { ev({ event: "BRANCH_DELETED", branch, where: "origin", already: true }); return; } // #5437: a retry after the first delete landed
        ev({ event: "BRANCH_DELETE_FAILED", branch, where: "origin", error }); throw e; // the post-run queue retries it
      }
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
        decisions: (Array.isArray(effective?.decisions) ? effective.decisions : []).filter((k) => k?.id).map((k) => ({ id: k.id, source: k.source ?? null })).concat((effective?.preserve ?? []).filter((p) => /^H\d+$/.test(p?.id) && p.source === "guard").map((p) => ({ id: p.id, source: p.source }))),
      };
      T.structure = s;
      const rec = { event: "STRUCTURE_DELTA", phase: "merge", pr, ...(milestone ? { milestone } : {}), ...s,
        edges_added: s.deps_added.length, edges_removed: s.deps_removed.length, import_files_added: sum("files_added"), import_files_removed: sum("files_removed"),
        boundary_changed: Boolean(d.boundary_config_changed?.changed), boundary_loosened: Boolean(d.boundary_config_changed?.loosens) };
      ev(rec);
      postRun.add("structure-telemetry", () => emit(rec)); // #5437: the telemetry write leaves the critical path
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
      const ownReal = own.filter((f) => !vcfg.flaky?.includes(f.job));
      if (own.length > ownReal.length) { T.anomalies.push(`Known-flaky e2e failure(s) reported, not blocking (verify.flaky): ${own.filter((f) => !ownReal.includes(f)).map((f) => f.job).join(", ")}`); }
      if (ownReal.length) { const r = await mergeFixRound(ownReal.map((f) => ({ name: f.job, url: f.url }))); return r ? { done: r } : { again: true }; }
      if (v.result === "fail") T.anomalies.push(`Pre-existing e2e failure(s) reported, not blocking: ${v.failures.map((f) => f.job).join(", ")}`);
      e2eHead = localHead;
      return null;
    }

    // ---- 7. (sync) wait per policy, (sync) merge at the reviewed head ----
    let lastStates = null; // the last required-check poll, reused by the DCO gate (#4651)
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
            lastStates = states;
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
      // #4386: late binding. A lane with numbered files holds the host sequence lease from here through the merge and
      // re-checks its numbers against the fetched lane; a taken number is renumbered by the engine and only CI is waited on.
      if (io.sequenceCheck && io.sequenceLease && !isSplit) {
        if (!seqLease) {
          const mine = (await io.sequenceSnapshot?.({ cwd: wt, base }).catch(() => null)) ?? [];
          if (mine.length) {
            seqLease = await io.sequenceLease.acquire({ repo, lane, dirs: [...new Set(mine.map((f) => dirname(f.path)))], issue, maxWaitS: ciMaxMinutes * 60 }).catch(() => null);
            if (seqLease) T.decisions.push(seqLease.timedOut ? `Sequence lease timed out after ${Math.round((seqLease.waitMs ?? 0) / 1000)}s (fail-open)` : `Sequence lease held (waited ${Math.round((seqLease.waitMs ?? 0) / 1000)}s)`);
          }
        }
        if (seqLease) {
          try { await git(["fetch", "origin", lane]); } catch { /* offline: use the local ref */ }
          const late = (await io.sequenceCheck({ cwd: wt, base, versioned: o.sequenceVersioned, extraBases: defaults.filter((d) => d && `origin/${d}` !== base).map((d) => `origin/${d}`) }).catch(() => null)) ?? [];
          if (late.length) {
            ev({ event: "SEQUENCE_LATE_BIND", pr, files: late.map((c) => c.lane) });
            const r = await baseSync("merge gate: sequence number taken"); if (r) return r;
            continue; // wait for the required checks of the renumbered head
          }
        }
      }
      // #4651: a failed DCO check blocks the merge even when it is not a required check on the lane branch (it would block the release PR)
      let dcoFailed = [];
      try { dcoFailed = ((lastStates ?? await io.checkStates?.(pr)) ?? []).filter((x) => /\bdco\b/i.test(String(x?.name ?? "")) && x.state === "failure" && (!x.head || !localHead || String(x.head).startsWith(localHead) || localHead.startsWith(String(x.head)))); } catch { dcoFailed = []; }
      if (dcoFailed.length) return await needsHuman(`DCO check failed on PR #${pr} (${[...new Set(dcoFailed.map((x) => x.name))].join(", ")}); a commit lacks a sign-off or has a placeholder author, which would block the release. Nothing merged.`, OUTCOME_CODES.CI_DCO);
      T.merge = [policyText, `merged at ${localHead.slice(0, 12)}`];
      laneGuard(resumed?.base ?? lane, "merge");
      try {
        phaseLedger.enter("merge");
        await ghc(["pr", "merge", String(pr), "-R", repo, "--merge", "--match-head-commit", localHead]);
        try { seqLease?.release(); } catch { /* fail-open */ }
        seqLease = null;
        break;
      } catch (e) {
        const msg = `${e?.stderr ?? ""}${e?.message ?? ""}`;
        if (await prMerged()) { // #4507: the merge went through despite the error
          T.decisions.push(`gh pr merge errored but PR #${pr} is MERGED: recorded merged (${msg.split("\n")[0].slice(0, 120)})`);
          try { seqLease?.release(); } catch { /* fail-open */ }
          seqLease = null;
          break;
        }
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
    postRun.add("branch-delete", deleteMergedBranch); // #5437: sets deleteLocalBranch before the teardown job
    let keepOpen = false;
    if (pendingRecord().length) { // #5141: the close step files what the lane could not track before the PR (idempotent by the marker)
      const left = pendingFollowups.filter((p) => !p.req.tracked);
      for (const why of new Set(left.map((p) => p.why))) {
        try { await track(left.filter((p) => p.why === why).map((p) => p.req), `${why}; filed after the merge`); } catch (e) { T.anomalies.push(`follow-up filing after the merge failed: ${String(e?.message ?? e).slice(0, 160)}`); }
      }
      for (const p of left) if (p.req.tracked && !closing.tracked.includes(p.req.tracked)) closing.tracked.push(p.req.tracked);
      const still = pendingRecord();
      if (still.length) {
        keepOpen = true; // release review #5155 (#5156): nothing re-files a pending item, so the issue stays open as the durable record
        T.decisions.push(`Follow-up still unfiled after the merge: ${still.map((x) => x.id).join(", ")}; issue left open (FORGE:FOLLOWUP_PENDING, FORGE:STATE pendingFollowups) until it is tracked`);
        try { await post("FORGE:FOLLOWUP_PENDING", renderPendingFollowups(still, pr)); } catch { /* FORGE:STATE and the lane result carry them too */ }
      }
    }
    const partial = closing.reason === "partial";
    if (closing.checklist || closing.liveBlocked || closing.transferred) keepOpen = true; // #5339: a transferred e2e/manual requirement is not met; // #5240: an unmet acceptance checkbox is not closed as completed; #5285: nor a default-on change with live acceptance deferred
    if (closing.liveBlocked) { // #5285: post what blocks the close
      try { await post("FORGE:TRACKED", `## Left open: live acceptance deferred on a default-on change\nMerged by PR #${pr}, but the rollout is live and these requirements still need live verification:\n${closing.blocks.map((b) => `- ${b.id} (flag ${b.flag})`).join("\n")}\n\nKeep the flag default-off until they are verified, or verify them and close.${closing.tracked.length ? ` Tracked in ${closing.tracked.join(", ")}.` : ""}`); } catch { /* the trajectory decision records it too */ }
    }
    // #5152: a merged change is `completed` even when partial: the remainder is tracked (FORGE:TRACKED), not dropped
    if (!keepOpen && !(await closeBlockers("completed", pr)).length) await ghw(["issue", "close", String(issue), "-R", repo, "--reason", "completed"]).catch(() => {}); // #5505: not while another own PR is open
    if (closing.transferred) { // #5339: record what is transferred, not met
      try { await post("FORGE:TRACKED", `## Left open: transferred, not met\nMerged by PR #${pr}, but these end-to-end/manual requirements were not run in the lane:\n${(closing.transfer ?? closing.open).map((r) => `- ${r.id}: ${r.transferred ? `transferred to epic #${r.transferred} (post-deploy journey)` : "no epic to take it"}`).join("\n")}${closing.tracked.length ? `\n\nTracked in ${closing.tracked.join(", ")}.` : ""}`); } catch { /* the PR body carries them too */ }
    } else if (closing.liveBlocked) { /* #5285: posted above */ } else if (closing.checklist) { // #5240: partial: left open; the unticked criteria, tracked follow-ups and any inert rollout are the record
      try { await post("FORGE:TRACKED", `## Left open: partial\nMerged by PR #${pr}, but these acceptance criteria are not met by it:\n${closing.unticked.map((u) => `- [ ] ${u}`).join("\n")}${closing.tracked.length ? `\n\nTracked in ${closing.tracked.join(", ")}.` : ""}${inert.length ? `\n\nInert in production: the change takes effect only behind ${inert.map((m) => `\`${m.flag}\` (mode: ${m.mode})`).join(", ")}; the production outcome is not claimed.` : ""}`); } catch { /* the PR body and FORGE:STATE carry them */ }
    } else if (keepOpen) { // #5159: the issue is not closed while a follow-up is pending, so the note must not say it is
      if (partial || closing.tracked.length) try { await post("FORGE:TRACKED", `## Left open: follow-up pending\nMerged by PR #${pr}; the issue stays open until the pending follow-up is filed (FORGE:FOLLOWUP_PENDING).${partial ? " The investigation's stated question is not answered in this change." : ""}${closing.tracked.length ? ` Already tracked in ${closing.tracked.join(", ")}.` : ""}`); } catch { /* the PR body links them too */ }
    } else if (partial) {
      try { await post("FORGE:TRACKED", `## Closed as partial\nClosed as completed by PR #${pr}; the investigation's stated question is not answered in this change and is carried forward in ${closing.tracked.join(", ")}.`); } catch { /* the PR body links them too */ }
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
    if (!keepOpen) { const f = await resolveFindingLabel({ io, issue, labels: iss.labels, reason: "merged" }); if (f.error) T.anomalies.push(`finding label not resolved: ${f.error}`); } // #5254
    try { // #4695/#4737: FORGE:DECISION records and supersession are persisted only after the merge
      const rec = await recordDecisions(pendingDecisions, { issue, repo, post });
      if (rec.length) T.decisions.push(`FORGE:DECISION: ${rec.map((d) => d.id).join(", ")}`);
      for (const d of rec.filter((x) => x.supersedes && x.consumers?.length)) { // #5338: a superseded interface reopens/notifies its consumers, or files one issue per named consumer
        const n = await notifyConsumers({ rec: d, pr, repo, gh: ghw });
        T.decisions.push(`Interface ${d.supersedes} superseded by ${d.id}: ${n.map((x) => `${x.consumer} ${x.action}${x.issue ? ` #${x.issue}` : ""}`).join(", ")}`);
      }
    } catch (e) { T.anomalies.push(`decision records not posted: ${String(e?.message ?? e).slice(0, 160)}`); }
    for (const sp of supersededIds(effective, guardSel)) { // #4693: the reviewer accepted the supersedes amendment; tell the guarded issue
      try { await ghw(["issue", "comment", sp.guard.slice(1), "-R", repo, "--body", supersessionComment({ guard: sp.guard, pr, why: sp.why })]); ev({ event: "supersedes_accepted", guard: sp.guard, pr }); T.decisions.push(`Guard ${sp.guard} superseded: ${sp.why}`); } catch (e) { T.anomalies.push(`supersession of ${sp.guard} not posted: ${String(e?.message ?? e).slice(0, 160)}`); }
    }
    postRun.add("guard", async () => { try { const g = await (o.guardAfterMerge ?? guardAfterMerge)({ io, repo, issue, pr, cwd: wt, base }); if (g?.posted) T.decisions.push(`FORGE:GUARD posted: ${g.guard.tests.length} test file(s), ${g.guard.hunks.length} hunk(s)`); else if (g?.skipped) ev({ event: "GUARD_SKIPPED", reason: g.reason }); } catch { /* the guard is best effort */ } }); // #5437
    // forge#4161: the merge-time structure record and the milestone ride on the lane result for orchestrate's drift fold.
    await gatePassed("merge_ci", "ci_red"); // #4375: merged means the required checks are green after a CI fix round
    let mergedTo = null; // #4711: FORGE:STATE records the lane and merge commit, so a dependent's check needs no PR search
    if (lane) try { const sha = JSON.parse(String(await ghc(["pr", "view", String(pr), "-R", repo, "--json", "mergeCommit"])) || "{}").mergeCommit?.oid; if (typeof sha === "string" && sha) mergedTo = { lane, pr, sha }; } catch { /* the PR-ancestry rule still applies */ }
    return await finish("merged", `PR #${pr}`, { pr, ...(mergedTo ? { mergedTo } : {}), ...(partial ? { close: "partial" } : {}), ...(keepOpen ? { keptOpen: true } : {}), structure: T.structure ?? null, ...(milestone ? { milestone } : {}), ...(lane ? { lane } : {}) });
  } catch (e) {
    if (e?.deferUsageLimit) {
      const when = e.resetAt || (Number.isFinite(e.resetAtEpochMs) ? new Date(e.resetAtEpochMs).toISOString() : "unknown");
      return finish("deferred", `usage limit hit; resets at ${when}`, { code: OUTCOME_CODES.RATE_LIMITED, resetAt: when, resetAtEpochMs: Number.isFinite(e.resetAtEpochMs) ? e.resetAtEpochMs : null, backendId: laneBackendId(process.env, rotator) }, OUTCOME_CODES.RATE_LIMITED);
    }
    if (e?.deferCode) return finish("deferred", e.deferDetail ?? String(e.message), { code: e.deferCode, ...(e.retryInSeconds ? { retryInSeconds: e.retryInSeconds } : {}), ...(e.backendId ? { backendId: e.backendId } : {}), ...quotaFacts(e) }, e.deferCode); // #5168: backendId keys the account hold; #5236 reset
    // #4505: a turn overrun is mechanical: a non-human end the batch recovers, needs-human only once a budget recovery failed too
    if (e?.laneCode === OUTCOME_CODES.BUDGET_EXCEEDED && !(recover?.final && recover.code === OUTCOME_CODES.BUDGET_EXCEEDED)) {
      return finish("budget-exceeded", e.message, { code: OUTCOME_CODES.BUDGET_EXCEEDED, branch, ...(recover ? { recovery: true } : {}) }, OUTCOME_CODES.BUDGET_EXCEEDED);
    }
    if (e?.laneCode) return await needsHuman(e.message, e.laneCode);
    if (e?.code === "CLI_SPAWN_FAILED" || e?.spawnDeterministic === true) { // #4129: certain to fail again, so not engine-error (orchestrate would relaunch it)
      return await needsHuman(`The claude CLI could not be started (${e.spawnErrno ?? "spawn error"}); a rerun fails the same way: ${String(e.message).slice(0, 400)}`, OUTCOME_CODES.CLI_SPAWN_FAILED);
    }
    if (e?.pushRejected && /non-fast-forward|fetch first|\[rejected\]/i.test(String(e?.stderr ?? e?.message ?? e))) {
      // #4920: another live lane owns this branch (its lease, or its open PR): this lane is superseded, nothing for a human to do
      let owner = null;
      try { owner = await otherLaneOwner({ gh: (a) => ghc(a), repo, issue, branch, selfId: agentId, ownPr: Number(/#(\d+)/.exec(String(T.pr?.[0] ?? ""))?.[1]) || null }); } catch { /* fail-open */ }
      if (owner) return finish("deferred", `git push was rejected (non-fast-forward): ${owner.detail}; another lane owns ${branch}`, { code: OUTCOME_CODES.LEASE_HELD, branch }, OUTCOME_CODES.LEASE_HELD);
      // #5202: the lane's own history diverged from origin/<branch> (not reconcilable checkpoints): mechanical, never needs-human
      return finish("engine-error", `git push was rejected (non-fast-forward) and no other lane owns ${branch}: ${String(e?.stderr ?? e?.message ?? e).slice(0, 400)}`, { code: OUTCOME_CODES.ENGINE_PUSH_DIVERGED, branch }, OUTCOME_CODES.ENGINE_PUSH_DIVERGED);
    }
    if (e?.pushRejected) return await needsHuman(`git push was rejected (no retry): ${String(e?.stderr ?? e?.message ?? e).slice(0, 400)}`);
    if (e?.engineCode) return finish("engine-error", e?.message ?? String(e), { code: e.engineCode }, e.engineCode); // #4997
    return finish("engine-error", e?.message ?? String(e));
  }
}

export const runLean = runCore;
