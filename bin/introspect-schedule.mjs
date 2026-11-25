// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Daily `fd-introspect --file-issues` (#5987): the lean-lane test-quality trend (`forgedock stats --conformance-outcomes`) run on a
 * systemd user timer, with a tagged cron entry as the fallback, modelled on gc-schedule.mjs. Installed by `doctor --fix` and
 * `forgedock init`. Findings are filed (deduped against open issues and prior reports) only when `orchestrate.slo.file_issues`
 * is true; `enabled` false removes the entry. All I/O is injected (`exec`, `fs`). Never throws.
 */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const CRON_TAG = "# forgedock-introspect";
const ARGS = "stats --conformance-outcomes --file-issues";

export const unitName = (cwd) => `forgedock-introspect-${createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 8)}`;
const q = (s) => `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;
const forgedockBin = () => join(dirname(fileURLToPath(import.meta.url)), "forgedock.mjs");

export function renderSystemd({ cwd, node = process.execPath, bin = forgedockBin() }) {
  return {
    service: `[Unit]\nDescription=ForgeDock introspect, files findings (${resolve(cwd)})\n\n[Service]\nType=oneshot\nWorkingDirectory=${resolve(cwd)}\nExecStart=${q(node)} ${q(bin)} ${ARGS}\n`,
    timer: `[Unit]\nDescription=ForgeDock introspect daily\n\n[Timer]\nOnCalendar=daily\nRandomizedDelaySec=30min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

export function renderCron({ cwd, node = process.execPath, bin = forgedockBin() }) {
  return `17 4 * * * cd ${q(resolve(cwd))} && ${q(node)} ${q(bin)} ${ARGS} >/dev/null 2>&1 ${CRON_TAG} ${resolve(cwd)}`;
}

/** Install (or remove) the daily run. @returns {status: installed|removed|off|failed, kind, detail} */
export async function installIntrospectSchedule({ enabled = true, cwd = process.cwd(), home = homedir(), platform = process.platform, fs = nodeFs, exec = async (cmd, args, input) => { const p = pexec(cmd, args, { timeout: 30000 }); if (input != null) p.child.stdin.end(input); return (await p).stdout; }, node, bin } = {}) {
  const name = unitName(cwd), dir = join(home, ".config", "systemd", "user");
  const opts = { cwd, ...(node ? { node } : {}), ...(bin ? { bin } : {}) };
  try {
    if (platform === "linux") {
      let hasSystemd = false;
      try { await exec("systemctl", ["--user", "show-environment"]); hasSystemd = true; } catch { hasSystemd = false; }
      if (hasSystemd) {
        if (!enabled) {
          if (!fs.existsSync(join(dir, `${name}.timer`))) return { status: "off", kind: "systemd", detail: "not enabled" };
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
        return { status: "installed", kind: "systemd", detail: `${name}.timer daily` };
      }
    }
    let cur = "";
    try { cur = String(await exec("crontab", ["-l"])); } catch { cur = ""; }
    const mine = (l) => l.trimEnd().endsWith(`${CRON_TAG} ${resolve(cwd)}`);
    const all = cur.split("\n").filter((l) => l.trim()), rest = all.filter((l) => !mine(l));
    if (!enabled && rest.length === all.length) return { status: "off", kind: "cron", detail: "not enabled" };
    await exec("crontab", ["-"], [...rest, ...(enabled ? [renderCron(opts)] : [])].join("\n") + "\n");
    return enabled ? { status: "installed", kind: "cron", detail: "crontab entry daily" } : { status: "removed", kind: "cron", detail: "removed crontab entry" };
  } catch (e) {
    return { status: "failed", kind: "unknown", detail: String(e?.message ?? e).slice(0, 200) };
  }
}
