// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5751: repo-declared hot areas (one lane at a time) and named counters (must not keep growing).
 * A hot area is admitted through the branch lock (branchlock.mjs) keyed `hot-area:<name>`: host-wide and pid-aware, but
 * host-local (lanes on another host are not excluded). A counter is a `git grep -c -E` pattern evaluated at a ref, so the
 * base side needs no checkout; growth fails conformance unless a contract decision row says `counter-ok: <name> <reason>`.
 */
import { OUTCOME_CODES as C } from "../engine/outcome-codes.mjs";
import { acquireBranchLock } from "./branchlock.mjs";
import { globToRegex } from "../../scripts/ci-local/lib.mjs";
import { pathsOverlap } from "./recurrence.mjs";

export const HOT_AREA_PREFIX = "hot-area:";

/** Names of the declared hot areas any of `paths` falls in (glob match, or a named directory containing a glob's root). */
export function areaOf(paths = [], hotAreas = []) {
  const ps = (paths ?? []).map((p) => String(p ?? "").trim().replace(/^\.?\/+/, "")).filter(Boolean);
  const hit = (g) => ps.some((p) => globToRegex(g).test(p) || pathsOverlap(p, g.split(/[*?[{]/)[0]));
  return [...new Set((hotAreas ?? []).filter((a) => (a.paths ?? []).some(hit)).map((a) => a.name))].sort();
}

/**
 * Take every lock in `areas` (sorted, so two lanes never deadlock). On a refusal the locks already taken are released and
 * the holder is reported. `lock` is the lock primitive (acquireBranchLock), injectable for tests.
 * @returns {Promise<{ok:true, release:() => void, areas:string[]} | {ok:false, area:string, holder:object|null}>}
 */
export async function acquireHotArea({ gitCommonDir, areas = [], owner, waitMs = 0, lock = acquireBranchLock, ...rest }) {
  const held = [];
  const release = () => { for (const h of held.splice(0).reverse()) h.release(); };
  for (const area of [...new Set(areas)].sort()) {
    const r = await lock({ gitCommonDir, branch: `${HOT_AREA_PREFIX}${area}`, owner, waitMs, ...rest });
    if (!r.ok) { release(); return { ok: false, area, holder: r.holder ?? null }; }
    held.push(r);
  }
  return { ok: true, release, areas: [...new Set(areas)].sort() };
}
