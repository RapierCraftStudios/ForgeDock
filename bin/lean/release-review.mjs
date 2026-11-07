// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Review and fix steps of `forgedock release` (#5208 part 1: stubs). Part 2 (#5212) fills these in without touching
 * `release.mjs`. Until then each returns a blocked result and the operator runs the manual path.
 */
const MANUAL = "use the manual path: forgedock review-staging <PR> (commands/review-pr-staging.md)";

/** Review step: run the staging panel, delta on head move, file findings. @returns {{blocked: true, reason: string}} */
export async function reviewStep(_ctx) {
  return { blocked: true, reason: `release review is not automated yet; ${MANUAL}` };
}

/** Fix step: a fix lane for a blocking finding. @returns {{blocked: true, reason: string}} */
export async function fixStep(_ctx) {
  return { blocked: true, reason: `release fix lanes are not automated yet; ${MANUAL}` };
}
