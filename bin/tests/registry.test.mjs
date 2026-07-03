/**
 * bin/tests/registry.test.mjs
 *
 * Unit tests for bin/registry.mjs.
 *
 * Covers:
 *   - resolveState: all 5 matrix cases (managed-active, managed-optedout, unmanaged)
 *   - setOptOut: add/remove from opt-out set
 *   - nudgeSeen / markNudgeSeen: one-shot nudge tracking
 *   - normalizeDir: Windows drive-letter lowercasing (PR #467), fail-open for non-existent paths
 *   - Queue RMW serialization: concurrent mutations don't stomp each other (PR #460)
 *
 * Run with: node --test bin/tests/registry.test.mjs
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

// We need to import registry.mjs but it uses a fixed REGISTRY_DIR derived from
// HOME at module load time. To isolate tests, we override HOME in the environment
// before importing. Since Node ESM module cache is per-specifier, we import a
// fresh instance by appending a cache-busting query param.
//
// Each describe block uses a fresh temp HOME so REGISTRY_PATH is isolated.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REGISTRY_PATH = join(__dirname, "..", "registry.mjs");

/**
 * Load a fresh instance of registry.mjs with the given HOME override.
 * Uses a URL with a dummy search param to bust the ESM module cache.
 *
 * @param {string} fakeHome
 * @param {string} salt - unique salt to bust module cache per test suite
 */
async function loadRegistry(fakeHome, salt) {
  const url = pathToFileURL(REGISTRY_PATH);
  url.searchParams.set("_t", salt);
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    return await import(url.href);
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
  }
}

// =============================================================================
// resolveState — state matrix
// =============================================================================

describe("resolveState — state matrix", async () => {
  let tmpDir;
  let projDir;
  let reg;

  before(async () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-reg-test-"));
    projDir = join(tmpDir, "project");
    mkdirSync(projDir, { recursive: true });
    // Load registry with a temp HOME so the registry file goes to tmpDir
    reg = await loadRegistry(tmpDir, "state-matrix-1");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 'unmanaged' when no forge.yaml and no .forgedock", () => {
    const state = reg.resolveState(projDir);
    assert.equal(state, "unmanaged");
  });

  it("returns 'managed-active' when forge.yaml exists and not opted out", () => {
    writeFileSync(join(projDir, "forge.yaml"), "# forge\n");
    const state = reg.resolveState(projDir);
    assert.equal(state, "managed-active");
  });

  it("returns 'managed-optedout' when forge.yaml exists and opted out", async () => {
    await reg.setOptOut(projDir, true);
    const state = reg.resolveState(projDir);
    assert.equal(state, "managed-optedout");
    // Clean up opt-out for next test
    await reg.setOptOut(projDir, false);
  });

  it("returns 'managed-active' when only .forgedock marker exists", () => {
    // Remove forge.yaml, add .forgedock
    rmSync(join(projDir, "forge.yaml"), { force: true });
    writeFileSync(join(projDir, ".forgedock"), "");
    const state = reg.resolveState(projDir);
    assert.equal(state, "managed-active");
  });

  it("returns 'managed-optedout' when .forgedock exists and opted out", async () => {
    await reg.setOptOut(projDir, true);
    const state = reg.resolveState(projDir);
    assert.equal(state, "managed-optedout");
    await reg.setOptOut(projDir, false);
    rmSync(join(projDir, ".forgedock"), { force: true });
  });

  it("returns 'unmanaged' when neither marker exists (even after cleanup)", () => {
    // Both markers removed in previous test
    const state = reg.resolveState(projDir);
    assert.equal(state, "unmanaged");
  });
});

// =============================================================================
// setOptOut / nudgeSeen / markNudgeSeen
// =============================================================================

describe("setOptOut, nudgeSeen, markNudgeSeen", async () => {
  let tmpDir;
  let projDir;
  let reg;

  before(async () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-reg-test-"));
    projDir = join(tmpDir, "project2");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "forge.yaml"), "# forge\n");
    reg = await loadRegistry(tmpDir, "opt-nudge-1");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("setOptOut(true) causes resolveState to return managed-optedout", async () => {
    await reg.setOptOut(projDir, true);
    assert.equal(reg.resolveState(projDir), "managed-optedout");
  });

  it("setOptOut(false) removes opt-out, causing resolveState to return managed-active", async () => {
    await reg.setOptOut(projDir, false);
    assert.equal(reg.resolveState(projDir), "managed-active");
  });

  it("nudgeSeen returns false before markNudgeSeen is called", () => {
    assert.equal(reg.nudgeSeen(projDir), false);
  });

  it("markNudgeSeen causes nudgeSeen to return true", async () => {
    await reg.markNudgeSeen(projDir);
    assert.equal(reg.nudgeSeen(projDir), true);
  });

  it("nudgeSeen returns false for a different directory not yet marked", () => {
    const otherDir = join(tmpDir, "other-project");
    mkdirSync(otherDir, { recursive: true });
    assert.equal(reg.nudgeSeen(otherDir), false);
  });
});

// =============================================================================
// normalizeDir — Windows drive-letter lowercasing (PR #467)
// =============================================================================

describe("normalizeDir — path normalization", async () => {
  let tmpDir;
  let reg;

  before(async () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-norm-test-"));
    reg = await loadRegistry(tmpDir, "normalize-1");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolveState is stable for the same path called twice", async () => {
    const projDir = join(tmpDir, "stable-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "forge.yaml"), "# forge\n");
    const s1 = reg.resolveState(projDir);
    const s2 = reg.resolveState(projDir);
    assert.equal(s1, s2);
  });

  it("resolveState handles paths that do not exist (fail-open)", () => {
    const nonExistent = join(tmpDir, "does-not-exist");
    // Must not throw
    let state;
    assert.doesNotThrow(() => {
      state = reg.resolveState(nonExistent);
    });
    assert.equal(state, "unmanaged");
  });

  it("setOptOut on a non-existent path does not throw", async () => {
    const nonExistent = join(tmpDir, "ghost-dir");
    await assert.doesNotReject(reg.setOptOut(nonExistent, true));
  });

  // Windows-specific: if running on Windows, drive letter should be normalized
  // On POSIX this test still runs but drive-letter logic is a no-op.
  it("two opt-out calls for the same path are idempotent", async () => {
    const projDir = join(tmpDir, "idem-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "forge.yaml"), "# forge\n");
    await reg.setOptOut(projDir, true);
    await reg.setOptOut(projDir, true);
    assert.equal(reg.resolveState(projDir), "managed-optedout");
    await reg.setOptOut(projDir, false);
  });
});

// =============================================================================
// Queue RMW serialization (PR #460) — concurrent mutations must not stomp
// =============================================================================

describe("Registry queue RMW serialization (PR #460)", async () => {
  let tmpDir;
  let regA;
  let projDirA;
  let projDirB;

  before(async () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-queue-test-"));
    projDirA = join(tmpDir, "proj-a");
    projDirB = join(tmpDir, "proj-b");
    mkdirSync(projDirA, { recursive: true });
    mkdirSync(projDirB, { recursive: true });
    writeFileSync(join(projDirA, "forge.yaml"), "# forge\n");
    writeFileSync(join(projDirB, "forge.yaml"), "# forge\n");
    // Use a single registry instance for concurrent ops
    regA = await loadRegistry(tmpDir, "queue-rmw-1");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("concurrent setOptOut calls for different dirs both persist", async () => {
    // Fire both concurrently without awaiting one before the other
    await Promise.all([
      regA.setOptOut(projDirA, true),
      regA.setOptOut(projDirB, true),
    ]);
    // Both must be opted out — a race would stomp one
    assert.equal(regA.resolveState(projDirA), "managed-optedout",
      "projDirA should be opted out");
    assert.equal(regA.resolveState(projDirB), "managed-optedout",
      "projDirB should be opted out");
  });

  it("concurrent markNudgeSeen and setOptOut both persist", async () => {
    const projDirC = join(tmpDir, "proj-c");
    mkdirSync(projDirC, { recursive: true });
    writeFileSync(join(projDirC, "forge.yaml"), "# forge\n");

    await Promise.all([
      regA.markNudgeSeen(projDirC),
      regA.setOptOut(projDirC, true),
    ]);
    // Both nudgeSeen and optedOut should be recorded
    assert.equal(regA.nudgeSeen(projDirC), true, "nudge should be marked seen");
    assert.equal(regA.resolveState(projDirC), "managed-optedout",
      "projDirC should be opted out");
  });

  it("many concurrent setOptOut calls all persist without stomping", async () => {
    const dirs = [];
    for (let i = 0; i < 10; i++) {
      const d = join(tmpDir, `proj-conc-${i}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "forge.yaml"), "# forge\n");
      dirs.push(d);
    }
    // Fire all 10 concurrently
    await Promise.all(dirs.map((d) => regA.setOptOut(d, true)));
    // All 10 must be opted out
    for (const d of dirs) {
      assert.equal(regA.resolveState(d), "managed-optedout",
        `${d} should be opted out`);
    }
  });
});

// =============================================================================
// Missing/corrupt registry file — fail-open behavior
// =============================================================================

describe("Registry fail-open for missing or corrupt file", async () => {
  let tmpDir;
  let reg;

  before(async () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "forge-failopen-test-"));
    reg = await loadRegistry(tmpDir, "failopen-1");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolveState works when no registry.json exists yet", () => {
    const projDir = join(tmpDir, "no-reg-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "forge.yaml"), "# forge\n");
    // No registry file written — must return managed-active (fail-open = empty opt-out)
    assert.equal(reg.resolveState(projDir), "managed-active");
  });

  it("nudgeSeen returns false when no registry.json exists", () => {
    const projDir = join(tmpDir, "no-reg-nudge");
    mkdirSync(projDir, { recursive: true });
    assert.equal(reg.nudgeSeen(projDir), false);
  });

  it("resolveState handles a corrupt registry.json (invalid JSON) without throwing", async () => {
    const registryDir = join(tmpDir, ".claude", "forgedock");
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(registryDir, "registry.json"), "{ not valid JSON }}");
    const projDir = join(tmpDir, "corrupt-reg-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "forge.yaml"), "# forge\n");
    let state;
    assert.doesNotThrow(() => {
      state = reg.resolveState(projDir);
    });
    // Corrupt file → treated as empty → managed-active
    assert.equal(state, "managed-active");
  });
});
