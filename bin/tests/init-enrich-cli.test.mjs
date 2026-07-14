/**
 * bin/tests/init-enrich-cli.test.mjs
 *
 * Unit tests for enrich() from bin/init-enrich-cli.mjs — the local Claude
 * Code CLI enrichment backend for `forgedock init` (issue #2004).
 *
 * All tests use the `spawnFn` dependency-injection test seam to avoid
 * depending on a real `claude` install (host-dependent, slow, non-
 * deterministic) or OS-specific executable/`.cmd`-shim fixtures.
 *
 * Covers:
 *   - Successful invocation: stdout JSON is parsed into the enriched draft
 *   - Non-zero exit status: falls back to the original draft, never throws
 *   - Timeout (ETIMEDOUT): falls back to the original draft, never throws
 *   - spawnFn throws (e.g. ENOENT — binary not found): falls back gracefully
 *   - spawnFn returns a generic error object (result.error set, no status):
 *     falls back gracefully
 *   - Malformed/prose-wrapped stdout: parseEnrichedDraft's existing
 *     extraction still applies (reused, not reimplemented)
 *   - argv is passed as a literal array (no shell string interpolation)
 *
 * Run with: node --test bin/tests/init-enrich-cli.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enrich } from "../init-enrich-cli.mjs";

// Minimal valid ConfigDraft — same shape used across init-enrich test suites.
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

const ENRICHED_DRAFT = {
  ...ORIGINAL_DRAFT,
  project: { ...ORIGINAL_DRAFT.project, name: { value: "ENRICHED", confidence: "high", source: "ai", why: "cli enrichment" } },
};

describe("init-enrich-cli enrich()", () => {
  it("parses stdout JSON into the enriched draft on success (status 0)", async () => {
    let capturedBin, capturedArgv, capturedOpts;
    const spawnFn = (bin, argv, opts) => {
      capturedBin = bin;
      capturedArgv = argv;
      capturedOpts = opts;
      return { status: 0, stdout: JSON.stringify(ENRICHED_DRAFT), stderr: "", error: undefined };
    };

    const result = await enrich(ORIGINAL_DRAFT, { cwd: "/tmp/repo", spawnFn });

    assert.equal(result.project.name.value, "ENRICHED");
    assert.equal(capturedBin, "claude");
    // argv must be a literal array — never a single interpolated shell string.
    assert.ok(Array.isArray(capturedArgv));
    assert.equal(capturedArgv[0], "--print");
    assert.equal(typeof capturedArgv[1], "string"); // the prompt message
    assert.equal(capturedArgv[2], "--dangerously-skip-permissions");
    assert.equal(capturedArgv.length, 3);
    // The prompt embeds the draft JSON as data, never as a shell command.
    assert.match(capturedArgv[1], /"owner"/);
    assert.equal(capturedOpts.cwd, "/tmp/repo");
  });

  it("falls back to the original draft on non-zero exit status, never throws", async () => {
    const spawnFn = () => ({ status: 1, stdout: "", stderr: "some CLI error", error: undefined });

    let result;
    await assert.doesNotReject(async () => {
      result = await enrich(ORIGINAL_DRAFT, { spawnFn });
    });
    assert.deepEqual(result, ORIGINAL_DRAFT);
  });

  it("falls back to the original draft on timeout (ETIMEDOUT), never throws", async () => {
    const spawnFn = () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: { code: "ETIMEDOUT", message: "timed out" },
    });

    let result;
    await assert.doesNotReject(async () => {
      result = await enrich(ORIGINAL_DRAFT, { spawnFn, timeoutMs: 1000 });
    });
    assert.deepEqual(result, ORIGINAL_DRAFT);
  });

  it("falls back to the original draft when spawnFn itself throws (e.g. binary not found)", async () => {
    const spawnFn = () => {
      throw new Error("ENOENT: spawn claude");
    };

    let result;
    await assert.doesNotReject(async () => {
      result = await enrich(ORIGINAL_DRAFT, { spawnFn });
    });
    assert.deepEqual(result, ORIGINAL_DRAFT);
  });

  it("falls back to the original draft when result.error is set (spawn-level failure)", async () => {
    const spawnFn = () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("spawn failure"),
    });

    let result;
    await assert.doesNotReject(async () => {
      result = await enrich(ORIGINAL_DRAFT, { spawnFn });
    });
    assert.deepEqual(result, ORIGINAL_DRAFT);
  });

  it("falls back to the original draft on malformed stdout (reuses parseEnrichedDraft's extraction/validation)", async () => {
    const spawnFn = () => ({ status: 0, stdout: "not valid json at all", stderr: "", error: undefined });

    const result = await enrich(ORIGINAL_DRAFT, { spawnFn });
    assert.deepEqual(result, ORIGINAL_DRAFT);
  });

  it("extracts JSON wrapped in prose from stdout (parseEnrichedDraft reuse)", async () => {
    const spawnFn = () => ({
      status: 0,
      stdout: `Here is the enriched config:\n${JSON.stringify(ENRICHED_DRAFT)}\nDone.`,
      stderr: "",
      error: undefined,
    });

    const result = await enrich(ORIGINAL_DRAFT, { spawnFn });
    assert.equal(result.project.name.value, "ENRICHED");
  });

  it("respects a custom bin override (test seam)", async () => {
    let capturedBin;
    const spawnFn = (bin) => {
      capturedBin = bin;
      return { status: 0, stdout: JSON.stringify(ORIGINAL_DRAFT), stderr: "", error: undefined };
    };

    await enrich(ORIGINAL_DRAFT, { bin: "/custom/path/claude", spawnFn });
    assert.equal(capturedBin, "/custom/path/claude");
  });
});
