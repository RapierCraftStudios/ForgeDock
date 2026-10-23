import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./_tmp.mjs";
import { aggregate, calibrate, main, parseRows, runArm, validateCorpus, validateRunConfig } from "../../scripts/bench-lightlane.mjs";

const CORPUS_PATH = new URL("../../docs/eval/corpus/lightlane-v1.json", import.meta.url);
const corpus = () => JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
const HEAD = "a".repeat(40);
const CFG = {
  arms: {
    light: { repo: "acme/sandbox-light", issues: { "lightlane-1293": 11, "lightlane-1304": 12, "lightlane-1308": 13 } },
    full: { repo: "acme/sandbox-full", issues: { "lightlane-1293": 21, "lightlane-1304": 22, "lightlane-1308": 23 } },
    control: { model: "claude-opus-5-5" },
  },
};

/** A fake process runner: records every call; the oracle passes unless `oracle` is false. */
function fakeRun({ result = null, control = null, oracle = true, diff = 1 } = {}) {
  const calls = [];
  const run = async (cmd, args, opts = {}) => {
    calls.push([cmd, ...args]);
    if (cmd === "forgedock") {
      if (result) writeFileSync(args[args.indexOf("--result-file") + 1], JSON.stringify(result));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "claude") return { code: 0, stdout: JSON.stringify(control), stderr: "" };
    if (cmd === "gh") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
    if (cmd === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
    if (cmd === "git" && args[0] === "diff") return { code: diff, stdout: "", stderr: "" };
    if (cmd === "sh") return { code: /unittest -q tests\.test_more\./.test(args[1]) ? (oracle ? 0 : 1) : 0, stdout: "", stderr: "", cwd: opts.cwd };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const withTmp = async (f) => f(tmpDir("bench-ll-test-"));

test("the committed corpus is valid: base 670b715, upstream #1293/#1304/#1308 with full fix shas and oracle commands", () => {
  const c = validateCorpus(corpus());
  assert.equal(c.base, "670b715b307adfe5d2fca08a87ca562cb8bfea2c");
  assert.deepEqual(c.issues.map((i) => i.upstream_issue), [1293, 1304, 1308]);
  for (const i of c.issues) assert.match(i.oracle.command, /^python3 -m unittest -q tests\.test_more\.\w+\.test_\w+/);
  assert.match(c.control_prompt, /\{title\}[\s\S]*\{body\}/);
});

test("validateCorpus and validateRunConfig reject bad input", () => {
  assert.throws(() => validateCorpus({ ...corpus(), base: "670b715" }), /base must be a full/);
  assert.throws(() => validateCorpus({ ...corpus(), issues: [{ ...corpus().issues[0], oracle: {} }] }), /oracle/);
  const c = corpus();
  assert.throws(() => validateRunConfig({ arms: { light: { repo: "acme/x", issues: {} } } }, c, ["light"]), /issues\.lightlane-1293/);
  assert.throws(() => validateRunConfig({ arms: { control: {} } }, c, ["control"]), /model/);
  assert.equal(validateRunConfig(CFG, c, ["light", "full", "control"]), CFG);
});

test("runArm light: runs run-issue with the result file, reads true cost/wall/model and the light fields, grades the PR head", async () => {
  await withTmp(async (tmp) => {
    const c = corpus(), issue = c.issues[1];
    const result = { terminalReason: "merged", pr: 77, cost_usd: 0.41, wall_ms: 200000, model_ms: 180000, light: true, light_eligibility: "eligible" };
    const { run, calls } = fakeRun({ result });
    let ticks = 0;
    const shapes = [];
    const row = await runArm({ arm: "light", issue, corpus: c, cfg: CFG, run, tmp, now: () => (ticks += 1000), apiShape: async (x) => { shapes.push(x); return { status: "none", changes: [], unknown: [] }; } });
    assert.deepEqual(calls[0], ["forgedock", "run-issue", "12", "--repo", "acme/sandbox-light", "--result-file", join(tmp, "light-lightlane-1304-result.json")]);
    assert.ok(calls.some((x) => x[0] === "gh" && x.includes("77") && x.includes("headRefOid")));
    assert.ok(calls.some((x) => x[0] === "git" && x[1] === "fetch" && x.includes("refs/pull/77/head")));
    assert.ok(calls.some((x) => x[0] === "git" && x[1] === "checkout" && x.includes(issue.fix_sha) && x.includes("tests/test_more.py")), "oracle files overlaid from the fix");
    const suiteAt = calls.findIndex((x) => x[0] === "sh" && x[2] === c.suite_command), oracleAt = calls.findIndex((x) => x[0] === "sh" && x[2] === issue.oracle.command);
    assert.ok(suiteAt >= 0 && oracleAt > suiteAt, "own suite runs before the oracle overlay");
    assert.equal(shapes[0].base, c.base);
    assert.deepEqual(row, { arm: "light", id: issue.id, cost_usd: 0.41, wall_ms: 200000, model_ms: 180000, harness_wall_ms: 1000, claimed_fix: true, oracle_pass: true, suite_pass: true,
      api_shape: { status: "none", changes: [] }, light: true, light_eligibility: "eligible", light_upgrade: null, terminal: "merged" });
  });
});

test("runArm full: a claimed fix that fails the oracle is a false fix candidate; an upgraded light result keeps its reasons", async () => {
  await withTmp(async (tmp) => {
    const c = corpus(), issue = c.issues[0];
    const { run } = fakeRun({ oracle: false, result: { terminalReason: "ci-pending", branch: "feat/issue-21", cost_usd: 1.1, wall_ms: 9, model_ms: 3, light: false, light_eligibility: "eligible", light_upgrade: ["api_shape"] } });
    const row = await runArm({ arm: "full", issue, corpus: c, cfg: CFG, run, tmp, apiShape: async () => ({ status: "changed", changes: [{ symbol: "seekable", change: "signature" }] }) });
    assert.equal(row.claimed_fix, true); assert.equal(row.oracle_pass, false);
    assert.deepEqual(row.light_upgrade, ["api_shape"]); assert.equal(row.api_shape.status, "changed");
  });
});

test("runArm without a PR or branch grades nothing; oracle_pass stays false and nothing is claimed", async () => {
  await withTmp(async (tmp) => {
    const c = corpus();
    const { run, calls } = fakeRun({ result: { terminalReason: "needs-human", cost_usd: 0.2 } });
    const row = await runArm({ arm: "light", issue: c.issues[2], corpus: c, cfg: CFG, run, tmp, apiShape: async () => assert.fail("not graded") });
    assert.equal(row.claimed_fix, false); assert.equal(row.oracle_pass, false); assert.equal(row.terminal, "needs-human");
    assert.ok(!calls.some((x) => x[0] === "sh"));
  });
});

test("runArm control: claude -p with the filled prompt; cost and time from its JSON; the working tree is committed and graded", async () => {
  await withTmp(async (tmp) => {
    const c = corpus(), issue = c.issues[2];
    const { run, calls } = fakeRun({ control: { type: "result", is_error: false, total_cost_usd: 0.45, duration_ms: 300000, duration_api_ms: 200000 } });
    const row = await runArm({ arm: "control", issue, corpus: c, cfg: CFG, run, tmp, apiShape: async () => ({ status: "none", changes: [] }) });
    const cl = calls.find((x) => x[0] === "claude");
    assert.equal(cl[1], "-p"); assert.ok(cl[2].includes(issue.title) && cl[2].includes(issue.body));
    assert.deepEqual(cl.slice(3), ["--output-format", "json", "--model", "claude-opus-5-5"]);
    assert.ok(calls.some((x) => x[0] === "git" && x.includes("commit")));
    assert.equal(row.cost_usd, 0.45); assert.equal(row.wall_ms, 300000); assert.equal(row.model_ms, 300000);
    assert.equal(row.claimed_fix, true); assert.equal(row.oracle_pass, true); assert.equal(row.light, null);
  });
});

test("calibrate: the oracle must fail on the base and pass on the fix", async () => {
  const c = corpus();
  let onFix = false;
  const run = async (cmd, args) => {
    if (cmd === "git" && args[0] === "checkout" && args.includes("-f")) onFix = args.includes(c.base) ? false : true;
    if (cmd === "sh") return { code: onFix ? 0 : 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = await calibrate({ corpus: c, run, tmp: "/nonexistent" });
  assert.deepEqual(res.map((r) => [r.id, r.red_on_base, r.green_on_fix]), c.issues.map((i) => [i.id, true, true]));
});

const row = (arm, id, o = {}) => ({ arm, id, cost_usd: 1, wall_ms: 100, model_ms: 100, claimed_fix: true, oracle_pass: true, suite_pass: true, api_shape: { status: "none", changes: [] },
  light: arm === "light" ? true : null, light_eligibility: arm === "control" ? null : "eligible", light_upgrade: null, ...o });

test("aggregate: per-arm cost, wall, model time, oracle pass and false-fix; targets judged on eligible light rows", () => {
  const rows = [
    row("light", "a", { cost_usd: 0.5, wall_ms: 120, model_ms: 100 }), row("light", "b", { cost_usd: 0.5, wall_ms: 120, model_ms: 100 }),
    row("light", "c", { light_eligibility: "ineligible", light: false, cost_usd: 9, wall_ms: 900, model_ms: 100 }),
    row("full", "a", { cost_usd: 0.8 }), row("full", "b", { cost_usd: 0.8, oracle_pass: false }),
    row("control", "a", { cost_usd: 0.45 }), row("control", "b", { cost_usd: 0.45 }), row("control", "c", { cost_usd: 0.45 }),
  ];
  const a = aggregate(rows);
  assert.deepEqual(Object.keys(a.arms), ["light", "full", "control"]);
  assert.equal(a.arms.full.false_fix_rate, 0.5); assert.equal(a.arms.full.oracle_pass_rate, 0.5);
  assert.equal(a.arms.light.cost_usd.sum, 10);
  assert.deepEqual(a.light_eligible.ids, ["a", "b"]);
  assert.equal(a.light_eligible.control_cost_usd, 0.9);
  assert.deepEqual(a.targets.cost_le_1_2x_control, { pass: true, value: 1.1111, limit: 1.2 });
  assert.deepEqual(a.targets.wall_le_1_3x_model, { pass: true, value: 1.2, limit: 1.3 });
  assert.equal(a.targets.oracle_ge_control.pass, true); assert.equal(a.targets.false_fix_le_control.pass, true);
  assert.deepEqual(a.targets.zero_undetected_api_shape, { pass: true, value: 0, limit: 0 });
});

test("aggregate: failing targets, an undetected API-shape change, and null when an arm is missing", () => {
  const a = aggregate([
    row("light", "a", { cost_usd: 2, wall_ms: 500, model_ms: 100, oracle_pass: false, api_shape: { status: "changed", changes: [{}] } }),
    row("light", "b", { light: false, light_upgrade: ["api_shape"], api_shape: { status: "changed", changes: [{}] } }),
    row("control", "a", { cost_usd: 1 }), row("control", "b", { cost_usd: 1 }),
  ]);
  assert.equal(a.targets.cost_le_1_2x_control.pass, false);
  assert.equal(a.targets.wall_le_1_3x_model.pass, false);
  assert.equal(a.targets.oracle_ge_control.pass, false); assert.equal(a.targets.false_fix_le_control.pass, false);
  assert.deepEqual(a.targets.zero_undetected_api_shape, { pass: false, value: 1, limit: 0 }, "the upgraded lane detected its change; the light finish did not");
  const none = aggregate([row("light", "a")]);
  assert.equal(none.targets.cost_le_1_2x_control.pass, null); assert.equal(none.targets.oracle_ge_control.pass, null);
});

test("CLI aggregate reads JSONL and exits 2 when a target fails, 0 when all pass or are unknown", async () => {
  await withTmp(async (tmp) => {
    const f = join(tmp, "rows.jsonl"), out = { s: "", write(x) { this.s += x; } }, err = { write() {} };
    writeFileSync(f, [row("light", "a", { cost_usd: 5 }), row("control", "a")].map((r) => JSON.stringify(r)).join("\n") + "\n");
    assert.equal(await main(["aggregate", f], { out, err }), 2);
    assert.equal(JSON.parse(out.s).targets.cost_le_1_2x_control.pass, false);
    writeFileSync(f, JSON.stringify(row("light", "a")) + "\n");
    assert.equal(await main(["aggregate", f], { out: { write() {} }, err }), 0);
    assert.equal(await main(["bogus"], { out, err }), 1);
    assert.deepEqual(parseRows("[]"), []);
  });
});
