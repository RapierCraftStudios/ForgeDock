// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheckCommand, execCapped, reapRunContainers } from "./effects.mjs";

describe("#5592 containers of a check run are reaped when it ends", () => {
  const fakeDocker = () => {
    const d = mkdtempSync(join(tmpdir(), "fake-docker-")), log = join(d, "log");
    writeFileSync(join(d, "docker"), `#!/bin/sh\necho "$@" >> ${log}\n`); chmodSync(join(d, "docker"), 0o755);
    return { dir: d, log };
  };
  it("a timed-out run: docker run is labelled for the run, the group is killed and the labelled containers are removed", async () => {
    const f = fakeDocker(), calls = [];
    const docker = async (a) => { calls.push(a); return a[0] === "ps" ? "c1\nc2\n" : ""; };
    const r = await runCheckCommand({ command: "docker run --rm -d prom/prometheus promtool test; sleep 30", cwd: tmpdir(), timeoutMs: 700, env: { PATH: `${f.dir}:${process.env.PATH}`, FORGE_DOCKER_LABELS: "forgedock.owner=1 forgedock.lane=lean-9" }, docker });
    assert.equal(r.rc, 124);
    const logged = readFileSync(f.log, "utf8");
    assert.match(logged, /^run --label forgedock\.run=\S+ --label forgedock\.owner=1 --label forgedock\.lane=lean-9 --rm -d prom\/prometheus promtool test/m);
    const label = /label (forgedock\.run=\S+)/.exec(logged)[1];
    assert.deepEqual(calls[0], ["ps", "-aq", "--filter", `label=${label}`]);
    assert.deepEqual(calls[1], ["rm", "-f", "c1", "c2"]);
  });
  it("a run that never starts a container makes no docker call; non-docker subcommands are not labelled", async () => {
    const f = fakeDocker(), calls = [];
    const r = await runCheckCommand({ command: "docker ps; true", cwd: tmpdir(), timeoutMs: 5000, env: { PATH: `${f.dir}:${process.env.PATH}` }, docker: async (a) => { calls.push(a); return ""; } });
    assert.equal(r.rc, 0); assert.deepEqual(calls, []);
    assert.equal(readFileSync(f.log, "utf8").trim(), "ps");
  });
  it("reapRunContainers never throws and removes nothing when none carry the label", async () => {
    const calls = [];
    assert.equal(await reapRunContainers("forgedock.run=x", { docker: async (a) => { calls.push(a); return ""; } }), 0);
    assert.equal(calls.length, 1);
    assert.equal(await reapRunContainers("forgedock.run=x", { docker: async () => { throw new Error("daemon down"); } }), 0);
  });
});

describe("#5592 a huge git/gh output never crashes the lane", () => {
  it("output past the cap is truncated with a marker, not a maxBuffer error", async () => {
    const out = await execCapped(process.execPath, ["-e", "process.stdout.write('x'.repeat(3e6))"], { cap: 1_000_000 });
    assert.ok(out.startsWith("xxxx") && out.length < 1_000_200);
    assert.match(out, /output truncated at 1000000 bytes/);
  });
  it("normal output passes through; a failing child rejects with stderr", async () => {
    assert.equal(await execCapped(process.execPath, ["-e", "process.stdout.write('hi')"]), "hi");
    await assert.rejects(execCapped(process.execPath, ["-e", "console.error('boom');process.exit(3)"]), (e) => e.code === 3 && /boom/.test(e.stderr) && /boom/.test(e.message));
  });
});
