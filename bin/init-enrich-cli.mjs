/**
 * init-enrich-cli.mjs — local Claude Code CLI enrichment backend for
 * ForgeDock init (issue #2004).
 *
 * Implements the same enrich(ConfigDraft) contract as the API backend
 * (bin/init-enrich-api.mjs) so the selection ladder in bin/init-enrich.mjs
 * can treat both backends interchangeably. Unlike the API backend, this
 * backend requires NO ANTHROPIC_API_KEY — it shells out to an already
 * authenticated local `claude` CLI (subscription OAuth or CLI-managed key)
 * in headless print mode.
 *
 * SECURITY — argv array, NEVER `shell: true`: the enrichment prompt embeds
 * the full ConfigDraft JSON as a single, unparsed argv element passed to
 * `spawnSync(bin, [...argv])` with no shell. This mirrors the hardened
 * pattern in bin/runner.mjs's runCliBackend (issue #2003), fixed in commit
 * cf742a4 after an earlier shell-injection finding: an earlier version of
 * that function built a shell command *string* run via
 * `spawnSync(command, { shell: true })` with hand-rolled quoting that did
 * NOT neutralize `$(...)`/backtick/`!` expansion inside double quotes. Do
 * not reintroduce `shell: true` or string-command interpolation here.
 *
 * SECURITY — read-only enforcement via --allowedTools/--disallowedTools, NOT
 * --dangerously-skip-permissions: the prompt tells the model it "MUST NOT
 * modify, create, or delete any files," but `forgedock init` runs against an
 * arbitrary user's repo — untrusted content (README, existing config, file
 * names) could carry a prompt-injection payload that induces writes. A prose
 * instruction alone is not enforcement. `--dangerously-skip-permissions`
 * bypasses ALL permission checks for ALL tools (Write, Edit, Bash,
 * NotebookEdit, etc.), so it cannot be used here. Instead the session is
 * restricted with `--allowedTools` (pre-approved, read-only tools) and
 * `--disallowedTools` (explicitly denied mutating tools) — both are
 * headless-safe (no interactive TTY prompt is generated for tools covered by
 * either list), so this preserves the original reason
 * `--dangerously-skip-permissions` was used (avoiding a hang on an
 * unanswerable permission prompt in `--print` mode) while making the
 * read-only contract technically enforced instead of compliance-only. Do not
 * reintroduce `--dangerously-skip-permissions` here. (See issue #2022.)
 *
 * The allow-list is the actual enforcement boundary, NOT the disallow-list:
 * only the tools named in `--allowedTools` ("Read Glob Grep LS") are
 * permitted to execute at all — everything else is implicitly denied by
 * omission, exactly like a default-deny firewall rule. `--disallowedTools`
 * ("Write Edit NotebookEdit Bash") is passed in addition purely as
 * defense-in-depth: an explicit, redundant belt-and-suspenders denial of the
 * specific mutating tools most likely to be added to a future CLI default
 * allow-set. If the two lists were ever to conflict (a tool named in both),
 * the allow-list governs what CAN run — it is not overridden by a matching
 * disallow-list entry granting it back. Do not read the disallow-list as the
 * primary boundary and the allow-list as merely advisory; the reverse is
 * true. (See issue #2047.)
 *
 * Windows `.cmd` shim resolution works WITHOUT `shell: true`: Node's
 * spawn/spawnSync resolve a bare `"claude"` command via PATH+PATHEXT and
 * safely re-invoke through cmd.exe internally when the resolved target is a
 * `.cmd`/`.bat` file — argv elements are never parsed as shell syntax. Do
 * NOT use `execFileSync("claude", [...])` here; it does not resolve `.cmd`
 * shims on Windows and throws ENOENT even when the CLI is genuinely
 * installed (see issue #394/#382 — this exact regression previously made an
 * unrelated skill-based enrichment backend silently dead on Windows).
 *
 * Graceful fallback: any failure (CLI absent, timeout, non-zero exit, spawn
 * error, malformed/unparseable output) returns the original draft unchanged
 * and never throws — mirrors bin/init-enrich-api.mjs's existing contract so
 * a backend failure can never crash `forgedock init`. Failure category is
 * always surfaced to stderr (unconditionally, not gated behind
 * FORGEDOCK_DEBUG) — mirrors the API backend's error-surfacing discipline
 * (see issues #491/#497); only the raw error detail is debug-gated.
 */

import { spawnSync } from "child_process";
import { dim, yellow, RESET } from "./tui.mjs";
import { parseEnrichedDraft } from "./init-enrich-api.mjs";
import { DEFAULT_SPAWN_MAX_BUFFER_BYTES } from "./cli-spawn-shared.mjs";

/**
 * Default wall-clock limit for a single `claude --print` enrichment call.
 * This is a single-shot headless prompt (not a multi-turn agent loop like
 * bin/runner.mjs's runCliBackend), so it is deliberately much shorter than
 * that function's 15-minute DEFAULT_CLI_TIMEOUT_MS. Override via
 * FORGEDOCK_CLI_ENRICH_TIMEOUT_MS (ms).
 */
const DEFAULT_ENRICH_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Default maximum size (bytes, UTF-8) for the built enrichment prompt
 * (which embeds the full ConfigDraft JSON as a single argv element) before
 * `enrich()` skips the CLI spawn entirely and falls back to the baseline
 * draft unchanged (issue #2016).
 *
 * argv passed to `spawnSync` with `shell: false` (this module's contract —
 * see the SECURITY note above) still counts against the OS's total argv+env
 * size limit (`ARG_MAX` on POSIX, ~32K chars for a single CreateProcess
 * command line on Windows — see the SYSTEM PROMPT note in
 * bin/runner.mjs's runCliBackend for the same constraint on a different
 * code path). A ConfigDraft is normally a few KB, but pathological inputs
 * (very large `review.tech_stack`/`repos.satellites` arrays from a
 * multi-hundred-repo org) could grow large enough to risk hitting that OS
 * ceiling — which would surface as an opaque spawn failure rather than a
 * clean, diagnosable fallback. 256 KB is comfortably below every relevant
 * platform's argv limit while being far above any realistic ConfigDraft
 * size. Override via FORGEDOCK_CLI_ENRICH_MAX_PROMPT_BYTES.
 */
const DEFAULT_ENRICH_MAX_PROMPT_BYTES = 256 * 1024;

/**
 * Build the headless enrichment prompt sent to the local `claude` CLI.
 *
 * Unlike the API backend's SYSTEM_PROMPT (which explicitly tells the model
 * it has NO filesystem/tool access, since it's a stateless Messages API
 * call), the CLI backend genuinely runs with the CLI's normal tool access —
 * that access is the whole value proposition of this backend over the
 * API backend (it can inspect the actual repo, not just the ConfigDraft
 * JSON). The prompt still constrains scope and output shape identically to
 * the API backend's contract so downstream consumers (parseEnrichedDraft,
 * forge.yaml writer) see a consistent shape regardless of backend.
 *
 * @param {object} draft - ConfigDraft from detectConfig()
 * @returns {string}
 */
function buildEnrichPrompt(draft) {
  const draftJson = JSON.stringify(draft, null, 2);
  return (
    "You are the init-enrich CLI backend for ForgeDock. You receive a ConfigDraft " +
    "JSON object and return an enriched version, following the enrich(ConfigDraft) " +
    "contract shared with the API enrichment backend.\n\n" +
    "ENRICHMENT SCOPE (what you MAY improve):\n" +
    "- review.tech_stack: infer from the current working directory's codebase if recognizable patterns appear.\n" +
    "- review.context: improve wording or add standard context based on the project.\n" +
    "- verification.health_patterns: suggest standard patterns for known frameworks.\n" +
    "You may use your available tools to inspect the current working directory " +
    "(read files, list directories) to improve accuracy, but MUST NOT modify, " +
    "create, or delete any files.\n\n" +
    "STRICTLY PROHIBITED — set confidence to 'low' and do NOT invent values for:\n" +
    "- project_board.project_id (must match ^PVT_[A-Za-z0-9_=-]+$ — you cannot verify these).\n" +
    "- project_board.field_ids.* (PVTSSF_ strings — you cannot verify these).\n" +
    "- project_board.project_number (you cannot query the GitHub Projects API without gh CLI access to the correct account).\n" +
    "- repos.satellites (you cannot verify satellite repositories exist).\n" +
    "Never invent a PVT_ or PVTSSF_ string. If you cannot verify a field, set confidence to 'low'.\n\n" +
    "OUTPUT RULES:\n" +
    "- Return ONLY the enriched ConfigDraft as a valid JSON object.\n" +
    "- Every leaf must have shape { value, confidence, source, why }.\n" +
    "- Do not modify project, paths, branches, or meta sections.\n" +
    "- Output the JSON object alone with no surrounding prose, no markdown code fences.\n\n" +
    "ConfigDraft:\n" +
    draftJson
  );
}

/**
 * Enrich a ConfigDraft by invoking the local Claude Code CLI in headless
 * print mode. This is the cli backend for the init-enrich interface — it
 * implements the same enrich(ConfigDraft) contract as the api backend
 * (bin/init-enrich-api.mjs) so the selection ladder (bin/init-enrich.mjs)
 * can treat both interchangeably.
 *
 * Callers should verify CLI availability (via isClaudeCliAvailable from
 * bin/runner.mjs) before calling this — this function does not probe
 * availability itself, it directly attempts invocation and falls back
 * gracefully if the CLI turns out to be unavailable or misbehaves.
 *
 * @param {object} draft - ConfigDraft from detectConfig()
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Working directory for the CLI invocation
 *   (lets the CLI inspect the actual repo being configured). Defaults to
 *   process.cwd().
 * @param {string} [opts.bin] - Executable to invoke (default "claude").
 *   Test seam only — production callers must never override this.
 * @param {number} [opts.timeoutMs] - Wall-clock timeout override. Defaults
 *   to FORGEDOCK_CLI_ENRICH_TIMEOUT_MS env var, else DEFAULT_ENRICH_TIMEOUT_MS.
 * @param {Function} [opts.spawnFn] - Injectable replacement for
 *   child_process.spawnSync. Test seam only — lets tests deterministically
 *   simulate success/timeout/non-zero-exit/spawn-error without depending on
 *   a real `claude` install or OS-specific executable shimming.
 * @param {object} [opts.env] - Environment to derive the scrubbed child env
 *   from (see SECURITY note below). Defaults to process.env. Test seam —
 *   mirrors bin/init-enrich-api.mjs's opts.env, lets tests assert on the
 *   scrub without mutating the real process env.
 * @returns {Promise<object>} Enriched ConfigDraft, or the original draft on
 *   any failure.
 */
export async function enrich(draft, opts = {}) {
  const {
    cwd = process.cwd(),
    bin = "claude",
    timeoutMs,
    spawnFn = spawnSync,
    env = process.env,
  } = opts;

  const rawTimeout = parseInt(process.env.FORGEDOCK_CLI_ENRICH_TIMEOUT_MS, 10);
  const resolvedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : Number.isFinite(rawTimeout) && rawTimeout > 0
        ? rawTimeout
        : DEFAULT_ENRICH_TIMEOUT_MS;

  const message = buildEnrichPrompt(draft);

  // Reject an oversized prompt before ever spawning — see the
  // DEFAULT_ENRICH_MAX_PROMPT_BYTES doc comment (issue #2016). This mirrors
  // the graceful-fallback contract of every other failure branch below: no
  // throw, just an early return of the original draft.
  const rawMaxPromptBytes = parseInt(
    process.env.FORGEDOCK_CLI_ENRICH_MAX_PROMPT_BYTES,
    10,
  );
  const maxPromptBytes =
    Number.isFinite(rawMaxPromptBytes) && rawMaxPromptBytes > 0
      ? rawMaxPromptBytes
      : DEFAULT_ENRICH_MAX_PROMPT_BYTES;
  const messageBytes = Buffer.byteLength(message, "utf-8");
  if (messageBytes > maxPromptBytes) {
    warn(
      `skipped: ConfigDraft is too large to pass as a CLI argument (${messageBytes} bytes exceeds the ${maxPromptBytes} byte limit) — falling back to baseline draft`,
    );
    return draft;
  }

  // Scrub the Anthropic API key from the child environment. Even though this
  // backend is restricted to read-only tools (no bash) via
  // --allowedTools/--disallowedTools, the spawned `claude` process would
  // otherwise still inherit ANTHROPIC_API_KEY unnecessarily — mirrors the
  // scrub in bin/runner.mjs's runCliBackend/run_bash. GH_TOKEN/GITHUB_TOKEN
  // and all other env vars are intentionally left intact.
  const childEnv = { ...env };
  delete childEnv.ANTHROPIC_API_KEY;

  let result;
  try {
    // No `shell` option (defaults to false): argv is passed as discrete,
    // unparsed elements — see the SECURITY note in the module header. This
    // also correctly resolves the Windows `.cmd` shim without shell:true.
    //
    // --allowedTools/--disallowedTools (NOT --dangerously-skip-permissions):
    // technically restricts this headless session to read-only tools so the
    // prompt's "MUST NOT modify, create, or delete any files" instruction is
    // CLI-enforced, not just prose — see the SECURITY note in the module
    // header (issue #2022).
    result = spawnFn(
      bin,
      [
        "--print",
        message,
        "--allowedTools",
        "Read Glob Grep LS",
        "--disallowedTools",
        "Write Edit NotebookEdit Bash",
      ],
      {
        cwd,
        encoding: "utf-8",
        maxBuffer: DEFAULT_SPAWN_MAX_BUFFER_BYTES,
        timeout: resolvedTimeoutMs,
        env: childEnv,
      },
    );
  } catch (err) {
    // Unconditional summary is intentionally generic — err.message can
    // contain local filesystem paths (e.g. an ENOENT spawn error against a
    // custom `bin` path), which must not appear in always-visible stderr
    // output (issue #2017). Full detail is still available via the
    // FORGEDOCK_DEBUG-gated line inside warn().
    warn("unavailable (invocation failed)", err);
    return draft;
  }

  if (!result) {
    warn("unavailable: no result from CLI invocation");
    return draft;
  }

  const timedOut = result.status === null && result.error?.code === "ETIMEDOUT";
  if (timedOut) {
    const timeoutSecs = Math.round(resolvedTimeoutMs / 1000);
    warn(
      `timed out after ${timeoutSecs}s and was killed — falling back to baseline draft`,
    );
    return draft;
  }

  if (result.error) {
    // Same rationale as the catch block above: keep the unconditional
    // summary generic, raw detail (which can include local paths) stays
    // behind FORGEDOCK_DEBUG (issue #2017).
    warn("failed to invoke (spawn-level error)", result.error);
    return draft;
  }

  if (result.status !== 0) {
    warn(`exited with status ${result.status ?? "?"} — falling back to baseline draft`);
    return draft;
  }

  const stdout = result.stdout ? String(result.stdout) : "";
  return parseEnrichedDraft(stdout, draft);
}

/**
 * Emit a two-tier warning: a short, always-visible category to stderr
 * (never gated behind FORGEDOCK_DEBUG — see issues #491/#497 for why silent
 * failures are a bug class here), plus the raw error detail only under
 * FORGEDOCK_DEBUG.
 *
 * @param {string} summary - Short, user-facing failure category.
 * @param {Error} [err] - Original error, logged only under FORGEDOCK_DEBUG.
 */
function warn(summary, err) {
  console.error(
    `  ${yellow("[!]")} CLI enrichment ${summary}.${RESET}`,
  );
  if (process.env.FORGEDOCK_DEBUG && err) {
    console.error(`  ${dim("[debug]")} cli enrichment failed: ${err.message}`);
  }
}
