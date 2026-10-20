// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4267: in-batch recovery of mechanical needs-human (orchestrate, run-issue/orchestrate CLI, /orchestrate spec).
// The runCore side (--recover label/decision/prompt, issueEdited) is in lean.test.mjs next to its harness.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpDir } from "../tests/_tmp.mjs";
import { orchestrate, formatOutcomeLists } from "./orchestrate.mjs";
import { runFromCli, orchestrateFromCli } from "../engine-cli.mjs";
// orchestrateFromCli opens the host lane registry (#4191): keep it in a temp dir.
process.env.FORGEDOCK_SCHED_DIR = tmpDir("recovery-sched-");

describe("in-batch recovery of mechanical needs-human (#4267)", () => {
  // runOne: `script[n]` is a list of results, one per launch of issue n (the last repeats); ctx is recorded.
  const batch = (script, bodies = {}, extra = {}) => {
    const calls = [], decisions = [];
    const p = orchestrate({ issues: Object.keys(script).map(Number), parallel: 3, recovery: { maxAttempts: 1 },
      readBody: async (n) => bodies[n] ?? "",
      runOne: async (n, _lane, ctx = {}) => {
        calls.push({ n, recover: ctx.recover ?? null });
        await new Promise((r) => setImmediate(r));
        const list = script[n] ?? [{ terminalReason: "merged" }];
        const k = calls.filter((c) => c.n === n).length - 1;
        return list[Math.min(k, list.length - 1)];
      },
      decide: (d) => { decisions.push(d); }, ...extra });
    return p.then((rows) => ({ rows, calls, decisions }));
  };
  const NH = (code, detail = `ended ${code}`, more = {}) => ({ terminalReason: "needs-human", code, detail, ...more });
  const byIssue = (rows) => Object.fromEntries(rows.map((r) => [r.issue, r]));

  it("ci.red: one recovery lane on the PR; green re-queues the issue and its dependent in the same batch, no operator action", async () => {
    const { rows, calls, decisions } = await batch({ 1: [NH("ci.red", "Required check(s) failed on PR #101: test"), { terminalReason: "merged", pr: 101 }], 2: [{ terminalReason: "merged", pr: 102 }] }, { 2: "**Depends on**: #1" });
    const r = byIssue(rows);
    assert.equal(r[1].outcome, "merged"); assert.equal(r[1].recovered, "ci.red");
    assert.equal(r[2].outcome, "merged", "the dependent was not skipped");
    assert.deepEqual(calls.filter((c) => c.n === 1).map((c) => c.recover), [null, { code: "ci.red", attempt: 1 }]);
    assert.ok(calls.findIndex((c) => c.n === 2) > calls.findLastIndex((c) => c.n === 1), "the dependent ran after the recovered merge");
    const d = decisions.find((x) => x.issue === 1);
    assert.match(d.what, /recovery lane for ci\.red/); assert.match(d.why, /Required check/); assert.ok(d.alternative);
    assert.deepEqual(formatOutcomeLists(rows), ["recovered: #1 (ci.red)"]);
  });

  it("a recovery that stays red is final with its evidence; dependents stay skipped; no attempt beyond max_attempts", async () => {
    const { rows, calls } = await batch({ 1: [NH("ci.red"), NH("ci.red", "CI verification failed again", { recovery: true })], 2: [] }, { 2: "**Depends on**: #1" });
    const r = byIssue(rows);
    assert.equal(calls.filter((c) => c.n === 1).length, 2, "the first run plus exactly one recovery");
    assert.equal(r[1].outcome, "needs-human");
    assert.deepEqual(r[1].recovery, { code: "ci.red", attempts: 1, outcome: "needs-human", result_code: "ci.red", detail: "CI verification failed again" });
    assert.equal(r[2].outcome, "skipped"); assert.ok(!calls.some((c) => c.n === 2));
    const lines = formatOutcomeLists(rows);
    assert.equal(lines.length, 1); assert.match(lines[0], /^unrecovered: #1 \(ci\.red: recovery ci\.red ended needs-human: CI verification failed again\)$/);
  });

  it("human codes (product-decision, spend) are never recovered, still skip dependents and are the only escalations, asked once while other lanes keep running", async () => {
    const { rows, calls, decisions } = await batch({
      1: [NH("builder.blocked", "Builder is blocked (product-decision): pick a pricing model")],
      2: [],
      3: [NH("builder.blocked", "Builder is blocked (spend): needs a paid plan")],
      4: [NH("conformance.omission", "R2 not covered")],
      5: [{ terminalReason: "merged" }] }, { 2: "**Depends on**: #1" });
    const r = byIssue(rows);
    assert.equal(calls.filter((c) => c.n === 1).length, 1); assert.equal(calls.filter((c) => c.n === 3).length, 1);
    assert.equal(calls.filter((c) => c.n === 4).length, 1, "terminal mechanical codes are not recovered either");
    assert.ok(!decisions.some((d) => [1, 3].includes(d.issue)));
    assert.equal(r[2].outcome, "skipped"); assert.equal(r[5].outcome, "merged");
    const lines = formatOutcomeLists(rows);
    assert.equal(lines.filter((l) => l.startsWith("escalations")).length, 1, "one escalation list");
    const esc = lines.find((l) => l.startsWith("escalations"));
    assert.match(esc, /#1 \(builder\.blocked\): Builder is blocked \(product-decision\)/);
    assert.match(esc, /#3 \(builder\.blocked\): Builder is blocked \(spend\)/);
    assert.doesNotMatch(esc, /#4/, "the needs-human list holds only human codes");
    assert.ok(lines.some((l) => /^unrecovered: #4 \(conformance\.omission: R2 not covered\)$/.test(l)));
  });

  it("base.conflict: a recovery base-sync with a clean result re-queues the issue; the report lists recovered issues separately", async () => {
    const { rows, calls } = await batch({ 1: [NH("ci.red"), { terminalReason: "merged" }], 2: [NH("base.conflict", "PR #102 still conflicts with staging after 2 base-syncs"), { terminalReason: "merged" }] });
    assert.deepEqual(calls.filter((c) => c.n === 2).map((c) => c.recover?.code ?? null), [null, "base.conflict"]);
    assert.equal(byIssue(rows)[2].recovered, "base.conflict");
    assert.deepEqual(formatOutcomeLists(rows), ["recovered: #1 (ci.red) #2 (base.conflict)"]);
  });

  it("ci-pending recovers only when its PR conflicts (as base.conflict); a slow-CI ci-pending is left as is", async () => {
    const seen = [];
    const conflicting = async (n, pr) => { seen.push([n, pr]); return n === 1; };
    const { rows, calls } = await batch({ 1: [{ terminalReason: "ci-pending", pr: 101 }, { terminalReason: "merged", pr: 101 }], 2: [{ terminalReason: "ci-pending", pr: 102 }] }, {}, { conflicting });
    const r = byIssue(rows);
    assert.equal(r[1].recovered, "base.conflict");
    assert.equal(r[2].outcome, "ci-pending"); assert.equal(calls.filter((c) => c.n === 2).length, 1);
    assert.deepEqual(seen.sort(), [[1, 101], [2, 102]]);
  });

  it("contract.invalid recovers only when the issue was edited mid-run", async () => {
    const { rows, calls } = await batch({ 1: [NH("contract.invalid", "contract invalid", { issueEdited: true }), { terminalReason: "merged" }], 2: [NH("contract.invalid")] });
    assert.equal(byIssue(rows)[1].recovered, "contract.invalid");
    assert.equal(byIssue(rows)[2].outcome, "needs-human"); assert.equal(calls.filter((c) => c.n === 2).length, 1);
  });

  it("without the recovery option the runner behaves as before: needs-human is final and dependents skip", async () => {
    const calls = [];
    const rows = await orchestrate({ issues: [1, 2], readBody: async (n) => (n === 2 ? "**Depends on**: #1" : ""),
      runOne: async (n) => { calls.push(n); return NH("ci.red"); } });
    assert.deepEqual(calls, [1]); assert.deepEqual(rows.map((r) => r.outcome), ["needs-human", "skipped"]);
  });

  it("the attempt count survives a resume: a persisted recovery lane is launched with ctx.recover and is not retried again", async () => {
    let state = { v: 1, order: [1], deps: { 1: [] }, pending: [1], results: {}, running: {}, recoveries: { 1: 1 }, recovering: { 1: { code: "ci.red", attempt: 1 } } };
    const store = { load: () => state, save: (s) => { state = s; }, log: () => {} };
    const ctxs = [];
    const rows = await orchestrate({ issues: [1], store, recovery: { maxAttempts: 1 }, readBody: async () => "",
      runOne: async (n, l, ctx) => { ctxs.push(ctx.recover); return NH("ci.red"); } });
    assert.deepEqual(ctxs, [{ code: "ci.red", attempt: 1 }]);
    assert.equal(rows[0].outcome, "needs-human"); assert.equal(rows[0].recovery.code, "ci.red");
    assert.deepEqual(state.recovering, {});
  });

  it("other runner decisions are recorded too (engine-error relaunch, dependency requeue, sub-issues), and a throwing recorder never blocks the run", async () => {
    const { decisions } = await batch({ 1: [{ terminalReason: "engine-error", detail: "boom" }, { terminalReason: "merged" }], 2: [{ terminalReason: "decomposed", subissues: [8] }] });
    assert.ok(decisions.some((d) => d.issue === 1 && /relaunch/.test(d.what) && d.why === "boom" && d.alternative));
    assert.ok(decisions.some((d) => d.issue === 2 && /#8/.test(d.what)));
    const rows = await orchestrate({ issues: [1], recovery: { maxAttempts: 1 }, readBody: async () => "", decide: () => { throw new Error("gh down"); },
      runOne: async (n, l, ctx) => (ctx.recover ? { terminalReason: "merged" } : NH("ci.red")) });
    assert.equal(rows[0].recovered, "ci.red");
  });


  it("run-issue --recover reaches runCore; a batch relaunches a ci.red lane with recover and reports it", async () => {
    const got = [];
    const l = console.log; console.log = () => {};
    try {
      await runFromCli(["7", "--lane", "staging", "--repo", "o/r", "--recover", "base.conflict", "--recover-attempt", "1"], { dir: tmpDir("core-rec-"), emitTelemetry: async () => {}, leanIo: {}, io: { gh: async () => "o/r\n" },
        leanModule: { runCore: async (o) => { got.push(o.recover); return { terminalReason: "merged" }; } } });
    } finally { console.log = l; }
    assert.deepEqual(got, [{ code: "base.conflict", attempt: 1 }]);
    // The batch: a ci.red lane is relaunched in-process with recover, the decision is recorded and the report lists it.
    const leanIo = {
      gh: async (a) => (a.includes("milestone") ? JSON.stringify({ milestone: null }) : JSON.stringify({ body: "" })),
      git: async (a) => (a[0] === "ls-remote" ? "abc\trefs/heads/staging\n" : ""),
    };
    const runs = [], decisions = [], logs = [];
    console.log = (x) => logs.push(String(x));
    let res;
    try {
      res = await orchestrateFromCli(["5", "--repo", "o/r", "--no-prefilter"], { dir: tmpDir("core-rec-"), batchRoot: tmpDir("core-rec-batch-"), allowTmpfs: true, emitTelemetry: async () => {},
        io: { gh: async () => "o/r\n" }, leanIo, sched: null, orchestration: { breaker: null, maxDeferrals: 3, globalParallel: null, recovery: { maxAttempts: 1 } }, decide: (d) => decisions.push(d),
        leanModule: { runCore: async (o) => { runs.push(o.recover ?? null); return o.recover ? { terminalReason: "merged", pr: 55 } : { terminalReason: "needs-human", code: "ci.red", detail: "Required check(s) failed on PR #55: test" }; } } });
    } finally { console.log = l; }
    assert.deepEqual(runs, [null, { code: "ci.red", attempt: 1 }]);
    assert.equal(res.ok, true);
    assert.ok(decisions.some((d) => d.issue === 5 && /recovery lane for ci\.red/.test(d.what)));
    assert.ok(logs.includes("recovered: #5 (ci.red)"), logs.join("\n"));
  });

  it("/orchestrate spec step 3 lists the recoverable codes, asks no confirmation on them, and escalates once at the end", async () => {
    const spec = readFileSync(new URL("../../commands/orchestrate.md", import.meta.url), "utf8");
    const step3 = spec.slice(spec.indexOf("## 3. Launch lanes"), spec.indexOf("## 4. Report"));
    for (const c of ["`ci.red`", "`base.conflict`", "`ci-pending` on a conflicting", "`contract.invalid` caused by an issue edited mid-run"]) assert.ok(step3.includes(c), c);
    assert.match(step3, /\*\*Do not ask for confirmation on them\.\*\*/);
    assert.match(step3, /FORGE:DECISION/);
    assert.match(step3, /one question list[\s\S]*once, at the end of the batch/);
    assert.match(spec, /recovered: #A \(ci\.red\) #B \(base\.conflict\)/);
  });
});
