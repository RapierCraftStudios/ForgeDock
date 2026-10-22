// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellSegments, pythonImports, nodeImports, preflightProbes, preflightProblems, runProbeMiss, unsetEnvVars, runPreflight, knownToContract } from "./preflight.mjs";
import { runCheckCommand } from "./effects.mjs";
import { repoTracks } from "./conformance.mjs";
import { tmpDir } from "../tests/_tmp.mjs";

const C = (...commands) => ({ deliverables: [], validate: commands.map((command, i) => ({ id: `V${i + 1}`, command })) });
const needs = (c, o) => preflightProbes(c, o).probes.map((p) => [p.kind, p.tool, p.interp ?? null, p.ids.join(",")]);

describe("#4328 validate preflight: what a command needs", () => {
  it("splits on && || | ; and newlines, keeps quotes and $(...) whole", () => {
    assert.deepEqual(shellSegments(`cd a && python3 -c "import yaml; print('x | y')" | tee "$TMPDIR/o" ; git diff $(git merge-base HEAD origin/x) -- a || true`),
      [["cd", "a"], ["python3", "-c", "import yaml; print('x | y')"], ["tee", "$TMPDIR/o"], ["git", "diff", "$(git merge-base HEAD origin/x)", "--", "a"], ["true"]]);
  });
  it("python -c imports and -m modules (top-level, absolute only); node -e bare packages", () => {
    assert.deepEqual(pythonImports("import yaml, os.path as p\nfrom jsonschema.validators import x; from . import y; from __future__ import annotations; __import__('toml')"), ["yaml", "os", "jsonschema", "toml"]);
    assert.deepEqual(nodeImports(`const z=require("zod"); import("@scope/pkg/sub"); import fs from "node:fs"; require("./x"); require("path")`), ["zod", "@scope/pkg"]);
  });
  it("probes each bare executable, a bare python's modules and node -e packages, deduped across validate ids", () => {
    assert.deepEqual(needs(C(`FOO=1 python3 -c "import yaml,json"`, "python3 -m pytest -q tests/x.py && jq . a.json", `node -e "require('zod')"`, "python3 -c 'import yaml'")), [
      ["command", "python3", null, "V1,V2,V4"], ["python-module", "yaml", "python3", "V1,V4"], ["python-module", "json", "python3", "V1"],
      ["python-module", "pytest", "python3", "V2"], ["command", "jq", null, "V2"], ["command", "node", null, "V3"], ["node-module", "zod", "node", "V3"]]);
  });
  it("wrappers and paths: only the wrapper is probed; ./script and .venv/bin/python and $VAR never are", () => {
    assert.deepEqual(needs(C(`uv run python -c "import yaml"`, "./scripts/check.sh", `.venv/bin/python -c "import yaml"`, "$PY -m x", "npx vitest run a.test.ts")),
      [["command", "uv", null, "V1"], ["command", "npx", null, "V5"]]);
  });
  it("skips names the repo tracks and names a deliverable's change adds", () => {
    const c = { ...C(`python3 -c "import app, yaml"`, `node -e "require('left-pad')"`), deliverables: [{ id: "D1", path: "package.json", change: "add devDependency left-pad for the check" }] };
    assert.deepEqual(needs(c, { repoHas: repoTracks(["app/__init__.py"]) }).map((x) => x[1]), ["python3", "yaml", "node"]);
  });
  it("caps the probes and reports the dropped count", () => {
    const r = preflightProbes(C(Array.from({ length: 25 }, (_, i) => `tool${i}`).join(" && ")), { cap: 20 });
    assert.equal(r.probes.length, 20); assert.equal(r.dropped, 5);
  });
  it("a problem line names the ids, the kind and the tool and forbids a global install", () => {
    const [p] = preflightProblems([{ ids: ["V5"], tool: "yaml", kind: "python-module", interp: "python3" }]);
    assert.match(p, /^V5: needs Python module 'yaml' \(for python3\), which this host lacks/);
    assert.match(p, /repo's own toolchain .*never a global install/);
  });
  it("the probes are real read-only shell checks: present tools pass, absent ones fail", async () => {
    const dir = tmpDir("preflight-");
    mkdirSync(join(dir, "node_modules", "here"), { recursive: true }); writeFileSync(join(dir, "node_modules", "here", "package.json"), "{}");
    mkdirSync(join(dir, "sub"));
    const probes = preflightProbes(C("bash -c true", "no-such-tool-4328 --x", `node -e "require('here'); require('fs'); require('absent-pkg-4328')"`)).probes;
    const rc = {};
    for (const p of probes) rc[`${p.kind}:${p.tool}`] = (await runCheckCommand({ command: p.probe, cwd: join(dir, "sub"), timeoutMs: 15000 })).rc;
    assert.equal(rc["command:bash"], 0); assert.notEqual(rc["command:no-such-tool-4328"], 0);
    assert.equal(rc["command:node"], 0); assert.equal(rc["node-module:here"], 0, "found in an ancestor node_modules");
    assert.notEqual(rc["node-module:absent-pkg-4328"], 0);
    const py = preflightProbes(C(`python3 -c "import json, no_such_mod_4328"`)).probes.filter((p) => p.kind === "python-module");
    if ((await runCheckCommand({ command: "command -v python3", cwd: dir })).rc === 0) {
      assert.deepEqual(await Promise.all(py.map(async (p) => (await runCheckCommand({ command: p.probe, cwd: dir })).rc !== 0)), [false, true]);
    }
  });
});

describe("#4393 validate preflight: running the command on base", () => {
  const known = knownToContract({ deliverables: [{ id: "D1", path: "tools/new_check.py", change: "add module newlib" }], repro_test: { path: "test/r.test.mjs" } }, ["shared/detection/__init__.py", "scripts/run.sh"]);
  it("unrunnable: a missing module, command or path; a repo-tracked or deliverable-named module is not the host", () => {
    assert.deepEqual(runProbeMiss({ rc: 1, output: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'httpx'\n" }, known),
      { tool: "httpx", kind: "python-module", line: "ModuleNotFoundError: No module named 'httpx'" });
    assert.equal(runProbeMiss({ rc: 1, output: "ModuleNotFoundError: No module named 'shared'" }, known), null);
    assert.equal(runProbeMiss({ rc: 1, output: "ModuleNotFoundError: No module named 'newlib'" }, known), null);
    assert.equal(runProbeMiss({ rc: 127, output: "bash: line 1: jq: command not found" }, known).tool, "jq");
    assert.deepEqual(runProbeMiss({ rc: 127, output: "bash: line 1: ./scripts/gone.sh: No such file or directory" }, known), { tool: "./scripts/gone.sh", kind: "path", line: "bash: line 1: ./scripts/gone.sh: No such file or directory" });
    assert.equal(runProbeMiss({ rc: 2, output: "python3: can't open file '/wt/x/tools/old.py': [Errno 2] No such file or directory" }, known).kind, "path");
  });
  it("runs: passes, RED test failures, timeouts and paths the change adds are no miss", () => {
    for (const r of [{ rc: 0, output: "" }, { rc: 1, output: "AssertionError: expected 1 to equal 2" }, { rc: 124, output: "ModuleNotFoundError: No module named 'httpx'\n(timed out after 30s)" },
      { rc: 2, output: "python3: can't open file '/wt/x/tools/new_check.py': [Errno 2] No such file or directory" }, { rc: 4, output: "ERROR: file or directory not found: tests/test_new.py" },
      { rc: 1, output: "Could not find '/wt/x/test/r.test.mjs'" }, { rc: 1, output: "cat: data.json: No such file or directory" }]) assert.equal(runProbeMiss(r, known), null, r.output);
  });
  it("unset env vars: empty or unset, outside single quotes, not assigned or defaulted by the command", () => {
    assert.deepEqual(unsetEnvVars(`cat "$TMPDIR/x" && echo \${OUT} '$SINGLE' \\$ESC \${D:-1} $? $HOME`, { TMPDIR: "", HOME: "/h" }), ["TMPDIR", "OUT"]);
    assert.deepEqual(unsetEnvVars(`X=1; echo $X; export Y=2 && echo "$Y"; for F in a b; do echo $F; done; echo $SET`, { SET: "s" }), []);
  });
  it("runPreflight runs every command with the env and a capped timeout, skips ids, honours the budget and reverts only what the runs changed", async () => {
    const ran = [], gits = [];
    let clock = 0, st = " M kept.js\n";
    const run = async (a) => { ran.push([a.command, a.timeoutMs, a.env.K]); clock += 70000; st += "?? new.log\n M src/a.js\n"; return { rc: 1, output: a.command === "c1" ? "ModuleNotFoundError: No module named 'httpx'" : "" }; };
    const git = async (args) => { gits.push(args.join(" ")); return args[0] === "status" ? st : ""; };
    const contract = { validate: ["c1", "c2", "c3", "c4"].map((command, i) => ({ id: `V${i + 1}`, command })) };
    const r = await runPreflight({ contract, run, git, env: { K: "v" }, skipIds: ["V2"], now: () => clock });
    assert.deepEqual(ran, [["c1", 30000, "v"], ["c3", 30000, "v"]]);
    assert.deepEqual(r.misses.map((m) => [m.ids, m.tool, m.kind, m.source]), [[["V1"], "httpx", "python-module", "run"]]);
    assert.deepEqual(r.skipped, ["V4"]);
    assert.deepEqual(r.reverted, ["new.log", "src/a.js"]);
    assert.deepEqual(gits.filter((g) => !g.startsWith("status")), ["clean -fdq -- new.log", "checkout -- src/a.js"], "kept.js was dirty before: untouched");
  });
  it("problem lines name the id, the tool and the observed line, or the env var", () => {
    const [run, env] = preflightProblems([{ ids: ["V4"], tool: "httpx", kind: "python-module", source: "run", line: "ModuleNotFoundError: No module named 'httpx'" }, { ids: ["V2"], tool: "TMPDIR", kind: "env-var", source: "env" }]);
    assert.match(run, /^V4: running it on the base worktree stopped before any test ran: needs Python module 'httpx' \(`ModuleNotFoundError[^`]*`\)[\s\S]*repo's own toolchain .*never a global install/);
    assert.match(env, /^V2: uses \$TMPDIR, which is unset or empty in the lane environment/);
  });
  it("a real run: a missing module is a miss, a failing test is not", async () => {
    const dir = tmpDir("preflight-run-");
    const git = async () => "";
    const contract = C(`node -e "require('absent-pkg-4393')"`, `node -e "process.exit(1)"`);
    const r = await runPreflight({ contract, run: (a) => runCheckCommand({ ...a, cwd: dir }), git });
    assert.deepEqual(r.misses.map((m) => [m.ids[0], m.tool]), [["V1", "absent-pkg-4393"]]);
  });
});
