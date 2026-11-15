// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { runCiPreflight, ciPreflightFromCli, emitEvents, parseCiPreflightConfig, yamlProblem, workflowEnvKeys } from "./ci-preflight.mjs";
import { ciFromCli } from "./ci-budget.mjs";

const GOOD_WF = "name: ci\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    env:\n      API_KEY: ${{ secrets.API_KEY }}\n    steps:\n      - run: echo hi\n";
const put = (root, rel, text) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
/** Fixture repo: kind node-pnpm | py-uv | py-poetry, all clean, with a workflow and a matching .env.example. */
function fixture(kind, { forge = "" } = {}) {
  const root = tmpDir("cipf-");
  put(root, ".github/workflows/ci.yml", GOOD_WF);
  put(root, ".env.example", "API_KEY=\n");
  if (kind === "node-pnpm") { put(root, "package.json", "{}"); put(root, "pnpm-lock.yaml", "lockfileVersion: 9\n"); }
  if (kind === "py-uv") { put(root, "pyproject.toml", "[project]\nname='x'\n"); put(root, "uv.lock", "version = 1\n"); }
  if (kind === "py-poetry") { put(root, "pyproject.toml", "[tool.poetry]\nname='x'\n"); put(root, "poetry.lock", "# lock\n"); }
  if (forge) put(root, "forge.yaml", forge);
  return root;
}
const ALL = () => true;
const okRun = () => ({ code: 0, out: "" });
const by = (res, name) => res.checks.find((c) => c.name === name);
const statuses = (res) => Object.fromEntries(res.checks.map((c) => [c.name, c.status]));

test("clean fixtures: every check passes or skips, within budget", () => {
  for (const [kind, lock] of [["node-pnpm", "lockfile:pnpm"], ["py-uv", "lockfile:uv"], ["py-poetry", "lockfile:poetry"]]) {
    const res = runCiPreflight(fixture(kind), { run: okRun, which: ALL });
    assert.equal(res.ok, true, kind);
    assert.equal(by(res, lock).status, "pass");
    assert.ok(res.checks.every((c) => c.status !== "fail") && res.elapsedMs < 60000);
    assert.equal(by(res, "generated").status, "skip");
    assert.equal(by(res, "tools").status, "skip");
  }
});

test("each injected defect fails only its own check, with a one-line reason", () => {
  const cases = {
    "workflow-lint": (r) => put(r, ".github/workflows/ci.yml", 'name: "oops\non: push\n'),
    "lockfile:pnpm": null,
    "env-drift": (r) => put(r, ".env.example", "OTHER=\n"),
    tools: null,
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const root = fixture("node-pnpm", { forge: name === "tools" ? "ci:\n  tools:\n    - nosuchtool\n" : "" });
    mutate?.(root);
    const run = (cmd) => (name === "lockfile:pnpm" && cmd === "pnpm" ? { code: 1, out: "ERR_PNPM_OUTDATED_LOCKFILE\nmore" } : { code: 0, out: "" });
    const res = runCiPreflight(root, { run, which: (c) => c !== "nosuchtool" && c !== "actionlint" });
    const bad = res.checks.filter((c) => c.status === "fail");
    assert.deepEqual(bad.map((c) => c.name), [name], name);
    assert.ok(!bad[0].reason.includes("\n"));
    assert.equal(res.ok, false);
  }
});

test("stale generated artifact (real git): fails after the generator rewrites a tracked path; clean when unchanged", () => {
  const root = fixture("node-pnpm", { forge: 'ci:\n  generated:\n    - echo "v2" > sdk.txt :: sdk.txt\n' });
  put(root, "sdk.txt", "v1\n");
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, stdio: "ignore" });
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "init");
  const res = runCiPreflight(root, { which: () => false });
  const g = by(res, "generated");
  assert.equal(g.status, "fail"); assert.match(g.reason, /stale generated artifact: sdk\.txt/);
  assert.ok(res.elapsedMs < 60000, `SDK-drift replay took ${res.elapsedMs} ms (budget 60000)`);
  writeFileSync(join(root, "sdk.txt"), "v2\n"); git("commit", "-qam", "regen");
  assert.equal(by(runCiPreflight(root, { which: () => false }), "generated").status, "pass");
});

test("missing optional tools are skipped with a reason and exit 0", async () => {
  const root = fixture("node-pnpm"); const lines = [];
  const code = await ciPreflightFromCli([], { cwd: root, out: (l) => lines.push(l), which: () => false, run: () => { throw new Error("must not run"); } });
  assert.equal(code, 0);
  const res = runCiPreflight(root, { which: () => false, run: okRun });
  assert.equal(by(res, "lockfile:pnpm").status, "skip"); assert.match(by(res, "lockfile:pnpm").reason, /not on PATH/);
  assert.equal(by(res, "workflow-lint").status, "pass"); // YAML fallback when actionlint is absent
  assert.ok(lines.some((l) => /^SKIP\s+lockfile:pnpm/.test(l)));
});

test("no forge.yaml key: no configured checks, only auto-detected ones; empty repo skips everything", () => {
  assert.deepEqual(parseCiPreflightConfig(fixture("node-pnpm")), { generated: [], tools: [], timeoutS: 60 });
  const empty = runCiPreflight(tmpDir("cipf-"), { run: okRun, which: ALL });
  assert.equal(empty.ok, true);
  assert.ok(empty.checks.every((c) => c.status === "skip"), JSON.stringify(statuses(empty)));
  const cfg = parseCiPreflightConfig(fixture("py-uv", { forge: "ci:\n  mode: remote\n  timeout_s: 5\n  tools: [a, b]\n  generated:\n    - gen :: a.txt b.txt\n" }));
  assert.deepEqual(cfg, { generated: [{ cmd: "gen", paths: ["a.txt", "b.txt"] }], tools: ["a", "b"], timeoutS: 5 });
});

test("budget: a check starting after the deadline is skipped", () => {
  let t = 0;
  const res = runCiPreflight(fixture("node-pnpm", { forge: "ci:\n  timeout_s: 1\n" }), { run: okRun, which: ALL, now: () => (t += 600) });
  assert.ok(res.checks.some((c) => c.status === "skip" && /budget of 1s exhausted/.test(c.reason)));
});

test("yamlProblem and workflowEnvKeys", () => {
  assert.equal(yamlProblem(GOOD_WF), null);
  assert.match(yamlProblem("a:\n\tb: 1\n"), /tab/);
  assert.match(yamlProblem("a: [1, 2\n"), /unbalanced/);
  assert.equal(yamlProblem("run: |\n  echo 'it's\n  x: \"open\n"), null); // block scalar bodies are not scanned
  assert.deepEqual([...workflowEnvKeys(GOOD_WF)], ["API_KEY"]);
});

test("events: step_failed POSTed per failed check only when FORGE_CI_EVENTS_URL is set; fetch errors are swallowed", async () => {
  const res = { checks: [{ name: "a", status: "fail", reason: "r" }, { name: "b", status: "pass", reason: "ok" }] };
  assert.equal(await emitEvents(res, { env: {}, fetchImpl: () => assert.fail("no url") }), 0);
  const calls = [];
  assert.equal(await emitEvents(res, { env: { FORGE_CI_EVENTS_URL: "http://x/ci/events", GITHUB_SHA: "abc" }, fetchImpl: async (u, o) => { calls.push([u, JSON.parse(o.body)]); } }), 1);
  assert.equal(calls[0][1].type, "step_failed"); assert.equal(calls[0][1].step, "preflight:a"); assert.equal(calls[0][1].sha, "abc");
  assert.equal(await emitEvents(res, { env: { FORGE_CI_EVENTS_URL: "http://x" }, fetchImpl: async () => { throw new Error("down"); } }), 0);
});

test("cli: --json output, exit 1 on a failure, unknown option throws; ci budget routing intact", async () => {
  const root = fixture("node-pnpm", { forge: "ci:\n  tools:\n    - nosuchtool\n" }); const lines = [];
  const code = await ciFromCli(["preflight", "--json"], { cwd: root, out: (l) => lines.push(l), preflight: { which: () => false, run: okRun } });
  assert.equal(code, 1);
  const j = JSON.parse(lines[0]); assert.equal(j.ok, false); assert.equal(j.checks.find((c) => c.name === "tools").status, "fail");
  await assert.rejects(ciPreflightFromCli(["--bogus"], { cwd: root }), /unknown argument --bogus/);
  await assert.rejects(ciFromCli(["nope"], {}), /usage: forgedock ci preflight/);
});
