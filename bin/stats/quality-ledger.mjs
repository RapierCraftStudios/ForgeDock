// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Quality ledger (#6203): the per-merge MERGE_LEDGER telemetry record, plus the pure helpers the weekly scorecard and the
 * escape linker share. No model calls; everything is derived from run-log / batch-row / GitHub facts that already exist.
 */
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs)$/i;
export const isTestFile = (p) => TEST_PATH_RE.test(String(p ?? ""));

/** Test files added or changed in a diff, from `git diff --name-status` lines or plain names. */
export function testDelta(files = []) {
  const list = (files ?? []).map((f) => String(f ?? "").trim()).filter(Boolean);
  const tests = list.filter(isTestFile);
  return { files_changed: list.length, test_files: tests.length };
}

const isBotLogin = (l) => /\[bot\]$|^github-actions$|^dependabot$/i.test(String(l ?? ""));
/** Operator actions visible on the issue during the run: comments by a non-bot author that are not FORGE machine comments. */
export function humanTouches(comments = [], sinceMs = 0) {
  return (comments ?? []).filter((c) => {
    if (!c || c.__mine === true) return false;
    const login = c.author?.login ?? c.user?.login ?? null;
    if (!login || isBotLogin(login)) return false;
    if (/^\s*<!--\s*FORGE:/.test(String(c.body ?? ""))) return false;
    const at = Date.parse(c.createdAt ?? c.created_at ?? "");
    return !Number.isFinite(at) || at >= sinceMs;
  }).length;
}

/**
 * The MERGE_LEDGER record. first_pass: merged without a recovery run, a relaunch (attempt > 1) or a builder rework round
 * (reviewer, CI, precheck, conformance...) after the first build; null when the builder triggers are not measurable.
 * cost_usd is THIS run's total (one number per run); the scorecard sums distinct runs per lane, never cumulative rows.
 */
export function buildMergeLedger({ firstPass = null, recovered = false, attempt = 1, ciVerifies = 0, ciFixRounds = 0, files = [], comments = [], sinceMs = 0, costUsd = 0, phases = {}, wallMs = null, engineVersion = null, tier = null, builderSessions = null, splitPlan = null, model = null, pr = null } = {}) {
  const clean = firstPass === true && !recovered && !(attempt > 1) && !ciFixRounds;
  const byPhase = {};
  for (const [id, v] of Object.entries(phases ?? {})) if (isNum(v?.ms)) byPhase[id] = Math.round(v.ms);
  return {
    event: "MERGE_LEDGER", ...(Number.isInteger(pr) ? { pr } : {}),
    first_pass: firstPass == null && !recovered && !(attempt > 1) ? null : clean,
    human_touch: humanTouches(comments, sinceMs),
    test_files: testDelta(files).test_files, files_changed: testDelta(files).files_changed,
    ci_attempts: Math.max(0, Math.round(ciVerifies)), ci_fix_rounds: Math.max(0, Math.round(ciFixRounds)),
    cost_usd: Math.round((costUsd || 0) * 1e6) / 1e6, ...(isNum(wallMs) ? { wall_ms: Math.round(wallMs) } : {}), wall_ms_by_phase: byPhase,
    // #6207: distinct builder CLI sessions (about 2.2 before the fold) and the lane shape; plan time stays in wall_ms_by_phase.plan (a sub-phase of the one builder session)
    ...(isNum(builderSessions) ? { builder_sessions: builderSessions } : {}), ...(typeof splitPlan === "boolean" ? { split_plan: splitPlan } : {}),
    engine_version: engineVersion ?? null, model_tier: tier ?? null, ...(model && model !== "default" ? { model } : {}), attempt, recovered: Boolean(recovered),
  };
}
