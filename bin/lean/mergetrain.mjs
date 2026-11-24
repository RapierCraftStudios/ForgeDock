// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// bin/lean/mergetrain.mjs — the phase-1 merge train (#5836, epic #5823), behind `orchestration.merge_train: off|on`.
// A lane whose reviewed PR has pending required checks ends `pr-ready` and frees its slot; the train, run by the batch
// runner (orchestrate.mjs), merges the green ones serially per base at the reviewed head. Red, conflicting and moved-head
// PRs are handed back as needs-human `ci.red` / `base.conflict` / `merge.head_mismatch` (in-batch recovery requeues a fix
// lane). #5837 batches PRs onto one candidate; #5838 bisects a red candidate to its culprit (rerun once, bare-base-tip probe,
// FIFO halves, at most ceil(log2 N)+1 CI runs, then serial). All I/O goes through the injected `gh`; state is plain JSON (batch state.json `train`).

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
  return `merge train: merged ${stats.merged ?? 0}, handed back ${total}${hb.length ? ` (${hb.map(([k, c]) => `${k} ${c}`).join(", ")})` : ""}, wait p50 ${w === null ? "n/a" : `${(w / 60000).toFixed(1)} min`}, base-syncs ${stats.syncs ?? 0}${stats.batches ? `, batches ${stats.batches}, candidate CI runs ${stats.candidateRuns ?? 0}${stats.candidateRed ? ` (${stats.candidateRed} red)` : ""}${stats.bisections ? `, bisections ${stats.bisections}` : ""}${stats.culprits ? `, culprits ${stats.culprits}` : ""}${stats.redBase ? `, red base ${stats.redBase}` : ""}` : ""}`;
}

/**
 * @param {object} o
 * @param {(args: string[]) => Promise<string>} o.gh   gh runner (stdout)
 * @param {string} o.repo
 * @param {() => number} [o.now]
 * @param {object|null} [o.saved]  a prior `snapshot()` (resume)
 * @param {number} [o.batchSize]  #5837: PRs per candidate batch (1 = the serial phase-1 train)
 * @param {string|null} [o.dispatch]  workflow file to `workflow_dispatch` on the candidate (else the repo's push trigger runs CI)
 * @param {string[]} [o.flaky]  #5838: `verify.flaky` names; a failing check named there is labelled known-flaky (every red candidate is rerun once)
 * @param {((r: {base, baseSha, checks, batch}) => Promise<unknown>)|null} [o.onBaseRed]  #5838: a red base tip (the batch hands back no PR)
 */
export function createMergeTrain({ gh, repo, now = () => Date.now(), saved = null, batchSize = 1, dispatch = null, batchTimeoutMs = 90 * 60000, flaky = [], onBaseRed = null }) {
  const entries = new Map((saved?.entries ?? []).map((e) => [e.issue, { ...e }]));
  const stats = { merged: saved?.stats?.merged ?? 0, handedBack: { ...(saved?.stats?.handedBack ?? {}) }, waits: [...(saved?.stats?.waits ?? [])], syncs: saved?.stats?.syncs ?? 0, batches: saved?.stats?.batches ?? 0, candidateRuns: saved?.stats?.candidateRuns ?? 0, candidateRed: saved?.stats?.candidateRed ?? 0,
    bisections: saved?.stats?.bisections ?? 0, culprits: saved?.stats?.culprits ?? 0, redBase: saved?.stats?.redBase ?? 0 };
  const copyBatch = (b) => ({ ...b, prs: b.prs.map((p) => ({ ...p })), ...(b.bisect ? { bisect: JSON.parse(JSON.stringify(b.bisect)) } : {}) });
  const batches = (saved?.batches ?? []).map(copyBatch); // [{id, base, baseSha, prs, candidate, state, bisect?}]
  const redBases = { ...(saved?.redBases ?? {}) }; // #5838: base -> tip sha reported red; no candidate is built on it again
  let batchSeq = 0;

  const handBack = (e, code, detail, extra = {}) => {
    entries.delete(e.issue);
    stats.handedBack[code] = (stats.handedBack[code] ?? 0) + 1;
    return { kind: "handback", issue: e.issue, pr: e.pr, code, detail, entry: e, ...extra };
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
  const dropHalf = async (b) => { const h = b.bisect?.half; if (!h?.ref) return; try { await gh(["api", "-X", "DELETE", ref(h.ref)]); } catch { /* already gone */ } };
  const endBatch = async (b) => { await dropRef(b); await dropHalf(b); const i = batches.indexOf(b); if (i >= 0) batches.splice(i, 1); };
  const inBatch = (issue) => batches.some((b) => b.prs.some((p) => p.issue === issue));
  /** A member leaves its batch (landed or handed back): a validating batch no longer matches its candidate, so it dissolves. */
  const leaveBatch = async (issue) => {
    const b = batches.find((x) => x.prs.some((p) => p.issue === issue)); if (!b) return;
    b.prs = b.prs.filter((p) => p.issue !== issue);
    if (b.state === "validating" || b.state === "bisecting" || !b.prs.length) await endBatch(b);
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
    if (!baseSha || redBases[base] === baseSha) return; // #5838: a red base tip builds no candidate until it moves
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

  /** Poll a validating batch's candidate checks (re-read, never rebuilt, after a resume); red starts bisection (#5838), a timeout dissolves it to serial handling. */
  async function validate(b, members) {
    let runs;
    try { runs = (await json(["api", `repos/${repo}/commits/${b.candSha}/check-runs`])).check_runs ?? []; } catch { return; }
    const states = rollupStates(runs.map((r) => ({ name: r.name, conclusion: r.status === "completed" ? r.conclusion : "", detailsUrl: r.html_url })));
    const first = members[0] ?? {};
    const { green, failed } = judgeChecks(states, { required: [...new Set(members.flatMap((m) => m.required ?? []))], policy: first.policy ?? "required" });
    if (green) { b.state = "merging"; return; }
    if (failed.length) { stats.candidateRed += 1; await startBisect(b, failed, runs); return; }
    if (now() - b.startedAt > batchTimeoutMs) { stats.candidateRed += 1; await serial(b, members); }
  }

  /** Every member goes to the serial phase-1 path (never re-batched): the budget ran out, a step timed out or a half could not be built. */
  async function serial(b, members = b.prs.map((p) => entries.get(p.issue)).filter(Boolean)) {
    for (const m of members) m.noBatch = true;
    await endBatch(b);
  }

  /** The latest run per check name on `sha`, restricted to `names`: {state: green|red|pending, failed, missing}; a `stale` run id reads pending. */
  async function readChecks(sha, names, stale = []) {
    const runs = (await json(["api", `repos/${repo}/commits/${sha}/check-runs`])).check_runs ?? [];
    const latest = new Map();
    for (const r of runs) if (names.includes(r.name) && (!latest.has(r.name) || (r.id ?? 0) >= (latest.get(r.name).id ?? 0))) latest.set(r.name, r);
    const st = names.map((n) => { const r = latest.get(n); if (!r) return { name: n, state: "missing" }; if (stale.includes(r.id) || r.status !== "completed") return { name: n, state: "pending" }; return { name: n, ...rollupStates([{ name: n, conclusion: r.conclusion, detailsUrl: r.html_url }])[0] }; });
    const failed = st.filter((x) => x.state === "failure").map((x) => ({ name: x.name, url: x.url }));
    return { failed, pending: st.some((x) => x.state === "pending"), missing: st.filter((x) => x.state === "missing").map((x) => x.name), green: st.every((x) => x.state === "success") };
  }

  /**
   * #5838: a red candidate. Rerun the failing checks once (a known-flaky or rerun-green failure merges without bisection),
   * then probe the bare base tip (the same checks red there = red base: report it, hand back no PR), then split the batch
   * FIFO into halves until one PR is left. The budget `ceil(log2 N)+1` counts every CI run it starts (the rerun and each
   * half; the probe reads the base tip's own runs); spent, the batch goes serial. State lives on `b.bisect` (resume re-reads).
   */
  async function startBisect(b, failed, runs) {
    const names = failed.map((f) => f.name);
    const ids = runs.filter((r) => names.includes(r.name) && r.status === "completed" && FAIL.has(String(r.conclusion ?? "").toUpperCase())).map((r) => r.id).filter((id) => id != null);
    b.state = "bisecting";
    b.bisect = { runs: 0, budget: Math.ceil(Math.log2(b.prs.length)) + 1, failed, flaky: names.filter((n) => flaky.includes(n)), frame: b.prs.map((p) => p.issue), step: "rerun", stale: ids, at: now(), halves: 0 };
    let rerun = 0;
    for (const id of ids) { try { await gh(["api", "-X", "POST", `repos/${repo}/actions/jobs/${id}/rerun`]); rerun += 1; } catch { /* not an Actions job */ } }
    if (rerun) { b.bisect.runs += 1; stats.candidateRuns += 1; } else b.bisect.step = "probe"; // nothing could rerun: probe at once
  }

  /** Build a candidate of the base tip plus the `issues` PRs (FIFO) for one bisection half; null when it cannot be built. */
  async function buildHalf(b, issues) {
    const k = (b.bisect.halves += 1);
    const h = { ref: `${b.candidate}-h${k}`, prs: issues, at: now() };
    try {
      await gh(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${h.ref}`, "-f", `sha=${b.baseSha}`]);
      b.bisect.half = h;
      for (const i of issues) { const p = b.prs.find((x) => x.issue === i); await gh(["api", "-X", "POST", `repos/${repo}/merges`, "-f", `base=${h.ref}`, "-f", `head=${p.head}`, "-f", `commit_message=forge-train ${b.id} bisect ${k}: PR #${p.pr}`]); }
      h.sha = (await json(["api", ref(h.ref).replace("/git/refs/", "/git/ref/")])).object?.sha;
      if (!h.sha) return null;
      if (dispatch) { try { await gh(["api", "-X", "POST", `repos/${repo}/actions/workflows/${dispatch}/dispatches`, "-f", `ref=${h.ref}`]); } catch { /* the push trigger may cover it */ } }
      return h;
    } catch { return null; }
  }

  /** Narrow the frame: one PR left is the culprit; else spend one run on the first FIFO half (or go serial when the budget is spent). */
  async function split(b, events) {
    const bs = b.bisect;
    if (bs.frame.length === 1) return culprit(b, bs.frame[0], events);
    if (bs.runs >= bs.budget) return serial(b);
    const h = await buildHalf(b, bs.frame.slice(0, Math.ceil(bs.frame.length / 2)));
    if (!h) return serial(b);
    bs.runs += 1; stats.candidateRuns += 1; bs.step = "half"; bs.at = now();
  }

  async function culprit(b, issue, events) {
    const bs = b.bisect, e = entries.get(issue), p = b.prs.find((x) => x.issue === issue);
    const f = bs.evidence ?? bs.failed[0] ?? { name: "unknown", url: null };
    stats.culprits += 1;
    if (e) {
      const c = { pr: p.pr, check: f.name, url: f.url ?? null, batch: b.id };
      events.push(handBack(e, "ci.red", `PR #${p.pr} broke the merged tree of train batch ${b.id} on ${b.base} (its own head is green): required check ${f.name} failed${f.url ? ` ${f.url}` : ""}.\n${bs.failed.map((x) => `- ${x.name}${x.url ? ` ${x.url}` : ""}`).join("\n")}`, { culprit: c }));
    }
    for (const q of b.prs) { const m = entries.get(q.issue); if (m) delete m.noBatch; } // innocents re-batch next poll
    await endBatch(b);
  }

  /** One poll of a bisecting batch: reads the pending step's checks (never rebuilds after a resume) and advances at most one step. */
  async function bisectStep(b, events) {
    const bs = b.bisect, names = bs.failed.map((f) => f.name);
    const late = now() - (bs.at ?? b.startedAt) > batchTimeoutMs;
    let r;
    try { r = await readChecks(bs.step === "probe" ? b.baseSha : bs.step === "half" ? bs.half.sha : b.candSha, names, bs.step === "rerun" ? bs.stale : []); } catch { return; }
    if (bs.step === "rerun") {
      if (r.green) { b.state = "merging"; delete b.bisect; return; } // a flake: the batch merges, no bisection
      if (r.failed.length) { bs.failed = r.failed; bs.step = "probe"; bs.at = now(); return; }
      if (late) await serial(b);
      return;
    }
    if (bs.step === "probe") {
      if (r.pending && !late) return;
      if (r.failed.length === names.length) { // every failing check is red on the bare base tip: a red base, not a culprit
        stats.redBase += 1; redBases[b.base] = b.baseSha;
        if (onBaseRed) { try { await onBaseRed({ base: b.base, baseSha: b.baseSha, checks: r.failed, batch: b.id }); } catch { /* reported best effort */ } }
        await endBatch(b);
        return;
      }
      stats.bisections += 1;
      return split(b, events);
    }
    if (r.pending || r.missing.length) { if (late) await serial(b); return; }
    const red = r.failed.length > 0, half = bs.half.prs;
    if (red) bs.evidence = r.failed[0];
    await dropHalf(b); delete bs.half;
    bs.frame = red ? half : bs.frame.filter((i) => !half.includes(i));
    return split(b, events);
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
      if (b.state === "bisecting") { await bisectStep(b, events); continue; }
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
      stats.bisections = snap?.stats?.bisections ?? 0; stats.culprits = snap?.stats?.culprits ?? 0; stats.redBase = snap?.stats?.redBase ?? 0;
      for (const k of Object.keys(redBases)) delete redBases[k]; Object.assign(redBases, snap?.redBases ?? {});
      batches.length = 0; for (const b of snap?.batches ?? []) batches.push(copyBatch(b));
    },
    has: (issue) => entries.has(issue),
    size: () => entries.size,
    tick,
    stats: () => ({ merged: stats.merged, handedBack: { ...stats.handedBack }, waits: [...stats.waits], syncs: stats.syncs, batches: stats.batches, candidateRuns: stats.candidateRuns, candidateRed: stats.candidateRed, bisections: stats.bisections, culprits: stats.culprits, redBase: stats.redBase }),
    snapshot: () => ({ entries: [...entries.values()], batches: batches.map(copyBatch), ...(Object.keys(redBases).length ? { redBases: { ...redBases } } : {}), stats: { ...stats, handedBack: { ...stats.handedBack }, waits: [...stats.waits] } }),
  };
}
