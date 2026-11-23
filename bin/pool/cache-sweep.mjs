// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5757: cache volume hygiene for pool agents. The planners are pure (imported by the agent and unit tests); the sweep
// itself runs inside a short-lived container of the lane image with the cache volume on /cache. The agent ships this
// file's source in CS_CACHE_SWEEP_SRC and the options in CS_CACHE_SWEEP_OPTS; the JSON result goes to stdout.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const CACHE_LABEL = "computeshare.cache=1";
/** #5881: owner label; the reaper and sweeps touch only containers and volumes carrying their own agent's label. */
export const agentLabel = (id) => `computeshare.agent=${id}`;
const DAY = 86400000;
const LOCK_LIVE_MS = 2 * 3600000; // a depcache key lock younger than this may belong to a running install or lane

/**
 * Oldest-first deletion plan to bring `entries` ({path, bytes, mtimeMs, live}) under `capBytes`. Live entries (the work
 * dirs of running sandboxes) count towards the total and are never chosen. Returns {delete, total, after}.
 */
export function planCacheCap(entries, capBytes) {
  const total = entries.reduce((a, e) => a + (e.bytes || 0), 0);
  if (!Number.isFinite(capBytes) || capBytes < 0 || total <= capBytes) return { delete: [], total, after: total };
  let after = total;
  const out = [];
  for (const e of entries.filter((x) => !x.live).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (after <= capBytes) break;
    out.push(e.path);
    after -= e.bytes || 0;
  }
  return { delete: out, total, after };
}

/**
 * Cache volumes to remove: last use known (`lastUsedMs` a number), older than `idleMs`, no sandbox record references
 * it and it is not in the never-evict list. `volumes` is [{name, lastUsedMs}].
 */
export function planIdleEviction({ volumes, referenced = new Set(), neverEvict = [], now, idleMs }) {
  const never = new Set(neverEvict);
  return volumes.filter((v) => Number.isFinite(v.lastUsedMs) && now - v.lastUsedMs > idleMs && !referenced.has(v.name) && !never.has(v.name)).map((v) => v.name);
}

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; } };
const sizeOf = (p) => (Number(sh("du", ["-sk", p]).split(/\s/)[0]) || 0) * 1024;
const kids = (dir) => sh("find", [dir, "-mindepth", "1", "-maxdepth", "1", "-printf", "%p\t%T@\n"]).split("\n").filter(Boolean).map((l) => { const i = l.lastIndexOf("\t"); return { path: l.slice(0, i), mtimeMs: Number(l.slice(i + 1)) * 1000 }; });

const num = (p) => { try { const n = Number(readFileSync(p, "utf8").trim()); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; } };
const mtimeOf = (p) => { try { return statSync(p).mtimeMs; } catch { return null; } };
const names = (dir) => { try { return readdirSync(dir); } catch { return []; } };

/**
 * #5898: depcache snapshots are `<root>/<repoKey>/<eco>-<16 hex>/`. Directory mtime never moves when a lane reuses one
 * (`last-used` is rewritten in place), so last use is that file, then manifest `created`, then mtime. A snapshot is live
 * while its `<snap>.lock` is recent. Returns [{path, lastMs, live}].
 */
function depcacheSnapshots(dc, now) {
  const out = [];
  for (const rk of names(dc)) {
    if (rk === "stores") continue;
    for (const n of names(join(dc, rk))) {
      const p = join(dc, rk, n);
      if (!/^[a-z]+-[0-9a-f]{16}$/.test(n) || !existsSync(join(p, "manifest.json"))) continue;
      let created = null;
      try { created = Number(JSON.parse(readFileSync(join(p, "manifest.json"), "utf8")).created) || null; } catch { /* unreadable manifest */ }
      const lockM = mtimeOf(`${p}.lock`);
      out.push({ path: p, lastMs: num(join(p, "last-used")) ?? created ?? mtimeOf(p) ?? 0, live: lockM !== null && now - lockM < LOCK_LIVE_MS });
    }
  }
  return out;
}

/** Runs inside the container. Returns {size_bytes, last_used_ms, removed, errors}. */
export function sweepVolume({ root = "/cache", maxAgeDays = 14, maxGb = null, keep = [], now = Date.now() } = {}) {
  const errors = [], removed = [];
  const rm = (p) => { try { rmSync(p, { recursive: true, force: true }); removed.push(p); } catch (e) { errors.push(`${p}: ${e.message}`); } };
  const cutoff = now - maxAgeDays * DAY;
  for (const d of ["uv", "npm", "pip", "poetry"]) { // package caches: old files out, then the empty dirs
    const dir = join(root, d);
    if (!existsSync(dir)) continue;
    sh("find", [dir, "-type", "f", "-mtime", `+${maxAgeDays}`, "-delete"]);
    sh("find", [dir, "-mindepth", "1", "-type", "d", "-empty", "-delete"]);
  }
  const ageOut = (dir, skip = []) => { for (const k of kids(dir)) if (k.mtimeMs < cutoff && !skip.includes(k.path)) rm(k.path); };
  const dc = join(root, "forge-depcache");
  if (existsSync(dc)) { // #5898: by last use, never a locked snapshot; dead publishers' tmp dirs and old locks go, then empty repo dirs
    for (const s of depcacheSnapshots(dc, now)) if (s.lastMs < cutoff && !s.live) rm(s.path);
    for (const rk of names(dc)) {
      if (rk === "stores") continue;
      for (const n of names(join(dc, rk))) if (/\.(tmp-\d+|lock)$/.test(n) && (mtimeOf(join(dc, rk, n)) ?? now) < cutoff) rm(join(dc, rk, n));
      if (names(join(dc, rk)).length === 0) rm(join(dc, rk));
    }
  }
  if (existsSync(join(root, "env"))) ageOut(join(root, "env"));
  const ps = join(root, "pnpm-store");
  if (existsSync(ps)) sh("pnpm", ["store", "prune", "--store-dir", ps]);
  for (const m of kids(join(root, "git")).filter((k) => k.path.endsWith(".git"))) sh("git", ["-C", m.path, "gc", "--auto", "--quiet"]);
  if (Number.isFinite(maxGb)) {
    const entries = [];
    const keepSet = new Set(keep);
    for (const k of kids(join(root, "work"))) entries.push({ ...k, bytes: sizeOf(k.path), live: keepSet.has(k.path) });
    for (const d of ["uv", "npm", "pip", "poetry", "env", "forge-depcache/stores"]) for (const k of kids(join(root, d))) entries.push({ ...k, bytes: sizeOf(k.path), live: false });
    for (const s of depcacheSnapshots(dc, now)) entries.push({ path: s.path, mtimeMs: s.lastMs, bytes: sizeOf(s.path), live: s.live });
    const plan = planCacheCap(entries, maxGb * 1024 ** 3);
    for (const p of plan.delete) rm(p);
  }
  const lastSec = num(join(root, ".last-used")), last = lastSec === null ? null : lastSec * 1000;
  return { size_bytes: sizeOf(root), last_used_ms: last, removed: removed.length, errors: errors.slice(0, 5) };
}

if (process.env.CS_CACHE_SWEEP_OPTS) process.stdout.write(JSON.stringify(sweepVolume(JSON.parse(process.env.CS_CACHE_SWEEP_OPTS))) + "\n");
