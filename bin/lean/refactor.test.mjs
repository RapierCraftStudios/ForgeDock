// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// refactor:split lane step (forge#4211): bin/lean/refactor.mjs against real fixture repos and the real scripts.
// The libcst cases resolve an interpreter like scripts/symbol-move.test.sh ($SYMBOL_MOVE_PYTHON, python3 with libcst,
// `uv run --no-project --with libcst python`) and skip without one; SYMBOL_MOVE_REQUIRE_LIBCST=1 makes that a failure.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../tests/_tmp.mjs";
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { groupingPrompt, GROUPING_SYSTEM } from "./prompts.mjs";
import { noToolFlags } from "./effects.mjs";
import {
  runSplitStep, defaultRun, compactIndex, slicePlan, parseSplitTarget, parseTestCmd, parseSplitPlan, parseGroupingReply,
  renderChainIssue, renderSplitPrBody, SYMBOL_INDEX, SYMBOL_MOVE, REFACTOR_VERIFY, SPLIT_LABEL,
} from "./refactor.mjs";

const GEN = fileURLToPath(new URL("../../scripts/fixtures/symbol-move/gen_big.py", import.meta.url));
const TEST_CMD = "python3 -m unittest discover -s tests -t .";
const ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };

function libcstPython() {
  const ok = (argv) => spawnSync(argv[0], [...argv.slice(1), "-c", "import libcst"], { stdio: "ignore", env: ENV }).status === 0;
  if (process.env.SYMBOL_MOVE_PYTHON) return process.env.SYMBOL_MOVE_PYTHON.trim().split(/\s+/);
  if (ok(["python3"])) return ["python3"];
  const uv = ["uv", "run", "--no-project", "--with", "libcst", "python"];
  return ok(uv) ? uv : null;
}
const PY = libcstPython();
const SKIP = PY ? false : "no python with libcst (set SYMBOL_MOVE_PYTHON)";
if (!PY && process.env.SYMBOL_MOVE_REQUIRE_LIBCST === "1") throw new Error("libcst required (SYMBOL_MOVE_REQUIRE_LIBCST=1) but not available");

const git = (dir, ...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { encoding: "utf8", env: ENV }).trim();
/** A git repo holding the ~3k-line fixture module pkg/big.py and its unittest suite, committed and tagged `base`. */
function fixtureRepo() {
  const d = join(tmpDir("split-"), "repo");
  mkdirSync(d, { recursive: true });
  git(d, "init", "-q");
  writeFileSync(join(d, ".gitignore"), "__pycache__/\n.forge-lean/\n");
  execFileSync("python3", [GEN, d], { env: ENV });
  git(d, "add", "-A"); git(d, "commit", "-qm", "base"); git(d, "tag", "base");
  return d;
}
const gitFx = (d) => async (args) => git(d, ...args);
const clean = (d) => git(d, "status", "--porcelain");
const seq = (n, f) => Array.from({ length: n }, (_, i) => f(String(i).padStart(2, "0")));
const FULL = {
  consts: [...seq(90, (i) => `LIMIT_${i}`), "_SEPARATOR"],
  helpers: [...seq(90, (i) => [`_scale_${i}`, `compute_${i}`]).flat(), "join_parts"],
  aio: seq(30, (i) => `fetch_${i}`),
  models: seq(30, (i) => `Item_${i}`),
};
const BODY = "`pkg/big.py` has 3000 lines.\n\n<!-- FORGE:MAINT:refactor:split:pkg/big.py -->\n";

/** Records every grouping call; replies with `plan`. */
function grouper(plan) {
  const calls = [];
  return { calls, fn: async (prompt, opts) => { calls.push({ prompt, opts }); return `Here is the plan:\n${JSON.stringify(plan)}`; } };
}
/** defaultRun, except that calls whose argv contains `script` are answered by `fake(args, cwd)`. */
const intercept = (script, fake) => async (cmd, args, o) => (args.includes(script) ? fake(args, o.cwd) : defaultRun(cmd, args, o));

describe("refactor:split parsers and planning (forge#4211)", () => {
  it("target, test command and chain plan come from the issue body", () => {
    assert.equal(parseSplitTarget(BODY), "pkg/big.py");
    assert.equal(parseSplitTarget("**Target**: `src/a.py`"), "src/a.py");
    assert.equal(parseSplitTarget("nothing"), null);
    assert.equal(parseTestCmd("**Test command**: `pytest -q tests`", ["npm test"]), "pytest -q tests");
    assert.equal(parseTestCmd("x", ["ruff check .", "pytest"]), "ruff check . && pytest");
    assert.equal(parseTestCmd("x", []), null);
    const c = renderChainIssue({ parent: 9, target: "pkg/big.py", packageName: "big_parts", rest: { models: ["Item_00"] }, testCmd: TEST_CMD });
    assert.deepEqual(c.labels, ["maintenance", SPLIT_LABEL]);
    assert.match(c.body, /<!-- FORGE:MAINT:refactor:split:pkg\/big.py -->/);
    assert.deepEqual(parseSplitPlan(c.body), { target: "pkg/big.py", package: "big_parts", plan: { models: ["Item_00"] } });
    assert.equal(parseSplitTarget(c.body), "pkg/big.py");
    assert.equal(parseTestCmd(c.body, []), TEST_CMD);
    assert.equal(parseSplitPlan("<!-- FORGE:SPLIT-PLAN -->\n```json\n{\"package\":\"bad name\",\"plan\":{}}\n```"), null);
  });

  it("the grouping reply must be one {module:[symbols]} object over known symbols, each once", () => {
    const names = ["a", "b", "c"];
    assert.deepEqual(parseGroupingReply('ok ```json\n{"m1":["a"],"m2":["b","c"]}\n```', names), { m1: ["a"], m2: ["b", "c"] });
    assert.equal(parseGroupingReply('{"m1":["a","a"]}', names), null);
    assert.equal(parseGroupingReply('{"m1":["zzz"]}', names), null);
    assert.equal(parseGroupingReply('{"a":["b"]}', names), null, "module name colliding with a symbol");
    assert.equal(parseGroupingReply('{"bad-name":["a"]}', names), null);
    assert.equal(parseGroupingReply("no json", names), null);
  });

  it("R4: slicePlan keeps whole modules under maxLines, dependencies first, and returns the rest", () => {
    const index = { symbols: [{ name: "A", kind: "const", lines: 10, public: true }, { name: "f", kind: "function", lines: 500, public: true }, { name: "g", kind: "function", lines: 600, public: true }],
      edges: [{ from: "f", to: "A" }, { from: "g", to: "f" }] };
    const plan = { late: ["g"], mid: ["f"], base: ["A"] };
    assert.deepEqual(slicePlan(plan, index, 600), { now: { base: ["A"], mid: ["f"] }, rest: { late: ["g"] }, lines: 510 });
    assert.deepEqual(slicePlan(plan, index, 5).now, { base: ["A"] }, "the first module is always taken");
    assert.equal(slicePlan(plan, index, 5000).rest, null);
  });

  it("R2/R5: the grouping input is the compact index only; its size does not follow the file size", () => {
    const d = tmpDir("split-size-");
    const mk = (n) => ["X = 1", "", "def f():", ...Array.from({ length: n }, (_, i) => `    v${i} = X + ${i}  # padding line ${"x".repeat(40)}`), "    return X", "", "class K:", "    def m(self):", "        return f()", ""].join("\n");
    writeFileSync(join(d, "small.py"), mk(5)); writeFileSync(join(d, "big.py"), mk(500));
    const idx = (f) => JSON.parse(execFileSync("python3", [SYMBOL_INDEX, join(d, f)], { encoding: "utf8" }));
    const [a, b] = [compactIndex(idx("small.py")), compactIndex(idx("big.py"))];
    assert.deepEqual(a.symbols.map((s) => s.name), ["X", "f", "K"], "top-level symbols only (no K.m)");
    assert.deepEqual(a.edges, ["K->f", "f->X"]);
    for (const s of a.symbols) assert.deepEqual(Object.keys(s).sort(), ["kind", "lines", "name", "public"]);
    const [pa, pb] = [groupingPrompt(a), groupingPrompt(b)];
    assert.ok(readFileSync(join(d, "big.py"), "utf8").length > 50 * readFileSync(join(d, "small.py"), "utf8").length);
    assert.ok(Math.abs(pb.length - pa.length) <= 2 * a.symbols.length, `prompt grew ${pa.length} -> ${pb.length}`);
    assert.doesNotMatch(pb, /padding line/);
    assert.match(GROUPING_SYSTEM, /no tools/);
    assert.deepEqual(noToolFlags({ strictMcp: true }), ["--tools", ""]);
    assert.ok(noToolFlags({}).includes("Read") && noToolFlags({}).includes("Grep") && noToolFlags({}).includes("Glob"));
  });
});

describe("refactor:split step on a fixture repo (forge#4211)", () => {
  it("R2: the ~3k-line module becomes a package plus shim with identical test results; the LLM sees the index only", { skip: SKIP }, async () => {
    const d = fixtureRepo();
    const src = readFileSync(join(d, "pkg/big.py"), "utf8");
    assert.ok(src.split("\n").length >= 2500);
    const g = grouper(FULL);
    const r = await runSplitStep({ wt: d, base: "base", issue: 42, issueBody: BODY, precheckCommands: [TEST_CMD], runTmp: tmpDir("split-run-"), python: PY, git: gitFx(d), callGrouper: g.fn });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.package, "pkg.big_parts");
    assert.deepEqual(Object.keys(r.modules).sort(), ["aio", "consts", "helpers", "models"]);
    assert.equal(r.rest, null);
    assert.equal(r.grouped, true);
    assert.deepEqual(r.verify, { failures: [], ok: true });
    for (const f of ["__init__", "consts", "helpers", "aio", "models"]) assert.ok(existsSync(join(d, `pkg/big_parts/${f}.py`)), f);
    assert.equal(clean(d), "", "the move is committed");
    assert.match(git(d, "log", "-1", "--format=%s"), /^refactor\(split\): move 4 module\(s\) of pkg\/big.py into pkg.big_parts \(#42\)$/);
    const after = spawnSync("bash", ["-c", TEST_CMD], { cwd: d, encoding: "utf8", env: ENV });
    assert.equal(after.status, 0);
    assert.match(after.stderr, /OK \(skipped=1\)/);
    // the grouping call: exactly one, an empty cwd, and no line of the module body in its prompt
    assert.equal(g.calls.length, 1);
    const { prompt, opts } = g.calls[0];
    assert.deepEqual(readdirSync(opts.cwd), [], "grouping cwd is an empty scratch dir");
    for (const line of src.split("\n").map((l) => l.trim()).filter((l) => l.length > 20)) assert.ok(!prompt.includes(line), `prompt leaks a body line: ${line}`);
    assert.doesNotMatch(prompt, /"start"|"end"|import functools/);
    assert.match(renderSplitPrBody({ issue: 42, ...r }), /Closes #42$/);
  });

  it("R4: a large split is a chain; each PR moves one package slice, the next applies the carried plan with --extend and no LLM call", { skip: SKIP }, async () => {
    const d = fixtureRepo();
    const g = grouper(FULL);
    const r1 = await runSplitStep({ wt: d, base: "base", issue: 1, issueBody: BODY, precheckCommands: [TEST_CMD], runTmp: tmpDir("split-run-"), python: PY, git: gitFx(d), callGrouper: g.fn, maxLines: 1200 });
    assert.equal(r1.ok, true, r1.reason);
    assert.ok(r1.rest, "a remainder is carried");
    assert.ok(r1.lines <= 1200 || Object.keys(r1.modules).length === 1);
    git(d, "tag", "pr1");
    const chain = renderChainIssue({ parent: 1, target: r1.target, packageName: r1.packageName, rest: r1.rest, testCmd: TEST_CMD });
    const g2 = grouper({});
    const r2 = await runSplitStep({ wt: d, base: "pr1", issue: 2, issueBody: chain.body, precheckCommands: [], runTmp: tmpDir("split-run-"), python: PY, git: gitFx(d), callGrouper: g2.fn, maxLines: 100000 });
    assert.equal(r2.ok, true, r2.reason);
    assert.equal(g2.calls.length, 0, "a chained step makes no grouping call");
    assert.equal(r2.package, r1.package, "the same target package");
    assert.deepEqual(Object.keys(r2.modules).sort(), Object.keys(r1.rest).sort());
    assert.equal(r2.rest, null);
    assert.equal(g.calls.length, 1, "one grouping call for the whole split");
    assert.equal(spawnSync("bash", ["-c", TEST_CMD], { cwd: d, env: ENV }).status, 0);
  });

  for (const [kind, mutate] of [
    ["logic-diff", (d) => { const p = join(d, "pkg/big.py"); writeFileSync(p, readFileSync(p, "utf8").replace('VERSION = "1.0"', 'VERSION = "2.0"')); }],
    ["missing-symbol", (d) => { const p = join(d, "pkg/big.py"); const s = readFileSync(p, "utf8"); const m = /\ndef describe\(\)[^\n]*\n(?: {4}[^\n]*\n)+/.exec(s); writeFileSync(p, s.replace(m[0], "\n")); mkdirSync(join(d, "pkg/big_parts")); writeFileSync(join(d, "pkg/big_parts/__init__.py"), ""); writeFileSync(join(d, "pkg/big_parts/misc.py"), m[0].slice(1)); }],
    ["new-cycle", (d) => { writeFileSync(join(d, "pkg/cyc_a.py"), "import pkg.cyc_b\n"); writeFileSync(join(d, "pkg/cyc_b.py"), "import pkg.cyc_a\n"); }],
  ]) {
    it(`R3: verification fails the lane on a ${kind} and resets the worktree`, async () => {
      const d = fixtureRepo();
      const run = async (cmd, args, o) => {
        if (args.includes("-c") && args.includes("import libcst")) return { code: 0, stdout: "", stderr: "" };
        if (args.includes(SYMBOL_MOVE)) { mutate(d); return { code: 0, stdout: JSON.stringify({ status: "ok", package: "pkg.big_parts", modules: { misc: ["describe"] } }), stderr: "" }; }
        return defaultRun(cmd, args, o);
      };
      const r = await runSplitStep({ wt: d, base: "base", issue: 3, issueBody: BODY, precheckCommands: [TEST_CMD], runTmp: tmpDir("split-run-"), git: gitFx(d), run, callGrouper: grouper(FULL).fn });
      assert.equal(r.ok, false);
      assert.equal(r.code, OUTCOME_CODES.SPLIT_VERIFY_FAILED);
      assert.match(r.reason, new RegExp(`- ${kind}`));
      assert.equal(clean(d), "", "no partial edit survives");
      assert.equal(git(d, "rev-parse", "HEAD"), git(d, "rev-parse", "base"));
    });
  }

  it("R6: a non-Python target is refused as needs-human material before anything runs", async () => {
    const d = fixtureRepo();
    mkdirSync(join(d, "src")); writeFileSync(join(d, "src/big.ts"), "export const a = 1;\n");
    git(d, "add", "-A"); git(d, "commit", "-qm", "ts");
    const calls = [];
    const r = await runSplitStep({ wt: d, base: "base", issueBody: "<!-- FORGE:MAINT:refactor:split:src/big.ts -->", precheckCommands: [TEST_CMD], git: gitFx(d),
      run: async (...a) => { calls.push(a); return defaultRun(...a); }, callGrouper: grouper(FULL).fn });
    assert.deepEqual(r, { ok: false, code: OUTCOME_CODES.SPLIT_UNSUPPORTED, reason: "no codemod tool for ts: `src/big.ts` (the refactor:split mover supports Python only)" });
    assert.equal(calls.length, 0);
    assert.equal(clean(d), "");
  });

  it("R6: no libcst (probe or mover refusal) is split.unsupported with the reason and no partial edit", async () => {
    const d = fixtureRepo();
    const g = grouper(FULL);
    const r = await runSplitStep({ wt: d, base: "base", issueBody: BODY, precheckCommands: [TEST_CMD], git: gitFx(d), python: ["python3", "-I", "-S"], callGrouper: g.fn });
    assert.equal(r.code, OUTCOME_CODES.SPLIT_UNSUPPORTED);
    assert.match(r.reason, /libcst is not importable/);
    assert.equal(g.calls.length, 0, "refused before the grouping call");
    // the mover itself refusing for want of libcst (after baseline and grouping) also leaves nothing behind
    const run = async (cmd, args, o) => {
      if (args.includes("-c") && args.includes("import libcst")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes(SYMBOL_MOVE)) return defaultRun("python3", ["-I", "-S", ...args.slice(args.indexOf(SYMBOL_MOVE))], o);
      return defaultRun(cmd, args, o);
    };
    const r2 = await runSplitStep({ wt: d, base: "base", issueBody: BODY, precheckCommands: [TEST_CMD], runTmp: tmpDir("split-run-"), git: gitFx(d), run, callGrouper: grouper(FULL).fn });
    assert.equal(r2.code, OUTCOME_CODES.SPLIT_UNSUPPORTED);
    assert.match(r2.reason, /no codemod tool: libcst/);
    assert.equal(clean(d), "");
    assert.equal(git(d, "rev-parse", "HEAD"), git(d, "rev-parse", "base"));
  });

  it("R4/R5: a chained plan passes --package and --extend to the mover and makes no grouping call", async () => {
    const d = fixtureRepo();
    const body = renderChainIssue({ parent: 1, target: "pkg/big.py", packageName: "big_parts", rest: { models: FULL.models }, testCmd: TEST_CMD }).body;
    let moverArgs = null;
    const mover = intercept(SYMBOL_MOVE, (args) => { moverArgs = args; return { code: 3, stdout: JSON.stringify({ status: "refused", reason: "moved symbol Item_00 needs 'compute_00'" }), stderr: "" }; });
    const run = async (cmd, args, o) => (args.includes("-c") && args.includes("import libcst") ? { code: 0, stdout: "", stderr: "" } : mover(cmd, args, o));
    const g = grouper(FULL);
    const r = await runSplitStep({ wt: d, base: "base", issueBody: body, precheckCommands: [], runTmp: tmpDir("split-run-"), git: gitFx(d), run, python: ["python3"], callGrouper: g.fn });
    assert.equal(g.calls.length, 0);
    assert.ok(moverArgs.includes("--extend"));
    assert.equal(moverArgs[moverArgs.indexOf("--package") + 1], "big_parts");
    assert.equal(r.code, OUTCOME_CODES.SPLIT_PLAN_INVALID, "a plan the mover refuses (not for libcst) is plan_invalid");
    assert.match(r.reason, /symbol-move refused: moved symbol Item_00/);
    assert.equal(clean(d), "");
  });

  it("an unparseable grouping reply is split.plan_invalid with no edit", async () => {
    const d = fixtureRepo();
    const run = async (cmd, args, o) => (args.includes("-c") && args.includes("import libcst") ? { code: 0, stdout: "", stderr: "" } : defaultRun(cmd, args, o));
    const r = await runSplitStep({ wt: d, base: "base", issueBody: BODY, precheckCommands: [TEST_CMD], runTmp: tmpDir("split-run-"), git: gitFx(d), run, callGrouper: async () => "I cannot do that" });
    assert.equal(r.code, OUTCOME_CODES.SPLIT_PLAN_INVALID);
    assert.equal(clean(d), "");
  });

  it("the scripts the step calls exist", () => {
    for (const p of [SYMBOL_INDEX, SYMBOL_MOVE, REFACTOR_VERIFY]) assert.ok(existsSync(p), p);
  });
});
