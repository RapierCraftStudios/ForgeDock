// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5704: the post-deploy reconcile for unmanaged repos (`release.managed` off). "Merged" is not "live": an issue whose lane merged
 * is reconciled against the **live SHA** read from the deploy record (`deploy.live_release_command` in `.forge/release.yaml` on the
 * default branch, else forge.yaml `deploy.engine.live_release_command`), never against the default branch. An unknown live SHA
 * is a no-op (fail closed). Per open `workflow:merged` / `workflow:merged-unverified` issue:
 *   - fix commit unresolvable (or not in the clone) -> skipped and reported;
 *   - fix not an ancestor of the live SHA -> `awaiting-promotion` ensured, left open;
 *   - an ancestor -> `awaiting-promotion` dropped and the issue's `[check:<id>]` entries from `.forge/post-deploy-checks.json` on
 *     origin/<default> run (the probe runner, `expect` included); a windowed entry (`for`) leaves it open under the monitoring label;
 *   - any fail -> `post-deploy-failed` plus a comment with the output; never closed;
 *   - all pass, or no checks and no FORGE:TRACKED hand-off (the orphan path) -> `FORGE:VERIFIED <live sha>`, close, tick the rollup.
 * Helper-level reuse of the #5562 engine (verifiedMarker, hasVerified, readTarget) and of the #4626 check runner, so managed and
 * unmanaged modes share one marker and one check implementation; `closeIssues`/`verifyStep` are not called (they need the managed
 * release ctx and fence). Idempotent: a FORGE:VERIFIED for the live SHA is never re-posted, a `post-deploy-failed` issue is not re-run.
 * Run by `forgedock close reconcile [--dry-run]` and by `probe --due` (the schedd timer). No model call.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTarget } from "./release-deploy.mjs";
import { verifiedMarker, hasVerified } from "./release-verify.mjs";
import { parsePolicy, POLICY_PATH } from "./release-config.mjs";
import { readEngine } from "./deploy-stages.mjs";
import { checksAt, runNamedChecks, tickItems, addMonitoringLabel, CHECKS_FILE } from "./postdeploy-check.mjs";
import { fixSha, readProbeConfig, resolveDefaultBranch, spawnProbe, clearAwaitingPromotion, markPostDeployFailed, POST_DEPLOY_FAILED_LABEL, OUTPUT_TAIL } from "./probe.mjs";
import { REMEDIATION_TRACKED_MARKER } from "./issuewatch-reconcile.mjs";

export const MERGED_LABELS = ["workflow:merged", "workflow:merged-unverified"];
export const AWAITING_PROMOTION_LABEL = "awaiting-promotion";
const CHECK_RE = /\[check:\s*([a-z0-9][a-z0-9._-]{0,63})\s*\]/g;
const short = (s) => String(s ?? "").slice(0, 12);
const labelsOf = (iss) => (iss?.labels ?? []).map((l) => String(l?.name ?? l));
const fenced = (s) => { const f = "`".repeat(Math.max(3, ...[...String(s).matchAll(/`+/g)].map((m) => m[0].length + 1))); return `${f}\n${String(s).trim() || "(no output)"}\n${f}`; };

/** A FORGE:TRACKED hand-off that defers the issue (the remediation merge's own note is not one: it waits for this reconcile). */
export const hasHandOff = (comments) => (comments ?? []).some((c) => { const b = String(c?.body ?? ""); return /FORGE:TRACKED/.test(b) && !b.includes(REMEDIATION_TRACKED_MARKER); });

/** The `[check:<id>]` ids an issue body names, in order, distinct. */
export const checkIdsOf = (body) => [...new Set([...String(body ?? "").matchAll(CHECK_RE)].map((m) => m[1]))];

/** `deploy.live_release_command`: `.forge/release.yaml` on origin/<default>, else forge.yaml `deploy.engine` (default branch's copy wins). */
export async function liveReleaseCommand({ io, cwd, defaultBranch }) {
  let text = null;
  try { text = String(await io.git(["show", `origin/${defaultBranch}:${POLICY_PATH}`], { cwd })); } catch { text = null; }
  if (text != null) {
    const cmd = parsePolicy(text).policy?.deploy?.live_release_command;
    if (typeof cmd === "string" && cmd.trim()) return cmd.trim();
  }
  let raw = null;
  try { raw = String(await io.git(["show", `origin/${defaultBranch}:forge.yaml`], { cwd })); } catch { try { raw = readFileSync(join(cwd, "forge.yaml"), "utf8"); } catch { raw = null; } }
  const cmd = readEngine({ raw, io: null, def: null })?.live_release_command;
  return typeof cmd === "string" && cmd.trim() ? cmd.trim() : null;
}

/** `io.rehearse` when the io has one (release io), else the probe runner with the caller's env. */
const rehearseOf = (io, cwd, env, spawn) => io.rehearse ? io.rehearse.bind(io) : async (cmd, { timeout = 120_000 } = {}) => {
  const r = await (spawn ?? spawnProbe)({ run: cmd, cwd, env, timeoutMs: timeout });
  return { ok: !r.timedOut && r.code === 0, code: r.code, output: String(r.stdout ?? "") };
};

async function readIssue(n, repo, io) {
  const iss = JSON.parse(String(await io.gh(["api", `repos/${repo}/issues/${n}`])));
  const raw = String(await io.gh(["api", `repos/${repo}/issues/${n}/comments`, "--paginate", "--jq", ".[]"]));
  return { ...iss, number: n, comments: raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) };
}

async function openMerged(repo, io, limit) {
  const seen = new Set();
  for (const label of MERGED_LABELS) {
    try {
      for (const i of JSON.parse(String(await io.gh(["issue", "list", "-R", repo, "--state", "open", "--label", label, "--json", "number", "--limit", String(limit)])) || "[]")) seen.add(Number(i.number));
    } catch { /* a repo without the label lists nothing */ }
  }
  return [...seen].filter(Number.isInteger).sort((a, b) => a - b);
}

const hasCommit = async (io, sha, cwd) => { try { await io.git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { cwd }); return true; } catch { return false; } };
const isAncestor = async (io, sha, live, cwd) => { try { await io.git(["merge-base", "--is-ancestor", sha, live], { cwd }); return true; } catch { return false; } };

async function ensureAwaiting({ io, repo, issue }) {
  const add = () => io.gh(["issue", "edit", String(issue), "-R", repo, "--add-label", AWAITING_PROMOTION_LABEL]);
  try { await add(); } catch {
    try { await io.gh(["label", "create", AWAITING_PROMOTION_LABEL, "-R", repo, "--force", "--color", "FBCA04", "--description", "Merged, not yet in the live release. Managed by ForgeDock."]); await add(); } catch { /* the reconcile row still says it */ }
  }
}

/** Tick the passed checks' items in the issue body and in the open post-deploy rollup issues; best effort. */
async function tickRollup({ io, repo, iss, ids }) {
  if (!ids.length) return;
  const set = new Set(ids);
  const edit = async (n, body) => { const next = tickItems(body, set); if (next !== String(body ?? "")) await io.gh(["issue", "edit", String(n), "-R", repo, "--body", next]); };
  try { await edit(iss.number, iss.body); } catch { /* the FORGE:VERIFIED comment is the record */ }
  try {
    const rolls = JSON.parse(String(await io.gh(["issue", "list", "-R", repo, "--state", "open", "--search", "FORGE:POSTDEPLOY_ROLLUP in:body", "--json", "number,body", "--limit", "20"])) || "[]");
    for (const r of rolls) { try { await edit(r.number, r.body); } catch { /* next pass */ } }
  } catch { /* no rollup */ }
}

/**
 * Reconcile the open merged issues against the live SHA. @returns {Promise<{live: ?string, reason?: string, rows: Array<{issue, outcome, detail}>}>}
 * Outcomes: unresolved | awaiting-promotion | monitoring | failed | failed-earlier | missing-check | tracked | verified | error.
 */
export async function reconcileLive({ repo, io, cwd = process.cwd(), dryRun = false, config = readProbeConfig(cwd), env = process.env, spawn, defaultBranch, limit = 200 }) {
  const def = defaultBranch ?? await resolveDefaultBranch({ repo, io, cwd });
  if (!def) return { live: null, reason: "default branch unknown", rows: [] };
  const cmd = await liveReleaseCommand({ io, cwd, defaultBranch: def });
  if (!cmd) return { live: null, reason: "deploy.live_release_command is not set: live SHA unknown, nothing reconciled", rows: [] };
  const target = await readTarget({ rehearse: rehearseOf(io, cwd, env, spawn) }, cmd);
  if (!target?.sha) return { live: null, reason: "the live-release command returned no SHA: nothing reconciled", rows: [] };
  const live = target.sha;
  if (!(await hasCommit(io, live, cwd))) return { live, reason: `live SHA ${short(live)} is not in this clone (fetch first): nothing reconciled`, rows: [] };
  const checks = await checksAt((a, o) => io.git(a, o), [`origin/${def}`], cwd);
  const rows = [];
  for (const n of await openMerged(repo, io, limit)) {
    try { rows.push(await reconcileIssue({ n, repo, io, cwd, dryRun, config, env, spawn, live, checks, def })); }
    catch (e) { rows.push({ issue: n, outcome: "error", detail: String(e?.message ?? e).split("\n")[0].slice(0, 200) }); }
  }
  return { live, rows };
}

async function reconcileIssue({ n, repo, io, cwd, dryRun, config, env, spawn, live, checks, def }) {
  const row = (outcome, detail = "") => ({ issue: n, outcome, detail });
  const iss = await readIssue(n, repo, io);
  const labels = labelsOf(iss);
  const fix = await fixSha(iss, io, repo);
  if (!fix || !(await hasCommit(io, fix, cwd))) return row("unresolved", fix ? `fix ${short(fix)} is not in this clone` : "no fix commit found (FORGE:TRAJECTORY or a merged closing PR)");
  if (!(await isAncestor(io, fix, live, cwd))) {
    if (!dryRun && !labels.includes(AWAITING_PROMOTION_LABEL)) await ensureAwaiting({ io, repo, issue: n });
    return row("awaiting-promotion", `fix ${short(fix)} is not in live ${short(live)}`);
  }
  if (labels.includes(POST_DEPLOY_FAILED_LABEL)) return row("failed-earlier", `labelled ${POST_DEPLOY_FAILED_LABEL}: cleared by a person or a new fix`);
  if (!dryRun && labels.includes(AWAITING_PROMOTION_LABEL)) await clearAwaitingPromotion({ io, repo, issue: n });
  const verified = hasVerified(iss.comments, live);
  const ids = verified ? [] : checkIdsOf(iss.body);
  const missing = ids.filter((id) => !checks[id]);
  if (missing.length) return row("missing-check", `names ${missing.map((m) => `[check:${m}]`).join(", ")} but ${CHECKS_FILE} on ${def} has no such entry`);
  const windowed = ids.filter((id) => checks[id].forMs), now = ids.filter((id) => !checks[id].forMs);
  const results = now.length ? await runNamedChecks({ ids: now, checks, cwd, config, env, spawn }) : [];
  const failed = results.filter((r) => r.result !== "pass");
  if (failed.length) {
    if (dryRun) return row("failed", `${failed.map((f) => f.id).join(", ")} failed (dry run: not recorded)`);
    await markPostDeployFailed({ io, repo, issue: n });
    const body = [`## Post-deploy verification failed at live ${short(live)}`, `The fix \`${short(fix)}\` is live, but ${failed.map((f) => `\`${f.id}\``).join(", ")} failed. Not closed; labelled \`${POST_DEPLOY_FAILED_LABEL}\`.`, "",
      ...failed.flatMap((f) => [`**${f.id}** (exit ${f.exit ?? "timeout"})`, fenced(String(f.output ?? "").slice(-OUTPUT_TAIL)), ""])].join("\n");
    try { await io.gh(["issue", "comment", String(n), "-R", repo, "--body", body]); } catch { /* the label still shows it */ }
    return row("failed", `${failed.map((f) => f.id).join(", ")} failed at live ${short(live)}`);
  }
  if (windowed.length) {
    if (!dryRun) await addMonitoringLabel({ io, repo, issue: n });
    return row("monitoring", `windowed ${windowed.join(", ")}: left open under monitoring`);
  }
  if (!verified && !ids.length && hasHandOff(iss.comments)) return row("tracked", "no checks and a FORGE:TRACKED hand-off: left open");
  if (dryRun) return row("verified", `live ${short(live)}${ids.length ? `, ${ids.length} check(s) passed` : ", no checks"} (dry run: not closed)`);
  const note = ids.length ? `${ids.map((i) => `\`${i}\``).join(", ")} passed against the live release.` : "No post-deploy checks and no hand-off: closed once the fix is live.";
  if (!verified) await io.gh(["issue", "comment", String(n), "-R", repo, "--body", `${verifiedMarker(live)}\n## Live and verified\nThe fix \`${short(fix)}\` is in the live release \`${short(live)}\`. ${note}`]);
  await tickRollup({ io, repo, iss, ids });
  await io.gh(["issue", "close", String(n), "-R", repo, "--reason", "completed"]);
  return row("verified", `closed at live ${short(live)}${verified ? " (already verified)" : ""}`);
}

const GROUPS = [["verified", "verified and closed"], ["failed", "failed (post-deploy-failed)"], ["awaiting-promotion", "awaiting promotion"], ["monitoring", "monitoring"], ["tracked", "tracked hand-off"], ["missing-check", "missing check"], ["failed-earlier", "failed earlier"], ["unresolved", "unresolved fix"], ["error", "error"]];

/** One line: `live <sha>: verified 2, awaiting promotion 1`, the no-op reason, or "" when nothing was open. */
export function formatReconcileSummary({ live, reason, rows = [] } = {}) {
  if (!live || reason) return `live reconcile: ${reason ?? "live SHA unknown, nothing reconciled"}`;
  const parts = GROUPS.map(([k, label]) => [label, rows.filter((r) => r.outcome === k).length]).filter(([, c]) => c).map(([l, c]) => `${l} ${c}`);
  return parts.length ? `live reconcile at ${short(live)}: ${parts.join(", ")}` : "";
}
