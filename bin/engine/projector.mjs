/**
 * GitHub adapter: reads/writes the FORGE:STATE block and workflow labels.
 * `io.gh(args)` is injected (async, returns stdout) so this is testable offline.
 */
import { parseState, upsertStateBlock } from "./state.mjs";

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
  };
}
