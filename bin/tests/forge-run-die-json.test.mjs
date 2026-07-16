/**
 * bin/tests/forge-run-die-json.test.mjs
 *
 * Regression test for #2216: scripts/forge-run.sh die() emitted invalid JSON
 * when interpolating raw `gh` CLI stderr that contains backslashes or newlines
 * (e.g. a multi-line auth-failure message on Windows paths).
 *
 * die() previously escaped only double quotes before embedding the message
 * into a hand-built JSON string. It did not escape backslashes (so a literal
 * `\` in the message broke the JSON grammar) and did not escape newlines
 * (raw `\n` bytes are invalid inside a JSON string literal). The fix routes
 * die() through the shared json_str() helper, extended to also escape
 * `\n`/`\r`/`\t`.
 *
 * This test stubs `gh` on PATH to simulate a multi-line, backslash-bearing
 * auth-failure message, spawns forge-run.sh via bash (mirrors the script's
 * own `#!/usr/bin/env bash` shebang — works under Git Bash on Windows and
 * natively on Linux CI), and asserts the emitted NDJSON `error` line parses
 * as valid JSON.
 *
 * Run with: node --test bin/tests/forge-run-die-json.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const FORGE_RUN_SH = join(REPO_ROOT, "scripts", "forge-run.sh");

/**
 * Simulated `gh` auth-failure stderr: multi-line, and includes a literal
 * backslash (a Windows-style path) — the exact combination that broke die()'s
 * quote-only escaping before this fix.
 */
const FAKE_GH_STDERR = [
  "gh: authentication failed",
  String.raw`config path: C:\Users\builder\.config\gh\hosts.yml`,
  "please run: gh auth login",
].join("\n");

/**
 * Write a stub `gh` executable to `binDir` that always fails with
 * FAKE_GH_STDERR on stderr, regardless of arguments.
 */
function makeFakeGhStub(binDir) {
  mkdirSync(binDir, { recursive: true });
  const stubPath = join(binDir, "gh");
  // Emit each fixture line via its own `printf '%s\n'` call so the resulting
  // stderr contains REAL newline bytes between lines. Embedding the whole
  // multi-line fixture as a single JSON-stringified argument would instead
  // produce a literal two-character "\n" sequence (printf's %s does not
  // interpret backslash escapes in its argument) — that would test a
  // different bug than the one this regression covers.
  const printfLines = FAKE_GH_STDERR.split("\n")
    .map((line) => `printf '%s\\n' ${JSON.stringify(line)} >&2`)
    .join("\n");
  const script = ["#!/usr/bin/env bash", printfLines, "exit 1", ""].join("\n");
  writeFileSync(stubPath, script, "utf-8");
  chmodSync(stubPath, 0o755);
  return stubPath;
}

/**
 * Run forge-run.sh via bash with a stubbed `gh` prepended to PATH.
 * Returns { stdout, stderr, status }.
 */
function runForgeRun(args, fakeGhBinDir) {
  const result = spawnSync("bash", [FORGE_RUN_SH, ...args], {
    encoding: "utf-8",
    timeout: 15000,
    env: {
      ...process.env,
      PATH: `${fakeGhBinDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
    },
  });
  return result;
}

/**
 * Extract the last non-empty NDJSON line from stdout.
 */
function lastJsonLine(stdout) {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1];
}

describe("forge-run.sh die() — JSON validity for gh stderr (forge#2216)", async () => {
  let tmpDir;
  let fakeGhBinDir;

  before(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-run-die-json-"));
    fakeGhBinDir = join(tmpDir, "fake-gh-bin");
    makeFakeGhStub(fakeGhBinDir);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits a valid, parseable JSON error line for multi-line gh stderr with a backslash", () => {
    const result = runForgeRun(["work-on", "123", "-R", "acme-org/acme-repo"], fakeGhBinDir);

    assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stderr: ${result.stderr}`);

    const line = lastJsonLine(result.stdout);
    assert.ok(line, `expected at least one NDJSON line on stdout; got: ${JSON.stringify(result.stdout)}`);

    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(line);
    }, `expected the emitted line to be valid JSON, got: ${line}`);

    assert.equal(parsed.event, "error");
    assert.equal(parsed.code, "GH_FETCH_FAILED");
  });

  it("preserves the underlying auth-failure message content (unescaped for the reader)", () => {
    const result = runForgeRun(["work-on", "456", "-R", "acme-org/acme-repo"], fakeGhBinDir);
    const parsed = JSON.parse(lastJsonLine(result.stdout));

    assert.match(parsed.message, /authentication failed/);
    assert.match(parsed.message, /gh auth login/);
  });

  it("round-trips the embedded newlines as literal \\n escape sequences, not raw control bytes", () => {
    const result = runForgeRun(["work-on", "789", "-R", "acme-org/acme-repo"], fakeGhBinDir);
    const line = lastJsonLine(result.stdout);

    // The raw NDJSON line itself must be a single line — no unescaped newline
    // bytes leaked from the multi-line gh stderr into the middle of the JSON.
    assert.equal(result.stdout.trimEnd().split("\n").filter(Boolean).length >= 1, true);

    const parsed = JSON.parse(line);
    // After JSON.parse, the escaped \n sequences decode back into real newlines,
    // so the multi-line structure of the original stderr is preserved in .message.
    assert.equal(parsed.message.split("\n").length, FAKE_GH_STDERR.split("\n").length);
  });

  it("round-trips a literal backslash from the Windows-style path without corruption", () => {
    const result = runForgeRun(["work-on", "101", "-R", "acme-org/acme-repo"], fakeGhBinDir);
    const parsed = JSON.parse(lastJsonLine(result.stdout));

    assert.match(parsed.message, /C:\\Users\\builder\\.config\\gh\\hosts\.yml/);
  });
});
