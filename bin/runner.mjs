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
import { join, dirname, basename, relative, isAbsolute, extname } from "path";
import os from "os";
import { execSync, spawn, spawnSync } from "child_process";
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
export const VALID_BACKENDS = readOnlySet(["native", "cli", "api", "auto"]);
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
// Each entry stores `{ available, cliPath, cachedAt }` instead of a bare
// boolean so `isClaudeCliAvailable()` can evaluate the TTL, and so the
// *same* resolved absolute executable path the probe validated can be
// reused by `runCliBackend()`'s production invocation (issue #2741) — see
// `resolveClaudeCliBinary()` below. `cliPath` is `null` when unavailable or
// when the probe succeeded but no path-like line could be parsed out of it
// (e.g. an injected test `execImpl` that returns a bare version string).
const CLI_AVAILABILITY_CACHE_TTL_MS = 60_000;
const CLI_AVAILABILITY_CACHE_MAX_SIZE = 100;
const cliAvailabilityCache = new Map();
const nativeAvailabilityCache = new Map();
// Windows file extensions `spawnSync(shell:false)` can actually launch:
// native executables (`.exe`, `.com`) directly, and `.cmd`/`.bat` via Node's
// own built-in special-cased re-exec through cmd.exe (see the comment on
// `runCliBackend()` below). An extensionless file — e.g. the POSIX shell
// shim `npm`/`npx` also drop alongside these on Windows — cannot be
// launched by `CreateProcess` at all, with or without a full absolute path.
const WINDOWS_SPAWNABLE_EXTENSIONS = new Set([".exe", ".cmd", ".bat", ".com"]);
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
 * Split the combined probe command's stdout (issue #2741 — see
 * `isClaudeCliAvailable()`) into the leading "path-like" lines (from the
 * `where`/`command -v` half of the command) versus everything after them
 * (the `claude --version` output). A path-like line is one containing a
 * path separator (`/` or `\`); `claude --version` output (e.g.
 * `"1.2.3 (Claude Code)"`) never does, so the first non-path-like line
 * marks the boundary.
 *
 * Pure/side-effect-free so it can be unit tested directly against
 * synthetic multi-line `where` output without spawning anything.
 *
 * @param {string} raw
 * @returns {string[]} Leading path-like lines, in original order.
 */
function parseProbeOutput(raw) {
  const lines = String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const pathLines = [];
  for (const line of lines) {
    if (line.includes("/") || line.includes("\\")) {
      pathLines.push(line);
    } else {
      break;
    }
  }
  return pathLines;
}

/**
 * Pick the best resolved `claude` executable path out of the candidate
 * path-like lines produced by `parseProbeOutput()` (issue #2741).
 *
 * On Windows, prefers a candidate with a recognized spawnable extension
 * (`WINDOWS_SPAWNABLE_EXTENSIONS`) over an extensionless one — `where`
 * matches bare filenames as well as PATHEXT-suffixed ones, and an
 * npx-transient shim directory can contain both an extensionless POSIX
 * shell script and a `.cmd`/`.ps1` sibling generated by npm's cross-platform
 * shim generator. If every candidate is extensionless, checks the same
 * directory for a `.cmd`/`.exe`/`.bat`/`.com` sibling with the same base
 * name before giving up and returning the bare match as-is.
 *
 * On POSIX, `command -v` returns a single resolvable path directly usable
 * by `spawnSync(shell:false)` (POSIX `execve` honors the shebang line), so
 * no extension preference is needed.
 *
 * @param {string[]} pathLines
 * @returns {string|null}
 */
function selectResolvedCliPath(pathLines) {
  if (pathLines.length === 0) return null;
  if (process.platform !== "win32") return pathLines[0];

  const withExt = pathLines.find((line) =>
    WINDOWS_SPAWNABLE_EXTENSIONS.has(extname(line).toLowerCase()),
  );
  if (withExt) return withExt;

  const bare = pathLines[0];
  const dir = dirname(bare);
  const base = basename(bare);
  for (const ext of [".cmd", ".exe", ".bat", ".com"]) {
    const candidate = join(dir, `${base}${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return bare;
}

/**
 * Probe whether the Claude Code CLI (`claude`) is present and responds on
 * this machine, so `forgedock run` can drive it directly instead of
 * requiring a separate, billable ANTHROPIC_API_KEY.
 *
 * Deliberately runs a single command *string* through a shell (via
 * `execSync`) rather than `execFileSync("claude", [...])` or a no-shell
 * `spawnSync`. On Windows, `claude` may be installed as a `claude.cmd`
 * shim, or present only as an npx-transient shim (an extensionless script
 * in a `_npx` cache directory, reachable only via the shell-augmented
 * PATH); `execFileSync`/no-shell `spawnSync` do not resolve either case the
 * same way a shell does and throw ENOENT even though the CLI is genuinely
 * runnable (see issue #382 for the `.cmd`-shim regression this originally
 * guarded against, and issue #2741 for the npx-shim case). `execSync`
 * always runs its command through a shell, which resolves both cases
 * correctly on Windows and behaves identically on POSIX.
 *
 * issue #2741 — probe/invocation asymmetry fix: this probe now does double
 * duty. In a single `execImpl` call (so per-cwd caching below still pays
 * the probe cost exactly once — existing tests assert this), it both
 * verifies `claude --version` responds AND captures the shell-resolved
 * absolute path (`where claude` on Windows / `command -v claude` on POSIX)
 * that made that resolution possible. That resolved path is cached
 * alongside `available` and exposed via `resolveClaudeCliBinary()` below,
 * so `runCliBackend()`'s production call site can spawn the *exact* binary
 * this probe validated — with `shell:false` — instead of a bare `"claude"`
 * name that the no-shell OS exec-path search may fail to resolve the same
 * way. The two commands are chained with `&&` (path-resolution failure
 * short-circuits the whole probe as "unavailable") rather than run
 * independently: an environment where `claude` only resolves as an
 * unlocatable shell alias/function (no path lookup, `--version` succeeds
 * anyway) was never actually spawnable via `spawnSync` in the first place,
 * so treating that as "unavailable" here is consistent with what
 * `runCliBackend()` can actually do with it.
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
  const resolveCmd = process.platform === "win32" ? "where claude" : "command -v claude";
  let available;
  let cliPath = null;
  try {
    const raw = execImpl(`${resolveCmd} && claude --version`, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      timeout: CLI_PROBE_TIMEOUT_MS,
    });
    available = true;
    cliPath = selectResolvedCliPath(parseProbeOutput(raw));
  } catch {
    available = false;
  }
  // Re-inserting an existing key moves it to the end of Map's iteration
  // order (delete+set), so eviction below always drops the true oldest
  // entry — whether "oldest" means "never refreshed" or "not refreshed in
  // the longest time."
  cliAvailabilityCache.delete(cwd);
  cliAvailabilityCache.set(cwd, { available, cliPath, cachedAt: Date.now() });
  if (cliAvailabilityCache.size > CLI_AVAILABILITY_CACHE_MAX_SIZE) {
    const oldestKey = cliAvailabilityCache.keys().next().value;
    cliAvailabilityCache.delete(oldestKey);
  }
  return available;
}

/**
 * Return the exact absolute `claude` executable path that
 * `isClaudeCliAvailable()` validated for `cwd` (issue #2741), ensuring the
 * probe/cache is populated or refreshed first. This is what closes the
 * probe/invocation asymmetry: `runCommand()`'s production call site passes
 * this resolved path as `runCliBackend()`'s `bin` argument instead of the
 * bare `"claude"` default, so the invocation spawns the identical binary
 * the probe already confirmed responds — with `shell:false` preserved
 * throughout (see the SECURITY note on `runCliBackend()` below).
 *
 * @param {string} [cwd] - Working directory for the probe (default cwd).
 * @param {object} [opts] - Forwarded to `isClaudeCliAvailable()` (e.g.
 *   `execImpl` test seam).
 * @returns {string|null} Absolute resolved path, or `null` when the CLI is
 *   unavailable or no path-like line could be parsed from the probe output
 *   (falls back to the bare `"claude"` name at the call site in that case).
 */
export function resolveClaudeCliBinary(cwd = process.cwd(), opts = {}) {
  isClaudeCliAvailable(cwd, opts);
  return cliAvailabilityCache.get(cwd)?.cliPath ?? null;
}

/** Resolve runtime.default from forge.yaml without making configuration mandatory. */
export function resolveConfiguredBackend(cwd) {
  try {
    const forgeYamlPath = join(cwd, "forge.yaml");
    if (!existsSync(forgeYamlPath)) return null;
    const configured = parseForgeYaml(readFileSync(forgeYamlPath, "utf-8"))?.runtime?.default;
    return typeof configured === "string" && VALID_BACKENDS.has(configured)
      ? configured
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the private runtime used by ForgeDock's native backend. Product
 * surfaces deliberately call this backend "native"; the executable is an
 * implementation detail and can be replaced with FORGEDOCK_RUNTIME_BIN.
 */
export function isNativeRuntimeAvailable(
  cwd = process.cwd(),
  { execImpl = execSync } = {},
) {
  const configuredBin = process.env.FORGEDOCK_RUNTIME_BIN;
  if (configuredBin) return existsSync(configuredBin);

  const cached = nativeAvailabilityCache.get(cwd);
  if (cached && Date.now() - cached.cachedAt < CLI_AVAILABILITY_CACHE_TTL_MS) {
    return cached.available;
  }

  const resolveCmd = process.platform === "win32" ? "where opencode" : "command -v opencode";
  let available = false;
  let cliPath = null;
  try {
    const raw = execImpl(`${resolveCmd} && opencode --version`, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      timeout: CLI_PROBE_TIMEOUT_MS,
    });
    available = true;
    cliPath = selectResolvedCliPath(parseProbeOutput(raw));

    // npm's Windows shim is a .cmd file, which async spawn(shell:false)
    // cannot launch. Resolve the package's native executable instead so
    // untrusted workflow arguments never pass through cmd.exe.
    if (process.platform === "win32" && cliPath?.toLowerCase().endsWith(".cmd")) {
      const nativeExe = join(dirname(cliPath), "node_modules", "opencode-ai", "bin", "opencode.exe");
      if (existsSync(nativeExe)) cliPath = nativeExe;
    }
  } catch {
    available = false;
  }

  nativeAvailabilityCache.delete(cwd);
  nativeAvailabilityCache.set(cwd, { available, cliPath, cachedAt: Date.now() });
  if (nativeAvailabilityCache.size > CLI_AVAILABILITY_CACHE_MAX_SIZE) {
    nativeAvailabilityCache.delete(nativeAvailabilityCache.keys().next().value);
  }
  return available;
}

export function resolveNativeRuntimeBinary(cwd = process.cwd(), opts = {}) {
  if (process.env.FORGEDOCK_RUNTIME_BIN) return process.env.FORGEDOCK_RUNTIME_BIN;
  isNativeRuntimeAvailable(cwd, opts);
  return nativeAvailabilityCache.get(cwd)?.cliPath ?? null;
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
  if (requested !== "auto") return requested;
  if (isNativeRuntimeAvailable(cwd)) return "native";
  return resolveBackendLadder({
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
 * Windows `.cmd`/`.bat` shim resolution works WITHOUT `shell: true` — BUT
 * only when `bin` is already a resolvable target: Node's spawn/spawnSync
 * safely re-invoke through cmd.exe internally when the *given* target is a
 * `.cmd`/`.bat` file, using a properly escaped mechanism, and argv elements
 * are never parsed as shell syntax (verified empirically on Windows: a
 * malicious-looking argv element is delivered to the child process
 * byte-for-byte, not executed). This is the correct fix for the
 * `execFileSync("claude", [...])` ENOENT-on-Windows regression from issue
 * #382 for a `claude.cmd` sitting directly on a real PATH entry.
 *
 * CORRECTED (issue #2741): the claim that a bare `"claude"` name resolves
 * via "spawnSync's own PATH/PATHEXT resolution" was overconfident and
 * false for an npx-transient shim (an extensionless script living in a
 * `_npx` cache directory rather than a stable PATH entry with a registered
 * PATHEXT extension) — `spawnSync(shell:false)` resolves a bare command
 * name via the OS's own exec-path search, which does not carry the same
 * shell/PATHEXT semantics `isClaudeCliAvailable()`'s shell-based probe
 * uses, and ENOENTs on that shim even though the probe reports the CLI
 * available. The fix is NOT `shell: true` (would reopen the injection hole
 * above); it is resolving the *exact* absolute path the probe validated
 * once, via `resolveClaudeCliBinary()`, and passing that resolved path as
 * `bin` — `spawnSync(shell:false)` launches an already-fully-resolved
 * absolute path (native `.exe`, or `.cmd`/`.bat` via the special-cased
 * re-exec described above) without needing any further PATH/PATHEXT
 * resolution of its own. See `isClaudeCliAvailable()`/
 * `resolveClaudeCliBinary()` above for how that resolution happens.
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
 *
 * Token usage: the invocation requests `--output-format json`, and on a
 * successful exit the captured stdout is parsed as the CLI's single-result
 * JSON envelope. When parsing succeeds and the envelope carries a `usage`
 * object, it is normalized to the same shape the API backend returns
 * (`{input_tokens, output_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens}`, each field `?? 0`). When the output isn't valid
 * JSON (older CLI versions, or a CLI that ignores `--output-format`) or the
 * envelope has no `usage` field, this degrades gracefully to `usage: null`
 * (an already fully-supported value throughout renderSummaryCard/renderDryRun)
 * — this parsing never throws on the success path.
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
 * @param {string} [opts.bin] - Executable to invoke (default "claude").
 *   UPDATED (issue #2741): the real production caller (`runCommand()`
 *   below) now deliberately passes `resolveClaudeCliBinary(cwd) ?? "claude"`
 *   here — a pre-resolved absolute path, not the bare default — to close
 *   the probe/invocation asymmetry described on `isClaudeCliAvailable()`
 *   above. The bare `"claude"` default remains purely a fallback for that
 *   production call site (when resolution genuinely finds nothing) and a
 *   test seam: tests still point this at a controlled fake binary instead
 *   of either invoking the real `claude` CLI (slow, non-deterministic, real
 *   side effects) or fighting platform-specific PATH-resolution semantics
 *   to shim "claude" itself (Windows resolves a bare executable name via
 *   the *calling* process's search path at the OS level, which is not
 *   reliably overridable per-call from within the same process).
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
 * @returns {{status: string, command: string, iterations: number, stopReason: string, usage: ({input_tokens: number, output_tokens: number, cache_creation_input_tokens: number, cache_read_input_tokens: number}|null), model: string, backend: "cli"}}
 */

// Diagnostic-only bound on each logged argv element (see sanitizeArgvForLog
// below) — independent of DEFAULT_SPAWN_MAX_BUFFER_BYTES, which governs the
// actual child process's stdout/stderr capture, not this summary string.
const MAX_LOGGED_ARGV_ELEMENT_LEN = 200;

// Diagnostic-only bound on the captured-output excerpt embedded directly in
// a CLI_BACKEND_FAILED error message (forge#2355). Deliberately much larger
// than MAX_LOGGED_ARGV_ELEMENT_LEN (200 chars) — that bound exists to keep a
// single argv element's *summary* short, but a truncated-to-200-chars
// captured-output excerpt would defeat the point of this fix (the whole goal
// is to give an operator reading the persisted `~/.forge/runs/*.jsonl`
// run-log enough of the CLI's actual failure text to diagnose it without
// re-running). 4000 chars is generous enough to carry a real stack
// trace/error while still bounding JSONL run-log line growth for very
// verbose CLI failures (issue #2355 AC4).
const MAX_LOGGED_OUTPUT_EXCERPT_LEN = 4000;

/**
 * Escape control/bidi-override characters and cap length, without joining
 * multiple elements. Shared core of `sanitizeArgvForLog` (which maps this
 * over an argv array with a small per-element bound) and
 * `sanitizeOutputExcerptForLog` (which applies it once to a full captured
 * stdout+stderr blob with a much larger bound) — both need the identical
 * escaping and surrogate-pair-safe truncation behavior hardened across
 * #2277/#2292/#2293; extracting it here keeps that behavior in one place
 * instead of duplicating it per bound.
 *
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function sanitizeAndCap(str, maxLen) {
  // eslint-disable-next-line no-control-regex -- intentional: neutralizing C0/DEL/C1 control chars and Unicode bidi-override/format chars is the point of this function
  const escaped = str.replace(/[\x00-\x1F\x7F-\x9F\u202A-\u202E\u2066-\u2069]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
  if (escaped.length <= maxLen) return escaped;
  // `.slice()` counts UTF-16 code units, not Unicode code points. If the cut
  // lands between a high surrogate (\uD800-\uDBFF) and its paired low
  // surrogate (\uDC00-\uDFFF) — e.g. an astral-plane emoji straddling the
  // boundary — a plain slice bisects the pair and leaves a lone/unpaired
  // surrogate at the tail, which can render as U+FFFD or otherwise
  // mis-encode downstream (#2293). Trim one additional unit in that case so
  // the cut never lands mid-pair.
  let cutLen = maxLen;
  const lastCode = escaped.charCodeAt(cutLen - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cutLen -= 1;
  return `${escaped.slice(0, cutLen)}…[truncated, ${escaped.length} chars]`;
}

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
  return cliArgs.map((arg) => sanitizeAndCap(String(arg), MAX_LOGGED_ARGV_ELEMENT_LEN)).join(" ");
}

/**
 * Build a safe-for-error-messages excerpt of the CLI's captured stdout+stderr
 * output, for embedding directly in a CLI_BACKEND_FAILED error's message
 * (forge#2355).
 *
 * Prior to this fix, the non-zero-exit diagnostic only *logged* the captured
 * output (`logger.log(diagnostic)` in `runCliBackend` below) and threw a
 * self-referential message pointing at that log line ("See captured output
 * above."). `logger.log()` writes to the orchestrating process's own
 * console/CI stream, which is never persisted into the durable
 * `~/.forge/runs/*.jsonl` run-log — only the thrown `Error.message` (via
 * `bin/engine.mjs`'s `reason: e.message` / fail-fast `detail` string) reaches
 * that persisted record. As a result, the single dominant engine failure mode
 * (50 of 69 `PHASE_FAILED` events in a 52-run-log audit) carried a reason that
 * pointed at output the run-log never captured, leaving operators nothing to
 * diagnose post-hoc. This function embeds a bounded excerpt of the real
 * output directly in the message instead.
 *
 * `output` is raw, untrusted CLI stdout/stderr — the CLI itself echoes
 * untrusted issue/PR body content it was fed (see the SECURITY note on
 * `sanitizeArgvForLog` above) — so it carries the identical injection risk
 * class already hardened for `argvSummary` across #2277/#2292/#2293. This
 * function reuses the exact same `sanitizeAndCap` escaping/truncation core,
 * just with a much larger bound (`MAX_LOGGED_OUTPUT_EXCERPT_LEN`) appropriate
 * for a diagnostic excerpt rather than a short argv summary.
 *
 * @param {string} output - combined, already-captured stdout+stderr text
 * @returns {string} bounded, sanitized excerpt safe to embed in Error.message
 */
export function sanitizeOutputExcerptForLog(output) {
  return sanitizeAndCap(String(output), MAX_LOGGED_OUTPUT_EXCERPT_LEN);
}

/**
 * Best-effort extraction of a Claude CLI session-limit reset time from
 * captured stdout/stderr (forge#2241). The CLI's own session-limit message
 * looks like `You've hit your session limit · resets 12:50am (Asia/Calcutta)`
 * — when present, this lets a non-zero-exit CLI_BACKEND_FAILED surface *when*
 * the quota resets instead of forcing a human to read raw logs (issue #2241
 * AC3). Deliberately narrow and case-insensitive: anchored on the literal
 * "session limit" phrase plus a trailing "resets ..." clause, so it can never
 * misattribute an unrelated crash's output as a reset time (see #2258/#2277/
 * #2292/#2293 — this same diagnostic branch has repeatedly needed defensive
 * narrowing around untrusted CLI output).
 *
 * @param {string} output - combined, already-captured stdout+stderr text
 * @returns {string|undefined} the reset-time text (trimmed), or undefined if
 *   no session-limit pattern was found — callers must not fabricate a value
 *   when this returns undefined.
 */
export function extractSessionLimitResetTime(output) {
  if (!output) return undefined;
  const match = /session limit[^\n]*?resets?\s+([^\n]+?)\s*$/im.exec(output);
  if (!match) return undefined;
  const resetAt = match[1].trim();
  if (resetAt.length === 0) return undefined;
  // Security review finding (forge#2241, PR #2323): `resetAt` is extracted
  // from raw, untrusted CLI stdout/stderr — the same `output` that #2277/
  // #2292/#2293 fixed control-char/bidi-override/surrogate-pair injection
  // for in the neighboring CLI_BACKEND_FAILED diagnostic. Route it through
  // the same sanitizeArgvForLog() escaping + length-capping used for
  // argvSummary before it can reach err.resetAt -> the engine-error
  // terminate detail -> operator-visible terminal/CI logs, so this new call
  // site inherits the identical defensive posture instead of reopening that
  // threat model via a fresh, unsanitized path.
  return sanitizeArgvForLog([resetAt]);
}

/**
 * Computes the UTC offset (in ms) `timeZone` observes at `instantMs`, defined
 * such that `wallClockAsUTC = instantMs + offset` — i.e. a positive offset
 * means the zone is ahead of UTC at that instant. Used by
 * `wallTimeInZoneToEpochMs()` below to convert a local wall-clock time back
 * into a real UTC epoch, correctly handling DST for zones that observe it
 * (though the only zone shape actually seen in production CLI output today —
 * `Asia/Calcutta`, a fixed +5:30 IANA link name with no DST — never needs the
 * iteration this enables; the general form is kept so any zone name the CLI
 * reports is handled correctly, not just the one observed so far).
 *
 * @param {number} instantMs - a real UTC epoch instant
 * @param {string} timeZone - IANA zone name (e.g. "Asia/Calcutta")
 * @returns {number} offset in ms
 */
function tzOffsetMsAtInstant(instantMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(instantMs)).map((p) => [p.type, p.value]));
  const localAsUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return localAsUTC - instantMs;
}

/**
 * Converts a local wall-clock time `(y, mo, d, h, mi, s)` *in* `timeZone*
 * into the real UTC epoch ms instant it represents. Two-iteration
 * fixed-point refinement using `tzOffsetMsAtInstant()` above — sufficient
 * for every real-world zone (including DST transitions, which shift the
 * offset by at most a couple of hours, well within one refinement step).
 *
 * @returns {number} UTC epoch ms
 */
function wallTimeInZoneToEpochMs(y, mo, d, h, mi, s, timeZone) {
  const naiveUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = naiveUtc;
  for (let i = 0; i < 2; i++) {
    guess = naiveUtc - tzOffsetMsAtInstant(guess, timeZone);
  }
  return guess;
}

/**
 * Parses the CLI's session-limit reset-time text (forge#2241's
 * `extractSessionLimitResetTime()` output — e.g. `"12:50am (Asia/Calcutta)"`)
 * into a machine-usable UTC epoch ms timestamp (forge#2524 AC5). The CLI only
 * ever reports a bare time-of-day plus an IANA zone name, never a date — the
 * reset is always the *next* occurrence of that wall-clock time from `nowMs`,
 * so this resolves "today" in the target zone and rolls forward one day if
 * that candidate has already passed.
 *
 * Deliberately narrow, mirroring `extractSessionLimitResetTime()`'s own
 * "never fabricate a value" contract: returns `undefined` on any input that
 * doesn't match the exact expected shape, or names a timezone
 * `Intl.DateTimeFormat` doesn't recognize — callers must treat `undefined` as
 * "could not compute a wait duration", never substitute a guessed default.
 *
 * @param {string|undefined} resetAtText - the (already-sanitized) display
 *   string from `extractSessionLimitResetTime()`
 * @param {number} [nowMs] - current time; defaults to `Date.now()`, overridable for tests
 * @returns {number|undefined} UTC epoch ms of the next occurrence of that
 *   wall-clock time in that zone, or `undefined` if unparseable
 */
export function parseSessionLimitResetEpochMs(resetAtText, nowMs = Date.now()) {
  if (!resetAtText) return undefined;
  const match = /^(\d{1,2}):(\d{2})\s*([ap]m)\s*\(([^)]+)\)\s*$/i.exec(resetAtText.trim());
  if (!match) return undefined;
  const [, hourStr, minuteStr, ampm, timeZone] = match;
  const rawHour = parseInt(hourStr, 10);
  // Reject out-of-range hours BEFORE the `% 12` conversion below — otherwise
  // malformed input like "13:30pm" or "99:30pm" silently aliases to a
  // plausible-but-wrong hour (13 % 12 = 1, 99 % 12 = 3) instead of being
  // rejected, violating this function's own "never fabricate a value"
  // contract. Mirrors the `minute > 59` guard further down.
  if (rawHour < 1 || rawHour > 12) return undefined;
  let hour = rawHour % 12;
  if (/pm/i.test(ampm)) hour += 12;
  const minute = parseInt(minuteStr, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return undefined;

  let todayParts;
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    });
    todayParts = Object.fromEntries(dtf.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  } catch {
    // Unrecognized IANA zone name — Intl throws a RangeError. Do not fabricate
    // a value; the caller must treat this identically to any other parse failure.
    return undefined;
  }

  const y = +todayParts.year, mo = +todayParts.month, d = +todayParts.day;
  let epoch = wallTimeInZoneToEpochMs(y, mo, d, hour, minute, 0, timeZone);
  // The CLI reports a reset time that is, by definition, in the future
  // relative to when it printed the message — if today's candidate has
  // already passed `nowMs`, the real reset is tomorrow at the same wall-clock time.
  if (epoch <= nowMs) {
    epoch = wallTimeInZoneToEpochMs(y, mo, d + 1, hour, minute, 0, timeZone);
  }
  return epoch;
}

/**
 * Coerce a single CLI-reported `usage.*` field to a finite number, or `0`
 * when it isn't one (forge#2424). `?? 0` only replaces `null`/`undefined` —
 * it does not coerce or reject other non-numeric values (e.g. a string), so
 * a malformed/unexpected field previously flowed through unchanged and later
 * string-concatenated instead of numerically adding in
 * bin/batch-runner.mjs's `tokenCost()` (`input + output`). Applied to all
 * four `usage.*` fields parsed from the CLI's `--output-format json`
 * envelope, which — unlike the API backend's SDK-typed `response.usage` — is
 * arbitrary CLI stdout and must not be trusted to already be well-typed.
 *
 * @param {unknown} value - raw field value from the parsed CLI JSON envelope
 * @returns {number} a finite number, or `0` when `value` is not one
 */
function toFiniteUsageNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
  let cliArgs = [
    "--print",
    userMessage,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
  ];

  try {
    if (systemPrompt) {
      const createdDir = mkdtempSync(join(os.tmpdir(), "forgedock-cli-system-prompt-"));
      tmpDir = createdDir;
      const systemPromptPath = join(createdDir, "system-prompt.txt");
      writeFileSync(systemPromptPath, systemPrompt, "utf-8");
      cliArgs = [
        "--print",
        userMessage,
        "--output-format",
        "json",
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
    // unparsed elements — see the SECURITY note above. `bin` is expected to
    // already be a fully-resolved absolute path (see `resolveClaudeCliBinary()`
    // and the `opts.bin` doc comment above, issue #2741) — spawnSync launches
    // an already-resolved `.exe`/`.cmd`/`.bat` path directly (with Node's
    // built-in special-cased `.cmd`/`.bat` re-exec) without needing any
    // further shell/PATHEXT resolution of its own.
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
      // forge#2360: spawnSync's `timeout` option kills the child outright on
      // expiry, but any stdout/stderr the CLI had already produced up to
      // that point is still populated on `result` — surface it rather than
      // silently discarding it, mirroring both the `run_bash` timeout path
      // below (which appends its own captured `partial` output) and the
      // sibling `result.status !== 0` branch just below this one (forge#2355
      // / PR #2374), which embeds a bounded/sanitized excerpt of captured
      // output via `sanitizeOutputExcerptForLog()` for the same reason: only
      // `err.message` is persisted into the durable `~/.forge/runs/*.jsonl`
      // run-log (via bin/engine.mjs's `reason: e.message`), never the
      // `logger.log()` call. Reuses the exact same hardened helper — do NOT
      // add a new unsanitized/unbounded path here (this file has 4 prior
      // review findings — #2277, #2292, #2293, #2355 — for that defect
      // class).
      const partial = (stdout + stderr).trim();
      throw new Error(
        `claude CLI invocation timed out after ${timeoutSecs}s and was killed. ` +
          `Set FORGEDOCK_CLI_TIMEOUT_MS (ms) to adjust, or use --backend api.` +
          (partial ? ` Partial output: ${sanitizeOutputExcerptForLog(partial)}` : ""),
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

      // forge#2355: when `hadOutput` is true, embed a bounded/sanitized
      // excerpt of the actual captured output directly in the thrown
      // Error's message, rather than only pointing at the `logger.log()`
      // call above. `logger.log()` writes to the orchestrating process's
      // console/CI stream — it is NEVER persisted into the durable
      // `~/.forge/runs/*.jsonl` run-log. Only `e.message` (via
      // `bin/engine.mjs`'s `reason: e.message` / fail-fast `detail` string,
      // both of which already interpolate `e.message` verbatim) reaches that
      // persisted record. Without this, the run-log's `PHASE_FAILED.reason`
      // carried a self-referential pointer to output that was already gone
      // by the time anyone read the log — this was the single dominant
      // engine failure mode (50 of 69 `PHASE_FAILED` events in a 52-run-log
      // audit — see issue #2355). The `!hadOutput` branch below is
      // intentionally left unchanged: it was already fixed by #2258/PR #2276
      // to be self-contained.
      const outputExcerpt = hadOutput ? sanitizeOutputExcerptForLog(output) : "";
      const err = new Error(
        `claude CLI exited with status ${result.status ?? "?"}${signalPart}. ` +
          (hadOutput
            ? `Output: ${outputExcerpt}`
            : "No output was captured (stdout and stderr were both empty).") +
          ` Invocation: ${bin} ${argvSummary} (cwd: ${cwd})`,
      );
      err.code = "CLI_BACKEND_FAILED";
      // forge#2241: attach the CLI's reported session-limit reset time (when
      // present) so callers (bin/engine.mjs) can surface *when* a
      // quota-exhaustion failure will clear without reading raw logs. Only
      // ever set when the pattern actually matches — never fabricated.
      const resetAt = extractSessionLimitResetTime(output);
      if (resetAt) {
        err.resetAt = resetAt;
        // forge#2524: also attach a machine-usable epoch-ms timestamp so
        // bin/engine.mjs can compute an actual wait duration and pause
        // in-process instead of merely displaying the reset time. Only ever
        // set when parsing succeeds — never fabricated (mirrors resetAt's
        // own contract). A future/unparseable reset time simply leaves this
        // field absent, and the caller's fail-fast/terminate behavior is
        // unaffected (see bin/engine.mjs's runIssue() pause-loop guard).
        const resetAtEpochMs = parseSessionLimitResetEpochMs(resetAt, Date.now());
        if (resetAtEpochMs !== undefined) err.resetAtEpochMs = resetAtEpochMs;
      }
      throw err;
    }

    // Parse the `--output-format json` single-result envelope requested
    // above. `claude --print --output-format json` emits a JSON object with
    // (among other fields) a top-level `result` string — the same
    // human-readable text the CLI would otherwise print in plain-text mode —
    // and a top-level `usage` object shaped like the Anthropic SDK's
    // `response.usage` (`input_tokens`/`output_tokens`/
    // `cache_creation_input_tokens`/`cache_read_input_tokens`, plus extra
    // fields we don't need). Older CLI versions that ignore
    // `--output-format` (or any other non-JSON stdout) are handled
    // defensively: any parse failure, or a parsed value missing `usage`,
    // degrades to the pre-existing `usage: null` behavior — this must never
    // throw on the success path.
    //
    // forge#2422: parse `stdout` ALONE here, not `output` (the combined
    // `stdout + stderr` string used above for the timeout/non-zero-exit
    // diagnostics). `--output-format json` writes exactly one JSON object to
    // stdout; any warning/banner text a CLI version writes to stderr on an
    // otherwise-clean, zero-exit run (deprecation notice, Node
    // `--trace-warnings`, etc.) would corrupt the combined string and break
    // `JSON.parse`, silently degrading `usage` to `null` even though valid
    // JSON was on stdout. `output` itself is untouched — the diagnostic
    // branches above still need the combined stream.
    //
    // forge#2424: each usage field is coerced with `toFiniteUsageNumber()`
    // rather than `?? 0`. `?? 0` only replaces `null`/`undefined` — a
    // non-numeric value (e.g. a string) would pass through unchanged and
    // later string-concatenate instead of numerically add in
    // bin/batch-runner.mjs's `tokenCost()` (`input + output`).
    const stdoutTrimmed = stdout.trim();
    let parsedResult = null;
    let usage = null;
    try {
      const parsed = JSON.parse(stdoutTrimmed);
      if (parsed && typeof parsed === "object") {
        parsedResult = typeof parsed.result === "string" ? parsed.result : null;
        if (parsed.usage && typeof parsed.usage === "object") {
          usage = {
            input_tokens: toFiniteUsageNumber(parsed.usage.input_tokens),
            output_tokens: toFiniteUsageNumber(parsed.usage.output_tokens),
            cache_creation_input_tokens: toFiniteUsageNumber(
              parsed.usage.cache_creation_input_tokens,
            ),
            cache_read_input_tokens: toFiniteUsageNumber(parsed.usage.cache_read_input_tokens),
          };
        }
      }
    } catch {
      // Non-JSON output (older CLI, or --output-format was ignored) —
      // parsedResult/usage stay null; fall back to raw output below.
    }

    // Prefer the parsed envelope's human-readable `.result` string so
    // console output stays prose, not a raw JSON blob; fall back to the raw
    // captured output when parsing failed or `.result` was absent.
    //
    // forge#2456: `.result` alone would otherwise silently drop any non-empty
    // `stderr` on an exit-0 run (deprecation notice, Node runtime banner,
    // etc.) — a real behavior change from the pre-#2398 baseline, where the
    // combined stdout+stderr stream was always logged. Append trimmed
    // `stderr` after the parsed result when present, so operators still see
    // it; when `stderr` is empty (the common case) the logged string is
    // unchanged. This mirrors the same "combine streams instead of dropping
    // one" fix already applied to the `run_bash` tool handler's success path
    // in #1229. `JSON.parse` itself still targets `stdout` alone (forge#2422)
    // — only the logged/displayed string composition changes here.
    //
    // forge#2483/forge#2484 (batch #2522): two follow-up fixes to the
    // forge#2456 composition above, applied together since they share the
    // exact same lines:
    //   - forge#2483: `stderrTrimmed` is untrusted subprocess output (the CLI
    //     echoes untrusted issue/PR body content — the same threat class
    //     `sanitizeArgvForLog`/`sanitizeOutputExcerptForLog` already harden
    //     for the timeout/non-zero-exit diagnostic paths above). It is now
    //     routed through the same `sanitizeOutputExcerptForLog()` helper
    //     before being concatenated into `humanOutput`, instead of reaching
    //     `logger.log()` raw.
    //   - forge#2484: `parsedResult !== null` is true even when
    //     `parsedResult === ""` (the earlier `typeof parsed.result ===
    //     "string"` check accepts `""`). Previously that produced
    //     `"" + "\n" + stderrTrimmed` — a leading-newline-only artifact.
    //     `parsedResult` (truthy check, not `!== null`) now gates the
    //     "prefix with parsedResult" behavior, so an empty `.result` falls
    //     through to the sanitized stderr alone, with no separator.
    // The `parsedResult === null` fallback branch (raw `output`) is
    // untouched by either fix — out of scope for both findings.
    const stderrTrimmed = stderr.trim();
    const sanitizedStderr = stderrTrimmed ? sanitizeOutputExcerptForLog(stderrTrimmed) : "";
    const humanOutput =
      parsedResult !== null
        ? parsedResult
          ? sanitizedStderr
            ? `${parsedResult}\n${sanitizedStderr}`
            : parsedResult
          : sanitizedStderr
        : output;
    if (humanOutput) logger.log(humanOutput);

    logger.log(
      renderSummaryCard({
        command: spec.name,
        args,
        iterations: 1,
        stopReason: "cli_exit_0",
        usage,
      }),
    );

    return {
      status: "complete",
      command: spec.name,
      iterations: 1,
      stopReason: "cli_exit_0",
      usage,
      model: "cli",
      backend: "cli",
    };
  } finally {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

/**
 * Execute one ForgeDock workflow with the native runtime. Unlike the legacy
 * CLI adapter this is asynchronous, so engine lease heartbeats and
 * cancellation timers continue to run while the agent is working.
 */
const NATIVE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "CI",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "SSH_AUTH_SOCK",
];

/** Build the least-privilege environment inherited by native agent workers. */
export function buildNativeChildEnv(env = process.env) {
  const childEnv = {};
  for (const key of NATIVE_ENV_ALLOWLIST) {
    if (env[key] !== undefined) childEnv[key] = env[key];
  }
  const extra = String(env.FORGEDOCK_PASSTHROUGH_ENV || "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  for (const key of extra) {
    if (env[key] !== undefined) childEnv[key] = env[key];
  }
  return childEnv;
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener?.("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    child.once?.("close", finish);
  });
}

/** Terminate the complete native worker tree before the engine releases it. */
export async function terminateNativeProcessTree(child) {
  if (process.platform === "win32" && Number.isInteger(child?.pid)) {
    const killed = await new Promise((resolve) => {
      let killer;
      try {
        killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        child.kill?.("SIGTERM");
        resolve(false);
        return;
      }
      const timer = setTimeout(() => resolve(false), 2_000);
      timer.unref?.();
      killer.once("close", (status) => {
        clearTimeout(timer);
        resolve(status === 0);
      });
      killer.once("error", () => {
        child.kill?.("SIGTERM");
        clearTimeout(timer);
        resolve(false);
      });
    });
    await waitForChildExit(child, killed ? 500 : 750);
    if (child?.exitCode == null && child?.signalCode == null) {
      throw new Error("native worker process tree is still running after taskkill");
    }
    return;
  }

  if (process.platform !== "win32" && Number.isInteger(child?.pid)) {
    const groupAlive = () => {
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (err) {
        return err?.code !== "ESRCH";
      }
    };
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (err) {
      if (err?.code !== "ESRCH") child.kill?.("SIGTERM");
    }
    await waitForChildExit(child, 750);
    if (groupAlive()) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (err) {
        if (err?.code !== "ESRCH") child.kill?.("SIGKILL");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (groupAlive()) {
      throw new Error("native worker process group is still running after SIGKILL");
    }
    return;
  }

  try {
    child.kill?.("SIGTERM");
  } catch {
    child.kill?.("SIGTERM");
  }
  await waitForChildExit(child, 750);
  if (child?.exitCode == null && child?.signalCode == null) {
    try {
      child.kill?.("SIGKILL");
    } catch {
      child.kill?.("SIGKILL");
    }
    await waitForChildExit(child, 250);
  }
  if (child?.exitCode == null && child?.signalCode == null) {
    throw new Error("native worker process group is still running after SIGKILL");
  }
}

export function runNativeBackend({
  spec,
  userMessage,
  args = [],
  cwd,
  model,
  logger = console,
  bin,
  spawnFn = spawn,
  terminateFn = terminateNativeProcessTree,
}) {
  const brandOutput = (value) => String(value ?? "").replace(/opencode/giu, "ForgeDock");
  const rawTimeout = parseInt(process.env.FORGEDOCK_CLI_TIMEOUT_MS, 10);
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_CLI_TIMEOUT_MS;
  const runtimeBin = bin || process.env.FORGEDOCK_RUNTIME_BIN || "opencode";
  const commandSegments = String(spec.name).split(/[\\/]/).filter(Boolean);
  let commandsDir = dirname(spec.path);
  for (let i = 1; i < commandSegments.length; i++) commandsDir = dirname(commandsDir);
  const runtimeArgs = [
    "run",
    `Execute the attached ForgeDock workflow specification for ${userMessage}. ` +
      `Treat it as authoritative, complete every required phase, and present all output as ForgeDock. ` +
      `Resolve Skill(\"name\") by loading ${commandsDir}/name.md. Resolve nested skills from the same ` +
      `registry. Use isolated child agents for Agent/Task review boundaries; if isolation is required but ` +
      `unavailable, fail closed instead of reviewing inline.`,
    "--file",
    spec.path,
    "--format",
    "default",
    "--title",
    `ForgeDock /${spec.name}`,
    "--auto",
  ];
  if (model) runtimeArgs.push("--model", model);

  const childEnv = buildNativeChildEnv();

  return new Promise((resolve, reject) => {
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const signalHandlers = new Map();

    const removeSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
      signalHandlers.clear();
    };

    const finishError = (message, code = "CLI_BACKEND_FAILED") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      removeSignalHandlers();
      const err = new Error(message);
      err.code = code;
      reject(err);
    };

    try {
      child = spawnFn(runtimeBin, runtimeArgs, {
        cwd,
        env: childEnv,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const wrapped = new Error(
        `Failed to start the ForgeDock native runtime: ${brandOutput(err.message)}`,
      );
      wrapped.code = "CLI_BACKEND_FAILED";
      reject(wrapped);
      return;
    }

    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = async () => {
        try {
          await terminateFn(child);
        } catch (err) {
          process.stderr.write(
            `ForgeDock could not confirm native worker termination: ${brandOutput(err.message)}\n`,
          );
        } finally {
          removeSignalHandlers();
          process.kill(process.pid, signal);
        }
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }

    let timedOut = false;
    timer = setTimeout(async () => {
      timedOut = true;
      let terminationConfirmed = true;
      try {
        await terminateFn(child);
      } catch {
        terminationConfirmed = false;
        try {
          child.kill?.("SIGKILL");
        } catch {
          // The timeout remains authoritative even when termination reports an error.
        }
      }
      const partial = sanitizeOutputExcerptForLog(brandOutput((stdout + stderr).trim()));
      finishError(
        `ForgeDock native runtime timed out after ${Math.round(timeoutMs / 1000)}s. ` +
          (terminationConfirmed
            ? "The worker process tree was stopped."
            : "Worker termination could not be confirmed; manual process cleanup is required.") +
          (partial ? ` Partial output: ${partial}` : ""),
      );
    }, timeoutMs);

    const append = (current, chunk) => {
      const next = current + String(chunk ?? "");
      return next.length > DEFAULT_SPAWN_MAX_BUFFER_BYTES
        ? next.slice(next.length - DEFAULT_SPAWN_MAX_BUFFER_BYTES)
        : next;
    };
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (err) => {
      if (timedOut) return;
      finishError(`Failed to start the ForgeDock native runtime: ${brandOutput(err.message)}`);
    });
    child.once("close", (status, signal) => {
      if (settled || timedOut) return;
      settled = true;
      clearTimeout(timer);
      removeSignalHandlers();
      const output = stdout.trim();
      const diagnostics = stderr.trim();
      if (status !== 0) {
        const excerpt = sanitizeOutputExcerptForLog(brandOutput((output + diagnostics).trim()));
        const err = new Error(
          `ForgeDock native runtime exited with status ${status ?? "?"}` +
            (signal ? `, signal ${signal}` : "") +
            (excerpt ? `. Output: ${excerpt}` : ". No output was captured."),
        );
        err.code = "CLI_BACKEND_FAILED";
        reject(err);
        return;
      }

      if (output) logger.log(brandOutput(output));
      if (diagnostics) logger.log(sanitizeOutputExcerptForLog(brandOutput(diagnostics)));
      logger.log(
        renderSummaryCard({
          command: spec.name,
          args,
          iterations: 1,
          stopReason: "native_exit_0",
          usage: null,
        }),
      );
      resolve({
        status: "complete",
        command: spec.name,
        iterations: 1,
        stopReason: "native_exit_0",
        usage: null,
        model: model || "runtime-default",
        backend: "native",
      });
    });
  });
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
 * @param {{spec: object, systemPrompt: string, userMessage: string, model: string, maxIterations: number, backend?: "native"|"cli"|"api"}} ctx
 * @returns {string}
 */
export function renderDryRun(ctx) {
  const { spec, systemPrompt, userMessage, model, maxIterations, backend } = ctx;
  const backendLine =
    backend === "native"
      ? `│ backend:        native (ForgeDock managed runtime)`
      : backend === "cli"
      ? `│ backend:        cli (claude CLI detected — no ANTHROPIC_API_KEY needed)`
      : backend === "api"
        ? `│ backend:        api (ANTHROPIC_API_KEY required)`
        : null;
  const toolsLine =
    backend === "native"
      ? `│ tools:          ForgeDock native workspace tools`
      : backend === "cli"
      ? `│ tools:          claude CLI's native tools (Read/Write/Edit/Bash/etc. — not TOOL_DEFINITIONS below)`
      : `│ tools:          ${TOOL_DEFINITIONS.map((t) => t.name).join(", ")}`;
  const systemPromptLine =
    backend === "native"
      ? `│ workflow:       ${systemPrompt.length} chars (attached from the ForgeDock command registry)`
      : backend === "cli"
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
    `(dry-run) No agent process or API call was started.`,
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
 * @param {string} [opts.backend]            - "native" | "cli" | "api" | "auto" (default
 *   "auto"). Resolution order when omitted: $FORGEDOCK_BACKEND env > "auto".
 *   "auto" prefers ForgeDock's native runtime, then the local Claude Code
 *   CLI, and finally the API backend. This
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
    backend = process.env.FORGEDOCK_BACKEND || resolveConfiguredBackend(cwd) || "auto",
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
    const previewModel =
      resolvedBackend === "native"
        ? Object.prototype.hasOwnProperty.call(opts, "model")
          ? model
          : process.env.FORGEDOCK_MODEL || "runtime-default"
        : model;
    logger.log(
      renderDryRun({
        spec,
        systemPrompt:
          resolvedBackend === "cli"
            ? cliSystemPrompt
            : resolvedBackend === "native"
              ? spec.content
              : systemPrompt,
        userMessage,
        model: previewModel,
        maxIterations,
        backend: resolvedBackend,
      }),
    );
    return {
      status: "dry-run",
      command: spec.name,
      args,
      specPath: spec.path,
      model: previewModel,
      backend: resolvedBackend,
    };
  }

  if (resolvedBackend === "native") {
    const resolvedBin = resolveNativeRuntimeBinary(cwd);
    if (!resolvedBin) {
      const err = new Error(
        "ForgeDock native runtime is unavailable. Run `forgedock doctor`, " +
          "set FORGEDOCK_RUNTIME_BIN, or select --backend cli|api.",
      );
      err.code = "CLI_BACKEND_FAILED";
      throw err;
    }
    const requestedModel = Object.prototype.hasOwnProperty.call(opts, "model")
      ? model
      : process.env.FORGEDOCK_MODEL || undefined;
    return runNativeBackend({
      spec,
      userMessage,
      args,
      cwd,
      model: requestedModel,
      logger,
      bin: resolvedBin,
    });
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
    // Pass the exact absolute path isClaudeCliAvailable() already validated
    // for this cwd (issue #2741) — resolveClaudeCliBinary() reuses that same
    // per-cwd cache, so this does not trigger a second probe. Falls back to
    // the bare "claude" name only if resolution genuinely found nothing
    // (e.g. an injected-execImpl test scenario with no path-like output),
    // preserving prior behavior in that edge case.
    const resolvedBin = resolveClaudeCliBinary(cwd) ?? "claude";
    return runCliBackend({
      spec,
      userMessage,
      systemPrompt: cliSystemPrompt,
      args,
      cwd,
      logger,
      bin: resolvedBin,
    });
  }

  if (!apiKey) {
    const err = new Error(
        "No executable backend is configured. Run `forgedock doctor`, pass --dry-run to preview, " +
        "or select --backend native|cli after authenticating that runtime.",
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
