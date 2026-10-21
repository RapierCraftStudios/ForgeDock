// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fresh fix sessions (#4363): which fix rounds run in a new, narrow session (resume: null, lean.fix_model) instead of
 * resuming the builder's whole plan+build transcript, and the caps of that session's prompt. Pure: no I/O.
 * Repo-agnostic: a failure "cites a file:line" when its text names any `path.ext:N`, whatever the language.
 */

/** Fix-round kinds whose failures are mechanical: always a fresh session. */
export const MECHANICAL_KINDS = Object.freeze(["precheck", "ci", "docs", "structure", "enumerating", "sequence"]);

/** The fresh prompt stays under this many characters; the per-part caps leave room for the fixed text. */
export const FIX_PROMPT_MAX = 60000;
export const FIX_CAPS = Object.freeze({ task: 20000, diff: 24000, contract: 8000, summary: 1500 });

const FILE_LINE_RE = /[\w.@/-]+\.[A-Za-z0-9]+:\d+/;

/** True only for a non-empty list whose every failure (a string, or `f.detail`) cites a `path.ext:N`. */
export function citesFileLine(failures) {
  if (!Array.isArray(failures) || !failures.length) return false;
  return failures.every((f) => FILE_LINE_RE.test(typeof f === "string" ? f : String(f?.detail ?? "")));
}

/** A mechanical kind, or a conformance/review FAIL whose failures all cite a file:line. */
export function freshFix(kind, failures = []) {
  if (MECHANICAL_KINDS.includes(kind)) return true;
  return (kind === "conformance" || kind === "review") && citesFileLine(failures);
}

/** `s` cut to `max` characters with a marker naming what was dropped. */
export function capText(s, max) {
  const t = String(s ?? "");
  return t.length <= max ? t : `${t.slice(0, max)}\n[... ${t.length - max} more characters cut]`;
}

/** The issue body without HTML comments (FORGE:STATE and other markers), trimmed and capped. */
export function issueSummary(body, max = FIX_CAPS.summary) {
  const t = String(body ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return capText(t, max);
}
