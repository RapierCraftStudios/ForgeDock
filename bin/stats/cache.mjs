// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Optional local cache for `forgedock stats` (forge#3835): ~/.forge/stats-cache/<owner>_<repo>/cache.json.
 * GitHub is the source of truth; this only stores what was already fetched plus the `updated_at` watermark so a
 * refresh is incremental. A missing, unreadable or wrong-version cache is treated as empty (a re-fetch), and
 * deleting the directory costs nothing but time. Writes never throw.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CACHE_VERSION = 1;

export function cacheDir(repo, env = process.env) {
  const root = env.FORGE_STATS_CACHE_DIR || join(homedir(), ".forge", "stats-cache");
  return join(root, repo.replace("/", "_"));
}

/**
 * { watermark: ISO string | null, coveredFrom: ISO string | null, items: { "<number>": item } }
 * The cache covers activity in [coveredFrom, watermark]; coveredFrom null means "from the beginning". A cache written
 * before the field existed loads with coveredFrom undefined (floor unknown), never as full coverage.
 */
export const emptyCache = () => ({ v: CACHE_VERSION, watermark: null, coveredFrom: null, items: {} });

export function loadCache(repo, env = process.env) {
  try {
    const c = JSON.parse(readFileSync(join(cacheDir(repo, env), "cache.json"), "utf8"));
    if (c && c.v === CACHE_VERSION && c.items && typeof c.items === "object") return { ...emptyCache(), ...c, coveredFrom: "coveredFrom" in c ? c.coveredFrom : undefined };
  } catch { /* missing or corrupt: refetch */ }
  return emptyCache();
}

export function saveCache(repo, cache, env = process.env) {
  try {
    const dir = cacheDir(repo, env);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `cache.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, join(dir, "cache.json"));
    return true;
  } catch { return false; }
}
