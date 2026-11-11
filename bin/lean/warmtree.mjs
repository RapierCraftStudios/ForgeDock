// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Local warm lane worktrees (#5435). Up to N detached worktrees per repo sit under `<worktreeRoot>/warm/` at a recent
 * base sha (sparse plan applied, #4221). A lane claims one with `git worktree move` + `checkout -B <branch> <base sha>`
 * instead of a cold `worktree add`, then checks `HEAD` against the lane base's sha: a pooled tree is never trusted for
 * its content, only for its checkout cost. Any failure removes the claimed tree and returns null (cold path); nothing
 * here fails a lane. Refill runs after the claim and is best effort. Opt-in: `o.warmTrees` or FORGE_LOCAL_WARM_TREES.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addLaneWorktree, DEFAULT_SPARSE_MAX_KB } from "./worktree.mjs";

export const MAX_WARM_TREES = 4;

/** Pool size from the option or env; 0 (off) for anything that is not a positive integer. */
export function warmTreeCount(opt, env = process.env) {
  const n = Number(opt ?? env.FORGE_LOCAL_WARM_TREES ?? 0);
  return Number.isInteger(n) && n > 0 ? Math.min(MAX_WARM_TREES, n) : 0;
}

const slot = (root, i) => join(root, "warm", `warm-${i}`);
const metaOf = (p) => `${p}.json`;
const sha = async (git, cwd, ref) => String(await git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd })).trim();

/** Create missing slots (or move stale ones to `ref`) up to `n`. Returns the number of slots ready. */
export async function refillWarm({ git, cwd, root, ref, n, maxBlobBytes = DEFAULT_SPARSE_MAX_KB * 1024, write }) {
  let ready = 0;
  const m = /^origin\/(.+)$/.exec(ref);
  if (m) { try { await git(["fetch", "origin", m[1]], { cwd }); } catch { /* offline: the local ref */ } } // refresh = fetch + checkout
  const want = await sha(git, cwd, ref);
  mkdirSync(join(root, "warm"), { recursive: true });
  for (let i = 0; i < n; i++) {
    const p = slot(root, i);
    try {
      if (existsSync(p)) {
        if (await sha(git, p, "HEAD") !== want) await git(["checkout", "--detach", "-q", want], { cwd: p });
      } else {
        const info = await addLaneWorktree(git, write ?? (async (f, t) => writeFileSync(f, t)), { cwd, wt: p, addArgs: ["worktree", "add", "--detach", p, want], ref: want, maxBlobBytes });
        writeFileSync(metaOf(p), JSON.stringify({ sparse: info.sparse, excluded: info.excluded, bytes: info.bytes }));
      }
      ready++;
    } catch { /* slot busy (claimed or being made by another lane) or broken: skip */ }
  }
  return ready;
}

/**
 * Claim a warm tree as `wt` on `branch` at `base`. Returns {sparse, excluded, bytes, warm: true, sha} or null (cold path).
 * The base sha is resolved here and compared with the claimed tree's HEAD, so a stale pooled tree can never reach a lane.
 */
export async function claimWarm({ git, cwd, root, wt, branch, base, n }) {
  if (!(n > 0)) return null;
  let want;
  try { want = await sha(git, cwd, base); } catch { return null; }
  for (let i = 0; i < n; i++) {
    const p = slot(root, i);
    if (!existsSync(p)) continue;
    let moved = false;
    try {
      await git(["worktree", "move", p, wt], { cwd }); // fails when another lane claimed it first
      moved = true;
      await git(["checkout", "-q", "-B", branch, want], { cwd: wt });
      if (await sha(git, wt, "HEAD") !== want) throw new Error("warm tree is not at the base sha");
      let meta = {};
      try { meta = JSON.parse(readFileSync(metaOf(p), "utf8")); } catch { /* unknown: treated as full */ }
      try { rmSync(metaOf(p), { force: true }); } catch { /* best effort */ }
      return { sparse: Boolean(meta.sparse), excluded: meta.excluded ?? 0, bytes: meta.bytes ?? 0, warm: true, sha: want };
    } catch {
      if (moved) { try { await git(["worktree", "remove", "--force", wt], { cwd }); } catch { /* cold path cleans leftovers */ } }
    }
  }
  return null;
}

/** #5435: env that turns off the repo's git hooks for one call (the lane checkout never needs post-checkout installers). */
export const NO_HOOKS = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null" };
