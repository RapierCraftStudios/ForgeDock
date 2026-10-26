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

export const CHECKS_FILE = ".forge/post-deploy-checks.json";
export const CHECK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const AWAITING_MEASUREMENT_LABEL = "awaiting-measurement";
const ITEM_RE = /^\s*[-*]\s+\[[ xX]\]\s+(.*)$/;
const CHECK_TOKEN_RE = /^`[^`]*`\s+(?:\*\*known-flaw\*\*\s+)?[—-]+\s*post-deploy:\s*\[check:\s*([^\]\s]*)\s*\]/;

/** The checks file's runnable entries `{id: {run, pass, timeoutS}}`; malformed input or entries are dropped. */
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
    out[id] = { run: spec.run.trim(), pass, timeoutS: t == null ? null : Math.min(Math.floor(t) || 1, MAX_TIMEOUT_S) };
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

/**
 * Measure a ready post-deploy follow-up. Never runs a command that is not in the default branch's checks file.
 * @returns {Promise<{state:"awaiting-measurement"|"pass"|"fail"|"recorded-fail"|"dry-run", detail:string}>}
 */
export async function measureFollowup({ iss, repo, parent, def, shas = [], cwd, io, dryRun = false, isTrusted = () => false, config = readProbeConfig(cwd), env = process.env, spawn }) {
  const ids = itemCheckIds(iss.body);
  const checks = await checksAt(io.git, [`origin/${def}`], cwd);
  const missing = ids.filter((id) => !id || !checks[id]);
  if (!ids.length || missing.length) return { state: "awaiting-measurement", detail: `no runnable check on ${def} for ${ids.length ? `${missing.map((m) => m ?? "an item without a check id").join(", ")}` : "any item"} (${CHECKS_FILE})` };
  const fix = [...shas].sort().join(",");
  const prior = (iss.comments ?? []).filter((c) => isTrusted(c)).map((c) => probeResultOf(c?.body)).filter(Boolean).reverse().find((p) => p.fix === fix);
  if (prior?.result === "fail") return { state: "recorded-fail", detail: `check failed for ${fix.slice(0, 12)} (FORGE:PROBE); waiting for a new fix of #${parent}` };
  if (dryRun) return { state: "dry-run", detail: `checks ${[...new Set(ids)].join(", ")} not run (dry run)` };
  let defaultSha = null;
  try { defaultSha = String(await io.git(["rev-parse", `origin/${def}`], { cwd })).trim() || null; } catch { /* recorded as null */ }
  const rows = [];
  if (prior?.result !== "pass") {
    for (const id of [...new Set(ids)]) {
      const c = checks[id];
      const r = await runProbe(c, { cwd, env: probeEnv(config.env, env), mask: config.env.map((k) => env[k]), timeoutS: config.timeoutS, ...(spawn ? { spawn } : {}) });
      rows.push({ id, ...r });
    }
    const ok = rows.every((r) => r.result === "pass");
    const body = [
      `<!-- ${PROBE_MARKER} -->`, `## Post-deploy check: ${ok ? "pass" : "fail"}`,
      JSON.stringify({ fix, default_sha: defaultSha, result: ok ? "pass" : "fail", checks: rows.map((r) => ({ id: r.id, result: r.result, exit: r.exit, ms: r.ms })) }), "",
      `Ran after the fix of #${parent} reached \`${def}\`; commands come from \`${CHECKS_FILE}\` on \`${def}\`.${ok ? " The follow-up is closed." : " The parent is reopened."}`,
      ...rows.filter((r) => r.result === "fail").flatMap((r) => ["", `**${r.id}** (exit ${r.exit ?? "timeout"})`, fenced(r.output)]),
    ].join("\n").slice(0, OUTPUT_TAIL * 4);
    await io.gh(["issue", "comment", String(iss.number), "-R", repo, "--body", body]);
    if (!ok) {
      const bad = rows.filter((r) => r.result === "fail");
      let note = "";
      try { await io.gh(["issue", "reopen", String(parent), "-R", repo]); } catch (e) { note = ` (reopen failed: ${String(e?.message ?? e).slice(0, 120)})`; }
      try {
        await io.gh(["issue", "comment", String(parent), "-R", repo, "--body", `Post-deploy check ${bad.map((r) => `\`${r.id}\``).join(", ")} failed for the fix on \`${def}\` (follow-up #${iss.number}); reopened.\n\n${bad.map((r) => fenced(r.output)).join("\n\n")}`.slice(0, OUTPUT_TAIL * 4)]);
      } catch { /* the follow-up comment carries the output */ }
      return { state: "fail", detail: `check ${bad.map((r) => r.id).join(", ")} failed; #${parent} reopened${note}` };
    }
  }
  await io.gh(["issue", "close", String(iss.number), "-R", repo, "--reason", "completed"]);
  return { state: "pass", detail: `checks ${[...new Set(ids)].join(", ")} passed` };
}
