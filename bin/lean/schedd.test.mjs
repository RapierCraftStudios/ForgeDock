// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { openBatch, isLaneAlive, listBatches } from "./batch.mjs";
import { startDaemon, scheddPaths, connectDaemon, request, mergeEnv, batchEnv } from "./schedd.mjs";
import { formatTable, orchestrate } from "./orchestrate.mjs";
import { orchestrateFromCli } from "../engine-cli.mjs";

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
  const h = { work, sched: join(work, "s"), root: join(work, "batches"), launches: join(work, "launches"), release: join(work, "release"), procs: [] };
  writeFileSync(h.launches, "");
  const stub = join(work, "stub-lane.mjs");
  writeFileSync(stub, `import { appendFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
const a = process.argv.slice(2); const n = Number(a[1]); const rf = a[a.indexOf("--result-file") + 1];
appendFileSync(${JSON.stringify(h.launches)}, n + "\\n");
const t = setInterval(() => { if (!existsSync(${JSON.stringify(h.release)})) return; clearInterval(t);
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
    const child = spawn(process.execPath, [h.daemonScript], { env: h.env, stdio: "ignore" });
    h.procs.push(child);
    await until(() => existsSync(scheddPaths(h.sched).sock) && existsSync(scheddPaths(h.sched).lock) && readFileSync(scheddPaths(h.sched).lock, "utf8") === String(child.pid) && readFileSync(scheddPaths(h.sched).lock, "utf8") !== before);
    // Wait for the socket to accept.
    for (let i = 0; i < 100; i++) { try { (await connectDaemon({ dir: h.sched, spawnDaemon: null })).destroy(); break; } catch { await new Promise((r) => setTimeout(r, 30)); } }
    return child;
  };
  h.client = { scheddDir: h.sched, spawnDaemon: null };
  h.launched = () => readFileSync(h.launches, "utf8").trim().split("\n").filter(Boolean).map(Number).sort();
  h.lanePids = () => listBatches(h.root).flatMap((id) => Object.values(openBatch(h.root, id).store.load()?.running ?? {}).map((r) => r.pid).filter(Boolean));
  h.cleanup = () => {
    writeFileSync(h.release, "");
    for (const p of h.procs) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
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
    } finally { h.cleanup(); }
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
    } finally { h.cleanup(); }
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
    } finally { h.cleanup(); }
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
    } finally { h.cleanup(); }
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
    } finally { h.cleanup(); }
  });

  it("#4481: a cancelled batch is not resumed by a schedd restart, also when the cancel landed while no daemon ran", async () => {
    const h = host();
    try {
      const statusIds = async () => (await request(await connectDaemon({ dir: h.sched, spawnDaemon: null }), { op: "status" })).batches.map((x) => x.id);
      const kill = async (d) => { const gone = new Promise((r) => d.on("exit", r)); d.kill("SIGKILL"); await gone; };
      let d = await h.daemon();
      await withRoot(h, () => capture(async () => {
        // A: cancelled through the daemon, then the daemon restarts.
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
        // B: the daemon dies mid-batch, the cancel is written with no daemon running; the next daemon only winds it down.
        orchestrateFromCli(["3", "4", "--parallel", "1", "--repo", "o/r", "--no-prefilter"], h.client).catch(() => {});
        await until(() => h.launched().length === 2 && h.lanePids().length === 1);
        const idB = listBatches(h.root).find((x) => x !== idA);
        await kill(d);
        openBatch(h.root, idB).requestCancel({ reason: "operator" });
        d = await h.daemon();
        try { await until(() => !!openBatch(h.root, idB).readReport()); } catch (e) { const fs = await import("node:fs"); const out = []; const walk = (d) => { for (const f of fs.readdirSync(d)) { const q = d + "/" + f; const st = fs.statSync(q); if (st.isDirectory()) walk(q); else if (st.isFile()) out.push("== " + q + "\n" + fs.readFileSync(q, "utf8").slice(0, 3000)); } }; walk(h.work); out.push("launched " + h.launched()); fs.writeFileSync(process.env.TMPDIR + "/dump.txt", out.join("\n")); throw e; }
        assert.deepEqual(openBatch(h.root, idB).readReport().rows.map((r) => [r.issue, r.outcome]), [[3, "held"], [4, "held"]]);
        assert.deepEqual(h.launched(), [1, 3], "no lane launched after the cancel");
        await kill(d);
        d = await h.daemon();
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(await statusIds(), [], "and the next restart resumes neither batch");
        assert.deepEqual(h.launched(), [1, 3]);
      }));
    } finally { h.cleanup(); }
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
    } finally { h.cleanup(); }
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
      await withRoot(h, () => capture(async () => {
        const a = orchestrateFromCli(["1", "2", "--parallel", "1", "--repo", "o/r", "--no-prefilter"], h.client).then(() => null, (e) => e);
        await until(() => h.launched().length === 1 && h.lanePids().length === 1);
        const [idA] = listBatches(h.root);
        const b = orchestrateFromCli(["5", "--parallel", "1", "--repo", "o/r", "--no-prefilter"], h.client).then(() => null, (e) => e);
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
        await b;
        await h.daemon(); // resumes both batches
        const ra = orchestrateFromCli(["--resume", idA], h.client), rb = orchestrateFromCli(["--resume", idB], h.client);
        setTimeout(() => writeFileSync(h.release, ""), 200);
        assert.deepEqual((await ra).rows.map((r) => [r.issue, r.outcome]), [[1, "merged"], [2, "merged"]]);
        assert.deepEqual((await rb).rows.map((r) => [r.issue, r.outcome]), [[5, "merged"]]);
        assert.deepEqual(h.launched(), [1, 2, 5], "adopted, not relaunched");
      }));
    } finally { h.cleanup(); }
  });

  it("lane env: allowlisted keys come from the client only, the rest from the daemon", () => {
    const kept = batchEnv({ PATH: "/c", CLAUDE_CONFIG_DIR: "/acct-b", SECRET_X: "no", FORGEDOCK_SCHED_DIR: "/s" });
    assert.deepEqual(kept, { PATH: "/c", CLAUDE_CONFIG_DIR: "/acct-b", FORGEDOCK_SCHED_DIR: "/s" });
    const env = mergeEnv({ PATH: "/d", ANTHROPIC_API_KEY: "daemon-key", NODE_OPTIONS: "x" }, kept);
    assert.deepEqual(env, { NODE_OPTIONS: "x", PATH: "/c", CLAUDE_CONFIG_DIR: "/acct-b", FORGEDOCK_SCHED_DIR: "/s" });
  });
});
