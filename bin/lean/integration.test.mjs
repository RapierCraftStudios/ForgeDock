// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseIntegration, parseIntegrationState, renderState, isDue, failingSpecs, runMilestone, runIntegration, makeIntegration, runIntegrationCli, emptyState, listOpenMilestones } from "./integration.mjs";
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

describe("walking skeleton and journey gate (#5337)", () => {
  const LANE = "milestone/m-one";
  const withSkeleton = (io, open = [{ number: 7, body: "", milestone: { title: "M One" } }]) => ({ ...io, gh: async (a) => (a[0] === "issue" && a[1] === "list" && a.includes("skeleton") ? JSON.stringify(open) : io.gh(a)) });

  it("admits no sibling until the skeleton issue merges", async () => {
    const { st, io } = fake({});
    const seam = makeIntegration({ repo: "o/r", io: withSkeleton(io), cfg: null, skeleton: true, nowFn: () => NOW });
    await seam.prime();
    assert.match(seam.holds(8, { lane: LANE }), /skeleton issue #7 of milestone\/m-one has not merged/);
    assert.equal(seam.holds(7, { lane: LANE }), null, "the skeleton itself is admitted");
    assert.equal(seam.holds(8, { lane: "staging" }), null, "other lanes are untouched");
    await seam.onMerged(7, {}, { milestone: "M One", pr: 20 });
    assert.equal(seam.holds(8, { lane: LANE }), null);
    assert.equal(parseIntegrationState(st.description).firstMergeAt, new Date(NOW).toISOString());
  });
  it("is off without the skeleton option", () => assert.equal(makeIntegration({ repo: "o/r", io: fake({}).io, cfg: null }), null));

  it("a red journey files ONE integration-red issue naming the PR, holds admission, and a green run closes it", async () => {
    const { st, io } = fake({});
    let result = { summary: "#5 fail", red: true, ran: true, head: SHA };
    const events = [];
    const seam = makeIntegration({ repo: "o/r", io: withSkeleton(io, []), cfg: null, skeleton: true, journeys: async () => result, nowFn: () => NOW, onEvent: (e) => events.push(e.detail) });
    await seam.prime();
    await seam.onMerged(1, {}, { milestone: "M One", pr: 11 });
    await seam.settle();
    assert.equal(st.created.length, 1);
    assert.match(st.created[0].title, /journey red after #11/);
    assert.match(st.created[0].body, /<!-- FORGE:INTEGRATION:journey:m-one -->/);
    assert.match(seam.holds(2, { lane: LANE }), /epic journey red on milestone\/m-one \(integration-red #900\)/);
    await seam.onMerged(2, {}, { milestone: "M One", pr: 12 });
    await seam.settle();
    assert.equal(st.created.length, 1, "still one issue");
    assert.match(st.edited.at(-1).body, /#11, #12/);
    result = { summary: "#5 pass", red: false, ran: true, head: SHA2 };
    await seam.onMerged(3, {}, { milestone: "M One", pr: 13 });
    await seam.settle();
    assert.deepEqual(st.closed, ["900"]);
    assert.equal(seam.holds(4, { lane: LANE }), null);
    const state = parseIntegrationState(st.description);
    assert.ok(state.firstMergeAt && state.firstJourneyGreenAt);
    assert.ok(events.some((d) => /first green journey on milestone\/m-one/.test(d)));
  });
  it("#5382: the integration-red issue itself is admitted, and a merge during a running journey run queues a rerun that clears the hold", async () => {
    const { st, io } = fake({});
    let release, runs = 0;
    const gate = new Promise((r) => { release = r; });
    const results = [{ summary: "fail", red: true, ran: true, head: SHA }, { summary: "pass", red: false, ran: true, head: SHA2 }];
    const seam = makeIntegration({ repo: "o/r", io: withSkeleton(io, []), cfg: null, skeleton: true, nowFn: () => NOW,
      journeys: async () => { const r = results[Math.min(runs++, 1)]; if (runs === 1) await gate; return r; } });
    await seam.prime();
    const first = seam.onMerged(1, {}, { milestone: "M One", pr: 11 });
    await first;
    await seam.onMerged(2, {}, { milestone: "M One", pr: 12 }); // lands while run 1 is in flight
    assert.equal(runs, 1, "no concurrent run");
    release();
    await seam.settle();
    assert.equal(runs, 2, "the merge that landed mid-run got its own run");
    assert.equal(seam.holds(3, { lane: LANE }), null, "the rerun was green: hold cleared");
    assert.deepEqual(st.closed, ["900"]);
    // and while red, only the red issue is admitted
    const red = fake({});
    const seam2 = makeIntegration({ repo: "o/r", io: withSkeleton(red.io, []), cfg: null, skeleton: true, nowFn: () => NOW, journeys: async () => ({ summary: "fail", red: true, ran: true, head: SHA }) });
    await seam2.prime();
    await seam2.onMerged(1, {}, { milestone: "M One", pr: 11 });
    await seam2.settle();
    assert.match(seam2.holds(2, { lane: LANE }), /integration-red #900/);
    assert.equal(seam2.holds(900, { lane: LANE }), null, "the red issue is the exit");
  });
  it("a red journey before the skeleton merged files nothing and holds nothing extra", async () => {
    const { st, io } = fake({});
    const seam = makeIntegration({ repo: "o/r", io: withSkeleton(io), cfg: null, skeleton: true, journeys: async () => ({ summary: "fail", red: true, ran: true, head: SHA }), nowFn: () => NOW });
    await seam.prime();
    await seam.onMerged(8, {}, { milestone: "M One", pr: 11 });
    await seam.settle();
    assert.equal(st.created.length, 0);
  });
  it("reloads an open journey red issue on prime and `integration status` shows the metric", async () => {
    const body = "x\n<!-- FORGE:INTEGRATION:journey:m-one -->";
    const { io } = fake({ description: renderState("", { ...emptyState(), firstMergeAt: "2026-10-27T09:00:00.000Z" }) });
    const gh = async (a) => (a[0] === "issue" && a[1] === "list" && a.includes("integration-red") ? JSON.stringify([{ number: 31, body, milestone: { title: "M One" } }]) : io.gh(a));
    const seam = makeIntegration({ repo: "o/r", io: { ...io, gh }, cfg: null, journeys: async () => "no journey declared" });
    await seam.prime();
    assert.match(seam.holds(2, { lane: LANE }), /integration-red #31/);
    const lines = [];
    await runIntegrationCli(["status", "--repo", "o/r"], { io, cfg: null, print: (t) => lines.push(t) });
    assert.match(lines.join("\n"), /first merge 2026-10-27T09:00:00.000Z, first green journey never/);
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
  it("runs the journeys after a child merge even with no integration cfg (#5336)", async () => {
    const { io } = fake({});
    const calls = [];
    const seam = makeIntegration({ repo: "o/r", io, cfg: null, journeys: async (m) => { calls.push(m.title); } });
    await seam.onMerged(1, {}, { milestone: "M One", pr: 11 });
    await seam.settle();
    assert.deepEqual(calls, ["M One"]);
    assert.equal(seam.holds(1, { lane: "milestone/m-one" }), null);
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

/** #5084: a GitHub-like milestones endpoint: pages of 100; without --paginate only page 1; `--jq '.[] | @json'` prints one object per line. */
const pagedMilestones = (all) => (a) => {
  const state = /state=(\w+)/.exec(a[1])?.[1] ?? "open";
  const items = all.filter((m) => state === "all" || m.state === state);
  const pages = []; for (let i = 0; i < items.length; i += 100) pages.push(items.slice(i, i + 100));
  if (!a.includes("--paginate")) return JSON.stringify(pages[0] ?? []);
  if (a.includes("--jq")) return items.map((m) => JSON.stringify(m)).join("\n") + "\n";
  return pages.map((p) => JSON.stringify(p)).join("");
};
const manyMilestones = (target, n = 120) => [...Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `M ${i + 1}`, state: i % 2 ? "open" : "closed", description: "" })), { number: n + 1, ...target }];

describe("listOpenMilestones pagination (#5084)", () => {
  it("(#5084) listOpenMilestones returns open milestones past page 1", async () => {
    const all = manyMilestones({ title: "Target", state: "open" }, 220).map((m) => ({ ...m, state: "open" }));
    const gh = async (a) => pagedMilestones(all)(a);
    const got = await listOpenMilestones({ gh, repo: "o/r" });
    assert.equal(got.length, 221);
    assert.deepEqual(got.at(-1), { number: 221, title: "Target", description: "" });
  });
});
