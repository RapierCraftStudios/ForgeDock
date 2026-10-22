// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpDir } from "../tests/_tmp.mjs";
import { parseVerifierConfig, pickVerifierModel, sameModel, changedSymbols, callersOf, verifierBudget, verifierPrompt, parseVerifierFindings, findingsToFailures,
  renderVerifierNote, verifierReport, formatReport, VERIFIER_SYSTEM, DEFAULT_VERIFIER_MODEL, MAX_CALLER_LINES, COST_RATIO_BAR } from "./verifier.mjs";
import { citesFileLine, freshFix } from "./fixround.mjs";
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";

const fence = (o) => "```json\n" + JSON.stringify(o) + "\n```";

describe("#4397 verifier config and model", () => {
  it("defaults to off; unknown modes are off; bad model ids are dropped", () => {
    assert.deepEqual(parseVerifierConfig(), { mode: "off", model: null });
    assert.deepEqual(parseVerifierConfig({ mode: "shadow", model: "claude-haiku-5-5" }), { mode: "shadow", model: "claude-haiku-5-5" });
    assert.deepEqual(parseVerifierConfig({ mode: "loud", model: "rm -rf /" }), { mode: "off", model: null });
  });
  it("never returns the builder's configured or reported model", () => {
    assert.deepEqual(pickVerifierModel({}), { model: DEFAULT_VERIFIER_MODEL, swapped: false });
    assert.deepEqual(pickVerifierModel({ builderModel: "claude-opus-5-5" }), { model: DEFAULT_VERIFIER_MODEL, swapped: false });
    const s = pickVerifierModel({ builderModel: "sonnet" });
    assert.equal(s.swapped, true); assert.ok(!sameModel(s.model, "sonnet"));
    const r = pickVerifierModel({ configured: "claude-opus-5-5", builderReported: ["claude-opus-5-5[1m]"] });
    assert.equal(r.swapped, true); assert.notEqual(r.model, "claude-opus-5-5");
    const both = pickVerifierModel({ builderModel: "claude-opus-5-5", builderReported: ["claude-sonnet-5-5"] });
    assert.equal(both.model, "claude-haiku-5-5");
    for (const b of ["opus", "sonnet", "haiku", "claude-sonnet-5-5", "claude-opus-5-5"]) assert.ok(!sameModel(pickVerifierModel({ builderModel: b }).model, b), b);
  });
  it("sameModel: ids, [1m] suffixes and bare aliases; default never matches", () => {
    assert.ok(sameModel("claude-opus-5-5", "claude-opus-5-5[1m]"));
    assert.ok(sameModel("opus", "claude-opus-5-5"));
    assert.ok(!sameModel("claude-opus-5-5", "claude-sonnet-5-5"));
    assert.ok(!sameModel("default", "claude-sonnet-5-5"));
  });
});

describe("#4397 changed symbols and callers (deterministic facts)", () => {
  it("names from hunk headers and added/removed definitions across ecosystems", () => {
    const diff = [
      "diff --git a/src/a.js b/src/a.js", "--- a/src/a.js", "+++ b/src/a.js",
      "@@ -1,3 +1,4 @@ export function parseLimit(x) {", "+  if (x == null) return 0;",
      "+const clampRange = (lo, hi) => lo;", "-export async function oldThing() {}",
      "@@ -9 +9 @@ def load_config(path):", "+def save_config(path, data):",
      "@@ -3 +3 @@ func (s *Server) HandleLogin(w http.ResponseWriter) {", "+fn parse_header(x: &str) {}",
      "+class RateLimiter {", "+  if (x) {",
    ].join("\n");
    assert.deepEqual(changedSymbols(diff), ["parseLimit", "clampRange", "oldThing", "load_config", "save_config", "HandleLogin", "parse_header", "RateLimiter"]);
    assert.equal(changedSymbols(diff, { max: 2 }).length, 2);
    assert.deepEqual(changedSymbols(""), []);
  });
  it("callersOf excludes definitions and ignored paths, caps per symbol and in total, survives a git grep miss", async () => {
    const grep = async (a) => {
      const s = a.at(-1);
      if (s === "missing") throw new Error("exit 1");
      return [`src/a.js:1:export function ${s}(x) {`, `.forge-lean/x.md:2:${s}`, ...Array.from({ length: 20 }, (_, i) => `src/c${i}.js:${i + 1}:  ${s}(arg);`)].join("\n");
    };
    const out = await callersOf({ symbols: ["parseLimit", "missing"], gitGrep: grep, ignore: [".forge-lean/"] });
    assert.equal(out.length, 8);
    assert.ok(out.every((c) => c.symbol === "parseLimit" && /^src\/c\d+\.js:\d+: parseLimit\(arg\);$/.test(c.line)), JSON.stringify(out));
    const many = await callersOf({ symbols: Array.from({ length: 12 }, (_, i) => `sym${i}x`), gitGrep: grep });
    assert.equal(many.length, MAX_CALLER_LINES);
    assert.deepEqual(await callersOf({ symbols: ["x"] }), []);
  });
  it("callersOf runs the repo's own git grep -w (real repo)", async () => {
    const d = tmpDir("verifier-grep-");
    execFileSync("git", ["init", "-q", d]);
    writeFileSync(join(d, "lib.js"), "export function parseLimit(x) { return x; }\n");
    writeFileSync(join(d, "use.js"), "import { parseLimit } from './lib.js';\nparseLimit(5);\nparseLimitX(1);\n");
    execFileSync("git", ["-C", d, "add", "."]);
    const out = await callersOf({ symbols: ["parseLimit"], gitGrep: async (a) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8" }) });
    assert.deepEqual(out.map((c) => c.line), ["use.js:1: import { parseLimit } from './lib.js';", "use.js:2: parseLimit(5);"]);
  });
});

describe("#4397 size bound", () => {
  it("budget grows with the diff, between a floor and a ceiling", () => {
    const sizes = [0, 1024, 40 * 1024, 200 * 1024, 10 * 1024 * 1024];
    const bs = sizes.map(verifierBudget);
    for (let i = 1; i < bs.length; i++) { assert.ok(bs[i].maxMs >= bs[i - 1].maxMs); assert.ok(bs[i].maxTurns >= bs[i - 1].maxTurns); }
    assert.deepEqual(bs[0], { maxMs: 180000, maxTurns: 10 });
    assert.deepEqual(bs.at(-1), { maxMs: 900000, maxTurns: 40 });
    assert.ok(bs[2].maxMs > bs[0].maxMs && bs[2].maxMs < bs.at(-1).maxMs);
  });
});

describe("#4397 prompt: fresh context, no builder framing", () => {
  const args = { issue: { number: 7, title: "foo breaks", body: "foo crashes on null.\nNon-regression: bar() keeps returning 1." }, comments: [{ body: "maintainer: also empty string" }, { body: "<!-- FORGE:STARTED -->\nStarted" }],
    contract: { requirements: [{ id: "R1", quote: "foo handles null" }] }, diff: "diff --git a/src/foo.js b/src/foo.js\n+fix", files: ["src/foo.js"], callers: [{ symbol: "foo", line: "src/bar.js:3: foo(x)" }] };
  it("carries the issue, comments, contract, diff and callers, never a builder result", () => {
    const p = verifierPrompt(args);
    for (const needle of ["Issue #7: foo breaks", "Non-regression: bar() keeps returning 1.", "maintainer: also empty string", "\"R1\"", "+fix", "foo: src/bar.js:3: foo(x)", "src/foo.js"]) assert.ok(p.includes(needle), needle);
    assert.doesNotMatch(p, /builder_result|FORGE:STARTED|self_review|implementation/i);
    assert.match(verifierPrompt({ ...args, callers: [] }), /<callers>\n\(none found\)/);
  });
  it("system prompt is adversarial: boundaries, baselines, callers, repro test; untrusted inputs", () => {
    for (const needle of ["BREAK", "boundary", "baselines", "callers", "repro test", "untrusted data", "\"findings\""]) assert.ok(VERIFIER_SYSTEM.includes(needle), needle);
  });
});

describe("#4397 findings feed the remediation loop", () => {
  const exists = (p) => ["src/foo.js", "src/bar.js"].includes(p);
  it("keeps only findings at an existing file and a positive line", () => {
    const text = fence({ findings: [
      { file: "src/foo.js", line: 3, input: "foo(null)", expected: "0", actual: "throws TypeError", why: "no guard" },
      { file: "`src/bar.js:12`", input: "bar('')" },
      { file: "./src/foo.js", line: "4" },
      { file: "src/nope.js", line: 1 },
      { file: "src/foo.js", line: 0 },
      { file: "src/foo.js" },
      "junk",
    ] });
    const f = parseVerifierFindings(text, { pathExists: exists });
    assert.deepEqual(f.map((x) => `${x.file}:${x.line}`), ["src/foo.js:3", "src/bar.js:12", "src/foo.js:4"]);
    assert.equal(f[0].actual, "throws TypeError");
  });
  it("unparseable or shapeless replies are no findings", () => {
    for (const t of ["", "no json here", fence({ verdict: "PASS" }), "{not json}", null]) assert.deepEqual(parseVerifierFindings(t), []);
    assert.deepEqual(parseVerifierFindings(fence({ findings: [] })), []);
  });
  it("failures are conformance.regression citing file:line, so the fix round is a fresh session", () => {
    const fails = findingsToFailures([{ file: "src/foo.js", line: 3, input: "foo(null)", expected: "0", actual: "throws", why: "" }]);
    assert.equal(fails[0].code, OUTCOME_CODES.CONFORMANCE_REGRESSION);
    assert.equal(fails[0].kind, "verifier");
    assert.match(fails[0].detail, /^independent verifier: src\/foo\.js:3 input foo\(null\): throws \(expected 0\)$/);
    assert.ok(citesFileLine(fails));
    assert.ok(freshFix("conformance", fails));
    assert.deepEqual(findingsToFailures([]), []);
  });
  it("renders the FORGE:REVIEW section: advisory in shadow, nothing when skipped", () => {
    assert.equal(renderVerifierNote(null), "");
    assert.equal(renderVerifierNote({ skipped: "empty_diff" }), "");
    const s = renderVerifierNote({ mode: "shadow", model: "claude-opus-5-5", swapped: true, findings: [{ file: "src/foo.js", line: 3, input: "foo(`x`)", actual: "throws", expected: "", why: "" }] });
    assert.match(s, /### Independent verifier \(shadow, advisory\)/);
    assert.match(s, /swapped/);
    assert.match(s, /- `src\/foo\.js:3` input foo\('x'\): throws/);
    assert.match(renderVerifierNote({ mode: "enforce", model: "m", findings: [] }), /No concrete defect found\./);
    assert.match(renderVerifierNote({ mode: "shadow", model: "m", findings: [], error: "CLI_IDLE" }), /did not answer \(CLI_IDLE\)/);
  });
});

describe("#4397 report: findings and cost ratio from run logs", () => {
  it("counts runs by mode, findings, errors and the ratio against the 10% bar", () => {
    const log = (repo, ...vs) => [{ event: "RUN_START", repo }, ...vs.map((v) => ({ event: "VERIFIER", ...v }))];
    const r = verifierReport([
      log("o/a", { mode: "shadow", findings: 2, cost_usd: 0.05, implement_cost_usd: 1 }),
      log("o/a", { mode: "shadow", findings: 0, cost_usd: 0.3, implement_cost_usd: 1 }, { mode: "shadow", findings: 1, cost_usd: 0.1, implement_cost_usd: 2 }),
      log("o/a", { mode: "shadow", findings: 0, error: "x", cost_usd: 0 }),
      log("o/b", { mode: "enforce", skipped: "empty_diff", findings: 0, cost_usd: 0 }),
      [{ event: "RUN_START", repo: "o/c" }, { event: "CONFORMANCE" }],
      "junk",
    ]);
    assert.deepEqual(r["o/a"], { runs: 3, shadow: 3, enforce: 0, with_findings: 2, findings: 3, errors: 1, skipped: 0, ratio_median: 0.125, ratio_max: 0.2, over_bar: 1 });
    assert.equal(r["o/b"].skipped, 1); assert.equal(r["o/b"].ratio_median, null);
    assert.equal(r["o/c"], undefined);
    assert.equal(COST_RATIO_BAR, 0.1);
    assert.match(formatReport(r), /\| o\/a \| 3 \| 3 \| 0 \| 2 \| 3 \| 1 \| 0.125 \| 0.2 \| 1 \|/);
    assert.equal(formatReport({}), "No VERIFIER runs found.");
  });
});
