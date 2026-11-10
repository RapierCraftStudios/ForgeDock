// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { originKind, outcomeOf, originReport, gatherOriginIssues, renderOrigin } from "./origin.mjs";
import { buildReport, parseArgs } from "./index.mjs";

const human = { login: "a", is_bot: false }, bot = { login: "forge", is_bot: true };
const iss = (n, extra = {}) => ({ number: n, title: `issue ${n}`, body: "", labels: [], createdAt: "2026-11-01T00:00:00Z", state: "CLOSED", stateReason: "COMPLETED", author: bot, ...extra });
const run = (n, usd, reason = "merged") => ({ issue: n, reason, phases: { implement: { usd } } });

describe("stats --origin (#5294)", () => {
  it("classifies by markers first, human author as requested, else unknown", () => {
    assert.equal(originKind(iss(1, { body: "<!-- FORGE:PRODWATCH source=x -->", author: human })), "production");
    assert.equal(originKind(iss(2, { labels: ["review-finding"], author: human })), "review-finding");
    assert.equal(originKind(iss(3, { labels: [{ name: "staging-review" }] })), "review-finding");
    assert.equal(originKind(iss(4, { body: "<!-- FORGE:DEFERRED_FROM: #1 -->" })), "follow-up");
    assert.equal(originKind(iss(5, { author: human })), "requested");
    assert.equal(originKind(iss(6)), "unknown");
    assert.equal(originKind(iss(7, { author: undefined })), "unknown");
  });
  it("classifies outcomes", () => {
    assert.equal(outcomeOf(iss(1, { state: "OPEN", stateReason: null })), "open");
    assert.equal(outcomeOf(iss(1, { stateReason: "NOT_PLANNED" })), "closed-invalid");
    assert.equal(outcomeOf(iss(1, { stateReason: "COMPLETED", labels: ["duplicate"] })), "closed-invalid");
    assert.equal(outcomeOf(iss(1, { stateReason: "COMPLETED" })), "merged");
    assert.equal(outcomeOf(iss(1, { stateReason: null }), run(1, 1)), "merged");
    assert.equal(outcomeOf(iss(1, { stateReason: null })), "other-closed");
  });
  const ISSUES = [iss(1, { author: human }), iss(2, { labels: ["review-finding"] }), iss(3, { labels: ["review-finding"], stateReason: "NOT_PLANNED" }),
    iss(4, { body: "<!-- FORGE:DEFERRED_FROM: #1 -->", state: "OPEN", stateReason: null }), iss(5), iss(6, { createdAt: "2026-09-01T00:00:00Z" }), iss(7, { isPr: true })];
  it("counts, cost share, unknown cost and window", () => {
    const r = originReport({ issues: ISSUES, runs: [run(1, 6), run(2, 2), run(3, 2, "failed")], since: "2026-10-01", repo: "o/r" });
    assert.equal(r.total, 5);
    assert.deepEqual(Object.fromEntries(Object.entries(r.by_origin).map(([k, v]) => [k, v.count])), { requested: 1, production: 0, "review-finding": 2, "follow-up": 1, unknown: 1 });
    assert.equal(r.by_origin["review-finding"].cost_usd, 4);
    assert.equal(r.by_origin["review-finding"].outcomes["closed-invalid"], 1);
    assert.equal(r.by_origin["follow-up"].cost_unknown, 1);
    assert.equal(r.by_origin["follow-up"].outcomes.open, 1);
    assert.equal(r.cost_usd, 10);
    assert.equal(r.pipeline.cost_share, 0.4);
    assert.match(renderOrigin(r), /pipeline-originated: 3 issues, \$4\.00 of \$10\.00 \(40\.0%/);
  });
  it("no recorded cost gives a null share, not 0", () => {
    assert.equal(originReport({ issues: [iss(1)], runs: [] }).pipeline.cost_share, null);
  });
  it("gatherOriginIssues throws on unreadable output", async () => {
    await assert.rejects(gatherOriginIssues({ gh: async () => "nope", repo: "o/r", since: "2026-10-01" }), /unreadable/);
  });
  it("parseArgs and buildReport wire --origin with stubbed gh", async () => {
    const o = parseArgs(["--origin", "--repo", "o/r", "--since", "2026-10-01"]);
    assert.equal(o.origin, true);
    const gh = async (args) => (args[0] === "issue" ? JSON.stringify(ISSUES) : "[]");
    const rep = await buildReport({ ...o, cache: false, local: false }, { gh, env: {}, now: () => Date.parse("2026-11-10T00:00:00Z") });
    assert.equal(rep.query.origin.total, 5);
    assert.equal(rep.query.origin.since, "2026-10-01");
  });
});
