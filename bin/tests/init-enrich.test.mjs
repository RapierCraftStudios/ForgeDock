/**
 * bin/tests/init-enrich.test.mjs
 *
 * Unit tests for the enrichment backend selection ladder in
 * bin/init-enrich.mjs (issue #2004): resolveEnrichBackend() and enrich().
 *
 * Covers:
 *   - CLI available, no API key → "cli"
 *   - CLI available AND API key set → "cli" (CLI takes priority)
 *   - CLI unavailable, API key set → "api"
 *   - Neither available → "none"
 *   - enrich() dispatches to the resolved backend and never throws
 *   - enrich() accepts a pre-resolved `backend` to skip re-probing
 *   - FORGEDOCK_INIT_BACKEND override (issue #2023): explicit "cli"/"api"/
 *     "none" wins over the auto ladder; "auto"/unset/invalid falls through
 *     to the unchanged ladder behavior above
 *
 * Run with: node --test bin/tests/init-enrich.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveEnrichBackend, enrich } from "../init-enrich.mjs";

const DRAFT = {
  project: { owner: { value: "acme", confidence: "high", source: "git", why: "x" } },
  paths: {},
  branches: {},
  meta: {},
};

describe("resolveEnrichBackend", () => {
  it("returns 'cli' when the CLI is available and no API key is set", () => {
    const backend = resolveEnrichBackend({
      env: {},
      isCliAvailableFn: () => true,
    });
    assert.equal(backend, "cli");
  });

  it("returns 'cli' when both the CLI and API key are available (cli takes priority)", () => {
    const backend = resolveEnrichBackend({
      env: { ANTHROPIC_API_KEY: "test-key" },
      isCliAvailableFn: () => true,
    });
    assert.equal(backend, "cli");
  });

  it("returns 'api' when the CLI is unavailable but an API key is set", () => {
    const backend = resolveEnrichBackend({
      env: { ANTHROPIC_API_KEY: "test-key" },
      isCliAvailableFn: () => false,
    });
    assert.equal(backend, "api");
  });

  it("returns 'none' when neither the CLI nor an API key is available", () => {
    const backend = resolveEnrichBackend({
      env: {},
      isCliAvailableFn: () => false,
    });
    assert.equal(backend, "none");
  });

  it("never throws regardless of isCliAvailableFn/env combination", () => {
    assert.doesNotThrow(() => {
      resolveEnrichBackend({ env: {}, isCliAvailableFn: () => false });
    });
  });
});

describe("resolveEnrichBackend — FORGEDOCK_INIT_BACKEND override (issue #2023)", () => {
  it("FORGEDOCK_INIT_BACKEND=api forces the api backend even when the CLI is available", () => {
    const backend = resolveEnrichBackend({
      env: { FORGEDOCK_INIT_BACKEND: "api", ANTHROPIC_API_KEY: "test-key" },
      isCliAvailableFn: () => true,
    });
    assert.equal(backend, "api");
  });

  it("FORGEDOCK_INIT_BACKEND=cli forces the cli backend even when only an API key is set", () => {
    const backend = resolveEnrichBackend({
      env: { FORGEDOCK_INIT_BACKEND: "cli", ANTHROPIC_API_KEY: "test-key" },
      isCliAvailableFn: () => false,
    });
    assert.equal(backend, "cli");
  });

  it("FORGEDOCK_INIT_BACKEND=none skips enrichment regardless of CLI/key availability", () => {
    const backend = resolveEnrichBackend({
      env: { FORGEDOCK_INIT_BACKEND: "none", ANTHROPIC_API_KEY: "test-key" },
      isCliAvailableFn: () => true,
    });
    assert.equal(backend, "none");
  });

  it("FORGEDOCK_INIT_BACKEND=auto preserves the unchanged ladder (cli takes priority)", () => {
    const backend = resolveEnrichBackend({
      env: { FORGEDOCK_INIT_BACKEND: "auto", ANTHROPIC_API_KEY: "test-key" },
      isCliAvailableFn: () => true,
    });
    assert.equal(backend, "cli");
  });

  it("unset FORGEDOCK_INIT_BACKEND preserves the unchanged ladder", () => {
    const backend = resolveEnrichBackend({
      env: { ANTHROPIC_API_KEY: "test-key" },
      isCliAvailableFn: () => false,
    });
    assert.equal(backend, "api");
  });

  it("an invalid FORGEDOCK_INIT_BACKEND value falls back to the ladder rather than throwing", () => {
    assert.doesNotThrow(() => {
      const backend = resolveEnrichBackend({
        env: { FORGEDOCK_INIT_BACKEND: "bogus", ANTHROPIC_API_KEY: "test-key" },
        isCliAvailableFn: () => false,
      });
      assert.equal(backend, "api");
    });
  });
});

describe("enrich (ladder dispatcher)", () => {
  it("dispatches to the cli backend when resolved backend is 'cli'", async () => {
    // Injects spawnFn through the ladder so this test never shells out to a
    // real `claude` binary (which may genuinely be installed and
    // authenticated in this environment) — deterministic, no live-CLI
    // side effects.
    let spawnFnCalled = false;
    const result = await enrich(DRAFT, {
      backend: "cli",
      cwd: "/tmp/repo",
      spawnFn: () => {
        spawnFnCalled = true;
        return { status: 0, stdout: JSON.stringify(DRAFT), stderr: "", error: undefined };
      },
    });
    assert.equal(spawnFnCalled, true);
    assert.equal(typeof result, "object");
    assert.ok(result !== null);
  });

  it("dispatches to the api backend when resolved backend is 'api' (no key → falls back to original draft, never throws)", async () => {
    const result = await enrich(DRAFT, { backend: "api" });
    // No ANTHROPIC_API_KEY in the test process env → init-enrich-api's
    // enrich() returns the original draft unchanged.
    assert.deepEqual(result, DRAFT);
  });

  it("returns the original draft unchanged when resolved backend is 'none'", async () => {
    const result = await enrich(DRAFT, { backend: "none" });
    assert.deepEqual(result, DRAFT);
  });

  it("resolves the backend internally when opts.backend is omitted", async () => {
    const result = await enrich(DRAFT, {
      env: {},
      isCliAvailableFn: () => false,
    });
    // Neither cli nor api available → original draft unchanged.
    assert.deepEqual(result, DRAFT);
  });
});
