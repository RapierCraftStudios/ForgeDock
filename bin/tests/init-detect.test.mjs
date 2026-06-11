/**
 * bin/tests/init-detect.test.mjs
 *
 * Unit tests for detectConfig from bin/init-detect.mjs.
 *
 * Uses temporary directories with `git init` to create real fixture repos so
 * that the detection helpers run against actual git metadata.
 *
 * Covers:
 *   - detectConfig with SSH remote URL → high-confidence owner/repo
 *   - detectConfig with HTTPS remote URL → high-confidence owner/repo
 *   - detectConfig with no remote → low-confidence placeholder owner/repo
 *   - Default branch detection via symbolic-ref / current branch
 *   - Staging branch detection when origin/staging exists vs. absent
 *   - paths.root always equals the injected cwd
 *   - paths.worktreeBase is {root}/.claude/worktrees
 *   - project.name is derived from repo slug
 *   - meta.remoteDetected reflects whether a remote was found
 *
 * Run with: node --test bin/tests/init-detect.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { detectConfig } from "../init-detect.mjs";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command in `cwd`, swallowing stderr.
 * Throws if the command fails (non-zero exit).
 */
function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10000,
    env: {
      ...process.env,
      // Ensure git does not prompt for credentials
      GIT_TERMINAL_PROMPT: "0",
      // Suppress "safe directory" warnings on Windows CI
      GIT_CONFIG_GLOBAL: "",
    },
  });
}

/**
 * Create a bare git repo at `barePath` that can act as a fake remote.
 * Returns the path to the bare repo.
 */
function makeBareRepo(barePath) {
  mkdirSync(barePath, { recursive: true });
  git(["init", "--bare", barePath], os.tmpdir());
  return barePath;
}

/**
 * Create a local git repo at `localPath` with an initial commit on `defaultBranch`.
 */
function makeLocalRepo(localPath, defaultBranch = "main") {
  mkdirSync(localPath, { recursive: true });
  git(["init", "-b", defaultBranch, localPath], os.tmpdir());
  // Git requires at least one commit for symbolic-ref resolution
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], {
    cwd: localPath,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      // Suppress global git hooks (pre-commit, commit-msg) — mirrors git() helper
      GIT_CONFIG_GLOBAL: "",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
  });
  return localPath;
}

/**
 * Add a remote to a local repo and set the remote HEAD symbolic-ref.
 * `remoteUrl` can be a fake SSH/HTTPS URL string or a local path.
 */
function addRemote(localPath, remoteName, remoteUrl) {
  git(["remote", "add", remoteName, remoteUrl], localPath);
}

// =============================================================================
// SSH remote URL detection
// =============================================================================

describe("detectConfig — SSH remote URL", async () => {
  let tmpDir;
  let repoPath;

  before(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-detect-ssh-"));
    repoPath = join(tmpDir, "repo");
    makeLocalRepo(repoPath, "main");
    addRemote(repoPath, "origin", "git@github.com:my-org/my-repo.git");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects owner from SSH remote URL", async () => {
    const draft = await detectConfig(repoPath);
    assert.equal(draft.project.owner.value, "my-org");
    assert.equal(draft.project.owner.confidence, "high");
  });

  it("detects repo from SSH remote URL", async () => {
    const draft = await detectConfig(repoPath);
    assert.equal(draft.project.repo.value, "my-repo");
    assert.equal(draft.project.repo.confidence, "high");
  });

  it("sets meta.remoteDetected = true", async () => {
    const draft = await detectConfig(repoPath);
    assert.equal(draft.meta.remoteDetected, true);
  });

  it("derives project name from repo slug (title-case)", async () => {
    const draft = await detectConfig(repoPath);
    assert.equal(draft.project.name.value, "My Repo");
  });

  it("paths.root equals the injected cwd", async () => {
    const draft = await detectConfig(repoPath);
    assert.equal(draft.paths.root.value, repoPath);
    assert.equal(draft.paths.root.confidence, "high");
  });

  it("paths.worktreeBase is {root}/.claude/worktrees", async () => {
    const draft = await detectConfig(repoPath);
    assert.equal(draft.paths.worktreeBase.value, join(repoPath, ".claude", "worktrees"));
  });
});

// =============================================================================
// HTTPS remote URL detection
// =============================================================================

describe("detectConfig — HTTPS remote URL", async () => {
  let tmpDir;
  let repoPath;

  before(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-detect-https-"));
    repoPath = join(tmpDir, "repo");
    makeLocalRepo(repoPath, "main");
    addRemote(repoPath, "origin", "https://github.com/acme-corp/acme-platform.git");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects owner from HTTPS remote URL", async () => {
    const draft = await detectConfig(repoPath);
    assert.equal(draft.project.owner.value, "acme-corp");
    assert.equal(draft.project.owner.confidence, "high");
  });

  it("detects repo from HTTPS remote URL", async () => {
    const draft = await detectConfig(repoPath);
    assert.equal(draft.project.repo.value, "acme-platform");
    assert.equal(draft.project.repo.confidence, "high");
  });

  it("derives project name from hyphenated slug", async () => {
    const draft = await detectConfig(repoPath);
    // "acme-platform" → "Acme Platform"
    assert.equal(draft.project.name.value, "Acme Platform");
    assert.equal(draft.project.name.confidence, "medium");
  });
});

// =============================================================================
// No remote — low-confidence fallbacks
// =============================================================================

describe("detectConfig — no remote", async () => {
  let tmpDir;
  let repoPath;

  before(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-detect-noremote-"));
    repoPath = join(tmpDir, "repo");
    makeLocalRepo(repoPath, "main");
    // No remote added
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns low-confidence placeholder owner", async () => {
    const draft = await detectConfig(repoPath);
    assert.equal(draft.project.owner.confidence, "low");
    assert.ok(draft.project.owner.value.length > 0, "placeholder must be non-empty");
  });

  it("returns low-confidence placeholder repo", async () => {
    const draft = await detectConfig(repoPath);
    assert.equal(draft.project.repo.confidence, "low");
  });

  it("sets meta.remoteDetected = false", async () => {
    const draft = await detectConfig(repoPath);
    assert.equal(draft.meta.remoteDetected, false);
  });
});

// =============================================================================
// Default branch detection
// =============================================================================

describe("detectConfig — default branch detection", async () => {
  let tmpDir;
  let repoPath;

  before(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-detect-branch-"));
    repoPath = join(tmpDir, "repo");
    makeLocalRepo(repoPath, "develop");
    addRemote(repoPath, "origin", "git@github.com:org/repo.git");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects current branch as default when symbolic-ref unavailable", async () => {
    // Without fetching, refs/remotes/origin/HEAD does not exist.
    // Strategy 2 (current local branch = 'develop') should be used.
    const draft = await detectConfig(repoPath);
    assert.ok(
      draft.branches.default.value === "develop" || draft.branches.default.value === "main",
      `Expected branch to be 'develop' (or fallback 'main'), got '${draft.branches.default.value}'`,
    );
  });

  it("default branch confidence is 'medium' or 'high' (not low) for a real repo", async () => {
    const draft = await detectConfig(repoPath);
    assert.ok(
      ["medium", "high"].includes(draft.branches.default.confidence),
      `Expected medium or high confidence, got '${draft.branches.default.confidence}'`,
    );
  });
});

// =============================================================================
// Staging branch detection
// =============================================================================

describe("detectConfig — staging branch detection", async () => {
  let tmpDir;
  let mainRepoPath;
  let stagingRepoPath;

  before(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-detect-staging-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns high-confidence 'staging' when origin/staging exists", async () => {
    // Create a bare repo that has a 'staging' branch, then fetch from it
    const barePath = join(tmpDir, "bare-with-staging");
    makeBareRepo(barePath);
    // Create a local repo, push to bare (creates default branch), then add staging
    const initRepo = join(tmpDir, "init-repo");
    makeLocalRepo(initRepo, "main");
    addRemote(initRepo, "origin", barePath);
    git(["push", "-u", "origin", "main"], initRepo);
    // Create and push staging branch
    git(["checkout", "-b", "staging"], initRepo);
    git(["push", "-u", "origin", "staging"], initRepo);

    // Now detect from a fresh local repo pointing at the same bare remote
    mainRepoPath = join(tmpDir, "main-repo");
    makeLocalRepo(mainRepoPath, "main");
    addRemote(mainRepoPath, "origin", barePath);
    git(["fetch", "origin"], mainRepoPath);

    const draft = await detectConfig(mainRepoPath);
    assert.equal(draft.branches.staging.value, "staging");
    assert.equal(draft.branches.staging.confidence, "high");
  });

  it("falls back to default branch at medium confidence when no staging remote", async () => {
    stagingRepoPath = join(tmpDir, "no-staging-repo");
    makeLocalRepo(stagingRepoPath, "main");
    addRemote(stagingRepoPath, "origin", "git@github.com:org/repo.git");
    // No fetch — no remote branches visible → no origin/staging
    const draft = await detectConfig(stagingRepoPath);
    // Should fall back to default branch (or 'main') at medium confidence
    assert.equal(draft.branches.staging.confidence, "medium");
    assert.ok(draft.branches.staging.value.length > 0);
  });

  it("does NOT falsely detect staging from origin/staging-v2 (substring false positive)", async () => {
    // Regression guard: a repo with only 'staging-v2' must NOT produce a
    // high-confidence 'staging' result — the old includes() check would have
    // matched 'staging-v2' as a substring of 'origin/staging'.
    const barePath = join(tmpDir, "bare-with-staging-v2");
    makeBareRepo(barePath);
    const initRepo = join(tmpDir, "init-repo-v2");
    makeLocalRepo(initRepo, "main");
    addRemote(initRepo, "origin", barePath);
    git(["push", "-u", "origin", "main"], initRepo);
    // Push staging-v2 but NOT staging
    git(["checkout", "-b", "staging-v2"], initRepo);
    git(["push", "-u", "origin", "staging-v2"], initRepo);

    // Detect from a fresh local repo pointing at the same bare remote
    const detectRepo = join(tmpDir, "detect-repo-v2");
    makeLocalRepo(detectRepo, "main");
    addRemote(detectRepo, "origin", barePath);
    git(["fetch", "origin"], detectRepo);

    const draft = await detectConfig(detectRepo);
    // staging-v2 must NOT be mistaken for staging — result must NOT be high confidence
    assert.notEqual(
      draft.branches.staging.confidence,
      "high",
      "staging-v2 must not produce high-confidence staging detection (substring false positive)",
    );
    // Value must not be 'staging' from a false positive
    assert.notEqual(
      draft.branches.staging.value,
      "staging",
      "staging-v2 must not produce value 'staging' (substring false positive)",
    );
  });
});

// =============================================================================
// Non-git directory — graceful fallback
// =============================================================================

describe("detectConfig — non-git directory (graceful fallback)", async () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-detect-nongit-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a ConfigDraft without throwing for a non-git directory", async () => {
    let draft;
    await assert.doesNotReject(async () => {
      draft = await detectConfig(tmpDir);
    });
    assert.ok(draft, "draft should be defined");
    assert.ok(draft.project, "draft.project should exist");
    assert.ok(draft.paths, "draft.paths should exist");
    assert.ok(draft.branches, "draft.branches should exist");
  });

  it("returns low-confidence owner/repo for non-git directory", async () => {
    const draft = await detectConfig(tmpDir);
    assert.equal(draft.project.owner.confidence, "low");
    assert.equal(draft.project.repo.confidence, "low");
  });

  it("paths.root equals the injected cwd even for non-git directory", async () => {
    const draft = await detectConfig(tmpDir);
    assert.equal(draft.paths.root.value, tmpDir);
  });
});

// =============================================================================
// Project name derivation
// =============================================================================

describe("detectConfig — project name derivation", async () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-detect-name-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("title-cases a hyphenated slug", async () => {
    const repoPath = join(tmpDir, "repo");
    makeLocalRepo(repoPath, "main");
    addRemote(repoPath, "origin", "https://github.com/org/my-cool-project.git");
    const draft = await detectConfig(repoPath);
    assert.equal(draft.project.name.value, "My Cool Project");
  });

  it("title-cases an underscore-separated slug", async () => {
    const repoPath = join(tmpDir, "repo2");
    makeLocalRepo(repoPath, "main");
    addRemote(repoPath, "origin", "https://github.com/org/my_snake_case.git");
    const draft = await detectConfig(repoPath);
    assert.equal(draft.project.name.value, "My Snake Case");
  });

  it("handles single-word repo name", async () => {
    const repoPath = join(tmpDir, "repo3");
    makeLocalRepo(repoPath, "main");
    addRemote(repoPath, "origin", "https://github.com/org/forge.git");
    const draft = await detectConfig(repoPath);
    assert.equal(draft.project.name.value, "Forge");
  });
});
