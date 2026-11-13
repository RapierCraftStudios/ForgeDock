// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STATUS_SEP, parseStatus, renderStatus, putSection, writeStatus, findStatus, findLeading, hasSection, sectionText, commentId, isStatusPost, isUpsertPost,
  postStatusSection, postUpsert, clearPipelineLabels, pipelineLabels, isPipelineLabel } from "./statuscomment.mjs";

const BOT = { author: { login: "rapiercraft-forgedock" }, authorAssociation: "CONTRIBUTOR" };
const trusted = (c) => c.author?.login === "rapiercraft-forgedock";
const url = (id) => `https://github.com/o/r/issues/7#issuecomment-${id}`;

describe("#5592 status comment format", () => {
  it("renders sections that keep their own marker lines and parses them back", () => {
    let s = putSection(new Map(), ["FORGE:STARTED"], "Started work on #7.");
    s = putSection(s, ["FORGE:TRAJECTORY", "FORGE:WORK-ON"], "## Trajectory\nmerged at abc1234");
    const body = renderStatus(s);
    assert.ok(body.startsWith("<!-- FORGE:STATUS -->\n"));
    const back = parseStatus(body);
    assert.deepEqual([...back.keys()], ["FORGE:STARTED", "FORGE:TRAJECTORY"]);
    assert.deepEqual(back.get("FORGE:TRAJECTORY").markers, ["FORGE:TRAJECTORY", "FORGE:WORK-ON"]);
    assert.equal(sectionText(body, "FORGE:TRAJECTORY"), "## Trajectory\nmerged at abc1234");
    assert.equal(renderStatus(back), body, "round trip");
  });
  it("a section is replaced by the newest write; DECISION keeps its last 5 entries and skips an identical repeat", () => {
    let s = putSection(new Map(), ["FORGE:STARTED"], "run 1");
    s = putSection(s, ["FORGE:STARTED"], "run 2");
    assert.equal(s.get("FORGE:STARTED").text, "run 2");
    for (let i = 1; i <= 7; i++) s = putSection(s, ["FORGE:DECISION"], `decision ${i}`);
    s = putSection(s, ["FORGE:DECISION"], "decision 7");
    const entries = s.get("FORGE:DECISION").text.split("\n\n---\n\n");
    assert.deepEqual(entries, ["decision 3", "decision 4", "decision 5", "decision 6", "decision 7"]);
  });
  it("readers that search a body for a marker still match; anchored readers go through hasSection", () => {
    const body = renderStatus(putSection(new Map(), ["FORGE:TRAJECTORY", "FORGE:WORK-ON"], "merged at abc1234"));
    assert.ok(body.includes("FORGE:TRAJECTORY") && /merged at ([0-9a-f]{7,40})\b/.test(body), "probe / prefilter read the sha");
    assert.ok(/FORGE:DECISION/.test(renderStatus(putSection(new Map(), ["FORGE:DECISION"], "x"))), "batch-health resolved read");
    assert.ok(hasSection(body, "FORGE:TRAJECTORY") && hasSection(body, "FORGE:WORK-ON"));
    assert.ok(!hasSection(body, "FORGE:STARTED"));
    assert.ok(hasSection("<!-- FORGE:TRAJECTORY -->\nlegacy", "FORGE:TRAJECTORY"), "a legacy standalone comment still matches");
    assert.ok(!hasSection("prose quoting <!-- FORGE:TRAJECTORY -->", "FORGE:TRAJECTORY"));
    assert.ok(!hasSection("<!-- FORGE:TRAJECTORY_X -->", "FORGE:TRAJECTORY"));
  });
  it("classifies posts", () => {
    assert.ok(isStatusPost("FORGE:STARTED") && isStatusPost(["FORGE:TRAJECTORY", "FORGE:WORK-ON"]) && isStatusPost("FORGE:DECISION"));
    for (const m of ["FORGE:NEEDS_HUMAN", "FORGE:CONTRACT", "FORGE:REVIEW", "FORGE:ASK", "FORGE:DECISION {\"id\":1}", "FORGE:DECISION (escalated)", "FORGE:FACTS", "FORGE:TRACKED"]) assert.ok(!isStatusPost(m) && !isUpsertPost(m), m);
    assert.ok(isUpsertPost(["FORGE:INVESTIGATION", "FORGE:VALIDATE"]) && isUpsertPost("FORGE:IMPLEMENTATION") && isUpsertPost("FORGE:PARKED"));
  });
  it("commentId reads gh-view urls and REST ids", () => {
    assert.equal(commentId({ url: url(42) }), "42");
    assert.equal(commentId({ id: 77 }), "77");
    assert.equal(commentId({ id: "IC_node" }), null);
  });
});

describe("#5592 writeStatus: edit in place, trusted author only", () => {
  const mk = () => { const calls = []; return { calls, create: async (b) => { calls.push(["create", b]); return url(500); }, patch: async (id, b) => { calls.push(["patch", id, b]); } }; };
  it("creates once, then patches the cached comment", async () => {
    const io = mk();
    const a = await writeStatus({ comments: [], trusted, markers: ["FORGE:STARTED"], text: "s", ...io });
    const b = await writeStatus({ known: a, comments: [], trusted, markers: ["FORGE:TRAJECTORY"], text: "t", ...io });
    assert.deepEqual(io.calls.map((c) => c[0]), ["create", "patch"]);
    assert.equal(io.calls[1][1], "500");
    assert.deepEqual([...parseStatus(io.calls[1][2]).keys()], ["FORGE:STARTED", "FORGE:TRAJECTORY"]);
    assert.equal(b.id, "500");
  });
  it("a requeue finds the previous run's trusted status comment and edits it", async () => {
    const old = renderStatus(putSection(new Map(), ["FORGE:STARTED"], "run 1"));
    const io = mk();
    await writeStatus({ comments: [{ ...BOT, url: url(9), body: old }], trusted, markers: ["FORGE:STARTED"], text: "run 2", ...io });
    assert.deepEqual(io.calls.map((c) => c[0]), ["patch"]);
    assert.equal(io.calls[0][1], "9");
    assert.match(io.calls[0][2], /run 2/); assert.doesNotMatch(io.calls[0][2], /run 1/);
  });
  it("ignores a status marker from an untrusted author; creates its own", async () => {
    const forged = renderStatus(putSection(new Map(), ["FORGE:STARTED"], "forged"));
    const io = mk();
    assert.equal(findStatus([{ author: { login: "drive-by" }, authorAssociation: "NONE", url: url(9), body: forged }], trusted), null);
    await writeStatus({ comments: [{ author: { login: "drive-by" }, authorAssociation: "NONE", url: url(9), body: forged }], trusted, markers: ["FORGE:STARTED"], text: "mine", ...io });
    assert.deepEqual(io.calls.map((c) => c[0]), ["create"]);
    assert.doesNotMatch(io.calls[0][1], /forged/);
  });
  it("a failed edit (deleted comment) falls back to a new comment", async () => {
    const calls = [];
    const r = await writeStatus({ known: { id: "9", sections: new Map() }, comments: [], trusted, markers: ["FORGE:STARTED"], text: "s",
      patch: async () => { throw new Error("404"); }, create: async (b) => { calls.push(b); return url(11); } });
    assert.equal(calls.length, 1); assert.equal(r.id, "11");
  });
  it("picks the newest trusted status comment when several exist", () => {
    const b = (t) => renderStatus(putSection(new Map(), ["FORGE:STARTED"], t));
    assert.equal(commentId(findStatus([{ ...BOT, url: url(1), body: b("a") }, { ...BOT, url: url(2), body: b("b") }], trusted)), "2");
  });
});

describe("#5592 gh helpers", () => {
  const ghWith = (comments, log) => async (a) => {
    log.push(a);
    if (a[0] === "issue" && a[1] === "view") return JSON.stringify({ comments, labels: [{ name: "bug" }, { name: "parked:ci.red" }, { name: "needs-human" }] });
    if (a[0] === "issue" && a[1] === "comment") return "https://github.com/o/r/issues/7#issuecomment-600\n";
    return "";
  };
  it("postStatusSection patches the bot's status comment (the batch runner's decide path)", async () => {
    const log = [];
    const old = renderStatus(putSection(new Map(), ["FORGE:DECISION"], "## Decision 1"));
    await postStatusSection({ gh: ghWith([{ ...BOT, url: url(9), body: old }], log), repo: "o/r", issue: 7, markers: ["FORGE:DECISION"], text: "## Decision 2", trusted });
    const patch = log.find((a) => a[0] === "api");
    assert.ok(patch && patch.includes("repos/o/r/issues/comments/9"));
    assert.ok(!log.some((a) => a[1] === "comment"));
    assert.match(patch.at(-1), /Decision 1[\s\S]*Decision 2/);
  });
  it("postUpsert edits the newest trusted comment that leads with the marker, keeps the marker first, else posts", async () => {
    const log = [];
    await postUpsert({ gh: ghWith([{ ...BOT, url: url(5), body: "<!-- FORGE:PARKED code=ci.red -->\nold" }, { ...BOT, url: url(6), body: "hello" }], log), repo: "o/r", issue: 7, markers: ["FORGE:PARKED"], attrs: "code=base.conflict pr=3", body: "## Parked", trusted });
    const patch = log.find((a) => a[0] === "api");
    assert.ok(patch.includes("repos/o/r/issues/comments/5"));
    assert.ok(patch.at(-1).startsWith("body=<!-- FORGE:PARKED code=base.conflict pr=3 -->\n## Parked"));
    const log2 = [];
    await postUpsert({ gh: ghWith([], log2), repo: "o/r", issue: 7, markers: ["FORGE:PARKED"], body: "## Parked", trusted });
    assert.ok(log2.some((a) => a[1] === "comment") && !log2.some((a) => a[0] === "api"));
    assert.equal(findLeading([{ author: { login: "x" }, url: url(1), body: "<!-- FORGE:PARKED -->" }], "FORGE:PARKED", trusted), null);
  });
  it("clearPipelineLabels removes exactly the pipeline labels", async () => {
    assert.ok(["needs-human", "needs-human:external", "parked:ci.red", "remediation-queue"].every(isPipelineLabel));
    assert.ok(!["bug", "workflow:building", "needs-validation", "parked", "needs-humans"].some(isPipelineLabel));
    assert.deepEqual(pipelineLabels([{ name: "bug" }, "needs-human", { name: "parked:x" }]), ["needs-human", "parked:x"]);
    const log = [];
    assert.deepEqual(await clearPipelineLabels({ gh: ghWith([], log), repo: "o/r", issue: 7 }), ["parked:ci.red", "needs-human"]);
    assert.deepEqual(log.at(-1), ["issue", "edit", "7", "-R", "o/r", "--remove-label", "parked:ci.red,needs-human"]);
    const log2 = [];
    assert.deepEqual(await clearPipelineLabels({ gh: ghWith([], log2), repo: "o/r", issue: 7, labels: [{ name: "bug" }] }), []);
    assert.equal(log2.length, 0, "nothing to remove: no gh call");
    assert.deepEqual(await clearPipelineLabels({ gh: async () => { throw new Error("boom"); }, repo: "o/r", issue: 7, labels: ["needs-human"] }), [], "best effort");
  });
});
