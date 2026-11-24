// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergedEvidence, repairMergedParked } from "./merged-park.mjs";

/** gh over a scripted issue: view, pr view, events, edit (records removals). */
const ghFor = ({ view = {}, prs = {}, events = "", failRemove = [] } = {}) => {
  const calls = [];
  const gh = async (a) => {
    calls.push(a.join(" "));
    if (a[0] === "issue" && a[1] === "view") return JSON.stringify(view);
    if (a[0] === "pr" && a[1] === "view") return JSON.stringify(prs[a[2]] ?? {});
    if (a[0] === "api") return events;
    if (a[0] === "issue" && a[1] === "edit") { if (failRemove.includes(a[a.indexOf("--remove-label") + 1])) throw new Error("no such label"); return ""; }
    return "";
  };
  return { gh, calls };
};
const STATE = (pr) => `x\n<!-- FORGE:STATE\n${JSON.stringify({ v: 1, issue: 7, pr })}\n-->`;
const T = (s) => new Date(s).toISOString();

describe("merged-park", () => {
  it("merged evidence from workflow:merged label, closing refs and FORGE:STATE pr", async () => {
    const lbl = ghFor({ view: { state: "OPEN", labels: [{ name: "workflow:merged" }] } });
    assert.equal((await mergedEvidence({ gh: lbl.gh, repo: "o/r", issue: 7 }))?.source, "label");
    const prs = { 41: { state: "MERGED", mergedAt: T("2026-11-17T15:43:35Z") } };
    const ref = ghFor({ view: { state: "OPEN", closedByPullRequestsReferences: [{ number: 41 }] }, prs });
    assert.equal((await mergedEvidence({ gh: ref.gh, repo: "o/r", issue: 7 }))?.pr, 41);
    const st = ghFor({ view: { state: "OPEN", body: STATE(41) }, prs });
    assert.equal((await mergedEvidence({ gh: st.gh, repo: "o/r", issue: 7 }))?.pr, 41);
    const open = ghFor({ view: { state: "OPEN", body: STATE(41) }, prs: { 41: { state: "OPEN" } } });
    assert.equal(await mergedEvidence({ gh: open.gh, repo: "o/r", issue: 7 }), null);
    assert.equal(await mergedEvidence({ gh: ghFor({ view: { state: "OPEN" } }).gh, repo: "o/r", issue: 7 }), null);
  });
  it("a reopen after the merge voids the evidence", async () => {
    const prs = { 41: { state: "MERGED", mergedAt: T("2026-11-17T15:43:35Z") } };
    const view = { state: "OPEN", closedByPullRequestsReferences: [{ number: 41 }] };
    const later = ghFor({ view, prs, events: `reopened\t${T("2026-11-18T00:00:00Z")}\t` });
    assert.equal(await mergedEvidence({ gh: later.gh, repo: "o/r", issue: 7 }), null);
    const earlier = ghFor({ view, prs, events: `reopened\t${T("2026-11-16T00:00:00Z")}\t` });
    assert.equal((await mergedEvidence({ gh: earlier.gh, repo: "o/r", issue: 7 }))?.pr, 41);
  });
  it("repair flags and clears a merged issue that keeps park labels", async () => {
    const labels = [{ name: "workflow:merged" }, { name: "remediation-queue" }, { name: "parked:env.tool_missing" }, { name: "bug" }];
    const h = ghFor();
    const out = await repairMergedParked({ gh: h.gh, repo: "o/r", issues: [{ number: 7, labels }, { number: 8, labels: [{ name: "workflow:merged" }] }] });
    assert.deepEqual(out, [{ issue: 7, flagged: ["remediation-queue", "parked:env.tool_missing"], removed: ["remediation-queue", "parked:env.tool_missing"] }]);
    assert.ok(h.calls.some((c) => c.includes("--remove-label remediation-queue")));
    assert.ok(!h.calls.some((c) => c.includes("issue edit 8")));
  });
  it("repair leaves an issue reopened after the merge parked", async () => {
    const h = ghFor({ events: `labeled\t${T("2026-11-17T00:00:00Z")}\tworkflow:merged\nreopened\t${T("2026-11-18T00:00:00Z")}\t` });
    const out = await repairMergedParked({ gh: h.gh, repo: "o/r", issues: [{ number: 7, labels: ["workflow:merged", "remediation-queue"] }] });
    assert.deepEqual(out, []);
    assert.ok(!h.calls.some((c) => c.includes("issue edit")));
  });
  it("repair lists open workflow:merged issues itself and skips pull requests", async () => {
    const calls = [];
    const gh = async (a) => { calls.push(a.join(" ")); return a[0] === "api" && a[1].includes("?state=open") ? JSON.stringify([{ number: 7, labels: [{ name: "workflow:merged" }, { name: "needs-human:external" }] }, { number: 9, pull_request: {}, labels: [{ name: "needs-human" }] }]) : ""; };
    const out = await repairMergedParked({ gh, repo: "o/r" });
    assert.deepEqual(out.map((r) => r.issue), [7]);
  });
});
