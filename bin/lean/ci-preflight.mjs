// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock ci preflight [--json]` (#5691): cheap deterministic CI checks that run before the long suites. No LLM anywhere.
 * - Checks: workflow lint, lockfile drift, generated-artifact drift, env drift, tool presence. Each returns
 *   {name, status: pass|fail|skip, reason}; a check whose tool or config is absent is skipped, never failed.
 * - Budget: one shared deadline (default 60 s, forge.yaml `ci.preflight.timeout_s`); a check starting after it is skipped.
 * - Config: the one-level forge.yaml parser flattens `ci.preflight.*` under `ci`, so the keys read are `ci.generated[]`
 *   (`"<command> :: <path> [<path>...]"`), `ci.tools[]` and `ci.timeout_s`. No key, no extra checks: only auto-detected ones run.
 * - Events: with FORGE_CI_EVENTS_URL set, each failed check is POSTed as a best-effort `step_failed` event (#5688 data contract).
 * Exit 1 only when a check fails. Every effect goes through the injected deps (run, which, fetch, out, env, now).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { parseForgeYaml } from "../forge-utils.mjs";

export const PREFLIGHT_USAGE = "usage: forgedock ci preflight [--json]";
export const DEFAULT_BUDGET_S = 60;

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : str(v) ? [str(v)] : []);
const oneLine = (s) => str(s).split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? "no output";
const pass = (name, reason = "ok") => ({ name, status: "pass", reason });
const fail = (name, reason) => ({ name, status: "fail", reason: oneLine(reason) });
const skip = (name, reason) => ({ name, status: "skip", reason });

/** forge.yaml `ci` section -> {generated: [{cmd, paths}], tools, timeoutS}; junk keeps the defaults. */
export function parsePreflightConfig(cwd) {
  let sec = null;
  try { sec = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.ci; } catch { /* no forge.yaml: defaults */ }
  const s = sec && typeof sec === "object" ? sec : {};
  const generated = list(s.generated).map((e) => { const [cmd, rest = ""] = e.split("::"); return { cmd: str(cmd), paths: str(rest).split(/\s+/).filter(Boolean) }; }).filter((g) => g.cmd);
  const t = Number(str(s.timeout_s));
  return { generated, tools: list(s.tools), timeoutS: Number.isFinite(t) && t > 0 ? t : DEFAULT_BUDGET_S };
}

const defaultRun = (cmd, args, { cwd, timeoutMs }) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: Math.max(1, timeoutMs), stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.error ? 127 : (r.status ?? 1), out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const defaultWhich = (cmd, env = process.env) => String(env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, cmd)));

function workflowFiles(cwd) {
  const dir = join(cwd, ".github", "workflows");
  try { return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => ({ file: `.github/workflows/${f}`, text: readFileSync(join(dir, f), "utf8") })); } catch { return []; }
}

/** First syntax problem of a workflow file, or null: a deliberately small scan used only when actionlint is absent. */
export function yamlProblem(text) {
  const lines = text.split(/\r?\n/);
  let block = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const ind = l.match(/^\s*/)[0];
    if (block >= 0 && (ind.length > block || !l.trim())) continue;
    block = -1;
    if (!l.trim() || /^\s*#/.test(l)) continue;
    if (/^ *\t/.test(l)) return `line ${i + 1}: tab used for indentation`;
    const body = l.replace(/\s#.*$/, "");
    if (/[:-]\s*[|>][+-]?\d?\s*$/.test(body)) { block = ind.length; continue; }
    const val = body.match(/^\s*(?:-\s+)?[\w.'"-]+:\s+(.+)$/)?.[1] ?? body.match(/^\s*-\s+(.+)$/)?.[1];
    if (val === undefined) continue;
    if (/^"/.test(val) && !/^"(?:[^"\\]|\\.)*"\s*$/.test(val)) return `line ${i + 1}: unterminated double quote`;
    if (/^'/.test(val) && !/^'(?:[^']|'')*'\s*$/.test(val)) return `line ${i + 1}: unterminated single quote`;
    if (/^[[{]/.test(val)) {
      const stripped = val.replace(/"[^"]*"|'[^']*'|\$\{\{.*?\}\}/g, "");
      if ((stripped.match(/\[/g) ?? []).length !== (stripped.match(/\]/g) ?? []).length || (stripped.match(/\{/g) ?? []).length !== (stripped.match(/\}/g) ?? []).length) return `line ${i + 1}: unbalanced flow bracket`;
    }
  }
  return null;
}

/** Keys set under a workflow `env:` map to a secrets/vars expression: app config that `.env.example` must list. */
export function workflowEnvKeys(text) {
  const keys = new Set(), lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)env:\s*$/);
    if (!m) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const k = lines[j].match(/^(\s+)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (!k && lines[j].trim() && !/^\s*#/.test(lines[j])) break;
      if (!k) continue;
      if (k[1].length <= m[1].length) break;
      if (/\$\{\{\s*(secrets|vars)\./.test(k[3]) && !/^GITHUB_/.test(k[2])) keys.add(k[2]);
    }
  }
  return keys;
}

/** Runs every check; @returns {ok, budgetMs, elapsedMs, checks}. `deps`: {run, which, now, env}. */
export function runPreflight(cwd, deps = {}) {
  const now = deps.now ?? Date.now, env = deps.env ?? process.env, run = deps.run ?? defaultRun, which = deps.which ?? ((c) => defaultWhich(c, env));
  const cfg = parsePreflightConfig(cwd), budgetMs = cfg.timeoutS * 1000, start = now();
  const left = () => budgetMs - (now() - start);
  const exec = (cmd, args) => run(cmd, args, { cwd, timeoutMs: left() });
  const guard = (name, fn) => {
    if (left() <= 0) return [skip(name, `budget of ${cfg.timeoutS}s exhausted`)];
    try { return fn(); } catch (e) { return [fail(name, `check crashed: ${e?.message ?? e}`)]; }
  };
  const checks = [];

  checks.push(...guard("workflow-lint", () => {
    const files = workflowFiles(cwd);
    if (!files.length) return [skip("workflow-lint", "no .github/workflows/*.yml")];
    if (which("actionlint")) { const r = exec("actionlint", []); return [r.code === 0 ? pass("workflow-lint", "actionlint clean") : fail("workflow-lint", r.out)]; }
    for (const f of files) { const p = yamlProblem(f.text); if (p) return [fail("workflow-lint", `${f.file}: ${p}`)]; }
    return [pass("workflow-lint", `${files.length} workflow file(s) parse (actionlint absent)`)];
  }));

  const pkg = existsSync(join(cwd, "package.json")), pyproject = existsSync(join(cwd, "pyproject.toml"));
  const locks = [
    { eco: "pnpm", when: pkg && existsSync(join(cwd, "pnpm-lock.yaml")), cmd: "pnpm", args: ["install", "--frozen-lockfile", "--lockfile-only"] },
    { eco: "npm", when: pkg && existsSync(join(cwd, "package-lock.json")), cmd: "npm", args: ["ci", "--dry-run", "--ignore-scripts"] },
    { eco: "uv", when: pyproject && existsSync(join(cwd, "uv.lock")), cmd: "uv", args: ["lock", "--check"] },
    { eco: "poetry", when: pyproject && existsSync(join(cwd, "poetry.lock")), cmd: "poetry", args: ["check", "--lock"] },
  ].filter((l) => l.when);
  if (!locks.length) checks.push(skip("lockfile", "no package.json/pyproject.toml with a lockfile"));
  for (const l of locks) {
    checks.push(...guard(`lockfile:${l.eco}`, () => {
      if (!which(l.cmd)) return [skip(`lockfile:${l.eco}`, `${l.cmd} not on PATH`)];
      const r = exec(l.cmd, l.args);
      return [r.code === 0 ? pass(`lockfile:${l.eco}`, "lockfile in sync") : fail(`lockfile:${l.eco}`, `lockfile drift: ${oneLine(r.out)}`)];
    }));
  }

  if (!cfg.generated.length) checks.push(skip("generated", "no ci.preflight.generated configured"));
  cfg.generated.forEach((g, i) => {
    const name = cfg.generated.length > 1 ? `generated:${i + 1}` : "generated";
    checks.push(...guard(name, () => {
      const r = exec("sh", ["-c", g.cmd]);
      if (r.code !== 0) return [fail(name, `generator failed (${g.cmd}): ${oneLine(r.out)}`)];
      if (!g.paths.length) return [skip(name, "no paths declared to diff")];
      const d = exec("git", ["diff", "--exit-code", "--", ...g.paths]);
      return [d.code === 0 ? pass(name, `${g.paths.join(" ")} up to date`) : fail(name, `stale generated artifact: ${g.paths.join(" ")} differs after \`${g.cmd}\``)];
    }));
  });

  checks.push(...guard("env-drift", () => {
    const ex = join(cwd, ".env.example");
    const used = new Set(workflowFiles(cwd).flatMap((f) => [...workflowEnvKeys(f.text)]));
    if (!existsSync(ex)) return [skip("env-drift", "no .env.example")];
    if (!used.size) return [skip("env-drift", "no workflow env: keys from secrets/vars")];
    const have = new Set(readFileSync(ex, "utf8").split(/\r?\n/).map((l) => l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]).filter(Boolean));
    const missing = [...used].filter((k) => !have.has(k)).sort();
    return [missing.length ? fail("env-drift", `workflow env key(s) missing from .env.example: ${missing.join(", ")}`) : pass("env-drift", `${used.size} key(s) listed in .env.example`)];
  }));

  if (!cfg.tools.length) checks.push(skip("tools", "no ci.preflight.tools configured"));
  else checks.push(...guard("tools", () => {
    const missing = cfg.tools.filter((t) => !which(t));
    return [missing.length ? fail("tools", `missing tool(s) on PATH: ${missing.join(", ")}`) : pass("tools", `${cfg.tools.join(", ")} present`)];
  }));

  return { ok: !checks.some((c) => c.status === "fail"), budgetMs, elapsedMs: now() - start, checks };
}

/** Best-effort `step_failed` event per failed check; never throws and never changes the result. */
export async function emitEvents(result, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const url = str(env.FORGE_CI_EVENTS_URL);
  if (!url || typeof fetchImpl !== "function") return 0;
  let sent = 0;
  for (const c of result.checks.filter((x) => x.status === "fail")) {
    const body = { type: "step_failed", step: `preflight:${c.name}`, class: "deterministic-setup", reason: c.reason, repo: env.GITHUB_REPOSITORY ?? null, sha: env.GITHUB_SHA ?? null };
    try { await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) }); sent++; } catch { /* best effort */ }
  }
  return sent;
}

/** `forgedock ci preflight [--json]`; @returns the exit code. `deps`: {out, cwd, run, which, now, env, fetchImpl}. */
export async function ciPreflightFromCli(argv, deps = {}) {
  const out = deps.out ?? ((l) => console.log(l)), cwd = deps.cwd ?? process.cwd();
  const unknown = argv.find((a) => a !== "--json");
  if (unknown) throw new Error(`unknown argument ${unknown}; ${PREFLIGHT_USAGE}`);
  const res = runPreflight(cwd, deps);
  await emitEvents(res, deps);
  if (argv.includes("--json")) out(JSON.stringify(res));
  else {
    for (const c of res.checks) out(`${c.status.toUpperCase().padEnd(4)} ${c.name}: ${c.reason}`);
    out(`preflight: ${res.ok ? "ok" : "FAILED"} in ${res.elapsedMs} ms (budget ${res.budgetMs / 1000} s)`);
  }
  return res.ok ? 0 : 1;
}
