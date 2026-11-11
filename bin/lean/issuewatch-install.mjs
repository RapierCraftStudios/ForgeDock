// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock issue-watch install` (#5465): run one watch as a supervised unit, like `forgedock-schedd` (pool/install/install-schedd.sh).
 * systemd user unit with `Restart=on-failure` (a finished watch exits 0 and stays down) plus a watchdog timer that runs
 * `issue-watch watchdog` to alert on a dead heartbeat; launchd agent with `KeepAlive.SuccessfulExit=false` on macOS. No LLM calls.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const safe = (s) => String(s).replace(/[^\w.-]/g, "_");
const quote = (s) => (/[\s"\\]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s);

export const unitName = (name) => `forgedock-issue-watch-${safe(name)}`;

/** The argv after `forgedock.mjs` that runs the watch. */
const runArgs = ({ name, repo, interval }) => ["issue-watch", "run", "--name", name, ...(repo ? ["--repo", repo] : []), ...(interval ? ["--interval", String(interval)] : [])];

export function renderSystemdUnit({ node, cli, name, repo, interval, cwd }) {
  return `[Unit]
Description=forgedock issue-watch ${name}
StartLimitIntervalSec=0

[Service]
WorkingDirectory=${cwd}
ExecStart=${[node, cli, ...runArgs({ name, repo, interval })].map(quote).join(" ")}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

export function renderWatchdog({ node, cli, name, cwd }) {
  const service = `[Unit]
Description=forgedock issue-watch ${name} watchdog

[Service]
Type=oneshot
WorkingDirectory=${cwd}
ExecStart=${[node, cli, "issue-watch", "watchdog"].map(quote).join(" ")}
`;
  const timer = `[Unit]
Description=forgedock issue-watch ${name} watchdog

[Timer]
OnBootSec=60
OnUnitActiveSec=60s

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

export function renderLaunchdPlist({ node, cli, name, repo, interval, cwd }) {
  const args = [node, cli, ...runArgs({ name, repo, interval })].map((a) => `    <string>${String(a).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.forgedock.issue-watch.${safe(name)}</string>
  <key>ProgramArguments</key><array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${cwd}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
</dict></plist>
`;
}

/** Writes and starts the unit; `{files, platform}`. `run(cmd, args)` and `write(path, text)` are injectable. */
export function installWatchUnit({ name, repo, interval, cwd = process.cwd(), node = process.execPath, cli, platform = process.platform, home = homedir(), run = (c, a) => spawnSync(c, a, { stdio: "ignore" }), write = (p, t) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); } }) {
  const o = { node, cli, name, repo, interval, cwd }, files = [];
  if (platform === "darwin") {
    const f = join(home, "Library", "LaunchAgents", `com.forgedock.issue-watch.${safe(name)}.plist`);
    write(f, renderLaunchdPlist(o)); files.push(f);
    run("launchctl", ["unload", f]); run("launchctl", ["load", "-w", f]);
    return { files, platform };
  }
  if (platform !== "linux") throw new Error(`issue-watch install: unsupported platform ${platform} (systemd or launchd only)`);
  const dir = join(home, ".config", "systemd", "user"), u = unitName(name), w = renderWatchdog(o);
  for (const [n, t] of [[`${u}.service`, renderSystemdUnit(o)], [`${u}-watchdog.service`, w.service], [`${u}-watchdog.timer`, w.timer]]) { write(join(dir, n), t); files.push(join(dir, n)); }
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", `${u}.service`]);
  run("systemctl", ["--user", "enable", "--now", `${u}-watchdog.timer`]);
  return { files, platform };
}
