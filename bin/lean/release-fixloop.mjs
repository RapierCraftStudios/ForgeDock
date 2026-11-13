// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One-round CI fix loop of `forgedock release` (#5567, epic #5549 5.2/5.3, I16). Pure functions, no model call, no I/O of their
 * own: the findings collector (every failed CI job, review finding and guard failure on one head, flake-classified), the brief
 * compiler (grouped by the violated property, deterministic), the round counter keyed by head sha, and the second-push policy
 * (a mechanical revert or an infra-flake rerun, once; anything else is HELD with an owner ask). `fixStep` in
 * `release-review.mjs` drives them through its seam.
 */
import { createHash } from "node:crypto";
import { classifyFailure } from "./release-flakes.mjs";

export const DEFAULT_MAX_ROUNDS = 1;
const LOG_TAIL = 400;
const uniq = (a) => [...new Set(a)];
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** policy `ci.fix` -> {maxRounds, coStart, fullRunWorkflow}; defaults: one round, no co-start, no uncached full run. */
export function parseFixConfig(fix) {
  const n = Number(fix?.max_rounds ?? fix?.maxRounds); // accepts the policy form and an already parsed one
  const wf = [fix?.full_run_workflow, fix?.fullRunWorkflow].find((x) => typeof x === "string" && x.trim())?.trim() ?? null;
  return { maxRounds: Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_ROUNDS, coStart: fix?.co_start === true || fix?.coStart === true || Boolean(wf), fullRunWorkflow: wf };
}

/**
 * One record of everything wrong at `head`. `jobs`: [{name, conclusion, log?, inputHash?}] of the finished CI jobs (only failed ones
 * are kept), `findings`: review findings [{id?, title, severity?, property?, wave?: boolean, blocking?: boolean}], `guards`:
 * [{name, why}]. Sorted so a fixed input gives a fixed record.
 */
export function collectFindings({ head, jobs = [], findings = [], guards = [] }) {
  const ci = jobs
    .filter((j) => j.conclusion === "failure")
    .map((j) => ({ name: j.name, ...classifyFailure(j.log), inputHash: j.inputHash ?? null, tail: String(j.log ?? "").slice(-LOG_TAIL) }))
    .sort((a, b) => byText(a.name, b.name));
  const review = findings
    .map((f) => ({ id: f.id ?? null, title: String(f.title ?? f.id ?? "finding"), severity: String(f.severity ?? "").toUpperCase() || null, property: f.property ?? f.invariant ?? f.category ?? null, inWave: f.wave !== false, blocking: f.blocking !== false && /^(CRITICAL|HIGH)$/i.test(String(f.severity ?? "")) }))
    .sort((a, b) => byText(a.title, b.title) || byText(String(a.id), String(b.id)));
  const gs = guards.map((g) => ({ name: g.name, why: String(g.why ?? "") })).sort((a, b) => byText(a.name, b.name));
  return { head, ci, review, guards: gs };
}

/** Findings that block this round: blocking, in-wave review findings; every failed CI job; every guard failure. */
export const blockingOf = (rec) => ({ ci: rec.ci, review: rec.review.filter((f) => f.blocking && f.inWave), guards: rec.guards });
/** Findings that never block: non-blocking or outside the wave. They become issues for the next plan and are never merged after READY (I16). */
export const deferredOf = (rec) => rec.review.filter((f) => !(f.blocking && f.inWave));
/** True when every failed CI job carries a known infra signature and nothing else is wrong. */
export const onlyInfraFlakes = (rec) => rec.ci.length > 0 && rec.ci.every((j) => j.class === "infra") && !blockingOf(rec).review.length && !rec.guards.length;

/**
 * The fix brief: findings grouped by the property they violate (a CI job is `ci:<name>`, a guard `guard:<name>`), one
 * sibling-sweep instruction, the CI-equivalent local commands and the checks that will rerun. Deterministic for a fixed input.
 */
export function compileBrief(rec, { commands = [], rerunChecks = [] } = {}) {
  const groups = new Map();
  const add = (prop, line) => groups.set(prop, [...(groups.get(prop) ?? []), line]);
  const b = blockingOf(rec);
  for (const f of b.review) add(f.property ?? "unclassified", `${f.severity ?? "finding"}: ${f.title}`);
  for (const j of b.ci) add(`ci:${j.name}`, j.tail ? `failed: ${j.tail.replace(/\s+/g, " ").trim()}` : "failed");
  for (const g of b.guards) add(`guard:${g.name}`, g.why || "failed");
  const out = [`Fix everything below in ONE commit series on the wave branch, at head ${rec.head}. One push; there is no second round.`, ""];
  for (const prop of [...groups.keys()].sort(byText)) {
    out.push(`## Invariant: ${prop}`, ...uniq(groups.get(prop)).sort(byText).map((l) => `- ${l}`), "");
  }
  out.push("## Sibling sweep", "For each invariant above, search the whole change for other places that break the same property and fix those too; do not fix only the instances named.", "");
  const cmds = uniq(commands);
  out.push("## Run locally first (CI-equivalent; all must be green before you push)", ...(cmds.length ? cmds.map((c) => `- \`${c}\``) : ["- (no preflight.commands configured)"]), "");
  const checks = uniq(rerunChecks).sort(byText);
  out.push("## Checks that will rerun", ...(checks.length ? checks.map((c) => `- ${c}`) : ["- (none recorded)"]), "");
  return out.join("\n");
}

/** Stable hash of a job's inputs: a rerun is requested only for jobs whose hash differs from the one that last ran. */
export const inputHash = (...parts) => createHash("sha256").update(parts.map(String).join("\0")).digest("hex").slice(0, 16);
/** Names of the jobs to rerun after the fix push: `now` and `before` map job name -> input hash; unchanged jobs are not requested. */
export const jobsToRerun = (now, before = {}) => Object.keys(now).filter((n) => before[n] !== now[n]).sort(byText);

/** Fix rounds already spent for `head`: the counter is keyed by head sha and a fix push links the new head to its parent. */
export const roundsAt = (state, head) => state?.fixloop?.heads?.[head]?.rounds ?? 0;
/** Link the head a push produced to its parent; `kind` is set for a second push (`revert`|`rerun`), `failedBefore` the failing check names at `from`. */
export function recordRound(state, { from, to, kind = null, failedBefore = null }) {
  const fl = (state.fixloop ??= { heads: {} });
  fl.heads[to] = { parent: from, rounds: roundsAt(state, from) + 1, ...(kind ? { second: kind } : {}), ...(failedBefore ? { failedBefore } : {}) };
}
/** The second push already used on this head's line, if any. */
export const secondPushOf = (state, head) => state?.fixloop?.heads?.[head]?.second ?? null;

/**
 * May the loop push again (the round budget is spent or the first fix did not clear the head)? Only (a) a mechanical revert of the
 * round-1 commit or (b) an infra-flake rerun with no code change, each once; anything else is HELD with an owner ask.
 * `lastPush` is what the previous second push was, if any. No model adjudicates whether the fix caused the failure: a revert is
 * chosen only when a check fails now that was not failing before the fix (a set difference by check name).
 * @returns {{action: "revert"|"rerun"}|{action: "hold", ask: string}}
 */
export function secondPush({ rec, failedBefore = null, lastPush = null, maxRounds = DEFAULT_MAX_ROUNDS, rounds }) {
  const ask = (why) => ({ action: "hold", ask: `Owner: ${why} The one-round fix budget (ci.fix.max_rounds=${maxRounds}, ${rounds} used) is spent; decide the next step, then resume the release.` });
  if (lastPush) return ask(`a second push (${lastPush}) was already used on this head.`);
  if (onlyInfraFlakes(rec)) return { action: "rerun" };
  const regressed = failedBefore ? rec.ci.filter((j) => !failedBefore.includes(j.name)) : [];
  if (regressed.length) return { action: "revert" };
  const left = [...rec.ci.map((j) => `ci:${j.name}`), ...blockingOf(rec).review.map((f) => f.title), ...rec.guards.map((g) => `guard:${g.name}`)];
  return ask(`still failing after the fix and not an infra flake or a regression from it: ${left.slice(0, 5).join("; ") || "no failure recorded"}.`);
}

/** Mark the release HELD through the control path (best effort: the returned blocked result stops the run either way). */
export async function holdForOwner(ctx, ask) {
  try { await ctx.hold?.(ask); } catch { /* the blocked result below still stops the job */ }
  return { blocked: true, held: true, reason: ask };
}
