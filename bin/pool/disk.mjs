// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5884: lane disk hard cap, pressure prune and fstrim for pool agents. Pure planners plus one best-effort runner;
// nothing here imports outside bin/pool (agent bundle closure).
import { execFile } from "node:child_process";

const GB = 1024;
const r1 = (n) => Math.round(n * 10) / 10;

/** GB used by lanes: running sandbox dirs (`sandboxMb` {id: MB}) plus this agent's cache volumes (`cacheVolumes` {name: {size_bytes}}). */
export function laneDiskUsedGb({ sandboxMb = {}, cacheVolumes = {} } = {}) {
  const sb = Object.values(sandboxMb).reduce((a, mb) => a + (Number(mb) || 0), 0) / GB;
  const cache = Object.values(cacheVolumes).reduce((a, v) => a + (Number(v?.size_bytes) || 0), 0) / 2 ** 30;
  return r1(sb + cache);
}

/** 'ok' under the prune threshold (or no cap set), 'prune' from `pruneAtPct` of the cap, 'full' at or over the cap. */
export function planDiskCap({ usedGb, capGb, pruneAtPct = 80 }) {
  const cap = Number(capGb);
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(usedGb)) return "ok";
  if (usedGb >= cap) return "full";
  return usedGb >= (cap * (Number(pruneAtPct) || 80)) / 100 ? "prune" : "ok";
}

/** fstrim is due when never run or `intervalS` (default 6 h) has passed; `force` after a pressure prune. */
export function fstrimDue({ now, last, intervalS = 6 * 3600, force = false }) {
  return force || !Number.isFinite(last) || now - last >= intervalS * 1000;
}

/** argv for fstrim of `root`: through `sudo -n` when not root. */
export function fstrimArgv({ root = "/var/lib/docker", uid = process.getuid?.() ?? 0 } = {}) {
  return uid === 0 ? ["fstrim", "-v", root] : ["sudo", "-n", "fstrim", "-v", root];
}

const execRun = (argv) => new Promise((resolve, reject) => {
  execFile(argv[0], argv.slice(1), { timeout: 10 * 60000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

/** Best-effort fstrim: `{ ok, out }` or `{ ok:false, error }`; never throws (unavailable fstrim, no sudo, unsupported fs). */
export async function runFstrim({ run = execRun, root, uid } = {}) {
  try { return { ok: true, out: String(await run(fstrimArgv({ root, uid }))).trim() }; }
  catch (e) { return { ok: false, error: String(e.stderr || e.message).slice(0, 200) }; }
}
