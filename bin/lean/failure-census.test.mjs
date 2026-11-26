// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parkBucket, parkRows, normalizeRow, lastAmendments, amendmentWhyClass, baseSyncConflicts, censusIssues, censusBatchRows, renderCensus } from "./failure-census.mjs";

const nh = (rows, prose = "") => `<!-- FORGE:NEEDS_HUMAN -->\n## Needs human\n${prose}\n${rows.map((r) => `- ${r}`).join("\n")}`;

describe("failure census", () => {
  it("buckets parks by the first matching class", () => {
    assert.equal(parkBucket("Remote sandbox lacks yaml, and no lane_tools recipe exists for it."), "sandbox_tool_gap");
    assert.equal(parkBucket(nh(["recurrence.design_missing: recurring issue routed to a design lane: no design block"])), "recurrence_design");
    assert.equal(parkBucket(nh(["conformance.unimplemented: R13 post-deploy check id is neither on the default branch nor added by this PR (.forge/post-deploy-checks.json)"])), "post_deploy_check_id");
    assert.equal(parkBucket(nh(["conformance.unimplemented: unknown or incomplete amendment: amendment kind 'supersedes' needs guard"])), "amendment_syntax");
    assert.equal(parkBucket(nh(['conformance.unimplemented: R4 reported "no status" ("x")'])), "no_status");
    assert.equal(parkBucket("Required check(s) failed on PR #6011 (Spec-size budget) and the builder made no new commit for it"), "ci_red");
    assert.equal(parkBucket("something new"), "other");
  });
  it("normalises rows so the same defect on different issues groups together", () => {
    const a = normalizeRow('- conformance.unimplemented: R13 post-deploy check id is neither on the default branch nor added by this PR (.forge/post-deploy-checks.json) ("quote one")');
    const b = normalizeRow('- conformance.unimplemented: R7 post-deploy check id is neither on the default branch nor added by this PR (.forge/post-deploy-checks.json) ("another")');
    assert.equal(a, b);
    assert.deepEqual(parkRows(nh(["a.b: one", "c.d: two"], "prose line")).length, 2);
  });
  it("uses only the last amendment state and classifies why", () => {
    const st = (am) => ({ body: `<!-- FORGE:AMENDMENT-STATE ${JSON.stringify({ contract: "x", amendments: am })} -->` });
    const am = lastAmendments([st([{ kind: "decision", why: "rename" }]), { body: "noise" }, st([{ kind: "substitute-validate", why: "fails on the unchanged base too" }, { kind: "add-deliverable", path: "devdocs/x.md", why: "docs freshness rule" }])]);
    assert.deepEqual(am.map((a) => a.kind), ["substitute-validate", "add-deliverable"]);
    assert.equal(amendmentWhyClass(am[0]), "frozen_command_broken_or_env");
    assert.equal(amendmentWhyClass(am[1]), "forced_by_another_gate");
    assert.deepEqual(lastAmendments([{ body: "<!-- FORGE:AMENDMENT-STATE {broken -->" }]), []);
  });
  it("reads base-sync conflict files", () => {
    assert.deepEqual(baseSyncConflicts("## Base Sync\n**Result:** conflicts in `devdocs/modules/lean.md`, `.forge/post-deploy-checks.json`\n"), ["devdocs/modules/lean.md", ".forge/post-deploy-checks.json"]);
    assert.deepEqual(baseSyncConflicts("**Result:** clean merge"), []);
  });
  it("counts parks, identical back-to-back repeats, amendments and hotspots per issue", () => {
    const row = "conformance.unimplemented: unknown or incomplete amendment: amendment kind 'supersedes' needs guard";
    const c = censusIssues([
      { number: 1, title: "one", comments: [{ body: nh([row]), createdAt: "2026-11-24T01:00:00Z" }, { body: nh([row]), createdAt: "2026-11-24T02:00:00Z" }, { body: "<!-- FORGE:BASE_SYNC -->\n## Base Sync\n**Result:** conflicts in `a.md`" }] },
      { number: 2, title: "two", comments: [{ body: nh([], "Remote sandbox lacks bash, and no lane_tools recipe exists for it."), createdAt: "2026-11-25T01:00:00Z" }] },
      { number: 3, title: "clean", comments: [{ body: "hello" }] },
    ]);
    assert.equal(c.issues, 3); assert.equal(c.withParks, 2); assert.equal(c.parks, 3); assert.equal(c.repeats, 1);
    assert.equal(c.buckets.amendment_syntax, 2); assert.equal(c.bucketIssues.amendment_syntax, 1);
    assert.equal(c.byDay["2026-11-25"].sandbox_tool_gap, 1);
    assert.equal(c.conflicts["a.md"], 1); assert.equal(c.mostParked[0].number, 1);
    assert.match(renderCensus({ repo: "o/r", issues: c }), /\| amendment_syntax \| 2 \| 1 \|/);
  });
  it("summarises batch rows: outcomes, deferral codes and merged-lane phase timing", () => {
    const b = censusBatchRows([
      { outcome: "merged", phases: { implement: { ms: 300000 }, ci_wait: { ms: 600000 } } },
      { outcome: "merged", phases: { implement: { ms: 420000 } } },
      { outcome: "deferred", code: "sandbox.capacity" }, { outcome: "needs-human", code: "ci.red" }, { issue: 1 },
    ]);
    assert.equal(b.outcomes.merged, 2); assert.equal(b.deferred["sandbox.capacity"], 1); assert.equal(b.needsHuman["ci.red"], 1);
    assert.equal(b.phases.implement.n, 2); assert.equal(b.phases.ci_wait.median_min, 10);
  });
});
