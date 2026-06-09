#!/usr/bin/env node
/**
 * registry.mjs — Per-directory ForgeDock state registry.
 *
 * Resolves, for any directory, whether ForgeDock is *managed* there
 * (a forge.yaml or .forgedock marker is present) and whether the user has
 * explicitly *opted out* via the central registry file.
 *
 * Exports:
 *   resolveState(dir)          → 'managed-active' | 'managed-optedout' | 'unmanaged'
 *   setOptOut(dir, optedOut)   → Promise<void>  (adds/removes dir from opt-out set)
 *
 * Registry file: ~/.claude/forgedock/registry.json
 * Registry schema:
 *   {
 *     "version": 1,
 *     "optedOut": {
 *       "/absolute/path/to/dir": { "at": "<ISO-8601 timestamp>" }
 *     }
 *   }
 *
 * State model:
 *   - A directory is **managed** iff it contains `forge.yaml` OR a `.forgedock` marker file.
 *   - A directory is **opted-out** iff its resolved absolute path appears in the
 *     `optedOut` map of the registry.
 *   - Opt-out wins over managed: a managed+opted-out directory is silenced.
 *   - Missing or corrupt registry.json is treated as an empty opt-out set — the
 *     registry always fails open (never blocks a Claude Code session).
 *
 * Contract guarantees:
 *   - Safe: every try/catch degrades gracefully; resolveState never throws
 *   - Isolated: imports only Node builtins (os, path, fs)
 *   - Atomic writes: registry.json is written via a .tmp file + renameSync
 *   - Testable: inject `dir` argument to point at fixture directories
 */

import os from "os";
import { resolve, join } from "path";
import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { mkdir } from "fs/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Cross-platform user home directory.
 * Mirrors the HOME resolution pattern used in forgedock.mjs.
 */
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

/**
 * Directory that holds ForgeDock's per-user runtime state files.
 * Created on first registry write if absent (mode 0o700).
 */
const REGISTRY_DIR = join(HOME, ".claude", "forgedock");

/**
 * Absolute path to the registry JSON file.
 */
const REGISTRY_PATH = join(REGISTRY_DIR, "registry.json");

/**
 * Empty registry structure — returned whenever the file is missing or corrupt.
 * Using a factory function avoids shared mutable state across calls.
 *
 * @returns {{ version: number, optedOut: Record<string, { at: string }> }}
 */
function emptyRegistry() {
  return { version: 1, optedOut: {} };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse the registry file.
 *
 * Fail-open: any read or parse error returns an empty registry rather than
 * throwing. This ensures that a corrupt or missing file never blocks a
 * Claude Code session.
 *
 * @returns {{ version: number, optedOut: Record<string, { at: string }> }}
 */
function readRegistry() {
  try {
    const raw = readFileSync(REGISTRY_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    // Basic schema validation — must be an object with an optedOut map
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.optedOut &&
      typeof parsed.optedOut === "object"
    ) {
      return parsed;
    }
    // Schema mismatch — treat as empty (fail open)
    return emptyRegistry();
  } catch {
    // File missing, unreadable, or invalid JSON — all treated as empty
    return emptyRegistry();
  }
}

/**
 * Atomically write registry data to disk.
 *
 * Creates REGISTRY_DIR (mode 0o700) if it does not exist.
 * Writes to a .tmp sibling first, then renames to the final path.
 * Best-effort: errors are silently suppressed to avoid blocking callers.
 *
 * @param {{ version: number, optedOut: Record<string, { at: string }> }} data
 * @returns {Promise<void>}
 */
async function writeRegistry(data) {
  try {
    await mkdir(REGISTRY_DIR, { recursive: true, mode: 0o700 });
    const tmp = REGISTRY_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf-8",
    });
    renameSync(tmp, REGISTRY_PATH);
  } catch {
    // Best-effort — a failed write is non-fatal; the registry remains as-is
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the ForgeDock state for a given directory.
 *
 * State matrix:
 *
 * | forge.yaml | .forgedock | in optedOut | Result             |
 * |:----------:|:----------:|:-----------:|:-------------------|
 * |    true    |    any     |    false    | managed-active     |
 * |    true    |    any     |    true     | managed-optedout   |
 * |   false    |    true    |    false    | managed-active     |
 * |   false    |    true    |    true     | managed-optedout   |
 * |   false    |   false    |    any      | unmanaged          |
 *
 * Opt-out wins over managed: a directory that has a marker but is also listed
 * in the registry's optedOut map is reported as managed-optedout.
 *
 * Missing or corrupt registry.json is treated as an empty opt-out set —
 * resolveState never throws.
 *
 * @param {string} dir - Absolute path to the directory to resolve.
 * @returns {'managed-active' | 'managed-optedout' | 'unmanaged'}
 */
export function resolveState(dir) {
  const absDir = resolve(dir);

  // Check for managed markers (forge.yaml or .forgedock)
  const hasForgeYaml = existsSync(join(absDir, "forge.yaml"));
  const hasMarker = existsSync(join(absDir, ".forgedock"));
  const isManaged = hasForgeYaml || hasMarker;

  if (!isManaged) {
    return "unmanaged";
  }

  // Directory is managed — check if opted out
  const registry = readRegistry();
  const isOptedOut = Object.prototype.hasOwnProperty.call(
    registry.optedOut,
    absDir,
  );

  return isOptedOut ? "managed-optedout" : "managed-active";
}

/**
 * Add or remove a directory from the opt-out set in the registry.
 *
 * The directory path is normalized with resolve() before being stored,
 * ensuring consistent key lookup regardless of trailing slashes or symlinks.
 *
 * @param {string} dir        - Absolute path to the directory.
 * @param {boolean} optedOut  - true to opt out, false to remove from opt-out set.
 * @returns {Promise<void>}
 */
export async function setOptOut(dir, optedOut) {
  const absDir = resolve(dir);
  const registry = readRegistry();

  if (optedOut) {
    registry.optedOut[absDir] = { at: new Date().toISOString() };
  } else {
    delete registry.optedOut[absDir];
  }

  await writeRegistry(registry);
}
