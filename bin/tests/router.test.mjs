/**
 * bin/tests/router.test.mjs — CLI-level tests for bin/forgedock.mjs routing.
 * Run with: node --test bin/tests/router.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, cpSync } from "node:fs";
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

  it("update in a forgeHome without .git prints the npm-update hint, relinks via forge, and exits 0", () => {
    // FORGE_HOME is derived from the CLI file's location — to exercise the
    // "installed via npm" branch (no .git), copy bin/ into a temp forgeHome
    // and spawn the copy. update() checks for .git before touching anything
    // else. forge() now runs as the repair path even here, so give it a
    // commands/ directory to link.
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
    assert.match(res.stdout, /npm update -g forgedock/);
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
