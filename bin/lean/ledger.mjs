// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lane resource ledger (#4179): `~/.forge/ledger/<batch>/<lane>.json` lists every resource a lane owns (worktree, branch,
 * run tmp, spawned pids, containers/volumes the builder reported) with owner, batch, lane, issue, created and expires.
 * Each resource is registered BEFORE it is created and released only after its teardown succeeded, so a lane that dies
 * leaves an exact record behind. Teardown acts only on what the ledger lists; this module itself only reads and writes
 * the ledger file (no git, gh, docker or kill calls).
 */
import * as nodeFs from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const ledgerRoot = () => join(homedir(), ".forge", "ledger");
export const LEDGER_TTL_MS = 6 * 3600 * 1000;
export const LEDGER_KINDS = Object.freeze(["worktree", "branch", "tmp", "pid", "container", "volume"]);
/** A path segment that cannot escape the root: [A-Za-z0-9._-] only, never "." or "..". */
export const safeSegment = (s) => { const v = String(s ?? "").replace(/[^A-Za-z0-9._-]/g, "_"); return !v || /^\.+$/.test(v) ? "_" : v; };

export function makeLedger({ root = ledgerRoot(), batch = "adhoc", lane, owner, issue, host = hostname(), pid = process.pid, now = () => Date.now(), ttlMs = LEDGER_TTL_MS, fs = nodeFs } = {}) {
  const dir = join(root, safeSegment(batch));
  const path = join(dir, `${safeSegment(lane ?? `lane-${issue}`)}.json`);
  const read = () => { try { const j = JSON.parse(fs.readFileSync(path, "utf8")); return j && typeof j === "object" && Array.isArray(j.resources) ? j : null; } catch { return null; } };
  const write = (j) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n");
    fs.renameSync(tmp, path);
  };
  const fresh = () => { const c = now(); return { v: 1, owner, batch: String(batch), lane: String(lane ?? `lane-${issue}`), issue, host, pid, created: c, expires: c + ttlMs, resources: [] }; };
  const same = (r, kind, value) => r.kind === kind && String(r.value) === String(value);
  return {
    path,
    read,
    /** Idempotent; call BEFORE the resource is created. `extra` (e.g. {marker}) is kept on the entry. */
    register(kind, value, extra = {}) {
      if (!LEDGER_KINDS.includes(kind) || value == null || value === "") return false;
      const j = read() ?? fresh();
      Object.assign(j, { owner, host, pid, expires: now() + ttlMs });
      if (!j.resources.some((r) => same(r, kind, value))) j.resources.push({ kind, value, ...extra, registered: now() });
      write(j);
      return true;
    },
    release(kind, value) {
      const j = read();
      if (!j) return false;
      const n = j.resources.length;
      j.resources = j.resources.filter((r) => !same(r, kind, value));
      if (j.resources.length !== n) write(j);
      return j.resources.length !== n;
    },
    entries(kind) { return (read()?.resources ?? []).filter((r) => !kind || r.kind === kind); },
    /** Delete the file only when it lists nothing; a non-empty ledger stays for the next run or the reaper. */
    remove() {
      const j = read();
      if (j && j.resources.length) return false;
      try { fs.rmSync(path, { force: true }); } catch { return false; }
      return true;
    },
  };
}
