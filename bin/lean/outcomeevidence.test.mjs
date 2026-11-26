// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { parseOutcomeEvidenceConfig, touchedAreas, outcomeEvidenceFailures, rawChecksAt } from "./outcomeevidence.mjs";

const cfg = parseOutcomeEvidenceConfig({ paths: { triage: "[src/triage/**, src/classify.ts]" }, corpus: { triage: ["corpus/triage/**"] } });
const have = new Set(["corpus/triage/replay.jsonl"]);
const exists = (p) => have.has(p);
const good = { area: "triage", metric: "precision", corpus: "corpus/triage/replay.jsonl", before: 0.81, after: 0.86, better: "higher" };
const run = (o) => outcomeEvidenceFailures({ cfg, files: ["src/triage/rules.ts"], exists, ...o });

test("config: absent, empty or path-less sections are off; globs parse from strings and arrays", () => {
  assert.equal(parseOutcomeEvidenceConfig(undefined), null);
  assert.equal(parseOutcomeEvidenceConfig({}), null);
  assert.equal(parseOutcomeEvidenceConfig({ corpus: { a: "c/**" } }), null);
  assert.deepEqual(cfg, { paths: { triage: ["src/triage/**", "src/classify.ts"] }, corpus: { triage: ["corpus/triage/**"] } });
  assert.deepEqual(outcomeEvidenceFailures({ cfg: null, files: ["src/triage/rules.ts"] }), []);
});

test("an untouched area, a test-only or corpus-only change passes", () => {
  assert.deepEqual(outcomeEvidenceFailures({ cfg, files: ["src/other.ts"], exists }), []);
  assert.deepEqual(outcomeEvidenceFailures({ cfg, files: ["src/triage/rules.test.ts", "corpus/triage/replay.jsonl"], exists }), []);
  assert.deepEqual(touchedAreas(cfg, ["src/classify.ts", "src/x.ts"]), { triage: ["src/classify.ts"] });
});

test("a touched area with no result row fails with the area, files and required shape", () => {
  const f = run({ result: {} });
  assert.equal(f.length, 1);
  assert.equal(f[0].code, "conformance.unimplemented");
  assert.equal(f[0].kind, "outcome_evidence_missing");
  assert.match(f[0].detail, /'triage'/);
  assert.match(f[0].detail, /src\/triage\/rules\.ts/);
  assert.match(f[0].detail, /result\.outcome_evidence/);
  assert.match(f[0].detail, /corpus\/triage\/\*\*/);
});

test("bad rows fail as invalid: no metric, undeclared or absent corpus, non-numeric values, unknown better", () => {
  const kinds = (row) => run({ result: { outcome_evidence: [{ ...good, ...row }] } }).map((x) => `${x.kind}: ${x.detail}`);
  assert.match(kinds({ metric: "" })[0], /outcome_evidence_invalid: .*metric is missing/);
  assert.match(kinds({ corpus: "test/mocks/fake.json" })[0], /not a declared corpus/);
  assert.match(kinds({ corpus: "corpus/triage/missing.jsonl" })[0], /does not exist/);
  assert.match(kinds({ corpus: "" })[0], /corpus is missing/);
  assert.match(kinds({ before: "n/a" })[0], /must be numbers/);
  assert.match(kinds({ after: null })[0], /must be numbers/);
  assert.match(kinds({ better: "up" })[0], /better must be/);
});

test("a worse after fails as regressed; lower-is-better is honoured", () => {
  const f = run({ result: { outcome_evidence: [{ ...good, after: 0.7 }] } });
  assert.deepEqual(f.map((x) => x.kind), ["outcome_evidence_regressed"]);
  assert.match(f[0].detail, /before 0\.81, after 0\.7/);
  assert.deepEqual(run({ result: { outcome_evidence: [{ ...good, metric: "p95_ms", before: 120, after: 90, better: "lower" }] } }), []);
  assert.equal(run({ result: { outcome_evidence: [{ ...good, metric: "p95_ms", before: 90, after: 120, better: "lower" }] } })[0].kind, "outcome_evidence_regressed");
});

test("a good row passes", () => {
  assert.deepEqual(run({ result: { outcome_evidence: [good] } }), []);
  assert.deepEqual(run({ result: { outcome_evidence: [{ ...good, before: "0.5", after: "0.5" }] } }), [], "numeric strings and an unchanged value pass");
});

test("a post-deploy check for a touched area needs a metric baseline, not a string match", () => {
  const contract = { requirements: [{ id: "R3", disposition: "post-deploy", check: "triage-rate" }] };
  const base = { result: { outcome_evidence: [good] }, contract };
  const f = run({ ...base, checks: { "triage-rate": { run: "curl x", pass: "/ok/" } } });
  assert.deepEqual(f.map((x) => x.kind), ["outcome_evidence_baseline_missing"]);
  assert.match(f[0].detail, /R3 post-deploy check 'triage-rate'.*baseline/);
  assert.equal(run({ ...base, checks: { "triage-rate": { run: "x", baseline: { metric: "precision", value: "high" } } } }).length, 1);
  assert.deepEqual(run({ ...base, checks: { "triage-rate": { run: "x", baseline: { metric: "precision", value: 0.81, better: "higher" } } } }), []);
  assert.deepEqual(run({ ...base, checks: {} }), [], "an unknown check id is check_unknown's finding");
  assert.deepEqual(outcomeEvidenceFailures({ cfg, files: ["src/other.ts"], contract, checks: { "triage-rate": { run: "x" } } }), [], "untouched area: no baseline demand");
});

test("rawChecksAt keeps the baseline field and lets later refs win", async () => {
  const files = { base: JSON.stringify({ a: { run: "x" } }), HEAD: JSON.stringify({ a: { run: "y", baseline: { metric: "m", value: 1 } }, b: "z" }) };
  const git = async ([, spec]) => { const ref = spec.split(":")[0]; if (!files[ref]) throw new Error("none"); return files[ref]; };
  assert.deepEqual(await rawChecksAt(git, ["base", "HEAD", "missing"]), { a: { run: "y", baseline: { metric: "m", value: 1 } }, b: { run: "z" } });
});
