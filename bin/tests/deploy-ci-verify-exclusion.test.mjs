// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4304: the spec CI gates that read `gh pr checks` themselves ignore forgedock/verify (the lean engine's report-only
// gate summary) as scripts/wait-ci-green.sh does, query only valid --json fields, and fail closed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const deploy = read("commands/deploy-pr.md");
const staging = read("commands/review-pr-staging.md");
const gate1E = staging.slice(staging.indexOf("### 1E: CI Status Gate"), staging.indexOf("### Phase 1F"));

// Each `$(gh pr checks ... --json ...)` command substitution through its `|| fallback)`, as one string; comments are skipped.
const checksReads = (text) => [...text.matchAll(/\$\(gh pr checks [^\n]*--json[\s\S]*?\|\|[^\n]*/g)].map((m) => m[0]);
const jqOf = (cmd) => /--jq '([^']+)'/.exec(cmd)?.[1];

describe("#4304: spec CI gates ignore forgedock/verify", () => {
  const reads = [...checksReads(deploy).map((c) => ["deploy-pr", c]), ...checksReads(gate1E).map((c) => ["review-pr-staging 1E", c])];

  it("finds the gate reads (2 in deploy-pr, 1 in review-pr-staging 1E)", () => {
    assert.equal(reads.filter(([f]) => f === "deploy-pr").length, 2);
    assert.equal(reads.filter(([f]) => f !== "deploy-pr").length, 1);
  });

  it("every read uses name,bucket, excludes forgedock/verify and fails closed", () => {
    for (const [f, c] of reads) {
      assert.match(c, /--json name,bucket\b/, `${f}: ${c}`);
      assert.doesNotMatch(c, /status|conclusion/, `${f}: invalid gh pr checks fields`);
      assert.match(c, /select\(\.name != "forgedock\/verify"\)/, `${f}: ${c}`);
      assert.match(c, /\|\| echo "1"\)/, `${f}: an unreadable result must count as failing`);
    }
  });

  it("the jq filters count a red forgedock/verify alone as 0 and any other failure as 1", { skip: spawnSync("jq", ["--version"]).status !== 0 && "jq not on PATH" }, () => {
    const count = (jq, checks) => spawnSync("jq", [jq], { input: JSON.stringify(checks), encoding: "utf8" }).stdout.trim();
    for (const [f, c] of reads) {
      const jq = jqOf(c);
      assert.ok(jq, `${f}: no --jq filter`);
      assert.equal(count(jq, [{ name: "ci", bucket: "pass" }, { name: "forgedock/verify", bucket: "fail" }]), "0", f);
      assert.equal(count(jq, [{ name: "lint", bucket: "fail" }, { name: "forgedock/verify", bucket: "pass" }]), "1", f);
      assert.equal(count(jq, [{ name: "e2e", bucket: "cancel" }]), "1", f);
    }
  });
});
