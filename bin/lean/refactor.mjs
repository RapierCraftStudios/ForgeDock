// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * refactor:split lane step (forge#4211, #4196): replaces the builder for an issue labelled `refactor:split`.
 * Deterministic except one grouping call: scripts/symbol-index.py (Python) or scripts/symbol-index.mjs (TypeScript)
 * indexes the target, one tool-less LLM call groups the top-level symbols from that index only (never a file body),
 * the language's codemod mover (scripts/symbol-move.py with libcst, scripts/symbol-move.mjs with ts-morph, #4212)
 * moves them into one package and leaves a re-export shim/barrel, and scripts/refactor-verify.sh proves the move
 * (same test counts, every public symbol resolves from its old path, no new cycle, moved-only diff). Other languages
 * are refused before anything runs. Every refusal leaves the worktree at its start commit.
 * A plan over `maxLines` moved lines is cut into whole modules: this PR moves the first slice, the rest is carried in
 * a FORGE:SPLIT-PLAN block of a chained issue that the next run applies with `symbol-move.py --extend`, no new call.
 * runCore (lean.mjs) owns lease, worktree, PR and merge; this module only produces the verified commit.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { groupingPrompt } from "./prompts.mjs";

export const SPLIT_LABEL = "refactor:split";
export const DEFAULT_SPLIT_MAX_LINES = 4000;
const SCRIPTS = fileURLToPath(new URL("../../scripts/", import.meta.url));
export const SYMBOL_INDEX = join(SCRIPTS, "symbol-index.py");
export const SYMBOL_MOVE = join(SCRIPTS, "symbol-move.py");
export const REFACTOR_VERIFY = join(SCRIPTS, "refactor-verify.sh");
export const SYMBOL_INDEX_MJS = join(SCRIPTS, "symbol-index.mjs");
export const SYMBOL_MOVE_TS = join(SCRIPTS, "symbol-move.mjs");
const LANGS = { ".py": "python", ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts", ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js", ".go": "go", ".rs": "rust", ".rb": "ruby", ".java": "java" };
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** argv runner without a shell; never throws for a non-zero exit. */
export function defaultRun(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (Number.isInteger(err.code) ? err.code : 127) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err && !Number.isInteger(err.code) ? err.message : "")) });
    });
  });
}

/** `<!-- FORGE:MAINT:refactor:split:<path> -->` (scripts/maintenance-scan.sh), else a `**Target**: <path>` line; null otherwise. */
export function parseSplitTarget(body) {
  const s = String(body ?? "");
  const m = /<!--\s*FORGE:MAINT:refactor:split:(.+?)\s*-->/.exec(s) ?? /^\s*\*\*Target\*\*:\s*`?([^`\s]+)`?/m.exec(s);
  return m ? m[1].trim() : null;
}

/** `**Test command**: <cmd>` (backticks optional), else forge.yaml learned.test_commands joined with ` && `; null otherwise. */
export function parseTestCmd(body, precheckCommands = []) {
  const m = /^\s*\*\*Test command\*\*:\s*(?:`([^`]+)`|(.+))$/m.exec(String(body ?? ""));
  const own = (m?.[1] ?? m?.[2] ?? "").trim();
  if (own) return own;
  const cmds = (Array.isArray(precheckCommands) ? precheckCommands : []).map((c) => String(c ?? "").trim()).filter(Boolean);
  return cmds.length ? cmds.join(" && ") : null;
}

const validPlan = (p) => p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length > 0
  && Object.entries(p).every(([k, v]) => IDENT.test(k) && Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === "string" && n));

/** The chain plan `<!-- FORGE:SPLIT-PLAN -->` + fenced json {target?, package, plan:{module:[symbols]}}; null when absent or invalid. */
export function parseSplitPlan(body) {
  const m = /<!--\s*FORGE:SPLIT-PLAN\s*-->\s*```(?:json)?\s*([\s\S]*?)```/.exec(String(body ?? ""));
  if (!m) return null;
  let j; try { j = JSON.parse(m[1]); } catch { return null; }
  if (!j || typeof j !== "object" || !IDENT.test(String(j.package ?? "")) || !validPlan(j.plan)) return null;
  return { target: typeof j.target === "string" && j.target ? j.target : null, package: j.package, plan: j.plan };
}

const top = (n) => String(n).split(".")[0];

/** What the grouping call sees: top-level symbols {name,kind,lines,public} and deduped `from->to` edges. No spans, bodies or imports. */
export function compactIndex(index) {
  const symbols = (index?.symbols ?? []).filter((s) => !String(s.name).includes(".")).map((s) => ({ name: s.name, kind: s.kind, lines: s.lines, public: Boolean(s.public) }));
  const names = new Set(symbols.map((s) => s.name));
  const edges = new Set();
  for (const e of index?.edges ?? []) {
    const f = top(e.from), t = top(e.to);
    if (f !== t && names.has(f) && names.has(t)) edges.add(`${f}->${t}`);
  }
  return { symbols, edges: [...edges].sort() };
}

/** The grouping reply as {module:[symbols]}: one JSON object, identifiers, known top-level symbols, none twice; null otherwise. */
export function parseGroupingReply(text, names) {
  const s = String(text ?? ""), a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let p; try { p = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!validPlan(p)) return null;
  const known = new Set(names), seen = new Set();
  for (const list of Object.values(p)) for (const n of list) { if (!known.has(n) || seen.has(n)) return null; seen.add(n); }
  if (Object.keys(p).some((k) => known.has(k))) return null;
  return p;
}

/**
 * One PR's slice of a plan: modules ordered so a module comes after the modules it references (plan order otherwise),
 * then whole modules until the moved lines would exceed maxLines; the first module is always taken.
 * Returns {now, rest, lines}; rest is null when everything fits.
 */
export function slicePlan(plan, index, maxLines = DEFAULT_SPLIT_MAX_LINES) {
  const ci = compactIndex(index);
  const size = new Map(ci.symbols.map((s) => [s.name, Number(s.lines) || 0]));
  const modOf = new Map();
  for (const [m, list] of Object.entries(plan)) for (const n of list) modOf.set(n, m);
  const deps = new Map(Object.keys(plan).map((m) => [m, new Set()]));
  for (const e of ci.edges) {
    const [f, t] = e.split("->"), mf = modOf.get(f), mt = modOf.get(t);
    if (mf && mt && mf !== mt) deps.get(mf).add(mt);
  }
  const order = [], state = new Map();
  const visit = (m) => {
    if (state.get(m)) return; // visiting (a cycle: symbol-move refuses it) or done
    state.set(m, 1);
    for (const d of Object.keys(plan)) if (deps.get(m).has(d)) visit(d);
    state.set(m, 2); order.push(m);
  };
  for (const m of Object.keys(plan)) visit(m);
  const now = {}, rest = {};
  let lines = 0, full = false;
  for (const m of order) {
    const l = plan[m].reduce((n, s) => n + (size.get(s) ?? 0), 0);
    if (!full && (!Object.keys(now).length || lines + l <= maxLines)) { now[m] = plan[m]; lines += l; } else { full = true; rest[m] = plan[m]; }
  }
  return { now, rest: Object.keys(rest).length ? rest : null, lines };
}

const pythonCmd = (py) => {
  const v = Array.isArray(py) ? py : String(py ?? process.env.SYMBOL_MOVE_PYTHON ?? "").trim().split(/\s+/).filter(Boolean);
  return v.length ? v : ["python3"];
};
/** A script's JSON reply: the whole stdout (refactor-verify pretty-prints), else its last line. */
const parseJson = (t) => {
  for (const c of [String(t ?? "").trim(), String(t ?? "").trim().split("\n").filter(Boolean).at(-1) ?? ""]) {
    try { const j = JSON.parse(c); if (j && typeof j === "object") return j; } catch { /* next candidate */ }
  }
  return null;
};
const tail = (r) => String(r?.stderr || r?.stdout || "").trim().slice(-600);
const failureLine = (f) => (f.kind === "logic-diff" ? `logic-diff ${f.file}:${f.line} \`${f.text}\`` : f.kind === "missing-symbol" ? `missing-symbol ${f.module}.${f.name}`
  : f.kind === "count-changed" ? `count-changed ${JSON.stringify(f.before)} -> ${JSON.stringify(f.after)}` : f.kind === "new-cycle" ? `new-cycle ${(f.cycle ?? []).join(" -> ")}` : JSON.stringify(f));

function effects(ctx) {
  const run = ctx.run ?? defaultRun;
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...(ctx.env ?? {}) };
  const sh = (cmd, args) => run(cmd, args, { cwd: ctx.wt, env });
  const git = ctx.git ?? (async (args) => { const r = await sh("git", args); if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${tail(r)}`); return r.stdout; });
  const scratch = () => { const d = join(ctx.runTmp ?? join(ctx.wt, ".forge-lean"), "split"); mkdirSync(d, { recursive: true }); return d; };
  return { sh, git, scratch };
}

/** Puts the worktree back at `head` and drops untracked files (ignored ones, such as .forge-lean/, stay). */
async function restore(git, head) {
  try { await git(["reset", "-q", "--hard", head]); } catch { /* best effort */ }
  try { await git(["clean", "-fdq"]); } catch { /* best effort */ }
}

/** baseline at `ref`'s state (the worktree checked out there), back to the current branch, then verify `ref..HEAD`. */
export async function reverifySplit(ctx) {
  const { sh, git, scratch } = effects(ctx);
  const head = String(await git(["rev-parse", "HEAD"])).trim();
  const branch = String(await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const out = join(scratch(), "split-rebaseline.json");
  await git(["checkout", "-q", "--detach", ctx.base]);
  const b = await sh("bash", [REFACTOR_VERIFY, "baseline", "--root", ctx.wt, "--target", ctx.target, "--test-cmd", ctx.testCmd, "--out", out]);
  await restore(git, ctx.base);
  await git(["checkout", "-q", branch === "HEAD" ? head : branch]);
  if (b.code !== 0) return { ok: false, code: OUTCOME_CODES.SPLIT_PLAN_INVALID, reason: `refactor-verify baseline at ${ctx.base} failed (exit ${b.code}): ${tail(b)}` };
  const v = await sh("bash", [REFACTOR_VERIFY, "verify", "--baseline", out, "--base", ctx.base]);
  const j = parseJson(v.stdout);
  if (v.code === 0 && j?.ok) return { ok: true, verify: j };
  if (v.code === 1) return { ok: false, code: OUTCOME_CODES.SPLIT_VERIFY_FAILED, reason: `refactor-verify failed:\n${(j?.failures ?? []).slice(0, 20).map((f) => `- ${failureLine(f)}`).join("\n")}`, verify: j };
  return { ok: false, code: OUTCOME_CODES.SPLIT_UNSUPPORTED, reason: `refactor-verify could not verify (exit ${v.code}): ${tail(v)}` };
}

/**
 * The split step. ctx: {wt, base, issue, issueBody, precheckCommands, runTmp, maxLines, run(cmd,args,{cwd,env}),
 * callGrouper(prompt, {cwd: an empty dir}) -> reply text, git(args) -> stdout, python (argv or string; default $SYMBOL_MOVE_PYTHON, else python3)}.
 * Returns {ok:true, target, testCmd, package, packageName, modules, rest, verify, grouped, lines} or {ok:false, code, reason}.
 */
export async function runSplitStep(ctx) {
  const { sh, git, scratch } = effects(ctx);
  const py = pythonCmd(ctx.python);
  const fail = (code, reason) => ({ ok: false, code, reason });
  const chain = parseSplitPlan(ctx.issueBody);
  // ---- 1. target, language, test command, codemod tool: nothing touched yet ----
  const raw = parseSplitTarget(ctx.issueBody) ?? chain?.target;
  if (!raw) return fail(OUTCOME_CODES.SPLIT_PLAN_INVALID, "no split target: the issue needs a `<!-- FORGE:MAINT:refactor:split:<path> -->` marker or a `**Target**: <path>` line");
  const target = normalize(raw.replace(/^\.\//, ""));
  if (isAbsolute(target) || target.startsWith("..")) return fail(OUTCOME_CODES.SPLIT_PLAN_INVALID, `split target \`${raw}\` must be a path inside the repository`);
  const ext = extname(target).toLowerCase();
  const lang = LANGS[ext] ?? (ext.slice(1) || "unknown");
  if (lang !== "python" && lang !== "ts") return fail(OUTCOME_CODES.SPLIT_UNSUPPORTED, `no codemod tool for ${lang}: \`${target}\` (the refactor:split movers support Python and TypeScript)`);
  if (!existsSync(join(ctx.wt, target))) return fail(OUTCOME_CODES.SPLIT_PLAN_INVALID, `split target \`${target}\` does not exist on the base`);
  const testCmd = parseTestCmd(ctx.issueBody, ctx.precheckCommands);
  if (!testCmd) return fail(OUTCOME_CODES.SPLIT_PLAN_INVALID, "no test command: add a `**Test command**: <cmd>` line to the issue or forge.yaml learned.test_commands");
  if (lang === "python") {
    const probe = await sh(py[0], [...py.slice(1), "-c", "import libcst"]);
    if (probe.code !== 0) return fail(OUTCOME_CODES.SPLIT_UNSUPPORTED, `no codemod tool for python: libcst is not importable by \`${py.join(" ")}\` (install it or set SYMBOL_MOVE_PYTHON)`);
  } else {
    // #4212: ts-morph is resolved from the target repo (or NODE_PATH); the probe reads and writes nothing
    const probe = await sh(process.execPath, [SYMBOL_MOVE_TS, "--probe", "--src", target]);
    if (probe.code !== 0) {
      const why = String(parseJson(probe.stdout)?.reason ?? "");
      return fail(OUTCOME_CODES.SPLIT_UNSUPPORTED, /^no codemod tool for ts:/.test(why) ? why : `no codemod tool for ts: the ts-morph probe failed (exit ${probe.code}): ${why || tail(probe)}`);
    }
  }
  const startHead = String(await git(["rev-parse", "HEAD"])).trim();
  const refuse = async (code, reason) => { await restore(git, startHead); return fail(code, reason); };
  // ---- 2. symbol index ----
  const ir = lang === "python" ? await sh("python3", [SYMBOL_INDEX, target]) : await sh(process.execPath, [SYMBOL_INDEX_MJS, target]);
  const index = parseJson(ir.stdout);
  if (index?.unsupported) return await refuse(OUTCOME_CODES.SPLIT_UNSUPPORTED, `no codemod tool for ${index.unsupported}: ${index.reason ?? "unsupported"}`);
  if (ir.code !== 0 || !Array.isArray(index?.symbols)) return await refuse(OUTCOME_CODES.SPLIT_PLAN_INVALID, `symbol index failed (exit ${ir.code}): ${tail(ir)}`);
  // ---- 3. baseline ----
  const dir = scratch(), baseline = join(dir, "split-baseline.json");
  const br = await sh("bash", [REFACTOR_VERIFY, "baseline", "--root", ctx.wt, "--target", target, "--test-cmd", testCmd, "--out", baseline]);
  if (br.code !== 0) return await refuse(OUTCOME_CODES.SPLIT_PLAN_INVALID, `refactor-verify baseline failed (exit ${br.code}): ${tail(br)}`);
  // ---- 4. plan: the chained remainder, else exactly one grouping call over the compact index ----
  let plan, grouped = false;
  if (chain) plan = chain.plan;
  else {
    const ci = compactIndex(index);
    const reply = await ctx.callGrouper(groupingPrompt(ci), { cwd: mkdtempSync(join(dir, "group-")) }); // empty cwd: nothing to read even with a tool
    grouped = true;
    plan = parseGroupingReply(reply, ci.symbols.map((s) => s.name));
    if (!plan) return await refuse(OUTCOME_CODES.SPLIT_PLAN_INVALID, `the grouping reply is not a valid {module:[symbols]} plan over the index: ${String(reply ?? "").slice(0, 300)}`);
  }
  // ---- 5. one PR's slice ----
  const { now, rest, lines } = slicePlan(plan, index, ctx.maxLines ?? DEFAULT_SPLIT_MAX_LINES);
  // ---- 6. move ----
  const planFile = join(mkdtempSync(join(dir, "plan-")), "plan.json");
  writeFileSync(planFile, `${JSON.stringify(now)}\n`);
  const moveArgs = ["--src", target, "--plan", planFile, ...(chain ? ["--package", chain.package, "--extend"] : [])];
  const mr = lang === "python" ? await sh(py[0], [...py.slice(1), SYMBOL_MOVE, ...moveArgs]) : await sh(process.execPath, [SYMBOL_MOVE_TS, ...moveArgs]);
  const moved = parseJson(mr.stdout);
  if (mr.code === 3 || moved?.status === "refused") {
    const why = String(moved?.reason ?? tail(mr));
    return await refuse(/libcst|no codemod tool/i.test(why) ? OUTCOME_CODES.SPLIT_UNSUPPORTED : OUTCOME_CODES.SPLIT_PLAN_INVALID, `symbol-move refused: ${why}`);
  }
  if (mr.code !== 0 || moved?.status !== "ok") return await refuse(OUTCOME_CODES.SPLIT_PLAN_INVALID, `symbol-move failed (exit ${mr.code}): ${tail(mr)}`);
  // ---- 7. commit ----
  const pkg = String(moved.package);
  const packageName = lang === "python" ? pkg.split(".").at(-1) : pkg.split("/").at(-1); // dotted package | package dir
  const tool = lang === "python" ? "libcst" : "ts-morph";
  try {
    await git(["add", "-A"]);
    await git(["commit", "--no-verify", "-q", "-m", `refactor(split): move ${Object.keys(now).length} module(s) of ${target} into ${pkg}${ctx.issue ? ` (#${ctx.issue})` : ""}`]);
  } catch (e) { return await refuse(OUTCOME_CODES.SPLIT_PLAN_INVALID, `committing the move failed: ${String(e?.message ?? e).slice(0, 300)}`); }
  // ---- 8. verify ----
  const vr = await sh("bash", [REFACTOR_VERIFY, "verify", "--baseline", baseline, "--base", ctx.base]);
  const verify = parseJson(vr.stdout);
  if (vr.code === 1) return await refuse(OUTCOME_CODES.SPLIT_VERIFY_FAILED, `refactor-verify failed; the move was reset:\n${(verify?.failures ?? []).slice(0, 20).map((f) => `- ${failureLine(f)}`).join("\n")}`);
  if (vr.code !== 0 || !verify?.ok) return await refuse(OUTCOME_CODES.SPLIT_UNSUPPORTED, `refactor-verify could not verify (exit ${vr.code}): ${tail(vr)}`);
  return { ok: true, target, testCmd, package: pkg, packageName, modules: moved.modules ?? now, rest, verify, grouped, lines, lang, tool };
}

const table = (modules) => ["| Module | Symbols |", "| --- | --- |", ...Object.entries(modules ?? {}).map(([m, s]) => `| \`${m}\` | ${s.length} |`)].join("\n");

/** The split PR body: what moved where, the deterministic proof, the chained remainder. */
export function renderSplitPrBody({ issue, target, package: pkg, modules, verify, rest, lines, grouped, tool }) {
  tool ??= /\.[cm]?tsx?$/i.test(String(target ?? "")) ? "ts-morph" : "libcst"; // a rerun result carries no tool
  const left = rest ? `\n\n## Remaining work\n${Object.keys(rest).length} module(s) (${Object.keys(rest).map((m) => `\`${m}\``).join(", ")}) move in a chained \`refactor:split\` PR filed after this one merges; each PR is mergeable on its own.` : "";
  return `## Split\n\`${target}\` → package \`${pkg}\`, ${Object.keys(modules ?? {}).length} module(s), ${lines ?? "?"} moved line(s). Moved verbatim by ${tool === "ts-morph" ? "\`scripts/symbol-move.mjs\` (ts-morph)" : "\`scripts/symbol-move.py\` (libcst)"}; \`${target}\` keeps every unmoved statement and re-exports each moved name. Plan: ${grouped ? "one grouping call over the symbol index (no file bodies)" : "carried from the chained issue (no LLM call)"}.\n\n${table(modules)}\n\n## Verification\n\`scripts/refactor-verify.sh\`: ${verify?.ok ? "ok" : "not run"} (identical pass/skip counts, every baseline public symbol resolves from its old path, no new import cycle, diff is moved blocks and import lines only). Location-only change: no conformance review.${left}\n\nCloses #${issue}`;
}

/** The chained issue for the rest of a large split: same maintenance marker and labels, and the plan, so the next run makes no grouping call. */
export function renderChainIssue({ parent, target, packageName, rest, testCmd = null }) {
  const plan = JSON.stringify({ target, package: packageName, plan: rest }, null, 2);
  return {
    title: `split ${target} (continued)`,
    labels: ["maintenance", SPLIT_LABEL],
    body: `Continues the split of \`${target}\` from #${parent}: ${Object.keys(rest).length} module(s) left, moved into the existing package \`${packageName}\`.\n\n**Target**: \`${target}\`\n${testCmd ? `**Test command**: \`${testCmd}\`\n` : ""}\n<!-- FORGE:MAINT:refactor:split:${target} -->\n<!-- FORGE:SPLIT-PLAN -->\n\`\`\`json\n${plan}\n\`\`\`\n`,
  };
}
