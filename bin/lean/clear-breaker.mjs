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

/**
 * #5978: the runner's own reset of a tripped breaker. It closes after `cooldownMs` when the failures were environmental
 * (VM restart, mirror, network: `environmental`) and the pool is healthy again (#5947 classes); anything else needs `--clear-breaker`.
 * @param {{tripped: ({at?: number}|null|undefined), now: number, cooldownMs: number, environmental: boolean, poolHealthy: boolean}} p
 * @returns {{reset: boolean, why: string}}
 */
export function decideAutoReset({ tripped, now, cooldownMs, environmental, poolHealthy }) {
  if (!tripped || !Number.isFinite(tripped.at)) return { reset: false, why: "not tripped" };
  if (!environmental) return { reset: false, why: "failure signature is not environmental" };
  if (now - tripped.at < cooldownMs) return { reset: false, why: "cooldown not elapsed" };
  if (!poolHealthy) return { reset: false, why: "pool not healthy" };
  return { reset: true, why: "environmental signature, cooldown elapsed, pool healthy" };
}
