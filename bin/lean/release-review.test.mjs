// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reviewStep, fixStep, missingReviewers, SPEC_PANEL, MAX_DELTA_PASSES, MAX_FIX_ROUNDS, realSeam, withIntegrityMarker } from "./release-review.mjs";
import { readFileSync } from "node:fs";
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
    fileCiIssue: async () => { log.push(["ci-issue"]); return n++; },
    issueMerged: async () => false,
    addNotes: async (pr, notes) => log.push(["notes", notes]),
    runLane: async (a) => { log.push(["lane", a.issue, a.lane]); return lanes[l++] ?? { terminalReason: "merged" }; },
  };
}
const ctx = (seam, steps = {}) => ({ io: { review: seam }, repo: "o/r", def: "main", staging: "staging", state: { steps: { "release-pr": { result: { pr: 7 } }, ...steps } }, save() {} });

describe("reviewStep", () => {
  it("reviewer sessions run the release job's own forgedock build", async () => {
    let seen = null;
    const real = realSeam({ repo: "o/r", def: "main", env: { PATH: "/usr/bin" }, cwd: "/tmp", makeRunner: () => async (a) => { seen = a; return { text: "" }; } });
    await real.runAgent({ role: "release-review-security", issue: 7, prompt: "p" });
    const [dir, ...rest] = seen.env.PATH.split(":");
    assert.equal(rest.join(":"), "/usr/bin");
    const shim = readFileSync(`${dir}/forgedock`, "utf8");
    assert.ok(shim.includes(process.execPath) && shim.includes("bin/forgedock.mjs"), shim);
  });

  it("a failed reviewer session is reported with its exit and tail", async () => {
    const s = fakeSeam({ fins: [{ code: 1, data: null, lines: ["finalize failed"] }] });
    s.runAgent = async (a) => { if (a.role === "release-review-security") throw Object.assign(new Error("forgedock: unknown option --post-reviewer"), { code: 2 }); return { text: "ok" }; };
    const r = await reviewStep(ctx(s));
    assert.match(r.reason, /session failures: security \(exit 2: forgedock: unknown option --post-reviewer\)/);
  });

  it("realSeam exposes every effect the steps use, matching the fake seam", () => {
    const real = Object.keys(realSeam({ repo: "o/r", def: "main", env: {}, cwd: "/tmp" })).sort();
    assert.deepEqual(real, Object.keys(fakeSeam()).filter((k) => k !== "log" && k !== "agents").sort());
  });

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

  it("blocks when a lane does not merge", async () => {
    const s = fakeSeam({ lanes: [{ terminalReason: "needs-human" }] });
    assert.equal((await fixStep(ctx(s, { review: { result: failed } }))).blocked, true);
  });

  it("red CI with no finding files one CI issue and runs a lane on it, then reviews the delta", async () => {
    const s = fakeSeam({ heads: [H2] });
    const r = await fixStep(ctx(s, { review: { result: { ...failed, blocking: [], ciFailing: 2 } } }));
    assert.deepEqual(s.log.slice(0, 3), [["ci-issue"], ["lane", 100, "staging"], ["pre", H1]]);
    assert.equal(r.blocked, undefined);
  });

  it("a resume skips fix issues already closed as merged and goes on to the delta review", async () => {
    const s = fakeSeam({ heads: [H2] });
    s.issueMerged = async (n) => n === 101;
    const r = await fixStep(ctx(s, { review: { result: failed } }));
    assert.equal(s.log.filter((e) => e[0] === "lane").length, 0);
    assert.deepEqual(s.log[0], ["pre", H1]);
    assert.equal(r.blocked, undefined);
  });

  it("realSeam.fileCiIssue reuses the issue already filed for the same release head", async () => {
    const calls = [];
    const gh = (args) => { calls.push(args); if (args[0] === "issue" && args[1] === "list") return JSON.stringify([{ number: 5396, title: "Release PR #7: CI red at b48bae6" }]); throw new Error("unexpected"); };
    const seam = realSeam({ repo: "o/r", def: "main", env: {}, cwd: "/tmp", gh });
    assert.equal(await seam.fileCiIssue({ pr: 7, head: "b48bae6628432906aa96f509eddfe6d49608e725" }), 5396);
    assert.equal(calls.length, 1);
  });

  it("a blocking finding and red CI together get a lane each", async () => {
    const s = fakeSeam({ heads: [H2] });
    await fixStep(ctx(s, { review: { result: { ...failed, ciFailing: 1 } } }));
    assert.deepEqual(s.log.filter((e) => e[0] === "lane").map((e) => e[1]), [101, 100]);
  });

  it("only cancelled CI: no CI issue, no lane, no round spent; re-summarises and goes on", async () => {
    const pass = { code: 0, data: { verdict: "APPROVE FOR DEPLOY", marker: "FORGE:GATE_PASS", ciFailing: 0 }, lines: [] };
    const s = fakeSeam({ summary: pass });
    const r = await fixStep(ctx(s, { review: { result: { ...failed, blocking: [], filed: [], ciFailing: 2, ciCancelOnly: true } } }));
    assert.deepEqual(s.log, [["summary", []]]);
    assert.equal(r.blocked, undefined);
    assert.equal(r.verdict, "APPROVE FOR DEPLOY");
    const still = { code: 0, data: { verdict: "BLOCK DEPLOY", marker: "FORGE:GATE_FAILURE", ciFailing: 1, ciCancelOnly: true }, lines: [] };
    const s2 = fakeSeam({ summary: still });
    const r2 = await fixStep(ctx(s2, { review: { result: { ...failed, blocking: [], filed: [], ciFailing: 1, ciCancelOnly: true } } }));
    assert.match(r2.reason, /still cancelled/);
    assert.ok(!s2.log.some((e) => e[0] === "ci-issue" || e[0] === "lane"));
  });

  it("only pending CI (#5519): blocks without a CI issue or lane; a real failure alongside still files", async () => {
    const s = fakeSeam();
    const r = await fixStep(ctx(s, { review: { result: { ...failed, blocking: [], filed: [], ciFailing: 1, ciPendingOnly: true } } }));
    assert.match(r.reason, /still pending/);
    assert.deepEqual(s.log, []);
    const s2 = fakeSeam();
    await fixStep(ctx(s2, { review: { result: { ...failed, blocking: [], filed: [], ciFailing: 2, ciPendingOnly: false } } }));
    assert.ok(s2.log.some((e) => e[0] === "ci-issue"));
  });

  it("blocks when the verdict is not a pass but there is nothing to fix", async () => {
    assert.match((await fixStep(ctx(fakeSeam(), { review: { result: { ...failed, blocking: [], ciFailing: 0 } } }))).reason, /nothing to fix|neither/);
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

describe("fixStep in snapshot mode (#5276)", () => {
  const failed = { pr: 7, head: H1, verdict: "BLOCK DEPLOY", marker: "FORGE:GATE_FAILURE", blocking: [101], filed: [101], ciFailing: 0 };
  const SNAP = "1".repeat(40), TIP = "2".repeat(40), ORIG = "3".repeat(40), PICK = "4".repeat(40);
  /** git/gh fakes for one blocker fix (PR 55, closes issue 101) merged on staging; `conflict` makes merge-tree fail. */
  const world = ({ conflict = false } = {}) => {
    const git = [], gh = [];
    const io = {
      git: (a) => {
        git.push(a);
        if (a[0] === "rev-parse") return `${TIP}\n`;
        if (a[0] === "merge-base") { if (a[3] === SNAP) throw new Error("not an ancestor"); return ""; }
        if (a[0] === "rev-list") return `${ORIG} ${"5".repeat(40)}\n`;
        if (a[0] === "merge-tree") { if (conflict) throw new Error("CONFLICT"); return "tree\n"; }
        if (a[0] === "log") return a.includes("--format=%B") ? "fix: blocker\n" : "An\nae@x\n2026-01-01T00:00:00Z\n";
        if (a[0] === "commit-tree") return `${PICK}\n`;
        return "";
      },
      gh: async (a) => {
        gh.push(a);
        if (a[1] === "list" && a[0] === "issue") return "[]";
        if (a[0] === "pr" && a[1] === "list") return JSON.stringify([{ number: 55, mergeCommit: { oid: ORIG }, mergedAt: "t", labels: [], closingIssuesReferences: [{ number: 101 }] }]);
        if (a[0] === "pr" && a[1] === "view") return JSON.stringify({ body: "" });
        return "";
      },
    };
    return { io, git, gh };
  };
  const snapCtx = (seam, w, fixMode) => {
    const c = ctx(seam, { review: { result: failed } });
    c.io = { ...c.io, ...w.io };
    c.git = w.io.git;
    c.config = { mode: "snapshot", ...(fixMode ? { fixMode } : {}) };
    c.state.release = { branch: "release/x", snapshot: SNAP, range: {}, picks: [] };
    return c;
  };

  it("R2: after the fix lane merges, its commit is cherry-picked onto the release branch before the delta review", async () => {
    const s = fakeSeam({ heads: [H2] }), w = world();
    const c = snapCtx(s, w);
    const r = await fixStep(c);
    assert.equal(r.blocked, undefined);
    assert.deepEqual(c.state.release.picks, [{ sha: PICK, orig: ORIG, pr: 55 }]);
    assert.ok(w.git.some((a) => a[0] === "push" && a.includes(`${PICK}:refs/heads/release/x`)));
    assert.ok(w.gh.some((a) => a[1] === "edit" && a[a.indexOf("--body") + 1].includes("FORGE:RELEASE")), "the record is written to the PR");
    assert.deepEqual(s.log.slice(0, 2), [["lane", 101, "staging"], ["pre", H1]]);
  });

  it("a conflicting cherry-pick blocks the job instead of reviewing a head that lacks the fix", async () => {
    const s = fakeSeam({ heads: [H2] });
    const r = await fixStep(snapCtx(s, world({ conflict: true })));
    assert.equal(r.blocked, true);
    assert.match(r.reason, /conflicts/);
    assert.ok(!s.log.some((e) => e[0] === "pre"));
  });

  it("fix_mode recut moves the branch to the staging tip instead of picking", async () => {
    const s = fakeSeam({ heads: [H2] }), w = world();
    const c = snapCtx(s, w, "recut");
    await fixStep(c);
    assert.ok(w.git.some((a) => a[0] === "push" && a.includes("--force") && a.includes(`${TIP}:refs/heads/release/x`)));
    assert.equal(c.state.release.snapshot, TIP);
    assert.deepEqual(c.state.release.picks, []);
  });

  it("freeze mode (no mode) never touches git", async () => {
    const s = fakeSeam({ heads: [H2] }), w = world();
    const c = snapCtx(s, w);
    c.config = {};
    await fixStep(c);
    assert.deepEqual(w.git, []);
  });
});

describe("withIntegrityMarker (filing release findings through issue-create.sh)", () => {
  const count = (s) => (s.match(/<!-- FORGE:BODY-INTEGRITY:[^>]+ -->/g) ?? []).length;
  it("appends exactly one marker to a body that has none", () => {
    const out = withIntegrityMarker("Found by the staging review of PR #5389.\n- **severity**: HIGH", "release-5389-REG-1");
    assert.equal(count(out), 1);
    assert.match(out, /<!-- FORGE:BODY-INTEGRITY:release-5389-REG-1 -->\n$/);
  });
  it("keeps a body that already has exactly one marker unchanged", () => {
    const body = "x\n<!-- FORGE:BODY-INTEGRITY:abc -->\n";
    assert.equal(withIntegrityMarker(body, "y"), body);
  });
  it("collapses several markers to one and sanitises the id", () => {
    const out = withIntegrityMarker("a <!-- FORGE:BODY-INTEGRITY:1 -->\nb <!-- FORGE:BODY-INTEGRITY:2 -->", "fix: auto-spawned schedd (review finding)");
    assert.equal(count(out), 1);
    assert.match(out, /FORGE:BODY-INTEGRITY:fix-auto-spawned-schedd-review-finding -->/);
  });
});
