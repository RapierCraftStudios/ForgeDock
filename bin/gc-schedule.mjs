// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Scheduled hygiene outside batches (#5421): `forgedock gc --apply` (owned scope only) on a systemd user timer, with a cron
 * entry as the fallback, driven by forge.yaml `hygiene.schedule` ("6h", "30m", "2d"). Installed by `doctor --fix` and
 * `forgedock init`. An empty schedule or `hygiene.auto_gc: false` removes the entry. All I/O is injected (`exec`, `fs`).
 */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDuration } from "./gc.mjs";

const pexec = promisify(execFile);
const CRON_TAG = "# forgedock-gc";

/** Unit basename for one repo: `forgedock-gc-<8 hex of the repo path>`. */
export const unitName = (cwd) => `forgedock-gc-${createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 8)}`;

const q = (s) => `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;
const forgedockBin = () => join(dirname(fileURLToPath(import.meta.url)), "forgedock.mjs");

/** systemd service + timer text. OnUnitActiveSec is the schedule; Persistent catches up a run missed while the host was off. */
export function renderSystemd({ schedule, cwd, node = process.execPath, bin = forgedockBin() }) {
  const min = Math.max(1, Math.round(parseDuration(schedule) / 60000));
  return {
    service: `[Unit]\nDescription=ForgeDock owned-resource GC (${resolve(cwd)})\n\n[Service]\nType=oneshot\nWorkingDirectory=${resolve(cwd)}\nExecStart=${q(node)} ${q(bin)} gc --apply\n`,
    timer: `[Unit]\nDescription=ForgeDock owned-resource GC every ${schedule}\n\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=${min}min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

/** One crontab line (tagged so it can be replaced or removed): minutes < 60, whole hours < 24, else daily. */
export function renderCron({ schedule, cwd, node = process.execPath, bin = forgedockBin() }) {
  const min = Math.max(1, Math.round(parseDuration(schedule) / 60000));
  const when = min < 60 ? `*/${min} * * * *` : min < 1440 ? `0 */${Math.max(1, Math.round(min / 60))} * * *` : "0 0 * * *";
  return `${when} cd ${q(resolve(cwd))} && ${q(node)} ${q(bin)} gc --apply >/dev/null 2>&1 ${CRON_TAG} ${resolve(cwd)}`;
}

/**
 * Install (or remove) the schedule. `enabled` is hygiene.auto_gc. Returns {status, kind, detail}; status is
 * installed | removed | off | failed. Never throws.
 */
export async function installGcSchedule({ schedule = "", enabled = true, cwd = process.cwd(), home = homedir(), platform = process.platform, fs = nodeFs, exec = async (cmd, args, input) => { const p = pexec(cmd, args, { timeout: 30000 }); if (input != null) p.child.stdin.end(input); return (await p).stdout; }, node, bin } = {}) {
  const name = unitName(cwd);
  const dir = join(home, ".config", "systemd", "user");
  const want = enabled && !!schedule;
  const opts = { schedule, cwd, ...(node ? { node } : {}), ...(bin ? { bin } : {}) };
  try {
    if (platform === "linux") {
      let hasSystemd = false;
      try { await exec("systemctl", ["--user", "show-environment"]); hasSystemd = true; } catch { hasSystemd = false; }
      if (hasSystemd) {
        if (!want) {
          if (!fs.existsSync(join(dir, `${name}.timer`))) return { status: "off", kind: "systemd", detail: "no schedule set" };
          try { await exec("systemctl", ["--user", "disable", "--now", `${name}.timer`]); } catch { /* already gone */ }
          for (const f of [`${name}.timer`, `${name}.service`]) fs.rmSync(join(dir, f), { force: true });
          return { status: "removed", kind: "systemd", detail: `removed ${name}.timer` };
        }
        const { service, timer } = renderSystemd(opts);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(join(dir, `${name}.service`), service);
        fs.writeFileSync(join(dir, `${name}.timer`), timer);
        await exec("systemctl", ["--user", "daemon-reload"]);
        await exec("systemctl", ["--user", "enable", "--now", `${name}.timer`]);
        return { status: "installed", kind: "systemd", detail: `${name}.timer every ${schedule}` };
      }
    }
    // cron fallback: replace our tagged line for this repo, keep every other line.
    let cur = "";
    try { cur = String(await exec("crontab", ["-l"])); } catch { cur = ""; }
    const mine = (l) => l.includes(`${CRON_TAG} ${resolve(cwd)}`);
    const rest = cur.split("\n").filter((l) => l.trim() && !mine(l));
    if (!want && rest.length === cur.split("\n").filter((l) => l.trim()).length) return { status: "off", kind: "cron", detail: "no schedule set" };
    const next = [...rest, ...(want ? [renderCron(opts)] : [])];
    await exec("crontab", ["-"], next.join("\n") + "\n");
    return want ? { status: "installed", kind: "cron", detail: `crontab entry every ${schedule}` } : { status: "removed", kind: "cron", detail: "removed crontab entry" };
  } catch (e) {
    return { status: "failed", kind: "unknown", detail: String(e?.message ?? e).slice(0, 200) };
  }
}
