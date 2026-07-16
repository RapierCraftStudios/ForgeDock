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
 *   getPersistedHomeState()    → { path, version, updatedAt } | null  (reads persistedHome)
 *   setPersistedHomeState(s)   → Promise<void>  (writes persistedHome; see #1943)
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
 *     },
 *     "persistedHome": {
 *       "path": "/absolute/path/to/~/.forge",
 *       "version": "1.2.3",
 *       "updatedAt": "<ISO-8601 timestamp>"
 *     } | null
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
 *   - `persistedHome` records the last known state of the persisted-toolset
 *     copy (bin/journey.mjs: persistHome(), issue #1943) written under
 *     `~/.forge/`. `null` means persistHome() has never run (or was skipped —
 *     e.g. a git-clone install) for this user. This is metadata ABOUT that
 *     copy — the copy itself is not stored here; only registry.mjs's own
 *     `~/.claude/forgedock/registry.json` lives in this file.
 *
 * Contract guarantees:
 *   - Safe: every try/catch degrades gracefully; resolveState never throws
 *   - Isolated: imports only Node builtins (os, path, fs)
 *   - Atomic writes: registry.json is written via a .tmp file + renameSync
 *   - Testable: inject `dir` argument to point at fixture directories
 */

import os from "os";
import { resolve, join } from "path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  realpathSync,
} from "fs";
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
 * @returns {{ version: number, optedOut: Record<string, { at: string }>, nudgeSeen: Record<string, { at: string }>, persistedHome: null }}
 */
function emptyRegistry() {
  return { version: 1, optedOut: {}, nudgeSeen: {}, persistedHome: null };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve and normalize a directory path for use as a registry key.
 *
 * First resolves the path to an absolute path with `resolve()`, then
 * dereferences any symbolic links with `realpathSync.native()` so that a
 * project entered via a symlinked path and the same project entered via its
 * real path produce the same registry key. A try/catch fallback to the
 * `resolve()` result ensures fail-open behaviour for non-existent or
 * inaccessible paths (ENOENT, EACCES, EPERM).
 *
 * On Windows only, the drive letter of the resulting canonical path is
 * lowercased (the character before the first `:`). This ensures that
 * `C:\Users\foo` and `c:\Users\foo` hash to the same key, since NTFS is
 * case-insensitive but JavaScript string comparison is not.
 *
 * On POSIX systems the canonical path is returned as-is; POSIX filesystems
 * are case-sensitive by convention and no normalization is needed.
 *
 * Only the drive letter is lowercased — the rest of the path is preserved
 * verbatim so that intentional casing in directory names is not altered.
 *
 * @param {string} dir - Directory path (absolute or relative).
 * @returns {string} Normalized canonical absolute path suitable for use as a registry key.
 */
function normalizeDir(dir) {
  const abs = resolve(dir);
  // Dereference symbolic links so that a symlinked project path and its
  // real path produce the same registry key. Fall back to the resolve()
  // result for paths that do not exist yet (e.g. ENOENT) or are not
  // accessible (EACCES/EPERM) — preserves the fail-open contract.
  // realpathSync.native uses the OS-native implementation (available since
  // Node 9.2) and avoids extra JS stat syscalls vs the JS fallback.
  let canonical;
  try {
    canonical = realpathSync.native(abs);
  } catch {
    canonical = abs;
  }
  // On Windows, drive letters vary in casing (C:\ vs c:\). Normalize to
  // lowercase so registry lookups are case-insensitive for drive letters.
  // Detect: canonical[1] === ':' is the Windows drive-letter pattern (e.g. C:\).
  if (
    process.platform === "win32" &&
    canonical.length >= 2 &&
    canonical[1] === ":"
  ) {
    return canonical[0].toLowerCase() + canonical.slice(1);
  }
  return canonical;
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
      // Ensure persistedHome is present (absent in registry files written
      // before #1943 added persisted-home tracking).
      if (parsed.persistedHome === undefined) {
        parsed.persistedHome = null;
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
 * Module-level write queue — serializes concurrent registry mutations so that
 * two callers (e.g. setOptOut + markNudgeSeen in the same tick) never race and
 * produce a last-write-wins corruption. Each enqueued mutation waits for the
 * previous one to resolve before executing. Errors are swallowed per the
 * existing best-effort contract so a failed write never blocks the next caller.
 *
 * The queue serializes the FULL read-modify-write cycle, not just the disk
 * write. Each task reads the freshest on-disk state inside the critical section,
 * applies the caller-supplied mutation, then writes atomically. This prevents
 * the snapshot-before-enqueue race where two concurrent callers both read stale
 * state and the second enqueued write silently stomps the first one's change.
 * <!-- fix: forge#438 -->
 */
let _writeQueue = Promise.resolve();

/**
 * Enqueue a read-modify-write mutation against the registry.
 *
 * Accepts a `mutate` function rather than a pre-read data snapshot. The
 * mutation is deferred until it reaches the head of the serial queue, at
 * which point it reads the freshest on-disk registry state, applies the
 * mutation, and writes the result atomically. This guarantees that concurrent
 * callers each see the previous caller's changes rather than racing on a
 * shared stale snapshot.
 *
 * Best-effort: errors inside the mutation or the disk write are silently
 * suppressed so callers are never blocked.
 *
 * @param {(registry: { version: number, optedOut: Record<string, { at: string }>, nudgeSeen: Record<string, { at: string }> }) => void} mutate
 *   Mutation callback. Called with the current registry object; should
 *   modify it in place. Return value is ignored. Callbacks may have side
 *   effects (e.g. reading the clock) — they are not required to be pure.
 * @returns {Promise<void>}
 */
async function writeRegistry(mutate) {
  // Chain onto the existing queue; swallow errors so callers are never blocked
  _writeQueue = _writeQueue
    .then(() => _doWriteRegistryWith(mutate))
    .catch(() => {});
  return _writeQueue;
}

/**
 * Inner implementation — performs the atomic read-modify-write cycle.
 * Called exclusively through writeRegistry's queue chain.
 *
 * Reads the current registry from disk (fail-open), applies the caller's
 * mutation function, then writes the result via a .tmp file + renameSync.
 *
 * @param {(registry: { version: number, optedOut: Record<string, { at: string }>, nudgeSeen: Record<string, { at: string }> }) => void} mutate
 *   Mutation callback — same contract as `writeRegistry`. Modifies the
 *   registry object in place; return value is ignored.
 * @returns {Promise<void>}
 */
async function _doWriteRegistryWith(mutate) {
  try {
    await mkdir(REGISTRY_DIR, { recursive: true, mode: 0o700 });
    // Read the freshest on-disk state inside the critical section so that
    // concurrent callers each build on the previous caller's committed write.
    const registry = readRegistry();
    mutate(registry);
    const tmp = REGISTRY_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", {
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
  // Pass a mutation closure rather than a pre-read snapshot. The actual
  // readRegistry() call is deferred to inside the serial queue so that
  // concurrent mutations each see the previous caller's committed write.
  await writeRegistry((registry) => {
    if (optedOut) {
      registry.optedOut[absDir] = { at: new Date().toISOString() };
    } else {
      delete registry.optedOut[absDir];
    }
  });
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
  // Pass a mutation closure rather than a pre-read snapshot. The actual
  // readRegistry() call is deferred to inside the serial queue so that
  // concurrent mutations each see the previous caller's committed write.
  await writeRegistry((registry) => {
    registry.nudgeSeen[absDir] = { at: new Date().toISOString() };
  });
}

/**
 * Remove the nudgeSeen entry for a directory from the registry.
 *
 * Called by `npx forgedock uninstall` to clean up per-directory state
 * written by the session-start hook. After uninstall, the nudge will fire
 * once more if ForgeDock is later reinstalled in the same directory —
 * consistent with a fresh install experience.
 *
 * Best-effort: a failed write is non-fatal and leaves the registry as-is.
 *
 * @param {string} dir - Absolute path to the directory.
 * @returns {Promise<void>}
 */
export async function clearNudgeSeen(dir) {
  const absDir = normalizeDir(dir);
  await writeRegistry((registry) => {
    delete registry.nudgeSeen[absDir];
  });
}

// ---------------------------------------------------------------------------
// Persisted-home state tracking (issue #1943)
// ---------------------------------------------------------------------------
// bin/journey.mjs's persistHome() copies ForgeDock's own toolset (bin/,
// commands/, scripts/, templates/) into a stable `~/.forge/` home so
// ~/.claude/commands/ symlinks and the SessionStart hook's script path
// survive npm/npx cache eviction. These two functions are the single place
// doctor()/update() read and write what persistHome() last did, so both
// commands agree on "where does the persisted copy live and what version is
// it" instead of each re-deriving it independently (forge#1589's split-brain
// precedent — install/doctor/status previously disagreed about where
// ForgeDock lived, and this issue must not reintroduce that).

/**
 * Read the last recorded persisted-home state from the registry.
 *
 * NOT pure: reads `~/.claude/forgedock/registry.json` from disk on every
 * call. Fail-open — a missing/corrupt registry file, or a registry written
 * before #1943, both resolve to `null` (equivalent to "persistHome() has
 * never recorded state for this user") rather than throwing.
 *
 * @returns {{ path: string, version: string, updatedAt: string } | null}
 */
export function getPersistedHomeState() {
  try {
    const registry = readRegistry();
    return registry.persistedHome ?? null;
  } catch {
    return null;
  }
}

/**
 * Record the current persisted-home state in the registry.
 *
 * NOT pure: performs a disk write (via the atomic `.tmp` + `renameSync`
 * pattern in `_doWriteRegistryWith`) and, when the caller omits `updatedAt`,
 * calls `new Date()` to stamp one — this function has real side effects, it
 * does not merely compute a value (see forge#462: a prior JSDoc/behavior
 * mismatch in this file claimed a writer was a "pure mutation function" when
 * it in fact touched the clock and the filesystem — documenting that
 * honestly here rather than repeating it).
 *
 * Best-effort: write failures are swallowed by writeRegistry()'s existing
 * fail-open contract; a failed write leaves the previous persistedHome value
 * (or null) in place rather than throwing.
 *
 * @param {{ path: string, version: string, updatedAt?: string }} state
 * @returns {Promise<void>}
 */
export async function setPersistedHomeState({ path, version, updatedAt } = {}) {
  // Normalize the same way normalizeDir() does elsewhere in this file
  // (lowercase Windows drive letter) so a later lookup never mismatches on
  // drive-letter casing alone (forge#412 precedent). Falls back to the raw
  // path if it doesn't exist yet or can't be resolved — never throws.
  let normalizedPath = path;
  try {
    if (path) normalizedPath = normalizeDir(path);
  } catch {
    normalizedPath = path;
  }
  await writeRegistry((registry) => {
    registry.persistedHome = {
      path: normalizedPath,
      version: version || "",
      updatedAt: updatedAt || new Date().toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Claude Code version detection and breakpoints resolution (issue #1252)
// ---------------------------------------------------------------------------

// execFileSync is not imported at the top of this module (it only imports fs
// builtins). Import it lazily here using createRequire — safe in Node ESM.
import { createRequire } from "module";
const _require = createRequire(import.meta.url);

/**
 * Detect the installed Claude Code version by running `claude --version`.
 *
 * Returns the version string (e.g. "2.1.197") or null if Claude Code is not
 * installed or the version cannot be parsed. Never throws — callers can safely
 * check for null and degrade gracefully.
 *
 * @returns {string | null} Semver-style version string or null.
 */
export function detectClaudeVersion() {
  try {
    const { execFileSync } = _require("child_process");
    const raw = execFileSync("claude", ["--version"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
    // Claude Code outputs e.g. "Claude Code 2.1.197" or just "2.1.197"
    const m = raw.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Compare two semver-style version strings (e.g. "2.1.152" vs "2.1.197").
 *
 * Returns:
 *   -1 if a < b
 *    0 if a === b
 *    1 if a > b
 *
 * Non-numeric components are compared lexicographically. Handles missing
 * components by treating them as 0.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map((s) => parseInt(s, 10) || 0);
  const pb = String(b).split(".").map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Load and parse docs/claude-breakpoints.json relative to FORGE_HOME.
 *
 * Returns the parsed breakpoints array or an empty array on any error (file
 * missing, malformed JSON, etc.). Consumers must pass the FORGE_HOME path.
 *
 * @param {string} forgeHome - Absolute path to the ForgeDock repo root.
 * @returns {Array<object>} Array of breakpoint objects.
 */
export function loadBreakpoints(forgeHome) {
  try {
    const bpPath = join(forgeHome, "docs", "claude-breakpoints.json");
    const raw = readFileSync(bpPath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.breakpoints) ? parsed.breakpoints : [];
  } catch {
    return [];
  }
}

/**
 * Resolve all breakpoints applicable to a given Claude Code version.
 *
 * A breakpoint is "applicable" if its version is > the supplied version,
 * meaning the user is on an older version and will be affected by this
 * breakpoint. This surfaces the set of features/changes the user is missing.
 *
 * If no version is supplied, all breakpoints are returned (useful for
 * listing the full registry).
 *
 * Results are sorted by version ascending.
 *
 * @param {Array<object>} breakpoints - Array from loadBreakpoints().
 * @param {string | null} installedVersion - The user's installed Claude Code version, or null.
 * @returns {Array<object>} Breakpoints the user is missing or all breakpoints if no version.
 */
export function resolveBreakpoints(breakpoints, installedVersion) {
  if (!installedVersion) return [...breakpoints].sort((a, b) => compareVersions(a.version, b.version));
  return breakpoints
    .filter((bp) => compareVersions(bp.version, installedVersion) > 0)
    .sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Resolve a single breakpoint by feature_key.
 *
 * Returns the breakpoint object with the matching `feature_key`, or null
 * if not found. Useful for conditional logic: "does this install support
 * effort_levels?" → `resolveBreakpoint(bps, 'effort_levels')`.
 *
 * @param {Array<object>} breakpoints - Array from loadBreakpoints().
 * @param {string} featureKey - The `feature_key` value to look up.
 * @returns {object | null} The matching breakpoint or null.
 */
export function resolveBreakpoint(breakpoints, featureKey) {
  return breakpoints.find((bp) => bp.feature_key === featureKey) ?? null;
}

/**
 * Check whether a detected Claude Code version meets or exceeds the version
 * required for a given feature_key.
 *
 * Returns true if the feature is available, false if not, and null if the
 * feature_key is unknown or the installed version is not detectable.
 *
 * @param {Array<object>} breakpoints - Array from loadBreakpoints().
 * @param {string} featureKey - Feature to check.
 * @param {string | null} installedVersion - Detected Claude Code version.
 * @returns {boolean | null}
 */
export function hasFeature(breakpoints, featureKey, installedVersion) {
  if (!installedVersion) return null;
  const bp = resolveBreakpoint(breakpoints, featureKey);
  if (!bp) return null;
  return compareVersions(installedVersion, bp.version) >= 0;
}
