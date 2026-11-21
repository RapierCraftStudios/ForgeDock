// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statfsSync } from "node:fs";
import { join } from "node:path";

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

const LXSS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";
const readRelease = () => readFileSync("/proc/sys/kernel/osrelease", "utf8");
/** reg.exe through the WSL interop socket: systemd services lack WSL_INTEROP (same handling as the agent's resize). */
function winRun(cmd, args, env = process.env) {
  const sock = env.WSL_INTEROP ? null : (() => { try { return readdirSync("/run/WSL").filter((f) => f.endsWith("_interop")).map((f) => join("/run/WSL", f)).sort().pop() ?? null; } catch { return null; } })();
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, windowsHide: true, env: { ...env, ...(sock ? { WSL_INTEROP: sock } : {}) } });
  return r.status === 0 ? r.stdout : null;
}
/** The /mnt/<letter> drive holding the distro's vhdx: its Lxss BasePath matched by DistributionName, or null. */
function distroDrive(regOut, distro) {
  if (!regOut || !distro) return null;
  for (const block of String(regOut).split(/\r?\n(?=HKEY_)/)) {
    const name = /^\s*DistributionName\s+REG_\w+\s+(.+?)\s*$/m.exec(block)?.[1];
    if (name !== distro) continue;
    const letter = /^\s*BasePath\s+REG_\w+\s+\S*?([A-Za-z]):[\\/]/m.exec(block)?.[1];
    return letter ? `/mnt/${letter.toLowerCase()}` : null;
  }
  return null;
}
/**
 * #5733: free space of the Windows drive that backs this WSL distro's vhdx (lanes grow it; the in-VM statfs only sees
 * the vhdx's virtual size). `{ gb, path }`, or null off WSL or when unreadable (absent means unknown: no gate).
 * Drive: explicit `path` (agent cfg host_disk_path), else the distro's Lxss BasePath, else /mnt/c. All I/O is injectable.
 */
export function hostDiskFree({ path = null, osrelease = readRelease, statfs = statfsSync, run = winRun, env = process.env } = {}) {
  try {
    if (!/microsoft/i.test(String(osrelease() ?? ""))) return null;
    let drive = path;
    if (!drive) { try { drive = distroDrive(run("/mnt/c/Windows/System32/reg.exe", ["query", LXSS_KEY, "/s"], env), env.WSL_DISTRO_NAME); } catch { drive = null; } }
    drive ??= "/mnt/c";
    const f = statfs(drive);
    const gb = Math.round((Number(f.bavail) * Number(f.bsize)) / 107374182.4) / 10;
    return Number.isFinite(gb) ? { gb, path: drive } : null;
  } catch { return null; }
}
