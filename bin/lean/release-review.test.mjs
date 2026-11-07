// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reviewStep, fixStep, missingReviewers, SPEC_PANEL, MAX_DELTA_PASSES, MAX_FIX_ROUNDS } from "./release-review.mjs";
import { reviewStagingJson } from "../review-staging.mjs";

const H1 = "a".repeat(40), H2 = "b".repeat(40);
const manifest = (head, delta = null) => ({ pr: 7, headSha: head, bundle: [1, 2], scopeMode: "full", contextFile: "/sd/review-ctx-7.json", launchedFile: "/sd/7_launched", briefs: [{ domain: "security", path: "/sd/brief-security.md" }], delta });
const fin = (extra = {}) => ({ code: 0, data: { head: H1, toFile: [], notes: [], ...extra }, lines: [] });

/** Seam fake: `heads` is what headOf answers in turn; `fins` what finalize answers in turn. */
function fakeSeam({ heads = [H1], fins = [fin()], summary, lanes = [] } = {}) {
  const log = [], agents = [];
  let h = 0, f = 0, l = 0, n = 100;
  return {
    log, agents,
    pre: async (a) => { log.push(["pre", a.delta]); return { code: 0, data: manifest(a.delta ? heads[heads.length - 1] : H1, a.delta ? { from: a.delta, files: ["x"] } : null), lines: [] }; },
    finalize: async () => { log.push(["finalize"]); return fins[Math.min(f++, fins.length - 1)]; },
    summary: async (a) => { log.push(["summary", a.filed]); return summary ?? { code: 0, data: { verdict: "APPROVE FOR DEPLOY", marker: "FORGE:GATE_PASS", ciFailing: 0 }, lines: [] }; },
    headOf: async () => heads[Math.min(h++, heads.length - 1)],
    readFile: (p) => `brief ${p}`,
    markLaunched: (file, domains) => log.push(["launched", domains]),
    saveTestGate: () => "/sd/7_test_gate_output.txt",
    runAgent: async (a) => { agents.push(a.role + (a.prompt.includes("findings block required") ? ":reask" : "")); return { text: "ok" }; },
    fileIssue: async ({ item }) => { log.push(["file", item.title]); return n++; },
    addNotes: async (pr, notes) => log.push(["notes", notes]),
    runLane: async (a) => { log.push(["lane", a.issue, a.lane]); return lanes[l++] ?? { terminalReason: "merged" }; },
  };
}
const ctx = (seam, steps = {}) => ({ io: { review: seam }, repo: "o/r", def: "main", staging: "staging", state: { steps: { "release-pr": { result: { pr: 7 } }, ...steps } }, save() {} });

describe("reviewStep", () => {
  it("runs the briefs and the spec panel in parallel, then test gate, finalize and summary in order", async () => {
    const s = fakeSeam();
    const r = await reviewStep(ctx(s));
    assert.equal(r.marker, "FORGE:GATE_PASS");
    assert.deepEqual(s.agents.slice().sort(), ["release-review-security", "release-test-gate", ...SPEC_PANEL.map((p) => `release-review-${p.domain}`)].sort());
    assert.deepEqual(s.log.map((e) => e[0]), ["pre", "launched", "finalize", "summary"]);
    assert.deepEqual(s.log[1][1], ["security", ...SPEC_PANEL.map((p) => p.domain)]);
  });

  it("R2: a head move triggers a --delta pass from the reviewed sha and never finalizes at the moved head", async () => {
    const s = fakeSeam({ heads: [H2, H2] });
    const r = await reviewStep(ctx(s));
    const pres = s.log.filter((e) => e[0] === "pre");
    assert.deepEqual(pres.map((e) => e[1]), [null, H1], "second pass is --delta <reviewed sha>");
    assert.equal(s.log.filter((e) => e[0] === "finalize").length, 1, "finalize ran once, after the delta pass");
    assert.ok(s.log.findIndex((e) => e[0] === "finalize") > s.log.findLastIndex((e) => e[0] === "pre"));
    assert.equal(r.verdict, "APPROVE FOR DEPLOY");
    // the delta pass credits the spec panel: only the briefs are re-run
    assert.equal(s.agents.filter((a) => a === "release-review-material-change").length, 1);
  });

  it("a finalize refusal for a moved head also becomes a delta pass", async () => {
    const s = fakeSeam({ fins: [{ code: 1, data: null, lines: ["REVIEW_RESULT: status: BLOCKED, blocker: head moved since the review (aaaaaaa -> bbbbbbb)"] }, fin()] });
    await reviewStep(ctx(s));
    assert.equal(s.log.filter((e) => e[0] === "pre").length, 2);
  });

  it("blocks when the head keeps moving", async () => {
    const s = fakeSeam();
    let i = 0;
    s.headOf = async () => String(++i).padStart(40, "c");
    const r = await reviewStep(ctx(s));
    assert.equal(r.blocked, true);
    assert.match(r.reason, new RegExp(`${MAX_DELTA_PASSES} delta passes`));
  });

  it("re-asks only the reviewer with a missing findings block, once, then finalizes", async () => {
    const s = fakeSeam({ fins: [{ code: 1, data: null, lines: ["REVIEW DELIVERY FAILURE: missing findings comment(s) for: security code-quality"] }, fin()] });
    const r = await reviewStep(ctx(s));
    assert.equal(r.blocked, undefined);
    assert.deepEqual(s.agents.filter((a) => a.endsWith(":reask")).sort(), ["release-review-code-quality:reask", "release-review-security:reask"]);
  });

  it("a second miss is a degraded panel (blocked, no further re-ask)", async () => {
    const bad = { code: 1, data: null, lines: ["REVIEW DELIVERY FAILURE: no structured findings block from: security."] };
    const s = fakeSeam({ fins: [bad] });
    const r = await reviewStep(ctx(s));
    assert.equal(r.blocked, true);
    assert.match(r.reason, /degraded panel/);
    assert.equal(s.agents.filter((a) => a.endsWith(":reask")).length, 1);
    assert.equal(s.log.filter((e) => e[0] === "summary").length, 0);
  });

  it("files each FILE item, lists NOTEs in the PR body, then summarises with --filed", async () => {
    const s = fakeSeam({ fins: [fin({ toFile: [{ title: "a", severity: "HIGH" }, { title: "b", severity: "LOW" }], notes: ["- n1"] })] });
    const r = await reviewStep(ctx(s));
    assert.deepEqual(s.log.slice(-4).map((e) => e[0]), ["file", "file", "notes", "summary"]);
    assert.deepEqual(s.log.at(-1)[1], [100, 101]);
    assert.deepEqual(r.blocking, [100], "only CRITICAL/HIGH findings block");
  });

  it("blocks when filing fails, before any summary is posted", async () => {
    const s = fakeSeam({ fins: [fin({ toFile: [{ title: "a", severity: "HIGH" }] })] });
    s.fileIssue = async () => null;
    const r = await reviewStep(ctx(s));
    assert.equal(r.blocked, true);
    assert.equal(s.log.filter((e) => e[0] === "summary").length, 0);
  });

  it("blocks without a release PR", async () => {
    assert.equal((await reviewStep({ ...ctx(fakeSeam()), state: { steps: {} } })).blocked, true);
  });
});

describe("fixStep", () => {
  const failed = { pr: 7, head: H1, verdict: "BLOCK DEPLOY", marker: "FORGE:GATE_FAILURE", blocking: [101], filed: [101], ciFailing: 0 };

  it("does nothing on GATE_PASS", async () => {
    const s = fakeSeam();
    const r = await fixStep(ctx(s, { review: { result: { ...failed, verdict: "APPROVE FOR DEPLOY", marker: "FORGE:GATE_PASS" } } }));
    assert.equal(r.blocked, undefined);
    assert.equal(s.log.length, 0);
  });

  it("runs a lane on the staging branch per blocking issue, then a delta review from the reviewed head", async () => {
    const s = fakeSeam({ heads: [H2] });
    const c = ctx(s, { review: { result: failed } });
    const r = await fixStep(c);
    assert.deepEqual(s.log[0], ["lane", 101, "staging"]);
    assert.deepEqual(s.log[1], ["pre", H1]);
    assert.equal(r.verdict, "APPROVE FOR DEPLOY");
  });

  it("is bounded: blocks once the rounds are spent", async () => {
    const bad = { code: 0, data: { verdict: "BLOCK DEPLOY", marker: "FORGE:GATE_FAILURE", ciFailing: 0 }, lines: [] };
    const s = fakeSeam({ heads: [H2], summary: bad, fins: [fin({ toFile: [{ title: "x", severity: "CRITICAL" }] })] });
    const r = await fixStep(ctx(s, { review: { result: failed } }));
    assert.equal(r.blocked, true);
    assert.equal(s.log.filter((e) => e[0] === "lane").length, MAX_FIX_ROUNDS);
  });

  it("blocks when a lane does not merge, and when only CI is red", async () => {
    const s = fakeSeam({ lanes: [{ terminalReason: "needs-human" }] });
    assert.equal((await fixStep(ctx(s, { review: { result: failed } }))).blocked, true);
    assert.match((await fixStep(ctx(fakeSeam(), { review: { result: { ...failed, blocking: [], ciFailing: 2 } } }))).reason, /no blocking finding/);
  });
});

describe("missingReviewers", () => {
  it("reads the names from the delivery and extract messages", () => {
    assert.deepEqual(missingReviewers(["x", "REVIEW DELIVERY FAILURE: missing findings comment(s) for: a b-c"]), ["a", "b-c"]);
    assert.deepEqual(missingReviewers(["REVIEW DELIVERY FAILURE: no structured findings block from: a, b. Re-dispatch them once"]), ["a", "b"]);
    assert.deepEqual(missingReviewers(["nothing"]), []);
  });
});

describe("reviewStagingJson (library entry)", () => {
  const io = (gh) => ({ root: "/r", env: {}, cwd: "/c", run: async () => ({ code: 0, stdout: "", stderr: "" }), gh, readFile: () => { throw new Error("nofile"); }, writeFile() {}, rm() {}, mkdir() {}, out: () => assert.fail("printed"), err: () => assert.fail("printed") });
  it("returns a stop as {code, lines} without printing and never throws", async () => {
    const r = await reviewStagingJson(["--summary"], io(async () => { throw new Error("no gh"); }));
    assert.equal(r.data, null);
    assert.ok(r.code >= 1);
    assert.ok(r.lines.length > 0);
  });
});
