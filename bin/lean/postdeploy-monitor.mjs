// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Windowed post-deploy monitoring (#4627). A follow-up whose checks declare `for` (and `every`) stays open with the
 * `post-deploy-monitoring` label after its first pass. `sweepDue` (run by schedd's timer and `forgedock probe --due`) re-runs
 * each one when its cadence elapsed or `origin/<default>` moved (a release), with the command read from the default branch
 * (never an issue). A pass is a FORGE:PROBE record; the window end closes the follow-up; a fail after a pass files one
 * regression issue naming the fix commit and the last-passing and breaking release, then closes the follow-up. No model call.
 */
import { readProbeConfig, resolveDefaultBranch, PROBE_MARKER, OUTPUT_TAIL } from "./probe.mjs";
import { MONITORING_LABEL, checksAt, itemCheckIds, monitorRecord, runChecks, CHECKS_FILE } from "./postdeploy-check.mjs";
import { deferredFrom, isTrustedIssueComment } from "./prefilter.mjs";

export const REGRESSION_MARKER = "FORGE:REGRESSION";
const fenced = (s) => { const f = "`".repeat(Math.max(3, ...[...String(s).matchAll(/`+/g)].map((m) => m[0].length + 1))); return `${f}\n${String(s).trim() || "(no output)"}\n${f}`; };
const short = (s) => String(s ?? "unknown").slice(0, 12);

/** One monitored follow-up. Outcomes: skipped | unrunnable | not-due | due (dry run) | pass | window-ended | fail. */
export async function monitorOne({ issue, repo, def, defaultSha, cwd, io, now, dryRun, config, env, spawn }) {
  const row = (outcome, detail = "", extra = {}) => ({ issue, outcome, detail, ...extra });
  const iss = JSON.parse(String(await io.gh(["issue", "view", String(issue), "-R", repo, "--json", "number,title,body,state,labels,comments"])));
  if (String(iss.state).toUpperCase() !== "OPEN") return row("skipped", "not open");
  const recs = (iss.comments ?? []).filter((c) => isTrustedIssueComment(c)).map((c) => monitorRecord(c?.body)).filter(Boolean);
  const last = recs[recs.length - 1];
  const finish = async (comment) => {
    if (comment) await io.gh(["issue", "comment", String(issue), "-R", repo, "--body", comment]);
    await io.gh(["issue", "close", String(issue), "-R", repo, "--reason", "completed"]);
    try { await io.gh(["issue", "edit", String(issue), "-R", repo, "--remove-label", MONITORING_LABEL]); } catch { /* label already gone */ }
  };
  if (!last || last.result !== "pass" || !last.until) return row("skipped", last?.result === "fail" ? "already failed (FORGE:PROBE)" : "no windowed pass record");
  if (now >= last.until) {
    if (!dryRun) await finish(`<!-- FORGE:MONITOR -->\nPost-deploy monitoring window ended ${new Date(last.until).toISOString()} with no failure; closed.`);
    return row("window-ended", dryRun ? "dry run: not closed" : "closed", { fix: last.fix });
  }
  if (now - last.at < last.everyMs && defaultSha && defaultSha === last.defaultSha) return row("not-due", `next run after ${new Date(last.at + last.everyMs).toISOString()} or a new release`);
  const ids = itemCheckIds(iss.body);
  const checks = await checksAt(io.git, [`origin/${def}`], cwd);
  if (!ids.length || ids.some((id) => !id || !checks[id])) return row("unrunnable", `no runnable check on ${def} (${CHECKS_FILE})`);
  if (dryRun) return row("due", "dry run: not run", { fix: last.fix });
  const rows = await runChecks({ ids, checks, cwd, config, env, spawn });
  const ok = rows.every((r) => r.result === "pass");
  const rec = { fix: last.fix, default_sha: defaultSha, result: ok ? "pass" : "fail", at: new Date(now).toISOString(), ...(ok ? { window_until: new Date(last.until).toISOString(), every_ms: last.everyMs } : {}) };
  const sum = rows.map((r) => ({ id: r.id, result: r.result, exit: r.exit, ms: r.ms }));
  if (ok) {
    await io.gh(["issue", "comment", String(issue), "-R", repo, "--body", `<!-- ${PROBE_MARKER} -->\n## Post-deploy check: pass\n${JSON.stringify({ ...rec, checks: sum })}\n\nRe-run on \`${def}\` at \`${short(defaultSha)}\`.`]);
    return row("pass", `checks ${[...new Set(ids)].join(", ")} passed at ${short(defaultSha)}`, { fix: last.fix });
  }
  const bad = rows.filter((r) => r.result === "fail");
  const parent = deferredFrom(iss.body);
  const title = `Regression: post-deploy check ${bad.map((r) => r.id).join(", ")} failed on ${def}${parent ? ` (fix of #${parent})` : ""}`;
  const body = [
    `<!-- ${REGRESSION_MARKER} -->`, `Post-deploy check ${bad.map((r) => `\`${r.id}\``).join(", ")} passed after the fix and now fails.`, "",
    `- Fix commit: \`${last.fix}\``, `- Last passing release (\`${def}\`): \`${last.defaultSha ?? "unknown"}\``, `- Breaking release (\`${def}\`): \`${defaultSha ?? "unknown"}\``,
    `- Monitored follow-up: #${issue}${parent ? `; parent: #${parent}` : ""}`, "", ...bad.flatMap((r) => [`**${r.id}** (exit ${r.exit ?? "timeout"})`, fenced(r.output), ""]),
  ].join("\n").slice(0, OUTPUT_TAIL * 4);
  const created = String(await io.gh(["issue", "create", "-R", repo, "--title", title, "--body", body]));
  const num = /\/issues\/(\d+)/.exec(created)?.[1] ?? null;
  await finish(`<!-- ${PROBE_MARKER} -->\n## Post-deploy check: fail\n${JSON.stringify({ ...rec, regression: num ? Number(num) : null, checks: sum })}\n\nRegression issue ${num ? `#${num}` : "filed"}; monitoring stops.`);
  return row("fail", `regression ${num ? `#${num}` : "filed"}: ${bad.map((r) => r.id).join(", ")} broke at ${short(defaultSha)} (fix ${short(last.fix)})`, { fix: last.fix, regression: num });
}

/** Re-run every due monitored follow-up of the repo. Sequential; an error is an `error` row, never a throw. */
export async function sweepDue({ repo, cwd = process.cwd(), io, dryRun = false, now = () => Date.now(), config = readProbeConfig(cwd), env = process.env, spawn, onResult = null } = {}) {
  const def = await resolveDefaultBranch({ repo, io, cwd });
  if (!def) throw new Error("no default branch");
  const found = JSON.parse(String(await io.gh(["issue", "list", "-R", repo, "--state", "open", "--label", MONITORING_LABEL, "--limit", "100", "--json", "number"])));
  const list = (Array.isArray(found) ? found : []).map((i) => i.number).filter(Number.isInteger);
  if (!list.length) return [];
  try { await io.git(["fetch", "origin", def], { cwd }); } catch { /* offline: the local ref */ }
  let defaultSha = null;
  try { defaultSha = String(await io.git(["rev-parse", `origin/${def}`], { cwd })).trim() || null; } catch { /* unknown release */ }
  const rows = [];
  for (const issue of list) {
    try { rows.push(await monitorOne({ issue, repo, def, defaultSha, cwd, io, now: now(), dryRun, config, env, spawn })); } catch (e) {
      rows.push({ issue, outcome: "error", detail: String(e?.message ?? e).slice(0, 160) });
    }
    try { if (!dryRun) await onResult?.(rows[rows.length - 1]); } catch { /* an event sink never fails the sweep */ }
  }
  return rows;
}

/** One line, e.g. `monitoring: pass #1; regression #2; closed #3`; "" when nothing is monitored. */
export function formatDueSummary(rows) {
  const g = [["pass", "pass"], ["fail", "regression"], ["window-ended", "window ended"], ["due", "due"], ["not-due", "not due"], ["unrunnable", "unrunnable"], ["error", "error"]];
  const parts = g.map(([k, l]) => [l, (rows ?? []).filter((r) => r.outcome === k).map((r) => `#${r.issue}`)]).filter(([, a]) => a.length).map(([l, a]) => `${l} ${a.join(" ")}`);
  return parts.length ? `monitoring: ${parts.join("; ")}` : "";
}
