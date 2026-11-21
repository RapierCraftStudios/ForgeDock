// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5760: CI budget gate fixtures (in-memory base/head workflow maps).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { parseCiBudget, parseAnnotation, scanWorkflow, singleTestFile, singleTestFileSteps, ciGateFindings, netCiChange, ciBudgetFailures, ciGateCli } from "./ci-gate.mjs";
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

describe("lane check (#5760 R10)", () => {
  it("a lane adding a bare workflow fails (unannotated + hygiene)", () => {
    const f = ciGateFindings({ cfg, base: { [CI]: BASE_CI }, head: { [CI]: BASE_CI, ".github/workflows/one.yml": BARE } });
    assert.deepEqual(kinds(f), ["ci_budget_unannotated", "ci_hygiene"]);
    assert.match(f.find((x) => x.kind === "ci_hygiene").detail, /concurrency.*timeout-minutes.*path scoping/);
    assert.equal(f[0].code, "conformance.unimplemented");
    assert.match(f.find((x) => x.kind === "ci_budget_unannotated").detail, /shared job `regression`/);
  });
  it("a lane folding a one-file check into the shared job passes", () => {
    const head = BASE_CI.replace("      - run: node --test tests/a.test.mjs tests/b.test.mjs", "      - run: node --test tests/a.test.mjs tests/b.test.mjs\n      - run: node --test tests/new.test.mjs");
    assert.deepEqual(ciGateFindings({ cfg, base: { [CI]: BASE_CI }, head: { [CI]: head } }), []);
  });
  it("an annotated, scoped workflow passes", () => {
    assert.deepEqual(ciGateFindings({ cfg, base: { [CI]: BASE_CI }, head: { [CI]: BASE_CI, ".github/workflows/gpu.yaml": GOOD } }), []);
  });
});

describe("annotation and single-file steps", () => {
  it("an annotation missing minutes is invalid", () => {
    const f = ciGateFindings({ cfg, base: {}, head: { ".github/workflows/gpu.yml": GOOD.replace("minutes=120/month ", "") } });
    assert.deepEqual(kinds(f), ["ci_budget_annotation_invalid"]);
    assert.match(f[0].detail, /missing minutes/);
  });
  it("parseAnnotation reads the three fields", () => {
    assert.deepEqual(parseAnnotation("  # FORGE:CI_BUDGET trigger=push:main minutes=30 why=deploy smoke, not a test"), { trigger: "push:main", minutes: 30, why: "deploy smoke, not a test", missing: [] });
    assert.deepEqual(parseAnnotation("# FORGE:CI_BUDGET why=x").missing, ["trigger", "minutes"]);
    assert.equal(parseAnnotation("# a comment"), null);
  });
  it("a single-file step added to another job fails unless annotated", () => {
    const head = BASE_CI.replace("      - run: npm run lint", "      - run: npm run lint\n      - run: npx vitest run src/a.spec.ts");
    assert.deepEqual(kinds(ciGateFindings({ cfg, base: { [CI]: BASE_CI }, head: { [CI]: head } })), ["ci_budget_unannotated"]);
    const ann = head.replace("  lint:\n", "  # FORGE:CI_BUDGET trigger=pull_request minutes=5 why=lint-coupled spec\n  lint:\n");
    assert.deepEqual(ciGateFindings({ cfg, base: { [CI]: BASE_CI }, head: { [CI]: ann } }), []);
  });
  it("a shared dir folds a step whose file lives under it", () => {
    const head = BASE_CI.replace("      - run: npm run lint", "      - run: npm run lint\n      - run: pytest tests/regression/test_x.py");
    assert.deepEqual(ciGateFindings({ cfg: parseCiBudget({ shared_regression_job: "tests/regression" }), base: { [CI]: BASE_CI }, head: { [CI]: head } }), []);
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
    const head = BASE_CI.replace("      - run: npm run lint", "      - run: npm run lint\n      - name: check scripts/foo.test.sh\n      - run: echo scripts/foo.test.sh");
    assert.deepEqual(ciGateFindings({ cfg, base: { [CI]: BASE_CI }, head: { [CI]: head } }), []);
  });
});

describe("new jobs and hygiene", () => {
  const withJob = (job) => BASE_CI + job;
  it("a job added to an existing workflow needs an annotation above or inside it", () => {
    const job = "  e2e:\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    steps:\n      - run: npm run e2e\n";
    assert.deepEqual(kinds(ciGateFindings({ cfg, base: { [CI]: BASE_CI }, head: { [CI]: withJob(job) } })), ["ci_budget_unannotated"]);
    const ann = "  # FORGE:CI_BUDGET trigger=pull_request:src/** minutes=200 why=browser stack\n" + job;
    assert.deepEqual(ciGateFindings({ cfg, base: { [CI]: BASE_CI }, head: { [CI]: withJob(ann) } }), []);
  });
  it("a new job without timeout-minutes is a hygiene failure", () => {
    const job = "  # FORGE:CI_BUDGET trigger=pr minutes=5 why=x\n  e2e:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run e2e\n";
    const f = ciGateFindings({ cfg, base: { [CI]: BASE_CI }, head: { [CI]: withJob(job) } });
    assert.deepEqual(kinds(f), ["ci_hygiene"]);
    assert.match(f[0].detail, /`e2e`.*timeout-minutes/);
  });
  it("an issue_comment job without a job-level if: fails ci_hygiene", () => {
    const wf = "# FORGE:CI_BUDGET trigger=issue_comment minutes=10 why=bot command\non:\n  issue_comment:\n    types: [created]\nconcurrency: bot\njobs:\n  bot:\n    timeout-minutes: 5\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n";
    const f = ciGateFindings({ cfg, base: {}, head: { ".github/workflows/bot.yml": wf } });
    assert.deepEqual(kinds(f), ["ci_hygiene"]);
    assert.match(f[0].detail, /job-level if:/);
    const ok = wf.replace("  bot:\n", "  bot:\n    if: startsWith(github.event.comment.body, '/bot')\n");
    assert.deepEqual(ciGateFindings({ cfg, base: {}, head: { ".github/workflows/bot.yml": ok } }), []);
  });
  it("a schedule-only workflow needs no path scoping", () => {
    const wf = "# FORGE:CI_BUDGET trigger=nightly minutes=300 why=full suite\non:\n  schedule:\n    - cron: '0 3 * * *'\n  workflow_dispatch:\nconcurrency: nightly\njobs:\n  full:\n    timeout-minutes: 60\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";
    assert.deepEqual(ciGateFindings({ cfg, base: {}, head: { ".github/workflows/nightly.yml": wf } }), []);
  });
  it("scanWorkflow reads triggers, concurrency and job children", () => {
    const s = scanWorkflow(BASE_CI);
    assert.deepEqual(s.triggers, { pull_request: { paths: true } });
    assert.equal(s.concurrency, true);
    assert.deepEqual(s.jobs.map((j) => [j.id, j.timeout, j.if]), [["lint", true, false], ["regression", true, false]]);
    assert.deepEqual(Object.keys(scanWorkflow("on: [push, pull_request]\njobs: {}\n").triggers), ["push", "pull_request"]);
  });
});

describe("max_workflows / max_ci_jobs (#5760 R8)", () => {
  const two = { [CI]: BASE_CI, ".github/workflows/old.yml": GOOD };
  it("exceeding max_workflows fails, and passes when the same diff removes one", () => {
    const c = parseCiBudget({ max_workflows: "2" });
    const head = { ...two, ".github/workflows/gpu.yml": GOOD };
    assert.deepEqual(kinds(ciGateFindings({ cfg: c, base: two, head })), ["ci_budget_exceeded"]);
    const swapped = { [CI]: BASE_CI, ".github/workflows/gpu.yml": GOOD };
    assert.deepEqual(ciGateFindings({ cfg: c, base: two, head: swapped }), []);
  });
  it("exceeding max_ci_jobs fails unless a job is folded away", () => {
    const c = parseCiBudget({ max_ci_jobs: "2" });
    const job = "  # FORGE:CI_BUDGET trigger=pr minutes=5 why=x\n  e2e:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: npm run e2e\n";
    assert.deepEqual(kinds(ciGateFindings({ cfg: c, base: { [CI]: BASE_CI }, head: { [CI]: BASE_CI + job } })), ["ci_budget_exceeded"]);
    const folded = BASE_CI.replace(/  lint:\n(?:    .*\n)*?(?=  regression:)/, "") + job;
    // the fold removes exactly the lint job (regression guard for the unambiguous, non-backtracking pattern)
    assert.ok(!folded.includes("lint:") && !folded.includes("npm run lint"));
    assert.ok(folded.includes("  regression:\n") && folded.endsWith(job));
    assert.deepEqual(ciGateFindings({ cfg: c, base: { [CI]: BASE_CI }, head: { [CI]: folded } }), []);
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
  it("ciBudgetFailures makes one git call when no workflow changed", async () => {
    const calls = [];
    const git = async (a) => { calls.push(a); return "src/a.js\n"; };
    assert.deepEqual(await ciBudgetFailures({ cfg, base: "origin/staging", git }), []);
    assert.equal(calls.length, 1);
  });
  it("ciBudgetFailures reads merge-base and HEAD workflows when a workflow changed", async () => {
    const files = { mb: { [CI]: BASE_CI }, HEAD: { [CI]: BASE_CI, ".github/workflows/one.yml": BARE } };
    const git = async (a) => {
      if (a[0] === "diff") return ".github/workflows/one.yml\n";
      if (a[0] === "merge-base") return "mb\n";
      if (a[0] === "ls-tree") return Object.keys(files[a[3]]).join("\n");
      const [ref, p] = a[1].split(/:(.*)/s);
      return files[ref][p];
    };
    assert.deepEqual(kinds(await ciBudgetFailures({ cfg, base: "origin/staging", git })), ["ci_budget_unannotated", "ci_hygiene"]);
  });
  it("the CLI prints CI_NET unknown on a bad ref and usage on bad args", async () => {
    const out = [];
    const cwd = tmpDir("ci-gate-");
    assert.equal(await ciGateCli(["net", "--base", "nope", "--head", "nope2"], { print: (s) => out.push(s), cwd }), 0);
    assert.match(out[0], /^CI_NET: unknown \(/);
    assert.equal(await ciGateCli(["net"], { print: (s) => out.push(s) }), 2);
  });
});
