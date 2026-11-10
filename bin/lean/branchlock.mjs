// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One writer per lane branch (#5333): a lock file in the repo's shared git dir, so every worktree and every engine
 * process on the host sees it. A builder session (implement, recovery, fix-up) holds it while it may commit.
 * Also the lane's teardown ordering helper: a worktree is removed only after its builder processes have exited.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export const LOCK_DIR = "forge-branch-locks";

/** True when `pid` is a live process (EPERM: alive, owned by someone else). */
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

const lockPath = (gitCommonDir, branch) => join(gitCommonDir, LOCK_DIR, encodeURIComponent(String(branch)));
const readHolder = (p) => { try { const j = JSON.parse(readFileSync(p, "utf8")); return j && typeof j === "object" ? j : null; } catch { return null; } };

/**
 * Take the writer lock of `branch`. The same `owner` re-enters. A holder whose pid is dead is taken over. Otherwise wait up to
 * `waitMs` (0: do not wait), then report the holder.
 * @returns {Promise<{ok: true, release: () => void} | {ok: false, holder: object|null}>}
 */
export async function acquireBranchLock({ gitCommonDir, branch, owner, pid = process.pid, alive = pidAlive, waitMs = 0, pollMs = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const p = lockPath(gitCommonDir, branch);
  mkdirSync(join(gitCommonDir, LOCK_DIR), { recursive: true });
  const deadline = now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(p, "wx");
      try { writeSync(fd, JSON.stringify({ owner, pid, branch, at: now() })); } finally { closeSync(fd); }
      return { ok: true, release: () => { if (readHolder(p)?.owner === owner) { try { unlinkSync(p); } catch { /* already gone */ } } } };
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }
    const holder = readHolder(p);
    if (holder?.owner === owner) return { ok: true, release: () => {} }; // re-entrant: the outer holder releases
    if (!holder || !alive(holder.pid)) { try { unlinkSync(p); } catch { /* raced: retry */ } continue; } // stale or unreadable: take over
    if (now() >= deadline) return { ok: false, holder };
    await sleep(pollMs);
  }
}

/**
 * Wait until none of `pids` is alive: SIGTERM was already sent; after `graceMs` escalate to SIGKILL, then wait `killMs` more.
 * @returns {Promise<number[]>} the pids still alive (empty: all exited)
 */
export async function waitPidsExit(pids, { alive, kill, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), graceMs = 5000, killMs = 3000, stepMs = 250 }) {
  const live = () => pids.filter((x) => alive(x));
  let left = live();
  for (let t = 0; left.length && t < graceMs; t += stepMs) { await sleep(stepMs); left = live(); }
  if (!left.length) return [];
  for (const x of left) { try { kill(x, "SIGKILL"); } catch { /* gone */ } }
  for (let t = 0; left.length && t < killMs; t += stepMs) { await sleep(stepMs); left = live(); }
  return left;
}
