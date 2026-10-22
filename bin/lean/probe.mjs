// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Outcome-based acceptance (#4399): an issue may declare an acceptance probe, a command plus its pass condition. Once the
 * issue's fix is on the default (production) branch, the probe runs deterministically (no model call, no lane), the
 * result is recorded on the issue as a `FORGE:PROBE` comment, and a fail reopens the issue with the output attached.
 *
 * Declaration: a fenced block in the issue body (author trusted) or in a trusted comment (the latest one wins):
 *   ```forge-probe
 *   run: curl -fsS https://example.com/health
 *   pass: exit 0            # default; or `pass: /regex/flags` matched against stdout
 *   timeout: 120            # seconds, capped at 900
 *   ```
 * Only trusted actors' commands run (`isTrustedActor`/`isTrustedComment`, fail closed). The fix commit is the latest
 * trusted FORGE:TRAJECTORY `merged at <sha>`, else the merge commit of the latest merged PR that closes the issue; it is
 * promoted when `git merge-base --is-ancestor <fix> origin/<default>` holds. A recorded result is never re-run for the
 * same fix. The probe gets a minimal env (PATH, HOME, LANG, TMPDIR) plus forge.yaml `acceptance_probe.env` (the repo's
 * designated test identity); those values are masked in the posted output.
 * Triggers: `forgedock probe [issue...]` and a sweep at the start of every `forgedock orchestrate` batch (`--no-probes`).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseForgeYaml } from "../forge-utils.mjs";
import { isTrustedActor, isTrustedComment } from "../engine/phases.mjs";
import { noComments } from "./render.mjs";

export const PROBE_MARKER = "FORGE:PROBE";
export const DEFAULT_TIMEOUT_S = 120;
export const MAX_TIMEOUT_S = 900;
export const OUTPUT_TAIL = 4000;
const BASE_ENV = ["PATH", "HOME", "LANG", "TMPDIR"];

const BLOCK_RE = /^[ \t]*```+[ \t]*forge-probe[ \t]*\n([\s\S]*?)^[ \t]*```+[ \t]*$/gm;
const isForgeMarker = (body) => /^\s*<!--\s*FORGE:/.test(String(body ?? ""));

/** The last ```forge-probe block of `text`: {run, pass, timeoutS}, or null when absent or malformed. */
export function parseProbe(text) {
  const blocks = [...noComments(String(text ?? ""), " ").matchAll(BLOCK_RE)];
  if (!blocks.length) return null;
  const fields = {};
  for (const line of blocks[blocks.length - 1][1].split("\n")) {
    const m = /^\s*(run|pass|timeout)\s*:\s*(.*?)\s*$/i.exec(line);
    if (m && !(m[1].toLowerCase() in fields)) fields[m[1].toLowerCase()] = m[2];
  }
  if (!fields.run) return null;
  let pass = { kind: "exit" };
  const p = (fields.pass ?? "").replace(/\s+#.*$/, "");
  if (p && !/^exit\s+0$/i.test(p)) {
    const r = /^\/(.+)\/([a-z]*)$/.exec(p);
    if (!r) return null;
    try { new RegExp(r[1], r[2]); } catch { return null; }
    pass = { kind: "regex", re: r[1], flags: r[2] };
  }
  let timeoutS = null;
  if (fields.timeout) {
    const t = parseInt(fields.timeout, 10);
    if (!Number.isFinite(t) || t <= 0) return null;
    timeoutS = Math.min(t, MAX_TIMEOUT_S);
  }
  return { run: fields.run, pass, timeoutS };
}

/** REST issue/comment author fields as the trust predicate reads them. */
const actorOf = (o) => ({ association: o?.author_association, type: o?.user?.type, login: o?.user?.login });

/**
 * The probe the issue declares: the latest trusted comment's block, else the body's when its author is trusted.
 * {probe, source} | {untrusted: true} (a block exists but only from untrusted actors) | null.
 */
export function declaredProbe(iss) {
  let untrusted = false;
  for (const c of [...(iss?.comments ?? [])].reverse()) {
    if (isForgeMarker(c?.body)) continue; // the engine's own comments (a FORGE:PROBE output tail) never declare a probe
    const probe = parseProbe(c?.body);
    if (!probe) continue;
    if (isTrustedComment(c)) return { probe, source: "comment" };
    untrusted = true;
  }
  const probe = parseProbe(iss?.body);
  if (probe) {
    if (isTrustedActor(actorOf(iss))) return { probe, source: "body" };
    untrusted = true;
  }
  return untrusted ? { untrusted: true } : null;
}

/** {fix, result} of a FORGE:PROBE comment body, or null. */
export function probeResultOf(body) {
  const s = String(body ?? "");
  if (!s.trimStart().startsWith(`<!-- ${PROBE_MARKER} -->`)) return null;
  const line = s.split("\n").find((l) => /^\s*`?\{.*"result"/.test(l));
  if (!line) return null;
  try {
    const j = JSON.parse(line.trim().replace(/^`|`$/g, ""));
    return j && (j.result === "pass" || j.result === "fail") ? { fix: String(j.fix ?? ""), result: j.result } : null;
  } catch { return null; }
}

const sameSha = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
const closesRe = (n) => new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b:?\\s+(?:[\\w.-]+/[\\w.-]+)?#${n}(?!\\d)`, "i");

/** The fix commit: latest trusted FORGE:TRAJECTORY `merged at <sha>`, else the latest merged PR closing #N's merge commit. */
export async function fixSha(iss, io, repo) {
  for (const c of [...(iss?.comments ?? [])].reverse()) {
    if (!String(c?.body ?? "").includes("FORGE:TRAJECTORY") || !isTrustedComment(c)) continue;
    const m = /merged at ([0-9a-f]{7,40})\b/.exec(c.body);
    if (m) return m[1];
  }
  try {
    const prs = JSON.parse(String(await io.gh(["pr", "list", "-R", repo, "--state", "merged", "--search", `#${iss.number}`, "--json", "number,title,body,mergeCommit,mergedAt", "--limit", "20"])));
    const hit = (Array.isArray(prs) ? prs : []).filter((p) => p?.mergeCommit?.oid && closesRe(iss.number).test(`${p.title ?? ""}\n${p.body ?? ""}`))
      .sort((a, b) => String(b.mergedAt ?? "").localeCompare(String(a.mergedAt ?? "")))[0];
    return hit?.mergeCommit?.oid ?? null;
  } catch { return null; }
}

/** True when `sha` is an ancestor of origin/<defaultBranch>; any git failure (unknown object) is false. */
export async function onDefault({ sha, defaultBranch, io, cwd }) {
  try { await io.git(["merge-base", "--is-ancestor", sha, `origin/${defaultBranch}`], { cwd }); return true; } catch { return false; }
}

/** forge.yaml `acceptance_probe`: {env: [names], timeoutS, sweepDays, enabled}. */
export function readProbeConfig(cwd = process.cwd()) {
  let c = {};
  try { c = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.acceptance_probe ?? {}; } catch { c = {}; }
  if (typeof c !== "object" || !c) c = {};
  const list = Array.isArray(c.env) ? c.env : String(c.env ?? "").replace(/^\[|\]$/g, "").split(/[\s,]+/);
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    env: list.map((s) => String(s).trim().replace(/^["']|["']$/g, "")).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)),
    timeoutS: Math.min(num(c.timeout_s, DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S),
    sweepDays: num(c.sweep_days, 30),
    enabled: !/^(false|no|off|0)$/i.test(String(c.enabled ?? "true").trim()),
  };
}

/** The probe's environment: the base names plus the allowlisted test identity, nothing else. */
export function probeEnv(allow = [], env = process.env) {
  return Object.fromEntries([...BASE_ENV, ...allow].filter((k) => typeof env[k] === "string").map((k) => [k, env[k]]));
}

/** Run `sh -c <run>` in its own process group; a timeout kills the group. Resolves {code, stdout, stderr, timedOut}. */
export function spawnProbe({ run, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", timedOut = false;
    const child = nodeSpawn("sh", ["-c", run], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const cap = (s, d) => (s + d).slice(-OUTPUT_TAIL * 4);
    child.stdout.on("data", (d) => { stdout = cap(stdout, d); });
    child.stderr.on("data", (d) => { stderr = cap(stderr, d); });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: `${stderr}${e.message}`, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr, timedOut }); });
  });
}

/** Run a probe: {result: pass|fail, exit, ms, output}. The output tail masks the allowlisted env values. */
export async function runProbe(probe, { cwd, env = {}, mask = [], timeoutS = DEFAULT_TIMEOUT_S, spawn = spawnProbe, now = () => Date.now() } = {}) {
  const t0 = now();
  const r = await spawn({ run: probe.run, cwd, env, timeoutMs: (probe.timeoutS ?? timeoutS) * 1000 });
  const ms = now() - t0;
  let ok = !r.timedOut && r.code === 0;
  if (!r.timedOut && probe.pass?.kind === "regex") ok = new RegExp(probe.pass.re, probe.pass.flags).test(String(r.stdout ?? ""));
  let output = `${r.stdout ?? ""}${r.stderr ? `\n${r.stderr}` : ""}${r.timedOut ? `\n[timed out after ${probe.timeoutS ?? timeoutS}s]` : ""}`;
  for (const v of mask) if (typeof v === "string" && v.length >= 4) output = output.split(v).join("***");
  return { result: ok ? "pass" : "fail", exit: r.timedOut ? null : r.code, ms, output: output.slice(-OUTPUT_TAIL) };
}

/** The FORGE:PROBE comment. */
export function renderProbeComment({ probe, fix, defaultBranch, defaultSha, r }) {
  const fence = "`".repeat(Math.max(3, ...[...String(r.output).matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const pass = probe.pass?.kind === "regex" ? `stdout matches \`/${probe.pass.re}/${probe.pass.flags}\`` : "exit 0";
  return [
    `<!-- ${PROBE_MARKER} -->`,
    `## Acceptance probe: ${r.result}`,
    JSON.stringify({ fix, default_sha: defaultSha, result: r.result, exit: r.exit, ms: r.ms }),
    "",
    `Ran after the fix \`${String(fix).slice(0, 12)}\` reached \`${defaultBranch}\`. Pass condition: ${pass}.${r.result === "fail" ? " The issue is reopened." : ""}`,
    "",
    fence, r.output.trim() || "(no output)", fence,
  ].join("\n");
}

/** Read the issue (REST, for author_association) and its comments. */
async function readIssue(issue, repo, io) {
  const iss = JSON.parse(String(await io.gh(["api", `repos/${repo}/issues/${issue}`])));
  const raw = String(await io.gh(["api", `repos/${repo}/issues/${issue}/comments`, "--paginate", "--jq", ".[]"]));
  const comments = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  return { ...iss, number: issue, comments };
}

/**
 * Probe one issue. Outcomes: no-probe | untrusted | unresolved | already-recorded | awaiting-promotion | pass | fail.
 * Writes (comment, reopen) only for pass/fail and never with `dryRun`.
 */
export async function probeIssue({ issue, repo, cwd = process.cwd(), io, defaultBranch, dryRun = false, config = readProbeConfig(cwd), env = process.env, spawn }) {
  const row = (outcome, detail = "", extra = {}) => ({ issue, outcome, detail, ...extra });
  const iss = await readIssue(issue, repo, io);
  const d = declaredProbe(iss);
  if (!d) return row("no-probe");
  if (d.untrusted) return row("untrusted", "forge-probe declared only by untrusted actors; not run");
  const fix = await fixSha(iss, io, repo);
  if (!fix) return row("unresolved", "no fix commit found (FORGE:TRAJECTORY or a merged closing PR)");
  const recorded = iss.comments.filter((c) => isTrustedComment(c)).map((c) => probeResultOf(c.body)).filter(Boolean).reverse()
    .find((p) => sameSha(p.fix, fix));
  if (recorded) return row("already-recorded", `${recorded.result} for ${fix.slice(0, 12)}`, { fix });
  if (!(await onDefault({ sha: fix, defaultBranch, io, cwd }))) return row("awaiting-promotion", `fix ${fix.slice(0, 12)} is not on ${defaultBranch}`, { fix });
  let defaultSha = null;
  try { defaultSha = String(await io.git(["rev-parse", `origin/${defaultBranch}`], { cwd })).trim() || null; } catch { /* recorded as null */ }
  const r = await runProbe(d.probe, { cwd, env: probeEnv(config.env, env), mask: config.env.map((k) => env[k]), timeoutS: config.timeoutS, ...(spawn ? { spawn } : {}) });
  const detail = `exit ${r.exit ?? "timeout"} in ${r.ms}ms`;
  if (dryRun) return row(r.result, `${detail} (dry run: not recorded)`, { fix, output: r.output });
  const body = renderProbeComment({ probe: d.probe, fix, defaultBranch, defaultSha, r });
  let note = "";
  if (r.result === "fail") {
    try { await io.gh(["issue", "reopen", String(issue), "-R", repo]); } catch (e) { note = `; reopen failed: ${String(e?.message ?? e).slice(0, 120)}`; }
  }
  await io.gh(["issue", "comment", String(issue), "-R", repo, "--body", body]);
  return row(r.result, detail + note, { fix });
}

/** The default branch: forge.yaml `branches.default`, else GitHub's. */
export async function resolveDefaultBranch({ repo, io, cwd = process.cwd() }) {
  try {
    const b = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.branches?.default;
    if (typeof b === "string" && b.trim()) return b.trim();
  } catch { /* GitHub's */ }
  return String(await io.gh(["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])).trim() || null;
}

/**
 * Probe `issues`, or (none given) the issues closed within `sweepDays` that mention `forge-probe`, capped at `limit`.
 * Sequential: probes hit production. Never throws per issue: an error is an `error` row.
 */
export async function sweepProbes({ repo, cwd = process.cwd(), io, issues = null, limit = 50, sinceDays = null, dryRun = false, config = readProbeConfig(cwd), now = () => Date.now(), env = process.env, spawn } = {}) {
  if (!config.enabled && !issues?.length) return [];
  const defaultBranch = await resolveDefaultBranch({ repo, io, cwd });
  if (!defaultBranch) throw new Error("no default branch");
  let list = issues;
  if (!list?.length) {
    const since = new Date(now() - (sinceDays ?? config.sweepDays) * 86400000).toISOString().slice(0, 10);
    const found = JSON.parse(String(await io.gh(["issue", "list", "-R", repo, "--state", "closed", "--search", `forge-probe in:body,comments closed:>=${since}`, "--limit", String(limit), "--json", "number"])));
    list = (Array.isArray(found) ? found : []).map((i) => i.number).filter(Number.isInteger);
  }
  if (!list.length) return [];
  try { await io.git(["fetch", "origin", defaultBranch], { cwd }); } catch { /* offline: the local ref */ }
  const rows = [];
  for (const issue of list) {
    try { rows.push(await probeIssue({ issue, repo, cwd, io, defaultBranch, dryRun, config, env, spawn })); } catch (e) {
      rows.push({ issue, outcome: "error", detail: String(e?.message ?? e).slice(0, 160) });
    }
  }
  return rows;
}

const GROUPS = [["pass", "pass"], ["fail", "fail (reopened)"], ["awaiting-promotion", "awaiting promotion"], ["unresolved", "unresolved fix"], ["untrusted", "untrusted (not run)"], ["error", "error"]];
/** One line, e.g. `probes: pass #A; fail (reopened) #B; awaiting promotion #C`; "" when nothing ran or waits. */
export function formatProbeSummary(rows) {
  const parts = GROUPS.map(([k, label]) => [label, (rows ?? []).filter((r) => r.outcome === k).map((r) => `#${r.issue}`)])
    .filter(([, l]) => l.length).map(([label, l]) => `${label} ${l.join(" ")}`);
  return parts.length ? `probes: ${parts.join("; ")}` : "";
}
