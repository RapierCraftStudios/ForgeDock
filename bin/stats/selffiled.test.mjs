// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selfFiledKind, selfFiledReport, gatherIssues, renderSelfFiled, SELF_FILED_KINDS, SELF_FILED_TARGET } from "./selffiled.mjs";
import { buildReport, parseArgs, runStats } from "./index.mjs";

const iss = (n, extra = {}) => ({ number: n, title: `issue ${n}`, body: "", labels: [], createdAt: "2026-11-01T00:00:00Z", ...extra });
const ISSUES = [
  iss(1, { body: "x\n<!-- FORGE:POSTDEPLOY_ROLLUP: default -->\n### #4\n<!-- FORGE:DEFERRED_FROM: #4 -->" }), // rollup wins over follow-up
  iss(2, { body: "<!-- FORGE:EXTERNAL_BATCH: b1 -->" }),
  iss(3, { body: "<!-- FORGE:HOST_BATCH: b1 -->" }),
  iss(4, { body: "<!-- FORGE:BACKLOG_BATCH: b0 -->" }),
  iss(5, { body: "<!-- FORGE:DEFERRED_FROM: #9 -->", labels: [{ name: "review-finding" }] }), // follow-up wins over the label
  iss(6, { title: "follow-up: 3 deferred item(s) from #9" }),
  iss(7, { labels: [{ name: "staging-review" }, { name: "review-finding" }] }),
  iss(8, { labels: ["review-finding"] }),
  ...Array.from({ length: 12 }, (_, i) => iss(100 + i, { labels: [{ name: "bug" }] })),
  iss(200, { createdAt: "2026-09-01T00:00:00Z", body: "<!-- FORGE:EXTERNAL_BATCH: old -->" }), // outside the window
];

describe("stats --self-filed (#5207)", () => {
  it("classifies by precedence rollup, follow-up, staging-review, review-finding, else null", () => {
    assert.deepEqual(ISSUES.slice(0, 8).map(selfFiledKind), ["rollup", "rollup", "rollup", "rollup", "follow-up", "follow-up", "staging-review", "review-finding"]);
    assert.equal(selfFiledKind(iss(9, { labels: [{ name: "bug" }] })), null);
    assert.equal(selfFiledKind({}), null);
  });
  it("reports the share by kind against the 15% target", () => {
    const r = selfFiledReport({ issues: ISSUES, since: "2026-10-08", repo: "o/r" });
    assert.deepEqual(r.by_kind, { "follow-up": 2, "review-finding": 1, "staging-review": 1, rollup: 4 });
    assert.equal(r.total, 20); assert.equal(r.pipeline, 8); assert.equal(r.share, 0.4);
    assert.equal(r.target, SELF_FILED_TARGET); assert.equal(r.met, false);
    assert.equal(selfFiledReport({ issues: ISSUES.slice(8, 20).concat(ISSUES[7]), since: "2026-10-08" }).met, true);
    const none = selfFiledReport({ issues: [], since: "2026-10-08" });
    assert.equal(none.share, null); assert.equal(none.met, null);
    const out = renderSelfFiled(r);
    for (const k of SELF_FILED_KINDS) assert.match(out, new RegExp(`^  ${k} +\\d+ `, "m"));
    assert.match(out, /total +8 +40\.0% \(target < 15\.0%: not met\)/);
  });
  it("gatherIssues lists every state since the date; unreadable output is an error, never 0%", async () => {
    const calls = [];
    const gh = async (a) => { calls.push(a); return JSON.stringify(ISSUES); };
    assert.equal((await gatherIssues({ gh, repo: "o/r", since: "2026-10-08" })).length, ISSUES.length);
    assert.deepEqual(calls[0], ["issue", "list", "-R", "o/r", "--state", "all", "--search", "created:>=2026-10-08", "--limit", "1000", "--json", "number,title,body,labels,createdAt"]);
    await assert.rejects(gatherIssues({ gh: async () => "rate limited", repo: "o/r", since: "2026-10-08" }), /unreadable/);
    await assert.rejects(gatherIssues({ gh: async () => "{}", repo: "o/r", since: "2026-10-08" }), /did not return a list/);
  });
  it("wires --self-filed through parseArgs and buildReport (default window: 30 days)", async () => {
    assert.equal(parseArgs(["--self-filed"]).selfFiled, true); assert.equal(parseArgs([]).selfFiled, false);
    let seen;
    const gh = async (a) => { seen = a; return JSON.stringify(ISSUES); };
    const r = await buildReport({ ...parseArgs(["--self-filed"]), repo: "o/r" }, { gh, now: () => Date.parse("2026-11-07T00:00:00Z") });
    assert.equal(seen[seen.indexOf("--search") + 1], "created:>=2026-10-08");
    assert.equal(r.query.self_filed.pipeline, 8);
    const d = await buildReport({ ...parseArgs(["--self-filed", "--since", "2026-11-02"]), repo: "o/r" }, { gh });
    assert.equal(d.query.self_filed.since, "2026-11-02"); assert.equal(d.query.self_filed.total, 0);
    await assert.rejects(buildReport({ ...parseArgs(["--self-filed", "--since", "1.2.0"]), repo: "o/r" }, { gh }), /must be a date/);
  });
  it("runStats prints the report, or exits 1 on unreadable gh output", async () => {
    const write = process.stdout.write, err = process.stderr.write; let out = "";
    process.stdout.write = (t) => { out += t; return true; }; process.stderr.write = () => true;
    try {
      assert.equal(await runStats(["--self-filed", "--repo", "o/r", "--since", "2026-10-08"], { gh: async () => JSON.stringify(ISSUES) }), 0);
      assert.match(out, /self-filed issues, o\/r since 2026-10-08: 20 new issues/);
      out = "";
      assert.equal(await runStats(["--self-filed", "--repo", "o/r", "--json"], { gh: async () => JSON.stringify(ISSUES) }), 0);
      assert.equal(JSON.parse(out).query.self_filed.target, 0.15);
      assert.equal(await runStats(["--self-filed", "--repo", "o/r"], { gh: async () => "not json" }), 1);
    } finally { process.stdout.write = write; process.stderr.write = err; }
  });
});
