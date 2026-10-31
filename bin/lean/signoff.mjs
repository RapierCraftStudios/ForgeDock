// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * DCO sign-off for a lane's own unpushed commits (#4651). A resumed lane keeps the commits of an earlier run; one from a
 * pool agent that predates the identity fix is authored `*@localhost` with no `Signed-off-by`, and DCO fails on the release
 * PR. Before a push, the commits the push would add (reachable from HEAD, not from origin/<branch> nor origin/<lane>) are
 * checked, and the offenders are rewritten with the lane identity and --signoff. Commits already on either remote ref are
 * never in the range, so they are never rewritten. Deterministic, 0 LLM calls.
 */
const SEP = "\x1f", END = "\x1e";
const PLACEHOLDER_RE = /@localhost$/i;

/** True when the commit must be rewritten: placeholder author or committer, or no sign-off naming its author. */
export function needsSignoff({ authorEmail, committerEmail, signedOff }) {
  if (PLACEHOLDER_RE.test(authorEmail ?? "") || PLACEHOLDER_RE.test(committerEmail ?? "")) return true;
  const a = String(authorEmail ?? "").toLowerCase();
  return !signedOff.some((s) => s.toLowerCase().includes(`<${a}>`));
}

/** Parse `git log` output of FORMAT into the commits that need a rewrite, oldest first (the log is newest first). */
export function offendersOf(out) {
  return String(out ?? "").split(END).map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => {
    const [sha, authorEmail, committerEmail, trailers = "", parents = ""] = r.split(SEP);
    return { sha, authorEmail, committerEmail, signedOff: trailers.split("\n").map((l) => l.trim()).filter(Boolean), merge: parents.trim().split(/\s+/).filter(Boolean).length > 1 };
  }).filter((c) => !c.merge && needsSignoff(c)).reverse();
}

const FORMAT = `%H${SEP}%ae${SEP}%ce${SEP}%(trailers:key=Signed-off-by,valueonly,separator=%x0a)${SEP}%P${END}`;

// filter-branch rewrites only the commits in the range (the excluded remote refs stay as they are), and only the listed ones change.
const IS_BAD = 'case " $FD_BAD " in *" $GIT_COMMIT "*)';
const ENV_FILTER = `${IS_BAD} export GIT_AUTHOR_NAME="$FD_NAME" GIT_AUTHOR_EMAIL="$FD_EMAIL" GIT_COMMITTER_NAME="$FD_NAME" GIT_COMMITTER_EMAIL="$FD_EMAIL";; esac`;
const MSG_FILTER = `${IS_BAD} git interpret-trailers --trailer "Signed-off-by: $FD_NAME <$FD_EMAIL>";; *) cat;; esac`;

/**
 * @param {object} o
 * @param {(args: string[], opts?: {env?: object}) => Promise<string>} o.git runs git in the lane worktree
 * @param {string} o.lane the lane (base) branch
 * @param {string} o.branch the lane's own branch
 * @param {object} [o.env] where GIT_AUTHOR_NAME/EMAIL are read from (default process.env)
 * @returns {Promise<{rewritten: number}>}
 * @throws Error with `.laneCode` unset: callers type it. `.noIdentity` when a rewrite is needed but no usable identity exists.
 */
export async function ensureSignedOff({ git, lane, branch, env = process.env }) {
  const ok = async (args) => { try { return String(await git(args)).trim(); } catch { return ""; } };
  try { await git(["fetch", "origin", branch]); } catch { /* not pushed yet, or offline: the tracking refs we have decide */ }
  const exclude = [];
  for (const ref of [`origin/${branch}`, `origin/${lane}`]) if (await ok(["rev-parse", "--verify", "-q", `refs/remotes/${ref}`])) exclude.push(`^${ref}`);
  const log = await ok(["log", `--format=${FORMAT}`, "HEAD", ...exclude]);
  const bad = offendersOf(log);
  if (!bad.length) return { rewritten: 0 };
  // the lane identity: GIT_AUTHOR_* (what the sandbox sets and what a commit would use), else the worktree config
  let name = env.GIT_AUTHOR_NAME || await ok(["config", "user.name"]), email = env.GIT_AUTHOR_EMAIL || await ok(["config", "user.email"]);
  if (!name || !email) { // the runner's own git env (what a commit here would use), e.g. GIT_AUTHOR_* set only on the git runner
    const m = /^(.*?)\s*<([^>]*)>/.exec(await ok(["var", "GIT_AUTHOR_IDENT"]));
    if (m) { name ||= m[1]; email ||= m[2]; }
  }
  if (!name || !email || PLACEHOLDER_RE.test(email)) {
    throw Object.assign(new Error(`${bad.length} unpushed commit(s) fail DCO (placeholder author or no sign-off: ${bad.slice(0, 5).map((c) => c.sha.slice(0, 8)).join(", ")}) and the worktree has no usable git identity to rewrite them`), { noIdentity: true });
  }
  const fenv = { FD_BAD: bad.map((c) => c.sha).join(" "), FD_NAME: name, FD_EMAIL: email, FILTER_BRANCH_SQUELCH_WARNING: "1" };
  // filter-branch refuses on any modified or staged tracked file (#4905): park them in a commit object (not the shared stash stack), rewrite, put them back.
  let parked = "";
  if (await ok(["status", "--porcelain", "--untracked-files=no"])) {
    const ident = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
    try { parked = String(await git(["stash", "create", "forge: signoff park"], { env: ident })).trim(); } catch { parked = ""; }
    if (parked) await git(["reset", "--hard", "-q", "HEAD"]);
  }
  let failure = null;
  try { await git(["filter-branch", "-f", "--env-filter", ENV_FILTER, "--msg-filter", MSG_FILTER, "--", "HEAD", ...exclude], { env: fenv }); }
  catch (e) { failure = Object.assign(new Error(`could not rewrite ${bad.length} unpushed commit(s) for DCO: ${String(e?.stderr ?? e?.message ?? e).slice(0, 300)}`), { noIdentity: false }); }
  let stashRef;
  if (parked) {
    try { await git(["stash", "apply", "-q", parked]); }
    catch { stashRef = "refs/forge/signoff-stash"; await ok(["update-ref", stashRef, parked]); } // keep the work reachable, never lose it
  }
  if (failure) throw failure;
  await ok(["for-each-ref", "--format=delete %(refname)", "refs/original/"]).then(async (l) => { for (const r of l.split("\n").map((x) => x.replace(/^delete /, "")).filter(Boolean)) await ok(["update-ref", "-d", r]); });
  return stashRef ? { rewritten: bad.length, stashRef } : { rewritten: bad.length };
}
