// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// bin/lean/mergetrain.mjs — the phase-1 merge train (#5836, epic #5823), behind `orchestration.merge_train: off|on`.
// A lane whose reviewed PR has pending required checks ends `pr-ready` and frees its slot; the train, run by the batch
// runner (orchestrate.mjs), merges the green ones serially per base at the reviewed head. Red, conflicting and moved-head
// PRs are handed back as needs-human `ci.red` / `base.conflict` / `merge.head_mismatch` (in-batch recovery requeues a fix
// lane). No batching, no bisection. All I/O goes through the injected `gh`; state is plain JSON (batch state.json `train`).

import { clearPipelineLabels } from "./statuscomment.mjs";

const MERGED_LABEL = "workflow:merged";
const CONFLICT_RE = /not mergeable|merge conflict|conflict/i;
const HEAD_RE = /head branch was modified|match-head-commit|expected head|does not match/i;
const FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

const sameHead = (a, b) => Boolean(a) && Boolean(b) && (String(a).startsWith(String(b)) || String(b).startsWith(String(a)));

/** `[{name, state: success|failure|pending, url}]` from a `statusCheckRollup`. */
export function rollupStates(rollup) {
  return (rollup ?? []).map((c) => {
    const v = String(c.conclusion || c.state || "").toUpperCase();
    return { name: c.name ?? c.context, state: OK.has(v) ? "success" : FAIL.has(v) ? "failure" : "pending", url: c.detailsUrl || c.targetUrl || null };
  });
}

/** Required (or, with policy `all`, every) check state of a PR: {green, failed: [{name, url}]}. */
export function judgeChecks(states, { required = [], policy = "required" } = {}) {
  const watched = policy === "all" ? states : states.filter((s) => required.includes(s.name));
  const failed = watched.filter((s) => s.state === "failure").map((s) => ({ name: s.name, url: s.url }));
  const seen = new Set(watched.map((s) => s.name));
  const green = !failed.length && watched.every((s) => s.state === "success") && (policy === "all" ? watched.length > 0 : required.every((n) => seen.has(n)));
  return { green, failed };
}

/** Median (nearest rank) of a number list; null when empty. */
export const p50 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.ceil(s.length / 2) - 1] : null; };

/** The batch report line, or null when the train never held a PR. */
export function formatTrainSummary(stats) {
  if (!stats || (!stats.merged && !Object.keys(stats.handedBack ?? {}).length && !stats.syncs && !stats.waits?.length)) return null;
  const hb = Object.entries(stats.handedBack ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const total = hb.reduce((n, [, c]) => n + c, 0);
  const w = p50(stats.waits ?? []);
  return `merge train: merged ${stats.merged ?? 0}, handed back ${total}${hb.length ? ` (${hb.map(([k, c]) => `${k} ${c}`).join(", ")})` : ""}, wait p50 ${w === null ? "n/a" : `${(w / 60000).toFixed(1)} min`}, base-syncs ${stats.syncs ?? 0}`;
}

/**
 * @param {object} o
 * @param {(args: string[]) => Promise<string>} o.gh   gh runner (stdout)
 * @param {string} o.repo
 * @param {() => number} [o.now]
 * @param {object|null} [o.saved]  a prior `snapshot()` (resume)
 */
export function createMergeTrain({ gh, repo, now = () => Date.now(), saved = null }) {
  const entries = new Map((saved?.entries ?? []).map((e) => [e.issue, { ...e }]));
  const stats = { merged: saved?.stats?.merged ?? 0, handedBack: { ...(saved?.stats?.handedBack ?? {}) }, waits: [...(saved?.stats?.waits ?? [])], syncs: saved?.stats?.syncs ?? 0 };

  const handBack = (e, code, detail) => {
    entries.delete(e.issue);
    stats.handedBack[code] = (stats.handedBack[code] ?? 0) + 1;
    return { kind: "handback", issue: e.issue, pr: e.pr, code, detail, entry: e };
  };
  const landed = (e, detail) => {
    entries.delete(e.issue);
    stats.merged += 1;
    stats.waits.push(Math.max(0, now() - e.since));
    return { kind: "merged", issue: e.issue, pr: e.pr, detail, entry: e };
  };

  /** The lane's post-merge steps for a plain merge: close the issue, `workflow:merged`, delete the branch (all best effort). */
  async function postMerge(e) {
    try { await gh(["issue", "close", String(e.issue), "-R", repo, "--reason", "completed"]); } catch { /* the issue stays open for the sweep */ }
    await clearPipelineLabels({ gh, repo, issue: e.issue });
    try { await gh(["issue", "edit", String(e.issue), "-R", repo, "--add-label", MERGED_LABEL]); } catch { /* best effort */ }
    if (e.branch) { try { await gh(["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${e.branch}`]); } catch { /* already gone */ } }
  }

  /** One poll: at most one merge per base; returns the events (merged / handback) it produced. */
  async function tick() {
    const events = [];
    const baseBusy = new Set();
    for (const e of [...entries.values()]) {
      let v;
      try { v = JSON.parse(String(await gh(["pr", "view", String(e.pr), "-R", repo, "--json", "state,headRefOid,headRefName,mergeable,mergeStateStatus,baseRefName,statusCheckRollup"]))); } catch { continue; } // unreadable: next poll
      if (v.headRefName) e.branch = v.headRefName;
      if (v.state === "MERGED") { events.push(landed(e, `PR #${e.pr} merged outside the train`)); continue; }
      if (v.state === "CLOSED") { events.push(handBack(e, "pr.closed", `PR #${e.pr} was closed without merging`)); continue; }
      if (!sameHead(v.headRefOid, e.head)) {
        events.push(handBack(e, "merge.head_mismatch", `PR #${e.pr} head moved to ${String(v.headRefOid).slice(0, 12)} after review at ${String(e.head).slice(0, 12)}; refusing to merge an unreviewed head.`));
        continue;
      }
      if (v.mergeable === "CONFLICTING") { events.push(handBack(e, "base.conflict", `PR #${e.pr} conflicts with ${v.baseRefName ?? e.lane}`)); continue; }
      const { green, failed } = judgeChecks(rollupStates(v.statusCheckRollup), e);
      if (failed.length) {
        events.push(handBack(e, "ci.red", `Required CI failed on PR #${e.pr}:\n${failed.map((f) => `- ${f.name}${f.url ? ` ${f.url}` : ""}`).join("\n")}`));
        continue;
      }
      if (!green) continue;
      const base = v.baseRefName ?? e.lane ?? "";
      if (baseBusy.has(base)) continue; // one merge or sync per base per poll
      if (v.mergeStateStatus === "BEHIND") {
        baseBusy.add(base);
        try {
          await gh(["pr", "update-branch", String(e.pr), "-R", repo]);
          stats.syncs += 1;
          e.head = null; // the update moves the head: adopt the new one next poll, after its checks restart
          try { e.head = JSON.parse(String(await gh(["pr", "view", String(e.pr), "-R", repo, "--json", "headRefOid"]))).headRefOid ?? null; } catch { /* adopted below */ }
          if (!e.head) e.head = v.headRefOid;
        } catch { /* a conflict shows on the next poll's mergeable */ }
        continue;
      }
      baseBusy.add(base);
      try {
        await gh(["pr", "merge", String(e.pr), "-R", repo, "--merge", "--match-head-commit", e.head]);
      } catch (err) {
        const msg = `${err?.stderr ?? ""}${err?.message ?? ""}`;
        try { if (JSON.parse(String(await gh(["pr", "view", String(e.pr), "-R", repo, "--json", "state"]))).state === "MERGED") { await postMerge(e); events.push(landed(e, `PR #${e.pr} merged`)); continue; } } catch { /* fall through */ }
        if (HEAD_RE.test(msg)) events.push(handBack(e, "merge.head_mismatch", `gh pr merge refused PR #${e.pr}: the head is not the reviewed ${String(e.head).slice(0, 12)}`));
        else if (CONFLICT_RE.test(msg)) events.push(handBack(e, "base.conflict", `gh pr merge reported a conflict on PR #${e.pr}`));
        continue; // transient or policy-blocked: retried next poll
      }
      await postMerge(e);
      events.push(landed(e, `PR #${e.pr} merged by the train at ${String(e.head).slice(0, 12)}`));
    }
    return events;
  }

  return {
    /** A lane's `pr-ready` result: `{issue, pr, head, required, policy, lane, milestone?}`. */
    add(r) { entries.set(r.issue, { issue: r.issue, pr: r.pr, head: r.head, required: r.required ?? [], policy: r.policy ?? "required", lane: r.lane ?? null, ...(r.milestone ? { milestone: r.milestone } : {}), since: now() }); },
    drop(issue) { entries.delete(issue); },
    /** Resume: replace the held PRs and the counters with a prior `snapshot()`. */
    restore(snap) {
      entries.clear();
      for (const e of snap?.entries ?? []) entries.set(e.issue, { ...e });
      stats.merged = snap?.stats?.merged ?? 0; stats.handedBack = { ...(snap?.stats?.handedBack ?? {}) }; stats.waits = [...(snap?.stats?.waits ?? [])]; stats.syncs = snap?.stats?.syncs ?? 0;
    },
    has: (issue) => entries.has(issue),
    size: () => entries.size,
    tick,
    stats: () => ({ merged: stats.merged, handedBack: { ...stats.handedBack }, waits: [...stats.waits], syncs: stats.syncs }),
    snapshot: () => ({ entries: [...entries.values()], stats: { ...stats, handedBack: { ...stats.handedBack }, waits: [...stats.waits] } }),
  };
}
