// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lane worktree confinement (#5825). Lane folders live under `<repo>/.claude/worktrees/`, inside the operator's checkout.
 * A lane folder that lost its `.git` link (a partial delete on Windows, a pruned registration) is no repository of its own,
 * so a git command run there walks up and acts on the operator's checkout (`git add -A` staged its untracked files).
 *
 * - `ceilingEnv(wt)`: `GIT_CEILING_DIRECTORIES` = the worktree's parent, for every lane git call and lane child process:
 *   discovery from inside the lane folder stops at the lane folder, it never reaches the checkout around it.
 * - `verifyLaneWorktree()`: the lane folder has a `.git` link, `git rev-parse --show-toplevel` is the lane folder and
 *   `--git-common-dir` is the repository's. The engine runs it at lane start and before every git write.
 * - `quarantineDir()`: a folder that is not a registered worktree is moved aside (never reused, never salvaged with git).
 * Paths are compared in the platform's form: separators unified and case folded on win32, trailing separators dropped.
 */
import { existsSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { posix, win32 } from "node:path";

const api = (platform) => (platform === "win32" ? win32 : posix);
/** The separator git uses for GIT_CEILING_DIRECTORIES (its PATH_SEP): `;` on Windows, `:` elsewhere. Never path.delimiter of the host. */
export const ceilingSep = (platform = process.platform) => (platform === "win32" ? ";" : ":");

/** Canonical comparable form of a path on `platform`. */
export function normPath(p, { platform = process.platform } = {}) {
  let s = String(p ?? "").trim();
  if (platform === "win32") s = s.replace(/\\/g, "/").toLowerCase();
  return s.length > 1 ? s.replace(/\/+$/, "") || "/" : s;
}
export const samePath = (a, b, o = {}) => Boolean(a) && Boolean(b) && normPath(a, o) === normPath(b, o);

/**
 * `{GIT_CEILING_DIRECTORIES}` for a lane worktree `wt`: its parent first, then any entries already in `env`. Null when the
 * parent cannot be expressed as one entry (it contains the separator), so the caller refuses the lane instead of
 * splitting a path into fragments.
 */
export function ceilingEnv(wt, { platform = process.platform, env = process.env } = {}) {
  if (!wt) return null;
  const sep = ceilingSep(platform), parent = api(platform).dirname(String(wt));
  if (!parent || parent.includes(sep)) return null;
  const rest = String(env?.GIT_CEILING_DIRECTORIES ?? "").split(sep).filter((d) => d && !samePath(d, parent, { platform }));
  return { GIT_CEILING_DIRECTORIES: [parent, ...rest].join(sep) };
}

const realOr = (p) => { try { return realpathSync.native(p); } catch { return p; } };

/**
 * Is `wt` a worktree of the repository at `cwd`? `git(args, {cwd, env})` is the injected git; `exists(p)` the fs probe.
 * Returns {ok: true, evidence} or {ok: false, why, evidence}; never throws. Evidence: worktree, toplevel, common_dir,
 * repo_common_dir (what git reported), for the engine-error detail.
 */
export async function verifyLaneWorktree({ git, exists, wt, cwd, platform = process.platform, real = realOr, env = process.env }) {
  const P = api(platform), evidence = { worktree: wt };
  const fail = (why) => ({ ok: false, why, evidence });
  if (!(await exists(P.join(wt, ".git")))) return fail("the lane folder has no .git link (not a git worktree)");
  const ceiling = ceilingEnv(wt, { platform, env });
  if (!ceiling) return fail(`the worktree parent contains the ${ceilingSep(platform)} separator; git cannot be confined to it`);
  let top, common, repoCommon;
  try {
    [top, common] = String(await git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { cwd: wt, env: ceiling })).trim().split(/\r?\n/).map((s) => s.trim());
  } catch (e) { return fail(`git rev-parse failed in the lane folder: ${String(e?.stderr || e?.message || e).trim().split("\n")[0].slice(0, 200)}`); }
  try { repoCommon = String(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd })).trim(); } catch (e) { return fail(`git rev-parse failed in the repository: ${String(e?.stderr || e?.message || e).trim().split("\n")[0].slice(0, 200)}`); }
  Object.assign(evidence, { toplevel: top ?? null, common_dir: common ?? null, repo_common_dir: repoCommon });
  if (!samePath(real(top), real(wt), { platform })) return fail(`git resolves the lane folder to toplevel ${top || "(none)"}, not the lane worktree`);
  if (!samePath(real(common), real(repoCommon), { platform })) return fail(`the lane folder's git dir ${common || "(none)"} is not the repository's ${repoCommon}`);
  return { ok: true, evidence };
}

/** True when `git worktree list --porcelain` output lists `wt` (paths compared in the platform's form; git prints `/` on Windows). */
export function listedWorktree(porcelain, wt, { platform = process.platform } = {}) {
  return String(porcelain ?? "").split(/\r?\n/).some((l) => l.startsWith("worktree ") && samePath(l.slice(9), wt, { platform }));
}

/**
 * Move a lane folder that is not a registered worktree to `<parent>/.quarantine/<name>-<ms>` (kept for inspection, never
 * reused). Returns the new path; throws when it cannot be moved (a locked file on Windows): the caller stops the lane.
 */
export function quarantineDir(wt, { now = Date.now, platform = process.platform, rename = renameSync, mkdir = (d) => mkdirSync(d, { recursive: true }), exists = existsSync } = {}) {
  const P = api(platform), dir = P.join(P.dirname(wt), ".quarantine");
  mkdir(dir);
  let to = P.join(dir, `${P.basename(wt)}-${now()}`);
  for (let i = 1; exists(to); i++) to = P.join(dir, `${P.basename(wt)}-${now()}-${i}`);
  rename(wt, to);
  return to;
}
