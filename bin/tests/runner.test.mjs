/**
 * bin/tests/runner.test.mjs
 *
 * Unit tests for bin/runner.mjs — the standalone command runner (issue #1151).
 *
 * Covers (all without network or the Anthropic SDK):
 *   - resolveSpecPath: flat + nested resolution, leading-slash/.md tolerance,
 *     traversal/empty rejection, unknown → null
 *   - listCommands: sorted, nested names use "/" separators
 *   - loadCommandSpec: returns content; unknown throws UNKNOWN_COMMAND
 *   - buildSystemPrompt / buildUserMessage: prompt assembly
 *   - TOOL_DEFINITIONS / getToolHandlers: tool registry behavior
 *   - renderDryRun / renderSummaryCard: rendering
 *   - runCommand: dry-run path, NO_API_KEY guard
 *
 * Run with: node --test bin/tests/runner.test.mjs
 */

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  resolveSpecPath,
  listCommands,
  loadCommandSpec,
  buildSystemPrompt,
  buildCliSystemPrompt,
  buildUserMessage,
  TOOL_DEFINITIONS,
  truncateToolResult,
  isWindowsBashShim,
  resolveBashShell,
  getToolHandlers,
  renderDryRun,
  renderSummaryCard,
  resolveConfiguredDefaultModel,
  runCommand,
  isClaudeCliAvailable,
  CLI_PROBE_OUTPUT_SENTINEL,
  parseProbeOutput,
  selectResolvedCliPath,
  resolveClaudeCliBinary,
  checkExecutionBackend,
  resolveBackend,
  resolveBackendLadder,
  runCliBackend,
  sanitizeArgvForLog,
  sanitizeOutputExcerptForLog,
  extractSessionLimitResetTime,
  parseSessionLimitResetEpochMs,
  VALID_BACKENDS,
} from "../runner.mjs";

// ---------------------------------------------------------------------------
// Fixture: a temporary commands/ directory with flat + nested specs
// ---------------------------------------------------------------------------

let TMP;
let COMMANDS_DIR;

before(() => {
  TMP = mkdtempSync(join(os.tmpdir(), "forgedock-runner-"));
  COMMANDS_DIR = join(TMP, "commands");
  mkdirSync(join(COMMANDS_DIR, "work-on", "build"), { recursive: true });
  writeFileSync(join(COMMANDS_DIR, "work-on.md"), "# work-on spec\nDo the work.");
  writeFileSync(join(COMMANDS_DIR, "review-pr.md"), "# review-pr spec");
  writeFileSync(join(COMMANDS_DIR, "work-on", "build.md"), "# build spec");
  writeFileSync(join(COMMANDS_DIR, "work-on", "build", "architect.md"), "# architect spec");
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveSpecPath
// ---------------------------------------------------------------------------

describe("resolveSpecPath", () => {
  it("resolves a flat command", () => {
    assert.equal(resolveSpecPath(COMMANDS_DIR, "work-on"), join(COMMANDS_DIR, "work-on.md"));
  });

  it("resolves a nested command", () => {
    assert.equal(
      resolveSpecPath(COMMANDS_DIR, "work-on/build"),
      join(COMMANDS_DIR, "work-on", "build.md"),
    );
  });

  it("resolves a deeply nested command", () => {
    assert.equal(
      resolveSpecPath(COMMANDS_DIR, "work-on/build/architect"),
      join(COMMANDS_DIR, "work-on", "build", "architect.md"),
    );
  });

  it("tolerates a leading slash", () => {
    assert.equal(resolveSpecPath(COMMANDS_DIR, "/review-pr"), join(COMMANDS_DIR, "review-pr.md"));
  });

  it("tolerates a trailing .md", () => {
    assert.equal(resolveSpecPath(COMMANDS_DIR, "work-on.md"), join(COMMANDS_DIR, "work-on.md"));
  });

  it("returns null for an unknown command", () => {
    assert.equal(resolveSpecPath(COMMANDS_DIR, "does-not-exist"), null);
  });

  it("rejects path traversal (forward slash)", () => {
    assert.equal(resolveSpecPath(COMMANDS_DIR, "../secrets"), null);
    assert.equal(resolveSpecPath(COMMANDS_DIR, "work-on/../../etc/passwd"), null);
  });

  it("rejects path traversal via backslash (Windows)", () => {
    assert.equal(resolveSpecPath(COMMANDS_DIR, "..\\secrets"), null);
    assert.equal(resolveSpecPath(COMMANDS_DIR, "work-on\\..\\..\\etc\\passwd"), null);
  });

  it("returns null for empty / non-string input", () => {
    assert.equal(resolveSpecPath(COMMANDS_DIR, ""), null);
    assert.equal(resolveSpecPath(COMMANDS_DIR, "   "), null);
    assert.equal(resolveSpecPath(COMMANDS_DIR, null), null);
    assert.equal(resolveSpecPath(COMMANDS_DIR, undefined), null);
  });
});

// ---------------------------------------------------------------------------
// listCommands
// ---------------------------------------------------------------------------

describe("listCommands", () => {
  it("lists all specs, sorted, with / separators", () => {
    assert.deepEqual(listCommands(COMMANDS_DIR), [
      "review-pr",
      "work-on",
      "work-on/build",
      "work-on/build/architect",
    ]);
  });

  it("returns [] for a missing directory", () => {
    assert.deepEqual(listCommands(join(TMP, "nope")), []);
  });
});

// ---------------------------------------------------------------------------
// loadCommandSpec
// ---------------------------------------------------------------------------

describe("loadCommandSpec", () => {
  it("loads spec content + name + path", () => {
    const spec = loadCommandSpec(COMMANDS_DIR, "work-on");
    assert.equal(spec.name, "work-on");
    assert.equal(spec.path, join(COMMANDS_DIR, "work-on.md"));
    assert.match(spec.content, /Do the work/);
  });

  it("normalizes a leading slash in the name", () => {
    assert.equal(loadCommandSpec(COMMANDS_DIR, "/work-on").name, "work-on");
  });

  it("throws UNKNOWN_COMMAND with the available list", () => {
    try {
      loadCommandSpec(COMMANDS_DIR, "nope");
      assert.fail("expected throw");
    } catch (err) {
      assert.equal(err.code, "UNKNOWN_COMMAND");
      assert.ok(Array.isArray(err.available));
      assert.ok(err.available.includes("work-on"));
      assert.match(err.message, /Available commands/);
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

describe("buildSystemPrompt", () => {
  it("embeds the spec content, command name, and repo root", () => {
    const spec = loadCommandSpec(COMMANDS_DIR, "work-on");
    const prompt = buildSystemPrompt(spec, { repoRoot: "/repo/root" });
    assert.match(prompt, /"\/work-on"/);
    assert.match(prompt, /Do the work/);
    assert.match(prompt, /\/repo\/root/);
    assert.match(prompt, /read_file/);
    assert.match(prompt, /COMMAND SPECIFICATION/);
  });

  it("omits the repo-root line when not provided", () => {
    const spec = loadCommandSpec(COMMANDS_DIR, "work-on");
    const prompt = buildSystemPrompt(spec);
    assert.doesNotMatch(prompt, /Working directory \/ repo root:/);
  });
});

describe("buildUserMessage", () => {
  it("formats a slash invocation with args", () => {
    assert.equal(buildUserMessage("work-on", ["1151"]), "Execute: /work-on 1151");
  });

  it("strips a leading slash and trims with no args", () => {
    assert.equal(buildUserMessage("/work-on", []), "Execute: /work-on");
  });

  it("accepts a string args value", () => {
    assert.equal(buildUserMessage("issue", "next"), "Execute: /issue next");
  });
});

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

describe("TOOL_DEFINITIONS", () => {
  it("defines read_file, write_file, run_bash with schemas", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    assert.deepEqual(names.sort(), ["read_file", "run_bash", "write_file"]);
    for (const tool of TOOL_DEFINITIONS) {
      assert.equal(tool.input_schema.type, "object");
      assert.ok(Array.isArray(tool.input_schema.required));
    }
  });
});

describe("getToolHandlers", () => {
  it("read_file reads a file relative to cwd", () => {
    const handlers = getToolHandlers(COMMANDS_DIR);
    const out = handlers.read_file({ path: "work-on.md" });
    assert.match(out, /Do the work/);
  });

  it("write_file creates parent dirs and writes content", () => {
    const handlers = getToolHandlers(TMP);
    const msg = handlers.write_file({ path: "nested/deep/out.txt", content: "hello" });
    assert.match(msg, /Wrote/);
    assert.ok(existsSync(join(TMP, "nested", "deep", "out.txt")));
    assert.equal(readFileSync(join(TMP, "nested", "deep", "out.txt"), "utf-8"), "hello");
  });

  it("run_bash executes a command and returns stdout", () => {
    const handlers = getToolHandlers(TMP);
    const out = handlers.run_bash({ command: "node -e \"process.stdout.write('pong')\"" });
    assert.match(out, /pong/);
  });

  it("run_bash throws on non-zero exit", () => {
    const handlers = getToolHandlers(TMP);
    assert.throws(() => handlers.run_bash({ command: "node -e \"process.exit(3)\"" }), /exit 3/);
  });

  // Regression test for issue #1229 (staging review — PR #1226): the success
  // path previously returned only stdout (via execSync), silently discarding
  // stderr written by a command that still exits 0 — even though the tool
  // schema promises combined stdout/stderr and the error path already
  // combines both.
  it("run_bash includes stderr in the result even when the command exits 0", () => {
    const handlers = getToolHandlers(TMP);
    const out = handlers.run_bash({
      command:
        "node -e \"process.stderr.write('WARN'); process.stdout.write('OK')\"",
    });
    assert.match(out, /OK/);
    assert.match(out, /WARN/);
  });

  it("run_bash scrubs ANTHROPIC_API_KEY from the child env", () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    try {
      const handlers = getToolHandlers(TMP);
      const out = handlers.run_bash({
        command: "node -e \"process.stdout.write(process.env.ANTHROPIC_API_KEY || 'ABSENT')\"",
      });
      assert.match(out, /ABSENT/);
      assert.doesNotMatch(out, /should-not-leak/);
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  // Coverage note for issue #1243 (staging review — PR #1242):
  // The /proc/$PPID/environ attack class cannot be fully tested here because
  // /proc/<pid>/environ reflects the environment at execve() time — it does not
  // update when process.env is modified at runtime. Setting ANTHROPIC_API_KEY
  // inside the test body (process.env.X = "...") does not inject it into
  // /proc/self/environ; it only affects the in-memory libc environ. Therefore
  // a correct test would require ANTHROPIC_API_KEY to be set in the shell
  // BEFORE launching 'node --test', which cannot be guaranteed in a unit test.
  //
  // The effective mitigation at the JavaScript layer is the child-env scrub in
  // run_bash (childEnv = {...process.env}; delete childEnv.ANTHROPIC_API_KEY),
  // which prevents the child process from inheriting the key in its OWN env.
  // The /proc/$PPID/environ vector is a known Linux-level limitation that
  // requires OS-level isolation (seccomp, prctl) to close fully.
  // See: issue #1370 for tracking this limitation.
  //
  // What IS tested: the child-env scrub prevents process.env.ANTHROPIC_API_KEY
  // from being inherited by run_bash child processes (see test above).
  // What is NOT testable in-process: /proc/$PPID/environ reads of the node PID.

  it("handlers validate required input", () => {
    const handlers = getToolHandlers(TMP);
    assert.throws(() => handlers.read_file({}), /requires a 'path'/);
    assert.throws(() => handlers.write_file({ content: "x" }), /requires a 'path'/);
    assert.throws(() => handlers.run_bash({}), /requires a 'command'/);
  });

  // -------------------------------------------------------------------------
  // SEC: read_file and write_file path confinement (issue #1172)
  // A prompt-injection payload must not be able to read /proc/self/environ or
  // any file outside the working directory via model-controlled path input.
  // -------------------------------------------------------------------------

  it("read_file rejects absolute paths (SEC: arbitrary host file read)", () => {
    const handlers = getToolHandlers(TMP);
    // Simulate a prompt-injection payload: read_file("/proc/self/environ")
    assert.throws(
      () => handlers.read_file({ path: "/proc/self/environ" }),
      /Absolute paths are not permitted/,
    );
    // Cross-platform absolute path — os.tmpdir() is absolute on both Windows and Linux
    assert.throws(
      () => handlers.read_file({ path: os.tmpdir() }),
      /Absolute paths are not permitted/,
    );
    // Windows drive-letter path (only absolute on Windows — skip on POSIX)
    if (process.platform === "win32") {
      assert.throws(
        () => handlers.read_file({ path: "C:\\Windows\\system.ini" }),
        /Absolute paths are not permitted/,
      );
    }
  });

  it("read_file rejects '../' path escape (SEC: working-directory confinement)", () => {
    const handlers = getToolHandlers(TMP);
    assert.throws(
      () => handlers.read_file({ path: "../etc/passwd" }),
      /Path escape detected/,
    );
    assert.throws(
      () => handlers.read_file({ path: "subdir/../../secret" }),
      /Path escape detected/,
    );
  });

  it("read_file allows valid relative paths (regression: confinement must not break normal use)", () => {
    const handlers = getToolHandlers(COMMANDS_DIR);
    // work-on.md was written in the before() fixture
    const out = handlers.read_file({ path: "work-on.md" });
    assert.match(out, /Do the work/);
    // nested path inside cwd
    const out2 = handlers.read_file({ path: "work-on/build.md" });
    assert.match(out2, /build spec/);
  });

  it("write_file rejects absolute paths (SEC: arbitrary host file write)", () => {
    const handlers = getToolHandlers(TMP);
    assert.throws(
      () => handlers.write_file({ path: "/tmp/evil.sh", content: "rm -rf /" }),
      /Absolute paths are not permitted/,
    );
  });

  it("write_file rejects '../' path escape (SEC: working-directory confinement)", () => {
    const handlers = getToolHandlers(TMP);
    assert.throws(
      () => handlers.write_file({ path: "../outside.txt", content: "escaped" }),
      /Path escape detected/,
    );
  });

  // -------------------------------------------------------------------------
  // SEC: symlink escape — resolveConfinedPath must resolve symlinks before
  // the confinement check, not just validate the path string (issue #1228).
  // A symlink pre-existing inside cwd must not let read_file/write_file
  // escape working-directory confinement.
  // -------------------------------------------------------------------------

  it("read_file rejects a symlinked file that resolves outside cwd (SEC: symlink escape)", (t) => {
    const symlinkTmp = mkdtempSync(join(os.tmpdir(), "forgedock-symlink-src-"));
    const outsideSecret = join(symlinkTmp, "secret.txt");
    writeFileSync(outsideSecret, "outside-cwd-secret");

    const handlers = getToolHandlers(TMP);
    const linkPath = join(TMP, "evil-link.txt");
    try {
      symlinkSync(outsideSecret, linkPath);
    } catch (err) {
      rmSync(symlinkTmp, { recursive: true, force: true });
      if (err.code === "EPERM" || err.code === "EACCES") {
        t.skip("symlink creation unavailable (Windows without Developer Mode)");
        return;
      }
      throw err;
    }
    try {
      assert.throws(
        () => handlers.read_file({ path: "evil-link.txt" }),
        /Path escape detected/,
      );
    } finally {
      rmSync(linkPath, { force: true });
      rmSync(symlinkTmp, { recursive: true, force: true });
    }
  });

  it("write_file rejects a target inside a symlinked directory that resolves outside cwd (SEC: symlink escape)", (t) => {
    const symlinkTmp = mkdtempSync(join(os.tmpdir(), "forgedock-symlink-dst-"));

    const handlers = getToolHandlers(TMP);
    const linkDir = join(TMP, "evil-link-dir");
    try {
      symlinkSync(symlinkTmp, linkDir);
    } catch (err) {
      rmSync(symlinkTmp, { recursive: true, force: true });
      if (err.code === "EPERM" || err.code === "EACCES") {
        t.skip("symlink creation unavailable (Windows without Developer Mode)");
        return;
      }
      throw err;
    }
    try {
      assert.throws(
        () => handlers.write_file({ path: "evil-link-dir/pwned.txt", content: "pwned" }),
        /Path escape detected/,
      );
      // The write must not have happened outside cwd.
      assert.equal(existsSync(join(symlinkTmp, "pwned.txt")), false);
    } finally {
      rmSync(linkDir, { force: true });
      rmSync(symlinkTmp, { recursive: true, force: true });
    }
  });

  it("write_file allows deeply nested new paths with no existing intermediate directories (regression: symlink fix must not over-block)", () => {
    const handlers = getToolHandlers(TMP);
    const out = handlers.write_file({
      path: "new-a/new-b/new-c/deep.txt",
      content: "deep content",
    });
    assert.match(out, /Wrote \d+ bytes/);
    assert.equal(
      readFileSync(join(TMP, "new-a", "new-b", "new-c", "deep.txt"), "utf-8"),
      "deep content",
    );
  });

  // -------------------------------------------------------------------------
  // Timeout: run_bash must not hang indefinitely (issue #1175)
  // A stalled command (slow git fetch, test suite waiting on stdin, etc.)
  // must be killed and surfaced as a clear error — not block the event loop.
  // -------------------------------------------------------------------------

  it("run_bash kills commands that exceed FORGEDOCK_BASH_TIMEOUT and surfaces a timeout error", () => {
    const orig = process.env.FORGEDOCK_BASH_TIMEOUT;
    process.env.FORGEDOCK_BASH_TIMEOUT = "500"; // 500ms — short but safe
    try {
      // Use os.tmpdir() as cwd (not TMP) so that any orphaned subprocess on
      // Windows — bash child processes inherit cwd but may not be killed when
      // their parent shell is terminated — does not hold TMP locked and break
      // the after() rmSync cleanup.
      const handlers = getToolHandlers(os.tmpdir());
      assert.throws(
        () =>
          handlers.run_bash({
            // node -e "setTimeout" holds the process open beyond the 500ms limit.
            command: "node -e \"setTimeout(() => {}, 30000)\"",
          }),
        (err) => {
          assert.match(err.message, /timed out/i);
          assert.match(err.message, /FORGEDOCK_BASH_TIMEOUT/);
          return true;
        },
      );
    } finally {
      if (orig === undefined) delete process.env.FORGEDOCK_BASH_TIMEOUT;
      else process.env.FORGEDOCK_BASH_TIMEOUT = orig;
    }
  });

  // Regression: SIGTERM from external source must NOT be misclassified as
  // a ForgeDock timeout (issue #1240). Before the fix, the timedOut condition
  // included `result.signal === "SIGTERM"` which fired for any SIGTERM — not
  // only those sent by Node's own spawnSync timeout mechanism. A child killed
  // by an external SIGTERM well below the configured timeoutMs was
  // incorrectly reported as "Command timed out after Ns".
  it("run_bash does NOT classify an external SIGTERM as a timeout (issue #1240)", () => {
    const orig = process.env.FORGEDOCK_BASH_TIMEOUT;
    // Set a generous 10-second timeout — the command will finish in <1s via
    // an external SIGTERM, so elapsedMs will be well below timeoutMs.
    process.env.FORGEDOCK_BASH_TIMEOUT = "10000";
    try {
      const handlers = getToolHandlers(os.tmpdir());
      // The command sends SIGTERM to its own process group immediately.
      // On POSIX this terminates the child via signal (status=null,
      // signal="SIGTERM") well within the 10s timeout window.
      // On Windows, `kill` is not available — skip this test gracefully.
      let threw = false;
      let thrownErr = null;
      try {
        // `kill $$` sends SIGTERM to the shell's own PID immediately.
        handlers.run_bash({ command: "kill $$" });
      } catch (err) {
        threw = true;
        thrownErr = err;
      }
      if (threw && thrownErr) {
        // The command may throw because it exited non-zero or was signaled,
        // but it MUST NOT be reported as a timeout.
        assert.doesNotMatch(
          thrownErr.message,
          /timed out/i,
          `A child killed by external SIGTERM must not be reported as a timeout — got: ${thrownErr.message}`,
        );
        assert.doesNotMatch(
          thrownErr.message,
          /FORGEDOCK_BASH_TIMEOUT/,
          `Timeout error message must not appear for an external-SIGTERM kill — got: ${thrownErr.message}`,
        );
      }
      // If the command didn't throw (e.g. on Windows where `kill $$` may be
      // interpreted differently), the test passes vacuously — no misreport.
    } finally {
      if (orig === undefined) delete process.env.FORGEDOCK_BASH_TIMEOUT;
      else process.env.FORGEDOCK_BASH_TIMEOUT = orig;
    }
  });

  // Regression: maxBuffer overflow must surface a buffer-truncation message
  // and the partial captured output — NOT "Command failed to start" (issue
  // #1241). Before the fix, spawnSync's ENOBUFS error was caught by the
  // generic `if (result.error)` guard, which discarded stdout/stderr and
  // reported a misleading spawn-failure message.
  it("run_bash reports buffer overflow with truncation message, not spawn failure (issue #1241)", () => {
    const origBuf = process.env.FORGEDOCK_MAX_BUFFER_BYTES;
    // Set a 100-byte maxBuffer so any command producing >100 bytes triggers
    // ENOBUFS without generating large output in the test suite.
    process.env.FORGEDOCK_MAX_BUFFER_BYTES = "100";
    try {
      const handlers = getToolHandlers(os.tmpdir());
      // Produce 200 bytes of output — guaranteed to exceed the 100-byte limit.
      assert.throws(
        () =>
          handlers.run_bash({
            command: "node -e \"process.stdout.write('x'.repeat(200))\"",
          }),
        (err) => {
          // Must name the buffer limit, not the spawn mechanism.
          assert.match(
            err.message,
            /buffer limit/i,
            `Expected 'buffer limit' in error message — got: ${err.message}`,
          );
          assert.doesNotMatch(
            err.message,
            /failed to start/i,
            `Must NOT say 'failed to start' for a buffer overflow — got: ${err.message}`,
          );
          // Partial output must be surfaced (spawnSync captures bytes up to
          // the limit before setting result.error).
          assert.match(
            err.message,
            /[xX]+/,
            `Expected partial stdout in error message — got: ${err.message}`,
          );
          return true;
        },
        "Expected run_bash to throw on maxBuffer overflow",
      );
    } finally {
      if (origBuf === undefined) delete process.env.FORGEDOCK_MAX_BUFFER_BYTES;
      else process.env.FORGEDOCK_MAX_BUFFER_BYTES = origBuf;
    }
  });

  // Verify that genuine spawn failures (ENOENT — shell binary not found) still
  // produce the original "failed to start" error message and are not
  // mistakenly treated as buffer overflows.
  //
  // NOTE: run_bash uses `shell: shell || true`, so bash always interprets
  // commands — a nonexistent command name produces exit 127 (not ENOENT).
  // To trigger a real spawnSync ENOENT we must point FORGEDOCK_SHELL at a
  // path that does not exist; spawnSync then cannot exec the shell itself.
  it("run_bash still reports spawn failure (ENOENT) as 'failed to start' (issue #1241)", () => {
    const origShell = process.env.FORGEDOCK_SHELL;
    // Point to a shell binary that definitely does not exist so spawnSync
    // itself fails with ENOENT rather than the child returning exit 127.
    process.env.FORGEDOCK_SHELL = "/nonexistent/shell/forgedock_test";
    try {
      const handlers = getToolHandlers(os.tmpdir());
      assert.throws(
        () => handlers.run_bash({ command: "echo hi" }),
        (err) => {
          assert.match(
            err.message,
            /failed to start/i,
            `Expected 'failed to start' for ENOENT — got: ${err.message}`,
          );
          assert.doesNotMatch(
            err.message,
            /buffer limit/i,
            `ENOENT must NOT be reported as a buffer overflow — got: ${err.message}`,
          );
          return true;
        },
        "Expected run_bash to throw on ENOENT (nonexistent shell)",
      );
    } finally {
      if (origShell === undefined) delete process.env.FORGEDOCK_SHELL;
      else process.env.FORGEDOCK_SHELL = origShell;
    }
  });

  // Regression: when a command exceeds maxBuffer (ENOBUFS) and elapsedMs is
  // also >= timeoutMs, the buffer-overflow message must win over the timeout
  // message. The ENOBUFS check must be ordered BEFORE the elapsedMs-based
  // timedOut fallback in the code. (issue #1364)
  //
  // Scenario: 100-byte maxBuffer with a generous spawnSync timeout. The command
  // fills the buffer quickly (ENOBUFS). We then verify that the elapsed-time
  // guard does NOT override ENOBUFS — i.e., "buffer limit" is surfaced even
  // though the elapsedMs condition would have fired if ENOBUFS were checked
  // later.
  //
  // We cannot reliably manufacture elapsedMs >= timeoutMs in the same run while
  // also getting ENOBUFS (spawnSync's own kill timer fires first when timeout is
  // small, producing ETIMEDOUT instead of ENOBUFS). Instead we verify the code
  // ordering invariant: the ENOBUFS branch runs first and throws, so the timedOut
  // branch is never reached. The unit test for the ENOBUFS path (issue #1241)
  // above already validates the "buffer limit" message. This test adds a check
  // that ENOBUFS always beats the timeout regardless of which assertion fires.
  it("run_bash ENOBUFS check fires before timedOut fallback — buffer-overflow always wins (issue #1364)", () => {
    const origBuf = process.env.FORGEDOCK_MAX_BUFFER_BYTES;
    // 100-byte buffer — 200-byte output guarantees ENOBUFS.
    process.env.FORGEDOCK_MAX_BUFFER_BYTES = "100";
    try {
      const handlers = getToolHandlers(os.tmpdir());
      // Run with the default (generous) timeout so ENOBUFS fires, not ETIMEDOUT.
      // The assertion verifies the ENOBUFS branch ran — not the timedOut branch —
      // which is only possible if ENOBUFS is checked before the elapsedMs guard.
      assert.throws(
        () =>
          handlers.run_bash({
            command: "node -e \"process.stdout.write('x'.repeat(200))\"",
          }),
        (err) => {
          // Must name the buffer limit — proves ENOBUFS branch ran first.
          assert.match(
            err.message,
            /buffer limit/i,
            `ENOBUFS branch must run before timedOut — got: ${err.message}`,
          );
          assert.doesNotMatch(
            err.message,
            /timed out/i,
            `timedOut branch must NOT fire for a buffer overflow — got: ${err.message}`,
          );
          return true;
        },
        "Expected ENOBUFS to produce 'buffer limit' error, not 'timed out'",
      );
    } finally {
      if (origBuf === undefined) delete process.env.FORGEDOCK_MAX_BUFFER_BYTES;
      else process.env.FORGEDOCK_MAX_BUFFER_BYTES = origBuf;
    }
  });
});

// ---------------------------------------------------------------------------
// truncateToolResult — SEC-4b: tool-result truncation marker
// ---------------------------------------------------------------------------

describe("truncateToolResult", () => {
  it("leaves short content unchanged (byte-identical, no marker)", () => {
    const short = "x".repeat(1000);
    assert.equal(truncateToolResult(short), short);
    assert.doesNotMatch(truncateToolResult(short), /truncated/);
  });

  it("leaves content at exactly the cap unchanged", () => {
    const exact = "y".repeat(100_000);
    assert.equal(truncateToolResult(exact), exact);
    assert.doesNotMatch(truncateToolResult(exact), /truncated/);
  });

  it("appends a truncation marker when content exceeds the cap", () => {
    const big = "z".repeat(100_001);
    const out = truncateToolResult(big);
    assert.match(out, /…\[truncated\]$/);
    // 100k cap retained + marker appended, original length not preserved.
    assert.ok(out.length < big.length + 32);
    assert.ok(out.startsWith("z".repeat(100_000)));
  });

  it("coerces nullish input to an empty string", () => {
    assert.equal(truncateToolResult(undefined), "");
    assert.equal(truncateToolResult(null), "");
  });
});

// ---------------------------------------------------------------------------
// isWindowsBashShim — shim detection helper (fix #1189)
// ---------------------------------------------------------------------------

describe("isWindowsBashShim", () => {
  it("identifies WindowsApps paths as shims", () => {
    assert.ok(
      isWindowsBashShim(
        "C:\\Users\\user\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe",
      ),
    );
    // forward-slash separators are normalised before matching
    assert.ok(
      isWindowsBashShim(
        "C:/Users/user/AppData/Local/Microsoft/WindowsApps/bash.exe",
      ),
    );
  });

  it("identifies System32 bash as a shim", () => {
    assert.ok(isWindowsBashShim("C:\\Windows\\System32\\bash.exe"));
    // matching is case-insensitive
    assert.ok(isWindowsBashShim("C:\\WINDOWS\\SYSTEM32\\BASH.EXE"));
  });

  it("does not flag real Git-for-Windows bash as a shim", () => {
    assert.equal(
      isWindowsBashShim("C:\\Program Files\\Git\\bin\\bash.exe"),
      false,
    );
    assert.equal(
      isWindowsBashShim(
        "C:\\Users\\user\\scoop\\apps\\git\\current\\bin\\bash.exe",
      ),
      false,
    );
    assert.equal(
      isWindowsBashShim("C:\\Program Files (x86)\\Git\\bin\\bash.exe"),
      false,
    );
  });

  it("returns false for non-string inputs without throwing", () => {
    assert.equal(isWindowsBashShim(null), false);
    assert.equal(isWindowsBashShim(undefined), false);
    assert.equal(isWindowsBashShim(42), false);
    assert.equal(isWindowsBashShim({}), false);
  });
});

// ---------------------------------------------------------------------------
// resolveBashShell — SEC-5: explicit cross-platform shell for run_bash
// ---------------------------------------------------------------------------

describe("resolveBashShell", () => {
  it("honors the FORGEDOCK_SHELL override", () => {
    const orig = process.env.FORGEDOCK_SHELL;
    process.env.FORGEDOCK_SHELL = "/custom/path/to/bash";
    try {
      assert.equal(resolveBashShell(), "/custom/path/to/bash");
    } finally {
      if (orig === undefined) delete process.env.FORGEDOCK_SHELL;
      else process.env.FORGEDOCK_SHELL = orig;
    }
  });

  it("returns a string path or undefined (graceful fallback), never throws", () => {
    const orig = process.env.FORGEDOCK_SHELL;
    delete process.env.FORGEDOCK_SHELL;
    try {
      const shell = resolveBashShell();
      assert.ok(shell === undefined || typeof shell === "string");
      // When a path is returned it must actually exist on disk.
      if (typeof shell === "string") assert.ok(existsSync(shell));
    } finally {
      if (orig !== undefined) process.env.FORGEDOCK_SHELL = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("renderDryRun / renderSummaryCard", () => {
  it("renderDryRun includes command, model, and tool names", () => {
    const spec = loadCommandSpec(COMMANDS_DIR, "work-on");
    const out = renderDryRun({
      spec,
      systemPrompt: "x".repeat(42),
      userMessage: "Execute: /work-on 1151",
      model: "claude-sonnet-5",
      maxIterations: 50,
    });
    assert.match(out, /\/work-on/);
    assert.match(out, /claude-sonnet-5/);
    assert.match(out, /read_file, write_file, run_bash/);
    assert.match(out, /42 chars/);
    assert.match(out, /dry-run/);
  });

  it("renderSummaryCard includes iterations and stop reason", () => {
    const out = renderSummaryCard({
      command: "work-on",
      args: ["1151"],
      iterations: 7,
      stopReason: "end_turn",
    });
    assert.match(out, /\/work-on 1151/);
    assert.match(out, /iterations: 7/);
    assert.match(out, /end_turn/);
  });

  it("renderSummaryCard renders token usage when provided", () => {
    const usage = {
      input_tokens: 1200,
      output_tokens: 340,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 800,
    };
    const out = renderSummaryCard({
      command: "work-on",
      args: ["42"],
      iterations: 3,
      stopReason: "end_turn",
      usage,
    });
    assert.match(out, /1200 in \/ 340 out/);
    assert.match(out, /800 read \/ 500 write/);
    assert.match(out, /FORGE:USAGE_JSON:/);
    // Verify JSON line is parseable and matches the usage object
    const jsonLine = out.split("\n").find((l) => l.startsWith("FORGE:USAGE_JSON:"));
    const parsed = JSON.parse(jsonLine.slice("FORGE:USAGE_JSON:".length));
    assert.deepStrictEqual(parsed, usage);
  });

  it("renderSummaryCard renders N/A when usage is null (dry-run)", () => {
    const out = renderSummaryCard({
      command: "work-on",
      args: ["42"],
      iterations: 0,
      stopReason: "dry-run",
      usage: null,
    });
    assert.match(out, /tokens:.*N\/A/);
    assert.ok(!out.includes("FORGE:USAGE_JSON:"), "should not emit JSON line when usage is null");
  });

  it("renderSummaryCard defaults usage to null when omitted", () => {
    const out = renderSummaryCard({
      command: "work-on",
      args: [],
      iterations: 1,
      stopReason: "end_turn",
    });
    assert.match(out, /tokens:.*N\/A/);
    assert.ok(!out.includes("FORGE:USAGE_JSON:"));
  });
});

// ---------------------------------------------------------------------------
// runCommand
// ---------------------------------------------------------------------------

describe("runCommand", () => {
  it("dry-run returns status 'dry-run' and logs a preview without network", async () => {
    const lines = [];
    const result = await runCommand({
      commandsDir: COMMANDS_DIR,
      commandName: "work-on",
      args: ["1151"],
      cwd: TMP,
      dryRun: true,
      logger: { log: (s) => lines.push(s) },
    });
    assert.equal(result.status, "dry-run");
    assert.equal(result.command, "work-on");
    assert.equal(result.specPath, join(COMMANDS_DIR, "work-on.md"));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /dry-run/);
  });

  it("throws NO_API_KEY for a live run with no key on the api backend", async () => {
    // backend is pinned to "api" explicitly (issue #2003): with the default
    // "auto" ladder, this assertion would only hold on a machine without the
    // `claude` CLI on PATH — auto-detection could otherwise pick the cli
    // backend and never reach the NO_API_KEY guard at all. Pinning makes the
    // test deterministic regardless of what's installed on the host running
    // it, while still exercising exactly the guard this test is about.
    await assert.rejects(
      runCommand({
        commandsDir: COMMANDS_DIR,
        commandName: "work-on",
        args: ["1151"],
        cwd: TMP,
        dryRun: false,
        apiKey: "",
        backend: "api",
        logger: { log() {} },
      }),
      (err) => err.code === "NO_API_KEY",
    );
  });

  it("propagates UNKNOWN_COMMAND for a bad command name", async () => {
    await assert.rejects(
      runCommand({
        commandsDir: COMMANDS_DIR,
        commandName: "nope",
        dryRun: true,
        logger: { log() {} },
      }),
      (err) => err.code === "UNKNOWN_COMMAND",
    );
  });

  it("dry-run result has no usage field", async () => {
    const result = await runCommand({
      commandsDir: COMMANDS_DIR,
      commandName: "work-on",
      args: ["1151"],
      cwd: TMP,
      dryRun: true,
      logger: { log() {} },
    });
    assert.equal(result.status, "dry-run");
    assert.equal(result.usage, undefined, "dry-run should not include usage");
  });

  it("dry-run result includes model field", async () => {
    const result = await runCommand({
      commandsDir: COMMANDS_DIR,
      commandName: "work-on",
      args: ["1151"],
      cwd: TMP,
      dryRun: true,
      model: "claude-test-model",
      logger: { log() {} },
    });
    assert.equal(result.status, "dry-run");
    assert.equal(result.model, "claude-test-model", "dry-run result must include model field");
  });
});

// ---------------------------------------------------------------------------
// resolveConfiguredDefaultModel (issue #1851 — forge.yaml agents.default_model)
// ---------------------------------------------------------------------------

describe("resolveConfiguredDefaultModel", () => {
  let modelTmp;

  before(() => {
    modelTmp = mkdtempSync(join(os.tmpdir(), "forgedock-model-cfg-"));
  });

  after(() => {
    rmSync(modelTmp, { recursive: true, force: true });
  });

  it("returns null when forge.yaml does not exist", () => {
    const dir = join(modelTmp, "no-forge-yaml");
    mkdirSync(dir, { recursive: true });
    assert.equal(resolveConfiguredDefaultModel(dir), null);
  });

  it("returns null when forge.yaml has no agents section", () => {
    const dir = join(modelTmp, "no-agents-section");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "forge.yaml"), 'project:\n  name: "Test"\n');
    assert.equal(resolveConfiguredDefaultModel(dir), null);
  });

  it("resolves a short alias to its full model ID", () => {
    const dir = join(modelTmp, "alias-opus");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      dir + "/forge.yaml",
      'project:\n  name: "Test"\nagents:\n  default_model: "opus"\n',
    );
    assert.equal(resolveConfiguredDefaultModel(dir), "claude-opus-4-6");
  });

  it("resolves the sonnet alias to the runner's current default ID", () => {
    const dir = join(modelTmp, "alias-sonnet");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "forge.yaml"),
      "agents:\n  default_model: sonnet\n",
    );
    assert.equal(resolveConfiguredDefaultModel(dir), "claude-sonnet-5");
  });

  it("passes through an unrecognized value (e.g. a full model ID) unchanged", () => {
    const dir = join(modelTmp, "full-id-passthrough");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "forge.yaml"),
      'agents:\n  default_model: "claude-custom-future-model"\n',
    );
    assert.equal(
      resolveConfiguredDefaultModel(dir),
      "claude-custom-future-model",
    );
  });

  it("fails soft (returns null, does not throw) when forge.yaml is unreadable", () => {
    // A directory named "forge.yaml" makes readFileSync throw EISDIR.
    const dir = join(modelTmp, "unreadable-forge-yaml");
    mkdirSync(join(dir, "forge.yaml"), { recursive: true });
    assert.doesNotThrow(() => resolveConfiguredDefaultModel(dir));
    assert.equal(resolveConfiguredDefaultModel(dir), null);
  });
});

// ---------------------------------------------------------------------------
// runCommand — model resolution precedence (issue #1851)
// ---------------------------------------------------------------------------

describe("runCommand model resolution precedence", () => {
  let precTmp;
  let originalForgedockModel;

  before(() => {
    precTmp = mkdtempSync(join(os.tmpdir(), "forgedock-model-prec-"));
    originalForgedockModel = process.env.FORGEDOCK_MODEL;
    delete process.env.FORGEDOCK_MODEL;
  });

  after(() => {
    rmSync(precTmp, { recursive: true, force: true });
    if (originalForgedockModel === undefined) {
      delete process.env.FORGEDOCK_MODEL;
    } else {
      process.env.FORGEDOCK_MODEL = originalForgedockModel;
    }
  });

  it("uses forge.yaml agents.default_model when FORGEDOCK_MODEL and opts.model are unset", async () => {
    const dir = join(precTmp, "cwd-with-forge-yaml");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "forge.yaml"), 'agents:\n  default_model: "opus"\n');

    const result = await runCommand({
      commandsDir: COMMANDS_DIR,
      commandName: "work-on",
      args: ["1851"],
      cwd: dir,
      dryRun: true,
      logger: { log() {} },
    });
    assert.equal(result.model, "claude-opus-4-6");
  });

  it("FORGEDOCK_MODEL env var still takes precedence over forge.yaml", async () => {
    const dir = join(precTmp, "cwd-env-wins");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "forge.yaml"), 'agents:\n  default_model: "opus"\n');
    process.env.FORGEDOCK_MODEL = "claude-env-override";

    try {
      const result = await runCommand({
        commandsDir: COMMANDS_DIR,
        commandName: "work-on",
        args: ["1851"],
        cwd: dir,
        dryRun: true,
        logger: { log() {} },
      });
      assert.equal(result.model, "claude-env-override");
    } finally {
      delete process.env.FORGEDOCK_MODEL;
    }
  });

  it("opts.model (the --model flag) still wins over forge.yaml", async () => {
    const dir = join(precTmp, "cwd-flag-wins");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "forge.yaml"), 'agents:\n  default_model: "opus"\n');

    const result = await runCommand({
      commandsDir: COMMANDS_DIR,
      commandName: "work-on",
      args: ["1851"],
      cwd: dir,
      dryRun: true,
      model: "claude-explicit-flag",
      logger: { log() {} },
    });
    assert.equal(result.model, "claude-explicit-flag");
  });

  it("falls back to the hardcoded default when forge.yaml has no agents section", async () => {
    const dir = join(precTmp, "cwd-hardcoded-fallback");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "forge.yaml"), 'project:\n  name: "Test"\n');

    const result = await runCommand({
      commandsDir: COMMANDS_DIR,
      commandName: "work-on",
      args: ["1851"],
      cwd: dir,
      dryRun: true,
      logger: { log() {} },
    });
    assert.equal(result.model, "claude-sonnet-5");
  });

  it("falls back to the hardcoded default when forge.yaml does not exist", async () => {
    const dir = join(precTmp, "cwd-no-forge-yaml");
    mkdirSync(dir, { recursive: true });

    const result = await runCommand({
      commandsDir: COMMANDS_DIR,
      commandName: "work-on",
      args: ["1851"],
      cwd: dir,
      dryRun: true,
      logger: { log() {} },
    });
    assert.equal(result.model, "claude-sonnet-5");
  });
});

// ---------------------------------------------------------------------------
// runCliBackend — argv passthrough is injection-safe (issue #2003)
// ---------------------------------------------------------------------------

describe("runCliBackend argv safety", () => {
  it("passes userMessage as a literal, unparsed argv element — no shell metacharacter execution", () => {
    // Regression test for a shell-injection finding caught in review: an
    // earlier implementation built a shell command *string* and ran it via
    // spawnSync(command, { shell: true }) with hand-rolled quoting that did
    // NOT neutralize $(...) / backticks / etc inside double quotes. The fix
    // is spawnSync(bin, [...argv]) with NO shell option — argv elements are
    // delivered to the child process as discrete, unparsed tokens, never
    // interpreted as shell syntax.
    //
    // Uses the `bin` test seam (defaults to "claude" in production; not
    // overridable outside tests) pointed at the real `node` binary
    // (process.execPath — a genuine, already-resolvable executable, so this
    // sidesteps the platform-specific PATH/`.cmd`-shim resolution quirks
    // that make shimming a fake "claude" on PATH unreliable to set up from
    // within the same running process on Windows).
    //
    // node's own CLI parser rejects the fixed 3rd argv element
    // ("--output-format", added by issue #2398's usage-parsing change) as an
    // unrecognized flag and exits non-zero — which is itself strong
    // affirmative evidence of correct argv separation: the parser named that
    // exact 3rd token as the "bad option" *distinct* from the 2nd (message)
    // token, proving all array elements arrived as separate, unmangled
    // OS-level argv entries rather than being concatenated/re-tokenized by an
    // intermediate shell. The decisive assertion, though, is simpler and
    // platform-independent: the injection payload's side effect (creating a
    // marker file via $(...)) must never occur, because runCliBackend never
    // hands the message to a shell in the first place.
    const shimDir = mkdtempSync(join(os.tmpdir(), "forgedock-cli-injection-"));
    const injectionMarkerPath = join(shimDir, "INJECTED");
    const maliciousMessage =
      `Execute: /work-on 2003; $(touch ${injectionMarkerPath.replace(/\\/g, "/")}) ` +
      `\`touch ${injectionMarkerPath.replace(/\\/g, "/")}\` && echo pwned`;

    const logLines = [];
    let thrown;
    try {
      runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: maliciousMessage,
        args: ["2003"],
        cwd: shimDir,
        logger: { log: (s) => logLines.push(s) },
        bin: process.execPath, // absolute path to the running `node` binary
      });
    } catch (err) {
      thrown = err;
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }

    // node's CLI parser rejects the 3rd argv element and exits non-zero, so
    // runCliBackend's `result.status !== 0` branch throws CLI_BACKEND_FAILED.
    assert.ok(thrown, "node's own flag validation should reject this argv and cause a non-zero exit");
    assert.equal(thrown.code, "CLI_BACKEND_FAILED");

    // The core security property: shell metacharacters in userMessage were
    // NEVER executed — no shell ever parsed the string, so $(...) never ran.
    assert.ok(
      !existsSync(injectionMarkerPath),
      "shell metacharacters in userMessage must NOT be executed (injection marker file must not exist)",
    );

    // Corroborating evidence: node's own error output names the 3rd argv
    // element as a distinct, unmangled token — proving argv separation was
    // preserved end-to-end (no shell re-tokenized/concatenated the array).
    const output = logLines.join("\n");
    assert.match(output, /--output-format/);
  });
});

// ---------------------------------------------------------------------------
// runCliBackend — content passthrough (review finding BUG-3, issue #2029;
// fixed for #2019)
//
// The injection-safety test above proves shell metacharacters in
// `userMessage` are never *executed*, but it never asserts on the actual
// *content* the CLI binary receives. That gap is precisely why BUG-1 (#2019
// — the CLI backend silently dropped `systemPrompt`/`spec.content`, so the
// spawned `claude` process never saw the command specification at all) went
// uncaught by an otherwise-strong suite. This test closes that gap by
// capturing the literal argv delivered to the spawned binary and asserting
// on it directly, using a recording stub binary via the `bin` test seam
// (same POSIX-shebang stub-binary pattern already used in
// bin/tests/router.test.mjs — CI runs ubuntu-only, see .github/workflows/ci.yml).
//
// UPDATED for #2019: `runCliBackend` now receives `systemPrompt` and forwards
// it to the CLI via `--append-system-prompt-file <path>` (a temp file, not an
// inline argv string — see the SYSTEM PROMPT block comment above
// `runCliBackend` in bin/runner.mjs for why). This test now asserts that flag
// is present with a path whose file contents include the spec content, and
// that the temp directory is cleaned up afterward.
// ---------------------------------------------------------------------------

describe("runCliBackend content passthrough (issue #2029, updated for #2019)", () => {
  it("forwards systemPrompt to the spawned CLI binary via --append-system-prompt-file", () => {
    // The stub relies on a POSIX shebang; CI runs ubuntu-only (see
    // .github/workflows/ci.yml), matching the existing precedent in
    // bin/tests/router.test.mjs. Skip on other platforms rather than fail.
    if (process.platform === "win32") {
      return;
    }

    const shimDir = mkdtempSync(join(os.tmpdir(), "forgedock-cli-argv-capture-"));
    const captureFile = join(shimDir, "captured-argv.json");
    const recorderPath = join(shimDir, "record-argv.mjs");
    const fakeClaudePath = join(shimDir, "fake-claude");

    // The recorder writes its own received argv (everything after the
    // recorder script path) to captureFile as JSON — this is what actually
    // reached the "CLI". It ALSO captures whether the system-prompt file
    // exists and its contents AT SPAWN TIME, before runCliBackend's finally
    // block removes the temp dir. This is the only sound way to observe the
    // file "while the CLI runs" — checking existsSync from the test after the
    // synchronous runCliBackend returns would always see the cleaned-up state.
    writeFileSync(
      recorderPath,
      [
        'import { writeFileSync, existsSync, readFileSync } from "node:fs";',
        "const argv = process.argv.slice(3);",
        'const flagIdx = argv.indexOf("--append-system-prompt-file");',
        "const sysPath = flagIdx >= 0 ? argv[flagIdx + 1] : null;",
        "const sysPromptExists = sysPath ? existsSync(sysPath) : false;",
        'const sysPromptContents = sysPromptExists ? readFileSync(sysPath, "utf-8") : null;',
        "writeFileSync(process.argv[2], JSON.stringify({ argv, sysPromptExists, sysPromptContents }));",
      ].join("\n") + "\n",
      "utf-8",
    );

    // The stub binary is what `runCliBackend` actually spawns (via the `bin`
    // seam). It re-execs node against the recorder, passing its own argv
    // through untouched via "$@" — this avoids node's own -p/--print flag
    // parsing (which would otherwise swallow "--print" as node's own CLI
    // flag, as happens in the sibling injection-safety test above).
    writeFileSync(
      fakeClaudePath,
      ["#!/bin/sh", `exec node "${recorderPath}" "${captureFile}" "$@"`, ""].join("\n"),
      { mode: 0o755 },
    );

    const message = "Execute: /work-on 2003";
    const logLines = [];
    const spec = loadCommandSpec(COMMANDS_DIR, "work-on");
    const systemPrompt = buildCliSystemPrompt(spec);
    let capturedSystemPromptPath;

    // try/finally so shimDir is always cleaned up, even if an assertion
    // below throws — matches the cleanup discipline already established by
    // the "runCliBackend argv safety" test directly above this one.
    try {
      const result = runCliBackend({
        spec,
        userMessage: message,
        systemPrompt,
        args: ["2003"],
        cwd: shimDir,
        logger: { log: (s) => logLines.push(s) },
        bin: fakeClaudePath,
      });

      assert.equal(result.status, "complete");
      assert.ok(existsSync(captureFile), "the stub binary must have run and recorded its argv");

      const captured = JSON.parse(readFileSync(captureFile, "utf-8"));
      const capturedArgv = captured.argv;

      // The exact content reaching the CLI invocation now includes the
      // system-prompt file flag — this is the fix for BUG-1 / #2019.
      assert.deepStrictEqual(capturedArgv.slice(0, 2), ["--print", message]);
      assert.equal(capturedArgv[2], "--output-format");
      assert.equal(capturedArgv[3], "json");
      assert.equal(capturedArgv[4], "--append-system-prompt-file");
      capturedSystemPromptPath = capturedArgv[5];
      assert.ok(
        typeof capturedSystemPromptPath === "string" && capturedSystemPromptPath.length > 0,
        "argv must include a system-prompt file path",
      );
      assert.equal(capturedArgv[6], "--dangerously-skip-permissions");

      // The file existed AT THE TIME the CLI process ran (observed by the
      // recorder during the spawn, before runCliBackend's finally-block
      // cleanup) and contained the command spec content — proving the spec is
      // no longer dropped.
      assert.ok(captured.sysPromptExists, "system-prompt temp file must exist while the CLI runs");
      assert.match(captured.sysPromptContents, /COMMAND SPECIFICATION/);
      assert.match(captured.sysPromptContents, /# work-on spec/); // fixture spec content from COMMANDS_DIR
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }

    // Cleanup assertion: runCliBackend's own temp dir (parent of the
    // captured file, NOT shimDir above) must be removed after the call
    // returns — the finally block inside runCliBackend runs before this
    // test's try/finally above even begins its own cleanup.
    assert.ok(
      !existsSync(capturedSystemPromptPath),
      "runCliBackend must clean up its own system-prompt temp file after the call completes",
    );
  });

  it("omits --append-system-prompt-file entirely when no systemPrompt is supplied (back-compat)", () => {
    if (process.platform === "win32") {
      return;
    }

    const shimDir = mkdtempSync(join(os.tmpdir(), "forgedock-cli-argv-capture-nosysprompt-"));
    const captureFile = join(shimDir, "captured-argv.json");
    const recorderPath = join(shimDir, "record-argv.mjs");
    const fakeClaudePath = join(shimDir, "fake-claude");

    writeFileSync(
      recorderPath,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));",
      ].join("\n") + "\n",
      "utf-8",
    );
    writeFileSync(
      fakeClaudePath,
      ["#!/bin/sh", `exec node "${recorderPath}" "${captureFile}" "$@"`, ""].join("\n"),
      { mode: 0o755 },
    );

    const message = "Execute: /work-on 2003";

    try {
      const result = runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: message,
        args: ["2003"],
        cwd: shimDir,
        logger: { log: () => {} },
        bin: fakeClaudePath,
      });

      assert.equal(result.status, "complete");
      const capturedArgv = JSON.parse(readFileSync(captureFile, "utf-8"));
      assert.deepStrictEqual(capturedArgv, [
        "--print",
        message,
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
      ]);
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("cleans up the system-prompt temp file when the CLI invocation fails (non-zero exit)", () => {
    if (process.platform === "win32") {
      return;
    }

    const shimDir = mkdtempSync(join(os.tmpdir(), "forgedock-cli-argv-capture-fail-"));
    const captureFile = join(shimDir, "captured-argv.json");
    const recorderPath = join(shimDir, "record-argv.mjs");
    const fakeClaudePath = join(shimDir, "fake-claude-fail");

    // Recorder captures argv AND always exits non-zero, simulating a failed
    // CLI invocation — this exercises the throw path inside runCliBackend's
    // try/finally, proving the temp file is still cleaned up.
    writeFileSync(
      recorderPath,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));",
        "process.exit(1);",
      ].join("\n") + "\n",
      "utf-8",
    );
    writeFileSync(
      fakeClaudePath,
      ["#!/bin/sh", `exec node "${recorderPath}" "${captureFile}" "$@"`, ""].join("\n"),
      { mode: 0o755 },
    );

    const spec = loadCommandSpec(COMMANDS_DIR, "work-on");
    const systemPrompt = buildCliSystemPrompt(spec);
    let capturedSystemPromptPath;

    try {
      assert.throws(() => {
        runCliBackend({
          spec,
          userMessage: "Execute: /work-on 2003",
          systemPrompt,
          args: ["2003"],
          cwd: shimDir,
          logger: { log: () => {} },
          bin: fakeClaudePath,
        });
      }, /CLI_BACKEND_FAILED|exited with status/);

      const capturedArgv = JSON.parse(readFileSync(captureFile, "utf-8"));
      capturedSystemPromptPath = capturedArgv[5];
      assert.ok(typeof capturedSystemPromptPath === "string" && capturedSystemPromptPath.length > 0);
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }

    assert.ok(
      !existsSync(capturedSystemPromptPath),
      "temp file must be cleaned up even when the CLI invocation throws (non-zero exit)",
    );
  });
});

// ---------------------------------------------------------------------------
// runCliBackend — env scrub (issue #2021)
// ---------------------------------------------------------------------------

describe("runCliBackend env scrub (issue #2021)", () => {
  it("does not forward ANTHROPIC_API_KEY to the spawned CLI, but leaves other env vars intact", () => {
    if (process.platform === "win32") {
      return;
    }

    const shimDir = mkdtempSync(join(os.tmpdir(), "forgedock-cli-env-capture-"));
    const captureFile = join(shimDir, "captured-env.json");
    const recorderPath = join(shimDir, "record-env.mjs");
    const fakeClaudePath = join(shimDir, "fake-claude-env");

    // Recorder dumps the two env vars under test (not the full env — full
    // env dumps in a test fixture are themselves a needless leak surface)
    // to captureFile as JSON.
    writeFileSync(
      recorderPath,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.argv[2], JSON.stringify({",
        "  anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,",
        "  marker: process.env.FORGEDOCK_TEST_MARKER ?? null,",
        "}));",
      ].join("\n") + "\n",
      "utf-8",
    );
    writeFileSync(
      fakeClaudePath,
      ["#!/bin/sh", `exec node "${recorderPath}" "${captureFile}" "$@"`, ""].join("\n"),
      { mode: 0o755 },
    );

    const origKey = process.env.ANTHROPIC_API_KEY;
    const origMarker = process.env.FORGEDOCK_TEST_MARKER;
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    process.env.FORGEDOCK_TEST_MARKER = "should-survive-scrub";

    try {
      const result = runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: "Execute: /work-on 2003",
        args: ["2003"],
        cwd: shimDir,
        logger: { log: () => {} },
        bin: fakeClaudePath,
      });

      assert.equal(result.status, "complete");
      const captured = JSON.parse(readFileSync(captureFile, "utf-8"));
      assert.equal(
        captured.anthropicKey,
        null,
        "ANTHROPIC_API_KEY must not be present in the spawned CLI's environment",
      );
      assert.equal(
        captured.marker,
        "should-survive-scrub",
        "unrelated env vars must still be forwarded — this must be a targeted scrub, not env: {}",
      );
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
      if (origMarker === undefined) delete process.env.FORGEDOCK_TEST_MARKER;
      else process.env.FORGEDOCK_TEST_MARKER = origMarker;
    }
  });
});

// ---------------------------------------------------------------------------
// runCliBackend — spawnFn injection seam (issue #2033)
//
// Additive to the `bin`-override tests above (real fake binary on disk, real
// spawnSync). This exercises the same `spawnFn` dependency-injection seam
// already used by bin/init-enrich-cli.mjs's enrich() (see
// bin/tests/init-enrich-cli.test.mjs), so the two mirrored CLI-spawn
// backends can be tested — and any future behavioral drift between them
// caught — with equivalent fixtures. Platform-agnostic: unlike the
// `bin`-override tests, no `#!/bin/sh` shim is written to disk, so this
// suite is not skipped on win32.
// ---------------------------------------------------------------------------

describe("runCliBackend spawnFn seam (issue #2033)", () => {
  it("uses the injected spawnFn instead of the real spawnSync, and forwards argv/opts", () => {
    let capturedBin, capturedArgv, capturedOpts;
    const spawnFn = (bin, argv, opts) => {
      capturedBin = bin;
      capturedArgv = argv;
      capturedOpts = opts;
      return { status: 0, stdout: "ok", stderr: "", error: undefined };
    };

    const result = runCliBackend({
      spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
      userMessage: "Execute: /work-on 2033",
      args: ["2033"],
      cwd: TMP,
      logger: { log: () => {} },
      bin: "claude",
      spawnFn,
    });

    assert.equal(result.status, "complete");
    assert.equal(result.backend, "cli");
    assert.equal(capturedBin, "claude");
    // argv must be a literal array — never a single interpolated shell string
    // (mirrors the equivalent guard in init-enrich-cli.test.mjs).
    assert.ok(Array.isArray(capturedArgv));
    assert.equal(capturedArgv[0], "--print");
    assert.equal(capturedArgv[1], "Execute: /work-on 2033");
    assert.equal(capturedOpts.cwd, TMP);
    assert.notEqual(
      capturedOpts.shell,
      true,
      "must never invoke spawnFn with shell:true (shell-injection guard, mirrors issue #2031)",
    );
  });

  it("propagates a non-zero exit status from the injected spawnFn as CLI_BACKEND_FAILED", () => {
    const spawnFn = () => ({
      status: 1,
      stdout: "",
      stderr: "boom",
      error: undefined,
    });

    assert.throws(
      () =>
        runCliBackend({
          spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
          userMessage: "Execute: /work-on 2033",
          args: ["2033"],
          cwd: TMP,
          logger: { log: () => {} },
          bin: "claude",
          spawnFn,
        }),
      (err) => err.code === "CLI_BACKEND_FAILED",
    );
  });

  // Issue #2258 (parent: #2244) — a non-zero exit with fully empty
  // stdout/stderr previously threw a self-referential "See output above for
  // details" message even though nothing was ever logged, making the failure
  // structurally undiagnosable. This asserts the fixed message is
  // self-contained: it never claims output exists when it doesn't, and it
  // inlines exit status, signal, and invocation (argv/cwd) context.
  it("never claims 'output above' and inlines status/signal/argv/cwd when stdout AND stderr are both empty", () => {
    const loggedLines = [];
    const spawnFn = () => ({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "",
      error: undefined,
    });

    let thrown;
    try {
      runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: "Execute: /work-on 2258",
        args: ["2258"],
        cwd: TMP,
        logger: { log: (line) => loggedLines.push(line) },
        bin: "claude",
        spawnFn,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "runCliBackend must throw on non-zero exit");
    assert.equal(thrown.code, "CLI_BACKEND_FAILED");
    assert.match(thrown.message, /exited with status 1/);
    assert.ok(
      !thrown.message.includes("See output above for details"),
      `message must not claim output exists when none was captured: ${thrown.message}`,
    );
    assert.match(
      thrown.message,
      /no output was captured/i,
      "message must explicitly state that no output was captured",
    );
    assert.match(
      thrown.message,
      /claude --print/,
      "message must inline the argv used for the failed invocation",
    );
    assert.ok(
      thrown.message.includes(TMP),
      "message must inline the cwd used for the failed invocation",
    );
    assert.ok(
      loggedLines.some((line) => /no output was captured/i.test(line)),
      "an explicit 'no output captured' diagnostic must be logged even when nothing was printed",
    );
  });

  // Issue #2355: when the CLI produces non-empty stdout/stderr before a
  // non-zero exit, the thrown message previously only said "See captured
  // output above" — a pointer to a logger.log() call that is never persisted
  // into the durable ~/.forge/runs/*.jsonl run-log (only `err.message`, via
  // bin/engine.mjs's `reason: e.message`/fail-fast `detail` string, reaches
  // that persisted record). This asserts the actual captured output text is
  // now embedded directly in the thrown message.
  it("embeds the actual captured output text in the thrown message when stdout/stderr is non-empty (#2355)", () => {
    const spawnFn = () => ({
      status: 1,
      signal: null,
      stdout: "TypeError: cannot read property 'foo' of undefined",
      stderr: "    at main (/app/index.js:12:3)",
      error: undefined,
    });

    let thrown;
    try {
      runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: "Execute: /work-on 2355",
        args: ["2355"],
        cwd: TMP,
        logger: { log: () => {} },
        bin: "claude",
        spawnFn,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "runCliBackend must throw on non-zero exit");
    assert.equal(thrown.code, "CLI_BACKEND_FAILED");
    assert.ok(
      !thrown.message.includes("See captured output above"),
      `message must not be a self-referential pointer to already-logged output: ${thrown.message}`,
    );
    assert.ok(
      thrown.message.includes("TypeError: cannot read property 'foo' of undefined"),
      `message must embed the actual captured stdout text: ${thrown.message}`,
    );
    assert.ok(
      thrown.message.includes("at main (/app/index.js:12:3)"),
      `message must embed the actual captured stderr text: ${thrown.message}`,
    );
  });

  // Issue #2355 AC4: the embedded excerpt must be bounded so a very verbose
  // CLI failure doesn't bloat the persisted JSONL run-log line indefinitely.
  it("bounds and truncates a very large captured-output excerpt with a visible marker (#2355)", () => {
    const hugeOutput = "E".repeat(10000);
    const spawnFn = () => ({ status: 1, signal: null, stdout: hugeOutput, stderr: "", error: undefined });

    let thrown;
    try {
      runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: "Execute: /work-on 2355",
        args: ["2355"],
        cwd: TMP,
        logger: { log: () => {} },
        bin: "claude",
        spawnFn,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "expected runCliBackend to throw");
    assert.ok(
      !thrown.message.includes("E".repeat(10000)),
      "message must not contain the full unbounded captured output",
    );
    assert.match(
      thrown.message,
      /…\[truncated, \d+ chars\]/,
      "message must contain a visible truncation marker for the bounded excerpt",
    );
  });

  // Issue #2355: confirms the `!hadOutput` branch (already fixed by #2258/PR
  // #2276) is unchanged by this fix — no regression to the empty-output
  // diagnostic (exit code/signal/argv/cwd).
  it("does not alter the empty-output diagnostic text (no regression to #2258/PR #2276, issue #2355 AC3)", () => {
    const spawnFn = () => ({ status: 1, signal: null, stdout: "", stderr: "", error: undefined });

    let thrown;
    try {
      runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: "Execute: /work-on 2355",
        args: ["2355"],
        cwd: TMP,
        logger: { log: () => {} },
        bin: "claude",
        spawnFn,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "expected runCliBackend to throw");
    assert.match(
      thrown.message,
      /No output was captured \(stdout and stderr were both empty\)\./,
      "empty-output message text must remain byte-identical to the pre-existing #2258/PR #2276 fix",
    );
  });

  it("sanitizeOutputExcerptForLog neutralizes control characters, matching sanitizeArgvForLog's discipline (#2355)", () => {
    const raw = "\x1b[31mFAKE\x1b[0m";
    const excerpt = sanitizeOutputExcerptForLog(raw);
    // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of raw control chars is the point of this test
    assert.ok(!/[\x00-\x1F\x7F]/.test(excerpt), "excerpt must not contain raw control characters");
    assert.match(excerpt, /\\x1b/, "escaped ESC sequence should appear in place of the raw control char");
  });

  it("surfaces result.signal in the thrown message when the child was killed by a signal", () => {
    const spawnFn = () => ({
      status: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      error: undefined,
    });

    assert.throws(
      () =>
        runCliBackend({
          spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
          userMessage: "Execute: /work-on 2258",
          args: ["2258"],
          cwd: TMP,
          logger: { log: () => {} },
          bin: "claude",
          spawnFn,
        }),
      (err) => err.code === "CLI_BACKEND_FAILED" && /signal SIGKILL/.test(err.message),
    );
  });

  // Issue #2360: spawnSync's `timeout` option kills the child on expiry, but
  // any stdout/stderr the CLI had already produced before the kill is still
  // populated on `result` — the timeout branch previously discarded it
  // entirely. This asserts the partial output is now embedded in the thrown
  // message (mirroring the #2355 fix to the sibling non-zero-exit branch).
  it("embeds captured partial output in the thrown message on ETIMEDOUT (#2360)", () => {
    const spawnFn = () => ({
      status: null,
      signal: null,
      error: { code: "ETIMEDOUT" },
      stdout: "Architect plan: step 1 of 5 complete...",
      stderr: "",
    });

    let thrown;
    try {
      runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: "Execute: /work-on 2360",
        args: ["2360"],
        cwd: TMP,
        logger: { log: () => {} },
        bin: "claude",
        spawnFn,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "expected runCliBackend to throw on ETIMEDOUT");
    assert.match(thrown.message, /timed out after \d+s and was killed/);
    assert.match(thrown.message, /FORGEDOCK_CLI_TIMEOUT_MS/);
    assert.ok(
      thrown.message.includes("Partial output:"),
      `message must include a Partial output section: ${thrown.message}`,
    );
    assert.ok(
      thrown.message.includes("Architect plan: step 1 of 5 complete..."),
      `message must embed the actual captured partial stdout text: ${thrown.message}`,
    );
  });

  // Issue #2360: no regression — when the killed CLI produced no output at
  // all before timing out, the message must remain byte-identical to the
  // pre-existing (pre-#2360) text, with no dangling "Partial output:" suffix.
  it("does not append a Partial output section when stdout/stderr are both empty on ETIMEDOUT (#2360)", () => {
    const spawnFn = () => ({
      status: null,
      signal: null,
      error: { code: "ETIMEDOUT" },
      stdout: "",
      stderr: "",
    });

    let thrown;
    try {
      runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: "Execute: /work-on 2360",
        args: ["2360"],
        cwd: TMP,
        logger: { log: () => {} },
        bin: "claude",
        spawnFn,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "expected runCliBackend to throw on ETIMEDOUT");
    assert.ok(
      !thrown.message.includes("Partial output:"),
      `message must not include a Partial output section when nothing was captured: ${thrown.message}`,
    );
    assert.match(
      thrown.message,
      /^claude CLI invocation timed out after \d+s and was killed\. Set FORGEDOCK_CLI_TIMEOUT_MS \(ms\) to adjust, or use --backend api\.$/,
      "empty-output timeout message text must remain byte-identical to the pre-#2360 behavior",
    );
  });

  // Issue #2360: the embedded partial-output excerpt on timeout must be
  // bounded and sanitized the same way as the #2355 fix to the sibling
  // non-zero-exit branch — reusing `sanitizeOutputExcerptForLog()`, not a new
  // unsanitized/unbounded path (this file has 4 prior review findings for
  // exactly that defect class: #2277, #2292, #2293, #2355).
  it("bounds and truncates a very large partial-output excerpt on ETIMEDOUT (#2360)", () => {
    const hugeOutput = "T".repeat(10000);
    const spawnFn = () => ({
      status: null,
      signal: null,
      error: { code: "ETIMEDOUT" },
      stdout: hugeOutput,
      stderr: "",
    });

    let thrown;
    try {
      runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: "Execute: /work-on 2360",
        args: ["2360"],
        cwd: TMP,
        logger: { log: () => {} },
        bin: "claude",
        spawnFn,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "expected runCliBackend to throw on ETIMEDOUT");
    assert.ok(
      !thrown.message.includes("T".repeat(10000)),
      "message must not contain the full unbounded captured partial output",
    );
    assert.match(
      thrown.message,
      /…\[truncated, \d+ chars\]/,
      "message must contain a visible truncation marker for the bounded excerpt",
    );
  });

  // #2277: the CLI_BACKEND_FAILED diagnostic embeds `cliArgs.join(" ")`
  // (which includes `userMessage` verbatim) into the thrown Error.message,
  // and that message is later written verbatim to stderr by
  // bin/forgedock.mjs's `run-issue` case. `userMessage` is built from
  // untrusted issue/PR body content, so the diagnostic must bound length and
  // neutralize control characters — without losing the argv/cwd context
  // #2258 added (that context is what makes the diagnostic useful at all).
  it("bounds and neutralizes untrusted userMessage content in the CLI_BACKEND_FAILED diagnostic", () => {
    const hugeMessage = "\x1b[31mFAKE LOG LINE\x1b[0m\nInjected-Header: evil" + "A".repeat(5000);
    const spawnFn = () => ({ status: 1, signal: null, stdout: "", stderr: "", error: undefined });

    let thrown;
    try {
      runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: hugeMessage,
        args: ["2033"],
        cwd: TMP,
        logger: { log: () => {} },
        bin: "claude",
        spawnFn,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "expected runCliBackend to throw");
    assert.equal(thrown.code, "CLI_BACKEND_FAILED");
    // Bounded: must not contain the full 5000-char run of "A"s.
    assert.ok(
      !thrown.message.includes("A".repeat(5000)),
      "message must not contain the full unbounded userMessage",
    );
    // Neutralized: raw ESC (\x1b) and other C0 control chars must not survive.
    // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of raw control chars is the point of this test
    assert.ok(!/[\x00-\x1F\x7F]/.test(thrown.message), "message must not contain raw control characters");
    assert.match(thrown.message, /\\x1b/, "escaped ESC sequence should appear in place of the raw control char");
    // Diagnosability preserved: flags and cwd must still be visible.
    assert.match(thrown.message, /--print/);
    assert.match(thrown.message, /--dangerously-skip-permissions/);
    assert.ok(thrown.message.includes(TMP), "cwd must remain visible in the diagnostic");
  });

  it("sanitizeArgvForLog leaves short, plain argv elements unchanged", () => {
    const summary = sanitizeArgvForLog(["--print", "hello world", "--dangerously-skip-permissions"]);
    assert.equal(summary, "--print hello world --dangerously-skip-permissions");
  });

  it("sanitizeArgvForLog neutralizes Unicode bidi-override characters (#2292)", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE — could visually reorder the diagnostic
    // line in a terminal/log viewer that renders bidi controls.
    const rlo = "‮evil";
    const summary = sanitizeArgvForLog([rlo]);
    assert.ok(!/[‪-‮⁦-⁩]/.test(summary), "message must not contain a raw bidi control char");
    assert.match(summary, /\\u202e/i, "escaped RLO sequence should appear in place of the raw char");
  });

  it("sanitizeArgvForLog neutralizes Unicode bidi isolate characters (#2292)", () => {
    // U+2066 LRI / U+2069 PDI — bidi isolate pair, distinct Unicode block from
    // the override range above but same visual-spoofing threat model.
    const isolated = "⁦embedded⁩";
    const summary = sanitizeArgvForLog([isolated]);
    assert.ok(!/[‪-‮⁦-⁩]/.test(summary), "message must not contain raw bidi isolate chars");
    assert.match(summary, /\\u2066/i);
    assert.match(summary, /\\u2069/i);
  });

  it("sanitizeArgvForLog neutralizes C1 control characters (#2292)", () => {
    // U+009B CSI (C1 control range \x80-\x9F) — not covered by the original
    // C0/DEL-only regex.
    const csi = "evil";
    const summary = sanitizeArgvForLog([csi]);
    // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of raw C1 control chars is the point of this test
    assert.ok(!/[\x80-\x9F]/.test(summary), "message must not contain a raw C1 control char");
    assert.match(summary, /\\x9b/i, "escaped CSI sequence should appear in place of the raw char");
  });

  it("sanitizeArgvForLog still escapes C0/DEL exactly as before (regression guard, #2292)", () => {
    const summary = sanitizeArgvForLog(["a\tb\x1bc\x7f"]);
    assert.equal(summary, "a\\x09b\\x1bc\\x7f");
  });

  it("sanitizeArgvForLog does not split a UTF-16 surrogate pair at the truncation boundary (#2293)", () => {
    // U+1F600 GRINNING FACE is an astral-plane character represented as a
    // high+low surrogate pair in UTF-16. Position it so the pair straddles
    // the MAX_LOGGED_ARGV_ELEMENT_LEN (200) cut: 199 plain chars + the 2-unit
    // emoji = 201 units, so a naive `.slice(0, 200)` would keep the 199 chars
    // plus only the emoji's lone high surrogate.
    const emoji = String.fromCodePoint(0x1f600);
    const arg = "a".repeat(199) + emoji + "trailing content past the cut";
    const summary = sanitizeArgvForLog([arg]);
    const [truncated] = summary.split("…[truncated,");
    for (let i = 0; i < truncated.length; i++) {
      const code = truncated.charCodeAt(i);
      const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
      const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
      if (isHighSurrogate) {
        assert.ok(
          i + 1 < truncated.length && truncated.charCodeAt(i + 1) >= 0xdc00 && truncated.charCodeAt(i + 1) <= 0xdfff,
          `lone high surrogate at index ${i} — surrogate pair was split`,
        );
      }
      assert.ok(!isLowSurrogate || (i > 0 && truncated.charCodeAt(i - 1) >= 0xd800 && truncated.charCodeAt(i - 1) <= 0xdbff), `lone low surrogate at index ${i}`);
    }
    assert.match(summary, /…\[truncated, \d+ chars\]/);
  });

  it("sanitizeArgvForLog truncation marker still reports the true pre-trim length (#2293)", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const arg = "a".repeat(199) + emoji + "trailing content past the cut";
    const summary = sanitizeArgvForLog([arg]);
    assert.match(summary, new RegExp(`…\\[truncated, ${arg.length} chars\\]`));
  });

  it("defaults to the real spawnSync when spawnFn is omitted (backward compatibility)", () => {
    // No behavior assertion beyond "does not throw a TypeError from a missing
    // spawnFn" — this just confirms the default parameter wiring is correct.
    // Point `bin` at a definitely-nonexistent executable so the real
    // spawnSync fails fast via ENOENT instead of actually invoking `claude`.
    assert.throws(
      () =>
        runCliBackend({
          spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
          userMessage: "Execute: /work-on 2033",
          args: ["2033"],
          cwd: TMP,
          logger: { log: () => {} },
          bin: join(TMP, "definitely-does-not-exist-forgedock-2033"),
        }),
      /Failed to invoke claude CLI/,
    );
  });
});

// ---------------------------------------------------------------------------
// runCliBackend — token usage parsing from --output-format json (issue #2398)
//
// #2377/PR #2396 wired real per-phase usage recording for the API backend
// into bin/engine.mjs's run-log events but explicitly scoped out the CLI
// backend, which always returned `usage: null`. This closes that gap:
// runCliBackend() now requests `--output-format json` and, on a successful
// exit, parses the CLI's single-result JSON envelope for a top-level `usage`
// object. These tests use the spawnFn injection seam (issue #2033) to
// control the exact stdout the "CLI" returns, without needing a real
// fake-binary shim.
// ---------------------------------------------------------------------------

describe("runCliBackend usage parsing from --output-format json (issue #2398)", () => {
  it("requests --output-format json in cliArgs", () => {
    let capturedArgv;
    const spawnFn = (bin, argv) => {
      capturedArgv = argv;
      return { status: 0, stdout: "ok", stderr: "", error: undefined };
    };

    runCliBackend({
      spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
      userMessage: "Execute: /work-on 2398",
      args: ["2398"],
      cwd: TMP,
      logger: { log: () => {} },
      bin: "claude",
      spawnFn,
    });

    assert.ok(capturedArgv.includes("--output-format"));
    assert.equal(capturedArgv[capturedArgv.indexOf("--output-format") + 1], "json");
  });

  it("populates usage from a valid JSON envelope with a usage object", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Hi! Done.",
      usage: {
        input_tokens: 2,
        output_tokens: 31,
        cache_creation_input_tokens: 11630,
        cache_read_input_tokens: 20334,
      },
    });
    const spawnFn = () => ({ status: 0, stdout: envelope, stderr: "", error: undefined });

    const loggedLines = [];
    const result = runCliBackend({
      spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
      userMessage: "Execute: /work-on 2398",
      args: ["2398"],
      cwd: TMP,
      logger: { log: (line) => loggedLines.push(line) },
      bin: "claude",
      spawnFn,
    });

    assert.deepStrictEqual(result.usage, {
      input_tokens: 2,
      output_tokens: 31,
      cache_creation_input_tokens: 11630,
      cache_read_input_tokens: 20334,
    });
    // Human-readable `.result` string is logged, not the raw JSON blob.
    assert.ok(
      loggedLines.some((line) => line === "Hi! Done."),
      "the parsed envelope's .result string must be logged, not the raw JSON",
    );
    assert.ok(
      !loggedLines.some((line) => line.includes('"type":"result"')),
      "the raw JSON envelope must never be logged verbatim",
    );
  });

  it("normalizes a partial usage object with per-field coercion to 0 for missing fields", () => {
    // Only input_tokens/output_tokens present — no cache fields, as when
    // prompt caching is not active (mirrors the SDK's own omission behavior).
    const envelope = JSON.stringify({
      result: "done",
      usage: { input_tokens: 5, output_tokens: 10 },
    });
    const spawnFn = () => ({ status: 0, stdout: envelope, stderr: "", error: undefined });

    const result = runCliBackend({
      spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
      userMessage: "Execute: /work-on 2398",
      args: ["2398"],
      cwd: TMP,
      logger: { log: () => {} },
      bin: "claude",
      spawnFn,
    });

    assert.deepStrictEqual(result.usage, {
      input_tokens: 5,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("degrades to usage: null when the JSON envelope has no usage field", () => {
    const envelope = JSON.stringify({ type: "result", result: "done, no usage field" });
    const spawnFn = () => ({ status: 0, stdout: envelope, stderr: "", error: undefined });

    const loggedLines = [];
    const result = runCliBackend({
      spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
      userMessage: "Execute: /work-on 2398",
      args: ["2398"],
      cwd: TMP,
      logger: { log: (line) => loggedLines.push(line) },
      bin: "claude",
      spawnFn,
    });

    assert.equal(result.status, "complete");
    assert.equal(result.usage, null, "usage must degrade to null, not throw, when absent from the envelope");
    assert.ok(loggedLines.some((line) => line === "done, no usage field"));
  });

  it("degrades to usage: null when stdout is non-JSON plain text (older CLI without --output-format support)", () => {
    const plainText = "Hi! ForgeDock's loaded up and ready.";
    const spawnFn = () => ({ status: 0, stdout: plainText, stderr: "", error: undefined });

    const loggedLines = [];
    const result = runCliBackend({
      spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
      userMessage: "Execute: /work-on 2398",
      args: ["2398"],
      cwd: TMP,
      logger: { log: (line) => loggedLines.push(line) },
      bin: "claude",
      spawnFn,
    });

    assert.equal(result.status, "complete");
    assert.equal(result.usage, null, "usage must degrade to null on non-JSON output — no crash");
    // Raw output is still logged for human readability when parsing fails.
    assert.ok(loggedLines.some((line) => line === plainText));
  });

  it("degrades to usage: null on malformed/truncated JSON without throwing", () => {
    const truncated = '{"type":"result","result":"partial","usage":{"input_tok';
    const spawnFn = () => ({ status: 0, stdout: truncated, stderr: "", error: undefined });

    const result = runCliBackend({
      spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
      userMessage: "Execute: /work-on 2398",
      args: ["2398"],
      cwd: TMP,
      logger: { log: () => {} },
      bin: "claude",
      spawnFn,
    });

    assert.equal(result.status, "complete");
    assert.equal(result.usage, null);
  });

  it("non-zero exit diagnostics still operate on raw captured output, not JSON-parsed", () => {
    // The error/diagnostic path (result.status !== 0) must never attempt to
    // JSON-parse output or gate its behavior on parse success — it always
    // used raw stdout+stderr and must continue to do so unchanged.
    const rawErrorOutput = "some non-JSON crash text from an older CLI";
    const spawnFn = () => ({ status: 1, stdout: rawErrorOutput, stderr: "", error: undefined });

    let thrown;
    try {
      runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: "Execute: /work-on 2398",
        args: ["2398"],
        cwd: TMP,
        logger: { log: () => {} },
        bin: "claude",
        spawnFn,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown);
    assert.equal(thrown.code, "CLI_BACKEND_FAILED");
    assert.match(thrown.message, new RegExp(rawErrorOutput.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  // forge#2422: the success-path JSON envelope must be parsed from stdout
  // ALONE, not the combined stdout+stderr string. A zero-exit run where the
  // CLI writes non-JSON noise (deprecation banner, Node warning, etc.) to
  // stderr while still emitting a clean, valid JSON envelope on stdout must
  // still have its usage parsed — not silently degrade to null.
  it("parses usage from stdout alone even when stderr contains non-JSON noise on a zero-exit run (forge#2422)", () => {
    const envelope = JSON.stringify({
      type: "result",
      result: "Hi! Done.",
      usage: { input_tokens: 7, output_tokens: 13 },
    });
    const stderrNoise = "(node:12345) DeprecationWarning: something is deprecated\n";
    const spawnFn = () => ({ status: 0, stdout: envelope, stderr: stderrNoise, error: undefined });

    const loggedLines = [];
    const result = runCliBackend({
      spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
      userMessage: "Execute: /work-on 2422",
      args: ["2422"],
      cwd: TMP,
      logger: { log: (line) => loggedLines.push(line) },
      bin: "claude",
      spawnFn,
    });

    assert.equal(result.status, "complete");
    assert.deepStrictEqual(
      result.usage,
      {
        input_tokens: 7,
        output_tokens: 13,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      "usage must parse from stdout's clean JSON envelope, not degrade to null because of stderr noise",
    );
    // forge#2456: the stderr noise itself is no longer silently dropped from
    // the logged output — it's appended after the parsed .result text, on
    // its own line, once JSON.parse has already succeeded from stdout alone.
    assert.ok(
      loggedLines.some((line) => line === `Hi! Done.\n${stderrNoise.trim()}`),
      "the parsed .result text and the stderr noise must both be logged, in that order",
    );
  });

  // forge#2456: `runCliBackend`'s success path previously discarded any
  // non-empty stderr whenever the JSON envelope parsed with a string
  // `.result` — silently dropping warnings/banners a user would have seen in
  // the pre-#2398 raw-output behavior. Mirrors the same "combine streams
  // instead of dropping one" fix already applied to the `run_bash` tool
  // handler's success path (#1229).
  it("appends non-empty stderr after the parsed .result on a successful JSON-parse exit (forge#2456)", () => {
    const envelope = JSON.stringify({
      type: "result",
      result: "Hi! Done.",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const stderrBanner = "(node:99999) [DEP0040] DeprecationWarning: punycode is deprecated";
    const spawnFn = () => ({ status: 0, stdout: envelope, stderr: stderrBanner, error: undefined });

    const loggedLines = [];
    const result = runCliBackend({
      spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
      userMessage: "Execute: /work-on 2456",
      args: ["2456"],
      cwd: TMP,
      logger: { log: (line) => loggedLines.push(line) },
      bin: "claude",
      spawnFn,
    });

    assert.equal(result.status, "complete");
    assert.ok(
      loggedLines.some((line) => line === `Hi! Done.\n${stderrBanner}`),
      "non-empty stderr must be appended after the parsed .result text, not dropped",
    );
    assert.ok(
      !loggedLines.some((line) => line === "Hi! Done."),
      "the parsed .result text must not ALSO be logged bare when stderr was appended to it",
    );
  });

  it("logs the parsed .result unchanged (no trailing newline/whitespace) when stderr is empty on a successful JSON-parse exit (forge#2456)", () => {
    const envelope = JSON.stringify({
      type: "result",
      result: "Hi! Done.",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const spawnFn = () => ({ status: 0, stdout: envelope, stderr: "", error: undefined });

    const loggedLines = [];
    runCliBackend({
      spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
      userMessage: "Execute: /work-on 2456",
      args: ["2456"],
      cwd: TMP,
      logger: { log: (line) => loggedLines.push(line) },
      bin: "claude",
      spawnFn,
    });

    assert.ok(
      loggedLines.some((line) => line === "Hi! Done."),
      "with empty stderr, the logged line must be byte-identical to the parsed .result — no formatting change",
    );
  });

  // forge#2484 (batch #2522): `parsedResult === ""` is a valid, non-null
  // `.result` (per the `typeof parsed.result === "string"` check above), but
  // the forge#2456 composition treated "non-null" as the sole gate for
  // prefixing with `parsedResult`, producing `"" + "\n" + stderrTrimmed` — a
  // leading-newline-only artifact — whenever the envelope's `.result` was an
  // empty string and `stderr` was non-empty. Fixed: an empty `.result` now
  // falls through to the (sanitized) stderr alone, with no separator.
  it("logs stderr alone with no leading newline when .result is an empty string (forge#2484)", () => {
    const envelope = JSON.stringify({
      type: "result",
      result: "",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const stderrBanner = "some warning from the CLI";
    const spawnFn = () => ({ status: 0, stdout: envelope, stderr: stderrBanner, error: undefined });

    const loggedLines = [];
    const result = runCliBackend({
      spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
      userMessage: "Execute: /work-on 2484",
      args: ["2484"],
      cwd: TMP,
      logger: { log: (line) => loggedLines.push(line) },
      bin: "claude",
      spawnFn,
    });

    assert.equal(result.status, "complete");
    assert.ok(
      loggedLines.some((line) => line === stderrBanner),
      "with an empty .result, the logged line must be the stderr alone — no leading-newline-only artifact",
    );
    assert.ok(
      !loggedLines.some((line) => line === `\n${stderrBanner}`),
      "must never log a leading-newline-only string when .result is empty",
    );
  });

  // forge#2483 (batch #2522): the appended `stderr` on this success path is
  // untrusted subprocess output (the CLI echoes untrusted issue/PR body
  // content — the same threat class already hardened for the timeout/
  // non-zero-exit diagnostic paths via `sanitizeOutputExcerptForLog()`). It
  // must be routed through that same helper before reaching `logger.log()`,
  // rather than being concatenated raw.
  it("sanitizes control characters in appended stderr on the success path (forge#2483)", () => {
    const envelope = JSON.stringify({
      type: "result",
      result: "Hi! Done.",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    // A bell character (\x07) is a C0 control char that sanitizeOutputExcerptForLog
    // must escape to a visible \x07 form, per the same hardening applied to
    // the timeout/non-zero-exit diagnostic paths (forge#2277).
    const stderrWithControlChar = "warning: \x07 unexpected byte";
    const spawnFn = () => ({
      status: 0,
      stdout: envelope,
      stderr: stderrWithControlChar,
      error: undefined,
    });

    const loggedLines = [];
    runCliBackend({
      spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
      userMessage: "Execute: /work-on 2483",
      args: ["2483"],
      cwd: TMP,
      logger: { log: (line) => loggedLines.push(line) },
      bin: "claude",
      spawnFn,
    });

    assert.ok(
      loggedLines.some((line) => line === "Hi! Done.\nwarning: \\x07 unexpected byte"),
      "the control char in appended stderr must be escaped to a visible \\xHH form before logging",
    );
    assert.ok(
      !loggedLines.some((line) => line.includes("\x07")),
      "the raw, unescaped control char must never reach logger.log()",
    );
  });

  // forge#2424: a non-numeric usage field (e.g. a string, as an alternate/
  // future CLI JSON shape might emit) must be coerced to a safe numeric
  // value (0), never passed through raw — otherwise bin/batch-runner.mjs's
  // tokenCost() (`input + output`) would string-concatenate instead of
  // numerically add, silently corrupting the cost/run-log signal.
  it("coerces a non-numeric usage field to 0 instead of passing it through raw (forge#2424)", () => {
    const envelope = JSON.stringify({
      type: "result",
      result: "done",
      usage: {
        input_tokens: "1000", // non-numeric (string) — must not pass through raw
        output_tokens: 250,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: undefined,
      },
    });
    const spawnFn = () => ({ status: 0, stdout: envelope, stderr: "", error: undefined });

    const result = runCliBackend({
      spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
      userMessage: "Execute: /work-on 2424",
      args: ["2424"],
      cwd: TMP,
      logger: { log: () => {} },
      bin: "claude",
      spawnFn,
    });

    assert.equal(result.status, "complete");
    assert.deepStrictEqual(result.usage, {
      input_tokens: 0,
      output_tokens: 250,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    assert.equal(typeof result.usage.input_tokens, "number");
    // Downstream arithmetic (mirrors bin/batch-runner.mjs's tokenCost()) must
    // numerically add, never string-concatenate.
    assert.strictEqual(
      result.usage.input_tokens + result.usage.output_tokens,
      250,
      "coerced usage fields must add numerically, not string-concatenate",
    );
  });
});

// ---------------------------------------------------------------------------
// extractSessionLimitResetTime / CLI_BACKEND_FAILED resetAt (issue #2241)
//
// #2259/#2261 already fail-fast + terminate cleanly as "engine-error" (not
// "needs-human") for a session-limit CLI_BACKEND_FAILED — this closes the one
// remaining acceptance gap: surfacing *when* the CLI's own reported quota
// resets, instead of requiring a human to read raw logs. Deliberately narrow:
// must never fabricate a reset time for ordinary, unrelated crash output.
// ---------------------------------------------------------------------------

describe("extractSessionLimitResetTime (issue #2241)", () => {
  it("extracts the reset-time text from a genuine session-limit message", () => {
    const output = "You've hit your session limit · resets 12:50am (Asia/Calcutta)";
    assert.equal(extractSessionLimitResetTime(output), "12:50am (Asia/Calcutta)");
  });

  it("is case-insensitive and tolerates surrounding stdout/stderr noise", () => {
    const output = "some preamble\nYOU'VE HIT YOUR SESSION LIMIT · RESETS 3:00pm (UTC)\ntrailing noise";
    assert.equal(extractSessionLimitResetTime(output), "3:00pm (UTC)");
  });

  it("returns undefined for ordinary non-session-limit crash output (must not fabricate a reset time)", () => {
    const output = "Captured output (stdout+stderr):\nTypeError: cannot read property 'foo' of undefined\n    at main (/app/index.js:12:3)";
    assert.equal(extractSessionLimitResetTime(output), undefined);
  });

  it("returns undefined for empty or falsy output", () => {
    assert.equal(extractSessionLimitResetTime(""), undefined);
    assert.equal(extractSessionLimitResetTime(undefined), undefined);
  });

  it("returns undefined when the 'session limit' phrase appears without a resets clause", () => {
    const output = "session limit configuration changed — no action needed";
    assert.equal(extractSessionLimitResetTime(output), undefined);
  });

  // Security review finding (forge#2241, PR #2323): resetAt is extracted from
  // untrusted CLI stdout/stderr — the same threat model #2277/#2292/#2293
  // fixed for the neighboring argvSummary diagnostic. This asserts the fix
  // (routing resetAt through sanitizeArgvForLog) actually neutralizes control
  // chars and bidi-override sequences instead of passing them through raw.
  it("neutralizes control characters and bidi-override sequences in the captured reset-time text (security review finding)", () => {
    const output = "You've hit your session limit · resets 12:50am\x1b[31m‮evil‬";
    const resetAt = extractSessionLimitResetTime(output);
    assert.ok(resetAt, "a reset time should still be extracted");
    // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of raw control/bidi chars is the point of this test
    assert.ok(!/[\x00-\x1F\x7F-\x9F‪-‮⁦-⁩]/.test(resetAt),
      `resetAt must not contain raw control/bidi-override characters: ${JSON.stringify(resetAt)}`);
    assert.match(resetAt, /\\x1b/, "escaped ESC sequence should appear in place of the raw control char");
    assert.match(resetAt, /\\u202e/i, "escaped RLO sequence should appear in place of the raw bidi-override char");
  });

  it("caps an excessively long captured reset-time string (security review finding — no unbounded log growth)", () => {
    const output = `You've hit your session limit · resets ${"A".repeat(5000)}`;
    const resetAt = extractSessionLimitResetTime(output);
    assert.ok(resetAt, "a reset time should still be extracted");
    assert.ok(!resetAt.includes("A".repeat(5000)), "resetAt must not contain the full unbounded run of characters");
    assert.match(resetAt, /…\[truncated, \d+ chars\]/, "resetAt must carry the truncation marker for an oversized value");
  });
});

describe("runCliBackend attaches resetAt to CLI_BACKEND_FAILED on a session-limit exit (issue #2241)", () => {
  it("sets err.resetAt when the captured output reports a session-limit reset time", () => {
    const spawnFn = () => ({
      status: 1,
      signal: null,
      stdout: "You've hit your session limit · resets 12:50am (Asia/Calcutta)",
      stderr: "",
      error: undefined,
    });

    let thrown;
    try {
      runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: "Execute: /work-on 2241",
        args: ["2241"],
        cwd: TMP,
        logger: { log: () => {} },
        bin: "claude",
        spawnFn,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "runCliBackend must throw on non-zero exit");
    assert.equal(thrown.code, "CLI_BACKEND_FAILED");
    assert.equal(thrown.resetAt, "12:50am (Asia/Calcutta)");
  });

  it("leaves resetAt unset (undefined) for an ordinary non-session-limit crash — never fabricated", () => {
    const spawnFn = () => ({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "boom",
      error: undefined,
    });

    let thrown;
    try {
      runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: "Execute: /work-on 2241",
        args: ["2241"],
        cwd: TMP,
        logger: { log: () => {} },
        bin: "claude",
        spawnFn,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "runCliBackend must throw on non-zero exit");
    assert.equal(thrown.code, "CLI_BACKEND_FAILED");
    assert.equal(thrown.resetAt, undefined, "resetAt must not be set for unrelated crash output");
  });
});

// ---------------------------------------------------------------------------
// parseSessionLimitResetEpochMs (forge#2524) — turns extractSessionLimitResetTime()'s
// display string ("12:50am (Asia/Calcutta)") into a machine-usable epoch-ms
// timestamp so the engine can compute an actual wait duration. Asia/Calcutta
// is used throughout as a deterministic test fixture: it's a real IANA link
// name with a fixed +5:30 offset and no DST, so expected epoch values can be
// computed by hand without any DST-transition ambiguity.
// ---------------------------------------------------------------------------

describe("parseSessionLimitResetEpochMs (forge#2524)", () => {
  it("resolves today's occurrence when the parsed time is still in the future relative to now", () => {
    // now = 2026-01-01T04:00:00Z = 2026-01-01 09:30 IST (Asia/Calcutta, UTC+5:30)
    const nowMs = Date.UTC(2026, 0, 1, 4, 0, 0);
    const epoch = parseSessionLimitResetEpochMs("10:00am (Asia/Calcutta)", nowMs);
    // 10:00 IST on 2026-01-01 = 04:30 UTC same day — still after `nowMs`.
    assert.equal(epoch, Date.UTC(2026, 0, 1, 4, 30, 0));
  });

  it("rolls forward to tomorrow when today's occurrence of the parsed time has already passed", () => {
    // now = 2026-01-01T04:00:00Z = 2026-01-01 09:30 IST
    const nowMs = Date.UTC(2026, 0, 1, 4, 0, 0);
    const epoch = parseSessionLimitResetEpochMs("8:00am (Asia/Calcutta)", nowMs);
    // 8:00 IST today = 02:30 UTC, already before `nowMs` (04:00 UTC) — must roll to tomorrow.
    assert.equal(epoch, Date.UTC(2026, 0, 2, 2, 30, 0));
  });

  it("handles 12:00am (midnight) and 12:xxpm (noon) boundary conversions correctly", () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01 05:30 IST
    const midnight = parseSessionLimitResetEpochMs("12:00am (Asia/Calcutta)", nowMs);
    // 12:00am IST today already passed relative to 05:30 IST `now` — rolls to tomorrow midnight.
    assert.equal(midnight, Date.UTC(2026, 0, 1, 18, 30, 0)); // 2026-01-02 00:00 IST = 2026-01-01 18:30 UTC
    const noon = parseSessionLimitResetEpochMs("12:30pm (Asia/Calcutta)", nowMs);
    assert.equal(noon, Date.UTC(2026, 0, 1, 7, 0, 0)); // 12:30pm IST = 07:00 UTC, still future
  });

  it("returns undefined for unparseable reset-time text — never fabricates a value", () => {
    assert.equal(parseSessionLimitResetEpochMs("sometime soon", Date.now()), undefined);
    assert.equal(parseSessionLimitResetEpochMs("", Date.now()), undefined);
    assert.equal(parseSessionLimitResetEpochMs(undefined, Date.now()), undefined);
  });

  it("returns undefined for an out-of-range minute value", () => {
    assert.equal(parseSessionLimitResetEpochMs("10:75am (Asia/Calcutta)", Date.now()), undefined);
  });

  it("returns undefined for an out-of-range hour value instead of aliasing via modulo (forge#2560)", () => {
    // Regression: `hour % 12` previously wrapped any out-of-range hour into a
    // plausible-but-wrong in-range value (13 % 12 = 1, 99 % 12 = 3, 25 % 12 = 1)
    // instead of being rejected. Must return `undefined` for all of these.
    assert.equal(parseSessionLimitResetEpochMs("13:30pm (Asia/Calcutta)", Date.now()), undefined);
    assert.equal(parseSessionLimitResetEpochMs("99:30pm (Asia/Calcutta)", Date.now()), undefined);
    assert.equal(parseSessionLimitResetEpochMs("25:00am (Asia/Calcutta)", Date.now()), undefined);
  });

  it("returns undefined for an unrecognized IANA timezone name rather than throwing", () => {
    assert.doesNotThrow(() => parseSessionLimitResetEpochMs("10:00am (Not/AZone)", Date.now()));
    assert.equal(parseSessionLimitResetEpochMs("10:00am (Not/AZone)", Date.now()), undefined);
  });
});

describe("runCliBackend attaches resetAtEpochMs to CLI_BACKEND_FAILED on a session-limit exit (forge#2524)", () => {
  it("sets err.resetAtEpochMs to a finite future timestamp alongside err.resetAt", () => {
    const spawnFn = () => ({
      status: 1,
      signal: null,
      stdout: "You've hit your session limit · resets 11:59pm (Asia/Calcutta)",
      stderr: "",
      error: undefined,
    });

    let thrown;
    try {
      runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: "Execute: /work-on 2524",
        args: ["2524"],
        cwd: TMP,
        logger: { log: () => {} },
        bin: "claude",
        spawnFn,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "runCliBackend must throw on non-zero exit");
    assert.equal(thrown.code, "CLI_BACKEND_FAILED");
    assert.equal(thrown.resetAt, "11:59pm (Asia/Calcutta)");
    assert.equal(typeof thrown.resetAtEpochMs, "number");
    assert.ok(Number.isFinite(thrown.resetAtEpochMs));
    // Always the next occurrence of that wall-clock time — within 24h of now.
    assert.ok(thrown.resetAtEpochMs > Date.now() - 1000, "resetAtEpochMs should not be in the past");
    assert.ok(thrown.resetAtEpochMs <= Date.now() + 24 * 60 * 60 * 1000, "resetAtEpochMs should be within 24h");
  });

  it("leaves resetAtEpochMs unset for an ordinary non-session-limit crash — never fabricated", () => {
    const spawnFn = () => ({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "boom",
      error: undefined,
    });

    let thrown;
    try {
      runCliBackend({
        spec: loadCommandSpec(COMMANDS_DIR, "work-on"),
        userMessage: "Execute: /work-on 2524",
        args: ["2524"],
        cwd: TMP,
        logger: { log: () => {} },
        bin: "claude",
        spawnFn,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "runCliBackend must throw on non-zero exit");
    assert.equal(thrown.resetAt, undefined);
    assert.equal(thrown.resetAtEpochMs, undefined, "resetAtEpochMs must not be set for unrelated crash output");
  });
});

// ---------------------------------------------------------------------------
// buildCliSystemPrompt (issue #2019)
// ---------------------------------------------------------------------------

describe("buildCliSystemPrompt", () => {
  it("includes the command spec content", () => {
    const spec = loadCommandSpec(COMMANDS_DIR, "work-on");
    const prompt = buildCliSystemPrompt(spec);
    assert.match(prompt, /COMMAND SPECIFICATION \(commands\/work-on\.md\)/);
    assert.match(prompt, /# work-on spec/);
    assert.match(prompt, /Do the work\./);
  });

  it("does NOT claim the API backend's custom 3-tool loop", () => {
    const spec = loadCommandSpec(COMMANDS_DIR, "work-on");
    const prompt = buildCliSystemPrompt(spec);
    // buildSystemPrompt() (API backend) says this; buildCliSystemPrompt()
    // (CLI backend) must not, since the CLI has its own native tools.
    assert.ok(
      !prompt.includes("You have three tools to do real work"),
      "CLI system prompt must not claim the API-only read_file/write_file/run_bash loop",
    );
    assert.ok(!prompt.includes("read_file: read a file from disk"));
  });

  it("differs from buildSystemPrompt's API-flavored output for the same spec", () => {
    const spec = loadCommandSpec(COMMANDS_DIR, "work-on");
    const apiPrompt = buildSystemPrompt(spec, { repoRoot: "/tmp/repo" });
    const cliPrompt = buildCliSystemPrompt(spec);
    assert.notEqual(apiPrompt, cliPrompt);
  });
});

// ---------------------------------------------------------------------------
// Backend selection — isClaudeCliAvailable / resolveBackend (issue #2003)
// ---------------------------------------------------------------------------

describe("CLI probe output parsing", () => {
  it("keeps ordered path lines before the explicit sentinel", () => {
    const raw = `noise\r\nC:\\bin\\claude\r\n\r\nC:\\bin\\claude.cmd\r\n${CLI_PROBE_OUTPUT_SENTINEL}\r\n1.2.3`;
    assert.deepEqual(parseProbeOutput(raw), ["C:\\bin\\claude", "C:\\bin\\claude.cmd"]);
  });

  it("never treats path-like version output as a CLI candidate", () => {
    const raw = `/real/claude\n${CLI_PROBE_OUTPUT_SENTINEL}\nUpdate: https://example.test/claude.cmd`;
    assert.deepEqual(parseProbeOutput(raw), ["/real/claude"]);
  });

  it("fails closed when the sentinel is absent", () => {
    assert.deepEqual(parseProbeOutput("/real/claude\nhttps://example.test/claude.cmd"), []);
  });
});

describe("selectResolvedCliPath", () => {
  it("returns the first candidate on POSIX", () => {
    assert.equal(
      selectResolvedCliPath(["/first/claude", "/second/claude"], { platform: "linux" }),
      "/first/claude",
    );
  });

  it("prefers a spawnable Windows extension", () => {
    assert.equal(
      selectResolvedCliPath(["C:\\bin\\claude", "C:\\bin\\claude.CMD"], {
        platform: "win32",
      }),
      "C:\\bin\\claude.CMD",
    );
  });

  it("finds a spawnable sibling when all Windows candidates are extensionless", () => {
    const checked = [];
    const resolved = selectResolvedCliPath(["C:\\bin\\claude"], {
      platform: "win32",
      existsImpl(candidate) {
        checked.push(candidate);
        return candidate.toLowerCase().endsWith(".exe");
      },
    });
    assert.equal(resolved, "C:\\bin\\claude.exe");
    assert.deepEqual(checked.map((value) => value.slice(-4).toLowerCase()), [".cmd", ".exe"]);
  });
});

describe("isClaudeCliAvailable", () => {
  it("returns a boolean and never throws, regardless of whether `claude` is installed", () => {
    // Deliberately does not assert true/false — whether `claude` happens to be
    // on PATH is host-dependent. What matters (and is the whole point of the
    // function) is that it never throws and always resolves to a boolean.
    let result;
    assert.doesNotThrow(() => {
      result = isClaudeCliAvailable(TMP);
    });
    assert.equal(typeof result, "boolean");
  });

  // Per-cwd memoization (issue #2011): resolveBackend()/runCommand() call
  // isClaudeCliAvailable() unconditionally on every "auto"-backend call,
  // including every --dry-run. Without caching, a process invoking
  // runCommand() repeatedly (e.g. bin/batch-runner.mjs) re-spawns
  // `claude --version` on every single call. These tests inject a fake
  // `execImpl` via the test-seam second parameter (rather than mocking
  // `node:child_process`'s `execSync` export directly — built-in ESM modules
  // export non-configurable bindings that `node:test`'s `mock.method` cannot
  // redefine) to assert the probe is only actually invoked once per distinct
  // cwd.
  it("only spawns the probe once per cwd across repeated calls", () => {
    const execImpl = mock.fn(() => "1.2.3");
    const cwd = mkdtempSync(join(os.tmpdir(), "forgedock-cli-cache-"));
    try {
      const first = isClaudeCliAvailable(cwd, { execImpl });
      const second = isClaudeCliAvailable(cwd, { execImpl });
      const third = isClaudeCliAvailable(cwd, { execImpl });
      assert.equal(first, true);
      assert.equal(second, true);
      assert.equal(third, true);
      assert.equal(
        execImpl.mock.callCount(),
        1,
        "execImpl should only be invoked once for repeated calls with the same cwd",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("caches a negative (not-available) result too, not just a positive one", () => {
    const execImpl = mock.fn(() => {
      throw new Error("ENOENT: claude not found");
    });
    const cwd = mkdtempSync(join(os.tmpdir(), "forgedock-cli-cache-neg-"));
    try {
      const first = isClaudeCliAvailable(cwd, { execImpl });
      const second = isClaudeCliAvailable(cwd, { execImpl });
      assert.equal(first, false);
      assert.equal(second, false);
      assert.equal(
        execImpl.mock.callCount(),
        1,
        "a cached 'not available' result must not re-probe on subsequent calls",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("probes independently for different cwd values", () => {
    const execImpl = mock.fn(() => "1.2.3");
    const cwdA = mkdtempSync(join(os.tmpdir(), "forgedock-cli-cache-a-"));
    const cwdB = mkdtempSync(join(os.tmpdir(), "forgedock-cli-cache-b-"));
    try {
      isClaudeCliAvailable(cwdA, { execImpl });
      isClaudeCliAvailable(cwdB, { execImpl });
      assert.equal(
        execImpl.mock.callCount(),
        2,
        "distinct cwd values must each be probed independently, not share a cache entry",
      );
    } finally {
      rmSync(cwdA, { recursive: true, force: true });
      rmSync(cwdB, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// resolveClaudeCliBinary / probe-invocation asymmetry regression (issue #2741)
// ---------------------------------------------------------------------------
//
// Reproduces the exact bug: an environment where the CLI is only reachable
// as an npx-transient shim. The shell-based probe (`where`/`command -v`, via
// the injected execImpl) resolves and reports it available; a bare-name
// spawnSync (shell:false) would ENOENT on that same environment. Asserts
// that (a) resolveClaudeCliBinary() surfaces the resolved path rather than
// the bare name, and (b) runCliBackend(), given that resolved path as `bin`,
// succeeds even when the injected spawnFn is wired to fail on the bare
// "claude" name specifically.
describe("resolveClaudeCliBinary — probe/invocation asymmetry regression (issue #2741)", () => {
  it("resolves and caches the shell-validated absolute path, not the bare command name", () => {
    const shimPath = "/home/user/.npm/_npx/abc123/node_modules/.bin/claude";
    const execImpl = mock.fn(() => `${shimPath}\n${CLI_PROBE_OUTPUT_SENTINEL}\n1.2.3 (Claude Code)`);
    const cwd = mkdtempSync(join(os.tmpdir(), "forgedock-cli-resolve-"));
    try {
      const resolved = resolveClaudeCliBinary(cwd, {
        execImpl,
        platform: "linux",
        existsImpl: () => true,
      });
      assert.equal(resolved, shimPath);
      assert.equal(
        execImpl.mock.callCount(),
        1,
        "resolveClaudeCliBinary must reuse isClaudeCliAvailable's single-probe cache, not re-probe",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns null when the probe succeeds but no path-like line is present (e.g. a bare version string)", () => {
    const execImpl = mock.fn(() => "1.2.3");
    const cwd = mkdtempSync(join(os.tmpdir(), "forgedock-cli-resolve-nopath-"));
    try {
      assert.equal(resolveClaudeCliBinary(cwd, { execImpl }), null);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns null when the CLI is unavailable", () => {
    const execImpl = mock.fn(() => {
      throw new Error("ENOENT: claude not found");
    });
    const cwd = mkdtempSync(join(os.tmpdir(), "forgedock-cli-resolve-unavailable-"));
    try {
      assert.equal(resolveClaudeCliBinary(cwd, { execImpl }), null);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("on win32, prefers a .cmd sibling over a bare extensionless `where` match", () => {
    if (process.platform !== "win32") return; // platform-specific selection logic
    const bareShim = "C:\\Users\\dev\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\.bin\\claude";
    const cmdShim = `${bareShim}.cmd`;
    const execImpl = mock.fn(() => `${bareShim}\n${cmdShim}\n${CLI_PROBE_OUTPUT_SENTINEL}\n1.2.3 (Claude Code)`);
    const cwd = mkdtempSync(join(os.tmpdir(), "forgedock-cli-resolve-win-"));
    try {
      assert.equal(resolveClaudeCliBinary(cwd, { execImpl, existsImpl: () => true }), cmdShim);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("runCliBackend spawns the resolved path successfully when the bare name would ENOENT (the reported bug)", () => {
    const shimPath = "/home/user/.npm/_npx/abc123/node_modules/.bin/claude";
    const execImpl = mock.fn(() => `${shimPath}\n${CLI_PROBE_OUTPUT_SENTINEL}\n1.2.3 (Claude Code)`);
    const cwd = mkdtempSync(join(os.tmpdir(), "forgedock-cli-resolve-e2e-"));
    try {
      const resolvedBin = resolveClaudeCliBinary(cwd, {
        execImpl,
        platform: "linux",
        existsImpl: () => true,
      });
      assert.equal(resolvedBin, shimPath, "precondition: probe must resolve the shim path");

      // Mirrors the real-world failure: spawnFn ENOENTs on the bare "claude"
      // name (no shell/PATHEXT resolution available to a no-shell spawnSync)
      // but succeeds when given the exact resolved path.
      const spawnFn = (bin) => {
        if (bin === "claude") {
          return {
            status: null,
            signal: null,
            stdout: "",
            stderr: "",
            error: Object.assign(new Error("spawnSync claude ENOENT"), { code: "ENOENT" }),
          };
        }
        if (bin === shimPath) {
          return { status: 0, signal: null, stdout: JSON.stringify({ result: "ok" }), stderr: "" };
        }
        throw new Error(`unexpected bin: ${bin}`);
      };

      const result = runCliBackend({
        spec: { path: "x", name: "x", content: "x" },
        userMessage: "hello",
        cwd,
        bin: resolvedBin,
        spawnFn,
      });
      assert.equal(result.status, "complete");

      // Sanity: confirm the bare name really would have failed, proving this
      // test reproduces the reported ENOENT rather than trivially passing.
      assert.throws(() => {
        runCliBackend({
          spec: { path: "x", name: "x", content: "x" },
          userMessage: "hello",
          cwd,
          bin: "claude",
          spawnFn,
        });
      }, /Failed to invoke claude CLI/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refreshes a cached path once when a transient shim disappears", () => {
    const oldShim = "/tmp/npx-old/claude";
    const newShim = "/tmp/npx-new/claude";
    let probe = 0;
    let oldExists = true;
    const execImpl = mock.fn(() => {
      const path = probe++ === 0 ? oldShim : newShim;
      return `${path}\n${CLI_PROBE_OUTPUT_SENTINEL}\n1.2.3`;
    });
    const existsImpl = (candidate) => candidate === newShim || (candidate === oldShim && oldExists);
    const cwd = mkdtempSync(join(os.tmpdir(), "forgedock-cli-resolve-stale-"));
    try {
      assert.equal(resolveClaudeCliBinary(cwd, { execImpl, existsImpl }), oldShim);
      oldExists = false;
      assert.equal(resolveClaudeCliBinary(cwd, { execImpl, existsImpl }), newShim);
      assert.equal(execImpl.mock.callCount(), 2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("checkExecutionBackend", () => {
  it("uses the production-resolved CLI path in auto mode", () => {
    assert.deepEqual(checkExecutionBackend({
      resolveCliFn: () => "/bin/claude",
      spawnImpl: () => ({ status: 0 }),
    }), {
      ready: true,
      backend: "cli",
      reason: "resolved-cli",
    });
  });

  it("falls back to a configured API backend in auto mode", () => {
    assert.deepEqual(checkExecutionBackend({
      resolveCliFn: () => null,
      apiKey: "key",
      sdkAvailableFn: () => true,
    }), {
      ready: true,
      backend: "api",
      reason: "api-key-and-sdk-configured",
    });
  });

  it("fails explicit CLI and API checks instead of crossing backends", () => {
    assert.equal(checkExecutionBackend({ requested: "cli", resolveCliFn: () => null, apiKey: "key" }).ready, false);
    assert.equal(checkExecutionBackend({ requested: "api", resolveCliFn: () => "/bin/claude", apiKey: "" }).ready, false);
  });

  it("reports no usable backend when auto has neither CLI nor API key", () => {
    assert.deepEqual(checkExecutionBackend({ resolveCliFn: () => null, apiKey: "" }), {
      ready: false,
      backend: "api",
      reason: "api-key-missing",
    });
  });

  it("rejects an unspawnable resolved CLI and an API backend without its SDK", () => {
    assert.equal(checkExecutionBackend({
      requested: "cli",
      resolveCliFn: () => "claude.cmd",
      spawnImpl: () => ({ status: null, error: new Error("EINVAL") }),
    }).ready, false);
    assert.deepEqual(checkExecutionBackend({
      requested: "api",
      apiKey: "key",
      sdkAvailableFn: () => false,
    }), { ready: false, backend: "api", reason: "api-sdk-missing" });
  });
});

describe("resolveBackend", () => {
  it("returns 'cli' immediately when explicitly requested, without probing", () => {
    assert.equal(resolveBackend({ requested: "cli", cwd: TMP }), "cli");
  });

  it("returns 'api' immediately when explicitly requested, without probing", () => {
    assert.equal(resolveBackend({ requested: "api", cwd: TMP }), "api");
  });

  it("'auto' resolves to either 'cli' or 'api' based on CLI detection (never throws)", () => {
    let result;
    assert.doesNotThrow(() => {
      result = resolveBackend({ requested: "auto", cwd: TMP });
    });
    assert.ok(result === "cli" || result === "api");
  });

  it("defaults to 'auto' behavior when requested is omitted", () => {
    let result;
    assert.doesNotThrow(() => {
      result = resolveBackend({ cwd: TMP });
    });
    assert.ok(result === "cli" || result === "api");
  });

  it("throws a descriptive error for an unrecognized backend value", () => {
    assert.throws(
      () => resolveBackend({ requested: "not-a-real-backend", cwd: TMP }),
      /Invalid backend "not-a-real-backend"/,
    );
  });
});

// resolveBackendLadder — shared primitive underlying both resolveBackend()
// (above) and bin/init-enrich.mjs's resolveEnrichBackend() (issue #2026).
describe("resolveBackendLadder", () => {
  it("returns the override immediately when it is a member of validOverrides, without probing the CLI", () => {
    let probed = false;
    const result = resolveBackendLadder({
      override: "api",
      validOverrides: new Set(["cli", "api"]),
      cwd: TMP,
      isCliAvailableFn: () => {
        probed = true;
        return true;
      },
      cliFallback: () => "api",
    });
    assert.equal(result, "api");
    assert.equal(probed, false, "CLI probe must not run when an explicit override wins");
  });

  it("ignores an override that is not a member of validOverrides and falls through to probing", () => {
    const result = resolveBackendLadder({
      override: "not-a-real-backend",
      validOverrides: new Set(["cli", "api"]),
      cwd: TMP,
      isCliAvailableFn: () => true,
      cliFallback: () => "api",
    });
    assert.equal(result, "cli");
  });

  it("returns 'cli' when no override is given and the CLI is available", () => {
    const result = resolveBackendLadder({
      override: undefined,
      validOverrides: new Set(["cli", "api"]),
      cwd: TMP,
      isCliAvailableFn: () => true,
      cliFallback: () => {
        throw new Error("cliFallback must not be called when the CLI is available");
      },
    });
    assert.equal(result, "cli");
  });

  it("calls cliFallback() when no override is given and the CLI is unavailable", () => {
    let fallbackCalled = false;
    const result = resolveBackendLadder({
      override: undefined,
      validOverrides: new Set(["cli", "api"]),
      cwd: TMP,
      isCliAvailableFn: () => false,
      cliFallback: () => {
        fallbackCalled = true;
        return "api";
      },
    });
    assert.equal(result, "api");
    assert.equal(fallbackCalled, true);
  });
});

// ---------------------------------------------------------------------------
// runCommand — backend plumbing (issue #2003)
// ---------------------------------------------------------------------------

describe("runCommand backend resolution", () => {
  it("dry-run result includes a resolved backend field ('cli' or 'api')", async () => {
    const result = await runCommand({
      commandsDir: COMMANDS_DIR,
      commandName: "work-on",
      args: ["2003"],
      cwd: TMP,
      dryRun: true,
      logger: { log() {} },
    });
    assert.equal(result.status, "dry-run");
    assert.ok(result.backend === "cli" || result.backend === "api");
  });

  it("dry-run output documents which backend would run", async () => {
    const lines = [];
    await runCommand({
      commandsDir: COMMANDS_DIR,
      commandName: "work-on",
      args: ["2003"],
      cwd: TMP,
      dryRun: true,
      backend: "api",
      logger: { log: (s) => lines.push(s) },
    });
    assert.match(lines[0], /backend:\s+api/);
  });

  it("dry-run output reflects an explicit --backend cli override", async () => {
    const lines = [];
    await runCommand({
      commandsDir: COMMANDS_DIR,
      commandName: "work-on",
      args: ["2003"],
      cwd: TMP,
      dryRun: true,
      backend: "cli",
      logger: { log: (s) => lines.push(s) },
    });
    assert.match(lines[0], /backend:\s+cli/);
  });

  it("dry-run rejects an invalid backend value instead of silently ignoring it", async () => {
    await assert.rejects(
      runCommand({
        commandsDir: COMMANDS_DIR,
        commandName: "work-on",
        args: ["2003"],
        cwd: TMP,
        dryRun: true,
        backend: "not-a-real-backend",
        logger: { log() {} },
      }),
      /Invalid backend/,
    );
  });

  it("NO_API_KEY is never thrown when backend is explicitly 'cli', even with no key set", async () => {
    // This exercises the core acceptance criterion: the cli backend must not
    // require ANTHROPIC_API_KEY. runCommand's control flow returns from
    // runCliBackend() before the `if (!apiKey)` guard is ever reached when
    // resolvedBackend === "cli", so no NO_API_KEY error is reachable on this
    // path regardless of whether the `claude` CLI is actually installed.
    //
    // A tiny FORGEDOCK_CLI_TIMEOUT_MS bounds this test to a near-instant
    // timeout (real `claude --print` startup takes far longer than a few
    // milliseconds) so the test suite never spends real wall-clock time —
    // or a real Claude Code session — actually running the CLI. The only
    // assertion that matters is the *absence* of NO_API_KEY; a timeout or a
    // "claude not found" failure are both acceptable, expected outcomes here.
    const originalTimeout = process.env.FORGEDOCK_CLI_TIMEOUT_MS;
    process.env.FORGEDOCK_CLI_TIMEOUT_MS = "1";
    try {
      await runCommand({
        commandsDir: COMMANDS_DIR,
        commandName: "work-on",
        args: ["2003"],
        cwd: TMP,
        dryRun: false,
        apiKey: "",
        backend: "cli",
        logger: { log() {} },
      });
    } catch (err) {
      assert.notEqual(err.code, "NO_API_KEY");
    } finally {
      if (originalTimeout === undefined) {
        delete process.env.FORGEDOCK_CLI_TIMEOUT_MS;
      } else {
        process.env.FORGEDOCK_CLI_TIMEOUT_MS = originalTimeout;
      }
    }
  });

  // silent-flag-drop-on-backend-switch (issue #2010): model/maxIterations
  // only apply to the api backend. When the cli backend is resolved, any
  // explicitly-supplied model/maxIterations must be surfaced via a warning
  // rather than dropped with no diagnostic. The warning is logged
  // synchronously before runCliBackend() is invoked, so it is captured
  // regardless of whether the subsequent (intentionally near-instant,
  // FORGEDOCK_CLI_TIMEOUT_MS-bounded) cli invocation succeeds or throws.
  it("warns when --model and --max-iterations are explicitly supplied but backend resolves to cli", async () => {
    const originalTimeout = process.env.FORGEDOCK_CLI_TIMEOUT_MS;
    process.env.FORGEDOCK_CLI_TIMEOUT_MS = "1";
    const lines = [];
    try {
      await runCommand({
        commandsDir: COMMANDS_DIR,
        commandName: "work-on",
        args: ["2003"],
        cwd: TMP,
        dryRun: false,
        apiKey: "",
        backend: "cli",
        model: "some-model",
        maxIterations: 5,
        logger: { log: (s) => lines.push(s) },
      });
    } catch {
      // Expected — the bounded timeout/missing-CLI failure is not under test here.
    } finally {
      if (originalTimeout === undefined) {
        delete process.env.FORGEDOCK_CLI_TIMEOUT_MS;
      } else {
        process.env.FORGEDOCK_CLI_TIMEOUT_MS = originalTimeout;
      }
    }
    const warning = lines.find((l) => /ignored on the cli backend/.test(l));
    assert.ok(warning, "expected a warning about ignored options to be logged");
    assert.match(warning, /--model/);
    assert.match(warning, /--maxIterations/);
  });

  it("does not warn when model/maxIterations are only default-computed and backend resolves to cli", async () => {
    const originalTimeout = process.env.FORGEDOCK_CLI_TIMEOUT_MS;
    process.env.FORGEDOCK_CLI_TIMEOUT_MS = "1";
    const lines = [];
    try {
      await runCommand({
        commandsDir: COMMANDS_DIR,
        commandName: "work-on",
        args: ["2003"],
        cwd: TMP,
        dryRun: false,
        apiKey: "",
        backend: "cli",
        logger: { log: (s) => lines.push(s) },
      });
    } catch {
      // Expected — the bounded timeout/missing-CLI failure is not under test here.
    } finally {
      if (originalTimeout === undefined) {
        delete process.env.FORGEDOCK_CLI_TIMEOUT_MS;
      } else {
        process.env.FORGEDOCK_CLI_TIMEOUT_MS = originalTimeout;
      }
    }
    const warning = lines.find((l) => /ignored on the cli backend/.test(l));
    assert.equal(warning, undefined, "no warning expected when model/maxIterations were not explicitly supplied");
  });

  it("does not warn about ignored model/maxIterations when backend resolves to api", async () => {
    const lines = [];
    await runCommand({
      commandsDir: COMMANDS_DIR,
      commandName: "work-on",
      args: ["2003"],
      cwd: TMP,
      dryRun: true,
      backend: "api",
      model: "some-model",
      maxIterations: 5,
      logger: { log: (s) => lines.push(s) },
    });
    const warning = lines.find((l) => /ignored on the cli backend/.test(l));
    assert.equal(warning, undefined, "no cli-ignored-options warning expected on the api backend");
  });

  // Discoverability notice (issue #2020): the "auto" ladder's CLI-first
  // precedence itself is unchanged/intentional (see doc comment at the
  // notice's call site) — these tests only cover the new notice, never the
  // resolution logic (that's covered by the existing `describe("resolveBackend", ...)`
  // block above).
  describe("auto-resolved-to-cli discoverability notice (issue #2020)", () => {
    it("logs a notice when backend is left as 'auto', an API key is set, and the ladder resolves to cli", async () => {
      // Host-dependent, same discipline as isClaudeCliAvailable's own tests:
      // the notice can only fire when the ladder actually resolves to "cli"
      // on this host, which requires `claude` to be on PATH. When it isn't,
      // resolvedBackend is "api" and the entire cli-branch (including the
      // notice) is unreachable — assert its absence in that case instead,
      // so the test is deterministic either way rather than flaky.
      const cliAvailable = isClaudeCliAvailable(TMP);
      const originalTimeout = process.env.FORGEDOCK_CLI_TIMEOUT_MS;
      process.env.FORGEDOCK_CLI_TIMEOUT_MS = "1";
      const lines = [];
      try {
        await runCommand({
          commandsDir: COMMANDS_DIR,
          commandName: "work-on",
          args: ["2003"],
          cwd: TMP,
          dryRun: false,
          apiKey: "sk-test-key-present",
          backend: "auto",
          logger: { log: (s) => lines.push(s) },
        });
      } catch {
        // Expected on a CLI-available host — the bounded near-instant
        // timeout/missing-CLI failure is not under test here.
      } finally {
        if (originalTimeout === undefined) {
          delete process.env.FORGEDOCK_CLI_TIMEOUT_MS;
        } else {
          process.env.FORGEDOCK_CLI_TIMEOUT_MS = originalTimeout;
        }
      }
      const notice = lines.find((l) => /Using the claude CLI backend/.test(l));
      if (cliAvailable) {
        assert.ok(notice, "expected the discoverability notice when auto resolves to cli with an apiKey present");
        assert.match(notice, /--backend api/);
        assert.match(notice, /FORGEDOCK_BACKEND=api/);
      } else {
        assert.equal(
          notice,
          undefined,
          "no notice expected when the host has no claude CLI (ladder resolves to api, cli-branch unreachable)",
        );
      }
    });

    it("does not log the notice when backend is explicitly 'cli' (explicit choice needs no override hint)", async () => {
      const originalTimeout = process.env.FORGEDOCK_CLI_TIMEOUT_MS;
      process.env.FORGEDOCK_CLI_TIMEOUT_MS = "1";
      const lines = [];
      try {
        await runCommand({
          commandsDir: COMMANDS_DIR,
          commandName: "work-on",
          args: ["2003"],
          cwd: TMP,
          dryRun: false,
          apiKey: "sk-test-key-present",
          backend: "cli",
          logger: { log: (s) => lines.push(s) },
        });
      } catch {
        // Expected — the bounded timeout/missing-CLI failure is not under test here.
      } finally {
        if (originalTimeout === undefined) {
          delete process.env.FORGEDOCK_CLI_TIMEOUT_MS;
        } else {
          process.env.FORGEDOCK_CLI_TIMEOUT_MS = originalTimeout;
        }
      }
      const notice = lines.find((l) => /Using the claude CLI backend/.test(l));
      assert.equal(notice, undefined, "no notice expected when backend was explicitly requested as cli");
    });

    it("does not log the notice when no apiKey is set, even if auto resolves to cli", async () => {
      const cliAvailable = isClaudeCliAvailable(TMP);
      if (!cliAvailable) return; // notice's containing branch is unreachable without a CLI on PATH
      const originalTimeout = process.env.FORGEDOCK_CLI_TIMEOUT_MS;
      process.env.FORGEDOCK_CLI_TIMEOUT_MS = "1";
      const lines = [];
      try {
        await runCommand({
          commandsDir: COMMANDS_DIR,
          commandName: "work-on",
          args: ["2003"],
          cwd: TMP,
          dryRun: false,
          apiKey: "",
          backend: "auto",
          logger: { log: (s) => lines.push(s) },
        });
      } catch {
        // Expected — the bounded timeout/missing-CLI failure is not under test here.
      } finally {
        if (originalTimeout === undefined) {
          delete process.env.FORGEDOCK_CLI_TIMEOUT_MS;
        } else {
          process.env.FORGEDOCK_CLI_TIMEOUT_MS = originalTimeout;
        }
      }
      const notice = lines.find((l) => /Using the claude CLI backend/.test(l));
      assert.equal(notice, undefined, "no notice expected when no apiKey is set");
    });

    it("does not log the notice on --dry-run (dry-run already reports the resolved backend separately)", async () => {
      const lines = [];
      await runCommand({
        commandsDir: COMMANDS_DIR,
        commandName: "work-on",
        args: ["2003"],
        cwd: TMP,
        dryRun: true,
        apiKey: "sk-test-key-present",
        backend: "auto",
        logger: { log: (s) => lines.push(s) },
      });
      const notice = lines.find((l) => /Using the claude CLI backend/.test(l));
      assert.equal(notice, undefined, "no live-run notice expected during --dry-run");
    });
  });
});
