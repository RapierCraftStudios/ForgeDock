// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Parent-death watchdog for a lean runner (#4162): `node runner-watchdog.mjs <enginePid> <pgid> [pollMs]`.
 * Spawned detached next to each runner child. When the engine is gone (even after a SIGKILL it could not handle),
 * the runner's process group gets SIGTERM, then SIGKILL after a grace period. Exits as soon as the group is gone.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const gone = (kill, pid) => { try { kill(pid, 0); return false; } catch (e) { return e?.code === "ESRCH"; } };

/** Returns "group-gone" or "engine-gone" (after signalling the group). `kill` and `sleep` are injectable. */
export async function watch({ enginePid, pgid, kill = process.kill.bind(process), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 2000, graceMs = 5000 }) {
  for (;;) {
    if (gone(kill, -pgid)) return "group-gone";
    if (gone(kill, enginePid)) {
      try { kill(-pgid, "SIGTERM"); } catch { /* gone */ }
      await sleep(graceMs);
      if (!gone(kill, -pgid)) { try { kill(-pgid, "SIGKILL"); } catch { /* gone */ } }
      return "engine-gone";
    }
    await sleep(pollMs);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [enginePid, pgid, pollMs] = process.argv.slice(2).map(Number);
  if (Number.isSafeInteger(enginePid) && enginePid > 0 && Number.isSafeInteger(pgid) && pgid > 1) {
    watch({ enginePid, pgid, pollMs: Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 2000 }).then(() => process.exit(0), () => process.exit(0));
  } else process.exit(2);
}
