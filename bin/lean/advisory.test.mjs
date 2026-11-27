// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitAdvisory, ADVISORY_KINDS, ADVISORY_CODES } from "./conformance.mjs";
import { OUTCOME_CODES as C } from "../engine/outcome-codes.mjs";
import { genericInstallCommands, missingPythonModules } from "../pool/lane-tools.mjs";

describe("advisory gates (unclog)", () => {
  it("shape, environment and opinion rules are advisory; failing checks, regressions and omissions block (#6083)", () => {
    const rows = [
      { code: C.CONFORMANCE_SCOPE_CREEP, kind: "scope_creep", detail: "x" },
      { code: C.CONFORMANCE_SCOPE_CREEP, detail: "review-side creep has no kind" },
      { code: C.CONFORMANCE_E2E_UNVERIFIED, kind: "e2e_row", detail: "e2e" },
      { code: C.CONFORMANCE_UNTRACKED_DEFERRAL, kind: "untracked_deferral", detail: "deferral" },
      { code: C.CONFORMANCE_UNIMPLEMENTED, kind: "review_unimplemented", detail: "reviewer opinion" },
      { code: C.CONFORMANCE_UNIMPLEMENTED, kind: "validate_missing", detail: "V1 no result" },
      { code: C.ENV_TOOL_MISSING, kind: "validate_env", detail: "tool" },
      { code: C.CONFORMANCE_GUARD_BROKEN, kind: "guard_broken", detail: "G1" },
      { code: C.CONFORMANCE_UNIMPLEMENTED, kind: "page_metadata_missing", detail: "page" },
      { code: C.CONFORMANCE_UNIMPLEMENTED, kind: "prod_parity_unjustified", detail: "parity" },
      { code: C.CONFORMANCE_UNIMPLEMENTED, kind: "validate_failed", detail: "V1 failed" },
      { code: C.CONFORMANCE_UNIMPLEMENTED, kind: "requirement_unimplemented", detail: "R1 reported not done" },
      { code: C.CONFORMANCE_UNIMPLEMENTED, kind: "repro_red_green", detail: "repro" },
      { code: C.CONFORMANCE_UNIMPLEMENTED, kind: "source_deliverable_untouched", detail: "tests only" },
      { code: C.CONFORMANCE_REGRESSION, detail: "a.test.mjs: fails" },
      { code: C.CONFORMANCE_OMISSION, detail: "narrowed" },
    ];
    const { block, advisory } = splitAdvisory(rows);
    assert.deepEqual(block.map((f) => f.kind ?? f.code), ["validate_failed", "requirement_unimplemented", "repro_red_green", "source_deliverable_untouched", C.CONFORMANCE_REGRESSION, C.CONFORMANCE_OMISSION]);
    assert.equal(advisory.length, 10);
  });
  it("never lists a kind that proves the change wrong", () => {
    for (const k of ["validate_failed", "requirement_unimplemented", "repro_red_green", "source_deliverable_untouched", "test_missing", "test_weak"]) assert.ok(!ADVISORY_KINDS.includes(k), k);
    assert.ok(!ADVISORY_CODES.includes(C.CONFORMANCE_REGRESSION) && !ADVISORY_CODES.includes(C.CONFORMANCE_OMISSION));
  });
  it("a kind the repo enforces by code stays blocking", () => {
    const { block } = splitAdvisory([{ code: C.CONFORMANCE_GUARD_BROKEN, kind: "guard_broken", detail: "G1" }], { enforce: [C.CONFORMANCE_GUARD_BROKEN] });
    assert.equal(block.length, 1);
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
    assert.match(genericInstallCommands({ kind: "python-module", tool: "yaml" })[0], /pip install --quiet --break-system-packages PyYAML/);
    assert.match(genericInstallCommands({ kind: "python-module", tool: "requests" })[0], /pip install --quiet --break-system-packages requests/);
    const y = genericInstallCommands({ kind: "python-module", tool: "yaml" })[0];
    assert.match(y, /\|\| \(apt-get update -qq && apt-get install -y --no-install-recommends python3-yaml && rm -rf \/var\/lib\/apt\/lists\/\*\)$/, "apt fallback grouped so it runs only when pip fails");
    assert.match(genericInstallCommands({ kind: "node-module", tool: "@adobe/css-tools" })[0], /^npm install --no-save .* @adobe\/css-tools$/);
    assert.match(genericInstallCommands({ kind: "command", tool: "ripgrep" })[0], /apt-get install -y --no-install-recommends ripgrep/);
    assert.match(genericInstallCommands({ kind: "command", tool: "ripgrep" }, { root: false })[0], /^sudo sh -c /);
  });
  it("#6138 python modules install system-wide, never --user, with the apt fallback kept; non-root goes through sudo", () => {
    const root = genericInstallCommands({ kind: "python-module", tool: "yaml" })[0];
    assert.doesNotMatch(root, /--user/);
    assert.match(root, /^python3 -m pip install --quiet --break-system-packages PyYAML \|\| python3 -m pip install --quiet PyYAML \|\| \(apt-get/);
    const nr = genericInstallCommands({ kind: "python-module", tool: "PIL" }, { root: false })[0];
    assert.doesNotMatch(nr, /--user/);
    assert.match(nr, /^sudo sh -c .*Pillow.*\|\| \(sudo sh -c .*python3-pil/);
    assert.deepEqual(missingPythonModules("ModuleNotFoundError: No module named 'yaml.nodes'\nNo module named foo"), ["yaml", "foo"]);
  });
  it("refuses unsafe names and kinds nothing can install", () => {
    for (const m of [{ kind: "command", tool: "a;rm -rf /" }, { kind: "command", tool: "$(x)" }, { kind: "command", tool: "../x" }, { kind: "command", tool: "bin/x" }, { kind: "environment", tool: "db" }, { kind: "forgedock-path", tool: "forgedock" }, {}])
      assert.deepEqual(genericInstallCommands(m), [], JSON.stringify(m));
  });
});
