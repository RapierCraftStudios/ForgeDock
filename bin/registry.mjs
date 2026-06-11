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
 *   nudgeSeen(dir)             → boolean  (true if nudge was already shown for dir)
 *   markNudgeSeen(dir)         → Promise<void>  (records that nudge was shown for dir)
 *
 * Registry file: ~/.claude/forgedock/registry.json
 * Registry schema:
 *   {
 *     "version": 1,
 *     "optedOut": {
 *       "/absolute/path/to/dir": { "at": "<ISO-8601 timestamp>" }
 *     },
 *     "nudgeSeen": {
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
 *   - A nudge is shown at most once per unmanaged directory; `nudgeSeen` tracks
 *     which directories have already received the nudge.
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
 * @returns {{ version: number, optedOut: Record<string, { at: string }>, nudgeSeen: Record<string, { at: string }> }}
 */
function emptyRegistry() {
  return { version: 1, optedOut: {}, nudgeSeen: {} };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve and normalize a directory path for use as a registry key.
 *
 * Calls `resolve()` to produce an absolute path, then — on Windows only —
 * lowercases the drive letter (the character before the first `:`). This
 * ensures that `C:\Users\foo` and `c:\Users\foo` hash to the same key,
 * since NTFS is case-insensitive but JavaScript string comparison is not.
 *
 * On POSIX systems the resolved path is returned as-is; POSIX filesystems
 * are case-sensitive by convention and no normalization is needed.
 *
 * Only the drive letter is lowercased — the rest of the path is preserved
 * verbatim so that intentional casing in directory names is not altered.
 *
 * @param {string} dir - Directory path (absolute or relative).
 * @returns {string} Normalized absolute path suitable for use as a registry key.
 */
function normalizeDir(dir) {
  const abs = resolve(dir);
  // On Windows, drive letters vary in casing (C:\ vs c:\). Normalize to
  // lowercase so registry lookups are case-insensitive for drive letters.
  // Detect: abs[1] === ':' is the Windows drive-letter pattern (e.g. C:\).
  if (process.platform === "win32" && abs.length >= 2 && abs[1] === ":") {
    return abs[0].toLowerCase() + abs.slice(1);
  }
  return abs;
}

/**
 * Read and parse the registry file.
 *
 * Fail-open: any read or parse error returns an empty registry rather than
 * throwing. This ensures that a corrupt or missing file never blocks a
 * Claude Code session.
 *
 * @returns {{ version: number, optedOut: Record<string, { at: string }>, nudgeSeen: Record<string, { at: string }> }}
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
      // Ensure nudgeSeen is present (may be absent in older registry files)
      if (!parsed.nudgeSeen || typeof parsed.nudgeSeen !== "object") {
        parsed.nudgeSeen = {};
      }
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
 * Module-level write queue — serializes concurrent writeRegistry calls so that
 * two callers (e.g. setOptOut + markNudgeSeen in the same tick) never race and
 * produce a last-write-wins corruption. Each enqueued write waits for the
 * previous one to resolve before executing. Errors are swallowed per the
 * existing best-effort contract so a failed write never blocks the next caller.
 */
let _writeQueue = Promise.resolve();

/**
 * Atomically write registry data to disk.
 *
 * Creates REGISTRY_DIR (mode 0o700) if it does not exist.
 * Writes to a .tmp sibling first, then renames to the final path.
 * Best-effort: errors are silently suppressed to avoid blocking callers.
 * Calls are serialized through a module-level Promise queue.
 *
 * @param {{ version: number, optedOut: Record<string, { at: string }>, nudgeSeen: Record<string, { at: string }> }} data
 * @returns {Promise<void>}
 */
async function writeRegistry(data) {
  // Chain onto the existing queue; swallow errors so callers are never blocked
  _writeQueue = _writeQueue.then(() => _doWriteRegistry(data)).catch(() => {});
  return _writeQueue;
}

/**
 * Inner implementation — performs the actual atomic write.
 * Called exclusively through writeRegistry's queue chain.
 *
 * @param {{ version: number, optedOut: Record<string, { at: string }>, nudgeSeen: Record<string, { at: string }> }} data
 * @returns {Promise<void>}
 */
async function _doWriteRegistry(data) {
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
  const absDir = normalizeDir(dir);

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
 * The directory path is normalized with normalizeDir() before being stored,
 * ensuring consistent key lookup regardless of trailing slashes, symlinks, or
 * drive-letter casing on Windows.
 *
 * @param {string} dir        - Absolute path to the directory.
 * @param {boolean} optedOut  - true to opt out, false to remove from opt-out set.
 * @returns {Promise<void>}
 */
export async function setOptOut(dir, optedOut) {
  const absDir = normalizeDir(dir);
  const registry = readRegistry();

  if (optedOut) {
    registry.optedOut[absDir] = { at: new Date().toISOString() };
  } else {
    delete registry.optedOut[absDir];
  }

  await writeRegistry(registry);
}

/**
 * Check whether the one-time "Enable ForgeDock here?" nudge has already been
 * shown for a given directory.
 *
 * Fail-open: returns false on any registry read error, so the nudge fires
 * once more on the next session rather than never.
 *
 * @param {string} dir - Absolute path to the directory.
 * @returns {boolean} true if the nudge has already been shown for this directory.
 */
export function nudgeSeen(dir) {
  try {
    const absDir = normalizeDir(dir);
    const registry = readRegistry();
    return Object.prototype.hasOwnProperty.call(registry.nudgeSeen, absDir);
  } catch {
    return false;
  }
}

/**
 * Record that the one-time nudge has been shown for a directory so it is not
 * shown again in future sessions.
 *
 * Best-effort: a failed write means the nudge may appear one extra time, which
 * is acceptable — it never blocks a Claude Code session.
 *
 * @param {string} dir - Absolute path to the directory.
 * @returns {Promise<void>}
 */
export async function markNudgeSeen(dir) {
  const absDir = normalizeDir(dir);
  const registry = readRegistry();
  registry.nudgeSeen[absDir] = { at: new Date().toISOString() };
  await writeRegistry(registry);
}
