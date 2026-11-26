// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5760: CI budget gate fixtures (in-memory base/head workflow maps).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { parseCiBudget, parseAnnotation, scanWorkflow, singleTestFile, singleTestFileSteps, netCiChange, ciGateCli } from "./ci-gate.mjs";
import { parseForgeYaml } from "../forge-utils.mjs";

const kinds = (f) => f.map((x) => x.kind).sort();
const CI = ".github/workflows/ci.yml";
const BASE_CI = [
  "name: CI",
  "on:",
  "  pull_request:",
  "    paths: ['src/**']",
  "concurrency:",
  "  group: ci-${{ github.ref }}",
  "  cancel-in-progress: true",
  "jobs:",
  "  lint:",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 10",
  "    steps:",
  "      - run: npm run lint",
  "  regression:",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 20",
  "    steps:",
  "      - run: node --test tests/a.test.mjs tests/b.test.mjs",
  "",
].join("\n");
const cfg = parseCiBudget({ shared_regression_job: "regression" });
const BARE = "name: one\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test tests/x.test.mjs\n";
const GOOD = [
  "# FORGE:CI_BUDGET trigger=pull_request:src/** minutes=120/month why=needs a GPU runner the shared job lacks",
  "name: gpu",
  "on:",
  "  pull_request:",
  "    paths:",
  "      - 'gpu/**'",
  "concurrency:",
  "  group: gpu-${{ github.ref }}",
  "jobs:",
  "  gpu:",
  "    runs-on: gpu",
  "    timeout-minutes: 30",
  "    steps:",
  "      - run: make gpu-test",
  "",
].join("\n");

describe("annotation and single-file steps", () => {
  it("parseAnnotation reads the three fields", () => {
    assert.deepEqual(parseAnnotation("  # FORGE:CI_BUDGET trigger=push:main minutes=30 why=deploy smoke, not a test"), { trigger: "push:main", minutes: 30, why: "deploy smoke, not a test", missing: [] });
    assert.deepEqual(parseAnnotation("# FORGE:CI_BUDGET why=x").missing, ["trigger", "minutes"]);
    assert.equal(parseAnnotation("# a comment"), null);
  });
  it("singleTestFile needs a runner and exactly one test file", () => {
    assert.equal(singleTestFile("      - run: node --test bin/x.test.mjs"), "bin/x.test.mjs");
    assert.equal(singleTestFile("run: bash scripts/foo.test.sh"), "scripts/foo.test.sh");
    assert.equal(singleTestFile("run: go test ./pkg/foo_test.go"), "./pkg/foo_test.go");
    assert.equal(singleTestFile("run: node --test a.test.mjs b.test.mjs"), null);
    assert.equal(singleTestFile("run: npm test"), null);
    assert.equal(singleTestFile("run: cat x.test.mjs"), null);
    assert.deepEqual(singleTestFileSteps(["npm ci", "pytest tests/test_a.py"]), [{ line: 1, file: "tests/test_a.py" }]);
  });
  it("singleTestFile ignores runner words inside paths and non-command lines (#5787)", () => {
    for (const l of ["      - run: echo scripts/foo.test.sh", "      - name: check scripts/foo.test.sh", "          - scripts/foo.test.sh", "run: cat x.test.sh", "      - name: Run vitest on a.test.ts", "run: cat lib/bash/x.test.mjs"]) assert.equal(singleTestFile(l), null, l);
    assert.equal(singleTestFile("run: npm ci && bash scripts/foo.test.sh"), "scripts/foo.test.sh");
    assert.equal(singleTestFile("        npx vitest run src/a.test.ts"), "src/a.test.ts");
  });
  it("singleTestFile still flags real runner steps (#5787 over-narrowing guard)", () => {
    assert.equal(singleTestFile("run: cd x && pytest tests/test_a.py"), "tests/test_a.py");
    assert.equal(singleTestFile("run: sh scripts/foo.test.sh"), "scripts/foo.test.sh");
  });
});

describe("config, net change and wiring", () => {
  it("parseCiBudget reads the flattened ci.budget block and shares monthly_minutes with ci.monthly_minutes", () => {
    const y = parseForgeYaml("ci:\n  mode: auto\n  budget:\n    max_workflows: 12\n    max_ci_jobs: 40\n    monthly_minutes: 50000\n    shared_regression_job: regression\n");
    assert.deepEqual(parseCiBudget(y.ci), { maxWorkflows: 12, maxCiJobs: 40, monthlyMinutes: 50000, sharedJob: "regression" });
    assert.equal(y.ci.monthly_minutes, "50000");
    assert.deepEqual(parseCiBudget(null), { maxWorkflows: null, maxCiJobs: null, monthlyMinutes: null, sharedJob: null });
    assert.equal(parseCiBudget({ max_workflows: "many" }).maxWorkflows, null);
  });
  it("netCiChange reports workflows, jobs and annotated minutes", () => {
    const head = { [CI]: BASE_CI, ".github/workflows/gpu.yml": GOOD, ".github/workflows/one.yml": BARE };
    const r = netCiChange({ base: { [CI]: BASE_CI }, head, cfg: parseCiBudget({ monthly_minutes: 3000 }) });
    assert.deepEqual([r.workflows, r.jobs, r.minutes], [2, 2, 120]);
    assert.equal(r.line, "CI_NET: workflows +2, jobs +2, est. minutes/month +120 of 3000 budget");
    assert.match(netCiChange({ base: head, head: { [CI]: BASE_CI } }).line, /workflows -2, jobs -2, est\. minutes\/month -120$/);
  });
  it("the CLI prints CI_NET unknown on a bad ref and usage on bad args", async () => {
    const out = [];
    const cwd = tmpDir("ci-gate-");
    assert.equal(await ciGateCli(["net", "--base", "nope", "--head", "nope2"], { print: (s) => out.push(s), cwd }), 0);
    assert.match(out[0], /^CI_NET: unknown \(/);
    assert.equal(await ciGateCli(["net"], { print: (s) => out.push(s) }), 2);
  });
});
