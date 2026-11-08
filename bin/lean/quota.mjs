// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account-pool exhaustion for a lane (#5236). When the rotator reports no account with room, a lane must not spawn
 * through the tokenbaton shim (which would fall back to the default profile and fail `backend.auth`), nor sleep on a
 * far reset: it ends `deferred` with `quota.exhausted` carrying the earliest reset, which the batch holds until.
 */
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";

/** Wait (s) when no reset is known. */
export const QUOTA_RETRY_SECONDS = 900;

/**
 * `{earliestReset}` (epoch ms or null) when `rotator.pick` finds no account outside `exclude`; null when one has room,
 * there is no smart rotator, or the pick fails (never block a lane on a rotator fault).
 */
export function poolExhausted(rotator, exclude) {
  try {
    if (!rotator || typeof rotator.pick !== "function") return null;
    const p = rotator.pick({ exclude });
    if (!p || p.account !== null || p.account === undefined) return null;
    return { earliestReset: Number.isFinite(p.earliestReset) && p.earliestReset > 0 ? p.earliestReset : null };
  } catch { return null; }
}

/** `e` marked as a `quota.exhausted` deferral (handled through `deferCode`); `backendId` keys the batch's account hold. */
export function exhaustedDeferral(e, { earliestReset, backendId, now }) {
  const at = Number.isFinite(earliestReset) && earliestReset > now ? earliestReset : null;
  return Object.assign(e, {
    deferCode: OUTCOME_CODES.QUOTA_EXHAUSTED,
    retryInSeconds: at ? Math.max(1, Math.ceil((at - now) / 1000)) : QUOTA_RETRY_SECONDS,
    backendId,
    ...(at ? { resetAtEpochMs: at, resetAt: new Date(at).toISOString() } : {}),
    deferDetail: `quota exhausted: no account has capacity${at ? `; earliest reset ${new Date(at).toISOString()}` : ""}`,
  });
}

/** Extra result facts of a `quota.exhausted` deferral: the earliest reset, so the batch holds until then. */
export const quotaFacts = (e) => (e?.deferCode === OUTCOME_CODES.QUOTA_EXHAUSTED && Number.isFinite(e.resetAtEpochMs) ? { resetAtEpochMs: e.resetAtEpochMs, resetAt: e.resetAt } : {});
