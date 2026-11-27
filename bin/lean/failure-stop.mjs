// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5979: identical-failure stop. A lane that ends needs-human with the same (code, normalised detail) as an earlier NEEDS_HUMAN
 * or PARKED comment of the issue is parked with one consolidated comment instead of being recovered or relaunched. Pure.
 */
import { createHash } from "node:crypto";

export const SIG_RE = /\bsig=([0-9a-f]{12})\b/;
const MARKER_RE = /<!--\s*FORGE:(NEEDS_HUMAN|PARKED)(?![A-Za-z0-9_])/;

/** Detail without what differs between two runs of the same failure: shas, timestamps, numbers (costs, counts, ids), whitespace. */
export function normalizeDetail(detail) {
  return String(detail ?? "")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "")
    .replace(/\b[0-9a-f]{7,40}\b/g, "")
    .replace(/\$\d+(\.\d+)?/g, "")
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 12 hex characters of sha256(code + normalised detail): a repeat fingerprint, not a security hash (sha256 keeps CodeQL js/weak-cryptographic-algorithm quiet). */
export function repeatSignature(code, detail) {
  return createHash("sha256").update(`${code ?? ""}\n${normalizeDetail(detail)}`).digest("hex").slice(0, 12);
}

const DECISION_RE = /<!--\s*FORGE:DECISION(?![A-Za-z0-9_])/;
const PREMISE_DECISION_RE = /^\s*(?:<!--[^>]*-->\s*)?##\s*Decision:\s*no needs-human/i;

/** #6122: a trusted operator/builder FORGE:DECISION (not the engine's own "no needs-human" premise note) is new input for the lane. */
export const isResetDecision = (body) => DECISION_RE.test(String(body ?? "")) && !PREMISE_DECISION_RE.test(String(body ?? "").replace(DECISION_RE, "").replace(/^\s*(?:-->)?/, ""));

/**
 * Earlier trusted NEEDS_HUMAN/PARKED comments carrying `sig=<hash>`. A PARKED summary counts as the failure it parked on.
 * #6122: comments are chronological; a trusted FORGE:DECISION newer than a park resets the count (the decision is applied on the
 * next run, so the repeat is no longer "the same input"), only failures after the last decision count.
 */
export function countIdentical(comments, sig, trusted = () => true) {
  let n = 0;
  for (const c of Array.isArray(comments) ? comments : []) {
    const body = String(c?.body ?? "");
    if (isResetDecision(body) && trusted(c)) { n = 0; continue; }
    if (MARKER_RE.test(body) && SIG_RE.exec(body)?.[1] === sig && trusted(c)) n++;
  }
  return n;
}

/** True from the 2nd identical failure (`count` includes the one being handled). */
export const shouldPark = (count) => count >= 2;

/** The one consolidated comment: the attempts, the identical failure, and what would unblock it. */
export function summaryComment({ attempts, code, detail, unblock, sig = "" }) {
  const n = Number.isInteger(attempts) ? attempts : 2;
  return `## Parked: the same failure repeated\n**Attempts**: ${n} lane runs ended with the identical failure \`${code}\`; the engine stops relaunching it.\n**Failure**: ${String(detail ?? "").trim().slice(0, 1500)}\n**To unblock**: ${unblock || "a decision or input that changes what the lane can do (edit the issue or contract, supply the missing input), then remove the parked label to rerun."}${sig ? `\nsig=${sig}` : ""}`;
}
