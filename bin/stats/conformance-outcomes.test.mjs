// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conformanceOutcomes, gatherConformanceOutcomes, renderConformanceOutcomes, replayPrs, renderReplay, prsOfPage, joinedNumbers, wilson, cites, reverts, sameHunks, OUTCOME_INSUFFICIENT, HIGHER, NOT_HIGHER, DEFAULT_OUTCOME_MIN_N } from "./conformance-outcomes.mjs";
import { conformanceVerdicts, verdictOf } from "./query.mjs";
import { summariseLog } from "./local-source.mjs";
import { buildReport, parseArgs, runStats } from "./index.mjs";

const DAY = 86400000;
const T0 = Date.parse("2026-10-01T00:00:00Z");
const at = (d) => new Date(T0 + d * DAY).toISOString();
const NOW = T0 + 60 * DAY;
const pr = (number, d, extra = {}) => ({ repo: "o/r", number, title: `feat: change ${number}`, body: "", mergedAt: at(d), mergeSha: `sha${number}`, closingIssues: [], ...extra });
const verdicts = (rows) => conformanceVerdicts({ records: rows.map(([prN, would, failures = [], mode = "shadow"]) => [
  { event: "run_terminal", issue: prN + 1000, pr: prN, reason: "merged", conformance_mode: mode, ...(would ? { shadow_would: would } : {}), ts: at(0) },
  ...(failures.length ? [{ event: "conformance_shadow", issue: prN + 1000, would, failures, ts: at(-0.1) }] : []),
]).flat() });

describe("conformance outcomes: join (#5210 R1)", () => {
  it("joins each merged lane PR to its last verdict, mode and the four signals inside the window only", () => {
    const prs = [
      pr(1, 0, { closingIssues: [{ number: 1001, reopenedAt: [at(3)] }] }), // reopened in window
      pr(2, 0), pr(3, 0), pr(4, 0), pr(5, 0),
      pr(6, 0, { closingIssues: [{ number: 1006, reopenedAt: [at(9)] }] }), // reopened outside the 7d window
      pr(20, 1, { title: "Revert \"feat: change 2\"", body: "Reverts o/r#2" }),
      pr(21, 2, { title: "fix: handle null", body: "Fixes a regression from #3" }),
      pr(22, 3, { title: "chore: tidy", body: "review-finding of PR #4" }),
      pr(23, 4, { title: "fix: loop bound", body: "unrelated" }), // same-hunks fix for #5 via git
      pr(24, 12, { title: "fix: late", body: "fix for #6" }), // outside window
      pr(25, 1, { title: "docs: mention #5", body: "" }), // a mention, not a cause
    ];
    const v = verdicts([[1, "conforms"], [2, "nonconforming", ["omission"]], [3, "conforms", [], "enforce"], [4, "nonconforming", ["scope_creep", "omission"]], [5, "conforms"], [6, "conforms"]]);
    const git = { oldRanges: (sha) => (sha === "sha23" ? [{ file: "a.js", start: 1, end: 2 }] : []), blame: (rev, file) => (rev === "sha23^" && file === "a.js" ? ["sha5"] : []) };
    const r = conformanceOutcomes({ prs, verdicts: v, now: NOW, git, minN: 1 });
    const by = Object.fromEntries(r.prs.map((x) => [x.pr, x]));
    assert.equal(r.sources.lane_prs, 6);
    assert.equal(r.sources.unjoined, 6, "PRs without a verdict are not lane PRs");
    assert.deepEqual(by[1].signals, { reverted: false, reopened: true, cited: false, same_hunks: false });
    assert.equal(by[2].signals.reverted, true);
    assert.deepEqual(by[2].kinds, ["omission"]);
    assert.equal(by[3].signals.cited, true);
    assert.equal(by[3].mode, "enforce");
    assert.equal(by[4].signals.cited, true, "review-finding of PR #N");
    assert.deepEqual(by[4].kinds, ["omission", "scope_creep"]);
    assert.equal(by[5].signals.same_hunks, true);
    assert.equal(by[5].signals.cited, false, "a docs mention is not a cause");
    assert.deepEqual(by[6].signals, { reverted: false, reopened: false, cited: false, same_hunks: false }, "signals after the window do not count");
    assert.equal(by[6].defect, false);
    assert.equal(by[1].defect, true);
  });

  it("the latest verdict wins across batch rows, run logs and telemetry; a shadow run with no verdict has none", () => {
    const v = conformanceVerdicts({
      batchRows: [{ issue: 7, pr: 70, outcome: "merged", conformance: { mode: "shadow", would: "nonconforming", kinds: ["omission"] }, ts: "2026-10-01T00:00:00Z" }],
      runs: [{ finished: true, issue: 7, pr: 70, reason: "merged", conformanceMode: "shadow", shadowWould: "conforms", conformanceFailures: [], endTs: "2026-10-02T00:00:00Z" }],
      records: [{ event: "run_terminal", issue: 8, pr: 80, reason: "merged", conformance_mode: "shadow", ts: "2026-10-02T00:00:00Z" }],
    });
    assert.equal(v.get("pr:70").state, "conforms");
    assert.equal(v.get("pr:70").source, "local");
    assert.equal(v.get("pr:80"), undefined);
    assert.deepEqual(verdictOf({ mode: "enforce", merged: true }), { mode: "enforce", state: "conforms", kinds: [] });
  });

  it("a PR whose window is still open is pending, not counted", () => {
    const r = conformanceOutcomes({ prs: [pr(1, 58)], verdicts: verdicts([[1, "conforms"]]), now: NOW, minN: 1 });
    assert.equal(r.sources.pending, 1);
    assert.equal(r.sources.lane_prs, 0);
  });

  it("run logs expose pr, mode and the last verdict's failure codes", () => {
    const s = summariseLog([{ event: "RUN_START", issue: 9, ts: at(0) }, { event: "CONFORMANCE", round: 1, state: "nonconforming", failures: ["regression"], mode: "shadow" },
      { event: "CONFORMANCE_SHADOW", would: "nonconforming", failures: ["omission"] }, { event: "RUN_TERMINAL", reason: "merged", pr: 90, conformance_mode: "shadow", shadow_would: "nonconforming", ts: at(1) }]);
    assert.equal(s.pr, 90);
    assert.equal(s.conformanceMode, "shadow");
    assert.deepEqual(s.conformanceFailures, ["omission"]);
  });

  it("signal helpers", () => {
    assert.equal(reverts({ title: "Revert \"x\"", body: "Reverts o/r#12" }, { number: 12 }, "o/r"), true);
    assert.equal(reverts({ title: "fix: x", body: "Reverts o/r#12" }, { number: 12 }, "o/r"), false);
    assert.equal(cites({ title: "fix(x): y", body: "Closes #120" }, { number: 12, closingIssues: [] }), false, "#120 is not #12");
    assert.equal(cites({ title: "fix(x): y (#12)", body: "" }, { number: 12, closingIssues: [] }), true);
    assert.equal(sameHunks({ mergeSha: "a" }, [{ mergeSha: "b" }], null), null, "no git: unresolved");
    assert.equal(sameHunks({ mergeSha: "a" }, [], null), false, "no later fix: false");
    assert.equal(sameHunks({ mergeSha: "a" }, [{ mergeSha: "b" }], { oldRanges: () => null, blame: () => [] }), null);
  });
});

describe("conformance outcomes: 2x2 and conclusion (#5210 R2)", () => {
  const many = (start, n, would, defects, failures = []) => Array.from({ length: n }, (_, i) => {
    const num = start + i;
    return { p: pr(num, 0, i < defects ? { closingIssues: [{ number: num + 1000, reopenedAt: [at(1)] }] } : {}), v: [num, would, failures] };
  });
  it("defaults to min n 20 per cell and prints insufficient data below it", () => {
    const xs = [...many(1, 19, "nonconforming", 10, ["omission"]), ...many(100, 30, "conforms", 1)];
    const r = conformanceOutcomes({ prs: xs.map((x) => x.p), verdicts: verdicts(xs.map((x) => x.v)), now: NOW });
    assert.equal(r.min_n, DEFAULT_OUTCOME_MIN_N);
    assert.equal(r.min_n, 20);
    assert.equal(r.overall.nonconforming.n, 19);
    assert.equal(r.overall.nonconforming.rate, null);
    assert.equal(r.overall.nonconforming.insufficient, true);
    assert.equal(r.conclusion, OUTCOME_INSUFFICIENT);
    const text = renderConformanceOutcomes(r);
    assert.match(text, /\| all \| 10\/19 n\/a \|/);
    assert.match(text.split("\n").at(-1), /^conclusion: insufficient data$/);
  });
  it("per repo, per mode and per failure kind with n, rate and a Wilson interval; higher when the intervals separate", () => {
    const xs = [...many(1, 25, "nonconforming", 15, ["omission"]), ...many(30, 22, "nonconforming", 1, ["scope_creep"]), ...many(100, 40, "conforms", 2)];
    const r = conformanceOutcomes({ prs: xs.map((x) => x.p), verdicts: verdicts(xs.map((x) => x.v)), now: NOW });
    const o = r.repos["o/r"];
    assert.deepEqual([o.by_kind.omission.nonconforming.n, o.by_kind.omission.nonconforming.defects, o.by_kind.omission.nonconforming.rate], [25, 15, 0.6]);
    assert.deepEqual(o.by_kind.omission.nonconforming.interval, wilson(15, 25));
    assert.equal(o.by_kind.omission.conclusion, HIGHER);
    assert.equal(o.by_kind.scope_creep.conclusion, NOT_HIGHER);
    assert.equal(o.overall.conforming.n, 40);
    assert.ok(o.by_mode.shadow);
    assert.equal(r.conclusion, HIGHER);
    const text = renderConformanceOutcomes(r);
    assert.match(text, /## o\/r/);
    assert.match(text, /\| kind omission \| 15\/25 60% \[/);
    assert.equal(text.split("\n").at(-1), `conclusion: ${HIGHER}`);
  });
  it("wilson matches the closed form and stays inside [0, 1]", () => {
    assert.deepEqual(wilson(0, 10), [0, 0.2775]);
    assert.deepEqual(wilson(10, 10), [0.7225, 1]);
    assert.equal(wilson(0, 0), null);
  });
});

/** gh stub: `api graphql` search pages over `total` merged PRs; records every call. */
function graphqlGh(total, calls = []) {
  return async (args) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "graphql") {
      const after = args.find((a) => a.startsWith("after="));
      const start = after ? Number(after.slice(6)) : 0;
      const nodes = Array.from({ length: Math.min(100, total - start) }, (_, i) => ({ number: start + i + 1, title: "t", body: "", mergedAt: at(0), mergeCommit: { oid: `s${start + i}` },
        repository: { nameWithOwner: "o/r" }, closingIssuesReferences: { nodes: [] } }));
      return JSON.stringify({ data: { search: { pageInfo: { hasNextPage: start + 100 < total, endCursor: String(start + 100) }, nodes } } });
    }
    return "[]";
  };
}
const isWrite = (args) => args.some((a) => /^(-X|--method)$/.test(a)) || args.some((a) => /^query=\s*mutation\b/.test(a)) || ["comment", "edit", "create", "close", "reopen", "merge"].includes(args[1]);

describe("conformance outcomes: read only (#5210 R3)", () => {
  it("one GraphQL call per 100 PRs and no write", async () => {
    const calls = [];
    const out = await gatherConformanceOutcomes({ repo: "o/r", gh: graphqlGh(250, calls), since: at(0), now: NOW });
    assert.equal(out.prs.length, 250);
    assert.equal(out.graphqlCalls, 3);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((a) => a[0] === "api" && a[1] === "graphql" && !isWrite(a)));
    assert.ok(calls[0].includes("q=repo:o/r is:pr is:merged merged:>=2026-10-01"));
  });
  it("runStats --conformance-outcomes --json: GitHub reads only, the report under query.conformance_outcomes", async () => {
    const calls = [];
    const gh = graphqlGh(120, calls);
    let out = "";
    const w = process.stdout.write;
    process.stdout.write = (t) => { out += t; return true; };
    let code;
    try {
      code = await runStats(["--conformance-outcomes", "--repo", "o/r", "--since", "2026-10-01", "--window-days", "5", "--json", "--no-cache", "--no-local"],
        { gh, env: { HOME: "/nonexistent" }, now: () => NOW, git: null, releaseTimes: [], onProgress: () => {} });
    } finally { process.stdout.write = w; }
    assert.equal(code, 0);
    const rep = JSON.parse(out).query.conformance_outcomes;
    assert.equal(rep.window_days, 5);
    assert.equal(rep.sources.merged_prs, 120);
    assert.equal(rep.sources.graphql_calls, 2);
    assert.equal(rep.conclusion, OUTCOME_INSUFFICIENT);
    assert.equal(calls.filter((a) => a[1] === "graphql").length, 2);
    assert.ok(calls.every((a) => !isWrite(a)), "no GitHub write");
  });
  it("buildReport bounds the crawl and uses min n 20 unless --min-n is passed", async () => {
    const r = await buildReport({ ...parseArgs(["--conformance-outcomes", "--min-n", "3"]), repo: "o/r", cache: false, local: false },
      { gh: graphqlGh(0), env: {}, now: () => NOW, git: null, releaseTimes: [], onProgress: () => {} });
    assert.equal(r.query.conformance_outcomes.min_n, 3);
  });
  it("a 502 at first=100 retries the same page smaller and completes (#5363)", async () => {
    const calls = [];
    const inner = graphqlGh(150, calls);
    const gh = async (args) => {
      if (args.includes("first=100")) throw new Error("gh: HTTP 502: Bad Gateway");
      return inner(args);
    };
    const out = await gatherConformanceOutcomes({ repo: "o/r", gh, since: at(0), now: NOW });
    assert.ok(out.prs.length > 0);
    assert.ok(calls.some((a) => a.includes("first=50")));
  });
  it("a persistent 502 fails naming a narrower --since (#5363)", async () => {
    await assert.rejects(gatherConformanceOutcomes({ repo: "o/r", gh: async () => { throw new Error("HTTP 502"); }, since: at(0), now: NOW }), /narrower --since/);
  });
  it("flag parsing", () => {
    assert.equal(parseArgs(["--conformance-outcomes"]).conformanceOutcomes, true);
    assert.equal(parseArgs(["--conformance-outcomes", "--window-days", "14"]).windowDays, 14);
    assert.throws(() => parseArgs(["--window-days", "7"]), /needs --conformance-outcomes/);
    assert.throws(() => parseArgs(["--conformance-outcomes", "--window-days", "0"]), /positive integer/);
  });
});

describe("conformance outcomes: surfaces and replay (#5283)", () => {
  const stub = (files) => files.map((f) => (f.includes("migrations/") ? "domain:database" : f.includes("auth") ? "domain:auth" : f.endsWith(".tsx") ? "domain:frontend" : null)).filter(Boolean).sort();
  const lane = (n, d, files) => pr(n, d, { files });
  it("by_surface compares nonconforming vs conforming among PRs touching that surface; n/a under min n", () => {
    const prs = [lane(1, 0, ["db/migrations/0543.sql"]), lane(2, 0, ["db/migrations/0544.sql"]), lane(3, 0, ["web/a.tsx"]), pr(4, 0)];
    const v = verdicts([[1, "nonconforming", ["conformance.unimplemented"]], [2, "conforms"], [3, "conforms"], [4, "conforms"]]);
    const r = conformanceOutcomes({ prs, verdicts: v, minN: 1, now: NOW, surfacesOf: stub });
    const s = r.repos["o/r"].by_surface;
    assert.deepEqual(Object.keys(s).sort(), ["domain:database", "domain:frontend"]);
    assert.equal(s["domain:database"].nonconforming.n, 1);
    assert.equal(s["domain:database"].conforming.n, 1);
    assert.match(renderConformanceOutcomes(r), /surface domain:database/);
    assert.equal(conformanceOutcomes({ prs, verdicts: v, minN: 5, now: NOW, surfacesOf: stub }).repos["o/r"].by_surface["domain:database"].nonconforming.rate, null);
  });
  it("replay: enforced when a configured surface is hit and the verdict is nonconforming, flagged when it would pass, none otherwise", () => {
    const prs = [lane(1, 0, ["db/migrations/0543.sql"]), lane(2, 0, ["web/(site)/layout.tsx"]), lane(3, 0, ["docs/x.md"])];
    const v = verdicts([[1, "nonconforming", ["conformance.unimplemented"]], [2, "conforms"], [3, "conforms"]]);
    const r = replayPrs({ prs, verdicts: v, numbers: [1, 2, 3, 9], enforceDomains: "database,frontend", surfacesOf: stub });
    assert.deepEqual(r.prs.map((x) => x.outcome), ["enforced", "flagged", "none"]);
    assert.deepEqual(r.missing, [9]);
    assert.equal(replayPrs({ prs, verdicts: v, numbers: [3], riskPaths: "docs/**", surfacesOf: stub }).prs[0].outcome, "flagged");
    assert.match(renderReplay(r), /\| #2 \| shadow \| conforms \| domain:frontend \| flagged \|/);
  });
  it("buildReport wires --replay into the report (JSON) and reports PRs outside the fetched range as missing", async () => {
    const r = await buildReport({ ...parseArgs(["--conformance-outcomes", "--replay", "1,99", "--enforce-domains", "frontend"]), repo: "o/r", cache: false, local: false },
      { gh: graphqlGh(0), env: {}, now: () => NOW, git: null, releaseTimes: [], onProgress: () => {} });
    const rp = r.query.conformance_outcomes.replay;
    assert.deepEqual(rp.enforce_domains, ["frontend"]);
    assert.ok(rp.missing.includes(99));
  });
  it("prsOfPage keeps changed file paths; parseArgs validates --replay and its companions", () => {
    const data = { data: { search: { nodes: [{ number: 5, mergedAt: at(0), files: { nodes: [{ path: "a.ts" }] } }] } } };
    assert.deepEqual(prsOfPage(data, "o/r")[0].files, ["a.ts"]);
    assert.deepEqual(parseArgs(["--conformance-outcomes", "--replay", "1,2", "--enforce-domains", "auth"]).replay, [1, 2]);
    assert.throws(() => parseArgs(["--replay", "1"]), /need --conformance-outcomes/);
    assert.throws(() => parseArgs(["--conformance-outcomes", "--enforce-domains", "auth"]), /need --replay/);
    assert.throws(() => parseArgs(["--conformance-outcomes", "--replay", "x"]), /comma list/);
  });
});

describe("joinedNumbers (#5363)", () => {
  it("lists each merged PR and its closing issues once, sorted", () => {
    assert.deepEqual(joinedNumbers([{ number: 9, closingIssues: [{ number: 3 }, { number: 5 }] }, { number: 4, closingIssues: [{ number: 3 }] }]), [3, 4, 5, 9]);
    assert.deepEqual(joinedNumbers(), []);
  });
});
