// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5437: post-decision bookkeeping of a lane (branch delete, structure telemetry, guard, trajectory, teardown) as a queue of
 * named jobs run after RUN_TERMINAL. Jobs run in the order added and are idempotent (a job that finished is never re-run,
 * `run()` is safe to call twice). A failing job is retried with backoff; its outcome is recorded (POSTRUN_OK / POSTRUN_FAILED)
 * and never changes the lane's outcome. Deterministic, 0 LLM calls.
 */
export function makePostRun({ ev = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, attempts = 3, backoffMs = 1000 } = {}) {
  const jobs = [];
  let running = null;
  async function runJob(j) {
    for (let i = 1; i <= attempts; i++) {
      const t = now();
      try { await j.fn(); j.done = true; ev({ event: "POSTRUN_OK", job: j.name, attempt: i, ms: now() - t }); return; }
      catch (e) {
        const error = String(e?.message ?? e).slice(0, 300);
        if (i === attempts) { j.done = true; ev({ event: "POSTRUN_FAILED", job: j.name, attempts: i, error }); return; }
        try { await sleep(backoffMs * 2 ** (i - 1)); } catch { /* keep going */ }
      }
    }
  }
  return {
    add(name, fn) { jobs.push({ name, fn, done: false }); },
    pending: () => jobs.filter((j) => !j.done).map((j) => j.name),
    /** Runs every job not yet done, once at a time; concurrent callers share one run. */
    run() {
      running ??= (async () => { for (const j of jobs) if (!j.done) await runJob(j); })().finally(() => { running = null; });
      return running;
    },
  };
}
