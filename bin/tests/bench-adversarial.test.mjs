import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./_tmp.mjs";
import { aggregateAdversarial, calibrateEvidence, gradeAdversarial, main, renderScorecard, runAdversarial, validateAdversarialCorpus } from "../../scripts/bench-adversarial.mjs";

const CORPUS_PATH = new URL("../../docs/eval/corpus/adversarial-v1.json", import.meta.url);
const corpus = () => JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
const byId = (id) => corpus().issues.find((i) => i.id === id);
const HEAD = "a".repeat(40);

test("the committed corpus is valid: 20 issues, at least 5 invalid, every kind present", () => {
  const c = validateAdversarialCorpus(corpus());
  assert.equal(c.issues.length, 20);
  assert.ok(c.issues.filter((i) => ["wrong-premise", "duplicate", "already-fixed"].includes(i.kind)).length >= 5);
  for (const k of ["valid", "wrong-premise", "duplicate", "already-fixed", "integration"]) assert.ok(c.issues.some((i) => i.kind === k), k);
});

test("validateAdversarialCorpus rejects a small corpus, too few invalid issues and malformed entries", () => {
  const c = corpus();
  assert.throws(() => validateAdversarialCorpus({ ...c, issues: c.issues.slice(0, 19) }), /at least 20 issues/);
  const fewInvalid = c.issues.map((i) => (i.kind === "already-fixed" || i.kind === "wrong-premise" ? { ...byId("adv-int-is-permutation"), id: i.id } : i));
  assert.throws(() => validateAdversarialCorpus({ ...c, issues: fewInvalid }), /at least 5 invalid/);
  const set = (id, patch) => ({ ...c, issues: c.issues.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
  assert.throws(() => validateAdversarialCorpus(set("adv-dup-chunks", { forbid_new_defs: [] })), /forbid_new_defs/);
  assert.throws(() => validateAdversarialCorpus(set("adv-int-count-runs", { must_touch: [] })), /must_touch/);
  assert.throws(() => validateAdversarialCorpus(set("adv-wp-chunked-tail", { evidence: undefined })), /needs evidence/);
  assert.throws(() => validateAdversarialCorpus(set("adv-valid-1293", { oracle: {} })), /oracle/);
  assert.throws(() => validateAdversarialCorpus(set("adv-af-triplewise", { kind: "bogus" })), /kind must be/);
  assert.throws(() => validateAdversarialCorpus({ ...c, base: "670b715" }), /base must be/);
});

test("gradeAdversarial counts wrong issues implemented, duplicates created and integration points missed", () => {
  const claimed = { claimed_fix: true }, none = { claimed_fix: false };
  assert.equal(gradeAdversarial({ issue: byId("adv-wp-chunked-tail"), row: claimed }).wrong_implemented, true);
  assert.equal(gradeAdversarial({ issue: byId("adv-wp-chunked-tail"), row: none }).wrong_implemented, false, "closing with evidence is the right outcome");
  assert.equal(gradeAdversarial({ issue: byId("adv-valid-1293"), row: claimed }).wrong_implemented, false);
  const dup = byId("adv-dup-chunks");
  assert.equal(gradeAdversarial({ issue: dup, row: claimed, added: ["def chunks(iterable, n):", "    pass"] }).duplicate_created, true);
  assert.equal(gradeAdversarial({ issue: dup, row: claimed, added: ["# reuse chunked"] }).duplicate_created, false);
  assert.equal(gradeAdversarial({ issue: dup, row: none, added: ["def chunks(x):"] }).duplicate_created, false);
  const int = byId("adv-int-is-permutation");
  assert.equal(gradeAdversarial({ issue: int, row: claimed, paths: ["more_itertools/more.py"] }).integration_missed, 2);
  assert.equal(gradeAdversarial({ issue: int, row: claimed, paths: int.must_touch }).integration_missed, 0);
  assert.equal(gradeAdversarial({ issue: int, row: none }).integration_missed, 3);
  assert.equal(gradeAdversarial({ issue: byId("adv-valid-1293"), row: claimed, paths: [] }).integration_missed, 0);
  assert.equal(gradeAdversarial({ issue: int, row: claimed }).has_oracle, false);
  assert.equal(gradeAdversarial({ issue: byId("adv-valid-1293"), row: claimed }).has_oracle, true);
});

const g = (arm, o) => ({ arm, kind: "valid", wrong_implemented: false, duplicate_created: false, integration_missed: 0, has_oracle: false, oracle_pass: false, cost_usd: 1, wall_ms: 10, ...o });

test("aggregateAdversarial and renderScorecard report the five metrics per arm with date, model and corpus revision", () => {
  const rows = [
    g("full", { kind: "wrong-premise" }), g("full", { kind: "duplicate" }), g("full", { kind: "valid", has_oracle: true, oracle_pass: true }), g("full", { kind: "integration", integration_missed: 1, cost_usd: 2 }),
    g("control", { kind: "wrong-premise", wrong_implemented: true }), g("control", { kind: "duplicate", wrong_implemented: true, duplicate_created: true }),
    g("control", { kind: "valid", has_oracle: true, oracle_pass: false }), g("control", { kind: "integration", integration_missed: 3, cost_usd: 3 }),
  ];
  const meta = { run_date: "2026-11-10", model: "claude-opus-5-5", corpus_revision: "adversarial-v1@670b715+abcd1234" };
  const a = aggregateAdversarial(rows, meta);
  assert.deepEqual(a.arms.full, { n: 4, invalid_n: 2, wrong_implemented: 0, duplicate_created: 0, integration_missed: 1, oracle_n: 1, oracle_pass_rate: 1, cost_usd: 5, wall_ms: 40, start_ms: 0, start_unobserved: 4, light_unobserved: 0 });
  assert.deepEqual([a.arms.control.wrong_implemented, a.arms.control.duplicate_created, a.arms.control.integration_missed, a.arms.control.oracle_pass_rate, a.arms.control.cost_usd], [2, 1, 3, 0, 6]);
  const md = renderScorecard(a);
  for (const s of ["2026-11-10", "claude-opus-5-5", "adversarial-v1@670b715+abcd1234", "Wrong issues implemented", "Duplicate implementations", "Integration points missed", "Oracle pass rate", "Cost", "Wall time", "| full | control |"]) assert.ok(md.includes(s), s);
  assert.equal(aggregateAdversarial([], meta).arms.full.oracle_pass_rate, null);
});

test("aggregateAdversarial sums start_ms and counts rows without one as start_unobserved (#5620)", () => {
  const meta = { run_date: "2026-11-10", model: "m", corpus_revision: "r" };
  const a = aggregateAdversarial([g("full", { start_ms: 3000 }), g("full", { start_ms: 1500 }), g("full", { start_ms: null }), g("control", {})], meta);
  assert.equal(a.arms.full.start_ms, 4500); assert.equal(a.arms.full.start_unobserved, 1);
  assert.equal(a.arms.control.start_ms, 0); assert.equal(a.arms.control.start_unobserved, 1);
  const md = renderScorecard(a);
  assert.ok(md.includes("| Sandbox start (ms, sum) | 4500 | 0 |"), md);
  assert.ok(md.includes("start_unobserved"));
});

test("calibrateEvidence checks each evidence pattern against the file at the base", async () => {
  const c = corpus();
  const run = async (cmd, args) => {
    if (cmd === "git" && args[0] === "show") return { code: 0, stdout: args[1].endsWith("recipes.py") ? "def other(" : "def chunked(", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = await calibrateEvidence({ corpus: c, run, tmp: "/nonexistent" });
  assert.equal(res.length, c.issues.filter((i) => i.evidence).length);
  assert.equal(res.find((r) => r.id === "adv-dup-chunks").evidence_ok, true);
  assert.equal(res.find((r) => r.id === "adv-dup-flatten-once").evidence_ok, false, "recipes.py lacks the pattern at the base");
});

/** A fake runner for the real runArm: the arm's diff touches `paths` and adds `added`. */
function fakeRun({ paths = [], added = [], claude = { is_error: false, total_cost_usd: 0.5, duration_ms: 1000 }, full = {} } = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "claude") return { code: 0, stdout: JSON.stringify(claude), stderr: "" };
    if (cmd === "forgedock") {
      const rf = args[args.indexOf("--result-file") + 1], n = args[1];
      if (full[n]) writeFileSync(rf, JSON.stringify(full[n]));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
    if (cmd === "git" && args[0] === "diff" && args[1] === "--quiet") return { code: paths.length ? 1 : 0, stdout: "", stderr: "" };
    if (cmd === "git" && args[0] === "diff" && args[1] === "--name-only") return { code: 0, stdout: paths.join("\n"), stderr: "" };
    if (cmd === "git" && args[0] === "diff" && args[1] === "-U0") return { code: 0, stdout: added.map((l) => `+${l}`).join("\n"), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

test("runAdversarial: a control arm that implements a duplicate is graded wrong and duplicate; issues without an oracle are never overlaid", async () => {
  const tmp = tmpDir("bench-adv-test-"), c = corpus();
  const cfg = { arms: { control: { model: "claude-opus-5-5" } } };
  const { run, calls } = fakeRun({ paths: ["more_itertools/recipes.py"], added: ["def pairs(iterable):"] });
  const rows = await runAdversarial({ corpus: c, cfg, arms: ["control"], issues: ["adv-dup-consecutive-pairs"], run, tmp, apiShape: undefined });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wrong_implemented, true); assert.equal(rows[0].duplicate_created, true);
  assert.equal(rows[0].oracle_pass, false); assert.equal(rows[0].cost_usd, 0.5);
  assert.ok(!calls.some((x) => x[0] === "git" && x[1] === "fetch"), "no fix sha to fetch");
  assert.ok(!calls.some((x) => x[0] === "git" && x[1] === "checkout" && x.includes("--") && x.includes(HEAD)));
});

test("CLI: validate, run (control arm) and aggregate write rows and a scorecard", async () => {
  const tmp = tmpDir("bench-adv-cli-"), cp = new URL("../../docs/eval/corpus/adversarial-v1.json", import.meta.url).pathname;
  const out = { s: "", write(x) { this.s += x; } }, err = { s: "", write(x) { this.s += x; } };
  assert.equal(await main(["validate", "--corpus", cp], { out, err }), 0);
  assert.equal(JSON.parse(out.s).invalid, 12);
  const cfgPath = join(tmp, "cfg.json"), rows = join(tmp, "rows.jsonl"), sc = join(tmp, "score.md");
  writeFileSync(cfgPath, JSON.stringify({ arms: { control: { model: "claude-opus-5-5" } } }));
  const { run } = fakeRun({ paths: ["more_itertools/more.py"] });
  assert.equal(await main(["run", "--corpus", cp, "--config", cfgPath, "--out", rows, "--arms", "control", "--issues", "adv-int-is-permutation,adv-wp-one-empty"], { run, out, err }), 0);
  const lines = readFileSync(rows, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((r) => [r.id, r.wrong_implemented, r.integration_missed]), [["adv-wp-one-empty", true, 0], ["adv-int-is-permutation", false, 2]]);
  const o2 = { s: "", write(x) { this.s += x; } };
  assert.equal(await main(["aggregate", rows, "--corpus", cp, "--model", "claude-opus-5-5", "--date", "2026-11-10", "--scorecard", sc], { out: o2, err }), 0);
  assert.match(readFileSync(sc, "utf8"), /Run date: 2026-11-10[\s\S]*Model: claude-opus-5-5[\s\S]*Corpus revision: adversarial-v1@670b715\+[0-9a-f]{8}/);
  assert.equal(JSON.parse(o2.s).arms.control.wrong_implemented, 1);
  assert.equal(await main(["aggregate", rows, "--corpus", cp, "--model", "m", "--date", "yesterday"], { out: o2, err }), 1);
  assert.equal(await main(["bogus"], { out, err }), 1);
});

test("CLI run with both arms: the full lane closes the invalid issue, the control implements it; both land in the scorecard", async () => {
  const tmp = tmpDir("bench-adv-both-"), cp = new URL("../../docs/eval/corpus/adversarial-v1.json", import.meta.url).pathname;
  const out = { s: "", write(x) { this.s += x; } }, err = { s: "", write(x) { this.s += x; } };
  const cfgPath = join(tmp, "cfg.json"), rows = join(tmp, "rows.jsonl"), sc = join(tmp, "score.md");
  writeFileSync(cfgPath, JSON.stringify({ arms: { full: { repo: "acme/sandbox", issues: Object.fromEntries(corpus().issues.map((i, k) => [i.id, k + 1])) }, control: { model: "claude-opus-5-5" } } }));
  const { run } = fakeRun({ paths: ["more_itertools/more.py"], full: { 5: { terminalReason: "closed-invalid", cost_usd: 0.2, wall_ms: 500, model_ms: 400 } } });
  assert.equal(await main(["run", "--corpus", cp, "--config", cfgPath, "--out", rows, "--issues", "adv-wp-one-empty"], { run, out, err }), 0, err.s);
  const lines = readFileSync(rows, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((r) => [r.arm, r.wrong_implemented]), [["full", false], ["control", true]]);
  assert.equal(lines[0].terminal, "closed-invalid", "the full row came from the result file");
  assert.equal(await main(["aggregate", rows, "--corpus", cp, "--model", "claude-opus-5-5", "--date", "2026-11-10", "--scorecard", sc], { out, err }), 0);
  assert.match(readFileSync(sc, "utf8"), /Wrong issues implemented[^\n]*\| 0 of 1 invalid \| 1 of 1 invalid \|/);
});

test("the corpus has no integration row that only aliases an existing helper (take_until == takewhile_inclusive, #5541)", () => {
  const ids = corpus().issues.map((i) => i.id);
  assert.ok(!ids.includes("adv-int-take-until"));
  // Public names at the corpus base (more_itertools/more.py __all__ @670b715) that an integration row must not re-request.
  const shipped = /\b(take_until|takewhile_inclusive|argmax|argmin|iequals|minmax|run_length|circular_shifts)\(/;
  for (const i of corpus().issues.filter((x) => x.kind === "integration")) assert.ok(!shipped.test(i.title), `${i.id} asks for a helper the base already ships`);
  assert.equal(byId("adv-int-is-permutation").kind, "integration");
});

test("runAdversarial marks a row without a light field as light_unobserved", async () => {
  const tmp = tmpDir("bench-adv-light-"), c = corpus();
  const n = Object.fromEntries(c.issues.map((i, k) => [i.id, k + 1]));
  const cfg = { arms: { full: { repo: "acme/sandbox", issues: n } } };
  const full = { [n["adv-valid-1293"]]: { terminalReason: "merged", cost_usd: 0.5, wall_ms: 1, model_ms: 1 }, [n["adv-valid-1304"]]: { terminalReason: "merged", light: false, cost_usd: 0.5, wall_ms: 1, model_ms: 1 } };
  const { run } = fakeRun({ full });
  const rows = await runAdversarial({ corpus: c, cfg, arms: ["full"], issues: ["adv-valid-1293", "adv-valid-1304"], run, tmp });
  assert.deepEqual(rows.map((r) => [r.id, r.light, r.light_unobserved]), [["adv-valid-1293", null, true], ["adv-valid-1304", false, false]]);
  const sc = aggregateAdversarial(rows, { run_date: "2026-11-12", model: "m", corpus_revision: "r" });
  assert.equal(sc.arms.full.light_unobserved, 1);
  assert.equal(sc.arms.control.light_unobserved, 0);
  assert.match(renderScorecard(sc), /light_unobserved/);
});
