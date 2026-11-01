/**
 * GitHub adapter: reads/writes the FORGE:STATE block and workflow labels.
 * `io.gh(args)` is injected (async, returns stdout) so this is testable offline.
 */
import { parseState, upsertStateBlock } from "./state.mjs";
import { isTrustedActor } from "./phases.mjs";

// Defence in depth: a lease further out than 3x the engine's 10 min TTL (same
// bound as scripts/remediate-liveness.sh MAX_LEASE_TTL_MS) is never honoured.
export const MAX_LEASE_TTL_MS = 3 * 600_000;

// Body + provenance in ONE call. `gh issue view --json` cannot return the last
// editor or authorAssociation, so GraphQL is used. -F variables, never interpolation.
const PROVENANCE_QUERY = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){"
  + "issue(number:$number){body authorAssociation author{login __typename} editor{login __typename}}}}";

export function makeProjector(io, { repo } = {}) {
  const gh = io.gh;

  // Throws on an unreadable body: an empty string would make writeState wipe the issue (#4860).
  async function getBody(issue) {
    const out = await gh(["issue", "view", String(issue), "--json", "body", ...(repo ? ["-R", repo] : [])]);
    let body;
    try { body = JSON.parse(out).body; } catch { throw new Error(`issue #${issue}: body read returned non-JSON output`); }
    if (typeof body !== "string") throw new Error(`issue #${issue}: body read returned no body`);
    return body;
  }

  /**
   * Body of the issue iff its LAST EDITOR (`editor ?? author`) is trusted, else
   * null. The reporter can edit their own body, so creator-only trust is wrong
   * and engine writes (bot editor) must stay readable. Any error, malformed
   * JSON or missing provenance fails closed (null).
   */
  async function getTrustedBody(issue) {
    try {
      const out = await gh(["api", "graphql", "-f", `query=${PROVENANCE_QUERY}`,
        "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${Number(issue)}`]);
      const i = JSON.parse(out)?.data?.repository?.issue;
      if (!i || typeof i.body !== "string") return null;
      const actor = i.editor ?? i.author;
      if (!actor || typeof actor !== "object") return null;
      // authorAssociation describes the CREATOR: valid for the actor only when
      // the actor IS the creator. A distinct human editor's standing comes from
      // the collaborator permission endpoint (fail closed to NONE).
      let association = "NONE";
      if (!i.editor || i.editor.login === i.author?.login) association = i.authorAssociation;
      else if (actor.__typename !== "Bot" && typeof actor.login === "string" && /^[A-Za-z0-9-]+(\[bot\])?$/.test(actor.login)) {
        try {
          const perm = JSON.parse(await gh(["api", `repos/{owner}/{repo}/collaborators/${actor.login}/permission`, "--jq", "{permission}"])).permission;
          association = perm === "admin" ? "OWNER" : (perm === "maintain" || perm === "write") ? "COLLABORATOR" : "NONE";
        } catch { /* fail closed */ }
      }
      return isTrustedActor({ association, type: actor.__typename, login: actor.login }) ? i.body : null;
    } catch { return null; }
  }

  return {
    /** @returns {Promise<import("./phases.mjs").RunState|null>} */
    async readState(issue) {
      const body = await getTrustedBody(issue);
      if (body === null) return null;
      const st = parseState(body);
      if (st?.lease && !(Number.isFinite(st.lease.until) && st.lease.until <= Date.now() + MAX_LEASE_TTL_MS)) {
        return { ...st, lease: null };
      }
      return st;
    },

    async writeState(issue, index) {
      const old = await getBody(issue);
      const body = upsertStateBlock(old, index);
      // Each run of issue text around a FORGE:STATE block must survive on its own: the block is replaced in place, so text
      // before and after it stays apart and a joined string would never match (#4871).
      const dropped = old.split(/<!-- FORGE:STATE\s*[\s\S]*?-->/).map((t) => t.trim()).filter(Boolean).some((t) => !body.includes(t));
      if (dropped) throw new Error(`issue #${issue}: refusing a state write that drops existing issue text`);
      await gh(["issue", "edit", String(issue), "--body", body, ...(repo ? ["-R", repo] : [])]);
    },

    async setLabel(issue, label) {
      await gh(["issue", "edit", String(issue), "--add-label", label, ...(repo ? ["-R", repo] : [])]);
    },

    async removeLabel(issue, label) {
      await gh(["issue", "edit", String(issue), "--remove-label", label, ...(repo ? ["-R", repo] : [])]);
    },
  };
}
