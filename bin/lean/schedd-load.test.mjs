// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5531: a real schedd process under synthetic CPU load still answers `status` in under a second and keeps dispatching.
// FORGEDOCK_SCHEDD_LOAD_HOGS: hog count (default 2); `auto` = 4 x nproc (the issue's load; run on a dedicated host only).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { openBatch } from "./batch.mjs";
import { startDaemon, connectDaemon, request } from "./schedd.mjs";

const hogs = process.env.FORGEDOCK_SCHEDD_LOAD_HOGS === "auto" ? cpus().length * 4 : Number(process.env.FORGEDOCK_SCHEDD_LOAD_HOGS) || 2;

describe("schedd under CPU load (#5531)", () => {
  it("#5531: status answers in under 1 s and a hosted batch keeps dispatching while CPU hogs run", async () => {
    const dir = tmpDir("schedd-load-"), root = join(dir, "batches");
    const b = openBatch(root, "b20261031-000000-8001");
    b.writePlan({ daemon: true, repo: "o/r", created: new Date().toISOString() });
    b.store.save({ v: 1, order: [1], results: {}, running: {}, pending: [1], parallel: 1 });
    let dispatched = 0, timer;
    const runBatch = async ({ sink }) => { sink.batch({ id: b.id, dir: b.dir }); timer = setInterval(() => { dispatched++; }, 20); return await new Promise(() => {}); };
    const d = await startDaemon({ dir, root, runBatch, log: () => {}, resumeOnStart: true });
    const procs = Array.from({ length: hogs }, () => spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
    try {
      await new Promise((r) => setTimeout(r, 500));
      const sock = await connectDaemon({ dir, spawnDaemon: null });
      const t0 = Date.now(), st = await request(sock, { op: "status" }, undefined, { timeoutMs: 5000 });
      const took = Date.now() - t0, n0 = dispatched;
      assert.equal(st.type, "status");
      assert.ok(took < 1000, `status took ${took} ms under ${hogs} hogs`);
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(dispatched > n0, "the hosted batch's loop kept running");
    } finally { clearInterval(timer); for (const p of procs) p.kill("SIGKILL"); await d.close(); }
  });
});
