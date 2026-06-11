/**
 * bin/tests/init-enrich-api.test.mjs
 *
 * Unit tests for parseEnrichedDraft from bin/init-enrich-api.mjs.
 *
 * Covers:
 *   - Extracts a plain JSON object from the output string
 *   - Extracts a JSON object wrapped in prose (preamble + postamble)
 *   - Handles braces inside JSON string values (does not stop at wrong brace)
 *   - Returns original draft for null/undefined/non-string input
 *   - Returns original draft for malformed JSON
 *   - Returns original draft when required sections are missing
 *   - Returns original draft when no '{' is found in output
 *
 * Run with: node --test bin/tests/init-enrich-api.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEnrichedDraft } from "../init-enrich-api.mjs";

// Minimal valid ConfigDraft — returned by detectConfig as the "original"
const ORIGINAL_DRAFT = {
  project: {
    owner: { value: "acme", confidence: "high", source: "git remote", why: "from remote" },
    repo: { value: "my-app", confidence: "high", source: "git remote", why: "from remote" },
    name: { value: "My App", confidence: "medium", source: "derived", why: "slug" },
  },
  paths: {
    root: { value: "/home/user/my-app", confidence: "high", source: "cwd", why: "cwd" },
    worktreeBase: { value: "/home/user/my-app/.claude/worktrees", confidence: "high", source: "derived", why: "convention" },
  },
  branches: {
    default: { value: "main", confidence: "high", source: "git", why: "remote HEAD" },
    staging: { value: "staging", confidence: "high", source: "git", why: "found remote/staging" },
  },
  meta: { remoteDetected: true },
};

/**
 * Build a minimal enriched ConfigDraft with the required top-level sections.
 * Optionally merge in extra keys.
 */
function buildEnrichedDraft(overrides = {}) {
  return {
    project: ORIGINAL_DRAFT.project,
    paths: ORIGINAL_DRAFT.paths,
    branches: ORIGINAL_DRAFT.branches,
    meta: ORIGINAL_DRAFT.meta,
    ...overrides,
  };
}

// =============================================================================
// parseEnrichedDraft
// =============================================================================

describe("parseEnrichedDraft", () => {
  // ── happy path ──────────────────────────────────────────────────────────────

  it("extracts a plain JSON object string", () => {
    const enriched = buildEnrichedDraft();
    const output = JSON.stringify(enriched);
    const result = parseEnrichedDraft(output, ORIGINAL_DRAFT);
    assert.deepEqual(result.project, enriched.project);
    assert.deepEqual(result.paths, enriched.paths);
    assert.deepEqual(result.branches, enriched.branches);
  });

  it("extracts JSON wrapped in prose preamble and postamble", () => {
    const enriched = buildEnrichedDraft({
      review: { tech_stack: { value: "Node.js 18", confidence: "medium", source: "inferred", why: "package.json" } },
    });
    const output = `Here is the enriched draft as requested:\n\n${JSON.stringify(enriched)}\n\nHope this helps!`;
    const result = parseEnrichedDraft(output, ORIGINAL_DRAFT);
    assert.equal(result.review?.tech_stack?.value, "Node.js 18");
  });

  it("handles braces inside JSON string values (balanced-brace scanner)", () => {
    // project.name contains braces that must not end the scan prematurely
    const enriched = buildEnrichedDraft();
    // Embed braces in a string value
    enriched.project = {
      ...enriched.project,
      name: { value: "Go template {.Names}", confidence: "medium", source: "test", why: "test" },
    };
    const output = JSON.stringify(enriched) + " extra } brace outside";
    const result = parseEnrichedDraft(output, ORIGINAL_DRAFT);
    // Must parse the enriched draft correctly, not the trailing brace
    assert.equal(result.project?.name?.value, "Go template {.Names}");
  });

  it("handles Windows path in JSON string values (backslash + braces)", () => {
    const enriched = buildEnrichedDraft();
    enriched.paths = {
      ...enriched.paths,
      root: { value: "C:\\Users\\user\\my-app", confidence: "high", source: "cwd", why: "cwd" },
    };
    const output = JSON.stringify(enriched);
    const result = parseEnrichedDraft(output, ORIGINAL_DRAFT);
    assert.equal(result.paths?.root?.value, "C:\\Users\\user\\my-app");
  });

  it("extracts enriched draft even when output has trailing prose containing '}'", () => {
    const enriched = buildEnrichedDraft();
    const output = JSON.stringify(enriched) + "\n\nNote: you might want to review the { curly-braced } parts.";
    const result = parseEnrichedDraft(output, ORIGINAL_DRAFT);
    // Must return the parsed draft, not fall through to ORIGINAL_DRAFT
    assert.deepEqual(result.meta, enriched.meta);
  });

  // ── fallback to original draft ───────────────────────────────────────────

  it("returns original draft for null output", () => {
    const result = parseEnrichedDraft(null, ORIGINAL_DRAFT);
    assert.equal(result, ORIGINAL_DRAFT);
  });

  it("returns original draft for undefined output", () => {
    const result = parseEnrichedDraft(undefined, ORIGINAL_DRAFT);
    assert.equal(result, ORIGINAL_DRAFT);
  });

  it("returns original draft for empty string", () => {
    const result = parseEnrichedDraft("", ORIGINAL_DRAFT);
    assert.equal(result, ORIGINAL_DRAFT);
  });

  it("returns original draft for non-string input (number)", () => {
    const result = parseEnrichedDraft(42, ORIGINAL_DRAFT);
    assert.equal(result, ORIGINAL_DRAFT);
  });

  it("returns original draft when no '{' is found in output", () => {
    const result = parseEnrichedDraft("No JSON here at all.", ORIGINAL_DRAFT);
    assert.equal(result, ORIGINAL_DRAFT);
  });

  it("returns original draft for malformed JSON", () => {
    const result = parseEnrichedDraft("{ not valid json }", ORIGINAL_DRAFT);
    assert.equal(result, ORIGINAL_DRAFT);
  });

  it("returns original draft when parsed object is missing 'project' section", () => {
    const partial = { paths: ORIGINAL_DRAFT.paths, branches: ORIGINAL_DRAFT.branches };
    const result = parseEnrichedDraft(JSON.stringify(partial), ORIGINAL_DRAFT);
    assert.equal(result, ORIGINAL_DRAFT);
  });

  it("returns original draft when parsed object is missing 'paths' section", () => {
    const partial = { project: ORIGINAL_DRAFT.project, branches: ORIGINAL_DRAFT.branches };
    const result = parseEnrichedDraft(JSON.stringify(partial), ORIGINAL_DRAFT);
    assert.equal(result, ORIGINAL_DRAFT);
  });

  it("returns original draft when parsed object is missing 'branches' section", () => {
    const partial = { project: ORIGINAL_DRAFT.project, paths: ORIGINAL_DRAFT.paths };
    const result = parseEnrichedDraft(JSON.stringify(partial), ORIGINAL_DRAFT);
    assert.equal(result, ORIGINAL_DRAFT);
  });

  it("returns original draft when output has unclosed JSON (no matching '}')", () => {
    const output = '{ "project": { "owner": "acme"'; // no closing brace
    const result = parseEnrichedDraft(output, ORIGINAL_DRAFT);
    assert.equal(result, ORIGINAL_DRAFT);
  });

  // ── edge cases ───────────────────────────────────────────────────────────

  it("preserves enriched review section when present", () => {
    const enriched = buildEnrichedDraft({
      review: {
        tech_stack: { value: "Next.js 15, FastAPI", confidence: "medium", source: "inferred", why: "description" },
        context: { value: "Multi-service monorepo", confidence: "medium", source: "inferred", why: "paths" },
      },
    });
    const result = parseEnrichedDraft(JSON.stringify(enriched), ORIGINAL_DRAFT);
    assert.equal(result.review?.tech_stack?.value, "Next.js 15, FastAPI");
    assert.equal(result.review?.context?.value, "Multi-service monorepo");
  });

  it("handles JSON with escaped double-quotes in string values", () => {
    const enriched = buildEnrichedDraft();
    enriched.project = {
      ...enriched.project,
      name: { value: 'My "Quoted" App', confidence: "medium", source: "test", why: "test" },
    };
    const output = JSON.stringify(enriched);
    const result = parseEnrichedDraft(output, ORIGINAL_DRAFT);
    assert.equal(result.project?.name?.value, 'My "Quoted" App');
  });
});
