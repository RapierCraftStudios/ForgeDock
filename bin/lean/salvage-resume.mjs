// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5063: pick the salvage ref a rerun resumes from. The DCO and exit rescues push to `forge-salvage/<issue>-<sha10>`
 * (#4958, #5047). The suffix is a sha, so the newest ref is chosen by commit time, not by name. When the lane branch
 * already exists on origin, only a ref strictly ahead of it (descending from origin/<branch>) can be resumed without
 * losing either side; a behind or diverged ref is ignored.
 */
const ok = async (git, args, cwd) => { try { await git(args, { cwd }); return true; } catch { return false; } };

/** @returns {Promise<{ref: string, sha: string} | null>} */
export async function pickSalvage({ io, cwd, issue, branch, hasBranch }) {
  const out = String(await io.git(["ls-remote", "--heads", "origin", `refs/heads/forge-salvage/${issue}-*`], { cwd }));
  const refs = out.split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p[1]).map(([sha, ref]) => ({ sha, ref }));
  if (!refs.length) return null;
  if (refs.length > 1 || hasBranch) await io.git(["fetch", "origin", `+refs/heads/forge-salvage/${issue}-*:refs/remotes/origin/forge-salvage/${issue}-*`], { cwd });
  // release #5068 BUG-2/SPEC-1: compare against the live lane branch; a missing or stale local origin/<branch> would ignore a usable salvage or resume one that is behind the remote
  if (hasBranch) await io.git(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd });
  for (const r of refs) r.ct = Number(String(await io.git(["log", "-1", "--format=%ct", r.sha], { cwd }).catch(() => "")).trim()) || 0;
  refs.sort((a, b) => b.ct - a.ct || (a.ref < b.ref ? 1 : -1));
  for (const r of refs) {
    if (!hasBranch) return r;
    if (await ok(io.git, ["merge-base", "--is-ancestor", `origin/${branch}`, r.sha], cwd) && !(await ok(io.git, ["merge-base", "--is-ancestor", r.sha, `origin/${branch}`], cwd))) return r;
  }
  return null;
}
