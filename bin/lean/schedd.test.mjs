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
import { formatTable } from "./orchestrate.mjs";
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
`);
  h.daemonScript = join(work, "daemon.mjs");
  writeFileSync(h.daemonScript, `import { startDaemon } from ${JSON.stringify(new URL("./schedd.mjs", import.meta.url).href)};
import { runBatch } from ${JSON.stringify(new URL("../engine-cli.mjs", import.meta.url).href)};
const deps = { allowTmpfs: true, laneScript: ${JSON.stringify(stub)}, pollMs: 30, orchestration: { breaker: null, maxDeferrals: 3 }, io: { gh: async () => "o/r\\n" },
  leanIo: { gh: async (a) => a.includes("milestone") ? JSON.stringify({ milestone: null }) : a[0] === "repo" ? "main\\n" : JSON.stringify({ body: a[2] === "3" ? "Depends on #1" : "", labels: [] }),
    git: async (a) => (a[0] === "ls-remote" ? "abc\\trefs/heads/staging\\n" : "") } };
const d = await startDaemon({ runBatch: (a) => runBatch({ ...a, daemon: true, deps }), idleMs: 600000 });
if (!d.running) process.exit(3);
process.once("SIGTERM", () => d.close());
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

  it("lane env: allowlisted keys come from the client only, the rest from the daemon", () => {
    const kept = batchEnv({ PATH: "/c", CLAUDE_CONFIG_DIR: "/acct-b", SECRET_X: "no", FORGEDOCK_SCHED_DIR: "/s" });
    assert.deepEqual(kept, { PATH: "/c", CLAUDE_CONFIG_DIR: "/acct-b", FORGEDOCK_SCHED_DIR: "/s" });
    const env = mergeEnv({ PATH: "/d", ANTHROPIC_API_KEY: "daemon-key", NODE_OPTIONS: "x" }, kept);
    assert.deepEqual(env, { NODE_OPTIONS: "x", PATH: "/c", CLAUDE_CONFIG_DIR: "/acct-b", FORGEDOCK_SCHED_DIR: "/s" });
  });
});
