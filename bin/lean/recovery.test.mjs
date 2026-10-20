// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4267: in-batch recovery of mechanical needs-human (orchestrate, run-issue/orchestrate CLI, /orchestrate spec).
// The runCore side (--recover label/decision/prompt, issueEdited) is in lean.test.mjs next to its harness.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpDir } from "../tests/_tmp.mjs";
import { orchestrate, formatOutcomeLists, OUTCOME_LINE_MAX } from "./orchestrate.mjs";
import { RECOVER_HOW } from "./lean.mjs";
import { RECOVERABLE_CODES } from "../engine/outcome-codes.mjs";
import { runFromCli, orchestrateFromCli } from "../engine-cli.mjs";
// orchestrateFromCli opens the host lane registry (#4191): keep it in a temp dir.
process.env.FORGEDOCK_SCHED_DIR = tmpDir("recovery-sched-");

describe("in-batch recovery of mechanical needs-human (#4267)", () => {
  // runOne: `script[n]` is a list of results, one per launch of issue n (the last repeats); ctx is recorded.
  const batch = (script, bodies = {}, extra = {}) => {
    const calls = [], decisions = [];
    const p = orchestrate({ issues: Object.keys(script).map(Number), parallel: 3, recovery: { maxAttempts: extra.maxAttempts ?? 1 },
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
    assert.deepEqual(calls.filter((c) => c.n === 1).map((c) => c.recover), [null, { code: "ci.red", attempt: 1, final: true }]);
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

  it("relabelNeedsHuman (SPEC-7/8): only a recovery that ends final engine-error/deferred relabels; invalid/merged never; a requeued deferred waits", async () => {
    const relabels = [];
    const rl = { relabelNeedsHuman: async (x) => { relabels.push(x); }, pollMs: 5 };
    // engine-error after the recovery lane's own relaunch: final -> exactly one relabel with the recovery evidence
    const a = await batch({ 1: [NH("ci.red"), { terminalReason: "engine-error", detail: "boom" }] }, {}, rl);
    assert.equal(a.rows[0].outcome, "engine-error"); assert.equal(relabels.length, 1);
    assert.equal(relabels[0].issue, 1); assert.match(relabels[0].evidence, /Recovery pass for `ci\.red` \(attempt 1\) did not merge: it ended `engine-error`/);
    // invalid / merged / decomposed: never
    relabels.length = 0;
    await batch({ 1: [NH("ci.red"), { terminalReason: "invalid", detail: "not a bug" }], 2: [NH("ci.red"), { terminalReason: "merged" }],
      3: [NH("ci.red"), { terminalReason: "decomposed", subissues: [] }] }, {}, rl);
    assert.deepEqual(relabels, []);
    // a deferred recovery that is requeued is not relabelled until it is final (capped)
    const defer = { terminalReason: "deferred", code: "gh.unavailable", retryInSeconds: 0.01, detail: "gh down" };
    const seen = [];
    const d = await batch({ 1: [NH("ci.red"), defer] }, {}, { ...rl, maxDeferrals: 2, onUpdate: (r) => seen.push([r.outcome, relabels.length, String(r.detail)]) });
    assert.equal(d.rows[0].outcome, "deferred");
    const rq = seen.filter(([o, , det]) => o === "deferred" && /^requeued in/.test(det));
    assert.ok(rq.length >= 1 && rq.every(([, n]) => n === 0), "a requeued deferral is not relabelled");
    assert.equal(relabels.filter((x) => x.issue === 1).length, 1, "once, only when final");
    // without a recovery pass nothing is relabelled
    relabels.length = 0;
    await batch({ 1: [{ terminalReason: "engine-error" }] }, {}, rl);
    assert.deepEqual(relabels, []);
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
    assert.deepEqual(ctxs, [{ code: "ci.red", attempt: 1, final: true }]);
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
    assert.deepEqual(got, [{ code: "base.conflict", attempt: 1, final: true }]);
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
    assert.deepEqual(runs, [null, { code: "ci.red", attempt: 1, final: true }]);
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

  it("#4302: with maxAttempts 2 only the last attempt is final; a non-final attempt is not relabelled while its successor runs", async () => {
    const relabels = [];
    const conf = { maxAttempts: 2, conflicting: async () => true, relabelNeedsHuman: async (x) => { relabels.push(x); } };
    const pend = { terminalReason: "ci-pending", pr: 9, detail: "CI still running" };
    const seen = [];
    const { rows, calls } = await batch({ 1: [NH("base.conflict"), pend, pend] }, {}, { ...conf, onUpdate: (r) => seen.push([r.outcome, relabels.length]) });
    assert.deepEqual(calls.map((c) => c.recover), [null, { code: "base.conflict", attempt: 1, final: false }, { code: "base.conflict", attempt: 2, final: true }]);
    assert.equal(rows[0].outcome, "ci-pending");
    assert.ok(seen.filter(([o]) => o === "recovering").every(([, k]) => k === 0), "no relabel between attempts");
    assert.deepEqual(relabels, [], "the final lane relabels ci-pending itself; the runner does not");
  });

  it("#4302: a non-final attempt that ends needs-human/ci-pending without a successor is relabelled by the runner, once", async () => {
    const relabels = [];
    const rl = { maxAttempts: 2, relabelNeedsHuman: async (x) => { relabels.push(x); } };
    // ci-pending on a PR that does not conflict is not recoverable: no attempt 2.
    const a = await batch({ 1: [NH("ci.red"), { terminalReason: "ci-pending", pr: 9, detail: "CI still running" }] }, {}, { ...rl, conflicting: async () => false });
    assert.equal(a.calls.length, 2); assert.equal(a.rows[0].outcome, "ci-pending");
    assert.equal(relabels.length, 1); assert.match(relabels[0].evidence, /Recovery pass for `ci\.red` \(attempt 1\) did not merge: it ended `ci-pending`/);
    // needs-human with a human code is never recovered: no attempt 2.
    relabels.length = 0;
    const b = await batch({ 1: [NH("ci.red"), NH("builder.blocked", "needs credentials")] }, {}, rl);
    assert.equal(b.calls.length, 2); assert.equal(b.rows[0].outcome, "needs-human");
    assert.equal(relabels.length, 1); assert.match(relabels[0].evidence, /ended `needs-human` \(`builder\.blocked`\)/);
    // maxAttempts 1: the only attempt is final, so the lane relabels and the runner does not (unchanged).
    relabels.length = 0;
    const c = await batch({ 1: [NH("ci.red"), NH("builder.blocked")] }, {}, { ...rl, maxAttempts: 1 });
    assert.deepEqual(c.calls.map((x) => x.recover), [null, { code: "ci.red", attempt: 1, final: true }]);
    assert.deepEqual(relabels, []);
  });

  it("#4302: --recover-nonfinal reaches runCore as final: false; without it a recovery lane is final", async () => {
    const got = [];
    const l = console.log; console.log = () => {};
    try {
      for (const extra of [["--recover-nonfinal"], []]) {
        await runFromCli(["7", "--lane", "staging", "--repo", "o/r", "--recover", "ci.red", "--recover-attempt", "1", ...extra], { dir: tmpDir("core-rec-"), emitTelemetry: async () => {}, leanIo: {}, io: { gh: async () => "o/r\n" },
          leanModule: { runCore: async (o) => { got.push(o.recover); return { terminalReason: "merged" }; } } });
      }
    } finally { console.log = l; }
    assert.deepEqual(got, [{ code: "ci.red", attempt: 1, final: false }, { code: "ci.red", attempt: 1, final: true }]);
  });
});

describe("#4298 staging-review follow-ups: recovery", () => {
  it("RECOVER_HOW has a prompt for exactly the RECOVERABLE_CODES", () => {
    assert.deepEqual(Object.keys(RECOVER_HOW).sort(), [...RECOVERABLE_CODES].sort());
    for (const c of RECOVERABLE_CODES) assert.ok(String(RECOVER_HOW[c]).length > 20, c);
  });

  it("a recovered row reports the first attempt's cost and minutes summed with the recovery's; the lane sees only {code, attempt, final}", async () => {
    let t = 0; const seen = [];
    const script = { 1: [{ terminalReason: "needs-human", code: "ci.red", detail: "red", cost_usd: 0.5 }, { terminalReason: "merged", pr: 9, cost_usd: 0.25 }],
      2: [{ terminalReason: "needs-human", code: "ci.red", detail: "red", cost_usd: 1 }, { terminalReason: "needs-human", code: "ci.red", detail: "red again", cost_usd: 2 }] };
    const k = { 1: 0, 2: 0 };
    const rows = await orchestrate({ issues: [1, 2], parallel: 1, recovery: { maxAttempts: 1 }, readBody: async () => "", now: () => t,
      runOne: async (n, _l, ctx = {}) => { seen.push(ctx.recover ?? null); t += 60000 * (n === 1 ? 3 : 1); return script[n][k[n]++]; } });
    const r = Object.fromEntries(rows.map((x) => [x.issue, x]));
    assert.equal(r[1].outcome, "merged"); assert.equal(r[1].cost_usd, 0.75); assert.equal(r[1].minutes, 6);
    assert.equal(r[2].outcome, "needs-human"); assert.equal(r[2].cost_usd, 3); assert.equal(r[2].minutes, 2);
    assert.deepEqual(seen.filter(Boolean), [{ code: "ci.red", attempt: 1, final: true }, { code: "ci.red", attempt: 1, final: true }]);
  });

  it("formatOutcomeLists caps a detail at OUTCOME_LINE_MAX", () => {
    const [l] = formatOutcomeLists([{ issue: 3, outcome: "needs-human", code: "conformance.omission", detail: "x".repeat(500) }]);
    assert.ok(l.includes("x".repeat(OUTCOME_LINE_MAX)) && !l.includes("x".repeat(OUTCOME_LINE_MAX + 1)));
  });

  it("run-issue rejects --recover on the legacy --path full", async () => {
    await assert.rejects(runFromCli(["7", "--lane", "staging", "--path", "full", "--recover", "ci.red"], { dir: tmpDir("core-rec-"), emitTelemetry: async () => {}, io: { gh: async () => "o/r\n" } }),
      /--recover is not supported with --path full/);
  });

  it("/orchestrate spec describes terminal non-human needs-human rows, --recover scope and the schedd resume scope", () => {
    const spec = readFileSync(new URL("../../commands/orchestrate.md", import.meta.url), "utf8");
    assert.match(spec, /\*\*terminal code\*\* that is neither recoverable nor human/);
    assert.match(spec, /`unrecovered: #N/);
    assert.match(spec, /core path only:\s+`--path full` rejects `--recover`/);
    assert.match(spec, /resumes every daemon-hosted batch that has no report yet/);
  });
});

describe("#4304 staging-review follow-ups: recovery", () => {
  it("a recovery row counts the pre-filter cost once; a single pass still includes it", async () => {
    const script = { 1: [{ terminalReason: "needs-human", code: "ci.red", detail: "red", cost_usd: 1 }, { terminalReason: "needs-human", code: "ci.red", detail: "red again", cost_usd: 1 }],
      2: [{ terminalReason: "merged", pr: 4, cost_usd: 1 }] };
    const k = { 1: 0, 2: 0 };
    const rows = await orchestrate({ issues: [1, 2], parallel: 1, recovery: { maxAttempts: 1 }, readBody: async () => "", now: () => 0,
      prefilter: async () => ({ closed: false, cost_usd: 0.1 }), runOne: async (n) => script[n][k[n]++] });
    const r = Object.fromEntries(rows.map((x) => [x.issue, x]));
    assert.equal(k[1], 2, "issue 1 ran a recovery lane");
    assert.equal(r[1].cost_usd, 2.1);
    assert.equal(r[2].cost_usd, 1.1);
  });

  const runBatchWith = async (enginePath) => {
    const leanIo = {
      gh: async (a) => (a.includes("milestone") ? JSON.stringify({ milestone: null }) : JSON.stringify({ body: "" })),
      git: async (a) => (a[0] === "ls-remote" ? "abc\trefs/heads/staging\n" : ""),
    };
    const runs = [], logs = [], l = console.log;
    console.log = (x) => logs.push(String(x));
    try {
      await orchestrateFromCli(["5", "--repo", "o/r", "--no-prefilter"], { dir: tmpDir("core-rec-"), batchRoot: tmpDir("core-rec-batch-"), allowTmpfs: true, emitTelemetry: async () => {},
        io: { gh: async () => "o/r\n" }, leanIo, sched: null, enginePath, orchestration: { breaker: null, maxDeferrals: 3, globalParallel: null, recovery: { maxAttempts: 1 } }, decide: () => {},
        relabelNeedsHuman: async () => {},
        leanModule: { runCore: async (o) => { runs.push(o.recover ?? null); return { terminalReason: "needs-human", code: "ci.red", detail: "Required check(s) failed on PR #55: test" }; } } });
    } finally { console.log = l; }
    return { runs, logs };
  };

  it("engine.path full turns batch recovery off (run-issue rejects --recover there); core keeps it", async () => {
    const full = await runBatchWith("full");
    assert.deepEqual(full.runs, [null]);
    assert.ok(full.logs.some((x) => /recovery: off \(engine\.path is full/.test(x)), full.logs.join("\n"));
    const core = await runBatchWith("core");
    assert.deepEqual(core.runs, [null, { code: "ci.red", attempt: 1, final: true }]);
  });
});
