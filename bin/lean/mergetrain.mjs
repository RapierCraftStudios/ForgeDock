// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// bin/lean/mergetrain.mjs — the phase-1 merge train (#5836, epic #5823), behind `orchestration.merge_train: off|on`.
// A lane whose reviewed PR has pending required checks ends `pr-ready` and frees its slot; the train, run by the batch
// runner (orchestrate.mjs), merges the green ones serially per base at the reviewed head. Red, conflicting and moved-head
// PRs are handed back as needs-human `ci.red` / `base.conflict` / `merge.head_mismatch` (in-batch recovery requeues a fix
// lane). No batching, no bisection. All I/O goes through the injected `gh`; state is plain JSON (batch state.json `train`).

import { closeMergedIssue } from "./lean.mjs";

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
  if (!stats || (!stats.merged && !Object.keys(stats.handedBack ?? {}).length && !stats.syncs && !stats.batches && !stats.waits?.length)) return null;
  const hb = Object.entries(stats.handedBack ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const total = hb.reduce((n, [, c]) => n + c, 0);
  const w = p50(stats.waits ?? []);
  return `merge train: merged ${stats.merged ?? 0}, handed back ${total}${hb.length ? ` (${hb.map(([k, c]) => `${k} ${c}`).join(", ")})` : ""}, wait p50 ${w === null ? "n/a" : `${(w / 60000).toFixed(1)} min`}, base-syncs ${stats.syncs ?? 0}${stats.batches ? `, batches ${stats.batches}, candidate CI runs ${stats.candidateRuns ?? 0}${stats.candidateRed ? ` (${stats.candidateRed} red)` : ""}` : ""}`;
}

/**
 * @param {object} o
 * @param {(args: string[]) => Promise<string>} o.gh   gh runner (stdout)
 * @param {string} o.repo
 * @param {() => number} [o.now]
 * @param {object|null} [o.saved]  a prior `snapshot()` (resume)
 * @param {number} [o.batchSize]  #5837: PRs per candidate batch (1 = the serial phase-1 train)
 * @param {string|null} [o.dispatch]  workflow file to `workflow_dispatch` on the candidate (else the repo's push trigger runs CI)
 */
export function createMergeTrain({ gh, repo, now = () => Date.now(), saved = null, batchSize = 1, dispatch = null, batchTimeoutMs = 90 * 60000 }) {
  const entries = new Map((saved?.entries ?? []).map((e) => [e.issue, { ...e }]));
  const stats = { merged: saved?.stats?.merged ?? 0, handedBack: { ...(saved?.stats?.handedBack ?? {}) }, waits: [...(saved?.stats?.waits ?? [])], syncs: saved?.stats?.syncs ?? 0, batches: saved?.stats?.batches ?? 0, candidateRuns: saved?.stats?.candidateRuns ?? 0, candidateRed: saved?.stats?.candidateRed ?? 0 };
  const batches = (saved?.batches ?? []).map((b) => ({ ...b, prs: b.prs.map((p) => ({ ...p })) })); // [{id, base, baseSha, prs, candidate, state}]
  let batchSeq = 0;

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

  const postMerge = (e) => closeMergedIssue({ gh, repo, issue: e.issue, branch: e.branch }); // the lane's shared post-merge helper

  const ref = (b) => `repos/${repo}/git/refs/heads/${b}`;
  const json = async (args) => JSON.parse(String(await gh(args)));
  const dropRef = async (b) => { try { await gh(["api", "-X", "DELETE", ref(b.candidate)]); } catch { /* already gone */ } };
  const endBatch = async (b) => { await dropRef(b); const i = batches.indexOf(b); if (i >= 0) batches.splice(i, 1); };
  const inBatch = (issue) => batches.some((b) => b.prs.some((p) => p.issue === issue));
  /** A member leaves its batch (landed or handed back): a validating batch no longer matches its candidate, so it dissolves. */
  const leaveBatch = async (issue) => {
    const b = batches.find((x) => x.prs.some((p) => p.issue === issue)); if (!b) return;
    b.prs = b.prs.filter((p) => p.issue !== issue);
    if (b.state === "validating" || !b.prs.length) await endBatch(b);
  };

  /** Merge one PR at its reviewed head: "merged" | "handed" | "kept" (transient or protection refusal: retried next poll). */
  async function mergeOne(e, events) {
    try {
      await gh(["pr", "merge", String(e.pr), "-R", repo, "--merge", "--match-head-commit", e.head]);
    } catch (err) {
      const msg = `${err?.stderr ?? ""}${err?.message ?? ""}`;
      try { if (JSON.parse(String(await gh(["pr", "view", String(e.pr), "-R", repo, "--json", "state"]))).state === "MERGED") { await postMerge(e); events.push(landed(e, `PR #${e.pr} merged`)); return "merged"; } } catch { /* fall through */ }
      if (HEAD_RE.test(msg)) { events.push(handBack(e, "merge.head_mismatch", `gh pr merge refused PR #${e.pr}: the head is not the reviewed ${String(e.head).slice(0, 12)}`)); return "handed"; }
      if (CONFLICT_RE.test(msg)) { events.push(handBack(e, "base.conflict", `gh pr merge reported a conflict on PR #${e.pr}`)); return "handed"; }
      return "kept";
    }
    await postMerge(e);
    events.push(landed(e, `PR #${e.pr} merged by the train at ${String(e.head).slice(0, 12)}`));
    return "merged";
  }

  /** Build `forge-train/<base>/<id>` by merging the PRs (FIFO) onto the base tip; a conflicting PR is handed back and the rest go on. */
  async function build(base, group, events) {
    const baseSha = (await json(["api", `repos/${repo}/git/ref/heads/${base}`])).object?.sha;
    if (!baseSha) return;
    const id = `${now().toString(36)}-${batchSeq++}`;
    const b = { id, base, baseSha, prs: [], candidate: `forge-train/${base}/${id}`, state: "building", startedAt: now() };
    await gh(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${b.candidate}`, "-f", `sha=${baseSha}`]);
    try {
      for (const { e } of group) {
        try { await gh(["api", "-X", "POST", `repos/${repo}/merges`, "-f", `base=${b.candidate}`, "-f", `head=${e.head}`, "-f", `commit_message=forge-train ${id}: PR #${e.pr}`]); } // a merge, never a rebase
        catch (err) {
          if (!/409|conflict/i.test(`${err?.stderr ?? ""}${err?.message ?? ""}`)) throw err; // transient: abandon this attempt
          events.push(handBack(e, "base.conflict", `PR #${e.pr} conflicts with ${base} or an earlier PR in train batch ${id}; conflicting files: ${(await conflictFiles(e, b, baseSha)).join(", ") || "unknown"}`));
          continue;
        }
        b.prs.push({ issue: e.issue, pr: e.pr, head: e.head });
      }
      if (b.prs.length < 2) { await dropRef(b); return; } // nothing to share a CI run: serial handling
      b.candSha = (await json(["api", ref(b.candidate).replace("/git/refs/", "/git/ref/")])).object?.sha;
      if (dispatch) { try { await gh(["api", "-X", "POST", `repos/${repo}/actions/workflows/${dispatch}/dispatches`, "-f", `ref=${b.candidate}`]); } catch { /* the push trigger may cover it */ } }
      b.state = "validating"; stats.batches += 1; stats.candidateRuns += 1;
      batches.push(b);
    } catch { await dropRef(b); }
  }
  async function conflictFiles(e, b, baseSha) {
    try {
      const mine = (await json(["pr", "view", String(e.pr), "-R", repo, "--json", "files"])).files?.map((f) => f.path) ?? [];
      const taken = new Set((await json(["api", `repos/${repo}/compare/${baseSha}...${b.candidate}`])).files?.map((f) => f.filename) ?? []);
      const both = mine.filter((f) => taken.has(f));
      return both.length ? both : mine;
    } catch { return []; }
  }

  /** Poll a validating batch's candidate checks (re-read, never rebuilt, after a resume); red/timeout dissolves it to serial handling. */
  async function validate(b, members) {
    let runs;
    try { runs = (await json(["api", `repos/${repo}/commits/${b.candSha}/check-runs`])).check_runs ?? []; } catch { return; }
    const states = rollupStates(runs.map((r) => ({ name: r.name, conclusion: r.status === "completed" ? r.conclusion : "", detailsUrl: r.html_url })));
    const first = members[0] ?? {};
    const { green, failed } = judgeChecks(states, { required: [...new Set(members.flatMap((m) => m.required ?? []))], policy: first.policy ?? "required" });
    if (green) { b.state = "merging"; return; }
    if (failed.length || now() - b.startedAt > batchTimeoutMs) {
      stats.candidateRed += 1;
      for (const m of members) m.noBatch = true;
      await endBatch(b);
    }
  }

  /** One poll: at most one merge per base (a validated batch merges its PRs in order); returns the events (merged / handback). */
  async function tick() {
    const events = [];
    const baseBusy = new Set();
    const ready = [];
    for (const e of [...entries.values()]) {
      let v;
      try { v = JSON.parse(String(await gh(["pr", "view", String(e.pr), "-R", repo, "--json", "state,headRefOid,headRefName,mergeable,mergeStateStatus,baseRefName,statusCheckRollup"]))); } catch { continue; } // unreadable: next poll
      if (v.headRefName) e.branch = v.headRefName;
      if (v.state === "MERGED") { events.push(landed(e, `PR #${e.pr} merged outside the train`)); await leaveBatch(e.issue); continue; }
      if (v.state === "CLOSED") { events.push(handBack(e, "pr.closed", `PR #${e.pr} was closed without merging`)); await leaveBatch(e.issue); continue; }
      if (!sameHead(v.headRefOid, e.head)) {
        events.push(handBack(e, "merge.head_mismatch", `PR #${e.pr} head moved to ${String(v.headRefOid).slice(0, 12)} after review at ${String(e.head).slice(0, 12)}; refusing to merge an unreviewed head.`));
        await leaveBatch(e.issue);
        continue;
      }
      if (v.mergeable === "CONFLICTING") { events.push(handBack(e, "base.conflict", `PR #${e.pr} conflicts with ${v.baseRefName ?? e.lane}`)); await leaveBatch(e.issue); continue; }
      const { green, failed } = judgeChecks(rollupStates(v.statusCheckRollup), e);
      if (failed.length) {
        events.push(handBack(e, "ci.red", `Required CI failed on PR #${e.pr}:\n${failed.map((f) => `- ${f.name}${f.url ? ` ${f.url}` : ""}`).join("\n")}`));
        await leaveBatch(e.issue);
        continue;
      }
      if (!green) continue;
      ready.push({ e, v, base: v.baseRefName ?? e.lane ?? "" });
    }
    for (const b of [...batches]) { // batches first: they own their base for this poll
      baseBusy.add(b.base);
      const members = b.prs.map((p) => entries.get(p.issue)).filter(Boolean);
      if (b.state === "validating") { await validate(b, members); continue; }
      for (const p of b.prs) { // merging: in order, stop at the first refusal so FIFO holds
        const e = entries.get(p.issue); if (!e) { await leaveBatch(p.issue); continue; }
        if (!ready.some((r) => r.e === e)) break;
        const r = await mergeOne(e, events);
        if (r === "kept") break;
        await leaveBatch(e.issue);
      }
    }
    if (batchSize > 1) {
      for (const base of new Set(ready.map((r) => r.base))) {
        if (baseBusy.has(base)) continue;
        const group = ready.filter((r) => r.base === base && !r.e.noBatch && !inBatch(r.e.issue)).sort((x, y) => x.e.since - y.e.since).slice(0, batchSize);
        if (group.length < 2) continue;
        try { await build(base, group, events); } catch { /* next poll */ }
        if (batches.some((b) => b.base === base)) baseBusy.add(base);
      }
    }
    for (const { e, v, base } of ready) {
      if (!entries.has(e.issue) || inBatch(e.issue)) continue;
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
      await mergeOne(e, events);
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
      stats.batches = snap?.stats?.batches ?? 0; stats.candidateRuns = snap?.stats?.candidateRuns ?? 0; stats.candidateRed = snap?.stats?.candidateRed ?? 0;
      batches.length = 0; for (const b of snap?.batches ?? []) batches.push({ ...b, prs: b.prs.map((p) => ({ ...p })) });
    },
    has: (issue) => entries.has(issue),
    size: () => entries.size,
    tick,
    stats: () => ({ merged: stats.merged, handedBack: { ...stats.handedBack }, waits: [...stats.waits], syncs: stats.syncs, batches: stats.batches, candidateRuns: stats.candidateRuns, candidateRed: stats.candidateRed }),
    snapshot: () => ({ entries: [...entries.values()], batches: batches.map((b) => ({ ...b, prs: b.prs.map((p) => ({ ...p })) })), stats: { ...stats, handedBack: { ...stats.handedBack }, waits: [...stats.waits] } }),
  };
}
