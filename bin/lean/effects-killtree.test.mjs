// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { killLedgerPid, descendantPids } from "./effects.mjs";

// a signalled-but-unreaped (zombie) process counts as stopped
const alive = (p) => { try { process.kill(p, 0); } catch { return false; } try { return !readFileSync(`/proc/${p}/stat`, "utf8").includes(") Z "); } catch { return true; } };

// #5746: stopping a lane kills its whole process tree, including a builder that left the lane's process group (setsid)
describe("#5746 killLedgerPid stops the whole process tree", () => {
  it("descendantPids walks /proc ppids, grandchildren included, unrelated pids excluded", () => {
    const d = tmpDir("proc-");
    const st = (pid, ppid, comm = "node") => { mkdirSync(join(d, String(pid))); writeFileSync(join(d, String(pid), "stat"), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0`); };
    st(10, 1); st(11, 10, "a b) c"); st(12, 11); st(13, 1); st(14, 13);
    assert.deepEqual(descendantPids(10, { procDir: d }).sort(), [11, 12]);
  });
  it("a setsid grandchild outside the lane's process group is signalled too", { skip: !existsSync("/proc") }, async () => {
    const marker = `killtree-${process.pid}`;
    const inner = "setInterval(()=>{},1000)";
    const outer = `const c=require("child_process").spawn(process.execPath,["-e",${JSON.stringify(inner)}],{detached:true,stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)`;
    const lane = spawn(process.execPath, ["-e", outer, marker], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const gc = await new Promise((res) => lane.stdout.once("data", (b) => res(Number(String(b).trim()))));
    try {
      assert.ok(alive(gc));
      assert.equal(killLedgerPid(lane.pid, marker), true);
      for (let i = 0; i < 50 && alive(gc); i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(alive(gc), false, "the setsid grandchild survived the stop");
    } finally { for (const p of [gc, lane.pid]) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } } }
  });
});
