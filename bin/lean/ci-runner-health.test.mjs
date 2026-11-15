// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { ciFromCli } from "./ci-budget.mjs";
import { ciRunnerHealthFromCli, detectRunnerHealth, planRecovery, applyRecovery, renderRunnerHealthUnits, parseRunnerHealthConfig, RESTART_COOLDOWN_MS } from "./ci-runner-health.mjs";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const cfg = { repo: "o/r", services: ["actions.runner.o-r.r1.service", "actions.runner.o-r.r2.service"], minDiskGb: 10, jobTimeoutMin: 360 };
const ghFor = ({ busy = [], runs = [], jobs = {} } = {}) => async (a) => {
  const u = a.join(" ");
  if (/actions\/runners/.test(u)) return JSON.stringify({ runners: busy.map((name) => ({ name, busy: true })).concat([{ name: "idle", busy: false }]) });
  if (/actions\/runs\?/.test(u)) return JSON.stringify({ workflow_runs: runs });
  const m = /actions\/runs\/(\d+)\/jobs/.exec(u);
  if (m) return JSON.stringify({ jobs: jobs[m[1]] ?? [] });
  throw new Error(`unexpected ${u}`);
};
const cwdWith = () => { const d = tmpDir("crh-"); writeFileSync(join(d, "forge.yaml"), `ci:\n  repo: o/r\n  services:\n${cfg.services.map((x) => `    - ${x}`).join("\n")}\n`); return d; };
const healthy = (o = {}) => ({
  now: () => NOW, gh: ghFor(), diskGb: () => 50, memGb: () => 8,
  systemctl: async () => ({ code: 0, out: "active\n" }),
  docker: async () => ({ code: 0, out: "" }),
  ...o,
});
const kinds = async (o, c = cfg) => (await detectRunnerHealth(c, healthy(o))).findings.map((f) => f.kind);

test("healthy fixture: no findings, no events, exit 0", async () => {
  const posts = [], lines = [];
  const code = await ciRunnerHealthFromCli([], { cwd: tmpDir("crh-"), env: { FORGEDOCK_CI_EVENTS_URL: "http://x/ci/events", GITHUB_REPOSITORY: "o/r" }, out: (l) => lines.push(l), fetchImpl: async (u, i) => { posts.push(i.body); return { status: 202 }; }, ...healthy() });
  assert.equal(code, 0); assert.equal(posts.length, 0); assert.match(lines.at(-1), /healthy/);
});

test("(a) busy runner on a cancelled run is stuck, mapped to its own service", async () => {
  const o = { gh: ghFor({ busy: ["r1"], runs: [{ id: 7, status: "completed", conclusion: "cancelled" }], jobs: { 7: [{ id: 70, status: "in_progress", runner_name: "r1" }] } }) };
  const r = await detectRunnerHealth(cfg, healthy(o));
  assert.deepEqual(r.findings.map((f) => [f.kind, f.service]), [["stuck-run", "actions.runner.o-r.r1.service"]]);
  // busy on a live run: not stuck
  assert.deepEqual(await kinds({ gh: ghFor({ busy: ["r1"], runs: [{ id: 8, status: "in_progress", conclusion: null }] }) }), []);
});

test("(b) inactive service", async () => {
  const f = (await detectRunnerHealth(cfg, healthy({ systemctl: async (a) => ({ code: 3, out: a[1].includes(".r2.") ? "failed\n" : "active\n" }) }))).findings;
  assert.deepEqual(f.map((x) => [x.kind, x.service]), [["service-down", cfg.services[1]]]);
});

test("(c) only old runner-labelled containers are orphaned", async () => {
  const row = (ID, CreatedAt, Labels) => JSON.stringify({ ID, CreatedAt, Labels });
  const docker = async () => ({ code: 0, out: [row("old1", "2026-11-15 01:00:00 +0000 UTC", "com.github.actions.runner=r1"), row("new1", "2026-11-15 11:00:00 +0000 UTC", "com.github.actions.runner=r1"), row("other", "2026-11-01 01:00:00 +0000 UTC", "app=db")].join("\n") });
  const f = (await detectRunnerHealth(cfg, healthy({ docker }))).findings;
  assert.deepEqual(f.map((x) => x.id), ["old1"]);
});

test("(d) low disk and low memory", async () => {
  assert.deepEqual(await kinds({ diskGb: () => 3 }), ["low-disk"]);
  assert.deepEqual(await kinds({ memGb: () => 0.4 }), ["low-memory"]);
  assert.deepEqual(await kinds({ diskGb: () => 5 }, { ...cfg, minDiskGb: 4 }), []);
});

test("each finding posts one runner_unhealthy event the bus accepts", async () => {
  const { validateEvent } = await import("../pool/ci-events.mjs");
  const posts = [];
  const code = await ciRunnerHealthFromCli(["--json"], { cwd: tmpDir("crh-"), env: { FORGEDOCK_CI_EVENTS_URL: "http://x/ci/events", GITHUB_REPOSITORY: "o/r" }, out: () => {}, fetchImpl: async (u, i) => { posts.push(JSON.parse(i.body)); return { status: 202 }; }, ...healthy({ diskGb: () => 1, memGb: () => 0.1 }) });
  assert.equal(code, 1); assert.equal(posts.length, 2);
  for (const p of posts) { assert.equal(validateEvent(p).type, "runner_unhealthy"); assert.equal(p.class, "infra"); }
});

test("dry run is the default: prints the plan and acts on nothing", async () => {
  const calls = [], lines = [];
  const o = healthy({ systemctl: async (a) => { calls.push(a); return { code: 3, out: "inactive\n" }; }, docker: async (a) => { calls.push(a); return { code: 0, out: "" }; } });
  await ciRunnerHealthFromCli(["--repo", "o/r"], { cwd: cwdWith(), env: {}, out: (l) => lines.push(l), dir: tmpDir("crh-d-"), ...o });
  assert.ok(calls.every((a) => a[0] === "is-active" || a[0] === "ps"));
  assert.ok(lines.some((l) => /plan \(dry run/.test(l)));
});

test("--recover restarts only the affected service and removes only orphans", async () => {
  const calls = [], dir = tmpDir("crh-d-");
  const row = JSON.stringify({ ID: "old1", CreatedAt: "2026-11-15 01:00:00 +0000 UTC", Labels: "com.github.actions.runner=r1" });
  const systemctl = async (a) => { calls.push(["sc", ...a]); return { code: 0, out: a[0] === "is-active" ? (a[1].includes(".r2.") ? "failed\n" : "active\n") : "" }; };
  const docker = async (a) => { calls.push(["dk", ...a]); return { code: 0, out: a[0] === "ps" ? row : "" }; };
  await ciRunnerHealthFromCli(["--recover"], { cwd: cwdWith(), env: {}, out: () => {}, dir, ...healthy({ systemctl, docker }), now: () => NOW });
  assert.deepEqual(calls.filter((c) => c[1] === "restart" || c[1] === "rm"), [["sc", "restart", cfg.services[1]], ["dk", "rm", "-f", "old1"]]);
});

test("recovery is idempotent and rate limited to one restart per service per 10 min", async () => {
  const calls = [], dir = tmpDir("crh-d-"), lines = [];
  const deps = { systemctl: async (a) => { calls.push(a); return { code: 0, out: "" }; }, docker: async () => ({ code: 0, out: "" }), dir, out: (l) => lines.push(l) };
  const plan = planRecovery([{ kind: "service-down", service: "s1", reason: "x" }, { kind: "stuck-run", service: "s1", reason: "y" }]);
  assert.equal(plan.length, 1);
  await applyRecovery(plan, { ...deps, nowMs: NOW });
  await applyRecovery(plan, { ...deps, nowMs: NOW + 60000 });
  assert.equal(calls.length, 1); assert.ok(lines.some((l) => /cooldown/.test(l)));
  await applyRecovery(plan, { ...deps, nowMs: NOW + RESTART_COOLDOWN_MS + 1 });
  assert.equal(calls.length, 2);
});

test("timer unit runs every 2 min; --recover only when configured; config parses", () => {
  const u = renderRunnerHealthUnits({ node: "/n", cli: "/c.mjs", cwd: "/w", recover: true });
  assert.match(u.timer, /OnUnitActiveSec=2min/); assert.match(u.service, /"ci" "runner-health" "--recover"/);
  assert.doesNotMatch(renderRunnerHealthUnits({ node: "/n", cli: "/c.mjs", cwd: "/w" }).service, /--recover/);
  const dir = tmpDir("crh-");
  writeFileSync(join(dir, "forge.yaml"), "ci:\n  repo: o/r\n  min_disk_gb: 20\n  recover: true\n  services:\n    - a.service\n    - b.service\n");
  assert.deepEqual(parseRunnerHealthConfig(dir), { repo: "o/r", services: ["a.service", "b.service"], minDiskGb: 20, recover: true, jobTimeoutMin: 360 });
});

test("ci runner-health routes through ciFromCli; unknown argument throws", async () => {
  const lines = [];
  const code = await ciFromCli(["runner-health", "--print-units"], { out: (l) => lines.push(l), cwd: tmpDir("crh-") });
  assert.equal(code, 0); assert.match(lines.join("\n"), /OnUnitActiveSec=2min/);
  await assert.rejects(() => ciRunnerHealthFromCli(["--bogus"], {}), /unknown argument/);
});
