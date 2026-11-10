// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Host preflight of `forgedock release` (#5277): forge.yaml `release.preflight_command` runs the repo's own suites on the host
 * (not as Actions minutes) before the release PR is opened, again after each fix round, and once more on the final head before
 * the draft PR is marked ready. A failing blocking preflight files one `release-blocker` issue per head and stops the job; `--resume`
 * retries. With no command set every function here is a no-op. No model call. Effects go through `ctx.io`.
 */
import { fileBlocker, tail } from "./release-rehearsal.mjs";

export const PREFLIGHT_TIMEOUT_MS = 20 * 60_000;
const json = (s) => JSON.parse(String(s || "null"));
const off = (v) => ["false", "off", "no", "0"].includes(String(v ?? "").trim().toLowerCase());

/** `release.preflight_command` / `_timeout` (seconds) / `_blocking` -> `{command, timeoutMs, blocking}`, or null when no command is set. */
export function parsePreflightConfig(r) {
  const command = typeof r?.preflight_command === "string" ? r.preflight_command.trim() : "";
  if (!command) return null;
  const secs = Number(r.preflight_timeout);
  return { command, timeoutMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : PREFLIGHT_TIMEOUT_MS, blocking: !off(r.preflight_blocking) };
}

/**
 * Run the preflight at `head`; on failure file/comment the release-blocker issue.
 * @returns {{ok, head, command, blocking, code, timedOut, issue?}}
 */
export async function runHostPreflight(ctx, { head, pr }) {
  const { io, repo, config } = ctx;
  const cfg = config.preflight;
  const run = await io.rehearse(cfg.command, { timeout: cfg.timeoutMs });
  const res = { ok: !!run.ok, head, command: cfg.command, blocking: cfg.blocking, code: run.code ?? null, timedOut: !!run.timedOut, output: run.ok ? "" : tail(run.output) };
  if (!res.ok) res.issue = await fileBlocker({ io, repo, pr, kind: "preflight" }, res);
  const { output, ...kept } = res;
  return kept;
}

const stopOf = (r) => ({ stopped: true, why: `release preflight failed at ${r.head} (release-blocker #${r.issue}); fix it, then resume`, ...r });

/** Step before `release-pr`: preflight on the staging head, so no release PR is opened on a failing head. */
export async function hostPreflightStep(ctx) {
  const cfg = ctx.config.preflight;
  if (!cfg) return { skipped: true };
  const head = String(await ctx.io.gh(["api", `repos/${ctx.repo}/commits/${ctx.staging}`, "--jq", ".sha"])).trim();
  const r = await runHostPreflight(ctx, { head });
  return !r.ok && r.blocking ? stopOf(r) : r;
}

/** Step after `fixes`: preflight on the final head, then mark the draft release PR ready so Actions CI runs once on it. */
export async function markReadyStep(ctx) {
  if (!ctx.config.preflight) return { skipped: true };
  const { io, repo } = ctx;
  const { pr } = ctx.state.steps["release-pr"].result;
  const view = json(await io.gh(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,isDraft"]));
  const r = await runHostPreflight(ctx, { head: view?.headRefOid, pr });
  if (!r.ok && r.blocking) return stopOf(r);
  if (view?.isDraft) await io.gh(["pr", "ready", String(pr), "--repo", repo]);
  return { ...r, ready: true, wasDraft: !!view?.isDraft };
}
