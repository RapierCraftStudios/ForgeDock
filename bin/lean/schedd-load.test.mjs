// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5531: a real schedd process under synthetic CPU load still answers `status` in under a second and keeps dispatching.
// End to end: the daemon runs in its own node process (real socket, real batch dir, a runBatch that dispatches by writing
// log rows), the CPU hogs are real processes, and the client is this process plus the real `forgedock schedd status` CLI.
// FORGEDOCK_SCHEDD_LOAD_HOGS: hog count (default 2); `auto` = 4 x nproc (the issue's load; run on a dedicated host only).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpDir } from "../tests/_tmp.mjs";
import { openBatch } from "./batch.mjs";
import { connectDaemon, request } from "./schedd.mjs";

const hogs = process.env.FORGEDOCK_SCHEDD_LOAD_HOGS === "auto" ? cpus().length * 4 : Number(process.env.FORGEDOCK_SCHEDD_LOAD_HOGS) || 2;
const CLI = fileURLToPath(new URL("../forgedock.mjs", import.meta.url));
const SCHEDD = pathToFileURL(fileURLToPath(new URL("./schedd.mjs", import.meta.url))).href;
const BATCH = pathToFileURL(fileURLToPath(new URL("./batch.mjs", import.meta.url))).href;

/** The daemon process: hosts the given batch and dispatches one log row every 50 ms until it is told to stop. */
const daemonSrc = (dir, root, id) => `
import { startDaemon } from ${JSON.stringify(SCHEDD)};
import { openBatch } from ${JSON.stringify(BATCH)};
const b = openBatch(${JSON.stringify(root)}, ${JSON.stringify(id)});
let n = 0;
const runBatch = async ({ sink, signal }) => {
  sink.batch({ id: b.id, dir: b.dir });
  const t = setInterval(() => b.store.log({ type: "dispatch", n: ++n }), 50);
  await new Promise((r) => signal?.addEventListener?.("abort", r));
  clearInterval(t);
};
const d = await startDaemon({ dir: ${JSON.stringify(dir)}, root: ${JSON.stringify(root)}, runBatch, log: (m) => console.log(m), resumeOnStart: true });
process.on("SIGTERM", async () => { await d.close(); process.exit(0); });
console.log("ready");
`;

const dispatches = (b) => { try { return readFileSync(join(b.dir, "log.jsonl"), "utf8").split("\n").filter((l) => l.includes('"dispatch"')).length; } catch { return 0; } };
const until = async (fn, ms) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); } };

describe("schedd under CPU load (#5531)", () => {
  it("#5531: status answers in under 1 s and a hosted batch keeps dispatching while CPU hogs run", async () => {
    const dir = tmpDir("schedd-load-"), root = join(dir, "batches");
    const b = openBatch(root, "b20261031-000000-8001");
    b.writePlan({ daemon: true, repo: "o/r", created: new Date().toISOString() });
    b.store.save({ v: 1, order: [1], results: {}, running: {}, pending: [1], parallel: 1 });
    // a long history the status scan has to walk (finished batches)
    for (let i = 0; i < 100; i++) { const o = openBatch(root, `b20261001-000000-${7000 + i}`); o.writePlan({ daemon: true, created: "2026-10-01T00:00:00Z" }); o.store.save({ v: 1, order: [1], pending: [] }); o.requestCancel({ reason: "done" }); }
    const daemon = spawn(process.execPath, ["--input-type=module", "-e", daemonSrc(dir, root, b.id)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; daemon.stdout.on("data", (c) => { out += c; }); daemon.stderr.on("data", (c) => { out += c; });
    const procs = [];
    try {
      await until(() => out.includes("ready") && dispatches(b) > 0, 15000);
      for (let i = 0; i < hogs; i++) procs.push(spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
      await new Promise((r) => setTimeout(r, 500));
      const n0 = dispatches(b);
      // a client outside the daemon process, over the real socket
      const sock = await connectDaemon({ dir, spawnDaemon: null });
      const t0 = Date.now(), st = await request(sock, { op: "status" }, undefined, { timeoutMs: 5000 });
      const took = Date.now() - t0;
      assert.equal(st.type, "status");
      assert.equal(st.pid, daemon.pid, "answered by the spawned daemon");
      assert.ok(st.batches.some((x) => x.id === b.id && x.running), "the batch is hosted");
      assert.ok(took < 1000, `status took ${took} ms under ${hogs} hogs`);
      // the real CLI: `forgedock schedd status` against the same daemon (node startup excluded from the 1 s bound)
      const cli = await new Promise((res) => execFile(process.execPath, [CLI, "schedd", "status"], { env: { ...process.env, FORGEDOCK_SCHED_DIR: dir }, timeout: 30000 }, (err, stdout) => res({ err, stdout })));
      assert.equal(cli.err, null, String(cli.err));
      assert.match(cli.stdout, new RegExp(`schedd: pid ${daemon.pid}, `));
      assert.match(cli.stdout, new RegExp(b.id));
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(dispatches(b) > n0, `the hosted batch kept dispatching (${n0} → ${dispatches(b)})`);
    } finally {
      for (const p of procs) p.kill("SIGKILL");
      daemon.kill("SIGTERM");
      await new Promise((r) => { const t = setTimeout(() => { daemon.kill("SIGKILL"); r(); }, 5000); daemon.on("exit", () => { clearTimeout(t); r(); }); });
    }
  });
});
