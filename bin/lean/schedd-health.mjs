// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * schedd liveness (#4780). The daemon's event loop writes `heartbeat.json` ({pid, ts}) every `HEARTBEAT_MS`; a starved or
 * wedged loop stops writing, so the file goes stale while the pid stays alive (which `Restart=always` cannot see).
 * `sched show` / `schedd status` report "last tick N s ago" from it, and `watchdog` (run by a systemd timer, outside the
 * daemon) signals a live daemon whose heartbeat is older than `stallMs`; the unit's `Restart=always` then restarts it and
 * the new daemon resumes every hosted batch.
 */
import { readFileSync, rmSync } from "node:fs";
import { setPriority } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "./batch.mjs";
import { schedDir, pidAlive } from "./sched.mjs";

export const HEARTBEAT_MS = 5 * 1000;
export const STALL_MS = 60 * 1000;
export const KILL_GRACE_MS = 10 * 1000;

export const heartbeatPath = (dir = schedDir()) => join(dir, "heartbeat.json");

/** Record a tick now. */
export function writeHeartbeat({ dir = schedDir(), pid = process.pid, now = () => Date.now() } = {}) {
  writeAtomic(heartbeatPath(dir), JSON.stringify({ pid, ts: now() }));
}

/** The last heartbeat `{pid, ts}`, or null when absent or unreadable. */
export function readHeartbeat(dir = schedDir()) {
  try {
    const h = JSON.parse(readFileSync(heartbeatPath(dir), "utf8"));
    return Number.isInteger(h?.pid) && Number.isFinite(h?.ts) ? h : null;
  } catch { return null; }
}

export const clearHeartbeat = (dir = schedDir()) => rmSync(heartbeatPath(dir), { force: true });

/** `{status:"ok"|"stalled"|"down", pid, ageMs}`: down = no heartbeat or its pid is gone. */
export function stallCheck({ dir = schedDir(), stallMs = STALL_MS, now = () => Date.now(), alive = pidAlive } = {}) {
  const h = readHeartbeat(dir);
  if (!h || !alive(h.pid)) return { status: "down", pid: h?.pid ?? null, ageMs: h ? now() - h.ts : null };
  const ageMs = Math.max(0, now() - h.ts);
  return { status: ageMs > stallMs ? "stalled" : "ok", pid: h.pid, ageMs };
}

/** The `last tick N s ago` text for a stall-check result. */
export function tickText(c) {
  if (c.status === "down") return "schedd: not running";
  const s = `schedd: pid ${c.pid}, last tick ${Math.round(c.ageMs / 1000)} s ago`;
  return c.status === "stalled" ? `${s} (STALLED)` : s;
}

/** Signal a stalled live daemon: SIGTERM, then SIGKILL after `graceMs` if it is still alive. @returns the check, plus `killed` */
export async function watchdog({ dir = schedDir(), stallMs = STALL_MS, now = () => Date.now(), alive = pidAlive, kill = (p, s) => process.kill(p, s),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), graceMs = KILL_GRACE_MS, log = (m) => console.log(m) } = {}) {
  const c = stallCheck({ dir, stallMs, now, alive });
  if (c.status !== "stalled") return { ...c, killed: null };
  log(`schedd watchdog: pid ${c.pid} silent for ${Math.round(c.ageMs / 1000)} s (limit ${Math.round(stallMs / 1000)} s), sending SIGTERM`);
  try { kill(c.pid, "SIGTERM"); } catch { return { ...c, killed: null }; }
  await sleep(graceMs);
  if (!alive(c.pid)) return { ...c, killed: "SIGTERM" };
  log(`schedd watchdog: pid ${c.pid} ignored SIGTERM, sending SIGKILL`);
  try { kill(c.pid, "SIGKILL"); } catch { /* gone */ }
  return { ...c, killed: "SIGKILL" };
}

/** Raise the daemon's own scheduling priority; a user without CAP_SYS_NICE cannot, and that is fine (never throws). */
export function bestEffortRenice(set = setPriority, level = -5) {
  try { set(0, level); return true; } catch { return false; }
}
