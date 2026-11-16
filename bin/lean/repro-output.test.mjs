// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5732: a repro HEAD=FAILED carries the failing run's output, and an absent interpreter is the environment, not a red test.
// Imports only exports that exist on the base, so on the base this file loads and fails by assertion.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reproFailures, reproEnvMiss } from "./conformance.mjs";

// The recorded AlterLab #41002 repro_test shape (bare test invocation)
const C41002 = { repro_test: { path: "services/api/tests/test_admin_scraping_kpis_41002.py", id: "test_list_and_detail_success_rate_match_with_tier_cap",
  command: "cd services/api && poetry run pytest -q -p no:cacheprovider tests/test_admin_scraping_kpis_41002.py::test_list_and_detail_success_rate_match_with_tier_cap" } };
const PYTEST_FAIL = ["F                                                                        [100%]",
  "    def test_list_and_detail_success_rate_match_with_tier_cap():", ">       assert detail.success_rate == listing.success_rate",
  "E       AssertionError: 0.5 != 0.4", "FAILED tests/test_admin_scraping_kpis_41002.py::test_list_and_detail_success_rate_match_with_tier_cap", "1 failed in 0.31s"].join("\n");

describe("#5732 repro output and env classification", () => {
  it("#5732 repro_red_green failure carries the head output tail", () => {
    const [f] = reproFailures(C41002, { base: "SKIPPED", head: "FAILED", headOutput: PYTEST_FAIL });
    assert.equal(f.kind, "repro_red_green");
    assert.match(f.detail, /got BASE=SKIPPED HEAD=FAILED/);
    assert.match(f.detail, /output tail/);
    assert.match(f.detail, /AssertionError: 0\.5 != 0\.4/);
  });
  it("#5732 the tail is the last 20 lines, and the base run's output is shown too", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const [f] = reproFailures(C41002, { base: "RAN", head: "RAN", headOutput: "1 passed", baseOutput: long });
    assert.equal(f.kind, "repro_base_green");
    assert.match(f.detail, /base output tail \(last 20 lines\)/);
    assert.match(f.detail, /line 30/);
    assert.doesNotMatch(f.detail, /line 10\n/);
  });
  it("#5732 no output, no tail", () => {
    assert.doesNotMatch(reproFailures(C41002, { base: "SKIPPED", head: "FAILED" })[0].detail, /output tail/);
  });
  it("#5732 interpreter-missing head is env", () => {
    assert.ok(reproEnvMiss({ rc: 1, output: "poetry env use: python3.11 not found" }, {}));
    assert.ok(reproEnvMiss({ rc: 1, output: "\nCould not find the python executable python3.11\n" }, {}));
    assert.equal(reproEnvMiss({ rc: 1, output: PYTEST_FAIL }, {}), null, "a real assertion failure stays the change's");
  });
  it("#5732 an env-classified head is repro_env, with the output tail", () => {
    const [f] = reproFailures(C41002, { base: "SKIPPED", head: "UNRUNNABLE", headOutput: "poetry env use: python3.11 not found" });
    assert.equal(f.kind, "repro_env");
    assert.match(f.detail, /python3\.11 not found/);
  });
});
