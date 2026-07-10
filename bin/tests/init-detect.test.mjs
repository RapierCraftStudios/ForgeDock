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
import { join, resolve } from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { detectConfig, buildMinimalForgeYaml, resolveGitRoot } from "../init-detect.mjs";

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

  it("falls back to default branch at LOW confidence when no staging remote (forge#1850)", async () => {
    stagingRepoPath = join(tmpDir, "no-staging-repo");
    makeLocalRepo(stagingRepoPath, "main");
    addRemote(stagingRepoPath, "origin", "git@github.com:org/repo.git");
    // No fetch — no remote branches visible → no origin/staging
    const draft = await detectConfig(stagingRepoPath);
    // Deriving a merge target (staging is the fast-lane PR target) from a
    // failed lookup is a guess, not a "likely correct" inference — it must
    // be flagged "low" so it gets a # TODO comment and the [low] badge
    // instead of silently blending in as verified. Regression guard for
    // forge#1850 (medium confidence let a guessed staging: "main" ship
    // silently, turning a routine PR into a production deploy trigger).
    assert.equal(draft.branches.staging.confidence, "low");
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
// Monorepo-adjacent directory detection (forge#1850)
// =============================================================================
//
// Regression coverage for defect 3: `cwd` is not itself a git repository, but
// holds exactly one immediate subdirectory that is (the ScraperAPI/alterlab
// layout from the issue). Detection must resolve to that subdirectory instead
// of falling straight to "your-github-org"/"your-repo-name" placeholders.

describe("detectConfig — monorepo-adjacent subdirectory detection (forge#1850)", async () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-detect-monorepo-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves to the single git subdirectory when cwd itself is not a repo", async () => {
    const parentDir = join(tmpDir, "ScraperAPI");
    const repoDir = join(parentDir, "alterlab");
    makeLocalRepo(repoDir, "main");
    addRemote(repoDir, "origin", "https://github.com/RapierCraftStudios/alterlab.git");

    const draft = await detectConfig(parentDir);

    // Owner/repo detected from the subdirectory's remote, not placeholders.
    assert.equal(draft.project.owner.value, "RapierCraftStudios");
    assert.equal(draft.project.repo.value, "alterlab");
    assert.notEqual(draft.project.owner.confidence, "low");
    // paths.root redirected to the subdirectory, not the (non-repo) parent.
    assert.equal(draft.paths.root.value, repoDir);
    assert.match(draft.paths.root.why, /alterlab/);
  });

  it("falls back to placeholders when cwd has zero git subdirectories", async () => {
    const parentDir = join(tmpDir, "no-subdirs");
    mkdirSync(join(parentDir, "not-a-repo"), { recursive: true });

    const draft = await detectConfig(parentDir);

    assert.equal(draft.project.owner.value, "your-github-org");
    assert.equal(draft.paths.root.value, parentDir);
  });

  it("falls back to placeholders when cwd has multiple git subdirectories (ambiguous)", async () => {
    const parentDir = join(tmpDir, "multi-repo");
    makeLocalRepo(join(parentDir, "repo-a"), "main");
    makeLocalRepo(join(parentDir, "repo-b"), "main");

    const draft = await detectConfig(parentDir);

    // Ambiguous — must not guess which subdirectory is "the" repo.
    assert.equal(draft.project.owner.value, "your-github-org");
    assert.equal(draft.paths.root.value, parentDir);
  });
});

// =============================================================================
// resolveGitRoot (direct unit tests — forge#1927)
// =============================================================================
//
// resolveGitRoot() was previously only exercised indirectly through
// detectConfig() (see the monorepo-adjacent describe block above). It is now
// exported directly so bin/hooks/session-start.mjs can reuse it for
// nudge-tracking. These tests cover it in isolation, independent of the rest
// of detectConfig()'s detection pipeline.

describe("resolveGitRoot", async () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-resolve-git-root-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns cwd unresolved when cwd is itself a git repo root", () => {
    const repoDir = join(tmpDir, "own-repo");
    makeLocalRepo(repoDir, "main");

    const result = resolveGitRoot(repoDir);

    assert.equal(result.root, repoDir);
    assert.equal(result.resolved, false);
  });

  it("resolves to the true toplevel when cwd is nested inside a repo", () => {
    const repoDir = join(tmpDir, "nested-repo");
    makeLocalRepo(repoDir, "main");
    const nestedDir = join(repoDir, "src", "components");
    mkdirSync(nestedDir, { recursive: true });

    const result = resolveGitRoot(nestedDir);

    // git rev-parse --show-toplevel always emits forward slashes, even on
    // Windows (see resolveGitRoot's own doc comment) — normalize with
    // path.resolve() before comparing so a pure separator-style difference
    // doesn't fail the assertion.
    assert.equal(resolve(result.root), resolve(repoDir));
    assert.equal(result.resolved, true);
  });

  it("resolves to the single git subdirectory when cwd is a non-repo parent", () => {
    const parentDir = join(tmpDir, "single-child-parent");
    const repoDir = join(parentDir, "my-app");
    makeLocalRepo(repoDir, "main");

    const result = resolveGitRoot(parentDir);

    assert.equal(result.root, repoDir);
    assert.equal(result.resolved, true);
    assert.match(result.why, /my-app/);
  });

  it("falls back to unresolved cwd when there are zero git subdirectories", () => {
    const parentDir = join(tmpDir, "no-child-repos");
    mkdirSync(join(parentDir, "not-a-repo"), { recursive: true });

    const result = resolveGitRoot(parentDir);

    assert.equal(result.root, parentDir);
    assert.equal(result.resolved, false);
  });

  it("falls back to unresolved cwd when there are two or more git subdirectories (ambiguous)", () => {
    const parentDir = join(tmpDir, "two-sibling-repos");
    makeLocalRepo(join(parentDir, "repo-a"), "main");
    makeLocalRepo(join(parentDir, "repo-b"), "main");

    const result = resolveGitRoot(parentDir);

    assert.equal(result.root, parentDir);
    assert.equal(result.resolved, false);
  });

  it("falls back to unresolved cwd when cwd does not exist", () => {
    const missingDir = join(tmpDir, "does-not-exist");

    const result = resolveGitRoot(missingDir);

    assert.equal(result.root, missingDir);
    assert.equal(result.resolved, false);
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

// ---------------------------------------------------------------------------
// buildMinimalForgeYaml — pure minimal-template builder (#1148)
// ---------------------------------------------------------------------------

describe("buildMinimalForgeYaml", () => {
  const base = {
    projectName: "My App",
    owner: "my-org",
    repo: "my-repo",
    description: "A test project",
    root: "/home/me/my-repo",
    worktreeBase: "/home/me/my-repo/.claude/worktrees",
    defaultBranch: "main",
    stagingBranch: "staging",
  };

  it("includes all three required sections so `doctor` passes", () => {
    const yaml = buildMinimalForgeYaml(base);
    assert.match(yaml, /^project:/m);
    assert.match(yaml, /^paths:/m);
    assert.match(yaml, /^branches:/m);
  });

  it("embeds the detected values", () => {
    const yaml = buildMinimalForgeYaml(base);
    assert.match(yaml, /name: "My App"/);
    assert.match(yaml, /owner: "my-org"/);
    assert.match(yaml, /repo: "my-repo"/);
    assert.match(yaml, /description: "A test project"/);
    assert.match(yaml, /root: "\/home\/me\/my-repo"/);
    assert.match(yaml, /worktree_base: "\/home\/me\/my-repo\/\.claude\/worktrees"/);
    assert.match(yaml, /default: "main"/);
    assert.match(yaml, /staging: "staging"/);
    assert.match(yaml, /feature_pattern: "milestone\/\{slug\}"/);
  });

  it("omits all commented optional sections (stays minimal)", () => {
    const yaml = buildMinimalForgeYaml(base);
    assert.doesNotMatch(yaml, /# repos:/);
    assert.doesNotMatch(yaml, /# project_board:/);
    assert.doesNotMatch(yaml, /# review:/);
    assert.doesNotMatch(yaml, /# verification:/);
    // Far shorter than the full ~200-line template.
    assert.ok(yaml.split("\n").length < 40, "minimal config should be under 40 lines");
  });

  it("omits the description line when description is empty", () => {
    const yaml = buildMinimalForgeYaml({ ...base, description: "" });
    assert.doesNotMatch(yaml, /description:/);
  });

  it("escapes backslashes in Windows paths (ref: forge#810)", () => {
    const yaml = buildMinimalForgeYaml({
      ...base,
      root: String.raw`C:\Users\me\my-repo`,
      worktreeBase: String.raw`C:\Users\me\my-repo\.claude\worktrees`,
    });
    // Each backslash in the path is doubled in the emitted YAML scalar.
    assert.ok(yaml.includes(String.raw`root: "C:\\Users\\me\\my-repo"`));
    assert.ok(
      yaml.includes(
        String.raw`worktree_base: "C:\\Users\\me\\my-repo\\.claude\\worktrees"`,
      ),
    );
  });

  it("escapes embedded double quotes", () => {
    const yaml = buildMinimalForgeYaml({ ...base, description: 'has "quotes"' });
    assert.ok(yaml.includes('description: "has \\"quotes\\""'));
  });
});
