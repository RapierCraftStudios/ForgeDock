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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  resolveSpecPath,
  listCommands,
  loadCommandSpec,
  buildSystemPrompt,
  buildUserMessage,
  TOOL_DEFINITIONS,
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

  it("rejects path traversal", () => {
    assert.equal(resolveSpecPath(COMMANDS_DIR, "../secrets"), null);
    assert.equal(resolveSpecPath(COMMANDS_DIR, "work-on/../../etc/passwd"), null);
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

  it("handlers validate required input", () => {
    const handlers = getToolHandlers(TMP);
    assert.throws(() => handlers.read_file({}), /requires a 'path'/);
    assert.throws(() => handlers.write_file({ content: "x" }), /requires a 'path'/);
    assert.throws(() => handlers.run_bash({}), /requires a 'command'/);
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
