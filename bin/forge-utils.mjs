/**
 * bin/forge-utils.mjs — Shared pure utility functions for ForgeDock.
 *
 * Extracted from bin/hooks/session-start.mjs so they can be unit-tested
 * without importing the hook script (which calls process.exit at module
 * top-level as part of its fail-open contract).
 *
 * Exports:
 *   parseForgeYaml(raw)               → object  (parse a forge.yaml string)
 *   sanitizeContextValue(value, max)  → string|null  (sanitize before injection)
 *   resolveModelAlias(value)          → string|null  (short alias → full model ID)
 *
 * Contract guarantees:
 *   - Pure: no I/O, no side effects, no global state
 *   - Safe: both functions are try/catch-free at the module level; individual
 *     helpers never throw
 *   - Isolated: imports no external modules
 */

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
// Model alias resolution
// ---------------------------------------------------------------------------

/**
 * Short model aliases mapped to their current full Anthropic model IDs.
 *
 * These are the same aliases accepted by the Agent/Task tool's `model`
 * parameter in Claude Code (enum: "sonnet" | "opus" | "haiku" | "fable").
 * forge.yaml's `agents.default_model` field is documented to use one of
 * these aliases so the same configured value drives both interactive
 * (Agent/Task tool) and headless (bin/runner.mjs, raw Anthropic SDK) use.
 *
 * Keep in sync with the other hardcoded model IDs in this codebase (e.g.
 * bin/runner.mjs's DEFAULT_MODEL, bin/init-enrich-api.mjs's ENRICH_MODEL)
 * if those are ever bumped.
 */
const MODEL_ALIASES = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-6",
  haiku: "claude-haiku-4-5",
};

/**
 * Resolve a forge.yaml `agents.default_model` value to a full Anthropic
 * model ID, for use with the raw Anthropic SDK (bin/runner.mjs).
 *
 * Recognized short aliases ("sonnet", "opus", "haiku" — case-insensitive)
 * are mapped to their current full model ID via MODEL_ALIASES. Any other
 * non-empty string is returned unchanged (pass-through), so a full model ID
 * configured directly still works for the headless runner — though it will
 * NOT work for interactive Agent/Task tool calls in command specs, which
 * only accept the short-alias enum. This constraint is documented in
 * docs/CONFIG.md and forge.yaml.example.
 *
 * Never throws. Returns null for null/undefined/empty input.
 *
 * @param {string|null|undefined} value - Raw `agents.default_model` value.
 * @returns {string|null}
 */
export function resolveModelAlias(value) {
  try {
    if (value == null) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    const alias = MODEL_ALIASES[trimmed.toLowerCase()];
    return alias ?? trimmed;
  } catch {
    return null;
  }
}
