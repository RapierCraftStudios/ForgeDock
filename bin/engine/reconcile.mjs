/**
 * Merge the local run-log state and the remote FORGE:STATE index.
 * Rule: GitHub wins on divergence (spec §5.3).
 */
export function reconcileState(local, remote) {
  if (!remote) return { state: local ?? null, action: local ? "local" : "fresh" };
  if (!local) return { state: remote, action: "hydrate" };
  if (remote.v > local.v) return { state: remote, action: "hydrate" };   // advanced elsewhere
  if (remote.v < local.v) return { state: local, action: "remirror" };   // crashed pre-mirror
  return { state: local, action: "local" };
}
