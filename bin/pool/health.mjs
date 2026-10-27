// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";

const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 }); return r.status === 0 ? r.stdout : null; };

/** Last exit reason in journal lines, or null. Matches systemd's "Main process exited, code=killed, status=15/TERM" and oom-kill results. */
export function lastExitReason(lines) {
  let reason = null;
  for (const l of lines) {
    const m = /Main process exited, (code=\S+, status=\S+)/.exec(l) || /(Failed with result '(?:oom-kill|signal|exit-code)')/.exec(l);
    if (m) reason = m[1];
  }
  return reason;
}

/**
 * Did a systemd --user unit restart in the last hour? `run(cmd,args)` returns stdout or null (injected for tests).
 * "skip" when the unit is absent or systemd is unavailable. Restarts come from the journal because NRestarts is only cumulative.
 */
export function restartCheck({ unit, run = sh } = {}) {
  const show = run("systemctl", ["--user", "show", unit, "-p", "NRestarts", "-p", "LoadState"]);
  if (!show || /LoadState=not-found/.test(show)) return { status: "skip" };
  const total = Number(/NRestarts=(\d+)/.exec(show)?.[1] ?? 0);
  const lines = (run("journalctl", ["--user", "-u", unit, "--since", "1 hour ago", "--no-pager", "-o", "cat"]) ?? "").split("\n");
  const recent = lines.filter((l) => /Scheduled restart job/.test(l)).length;
  if (recent === 0) return { status: "pass", detail: `no restarts in the last hour (NRestarts=${total})` };
  const why = lastExitReason(lines);
  return { status: "warn", detail: `${unit} restarted ${recent}x in the last hour (NRestarts=${total})${why ? `; last exit: ${why}` : ""}. Check for OOM kills (earlyoom/systemd-oomd) under memory pressure` };
}
