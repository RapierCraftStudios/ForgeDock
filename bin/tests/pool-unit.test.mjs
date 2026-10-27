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
  it("generated units carry OOMScoreAdjust= and StartLimitIntervalSec=0 from the shared snippet", () => {
    const out = (mode) => spawnSync("bash", ["-c", `. ${root}pool/install/unit-hardening.sh; unit_hardening ${mode}`], { encoding: "utf8" }).stdout;
    for (const mode of ["user", "system"]) {
      assert.match(out(mode), /^OOMScoreAdjust=-?\d+$/m);
      assert.match(out(mode), /^StartLimitIntervalSec=0$/m);
      assert.match(out(mode), /^Restart=always$/m);
    }
    for (const f of ["install-router.sh", "install-agent.sh", "install-schedd.sh"]) assert.match(read(`pool/install/${f}`), /unit-hardening\.sh/);
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
