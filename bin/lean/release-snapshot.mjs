// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Snapshot releases of `forgedock release` (#5276): `release.mode: snapshot` cuts `release/<id>` from a staging SHA instead of
 * freezing staging. The release PR head is that branch; blockers are fixed on staging and cherry-picked onto it, and every pick
 * is appended to the `FORGE:RELEASE` record (kept in `state.release` and as a hidden marker in the PR body). `checkChain` is the
 * provenance verifier: head = snapshot + exactly the recorded picks, each one a clean cherry-pick of a staging commit.
 * Picks are built with plumbing (merge-tree + commit-tree), so no working tree is needed. Every effect goes through `git`
 * (`(args, {env, input}) => stdout`, throws on failure) and `io.gh`, so the module is testable with a real temp repo.
 */
const REMOTE = "origin";
/** Head movement after the cut (#5567): the fix push, a recorded `main-sync` cherry-pick of a staging commit, or a mechanical `revert`. */
export const PICK_KINDS = ["fix", "main-sync", "revert"];
import { BLOCKER_LABEL } from "./release-rehearsal.mjs";
export const DEFAULT_PATTERN = "release/{date}-{n}";
const MARKER = "FORGE:RELEASE";
const REF_RE = /^[A-Za-z0-9._/-]+$/;
const json = (s) => JSON.parse(String(s || "null"));

/** `<!-- FORGE:RELEASE {...} -->`: the record as a hidden PR-body marker. */
export const recordMarker = (rec) => `<!-- ${MARKER} ${JSON.stringify(rec)} -->`;
export function parseRecord(text) {
  const m = /<!-- FORGE:RELEASE (\{.*?\}) -->/s.exec(String(text ?? ""));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
/** `body` with its FORGE:RELEASE marker replaced (or appended). */
export const withRecord = (body, rec) => {
  const text = String(body ?? "").replace(/\n*<!-- FORGE:RELEASE \{.*?\} -->\n*/s, "\n").trimEnd();
  return `${text}\n\n${recordMarker(rec)}\n`;
};

/** Ref prefix of `pattern` (up to the first `{`): every branch under it counts as a release in flight. */
export const patternPrefix = (pattern = DEFAULT_PATTERN) => {
  const i = pattern.indexOf("{");
  return i < 0 ? pattern : pattern.slice(0, i);
};
const dateOf = (now) => new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
export function branchName(pattern, now, n) {
  const date = dateOf(now);
  const name = pattern.replace("{date}", date).replace("{n}", String(n));
  if (!REF_RE.test(name) || name.includes("..") || name.startsWith("/") || name.endsWith("/")) throw new Error(`release.branch_pattern gives an invalid branch name: ${JSON.stringify(name)}`);
  return name;
}

export const isAncestor = (git, a, b) => { try { git(["merge-base", "--is-ancestor", a, b]); return true; } catch { return false; } };
const fetchRef = (git, ref) => git(["fetch", "--quiet", REMOTE, `+refs/heads/${ref}:refs/remotes/${REMOTE}/${ref}`]);
const tipOf = (git, ref) => git(["rev-parse", `refs/remotes/${REMOTE}/${ref}`]).trim();
const committer = (git) => {
  const cfg = (k) => { try { return git(["config", k]).trim(); } catch { return ""; } };
  return { GIT_COMMITTER_NAME: cfg("user.name") || "ForgeDock release", GIT_COMMITTER_EMAIL: cfg("user.email") || "release@forgedock.invalid" };
};

/** The tree of `orig` applied onto `onto` (what `git cherry-pick` would produce); throws on a conflict. */
function pickTree(git, onto, orig) {
  const parents = git(["rev-list", "--parents", "-n", "1", orig]).trim().split(/\s+/).slice(1);
  if (!parents.length) throw new Error(`${orig} is a root commit`);
  return git(["merge-tree", "--write-tree", `--merge-base=${parents[0]}`, onto, orig]).split("\n")[0].trim();
}

/**
 * Cut `branch` from the staging tip. One release in flight: any branch under the pattern prefix refuses.
 * @returns {{refused: string}|{branch, record}}
 */
export async function cutSnapshot({ io, git, repo, staging, def, pattern = DEFAULT_PATTERN, id, bundle = [] }) {
  const prefix = patternPrefix(pattern);
  const live = git(["ls-remote", "--heads", REMOTE, `${prefix}*`]).trim().split("\n").filter(Boolean).map((l) => l.split(/\s+/)[1]?.replace("refs/heads/", ""));
  if (live.length) return { refused: `a release branch is already in flight (${live.join(", ")}); one release per repo: finish it with forgedock release --resume <id> or delete the branch` };
  const day = pattern.replace("{date}", dateOf(io.now())).split("{n}")[0];
  const prior = (json(await io.gh(["pr", "list", "--repo", repo, "--base", def, "--state", "all", "--limit", "100", "--json", "headRefName"])) ?? []).filter((p) => String(p.headRefName).startsWith(day)).length;
  const branch = branchName(pattern, io.now(), prior + 1);
  fetchRef(git, staging); fetchRef(git, def);
  const snapshot = tipOf(git, staging);
  git(["push", "--quiet", REMOTE, `${snapshot}:refs/heads/${branch}`]);
  const issues = [...new Set(bundle.flatMap((p) => (p.closingIssuesReferences ?? []).map((i) => i.number)))].sort((a, b) => a - b);
  return { branch, record: { v: 1, id, branch, snapshot, range: { base: tipOf(git, def), head: snapshot }, bundle: bundle.map((p) => p.number), issues, picks: [] } };
}

/** The PR head record into the PR body and the state. */
export async function writeRecord(ctx) {
  const { io, repo, state } = ctx;
  const { pr } = state.steps["release-pr"].result;
  const body = json(await io.gh(["pr", "view", String(pr), "--repo", repo, "--json", "body"]))?.body ?? "";
  await io.gh(["pr", "edit", String(pr), "--repo", repo, "--body", withRecord(body, state.release)]);
}

/** Merged staging PRs that fix a blocker: labelled `release-blocker`, or closing one of `issues` or an issue labelled so. */
async function blockerPrs({ io, repo, staging, issues }) {
  const labelled = new Set((json(await io.gh(["issue", "list", "--repo", repo, "--label", BLOCKER_LABEL, "--state", "all", "--limit", "200", "--json", "number"])) ?? []).map((i) => i.number));
  for (const n of issues) labelled.add(n);
  const prs = json(await io.gh(["pr", "list", "--repo", repo, "--base", staging, "--state", "merged", "--limit", "200", "--json", "number,mergeCommit,mergedAt,labels,closingIssuesReferences"])) ?? [];
  return prs
    .filter((p) => p.mergeCommit?.oid && ((p.labels ?? []).some((l) => l.name === BLOCKER_LABEL) || (p.closingIssuesReferences ?? []).some((i) => labelled.has(i.number))))
    .sort((a, b) => String(a.mergedAt).localeCompare(String(b.mergedAt)));
}

/**
 * Cherry-pick the merged blocker fixes (not yet on the branch) onto `release/<id>`, fast-forward the branch and record the picks.
 * The new picks are saved in the state before the push, so a kill in between is repaired by the push of the last pick at the next call.
 * @returns {{picked: number[]}|{err: string}}
 */
export async function pickFixes(ctx, { issues = [] } = {}) {
  const { io, git, repo, staging, state } = ctx;
  const rec = state.release;
  if (!rec) return { err: "no FORGE:RELEASE record in the release state" };
  const push = (sha) => git(["push", "--quiet", REMOTE, `${sha}:refs/heads/${rec.branch}`]);
  if (rec.picks.length) { try { push(rec.picks.at(-1).sha); } catch { /* already there, or the objects are gone: the checks below decide */ } }
  fetchRef(git, staging);
  const stagingTip = tipOf(git, staging);
  let head = rec.picks.at(-1)?.sha ?? rec.snapshot;
  const picked = [];
  for (const p of await blockerPrs({ io, repo, staging, issues })) {
    const orig = p.mergeCommit.oid;
    if (rec.picks.some((k) => k.orig === orig) || isAncestor(git, orig, head)) continue;
    if (!isAncestor(git, orig, stagingTip)) return { err: `fix #${p.number} (${orig}) is not on ${staging}` };
    let tree;
    try { tree = pickTree(git, head, orig); } catch (e) { return { err: `cherry-pick of #${p.number} (${orig}) onto ${rec.branch} conflicts: resolve it by hand or use release.fix_mode: recut` }; }
    const [an, ae, ad] = git(["log", "-1", "--format=%an%n%ae%n%aI", orig]).trim().split("\n");
    const msg = `${git(["log", "-1", "--format=%B", orig]).trimEnd()}\n\n(cherry picked from commit ${orig})\n`;
    const sha = git(["commit-tree", tree, "-p", head, "-F", "-"], { input: msg, env: { GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad, ...committer(git) } }).trim();
    rec.picks.push({ sha, orig, pr: p.number, kind: "fix" });
    picked.push(p.number);
    head = sha;
  }
  if (!picked.length) return { picked };
  ctx.save();
  push(head);
  await writeRecord(ctx);
  return { picked };
}

/**
 * #5567: the mechanical revert of the newest pick (the round-1 fix commit): a commit whose tree is the tree before that pick, recorded
 * as a `revert` pick naming the reverted commit. No new code; `checkChain` verifies the tree. @returns {{reverted: string}|{err: string}}
 */
export async function revertLast(ctx) {
  const { git, state } = ctx;
  const rec = state.release;
  if (!rec?.picks?.length) return { err: "no recorded pick to revert" };
  const last = rec.picks.at(-1);
  if (last.kind === "revert") return { err: "the newest pick is already a revert" };
  const parent = git(["rev-parse", `${last.sha}^`]).trim();
  const tree = git(["rev-parse", `${parent}^{tree}`]).trim();
  const msg = `Revert "${git(["log", "-1", "--format=%s", last.sha]).trim()}"\n\n(reverts commit ${last.sha})\n`;
  const sha = git(["commit-tree", tree, "-p", last.sha, "-F", "-"], { input: msg, env: committer(git) }).trim();
  rec.picks.push({ sha, orig: last.sha, kind: "revert" });
  ctx.save();
  git(["push", "--quiet", REMOTE, `${sha}:refs/heads/${rec.branch}`]);
  await writeRecord(ctx);
  return { reverted: last.sha };
}

/** `fix_mode: recut`: move the (unmerged) release branch to the current staging tip and start the record's picks over. */
export async function recut(ctx) {
  const { git, staging, state } = ctx;
  const rec = state.release;
  fetchRef(git, staging);
  const tip = tipOf(git, staging);
  const unchanged = tip === (rec.picks.at(-1)?.sha ?? rec.snapshot) && !rec.picks.length;
  let head = unchanged ? tip : null;
  if (!unchanged) {
    rec.recuts = (rec.recuts ?? 0) + 1;
    rec.snapshot = tip; rec.picks = []; rec.range = { ...rec.range, head: tip };
    head = tip;
  }
  const sync = ctx.def ? syncDefault(ctx, head) : null; // #5565: a p0 that landed on the default branch after the cut comes in as one main-sync pick
  if (sync?.err) return { recut: false, err: sync.err };
  if (sync) { head = sync.sha; rec.picks.push({ sha: sync.sha, orig: sync.orig, kind: "main-sync", merge: true }); rec.range = { ...rec.range, head }; }
  if (unchanged && !sync) return { recut: false };
  ctx.save();
  git(["push", "--quiet", "--force", REMOTE, `${head}:refs/heads/${rec.branch}`]);
  await writeRecord(ctx);
  return { recut: true, snapshot: tip, ...(sync ? { mainSync: sync.orig } : {}) };
}

/** #5565: true when the default branch has commits the release head does not contain (a p0 landed after the cut); the release merge refuses then. */
export function defaultBehind({ git, def, head }) {
  fetchRef(git, def);
  return !isAncestor(git, `${REMOTE}/${def}`, head);
}

/** Merge the default-branch tip into `head` (plumbing, no working tree) unless it is already an ancestor. @returns {{sha, orig}|{err}|null} */
function syncDefault(ctx, head) {
  const { git, def } = ctx;
  fetchRef(git, def);
  const orig = tipOf(git, def);
  if (isAncestor(git, orig, head)) return null;
  let tree;
  try { tree = git(["merge-tree", "--write-tree", head, orig]).split("\n")[0].trim(); } catch { return { err: `merging ${def} into ${ctx.state.release.branch} conflicts: resolve it by hand` }; }
  const sha = git(["commit-tree", tree, "-p", head, "-p", orig, "-F", "-"], { input: `Merge ${def} into ${ctx.state.release.branch} (main-sync)\n`, env: committer(git) }).trim();
  return { sha, orig };
}

/**
 * Provenance check: `sha` = snapshot + the first k recorded picks (all of them with `exact`), linear, each commit the clean
 * cherry-pick of its staging commit (same tree as `git cherry-pick` of it onto the previous commit).
 * @returns {{ok: true, picks: number}|{ok: false, why: string}}
 */
export function checkChain({ git, record, sha, staging, exact = false }) {
  const no = (why) => ({ ok: false, why });
  try {
    fetchRef(git, staging);
    const stagingTip = tipOf(git, staging);
    if (!record?.snapshot) return no("no FORGE:RELEASE record");
    if (!isAncestor(git, record.snapshot, stagingTip)) return no(`snapshot ${record.snapshot} is not on ${staging}`);
    if (sha !== record.snapshot && !isAncestor(git, record.snapshot, sha)) return no(`${sha} does not descend from the snapshot ${record.snapshot}`);
    const rows = git(["rev-list", "--reverse", "--first-parent", "--parents", `${record.snapshot}..${sha}`]).trim().split("\n").filter(Boolean).map((l) => l.split(/\s+/));
    if (rows.length > record.picks.length) return no(`${rows.length} commit(s) on the release branch, ${record.picks.length} recorded cherry-pick(s): ${rows.slice(record.picks.length).map((r) => r[0].slice(0, 12)).join(", ")} not recorded`);
    if (exact && rows.length !== record.picks.length) return no(`head is at ${rows.length} of ${record.picks.length} recorded cherry-picks`);
    let prev = record.snapshot;
    for (const [i, [c, ...parents]] of rows.entries()) {
      const pick = record.picks[i];
      if (c !== pick.sha) return no(`commit ${c.slice(0, 12)} is not the recorded pick ${pick.sha.slice(0, 12)}`);
      if (pick.kind === "main-sync" && pick.merge) { // #5565: the default branch merged in after a p0 landed: parents are the previous pick and the recorded default tip
        if (parents.length !== 2 || parents[0] !== prev || parents[1] !== pick.orig) return no(`commit ${c.slice(0, 12)} is not the recorded merge of ${String(pick.orig).slice(0, 12)} onto ${prev.slice(0, 12)}`);
        prev = c;
        continue;
      }
      if (parents.length !== 1 || parents[0] !== prev) return no(`commit ${c.slice(0, 12)} is not a linear child of ${prev.slice(0, 12)}`);
      if (pick.kind && !PICK_KINDS.includes(pick.kind)) return no(`commit ${c.slice(0, 12)} has the unrecorded pick kind ${JSON.stringify(pick.kind)}`);
      if (pick.kind === "revert") { // #5567: a mechanical revert of the previous pick: same tree as before it, and it names it
        if (pick.orig !== prev) return no(`revert ${c.slice(0, 12)} does not revert the previous pick`);
        if (!git(["log", "-1", "--format=%B", c]).includes(`(reverts commit ${pick.orig})`)) return no(`revert ${c.slice(0, 12)} does not name ${pick.orig.slice(0, 12)}`);
        if (git(["rev-parse", `${c}^{tree}`]).trim() !== git(["rev-parse", `${pick.orig}~1^{tree}`]).trim()) return no(`revert ${c.slice(0, 12)} is not the mechanical revert of ${pick.orig.slice(0, 12)}`);
        prev = c;
        continue;
      }
      if (!isAncestor(git, pick.orig, stagingTip)) return no(`${pick.orig} is not a ${staging} commit`);
      if (!git(["log", "-1", "--format=%B", c]).includes(`(cherry picked from commit ${pick.orig})`)) return no(`commit ${c.slice(0, 12)} does not name ${pick.orig} as its cherry-pick source`);
      if (git(["rev-parse", `${c}^{tree}`]).trim() !== pickTree(git, prev, pick.orig)) return no(`commit ${c.slice(0, 12)} differs from the cherry-pick of ${pick.orig.slice(0, 12)}`);
      prev = c;
    }
    return { ok: true, picks: rows.length };
  } catch (e) { return no(`could not verify: ${String(e.message).split("\n")[0]}`); }
}

/** `forgedock release verify <sha>`: the record from the PR whose head is `sha`, then `checkChain`. */
export async function verifyRelease({ io, git, repo, staging, sha }) {
  let prs = [];
  try { prs = json(await io.gh(["api", `repos/${repo}/commits/${sha}/pulls`, "--jq", "[.[] | {number, body}]"])) ?? []; } catch { /* unknown commit: no record below */ }
  const found = prs.map((p) => ({ number: p.number, record: parseRecord(p.body) })).find((p) => p.record);
  if (!found) return { ok: false, why: `no pull request with a FORGE:RELEASE record contains ${sha}` };
  try { git(["fetch", "--quiet", REMOTE, sha]); } catch { /* sha may already be local, or not fetchable by id */ }
  return { ...checkChain({ git, record: found.record, sha, staging }), pr: found.number };
}

/** Delete the release branch after post-merge; a missing branch is fine. */
export function cleanupSnapshot({ git, branch }) {
  try { git(["push", "--quiet", REMOTE, "--delete", branch]); return { deleted: true }; } catch (e) { return { deleted: false, why: String(e.message).split("\n")[0] }; }
}
