// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #4590: tool state that must never ride a lane branch: the engine's own scratch (.forge-lean/) and tool caches
 * (.eslintcache, *.tsbuildinfo, and a generated next-env.d.ts when the repo ignores it). `info/exclude` only hides untracked
 * files, so a force-added or checkpoint-staged one gets committed and then conflicts in every base merge. This is the
 * deterministic gate: before a push, files the branch ADDED against the merge base are removed from the index (a file the
 * base itself tracks is the repo's own choice and is never touched). Git is injected: `git(args) -> stdout`, throws on failure.
 */
export const LEAN_SCRATCH = ".forge-lean/";
const CACHE_BASENAMES = [/^\.eslintcache$/, /\.tsbuildinfo$/];
const NEXT_ENV = "next-env.d.ts";

/** Lines `forgedock init` adds to a repo's .gitignore (next-env.d.ts only for Next.js repos). */
export const GITIGNORE_LINES = [".forge-lean/", ".eslintcache", "*.tsbuildinfo"];
export const GITIGNORE_NEXT_LINE = NEXT_ENV;

const base = (p) => p.slice(p.lastIndexOf("/") + 1);
/** Deny-listed path? `nextEnvIgnored`: the repo's own .gitignore ignores next-env.d.ts, so a tracked copy is stray. */
export function isToolState(path, { nextEnvIgnored = false } = {}) {
  const p = String(path ?? "").replace(/^\.\//, "");
  if (!p) return false;
  if (p.startsWith(LEAN_SCRATCH) || p === LEAN_SCRATCH.slice(0, -1)) return true;
  const b = base(p);
  return CACHE_BASENAMES.some((re) => re.test(b)) || (nextEnvIgnored && b === NEXT_ENV);
}
export const denied = (paths, opts) => paths.filter((p) => isToolState(p, opts));

const zlist = (out) => String(out ?? "").split("\0").filter(Boolean);
const quiet = async (git, args) => { try { await git(args); return true; } catch { return false; } };

/** The subset of `paths` the repo's .gitignore ignores (`--no-index`: tracked copies count). */
async function ignoredNextEnv(git, paths) {
  const out = [];
  for (const p of paths) if (base(p) === NEXT_ENV && await quiet(git, ["check-ignore", "-q", "--no-index", "--", p])) out.push(p);
  return out;
}

/** Deny-listed paths among `paths`, including next-env.d.ts copies the repo ignores. */
export async function strayPaths(git, paths) {
  const plain = denied(paths);
  const nexts = await ignoredNextEnv(git, paths.filter((p) => !plain.includes(p)));
  return [...plain, ...nexts];
}

/** After `git add -A`: unstage deny-listed paths so a checkpoint never commits them. Returns true when something else is staged. */
export async function unstageToolState(git) {
  const staged = zlist(await git(["diff", "--cached", "--name-only", "-z"]));
  const stray = await strayPaths(git, staged);
  if (stray.length) await git(["reset", "-q", "--", ...stray]);
  return stray.length ? (await git(["diff", "--cached", "--name-only"])).trim() !== "" : staged.length > 0;
}

/**
 * Remove from the index (and commit) the deny-listed files this branch added against `base`. Returns the removed paths ([]
 * when the branch is clean). Never throws: a failure leaves the branch as it was and the push proceeds.
 */
export async function untrackToolState({ git, base: ref, ev = () => {} }) {
  try {
    const added = zlist(await git(["diff", "--diff-filter=A", "--name-only", "-z", `${ref}...HEAD`]));
    const stray = await strayPaths(git, added);
    if (!stray.length) return [];
    await git(["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ...stray]);
    await git(["commit", "--no-verify", "-m", "chore: untrack lane tool state (#4590)", "-m", stray.slice(0, 20).join("\n")]);
    ev({ event: "TOOLSTATE_UNTRACKED", files: stray.slice(0, 20), count: stray.length });
    return stray;
  } catch (e) {
    ev({ event: "TOOLSTATE_UNTRACK_FAILED", error: String(e?.message ?? e).slice(0, 200) });
    return [];
  }
}

/**
 * #4880: a fresh lane starts with no scratch it did not write. Drops .forge-lean/ from the index (a base that still tracks it)
 * and from disk (`git clean -x`, so no fs delete is needed). Never throws. Returns true when the directory was tracked or present.
 */
export async function clearLaneScratch({ git, fs = {}, cwd }) {
  const dir = `${cwd}/${LEAN_SCRATCH.slice(0, -1)}`;
  let cleared = false;
  try { cleared = String((await git(["ls-files", "--", LEAN_SCRATCH])) ?? "").split("\n").some((f) => isToolState(f.trim())); } catch { /* unreadable index: still clean the disk */ }
  try { if (!cleared && fs.exists) cleared = Boolean(await fs.exists(dir)); } catch { /* best effort */ }
  try { if (cleared) await git(["rm", "-r", "-f", "-q", "--ignore-unmatch", "--", LEAN_SCRATCH]); } catch { /* best effort */ }
  try { if (cleared) await git(["clean", "-f", "-d", "-x", "-q", "--", LEAN_SCRATCH]); } catch { /* best effort */ }
  return cleared;
}

/** The deny-list lines a repo's .gitignore text lacks (append-only; `next`: also next-env.d.ts, for Next.js repos). */
export function gitignoreAdditions(text, { next = false } = {}) {
  const have = new Set(String(text ?? "").split(/\r?\n/).map((l) => l.trim().replace(/^\//, "")));
  return [...GITIGNORE_LINES, ...(next ? [GITIGNORE_NEXT_LINE] : [])].filter((l) => !have.has(l));
}
