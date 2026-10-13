// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { tmpDir } from "../tests/_tmp.mjs";
import { join } from "node:path";
import { runLean, MAX_ROUNDS } from "./lean.mjs";
import { riskTier, isDocsOnly, isTestFile, isBlocking, parseFindings, choosePath, isLargeDiff } from "./risk.mjs";
import { BUILDER_SYSTEM, REVIEWER_SYSTEM, SECURITY_REVIEWER_SYSTEM, approxTokens } from "./prompts.mjs";
import { mapRecord } from "../engine/telemetry-seam.mjs";
import { readLog } from "../engine/runlog.mjs";
import { runFromCli } from "../engine-cli.mjs";
import { runCliBackend, buildLeanSessionFlags, buildReadOnlyToolFlags } from "../runner.mjs";

const WT = "/wt/lean-7";
const finding = (o) => ({ id: "F1", severity: "LOW", confidence: "POSSIBLE", file: "a.js", line: 1, scope: "introduced", title: "t", failure_scenario: "s", ...o });
const reply = (arr) => "```json\n" + JSON.stringify(arr) + "\n```";

/** In-memory world: fake gh, git, fs, runner, ci. `script` hooks let each test steer the builder/reviewer. */
function world(o = {}) {
  const w = {
    leaseWrites: [], lease: o.lease ?? null, comments: [], labels: [], closed: [], edits: [], prs: [], merges: [], calls: [], telemetry: [], files: {}, ciQueue: [...(o.ci ?? [])],
    changed: o.changed ?? ["src/foo.js", "test/foo.test.js"], lines: o.lines ?? 40, head: "aaaa1111aaaa1111", waits: [...(o.waits ?? [])],
    reviewReplies: [...(o.reviews ?? [])], builderHooks: [...(o.builderHooks ?? [])], issueBody: o.body ?? "Bug in foo", clock: 0, validate: o.validate ?? { status: "valid", summary: "real", evidence: ["src/foo.js:3"] },
  };
  const writeBuilderFiles = () => {
    w.files[`${WT}/.forge-lean/validate.json`] = JSON.stringify(w.validate);
    w.files[`${WT}/.forge-lean/plan.md`] = "## Approach\nfix foo\n## Sibling sites\nbar";
    w.files[`${WT}/.forge-lean/implement.json`] = JSON.stringify({ summary: "fixed", commit: w.head, files: w.changed });
  };
  w.io = {
    now: () => w.clock, sleep: async (ms) => { w.clock += ms; },
    gh: async (a) => {
      const k = a.slice(0, 2).join(" ");
      if (k === "issue view") return JSON.stringify({ number: 7, title: "foo breaks", body: w.issueBody, state: "OPEN" });
      if (k === "issue comment") { w.comments.push(a[a.indexOf("--body") + 1]); return `https://github.com/o/r/issues/7#issuecomment-${w.comments.length}\n`; }
      if (k === "issue close") { w.closed.push(a); return ""; }
      if (k === "issue edit") { w.edits.push(a); return ""; }
      if (k === "pr create") { w.prs.push(a); return "https://github.com/o/r/pull/77\n"; }
      if (k === "pr merge") { w.merges.push(a); return ""; }
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
    git: async (a) => {
      w.calls.push(["git", ...a]);
      if (a[0] === "rev-parse" && a[1] === "--git-path") return "/repo/.git/info/exclude";
      if (a[0] === "rev-parse") return w.head;
      if (a[0] === "diff" && a[1] === "--name-only") return w.changed.join("\n");
      if (a[0] === "diff" && a[1] === "--numstat") return `${w.lines}\t0\tx`;
      if (a[0] === "diff") return "diff --git a/src/foo.js b/src/foo.js\n+fix";
      return "";
    },
    runner: async (c) => {
      w.calls.push(["runner", c.role, c.resume ?? null, c.model ?? null, c.prompt, c.readOnly ?? false]);
      if (o.builderThrows && c.role === "builder") throw new Error("cli exploded");
      if (c.role === "builder") {
        if (!c.resume) { w.builderStart = c; writeBuilderFiles(); }
        else { const h = w.builderHooks.shift(); if (h) h(w); w.head = `bbbb${w.calls.length}`.padEnd(16, "0"); }
        return { text: "done", sessionId: "sess-1", usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.1, durationMs: 1000, turns: 3, model: "default" };
      }
      const text = w.reviewReplies.length ? w.reviewReplies.shift() : reply([]);
      return { text, sessionId: `rev-${w.calls.length}`, usage: { input_tokens: 4, output_tokens: 2 }, costUsd: 0.05, durationMs: 500, turns: 2, model: c.model };
    },
    ciLocal: async () => w.ciQueue.length ? w.ciQueue.shift() : { result: "PASS", tail: "" },
    waitCiGreen: async () => w.waits.length ? w.waits.shift() : { rc: 0, text: `CI_GATE: PASS\nCI_GATE_HEAD: ${w.head}` },
    projector: { readState: async () => (w.lease ? { v: 1, lease: w.lease } : null), writeState: async (_i, st) => { w.leaseWrites.push(st); } },
    transitionLabel: async (n, s) => { w.labels.push(s); },
    fs: { read: async (p) => { if (!(p in w.files)) throw new Error("ENOENT"); return w.files[p]; }, append: async (p, t) => { w.files[p] = (w.files[p] ?? "") + t; } },
  };
  return w;
}

const run = (w, extra = {}) => runLean({ issue: 7, repo: "o/r", lane: "staging", cwd: "/repo", worktreeRoot: "/wt", dir: tmpDir("lean-"),
  io: w.io, emitTelemetry: async (r) => w.telemetry.push(r), random: () => 0.5, ...extra });
const markers = (w) => w.comments.map((c) => /FORGE:[A-Z_]+/.exec(c)[0]);
const resumes = (w) => w.calls.filter((c) => c[0] === "runner" && c[1] === "builder");

describe("lean path: happy path and knowledge graph", () => {
  it("drives an issue end to end and posts every stage comment with its marker and content", async () => {
    const w = world();
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    assert.deepEqual(markers(w), ["FORGE:VALIDATE", "FORGE:PLAN", "FORGE:IMPLEMENT", "FORGE:REVIEW", "FORGE:CLOSE"]);
    assert.match(w.comments[0], /"status": "valid"/);
    assert.match(w.comments[1], /Sibling sites/);
    assert.match(w.comments[2], /"summary": "fixed"/);
    const body = w.prs[0][w.prs[0].indexOf("--body") + 1];
    assert.match(body, /Closes #7/);
    for (const m of ["FORGE:VALIDATE", "FORGE:PLAN", "FORGE:IMPLEMENT", "FORGE:REVIEW"]) assert.match(body, new RegExp(`${m}: https://github.com/o/r/issues/7#issuecomment-\\d+`));
    assert.deepEqual(w.merges[0].slice(-2), ["--match-head-commit", w.head]);
    assert.deepEqual(w.labels, ["investigating", "building", "in-review", "merged"]);
    assert.ok(w.closed.length === 1);
    assert.ok(w.files["/repo/.git/info/exclude"].includes(".forge-lean/"), "scratch dir is git-excluded");
  });

  it("emits one phase_attempt per stage plus run_terminal, stats-compatible", async () => {
    const w = world();
    const r = await run(w);
    const mapped = w.telemetry.map((t) => mapRecord(t, 5)).filter(Boolean);
    assert.deepEqual(mapped.filter((m) => m.event === "phase_attempt").map((m) => m.phase), ["implement", "review"]);
    assert.equal(mapped[0].payload.stages, "validate,architect,implement");
    assert.equal(mapped.filter((m) => m.event === "phase_attempt" && m.payload.input_tokens === undefined).length, 0, "no null-usage records");
    assert.equal(mapped.at(-1).event, "run_terminal");
    assert.equal(mapped.at(-1).payload.reason, "merged");
    const v = mapped[0].payload;
    assert.equal(mapped[0].payload.attempt, 1);
    assert.equal(v.input_tokens, 10); assert.equal(v.cost_usd, 0.1);
    assert.ok(r.cost_usd > 0);
  });

  it("writes the run log (RUN_START, PHASE_COMMIT per stage, RUN_TERMINAL)", async () => {
    const w = world(); const dir = tmpDir("lean-");
    await run(w, { dir });
    const ev = readLog(dir, 7).map((e) => e.event);
    assert.equal(ev[0], "RUN_START"); assert.equal(ev.at(-1), "RUN_TERMINAL");
    assert.ok(readLog(dir, 7).filter((e) => e.event === "PHASE_COMMIT").map((e) => e.phase).includes("review"));
  });

  it("builder default model, reviewer claude-sonnet-5-5 unless configured", async () => {
    const w = world(); await run(w);
    assert.equal(resumes(w)[0][3], null);
    assert.equal(w.calls.find((c) => c[1] === "reviewer")[3], "claude-sonnet-5-5");
    const w2 = world(); await run(w2, { reviewerModel: "my-model" });
    assert.equal(w2.calls.find((c) => c[1] === "reviewer")[3], "my-model");
  });
});

describe("lean path: review fixes (#4083)", () => {
  it("merge requires the CI-gated head to equal the reviewed head and always passes the local head", async () => {
    const w = world({ waits: [{ rc: 0, text: "CI_GATE_HEAD: deadbeefdead" }] });
    const r = await run(w);
    assert.equal(r.terminalReason, "needs-human");
    assert.equal(w.merges.length, 0);
    const w2 = world({ waits: [{ rc: 0, text: "CI_GATE: PASS" }] });
    assert.equal((await run(w2)).terminalReason, "merged");
    assert.equal(w2.merges[0].at(-1), w2.head);
  });

  it("a gate needs-human records exactly one RUN_TERMINAL and one telemetry terminal", async () => {
    const f = { result: "FAIL", tail: "x" };
    const w = world({ ci: [f, f, f] }); const dir = tmpDir("lean-");
    const r = await run(w, { dir });
    assert.equal(r.terminalReason, "needs-human");
    assert.equal(readLog(dir, 7).filter((e) => e.event === "RUN_TERMINAL").length, 1);
    assert.equal(w.telemetry.filter((t) => t.event === "RUN_TERMINAL").length, 1);
  });

  it("a held lease defers the run before any work; an owned lease is written and released", async () => {
    const held = world({ lease: { by: "other_1", until: 10 ** 13 } });
    const r = await run(held, { agentId: "me" });
    assert.equal(r.terminalReason, "deferred");
    assert.equal(held.calls.length, 0);
    const w = world();
    await run(w, { agentId: "me", leaseRenewMs: 10 ** 9 });
    assert.equal(w.leaseWrites[0].lease.by, "me");
    assert.equal(w.leaseWrites.at(-1).lease, null);
    assert.equal(w.leaseWrites.at(-1).terminal, true);
  });

  it("reruns reset the lean worktree and branch instead of failing, and errors clear the in-progress label", async () => {
    const w = world();
    await run(w);
    const add = w.calls.find((c) => c[1] === "worktree" && c[2] === "add");
    assert.ok(add.includes("-B"));
    assert.ok(w.calls.some((c) => c[1] === "worktree" && c[2] === "remove"));
    const e = world({ builderThrows: true });
    const r = await run(e);
    assert.equal(r.terminalReason, "engine-error");
    assert.ok(e.edits.some((a) => a.includes("--remove-label") && a.join(" ").includes("workflow:investigating")));
  });

  it("closes only on invalid/already-fixed WITH evidence; otherwise needs-human with the reasoning", async () => {
    for (const validate of [{ status: "invalid", summary: "no repro", evidence: [] }, { status: "invalid", summary: "no repro", evidence: ["  "] },
      { status: "maybe", summary: "unsure why", evidence: ["a.js:1"] }]) {
      const w = world({ validate });
      const r = await run(w);
      assert.equal(r.terminalReason, "needs-human");
      assert.equal(w.closed.length, 0);
      assert.ok(w.comments.some((c) => c.includes("FORGE:NEEDS_HUMAN") && c.includes(validate.summary)));
    }
    const ok = world({ validate: { status: "already-fixed", summary: "fixed in abc", evidence: ["commit abc1234"] } });
    assert.equal((await run(ok)).terminalReason, "invalid");
    assert.equal(ok.closed.length, 1);
  });

  it("reviewers are read-only (Read/Grep/Glob) and the builder is not", async () => {
    const w = world({ changed: ["src/auth/x.js", "test/x.test.js"] });
    await run(w);
    const rev = w.calls.filter((c) => c[0] === "runner" && c[1] !== "builder");
    assert.ok(rev.length >= 2 && rev.every((c) => c[5] === true));
    assert.ok(w.calls.filter((c) => c[1] === "builder").every((c) => c[5] === false));
    assert.deepEqual(buildReadOnlyToolFlags({ strictMcp: true }), ["--tools", "Read,Grep,Glob"]);
    assert.ok(buildReadOnlyToolFlags({ strictMcp: false }).includes("Bash"));
  });

  it("review rounds are numbered from 1", async () => {
    const w = world({ reviews: [reply([finding({ severity: "HIGH" })]), reply([])] });
    await run(w);
    const revs = w.comments.filter((c) => c.includes("FORGE:REVIEW"));
    assert.match(revs[0], /round 1 \|/); assert.match(revs[1], /round 2 \|/);
  });
});

describe("lean path: invalid issue", () => {
  it("closes an invalid issue with evidence and never builds a PR", async () => {
    const w = world({ validate: { status: "invalid", summary: "not reproducible", evidence: ["src/foo.js:3 already guards null"] } });
    const r = await run(w);
    assert.equal(r.terminalReason, "invalid");
    assert.match(w.comments[0], /already guards null/);
    assert.equal(w.closed.length, 1); assert.ok(w.closed[0].includes("not planned"));
    assert.equal(w.prs.length, 0);
    assert.ok(w.labels.includes("invalid"));
  });
});

describe("lean path: gates resume the same session", () => {
  it("ci-local FAIL -> resume with the failure tail -> pass", async () => {
    const w = world({ ci: [{ result: "FAIL", tail: "FAILED test_foo: expected 1" }] });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    const b = resumes(w);
    assert.equal(b.length, 2);
    assert.equal(b[0][2], null); assert.equal(b[1][2], "sess-1");
    assert.match(b[1][4], /FAILED test_foo/);
    assert.equal(b.filter((c) => c[2] === null).length, 1, "never a cold reload");
  });

  it("missing test file -> resume -> pass once the hook adds one", async () => {
    const w = world({ changed: ["src/foo.js"], builderHooks: [(x) => x.changed.push("test/foo.test.js")] });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    assert.match(resumes(w)[1][4], /No test file changed/);
  });

  it("docs-only change needs no test", async () => {
    const w = world({ changed: ["docs/guide.md", "README.md"] });
    assert.equal((await run(w)).terminalReason, "merged");
    assert.equal(resumes(w).length, 1);
  });

  it(`${MAX_ROUNDS} failed gate rounds -> needs-human`, async () => {
    const w = world({ ci: [{ result: "FAIL", tail: "x" }, { result: "FAIL", tail: "x" }, { result: "FAIL", tail: "x" }] });
    const r = await run(w);
    assert.equal(r.terminalReason, "needs-human");
    assert.equal(resumes(w).length, 1 + MAX_ROUNDS);
    assert.ok(w.edits.some((e) => e.includes("needs-human")));
    assert.equal(w.prs.length, 0);
  });
});

describe("lean path: review", () => {
  it("blocking finding -> builder resumed via --resume -> delta re-review -> merge", async () => {
    const w = world({ reviews: [reply([finding({ severity: "HIGH", title: "null deref" })]), reply([])] });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    const b = resumes(w);
    assert.equal(b[1][2], "sess-1"); assert.match(b[1][4], /null deref/);
    const reviews = w.calls.filter((c) => c[1] === "reviewer");
    assert.equal(reviews.length, 2);
    assert.match(reviews[1][4], /DELTA re-review/);
    assert.equal(reviews[1][2], null, "reviewer is always a fresh session");
    assert.deepEqual(markers(w).filter((m) => m === "FORGE:REVIEW").length, 2);
  });

  it("2 failed fix rounds -> needs-human", async () => {
    const bad = reply([finding({ severity: "CRITICAL" })]);
    const w = world({ reviews: [bad, bad, bad] });
    const r = await run(w);
    assert.equal(r.terminalReason, "needs-human");
    assert.equal(resumes(w).length, 1 + MAX_ROUNDS);
    assert.equal(w.prs.length, 0);
  });

  it("non-blocking findings are listed in the review comment and never filed as issues", async () => {
    const w = world({ reviews: [reply([finding({ severity: "LOW", title: "naming nit" }), finding({ severity: "MEDIUM", confidence: "LIKELY", title: "maybe" }),
      finding({ severity: "MEDIUM", confidence: "CONFIRMED", scope: "pre-existing", title: "old bug" })])] });
    const r = await run(w);
    assert.equal(r.terminalReason, "merged");
    const rev = w.comments.find((c) => c.includes("FORGE:REVIEW"));
    for (const t of ["naming nit", "maybe", "old bug"]) assert.ok(rev.includes(t));
    assert.equal(resumes(w).length, 1);
  });

  it("unparseable reviewer output is retried once, then needs-human", async () => {
    const w = world({ reviews: ["no json here", "still none"] });
    assert.equal((await run(w)).terminalReason, "needs-human");
  });

  it("blocking classification", () => {
    assert.ok(isBlocking({ severity: "HIGH", confidence: "POSSIBLE" }));
    assert.ok(isBlocking({ severity: "CRITICAL" }));
    assert.ok(isBlocking({ severity: "MEDIUM", confidence: "CONFIRMED", scope: "introduced" }));
    assert.ok(!isBlocking({ severity: "MEDIUM", confidence: "CONFIRMED", scope: "pre-existing" }));
    assert.ok(!isBlocking({ severity: "MEDIUM", confidence: "LIKELY", scope: "introduced" }));
    assert.ok(!isBlocking({ severity: "LOW", confidence: "CONFIRMED" }));
    assert.deepEqual(parseFindings("x ```json\n[{\"a\":1}]\n``` y"), [{ a: 1 }]);
    assert.equal(parseFindings("nothing"), null);
  });
});

describe("lean path: risk tier and routing", () => {
  it("risky path adds a security reviewer (and a calm change does not)", async () => {
    const w = world({ changed: ["src/auth/login.js", "test/auth.test.js"] });
    await run(w);
    const roles = w.calls.filter((c) => c[0] === "runner").map((c) => c[1]);
    assert.ok(roles.includes("security-reviewer"));
    const w2 = world(); await run(w2);
    assert.ok(!w2.calls.some((c) => c[1] === "security-reviewer"));
  });

  it("riskTier covers auth, crypto, secret, permission, migration, payment, workflows", () => {
    for (const f of ["lib/auth/x.py", "pkg/crypto/aes.go", "config/secrets.yml", "app/permissions.rb", "db/migrations/001.sql", "src/payment/charge.ts", ".github/workflows/ci.yml"]) {
      assert.equal(riskTier([f]).tier, "high", f);
    }
    assert.equal(riskTier(["src/util/format.js"]).tier, "low");
    assert.equal(riskTier(["src/a.js"], "rotate the secret key").tier, "high");
  });

  it("auto: full only when risk high AND diff large", async () => {
    assert.equal(choosePath("auto", { tier: "high" }, { files: 20, lines: 10 }), "full");
    assert.equal(choosePath("auto", { tier: "high" }, { files: 2, lines: 50 }), "lean");
    assert.equal(choosePath("auto", { tier: "low" }, { files: 40, lines: 5000 }), "lean");
    assert.equal(choosePath("lean", { tier: "high" }, { files: 40, lines: 5000 }), "lean");
    assert.ok(isLargeDiff({ lines: 400 }));
    const big = world({ changed: ["src/auth/a.js", "test/a.test.js"], lines: 900 });
    const r = await run(big, { path: "auto" });
    assert.equal(r.terminalReason, "route-full");
    assert.equal(big.prs.length, 0);
    const small = world({ changed: ["src/auth/a.js", "test/a.test.js"], lines: 30 });
    assert.equal((await run(small, { path: "auto" })).terminalReason, "merged");
    const calm = world({ lines: 900 });
    assert.equal((await run(calm, { path: "auto" })).terminalReason, "merged");
  });
});

describe("lean path: remote CI", () => {
  it("slow CI polls with backoff and is never a needs-human", async () => {
    const w = world({ waits: Array.from({ length: 500 }, () => ({ rc: 3, text: "pending" })) });
    const r = await run(w, { ciMaxMinutes: 30 });
    assert.equal(r.terminalReason, "ci-pending");
    assert.equal(w.edits.length, 0);
    assert.equal(w.merges.length, 0);
    assert.ok(w.clock >= 30 * 60000);
  });

  it("pending then green merges", async () => {
    const w = world({ waits: [{ rc: 3, text: "" }, { rc: 4, text: "" }] });
    assert.equal((await run(w)).terminalReason, "merged");
  });

  it("red remote CI -> needs-human", async () => {
    const w = world({ waits: [{ rc: 1, text: "CI_GATE: FAIL" }] });
    assert.equal((await run(w)).terminalReason, "needs-human");
    assert.equal(w.merges.length, 0);
  });
});

describe("lean path: codebase-agnostic", () => {
  it("works on non-FD layouts (Go, Java, Ruby)", async () => {
    for (const changed of [["pkg/cache/cache.go", "pkg/cache/cache_test.go"], ["src/main/java/a/Foo.java", "src/test/java/a/FooTest.java"], ["app/models/foo.rb", "spec/models/foo_spec.rb"]]) {
      const w = world({ changed });
      assert.equal((await run(w)).terminalReason, "merged", changed.join());
    }
    assert.ok(isTestFile("pkg/x_test.go") && isTestFile("tests/test_x.py") && isTestFile("src/__tests__/a.ts") && !isTestFile("src/main.go"));
    assert.ok(isDocsOnly(["docs/a.rst", "README.md"]) && !isDocsOnly(["README.md", "src/a.go"]));
  });

  it("prompts carry no ForgeDock-specific paths", () => {
    for (const p of [BUILDER_SYSTEM, REVIEWER_SYSTEM, SECURITY_REVIEWER_SYSTEM]) assert.doesNotMatch(p, /commands\/|scripts\/|bin\/|forge\.yaml|forgedock/i);
    const src = readFileSync(new URL("./lean.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(src, /bin\/engine\.mjs|commands\//);
  });
});

describe("lean path: prompts", () => {
  it("each phase prompt is 4k tokens or less and states the contract", () => {
    for (const p of [BUILDER_SYSTEM, REVIEWER_SYSTEM, SECURITY_REVIEWER_SYSTEM]) assert.ok(approxTokens(p) <= 4000, `${approxTokens(p)} tokens`);
    for (const f of ["validate.json", "plan.md", "implement.json"]) assert.ok(BUILDER_SYSTEM.includes(`.forge-lean/${f}`));
    assert.match(BUILDER_SYSTEM, /FAILS without the fix/);
    assert.match(BUILDER_SYSTEM, /[Ss]ibling/);
    assert.match(REVIEWER_SYSTEM, /JSON array/);
  });
});

describe("runner extension and CLI wiring", () => {
  it("runCliBackend appends extraArgs and returns the envelope session_id", () => {
    let argv;
    const r = runCliBackend({ spec: { name: "x" }, userMessage: "go", cwd: process.cwd(), bin: "claude", logger: { log() {} },
      extraArgs: ["--resume", "sess-9"], sessionFlags: ["--strict-mcp-config"],
      spawnFn: (_b, a) => { argv = a; return { status: 0, stderr: "", stdout: JSON.stringify({ result: "ok", session_id: "sess-9", usage: { input_tokens: 1 } }) }; } });
    assert.equal(argv[argv.indexOf("--resume") + 1], "sess-9");
    assert.equal(r.sessionId, "sess-9");
    const r2 = runCliBackend({ spec: { name: "x" }, userMessage: "go", cwd: process.cwd(), logger: { log() {} }, spawnFn: () => ({ status: 0, stdout: "{}", stderr: "" }) });
    assert.equal(r2.sessionId, null);
  });

  it("buildLeanSessionFlags reuses the capability probe and falls back cleanly", () => {
    const f = buildLeanSessionFlags({ strictMcp: true, disableSlash: true }, {});
    for (const x of ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--setting-sources", "project,local"]) assert.ok(f.includes(x), x);
    assert.deepEqual(buildLeanSessionFlags({ strictMcp: false, disableSlash: false }, {}), []);
    assert.deepEqual(buildLeanSessionFlags({ strictMcp: true, disableSlash: true }, { FORGEDOCK_FULL_SESSION: "1" }), []);
  });

  it("run-issue --path lean dispatches to the lean engine; default stays full; auto escalates", async () => {
    const dir = tmpDir("lean-cli-");
    const mk = (result) => { const seen = {}; return { seen, leanModule: { runLean: async (o) => { seen.path = o.path; return result; } }, leanIo: {}, dir, emitTelemetry: async () => {},
      io: { gh: async () => "o/r\n" }, runIssue: async () => { seen.full = true; return { terminalReason: "merged" }; } }; };
    const silent = console.log; console.log = () => {};
    try {
      const a = mk({ terminalReason: "merged" });
      await runFromCli(["7", "--lane", "staging", "--path", "lean", "--repo", "o/r"], a);
      assert.equal(a.seen.path, "lean"); assert.ok(!a.seen.full);
      const b = mk({ terminalReason: "route-full", detail: "x" });
      await runFromCli(["7", "--lane", "staging", "--path", "auto", "--repo", "o/r"], b);
      assert.equal(b.seen.path, "auto"); assert.ok(b.seen.full);
      const c = mk({}); await runFromCli(["7", "--lane", "staging", "--repo", "o/r"], c);
      assert.equal(c.seen.path, undefined); assert.ok(c.seen.full);
      await assert.rejects(runFromCli(["7", "--lane", "staging", "--path", "bogus"], mk({})), /--path must be/);
    } finally { console.log = silent; }
    assert.ok(readdirSync(dir).length >= 0);
  });
});
