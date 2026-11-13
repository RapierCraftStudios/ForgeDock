// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveCatalog, mergeRecipes, rewriteMissed, extractTestIds, equivalentRuns, isDriftFailure, rewriteSubprojectVenv } from "./validate-catalog.mjs";
import { applyValidateRecipes } from "./conformance.mjs";

const CI = "run: uv run --with-requirements r.txt pytest tests\nrun: npx vitest run";
describe("#5653 validate catalogue", () => {
  it("derives the repo's pytest and JS runners from CI text", () => {
    const c = deriveCatalog([CI]);
    assert.equal("cd api && poetry run pytest t.py".replace(new RegExp(c[0].match), c[0].replace), "cd api && uv run --with-requirements r.txt pytest t.py");
    assert.equal("pnpm exec vitest run x".replace(new RegExp(c[2].match), c[2].replace), "npx vitest run x");
    assert.deepEqual(deriveCatalog(["make test"]), []);
  });
  it("forge.yaml recipes win over derived entries", () => {
    const m = mergeRecipes([{ match: "a", replace: "1" }], [{ match: "a", replace: "2" }, { match: "b", replace: "3" }]);
    assert.deepEqual(m, [{ match: "a", replace: "1" }, { match: "b", replace: "3" }]);
  });
  it("rewrites only the unrunnable ids and leaves unmatched commands unchanged", () => {
    const c = { validate: [{ id: "V1", command: "poetry run pytest a.py" }, { id: "V2", command: "poetry run pytest b.py" }, { id: "V3", command: "node --test x" }] };
    const r = rewriteMissed(c, deriveCatalog([CI]), ["V1", "V3"], applyValidateRecipes);
    assert.match(r.contract.validate[0].command, /^uv run --with-requirements r\.txt pytest a\.py$/);
    assert.equal(r.contract.validate[1].command, "poetry run pytest b.py");
    assert.equal(r.contract.validate[2].command, "node --test x");
    assert.deepEqual(r.applied.map((a) => a.id), ["V1"]);
    assert.equal(rewriteMissed(c, [], ["V1"], applyValidateRecipes).contract, c);
  });
  it("equivalentRuns needs the same passing test ids and a passing substitute", () => {
    const out = "a.py::t1 PASSED\na.py::t2 PASSED\n", bad = "a.py::t1 PASSED\na.py::t2 FAILED\n";
    assert.equal(equivalentRuns({ rc: 1, output: out }, { rc: 0, output: out }), true);
    assert.equal(equivalentRuns({ rc: 1, output: out }, { rc: 1, output: out }), false, "a failing substitute is never equivalent");
    assert.equal(equivalentRuns({ rc: 1, output: bad }, { rc: 0, output: out }), false, "a failing test in the frozen run");
    assert.equal(equivalentRuns({ rc: 1, output: out }, { rc: 0, output: "a.py::t1 PASSED\n" }), false);
    assert.equal(equivalentRuns({ rc: 1, output: "boom" }, { rc: 0, output: "boom" }), false, "no ids is no evidence");
    assert.deepEqual([...extractTestIds("ok 1 - one\nnot ok 2 - two # x")], ["one", "two"]);
  });
  it("classifies a stale generated artifact, not a test failure", () => {
    assert.equal(isDriftFailure("error: generated tools file is out of date"), true);
    assert.equal(isDriftFailure("AssertionError: 1 != 2"), false);
  });
});

describe("#5683 sub-project venv rewrite", () => {
  const files = ["services/api/pyproject.toml"], exists = (p) => p === "services/api/.venv/bin/python";
  it("rewrites the repro and validate commands, leaves others, and returns the input when nothing changes", () => {
    const c = { repro_test: { path: "t", id: "i", command: "cd services/api && python -m pytest tests/a.py" }, validate: [{ id: "V1", command: "cd services/api && pytest" }, { id: "V2", command: "node --test x" }] };
    const r = rewriteSubprojectVenv(c, files, exists);
    assert.equal(r.contract.repro_test.command, "cd services/api && .venv/bin/python -m pytest tests/a.py");
    assert.deepEqual(r.contract.validate.map((v) => v.command), ["cd services/api && .venv/bin/python -m pytest", "node --test x"]);
    assert.deepEqual(r.applied.map((a) => a.id).sort(), ["V1", "repro_test"]);
    const same = { validate: [{ id: "V1", command: "node --test x" }] };
    assert.equal(rewriteSubprojectVenv(same, files, exists).contract, same);
  });
});
