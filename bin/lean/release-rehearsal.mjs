// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Rehearsal step of `forgedock release` (#5253): runs the project's own deploy dry-run (forge.yaml `release.rehearsal`) on the
 * host against the release-PR head, after review and before promotion. A failing blocking rehearsal files (or updates) one
 * `release-blocker` issue per head and stops the job like a GATE_FAILURE; `--resume` re-runs it. The result is recorded in the
 * release state and in a FORGE:REHEARSAL section of the release PR body. No model call. Effects go through `ctx.io`.
 */
export const REHEARSAL_TIMEOUT_MS = 20 * 60_000;
export const OUTPUT_TAIL_CHARS = 6000;
export const BLOCKER_LABEL = "release-blocker";
const PR_START = "<!-- FORGE:REHEARSAL -->", PR_END = "<!-- /FORGE:REHEARSAL -->";
const json = (s) => JSON.parse(String(s || "null"));
const off = (v) => ["false", "off", "no", "0"].includes(String(v ?? "").trim().toLowerCase());

/**
 * The rehearsal keys of forge.yaml's `release` map -> `{command, timeoutMs, blocking}`, or null when no command is set. The
 * forge.yaml parser reads two levels, so the block is the flat keys `rehearsal_command`, `rehearsal_timeout` (seconds) and
 * `rehearsal_blocking`.
 */
export function parseRehearsalConfig(r) {
  const command = typeof r?.rehearsal_command === "string" ? r.rehearsal_command.trim() : "";
  if (!command) return null;
  const secs = Number(r.rehearsal_timeout);
  return { command, timeoutMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : REHEARSAL_TIMEOUT_MS, blocking: !off(r.rehearsal_blocking) };
}

const tail = (s) => { const t = String(s ?? ""); return t.length > OUTPUT_TAIL_CHARS ? `…${t.slice(-OUTPUT_TAIL_CHARS)}` : t; };
const marker = (head) => `<!-- FORGE:RELEASE_BLOCKER head=${head} -->`;

const prSection = (res) => `${PR_START}\n**Rehearsal**: ${res.ok ? "PASS" : res.blocking ? "FAIL (promotion held)" : "FAIL (non-blocking)"} at \`${res.head}\` — \`${res.command}\`${res.issue ? ` (#${res.issue})` : ""}\n${PR_END}`;

async function recordInPr({ io, repo, pr }, res) {
  const body = String(json(await io.gh(["pr", "view", String(pr), "--repo", repo, "--json", "body"]))?.body ?? "");
  const a = body.indexOf(PR_START), b = body.indexOf(PR_END);
  const base = a >= 0 && b > a ? (body.slice(0, a) + body.slice(b + PR_END.length)).trimEnd() : body.trimEnd();
  await io.gh(["pr", "edit", String(pr), "--repo", repo, "--body", `${base}\n\n${prSection(res)}\n`]);
}

/** One open release-blocker issue per head: comment on it when it exists, else create it. @returns the issue number. */
async function fileBlocker({ io, repo, pr }, res) {
  const text = `Release rehearsal failed on PR #${pr} at head \`${res.head}\`.\n\nCommand: \`${res.command}\` (exit ${res.code ?? "?"}${res.timedOut ? ", timed out" : ""})\n\n\`\`\`\n${tail(res.output)}\n\`\`\`\n`;
  const open = json(await io.gh(["issue", "list", "--repo", repo, "--label", BLOCKER_LABEL, "--state", "open", "--limit", "100", "--json", "number,body"])) ?? [];
  const found = open.find((i) => String(i.body ?? "").includes(marker(res.head)));
  if (found) { await io.gh(["issue", "comment", String(found.number), "--repo", repo, "--body", text]); return found.number; }
  const url = String(await io.gh(["issue", "create", "--repo", repo, "--label", BLOCKER_LABEL, "--title", `release-blocker: rehearsal failed at ${res.head.slice(0, 12)}`, "--body", `${marker(res.head)}\n${text}`])).trim();
  return Number(/\/issues\/(\d+)/.exec(url)?.[1]) || null;
}

export async function rehearsalStep(ctx) {
  const { io, repo, config } = ctx;
  const cfg = config.rehearsal;
  if (!cfg) return { skipped: true };
  const { pr } = ctx.state.steps["release-pr"].result;
  const head = json(await io.gh(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid"]))?.headRefOid;
  const run = await io.rehearse(cfg.command, { timeout: cfg.timeoutMs });
  const res = { ok: !!run.ok, head, command: cfg.command, blocking: cfg.blocking, code: run.code ?? null, timedOut: !!run.timedOut, output: run.ok ? "" : tail(run.output), at: new Date(io.now()).toISOString() };
  if (!res.ok) res.issue = await fileBlocker({ io, repo, pr }, res);
  await recordInPr({ io, repo, pr }, res);
  const { output, ...kept } = res;
  if (!res.ok && res.blocking) return { stopped: true, why: `release rehearsal failed at ${head} (release-blocker #${res.issue}); fix it, then resume`, ...kept };
  return kept;
}
