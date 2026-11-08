// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Finding lifecycle at close: a `review-finding` issue leaves `needs-validation` as `validated` (merged fix) or `false-positive` (INVALID). */
export const FINDING_LABEL = "review-finding";
const VERDICTS = { merged: "CONFIRMED", invalid: "INVALID" };

const names = (labels) => (labels ?? []).map((l) => l?.name ?? l);
export const isFinding = (labels) => names(labels).includes(FINDING_LABEL);
export const findingVerdict = (reason) => VERDICTS[reason] ?? null;

/** Best effort: `{ applied, error? }`; non-findings and unmapped reasons are untouched. transition-label.sh --validate is idempotent. */
export async function resolveFindingLabel({ io, issue, labels, reason }) {
  const verdict = findingVerdict(reason);
  if (!verdict || !isFinding(labels)) return { applied: false };
  try { await io.validateLabel(issue, verdict); return { applied: true, verdict }; } catch (e) { return { applied: false, error: String(e?.message ?? e).slice(0, 160) }; }
}
