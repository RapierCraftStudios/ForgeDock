#!/usr/bin/env node
/**
 * init-detect.mjs — Pure deterministic config detection for ForgeDock.
 *
 * Exports a single function: detectConfig(cwd)
 *
 * Returns a ConfigDraft: a structured object mirroring forge.yaml's required
 * sections (project, paths, branches) where every leaf is:
 *   { value, confidence, source, why }
 *
 * Confidence levels:
 *   "high"   — verified from a concrete, unambiguous source
 *   "medium" — inferred from available signals; likely correct
 *   "low"    — guessed default; no supporting evidence found
 *
 * Contract guarantees:
 *   - Pure: no prompts, no writes; reads only git metadata and the filesystem
 *   - Safe: every try/catch degrades to "low" confidence defaults, never throws
 *   - Isolated: imports only Node builtins (child_process, path)
 *   - Testable: inject `cwd` to point at a fixture repo and assert the draft
 */

import { execFileSync } from "child_process";
import { join, resolve } from "path";
import { readdirSync, existsSync } from "fs";

// ---------------------------------------------------------------------------
// Field factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a high-confidence field.
 * @param {string} value
 * @param {string} source
 * @param {string} why
 * @returns {{ value: string, confidence: 'high', source: string, why: string }}
 */
function high(value, source, why) {
  return { value, confidence: "high", source, why };
}

/**
 * Create a medium-confidence field.
 * @param {string} value
 * @param {string} source
 * @param {string} why
 * @returns {{ value: string, confidence: 'medium', source: string, why: string }}
 */
function medium(value, source, why) {
  return { value, confidence: "medium", source, why };
}

/**
 * Create a low-confidence field (default / guessed).
 * @param {string} value
 * @param {string} source
 * @param {string} why
 * @returns {{ value: string, confidence: 'low', source: string, why: string }}
 */
function low(value, source, why) {
  return { value, confidence: "low", source, why };
}

// ---------------------------------------------------------------------------
// Detection helpers — each returns a field object; never throws
// ---------------------------------------------------------------------------

/**
 * Detect GitHub owner and repo from the git remote named "origin".
 *
 * Supports both SSH (git@github.com:owner/repo.git) and HTTPS
 * (https://github.com/owner/repo.git) remote URL formats.
 *
 * Uses execFileSync (no shell) so remote URL content cannot be used for
 * command injection.
 *
 * @param {string} cwd - Absolute path to the repo root to inspect.
 * @returns {{ owner: import('./init-detect.mjs').ConfigField, repo: import('./init-detect.mjs').ConfigField, remoteDetected: boolean }}
 */
function detectRemote(cwd) {
  try {
    const remoteUrl = execFileSync(
      "git",
      ["remote", "get-url", "origin"],
      {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      },
    ).trim();

    // SSH: git@github.com:owner/repo.git
    const sshMatch = remoteUrl.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
    // HTTPS: https://github.com/owner/repo.git
    const httpsMatch = remoteUrl.match(
      /^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/,
    );

    if (sshMatch) {
      const [, owner, repo] = sshMatch;
      const sourceLabel = "git remote origin (SSH)";
      const why = `Parsed from SSH remote URL: ${remoteUrl}`;
      return {
        owner: high(owner, sourceLabel, why),
        repo: high(repo, sourceLabel, why),
        remoteDetected: true,
      };
    }

    if (httpsMatch) {
      const [, owner, repo] = httpsMatch;
      const sourceLabel = "git remote origin (HTTPS)";
      const why = `Parsed from HTTPS remote URL: ${remoteUrl}`;
      return {
        owner: high(owner, sourceLabel, why),
        repo: high(repo, sourceLabel, why),
        remoteDetected: true,
      };
    }

    // URL not in a recognised format — treat as no remote
  } catch {
    // git not available, not a repo, or no remote named "origin"
  }

  return {
    owner: low("your-github-org", "default placeholder", "No git remote named 'origin' found"),
    repo: low("your-repo-name", "default placeholder", "No git remote named 'origin' found"),
    remoteDetected: false,
  };
}

/**
 * Detect the default branch for the repository.
 *
 * Strategy (first success wins):
 *   1. git symbolic-ref refs/remotes/origin/HEAD  → the authoritative remote default
 *   2. git rev-parse --abbrev-ref HEAD             → the current local branch
 *   3. Fall back to "main" at low confidence
 *
 * @param {string} cwd
 * @returns {{ value: string, confidence: 'high'|'medium'|'low', source: string, why: string }}
 */
function detectDefaultBranch(cwd) {
  // Strategy 1: symbolic ref (authoritative)
  try {
    const headRef = execFileSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      },
    ).trim();
    const branch = headRef.replace(/^refs\/remotes\/origin\//, "");
    if (branch) {
      return high(
        branch,
        "git symbolic-ref refs/remotes/origin/HEAD",
        `Remote HEAD points to ${branch}`,
      );
    }
  } catch {
    // symbolic-ref not set — try next strategy
  }

  // Strategy 2: current local branch
  try {
    const cur = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      },
    ).trim();
    if (cur && cur !== "HEAD") {
      return medium(
        cur,
        "git rev-parse --abbrev-ref HEAD",
        `Current local branch is ${cur}; used as default branch estimate`,
      );
    }
  } catch {
    // git unavailable or not a git repo
  }

  // Strategy 3: fall back
  return low("main", "default placeholder", "Could not determine branch from git; defaulting to 'main'");
}

/**
 * Detect the staging branch.
 *
 * Strategy: check whether a remote branch named "staging" exists in the
 * remote listing. Falls back to the default branch at medium confidence
 * when staging is absent (many projects use main as their staging target).
 *
 * @param {string} cwd
 * @param {string} defaultBranch - The already-detected default branch value.
 * @returns {{ value: string, confidence: 'high'|'medium'|'low', source: string, why: string }}
 */
function detectStagingBranch(cwd, defaultBranch) {
  try {
    const remoteBranches = execFileSync(
      "git",
      ["branch", "-r"],
      {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      },
    );
    const branchLines = remoteBranches.split("\n").map((l) => l.trim());
    if (branchLines.some((l) => l === "origin/staging")) {
      return high(
        "staging",
        "git branch -r",
        "Found 'origin/staging' in the remote branch listing",
      );
    }
  } catch {
    // git not available or no remotes
  }

  // No 'origin/staging' found. Deriving a merge target from a failed lookup
  // is not a "likely correct" inference — it's a guess, and `staging` is the
  // single most destructive field to get wrong (it's the fast-lane PR merge
  // target). Flag it "low" so it gets a # TODO comment and the [low] badge
  // instead of silently blending in as if it were verified. <!-- Added: forge#1850 -->
  return low(
    defaultBranch,
    "default placeholder",
    `No 'origin/staging' remote branch found; guessed the default branch '${defaultBranch}' — verify this is actually your staging branch`,
  );
}

/**
 * Resolve the effective git repository root for detection purposes.
 *
 * `execFileSync("git", ...)` already searches UPWARD through parent
 * directories to find a repo root, so a `cwd` nested inside a repo is
 * already handled correctly with no extra code here. The gap this closes is
 * the other direction: `cwd` is a *parent* of the actual repo (a common
 * monorepo-adjacent layout, e.g. `ScraperAPI/` containing the real repo at
 * `ScraperAPI/alterlab/`) — git has no way to discover a repo by looking
 * downward, so every detector below would otherwise degrade straight to
 * placeholders.
 *
 * Never throws; falls back to the original `cwd` unchanged when neither
 * case applies (no repo found at all, or the subdirectory scan is
 * ambiguous — zero or multiple candidates).
 *
 * @param {string} cwd
 * @returns {{ root: string, resolved: boolean, why: string }}
 */
function resolveGitRoot(cwd) {
  // cwd is already inside a repo (possibly nested) — `--show-toplevel` finds
  // the true root regardless of depth. Compare with path.resolve() so a pure
  // separator-style difference (git always emits forward slashes, even on
  // Windows) doesn't get mistaken for an actual resolution.
  try {
    const toplevel = execFileSync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
    ).trim();
    if (toplevel) {
      const resolved = resolve(toplevel) !== resolve(cwd);
      return {
        root: resolved ? toplevel : cwd,
        resolved,
        why: `'${cwd}' is nested inside a git repository rooted at '${toplevel}'`,
      };
    }
  } catch {
    // Not inside any git repository — try the subdirectory scan below.
  }

  // cwd itself isn't a repo — check whether it holds exactly one immediate
  // subdirectory that is. Ambiguous (0 or 2+) candidates fall through
  // unchanged, preserving the existing placeholder behavior.
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    const gitDirs = entries.filter(
      (e) => e.isDirectory() && existsSync(join(cwd, e.name, ".git")),
    );
    if (gitDirs.length === 1) {
      const sub = join(cwd, gitDirs[0].name);
      return {
        root: sub,
        resolved: true,
        why: `'${cwd}' is not a git repository, but its only subdirectory '${gitDirs[0].name}' is — resolved detection to that subdirectory`,
      };
    }
  } catch {
    // cwd unreadable — fall through to the unresolved case.
  }

  return { root: cwd, resolved: false, why: "" };
}

/**
 * Derive a human-readable project name from the repository slug.
 *
 * Splits on hyphens and underscores, title-cases each word.
 * E.g. "my-cool-repo" → "My Cool Repo"
 *
 * @param {string} repoSlug
 * @returns {{ value: string, confidence: 'medium', source: string, why: string }}
 */
function deriveProjectName(repoSlug) {
  const name = repoSlug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return medium(
    name || repoSlug,
    "derived from repo slug",
    `Title-cased version of repo name '${repoSlug}' (split on hyphens/underscores)`,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {{ value: string, confidence: 'high'|'medium'|'low', source: string, why: string }} ConfigField
 *
 * @typedef {{
 *   project: {
 *     owner: ConfigField,
 *     repo:  ConfigField,
 *     name:  ConfigField,
 *   },
 *   paths: {
 *     root:         ConfigField,
 *     worktreeBase: ConfigField,
 *   },
 *   branches: {
 *     default: ConfigField,
 *     staging: ConfigField,
 *   },
 *   meta: {
 *     remoteDetected: boolean,
 *   },
 * }} ConfigDraft
 */

/**
 * Run all deterministic detection steps for a repository rooted at `cwd`.
 *
 * Returns a ConfigDraft — never throws. Every field in the draft carries a
 * confidence level so downstream consumers (init-enrich, review-render) can
 * decide how to treat each value.
 *
 * @param {string} [cwd] - Absolute path to the repo root. Defaults to process.cwd().
 * @returns {Promise<ConfigDraft>}
 */
export async function detectConfig(cwd = process.cwd()) {
  // Resolve the effective repo root FIRST — every detector below runs
  // against this, not the raw cwd argument. See resolveGitRoot() docblock.
  const { root: gitRoot, resolved: rootResolved, why: rootWhy } = resolveGitRoot(cwd);

  // Project identity
  const { owner, repo, remoteDetected } = detectRemote(gitRoot);

  // Project name derived from the repo slug
  const name = deriveProjectName(repo.value);

  // Paths — high confidence in the common case (root === cwd, nothing to
  // resolve). When detection had to redirect to a git subdirectory or a
  // parent toplevel, flag it medium confidence with an explanatory `why` so
  // the review screen surfaces the redirection instead of silently adopting it.
  const root = rootResolved
    ? medium(gitRoot, "resolved git repository root", rootWhy)
    : high(cwd, "process.cwd()", "Absolute path passed to detectConfig — the project root");
  const worktreeBase = high(
    join(gitRoot, ".claude", "worktrees"),
    "derived from root",
    `Convention: {root}/.claude/worktrees (root = ${gitRoot})`,
  );

  // Branch detection
  const defaultBranchField = detectDefaultBranch(gitRoot);
  const stagingBranchField = detectStagingBranch(gitRoot, defaultBranchField.value);

  return {
    project: { owner, repo, name },
    paths: { root, worktreeBase },
    branches: {
      default: defaultBranchField,
      staging: stagingBranchField,
    },
    meta: { remoteDetected },
  };
}

// ---------------------------------------------------------------------------
// Minimal forge.yaml template builder
// ---------------------------------------------------------------------------

/**
 * Escape a value for embedding inside a YAML double-quoted scalar.
 *
 * Backslash MUST be escaped first to avoid double-escaping an already-escaped
 * quote. This mirrors the escaping applied by the full-config generator in
 * forgedock.mjs and prevents Windows paths (which contain `\`) from corrupting
 * the emitted YAML. (Ref: forge#810 — init() did not escape backslashes.)
 *
 * @param {string} value
 * @returns {string}
 */
function escapeYamlScalar(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a minimal forge.yaml document containing ONLY the three required
 * sections — project, paths, branches — with no commented optional blocks.
 *
 * This is the `npx forgedock init --minimal` output. It is intentionally
 * complete enough to pass `npx forgedock doctor` (which requires project,
 * paths, AND branches) and to drive `/work-on` (which needs
 * paths.worktree_base for git worktrees) — while staying ~20 lines instead of
 * the ~200-line full template. Optional sections (repos, project_board,
 * review, verification, …) fall back to sensible defaults and can be added
 * later from forge.yaml.example / docs/CONFIG.md.
 *
 * Pure: returns a string, performs no I/O.
 *
 * @param {object} opts
 * @param {string} opts.projectName - Human-readable project name.
 * @param {string} opts.owner - GitHub org/user that owns the repo.
 * @param {string} opts.repo - Repository name (no owner prefix).
 * @param {string} [opts.description] - One-line project description (omitted if empty).
 * @param {string} opts.root - Absolute path to the project root.
 * @param {string} opts.worktreeBase - Directory where git worktrees are created.
 * @param {string} opts.defaultBranch - Default branch (e.g. main).
 * @param {string} opts.stagingBranch - Staging branch for fast-lane PRs.
 * @returns {string} The minimal forge.yaml content.
 */
export function buildMinimalForgeYaml({
  projectName,
  owner,
  repo,
  description = "",
  root,
  worktreeBase,
  defaultBranch,
  stagingBranch,
}) {
  const e = escapeYamlScalar;
  const descLine = description
    ? `\n  description: "${e(description)}"`
    : "";

  return `# forge.yaml — ForgeDock Configuration (minimal)
#
# Generated by: npx forgedock init --minimal
#
# Only project, paths, and branches are required — everything else is optional
# and falls back to sensible defaults. Start here and add sections as you need
# them. See forge.yaml.example and docs/CONFIG.md for the full reference.

# =============================================================================
# PROJECT (REQUIRED)
# =============================================================================

project:
  name: "${e(projectName)}"
  owner: "${e(owner)}"
  repo: "${e(repo)}"${descLine}

# =============================================================================
# PATHS (REQUIRED)
# =============================================================================

paths:
  root: "${e(root)}"
  worktree_base: "${e(worktreeBase)}"

# =============================================================================
# BRANCHES (REQUIRED)
# =============================================================================

branches:
  default: "${e(defaultBranch)}"
  staging: "${e(stagingBranch)}"
  feature_pattern: "milestone/{slug}"
`;
}
