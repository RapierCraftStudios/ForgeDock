// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5748: the lane workflow's security shape, checked as text (zero LLM).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const text = readFileSync(fileURLToPath(new URL("../../.github/workflows/forgedock-lane.yml", import.meta.url)), "utf8");
const code = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

describe("forgedock-lane.yml (#5748)", () => {
  it("triggers on workflow_dispatch only, never pull_request or pull_request_target", () => {
    const on = /^on:\n((?:[ ]+.*\n|\n)+)/m.exec(code)[1];
    assert.deepEqual([...on.matchAll(/^  ([a-z_]+):/gm)].map((m) => m[1]), ["workflow_dispatch"]);
    assert.doesNotMatch(code, /pull_request/);
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
