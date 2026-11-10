// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Builder self-review (#4374): the builder answers the shared `REVIEW_RUBRIC` (prompts.mjs) in result.json
 * `self_review: [{question, answer, evidence}]` inside its build session. The engine only reads and logs it: a missing
 * self-review is SELF_REVIEW_MISSING, and the first reviewer judgement is compared with it (SELF_REVIEW_AGREED /
 * SELF_REVIEW_DISAGREED). Never a failure, never a runner call. Pure: no I/O.
 */

import { precheck, authorizationOf, applyAmendments } from "./conformance.mjs";
import { pathDomains, riskClassOf } from "./review-trigger.mjs";

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

// ---- #5345 clean-first-review: the reviewer's deterministic checks, run by the builder before it finishes ----
/** (selfReviewFindings, firstReviewRecord, sectionOfKind, FINDING_PITFALLS: precheck() subset + preserve-touch; the first-round record riding on RUN_TERMINAL) */
/** The contract section a finding kind traces to (measures which section of the plan first-round findings map to). */
export const KIND_SECTION = Object.freeze({
  "conformance.omission": "requirements",
  "conformance.unimplemented": "requirements",
  "conformance.untracked_deferral": "requirements",
  "conformance.unjustified_deferral": "requirements",
  "conformance.scope_creep": "deliverables",
  "conformance.preserve_violated": "preserve",
  "conformance.regression": "validate",
  "review.incomplete": "reviewer",
});
export const sectionOfKind = (code) => KIND_SECTION[code] ?? "other";

/** Builder pitfall per recurring finding kind (the three that are 80% of first-round findings). */
export const FINDING_PITFALLS = Object.freeze({
  "conformance.omission": "Map every issue requirement to the diff line that delivers it; omission is the top finding.",
  "conformance.scope_creep": "Edit only contract-listed files (tests aside); amend a needed extra file in first.",
  "conformance.preserve_violated": "Re-check each preserve path is unchanged; an edited one needs a covering deliverable.",
});

/** R5: the planner rule per contract section the first-round findings trace to (rendered into the plan prompt). */
export const PLANNER_TIGHTENING = Object.freeze({
  requirements: "One requirement per sentence or clause, each with a deliverable and a validate (omission is the top finding).",
  deliverables: "List every changed file, tests included (scope_creep flags unnamed ones).",
  preserve: "Give each preserve row a file path; it cannot be checked without one.",
});

const PATH_RE = /[\w@.-]+(?:\/[\w@.*-]+)+\.\w+|[\w@.-]+\/[\w@.*-]+\/?/g;
const NEEDS_RESULT = new Set(["requirement_unimplemented", "untracked_deferral"]);

/**
 * The deterministic conformance findings of the current tree: [{code, kind, detail, section}]. Validate commands are not
 * judged here (`forgedock check` runs them); requirement statuses are judged only when the builder reported any.
 */
export function selfReviewFindings({ contract: frozen, result = null, changedFiles = [], ignore = [".forge-lean/"], hotspots = null }) {
  if (!frozen || typeof frozen !== "object") return [];
  // the builder's typed amendments (add-deliverable, ...) are part of the contract the gate judges; problems are the engine's to report
  const contract = Array.isArray(result?.amendments) && result.amendments.length ? applyAmendments(frozen, result.amendments).contract : frozen;
  const reported = Array.isArray(result?.requirements);
  const pc = precheck({ contract: { ...contract, validate: [] }, result: reported ? result : null, changedFiles, ignore, hotspots, ciVerified: true });
  // no result.json yet: the builder cannot have amended an extra file in, so scope_creep is not judged until one exists
  const out = pc.failures.filter((f) => (reported || !NEEDS_RESULT.has(f.kind)) && (result || f.code !== "conformance.scope_creep")).map((f) => ({ code: f.code, kind: f.kind ?? null, detail: f.detail, section: sectionOfKind(f.code) }));
  out.push(...preserveTouched(contract, changedFiles, ignore));
  return out;
}

/** A preserve item names a path the diff changed that no deliverable authorizes: the touch can only be a violation. */
export function preserveTouched(contract, changedFiles = [], ignore = []) {
  const out = [];
  for (const p of contract?.preserve ?? []) {
    const named = [...String(p?.what ?? "").matchAll(PATH_RE)].map((m) => m[0].replace(/[.,;:)]+$/, ""));
    for (const f of changedFiles) {
      if (ignore.some((x) => f.startsWith(x)) || authorizationOf(contract, f)) continue;
      if (named.some((n) => n === f || (n.endsWith("/") && f.startsWith(n)))) out.push({ code: "conformance.preserve_violated", kind: "preserve_touched", detail: `${p.id}: ${f} is preserved and no deliverable authorizes changing it`, section: "preserve" });
    }
  }
  return out;
}

/** The change type of a lane from its issue labels: bug|feature|chore|docs|other. */
export function changeTypeOf(labels = []) {
  const names = (Array.isArray(labels) ? labels : []).map((l) => String(l?.name ?? l).toLowerCase());
  for (const t of ["bug", "feature", "chore", "docs"]) if (names.some((n) => n === t || n === `type:${t}`)) return t;
  return "other";
}

/** `domain:<d>` / `risk:<class>` surfaces a lane's files touch (the same names `stats --conformance-outcomes` uses). */
export function surfacesOf(files = []) {
  const domains = pathDomains(files) ?? [];
  return [...new Set([...domains.map((d) => `domain:${d}`), ...files.map(riskClassOf).filter(Boolean).map((c) => `risk:${c}`)])].sort();
}

/**
 * The first-round record riding on RUN_TERMINAL: the first gate judgement (`rounds[0]`: {state, failures: [code]}), its
 * failure kinds, how many gate rounds the lane took, and whether the reviewer's own first reply (`firstReply`, a decide()
 * state) was incomplete. null when no review ran.
 */
export function firstReviewRecord({ rounds = [], firstReply = null, labels = [], files = [] } = {}) {
  if (!rounds.length) return null;
  const first = rounds[0];
  const kinds = [...new Set((first.failures ?? []).filter(Boolean))].sort();
  return { state: first.state, kinds, rounds: rounds.length, clean: first.state === "conforms", incomplete: firstReply === "review.incomplete" || first.state === "review.incomplete", type: changeTypeOf(labels), surfaces: surfacesOf(files) };
}

/** The failures a builder's own red `forgedock check` record holds (the review section), as resume failures; [] when none. */
export function selfCheckFailures(record) {
  return (Array.isArray(record?.review) ? record.review : []).filter((f) => f?.code && f?.detail).map((f) => ({ code: f.code, detail: String(f.detail) }));
}
