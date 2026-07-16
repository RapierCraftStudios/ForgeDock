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
 *   - spawnFn is never invoked with a truthy `shell` option (issue #2031 —
 *     regression guard: even though spawnFn is fully mocked, these
 *     assertions still fail if a future change reintroduces `shell: true`)
 *   - Oversized ConfigDraft JSON is rejected before spawn, never spawns
 *     (issue #2016)
 *   - Failure warnings never leak raw error detail (e.g. local paths) into
 *     the unconditional (non-FORGEDOCK_DEBUG) stderr line (issue #2017)
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
    // Read-only enforcement: --allowedTools/--disallowedTools, NEVER
    // --dangerously-skip-permissions (issue #2022 — the prose "MUST NOT
    // modify files" instruction alone is not enforcement).
    assert.equal(capturedArgv[2], "--allowedTools");
    assert.equal(capturedArgv[3], "Read Glob Grep LS");
    assert.equal(capturedArgv[4], "--disallowedTools");
    assert.equal(capturedArgv[5], "Write Edit NotebookEdit Bash");
    assert.equal(capturedArgv.length, 6);
    assert.ok(!capturedArgv.includes("--dangerously-skip-permissions"));
    // The prompt embeds the draft JSON as data, never as a shell command.
    assert.match(capturedArgv[1], /"owner"/);
    assert.equal(capturedOpts.cwd, "/tmp/repo");
    // Regression guard (issue #2031): spawnFn is fully mocked in this suite,
    // so nothing else here would catch a future `shell: true` reintroduction
    // — this assertion inspects the actual opts object the mock received.
    assert.notEqual(
      capturedOpts.shell,
      true,
      "must never invoke spawnFn with shell:true (shell-injection guard — issue #2031)",
    );
  });

  it("never passes a truthy `shell` option to spawnFn (issue #2031 — dedicated shell:true regression guard)", async () => {
    let capturedOpts;
    const spawnFn = (bin, argv, opts) => {
      capturedOpts = opts;
      return { status: 0, stdout: JSON.stringify(ENRICHED_DRAFT), stderr: "", error: undefined };
    };

    await enrich(ORIGINAL_DRAFT, { spawnFn });

    assert.ok(
      !capturedOpts.shell,
      "spawnFn opts.shell must be falsy — argv elements must never be re-parsed by a shell",
    );
  });

  it("scrubs ANTHROPIC_API_KEY from the env passed to spawnFn while preserving other vars (issue #2021)", async () => {
    let capturedOpts;
    const spawnFn = (bin, argv, opts) => {
      capturedOpts = opts;
      return { status: 0, stdout: JSON.stringify(ENRICHED_DRAFT), stderr: "", error: undefined };
    };

    const fakeEnv = { ANTHROPIC_API_KEY: "sk-ant-should-not-leak", GH_TOKEN: "gh-token-should-survive" };
    await enrich(ORIGINAL_DRAFT, { spawnFn, env: fakeEnv });

    assert.ok(capturedOpts.env, "spawnFn must receive an env option");
    assert.equal(
      capturedOpts.env.ANTHROPIC_API_KEY,
      undefined,
      "ANTHROPIC_API_KEY must not be present in the env passed to spawnFn",
    );
    assert.equal(
      capturedOpts.env.GH_TOKEN,
      "gh-token-should-survive",
      "unrelated env vars must still be forwarded — this must be a targeted scrub, not env: {}",
    );
    // The injected `env` opt must not be the SAME identity as spawnFn's
    // received env, and must not have been mutated in place — a shallow copy,
    // not a mutation of the caller-owned object.
    assert.equal(fakeEnv.ANTHROPIC_API_KEY, "sk-ant-should-not-leak");
  });

  it("defaults env to process.env when opts.env is not supplied", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak-default";
    let capturedOpts;
    const spawnFn = (bin, argv, opts) => {
      capturedOpts = opts;
      return { status: 0, stdout: JSON.stringify(ENRICHED_DRAFT), stderr: "", error: undefined };
    };

    try {
      await enrich(ORIGINAL_DRAFT, { spawnFn });
      assert.equal(capturedOpts.env.ANTHROPIC_API_KEY, undefined);
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
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

  it("falls back to the original draft without spawning when the ConfigDraft JSON exceeds the argv size guard (issue #2016)", async () => {
    // A huge tech_stack array forces buildEnrichPrompt()'s output well past
    // the 256KB default (FORGEDOCK_CLI_ENRICH_MAX_PROMPT_BYTES) guard.
    const HUGE_DRAFT = {
      ...ORIGINAL_DRAFT,
      review: {
        tech_stack: {
          value: Array.from({ length: 20000 }, (_, i) => `framework-${i}-padding-padding`),
          confidence: "low",
          source: "test",
          why: "oversized fixture",
        },
      },
    };

    let spawnCalled = false;
    const spawnFn = () => {
      spawnCalled = true;
      return { status: 0, stdout: JSON.stringify(ENRICHED_DRAFT), stderr: "", error: undefined };
    };

    const result = await enrich(HUGE_DRAFT, { spawnFn });

    assert.equal(spawnCalled, false, "spawnFn must never be called for an oversized ConfigDraft");
    assert.deepEqual(result, HUGE_DRAFT);
  });

  it("respects FORGEDOCK_CLI_ENRICH_MAX_PROMPT_BYTES override for the argv size guard (issue #2016)", async () => {
    const origLimit = process.env.FORGEDOCK_CLI_ENRICH_MAX_PROMPT_BYTES;
    process.env.FORGEDOCK_CLI_ENRICH_MAX_PROMPT_BYTES = "10"; // tiny — any real prompt exceeds this
    let spawnCalled = false;
    const spawnFn = () => {
      spawnCalled = true;
      return { status: 0, stdout: JSON.stringify(ENRICHED_DRAFT), stderr: "", error: undefined };
    };

    try {
      const result = await enrich(ORIGINAL_DRAFT, { spawnFn });
      assert.equal(spawnCalled, false, "spawnFn must not be called once the override shrinks the limit below the prompt size");
      assert.deepEqual(result, ORIGINAL_DRAFT);
    } finally {
      if (origLimit === undefined) delete process.env.FORGEDOCK_CLI_ENRICH_MAX_PROMPT_BYTES;
      else process.env.FORGEDOCK_CLI_ENRICH_MAX_PROMPT_BYTES = origLimit;
    }
  });

  it("does not leak raw error detail (e.g. local paths) into the unconditional stderr line on spawnFn throw (issue #2017)", async () => {
    const spawnFn = () => {
      throw new Error("ENOENT: spawn /Users/someone/secret-local-path/claude");
    };

    const origErrorLog = console.error;
    const loggedLines = [];
    console.error = (...args) => loggedLines.push(args.join(" "));

    try {
      const result = await enrich(ORIGINAL_DRAFT, { spawnFn });
      assert.deepEqual(result, ORIGINAL_DRAFT);
    } finally {
      console.error = origErrorLog;
    }

    // FORGEDOCK_DEBUG is not set in this test — only the generic, path-free
    // category line should have been logged.
    assert.ok(loggedLines.length >= 1, "warn() must log at least the unconditional summary line");
    const joined = loggedLines.join("\n");
    assert.ok(
      !joined.includes("secret-local-path"),
      "the raw error message (which can contain local paths) must not appear unconditionally in stderr",
    );
  });

  it("does not leak raw error detail into the unconditional stderr line when result.error is set (issue #2017)", async () => {
    const spawnFn = () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("spawn failure at /Users/someone/another-secret-path/claude"),
    });

    const origErrorLog = console.error;
    const loggedLines = [];
    console.error = (...args) => loggedLines.push(args.join(" "));

    try {
      const result = await enrich(ORIGINAL_DRAFT, { spawnFn });
      assert.deepEqual(result, ORIGINAL_DRAFT);
    } finally {
      console.error = origErrorLog;
    }

    const joined = loggedLines.join("\n");
    assert.ok(
      !joined.includes("another-secret-path"),
      "the raw error message (which can contain local paths) must not appear unconditionally in stderr",
    );
  });
});
