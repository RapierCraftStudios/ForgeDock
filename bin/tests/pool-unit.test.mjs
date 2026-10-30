import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runPoolCli } from "../pool/cli.mjs";
import { restartCheck, lastExitReason } from "../pool/health.mjs";

const root = new URL("../../", import.meta.url).pathname;
const read = (p) => readFileSync(root + p, "utf8");

describe("pool unit hardening (#4673)", () => {
  it("router sets a distinctive process title", async () => {
    const old = process.title;
    const log = console.log; console.log = () => {};
    try { await runPoolCli(["router", "--config", "/nonexistent"], { startRouter: () => {} }).catch(() => {}); } finally { console.log = log; }
    const title = process.title; process.title = old;
    assert.equal(title, "forgedock-pool-router");
  });
  it("schedd sets its title", () => {
    assert.match(read("bin/engine-cli.mjs"), /process\.title = "forgedock-schedd"/);
  });
  it("generated units carry OOMScoreAdjust= from the shared snippet and StartLimitIntervalSec=0 in [Unit] only", () => {
    const out = (mode) => spawnSync("bash", ["-c", `. ${root}pool/install/unit-hardening.sh; unit_hardening ${mode}`], { encoding: "utf8" }).stdout;
    for (const mode of ["user", "system"]) {
      assert.match(out(mode), /^OOMScoreAdjust=-?\d+$/m);
      assert.match(out(mode), /^Restart=always$/m);
      assert.doesNotMatch(out(mode), /StartLimitIntervalSec/);
    }
    for (const f of ["install-router.sh", "install-agent.sh", "install-schedd.sh"]) assert.match(read(`pool/install/${f}`), /unit-hardening\.sh/);
  });
  it("StartLimitIntervalSec=0 lands in [Unit], not [Service], of every generated unit", () => {
    for (const [f, mode] of [["install-router.sh", "user"], ["install-agent.sh", "system"], ["install-schedd.sh", "user"]]) {
      const heredoc = read(`pool/install/${f}`).match(/<<-?\s*\\?'?(\w+)'?\n(\[Unit\][\s\S]*?)\n\1\n/)[2];
      const script = `. ${root}pool/install/unit-hardening.sh; cat <<EOF\n${heredoc}\nEOF`;
      const unit = spawnSync("bash", ["-c", script], { encoding: "utf8" }).stdout;
      const sections = {};
      let cur;
      for (const line of unit.split("\n")) { const m = line.match(/^\[(\w+)\]$/); if (m) cur = sections[m[1]] = []; else if (cur) cur.push(line); }
      assert.ok(sections.Unit.includes("StartLimitIntervalSec=0"), `${f}: missing in [Unit] (${mode})`);
      assert.ok(!sections.Service.some((l) => l.startsWith("StartLimitIntervalSec")), `${f}: present in [Service]`);
    }
  });
  it("schedd unit gets CPUWeight and a watchdog timer; router and agent units get no priority lines (#4780)", () => {
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
