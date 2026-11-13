// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock issue-watch install` (#5465): run one watch as a supervised unit, like `forgedock-schedd` (pool/install/install-schedd.sh).
 * systemd user unit with `Restart=on-failure` (a finished watch exits 0 and stays down) plus a watchdog timer that runs
 * `issue-watch watchdog` to alert on a dead heartbeat; launchd agent with `KeepAlive.SuccessfulExit=false` on macOS. No LLM calls.
 * #5529: the unit carries the lane environment (PATH with claude first, TMPDIR, TOKENBATON_*, no CLAUDE_CONFIG_DIR) and reads the
 * computeshare token when it starts; the token value is never written into the unit.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveOnPath } from "./issuewatch-parity.mjs";
import { isShim } from "./rotator.mjs";

const safe = (s) => String(s).replace(/[^\w.-]/g, "_");
const quote = (s) => (/[\s"\\]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s);

export const watchUnitName = (name) => `forgedock-issue-watch-${safe(name)}`;

/** The router's token *file path* (never its value): `forgedock_token_file` of the computeshare router config, else its sibling `forgedock.token`. */
export function routerTokenFile({ env = process.env, home = homedir(), read = (p) => readFileSync(p, "utf8") } = {}) {
  const conf = env.COMPUTESHARE_CONFIG || join(home, ".config", "computeshare", "router.json");
  try { const p = JSON.parse(read(conf))?.forgedock_token_file; if (typeof p === "string" && p) return p; } catch { /* no router config: the sibling path */ }
  return join(dirname(conf), "forgedock.token");
}

/**
 * #5529: the lane environment a supervised watch needs (systemd and launchd start it with almost none, so its lanes failed
 * `Failed to find executable claude`): PATH with the tokenbaton shim and the resolved `claude` dirs first, then the installer's PATH;
 * TMPDIR; TOKENBATON_HOME / TOKENBATON_SWITCH_AT when set. `tokenFile` is where the computeshare token is read at start (a path only).
 * @returns {{vars: Record<string,string>, unset: string[], tokenFile: string, claude: string|null}}
 */
export function resolveLaneEnv({ env = process.env, home = homedir(), exists = existsSync } = {}) {
  const claude = resolveOnPath("claude", env.PATH);
  const shims = [env.TOKENBATON_HOME && join(env.TOKENBATON_HOME, "shim"), join(home, ".tokenbaton", "shim")].filter((d) => d && exists(join(d, "claude")));
  const dirs = [...(claude && isShim(claude) ? [dirname(claude)] : []), ...shims, ...(claude ? [dirname(claude)] : []), ...String(env.PATH ?? "").split(":"), "/usr/local/bin", "/usr/bin", "/bin"];
  const vars = { PATH: [...new Set(dirs.filter(Boolean))].join(":"), TMPDIR: env.TMPDIR || "/tmp" };
  for (const k of ["TOKENBATON_HOME", "TOKENBATON_SWITCH_AT"]) if (env[k]) vars[k] = env[k];
  return { vars, unset: ["CLAUDE_CONFIG_DIR"], tokenFile: routerTokenFile({ env, home }), claude };
}

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
/** sh run at unit start: COMPUTESHARE_TOKEN from the keychain (pool/install/install-router.sh), else the router token file, then exec the watch. */
export const tokenStartScript = (tokenFile) =>
  't="${COMPUTESHARE_TOKEN:-}"; [ -n "$t" ] || t=$(secret-tool lookup service forgedock account COMPUTESHARE_TOKEN 2>/dev/null) || t=; ' +
  '[ -n "$t" ] || t=$(cat ' + shq(tokenFile) + ' 2>/dev/null) || t=; [ -n "$t" ] && export COMPUTESHARE_TOKEN="$t"; exec "$@"';
/** One systemd word in double quotes; `$` and `%` are doubled so systemd passes them through verbatim. */
const sdArg = (s) => '"' + String(s).replace(/(["\\])/g, "\\$1").replace(/[$%]/g, (c) => c + c) + '"';

/** The argv after `forgedock.mjs` that runs the watch. */
const runArgs = ({ name, repo, interval }) => ["issue-watch", "run", "--name", name, ...(repo ? ["--repo", repo] : []), ...(interval ? ["--interval", String(interval)] : [])];

export function renderSystemdUnit({ node, cli, name, repo, interval, cwd, laneEnv = null }) {
  const argv = [node, cli, ...runArgs({ name, repo, interval })].map(quote).join(" ");
  const env = laneEnv ? [...Object.entries(laneEnv.vars).map(([k, v]) => `Environment=${sdArg(`${k}=${v}`)}`), `UnsetEnvironment=${laneEnv.unset.join(" ")}`, ""].join("\n") : "";
  const exec = laneEnv ? `/bin/sh -c ${sdArg(tokenStartScript(laneEnv.tokenFile))} forgedock-issue-watch ${argv}` : argv;
  return `[Unit]
Description=forgedock issue-watch ${name}
StartLimitIntervalSec=0

[Service]
WorkingDirectory=${cwd}
${env}ExecStart=${exec}
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

export function renderLaunchdPlist({ node, cli, name, repo, interval, cwd, laneEnv = null }) {
  const x = (a) => String(a).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const args = [node, cli, ...runArgs({ name, repo, interval })].map((a) => `    <string>${x(a)}</string>`).join("\n");
  // launchd agents run in the login session, so the lane reads the token from the keychain itself; no value here
  const env = laneEnv ? `  <key>EnvironmentVariables</key><dict>${Object.entries(laneEnv.vars).map(([k, v]) => `<key>${x(k)}</key><string>${x(v)}</string>`).join("")}</dict>\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.forgedock.issue-watch.${safe(name)}</string>
  <key>ProgramArguments</key><array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${cwd}</string>
${env}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
</dict></plist>
`;
}

/** Writes and starts the unit; `{files, platform, claude}`. `run(cmd, args)` and `write(path, text)` are injectable; `env` is the installer's environment. */
export function installWatchUnit({ name, repo, interval, cwd = process.cwd(), node = process.execPath, cli, platform = process.platform, home = homedir(), env = process.env, run = (c, a) => spawnSync(c, a, { stdio: "ignore" }), write = (p, t) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); } }) {
  const laneEnv = resolveLaneEnv({ env, home }), o = { node, cli, name, repo, interval, cwd, laneEnv }, files = [];
  if (platform === "darwin") {
    const f = join(home, "Library", "LaunchAgents", `com.forgedock.issue-watch.${safe(name)}.plist`);
    write(f, renderLaunchdPlist(o)); files.push(f);
    run("launchctl", ["unload", f]); run("launchctl", ["load", "-w", f]);
    return { files, platform, claude: laneEnv.claude };
  }
  if (platform !== "linux") throw new Error(`issue-watch install: unsupported platform ${platform} (systemd or launchd only)`);
  const dir = join(home, ".config", "systemd", "user"), u = watchUnitName(name), w = renderWatchdog(o);
  for (const [n, t] of [[`${u}.service`, renderSystemdUnit(o)], [`${u}-watchdog.service`, w.service], [`${u}-watchdog.timer`, w.timer]]) { write(join(dir, n), t); files.push(join(dir, n)); }
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", `${u}.service`]);
  run("systemctl", ["--user", "enable", "--now", `${u}-watchdog.timer`]);
  return { files, platform, claude: laneEnv.claude };
}
