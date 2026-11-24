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

/** #5923: WSL mirrored networking gives the guest a narrow source-port slice; docker MASQUERADE must stay inside it or replies drop. */
const DEFAULT_RANGE = [32768, 60999];
const NAT_BRIDGE_FMT = '{{.Name}}|{{index .Options "com.docker.network.bridge.name"}}|{{range .IPAM.Config}}{{.Subnet}} {{end}}';
const parseRange = (s) => { const m = /(\d+)\s+(\d+)/.exec(String(s ?? "")); return m ? [Number(m[1]), Number(m[2])] : null; };
const narrow = (r) => Boolean(r) && (r[0] > DEFAULT_RANGE[0] || r[1] < DEFAULT_RANGE[1]);

/** iptables arg lists (tcp and udp per subnet) pinning NAT source ports to `range` ([lo, hi]); subnets are {subnet, bridge}. */
export function natPinRules(range, subnets) {
  const [lo, hi] = range;
  return subnets.flatMap(({ subnet, bridge }) => ["tcp", "udp"].map((proto) => ["-t", "nat", "-I", "POSTROUTING", "1", "-s", subnet, "!", "-o", bridge, "-p", proto, "-j", "MASQUERADE", "--to-ports", `${lo}-${hi}`]));
}
const checkArgs = (rule) => ["-t", "nat", "-C", "POSTROUTING", ...rule.slice(5)];

/** Same rules as the installed script: the script text below is embedded verbatim in pool/install/install-agent.sh. */
export function natPinScript() {
  return `#!/bin/sh
# cs-nat-portrange: pin docker NAT source ports to the guest ip_local_port_range (WSL mirrored networking)
set -eu
set -- $(sysctl -n net.ipv4.ip_local_port_range) || exit 0
lo=$1; hi=$2
[ "$lo" -gt 32768 ] || [ "$hi" -lt 60999 ] || exit 0
docker network ls --filter driver=bridge -q | while read -r id; do
  info=$(docker network inspect -f '${NAT_BRIDGE_FMT}' "$id") || continue
  name=\${info%%|*}; rest=\${info#*|}; bridge=\${rest%%|*}; subnets=\${rest#*|}
  if [ -z "$bridge" ]; then if [ "$name" = bridge ]; then bridge=docker0; else bridge="br-$(echo "$id" | cut -c1-12)"; fi; fi
  for subnet in $subnets; do
    case "$subnet" in *:*) continue ;; esac
    for proto in tcp udp; do
      iptables -t nat -C POSTROUTING -s "$subnet" ! -o "$bridge" -p "$proto" -j MASQUERADE --to-ports "$lo-$hi" 2>/dev/null ||
        iptables -t nat -I POSTROUTING 1 -s "$subnet" ! -o "$bridge" -p "$proto" -j MASQUERADE --to-ports "$lo-$hi"
    done
  done
done
`;
}
export function natPinUnit() {
  return `[Unit]
Description=Pin docker NAT source ports to the WSL guest port range
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/cs-nat-portrange

[Install]
WantedBy=docker.service
`;
}

/** Every bridge network docker has (default 172.17.0.0/16 plus each custom one) as [{subnet, bridge}] (IPv4 only). */
export function bridgeSubnets({ run = sh } = {}) {
  const out = [];
  const ids = (run("docker", ["network", "ls", "--filter", "driver=bridge", "-q"]) ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (const id of ids) {
    const info = (run("docker", ["network", "inspect", "-f", NAT_BRIDGE_FMT, id]) ?? "").trim();
    const [name, opt, subs] = info.split("|");
    if (subs === undefined) continue;
    const bridge = opt || (name === "bridge" ? "docker0" : `br-${id.slice(0, 12)}`);
    for (const subnet of subs.split(/\s+/).filter((s) => s && !s.includes(":"))) out.push({ subnet, bridge });
  }
  if (!out.length) out.push({ subnet: "172.17.0.0/16", bridge: "docker0" });
  return out;
}

const guestRange = (run, read) => parseRange(run("sysctl", ["-n", "net.ipv4.ip_local_port_range"])) ?? (() => { try { return parseRange(read("/proc/sys/net/ipv4/ip_local_port_range")); } catch { return null; } })();
const isWsl = (osrelease) => { try { return /microsoft/i.test(String(osrelease() ?? "")); } catch { return false; } };
const isMirrored = (run, range) => { const m = run("wslinfo", ["--networking-mode"]); return m !== null ? /mirrored/i.test(m) : narrow(range); };

/** Idempotent: `iptables -C` before `-I`, per rule. `{ applied, range }`, or null when not a mirrored WSL guest. */
export function ensureNatPin({ run = sh, read = (p) => readFileSync(p, "utf8"), osrelease = readRelease } = {}) {
  if (!isWsl(osrelease)) return null;
  const range = guestRange(run, read);
  if (!range || !isMirrored(run, range)) return null;
  let applied = 0;
  for (const rule of natPinRules(range, bridgeSubnets({ run }))) {
    if (run("iptables", checkArgs(rule)) !== null) continue;
    if (run("iptables", rule) !== null) applied++;
  }
  return { applied, range: `${range[0]}-${range[1]}` };
}

/** `/health` net block: `{ mirrored, port_range, nat_pin, degraded }`; degraded = mirrored without the pin. Off WSL: not mirrored, not degraded. */
export function netState({ osrelease = readRelease, read = (p) => readFileSync(p, "utf8"), run = sh } = {}) {
  const off = { mirrored: false, port_range: null, nat_pin: null, degraded: false };
  try {
    if (!isWsl(osrelease)) return off;
    const range = guestRange(run, read);
    if (!isMirrored(run, range)) return { ...off, port_range: range ? `${range[0]}-${range[1]}` : null };
    const pinned = Boolean(range) && natPinRules(range, bridgeSubnets({ run })).every((r) => run("iptables", checkArgs(r)) !== null);
    return { mirrored: true, port_range: range ? `${range[0]}-${range[1]}` : null, nat_pin: pinned, degraded: !pinned };
  } catch { return off; }
}
