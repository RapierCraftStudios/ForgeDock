/**
 * #4920: who else owns an issue's lane, read from GitHub (never host-local state), so a second batch, a remote
 * sandbox or a restarted daemon sees the same answer. A live FORGE:STATE lease held by another lane, or an open
 * `feat/issue-N-lean` PR that is not ours, means another lane owns the issue. Generic: no repo or pool logic.
 */
import { parseState } from "../engine/state.mjs";
import { MAX_LEASE_TTL_MS } from "../engine/projector.mjs";

/** The live lease on an issue body held by someone other than `selfId` (null: none, expired, ours or implausibly far out). */
export function foreignLease(body, { selfId = null, selfBatch = null, now = Date.now() } = {}) {
  const l = parseState(body)?.lease;
  if (!l || !Number.isFinite(l.until) || l.until <= now || l.until > now + MAX_LEASE_TTL_MS) return null;
  if (selfBatch && l.batch === selfBatch) return null; // #5654: a run of this same batch (its stale lease), not another lane's
  return l.by && l.by !== selfId ? l : null;
}

/**
 * @param {{gh: Function, repo: string, issue: number, branch?: string, selfId?: string|null, selfBatch?: string|null, ownPr?: number|null, now?: number, checkLease?: boolean, checkPr?: boolean}} a
 * @returns {Promise<{kind: "lease"|"pr", detail: string}|null>} null when nothing else owns it or GitHub is unreadable (fail-open)
 */
export async function otherLaneOwner({ gh, repo, issue, branch = `feat/issue-${issue}-lean`, selfId = null, selfBatch = null, ownPr = null, now = Date.now(), checkLease = true, checkPr = true }) {
  const json = async (args) => { try { return JSON.parse(String(await gh(args))); } catch { return null; } };
  if (checkLease) {
    const iss = await json(["issue", "view", String(issue), "-R", repo, "--json", "body"]);
    const l = foreignLease(iss?.body ?? "", { selfId, selfBatch, now });
    if (l) return { kind: "lease", detail: `issue ${issue} leased by ${l.by} until ${new Date(l.until).toISOString()}` };
  }
  if (!checkPr) return null;
  const prs = await json(["pr", "list", "-R", repo, "--head", branch, "--state", "open", "--json", "number", "--limit", "5"]);
  const other = Array.isArray(prs) ? prs.find((p) => Number.isInteger(p?.number) && p.number !== ownPr) : null;
  return other ? { kind: "pr", detail: `PR #${other.number} is open on ${branch} from another lane` } : null;
}

/**
 * #5241: clear the lease on `issue`'s FORGE:STATE when `shouldClear(lease)` agrees (a cancelled lane's, once it ended).
 * @param {{projector: {readState: Function, writeState: Function}, issue: number, shouldClear?: (lease: object) => boolean}} a
 * @returns {Promise<boolean>} true when a lease was cleared; false when none, kept by the guard, or GitHub is unreadable (fail-safe)
 */
export async function clearLease({ projector, issue, shouldClear = () => true }) {
  try {
    const st = await projector.readState(issue);
    if (!st?.lease || !shouldClear(st.lease)) return false;
    await projector.writeState(issue, { ...st, lease: null });
    return true;
  } catch { return false; }
}
