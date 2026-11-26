// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5757: cache volume hygiene for pool agents. The planners are pure (imported by the agent and unit tests); the sweep
// itself runs inside a short-lived container of the lane image with the cache volume on /cache. The agent ships this
// file's source in CS_CACHE_SWEEP_SRC and the options in CS_CACHE_SWEEP_OPTS; the JSON result goes to stdout.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const CACHE_LABEL = "computeshare.cache=1";
/** #5969: dirs older entrypoints (and volumes/images already out there) export as lane cache dirs; still swept, capped and pruned. */
export const LEGACY_STORES = ["uv", "npm", "pip", "poetry"];
/** #5955: every package-manager store the lanes write (depcache.mjs env(), agent.mjs pnpm store), relative to the /cache volume root. One list for the sweep and pruneCaches. */
export const PACKAGE_STORES = ["pnpm-store", ...["pnpm-store", "npm-cache", "uv-cache", "poetry-cache", "pip-cache"].map((n) => `forge-depcache/stores/${n}`), ...LEGACY_STORES];
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
 * #5901: least-recently-used plan for one repo's depcache snapshots ({path, bytes, lastUsedMs, live}). Same rule as
 * `planCacheCap` with last use as the order; live (locked) snapshots count towards the total and are never chosen.
 */
export function planDepcacheCap(entries, capBytes) {
  return planCacheCap(entries.map((e) => ({ ...e, mtimeMs: e.lastUsedMs })), capBytes);
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

const SNAP = /^[a-z]+-[0-9a-f]{16}$/;
const num = (p) => { try { const n = Number(readFileSync(p, "utf8").trim()); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; } };
const mtimeOf = (p) => { try { return statSync(p).mtimeMs; } catch { return null; } };
/** #5898: a snapshot is in use while its `<snap>.lock` is younger than LOCK_LIVE_MS (the container cannot check pids). */
const lockLive = (p, now) => { const m = mtimeOf(`${p}.lock`); return m !== null && now - m < LOCK_LIVE_MS; };
/** Every depcache snapshot as {path, lastUsedMs, live}; last use falls back to manifest `created`, then mtime. */
function depcacheSnaps(dc, now) {
  const out = [];
  for (const repo of kids(dc)) {
    if (repo.path.endsWith("/stores")) continue;
    for (const k of kids(repo.path)) {
      if (!SNAP.test(k.path.slice(repo.path.length + 1))) continue;
      out.push({ ...k, lastUsedMs: snapLastUsed(k), live: lockLive(k.path, now) });
    }
  }
  return out;
}
/** Last use of a depcache snapshot: its `last-used` file (epoch ms, written on every hit), else the directory mtime. */
const snapLastUsed = (k) => {
  let created = null;
  try { created = Number(JSON.parse(readFileSync(join(k.path, "manifest.json"), "utf8")).created) || null; } catch { /* no manifest */ }
  return num(join(k.path, "last-used")) ?? created ?? k.mtimeMs;
};

/**
 * #5901: depcache is `<dc>/<repoKey>/<eco>-<key>/`. Each snapshot (not the repo dir, whose mtime moves with every new
 * snapshot) ages out by its last use and is trimmed least-recently-used past the per-repo cap. A snapshot with a lock file
 * is in use and kept. Fills `depcacheBytes[repoKey]` with what remains.
 */
function sweepDepcache(dc, { cutoff, now, capBytes, rm, depcacheBytes }) {
  for (const repo of kids(dc)) {
    const rk = repo.path.slice(dc.length + 1);
    if (rk === "stores") continue;
    if (SNAP.test(rk)) { if (snapLastUsed(repo) < cutoff && !lockLive(repo.path, now)) rm(repo.path); continue; } // an entry of the flat layout (no repo level)
    let snaps = kids(repo.path).filter((k) => SNAP.test(k.path.slice(repo.path.length + 1)));
    for (const k of kids(repo.path)) if (/\.(tmp-\d+|lock)$/.test(k.path) && k.mtimeMs < cutoff) rm(k.path); // dead publishers' tmp dirs, old locks
    snaps = snaps.map((k) => ({ ...k, lastUsedMs: snapLastUsed(k), live: lockLive(k.path, now) }));
    for (const k of snaps.filter((x) => x.lastUsedMs < cutoff && !x.live)) rm(k.path);
    snaps = snaps.filter((x) => existsSync(x.path));
    if (!snaps.length) { if (repo.mtimeMs < cutoff) rm(repo.path); continue; } // nothing left in it and untouched for the max age
    for (const k of snaps) k.bytes = sizeOf(k.path);
    if (capBytes !== null) for (const p of planDepcacheCap(snaps, capBytes).delete) rm(p);
    depcacheBytes[rk] = snaps.filter((x) => existsSync(x.path)).reduce((a, x) => a + x.bytes, 0);
  }
}

/** Runs inside the container. Returns {size_bytes, last_used_ms, removed, errors}. */
export function sweepVolume({ root = "/cache", maxAgeDays = 14, maxGb = null, maxDepcacheGb = null, keep = [], now = Date.now() } = {}) {
  const errors = [], removed = [];
  const rm = (p) => { try { rmSync(p, { recursive: true, force: true }); removed.push(p); } catch (e) { errors.push(`${p}: ${e.message}`); } };
  const cutoff = now - maxAgeDays * DAY;
  for (const d of PACKAGE_STORES) { // package caches: old files out, then the empty dirs
    const dir = join(root, d);
    if (!existsSync(dir)) continue;
    sh("find", [dir, "-type", "f", "-mtime", `+${maxAgeDays}`, "-delete"]);
    sh("find", [dir, "-mindepth", "1", "-type", "d", "-empty", "-delete"]);
  }
  const ageOut = (dir, skip = []) => { for (const k of kids(dir)) if (k.mtimeMs < cutoff && !skip.includes(k.path)) rm(k.path); };
  const dc = join(root, "forge-depcache");
  const depcacheBytes = {};
  if (existsSync(dc)) { ageOut(join(dc, "stores")); sweepDepcache(dc, { cutoff, now, capBytes: Number.isFinite(maxDepcacheGb) ? maxDepcacheGb * 1024 ** 3 : null, rm, depcacheBytes }); } // store entries, then snapshots per repo
  if (existsSync(join(root, "env"))) ageOut(join(root, "env"));
  const ps = join(root, "pnpm-store");
  if (existsSync(ps)) sh("pnpm", ["store", "prune", "--store-dir", ps]);
  for (const m of kids(join(root, "git")).filter((k) => k.path.endsWith(".git"))) sh("git", ["-C", m.path, "gc", "--auto", "--quiet"]);
  if (Number.isFinite(maxGb)) {
    const entries = [];
    const keepSet = new Set(keep);
    for (const k of kids(join(root, "work"))) entries.push({ ...k, bytes: sizeOf(k.path), live: keepSet.has(k.path) });
    for (const d of [...PACKAGE_STORES, "env", "forge-depcache/stores"]) for (const k of kids(join(root, d))) entries.push({ ...k, bytes: sizeOf(k.path), live: false });
    for (const k of depcacheSnaps(dc, now)) entries.push({ path: k.path, mtimeMs: k.lastUsedMs, bytes: sizeOf(k.path), live: k.live });
    const plan = planCacheCap(entries, maxGb * 1024 ** 3);
    for (const p of plan.delete) rm(p);
  }
  const lastSec = num(join(root, ".last-used")), last = lastSec === null ? null : lastSec * 1000;
  return { size_bytes: sizeOf(root), last_used_ms: last, depcache_bytes: depcacheBytes, removed: removed.length, errors: errors.slice(0, 5) };
}

if (process.env.CS_CACHE_SWEEP_OPTS) process.stdout.write(JSON.stringify(sweepVolume(JSON.parse(process.env.CS_CACHE_SWEEP_OPTS))) + "\n");
