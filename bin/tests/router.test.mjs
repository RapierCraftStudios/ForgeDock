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

function runCli(args, { cwd, home } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd ?? mkdtempSync(join(os.tmpdir(), "fd-cli-cwd-")),
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
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

    const installRes = runCli(["install", "--fast"], { cwd, home });
    assert.equal(installRes.status, 0, installRes.stdout + installRes.stderr);
    assert.ok(existsSync(join(cwd, "forge.yaml")));

    const doctorRes = runCli(["doctor"], { cwd, home });
    assert.equal(doctorRes.status, 0, doctorRes.stdout + doctorRes.stderr);
  });
});
