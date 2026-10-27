// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Transient-failure retry for the core work-on's network writes (git push, gh writes, gh pr merge). */

export const PUSH_TRANSIENT_RE = /remote unpack failed|index-pack failed|RPC failed|unexpected disconnect|early EOF|the remote end hung up|HTTP\/?\s?5\d\d|returned error: 5\d\d|\b50[0234]\b|internal server error|bad gateway|service unavailable|gateway time-?out|connection (?:reset|timed out|refused)|timed out|could not resolve host|broken pipe|ETIMEDOUT|ECONNRESET|temporarily unavailable|\[remote rejected\][^\n]*\(failed\)|unable to write file|unable to create temporary object|unpacker error|failed to write object/i;
export const PUSH_PERMANENT_RE = /protected branch|GH006|GH013|repository rule violations|permission (?:denied|to .* denied)|denied to|\b403\b|authentication failed|not allowed|hook declined|pre-receive hook declined|\[rejected\]|non-fast-forward|fetch first/i;
export const GH_TRANSIENT_RE = /HTTP 5\d\d|\b50[0234]\b|secondary rate limit|rate limit exceeded|abuse detection|something went wrong|internal server error|bad gateway|service unavailable|ETIMEDOUT|ECONNRESET|connection reset|timed out|\bEOF\b|temporarily unavailable/i;
/** #4507: gh failing to parse its own input: a torn HTTP cache entry (JSON) or a half-written config (YAML). */
export const GH_PARSE_RE = /invalid character .{0,40}looking for|unexpected end of JSON input|cannot unmarshal|yaml: line \d+|yaml: unmarshal/i;
export const MERGE_TRANSIENT_RE = new RegExp(`${GH_TRANSIENT_RE.source}|${GH_PARSE_RE.source}|base branch was modified|head branch was modified|mergeability.*unknown|try again`, "i");
export const MERGE_CONFLICT_RE = /not mergeable|merge conflict|conflict/i;

export const errText = (e) => `${e?.stderr ?? ""}\n${e?.message ?? ""}\n${e?.stdout ?? ""}`;

/**
 * Run `fn` up to `attempts` times. A `permanent` match throws immediately with `e.permanent = true`; a `transient`
 * match retries with exponential backoff; anything else throws as-is. When every attempt failed transiently the last
 * error carries `transientExhausted = true`.
 */
export async function retrying(fn, { transient, permanent = null, attempts = 4, sleep, baseMs = 1000, random = Math.random }) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(i); } catch (e) {
      const t = errText(e);
      if (permanent && permanent.test(t)) { e.permanent = true; throw e; }
      if (!transient.test(t)) throw e;
      last = e;
      if (i < attempts - 1) await sleep(baseMs * 2 ** i + Math.floor(random() * 250));
    }
  }
  last.transientExhausted = true;
  throw last;
}

/**
 * #4507: run `call(env)` with the lane's gh cache env; on a gh parse error (corrupt cache) reset the cache and run it
 * once more. Without a cache it still retries once. Any other error is rethrown unchanged.
 */
export async function ghCacheRetry(call, cache) {
  try { return await call(cache?.env?.()); } catch (e) {
    if (!GH_PARSE_RE.test(errText(e))) throw e;
    try { await cache?.reset?.(); } catch { /* retry on the old dir */ }
    return await call(cache?.env?.());
  }
}

/** #4662: an expired or revoked token (HTTP 401). 403 is a missing scope or a rate limit, which a refresh does not fix. */
export const GH_AUTH_RE = /HTTP 401|\b401\b[^\n]{0,40}(?:unauthorized|bad credentials)|bad credentials|requires authentication|authentication required|gh auth login|try authenticating/i;
export const GH_AUTH_RETRY_SECONDS = 120;

/** Runs scripts/refresh-bot-token.sh (or $FORGE_REFRESH_TOKEN_SCRIPT); resolves on exit 0, rejects otherwise. */
export async function runRefreshScript(env = process.env) {
  const { execFile } = await import("node:child_process");
  const script = env.FORGE_REFRESH_TOKEN_SCRIPT || new URL("../../scripts/refresh-bot-token.sh", import.meta.url).pathname;
  return new Promise((res, rej) => execFile("bash", [script], { env, timeout: 60000 }, (err, _out, stderr) => (err ? rej(Object.assign(err, { stderr })) : res())));
}

/**
 * #4662: one refresh-and-retry for an auth failure. `refresh` runs once per `state` (shared across calls, so a dead token
 * does not spawn a refresh per gh call); when the call still fails with an auth error the error carries
 * `deferCode: "gh.auth"` so the lane ends `deferred` (requeued in `retryInSeconds`), never `engine-error`.
 */
export async function refreshAuthOnce(call, { refresh, state = { refreshed: false } }) {
  try { return await call(); } catch (e) {
    if (!GH_AUTH_RE.test(errText(e))) throw e;
    if (!state.refreshed) {
      state.refreshed = true;
      try { await refresh(); state.ok = true; } catch { state.ok = false; }
      if (state.ok) { try { const r = await call(); state.refreshed = false; return r; } catch (e2) { if (!GH_AUTH_RE.test(errText(e2))) throw e2; e = e2; } }
    }
    throw Object.assign(e, { deferCode: "gh.auth", deferDetail: `gh auth failed (HTTP 401) after a token refresh: ${errText(e).trim().split("\n")[0].slice(0, 200)}`, retryInSeconds: GH_AUTH_RETRY_SECONDS });
  }
}
