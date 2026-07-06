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
 *   buildUserMessage(name, args)            → string
 *   TOOL_DEFINITIONS                        → object[]      (Anthropic tool schemas)
 *   truncateToolResult(content)             → string        (cap + truncation marker)
 *   resolveBashShell()                      → string|undefined (explicit shell for run_bash)
 *   getToolHandlers(cwd)                    → Record<string, fn>
 *   renderDryRun(ctx)                       → string
 *   renderSummaryCard(ctx)                  → string
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
  realpathSync,
} from "fs";
import { join, dirname, basename, relative, isAbsolute } from "path";
import { execSync, spawnSync } from "child_process";

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_MAX_TOKENS = 16384;
// Default wall-clock limit for a single run_bash command. Chosen to be
// generous enough for CI steps (git clones, test suites) while bounding
// the worst-case hang to 5 minutes. Override via FORGEDOCK_BASH_TIMEOUT (ms).
const DEFAULT_BASH_TIMEOUT_MS = 5 * 60 * 1000;
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
          : 50 * 1024 * 1024;
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
 * @param {{spec: object, systemPrompt: string, userMessage: string, model: string, maxIterations: number}} ctx
 * @returns {string}
 */
export function renderDryRun(ctx) {
  const { spec, systemPrompt, userMessage, model, maxIterations } = ctx;
  return [
    `┌─ ForgeDock run (dry-run) ───────────────────────────────`,
    `│ command:        /${spec.name}`,
    `│ spec:           ${spec.path}`,
    `│ model:          ${model}`,
    `│ max iterations: ${maxIterations}`,
    `│ tools:          ${TOOL_DEFINITIONS.map((t) => t.name).join(", ")}`,
    `│ system prompt:  ${systemPrompt.length} chars`,
    `│ user message:   ${userMessage}`,
    `└─────────────────────────────────────────────────────────`,
    ``,
    `(dry-run) No API call made. Set ANTHROPIC_API_KEY and install`,
    `@anthropic-ai/sdk, then drop --dry-run to execute the pipeline.`,
  ].join("\n");
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
 * @param {string} [opts.model]              - Model id.
 * @param {number} [opts.maxIterations]      - Tool-loop bound.
 * @param {boolean} [opts.dryRun]            - Preview without an API call.
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
    model = process.env.FORGEDOCK_MODEL || DEFAULT_MODEL,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    dryRun = false,
    logger = console,
  } = opts;

  const spec = loadCommandSpec(commandsDir, commandName);
  const systemPrompt = buildSystemPrompt(spec, { repoRoot: cwd });
  const userMessage = buildUserMessage(commandName, args);

  if (dryRun) {
    logger.log(renderDryRun({ spec, systemPrompt, userMessage, model, maxIterations }));
    return { status: "dry-run", command: spec.name, args, specPath: spec.path, model };
  }

  if (!apiKey) {
    const err = new Error(
      "ANTHROPIC_API_KEY is not set. Export your Anthropic API key to run the live pipeline, or pass --dry-run to preview.",
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
  return { status: "max-iterations", command: spec.name, iterations, usage, model };
}
