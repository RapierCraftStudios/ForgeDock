// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitAdvisory, ADVISORY_KINDS } from "./conformance.mjs";
import { OUTCOME_CODES as C } from "../engine/outcome-codes.mjs";
import { genericInstallCommands } from "../pool/lane-tools.mjs";

describe("advisory gates (unclog)", () => {
  it("shape rules are advisory; failing checks, regressions and unimplemented requirements block", () => {
    const rows = [
      { code: C.CONFORMANCE_SCOPE_CREEP, kind: "scope_creep", detail: "x" },
      { code: C.CONFORMANCE_SCOPE_CREEP, detail: "review-side creep has no kind" },
      { code: C.CONFORMANCE_UNIMPLEMENTED, kind: "check_unknown", detail: "post-deploy check id" },
      { code: C.RECURRENCE_DESIGN_MISSING, kind: "design_missing", detail: "no design block" },
      { code: C.CONFORMANCE_UNIMPLEMENTED, kind: "amendment_invalid", detail: "unknown or incomplete amendment" },
      { code: C.CONFORMANCE_UNIMPLEMENTED, kind: "validate_failed", detail: "V1 failed" },
      { code: C.CONFORMANCE_UNIMPLEMENTED, kind: "requirement_unimplemented", detail: "R1" },
      { code: C.CONFORMANCE_REGRESSION, kind: "guard_broken", detail: "G1" },
    ];
    const { block, advisory } = splitAdvisory(rows);
    assert.deepEqual(block.map((f) => f.kind), ["validate_failed", "requirement_unimplemented", "guard_broken"]);
    assert.equal(advisory.length, 5);
  });
  it("never lists a kind that proves the change wrong", () => {
    for (const k of ["validate_failed", "validate_missing", "guard_broken", "requirement_unimplemented", "repro_red_green", "substitute_unverified", "untracked_deferral", "prod_parity_unjustified", "outcome_evidence_missing"]) assert.ok(!ADVISORY_KINDS.includes(k), k);
  });
  it("a code the repo explicitly enforces stays blocking", () => {
    const { block, advisory } = splitAdvisory([{ code: C.CONFORMANCE_SCOPE_CREEP, kind: "scope_creep", detail: "x" }], { enforce: [C.CONFORMANCE_SCOPE_CREEP] });
    assert.equal(block.length, 1); assert.equal(advisory.length, 0);
  });
  it("empty and missing input", () => {
    assert.deepEqual(splitAdvisory(undefined), { block: [], advisory: [] });
  });
});

describe("generic sandbox install (unclog)", () => {
  it("installs by miss kind, mapping import names to packages", () => {
    assert.match(genericInstallCommands({ kind: "python-module", tool: "yaml" })[0], /pip install --user --quiet PyYAML/);
    assert.match(genericInstallCommands({ kind: "python-module", tool: "requests" })[0], /pip install --user --quiet requests/);
    assert.match(genericInstallCommands({ kind: "node-module", tool: "@adobe/css-tools" })[0], /^npm install --no-save .* @adobe\/css-tools$/);
    assert.match(genericInstallCommands({ kind: "command", tool: "shellcheck" })[0], /apt-get install -y --no-install-recommends shellcheck/);
    assert.match(genericInstallCommands({ kind: "command", tool: "shellcheck" }, { root: false })[0], /^sudo sh -c /);
  });
  it("refuses unsafe names and kinds nothing can install", () => {
    for (const m of [{ kind: "command", tool: "a;rm -rf /" }, { kind: "command", tool: "$(x)" }, { kind: "command", tool: "../x" }, { kind: "command", tool: "bin/x" }, { kind: "environment", tool: "db" }, { kind: "forgedock-path", tool: "forgedock" }, {}])
      assert.deepEqual(genericInstallCommands(m), [], JSON.stringify(m));
  });
});
