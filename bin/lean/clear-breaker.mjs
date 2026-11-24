/**
 * #5964: the runner's decision on a hosted `--clear-breaker` request. The request carries the time it was made;
 * it clears only a breaker that tripped at or before it, so a stale request cannot close a later trip.
 */

/**
 * @param {{tripped: ({at?: number}|null|undefined), requestAt: (number|boolean|null|undefined)}} p
 * @returns {{clear: boolean, stale: boolean}} `clear`: reset the breaker; `stale`: the request predates the current trip (discard it)
 */
export function decideClear({ tripped, requestAt }) {
  if (requestAt === true) return { clear: true, stale: false }; // legacy boolean seam: unconditional
  if (typeof requestAt !== "number" || !Number.isFinite(requestAt)) return { clear: false, stale: false };
  if (tripped && Number.isFinite(tripped.at) && tripped.at > requestAt) return { clear: false, stale: true };
  return { clear: true, stale: false };
}
