/**
 * #4920: who else owns an issue's lane, read from GitHub (never host-local state), so a second batch, a remote
 * sandbox or a restarted daemon sees the same answer. A live FORGE:STATE lease held by another lane, or an open
 * `feat/issue-N-lean` PR that is not ours, means another lane owns the issue. Generic: no repo or pool logic.
 */
import { parseState } from "../engine/state.mjs";
import { MAX_LEASE_TTL_MS } from "../engine/projector.mjs";

/** The live lease on an issue body held by someone other than `selfId` (null: none, expired, ours or implausibly far out). */
export function foreignLease(body, { selfId = null, now = Date.now() } = {}) {
  const l = parseState(body)?.lease;
  if (!l || !Number.isFinite(l.until) || l.until <= now || l.until > now + MAX_LEASE_TTL_MS) return null;
  return l.by && l.by !== selfId ? l : null;
}

/**
 * @param {{gh: Function, repo: string, issue: number, branch?: string, selfId?: string|null, ownPr?: number|null, now?: number, checkLease?: boolean, checkPr?: boolean}} a
 * @returns {Promise<{kind: "lease"|"pr", detail: string}|null>} null when nothing else owns it or GitHub is unreadable (fail-open)
 */
export async function otherLaneOwner({ gh, repo, issue, branch = `feat/issue-${issue}-lean`, selfId = null, ownPr = null, now = Date.now(), checkLease = true, checkPr = true }) {
  const json = async (args) => { try { return JSON.parse(String(await gh(args))); } catch { return null; } };
  if (checkLease) {
    const iss = await json(["issue", "view", String(issue), "-R", repo, "--json", "body"]);
    const l = foreignLease(iss?.body ?? "", { selfId, now });
    if (l) return { kind: "lease", detail: `issue ${issue} leased by ${l.by} until ${new Date(l.until).toISOString()}` };
  }
  if (!checkPr) return null;
  const prs = await json(["pr", "list", "-R", repo, "--head", branch, "--state", "open", "--json", "number", "--limit", "5"]);
  const other = Array.isArray(prs) ? prs.find((p) => Number.isInteger(p?.number) && p.number !== ownPr) : null;
  return other ? { kind: "pr", detail: `PR #${other.number} is open on ${branch} from another lane` } : null;
}
