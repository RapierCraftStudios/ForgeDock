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

/** 12 hex characters of sha1(code + normalised detail). */
export function failureSignature(code, detail) {
  return createHash("sha1").update(`${code ?? ""}\n${normalizeDetail(detail)}`).digest("hex").slice(0, 12);
}

/** Earlier trusted NEEDS_HUMAN/PARKED comments carrying `sig=<hash>`. A PARKED summary counts as the failure it parked on. */
export function countIdentical(comments, sig, trusted = () => true) {
  let n = 0;
  for (const c of Array.isArray(comments) ? comments : []) {
    const body = String(c?.body ?? "");
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
