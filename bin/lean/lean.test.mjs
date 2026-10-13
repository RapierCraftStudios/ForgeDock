// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { runCore } from "./lean.mjs";
import { orchestrate, parseDeps, formatTable } from "./orchestrate.mjs";
import { REVIEWER_SYSTEM, approxTokens, builderPrompt, reviewerPrompt, parseVerdict } from "./prompts.mjs";
import { mapRecord } from "../engine/telemetry-seam.mjs";
import { readLog } from "../engine/runlog.mjs";
import { runFromCli, orchestrateFromCli, ENGINE_PATHS } from "../engine-cli.mjs";

const WT = "/wt/lean-7";
const ok = (extra = {}) => "```json\n" + JSON.stringify({ verdict: "PASS", fixes_issue: true, regression: false, reason: "src/foo.js:3 fixed", ...extra }) + "\n```";
const bad = (reason = "src/foo.js:9 still wrong") => ok({ verdict: "FAIL", fixes_issue: false, reason });

/** In-memory world with fake gh, git, fs and runner. */
function world(o = {}) {
  const w = {
    comments: [], labels: [], closed: [], edits: [], prs: [], merges: [], calls: [], telemetry: [], files: {}, head: "aaaa1111aaaa1111",
    changed: o.changed ?? ["src/foo.js", "test/foo.test.js"], reviews: [...(o.reviews ?? [])], waits: [...(o.waits ?? [])], clock: 0,
    result: o.result ?? { status: "fixed", summary: "fixed foo", evidence: [], tests: ["test/foo.test.js"] },
    prList: o.prList ?? [], remote: o.remote ?? "", resumeResult: o.resumeResult, seq: [],
  };
  w.io = {
    now: () => w.clock, sleep: async (ms) => { w.clock += ms; },
    gh: async (a) => {
      const k = a.slice(0, 2).join(" ");
      if (a[0] === "api") return "";
      if (k === "pr list") return JSON.stringify(w.prList);
      if (k === "issue view") return JSON.stringify({ number: 7, title: "foo breaks", body: "Bug in foo", state: "OPEN" });
      if (k === "issue comment") { w.comments.push(a[a.indexOf("--body") + 1]); w.seq.push("comment"); return `https://github.com/o/r/issues/7#issuecomment-${w.comments.length}\n`; }
      if (k === "issue close") { w.closed.push(a); w.seq.push("close"); return ""; }
      if (k === "issue edit") { w.edits.push(a); return ""; }
      if (k === "pr create") { w.prs.push(a); w.seq.push("pr"); return "https://github.com/o/r/pull/77\n"; }
      if (k === "pr merge") { w.merges.push(a); w.seq.push("merge"); return ""; }
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
    git: async (a) => {
      w.calls.push(["git", ...a]);
      if (a[0] === "rev-parse" && a[1] === "--git-path") return "/repo/.git/info/exclude";
      if (a[0] === "rev-parse") return w.head;
      if (a[0] === "diff" && a[1] === "--name-only") return w.changed.join("\n");
      if (a[0] === "diff") return "diff --git a/src/foo.js b/src/foo.js\n+fix";
      if (a[0] === "ls-remote") return w.remote;
      if (a[0] === "push") w.seq.push("push");
      return "";
    },
    runner: async (c) => {
      w.calls.push(["runner", c.role, c.resume ?? null, c.model ?? null, c.prompt, c.readOnly ?? false, c.system]);
      w.seq.push(c.role + (c.resume ? "-resume" : ""));
      if (c.role === "builder") {
        const r = c.resume ? (w.resumeResult ?? w.result) : w.result;
        if (r) w.files[`${WT}/.forge-lean/result.json`] = JSON.stringify(r);
        if (c.resume) w.head = `bbbb${w.calls.length}`.padEnd(16, "0");
        return { text: "done", sessionId: "sess-1", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, costUsd: 0.1, durationMs: 1000, turns: 3, model: "default" };
      }
      return { text: w.reviews.length ? w.reviews.shift() : ok(), sessionId: "rev", usage: { input_tokens: 4, output_tokens: 2 }, costUsd: 0.05, durationMs: 500, turns: 2, model: c.model };
    },
    waitCiGreen: async () => (w.waits.length ? w.waits.shift() : { rc: 0, text: `CI_GATE_HEAD: ${w.head}` }),
    transitionLabel: async (n, s) => { w.labels.push(s); w.seq.push(`label:${s}`); },
    fs: { read: async (p) => { if (!(p in w.files)) throw new Error("ENOENT"); return w.files[p]; }, append: async (p, t) => { w.files[p] = (w.files[p] ?? "") + t; } },
  };
  return w;
}
const run = (w, extra = {}) => runCore({ issue: 7, repo: "o/r", lane: "staging", cwd: "/repo", worktreeRoot: "/wt", dir: tmpDir("core-"),
  io: w.io, emitTelemetry: async (r) => w.telemetry.push(r), random: () => 0.5, ...extra });
const builders = (w) => w.calls.filter((c) => c[0] === "runner" && c[1] === "builder");
const reviewers = (w) => w.calls.filter((c) => c[0] === "runner" && c[1] === "reviewer");
const registers = (w) => w.comments.filter((c) => c.startsWith("<!-- FORGE:WORK-ON -->"));

describe("core work-on", () => {
  it("happy path: started comment, one register comment with everything, merge at the reviewed head", async () => {
    const w = world();
    const dir = tmpDir("core-");
    const r = await run(w, { dir });
    assert.equal(r.terminalReason, "merged");
    assert.equal(r.pr, 77);
    assert.match(w.comments[0], /FORGE:STARTED/);
    const reg = registers(w);
    assert.equal(reg.length, 1);
    for (const needle of ["fixed foo", "src/foo.js", "test/foo.test.js", "PASS", "src/foo.js:3 fixed", "https://github.com/o/r/pull/77", "cost $0.15", "tokens 14 in / 7 out / 100 cache", "wall"]) {
      assert.ok(reg[0].includes(needle), `register comment lacks ${needle}:\n${reg[0]}`);
    }
    assert.match(w.prs[0][w.prs[0].indexOf("--body") + 1], /Closes #7/);
    assert.deepEqual(w.merges[0].slice(-2), ["--match-head-commit", w.head]);
    assert.equal(w.closed.length, 1);
    assert.equal(builders(w).length, 1);
    assert.equal(reviewers(w).length, 1);
    const ev = readLog(dir, 7).map((e) => e.event);
    assert.equal(ev[0], "RUN_START"); assert.equal(ev.at(-1), "RUN_TERMINAL");
  });

  it("validation comment is posted before the reviewer and the in-review label; content for a fixed issue; register links it", async () => {
    const w = world({ result: { status: "fixed", summary: "fixed foo\nmore", evidence: ["src/foo.js:3 null deref"], tests: ["t"] } });
    await run(w);
    const vi = w.comments.findIndex((c) => c.startsWith("<!-- FORGE:VALIDATE -->"));
    assert.ok(vi >= 0);
    const v = w.comments[vi];
    assert.match(v, /Verdict:\*\* valid/);
    assert.match(v, /src\/foo.js:3 null deref/);
    assert.match(v, /Summary:\*\* fixed foo$/);
    assert.ok(!v.includes("more"));
    const pos = (x) => w.seq.indexOf(x);
    const commentSeq = w.seq.map((s, i) => (s === "comment" ? i : -1)).filter((i) => i >= 0);
    assert.ok(commentSeq[vi] > pos("builder") && commentSeq[vi] < pos("reviewer"));
    assert.ok(commentSeq[vi] < pos("label:in-review"));
    assert.match(registers(w)[0], /Validation:\*\* https:\/\/github.com\/o\/r\/issues\/7#issuecomment-\d+/);
    assert.equal(w.comments.filter((c) => c.includes("FORGE:VALIDATE")).length, 1);
  });

  it("labels transition in order, and register is posted after the PR and before the merge", async () => {
    const w = world();
    await run(w);
    assert.deepEqual(w.labels, ["investigating", "building", "in-review", "merged"]);
    const order = w.seq.filter((s) => ["label:investigating", "label:building", "builder", "label:in-review", "reviewer", "push", "pr", "merge", "label:merged"].includes(s));
    assert.deepEqual(order, ["label:investigating", "label:building", "builder", "label:in-review", "reviewer", "push", "pr", "merge", "label:merged"]);
    assert.ok(w.seq.indexOf("pr") < w.seq.lastIndexOf("comment") && w.seq.lastIndexOf("comment") < w.seq.indexOf("merge"));
  });

  it("emits phase_attempt for builder and reviewer plus run_terminal, stats-compatible", async () => {
    const w = world();
    await run(w);
    const mapped = w.telemetry.map((t) => mapRecord(t, 5)).filter(Boolean);
    assert.deepEqual(mapped.filter((m) => m.event === "phase_attempt").map((m) => m.phase), ["implement", "review"]);
    assert.equal(mapped[0].payload.input_tokens, 10);
    assert.equal(mapped.at(-1).event, "run_terminal");
    assert.equal(mapped.at(-1).payload.reason, "merged");
  });

  it("invalid with evidence closes the issue as invalid and opens no PR", async () => {
    const w = world({ changed: [], result: { status: "invalid", summary: "not a bug", evidence: ["src/foo.js:3 already guards null"], tests: [] } });
    const r = await run(w);
    assert.equal(r.terminalReason, "invalid");
    assert.deepEqual(w.labels, ["investigating", "building", "invalid"]);
    const vs = w.comments.filter((c) => c.startsWith("<!-- FORGE:VALIDATE -->"));
    assert.equal(vs.length, 1, "the validation comment is the evidence comment");
    assert.match(vs[0], /Verdict:\*\* invalid/);
    assert.match(vs[0], /src\/foo.js:3 already guards null/);
    assert.match(vs[0], /Summary:\*\* not a bug/);
    assert.equal(registers(w).length, 0, "no duplicate evidence comment");
    assert.equal(w.closed.length, 1);
    assert.equal(w.prs.length, 0);
    assert.equal(reviewers(w).length, 0);
  });

  it("already-fixed with evidence also closes", async () => {
    const w = world({ changed: [], result: { status: "already-fixed", summary: "done upstream", evidence: ["a.js:1"], tests: [] } });
    assert.equal((await run(w)).terminalReason, "invalid");
  });

  it("invalid without evidence goes to needs-human and does not close", async () => {
    const w = world({ changed: [], result: { status: "invalid", summary: "trust me", evidence: [], tests: [] } });
    const r = await run(w);
    assert.equal(r.terminalReason, "needs-human");
    assert.equal(w.closed.length, 0);
    assert.ok(w.edits.some((e) => e.includes("needs-human")));
    assert.ok(w.comments.some((c) => c.includes("FORGE:NEEDS_HUMAN") && c.includes("without evidence")));
  });

  it("review FAIL -> builder resumed via --resume with the reason -> re-review PASS -> merge", async () => {
    const w = world({ reviews: [bad("src/foo.js:9 still wrong"), ok()] });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    const b = builders(w);
    assert.equal(b.length, 2);
    assert.equal(b[1][2], "sess-1");
    assert.match(b[1][4], /src\/foo.js:9 still wrong/);
    assert.equal(reviewers(w).length, 2);
    assert.equal(w.prs.length, 1);
    assert.equal(registers(w).length, 1);
    assert.deepEqual(w.merges[0].slice(-2), ["--match-head-commit", w.head]);
  });

  it("review FAIL twice -> needs-human, no PR", async () => {
    const w = world({ reviews: [bad(), bad("still bad")] });
    const r = await run(w);
    assert.equal(r.terminalReason, "needs-human");
    assert.equal(builders(w).length, 2);
    assert.equal(w.prs.length, 0);
    assert.equal(w.merges.length, 0);
    assert.ok(w.edits.some((e) => e.includes("needs-human")));
  });

  it("a FAIL verdict with fixes_issue true and no regression is not a failure", async () => {
    const w = world({ reviews: [ok({ verdict: "FAIL" })] });
    assert.equal((await run(w)).terminalReason, "merged");
    assert.equal(builders(w).length, 1);
  });

  it("builder blocked, or no commit, is needs-human", async () => {
    assert.equal((await run(world({ result: { status: "blocked", summary: "need creds" } }))).terminalReason, "needs-human");
    assert.equal((await run(world({ changed: [] }))).terminalReason, "needs-human");
  });

  it("red remote CI is needs-human; slow CI polls with backoff and ends ci-pending, never needs-human", async () => {
    const w = world({ waits: [{ rc: 1, text: "lint failed" }] });
    assert.equal((await run(w)).terminalReason, "needs-human");
    const w2 = world({ waits: Array(500).fill({ rc: 2, text: "" }) });
    const r2 = await run(w2, { ciMaxMinutes: 10 });
    assert.equal(r2.terminalReason, "ci-pending");
    assert.equal(w2.edits.length, 0);
    const w3 = world({ waits: [{ rc: 2, text: "" }, { rc: 2, text: "" }] });
    assert.equal((await run(w3)).terminalReason, "merged");
  });

  it("refuses merge when the CI-gated head differs from the reviewed head", async () => {
    const w = world({ waits: [{ rc: 0, text: "CI_GATE_HEAD: deadbeefdead" }] });
    assert.equal((await run(w)).terminalReason, "needs-human");
    assert.equal(w.merges.length, 0);
  });

  it("an open Depends-on dependency refuses the run before any label or worktree", async () => {
    const w = world();
    const gh = w.io.gh;
    w.io.gh = async (a) => {
      if (a[0] === "api" && /issues\/7$/.test(a[1])) return JSON.stringify({ body: "**Depends on**: #3", user: { login: "x" }, author_association: "OWNER" });
      if (a[0] === "api" && /issues\/3$/.test(a[1])) return JSON.stringify({ state: "open" });
      return gh(a);
    };
    const r = await run(w);
    assert.ok(["dependency-open", "dependency-unreadable"].includes(r.terminalReason));
    assert.equal(w.labels.length, 0);
    assert.equal(w.calls.filter((c) => c[1] === "worktree").length, 0);
  });

  it("an open PR / remote branch resumes: worktree from the branch, builder skipped, review then merge", async () => {
    const w = world({ prList: [{ number: 77, headRefOid: "x" }], remote: "abc\trefs/heads/feat/issue-7-lean" });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    assert.equal(builders(w).length, 0);
    assert.equal(w.prs.length, 0);
    assert.ok(w.calls.some((c) => c[0] === "git" && c[1] === "worktree" && c[2] === "add" && c.includes("origin/feat/issue-7-lean")));
  });

  it("builder uses the CLI default model; reviewer is read-only Sonnet unless configured", async () => {
    const w = world(); await run(w);
    assert.equal(builders(w)[0][3], null);
    assert.equal(builders(w)[0][5], false);
    assert.equal(reviewers(w)[0][3], "claude-sonnet-5-5");
    assert.equal(reviewers(w)[0][5], true);
    const w2 = world(); await run(w2, { reviewerModel: "my-model" });
    assert.equal(reviewers(w2)[0][3], "my-model");
  });
});

describe("prompts", () => {
  it("builder prompt is at most 1k tokens and short and plain", () => {
    const p = builderPrompt(7);
    assert.ok(approxTokens(p) <= 1000);
    assert.match(p, /Resolve issue #7 \(read it with gh issue view 7 --comments\)/);
    assert.match(p, /Do not push or touch GitHub/);
    assert.match(p, /result\.json/);
  });

  it("reviewer system prompt is at most 1.5k tokens and holds only the two questions", () => {
    assert.ok(approxTokens(REVIEWER_SYSTEM) <= 1500);
    assert.match(REVIEWER_SYSTEM, /Does this change fix the issue as described\?/);
    assert.match(REVIEWER_SYSTEM, /introduce a regression/);
    for (const banned of [/edge/i, /style/i, /harden/i, /nice.to.have/i, /severity/i, /nit/i, /optional/i, /refactor/i, /naming/i, /performance/i, /security/i]) {
      assert.doesNotMatch(REVIEWER_SYSTEM, banned);
    }
    assert.equal((REVIEWER_SYSTEM.match(/^\d\. /gm) ?? []).length, 2);
  });

  it("the full reviewer prompt for a typical diff stays under 1.5k tokens of instructions plus content", () => {
    const p = reviewerPrompt({ issue: { number: 7, title: "t", body: "b" }, diff: "x".repeat(2000) });
    assert.match(p, /<diff>/);
    assert.ok(approxTokens(REVIEWER_SYSTEM) + approxTokens(reviewerPrompt({ issue: { number: 7, title: "t", body: "b" }, diff: "" })) <= 1500);
  });

  it("parseVerdict: flags decide, garbage is null", () => {
    assert.equal(parseVerdict(ok()).fail, false);
    assert.equal(parseVerdict(ok({ regression: true })).fail, true);
    assert.equal(parseVerdict(bad()).fail, true);
    assert.equal(parseVerdict("no json"), null);
    assert.equal(parseVerdict('{"verdict":"FAIL","reason":"x"}').fail, true);
  });
});

describe("run-issue routing", () => {
  const mk = () => { const seen = {}; return { seen, dir: tmpDir("core-cli-"), emitTelemetry: async () => {}, leanIo: {}, io: { gh: async () => "o/r\n" },
    leanModule: { runCore: async (o) => { seen.core = o.path; return { terminalReason: "merged" }; } }, runIssue: async () => { seen.full = true; return { terminalReason: "merged" }; } }; };
  const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };

  it("default (no --path) runs the core work-on", async () => {
    const d = mk();
    await quiet(() => runFromCli(["7", "--lane", "staging", "--repo", "o/r"], d));
    assert.equal(d.seen.core, "core"); assert.ok(!d.seen.full);
  });

  it("--path lean and --path auto are aliases of the core", async () => {
    for (const p of ["lean", "auto", "core"]) {
      const d = mk();
      await quiet(() => runFromCli(["7", "--lane", "staging", "--repo", "o/r", "--path", p], d));
      assert.ok(d.seen.core && !d.seen.full, p);
    }
  });

  it("--path full still routes to the old engine", async () => {
    const d = mk();
    await quiet(() => runFromCli(["7", "--lane", "staging", "--repo", "o/r", "--path", "full"], d));
    assert.ok(d.seen.full); assert.equal(d.seen.core, undefined);
  });

  it("bad --path errors; --retry is rejected on the core path", async () => {
    await assert.rejects(runFromCli(["7", "--lane", "staging", "--path", "bogus"], mk()), /--path must be/);
    await assert.rejects(runFromCli(["7", "--lane", "staging", "--repo", "o/r", "--retry"], mk()), /not supported with the core path/);
    assert.deepEqual(ENGINE_PATHS, ["core", "full", "lean", "auto"]);
  });
});

describe("orchestrate", () => {
  const tick = () => new Promise((r) => setImmediate(r));
  const harness = (bodies, outcomes = {}) => {
    const log = { starts: [], ends: [], active: 0, maxActive: 0 };
    return { log,
      readBody: async (n) => bodies[n] ?? "",
      runOne: async (n) => {
        log.starts.push(n); log.active++; log.maxActive = Math.max(log.maxActive, log.active);
        await tick(); await tick();
        log.active--; log.ends.push(n);
        const reason = outcomes[n] ?? "merged";
        return { terminalReason: reason, pr: reason === "merged" ? 100 + n : null, cost_usd: 0.5, detail: reason };
      } };
  };

  it("parseDeps reads Depends-on lines and ignores self references", () => {
    assert.deepEqual(parseDeps("x\n**Depends on**: #4\n**Depends on**: #7\n", 7), [4]);
  });

  it("runs at most K at once", async () => {
    const h = harness({});
    const rows = await orchestrate({ issues: [1, 2, 3, 4, 5, 6], parallel: 2, ...h });
    assert.equal(h.log.maxActive, 2);
    assert.equal(rows.length, 6);
    assert.ok(rows.every((r) => r.outcome === "merged"));
  });

  it("default style K=3 runs three in parallel", async () => {
    const h = harness({});
    await orchestrate({ issues: [1, 2, 3, 4], parallel: 3, ...h });
    assert.equal(h.log.maxActive, 3);
  });

  it("a dependent waits until its dependency has merged", async () => {
    const h = harness({ 2: "**Depends on**: #1" });
    await orchestrate({ issues: [2, 1, 3], parallel: 3, ...h });
    assert.ok(h.log.ends.indexOf(1) < h.log.starts.indexOf(2), JSON.stringify(h.log));
  });

  it("a dependent is skipped, without running, when its dependency ends needs-human (transitively)", async () => {
    const h = harness({ 2: "**Depends on**: #1", 3: "**Depends on**: #2" }, { 1: "needs-human" });
    const rows = await orchestrate({ issues: [1, 2, 3, 4], parallel: 3, ...h });
    assert.deepEqual(rows.map((r) => r.outcome), ["needs-human", "skipped", "skipped", "merged"]);
    assert.ok(!h.log.starts.includes(2) && !h.log.starts.includes(3));
    assert.match(rows[1].detail, /#1/);
  });

  it("a dependency that closed as invalid does not block", async () => {
    const h = harness({ 2: "**Depends on**: #1" }, { 1: "invalid" });
    const rows = await orchestrate({ issues: [1, 2], parallel: 2, ...h });
    assert.equal(rows[1].outcome, "merged");
  });

  it("a dependency cycle is skipped rather than hanging; a thrown run is an engine-error row", async () => {
    const h = harness({ 1: "**Depends on**: #2", 2: "**Depends on**: #1" });
    const rows = await orchestrate({ issues: [1, 2], parallel: 2, ...h });
    assert.ok(rows.every((r) => r.outcome === "skipped"));
    const rows2 = await orchestrate({ issues: [9], runOne: async () => { throw new Error("boom"); }, readBody: async () => "" });
    assert.equal(rows2[0].outcome, "engine-error");
  });

  it("formatTable prints issue, outcome, PR, cost, minutes", () => {
    const t = formatTable([{ issue: 1, outcome: "merged", pr: 101, cost_usd: 0.5, minutes: 3.2 }, { issue: 2, outcome: "skipped", pr: null, cost_usd: 0, minutes: 0, detail: "dependency #1 ended needs-human" }]);
    assert.match(t, /issue\s+outcome\s+PR\s+cost\s+min/);
    assert.match(t, /#1\s+merged\s+#101\s+\$0\.50\s+3\.2/);
    assert.match(t, /skipped \(dependency #1/);
  });

  it("orchestrateFromCli wires parallel, lane and prints the table", async () => {
    const seen = [];
    const logs = [];
    const l = console.log; console.log = (s) => logs.push(String(s));
    try {
      const res = await orchestrateFromCli(["1", "2", "--parallel", "2", "--lane", "main", "--repo", "o/r"], {
        dir: tmpDir("core-orch-"), emitTelemetry: async () => {}, io: { gh: async () => "o/r\n" },
        leanIo: { gh: async () => JSON.stringify({ body: "" }) },
        leanModule: { runCore: async (o) => { seen.push([o.issue, o.lane, o.repo]); return { terminalReason: "merged", pr: 50 + o.issue, cost_usd: 1, wall_ms: 1 }; } } });
      assert.equal(res.ok, true);
    } finally { console.log = l; }
    assert.deepEqual(seen.sort(), [[1, "main", "o/r"], [2, "main", "o/r"]]);
    assert.ok(logs.some((s) => /issue\s+outcome/.test(s)));
    await assert.rejects(orchestrateFromCli([], {}), /usage/);
  });
});
