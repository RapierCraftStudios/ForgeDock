/**
 * bin/forge-utils.mjs — Shared utility functions for ForgeDock.
 *
 * Extracted from bin/hooks/session-start.mjs so they can be unit-tested
 * without importing the hook script (which calls process.exit at module
 * top-level as part of its fail-open contract).
 *
 * Exports:
 *   parseForgeYaml(raw)               → object  (parse a forge.yaml string)
 *   sanitizeContextValue(value, max)  → string|null  (sanitize before injection)
 *   detectClaudeVersion([opts])       → Promise<VersionResult>  (detect installed vs latest; opts.forceRefresh bypasses cache)
 *
 * Contract guarantees:
 *   - parseForgeYaml and sanitizeContextValue: Pure — no I/O, no side effects, no global state
 *   - detectClaudeVersion: performs I/O (child_process + fs); fail-open — never throws,
 *     returns {version: 'unknown'} on any error
 *   - Safe: no function throws at the module level
 *   - Isolated: imports only Node builtins
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// YAML parser
// ---------------------------------------------------------------------------

/**
 * Minimal YAML parser for forge.yaml files.
 *
 * Handles:
 *   - Top-level scalar values: `key: value` and `key: "quoted value"`
 *   - Top-level section headers: `section:` (no value on the same line)
 *   - Nested scalars under a section: `  key: value`
 *   - Comments (`# ...`) and blank lines are skipped
 *   - Both LF and CRLF line endings (split on /\r?\n/)
 *
 * Does NOT handle: arrays, multi-line values, anchors, aliases, or other
 * YAML features. Intended only for the flat key-value structure of forge.yaml.
 *
 * @param {string} raw - Raw string content of a forge.yaml file.
 * @returns {Record<string, string | Record<string, string>>}
 */
export function parseForgeYaml(raw) {
  const result = {};
  let currentSection = null;

  for (const line of raw.split(/\r?\n/)) {
    // Skip comments and blank lines
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;

    // Top-level section header: `section:` (no value on same line)
    const sectionMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(?:#.*)?$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      result[currentSection] = {};
      continue;
    }

    // Top-level scalar: `key: value` (no leading whitespace)
    const topScalarMatch = line.match(
      /^([a-zA-Z_][a-zA-Z0-9_]*):\s+"([^"]*)"(?:\s*#.*)?$|^([a-zA-Z_][a-zA-Z0-9_]*):\s+([^#\n]+?)(?:\s*#.*)?$/,
    );
    if (topScalarMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      const key = topScalarMatch[1] ?? topScalarMatch[3];
      const value = topScalarMatch[2] ?? topScalarMatch[4]?.trim();
      if (key && value !== undefined) {
        currentSection = null;
        result[key] = value;
      }
      continue;
    }

    // Nested scalar under current section: `  key: value`
    if (currentSection && /^\s+/.test(line)) {
      const nestedMatch = line.match(
        /^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s+"([^"]*)"(?:\s*#.*)?$|^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s+([^#\n]+?)(?:\s*#.*)?$/,
      );
      if (nestedMatch) {
        const key = nestedMatch[1] ?? nestedMatch[3];
        const value = nestedMatch[2] ?? nestedMatch[4]?.trim();
        if (
          key &&
          value !== undefined &&
          typeof result[currentSection] === "object"
        ) {
          result[currentSection][key] = value;
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Context value sanitizer
// ---------------------------------------------------------------------------

/**
 * Sanitize a forge.yaml value before injecting it into the session context.
 *
 * A forge.yaml file may originate from a cloned repository rather than from
 * ForgeDock's own sanitized writer. This function ensures that untrusted
 * field values cannot inject markdown structural sequences or control
 * characters into the LLM session context.
 *
 * Strips:
 *   - Control characters U+0000-U+001F and U+007F-U+009F (including \r, \n, \t)
 *   - Leading markdown heading markers (one or more `#` followed by space)
 *   - YAML/Markdown horizontal rules (`---` at start of value)
 *   - HTML comment delimiters (`<!--` and `-->`)
 *   - Triple backtick sequences (fenced code block markers)
 *   - Single backticks (inline-code span terminators)
 *
 * Applies stripping in a fixed-point loop: repeats until the string stops
 * changing, so that adjacent fragments that re-form a token after one pass
 * are also stripped.
 *
 * Caps the value to `maxLen` characters after stripping.
 * Trims leading/trailing whitespace.
 *
 * Returns `null` for null/undefined input (preserves existing null guards in
 * the callers so that optional notes are omitted when the field is absent).
 *
 * Never throws — any internal error returns `null` so the hook stays fail-open.
 * <!-- fix: forge#418 -->
 *
 * @param {string|null|undefined} value  - Raw value from forge.yaml.
 * @param {number}                maxLen - Maximum allowed length after stripping.
 * @returns {string|null}
 */
export function sanitizeContextValue(value, maxLen) {
  try {
    if (value == null) return null;
    // eslint-disable-next-line no-control-regex
    let stripped = String(value)
      // Strip control characters (C0 block U+0000-U+001F, DEL U+007F, C1 block U+0080-U+009F)
      .replace(/[\x00-\x1F\x7F-\x9F]/g, "");
    // Strip injection-capable token sequences until a fixed point. A single
    // pass can re-form a token from adjacent fragments (e.g. "<!<!---->--"
    // leaves "<!--"), and HTML parsers accept "--!>" as a comment close in
    // addition to "-->". Each pass strictly shrinks the string, so the loop
    // terminates.
    let prev;
    do {
      prev = stripped;
      stripped = stripped
        // Strip leading markdown headings (e.g. "## Title" → "Title")
        .replace(/^#+\s+/g, "")
        // Strip horizontal rule patterns at start of value
        .replace(/^---+/g, "")
        // Strip HTML comment delimiters (open, and both close forms)
        .replace(/<!--/g, "")
        .replace(/--!?>/g, "")
        // Strip triple backtick fenced code block markers
        .replace(/`{3}/g, "")
        // Strip single backticks — values are interpolated inside inline-code
        // spans (e.g. `${stagingBranch}`), so any backtick in the value would
        // terminate the span prematurely and corrupt the rendered context.
        // <!-- fix: forge#443 -->
        .replace(/`/g, "");
    } while (stripped !== prev);
    const str = stripped.trim().slice(0, maxLen);
    return str.length > 0 ? str : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Claude Code version detector
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} VersionResult
 * @property {string}  installed - Installed claude version string, or 'unknown'
 * @property {string}  latest    - Latest npm registry version, or 'unknown'
 * @property {boolean} stale     - true when installed !== latest and both are known
 * @property {string}  delta     - Human-readable delta, e.g. '1.0.5 → 1.0.8', or '' when unknown
 */

/**
 * @typedef {Object} UnknownVersionResult
 * @property {string} version - Always 'unknown'
 */

/** Cache TTL: 24 hours in milliseconds. */
const VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** CLI call timeout: 5 seconds. */
const VERSION_CLI_TIMEOUT_MS = 5_000;

/** Path to the version cache file. */
const VERSION_CACHE_PATH = join(
  os.homedir(),
  ".claude",
  "forgedock",
  "version-cache.json",
);

/**
 * Detect the installed Claude Code version and compare it against the latest
 * npm registry release.
 *
 * Results are cached at ~/.claude/forgedock/version-cache.json with a 24h TTL
 * so the npm registry is not queried on every Claude Code session.
 *
 * On cache hit (cache file exists AND cachedAt is within the last 24h):
 *   Returns the cached {installed, latest, stale, delta} directly.
 *
 * On cache miss:
 *   1. Runs `claude --version` with a 5s timeout to get the installed version.
 *   2. Runs `npm info @anthropic-ai/claude-code version` with a 5s timeout
 *      to get the latest release from the npm registry.
 *   3. Writes the result to the cache file (best-effort atomic write).
 *
 * Fail-open contract:
 *   - Never throws. Any error (ENOTFOUND, ETIMEDOUT, timeout kill, JSON parse
 *     failure, fs error) returns {version: 'unknown'}.
 *   - A partial failure (installed known, latest unknown) returns a result
 *     with stale: false so the session is not falsely flagged.
 *
 * Version string handling:
 *   - Both strings are .trim()-ed before comparison (guards against CRLF).
 *   - A semver prefix regex extracts the version number from the raw CLI output
 *     (e.g. "claude 1.0.5" → "1.0.5", "1.0.5\n" → "1.0.5").
 *   - If extraction fails, the full trimmed string is used as-is.
 *
 * Callers MUST sanitize the returned strings before injecting them into
 * stdout/session context. This function returns raw strings — sanitization
 * (via sanitizeContextValue) is the caller's responsibility.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh=false] - When true, bypass the 24h cache
 *   and query the npm registry directly. Use for `forgedock doctor --refresh`.
 *
 * <!-- fix: forge#680 -->
 *
 * @returns {Promise<VersionResult | UnknownVersionResult>}
 */
export async function detectClaudeVersion({ forceRefresh = false } = {}) {
  try {
    // --- Cache read (skipped when forceRefresh is true) ---
    if (!forceRefresh) {
      const cached = readVersionCache();
      if (cached !== null) {
        return cached;
      }
    }

    // --- Installed version ---
    const installed = getInstalledClaudeVersion();

    // --- Latest version from npm registry ---
    const latest = getLatestNpmVersion();

    // Both unknown — return early without writing a bad cache entry.
    if (installed === "unknown" && latest === "unknown") {
      return { version: "unknown" };
    }

    // --- Build result ---
    const stale =
      installed !== "unknown" &&
      latest !== "unknown" &&
      installed !== latest;

    const delta =
      installed !== "unknown" && latest !== "unknown"
        ? `${installed} → ${latest}`
        : "";

    /** @type {VersionResult} */
    const result = { installed, latest, stale, delta };

    // --- Cache write (best-effort) ---
    writeVersionCache(result);

    return result;
  } catch {
    // Fail open — never block a Claude Code session
    return { version: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read and validate the version cache file.
 *
 * Returns the cached VersionResult if the cache is fresh (within TTL),
 * or null if the cache is absent, stale, corrupt, or unreadable.
 *
 * Never throws.
 *
 * @returns {VersionResult | null}
 */
function readVersionCache() {
  try {
    if (!existsSync(VERSION_CACHE_PATH)) return null;
    const raw = readFileSync(VERSION_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    // Validate required fields
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.cachedAt !== "number" ||
      typeof parsed.installed !== "string" ||
      typeof parsed.latest !== "string"
    ) {
      return null;
    }
    // Check TTL
    if (Date.now() - parsed.cachedAt >= VERSION_CACHE_TTL_MS) {
      return null;
    }
    return {
      installed: parsed.installed,
      latest: parsed.latest,
      stale: parsed.stale === true,
      delta: typeof parsed.delta === "string" ? parsed.delta : "",
    };
  } catch {
    return null;
  }
}

/**
 * Write the version result to the cache file using an atomic tmp+rename pattern.
 *
 * Best-effort — never throws. A concurrent session may overwrite this write;
 * that is acceptable (last-write-wins, all writers produce equivalent data).
 *
 * @param {VersionResult} result
 */
function writeVersionCache(result) {
  try {
    const cacheDir = dirname(VERSION_CACHE_PATH);
    mkdirSync(cacheDir, { recursive: true });
    const payload = JSON.stringify({ ...result, cachedAt: Date.now() });
    const tmp = `${VERSION_CACHE_PATH}.tmp`;
    writeFileSync(tmp, payload, "utf-8");
    renameSync(tmp, VERSION_CACHE_PATH);
  } catch {
    // Cache write failure is non-fatal — next session will query again
  }
}

/**
 * Run `claude --version` and return the trimmed version string.
 *
 * The output is expected to be one of:
 *   - "1.0.5"           (bare semver)
 *   - "claude 1.0.5"    (tool name prefix)
 *   - "@anthropic-ai/claude-code/1.0.5 node/22.0.0 ..."  (long form)
 *
 * A semver extraction regex pulls the first \d+\.\d+\.[\w.-]+ match from the
 * raw output. If nothing matches, the full trimmed first line is returned.
 *
 * Returns "unknown" if the command fails, times out, or produces no output.
 *
 * Never throws.
 *
 * @returns {string}
 */
function getInstalledClaudeVersion() {
  try {
    const raw = execFileSync("claude", ["--version"], {
      encoding: "utf-8",
      timeout: VERSION_CLI_TIMEOUT_MS,
      // Suppress stderr so error output from the binary doesn't leak
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = raw.trim();
    if (!trimmed) return "unknown";
    // Extract the first semver-like token (e.g. "1.0.5", "1.0.5-beta.1")
    const match = trimmed.match(/\d+\.\d+\.[\w.-]+/);
    return match ? match[0] : trimmed.split(/\s+/)[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Run `npm info @anthropic-ai/claude-code version` and return the trimmed
 * version string.
 *
 * Returns "unknown" if the command fails, the registry is unreachable
 * (ENOTFOUND, ETIMEDOUT), or the timeout is exceeded.
 *
 * Never throws.
 *
 * @returns {string}
 */
function getLatestNpmVersion() {
  try {
    const raw = execFileSync(
      "npm",
      ["info", "@anthropic-ai/claude-code", "version", "--json"],
      {
        encoding: "utf-8",
        timeout: VERSION_CLI_TIMEOUT_MS,
        // Suppress stderr (npm progress/warning output)
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const trimmed = raw.trim();
    if (!trimmed) return "unknown";
    // npm --json wraps the version in quotes: "1.0.8"
    // JSON.parse turns it into a plain string.
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string" && parsed.length > 0) return parsed;
    } catch {
      // Not valid JSON — fall through to plain string handling
    }
    // Fallback: use the raw trimmed value if it looks like a version
    const match = trimmed.match(/\d+\.\d+\.[\w.-]+/);
    return match ? match[0] : "unknown";
  } catch {
    return "unknown";
  }
}
