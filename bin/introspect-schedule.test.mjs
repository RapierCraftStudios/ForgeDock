// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./tests/_tmp.mjs";
import { runIntrospect, installIntrospectSchedule, renderIntrospectCron, renderIntrospectSystemd, introspectUnitName } from "./introspect-schedule.mjs";

describe("#5987 introspect schedule", () => {
  it("renders a daily systemd unit and a tagged cron line that run stats --file-issues", () => {
    const s = renderIntrospectSystemd({ cwd: "/work/r", node: "/n", bin: "/b/forgedock.mjs" });
    assert.match(s.service, /ExecStart="\/n" ".*introspect-schedule.mjs" --run/);
    assert.match(s.timer, /OnCalendar=daily/);
    assert.match(renderIntrospectCron({ cwd: "/work/r", node: "/n", bin: "/b/f.mjs" }), /^17 4 \* \* \* cd "\/work\/r" .*introspect-schedule.mjs" --run .*# forgedock-introspect \/work\/r$/);
  });

  it("systemd: installs once (rewrite, no duplicate), removes when disabled", async () => {
    const home = tmpDir("isch-"), calls = [];
    const exec = async (c, a) => { calls.push([c, ...a].join(" ")); return ""; };
    const o = { cwd: "/work/r", home, platform: "linux", exec, node: "/n", bin: "/b" };
    assert.equal((await installIntrospectSchedule(o)).status, "installed");
    assert.equal((await installIntrospectSchedule(o)).status, "installed");
    const name = introspectUnitName("/work/r"), dir = join(home, ".config", "systemd", "user");
    assert.deepEqual(fs.readdirSync(dir).sort(), [`${name}.service`, `${name}.timer`]);
    assert.equal((await installIntrospectSchedule({ ...o, enabled: false })).status, "removed");
    assert.equal(fs.existsSync(join(dir, `${name}.timer`)), false);
    assert.equal((await installIntrospectSchedule({ ...o, enabled: false })).status, "off");
  });

  it("cron fallback replaces only its own line and dedupes", async () => {
    let tab = "0 1 * * * other\n17 4 * * * x # forgedock-introspect /work/r2\n";
    const exec = async (c, a, input) => { if (c === "systemctl") throw new Error("no systemd"); if (a[0] === "-l") return tab; tab = input; return ""; };
    const o = { cwd: "/work/r", platform: "linux", exec, node: "/n", bin: "/b" };
    await installIntrospectSchedule(o); await installIntrospectSchedule(o);
    const lines = tab.trim().split("\n");
    assert.equal(lines.filter((l) => l.endsWith("# forgedock-introspect /work/r")).length, 1);
    assert.equal(lines.length, 3, "other lines kept");
    assert.equal((await installIntrospectSchedule({ ...o, enabled: false })).status, "removed");
    assert.equal(tab.trim().split("\n").length, 2);
  });

  it("never throws", async () => {
    const r = await installIntrospectSchedule({ cwd: "/w", platform: "darwin", exec: async () => { throw new Error("boom"); } });
    assert.ok(["off", "failed", "removed"].includes(r.status) || r.status === "installed");
  });

  it("runIntrospect files the report once, dedupes an unchanged report, adopts an open issue, and stays off by default", async () => {
    const home = tmpDir("isch-run-"), cwd = tmpDir("isch-cwd-"), calls = [];
    const gh = async (a) => { calls.push(a); return a[1] === "list" ? "[]" : a[1] === "create" ? "https://x/issues/9\n" : ""; };
    const run = async () => "adequate 80%";
    assert.equal((await runIntrospect({ cwd, home, run, gh })).action, "disabled");
    assert.equal(calls.length, 0);
    fs.writeFileSync(join(cwd, "forge.yaml"), "orchestrate:\n  slo:\n    file_issues: true\n");
    const a = await runIntrospect({ cwd, home, run, gh });
    assert.equal(a.action, "create"); assert.equal(a.issue, 9);
    assert.equal((await runIntrospect({ cwd, home, run, gh })).action, "unchanged", "prior report: nothing filed");
    const c = await runIntrospect({ cwd, home, run: async () => "adequate 70%", gh });
    assert.equal(c.action, "comment"); assert.equal(c.issue, 9);
    assert.equal(calls.filter((x) => x[1] === "create").length, 1);
    assert.match(calls.at(-1).at(-1), /report: .*introspect/);
  });
});
