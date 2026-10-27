// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseIntegration, parseIntegrationState, renderState, isDue, failingSpecs, runMilestone, runIntegration, makeIntegration, runIntegrationCli, emptyState } from "./integration.mjs";
import { orchestrate } from "./orchestrate.mjs";

const SHA = "a".repeat(40), SHA2 = "b".repeat(40);
const CFG = parseIntegration({ workflow: "e2e.yml", every_merges: "2", block_admission_after: "2" });
const NOW = Date.parse("2026-10-27T10:00:00Z");

/** One milestone "M One" (branch milestone/m-one), a workflow whose conclusion is `st.conclusion`, and a log of every gh call. */
function fake({ description = "Ship it.", conclusion = "success", branch = true, open = [] } = {}) {
  const st = { description, conclusion, open: [...open], calls: [], created: [], edited: [], closed: [], head: SHA };
  const gh = async (a) => {
    st.calls.push(a);
    if (a[0] === "api" && /milestones\?state=open/.test(a[1])) return JSON.stringify([{ number: 3, title: "M One", description: st.description }, { number: 4, title: "No Branch", description: "" }]);
    if (a[0] === "api" && /milestones\?state=all/.test(a[1])) return JSON.stringify([{ number: 3, title: "M One", description: st.description }]);
    if (a[0] === "api" && /\/branches\//.test(a[1])) { if (branch && /milestone%2Fm-one/.test(a[1])) return `${st.head}\n`; throw new Error("404"); }
    if (a[0] === "api" && a[1] === "-X" && a[2] === "PATCH") { st.description = a[a.indexOf("-f") + 1].slice("description=".length); return "{}"; }
    if (a[0] === "issue" && a[1] === "list") return JSON.stringify(st.open);
    if (a[0] === "issue" && a[1] === "create") {
      const n = 900 + st.created.length;
      st.created.push({ n, title: a[a.indexOf("--title") + 1], body: a[a.indexOf("--body") + 1], label: a.includes("--label") });
      st.open.push({ number: n, body: a[a.indexOf("--body") + 1] });
      return `https://github.com/o/r/issues/${n}\n`;
    }
    if (a[0] === "issue" && a[1] === "edit") { st.edited.push({ n: a[2], body: a[a.indexOf("--body") + 1] }); st.open = st.open.map((x) => (String(x.number) === a[2] ? { ...x, body: a[a.indexOf("--body") + 1] } : x)); return ""; }
    if (a[0] === "issue" && a[1] === "close") { st.closed.push(a[2]); st.open = st.open.filter((x) => String(x.number) !== a[2]); return ""; }
    throw new Error(`unexpected gh ${a.join(" ")}`);
  };
  const io = { gh, dispatchWorkflow: async () => {},
    workflowRuns: async () => [{ databaseId: 5, headSha: st.head, status: "completed", conclusion: st.conclusion, url: "https://run/5", name: "e2e" }],
    failedLogs: async () => "FAIL e2e/cart.spec.ts\nFAIL e2e/login.e2e.ts\n" };
  return { st, io };
}
const run = (io, st, extra = {}) => runIntegration({ io, repo: "o/r", cfg: CFG, pattern: "milestone/{slug}", nowFn: () => NOW, sleep: async () => {}, ...extra });

describe("config and state", () => {
  it("is off without a workflow and parses the keys", () => {
    assert.equal(parseIntegration({}), null);
    assert.equal(parseIntegration({ workflow: "a b" }), null);
    assert.deepEqual([CFG.workflow, CFG.intervalHours, CFG.everyMerges, CFG.blockAdmissionAfter, CFG.projectInput], ["e2e.yml", 24, 2, 2, "project"]);
    assert.equal(parseIntegration({ workflow: "e.yml", interval_hours: "x", block_admission_after: "0" }).blockAdmissionAfter, null);
  });
  it("round-trips the state block and keeps the description text", () => {
    const d = renderState("Ship it.", { ...emptyState(), redStreak: 3 });
    assert.match(d, /^Ship it\./);
    assert.equal(parseIntegrationState(d).redStreak, 3);
    assert.equal(parseIntegrationState(renderState(d, { ...emptyState(), redStreak: 1 })).redStreak, 1);
    assert.equal(parseIntegrationState("none"), null);
  });
  it("is due when never run, aged, or after N merges", () => {
    assert.equal(isDue(null, CFG, NOW).due, true);
    const s = { ...emptyState(), lastRun: { at: new Date(NOW - 3600000).toISOString() } };
    assert.equal(isDue(s, CFG, NOW).due, false);
    assert.equal(isDue({ ...s, mergesSince: 2 }, CFG, NOW).due, true);
    assert.equal(isDue({ ...s, lastRun: { at: new Date(NOW - 25 * 3600000).toISOString() } }, CFG, NOW).due, true);
  });
  it("names failing specs from logs", () => assert.deepEqual(failingSpecs([{ log: "FAIL e2e/a.spec.ts x e2e/a.spec.ts ./b.test.js" }]), ["b.test.js", "e2e/a.spec.ts"]));
});

describe("runIntegration", () => {
  it("skips a milestone without a branch and records a green run", async () => {
    const { st, io } = fake();
    const res = await run(io, st);
    assert.equal(res.find((r) => r.title === "No Branch").ran, false);
    assert.equal(res.find((r) => r.title === "M One").result, "pass");
    const s = parseIntegrationState(st.description);
    assert.equal(s.lastGreen.sha, SHA);
    assert.equal(s.redStreak, 0);
    assert.equal(st.created.length, 0);
  });
  it("a red run files ONE integration-red issue and a second red updates it", async () => {
    const { st, io } = fake({ conclusion: "failure" });
    await run(io, st);
    assert.equal(st.created.length, 1);
    assert.match(st.created[0].title, /integration-red\(milestone\/m-one\)/);
    assert.ok(st.created[0].label);
    assert.match(st.created[0].body, /e2e\/cart\.spec\.ts/);
    assert.match(st.created[0].body, /Merge range/);
    assert.match(st.created[0].body, /<!-- FORGE:INTEGRATION:m-one -->/);
    st.head = SHA2;
    await run(io, st, { force: true });
    assert.equal(st.created.length, 1, "no second issue");
    assert.equal(st.edited.length, 1);
    assert.match(st.edited[0].body, /2 consecutive red runs/);
    assert.equal(parseIntegrationState(st.description).redStreak, 2);
  });
  it("a green run after red closes the issue, records the range start and resets the streak", async () => {
    const { st, io } = fake({ conclusion: "failure" });
    await run(io, st);
    st.conclusion = "success"; st.head = SHA2;
    await run(io, st, { force: true });
    assert.deepEqual(st.closed, ["900"]);
    const s = parseIntegrationState(st.description);
    assert.equal(s.redStreak, 0);
    assert.equal(s.lastGreen.sha, SHA2);
  });
  it("the red issue names the merge range from the last green run", async () => {
    const { st, io } = fake();
    await run(io, st);
    st.conclusion = "failure"; st.head = SHA2;
    await run(io, st, { force: true });
    assert.match(st.created[0].body, new RegExp(`${SHA.slice(0, 7)}\\.\\.${SHA2.slice(0, 7)}`));
  });
  it("is not run again when not due", async () => {
    const { st, io } = fake();
    await run(io, st);
    const again = await run(io, st);
    assert.equal(again.find((r) => r.title === "M One").ran, false);
  });
  it("a timed-out run records nothing", async () => {
    const { st, io } = fake();
    io.workflowRuns = async () => [{ databaseId: 5, headSha: st.head, status: "in_progress", conclusion: null }];
    let t = NOW;
    const r = await runMilestone({ io, repo: "o/r", ms: { number: 3, title: "M One", description: "" }, cfg: { ...CFG, maxMinutes: 1 }, pattern: "milestone/{slug}", nowFn: () => (t += 120000), sleep: async () => {} });
    assert.equal(r.result, "timeout");
    assert.equal(parseIntegrationState(st.description), null);
  });
});

describe("makeIntegration seam", () => {
  it("is null when off", () => assert.equal(makeIntegration({ repo: "o/r", io: {}, cfg: null }), null));
  it("holds a lane after N consecutive red runs and releases it on green", async () => {
    const red = { ...emptyState(), redStreak: 2 };
    const { st, io } = fake({ description: renderState("", red) });
    const seam = makeIntegration({ repo: "o/r", io, cfg: CFG, nowFn: () => NOW, sleep: async () => {} });
    await seam.prime();
    assert.match(seam.holds(1, { lane: "milestone/m-one" }), /2 consecutive red integration runs/);
    assert.equal(seam.holds(1, { lane: "staging" }), null);
    st.head = SHA2;
    for (const pr of [11, 12]) await seam.onMerged(1, {}, { milestone: "M One", pr });
    await seam.settle();
    assert.equal(seam.holds(1, { lane: "milestone/m-one" }), null, "green run released the hold");
    assert.equal(parseIntegrationState(st.description).redStreak, 0);
  });
  it("records merged PRs and starts a run only at every_merges", async () => {
    const { st, io } = fake({ conclusion: "failure" });
    const seam = makeIntegration({ repo: "o/r", io, cfg: CFG, nowFn: () => NOW, sleep: async () => {} });
    await seam.onMerged(1, {}, { milestone: "M One", pr: 11 });
    await seam.settle();
    assert.equal(st.created.length, 0);
    assert.deepEqual(parseIntegrationState(st.description).mergedPrs, [11]);
    await seam.onMerged(2, {}, { milestone: "M One", pr: 12 });
    await seam.settle();
    assert.equal(st.created.length, 1);
    assert.match(st.created[0].body, /#11, #12/);
  });
  it("orchestrate ends a held lane `held` and starts nothing while the streak is red", async () => {
    const started = [];
    const integration = { holds: (n, { lane }) => (lane === "milestone/m-one" ? "2 consecutive red integration runs on milestone/m-one" : null) };
    const rows = await orchestrate({ issues: [1], parallel: 1, readBody: async () => "body", resolveLane: async () => ({ lane: "milestone/m-one" }),
      runOne: async (n) => { started.push(n); return { outcome: "merged" }; }, integration, pollMs: 1 });
    assert.deepEqual(started, []);
    assert.equal(rows[0].outcome, "held");
    assert.match(rows[0].detail, /integration: 2 consecutive red/);
  });
});

describe("runIntegrationCli", () => {
  it("does nothing without ci.workflow", async () => {
    const out = [];
    assert.equal(await runIntegrationCli(["run"], { cfg: null, print: (t) => out.push(t) }), 0);
    assert.match(out[0], /nothing to run/);
  });
  it("prints a line per milestone and exits 1 on a red run", async () => {
    const { st, io } = fake({ conclusion: "failure" });
    const out = [];
    const code = await runIntegrationCli(["run", "--repo", "o/r"], { cfg: CFG, io, pattern: "milestone/{slug}", now: () => NOW, sleep: async () => {}, print: (t) => out.push(t) });
    assert.equal(code, 1);
    assert.ok(out.some((l) => /M One: fail/.test(l)));
    assert.equal(st.created.length, 1);
  });
});

describe("integration status", () => {
  it("prints the last green run per milestone", async () => {
    const { st, io } = fake();
    await run(io, st);
    const out = [];
    assert.equal(await runIntegrationCli(["status", "--repo", "o/r"], { io, cfg: CFG, print: (t) => out.push(t) }), 0);
    assert.ok(out.some((l) => /M One: last green full-suite run 2026-10-27T10:00:00\.000Z \(red streak 0\)/.test(l)));
    assert.ok(out.some((l) => /No Branch: last green full-suite run never/.test(l)));
    const off = [];
    await runIntegrationCli(["status", "--repo", "o/r"], { io, cfg: null, print: (t) => off.push(t) });
    assert.equal(off.length, 1, "without ci.workflow only milestones with a state block");
  });
});
