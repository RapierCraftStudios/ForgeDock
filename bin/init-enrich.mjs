/**
 * init-enrich.mjs — enrichment backend selection ladder for ForgeDock init
 * (issue #2004).
 *
 * `forgedock init`'s AI enrichment step has two interchangeable backends,
 * both implementing the same enrich(ConfigDraft) contract:
 *   - cli: bin/init-enrich-cli.mjs — local Claude Code CLI, no API key needed.
 *   - api: bin/init-enrich-api.mjs — Anthropic Messages API, needs ANTHROPIC_API_KEY.
 *
 * Selection ladder (mirrors the "auto" ladder bin/runner.mjs established for
 * the `forgedock run` engine backend in issue #2003, applied here to the
 * separate init-enrichment call site):
 *   1. `claude` CLI present and responding → cli backend. Reuses whatever
 *      the CLI is already authenticated with (Pro/Max OAuth or a
 *      CLI-managed key) — no ANTHROPIC_API_KEY required.
 *   2. ANTHROPIC_API_KEY set → api backend (existing, unchanged behavior).
 *   3. Neither → "none". Caller (bin/journey.mjs) skips enrichment and
 *      prints an explanatory message; the deterministic detection baseline
 *      is used unchanged.
 *
 * This is a separate module from bin/runner.mjs's own ladder rather than a
 * shared abstraction: the two invocation shapes differ (a multi-turn agent
 * tool-use loop for `forgedock run` vs. a one-shot `--print` enrichment
 * prompt here), so full extraction is deferred (see issue #2004's Notes).
 * The CLI-presence probe itself (isClaudeCliAvailable) IS reused directly
 * from bin/runner.mjs with zero duplication.
 *
 * Override (issue #2023): the ladder above changed the *default* precedence
 * from "API-key-only" to "CLI-first" (#2004). Existing users who have both
 * ANTHROPIC_API_KEY set and a `claude` CLI on PATH get silently moved onto
 * the cli backend with no way to opt back into the old, explicit api-key
 * behavior. `FORGEDOCK_INIT_BACKEND` (values: "cli"|"api"|"none"|"auto")
 * gives them that escape hatch, mirroring bin/runner.mjs's FORGEDOCK_BACKEND
 * override for the `forgedock run` engine ladder (#2003). Unset, empty, or
 * "auto" — including any unrecognized value — falls through to the ladder
 * unchanged, so the #2004 default behavior is byte-for-byte preserved for
 * anyone who doesn't set the var.
 */

import { isClaudeCliAvailable } from "./runner.mjs";
import { enrich as enrichViaApi } from "./init-enrich-api.mjs";
import { enrich as enrichViaCli } from "./init-enrich-cli.mjs";

/** Valid explicit values for FORGEDOCK_INIT_BACKEND (excluding "auto", which
 * is the no-override default and falls through to the ladder below). */
const VALID_INIT_BACKEND_OVERRIDES = new Set(["cli", "api", "none"]);

/**
 * Resolve which enrichment backend should be used.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Working directory for the CLI probe. Defaults
 *   to process.cwd().
 * @param {object} [opts.env] - Environment to read ANTHROPIC_API_KEY and
 *   FORGEDOCK_INIT_BACKEND from. Defaults to process.env. Injectable so
 *   callers (bin/journey.mjs) can pass ctx.env for testability.
 * @param {Function} [opts.isCliAvailableFn] - Injectable replacement for
 *   isClaudeCliAvailable. Test seam — lets tests deterministically simulate
 *   CLI presence/absence without depending on whether the CI host happens
 *   to have `claude` on PATH.
 * @returns {"cli"|"api"|"none"}
 */
export function resolveEnrichBackend({
  cwd = process.cwd(),
  env = process.env,
  isCliAvailableFn = isClaudeCliAvailable,
} = {}) {
  // Explicit override (#2023) — takes precedence over the auto ladder.
  // "auto" and any unrecognized value intentionally fall through unchanged,
  // never throw: this preserves the "graceful fallback, never crash init"
  // discipline the rest of this module follows.
  const override = env.FORGEDOCK_INIT_BACKEND;
  if (override && VALID_INIT_BACKEND_OVERRIDES.has(override)) return override;

  if (isCliAvailableFn(cwd)) return "cli";
  if (env.ANTHROPIC_API_KEY) return "api";
  return "none";
}

/**
 * Enrich a ConfigDraft using whichever backend is available, per the
 * selection ladder in resolveEnrichBackend(). Both backends implement the
 * same contract and the same graceful-fallback-never-throws discipline, so
 * this dispatcher inherits that guarantee: it always resolves to a draft
 * (enriched or original), never rejects.
 *
 * @param {object} draft - ConfigDraft from detectConfig()
 * @param {object} [opts]
 * @param {"cli"|"api"|"none"} [opts.backend] - Pre-resolved backend, to
 *   avoid a redundant CLI probe when the caller already called
 *   resolveEnrichBackend() for a UI gate/message decision. If omitted,
 *   resolved internally.
 * @param {string} [opts.cwd] - Working directory (forwarded to whichever
 *   backend is selected; only meaningful for the cli backend).
 * @param {object} [opts.env] - Environment. Used to resolve the backend when
 *   opts.backend is omitted, AND forwarded to the api backend
 *   (enrichViaApi) so it can read ANTHROPIC_API_KEY from the injected value
 *   instead of the real process.env — the test seam bin/journey.mjs relies
 *   on when passing ctx.env.
 * @param {Function} [opts.isCliAvailableFn] - See resolveEnrichBackend().
 * @returns {Promise<object>} Enriched ConfigDraft, or the original draft
 *   when no backend is available or the selected backend fails.
 */
export async function enrich(draft, opts = {}) {
  const { cwd = process.cwd(), env = process.env, isCliAvailableFn, bin, spawnFn, timeoutMs } = opts;
  const backend =
    opts.backend ?? resolveEnrichBackend({ cwd, env, isCliAvailableFn });

  if (backend === "cli") {
    // bin/spawnFn/timeoutMs are test seams — forwarded when present so
    // callers (and this module's own tests) can exercise the cli backend
    // deterministically without depending on a real `claude` install.
    const cliOpts = { cwd };
    if (bin !== undefined) cliOpts.bin = bin;
    if (spawnFn !== undefined) cliOpts.spawnFn = spawnFn;
    if (timeoutMs !== undefined) cliOpts.timeoutMs = timeoutMs;
    return enrichViaCli(draft, cliOpts);
  }
  if (backend === "api") return enrichViaApi(draft, { env });
  return draft;
}
