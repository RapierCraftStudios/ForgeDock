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
const ARGS = "--run"; // this file is the entry: runs the introspect report and files it (see runIntrospect)

export const introspectUnitName = (cwd) => `forgedock-introspect-${createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 8)}`;
const q = (s) => `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;
const SELF = fileURLToPath(import.meta.url);
const forgedockBin = () => join(dirname(SELF), "forgedock.mjs");

export function renderIntrospectSystemd({ cwd, node = process.execPath, bin = forgedockBin() }) {
  return {
    service: `[Unit]\nDescription=ForgeDock introspect, files findings (${resolve(cwd)})\n\n[Service]\nType=oneshot\nWorkingDirectory=${resolve(cwd)}\nExecStart=${q(node)} ${q(SELF)} ${ARGS}\n`,
    timer: `[Unit]\nDescription=ForgeDock introspect daily\n\n[Timer]\nOnCalendar=daily\nRandomizedDelaySec=30min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

export function renderIntrospectCron({ cwd, node = process.execPath, bin = forgedockBin() }) {
  return `17 4 * * * cd ${q(resolve(cwd))} && ${q(node)} ${q(SELF)} ${ARGS} >/dev/null 2>&1 ${CRON_TAG} ${resolve(cwd)}`;
}

/** Install (or remove) the daily run. @returns {status: installed|removed|off|failed, kind, detail} */
export async function installIntrospectSchedule({ enabled = true, cwd = process.cwd(), home = homedir(), platform = process.platform, fs = nodeFs, exec = async (cmd, args, input) => { const p = pexec(cmd, args, { timeout: 30000 }); if (input != null) p.child.stdin.end(input); return (await p).stdout; }, node, bin } = {}) {
  const name = introspectUnitName(cwd), dir = join(home, ".config", "systemd", "user");
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
        const { service, timer } = renderIntrospectSystemd(opts);
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
    await exec("crontab", ["-"], [...rest, ...(enabled ? [renderIntrospectCron(opts)] : [])].join("\n") + "\n");
    return enabled ? { status: "installed", kind: "cron", detail: "crontab entry daily" } : { status: "removed", kind: "cron", detail: "removed crontab entry" };
  } catch (e) {
    return { status: "failed", kind: "unknown", detail: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * One introspect run: `forgedock stats --conformance-outcomes`, its report saved under `<home>/.forge/introspect/`, then filed
 * (deduped, see slo.fileIntrospect) when `orchestrate.slo.file_issues` is on. State `filed.json` holds the last filed report hash.
 */
export async function runIntrospect({ cwd = process.cwd(), home = homedir(), fs = nodeFs, run = async () => String((await pexec(process.execPath, [forgedockBin(), "stats", "--conformance-outcomes"], { cwd, timeout: 300000, maxBuffer: 8 << 20 })).stdout), gh = async (a) => String((await pexec("gh", a, { timeout: 30000 })).stdout), now = Date.now() } = {}) {
  try {
    const [{ parseSloConfig, fileIntrospect }, { parseForgeYaml }] = await Promise.all([import("./lean/slo.mjs"), import("./forge-utils.mjs")]);
    let cfg; try { cfg = parseSloConfig(parseForgeYaml(fs.readFileSync(join(cwd, "forge.yaml"), "utf8"))); } catch { cfg = parseSloConfig({}); }
    const report = await run(), dir = join(home, ".forge", "introspect"), scope = introspectUnitName(cwd).slice(-8);
    fs.mkdirSync(dir, { recursive: true });
    const reportPath = join(dir, `${new Date(now).toISOString().slice(0, 10)}-${scope}.txt`);
    fs.writeFileSync(reportPath, report);
    if (!cfg.fileIssues) return { action: "disabled", reportPath };
    const stateFile = join(dir, `filed-${scope}.json`);
    let prior = null; try { prior = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { prior = null; }
    const r = await fileIntrospect({ report, scope, gh, cfg, prior, reportPath });
    if (r.hash && ["create", "comment"].includes(r.action)) fs.writeFileSync(stateFile, JSON.stringify({ hash: r.hash, issue: r.issue }));
    return { ...r, reportPath };
  } catch (e) { return { action: "failed", detail: String(e?.message ?? e).slice(0, 200) }; }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF && process.argv.includes("--run")) {
  runIntrospect().then((r) => { console.log(`introspect: ${r.action}${r.reportPath ? ` ${r.reportPath}` : ""}`); });
}
