// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Speculative start (#5436): the review session reads the same committed diff as the guard and precheck run, so it starts
 * beside them. `fn` must have no effect on lane state (only the model call); the caller applies the reply when it adopts
 * the job, and `discard()` drops it when precheck fails, so a red precheck costs nothing but the unused call.
 */
export function startSpeculative(fn) {
  const p = Promise.resolve().then(fn);
  let state = "running";
  p.then(() => { if (state === "running") state = "settled"; }, () => { if (state === "running") state = "failed"; });
  p.catch(() => {}); // a discarded job's rejection is never unhandled
  return {
    /** The job's promise; rejects as `fn` did. */
    adopt() { state = "adopted"; return p; },
    /** Drop the job; its result is never read. Returns true when it had not finished. */
    discard() { const was = state === "running"; if (state !== "adopted") state = "discarded"; return was; },
    state: () => state,
  };
}
