// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Merge-back after a fast lane (#5566, epic #5549 Phase 4; design 6.7 point 6, risks R3 R4): once a p0 or train has landed on the
 * default branch, sync it back into the integration branch through a sync PR (merge commit, never squash). Staging has no CI by
 * policy, so a conflicted sync must not land unvalidated code: the PR gets the review panel plus a targeted preflight over the
 * recorded target set (every conflict file and every file the lane changed), and `syncBlocksRelease` holds `release start` for
 * lane `release` until it is merged and green. Facts (target set, hunk overlap, stale milestones) are deterministic git/gh reads.
 * Every effect goes through `io` (`git`, `gh`, `api`); with `release.managed` off nothing is read or written.
 */
import { DEFAULT_STAGING_BRANCH } from "./lane.mjs";
import { recordSync } from "./release-ledger.mjs";
import { setIntake } from "./intake.mjs";
import { reviewStep } from "./release-review.mjs";
import { runTargetedPreflight } from "./release-preflight.mjs";

export const SYNC_BOUNDS = { pollMs: 10_000, mergePolls: 30 };
export const HAZARD = "stale-vs-main: this milestone branch predates the sync; a later squash merge of it can drop or re-apply lane changes (squash/ancestry hazard); merge the integration branch into it first";
const json = (s) => JSON.parse(String(s || "null"));
const uniq = (a) => [...new Set(a)];

/** A sync is blocked until it is merged and green: conflicted, unreviewed, or a preflight that does not cover the target set is unvalidated. */
export function syncValidated(sync) {
  if (!sync) return false;
  const covered = new Set(sync.preflight?.covered ?? []);
  return !sync.conflicted && sync.preflight?.ok === true && (sync.target ?? []).every((f) => covered.has(f)) && sync.review?.ok === true;
}

/**
 * `release start` for lane `release` is held while a recorded sync is conflicted, unvalidated or unmerged; trains and p0 are never
 * blocked. `state` is the ledger `_active` view (or the sync record itself). @returns {boolean}
 */
export function syncBlocksRelease(state, lane = state?.lane ?? "release") {
  if (lane !== "release") return false;
  const sync = state?.sync ?? (state?.target ? state : null);
  if (!sync) return false;
  return !(sync.merged === true && syncValidated(sync));
}

/** Old-side line ranges per file from a `-U0` unified diff: `{file: [[start, end], ...]}`. */
export function diffRanges(diff) {
  const out = {};
  let file = null;
  for (const line of String(diff ?? "").split("\n")) {
    const f = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (f) { file = f[1] === "/dev/null" ? null : f[1]; continue; }
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (m && file) { const s = Number(m[1]), n = m[2] === undefined ? 1 : Number(m[2]); (out[file] ??= []).push([s, s + Math.max(n, 1) - 1]); }
  }
  return out;
}

/** Open PRs whose hunks overlap a lane hunk (same file, intersecting line range). @returns {{pr, files}[]} */
export function duplicateFixes(laneHunks, prs) {
  const hits = [];
  for (const p of prs) {
    const files = Object.keys(p.hunks ?? {}).filter((f) => (laneHunks[f] ?? []).some(([a, b]) => p.hunks[f].some(([c, d]) => a <= d && c <= b)));
    if (files.length) hits.push({ pr: p.number, files });
  }
  return hits;
}

/** Every conflict file and every lane-changed file; recorded on the sync. */
export const targetSet = ({ conflicts = [], changed = [] }) => uniq([...conflicts, ...changed]).sort();

const probe = (io, staging, def) => {
  try { io.git(["merge-tree", "--write-tree", "--name-only", `origin/${staging}`, `origin/${def}`]); return { conflicted: false, files: [] }; } catch (e) {
    const text = `${e?.stdout ?? ""}\n${e?.message ?? ""}`;
    const files = uniq([...text.matchAll(/Merge conflict in (.+)/g)].map((m) => m[1].trim()));
    return { conflicted: true, files };
  }
};

/** Open `milestone/<slug>` branches, each marked stale-vs-main with the squash/ancestry hazard. */
export function staleMilestones(io) {
  let out = ""; try { out = io.git(["ls-remote", "--heads", "origin", "milestone/*"]); } catch { out = ""; }
  return String(out).split("\n").map((l) => /refs\/heads\/(milestone\/\S+)/.exec(l)?.[1]).filter(Boolean).map((branch) => ({ branch, status: "stale-vs-main", note: HAZARD }));
}

async function openOrReuse({ io, repo, def, staging }) {
  const open = json(await io.gh(["pr", "list", "--repo", repo, "--head", def, "--base", staging, "--state", "open", "--json", "number"])) ?? [];
  if (open[0]) return open[0].number;
  const body = `Merge-back of \`${def}\` into \`${staging}\` after a fast lane landed (#5566). Merge with a merge commit; squash is refused. The review panel and a targeted preflight over the recorded target set must pass before it merges.`;
  const out = String(await io.gh(["pr", "create", "--repo", repo, "--base", staging, "--head", def, "--title", `sync: merge ${def} into ${staging}`, "--body", body]));
  return Number(/\/pull\/(\d+)/.exec(out)?.[1]) || null;
}

const defaultReview = async (ctx, pr) => {
  const r = await reviewStep({ ...ctx, state: { ...(ctx.state ?? {}), steps: { "release-pr": { result: { pr } } } }, save: () => {} });
  return { ok: !r?.blocked && !r?.refused && !r?.stopped, verdict: r?.verdict ?? null };
};

/**
 * The SYNCING step. `ctx`: {io, repo, def, staging?, config: {managed, preflight?}, policy?: {merge: {method}}, state?, actor?, release?,
 * review?, preflight?, recordSync?, setIntake?}; `args`: {lane}. Unmanaged: `{skipped: true}` with no io call.
 * @returns {Promise<{skipped?: true, refused?: string, pr, conflicted, target, duplicates, milestones, validated, merged, blocks}>}
 */
export async function syncStep(ctx, { lane = "p0" } = {}) {
  if (!ctx.config?.managed) return { skipped: true };
  const { io, repo, def } = ctx;
  const staging = ctx.staging ?? DEFAULT_STAGING_BRANCH;
  const method = ctx.policy?.merge?.method ?? "merge-commit";
  if (method === "squash") return { refused: "merge-back refuses merge.method squash: a squash drops the default branch from the ancestry and re-conflicts the next sync (R4); use merge-commit" };
  const L = { recordSync, setIntake, ...(ctx.ledger ?? {}) };
  const lctx = io.api ? { io, repo, credential: "driver" } : null;
  const record = ctx.recordSync ?? (lctx ? (r) => L.recordSync(lctx, r, io.now?.()) : async () => null);
  const intake = ctx.setIntake ?? (io.api ? (p) => L.setIntake({ io, repo, by: ctx.actor ?? "engine", release: ctx.release ?? null, ...p }) : async () => null);

  await intake({ paused: true, reason: `merge-back ${def} -> ${staging} (${lane})` });
  try { io.git(["fetch", "--quiet", "origin", staging, def]); } catch { /* best effort */ }
  const p = probe(io, staging, def);
  let changed = [], laneHunks = {};
  try { changed = String(io.git(["diff", "--name-only", `origin/${staging}...origin/${def}`])).split("\n").filter(Boolean); laneHunks = diffRanges(io.git(["diff", "-U0", `origin/${staging}...origin/${def}`])); } catch { /* unreadable: the target keeps the conflict files */ }
  const target = targetSet({ conflicts: p.files, changed });
  const pr = await openOrReuse({ io, repo, def, staging });
  const head = (() => { try { return String(io.git(["rev-parse", `origin/${def}`])).trim(); } catch { return null; } })();

  const review = await (ctx.review ?? defaultReview)(ctx, pr);
  const pre = await (ctx.preflight ?? runTargetedPreflight)(ctx, { head, pr, target });
  const prs = json(await io.gh(["pr", "list", "--repo", repo, "--base", staging, "--state", "open", "--json", "number,headRefName"])) ?? [];
  const others = [];
  for (const o of prs.filter((x) => x.headRefName !== def && x.number !== pr)) others.push({ number: o.number, hunks: diffRanges(await io.gh(["pr", "diff", String(o.number), "--repo", repo])) });
  const sync = { lane, pr, def, staging, conflicted: p.conflicted, target, review: { ok: !!review?.ok, verdict: review?.verdict ?? null }, preflight: { ok: !!pre?.ok, covered: pre?.covered ?? [], head }, duplicates: duplicateFixes(laneHunks, others), milestones: staleMilestones(io), merged: false };
  sync.validated = syncValidated(sync);
  await record(sync);
  return { ...sync, blocks: syncBlocksRelease({ sync, lane: "release" }) };
}

/** Merge a validated sync PR with a merge commit, record it, and release the intake pause. A conflicted or unvalidated sync stays open and paused. */
export async function finishSync(ctx, sync) {
  if (!ctx.config?.managed) return { skipped: true };
  const { io, repo } = ctx;
  if (!syncValidated(sync)) return { merged: false, why: sync?.conflicted ? "sync is conflicted; resolve it and rerun the preflight" : "sync is unvalidated: review and a preflight covering the target set must be green" };
  const b = { ...SYNC_BOUNDS, ...(ctx.config.syncBounds ?? {}) };
  await io.gh(["pr", "merge", String(sync.pr), "--repo", repo, "--merge"]);
  let state = null;
  for (let i = 0; i < b.mergePolls; i++) {
    state = json(await io.gh(["pr", "view", String(sync.pr), "--repo", repo, "--json", "state"]))?.state;
    if (state === "MERGED") break;
    await io.sleep?.(b.pollMs);
  }
  if (state !== "MERGED") return { merged: false, why: `sync PR #${sync.pr} is ${state ?? "unreadable"}, not merged` };
  const lctx = io.api ? { io, repo, credential: "driver" } : null;
  const done = { ...sync, merged: true };
  await (ctx.recordSync ?? (lctx ? (r) => (ctx.ledger?.recordSync ?? recordSync)(lctx, r, io.now?.()) : async () => null))(done);
  await (ctx.setIntake ?? (io.api ? (p) => (ctx.ledger?.setIntake ?? setIntake)({ io, repo, by: ctx.actor ?? "engine", ...p }) : async () => null))({ paused: false });
  return { merged: true, sync: done };
}
