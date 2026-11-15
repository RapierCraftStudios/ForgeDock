// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCiFailure, failFastDecision, failFastPolicy, DOWNSTREAM_CLASSES } from "./ci-classify.mjs";
import { signatureHash } from "./release-flakes.mjs";

const S = "deterministic-setup", G = "generated-artifact-stale", I = "infra", C = "code";
const step = (want, ...lines) => ({ want, step: "build", lines });
const tst = (want, message, ...lines) => ({ want, step: "unit", lines, test: { id: "t1", message } });

/** Real-shaped excerpts: node, python, go, docker. */
export const CORPUS = [
  // deterministic-setup
  step(S, "sh: 1: tsc: command not found", "npm ERR! code ELIFECYCLE"),
  step(S, "/home/runner/work/_temp/abc.sh: line 2: pnpm: command not found"),
  step(S, "exec: \"golangci-lint\": executable file not found in $PATH"),
  step(S, "npm ERR! code ERESOLVE", "npm ERR! ERESOLVE could not resolve", "npm ERR! Found: react@18.2.0"),
  step(S, "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date with package.json"),
  step(S, "npm ERR! `npm ci` can only install packages when your package.json and package-lock.json are in sync."),
  step(S, "ERROR: No matching distribution found for private-lib==2.0", "ERROR: Could not find a version that satisfies the requirement private-lib==2.0"),
  step(S, "error: poetry.lock is not up to date with pyproject.toml"),
  step(S, "go: updates to go.mod needed; to update it:", "\tgo mod tidy"),
  step(S, "Error response from daemon: manifest for ghcr.io/org/base:v9 not found: manifest unknown: manifest unknown"),
  step(S, "docker: Error response from daemon: pull access denied for acme/builder, repository does not exist or may require 'docker login'"),
  step(S, "npm ERR! Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/foo'"),
  step(S, "ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@acme%2fprivate: Not Found - 404"),
  step(S, "bash: uv: command not found"),
  // generated-artifact-stale
  step(G, "error: generated files are out of date", "run `pnpm codegen` and commit the result"),
  step(G, "The OpenAPI client is out of date. Run `make gen-client` to regenerate."),
  step(G, "git diff --exit-code failed: working tree is not clean after running generate", " M src/schema.ts"),
  step(G, "Schema drift detected between prisma/schema.prisma and the database snapshot"),
  step(G, "types.d.ts is stale; please run `npm run build:types` and commit"),
  step(G, "check-generated: FAIL files differ from committed"),
  step(G, "protobuf bindings out of date, run `buf generate`"),
  // infra
  step(I, "Error: Unable to upload artifact: storage quota"),
  step(I, "The runner has received a shutdown signal."),
  step(I, "FATAL: database system is starting up"),
  step(I, "npm ERR! network request failed: ETIMEDOUT"),
  step(I, "curl: (6) Could not resolve host: files.pythonhosted.org"),
  step(I, "fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 503 Service Unavailable"),
  tst(I, "connect ECONNRESET 10.0.0.3:443"),
  // code
  tst(C, "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 1 !== 2", "not ok 4 - adds"),
  tst(C, "Error: Cannot find module './util' imported from src/app.ts"),
  tst(C, "E   assert 3 == 4", "FAILED tests/test_calc.py::test_add - assert 3 == 4"),
  tst(C, "E   ModuleNotFoundError: No module named 'app.helpers'"),
  tst(C, "--- FAIL: TestParse (0.00s)", "    parse_test.go:21: got 3, want 4"),
  tst(C, "expect(received).toBe(expected) // Object.is equality: Expected: 5 Received: 4"),
  step(C, "src/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'."),
  step(C, "/src/a.js\n  3:7  error  'x' is assigned a value but never used  no-unused-vars", "✖ 1 problem (1 error, 0 warnings)"),
  step(C, "mypy: pkg/mod.py:9: error: Incompatible return value type (got \"str\", expected \"int\")"),
  step(C, "./main.go:14:2: undefined: Frobnicate", "FAIL\texample.com/m [build failed]"),
  step(C, "ruff: F401 `os` imported but unused"),
  tst(C, "panic: runtime error: index out of range [3] with length 3"),
  step(C, "Dockerfile:12 RUN make test failed: test_widget: expected 3 got 4"),
  step(C, "error[E0308]: mismatched types", " --> src/lib.rs:4:5"),
  // flaky-suspect is exercised separately via the ledger.
];

describe("classifyCiFailure corpus (#5690)", () => {
  it("accuracy >= 90% overall, 100% setup precision, >= 5 per class and >= 40 excerpts", () => {
    const rows = {};
    let ok = 0, setupFalse = 0;
    for (const c of CORPUS) {
      const got = classifyCiFailure(c).class;
      const r = (rows[c.want] ??= { n: 0, ok: 0 });
      r.n++;
      if (got === c.want) { r.ok++; ok++; }
      if (got === S && c.want !== S) setupFalse++;
    }
    const table = Object.entries(rows).map(([cls, r]) => ({ class: cls, total: r.n, correct: r.ok, pct: `${Math.round((100 * r.ok) / r.n)}%` }));
    table.push({ class: "ALL", total: CORPUS.length, correct: ok, pct: `${Math.round((100 * ok) / CORPUS.length)}%` });
    console.table(table);
    assert.ok(CORPUS.length >= 40);
    for (const cls of [S, G, I, C]) assert.ok(rows[cls].n >= 5, cls);
    assert.ok(ok / CORPUS.length >= 0.9, `accuracy ${ok}/${CORPUS.length}`);
    assert.equal(setupFalse, 0, "a non-setup failure was classed as setup");
    assert.equal(rows[C].ok, rows[C].n, "no code failure may be misclassed");
  });

  it("covers node, python, go and docker", () => {
    const blob = CORPUS.map((c) => c.lines.join("\n")).join("\n");
    for (const re of [/npm|pnpm/, /ModuleNotFound|poetry|pytest|mypy/, /go\.mod|\.go:/, /docker|manifest/i]) assert.match(blob, re);
  });

  it("downstream is true for setup and stale only", () => {
    assert.equal(classifyCiFailure(CORPUS[0]).downstream, true);
    assert.equal(classifyCiFailure(CORPUS.find((c) => c.want === G)).downstream, true);
    assert.equal(classifyCiFailure(CORPUS.find((c) => c.want === I)).downstream, false);
    assert.equal(classifyCiFailure(CORPUS.find((c) => c.want === C)).downstream, false);
  });

  it("a test failure is never setup or stale, even with setup-looking output", () => {
    assert.equal(classifyCiFailure({ step: "unit", lines: ["sh: foo: command not found"], test: { id: "t" } }).class, C);
  });

  it("handles empty input", () => {
    assert.equal(classifyCiFailure().class, C);
    assert.equal(classifyCiFailure({ lines: [] }).downstream, false);
  });
});

describe("flake ledger override (#5690)", () => {
  const base = { step: "unit", lines: ["boom at line 12"], test: { id: "t9", message: "Error: timed out after 5000ms" } };
  const plain = classifyCiFailure(base);
  it("a ledger hit turns code into flaky-suspect", () => {
    assert.equal(plain.class, C);
    const flakes = [{ signature_hash: signatureHash("unit", "t9", plain.signature) }];
    const r = classifyCiFailure({ ...base, flakes });
    assert.deepEqual([r.class, r.downstream], ["flaky-suspect", false]);
  });
  it("a miss stays code; the hit does not override setup or infra", () => {
    assert.equal(classifyCiFailure({ ...base, flakes: [{ signature_hash: "nope" }] }).class, C);
    const setup = { step: "build", lines: ["sh: tsc: command not found"] };
    const sig = classifyCiFailure(setup).signature;
    assert.equal(classifyCiFailure({ ...setup, flakes: [{ signature_hash: signatureHash("build", null, sig) }] }).class, S);
  });
});

describe("failFastDecision (#5690)", () => {
  const cases = [["deterministic-setup", true], ["generated-artifact-stale", true], ["infra", false], ["flaky-suspect", false], ["code", false]];
  it("cancel only for downstream classes under policy deterministic", () => {
    for (const [cls, down] of cases) {
      const e = { type: "step_failed", class: cls };
      assert.equal(failFastDecision(e, { fail_fast: "deterministic" }).action, down ? "cancel" : "continue", cls);
      assert.equal(failFastDecision(e, { fail_fast: "off" }).action, "continue", cls);
      assert.equal(failFastDecision(e, undefined).action, "continue", cls);
      assert.equal(failFastDecision(e, {}).action, "continue", cls);
    }
    assert.deepEqual(DOWNSTREAM_CLASSES, [S, G]);
  });
  it("classifies an event with no class; unknown policy values are off", () => {
    const e = { type: "step_failed", step: "s", lines: ["sh: x: command not found"] };
    assert.equal(failFastDecision(e, "deterministic").action, "cancel");
    assert.equal(failFastPolicy("always"), "off");
    assert.equal(failFastDecision({ type: "job_started" }, "deterministic").action, "continue");
  });
});

describe("flaky-suspect corpus (#5690)", () => {
  it("5 ledger-hit excerpts classify flaky-suspect, the same excerpts without the ledger classify code", () => {
    const cases = CORPUS.filter((c) => c.want === C).slice(0, 5);
    assert.equal(cases.length, 5);
    for (const c of cases) {
      const sig = classifyCiFailure(c).signature;
      const flakes = [{ signature_hash: signatureHash(c.step, c.test?.id ?? null, sig) }];
      assert.equal(classifyCiFailure({ ...c, flakes }).class, "flaky-suspect");
      assert.equal(classifyCiFailure(c).class, C);
    }
  });
});
