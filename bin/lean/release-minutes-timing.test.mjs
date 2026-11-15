// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5718: Actions timing primitives of the release ledger (pure).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyStep, criticalJob, firstFailedStep, isSelfHosted, jobRan, jobSeconds, jobSetup, minuteShares, queueSeconds } from "./release-minutes.mjs";

const T = (s) => `2026-03-01T10:${s}Z`;
const job = (o = {}) => ({ name: "test", conclusion: "success", created_at: T("00:00"), started_at: T("00:30"), completed_at: T("05:30"), labels: ["ubuntu-latest"], runner_group_name: "GitHub Actions", steps: [], ...o });
const step = (name, a, b, conclusion = "success") => ({ name, conclusion, started_at: T(a), completed_at: T(b) });

describe("step classes (#5718)", () => {
  it("classifies checkout, toolchain and dependency steps of every ecosystem by name", () => {
    const want = {
      checkout: ["Run actions/checkout@v4", "Checkout", "Checkout repository", "git clone the sources"],
      toolchain: ["Run actions/setup-node@v4", "Run actions/setup-python@v5", "Run actions/setup-go@v5", "Set up Python", "Setup Node.js", "Set up Docker Buildx", "Run pnpm/action-setup@v4", "Install Rust toolchain", "rustup update stable", "Run astral-sh/setup-uv@v3"],
      deps: ["Install dependencies", "npm ci", "Run npm install", "pnpm install --frozen-lockfile", "yarn install --immutable", "Run yarn", "pip install -r requirements.txt", "poetry install --no-root", "uv sync --frozen", "uv pip install -e .", "bundle install", "composer install", "go mod download", "cargo fetch", "dotnet restore", "Install Python dependencies", "Restore dependency cache", "Run actions/cache@v4"],
      "image-build": ["Build and push image", "Run docker/build-push-action@v6", "docker build -t app .", "Build web image", "docker buildx bake"],
      lint: ["Run lint", "eslint", "ruff check", "Check formatting", "Typecheck", "Lockfile is up to date", "Generated files drift"],
    };
    for (const [cls, names] of Object.entries(want)) for (const n of names) assert.equal(classifyStep(n), cls, n);
  });
  it("the runner's own steps, post steps and work steps are not setup", () => {
    for (const n of ["Set up job", "Complete job", "Post Run actions/checkout@v4", "Post Install dependencies", "Run tests", "Roll out", "Smoke", "", null]) assert.equal(classifyStep(n), null, String(n));
  });
  it("jobSetup sums the seconds of each setup class", () => {
    const j = job({ steps: [step("Set up job", "00:30", "00:32"), step("Run actions/checkout@v4", "00:32", "00:40"), step("Run actions/setup-node@v4", "00:40", "01:00"), step("npm ci", "01:00", "01:45"), step("Run actions/cache@v4", "01:45", "01:50"), step("Run tests", "01:50", "05:30")] });
    assert.deepEqual(jobSetup(j), { checkout: 8, toolchain: 20, deps: 50, total: 78 });
    assert.deepEqual(jobSetup(job()), { checkout: 0, toolchain: 0, deps: 0, total: 0 });
  });
});

describe("job timing (#5718)", () => {
  it("seconds, queue and self-hosted detection", () => {
    assert.equal(jobSeconds(job()), 300); assert.equal(queueSeconds(job()), 30);
    const skipped = job({ conclusion: "skipped", started_at: T("00:00"), completed_at: T("00:00") });
    assert.equal(jobRan(skipped), false); assert.equal(queueSeconds(skipped), null); assert.equal(jobSeconds({}), 0);
    assert.equal(isSelfHosted(job()), false);
    assert.equal(isSelfHosted(job({ labels: ["self-hosted", "linux"] })), true);
    assert.equal(isSelfHosted(job({ labels: ["big"], runner_group_name: "Default" })), true);
    assert.equal(isSelfHosted(job({ labels: ["ubuntu-latest-8-cores"], runner_group_name: "Default Larger Runners" })), false);
  });
  it("minute shares split failed and cancelled job time", () => {
    const s = minuteShares([job(), job({ conclusion: "failure" }), job({ conclusion: "cancelled", completed_at: T("10:30") }), job({ conclusion: "timed_out", completed_at: T("03:00") })]);
    assert.deepEqual([s.seconds, s.failed, s.cancelled], [1350, 450, 600]);
    assert.equal(s.failedShare, 450 / 1350); assert.equal(s.cancelledShare, 600 / 1350);
    assert.deepEqual(minuteShares([]), { seconds: 0, failed: 0, cancelled: 0, failedShare: null, cancelledShare: null });
  });
  it("the critical job ends last; the first failed step is the earliest one", () => {
    const a = job({ name: "lint", completed_at: T("02:00"), conclusion: "failure", steps: [step("Run lint", "00:40", "02:00", "failure")] });
    const b = job({ name: "restore", completed_at: T("25:00"), conclusion: "failure", steps: [step("Run restore", "01:00", "25:00", "failure")] });
    assert.equal(criticalJob([a, b, job({ conclusion: "skipped", started_at: T("30:00"), completed_at: T("30:00") })]).name, "restore");
    assert.equal(criticalJob([]), null);
    assert.deepEqual(firstFailedStep([b, a]), { job: "lint", step: "Run lint", cls: "lint", at: T("02:00") });
    assert.equal(firstFailedStep([job()]), null);
  });
});
