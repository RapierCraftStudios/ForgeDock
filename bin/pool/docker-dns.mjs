// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6195: on WSL2 mirrored networking dockerd's resolver (the WSL proxy, 10.255.255.254) can fail while the host resolver works.
import { readFileSync, writeFileSync } from "node:fs";

/** dockerd's own resolver failing: "lookup ghcr.io on 10.255.255.254:53: no such host" / "server misbehaving". */
export const DNS_FAIL_RE = /lookup \S+ on [0-9a-f.:]+:53: (no such host|server misbehaving)/i;

/**
 * Write public resolvers into daemon.json `dns` (other keys kept; a `dns` already set is left alone), then restart docker
 * only while the agent is idle. Returns {changed, restarted}. Never throws on an unreadable/unwritable file: reports no change.
 */
export async function ensureDaemonDns({ file = "/etc/docker/daemon.json", dns = ["1.1.1.1", "8.8.8.8"], restart = async () => {}, idle = () => false, log = null } = {}) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(file, "utf8") || "{}"); } catch (e) { if (e?.code !== "ENOENT") { log?.warn?.(`daemon.json unreadable: ${e.message}`); return { changed: false, restarted: false }; } }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return { changed: false, restarted: false };
  if (Array.isArray(cfg.dns) && cfg.dns.length) return { changed: false, restarted: false };
  try { writeFileSync(file, `${JSON.stringify({ ...cfg, dns }, null, 2)}\n`); } catch (e) { log?.warn?.(`cannot write ${file}: ${e.message}`); return { changed: false, restarted: false }; }
  log?.info?.(`docker daemon DNS set to ${dns.join(", ")} in ${file}`);
  if (!idle()) { log?.warn?.("docker not restarted: sandboxes are running; the new DNS applies at the next restart"); return { changed: true, restarted: false }; }
  try { await restart(); } catch (e) { log?.warn?.(`docker restart failed: ${e.message}`); return { changed: true, restarted: false }; }
  return { changed: true, restarted: true };
}
