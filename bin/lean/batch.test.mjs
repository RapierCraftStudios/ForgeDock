// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { orchestrate, deferPolicy, DEFER_BACKOFF_S } from "./orchestrate.mjs";
import { openBatch, fsTypeOf, assertDiskPath, isLaneAlive, writeAtomic, launchLane } from "./batch.mjs";
import { orchestrateFromCli, runFromCli, readOrchestration, makeRelabelNeedsHuman } from "../engine-cli.mjs";

// orchestrateFromCli opens the host lane registry (#4191): keep it in a temp dir, also for spawned dispatchers.
process.env.FORGEDOCK_SCHED_DIR = tmpDir("batch-sched-");
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const until = async (cond, ms = 15000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 25)); }
};
// A fake clock: `sleep` advances it, so delays are asserted without waiting.
const fakeClock = () => { const c = { t: 1_000_000 }; return { c, now: () => c.t, sleep: async (ms) => { c.t += ms; } }; };

describe("durable batch runner (#4121)", () => {
  it("killing the dispatcher mid-batch and --resume re-adopts live lanes and finishes without duplicate launches", async () => {
    const work = tmpDir("batch-int-");
    const root = join(work, "batches");
    const launches = join(work, "launches"), release = join(work, "release");
    writeFileSync(launches, "");
    // Stub lane: records its launch, waits for the release file, then writes its result like `run-issue --result-file`.
    const stub = join(work, "stub-lane.mjs");
    writeFileSync(stub, `import { appendFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
const a = process.argv.slice(2); const n = Number(a[1]); const rf = a[a.indexOf("--result-file") + 1];
appendFileSync(${JSON.stringify(launches)}, n + "\\n");
const t = setInterval(() => { if (!existsSync(${JSON.stringify(release)})) return; clearInterval(t);
  writeFileSync(rf + ".tmp", JSON.stringify({ terminalReason: "merged", pr: 100 + n, cost_usd: 0 })); renameSync(rf + ".tmp", rf); }, 20);
`);
    const depsSrc = `{ batchRoot: ${JSON.stringify(root)}, batchId: "bt1", allowTmpfs: true, laneScript: ${JSON.stringify(stub)}, pollMs: 30,
      orchestration: { breaker: null, maxDeferrals: 3 }, io: { gh: async () => "o/r\\n" },
      leanIo: { gh: async (a) => a.includes("milestone") ? JSON.stringify({ milestone: null }) : a[0] === "repo" ? "main\\n" : JSON.stringify({ body: a[2] === "3" ? "Depends on #1" : "" }),
        git: async (a) => (a[0] === "ls-remote" ? "abc\\trefs/heads/staging\\n" : "") } }`;
    const dispatcher = join(work, "dispatcher.mjs");
    writeFileSync(dispatcher, `import { orchestrateFromCli } from ${JSON.stringify(new URL("../engine-cli.mjs", import.meta.url).href)};
await orchestrateFromCli(["1", "2", "3", "--parallel", "2", "--repo", "o/r", "--no-prefilter"], ${depsSrc});
`);
    const batch = openBatch(root, "bt1");
    const pids = () => Object.values(batch.store.load()?.running ?? {}).map((r) => r.pid).filter(Boolean);
    let lanePids = [];
    try {
      const child = spawn(process.execPath, [dispatcher], { stdio: "ignore" });
      const exited = new Promise((r) => child.on("exit", r));
      await until(() => readFileSync(launches, "utf8").trim().split("\n").filter(Boolean).length === 2 && pids().length === 2);
      lanePids = pids();
      child.kill("SIGKILL");
      await exited;
      // The lanes run in their own session: the dispatcher's death did not take them down.
      for (const pid of lanePids) assert.equal(isLaneAlive(pid, null), true, `lane ${pid} survived`);
      const deps = (await import(`data:text/javascript,export default ${encodeURIComponent(depsSrc)}`)).default;
      const resumed = quiet(() => orchestrateFromCli(["--resume", "bt1"], deps));
      setTimeout(() => writeFileSync(release, ""), 200);
      const res = await resumed;
      assert.deepEqual(res.rows.map((r) => [r.issue, r.outcome, r.pr]), [[1, "merged", 101], [2, "merged", 102], [3, "merged", 103]]);
      assert.deepEqual(readFileSync(launches, "utf8").trim().split("\n").map(Number).sort(), [1, 2, 3]); // no duplicate launch
      assert.deepEqual(batch.store.load().running, {});
    } finally {
      writeFileSync(release, "");
      for (const pid of lanePids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  });

  it("deferred codes are requeued with their own delay; non-host deferrals stop at the cap", async () => {
    const { now, sleep } = fakeClock();
    const seq = [
      { code: "host.busy", retryInSeconds: 60 },
      { code: "rate_limited", resetAtEpochMs: null, retryInSeconds: 600 },
      { code: "merge.transient" },
      { code: "push.transient" },
      { code: "cli.idle" },
    ];
    const starts = [];
    const rows = await orchestrate({ issues: [1], readBody: async () => "", now, sleep, maxDeferrals: 3,
      runOne: async () => { starts.push(now()); const d = seq.shift(); return { terminalReason: "deferred", detail: d.code, ...d }; } });
    const gaps = starts.slice(1).map((t, i) => (t - starts[i]) / 1000);
    assert.deepEqual(gaps, [60, 600, DEFER_BACKOFF_S * 2, DEFER_BACKOFF_S * 4]);
    assert.equal(rows[0].outcome, "deferred");
    assert.match(rows[0].detail, /gave up after 3 deferrals/);
    // the usage-limit reset time and a lease expiry are honoured
    assert.deepEqual(deferPolicy({ code: "rate_limited", resetAtEpochMs: 5000 }, { now: 1000 }), { delayMs: 4000, hold: true });
    assert.equal(deferPolicy({ code: "lease-held", detail: "leased by x until 1970-01-01T00:01:40.000Z" }, { now: 0 }).delayMs, 105000);
    assert.deepEqual(deferPolicy({ code: "host.busy" }, { now: 0, deferrals: 99 }), { delayMs: 60000, host: true });
  });

  it("gh.unavailable deferrals (forge#4157) are requeued, never relaunched as engine-error, and never trip the breaker", async () => {
    const { now, sleep } = fakeClock();
    const updates = [];
    let calls = 0;
    const rows = await orchestrate({ issues: [1], readBody: async () => "", now, sleep, maxDeferrals: 3, breaker: { errors: 3, window_min: 30 },
      onUpdate: (r) => updates.push(r),
      runOne: async () => (++calls <= 3
        ? { terminalReason: "deferred", code: "gh.unavailable", retryInSeconds: 60, detail: "gh repo view failed" }
        : { terminalReason: "merged", pr: 5 }) });
    assert.equal(calls, 4);
    assert.equal(rows[0].outcome, "merged");
    assert.ok(!updates.some((u) => u.outcome === "breaker" || u.outcome === "engine-error"));
    assert.equal(updates.filter((u) => /requeued in 60s: gh.unavailable/.test(u.detail ?? "")).length, 3);
    assert.deepEqual(deferPolicy({ code: "gh.unavailable", retryInSeconds: 60 }, { now: 0 }), { delayMs: 60000 });
  });

  it("a usage limit holds every admission until its reset; a deferred issue's dependents wait instead of being skipped", async () => {
    const { now, sleep, c } = fakeClock();
    const t0 = c.t, starts = {};
    let limited = true;
    const rows = await orchestrate({ issues: [1, 2, 3], parallel: 1, now, sleep, readBody: async (n) => (n === 3 ? "Blocked by #1" : ""),
      runOne: async (n) => {
        (starts[n] ??= []).push(now());
        if (n === 1 && limited) { limited = false; return { terminalReason: "deferred", code: "rate_limited", resetAtEpochMs: t0 + 600_000 }; }
        return { terminalReason: "merged" };
      } });
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged", "merged"]);
    assert.ok(starts[2][0] >= t0 + 600_000, "no admission during the hold");
    assert.equal(starts[1].length, 2);
  });

  it("the breaker stops admissions after N engine-errors in M minutes and lets running lanes finish", async () => {
    const started = [];
    let releaseSlow;
    const slow = new Promise((r) => { releaseSlow = r; });
    // #3 runs slowly; #1 fails (relaunch queued behind #2, #4), then #2 fails: two errors in the window trip the breaker.
    const rows = await orchestrate({ issues: [3, 1, 2, 4], parallel: 2, breaker: { errors: 2, window_min: 30 }, readBody: async () => "",
      onUpdate: (r) => { if (r.outcome === "breaker") setTimeout(releaseSlow, 10); },
      runOne: async (n) => {
        started.push(n);
        if (n === 3) { await slow; return { terminalReason: "merged", pr: 103 }; }
        throw new Error(`boom ${n}`);
      } });
    assert.deepEqual(started, [3, 1, 2]);
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "held", "held", "held"]);
    assert.match(rows[1].detail, /circuit breaker: 2 engine-errors within 30 min/);
  });

  it("an engine-error is relaunched once; a resume after the breaker continues the held issues", async () => {
    const saved = { state: null };
    const store = { load: () => saved.state, save: (s) => { saved.state = JSON.parse(JSON.stringify(s)); } };
    const runs = [];
    let fail = true;
    const runOne = async (n) => { runs.push(n); if (fail) throw new Error("x"); return { terminalReason: "merged" }; };
    let rows = await orchestrate({ issues: [1, 2, 3], parallel: 1, breaker: { errors: 2, window_min: 30 }, store, readBody: async () => "", runOne });
    assert.deepEqual(runs, [1, 2]); // #1's relaunch is queued behind #2, whose error trips the breaker
    assert.deepEqual(rows.map((r) => r.outcome), ["held", "held", "held"]);
    fail = false;
    saved.state = { ...saved.state, breaker: null, errorTimes: [] }; // what --resume does
    rows = await orchestrate({ issues: [1, 2, 3], parallel: 1, breaker: { errors: 2, window_min: 30 }, store, readBody: async () => "", runOne });
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged", "merged"]);
    assert.deepEqual(runs, [1, 2, 3, 1, 2]);
    // without a breaker an engine-error is relaunched exactly once, then final
    const again = [];
    const [row] = await orchestrate({ issues: [9], readBody: async () => "", runOne: async (n) => { again.push(n); throw new Error("boom"); } });
    assert.deepEqual([again, row.outcome], [[9, 9], "engine-error"]);
  });

  it("#4153 a resume re-derives a pending issue's lane from its current milestone", async () => {
    const saved = { state: null };
    const store = { load: () => saved.state, save: (s) => { saved.state = JSON.parse(JSON.stringify(s)); } };
    const milestoneLane = { 1: "staging", 2: "staging" };
    const resolveLane = async (n) => ({ ok: true, lane: milestoneLane[n] });
    const runs = [];
    let rows = await orchestrate({ issues: [1, 2], parallel: 1, breaker: { errors: 1, window_min: 30 }, store, resolveLane, readBody: async () => "",
      runOne: async (n, lane) => { runs.push([n, lane]); throw new Error("x"); } });
    assert.deepEqual(rows.map((r) => r.outcome), ["held", "held"]);
    assert.equal(saved.state.lanes["2"].lane, "staging");
    milestoneLane[1] = milestoneLane[2] = "milestone/m1"; // the operator re-milestones both issues
    saved.state = { ...saved.state, breaker: null, errorTimes: [] }; // what --resume does
    rows = await orchestrate({ issues: [1, 2], parallel: 1, store, resolveLane, readBody: async () => "",
      runOne: async (n, lane) => { runs.push([n, lane]); return { terminalReason: "merged" }; } });
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged"]);
    assert.deepEqual(runs.slice(1).sort((a, b) => a[0] - b[0]), [[1, "milestone/m1"], [2, "milestone/m1"]]);
    assert.equal(saved.state.lanes["2"].lane, "milestone/m1");
  });

  it("concurrency follows the live K", async () => {
    let k = 1, active = 0, maxActive = 0;
    const rows = await orchestrate({ issues: [1, 2, 3, 4, 5, 6, 7], parallel: 1, pollMs: 5, getParallel: () => k, readBody: async () => "",
      onUpdate: () => { k = 3; },
      runOne: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 15)); active--; return { terminalReason: "merged" }; } });
    assert.equal(maxActive, 3);
    assert.equal(rows.length, 7);
  });

  it("batch files: atomic writes, live K via --set-parallel, tmpfs refused, pid reuse not adopted", async () => {
    const root = tmpDir("batch-files-");
    const b = openBatch(root, "b1");
    b.writePlan({ argv: ["1"] });
    await quiet(() => orchestrateFromCli(["--set-parallel", "b1", "7"], { batchRoot: root }));
    assert.equal(b.readParallel(), 7);
    await assert.rejects(orchestrateFromCli(["--set-parallel", "nope", "2"], { batchRoot: root }), /no batch nope/);
    await assert.rejects(orchestrateFromCli(["--set-parallel", "b1", "0"], { batchRoot: root }), /positive integer/);
    assert.throws(() => openBatch(root, "../x"), /invalid batch id/);
    writeAtomic(join(root, "f.json"), "{}");
    assert.equal(readFileSync(join(root, "f.json"), "utf8"), "{}");
    const mounts = [{ mount: "/", type: "ext4" }, { mount: "/tmp", type: "tmpfs" }, { mount: "/home", type: "btrfs" }];
    assert.equal(fsTypeOf("/tmp/x/y", mounts), "tmpfs");
    assert.equal(fsTypeOf("/tmpx/y", mounts), "ext4");
    assert.throws(() => assertDiskPath("/tmp/batches", mounts), /must be on disk/);
    assert.doesNotThrow(() => assertDiskPath("/home/u/.forge/batches", mounts));
    assert.equal(isLaneAlive(process.pid, "--definitely-not-in-my-cmdline"), false);
    assert.equal(isLaneAlive(2 ** 22 + 12345, null), false);
    assert.deepEqual(readOrchestration(root), { breaker: { errors: 3, window_min: 30 }, maxDeferrals: 3, globalParallel: null, recovery: { maxAttempts: 1 } });
    writeFileSync(join(root, "forge.yaml"), "orchestration:\n  breaker:\n    errors: 5\n    window_min: 10\n  max_deferrals: 2\n  global_parallel: 4\n");
    assert.deepEqual(readOrchestration(root), { breaker: { errors: 5, window_min: 10 }, maxDeferrals: 2, globalParallel: 4, recovery: { maxAttempts: 1 } });
  });

  it("run-issue --result-file writes the lane result, also when the run throws", async () => {
    const d = tmpDir("batch-rf-");
    const rf = join(d, "lanes", "7.json");
    const base = { dir: d, emitTelemetry: async () => {}, leanIo: {}, io: { gh: async () => "o/r\n" } };
    await quiet(() => runFromCli(["7", "--repo", "o/r", "--result-file", rf], { ...base, leanModule: { runCore: async () => ({ terminalReason: "merged", pr: 9 }) } }));
    assert.deepEqual(JSON.parse(readFileSync(rf, "utf8")), { terminalReason: "merged", pr: 9 });
    await assert.rejects(quiet(() => runFromCli(["7", "--repo", "o/r", "--result-file", rf], { ...base, leanModule: { runCore: async () => { throw new Error("kaboom"); } } })), /kaboom/);
    assert.equal(JSON.parse(readFileSync(rf, "utf8")).terminalReason, "engine-error");
    assert.ok(!existsSync(`${rf}.tmp-${process.pid}`));
  });
});

describe("lane launch env (#4179)", () => {
  it("launchLane passes FORGEDOCK_BATCH_ID (the ledger dir) in the lane env and keeps the rest of the env and argv", () => {
    const batch = openBatch(tmpDir("batch-"), "b20261019-120000-1");
    const spawned = [];
    const { pid } = launchLane({ batch, issue: 7, args: ["--repo", "o/r"], script: "/x/forgedock.mjs", bin: "node", env: { PATH: "/bin", KEEP: "1" },
      spawnFn: (bin, argv, opts) => { spawned.push({ bin, argv, opts }); return { pid: 99, unref() {}, on() {} }; } });
    assert.equal(pid, 99);
    assert.equal(spawned[0].opts.env.FORGEDOCK_BATCH_ID, batch.id);
    assert.equal(spawned[0].opts.env.KEEP, "1");
    assert.deepEqual(spawned[0].argv, ["/x/forgedock.mjs", "run-issue", "7", "--repo", "o/r", "--result-file", batch.resultFile(7)]);
  });
});

describe("#4318: the batch dispatcher's signal relabel and the needs-human relabel hook", () => {
  it("SIGINT of a foreground dispatcher relabels a queued recovery with the signal as cause, then exits 130; handlers are removed", async () => {
    const leanIo = {
      gh: async (a) => (a.includes("milestone") ? JSON.stringify({ milestone: null }) : JSON.stringify({ body: "" })),
      git: async (a) => (a[0] === "ls-remote" ? "abc\trefs/heads/staging\n" : ""),
    };
    const handlers = new Map(), removed = [], exits = [], relabels = [];
    const l = console.log;
    console.log = () => {};
    try {
      await orchestrateFromCli(["1", "2", "--parallel", "1", "--repo", "o/r", "--no-prefilter"], { dir: tmpDir("sig-"), batchRoot: tmpDir("sig-batch-"), allowTmpfs: true,
        emitTelemetry: async () => {}, io: { gh: async () => "o/r\n" }, leanIo, sched: null, decide: () => {},
        orchestration: { breaker: null, maxDeferrals: 3, globalParallel: null, recovery: { maxAttempts: 2 } },
        processOn: (s, f) => handlers.set(s, f), processOff: (s, f) => { if (handlers.get(s) === f) removed.push(s); }, exit: (c) => exits.push(c),
        relabelNeedsHuman: async (x) => { relabels.push(x); return true; },
        leanModule: { runCore: async (o) => {
          if (o.issue === 1 && !o.recover) return { terminalReason: "needs-human", code: "ci.red", detail: "Required check(s) failed on PR #55: test" };
          if (o.issue === 2) await handlers.get("SIGINT")(); // issue 1's attempt is queued behind issue 2 (K=1)
          return { terminalReason: "merged", pr: 50 + o.issue };
        } } });
    } finally { console.log = l; }
    assert.deepEqual(exits, [130]);
    assert.equal(relabels.length, 1); assert.equal(relabels[0].issue, 1);
    assert.match(relabels[0].evidence, /the batch stopped \(interrupted by SIGINT\)/);
    assert.deepEqual(removed.sort(), ["SIGINT", "SIGTERM"]);
  });

  describe("makeRelabelNeedsHuman", () => {
    const LIVE = (until) => `body\n<!-- FORGE:STATE\n${JSON.stringify({ v: 1, issue: 7, lease: { by: "core_1", until, host: "h", pid: 1 } })}\n-->`;
    const hook = (view, fail = {}) => {
      const calls = [];
      const gh = async (a) => {
        calls.push(a[1]);
        if (a[1] === "view") return JSON.stringify(view);
        if (fail[a[1]]) throw new Error(`${a[1]} failed`);
        return "";
      };
      return { calls, run: () => makeRelabelNeedsHuman({ gh, repo: "o/r", now: () => 1000 })({ issue: 7, evidence: "why" }) };
    };
    it("a closed issue or a live lease is skipped without a write", async () => {
      for (const view of [{ state: "CLOSED", body: "" }, { state: "OPEN", body: LIVE(5000) }]) {
        const h = hook(view);
        assert.equal(await h.run(), "skipped");
        assert.deepEqual(h.calls, ["view"]);
      }
    });
    it("an expired lease relabels: the label first, then the comment", async () => {
      const h = hook({ state: "OPEN", body: LIVE(500) });
      assert.equal(await h.run(), true);
      assert.deepEqual(h.calls, ["view", "edit", "comment"]);
    });
    it("a failed label add posts no comment and reports failed; a failed comment keeps the label", async () => {
      const a = hook({ state: "OPEN", body: "" }, { edit: true });
      assert.equal(await a.run(), "failed");
      assert.deepEqual(a.calls, ["view", "edit"]);
      const b = hook({ state: "OPEN", body: "" }, { comment: true });
      assert.equal(await b.run(), true);
    });
  });
});

describe("#4354: the batch report ends with the fail-soft alerts of the batch's repo", () => {
  const seed = (dir, repo, status) => {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      const evs = [{ event: "RUN_START", ts: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), repo, issue: 500 + i },
        { event: "DEPS_PREPARED", eco: "pnpm", status, reason: "tool not found: spawn pnpm ENOENT" }, { event: "RUN_TERMINAL", reason: "merged", code: "completed" }];
      writeFileSync(join(dir, `${500 + i}.jsonl`), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
  };
  const run = async (dir) => {
    const lines = [], l = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      await orchestrateFromCli(["1", "--repo", "o/r", "--no-prefilter"], { dir, batchRoot: tmpDir("alert-batch-"), allowTmpfs: true,
        emitTelemetry: async () => {}, io: { gh: async () => "o/r\n" }, sched: null, decide: () => {}, alertConfig: {}, heavyStats: null,
        leanIo: { gh: async (a) => (a.includes("milestone") ? JSON.stringify({ milestone: null }) : JSON.stringify({ body: "" })), git: async (a) => (a[0] === "ls-remote" ? "abc\trefs/heads/staging\n" : "") },
        orchestration: { breaker: null, maxDeferrals: 3, globalParallel: null, recovery: { maxAttempts: 2 } },
        leanModule: { runCore: async () => ({ terminalReason: "merged", pr: 51 }) } });
    } finally { console.log = l; }
    return lines.join("\n").split("\n").filter((x) => x.trim());
  };

  it("prints ALERTS last for the repo's failing dependency cache, nothing for a healthy one or another repo's lanes", async () => {
    const bad = tmpDir("alert-runs-");
    seed(bad, "o/r", "failed");
    const out = await run(bad);
    const at = out.indexOf("ALERTS");
    assert.ok(at > 0, out.join("\n"));
    assert.match(out[at + 1], /^DEPS_PREPARED failed \(pnpm\): 100% \(10\/10 lanes, threshold 20%\), e\.g\. "tool not found: spawn pnpm ENOENT"$/);
    assert.equal(out.length, at + 2, "the alerts end the report");
    const good = tmpDir("alert-runs-");
    seed(good, "o/r", "hit");
    assert.ok(!(await run(good)).some((x) => /ALERTS|DEPS_PREPARED/.test(x)));
    const other = tmpDir("alert-runs-");
    seed(other, "x/y", "failed");
    assert.ok(!(await run(other)).some((x) => /ALERTS/.test(x)));
  });
});
