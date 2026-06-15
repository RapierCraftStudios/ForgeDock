/**
 * bin/tests/forgedock-installer.test.mjs
 *
 * Unit tests for pure helper functions in bin/installer-helpers.mjs:
 *   - parseFrontmatter()
 *   - generateStubContent()
 *   - isForgeStub()
 *
 * Covers edge cases identified in issue #658:
 *   - BOM-prefixed files
 *   - Missing frontmatter
 *   - Empty argumentHint
 *   - Pipe characters in description
 *   - YAML special characters in argument-hint
 *
 * Run with: node --test bin/tests/forgedock-installer.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HELPERS_PATH = join(__dirname, "..", "installer-helpers.mjs");

// Import directly — no side effects, no I/O, no environment dependencies
const { STUB_MARKER, parseFrontmatter, generateStubContent, isForgeStub } =
  await import(HELPERS_PATH);

// =============================================================================
// STUB_MARKER sanity check
// =============================================================================

describe("STUB_MARKER", () => {
  it("is the expected sentinel string", () => {
    assert.equal(STUB_MARKER, "<!-- FORGEDOCK:STUB -->");
  });

  it("is unique enough to not appear in ordinary markdown prose", () => {
    const ordinaryMarkdown = `# My Command\n\nThis is a regular command spec.\n\n## Usage\n\nRun this command.\n`;
    assert.equal(ordinaryMarkdown.includes(STUB_MARKER), false);
  });
});

// =============================================================================
// parseFrontmatter
// =============================================================================

describe("parseFrontmatter — happy path", () => {
  it("extracts description and argument-hint from valid frontmatter", () => {
    const content = `---
description: Pick up a GitHub issue and run the full pipeline
argument-hint: [issue number or "next"]
---
# Body content here
`;
    const result = parseFrontmatter(content);
    assert.equal(result.description, "Pick up a GitHub issue and run the full pipeline");
    assert.equal(result.argumentHint, '[issue number or "next"]');
  });

  it("extracts description only when argument-hint is absent", () => {
    const content = `---
description: A simple command with no arguments
---
# Body
`;
    const result = parseFrontmatter(content);
    assert.equal(result.description, "A simple command with no arguments");
    assert.equal(result.argumentHint, "");
  });

  it("strips double quotes from values", () => {
    const content = `---
description: "Quoted description"
argument-hint: "[optional]"
---
`;
    const result = parseFrontmatter(content);
    assert.equal(result.description, "Quoted description");
    assert.equal(result.argumentHint, "[optional]");
  });

  it("strips single quotes from values", () => {
    const content = `---
description: 'Single-quoted description'
argument-hint: '[optional]'
---
`;
    const result = parseFrontmatter(content);
    assert.equal(result.description, "Single-quoted description");
    assert.equal(result.argumentHint, "[optional]");
  });

  it("is case-insensitive for key names", () => {
    const content = `---
Description: Case Insensitive Key
Argument-Hint: [hint]
---
`;
    const result = parseFrontmatter(content);
    assert.equal(result.description, "Case Insensitive Key");
    assert.equal(result.argumentHint, "[hint]");
  });

  it("ignores unknown frontmatter keys", () => {
    const content = `---
description: My Command
author: someone
version: 1.0.0
argument-hint: [number]
---
`;
    const result = parseFrontmatter(content);
    assert.equal(result.description, "My Command");
    assert.equal(result.argumentHint, "[number]");
  });
});

describe("parseFrontmatter — missing/malformed frontmatter", () => {
  it("returns empty strings when content has no frontmatter", () => {
    const content = `# Just a heading\n\nNo frontmatter here.\n`;
    const result = parseFrontmatter(content);
    assert.equal(result.description, "");
    assert.equal(result.argumentHint, "");
  });

  it("returns empty strings for empty string input", () => {
    const result = parseFrontmatter("");
    assert.equal(result.description, "");
    assert.equal(result.argumentHint, "");
  });

  it("returns empty strings when frontmatter opening --- is present but closing --- is absent", () => {
    const content = `---
description: Unclosed frontmatter
# No closing ---
`;
    const result = parseFrontmatter(content);
    assert.equal(result.description, "");
    assert.equal(result.argumentHint, "");
  });

  it("returns empty strings when frontmatter block is empty", () => {
    const content = `---
---
# Body
`;
    const result = parseFrontmatter(content);
    assert.equal(result.description, "");
    assert.equal(result.argumentHint, "");
  });

  it("returns empty strings when content starts with whitespace before ---", () => {
    const content = ` ---\ndescription: Leading space\n---\n`;
    const result = parseFrontmatter(content);
    assert.equal(result.description, "");
    assert.equal(result.argumentHint, "");
  });
});

describe("parseFrontmatter — BOM-prefixed files (issue #658 edge case)", () => {
  it("correctly parses BOM-prefixed content after stripping BOM", () => {
    // UTF-8 BOM is \uFEFF — Node.js readFileSync('utf-8') does not strip it automatically.
    // parseFrontmatter strips it before the startsWith check so BOM-prefixed files
    // are parsed correctly (fix from PR #657).
    const bom = "\uFEFF";
    const content = `${bom}---
description: BOM-prefixed file
---
# Body
`;
    const result = parseFrontmatter(content);
    // BOM is stripped before parsing — description should be extracted correctly
    assert.equal(result.description, "BOM-prefixed file");
    assert.equal(result.argumentHint, "");
  });

  it("correctly parses BOM-prefixed content with argument-hint after stripping BOM", () => {
    const bom = "\uFEFF";
    const content = `${bom}---
description: BOM command
argument-hint: [number]
---
# Body
`;
    const result = parseFrontmatter(content);
    assert.equal(result.description, "BOM command");
    assert.equal(result.argumentHint, "[number]");
  });
});

describe("parseFrontmatter — pipe characters in description (issue #658 edge case)", () => {
  it("handles pipe characters in description value", () => {
    const content = `---
description: Run pipeline step A | B | C
---
`;
    const result = parseFrontmatter(content);
    assert.equal(result.description, "Run pipeline step A | B | C");
  });
});

describe("parseFrontmatter — YAML special characters in argument-hint (issue #658 edge case)", () => {
  it("handles colons in argument-hint value", () => {
    const content = `---
description: My command
argument-hint: [repo:number]
---
`;
    const result = parseFrontmatter(content);
    assert.equal(result.argumentHint, "[repo:number]");
  });

  it("handles curly braces in argument-hint value", () => {
    const content = `---
description: My command
argument-hint: {issue} or next
---
`;
    const result = parseFrontmatter(content);
    assert.equal(result.argumentHint, "{issue} or next");
  });

  it("strips trailing double-quote when value ends with a double-quote (quote-strip behavior)", () => {
    // parseFrontmatter strips surrounding quotes using replace(/^["']|["']$/g, "")
    // So a value ending with " will have that trailing quote removed
    const content = `---
description: My command
argument-hint: {issue} or "next"
---
`;
    const result = parseFrontmatter(content);
    // The trailing " is stripped by the quote-stripping regex
    assert.equal(result.argumentHint, '{issue} or "next');
  });

  it("handles square brackets in argument-hint value", () => {
    const content = `---
description: My command
argument-hint: [issue number or "next" to pick highest priority]
---
`;
    const result = parseFrontmatter(content);
    assert.equal(result.argumentHint, '[issue number or "next" to pick highest priority]');
  });
});

// =============================================================================
// generateStubContent
// =============================================================================

describe("generateStubContent — output structure", () => {
  it("includes STUB_MARKER in generated content", () => {
    const content = generateStubContent(
      "work-on.md",
      "/home/user/.forgedock/commands/work-on.md",
      "Run the full pipeline",
      "",
    );
    assert.ok(content.includes(STUB_MARKER), "stub must contain STUB_MARKER");
  });

  it("includes description in frontmatter", () => {
    const content = generateStubContent(
      "work-on.md",
      "/home/user/.forgedock/commands/work-on.md",
      "Run the full pipeline",
      "",
    );
    assert.ok(content.includes("description: Run the full pipeline"), "stub must include description");
  });

  it("includes argument-hint line when argumentHint is non-empty", () => {
    const content = generateStubContent(
      "work-on.md",
      "/home/user/.forgedock/commands/work-on.md",
      "Run the full pipeline",
      "[issue number]",
    );
    assert.ok(content.includes("argument-hint: [issue number]"), "stub must include argument-hint");
  });

  it("omits argument-hint line when argumentHint is empty string (issue #658 edge case)", () => {
    const content = generateStubContent(
      "work-on.md",
      "/home/user/.forgedock/commands/work-on.md",
      "Run the full pipeline",
      "",
    );
    assert.equal(content.includes("argument-hint:"), false, "stub must not include argument-hint when empty");
  });

  it("includes the full spec path in the body", () => {
    const fullPath = "/home/user/.forgedock/commands/work-on.md";
    const content = generateStubContent("work-on.md", fullPath, "Run the full pipeline", "");
    assert.ok(content.includes(fullPath), "stub must reference the full spec path");
  });

  it("uses rel as description fallback when description is empty", () => {
    const content = generateStubContent(
      "work-on/build.md",
      "/home/user/.forgedock/commands/work-on/build.md",
      "",
      "",
    );
    assert.ok(content.includes("description: work-on/build.md"), "stub must use rel as description fallback");
  });

  it("uses forward slashes in displayed path on all platforms", () => {
    // Simulate a Windows-style path with backslashes
    const windowsPath = "C:\\Users\\user\\.claude\\commands\\work-on.md";
    const content = generateStubContent("work-on.md", windowsPath, "My command", "");
    // Backslashes must be converted to forward slashes
    assert.ok(content.includes("C:/Users/user/.claude/commands/work-on.md"), "path must use forward slashes");
    assert.equal(content.includes("\\"), false, "stub must not contain backslashes in path");
  });

  it("begins with valid frontmatter block starting with ---", () => {
    const content = generateStubContent(
      "quality-gate.md",
      "/home/user/.forgedock/commands/quality-gate.md",
      "Run quality gate",
      "[domain]",
    );
    assert.ok(content.startsWith("---\n"), "stub must start with frontmatter opening");
  });

  it("contains closing --- after frontmatter keys", () => {
    const content = generateStubContent(
      "quality-gate.md",
      "/home/user/.forgedock/commands/quality-gate.md",
      "Run quality gate",
      "[domain]",
    );
    // The frontmatter must close
    assert.ok(content.includes("\n---\n"), "stub must contain frontmatter closing ---");
  });

  it("is detectable as a stub by isForgeStub (round-trip test)", () => {
    const content = generateStubContent(
      "review-pr.md",
      "/home/user/.forgedock/commands/review-pr.md",
      "Review a pull request",
      "[PR number]",
    );
    assert.equal(isForgeStub(content), true, "generated stub must be detected by isForgeStub");
  });
});

describe("generateStubContent — special characters in inputs", () => {
  it("handles pipe characters in description without breaking frontmatter", () => {
    const content = generateStubContent(
      "orchestrate.md",
      "/home/user/.forgedock/commands/orchestrate.md",
      "Run step A | B | C",
      "",
    );
    assert.ok(content.includes("description: Run step A | B | C"));
    assert.ok(content.includes(STUB_MARKER));
  });

  it("handles colon characters in argument-hint without breaking frontmatter", () => {
    const content = generateStubContent(
      "work-on.md",
      "/home/user/.forgedock/commands/work-on.md",
      "Work on an issue",
      "[repo:number]",
    );
    assert.ok(content.includes("argument-hint: [repo:number]"));
  });

  it("handles deeply nested path for rel parameter", () => {
    const content = generateStubContent(
      "work-on/build/implement.md",
      "/home/user/.forgedock/commands/work-on/build/implement.md",
      "Implement the solution",
      "",
    );
    assert.ok(content.includes("description: Implement the solution"));
    assert.ok(content.includes(STUB_MARKER));
  });
});

// =============================================================================
// isForgeStub
// =============================================================================

describe("isForgeStub — detection", () => {
  it("returns true for content containing STUB_MARKER", () => {
    const stubContent = `---
description: My Command
---
${STUB_MARKER}

When this command is invoked, read the full spec.
`;
    assert.equal(isForgeStub(stubContent), true);
  });

  it("returns false for content without STUB_MARKER", () => {
    const userContent = `---
description: My handwritten command
---

# My Command

This is a user-authored command file that does not have the stub marker.
`;
    assert.equal(isForgeStub(userContent), false);
  });

  it("returns false for empty string", () => {
    assert.equal(isForgeStub(""), false);
  });

  it("returns false for ordinary markdown prose", () => {
    const markdown = `# Work On\n\nThis is a command that does some work.\n\n## Usage\n\nProvide an issue number.\n`;
    assert.equal(isForgeStub(markdown), false);
  });

  it("returns true for content where STUB_MARKER appears mid-file", () => {
    const content = `Some text before\n${STUB_MARKER}\nSome text after`;
    assert.equal(isForgeStub(content), true);
  });

  it("returns true for content where STUB_MARKER appears at end", () => {
    const content = `Some content\n${STUB_MARKER}`;
    assert.equal(isForgeStub(content), true);
  });

  it("returns true for content where STUB_MARKER appears at start", () => {
    const content = `${STUB_MARKER}\nsome trailing content`;
    assert.equal(isForgeStub(content), true);
  });

  it("returns false for partial STUB_MARKER string (prefix only)", () => {
    const content = `<!-- FORGEDOCK:STO -->`;
    assert.equal(isForgeStub(content), false);
  });

  it("returns false for near-match with different case", () => {
    const content = `<!-- forgedock:stub -->`;
    assert.equal(isForgeStub(content), false);
  });

  it("correctly identifies output of generateStubContent as a stub (round-trip)", () => {
    const generated = generateStubContent(
      "autopilot.md",
      "/home/user/.forgedock/commands/autopilot.md",
      "Run the autopilot self-improvement cycle",
      "[iterations]",
    );
    assert.equal(isForgeStub(generated), true, "round-trip: generated stub must be detected");
  });

  it("correctly identifies non-stub file as false (round-trip)", () => {
    const nonStubContent = `---
description: User-authored command
---
# Do stuff

Some instructions here.
`;
    assert.equal(isForgeStub(nonStubContent), false, "round-trip: user file must not be detected as stub");
  });
});
