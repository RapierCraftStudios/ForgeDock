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
import { spawnSync, execFileSync } from "node:child_process";
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

  it("parses agents.subagent_model (issue #1852)", () => {
    const yaml = 'agents:\n  subagent_model: "haiku"\n';
    const result = parseForgeYaml(yaml);
    assert.equal(result.agents?.subagent_model, "haiku");
  });

  it("parses agents.default_model and agents.subagent_model together (issue #1852)", () => {
    const yaml = 'agents:\n  default_model: "opus"\n  subagent_model: "haiku"\n';
    const result = parseForgeYaml(yaml);
    assert.equal(result.agents?.default_model, "opus");
    assert.equal(result.agents?.subagent_model, "haiku");
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

// =============================================================================
// session-start.mjs: nudge tracking uses resolved git root, not parent dir
// <!-- fix: forge#1927 -->
// =============================================================================
//
// Regression coverage: handleUnmanaged() previously keyed nudgeSeen/
// markNudgeSeen by the raw process.cwd(). When cwd is a parent directory that
// merely contains the real git repo as its single subdirectory (the
// "Coding Projects/AlterLab/" containing "alterlab/.git" layout — see
// bin/init-detect.mjs's resolveGitRoot), the nudge must still be tracked
// against the resolved repo root so that two independent projects sharing a
// common grandparent directory each get their own nudge-seen state.
//
// Of the two subtests below, only the second ("tracks the same project
// consistently whether cwd is the parent or the resolved repo root itself")
// actually exercises the resolveGitRoot fix — it enters the SAME repo via
// two different cwd forms and requires them to collapse to one identity,
// which only holds true with git-root resolution in place. The first
// subtest is a general sanity check for independent nudge tracking across
// distinct projects; it does not isolate the fix (see its own comment below).
//
// Runs the real session-start.mjs hook as a child process (spawnSync) against
// real temp-directory git fixtures, with HOME/USERPROFILE overridden so the
// registry.json read/write is fully isolated from the developer's real
// ~/.claude/forgedock/registry.json.

describe("session-start nudge tracking resolves git root (forge#1927)", async () => {
  let tmpDir;
  let fakeHome;
  let hookPath;

  before(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-nudge-gitroot-"));
    fakeHome = join(tmpDir, "fake-home");
    mkdirSync(fakeHome, { recursive: true });
    hookPath = join(BIN_DIR, "hooks", "session-start.mjs");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Create a non-repo parent directory containing exactly one git-repo
   * subdirectory (the resolveGitRoot single-child-parent layout).
   *
   * @param {string} parentName
   * @param {string} childRepoName
   * @returns {string} Absolute path to the parent directory (the cwd to use).
   */
  function makeParentWithSingleChildRepo(parentName, childRepoName) {
    const parentDir = join(tmpDir, parentName);
    const repoDir = join(parentDir, childRepoName);
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main", repoDir], {
      cwd: tmpDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "" },
    });
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_GLOBAL: "",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    });
    return parentDir;
  }

  function runHook(cwd) {
    return spawnSync(process.execPath, [hookPath], {
      cwd,
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    });
  }

  it("shows the nudge independently for two sibling projects under the same grandparent directory", () => {
    // Two distinct projects, each structured as a non-repo parent folder
    // holding exactly one git-repo subdirectory, both living under the same
    // grandparent tmpDir — the exact layout the issue describes.
    //
    // NOTE: This is a general sanity check, not fix-specific regression
    // coverage. "ProjectA" and "ProjectB" are already distinct raw cwd
    // paths, so this test passes under both the pre-fix (raw-cwd-keyed) and
    // post-fix (resolved-git-root-keyed) tracking strategies — it does not
    // isolate resolveGitRoot's behavior. The genuinely fix-dependent case is
    // the next test below, where the SAME repo is entered via two different
    // cwd forms.
    const projectAParent = makeParentWithSingleChildRepo("ProjectA", "alterlab");
    const projectBParent = makeParentWithSingleChildRepo("ProjectB", "otherapp");

    // First session for project A: nudge must show.
    const firstA = runHook(projectAParent);
    assert.equal(firstA.status, 0, `hook must exit 0. stderr: ${firstA.stderr}`);
    assert.match(
      firstA.stdout,
      /ForgeDock: unmanaged nudge/,
      "first run for project A must show the nudge",
    );

    // First session for project B (sibling project, same grandparent dir):
    // must ALSO show the nudge — must not be suppressed by project A's
    // already-recorded nudge-seen state.
    const firstB = runHook(projectBParent);
    assert.equal(firstB.status, 0, `hook must exit 0. stderr: ${firstB.stderr}`);
    assert.match(
      firstB.stdout,
      /ForgeDock: unmanaged nudge/,
      "first run for sibling project B must show the nudge independently of project A",
    );

    // Second session for project A: nudge must now be suppressed (already
    // recorded against A's own resolved git root).
    const secondA = runHook(projectAParent);
    assert.equal(secondA.status, 0, `hook must exit 0. stderr: ${secondA.stderr}`);
    assert.equal(
      secondA.stdout,
      "",
      "second run for project A must stay silent (nudge already recorded)",
    );

    // Second session for project B: independently suppressed too.
    const secondB = runHook(projectBParent);
    assert.equal(secondB.status, 0, `hook must exit 0. stderr: ${secondB.stderr}`);
    assert.equal(
      secondB.stdout,
      "",
      "second run for project B must stay silent (nudge already recorded)",
    );
  });

  it("tracks the same project consistently whether cwd is the parent or the resolved repo root itself (regression demo)", () => {
    // This is the precise scenario resolveGitRoot fixes: the SAME underlying
    // project can be entered either via its outer parent directory (the
    // "Coding Projects/AlterLab/" layout, one level above the actual
    // "alterlab/.git" repo) or, on another occasion, directly via the repo
    // root itself. Before this fix, nudgeSeen/markNudgeSeen keyed by the raw
    // cwd would treat these as two DIFFERENT directories and show the nudge
    // a second, spurious time for what is really the same project — because
    // resolveGitRoot(parentDir).root === repoDir === resolveGitRoot(repoDir).root,
    // both cwd forms must now collapse to one shared nudge-seen entry.
    const parentDir = makeParentWithSingleChildRepo("SharedIdentity", "the-repo");
    const repoDir = join(parentDir, "the-repo");

    // First session, entered via the outer parent directory: nudge shows.
    const viaParent = runHook(parentDir);
    assert.equal(viaParent.status, 0, `hook must exit 0. stderr: ${viaParent.stderr}`);
    assert.match(
      viaParent.stdout,
      /ForgeDock: unmanaged nudge/,
      "first run via the parent directory must show the nudge",
    );

    // Second session, entered directly via the actual repo root: must be
    // silent — it resolves to the same identity already nudged above.
    const viaRepoRoot = runHook(repoDir);
    assert.equal(viaRepoRoot.status, 0, `hook must exit 0. stderr: ${viaRepoRoot.stderr}`);
    assert.equal(
      viaRepoRoot.stdout,
      "",
      "run via the resolved repo root must stay silent — same project identity as the parent-dir run",
    );
  });
});
