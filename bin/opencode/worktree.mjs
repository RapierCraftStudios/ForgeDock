import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { codedError, slugify } from "./config.mjs";

const exec = promisify(execFile);

async function git(cwd, args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return String(stdout || "").trim();
  } catch (error) {
    if (allowFailure) return "";
    const detail = String(error.stderr || error.message || "git failed").trim();
    throw codedError("OPENCODE_WORKTREE_FAILED", `git ${args[0]} failed: ${detail}`);
  }
}

function parseWorktrees(output) {
  const records = [];
  let record = null;
  for (const line of String(output || "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      record = { path: line.slice(9), branch: "" };
      records.push(record);
    } else if (record && line.startsWith("branch refs/heads/")) {
      record.branch = line.slice("branch refs/heads/".length);
    }
  }
  return records;
}

function pathKey(path) {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function isOwnedPath(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function isSafeBranchName(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 240 || value !== value.trim()) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  if (value === "HEAD" || value === "@" || value.startsWith("refs/") || value.includes("..") || value.includes("//")) return false;
  return value.split("/").every((part) =>
    part && !part.startsWith(".") && !part.startsWith("-") && !part.endsWith(".") && !part.toLowerCase().endsWith(".lock"));
}

function assertSafeBranchName(value, kind) {
  if (!isSafeBranchName(value)) {
    throw codedError("OPENCODE_BRANCH_INVALID", `Refusing unsafe ${kind} branch name: ${JSON.stringify(value)}`);
  }
}

export function branchForIssue(issue) {
  const labels = (issue.labels || []).map((label) => typeof label === "string" ? label : label?.name).filter(Boolean);
  const fix = labels.some((label) => /^(bug|fix|priority:P[01])$/i.test(label)) || /^(fix|bug)(?:\b|[:(])/i.test(issue.title || "");
  return `${fix ? "fix" : "feat"}/${slugify(issue.title)}-${issue.number}`;
}

export function worktreePath(repoRoot, branch) {
  assertSafeBranchName(branch, "worktree");
  return join(resolve(repoRoot), ".opencode", "worktrees", branch.replaceAll("/", "-"));
}

export async function ensureWorktree({
  repoRoot,
  worktreeRoot = repoRoot,
  branch,
  base,
  path = worktreePath(worktreeRoot, branch),
  protectedBranches = [],
}) {
  assertSafeBranchName(branch, "feature");
  assertSafeBranchName(base, "base");
  const forbidden = new Set([base, ...protectedBranches].filter(Boolean));
  if (forbidden.has(branch)) {
    throw codedError("OPENCODE_BRANCH_PROTECTED", `Refusing to use protected/base branch ${branch} as a feature worktree.`);
  }
  const root = resolve(repoRoot);
  const ownerRoot = resolve(worktreeRoot);
  const ownedRoot = resolve(join(ownerRoot, ".opencode", "worktrees"));
  const target = resolve(path);
  const expected = resolve(worktreePath(ownerRoot, branch));
  if (!samePath(target, expected) || !isOwnedPath(ownedRoot, target)) {
    throw codedError("OPENCODE_WORKTREE_UNOWNED", `Refusing non-owned worktree path for ${branch}: ${target}`);
  }
  await git(root, ["check-ref-format", "--branch", branch]);
  await git(root, ["check-ref-format", "--branch", base]);
  const worktrees = parseWorktrees(await git(root, ["worktree", "list", "--porcelain"]));
  const primary = worktrees[0]?.path ? resolve(worktrees[0].path) : "";
  if (!primary || !samePath(ownerRoot, primary)) {
    throw codedError("OPENCODE_WORKTREE_UNOWNED", `Owned worktree root ${ownerRoot} is not the repository's primary checkout.`);
  }
  const branchWorktree = worktrees.find((item) => item.branch === branch);
  if (branchWorktree) {
    const existing = resolve(branchWorktree.path);
    if (samePath(existing, primary)) {
      throw codedError("OPENCODE_WORKTREE_UNOWNED", `Refusing to reuse the primary checkout for branch ${branch}.`);
    }
    if (!samePath(existing, expected) || !isOwnedPath(ownedRoot, existing)) {
      throw codedError("OPENCODE_WORKTREE_UNOWNED", `Refusing to reuse worktree outside ${ownedRoot}: ${existing}`);
    }
    return { path: existing, branch, reused: true };
  }

  const atTarget = worktrees.find((item) => samePath(item.path, target));
  if (atTarget && atTarget.branch !== branch) {
    throw codedError(
      "OPENCODE_WORKTREE_CONFLICT",
      `OpenCode worktree ${target} is already registered on ${atTarget.branch || "a detached HEAD"}.`,
    );
  }
  if (existsSync(target) && !atTarget) {
    throw codedError("OPENCODE_WORKTREE_CONFLICT", `Refusing to overwrite non-worktree path: ${target}`);
  }
  await git(root, ["fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`]);
  await git(root, ["rev-parse", "--verify", `refs/remotes/origin/${base}^{commit}`]);
  mkdirSync(dirname(target), { recursive: true });
  const branchExists = Boolean(await git(root, ["show-ref", "--verify", `refs/heads/${branch}`], { allowFailure: true }));
  if (branchExists) await git(root, ["worktree", "add", "--", target, `refs/heads/${branch}`]);
  else await git(root, ["worktree", "add", "-b", branch, "--", target, `refs/remotes/origin/${base}`]);
  return { path: target, branch, reused: false };
}

export async function cleanupMergedWorktree({ repoRoot, worktreeRoot = repoRoot, path, branch, base }) {
  if (!path || !branch) return { removed: false, reason: "no-worktree" };
  if (!isSafeBranchName(branch) || !isSafeBranchName(base) || branch === base) {
    return { removed: false, reason: "invalid-ref" };
  }
  const root = resolve(repoRoot);
  const ownerRoot = resolve(worktreeRoot);
  const target = resolve(path);
  const expectedRoot = resolve(join(ownerRoot, ".opencode", "worktrees"));
  const expected = resolve(worktreePath(ownerRoot, branch));
  if (!samePath(target, expected) || !isOwnedPath(expectedRoot, target)) {
    return { removed: false, reason: "outside-opencode-worktrees" };
  }
  let worktrees;
  try {
    worktrees = parseWorktrees(await git(root, ["worktree", "list", "--porcelain"]));
  } catch {
    return { removed: false, reason: "worktree-inspection-failed" };
  }
  const primary = worktrees[0]?.path ? resolve(worktrees[0].path) : "";
  if (!primary || !samePath(ownerRoot, primary) || samePath(target, primary)) {
    return { removed: false, reason: "primary-or-unowned-worktree" };
  }
  const registered = worktrees.find((item) => samePath(item.path, target));
  if (!registered || registered.branch !== branch) {
    return { removed: false, reason: "worktree-registration-mismatch" };
  }
  try {
    if (await git(target, ["status", "--porcelain", "--untracked-files=all"])) {
      return { removed: false, reason: "dirty-worktree" };
    }
  } catch {
    return { removed: false, reason: "worktree-status-unknown" };
  }
  try {
    await git(root, ["fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    await git(root, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    await git(root, ["rev-parse", "--verify", `refs/remotes/origin/${base}^{commit}`]);
    await git(root, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/remotes/origin/${base}`]);
  } catch {
    return { removed: false, reason: "branch-not-merged-or-unverifiable" };
  }
  try {
    await git(root, ["worktree", "remove", "--", target]);
  } catch {
    return { removed: false, reason: "worktree-remove-failed" };
  }
  const branchRemoved = Boolean(await git(root, ["branch", "-d", "--", branch], { allowFailure: true }));
  return { removed: true, reason: branchRemoved ? "merged" : "merged-branch-retained" };
}
