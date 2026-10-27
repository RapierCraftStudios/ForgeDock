/**
 * #4518: a builder CLI killed from outside (host or OOM guard, scope stop, operator SIGTERM) exits with SIGTERM/SIGKILL
 * or status 143/137 and no timer of ours fired (our own kills throw CLI_TIMEOUT / CLI_IDLE / CLI_CONTEXT / CLI_TURNS).
 */
export function isExternalKill(e) {
  if (e?.code !== "CLI_BACKEND_FAILED") return false; // #4690: a scope-limit stop is CLI_LANE_LIMIT, never a host kill
  return e.signal === "SIGTERM" || e.signal === "SIGKILL" || e.status === 143 || e.status === 137;
}
