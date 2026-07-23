/**
 * bin/tests/router.test.mjs — CLI-level tests for bin/forgedock.mjs routing.
 * Run with: node --test bin/tests/router.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, cpSync, unlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  it("backend-check fails configured API mode when its key is absent", () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-backend-check-"));
    const unavailable = runCli(["backend-check", "--quiet"], {
      home,
      extraEnv: { FORGEDOCK_BACKEND: "api", ANTHROPIC_API_KEY: "" },
    });
    assert.equal(unavailable.status, 1, unavailable.stdout + unavailable.stderr);
  });

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

  // -------------------------------------------------------------------------
  // Dirty-tree-guard npm fallback (forge#2460)
  //
  // Before this fix, `update()` unconditionally skipped (no relink, no
  // guidance beyond "commit or stash") whenever the FORGE_HOME git clone had
  // uncommitted tracked changes on a non-main branch — even when that clone
  // IS the ForgeDock source repo the user is actively developing in (cwd
  // nested under FORGE_HOME). The fix distinguishes that case from a
  // genuinely separate, unrelated dirty git-clone install: when cwd is
  // inside FORGE_HOME, it now runs the git-independent relinkAndHint() sync
  // (commands/hooks only — never touches git state) and prints an
  // `npm install -g forgedock@latest` fallback hint, instead of just
  // skipping. HEAD must never move in either case.
  // -------------------------------------------------------------------------
  function makeDirtyNonMainClone(prefix) {
    const forgeHome = mkdtempSync(join(os.tmpdir(), prefix));
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "ForgeDock Test",
      GIT_AUTHOR_EMAIL: "test@forgedock.test",
      GIT_COMMITTER_NAME: "ForgeDock Test",
      GIT_COMMITTER_EMAIL: "test@forgedock.test",
    };
    cpSync(dirname(CLI), join(forgeHome, "bin"), {
      recursive: true,
      filter: (src) => !src.includes("tests"),
    });
    mkdirSync(join(forgeHome, "commands"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "one.md"), "# /one\n\nTest command\n", "utf-8");

    spawnSync("git", ["init", "-b", "main", forgeHome], { stdio: "pipe" });
    spawnSync("git", ["-C", forgeHome, "add", "-A"], { stdio: "pipe", env: gitEnv });
    spawnSync("git", ["-C", forgeHome, "commit", "-m", "init"], { stdio: "pipe", env: gitEnv });
    spawnSync("git", ["-C", forgeHome, "checkout", "-b", "feature/dirty-test"], { stdio: "pipe", env: gitEnv });
    // Dirty a TRACKED file (untracked files are deliberately excluded by the
    // guard's `--untracked-files=no` scan, so this must modify a tracked one).
    writeFileSync(join(forgeHome, "commands", "one.md"), "# /one\n\nEdited, uncommitted.\n", "utf-8");

    const branch = spawnSync("git", ["-C", forgeHome, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
    }).stdout.trim();
    const headBefore = spawnSync("git", ["-C", forgeHome, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).stdout.trim();

    return { forgeHome, branch, headBefore };
  }

  it("update on a dirty, non-main branch run from INSIDE the source repo itself relinks commands/hooks and prints the npm fallback hint, HEAD unmoved (forge#2460)", () => {
    const { forgeHome, branch, headBefore } = makeDirtyNonMainClone("fd-selfrepo-");
    const home = mkdtempSync(join(os.tmpdir(), "fd-selfrepo-home-"));

    const res = spawnSync(process.execPath, [join(forgeHome, "bin", "forgedock.mjs"), "update"], {
      cwd: forgeHome, // cwd IS FORGE_HOME — the npx-shadowing self-checkout case
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
      encoding: "utf-8",
      timeout: 30000,
    });

    assert.equal(res.status, 0, `update exited non-zero:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /source repo itself/i);
    assert.match(res.stdout, /npm install -g forgedock@latest/);
    assert.doesNotMatch(res.stdout, /Commit or stash your changes before updating/);

    // relinkAndHint() ran → commands/one.md must have been synced onto disk.
    assert.ok(
      existsSync(join(home, ".claude", "commands", "one.md")),
      "relinkAndHint() should have synced commands/hooks from the dirty working tree",
    );

    // HEAD must never move: still on the same non-main branch, same commit.
    const branchAfter = spawnSync("git", ["-C", forgeHome, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
    }).stdout.trim();
    const headAfter = spawnSync("git", ["-C", forgeHome, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).stdout.trim();
    assert.equal(branchAfter, branch, "must not switch off the dirty non-main branch");
    assert.equal(headAfter, headBefore, "HEAD must not move");
  });

  it("update on a dirty, non-main branch run from INSIDE the source repo, when relinkAndHint() throws, prints an accurate error instead of the misleading fast-forward message (forge#2493)", () => {
    const { forgeHome, branch, headBefore } = makeDirtyNonMainClone("fd-selfrepo-relinkfail-");
    const home = mkdtempSync(join(os.tmpdir(), "fd-selfrepo-relinkfail-home-"));
    // Force relinkAndHint() to throw: forge() does
    // `await mkdir(join(ctx.home, ".claude", "commands"), { recursive: true })`
    // — pre-creating a REGULAR FILE at `home/.claude` makes that mkdir throw
    // (a path segment exists as a non-directory), which is a real, reachable
    // failure mode (any disk-write error inside forge()/writeInstallReceipt()
    // reaches this same call), not a contrived one.
    writeFileSync(join(home, ".claude"), "not a directory", "utf-8");

    const res = spawnSync(process.execPath, [join(forgeHome, "bin", "forgedock.mjs"), "update"], {
      cwd: forgeHome, // cwd IS FORGE_HOME — the npx-shadowing self-checkout case
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
      encoding: "utf-8",
      timeout: 30000,
    });

    assert.equal(res.status, 0, `update exited non-zero:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /source repo itself/i);
    // The misleading fast-forward message must NEVER appear here — no
    // fast-forward/merge was ever attempted in this path (forge#2493).
    assert.doesNotMatch(res.stdout, /Cannot fast-forward/);
    // An accurate, relink-specific error must be printed instead.
    assert.match(res.stdout, /Could not sync commands\/hooks from the working tree/i);
    // The npm-fallback hint must still print even though relink failed.
    assert.match(res.stdout, /npm install -g forgedock@latest/);

    // HEAD must never move, even on the failure path.
    const branchAfter = spawnSync("git", ["-C", forgeHome, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
    }).stdout.trim();
    const headAfter = spawnSync("git", ["-C", forgeHome, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).stdout.trim();
    assert.equal(branchAfter, branch, "must not switch off the dirty non-main branch");
    assert.equal(headAfter, headBefore, "HEAD must not move");
  });

  it("update on a dirty, non-main branch run from OUTSIDE the source repo (separate cwd) keeps the original commit/stash guidance — no npm fallback, no relink (forge#2460)", () => {
    const { forgeHome, branch, headBefore } = makeDirtyNonMainClone("fd-elsewhere-");
    const home = mkdtempSync(join(os.tmpdir(), "fd-elsewhere-home-"));
    const outsideCwd = mkdtempSync(join(os.tmpdir(), "fd-elsewhere-cwd-"));

    const res = spawnSync(process.execPath, [join(forgeHome, "bin", "forgedock.mjs"), "update"], {
      cwd: outsideCwd, // cwd is NOT inside FORGE_HOME
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
      encoding: "utf-8",
      timeout: 30000,
    });

    assert.equal(res.status, 0, `update exited non-zero:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /Commit or stash your changes before updating/);
    assert.doesNotMatch(res.stdout, /source repo itself/i);
    assert.doesNotMatch(res.stdout, /npm install -g forgedock@latest/);

    // relinkAndHint() must NOT have run — nothing installed into home.
    assert.ok(
      !existsSync(join(home, ".claude", "commands", "one.md")),
      "relinkAndHint() must not run for a dirty clone unrelated to the invoking cwd",
    );

    const branchAfter = spawnSync("git", ["-C", forgeHome, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
    }).stdout.trim();
    const headAfter = spawnSync("git", ["-C", forgeHome, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).stdout.trim();
    assert.equal(branchAfter, branch, "must not switch off the dirty non-main branch");
    assert.equal(headAfter, headBefore, "HEAD must not move");
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

describe("orchestrate engine fallback guards", () => {
  const specPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "commands",
    "orchestrate",
    "phase-4-execution.md",
  );

  it("uses the tested backend-check command instead of an inline spawn canary", () => {
    const spec = readFileSync(specPath, "utf-8");
    assert.match(spec, /forgedock backend-check --quiet/);
    assert.doesNotMatch(spec, /spawnSync\('claude', \['--version'\]/);
  });

  it("requires committed state to be an empty array before fallback", () => {
    const spec = readFileSync(specPath, "utf-8");
    assert.match(spec, /\.run \| type == "string" and test\(/);
    assert.match(spec, /A-Za-z0-9\._:\/-/);
    assert.match(spec, /\.v \| type == "number"/);
    assert.match(spec, /\.committed \| type == "array"/);
    assert.match(spec, /\.committed \| length == 0/);
    assert.match(spec, /CLAIM_SCOPE="\$\{STATE_RUN\}:\$\{STATE_VERSION\}"/);
    assert.doesNotMatch(spec, /CLAIM_SCOPE="\$\{BATCH_ID/);
  });

  it("posts a fallback claim before paginated lowest-comment-id election", () => {
    const spec = readFileSync(specPath, "utf-8");
    const claimPost = spec.indexOf("CLAIM_ID=$(gh api");
    const claimList = spec.indexOf("CLAIM_IDS=$(gh api");
    assert.ok(claimPost >= 0 && claimList > claimPost, "claim must be posted before election");
    assert.match(spec.slice(claimList, claimList + 500), /--paginate/);
    assert.match(
      spec.slice(claimList, claimList + 500),
      /any\(\. == \\"<!-- FORGE:ENGINE_FALLBACK -->\\"\)/,
    );
    assert.match(spec.slice(claimList, claimList + 500), /split\(.*any\(\. ==/);
    assert.match(spec, /sort -n \| head -1/);
    assert.doesNotMatch(spec, /ALREADY_FALLEN_BACK=/);
  });
});

describe("version command / --version, -v flags (#1981)", () => {
  it("`version` prints the local version and exits 0", () => {
    const res = runCli(["version"], { home: mkdtempSync(join(os.tmpdir(), "fd-ver-")) });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /forgedock v\d+\.\d+\.\d+/);
  });

  it("`--version` behaves identically to `version`", () => {
    const res = runCli(["--version"], { home: mkdtempSync(join(os.tmpdir(), "fd-ver-flag-")) });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /forgedock v\d+\.\d+\.\d+/);
  });

  it("`-v` behaves identically to `version`", () => {
    const res = runCli(["-v"], { home: mkdtempSync(join(os.tmpdir(), "fd-ver-short-")) });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /forgedock v\d+\.\d+\.\d+/);
  });

  it("does not double-print the branded splash logo before the version line", () => {
    // version/--version/-v are deliberately excluded from SPLASH_COMMANDS —
    // splash() renders to stderr, so stdout must contain only the version
    // output, not a duplicated logo block.
    const res = runCli(["version"], { home: mkdtempSync(join(os.tmpdir(), "fd-ver-nosplash-")) });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const versionLines = res.stdout.split("\n").filter((l) => /forgedock v/.test(l));
    assert.equal(versionLines.length, 1, res.stdout);
  });

  it("help lists the version command and flag", () => {
    const res = runCli(["help"], { home: mkdtempSync(join(os.tmpdir(), "fd-ver-help-")) });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /npx forgedock version/);
    assert.match(res.stdout, /--version/);
  });

  it("does not hang or crash when the npm registry is unreachable (offline-safe)", () => {
    // No network stub is injectable for fetchLatestVersion() (it hits the
    // real registry directly by design — see bin/forgedock.mjs comment on
    // fetchLatestVersion), so this exercises the real best-effort path: the
    // command must still print the local version and exit 0 within the
    // process timeout, proving the 5s internal timeout on the latest-version
    // check never blocks the primary output.
    const res = runCli(["version"], { home: mkdtempSync(join(os.tmpdir(), "fd-ver-net-"))});
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });

  // forge#2719 — package-vs-installed-commands drift advisory.
  it("warns when installed commands (~/.forge/version) are older than the package", () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-ver-drift-stale-"));
    mkdirSync(join(home, ".forge"), { recursive: true });
    writeFileSync(join(home, ".forge", "version"), "0.0.1");
    const res = runCli(["version"], { home });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Installed commands are stale \(v0\.0\.1\) vs package v\d+\.\d+\.\d+/);
    assert.match(res.stdout, /npx forgedock update/);
  });

  it("stays silent about drift when installed commands match the package version", () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-ver-drift-equal-"));
    // Read this checkout's own package.json version so the persisted version
    // exactly matches the source version under test.
    const pkgVersion = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf-8"),
    ).version;
    mkdirSync(join(home, ".forge"), { recursive: true });
    writeFileSync(join(home, ".forge", "version"), pkgVersion);
    const res = runCli(["version"], { home });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /Installed commands are stale/);
  });

  it("stays silent about drift when ~/.forge/version is missing (degrades to unknown, no throw)", () => {
    // No ~/.forge directory created at all — persisted state is absent.
    const home = mkdtempSync(join(os.tmpdir(), "fd-ver-drift-missing-"));
    const res = runCli(["version"], { home });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /Installed commands are stale/);
  });
});

describe("getInstalledCommandsDriftStatus() — package-vs-installed-commands helper (forge#2719)", () => {
  // pathToFileURL(...).href is required, not a raw path — dynamic import()
  // rejects Windows backslash paths with ERR_UNSUPPORTED_ESM_URL_SCHEME
  // (same pattern bin/hooks/session-start.mjs already uses for its own
  // dynamic imports of this file).
  const REGISTRY_MJS = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "registry.mjs")).href;

  // registry.mjs computes its module-scope HOME constant once, at import
  // time — so process.env.HOME must be set *before* the dynamic import, and
  // each test needs its own fresh module instance (registry.mjs's internal
  // HOME would otherwise stay pinned to whichever HOME was in effect on the
  // very first import, since Node caches ESM modules by specifier). A
  // cache-busting query string forces a fresh module instance per test.
  let importSeq = 0;
  async function withHome(home, fn) {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const { getInstalledCommandsDriftStatus } = await import(`${REGISTRY_MJS}?t=${Date.now()}-${importSeq++}`);
      return fn(getInstalledCommandsDriftStatus);
    } finally {
      process.env.HOME = prevHome;
      process.env.USERPROFILE = prevProfile;
    }
  }

  it("reports isStale=true when the persisted version is older than the source version", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-drift-older-"));
    const pkgDir = mkdtempSync(join(os.tmpdir(), "fd-drift-older-pkg-"));
    mkdirSync(join(home, ".forge"), { recursive: true });
    writeFileSync(join(home, ".forge", "version"), "1.0.0");
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "2.0.0" }));
    const result = await withHome(home, (fn) => fn(pkgDir));
    assert.deepEqual(result, {
      persistedVersion: "1.0.0",
      sourceVersion: "2.0.0",
      isStale: true,
      unknown: false,
    });
  });

  it("reports isStale=false when the persisted version equals the source version", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-drift-equal-"));
    const pkgDir = mkdtempSync(join(os.tmpdir(), "fd-drift-equal-pkg-"));
    mkdirSync(join(home, ".forge"), { recursive: true });
    writeFileSync(join(home, ".forge", "version"), "3.1.4");
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "3.1.4" }));
    const result = await withHome(home, (fn) => fn(pkgDir));
    assert.equal(result.isStale, false);
    assert.equal(result.unknown, false);
  });

  it("reports isStale=false when the persisted version is newer than the source version", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-drift-newer-"));
    const pkgDir = mkdtempSync(join(os.tmpdir(), "fd-drift-newer-pkg-"));
    mkdirSync(join(home, ".forge"), { recursive: true });
    writeFileSync(join(home, ".forge", "version"), "9.9.9");
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    const result = await withHome(home, (fn) => fn(pkgDir));
    assert.equal(result.isStale, false);
    assert.equal(result.unknown, false);
  });

  it("degrades to unknown=true, never throws, when ~/.forge/version is missing", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-drift-unknown-home-"));
    const pkgDir = mkdtempSync(join(os.tmpdir(), "fd-drift-unknown-pkg-"));
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    const result = await withHome(home, (fn) => fn(pkgDir));
    assert.equal(result.unknown, true);
    assert.equal(result.isStale, false);
  });

  it("degrades to unknown=true, never throws, when package.json is missing/unreadable", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-drift-unknown-pkg-home-"));
    const pkgDir = mkdtempSync(join(os.tmpdir(), "fd-drift-unknown-pkg-missing-"));
    mkdirSync(join(home, ".forge"), { recursive: true });
    writeFileSync(join(home, ".forge", "version"), "1.0.0");
    // No package.json written in pkgDir at all.
    const result = await withHome(home, (fn) => fn(pkgDir));
    assert.equal(result.unknown, true);
  });

  for (const [label, version] of [
    ["missing", undefined],
    ["empty", ""],
    ["whitespace-only", "   "],
    ["non-string", 123],
  ]) {
    it(`degrades to unknown=true when package.json version is ${label}`, async () => {
      const home = mkdtempSync(join(os.tmpdir(), `fd-drift-${label}-home-`));
      const pkgDir = mkdtempSync(join(os.tmpdir(), `fd-drift-${label}-pkg-`));
      mkdirSync(join(home, ".forge"), { recursive: true });
      writeFileSync(join(home, ".forge", "version"), "1.0.0");
      const pkg = version === undefined ? {} : { version };
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkg));
      const result = await withHome(home, (fn) => fn(pkgDir));
      assert.deepEqual(result, {
        persistedVersion: "",
        sourceVersion: "",
        isStale: false,
        unknown: true,
      });
    });
  }
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
      // forge#2261: bin/labels.json gained a new "workflow:"-prefixed label
      // (workflow:engine-error). Check 7 filters expectedLabels by
      // `startsWith("workflow:")`, so this stub's "already present" set must
      // stay in sync with every workflow:* label in bin/labels.json — this
      // list existing exactly to mirror that filter, not the full manifest.
      "workflow:engine-error",
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

// ---------------------------------------------------------------------------
// update() global npm install self-update (forge#2133)
//
// Regression covered: `npx forgedock update` on a machine with a global npm
// install previously only printed an advisory ("New version available...
// run npx forgedock@latest") and never actually upgraded anything — the
// stale binary kept re-persisting itself into ~/.forge/ forever. This
// exercises the fixed path: detect a global npm install (via `npm root -g`),
// run `npm install -g forgedock@latest`, then re-exec the freshly-installed
// binary to complete persist/relink.
//
// Stub relies on a POSIX shebang (`#!/bin/sh`) — CI runs ubuntu-only (see
// .github/workflows/ci.yml), matching the existing shim precedent in this
// file and in bin/tests/runner.test.mjs. Skipped on other platforms rather
// than failed.
//
// Windows note (forge#2169): a `.cmd`-based cross-platform npm stub is NOT a
// viable alternative here — this was investigated and empirically ruled out,
// not merely assumed. `selfUpdateGlobalInstall()` in bin/forgedock.mjs calls
// `execFileSync("npm", [...])` with no `shell: true`, and on Windows that
// call cannot resolve ANY `.cmd`-based npm — real or stubbed:
//   execFileSync("npm", ["--version"])       [real npm.cmd already on PATH] → ENOENT
//   execFileSync("npm.cmd", ["--version"])   [exact filename, real npm.cmd] → EINVAL
// This exactly matches — and extends — the identical `gh`-stub finding
// documented for the doctor Check 7 test (see commit 4061853, "fix(tests):
// scope Check 7 gh-stub test to POSIX platforms (#1964)"): execFileSync
// without a shell cannot invoke a .cmd/.bat launcher on Windows at all.
// Shipping a `.cmd` shim for these tests would therefore never even be
// reached by the code under test, so it would not restore real coverage —
// it would only mask that `execFileSync("npm", ...)` itself cannot resolve
// npm on Windows regardless of shim vs. real install. (That resolution
// failure is a separate, more significant latent issue tracked outside this
// low-severity test-coverage gap — see the issue thread for the follow-up.)
// These two tests therefore remain intentionally POSIX-only; CI (ubuntu-only)
// is where the real coverage lives.
// ---------------------------------------------------------------------------

describe("update — global npm install self-update (forge#2133)", () => {
  it("detects a global install, runs `npm install -g`, and re-execs to finish persist/relink from the new payload", (t) => {
    // See the Windows note in the file-level comment above this describe
    // block (forge#2169) — a Windows shim is not viable for this exact
    // execFileSync("npm", ...) call, confirmed empirically.
    if (process.platform === "win32") {
      t.skip("execFileSync(\"npm\", ...) cannot resolve a .cmd-based npm on Windows (forge#2169)");
      return;
    }

    const shimDir = mkdtempSync(join(os.tmpdir(), "fd-npm-shim-"));
    const globalRoot = join(shimDir, "global-root");
    const forgeHome = join(globalRoot, "forgedock");
    const installLog = join(shimDir, "install-log.txt");

    try {
      // Build a fake global-install layout: {globalRoot}/forgedock is what
      // `npm root -g` + isGlobalNpmInstall()'s `{root}/forgedock` join must
      // resolve to.
      mkdirSync(join(forgeHome, "bin"), { recursive: true });
      cpSync(dirname(CLI), join(forgeHome, "bin"), {
        recursive: true,
        filter: (src) => !src.includes("tests"),
      });
      mkdirSync(join(forgeHome, "commands"), { recursive: true });
      writeFileSync(join(forgeHome, "commands", "one.md"), "# /one\n\nTest command\n", "utf-8");
      // Deliberately stale — guaranteed older than whatever the real npm
      // registry's current "latest" is, so the self-update branch triggers
      // without needing a fetchLatestVersion() stub (none is injectable —
      // same constraint documented on the "does not hang..." version test
      // above).
      writeFileSync(join(forgeHome, "package.json"), JSON.stringify({ name: "forgedock", version: "0.0.1" }), "utf-8");

      // Fake `npm`: responds to `npm root -g` with our fake global root, and
      // to `npm install -g forgedock@X` by bumping the target package.json's
      // version to X — simulating what a real `npm install -g` would leave
      // on disk (the same install path, now containing the new version) —
      // and logging the exact argv it received for the assertion below.
      const npmShimPath = join(shimDir, "npm");
      writeFileSync(
        npmShimPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "root" ] && [ "$2" = "-g" ]; then',
          `  printf '%s\\n' "${globalRoot.replace(/\\/g, "/")}"`,
          "  exit 0",
          "fi",
          'if [ "$1" = "install" ] && [ "$2" = "-g" ]; then',
          `  printf '%s\\n' "$3" >> "${installLog.replace(/\\/g, "/")}"`,
          '  VER=$(printf \'%s\' "$3" | sed \'s/^forgedock@//\')',
          `  NPM_SHIM_NEW_VERSION="$VER" node -e "const fs=require('fs');const p='${join(forgeHome, "package.json").replace(/\\/g, "/")}';const pkg=JSON.parse(fs.readFileSync(p,'utf-8'));pkg.version=process.env.NPM_SHIM_NEW_VERSION;fs.writeFileSync(p, JSON.stringify(pkg));"`,
          "  exit 0",
          "fi",
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const home = mkdtempSync(join(os.tmpdir(), "fd-npm-shim-home-"));
      const res = spawnSync(
        process.execPath,
        [join(forgeHome, "bin", "forgedock.mjs"), "update"],
        {
          cwd: mkdtempSync(join(os.tmpdir(), "fd-npm-shim-cwd-")),
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            NO_COLOR: "1",
            PATH: `${shimDir}:${process.env.PATH}`,
          },
          encoding: "utf-8",
          timeout: 30000,
        },
      );

      assert.equal(res.status, 0, `update exited non-zero:\n${res.stdout}\n${res.stderr}`);
      assert.match(res.stdout, /Installing.*forgedock@.*globally/i);
      assert.ok(existsSync(installLog), "the fake npm must have been invoked with `install -g`");
      const loggedArg = readFileSync(installLog, "utf-8").trim();
      assert.match(loggedArg, /^forgedock@\d+\.\d+\.\d+/, "npm install -g must be called with an explicit forgedock@<version> argv, not a bare 'npm update'");

      // After re-exec, the local package.json must no longer read "0.0.1" —
      // the fake npm bumped it to the real registry's latest version.
      const finalPkg = JSON.parse(readFileSync(join(forgeHome, "package.json"), "utf-8"));
      assert.notEqual(finalPkg.version, "0.0.1", "self-update must actually change the installed version, not leave the stale one in place");

      // The re-exec must complete the persist/relink phase from the NEW
      // payload — commands/one.md must be linked into ~/.claude/commands/.
      assert.ok(
        existsSync(join(home, ".claude", "commands", "one.md")),
        "the re-exec'd update must complete relink from the newly-installed payload",
      );
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("falls back to the advisory message (no self-update attempt) when not a global install", () => {
    // Regression guard: the existing npx-cache-path test above (line ~111)
    // already covers this, but assert explicitly here that isGlobalNpmInstall()
    // detection is negative for an ordinary temp-dir forgeHome (not nested
    // under any `npm root -g` result), so the pre-existing advisory-only
    // behavior for genuinely ephemeral installs is unchanged by forge#2133.
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-npm-notglobal-"));
    cpSync(dirname(CLI), join(forgeHome, "bin"), {
      recursive: true,
      filter: (src) => !src.includes("tests"),
    });
    mkdirSync(join(forgeHome, "commands"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "one.md"), "# /one\n\nTest command\n", "utf-8");
    writeFileSync(join(forgeHome, "package.json"), JSON.stringify({ name: "forgedock", version: "0.0.1" }), "utf-8");

    const home = mkdtempSync(join(os.tmpdir(), "fd-npm-notglobal-home-"));
    const res = spawnSync(process.execPath, [join(forgeHome, "bin", "forgedock.mjs"), "update"], {
      cwd: mkdtempSync(join(os.tmpdir(), "fd-npm-notglobal-cwd-")),
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
      encoding: "utf-8",
      timeout: 30000,
    });

    assert.equal(res.status, 0, res.stdout + res.stderr);
    // Either the registry lookup succeeded and printed the advisory (most
    // likely, since 0.0.1 is guaranteed stale), or network was unavailable —
    // both are correct outcomes; the decisive assertion is what must NOT
    // happen: no self-update attempt.
    assert.doesNotMatch(res.stdout, /Installing.*forgedock@.*globally/i);
  });

  // -------------------------------------------------------------------------
  // selfUpdateGlobalInstall() re-exec depth guard (forge#2158)
  //
  // Regression covered: if `npm install -g` reports success but the resolved
  // version never actually advances (stale registry mirror/proxy, cache
  // issue), the pre-fix code re-exec'd `update` unconditionally with no
  // attempt counter — recursing indefinitely, each cycle blocking up to
  // ~125s. This exercises the fixed path with a shim that deliberately never
  // bumps the on-disk version, so `update()` sees "newer version available"
  // on every attempt: the guard must cap re-exec at MAX_SELF_UPDATE_ATTEMPTS
  // (1 retry, i.e. 2 total install attempts) and print an actionable message
  // instead of looping forever.
  //
  // Windows note (forge#2169): skipped for the same reason as the forge#2133
  // test above (see the file-level comment above the enclosing describe
  // block) — execFileSync("npm", ...) cannot resolve any .cmd-based npm on
  // Windows, real or stubbed, so a Windows shim would not be reachable by
  // the code under test.
  // -------------------------------------------------------------------------
  it("caps self-update re-exec attempts when the installed version never advances, instead of looping indefinitely", (t) => {
    if (process.platform === "win32") {
      t.skip("execFileSync(\"npm\", ...) cannot resolve a .cmd-based npm on Windows (forge#2169)");
      return;
    }

    const shimDir = mkdtempSync(join(os.tmpdir(), "fd-npm-stale-shim-"));
    const globalRoot = join(shimDir, "global-root");
    const forgeHome = join(globalRoot, "forgedock");
    const installLog = join(shimDir, "install-log.txt");

    try {
      mkdirSync(join(forgeHome, "bin"), { recursive: true });
      cpSync(dirname(CLI), join(forgeHome, "bin"), {
        recursive: true,
        filter: (src) => !src.includes("tests"),
      });
      mkdirSync(join(forgeHome, "commands"), { recursive: true });
      writeFileSync(join(forgeHome, "commands", "one.md"), "# /one\n\nTest command\n", "utf-8");
      // Deliberately stale on disk, and the shim below never bumps it — every
      // `update()` invocation (parent and every re-exec'd child) sees this
      // same stale version and decides a self-update is needed again.
      writeFileSync(join(forgeHome, "package.json"), JSON.stringify({ name: "forgedock", version: "0.0.1" }), "utf-8");

      // Fake `npm`: responds to `npm root -g` normally, but `npm install -g`
      // only logs the call (appends one line per invocation) and exits 0 —
      // it never actually writes a new version to package.json, simulating a
      // stale registry mirror/proxy that reports success without the
      // resolved version ever advancing.
      const npmShimPath = join(shimDir, "npm");
      writeFileSync(
        npmShimPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "root" ] && [ "$2" = "-g" ]; then',
          `  printf '%s\\n' "${globalRoot.replace(/\\/g, "/")}"`,
          "  exit 0",
          "fi",
          'if [ "$1" = "install" ] && [ "$2" = "-g" ]; then',
          `  printf '%s\\n' "$3" >> "${installLog.replace(/\\/g, "/")}"`,
          "  exit 0",
          "fi",
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const home = mkdtempSync(join(os.tmpdir(), "fd-npm-stale-shim-home-"));
      const res = spawnSync(
        process.execPath,
        [join(forgeHome, "bin", "forgedock.mjs"), "update"],
        {
          cwd: mkdtempSync(join(os.tmpdir(), "fd-npm-stale-shim-cwd-")),
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            NO_COLOR: "1",
            PATH: `${shimDir}:${process.env.PATH}`,
          },
          encoding: "utf-8",
          timeout: 30000,
        },
      );

      assert.equal(res.status, 0, `update exited non-zero:\n${res.stdout}\n${res.stderr}`);

      // Exactly 2 install attempts total (initial + 1 retry allowed by
      // MAX_SELF_UPDATE_ATTEMPTS=1), never more — this is the core
      // regression assertion: the process must NOT recurse indefinitely.
      assert.ok(existsSync(installLog), "the fake npm must have been invoked with `install -g` at least once");
      const attempts = readFileSync(installLog, "utf-8").trim().split("\n").filter(Boolean);
      assert.equal(attempts.length, 2, `expected exactly 2 install attempts (cap reached), got ${attempts.length}:\n${attempts.join("\n")}`);

      // The guard must print an actionable message instead of silently
      // stopping or looping past the cap.
      assert.match(res.stdout, /did not converge|manually/i);
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Negative attempt-counter clamp (forge#2168)
  //
  // Regression covered: `Number.parseInt(x, 10) || 0` only substitutes 0 for
  // NaN/0/"" — a negative numeric string passes through unclamped and is
  // truthy, so it survives the `|| 0` fallback. Without an explicit
  // non-negative floor, a corrupted/negative FORGEDOCK_SELF_UPDATE_ATTEMPT
  // (e.g. "-3") would let the depth guard's `attempt > MAX_SELF_UPDATE_ATTEMPTS`
  // check stay false for several extra re-exec cycles while the value
  // increments back up through 0 — i.e. several more `npm install -g` calls
  // than MAX_SELF_UPDATE_ATTEMPTS should ever allow. With the fix
  // (`Math.max(0, ...)`), attempt=-3 is immediately treated as attempt=0 — the
  // exact same starting state as a fresh, unset-env-var call — so this
  // clamped run must produce the same 2 total installs (1 initial + 1 retry)
  // as the depth-guard test above (forge#2203), not fewer. The guard trips
  // only on the third would-be call (attempt=2, > MAX_SELF_UPDATE_ATTEMPTS=1).
  //
  // Windows note (forge#2169): skipped for the same reason as the two tests
  // above — execFileSync("npm", ...) cannot resolve npm on Windows.
  // -------------------------------------------------------------------------
  it("clamps a negative FORGEDOCK_SELF_UPDATE_ATTEMPT to 0 instead of allowing extra re-exec cycles", (t) => {
    if (process.platform === "win32") {
      t.skip("execFileSync(\"npm\", ...) cannot resolve a .cmd-based npm on Windows (forge#2169)");
      return;
    }

    const shimDir = mkdtempSync(join(os.tmpdir(), "fd-npm-neg-shim-"));
    const globalRoot = join(shimDir, "global-root");
    const forgeHome = join(globalRoot, "forgedock");
    const installLog = join(shimDir, "install-log.txt");

    try {
      mkdirSync(join(forgeHome, "bin"), { recursive: true });
      cpSync(dirname(CLI), join(forgeHome, "bin"), {
        recursive: true,
        filter: (src) => !src.includes("tests"),
      });
      mkdirSync(join(forgeHome, "commands"), { recursive: true });
      writeFileSync(join(forgeHome, "commands", "one.md"), "# /one\n\nTest command\n", "utf-8");
      // Deliberately stale, and the shim below never bumps it — same "never
      // converges" setup as the depth-guard test above, so every re-exec
      // decides a self-update is needed again and the only thing capping
      // total installs is the attempt-count guard under test here.
      writeFileSync(join(forgeHome, "package.json"), JSON.stringify({ name: "forgedock", version: "0.0.1" }), "utf-8");

      const npmShimPath = join(shimDir, "npm");
      writeFileSync(
        npmShimPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "root" ] && [ "$2" = "-g" ]; then',
          `  printf '%s\\n' "${globalRoot.replace(/\\/g, "/")}"`,
          "  exit 0",
          "fi",
          'if [ "$1" = "install" ] && [ "$2" = "-g" ]; then',
          `  printf '%s\\n' "$3" >> "${installLog.replace(/\\/g, "/")}"`,
          "  exit 0",
          "fi",
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const home = mkdtempSync(join(os.tmpdir(), "fd-npm-neg-shim-home-"));
      const res = spawnSync(
        process.execPath,
        [join(forgeHome, "bin", "forgedock.mjs"), "update"],
        {
          cwd: mkdtempSync(join(os.tmpdir(), "fd-npm-neg-shim-cwd-")),
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            NO_COLOR: "1",
            PATH: `${shimDir}:${process.env.PATH}`,
            // The regression input: a negative starting attempt count.
            FORGEDOCK_SELF_UPDATE_ATTEMPT: "-3",
          },
          encoding: "utf-8",
          timeout: 30000,
        },
      );

      assert.equal(res.status, 0, `update exited non-zero:\n${res.stdout}\n${res.stderr}`);
      assert.ok(existsSync(installLog), "the fake npm must have been invoked with `install -g` at least once");
      const attempts = readFileSync(installLog, "utf-8").trim().split("\n").filter(Boolean);
      // With the clamp fix, attempt=-3 is treated as attempt=0, producing the
      // same 2 total installs (1 initial + 1 retry) as the depth-guard test's
      // happy path above (forge#2203) — clamped-negative and fresh-start are
      // the same starting state. Without the clamp, the negative value would
      // only climb back to the cap after several more unclamped increments
      // (-3→-2→-1→0→1→2), producing more installs than the guard should ever
      // allow — this assertion is the exact regression guard for forge#2168.
      assert.equal(attempts.length, 2, `expected exactly 2 install attempts (negative input clamped to 0, then capped like a fresh start), got ${attempts.length}:\n${attempts.join("\n")}`);
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Signal-killed re-exec child no longer reported as success (forge#2159)
  //
  // Regression covered: `process.exit(result.status ?? 0)` collapses a
  // signal-killed child (`result.status === null`, `result.signal` set) into
  // exit code 0, masking the failure. This test replaces the re-exec'd
  // binary (the file `selfUpdateGlobalInstall()` re-execs via
  // `spawnSync(process.execPath, [__filename, "update"], ...)`) with a
  // script that immediately self-terminates via SIGTERM, then asserts the
  // *outer* `update` process — which is the real, unmodified
  // `selfUpdateGlobalInstall()` under test — exits non-zero rather than 0.
  //
  // Windows note (forge#2169): skipped for the same reason as the tests
  // above, plus POSIX signal semantics (a process terminating itself via
  // `process.kill(process.pid, "SIGTERM")` and being observed by the parent
  // as `signal: "SIGTERM"`) do not hold on Windows.
  // -------------------------------------------------------------------------
  it("exits non-zero (not 0) when the re-exec'd self-update child is killed by a signal", (t) => {
    if (process.platform === "win32") {
      t.skip("execFileSync(\"npm\", ...) cannot resolve a .cmd-based npm on Windows, and POSIX signal semantics do not hold on Windows (forge#2169)");
      return;
    }

    const shimDir = mkdtempSync(join(os.tmpdir(), "fd-npm-sig-shim-"));
    const globalRoot = join(shimDir, "global-root");
    const forgeHome = join(globalRoot, "forgedock");
    const forgedockBin = join(forgeHome, "bin", "forgedock.mjs");

    try {
      mkdirSync(join(forgeHome, "bin"), { recursive: true });
      cpSync(dirname(CLI), join(forgeHome, "bin"), {
        recursive: true,
        filter: (src) => !src.includes("tests"),
      });
      mkdirSync(join(forgeHome, "commands"), { recursive: true });
      writeFileSync(join(forgeHome, "commands", "one.md"), "# /one\n\nTest command\n", "utf-8");
      writeFileSync(join(forgeHome, "package.json"), JSON.stringify({ name: "forgedock", version: "0.0.1" }), "utf-8");

      // Fake `npm`: on `install -g`, overwrite the on-disk forgedock.mjs
      // (the exact path `selfUpdateGlobalInstall()` re-execs via
      // `__filename`) with a tiny script that immediately kills itself with
      // SIGTERM. The outer/parent process is still running the real,
      // already-loaded forgedock.mjs code in memory — only the file that the
      // *re-exec'd child* will load from disk is replaced.
      const npmShimPath = join(shimDir, "npm");
      writeFileSync(
        npmShimPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "root" ] && [ "$2" = "-g" ]; then',
          `  printf '%s\\n' "${globalRoot.replace(/\\/g, "/")}"`,
          "  exit 0",
          "fi",
          'if [ "$1" = "install" ] && [ "$2" = "-g" ]; then',
          `  printf 'process.kill(process.pid, \\"SIGTERM\\");\\n' > "${forgedockBin.replace(/\\/g, "/")}"`,
          "  exit 0",
          "fi",
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const home = mkdtempSync(join(os.tmpdir(), "fd-npm-sig-shim-home-"));
      const res = spawnSync(
        process.execPath,
        [forgedockBin, "update"],
        {
          cwd: mkdtempSync(join(os.tmpdir(), "fd-npm-sig-shim-cwd-")),
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            NO_COLOR: "1",
            PATH: `${shimDir}:${process.env.PATH}`,
          },
          encoding: "utf-8",
          timeout: 30000,
        },
      );

      // Core regression assertion: a signal-killed re-exec child must NOT be
      // reported as a successful (exit 0) update.
      assert.notEqual(res.status, 0, `expected non-zero exit for a signal-killed re-exec child, got status=${res.status} signal=${res.signal}\n${res.stdout}\n${res.stderr}`);
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Windows npm.cmd resolution fix (forge#2180)
  //
  // Regression covered: selfUpdateGlobalInstall() called `execFileSync("npm",
  // [...])` with no `shell: true`. On Windows, `npm` is a `.cmd` batch
  // launcher, and Node's execFileSync/spawnSync cannot invoke `.cmd`/`.bat`
  // files without a shell (nodejs/node#3675) — confirmed empirically on a
  // real Windows 11 machine during #2169/#2180's investigation:
  // execFileSync("npm", ["--version"]) ENOENTs even with a real npm.cmd
  // already on PATH. The fix adds `shell: true`, which lets cmd.exe resolve
  // a `.cmd`-based npm (real or, as here, stubbed) via PATH exactly the way
  // an interactive shell would.
  //
  // Unlike the POSIX tests above, this test is intentionally the mirror
  // image: it runs ONLY on win32, using a real `.cmd` stub — the previously
  // "not viable" cross-platform npm stub story from #2169 no longer applies
  // to *this* call once `shell: true` is in place, since cmd.exe (not
  // execFileSync's bare CreateProcess path) is what resolves the `.cmd`
  // extension. This does not run in CI (project CI is ubuntu-only per
  // .github/workflows/ci.yml) but is real, executable regression coverage
  // for any Windows developer machine — including the one this fix was
  // authored and manually verified on.
  // -------------------------------------------------------------------------
  it("[win32] resolves a .cmd-based npm via shell:true and completes the self-update", (t) => {
    if (process.platform !== "win32") {
      t.skip("this test exercises the win32-only .cmd-resolution shell:true path (forge#2169)");
      return;
    }

    const shimDir = mkdtempSync(join(os.tmpdir(), "fd-npm-win-shim-"));
    const globalRoot = join(shimDir, "global-root");
    const forgeHome = join(globalRoot, "forgedock");
    const installLog = join(shimDir, "install-log.txt");

    try {
      mkdirSync(join(forgeHome, "bin"), { recursive: true });
      cpSync(dirname(CLI), join(forgeHome, "bin"), {
        recursive: true,
        filter: (src) => !src.includes("tests"),
      });
      mkdirSync(join(forgeHome, "commands"), { recursive: true });
      writeFileSync(join(forgeHome, "commands", "one.md"), "# /one\n\nTest command\n", "utf-8");
      // Deliberately stale — guaranteed older than the real registry's
      // current "latest", so the self-update branch triggers without an
      // injectable fetchLatestVersion() stub (none exists — see the POSIX
      // test above for the same constraint).
      writeFileSync(join(forgeHome, "package.json"), JSON.stringify({ name: "forgedock", version: "0.0.1" }), "utf-8");

      // Fake npm.cmd: responds to `npm root -g` with the fake global root,
      // and to `npm install -g forgedock@X` by bumping the target
      // package.json's version to X and logging the exact argv received.
      const npmShimPath = join(shimDir, "npm.cmd");
      const pkgJsonPath = join(forgeHome, "package.json").replace(/\\/g, "/");
      writeFileSync(
        npmShimPath,
        [
          "@echo off",
          'if "%1"=="root" if "%2"=="-g" (',
          `  echo ${globalRoot.replace(/\\/g, "/")}`,
          "  exit /b 0",
          ")",
          'if "%1"=="install" if "%2"=="-g" (',
          `  echo %3>>"${installLog.replace(/\\/g, "/")}"`,
          `  node -e "const fs=require('fs');const p='${pkgJsonPath}';const pkg=JSON.parse(fs.readFileSync(p,'utf-8'));pkg.version='%3'.replace('forgedock@','');fs.writeFileSync(p, JSON.stringify(pkg));"`,
          "  exit /b 0",
          ")",
          "exit /b 1",
          "",
        ].join("\r\n"),
      );

      const home = mkdtempSync(join(os.tmpdir(), "fd-npm-win-shim-home-"));
      const res = spawnSync(
        process.execPath,
        [join(forgeHome, "bin", "forgedock.mjs"), "update"],
        {
          cwd: mkdtempSync(join(os.tmpdir(), "fd-npm-win-shim-cwd-")),
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            NO_COLOR: "1",
            PATH: `${shimDir};${process.env.PATH}`,
          },
          encoding: "utf-8",
          timeout: 30000,
        },
      );

      assert.equal(res.status, 0, `update exited non-zero:\n${res.stdout}\n${res.stderr}`);
      assert.match(res.stdout, /Installing.*forgedock@.*globally/i);
      assert.ok(existsSync(installLog), "the fake npm.cmd must have been invoked with `install -g` — this is the exact regression forge#2180 fixes (previously ENOENT before npm.cmd was ever reached)");
      const loggedArg = readFileSync(installLog, "utf-8").trim();
      assert.match(loggedArg, /^forgedock@\d+\.\d+\.\d+/, "npm install -g must be called with an explicit forgedock@<version> argv");

      // After re-exec, the local package.json must no longer read "0.0.1".
      const finalPkg = JSON.parse(readFileSync(join(forgeHome, "package.json"), "utf-8"));
      assert.notEqual(finalPkg.version, "0.0.1", "self-update must actually change the installed version, not leave the stale one in place");

      // The re-exec must complete the persist/relink phase from the NEW
      // payload.
      assert.ok(
        existsSync(join(home, ".claude", "commands", "one.md")),
        "the re-exec'd update must complete relink from the newly-installed payload",
      );
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });
});
