// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { tmpDir } from "../tests/_tmp.mjs";
import { classifyDelta, deltaDiff, citedIds, deltaSkeleton, mergeDeltaRows, renderCheckpoint, parseReviewCheckpoint, CHECKPOINT_ROWS_MAX } from "./review-delta.mjs";
import { renderReview, renderShadowReview } from "./render.mjs";
import { reviewerDeltaPrompt } from "./prompts.mjs";
import { decide, reviewSkeleton } from "./conformance.mjs";

const run = promisify(execFile);
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

/** A repo with `main` (base) and a `feat` branch that changes src/a.js; returns {dir, g (sync), git (the engine's async seam), commit}. */
function repo() {
  const dir = tmpDir("review-delta-");
  const g = (...a) => execFileSync("git", a, { cwd: dir, env: ENV, encoding: "utf8" }).trim();
  const git = async (a) => (await run("git", a, { cwd: dir, env: ENV })).stdout;
  const write = (f, t) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); };
  const commit = (files, msg) => { for (const [f, t] of Object.entries(files)) write(f, t); g("add", "-A"); g("commit", "-qm", msg); return g("rev-parse", "HEAD"); };
  g("init", "-q", "-b", "main");
  commit({ "src/a.js": "a1\na2\na3\n", "src/b.js": "b1\n", "README.md": "r\n" }, "init");
  g("checkout", "-q", "-b", "feat");
  const reviewed = commit({ "src/a.js": "a1\nFIX\na3\n" }, "fix");
  return { dir, g, git, commit, reviewed };
}

describe("classifyDelta (#4365)", () => {
  it("same head, no checkpoint and a reviewed head outside the branch", async () => {
    const r = repo();
    assert.equal((await classifyDelta(r.git, { reviewed: r.reviewed, head: r.reviewed, base: "main" })).kind, "same");
    assert.equal((await classifyDelta(r.git, { reviewed: null, head: r.reviewed, base: "main" })).kind, "full");
    r.g("checkout", "-q", "main");
    const other = r.commit({ "src/b.js": "b2\n" }, "base moves");
    r.g("checkout", "-q", "feat");
    assert.equal((await classifyDelta(r.git, { reviewed: other, head: r.reviewed, base: "main" })).kind, "full", "not an ancestor: full review");
  });
  it("a clean merge of the base is a pure base merge; a CI-fix commit after it is a delta", async () => {
    const r = repo();
    r.g("checkout", "-q", "main"); r.commit({ "src/b.js": "b2\n" }, "base moves"); r.g("checkout", "-q", "feat");
    r.g("merge", "-q", "--no-edit", "main");
    const merged = r.g("rev-parse", "HEAD");
    assert.equal((await classifyDelta(r.git, { reviewed: r.reviewed, head: merged, base: "main" })).kind, "base-merge");
    const fixed = r.commit({ "src/a.js": "a1\nFIX2\na3\n" }, "ci fix");
    assert.equal((await classifyDelta(r.git, { reviewed: r.reviewed, head: fixed, base: "main" })).kind, "delta");
  });
  it("a merge that resolved a conflict, or an edited merge, is a delta", async () => {
    const r = repo();
    r.g("checkout", "-q", "main"); r.commit({ "src/a.js": "a1\nBASE\na3\n" }, "base edits the same line"); r.g("checkout", "-q", "feat");
    try { r.g("merge", "-q", "--no-edit", "main"); } catch { /* conflict */ }
    writeFileSync(join(r.dir, "src/a.js"), "a1\nFIX+BASE\na3\n");
    r.g("add", "-A"); r.g("commit", "-qm", "resolve");
    const head = r.g("rev-parse", "HEAD");
    assert.equal((await classifyDelta(r.git, { reviewed: r.reviewed, head, base: "main" })).kind, "delta");
    const r2 = repo();
    r2.g("checkout", "-q", "main"); r2.commit({ "src/b.js": "b2\n" }, "base moves"); r2.g("checkout", "-q", "feat");
    r2.g("merge", "-q", "--no-commit", "--no-ff", "main");
    writeFileSync(join(r2.dir, "src/a.js"), "sneaky\n"); r2.g("add", "-A"); r2.g("commit", "-qm", "evil merge");
    assert.equal((await classifyDelta(r2.git, { reviewed: r2.reviewed, head: r2.g("rev-parse", "HEAD"), base: "main" })).kind, "delta");
  });
});

describe("deltaDiff (#4365)", () => {
  it("only the PR's files since the reviewed head: base-only changes merged in stay out", async () => {
    const r = repo();
    r.g("checkout", "-q", "main"); r.commit({ "README.md": "base readme\n" }, "base moves"); r.g("checkout", "-q", "feat");
    r.g("merge", "-q", "--no-edit", "main");
    r.commit({ "src/a.js": "a1\nFIX2\na3\n" }, "ci fix");
    const d = await deltaDiff(r.git, { reviewed: r.reviewed, base: "main", files: ["src/a.js"] });
    assert.deepEqual(d.files, ["src/a.js"]);
    assert.match(d.diff, /\+FIX2/);
    assert.doesNotMatch(d.diff, /README|base readme/);
  });
});

const CONTRACT = {
  requirements: [{ id: "R1", quote: "foo must handle a null argument without throwing.", disposition: "deliver" }, { id: "R2", quote: "bar logs the error once.", disposition: "deliver" }],
  deliverables: [{ id: "D1", path: "src/a.js", change: "guard", requirements: ["R1", "R2"] }],
  preserve: [{ id: "P1", what: "callers keep working" }],
  validate: [{ id: "V1", command: "node --test" }],
};
const ISSUE = "foo must handle a null argument without throwing.\nbar logs the error once.";
const FIRST = {
  issue_coverage: CONTRACT.requirements.map((r) => ({ quote: r.quote, contract_ids: [r.id], status: "covered" })),
  requirements: [{ id: "R1", status: "implemented", evidence: "src/a.js:2", validated_by: "V1" }, { id: "R2", status: "partial", evidence: "src/a.js:3", validated_by: "V1", note: "logs twice" }],
  scope: [{ file: "src/a.js", authorized_by: "D1" }], preserve: [{ id: "P1", status: "intact", evidence: "src/a.js:1" }],
  regressions: [{ at: "src/a.js:3", failure: "throws on empty" }], verdict: "NONCONFORMING", summary: "R2 partial",
};
const ctx = { contract: CONTRACT, changedFiles: ["src/a.js"], issueText: ISSUE, pathExists: () => true, repoFiles: new Set(["src/a.js"]), ignore: [] };

describe("delta rows (#4365)", () => {
  it("cited ids come from the first verdict's failures; the skeleton holds only those rows and the fix-diff files", () => {
    const d = decide(FIRST, ctx);
    assert.equal(d.state, "nonconforming");
    const cited = citedIds(d.failures, CONTRACT);
    assert.deepEqual([...cited], ["R2"]);
    const sk = deltaSkeleton(reviewSkeleton(CONTRACT, ["src/a.js"]), { cited, files: ["src/a.js"] });
    assert.deepEqual(sk.requirements.map((r) => r.id), ["R2"]);
    assert.deepEqual(sk.preserve, []);
    assert.equal(sk.issue_coverage, undefined);
    assert.deepEqual(sk.scope.map((s) => s.file), ["src/a.js"]);
  });
  it("a delta reply fixing the cited row and listing no regression conforms under the unchanged decide()", () => {
    const merged = mergeDeltaRows(FIRST, { requirements: [{ id: "R2", status: "implemented", evidence: "src/a.js:3", validated_by: "V1" }], regressions: [], verdict: "CONFORMS", summary: "fixed" });
    assert.equal(merged.requirements.find((r) => r.id === "R1").status, "implemented", "uncited rows keep the first review's values");
    assert.deepEqual(merged.regressions, [], "regressions are replaced, not appended");
    assert.equal(decide(merged, ctx).state, "conforms");
  });
  it("a regression added by the fix diff still blocks; a reply without regressions or verdict is incomplete; no reply is null", () => {
    const reg = mergeDeltaRows(FIRST, { requirements: [{ id: "R2", status: "implemented", evidence: "src/a.js:3", validated_by: "V1" }], regressions: [{ at: "src/a.js:9", failure: "new crash" }], verdict: "NONCONFORMING" });
    const d = decide(reg, ctx);
    assert.equal(d.state, "nonconforming");
    assert.deepEqual(d.failures.map((f) => f.code), ["conformance.regression"]);
    assert.equal(decide(mergeDeltaRows(FIRST, {}), ctx).state, "review.incomplete");
    assert.equal(mergeDeltaRows(FIRST, null), null);
  });
  it("the delta prompt carries the first verdict, the cited failures and only the fix diff", () => {
    const p = reviewerDeltaPrompt({ issue: { number: 7, title: "t" }, contract: CONTRACT, prior: FIRST, failures: [{ code: "conformance.unimplemented", detail: "R2 partial: logs twice" }],
      reviewed: "a".repeat(40), head: "b".repeat(40), files: ["src/a.js"], diff: "diff --git a/src/a.js b/src/a.js\n+FIX2", skeleton: { requirements: [{ id: "R2" }] } });
    assert.match(p, /DELTA RE-REVIEW/);
    assert.match(p, /R2 partial: logs twice/);
    assert.match(p, /<first_verdict>[\s\S]*logs twice[\s\S]*<\/first_verdict>/);
    assert.match(p, /\+FIX2/);
    assert.match(p, new RegExp(`git diff ${"a".repeat(40)}\\.\\.HEAD`));
  });
});

describe("FORGE:REVIEW checkpoint (#4365)", () => {
  const head = "c".repeat(40);
  it("renderReview and renderShadowReview record the reviewed head and rows; parse round-trips them", () => {
    const rv = { ...FIRST, requirements: FIRST.requirements.map((r) => ({ ...r, status: "implemented" })), regressions: [], verdict: "CONFORMS" };
    const body = renderReview(rv, CONTRACT, { head, verdict: "conforms", rows: rv });
    assert.match(body, /^## Conformance Review\n/, "heading unchanged");
    assert.deepEqual(parseReviewCheckpoint(body), { head, verdict: "conforms", rows: rv });
    const sh = renderShadowReview({ would: "conforms", review: rv, contract: CONTRACT, checkpoint: { head, verdict: "conforms", rows: rv } });
    assert.equal(parseReviewCheckpoint(sh).head, head);
    assert.equal(parseReviewCheckpoint(renderReview(rv, CONTRACT)), null, "no checkpoint without a head");
  });
  it("rows over the cap are left off (the next session reviews in full); short or missing heads do not parse", () => {
    const big = { summary: "x".repeat(CHECKPOINT_ROWS_MAX + 1) };
    const cp = parseReviewCheckpoint(renderCheckpoint({ head, rows: big }));
    assert.equal(cp.head, head); assert.equal(cp.rows, null);
    assert.equal(parseReviewCheckpoint("**Reviewed head:** `abc1234`"), null);
    assert.equal(renderCheckpoint({}), "");
  });
});
