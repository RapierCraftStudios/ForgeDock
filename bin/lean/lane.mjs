// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lane resolution for core work-on (#4125). The lane (base and merge branch) comes from the issue, not the caller:
 * a milestone maps to forge.yaml `branches.feature_pattern` with `{slug}` from the milestone title, otherwise
 * `branches.staging`. A requested `--lane` is an assertion; the default/production branch is never a lane; the branch
 * must exist on origin. Every failure is fail-closed with a typed `lane.*` code. Reads are injected through `io`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseForgeYaml } from "../forge-utils.mjs";
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";

/** The documented forge.yaml conventions (forge.yaml.example, scripts/classify-lane.sh); always verified on origin. */
export const DEFAULT_STAGING_BRANCH = "staging";
export const DEFAULT_FEATURE_PATTERN = "milestone/{slug}";
const LANE_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** Same slug as scripts/classify-lane.sh: lowercase, spaces to hyphens, keep [a-z0-9-], collapse and trim hyphens. */
export function milestoneSlug(title) {
  return String(title ?? "").toLowerCase().replace(/ /g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** forge.yaml `branches` from the checkout: {default, staging, featurePattern}; missing keys are null. */
export function readBranches(cwd = process.cwd()) {
  let b = {};
  try { b = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.branches ?? {}; } catch { b = {}; }
  const s = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return { default: s(b.default), staging: s(b.staging), featurePattern: s(b.feature_pattern) };
}

/** True when `lane` is one of the default (production) branches. */
export function isDefaultLane(lane, defaults) {
  return !!lane && (defaults ?? []).includes(lane);
}

/** The repo's default branches: forge.yaml `branches.default` plus GitHub's default branch. Throws when GitHub's is unreadable. */
export async function defaultBranches({ repo, io, branches = {} }) {
  const gh = String(await io.gh(["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])).trim();
  if (!gh) throw new Error("GitHub reported no default branch");
  return [...new Set([branches.default, gh].filter(Boolean))];
}

/** #4963: one batch's shared lookups: the default branches once, `ls-remote` once per lane. Failures are evicted, so a retry re-reads. */
export function makeLaneCache() { return new Map(); }
const once = (cache, key, load, keep = () => true) => {
  let p = cache.get(key);
  if (!p) {
    p = Promise.resolve().then(load);
    cache.set(key, p);
    p.then((v) => { if (!keep(v) && cache.get(key) === p) cache.delete(key); }, () => { if (cache.get(key) === p) cache.delete(key); });
  }
  return p;
};

/**
 * `cache` (makeLaneCache) shares the default-branch and ls-remote reads across issues; `milestone` (a title, or null for none)
 * is a pre-read value that skips the per-issue `gh issue view`; undefined reads it.
 * @returns {Promise<{ok:true, lane:string, expected:string, milestone:?string, overridden:boolean, defaults:string[]}
 *   | {ok:false, code:string, detail:string}>}
 */
export async function resolveLane({ issue, repo, io, cwd, branches = {}, requested = null, override = false, cache = null, milestone: known }) {
  const refuse = (code, detail) => ({ ok: false, code, detail });
  const transient = (detail) => ({ ...refuse(OUTCOME_CODES.LANE_UNRESOLVED, detail), transient: true }); // #4791: a gh/git command failed; retry
  const staging = branches.staging || DEFAULT_STAGING_BRANCH;
  const pattern = branches.featurePattern || DEFAULT_FEATURE_PATTERN;
  if (!pattern.includes("{slug}")) return refuse(OUTCOME_CODES.LANE_UNRESOLVED, `forge.yaml branches.feature_pattern "${pattern}" has no {slug}`);
  let milestone = null, defaults;
  try {
    if (known !== undefined) milestone = known || null;
    else milestone = JSON.parse(String(await io.gh(["issue", "view", String(issue), "-R", repo, "--json", "milestone"])))?.milestone?.title || null;
  } catch (e) { return transient(`cannot read the milestone of #${issue}: ${String(e?.message ?? e).slice(0, 200)}`); }
  try {
    defaults = cache ? await once(cache, "default-branches", () => defaultBranches({ repo, io, branches })) : await defaultBranches({ repo, io, branches });
  } catch (e) {
    return transient(`cannot read the default branch of ${repo}: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  let expected = staging;
  if (milestone) {
    const slug = milestoneSlug(milestone);
    if (!slug) return refuse(OUTCOME_CODES.LANE_UNRESOLVED, `milestone "${milestone}" gives an empty branch slug; rename it to include ASCII letters or digits`);
    expected = pattern.replace("{slug}", slug);
  }
  const why = milestone ? `milestone "${milestone}"` : "no milestone (branches.staging)";
  if (isDefaultLane(requested, defaults)) {
    return refuse(OUTCOME_CODES.LANE_DEFAULT_BRANCH, `--lane ${requested} is the default branch; the core path never targets it (promotion is a human-merged release PR). #${issue} belongs on ${expected} (${why})`);
  }
  if (isDefaultLane(expected, defaults)) {
    return refuse(OUTCOME_CODES.LANE_DEFAULT_BRANCH, `#${issue} resolves to ${expected} (${why}), which is the default branch; set forge.yaml branches.staging to a non-default branch`);
  }
  let lane = expected, overridden = false;
  if (requested && requested !== expected) {
    if (!override) return refuse(OUTCOME_CODES.LANE_MISMATCH, `--lane ${requested} does not match #${issue}'s lane ${expected} (${why}); omit --lane, or pass --lane-override to force it`);
    lane = requested; overridden = true;
  }
  if (!LANE_RE.test(lane) || lane.includes("..")) return refuse(OUTCOME_CODES.LANE_UNRESOLVED, `invalid lane ${JSON.stringify(lane)}`);
  let out;
  const lsRemote = () => io.git(["ls-remote", "--heads", "origin", `refs/heads/${lane}`], { cwd });
  try { out = String(cache ? await once(cache, `lane:${lane}`, async () => String(await lsRemote()), (v) => v.trim() !== "") : await lsRemote()); } catch (e) {
    return transient(`cannot check origin for ${lane}: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  if (!out.trim()) return refuse(OUTCOME_CODES.LANE_BRANCH_MISSING, `lane branch ${lane} (${why}) does not exist on origin; create it first (e.g. /milestone start) or fix the milestone title`);
  return { ok: true, lane, expected, milestone, overridden, defaults };
}

/**
 * #4593: true when `lane` is a non-staging branch fully merged into `staging` by a merge commit (a shipped milestone branch).
 * Fail closed: any git error (no such ref, offline) is "not shipped".
 */
export async function isShippedLane({ lane, staging = DEFAULT_STAGING_BRANCH, io, cwd }) {
  if (!lane || lane === staging) return false;
  try {
    try { await io.git(["fetch", "origin", lane, staging], { cwd }); } catch { /* offline: use the local refs */ }
    await io.git(["merge-base", "--is-ancestor", `origin/${lane}`, `origin/${staging}`], { cwd });
    // #4623: an unused lane cut from staging is trivially an ancestor; shipped also needs a merge commit that took the lane tip.
    const tip = String(await io.git(["rev-parse", `origin/${lane}`], { cwd })).trim();
    const merges = String(await io.git(["rev-list", "--merges", "--parents", `origin/${staging}`, `^origin/${lane}`], { cwd }));
    return !!tip && merges.split("\n").some((l) => l.trim().split(/\s+/).slice(2).includes(tip));
  } catch { return false; }
}
