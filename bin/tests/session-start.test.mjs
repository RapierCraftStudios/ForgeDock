/**
 * bin/tests/session-start.test.mjs
 *
 * Unit tests for parseForgeYaml and sanitizeContextValue from bin/forge-utils.mjs,
 * plus fail-open integration tests for session-start.mjs.
 *
 * Covers:
 *   - parseForgeYaml: LF and CRLF line endings, top-level scalars, sections,
 *     nested scalars, quoted values, comments, blank lines.
 *   - sanitizeContextValue: null/undefined input, control character stripping,
 *     HTML comment delimiter injection, triple backtick, heading markers,
 *     horizontal rules, single backtick bypass (fixed-point loop), maxLen cap,
 *     cwd passthrough (plain path not stripped).
 *   - session-start fail-open: missing forge-utils.mjs must not block the hook
 *     (hook must exit 0 with no stdout). <!-- fix: forge#489 -->
 *
 * Run with: node --test bin/tests/session-start.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, renameSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";
import {
  parseForgeYaml,
  sanitizeContextValue,
  resolveModelAlias,
} from "../forge-utils.mjs";

// ---------------------------------------------------------------------------
// Paths used by fail-open integration tests
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** bin/ directory of the real installation (parent of tests/) */
const BIN_DIR = resolve(__dirname, "..");

// =============================================================================
// parseForgeYaml
// =============================================================================

describe("parseForgeYaml", () => {
  it("parses a simple top-level scalar (LF)", () => {
    const yaml = 'version: 1.0.0\n';
    const result = parseForgeYaml(yaml);
    assert.equal(result.version, "1.0.0");
  });

  it("parses top-level scalars with CRLF line endings (PR #455)", () => {
    // Windows line endings must not produce trailing \r in values
    const yaml = "project:\r\n  name: ForgeDock\r\n  owner: acme\r\n";
    const result = parseForgeYaml(yaml);
    assert.equal(result.project?.name, "ForgeDock");
    assert.equal(result.project?.owner, "acme");
    // Values must not contain carriage returns
    assert.ok(!result.project?.name.includes("\r"), "name must not contain \\r");
    assert.ok(!result.project?.owner.includes("\r"), "owner must not contain \\r");
  });

  it("handles mixed LF and CRLF in the same file", () => {
    const yaml = "project:\r\n  name: TestProject\n  owner: testorg\r\n";
    const result = parseForgeYaml(yaml);
    assert.equal(result.project?.name, "TestProject");
    assert.equal(result.project?.owner, "testorg");
  });

  it("skips comment lines", () => {
    const yaml = "# this is a comment\nversion: 2.0\n# another comment\n";
    const result = parseForgeYaml(yaml);
    assert.equal(result.version, "2.0");
    assert.equal(Object.keys(result).length, 1);
  });

  it("skips blank lines", () => {
    const yaml = "\n\nversion: 3.0\n\n";
    const result = parseForgeYaml(yaml);
    assert.equal(result.version, "3.0");
  });

  it("parses section header and nested scalars", () => {
    const yaml = "project:\n  name: MyApp\n  owner: myorg\n";
    const result = parseForgeYaml(yaml);
    assert.deepEqual(result.project, { name: "MyApp", owner: "myorg" });
  });

  it("parses quoted top-level scalar values", () => {
    const yaml = 'description: "My Project"\n';
    const result = parseForgeYaml(yaml);
    assert.equal(result.description, "My Project");
  });

  it("parses quoted nested scalar values", () => {
    const yaml = "project:\n  description: \"Autonomous pipeline\"\n";
    const result = parseForgeYaml(yaml);
    assert.equal(result.project?.description, "Autonomous pipeline");
  });

  it("parses multiple sections independently", () => {
    const yaml = "project:\n  owner: a\npaths:\n  root: /some/path\n";
    const result = parseForgeYaml(yaml);
    assert.equal(result.project?.owner, "a");
    assert.equal(result.paths?.root, "/some/path");
  });

  it("top-level scalar after a section resets the section context", () => {
    const yaml = "project:\n  name: A\nversion: 1.0\n";
    const result = parseForgeYaml(yaml);
    // version must be a top-level string, not nested under project
    assert.equal(typeof result.version, "string");
    assert.equal(result.version, "1.0");
  });

  it("inline comment after value is stripped", () => {
    const yaml = "owner: myorg # inline comment\n";
    const result = parseForgeYaml(yaml);
    assert.equal(result.owner, "myorg");
  });

  it("returns empty object for empty string", () => {
    const result = parseForgeYaml("");
    assert.deepEqual(result, {});
  });

  it("returns empty object for comment-only content", () => {
    const result = parseForgeYaml("# just a comment\n");
    assert.deepEqual(result, {});
  });

  it("handles Windows path values without backslash corruption", () => {
    const yaml = "paths:\n  root: C:\\Users\\user\\project\n";
    const result = parseForgeYaml(yaml);
    assert.ok(result.paths?.root.includes("C:"), "Windows path should be preserved");
  });

  it("parses agents.default_model (issue #1851)", () => {
    const yaml = 'agents:\n  default_model: "opus"\n';
    const result = parseForgeYaml(yaml);
    assert.equal(result.agents?.default_model, "opus");
  });
});

// =============================================================================
// resolveModelAlias (issue #1851 — forge.yaml agents.default_model)
// =============================================================================

describe("resolveModelAlias", () => {
  it("returns null for null input", () => {
    assert.equal(resolveModelAlias(null), null);
  });

  it("returns null for undefined input", () => {
    assert.equal(resolveModelAlias(undefined), null);
  });

  it("returns null for an empty/whitespace-only string", () => {
    assert.equal(resolveModelAlias(""), null);
    assert.equal(resolveModelAlias("   "), null);
  });

  it("resolves the 'sonnet' alias to a full model ID", () => {
    assert.equal(resolveModelAlias("sonnet"), "claude-sonnet-5");
  });

  it("resolves the 'opus' alias to a full model ID", () => {
    assert.equal(resolveModelAlias("opus"), "claude-opus-4-6");
  });

  it("resolves the 'haiku' alias to a full model ID", () => {
    assert.equal(resolveModelAlias("haiku"), "claude-haiku-4-5");
  });

  it("is case-insensitive", () => {
    assert.equal(resolveModelAlias("OPUS"), "claude-opus-4-6");
    assert.equal(resolveModelAlias("Sonnet"), "claude-sonnet-5");
  });

  it("passes through an unrecognized value unchanged (e.g. a full model ID)", () => {
    assert.equal(resolveModelAlias("claude-opus-4-6"), "claude-opus-4-6");
    assert.equal(resolveModelAlias("some-future-model"), "some-future-model");
  });

  it("trims surrounding whitespace before resolving", () => {
    assert.equal(resolveModelAlias("  opus  "), "claude-opus-4-6");
  });
});

// =============================================================================
// sanitizeContextValue
// =============================================================================

describe("sanitizeContextValue", () => {
  it("returns null for null input", () => {
    assert.equal(sanitizeContextValue(null, 200), null);
  });

  it("returns null for undefined input", () => {
    assert.equal(sanitizeContextValue(undefined, 200), null);
  });

  it("returns null for empty string after trimming", () => {
    assert.equal(sanitizeContextValue("   ", 200), null);
  });

  it("passes through a clean string unchanged", () => {
    assert.equal(sanitizeContextValue("ForgeDock", 200), "ForgeDock");
  });

  it("strips control characters (C0 block)", () => {
    // \x01 through \x1F are all control chars
    const result = sanitizeContextValue("hello\x00world\x07\x1F", 200);
    assert.equal(result, "helloworld");
  });

  it("strips DEL (U+007F) and C1 block (U+0080-U+009F)", () => {
    const result = sanitizeContextValue("a\x7Fb\x80c\x9Fd", 200);
    assert.equal(result, "abcd");
  });

  it("strips carriage return and newline (injected by CRLF values)", () => {
    const result = sanitizeContextValue("line1\r\nline2\nline3", 500);
    assert.equal(result, "line1line2line3");
  });

  it("strips HTML comment open delimiter", () => {
    const result = sanitizeContextValue("<!-- inject", 200);
    assert.ok(!result?.includes("<!--"), "should not contain <!--");
  });

  it("strips HTML comment close delimiter (-->)", () => {
    const result = sanitizeContextValue("inject -->", 200);
    assert.ok(!result?.includes("-->"), "should not contain -->");
  });

  it("strips alternate HTML comment close (--!>)", () => {
    const result = sanitizeContextValue("inject --!>", 200);
    assert.ok(!result?.includes("--!>"), "should not contain --!>");
  });

  it("strips triple backtick fenced code block markers", () => {
    const result = sanitizeContextValue("```bash\necho hi\n```", 200);
    assert.ok(!result?.includes("```"), "should not contain ```");
  });

  it("strips single backticks (PR #443 — fixed-point loop)", () => {
    const result = sanitizeContextValue("`value`", 200);
    assert.ok(!result?.includes("`"), "should not contain backtick");
    assert.equal(result, "value");
  });

  it("strips single backtick that would terminate an inline-code span", () => {
    // A value like 'staging`; rm -rf /' would terminate the span
    const result = sanitizeContextValue("staging`; rm -rf /", 200);
    assert.ok(!result?.includes("`"), "backtick must be stripped");
    assert.equal(result, "staging; rm -rf /");
  });

  it("handles fixed-point bypass: adjacent fragments that re-form a token", () => {
    // '<!<!---->--' → first pass strips '<!--' leaving '<!---->', next pass strips '-->'
    // The fixed-point loop must handle this
    const malicious = "<!<!---->-->";
    const result = sanitizeContextValue(malicious, 200);
    assert.ok(!result?.includes("<!--"), "should not contain <!-- after fixed-point");
    assert.ok(!result?.includes("-->"), "should not contain --> after fixed-point");
  });

  it("strips leading markdown heading markers", () => {
    const result = sanitizeContextValue("## Injected Heading", 200);
    assert.ok(!result?.startsWith("#"), "should not start with #");
    assert.equal(result, "Injected Heading");
  });

  it("strips leading horizontal rule", () => {
    const result = sanitizeContextValue("---\nContent", 200);
    assert.ok(!result?.startsWith("---"), "should not start with ---");
  });

  it("applies maxLen cap after stripping", () => {
    const result = sanitizeContextValue("abcdefghij", 5);
    assert.equal(result, "abcde");
  });

  it("trims leading and trailing whitespace", () => {
    const result = sanitizeContextValue("  hello  ", 200);
    assert.equal(result, "hello");
  });

  it("coerces non-string values to string", () => {
    // Number input should not throw
    const result = sanitizeContextValue(42, 200);
    assert.equal(result, "42");
  });

  it("passes through a clean cwd-like path (PR #465)", () => {
    // sanitizeContextValue is used on process.cwd() — must not strip normal paths
    const cwd = "/home/user/projects/my-app";
    const result = sanitizeContextValue(cwd, 500);
    assert.equal(result, cwd);
  });

  it("passes through Windows path (backslash not stripped)", () => {
    const winPath = "C:\\Users\\user\\project";
    const result = sanitizeContextValue(winPath, 500);
    assert.ok(result?.includes("C:"), "Windows drive should be preserved");
    assert.ok(result?.includes("user"), "path components should be preserved");
  });

  it("returns null when result is empty after stripping", () => {
    // Input is only backticks — after strip, empty string
    const result = sanitizeContextValue("```", 200);
    assert.equal(result, null);
  });

  it("never throws on unexpected input types", () => {
    assert.doesNotThrow(() => sanitizeContextValue({}, 100));
    assert.doesNotThrow(() => sanitizeContextValue([], 100));
    assert.doesNotThrow(() => sanitizeContextValue(true, 100));
  });
});

// =============================================================================
// session-start.mjs fail-open: missing forge-utils.mjs
// <!-- fix: forge#489 -->
// =============================================================================

describe("session-start fail-open when forge-utils.mjs is missing", async () => {
  let tmpBinDir;
  let tmpHooksDir;
  let hookPath;

  before(() => {
    // Create a temporary copy of the bin/ directory so we can rename
    // forge-utils.mjs without touching the real installation.
    tmpBinDir = mkdtempSync(join(os.tmpdir(), "forge-failopen-utils-"));
    // Copy bin/ tree: hooks/, registry.mjs, forge-utils.mjs, init-detect.mjs, etc.
    cpSync(BIN_DIR, tmpBinDir, { recursive: true });
    tmpHooksDir = join(tmpBinDir, "hooks");
    hookPath = join(tmpHooksDir, "session-start.mjs");

    // Rename forge-utils.mjs to simulate a missing module
    renameSync(
      join(tmpBinDir, "forge-utils.mjs"),
      join(tmpBinDir, "forge-utils.mjs.bak"),
    );
  });

  after(() => {
    rmSync(tmpBinDir, { recursive: true, force: true });
  });

  it("exits 0 when forge-utils.mjs is missing (fail-open contract)", () => {
    // Run the hook with node --input-type=module so we can pass a file: URL.
    // We spawn the hook directly; Claude Code's working directory is set to
    // a temp dir (unmanaged) so there's no forge.yaml or .forgedock marker.
    const result = spawnSync(
      process.execPath,
      [hookPath],
      {
        cwd: os.tmpdir(),
        encoding: "utf-8",
        timeout: 10000,
        env: { ...process.env },
      },
    );
    assert.equal(
      result.status,
      0,
      `Hook must exit 0 when forge-utils.mjs is missing. ` +
        `Got exit code ${result.status}. stderr: ${result.stderr}`,
    );
  });

  it("produces no stdout when forge-utils.mjs is missing", () => {
    const result = spawnSync(
      process.execPath,
      [hookPath],
      {
        cwd: os.tmpdir(),
        encoding: "utf-8",
        timeout: 10000,
        env: { ...process.env },
      },
    );
    assert.equal(
      result.stdout,
      "",
      `Hook must produce no stdout when forge-utils.mjs is missing. ` +
        `Got: ${JSON.stringify(result.stdout)}`,
    );
  });
});
