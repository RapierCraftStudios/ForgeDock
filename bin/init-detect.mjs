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
import { join } from "path";

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
    // git not available or detached HEAD
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
    if (remoteBranches.includes("origin/staging")) {
      return high(
        "staging",
        "git branch -r",
        "Found 'origin/staging' in the remote branch listing",
      );
    }
  } catch {
    // git not available or no remotes
  }

  return medium(
    defaultBranch,
    "derived from default branch",
    `No 'origin/staging' remote branch found; staging defaults to the default branch '${defaultBranch}'`,
  );
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
  // Project identity
  const { owner, repo, remoteDetected } = detectRemote(cwd);

  // Project name derived from the repo slug
  const name = deriveProjectName(repo.value);

  // Paths — always high confidence (derived from the cwd argument)
  const root = high(cwd, "process.cwd()", "Absolute path passed to detectConfig — the project root");
  const worktreeBase = high(
    join(cwd, ".claude", "worktrees"),
    "derived from root",
    `Convention: {root}/.claude/worktrees (root = ${cwd})`,
  );

  // Branch detection
  const defaultBranchField = detectDefaultBranch(cwd);
  const stagingBranchField = detectStagingBranch(cwd, defaultBranchField.value);

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
