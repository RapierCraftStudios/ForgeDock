/**
 * GitHub adapter: reads/writes the FORGE:STATE block and workflow labels.
 * `io.gh(args)` is injected (async, returns stdout) so this is testable offline.
 */
import { parseState, upsertStateBlock } from "./state.mjs";

/**
 * forge#2382: canonical `workflow:*` states, mirroring scripts/transition-label.sh's
 * `VALID_STATES` array exactly (order and membership). Single-sourced here so
 * `setWorkflowLabel` below can validate its target and compute the "everything
 * else" removal set the same way the script does — this is NOT re-exported as
 * a general-purpose registry; it exists solely to back that one function.
 */
const WORKFLOW_STATES = [
  "investigating",
  "ready-to-build",
  "building",
  "in-review",
  "merged",
  "invalid",
  "decomposed",
  "awaiting-merge",
];

export function makeProjector(io) {
  const gh = io.gh;

  async function getBody(issue) {
    const out = await gh(["issue", "view", String(issue), "--json", "body"]);
    try { return JSON.parse(out).body ?? ""; } catch { return ""; }
  }

  return {
    /** @returns {Promise<import("./phases.mjs").RunState|null>} */
    async readState(issue) { return parseState(await getBody(issue)); },

    async writeState(issue, index) {
      const body = upsertStateBlock(await getBody(issue), index);
      await gh(["issue", "edit", String(issue), "--body", body]);
    },

    async setLabel(issue, label) {
      await gh(["issue", "edit", String(issue), "--add-label", label]);
    },

    async removeLabel(issue, label) {
      await gh(["issue", "edit", String(issue), "--remove-label", label]);
    },

    /**
     * forge#2382: engine-native `workflow:*` state machine — an in-process
     * port of scripts/transition-label.sh's core workflow-mode behavior
     * (that script remains the authoritative reference; this mirrors it
     * rather than shelling out, so the engine can issue transitions without
     * a subprocess call per the issue's own item 3 wording: "reusing ...
     * logic in-process").
     *
     * Behavior, matching the script exactly:
     *   1. Add `workflow:{targetState}`.
     *   2. Remove every OTHER `workflow:*` state currently present on the
     *      issue (read-modify-write against live labels — no local cache —
     *      so this is safe to call repeatedly/idempotently).
     *   3. ONLY when targetState is "awaiting-merge": best-effort clear a
     *      pre-existing `needs-human` label (the one sticky, write-only label
     *      this state machine is allowed to clear — see the script's own
     *      comment on this exception, forge#1809/#1810).
     *
     * Illegal transitions are impossible by construction: `targetState` must
     * be one of `WORKFLOW_STATES` or this throws synchronously before any
     * `gh` call is made — there is no way to reach an unrecognized
     * `workflow:*` label through this method.
     *
     * Best-effort on the read-back/removal step (matches the script's own
     * "add succeeds or throws; stale-label removal is best-effort" shape,
     * minus the script's retry-with-verification loop — a transient failure
     * here just leaves a stale label for the NEXT transition/sweep to clear,
     * never a wrong terminal label, since the target label is always added
     * first and unconditionally).
     *
     * @param {number|string} issue
     * @param {string} targetState - one of WORKFLOW_STATES (no `workflow:` prefix)
     */
    async setWorkflowLabel(issue, targetState) {
      if (!WORKFLOW_STATES.includes(targetState)) {
        throw new Error(`setWorkflowLabel: unknown target state "${targetState}" (expected one of: ${WORKFLOW_STATES.join(", ")})`);
      }
      const target = `workflow:${targetState}`;
      await gh(["issue", "edit", String(issue), "--add-label", target]);

      let current = [];
      try {
        const out = await gh(["issue", "view", String(issue), "--json", "labels"]);
        current = (JSON.parse(out || "{}").labels || []).map((l) => (l && l.name) || l);
      } catch {
        return; // best-effort — cannot determine stale labels without a label read; skip removal
      }

      const stale = WORKFLOW_STATES
        .filter((s) => s !== targetState)
        .map((s) => `workflow:${s}`)
        .filter((label) => current.includes(label));
      if (stale.length) {
        try {
          await gh(["issue", "edit", String(issue), "--remove-label", stale.join(",")]);
        } catch { /* best-effort — a future transition will retry the removal */ }
      }

      if (targetState === "awaiting-merge") {
        try {
          await gh(["issue", "edit", String(issue), "--remove-label", "needs-human"]);
        } catch { /* best-effort — label may simply not be present */ }
      }
    },
  };
}
