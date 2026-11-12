// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseIssueLink, classifyOrphanPr, orphanTelemetry, openPrBlockingClose, supersedeOlderPrs, sweepOrphanPrs, formatOrphanSummary, issuePrMarker } from "./orphan-pr.mjs";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const pr = (number, issue, extra = {}) => ({ number, headRefName: `feat/issue-${issue}-lean`, body: "", createdAt: "2026-11-09T12:00:00Z", ...extra });

/** Fake repo. `issues`: n -> {state, stateReason, labels}; `cherry`: head -> git cherry output. */
function world({ open = [], merged = [], issues = {}, cherry = {}, labelled = [], all = [] }) {
  const w = { closed: [], created: [], edits: [], gitFail: false };
  w.io = {
    now: () => NOW,
    gh: async (a) => {
      const k = a.slice(0, 2).join(" ");
      if (k === "pr list") { const st = a[a.indexOf("--state") + 1]; return JSON.stringify(a.includes("--search") ? all : st === "merged" ? merged : open); }
      if (k === "issue view") return JSON.stringify({ labels: [], ...issues[Number(a[2])], labels: (issues[Number(a[2])]?.labels ?? []).map((name) => ({ name })) });
      if (k === "issue list") return JSON.stringify(a.includes("--search") ? [] : labelled);
      if (k === "issue create") { w.created.push(a); return "https://github.com/o/r/issues/900\n"; }
      if (k === "pr close") { w.closed.push({ pr: Number(a[2]), comment: a[a.indexOf("--comment") + 1] }); return ""; }
      if (k === "issue edit" || k === "issue close") { w.edits.push(a); return ""; }
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
    git: async (a) => {
      if (w.gitFail) throw new Error("git down");
      if (a[0] === "fetch") return "";
      if (a[0] === "cherry") return cherry[a[2].replace("origin/", "")] ?? "+ abc\n";
      if (a[0] === "rev-parse") return "c0ffee123456\n";
      throw new Error(`unexpected git ${a.join(" ")}`);
    },
  };
  return w;
}
const run = (w, extra = {}) => sweepOrphanPrs({ repo: "o/r", io: w.io, ...extra });

describe("orphan-PR sweep (#5505)", () => {
  it("derives the link from the branch or the marker, never closingIssuesReferences", () => {
    assert.equal(parseIssueLink(pr(1, 7)), 7);
    assert.equal(parseIssueLink({ headRefName: "x", body: `hi ${issuePrMarker(9)}` }), 9);
    assert.equal(parseIssueLink({ headRefName: "hand/fix-7", body: "Closes #7", closingIssuesReferences: [{ number: 7 }] }), null);
  });

  it("pattern 1: issue closed by another PR; the equivalent change is on base -> superseded, citing the commit", async () => {
    const w = world({ open: [pr(40338, 40048)], issues: { 40048: { state: "CLOSED", stateReason: "COMPLETED" } }, cherry: { "feat/issue-40048-lean": "- abc\n" } });
    const rows = await run(w);
    assert.equal(rows[0].kind, "superseded");
    assert.match(w.closed[0].comment, /c0ffee123456/);
  });

  it("pattern 2: two PRs for one closed issue -> the older is a duplicate; the newest is judged on its own diff", async () => {
    const w = world({ open: [pr(40138, 40137), pr(40340, 40137)], issues: { 40137: { state: "CLOSED", stateReason: "COMPLETED" } } });
    const rows = await run(w);
    assert.equal(rows.find((r) => r.pr === 40138).kind, "duplicate");
    assert.equal(rows.find((r) => r.pr === 40340).kind, "undelivered");
    assert.equal(w.closed.length, 2);
  });

  it("pattern 3: a hotfix backport issue labelled backport-pending keeps its PR open", async () => {
    const w = world({ open: [pr(39718, 39450)], issues: { 39450: { state: "CLOSED", stateReason: "COMPLETED", labels: [BACK] } } });
    const rows = await run(w);
    assert.equal(rows[0].kind, "backport-pending");
    assert.equal(w.closed.length, 0);
    assert.equal(orphanTelemetry(rows).count, 0);
  });

  it("pattern 3b: the backport merged -> label cleared and the issue closed", async () => {
    const w = world({ labelled: [{ number: 39450, state: "OPEN" }], all: [{ number: 5, state: "MERGED", headRefName: "hotfix/google-mobile-pool-39450" }] });
    const rows = await run(w);
    assert.ok(w.edits.some((a) => a.includes("--remove-label")) && w.edits.some((a) => a[1] === "close"));
    assert.equal(orphanTelemetry(rows).count, 0);
  });

  it("pattern 4: lane PR left behind after decompose, never delivered -> follow-up filed first, then PR closed", async () => {
    const w = world({ open: [pr(38601, 38564)], issues: { 38564: { state: "CLOSED", stateReason: "COMPLETED" } } });
    const rows = await run(w);
    assert.equal(rows[0].kind, "undelivered");
    assert.equal(w.created.length, 1);
    assert.match(w.created[0].join(" "), /feat\/issue-38564-lean/);
    assert.match(w.closed[0].comment, /#900/);
  });

  it("pattern 4b: a failed follow-up filing never closes the PR (no lost work)", async () => {
    const w = world({ open: [pr(38601, 38564)], issues: { 38564: { state: "CLOSED", stateReason: "COMPLETED" } } });
    const gh = w.io.gh; w.io.gh = async (a) => { if (a[0] === "issue" && a[1] === "create") throw new Error("boom"); return gh(a); };
    const rows = await run(w);
    assert.equal(rows[0].kind, "error");
    assert.equal(w.closed.length, 0);
  });

  it("pattern 5: issue closed as not planned -> PR closed", async () => {
    const w = world({ open: [pr(36719, 36662)], issues: { 36662: { state: "CLOSED", stateReason: "NOT_PLANNED" } } });
    assert.equal((await run(w))[0].kind, "not_planned");
    assert.equal(w.closed.length, 1);
  });

  it("a merged sibling PR makes the open one a duplicate", () => {
    assert.equal(classifyOrphanPr({ number: 3 }, { issue: {}, merged: 9, base: "staging" }).kind, "duplicate");
  });

  it("an open issue, a non-lane PR and a git failure are never closed", async () => {
    const w = world({ open: [pr(1, 5), { number: 2, headRefName: "hand/x", body: "" }, pr(3, 6)], issues: { 5: { state: "OPEN" }, 6: { state: "CLOSED", stateReason: "COMPLETED" } }, cherry: { "feat/issue-6-lean": "" } });
    w.gitFail = true;
    const rows = await run(w);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "undelivered"); // git unknown is not superseded
  });

  it("--dry-run writes nothing", async () => {
    const w = world({ open: [pr(36719, 36662)], issues: { 36662: { state: "CLOSED", stateReason: "NOT_PLANNED" } } });
    const rows = await run(w, { dryRun: true });
    assert.equal(rows[0].kind, "not_planned");
    assert.equal(w.closed.length + w.created.length + w.edits.length, 0);
  });

  it("telemetry counts orphans and alerts only past 24h", () => {
    assert.deepEqual(orphanTelemetry([{ kind: "superseded", ageMs: 3600000 }]), { count: 1, oldestAgeMs: 3600000, alert: false });
    assert.equal(orphanTelemetry([{ kind: "undelivered", ageMs: 90000000 }]).alert, true);
    assert.match(formatOrphanSummary([{ kind: "undelivered", pr: 4, ageMs: 90000000, closed: true }]), /ALERT oldest 25h/);
    assert.equal(formatOrphanSummary([]), "");
  });

  it("a backport-merged cleanup row is not an orphan (#5517)", () => {
    const rows = [{ issue: 7, kind: "backport-merged", detail: "label cleared" }];
    assert.deepEqual(orphanTelemetry(rows), { count: 0, oldestAgeMs: 0, alert: false });
    assert.equal(formatOrphanSummary(rows), "");
  });
});

describe("one live PR per issue and the close gate (#5505)", () => {
  it("supersedes the older open PR of the same issue, not other issues' PRs", async () => {
    const w = world({ open: [pr(10, 7), pr(11, 7), pr(12, 8)] });
    assert.deepEqual(await supersedeOlderPrs({ repo: "o/r", io: w.io, issue: 7, newPr: 11 }), [10]);
    assert.deepEqual(w.closed.map((c) => c.pr), [10]);
    assert.match(w.closed[0].comment, /Superseded by #11/);
  });

  it("blocks a completed close while another own PR is open; not planned and duplicate close freely", async () => {
    const w = world({ open: [pr(10, 7), pr(11, 7)] });
    assert.deepEqual(await openPrBlockingClose({ repo: "o/r", io: w.io, issue: 7, reason: "completed", exceptPr: 11 }), [10]);
    assert.deepEqual(await openPrBlockingClose({ repo: "o/r", io: w.io, issue: 7, reason: "not planned" }), []);
    assert.deepEqual(await openPrBlockingClose({ repo: "o/r", io: w.io, issue: 7, reason: "duplicate" }), []);
  });
});
const BACK = "backport-pending";
