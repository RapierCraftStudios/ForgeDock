// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5748: the lane workflow's security shape, checked as text (zero LLM).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { fileURLToPath } from "node:url";

const text = readFileSync(fileURLToPath(new URL("../../.github/workflows/forgedock-lane.yml", import.meta.url)), "utf8");
const code = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

describe("forgedock-lane.yml (#5748)", () => {
  it("triggers on workflow_dispatch only, never pull_request or pull_request_target", () => {
    const on = /^on:\n((?:[ ]+.*\n|\n)+)/m.exec(code)[1];
    assert.deepEqual([...on.matchAll(/^  ([a-z_]+):/gm)].map((m) => m[1]), ["workflow_dispatch"]);
    assert.doesNotMatch(code, /^\s*pull_request(_target)?:/m); // no such trigger key; ruleset type names in the #5899 guard are not triggers
  });
  it("has least-privilege permissions, an environment holding the credential, and a job limit under 6 h", () => {
    assert.match(code, /^permissions:\n  contents: write\n  issues: write\n  pull-requests: write\n/m);
    assert.doesNotMatch(code, /permissions:[\s\S]*(actions|packages|id-token|security-events): write/);
    assert.match(code, /environment: forgedock-lane/);
    assert.match(code, /secrets\.CLAUDE_CODE_OAUTH_TOKEN/);
    const m = /timeout-minutes: (\d+)/.exec(code); assert.ok(m && Number(m[1]) < 360);
    assert.match(code, /timeout 345m forgedock run-issue/);
    assert.doesNotMatch(code, /run-issue[^\n]*\|\| true/); // the cap must not be swallowed: rc 124 posts the retryable deferral
    assert.match(code, /\[ "\$rc" = 124 \][\s\S]*sandbox\.actions_timeout/);
  });
  it("keeps inputs out of shell text, pushes to feat/* only and never echoes env or secrets", () => {
    assert.doesNotMatch(code, /run:[^\n]*\$\{\{ *inputs\./);
    assert.match(code, /refs\/heads\/feat\/\*/);
    assert.doesNotMatch(code, /\b(printenv|set -x)\b|\benv\s*(\||$)|echo[^\n]*(secrets\.|TOKEN)/m);
    assert.match(code, /run-issue[^\n]*> \/dev\/null 2>&1/);
    assert.match(code, /run-name: forgedock-lane \$\{\{ inputs\.lane_id \}\}/);
  });
});

/** The guard step's shell body (#5899), dedented from the workflow text. */
function guardScript() {
  const lines = text.split("\n"), i = lines.findIndex((l) => l.includes("id: guard"));
  const r = lines.findIndex((l, k) => k > i && /^\s+run: \|$/.test(l));
  const body = [];
  for (let k = r + 1; k < lines.length && (lines[k].startsWith("          ") || lines[k] === ""); k++) body.push(lines[k].slice(10));
  return body.join("\n");
}
const hasJq = spawnSync("jq", ["--version"]).status === 0;

/** Runs the guard against a stub gh answering `repos/o/r/<path>` from `api` (a path missing from `api` fails like a 404). */
function runGuard(api, { def = "main", ref = "staging" } = {}) {
  const dir = tmpDir("lane-guard-"), bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, "api.json"), JSON.stringify(api));
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const [, , cmd, path, flag, expr] = process.argv;
const api = JSON.parse(require("fs").readFileSync(${JSON.stringify(join(dir, "api.json"))}, "utf8"));
const key = path.replace(/^repos\\/o\\/r\\//, "");
if (cmd !== "api" || !(key in api)) { process.stderr.write("HTTP 404"); process.exit(1); }
process.stdout.write(require("child_process").execFileSync("jq", ["-r", expr], { input: JSON.stringify(api[key]) }));
`);
  chmodSync(join(bin, "gh"), 0o755);
  const out = join(dir, "out"), res = join(dir, "result.json");
  writeFileSync(out, "");
  const r = spawnSync("bash", ["-e", "-c", guardScript()], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_REPO: "o/r", DEFAULT_BRANCH: def, LANE_REF: ref, RESULT_FILE: res, GITHUB_OUTPUT: out }, encoding: "utf8" });
  return { status: r.status, ok: /ok=true/.test(readFileSync(out, "utf8")), result: existsSync(res) ? JSON.parse(readFileSync(res, "utf8")) : null };
}

describe("forgedock-lane.yml protection guard (#5899)", () => {
  it("every step that checks out, installs or runs the lane is gated on the guard", () => {
    const steps = code.split(/\n      - /).slice(1);
    const gi = steps.findIndex((t) => t.includes("id: guard"));
    assert.ok(gi > 0 && gi < steps.findIndex((t) => t.startsWith("uses: actions/checkout")));
    for (const t of steps.slice(gi + 1)) {
      if (t.startsWith("name: Post result")) { assert.match(t, /if: always\(\)/); continue; }
      assert.match(t, /if: steps\.guard\.outputs\.ok == 'true'/, t.split("\n")[0]);
    }
  });
  it("passes when both branches have a blocking ruleset or classic required status checks", { skip: !hasJq && "jq not installed" }, () => {
    assert.ok(runGuard({ "rules/branches/main": [{ type: "pull_request" }], "rules/branches/staging": [{ type: "required_status_checks" }] }).ok);
    const g = runGuard({ "rules/branches/main": [], "branches/main": { protected: true, protection: { required_status_checks: { enforcement_level: "non_admins", contexts: ["ci"] } } }, "rules/branches/staging": [{ type: "update" }] });
    assert.equal(g.ok, true); assert.equal(g.result, null);
  });
  it("refuses, with a needs-human result naming the branch, when a branch is unprotected or protection is unreadable", { skip: !hasJq && "jq not installed" }, () => {
    const g = runGuard({ "rules/branches/main": [{ type: "pull_request" }], "rules/branches/staging": [{ type: "non_fast_forward" }], "branches/staging": { protected: false } });
    assert.equal(g.status, 0); assert.equal(g.ok, false);
    assert.equal(g.result.terminalReason, "needs-human"); assert.equal(g.result.code, "sandbox.start_failed");
    assert.match(g.result.detail, / staging have no server-side push protection/); assert.doesNotMatch(g.result.detail, /main/);
    // classic protection without a required status check does not block a fast-forward push
    assert.equal(runGuard({ "rules/branches/main": [{ type: "pull_request" }], "rules/branches/staging": [], "branches/staging": { protected: true, protection: { required_status_checks: { enforcement_level: "non_admins", contexts: [] } } } }).ok, false);
    // the API failing (no answer) fails closed
    const f = runGuard({});
    assert.equal(f.ok, false); assert.match(f.result.detail, / main staging have/);
  });
});
