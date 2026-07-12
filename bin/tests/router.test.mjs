/**
 * bin/tests/router.test.mjs — CLI-level tests for bin/forgedock.mjs routing.
 * Run with: node --test bin/tests/router.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, cpSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "forgedock.mjs");

function runCli(args, { cwd, home, extraEnv } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd ?? mkdtempSync(join(os.tmpdir(), "fd-cli-cwd-")),
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", ...extraEnv },
    encoding: "utf-8",
    timeout: 30000,
  });
}

describe("router", () => {
  it("help lists the union of journey + engine commands — no phantom commands", () => {
    const res = runCli(["help"], { home: mkdtempSync(join(os.tmpdir(), "fd-h-")) });
    assert.equal(res.status, 0);
    // Journey/onboarding surface
    assert.match(res.stdout, /install/);
    assert.match(res.stdout, /enable/);
    assert.match(res.stdout, /disable/);
    assert.match(res.stdout, /status/);
    // Engine surface (real commands merged from staging)
    assert.match(res.stdout, /demo/);
    assert.match(res.stdout, /run-issue/);
    assert.match(res.stdout, /doctor/);
    // Journey flags
    assert.match(res.stdout, /--fast/);
    assert.match(res.stdout, /--manual/);
    assert.match(res.stdout, /--verbose/);
    // Never-shipped command must not reappear
    assert.doesNotMatch(res.stdout, /integrate/);
  });

  it("unknown command exits 1", () => {
    const res = runCli(["frobnicate"], { home: mkdtempSync(join(os.tmpdir(), "fd-u-")) });
    assert.equal(res.status, 1);
    assert.match(res.stdout + res.stderr, /Unknown command/);
  });

  it("status reports unmanaged in a fresh directory", () => {
    const res = runCli(["status"], { home: mkdtempSync(join(os.tmpdir(), "fd-s-")) });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /unmanaged|not active/i);
  });

  it("disable then status reports opted out", () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-d-"));
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-d-cwd-"));
    writeFileSync(join(cwd, "forge.yaml"), "project:\n", "utf-8");
    assert.equal(runCli(["disable"], { home, cwd }).status, 0);
    const res = runCli(["status"], { home, cwd });
    assert.match(res.stdout, /opted.?out|disabled/i);
  });

  it("enable in a bare directory creates the .forgedock marker", () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-e-"));
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-e-cwd-"));
    assert.equal(runCli(["enable"], { home, cwd }).status, 0);
    assert.ok(existsSync(join(cwd, ".forgedock")));
  });

  it("works without HOME when USERPROFILE is set (no hard exit)", () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-w-"));
    const res = spawnSync(process.execPath, [CLI, "help"], {
      env: { ...process.env, HOME: "", USERPROFILE: home, NO_COLOR: "1" },
      encoding: "utf-8",
      timeout: 30000,
    });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.stdout + res.stderr, /HOME environment variable/);
  });

  it("uninstall removes copy-installed commands and clears the ownership manifest", () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-copy-"));
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-copy-cwd-"));
    const targetDir = join(home, ".claude", "commands");
    mkdirSync(targetDir, { recursive: true });

    // Simulate a prior copy-mode install (Windows without Developer Mode):
    // a regular file at the target path, recorded in the ownership manifest.
    const rel = "fake-copied-command.md";
    writeFileSync(join(targetDir, rel), "# fake command\n", "utf-8");
    const manifestDir = join(home, ".claude", "forgedock");
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, "copied-commands.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ version: 1, files: { [rel]: true } }, null, 2) + "\n",
      "utf-8",
    );

    const res = runCli(["uninstall"], { home, cwd });
    assert.equal(res.status, 0);
    assert.ok(!existsSync(join(targetDir, rel)), "copied command file should be removed");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    assert.deepEqual(manifest.files, {}, "manifest should be cleared of removed entries");
  });

  it("update in a forgeHome without .git checks the npm registry (not the old dead 'npm update -g' hint), relinks via forge, and exits 0 (#1902)", () => {
    // FORGE_HOME is derived from the CLI file's location — to exercise the
    // "installed via npm" branch (no .git), copy bin/ into a temp forgeHome
    // and spawn the copy. update() checks for .git before touching anything
    // else. forge() now runs as the repair path even here, so give it a
    // commands/ directory to link.
    //
    // package.json is intentionally NOT copied into forgeHome, so getVersion()
    // resolves to "" here — the branch taken then depends only on whether the
    // sandbox has network access to the npm registry, so the assertion below
    // accepts either outcome rather than asserting on a live network result.
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-npm-"));
    cpSync(join(dirname(CLI)), join(forgeHome, "bin"), {
      recursive: true,
      filter: (src) => !src.includes("tests"),
    });
    mkdirSync(join(forgeHome, "commands"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "one.md"), "# /one\n\nTest command\n", "utf-8");
    const home = mkdtempSync(join(os.tmpdir(), "fd-npm-home-"));
    const res = spawnSync(process.execPath, [join(forgeHome, "bin", "forgedock.mjs"), "update"], {
      cwd: mkdtempSync(join(os.tmpdir(), "fd-npm-cwd-")),
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
      encoding: "utf-8",
      timeout: 30000,
    });
    assert.equal(res.status, 0);
    // The old dead-end advice ("forgedock was never installed via npm -g, so
    // this is a no-op") must never appear again (#1902).
    assert.doesNotMatch(res.stdout, /npm update -g forgedock/);
    // Either the registry lookup succeeded (reports the latest published
    // version) or it failed gracefully (network unavailable in the sandbox) —
    // both are correct outcomes of the real version check.
    assert.match(
      res.stdout,
      /Latest published version is|New version available|Already up to date|Could not check npm for the latest version/,
    );
    // forge() now runs as a repair path — commands get (re)linked/copied.
    assert.match(res.stdout, /slash command/i);
    assert.ok(existsSync(join(home, ".claude", "commands", "one.md")));
    // Guard: update must never enter the config journey.
    assert.doesNotMatch(res.stdout, /Reading your repository/);
    assert.doesNotMatch(res.stdout, /forge\.yaml configuration/);
  });

  it("update from a git worktree resolves symlinks to the main repo, not the worktree (#1700)", () => {
    // Simulate issue #1700: forgedock.mjs runs from inside a git worktree.
    // A git worktree has a .git FILE (not a directory).  resolveRealForgeHome()
    // must detect this, resolve to the main repo root, and link commands from
    // there — not from the ephemeral worktree that will be cleaned up.
    //
    // Physical layout:
    //   remoteRepo/        — bare clone (local remote so git fetch succeeds)
    //   mainRepo/          — the real, stable installation (has .git DIR)
    //     commands/stable.md
    //     bin/             — copy of forgedock CLI for forge()
    //   worktree/          — ephemeral worktree (has .git FILE)
    //     .git             — file: "gitdir: mainRepo/.git/worktrees/test-wt"
    //     commands/ephemeral.md
    //     bin/forgedock.mjs — script under test
    //
    // Test flow:
    //   resolveRealForgeHome(worktree)
    //     → detects worktree/.git is a FILE
    //     → runs git rev-parse --git-common-dir (cwd: worktree) → mainRepo/.git
    //     → returns mainRepo (dirname of mainRepo/.git)
    //   update() with FORGE_HOME = mainRepo
    //     → mainRepo/.git is a DIR → git-clone path
    //     → on "main" branch → git fetch origin main → succeeds (local bare remote)
    //     → already up to date → relinkAndHint() → links mainRepo/commands

    const remoteRepo = mkdtempSync(join(os.tmpdir(), "fd-remote-"));
    const mainRepo = mkdtempSync(join(os.tmpdir(), "fd-main-repo-"));
    const worktree = mkdtempSync(join(os.tmpdir(), "fd-worktree-"));

    // Git identity env vars — required on CI runners that have no global user.email/user.name.
    // Without these, `git commit --allow-empty` exits non-zero (silent, stdio:pipe), leaving
    // mainRepo with zero commits. git rev-parse HEAD then fails with "ambiguous argument 'HEAD'",
    // which update() catches as "Cannot fast-forward — local changes exist" and skips relink.
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "ForgeDock Test",
      GIT_AUTHOR_EMAIL: "test@forgedock.test",
      GIT_COMMITTER_NAME: "ForgeDock Test",
      GIT_COMMITTER_EMAIL: "test@forgedock.test",
    };

    // Bootstrap: bare remote repo, then clone it as mainRepo.
    // Use -b main explicitly so the initial branch is "main" regardless of
    // the system's init.defaultBranch config (CI runners may default to "master").
    spawnSync("git", ["init", "--bare", "-b", "main", remoteRepo], { stdio: "pipe" });
    spawnSync("git", ["init", "-b", "main", mainRepo], { stdio: "pipe" });
    spawnSync("git", ["-C", mainRepo, "remote", "add", "origin", remoteRepo], { stdio: "pipe" });
    spawnSync("git", ["-C", mainRepo, "commit", "--allow-empty", "-m", "init"], {
      stdio: "pipe",
      env: gitEnv,
    });
    spawnSync("git", ["-C", mainRepo, "push", "origin", "main"], { stdio: "pipe" });

    // Build the git worktree admin chain so git commands work from worktree
    mkdirSync(join(mainRepo, ".git", "worktrees", "test-wt"), { recursive: true });
    writeFileSync(
      join(mainRepo, ".git", "worktrees", "test-wt", "gitdir"),
      `${join(worktree, ".git")}\n`,
      "utf-8",
    );
    writeFileSync(join(mainRepo, ".git", "worktrees", "test-wt", "commondir"), "../..\n", "utf-8");
    writeFileSync(
      join(mainRepo, ".git", "worktrees", "test-wt", "HEAD"),
      "ref: refs/heads/fix/test\n",
      "utf-8",
    );
    // worktree/.git is the FILE that marks this directory as a linked worktree
    writeFileSync(
      join(worktree, ".git"),
      `gitdir: ${join(mainRepo, ".git", "worktrees", "test-wt")}\n`,
      "utf-8",
    );

    // Install the forgedock CLI into the WORKTREE (the binary the agent would invoke)
    cpSync(join(dirname(CLI)), join(worktree, "bin"), {
      recursive: true,
      filter: (src) => !src.includes("tests"),
    });

    // Commands in the WORKTREE — must NOT be symlinked (dangling after cleanup)
    mkdirSync(join(worktree, "commands"), { recursive: true });
    writeFileSync(join(worktree, "commands", "ephemeral.md"), "# Ephemeral\n", "utf-8");

    // Commands in the MAIN REPO — these are the stable ones that SHOULD be symlinked
    mkdirSync(join(mainRepo, "commands"), { recursive: true });
    writeFileSync(join(mainRepo, "commands", "stable.md"), "# Stable\n", "utf-8");

    // Copy bin/ into mainRepo so forge() can find session-start.mjs when relinking
    cpSync(join(dirname(CLI)), join(mainRepo, "bin"), {
      recursive: true,
      filter: (src) => !src.includes("tests"),
    });

    const home = mkdtempSync(join(os.tmpdir(), "fd-wt-home-"));

    // Run forgedock update from the WORKTREE binary.
    // Before fix: FORGE_HOME = worktree path → ephemeral.md installed → dangling after cleanup.
    // After fix:  FORGE_HOME = mainRepo path → stable.md installed → stable forever.
    const res = spawnSync(
      process.execPath,
      [join(worktree, "bin", "forgedock.mjs"), "update"],
      {
        cwd: mkdtempSync(join(os.tmpdir(), "fd-wt-cwd-")),
        env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
        encoding: "utf-8",
        timeout: 30000,
      },
    );

    assert.equal(res.status, 0, `update exited non-zero:\n${res.stderr}`);

    // stable.md from the MAIN REPO must be installed
    assert.ok(
      existsSync(join(home, ".claude", "commands", "stable.md")),
      "stable.md from the main repo must be installed (resolveRealForgeHome resolved correctly)",
    );

    // ephemeral.md from the WORKTREE must NOT be installed
    assert.ok(
      !existsSync(join(home, ".claude", "commands", "ephemeral.md")),
      "ephemeral.md from the worktree must NOT be installed (would become dangling after cleanup)",
    );
  });

  it("init --manual non-TTY with existing forge.yaml aborts (exit 1, file untouched)", () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-manual-abort-home-"));
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-manual-abort-cwd-"));
    const preContent = "precious: config\n";
    writeFileSync(join(cwd, "forge.yaml"), preContent, "utf-8");

    const res = spawnSync(process.execPath, [CLI, "init", "--manual"], {
      cwd,
      input: "",
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
      encoding: "utf-8",
      timeout: 30000,
    });

    assert.equal(res.status, 1);
    assert.match(res.stdout + res.stderr, /already exists/i);
    assert.equal(readFileSync(join(cwd, "forge.yaml"), "utf-8"), preContent);
  });

  it("golden path: journey install (--fast, non-TTY) with a pre-existing CLAUDE.md (no managed block) leaves doctor exiting 0", () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-doctor-home-"));
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-doctor-cwd-"));

    // Deterministic git identity, independent of the host machine's own
    // global git config — Check 3 (git configured) must pass reliably.
    writeFileSync(
      join(home, ".gitconfig"),
      "[user]\n\tname = Test User\n\temail = test@example.com\n",
      "utf-8",
    );

    // Pre-existing CLAUDE.md with no ForgeDock managed block. The journey
    // install must not require one, and doctor must not treat its absence
    // as a failure — session context comes from the SessionStart hook.
    writeFileSync(
      join(cwd, "CLAUDE.md"),
      "# Project notes\n\nSome existing content.\n",
      "utf-8",
    );

    // Stub external tools (gh, yq) so doctor passes in isolated environments
    // (CI, sandboxed test HOMEs) where these aren't installed/authenticated.
    const stubBin = mkdtempSync(join(os.tmpdir(), "fd-stub-bin-"));
    // gh: must handle "gh --version" and "gh auth status" with exit 0
    writeFileSync(join(stubBin, "gh"), "#!/bin/sh\necho 'gh version 2.60.0'\n", { mode: 0o755 });
    // yq: must handle "yq --version" with exit 0
    writeFileSync(join(stubBin, "yq"), "#!/bin/sh\necho 'yq (https://github.com/mikefarah/yq/) version v4.44.0'\n", { mode: 0o755 });

    const stubEnv = { PATH: `${stubBin}:${process.env.PATH}` };

    const installRes = runCli(["install", "--fast"], { cwd, home, extraEnv: stubEnv });
    assert.equal(installRes.status, 0, installRes.stdout + installRes.stderr);
    assert.ok(existsSync(join(cwd, "forge.yaml")));

    const doctorRes = runCli(["doctor"], { cwd, home, extraEnv: stubEnv });
    assert.equal(doctorRes.status, 0, doctorRes.stdout + doctorRes.stderr);
    // forge#1895: the new hook-script-path-integrity check must PASS here —
    // FORGE_HOME in this test is the real, on-disk repo location, so the
    // baked-in hook script path genuinely exists.
    assert.match(doctorRes.stdout, /SessionStart hook script path/i);
    assert.doesNotMatch(doctorRes.stdout, /no longer exists/i);
  });

  it("install/status/doctor agree on location when cwd has its own unrelated .claude/commands/ (#1589)", () => {
    // Regression for the install split-brain: journey's forge() always
    // writes to home/.claude/commands (global) — it never respects cwd.
    // detectInstallPaths() must therefore always report that same global
    // location, even when cwd happens to already have its own, unrelated
    // .claude/commands/ directory (e.g. a repo with its own Claude commands,
    // ForgeDock's own repo included). Before the fix, detectInstallPaths()
    // treated cwd's .claude/commands/ existence as evidence of a
    // "project-scoped ForgeDock install" and pointed status/doctor/uninstall
    // at the wrong directory.
    const home = mkdtempSync(join(os.tmpdir(), "fd-split-home-"));
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-split-cwd-"));

    writeFileSync(
      join(home, ".gitconfig"),
      "[user]\n\tname = Test User\n\temail = test@example.com\n",
      "utf-8",
    );

    // Pre-existing, unrelated .claude/commands/ in cwd — NOT created by
    // ForgeDock. This is exactly the false-positive trigger from the issue.
    const cwdClaudeCommands = join(cwd, ".claude", "commands");
    mkdirSync(cwdClaudeCommands, { recursive: true });
    const unrelatedFile = "not-a-forgedock-command.md";
    writeFileSync(join(cwdClaudeCommands, unrelatedFile), "# user's own command\n", "utf-8");

    const stubBin = mkdtempSync(join(os.tmpdir(), "fd-split-stub-bin-"));
    writeFileSync(join(stubBin, "gh"), "#!/bin/sh\necho 'gh version 2.60.0'\n", { mode: 0o755 });
    writeFileSync(join(stubBin, "yq"), "#!/bin/sh\necho 'yq (https://github.com/mikefarah/yq/) version v4.44.0'\n", { mode: 0o755 });
    const stubEnv = { PATH: `${stubBin}:${process.env.PATH}` };

    const installRes = runCli(["install", "--fast"], { cwd, home, extraEnv: stubEnv });
    assert.equal(installRes.status, 0, installRes.stdout + installRes.stderr);

    const homeCommandsDir = join(home, ".claude", "commands");
    assert.ok(existsSync(homeCommandsDir), "install must write to the global home directory");
    assert.ok(
      existsSync(join(homeCommandsDir, "work-on.md")),
      "install must land known command files in the global home directory",
    );

    // cwd's own unrelated .claude/commands/ must be left completely alone.
    assert.ok(
      existsSync(join(cwdClaudeCommands, unrelatedFile)),
      "install must not touch cwd's pre-existing, unrelated .claude/commands/",
    );
    assert.ok(
      !existsSync(join(cwdClaudeCommands, "work-on.md")),
      "install must not land ForgeDock commands in cwd's .claude/commands/",
    );

    const statusRes = runCli(["status"], { cwd, home, extraEnv: stubEnv });
    assert.equal(statusRes.status, 0, statusRes.stdout + statusRes.stderr);
    assert.match(statusRes.stdout, /installed at/i);
    assert.doesNotMatch(
      statusRes.stdout,
      /not installed/i,
      "status must find the real (global) install, not conclude nothing is installed",
    );

    const doctorRes = runCli(["doctor"], { cwd, home, extraEnv: stubEnv });
    assert.equal(doctorRes.status, 0, doctorRes.stdout + doctorRes.stderr);
    assert.doesNotMatch(
      doctorRes.stdout,
      /project-scoped/i,
      "doctor must not report a project-scoped mode — install never writes there",
    );

    const uninstallRes = runCli(["uninstall"], { cwd, home, extraEnv: stubEnv });
    assert.equal(uninstallRes.status, 0, uninstallRes.stdout + uninstallRes.stderr);
    // uninstall must clear out what install actually created (the global dir)...
    assert.ok(
      !existsSync(join(homeCommandsDir, "work-on.md")),
      "uninstall must remove the command files install created in the global directory",
    );
    // ...and must still leave cwd's unrelated file untouched.
    assert.ok(
      existsSync(join(cwdClaudeCommands, unrelatedFile)),
      "uninstall must not touch cwd's pre-existing, unrelated .claude/commands/",
    );
  });
});

describe("doctor — forge.yaml placeholder / staleness checks (forge#1850)", () => {
  function stubTools() {
    const stubBin = mkdtempSync(join(os.tmpdir(), "fd-doctor-stub-bin-"));
    writeFileSync(join(stubBin, "gh"), "#!/bin/sh\necho 'gh version 2.60.0'\n", { mode: 0o755 });
    writeFileSync(join(stubBin, "yq"), "#!/bin/sh\necho 'yq (https://github.com/mikefarah/yq/) version v4.44.0'\n", { mode: 0o755 });
    return { PATH: `${stubBin}:${process.env.PATH}` };
  }

  /**
   * Runs a full `install --fast` first (so command files + SessionStart hook
   * checks are satisfied), then overwrites forge.yaml with custom content —
   * isolating these tests to just the forge.yaml placeholder/staleness checks
   * under test, not the whole install surface.
   */
  function setupWithForgeYaml(forgeYamlContent) {
    const home = mkdtempSync(join(os.tmpdir(), "fd-doctor-ph-home-"));
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-doctor-ph-cwd-"));
    writeFileSync(
      join(home, ".gitconfig"),
      "[user]\n\tname = Test User\n\temail = test@example.com\n",
      "utf-8",
    );
    const extraEnv = stubTools();
    const installRes = runCli(["install", "--fast"], { cwd, home, extraEnv });
    assert.equal(installRes.status, 0, installRes.stdout + installRes.stderr);
    writeFileSync(join(cwd, "forge.yaml"), forgeYamlContent, "utf-8");
    return { home, cwd, extraEnv };
  }

  it("warns (but does not fail) on placeholder owner/repo — advisory, not a broken-install exit code", () => {
    const { home, cwd, extraEnv } = setupWithForgeYaml(
      [
        "project:",
        '  name: "Your Repo Name"',
        '  owner: "your-github-org"  # TODO(forgedock:owner) — verify this value',
        '  repo: "your-repo-name"  # TODO(forgedock:repo) — verify this value',
        "paths:",
        '  root: "/tmp/x"',
        "branches:",
        '  default: "main"',
        '  staging: "main"',
        "",
      ].join("\n"),
    );

    const res = runCli(["doctor"], { cwd, home, extraEnv });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /forge\.yaml identity/i);
    assert.match(res.stdout, /placeholder values/i);
  });

  it("warns when branches.staging equals branches.default", () => {
    const { home, cwd, extraEnv } = setupWithForgeYaml(
      [
        "project:",
        '  name: "Real Project"',
        '  owner: "real-org"',
        '  repo: "real-repo"',
        "paths:",
        '  root: "/tmp/x"',
        "branches:",
        '  default: "main"',
        '  staging: "main"',
        "",
      ].join("\n"),
    );

    const res = runCli(["doctor"], { cwd, home, extraEnv });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /branches\.staging equals branches\.default/i);
  });

  it("stays clean for a fully-resolved config — no placeholder or staging warnings", () => {
    const { home, cwd, extraEnv } = setupWithForgeYaml(
      [
        "project:",
        '  name: "Real Project"',
        '  owner: "real-org"',
        '  repo: "real-repo"',
        "paths:",
        '  root: "/tmp/x"',
        "branches:",
        '  default: "main"',
        '  staging: "staging"',
        "",
      ].join("\n"),
    );

    const res = runCli(["doctor"], { cwd, home, extraEnv });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /forge\.yaml identity/i);
    assert.doesNotMatch(res.stdout, /branches\.staging equals branches\.default/i);
    assert.doesNotMatch(res.stdout, /forge\.yaml placeholders/i);
  });
});

describe("doctor: SessionStart hook script path integrity (Check 5c, forge#1895)", () => {
  function stubTools() {
    const stubBin = mkdtempSync(join(os.tmpdir(), "fd-hookcheck-stub-bin-"));
    writeFileSync(join(stubBin, "gh"), "#!/bin/sh\necho 'gh version 2.60.0'\n", { mode: 0o755 });
    writeFileSync(join(stubBin, "yq"), "#!/bin/sh\necho 'yq (https://github.com/mikefarah/yq/) version v4.44.0'\n", { mode: 0o755 });
    return { PATH: `${stubBin}:${process.env.PATH}` };
  }

  /**
   * Runs a real `install --fast` (so a genuine SessionStart hook entry is
   * registered pointing at the real, existing hook script), then rewrites
   * that entry's command to point at a path that does not exist — simulating
   * a hook script that has since gone missing (e.g. a pruned npx cache).
   */
  function installThenBreakHookPath(brokenPath) {
    const home = mkdtempSync(join(os.tmpdir(), "fd-hookcheck-home-"));
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-hookcheck-cwd-"));
    writeFileSync(
      join(home, ".gitconfig"),
      "[user]\n\tname = Test User\n\temail = test@example.com\n",
      "utf-8",
    );
    const extraEnv = stubTools();
    const installRes = runCli(["install", "--fast"], { cwd, home, extraEnv });
    assert.equal(installRes.status, 0, installRes.stdout + installRes.stderr);

    const settingsPath = join(home, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    for (const entry of settings.hooks.SessionStart) {
      for (const h of entry.hooks) {
        if (typeof h.command === "string" && h.command.includes("session-start.mjs")) {
          h.command = `node "${brokenPath}"`;
        }
      }
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    return { home, cwd, extraEnv };
  }

  it("fails with a generic fix hint when the hook script path is missing (non-cache path)", () => {
    const brokenPath = join(os.tmpdir(), "fd-hookcheck-gone-", "bin", "hooks", "session-start.mjs");
    const { home, cwd, extraEnv } = installThenBreakHookPath(brokenPath);

    const res = runCli(["doctor"], { cwd, home, extraEnv });
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /SessionStart hook script path/i);
    assert.match(res.stdout, /no longer exists/i);
    assert.doesNotMatch(res.stdout, /ephemeral npm\/npx\/pnpm\/yarn cache/i);
  });

  it("fails with an ephemeral-cache-aware fix hint when the missing path sits inside an npx cache shape", () => {
    const brokenPath = join(os.tmpdir(), "fd-hookcheck-npx-", "_npx", "a1b2c3", "node_modules", "forgedock", "bin", "hooks", "session-start.mjs");
    const { home, cwd, extraEnv } = installThenBreakHookPath(brokenPath);

    const res = runCli(["doctor"], { cwd, home, extraEnv });
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /SessionStart hook script path/i);
    assert.match(res.stdout, /ephemeral npm\/npx\/pnpm\/yarn cache/i);
    assert.match(res.stdout, /npm install -g forgedock/);
  });

  it("doctor --fix refreshes a dangling hook script path (forge#1944)", () => {
    const brokenPath = join(os.tmpdir(), "fd-hookcheck-fix-gone-", "bin", "hooks", "session-start.mjs");
    const { home, cwd, extraEnv } = installThenBreakHookPath(brokenPath);

    // Plain doctor still fails — --fix must never run implicitly.
    const before = runCli(["doctor"], { cwd, home, extraEnv });
    assert.equal(before.status, 1, before.stdout + before.stderr);
    assert.match(before.stdout, /SessionStart hook script path/i);
    assert.doesNotMatch(before.stdout, /auto-fixed/i);

    const fixRes = runCli(["doctor", "--fix"], { cwd, home, extraEnv });
    assert.equal(fixRes.status, 0, fixRes.stdout + fixRes.stderr);
    assert.match(fixRes.stdout, /SessionStart hook script path/i);
    assert.match(fixRes.stdout, /issue\(s\) auto-fixed/i);

    // The registered entry must now point at a real, existing script.
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
    const commands = settings.hooks.SessionStart.flatMap((e) => e.hooks.map((h) => h.command));
    const ours = commands.find((c) => c.includes("session-start.mjs"));
    assert.ok(ours, "a SessionStart hook entry must still be registered");
    assert.doesNotMatch(ours, /fd-hookcheck-fix-gone-/, "the dangling path must have been replaced");

    // Idempotent: a second --fix run reports all-clear, no further fixes.
    const secondFix = runCli(["doctor", "--fix"], { cwd, home, extraEnv });
    assert.equal(secondFix.status, 0, secondFix.stdout + secondFix.stderr);
    assert.doesNotMatch(secondFix.stdout, /issue\(s\) auto-fixed/i);
  });
});

describe("doctor --fix (forge#1944)", () => {
  function stubTools() {
    const stubBin = mkdtempSync(join(os.tmpdir(), "fd-doctor-fix-stub-bin-"));
    writeFileSync(join(stubBin, "gh"), "#!/bin/sh\necho 'gh version 2.60.0'\n", { mode: 0o755 });
    writeFileSync(join(stubBin, "yq"), "#!/bin/sh\necho 'yq (https://github.com/mikefarah/yq/) version v4.44.0'\n", { mode: 0o755 });
    return { PATH: `${stubBin}:${process.env.PATH}` };
  }

  function setupInstall() {
    const home = mkdtempSync(join(os.tmpdir(), "fd-doctor-fix-home-"));
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-doctor-fix-cwd-"));
    writeFileSync(
      join(home, ".gitconfig"),
      "[user]\n\tname = Test User\n\temail = test@example.com\n",
      "utf-8",
    );
    const extraEnv = stubTools();
    const installRes = runCli(["install", "--fast"], { cwd, home, extraEnv });
    assert.equal(installRes.status, 0, installRes.stdout + installRes.stderr);
    return { home, cwd, extraEnv };
  }

  // Register `rel` (a command file path relative to ~/.claude/commands) as a
  // copy-mode-managed entry in forge()'s ownership manifest
  // (bin/journey.mjs loadCopiedManifest/saveCopiedManifest). forge() only
  // re-copies a regular file it finds at a symlink's target path if that
  // path is recorded here — otherwise it treats the file as user-owned and
  // skips it with a warning (see journey.mjs:1014-1018). Tests that simulate
  // a "stale copy-mode install" and then expect `doctor --fix` to repair it
  // must mark the file as copied first, or forge()'s repair path is a no-op
  // against it. <!-- Added: forge#1944 CI fix -->
  function markAsCopiedFile(home, rel) {
    const manifestPath = join(home, ".claude", "forgedock", "copied-commands.json");
    mkdirSync(dirname(manifestPath), { recursive: true });
    let manifest = { version: 1, files: {} };
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      } catch {
        // Corrupt/missing — start fresh, matches loadCopiedManifest()'s own fallback.
      }
    }
    manifest.files = manifest.files || {};
    manifest.files[rel] = true;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  }

  it("repairs a stale copy-mode command file (Check 1) and is idempotent", () => {
    const { home, cwd, extraEnv } = setupInstall();
    const targetDir = join(home, ".claude", "commands");
    const targetPath = join(targetDir, "work-on.md");
    const files = readFileSync(targetPath, "utf-8");
    // Corrupt the installed copy so it no longer matches the source — this is
    // the "stale copy" branch of Check 1's copy-mode detection. On platforms
    // where install --fast created a real symlink (Linux/macOS CI, or Windows
    // with Developer Mode), writing straight to the target path follows the
    // symlink and mutates the SOURCE file instead, leaving content identical
    // and defeating the test. Unlink first so the target is guaranteed to be
    // a plain regular file with genuinely divergent content, regardless of
    // install mode. <!-- Added: forge#1944 CI fix -->
    unlinkSync(targetPath);
    writeFileSync(targetPath, files + "\nstale local edit\n", "utf-8");
    // Mark it as copy-managed so forge()'s repair path (invoked by
    // `doctor --fix`) recognizes this regular file as ours to re-copy,
    // instead of skipping it as a foreign user file.
    markAsCopiedFile(home, "work-on.md");

    const before = runCli(["doctor"], { cwd, home, extraEnv });
    assert.equal(before.status, 1, before.stdout + before.stderr);
    assert.match(before.stdout, /Command files/i);
    assert.doesNotMatch(before.stdout, /auto-fixed/i);
    assert.match(before.stdout, /doctor --fix/);

    const fixRes = runCli(["doctor", "--fix"], { cwd, home, extraEnv });
    assert.equal(fixRes.status, 0, fixRes.stdout + fixRes.stderr);
    assert.match(fixRes.stdout, /Command files/i);
    assert.match(fixRes.stdout, /issue\(s\) auto-fixed/i);

    // Second consecutive --fix run reports no further fixes (idempotent).
    const secondFix = runCli(["doctor", "--fix"], { cwd, home, extraEnv });
    assert.equal(secondFix.status, 0, secondFix.stdout + secondFix.stderr);
    assert.doesNotMatch(secondFix.stdout, /issue\(s\) auto-fixed/i);
  });

  // Checks 1, 5, and 5c all funnel repair through the shared
  // runInstallRepairOnce()/installRepairRan memoization. Before forge#1975,
  // the fixed()-vs-pass() decision for each check read that SHARED flag
  // instead of tracking its own pre-repair broken state — so when Check 1
  // was broken and triggered repair, Checks 5 and 5c (already healthy,
  // never broken themselves) would also report "repaired" and inflate the
  // fixesApplied counter from 1 to 3. This test corrupts ONLY Check 1's
  // state — a fresh install leaves the SessionStart hook (Check 5) and its
  // script path (Check 5c) healthy — and asserts the counter reports
  // exactly 1 fix, not 3.
  it("does not inflate fixesApplied for healthy sibling checks when only one check is broken (forge#1975)", () => {
    const { home, cwd, extraEnv } = setupInstall();
    const targetDir = join(home, ".claude", "commands");
    const targetPath = join(targetDir, "work-on.md");
    const files = readFileSync(targetPath, "utf-8");
    unlinkSync(targetPath);
    writeFileSync(targetPath, files + "\nstale local edit\n", "utf-8");
    markAsCopiedFile(home, "work-on.md");

    const before = runCli(["doctor"], { cwd, home, extraEnv });
    assert.equal(before.status, 1, before.stdout + before.stderr);
    assert.match(before.stdout, /Command files/i);

    const fixRes = runCli(["doctor", "--fix"], { cwd, home, extraEnv });
    assert.equal(fixRes.status, 0, fixRes.stdout + fixRes.stderr);
    assert.match(fixRes.stdout, /Command files/i);
    // Exactly one check was actually broken and repaired — the counter must
    // report 1, not 3 (Checks 5/5c riding along on the shared repair flag).
    assert.match(fixRes.stdout, /\b1 issue\(s\) auto-fixed\b/i);
    assert.doesNotMatch(fixRes.stdout, /\b[23] issue\(s\) auto-fixed\b/i);
    // SessionStart hook / script path checks were healthy the whole time —
    // they must report as a plain pass, never as "(repaired)".
    assert.doesNotMatch(fixRes.stdout, /SessionStart hook\b.*\(repaired\)/i);
    assert.doesNotMatch(fixRes.stdout, /SessionStart hook script path\b.*\(repaired\)/i);
  });

  it("re-registers a completely missing SessionStart hook (Check 5)", () => {
    const { home, cwd, extraEnv } = setupInstall();
    const settingsPath = join(home, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    // Simulate the hook entry having been wiped out entirely (not merely
    // pointing at a dangling path — that's Check 5c's scenario).
    settings.hooks.SessionStart = [];
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

    const before = runCli(["doctor"], { cwd, home, extraEnv });
    assert.equal(before.status, 1, before.stdout + before.stderr);
    assert.match(before.stdout, /SessionStart hook\b/);

    const fixRes = runCli(["doctor", "--fix"], { cwd, home, extraEnv });
    assert.equal(fixRes.status, 0, fixRes.stdout + fixRes.stderr);
    assert.match(fixRes.stdout, /SessionStart hook\b/);
    assert.match(fixRes.stdout, /issue\(s\) auto-fixed/i);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.ok(
      after.hooks.SessionStart.some((e) =>
        e.hooks.some((h) => typeof h.command === "string" && h.command.includes("session-start.mjs")),
      ),
      "hook entry must be re-registered",
    );
  });

  it("removes a legacy CLAUDE.md managed block (Check 6)", () => {
    const { home, cwd, extraEnv } = setupInstall();
    writeFileSync(
      join(cwd, "CLAUDE.md"),
      "# Notes\n\n<!-- BEGIN FORGEDOCK -->\nSome legacy injected content.\n<!-- END FORGEDOCK -->\n\nUser content below.\n",
      "utf-8",
    );

    const before = runCli(["doctor"], { cwd, home, extraEnv });
    assert.equal(before.status, 0, before.stdout + before.stderr);
    assert.match(before.stdout, /CLAUDE\.md legacy block/i);
    assert.match(before.stdout, /legacy ForgeDock block found/i);

    const fixRes = runCli(["doctor", "--fix"], { cwd, home, extraEnv });
    assert.equal(fixRes.status, 0, fixRes.stdout + fixRes.stderr);
    assert.match(fixRes.stdout, /CLAUDE\.md legacy block/i);
    assert.match(fixRes.stdout, /issue\(s\) auto-fixed/i);

    const content = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
    assert.doesNotMatch(content, /BEGIN FORGEDOCK/);
    assert.match(content, /User content below\./);

    const secondFix = runCli(["doctor", "--fix"], { cwd, home, extraEnv });
    assert.equal(secondFix.status, 0, secondFix.stdout + secondFix.stderr);
    assert.doesNotMatch(secondFix.stdout, /issue\(s\) auto-fixed/i);
  });

  // Stub `gh` so it also answers Check 7's two subcommands (`label list` /
  // `label create`), on top of the `--version`/`auth status` calls the plain
  // stubTools() above already covers. State is tracked via a marker file
  // written by the `label create` branch: before it exists, `label list`
  // reports the workflow:* labels as absent (simulating a repo that has
  // never had ForgeDock labels bootstrapped); once labelsSetup() has called
  // `label create` for every label in bin/labels.json (forge#1944), `label
  // list` reports them all present — mirroring gh's real idempotent
  // create --force semantics closely enough for Check 7's detect/fix/recheck
  // logic, without any network access or a real GitHub repo.
  //
  // POSIX-only: forgedock.mjs calls execFileSync("gh", [...]) (no shell) for
  // label list/create. execFileSync without `shell: true` can only launch a
  // real executable — on POSIX that includes an extensionless script with a
  // `#!/bin/sh` shebang (the kernel itself handles it), so a plain shell
  // stub placed first on PATH is sufficient and deterministic. On Windows,
  // execFileSync without a shell cannot invoke a .cmd/.bat launcher at all
  // (Windows' CreateProcess only recognizes real PE binaries for a bare,
  // non-shell spawn — confirmed empirically: spawnSync("gh.cmd", ...) with
  // shell:false fails with EINVAL even given the file's exact name), so
  // there is no reliable way to fake `gh` for execFileSync callers on
  // Windows without shipping a compiled binary. This test therefore only
  // runs on POSIX platforms, which matches the project's CI (ubuntu-latest
  // — see .github/workflows/ci.yml) and is where the real coverage lives.
  function stubToolsWithLabels() {
    const stubBin = mkdtempSync(join(os.tmpdir(), "fd-doctor-fix-label-stub-bin-"));
    const present = [
      "workflow:investigating",
      "workflow:ready-to-build",
      "workflow:building",
      "workflow:in-review",
      "workflow:awaiting-merge",
      "workflow:merged",
      "workflow:decomposed",
      "workflow:invalid",
    ].map((name) => ({ name }));

    const ghStubPath = join(stubBin, "gh-stub.js");
    writeFileSync(
      ghStubPath,
      [
        'const fs = require("fs");',
        'const path = require("path");',
        'const marker = path.join(__dirname, ".labels-created");',
        'const args = process.argv.slice(2);',
        `const present = ${JSON.stringify(JSON.stringify(present))};`,
        'if (args[0] === "label" && args[1] === "list") {',
        '  console.log(fs.existsSync(marker) ? present : "[]");',
        "  process.exit(0);",
        "}",
        'if (args[0] === "label" && args[1] === "create") {',
        '  fs.writeFileSync(marker, "");',
        "  process.exit(0);",
        "}",
        'if (args[0] === "auth" && args[1] === "status") process.exit(0);',
        'console.log("gh version 2.60.0");',
      ].join("\n") + "\n",
      "utf-8",
    );
    writeFileSync(
      join(stubBin, "gh"),
      `#!/bin/sh\nexec node "${ghStubPath}" "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(stubBin, "yq"),
      "#!/bin/sh\necho 'yq (https://github.com/mikefarah/yq/) version v4.44.0'\n",
      { mode: 0o755 },
    );

    return { PATH: `${stubBin}:${process.env.PATH}` };
  }

  // See the POSIX-only note above stubToolsWithLabels() — execFileSync
  // cannot deterministically invoke a stub `gh` on Windows without a shell,
  // so this test is skipped there. CI (ubuntu-latest) provides real coverage.
  const itPosix = process.platform === "win32" ? it.skip : it;

  itPosix("bootstraps missing GitHub workflow labels (Check 7) and is idempotent", () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-doctor-fix-home-"));
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-doctor-fix-cwd-"));
    writeFileSync(
      join(home, ".gitconfig"),
      "[user]\n\tname = Test User\n\temail = test@example.com\n",
      "utf-8",
    );
    const extraEnv = stubToolsWithLabels();
    const installRes = runCli(["install", "--fast"], { cwd, home, extraEnv });
    assert.equal(installRes.status, 0, installRes.stdout + installRes.stderr);

    // A real (non-placeholder) owner/repo so Check 4 resolves forgeOwner/
    // forgeRepo and Check 7 actually runs instead of reporting "Skipped".
    writeFileSync(
      join(cwd, "forge.yaml"),
      [
        "project:",
        '  name: "Real Project"',
        '  owner: "real-org"',
        '  repo: "real-repo"',
        "paths:",
        '  root: "/tmp/x"',
        "branches:",
        '  default: "main"',
        '  staging: "staging"',
        "",
      ].join("\n"),
      "utf-8",
    );

    const before = runCli(["doctor"], { cwd, home, extraEnv });
    assert.equal(before.status, 1, before.stdout + before.stderr);
    assert.match(before.stdout, /GitHub workflow labels/i);
    assert.doesNotMatch(before.stdout, /issue\(s\) auto-fixed/i);

    const fixRes = runCli(["doctor", "--fix"], { cwd, home, extraEnv });
    assert.equal(fixRes.status, 0, fixRes.stdout + fixRes.stderr);
    assert.match(fixRes.stdout, /GitHub workflow labels/i);
    assert.match(fixRes.stdout, /issue\(s\) auto-fixed/i);

    // Second consecutive --fix run reports no further fixes (idempotent) —
    // the stub's marker file now makes `label list` report all workflow:*
    // labels already present.
    const secondFix = runCli(["doctor", "--fix"], { cwd, home, extraEnv });
    assert.equal(secondFix.status, 0, secondFix.stdout + secondFix.stderr);
    assert.doesNotMatch(secondFix.stdout, /issue\(s\) auto-fixed/i);
  });

  it("plain `doctor` (no --fix) is unaffected — never auto-repairs, never prints an auto-fixed summary", () => {
    const { home, cwd, extraEnv } = setupInstall();
    const targetDir = join(home, ".claude", "commands");
    const targetPath = join(targetDir, "work-on.md");
    const original = readFileSync(targetPath, "utf-8");
    // See the identical unlink-before-write note in the Check 1 test above —
    // writing straight to a symlinked target would silently corrupt the
    // source file instead of the copy on symlink-capable platforms.
    unlinkSync(targetPath);
    writeFileSync(targetPath, original + "\nstale local edit\n", "utf-8");

    const res1 = runCli(["doctor"], { cwd, home, extraEnv });
    assert.equal(res1.status, 1, res1.stdout + res1.stderr);
    assert.doesNotMatch(res1.stdout, /auto-fixed/i);

    // Running plain doctor again must not have repaired anything either.
    const res2 = runCli(["doctor"], { cwd, home, extraEnv });
    assert.equal(res2.status, 1, res2.stdout + res2.stderr);
    assert.equal(
      readFileSync(join(targetDir, "work-on.md"), "utf-8"),
      original + "\nstale local edit\n",
      "plain doctor must never modify the install",
    );
  });
});

describe("status — re-entry mini-dashboard (#1945)", () => {
  /** Same install + forge.yaml overwrite pattern as the doctor placeholder suite above. */
  function setupConfigured(forgeYamlContent, { gh } = {}) {
    const home = mkdtempSync(join(os.tmpdir(), "fd-dash-home-"));
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-dash-cwd-"));
    writeFileSync(
      join(home, ".gitconfig"),
      "[user]\n\tname = Test User\n\temail = test@example.com\n",
      "utf-8",
    );
    const stubBin = mkdtempSync(join(os.tmpdir(), "fd-dash-stub-bin-"));
    writeFileSync(join(stubBin, "gh"), gh ?? "#!/bin/sh\necho 'gh version 2.60.0'\n", { mode: 0o755 });
    writeFileSync(join(stubBin, "yq"), "#!/bin/sh\necho 'yq (https://github.com/mikefarah/yq/) version v4.44.0'\n", { mode: 0o755 });
    const extraEnv = { PATH: `${stubBin}:${process.env.PATH}` };
    const installRes = runCli(["install", "--fast"], { cwd, home, extraEnv });
    assert.equal(installRes.status, 0, installRes.stdout + installRes.stderr);
    writeFileSync(join(cwd, "forge.yaml"), forgeYamlContent, "utf-8");
    return { home, cwd, extraEnv };
  }

  // Deliberately a repo slug that cannot exist on GitHub — this test asserts
  // graceful degradation of the dashboard, not any specific gh response, so it
  // must hold whether the process-level PATH override below actually reaches
  // a stub binary or falls through to a real `gh` on the host (the exact
  // classification/counting logic is unit-tested in isolation, with an
  // injectable `io.gh`, in bin/tests/engine-cli.test.mjs — this test only
  // needs to prove statusScreen() never crashes and always renders all rows).
  const FORGE_YAML = [
    "project:",
    '  name: "Real Project"',
    '  owner: "forgedock-test-nonexistent-org-zzz"',
    '  repo: "forgedock-test-nonexistent-repo-zzz"',
    "paths:",
    '  root: "/tmp/x"',
    "branches:",
    '  default: "main"',
    '  staging: "staging"',
    "",
  ].join("\n");

  it("degrades gracefully to unknown/none for an unreachable repo (no crash)", () => {
    const { home, cwd, extraEnv } = setupConfigured(FORGE_YAML);

    const res = runCli(["status"], { cwd, home, extraEnv });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /staging PRs\s+(unknown|\d+ open)/i);
    assert.match(res.stdout, /bot token\s+not available/i);
    // engine/last-run rows must render some value, not throw past statusScreen.
    assert.match(res.stdout, /engine\s+(unknown|none in-flight|\d+ in-flight)/i);
    assert.match(res.stdout, /last run\s+(none|#\d+)/i);
  });

  it("does not render dashboard rows for an unconfigured directory (no forge.yaml)", () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-dash-unconf-home-"));
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-dash-unconf-cwd-"));
    const res = runCli(["status"], { cwd, home });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /staging PRs/i);
    assert.doesNotMatch(res.stdout, /bot token/i);
  });
});
