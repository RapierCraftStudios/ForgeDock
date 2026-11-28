// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6195/#6234: on WSL2 mirrored networking dockerd's resolver (the WSL proxy, 10.255.255.254) can fail while the host resolver works.
// Lane containers get a per-container `--dns` (agent netArgs), which never touches the shared daemon. Only the daemon's own pulls need the
// daemon-wide fallback, and a dockerd restart kills every container on it, so it runs only when provably nothing else is on the daemon.
import { readFileSync, writeFileSync } from "node:fs";

/** dockerd's own resolver failing: "lookup ghcr.io on 10.255.255.254:53: no such host" / "server misbehaving". */
export const DNS_FAIL_RE = /lookup \S+ on [0-9a-f.:]+:53: (no such host|server misbehaving)/i;

/**
 * Repair dockerd's resolver for the agent's own pulls. Order matters and is atomic against admission:
 *   1. `hold()` pauses admission on the agent (returns a release function; called in a finally),
 *   2. `idle()` (sync or async) must say that no sandbox is active AND no container at all (co-tenants included) runs on the daemon,
 *   3. only then daemon.json `dns` is written (other keys kept; a `dns` already set is left alone) and docker restarted.
 * Not idle, an unreadable file or a failed restart: daemon.json is left (or put back) as it was, so no resolver is pinned without a restart.
 * Returns {changed, restarted, reason?}. Never throws.
 */
export async function ensureDaemonDns({ file = "/etc/docker/daemon.json", dns = ["1.1.1.1", "8.8.8.8"], restart = async () => {}, idle = () => false, hold = () => () => {}, log = null } = {}) {
  let release = () => {};
  try { release = hold() ?? release; } catch (e) { log?.warn?.(`docker DNS repair: cannot pause admission: ${e.message}`); return { changed: false, restarted: false, reason: "hold" }; }
  try {
    let raw = "", cfg = {};
    try { raw = readFileSync(file, "utf8"); cfg = JSON.parse(raw || "{}"); } catch (e) { if (e?.code !== "ENOENT") { log?.warn?.(`daemon.json unreadable: ${e.message}`); return { changed: false, restarted: false, reason: "unreadable" }; } raw = ""; }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return { changed: false, restarted: false, reason: "unreadable" };
    if (Array.isArray(cfg.dns) && cfg.dns.length) return { changed: false, restarted: false, reason: "dns-set" };
    let quiet = false;
    try { quiet = (await idle()) === true; } catch { quiet = false; }
    if (!quiet) { log?.warn?.("docker not restarted: sandboxes or other containers are running; lane containers use per-container --dns, daemon.json is untouched"); return { changed: false, restarted: false, reason: "busy" }; }
    try { writeFileSync(file, `${JSON.stringify({ ...cfg, dns }, null, 2)}\n`); } catch (e) { log?.warn?.(`cannot write ${file}: ${e.message}`); return { changed: false, restarted: false, reason: "unwritable" }; }
    try { await restart(); } catch (e) {
      log?.warn?.(`docker restart failed: ${e.message}; daemon.json restored`);
      try { writeFileSync(file, raw || "{}\n"); } catch { /* best effort */ }
      return { changed: false, restarted: false, reason: "restart-failed" };
    }
    log?.info?.(`docker daemon DNS set to ${dns.join(", ")} in ${file}; docker restarted while idle`);
    return { changed: true, restarted: true };
  } finally { try { release(); } catch { /* ignore */ } }
}
