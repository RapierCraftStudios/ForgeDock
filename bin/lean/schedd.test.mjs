// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { openBatch, isLaneAlive, listBatches } from "./batch.mjs";
import { startDaemon, scheddPaths, connectDaemon, request, mergeEnv, batchEnv, exitOnSignals } from "./schedd.mjs";
import { schedDir } from "./sched.mjs";
import { formatTable, orchestrate } from "./orchestrate.mjs";
import { orchestrateFromCli } from "../engine-cli.mjs";

// #4503: this process, and the env its clients submit for their lanes, never resolve the host's `~/.forge/sched`.
process.env.FORGEDOCK_SCHED_DIR = tmpDir("schedd-home-");
// Stub lanes run detached: a host whose test never reached its `finally` still has them reaped when the file ends.
const hosts = [];
process.on("exit", () => { for (const h of hosts) h.reap(); });
const LANE_MAX_MS = 120_000;

const until = async (cond, ms = 15000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 25)); }
};
const capture = async (fn) => {
  const lines = [], l = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try { return { res: await fn(), lines }; } finally { console.log = l; }
};

/** A host: sched + batch dirs, a stub lane that waits for `release`, and a daemon script with injected lanes. */
function host() {
  const work = tmpDir("schedd-");
  const h = { work, sched: join(work, "s"), root: join(work, "batches"), launches: join(work, "launches"), release: join(work, "release"), procs: [],
    lanePidFile: join(work, "lane-pids"), log: join(work, "schedd.log") };
  writeFileSync(h.launches, "");
  writeFileSync(h.lanePidFile, "");
  hosts.push(h);
  const stub = join(work, "stub-lane.mjs");
  writeFileSync(stub, `import { appendFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
const a = process.argv.slice(2); const n = Number(a[1]); const rf = a[a.indexOf("--result-file") + 1];
appendFileSync(${JSON.stringify(h.launches)}, n + "\\n");
appendFileSync(${JSON.stringify(h.lanePidFile)}, process.pid + "\\n");
// #4503: a stub whose test run is gone (work dir removed) or that outlived its bound exits instead of polling forever.
const born = Date.now();
const t = setInterval(() => { if (!existsSync(${JSON.stringify(work)}) || Date.now() - born > ${LANE_MAX_MS}) process.exit(0);
  if (!existsSync(${JSON.stringify(h.release)})) return; clearInterval(t);
  writeFileSync(rf + ".tmp", JSON.stringify({ terminalReason: "merged", pr: 100 + n, cost_usd: 0 })); renameSync(rf + ".tmp", rf); }, 20);
// Like run-issue's #4179 teardown: SIGTERM reports deferred run.interrupted.
process.once("SIGTERM", () => { writeFileSync(rf + ".tmp", JSON.stringify({ terminalReason: "deferred", code: "run.interrupted", detail: "interrupted by SIGTERM" })); renameSync(rf + ".tmp", rf); process.exit(143); });
`);
  h.daemonScript = join(work, "daemon.mjs");
  writeFileSync(h.daemonScript, `import { startDaemon, exitOnSignals } from ${JSON.stringify(new URL("./schedd.mjs", import.meta.url).href)};
import { runBatch } from ${JSON.stringify(new URL("../engine-cli.mjs", import.meta.url).href)};
const deps = { allowTmpfs: true, laneScript: ${JSON.stringify(stub)}, pollMs: 30, orchestration: { breaker: null, maxDeferrals: 3 }, io: { gh: async () => "o/r\\n" },
  leanIo: { gh: async (a) => a.includes("milestone") ? JSON.stringify({ milestone: null }) : a[0] === "repo" ? "main\\n" : JSON.stringify({ body: a[2] === "3" ? "Depends on #1" : "", labels: [] }),
    git: async (a) => (a[0] === "ls-remote" ? "abc\\trefs/heads/staging\\n" : "") } };
const d = await startDaemon({ runBatch: (a) => runBatch({ ...a, daemon: true, deps }), idleMs: 600000 });
if (!d.running) process.exit(3);
exitOnSignals(d); // the forgedock schedd handler (#4454)
await d.closed;
`);
  h.env = { ...process.env, FORGEDOCK_SCHED_DIR: h.sched, FORGEDOCK_BATCH_DIR: h.root, FORGEDOCK_LIMITS_FILE: join(work, "limits.json") };
  h.daemon = async () => {
    const before = existsSync(scheddPaths(h.sched).lock) ? readFileSync(scheddPaths(h.sched).lock, "utf8") : null;
    const out = openSync(h.log, "a");
    let child;
    try { child = spawn(process.execPath, [h.daemonScript], { env: h.env, stdio: ["ignore", out, out] }); } finally { closeSync(out); }
    h.procs.push(child);
    await until(() => existsSync(scheddPaths(h.sched).sock) && existsSync(scheddPaths(h.sched).lock) && readFileSync(scheddPaths(h.sched).lock, "utf8") === String(child.pid) && readFileSync(scheddPaths(h.sched).lock, "utf8") !== before);
    // Wait for the socket to accept.
    for (let i = 0; i < 100; i++) { try { (await connectDaemon({ dir: h.sched, spawnDaemon: null })).destroy(); break; } catch { await new Promise((r) => setTimeout(r, 30)); } }
    return child;
  };
  h.client = { scheddDir: h.sched, spawnDaemon: null };
  h.launched = () => readFileSync(h.launches, "utf8").trim().split("\n").filter(Boolean).map(Number).sort();
  h.lanePids = () => listBatches(h.root).flatMap((id) => Object.values(openBatch(h.root, id).store.load()?.running ?? {}).map((r) => r.pid).filter(Boolean));
  h.stubPids = () => (existsSync(h.lanePidFile) ? readFileSync(h.lanePidFile, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
  h.reap = () => {
    for (const p of h.procs) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
    for (const pid of h.stubPids()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  };
  h.cleanup = async () => {
    if (existsSync(h.work)) writeFileSync(h.release, "");
    h.reap();
    await until(() => h.stubPids().every((pid) => !isLaneAlive(pid, null)), 5000).catch(() => {});
  };
  return h;
}

describe("schedd host scheduler (#4192)", () => {
  // The client and the daemon both resolve the batch root from FORGEDOCK_BATCH_DIR.
  const withRoot = async (h, fn) => {
    const prev = process.env.FORGEDOCK_BATCH_DIR;
    process.env.FORGEDOCK_BATCH_DIR = h.root;
    try { return await fn(); } finally { if (prev === undefined) delete process.env.FORGEDOCK_BATCH_DIR; else process.env.FORGEDOCK_BATCH_DIR = prev; }
  };

  it("one daemon hosts every batch: registry slots are the daemon's, its RSS stays ≤ 150 MB, set-parallel goes through it", async () => {
    const h = host();
    try {
      const d = await h.daemon();
      const submit = (issues) => orchestrateFromCli([...issues, "--parallel", "2", "--repo", "o/r", "--no-prefilter"], h.client);
      // One capture for the three concurrent clients (console.log is process-wide).
      const all = capture(() => Promise.all([submit(["1", "2"]), submit(["4"]), submit(["5"])]));
      await until(() => h.launched().length === 4 && h.lanePids().length === 4);
      const reg = JSON.parse(readFileSync(join(h.sched, "registry.json"), "utf8"));
      assert.equal(Object.keys(reg.slots).length, 4);
      for (const s of Object.values(reg.slots)) assert.equal(s.pid, d.pid, "every lane slot belongs to the one daemon");
      const st = await request(await connectDaemon({ dir: h.sched, spawnDaemon: null }), { op: "status" });
      assert.equal(st.pid, d.pid);
      assert.equal(st.batches.length, 3);
      const rssKb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${d.pid}/status`, "utf8"))[1]);
      assert.ok(rssKb <= 150 * 1024, `daemon RSS ${rssKb} kB hosting 3 batches`);
      writeFileSync(h.release, "");
      const { res: done, lines } = await all;
      assert.deepEqual(done.map((res) => res.rows.map((r) => [r.issue, r.outcome, r.pr])), [[[1, "merged", 101], [2, "merged", 102]], [[4, "merged", 104]], [[5, "merged", 105]]]);
      assert.ok(lines.some((l) => /^#1 → merged$/.test(l)), "rows stream to the client");
      for (const res of done) assert.ok(lines.some((l) => l.includes(formatTable(res.rows))), "each report table is printed");
      const id = done[0].batch;
      await withRoot(h, () => capture(() => orchestrateFromCli(["--set-parallel", id, "5"], h.client)));
      assert.equal(openBatch(h.root, id).readParallel(), 5);
    } finally { await h.cleanup(); }
  });

  it("a client that disconnects does not stop the batch; --resume reattaches, and replays the report once done", async () => {
    const h = host();
    try {
      await h.daemon();
      const clientScript = join(h.work, "client.mjs");
      writeFileSync(clientScript, `import { orchestrateFromCli } from ${JSON.stringify(new URL("../engine-cli.mjs", import.meta.url).href)};
await orchestrateFromCli(["1", "2", "--parallel", "2", "--repo", "o/r", "--no-prefilter"], { scheddDir: ${JSON.stringify(h.sched)}, spawnDaemon: null });
`);
      const client = spawn(process.execPath, [clientScript], { env: h.env, stdio: "ignore" });
      h.procs.push(client);
      const exited = new Promise((r) => client.on("exit", r));
      await until(() => h.launched().length === 2 && h.lanePids().length === 2);
      client.kill("SIGKILL");
      await exited;
      const [id] = listBatches(h.root);
      for (const pid of h.lanePids()) assert.equal(isLaneAlive(pid, null), true, "lanes outlive the client");
      const attached = capture(() => orchestrateFromCli(["--resume", id], h.client));
      setTimeout(() => writeFileSync(h.release, ""), 200);
      const { res } = await attached;
      assert.deepEqual(res.rows.map((r) => [r.issue, r.outcome, r.pr]), [[1, "merged", 101], [2, "merged", 102]]);
      assert.deepEqual(h.launched(), [1, 2], "no lane relaunched");
      // Finished: the report is replayed from report.json, nothing runs again.
      const again = await capture(() => orchestrateFromCli(["--resume", id], h.client));
      assert.deepEqual(again.res.rows, res.rows);
      assert.ok(again.lines.join("\n").includes(formatTable(res.rows)));
      assert.deepEqual(h.launched(), [1, 2]);
    } finally { await h.cleanup(); }
  });

  it("a daemon restart resumes the batch from state and re-adopts its live lanes without duplicate launches", async () => {
    const h = host();
    try {
      const d1 = await h.daemon();
      const first = capture(() => orchestrateFromCli(["1", "2", "3", "--parallel", "2", "--repo", "o/r", "--no-prefilter"], h.client)).then(() => null, (e) => e);
      await until(() => h.launched().length === 2 && h.lanePids().length === 2);
      const lanes = h.lanePids();
      const d1exit = new Promise((r) => d1.on("exit", r));
      d1.kill("SIGKILL");
      await d1exit;
      assert.match(String((await first)?.message), /--resume/, "the client is told how to reattach");
      for (const pid of lanes) assert.equal(isLaneAlive(pid, null), true, "lanes outlive the daemon");
      const [id] = listBatches(h.root);
      await h.daemon(); // takes over the dead daemon's lock and socket, resumes the batch
      const attached = capture(() => orchestrateFromCli(["--resume", id], h.client));
      setTimeout(() => writeFileSync(h.release, ""), 200);
      const { res } = await attached;
      assert.deepEqual(res.rows.map((r) => [r.issue, r.outcome, r.pr]), [[1, "merged", 101], [2, "merged", 102], [3, "merged", 103]]);
      assert.deepEqual(h.launched(), [1, 2, 3], "adopted, not relaunched");
      assert.deepEqual(openBatch(h.root, id).store.load().running, {});
    } finally { await h.cleanup(); }
  });

  it("#4408: --add and --resume <id> N add issues to the live batch (no second batch); an unhosted finished batch runs its adds on --resume", async () => {
    const h = host();
    try {
      await h.daemon();
      const client = { ...h.client, io: { gh: async (a) => (a[0] === "issue" ? JSON.stringify({ state: a[2] === "9" ? "CLOSED" : "OPEN" }) : "o/r\n") } };
      const { res } = await withRoot(h, () => capture(async () => {
        const first = orchestrateFromCli(["1", "--parallel", "3", "--repo", "o/r", "--no-prefilter"], h.client);
        await until(() => h.launched().length === 1 && h.lanePids().length === 1);
        const [id] = listBatches(h.root);
        const add = await orchestrateFromCli(["--add", id, "2", "1", "x", "9"], client);
        assert.deepEqual(add.added, [2]);
        assert.deepEqual(add.skipped.map((x) => [x.issue, x.reason]).sort(), [[1, "already in batch"], [9, "closed"], ["x", "not an integer"]]);
        await until(() => h.launched().includes(2));
        const resumed = orchestrateFromCli(["--resume", id, "4"], client);
        await until(() => h.launched().includes(4));
        assert.deepEqual(listBatches(h.root), [id], "no second batch");
        writeFileSync(h.release, "");
        const [done] = await Promise.all([first, resumed]);
        assert.deepEqual(done.rows.map((r) => [r.issue, r.outcome]), [[1, "merged"], [2, "merged"], [4, "merged"]]);
        // Finished and no longer hosted: the add is persisted and the next --resume runs it instead of replaying the report.
        const later = await orchestrateFromCli(["--add", id, "6"], client);
        assert.deepEqual(later.added, [6]);
        const again = await orchestrateFromCli(["--resume", id], client);
        assert.deepEqual(again.rows.map((r) => [r.issue, r.outcome]), [[1, "merged"], [2, "merged"], [4, "merged"], [6, "merged"]]);
        return done;
      }));
      assert.equal(res.rows.length, 3);
      assert.deepEqual(h.launched(), [1, 2, 4, 6], "each issue launched once");
    } finally { await h.cleanup(); }
  });

  it("#4376: --cancel stops one batch (its lane torn down, the rest held, report written); the other batch and the daemon run on", async () => {
    const h = host();
    try {
      const d = await h.daemon();
      await withRoot(h, () => capture(async () => {
        const a = orchestrateFromCli(["1", "2", "--parallel", "1", "--repo", "o/r", "--no-prefilter"], h.client);
        await until(() => h.launched().length === 1 && h.lanePids().length === 1);
        const [idA] = listBatches(h.root);
        const b = orchestrateFromCli(["5", "--parallel", "1", "--repo", "o/r", "--no-prefilter"], h.client);
        await until(() => h.launched().includes(5) && h.lanePids().length === 2);
        const idB = listBatches(h.root).find((x) => x !== idA);
        const res = await orchestrateFromCli(["--cancel", idA], h.client);
        assert.deepEqual(res, { ok: true, batch: idA, cancelled: true });
        const doneA = await a;
        assert.deepEqual(doneA.rows.map((r) => [r.issue, r.outcome, r.detail]), [[1, "held", "cancelled by operator"], [2, "held", "cancelled by operator"]]);
        assert.ok(openBatch(h.root, idA).readReport(), "the cancelled batch wrote its report");
        assert.deepEqual(h.launched(), [1, 5], "#2 never launched");
        const st = await request(await connectDaemon({ dir: h.sched, spawnDaemon: null }), { op: "status" });
        assert.equal(st.pid, d.pid, "the daemon kept running");
        assert.deepEqual(st.batches.map((x) => x.id), [idB]);
        writeFileSync(h.release, "");
        const doneB = await b;
        assert.deepEqual(doneB.rows.map((r) => [r.issue, r.outcome]), [[5, "merged"]]);
        const again = await orchestrateFromCli(["--cancel", idA], h.client);
        assert.equal(again.cancelled, false, "a finished batch is left alone");
        await assert.rejects(orchestrateFromCli(["--cancel", "nope"], h.client), /no batch nope/);
      }));
    } finally { await h.cleanup(); }
  });

  it("#4481: a batch cancelled through the daemon is not resumed by a schedd restart", async () => {
    const h = host();
    try {
      const statusIds = async () => (await request(await connectDaemon({ dir: h.sched, spawnDaemon: null }), { op: "status" })).batches.map((x) => x.id);
      const kill = async (d) => { const gone = new Promise((r) => d.on("exit", r)); d.kill("SIGKILL"); await gone; };
      let d = await h.daemon();
      await withRoot(h, () => capture(async () => {
        const a = orchestrateFromCli(["1", "2", "--parallel", "1", "--repo", "o/r", "--no-prefilter"], h.client);
        await until(() => h.launched().length === 1 && h.lanePids().length === 1);
        const [idA] = listBatches(h.root);
        assert.equal((await orchestrateFromCli(["--cancel", idA], h.client)).cancelled, true);
        await a;
        await kill(d);
        d = await h.daemon();
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(await statusIds(), [], "the restarted daemon hosts no cancelled batch");
        assert.deepEqual(h.launched(), [1]);
      }));
    } finally { await h.cleanup(); }
  });

  it("single instance: a live daemon keeps its lock; a dead owner's lock and socket are taken over", async () => {
    const h = host();
    try {
      const d = await h.daemon();
      const second = await startDaemon({ dir: h.sched, root: h.root, runBatch: async () => ({}), log: () => {}, resumeOnStart: false });
      assert.deepEqual(second, { running: false, owner: d.pid });
      const dexit = new Promise((r) => d.on("exit", r));
      d.kill("SIGKILL");
      await dexit;
      assert.ok(existsSync(scheddPaths(h.sched).lock) && existsSync(scheddPaths(h.sched).sock), "stale lock and socket left behind");
      const third = await startDaemon({ dir: h.sched, root: h.root, runBatch: async () => ({}), log: () => {}, resumeOnStart: false });
      try {
        assert.equal(third.running, true);
        const st = await request(await connectDaemon({ dir: h.sched, spawnDaemon: null }), { op: "status" });
        assert.equal(st.pid, process.pid);
      } finally { await third.close(); }
      assert.equal(existsSync(scheddPaths(h.sched).lock), false, "lock released on close");
    } finally { await h.cleanup(); }
  });

  it("#4454: close() stops every hosted batch loop before releasing the lock; no batch admits a lane after close()", async () => {
    const dir = tmpDir("schedd-stop-"), root = join(dir, "batches"), lock = scheddPaths(dir).lock;
    const started = { a: [], b: [] }, stoppedWithLock = {};
    let releaseLane;
    const lane = new Promise((r) => { releaseLane = r; });
    // An unref'd cancellable sleep: a base without the stop cannot hang the test process on the 30-min requeue delay.
    const sleep = (ms, sig) => new Promise((r) => { const t = setTimeout(r, ms); t.unref(); sig?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
    const runBatch = async ({ argv, sink, signal }) => {
      const id = argv[0];
      sink.batch({ id, dir: join(root, id) });
      try {
        return await orchestrate({ issues: id === "a" ? [1, 2] : [9], parallel: 1, readBody: async () => "", signal, sleep,
          runOne: async (n) => {
            started[id].push(n);
            if (n === 1) { await lane; return { terminalReason: "merged" }; } // a detached lane, still running at shutdown
            if (n === 9) return { terminalReason: "deferred", detail: `leased by x until ${new Date(Date.now() + 3600e3).toISOString()}` };
            return { terminalReason: "merged" };
          } });
      } finally { stoppedWithLock[id] = existsSync(lock); }
    };
    const d = await startDaemon({ dir, root, runBatch, log: () => {}, resumeOnStart: false });
    const submit = async (id) => request(await connectDaemon({ dir, spawnDaemon: null }), { op: "submit", argv: [id], cwd: dir, env: {} }).catch((e) => e);
    const clients = [submit("a"), submit("b")]; // each resolves (or rejects) once its connection ends
    await until(() => started.a.length === 1 && started.b.length === 1);
    await new Promise((r) => setTimeout(r, 100)); // b is asleep on its requeue delay
    const t0 = Date.now();
    await d.close();
    assert.ok(Date.now() - t0 < 3000, `close() took ${Date.now() - t0} ms`);
    assert.deepEqual(stoppedWithLock, { a: true, b: true }, "both batch loops stopped while the lock was still held");
    assert.equal(existsSync(lock), false, "lock released after the loops stopped");
    assert.equal(existsSync(scheddPaths(dir).sock), false);
    releaseLane();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(started, { a: [1], b: [9] }, "no hosted batch admits a lane after close()");
    await Promise.all(clients);
  });

  it("#4454: close() waits at most stopMs for a batch that ignores the stop, then releases the lock", async () => {
    const dir = tmpDir("schedd-bound-");
    const d = await startDaemon({ dir, root: join(dir, "batches"), log: () => {}, resumeOnStart: false, stopMs: 200,
      runBatch: ({ sink }) => { sink.batch({ id: "x", dir }); return new Promise(() => {}); } });
    request(await connectDaemon({ dir, spawnDaemon: null }), { op: "submit", argv: ["x"], cwd: dir, env: {} }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await d.close();
    const took = Date.now() - t0;
    assert.ok(took >= 150 && took < 2000, `close() took ${took} ms`);
    assert.equal(existsSync(scheddPaths(dir).lock), false);
  });

  it("#4454: kill -TERM stops both batches and exits 143 within the bound; lanes keep running; the next daemon resumes and adopts them", async () => {
    const h = host();
    try {
      const d1 = await h.daemon();
      const { lines } = await withRoot(h, () => capture(async () => {
        // #4503: a gives up at once (reconnectMs 0) with the resume hint; b re-attaches to the next daemon on its own.
        const a = orchestrateFromCli(["1", "2", "--parallel", "1", "--repo", "o/r", "--no-prefilter"], { ...h.client, reconnectMs: 0 }).then(() => null, (e) => e);
        await until(() => h.launched().length === 1 && h.lanePids().length === 1);
        const [idA] = listBatches(h.root);
        const b = orchestrateFromCli(["5", "--parallel", "1", "--repo", "o/r", "--no-prefilter"], h.client);
        await until(() => h.launched().includes(5) && h.lanePids().length === 2);
        const idB = listBatches(h.root).find((x) => x !== idA);
        const lanes = h.lanePids();
        const exit = new Promise((r) => d1.on("exit", (code) => r(code)));
        const t0 = Date.now();
        d1.kill("SIGTERM");
        assert.equal(await exit, 143);
        assert.ok(Date.now() - t0 < 12000, "exits within the bound");
        for (const pid of lanes) assert.equal(isLaneAlive(pid, null), true, "lanes keep running");
        assert.equal(existsSync(scheddPaths(h.sched).lock), false);
        assert.equal(openBatch(h.root, idA).readReport(), null, "a stopped batch writes no report");
        assert.equal(openBatch(h.root, idB).readReport(), null);
        assert.match(String((await a)?.message), /--resume/);
        await h.daemon(); // resumes both batches
        const ra = orchestrateFromCli(["--resume", idA], h.client);
        setTimeout(() => writeFileSync(h.release, ""), 200);
        assert.deepEqual((await ra).rows.map((r) => [r.issue, r.outcome]), [[1, "merged"], [2, "merged"]]);
        assert.deepEqual((await b).rows.map((r) => [r.issue, r.outcome]), [[5, "merged"]], "b re-attached and finished");
        assert.deepEqual(h.launched(), [1, 2, 5], "adopted, not relaunched");
      }));
      assert.ok(lines.some((l) => l.startsWith("schedd connection lost; reconnecting to batch ")), "the client said it reconnects");
      const log = readFileSync(h.log, "utf8");
      assert.match(log, /^schedd: exiting \(SIGTERM\)$/m);
      assert.match(log, /^schedd: exited \(code 143\)$/m);
    } finally { await h.cleanup(); }
  });

  it("#4503: every schedd exit writes a reason line", async () => {
    for (const [ev, arg, code, re] of [["SIGTERM", undefined, 143, /^schedd: exiting \(SIGTERM\)$/], ["SIGINT", undefined, 130, /^schedd: exiting \(SIGINT\)$/],
      ["SIGHUP", undefined, 129, /^schedd: exiting \(SIGHUP\)$/], ["uncaughtException", new Error("boom\nmore"), 1, /^schedd: exiting \(uncaught: boom\)$/],
      ["unhandledRejection", new Error("nope"), 1, /^schedd: exiting \(unhandled rejection: nope\)$/]]) {
      const handlers = {}, lines = [], exits = [];
      exitOnSignals({ close: async () => { lines.push("closed"); } }, { on: (s, f) => { handlers[s] = f; }, exit: (c) => exits.push(c), log: (m) => lines.push(m) });
      await handlers[ev](arg);
      assert.match(lines[0], re, `${ev}: the reason is logged before close()`);
      assert.equal(lines.at(-1), "closed");
      assert.deepEqual(exits, [code]);
      handlers.exit(code);
      assert.equal(lines.at(-1), `schedd: exited (code ${code})`);
    }
    const dir = tmpDir("schedd-idle-"), lines = [];
    const d = await startDaemon({ dir, root: join(dir, "batches"), runBatch: async () => ({}), log: (m) => lines.push(m), resumeOnStart: false, idleMs: 50 });
    await d.closed;
    assert.ok(lines.includes("schedd: idle, exiting"));
  });

  it("#4503: a daemon that lost its lock or socket logs it and stops its batches resumable, never removing the successor's lock or socket; a dead owner's takeover is logged", async () => {
    const dir = tmpDir("schedd-lost-"), p = scheddPaths(dir), root = join(dir, "batches"), lines = [];
    let stopped = false;
    const d = await startDaemon({ dir, root, log: (m) => lines.push(m), resumeOnStart: false, lockCheckMs: 30,
      runBatch: ({ sink, signal }) => { sink.batch({ id: "x", dir }); return new Promise((_, rej) => signal.addEventListener("abort", () => { stopped = true; rej(Object.assign(new Error("stopped"), { code: "batch.stopped" })); })); } });
    request(await connectDaemon({ dir, spawnDaemon: null }), { op: "submit", argv: ["x"], cwd: dir, env: {} }).catch(() => {});
    await until(() => lines.some((l) => l.includes("listening")));
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(p.lock, "999999999"); // a successor (now dead) took the lock
    await d.closed;
    assert.ok(lines.includes("schedd: lost lock (owner pid 999999999), exiting"), lines.join("\n"));
    assert.equal(stopped, true, "the hosted batch loop was stopped (no report: the next daemon resumes it)");
    assert.equal(readFileSync(p.lock, "utf8"), "999999999", "the successor's lock is left alone");
    assert.equal(existsSync(p.sock), true, "the successor's socket is left alone");

    const lines2 = [];
    const d2 = await startDaemon({ dir, root, runBatch: async () => ({}), log: (m) => lines2.push(m), resumeOnStart: false, lockCheckMs: 30 });
    assert.ok(lines2.includes("schedd: took over the lock of dead pid 999999999 (it exited without a clean shutdown)"), lines2.join("\n"));
    rmSync(p.sock);
    await d2.closed;
    assert.ok(lines2.includes(`schedd: lost socket ${p.sock}, exiting`), lines2.join("\n"));
    assert.equal(existsSync(p.lock), false, "its own lock is released");
  });

  it("#4503: a client whose daemon is SIGKILLed re-attaches to the next daemon and finishes, without relaunching a lane", async () => {
    const h = host();
    try {
      const d1 = await h.daemon();
      await withRoot(h, () => capture(async () => {
        const a = orchestrateFromCli(["1", "--parallel", "1", "--repo", "o/r", "--no-prefilter"], h.client);
        await until(() => h.launched().length === 1 && h.lanePids().length === 1);
        const gone = new Promise((r) => d1.on("exit", r));
        d1.kill("SIGKILL");
        await gone;
        await new Promise((r) => setTimeout(r, 300)); // the client is retrying against the dead socket
        await h.daemon();
        setTimeout(() => writeFileSync(h.release, ""), 200);
        assert.deepEqual((await a).rows.map((r) => [r.issue, r.outcome]), [[1, "merged"]]);
        assert.deepEqual(h.launched(), [1], "adopted, not relaunched");
      }));
      assert.match(readFileSync(h.log, "utf8"), /^schedd: took over the lock of dead pid \d+ \(it exited without a clean shutdown\)$/m);
    } finally { await h.cleanup(); }
  });

  it("#4503: test runs never resolve ~/.forge/sched, and teardown leaves no live stub lane", async () => {
    assert.notEqual(schedDir(), join(homedir(), ".forge", "sched"));
    assert.ok(schedDir().startsWith(tmpdir()), schedDir());
    const h = host();
    let pids = [], a;
    try {
      await h.daemon();
      await withRoot(h, async () => {
        a = capture(() => orchestrateFromCli(["1", "2", "--parallel", "2", "--repo", "o/r", "--no-prefilter"], { ...h.client, reconnectMs: 0 })).catch((e) => e);
        await until(() => h.stubPids().length === 2 && h.lanePids().length === 2);
      });
      pids = h.stubPids();
      for (const pid of pids) assert.equal(isLaneAlive(pid, null), true);
      const [id] = listBatches(h.root);
      assert.equal(openBatch(h.root, id).readPlan().env.FORGEDOCK_SCHED_DIR, schedDir(), "the lanes' env pins the test sched dir");
    } finally { await h.cleanup(); }
    await a;
    assert.equal(pids.length, 2);
    for (const pid of pids) assert.equal(isLaneAlive(pid, null), false, `stub lane ${pid} reaped`);
  });

  it("lane env: allowlisted keys come from the client only, the rest from the daemon", () => {
    const kept = batchEnv({ PATH: "/c", CLAUDE_CONFIG_DIR: "/acct-b", SECRET_X: "no", FORGEDOCK_SCHED_DIR: "/s" });
    assert.deepEqual(kept, { PATH: "/c", CLAUDE_CONFIG_DIR: "/acct-b", FORGEDOCK_SCHED_DIR: "/s" });
    const env = mergeEnv({ PATH: "/d", ANTHROPIC_API_KEY: "daemon-key", NODE_OPTIONS: "x" }, kept);
    assert.deepEqual(env, { NODE_OPTIONS: "x", PATH: "/c", CLAUDE_CONFIG_DIR: "/acct-b", FORGEDOCK_SCHED_DIR: "/s" });
  });
});
