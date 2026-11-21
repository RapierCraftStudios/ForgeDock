// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { parseCiPrecheckConfig, classifyJob, requiredFor, selectCiPrecheck, deriveCiPrecheck, ciPrecheckCommand, ciPrecheckOutcome, CI_PRECHECK_DIR, DEFAULT_MAX_JOBS } from "./ci-precheck.mjs";

const step = (command, extra = {}) => ({ name: command, command, cwd: ".", kind: "check", ...extra });
const job = (key, name, cmds, extra = {}) => ({ id: `gha:ci:${key}`, source: "github-actions", name, workflow: ".github/workflows/ci.yml", steps: [step("pnpm install --frozen-lockfile", { kind: "install" }), ...cmds.map((c) => step(c))], services: [], needs: [], ...extra });
const PLAN = {
  version: 1, repo: "/wt", jobs: [
    job("lint", "Lint", ["pnpm lint"]),
    job("typecheck", "Typecheck", ["pnpm turbo run typecheck --filter=...[origin/main]"]),
    job("unit", "Unit tests", ["pnpm vitest related src/a.ts"]),
    job("e2e", "E2E", ["pnpm playwright test"]),
    job("storybook", "Storybook", ["pnpm build-storybook"]),
    job("lighthouse", "Lighthouse", ["lhci autorun"]),
    job("build", "Build", ["pnpm next build"]),
    job("image", "Docker image", ["docker build -t app ."]),
    job("dco", "DCO", ["bash scripts/check-dco.sh"]),
    { id: "gha:docs:links", source: "github-actions", name: "Links", not_applicable: "pull_request path filter selects none of the changed files", steps: [], services: [] },
    { id: "explicit:extra", source: "explicit", name: "extra", steps: [step("make extra")], services: [] },
  ],
};

describe("#5820 ci-precheck config", () => {
  it("defaults on, kind/glob lists from block, flow or comma forms; off and max_jobs parse", () => {
    assert.deepEqual(parseCiPrecheckConfig(null), { mode: "on", include: [], exclude: [], maxJobs: DEFAULT_MAX_JOBS });
    const c = parseCiPrecheckConfig({ ci_precheck: "off", ci_precheck_include: ["e2e", "gha:ci:build"], ci_precheck_exclude: "[\"Lint\", 'dco']", ci_precheck_max_jobs: "3" });
    assert.deepEqual(c, { mode: "off", include: ["e2e", "gha:ci:build"], exclude: ["Lint", "dco"], maxJobs: 3 });
    assert.deepEqual(parseCiPrecheckConfig({ ci_precheck_exclude: "a, b" }).exclude, ["a", "b"]);
    assert.equal(parseCiPrecheckConfig({ ci_precheck_max_jobs: "junk" }).maxJobs, DEFAULT_MAX_JOBS);
  });
});

describe("#5820 job classes", () => {
  it("heavy suites are classed by name or command; cheap ones by name, then command", () => {
    const k = (key) => classifyJob(PLAN.jobs.find((j) => j.id === `gha:ci:${key}`));
    assert.deepEqual(["e2e", "storybook", "lighthouse", "build", "image"].map((x) => k(x)), [{ kind: "e2e", heavy: true }, { kind: "visual", heavy: true }, { kind: "lighthouse", heavy: true }, { kind: "build", heavy: true }, { kind: "docker", heavy: true }]);
    assert.deepEqual(["lint", "typecheck", "unit", "dco"].map((x) => k(x).kind), ["lint", "typecheck", "test", "other"]);
    assert.equal(classifyJob(job("checks", "Checks", ["pnpm exec playwright test"])).kind, "e2e", "a heavy runner in the steps of a neutral job name");
    assert.equal(classifyJob(job("checks", "Checks", ["pnpm build && pnpm vitest run"])).kind, "test", "a plain package build before tests is not an app build");
  });

  it("required contexts match the job name, key, a matrix suffix or a caller prefix", () => {
    const j = job("unit", "Unit tests", ["x"]);
    assert.deepEqual(requiredFor(j, ["Unit tests", "unit (ubuntu-latest, 22)", "CI / Unit tests", "Lint", "Unit tests extra"]), ["Unit tests", "unit (ubuntu-latest, 22)", "CI / Unit tests"]);
  });
});

describe("#5820 selection", () => {
  it("required checks select their jobs (plus what an aggregator needs); heavy required jobs stay CI-only", () => {
    const plan = { ...PLAN, jobs: [...PLAN.jobs, { ...job("all", "All checks", ["true"]), needs: ["gha:ci:typecheck"] }] };
    const s = selectCiPrecheck({ plan, required: ["Lint", "All checks", "E2E", "DCO"] });
    assert.equal(s.source, "required");
    assert.deepEqual(s.run.map((r) => [r.job, r.why]), [["gha:ci:lint", 'required check "Lint"'], ["gha:ci:typecheck", "needed by required job gha:ci:all"], ["gha:ci:dco", 'required check "DCO"'], ["gha:ci:all", 'required check "All checks"']]);
    assert.match(s.skipped.find((x) => x.job === "gha:ci:e2e").reason, /heavy \(e2e\)/);
    assert.equal(s.skipped.find((x) => x.job === "gha:ci:unit").reason, "not a required check");
    assert.ok(!s.run.some((r) => r.job === "explicit:extra"), "ci-local extra commands are not CI jobs");
    assert.deepEqual(s.run[0].steps, ["pnpm lint"], "install steps dropped");
    assert.deepEqual(s.run[0].plan.jobs.map((j) => j.id), ["gha:ci:lint"], "a one-job plan for ci-local run");
  });

  it("no required checks: the conservative lint/typecheck/test fallback, heavy and other jobs left to CI", () => {
    for (const required of [[], null, ["some-external-app"]]) {
      const s = selectCiPrecheck({ plan: PLAN, required });
      assert.equal(s.source, "fallback");
      assert.deepEqual(s.run.map((r) => r.kind), ["lint", "typecheck", "test"]);
      assert.match(s.note, /conservative/);
    }
    const s = selectCiPrecheck({ plan: PLAN, required: [] });
    for (const id of ["e2e", "storybook", "lighthouse", "build", "image"]) assert.match(s.skipped.find((x) => x.job === `gha:ci:${id}`).reason, /^heavy/);
    assert.match(s.skipped.find((x) => x.job === "gha:ci:dco").reason, /not in the fallback set/);
    assert.match(s.skipped.find((x) => x.job === "gha:docs:links").reason, /path filter/);
  });

  it("include opts a heavy kind or a job in; exclude always wins; max_jobs caps the rest", () => {
    const cfg = parseCiPrecheckConfig({ ci_precheck_include: ["e2e", "Build"], ci_precheck_exclude: ["gha:ci:lint"], ci_precheck_max_jobs: "3" });
    const s = selectCiPrecheck({ plan: PLAN, required: [], cfg });
    assert.deepEqual(s.run.map((r) => r.job), ["gha:ci:typecheck", "gha:ci:unit", "gha:ci:e2e"]);
    assert.equal(s.skipped.find((x) => x.job === "gha:ci:lint").reason, "excluded by lean.ci_precheck_exclude");
    assert.match(s.skipped.find((x) => x.job === "gha:ci:build").reason, /max_jobs \(3\)/);
  });

  it("a job ci-local deferred (secrets, missing tool) is unrunnable with its reason; a scoped-out job is skipped", () => {
    const plan = { jobs: [job("unit", "Unit tests", ["x"], { deferred_reason: "tool not installed locally: cargo" }), { ...job("lint", "Lint", []), steps: [step("eslint a.js", { skip: "no changed js file" })] }] };
    const s = selectCiPrecheck({ plan, required: ["Unit tests", "Lint"] });
    assert.deepEqual(s.unrunnable, [{ job: "gha:ci:unit", name: "Unit tests", reason: "tool not installed locally: cargo" }]);
    assert.match(s.skipped.find((x) => x.job === "gha:ci:lint").reason, /scoped out/);
    assert.equal(s.run.length, 0);
  });
});

describe("#5820 derive + outcome", () => {
  it("writes one plan file per job and returns bounded ci-local commands", async () => {
    const written = new Map();
    const d = await deriveCiPrecheck({ buildPlan: async (a) => { assert.deepEqual(a, { repo: "/wt", base: "origin/main", baseBranch: "main", files: ["src/a.ts"] }); return PLAN; },
      required: ["Lint"], cfg: parseCiPrecheckConfig(null), wt: "/wt", base: "origin/main", lane: "main", files: ["src/a.ts"], perCommandMs: 600000, writeFile: async (p, t) => written.set(p, JSON.parse(t)) });
    assert.equal(d.commands.length, 1);
    assert.equal(d.commands[0].command, ciPrecheckCommand({ job: "gha:ci:lint" }, { perCommandMs: 600000 }));
    assert.match(d.commands[0].command, /ci-local\.sh' run --repo \. --plan '\.forge-lean\/ci-precheck\/gha_ci_lint\.json' --budget-minutes 9$/);
    assert.deepEqual([...written.keys()], [`${CI_PRECHECK_DIR}/gha_ci_lint.json`]);
    const again = await deriveCiPrecheck({ buildPlan: async () => PLAN, required: ["Lint"], cfg: parseCiPrecheckConfig(null), wt: "/wt", base: "b", lane: "l", writeFile: async () => {}, skipJobs: new Set(["gha:ci:lint"]) });
    assert.equal(again.commands.length, 0); assert.match(again.skipped.at(-1).reason, /earlier round/);
  });

  it("a planner failure (no yq) is one unrunnable entry, never a throw", async () => {
    const d = await deriveCiPrecheck({ buildPlan: async () => { throw new Error("yq not found (mikefarah yq v4 is required to read CI definitions)"); }, cfg: parseCiPrecheckConfig(null), wt: "/wt", base: "b", lane: "l", writeFile: async () => {} });
    assert.deepEqual(d.commands, []); assert.equal(d.source, "none");
    assert.match(d.unrunnable[0].reason, /CI check plan unavailable: yq not found/);
  });

  it("exit 1 fails; exit 2/124/127 are unrunnable with a reason; exit 0 with a deferred line is deferred", () => {
    assert.deepEqual(ciPrecheckOutcome({ rc: 0, output: "CI_LOCAL_RESULT: PASS" }), { status: "pass", reason: "" });
    assert.deepEqual(ciPrecheckOutcome({ rc: 1, output: "x\nCI_LOCAL_FAIL: gha:ci:lint | step: pnpm lint | exit 1\n" }), { status: "fail", reason: "gha:ci:lint | step: pnpm lint | exit 1" });
    assert.deepEqual(ciPrecheckOutcome({ rc: 2, output: "CI_LOCAL_RESULT: DEGRADED reason=budget_exhausted" }), { status: "unrunnable", reason: "budget_exhausted" });
    assert.equal(ciPrecheckOutcome({ rc: 124, output: "" }).status, "unrunnable");
    assert.match(ciPrecheckOutcome({ rc: 127, output: "bash: node: command not found" }).reason, /could not start: bash: node/);
    assert.deepEqual(ciPrecheckOutcome({ rc: 0, output: "CI_LOCAL_DEFERRED: gha:ci:unit | Unit | version drift (node 18 vs 22)\nCI_LOCAL_RESULT: PASS" }), { status: "deferred", reason: "version drift (node 18 vs 22)" });
  });
});

// Plan derivation from a sample workflow through the real ci-local planner; needs mikefarah yq v4 (skipped without it).
const yq = spawnSync("yq", ["-o=json", ".", "-"], { input: "a: 1\n", encoding: "utf8" });
describe("#5820 plan derivation from workflow YAML (ci-local planner)", { skip: yq.status === 0 && /"a": 1/.test(yq.stdout) ? false : "yq v4 not installed" }, () => {
  it("required lint and unit jobs run, the e2e job stays CI-only, the docs-only workflow does not apply", async () => {
    const { buildPlan } = await import("../../scripts/ci-local/plan.mjs");
    const repo = tmpDir("ci-precheck-"), g = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
    g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.com"); g("config", "user.name", "t");
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true }); mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), [
      "name: CI", "on:", "  pull_request:", "jobs:",
      "  lint:", "    name: Lint", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v4", "      - run: echo lint-ok",
      "  unit:", "    name: Unit tests", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v4", "      - run: echo unit-ok",
      "  e2e:", "    name: E2E", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v4", "      - run: echo playwright",
      "  deploy:", "    runs-on: ubuntu-latest", "    environment: prod", "    steps:", "      - run: echo deploy", ""].join("\n"));
    writeFileSync(join(repo, ".github", "workflows", "docs.yml"), ["name: Docs", "on:", "  pull_request:", "    paths: ['docs/**']", "jobs:", "  links:", "    runs-on: ubuntu-latest", "    steps:", "      - run: echo links", ""].join("\n"));
    writeFileSync(join(repo, "src", "a.js"), "1\n"); g("add", "-A"); g("commit", "-qm", "base");
    const plan = buildPlan({ repo, base: "main", files: ["src/a.js"], noCache: true });
    const s = selectCiPrecheck({ plan, required: ["Lint", "Unit tests", "E2E"] });
    assert.equal(s.source, "required");
    assert.deepEqual(s.run.map((r) => [r.job, r.steps]), [["gha:ci:lint", ["echo lint-ok"]], ["gha:ci:unit", ["echo unit-ok"]]]);
    assert.match(s.skipped.find((x) => x.job === "gha:ci:e2e").reason, /^heavy \(e2e\)/);
    assert.match(s.skipped.find((x) => /docs/.test(x.job)).reason, /path filter/);
  });
});
