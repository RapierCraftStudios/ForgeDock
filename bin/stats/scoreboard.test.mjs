import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defectClass, scoreboard, gatherScoreboard, renderScoreboard, scoreboardGate } from "./scoreboard.mjs";
import { renderAcceptanceComment } from "../lean/acceptance.mjs";
import { buildReport, parseArgs } from "./index.mjs";

const iss = (number, o = {}) => ({ number, state: "closed", title: `t${number}`, body: "", labels: [], created_at: "2026-11-01T00:00:00Z", closed_at: "2026-11-02T00:00:00Z", ...o });
const ms = { number: 7, title: "Feature X", state: "closed" };
const acc = (head, at, result) => ({ body: renderAcceptanceComment({ head, at, site: "milestone", rows: [{ name: "j", result, exit: result === "pass" ? 0 : 1, ms: 1, output: "x" }] }), created_at: at });
const epicRow = (comments) => ({ number: 1, state: "open", declared: { journeys: [{ name: "j", when: "milestone" }] }, comments });
const ISSUES = [
  iss(1, { labels: [{ name: "epic" }] }),
  iss(2, { closed_at: "2026-11-02T00:00:00Z" }),
  iss(3, { closed_at: "2026-11-03T00:00:00Z" }),
  iss(4, { body: "Fixes #2 after the redo", closed_at: "2026-11-04T00:00:00Z" }),
  iss(5, { labels: [{ name: "bug" }, { name: "post-deploy" }], created_at: "2026-11-06T00:00:00Z" }),
  iss(6, { title: "hotfix: crash", labels: [{ name: "needs-human" }], created_at: "2026-11-07T00:00:00Z" }),
  iss(8, { labels: [{ name: "bug" }], created_at: "2026-11-01T12:00:00Z" }), // before the last child: not a defect after it
  iss(20, { pull_request: {}, closed_at: "2026-11-02T00:00:00Z" }),
];
const PRS = [{ number: 20, merged_at: "2026-11-02T00:00:00Z", head_ref: "feat/issue-2-x" }, { number: 21, merged_at: "2026-11-03T00:00:00Z", head_ref: "hand-fix" }];

describe("feature scoreboard", () => {
  it("counts PRs labelled manual-merge as operator interventions", () => {
    const s = scoreboard({ milestone: ms, issues: [iss(2), iss(30, { pull_request: {}, labels: [{ name: "manual-merge" }] })], prs: [] });
    assert.deepEqual(s.interventions.manual_merges, [30]);
    assert.equal(s.interventions.total, 1);
  });
  it("classifies defects by label or title", () => {
    assert.equal(defectClass(iss(1, { labels: ["release-review"] })), "release-review");
    assert.equal(defectClass(iss(1, { title: "hotfix: x" })), "hotfix");
    assert.equal(defectClass(iss(1, { labels: ["bug"] })), "other");
    assert.equal(defectClass(iss(1)), null);
  });
  it("a shipped milestone: journey status, time to first green, defects by class, rework, interventions", () => {
    const epics = [epicRow([acc("a".repeat(40), "2026-11-04T00:00:00Z", "fail"), acc("b".repeat(40), "2026-11-05T00:00:00Z", "pass")])];
    const s = scoreboard({ milestone: ms, issues: ISSUES, prs: PRS, epics });
    assert.equal(s.journey_status_at_ship, "pass");
    assert.equal(s.minutes_first_merge_to_first_green, 3 * 1440);
    assert.equal(s.last_child_merged_at, "2026-11-04T00:00:00.000Z");
    assert.deepEqual(s.defects_after_last_child.by_class, { "release-review": 0, "post-deploy": 1, hotfix: 1, other: 0 });
    assert.deepEqual(s.rework.issues, [4]);
    assert.deepEqual(s.interventions.hand_prs, [21]);
    assert.deepEqual(s.interventions.needs_human_issues, [6]);
  });
  it("red and never-run journeys are not pass; missing data is null, not 0", () => {
    assert.equal(scoreboard({ milestone: ms, issues: ISSUES, epics: [epicRow([acc("a".repeat(40), "2026-11-04T00:00:00Z", "fail")])] }).journey_status_at_ship, "fail");
    const never = scoreboard({ milestone: ms, issues: ISSUES, epics: [epicRow([])] });
    assert.equal(never.journey_status_at_ship, "never-ran");
    assert.equal(never.minutes_first_merge_to_first_green, null);
    const open = scoreboard({ milestone: ms, issues: [iss(2, { state: "open", closed_at: null })], epics: [] });
    assert.equal(open.defects_after_last_child, null);
    assert.equal(open.journey_status_at_ship, null);
    assert.match(renderScoreboard(open), /n\/a/);
  });
  it("run logs add cost and needs-human runs", () => {
    const s = scoreboard({ milestone: ms, issues: ISSUES, runs: [{ issue: 2, usd: 1.5, reason: "merged" }, { issue: 3, usd: 0.25, reason: "needs-human" }, { issue: 99, usd: 9 }] });
    assert.equal(s.cost_usd, 1.75);
    assert.equal(s.interventions.needs_human_runs, 1);
  });
  it("gate: refuses a regressed benchmark, a missing one and red journeys", () => {
    assert.equal(scoreboardGate({ bench: { regression: null } }).ok, true);
    assert.equal(scoreboardGate({ bench: null }).ok, false);
    assert.equal(scoreboardGate({ bench: { regression: "x" } }).ok, false);
    assert.equal(scoreboardGate({ bench: { regression: null }, board: { milestone: ms, journey_status_at_ship: "fail" } }).ok, false);
  });
  it("gatherScoreboard and stats --milestone read the board through gh alone", async () => {
    const acceptanceComment = acc("b".repeat(40), "2026-11-05T00:00:00Z", "pass");
    const gh = async (args) => {
      const a = args.join(" ");
      if (a.includes("/milestones")) return JSON.stringify(ms) + "\n";
      if (a.includes("/pulls/")) return JSON.stringify(PRS[0]) + "\n";
      if (a.includes("/issues?milestone=7&state=all")) return ISSUES.map((i) => JSON.stringify(i)).join("\n");
      if (a.includes("labels=epic")) return JSON.stringify([{ number: 1, state: "open", body: "", user: { login: "bot", type: "Bot" }, author_association: "NONE" }]);
      if (a.includes("/issues/1/comments")) return JSON.stringify({ ...acceptanceComment, user: { login: "bot", type: "Bot" }, author_association: "NONE" }) + "\n";
      return "";
    };
    const s = await gatherScoreboard({ io: { gh }, repo: "o/r", ref: "Feature X" });
    assert.equal(s.milestone.number, 7);
    assert.equal(s.children, 6);
    assert.equal((await gatherScoreboard({ io: { gh }, repo: "o/r", ref: "nope" })), null);
    const report = await buildReport({ minN: 10, ...parseArgs(["--milestone", "7"]), repo: "o/r", local: false, cache: false }, { gh, releaseTimes: [], env: {} });
    assert.equal(report.query.scoreboard.milestone.title, "Feature X");
    assert.ok(report.query.mix, "the verdict mix stays");
    assert.match(renderScoreboard(report.query.scoreboard), /Feature scoreboard: Feature X/);
  });
});
