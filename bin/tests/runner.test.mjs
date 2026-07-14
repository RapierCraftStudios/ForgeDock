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

import { describe, it, before, after } from "node:test";
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
  resolveBackend,
  runCliBackend,
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
    // ("--dangerously-skip-permissions") as an unrecognized flag and exits
    // non-zero — which is itself strong affirmative evidence of correct argv
    // separation: the parser named that exact 3rd token as the "bad option"
    // *distinct* from the 2nd (message) token, proving all three array
    // elements arrived as separate, unmangled OS-level argv entries rather
    // than being concatenated/re-tokenized by an intermediate shell. The
    // decisive assertion, though, is simpler and platform-independent: the
    // injection payload's side effect (creating a marker file via $(...))
    // must never occur, because runCliBackend never hands the message to a
    // shell in the first place.
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
    assert.match(output, /--dangerously-skip-permissions/);
  });
});

// ---------------------------------------------------------------------------
// Backend selection — isClaudeCliAvailable / resolveBackend (issue #2003)
// ---------------------------------------------------------------------------

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
});
