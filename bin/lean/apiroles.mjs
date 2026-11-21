// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5821: the one-shot read-only lane roles (the conformance reviewer and the independent verifier) as direct Messages
 * API calls instead of a fresh headless `claude` session. A fresh CLI session writes a ~37k-token baseline to cache
 * before the role reads its prompt; this path sends only a small stable prefix (two read-only tools + the role's system
 * prompt, cached) and the role's own prompt (issue, contract, rubric, diff). The reply text goes to the same parser
 * (parseReview / parseVerifierFindings), so the verdict format and blocking semantics are the CLI path's.
 *
 * Opt-in (engine.review_backend: cli|api|auto, default cli): the API bills ANTHROPIC_API_KEY per token while the CLI
 * may run on a subscription login. A missing key or SDK, an API error, a refusal or a truncated reply falls back to
 * the CLI runner for the same call, and the result carries `apiFallback` so the lane logs an API_ROLE_FALLBACK event.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseForgeYaml } from "../forge-utils.mjs";
import { estimateCostUsd, isOpenCodeRuntime } from "../runner.mjs";
import { toolStats } from "./toolstats.mjs";

export const REVIEW_BACKENDS = Object.freeze(["cli", "api", "auto"]);
/** Roles the API path may serve: fresh, read-only, one reply parsed by the engine. The builder keeps its CLI session. */
export const API_ROLES = Object.freeze(["reviewer", "verifier"]);
export const API_MAX_TOKENS = 64000;
export const API_EFFORT = "high";
export const API_DEFAULT_MAX_TURNS = 40;
export const API_DEFAULT_MAX_MS = 20 * 60000;
export const READ_MAX_BYTES = 100 * 1024;
export const READ_MAX_LINES = 2000;
export const GREP_MAX_LINES = 300;
export const GREP_MAX_BYTES = 40 * 1024;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Models that take server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODEL_RE = /^claude-(opus|sonnet)-5-5$/;

/**
 * USD per million tokens [input, output, cache read, cache write (5 min)] of the API models a lane routes to; any other
 * model falls back to runner.mjs estimateCostUsd. The CLI reports its own cost; this keeps API attempts comparable.
 */
export const API_PRICES = Object.freeze({
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
});
const n0 = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
export function apiCostUsd(usage, model) {
  if (!usage || typeof usage !== "object") return null;
  const p = API_PRICES[String(model ?? "")];
  if (!p) return estimateCostUsd(usage, model);
  const [i, o, cr, cw] = p;
  return Math.round(((n0(usage.input_tokens) * i + n0(usage.output_tokens) * o + n0(usage.cache_read_input_tokens) * cr + n0(usage.cache_creation_input_tokens) * cw) / 1e6) * 1e6) / 1e6;
}

/**
 * The backend setting: env FORGEDOCK_REVIEW_BACKEND (host owner) wins, then forge.yaml `engine.review_backend`, else
 * `cli`. Like `execution.agent_backend` (#4257), a committed forge.yaml value alone never starts billing an API key:
 * from forge.yaml, `api`/`auto` take effect only with FORGEDOCK_ALLOW_API_BACKEND=1 on the host (`approved: false` otherwise).
 */
export function readReviewBackend({ cwd = process.cwd(), env = process.env } = {}) {
  const fromEnv = String(env?.FORGEDOCK_REVIEW_BACKEND ?? "").trim().toLowerCase();
  if (REVIEW_BACKENDS.includes(fromEnv)) return { mode: fromEnv, source: "env", approved: true };
  let fromYaml = "";
  try {
    const p = join(cwd, "forge.yaml");
    if (existsSync(p)) fromYaml = String(parseForgeYaml(readFileSync(p, "utf8"))?.engine?.review_backend ?? "").trim().toLowerCase();
  } catch { fromYaml = ""; }
  if (REVIEW_BACKENDS.includes(fromYaml)) return { mode: fromYaml, source: "forge.yaml", approved: fromYaml === "cli" || String(env?.FORGEDOCK_ALLOW_API_BACKEND ?? "").trim() === "1" };
  return { mode: "cli", source: "default", approved: true };
}

/** Typed failure of the API path; `reason` is the fallback reason logged in API_ROLE_FALLBACK. */
export class ApiRoleError extends Error {
  constructor(reason, detail = "", extra = {}) {
    super(`${reason}${detail ? `: ${detail}` : ""}`);
    this.reason = reason;
    this.detail = String(detail ?? "").slice(0, 300);
    Object.assign(this, extra);
  }
}

/**
 * The fallback reason of an error thrown by the SDK or the loop, from the SDK's typed errors (never message text).
 * `sticky`: the condition holds for every later call of this process (bad key, unknown model), so the API is not retried.
 */
export function classifyApiError(e, sdk = {}) {
  if (e instanceof ApiRoleError) return { reason: e.reason, detail: e.detail, sticky: false };
  const is = (name) => typeof sdk[name] === "function" && e instanceof sdk[name];
  const detail = String(e?.message ?? e).split("\n")[0].slice(0, 300);
  if (is("AuthenticationError") || is("PermissionDeniedError")) return { reason: "api_auth", detail, sticky: true };
  if (is("NotFoundError")) return { reason: "api_not_found", detail, sticky: true };
  if (is("RateLimitError")) return { reason: "api_rate_limited", detail, sticky: false };
  if (is("BadRequestError") || is("UnprocessableEntityError")) return { reason: "api_bad_request", detail, sticky: false };
  if (is("APIUserAbortError") || is("APIConnectionTimeoutError")) return { reason: "api_timeout", detail, sticky: false };
  if (is("APIConnectionError")) return { reason: "api_connection", detail, sticky: false };
  if (is("APIError")) return { reason: `api_status_${e?.status ?? "unknown"}`, detail, sticky: false };
  return { reason: "api_error", detail, sticky: false };
}

/** The read-only tools of the API path. Read, Grep and Glob of the CLI path map to these two. */
export const READ_ONLY_TOOLS = Object.freeze([
  {
    name: "read_file",
    description: "Read one git-tracked file of the worktree (the changed version). Returns numbered lines (`<line>\\t<text>`), at most 2000 lines or 100 KB per call; pass start_line/end_line for a range of a large file.",
    input_schema: { type: "object", properties: { path: { type: "string", description: "Repo-relative path, e.g. bin/lean/x.mjs" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false },
    eager_input_streaming: true,
  },
  {
    name: "grep",
    description: "Search the git-tracked files of the worktree with an extended regular expression (git grep -n -I -E). Returns `path:line:text`, at most 300 lines. Optional `path` limits the search to a file or directory.",
    input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"], additionalProperties: false },
    eager_input_streaming: true,
  },
]);

export const API_TOOLS_NOTE = "In this session the read-only tools are read_file (one repo-relative, git-tracked path; numbered lines) and grep (git grep over tracked files; path:line:text). They stand in for Read, Grep and Glob; nothing can be run or written. Read only what the prompt does not already show.";

const relOk = (p) => typeof p === "string" && p.trim() !== "" && p.length <= 1000 && !isAbsolute(p) && !p.includes("\0") && !p.startsWith(":") && !p.split(/[\\/]/).includes("..");

/**
 * Handlers of READ_ONLY_TOOLS for worktree `cwd`. Allowlist: git-tracked files only (no untracked secrets, no .git),
 * confined to the worktree after symlink resolution, bounded output. Argv-only `git`, no shell, no writes.
 */
export function makeReadOnlyHandlers(cwd, { git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }) } = {}) {
  let tracked = null;
  const trackedSet = () => (tracked ??= new Set(String(git(["ls-files", "-z"])).split("\0").filter(Boolean)));
  const root = realpathSync(cwd);
  return {
    read_file(input) {
      const p = String(input?.path ?? "").replace(/^\.\//, "");
      if (!relOk(p)) throw new Error("path must be a repo-relative path inside the worktree");
      if (!trackedSet().has(p)) throw new Error(`not a git-tracked file of the worktree: ${p}`);
      const abs = resolve(root, p);
      const real = realpathSync(abs);
      const rel = relative(root, real);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path resolves outside the worktree: ${p}`);
      if (!statSync(real).isFile()) throw new Error(`not a file: ${p}`);
      const lines = readFileSync(real, "utf8").split("\n");
      const start = Number.isInteger(input?.start_line) && input.start_line > 0 ? input.start_line : 1;
      const endWanted = Number.isInteger(input?.end_line) && input.end_line >= start ? input.end_line : lines.length;
      const out = [];
      let bytes = 0, i = start;
      for (; i <= Math.min(endWanted, lines.length) && out.length < READ_MAX_LINES; i++) {
        const row = `${i}\t${lines[i - 1]}`;
        bytes += Buffer.byteLength(row, "utf8") + 1;
        if (bytes > READ_MAX_BYTES) break;
        out.push(row);
      }
      const last = i - 1;
      return out.join("\n") + (last < Math.min(endWanted, lines.length) ? `\n[truncated at line ${last} of ${lines.length}; read on with start_line ${last + 1}]` : "");
    },
    grep(input) {
      const pattern = String(input?.pattern ?? "");
      if (!pattern || pattern.length > 500) throw new Error("pattern must be 1-500 characters");
      const path = input?.path == null || input.path === "" ? null : String(input.path).replace(/^\.\//, "");
      if (path !== null && !relOk(path)) throw new Error("path must be a repo-relative path inside the worktree");
      let out;
      try { out = String(git(["grep", "-n", "-I", "-E", "-e", pattern, "--", ...(path ? [path] : [])])); }
      catch (e) { if (e?.status === 1) return "(no matches)"; throw new Error(`grep failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 200)}`); }
      const rows = out.split("\n").filter(Boolean);
      const kept = [];
      let bytes = 0;
      for (const r of rows) { const line = r.length > 400 ? `${r.slice(0, 400)}...` : r; bytes += line.length + 1; if (kept.length >= GREP_MAX_LINES || bytes > GREP_MAX_BYTES) break; kept.push(line); }
      return kept.join("\n") + (kept.length < rows.length ? `\n[${rows.length - kept.length} more matches not shown; narrow the pattern or path]` : "");
    },
  };
}

const sumUsage = (acc, u = {}) => {
  for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) acc[k] += n0(u?.[k]);
  return acc;
};
const textOf = (content) => (content ?? []).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");

/**
 * One role call as a Messages API tool loop. Stable prefix first (tools, then the system prompt with a cache
 * breakpoint), the role's prompt after it; top-level automatic caching moves a second breakpoint along the loop.
 * Adaptive thinking (no `thinking` param), explicit effort, no sampling params, streaming with finalMessage().
 * Returns the lean runner's result shape with `backend: "api"`; throws ApiRoleError on refusal, max_tokens or turn
 * exhaustion (with the usage spent so far), SDK errors pass through for classifyApiError.
 */
export async function runApiRole({ client, model, system, prompt, cwd, maxTurns = null, maxMs = null, handlers = null, now = () => Date.now() }) {
  const t0 = now();
  const h = handlers ?? makeReadOnlyHandlers(cwd);
  const turnsCap = Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : API_DEFAULT_MAX_TURNS;
  const deadline = t0 + (Number.isFinite(maxMs) && maxMs > 0 ? maxMs : API_DEFAULT_MAX_MS);
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const toolUses = [];
  const messages = [{ role: "user", content: prompt }];
  const fallbacks = FALLBACK_MODEL_RE.test(model) ? { betas: [FALLBACK_BETA], fallbacks: "default" } : {};
  let baselineTokens = null, endTokens = null, served = model, turns = 0;
  const fail = (reason, detail) => new ApiRoleError(reason, detail, { usage, model: served, turns, durationMs: now() - t0 });
  while (turns < turnsCap) {
    const left = deadline - now();
    if (left <= 0) throw fail("api_timeout", `no reply within ${Math.round((deadline - t0) / 1000)} s`);
    turns++;
    const msg = await client.beta.messages.stream({
      model, max_tokens: API_MAX_TOKENS,
      tools: READ_ONLY_TOOLS,
      system: [{ type: "text", text: [system, API_TOOLS_NOTE].filter(Boolean).join("\n\n"), cache_control: { type: "ephemeral" } }],
      messages,
      cache_control: { type: "ephemeral" },
      output_config: { effort: API_EFFORT },
      ...fallbacks,
    }, { timeout: left }).finalMessage();
    sumUsage(usage, msg?.usage);
    if (typeof msg?.model === "string" && msg.model) served = msg.model;
    const ctx = n0(msg?.usage?.input_tokens) + n0(msg?.usage?.cache_creation_input_tokens) + n0(msg?.usage?.cache_read_input_tokens);
    baselineTokens ??= ctx;
    endTokens = ctx;
    const stop = msg?.stop_reason;
    if (stop === "refusal") throw fail("refusal", msg?.stop_details?.category ?? "");
    if (stop === "max_tokens") throw fail("max_tokens", `reply cut at max_tokens ${API_MAX_TOKENS}`);
    messages.push({ role: "assistant", content: msg?.content ?? [] });
    if (stop === "pause_turn") continue;
    if (stop !== "tool_use") {
      const text = textOf(msg?.content);
      if (!text.trim()) throw fail("empty_reply", String(stop ?? ""));
      const durationMs = now() - t0;
      return { text, sessionId: null, usage, costUsd: apiCostUsd(usage, served), durationMs, turns, model: served, baselineTokens, endTokens,
        tools: toolStats(toolUses), toolUses, backend: "api" };
    }
    const results = [];
    for (const b of msg.content ?? []) {
      if (b?.type !== "tool_use") continue;
      let content, isError = false;
      try {
        const fn = Object.hasOwn(h, b.name) ? h[b.name] : null;
        if (!fn) throw new Error(`unknown tool: ${b.name}`);
        if (!b.input || typeof b.input !== "object" || Array.isArray(b.input)) throw new Error("invalid tool input");
        content = String(fn(b.input) ?? "");
        toolUses.push({ msg: msg.id ?? `t${turns}`, name: b.name === "read_file" ? "Read" : "Grep", path: b.name === "read_file" ? String(b.input.path ?? "") : null, cmd: null });
      } catch (e) { content = `Error: ${String(e?.message ?? e).slice(0, 500)}`; isError = true; }
      results.push({ type: "tool_result", tool_use_id: b.id, content, ...(isError ? { is_error: true } : {}) });
    }
    if (!results.length) throw fail("empty_reply", "tool_use without a tool call");
    messages.push({ role: "user", content: results });
  }
  throw fail("max_turns", `no final reply in ${turnsCap} turns`);
}

/** The SDK module (default export = client class, named typed errors) or null when the optional dependency is absent. */
async function loadSdk() {
  try { return await import("@anthropic-ai/sdk"); } catch { return null; }
}

/**
 * Wrap the lean CLI runner: a fresh read-only call of an API role goes to the Messages API when the backend setting
 * and credentials allow, else (and on any API failure) to `cliRunner` with the same args. A fallback result carries
 * `apiFallback: {role, reason, detail, ...spent}`, and any API tokens already spent are added to its usage and cost.
 */
export function withApiRoles(cliRunner, { mode = "cli", approved = true, roles = API_ROLES, env = process.env, sdkLoader = loadSdk, clientFactory = null, handlersFor = null, now = () => Date.now() } = {}) {
  if (mode === "cli") return cliRunner;
  let sticky = null; // a reason that holds for the rest of the process (no key, no SDK, auth or model rejected)
  let sdkP = null, client = null;
  const preflight = async () => {
    if (sticky) return sticky;
    if (!approved) return (sticky = { reason: "not_approved", detail: "engine.review_backend from forge.yaml needs FORGEDOCK_ALLOW_API_BACKEND=1 on the host" });
    if (isOpenCodeRuntime(env)) return (sticky = { reason: "opencode_runtime", detail: "" });
    const apiKey = String(env?.ANTHROPIC_API_KEY ?? "").trim();
    if (!apiKey) return (sticky = { reason: "no_api_key", detail: "ANTHROPIC_API_KEY is not set" });
    sdkP ??= Promise.resolve(sdkLoader());
    const sdk = await sdkP;
    if (!sdk?.default && !clientFactory) return (sticky = { reason: "no_sdk", detail: "@anthropic-ai/sdk is not installed" });
    client ??= clientFactory ? clientFactory({ apiKey, sdk }) : new sdk.default({ apiKey, maxRetries: 2 });
    return null;
  };
  return async (args) => {
    const eligible = roles.includes(args?.role) && !args?.resume && args?.readOnly === true && !args?.noTools;
    if (!eligible) return cliRunner(args);
    const model = String(args.model ?? "");
    let why = null, spent = null;
    if (!/^claude-[a-z0-9-]+$/.test(model)) why = { reason: "model_not_api_id", detail: `model "${model || "default"}" is not a full API model id` };
    else why = await preflight();
    if (!why) {
      try {
        return await runApiRole({ client, model, system: args.system ?? "", prompt: args.prompt ?? "", cwd: args.cwd, maxTurns: args.maxTurns ?? null, maxMs: args.maxMs || null,
          handlers: handlersFor ? handlersFor(args.cwd) : null, now });
      } catch (e) {
        const c = classifyApiError(e, (await sdkP) ?? {});
        if (c.sticky) sticky = { reason: c.reason, detail: c.detail };
        why = { reason: c.reason, detail: c.detail };
        if (e?.usage) spent = { usage: e.usage, cost_usd: apiCostUsd(e.usage, e.model ?? model), model: e.model ?? model, turns: e.turns ?? null };
      }
    }
    // auto: a missing credential just means the CLI path; only an explicit `api`, or a failed API call, is reported
    const silent = mode === "auto" && !spent && ["no_api_key", "no_sdk", "not_approved", "opencode_runtime", "model_not_api_id"].includes(why.reason);
    const r = await cliRunner(args);
    if (silent) return r;
    const out = { ...r, backend: "cli", apiFallback: { role: args.role, mode, reason: why.reason, ...(why.detail ? { detail: why.detail } : {}), ...(spent ?? {}) } };
    if (spent) {
      out.usage = sumUsage(sumUsage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, r?.usage ?? {}), spent.usage);
      if (Number.isFinite(r?.costUsd) && Number.isFinite(spent.cost_usd)) out.costUsd = Math.round((r.costUsd + spent.cost_usd) * 1e6) / 1e6;
    }
    return out;
  };
}
