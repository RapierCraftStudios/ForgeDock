// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { prefilterIssue, makePrefilter, formatPrefilterSummary, claimsFix, ciFailureRun, namedPaths, DEFAULT_PREFILTER_MODEL } from "./prefilter.mjs";
import { parsePrefilterVerdict, prefilterPrompt } from "./prompts.mjs";
import { orchestrate, formatTable } from "./orchestrate.mjs";
import { triageFromCli } from "../engine-cli.mjs";

const fence = (o) => "```json\n" + JSON.stringify(o) + "\n```";

/** Fake GitHub + git for one repo `o/r`, lane `staging`. */
function world(o = {}) {
  const w = { comments: [], closed: [], labels: [], runner: [], lanes: [], gitCalls: [],
    issues: o.issues ?? {}, prs: o.prs ?? [], commits: o.commits ?? "", paths: new Set(o.paths ?? []), runs: o.runs ?? {}, workflowRuns: o.workflowRuns ?? {}, shaRuns: o.shaRuns ?? {},
    verdict: o.verdict ?? null };
  w.io = {
    gh: async (a) => {
      const k = a.slice(0, 2).join(" ");
      if (k === "issue view") { const n = Number(a[2]); return JSON.stringify({ number: n, state: "OPEN", labels: [], title: "", body: "", ...w.issues[n] }); }
      if (k === "search prs") return JSON.stringify(w.prs);
      if (k === "repo view") return "main\n";
      if (a[0] === "api") {
        const m = /actions\/runs\/(\d+)$/.exec(a[1]);
        if (m) return JSON.stringify(w.runs[m[1]]);
        const wf = /actions\/workflows\/(\d+)\/runs\?branch=([^&]+)/.exec(a[1]);
        if (wf) return JSON.stringify({ workflow_runs: w.workflowRuns[`${wf[1]}:${decodeURIComponent(wf[2])}`] ?? [] });
        const at = /actions\/workflows\/\d+\/runs\?head_sha=([^&]+)/.exec(a[1]);
        if (at) { w.shaQueries = (w.shaQueries ?? 0) + 1; return JSON.stringify({ workflow_runs: w.shaRuns[at[1]] ?? [] }); }
      }
      if (k === "issue comment") { w.comments.push([Number(a[2]), a[a.indexOf("--body") + 1]]); return ""; }
      if (k === "issue close") { w.closed.push([Number(a[2]), a[a.indexOf("--reason") + 1]]); return ""; }
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
    git: async (a) => {
      w.gitCalls.push(a);
      if (a[0] === "log") return w.commits;
      if (a[0] === "cat-file") { if (w.paths.has(a[2].replace(/^origin\/staging:/, ""))) return ""; throw new Error("missing"); }
      if (a[0] === "fetch") return "";
      if (a[0] === "ls-remote") return a.at(-1) === "refs/heads/staging" ? "abc\trefs/heads/staging\n" : "";
      throw new Error(`unexpected git ${a.join(" ")}`);
    },
    runner: async (args) => { w.runner.push(args); return { text: w.verdict ? fence(w.verdict) : "no json", costUsd: 0.02 }; },
    transitionLabel: async (n, s) => { w.labels.push([n, s]); },
  };
  return w;
}
const pf = (w, issue, extra = {}) => prefilterIssue({ issue, repo: "o/r", lane: "staging", cwd: "/repo", io: w.io, ...extra });

describe("pre-filter (#4123)", () => {
  it("claimsFix matches closing keywords and lean-style (#N) titles, not bare mentions or longer numbers", () => {
    assert.ok(claimsFix("Fixes #12", 12));
    assert.ok(claimsFix("this closes o/r#12.", 12));
    assert.ok(claimsFix("fix(core): guard null (#12)", 12));
    assert.ok(!claimsFix("see #12 for context", 12));
    assert.ok(!claimsFix("Fixes #123", 12));
  });

  it("an issue with a merged PR that claims to fix it is validated without a lane and closed with the evidence", async () => {
    const w = world({ issues: { 12: { title: "foo breaks", body: "foo crashes on null" } },
      prs: [{ number: 90, title: "fix: guard foo", body: "Fixes #12", url: "https://github.com/o/r/pull/90" }, { number: 91, title: "docs", body: "see #12" }],
      verdict: { verdict: "ALREADY-FIXED", summary: "guard added in PR #90", evidence: ["src/foo.js:3 null guard"] } });
    const r = await pf(w, 12);
    assert.equal(r.closed, true); assert.equal(r.kind, "validated"); assert.equal(r.cost_usd, 0.02);
    assert.equal(w.runner.length, 1);
    const call = w.runner[0];
    assert.equal(call.model, DEFAULT_PREFILTER_MODEL); assert.equal(call.readOnly, true); assert.equal(call.resume, null); assert.equal(call.cwd, "/repo");
    assert.match(call.prompt, /merged PR #90/); assert.doesNotMatch(call.prompt, /PR #91/);
    assert.deepEqual(w.closed, [[12, "not planned"]]);
    assert.deepEqual(w.labels, [[12, "invalid"]]);
    assert.match(w.comments[0][1], /FORGE:PREFILTER/); assert.match(w.comments[0][1], /src\/foo\.js:3 null guard/); assert.match(w.comments[0][1], /PR #90/);
  });

  it("a candidate the validator CONFIRMS (or answers without evidence) is not closed", async () => {
    const mk = (verdict) => world({ issues: { 12: { body: "x" } }, prs: [{ number: 90, title: "fix (#12)", body: "" }], verdict });
    for (const v of [{ verdict: "CONFIRMED", evidence: ["src/foo.js:3 still derefs"] }, { verdict: "ALREADY-FIXED", evidence: [] }, null]) {
      const w = mk(v);
      const r = await pf(w, 12);
      assert.equal(r.closed, false); assert.equal(r.candidate, true);
      assert.equal(w.closed.length, 0); assert.equal(w.comments.length, 0);
    }
  });

  it("lane commits whose subject ends (#N) are a signal; merge commits and other numbers are not", async () => {
    const w = world({ issues: { 12: { body: "x" } }, commits: "aaaaaaaaaaaaaaaa\tfix(x): guard (#12)\nbbbbbbbbbbbb\tMerge pull request #12 from o/b\ncccccccccccc\tfeat: y (#120)\n",
      verdict: { verdict: "ALREADY-FIXED", evidence: ["a.js:1"] } });
    const r = await pf(w, 12);
    assert.equal(r.closed, true);
    assert.match(w.runner[0].prompt, /commit aaaaaaaaaaaa/);
    assert.doesNotMatch(w.runner[0].prompt, /bbbbbbbbbbbb|cccccccccccc/);
  });

  it("an auto-filed CI-failure issue whose workflow is green again is closed with the run link, without a model call", async () => {
    const body = "Workflow `executable-bit-check` failed on push to staging.\nRun: https://github.com/o/r/actions/runs/500";
    const w = world({ issues: { 34: { title: "executable-bit-check failed on push to staging", body } },
      runs: { 500: { id: 500, workflow_id: 7, name: "executable-bit-check", head_branch: "staging", created_at: "2026-10-10T00:00:00Z", html_url: "https://github.com/o/r/actions/runs/500" } },
      workflowRuns: { "7:staging": [{ id: 600, conclusion: "success", created_at: "2026-10-12T00:00:00Z", html_url: "https://github.com/o/r/actions/runs/600", head_sha: "abcdef1234567890" }] } });
    const r = await pf(w, 34);
    assert.equal(r.closed, true); assert.equal(r.kind, "ci-green");
    assert.equal(w.runner.length, 0);
    assert.match(w.comments[0][1], /actions\/runs\/600/); assert.match(w.comments[0][1], /actions\/runs\/500/);
    assert.deepEqual(w.closed, [[34, "not planned"]]);
  });

  it("#4305 the CI-green shortcut is skipped for intermittent, reopened and same-SHA-flaky CI failures", async () => {
    const link = "Run: https://github.com/o/r/actions/runs/500";
    const green = (issue, extra = {}) => world({ issues: { 34: { title: "shell-compat failed on staging", body: `Workflow failed.\n${link}`, ...issue } },
      runs: { 500: { id: 500, workflow_id: 7, name: "shell-compat", head_branch: "staging", head_sha: "1111111111111111", created_at: "2026-10-10T00:00:00Z", html_url: "https://github.com/o/r/actions/runs/500" } },
      workflowRuns: { "7:staging": [{ id: 600, conclusion: "success", created_at: "2026-10-12T00:00:00Z", html_url: "https://github.com/o/r/actions/runs/600", head_sha: "8d9f6ba0aaaaaaaa" }] }, ...extra });
    const bot = { author: { login: "rapiercraft-forgedock[bot]" }, authorAssociation: "NONE", body: "<!-- FORGE:PREFILTER -->\n<!-- FORGE:VALIDATE -->\n## Pre-filter: CI failure no longer reproduces" };
    const stranger = { author: { login: "someone" }, authorAssociation: "NONE", body: bot.body };
    const cases = [
      ["intermittent wording", green({ body: `\`a.test.sh\` fails intermittently on macOS.\n${link}` }), /issue says the failure is intermittent/],
      ["flaky label", green({ labels: [{ name: "flaky" }] }), /flaky label/],
      ["reopened after a pre-filter close", green({ comments: [bot] }), /reopened after a pre-filter close/],
      ["failed and passed at the same SHA", green({}, { shaRuns: { "8d9f6ba0aaaaaaaa": [{ id: 601, conclusion: "failure" }, { id: 600, conclusion: "success" }] } }), /failed and passed at 8d9f6ba0aaaa/],
    ];
    for (const [name, w, why] of cases) {
      const r = await pf(w, 34);
      assert.equal(r.closed, false, name); assert.notEqual(r.kind, "ci-green", name);
      assert.deepEqual(w.closed, [], name); assert.deepEqual(w.comments, [], name); assert.equal(w.runner.length, 0, name);
      assert.match(r.detail, /^skipped CI-green shortcut: flaky \(/, name); assert.match(r.detail, why, name);
      assert.match(r.detail, /no already-fixed signal$/, name);
    }
    // wording and the reopen marker need no runs lookup; an untrusted marker comment is no reopen, and a green-only SHA still closes
    const quiet = green({ body: `fails intermittently ${link}` });
    await pf(quiet, 34); assert.equal(quiet.shaQueries ?? 0, 0);
    const forged = green({ comments: [stranger] }, { shaRuns: { "8d9f6ba0aaaaaaaa": [{ id: 600, conclusion: "success" }] } });
    const r = await pf(forged, 34);
    assert.equal(r.kind, "ci-green"); assert.equal(forged.shaQueries, 1);
    // an unreadable same-SHA lookup is no proof either: no shortcut
    const down = green();
    const gh0 = down.io.gh; down.io.gh = async (a) => (/head_sha=/.test(a[1] ?? "") ? (() => { throw new Error("HTTP 502"); })() : gh0(a));
    assert.equal((await pf(down, 34)).closed, false);
  });

  it("a CI-failure issue whose workflow is still red (or whose latest run is the failing one) goes to a lane", async () => {
    const base = { issues: { 34: { title: "ci failed", body: "https://github.com/o/r/actions/runs/500" } },
      runs: { 500: { id: 500, workflow_id: 7, head_branch: "staging", created_at: "2026-10-10T00:00:00Z" } } };
    for (const latest of [{ id: 600, conclusion: "failure", created_at: "2026-10-12T00:00:00Z" }, { id: 500, conclusion: "success", created_at: "2026-10-10T00:00:00Z" }]) {
      const w = world({ ...base, workflowRuns: { "7:staging": [latest] } });
      const r = await pf(w, 34);
      assert.equal(r.closed, false); assert.equal(w.closed.length, 0);
    }
  });

  it("every named path missing on the lane is a candidate; any surviving path is not", async () => {
    assert.deepEqual(namedPaths("see `src/old/foo.js:12` and lib/bar.py, not https://x.io/a/b.js <!-- FORGE:STATE {\"a\":\"c/d.js\"} -->"), ["src/old/foo.js", "lib/bar.py"]);
    // #4298: the scan-based noComments: a `--!>` closer ends a comment and an unclosed one runs to the end (the old
    // one-pass regex kept both hidden paths).
    assert.deepEqual(namedPaths("fix lib/a.js <!-- x/hidden.js --!> visible/e.js and <!-- unclosed c/d.js"), ["lib/a.js", "visible/e.js"]);
    const gone = world({ issues: { 5: { body: "crash in src/old/foo.js:12" } }, verdict: { verdict: "INVALID", evidence: ["src/old/foo.js removed in abc123"] } });
    assert.equal((await pf(gone, 5)).closed, true);
    assert.match(gone.runner[0].prompt, /do not exist on origin\/staging: src\/old\/foo\.js/);
    const kept = world({ issues: { 5: { body: "crash in src/old/foo.js:12 and src/new.js/x.ts" } }, paths: ["src/old/foo.js"] });
    const r = await pf(kept, 5);
    assert.equal(r.candidate, false); assert.equal(kept.runner.length, 0);
  });

  it("is fail-open: no signal, a runner error, a held lease or a gh failure never close and never throw", async () => {
    const quiet = world({ issues: { 1: { body: "plain feature request" } } });
    assert.equal((await pf(quiet, 1)).candidate, false); assert.equal(quiet.runner.length, 0);
    const boom = world({ issues: { 2: { body: "x" } }, prs: [{ number: 9, title: "Fixes #2", body: "" }] });
    boom.io.runner = async () => { throw new Error("usage limit"); };
    const r = await pf(boom, 2);
    assert.equal(r.closed, false); assert.match(r.detail, /validation failed/);
    const leased = world({ issues: { 3: { body: "x" } }, prs: [{ number: 9, title: "Fixes #3", body: "" }], verdict: { verdict: "ALREADY-FIXED", evidence: ["a:1"] } });
    leased.io.projector = { readState: async () => ({ lease: { by: "core_1", until: Date.now() + 60000 } }) };
    assert.equal((await pf(leased, 3)).closed, false); assert.equal(leased.runner.length, 0);
    const down = world(); down.io.gh = async () => { throw new Error("HTTP 502"); };
    assert.match((await pf(down, 4)).detail, /pre-filter error/);
  });

  it("--dry-run reports candidates without a model call or close", async () => {
    const w = world({ issues: { 12: { body: "x" } }, prs: [{ number: 90, title: "Fixes #12", body: "" }], verdict: { verdict: "ALREADY-FIXED", evidence: ["a:1"] } });
    const r = await pf(w, 12, { dryRun: true });
    assert.equal(r.candidate, true); assert.equal(r.closed, false);
    assert.equal(w.runner.length, 0); assert.equal(w.closed.length, 0); assert.equal(w.comments.length, 0);
  });

  it("parsePrefilterVerdict reads fenced or bare JSON and rejects unknown verdicts", () => {
    assert.deepEqual(parsePrefilterVerdict(fence({ verdict: "already-fixed", summary: "s", evidence: ["a:1", " "] })), { verdict: "ALREADY-FIXED", summary: "s", evidence: ["a:1"] });
    assert.equal(parsePrefilterVerdict('{"verdict":"MAYBE"}'), null);
    assert.match(prefilterPrompt({ issue: { number: 1, title: "t", body: "b" }, lane: "main", signals: {} }), /\(none\)/);
  });
});

describe("orchestrate with the pre-filter (#4123)", () => {
  it("an issue the pre-filter closed never starts a lane; the rest do; the report shows count and spend avoided", async () => {
    const lanes = [];
    const rows = await orchestrate({ issues: [1, 2, 3], parallel: 2, readBody: async () => "",
      prefilter: async (n) => (n === 1 ? { issue: 1, closed: true, kind: "validated", candidate: true, cost_usd: 0.02, detail: "already-fixed (PR #9)" }
        : n === 2 ? { issue: 2, closed: false, candidate: true, cost_usd: 0.02, detail: "confirmed: lane" } : (() => { throw new Error("boom"); })()),
      runOne: async (n) => { lanes.push(n); return { terminalReason: n === 3 ? "invalid" : "merged", pr: n === 2 ? 102 : null, cost_usd: n === 3 ? 0.8 : 1.5 }; } });
    assert.deepEqual(lanes.sort(), [2, 3]);
    assert.deepEqual(rows.map((r) => r.outcome), ["invalid", "merged", "invalid"]);
    assert.equal(rows[0].cost_usd, 0.02); assert.equal(rows[1].cost_usd, 1.52);
    assert.match(formatTable(rows), /#1\s+invalid \(pre-filter\)/);
    const line = formatPrefilterSummary(rows);
    assert.match(line, /2 checked, 2 candidate\(s\), 1 closed without a lane \(0 CI green, 1 validated\)/);
    assert.match(line, /validation \$0\.04, spend avoided ~\$0\.76 \(batch invalid-lane average \$0\.80\/lane\)/);
    assert.equal(formatPrefilterSummary([{ issue: 1, outcome: "merged" }]), "");
  });

  it("a dependent of a pre-filter-closed issue is not skipped", async () => {
    const rows = await orchestrate({ issues: [1, 2], readBody: async (n) => (n === 2 ? "**Depends on**: #1" : ""),
      prefilter: makePrefilter({ repo: "o/r", lane: "staging", cwd: "/repo", io: world({ issues: { 1: { body: "x" } }, prs: [{ number: 9, title: "Fixes #1", body: "" }], verdict: { verdict: "ALREADY-FIXED", evidence: ["a:1"] } }).io }),
      runOne: async () => ({ terminalReason: "merged", pr: 5, cost_usd: 1 }) });
    assert.deepEqual(rows.map((r) => r.outcome), ["invalid", "merged"]);
  });

  it("a dependency-open issue requeued by #4124 is pre-filtered once, and its validation cost counted once", async () => {
    const checks = [];
    let first = true;
    const rows = await orchestrate({ issues: [2], readBody: async () => "",
      prefilter: async (n) => { checks.push(n); return { issue: n, closed: false, candidate: true, cost_usd: 0.02, detail: "confirmed: lane" }; },
      runOne: async (n) => (n === 2 && first ? ((first = false), { terminalReason: "dependency-open", dependencies: [1] }) : { terminalReason: "merged", pr: 10 + n, cost_usd: 1 }) });
    assert.deepEqual(checks, [2, 1]);
    assert.deepEqual(rows.map((r) => [r.issue, r.outcome, r.cost_usd]), [[2, "merged", 1.02], [1, "merged", 1.02]]);
  });

  it("forgedock triage closes the fixed issue and prints the issues that still need a lane", async () => {
    const w = world({ issues: { 12: { body: "x" }, 13: { body: "y" } }, prs: [{ number: 90, title: "Fixes #12", body: "" }], verdict: { verdict: "ALREADY-FIXED", evidence: ["a:1"] } });
    const logs = []; const l = console.log; console.log = (s) => logs.push(String(s));
    let res;
    try { res = await triageFromCli(["12", "#13", "--repo", "o/r", "--lane", "staging"], { leanIo: w.io }); } finally { console.log = l; }
    assert.deepEqual(res.lanes, [13]);
    assert.equal(logs.at(-1), "lanes: #13");
    assert.ok(logs.some((s) => /^pre-filter: 2 checked, 1 candidate\(s\), 1 closed/.test(s)));
    assert.deepEqual(w.closed, [[12, "not planned"]]);
    await assert.rejects(triageFromCli([], {}), /usage/);
  });

  it("#4141 triage runs a bounded parallel pool, fetches each lane once, and prints rows in input order", async () => {
    const issues = {}; for (let n = 1; n <= 6; n++) issues[n] = { body: `b${n}` };
    const w = world({ issues, prs: [], verdict: { verdict: "VALID", evidence: [] } });
    let live = 0, peak = 0, fetches = 0;
    const gh0 = w.io.gh, git0 = w.io.git;
    w.io.gh = async (a, o) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5 + (Number(a.find((x) => /^\d+$/.test(x))) || 0) % 3)); live--; return gh0(a, o); };
    w.io.git = async (a, o) => { if (a[0] === "fetch") fetches++; return git0(a, o); };
    const logs = []; const l = console.log; console.log = (s) => logs.push(String(s));
    let res;
    try { res = await triageFromCli(["1", "2", "3", "4", "5", "6", "--repo", "o/r", "--lane", "staging", "--parallel", "3"], { leanIo: w.io }); } finally { console.log = l; }
    const order = logs.filter((s) => /^#\d+ → /.test(s)).map((s) => Number(s.slice(1, s.indexOf(" "))));
    assert.deepEqual(order, [1, 2, 3, 4, 5, 6]);
    assert.ok(peak > 1 && peak <= 3, `peak ${peak}`);
    assert.equal(fetches, 1);
    assert.deepEqual(res.rows.map((r) => r.issue), [1, 2, 3, 4, 5, 6]);
    await assert.rejects(triageFromCli(["1", "--repo", "o/r", "--parallel", "0"], { leanIo: w.io }), /--parallel/);
  });

  it("#4125 triage checks each issue against its own lane: a refused lane (--lane main, missing milestone branch) is reported and dropped", async () => {
    const w = world({ issues: { 12: { body: "x" }, 13: { body: "y", milestone: { title: "Later" } } } });
    const logs = []; const l = console.log; console.log = (s) => logs.push(String(s));
    let res, res2;
    try {
      res = await triageFromCli(["12", "13", "--repo", "o/r", "--dry-run"], { leanIo: w.io });
      res2 = await triageFromCli(["12", "--repo", "o/r", "--lane", "main", "--dry-run"], { leanIo: w.io });
    } finally { console.log = l; }
    assert.deepEqual(res.lanes, [12]);
    assert.ok(logs.some((s) => /^#13 → lane-refused \(lane\.branch_missing: lane branch milestone\/later/.test(s)), logs.join("\n"));
    assert.deepEqual(res2.lanes, []);
    assert.ok(logs.some((s) => /^#12 → lane-refused \(lane\.default_branch/.test(s)));
  });
});
