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
  runCommand,
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

  it("read_file rejects a symlinked file that resolves outside cwd (SEC: symlink escape)", () => {
    const symlinkTmp = mkdtempSync(join(os.tmpdir(), "forgedock-symlink-src-"));
    const outsideSecret = join(symlinkTmp, "secret.txt");
    writeFileSync(outsideSecret, "outside-cwd-secret");

    const handlers = getToolHandlers(TMP);
    const linkPath = join(TMP, "evil-link.txt");
    symlinkSync(outsideSecret, linkPath);
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

  it("write_file rejects a target inside a symlinked directory that resolves outside cwd (SEC: symlink escape)", () => {
    const symlinkTmp = mkdtempSync(join(os.tmpdir(), "forgedock-symlink-dst-"));

    const handlers = getToolHandlers(TMP);
    const linkDir = join(TMP, "evil-link-dir");
    symlinkSync(symlinkTmp, linkDir);
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
      model: "claude-sonnet-4-5",
      maxIterations: 50,
    });
    assert.match(out, /\/work-on/);
    assert.match(out, /claude-sonnet-4-5/);
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

  it("throws NO_API_KEY for a live run with no key", async () => {
    await assert.rejects(
      runCommand({
        commandsDir: COMMANDS_DIR,
        commandName: "work-on",
        args: ["1151"],
        cwd: TMP,
        dryRun: false,
        apiKey: "",
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
});
