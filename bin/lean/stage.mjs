// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #6245: which sub-phase a lane is in, visible from outside the lane.
 *
 * Lane side: `createStageReporter` turns the phase ledger's transitions into one `LANE_STAGE` run-log event (read by the dispatcher)
 * and one `FORGE:STAGE` section of the issue's status comment, written at most once per `minMs` (default 60 s) per issue.
 * Dispatcher side: `latestStage` reads the newest LANE_STAGE and the newest event time of a sandbox run log; `laneStageLine` and
 * `laneStageLines` render `#N <sub-phase> for Xm (last activity Ys ago)` for `orchestrate --status` and `schedd status`, and flag a
 * lane `quiet` (informational only) after `quietMin` minutes without sandbox activity in a model phase.
 */

/** Ledger phases that are shown as a stage; the rest (sandbox_start, deps_install, validate, base_sync) are not transitions an operator waits on. */
export const STAGES = Object.freeze(["plan", "contract", "implement", "precheck", "fix", "review", "ci_wait", "merge"]);
/** Stages where the lane is waiting on a model session: silence there is what `quiet` flags. */
export const MODEL_STAGES = Object.freeze(["plan", "contract", "implement", "fix", "review"]);
export const STAGE_MIN_MS = 60000;
export const STAGE_HEARTBEAT_MS = 300000;
export const QUIET_MIN_DEFAULT = 15;

const iso = (t) => new Date(t).toISOString();
const text1 = (s, n = 80) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** The reason of a fix round: its trigger, then the first failure's code and requirement id (`conformance.unimplemented R3`). */
export function fixReason(trigger, failures = []) {
  const f = Array.isArray(failures) ? failures[0] : null;
  const code = f && typeof f === "object" ? f.code ?? f.kind : null;
  const id = f && typeof f === "object" ? f.id ?? f.req ?? f.requirement : null;
  return text1([code ?? trigger, typeof id === "string" || typeof id === "number" ? id : null].filter((x) => x != null && x !== "").join(" "));
}

/** The stage's display name: `fix R2` carries its round. */
export const stageName = (stage, round = null) => (stage === "fix" && round ? `fix round ${round}` : stage);

/** The body of the FORGE:STAGE section. */
export function renderStage({ stage, round = null, reason = null, since, last }) {
  return `**stage:** ${stageName(stage, round)}${reason ? ` (${text1(reason)})` : ""} - started ${iso(since)}, last activity ${iso(last ?? since)}`;
}

/**
 * Lane-side reporter. `enter(phase)` is the phase ledger's transition hook, `note(reason)` names the next fix round, `touch()` marks
 * activity (any run-log event). `write(text)` edits the status comment; `emit(event)` appends to the run log. Both are best effort.
 * Writes are throttled: a transition inside the window is sent when it ends (trailing timer); a touch alone refreshes the
 * last-activity time at most every `heartbeatMs`.
 */
export function createStageReporter({ now = () => Date.now(), write, emit, minMs = STAGE_MIN_MS, heartbeatMs = STAGE_HEARTBEAT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let cur = null, round = 0, reason = null, since = 0, last = 0, lastWrite = -Infinity, dirty = false, timer = null, closed = false, note = null;
  const send = async () => {
    timer = null; if (closed || !dirty) return;
    dirty = false; lastWrite = now();
    try { await write?.(renderStage({ stage: cur, round, reason, since, last })); } catch { /* status is best effort */ }
  };
  const schedule = (delay) => {
    if (closed) return;
    if (delay <= 0) { send(); return; }
    if (timer) return;
    timer = setTimer(send, delay); timer?.unref?.();
  };
  return {
    enter(phase) {
      if (closed || !STAGES.includes(phase) || phase === cur) return;
      const t = now();
      cur = phase; since = last = t; reason = null;
      if (phase === "fix") { round += 1; reason = note; note = null; }
      try { emit?.({ event: "LANE_STAGE", stage: phase, ...(phase === "fix" ? { round } : {}), ...(reason ? { reason } : {}) }); } catch { /* run log is best effort */ }
      dirty = true;
      schedule(lastWrite + minMs - t);
    },
    note(r) { note = text1(r) || null; },
    touch() {
      if (closed || !cur) return;
      const t = now(); last = t;
      if (!dirty && t - lastWrite >= heartbeatMs) { dirty = true; schedule(lastWrite + minMs - t); }
    },
    flush: () => { if (timer) clearTimer(timer); timer = null; return send(); },
    close() { closed = true; if (timer) clearTimer(timer); timer = null; },
    current: () => cur,
  };
}

/**
 * The newest sub-phase of a sandbox run log (JSONL text): `{stage, round, reason, since, lastEventAt}`, or null when it has no
 * LANE_STAGE yet. `lastEventAt` is the newest event time of any kind (epoch ms, or null when no event has a time).
 */
export function latestStage(runLog, { tail = 600 } = {}) {
  const lines = String(runLog ?? "").split("\n").filter(Boolean).slice(-tail);
  let stage = null, lastEventAt = null;
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (!e || typeof e !== "object") continue;
    const t = Date.parse(e.ts);
    if (Number.isFinite(t) && (lastEventAt === null || t > lastEventAt)) lastEventAt = t;
    if (e.event === "LANE_STAGE" && STAGES.includes(e.stage)) stage = { stage: e.stage, round: Number.isInteger(e.round) ? e.round : null, reason: typeof e.reason === "string" ? e.reason : null, since: Number.isFinite(t) ? t : null };
  }
  return stage ? { ...stage, lastEventAt } : (lastEventAt !== null ? { stage: null, round: null, reason: null, since: null, lastEventAt } : null);
}

/**
 * The dispatcher's stage record for a handle: merges a fresh `latestStage` (and the time the lane log last grew, `logAt`) into the
 * previous record. Returns `{stage, round, reason, since, lastEventAt}` (epoch ms) or null; `stage` keeps its old value when the
 * log shows none (a log that has not reached the first transition).
 */
export function mergeStage(prev, found, logAt = null) {
  const lastEventAt = [prev?.lastEventAt, found?.lastEventAt, logAt].filter(Number.isFinite).reduce((a, b) => Math.max(a, b), -Infinity);
  const next = found?.stage ? { stage: found.stage, round: found.round, reason: found.reason, since: found.since ?? prev?.since ?? null } : prev ? { stage: prev.stage ?? null, round: prev.round ?? null, reason: prev.reason ?? null, since: prev.since ?? null } : { stage: null, round: null, reason: null, since: null };
  if (!Number.isFinite(lastEventAt) && !next.stage) return null;
  return { ...next, lastEventAt: Number.isFinite(lastEventAt) ? lastEventAt : null };
}

export const quietMinOf = (env = process.env) => { const n = Number(env.FORGE_LANE_QUIET_MIN); return Number.isFinite(n) && n > 0 ? n : QUIET_MIN_DEFAULT; };

const mins = (ms) => `${Math.max(0, Math.round(ms / 60000))}m`;
const secs = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 120 ? mins(ms) : `${s}s`; };

/** `#N <sub-phase> for Xm (last activity Ys ago)`, plus ` quiet` for a model phase silent for `quietMin`. Null when the lane has no stage record. */
export function laneStageLine(n, rec, { now = Date.now(), quietMin = QUIET_MIN_DEFAULT } = {}) {
  const s = rec?.stage ?? rec?.handle?.stage;
  if (!s || !s.stage) return null;
  const since = Number.isFinite(s.since) ? s.since : rec?.startedAt;
  const age = Number.isFinite(s.lastEventAt) ? now - s.lastEventAt : null;
  const quiet = age !== null && age > quietMin * 60000 && MODEL_STAGES.includes(s.stage);
  const name = `${stageName(s.stage, s.round)}${s.reason ? ` [${text1(s.reason, 60)}]` : ""}`;
  return `#${n} ${name}${Number.isFinite(since) ? ` for ${mins(now - since)}` : ""}${age !== null ? ` (last activity ${secs(age)} ago)` : ""}${quiet ? " quiet" : ""}`;
}

/** The lines for every running lane of a batch state that has a stage record. */
export function laneStageLines(state, opts = {}) {
  return Object.entries(state?.running ?? {}).map(([n, rec]) => laneStageLine(n, rec, opts)).filter(Boolean);
}
