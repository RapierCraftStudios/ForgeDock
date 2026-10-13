// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Transient-failure retry for the core work-on's network writes (git push, gh writes, gh pr merge). */

export const PUSH_TRANSIENT_RE = /remote unpack failed|index-pack failed|RPC failed|unexpected disconnect|early EOF|the remote end hung up|HTTP\/?\s?5\d\d|returned error: 5\d\d|\b50[0234]\b|internal server error|bad gateway|service unavailable|gateway time-?out|connection (?:reset|timed out|refused)|timed out|could not resolve host|broken pipe|ETIMEDOUT|ECONNRESET|temporarily unavailable/i;
export const PUSH_PERMANENT_RE = /protected branch|GH006|GH013|repository rule violations|permission (?:denied|to .* denied)|denied to|\b403\b|authentication failed|not allowed|hook declined|pre-receive hook declined|\[remote rejected\]|\[rejected\]|non-fast-forward|fetch first/i;
export const GH_TRANSIENT_RE = /HTTP 5\d\d|\b50[0234]\b|secondary rate limit|rate limit exceeded|abuse detection|something went wrong|internal server error|bad gateway|service unavailable|ETIMEDOUT|ECONNRESET|connection reset|timed out|\bEOF\b|temporarily unavailable/i;
export const MERGE_TRANSIENT_RE = new RegExp(`${GH_TRANSIENT_RE.source}|base branch was modified|head branch was modified|mergeability.*unknown|try again`, "i");
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
