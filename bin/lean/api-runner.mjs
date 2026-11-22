// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5821: a direct Messages API runner for one-shot roles (reviewer, verifier, grouper).
 *
 * A CLI session writes a ~37k-token system/tool baseline to the prompt cache on every fresh spawn; these roles need
 * one to three turns on a prompt that already embeds the diff. This runner sends that prompt as one Messages API call
 * whose system block and shared prefix (rubric, contract, diff) carry cache_control.
 *
 * Why this differs from the earlier attempts: #5347 batched CLI calls and moved no role off the CLI; #2385/#2413 put
 * API caching into the older bin/runner.mjs engine path and was reverted (reason not recorded). Here the lean engine has
 * a single runner seam (effects.mjs makeLeanRunner), the diff is already embedded and bounded (REVIEW_DIFF_MAX_BYTES),
 * the CLI stays the fallback (lean.api_fallback), the route is off unless lean.api_roles names a role, and the builder
 * session stays on the CLI.
 */

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const API_DEFAULT_MODEL = "claude-sonnet-5-5";
export const API_MAX_TOKENS = 8192;
export const API_DEFAULT_TIMEOUT_MS = 300_000;

/** USD per million tokens {input, output}; cache write is 1.25x input and cache read 0.1x input. Unknown models price as sonnet. */
const PRICES = { opus: { in: 15, out: 75 }, sonnet: { in: 3, out: 15 }, haiku: { in: 1, out: 5 }, fable: { in: 15, out: 75 } };
const priceOf = (model) => PRICES[Object.keys(PRICES).find((k) => String(model ?? "").includes(k))] ?? PRICES.sonnet;

/** Cost in USD of one response's usage block. */
export function apiCostUsd(usage, model) {
  const p = priceOf(model), u = usage ?? {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return (n(u.input_tokens) * p.in + n(u.output_tokens) * p.out + n(u.cache_creation_input_tokens) * p.in * 1.25 + n(u.cache_read_input_tokens) * p.in * 0.1) / 1e6;
}

/** Typed failure: `kind` is auth | rate_limit | timeout | transport | http | empty; `status` is the HTTP status when there was one. */
export class ApiRunnerError extends Error {
  constructor(kind, message, status = null) { super(message); this.name = "ApiRunnerError"; this.kind = kind; this.status = status; }
}

/** The request body: system and the shared prefix are cache breakpoints, the variable tail is not. */
export function buildApiRequest({ model, system, prefix, tail = "", maxTokens = API_MAX_TOKENS }) {
  const content = [{ type: "text", text: String(prefix ?? ""), cache_control: { type: "ephemeral" } }];
  if (String(tail ?? "")) content.push({ type: "text", text: String(tail) });
  return { model, max_tokens: maxTokens, ...(system ? { system: [{ type: "text", text: String(system), cache_control: { type: "ephemeral" } }] } : {}), messages: [{ role: "user", content }] };
}

/** True when an API key is available to the runner. */
export const apiKeyPresent = (env = process.env) => Boolean(String(env?.ANTHROPIC_API_KEY ?? "").trim());

/**
 * One Messages API call. Returns the lean runner result shape; throws ApiRunnerError.
 * `fetchImpl`, `env` and `now` are the I/O boundaries (network, environment, clock).
 */
export async function runApiCall({ model = null, system = "", prefix, tail = "", maxMs = 0, maxTokens, fetchImpl = globalThis.fetch, env = process.env, now = () => Date.now() }) {
  const key = String(env?.ANTHROPIC_API_KEY ?? "").trim();
  if (!key) throw new ApiRunnerError("auth", "ANTHROPIC_API_KEY is not set");
  const m = !model || model === "default" ? API_DEFAULT_MODEL : model;
  const url = `${String(env?.ANTHROPIC_BASE_URL ?? "").replace(/\/+$/, "") || "https://api.anthropic.com"}/v1/messages`;
  const t0 = now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), maxMs > 0 ? maxMs : API_DEFAULT_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(buildApiRequest({ model: m, system, prefix, tail, maxTokens })) });
  } catch (e) {
    throw new ApiRunnerError(ctl.signal.aborted ? "timeout" : "transport", `Messages API ${ctl.signal.aborted ? "timed out" : "request failed"}: ${String(e?.message ?? e).slice(0, 200)}`);
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const kind = res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate_limit" : "http";
    throw new ApiRunnerError(kind, `Messages API returned ${res.status}`, res.status);
  }
  const data = await res.json();
  const text = (Array.isArray(data?.content) ? data.content : []).filter((b) => b?.type === "text").map((b) => b.text).join("");
  if (!text.trim()) throw new ApiRunnerError("empty", "Messages API returned no text");
  const u = data.usage ?? {};
  const usage = { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0 };
  const used = data.model ?? m;
  return { text, sessionId: null, usage, costUsd: apiCostUsd(usage, used), durationMs: now() - t0, turns: 1, model: used,
    baselineTokens: usage.cache_creation_input_tokens + usage.cache_read_input_tokens + usage.input_tokens, tools: null, endTokens: null, toolUses: null, route: "api" };
}
