// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pre-PR declared check commands (#4240), one round (#4331): the commands run concurrently up to the host worker cap,
 * each timed, inside one total budget. #4344: the worker cap is shared, not multiplied (k running commands get
 * max(1, floor(N / k)) workers each), and `acquire` takes one heavy-step slot per running command. A command that never
 * started before the budget ran out, or that the budget cut short, is left to CI (`deferred-to-ci`), never a failure.
 * Repo-agnostic: commands are opaque `bash -c` strings run through the injected `run`.
 * #4364: `planPrecheck` is the one selection and budget rule shared by the engine's pre-PR round and `forgedock check`,
 * which the builder runs in-session (`selfCheck`); `worktreeFingerprint` tells whether that run saw the final tree.
 */
import { createHash } from "node:crypto";
import { scopeChecks, selectCommands } from "./testmap.mjs";
import { LOG_CAP } from "./verify.mjs";

/** #4364: the engine's check plan for `forgedock check` (written beside contract.json) and the CLI's last run record. */
export const CHECK_PLAN_FILE = ".forge-lean/check-plan.json";
export const SELF_CHECK_FILE = ".forge-lean/self-check.json";
/** #4390: full output of each failing check command (`forgedock check`, the engine's precheck round). */
export const CHECK_LOG_DIR = ".forge-lean/logs";

/** rc of a command killed by its timeout (effects.mjs runCheckCommand). */
const TIMEOUT_RC = 124;

/**
 * @param {{commands:string[], parallelism?:number, budgetMs:number, perCommandMs:number, now?:() => number,
 *   acquire?:() => Promise<{release?:Function}|null>,
 *   run:(a:{command:string, timeoutMs:number, workers:number}) => Promise<{rc:number, output?:string}>}} p
 *   acquire: awaited per command before its timeout is computed (the wait counts against the budget); a throw runs ungated
 * @returns {Promise<{results:{command:string, rc:number, output:string, ms:number}[], deferred:string[], ms:number}>}
 *   results in input order (commands that ran and were not cut by the budget); deferred in input order
 */
export async function runChecks({ commands, parallelism = 1, budgetMs, perCommandMs, now = () => Date.now(), acquire, run }) {
  const list = Array.isArray(commands) ? commands : [];
  const workers = Math.max(1, Math.floor(Number(parallelism)) || 1);
  const k = Math.max(1, Math.min(workers, list.length)), share = Math.max(1, Math.floor(workers / k));
  const start = now(), deadline = start + (Number(budgetMs) > 0 ? Number(budgetMs) : 0);
  const per = Number(perCommandMs) > 0 ? Number(perCommandMs) : Infinity;
  const slots = new Array(list.length).fill(null);
  let next = 0;
  /** One command, once its slot (if any) is held: the slot wait counts against the budget. */
  async function runOne(command) {
    const left = deadline - now();
    if (left <= 0) return { deferred: true };
    const timeoutMs = Math.min(per, left), t = now();
    let r;
    try { r = await run({ command, timeoutMs, workers: share }); } catch (e) { r = { rc: 127, output: String(e?.message ?? e) }; }
    const rc = Number.isInteger(r?.rc) ? r.rc : 1;
    // the budget, not the command's own timeout, cut it short: CI runs it
    if (rc === TIMEOUT_RC && timeoutMs < per) return { deferred: true };
    return { command, rc, output: String(r?.output ?? ""), ms: Math.max(0, now() - t) };
  }
  async function worker() {
    while (next < list.length) {
      const i = next++, command = list[i];
      if (deadline - now() <= 0) { slots[i] = { deferred: true }; continue; }
      let g = null;
      try { g = acquire ? await acquire() : null; } catch { g = null; }
      try { slots[i] = await runOne(command); } finally { try { g?.release?.(); } catch { /* fail-open */ } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, list.length) }, worker));
  const results = [], deferred = [];
  slots.forEach((s, i) => { if (s?.deferred) deferred.push(list[i]); else if (s) results.push(s); });
  return { results, deferred, ms: Math.max(0, now() - start) };
}

/**
 * #4331 batch-report line: pre-PR check wall time summed over the rows' `precheck_ms`, and the commands deferred to CI
 * (`precheck_deferred`). Null when no lane ran pre-PR checks.
 */
export function formatPrecheckSummary(rows) {
  const ran = (rows ?? []).filter((r) => Number.isFinite(r?.precheck_ms) && r.precheck_ms >= 0);
  if (!ran.length) return null;
  const ms = ran.reduce((a, r) => a + r.precheck_ms, 0);
  const deferred = ran.reduce((a, r) => a + (Number.isInteger(r.precheck_deferred) ? r.precheck_deferred : 0), 0);
  return `precheck: ${(ms / 60000).toFixed(1)}m total over ${ran.length} lane${ran.length === 1 ? "" : "s"}${deferred ? `, ${deferred} deferred to CI` : ""}`;
}

/**
 * #4364: the pre-PR commands and budget for a round: `scopeChecks` over the trimmed learned commands (a mapped learned
 * command runs only when its globs match a changed file); budget lean.precheck.max_minutes, else
 * verify.precheck_total_seconds (default 600 s); per command verify.precheck_timeout_seconds.
 * @returns {{commands:string[], source:string, added:number, dropped:string[], selected:number, budgetMs:number, perCommandMs:number}}
 */
export function planPrecheck({ testMap = null, files = [], learned = [], maxMinutes, verify = {} }) {
  const list = (Array.isArray(learned) ? learned : []).map((c) => String(c ?? "").trim()).filter(Boolean);
  const m = scopeChecks(testMap, files, list);
  const max = Number(maxMinutes);
  const budgetMs = (max > 0 ? max * 60 : Number(verify.precheckTotalSeconds) || 600) * 1000;
  return { ...m, selected: testMap ? selectCommands(testMap, files).length : 0, budgetMs, perCommandMs: (Number(verify.precheckTimeoutSeconds) || 300) * 1000 };
}

const lines = (out) => String(out ?? "").split("\n").map((x) => x.trim()).filter(Boolean);

/**
 * #4364: content fingerprint of the worktree against merge-base(base, HEAD): sha256 over the sorted (path, blob sha or
 * "deleted") pairs of every tracked path that differs (committed, staged or not) plus untracked non-ignored files,
 * `.forge-lean/` excluded. Committing after a check leaves it unchanged; any edit changes it.
 * @param {{git:(args:string[]) => Promise<string>, base:string}} p
 */
export async function worktreeFingerprint({ git, base }) {
  const mb = String(await git(["merge-base", base, "HEAD"])).trim();
  const keep = (f) => !f.startsWith(".forge-lean/");
  const deleted = new Set(lines(await git(["diff", "--name-only", "--diff-filter=D", mb])).filter(keep));
  const paths = [...new Set([...lines(await git(["diff", "--name-only", mb])), ...lines(await git(["ls-files", "-o", "--exclude-standard"]))])].filter(keep).sort();
  const live = paths.filter((f) => !deleted.has(f)), blobs = new Map();
  for (let i = 0; i < live.length; i += 200) {
    const part = live.slice(i, i + 200), shas = lines(await git(["hash-object", "--", ...part]));
    part.forEach((f, j) => blobs.set(f, shas[j] ?? ""));
  }
  return createHash("sha256").update(paths.map((f) => `${f}\0${blobs.get(f) ?? "deleted"}`).join("\n")).digest("hex");
}

/** #4364: 'skipped' (no record), 'stale' (another tree), 'red' (this tree, failing) or 'green' (this tree, passing). */
export function selfCheckState(record, fingerprint) {
  if (!record || typeof record !== "object" || !record.fingerprint) return "skipped";
  if (record.fingerprint !== fingerprint) return "stale";
  return record.ok === true ? "green" : "red";
}

/**
 * #4364 `forgedock check`: the contract's validate commands (reported `ci`, not run, in verify.mode ci, as the engine
 * accepts them on a CI-verified head), then the planned pre-PR commands under the plan's budget, both through
 * `runChecks` with the same worker cap. No heavy slot is taken here: the heavy shims on the builder's PATH gate the
 * heavy binaries. ok = every command that ran exited 0 (deferred and `ci` are not failures, as in the engine).
 * @param {{contract:object, plan:{mode?:string, commands:string[], budgetMs:number, perCommandMs:number}, parallelism?:number, now?:() => number, run:Function}} p
 */
export async function selfCheck({ contract, plan, parallelism = 1, now = () => Date.now(), run }) {
  const vals = (Array.isArray(contract?.validate) ? contract.validate : []).filter((v) => v && String(v.command ?? "").trim());
  const ci = plan?.mode === "ci", per = Number(plan?.perCommandMs) > 0 ? Number(plan.perCommandMs) : 300000;
  const validate = [];
  if (ci) for (const v of vals) validate.push({ id: v.id, command: String(v.command), status: "ci" });
  else if (vals.length) {
    const cmds = vals.map((v) => String(v.command));
    // as the engine's validate rerun: each command its own timeout, no round budget
    const r = await runChecks({ commands: cmds, parallelism, budgetMs: Infinity, perCommandMs: per, now, run });
    const byCmd = new Map(r.results.map((x) => [x.command, x]));
    for (const v of vals) { const x = byCmd.get(String(v.command)); validate.push(x ? { id: v.id, ...x } : { id: v.id, command: String(v.command), status: "deferred-to-ci" }); }
  }
  const pre = await runChecks({ commands: plan?.commands ?? [], parallelism, budgetMs: plan?.budgetMs ?? 0, perCommandMs: per, now, run });
  const commands = [...pre.results];
  const ok = [...validate, ...commands].every((x) => x.status || x.rc === 0);
  return { ok, validate, commands, deferred: pre.deferred };
}

/** #4390: summary lines naming a failing test, as common runners print them (pytest, TAP/node --test, jest/vitest, go, cargo). */
const FAIL_ID_RE = /^\s*(?:FAILED |ERROR |not ok \d|FAIL |[✕×✗] |--- FAIL: |test \S.* \.\.\. FAILED)/;
export const QUIET_TAIL_LINES = 40;

/**
 * #4390 quiet-output contract: one failure as its last `lines` lines (at most `maxChars`, cut marked with `…`), the
 * failing-test-id lines found anywhere in the output (deduped, at most `maxIds`) and, when given, the full log's path.
 */
export function quietFailure(output, { lines = QUIET_TAIL_LINES, maxChars = Infinity, logPath = null, maxIds = 30 } = {}) {
  const all = String(output ?? "").split("\n");
  while (all.length && !all[all.length - 1].trim()) all.pop();
  const from = Math.max(0, all.length - lines);
  let tail = all.slice(from).join("\n");
  const cut = from > 0 || tail.length > maxChars;
  if (tail.length > maxChars) tail = tail.slice(-maxChars);
  const ids = [...new Set(all.filter((l) => FAIL_ID_RE.test(l)).map((l) => l.trim().slice(0, 300)))];
  const out = [tail ? `${cut ? "…" : ""}${tail}` : "(no output)"];
  if (ids.length) out.push(`failing tests:\n${ids.slice(0, maxIds).map((l) => `  ${l}`).join("\n")}${ids.length > maxIds ? `\n  … and ${ids.length - maxIds} more` : ""}`);
  if (logPath) out.push(`full log: ${logPath}`);
  return out.join("\n");
}

/** #4364: the compact pass/fail table `forgedock check` prints; #4390: each failure quiet (`quietFailure`), within `cap` chars. */
export function formatCheckTable(r, cap = LOG_CAP) {
  const word = (x) => (x.status === "ci" ? "CI" : x.status ? "DEFERRED" : x.rc === 0 ? "PASS" : `FAIL exit ${x.rc}`);
  const rows = [...(r.validate ?? []).map((x) => ({ ...x, label: `${x.id} ${x.command}` })), ...(r.commands ?? []).map((x) => ({ ...x, label: x.command })),
    ...(r.deferred ?? []).map((c) => ({ command: c, label: c, status: "deferred-to-ci" }))];
  const out = rows.map((x) => `${word(x).padEnd(12)} ${Number.isFinite(x.ms) ? `${(x.ms / 1000).toFixed(1)}s`.padStart(7) : "".padStart(7)}  ${x.label}`);
  const failed = rows.filter((x) => !x.status && x.rc !== 0);
  const per = Math.max(500, Math.floor(cap / Math.max(1, failed.length))); // verify.mjs capLogs share
  for (const f of failed) out.push("", `--- ${f.label} (exit ${f.rc})`, quietFailure(f.output, { maxChars: per, logPath: f.logPath ?? null }));
  out.push("", r.ok ? "check: PASS" : `check: FAIL (${failed.length} failing)`);
  return out.join("\n");
}
