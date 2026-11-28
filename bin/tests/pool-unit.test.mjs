import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runPoolCli, statusTable, queueWaitByWorker } from "../pool/cli.mjs";
import { usageSummary } from "../pool/agent.mjs";
import { restartCheck, lastExitReason } from "../pool/health.mjs";
// Windows hosts: these tests exercise POSIX-only behaviour (file modes, tmpfs, systemd units, sh/bash scripts, file-URL paths); Linux CI runs them.
const POSIX_ONLY = process.platform === "win32" && "POSIX-only behaviour";

// fileURLToPath, forward slashes: a URL pathname is /C:/... on win32; bash (Git Bash) and fs both take C:/...
const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\\/g, "/");
const read = (p) => readFileSync(root + p, "utf8").replace(/\r\n/g, "\n"); // a CRLF checkout (core.autocrlf) reads as LF

describe("pool unit hardening (#4673)", () => {
  it("router sets a distinctive process title", async () => {
    const old = process.title;
    const log = console.log; console.log = () => {};
    try { await runPoolCli(["router", "--config", "/nonexistent"], { startRouter: () => {} }).catch(() => {}); } finally { console.log = log; }
    const title = process.title; process.title = old;
    assert.equal(title, "forgedock-pool-router");
  });
  it("schedd sets its title", { skip: POSIX_ONLY }, () => {
    assert.match(read("bin/engine-cli.mjs"), /process\.title = "forgedock-schedd"/);
  });
  it("generated units carry OOMScoreAdjust= from the shared snippet and StartLimitIntervalSec=0 in [Unit] only", { skip: POSIX_ONLY }, () => {
    const out = (mode) => spawnSync("bash", ["-c", `. ${root}pool/install/unit-hardening.sh; unit_hardening ${mode}`], { encoding: "utf8" }).stdout;
    for (const mode of ["user", "system"]) {
      assert.match(out(mode), /^OOMScoreAdjust=-?\d+$/m);
      assert.match(out(mode), /^Restart=always$/m);
      assert.doesNotMatch(out(mode), /StartLimitIntervalSec/);
    }
    for (const f of ["install-router.sh", "install-agent.sh", "install-schedd.sh"]) assert.match(read(`pool/install/${f}`), /unit-hardening\.sh/);
  });
  it("StartLimitIntervalSec=0 lands in [Unit], not [Service], of every generated unit", { skip: POSIX_ONLY }, () => {
    for (const [f, mode] of [["install-router.sh", "user"], ["install-agent.sh", "system"], ["install-schedd.sh", "user"]]) {
      const heredoc = [...read(`pool/install/${f}`).matchAll(/<<-?\s*\\?'?(\w+)'?\n(\[Unit\][\s\S]*?)\n\1\n/g)].map((m) => m[2]).find((h) => /unit_hardening/.test(h));
      const script = `. ${root}pool/install/unit-hardening.sh; cat <<EOF\n${heredoc}\nEOF`;
      const unit = spawnSync("bash", ["-c", script], { encoding: "utf8" }).stdout;
      const sections = {};
      let cur;
      for (const line of unit.split("\n")) { const m = line.match(/^\[(\w+)\]$/); if (m) cur = sections[m[1]] = []; else if (cur) cur.push(line); }
      assert.ok(sections.Unit.includes("StartLimitIntervalSec=0"), `${f}: missing in [Unit] (${mode})`);
      assert.ok(!sections.Service.some((l) => l.startsWith("StartLimitIntervalSec")), `${f}: present in [Service]`);
    }
  });
  it("schedd unit gets CPUWeight and a watchdog timer; router and agent units get no priority lines (#4780)", { skip: POSIX_ONLY }, () => {
    const out = (mode) => spawnSync("bash", ["-c", `. ${root}pool/install/unit-hardening.sh; unit_priority ${mode}`], { encoding: "utf8" }).stdout;
    assert.match(out("user"), /^CPUWeight=\d+$/m);
    assert.doesNotMatch(out("user"), /Nice=/);
    assert.match(out("system"), /^Nice=-5$/m);
    const sched = read("pool/install/install-schedd.sh");
    assert.match(sched, /unit_priority user/);
    assert.match(sched, /schedd watchdog/);
    assert.match(sched, /OnUnitActiveSec=/);
    for (const f of ["install-router.sh", "install-agent.sh"]) assert.doesNotMatch(read(`pool/install/${f}`), /unit_priority/);
  });
  it("restartCheck warns with the last exit reason, passes when quiet, skips absent units", () => {
    const run = (journal) => (cmd) => cmd === "systemctl" ? "NRestarts=8\nLoadState=loaded\n" : journal;
    const bad = restartCheck({ unit: "u", run: run("x: Main process exited, code=killed, status=15/TERM\nx: Scheduled restart job, restart counter is at 1.\n") });
    assert.equal(bad.status, "warn");
    assert.match(bad.detail, /status=15\/TERM/);
    assert.equal(restartCheck({ unit: "u", run: run("") }).status, "pass");
    assert.equal(restartCheck({ unit: "u", run: () => "LoadState=not-found\n" }).status, "skip");
    assert.equal(restartCheck({ unit: "u", run: () => null }).status, "skip");
    assert.equal(lastExitReason(["nothing"]), null);
  });
});

describe("per-repo lane image (#5650)", () => {
  it("agent resolves the image through lane-tools and keeps the base default", { skip: POSIX_ONLY }, () => {
    const src = read("bin/pool/agent.mjs");
    assert.match(src, /resolveLaneImage\(\{ tools: spec\.lane_tools, baseImage: spec\.image \?\? image, docker: variantDocker\(spec\.image \?\? image\) \}\)/);
    assert.match(src, /: \(spec\.image \?\? image\)/);
  });
});

describe("#6062 per-worker usage rollup", () => {
  const row = (c, m, cu, cp, mu, mp) => ({ reserved: { cpus: c, mem_gb: m }, cpu_avg: cu, cpu_peak: cp, mem_avg_gb: mu, mem_peak_gb: mp, samples: 3 });
  it("empty rows give zeros and null ratios", () => {
    assert.deepEqual(usageSummary([]), { lanes: 0, admitted: { cpus: 0, mem_gb: 0 }, used: { cpu_avg: 0, cpu_peak: 0, mem_avg_gb: 0, mem_peak_gb: 0 }, utilization: { cpu: null, mem: null } });
    assert.equal(usageSummary([null]).lanes, 0);
  });
  it("sums admitted and used over lanes and rounds utilization", () => {
    const s = usageSummary([row(2, 4, 0.5, 1, 1, 2), row(4, 8, 1.01, 3, 2, 3), null]);
    assert.equal(s.lanes, 2);
    assert.deepEqual(s.admitted, { cpus: 6, mem_gb: 12 });
    assert.deepEqual(s.used, { cpu_avg: 1.51, cpu_peak: 4, mem_avg_gb: 3, mem_peak_gb: 5 });
    assert.deepEqual(s.utilization, { cpu: 0.25, mem: 0.25 });
  });
  it("queue wait p50/p95 per worker; unattributed rows are skipped", () => {
    const q = queueWaitByWorker([1, 2, 3, 4].map((i) => ({ phases: { queue_wait: { ms: i * 1000, worker: "w1" } } })).concat([{ phases: { queue_wait: { ms: 9 } } }, {}]));
    assert.deepEqual(q, { w1: { n: 4, p50_ms: 2000, p95_ms: 4000 } });
  });
});
