// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Post-merge step of `forgedock release` (#5208 part 1: stub). Part 3 (#5213) fills it in without touching `release.mjs`:
 * confirm or dispatch the publish run, wait for the artifact, open the version-sync PR.
 */

/** @returns {{blocked: true, reason: string}} */
export async function postMergeStep(_ctx) {
  return { blocked: true, reason: "post-merge (publish check, version-sync PR) is not automated yet; use the manual path: watch publish.yml and open the chore/sync-version PR (commands/review-pr-staging.md)" };
}
