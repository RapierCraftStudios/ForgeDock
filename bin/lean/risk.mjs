// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Lean path (#4081): deterministic path/keyword helpers. Pure, codebase-agnostic, no model calls. */

const RISK_PATH = /(^|[/._-])(auth|authn|authz|oauth|login|session|crypto|cipher|secret|secrets|credential|credentials|token|permission|permissions|acl|rbac|migration|migrations|payment|payments|billing|stripe)([/._-]|$)|^\.github\/workflows\//i;
const RISK_KEYWORD = /\b(auth\w*|crypto\w*|secret\w*|permission\w*|migration\w*|payment\w*)\b/i;

/** @returns {{tier:"high"|"low", reasons:string[]}} */
export function riskTier(files = [], text = "") {
  const reasons = [];
  for (const f of files) if (RISK_PATH.test(f)) reasons.push(`path:${f}`);
  const kw = RISK_KEYWORD.exec(String(text));
  if (kw) reasons.push(`keyword:${kw[1].toLowerCase()}`);
  return { tier: reasons.length ? "high" : "low", reasons };
}

const DOC_FILE = /(\.(md|mdx|rst|txt|adoc)$)|(^|\/)(docs?|documentation)\//i;
export const isDocsOnly = (files) => files.length > 0 && files.every((f) => DOC_FILE.test(f));

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|\.(test|spec)\.[a-z0-9]+$|_(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.[a-z0-9]+$|Tests?\.(java|kt|cs|swift|scala)$/i;
export const isTestFile = (f) => TEST_FILE.test(f);

export const LARGE_DIFF = { files: 15, lines: 400 };
export const isLargeDiff = ({ files = 0, lines = 0 } = {}) => files >= LARGE_DIFF.files || lines >= LARGE_DIFF.lines;

/** `auto` goes full only when risk is high AND the diff is large; lean otherwise. */
export function choosePath(requested, risk, stats) {
  if (requested === "lean" || requested === "full") return requested;
  return risk?.tier === "high" && isLargeDiff(stats) ? "full" : "lean";
}

/** Blocking = CRITICAL/HIGH, or CONFIRMED MEDIUM in introduced code. */
export function isBlocking(f) {
  const sev = String(f?.severity ?? "").toUpperCase();
  if (sev === "CRITICAL" || sev === "HIGH") return true;
  return sev === "MEDIUM" && String(f?.confidence ?? "").toUpperCase() === "CONFIRMED"
    && String(f?.scope ?? "introduced").toLowerCase() === "introduced";
}

/** Extract the findings array from a reviewer reply (last json fence, else first [...]). null when unparseable. */
export function parseFindings(text) {
  const s = String(text ?? "");
  const fences = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const cands = [...fences.reverse(), s.slice(s.indexOf("["), s.lastIndexOf("]") + 1)];
  for (const c of cands) {
    try { const v = JSON.parse(c.trim()); if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object"); } catch { /* next */ }
  }
  return null;
}
