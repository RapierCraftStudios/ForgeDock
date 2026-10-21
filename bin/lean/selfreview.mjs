// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Builder self-review (#4374): the builder answers the shared `REVIEW_RUBRIC` (prompts.mjs) in result.json
 * `self_review: [{question, answer, evidence}]` inside its build session. The engine only reads and logs it: a missing
 * self-review is SELF_REVIEW_MISSING, and the first reviewer judgement is compared with it (SELF_REVIEW_AGREED /
 * SELF_REVIEW_DISAGREED). Never a failure, never a runner call. Pure: no I/O.
 */

const text = (v) => (v === null || v === undefined ? "" : String(v)).trim();

/**
 * The self-review of a result: `present` with its items and the questions not answered yes, `missing` when a fixed result
 * has no non-empty `self_review` array, `invalid` when an entry lacks a question or an answer, or null for a result
 * that is not `fixed` (nothing to self-review).
 */
export function readSelfReview(result) {
  if (!result || typeof result !== "object" || result.status !== "fixed") return null;
  const raw = result.self_review;
  if (!Array.isArray(raw) || !raw.length) return { state: "missing", items: [], no: [] };
  const items = raw.map((x) => ({ question: text(x?.question), answer: text(x?.answer), evidence: text(x?.evidence) }));
  if (items.some((x) => !x.question || !x.answer)) return { state: "invalid", items, no: [] };
  return { state: "present", items, no: items.filter((x) => x.answer.toLowerCase() !== "yes").map((x) => x.question) };
}

/**
 * Compare a present self-review with a reviewer decision (`decide()` state). Null when either side has no judgement
 * (self-review not present, reviewer reply incomplete, unparseable or skipped). Agreement: all yes and the reviewer
 * conforms, or any no and the reviewer finds it nonconforming.
 */
export function compareSelfReview(self, decision) {
  if (self?.state !== "present") return null;
  const reviewer = decision?.state;
  if (reviewer !== "conforms" && reviewer !== "nonconforming") return null;
  const allYes = self.no.length === 0;
  return { agreed: allYes === (reviewer === "conforms"), reviewer, self_no: self.no };
}
