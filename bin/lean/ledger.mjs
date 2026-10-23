// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lane resource ledger (#4179): `~/.forge/ledger/<batch>/<lane>.json` lists every resource a lane owns (worktree, branch,
 * run tmp, spawned pids, containers/volumes the builder reported) with owner, batch, lane, issue, created and expires.
 * Each resource is registered BEFORE it is created and released only after its teardown succeeded, so a lane that dies
 * leaves an exact record behind. A `sandbox` entry (#4253, execution.mjs) carries `{provider, handle}` (never a secret);
 * a file listing only sandboxes is a remote lane, not a lane on this host. Teardown acts only on what the ledger lists; this module itself only reads and writes
 * the ledger file (no git, gh, docker or kill calls).
 */
import * as nodeFs from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const ledgerRoot = () => join(homedir(), ".forge", "ledger");
export const LEDGER_TTL_MS = 6 * 3600 * 1000;
export const LEDGER_KINDS = Object.freeze(["worktree", "branch", "tmp", "pid", "container", "volume", "sandbox"]);
/** A path segment that cannot escape the root: [A-Za-z0-9._-] only, never "." or "..". */
export const safeSegment = (s) => { const v = String(s ?? "").replace(/[^A-Za-z0-9._-]/g, "_"); return !v || /^\.+$/.test(v) ? "_" : v; };

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };

/**
 * Live lanes on this host (#4182): lane files under `<root>/<batch>/` whose host is `host`, whose pid is alive and whose
 * expiry is in the future. A file listing only `sandbox` resources (#4253) runs off this host and is not counted. Read-only: never writes or deletes; unreadable or malformed files are skipped.
 */
export function countLiveLanes({ root = ledgerRoot(), host = hostname(), now = () => Date.now(), alive = pidAlive, fs = nodeFs } = {}) {
  let n = 0, batches = [];
  try { batches = fs.readdirSync(root); } catch { return 0; }
  for (const b of batches) {
    let names = [];
    try { names = fs.readdirSync(join(root, b)); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith(".json")) continue;
      try {
        const j = JSON.parse(fs.readFileSync(join(root, b, f), "utf8"));
        const remote = Array.isArray(j?.resources) && j.resources.length > 0 && j.resources.every((r) => r?.kind === "sandbox");
        if (j && !remote && j.host === host && Number.isSafeInteger(j.pid) && j.pid > 0 && Number(j.expires) > now() && alive(j.pid)) n++;
      } catch { /* not a lane file */ }
    }
  }
  return n;
}

/** Docker ownership labels (#4181): owner, batch, lane, issue, expires (epoch ms, as the ledger), values [A-Za-z0-9_.-] only. */
export function dockerLabels({ batch, lane, issue, expires } = {}) {
  const v = (x) => String(x ?? "").replace(/[^A-Za-z0-9_.-]/g, "-") || "unknown";
  return [`forgedock.owner=1`, `forgedock.batch=${v(batch)}`, `forgedock.lane=${v(lane)}`, `forgedock.issue=${v(issue)}`, `forgedock.expires=${v(expires)}`];
}

/** #4432: with a `repo`, the lane file is `<batch>/<owner>__<repo>__<lane>.json` (issue numbers, hence lane names, are per repo). */
export function makeLedger({ root = ledgerRoot(), batch = "adhoc", lane, owner, issue, repo = null, host = hostname(), pid = process.pid, now = () => Date.now(), ttlMs = LEDGER_TTL_MS, fs = nodeFs } = {}) {
  const dir = join(root, safeSegment(batch));
  const repoPrefix = repo ? `${String(repo).split("/").map(safeSegment).join("__")}__` : "";
  const path = join(dir, `${repoPrefix}${safeSegment(lane ?? `lane-${issue}`)}.json`);
  const read = () => { try { const j = JSON.parse(fs.readFileSync(path, "utf8")); return j && typeof j === "object" && Array.isArray(j.resources) ? j : null; } catch { return null; } };
  const write = (j) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n");
    fs.renameSync(tmp, path);
  };
  const fresh = () => { const c = now(); return { v: 1, owner, batch: String(batch), lane: String(lane ?? `lane-${issue}`), issue, ...(repo ? { repo: String(repo) } : {}), host, pid, created: c, expires: c + ttlMs, resources: [] }; };
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
