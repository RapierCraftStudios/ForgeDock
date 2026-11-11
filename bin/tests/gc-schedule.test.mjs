// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5421: the scheduled `gc --apply` entry (systemd user timer, cron fallback), with injected exec and a temp home.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./_tmp.mjs";
import { renderSystemd, renderCron, installGcSchedule, unitName } from "../gc-schedule.mjs";

const common = { node: "/usr/bin/node", bin: "/opt/fd/forgedock.mjs", cwd: "/work/repo" };
const fake = (over = {}) => {
  const calls = [];
  const exec = async (cmd, args, input) => {
    calls.push([cmd, ...args].join(" "));
    if (over.fail?.test([cmd, ...args].join(" "))) throw new Error("fail");
    return cmd === "crontab" && args[0] === "-l" ? over.crontab ?? "" : "";
  };
  return { calls, exec };
};

describe("gc schedule entry (#5421)", () => {
  it("renders a systemd timer that fires on the interval and runs gc --apply", () => {
    const { service, timer } = renderSystemd({ schedule: "6h", ...common });
    assert.match(timer, /^OnUnitActiveSec=360min$/m); assert.match(timer, /^Persistent=true$/m); assert.match(timer, /^WantedBy=timers\.target$/m);
    assert.match(service, /^Type=oneshot$/m); assert.match(service, /^WorkingDirectory=\/work\/repo$/m);
    assert.match(service, /^ExecStart="\/usr\/bin\/node" "\/opt\/fd\/forgedock\.mjs" gc --apply$/m);
  });
  it("renders a cron line by interval", () => {
    assert.match(renderCron({ schedule: "30m", ...common }), /^\*\/30 \* \* \* \* cd "\/work\/repo" && .* gc --apply .*# forgedock-gc \/work\/repo$/);
    assert.match(renderCron({ schedule: "6h", ...common }), /^0 \*\/6 \* \* \*/);
    assert.match(renderCron({ schedule: "2d", ...common }), /^0 0 \* \* \*/);
  });
  it("installs the user timer when systemd is available, and removes it when the schedule is unset", async () => {
    const home = tmpDir("sched-"), f = fake();
    const r = await installGcSchedule({ schedule: "6h", cwd: "/work/repo", home, platform: "linux", exec: f.exec, ...common });
    assert.equal(r.status, "installed"); assert.equal(r.kind, "systemd");
    const unit = join(home, ".config", "systemd", "user", `${unitName("/work/repo")}.timer`);
    assert.match(readFileSync(unit, "utf8"), /OnUnitActiveSec=360min/);
    assert.ok(f.calls.some((c) => c.startsWith("systemctl --user enable --now")));
    const off = await installGcSchedule({ schedule: "", cwd: "/work/repo", home, platform: "linux", exec: fake().exec });
    assert.equal(off.status, "removed"); assert.equal(existsSync(unit), false);
  });
  it("auto_gc: false installs nothing", async () => {
    const f = fake();
    const r = await installGcSchedule({ schedule: "6h", enabled: false, cwd: "/work/repo", home: tmpDir("sched-"), platform: "linux", exec: f.exec });
    assert.equal(r.status, "off");
  });
  it("falls back to crontab, keeping other entries and replacing its own line", async () => {
    const f = fake({ fail: /show-environment/, crontab: `0 1 * * * backup\n0 */6 * * * old ${"# forgedock-gc"} /work/repo\n` });
    let written = "";
    const exec = async (cmd, args, input) => { if (cmd === "crontab" && args[0] === "-") { written = input; f.calls.push("crontab -"); return ""; } return f.exec(cmd, args, input); };
    const r = await installGcSchedule({ schedule: "12h", cwd: "/work/repo", home: tmpDir("sched-"), platform: "linux", exec, ...common });
    assert.equal(r.kind, "cron"); assert.equal(r.status, "installed");
    assert.match(written, /0 1 \* \* \* backup/); assert.equal(written.match(/forgedock-gc/g).length, 1); assert.match(written, /0 \*\/12 /);
  });
  it("cron fallback leaves another repo's entry alone when its path shares our prefix (#5485)", async () => {
    const other = `0 */6 * * * old # forgedock-gc /work/repo2`;
    for (const enabled of [true, false]) {
      const f = fake({ fail: /show-environment/, crontab: `0 1 * * * backup\n0 */6 * * * old # forgedock-gc /work/repo\n${other}\n` });
      let written = "";
      const exec = async (cmd, args, input) => { if (cmd === "crontab" && args[0] === "-") { written = input; return ""; } return f.exec(cmd, args, input); };
      const r = await installGcSchedule({ schedule: "12h", enabled, cwd: "/work/repo", home: tmpDir("sched-"), platform: "linux", exec, ...common });
      assert.equal(r.kind, "cron");
      assert.ok(written.split("\n").includes(other), `enabled=${enabled}: sibling line kept`);
      assert.match(written, /backup/);
      assert.equal(written.split("\n").filter((l) => l.endsWith("# forgedock-gc /work/repo")).length, enabled ? 1 : 0);
    }
  });
  it("an exec failure is reported, never thrown", async () => {
    const r = await installGcSchedule({ schedule: "6h", cwd: "/work/repo", home: tmpDir("sched-"), platform: "linux", exec: fake({ fail: /daemon-reload|crontab/ }).exec, ...common });
    assert.equal(r.status, "failed");
  });
});
