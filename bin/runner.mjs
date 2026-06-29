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
} from "fs";
import { join, dirname, relative, isAbsolute } from "path";
import { execSync } from "child_process";

const DEFAULT_MODEL = "claude-sonnet-4-5";
const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_MAX_TOKENS = 8192;
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
 * @param {string} cwd   - Absolute path to the allowed root directory.
 * @param {string} p     - Model-supplied path (must be relative).
 * @returns {string}     - Absolute resolved path (guaranteed inside cwd).
 * @throws {Error}       - If p is absolute or resolves outside cwd.
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
  return resolved;
}

/**
 * Resolve an explicit bash shell for run_bash, or undefined to fall back to the
 * platform default shell. The system prompt instructs the model to use
 * bash-style git/gh/scripts invocations, so executing under bash keeps behavior
 * consistent across platforms rather than following the host default (cmd.exe
 * on Windows). A FORGEDOCK_SHELL override always wins. When no bash is found we
 * return undefined so execSync falls back to the platform default and non-bash
 * hosts still work.
 *
 * @returns {string|undefined} Absolute path to a bash shell, or undefined.
 */
export function resolveBashShell() {
  // Explicit override always wins (even cmd.exe, if the operator insists).
  const override = process.env.FORGEDOCK_SHELL;
  if (override && override.trim()) return override.trim();

  if (process.platform === "win32") {
    // Prefer Git Bash / WSL bash; fall back to the platform default if absent.
    const candidates = [
      join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
      join(
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "Git",
        "bin",
        "bash.exe",
      ),
      join(process.env.SystemRoot || "C:\\Windows", "System32", "bash.exe"),
    ];
    return candidates.find((c) => existsSync(c));
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
      // across platforms. `undefined` lets execSync use the platform default.
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
      try {
        return execSync(command, {
          cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 50 * 1024 * 1024,
          timeout: timeoutMs,
          env: childEnv,
          ...(shell ? { shell } : {}),
        });
      } catch (e) {
        const stdout = e.stdout ? String(e.stdout) : "";
        const stderr = e.stderr ? String(e.stderr) : "";
        // Detect timeout: e.killed is the primary indicator (set by Node.js on
        // most POSIX platforms), but on Windows execSync uses TerminateProcess()
        // which may not set e.killed reliably. Fall back to elapsed wall time —
        // if we spent at least as long as the timeout, the timer must have fired,
        // since a voluntarily-exiting process would have returned before then.
        const elapsedMs = Date.now() - startMs;
        if (e.killed || elapsedMs >= timeoutMs) {
          const timeoutSecs = Math.round(timeoutMs / 1000);
          const partial = (stdout + stderr).trim();
          throw new Error(
            `Command timed out after ${timeoutSecs}s and was killed. ` +
              `Set FORGEDOCK_BASH_TIMEOUT (ms) to adjust.` +
              (partial ? `\nPartial output:\n${partial}` : ""),
          );
        }
        // Surface the command's output AND exit status to the model so it can
        // react to failures rather than silently swallowing them.
        throw new Error(
          `Command failed (exit ${e.status ?? "?"}):\n${stdout}${stderr}`.trim(),
        );
      }
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
 * @param {{command: string, args: string[], iterations: number, stopReason: string}} ctx
 * @returns {string}
 */
export function renderSummaryCard(ctx) {
  const { command, args, iterations, stopReason } = ctx;
  const argStr = Array.isArray(args) ? args.join(" ") : String(args ?? "");
  return [
    ``,
    `┌─ ForgeDock pipeline summary ────────────────────────────`,
    `│ command:    /${command} ${argStr}`.trimEnd(),
    `│ iterations: ${iterations}`,
    `│ stop:       ${stopReason}`,
    `└─────────────────────────────────────────────────────────`,
  ].join("\n");
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
    return { status: "dry-run", command: spec.name, args, specPath: spec.path };
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
  const handlers = getToolHandlers(cwd);
  const messages = [{ role: "user", content: userMessage }];

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
        }),
      );
      return {
        status,
        command: spec.name,
        iterations,
        stopReason: response.stop_reason,
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
    }),
  );
  return { status: "max-iterations", command: spec.name, iterations };
}
