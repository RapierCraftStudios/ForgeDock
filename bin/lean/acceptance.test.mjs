// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAcceptance, validateEpic, declaredAcceptance, renderAcceptanceComment, acceptanceResultOf, gateMilestone, gateByRef, transferToEpic, transferOf, transferName, runMilestoneJourneys, acceptanceFromCli } from "./acceptance.mjs";
import { makeIntegration } from "./integration.mjs";

const F = "```";
const block = (inner) => `Epic\n\n${F}forge-acceptance\n${inner}\n${F}\n`;
const J1 = block("journey: create a task and get a result\nrun: ./j.sh\npass: exit 0\ntimeout: 60");
const HEAD = "a".repeat(40), OLD = "b".repeat(40);
const owner = { author_association: "OWNER", user: { type: "User", login: "me" } };
const bot = { user: { type: "Bot", login: "forge[bot]" }, author_association: "NONE" };
const rec = (head, results, site = "milestone") => ({ ...bot, body: renderAcceptanceComment({ head, at: "t", site, rows: Object.entries(results).map(([name, result]) => ({ name, result, exit: result === "pass" ? 0 : 1, ms: 1, output: "x" })) }) });
const epic = (declared, comments = []) => ({ number: 7, declared, comments });
const decl = declaredAcceptance({ body: J1, ...owner });

describe("acceptance parsing and the creation gate", () => {
  it("parses journeys with defaults and post-deploy", () => {
    const a = parseAcceptance(block("journey: a\nrun: x\njourney: b\nrun: y\npass: /ok/i\nwhen: post-deploy"));
    assert.deepEqual(a.errors, []);
    assert.equal(a.journeys[0].when, "milestone");
    assert.deepEqual(a.journeys[1].pass, { kind: "regex", re: "ok", flags: "i" });
    assert.equal(a.journeys[1].when, "post-deploy");
  });
  it("rejects an epic without a runnable journey", () => {
    assert.equal(validateEpic("## Epic\nno journeys").ok, false);
    assert.equal(validateEpic(block("journey: a")).ok, false, "no run command");
    assert.equal(validateEpic(block("journey: a\nrun: x\nwhen: never")).ok, false);
    assert.equal(validateEpic(`${F}\n${J1}\n${F}`.replace(/forge-acceptance/, "forge-probe")).ok, false);
    assert.equal(validateEpic(J1).ok, true);
  });
  it("a quoted block (inside another fence) is not a declaration", () => {
    assert.equal(validateEpic(`~~~md\n${J1}\n~~~`).ok, false);
  });
  it("only declarers' journeys count", () => {
    assert.deepEqual(declaredAcceptance({ body: J1, ...bot }), { untrusted: true });
    assert.equal(declaredAcceptance({ body: J1, ...owner }).journeys.length, 1);
    assert.equal(declaredAcceptance({ body: "x", ...owner, comments: [{ body: J1, ...owner }] }).source, "comment");
  });
});

describe("acceptance gate", () => {
  it("blocks a journey that never ran, is red, or ran on an older head", () => {
    const never = gateMilestone({ epics: [epic(decl)], head: HEAD });
    assert.equal(never.ok, false); assert.match(never.reasons[0], /never run/);
    const red = gateMilestone({ epics: [epic(decl, [rec(HEAD, { "create a task and get a result": "fail" })])], head: HEAD });
    assert.match(red.reasons[0], /is red/);
    const stale = gateMilestone({ epics: [epic(decl, [rec(OLD, { "create a task and get a result": "pass" })])], head: HEAD });
    assert.match(stale.reasons[0], /has not run on/);
  });
  it("passes a green run on the head; an epic with no journey blocks", () => {
    assert.equal(gateMilestone({ epics: [epic(decl, [rec(HEAD, { "create a task and get a result": "pass" })])], head: HEAD }).ok, true);
    assert.equal(gateMilestone({ epics: [epic(null)], head: HEAD }).ok, false);
  });
  it("an untrusted (non-bot-marker) result comment does not count", () => {
    const forged = { ...rec(HEAD, { "create a task and get a result": "pass" }), user: { type: "User", login: "rando" }, author_association: "NONE" };
    assert.equal(gateMilestone({ epics: [epic(decl, [forged])], head: HEAD }).ok, false);
  });
  it("post-deploy journeys hold the epic at close, not at ship", () => {
    const d = declaredAcceptance({ body: block("journey: live\nrun: curl x\nwhen: post-deploy"), ...owner });
    assert.equal(gateMilestone({ epics: [epic(d)], head: HEAD, stage: "ship" }).ok, true);
    const c = gateMilestone({ epics: [epic(d)], head: HEAD, stage: "close" });
    assert.equal(c.ok, false); assert.match(c.reasons[0], /post-deploy journey "live"/);
    assert.equal(gateMilestone({ epics: [epic(d, [rec(OLD, { live: "pass" }, "post-deploy")])], head: HEAD, stage: "close" }).ok, true);
  });
  it("result comment round-trips head, time and result", () => {
    const r = acceptanceResultOf(rec(HEAD, { a: "pass", b: "fail" }).body);
    assert.equal(r.head, HEAD); assert.equal(r.at, "t"); assert.equal(r.result, "fail"); assert.equal(r.results.b.result, "fail");
    assert.equal(acceptanceResultOf("no"), null);
  });
});

/** gh stub: milestone "M One" (#3) with epic #7, comments `comments`. */
function world({ comments = [], body = J1, author = owner, labels = true } = {}) {
  const w = { calls: [], posted: [] };
  const epicIssue = { number: 7, state: "open", body, ...author, labels: [{ name: "epic" }] };
  w.io = {
    gh: async (a) => {
      w.calls.push(a);
      if (/milestones\?state=all/.test(a[1])) return JSON.stringify([{ number: 3, title: "M One", description: "" }]);
      if (/issues\?milestone=3/.test(a[1])) return labels ? JSON.stringify([epicIssue]) : "[]";
      if (/issues\/7\/comments/.test(a[1])) return comments.map((c) => JSON.stringify(c)).join("\n");
      if (/\/branches\//.test(a[1])) return `${HEAD}\n`;
      if (a[0] === "issue" && a[1] === "comment") { w.posted.push(a[a.indexOf("--body") + 1]); return ""; }
      if (a[0] === "issue" && a[1] === "edit") return "";
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
    git: async () => `${HEAD}\n`,
  };
  return w;
}

describe("gateByRef, run and CLI", () => {
  it("a milestone cannot ship while its journey never ran (ship and close)", async () => {
    for (const stage of ["ship", "close"]) {
      const w = world();
      const g = await gateByRef({ io: w.io, repo: "o/r", title: "M One", stage });
      assert.equal(g.gated, true); assert.equal(g.ok, false);
    }
  });
  it("no epic means not gated; an unreadable head fails closed", async () => {
    assert.equal((await gateByRef({ io: world({ labels: false }).io, repo: "o/r", title: "M One" })).gated, false);
    assert.equal((await gateByRef({ io: world().io, repo: "o/r", title: "Nope" })).gated, false);
    const w = world(); const gh = w.io.gh; w.io.gh = async (a) => { if (/\/branches\//.test(a[1])) throw new Error("404"); return gh(a); };
    const g = await gateByRef({ io: w.io, repo: "o/r", branch: "milestone/m-one" });
    assert.equal(g.ok, false); assert.match(g.reasons[0], /fail closed/);
  });
  it("runs journeys, posts the result on the epic with the head, and the gate then passes", async () => {
    const w = world();
    const res = await runMilestoneJourneys({ io: w.io, repo: "o/r", milestone: { number: 3, title: "M One", branch: "milestone/m-one" }, cwd: "/x", head: HEAD, now: () => "2026-11-10T00:00:00Z",
      spawn: async () => ({ code: 0, stdout: "ok", stderr: "", timedOut: false }) });
    assert.equal(res[0].result, "pass");
    assert.equal(w.posted.length, 1);
    const r = acceptanceResultOf(w.posted[0]);
    assert.equal(r.head, HEAD); assert.equal(r.at, "2026-11-10T00:00:00Z"); assert.equal(r.result, "pass");
    const w2 = world({ comments: [{ ...bot, body: w.posted[0] }] });
    assert.equal((await gateByRef({ io: w2.io, repo: "o/r", title: "M One" })).ok, true);
  });
  it("a failing journey posts fail", async () => {
    const w = world();
    const res = await runMilestoneJourneys({ io: w.io, repo: "o/r", milestone: { number: 3, title: "M One", branch: "b" }, cwd: "/x", head: HEAD, spawn: async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false }) });
    assert.equal(res[0].result, "fail"); assert.match(w.posted[0], /: fail/);
  });
  it("CLI check/gate exit codes", async () => {
    const out = [];
    const print = (t) => out.push(t);
    assert.equal(await acceptanceFromCli(["check", "--body-file", "f"], { print, readFile: () => "no journeys" }), 1);
    assert.equal(await acceptanceFromCli(["check", "--body-file", "f"], { print, readFile: () => J1 }), 0);
    assert.equal(await acceptanceFromCli(["gate", "--milestone", "M One", "--repo", "o/r"], { print, io: world().io, cwd: "/nonexistent" }), 1);
    assert.match(out.at(-1), /BLOCKED/);
  });
});

describe("integration seam runs journeys after a child merge", () => {
  it("calls journeys without an integration cfg and survives its failure", async () => {
    const calls = [], events = [];
    const io = { gh: async (a) => (/milestones\?state=all/.test(a[1]) ? JSON.stringify([{ number: 3, title: "M One", description: "" }]) : "{}") };
    const ig = makeIntegration({ repo: "o/r", io, cfg: null, journeys: async (m) => { calls.push(m); return "ok"; }, onEvent: (e) => events.push(e.detail) });
    await ig.onMerged(1, {}, { milestone: "M One", pr: 5 });
    await ig.settle();
    assert.deepEqual(calls, [{ title: "M One", branch: "milestone/m-one", number: 3 }]);
    assert.equal(ig.holds(1, { lane: "milestone/m-one" }), null);
    const bad = makeIntegration({ repo: "o/r", io, cfg: null, journeys: async () => { throw new Error("x"); }, onEvent: (e) => events.push(e.detail) });
    await bad.onMerged(1, {}, { milestone: "M One" }); await bad.settle();
    assert.ok(events.some((e) => /journey run failed/.test(e)));
  });
});

describe("transferred requirements (#5339)", () => {
  const rows = (name, result) => [{ name, result, exit: result === "pass" ? 0 : 1, ms: 1 }];
  const declPd = declaredAcceptance({ body: block("journey: smoke\nrun: ./j.sh\nwhen: post-deploy"), ...owner });
  const tcomment = { ...bot, body: ["<!-- FORGE:TRANSFERRED -->", "## t", JSON.stringify({ issue: 5339, req: "R1", quote: "q", at: "t" })].join("\n") };
  const pd = (results) => ({ ...bot, body: renderAcceptanceComment({ head: HEAD, at: "t", site: "post-deploy", rows: Object.entries(results).map(([name, result]) => ({ name, result, exit: result === "pass" ? 0 : 1, ms: 1 })) }) });
  it("blocks the epic's close until a post-deploy journey named for the requirement passes; ship is not blocked", () => {
    const passSmoke = pd({ smoke: "pass" });
    const open = gateMilestone({ epics: [epic(declPd, [tcomment, passSmoke])], head: HEAD, stage: "close" });
    assert.equal(open.ok, false);
    assert.match(open.reasons.join(), /R1 transferred from #5339 has not been run/);
    assert.equal(gateMilestone({ epics: [epic(declPd, [tcomment])], head: HEAD, stage: "ship" }).ok, true);
    assert.equal(gateMilestone({ epics: [epic(declPd, [tcomment, passSmoke, pd({ [transferName(5339, "R1")]: "fail" })])], head: HEAD, stage: "close" }).ok, false);
    assert.equal(gateMilestone({ epics: [epic(declPd, [tcomment, passSmoke, pd({ [transferName(5339, "R1")]: "pass" })])], head: HEAD, stage: "close" }).ok, true);
  });
  it("transferToEpic posts one FORGE:TRANSFERRED comment per requirement, idempotently, and returns null without an epic", async () => {
    const posted = [];
    let existing = [];
    const gh = async (a) => {
      const u = a.join(" ");
      if (u.includes("/milestones")) return JSON.stringify([{ number: 3, title: "Feature X", state: "open" }]);
      if (u.includes("issues?milestone=")) return JSON.stringify([{ number: 7, state: "open", body: "", user: owner.user, author_association: "OWNER" }]);
      if (u.includes("/comments")) return existing.map((b) => JSON.stringify({ body: b, ...bot })).join("\n");
      if (a[0] === "issue" && a[1] === "comment") { posted.push(a[a.indexOf("--body") + 1]); return ""; }
      return "[]";
    };
    const reqs = [{ id: "R1", quote: "Live search works [type:e2e]" }];
    const n = await transferToEpic({ io: { gh }, repo: "o/r", milestoneTitle: "Feature X", issue: 5339, reqs });
    assert.equal(n, 7);
    assert.equal(posted.length, 1);
    assert.deepEqual([transferOf(posted[0]).issue, transferOf(posted[0]).req], [5339, "R1"]);
    existing = [posted[0]];
    await transferToEpic({ io: { gh }, repo: "o/r", milestoneTitle: "Feature X", issue: 5339, reqs });
    assert.equal(posted.length, 1, "idempotent");
    assert.equal(await transferToEpic({ io: { gh }, repo: "o/r", milestoneTitle: null, issue: 5339, reqs }), null);
    assert.equal(await transferToEpic({ io: { gh: async () => "[]" }, repo: "o/r", milestoneTitle: "Feature X", issue: 5339, reqs }), null);
  });
});
