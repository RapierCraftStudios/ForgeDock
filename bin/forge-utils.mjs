/**
 * bin/forge-utils.mjs — Shared pure utility functions for ForgeDock.
 *
 * Extracted from bin/hooks/session-start.mjs so they can be unit-tested
 * without importing the hook script (which calls process.exit at module
 * top-level as part of its fail-open contract).
 *
 * Exports:
 *   parseForgeYaml(raw)                    → object  (parse a forge.yaml string)
 *   sanitizeContextValue(value, max)       → string|null  (sanitize before injection)
 *   resolveModelAlias(value)               → string|null  (short alias → full model ID)
 *   parseNameStatusDiff(diffText)          → array  (parse `git diff --name-status` output)
 *   classifyCommandChanges(entries, opts)  → object (added/updated/removed/engine counts)
 *   countBreakingCommits(subjects)         → number (breaking-change commit count)
 *   parseGitHubOwnerRepo(remoteUrl)        → object|null ({owner, repo} from a git remote URL)
 *   classifyConventionalCommitLines(body)  → object (feat/fix/... counts from release notes)
 *   formatUpdateChangelogSummary(opts)     → string (git-clone mode changelog summary)
 *   formatVersionAvailableSummary(opts)    → string (npm mode changelog summary)
 *
 * Contract guarantees:
 *   - Pure: no I/O, no side effects, no global state
 *   - Safe: every exported function is internally try/catch-free where it
 *     cannot throw on any input shape (string coercion + defensive defaults);
 *     callers doing I/O (execFileSync, fetch) still wrap those calls
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

// ---------------------------------------------------------------------------
// Diff-aware changelog summary (forge#1947) — parsing & formatting helpers
// ---------------------------------------------------------------------------
//
// These functions turn raw `git diff --name-status`, `git log --pretty=%s`,
// a git remote URL, and a GitHub release body into the condensed changelog
// summary printed by `update()` in bin/forgedock.mjs. Kept pure/I/O-free here
// so they're unit-testable without spawning git or hitting the network — the
// caller (forgedock.mjs) is responsible for running the actual git/fetch
// calls and wrapping them in try/catch so a failure never blocks `update()`.

/**
 * Parse the output of `git diff --name-status <a> <b>` into structured
 * entries.
 *
 * Handles:
 *   - Plain status lines: `A\tpath`, `M\tpath`, `D\tpath`
 *   - Rename/copy lines: `R100\told\tnew` / `C100\told\tnew` — the new path
 *     is used, status is normalized to the bare letter (`R`/`C`)
 *   - Both LF and CRLF line endings
 *   - Blank lines and malformed lines are skipped rather than throwing
 *
 * @param {string} diffText - Raw stdout from `git diff --name-status`.
 * @returns {Array<{status: string, path: string}>}
 */
export function parseNameStatusDiff(diffText) {
  const entries = [];
  if (typeof diffText !== "string" || !diffText.trim()) return entries;

  for (const line of diffText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t").filter((p) => p.length > 0);
    if (parts.length < 2) continue;

    const rawStatus = parts[0];
    const status = rawStatus.charAt(0).toUpperCase();
    // Rename/copy lines carry two paths (old, new) — the working path after
    // the change is the last field.
    const path = parts[parts.length - 1];
    if (!path) continue;

    entries.push({ status, path });
  }

  return entries;
}

/**
 * Classify parsed diff entries into command/engine change counts.
 *
 * `commands/` files are ForgeDock's slash-command specs — Added counts as
 * "commands added", Deleted as "removed", everything else (Modified,
 * Renamed, Copied) as "updated". `bin/engine/` files are counted as a single
 * "engine changed" bucket regardless of status, since the changelog summary
 * only needs to flag that the durable-run engine moved, not the granularity
 * of how.
 *
 * @param {Array<{status: string, path: string}>} entries - From parseNameStatusDiff.
 * @param {{commandsPrefix?: string, enginePrefix?: string}} [opts]
 * @returns {{commandsAdded: number, commandsUpdated: number, commandsRemoved: number, engineChanged: number}}
 */
export function classifyCommandChanges(entries, opts = {}) {
  const commandsPrefix = opts.commandsPrefix ?? "commands/";
  const enginePrefix = opts.enginePrefix ?? "bin/engine/";

  const result = {
    commandsAdded: 0,
    commandsUpdated: 0,
    commandsRemoved: 0,
    engineChanged: 0,
  };

  if (!Array.isArray(entries)) return result;

  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string") continue;
    const normalizedPath = entry.path.replace(/\\/g, "/");

    if (normalizedPath.startsWith(enginePrefix)) {
      result.engineChanged++;
      continue;
    }

    if (normalizedPath.startsWith(commandsPrefix)) {
      if (entry.status === "A") result.commandsAdded++;
      else if (entry.status === "D") result.commandsRemoved++;
      else result.commandsUpdated++;
    }
  }

  return result;
}

/**
 * Count commit subject lines that signal a breaking change, using the
 * Conventional Commits convention: a `!` immediately before the `:` in the
 * type/scope prefix (e.g. `feat(cli)!: drop legacy flag`), or a
 * `BREAKING CHANGE` marker anywhere in the subject.
 *
 * @param {string[]} subjects - Commit subject lines (e.g. from `git log --pretty=%s`).
 * @returns {number}
 */
export function countBreakingCommits(subjects) {
  if (!Array.isArray(subjects)) return 0;
  const breakingPrefix = /^\w+(\([^)]*\))?!:/;
  let count = 0;
  for (const subject of subjects) {
    if (typeof subject !== "string") continue;
    if (breakingPrefix.test(subject) || subject.includes("BREAKING CHANGE")) {
      count++;
    }
  }
  return count;
}

/**
 * Extract `{owner, repo}` from a git remote URL, supporting the common forms
 * GitHub remotes take:
 *   - `https://github.com/owner/repo.git`
 *   - `https://github.com/owner/repo`
 *   - `git@github.com:owner/repo.git`
 *   - `ssh://git@github.com/owner/repo.git`
 *
 * Returns null (never throws) for non-GitHub remotes or unparseable input —
 * callers should treat null as "omit the link" rather than failing.
 *
 * @param {string} remoteUrl - Output of `git remote get-url origin`.
 * @returns {{owner: string, repo: string}|null}
 */
export function parseGitHubOwnerRepo(remoteUrl) {
  if (typeof remoteUrl !== "string" || !remoteUrl.trim()) return null;
  const trimmed = remoteUrl.trim();

  const patterns = [
    /^(?:https?:\/\/)(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  }

  return null;
}

/**
 * Classify a GitHub auto-generated release body ("What's Changed" style —
 * a bullet list of `* type(scope): description by @user in .../pull/N`
 * lines) into conventional-commit-type counts, plus a breaking-change count.
 *
 * Unrecognized/non-conventional bullet lines are counted under "other" so
 * the total always reflects every listed entry.
 *
 * @param {string} body - Raw release body (markdown).
 * @returns {{counts: Record<string, number>, breakingCount: number}}
 */
export function classifyConventionalCommitLines(body) {
  const counts = {};
  let breakingCount = 0;
  if (typeof body !== "string" || !body.trim()) {
    return { counts, breakingCount };
  }

  const bulletPattern = /^\s*[*-]\s+(.+)$/;
  const typePattern = /^(\w+)(\([^)]*\))?(!)?:\s*/;

  for (const line of body.split(/\r?\n/)) {
    const bulletMatch = line.match(bulletPattern);
    if (!bulletMatch) continue;
    const rest = bulletMatch[1];

    const typeMatch = rest.match(typePattern);
    const type = typeMatch ? typeMatch[1].toLowerCase() : "other";
    counts[type] = (counts[type] || 0) + 1;

    if ((typeMatch && typeMatch[3] === "!") || rest.includes("BREAKING CHANGE")) {
      breakingCount++;
    }
  }

  return { counts, breakingCount };
}

/**
 * Build the condensed changelog summary printed after a successful
 * git-clone-mode update (`update()`'s fast-forward-merge branch in
 * bin/forgedock.mjs). Always returns at least a headline — never an empty
 * string — so the caller can print unconditionally when it has data to pass.
 *
 * @param {object} opts
 * @param {string} [opts.fromVersion] - package.json version before the merge.
 * @param {string} [opts.toVersion] - package.json version after the merge.
 * @param {number} [opts.commandsAdded]
 * @param {number} [opts.commandsUpdated]
 * @param {number} [opts.commandsRemoved]
 * @param {number} [opts.engineChanged]
 * @param {number} [opts.breakingCount]
 * @param {string} [opts.compareUrl] - Link to the full diff/changelog.
 * @returns {string}
 */
export function formatUpdateChangelogSummary(opts = {}) {
  const {
    fromVersion,
    toVersion,
    commandsAdded = 0,
    commandsUpdated = 0,
    commandsRemoved = 0,
    engineChanged = 0,
    breakingCount = 0,
    compareUrl,
  } = opts;

  const versionLabel =
    fromVersion && toVersion && fromVersion !== toVersion
      ? `v${fromVersion} -> v${toVersion}`
      : toVersion
        ? `v${toVersion}`
        : null;

  const bullets = [];
  if (commandsAdded) {
    bullets.push(`${commandsAdded} command${commandsAdded === 1 ? "" : "s"} added`);
  }
  if (commandsRemoved) {
    bullets.push(`${commandsRemoved} removed`);
  }
  if (commandsUpdated) {
    bullets.push(`${commandsUpdated} updated`);
  }
  if (engineChanged) {
    bullets.push(`engine: ${engineChanged} file${engineChanged === 1 ? "" : "s"} changed`);
  }

  const headline = versionLabel ? `Updated ${versionLabel}` : "Updated";
  const lines = [bullets.length ? `${headline}: ${bullets.join(", ")}` : `${headline}.`];

  if (breakingCount > 0) {
    lines.push(
      `  ${breakingCount} breaking change${breakingCount === 1 ? "" : "s"} — review before continuing.`,
    );
  }
  if (compareUrl) {
    lines.push(`  See full changelog: ${compareUrl}`);
  }

  return lines.join("\n");
}

/**
 * Build the condensed changelog summary printed after `update()` detects a
 * newer version is available in npm/npx mode (where the tool never runs the
 * update itself, so no local before/after diff exists — the summary is
 * sourced from the newest published GitHub release's notes instead).
 *
 * @param {object} opts
 * @param {string} opts.currentVersion - Installed package.json version.
 * @param {string} opts.latestVersion - Latest published version.
 * @param {Record<string, number>} [opts.typeCounts] - From classifyConventionalCommitLines.
 * @param {number} [opts.breakingCount]
 * @param {string} [opts.releaseUrl] - Link to the release notes.
 * @returns {string}
 */
export function formatVersionAvailableSummary(opts = {}) {
  const {
    currentVersion,
    latestVersion,
    typeCounts = {},
    breakingCount = 0,
    releaseUrl,
  } = opts;

  const parts = Object.entries(typeCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${count} ${type}`);

  const headline =
    currentVersion && latestVersion
      ? `Changelog v${currentVersion} -> v${latestVersion}`
      : "Changelog";

  const lines = [parts.length ? `${headline}: ${parts.join(", ")}` : `${headline}.`];

  if (breakingCount > 0) {
    lines.push(
      `  ${breakingCount} breaking change${breakingCount === 1 ? "" : "s"} — review before updating.`,
    );
  }
  if (releaseUrl) {
    lines.push(`  See full changelog: ${releaseUrl}`);
  }

  return lines.join("\n");
}
