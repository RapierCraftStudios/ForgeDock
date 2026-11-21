/**
 * #5709: hold a lane's merge into the integration branch while a release PR (head = that branch, base = a default branch)
 * has CI running, so the merge does not restart the release's CI. Deterministic, no LLM; fail-open when GitHub cannot be read.
 * Two sources: a manual hold (`release merge-hold`, state key `mergeHold` of `_active`) and a pending-checks release PR.
 */

/**
 * #5777: report-only gate entries, never "release CI running" (mirrors CI_EXCLUDED_CHECKS of bin/review-staging.mjs).
 * `forge/deploy-gate` stays pending until the staging review posts its marker, so counting it held every merge for the whole review.
 */
const REPORT_ONLY_CHECKS = new Set(["forgedock/verify", "forge/deploy-gate", "Check for FORGE gate markers"]);

/** A rollup entry that has not finished (check run not COMPLETED, or a status context PENDING/EXPECTED); report-only gate entries never count. */
export function rollupPending(entry) {
  if (!entry) return false;
  if (REPORT_ONLY_CHECKS.has(String(entry.context ?? entry.name ?? ""))) return false;
  if (entry.__typename === "StatusContext" || (entry.state && !entry.status)) return /^(PENDING|EXPECTED)$/i.test(String(entry.state ?? ""));
  return String(entry.status ?? "").toUpperCase() !== "COMPLETED";
}

/** `release.hold_merges_during_release_ci` of a parsed release policy; default true (absent policy, key or section). */
export function holdEnabled(policy) {
  return policy?.release?.hold_merges_during_release_ci !== false;
}

/**
 * #5776: a release-ledger io for lanes. `makeLeanIo` has no `api`, which the ledger reader needs, so the hold's read threw a
 * TypeError that the fail-open catch swallowed (the manual hold never held). Read-only (GET): gh errors propagate unchanged
 * (their `HTTP 404` text keeps the ledger's missing-file detection working).
 * @param {(args: string[]) => Promise<string>} gh
 */
export function ledgerIoFromGh(gh) {
  return { api: async (method, path) => JSON.parse(String(await gh(["api", "-X", method, path])) || "null") };
}

/**
 * @param {object} o
 * @param {(args: string[]) => Promise<string>} o.gh   gh runner
 * @param {string} o.repo
 * @param {string} o.branch   the branch the lane merges into (without `origin/`)
 * @param {string[]} [o.defaults]  default branch names; a release PR targets one of them
 * @param {boolean} [o.enabled]  explicit switch (false disables)
 * @param {object|null} [o.policy]  parsed release policy; `release.hold_merges_during_release_ci: false` disables
 * @param {() => Promise<object|null>} [o.readActive]  the `_active` record, for the manual hold
 * @returns {Promise<{held: boolean, kind?: "manual"|"release-ci", reason?: string, pr?: number}>}
 */
export async function releaseMergeHold({ gh, repo, branch, defaults = [], enabled = true, policy = null, readActive = null }) {
  if (enabled === false || !holdEnabled(policy) || !branch) return { held: false };
  try {
    const a = readActive ? await readActive() : null;
    const m = a?.mergeHold;
    if (m) return { held: true, kind: "manual", reason: `manual merge hold (${m.reason ?? "no reason"})` };
  } catch { /* fail-open */ }
  try {
    const rows = JSON.parse(String(await gh(["pr", "list", "-R", repo, "--head", branch, "--state", "open", "--json", "number,baseRefName,statusCheckRollup"])) || "[]");
    const names = new Set(defaults.filter(Boolean));
    for (const p of Array.isArray(rows) ? rows : []) {
      if (!names.has(p?.baseRefName)) continue;
      if ((p.statusCheckRollup ?? []).some(rollupPending)) return { held: true, kind: "release-ci", pr: p.number, reason: `release PR #${p.number} (${branch} -> ${p.baseRefName}) has CI running` };
    }
  } catch { /* fail-open */ }
  return { held: false };
}
