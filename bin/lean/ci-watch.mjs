// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5692: step-granular CI awareness for the lane's merge wait. `watchCi` yields `step_failed` / `test_failed` events for
 * one head sha: from the router's long-poll GET /ci/events (#5688) when it is configured and has events for the sha,
 * else by polling the Actions jobs API and synthesizing `step_failed` from the first failed step of an in_progress job.
 * Events only start a fix round; the GitHub check status stays the merge gate (lean.mjs). Never throws.
 */
import { failFastDecision } from "./ci-classify.mjs";

export const POLL_MS = 15000, LONG_POLL_S = 25;
const FAIL_TYPES = new Set(["step_failed", "test_failed"]);
const FAILED = new Set(["failure", "timed_out"]);

/** First failed step of every in_progress job: [{job, step, completed_at, run_id}] (a finished job is the check poll's business). */
export function failedStepsOf(jobs, runId = null) {
  const out = [];
  for (const j of jobs ?? []) {
    if (j?.status !== "in_progress") continue;
    const s = (j.steps ?? []).find((x) => FAILED.has(String(x?.conclusion ?? "")));
    if (s) out.push({ job: j.name ?? null, step: s.name ?? null, completed_at: s.completed_at ?? null, run_id: runId });
  }
  return out;
}

/**
 * Async iterator of failure events for `sha`. `io`: ciEventsWait({repo,sha,pr,since,waitS}) -> {events,next}|null (router),
 * runsForSha(sha) -> [{id|databaseId}], jobsOf(runId) -> [job]. `sleep`/`now` are injectable (fake clock in tests).
 */
export async function* watchCi({ repo, sha, pr, io, sleep, now = Date.now, pollMs = POLL_MS, waitS = LONG_POLL_S, signal } = {}) {
  const seen = new Set();
  const fresh = (key) => (seen.has(key) ? false : (seen.add(key), true));
  let since = 0, router = false;
  const poll = async (w) => {
    try { return (await io?.ciEventsWait?.({ repo, sha, pr, since, waitS: w })) ?? null; } catch { return null; }
  };
  if (io?.ciEventsWait) { // the router is used only when it has already emitted events for this sha
    const first = await poll(0);
    if (first?.events?.length) { router = true; since = first.next ?? since; for (const e of first.events) if (FAIL_TYPES.has(e.type) && fresh(`e${e.seq}`)) yield e; }
  }
  while (!signal?.aborted) {
    if (router) {
      const r = await poll(waitS);
      if (!r) { await sleep(pollMs); continue; }
      since = r.next ?? since;
      for (const e of r.events ?? []) if (FAIL_TYPES.has(e.type) && fresh(`e${e.seq}`)) yield e;
      continue;
    }
    try {
      for (const run of (await io?.runsForSha?.(sha)) ?? []) {
        const id = run.id ?? run.databaseId;
        if (id == null || run.status === "completed") continue;
        for (const f of failedStepsOf(await io.jobsOf(id), id)) {
          if (fresh(`j${id}\n${f.job}\n${f.step}`)) yield { type: "step_failed", repo, sha, run_id: String(id), job: f.job, step: f.step, lines: [], ts: f.completed_at ?? new Date(now()).toISOString(), source: "jobs-api" };
        }
      }
    } catch { /* the check poll still runs */ }
    await sleep(pollMs);
  }
}

/** One pending `next()` at a time, so the merge loop can race it against its own sleep: `next()` resolves an event or null once stopped. */
export function ciSignal(opts) {
  const ac = new AbortController(), it = watchCi({ ...opts, signal: ac.signal });
  let pending = null;
  return {
    next() {
      pending ??= it.next().then((r) => { pending = null; return r.done ? null : r.value; }, () => { pending = null; return null; });
      return pending;
    },
    stop() { ac.abort(); it.return?.().catch?.(() => {}); },
  };
}

/** Cancel the run only when the classifier says downstream and the policy is `deterministic` (#5690). */
export const cancelDecision = (event, policy) => failFastDecision(event, policy);

/** Builder context for an event-triggered round: the failing step's lines and test id. */
export const eventLog = (e) => [e.test ? `test: ${e.test}` : null, e.step ? `step: ${e.step}` : null, ...(e.lines ?? [])].filter(Boolean).join("\n");
