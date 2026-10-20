// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sparse lane worktrees (#4221). A lane checks out every tracked file except regular blobs at or above
 * `maxBlobBytes` (forge.yaml `env.sparse_max_kb`, default 1024; 0 = off). Lockfiles, manifests, toolchain pins and
 * git/forge config are always checked out (the #4220 dep cache and #4163 toolchain pins read them). The patterns are
 * non-cone (`/*` then `!/<path>`), kept in the worktree's own `info/sparse-checkout`; `core.sparseCheckout` is per-worktree
 * config (git sets `extensions.worktreeConfig` in the shared config), so the main checkout is untouched. A repo with no
 * such blob gets today's plain `git worktree add`. A failed sparse step falls back to a full checkout; never fails a lane.
 */
import { join } from "node:path";

export const DEFAULT_SPARSE_MAX_KB = 1024;

const KEEP_RE = /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.yarnrc\.yml|uv\.lock|poetry\.lock|pyproject\.toml|requirements.*\.txt|setup\.py|setup\.cfg|\.nvmrc|\.node-version|\.tool-versions|tsconfig.*\.json|forge\.yaml|\.gitattributes|\.gitignore)$/;

/** Blobs to leave out, from `git ls-tree -r -l -z <ref>` output: {excludes, bytes}. Symlinks, gitlinks and kept files never. */
export function sparsePlan(lsTree, { maxBlobBytes = DEFAULT_SPARSE_MAX_KB * 1024 } = {}) {
  const excludes = [];
  let bytes = 0;
  if (!(maxBlobBytes > 0)) return { excludes, bytes };
  for (const rec of String(lsTree ?? "").split("\0")) {
    const m = /^(\d{6}) blob [0-9a-f]+ +(\d+)\t([\s\S]+)$/.exec(rec.replace(/^\n+/, ""));
    if (!m || !["100644", "100755"].includes(m[1])) continue;
    const size = Number(m[2]), path = m[3];
    if (size < maxBlobBytes || /[\n\r]/.test(path) || KEEP_RE.test(path.split("/").at(-1))) continue;
    excludes.push(path);
    bytes += size;
  }
  return { excludes, bytes };
}

/** gitignore-syntax escape for a literal path: \ * ? [ anywhere, trailing spaces. */
const esc = (p) => p.replace(/[\\*?[]/g, (c) => `\\${c}`).replace(/ +$/, (s) => s.replace(/ /g, "\\ "));

/** Non-cone sparse patterns that include everything except `excludes`. */
export function sparsePatterns(excludes) {
  return ["/*", ...excludes.map((p) => `!/${esc(p)}`)];
}

/**
 * Add a lane worktree, sparse when the plan is non-empty. `git(args, {cwd})` is the injected io.git; `write(path, text)`
 * writes the pattern file (argv-safe for any number of patterns). `addArgs` is the plain `["worktree","add",...]` argv.
 * A failing `worktree add` is rethrown unchanged (the caller retries lock races). Returns {sparse, excluded, bytes, fallback?}.
 */
export async function addLaneWorktree(git, write, { cwd, wt, addArgs, ref, maxBlobBytes = DEFAULT_SPARSE_MAX_KB * 1024 }) {
  let plan = { excludes: [], bytes: 0 };
  if (maxBlobBytes > 0 && typeof write === "function") {
    try { plan = sparsePlan(await git(["ls-tree", "-r", "-l", "-z", ref], { cwd }), { maxBlobBytes }); } catch { /* no plan: full checkout */ }
  }
  if (!plan.excludes.length) {
    await git(addArgs, { cwd });
    return { sparse: false, excluded: 0, bytes: 0 };
  }
  await git([...addArgs.slice(0, 2), "--no-checkout", ...addArgs.slice(2)], { cwd });
  const g = (a) => git(a, { cwd: wt });
  try {
    await g(["sparse-checkout", "set", "--no-cone", "/*"]);
    const file = String(await g(["rev-parse", "--git-path", "info/sparse-checkout"])).trim();
    await write(file.startsWith("/") ? file : join(wt, file), `${sparsePatterns(plan.excludes).join("\n")}\n`);
    await g(["read-tree", "-mu", "HEAD"]);
    return { sparse: true, excluded: plan.excludes.length, bytes: plan.bytes };
  } catch (e) {
    const reason = String(e?.stderr || e?.message || e).trim().split("\n").slice(-2).join(" ").slice(0, 300);
    try { await g(["sparse-checkout", "disable"]); } catch { /* full read-tree below */ }
    await g(["read-tree", "-mu", "HEAD"]);
    return { sparse: false, excluded: 0, bytes: 0, fallback: reason || "sparse checkout failed" };
  }
}
