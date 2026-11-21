// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Merge train, phase 1 (#5823), behind forge.yaml `orchestration.merge_train: on` (default `off`).
 *
 * A lane started with `mergeTrain` ends `pr-ready` instead of polling CI once its PR is reviewed, pushed and waiting on
 * checks (lean.mjs `trainHandoff`), and the batch runner frees its slot. The runner keeps one entry per PR-ready issue
 * (persisted with the batch state as `train`) and calls `step(entry)` every `pollMs`; at most one PR per lane base merges
 * per tick. One `step` reads the PR once and does one thing (`trainVerdict`):
 *   - green and mergeable: merge at the reviewed head (`--match-head-commit`), then close the issue (`finishMerged`);
 *   - green but BEHIND (strict branch protection): `gh pr update-branch` (a merge commit, never a rebase), CI runs again;
 *   - a required (or DCO) check red: hand back `needs-human` `ci.red` with the failing checks, so the batch's recovery
 *     path requeues a fix lane; conflicting: `base.conflict`; a head nobody reviewed: `merge.head_mismatch`;
 *   - still pending past `maxWaitMin`: `ci-pending`, as a lane that waited would end.
 * No batching and no bisection yet (phase 2). All effects are injected, so the module is unit-testable.
 */
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { openPrBlockingClose } from "./orphan-pr.mjs";
import { clearPipelineLabels } from "./statuscomment.mjs";

export const MERGE_TRAIN_MARKER = "<!-- FORGE:MERGE_TRAIN -->";
export const TRAIN_POLL_MS = 60_000;
export const TRAIN_MAX_WAIT_MIN = 360; // lean's ciMaxMinutes default: the train waits no longer than a lane would have
export const TRAIN_MAX_SYNCS = 5; // update-branch syncs of one entry before it is handed back base.conflict
export const TRAIN_MAX_MERGE_RETRIES = 5;
// Checks that report on a PR but never gate its merge (the lane's own verify report, deploy gate, marker check).
const REPORT_ONLY = new Set(["forgedock/verify", "forge/deploy-gate", "Check for FORGE gate markers"]);
const OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const BAD = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PROTECTED_RE = /^(main|master|staging|develop|production|release\/.+|milestone\/.+)$/;

/** forge.yaml `orchestration.merge_train`: `on` (or true) turns it on; anything else is `off`. */
export const parseMergeTrain = (v) => (v === true || String(v ?? "").trim().toLowerCase() === "on" ? "on" : "off");

/** One statusCheckRollup entry as {name, state: success|failure|pending, url} (the effects.mjs checkStates mapping). */
export function checkOf(c) {
  const v = String(c?.conclusion || c?.state || "").toUpperCase();
  return { name: String(c?.name ?? c?.context ?? ""), state: OK.has(v) ? "success" : BAD.has(v) ? "failure" : "pending", url: c?.detailsUrl || c?.targetUrl || null };
}

const sameSha = (a, b) => Boolean(a && b) && (String(a).startsWith(String(b)) || String(b).startsWith(String(a)));

/**
 * Pure: the next action for one train entry given `view` (gh pr view: state, mergeable, mergeStateStatus, headRefOid,
 * statusCheckRollup). `entry`: {pr, head, required: [names], policy: required|all, since (ms)}.
 * Returns {action, failed?, detail?}; action is one of merged-elsewhere | closed | head-moved | conflict | red | update-branch | merge | timeout | wait.
 */
export function trainVerdict(view, entry, { now = Date.now(), maxWaitMin = TRAIN_MAX_WAIT_MIN } = {}) {
  const state = String(view?.state ?? "").toUpperCase();
  if (state === "MERGED") return { action: "merged-elsewhere" };
  if (state === "CLOSED") return { action: "closed" };
  if (!sameSha(view?.headRefOid, entry.head)) return { action: "head-moved", detail: `PR head ${String(view?.headRefOid ?? "?").slice(0, 12)} is not the reviewed head ${String(entry.head ?? "?").slice(0, 12)}` };
  const m = String(view?.mergeable ?? "").toUpperCase(), ms = String(view?.mergeStateStatus ?? "").toUpperCase();
  if (m === "CONFLICTING" || ms === "DIRTY") return { action: "conflict" };
  const checks = (Array.isArray(view?.statusCheckRollup) ? view.statusCheckRollup : []).map(checkOf);
  const gating = entry.policy === "all" ? checks.filter((c) => !REPORT_ONLY.has(c.name)) : checks.filter((c) => (entry.required ?? []).includes(c.name));
  const dco = checks.filter((c) => /\bdco\b/i.test(c.name) && c.state === "failure"); // #4651: a red DCO blocks the release PR too
  const failed = [...gating.filter((c) => c.state === "failure"), ...dco.filter((c) => !gating.includes(c))];
  if (failed.length) return { action: "red", failed };
  const names = entry.policy === "all" ? gating.map((c) => c.name) : (entry.required ?? []);
  const green = names.length > 0 && names.every((n) => gating.some((c) => c.name === n && c.state === "success")) && gating.every((c) => c.state === "success");
  if (green) return { action: ms === "BEHIND" ? "update-branch" : "merge" };
  if (now - Number(entry.since ?? now) >= maxWaitMin * 60000) return { action: "timeout" };
  return { action: "wait" };
}

/**
 * After the merge: issue comment, close (completed, unless another own PR is open), workflow:merged, pipeline labels off,
 * lane branch deleted on origin unless protected or another open PR is based on it. Every step is best effort.
 * Returns {sha, mergedTo}.
 */
export async function finishMerged({ gh, transitionLabel = null, repo, issue, entry, branch, waitedMin = 0 }) {
  let sha = null;
  try { sha = JSON.parse(String(await gh(["pr", "view", String(entry.pr), "-R", repo, "--json", "mergeCommit"])) || "{}").mergeCommit?.oid ?? null; } catch { sha = null; }
  const body = `${MERGE_TRAIN_MARKER}\n## Merged by the merge train\nPR #${entry.pr} merged${sha ? ` as \`${String(sha).slice(0, 12)}\`` : ""} into \`${entry.lane ?? "its base"}\` after ${waitedMin} min in the train (base-syncs: ${entry.syncs ?? 0}). The lane released its slot at PR-ready (#5823).`;
  try { await gh(["issue", "comment", String(issue), "-R", repo, "--body", body]); } catch { /* best effort */ }
  try { if (!(await openPrBlockingClose({ repo, io: { gh }, issue, exceptPr: entry.pr })).length) await gh(["issue", "close", String(issue), "-R", repo, "--reason", "completed"]); } catch { /* best effort */ }
  try { await transitionLabel?.(issue, "merged"); } catch { /* best effort */ }
  await clearPipelineLabels({ gh, repo, issue });
  if (branch && !PROTECTED_RE.test(branch) && branch !== entry.lane && !(entry.defaults ?? []).includes(branch)) {
    try {
      const open = JSON.parse(String(await gh(["pr", "list", "-R", repo, "--base", branch, "--state", "open", "--json", "number"])) || "[]");
      if (!open.length) await gh(["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${branch}`]);
    } catch { /* already gone, or kept: the orphan sweep handles it */ }
  }
  return { sha, mergedTo: sha && entry.lane ? { lane: entry.lane, pr: entry.pr, sha } : null };
}

/**
 * The train for one batch. `gh(args)` -> stdout; `hold(entry)` -> {held, reason} (release merge hold, #5709; optional).
 * `step(entry)` returns {state: "wait", update?} | {state: "merged", mergedTo, detail, update?} |
 * {state: "handback", outcome, code?, detail, update?}. It never throws: an unreadable PR is a wait.
 */
export function makeMergeTrain({ gh, repo, transitionLabel = null, hold = null, now = () => Date.now(), pollMs = TRAIN_POLL_MS, maxWaitMin = TRAIN_MAX_WAIT_MIN }) {
  const waited = (e) => Math.round((now() - Number(e.since ?? now())) / 6000) / 10;
  const merged = async (e, view, how) => {
    const f = await finishMerged({ gh, transitionLabel, repo, issue: e.issue, entry: e, branch: view?.headRefName ?? null, waitedMin: waited(e) });
    return { state: "merged", mergedTo: f.mergedTo, detail: `PR #${e.pr} ${how}${f.sha ? ` (${String(f.sha).slice(0, 12)})` : ""}` };
  };
  async function step(e) {
    let view;
    try { view = JSON.parse(String(await gh(["pr", "view", String(e.pr), "-R", repo, "--json", "state,mergeable,mergeStateStatus,headRefOid,headRefName,statusCheckRollup"])) || "{}"); } catch { return { state: "wait" }; }
    const v = trainVerdict(view, e, { now: now(), maxWaitMin });
    const back = (outcome, code, detail) => ({ state: "handback", outcome, ...(code ? { code } : {}), detail });
    switch (v.action) {
      case "merged-elsewhere": return await merged(e, view, "was merged outside the train");
      case "closed": return back("needs-human", null, `PR #${e.pr} was closed while in the merge train; nothing merged.`);
      case "head-moved": return back("needs-human", OUTCOME_CODES.MERGE_HEAD_MISMATCH, `${v.detail} on PR #${e.pr}; the train never merges an unreviewed head.`);
      case "conflict": return back("needs-human", OUTCOME_CODES.BASE_CONFLICT, `PR #${e.pr} conflicts with ${e.lane ?? "its base"} in the merge train; nothing merged.`);
      case "red": return back("needs-human", OUTCOME_CODES.CI_RED, `Required check(s) failed on PR #${e.pr} at ${String(e.head).slice(0, 12)} in the merge train: ${v.failed.map((c) => `${c.name}${c.url ? ` (${c.url})` : ""}`).join(", ")}; nothing merged.`);
      case "timeout": return back("ci-pending", null, `PR #${e.pr} still waiting on CI after ${maxWaitMin} min in the merge train`);
      case "wait": return { state: "wait" };
      case "update-branch": {
        if ((e.syncs ?? 0) >= TRAIN_MAX_SYNCS) return back("needs-human", OUTCOME_CODES.BASE_CONFLICT, `PR #${e.pr} still behind ${e.lane ?? "its base"} after ${e.syncs} train base-syncs; nothing merged.`);
        try { await gh(["pr", "update-branch", String(e.pr), "-R", repo]); } catch (err) {
          const msg = String(err?.stderr ?? err?.message ?? err);
          if (/conflict/i.test(msg)) return back("needs-human", OUTCOME_CODES.BASE_CONFLICT, `PR #${e.pr} could not be updated from ${e.lane ?? "its base"} (conflict); nothing merged.`);
          return { state: "wait" };
        }
        let head = e.head;
        try { head = JSON.parse(String(await gh(["pr", "view", String(e.pr), "-R", repo, "--json", "headRefOid"])) || "{}").headRefOid ?? e.head; } catch { /* next read hands it back head-moved */ }
        return { state: "wait", update: { head, syncs: (e.syncs ?? 0) + 1 } };
      }
      case "merge": {
        let h = null;
        try { h = hold ? await hold(e) : null; } catch { h = null; }
        if (h?.held) return { state: "wait", detail: h.reason };
        try { await gh(["pr", "merge", String(e.pr), "-R", repo, "--merge", "--match-head-commit", e.head]); } catch (err) {
          const msg = String(err?.stderr ?? err?.message ?? err);
          let after = null;
          try { after = JSON.parse(String(await gh(["pr", "view", String(e.pr), "-R", repo, "--json", "state"])) || "{}").state; } catch { after = null; }
          if (String(after ?? "").toUpperCase() === "MERGED") return await merged(e, view, "merged by the train (gh reported an error after the merge)");
          if (/not mergeable|merge conflict/i.test(msg)) return back("needs-human", OUTCOME_CODES.BASE_CONFLICT, `gh pr merge reported a conflict on PR #${e.pr}; nothing merged.`);
          const retries = (e.mergeRetries ?? 0) + 1;
          if (retries > TRAIN_MAX_MERGE_RETRIES) return back("ci-pending", null, `gh pr merge kept failing on PR #${e.pr} in the merge train: ${msg.split("\n")[0].slice(0, 200)}`);
          return { state: "wait", update: { mergeRetries: retries } };
        }
        return await merged(e, view, "merged by the train");
      }
      default: return { state: "wait" };
    }
  }
  return { pollMs, step };
}

/** Batch-report line (#5823): PRs the train merged or handed back, their wait in the train and base-syncs. Null without train rows. */
export function formatTrainSummary(rows) {
  const t = (rows ?? []).filter((r) => r?.train && typeof r.train === "object");
  const waiting = (rows ?? []).filter((r) => r?.outcome === "pr-ready").length;
  if (!t.length && !waiting) return null;
  const merged = t.filter((r) => r.train.result === "merged"), back = t.filter((r) => r.train.result !== "merged");
  const waits = merged.map((r) => Number(r.train.waited_min) || 0).sort((a, b) => a - b);
  const p50 = waits.length ? waits[Math.floor((waits.length - 1) / 2)] : null;
  const syncs = t.reduce((n, r) => n + (Number(r.train.syncs) || 0), 0);
  const byCode = {};
  for (const r of back) { const k = r.train.result === "needs-human" ? (r.code ?? "needs-human") : r.train.result; byCode[k] = (byCode[k] ?? 0) + 1; }
  return `merge train: ${merged.length} merged${p50 != null ? ` (train wait p50 ${p50} min)` : ""}, ${back.length} handed back${back.length ? ` (${Object.entries(byCode).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}, ${syncs} base-sync(s)${waiting ? `, ${waiting} still PR-ready (resume continues them)` : ""}`;
}
