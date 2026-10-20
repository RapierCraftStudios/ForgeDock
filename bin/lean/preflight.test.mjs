// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellSegments, pythonImports, nodeImports, preflightProbes, preflightProblems } from "./preflight.mjs";
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
