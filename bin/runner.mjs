/**
 * bin/runner.mjs — Standalone command runner for ForgeDock.
 *
 * Decouples ForgeDock from the Claude Code agent loop. Instead of relying on
 * Claude Code to read a `commands/*.md` spec as a slash command, this runner
 * loads the same spec, assembles a system prompt, and drives an Anthropic
 * tool-use loop directly via the Claude SDK — enabling CI/CD runs, headless
 * batch processing, and non-Claude-Code users.
 *
 * This is the foundational increment of the standalone runtime (issue #1151):
 * a generic spec-driven `run` path. Broader per-command parity, subagent
 * spawning, and streaming UI are tracked as follow-ups.
 *
 * Exports:
 *   resolveSpecPath(commandsDir, name)      → string|null   (spec file path)
 *   listCommands(commandsDir)               → string[]      (available command names)
 *   loadCommandSpec(commandsDir, name)      → {path,name,content}
 *   buildSystemPrompt(spec, opts)           → string
 *   buildCliSystemPrompt(spec)              → string        (cli-backend system prompt)
 *   buildUserMessage(name, args)            → string
 *   TOOL_DEFINITIONS                        → object[]      (Anthropic tool schemas)
 *   truncateToolResult(content)             → string        (cap + truncation marker)
 *   resolveBashShell()                      → string|undefined (explicit shell for run_bash)
 *   getToolHandlers(cwd)                    → Record<string, fn>
 *   renderDryRun(ctx)                       → string
 *   renderSummaryCard(ctx)                  → string
 *   resolveConfiguredDefaultModel(cwd)      → string|null   (forge.yaml agents.default_model, resolved)
 *   runCommand(opts)                        → Promise<{status, ...}>
 *
 * Design notes:
 *   - The Anthropic SDK is a LAZY/optional dependency: it is imported only when
 *     a live run is requested (`--dry-run` and all pure helpers need no SDK and
 *     no network), keeping `npm install`/`npm test` dependency-free.
 *   - The API key is read from ANTHROPIC_API_KEY only — never written to disk
 *     or logged.
 *   - Path resolution is Windows-safe: command names use `/` separators and are
 *     joined with `path` segments. Path traversal (`..`) is rejected.
 */

import {
  readFileSync,
  existsSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
} from "fs";
import { join, dirname, basename, relative, isAbsolute } from "path";
import os from "os";
import { execSync, spawnSync } from "child_process";
import { parseForgeYaml, resolveModelAlias } from "./forge-utils.mjs";
import { DEFAULT_SPAWN_MAX_BUFFER_BYTES } from "./cli-spawn-shared.mjs";

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_MAX_TOKENS = 16384;
// Default wall-clock limit for a single run_bash command. Chosen to be
// generous enough for CI steps (git clones, test suites) while bounding
// the worst-case hang to 5 minutes. Override via FORGEDOCK_BASH_TIMEOUT (ms).
const DEFAULT_BASH_TIMEOUT_MS = 5 * 60 * 1000;
// Default wall-clock limit for a single `claude --print` CLI-backend
// invocation (issue #2003). This bounds an entire command run (the CLI's own
// internal tool-use loop), not one bash step, so it is deliberately larger
// than DEFAULT_BASH_TIMEOUT_MS. Override via FORGEDOCK_CLI_TIMEOUT_MS (ms).
const DEFAULT_CLI_TIMEOUT_MS = 15 * 60 * 1000;
// Short bound for the `claude --version` presence probe used by backend
// auto-detection — this must never make --dry-run (or a live run) hang, so
// it is far shorter than DEFAULT_CLI_TIMEOUT_MS. Mirrors the timeout already
// used by the `claude --version` doctor check in bin/forgedock.mjs.
const CLI_PROBE_TIMEOUT_MS = 5000;
/**
 * Wraps a Set in a Proxy that blocks add()/delete()/clear(), so the
 * returned collection is genuinely read-only — not just Object.frozen.
 *
 * Note: `Object.freeze(new Set(...))` does NOT prevent mutation. Set's
 * mutator methods (add/delete/clear) operate on an internal [[SetData]]
 * slot, not on the object's own enumerable properties, so Object.freeze()
 * — which only locks down property descriptors — has no effect on them;
 * `.add()` on a frozen Set still silently succeeds. A Proxy trapping the
 * mutator method names is the only reliable way to make a Set read-only.
 *
 * Two known, intentionally-accepted deviations from a plain Set (neither
 * is exercised by any current caller — grep confirms only `.has()` and
 * spread/iteration are used):
 *   - `structuredClone()` throws on a Proxy (no native [[SetData]] slot to
 *     brand-check), where it would succeed on a plain Set.
 *   - Without the `constructor` passthrough below, `.constructor` would
 *     resolve to a bound wrapper rather than `Set` itself. Special-cased
 *     here so `VALID_BACKENDS.constructor === Set` still holds.
 */
function readOnlySet(values) {
  const target = new Set(values);
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "add" || prop === "delete" || prop === "clear") {
        return () => {
          throw new TypeError(
            "VALID_BACKENDS is read-only and must not be mutated.",
          );
        };
      }
      // Return the real Set constructor, not a bound wrapper — keeps
      // `VALID_BACKENDS.constructor === Set` true, matching a plain Set.
      if (prop === "constructor") return Set;
      const value = Reflect.get(t, prop, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

/**
 * Valid values for the `backend` option / --backend flag / FORGEDOCK_BACKEND
 * env. Exported (issue #2013) so bin/forgedock.mjs's CLI-layer `--backend`
 * flag validation can reuse this exact Set instead of maintaining its own
 * independently-hardcoded copy — keeps both layers' "Must be one of: ..."
 * error messages structurally unable to drift apart.
 *
 * Read-only (issue #2075): every importer (bin/engine.mjs, bin/forgedock.mjs)
 * holds a reference to this exact instance, not a copy. Without the
 * read-only wrapper above, any consumer calling .add()/.delete()/.clear()
 * on it would silently change the accepted backend values — and the "Must
 * be one of: ..." error-message wording — for every other consumer
 * simultaneously. Treat it as immutable; mutation attempts throw.
 */
export const VALID_BACKENDS = readOnlySet(["cli", "api", "auto"]);
// Per-process memoization for isClaudeCliAvailable(), keyed by `cwd` (issue
// #2011). `runCommand()` calls resolveBackend() — and therefore, for the
// default "auto" backend, isClaudeCliAvailable() — unconditionally on every
// invocation, including every `--dry-run`. Without caching, a process that
// calls runCommand() repeatedly (e.g. bin/batch-runner.mjs driving many
// commands, or an orchestration loop) re-spawns `claude --version` on every
// single call.
//
// Bounded on two axes (issues #2057, #2058 — review findings on PR #2056):
//   1. TTL (`CLI_AVAILABILITY_CACHE_TTL_MS`): an entry older than the TTL is
//      treated as absent and re-probed, so a `claude` install/uninstall that
//      happens mid-run of a long-lived process (e.g. an orchestration loop)
//      is picked up within one TTL window instead of staying stale for the
//      rest of the process's lifetime.
//   2. Max size (`CLI_AVAILABILITY_CACHE_MAX_SIZE`): entries beyond the cap
//      evict the oldest (insertion-order, via `Map`'s iteration order and a
//      delete+re-set on refresh) so a process that probes an unbounded
//      number of distinct `cwd` values cannot grow this cache without limit.
// Each entry stores `{ available, cachedAt }` instead of a bare boolean so
// `isClaudeCliAvailable()` can evaluate the TTL.
const CLI_AVAILABILITY_CACHE_TTL_MS = 60_000;
const CLI_AVAILABILITY_CACHE_MAX_SIZE = 100;
const cliAvailabilityCache = new Map();
// Cap tool-result payloads so a large file read or verbose command does not
// blow the context window in a single turn.
const MAX_TOOL_RESULT_CHARS = 100_000;
// Sentinel appended to a tool result that was sliced to MAX_TOOL_RESULT_CHARS,
// so the model can tell its input was cut rather than treating it as complete.
const TRUNCATION_MARKER = "\n…[truncated]";

/**
 * Cap a tool-result string to MAX_TOOL_RESULT_CHARS, appending a visible
 * truncation marker when (and only when) the content was actually sliced.
 * Short results are returned unchanged.
 *
 * @param {string} content
 * @returns {string}
 */
export function truncateToolResult(content) {
  const str = String(content ?? "");
  if (str.length <= MAX_TOOL_RESULT_CHARS) return str;
  return str.slice(0, MAX_TOOL_RESULT_CHARS) + TRUNCATION_MARKER;
}

/**
 * Resolve the project-configured default model from forge.yaml's
 * `agents.default_model` field, if present.
 *
 * Reads `{cwd}/forge.yaml` (a fixed, non-agent-controlled filename — not the
 * LLM-facing `resolveConfinedPath` path-confinement helper used for tool-call
 * paths below), parses it with the shared `parseForgeYaml`, and resolves the
 * `agents.default_model` alias (`sonnet`/`opus`/`haiku`, or a pass-through
 * full model ID) via `resolveModelAlias`.
 *
 * Fail-soft: returns `null` on any failure (forge.yaml missing, unreadable,
 * malformed, or the field absent) so the headless runner keeps working with
 * zero configuration — this is a fallback tier, not a requirement.
 *
 * @param {string} cwd - Working directory to look for forge.yaml in.
 * @returns {string|null}
 */
export function resolveConfiguredDefaultModel(cwd) {
  try {
    const forgeYamlPath = join(cwd, "forge.yaml");
    if (!existsSync(forgeYamlPath)) return null;
    const raw = readFileSync(forgeYamlPath, "utf-8");
    const parsed = parseForgeYaml(raw);
    const configured = parsed?.agents?.default_model;
    return resolveModelAlias(configured);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backend selection (issue #2003) — CLI vs API execution backend
// ---------------------------------------------------------------------------

/**
 * Probe whether the Claude Code CLI (`claude`) is present and responds on
 * this machine, so `forgedock run` can drive it directly instead of
 * requiring a separate, billable ANTHROPIC_API_KEY.
 *
 * Deliberately uses `execSync("claude --version", ...)` — a single command
 * *string* executed through a shell — rather than
 * `execFileSync("claude", [...])`. On Windows, `claude` is installed as a
 * `claude.cmd` shim; `execFileSync` does not resolve `.cmd` shims and throws
 * ENOENT even though the CLI is genuinely installed and on PATH (this exact
 * regression previously made an unrelated skill-based enrichment backend
 * silently dead on Windows — see issue #382). `execSync` always runs its
 * command through a shell, which resolves PATHEXT-registered `.cmd`/`.bat`
 * shims correctly on Windows and behaves identically on POSIX. This mirrors
 * the pre-existing `claude --version` doctor check in bin/forgedock.mjs.
 *
 * Bounded by CLI_PROBE_TIMEOUT_MS so a hung or misbehaving `claude` binary
 * can never make backend resolution (and therefore --dry-run, or the start
 * of a live run) hang indefinitely. Any failure — not installed, not on
 * PATH, times out, non-zero exit — is treated as "not available" and never
 * throws; the caller (resolveBackend) falls back to the API backend.
 *
 * Memoized per `cwd` for up to `CLI_AVAILABILITY_CACHE_TTL_MS` (see
 * `cliAvailabilityCache` above, issues #2011, #2057, #2058) — the first call
 * for a given `cwd` pays the probe cost; every subsequent call for that same
 * `cwd` within the TTL window returns the cached result instantly, with no
 * new child process spawned. Once the TTL elapses the entry is treated as
 * absent and re-probed, and the cache never grows past
 * `CLI_AVAILABILITY_CACHE_MAX_SIZE` distinct `cwd` entries (oldest evicted
 * first).
 *
 * @param {string} [cwd] - Working directory for the probe (default cwd).
 * @param {object} [opts]
 * @param {typeof execSync} [opts.execImpl] - Test seam only — production
 *   callers must never override this; built-in ESM modules like
 *   `node:child_process` export non-configurable bindings that `node:test`'s
 *   `mock.method` cannot redefine, so tests inject a stub here directly
 *   instead. Mirrors the existing `bin` test-seam parameter on
 *   `runCliBackend()`.
 * @returns {boolean}
 */
export function isClaudeCliAvailable(cwd = process.cwd(), { execImpl = execSync } = {}) {
  const cached = cliAvailabilityCache.get(cwd);
  if (cached && Date.now() - cached.cachedAt < CLI_AVAILABILITY_CACHE_TTL_MS) {
    return cached.available;
  }
  let available;
  try {
    execImpl("claude --version", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      timeout: CLI_PROBE_TIMEOUT_MS,
    });
    available = true;
  } catch {
    available = false;
  }
  // Re-inserting an existing key moves it to the end of Map's iteration
  // order (delete+set), so eviction below always drops the true oldest
  // entry — whether "oldest" means "never refreshed" or "not refreshed in
  // the longest time."
  cliAvailabilityCache.delete(cwd);
  cliAvailabilityCache.set(cwd, { available, cachedAt: Date.now() });
  if (cliAvailabilityCache.size > CLI_AVAILABILITY_CACHE_MAX_SIZE) {
    const oldestKey = cliAvailabilityCache.keys().next().value;
    cliAvailabilityCache.delete(oldestKey);
  }
  return available;
}

/**
 * Shared backend-resolution primitive (issue #2026) used by both
 * `resolveBackend()` (below, `forgedock run`'s engine ladder — issue #2003)
 * and `resolveEnrichBackend()` (bin/init-enrich.mjs's init-enrichment
 * ladder — issue #2004). Both ladders share the exact same two steps — an
 * explicit override wins outright, otherwise probe the local Claude Code
 * CLI and prefer it when present — but diverge on (a) which override
 * values are valid and whether an invalid one throws or is silently
 * ignored, and (b) what to return when the CLI probe fails (`resolveBackend`
 * always falls back to `"api"`; `resolveEnrichBackend` falls back to `"api"`
 * only if `ANTHROPIC_API_KEY` is set, else `"none"`). Rather than force
 * those into one shape, this shared helper implements exactly the common
 * two steps and defers to a `cliFallback` callback for the diverging tail,
 * and defers override *validation* (throw vs. fall-through) entirely to
 * the caller — this function only performs a membership check, it never
 * throws. This removes the duplicated CLI-probe-and-branch logic while
 * preserving each caller's distinct, already-shipped behavior byte-for-byte.
 *
 * @param {object} opts
 * @param {string} [opts.override] - Pre-validated override value. Returned
 *   as-is when it is a member of `validOverrides`; otherwise ignored (the
 *   caller is responsible for deciding whether an unrecognized value should
 *   throw or fall through — this helper never throws).
 * @param {Set<string>} opts.validOverrides - The set of override values this
 *   caller accepts outright.
 * @param {string} [opts.cwd] - Working directory for the CLI probe.
 * @param {Function} [opts.isCliAvailableFn] - Injectable CLI-presence probe.
 *   Defaults to `isClaudeCliAvailable` (which is itself memoized per `cwd` —
 *   issue #2011). Callers MUST pass this through rather than reimplementing
 *   probing, to preserve that cache.
 * @param {Function} opts.cliFallback - Called (no args) when no valid
 *   override was given AND the CLI probe failed. Must return the caller's
 *   fallback backend value (e.g. `"api"`, or `"api"|"none"` depending on an
 *   API key check).
 * @returns {string} The resolved backend value.
 */
export function resolveBackendLadder({
  override,
  validOverrides,
  cwd = process.cwd(),
  isCliAvailableFn = isClaudeCliAvailable,
  cliFallback,
}) {
  if (override !== undefined && validOverrides.has(override)) return override;
  if (isCliAvailableFn(cwd)) return "cli";
  return cliFallback();
}

/**
 * Resolve which execution backend `runCommand()` should use.
 *
 * Ladder (issue #2003):
 *   1. An explicit `"cli"` or `"api"` request always wins outright — no
 *      probing, no fallback. This is what `--backend cli|api` and
 *      `FORGEDOCK_BACKEND=cli|api` produce.
 *   2. `"auto"` (the default) probes `isClaudeCliAvailable()`: prefers the
 *      CLI backend when a working `claude` install is detected (reuses
 *      whatever credentials the CLI already has — Pro/Max OAuth or a
 *      CLI-managed key — with no ANTHROPIC_API_KEY required), otherwise
 *      falls back to the API backend unchanged (existing behavior for every
 *      caller that never opts in to this feature).
 *
 * Delegates its shared "override-or-probe-CLI" shape to
 * `resolveBackendLadder()` (issue #2026) — this function retains its own
 * `VALID_BACKENDS` throw-on-invalid check (NOT shared; see that helper's
 * doc comment) and its own no-API-key-check fallback (always `"api"`,
 * unconditionally — the API key itself is validated lazily downstream, only
 * if/when the api backend is actually selected).
 *
 * @param {object} [opts]
 * @param {string} [opts.requested] - "cli" | "api" | "auto" (default "auto").
 * @param {string} [opts.cwd]       - Working directory for the CLI probe.
 * @returns {"cli"|"api"}
 */
export function resolveBackend({ requested = "auto", cwd = process.cwd() } = {}) {
  if (!VALID_BACKENDS.has(requested)) {
    throw new Error(
      `Invalid backend "${requested}". Must be one of: ${[...VALID_BACKENDS].join(", ")}.`,
    );
  }
  return resolveBackendLadder({
    override: requested === "auto" ? undefined : requested,
    validOverrides: new Set(["cli", "api"]),
    cwd,
    cliFallback: () => "api",
  });
}

/**
 * Run a command via the local Claude Code CLI instead of the Anthropic SDK
 * (issue #2003's "cli" backend). Shells out to headless print mode
 * (`claude --print "<message>" --dangerously-skip-permissions`), reusing
 * whatever the CLI is already authenticated with — no ANTHROPIC_API_KEY is
 * read or required anywhere on this path.
 *
 * SECURITY — argv array, NEVER `shell: true`: `userMessage` is built from
 * `buildUserMessage(commandName, args)`, and `args` originates from
 * user-supplied CLI arguments to `forgedock run <command> <args...>` — it is
 * untrusted input from this function's point of view. `spawnSync("claude",
 * [...argv], { shell: false (default) })` passes each argument as a discrete,
 * unparsed argv element: the target process receives `userMessage` as one
 * literal string, with no shell ever tokenizing or expanding it, so shell
 * metacharacters (`$(...)`, backticks, `;`, `&&`, `|`, `!`) inside it cannot
 * trigger command injection. An earlier version of this function built a
 * shell command *string* (`claude --print "<quoted message>" ...`) run via
 * `spawnSync(command, { shell: true })` with hand-rolled quoting
 * (backslash/double-quote escaping only) — that does NOT neutralize
 * `$(...)`/backtick/`!` expansion inside POSIX double quotes and was an
 * exploitable injection (verified: a crafted `userMessage` could execute
 * arbitrary shell commands with this process's privileges). Do not
 * reintroduce `shell: true` or string-command interpolation here.
 *
 * Windows `.cmd` shim resolution works WITHOUT `shell: true`: Node's
 * spawn/spawnSync resolve a bare `"claude"` command via PATH+PATHEXT and
 * safely re-invoke through cmd.exe internally when the resolved target is a
 * `.cmd`/`.bat` file, using a properly escaped mechanism, and argv elements
 * are never parsed as shell syntax (verified empirically on Windows: a
 * malicious-looking argv element is delivered to the child process
 * byte-for-byte, not executed). This is the correct fix for the
 * `execFileSync("claude", [...])` ENOENT-on-Windows regression from issue
 * #382 — that regression was about USING execFileSync with an unresolved
 * bare command name in an older/incompatible way, not about needing
 * `shell: true`; spawnSync's own PATH/PATHEXT resolution (unlike
 * execFileSync's, in the failure mode #382 hit) handles the `.cmd` shim
 * transparently here.
 *
 * `--dangerously-skip-permissions` mirrors the established headless-CI
 * invocation pattern already documented in docs/CI.md and
 * templates/workflows/forgedock-review.yml: without it, the CLI would block
 * on an interactive permission prompt that a headless caller can never
 * answer, hanging until FORGEDOCK_CLI_TIMEOUT_MS/DEFAULT_CLI_TIMEOUT_MS
 * kills it.
 *
 * SYSTEM PROMPT / COMMAND SPEC DELIVERY (issue #2019): `systemPrompt` (built
 * by `buildCliSystemPrompt(spec)` — see below) is written to a private
 * temp file and forwarded via `--append-system-prompt-file <path>`, NOT
 * passed inline as a `--system-prompt`/`--append-system-prompt` argv string.
 * Two reasons this matters:
 *   1. Size: a command spec like `commands/work-on.md` is 100+ KB, and the
 *      full `commands/*.md` corpus is over 1MB. Windows' CreateProcess has a
 *      ~32K character command-line limit; spawnSync here uses `shell: false`
 *      so it hits that OS-level argv limit directly. A file path is always
 *      short regardless of spec size.
 *   2. Semantics: `--append-system-prompt-file` *appends* to the CLI's own
 *      default system prompt (tool descriptions, environment info, etc.),
 *      matching how a real `/work-on` slash-command invocation inside Claude
 *      Code behaves — the ForgeDock spec augments the CLI's native
 *      capabilities rather than replacing them. `--system-prompt-file` would
 *      instead *replace* the CLI's default prompt entirely, which would
 *      strip the CLI of its own operating instructions.
 * The temp file lives in a per-call `mkdtempSync` directory and is always
 * removed in a `finally` block, covering the timeout/spawn-error/non-zero-exit
 * paths as well as the success path.
 *
 * Model selection is intentionally NOT forwarded to the CLI in this first
 * increment — the CLI backend uses whatever model the `claude` CLI itself is
 * configured for. `opts.model`/FORGEDOCK_MODEL only affects the API backend.
 * Likewise, structured token usage is not available the same way the
 * Anthropic SDK exposes it; `usage` is reported as `null` (an already
 * fully-supported value throughout renderSummaryCard/renderDryRun).
 *
 * @param {object} opts
 * @param {{path: string, name: string, content: string}} opts.spec
 * @param {string} opts.userMessage
 * @param {string} [opts.systemPrompt] - CLI-appropriate system prompt (see
 *   `buildCliSystemPrompt`), forwarded via `--append-system-prompt-file`.
 *   Omitted/empty is tolerated (no flag is added) so existing callers that
 *   have not been updated yet do not break, but production callers should
 *   always supply it — see issue #2019.
 * @param {string[]} [opts.args]
 * @param {string} opts.cwd
 * @param {{log: Function, error?: Function}} [opts.logger]
 * @param {string} [opts.bin] - Executable to invoke (default "claude"). Test
 *   seam only — production callers must never override this; it exists so
 *   tests can point at a controlled fake binary instead of either invoking
 *   the real `claude` CLI (slow, non-deterministic, real side effects) or
 *   fighting platform-specific PATH-resolution semantics to shim "claude"
 *   itself (Windows resolves a bare executable name via the *calling*
 *   process's search path at the OS level, which is not reliably
 *   overridable per-call from within the same process).
 * @param {Function} [opts.spawnFn] - Injectable replacement for
 *   `child_process.spawnSync` (default `spawnSync`). Test seam only —
 *   production callers must never override this. Mirrors the identical
 *   `spawnFn` seam on `bin/init-enrich-cli.mjs`'s `enrich()` (issue #2033):
 *   both functions spawn the local `claude` CLI in headless print mode, so
 *   sharing the same seam shape lets tests exercise both with equivalent
 *   fixtures and makes future divergence between the two easier to catch.
 *   This is additive to the existing `bin` override seam above — tests may
 *   still use a real fake-binary-on-disk + real `spawnSync` (the original
 *   seam), or fully mock the call via `spawnFn` (no fake binary needed).
 * @returns {{status: string, command: string, iterations: number, stopReason: string, usage: null, model: string, backend: "cli"}}
 */

// Diagnostic-only bound on each logged argv element (see sanitizeArgvForLog
// below) — independent of DEFAULT_SPAWN_MAX_BUFFER_BYTES, which governs the
// actual child process's stdout/stderr capture, not this summary string.
const MAX_LOGGED_ARGV_ELEMENT_LEN = 200;

/**
 * Build a safe-for-logs/error-messages summary of a CLI argv array.
 *
 * `cliArgs` (see `runCliBackend` below) includes `userMessage` verbatim, and
 * `userMessage` is built from untrusted third-party content (issue/PR bodies
 * fetched via `gh` — see the SECURITY note in `bin/engine.mjs`). The
 * non-zero-exit diagnostic added in #2258 embeds `cliArgs.join(" ")` directly
 * into a thrown `Error.message`, which `bin/forgedock.mjs`'s `run-issue` case
 * later writes verbatim to stderr (`process.stderr.write(err.message)`) — so
 * a crafted issue/PR body could otherwise inject raw ANSI escape sequences or
 * newline-heavy content into operator-visible CI/terminal logs, or simply
 * balloon log size with an arbitrarily large body (#2277).
 *
 * This function is used ONLY to build the human-readable diagnostic string —
 * it must NEVER be applied to the actual `cliArgs` array passed to `spawnFn`,
 * which must remain byte-exact for the real invocation. It intentionally
 * keeps (rather than removes) the argv/cwd context: that context is exactly
 * what #2258 added to fix a prior defect where a real CLI failure produced a
 * diagnostic pointing at output that didn't exist. The goal here is to bound
 * and neutralize each element, not to delete the context.
 *
 * - Control characters (`\x00`-`\x1F`, `\x7F`-`\x9F` — C0/DEL and C1) are
 *   escaped to a visible `\xHH` form, neutralizing ANSI escape sequences and
 *   log-line spoofing.
 * - Unicode bidirectional-override/format characters (`‪`-`‮`
 *   LRE/RLE/PDF/LRO/RLO and `⁦`-`⁩` LRI/RLI/FSI/PDI) are escaped to
 *   a visible `\uHHHH` form, neutralizing visual reordering of the diagnostic
 *   line in terminals/log viewers that render bidi controls (#2292).
 * - Each element is independently truncated to `MAX_LOGGED_ARGV_ELEMENT_LEN`
 *   characters, with an explicit `…[truncated, N chars]` marker appended
 *   when truncation occurs, so log growth is bounded regardless of how large
 *   the untrusted `userMessage` is.
 *
 * @param {string[]} cliArgs
 * @returns {string} space-joined, sanitized argv summary
 */
export function sanitizeArgvForLog(cliArgs) {
  return cliArgs
    .map((arg) => {
      const str = String(arg);
      // eslint-disable-next-line no-control-regex -- intentional: neutralizing C0/DEL/C1 control chars and Unicode bidi-override/format chars is the point of this function
      const escaped = str.replace(/[\x00-\x1F\x7F-\x9F\u202A-\u202E\u2066-\u2069]/g, (ch) => {
        const code = ch.charCodeAt(0);
        return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
      });
      if (escaped.length <= MAX_LOGGED_ARGV_ELEMENT_LEN) return escaped;
      return `${escaped.slice(0, MAX_LOGGED_ARGV_ELEMENT_LEN)}…[truncated, ${escaped.length} chars]`;
    })
    .join(" ");
}

export function runCliBackend({
  spec,
  userMessage,
  systemPrompt = "",
  args = [],
  cwd,
  logger = console,
  bin = "claude",
  spawnFn = spawnSync,
}) {
  const rawTimeout = parseInt(process.env.FORGEDOCK_CLI_TIMEOUT_MS, 10);
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_CLI_TIMEOUT_MS;

  // Write the system prompt (command spec + framing) to a private temp file
  // rather than passing it inline as an argv string — see the SYSTEM PROMPT
  // block comment above for why. The directory is created fresh per call and
  // always removed in `finally`, regardless of how spawnSync exits below.
  //
  // `tmpDir` is declared here (outside `try`) so `finally` below can see it,
  // but the `mkdtempSync`/`writeFileSync` calls themselves now run *inside*
  // the `try` block (issue #2061 — review finding on PR #2060) rather than
  // before it: if either call throws (disk full, EACCES on a locked-down
  // temp dir, etc.), that throw must still be covered by the same `finally`
  // cleanup path, not bypass it. `tmpDir` is assigned immediately after
  // `mkdtempSync` succeeds — before `writeFileSync` runs — so a failure in
  // `writeFileSync` still leaves `tmpDir` set and the already-created
  // directory gets cleaned up.
  let tmpDir = null;
  let cliArgs = ["--print", userMessage, "--dangerously-skip-permissions"];

  try {
    if (systemPrompt) {
      const createdDir = mkdtempSync(join(os.tmpdir(), "forgedock-cli-system-prompt-"));
      tmpDir = createdDir;
      const systemPromptPath = join(createdDir, "system-prompt.txt");
      writeFileSync(systemPromptPath, systemPrompt, "utf-8");
      cliArgs = [
        "--print",
        userMessage,
        "--append-system-prompt-file",
        systemPromptPath,
        "--dangerously-skip-permissions",
      ];
    }

    // Scrub the Anthropic API key from the child environment. This backend
    // runs with `--dangerously-skip-permissions` (no confirmation gate on any
    // tool call, including bash), and the runner is designed to feed
    // untrusted third-party content (issue/PR bodies via gh) into the model
    // loop — so a prompt-injection payload could otherwise issue a bash
    // command that exfiltrates the key straight out of its own environment.
    // Mirrors the existing scrub in the `run_bash` tool handler below.
    // GH_TOKEN/GITHUB_TOKEN and all other env vars are intentionally left
    // intact — only the Anthropic key is removed.
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;

    // No `shell` option (defaults to false): argv is passed as discrete,
    // unparsed elements — see the SECURITY note above. This also correctly
    // resolves the Windows `.cmd` shim without needing shell:true.
    const result = spawnFn(bin, cliArgs, {
      cwd,
      encoding: "utf-8",
      maxBuffer: DEFAULT_SPAWN_MAX_BUFFER_BYTES,
      timeout: timeoutMs,
      env: childEnv,
    });

    const stdout = result.stdout ? String(result.stdout) : "";
    const stderr = result.stderr ? String(result.stderr) : "";

    // Same timeout-detection shape as run_bash below: ETIMEDOUT is the
    // authoritative Node-initiated kill signal; the elapsed-time fallback is
    // intentionally omitted here since spawnSync's own `timeout` + ETIMEDOUT is
    // reliable for this single, non-looped invocation.
    const timedOut = result.status === null && result.error?.code === "ETIMEDOUT";
    if (timedOut) {
      const timeoutSecs = Math.round(timeoutMs / 1000);
      throw new Error(
        `claude CLI invocation timed out after ${timeoutSecs}s and was killed. ` +
          `Set FORGEDOCK_CLI_TIMEOUT_MS (ms) to adjust, or use --backend api.`,
      );
    }
    if (result.error) {
      throw new Error(`Failed to invoke claude CLI: ${result.error.message}`);
    }

    const output = (stdout + stderr).trim();

    if (result.status !== 0) {
      // Non-zero exit: always emit a self-contained diagnostic, regardless of
      // whether stdout/stderr captured anything. Previously this branch threw
      // a self-referential message that unconditionally pointed to
      // previously-logged output, even when `output` was empty (the
      // success-path log call above was gated on `if (output)` and never
      // ran) -- leaving the operator with nothing to consult. See issue
      // #2258 / parent #2244.
      const hadOutput = output.length > 0;
      const signalPart = result.signal ? `, signal ${result.signal}` : "";
      // Sanitized for the diagnostic string ONLY — the actual `cliArgs` array
      // above (passed to spawnFn) is untouched. See sanitizeArgvForLog's doc
      // comment for why (#2277 — untrusted userMessage content must not reach
      // stderr/CI logs unbounded/unescaped).
      const argvSummary = sanitizeArgvForLog(cliArgs);
      const diagnostic = hadOutput
        ? `Captured output (stdout+stderr):\n${output}`
        : "No output was captured on stdout or stderr.";
      logger.log(diagnostic);

      const err = new Error(
        `claude CLI exited with status ${result.status ?? "?"}${signalPart}. ` +
          (hadOutput
            ? "See captured output above."
            : "No output was captured (stdout and stderr were both empty).") +
          ` Invocation: ${bin} ${argvSummary} (cwd: ${cwd})`,
      );
      err.code = "CLI_BACKEND_FAILED";
      throw err;
    }

    if (output) logger.log(output);

    logger.log(
      renderSummaryCard({
        command: spec.name,
        args,
        iterations: 1,
        stopReason: "cli_exit_0",
        usage: null,
      }),
    );

    return {
      status: "complete",
      command: spec.name,
      iterations: 1,
      stopReason: "cli_exit_0",
      usage: null,
      model: "cli",
      backend: "cli",
    };
  } finally {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Command spec resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a command name to its spec file under commandsDir.
 *
 * Supports flat (`work-on`) and nested (`work-on/build`,
 * `work-on/build/architect`) command names. A leading slash and a trailing
 * `.md` are tolerated. Returns null if the spec does not exist or the name is
 * empty / contains a path-traversal segment.
 *
 * @param {string} commandsDir - Absolute path to the commands/ directory.
 * @param {string} commandName - e.g. "work-on", "/review-pr", "work-on/build".
 * @returns {string|null} Absolute path to the spec file, or null.
 */
export function resolveSpecPath(commandsDir, commandName) {
  if (typeof commandName !== "string" || commandName.trim() === "") return null;
  const clean = commandName
    .trim()
    .replace(/^[\\/]+/, "")
    .replace(/\.md$/i, "");
  // Split on BOTH separators — on Windows a backslash in the name would
  // otherwise survive as a single segment and be re-normalized by path.join,
  // bypassing the traversal check below.
  const segments = clean.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return null;
  // Reject path traversal — command names must stay within commands/.
  if (segments.some((s) => s === ".." || s === ".")) return null;
  const candidate = join(commandsDir, ...segments) + ".md";
  // Defense-in-depth: the resolved path must remain inside commandsDir even
  // if a segment slipped through (belt-and-suspenders with the check above).
  const rel = relative(commandsDir, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return existsSync(candidate) ? candidate : null;
}

/**
 * List all available command names (relative to commandsDir, without .md),
 * recursing into nested directories. Names always use `/` separators
 * regardless of platform.
 *
 * @param {string} commandsDir
 * @returns {string[]} Sorted command names.
 */
export function listCommands(commandsDir) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        const rel = relative(commandsDir, full)
          .split(/[\\/]/)
          .join("/")
          .replace(/\.md$/, "");
        out.push(rel);
      }
    }
  }
  walk(commandsDir);
  return out.sort();
}

/**
 * Load a command spec. Throws a descriptive error (code UNKNOWN_COMMAND) listing
 * available commands if the name does not resolve.
 *
 * @param {string} commandsDir
 * @param {string} commandName
 * @returns {{path: string, name: string, content: string}}
 */
export function loadCommandSpec(commandsDir, commandName) {
  const path = resolveSpecPath(commandsDir, commandName);
  if (!path) {
    const available = listCommands(commandsDir);
    const err = new Error(
      `Unknown command: "${commandName}"\n\nAvailable commands:\n  ${available.join("\n  ")}`,
    );
    err.code = "UNKNOWN_COMMAND";
    err.available = available;
    throw err;
  }
  const name = String(commandName).trim().replace(/^\/+/, "").replace(/\.md$/i, "");
  return { path, name, content: readFileSync(path, "utf-8") };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the system prompt from a loaded spec.
 *
 * @param {{name: string, content: string}} spec
 * @param {{repoRoot?: string}} [opts]
 * @returns {string}
 */
export function buildSystemPrompt(spec, opts = {}) {
  const { repoRoot } = opts;
  return [
    `You are ForgeDock's standalone command runner. You are executing the "/${spec.name}" command directly via the Anthropic API — NOT inside Claude Code.`,
    ``,
    `Follow the command specification below exactly. You have three tools to do real work:`,
    `  - read_file: read a file from disk`,
    `  - write_file: create or overwrite a file`,
    `  - run_bash: run a shell command (git, gh, scripts/, build/test commands, etc.)`,
    ``,
    `Use run_bash for all git/gh operations and for running scripts from scripts/. Post FORGE annotations to GitHub via the gh CLI exactly as the spec instructs. Do not ask the user questions — this is a headless run. When the command is fully complete, stop and emit a concise final summary of what was accomplished.`,
    repoRoot ? `\nWorking directory / repo root: ${repoRoot}` : "",
    ``,
    `=== COMMAND SPECIFICATION (commands/${spec.name}.md) ===`,
    spec.content,
  ]
    .filter((line) => line !== false && line !== undefined && line !== null)
    .join("\n");
}

/**
 * Assemble the system prompt to forward to the CLI backend (issue #2019).
 *
 * This is deliberately NOT `buildSystemPrompt()` reused verbatim:
 * `buildSystemPrompt()` was written for the API backend's custom, minimal
 * 3-tool loop (`read_file`/`write_file`/`run_bash`) and explicitly tells the
 * model "You have three tools to do real work" — that claim is false for the
 * CLI backend, which runs inside the full `claude` CLI with its own native
 * tool set (Read/Write/Edit/Bash/etc.) and its own default system prompt.
 * Passing the API-flavored prompt to the CLI via `--append-system-prompt-file`
 * would misinform the model about which tools it actually has.
 *
 * Forwarded via `--append-system-prompt-file` (see `runCliBackend`), which
 * *appends* to the CLI's own default system prompt rather than replacing it
 * — the CLI keeps its normal tool descriptions/environment info, with the
 * ForgeDock command specification layered on top, mirroring how invoking
 * `/${spec.name}` as a real Claude Code slash command would behave.
 *
 * @param {{name: string, content: string}} spec
 * @returns {string}
 */
export function buildCliSystemPrompt(spec) {
  return [
    `You are executing the ForgeDock "/${spec.name}" command. Follow the command specification below exactly, using your normal available tools to do the work (file edits, git, gh, running scripts/build/test commands, etc.). Post FORGE annotations to GitHub via the gh CLI exactly as the spec instructs. Do not ask the user questions — this is a headless run. When the command is fully complete, stop and emit a concise final summary of what was accomplished.`,
    ``,
    `=== COMMAND SPECIFICATION (commands/${spec.name}.md) ===`,
    spec.content,
  ].join("\n");
}

/**
 * Build the initial user message equivalent to the Claude Code slash invocation.
 *
 * @param {string} commandName
 * @param {string[]|string} args
 * @returns {string}
 */
export function buildUserMessage(commandName, args) {
  const name = String(commandName).trim().replace(/^\/+/, "");
  const argStr = Array.isArray(args) ? args.join(" ") : String(args ?? "");
  return `Execute: /${name} ${argStr}`.trim();
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

/** Anthropic tool-use schemas for the runtime's tool loop. */
export const TOOL_DEFINITIONS = [
  {
    name: "read_file",
    description:
      "Read the contents of a file. Path must be relative to the working directory. Absolute paths and paths that escape the working directory (e.g. '../') are rejected.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read (relative to working directory)." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file with the given content. Parent directories are created as needed. Path must be relative to the working directory. Absolute paths and paths that escape the working directory (e.g. '../') are rejected.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write (relative to working directory)." },
        content: { type: "string", description: "Full file content." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_bash",
    description:
      "Run a shell command in the working directory and return combined stdout/stderr. Use for git, gh, scripts/, build, and test commands.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
      },
      required: ["command"],
    },
  },
];

/**
 * Resolve a tool-supplied path against cwd unless it is already absolute.
 * @param {string} cwd
 * @param {string} p
 */
function resolvePath(cwd, p) {
  return isAbsolute(p) ? p : join(cwd, p);
}

/**
 * Resolve a model-controlled path, confining it to cwd.
 *
 * Absolute paths are rejected outright — the runner is designed to feed
 * untrusted third-party content into the model loop (prompt injection is
 * explicitly in scope), so model-controlled paths must never escape the working
 * directory. A prompt-injection payload could otherwise call
 * read_file("/proc/self/environ") to leak ANTHROPIC_API_KEY into model context,
 * or write_file("/etc/cron.d/evil") for privilege escalation.
 *
 * Mirrors the guard used by resolveSpecPath (the positive example already in
 * this file): reject when relative(cwd, resolved) starts with ".." or is
 * absolute.
 *
 * The lexical checks above only inspect the path *string* — they do not
 * protect against a symlink pre-existing inside cwd (planted by an earlier
 * tool call, or already present on disk) that lexically resolves inside cwd
 * but dereferences at the OS level to a location outside it. To close that
 * gap, the resolved path's *real* (symlink-free) location is also checked
 * against the *real* cwd before returning. write_file targets frequently
 * don't exist yet (its mkdirSync call runs after this function returns), so
 * realpathSync would throw ENOENT if run on the leaf directly — this walks
 * up to the nearest existing ancestor, resolves *that*, and rejoins the
 * non-existent remainder. Unlike bin/registry.mjs's normalizeDir() (a
 * non-security path-normalization helper), there is no fail-open fallback
 * here: this is a security confinement check, so a resolution failure must
 * never be treated as "no symlink present".
 *
 * @param {string} cwd   - Absolute path to the allowed root directory.
 * @param {string} p     - Model-supplied path (must be relative).
 * @returns {string}     - Absolute resolved path (guaranteed inside cwd).
 * @throws {Error}       - If p is absolute or resolves outside cwd (lexically
 *                         or after symlink resolution).
 */
function resolveConfinedPath(cwd, p) {
  if (isAbsolute(p)) {
    throw new Error(
      `Absolute paths are not permitted. Use a path relative to the working directory. Got: ${p}`,
    );
  }
  const resolved = join(cwd, p);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Path escape detected: "${p}" resolves outside the working directory. Use a path relative to the working directory.`,
    );
  }

  // Symlink-resolution check: walk up from `resolved` to the nearest
  // existing ancestor (this may be `cwd` itself, if none of the
  // intermediate directories exist yet — the common case for write_file),
  // realpath that ancestor, then rejoin the not-yet-existing remainder.
  const realCwd = realpathSync.native(cwd);
  let existingAncestor = resolved;
  const remainder = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break; // reached filesystem root — give up walking
    remainder.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  const realAncestor = realpathSync.native(existingAncestor);
  const realResolved =
    remainder.length > 0 ? join(realAncestor, ...remainder) : realAncestor;

  const realRel = relative(realCwd, realResolved);
  if (realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new Error(
      `Path escape detected: "${p}" resolves outside the working directory. Use a path relative to the working directory.`,
    );
  }

  // Residual TOCTOU assumption: we return the lexical `resolved` path rather
  // than `realResolved` so that callers (readFileSync / writeFileSync) work
  // correctly with not-yet-existing paths (where realResolved === resolved
  // anyway, since there is nothing to dereference).  The check above verified
  // confinement on the realpath of the nearest *existing* ancestor, but a
  // concurrent actor that mutates the filesystem between this check and the
  // caller's open() call could in theory introduce a symlink that evades the
  // guard — a classic time-of-check / time-of-use (TOCTOU) window.
  //
  // This is acceptable under the current threat model because:
  //   1. Tool calls are executed in a strictly sequential, synchronous
  //      `for...of` loop (see the runLive tool-use loop).  There is no async
  //      gap and no concurrent tool execution within the runner itself.
  //   2. A prompt-injected model therefore cannot create this race — it would
  //      need to schedule two tool calls simultaneously, which the loop
  //      prevents.
  //   3. Only an independent, external OS process running concurrently could
  //      exploit the window, which is outside the stated single-shot
  //      prompt-injection threat model.
  //
  // If the runner is ever refactored to execute tool calls concurrently or
  // asynchronously, this assumption MUST be revisited.  Mitigations to
  // consider at that point include: operating on `realResolved` directly
  // (eliminating the lexical/realpath split), or opening the file with an
  // O_NOFOLLOW-equivalent flag so the kernel rejects a symlink at open time.
  return resolved;
}

// ---------------------------------------------------------------------------
// Windows bash shim detection
// ---------------------------------------------------------------------------

/**
 * Path fragments that identify Windows bash shims — executables that exist on
 * disk but are launchers or redirectors rather than real bash installations.
 * On systems without WSL these shims either fail or open the Windows Store UI.
 *
 * Used by resolveBashShell() to skip shim paths returned by `where bash.exe`,
 * so that a real bash installation (e.g. Git for Windows) is preferred over a
 * shim that happens to appear earlier on PATH.
 *
 * Fragments are matched case-insensitively against the normalised (backslash)
 * form of each candidate path.
 */
const WINDOWS_BASH_SHIM_FRAGMENTS = [
  "\\WindowsApps\\", // Windows Store app shim tree (opens Store if WSL absent)
  "\\System32\\bash.exe", // WSL inbox launcher (fails without WSL)
];

/**
 * Return true when a Windows path points to a known bash shim rather than a
 * real bash installation. Shims pass existsSync() but will fail or open the
 * Windows Store UI when WSL is not installed.
 *
 * Matching is case-insensitive and tolerates forward-slash separators so the
 * helper works correctly regardless of how the path was produced.
 *
 * @param {string} p - Candidate path to test.
 * @returns {boolean}
 */
export function isWindowsBashShim(p) {
  if (typeof p !== "string") return false;
  const normalised = p.replace(/\//g, "\\").toLowerCase();
  return WINDOWS_BASH_SHIM_FRAGMENTS.some((frag) =>
    normalised.includes(frag.toLowerCase()),
  );
}

// Guard so the "no bash found" warning fires at most once per process, even
// when run_bash is invoked many times in a single runner session.
let _bashWarningEmitted = false;

/**
 * Resolve an explicit bash shell for run_bash, or undefined to fall back to the
 * platform default shell. The system prompt instructs the model to use
 * bash-style git/gh/scripts invocations, so executing under bash keeps behavior
 * consistent across platforms rather than following the host default (cmd.exe
 * on Windows). A FORGEDOCK_SHELL override always wins. When no bash is found we
 * return undefined so execSync falls back to the platform default and non-bash
 * hosts still work.
 *
 * On Windows, discovery order is:
 *   1. FORGEDOCK_SHELL env var (override — wins unconditionally)
 *   2. PATH lookup via `where bash.exe` (catches Scoop, winget, custom prefixes)
 *      Known shim paths (WindowsApps, System32\bash.exe) are filtered out so
 *      that a real bash installation is preferred over a stub that may fail or
 *      open the Windows Store UI if WSL is not installed.
 *   3. Hardcoded candidates: standard Git for Windows (x64 + x86) + Scoop + WSL
 *   4. undefined → platform default shell (cmd.exe); emits a one-time stderr warning
 *
 * @returns {string|undefined} Absolute path to a bash shell, or undefined.
 */
export function resolveBashShell() {
  // Explicit override always wins (even cmd.exe, if the operator insists).
  const override = process.env.FORGEDOCK_SHELL;
  if (override && override.trim()) return override.trim();

  if (process.platform === "win32") {
    // 1. PATH-based discovery — covers Scoop, winget, and custom install
    //    prefixes that place bash.exe on PATH but not under Program Files.
    //    `where.exe` is a standalone tool in System32; run it via the default
    //    shell so restricted environments that lack `where` degrade gracefully.
    //    All results are filtered to skip known shim paths before the first
    //    real bash candidate is accepted (see isWindowsBashShim).
    try {
      const fromPath = execSync("where bash.exe", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 3000,
        shell: true,
      })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !isWindowsBashShim(l))
        .find((l) => existsSync(l));
      if (fromPath) return fromPath;
    } catch {
      // `where` failed or returned no results — fall through to hardcoded list.
    }

    // 2. Hardcoded candidates: standard Git for Windows (machine-wide x64 + x86),
    //    Scoop convention (%USERPROFILE%\scoop\apps\git\current\bin\bash.exe),
    //    and WSL bash (%SystemRoot%\System32\bash.exe).
    //    Note: System32\bash.exe is the WSL inbox launcher — it works when WSL is
    //    installed but is a shim that fails without WSL.  It is listed last so
    //    real Git-for-Windows paths take priority.
    const candidates = [
      join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
      join(
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "Git",
        "bin",
        "bash.exe",
      ),
      // Scoop installs Git under %USERPROFILE%\scoop\apps\git\current\.
      join(
        process.env.USERPROFILE || "",
        "scoop",
        "apps",
        "git",
        "current",
        "bin",
        "bash.exe",
      ),
      join(process.env.SystemRoot || "C:\\Windows", "System32", "bash.exe"),
    ];
    const found = candidates.find((c) => c && existsSync(c));
    if (found) return found;

    // 3. No bash found anywhere — warn the operator once so the silent cmd.exe
    //    fallback does not go unnoticed. Writing to stderr keeps stdout clean
    //    for callers that pipe or parse runner output.
    if (!_bashWarningEmitted) {
      _bashWarningEmitted = true;
      process.stderr.write(
        "[ForgeDock] Warning: bash not found on this system. run_bash commands " +
          "will execute under cmd.exe, which may not support bash idioms " +
          "(heredocs, scripts/*.sh, single-quote semantics). Install Git for " +
          "Windows (https://gitforwindows.org) or Scoop (`scoop install git`), " +
          "or set FORGEDOCK_SHELL to the absolute path of bash.exe to suppress " +
          "this warning.\n",
      );
    }
    return undefined;
  }
  // POSIX: prefer bash, fall back to /bin/sh (bash-compatible enough).
  return ["/bin/bash", "/usr/bin/bash", "/bin/sh"].find((c) => existsSync(c));
}

/**
 * Build the concrete tool handlers bound to a working directory.
 *
 * Each handler returns a string (the tool_result content). Handlers may throw;
 * the loop catches and reports the error back to the model as an error result.
 *
 * @param {string} cwd
 * @returns {Record<string, (input: object) => string>}
 */
export function getToolHandlers(cwd) {
  return {
    read_file: ({ path }) => {
      if (!path) throw new Error("read_file requires a 'path'");
      return readFileSync(resolveConfinedPath(cwd, path), "utf-8");
    },
    write_file: ({ path, content }) => {
      if (!path) throw new Error("write_file requires a 'path'");
      const target = resolveConfinedPath(cwd, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content ?? "", "utf-8");
      return `Wrote ${Buffer.byteLength(content ?? "", "utf-8")} bytes to ${path}`;
    },
    run_bash: ({ command }) => {
      if (!command) throw new Error("run_bash requires a 'command'");
      // Scrub the Anthropic API key from the child environment. The runner is
      // designed to feed untrusted third-party content (issue/PR bodies via gh)
      // into the model loop, so a prompt-injection payload could otherwise issue
      // a run_bash command that exfiltrates the key. gh/git auth tokens
      // (GH_TOKEN/GITHUB_TOKEN) are intentionally left intact.
      const childEnv = { ...process.env };
      delete childEnv.ANTHROPIC_API_KEY;
      // Run under bash when available so bash-style commands the model emits
      // (heredocs, scripts/*.sh, single-quote semantics) behave consistently
      // across platforms. `undefined` lets spawnSync fall back to the platform
      // default shell (see `shell: shell || true` below).
      const shell = resolveBashShell();
      // Resolve wall-clock timeout. FORGEDOCK_BASH_TIMEOUT overrides the
      // module default so operators can tune per-repo or per-CI-job without
      // touching source. NaN / non-positive values fall back to the default.
      const rawTimeout = parseInt(process.env.FORGEDOCK_BASH_TIMEOUT, 10);
      const timeoutMs =
        Number.isFinite(rawTimeout) && rawTimeout > 0
          ? rawTimeout
          : DEFAULT_BASH_TIMEOUT_MS;
      const startMs = Date.now();
      // Use spawnSync (not execSync) so stderr is captured on BOTH the success
      // and failure paths. execSync only ever *returns* stdout on success —
      // stderr is only exposed via the thrown error's `.stderr` on a nonzero
      // exit — even though the tool schema above promises combined
      // stdout/stderr and the failure path below already concatenates both.
      // That meant diagnostics a command writes to stderr while still exiting
      // 0 (git/npm/linter warnings) silently vanished from what the agent
      // loop sees. spawnSync returns { stdout, stderr, status, signal, error }
      // uniformly regardless of exit status, so both streams are always
      // available. `shell: shell || true` preserves execSync's implicit
      // "always run via a shell" behavior for compound commands (&&, pipes,
      // heredocs) when resolveBashShell() returns undefined.
      // maxBuffer defaults to 50 MB. FORGEDOCK_MAX_BUFFER_BYTES overrides it so
      // tests can trigger ENOBUFS with a small value without generating 50 MB of
      // output.  Non-positive or non-finite values fall back to the default.
      const rawMaxBuffer = parseInt(process.env.FORGEDOCK_MAX_BUFFER_BYTES, 10);
      const maxBuffer =
        Number.isFinite(rawMaxBuffer) && rawMaxBuffer > 0
          ? rawMaxBuffer
          : DEFAULT_SPAWN_MAX_BUFFER_BYTES;
      const result = spawnSync(command, {
        cwd,
        encoding: "utf-8",
        maxBuffer,
        timeout: timeoutMs,
        env: childEnv,
        shell: shell || true,
      });
      const stdout = result.stdout ? String(result.stdout) : "";
      const stderr = result.stderr ? String(result.stderr) : "";
      // Check ENOBUFS BEFORE the timedOut fallback. When a command both exceeds
      // maxBuffer AND runs past timeoutMs, both result.error.code === "ENOBUFS"
      // and elapsedMs >= timeoutMs are simultaneously true. The elapsedMs
      // fallback (check 2 below) is a heuristic catch-all that must not
      // override a specific, authoritative error code. ENOBUFS is always the
      // correct diagnosis when present — surface it first. (issue #1364)
      if (result.error?.code === "ENOBUFS") {
        // The process ran but produced more output than maxBuffer allows.
        // spawnSync populates result.stdout/stderr up to the limit before
        // setting result.error — surface what was captured so the agent has
        // actionable context rather than a misleading "failed to start" error.
        const partial = (stdout + stderr).trim();
        const bufDisplay =
          maxBuffer < 1024
            ? `${maxBuffer} bytes`
            : maxBuffer < 1024 * 1024
              ? `${Math.round(maxBuffer / 1024)}KB`
              : `${Math.round(maxBuffer / (1024 * 1024))}MB`;
        throw new Error(
          `Command output exceeded ${bufDisplay} buffer limit (output truncated).` +
            (partial ? `\nPartial output:\n${partial}` : ""),
        );
      }
      // Detect timeout. Two reliable indicators:
      //   1. result.error.code === "ETIMEDOUT" — Node sets this on the error
      //      object specifically when spawnSync's own `timeout` option fires
      //      and it kills the child. This is the authoritative Node-initiated
      //      kill signal.
      //   2. elapsedMs >= timeoutMs — elapsed-wall-time fallback for platforms
      //      (primarily Windows) where the ETIMEDOUT error code is unreliable.
      //      If we spent at least as long as the timeout, the timer must have
      //      fired, since a voluntarily-exiting process would have returned
      //      before then.
      //
      // NOTE: `result.signal === "SIGTERM"` is intentionally NOT included.
      // spawnSync sets result.signal for ANY signal that terminated the child —
      // including SIGTERM from external sources (supervisors, orchestrators,
      // `timeout(1)` wrappers, or the child self-signaling) that are entirely
      // unrelated to this runner's timeout. Including it caused any externally-
      // sent SIGTERM to be misreported as a ForgeDock timeout (issue #1240).
      //
      // Gate all of this on `result.status === null` so a legitimately-
      // completed process near the timeout boundary is never misreported.
      // ENOBUFS is excluded above — it is checked first so a command that both
      // overflows the buffer AND exceeds the timeout gets the correct message.
      const elapsedMs = Date.now() - startMs;
      const timedOut =
        result.status === null &&
        (result.error?.code === "ETIMEDOUT" || elapsedMs >= timeoutMs);
      if (timedOut) {
        const timeoutSecs = Math.round(timeoutMs / 1000);
        const partial = (stdout + stderr).trim();
        throw new Error(
          `Command timed out after ${timeoutSecs}s and was killed. ` +
            `Set FORGEDOCK_BASH_TIMEOUT (ms) to adjust.` +
            (partial ? `\nPartial output:\n${partial}` : ""),
        );
      }
      if (result.error) {
        // spawnSync-level failure to even launch the process (e.g. ENOENT
        // for a missing shell binary) — distinct from a nonzero exit status
        // below.
        throw new Error(`Command failed to start: ${result.error.message}`);
      }
      if (result.status !== 0) {
        // Surface the command's output AND exit status to the model so it
        // can react to failures rather than silently swallowing them.
        throw new Error(
          `Command failed (exit ${result.status ?? "?"}):\n${stdout}${stderr}`.trim(),
        );
      }
      // Combined stdout/stderr on success — matches the tool schema's
      // documented contract.
      return stdout + stderr;
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the dry-run preview: what would be sent to the API, no network.
 *
 * `systemPrompt` in `ctx` must already be the backend-appropriate prompt —
 * callers resolve `backend === "cli" ? cliSystemPrompt : systemPrompt` before
 * calling this (see `runCommand`). This function branches the `tools:` line
 * (and the on-disk-vs-inline framing of the system-prompt line) on `backend`
 * so the preview accurately reflects what each backend actually sends: the
 * `api` backend sends `TOOL_DEFINITIONS` (its custom read_file/write_file/
 * run_bash loop) inline as `system`; the `cli` backend uses the `claude`
 * CLI's own native tool set and receives the prompt via
 * `--append-system-prompt-file`, not inline (issue #2019).
 *
 * @param {{spec: object, systemPrompt: string, userMessage: string, model: string, maxIterations: number, backend?: "cli"|"api"}} ctx
 * @returns {string}
 */
export function renderDryRun(ctx) {
  const { spec, systemPrompt, userMessage, model, maxIterations, backend } = ctx;
  const backendLine =
    backend === "cli"
      ? `│ backend:        cli (claude CLI detected — no ANTHROPIC_API_KEY needed)`
      : backend === "api"
        ? `│ backend:        api (ANTHROPIC_API_KEY required)`
        : null;
  const toolsLine =
    backend === "cli"
      ? `│ tools:          claude CLI's native tools (Read/Write/Edit/Bash/etc. — not TOOL_DEFINITIONS below)`
      : `│ tools:          ${TOOL_DEFINITIONS.map((t) => t.name).join(", ")}`;
  const systemPromptLine =
    backend === "cli"
      ? `│ system prompt:  ${systemPrompt.length} chars (appended to CLI's default via --append-system-prompt-file)`
      : `│ system prompt:  ${systemPrompt.length} chars`;
  return [
    `┌─ ForgeDock run (dry-run) ───────────────────────────────`,
    `│ command:        /${spec.name}`,
    `│ spec:           ${spec.path}`,
    backendLine,
    `│ model:          ${model}`,
    `│ max iterations: ${maxIterations}`,
    toolsLine,
    systemPromptLine,
    `│ user message:   ${userMessage}`,
    `└─────────────────────────────────────────────────────────`,
    ``,
    `(dry-run) No API call made. Set ANTHROPIC_API_KEY and install`,
    `@anthropic-ai/sdk, then drop --dry-run to execute the pipeline.`,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");
}

/**
 * Render the pipeline summary card emitted on completion.
 * @param {{command: string, args: string[], iterations: number, stopReason: string, usage?: object|null}} ctx
 * @returns {string}
 */
export function renderSummaryCard(ctx) {
  const { command, args, iterations, stopReason, usage = null } = ctx;
  const argStr = Array.isArray(args) ? args.join(" ") : String(args ?? "");
  const lines = [
    ``,
    `┌─ ForgeDock pipeline summary ────────────────────────────`,
    `│ command:    /${command} ${argStr}`.trimEnd(),
    `│ iterations: ${iterations}`,
    `│ stop:       ${stopReason}`,
  ];
  if (usage) {
    lines.push(
      `│ tokens:     ${usage.input_tokens} in / ${usage.output_tokens} out`,
      `│ cache:      ${usage.cache_read_input_tokens} read / ${usage.cache_creation_input_tokens} write`,
    );
  } else {
    lines.push(`│ tokens:     N/A`);
  }
  lines.push(
    `└─────────────────────────────────────────────────────────`,
  );
  if (usage) {
    lines.push(
      `FORGE:USAGE_JSON:${JSON.stringify(usage)}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run a ForgeDock command outside Claude Code.
 *
 * @param {object} opts
 * @param {string} opts.commandsDir          - Absolute path to commands/.
 * @param {string} opts.commandName          - Command to run (e.g. "work-on").
 * @param {string[]} [opts.args]             - Command arguments.
 * @param {string} [opts.cwd]                - Working directory (default cwd).
 * @param {string} [opts.apiKey]             - Anthropic API key (default env).
 * @param {string} [opts.model]              - Model id. Resolution order when
 *   omitted: $FORGEDOCK_MODEL env > forge.yaml `agents.default_model` (in
 *   `cwd`) > hardcoded DEFAULT_MODEL.
 * @param {number} [opts.maxIterations]      - Tool-loop bound.
 * @param {boolean} [opts.dryRun]            - Preview without an API call.
 * @param {string} [opts.backend]            - "cli" | "api" | "auto" (default
 *   "auto"). Resolution order when omitted: $FORGEDOCK_BACKEND env > "auto".
 *   "auto" prefers the local Claude Code CLI when detected (no
 *   ANTHROPIC_API_KEY needed), else falls back to the API backend. This
 *   precedence is intentional/shipped (issue #2003's accepted acceptance
 *   criteria) and is NOT changed by issue #2020 — that issue only adds a
 *   discoverability notice (below) for the case where the ladder silently
 *   preferred `cli` while an `ANTHROPIC_API_KEY` was also available, so
 *   users know the `--backend api`/`FORGEDOCK_BACKEND=api` override exists.
 * @param {{log: Function, error?: Function}} [opts.logger] - Output sink.
 * @returns {Promise<{status: string, command: string, [k: string]: any}>}
 */
export async function runCommand(opts = {}) {
  const {
    commandsDir,
    commandName,
    args = [],
    cwd = process.cwd(),
    apiKey = process.env.ANTHROPIC_API_KEY,
    model = process.env.FORGEDOCK_MODEL ||
      resolveConfiguredDefaultModel(cwd) ||
      DEFAULT_MODEL,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    dryRun = false,
    backend = process.env.FORGEDOCK_BACKEND || "auto",
    logger = console,
  } = opts;

  const spec = loadCommandSpec(commandsDir, commandName);
  const systemPrompt = buildSystemPrompt(spec, { repoRoot: cwd });
  // CLI-backend-specific prompt (issue #2019) — see buildCliSystemPrompt's
  // doc comment for why this must NOT be the same string as `systemPrompt`
  // above (that one is written for the API backend's custom 3-tool loop).
  const cliSystemPrompt = buildCliSystemPrompt(spec);
  const userMessage = buildUserMessage(commandName, args);

  // Resolve the backend before dry-run so the preview reports what would
  // actually run. isClaudeCliAvailable() is bounded by CLI_PROBE_TIMEOUT_MS
  // and never throws on detection failure, so this cannot make --dry-run (or
  // the start of a live run) hang or fail even when `claude` is absent or
  // misbehaving. An explicitly invalid `backend` value DOES throw here —
  // surfacing a bad --backend/FORGEDOCK_BACKEND value immediately, before any
  // work is attempted, rather than silently ignoring it.
  const resolvedBackend = resolveBackend({ requested: backend, cwd });

  if (dryRun) {
    logger.log(
      renderDryRun({
        spec,
        systemPrompt: resolvedBackend === "cli" ? cliSystemPrompt : systemPrompt,
        userMessage,
        model,
        maxIterations,
        backend: resolvedBackend,
      }),
    );
    return {
      status: "dry-run",
      command: spec.name,
      args,
      specPath: spec.path,
      model,
      backend: resolvedBackend,
    };
  }

  if (resolvedBackend === "cli") {
    // Discoverability notice (issue #2020): the "auto" ladder's CLI-first
    // precedence is intentional, shipped behavior (issue #2003's accepted
    // acceptance criteria: "prefers CLI when present, falls back to SDK")
    // and is NOT changed here — reverting it would contradict that accepted
    // design, exactly as sibling issue #2023 found for the analogous
    // init-enrich ladder. The actual gap #2020 identified is that this
    // choice is invisible on a live run: --dry-run reports the resolved
    // backend via renderDryRun() above, but a live run previously printed
    // nothing, so a user who has both `claude` on PATH and
    // ANTHROPIC_API_KEY set has no signal that the ladder picked "cli" over
    // their key, nor that `--backend api`/`FORGEDOCK_BACKEND=api` exists to
    // pin the previous (API-only) behavior. Gate strictly on:
    //   - `backend` being the raw, pre-resolution "auto"/default value (an
    //     explicit `--backend cli`/`FORGEDOCK_BACKEND=cli` request needs no
    //     "did you mean to override" hint — the user already chose).
    //   - `apiKey` being truthy (silent for the common CLI-only case with no
    //     key at all — nothing to "switch away from").
    if (backend === "auto" && apiKey) {
      logger.log(
        "Using the claude CLI backend (found on PATH). ANTHROPIC_API_KEY is also set — " +
          "pass --backend api or set FORGEDOCK_BACKEND=api to use the API backend instead.",
      );
    }

    // model/maxIterations only apply to the api backend — the cli backend
    // uses whatever model the `claude` CLI itself is configured for, and has
    // no equivalent iteration-cap concept for a single `claude --print`
    // invocation. Warn (rather than silently drop) when the caller explicitly
    // supplied either, so the behavior is discoverable outside of --dry-run.
    // hasOwnProperty on the raw opts (not the destructured, default-applied
    // values above) is required here: model/maxIterations always resolve to
    // a computed default, so checking their truthiness would fire this
    // warning on every single cli-backend run.
    const ignoredOptions = [];
    if (Object.prototype.hasOwnProperty.call(opts, "model")) ignoredOptions.push("model");
    if (Object.prototype.hasOwnProperty.call(opts, "maxIterations"))
      ignoredOptions.push("maxIterations");
    if (ignoredOptions.length > 0) {
      logger.log(
        `Warning: --${ignoredOptions.join(" and --")} ${
          ignoredOptions.length > 1 ? "are" : "is"
        } ignored on the cli backend (backend: cli uses whatever model the ` +
          `claude CLI itself is configured for). Use --backend api to honor ${
            ignoredOptions.length > 1 ? "these options" : "this option"
          }.`,
      );
    }
    return runCliBackend({ spec, userMessage, systemPrompt: cliSystemPrompt, args, cwd, logger });
  }

  if (!apiKey) {
    const err = new Error(
      "ANTHROPIC_API_KEY is not set. Export your Anthropic API key to run the live pipeline, " +
        "pass --dry-run to preview, or use --backend cli (requires the `claude` CLI on PATH, " +
        "already authenticated) to run without an API key.",
    );
    err.code = "NO_API_KEY";
    throw err;
  }

  // Lazy/optional SDK import — keeps the package dependency-free until a live
  // run is actually requested.
  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    const err = new Error(
      "@anthropic-ai/sdk is not installed. Install it with:\n  npm install @anthropic-ai/sdk\nThen re-run, or use --dry-run to preview without the SDK.",
    );
    err.code = "NO_SDK";
    throw err;
  }

  const client = new Anthropic({ apiKey });
  // NOTE on /proc/$PPID/environ (Linux): deleting from process.env calls
  // unsetenv() at the C level, which does NOT update the kernel's
  // /proc/<pid>/environ snapshot (that is fixed at execve() time). A
  // run_bash payload can still read /proc/$PPID/environ and recover the
  // key if it was set in the shell environment before the node process
  // started. The only effective JavaScript-layer mitigation is the
  // child-env scrub in run_bash: `childEnv = {...process.env}; delete
  // childEnv.ANTHROPIC_API_KEY` — this prevents the child from inheriting
  // the key in its own process.env, which is sufficient for
  // `process.env.ANTHROPIC_API_KEY` access. The /proc/$PPID/environ vector
  // is a known Linux limitation at the OS level; closing it would require
  // a native module (e.g. prctl PR_SET_DUMPABLE) or process isolation.
  // See: issue #1370 for tracking this known limitation.
  const handlers = getToolHandlers(cwd);
  const messages = [{ role: "user", content: userMessage }];

  // Accumulate token usage across all messages.create() calls in this run.
  // Field names match the Anthropic SDK's response.usage object exactly.
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  let iterations = 0;
  while (iterations < maxIterations) {
    iterations++;

    const response = await client.messages.create({
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: systemPrompt,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    // Accumulate usage — guard each field for null/undefined (SDK omits
    // cache fields when prompt caching is not active).
    const ru = response.usage ?? {};
    usage.input_tokens += ru.input_tokens ?? 0;
    usage.output_tokens += ru.output_tokens ?? 0;
    usage.cache_creation_input_tokens += ru.cache_creation_input_tokens ?? 0;
    usage.cache_read_input_tokens += ru.cache_read_input_tokens ?? 0;

    messages.push({ role: "assistant", content: response.content });

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        logger.log(block.text);
      }
    }

    if (response.stop_reason !== "tool_use") {
      // `max_tokens` is a TRUNCATED assistant turn, not a clean finish — report
      // it distinctly so callers (and CI) don't treat a cut-off run as success.
      const status =
        response.stop_reason === "max_tokens" ? "incomplete" : "complete";
      logger.log(
        renderSummaryCard({
          command: spec.name,
          args,
          iterations,
          stopReason: response.stop_reason,
          usage,
        }),
      );
      return {
        status,
        command: spec.name,
        iterations,
        stopReason: response.stop_reason,
        usage,
        model,
        backend: "api",
      };
    }

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const handler = handlers[block.name];
      let content;
      let isError = false;
      try {
        if (!handler) throw new Error(`Unknown tool: ${block.name}`);
        content = String(handler(block.input ?? {}) ?? "");
      } catch (e) {
        content = `Error: ${e.message}`;
        isError = true;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: truncateToolResult(content),
        is_error: isError,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  logger.log(
    renderSummaryCard({
      command: spec.name,
      args,
      iterations,
      stopReason: "max_iterations",
      usage,
    }),
  );
  return {
    status: "max-iterations",
    command: spec.name,
    iterations,
    usage,
    model,
    backend: "api",
  };
}
