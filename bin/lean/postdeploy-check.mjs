// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Named post-deploy checks (#4626). A post-deploy requirement names a check id (`[check:<id>]` in its follow-up item);
 * the command lives in the checks file on the default branch, `.forge/post-deploy-checks.json`:
 *   { "<id>": { "run": "sh command", "pass": "exit 0 | /regex/flags", "timeout": 120 } }   (a bare string is `run`)
 * and is read with `git show origin/<default>:<file>`: reviewed default-branch code, never an issue body or comment
 * (#4468). When the #4389 gate reports a follow-up ready, `measureFollowup` runs every item's check (no model call, the
 * probe runner's minimal env): all pass -> a FORGE:PROBE record and the follow-up closes; a fail -> the record, and the
 * parent reopens with the output. An item without a runnable check is `awaiting-measurement`: no lane, ever.
 */
import { noComments } from "./render.mjs";
import { MAX_TIMEOUT_S, OUTPUT_TAIL, PROBE_MARKER, probeEnv, probeResultOf, readProbeConfig, runProbe } from "./probe.mjs";
import { parseMinAge } from "./prefilter.mjs";

export const CHECKS_FILE = ".forge/post-deploy-checks.json";
export const CHECK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const AWAITING_MEASUREMENT_LABEL = "awaiting-measurement";
export const MONITORING_LABEL = "post-deploy-monitoring";
export const OWNER_ASK_MARKER = "FORGE:OWNER_ASK"; // #4689
export const DEFAULT_EVERY_MS = 6 * 3600e3;
const ITEM_RE = /^\s*[-*]\s+\[[ xX]\]\s+(.*)$/;
const CHECK_TOKEN_RE = /^`[^`]*`\s+(?:\*\*known-flaw\*\*\s+)?[—-]+\s*post-deploy:\s*\[check:\s*([^\]\s]*)\s*\]/;

/**
 * The checks file's runnable entries `{id: {run, pass, timeoutS, forMs?, everyMs?}}`; malformed input or entries are dropped.
 * `for` (a window such as "7d") makes the check windowed (#4627); `every` (default 6h) is its cadence and needs a `for`.
 */
export function parseChecks(text) {
  let j;
  try { j = JSON.parse(String(text ?? "")); } catch { return {}; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return {};
  const out = {};
  for (const [id, v] of Object.entries(j)) {
    const spec = typeof v === "string" ? { run: v } : v;
    if (!CHECK_ID_RE.test(id) || !spec || typeof spec.run !== "string" || !spec.run.trim()) continue;
    let pass = { kind: "exit" };
    const p = String(spec.pass ?? "").trim();
    if (p && !/^exit\s+0$/i.test(p)) {
      const r = /^\/(.+)\/([a-z]*)$/.exec(p);
      try { if (!r) continue; new RegExp(r[1], r[2]); } catch { continue; }
      pass = { kind: "regex", re: r[1], flags: r[2] };
    }
    const t = spec.timeout == null ? null : Number(spec.timeout);
    if (t != null && !(Number.isFinite(t) && t > 0)) continue;
    const win = spec.for == null ? null : parseMinAge(spec.for);
    const cad = spec.every == null ? null : parseMinAge(spec.every);
    if ((spec.for != null && !win) || (spec.every != null && !cad) || (spec.every != null && spec.for == null)) continue;
    out[id] = { run: spec.run.trim(), pass, timeoutS: t == null ? null : Math.min(Math.floor(t) || 1, MAX_TIMEOUT_S), ...(win ? { forMs: win, everyMs: cad ?? DEFAULT_EVERY_MS } : {}) };
  }
  return out;
}

/** Per checklist item of a follow-up body: its `[check:<id>]` id, or null when it names none (or a malformed one). */
export function itemCheckIds(body) {
  return noComments(String(body ?? ""), " ").split("\n").map((l) => ITEM_RE.exec(l)?.[1]).filter((t) => t != null)
    .map((t) => { const m = CHECK_TOKEN_RE.exec(t); return m && CHECK_ID_RE.test(m[1]) ? m[1] : null; });
}

/** The checks file at each git ref (`git show <ref>:<file>`); a missing file or ref contributes nothing. */
export async function checksAt(git, refs, cwd) {
  const out = {};
  for (const ref of refs) {
    try { Object.assign(out, parseChecks(String(await git(["show", `${ref}:${CHECKS_FILE}`], { cwd })))); } catch { /* no file at this ref */ }
  }
  return out;
}

const fenced = (s) => { const f = "`".repeat(Math.max(3, ...[...String(s).matchAll(/`+/g)].map((m) => m[0].length + 1))); return `${f}\n${String(s).trim() || "(no output)"}\n${f}`; };

/** Run each distinct check id with the probe runner (minimal env, timeout, masked output): `[{id, result, exit, ms, output}]`. */
export async function runNamedChecks({ ids, checks, cwd, config, env, spawn }) {
  const rows = [];
  for (const id of [...new Set(ids)]) {
    const r = await runProbe(checks[id], { cwd, env: probeEnv(config.env, env), mask: config.env.map((k) => env[k]), timeoutS: config.timeoutS, ...(spawn ? { spawn } : {}) });
    rows.push({ id, ...r });
  }
  return rows;
}

/** The windowed-monitoring fields of a FORGE:PROBE record body (`at`, `window_until`, `every_ms`, `regression`, ...), or null. */
export function monitorRecord(body) {
  const base = probeResultOf(body);
  if (!base) return null;
  const line = String(body).split("\n").find((l) => /^\s*`?\{.*"result"/.test(l));
  try {
    const j = JSON.parse(line.trim().replace(/^`|`$/g, ""));
    const at = Date.parse(j.at), until = Date.parse(j.window_until);
    return Number.isFinite(at) ? { ...base, at, defaultSha: j.default_sha ?? null, everyMs: Number(j.every_ms) || DEFAULT_EVERY_MS, until: Number.isFinite(until) ? until : null, regression: j.regression ?? null } : null;
  } catch { return null; }
}

/** The post-deploy-monitoring label, created on first use; best effort. */
export async function addMonitoringLabel({ io, repo, issue }) {
  const edit = () => io.gh(["issue", "edit", String(issue), "-R", repo, "--add-label", MONITORING_LABEL]);
  try { await edit(); } catch {
    try { await io.gh(["label", "create", MONITORING_LABEL, "-R", repo, "--force", "--color", "C5DEF5", "--description", "Post-deploy follow-up whose windowed check re-runs on later releases. Managed by ForgeDock."]); await edit(); } catch { /* the record still shows it */ }
  }
}

/** #4689: tick every unticked post-deploy checklist item of a follow-up body (the evidence is in the FORGE:PROBE comment). */
export const tickItems = (body) => String(body ?? "").replace(/^(\s*[-*]\s+)\[ \](\s+`[^`]*`\s+(?:\*\*known-flaw\*\*\s+)?[—-]+\s*post-deploy:)/gm, "$1[x]$2");

/** #4689: one typed `FORGE:OWNER_ASK` comment for the items with no runnable check, posted once; best effort, nothing in a dry run. */
async function postOwnerAsk({ iss, repo, io, dryRun, isTrusted, ids, missing, def }) {
  if (dryRun || (iss.comments ?? []).some((c) => isTrusted(c) && String(c?.body ?? "").includes(OWNER_ASK_MARKER))) return;
  const what = ids.length ? missing.map((m) => (m ? `add \`${m}\` to ${CHECKS_FILE} on ${def}` : "name an item's check with `[check:<id>]`")).join("; ") : "name each item's check with `[check:<id>]` and add it to the checks file";
  try { await io.gh(["issue", "comment", String(iss.number), "-R", repo, "--body", `<!-- ${OWNER_ASK_MARKER} -->\n## Owner ask\nNo lane was started and none will be. Needed from the owner: ${what}, or measure the item by hand.`]); } catch { /* the label still shows it */ }
}

/** #4689: one engineering issue per failing check (never a lane): the output, the fix and the follow-up. Best effort. */
async function fileFailureIssues({ bad, iss, repo, io, parent, def, fix }) {
  for (const r of bad) {
    const title = `Post-deploy check ${r.id} fails on ${def}${parent ? ` (fix of #${parent})` : ""}`;
    const body = `Post-deploy check \`${r.id}\` failed (exit ${r.exit ?? "timeout"}) for fix \`${fix.slice(0, 12)}\` on \`${def}\`. Follow-up: #${iss.number}.\n\n${fenced(r.output)}`.slice(0, OUTPUT_TAIL * 2);
    const create = (extra) => io.gh(["issue", "create", "-R", repo, "--title", title, "--body", body, ...extra]);
    try { await create(["--label", "followup:engineering"]); } catch { try { await create([]); } catch { /* the follow-up comment carries the output */ } }
  }
}

/**
 * Measure a ready post-deploy follow-up. Never runs a command that is not in the default branch's checks file.
 * @returns {Promise<{state:"awaiting-measurement"|"pass"|"fail"|"recorded-fail"|"dry-run"|"monitoring", detail:string}>}
 * When every item's check declares a window (#4627) a pass records the release and the window end and the follow-up stays
 * open (`monitoring`); `sweepDue` (postdeploy-monitor.mjs) re-runs it.
 */
export async function measureFollowup({ iss, repo, parent, def, shas = [], cwd, io, dryRun = false, isTrusted = () => false, config = readProbeConfig(cwd), env = process.env, spawn, now = () => Date.now() }) {
  const ids = itemCheckIds(iss.body);
  const checks = await checksAt(io.git, [`origin/${def}`], cwd);
  const missing = ids.filter((id) => !id || !checks[id]);
  if (!ids.length || missing.length) {
    await postOwnerAsk({ iss, repo, io, dryRun, isTrusted, ids, missing, def });
    return { state: "awaiting-measurement", detail: `no runnable check on ${def} for ${ids.length ? `${missing.map((m) => m ?? "an item without a check id").join(", ")}` : "any item"} (${CHECKS_FILE})` };
  }
  const fix = [...shas].sort().join(",");
  const prior = (iss.comments ?? []).filter((c) => isTrusted(c)).map((c) => probeResultOf(c?.body)).filter(Boolean).reverse().find((p) => p.fix === fix);
  if (prior?.result === "fail") return { state: "recorded-fail", detail: `check failed for ${fix.slice(0, 12)} (FORGE:PROBE); waiting for a new fix of #${parent}` };
  const windowed = ids.every((id) => checks[id].forMs);
  const monitored = (iss.comments ?? []).filter((c) => isTrusted(c)).map((c) => monitorRecord(c?.body)).filter(Boolean).find((p) => p.fix === fix && p.result === "pass" && p.until);
  if (windowed && monitored) return { state: "monitoring", detail: `windowed checks ${[...new Set(ids)].join(", ")} monitored until ${new Date(monitored.until).toISOString()}` };
  if (dryRun) return { state: "dry-run", detail: `checks ${[...new Set(ids)].join(", ")} not run (dry run)` };
  let defaultSha = null;
  try { defaultSha = String(await io.git(["rev-parse", `origin/${def}`], { cwd })).trim() || null; } catch { /* recorded as null */ }
  const rows = [];
  if (prior?.result !== "pass") {
    rows.push(...await runNamedChecks({ ids, checks, cwd, config, env, spawn }));
    const ok = rows.every((r) => r.result === "pass");
    const at = now();
    const win = windowed && ok ? { at: new Date(at).toISOString(), window_until: new Date(at + Math.max(...ids.map((id) => checks[id].forMs))).toISOString(), every_ms: Math.min(...ids.map((id) => checks[id].everyMs)) } : {};
    const body = [
      `<!-- ${PROBE_MARKER} -->`, `## Post-deploy check: ${ok ? "pass" : "fail"}`,
      JSON.stringify({ fix, default_sha: defaultSha, result: ok ? "pass" : "fail", ...win, checks: rows.map((r) => ({ id: r.id, result: r.result, exit: r.exit, ms: r.ms })) }), "",
      `Ran after the fix of #${parent} reached \`${def}\`; commands come from \`${CHECKS_FILE}\` on \`${def}\`.${ok ? (win.at ? ` Monitored until \`${win.window_until}\`, re-run on later releases.` : " The follow-up is closed.") : " The parent is reopened."}`,
      ...rows.filter((r) => r.result === "fail").flatMap((r) => ["", `**${r.id}** (exit ${r.exit ?? "timeout"})`, fenced(r.output)]),
    ].join("\n").slice(0, OUTPUT_TAIL * 4);
    await io.gh(["issue", "comment", String(iss.number), "-R", repo, "--body", body]);
    if (ok && tickItems(iss.body) !== iss.body) { try { await io.gh(["issue", "edit", String(iss.number), "-R", repo, "--body", tickItems(iss.body)]); } catch { /* the PROBE record is the evidence */ } }
    if (!ok) {
      const bad = rows.filter((r) => r.result === "fail");
      await fileFailureIssues({ bad, iss, repo, io, parent, def, fix });
      let note = "";
      try { await io.gh(["issue", "reopen", String(parent), "-R", repo]); } catch (e) { note = ` (reopen failed: ${String(e?.message ?? e).slice(0, 120)})`; }
      try {
        await io.gh(["issue", "comment", String(parent), "-R", repo, "--body", `Post-deploy check ${bad.map((r) => `\`${r.id}\``).join(", ")} failed for the fix on \`${def}\` (follow-up #${iss.number}); reopened.\n\n${bad.map((r) => fenced(r.output)).join("\n\n")}`.slice(0, OUTPUT_TAIL * 4)]);
      } catch { /* the follow-up comment carries the output */ }
      return { state: "fail", detail: `check ${bad.map((r) => r.id).join(", ")} failed; #${parent} reopened${note}` };
    }
  }
  if (windowed) {
    await addMonitoringLabel({ io, repo, issue: iss.number });
    return { state: "monitoring", detail: `checks ${[...new Set(ids)].join(", ")} passed; monitored on later releases` };
  }
  await io.gh(["issue", "close", String(iss.number), "-R", repo, "--reason", "completed"]);
  return { state: "pass", detail: `checks ${[...new Set(ids)].join(", ")} passed` };
}
