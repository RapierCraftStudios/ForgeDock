// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { formatFirstPassSummary } from "./fixround.mjs";
import { runChecks, formatPrecheckSummary, planPrecheck, selfCheck, selfCheckState, formatCheckTable, worktreeFingerprint } from "./precheck.mjs";
import { execFileSync } from "node:child_process";
import { readPrecheckBudget } from "../engine-cli.mjs";
import { orchestrate } from "./orchestrate.mjs";

/** A fake run: each call takes `cost[command]` ms of the shared clock (default 1000) and returns rc[command] (default 0). */
function harness({ cost = {}, rc = {} } = {}) {
  const h = { t: 0, live: 0, peak: 0, calls: [] };
  h.now = () => h.t;
  h.run = async ({ command, timeoutMs }) => {
    h.calls.push([command, timeoutMs]); h.peak = Math.max(h.peak, ++h.live);
    await new Promise((r) => setImmediate(r));
    const c = cost[command] ?? 1000;
    h.t += Math.min(c, timeoutMs); h.live--;
    return c > timeoutMs ? { rc: 124, output: "timed out" } : { rc: rc[command] ?? 0, output: `${command} out` };
  };
  return h;
}

describe("runChecks (#4331)", () => {
  it("runs up to `parallelism` commands at once and returns results in input order with ms", async () => {
    const h = harness();
    const r = await runChecks({ commands: ["a", "b", "c", "d", "e"], parallelism: 3, budgetMs: 600000, perCommandMs: 300000, now: h.now, run: h.run });
    assert.equal(h.peak, 3);
    assert.deepEqual(r.results.map((x) => x.command), ["a", "b", "c", "d", "e"]);
    assert.ok(r.results.every((x) => x.rc === 0 && Number.isFinite(x.ms) && x.ms >= 0));
    assert.deepEqual(r.deferred, []);
    assert.ok(r.ms > 0);
  });

  it("parallelism 1 is serial; 0, NaN or missing fall back to 1", async () => {
    for (const p of [1, 0, NaN, undefined, "x"]) {
      const h = harness();
      await runChecks({ commands: ["a", "b", "c"], parallelism: p, budgetMs: 600000, perCommandMs: 300000, now: h.now, run: h.run });
      assert.equal(h.peak, 1, String(p));
    }
  });

  it("past the budget the remaining commands are deferred to CI, not failed; a running one gets what is left", async () => {
    const h = harness();
    const r = await runChecks({ commands: ["a", "b", "c"], parallelism: 1, budgetMs: 1500, perCommandMs: 300000, now: h.now, run: h.run });
    assert.deepEqual(h.calls, [["a", 1500], ["b", 500]]);
    assert.deepEqual(r.results.map((x) => [x.command, x.rc]), [["a", 0]], "b was cut by the budget (rc 124): deferred, not a failure");
    assert.deepEqual(r.deferred, ["b", "c"]);
  });

  it("a command's own timeout (not the budget) stays a failure; a throw is rc 127", async () => {
    const h = harness({ cost: { slow: 5000 } });
    const r = await runChecks({ commands: ["slow", "boom", "bad"], parallelism: 2, budgetMs: 600000, perCommandMs: 2000, now: h.now,
      run: (a) => (a.command === "boom" ? Promise.reject(new Error("spawn failed")) : a.command === "bad" ? Promise.resolve({ rc: 2, output: "lint" }) : h.run(a)) });
    assert.deepEqual(r.results.map((x) => [x.command, x.rc]), [["slow", 124], ["boom", 127], ["bad", 2]]);
    assert.match(r.results[1].output, /spawn failed/);
    assert.deepEqual(r.deferred, []);
  });

  it("no commands: nothing runs", async () => {
    let n = 0;
    const r = await runChecks({ commands: [], parallelism: 4, budgetMs: 1000, perCommandMs: 1000, now: () => 0, run: async () => { n++; return { rc: 0 }; } });
    assert.deepEqual([n, r.results, r.deferred, r.ms], [0, [], [], 0]);
  });
});

describe("runChecks (#4344)", () => {
  /** A fake heavy semaphore: counts live slots, their peak and releases; `wait` ms of the shared clock per acquire. */
  const sem = (h, wait = 0) => { const s = { live: 0, peak: 0, acquired: 0, released: 0 };
    s.acquire = async () => { s.acquired++; s.peak = Math.max(s.peak, ++s.live); h.t += wait; return { release: () => { s.live--; s.released++; } }; }; return s; };

  it("#4344 divides the worker budget across concurrent commands and takes one heavy slot per running command", async () => {
    for (const [n, cmds, share, peak] of [[8, ["a", "b", "c", "d", "e", "f", "g", "h"], 1, 8], [8, ["a", "b"], 4, 2], [6, ["a", "b", "c", "d"], 1, 4], [5, ["a", "b"], 2, 2], [4, ["a"], 4, 1]]) {
      const h = harness(), s = sem(h), seen = [];
      await runChecks({ commands: cmds, parallelism: n, budgetMs: 600000, perCommandMs: 300000, now: h.now, acquire: s.acquire, run: (a) => { seen.push(a.workers); return h.run(a); } });
      assert.ok(seen.every((w) => w === share), `N=${n} k=${cmds.length}: ${seen}`);
      assert.ok(share * h.peak <= n, `round total ${share * h.peak} workers > N=${n}`);
      assert.deepEqual([s.peak, s.acquired, s.released, s.live], [peak, cmds.length, cmds.length, 0], `N=${n} slots`);
    }
  });

  it("#4344 FORGE_HOST_PARALLELISM=1: one command at a time, one worker, one slot", async () => {
    const h = harness(), s = sem(h), seen = [];
    await runChecks({ commands: ["a", "b", "c"], parallelism: 1, budgetMs: 600000, perCommandMs: 300000, now: h.now, acquire: s.acquire, run: (a) => { seen.push(a.workers); return h.run(a); } });
    assert.deepEqual([h.peak, s.peak, seen], [1, 1, [1, 1, 1]]);
  });

  it("#4344 the slot wait counts against the budget: a command whose wait exhausts it is deferred, its slot released", async () => {
    const h = harness(), s = sem(h, 1000);
    const r = await runChecks({ commands: ["a", "b"], parallelism: 1, budgetMs: 2500, perCommandMs: 300000, now: h.now, acquire: s.acquire, run: h.run });
    assert.deepEqual(h.calls, [["a", 1500]]);
    assert.deepEqual([r.results.map((x) => x.command), r.deferred], [["a"], ["b"]]);
    assert.deepEqual([s.acquired, s.released], [2, 2]);
  });

  it("#4344 a throwing acquire runs the command ungated; a throwing release is ignored", async () => {
    const h = harness();
    const r1 = await runChecks({ commands: ["a"], parallelism: 2, budgetMs: 600000, perCommandMs: 300000, now: h.now, acquire: async () => { throw new Error("registry"); }, run: h.run });
    const r2 = await runChecks({ commands: ["b"], parallelism: 2, budgetMs: 600000, perCommandMs: 300000, now: h.now, acquire: async () => ({ release: () => { throw new Error("x"); } }), run: h.run });
    assert.deepEqual([...r1.results, ...r2.results].map((x) => [x.command, x.rc]), [["a", 0], ["b", 0]]);
  });
});

describe("formatPrecheckSummary (#4331)", () => {
  it("sums precheck_ms over the lanes that ran checks and counts deferrals; null when none did", () => {
    assert.equal(formatPrecheckSummary([{ precheck_ms: 90000 }, { precheck_ms: 30000, precheck_deferred: 2 }, { issue: 3 }]), "precheck: 2.0m total over 2 lanes, 2 deferred to CI");
    assert.equal(formatPrecheckSummary([{ precheck_ms: 6000 }]), "precheck: 0.1m total over 1 lane");
    assert.equal(formatPrecheckSummary([{ issue: 1 }]), null);
    assert.equal(formatPrecheckSummary(undefined), null);
  });
  it("orchestrate rows carry the lane's precheckMs/precheckDeferred as precheck_ms/precheck_deferred for the report line", async () => {
    const rows = await orchestrate({ issues: [1, 2, 3], parallel: 1, readBody: async () => "",
      runOne: async (n) => ({ terminalReason: "merged", ...({ 1: { precheckMs: 90000, precheckDeferred: 1 }, 2: { precheckMs: 30000, precheckDeferred: 0 } })[n] }) });
    assert.deepEqual(rows.map((r) => [r.issue, r.precheck_ms, r.precheck_deferred]), [[1, 90000, 1], [2, 30000, undefined], [3, undefined, undefined]]);
    assert.equal(formatPrecheckSummary(rows), "precheck: 2.0m total over 2 lanes, 1 deferred to CI");
  });
  it("#4362: orchestrate rows carry the lane's firstPass as first_pass for the batch first-pass line", async () => {
    const rows = await orchestrate({ issues: [1, 2, 3], parallel: 1, readBody: async () => "",
      runOne: async (n) => ({ terminalReason: "merged", ...({ 1: { firstPass: true }, 2: { firstPass: false } })[n] }) });
    assert.deepEqual(rows.map((r) => [r.issue, r.first_pass]), [[1, true], [2, false], [3, undefined]]);
    assert.equal(formatFirstPassSummary(rows), "first-pass: 50% (1/2 lanes that reached the build)");
  });
});

describe("readPrecheckBudget: forge.yaml lean.precheck.max_minutes (#4331)", () => {
  const withYaml = (text, fn) => { const d = tmpDir("precheck-"); writeFileSync(join(d, "forge.yaml"), text); return fn(d); };
  it("reads the nested block and the flat key; invalid or absent is undefined", () => {
    assert.equal(withYaml("lean:\n  precheck:\n    max_minutes: 7\n", readPrecheckBudget), 7);
    assert.equal(withYaml("lean:\n  precheck_max_minutes: 15\n  repro_test: off\n", readPrecheckBudget), 15);
    for (const bad of ["0", "-1", "abc", "121"]) assert.equal(withYaml(`lean:\n  precheck_max_minutes: ${bad}\n`, readPrecheckBudget), undefined, bad);
    assert.equal(withYaml("verify:\n  mode: local\n", readPrecheckBudget), undefined);
    assert.equal(readPrecheckBudget(tmpDir("precheck-")), undefined);
  });
});

describe("forgedock check core (#4364)", () => {
  const MAP = { version: 1, entries: [{ globs: ["src/**"], command: "npm test", cwd: "." }, { globs: ["docs/**"], command: "make docs", cwd: "." }] };

  it("planPrecheck: the engine's selection and budget rule (max_minutes wins, else precheck_total_seconds, else 600 s)", () => {
    const p = planPrecheck({ testMap: MAP, files: ["src/a.js"], learned: [" make lint ", "", "make docs"], verify: { precheckTotalSeconds: 120, precheckTimeoutSeconds: 30 } });
    assert.deepEqual(p.commands, ["make lint", "npm test"]); assert.deepEqual(p.dropped, ["make docs"]);
    assert.equal(p.selected, 1); assert.equal(p.budgetMs, 120000); assert.equal(p.perCommandMs, 30000);
    assert.equal(planPrecheck({ learned: ["x"], maxMinutes: 2, verify: { precheckTotalSeconds: 999 } }).budgetMs, 120000);
    assert.equal(planPrecheck({ learned: ["x"], maxMinutes: 3, verify: {} }).budgetMs, 180000);
    assert.deepEqual(planPrecheck({ learned: ["x"], verify: {} }), { commands: ["x"], added: 0, dropped: [], source: "learned", selected: 0, budgetMs: 600000, perCommandMs: 300000 });
  });

  it("selfCheck runs validates then pre-PR commands; ok only when every run exits 0; ci mode leaves validates to CI", async () => {
    const h = harness({ rc: { "make lint": 2 } });
    const contract = { validate: [{ id: "V1", command: "node --test a" }, { id: "V2", command: " " }] };
    const plan = { mode: "local", commands: ["npm test", "make lint"], budgetMs: 600000, perCommandMs: 300000 };
    const r = await selfCheck({ contract, plan, now: h.now, run: h.run });
    assert.deepEqual(h.calls.map((c) => c[0]), ["node --test a", "npm test", "make lint"]);
    assert.deepEqual(r.validate.map((x) => [x.id, x.rc]), [["V1", 0]]); assert.deepEqual(r.commands.map((x) => x.rc), [0, 2]); assert.equal(r.ok, false);
    const h2 = harness();
    const r2 = await selfCheck({ contract, plan: { ...plan, mode: "ci" }, now: h2.now, run: h2.run });
    assert.deepEqual(h2.calls.map((c) => c[0]), ["npm test", "make lint"]); assert.deepEqual(r2.validate, [{ id: "V1", command: "node --test a", status: "ci" }]); assert.equal(r2.ok, true);
    const h3 = harness({ cost: { "npm test": 5000 } });
    const r3 = await selfCheck({ contract: {}, plan: { commands: ["npm test", "make lint"], budgetMs: 4000, perCommandMs: 300000 }, now: h3.now, run: h3.run });
    assert.deepEqual(r3.deferred, ["npm test", "make lint"]); assert.equal(r3.ok, true, "deferred to CI is not a failure, as in the engine");
  });

  it("selfCheckState and formatCheckTable", () => {
    assert.equal(selfCheckState(null, "f"), "skipped"); assert.equal(selfCheckState({ fingerprint: "g", ok: true }, "f"), "stale");
    assert.equal(selfCheckState({ fingerprint: "f", ok: false }, "f"), "red"); assert.equal(selfCheckState({ fingerprint: "f", ok: true }, "f"), "green");
    const t = formatCheckTable({ ok: false, validate: [{ id: "V1", command: "v", rc: 0, ms: 1200 }], commands: [{ command: "make lint", rc: 2, ms: 10, output: `${"x".repeat(5000)}TAIL` }], deferred: ["slow"] }, 1000);
    assert.match(t, /^PASS +1\.2s {2}V1 v$/m); assert.match(t, /^FAIL exit 2 .* make lint$/m); assert.match(t, /^DEFERRED .* slow$/m);
    assert.match(t, /--- make lint \(exit 2\)\n…x+TAIL/); assert.ok(t.length < 1400, "failure output capped"); assert.match(t, /check: FAIL \(1 failing\)$/);
  });

  it("worktreeFingerprint: the same content committed or not is the same tree; an edit or new file changes it; .forge-lean is ignored", async () => {
    const dir = tmpDir("selfcheck-fp-");
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const g = (a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env });
    g(["init", "-q", "-b", "main"]); writeFileSync(join(dir, "a.js"), "1\n"); writeFileSync(join(dir, "gone.js"), "x\n"); g(["add", "-A"]); g(["commit", "-q", "-m", "base"]);
    g(["branch", "base"]);
    const fp = () => worktreeFingerprint({ git: async (a) => g(a), base: "base" });
    const clean = await fp();
    writeFileSync(join(dir, "a.js"), "2\n"); writeFileSync(join(dir, "new.js"), "n\n"); g(["rm", "-q", "gone.js"]);
    const dirty = await fp(); assert.notEqual(dirty, clean);
    execFileSync("mkdir", ["-p", join(dir, ".forge-lean")]); writeFileSync(join(dir, ".forge-lean", "result.json"), "{}");
    g(["add", "-A"]); g(["reset", "-q", "--", ".forge-lean"]);
    writeFileSync(join(dir, ".git", "info", "exclude"), ".forge-lean/\n");
    g(["commit", "-q", "-m", "work"]);
    assert.equal(await fp(), dirty, "committing the checked tree does not make the check stale");
    writeFileSync(join(dir, "a.js"), "3\n");
    assert.notEqual(await fp(), dirty);
  });
});
