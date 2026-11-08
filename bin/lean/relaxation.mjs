// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Relaxation gate (#5237). A change that relaxes a detector, validator, gate or classifier inside a declared
 * `review.risk_paths` glob (a new accept/rescue/allow branch, a removed deny) is reviewed adversarially: it needs at least
 * one added negative test per relaxed file (`conformance.unimplemented`, kind `relaxation_untested`), the reviewer and the
 * independent verifier get the relaxed hunks with a counterexample brief. Deterministic, 0 LLM calls for the detection.
 * The match is syntactic: the verifier covers what a pattern cannot.
 */
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { riskPathHits } from "./review-trigger.mjs";

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|e2e)\/|\.(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]*$|_test\.[a-z0-9]+$|(^|\/)conftest\.py$/i;
const COMMENT = /^\s*(#|\/\/|\*|\/\*|--)/;
const ACCEPT_RETURN = /\b(?:return|=>)\s*\(?\s*(?:true|True|ok|allow(?:ed)?|accept(?:ed)?|benign|valid|pass(?:ed)?)\b/;
const ACCEPT_NAME = /\b\w*(?:rescue|allowlist|whitelist|safelist|benign|exempt|bypass|allow|accept)\w*\b/i;
const DENY = /\b(?:raise|throw)\b|\breturn\s+(?:false|False|deny|denied|block|blocked|reject|rejected)\b|\b(?:deny|reject|blocked)\w*\s*[=(]/;
const NEGATIVE = /assertFalse|assert\s+not\b|assert_not|\.not\.|toBe\(false\)|toBeFalsy|toThrow|rejects|pytest\.raises|assert_raises|assert\.(?:throws|rejects|ok\(!|equal\(.*,\s*false\))|\b(?:must|should)(?:\s+still)?\s+(?:be\s+)?(?:detect|block|reject|deny|refuse|fail)|not[ _](?:accept|allow|benign|rescue)|negative|counterexample|still[ _](?:detected|blocked|rejected)/i;

export const isRelaxationTestPath = (p) => TEST_PATH.test(String(p));

/** Per-file added/removed lines of a unified diff: [{file, added: [{line, text}], removed: [text]}]. */
function parseDiff(diff) {
  const out = [];
  let cur = null, n = 0;
  for (const l of String(diff ?? "").split("\n")) {
    const f = /^diff --git a\/.* b\/(.*)$/.exec(l);
    if (f) { cur = { file: f[1], added: [], removed: [] }; out.push(cur); continue; }
    if (!cur) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { n = Number(h[1]); continue; }
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) cur.added.push({ line: n++, text: l.slice(1) });
    else if (l.startsWith("-")) cur.removed.push(l.slice(1));
  }
  return out;
}

const excerpt = (t) => String(t).trim().replace(/\s+/g, " ").slice(0, 160);

/**
 * `{relaxations: [{file, line, class, excerpt}], negatives}` for a `git diff -U0 base...HEAD`. Only non-test files matching a
 * declared review.risk_paths glob count; `negatives` is the number of negative assertions added in changed test files.
 */
export function analyzeRelaxations({ diff = "", riskPaths = [] } = {}) {
  const files = parseDiff(diff);
  const risky = new Set(riskPathHits(files.map((f) => f.file).filter((f) => !isRelaxationTestPath(f)), riskPaths));
  const relaxations = [];
  let negatives = 0;
  for (const f of files) {
    if (isRelaxationTestPath(f.file)) { negatives += f.added.filter((a) => NEGATIVE.test(a.text)).length; continue; }
    if (!risky.has(f.file)) continue;
    const code = f.added.filter((a) => !COMMENT.test(a.text));
    for (const a of code) if (ACCEPT_RETURN.test(a.text) || ACCEPT_NAME.test(a.text)) relaxations.push({ file: f.file, line: a.line, class: "accept", excerpt: excerpt(a.text) });
    const removedDeny = f.removed.filter((t) => !COMMENT.test(t) && DENY.test(t));
    if (removedDeny.length > code.filter((a) => DENY.test(a.text)).length) relaxations.push({ file: f.file, line: code[0]?.line ?? 1, class: "deny_removed", excerpt: excerpt(removedDeny[0]) });
  }
  return { relaxations, negatives };
}

/** One blocking failure when the diff has fewer added negative assertions than relaxed files; [] otherwise. */
export function relaxationFailures({ relaxations = [], negatives = 0 } = {}) {
  const files = [...new Set(relaxations.map((r) => r.file))];
  if (!files.length || negatives >= files.length) return [];
  return [{ code: OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED, kind: "relaxation_untested", detail: `${files.slice(0, 3).join(", ")} relax${files.length === 1 ? "es" : ""} a rule in a declared review.risk_paths path (${relaxations.slice(0, 2).map((r) => `${r.file}:${r.line} ${r.class}`).join("; ")}) but the diff adds ${negatives} negative test(s) for ${files.length} relaxed file(s): add a test that the inputs the relaxed rule must still reject are rejected` }];
}

/** The <relaxation_checks> block for the reviewer and the verifier prompts; "" when nothing was relaxed. */
export function relaxationBlock(relaxations = []) {
  if (!relaxations.length) return "";
  const rows = relaxations.slice(0, 20).map((r) => `- ${r.file}:${r.line} (${r.class}): ${r.excerpt}`).join("\n");
  return `\n<relaxation_checks>\nThis diff relaxes a rule in a declared risk path (a new accept/rescue/allow branch or a removed deny):\n${rows}\nPositive cases passing is not evidence. For each relaxation: (1) name the inputs the relaxed rule now accepts that it must not (for a detector: the project's challenge, block or negative-corpus pages and fixtures), (2) trace or run them through the changed code, (3) check a negative test exists for the new accept class. Report each accepted counterexample and each missing negative test as a regressions row with path:line (it blocks the merge).\n</relaxation_checks>`;
}
